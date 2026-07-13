// Mock2 cycle RUNNER (Phase M6, ADR-003/004; survey §8; brief's Build section).
// The machine: exec into an already-fenced M4 container, make one targeted
// change, run the PINNED gate battery, checkpoint. Triggered by a canned API
// call (no chat yet — chat is M7). This is the first phase that consumes
// everything M5 built: the pinned build_runner slot, canStartCycle, the pinned
// gate scripts, and the M4 squid-fenced container.
//
// The DECISIONS are pure (runner-logic.js / cycle-logic.js / lock-logic.js /
// change-logic.js, all unit-tested stub-first); this module is the host/exec +
// model-call orchestration. It follows the house 202+poll job pattern
// (activeCreations in lxc.js; mirrored in provision.js): startCycle returns
// immediately with the cycle row, the frontend polls the cycle poll endpoint,
// and runCycle drives the loop in the background.
//
// EVERY container exec + host op pivots through host.js (risk R3). The decrypted
// model key is read ORCHESTRATOR-SIDE only and never enters a container.
//
// Terminology (risk R7): the AI build component is the RUNNER; the slot that
// drives it is build_runner. Nothing here is named "agent".

import { sh, b64 } from './host.js';
import { getMock2Db } from './db.js';
import { getProject, updateProject } from './projects.js';
import { containerNameForProject } from './provision.js';
import { buildCheckpointScript } from './template.js';
import { getSlot, getConnector, decryptConnectorKey, listPrices } from './connectors.js';
import { parseCapabilities, slotAssignmentError, isCloudProvider } from './connector-logic.js';
import { getApplicableQuota, periodUsage, insertLedgerEntry } from './quotas.js';
import { canStartCycle, costCentsForUsage } from './quota-logic.js';
import { getCurrentFrameworkVersion } from './framework.js';
import {
  insertCycle, getCycle, updateCycle, addCycleUsage, finishCycle, countRunningCycles,
} from './cycles.js';
import {
  parseGateScripts, initialGateReports, gateBatteryVerdict, allGatesGreen,
  interruptDecision, estimateCycleTokens, shouldStopForBudget, retriesExhausted, MAX_CYCLE_RETRIES,
} from './cycle-logic.js';
import { getLock, acquireLock, releaseLock, touchLock } from './locks.js';
import { insertChangeRecord, changeRecordMirror } from './change-records.js';
import { raiseQueueItem, resolveQueueItem } from './queue.js';
import { getProjectRemote, pushProjectRemote } from './git-connectors.js';
import {
  RUNNER_TOOLS, MAX_TURNS, MAX_TOOL_RESULT_CHARS, truncateToolResult, parseFrameworkSkills,
  buildRunnerSystemPrompt, buildRunnerTask, classifyTurn, describeRunnerStep, STALL_NUDGE,
} from './runner-logic.js';
import { callModelTurn } from './model-client.js';
import { deployProject, readRunContract } from './deploy.js';
import { notifyCycleComplete } from '../lib/notification-dispatch.js';

const APP_DIR = '/srv/app';
const GATES_DIR = '/srv/gates';
const nowIso = () => new Date().toISOString();

// Live cycle-job progress, keyed by cycle id (house 202+poll pattern). The poll
// endpoint reads this alongside the cycle row; entries drop a couple minutes
// after the job settles.
export const activeCycles = new Map();

export function getCycleJobStatus(cycleId) {
  return activeCycles.get(Number(cycleId)) || null;
}

function setJob(cycleId, patch) {
  const cur = activeCycles.get(Number(cycleId)) || {};
  activeCycles.set(Number(cycleId), { ...cur, ...patch, updatedAt: Date.now() });
}
function scheduleJobCleanup(cycleId) {
  setTimeout(() => activeCycles.delete(Number(cycleId)), 120000);
}

// Raise an admin-queue item without letting a queue write abort the cycle (the
// queue is a side effect, never the load-bearing path — the cycle status is).
function safeRaise(item) {
  try { raiseQueueItem(item); } catch (e) { console.warn('[mock2] queue raise failed:', e?.message); }
}

// ---- readiness + estimate (ADR-001 presence-of-credentials) ----

