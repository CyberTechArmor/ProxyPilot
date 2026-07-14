// Mock2 build runner — Claude Agent SDK variant (Phase 1 of the migration; see
// docs/agent-sdk-migration.md). SELECTED ONLY when BUILD_RUNNER=sdk; the default
// stays the hand-rolled runCycle in runner.js, byte-for-byte unchanged.
//
// What's different from runner.js: the AGENTIC LOOP is the Claude Agent SDK's
// query() with its built-in Read/Edit/Write/Bash/Grep/Glob tools, instead of our
// hand-rolled turn loop over RUNNER_TOOLS. What's IDENTICAL (imported straight from
// runner.js so there is one implementation): copying the pinned gate battery in,
// running that battery, checkpoint → hash-chained change record, and the deploy
// (Run) stage. So a cycle driven by the SDK produces the SAME commit, the SAME
// change record, and the SAME gate-battery invocation as the hand-rolled path.
//
// Where the SDK runs (the R3 / key-never-in-container tension, resolved): the SDK
// runs in THIS backend (orchestrator) process, against a LOCAL checkout synced out
// of the fenced container. The decrypted key is handed to the SDK's subprocess via
// options.env — orchestrator-side only, never entering the container. The edited
// tree is synced back into the container, where the (unchanged) gates, checkpoint,
// and deploy run exactly as today.
//
// Terminology (risk R7): this is the SDK build runner; the slot is build_runner.

import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { sh } from './host.js';
import { updateProject } from './projects.js';
import { effectivePrice } from './connectors.js';
import { getApplicableQuota, periodUsage, insertLedgerEntry } from './quotas.js';
import { costCentsForUsage, shouldStopForBudget } from './quota-logic.js';
import {
  budgetMode, budgetPauseReasonCents, budgetCentsForTokenLegacy, dollars, USAGE_SCHEMA_VERSION,
} from './usage-logic.js';
import {
  getCycle, updateCycle, addCycleUsage, finishCycle,
} from './cycles.js';
import { initialGateReports, allGatesGreen, interruptDecision } from './cycle-logic.js';
import { releaseLock, touchLock } from './locks.js';
import { insertCycleEvent } from './cycle-events.js';
import {
  parseFrameworkSkills, buildRunnerClaudeMd, buildRunnerTask,
  SDK_ALLOWED_TOOLS, MAX_TURNS, softPauseReason, SOFT_PAUSE_TOKENS,
  updateProgress, initProgressState, noProgressLimit, haltReasonLabel,
  isRefusalStop, REFUSAL_HALT_REASON,
} from './runner-logic.js';
import { buildResumeContextBlock } from './unblock-logic.js';
import { closeRequest } from './requests.js';
import { notifyCycleComplete } from '../lib/notification-dispatch.js';
import { buildHookOptions } from './runner-sdk-hooks.js';
import { smokeAfterDeploy, smokeFailSummary } from './smoke.js';
import {
  APP_DIR, setJob, scheduleJobCleanup, copyGatesIntoContainer, runGateBattery,
  checkpointAndRecord, deployStage, formatGateReports, containerSh, haltCycle,
} from './runner.js';

const execFileP = promisify(execFile);
const nowIso = () => new Date().toISOString();

// Working-tree paths never worth syncing (heavy / regenerated / VCS internals).
// Kept out of BOTH the pull and the push tarballs.
const TAR_EXCLUDES = ['--exclude=./node_modules', '--exclude=./.git', '--exclude=./dist', '--exclude=./.next'];

// How many gate-feedback rounds the SDK gets: the first pass, then up to a few
// "gates are red, here's why, fix it" resumes. Bounded so a build that can't go
// green pauses/fails instead of looping. The soft token/time pause trips first on a
// genuinely long build.
const SDK_MAX_GATE_ROUNDS = 4;
// Bound a single query() so our between-round soft-pause/interrupt checks are
// actually reached (mirrors the hand-rolled MAX_TURNS backstop).
const SDK_MAX_TURNS_PER_ROUND = Math.min(MAX_TURNS, 200);

