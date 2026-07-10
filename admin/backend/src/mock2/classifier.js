// Mock2 rule-change CLASSIFIER orchestration (Phase M9, ADR-002; the steady-state
// iteration loop the user actually lives in). After the design is approved, every
// chat message is an ITERATION message: the classifier runs on it FIRST, compares
// the requested change against the confirmed state/rules.md + the pinned
// constitution, and routes by outcome (biased to flag):
//
//   * implements  → build directly (proceedToBuild — the SAME hand-off the audit
//                   uses; ADR-002);
//   * contradicts → an EDITOR rule_contradiction question (reconfirm flow), the
//                   build deferred until it's answered;
//   * unaddressed → an EDITOR rule_gap question (lazy rule), then build.
//
// The DECISIONS are the pure classifier-logic.js (unit-tested stub-first, risk R9);
// this module is the host/model orchestration. It mirrors audit.js: the classifier
// runs on the classifier slot through the SAME callModelTurn (tools [] — a JSON
// decision out), the 202+poll job pattern, every container read through host.js
// (R3), the decrypted key ORCHESTRATOR-SIDE only, and the spend priced on the
// slot (R5). It REUSES the M8 question plumbing wholesale — questions.insertQuestion
// + the rule_question chat message + audit.answerAuditQuestion + maybeResumeBuild —
// so there is no second question path (ADR-002).
//
// The checkout lock (ADR-004): the classifier READS the container (rules +
// inventory) so it does not take the lock; a resulting rule question's ANSWER
// writes state/rules.md and takes it (audit.answerAuditQuestion), and a build that
// proceeds takes it as the cycle holder (startCycle).
//
// Terminology (risk R7): the AI build component is the runner; nothing here is
// named "agent".

import { sh, b64 } from './host.js';
import { getProject } from './projects.js';
import { containerNameForProject } from './provision.js';
import { getSlot, getConnector, decryptConnectorKey, listPrices } from './connectors.js';
import { parseCapabilities, slotAssignmentError, isCloudProvider } from './connector-logic.js';
import { getApplicableQuota, periodUsage, insertLedgerEntry } from './quotas.js';
import { canStartCycle, costCentsForUsage } from './quota-logic.js';
import { getCurrentFrameworkVersion } from './framework.js';
import {
  insertCycle, getCycle, updateCycle, addCycleUsage, finishCycle, countRunningCycles,
} from './cycles.js';
import { getLock } from './locks.js';
import { insertMessage, getOrCreateChat } from './chats.js';
import { insertQuestion, countOpenEditorQuestions } from './questions.js';
import { INVENTORY_PATH } from './concept-logic.js';
import { buildRuleQuestionBody, routeForKind } from './audit-logic.js';
import { buildRunnerReady } from './runner.js';
import { proceedToBuild } from './audit.js';
import { callModelTurn } from './model-client.js';
import {
  buildClassifierSystemPrompt, buildClassifierTask, parseClassifierResult,
  normalizeOutcome, proceedsToBuild, classifierQuestionKind, fallbackQuestion,
  estimateClassifierTokens,
} from './classifier-logic.js';

const APP_DIR = '/srv/app';
const RULES_PATH = 'state/rules.md';
const nowIso = () => new Date().toISOString();
const MAX_CLASSIFIER_INPUT_CHARS = 120000;

// Live classifier-job progress, keyed by project id (house 202+poll pattern). The
// chat poll endpoint reads this; entries drop a couple minutes after the classify
// settles. One iteration turn per project at a time (the guards serialize it).
export const activeClassifierJobs = new Map();

export function getClassifierJobStatus(projectId) {
  return activeClassifierJobs.get(Number(projectId)) || null;
}

function setJob(projectId, patch) {
  const cur = activeClassifierJobs.get(Number(projectId)) || {};
  activeClassifierJobs.set(Number(projectId), { ...cur, ...patch, updatedAt: Date.now() });
}
function scheduleJobCleanup(projectId) {
  setTimeout(() => activeClassifierJobs.delete(Number(projectId)), 120000);
}