// The build_runner slot must be assigned to an enabled connector whose key
// decrypts orchestrator-side (a cloud provider needs a key; a local ollama may
// not). This is the "environment variable AND presence of credentials" gate:
// even on an enabled host, a cycle cannot start work until a usable model exists.
export function buildRunnerReady() {
  const slot = getSlot('build_runner');
  if (!slot) return { ok: false, reason: 'No build_runner model slot is assigned. Assign one under Model connectors.' };
  const connector = getConnector(slot.connector_id);
  if (!connector) return { ok: false, reason: 'The build_runner slot points at a missing connector.' };
  if (!connector.enabled) return { ok: false, reason: 'The build_runner connector is disabled.' };
  const capErr = slotAssignmentError(parseCapabilities(connector.capabilities), 'build_runner');
  if (capErr) return { ok: false, reason: capErr };
  const apiKey = decryptConnectorKey(connector);
  if (isCloudProvider(connector.provider) && !apiKey) {
    return { ok: false, reason: 'The build_runner connector has no decryptable API key.' };
  }
  return { ok: true, connector, model: slot.model, apiKey };
}

// The effective price row for a connector+model at now (listPrices is model,
// effective_at DESC). Returns the newest row whose effective_at is in the past,
// or null (self-hosted / unpriced ⇒ cost 0).
function effectivePrice(connectorId, model) {
  const now = nowIso();
  return listPrices(connectorId).find((p) => p.model === model && String(p.effective_at) <= now) || null;
}

// The cost ENVELOPE (R5): the buffered token estimate priced at the current rate.
function estimateCycle(connectorId, model) {
  const { inputTokens, outputTokens } = estimateCycleTokens();
  const price = effectivePrice(connectorId, model);
  const estCostCents = costCentsForUsage({ inputTokens, outputTokens }, price);
  return { estTokens: inputTokens + outputTokens, estCostCents, price };
}

// The quota verdict for starting a cycle on this project (canStartCycle is
// built + unit-tested in M5; M6 enforces it). No applicable quota ⇒ allowed.
function quotaVerdict(projectId, estCostCents) {
  const quota = getApplicableQuota(projectId, 'monthly');
  if (!quota) return { verdict: { ok: true }, quota: null };
  const usage = periodUsage({ scope: quota.scope, projectId: quota.scope === 'project' ? quota.project_id : null, period: quota.period });
  const runningCycles = countRunningCycles(quota.scope === 'project' ? projectId : null);
  const verdict = canStartCycle(
    { estCostCents },
    { budgetCents: quota.budget_cents, bufferPct: quota.buffer_pct, maxConcurrentCycles: quota.max_concurrent_cycles },
    { spentCents: usage.costCents, runningCycles },
  );
  return { verdict, quota };
}

// ---- start (route calls this; returns synchronously, runs in background) ----

// startCycle — the cycle-start sequence (04-phased-plan §M6):
//   estimate → canStartCycle quota check (refused_quota terminal) → pin the
//   current framework version → take the lock → copy the pinned gate scripts into
//   the container → run in the background.
// Returns { status:'started'|'refused'|'error', cycle, error }.
export async function startCycle({ project, instruction, initiatedBy, actingAsAdmin = 0 }) {
  const projectId = Number(project.id);

  const ready = buildRunnerReady();
  if (!ready.ok) return { status: 'error', error: ready.reason };

  // The container must be up (an active project). The lock guards it, so we also
  // refuse if someone/something already holds the checkout.
  if (project.lifecycle !== 'active') {
    return { status: 'error', error: `Project must be online to run a cycle (it is "${project.lifecycle}").` };
  }
  const existingLock = getLock(projectId);
  if (existingLock && (existingLock.holder_cycle_id != null || existingLock.holder_user_id != null)) {
    return { status: 'error', error: 'This project is checked out by another writer. Wait, or request a takeover.' };
  }

  // Pin the framework version at start (ADR-003) — the whole cycle uses THIS
  // version's gate scripts and content, stamped immutably on the cycle + records.
  const framework = getCurrentFrameworkVersion();
  if (!framework) return { status: 'error', error: 'No framework version exists to pin. Publish one first.' };

  const { estTokens, estCostCents } = estimateCycle(ready.connector.id, ready.model);
  const { verdict } = quotaVerdict(projectId, estCostCents);
  if (!verdict.ok) {
    // refused_quota is a real terminal cycle status (migration 502 CHECK). Record
    // the refused cycle so the UI + ledger reflect it.
    const refused = insertCycle({
      projectId, frameworkVersionId: framework.id, stage: 'build', instruction,
      initiatedBy, actingAsAdmin, estTokens, estCostCents, status: 'refused_quota',
    });
    finishCycle(refused.id, { status: 'refused_quota', error: verdict.reason });
    safeRaise({
      kind: 'quota_exhausted', project_id: projectId, dedupe_key: `mock2-quota:${projectId}`,
      ref_table: 'mock2_cycles', ref_id: refused.id, detail: `${project.name}: ${verdict.reason}`,
    });
    return { status: 'refused', cycle: getCycle(refused.id), error: verdict.reason };
  }

  // Create the cycle (estimating), then take the lock as the cycle holder.
  const cycle = insertCycle({
    projectId, frameworkVersionId: framework.id, stage: 'build', instruction,
    initiatedBy, actingAsAdmin, estTokens, estCostCents, status: 'estimating',
  });
  const lock = acquireLock({ projectId, requester: { type: 'cycle', id: cycle.id }, role: 'admin' });
  if (!lock.ok) {
    finishCycle(cycle.id, { status: 'failed', error: `could not acquire checkout lock: ${lock.reason}` });
    return { status: 'error', cycle: getCycle(cycle.id), error: `Could not acquire the checkout lock: ${lock.reason}` };
  }

  const containerName = project.container_name || containerNameForProject(projectId);
  const gateScripts = parseGateScripts(framework.gates_json);

  setJob(cycle.id, { phase: 'starting', message: 'Copying pinned gates into the container…', startedAt: Date.now() });

  // Fire-and-forget; runCycle owns its own error handling and always lands the
  // cycle terminal + releases the lock.
  runCycle({ cycle, project, containerName, framework, gateScripts, ready }).catch((err) => {
    console.error(`[mock2] runner crashed for cycle ${cycle.id}:`, err?.message || err);
    try { finishCycle(cycle.id, { status: 'failed', error: `runner crashed: ${err?.message || err}` }); } catch { /* ignore */ }
    try { releaseLock(projectId, { type: 'cycle', id: cycle.id }); } catch { /* ignore */ }
    setJob(cycle.id, { phase: 'failed', message: `runner crashed: ${err?.message || err}` });
    scheduleJobCleanup(cycle.id);
  });

  return { status: 'started', cycle: getCycle(cycle.id) };
}