// ---- the SDK-driven cycle (same signature as runCycle) ----

export async function runCycleSdk({ cycle, project, containerName, framework, gateScripts, ready }) {
  const projectId = Number(project.id);
  const holder = { type: 'cycle', id: cycle.id };
  const price = effectivePrice(ready.connector.id, ready.model);
  const logEvent = (kind, { role = null, content = null, meta = null } = {}) =>
    insertCycleEvent({ projectId, cycleId: cycle.id, kind, role, content, meta });

  // The SDK speaks the Anthropic model family. Phase 1 supports a direct Anthropic
  // connector (key via env). A non-Anthropic build_runner slot is a clean,
  // actionable failure, not a crash — the operator can point the slot at Anthropic
  // or leave BUILD_RUNNER unset to use the hand-rolled (provider-agnostic) runner.
  if (ready.connector.provider !== 'anthropic' || !ready.apiKey) {
    finishCycle(cycle.id, {
      status: 'failed',
      error: 'BUILD_RUNNER=sdk needs an Anthropic build_runner connector with a decryptable key. '
        + 'Point the slot at Anthropic, or unset BUILD_RUNNER to use the hand-rolled runner.',
    });
    releaseLock(projectId, holder);
    setJob(cycle.id, { phase: 'failed', message: 'SDK runner requires an Anthropic build_runner connector.' });
    return scheduleJobCleanup(cycle.id);
  }

  // Load the SDK lazily so a flag-off install never needs the package present. It
  // is deliberately NOT a package.json dependency: its `zod@^4` peer conflicts with
  // the backend's `zod@^3` and would break the default `npm install` (ERESOLVE).
  // Operators opting into the SDK runner install it out-of-band (see below).
  let query;
  try {
    ({ query } = await import('@anthropic-ai/claude-agent-sdk'));
  } catch (err) {
    finishCycle(cycle.id, {
      status: 'failed',
      error: `BUILD_RUNNER=sdk but @anthropic-ai/claude-agent-sdk is not installed: ${err?.message || err}. `
        + 'Install it in admin/backend with `npm install @anthropic-ai/claude-agent-sdk --no-save --legacy-peer-deps` '
        + '(the --legacy-peer-deps is required: the SDK peers zod@^4 while the backend pins zod@^3), or unset BUILD_RUNNER.',
    });
    releaseLock(projectId, holder);
    setJob(cycle.id, { phase: 'failed', message: 'Claude Agent SDK is not installed (see cycle error for the install command).' });
    return scheduleJobCleanup(cycle.id);
  }

  // Copy the PINNED gate scripts into the container (ADR-003) — identical to the
  // hand-rolled path. Stamp the initial all-pending gate report.
  const copied = await copyGatesIntoContainer(containerName, gateScripts);
  if (!copied.ok) {
    finishCycle(cycle.id, { status: 'failed', error: `could not copy gates into container: ${copied.error}` });
    releaseLock(projectId, holder);
    setJob(cycle.id, { phase: 'failed', message: copied.error });
    return scheduleJobCleanup(cycle.id);
  }
  updateCycle(cycle.id, { status: 'running', started_at: nowIso(), gates_json: JSON.stringify(initialGateReports(gateScripts)) });
  setJob(cycle.id, { phase: 'running', message: 'SDK runner starting (Claude Agent SDK)…' });
  logEvent('task', { role: 'user', content: cycle.instruction || '', meta: { model: ready.model, framework_version: framework.version, runner: 'sdk' } });

  let checkoutDir = null;
  const runStartMs = Date.now();
  let usedTokensThisRun = 0;
  // Cost-truth: same additive accounting as the hand-rolled runner — the four canonical
  // classes + the run's spend, plus the flag-gated dollar soft-pause ceiling.
  let usedCostThisRun = 0;
  const runUsage = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
  const budgetDollars = budgetMode(process.env) === 'dollars';
  const dollarCeilingCents = budgetDollars ? budgetCentsForTokenLegacy(SOFT_PAUSE_TOKENS, ready.model) : null;
  let sessionId = null;
  let lastGateReports = initialGateReports(gateScripts);
  // No-progress circuit breaker threshold (harness safety) — same as the
  // hand-rolled runner; the SDK equivalent aborts the query() stream and halts.
  const noProgLimit = noProgressLimit(process.env);

  try {
    // 1) Materialize a local checkout of the container's working tree.
    setJob(cycle.id, { phase: 'running', message: 'Syncing the project into a local workspace…' });
    checkoutDir = await mkdtemp(join(tmpdir(), `mock2-sdk-${cycle.id}-`));
    const pulled = await pullWorkingTree(containerName, checkoutDir);
    if (!pulled.ok) {
      finishCycle(cycle.id, { status: 'failed', error: `could not sync the project out of the container: ${pulled.error}` });
      releaseLock(projectId, holder);
      setJob(cycle.id, { phase: 'failed', message: 'Could not sync the project for the SDK runner.' });
      return scheduleJobCleanup(cycle.id);
    }

    // 2) Write the constitution/governance as an auto-loaded CLAUDE.md. It goes in
    //    .claude/ (also auto-loaded) and is EXCLUDED from the push-back, so it is
    //    ephemeral to this run and never enters the project's committed tree.
    const skills = parseFrameworkSkills(framework.skills_json);
    const claudeMd = buildRunnerClaudeMd({
      constitution: framework.constitution_md, skills, appDir: checkoutDir, webPort: project.web_port || 3000,
    });
    await mkdir(join(checkoutDir, '.claude'), { recursive: true });
    await writeFile(join(checkoutDir, '.claude', 'CLAUDE.md'), claudeMd, 'utf8');
    logEvent('note', { role: 'system', content: 'Constitution loaded from .claude/CLAUDE.md (auto-loaded by the SDK, not re-explored).' });

    // 3) Drive the SDK loop, then verify the pinned gates. Bounded gate-feedback
    //    rounds: after each pass we sync the edits back and run the SAME battery in
    //    the container; if red and rounds remain, resume the SDK session with the
    //    gate output. Interrupt + soft-pause are honored at each round boundary.
    const env = { ...process.env, ANTHROPIC_API_KEY: ready.apiKey };
    if (ready.connector.base_url) env.ANTHROPIC_BASE_URL = String(ready.connector.base_url);

    // Enforcement + audit hooks (docs/agent-sdk-migration.md). PreToolUse blocks
    // edits to governed paths + destructive shell; PostToolUse audits every
    // mutating tool call into the durable cycle-events log. ctx carries logEvent so
    // the records land in our transcript, not a file that would be synced back.
    const hookCtx = {
      cycleId: cycle.id, projectId, actorUserId: cycle.initiated_by ?? null,
      repoRoot: checkoutDir, logEvent, now: () => new Date().toISOString(),
    };
    const hookOptions = buildHookOptions(hookCtx);

    let battery = lastGateReports;
    let green = false;
    for (let round = 0; round < SDK_MAX_GATE_ROUNDS; round++) {
      // Honor an interrupt / stop-all at the boundary.
      const fresh = getCycle(cycle.id);
      if (!fresh || fresh.status !== 'running') { releaseLock(projectId, holder); return scheduleJobCleanup(cycle.id); }
      const ir = interruptDecision(fresh.interrupt_request);
      if (ir.stop) {
        if (ir.checkpointFirst) await checkpointAndRecord({ cycle: fresh, project, containerName, holder, gateReports: lastGateReports, gateScripts, framework, summary: `checkpoint: ${ir.terminalStatus}` });
        finishCycle(cycle.id, { status: ir.terminalStatus, error: `interrupted (${fresh.interrupt_request})` });
        releaseLock(projectId, holder);
        setJob(cycle.id, { phase: 'stopped', message: `Stopped (${fresh.interrupt_request})` });
        return scheduleJobCleanup(cycle.id);
      }
      // Hard budget stop (ledger) — same guard as the hand-rolled path.
      const q = getApplicableQuota(projectId, 'monthly');
      if (q) {
        const usage = periodUsage({ scope: q.scope, projectId: q.scope === 'project' ? q.project_id : null, period: q.period });
        if (shouldStopForBudget({ budgetCents: q.budget_cents, spentCents: usage.costCents })) {
          await checkpointAndRecord({ cycle: getCycle(cycle.id), project, containerName, holder, gateReports: lastGateReports, gateScripts, framework, summary: 'checkpoint: budget buffer crossed' });
          finishCycle(cycle.id, { status: 'interrupted', error: 'budget buffer crossed mid-cycle — checkpointed and stopped' });
          releaseLock(projectId, holder);
          setJob(cycle.id, { phase: 'stopped', message: 'Budget buffer crossed — checkpointed and stopped' });
          return scheduleJobCleanup(cycle.id);
        }
      }
      // Soft token/dollar/time pause — resumable, not a failure (identical semantics to
      // the hand-rolled runner; dollar ceiling behind the same MOCK2_BUDGET_DOLLARS flag).
      const elapsedMs = Date.now() - runStartMs;
      const pauseReason = budgetDollars
        ? (budgetPauseReasonCents({ spentCents: usedCostThisRun, ceilingCents: dollarCeilingCents })
          || softPauseReason({ usedTokens: 0, elapsedMs }))
        : softPauseReason({ usedTokens: usedTokensThisRun, elapsedMs });
      if (pauseReason) {
        const mins = Math.round((Date.now() - runStartMs) / 60000);
        const detail = pauseReason === 'budget_tokens'
          ? `token budget reached (~${Math.round(usedTokensThisRun / 1000)}k tokens this run)`
          : pauseReason === 'budget_cost'
            ? `cost budget reached (~${dollars(usedCostThisRun)} this run)`
            : `time budget reached (~${mins} min this run)`;
        await checkpointAndRecord({ cycle: getCycle(cycle.id), project, containerName, holder, gateReports: lastGateReports, gateScripts, framework, summary: `checkpoint: paused — ${detail}` });
        updateCycle(cycle.id, { pause_reason: pauseReason });
        finishCycle(cycle.id, { status: 'interrupted', error: `Paused — ${detail}. Resume to continue where it stopped.` });
        releaseLock(projectId, holder);
        setJob(cycle.id, { phase: 'paused', message: `Paused — ${detail}. Resume to continue.`, commit: null });
        void notifyCycleComplete({ project: { id: projectId, name: project.name }, cycle: getCycle(cycle.id), outcome: 'paused' });
        return scheduleJobCleanup(cycle.id);
      }

      // Run the SDK loop for this round. On round 0 of a RESUME, append the operator
      // guidance (message / chosen option / granted one-time authorizations) so the
      // SDK runner carries the same context as the hand-rolled runner.
      let resumeBlock = '';
      if (round === 0) {
        try { const rc = getCycle(cycle.id)?.resume_context_json; resumeBlock = rc ? buildResumeContextBlock(JSON.parse(rc)) : ''; } catch { resumeBlock = ''; }
        if (resumeBlock) logEvent('resume_guidance', { role: 'user', content: resumeBlock, meta: { runner: 'sdk' } });
      }
      const prompt = round === 0
        ? `${buildRunnerTask(cycle.instruction)}${resumeBlock ? `\n\n${resumeBlock}` : ''}`
        : `The verification gate battery is not all green yet. Fix the cause and stop.\n\n${formatGateReports(battery)}`;
      setJob(cycle.id, { phase: 'running', message: round === 0 ? 'SDK runner working…' : `SDK runner addressing gate feedback (round ${round + 1})…` });

      const options = {
        cwd: checkoutDir,
        model: ready.model,
        allowedTools: [...SDK_ALLOWED_TOOLS],
        permissionMode: 'bypassPermissions',
        settingSources: ['project'], // auto-load .claude/CLAUDE.md from cwd
        maxTurns: SDK_MAX_TURNS_PER_ROUND,
        env,
        ...hookOptions, // PreToolUse guardrails + PostToolUse audit
        ...(sessionId ? { resume: sessionId } : {}),
      };

      const round1 = await runSdkQuery({ query, prompt, options, cycleId: cycle.id, round, logEvent, noProgLimit });
      if (round1.sessionId) sessionId = round1.sessionId;
      // Usage accounting — COST is cache-aware; the TOKEN COUNT + soft-pause budget
      // are fresh input+output only (a cache read re-reads the whole prefix; counting
      // it would trip the pause on re-reads). Mirrors runner.js exactly.
      const u = round1.usage;
      const cost = costCentsForUsage({ inputTokens: u.inputTokens, outputTokens: u.outputTokens, cacheReadTokens: u.cacheReadTokens, cacheWriteTokens: u.cacheWriteTokens }, price);
      const turnTokens = u.inputTokens + u.outputTokens;
      usedTokensThisRun += turnTokens;
      usedCostThisRun += cost;
      runUsage.input += u.inputTokens || 0;
      runUsage.output += u.outputTokens || 0;
      runUsage.cache_read += u.cacheReadTokens || 0;
      runUsage.cache_write += u.cacheWriteTokens || 0;
      addCycleUsage(cycle.id, { tokens: turnTokens, costCents: cost });
      try {
        updateCycle(cycle.id, {
          input_tokens: runUsage.input, output_tokens: runUsage.output,
          cache_read_tokens: runUsage.cache_read, cache_write_tokens: runUsage.cache_write,
          usage_schema_version: USAGE_SCHEMA_VERSION,
        });
      } catch (e) { console.warn('[mock2] canonical usage write failed:', e?.message); }
      try { insertLedgerEntry({ projectId, cycleId: cycle.id, connectorId: ready.connector.id, model: ready.model, inputTokens: u.inputTokens, outputTokens: u.outputTokens, costCents: cost, wallClockMs: 0 }); } catch (e) { console.warn('[mock2] ledger write failed:', e?.message); }
      logEvent('ai_message', { role: 'assistant', content: round1.summary || '', meta: { round, num_turns: round1.numTurns, input_tokens: u.inputTokens, output_tokens: u.outputTokens, cache_read_tokens: u.cacheReadTokens, cache_write_tokens: u.cacheWriteTokens, cost_cents: cost, total_cost_usd: round1.totalCostUsd, sdk_error: round1.error || null } });
      touchLock(projectId, holder);

      // No-progress circuit breaker (harness safety, SDK equivalent): the query
      // stream was aborted mid-round because the SDK loop was stuck (repeated
      // no-tool / near-identical turns). End as BLOCKED via the shared halt — never
      // keep re-prompting. Sync partial edits back first so they're checkpointed.
      if (round1.breakerTripped) {
        try { await pushWorkingTree(containerName, checkoutDir); } catch { /* best effort */ }
        await haltCycle({ cycle: getCycle(cycle.id), project, containerName, holder, gateReports: lastGateReports, gateScripts, framework, trigger: round1.breakerTrigger, reason: `Auto-stopped after no progress in the SDK runner (${haltReasonLabel(round1.breakerTrigger)}).`, logEvent });
        return scheduleJobCleanup(cycle.id);
      }

      // Safety refusal (Fable 5's classifier can emit stop_reason "refusal"; Opus 4.8
      // never does). Map it to the shared halt — needs-attention, resumable — exactly as
      // the hand-rolled runner does. Never a crash, never a retry loop.
      if (round1.refusal) {
        try { await pushWorkingTree(containerName, checkoutDir); } catch { /* best effort */ }
        await haltCycle({ cycle: getCycle(cycle.id), project, containerName, holder, gateReports: lastGateReports, gateScripts, framework, trigger: 'model_refusal', reason: REFUSAL_HALT_REASON, options: [], logEvent });
        return scheduleJobCleanup(cycle.id);
      }

      // Sync the SDK's edits back into the container (excluding our .claude/ and the
      // heavy dirs), then run the SAME pinned battery there.
      const pushed = await pushWorkingTree(containerName, checkoutDir);
      if (!pushed.ok) {
        finishCycle(cycle.id, { status: 'failed', error: `could not sync the SDK's changes back into the container: ${pushed.error}` });
        releaseLock(projectId, holder);
        setJob(cycle.id, { phase: 'failed', message: 'Could not sync the SDK changes back.' });
        return scheduleJobCleanup(cycle.id);
      }
      battery = await runGateBattery(cycle.id, containerName, gateScripts);
      lastGateReports = battery;
      logEvent('gate', { role: 'system', content: formatGateReports(battery), meta: { gates: battery, green: !gateScripts.length || allGatesGreen(battery), round } });
      // A framework with zero gates is vacuously green (placeholder content, R8).
      green = !gateScripts.length || allGatesGreen(battery);
      if (green) break;
    }

    // 4) Terminal: gates green → checkpoint + change record + deploy (IDENTICAL to
    //    the hand-rolled finish path). Not green after the rounds → checkpoint the
    //    WIP and PAUSE (resumable), same as the hand-rolled backstop.
    if (!green) {
      await checkpointAndRecord({ cycle: getCycle(cycle.id), project, containerName, holder, gateReports: lastGateReports, gateScripts, framework, summary: 'checkpoint: gates not green after SDK rounds' });
      updateCycle(cycle.id, { pause_reason: 'max_turns' });
      finishCycle(cycle.id, { status: 'interrupted', error: `Paused — gates still red after ${SDK_MAX_GATE_ROUNDS} SDK rounds. Resume to continue.` });
      releaseLock(projectId, holder);
      setJob(cycle.id, { phase: 'paused', message: 'Paused — gates still red after the SDK rounds. Resume to continue.' });
      void notifyCycleComplete({ project: { id: projectId, name: project.name }, cycle: getCycle(cycle.id), outcome: 'paused' });
      return scheduleJobCleanup(cycle.id);
    }

    const record = await checkpointAndRecord({ cycle: getCycle(cycle.id), project, containerName, holder, gateReports: battery, gateScripts, framework, summary: 'SDK runner change' });
    logEvent('checkpoint', { role: 'system', content: 'SDK runner change', meta: { commit_sha: record?.commit_sha || null, seq: record?.seq ?? null } });

    const deployed = await deployStage({ cycle: getCycle(cycle.id), project, containerName, holder });
    if (!deployed.ok) {
      logEvent('deploy', { role: 'system', content: deployed.error || 'deploy failed', meta: { ok: false } });
      finishCycle(cycle.id, { status: 'failed', error: deployed.error });
      releaseLock(projectId, holder);
      setJob(cycle.id, { phase: 'deploy_failed', message: deployed.error, commit: record?.commit_sha || null });
      void notifyCycleComplete({ project: { id: projectId, name: project.name }, cycle: getCycle(cycle.id), outcome: 'deploy_failed' });
      return scheduleJobCleanup(cycle.id);
    }
    logEvent('deploy', { role: 'system', content: deployed.skipped ? 'No run contract — placeholder still serving (nothing to deploy).' : 'Deployed — app serving on its live URL.', meta: { ok: true, skipped: !!deployed.skipped } });

    // e2e/journey SMOKE GATE — identical to the hand-rolled runner (harness parity):
    // cheap HTTP always; browser + read-only DB connectors only on a relevance hit
    // (default OFF). Same shared code path, so the run/skip decision is runner-agnostic.
    if (!deployed.skipped) {
      const smoke = await smokeAfterDeploy({ containerName, appDir: APP_DIR, webPort: project.web_port || 3000, commitSha: record?.commit_sha, summary: 'SDK runner change', instruction: cycle.instruction, logEvent, env: process.env });
      if (!smoke.ok) {
        const detail = smokeFailSummary(smoke.report);
        finishCycle(cycle.id, { status: 'failed', error: `Smoke gate failed after deploy — ${detail}` });
        releaseLock(projectId, holder);
        setJob(cycle.id, { phase: 'smoke_failed', message: `Smoke gate failed — ${detail}`, commit: record?.commit_sha || null });
        void notifyCycleComplete({ project: { id: projectId, name: project.name }, cycle: getCycle(cycle.id), outcome: 'smoke_failed' });
        return scheduleJobCleanup(cycle.id);
      }
    }
    finishCycle(cycle.id, { status: 'succeeded' });
    try { const rc = getCycle(cycle.id); if (rc?.request_id) closeRequest(rc.request_id, 'succeeded'); } catch { /* best effort */ }
    releaseLock(projectId, holder);
    updateProject(projectId, { last_activity_at: nowIso() });
    setJob(cycle.id, {
      phase: deployed.skipped ? 'succeeded' : 'serving',
      message: deployed.skipped ? 'Change complete — gates green, checkpoint recorded.' : 'Deployed — gates green and the app is live on its URL.',
      commit: record?.commit_sha || null,
    });
    void notifyCycleComplete({ project: { id: projectId, name: project.name }, cycle: getCycle(cycle.id), outcome: 'succeeded' });
    return scheduleJobCleanup(cycle.id);
  } finally {
    if (checkoutDir) { try { await rm(checkoutDir, { recursive: true, force: true }); } catch { /* best effort */ } }
  }
}

