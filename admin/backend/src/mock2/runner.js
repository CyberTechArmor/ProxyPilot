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
import { getSlot, getConnector, decryptConnectorKey, effectivePrice, listConnectors, isSecretDecryptable } from './connectors.js';
import { phaseRoutingApplies, detectPhaseProviders, applyProviderPreference, resolvePhaseModelMap, applyPhasePosture, phasePosture, phaseMapRecordLine, implementLaneForTask } from './phase-routing-logic.js';
import { contractClassifierMode, CONTRACT_CLASSIFIER_PROMPT, buildContractClassifierTask, parseContractClassifierReply, applyInventoryAdditions, contractAmendmentMessage, BUILD_PLAN_SYSTEM_PROMPT, buildPlanTask, formatPlanForTask } from './contract-classifier-logic.js';
import { resolveProjectKey } from './project-keys.js';
import { parseCapabilities, slotAssignmentError, isCloudProvider } from './connector-logic.js';
import { getApplicableQuota, periodUsage, insertLedgerEntry } from './quotas.js';
import { canStartCycle, costCentsForUsage } from './quota-logic.js';
import { getCurrentFrameworkVersion, getFrameworkVersion } from './framework.js';
import {
  insertCycle, getCycle, updateCycle, addCycleUsage, finishCycle, countRunningCycles,
  listCyclesForProject, listCyclesForRequest, projectHasBeenDeployed } from './cycles.js';
