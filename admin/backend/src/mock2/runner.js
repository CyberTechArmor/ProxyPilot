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
import { buildDbSnapshotScript } from './restore-logic.js';
import { getSlot, getConnector, decryptConnectorKey, effectivePrice } from './connectors.js';
import { resolveProjectKey } from './project-keys.js';
import { parseCapabilities, slotAssignmentError, isCloudProvider } from './connector-logic.js';
import { getApplicableQuota, periodUsage, insertLedgerEntry } from './quotas.js';
import { canStartCycle, costCentsForUsage } from './quota-logic.js';
import { getCurrentFrameworkVersion } from './framework.js';
import {
  insertCycle, getCycle, updateCycle, addCycleUsage, finishCycle, countRunningCycles,
  listCyclesForProject, projectHasBeenDeployed } from './cycles.js';
import {
  parseGateScripts, buildGateBattery, gatesForProfile, initialGateReports, gateBatteryVerdict, allGatesGreen,
  gateStatusFromOutput,
  interruptDecision, estimateCycleTokens, shouldStopForBudget, retriesExhausted, MAX_CYCLE_RETRIES,
  noopStartRefusal,
  normalizeBuildMode, isFastBuildMode, BUILD_MODE_FULL, BUILD_MODE_MVP, BUILD_MODE_QUICK,
} from './cycle-logic.js';
import { getLock, acquireLock, releaseLock, touchLock } from './locks.js';
import { insertChangeRecord, changeRecordMirror } from './change-records.js';
import { insertMessage } from './chats.js';
import { webSearchServerTools, RUNNER_WEB_SEARCH_FLAG } from './ask-logic.js';
import { getRoutingRule } from './routing.js';
import { applyLaneTuning } from './lane-tuning-logic.js';
import { decideRouting, escalationAttempts, routingMode, parseRoutingJson, mvpRoutingDecision, quickRoutingDecision } from './routing-logic.js';
import {
  prepassEnabled, prepassModel, buildPrepassPrompt, parsePrepassReply,
  prepassEffort, formatBriefForTask, featureScaleNotice,
  normalizeSuggestMode,
  buildDistillSystemPrompt, buildDistillUserTurn, cleanDistilledInstruction,
} from './prepass-logic.js';
import { insertCycleEvent, listRecentDownNotes } from './cycle-events.js';
import { listAssets } from './project-assets.js';
import { buildAssetSection, diffAssetFingerprint, buildAssetChangeSection } from './project-assets-logic.js';
import { buildDesignFindingsBrief, markDesignFindingsBriefed } from './design-findings.js';
import {
  insertAuthorization, listGrantedUnusedAuthorizations, markAuthorizationUsed, expireStaleAuthorizations,
} from './authorizations.js';
import { buildResumeContextBlock, resolveSelectedOption, validateAuthScope, validateHaltOptions } from './unblock-logic.js';
import { latestOpenRequestId, closeRequest, getRequest } from './requests.js';
import { hydrateAttachments } from './chat-images.js';
import { parseAttachmentsJson } from './chat-image-logic.js';
import { countConsultsForCycle, countConsultsForRequest } from './consults.js';
import { runConsult } from './consult.js';
import { consultAutoEnabled, consultTrigger, consultAllowed } from './consult-logic.js';
import { raiseQueueItem, resolveQueueItem } from './queue.js';
import { getProjectRemote, pushProjectRemote } from './git-connectors.js';
import {
  RUNNER_TOOLS, runnerToolsForCycle, MAX_TURNS, MAX_TOOL_RESULT_CHARS, truncateToolResult, parseFrameworkSkills,
  groupToolCallsForExecution,
  buildRunnerSystemPrompt, buildRunnerTask, buildFeedbackSection, classifyTurn, describeRunnerStep, STALL_NUDGE, formatAcceptanceBlock,
  buildCompletionSummaryBody,
  softPauseReason, SOFT_PAUSE_TOKENS, SOFT_PAUSE_MS,
  updateProgress, initProgressState, noProgressLimit, haltReasonLabel,
} from './runner-logic.js';
import { harnessForProject } from './harness.js';
import { applyEdits } from './apply-edit-logic.js';
import { commandAllowed, redactSecrets } from './harness-safety.js';
import { formatReadRange, formatSearchResults } from './harness-copilot.js';
import { callStepTurn, stepSystemPrompt } from './harness-steps.js';
import { listPublishedComponents, getPublishedComponentWithVersion, listProjectComponents } from './components.js';
import {
  formatComponentForModel, parseFilesJson, safeComponentPath, buildComponentManifest,
  buildPathsExistScript, parsePathsExistOutput, buildManifestVerifyScript, parseShaVerifyOutput,
  formatMaterializeResult, parseContractJson,
} from './component-logic.js';
import { logAudit } from '../db.js';
import {
  budgetMode, budgetPauseReasonCents, budgetCentsForTokenLegacy, dollars, USAGE_SCHEMA_VERSION,
} from './usage-logic.js';
import { deployProject, readRunContract, readDeclaredEgress, stampDeployedCommit } from './deploy.js';
import { syncDeclaredEgress, probeEgressGrants } from './egress-grants.js';
import { reconcileMock2Firewall } from './firewall.js';
import { smokeAfterDeploy, smokeFailSummary, changedFilesForCommit } from './smoke.js';
import { needsOperatorUiVerification, smokeConfigFromEnv } from './smoke-triggers.js';
import {
  ACCEPTANCE_PATH, classifyTaskKind, parseAcceptance, batteryHasRedTestGate,
  acceptanceVerdict, summaryOverclaims, anomalySignals, acceptanceRecord, codeChangedFiles,
  mutationActions, actionParityReport, actionLabelWords,
} from './acceptance-logic.js';
import {
  evaluateIntegrationTruthfulness, readSourceSnapshot, haltReasonForDecision, blockingSummary,
} from './integration-enforcement.js';
import { listApprovedEgressGrants } from './egress-grants.js';
import { stubContextForCycle } from './stub-logic.js';
import { listOpenStubs, recordIntegrationGate, recordIntegrationFindings, openVerificationChecklist, recordIntegrationResolution, STUB_REGISTRY_PATH, priorBlockedSignatures, projectChecklistItems, listActiveVerifications } from './integration-state.js';
import { acceptPendingEligibility, buildAcceptPendingChecklist, normalizeAttestation, applyIntegrationGateMode, applyLiveCheckMode } from './accept-pending-logic.js';
import { getIntegrationGateMode, getLaneTuning, routingEnv } from './settings.js';
import { capabilityCheckStatus } from './verification-logic.js';
// B.3: the in-fence contract-fixture server module a project must provide so the
// honest path (real transport verified against a local TLS socket) is walkable.
import { CONTRACT_FIXTURE_PATH_RE } from './scaffold.js';
import { scanProjectForLegacyStubs, blockingLegacyFindings } from './migration-scan.js';
import { touchedSubsystems as touchedSubsystemsOf } from './stub-logic.js';
import { notifyCycleComplete } from '../lib/notification-dispatch.js';
import { crudRulesFloorSection } from './rules-pack-logic.js';

// Exported so the alternative Claude Agent SDK runner (runner-sdk.js, gated behind
// BUILD_RUNNER=sdk — docs/agent-sdk-migration.md) orients in the same container
// layout. Unchanged for the default hand-rolled path.
export const APP_DIR = '/srv/app';
export const GATES_DIR = '/srv/gates';
const nowIso = () => new Date().toISOString();

// Per-turn output ceiling for build-runner model calls. 8k proved to be the
// dominant wall-clock sink on large builds: a big file hit the cap turn after
// turn (15 consecutive truncated 8k turns on one SPA file ≈ 20 minutes), each
// truncation costing a full re-prompt round-trip. Default 64k — the maximum
// every current Claude model supports (Opus 4.8 / Sonnet 5 go to 128k; Haiku
// 4.5 caps at 64k, and a max_tokens above the model's limit 400s, so 64k is
// the highest universally-safe default). model-client streams automatically
// above its 12k threshold and scales the HTTP timeout with the budget.
// Per-turn output budgets are gone (operator decision): with no env override
// the turn runs to the serving model's own ceiling (modelMaxOutputTokens via
// callStepTurn). MOCK2_RUNNER_MAX_TOKENS remains an explicit operator cap;
// floored at 1024 so a typo can't brick the runner.
const RUNNER_MAX_TOKENS = (() => {
  const n = Number(process.env.MOCK2_RUNNER_MAX_TOKENS);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.max(1024, Math.round(n));
})();

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
// projectId/userId (optional) layer the per-project and per-user API keys over
// the global connector: the connector still chooses the provider/model, but a
// project key — or the acting user's own private key — supplies the CREDENTIAL
// (see project-keys-logic for the precedence). Omitting them keeps the previous
// behavior exactly, so every existing caller is unchanged.
export function buildRunnerReady({ projectId = null, userId = null } = {}) {
  const slot = getSlot('build_runner');
  if (!slot) return { ok: false, reason: 'No build_runner model slot is assigned. Assign one under Model connectors.' };
  const connector = getConnector(slot.connector_id);
  if (!connector) return { ok: false, reason: 'The build_runner slot points at a missing connector.' };
  if (!connector.enabled) return { ok: false, reason: 'The build_runner connector is disabled.' };
  const capErr = slotAssignmentError(parseCapabilities(connector.capabilities), 'build_runner');
  if (capErr) return { ok: false, reason: capErr };
  const globalKey = decryptConnectorKey(connector);
  const resolved = resolveProjectKey({ projectId, provider: connector.provider, userId, globalKey });
  const apiKey = resolved.apiKey;
  if (isCloudProvider(connector.provider) && !apiKey) {
    return { ok: false, reason: 'The build_runner connector has no decryptable API key.' };
  }
  // A project/user key may carry its own base URL (a gateway or proxy for that
  // account); otherwise the connector's stands.
  const effectiveConnector = resolved.baseUrl && resolved.source !== 'global'
    ? { ...connector, base_url: resolved.baseUrl }
    : connector;
  return {
    ok: true, connector: effectiveConnector, model: slot.model, apiKey,
    keySource: resolved.source, keySourceLabel: resolved.label, keyId: resolved.keyId,
  };
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

// Quick-lane pre-pass host half (pure decisions in prepass-logic.js): one
// bounded call on the cheap classifier model against the build connector's own
// key. Returns { scope, effort } (effort bumped when the request is bigger
// than the lane assumes); stamps the scope + working brief into routing_json
// (both harnesses append the brief to the task turn); posts the Build-MVP
// suggestion for feature-scale asks. Spend lands in the ledger like every
// other model call. Any failure returns null — callers treat that as "no
// pre-pass" and run unchanged.
async function runQuickPrepass({ project, cycle, ready, routing }) {
  const model = prepassModel(routingEnv());
  const res = await callStepTurn('quick-prepass', {
    connector: ready.connector, apiKey: ready.apiKey, model,
    system: stepSystemPrompt('quick-prepass', buildPrepassPrompt(), {}), tools: [], transcript: [{ role: 'user', text: String(cycle.instruction || '') }],
    timeoutMs: 120000, effort: 'high', thinking: 'off',
  });
  if (!res.ok) return null;
  try {
    const u = res.usage || {};
    const cost = costCentsForUsage({
      inputTokens: u.inputTokens || 0, outputTokens: u.outputTokens || 0,
      cacheReadTokens: u.cacheReadInputTokens || 0, cacheWriteTokens: u.cacheCreationInputTokens || 0,
    }, effectivePrice(ready.connector.id, model));
    insertLedgerEntry({ projectId: project.id, cycleId: cycle.id, connectorId: ready.connector.id, model: res.modelUsed || model, inputTokens: u.inputTokens || 0, outputTokens: u.outputTokens || 0, costCents: cost, wallClockMs: 0, step: 'quick-prepass' });
  } catch (e) { console.warn('[mock2] pre-pass ledger write failed:', e?.message); }
  const parsed = parsePrepassReply(res.text);
  if (!parsed) return null;
  // Suggestions 'off': the operator asked for exactly what they typed — drop
  // the domain expectations so they never reach the working brief. ('ask' picks
  // ride the instruction as confirmed extras; 'auto' keeps them here.)
  if (parsed.brief && normalizeSuggestMode(project.suggest_mode) === 'off') {
    parsed.brief.domain_expectations = [];
  }
  try {
    updateCycle(cycle.id, { routing_json: JSON.stringify({ ...(routing || {}), prepass: parsed }) });
  } catch (e) { console.warn('[mock2] pre-pass routing stamp failed:', e?.message); }
  try {
    insertCycleEvent({
      projectId: project.id, cycleId: cycle.id, kind: 'note', role: 'system',
      content: `pre-pass: scope=${parsed.scope}${parsed.brief ? ' (working brief attached to the task)' : ''}`,
      meta: { prepass: parsed },
    });
  } catch { /* best effort */ }
  if (parsed.scope === 'feature_scale') {
    try { insertMessage({ projectId: project.id, kind: 'system', cycleId: cycle.id, body: featureScaleNotice() }); } catch { /* best effort */ }
  }
  return { scope: parsed.scope, effort: prepassEffort(parsed.scope, ready.effort || 'high') };
}

// probeSplitProposal — the ROUTE-TIME half of the pre-pass: before a quick
// update starts, one cheap call sizes the request; a feature-scale ask that
// naturally decomposes comes back with a split proposal the UI renders as a
// grouping card (build all as one / in ordered groups). Bounded and fail-open:
// null (no proposal) on any error, timeout, or a non-splittable request.
export async function probeSplitProposal(instruction, { timeoutMs = 9000 } = {}) {
  if (!prepassEnabled(routingEnv())) return null;
  const ready = buildRunnerReady();
  if (!ready.ok) return null;
  const call = callStepTurn('split-probe', {
    connector: ready.connector, apiKey: ready.apiKey, model: prepassModel(routingEnv()),
    system: stepSystemPrompt('split-probe', buildPrepassPrompt(), {}), tools: [], transcript: [{ role: 'user', text: String(instruction || '') }],
    timeoutMs: 120000, effort: 'high', thinking: 'off',
  });
  const res = await Promise.race([
    call,
    new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs)),
  ]);
  if (!res || !res.ok) return null;
  const parsed = parsePrepassReply(res.text);
  if (!parsed) return null;
  return parsed; // { scope, brief, split|null }
}