// ---- SDK query() driver: iterate the message stream for ONE round ----

// Runs the async generator to completion, capturing session id + result usage and
// logging assistant text / tool calls into the durable transcript. Never throws —
// a failed query resolves with a best-effort summary + error so the caller decides
// (gate feedback / pause) rather than crashing the cycle.
//
// No-progress circuit breaker (SDK equivalent of the hand-rolled runner's): each
// assistant message is folded into updateProgress; when it trips (repeated no-tool
// / near-identical / no-state-change), we ABORT the query stream (abortController)
// and return breakerTripped so the caller halts as blocked — the same behavior,
// same threshold, so a stuck SDK loop can't spin the way the ADP repro did.
async function runSdkQuery({ query, prompt, options, cycleId, round, logEvent, noProgLimit = 3 }) {
  const out = { sessionId: null, summary: '', usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, numTurns: 0, totalCostUsd: 0, error: null, breakerTripped: false, breakerTrigger: null, refusal: false };
  const abort = new AbortController();
  const opts = { ...options, abortController: abort };
  let progress = initProgressState();
  try {
    for await (const msg of query({ prompt, options: opts })) {
      if (!msg || typeof msg !== 'object') continue;
      if (msg.type === 'system') {
        if (msg.session_id) out.sessionId = msg.session_id;
        continue;
      }
      if (msg.type === 'assistant') {
        const { text, toolCalls } = extractAssistant(msg);
        if (text) { out.summary = text; logEvent('ai_message', { role: 'assistant', content: text, meta: { round, stream: true } }); }
        for (const tc of toolCalls) logEvent('tool_call', { role: 'assistant', content: tc.name, meta: { name: tc.name, input: tc.input, round } });
        // Fold into the no-progress breaker; abort + halt if the SDK loop is stuck.
        const p = updateProgress(progress, { toolCalls, text }, noProgLimit);
        progress = p.state;
        if (p.tripped) {
          out.breakerTripped = true;
          out.breakerTrigger = p.trigger;
          logEvent('note', { role: 'system', content: `No-progress breaker tripped (${p.trigger}); aborting the SDK round.`, meta: { round, trigger: p.trigger } });
          try { abort.abort(); } catch { /* ignore */ }
          break;
        }
        continue;
      }
      if (msg.type === 'result') {
        const r = msg.result && typeof msg.result === 'object' ? msg.result : msg;
        const usage = r.usage || {};
        out.usage = {
          inputTokens: usage.input_tokens || 0,
          outputTokens: usage.output_tokens || 0,
          cacheReadTokens: usage.cache_read_input_tokens || 0,
          cacheWriteTokens: usage.cache_creation_input_tokens || 0,
        };
        out.numTurns = r.num_turns || 0;
        out.totalCostUsd = r.total_cost_usd || msg.total_cost_usd || 0;
        // A safety refusal surfaces via stop_reason/subtype "refusal" — flag it so the
        // caller halts (needs-attention) rather than treating it as a hard error.
        if (isRefusalStop(r.stop_reason) || String(msg.subtype || '').toLowerCase() === 'refusal') {
          out.refusal = true;
        } else if (r.success === false || (typeof msg.subtype === 'string' && msg.subtype.startsWith('error'))) {
          out.error = String(r.stop_reason || msg.subtype || 'sdk reported failure');
        }
        if (typeof r.result === 'string' && r.result) out.summary = r.result;
      }
    }
  } catch (err) {
    // Our own breaker abort surfaces as an AbortError — that's expected, not a
    // query failure; the caller halts on breakerTripped.
    if (!out.breakerTripped) {
      out.error = `sdk query failed: ${err?.message || err}`;
      logEvent('note', { role: 'system', content: out.error, meta: { round } });
    }
  }
  return out;
}