// retryCycle — resume a build that stalled awaiting an admin because the runner
// exhausted its retries on a TRANSIENT failure (e.g. an upstream 429 rate limit).
// The stalled cycle already checkpointed its WIP and released the lock, so we just
// clear its handoff queue item and start a FRESH cycle with the same instruction —
// which continues from that checkpoint in the container. Editors can self-serve
// this once they've fixed the underlying cause (added billing, raised the limit);
// it is NOT a bypass for an audit-stage framework deviation (that clears only when
// an admin resolves the deviation, so those cycles carry no `error` and the UI
// won't offer Retry). Returns the same shape as startCycle.
export async function retryCycle({ project, cycle, initiatedBy, actingAsAdmin = 0 }) {
  if (!cycle) return { status: 'error', error: 'No cycle to retry.' };
  if (!['awaiting_admin', 'failed'].includes(cycle.status)) {
    return { status: 'error', error: `This cycle is "${cycle.status}" — there is nothing to retry.` };
  }
  // Clear the retries/quota handoff so it stops nagging in the admin queue (both
  // dedupe keys the escalation paths use). Best-effort — a missing item is fine.
  for (const key of [`mock2-retries:${cycle.id}`, `mock2-requeue:${cycle.id}`, `mock2-quota:${project.id}`]) {
    try { resolveQueueItem(key, { resolution: 'retried by editor' }); } catch { /* best effort */ }
  }
  return startCycle({ project, instruction: cycle.instruction, initiatedBy, actingAsAdmin });
}

// ---- the agentic loop ----

