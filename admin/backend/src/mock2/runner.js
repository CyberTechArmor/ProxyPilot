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
import { getSlot, getConnector, decryptConnectorKey, effectivePrice } from './connectors.js';
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
import { insertCycleEvent } from './cycle-events.js';
import {
  insertAuthorization, listGrantedUnusedAuthorizations, markAuthorizationUsed, expireStaleAuthorizations,
} from './authorizations.js';
import { buildResumeContextBlock, resolveSelectedOption, validateAuthScope, validateHaltOptions } from './unblock-logic.js';
import { latestOpenRequestId, closeRequest } from './requests.js';
import { countConsultsForCycle, countConsultsForRequest } from './consults.js';
import { runConsult } from './consult.js';
import { consultAutoEnabled, consultTrigger, consultAllowed } from './consult-logic.js';
import { raiseQueueItem, resolveQueueItem } from './queue.js';
import { getProjectRemote, pushProjectRemote } from './git-connectors.js';
import {
  RUNNER_TOOLS, MAX_TURNS, MAX_TOOL_RESULT_CHARS, truncateToolResult, parseFrameworkSkills,
  buildRunnerSystemPrompt, buildRunnerTask, classifyTurn, describeRunnerStep, STALL_NUDGE, formatAcceptanceBlock,
  softPauseReason, SOFT_PAUSE_TOKENS, SOFT_PAUSE_MS, buildRunnerMode,
  updateProgress, initProgressState, noProgressLimit, haltReasonLabel,
} from './runner-logic.js';
import { callModelTurn } from './model-client.js';
import { listPublishedComponents, getPublishedComponentWithVersion } from './components.js';
import { formatComponentForModel } from './component-logic.js';
import {
  budgetMode, budgetPauseReasonCents, budgetCentsForTokenLegacy, dollars, USAGE_SCHEMA_VERSION,
} from './usage-logic.js';
import { deployProject, readRunContract } from './deploy.js';
import { smokeAfterDeploy, smokeFailSummary } from './smoke.js';
import { notifyCycleComplete } from '../lib/notification-dispatch.js';

// Exported so the alternative Claude Agent SDK runner (runner-sdk.js, gated behind
// BUILD_RUNNER=sdk — docs/agent-sdk-migration.md) orients in the same container
// layout. Unchanged for the default hand-rolled path.
export const APP_DIR = '/srv/app';
export const GATES_DIR = '/srv/gates';
const nowIso = () => new Date().toISOString();

// Live cycle-job progress, keyed by cycle id (house 202+poll pattern). The poll
// endpoint reads this alongside the cycle row; entries drop a couple minutes
// after the job settles.
export const activeCycles = new Map();

export function getCycleJobStatus(cycleId) {
  return activeCycles.get(Number(cycleId)) || null;
}