function classifierJobActive(projectId) {
  const j = activeClassifierJobs.get(Number(projectId));
  return !!j && !['done', 'building', 'awaiting_user', 'failed'].includes(j.phase);
}

// ---- slot readiness (the classifier slot, ADR-001 presence-of-creds) ----

// Mirrors audit.auditReady() / concept.conceptReady().
export function classifierReady() {
  const slot = getSlot('classifier');
  if (!slot) return { ok: false, reason: 'No classifier model slot is assigned. Assign one under Model connectors.' };
  const connector = getConnector(slot.connector_id);
  if (!connector) return { ok: false, reason: 'The classifier slot points at a missing connector.' };
  if (!connector.enabled) return { ok: false, reason: 'The classifier connector is disabled.' };
  const capErr = slotAssignmentError(parseCapabilities(connector.capabilities), 'classifier');
  if (capErr) return { ok: false, reason: capErr };
  const apiKey = decryptConnectorKey(connector);
  if (isCloudProvider(connector.provider) && !apiKey) {
    return { ok: false, reason: 'The classifier connector has no decryptable API key.' };
  }
  return { ok: true, connector, model: slot.model, apiKey };
}

// ---- pricing + quota (mirrors runner/audit; the classifier spends too, R5) ----

function effectivePrice(connectorId, model) {
  const now = nowIso();
  return listPrices(connectorId).find((p) => p.model === model && String(p.effective_at) <= now) || null;
}

function estimateClassifierCostCents(ready) {
  return costCentsForUsage(estimateClassifierTokens(), effectivePrice(ready.connector.id, ready.model));
}

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

function recordSpend({ projectId, cycleId, connector, model, usage }) {
  const cents = costCentsForUsage({ inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }, effectivePrice(connector.id, model));
  addCycleUsage(cycleId, { tokens: (usage.inputTokens || 0) + (usage.outputTokens || 0), costCents: cents });
  try {
    insertLedgerEntry({ projectId, cycleId, connectorId: connector.id, model, inputTokens: usage.inputTokens || 0, outputTokens: usage.outputTokens || 0, costCents: cents, wallClockMs: 0 });
  } catch (e) { console.warn('[mock2] classifier ledger write failed:', e?.message); }
}

// ---- container IO (the classifier READS rules + inventory) ----

function containerSh(containerName, script, { timeoutMs = 60000 } = {}) {
  return sh(`printf '%s' '${b64(script)}' | base64 -d | incus exec ${containerName} -- sh`, { timeoutMs });
}

async function readWorkingFile(containerName, relPath) {
  const r = await containerSh(containerName, `cat "${APP_DIR}/${relPath}" 2>/dev/null`);
  if (r.code !== 0) return { ok: false, content: '' };
  return { ok: true, content: r.stdout || '' };
}

// ---- start (the /chat route calls this on an iteration message; 202 + poll) ----