async function runCycle({ cycle, project, containerName, framework, gateScripts, ready }) {
  const projectId = Number(project.id);
  const holder = { type: 'cycle', id: cycle.id };
  const price = effectivePrice(ready.connector.id, ready.model);

  // Copy the PINNED gate scripts into the container (ADR-003 — this version's, not
  // "latest"). Stamp the initial (all-pending) gate report on the cycle.
  const copied = await copyGatesIntoContainer(containerName, gateScripts);
  if (!copied.ok) {
    finishCycle(cycle.id, { status: 'failed', error: `could not copy gates into container: ${copied.error}` });
    releaseLock(projectId, holder);
    setJob(cycle.id, { phase: 'failed', message: copied.error });
    return scheduleJobCleanup(cycle.id);
  }
  updateCycle(cycle.id, { status: 'running', started_at: nowIso(), gates_json: JSON.stringify(initialGateReports(gateScripts)) });
  setJob(cycle.id, { phase: 'running', message: 'Runner working…' });

  const skills = parseFrameworkSkills(framework.skills_json);
  const system = buildRunnerSystemPrompt({ constitution: framework.constitution_md, skills, appDir: APP_DIR, webPort: project.web_port || 3000 });
  const transcript = [{ role: 'user', text: buildRunnerTask(cycle.instruction) }];

  let lastGateReports = initialGateReports(gateScripts);

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    // 1) Honor interrupts at the step boundary.
    const fresh = getCycle(cycle.id);
    if (!fresh || fresh.status !== 'running') {
      // An external actor (admin stop-all / delete) already moved it off running.
      releaseLock(projectId, holder);
      return scheduleJobCleanup(cycle.id);
    }
    const ir = interruptDecision(fresh.interrupt_request);
    if (ir.stop) {
      if (ir.checkpointFirst) await checkpointAndRecord({ cycle: fresh, project, containerName, holder, gateReports: lastGateReports, gateScripts, framework, summary: `checkpoint: ${ir.terminalStatus}` });
      finishCycle(cycle.id, { status: ir.terminalStatus, error: `interrupted (${fresh.interrupt_request})` });
      releaseLock(projectId, holder);
      if (ir.queued) {
        safeRaise({ kind: 'retries_exhausted', project_id: projectId, dedupe_key: `mock2-requeue:${cycle.id}`, ref_table: 'mock2_cycles', ref_id: cycle.id, detail: `${project.name}: cycle re-queued by editor` });
      }
      setJob(cycle.id, { phase: 'stopped', message: `Stopped (${fresh.interrupt_request})` });
      return scheduleJobCleanup(cycle.id);
    }

    // 2) Mid-cycle buffer stop (R5 — the real guard). Checked against the ledger.
    const q = getApplicableQuota(projectId, 'monthly');
    if (q) {
      const usage = periodUsage({ scope: q.scope, projectId: q.scope === 'project' ? q.project_id : null, period: q.period });
      if (shouldStopForBudget({ budgetCents: q.budget_cents, spentCents: usage.costCents })) {
        await checkpointAndRecord({ cycle: fresh, project, containerName, holder, gateReports: lastGateReports, gateScripts, framework, summary: 'checkpoint: budget buffer crossed' });
        finishCycle(cycle.id, { status: 'interrupted', error: 'budget buffer crossed mid-cycle — checkpointed and stopped' });
        releaseLock(projectId, holder);
        safeRaise({ kind: 'quota_exhausted', project_id: projectId, dedupe_key: `mock2-quota:${projectId}`, ref_table: 'mock2_cycles', ref_id: cycle.id, detail: `${project.name}: budget crossed mid-cycle` });
        setJob(cycle.id, { phase: 'stopped', message: 'Budget buffer crossed — checkpointed and stopped' });
        return scheduleJobCleanup(cycle.id);
      }
    }

    // 3) Call the build_runner model for the next step.
    const result = await callModelTurn({ connector: ready.connector, apiKey: ready.apiKey, model: ready.model, system, tools: RUNNER_TOOLS, transcript, maxTokens: 8000 });
    if (!result.ok) {
      // Transient model failure — retry up to MAX_CYCLE_RETRIES, then escalate.
      const retries = (getCycle(cycle.id).retries || 0) + 1;
      updateCycle(cycle.id, { retries });
      if (retriesExhausted(retries)) {
        await escalateAwaitingAdmin({ cycle: getCycle(cycle.id), project, containerName, holder, reason: result.error });
        return scheduleJobCleanup(cycle.id);
      }
      setJob(cycle.id, { phase: 'retrying', message: `Model call failed (retry ${retries}/${MAX_CYCLE_RETRIES}): ${result.error}` });
      continue;
    }

    // Ledger + usage after every model call (M5 writer).
    const costCents = costCentsForUsage({ inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens }, price);
    addCycleUsage(cycle.id, { tokens: result.usage.inputTokens + result.usage.outputTokens, costCents });
    try { insertLedgerEntry({ projectId, cycleId: cycle.id, connectorId: ready.connector.id, model: ready.model, inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, costCents, wallClockMs: 0 }); } catch (e) { console.warn('[mock2] ledger write failed:', e?.message); }

    // Only record a NON-EMPTY assistant turn. An empty one (no text, no tool
    // calls) serializes to empty message content, which Anthropic/OpenAI reject —
    // re-sending it would 400 every subsequent call and derail the cycle. When
    // the model stalls with nothing, we skip its turn and nudge below instead.
    if (result.text || (result.toolCalls && result.toolCalls.length)) {
      transcript.push({ role: 'assistant', text: result.text || '', toolCalls: result.toolCalls || [] });
    }
    const decision = classifyTurn(result.toolCalls);

    // Surface task-level progress for the poll UI ("Step 3 · writing
    // public/index.html") so the Builder can see what the runner is doing rather
    // than a static "running". The terminal branches below set their own message.
    setJob(cycle.id, { phase: 'running', message: describeRunnerStep(turn, result.toolCalls) });

    // 4) The model declared finish — verify the gates are actually green before
    //    accepting it (it never approves its own work: we re-run the battery).
    if (decision.done) {
      // The turn may pair `finish` with other tool calls — answer EVERY tool_use
      // (providers reject a follow-up with an unmatched tool_use id). Execute the
      // non-finish calls, then verify the battery.
      for (const call of decision.toolCalls) {
        if (call.name === 'finish') continue;
        const out = await executeTool({ call, cycle, containerName, holder, gateScripts });
        lastGateReports = out.gateReports || lastGateReports;
        transcript.push({ role: 'tool', toolCallId: call.id, name: call.name, content: truncateToolResult(out.content) });
      }
      const battery = await runGateBattery(cycle.id, containerName, gateScripts);
      lastGateReports = battery;
      // A framework with zero gates (placeholder content, risk R8 — parseGateScripts
      // returns []) is vacuously green: there is nothing to fail, so finish is
      // accepted. Only reject finish when there ARE gates and one isn't green.
      if (gateScripts.length && !allGatesGreen(battery)) {
        // Not green — feed the finish call its verdict and keep working ("review,
        // not error"). The next model turn answers with fresh work.
        transcript.push({ role: 'tool', toolCallId: finishCallId(result.toolCalls), name: 'finish', content: `Gates are not all green yet — you cannot finish. Battery:\n${formatGateReports(battery)}` });
        touchLock(projectId, holder);
        continue;
      }
      const record = await checkpointAndRecord({ cycle: getCycle(cycle.id), project, containerName, holder, gateReports: battery, gateScripts, framework, summary: decision.finishSummary });

      // Run phase — deploy the built app so "succeeded" means "serving". Install
      // deps → migrate (in-container Postgres, ADR-008) → build → swap the systemd
      // unit's ExecStart to the manifest `start` command → restart → health-check,
      // all inside the container through host.js while still holding the checkout
      // lock (ADR-004). A placeholder project (no run contract) is a no-op; a
      // deploy failure is a distinct, retryable terminal state (not a silent
      // success). The live URL then serves the real app (the CycleCard reloads
      // the preview on success via onBuilt).
      const deployed = await deployStage({ cycle: getCycle(cycle.id), project, containerName, holder });
      if (!deployed.ok) {
        finishCycle(cycle.id, { status: 'failed', error: deployed.error });
        releaseLock(projectId, holder);
        setJob(cycle.id, { phase: 'deploy_failed', message: deployed.error, commit: record?.commit_sha || null });
        void notifyCycleComplete({ project: { id: projectId, name: project.name }, cycle: getCycle(cycle.id), outcome: 'deploy_failed' });
        return scheduleJobCleanup(cycle.id);
      }
      finishCycle(cycle.id, { status: 'succeeded' });
      releaseLock(projectId, holder);
      updateProject(projectId, { last_activity_at: nowIso() });
      setJob(cycle.id, {
        phase: deployed.skipped ? 'succeeded' : 'serving',
        message: deployed.skipped
          ? 'Change complete — gates green, checkpoint recorded.'
          : 'Deployed — gates green and the app is live on its URL.',
        commit: record?.commit_sha || null,
      });
      void notifyCycleComplete({ project: { id: projectId, name: project.name }, cycle: getCycle(cycle.id), outcome: 'succeeded' });
      return scheduleJobCleanup(cycle.id);
    }

    // 5) The model stalled (no tool call) — nudge and continue.
    if (decision.stalled) {
      transcript.push({ role: 'user', text: STALL_NUDGE });
      continue;
    }

    // 6) Execute the requested tools; feed results back.
    for (const call of decision.toolCalls) {
      const out = await executeTool({ call, cycle, containerName, holder, gateScripts });
      lastGateReports = out.gateReports || lastGateReports;
      transcript.push({ role: 'tool', toolCallId: call.id, name: call.name, content: truncateToolResult(out.content) });
    }
    touchLock(projectId, holder); // any exec/write refreshed the idle timer
  }

  // Loop ceiling hit — checkpoint WIP, fail, release.
  await checkpointAndRecord({ cycle: getCycle(cycle.id), project, containerName, holder, gateReports: lastGateReports, gateScripts, framework, summary: 'checkpoint: max turns reached' });
  finishCycle(cycle.id, { status: 'failed', error: `runner exceeded ${MAX_TURNS} turns without finishing` });
  releaseLock(projectId, holder);
  setJob(cycle.id, { phase: 'failed', message: `Exceeded ${MAX_TURNS} turns without a green finish.` });
  void notifyCycleComplete({ project: { id: projectId, name: project.name }, cycle: getCycle(cycle.id), outcome: 'failed' });
  scheduleJobCleanup(cycle.id);
}