import {
  parseGateScripts, buildGateBattery, gatesForProfile, initialGateReports, gateBatteryVerdict, allGatesGreen,
  gateStatusFromOutput,
  interruptDecision, estimateCycleTokens, shouldStopForBudget, retriesExhausted, MAX_CYCLE_RETRIES,
  noopStartRefusal,
  normalizeBuildMode, isFastBuildMode, BUILD_MODE_FULL, BUILD_MODE_MVP, BUILD_MODE_QUICK,
  queueMayAdvancePast, touchesUserFacing, gateConfigTouchedFiles,
} from './cycle-logic.js';
import { getLock, acquireLock, releaseLock, touchLock } from './locks.js';
import { insertChangeRecord, changeRecordMirror, lastChangeRecord } from './change-records.js';
import { terminalRecordPlan } from './conclude-logic.js';
import { insertMessage } from './chats.js';
import { webSearchServerTools, RUNNER_WEB_SEARCH_FLAG } from './ask-logic.js';
import { getRoutingRule } from './routing.js';
import { applyLaneTuning } from './lane-tuning-logic.js';
import { decideRouting, escalationAttempts, routingMode, parseRoutingJson, mvpRoutingDecision, quickRoutingDecision } from './routing-logic.js';
import {
  prepassEnabled, prepassModelFor, buildPrepassPrompt, parsePrepassReply,
  prepassEffort, formatBriefForTask, formatSpecificityForTask, featureScaleNotice,
  normalizeSuggestMode,
  buildDistillSystemPrompt, buildDistillUserTurn, cleanDistilledInstruction,
} from './prepass-logic.js';
import { insertCycleEvent, listRecentDownNotes } from './cycle-events.js';
import { listAssets, readAssetText } from './project-assets.js';
import { buildAssetSection, diffAssetFingerprint, buildAssetChangeSection, docAssetPath } from './project-assets-logic.js';
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
import { consultAutoEnabled, consultTrigger, consultAllowed, reHaltSameReason } from './consult-logic.js';
import { raiseQueueItem, resolveQueueItem } from './queue.js';
import { getProjectRemote, pushProjectRemote } from './git-connectors.js';
import {
  RUNNER_TOOLS, runnerToolsForCycle, MAX_TURNS, MAX_TOOL_RESULT_CHARS, truncateToolResult, parseFrameworkSkills,
  RUNNER_CACHE_TTL, pruneStaleToolResults,
  groupToolCallsForExecution,
  buildRunnerSystemPrompt, buildRunnerTask, buildFeedbackSection, classifyTurn, describeRunnerStep, STALL_NUDGE, formatAcceptanceBlock,
  buildCompletionSummaryBody,
  softPauseReason, SOFT_PAUSE_TOKENS, SOFT_PAUSE_MS,
  CONTEXT_HANDOFF_MAX_CHAIN, continuationRun, buildContinuationInstruction,
  updateProgress, initProgressState, noProgressLimit, haltReasonLabel, haltSummaryWithLandedWork,
  readSetFromTranscript,
} from './runner-logic.js';
import { harnessForProject } from './harness.js';
import { applyEdits } from './apply-edit-logic.js';
import { commandAllowed, redactSecrets } from './harness-safety.js';
import { formatReadRange, formatSearchResults } from './harness-copilot.js';
import { callStepTurn, stepSystemPrompt } from './harness-steps.js';
import {
  failingAppChecks, diagnosisCandidateFiles, diagnosisEvidence, diagnosisChatMessage, DIAGNOSIS_SYSTEM_PROMPT,
} from './diagnose-logic.js';
import { listPublishedComponents, getPublishedComponentWithVersion, listProjectComponents } from './components.js';
import {
  formatComponentForModel, parseFilesJson, safeComponentPath, buildComponentManifest,
  buildPathsExistScript, parsePathsExistOutput, buildManifestVerifyScript, parseShaVerifyOutput,
  formatMaterializeResult, parseContractJson,
} from './component-logic.js';
import { logAudit } from '../db.js';
import {
  budgetMode, budgetPauseReasonCents, budgetCentsForTokenLegacy, dollars, USAGE_SCHEMA_VERSION,
  cacheHealth,
} from './usage-logic.js';
import { deployProject, readRunContract, readDeclaredEgress, stampDeployedCommit } from './deploy.js';
import { syncDeclaredEgress, probeEgressGrants } from './egress-grants.js';
import { reconcileMock2Firewall } from './firewall.js';
import { smokeAfterDeploy, smokeFailSummary, changedFilesForCommit, resolveBrowserTarget } from './smoke.js';
import { needsOperatorUiVerification, smokeConfigFromEnv } from './smoke-triggers.js';
import {
  ACCEPTANCE_PATH, classifyTaskKind, parseAcceptance, batteryHasRedTestGate,
  acceptanceVerdict, summaryOverclaims, verificationOnlyFinish, anomalySignals, acceptanceRecord, codeChangedFiles,
  mutationActions, actionParityReport, actionLabelWords, actionLabelCore,
  actionLabelParityMode,
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
import { UI_CHECKS_PATH, parseUiChecks } from './ui-check-logic.js';
import {
  httpProbePlan, browserProbePlan, probeBudget,
  formatHttpProbeResult, formatBrowserProbeResult, PROBE_MAX_PER_CYCLE,
  httpProbeCommand, parseCurlDashI,
} from './probe-logic.js';
import { runBrowserProbe } from './browser-probe.js';
import {
  removalCoverage, removalRejectionMessage, removalWarningMessage, removalCoverageNote,
} from './removal-claims-logic.js';
import {
  malformedFinishInput, malformedRejectionMessage, receivedParamsEcho, FINISH_FILE_PATH, parseFinishFile,
  initFinishGuard, recordFinishRejection, escalatedRetryDiagnostic, budgetNote,
  budgetExhaustedSummary, harnessFaultHaltAccepted,
  unverifiableClaims, sensitiveAssumedEntries,
} from './finish-guard-logic.js';
import { recordFeature, takeFeatureLedger } from './feature-activation.js';
// (models.js constants are no longer used directly here — the phase map and
// provider-aware prepass pick every model.)

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
  // THE CLOSE-HOOK RE-DRAIN (P48): build-queue.js always said "the close hook
  // re-drains" and nothing ever did — the drains lived only at enqueue points
  // and the after-build review, so a queued build could sit "Up next" forever
  // behind a cycle that had already concluded (the design-fix build wedged
  // behind a pending-verification completion). This is called at every cycle
  // exit, so it IS the close hook: when the concluded cycle no longer blocks
  // the queue (terminal, or the calm pending-verification completion — never a
  // blocked cycle whose resume needs the lock a queued build would take),
  // advance the queue. Fire-and-forget; a drain failure never affects cleanup.
  try {
    const c = getCycle(Number(cycleId));
    if (c && queueMayAdvancePast(c)) {
      import('./build-queue.js')
        .then(({ drainBuildQueue }) => drainBuildQueue(c.project_id))
        .catch((e) => console.warn('[mock2] close-hook queue drain failed:', e?.message));
    }
  } catch { /* cleanup must never throw */ }
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


// The connector (+ key) that can serve a phase-map model on ANOTHER provider
// than the build_runner slot's: the first enabled connector of that provider
// advertising agentic_build with a usable credential, with the project/user
// key layered over the global one exactly like buildRunnerReady. Null when no
// such connector exists — the caller keeps the slot connector and says so.
function agenticConnectorForProvider(provider, { projectId = null, userId = null } = {}) {
  for (const c of listConnectors()) {
    if (!c?.enabled || c.provider !== provider) continue;
    if (!parseCapabilities(c.capabilities).includes('agentic_build')) continue;
    const globalKey = decryptConnectorKey(c);
    const resolved = resolveProjectKey({ projectId, provider, userId, globalKey });
    const apiKey = resolved.apiKey;
    if (isCloudProvider(provider) && !apiKey) continue;
    const connector = resolved.baseUrl && resolved.source !== 'global'
      ? { ...c, base_url: resolved.baseUrl }
      : c;
    return { connector, apiKey };
  }
  return null;
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
  const model = prepassModelFor(ready.connector.provider, routingEnv());
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
    connector: ready.connector, apiKey: ready.apiKey, model: prepassModelFor(ready.connector.provider, routingEnv()),
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
  // A distillation is cheap-tier work ("one cheap turn", per the contract
  // above) — and MODEL_PRIMARY here had the same provider bug as the
  // classifier: an Anthropic id on an OpenAI build connector fails the call.
  const call = callStepTurn('chat-distill', {
    connector: ready.connector, apiKey: ready.apiKey, model: prepassModelFor(ready.connector.provider, routingEnv()),
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

// FAILURE DIAGNOSIS — the platform doing what the successful human loop did.
// Measured on project 54's export saga: four fix builds ($1.07) each repaired
// something plausible-but-adjacent while the acceptance report named the
// exact failing selector every time; the one build that started from a
// root-cause diagnosis fixed it for $0.17. The specificity already existed
// in the platform's own artifacts — nothing compiled it, and nothing read it
// before the next attempt.
//
// So, on a cycle that FAILS its own acceptance checks: gather the evidence
// deterministically (zero model spend — the failing checks' exact steps, the
// build's claimed finish, the changed files' code), hand it to the TOP-TIER
// review model from the cycle's phase map, and post the root cause + a
// build-ready FIX INSTRUCTION into the chat, where the ⚡ quick-update
// shortcut can send it. One bounded top-tier call (~$0.10–0.25).
//
// Fire-and-forget and fail-open: the cycle is already recorded failed before
// this runs, and a diagnosis failure changes nothing about it.
// MOCK2_FAILURE_DIAGNOSIS=off disables.
async function runFailureDiagnosis({ project, cycle, ready, smokeReport, changedFiles, finishSummary, logEvent }) {
  if (String(process.env.MOCK2_FAILURE_DIAGNOSIS || '').trim().toLowerCase() === 'off') return;
  const checks = failingAppChecks(smokeReport);
  if (!checks.length) return;
  const projectId = project.id;
  const containerName = project.container_name || containerNameForProject(projectId);
  const files = [];
  for (const p of diagnosisCandidateFiles(changedFiles)) {
    const r = await readFileInContainer(containerName, p).catch(() => null);
    if (r?.ok && r.content) files.push({ path: p, content: r.content });
  }
  // The top tier from this cycle's phase map (review, else plan) — the same
  // tier the human-loop diagnosis ran on; connector resolution mirrors the
  // plan phase. No usable map entry → the build connector's own model.
  let call = { connector: ready.connector, apiKey: ready.apiKey, model: ready.model };
  try {
    const pm = parseRoutingJson(getCycle(cycle.id)?.routing_json)?.phase_map || null;
    const target = pm?.review || pm?.plan || null;
    if (target?.model) {
      if (!target.provider || target.provider === ready.connector.provider) {
        call = { ...call, model: target.model };
      } else {
        const swap = agenticConnectorForProvider(target.provider, { projectId, userId: cycle.initiated_by });
        if (swap) call = { connector: swap.connector, apiKey: swap.apiKey, model: target.model };
      }
    }
  } catch { /* the build connector stands */ }
  const res = await callStepTurn('failure-diagnosis', {
    connector: call.connector, apiKey: call.apiKey, model: call.model,
    system: stepSystemPrompt('failure-diagnosis', DIAGNOSIS_SYSTEM_PROMPT, {}),
    tools: [],
    transcript: [{ role: 'user', text: diagnosisEvidence({ instruction: cycle.instruction, finishSummary, checks, files }) }],
    timeoutMs: 240000, effort: 'high', thinking: null,
  });
  if (!res.ok) { console.warn('[mock2] failure diagnosis failed:', res.error); return; }
  try {
    const u = res.usage || {};
    const cost = costCentsForUsage({
      inputTokens: u.inputTokens || 0, outputTokens: u.outputTokens || 0,
      cacheReadTokens: u.cacheReadInputTokens || 0, cacheWriteTokens: u.cacheCreationInputTokens || 0,
    }, effectivePrice(call.connector.id, call.model));
    insertLedgerEntry({ projectId, cycleId: cycle.id, connectorId: call.connector.id, model: res.modelUsed || call.model, inputTokens: u.inputTokens || 0, outputTokens: u.outputTokens || 0, costCents: cost, wallClockMs: 0, step: 'failure-diagnosis' });
  } catch (e) { console.warn('[mock2] failure-diagnosis ledger write failed:', e?.message); }
  const body = diagnosisChatMessage(res.text, { model: res.modelUsed || call.model });
  if (body) { try { insertMessage({ projectId, kind: 'assistant', cycleId: cycle.id, body }); } catch { /* best effort */ } }
  try {
    logEvent?.('ai_message', {
      role: 'assistant',
      content: 'Failure diagnosis written — root cause + a build-ready fix instruction posted to the chat.',
      meta: { step: 'failure-diagnosis', model: res.modelUsed || call.model },
    });
  } catch { /* best effort */ }
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
export async function startCycle({ project, instruction, initiatedBy, actingAsAdmin = 0, resumeContext = null, requestId = null, segment = null, task = null, buildMode = null, escalate = false, escalateModel = null, escalateEffort = null, escalateThinking = null }) {
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

  // OPERATOR ESCALATION — the Redo card / extra-effort boost. Unlike rung-1
  // escalation (which needs a FAILED prior attempt), this is the operator
  // saying "this run gets more": force the escalation model (per-press pick,
  // else per-rule, else the global setting/env) at the chosen effort (default
  // high), over whatever the fast lane or the knowledge base just decided.
  const escEffort = escalate ? (['low', 'medium', 'high', 'xhigh', 'max'].includes(escalateEffort) ? escalateEffort : 'high') : null;
  if (escalate) {
    const env = routingEnv();
    // Model precedence: the operator's explicit per-press pick (the Redo
    // card / boost dropdown) → the rule's escalation model → the global
    // setting/env → the slot model. A per-press choice is the most specific
    // intent there is.
    const escModel = String(escalateModel || routing?.escalation_model || env.MOCK2_ESCALATE_MODEL || '').trim() || ready.model;
    routing = {
      ...(routing || {}), model: escModel, effort: escEffort, rung: 1,
      reason: 'operator escalation (redo / extra effort for this build)', mode, applied_model: escModel,
    };
    ready = { ...ready, model: escModel, effort: escEffort };
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

  // A per-press escalation OUTRANKS the standing lane tuning it just lost to:
  // the operator picked model/effort (and possibly thinking) for THIS build
  // knowingly, and it reverts on the next one — the most specific intent wins.
  // thinking: 'on' clears any standing thinking-off for this run (null = the
  // model's default, adaptive where supported); 'off' forces it off; not
  // chosen = whatever the tuning said stands.
  if (escalate) {
    ready = {
      ...ready,
      model: routing.model,
      effort: escEffort,
      ...(escalateThinking ? { thinking: escalateThinking === 'off' ? 'off' : null } : {}),
    };
    routing.applied_model = ready.model;
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

  // Per-phase model routing (phase-routing@1): with the phase_routing toggle
  // on it governs EVERY build mode — full, mvp, and quick alike (operator
  // decision 2026-08: "use the 5 phase for everything"). The five-phase map is
  // resolved ONCE from which providers hold a usable credential (the same
  // connector rows as the provider selector — no second credential store),
  // narrowed by the project's provider choice (unset → the global default:
  // all configured providers, i.e. hybrid), shaped by the cost posture, and
  // stamped into routing_json + the change record so the cycle is
  // reproducible. Neither provider configured → fail HERE, before any cycle
  // row is inserted, so a refused start writes no partial state.
  if (phaseRoutingApplies({ skillsJson: framework.skills_json, env: routingEnv() })) {
    let providers = null;
    try {
      providers = detectPhaseProviders(listConnectors().map((c) => ({
        provider: c.provider, enabled: !!c.enabled, keyUsable: isSecretDecryptable(c),
      })));
    } catch (e) {
      // Detection ERROR ≠ "no provider": fall back to the single-model path
      // rather than refusing work on an infrastructure hiccup.
      console.warn('[mock2] phase-routing provider detection failed (single-model path applies):', e?.message);
    }
    if (providers) {
      const preferred = applyProviderPreference({ providers, preference: project.provider_preference });
      if (!preferred.ok) return { status: 'error', error: preferred.error };
      const resolved = resolvePhaseModelMap({ providers: preferred.providers });
      if (!resolved.ok) return { status: 'error', error: resolved.error };
      // Cost posture (five presets): shape the resolved map — default keeps
      // the manual configuration; suggested/ultra_cheap/balanced/max_quality
      // re-pin every phase. The posture rides routing_json + the record line.
      const postured = applyPhasePosture(resolved, phasePosture(routingEnv()));
      routing = {
        ...(routing || { mode }),
        phase_scenario: postured.scenario,
        phase_providers: postured.providers,
        phase_posture: postured.posture,
        phase_map: postured.map,
      };
      // The build conversation runs on the map's IMPLEMENT model (the 3b/
      // complex lane — a whole-cycle default; 3a applies per-task via the
      // work-file classification). This is what makes a posture real: with
      // ultra_cheap the builder actually runs Luna/Haiku, not the slot model.
      // A per-press operator escalation (Redo / extra effort) outranks the
      // map — that is the most specific intent there is. Cross-provider
      // models swap to a usable agentic connector for that provider; no such
      // connector → keep the slot connector/model and say so.
      const impl = postured.map?.implement_complex || null;
      if (impl?.model && !escalate) {
        let swap = null;
        let applicable = true;
        if (impl.provider && impl.provider !== ready.connector.provider) {
          swap = agenticConnectorForProvider(impl.provider, { projectId, userId: initiatedBy });
          if (!swap) {
            applicable = false;
            console.warn(`[mock2] phase map wants ${impl.model} (${impl.provider}) but no usable agentic ${impl.provider} connector exists — keeping ${ready.model}`);
          }
        }
        if (applicable) {
          ready = { ...ready, model: impl.model, ...(swap ? { connector: swap.connector, apiKey: swap.apiKey } : {}) };
          routing.applied_model = impl.model;
          routing.reason = [routing.reason, `phase-map:${postured.posture || 'default'}`].filter(Boolean).join(' ');
        }
      }
    }
  }

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
    await concludeCycle({ cycle: refused, project, framework, status: 'refused_quota', error: verdict.reason });
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
    await concludeCycle({ cycle, project, framework, status: 'failed', error: `could not acquire checkout lock: ${lock.reason}` });
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
  // Regression-gate escalation (run-taxonomy fix #3/C1): a quick update's diff
  // isn't known until the cycle runs, so the escalation decision itself
  // happens at finish time (see the finish-time gate run below) — but the MVP
  // battery's SCRIPTS need to already be in the container in case it fires,
  // so they are computed here and copied alongside the requested (quick)
  // battery. null on any non-quick mode: nothing to escalate to.
  const escalationGateScripts = gateProfile === 'quick'
    ? buildGateBattery(parsedGates, BUILD_MODE_MVP).gates.filter((g) => !waivedGates.includes(g.name))
    : null;
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
  const args = { cycle, project, containerName, framework, gateScripts, escalationGateScripts, ready, buildMode: modeStr };
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
  driveCycle().catch(async (err) => {
    console.error(`[mock2] runner crashed for cycle ${cycle.id}:`, err?.message || err);
    try { await concludeCycle({ cycle, project, framework, containerName, holder: { type: 'cycle', id: cycle.id }, status: 'failed', error: `runner crashed: ${err?.message || err}` }); } catch { /* ignore */ }
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
        const [{ ensureComponentDeps, ensureScaffoldDeps, ensureNodeRuntime }, { listProjectComponents }] = await Promise.all([
          import('./component-install.js'), import('./components.js'),
        ]);
        try { await ensureScaffoldDeps({ containerName }); } catch { /* best effort */ }
        try { await ensureNodeRuntime({ containerName }); } catch (e) { console.warn('[mock2] retry-deploy node runtime repair failed:', e?.message); }
        const ensured = await ensureComponentDeps({ containerName, rows: listProjectComponents(projectId) });
        if (ensured.repaired.length) {
          insertMessage({
            projectId, kind: 'system', cycleId: cycle.id,
            body: `Repaired missing component dependencies before redeploying: ${ensured.repaired.map((r) => `${r.key} (${r.missing.join(', ')})`).join('; ')}.`,
          });
        }
        if (!ensured.ok) {
          const detail = ensured.failed.map((f) => f.error).join('; ');
          await concludeCycle({ cycle, project, containerName, holder, status: 'failed', error: detail });
          setJob(cycle.id, { phase: 'deploy_failed', message: detail });
          return;
        }
      } catch (e) { console.warn('[mock2] retry-deploy dep repair failed:', e?.message); }
      const deployed = await deployStage({ cycle: getCycle(cycle.id), project, containerName, holder });
      if (!deployed.ok) {
        await concludeCycle({ cycle, project, containerName, holder, status: 'failed', error: deployed.error });
        setJob(cycle.id, { phase: 'deploy_failed', message: deployed.error });
        void notifyCycleComplete({ project: { id: projectId, name: project.name }, cycle: getCycle(cycle.id), outcome: 'deploy_failed' });
      } else {
        await concludeCycle({ cycle, project, containerName, holder, status: restoreStatus, error: null, summary: `checkpoint: redeploy (${restoreStatus})` });
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
      await concludeCycle({ cycle, project, containerName, holder, status: 'failed', error: `deploy retry crashed: ${err?.message || err}` });
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
        await concludeCycle({ cycle, project, containerName, holder, status: 'failed', error: `accept-pending deploy failed: ${deployed.error}` });
        setJob(cycle.id, { phase: 'deploy_failed', message: deployed.error });
        void notifyCycleComplete({ project: { id: projectId, name: project.name }, cycle: getCycle(cycle.id), outcome: 'deploy_failed' });
        return;
      }
      // Land the honest pending terminal (status awaiting_user + verification_state
      // pending → reported outcome pending-operator-verification), the SAME terminal
      // the runner's own B.5 branch produces — never "succeeded".
      openVerificationChecklist({ projectId, cycleId: cycle.id, checklist });
      updateCycle(cycle.id, { verification_state: 'pending', halt_reason: null });
      await concludeCycle({ cycle, project, containerName, holder, status: 'awaiting_user', error: null, summary: `accept-pending: deployed for live verification (${checklist.length} check(s) outstanding)` });
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
      await concludeCycle({ cycle, project, containerName, holder, status: 'failed', error: `accept-pending crashed: ${err?.message || err}` });
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
export async function runCycle({ cycle, project, containerName, framework, gateScripts, escalationGateScripts = null, ready, buildMode = BUILD_MODE_FULL, harnessProfile = null }) {
  const cycleMode = normalizeBuildMode(buildMode);
  const mvpBuild = isFastBuildMode(cycleMode); // fast modes share the relaxed acceptance path
  const projectId = Number(project.id);
  const holder = { type: 'cycle', id: cycle.id };
  const price = effectivePrice(ready.connector.id, ready.model);
  const webPort = project.web_port || 3000;

  // Copy the PINNED gate scripts into the container (ADR-003 — this version's, not
  // "latest"). Stamp the initial (all-pending) gate report on the cycle.
  //
  // Copying is cheap; running is what costs — so on a quick cycle, copy the
  // UNION of the requested (quick) and escalation (mvp) scripts now, so a
  // mid-cycle escalation (C1, decided at finish time once the diff is known)
  // never needs a second container round-trip. Execution stays profile-gated:
  // only the requested set runs unless the diff actually escalates.
  const scriptsToCopy = escalationGateScripts
    ? [...gateScripts, ...escalationGateScripts.filter((g) => !gateScripts.some((r) => r.name === g.name))]
    : gateScripts;
  const copied = await copyGatesIntoContainer(containerName, scriptsToCopy);
  if (!copied.ok) {
    await concludeCycle({ cycle, project, framework, containerName, holder, gateScripts, status: 'failed', error: `could not copy gates into container: ${copied.error}` });
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

  // CONTRACT CLASSIFIER + IMPLEMENT-LANE LADDER (the project-53 lessons).
  //
  // One cheap strict-JSON call per non-resume build does two jobs:
  //  1. Capabilities the approved inventory lacks are APPENDED as a recorded
  //     amendment (announced in chat, riding this cycle's checkpoint, parity-
  //     enforced) so the build proceeds AUTHORIZED instead of halting or
  //     shipping "Not built yet" placeholders.
  //  2. The same reply classifies the request (complexity + touches), which
  //     drives the phase map's 3a/3b lane: mechanical + no sensitive touches
  //     → the CHEAP tier builds first (Luna/Haiku); anything complex or on
  //     the touches carve-out → the mid tier. Failed prior attempts climb:
  //     second attempt one tier up, third the top tier — and an operator
  //     Redo/boost pick always outranks the ladder.
  // Fail-open everywhere: classifier errors classify as complex (the safe
  // lane) and build on the existing contract.
  let phasePlanBrief = '';
  {
    let verdict = null;
    const isResume = !!getCycle(cycle.id)?.resume_context_json;
    const isInventoryBuild = /approved design inventory/i.test(String(cycle.instruction || ''));
    if (contractClassifierMode(process.env) === 'on' && !isResume && !isInventoryBuild) {
      try {
        const invRead = await readFileInContainer(containerName, 'state/inventory.json');
        const inventory = invRead.ok ? JSON.parse(invRead.content) : null;
        if (inventory && !inventory.skipped && Array.isArray(inventory.screens)) {
          setJob(cycle.id, { phase: 'running', message: 'Checking the request against the approved design contract…' });
          const clsModel = prepassModelFor(ready.connector.provider, routingEnv());
          const res = await callStepTurn('contract-classifier', {
            connector: ready.connector, apiKey: ready.apiKey, model: clsModel,
            system: stepSystemPrompt('contract-classifier', CONTRACT_CLASSIFIER_PROMPT, {}), tools: [],
            transcript: [{ role: 'user', text: buildContractClassifierTask({ instruction: cycle.instruction, inventoryJson: invRead.content }) }],
            timeoutMs: 120000, effort: 'low', thinking: 'off',
          });
          if (res.ok) {
            try {
              const u = res.usage || {};
              const cost = costCentsForUsage({
                inputTokens: u.inputTokens || 0, outputTokens: u.outputTokens || 0,
                cacheReadTokens: u.cacheReadInputTokens || 0, cacheWriteTokens: u.cacheCreationInputTokens || 0,
              }, effectivePrice(ready.connector.id, clsModel));
              insertLedgerEntry({ projectId, cycleId: cycle.id, connectorId: ready.connector.id, model: res.modelUsed || clsModel, inputTokens: u.inputTokens || 0, outputTokens: u.outputTokens || 0, costCents: cost, wallClockMs: 0, step: 'contract-classifier' });
            } catch (e) { console.warn('[mock2] contract-classifier ledger write failed:', e?.message); }
            verdict = parseContractClassifierReply(res.text);
            // VISIBLE, with its model tag: the cheap-tier steps (classifier,
            // prepass) never emitted feed events, so even when Luna ran, the
            // activity stream showed only the executor's model and the
            // operator reasonably concluded the cheap tier was never used
            // (operator report, twice). One compact row names the verdict
            // and the model that made it.
            if (verdict) {
              logEvent('ai_message', {
                role: 'assistant',
                content: `Sized by the classifier: ${verdict.complexity}${verdict.touches?.length ? ` · touches ${verdict.touches.join(', ')}` : ''} — the ${verdict.complexity === 'mechanical' ? 'cheap' : 'mid'}-tier lane builds it.`,
                meta: { step: 'contract-classifier', model: res.modelUsed || clsModel },
              });
            }
            if (verdict && !verdict.covered) {
              const applied = applyInventoryAdditions(inventory, verdict.additions, { at: nowIso() });
              if (applied.added.total > 0) {
                const w = await writeFileInContainer(containerName, 'state/inventory.json', JSON.stringify(applied.inventory, null, 2));
                if (w.ok) {
                  logEvent('note', {
                    role: 'system',
                    content: `Contract extended before build: ${applied.summary || `${applied.added.total} addition(s)`}`,
                    meta: { contract_amendment: applied.added, reason: verdict.reason },
                  });
                  try { insertMessage({ projectId, kind: 'system', cycleId: cycle.id, body: contractAmendmentMessage(applied.added, applied.summary, verdict.reason) }); } catch { /* best effort */ }
                } else {
                  console.warn('[mock2] contract amendment write failed (build proceeds on the existing contract):', w.error);
                }
              }
            }
          }
        }
      } catch (e) { console.warn('[mock2] contract classifier failed (build proceeds on the existing contract):', e?.message); }
    }
    // The lane ladder — applies whenever the cycle carries a phase map and
    // the operator didn't hand-pick a model for this run.
    try {
      const routingDoc = parseRoutingJson(getCycle(cycle.id)?.routing_json);
      const pm = routingDoc?.phase_map || null;
      const operatorPick = /operator escalation/i.test(String(routingDoc?.reason || ''));
      if (pm && !operatorPick) {
        let attempts = 0;
        // The inventory (MVP) build skips the ladder — it is a full-scope
        // build, so the whole-cycle implement_complex default already picked
        // at start is the right lane and nothing should downgrade it.
        let lane = { lane: 'implement_complex', reason: 'inventory build — full-scope implement' };
        if (!isInventoryBuild) {
        try {
          attempts = escalationAttempts({
            priorCycles: listCyclesForProject(projectId, { limit: 20 }),
            requestId: cycle.request_id, instruction: cycle.instruction,
          });
        } catch { attempts = 0; }
        lane = implementLaneForTask({ complexity: verdict?.complexity, touches: verdict?.touches });
        let target; let why;
        if (attempts >= 2) { target = pm.plan; why = `attempt ${attempts + 1} → top tier`; }
        else if (attempts === 1) {
          target = lane.lane === 'implement_mechanical' ? pm.implement_complex : pm.plan;
          why = 'second attempt → one tier up';
        } else { target = pm[lane.lane]; why = lane.reason; }
        if (target?.model && target.model !== ready.model) {
          let swap = null;
          let applicable = true;
          if (target.provider && target.provider !== ready.connector.provider) {
            swap = agenticConnectorForProvider(target.provider, { projectId, userId: cycle.initiated_by });
            if (!swap) {
              applicable = false;
              console.warn(`[mock2] lane ladder wants ${target.model} (${target.provider}) but no usable agentic connector exists — keeping ${ready.model}`);
            }
          }
          if (applicable) {
            ready = { ...ready, model: target.model, ...(swap ? { connector: swap.connector, apiKey: swap.apiKey } : {}) };
            const updatedRouting = {
              ...routingDoc, applied_model: target.model, implement_lane: lane.lane,
              phase_attempts: attempts, reason: [routingDoc.reason, `lane:${lane.lane} (${why})`].filter(Boolean).join(' '),
            };
            try { updateCycle(cycle.id, { routing_json: JSON.stringify(updatedRouting) }); } catch { /* best effort */ }
          }
        } else if (routingDoc && routingDoc.implement_lane !== lane.lane) {
          try { updateCycle(cycle.id, { routing_json: JSON.stringify({ ...routingDoc, implement_lane: lane.lane }) }); } catch { /* best effort */ }
        }
        }
        // PLAN PHASE, made real — for EVERY first-attempt build whose plan
        // model differs from its executor, not only the cheap lane. It began
        // as a cheap-lane safety net (top-tier invariants over Luna's
        // typing), but that left the common case single-model: a quick
        // update classified complex ran wholly on the mid tier, and the
        // inventory (MVP) build skipped the block entirely — so the resolved
        // phase map was stamped on the cycle and then ignored, and the
        // operator watched every step of every build run on one model
        // (project 54: 177 of 178 model-stamped events on the same model,
        // twice reported). Now the map's top-tier plan model writes the
        // implementation plan first and the lane's executor carries it out —
        // which is also where contract misses (action parity, hidden
        // controls) are cheapest to prevent. Same-model maps (ultra_cheap /
        // max_quality postures) skip it: a separate call on the same model
        // adds cost, not thinking. Repeat attempts skip it too — the ladder
        // is already escalating the executor itself.
        // Fail-open: no plan → the build runs on the instruction alone.
        if (pm.plan?.model && pm.plan.model !== ready.model && (isInventoryBuild || attempts === 0)) {
          const planConn = (!pm.plan.provider || pm.plan.provider === ready.connector.provider)
            ? { connector: ready.connector, apiKey: ready.apiKey }
            : agenticConnectorForProvider(pm.plan.provider, { projectId, userId: cycle.initiated_by });
          if (planConn) {
            setJob(cycle.id, { phase: 'running', message: `Plan phase (${pm.plan.model}) writing the implementation plan…` });
            let reqDoc = '';
            try { const rd = await readFileInContainer(containerName, 'state/design-requirements.md'); if (rd.ok) reqDoc = rd.content; } catch { /* optional */ }
            let invJson = '';
            try { const ir = await readFileInContainer(containerName, 'state/inventory.json'); if (ir.ok) invJson = ir.content; } catch { /* optional */ }
            const planRes = await callStepTurn('build-plan', {
              connector: planConn.connector, apiKey: planConn.apiKey, model: pm.plan.model,
              system: stepSystemPrompt('build-plan', BUILD_PLAN_SYSTEM_PROMPT, {}), tools: [],
              transcript: [{ role: 'user', text: buildPlanTask({ instruction: cycle.instruction, inventoryJson: invJson, requirementsDoc: reqDoc }) }],
              timeoutMs: 300000, effort: 'high',
            });
            if (planRes.ok) {
              try {
                const u = planRes.usage || {};
                const cost = costCentsForUsage({
                  inputTokens: u.inputTokens || 0, outputTokens: u.outputTokens || 0,
                  cacheReadTokens: u.cacheReadInputTokens || 0, cacheWriteTokens: u.cacheCreationInputTokens || 0,
                }, effectivePrice(planConn.connector.id, pm.plan.model));
                insertLedgerEntry({ projectId, cycleId: cycle.id, connectorId: planConn.connector.id, model: planRes.modelUsed || pm.plan.model, inputTokens: u.inputTokens || 0, outputTokens: u.outputTokens || 0, costCents: cost, wallClockMs: 0, step: 'build-plan' });
              } catch (e) { console.warn('[mock2] build-plan ledger write failed:', e?.message); }
              phasePlanBrief = formatPlanForTask(planRes.text, pm.plan.model);
              // ai_message, not note: the live activity feed surfaces
              // ai_message/tool_call rows only, so as a note the plan phase
              // was invisible — the feed showed every step on the executor's
              // model even when a top-tier plan had just run (operator
              // report: "only terra is being used"). This row is the plan
              // model's tag appearing in the feed.
              logEvent('ai_message', {
                role: 'assistant',
                content: `Implementation plan written (plan phase) — ${ready.model} executes it.`,
                meta: { step: 'build-plan', model: pm.plan.model, executor: ready.model },
              });
            } else {
              console.warn('[mock2] build-plan step failed (the build runs on the instruction alone):', planRes.error);
            }
          }
        }
      }
    } catch (e) { console.warn('[mock2] implement-lane ladder failed (current model stands):', e?.message); }
  }

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
  // WHICH ENGINE IS BUILDING — stamped on every run. Operator request: build 47
  // ran on the copilot harness (the install default) and nothing in its log
  // said so, so the harness variable was invisible when reading the evidence.
  // One event at the top of every cycle names the harness, mode and model.
  const engineName = harnessProfile?.name || 'proxypilot';
  logEvent('note', {
    role: 'system',
    content: `Build engine: ${engineName} harness · ${cycleMode} mode · model ${ready.model}`,
    meta: { harness: engineName, build_mode: cycleMode, model: ready.model },
  });
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
  let specificitySection = '';
  try {
    const prepass = parseRoutingJson(getCycle(cycle.id)?.routing_json)?.prepass;
    prepassBrief = formatBriefForTask(prepass);
    // Phase-2 point 3: the pre-pass's vague/specific read now REACHES the
    // build — vague expands like a domain expert, specific executes literally.
    specificitySection = formatSpecificityForTask(prepass);
  } catch { /* optional */ }
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
    // Materialize reference-file (document) assets into the container at
    // state/assets/<path> so the model's read tools reach the FULL content —
    // the prompt above only carries each file's summary. Re-written when the
    // library changed (or on first sight), skipped otherwise.
    const docs = assets.filter((a) => a.kind === 'document');
    if (docs.length && (diff.changed || diff.firstRun)) {
      let written = 0;
      for (const doc of docs) {
        const content = readAssetText(projectId, doc.id);
        if (content == null) continue;
        try {
          const w = await writeFileInContainer(containerName, `state/assets/${docAssetPath(doc.name)}`, content);
          if (w?.ok !== false) written++;
        } catch { /* per-file best effort */ }
      }
      if (written) logEvent('status', { text: `materialized ${written} reference file(s) into state/assets/` });
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
  const transcript = [{ role: 'user', text: `${buildRunnerTask(cycle.instruction)}${phasePlanBrief}${specificitySection}${prepassBrief}${rulesFloor}${feedbackSection}${designFindingsSectionText}${assetSection}${assetChangeSection}`, ...(taskImages.length ? { images: taskImages } : {}) }];
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
    // Resume bridge: carry the previous cycle's diff-anchored checkpoint
    // summary so the resumed build doesn't re-pay orientation turns
    // rediscovering what was already done before acting on the guidance.
    if (!resumeCtx.lastCheckpoint) {
      try {
        const last = lastChangeRecord(projectId);
        if (last) resumeCtx.lastCheckpoint = { seq: last.seq, summary: last.summary };
      } catch { /* advisory — a bare resume stays a bare resume */ }
    }
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
  // The LIVE context of the newest model call (fresh input + cache read +
  // cache write) — what the next turn will re-read. The context-handoff
  // sweet spot is judged on this, not on cumulative spend.
  let lastContextTokens = 0;
  // Cost-truth: accumulate the four canonical token classes + the run's spend so the
  // soft-pause can trip on DOLLARS (behind the flag) and the cycle can store the honest
  // usage basis. usedCostThisRun tracks fractional cents like the ledger.
  let usedCostThisRun = 0;
  const runUsage = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
  // Cache-health watch: per-turn usage tail for the silent-invalidator
  // detector (usage-logic.cacheHealth). Warn once per run — a build lane
  // paying full price for its whole prefix every turn is a ~10x input-cost
  // leak that no total reveals on its own.
  const cacheWatch = [];
  let cacheWarned = false;
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
  // Runtime-observation budget (run-taxonomy fix #1/B1): http_probe + browser_probe
  // share one per-cycle cap so a build cannot substitute unbounded probing for
  // making the change. A mutable object (not a local let) so it can be passed
  // into executeTool and updated from any of this cycle's call sites.
  const probeState = { used: 0 };
  // Symptom-chase cap (run-taxonomy fix #7/B2): prior halt reasons for this
  // REQUEST (a resume chain shares one request_id), computed once so
  // reHaltSameReason can be fed a REAL value — previously every haltCycle call
  // site passed only { gateFailStreak }, so consultTrigger's
  // 'same_reason_rehalt' case had never fired in production. Best-effort: a
  // lookup failure yields no priors, never blocks the halt.
  const priorHaltReasonsForRequest = (() => {
    try {
      return listCyclesForRequest(cycle.request_id)
        .filter((c) => c.id !== cycle.id && c.halt_reason)
        .map((c) => c.error || '');
    } catch { return []; }
  })();
  const haltSignals = (reason) => ({
    gateFailStreak,
    reHaltSameReason: reHaltSameReason({ reason, priorReasons: priorHaltReasonsForRequest }),
  });
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
  // Label-parity state (operator rule 2026-08): drifted labels also earn one
  // rejection round (visible control demanded; wording stays the design's).
  let labelParityRejected = false;
  // Rejects a removal claim at most once — a repeated rejection auto-halts.
  let removalRejected = false;
  // SHARED finish-rejection budget across ALL finish validators (gate-audit.md
  // #1; P47 request 141 spent $4.75 on five identical rejections). Every
  // validator rejection charges ONE shared budget; identical retries are
  // detected, diagnosed, and counted once; exhaustion CONCLUDES the cycle with
  // a checkpoint + operator summary instead of another round-trip.
  let finishGuard = initFinishGuard();
  // An enforced reproduce-first waiver carried on the resume context (admin-
  // granted upstream). Applied at the acceptance verdict — the real enforcement
  // layer — and stamped into the acceptance record, never merely narrated.
  const reproduceFirstWaiver = (resumeCtx?.waivers || []).find((w) => w && w.rule === 'reproduce_first') || null;

  // concludeFinishBudget — the finish handshake's rejection budget is spent:
  // CHECKPOINT the completed work, tell the operator plainly what happened, and
  // land the calm pending-operator-verification terminal. Never strand a
  // type-clean tree behind the handshake (P47 request 141 ended awaiting_admin
  // with all work complete and nothing shipped).
  const concludeFinishBudget = async ({ decision, gateReports }) => {
    let changed = [];
    try {
      const wt = await execInContainer(containerName, `{ git diff --name-only HEAD; git ls-files --others --exclude-standard; } 2>/dev/null | sort -u | grep -v '^state/changes/'`);
      changed = (wt.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
    } catch { /* best effort */ }
    let record = null;
    try {
      record = await checkpointAndRecord({
        cycle: getCycle(cycle.id), project, containerName, holder,
        gateReports: gateReports || [], gateScripts, framework,
        summary: `checkpoint: finish handshake budget exhausted\n\n${decision.finishSummary || ''}`.trim(),
      });
    } catch (e) { console.warn('[mock2] finish-budget checkpoint failed:', e?.message); }
    const summaryMsg = budgetExhaustedSummary({ history: finishGuard.history, finishSummary: decision.finishSummary, changedFiles: changed });
    try { insertMessage({ projectId, kind: 'system', cycleId: cycle.id, body: summaryMsg }); } catch (e) { console.warn('[mock2] finish-budget message failed:', e?.message); }
    try {
      openVerificationChecklist({
        projectId, cycleId: cycle.id,
        checklist: ['Review the checkpointed work — the finish handshake rejected this build\'s completion payload repeatedly. If the app looks right, press Deploy.'],
      });
      updateCycle(cycle.id, { verification_state: 'pending' });
    } catch (e) { console.warn('[mock2] finish-budget checklist failed:', e?.message); }
    // Flag for harness triage: repeated finish rejections are as likely to be a
    // harness-side parser/validator fault as a build fault (request 141 was ours).
    safeRaise({
      kind: 'flag', project_id: projectId, dedupe_key: `mock2-finish-budget:${cycle.id}`,
      ref_table: 'mock2_cycles', ref_id: cycle.id,
      detail: `${project.name}: finish handshake budget exhausted on cycle ${cycle.id} (${finishGuard.history.map((h) => h.validator).join(', ')}) — triage for a harness-side validator/parser fault.`,
    });
    logEvent('note', { role: 'system', content: 'Finish handshake budget exhausted — cycle concluded with a checkpoint for operator review.', meta: { finish_budget_exhausted: true, history: finishGuard.history } });
    finishCycle(cycle.id, { status: 'awaiting_user', error: null });
    releaseLock(projectId, holder);
    setJob(cycle.id, {
      phase: 'pending_verification',
      message: 'Concluded — the work is checkpointed. The finish handshake kept rejecting the completion payload; review the change and press Deploy if it is right.',
      commit: record?.commit_sha || null,
    });
    // outcome 'paused', not 'pending_verification': this conclusion did NOT
    // deploy, so the deployed-terminal review chain must not treat it as one.
    void notifyCycleComplete({ project: { id: projectId, name: project.name }, cycle: getCycle(cycle.id), outcome: 'paused' });
  };

  // rejectFinishOrConclude — EVERY finish-validator rejection goes through here
  // (fix 1.a/1.b/1.d): the message carries an echo of the parameters actually
  // received; an identical retry gets an escalated diagnostic naming the likely
  // cause instead of the same rejection; and the SHARED budget decides whether
  // to reject at all or conclude the cycle. Returns 'rejected' | 'concluded'.
  const rejectFinishOrConclude = async ({ validator, termId, termName, decision, message, gateReports, echo = true }) => {
    const g = recordFinishRejection(finishGuard, { validator, input: decision.finishInput || {} });
    finishGuard = g.state;
    if (g.exhausted) {
      await concludeFinishBudget({ decision, gateReports });
      return 'concluded';
    }
    const body = g.identicalRepeat
      ? escalatedRetryDiagnostic({ validator, input: decision.finishInput || {} })
      : `${message}${echo ? `\n\n${receivedParamsEcho(decision.finishInput || {})}` : ''}\n\n${budgetNote(g.count)}`;
    transcript.push({ role: 'tool', toolCallId: termId, name: termName, content: body });
    logEvent('note', {
      role: 'system',
      content: `Finish rejected (${validator})${g.identicalRepeat ? ' — identical retry; escalated diagnostic sent' : ''}: ${String(message).replace(/\s+/g, ' ').slice(0, 300)}`,
      meta: { finish_rejections_charged: finishGuard.charged, identical_retry: g.identicalRepeat },
    });
    touchLock(projectId, holder);
    return 'rejected';
  };

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
      // ir.checkpointFirst decides whether a checkpoint is even attempted — when
      // false, concludeCycle still records the terminal (a minimal record), it
      // just never touches the container. Previously a false checkpointFirst
      // left this cycle with NO change record at all.
      await concludeCycle({
        cycle: fresh, project, framework,
        containerName: ir.checkpointFirst ? containerName : null,
        holder: ir.checkpointFirst ? holder : null,
        gateReports: lastGateReports, gateScripts,
        status: ir.terminalStatus, error: `interrupted (${fresh.interrupt_request})`,
        summary: ir.checkpointFirst ? `checkpoint: ${ir.terminalStatus}` : null,
      });
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
        || softPauseReason({ usedTokens: 0, elapsedMs, contextTokens: lastContextTokens }))
      : softPauseReason({ usedTokens: usedTokensThisRun, elapsedMs, contextTokens: lastContextTokens });
    if (pauseReason) {
      const mins = Math.round((Date.now() - runStartMs) / 60000);
      const detail = pauseReason === 'budget_tokens'
        ? `token budget reached (~${Math.round(usedTokensThisRun / 1000)}k tokens this run)`
        : pauseReason === 'budget_cost'
          ? `cost budget reached (~${dollars(usedCostThisRun)} this run)`
          : pauseReason === 'context_handoff'
            ? `context sweet spot reached (~${Math.round(lastContextTokens / 1000)}k live context)`
            : `time budget reached (~${mins} min this run)`;
      // THE HANDOFF LOOP (context sweet spot). Past ~140k of live context,
      // every further turn re-reads the whole transcript at the cached rate
      // and quality degrades — restarting fresh pays for itself in a few
      // turns (see runner-logic CONTEXT_HANDOFF_TOKENS). So instead of a
      // manual pause: the model — which still HAS the context — writes the
      // handoff (done / next steps / gotchas), the work is checkpointed, and
      // the continuation is QUEUED to run automatically, carrying the
      // handoff. Bounded to CONTEXT_HANDOFF_MAX_CHAIN automatic runs per
      // operator request; past that (or on a failed handoff write) it's the
      // ordinary resumable pause. Every step here is fail-open.
      let handoffQueued = false;
      if (pauseReason === 'context_handoff') {
        const priorRun = continuationRun(cycle.instruction);
        if (priorRun < CONTEXT_HANDOFF_MAX_CHAIN) {
          try {
            const h = await callStepTurn('context-handoff', {
              connector: ready.connector, apiKey: ready.apiKey, model: ready.model, system,
              tools: [],
              transcript: [...transcript, { role: 'user', text: 'CONTEXT HANDOFF — stop working now. Write the handoff for the run that continues this work in a fresh context: DONE (what is complete, as verified facts), NEXT STEPS (ordered and specific — files and exact changes), GOTCHAS (anything the next run must know to not undo or repeat work). At most 300 words, no code blocks.' }],
              effort: 'medium', thinking: 'off', timeoutMs: 180000,
            });
            const handoffText = h.ok ? String(h.text || '').trim() : '';
            if (h.ok && h.usage) {
              const hc = costCentsForUsage({ inputTokens: h.usage.inputTokens || 0, outputTokens: h.usage.outputTokens || 0, cacheReadTokens: h.usage.cacheReadInputTokens || 0, cacheWriteTokens: h.usage.cacheCreationInputTokens || 0 }, price);
              insertLedgerEntry({ projectId, cycleId: cycle.id, connectorId: ready.connector.id, model: h.modelUsed || ready.model, inputTokens: h.usage.inputTokens || 0, outputTokens: h.usage.outputTokens || 0, costCents: hc, wallClockMs: 0, step: 'context-handoff' });
            }
            if (handoffText) {
              const { enqueueBuild } = await import('./build-queue.js');
              const nextRun = priorRun + 1;
              enqueueBuild({
                projectId,
                instruction: buildContinuationInstruction({ original: cycle.instruction, handoff: handoffText, run: nextRun, maxChain: CONTEXT_HANDOFF_MAX_CHAIN }),
                buildMode: cycleMode, initiatedBy: cycle.initiated_by,
              });
              handoffQueued = true;
              logEvent('ai_message', {
                role: 'assistant',
                content: `Context handoff written — continuation queued (run ${nextRun} of ${CONTEXT_HANDOFF_MAX_CHAIN}).\n\n${handoffText.slice(0, 1200)}`,
                meta: { step: 'context-handoff', model: ready.model },
              });
              try {
                insertMessage({
                  projectId, kind: 'system', cycleId: cycle.id,
                  body: `**Context sweet spot reached** (~${Math.round(lastContextTokens / 1000)}k live context) — progress is checkpointed and the continuation is queued (run ${nextRun} of ${CONTEXT_HANDOFF_MAX_CHAIN}). The handoff — what's done, what's next — rides the queued build, so it starts sharp in a fresh context instead of grinding an expensive, degrading window.`,
                });
              } catch { /* best effort */ }
            }
          } catch (e) { console.warn('[mock2] context handoff failed (ordinary pause applies):', e?.message); }
        }
      }
      await checkpointAndRecord({ cycle: fresh, project, containerName, holder, gateReports: lastGateReports, gateScripts, framework, summary: `checkpoint: paused — ${detail}` });
      updateCycle(cycle.id, { pause_reason: pauseReason });
      finishCycle(cycle.id, { status: 'interrupted', error: handoffQueued ? `Paused — ${detail}. The continuation is queued and starts on its own.` : `Paused — ${detail}. Resume to continue where it stopped.` });
      releaseLock(projectId, holder);
      setJob(cycle.id, { phase: 'paused', message: handoffQueued ? `Paused — ${detail}. Continuation queued.` : `Paused — ${detail}. Resume to continue.`, commit: null });
      void notifyCycleComplete({ project: { id: projectId, name: project.name }, cycle: getCycle(cycle.id), outcome: 'paused' });
      return scheduleJobCleanup(cycle.id);
    }

    // 3) Call the build_runner model for the next step.
    // Web search rides along ONLY when the operator opted the build lane in
    // (MOCK2_RUNNER_WEB_SEARCH=on, Anthropic connectors only) — Anthropic runs
    // the search server-side during the call, so the fence stays sealed.
    // Cost levers (see runner-logic): batch-prune stale tool-result bodies so
    // the cached prefix stops growing with dead weight, and ride the 1-hour
    // cache so slow gate rounds don't expire it between turns.
    const pruned = pruneStaleToolResults(transcript);
    if (pruned.prunedCount) {
      logEvent('status', { text: `pruned ${pruned.prunedCount} stale tool results (~${Math.round(pruned.prunedChars / 1000)}k chars) from the transcript` });
    }
    const result = await callStepTurn('build-runner', {
      connector: ready.connector, apiKey: ready.apiKey, model: ready.model, system, tools: (harnessProfile?.toolsForCycle || runnerToolsForCycle)({ hasGates: gateScripts.length > 0 }), transcript, maxTokens: RUNNER_MAX_TOKENS || undefined,
      serverTools: webSearchServerTools({ provider: ready.connector.provider, env: process.env, flag: RUNNER_WEB_SEARCH_FLAG, defaultOn: false }),
      effort: ready.effort || null,
      thinking: ready.thinking || null,
      cacheTtl: RUNNER_CACHE_TTL,
    });
    if (!result.ok) {
      // Transient model failure — retry up to MAX_CYCLE_RETRIES, then escalate.
      const retries = (getCycle(cycle.id).retries || 0) + 1;
      updateCycle(cycle.id, { retries });
      if (retriesExhausted(retries)) {
        await escalateAwaitingAdmin({ cycle: getCycle(cycle.id), project, framework, containerName, holder, gateReports: lastGateReports, gateScripts, reason: result.error });
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
    lastContextTokens = (u.inputTokens || 0) + cacheRead + cacheWrite;
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
    // Cache-health: after enough evidence, surface a never-read/never-engaged
    // cache exactly once per run (advisory — never blocks the cycle).
    cacheWatch.push({ input: u.inputTokens || 0, cache_read: cacheRead, cache_write: cacheWrite });
    if (cacheWatch.length > 6) cacheWatch.shift();
    if (!cacheWarned) {
      const health = cacheHealth(cacheWatch);
      if (!health.healthy) {
        cacheWarned = true;
        const msg = health.reason === 'cache_never_read'
          ? `prompt cache is being written every turn but never read (${health.suspectCalls} consecutive large calls) — a byte at the front of the prompt is changing per call (timestamp/unstable ordering); the full prefix is being re-billed each turn`
          : `prompt cache never engaged across ${health.suspectCalls} consecutive large calls — the transcript prefix is billing at full input price every turn`;
        console.warn(`[mock2] cache-health (build-runner, project ${projectId}): ${msg}`);
        logEvent('status', { text: `cache-health warning: ${msg}` });
      }
    }

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
        model: result.modelUsed || ready.model,
        input_tokens: u.inputTokens, output_tokens: u.outputTokens,
        cache_read_tokens: cacheRead, cache_write_tokens: cacheWrite, cost_cents: costCents,
      },
    });
    for (const tc of result.toolCalls || []) {
      // Per-action model attribution: the Working feed names WHICH model made
      // each Read/Edit/Ran (operator ask — the lane ladder and escalations
      // mean the answer is no longer one model per project).
      logEvent('tool_call', { role: 'assistant', content: tc.name, meta: { name: tc.name, input: tc.input || {}, model: result.modelUsed || ready.model } });
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
      await haltCycle({ cycle: getCycle(cycle.id), project, containerName, holder, gateReports: lastGateReports, gateScripts, framework, trigger: 'model_refusal', reason: decision.haltReason, options: [], logEvent, consultSignals: haltSignals(decision.haltReason) });
      return scheduleJobCleanup(cycle.id);
    }

    // 4a) The model called halt — it cannot honestly finish (blocked, missing
    //     dependency, out-of-scope fix). End the cycle NON-SUCCESS: no deploy,
    //     resumable, surfaced as needs-attention with the model's reason. Answer any
    //     tool call it paired with halt so the transcript stays well-formed.
    if (decision.halted) {
      // Fix 1.e (P47 request 141's endgame): a halt that asserts a HARNESS
      // fault, when this cycle's finish-rejection history is consistent with
      // that assertion, is accepted AS-IS — no wording re-litigation, no
      // "restate with 2–4 options" round-trip — and flagged for harness
      // triage. Request 141's correct bug report ("the finish tool keeps
      // rejecting a payload I believe is well-formed") was itself rejected
      // for its format, which is the harness disputing its own fault.
      const harnessFault = harnessFaultHaltAccepted({ reason: decision.haltReason, rejectionTotal: finishGuard.total });
      if (harnessFault) {
        safeRaise({
          kind: 'flag', project_id: projectId, dedupe_key: `mock2-harness-fault:${cycle.id}`,
          ref_table: 'mock2_cycles', ref_id: cycle.id,
          detail: `${project.name}: the build asserts a HARNESS fault after ${finishGuard.total} finish rejection(s) — "${String(decision.haltReason || '').slice(0, 200)}". Triage the finish validators/parser, not the build.`,
        });
        logEvent('note', { role: 'system', content: `Halt asserts a harness fault after ${finishGuard.total} finish rejection(s) — accepted as-is and flagged for harness triage.`, meta: { harness_triage: true } });
      }
      // A model halt must carry viable resolution options. If it doesn't and we
      // haven't already asked, feed the validation error back to the halt tool call
      // and let the model restate — ONE retry, then we halt regardless.
      const optCheck = validateHaltOptions(decision.haltOptions);
      if (!optCheck.ok && !haltOptionsRetried && !harnessFault) {
        haltOptionsRetried = true;
        for (const call of decision.toolCalls) {
          if (call.name === 'halt') {
            transcript.push({
              role: 'tool', toolCallId: call.id || 'halt', name: 'halt',
              content: `Not halted: ${optCheck.error}. Re-call halt with 2–4 resolution options — each with a kind (grant_authorization | expand_scope | run_dependency_first | override_rule | abandon), a one-line risk, and exactly what to inject on resume; mark at most one recommended. If a one-time privileged operation is a viable path, include a grant_authorization option carrying the exact scope and expected row count.`,
            });
            continue;
          }
          const out = await executeTool({ call, cycle, containerName, holder, gateScripts, webPort, probeState });
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
        const out = await executeTool({ call, cycle, containerName, holder, gateScripts, webPort, probeState });
        lastGateReports = out.gateReports || lastGateReports;
        if (out.gateReports) redTestObserved = redTestObserved || batteryHasRedTestGate(out.gateReports);
        transcript.push({ role: 'tool', toolCallId: call.id, name: call.name, content: truncateToolResult(out.content) });
        logEvent('tool_result', { role: 'tool', content: out.content, meta: { name: call.name } });
      }
      await haltCycle({ cycle: getCycle(cycle.id), project, containerName, holder, gateReports: lastGateReports, gateScripts, framework, trigger: 'model_halt', reason: decision.haltReason, options: haltOptions, logEvent, consultSignals: haltSignals(decision.haltReason) });
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
        consultSignals: haltSignals(`The build requested a one-time authorization: ${v.scope}${decision.authRequest.reason ? ` — ${decision.authRequest.reason}` : ''}`),
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
        const out = await executeTool({ call, cycle, containerName, holder, gateScripts, webPort, probeState });
        lastGateReports = out.gateReports || lastGateReports;
        if (out.gateReports) redTestObserved = redTestObserved || batteryHasRedTestGate(out.gateReports);
        transcript.push({ role: 'tool', toolCallId: call.id, name: call.name, content: truncateToolResult(out.content) });
        logEvent('tool_result', { role: 'tool', content: out.content, meta: { name: call.name } });
      }
      // FILE-BASED FINISH FALLBACK (P47 cycle 587): the mangling below is
      // EMISSION flakiness — the same model glued three finish calls into one
      // string in one cycle and sent a clean call in the next, so re-issuing is
      // a coin flip. When the arriving call is malformed or missing its
      // required fields AND state/finish.json exists (the fallback the
      // rejection messages teach), the file's fields become the call's
      // parameters. The file is CONSUMED either way — deleted before the diff
      // is read — so it can never leak into a checkpoint or feed a later cycle.
      {
        const needsFile = malformedFinishInput(decision.finishInput || {}).malformed
          || !decision.finishAcceptance?.length || !decision.finishAssumptions;
        if (needsFile) {
          try {
            const ff = await readFileInContainer(containerName, FINISH_FILE_PATH);
            if (ff.ok && String(ff.content || '').trim()) {
              const parsedFile = parseFinishFile(ff.content);
              await execInContainer(containerName, `rm -f '${APP_DIR}/${FINISH_FILE_PATH}'`);
              if (parsedFile.ok) {
                const f = parsedFile.fields;
                if (f.summary) decision.finishSummary = f.summary;
                if (f.acceptance) decision.finishAcceptance = f.acceptance;
                if (f.assumptions) decision.finishAssumptions = f.assumptions;
                if (f.acceptance_ids) decision.finishAcceptanceIds = f.acceptance_ids;
                if (f.removals) decision.finishRemovals = f.removals;
                decision.finishInput = { ...(decision.finishInput || {}), ...f };
                logEvent('note', {
                  role: 'system',
                  content: `finish parameters hydrated from ${FINISH_FILE_PATH} (serialization fallback): ${Object.keys(f).join(', ')}.`,
                  meta: { finish_file: true },
                });
              } else {
                logEvent('note', { role: 'system', content: `${FINISH_FILE_PATH} exists but was unusable — ${parsedFile.error}. It was removed; the normal rejection follows.`, meta: { finish_file: false } });
              }
            }
          } catch (e) { console.warn('[mock2] finish-file fallback failed open:', e?.message); }
        }
      }
      // FINISH GUARD, fix 1.c (P47 request 141's root cause): a parameter value
      // carrying tool-call syntax fragments is a MALFORMED CALL, not missing
      // prose. Detected FIRST, with the offending fragment quoted — otherwise a
      // validator complains about a "missing" parameter that was never going to
      // arrive and the model rephrases prose five times ($4.75, nothing shipped).
      // CHEAPEST PASS: send one structurally well-formed finish call — which is
      // the desired behavior; there is no way to satisfy this check that makes
      // the app worse.
      {
        const malformed = malformedFinishInput(decision.finishInput || {});
        if (malformed.malformed) {
          const r = await rejectFinishOrConclude({
            validator: 'malformed-call', termId, termName, decision, gateReports: lastGateReports,
            message: malformedRejectionMessage(malformed, decision.finishInput || {}), echo: false,
          });
          if (r === 'concluded') return scheduleJobCleanup(cycle.id);
          continue;
        }
      }
      // Acceptance criteria are REQUIRED on finish (constitution §11): a
      // human-runnable check per user-visible change + the verified-vs-assumed
      // assumption split. A finish without them is rejected back to the model;
      // the SHARED rejection budget (not the old one-per-validator scheme)
      // bounds the round-trips, and the no-progress breaker still terminates a
      // cycle that keeps refusing.
      // CHEAPEST PASS: write more acceptance prose (gate-audit.md #8/9 called
      // this COSTLY — it produces no product). That is why the rejection now
      // echoes what was received (a structural bug is fixable in one pass) and
      // why the budget is shared: prose negotiation is capped at 3 round-trips
      // total, then the operator decides.
      if (!decision.finishAcceptance?.length || !decision.finishAssumptions) {
        const r = await rejectFinishOrConclude({
          validator: 'acceptance-present', termId, termName, decision, gateReports: lastGateReports,
          message: 'Not finished: finish requires `acceptance` (≥1 human-runnable check — "as <role>, do X, expect Y" — one per user-visible change, or one entry describing the non-UI verification performed) and `assumptions` ({verified:[…], assumed:[…]} — the cross-layer values you READ the source for this cycle, naming the file, vs the ones you assumed). Re-call finish with both.',
        });
        if (r === 'concluded') return scheduleJobCleanup(cycle.id);
        if (progress.tripped) {
          await haltCycle({ cycle: getCycle(cycle.id), project, containerName, holder, gateReports: lastGateReports, gateScripts, framework, trigger: progress.trigger, reason: `Auto-stopped after ${noProgLimit} turns with no progress (${haltReasonLabel(progress.trigger)}); finish kept omitting acceptance criteria.`, logEvent, consultSignals: haltSignals(`Auto-stopped after ${noProgLimit} turns with no progress (${haltReasonLabel(progress.trigger)}); finish kept omitting acceptance criteria.`) });
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
        // CHEAPEST PASS: write a plausible state/acceptance.json (or reword the
        // spec) without new verification — honest work for a real bugfix, prose
        // for everything else. Shares the finish budget so it can no longer
        // consume five round-trips on its own (P47 request 141).
        const r = await rejectFinishOrConclude({
          validator: 'acceptance-demonstrated', termId, termName, decision, gateReports: lastGateReports,
          message: `Not finished — acceptance not demonstrated:\n${verdict.reasons.map((x) => `- ${x}`).join('\n')}`,
        });
        if (r === 'concluded') return scheduleJobCleanup(cycle.id);
        if (progress.tripped) {
          await haltCycle({ cycle: getCycle(cycle.id), project, containerName, holder, gateReports: lastGateReports, gateScripts, framework, trigger: progress.trigger, reason: `Auto-stopped: finish kept arriving without demonstrated acceptance (${verdict.reasons[0]}).`, logEvent, consultSignals: haltSignals(`Auto-stopped: finish kept arriving without demonstrated acceptance (${verdict.reasons[0]}).`) });
          return scheduleJobCleanup(cycle.id);
        }
        continue;
      }
      // The change-record summary must describe THIS cycle's diff — naming files
      // the cycle did not touch (bundling prior cycles' work) is rejected.
      // EXCEPT the verification-only finish (P47 request 141, the resume
      // dead-end): a cycle that changed no product code and whose summary SAYS
      // the work already exists may name the files it verified — that is the
      // evidence trail, not an authorship claim. Without this, a resumed
      // request whose work a prior cycle completed had no honest completion
      // at all (finish over-claimed, halt re-blocked), ~$1 per resume.
      const oc = summaryOverclaims(decision.finishSummary, changedThisCycle);
      if (!oc.ok && !verificationOnlyFinish(decision.finishSummary, codeChanged)) {
        // CHEAPEST PASS: a shorter, accurate summary — which is the goal
        // (gate-audit.md #10: SOUND). Budget-shared like every other validator.
        const r = await rejectFinishOrConclude({
          validator: 'summary-overclaim', termId, termName, decision, gateReports: lastGateReports,
          message: `Not finished — the summary names files this cycle did NOT change (${oc.unmatched.join(', ')}). The change record must describe THIS cycle's diff only — do not bundle prior cycles' work. Files actually changed: ${changedThisCycle.slice(0, 20).join(', ') || '(none)'}. Re-call finish with a summary scoped to this diff.${codeChanged.length === 0
            ? ' If nothing needed changing because the requested work ALREADY EXISTS in the tree (e.g. a resumed request a prior cycle completed), say exactly that — a summary stating it is "already implemented — no code changes needed", naming what you verified, is a legitimate finish. Do not halt for "already done".'
            : ''}`,
        });
        if (r === 'concluded') return scheduleJobCleanup(cycle.id);
        if (progress.tripped) {
          await haltCycle({ cycle: getCycle(cycle.id), project, containerName, holder, gateReports: lastGateReports, gateScripts, framework, trigger: progress.trigger, reason: 'Auto-stopped: finish summary kept over-claiming beyond this cycle\'s diff.', logEvent, consultSignals: haltSignals('Auto-stopped: finish summary kept over-claiming beyond this cycle\'s diff.') });
          return scheduleJobCleanup(cycle.id);
        }
        continue;
      }
      // VERIFIED-VS-ASSUMED LEDGER CHECK (run-taxonomy fix #10/D3). A
      // `verified` entry that cites a specific file is a checkable claim, and
      // nothing checked it until now — assumptions.verified was taken on
      // faith. Only a claim citing a file this cycle never read is rejected;
      // an uncited claim (a cross-cutting invariant, a browser-probe
      // observation per Spec B) is never touched — see unverifiableClaims'
      // own contract. Placed right after summary-overclaim: both validators
      // are about the summary/assumptions block's honesty.
      const unverifiable = unverifiableClaims({ assumptions: decision.finishAssumptions, readSet: readSetFromTranscript(transcript) });
      if (unverifiable.length) {
        const r = await rejectFinishOrConclude({
          validator: 'unverifiable-claim', termId, termName, decision, gateReports: lastGateReports,
          message: `Not finished — assumptions.verified claims a file this cycle never read: ${unverifiable.map((c) => `"${c}"`).join('; ')}. Either read that file and re-verify, or move the claim to assumed.`,
        });
        if (r === 'concluded') return scheduleJobCleanup(cycle.id);
        if (progress.tripped) {
          await haltCycle({ cycle: getCycle(cycle.id), project, containerName, holder, gateReports: lastGateReports, gateScripts, framework, trigger: progress.trigger, reason: 'Auto-stopped: finish kept claiming verification of files never read.', logEvent, consultSignals: haltSignals('Auto-stopped: finish kept claiming verification of files never read.') });
          return scheduleJobCleanup(cycle.id);
        }
        continue;
      }
      // APP-OWNED SMOKE FAILURES MUST BE ANSWERED (fix 2.c; P47 request 140:
      // beneath the platform noise sat a real app failure, notes-todo-add, and
      // two cycles concluded "no product-code change was needed" without ever
      // naming it). A finish with an EMPTY product diff, arriving after a
      // smoke-failed cycle in the same request, must either have fixed the
      // failing app-owned checks (then the diff is not empty) or answer each
      // one BY NAME in its summary/acceptance. Cheapest-pass note lives with
      // unansweredSmokeFailures in ui-check-logic.js.
      if (codeChanged.length === 0 && cycle.request_id) {
        try {
          const { appOwnedFailureIds, unansweredSmokeFailures } = await import('./ui-check-logic.js');
          const prior = listCyclesForProject(projectId, { limit: 20 })
            .find((c) => c.id !== cycle.id && c.request_id === cycle.request_id && c.status === 'failed'
              && /smoke gate failed after deploy/i.test(String(c.error || '')));
          const failedIds = prior ? appOwnedFailureIds(prior.error) : [];
          const unanswered = unansweredSmokeFailures({ failedIds, summary: decision.finishSummary, acceptance: decision.finishAcceptance });
          if (unanswered.length) {
            const r = await rejectFinishOrConclude({
              validator: 'smoke-failure-unanswered', termId, termName, decision, gateReports: lastGateReports,
              message: `Not finished — the previous build in this request failed app-owned smoke check(s) [${unanswered.join(', ')}], and this finish changes no product code without answering them. `
                + 'Either fix what the failing check(s) caught, or state explicitly — naming each check id in your summary or acceptance — why the app is correct and no product change is needed '
                + '(e.g. the check asserts a selector the approved design renamed). Silence about a failing app check is not "no change needed".',
            });
            if (r === 'concluded') return scheduleJobCleanup(cycle.id);
            continue;
          }
        } catch (e) { console.warn('[mock2] smoke-answer check failed open:', e?.message); }
      }
      // REMOVAL CLAIMS: "I took it out" has to be checkable.
      //
      // Project 44 finished with "removed the To-dos inner scrollbar", an
      // acceptance sentence saying "no scrollbar beside the Note/To-dos
      // content", and two acceptance_ids that assert nothing of the kind. The
      // scrollbar is still on the screen. Nothing contradicted it because
      // nothing could — the gates catch overflow, dead controls and design
      // drift, and none of them catch "the thing you said you removed is
      // still there". Across 86 real finish payloads this shape is one in
      // seven, and two thirds of those declared no acceptance ids at all.
      //
      // Rejects ONCE, exactly like action parity: a repeated rejection
      // auto-halts a cycle, and a detector that can kill builds is worse than
      // the defect (LEARNINGS 107). The second finish ships and tells the
      // OPERATOR instead.
      try {
        const claimed = decision.finishRemovals || [];
        const uiSpecRead = await readFileInContainer(containerName, UI_CHECKS_PATH);
        const uiSpec = uiSpecRead.ok ? parseUiChecks(uiSpecRead.content) : { ok: false };
        const verdict = removalCoverage({
          summary: decision.finishSummary,
          removals: claimed,
          spec: uiSpec.ok ? uiSpec.spec : null,
        });
        const note = removalCoverageNote(verdict);
        if (note) logEvent('note', { role: 'system', content: note });
        // The ledger row, INCLUDING the quiet case. "No removal was claimed" is
        // the answer an operator cannot get any other way — a feature that
        // declines to act writes nothing, and silence reads identically to
        // never having run.
        recordFeature(projectId, 'removal_claims',
          verdict.claims.length ? 'fired' : 'skipped',
          verdict.claims.length
            ? `${verdict.claims.length} claim(s); ${verdict.ok ? 'each asserted by a check that could fail' : `${verdict.uncovered.length} unverified, ${verdict.badRefs.length} unfalsifiable`}`
            : 'the summary claimed no user-visible removal');
        if (!verdict.ok && !removalRejected) {
          removalRejected = true;
          // CHEAPEST PASS: add an expect_absent/expect_no_scroll check, or
          // withdraw the claim — both honest, neither touches the UI
          // (gate-audit.md #11: SOUND, but it costs a round-trip; the cost is
          // now bounded by the shared budget). Still rejects at most once.
          const r = await rejectFinishOrConclude({
            validator: 'removal-claims', termId, termName, decision, gateReports: lastGateReports,
            message: removalRejectionMessage(verdict), echo: false,
          });
          if (r === 'concluded') return scheduleJobCleanup(cycle.id);
          continue;
        }
        if (!verdict.ok) {
          // Shipped, but a person should know. The build's own summary will
          // say it removed something; this is the only place that says nothing
          // checked whether it did.
          const warning = removalWarningMessage(verdict);
          // Both halves, or a badRefs-only verdict logs an empty list and reads
          // as though nothing was wrong.
          const unverified = [
            ...verdict.uncovered.map((c) => c.raw),
            ...verdict.badRefs.map((b) => `${b.what || '(unnamed)'} — ${b.why}`),
          ].join(' | ');
          logEvent('note', { role: 'system', content: `Removal claims still unverified after rejection (accepted with warning): ${unverified}` });
          try {
            if (warning) insertMessage({ projectId, kind: 'system', cycleId: cycle.id, body: warning });
          } catch (e) { console.warn('[mock2] removal warning message failed:', e?.message); }
        } else if (verdict.claims.length) {
          // The declared checks are FORCED to run against the deployed app —
          // the same machinery acceptance_ids uses. Verifying the check exists
          // and never running it would only move the unverified claim one step
          // later.
          const ids = (verdict.declared || []).map((r) => r.checkId).filter(Boolean);
          if (ids.length) {
            decision.finishAcceptanceIds = [...new Set([...(decision.finishAcceptanceIds || []), ...ids])];
          }
        }
      } catch (e) {
        console.warn('[mock2] removal-claim check failed open:', e?.message);
        recordFeature(projectId, 'removal_claims', 'failed', e?.message || 'threw');
      }
      // ACTION PARITY (ratchet 3): on the inventory-implementation build,
      // every mutation action in the contract must be REACHABLE BY A USER —
      // a control, a menu item, or any secondary surface all count; a
      // hidden-only match never does. A capability found nowhere is silently
      // missing and rejects the finish once (with the list). Deterministic:
      // one container grep per label over src/ + public/.
      //
      // CHEAPEST PASS + THE PAIR (gate-audit.md #4/#12; reviewed together
      // with no-dead-controls in baseline-gates.js): the cheapest pass is to
      // put the capability wherever the design places it — a "More actions"
      // menu item satisfies this check completely. The pair cannot jointly
      // force render-everything: THIS check accepts menu/secondary placement
      // and accepts "left out + stated in the summary" (warn path, operator
      // told), so it never demands a rendered top-level control; and
      // no-dead-controls only inspects controls the build CHOSE to render —
      // it never asks for one to exist. P47's "Edit note title/body" button
      // came from a message that read as "the checker wants the string";
      // the message below forbids that reading explicitly.
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
            // THE CORE, not every word. Requiring all significant words on one
            // line meant "Edit note title/body" needed edit AND note AND title
            // AND body together — which no designed control ever satisfies, so
            // a build with a perfectly good `More actions → Edit` was told the
            // action appeared NOWHERE and printed the contract string on a
            // button to get past it. Two words is what a real control can
            // carry: the verb somewhere near the noun.
            const wordGrep = (a) => {
              const words = actionLabelCore(a.label).filter((w) => /^[a-z0-9]+$/.test(w));
              if (!words.length) return null;
              if (words.length === 1) return `grep -rqi -- '${words[0]}' src public app views 2>/dev/null`;
              return `grep -rhi -- '${words[0]}' src public app views 2>/dev/null | grep -qi -- '${words[1]}'`;
            };
            const script = ['cd "' + APP_DIR + '"']
              .concat(actions.map((a) => {
                const wg = wordGrep(a);
                // HIDDEN-ONLY is checked FIRST: an exact label whose every
                // occurrence sits on a line carrying a `hidden` attribute is
                // not a surfaced action, it is this grep being gamed. Project
                // 47 shipped `<p id="admin-settings-hint" hidden>` for exactly
                // that, and the old check counted it as present.
                return `l=$(printf '%s' '${b64(a.label)}' | base64 -d)\n`
                  + `n=$(grep -rhiF -- "$l" src public app views 2>/dev/null | wc -l)\n`
                  + `v=$(grep -rhiF -- "$l" src public app views 2>/dev/null | grep -vc 'hidden')\n`
                  + `if [ "$n" -gt 0 ] && [ "$v" -eq 0 ]; then printf 'HIDDEN\\t%s\\n' "$l"\n`
                  + `elif [ "$n" -gt 0 ]; then printf 'FOUND\\t%s\\n' "$l"\n`
                  + (wg ? `elif ${wg}; then printf 'WORDS\\t%s\\n' "$l"\n` : '')
                  + 'fi';
              }))
              .join('\n');
            const gr = await containerSh(containerName, script, { timeoutMs: 60000 });
            const tagged = (tag) => new Set(String(gr.stdout || '').split('\n')
              .filter((x) => x.startsWith(`${tag}\t`)).map((x) => x.slice(tag.length + 1).trim().toLowerCase()));
            const found = tagged('FOUND');
            const wordHits = tagged('WORDS');
            const hiddenOnly = tagged('HIDDEN');
            const parity = actionParityReport(actions, found, wordHits, hiddenOnly);
            if (parity.hiddenOnly?.length) {
              // Said out loud and separately from "missing": the build DID
              // write the label, on an element nobody can see. That is a
              // different mistake from dropping the action, and the message
              // has to name it or the next build repeats it.
              logEvent('note', {
                role: 'system',
                content: `Action parity: ${parity.hiddenOnly.length} action(s) matched ONLY on a hidden element: ${parity.hiddenOnly.map((a) => `"${a.label}"`).join(', ')}`,
              });
            }
            if (parity.drifted?.length) {
              logEvent('note', {
                role: 'system',
                content: `Action parity: ${parity.drifted.length} action(s) present under a different label than the contract: ${parity.drifted.slice(0, 8).map((a) => `"${a.label}"`).join(', ')}`,
              });
            }
            // Label parity (operator rule 2026-08): drifted is no longer
            // report-only — the project-53 lesson was eight capabilities
            // shipped as invisible affordances (click-to-edit, typed
            // commands) that read as MISSING buttons. One rejection round
            // demanding a VISIBLE control per drifted action; the wording
            // stays the design's call (never dictate copy — project 47),
            // and a second finish proceeds with the warning, like missing.
            if (actionLabelParityMode(process.env) === 'enforce'
              && parity.ok && parity.drifted?.length && !labelParityRejected && !parityRejected) {
              labelParityRejected = true;
              const list = parity.drifted.slice(0, 10).map((a) => `"${a.label}" (${a.screen})`).join(', ');
              const msg = `Not finished — label parity: these contract actions exist in the code but have no VISIBLE control a user could find: ${list}.\n\n`
                + 'Each one needs a real, discoverable control on its screen — a button, a menu item, an icon with an aria-label. '
                + 'Call it whatever reads best (the wording is the design\'s call, NOT this check\'s — do not print the contract string). '
                + 'What does NOT count: hover-only or click-target-only affordances with no visible cue, typed commands (e.g. "type remove to revoke"), '
                + 'hidden elements, or code paths with no control at all. If the mockup genuinely shows no control for one of these, '
                + 'leave it as is and say so in your finish summary. Then re-call finish.';
              const r = await rejectFinishOrConclude({
                validator: 'label-parity', termId, termName, decision, gateReports: lastGateReports,
                message: msg, echo: false,
              });
              if (r === 'concluded') return scheduleJobCleanup(cycle.id);
              continue;
            }
            if (actionLabelParityMode(process.env) === 'enforce' && parity.ok && parity.drifted?.length && labelParityRejected) {
              try {
                insertMessage({
                  projectId, kind: 'system', cycleId: cycle.id,
                  body: `Heads-up — ${parity.drifted.length} action${parity.drifted.length === 1 ? '' : 's'} from the approved design may lack a visible control (shipped under a different label/affordance): ${parity.drifted.slice(0, 8).map((a) => `"${a.label}"`).join(', ')}. Check them in the live app; send a build if any are hard to find.`,
                });
              } catch { /* best effort */ }
            }
            if (!parity.ok && !parityRejected) {
              parityRejected = true;
              const list = parity.missing.slice(0, 10).map((a) => `"${a.label}" (${a.screen})`).join(', ');
              const parityRejection = {
                role: 'tool', toolCallId: termId, name: termName,
                // THE WORDING OF THIS MESSAGE IS THE FEATURE. The old one said
                // the actions "appear NOWHERE in the app's UI source", and a
                // build read that as "the checker wants the exact string" and
                // shipped a button labelled "Edit note title/body". A gate that
                // dictates copy is worse than the drop it catches, so this
                // says explicitly that the contract is a list of CAPABILITIES,
                // names the good design as acceptable, and forbids the two
                // shortcuts that gaming it produces.
                content: `Not finished — action parity: a user has no way to perform these actions from the approved contract: ${list}.\n\n`
                  + 'The contract names CAPABILITIES, not button copy. Give each one a real control and label it however reads best — '
                  + '"Edit", a pencil icon with an aria-label, or an item inside a "More actions" menu all pass. '
                  + 'Do NOT put the contract\'s wording on screen: a button reading "Edit note title/body" is this check being satisfied instead of a user being served.\n\n'
                  + 'Two things that do NOT count: an element with the `hidden` attribute, and a control that leads somewhere the action cannot actually be performed. '
                  + 'PLACEMENT IS THE DESIGN\'S CALL, not this check\'s: put the capability where the approved mockup puts it — a menu item, a detail view, a settings screen all count as reachable. '
                  + 'This message never asks for a new top-level control; adding one to satisfy it is the wrong reading. '
                  + 'If you genuinely cannot build a capability this cycle: when the mockup SHOWS its control, ship that control disabled with a visible "Not built yet" badge; '
                  + 'when the mockup does not show it, leave it out and say so in your finish summary — the operator is told either way. Then re-call finish.',
              };
              const r = await rejectFinishOrConclude({
                validator: 'action-parity', termId, termName, decision, gateReports: lastGateReports,
                message: parityRejection.content, echo: false,
              });
              if (r === 'concluded') return scheduleJobCleanup(cycle.id);
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
      // Regression-gate escalation (run-taxonomy fix #3/C1) — decided HERE, not
      // at cycle start, because the diff isn't known until now (a fresh cycle's
      // tree is clean at start). A quick cycle whose diff touches user-facing
      // files runs the mvp battery instead: the gates that catch a visible
      // regression (ui-interaction, no-dead-controls, mobile-overflow, e2e)
      // previously ran only on greenfield/full builds — never on the lane that
      // produces most changes. The container already has both script sets
      // copied (see copyGatesIntoContainer above), so escalating costs nothing
      // extra to prepare.
      let effectiveGateScripts = gateScripts;
      let gateEscalated = false;
      if (cycleMode === BUILD_MODE_QUICK && escalationGateScripts && touchesUserFacing(changedThisCycle)) {
        effectiveGateScripts = escalationGateScripts;
        gateEscalated = true;
        try { updateCycle(cycle.id, { gates_json: JSON.stringify(initialGateReports(effectiveGateScripts)) }); } catch (e) { console.warn('[mock2] escalated gates_json stamp failed:', e?.message); }
        try {
          insertMessage({
            projectId, kind: 'system', cycleId: cycle.id,
            body: `Gate profile escalated: quick → mvp (this diff touches user-facing files: ${changedThisCycle.filter((f) => touchesUserFacing([f])).slice(0, 5).join(', ')}). Running ${effectiveGateScripts.map((g) => g.name).join(', ')}.`,
          });
        } catch { /* best effort */ }
        logEvent('note', { role: 'system', content: 'Gate profile escalated: quick → mvp (diff touches user-facing files).', meta: { escalated: true } });
      }
      // No battery in fast modes — skip both the run and the "Gate battery
      // (pending)" event noise; the deploy tail below is the verification.
      const battery = effectiveGateScripts.length ? await runGateBattery(cycle.id, containerName, effectiveGateScripts) : [];
      lastGateReports = battery;
      if (effectiveGateScripts.length) {
        logEvent('gate', { role: 'system', content: formatGateReports(battery), meta: { gates: battery, green: allGatesGreen(battery) } });
      }
      // A framework with zero gates (placeholder content, risk R8 — parseGateScripts
      // returns []) is vacuously green: there is nothing to fail, so finish is
      // accepted. Only reject finish when there ARE gates and one isn't green.
      if (effectiveGateScripts.length && !allGatesGreen(battery)) {
        // Not green — feed the finish call its verdict and keep working ("review,
        // not error"). The next model turn answers with fresh work — UNLESS the
        // breaker shows the cycle is just re-calling finish on the same red gates
        // with no new work, in which case halt (blocked) rather than loop.
        transcript.push({ role: 'tool', toolCallId: termId, name: termName, content: `Gates are not all green yet — you cannot finish. Battery:\n${formatGateReports(battery)}` });
        touchLock(projectId, holder);
        if (progress.tripped) {
          await haltCycle({ cycle: getCycle(cycle.id), project, containerName, holder, gateReports: battery, gateScripts: effectiveGateScripts, framework, trigger: progress.trigger, reason: `Auto-stopped after ${noProgLimit} turns with no progress (${haltReasonLabel(progress.trigger)}); gates still red.`, logEvent, consultSignals: haltSignals(`Auto-stopped after ${noProgLimit} turns with no progress (${haltReasonLabel(progress.trigger)}); gates still red.`) });
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
          cycle: getCycle(cycle.id), project, containerName, holder, gateReports: battery, gateScripts: effectiveGateScripts, framework,
          trigger, reason: bs.reason, options: bs.options, logEvent,
          consultSignals: haltSignals(bs.reason),
        });
        void notifyCycleComplete({ project: { id: projectId, name: project.name }, cycle: getCycle(cycle.id), outcome: 'blocked' });
        return scheduleJobCleanup(cycle.id);
      }
      // The change record carries the acceptance evidence (constitution §11):
      // summary + the acceptance/assumptions block, so a Reviewer can replay
      // the human-runnable checks straight from the record. The escalation
      // line rides along when this cycle's battery was widened (C1) — a
      // reviewer reading the record sees WHY a "quick" cycle ran mvp gates.
      // The gate-config notice (C3.2) is visibility, not a block: editing
      // checks is legitimate and often required by the ui-interaction gate
      // itself; the executed battery is always the pinned one regardless.
      const gateConfigTouched = gateConfigTouchedFiles(changedThisCycle);
      const recordSummary = `${decision.finishSummary}\n\n${formatAcceptanceBlock(decision.finishAcceptance, decision.finishAssumptions)}`
        + (gateEscalated ? '\n\nGate profile: quick → mvp (diff touches user-facing files)' : '')
        + (gateConfigTouched.length ? `\n\nGate config touched this cycle: ${gateConfigTouched.join(', ')}. The battery that judged this cycle was the pinned one; this change affects later cycles.` : '');
      logEvent('acceptance', {
        role: 'assistant',
        content: formatAcceptanceBlock(decision.finishAcceptance, decision.finishAssumptions),
        meta: { acceptance: decision.finishAcceptance, assumptions: decision.finishAssumptions },
      });
      const record = await checkpointAndRecord({ cycle: getCycle(cycle.id), project, containerName, holder, gateReports: battery, gateScripts: effectiveGateScripts, framework, summary: recordSummary });
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
      // A bug-fix that closed at a FRACTION of its estimate with no red
      // test HOLDS the deploy (anomaly.hold — the Goodhart signature): the
      // cycle still succeeds (work + record kept, gates already green), the
      // flag is raised for review, and the operator releases it with the
      // existing Deploy action once satisfied. Conservative option: hold,
      // never auto-rollback; the previous deploy keeps serving.
      // A full-effort fix that merely shipped without a test file is
      // flag-only (the post-deploy tripwire below raises it) and DEPLOYS —
      // holding on that stopped every routine test-less fix from
      // auto-redeploying (operator report, 2026-07-31).
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
        if (preAnomaly.hold && !noOpCycle) {
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
        const smoke = await smokeAfterDeploy({ containerName, appDir: APP_DIR, webPort: project.web_port || 3000, commitSha: record?.commit_sha, summary: decision.finishSummary, instruction: cycle.instruction, requiredIds: decision.finishAcceptanceIds || [], logEvent, env: process.env, reviewLogin, viewerLogin, projectId: project.id });
        // The smoke-side ledger rows, then the ledger itself. This is the last
        // stage that reports anything, so it is where the note gets written —
        // and it is written on the failure paths below too, because a build
        // that went red is exactly when "which platform features even ran"
        // stops being trivia. Instrumentation, so it can never throw.
        try {
          const sa = smoke.report?.browser?.screenAccounts;
          recordFeature(project.id, 'screen_accounts', sa ? 'fired' : 'skipped',
            sa || 'the spec declared no fixture users');
          recordFeature(project.id, 'first_run', smoke.notYetPossible ? 'fired' : 'skipped',
            smoke.notYetPossible
              ? 'no first administrator — session checks could not run'
              : 'the app has a first administrator (or nothing failed to explain)');
          const ledger = takeFeatureLedger(project.id);
          if (ledger.note) {
            logEvent('note', { role: 'system', content: ledger.note, meta: { feature_activation: ledger.summary } });
            insertMessage({ projectId, kind: 'system', cycleId: cycle.id, body: ledger.note });
          }
        } catch (e) { console.warn('[mock2] feature ledger failed:', e?.message); }
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
        } else if (!smoke.ok && smoke.baselineOnly) {
          // EVERY failure is a platform-owned check (fix 2.b; P47 request 140:
          // $10.28 / 3 cycles re-running a build against failures that were
          // not fixable from inside the app). The app's own checks passed and
          // the deploy works — so this cycle concludes SHIPPED, with the
          // platform failures named as the platform's, and no retry implied.
          // The failures are not hidden: they ride the chat message, the event
          // log, and a harness-triage flag — the base app or the platform
          // contract has to change, not the build.
          const product = (changedThisCycle || []).filter((f) => !/^state\//.test(f)
            && !/^public\/(build-id\.(js|txt)|sw\.js)$/.test(f));
          try {
            const { baselineBlockedMessage } = await import('./ui-check-logic.js');
            const msg = baselineBlockedMessage(smoke.baselineOnly, { emptyDiff: product.length === 0 });
            insertMessage({
              projectId, kind: 'system', cycleId: cycle.id,
              body: `**Shipped — platform checks failing (not yours).**\n\n${msg}`,
            });
          } catch (e) { console.warn('[mock2] baseline-only report failed:', e?.message); }
          safeRaise({
            kind: 'flag', project_id: projectId, dedupe_key: `mock2-baseline-smoke:${projectId}`,
            ref_table: 'mock2_cycles', ref_id: cycle.id,
            detail: `${project.name}: platform baseline check(s) failing after a build whose own checks passed: ${smoke.baselineOnly.ids.join(', ')}. Fix belongs in the platform, not in a build retry.`,
          });
          logEvent('note', {
            role: 'system',
            content: `Shipped — platform checks failing (not yours): ${smoke.baselineOnly.ids.join(', ')}. The deploy is kept; a build retry cannot clear these.`,
            meta: { baseline_only: true, ids: smoke.baselineOnly.ids },
          });
          // Falls through to the honest gate / pending-verification path below —
          // the cycle is NOT failed and nothing suggests running it again.
        } else if (!smoke.ok) {
          // PRE-EXISTING RED (P47 request 171): before failing the cycle over
          // check failures, ask whether every one of them was ALREADY red
          // before this build — parsed from the latest prior smoke-failed
          // cycle's recorded error. A pure-CSS change must not be marked
          // failed by a to-do bug it never touched; the cycle that FIRST
          // turned a check red still fails (there is no prior record naming
          // it), and a cycle that declared a red check as its own acceptance
          // fails on it however old the red is. Classification failing for
          // any reason fails CLOSED — the cycle fails, as before.
          let preexisting = null;
          try {
            const priorFailed = listCyclesForProject(projectId, { limit: 50 })
              .find((c) => c.id !== cycle.id && /smoke gate failed after deploy/i.test(String(c.error || '')));
            const { appOwnedFailureIds, preexistingSmokeVerdict, preexistingShippedMessage } = await import('./ui-check-logic.js');
            const v = preexistingSmokeVerdict({
              report: smoke.report,
              priorFailingIds: priorFailed ? appOwnedFailureIds(priorFailed.error) : [],
              requiredIds: decision.finishAcceptanceIds || [],
            });
            if (v.ship) preexisting = { ...v, message: preexistingShippedMessage({ preexisting: v.preexisting, results: smoke.report?.browser?.uiChecks || [] }) };
          } catch (e) { console.warn('[mock2] preexisting-smoke classification failed closed:', e?.message); }
          if (preexisting) {
            try {
              insertMessage({
                projectId, kind: 'system', cycleId: cycle.id,
                body: `**Shipped — pre-existing check failures (not this change).**\n\n${preexisting.message}`,
              });
            } catch { /* best effort */ }
            safeRaise({
              kind: 'flag', project_id: projectId, dedupe_key: `mock2-preexisting-smoke:${projectId}`,
              ref_table: 'mock2_cycles', ref_id: cycle.id,
              detail: `${project.name}: check(s) still red from before this build: ${preexisting.preexisting.join(', ')}. They fail every build until fixed by name.`,
            });
            logEvent('note', {
              role: 'system',
              content: `Shipped — pre-existing check failure(s), not this change's: ${preexisting.preexisting.join(', ')}. The deploy is kept; they stay red until a build fixes them by name.`,
              meta: { preexisting_smoke: true, ids: preexisting.preexisting },
            });
            // Falls through to the honest gate / pending-verification path
            // below — the cycle is NOT failed over reds it did not create.
          } else {
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
          // the check failures below it are the symptoms. (A failure set that
          // is ONLY platform baselines never reaches this branch — it
          // concludes shipped above. Anything here includes at least one
          // app-owned failure, and the summary lists app-owned ones first.)
          const error = readyLine
            ? `The deployed app is not reachable — ${readyLine}. Downstream: ${detail}`
            : `Smoke gate failed after deploy — ${detail}`;
          finishCycle(cycle.id, { status: 'failed', error });
          releaseLock(projectId, holder);
          setJob(cycle.id, { phase: 'smoke_failed', message: error, commit: record?.commit_sha || null });
          void notifyCycleComplete({ project: { id: projectId, name: project.name }, cycle: getCycle(cycle.id), outcome: 'smoke_failed' });
          // The failure is recorded — now diagnose it (fire-and-forget): the
          // top-tier review model reads the failing checks + the changed
          // files and posts the root cause with a build-ready fix
          // instruction, so the next attempt starts from evidence instead of
          // re-guessing (see runFailureDiagnosis).
          void runFailureDiagnosis({
            project, cycle, ready, smokeReport: smoke.report,
            changedFiles: changedThisCycle, finishSummary: decision.finishSummary, logEvent,
          }).catch((e) => console.warn('[mock2] failure diagnosis crashed:', e?.message));
          return scheduleJobCleanup(cycle.id);
          }
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
      // observed in a browser (the honest gate above), plus any role/permission
      // claim left in `assumed` (run-taxonomy fix #10/D3.5) — not rejected (this
      // is a legitimate but risky claim, not a malformed submission), just
      // folded into the same "a human still has to confirm this" path.
      const sensitiveAssumedChecklist = sensitiveAssumedEntries(decision.finishAssumptions?.assumed)
        .map((a) => `An assumption about roles/permissions was not verified this cycle: "${a}". Confirm this by hand before trusting access control on this change.`);
      const pendingChecklist = [...(integrationDecision?.checklist || []), ...(uiVerification.checklist || []), ...sensitiveAssumedChecklist];
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
      await haltCycle({ cycle: getCycle(cycle.id), project, containerName, holder, gateReports: lastGateReports, gateScripts, framework, trigger: progress.trigger, reason: `Auto-stopped after ${noProgLimit} turns with no progress: ${haltReasonLabel(progress.trigger)}.`, logEvent, consultSignals: haltSignals(`Auto-stopped after ${noProgLimit} turns with no progress: ${haltReasonLabel(progress.trigger)}.`) });
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
        ? await Promise.all(group.calls.map((call) => executeTool({ call, cycle, containerName, holder, gateScripts, webPort, probeState })))
        : [await executeTool({ call: group.calls[0], cycle, containerName, holder, gateScripts, webPort, probeState })];
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

// ---- runtime observation (run-taxonomy fix #1/B1) ----
//
// Nothing starts the app during a cycle — mock2-dev.service serves whatever
// the LAST DEPLOY left running, not the working tree a cycle is editing. So a
// probe against "deployed" sees the operator's reality (right for reproducing
// a report), but a probe against "working" needs the app rebuilt and
// restarted from the current tree first, or it would silently observe stale
// code. restartDevFromWorkingTree is that bridge: build (the mock2.yaml
// DECLARED build command — never assumed) + restart the SAME unit, no
// migrations, no gate battery, no checkpoint. Deliberately NOT deployStage:
// deployStage migrates, is queued per container, and stamps deploy state —
// side effects a probe must not have.

// restartDevFromWorkingTree(containerName, webPort) → { ok, detail }. Never
// throws. Falls back to reporting failure rather than silently leaving the
// prior (stale) build serving.
async function restartDevFromWorkingTree(containerName, webPort) {
  let contract;
  try {
    contract = await readRunContract(containerName, APP_DIR);
  } catch (e) {
    return { ok: false, detail: `could not read the run contract: ${e?.message || e}` };
  }
  if (!contract.hasContract) {
    return { ok: false, detail: 'no run contract yet (mock2.yaml has no run: block) — nothing to rebuild against' };
  }
  const buildCmd = contract.build || 'npm run build';
  const buildScript = `cd '${APP_DIR}' 2>/dev/null || cd /\n${buildCmd}\necho "__MOCK2_PROBE_BUILD_EXIT__:$?"`;
  const built = await containerSh(containerName, buildScript, { timeoutMs: 180000 });
  const buildOut = built.stdout || '';
  const exitMatch = buildOut.match(/__MOCK2_PROBE_BUILD_EXIT__:(\d+)/);
  const buildExit = exitMatch ? Number(exitMatch[1]) : (built.code ?? 1);
  if (buildExit !== 0) {
    const tail = buildOut.replace(/__MOCK2_PROBE_BUILD_EXIT__:\d+\s*$/, '').trim().slice(-2000);
    return { ok: false, detail: `build failed (exit ${buildExit}) before the restart:\n${tail}` };
  }
  await containerSh(containerName, 'systemctl restart mock2-dev.service', { timeoutMs: 30000 });
  // Short readiness poll (this is a warm restart, not a cold deploy — deploy.js's
  // own health check uses 45 attempts x 2s; a probe doesn't need that long).
  const poll = await containerSh(
    containerName,
    'last="000"\ni=0\nwhile [ $i -lt 20 ]; do\n'
      + `  code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:${webPort}/" 2>/dev/null)\n`
      + '  [ -n "$code" ] && last="$code"\n'
      + '  if [ -n "$code" ] && [ "$code" != "000" ] && [ "$code" -lt 500 ]; then echo "MOCK2_SERVING ($code)"; exit 0; fi\n'
      + '  i=$((i+1)); sleep 1\n'
      + 'done\n'
      + 'echo "MOCK2_NOT_SERVING (last http_code: $last)"\n',
    { timeoutMs: 30000 },
  );
  if (!/MOCK2_SERVING/.test(poll.stdout || '')) {
    return { ok: false, detail: `rebuilt, but the app did not come back up after restart: ${(poll.stdout || '').trim().slice(-500)}` };
  }
  return { ok: true, detail: 'rebuilt and restarted from the working tree' };
}

// runHttpProbe — one curl round-trip against the app's OWN port inside the
// container. The fence already blocks external egress; this never reaches
// beyond loopback because the URL is CONSTRUCTED here (probe-logic.
// httpProbeCommand), never taken from the model. Never throws — every failure
// mode returns formatted text, matching every other executeTool case.
async function runHttpProbe({ containerName, webPort, input }) {
  const plan = httpProbePlan(input || {});
  if (plan.error) return `error: ${plan.error}`;
  if (plan.target === 'working') {
    const restarted = await restartDevFromWorkingTree(containerName, webPort);
    if (!restarted.ok) return `error: could not prepare the working build for probing — ${restarted.detail}`;
  }
  let r;
  try {
    r = await execInContainer(containerName, httpProbeCommand({ webPort, method: plan.method, path: plan.path, headers: plan.headers, body: plan.body }));
  } catch (e) {
    return formatHttpProbeResult({ target: plan.target, method: plan.method, path: plan.path, raw: { error: `probe crashed: ${e?.message || e}` } });
  }
  if (r.code !== 0 && !(r.stdout || '').trim()) {
    return formatHttpProbeResult({ target: plan.target, method: plan.method, path: plan.path, raw: { error: `curl exited ${r.code}: ${(r.stderr || r.stdout || '').slice(-300)}` } });
  }
  const raw = parseCurlDashI(r.stdout || '');
  return formatHttpProbeResult({ target: plan.target, method: plan.method, path: plan.path, raw });
}

// runBrowserProbeTool — resolve the target/login context and hand off to the
// pure executor (browser-probe.js). Playwright runs in the BACKEND process,
// not the container, so the base URL is the container's own IP (the same
// resolveBrowserTarget smoke.js uses — 127.0.0.1 from the host fails
// ERR_CONNECTION_REFUSED, the bug that fix already exists to avoid), never
// localhost. Never throws.
async function runBrowserProbeTool({ containerName, webPort, input }) {
  const plan = browserProbePlan(input || {});
  if (plan.error) return `error: ${plan.error}`;
  if (plan.target === 'working') {
    const restarted = await restartDevFromWorkingTree(containerName, webPort);
    if (!restarted.ok) return `error: could not prepare the working build for probing — ${restarted.detail}`;
  }
  let spec = null;
  if (plan.role) {
    try {
      const r = await readFileInContainer(containerName, UI_CHECKS_PATH);
      if (r.ok) {
        const parsed = parseUiChecks(r.content);
        if (parsed.ok) spec = parsed.spec;
      }
    } catch { spec = null; }
  }
  let baseUrl;
  try {
    baseUrl = await resolveBrowserTarget(containerName, webPort);
  } catch (e) {
    return `error: could not resolve the container's address for the browser connector: ${e?.message || e}`;
  }
  let result;
  try {
    result = await runBrowserProbe({ baseUrl, spec, input: plan });
  } catch (e) {
    return `error: browser probe crashed: ${e?.message || e}`;
  }
  return formatBrowserProbeResult(result);
}

// ---- tool execution against the fenced container ----

async function executeTool({ call, cycle, containerName, holder, gateScripts, webPort, probeState }) {
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
    case 'http_probe': {
      const budget = probeBudget(probeState?.used ?? 0, PROBE_MAX_PER_CYCLE);
      if (!budget.allowed) return { content: budget.message };
      if (probeState) probeState.used += 1;
      touchLock(cycle.project_id, holder);
      const content = await runHttpProbe({ containerName, webPort, input: call.input || {} });
      return { content };
    }
    case 'browser_probe': {
      const budget = probeBudget(probeState?.used ?? 0, PROBE_MAX_PER_CYCLE);
      if (!budget.allowed) return { content: budget.message };
      if (probeState) probeState.used += 1;
      touchLock(cycle.project_id, holder);
      const content = await runBrowserProbeTool({ containerName, webPort, input: call.input || {} });
      return { content };
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
  // The resolved per-phase model map (when this cycle was phase-routed) rides
  // in the record so any cycle can be reproduced from its change record alone.
  let phaseLine = null;
  try { phaseLine = phaseMapRecordLine(parseRoutingJson(getCycle(cycle.id)?.routing_json)); } catch { /* best effort */ }
  const recordSummaryText = `${summary || 'checkpoint'}${phaseLine ? `\n\n${phaseLine}` : ''}${diffStat ? `\n\nDiff (this checkpoint):\n${diffStat}` : ''}`;

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

// concludeCycle — the ONE terminal exit for a build cycle. Every path that ends
// a cycle goes through here so the ledger has an entry for every cycle id: a
// cycle row with no change record is invisible to the audit spine, which is how
// crashed and refused cycles became "unlogged cycle IDs".
//
// Writes the richest record the situation allows:
//   * container + holder present  → full checkpointAndRecord (commit + diff)
//   * otherwise                   → a minimal record: no commit, no diff, but a
//                                   seq, a hash-chain link, and the reason.
// framework is optional — when the caller doesn't have it in scope (retryDeploy,
// acceptPendingVerification, the crash handler), it is resolved from the
// cycle's own pinned framework_version_id (ADR-003: the pin never changes).
// Never throws: a failure to record must not mask the failure being recorded.
export async function concludeCycle({
  cycle, project, framework = null, status, error = null,
  containerName = null, holder = null, gateReports = null, gateScripts = null,
  summary = null, logEvent = null,
}) {
  const plan = terminalRecordPlan({ containerName, holder, summary, status, error });
  let recordSummary = plan.summary;

  let fw = framework;
  if (!fw) {
    try { fw = getFrameworkVersion(cycle.framework_version_id); } catch (e) { console.warn('[mock2] concludeCycle: framework lookup failed:', e?.message); fw = null; }
  }

  let record = null;
  if (plan.strategy === 'checkpoint' && fw) {
    try {
      record = await checkpointAndRecord({
        cycle, project, containerName, holder,
        gateReports: gateReports || [], gateScripts, framework: fw,
        summary: recordSummary,
      });
    } catch (e) {
      console.warn('[mock2] concludeCycle checkpoint failed:', e?.message);
      recordSummary = `${recordSummary} (checkpoint failed: ${e?.message || e})`;
    }
  }

  if (!record) {
    if (fw) {
      try {
        record = insertChangeRecord({
          projectId: Number(project.id),
          cycleId: cycle.id,
          initiatedBy: cycle.initiated_by ?? null,
          actingAsAdmin: cycle.acting_as_admin ? 1 : 0,
          frameworkVersion: fw.version,
          frameworkVersionId: fw.id,
          rulesTouched: null,
          gatesRun: gateReports ? gateReports.map((g) => ({ name: g.name, result: g.status })) : null,
          commitSha: null,
          summary: recordSummary,
        });
      } catch (e) {
        console.warn('[mock2] concludeCycle minimal record failed:', e?.message);
      }
    } else {
      console.warn(`[mock2] concludeCycle: no framework resolvable for cycle ${cycle.id} — no change record written`);
    }
  }

  finishCycle(cycle.id, { status, error });

  if (typeof logEvent === 'function') {
    try {
      logEvent('note', { role: 'system', content: recordSummary, meta: { terminal: status, recorded: !!record } });
    } catch { /* best effort */ }
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
async function escalateAwaitingAdmin({ cycle, project, framework = null, containerName, holder, gateReports = null, gateScripts = null, reason }) {
  const projectId = Number(project.id);
  // Checkpoint + record the WIP so the branch is at a recoverable state — this
  // used to be a raw commit with no change record, which is exactly the
  // invisible-cycle gap concludeCycle exists to close.
  await concludeCycle({
    cycle, project, framework, containerName, holder, gateReports, gateScripts,
    status: 'awaiting_admin', error: `retries exhausted: ${reason}`,
    summary: 'checkpoint: auto (retries exhausted)',
  });
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

  // Verify the checkpointed tree BEFORE deciding what the halt record says
  // (run-taxonomy fix #5/D1). Previously gateReports was whatever happened to
  // have run before the halt — usually nothing — so a resume's record showed
  // gates_run: [] regardless of how much landed work was actually there. Run
  // the SAME battery a resume would run (the requested one, not a stricter
  // one that would fail on in-progress work for unrelated reasons) against
  // the tree this checkpoint is about to commit. Best-effort: a failure here
  // keeps the pre-halt reports rather than claiming a battery that didn't run.
  let verifiedGateReports = gateReports || [];
  if (containerName && gateScripts?.length) {
    try {
      verifiedGateReports = await runGateBattery(cycle.id, containerName, gateScripts);
    } catch (e) {
      console.warn('[mock2] halt verification battery failed:', e?.message);
    }
  }

  // Best-effort WIP checkpoint + change record so the branch and any report the
  // cycle wrote are recoverable when a human resumes.
  let record = null;
  try {
    record = await checkpointAndRecord({
      cycle, project, containerName, holder, gateReports: verifiedGateReports, gateScripts, framework,
      summary: haltSummaryWithLandedWork({ trigger, reason, gateReports: verifiedGateReports }),
    });
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