// Exported (with the container/checkpoint tail below) so the SDK runner drives the
// same poll UI. The behavior is identical to the hand-rolled path's use of it.
export function setJob(cycleId, patch) {
  const cur = activeCycles.get(Number(cycleId)) || {};
  activeCycles.set(Number(cycleId), { ...cur, ...patch, updatedAt: Date.now() });
}
export function scheduleJobCleanup(cycleId) {
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
// resumeContext (optional): operator guidance carried into a RESUMED cycle —
// { message, selectedOption, authorizations:[{scope,conditions}] } — stored on the
// cycle and injected as a labeled user turn after the task. A fresh (non-resume)
// build passes null, which also expires any dangling one-time authorizations so a
// stale grant can never apply to an unrelated later build ("expires with the cycle").
export async function startCycle({ project, instruction, initiatedBy, actingAsAdmin = 0, resumeContext = null, requestId = null, segment = null }) {
  const projectId = Number(project.id);
  if (!resumeContext) { try { expireStaleAuthorizations(projectId); } catch { /* best effort */ } }
  // Cost-truth: attach this cycle to its umbrella request as a SEGMENT. When the caller
  // doesn't pass one (the audit→build handoff), derive the project's latest open request
  // (opened by startBuild). Additive + nullable — a null request_id is legacy/harmless.
  const reqId = requestId != null ? requestId : latestOpenRequestId(projectId);
  const seg = segment || (resumeContext ? 'resumed' : 'build');

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
      requestId: reqId, segment: seg,
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
    requestId: reqId, segment: seg,
  });
  // Persist the resume context (operator guidance) so runCycle injects it as a
  // labeled turn after the task.
  if (resumeContext) updateCycle(cycle.id, { resume_context_json: JSON.stringify(resumeContext) });
  const lock = acquireLock({ projectId, requester: { type: 'cycle', id: cycle.id }, role: 'admin' });
  if (!lock.ok) {
    finishCycle(cycle.id, { status: 'failed', error: `could not acquire checkout lock: ${lock.reason}` });
    return { status: 'error', cycle: getCycle(cycle.id), error: `Could not acquire the checkout lock: ${lock.reason}` };
  }

  const containerName = project.container_name || containerNameForProject(projectId);
  const gateScripts = parseGateScripts(framework.gates_json);

  setJob(cycle.id, { phase: 'starting', message: 'Copying pinned gates into the container…', startedAt: Date.now() });

  // Which runner drives this cycle. Default (unset) is the hand-rolled loop below —
  // BYTE-FOR-BYTE unchanged. BUILD_RUNNER=sdk selects the Claude Agent SDK runner
  // (Phase 1, docs/agent-sdk-migration.md), imported dynamically so a flag-off
  // install never needs @anthropic-ai/claude-agent-sdk present. Both share the same
  // args, the same terminal-error handling, and the same gate/checkpoint/deploy tail.
  const args = { cycle, project, containerName, framework, gateScripts, ready };
  const driveCycle = buildRunnerMode(process.env) === 'sdk'
    ? () => import('./runner-sdk.js').then((m) => m.runCycleSdk(args))
    : () => runCycle(args);

  // Fire-and-forget; the runner owns its own error handling and always lands the
  // cycle terminal + releases the lock.
  driveCycle().catch((err) => {
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
// Any non-successful terminal cycle can be continued — retryCycle starts a fresh
// cycle with the same instruction, which continues from the checkpoint/working
// tree already in the container (no work lost). Covers a hard failure, a stall
// handed to an admin, a soft budget pause, a user abandon/interrupt, and a quota
// refusal (a resume re-checks quota and refuses cleanly if still over).
const RESUMABLE_CYCLE_STATUSES = Object.freeze([
  'failed', 'awaiting_admin', 'interrupted', 'abandoned', 'refused_quota',
]);

// message (optional): free-text operator guidance injected on resume. option
// (optional): the id/label of a halt resolution option the operator chose. Any
// GRANTED, unused one-time authorizations for the project are gathered, injected,
// and consumed (single-use) on this resume. A bare resume (no message/option/grant)
// carries no new context, so a build blocked on a real blocker re-halts rather than
// loops.
export async function retryCycle({ project, cycle, initiatedBy, actingAsAdmin = 0, message = '', option = null }) {
  if (!cycle) return { status: 'error', error: 'No cycle to retry.' };
  if (!RESUMABLE_CYCLE_STATUSES.includes(cycle.status)) {
    return { status: 'error', error: `This cycle is "${cycle.status}" — there is nothing to retry.` };
  }
  // Clear the retries/quota/blocked handoff so it stops nagging in the admin queue.
  for (const key of [`mock2-retries:${cycle.id}`, `mock2-requeue:${cycle.id}`, `mock2-blocked:${cycle.id}`, `mock2-quota:${project.id}`]) {
    try { resolveQueueItem(key, { resolution: 'resumed by editor' }); } catch { /* best effort */ }
  }
  // Assemble the resume context: operator message, chosen halt option, and any
  // granted one-time authorizations (consumed here — single-use).
  let selectedOption = null;
  try {
    const opts = cycle.halt_options_json ? JSON.parse(cycle.halt_options_json) : [];
    selectedOption = resolveSelectedOption(opts, option);
  } catch { selectedOption = resolveSelectedOption([], option); }
  const granted = listGrantedUnusedAuthorizations(project.id);
  const authorizations = granted.map((a) => ({ scope: a.scope, conditions: a.conditions }));
  for (const a of granted) { try { markAuthorizationUsed(a.id); } catch { /* best effort */ } }
  const msg = String(message || '').trim();
  const resumeContext = (msg || selectedOption || authorizations.length)
    ? { message: msg, selectedOption, authorizations }
    : null;

  // Cost-truth: the resume is a SEGMENT of the SAME request as the cycle being resumed.
  return startCycle({ project, instruction: cycle.instruction, initiatedBy, actingAsAdmin, resumeContext, requestId: cycle.request_id ?? null, segment: 'resumed' });
}

// retryDeploy — re-run ONLY the deploy (install → migrate → build → start →
// health) for a cycle whose gates passed but whose DEPLOY failed (status
// 'failed', deploy_status 'deploy_failed'). Much cheaper than retryCycle: no
// model calls and no gate battery — it redeploys the existing checkpoint in the
// container. Use it for a transient deploy failure, or after the cause is fixed
// (e.g. the unit now sets NODE_OPTIONS so an unhandled rejection no longer
// crash-loops the app). Fire-and-forget like startCycle; returns { status, cycle }.
export async function retryDeploy({ project, cycle }) {
  if (!cycle) return { status: 'error', error: 'No cycle to redeploy.' };
  if (!(cycle.status === 'failed' && cycle.deploy_status === 'deploy_failed')) {
    return { status: 'error', error: 'This build has no failed deploy to retry.' };
  }
  const projectId = Number(project.id);
  if (project.lifecycle !== 'active') {
    return { status: 'error', error: 'Bring the project online to redeploy.' };
  }
  const lock = acquireLock({ projectId, requester: { type: 'cycle', id: cycle.id }, role: 'admin' });
  if (!lock.ok) return { status: 'error', error: `Could not acquire the checkout lock: ${lock.reason}` };
  const holder = { type: 'cycle', id: cycle.id };
  const containerName = project.container_name || containerNameForProject(projectId);

  // Reopen the finished cycle as running so the task list shows deploy progress.
  updateCycle(cycle.id, { status: 'running', error: null, deploy_status: 'deploying' });
  setJob(cycle.id, { phase: 'deploying', message: 'Retrying the deploy…', startedAt: Date.now() });

  // Fire-and-forget; always lands terminal + releases the lock.
  (async () => {
    try {
      const deployed = await deployStage({ cycle: getCycle(cycle.id), project, containerName, holder });
      if (!deployed.ok) {
        finishCycle(cycle.id, { status: 'failed', error: deployed.error });
        setJob(cycle.id, { phase: 'deploy_failed', message: deployed.error });
        void notifyCycleComplete({ project: { id: projectId, name: project.name }, cycle: getCycle(cycle.id), outcome: 'deploy_failed' });
      } else {
        finishCycle(cycle.id, { status: 'succeeded' });
        try { const rc = getCycle(cycle.id); if (rc?.request_id) closeRequest(rc.request_id, 'succeeded'); } catch { /* best effort */ }
        updateProject(projectId, { last_activity_at: nowIso() });
        setJob(cycle.id, {
          phase: deployed.skipped ? 'succeeded' : 'serving',
          message: deployed.skipped
            ? 'Nothing to deploy — the placeholder is still serving.'
            : 'Deployed — the app is live on its URL.',
        });
        void notifyCycleComplete({ project: { id: projectId, name: project.name }, cycle: getCycle(cycle.id), outcome: 'succeeded' });
      }
    } catch (err) {
      finishCycle(cycle.id, { status: 'failed', error: `deploy retry crashed: ${err?.message || err}` });
      setJob(cycle.id, { phase: 'deploy_failed', message: `deploy retry crashed: ${err?.message || err}` });
    } finally {
      releaseLock(projectId, holder);
      scheduleJobCleanup(cycle.id);
    }
  })();

  return { status: 'started', cycle: getCycle(cycle.id) };
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

  // The durable transcript for this cycle (downloadable later). logEvent is
  // best-effort — insertCycleEvent already swallows its own errors.
  const logEvent = (kind, { role = null, content = null, meta = null } = {}) =>
    insertCycleEvent({ projectId, cycleId: cycle.id, kind, role, content, meta });
  logEvent('task', { role: 'user', content: cycle.instruction || '', meta: { model: ready.model, framework_version: framework.version } });

  const skills = parseFrameworkSkills(framework.skills_json);
  // The PUBLISHED component-library catalog (migration 516): the runner is told
  // what reusable building blocks exist and fetches sources via get_component.
  // Best-effort — an empty/failed catalog just omits the prompt section.
  let componentCatalog = [];
  try { componentCatalog = listPublishedComponents(); } catch (err) { console.warn('[mock2] component catalog load failed:', err?.message); }
  const system = buildRunnerSystemPrompt({ constitution: framework.constitution_md, skills, appDir: APP_DIR, webPort: project.web_port || 3000, components: componentCatalog });
  const transcript = [{ role: 'user', text: buildRunnerTask(cycle.instruction) }];
  // On a RESUME, inject the operator guidance (message / chosen option / granted
  // one-time authorizations) as a distinct labeled user turn AFTER the task.
  let resumeCtx = null;
  try { const rc = getCycle(cycle.id)?.resume_context_json; resumeCtx = rc ? JSON.parse(rc) : null; } catch { resumeCtx = null; }
  if (resumeCtx) {
    const block = buildResumeContextBlock(resumeCtx);
    if (block) {
      transcript.push({ role: 'user', text: block });
      logEvent('resume_guidance', { role: 'user', content: block, meta: { message: resumeCtx.message || '', option: resumeCtx.selectedOption?.label || null, authorizations: (resumeCtx.authorizations || []).map((a) => a.scope) } });
    }
  }

  let lastGateReports = initialGateReports(gateScripts);
  // Soft-pause accounting for THIS run (a resume is a fresh cycle, so its own
  // clock + token count start at zero — each resume gets a fresh budget window).
  const runStartMs = Date.now();
  let usedTokensThisRun = 0;
  // Cost-truth: accumulate the four canonical token classes + the run's spend so the
  // soft-pause can trip on DOLLARS (behind the flag) and the cycle can store the honest
  // usage basis. usedCostThisRun tracks fractional cents like the ledger.
  let usedCostThisRun = 0;
  const runUsage = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
  // Soft-pause budget mode (default 'tokens' — behavior unchanged until an operator sets
  // MOCK2_BUDGET_DOLLARS on the live install). In 'dollars' mode the token ceiling is
  // replaced by its migrated dollar equivalent at THIS lane's model rate.
  const budgetDollars = budgetMode(process.env) === 'dollars';
  const dollarCeilingCents = budgetDollars ? budgetCentsForTokenLegacy(SOFT_PAUSE_TOKENS, ready.model) : null;
  // No-progress circuit breaker state (harness safety) — trips a stuck cycle to a
  // blocked halt instead of re-prompting forever (the ADP 118-turn loop).
  let progressState = initProgressState();
  const noProgLimit = noProgressLimit(process.env);
  // A model halt must propose 2–4 resolution options (task Part 4). A halt with no
  // viable options gets ONE retry to supply them; if it still can't, we halt anyway
  // (harness safety — a stuck cycle must terminate, it can't loop forever).
  let haltOptionsRetried = false;
  // Consecutive red gate batteries (cost-truth Part 5.2 trigger a) so a halt after "the
  // same gate failing twice" can auto-fire a consult (flag-gated).
  let gateFailStreak = 0;

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

    // 2b) Soft budget pause (token/dollar + wall-clock). A long build isn't a failure —
    //     when this run crosses a ceiling we checkpoint the WIP and PAUSE it, resumable
    //     in one click. Default is the TOKEN ceiling (unchanged). Behind the
    //     MOCK2_BUDGET_DOLLARS flag the token ceiling is replaced by its migrated DOLLAR
    //     equivalent so cache-heavy + output-heavy runs pause at equal spend; the
    //     wall-clock check is identical in both modes.
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
      await checkpointAndRecord({ cycle: fresh, project, containerName, holder, gateReports: lastGateReports, gateScripts, framework, summary: `checkpoint: paused — ${detail}` });
      updateCycle(cycle.id, { pause_reason: pauseReason });
      finishCycle(cycle.id, { status: 'interrupted', error: `Paused — ${detail}. Resume to continue where it stopped.` });
      releaseLock(projectId, holder);
      setJob(cycle.id, { phase: 'paused', message: `Paused — ${detail}. Resume to continue.`, commit: null });
      void notifyCycleComplete({ project: { id: projectId, name: project.name }, cycle: getCycle(cycle.id), outcome: 'paused' });
      return scheduleJobCleanup(cycle.id);
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

    // Ledger + usage after every model call (M5 writer). COST is cache-aware
    // (reads 0.1×, writes 1.25×), but the TOKEN COUNT and the soft-pause budget
    // are fresh input + output only: a cache read re-reads the whole cached prefix
    // every turn, so counting those toward a token budget would balloon the total
    // (~1M in a few turns) and trip the pause on re-reads instead of real work.
    const u = result.usage;
    const cacheRead = u.cacheReadInputTokens || 0;
    const cacheWrite = u.cacheCreationInputTokens || 0;
    const costCents = costCentsForUsage({ inputTokens: u.inputTokens, outputTokens: u.outputTokens, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite }, price);
    const turnTokens = u.inputTokens + u.outputTokens;
    usedTokensThisRun += turnTokens;
    usedCostThisRun += costCents;
    // Cost-truth: accumulate the four canonical classes for this run and persist them on
    // the cycle (additive — used_tokens/used_cost_cents via addCycleUsage stay as-is).
    runUsage.input += u.inputTokens || 0;
    runUsage.output += u.outputTokens || 0;
    runUsage.cache_read += cacheRead;
    runUsage.cache_write += cacheWrite;
    addCycleUsage(cycle.id, { tokens: turnTokens, costCents });
    try {
      updateCycle(cycle.id, {
        input_tokens: runUsage.input, output_tokens: runUsage.output,
        cache_read_tokens: runUsage.cache_read, cache_write_tokens: runUsage.cache_write,
        usage_schema_version: USAGE_SCHEMA_VERSION,
      });
    } catch (e) { console.warn('[mock2] canonical usage write failed:', e?.message); }
    try { insertLedgerEntry({ projectId, cycleId: cycle.id, connectorId: ready.connector.id, model: ready.model, inputTokens: u.inputTokens, outputTokens: u.outputTokens, costCents, wallClockMs: 0 }); } catch (e) { console.warn('[mock2] ledger write failed:', e?.message); }

    // Only record a NON-EMPTY assistant turn. An empty one (no text, no tool
    // calls) serializes to empty message content, which Anthropic/OpenAI reject —
    // re-sending it would 400 every subsequent call and derail the cycle. When
    // the model stalls with nothing, we skip its turn and nudge below instead.
    if (result.text || (result.toolCalls && result.toolCalls.length)) {
      transcript.push({ role: 'assistant', text: result.text || '', toolCalls: result.toolCalls || [] });
    }
    // Log the AI's turn: its reasoning/text and the tool calls it requested, with
    // this turn's token/cost so the transcript doubles as a per-step spend trail.
    logEvent('ai_message', {
      role: 'assistant',
      content: result.text || '',
      meta: {
        turn, tools: (result.toolCalls || []).map((t) => t.name),
        input_tokens: u.inputTokens, output_tokens: u.outputTokens,
        cache_read_tokens: cacheRead, cache_write_tokens: cacheWrite, cost_cents: costCents,
      },
    });
    for (const tc of result.toolCalls || []) {
      logEvent('tool_call', { role: 'assistant', content: tc.name, meta: { name: tc.name, input: tc.input || {} } });
    }
    const decision = classifyTurn(result.toolCalls, { stopReason: result.stopReason });

    // No-progress circuit breaker — fold this turn ONCE. Enforced below on every
    // non-successful path so a stuck cycle auto-halts (blocked) instead of
    // re-prompting forever. A turn that makes a real move resets the counters.
    const progress = updateProgress(progressState, { toolCalls: result.toolCalls, text: result.text }, noProgLimit);
    progressState = progress.state;

    // Surface task-level progress for the poll UI ("Step 3 · writing
    // public/index.html") so the Builder can see what the runner is doing rather
    // than a static "running". The terminal branches below set their own message.
    setJob(cycle.id, { phase: 'running', message: describeRunnerStep(turn, result.toolCalls) });

    // 4a-0) The turn is a SAFETY REFUSAL (Fable 5's classifier can emit
    //     stop_reason "refusal"; Opus 4.8 never does). Map it to the existing halt
    //     state — needs-attention, resumable — with the refusal as the reason. Never a
    //     crash, never a retry loop, and never the "propose options" nudge.
    if (decision.refusal) {
      await haltCycle({ cycle: getCycle(cycle.id), project, containerName, holder, gateReports: lastGateReports, gateScripts, framework, trigger: 'model_refusal', reason: decision.haltReason, options: [], logEvent });
      return scheduleJobCleanup(cycle.id);
    }

    // 4a) The model called halt — it cannot honestly finish (blocked, missing
    //     dependency, out-of-scope fix). End the cycle NON-SUCCESS: no deploy,
    //     resumable, surfaced as needs-attention with the model's reason. Answer any
    //     tool call it paired with halt so the transcript stays well-formed.
    if (decision.halted) {
      // A model halt must carry viable resolution options. If it doesn't and we
      // haven't already asked, feed the validation error back to the halt tool call
      // and let the model restate — ONE retry, then we halt regardless.
      const optCheck = validateHaltOptions(decision.haltOptions);
      if (!optCheck.ok && !haltOptionsRetried) {
        haltOptionsRetried = true;
        for (const call of decision.toolCalls) {
          if (call.name === 'halt') {
            transcript.push({
              role: 'tool', toolCallId: call.id || 'halt', name: 'halt',
              content: `Not halted: ${optCheck.error}. Re-call halt with 2–4 resolution options — each with a kind (grant_authorization | expand_scope | run_dependency_first | override_rule | abandon), a one-line risk, and exactly what to inject on resume; mark at most one recommended. If a one-time privileged operation is a viable path, include a grant_authorization option carrying the exact scope and expected row count.`,
            });
            continue;
          }
          const out = await executeTool({ call, cycle, containerName, holder, gateScripts });
          lastGateReports = out.gateReports || lastGateReports;
          transcript.push({ role: 'tool', toolCallId: call.id, name: call.name, content: truncateToolResult(out.content) });
          logEvent('tool_result', { role: 'tool', content: out.content, meta: { name: call.name } });
        }
        logEvent('note', { role: 'system', content: `Halt rejected — ${optCheck.error}; asked the build to restate with options.`, meta: { retry: true } });
        continue;
      }
      const haltOptions = optCheck.ok ? optCheck.options : decision.haltOptions;
      for (const call of decision.toolCalls) {
        if (call.name === 'halt') continue;
        const out = await executeTool({ call, cycle, containerName, holder, gateScripts });
        lastGateReports = out.gateReports || lastGateReports;
        transcript.push({ role: 'tool', toolCallId: call.id, name: call.name, content: truncateToolResult(out.content) });
        logEvent('tool_result', { role: 'tool', content: out.content, meta: { name: call.name } });
      }
      await haltCycle({ cycle: getCycle(cycle.id), project, containerName, holder, gateReports: lastGateReports, gateScripts, framework, trigger: 'model_halt', reason: decision.haltReason, options: haltOptions, logEvent, consultSignals: { gateFailStreak } });
      return scheduleJobCleanup(cycle.id);
    }

    // 4a-ii) The model requested a scoped one-time authorization — record it and end
    //     the cycle awaiting an admin (a blocking request, like a rule question). An
    //     invalid (empty) scope is fed back so the model can restate it, not halted.
    if (decision.authRequest) {
      const v = validateAuthScope(decision.authRequest.scope);
      const authCallId = (decision.toolCalls.find((c) => c.name === 'request_authorization') || {}).id || 'request_authorization';
      if (!v.ok) {
        transcript.push({ role: 'tool', toolCallId: authCallId, name: 'request_authorization', content: `Cannot request authorization: ${v.error}.` });
        continue;
      }
      const auth = insertAuthorization({ projectId, cycleId: cycle.id, scope: v.scope, reason: decision.authRequest.reason });
      logEvent('authorization_request', { role: 'system', content: v.scope, meta: { authorization_id: auth.id, reason: decision.authRequest.reason || '' } });
      await haltCycle({
        cycle: getCycle(cycle.id), project, containerName, holder, gateReports: lastGateReports, gateScripts, framework,
        trigger: 'authorization_request',
        reason: `The build requested a one-time authorization: ${v.scope}${decision.authRequest.reason ? ` — ${decision.authRequest.reason}` : ''}`,
        options: [], logEvent,
      });
      return scheduleJobCleanup(cycle.id);
    }

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
        logEvent('tool_result', { role: 'tool', content: out.content, meta: { name: call.name } });
      }
      // Acceptance criteria are REQUIRED on finish (constitution §11): a
      // human-runnable check per user-visible change + the verified-vs-assumed
      // assumption split. A finish without them is rejected back to the model;
      // the no-progress breaker terminates a cycle that keeps refusing.
      if (!decision.finishAcceptance?.length || !decision.finishAssumptions) {
        transcript.push({
          role: 'tool', toolCallId: finishCallId(result.toolCalls), name: 'finish',
          content: 'Not finished: finish requires `acceptance` (≥1 human-runnable check — "as <role>, do X, expect Y" — one per user-visible change, or one entry describing the non-UI verification performed) and `assumptions` ({verified:[…], assumed:[…]} — the cross-layer values you READ the source for this cycle, naming the file, vs the ones you assumed). Re-call finish with both.',
        });
        logEvent('note', { role: 'system', content: 'Finish rejected — missing acceptance checks / assumptions; asked the build to restate.' });
        touchLock(projectId, holder);
        if (progress.tripped) {
          await haltCycle({ cycle: getCycle(cycle.id), project, containerName, holder, gateReports: lastGateReports, gateScripts, framework, trigger: progress.trigger, reason: `Auto-stopped after ${noProgLimit} turns with no progress (${haltReasonLabel(progress.trigger)}); finish kept omitting acceptance criteria.`, logEvent });
          return scheduleJobCleanup(cycle.id);
        }
        continue;
      }
      logEvent('note', { role: 'system', content: `Model requested finish: ${decision.finishSummary || ''}` });
      const battery = await runGateBattery(cycle.id, containerName, gateScripts);
      lastGateReports = battery;
      logEvent('gate', { role: 'system', content: formatGateReports(battery), meta: { gates: battery, green: !gateScripts.length || allGatesGreen(battery) } });
      // A framework with zero gates (placeholder content, risk R8 — parseGateScripts
      // returns []) is vacuously green: there is nothing to fail, so finish is
      // accepted. Only reject finish when there ARE gates and one isn't green.
      if (gateScripts.length && !allGatesGreen(battery)) {
        // Not green — feed the finish call its verdict and keep working ("review,
        // not error"). The next model turn answers with fresh work — UNLESS the
        // breaker shows the cycle is just re-calling finish on the same red gates
        // with no new work, in which case halt (blocked) rather than loop.
        transcript.push({ role: 'tool', toolCallId: finishCallId(result.toolCalls), name: 'finish', content: `Gates are not all green yet — you cannot finish. Battery:\n${formatGateReports(battery)}` });
        touchLock(projectId, holder);
        if (progress.tripped) {
          await haltCycle({ cycle: getCycle(cycle.id), project, containerName, holder, gateReports: battery, gateScripts, framework, trigger: progress.trigger, reason: `Auto-stopped after ${noProgLimit} turns with no progress (${haltReasonLabel(progress.trigger)}); gates still red.`, logEvent });
          return scheduleJobCleanup(cycle.id);
        }
        continue;
      }
      // The change record carries the acceptance evidence (constitution §11):
      // summary + the acceptance/assumptions block, so a Reviewer can replay
      // the human-runnable checks straight from the record.
      const recordSummary = `${decision.finishSummary}\n\n${formatAcceptanceBlock(decision.finishAcceptance, decision.finishAssumptions)}`;
      logEvent('acceptance', {
        role: 'assistant',
        content: formatAcceptanceBlock(decision.finishAcceptance, decision.finishAssumptions),
        meta: { acceptance: decision.finishAcceptance, assumptions: decision.finishAssumptions },
      });
      const record = await checkpointAndRecord({ cycle: getCycle(cycle.id), project, containerName, holder, gateReports: battery, gateScripts, framework, summary: recordSummary });
      logEvent('checkpoint', { role: 'system', content: decision.finishSummary || '', meta: { commit_sha: record?.commit_sha || null, seq: record?.seq ?? null } });

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
        logEvent('deploy', { role: 'system', content: deployed.error || 'deploy failed', meta: { ok: false } });
        finishCycle(cycle.id, { status: 'failed', error: deployed.error });
        releaseLock(projectId, holder);
        setJob(cycle.id, { phase: 'deploy_failed', message: deployed.error, commit: record?.commit_sha || null });
        void notifyCycleComplete({ project: { id: projectId, name: project.name }, cycle: getCycle(cycle.id), outcome: 'deploy_failed' });
        return scheduleJobCleanup(cycle.id);
      }
      logEvent('deploy', { role: 'system', content: deployed.skipped ? 'No run contract — placeholder still serving (nothing to deploy).' : 'Deployed — app serving on its live URL.', meta: { ok: true, skipped: !!deployed.skipped } });

      // e2e/journey SMOKE GATE — runs against the now-deployed app. The cheap
      // HTTP/API layer always runs; the browser + read-only DB connectors are a
      // relevance-gated escalation (default OFF) that start ONLY when this change's
      // diff/metadata warrants them. A backend-only change invokes zero connectors.
      // Every run/skip + reason is logged. With the connectors off and http not
      // enforced (defaults), ok is always true → the success path is unchanged.
      if (!deployed.skipped) {
        const smoke = await smokeAfterDeploy({ containerName, appDir: APP_DIR, webPort: project.web_port || 3000, commitSha: record?.commit_sha, summary: decision.finishSummary, instruction: cycle.instruction, logEvent, env: process.env });
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
        message: deployed.skipped
          ? 'Change complete — gates green, checkpoint recorded.'
          : 'Deployed — gates green and the app is live on its URL.',
        commit: record?.commit_sha || null,
      });
      void notifyCycleComplete({ project: { id: projectId, name: project.name }, cycle: getCycle(cycle.id), outcome: 'succeeded' });
      return scheduleJobCleanup(cycle.id);
    }

    // 4c) No-progress breaker on the non-terminal path — if the cycle is stuck
    //     (repeated no-tool / near-identical / no-state-change turns), halt it as
    //     blocked instead of nudging into another wasted turn. This is the guard
    //     the ADP repro needed: honesty gets an exit AND runaway can't spin.
    if (progress.tripped) {
      await haltCycle({ cycle: getCycle(cycle.id), project, containerName, holder, gateReports: lastGateReports, gateScripts, framework, trigger: progress.trigger, reason: `Auto-stopped after ${noProgLimit} turns with no progress: ${haltReasonLabel(progress.trigger)}.`, logEvent });
      return scheduleJobCleanup(cycle.id);
    }

    // 5) The model stalled (no tool call) — nudge and continue (until the breaker
    //    above trips). The nudge gives a genuinely-recoverable turn a chance first.
    if (decision.stalled) {
      transcript.push({ role: 'user', text: STALL_NUDGE });
      continue;
    }

    // 6) Execute the requested tools; feed results back.
    let ranGates = false;
    for (const call of decision.toolCalls) {
      const out = await executeTool({ call, cycle, containerName, holder, gateScripts });
      lastGateReports = out.gateReports || lastGateReports;
      if (call.name === 'run_gates') ranGates = true;
      transcript.push({ role: 'tool', toolCallId: call.id, name: call.name, content: truncateToolResult(out.content) });
      logEvent('tool_result', { role: 'tool', content: out.content, meta: { name: call.name } });
    }
    // Cost-truth Part 5.2 trigger (a): count CONSECUTIVE red gate batteries so a halt
    // after "the same gate failing twice" can auto-fire a consult (flag-gated).
    if (ranGates) gateFailStreak = gateBatteryVerdict(lastGateReports) === 'red' ? gateFailStreak + 1 : 0;
    touchLock(projectId, holder); // any exec/write refreshed the idle timer
  }

  // Runaway backstop hit (the soft token/time pause normally trips first). This
  // is a genuine dead-loop — checkpoint WIP and PAUSE it (resumable) rather than
  // fail, so an editor can inspect and continue instead of losing the work.
  await checkpointAndRecord({ cycle: getCycle(cycle.id), project, containerName, holder, gateReports: lastGateReports, gateScripts, framework, summary: 'checkpoint: max turns reached' });
  updateCycle(cycle.id, { pause_reason: 'max_turns' });
  finishCycle(cycle.id, { status: 'interrupted', error: `Paused — reached ${MAX_TURNS} steps without finishing. Resume to continue where it stopped.` });
  releaseLock(projectId, holder);
  setJob(cycle.id, { phase: 'paused', message: `Paused at the ${MAX_TURNS}-step ceiling. Resume to continue.` });
  void notifyCycleComplete({ project: { id: projectId, name: project.name }, cycle: getCycle(cycle.id), outcome: 'paused' });
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
    case 'get_component': {
      // Library lookup is DB-only (no container access) and limited to the
      // PUBLISHED catalog — the same set the system prompt advertised.
      const key = String(call.input?.key || '').trim();
      const found = getPublishedComponentWithVersion(key);
      if (!found) return { content: `error: no published component with key "${key.slice(0, 80)}" — the available keys are listed in your system prompt` };
      return { content: formatComponentForModel(found.component, found.version) };
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
// Exported so the SDK runner (runner-sdk.js) syncs its local checkout in/out of the
// fenced container through the same host round-trip — unchanged for the default path.
export function containerSh(containerName, script, { timeoutMs = 120000 } = {}) {
  return sh(`printf '%s' '${b64(script)}' | base64 -d | incus exec ${containerName} -- sh`, { timeoutMs });
}

export async function execInContainer(containerName, command) {
  const script = `cd '${APP_DIR}' 2>/dev/null || cd /\n${command}\n`;
  const r = await containerSh(containerName, script, { timeoutMs: 180000 });
  return { code: r.code, stdout: (r.stdout || '').slice(0, MAX_TOOL_RESULT_CHARS), stderr: (r.stderr || '').slice(0, 2000) };
}

// Exported for the component-submission route ("promote what the last build
// wrote" reads the proposed files straight out of the running container).
export async function readFileInContainer(containerName, path) {
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
// Exported so the SDK runner copies the SAME pinned battery in at cycle start.
export async function copyGatesIntoContainer(containerName, gateScripts) {
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
// Exported so the SDK runner runs the IDENTICAL pinned battery (same invocation).
export async function runGateBattery(cycleId, containerName, gateScripts) {
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

export function formatGateReports(reports) {
  return reports.map((g) => `- ${g.name}: ${g.status}${g.report ? `\n    ${g.report.split('\n').slice(-3).join('\n    ')}` : ''}`).join('\n');
}

// ---- checkpoint → change record → mirror → push ----

// Checkpoint the working tree into the bare repo (ADR-006 mount), insert the
// hash-chained change record, mirror it into the repo, and push to a
// push_on_checkpoint remote if configured. Returns the inserted record (or null).
// Exported so the SDK runner produces the SAME commit + hash-chained change record.
export async function checkpointAndRecord({ cycle, project, containerName, holder, gateReports, gateScripts, framework, summary }) {
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
// Exported so the SDK runner deploys through the IDENTICAL Run phase.
export async function deployStage({ cycle, project, containerName, holder }) {
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

// haltCycle — the NON-SUCCESS terminal (harness safety). A cycle that cannot
// honestly finish — the model called halt(reason), OR the no-progress breaker
// tripped — ends here: WIP is checkpointed (branch + any report artifacts stay
// recoverable), the cycle is marked BLOCKED (status 'awaiting_admin' + halt_reason,
// so it is NOT 'succeeded' and does NOT deploy), the lock is released, a
// needs-attention queue item is raised, and the human is notified. Resumable via
// the existing editor Retry (RESUMABLE_CYCLE_STATUSES includes 'awaiting_admin').
// Exported so the SDK runner ends a blocked/stuck cycle identically.
export async function haltCycle({ cycle, project, containerName, holder, gateReports, gateScripts, framework, trigger, reason, options = [], logEvent = null, consultSignals = null }) {
  const projectId = Number(project.id);
  setJob(cycle.id, { phase: 'blocked', message: 'Blocked — checkpointing before stopping…' });

  // Best-effort WIP checkpoint + change record so the branch and any report the
  // cycle wrote are recoverable when a human resumes.
  let record = null;
  try {
    record = await checkpointAndRecord({ cycle, project, containerName, holder, gateReports: gateReports || [], gateScripts, framework, summary: `halt: ${haltReasonLabel(trigger)}` });
  } catch (e) { console.warn('[mock2] halt checkpoint failed:', e?.message); }

  // Link any report artifacts the cycle wrote (state/changes/*.md, state/*.md).
  const artifacts = await listReportArtifacts(containerName);

  updateCycle(cycle.id, { halt_reason: trigger, halt_options_json: JSON.stringify(Array.isArray(options) ? options : []) });
  finishCycle(cycle.id, { status: 'awaiting_admin', error: reason });
  releaseLock(projectId, holder);

  if (typeof logEvent === 'function') {
    // Record the resolution options OFFERED (task Part 3 audit trail: options offered).
    const offered = (Array.isArray(options) ? options : []).map((o) => ({ id: o.id, label: o.label, kind: o.kind, recommended: !!o.recommended }));
    try { logEvent('halt', { role: 'system', content: reason, meta: { trigger, artifacts, commit_sha: record?.commit_sha || null, options: offered } }); } catch { /* best effort */ }
  }

  safeRaise({
    kind: 'retries_exhausted', project_id: projectId, dedupe_key: `mock2-blocked:${cycle.id}`,
    ref_table: 'mock2_cycles', ref_id: cycle.id,
    detail: `${project.name}: build BLOCKED (${trigger}) — ${reason}${artifacts.length ? ` · reports: ${artifacts.join(', ')}` : ''}`,
  });
  setJob(cycle.id, { phase: 'blocked', message: `Blocked — ${haltReasonLabel(trigger)}. Needs attention.`, commit: record?.commit_sha || null });
  void notifyCycleComplete({ project: { id: projectId, name: project.name }, cycle: getCycle(cycle.id), outcome: 'blocked' });

  // Cost-truth Part 5.2: auto-fire ONE bounded Fable 5 second opinion when the build is
  // demonstrably stuck — flag-gated (MOCK2_CONSULT, default OFF), so the runner is
  // byte-identical until an operator opts in. Advisory-only + capped; failures are
  // swallowed (never blocks the halt).
  void maybeAutoConsult({ project, cycle: getCycle(cycle.id), haltTrigger: trigger, reason, gateReports, signals: consultSignals || {}, logEvent });
}

// maybeAutoConsult — the flag-gated auto escalation consult (triggers a/b). Maps the
// halt trigger + signals to a consult trigger, respects the caps, compiles a tool-free
// digest, and stores the advisory result as a request segment. Never throws.
async function maybeAutoConsult({ project, cycle, haltTrigger, reason, gateReports, signals = {}, logEvent = null }) {
  try {
    if (!consultAutoEnabled(process.env)) return;
    const breakerTripped = ['no_tool_calls', 'repeated_output', 'no_state_change'].includes(haltTrigger);
    const trig = consultTrigger({
      gateFailStreak: signals.gateFailStreak || 0,
      breakerTripped,
      reHaltSameReason: !!signals.reHaltSameReason,
      operatorRequested: false,
    });
    if (!trig) return;
    const gate = consultAllowed({
      trigger: trig,
      perHaltCount: countConsultsForCycle(cycle.id),
      perRequestCount: countConsultsForRequest(cycle.request_id),
    });
    if (!gate.allowed) return;
    const gateOutput = (Array.isArray(gateReports) ? gateReports : []).map((g) => `${g.name}: ${g.status}`).join('\n');
    const r = await runConsult({
      projectId: Number(project.id), requestId: cycle.request_id, cycleId: cycle.id, trigger: trig,
      digestParts: { task: cycle.instruction || '', haltReason: reason, gateOutput },
    });
    if (r.ok && typeof logEvent === 'function') {
      try { logEvent('consult', { role: 'system', content: r.consult.diagnosis || 'second opinion', meta: { trigger: trig, consult_id: r.consult.id, cost_cents: r.consult.cost_cents } }); } catch { /* best effort */ }
    }
  } catch (e) { console.warn('[mock2] auto-consult failed:', e?.message); }
}

// Report artifacts a cycle wrote, so a halt can link them for the reviewer.
// Best-effort; runs in the container relative to APP_DIR (execInContainer cds there).
async function listReportArtifacts(containerName) {
  try {
    const r = await execInContainer(containerName, `ls -1 state/changes/*.md state/changes/*.json state/*.md 2>/dev/null | head -50`);
    return Array.from(new Set((r.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean)));
  } catch { return []; }
}

// ---- admin stop-all (used by the route) ----

// Interrupt every running cycle (admin escape hatch). Sets stop_after_step so the
// runners checkpoint and stop at their next boundary. Returns the count touched.
export function stopAllCycles(reason = 'admin stop-all') {
  const running = getMock2Db().prepare(`SELECT id FROM mock2_cycles WHERE status = 'running'`).all();
  for (const r of running) updateCycle(r.id, { interrupt_request: 'stop_after_step' });
  return { stopped: running.length, reason };
}