// distillChatPrompt — the "Build this as a Quick update" button's model call:
// one cheap turn converting a chat message (an Ask answer's improvement list, a
// review's findings) into a well-formed quick-update instruction. Bounded and
// fail-open like probeSplitProposal: null on error/timeout/unusable output.
export async function distillChatPrompt({ body, precedingUser = '', timeoutMs = 60000 } = {}) {
  const ready = buildRunnerReady();
  if (!ready.ok) return null;
  const call = callStepTurn('chat-distill', {
    connector: ready.connector, apiKey: ready.apiKey, model: 'claude-opus-5',
    system: stepSystemPrompt('chat-distill', buildDistillSystemPrompt(), {}), tools: [],
    transcript: [{ role: 'user', text: buildDistillUserTurn({ body, precedingUser }) }],
    timeoutMs: 120000, effort: 'high', thinking: 'off',
  });
  const res = await Promise.race([
    call,
    new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs)),
  ]);
  if (!res || !res.ok) return null;
  return cleanDistilledInstruction(res.text);
}

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
export async function startCycle({ project, instruction, initiatedBy, actingAsAdmin = 0, resumeContext = null, requestId = null, segment = null, task = null, buildMode = null }) {
  const projectId = Number(project.id);
  if (!resumeContext) { try { expireStaleAuthorizations(projectId); } catch { /* best effort */ } }
  // Refresh the base app BEFORE the build reads the tree, so the cycle works
  // against the current platform module rather than whatever shipped the day
  // the project was provisioned. Platform-owned files only, never app code —
  // and silent when there is nothing to do. A resume skips it: the tree must
  // not change underneath a cycle that is continuing.
  if (!resumeContext) {
    try {
      const { maybeUpgradeBaseApp } = await import('./base-app-upgrade.js');
      await maybeUpgradeBaseApp(projectId, { reason: 'pre-build' });
    } catch (e) { console.warn('[mock2] pre-build base-app upgrade skipped:', e?.message); }
  }
  // Cost-truth: attach this cycle to its umbrella request as a SEGMENT. When the caller
  // doesn't pass one (the audit→build handoff), derive the project's latest open request
  // (opened by startBuild). Additive + nullable — a null request_id is legacy/harmless.
  const reqId = requestId != null ? requestId : latestOpenRequestId(projectId);
  const seg = segment || (resumeContext ? 'resumed' : 'build');

  // Build mode (full / mvp / quick): explicit from the caller, else remembered
  // on the umbrella request — so a RESUME of a fast build stays in its mode
  // (same reduced gate battery, same routing) instead of silently tightening.
  let modeStr = buildMode != null ? normalizeBuildMode(buildMode) : null;
  if (modeStr == null) {
    try { modeStr = normalizeBuildMode(reqId != null ? getRequest(reqId)?.build_mode : BUILD_MODE_FULL); }
    catch { modeStr = BUILD_MODE_FULL; }
  }
  const mvpBuild = modeStr === BUILD_MODE_MVP;
  const quickBuild = modeStr === BUILD_MODE_QUICK;
  const fastBuild = mvpBuild || quickBuild;

  // Layer this project's (and this user's) API key over the global connector.
  // initiatedBy is the person whose work this is, so a personal key is only ever
  // spent on their own builds.
  let ready = buildRunnerReady({ projectId, userId: initiatedBy });
  if (!ready.ok) return { status: 'error', error: ready.reason };

  // Model ROUTING (migration 525): pick model + effort from the knowledge base
  // (task kind → rule), the audit's difficulty score, and the deterministic
  // escalation signal (a prior attempt of this same request failed/halted →
  // step up to the rule's escalation model). The decision is stamped on the
  // cycle + logged as a cycle event, and its terminal outcome is recorded, so
  // every build's routing is reviewable and the dictionary can be tuned from
  // evidence. MOCK2_ROUTING=shadow records without applying; =off skips.
  let routing = null;
  const mode = routingMode(process.env);
  if (mode !== 'off') {
    try {
      const priorCycles = listCyclesForProject(projectId, { limit: 20 });
      // A resume carries no fresh classification — recover the task from the
      // most recent routed build cycle of the same request.
      let effTask = task;
      if (!effTask) {
        for (const c of priorCycles) {
          if (c.stage !== 'build' || !c.routing_json) continue;
          if (reqId != null && Number(c.request_id) !== Number(reqId)) continue;
          const prev = parseRoutingJson(c.routing_json);
          if (prev?.task_kind) { effTask = { kind: prev.task_kind, difficulty: prev.difficulty ?? null }; break; }
        }
      }
      const rule = getRoutingRule(effTask?.kind || null);
      const attempts = escalationAttempts({ priorCycles, requestId: reqId, instruction });
      routing = decideRouting({
        rule, slotModel: ready.model, difficulty: effTask?.difficulty ?? null,
        priorAttempts: attempts, env: routingEnv(), laneDefaultEffort: 'high',
      });
      routing.mode = mode;
      // The model that will ACTUALLY run (shadow mode records the decision but
      // keeps the slot model) — the outcome recorder needs ground truth.
      routing.applied_model = mode === 'on' ? (routing.model || ready.model) : ready.model;
      if (mode === 'on') {
        ready = { ...ready, model: routing.model || ready.model, effort: routing.effort };
      }
    } catch (e) { console.warn('[mock2] routing decision failed (slot defaults apply):', e?.message); }
  }

  // Fast-mode routing: a fixed fast model + calibrated effort (MVP scaffold →
  // low, quick update → medium). This is an explicit operator speed choice, so
  // it overrides whatever the knowledge base decided (an escalation or a
  // heavyweight rule override would defeat the mode).
  if (fastBuild) {
    const fast = mvpBuild ? mvpRoutingDecision(routingEnv(), ready.model) : quickRoutingDecision(routingEnv(), ready.model);
    routing = { ...(routing || {}), ...fast, mode, applied_model: fast.model };
    ready = { ...ready, model: fast.model, effort: fast.effort };
  }

  // Operator lane tuning (admin settings → Model thinking & effort) — the LAST
  // word over slots, routing, fast-model, and the MVP override: per-lane model
  // override, effort override, and a thinking-off switch.
  {
    const tuned = applyLaneTuning(
      { model: ready.model, effort: ready.effort || null, thinking: null },
      getLaneTuning(fastBuild ? 'mvp' : 'build'),
    );
    ready = { ...ready, model: tuned.model, effort: tuned.effort, thinking: tuned.thinking };
    if (routing) routing.applied_model = ready.model;
  }

  // No-work-remaining backstop: when the last NOOP_CYCLE_LIMIT cycles for this
  // exact instruction each completed as a VERIFIED no-op (success-family
  // terminal, orchestrator-confirmed empty code diff), the work is done —
  // starting another empty cycle is the loop, not progress. Refuse calmly with
  // a terminal message (no cycle row is inserted: a refusal must not itself
  // mint another no-op). New/different instructions reset the count naturally.
  try {
    const refusal = noopStartRefusal({ priorCycles: listCyclesForProject(projectId, { limit: 10 }), instruction });
    if (refusal.refuse) {
      safeRaise({
        kind: 'flag', project_id: projectId, dedupe_key: `mock2-noop-done:${projectId}`,
        ref_table: 'mock2_projects', ref_id: projectId,
        detail: `${project.name}: ${refusal.reason}`,
      });
      return { status: 'refused', cycle: null, error: refusal.reason };
    }
  } catch (e) { console.warn('[mock2] no-op start check failed:', e?.message); }

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
  // Stamp the routing decision on the cycle (reviewable; the outcome recorder
  // and the Build panel read it back).
  if (routing) {
    try { updateCycle(cycle.id, { routing_json: JSON.stringify(routing) }); } catch { /* best effort */ }
  }
  const lock = acquireLock({ projectId, requester: { type: 'cycle', id: cycle.id }, role: 'admin' });
  if (!lock.ok) {
    finishCycle(cycle.id, { status: 'failed', error: `could not acquire checkout lock: ${lock.reason}` });
    return { status: 'error', cycle: getCycle(cycle.id), error: `Could not acquire the checkout lock: ${lock.reason}` };
  }

  const containerName = project.container_name || containerNameForProject(projectId);
  // Fast builds run a REDUCED battery: MVP drops the authoring-discipline
  // gates (rule-coverage / ui-interaction / acceptance); a quick update also
  // defers the vitest run. A later full Build brings everything back.
  //
  // Admin gate waivers (resume context, 'gate:<key>'): the waived gate is
  // REMOVED from this one cycle's battery — the enforcement layer, not a
  // narrated promise the finish tool then contradicts. One-time by
  // construction: the waiver lives only on this resume's context, so the next
  // cycle runs the full battery again.
  const waivedGates = (resumeContext?.waivers || [])
    .map((w) => (typeof w?.rule === 'string' && w.rule.startsWith('gate:') ? w.rule.slice(5) : null))
    .filter(Boolean);
  // ONE decision for the whole battery: operator gates filtered to this mode's
  // profile, plus the backend-owned baseline gates for that profile. Every
  // mode now runs SOME gates — the old code gave mvp and quick a battery of
  // zero, which is how an app shipped without a single check ever executing.
  // A waiver still removes a gate, because a waiver is a deliberate admin act.
  const parsedGates = parseGateScripts(framework.gates_json);
  const battery = buildGateBattery(parsedGates, modeStr);
  const gateProfile = battery.profile;
  const gateScripts = battery.gates.filter((g) => !waivedGates.includes(g.name));
  const frameworkGates = gatesForProfile(parsedGates, gateProfile);
  console.log(`[mock2] cycle ${cycle.id} gate profile '${gateProfile}': `
    + gateScripts.map((g) => `${g.name}${g.advisory ? '(advisory)' : ''}`).join(', '));
  // A FULL build with zero FRAMEWORK gates is almost certainly a broken
  // framework version (empty/unparseable gates_json) — the baseline gates
  // still run, but the full Build / Production check exists to run the
  // operator's battery. Say so loudly instead of running a battery that is
  // only the baseline (this is what made a full build's run_gates return
  // "pending" with no gate names — the model then honestly refused to finish).
  if (!frameworkGates.length && modeStr === BUILD_MODE_FULL) {
    try {
      insertMessage({
        projectId, kind: 'system', cycleId: cycle.id,
        body: 'Warning: the pinned framework version defines NO gates, so this full build (and any Production check) runs with an EMPTY battery. Check Framework → Versions (gates.json) and republish/re-import a version with gates to restore the production battery.',
      });
    } catch { /* best effort */ }
  }
  if (waivedGates.length) {
    try {
      insertMessage({
        projectId, kind: 'system', cycleId: cycle.id,
        body: `Admin waiver applied for this resume: gate${waivedGates.length === 1 ? '' : 's'} ${waivedGates.join(', ')} excluded from this cycle's battery (one-time — the next build runs it again). The underlying findings remain tracked and are not hidden.`,
      });
    } catch { /* best effort */ }
  }

  setJob(cycle.id, {
    phase: 'starting',
    message: gateScripts.length ? 'Copying pinned gates into the container…' : 'Preparing the build…',
    startedAt: Date.now(),
  });

  // Which harness drives this cycle: the project's own choice, else the legacy
  // BUILD_RUNNER flag, else the ProxyPilot harness (hand-rolled loop below,
  // BYTE-FOR-BYTE unchanged). harness.js dynamic-imports the chosen runner so a
  // ProxyPilot-only install never needs @anthropic-ai/claude-agent-sdk present.
  // Both harnesses share the same args, the same terminal-error handling, and
  // the same gate/checkpoint/deploy tail.
  const args = { cycle, project, containerName, framework, gateScripts, ready, buildMode: modeStr };
  const harness = harnessForProject(project, process.env);
  // Quick-lane pre-pass (prepass-logic.js): one cheap classifier+enrichment
  // call BEFORE the build — sizes the request (a "quick" ask can secretly be a
  // whole feature), raises effort a notch when it's bigger than the lane
  // assumes, stamps a working brief into routing_json for the task turn, and
  // suggests Build MVP in chat for feature-scale asks. Fail-open: any error →
  // the build runs exactly as before. Fresh (non-resume) quick cycles only.
  const wantsPrepass = modeStr === BUILD_MODE_QUICK && !resumeContext && prepassEnabled(routingEnv());
  const driveCycle = async () => {
    if (wantsPrepass) {
      try {
        setJob(cycle.id, { phase: 'starting', message: 'Sizing the request…' });
        const pp = await runQuickPrepass({ project, cycle, ready, routing });
        if (pp?.effort && pp.effort !== args.ready.effort) args.ready = { ...args.ready, effort: pp.effort };
      } catch (e) { console.warn('[mock2] quick pre-pass failed (build proceeds unchanged):', e?.message); }
    }
    return harness.runTask(args);
  };

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
// (optional): the id/label of a halt resolution option the operator chose.
// waivers (optional, ADMIN-granted upstream): structured rule waivers — e.g.
// [{ rule: 'reproduce_first' }] — that the resumed cycle applies AT THE
// ENFORCEMENT LAYER (acceptanceVerdict), not as narration; each is stamped into
// the cycle's acceptance record. Any GRANTED, unused one-time authorizations
// for the project are gathered, injected, and consumed (single-use) on this
// resume. A bare resume (no message/option/grant/waiver) carries no new
// context, so a build blocked on a real blocker re-halts rather than loops.
export async function retryCycle({ project, cycle, initiatedBy, actingAsAdmin = 0, message = '', option = null, waivers = [] }) {
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
  // Two waiver classes: the reproduce-first rule (acceptanceVerdict layer) and
  // per-gate waivers ('gate:<key>', e.g. 'gate:security-scan') applied at the
  // battery itself — for a red gate whose findings are PRE-EXISTING and
  // unrelated to the diff (the "npm-audit fails on transitive dev-dep vulns"
  // block). Both are admin-only (enforced in the route).
  const grantedWaivers = (Array.isArray(waivers) ? waivers : [])
    .map((w) => (typeof w === 'string' ? { rule: w } : w))
    .filter((w) => w && (w.rule === 'reproduce_first' || (typeof w.rule === 'string' && /^gate:[a-z0-9_.-]{1,60}$/i.test(w.rule))));
  // Carry the blocked cycle's INTEGRATION-GATE FINDINGS into the resume: the
  // gate is deterministic, so without the exact finding list the resumed build
  // rediscovers them blind and re-halts on the same block (a real 5-cycle loop).
  // Bounded so a pathological finding set can't blow the transcript.
  let gateFindings = [];
  try {
    const d = cycle.integration_gate_json ? JSON.parse(cycle.integration_gate_json) : null;
    if (d?.blocking && Array.isArray(d.reasons)) {
      let budget = 7000;
      for (const r of d.reasons.slice(0, 40)) {
        const line = String(r || '').slice(0, 500);
        if (line.length > budget) break;
        budget -= line.length;
        gateFindings.push(line);
      }
    }
  } catch { gateFindings = []; }
  const resumeContext = (msg || selectedOption || authorizations.length || grantedWaivers.length || gateFindings.length)
    ? { message: msg, selectedOption, authorizations, waivers: grantedWaivers, findings: gateFindings }
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
  // Redeploy applies to any settled cycle, not only a failed deploy: a build that
  // deployed fine can stop serving LATER (the app crashed, the container
  // restarted into a bad state) and the operator needs a way to restart it from
  // the UI without a model round. Only an actively running build is refused —
  // it already holds the checkout lock and is mid-flight.
  const ACTIVE_STATUSES = ['queued', 'estimating', 'running'];
  if (ACTIVE_STATUSES.includes(cycle.status)) {
    return { status: 'error', error: 'This build is still running — wait for it to finish before redeploying.' };
  }
  const projectId = Number(project.id);
  if (project.lifecycle !== 'active') {
    return { status: 'error', error: 'Bring the project online to redeploy.' };
  }
  // What the cycle should settle back to when the redeploy succeeds. A failed
  // deploy heals to succeeded (the original semantics); any other terminal
  // (succeeded, awaiting_user pending live verification, …) is RESTORED — a
  // restart must not rewrite history (e.g. it must never promote a
  // pending-verification build to succeeded).
  const hadFailedDeploy = cycle.status === 'failed' && cycle.deploy_status === 'deploy_failed';
  const restoreStatus = hadFailedDeploy ? 'succeeded' : cycle.status;
  const lock = acquireLock({ projectId, requester: { type: 'cycle', id: cycle.id }, role: 'admin' });
  if (!lock.ok) return { status: 'error', error: `Could not acquire the checkout lock: ${lock.reason}` };
  const holder = { type: 'cycle', id: cycle.id };
  const containerName = project.container_name || containerNameForProject(projectId);

  // Reopen the finished cycle as running so the task list shows deploy progress.
  updateCycle(cycle.id, { status: 'running', error: null, deploy_status: 'deploying' });
  setJob(cycle.id, { phase: 'deploying', message: 'Redeploying the app…', startedAt: Date.now() });

  // Fire-and-forget; always lands terminal + releases the lock.
  (async () => {
    try {
      // Repair pass first: components marked 'installed' under the old
      // silent-npm-failure bug can be missing their node_modules, which fails
      // the deploy at tsc ("Cannot find module …"). Fixing that here makes
      // "Retry deploy" the one-click recovery. Dynamic import — the static one
      // would be a cycle (component-install imports runner for exec helpers).
      try {
        const [{ ensureComponentDeps, ensureScaffoldDeps }, { listProjectComponents }] = await Promise.all([
          import('./component-install.js'), import('./components.js'),
        ]);
        try { await ensureScaffoldDeps({ containerName }); } catch { /* best effort */ }
        const ensured = await ensureComponentDeps({ containerName, rows: listProjectComponents(projectId) });
        if (ensured.repaired.length) {
          insertMessage({
            projectId, kind: 'system', cycleId: cycle.id,
            body: `Repaired missing component dependencies before redeploying: ${ensured.repaired.map((r) => `${r.key} (${r.missing.join(', ')})`).join('; ')}.`,
          });
        }
        if (!ensured.ok) {
          const detail = ensured.failed.map((f) => f.error).join('; ');
          finishCycle(cycle.id, { status: 'failed', error: detail });
          setJob(cycle.id, { phase: 'deploy_failed', message: detail });
          return;
        }
      } catch (e) { console.warn('[mock2] retry-deploy dep repair failed:', e?.message); }
      const deployed = await deployStage({ cycle: getCycle(cycle.id), project, containerName, holder });
      if (!deployed.ok) {
        finishCycle(cycle.id, { status: 'failed', error: deployed.error });
        setJob(cycle.id, { phase: 'deploy_failed', message: deployed.error });
        void notifyCycleComplete({ project: { id: projectId, name: project.name }, cycle: getCycle(cycle.id), outcome: 'deploy_failed' });
      } else {
        finishCycle(cycle.id, { status: restoreStatus, error: null });
        if (restoreStatus === 'succeeded') {
          try { const rc = getCycle(cycle.id); if (rc?.request_id) closeRequest(rc.request_id, 'succeeded'); } catch { /* best effort */ }
        }
        updateProject(projectId, { last_activity_at: nowIso() });
        setJob(cycle.id, {
          phase: deployed.skipped ? 'succeeded' : 'serving',
          message: deployed.skipped
            ? 'Nothing to deploy — the placeholder is still serving.'
            : 'Deployed — the app is live on its URL.',
        });
        // Only a heal-to-succeeded is a state change worth notifying; restoring
        // the prior terminal (a plain restart) changes nothing to announce.
        if (restoreStatus === 'succeeded') {
          void notifyCycleComplete({ project: { id: projectId, name: project.name }, cycle: getCycle(cycle.id), outcome: 'succeeded' });
        }
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

// acceptPendingVerification — operator completion valve (accept-pending-logic.js is
// the pure decision). For a BLOCKED cycle the operator attests is real code awaiting
// a live external check the fence cannot run, convert it to
// pending-operator-verification and deploy the already-checkpointed working tree —
// WITHOUT another model round and NEVER as "succeeded". The outstanding live check
// is recorded on the cycle and the operator's attestation is audit-logged, so the
// honesty guarantee moves from "the fence proves it" to "a named human verifies it
// live and records the observed result" — it is never dropped.
export async function acceptPendingVerification({ project, cycle, initiatedBy, attestation = '' }) {
  if (!cycle) return { status: 'error', error: 'No cycle to accept.' };
  const elig = acceptPendingEligibility(cycle);
  if (!elig.ok) return { status: 'error', error: elig.reason };
  const att = normalizeAttestation(attestation);
  if (!att.ok) return { status: 'error', error: att.error };
  const projectId = Number(project.id);
  if (project.lifecycle !== 'active') {
    return { status: 'error', error: 'Bring the project online first — accept-pending deploys the app so you can verify it live.' };
  }
  const lock = acquireLock({ projectId, requester: { type: 'cycle', id: cycle.id }, role: 'admin' });
  if (!lock.ok) return { status: 'error', error: `Could not acquire the checkout lock: ${lock.reason}` };
  const holder = { type: 'cycle', id: cycle.id };
  const containerName = project.container_name || containerNameForProject(projectId);

  let gateDecision = null;
  try { gateDecision = cycle.integration_gate_json ? JSON.parse(cycle.integration_gate_json) : null; } catch { gateDecision = null; }
  const subsystems = gateDecision?.touched_subsystems || [];
  const checklist = buildAcceptPendingChecklist({ gateDecision, subsystems });
  const priorHaltReason = cycle.halt_reason || null;
  const logEvent = (kind, payload = {}) => insertCycleEvent({ projectId, cycleId: cycle.id, kind, ...payload });

  // Reopen as running so the task list shows deploy progress; the halt banner clears.
  updateCycle(cycle.id, { status: 'running', error: null });
  setJob(cycle.id, { phase: 'deploying', message: 'Accepting as pending live verification — deploying…', startedAt: Date.now() });

  // Fire-and-forget; always lands terminal + releases the lock (mirrors retryDeploy).
  (async () => {
    try {
      const deployed = await deployStage({ cycle: getCycle(cycle.id), project, containerName, holder });
      if (!deployed.ok) {
        finishCycle(cycle.id, { status: 'failed', error: `accept-pending deploy failed: ${deployed.error}` });
        setJob(cycle.id, { phase: 'deploy_failed', message: deployed.error });
        void notifyCycleComplete({ project: { id: projectId, name: project.name }, cycle: getCycle(cycle.id), outcome: 'deploy_failed' });
        return;
      }
      // Land the honest pending terminal (status awaiting_user + verification_state
      // pending → reported outcome pending-operator-verification), the SAME terminal
      // the runner's own B.5 branch produces — never "succeeded".
      openVerificationChecklist({ projectId, cycleId: cycle.id, checklist });
      updateCycle(cycle.id, { verification_state: 'pending', halt_reason: null });
      finishCycle(cycle.id, { status: 'awaiting_user', error: null });
      try {
        recordIntegrationResolution({
          project_id: projectId, cycle_id: cycle.id, kind: 'operator_accept_pending',
          reason: att.text, routed_to: 'pending-operator-verification',
          decided_by: initiatedBy, role: 'admin',
        });
      } catch (e) { console.warn('[mock2] accept-pending resolution record failed:', e?.message); }
      try {
        logAudit(initiatedBy, 'MOCK2_ACCEPT_PENDING_VERIFICATION', 'mock2_cycle', cycle.id, {
          project_id: projectId, attestation: att.text,
          checklist: checklist.map((c) => c.item_id), prior_halt_reason: priorHaltReason,
        }, null);
      } catch (e) { console.warn('[mock2] accept-pending audit failed:', e?.message); }
      logEvent('pending_verification', {
        role: 'system',
        content: `Operator accepted the blocked build as pending live verification (${checklist.length} live check(s) outstanding). Attestation: ${att.text}`,
        meta: { checklist, operator_accepted: true, prior_halt_reason: priorHaltReason },
      });
      updateProject(projectId, { last_activity_at: nowIso() });
      setJob(cycle.id, {
        phase: 'pending_verification',
        message: `Accepted — deployed for live verification. ${checklist.length} live check${checklist.length === 1 ? '' : 's'} to confirm against the real system.`,
        commit: null,
      });
      void notifyCycleComplete({ project: { id: projectId, name: project.name }, cycle: getCycle(cycle.id), outcome: 'pending_verification' });
      // This path DEPLOYED too (deployStage above), so it gets the same
      // post-build chain as every other terminal that put something live.
      void import('./design-review.js')
        .then((m) => m.afterBuildReview(projectId, { reason: 'accepted as pending verification' }))
        .catch((e) => console.warn('[mock2] post-build review (accept-pending) failed:', e?.message));
    } catch (err) {
      finishCycle(cycle.id, { status: 'failed', error: `accept-pending crashed: ${err?.message || err}` });
      setJob(cycle.id, { phase: 'failed', message: `accept-pending crashed: ${err?.message || err}` });
    } finally {
      releaseLock(projectId, holder);
      scheduleJobCleanup(cycle.id);
    }
  })();

  return { status: 'started', cycle: getCycle(cycle.id), warn: elig.warn || null };
}

// ---- the agentic loop ----

// Exported ONLY for the ProxyPilotHarness adapter (harness.js), which wraps this
// loop unchanged — nothing else calls it directly; startCycle goes through the
// harness factory.
export async function runCycle({ cycle, project, containerName, framework, gateScripts, ready, buildMode = BUILD_MODE_FULL, harnessProfile = null }) {
  const cycleMode = normalizeBuildMode(buildMode);
  const mvpBuild = isFastBuildMode(cycleMode); // fast modes share the relaxed acceptance path
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

  // Migration scan (first cycle under the integration-truthfulness harness).
  // Idempotent; records non-blocking suspected-legacy-stub / analysis-incomplete
  // findings for the existing tree, which become blocking on the touched-subsystem
  // / reconciliation rules enforced at finish. Best-effort — never blocks start.
  try {
    await scanProjectForLegacyStubs({ project, frameworkVersionId: framework.id, execInContainer, readFileInContainer, appDir: APP_DIR });
  } catch (e) { console.warn('[mock2] migration scan failed:', e?.message); }

  // The durable transcript for this cycle (downloadable later). logEvent is
  // best-effort — insertCycleEvent already swallows its own errors.
  const logEvent = (kind, { role = null, content = null, meta = null } = {}) =>
    insertCycleEvent({ projectId, cycleId: cycle.id, kind, role, content, meta });
  logEvent('task', { role: 'user', content: cycle.instruction || '', meta: { model: ready.model, framework_version: framework.version } });
  // The routing decision, durably in the cycle transcript (request-log review).
  try {
    const routing = parseRoutingJson(getCycle(cycle.id)?.routing_json);
    if (routing) {
      logEvent('routing', {
        role: 'system',
        content: `model=${ready.model} effort=${ready.effort || 'default'} rung=${routing.rung} kind=${routing.task_kind}${routing.reason ? ` (${routing.reason})` : ''}${routing.mode === 'shadow' ? ' [shadow — slot defaults applied]' : ''}`,
        meta: routing,
      });
    }
  } catch { /* best effort */ }

  const skills = parseFrameworkSkills(framework.skills_json);
  // The PUBLISHED component-library catalog (migration 516): the runner is told
  // what reusable building blocks exist and fetches sources via get_component.
  // Best-effort — an empty/failed catalog just omits the prompt section.
  let componentCatalog = [];
  try { componentCatalog = listPublishedComponents(); } catch (err) { console.warn('[mock2] component catalog load failed:', err?.message); }
  // Components the platform PRE-INSTALLED for this project (migration 524) are
  // presented as installed infrastructure to wire against — and filtered out of
  // the adoptable catalog so the runner is never told to re-materialize them.
  let installedComponents = [];
  try {
    installedComponents = listProjectComponents(project.id)
      .filter((r) => r.status === 'installed')
      .map((r) => ({ key: r.key, name: r.name, version: r.pinned_version, contract: parseContractJson(r.contract_json) }));
  } catch (err) { console.warn('[mock2] installed components load failed:', err?.message); }
  const installedKeys = new Set(installedComponents.map((c) => c.key));
  // The harness profile (copilot) swaps the system prompt + tool vocabulary;
  // no profile → the proxypilot harness behavior, byte-identical to before.
  const buildSystemPrompt = harnessProfile?.buildSystemPrompt || buildRunnerSystemPrompt;
  const system = stepSystemPrompt('build-runner', buildSystemPrompt({
    constitution: framework.constitution_md, skills, appDir: APP_DIR,
    webPort: project.web_port || 3000,
    components: componentCatalog.filter((c) => !installedKeys.has(c.key)),
    installedComponents,
    buildMode: cycleMode,
  }), { CONSTITUTION: framework.constitution_md, APP_DIR, WEB_PORT: project.web_port || 3000 });
  // Multi-modal: images attached to the Build press live on the REQUEST row
  // (migration 526), so every segment of the request — the first build, a
  // deferred build after rule questions, a resume — re-hydrates the same
  // screenshots/design references onto its task turn.
  let taskImages = [];
  try {
    const req = cycle.request_id != null ? getRequest(cycle.request_id) : null;
    if (req?.attachments_json) taskImages = hydrateAttachments(cycle.project_id, parseAttachmentsJson(req.attachments_json));
  } catch (e) { console.warn('[mock2] task image hydration failed:', e?.message); }
  // The quick-lane pre-pass brief (routing_json.prepass, stamped before this
  // run started) rides the task turn as subordinate sizing notes — the
  // verbatim instruction stays authoritative.
  let prepassBrief = '';
  try { prepassBrief = formatBriefForTask(parseRoutingJson(getCycle(cycle.id)?.routing_json)?.prepass); } catch { /* optional */ }
  // Standing operator taste: recent thumbs-down notes ride every task so a
  // flagged mistake is corrected once, not re-flagged build after build.
  let feedbackSection = '';
  try { feedbackSection = buildFeedbackSection(listRecentDownNotes(projectId)); } catch { /* optional */ }
  // What the last look at the RUNNING app found and nobody has fixed. Until
  // this rode the task turn, the design review's critique lived exactly as long
  // as the chat message it was posted in — the next build started from the same
  // mockup with no idea the app had been looked at.
  let designFindingsSectionText = '';
  let designFindingKeys = [];
  try {
    const brief = await buildDesignFindingsBrief(getProject(projectId));
    designFindingsSectionText = brief.section;
    designFindingKeys = brief.keys;
  } catch { /* optional */ }
  // Reference material the operator collected for this project (logos, copy,
  // brand notes, screenshots). Subordinate to the instruction, and empty when
  // the library is — a project with no assets pays nothing for this.
  let assetSection = '';
  // WHAT CHANGED since the last build, checked deterministically on every one.
  //
  // The library was already read on every turn, so a logo uploaded after the
  // app was built did reach the next build's context — buried in a pile of
  // standing reference material with nothing marking it as new, and therefore
  // nothing telling the build to go back and apply it. The operator had to
  // notice and ask. The fingerprint of what the LAST build saw is stored on the
  // project, so the delta is arithmetic rather than a judgement call.
  let assetChangeSection = '';
  let assetsFp = null;
  try {
    const assets = listAssets(projectId);
    assetSection = buildAssetSection(assets);
    const diff = diffAssetFingerprint(getProject(projectId)?.assets_fingerprint, assets);
    assetChangeSection = buildAssetChangeSection(diff);
    assetsFp = diff.fingerprint;
    if (diff.changed) {
      logEvent('assets', {
        content: `assets changed since the last build: ${diff.added.length} added, ${diff.updated.length} changed, ${diff.removed.length} removed`,
        meta: { added: diff.added.length, updated: diff.updated.length, removed: diff.removed.length },
      });
    }
  } catch { /* optional */ }
  // Record what THIS build was told about the library — but only once it has
  // actually shipped. Recording it up front would mean a build that failed
  // before applying a new logo had "seen" it, and the next build would be told
  // nothing had changed. The change must survive a failure.
  const recordAssetsSeen = () => {
    if (!assetsFp) return;
    try { updateProject(projectId, { assets_fingerprint: assetsFp }); } catch { /* best effort */ }
  };
  // MVP-path floor (project-32 ratchet): the fast path skips the rule
  // interview, and exactly the rules an interview would set (editability,
  // status mutability, deletion policy) are what shipped missing. Fast
  // builds get the standard CRUD rules pack injected as a binding floor —
  // the inventory/instruction still outrank it where they explicitly
  // deviate. Full builds are unchanged (their interview owns the rules).
  const rulesFloor = mvpBuild ? crudRulesFloorSection() : '';
  const transcript = [{ role: 'user', text: `${buildRunnerTask(cycle.instruction)}${prepassBrief}${rulesFloor}${feedbackSection}${designFindingsSectionText}${assetSection}${assetChangeSection}`, ...(taskImages.length ? { images: taskImages } : {}) }];
  // Counted here rather than at read time: the count means "builds that were
  // told and shipped anyway", and a run that died before its first turn was
  // never told anything.
  if (designFindingKeys.length) {
    markDesignFindingsBriefed(getProject(projectId), designFindingKeys)
      .catch((e) => console.warn('[mock2] design findings marking failed:', e?.message));
  }
  if (taskImages.length) logEvent('attachments', { role: 'user', content: `${taskImages.length} image attachment(s) included with the task`, meta: { count: taskImages.length } });
  // Stub-registry context (B.6): EVERY cycle receives a concise global list of
  // unresolved production simulations, so a later instruction-scoped cycle can no
  // longer build on top of a shipped stub blind (AUDIT.md A.4). Cycles whose
  // instruction implicates an affected subsystem additionally receive the FULL
  // registry records + remediation context. Best-effort; a missing registry is
  // simply an empty list.
  try {
    const reg = await readFileInContainer(containerName, STUB_REGISTRY_PATH);
    const openStubs = reg.ok ? listOpenStubs(reg.content) : [];
    if (openStubs.length) {
      const instr = String(cycle.instruction || '').toLowerCase();
      const implicated = [...new Set(openStubs.map((s) => s.subsystem))].filter((s) => instr.includes(String(s).toLowerCase()));
      const ctx = stubContextForCycle({ stubs: openStubs, subsystems: implicated });
      const parts = [`Unresolved production simulations recorded for this project (do not build on top of these blind; a critical/high one on a subsystem you touch blocks "succeeded"):\n${ctx.global}`];
      if (ctx.block) parts.push(`Full records for the subsystem(s) this task touches:\n${ctx.block}`);
      const block = parts.join('\n\n');
      transcript.push({ role: 'user', text: block });
      logEvent('stub_context', { role: 'system', content: block, meta: { open: openStubs.length, implicated } });
    }
  } catch (e) { console.warn('[mock2] stub context injection failed:', e?.message); }
  // PATCH2 B.2 — AMBIENT capability-verification status: the project's outstanding
  // live checks are surfaced to the cycle as context, NOT as a blocker. A cycle
  // that does not touch those capabilities must not be dragged into their
  // verification; it is told they exist so it doesn't re-declare or re-flag them.
  try {
    const capStatus = capabilityCheckStatus({
      checklistItems: projectChecklistItems(projectId),
      activeVerifications: listActiveVerifications(projectId),
    });
    if (capStatus.outstanding.length) {
      const lines = capStatus.outstanding.map((c) => `- ${c.item_id} (${c.subsystem || 'capability'}): ${c.description || 'live external verification outstanding'}`).join('\n');
      const block = `Ambient status — these capabilities already await a LIVE operator verification a human runs against the real system (NOT your job this cycle, NOT a blocker; do not re-declare or re-flag them, and do not stub them):\n${lines}`;
      transcript.push({ role: 'user', text: block });
      logEvent('capability_status', { role: 'system', content: block, meta: { outstanding: capStatus.outstanding.map((c) => c.item_id) } });
    }
  } catch (e) { console.warn('[mock2] capability status injection failed:', e?.message); }
  // On a RESUME, inject the operator guidance (message / chosen option / granted
  // one-time authorizations) as a distinct labeled user turn AFTER the task.
  let resumeCtx = null;
  try { const rc = getCycle(cycle.id)?.resume_context_json; resumeCtx = rc ? JSON.parse(rc) : null; } catch { resumeCtx = null; }
  if (resumeCtx) {
    const block = buildResumeContextBlock(resumeCtx);
    if (block) {
      transcript.push({ role: 'user', text: block });
      logEvent('resume_guidance', { role: 'user', content: block, meta: { message: resumeCtx.message || '', option: resumeCtx.selectedOption?.label || null, authorizations: (resumeCtx.authorizations || []).map((a) => a.scope), waivers: (resumeCtx.waivers || []).map((w) => w.rule), findings: (resumeCtx.findings || []).length } });
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
  // Acceptance discipline (cycle-94 lesson). taskKind classifies the ask from
  // its instruction; redTestObserved records whether ANY battery this cycle
  // showed the test gate red — the reproduce-first proof a bug-fix cycle must
  // carry before finish is accepted.
  const taskKind = classifyTaskKind(cycle.instruction);
  let redTestObserved = false;
  // Action-parity gate state (ratchet 3): reject a finish at most once for
  // silently-missing inventory mutations — a second finish proceeds with a
  // loud note instead of looping.
  let parityRejected = false;
  // An enforced reproduce-first waiver carried on the resume context (admin-
  // granted upstream). Applied at the acceptance verdict — the real enforcement
  // layer — and stamped into the acceptance record, never merely narrated.
  const reproduceFirstWaiver = (resumeCtx?.waivers || []).find((w) => w && w.rule === 'reproduce_first') || null;

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
    // Web search rides along ONLY when the operator opted the build lane in
    // (MOCK2_RUNNER_WEB_SEARCH=on, Anthropic connectors only) — Anthropic runs
    // the search server-side during the call, so the fence stays sealed.
    const result = await callStepTurn('build-runner', {
      connector: ready.connector, apiKey: ready.apiKey, model: ready.model, system, tools: (harnessProfile?.toolsForCycle || runnerToolsForCycle)({ hasGates: gateScripts.length > 0 }), transcript, maxTokens: RUNNER_MAX_TOKENS || undefined,
      serverTools: webSearchServerTools({ provider: ready.connector.provider, env: process.env, flag: RUNNER_WEB_SEARCH_FLAG, defaultOn: false }),
      effort: ready.effort || null,
      thinking: ready.thinking || null,
    });
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
    try { insertLedgerEntry({ projectId, cycleId: cycle.id, connectorId: ready.connector.id, model: result.modelUsed || ready.model, inputTokens: u.inputTokens, outputTokens: u.outputTokens, costCents, wallClockMs: 0, step: 'build-runner' }); } catch (e) { console.warn('[mock2] ledger write failed:', e?.message); }

    // Only record a NON-EMPTY assistant turn. An empty one (no text, no tool
    // calls) serializes to empty message content, which Anthropic/OpenAI reject —
    // re-sending it would 400 every subsequent call and derail the cycle. When
    // the model stalls with nothing, we skip its turn and nudge below instead.
    if (result.text || (result.toolCalls && result.toolCalls.length)) {
      // `raw` carries the verbatim Anthropic blocks (thinking/server-tool) for
      // same-model replay — required with adaptive thinking on. Null elsewhere.
      transcript.push({ role: 'assistant', text: result.text || '', toolCalls: result.toolCalls || [], raw: result.raw || null });
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
          if (out.gateReports) redTestObserved = redTestObserved || batteryHasRedTestGate(out.gateReports);
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
        if (out.gateReports) redTestObserved = redTestObserved || batteryHasRedTestGate(out.gateReports);
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
    if (decision.done || decision.pendingVerification) {
      // PATCH2 B.1: `finish` (→ succeeded) and `pending_verification` (→ a calm
      // pending-operator-verification) share the SAME validation flow (acceptance,
      // gate battery, integration gate). termName/termId make every rejected-turn
      // tool_result match whichever terminal tool the builder actually called, so
      // a pending_verification turn is never answered with an unmatched finish id.
      const termName = decision.pendingVerification ? 'pending_verification' : 'finish';
      const termId = (result.toolCalls.find((c) => c && c.name === termName) || {}).id || termName;
      // The turn may pair the terminal call with other tool calls — answer EVERY
      // tool_use (providers reject a follow-up with an unmatched tool_use id).
      for (const call of decision.toolCalls) {
        if (call.name === termName) continue;
        const out = await executeTool({ call, cycle, containerName, holder, gateScripts });
        lastGateReports = out.gateReports || lastGateReports;
        if (out.gateReports) redTestObserved = redTestObserved || batteryHasRedTestGate(out.gateReports);
        transcript.push({ role: 'tool', toolCallId: call.id, name: call.name, content: truncateToolResult(out.content) });
        logEvent('tool_result', { role: 'tool', content: out.content, meta: { name: call.name } });
      }
      // Acceptance criteria are REQUIRED on finish (constitution §11): a
      // human-runnable check per user-visible change + the verified-vs-assumed
      // assumption split. A finish without them is rejected back to the model;
      // the no-progress breaker terminates a cycle that keeps refusing.
      if (!decision.finishAcceptance?.length || !decision.finishAssumptions) {
        transcript.push({
          role: 'tool', toolCallId: termId, name: termName,
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
      // The ORCHESTRATOR'S OWN diff reading for this cycle — read BEFORE the
      // acceptance verdict, because the verdict's verified-empty-diff rule keys
      // off it (§12: the harness verifies the diff itself; a model claim of
      // "nothing changed" is never trusted). Also feeds the over-claim check.
      const wt = await execInContainer(containerName, `{ git diff --name-only HEAD; git ls-files --others --exclude-standard; } 2>/dev/null | sort -u | grep -v '^state/changes/'`);
      const changedThisCycle = (wt.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
      const codeChanged = codeChangedFiles(changedThisCycle);
      // MACHINE acceptance (cycle-94 lesson — Goodhart guard). Gates green is a
      // PROXY; finish is only accepted when the acceptance spec exists and, for
      // a bug-fix task, red→green was demonstrated INSIDE this cycle — UNLESS
      // the verified code diff is empty (nothing to reproduce: an idempotent
      // re-adoption or spec-only alignment finishes as the chore it is), or an
      // admin granted an enforced reproduce-first waiver on resume. Every
      // rejection reason is actionable feedback; the breaker backstops refusal.
      const accFile = await readFileInContainer(containerName, ACCEPTANCE_PATH);
      const accParsed = accFile.ok ? parseAcceptance(accFile.content) : { ok: false, error: 'state/acceptance.json not found' };
      // MVP builds skip the acceptance-spec discipline (the acceptance gate is
      // not in their battery either): the finish call's own human-runnable
      // checks + assumptions are still required above, but no
      // state/acceptance.json or red→green demonstration is demanded. The full
      // Build restores the strict verdict.
      const verdict = mvpBuild
        ? { ok: true, reasons: [], reproduce_first: 'mvp_not_required' }
        : acceptanceVerdict({ parsed: accParsed, instructionKind: taskKind, redTestObserved, changedFiles: changedThisCycle, reproduceFirstWaiver });
      if (!verdict.ok) {
        transcript.push({
          role: 'tool', toolCallId: termId, name: termName,
          content: `Not finished — acceptance not demonstrated:\n${verdict.reasons.map((r) => `- ${r}`).join('\n')}`,
        });
        logEvent('note', { role: 'system', content: `Finish rejected — acceptance not demonstrated: ${verdict.reasons.join(' | ')}` });
        touchLock(projectId, holder);
        if (progress.tripped) {
          await haltCycle({ cycle: getCycle(cycle.id), project, containerName, holder, gateReports: lastGateReports, gateScripts, framework, trigger: progress.trigger, reason: `Auto-stopped: finish kept arriving without demonstrated acceptance (${verdict.reasons[0]}).`, logEvent });
          return scheduleJobCleanup(cycle.id);
        }
        continue;
      }
      // The change-record summary must describe THIS cycle's diff — naming files
      // the cycle did not touch (bundling prior cycles' work) is rejected.
      const oc = summaryOverclaims(decision.finishSummary, changedThisCycle);
      if (!oc.ok) {
        transcript.push({
          role: 'tool', toolCallId: termId, name: termName,
          content: `Not finished — the summary names files this cycle did NOT change (${oc.unmatched.join(', ')}). The change record must describe THIS cycle's diff only — do not bundle prior cycles' work. Files actually changed: ${changedThisCycle.slice(0, 20).join(', ') || '(none)'}. Re-call finish with a summary scoped to this diff.`,
        });
        logEvent('note', { role: 'system', content: `Finish rejected — summary over-claims (${oc.unmatched.join(', ')}).` });
        touchLock(projectId, holder);
        if (progress.tripped) {
          await haltCycle({ cycle: getCycle(cycle.id), project, containerName, holder, gateReports: lastGateReports, gateScripts, framework, trigger: progress.trigger, reason: 'Auto-stopped: finish summary kept over-claiming beyond this cycle\'s diff.', logEvent });
          return scheduleJobCleanup(cycle.id);
        }
        continue;
      }
      // ACTION PARITY (ratchet 3): on the inventory-implementation build,
      // every mutation action in the contract must be SURFACED in the app's
      // UI source — working control or a visible "Not built yet" badge both
      // put the label in the source; a label found NOWHERE is silently
      // missing and rejects the finish once (with the list). Deterministic:
      // one container grep per label over src/ + public/.
      if (/approved design inventory/i.test(String(cycle.instruction || ''))) {
        try {
          const invRead = await readFileInContainer(containerName, 'state/inventory.json');
          const inventory = invRead.ok ? JSON.parse(invRead.content) : null;
          const actions = inventory && !inventory.skipped ? mutationActions(inventory) : [];
          if (actions.length) {
            // Two greps per label, and the second one is why this is not a
            // label-matching gate any more.
            //
            //   FOUND — the contract's exact label is in the source.
            //   WORDS — it is not, but every significant word of it lands on
            //           ONE line of UI source, so a control for that action
            //           exists under a different name.
            //
            // Project 42's inventory said "Delete asset"; the platform admin
            // console already shipped exactly that control, labelled otherwise,
            // wired to DELETE /branding/assets/:id. On the exact match alone
            // the gate called it silently missing, rejected the finish, and the
            // build spent seven searches finding out the feature was already
            // there — then renamed the control to satisfy the grep. Rejecting a
            // finish over a name is how a gate teaches a build to edit labels
            // for the detector.
            const wordGrep = (a) => {
              const words = actionLabelWords(a.label).filter((w) => /^[a-z0-9]+$/.test(w)).slice(0, 6);
              if (!words.length) return null;
              if (words.length === 1) return `grep -rqi -- '${words[0]}' src public app views 2>/dev/null`;
              return `grep -rhi -- '${words[0]}' src public app views 2>/dev/null`
                + words.slice(1, -1).map((w) => ` | grep -i -- '${w}'`).join('')
                + ` | grep -qi -- '${words[words.length - 1]}'`;
            };
            const script = ['cd "' + APP_DIR + '"']
              .concat(actions.map((a) => {
                const wg = wordGrep(a);
                return `l=$(printf '%s' '${b64(a.label)}' | base64 -d)\n`
                  + `if grep -rqiF -- "$l" src public app views 2>/dev/null; then printf 'FOUND\\t%s\\n' "$l"\n`
                  + (wg ? `elif ${wg}; then printf 'WORDS\\t%s\\n' "$l"\n` : '')
                  + 'fi';
              }))
              .join('\n');
            const gr = await containerSh(containerName, script, { timeoutMs: 60000 });
            const tagged = (tag) => new Set(String(gr.stdout || '').split('\n')
              .filter((x) => x.startsWith(`${tag}\t`)).map((x) => x.slice(tag.length + 1).trim().toLowerCase()));
            const found = tagged('FOUND');
            const wordHits = tagged('WORDS');
            const parity = actionParityReport(actions, found, wordHits);
            if (parity.drifted?.length) {
              // Reported, never blocking: the action shipped, its NAME drifted
              // from the approved contract. Worth an operator's attention and
              // not worth a build round-trip.
              logEvent('note', {
                role: 'system',
                content: `Action parity: ${parity.drifted.length} action(s) present under a different label than the contract: ${parity.drifted.slice(0, 8).map((a) => `"${a.label}"`).join(', ')}`,
              });
            }
            if (!parity.ok && !parityRejected) {
              parityRejected = true;
              const list = parity.missing.slice(0, 10).map((a) => `"${a.label}" (${a.screen})`).join(', ');
              transcript.push({
                role: 'tool', toolCallId: termId, name: termName,
                content: `Not finished — action parity: these inventory mutation actions are in the approved contract but appear NOWHERE in the app's UI source: ${list}. Implement each one, or render its control disabled with a visible "Not built yet" badge — never silently drop a contract action. Then re-call finish.`,
              });
              logEvent('note', { role: 'system', content: `Finish rejected — action parity: silently missing: ${list}` });
              touchLock(projectId, holder);
              continue;
            }
            if (!parity.ok) {
              logEvent('note', { role: 'system', content: `Action parity: still missing after rejection (accepted with warning): ${parity.missing.map((a) => a.label).join(', ')}` });
              // The warning must reach the OPERATOR, not just the log —
              // request 92 shipped with five contract actions still missing
              // and only a log line to show for it.
              try {
                insertMessage({
                  projectId, kind: 'system', cycleId: cycle.id,
                  body: `Heads-up — ${parity.missing.length} action${parity.missing.length === 1 ? '' : 's'} from the approved design ${parity.missing.length === 1 ? 'is' : 'are'} still not in the app after this build: ${parity.missing.slice(0, 8).map((a) => `"${a.label}"`).join(', ')}. Send a build to add them (or ask for them to be badged "Not built yet").`,
                });
              } catch (e) { console.warn('[mock2] parity warning message failed:', e?.message); }
            } else if (parity.present.length) {
              logEvent('note', { role: 'system', content: `Action parity: all ${parity.present.length} inventory mutation actions surfaced in the UI source.` });
            }
          }
        } catch (e) { console.warn('[mock2] action-parity gate failed open:', e?.message); }
      }
      // Stamp the machine-readable acceptance state (migration 517) so "gates
      // green" and "acceptance demonstrated" are distinguishable in the record —
      // including the verified no-op flag (the loop-termination signal) and the
      // reproduce-first basis (demonstrated / not-required-empty-diff / waived).
      // STALE-SPEC GUARD (project 33): state/acceptance.json persists in the
      // working tree, so a spec left by an earlier cycle (a bugfix) rode into
      // six unrelated screen builds, mis-kinded them 'bugfix', and put the
      // anomaly tripwire into a false-positive storm (every deploy held). A
      // spec this cycle did not write never feeds the record/tripwire kind —
      // the instruction classification does.
      const accSpecCurrent = accParsed.ok && changedThisCycle.includes(ACCEPTANCE_PATH);
      const accState = acceptanceRecord({
        spec: accSpecCurrent ? accParsed.spec : null, instructionKind: taskKind, redTestObserved,
        uiRequired: accSpecCurrent ? accParsed.spec.ui : [],
        changedFiles: changedThisCycle, reproduceFirst: verdict.reproduce_first,
      });
      try { updateCycle(cycle.id, { acceptance_json: JSON.stringify(accState) }); } catch (e) { console.warn('[mock2] acceptance state write failed:', e?.message); }
      logEvent('note', { role: 'system', content: `Model requested finish: ${decision.finishSummary || ''}`, meta: { acceptance: accState } });
      // No battery in fast modes — skip both the run and the "Gate battery
      // (pending)" event noise; the deploy tail below is the verification.
      const battery = gateScripts.length ? await runGateBattery(cycle.id, containerName, gateScripts) : [];
      lastGateReports = battery;
      if (gateScripts.length) {
        logEvent('gate', { role: 'system', content: formatGateReports(battery), meta: { gates: battery, green: allGatesGreen(battery) } });
      }
      // A framework with zero gates (placeholder content, risk R8 — parseGateScripts
      // returns []) is vacuously green: there is nothing to fail, so finish is
      // accepted. Only reject finish when there ARE gates and one isn't green.
      if (gateScripts.length && !allGatesGreen(battery)) {
        // Not green — feed the finish call its verdict and keep working ("review,
        // not error"). The next model turn answers with fresh work — UNLESS the
        // breaker shows the cycle is just re-calling finish on the same red gates
        // with no new work, in which case halt (blocked) rather than loop.
        transcript.push({ role: 'tool', toolCallId: termId, name: termName, content: `Gates are not all green yet — you cannot finish. Battery:\n${formatGateReports(battery)}` });
        touchLock(projectId, holder);
        if (progress.tripped) {
          await haltCycle({ cycle: getCycle(cycle.id), project, containerName, holder, gateReports: battery, gateScripts, framework, trigger: progress.trigger, reason: `Auto-stopped after ${noProgLimit} turns with no progress (${haltReasonLabel(progress.trigger)}); gates still red.`, logEvent });
          return scheduleJobCleanup(cycle.id);
        }
        continue;
      }
      // INTEGRATION TRUTHFULNESS (AUDIT.md; B.3/B.4/B.5/B.7). Gates are green —
      // but every gate runs inside the fence and cannot see a simulated external
      // capability, which is exactly why the ADP2 fake shipped as "succeeded".
      // Before this cycle can reach a success terminal, analyze the produced
      // source for fabricated data / no-I/O tests / undeclared egress, and screen
      // the finish disclosures. A BLOCKING decision ends the cycle as a blocking
      // deviation (never "succeeded"); a clean decision whose in-scope manifest
      // integrations require live verification routes to pending-operator-
      // verification instead of succeeded. Fail-closed by construction: the
      // analyzer emits provenance_not_established rather than inferring success.
      let integrationDecision = null;
      try {
        const snapshot = await readSourceSnapshot({ containerName, appDir: APP_DIR, execInContainer, readFileInContainer });
        const declaredEgress = await readDeclaredEgress(containerName, APP_DIR).catch(() => []);
        const approvedGrants = listApprovedEgressGrants(projectId);
        // B.3: is the in-fence contract-fixture server present? If not, the gate
        // must say so (fixture_tooling_missing) rather than let a stub slip.
        const fixtureToolingPresent = snapshot.files.some((f) => CONTRACT_FIXTURE_PATH_RE.test(f.path));
        integrationDecision = evaluateIntegrationTruthfulness({
          files: snapshot.files, manifestText: snapshot.manifestText, declaredEgress, approvedGrants,
          finish: { summary: decision.finishSummary, acceptance: decision.finishAcceptance, assumptions: decision.finishAssumptions },
          changedFiles: changedThisCycle, fixtureToolingPresent,
        });
        // A suspected legacy stub recorded at migration time CROSSES into blocking
        // when this cycle touches its subsystem (or the framework has reconciled).
        const legacyBlocking = blockingLegacyFindings({
          projectId, touchedSubsystems: touchedSubsystemsOf(changedThisCycle),
          currentFrameworkVersionId: framework.id,
        });
        if (legacyBlocking.length && !integrationDecision.blocking) {
          integrationDecision.blocking = true;
          integrationDecision.outcome = 'blocked-deviation';
          for (const f of legacyBlocking) {
            integrationDecision.reasons.push(`[legacy:${f.kind}] ${f.subsystem || ''}: ${typeof f.detail === 'string' ? f.detail : (f.detail?.message || 'suspected legacy stub now in scope')}`);
          }
        }
        // Net the live-check checklist against the project's ACTIVE confirmations
        // (matching manifest hash): a capability the operator already verified
        // must not re-pend on every later cycle — that would be the empty-cycle
        // loop wearing a different hat. A manifest change invalidates the old
        // confirmation (hash mismatch), so a real change still re-opens the check.
        if (!integrationDecision.blocking && integrationDecision.checklist?.length) {
          try {
            const cap = capabilityCheckStatus({
              checklistItems: integrationDecision.checklist,
              activeVerifications: listActiveVerifications(projectId),
            });
            integrationDecision.checklist = cap.outstanding.map(({ stale_verification, ...it }) => it);
            if (!integrationDecision.checklist.length && integrationDecision.outcome === 'pending-operator-verification') {
              integrationDecision.outcome = 'succeeded';
            }
          } catch (e) { console.warn('[mock2] checklist netting failed:', e?.message); }
        }
        recordIntegrationGate(cycle.id, integrationDecision);
        logEvent('integration_gate', { role: 'system', content: integrationDecision.outcome, meta: { verdict: integrationDecision.gate.verdict, egress_ok: integrationDecision.egress.ok, screening_blocking: integrationDecision.screening.blocking, legacy_blocking: legacyBlocking.length, reasons: integrationDecision.reasons } });
      } catch (e) {
        // Fail closed on an analysis error too: a crash must not read as clean.
        console.warn('[mock2] integration gate crashed:', e?.message);
        integrationDecision = { blocking: true, outcome: 'blocked-deviation', reasons: [`integration gate could not run: ${e?.message || e}`], gate: { verdict: 'fail' }, egress: { ok: false }, screening: { blocking: false }, checklist: [] };
      }
      // integration_gate_mode operator switch (settings.js / accept-pending-logic).
      // DEFAULT 'enforce' leaves a blocking decision untouched → it halts below,
      // exactly as before. 'pending' downgrades the block to pending-operator-
      // verification (the build deploys; live checks are recorded); 'monitor'
      // records the findings but never blocks. The relaxation is logged and the
      // downgraded decision is re-stamped on the cycle, so it is auditable — never
      // a silent bypass. The gate is fully authoritative unless an admin opted out.
      if (integrationDecision.blocking) {
        const relax = applyIntegrationGateMode({
          decision: integrationDecision,
          mode: getIntegrationGateMode(),
          subsystems: integrationDecision.touched_subsystems || touchedSubsystemsOf(changedThisCycle),
        });
        if (relax.downgraded) {
          integrationDecision = relax.decision;
          recordIntegrationGate(cycle.id, integrationDecision);
          logEvent('integration_gate', {
            role: 'system',
            content: `relaxed:${relax.mode}`,
            meta: { mode: relax.mode, would_block: true, outcome: integrationDecision.outcome, reasons: relax.wouldBlockReasons },
          });
        }
      }
      // integration_gate_mode 'off' additionally disables the live-verification
      // hand-off: a non-blocking decision that would land this cycle in
      // pending-operator-verification (a credential-gated live checklist, or a
      // builder-declared pending outcome) completes as a plain success instead.
      // The skipped checks are recorded on the gate record (skipped_checklist)
      // and in the event log — disabled, never hidden.
      if (!integrationDecision.blocking) {
        const strip = applyLiveCheckMode({ decision: integrationDecision, mode: getIntegrationGateMode() });
        if (strip.skipped.length || strip.decision !== integrationDecision) {
          integrationDecision = strip.decision;
          recordIntegrationGate(cycle.id, integrationDecision);
          logEvent('integration_gate', {
            role: 'system',
            content: 'live-checks-disabled:off',
            meta: { mode: 'off', skipped_checklist: strip.skipped.map((c) => c.item_id), outcome: integrationDecision.outcome },
          });
        }
      }
      if (integrationDecision.blocking) {
        try {
          recordIntegrationFindings({
            projectId, cycleId: cycle.id, origin: 'integration_gate', frameworkVersionId: framework.id,
            sourceRef: `cycle:${cycle.id}`,
            findings: [
              ...(integrationDecision.gate?.findings || []).map((f) => ({ ...f, blocking: true, detail: f.message })),
              ...(integrationDecision.egress?.findings || []).map((f) => ({ kind: f.kind, subsystem: null, detail: f.message, severity: 'high', blocking: true })),
              ...(integrationDecision.screening?.candidates || []).map((c) => ({ kind: `disclosure_${c.tier}`, detail: `${c.source}: ${c.excerpt}`, severity: c.tier === 'high' ? 'critical' : 'high', blocking: true })),
            ],
          });
        } catch (e) { console.warn('[mock2] integration findings persist failed:', e?.message); }
        // B.4 loop breaker: compare THIS block's finding set against the earlier
        // blocked cycles of the same request. If the same set has now survived
        // N=2 consecutive resolutions, blockingSummary marks it resolution-
        // ineffective — the deadlock is surfaced AS a deadlock (full findings
        // inline, options suppressed, free-text/admin required).
        let priorSignatures = [];
        try { priorSignatures = priorBlockedSignatures(cycle.request_id, cycle.id); } catch { priorSignatures = []; }
        const bs = blockingSummary(integrationDecision, { priorSignatures });
        const trigger = bs.state === 'resolution-ineffective'
          ? 'resolution_ineffective'
          : (haltReasonForDecision(integrationDecision) || 'integration_gate');
        const findingLines = (bs.findings || integrationDecision.reasons || []);
        transcript.push({ role: 'tool', toolCallId: termId, name: termName, content: `Cannot finish — ${bs.reason}\n${findingLines.map((r) => `- ${r}`).join('\n')}${bs.requires_resolution ? `\n\n${bs.requires_resolution}` : ''}` });
        await haltCycle({
          cycle: getCycle(cycle.id), project, containerName, holder, gateReports: battery, gateScripts, framework,
          trigger, reason: bs.reason, options: bs.options, logEvent,
        });
        void notifyCycleComplete({ project: { id: projectId, name: project.name }, cycle: getCycle(cycle.id), outcome: 'blocked' });
        return scheduleJobCleanup(cycle.id);
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
      // A verified NO-OP cycle (no code change) advances straight to its
      // terminal — but ONLY when the live app is actually serving current
      // HEAD. "This segment's diff is empty" is not proof of that: paused/
      // resumed segments checkpoint work without deploying, the builder can
      // commit mid-cycle, and a silent git failure reads as an empty diff.
      // Each of those stranded committed code behind a "succeeded" cycle
      // until the operator pressed Redeploy (user report). deployed_commit
      // (migration 542) is stamped by every successful deploy; no stamp or
      // a mismatch means deploy runs.
      let appCurrent = false;
      try {
        const hs = await execInContainer(containerName, `git rev-parse HEAD 2>/dev/null`);
        const headSha = String(hs.stdout || '').trim().split('\n').pop().trim();
        const deployedSha = getProject(projectId)?.deployed_commit || null;
        appCurrent = /^[0-9a-f]{40}$/.test(headSha) && !!deployedSha && deployedSha === headSha;
      } catch { appCurrent = false; }
      const noOpCycle = codeChanged.length === 0 && appCurrent;
      // ANOMALY TRIPWIRE — BEFORE deploy (ratchet 6; it used to fire as a
      // post-deploy note, i.e. after the under-verified change was live).
      // A bug-fix that closed at a fraction of its estimate with no red
      // test and no test file touched now HOLDS the deploy: the cycle
      // still succeeds (work + record kept, gates already green), the flag
      // is raised for review, and the operator releases it with the
      // existing Deploy action once satisfied. Conservative option: hold,
      // never auto-rollback; the previous deploy keeps serving.
      let anomalyHold = null;
      try {
        const preAnomaly = anomalySignals({ kind: accState.kind, usedTokens: usedTokensThisRun, estTokens: cycle.est_tokens, changedFiles: changedThisCycle, redTestObserved });
        // NEVER hold a project's FIRST deploy. Holding assumes "the previous
        // deploy keeps serving" — but before the first one there is no previous
        // deploy, so the hold leaves the project with NOTHING serving. That is
        // exactly what happened: the initial build was misclassified as a bug
        // fix (the word "cannot" in ProxyPilot's own brief), the tripwire held
        // the deploy, and the app was unreachable until the operator pressed
        // Deploy by hand. The flag is still raised for review either way.
        let everDeployed = true;
        try { everDeployed = projectHasBeenDeployed(projectId); } catch { everDeployed = true; }
        if (preAnomaly.flag && !noOpCycle) {
          if (everDeployed) anomalyHold = preAnomaly;
          else {
            logEvent('note', {
              role: 'system',
              content: `Anomaly tripwire raised (${preAnomaly.reasons.join('; ')}) but NOT holding: this is the project's first deploy, and holding it would leave nothing serving.`,
              meta: { anomaly: preAnomaly.reasons, held: false, reason: 'first_deploy' },
            });
          }
        }
      } catch { /* tripwire must not break the finish path */ }
      if (anomalyHold) {
        const detail = `${project.name}: cycle ${cycle.id} looks under-verified — ${anomalyHold.reasons.join('; ')}. Deploy is HELD: review the change record, then press Deploy to release it.`;
        safeRaise({ kind: 'flag', project_id: projectId, dedupe_key: `mock2-anomaly-hold:${cycle.id}`, ref_table: 'mock2_cycles', ref_id: cycle.id, detail });
        logEvent('note', { role: 'system', content: `Anomaly tripwire — deploy HELD for human review (was: post-deploy note): ${anomalyHold.reasons.join('; ')}`, meta: { anomaly: anomalyHold.reasons, held: true } });
      }
      const deployed = noOpCycle
        ? { ok: true, skipped: true, noop: true }
        : anomalyHold
          ? { ok: true, skipped: true, held: true }
          : await deployStage({ cycle: getCycle(cycle.id), project, containerName, holder });
      if (!deployed.ok) {
        logEvent('deploy', { role: 'system', content: deployed.error || 'deploy failed', meta: { ok: false } });
        finishCycle(cycle.id, { status: 'failed', error: deployed.error });
        releaseLock(projectId, holder);
        setJob(cycle.id, { phase: 'deploy_failed', message: deployed.error, commit: record?.commit_sha || null });
        void notifyCycleComplete({ project: { id: projectId, name: project.name }, cycle: getCycle(cycle.id), outcome: 'deploy_failed' });
        return scheduleJobCleanup(cycle.id);
      }
      logEvent('deploy', {
        role: 'system',
        content: deployed.noop
          ? 'No code changes this cycle — the existing deploy keeps serving (nothing to redeploy).'
          : deployed.held
            ? 'Deploy HELD by the anomaly tripwire — review the change record, then press Deploy to release it; the previous deploy keeps serving.'
            : deployed.skipped
              ? 'No run contract — placeholder still serving (nothing to deploy).'
              : 'Deployed — app serving on its live URL.',
        meta: { ok: true, skipped: !!deployed.skipped, noop: !!deployed.noop, held: !!deployed.held, build_stamp: deployed.buildStamp || null },
      });
      // Client-cache staleness warning: the app serves, but its PWA build-id
      // plumbing says a browser could still be running pre-deploy assets. This
      // is the "I fixed it and nothing changed" trap — surface it on the build
      // that caused it rather than leaving it to be rediscovered by hand.
      if (deployed.buildStamp && deployed.buildStamp.stale_risk) {
        logEvent('note', {
          role: 'system',
          content: `Client-cache warning — ${deployed.buildStamp.detail}. Users may keep running the previous build until their service worker updates.`,
          meta: { stale_risk: true, build_stamp: deployed.buildStamp },
        });
      }

      // e2e/journey SMOKE GATE — runs against the now-deployed app. The cheap
      // HTTP/API layer always runs; the browser + read-only DB connectors are a
      // relevance-gated escalation (default OFF) that start ONLY when this change's
      // diff/metadata warrants them. A backend-only change invokes zero connectors.
      // Every run/skip + reason is logged. With the connectors off and http not
      // enforced (defaults), ok is always true → the success path is unchanged.
      let uiVerification = { needed: false, checklist: [] };
      if (!deployed.skipped) {
        // Make sure there is an account for the checks to run AS, before they
        // run. Without it they go anonymous, get bounced to /login, and time
        // out on elements that only exist behind the gate — three checks, three
        // timeouts, one red build (project 40).
        let reviewLogin = null;
        let viewerLogin = null;
        try {
          const { ensureReviewAccount } = await import('./review-account.js');
          const acct = await ensureReviewAccount(project);
          reviewLogin = acct?.login || null;
          // The unprivileged fixture, when the project has a role to give it.
          // Null when it does not — a "viewer" that fell back to admin would
          // make every permission check pass and prove nothing.
          viewerLogin = acct?.viewerLogin || null;
        } catch (e) { console.warn('[mock2] pre-smoke review account failed:', e?.message); }
        const smoke = await smokeAfterDeploy({ containerName, appDir: APP_DIR, webPort: project.web_port || 3000, commitSha: record?.commit_sha, summary: decision.finishSummary, instruction: cycle.instruction, requiredIds: decision.finishAcceptanceIds || [], logEvent, env: process.env, reviewLogin, viewerLogin });
        // A malformed TEST FILE is not a broken app. Project 38 deployed
        // successfully, served correctly, and the cycle went red because
        // state/ui-checks.json used a different (equally valid, more
        // conventional) step spelling — throwing away a working deploy and
        // making the operator press "Continue build". The parser now accepts
        // both spellings; this is the backstop for the next spelling nobody
        // anticipated. The app stays live, the problem is stated loudly, and
        // the build completes as PENDING VERIFICATION — never as a silent pass.
        if (!smoke.ok && smoke.specInvalid) {
          const detail = smokeFailSummary(smoke.report);
          logEvent('note', {
            role: 'system',
            content: `The app deployed and is serving, but its browser checks could not run: ${detail}. `
              + 'That is a defect in state/ui-checks.json, not in the app — the deploy is kept and this build '
              + 'completes as pending verification. Fix the check file in the next update.',
            meta: { smoke_spec_invalid: true },
          });
          try {
            insertMessage({
              projectId,
              kind: 'system',
              body: `**The app is live, but its automated browser checks did not run.**\n\n${detail}\n\n`
                + 'This is a problem with `state/ui-checks.json` (the check file), not with the app — so the deploy '
                + 'was kept rather than thrown away. Please confirm the change by hand, and ask for the check file '
                + 'to be fixed in the next update.',
            });
          } catch { /* best effort */ }
        } else if (!smoke.ok) {
          const detail = smokeFailSummary(smoke.report);
          // ASK THE APP WHETHER IT IS EVEN REACHABLE, before reporting a wall of
          // failed checks.
          //
          // The readiness probe — health 200, the sign-in page RENDERS, the
          // stylesheet is served, one signed-in request comes back — hung off
          // afterBuildReview, which fires only when a request closes SUCCEEDED
          // or lands in pending verification. So on a FAILED build, the one
          // check that answers "can anyone get in at all" never ran. That is
          // exactly backwards: a failed build is when the app is most likely to
          // be dead.
          //
          // Project 43: a feature router mounted above the sign-in route made
          // every path answer 401. What the operator saw was "3 console
          // error(s)" and "Timeout 5000ms exceeded", three resumed cycles and
          // $9.81 — never "nobody can get into the app", which is what this
          // says in one line. Best-effort and never blocking; the cycle fails
          // either way, this only decides what it fails SAYING.
          let readyLine = '';
          try {
            const { verifyAppReady } = await import('./readiness.js');
            const { readinessChatMessage } = await import('./readiness-logic.js');
            const ready = await verifyAppReady(project, { authed: reviewLogin });
            if (ready && !ready.ready) {
              readyLine = ready.summary || (ready.failures || []).join('; ');
              const msg = readinessChatMessage(ready);
              if (msg) { try { insertMessage({ projectId, kind: 'system', cycleId: cycle.id, body: msg }); } catch { /* best effort */ } }
              logEvent('note', { role: 'system', content: `Readiness after the failed smoke gate: ${readyLine}`, meta: { readiness_failed: true } });
            }
          } catch (e) { console.warn('[mock2] post-smoke readiness check failed:', e?.message); }
          // The readiness line goes FIRST when it fired: it is the cause, and
          // the check failures below it are the symptoms.
          const error = readyLine
            ? `The deployed app is not reachable — ${readyLine}. Downstream: ${detail}`
            : `Smoke gate failed after deploy — ${detail}`;
          finishCycle(cycle.id, { status: 'failed', error });
          releaseLock(projectId, holder);
          setJob(cycle.id, { phase: 'smoke_failed', message: error, commit: record?.commit_sha || null });
          void notifyCycleComplete({ project: { id: projectId, name: project.name }, cycle: getCycle(cycle.id), outcome: 'smoke_failed' });
          return scheduleJobCleanup(cycle.id);
        }
        // THE HONEST GATE. The smoke gate passing is not the same as "someone
        // saw it work": a user-visible change that no browser check observed is
        // an UNVERIFIED claim, and reporting it as a plain success is how a
        // build can say "done" for something the operator cannot even see (the
        // stale-cache incident). Route it to pending_verification with the
        // human check instead — the deploy still happens, nothing is blocked.
        try {
          uiVerification = needsOperatorUiVerification({
            changedFiles: changedThisCycle,
            report: smoke.report,
            acceptance: decision.finishAcceptance || [],
            config: smokeConfigFromEnv(process.env),
          });
          // A check file that could not be parsed means NOTHING was observed in
          // a browser, whatever the diff touched. That is the definition of an
          // unverified user-visible change, so it always routes to pending
          // verification rather than reporting a plain success.
          if (smoke.specInvalid) {
            uiVerification = {
              needed: true,
              reason: 'the browser checks could not run — state/ui-checks.json did not parse',
              checklist: [
                ...(uiVerification.checklist || []),
                'Open the app and confirm this change by hand — no browser check observed it.',
              ],
            };
          }
          if (uiVerification.needed) {
            logEvent('note', {
              role: 'system',
              content: `Honest completion — ${uiVerification.reason}; this change is user-visible, so it completes as pending verification with ${uiVerification.checklist.length} check(s) for you to confirm.`,
              meta: { ui_verification: true, reason: uiVerification.reason },
            });
          }
        } catch (e) { console.warn('[mock2] ui-verification gate skipped:', e?.message); }
      }
      // B.5/PATCH2 B.1 lifecycle branch. The integration gate passed (real code),
      // so a build with outstanding LIVE external checks the fence cannot run is a
      // CALM completion, not a block. It reaches here two ways:
      //   - the builder returned `pending_verification` directly (the first-class
      //     terminal move), OR
      //   - the builder called `finish` and this cycle's integrations still carry
      //     in-scope live checks (the existing auto-route).
      // Either way the deploy is allowed (the operator needs the running app to
      // verify) and the cycle lands in pending-operator-verification with the live
      // checklist — NEVER as a needs-attention flag. If the builder declared
      // pending but nothing is actually outstanding, it is simply a success.
      // The live-external checklist, plus any user-visible change nothing
      // observed in a browser (the honest gate above). Both are "a human still
      // has to confirm this", so they share one calm pending-verification path.
      const pendingChecklist = [...(integrationDecision?.checklist || []), ...(uiVerification.checklist || [])];
      const wantsPending = decision.pendingVerification === true;
      if (pendingChecklist.length) {
        openVerificationChecklist({ projectId, cycleId: cycle.id, checklist: pendingChecklist });
        updateCycle(cycle.id, { verification_state: 'pending' });
        // Stored status 'awaiting_user' + verification_state 'pending' → the
        // reported outcome is 'pending-operator-verification' (verification-logic).
        finishCycle(cycle.id, { status: 'awaiting_user', error: null });
        releaseLock(projectId, holder);
        updateProject(projectId, { last_activity_at: nowIso() });
        logEvent('pending_verification', { role: 'system', content: `Built and verified in-fence; ${pendingChecklist.length} live external check(s) remain before production sign-off.`, meta: { checklist: pendingChecklist, builder_declared: wantsPending } });
        setJob(cycle.id, {
          phase: 'pending_verification',
          // Calm completion copy (B.1) — this is not "Blocked / needs attention".
          message: `Built and verified in-fence — ${pendingChecklist.length} live check${pendingChecklist.length === 1 ? '' : 's'} remain before production sign-off. Confirm each against the real system when you have credentials.`,
          commit: record?.commit_sha || null,
        });
        // NOTE: no admin-attention `flag` is raised — pending-operator-verification
        // is ambient capability status (Run-stage badge + status endpoint), NOT a
        // blocker. It is surfaced through verification_state, not the `!` overlay.
        // The review summary in the build chat: what was done, which files, and
        // the live checks left. Best-effort — a chat write must not fail the cycle.
        try {
          insertMessage({
            projectId, kind: 'assistant', cycleId: cycle.id,
            body: buildCompletionSummaryBody({ summary: decision.finishSummary, changedFiles: changedThisCycle, deployed, pendingChecklist }),
          });
        } catch (e) { console.warn('[mock2] completion summary message failed:', e?.message); }
        void notifyCycleComplete({ project: { id: projectId, name: project.name }, cycle: getCycle(cycle.id), outcome: 'pending_verification' });
        // REVIEW IT ANYWAY.
        //
        // A pending-verification build has DEPLOYED — it is waiting on a human
        // to confirm live checks, not on anything technical. But it never
        // closes its request, and the whole post-build chain (serving check,
        // reviewer account, design review) used to hang off a request closing
        // as 'succeeded'. So the builds most in need of a second pair of eyes
        // were exactly the ones that got none: project 39 shipped an app that
        // looked nothing like its mockup and was never reviewed. Worse, the
        // smoke-spec backstop routes MORE builds down this path by design.
        // Fire-and-forget, same chain, same in-flight guard.
        void import('./design-review.js')
          .then((m) => m.afterBuildReview(projectId, { reason: 'pending verification' }))
          .catch((e) => console.warn('[mock2] post-build review (pending) failed:', e?.message));
        recordAssetsSeen();
        return scheduleJobCleanup(cycle.id);
      }
      // The builder declared pending but no live check is actually outstanding —
      // that is a plain success (nothing to verify), reported calmly.
      if (wantsPending) {
        logEvent('note', { role: 'system', content: 'pending_verification requested, but no live external checks are outstanding — recording as succeeded.' });
      }
      finishCycle(cycle.id, { status: 'succeeded' });
      recordAssetsSeen();
      try { const rc = getCycle(cycle.id); if (rc?.request_id) closeRequest(rc.request_id, 'succeeded'); } catch { /* best effort */ }
      // The review summary in the build chat: what was done and which files —
      // so the requester can review without opening the change history.
      // Best-effort — a chat write must not fail the cycle.
      try {
        insertMessage({
          projectId, kind: 'assistant', cycleId: cycle.id,
          body: buildCompletionSummaryBody({ summary: decision.finishSummary, changedFiles: changedThisCycle, deployed }),
        });
      } catch (e) { console.warn('[mock2] completion summary message failed:', e?.message); }
      // Anomaly tripwire (heuristic, never blocks): a bug-fix that closed at a
      // small fraction of its estimate with no reproduced red test / no test
      // touched is a Goodhart signature — flag it for a human, loudly.
      try {
        const commitFiles = record?.commit_sha ? await changedFilesForCommit(containerName, APP_DIR, record.commit_sha) : [];
        // Use the RECORDED kind (accState) — a verified empty-diff cycle resolved
        // to the spec's chore/feature kind, so a legitimate no-op is not nagged as
        // an under-verified bug fix on every run.
        const anomaly = anomalySignals({ kind: accState.kind, usedTokens: usedTokensThisRun, estTokens: cycle.est_tokens, changedFiles: commitFiles, redTestObserved });
        if (anomaly.flag && !anomalyHold) {
          const detail = `${project.name}: cycle ${cycle.id} succeeded but looks under-verified — ${anomaly.reasons.join('; ')}. Review the change record and the live behavior.`;
          safeRaise({ kind: 'flag', project_id: projectId, dedupe_key: `mock2-anomaly:${cycle.id}`, ref_table: 'mock2_cycles', ref_id: cycle.id, detail });
          logEvent('note', { role: 'system', content: `Anomaly tripwire raised for human review: ${anomaly.reasons.join('; ')}`, meta: { anomaly: anomaly.reasons } });
        }
      } catch (e) { console.warn('[mock2] anomaly tripwire failed:', e?.message); }
      releaseLock(projectId, holder);
      updateProject(projectId, { last_activity_at: nowIso() });
      setJob(cycle.id, {
        phase: deployed.skipped ? 'succeeded' : 'serving',
        message: deployed.noop
          ? 'Nothing left to do — the work is already complete and verified; the existing deploy keeps serving.'
          : deployed.held
            ? 'Change complete but deploy HELD — the anomaly tripwire wants a human look (under-verified change). Review the change record, then press Deploy to release it; the previous deploy keeps serving.'
            : deployed.skipped
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
    //    Consecutive READ-ONLY calls (read_file/list_dir/search_workspace/…) run
    //    CONCURRENTLY — they only observe the tree, so results are identical to
    //    running them one at a time, but a batch of reads costs one container
    //    round-trip's latency instead of N. Everything that writes, shells out,
    //    runs gates, or ends the cycle stays strictly serial and in order, and
    //    results are appended in the model's original order either way.
    let ranGates = false;
    for (const group of groupToolCallsForExecution(decision.toolCalls)) {
      const outs = group.parallel && group.calls.length > 1
        ? await Promise.all(group.calls.map((call) => executeTool({ call, cycle, containerName, holder, gateScripts })))
        : [await executeTool({ call: group.calls[0], cycle, containerName, holder, gateScripts })];
      for (let i = 0; i < group.calls.length; i++) {
        const call = group.calls[i];
        const out = outs[i];
        lastGateReports = out.gateReports || lastGateReports;
        if (out.gateReports) redTestObserved = redTestObserved || batteryHasRedTestGate(out.gateReports);
        if (call.name === 'run_gates') ranGates = true;
        transcript.push({ role: 'tool', toolCallId: call.id, name: call.name, content: truncateToolResult(out.content) });
        logEvent('tool_result', { role: 'tool', content: out.content, meta: { name: call.name } });
      }
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
      if (!r.ok) return { content: `error: ${r.error}` };
      // Optional line-range slicing (copilot harness read_file). No range params
      // → the whole file, byte-identical to the proxypilot harness behavior.
      return { content: sliceFileForRead(r.content, call.input?.start_line, call.input?.end_line) };
    }
    case 'search_workspace': {
      const r = await searchWorkspaceInContainer(containerName, call.input || {});
      return { content: r };
    }
    case 'list_dir': {
      const r = await listDirInContainer(containerName, String(call.input?.path || '.'), call.input?.recursive === true);
      return { content: r };
    }
    case 'create_file': {
      const relPath = String(call.input?.path || '');
      const rel = safeRel(relPath);
      if (!rel) return { content: 'error: path must be relative and inside the app dir' };
      const exists = await containerSh(containerName, `p=$(printf '%s' '${b64(rel)}' | base64 -d); [ -e "${APP_DIR}/$p" ] && echo EXISTS || echo NEW`);
      if (String(exists.stdout || '').includes('EXISTS')) {
        return { content: `error: FILE_EXISTS — "${relPath}" already exists. Use apply_edit to modify it.` };
      }
      const w = await writeFileInContainer(containerName, relPath, String(call.input?.content ?? ''));
      touchLock(cycle.project_id, holder);
      return { content: w.ok ? `created ${relPath}` : `error: ${w.error}` };
    }
    case 'run_terminal': {
      const command = String(call.input?.command || '');
      const policy = commandAllowed(command);
      if (!policy.ok) return { content: `DENIED: ${policy.reason}` };
      const r = await execInContainer(containerName, command);
      touchLock(cycle.project_id, holder);
      return { content: redactSecrets(`exit ${r.code}\n${r.stdout || ''}${r.stderr ? `\n[stderr]\n${r.stderr}` : ''}`) };
    }
    case 'get_diagnostics': {
      const r = await getDiagnosticsInContainer(containerName, call.input?.path ? String(call.input.path) : null);
      return { content: r };
    }
    case 'write_file': {
      const r = await writeFileInContainer(containerName, String(call.input?.path || ''), String(call.input?.content ?? ''));
      touchLock(cycle.project_id, holder);
      return { content: r.ok ? `wrote ${call.input?.path}` : `error: ${r.error}` };
    }
    case 'apply_edit': {
      // Anchored targeted edit of an EXISTING file. Read → applyEdits (pure,
      // byte-exact, all-or-nothing) → write back only on ok. A failed read is
      // surfaced as FILE_NOT_FOUND so the model reads/creates the file instead
      // of retrying a mismatch; every other failure is the pure contract's
      // structured error the model self-corrects from.
      const relPath = String(call.input?.path || '');
      const edits = Array.isArray(call.input?.edits) ? call.input.edits : [];
      const read = await readFileInContainer(containerName, relPath);
      if (!read.ok) {
        return { content: `error: FILE_NOT_FOUND — could not read "${relPath}" (${read.error}). Use write_file to create a new file, or read_file to confirm the path.` };
      }
      const res = applyEdits(read.content, edits, { path: relPath });
      if (!res.ok) {
        const e = res.error || {};
        const extra = e.code === 'AMBIGUOUS_MATCH' ? ` (count: ${e.count})`
          : e.code === 'NO_MATCH' && e.nearest ? `\nnearest lines:\n${e.nearest}` : '';
        return { content: `error: ${e.code} — ${e.message}${extra}` };
      }
      const w = await writeFileInContainer(containerName, relPath, res.content);
      touchLock(cycle.project_id, holder);
      if (!w.ok) return { content: `error: applied ${res.applied} edit(s) in memory but the write failed: ${w.error}` };
      return { content: `applied ${res.applied} edit(s) to ${relPath}\n${res.diff}` };
    }
    case 'get_component': {
      // Library lookup is DB-only (no container access) and limited to the
      // PUBLISHED catalog — the same set the system prompt advertised.
      const key = String(call.input?.key || '').trim();
      const found = getPublishedComponentWithVersion(key);
      if (!found) return { content: `error: no published component with key "${key.slice(0, 80)}" — the available keys are listed in your system prompt` };
      return { content: formatComponentForModel(found.component, found.version) };
    }
    case 'materialize_component': {
      // Server-side adopt: the platform writes the component's files INTO the
      // app source over the same channel write_file uses — the contents never
      // transit the model context, so the prompt/tool-result budgets put no
      // ceiling on component size (the 600k import ceiling is the only limit).
      // Byte-exactness is verified in-container (sha256sum vs the stored
      // content's hash); the result carries paths/sizes/hashes, never contents.
      const key = String(call.input?.key || '').trim();
      const overwrite = call.input?.overwrite === true;
      const found = getPublishedComponentWithVersion(key);
      if (!found) return { content: `error: no published component with key "${key.slice(0, 80)}" — the available keys are listed in your system prompt` };
      const files = parseFilesJson(found.version.files_json)
        .map((f) => ({ path: safeComponentPath(f.path), content: f.content }))
        .filter((f) => f.path);
      if (!files.length) return { content: `error: component "${key}" has no files to materialize` };
      const manifest = buildComponentManifest(files);

      // 1) Existing target paths are KEPT (reported, not clobbered) unless
      //    overwrite — a second adopt must never wipe already-adapted files.
      let existing = new Set();
      if (!overwrite) {
        const ex = await containerSh(containerName, buildPathsExistScript(files.map((f) => f.path), { appDir: APP_DIR }), { timeoutMs: 60000 });
        existing = parsePathsExistOutput(ex.stdout);
      }

      // 2) Write server-side, one proven base64 round-trip per file.
      const statuses = {};
      for (const f of files) {
        if (existing.has(f.path)) { statuses[f.path] = 'kept'; continue; }
        const w = await writeFileInContainer(containerName, f.path, f.content);
        statuses[f.path] = w.ok ? 'written' : 'write failed';
      }
      touchLock(cycle.project_id, holder);

      // 3) Verify every written file landed byte-exact.
      const written = files.filter((f) => statuses[f.path] === 'written').map((f) => f.path);
      if (written.length) {
        const v = await containerSh(containerName, buildManifestVerifyScript(written, { appDir: APP_DIR }), { timeoutMs: 120000 });
        const shas = parseShaVerifyOutput(v.stdout);
        for (const m of manifest) {
          if (statuses[m.path] === 'written' && shas.get(m.path) !== m.sha256) statuses[m.path] = 'verify failed';
        }
      }

      // Audit trail: which component+version landed in which project — counts
      // and hashes only, never file contents.
      try {
        const tally = (s) => Object.values(statuses).filter((x) => x === s).length;
        logAudit(cycle.initiated_by, 'MOCK2_COMPONENT_MATERIALIZE', 'mock2_component', found.component.id, {
          project_id: cycle.project_id, cycle_id: cycle.id,
          key: found.component.key, version: found.version.version,
          files: manifest.length, written: tally('written'), kept: tally('kept'),
          failed: manifest.length - tally('written') - tally('kept'), overwrite,
        }, null);
      } catch (e) { console.warn('[mock2] materialize audit log failed:', e?.message); }

      return { content: formatMaterializeResult({ component: found.component, version: found.version, manifest, statuses }) };
    }
    case 'run_gates': {
      // Fast modes have no battery and no run_gates tool — but belt-and-braces
      // for a model that calls it anyway (or an SDK path): answer plainly
      // instead of returning an empty "pending" battery it can loop on.
      if (!gateScripts.length) {
        return { content: 'This build mode runs NO gate battery — there is nothing to run. Verify your change yourself and call finish when it is complete and working; the deploy build + health check are the platform backstop.' };
      }
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
  return { code: r.code, stdout: (r.stdout || '').slice(0, MAX_TOOL_RESULT_CHARS), stderr: (r.stderr || '').slice(0, 20000) };
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

export async function writeFileInContainer(containerName, path, content) {
  const rel = safeRel(path);
  if (!rel) return { ok: false, error: 'path must be relative and inside the app dir' };
  // Payload over STDIN, script b64 in argv (shell-safe charset — the
  // model-supplied path stays b64-wrapped inside it): embedding content in
  // the command string hits Linux's 128KiB argv-entry cap (spawn E2BIG)
  // once a file grows past ~96KB.
  const script = `p=$(printf '%s' '${b64(rel)}' | base64 -d); d="${APP_DIR}/$p"; mkdir -p "$(dirname "$d")"; base64 -d > "$d" && echo ok`;
  const r = await sh(`incus exec ${containerName} -- sh -c 'eval "$(printf %s ${b64(script)} | base64 -d)"'`, { timeoutMs: 120000, input: b64(content) });
  if (r.code !== 0) return { ok: false, error: (r.stderr || 'write failed').trim().slice(-300) };
  return { ok: true };
}

// ---- copilot-harness tool executors (fenced-container I/O) ----

// read_file range slicing. Pure formatting lives in harness-copilot; this only
// forwards the model's optional start/end. No range → whole file, byte-identical
// to the proxypilot harness read_file.
function sliceFileForRead(content, startLine, endLine) {
  const hasRange = startLine != null || endLine != null;
  if (!hasRange) return content;
  return formatReadRange(content, startLine, endLine);
}

// search_workspace: ranked keyword/regex search over the working tree. ripgrep
// when present (respects .gitignore), else a grep fallback that skips the usual
// build/vendor dirs. The model-supplied query and glob are base64-decoded INSIDE
// the script (never interpolated raw) so they can't break out of the command.
async function searchWorkspaceInContainer(containerName, input = {}) {
  const query = String(input.query || '');
  if (!query.trim()) return 'error: query is required';
  const cap = Math.min(Math.max(Number(input.max_results) || 20, 1), 200);
  const glob = String(input.path_glob || '');
  const globArg = glob ? `--glob "$(printf '%s' '${b64(glob)}' | base64 -d)"` : '';
  const script = [
    `cd '${APP_DIR}' 2>/dev/null || exit 3`,
    `q=$(printf '%s' '${b64(query)}' | base64 -d)`,
    `if command -v rg >/dev/null 2>&1; then`,
    `  rg --line-number --no-heading --color never -m ${cap} ${globArg} -e "$q" 2>/dev/null`,
    `else`,
    `  grep -rIn --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist --exclude-dir=build -e "$q" . 2>/dev/null | head -n ${cap}`,
    `fi`,
  ].join('\n');
  const r = await containerSh(containerName, script, { timeoutMs: 30000 });
  return formatSearchResults(r.stdout || '', { cap });
}

// list_dir: one level by default, or the whole subtree (bounded) when recursive.
async function listDirInContainer(containerName, path, recursive) {
  const rel = safeRel(path === '.' ? '.' : path) ?? (path === '.' ? '.' : null);
  if (rel == null) return 'error: path must be relative and inside the app dir';
  const script = recursive
    ? `p=$(printf '%s' '${b64(rel)}' | base64 -d); cd '${APP_DIR}' 2>/dev/null || exit 3; find "$p" -not -path '*/node_modules/*' -not -path '*/.git/*' 2>/dev/null | head -n 500`
    : `p=$(printf '%s' '${b64(rel)}' | base64 -d); cd '${APP_DIR}' 2>/dev/null || exit 3; ls -1Ap "$p" 2>/dev/null`;
  const r = await containerSh(containerName, script, { timeoutMs: 30000 });
  if (r.code !== 0) return `NOT_A_DIRECTORY: ${String(path)}`;
  return (r.stdout || '').trim() || '(empty)';
}

// get_diagnostics: a scoped TypeScript typecheck of the working tree (the
// standard scaffold is TS/Express). "clean" on exit 0, else the tail of the
// compiler output. The optional path is advisory — tsc typechecks the project.
async function getDiagnosticsInContainer(containerName, path) {
  const note = path ? ` (scoped hint: ${String(path).slice(0, 120)})` : '';
  const r = await execInContainer(containerName, 'npx --no-install tsc --noEmit 2>&1 || npx tsc --noEmit 2>&1');
  const out = `${r.stdout || ''}${r.stderr ? `\n${r.stderr}` : ''}`.trim();
  if (r.code === 0) return `clean: no type errors${note}`;
  return `type errors${note}:\n${out.slice(-8000)}`;
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
    // A gate that exits 0 while saying it did not run is 'skipped'. Reporting
    // it as 'passed' is how a battery reads 8/8 green with a member that
    // executed nothing (project 42: e2e, no browser installed).
    reports[i].status = gateStatusFromOutput(exit, out);
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

  // 0) Snapshot the in-container Postgres (ADR-008) into the working clone so
  //    THIS checkpoint commit carries the database at this point in time —
  //    that's what makes a later restore bring the data back, not just the
  //    code. Best-effort: the script always exits 0 (no Postgres → skip).
  const dbSnap = await containerSh(containerName, buildDbSnapshotScript({ appDir: APP_DIR }), { timeoutMs: 120000 });
  if (dbSnap.code !== 0) {
    console.warn(`[mock2] db snapshot non-zero for cycle ${cycle.id}: ${(dbSnap.stdout || dbSnap.stderr || '').trim().slice(-300)}`);
  }

  // 1) Commit + push into the bare repo (over the ADR-011 mount).
  const commitScript = buildCheckpointScript({ appDir: APP_DIR, message: summary || 'checkpoint: mock2 cycle' });
  const cp = await containerSh(containerName, commitScript, { timeoutMs: 120000 });
  if (cp.code !== 0) {
    console.warn(`[mock2] checkpoint non-zero for cycle ${cycle.id}: ${(cp.stdout || cp.stderr || '').trim().slice(-300)}`);
  }
  // 2) Read the checkpoint commit sha.
  const sha = await execInContainer(containerName, `git -C ${APP_DIR} rev-parse HEAD 2>/dev/null`);
  const commitSha = (sha.stdout || '').trim().split('\n').pop() || null;

  // 2b) The commit's own diff --stat rides in the record (cycle-94 lesson: the
  //     record must be accountable to the diff — a reader sees exactly what THIS
  //     checkpoint changed, so a summary can't silently claim more).
  let diffStat = '';
  if (commitSha) {
    const stat = await execInContainer(containerName, `git -C ${APP_DIR} show --stat --format= ${commitSha} 2>/dev/null | tail -40`);
    diffStat = (stat.stdout || '').trim();
  }
  const recordSummaryText = `${summary || 'checkpoint'}${diffStat ? `\n\nDiff (this checkpoint):\n${diffStat}` : ''}`;

  // 3) Insert the hash-chained change record.
  const gatesRun = (gateReports || []).map((g) => ({ name: g.name, result: g.status }));
  let record = null;
  try {
    record = insertChangeRecord({
      projectId, cycleId: cycle.id, initiatedBy: cycle.initiated_by, actingAsAdmin: cycle.acting_as_admin,
      frameworkVersion: framework.version, frameworkVersionId: framework.id,
      gatesRun, commitSha, summary: recordSummaryText,
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

  // Sync the app's DECLARED egress (mock2.yaml `egress:`) into the grant store:
  // a newly declared host becomes a pending admin-queue item; a removed one is
  // revoked. Only already-approved grants are wired by the fence — a fresh
  // declaration stays blocked until an admin approves it. Best-effort; a parse/DB
  // hiccup never fails the deploy.
  try {
    const declared = await readDeclaredEgress(containerName, APP_DIR);
    const sync = syncDeclaredEgress(projectId, declared);
    // Probe host reachability for newly-declared grants so the admin sees whether
    // the HOST can even route to each destination before approving (acceptance #5).
    if (sync.added.length) await probeEgressGrants(sync.added).catch(() => {});
    // A newly ADDED grant is pending (nothing to wire yet — an admin approves it).
    // A REVOKED grant (removed from the declaration) must have its allow-hole
    // dropped now, so reconcile the fence when the wired set could have changed.
    if (sync.revoked.length) await reconcileMock2Firewall().catch(() => {});
  } catch (e) { console.warn('[mock2] egress sync (deploy) failed:', e?.message); }

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
  await stampDeployedCommit(projectId, containerName, APP_DIR);
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
  // Notify: this cycle is now WAITING ON A HUMAN and will sit there until one
  // acts. Every other terminal state already notifies; without this the operator
  // only discovers the handoff by opening the project, which is how a build ends
  // up idle for hours (measured: waiting on a human dominated elapsed time, not
  // model work). The bell row is deduped per project+cycle+outcome.
  void notifyCycleComplete({ project: { id: projectId, name: project.name }, cycle: getCycle(cycle.id), outcome: 'blocked' });
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