// startIteration — the post-approval chat entry. Synchronous setup (guards, insert
// the user message, quota pre-check, create the classifier cycle), then fire the
// background classify. Returns
// { status:'started'|'refused'|'error', cycle, userMessage, error }.
export async function startIteration({ project, message, user, actingAsAdmin = 0 }) {
  const projectId = Number(project.id);

  if (project.lifecycle !== 'active') {
    return { status: 'error', error: `The project must be online to iterate (it is "${project.lifecycle}"). Bring it online first.` };
  }
  if (!project.design_approved_at) {
    return { status: 'error', error: 'The design is not approved yet — iterate in Concept until you approve the design.' };
  }
  const existingLock = getLock(projectId);
  if (existingLock && (existingLock.holder_cycle_id != null || existingLock.holder_user_id != null)) {
    return { status: 'error', error: 'This project is checked out by another writer. Wait, or request a takeover.' };
  }
  if (classifierJobActive(projectId)) {
    return { status: 'error', error: 'An iteration is already being processed for this project.' };
  }
  // A rule question from a previous iteration is still open — confirm it before
  // starting another change (one deferred build at a time; the answer resumes it).
  if (countOpenEditorQuestions(projectId) > 0) {
    return { status: 'error', error: 'Confirm the open rule question first — its build starts automatically once answered.' };
  }
  const ready = classifierReady();
  if (!ready.ok) return { status: 'error', error: ready.reason };
  // Fail fast if the eventual build has no model (the classifier would spend, then
  // the build would refuse). buildRunnerReady is a runner READ API.
  const runner = buildRunnerReady();
  if (!runner.ok) return { status: 'error', error: runner.reason };

  const framework = getCurrentFrameworkVersion();
  if (!framework) return { status: 'error', error: 'No framework version exists to pin. Publish one first.' };

  // Record the Builder's iteration message (acting_as_admin stamped, ADR-007).
  getOrCreateChat(projectId);
  const userMessage = insertMessage({ projectId, authorUserId: user.id, actingAsAdmin, kind: 'user', body: String(message || '').slice(0, 4000) });

  // Quota PRE-CYCLE check (R5 — the classifier spends). A refusal is reported
  // plainly and nothing is built (the "pre-cycle refusal message").
  const estCostCents = estimateClassifierCostCents(ready);
  const { verdict } = quotaVerdict(projectId, estCostCents);
  if (!verdict.ok) {
    const refused = insertCycle({
      projectId, frameworkVersionId: framework.id, stage: 'define', instruction: String(message || '').slice(0, 2000),
      initiatedBy: user.id, actingAsAdmin, estCostCents, status: 'refused_quota',
    });
    updateCycle(refused.id, { trigger_message_id: userMessage.id });
    finishCycle(refused.id, { status: 'refused_quota', error: verdict.reason });
    insertMessage({ projectId, kind: 'system', cycleId: refused.id, body: `This change wasn't started — ${verdict.reason}` });
    return { status: 'refused', cycle: getCycle(refused.id), userMessage, error: verdict.reason };
  }

  // The classifier cycle (stage 'define' — the rule gate before Build). It holds
  // the classifier_outcome stamp + any question and remembers the iteration
  // instruction to resume with once the gate clears.
  const cycle = insertCycle({
    projectId, frameworkVersionId: framework.id, stage: 'define', instruction: String(message || '').slice(0, 2000),
    initiatedBy: user.id, actingAsAdmin, estCostCents, status: 'running',
  });
  updateCycle(cycle.id, { started_at: nowIso(), trigger_message_id: userMessage.id });
  setJob(projectId, { phase: 'classifying', message: 'Checking the change against your rules…', cycleId: cycle.id, startedAt: Date.now() });

  runClassifier({ project, cycle: getCycle(cycle.id), ready, framework, user, actingAsAdmin, message: String(message || '') })
    .catch((err) => {
      console.error(`[mock2] classifier crashed for project ${projectId}:`, err?.message || err);
      try { finishCycle(cycle.id, { status: 'failed', error: `classifier crashed: ${err?.message || err}` }); } catch { /* ignore */ }
      try { insertMessage({ projectId, kind: 'system', cycleId: cycle.id, body: `Something went wrong checking that change: ${err?.message || err}` }); } catch { /* ignore */ }
      setJob(projectId, { phase: 'failed', message: `classifier crashed: ${err?.message || err}` });
      scheduleJobCleanup(projectId);
    });

  return { status: 'started', cycle: getCycle(cycle.id), userMessage };
}