function finishCallId(toolCalls = []) {
  return (toolCalls.find((c) => c && c.name === 'finish') || {}).id || 'finish';
}

// ---- tool execution against the fenced container ----

async function executeTool({ call, cycle, containerName, holder, gateScripts }) {
  switch (call.name) {
    case 'exec_in_container': {
      const r = await execInContainer(containerName, String(call.input?.command || ''));
      touchLock(cycle.project_id, holder);
      return { content: `exit ${r.code}\n${r.stdout || ''}${r.stderr ? `\n[stderr]\n${r.stderr}` : ''}` };
    }
    case 'read_file': {
      const r = await readFileInContainer(containerName, String(call.input?.path || ''));
      return { content: r.ok ? r.content : `error: ${r.error}` };
    }
    case 'write_file': {
      const r = await writeFileInContainer(containerName, String(call.input?.path || ''), String(call.input?.content ?? ''));
      touchLock(cycle.project_id, holder);
      return { content: r.ok ? `wrote ${call.input?.path}` : `error: ${r.error}` };
    }
    case 'run_gates': {
      const battery = await runGateBattery(cycle.id, containerName, gateScripts);
      return { content: `Gate battery (${gateBatteryVerdict(battery)}):\n${formatGateReports(battery)}`, gateReports: battery };
    }
    default:
      return { content: `error: unknown tool "${call.name}"` };
  }
}