// Pull the assistant message's text + tool_use calls out of the SDK's content
// blocks (defensive about the exact shape across SDK versions).
function extractAssistant(msg) {
  const content = Array.isArray(msg.content) ? msg.content
    : (msg.message && Array.isArray(msg.message.content) ? msg.message.content : []);
  let text = '';
  const toolCalls = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && block.text) text += block.text;
    else if (block.type === 'tool_use') toolCalls.push({ name: block.name || 'tool', input: block.input || {} });
  }
  return { text: text.trim(), toolCalls };
}

// ---- container <-> local checkout sync ----
//
// Both directions stream through the SAME proven channel host.js/containerSh use:
// bytes piped through `incus exec <c> -- <cmd reading stdin>` (the nsenter pivot is
// handled for us). The tarball is base64 for a text-safe stdout (pull) and fed via
// the host command's own stdin (push) so neither the tarball nor its base64 ever
// lands on a command line (no E2BIG). The local half (extract/create) runs in this
// Node process's namespace via child_process `tar` — the same namespace the SDK's
// built-in tools operate in.

async function pullWorkingTree(containerName, checkoutDir) {
  const script = `cd '${APP_DIR}' 2>/dev/null || exit 3\n`
    + `tar -cf - ${TAR_EXCLUDES.join(' ')} . 2>/dev/null | base64 | tr -d '\\n'\n`;
  const r = await containerSh(containerName, script, { timeoutMs: 180000 });
  if (r.code !== 0) return { ok: false, error: (r.stderr || 'tar/export failed').trim().slice(-300) };
  const b64 = (r.stdout || '').trim();
  if (!b64) return { ok: true }; // empty tree — nothing to extract
  const tarPath = join(checkoutDir, '.mock2-pull.tar');
  try {
    await writeFile(tarPath, Buffer.from(b64, 'base64'));
    await execFileP('tar', ['-xf', tarPath, '-C', checkoutDir]);
    await rm(tarPath, { force: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

async function pushWorkingTree(containerName, checkoutDir) {
  const tarPath = join(checkoutDir, '.mock2-push.tar');
  try {
    // Create the tarball locally, excluding heavy dirs AND our ephemeral .claude/
    // governance so it never enters the project's committed tree.
    await execFileP('tar', ['-cf', tarPath, '-C', checkoutDir, ...TAR_EXCLUDES, '--exclude=./.claude', '--exclude=./.mock2-pull.tar', '--exclude=./.mock2-push.tar', '.']);
    const b64 = (await readFile(tarPath)).toString('base64');
    await rm(tarPath, { force: true });
    // Stream the base64 in via the host command's stdin → decode → into the
    // container's tar -xf - (overwrites changed files; does not delete removed ones,
    // an accepted Phase-1 limitation noted in the migration doc).
    const r = await sh(
      `base64 -d | incus exec ${containerName} -- sh -c "cd '${APP_DIR}' && tar -xf -"`,
      { input: b64, timeoutMs: 180000 },
    );
    if (r.code !== 0) return { ok: false, error: (r.stderr || 'tar/import failed').trim().slice(-300) };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}