async function runClassifier({ project, cycle, ready, framework, user, actingAsAdmin, message }) {
  const projectId = Number(project.id);
  const containerName = project.container_name || containerNameForProject(projectId);

  // 1) Read the inputs the classifier decides against: the confirmed rules +
  //    the approved inventory (the UI contract).
  const rules = await readWorkingFile(containerName, RULES_PATH);
  const inv = await readWorkingFile(containerName, INVENTORY_PATH);
  const rulesMd = String(rules.content || '').slice(0, MAX_CLASSIFIER_INPUT_CHARS);
  const inventoryText = String(inv.content || '').slice(0, MAX_CLASSIFIER_INPUT_CHARS);

  // 2) Run the classifier on the classifier slot (a reasoning task; no tools — a
  //    small JSON decision out).
  const res = await callModelTurn({
    connector: ready.connector, apiKey: ready.apiKey, model: ready.model,
    system: buildClassifierSystemPrompt({ constitution: framework.constitution_md, projectName: project.name }),
    tools: [],
    transcript: [{ role: 'user', text: buildClassifierTask({ message, rulesMd, inventory: inventoryText || null, projectName: project.name }) }],
    maxTokens: 2000,
  });
  if (res.ok) recordSpend({ projectId, cycleId: cycle.id, connector: ready.connector, model: ready.model, usage: res.usage });
  const parsed = res.ok ? parseClassifierResult(res.text) : { ok: false, error: res.error };
  if (!parsed.ok) {
    // A hard model failure — do NOT silently build. Surface it and stop.
    finishCycle(cycle.id, { status: 'failed', error: `classifier failed: ${parsed.error}` });
    insertMessage({ projectId, kind: 'system', cycleId: cycle.id, body: `Couldn't check that change against your rules: ${parsed.error}. Nothing was built — try again.` });
    setJob(projectId, { phase: 'failed', message: parsed.error });
    return scheduleJobCleanup(projectId);
  }

  const outcome = normalizeOutcome(parsed.outcome);
  // Stamp mock2_cycles.classifier_outcome (migration 502) — the record of how this
  // iteration was classified.
  updateCycle(cycle.id, { classifier_outcome: outcome });

  // 3a) implements → the change respects a confirmed rule; build directly (ADR-002).
  if (proceedsToBuild(outcome)) {
    const note = parsed.matchedRule
      ? `This matches a rule you already confirmed (“${String(parsed.matchedRule).slice(0, 140)}”) — building it now.`
      : 'This fits your confirmed rules — building it now.';
    insertMessage({ projectId, authorUserId: null, kind: 'assistant', cycleId: cycle.id, body: note });
    finishCycle(cycle.id, { status: 'succeeded' });
    setJob(projectId, { phase: 'building', message: 'Rule matched — starting the build.', cycleId: cycle.id });
    await proceedToBuild({ project: getProject(projectId), instruction: message, initiatedBy: cycle.initiated_by, actingAsAdmin, framework });
    return scheduleJobCleanup(projectId);
  }

  // 3b) contradicts / unaddressed → a lazy EDITOR question, build deferred. REUSE
  //     the M8 rule_question plumbing (ADR-002 — no second question path). Both
  //     kinds are EDITOR-routed (a domain rule never goes to the admin queue, so
  //     an admin answer is rejected for it); routeForKind confirms it.
  const kind = classifierQuestionKind(outcome); // rule_contradiction | rule_gap
  const questionText = parsed.question || fallbackQuestion(outcome, { message });
  const row = insertQuestion({
    projectId, cycleId: cycle.id, route: routeForKind(kind), kind, question: questionText, choices: parsed.choices,
  });
  insertMessage({
    projectId, kind: 'rule_question', cycleId: cycle.id, questionId: row.id,
    body: buildRuleQuestionBody({ question: questionText, choices: parsed.choices }),
  });
  updateCycle(cycle.id, { status: 'awaiting_user' });

  const lead = outcome === 'contradicts'
    ? 'This change may conflict with a rule you already confirmed.'
    : 'This change raises a new rule I should confirm with you.';
  insertMessage({
    projectId, kind: 'system', cycleId: cycle.id,
    body: `${lead} Confirm the rule question below — the build starts automatically once it's answered.`,
  });
  setJob(projectId, { phase: 'awaiting_user', message: 'Waiting on a rule confirmation.', cycleId: cycle.id });
  scheduleJobCleanup(projectId);
}