// A safe relative path: no traversal, no absolute. Returns null on rejection.
function safeRel(path) {
  const p = String(path || '').trim();
  if (!p || p.startsWith('/') || p.split('/').some((seg) => seg === '..')) return null;
  return p;
}

// Run a shell script INSIDE the container (base64-streamed to `incus exec -- sh`,
// so no quoting hazard from model-supplied content). Always resolves.
function containerSh(containerName, script, { timeoutMs = 120000 } = {}) {
  return sh(`printf '%s' '${b64(script)}' | base64 -d | incus exec ${containerName} -- sh`, { timeoutMs });
}

async function execInContainer(containerName, command) {
  const script = `cd '${APP_DIR}' 2>/dev/null || cd /\n${command}\n`;
  const r = await containerSh(containerName, script, { timeoutMs: 180000 });
  return { code: r.code, stdout: (r.stdout || '').slice(0, MAX_TOOL_RESULT_CHARS), stderr: (r.stderr || '').slice(0, 2000) };
}

async function readFileInContainer(containerName, path) {
  const rel = safeRel(path);
  if (!rel) return { ok: false, error: 'path must be relative and inside the app dir' };
  const script = `p=$(printf '%s' '${b64(rel)}' | base64 -d); cat "${APP_DIR}/$p"`;
  const r = await containerSh(containerName, script);
  if (r.code !== 0) return { ok: false, error: (r.stderr || 'read failed').trim().slice(-300) };
  return { ok: true, content: r.stdout || '' };
}

async function writeFileInContainer(containerName, path, content) {
  const rel = safeRel(path);
  if (!rel) return { ok: false, error: 'path must be relative and inside the app dir' };
  const script = `p=$(printf '%s' '${b64(rel)}' | base64 -d); d="${APP_DIR}/$p"; mkdir -p "$(dirname "$d")"; printf '%s' '${b64(content)}' | base64 -d > "$d" && echo ok`;
  const r = await containerSh(containerName, script);
  if (r.code !== 0) return { ok: false, error: (r.stderr || 'write failed').trim().slice(-300) };
  return { ok: true };
}

function gateFilename(gate, i) {
  const safeName = String(gate.name || 'gate').replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 40);
  return `${String(i).padStart(2, '0')}-${safeName}.sh`;
}

// Copy the pinned gate scripts into GATES_DIR (ADR-003). One host round-trip.
async function copyGatesIntoContainer(containerName, gateScripts) {
  let script = `mkdir -p ${GATES_DIR}\n`;
  gateScripts.forEach((g, i) => {
    const f = gateFilename(g, i);
    script += `printf '%s' '${b64(g.script)}' | base64 -d > "${GATES_DIR}/${f}"\nchmod +x "${GATES_DIR}/${f}"\n`;
  });
  script += 'echo gates-copied\n';
  const r = await containerSh(containerName, script);
  if (r.code !== 0) return { ok: false, error: (r.stderr || r.stdout || 'gate copy failed').trim().slice(-300) };
  return { ok: true };
}

// Run the whole gate battery, updating the cycle's gates_json + current_gate as
// each gate runs (the "gates going green" view). Returns the report list. Gate
// output is stored per gate for the "review, not error" framing.
async function runGateBattery(cycleId, containerName, gateScripts) {
  const reports = gateScripts.map((g) => ({ name: g.name, status: 'pending', started_at: null, report: null }));
  for (let i = 0; i < gateScripts.length; i++) {
    reports[i].status = 'running';
    reports[i].started_at = nowIso();
    updateCycle(cycleId, { current_gate: gateScripts[i].name, gates_json: JSON.stringify(reports) });
    const f = gateFilename(gateScripts[i], i);
    const script = `cd '${APP_DIR}' 2>/dev/null || cd /\nsh '${GATES_DIR}/${f}' 2>&1\necho "__MOCK2_GATE_EXIT__:$?"`;
    const r = await containerSh(containerName, script, { timeoutMs: 300000 });
    const out = r.stdout || '';
    const m = out.match(/__MOCK2_GATE_EXIT__:(\d+)\s*$/);
    const exit = m ? Number(m[1]) : (r.code === 0 ? 0 : 1);
    reports[i].status = exit === 0 ? 'passed' : 'failed';
    reports[i].report = out.replace(/__MOCK2_GATE_EXIT__:\d+\s*$/, '').trim().slice(-MAX_TOOL_RESULT_CHARS);
    updateCycle(cycleId, { gates_json: JSON.stringify(reports) });
  }
  updateCycle(cycleId, { current_gate: null, gates_json: JSON.stringify(reports) });
  return reports;
}

function formatGateReports(reports) {
  return reports.map((g) => `- ${g.name}: ${g.status}${g.report ? `\n    ${g.report.split('\n').slice(-3).join('\n    ')}` : ''}`).join('\n');
}

// ---- checkpoint → change record → mirror → push ----

// Checkpoint the working tree into the bare repo (ADR-006 mount), insert the
// hash-chained change record, mirror it into the repo, and push to a
// push_on_checkpoint remote if configured. Returns the inserted record (or null).
async function checkpointAndRecord({ cycle, project, containerName, holder, gateReports, gateScripts, framework, summary }) {
  const projectId = Number(project.id);
  setJob(cycle.id, { phase: 'checkpoint', message: 'Checkpointing into the bare repo…' });

  // 1) Commit + push into the bare repo (over the ADR-011 mount).
  const commitScript = buildCheckpointScript({ appDir: APP_DIR, message: summary || 'checkpoint: mock2 cycle' });
  const cp = await containerSh(containerName, commitScript, { timeoutMs: 120000 });
  if (cp.code !== 0) {
    console.warn(`[mock2] checkpoint non-zero for cycle ${cycle.id}: ${(cp.stdout || cp.stderr || '').trim().slice(-300)}`);
  }
  // 2) Read the checkpoint commit sha.
  const sha = await execInContainer(containerName, `git -C ${APP_DIR} rev-parse HEAD 2>/dev/null`);
  const commitSha = (sha.stdout || '').trim().split('\n').pop() || null;

  // 3) Insert the hash-chained change record.
  const gatesRun = (gateReports || []).map((g) => ({ name: g.name, result: g.status }));
  let record = null;
  try {
    record = insertChangeRecord({
      projectId, cycleId: cycle.id, initiatedBy: cycle.initiated_by, actingAsAdmin: cycle.acting_as_admin,
      frameworkVersion: framework.version, frameworkVersionId: framework.id,
      gatesRun, commitSha, summary: summary || 'checkpoint',
    });
  } catch (e) {
    console.error('[mock2] change record insert failed:', e?.message);
  }

  // 4) Mirror the record into the repo (state/changes/<seq>.json) + commit it, so
  //    rehydrate restores readable history even if mock2.db is lost.
  if (record) {
    try {
      const mirror = JSON.stringify(changeRecordMirror(record), null, 2);
      await writeFileInContainer(containerName, `state/changes/${record.seq}.json`, mirror);
      const mirrorScript = buildCheckpointScript({ appDir: APP_DIR, message: `mock2: change record ${record.seq}` });
      await containerSh(containerName, mirrorScript, { timeoutMs: 60000 });
    } catch (e) {
      console.warn('[mock2] change-record mirror failed:', e?.message);
    }
  }

  // 5) Orchestrator-side push to an external remote if push_on_checkpoint (ADR-006).
  try {
    const remote = getProjectRemote(projectId);
    if (remote?.push_on_checkpoint) {
      const push = await pushProjectRemote(getProject(projectId));
      if (!push.ok) console.warn(`[mock2] push_on_checkpoint failed for project ${projectId}: ${push.error}`);
    }
  } catch (e) {
    console.warn('[mock2] push_on_checkpoint error:', e?.message);
  }

  return record;
}

// ---- deploy stage (Run phase) ----

// deployStage — after gates are green and the change is checkpointed, install +
// migrate + build + swap the systemd unit to the manifest `start` command +
// restart, so the live URL serves the REAL app instead of the placeholder. The
// run command is DECLARED in mock2.yaml (ADR-005), never sniffed. Reports each
// step through setJob (the CycleCard renders job.message) and refreshes the lock
// (a deploy writes the container). Returns { ok, skipped, error }.
//   - skipped: the project has no run contract (an old placeholder) — the
//     serve.py front door keeps serving; not a failure.
//   - !ok: install/migrate/build/start/health failed — a distinct, retryable
//     terminal state (cycle → 'failed', deploy_status → 'deploy_failed'). The
//     existing editor Retry (CycleCard, cycle.status === 'failed') resumes it.
async function deployStage({ cycle, project, containerName, holder }) {
  const projectId = Number(project.id);
  const webPort = project.web_port || 3000;

  const runContract = await readRunContract(containerName, APP_DIR);
  if (!runContract.hasContract) {
    updateCycle(cycle.id, { deploy_status: null });
    return { ok: true, skipped: true };
  }

  updateCycle(cycle.id, { deploy_status: 'deploying' });
  setJob(cycle.id, { phase: 'deploying', message: 'Deploying — installing dependencies…' });

  const result = await deployProject({
    containerName, appDir: APP_DIR, webPort, runContract,
    onStep: (key, label) => {
      setJob(cycle.id, { phase: 'deploying', message: label });
      touchLock(projectId, holder); // a deploy step writes the container
    },
  });

  if (!result.ok) {
    updateCycle(cycle.id, { deploy_status: 'deploy_failed' });
    return { ok: false, error: `Deploy failed at "${result.step}" — ${result.error}` };
  }
  updateCycle(cycle.id, { deploy_status: 'serving' });
  touchLock(projectId, holder);
  return { ok: true };
}

// Retries exhausted → awaiting_admin + a retries_exhausted queue item + a handoff
// (container name, branch, last error). Terminal-until-an-admin-acts; the lock is
// released (there is no in-process runner to hold it, and an admin re-drives with
// a fresh cycle). 04-phased-plan §M6.
async function escalateAwaitingAdmin({ cycle, project, containerName, holder, reason }) {
  const projectId = Number(project.id);
  // Best-effort WIP checkpoint so the branch is at a recoverable state.
  try {
    const cp = buildCheckpointScript({ appDir: APP_DIR, message: 'checkpoint: auto (retries exhausted)' });
    await containerSh(containerName, cp, { timeoutMs: 60000 });
  } catch { /* best effort */ }
  finishCycle(cycle.id, { status: 'awaiting_admin', error: `retries exhausted: ${reason}` });
  releaseLock(projectId, holder);
  const handoff = { container: containerName, branch: 'main', cycle_id: cycle.id, error: reason };
  safeRaise({
    kind: 'retries_exhausted', project_id: projectId, dedupe_key: `mock2-retries:${cycle.id}`,
    ref_table: 'mock2_cycles', ref_id: cycle.id,
    detail: `${project.name}: cycle ${cycle.id} exhausted ${MAX_CYCLE_RETRIES} retries — ${reason}. Handoff: ${JSON.stringify(handoff)}`,
  });
  setJob(cycle.id, { phase: 'awaiting_admin', message: `Retries exhausted — handed off to an admin. ${reason}` });
}

// ---- admin stop-all (used by the route) ----

// Interrupt every running cycle (admin escape hatch). Sets stop_after_step so the
// runners checkpoint and stop at their next boundary. Returns the count touched.
export function stopAllCycles(reason = 'admin stop-all') {
  const running = getMock2Db().prepare(`SELECT id FROM mock2_cycles WHERE status = 'running'`).all();
  for (const r of running) updateCycle(r.id, { interrupt_request: 'stop_after_step' });
  return { stopped: running.length, reason };
}
