// Mock2 AUDIT step — the two-way routing that gates Build (Phase M8, ADR-002).
// When a Builder presses Build, this compares the approved inventory + any
// existing state/rules.md + the pinned framework and produces a list of
// questions, split by route (audit-logic.routeForKind): editor questions render
// as tappable choices in the chat and their answers append to state/rules.md
// (the rules-confirmation sign-off — sign-off #2); framework deviations
// materialize as items in the admin queue. No questions → Build starts
// immediately (hand off to the existing runner startCycle).
//
// The DECISIONS are the pure audit-logic.js (unit-tested stub-first); this module
// is the host/model orchestration. It mirrors concept.js: the audit runs on the
// audit slot through the SAME callModelTurn with its own restricted policy (no
// tools — a JSON question list out, like the M7 inventory extraction), the 202+
// poll job pattern, every container op through host.js (R3), and the decrypted
// model key read ORCHESTRATOR-SIDE only.
//
// The checkout lock (ADR-004): the audit READS the container (inventory + rules)
// so it does not take the lock; but an answer that WRITES state/rules.md takes it
// (like the M7 concept chat write), checkpoints, and releases. A build that
// proceeds hands off to startCycle, which takes the lock as the cycle holder.
//
// Terminology (risk R7): nothing here is named "agent".

import { sh, b64 } from './host.js';
import { getProject, updateProject } from './projects.js';
import { containerNameForProject } from './provision.js';
import { buildCheckpointScript } from './template.js';
import { getSlot, getConnector, decryptConnectorKey, effectivePrice } from './connectors.js';
import { parseCapabilities, slotAssignmentError, isCloudProvider } from './connector-logic.js';
import { getApplicableQuota, periodUsage, insertLedgerEntry } from './quotas.js';
import { canStartCycle, costCentsForUsage } from './quota-logic.js';
import { getCurrentFrameworkVersion, getFrameworkVersion } from './framework.js';
import {
  insertCycle, getCycle, updateCycle, addCycleUsage, finishCycle, countRunningCycles,
} from './cycles.js';
import { insertRequest } from './requests.js';
import { getLock, acquireLock, releaseLock, touchLock } from './locks.js';
import { insertChangeRecord, changeRecordMirror } from './change-records.js';
import { getProjectRemote, pushProjectRemote } from './git-connectors.js';
import { insertMessage, getOrCreateChat } from './chats.js';
import {
  insertQuestion, getQuestion, answerQuestion, dismissQuestion, updateQuestionText,
  countOpenEditorQuestions, countOpenAdminQuestions, listQuestionsForCycle,
} from './questions.js';
import { raiseQueueItem, resolveQueueItem, countAwaitingAdminItems } from './queue.js';
import { INVENTORY_PATH } from './concept-logic.js';
import { getChatMaxChars } from './settings.js';
import {
  listPublishedComponents, listProjectComponents, insertProjectComponentSuggestion,
  getProjectComponentByQuestion, decideProjectComponent,
} from './components.js';
import {
  parseContractJson, extractCapabilities, suggestComponentsForCapabilities,
  buildComponentSuggestionQuestion, parseComponentSuggestionAnswer,
} from './component-logic.js';
import { preinstallComponents } from './component-install.js';
import { buildRunnerReady, startCycle } from './runner.js';
import { callModelTurn } from './model-client.js';
import {
  buildAuditSystemPrompt, buildAuditTask, parseAuditQuestions, splitQuestionsByRoute,
  buildRuleQuestionBody, appendRule, auditGateCleared, blockedBuildStatus,
  isFrameworkDrifted, driftLabel, estimateAuditTokens,
  buildAdminDecisionsBlock, markDeviationDecision,
} from './audit-logic.js';
import { approveAsEditedText } from './unblock-logic.js';

const APP_DIR = '/srv/app';
const RULES_PATH = 'state/rules.md';
const nowIso = () => new Date().toISOString();

const MAX_AUDIT_INPUT_CHARS = 120000; // cap inventory/rules fed to the auditor (R5)

// Live audit-job progress, keyed by project id (house 202+poll pattern). The
// chat/build poll endpoints read this; entries drop a couple minutes after the
// audit settles. One audit per project at a time (the guards serialize it).
export const activeAuditJobs = new Map();

export function getAuditJobStatus(projectId) {
  return activeAuditJobs.get(Number(projectId)) || null;
}

function setJob(projectId, patch) {
  const cur = activeAuditJobs.get(Number(projectId)) || {};
  activeAuditJobs.set(Number(projectId), { ...cur, ...patch, updatedAt: Date.now() });
}
function scheduleJobCleanup(projectId) {
  setTimeout(() => activeAuditJobs.delete(Number(projectId)), 120000);
}

function auditJobActive(projectId) {
  const j = activeAuditJobs.get(Number(projectId));
  return !!j && !['done', 'building', 'awaiting_user', 'awaiting_admin', 'failed'].includes(j.phase);
}

// ---- slot readiness (the audit slot, ADR-001 presence-of-creds) ----

export function auditReady() {
  const slot = getSlot('audit');
  if (!slot) return { ok: false, reason: 'No audit model slot is assigned. Assign one under Model connectors.' };
  const connector = getConnector(slot.connector_id);
  if (!connector) return { ok: false, reason: 'The audit slot points at a missing connector.' };
  if (!connector.enabled) return { ok: false, reason: 'The audit connector is disabled.' };
  const capErr = slotAssignmentError(parseCapabilities(connector.capabilities), 'audit');
  if (capErr) return { ok: false, reason: capErr };
  const apiKey = decryptConnectorKey(connector);
  if (isCloudProvider(connector.provider) && !apiKey) {
    return { ok: false, reason: 'The audit connector has no decryptable API key.' };
  }
  return { ok: true, connector, model: slot.model, apiKey };
}

// ---- pricing + quota (mirrors runner/concept; the audit step spends too, R5) ----
// Pricing (effectivePrice) is shared from connectors.js so every stage prices the
// same way, with the built-in default rate as the fallback.

function estimateAuditCostCents(ready) {
  return costCentsForUsage(estimateAuditTokens(), effectivePrice(ready.connector.id, ready.model));
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
  const cacheRead = usage.cacheReadInputTokens || 0;
  const cacheWrite = usage.cacheCreationInputTokens || 0;
  const cents = costCentsForUsage({ inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite }, effectivePrice(connector.id, model));
  // Cost is cache-aware; the token count is fresh input + output (see runner.js).
  addCycleUsage(cycleId, { tokens: (usage.inputTokens || 0) + (usage.outputTokens || 0), costCents: cents });
  try {
    insertLedgerEntry({ projectId, cycleId, connectorId: connector.id, model, inputTokens: usage.inputTokens || 0, outputTokens: usage.outputTokens || 0, costCents: cents, wallClockMs: 0 });
  } catch (e) { console.warn('[mock2] audit ledger write failed:', e?.message); }
}

// ---- container IO (the audit READS; an answer WRITES rules.md) ----

function containerSh(containerName, script, { timeoutMs = 120000 } = {}) {
  return sh(`printf '%s' '${b64(script)}' | base64 -d | incus exec ${containerName} -- sh`, { timeoutMs });
}

async function readWorkingFile(containerName, relPath) {
  const r = await containerSh(containerName, `cat "${APP_DIR}/${relPath}" 2>/dev/null`);
  if (r.code !== 0) return { ok: false, error: 'not found' };
  return { ok: true, content: r.stdout || '' };
}

async function writeWorkingFile(containerName, relPath, content) {
  const script = `d="${APP_DIR}/${relPath}"; mkdir -p "$(dirname "$d")"; printf '%s' '${b64(content)}' | base64 -d > "$d" && echo ok`;
  const r = await containerSh(containerName, script);
  if (r.code !== 0) return { ok: false, error: (r.stderr || r.stdout || 'write failed').trim().slice(-300) };
  return { ok: true };
}

async function checkpoint(containerName, message) {
  const cp = buildCheckpointScript({ appDir: APP_DIR, message });
  const r = await containerSh(containerName, cp, { timeoutMs: 120000 });
  if (r.code !== 0) console.warn(`[mock2] audit checkpoint non-zero: ${(r.stdout || r.stderr || '').trim().slice(-300)}`);
  const sha = await containerSh(containerName, `git -C "${APP_DIR}" rev-parse HEAD 2>/dev/null`);
  return (sha.stdout || '').trim().split('\n').pop() || null;
}

async function maybePushRemote(projectId) {
  try {
    const remote = getProjectRemote(projectId);
    if (remote?.push_on_checkpoint) {
      const push = await pushProjectRemote(getProject(projectId));
      if (!push.ok) console.warn(`[mock2] audit push_on_checkpoint failed for ${projectId}: ${push.error}`);
    }
  } catch (e) { console.warn('[mock2] audit push_on_checkpoint error:', e?.message); }
}

// ---- drift detection (ADR-003 — pinned-at-last-build vs current) ----

function driftDedupeKey(projectId) { return `mock2-drift:${projectId}`; }

// Compare the project's last-built framework against current. On drift, raise a
// `drift` queue item + surface the "update available" banner (derived from the
// item). Non-blocking: a remediation is explicit-consent only (ADR-003 — nothing
// auto-remediates here).
function detectDrift(project, framework) {
  const lastBuilt = project.last_built_framework_version_id;
  if (!isFrameworkDrifted(lastBuilt, framework.id)) return { drifted: false };
  const from = getFrameworkVersion(lastBuilt);
  const label = driftLabel(from?.version ?? '?', framework.version);
  try {
    raiseQueueItem({
      kind: 'drift', project_id: Number(project.id), dedupe_key: driftDedupeKey(project.id),
      ref_table: 'mock2_framework_versions', ref_id: framework.id,
      detail: `${project.name}: framework moved since the last build — ${label}. Start an update cycle to adopt it (explicit consent; nothing auto-remediates).`,
    });
  } catch (e) { console.warn('[mock2] drift raise failed:', e?.message); }
  return { drifted: true, label };
}

// ---- start (route calls this on the Build press; 202 + poll) ----

// startBuild — the audit gate before a build cycle. Guards, quota check, drift
// detection, then fire the background audit. Returns
// { status:'started'|'refused'|'error', cycle, error }.
export async function startBuild({ project, instruction, user, actingAsAdmin = 0 }) {
  const projectId = Number(project.id);

  if (project.lifecycle !== 'active') {
    return { status: 'error', error: `Project must be online to build (it is "${project.lifecycle}").` };
  }
  if (!project.design_approved_at) {
    return { status: 'error', error: 'Approve the design first — Build unlocks after the Concept sign-off.' };
  }
  const existingLock = getLock(projectId);
  if (existingLock && (existingLock.holder_cycle_id != null || existingLock.holder_user_id != null)) {
    return { status: 'error', error: 'This project is checked out by another writer. Wait, or request a takeover.' };
  }
  if (auditJobActive(projectId)) {
    return { status: 'error', error: 'An audit is already running for this project.' };
  }
  const ready = auditReady();
  if (!ready.ok) return { status: 'error', error: ready.reason };
  // Fail fast if the eventual build has no model (the audit would spend, then the
  // build would refuse). buildRunnerReady is a runner READ API (allowed by M8).
  const runner = buildRunnerReady();
  if (!runner.ok) return { status: 'error', error: runner.reason };

  const framework = getCurrentFrameworkVersion();
  if (!framework) return { status: 'error', error: 'No framework version exists to pin. Publish one first.' };

  // Drift check (non-blocking) — surfaces the banner + queue item before the audit.
  detectDrift(project, framework);

  // Cost-truth: the operator's ask opens ONE request; the define audit + the build +
  // any resumes/consults are its segments (additive — request_id is nullable, this
  // never changes runner behavior).
  const request = insertRequest({ projectId, instruction: String(instruction || '').slice(0, getChatMaxChars()), initiatedBy: user.id, actingAsAdmin });

  // Quota (R5 — the audit step spends). refused_quota is a real terminal status.
  const estCostCents = estimateAuditCostCents(ready);
  const { verdict } = quotaVerdict(projectId, estCostCents);
  if (!verdict.ok) {
    const refused = insertCycle({
      projectId, frameworkVersionId: framework.id, stage: 'define', instruction: String(instruction || '').slice(0, getChatMaxChars()),
      initiatedBy: user.id, actingAsAdmin, estCostCents, status: 'refused_quota',
      requestId: request.id, segment: 'define',
    });
    finishCycle(refused.id, { status: 'refused_quota', error: verdict.reason });
    insertMessage({ projectId, kind: 'system', cycleId: refused.id, body: `Build not started — ${verdict.reason}` });
    return { status: 'refused', cycle: getCycle(refused.id), error: verdict.reason };
  }

  // The audit cycle (stage 'define' — the rules-confirmation gate before Build).
  // It holds the questions (cycle_id NOT NULL) and remembers the Build instruction
  // to resume with once the gate clears.
  const cycle = insertCycle({
    projectId, frameworkVersionId: framework.id, stage: 'define', instruction: String(instruction || '').slice(0, getChatMaxChars()),
    initiatedBy: user.id, actingAsAdmin, estCostCents, status: 'running',
    requestId: request.id, segment: 'define',
  });
  updateCycle(cycle.id, { started_at: nowIso() });
  getOrCreateChat(projectId);
  setJob(projectId, { phase: 'auditing', message: 'Auditing the design against the rules and framework…', cycleId: cycle.id, startedAt: Date.now() });

  runAudit({ project, cycle: getCycle(cycle.id), ready, framework, user, actingAsAdmin, instruction: String(instruction || '') })
    .catch((err) => {
      console.error(`[mock2] audit crashed for project ${projectId}:`, err?.message || err);
      try { finishCycle(cycle.id, { status: 'failed', error: `audit crashed: ${err?.message || err}` }); } catch { /* ignore */ }
      try { insertMessage({ projectId, kind: 'system', cycleId: cycle.id, body: `The build audit failed: ${err?.message || err}` }); } catch { /* ignore */ }
      setJob(projectId, { phase: 'failed', message: `audit crashed: ${err?.message || err}` });
      scheduleJobCleanup(projectId);
    });

  return { status: 'started', cycle: getCycle(cycle.id) };
}

async function runAudit({ project, cycle, ready, framework, user, actingAsAdmin, instruction }) {
  const projectId = Number(project.id);
  const containerName = project.container_name || containerNameForProject(projectId);

  // 1) Read the audit inputs: the approved inventory (the UI contract) + any
  //    rules already confirmed. The mockup is discarded on approval (M7), so the
  //    inventory — not pixels — is what the audit reads.
  const inv = await readWorkingFile(containerName, INVENTORY_PATH);
  if (!inv.ok || !String(inv.content || '').trim()) {
    finishCycle(cycle.id, { status: 'failed', error: 'no approved inventory to audit' });
    insertMessage({ projectId, kind: 'system', cycleId: cycle.id, body: 'Could not read the approved design inventory to audit the build. Re-approve the design and try again.' });
    setJob(projectId, { phase: 'failed', message: 'inventory unreadable' });
    return scheduleJobCleanup(projectId);
  }
  const rules = await readWorkingFile(containerName, RULES_PATH);
  const inventoryText = String(inv.content).slice(0, MAX_AUDIT_INPUT_CHARS);
  const rulesMd = rules.ok ? String(rules.content || '').slice(0, MAX_AUDIT_INPUT_CHARS) : '';

  // 1b) Component suggestions — define-time selection, PURE CODE (no model, no
  //     tokens): the inventory's required capabilities are matched against the
  //     published components' contracts; each match becomes a tappable
  //     component_suggestion question that gates the build exactly like a rule
  //     question. Already-decided components (confirmed OR declined) never
  //     re-suggest. Best-effort — a failure here must not break the audit.
  let suggestionCount = 0;
  try {
    let inventoryDoc = null;
    try { inventoryDoc = JSON.parse(inv.content); } catch { inventoryDoc = null; }
    const capabilities = extractCapabilities(inventoryDoc);
    if (capabilities.length) {
      const catalog = listPublishedComponents().map((c) => ({ ...c, contract: parseContractJson(c.contract_json) }));
      const decided = new Set(listProjectComponents(projectId).map((r) => r.key));
      const suggestions = suggestComponentsForCapabilities(catalog, capabilities, decided);
      for (const s of suggestions) {
        const catRow = catalog.find((c) => c.key === s.key);
        if (!catRow) continue;
        const q = buildComponentSuggestionQuestion(s);
        const row = insertQuestion({ projectId, cycleId: cycle.id, route: 'editor', kind: 'component_suggestion', question: q.question, choices: q.choices });
        insertProjectComponentSuggestion({ projectId, componentId: catRow.id, versionId: catRow.current_version_id, questionId: row.id });
        insertMessage({
          projectId, kind: 'rule_question', cycleId: cycle.id, questionId: row.id,
          body: buildRuleQuestionBody({ question: q.question, choices: q.choices }),
        });
        suggestionCount += 1;
      }
    }
  } catch (e) { console.warn('[mock2] component suggestion failed:', e?.message); }

  // 2) Run the audit on the audit slot (a reasoning task; no tools — JSON out).
  const auditRes = await callModelTurn({
    connector: ready.connector, apiKey: ready.apiKey, model: ready.model,
    system: buildAuditSystemPrompt({ constitution: framework.constitution_md, projectName: project.name }),
    tools: [],
    transcript: [{ role: 'user', text: buildAuditTask({ inventory: inventoryText, rulesMd, instruction, projectName: project.name, frameworkVersion: framework.version }) }],
    maxTokens: 6000,
    effort: 'medium', // a bounded classification/reasoning task — high depth buys nothing here
  });
  if (auditRes.ok) recordSpend({ projectId, cycleId: cycle.id, connector: ready.connector, model: ready.model, usage: auditRes.usage });
  const parsed = auditRes.ok ? parseAuditQuestions(auditRes.text) : { ok: false, error: auditRes.error, questions: [] };
  if (!parsed.ok) {
    finishCycle(cycle.id, { status: 'failed', error: `audit failed: ${parsed.error}` });
    insertMessage({ projectId, kind: 'system', cycleId: cycle.id, body: `The build audit couldn't complete: ${parsed.error}. Build was not started — try again.` });
    setJob(projectId, { phase: 'failed', message: parsed.error });
    return scheduleJobCleanup(projectId);
  }

  const { editor, admin } = splitQuestionsByRoute(parsed.questions);

  // The audit's routing classification of the request (kind + difficulty) —
  // stamped on the audit cycle so the deferred build (resumed after questions
  // clear) still finds it, and reviewable in the logs either way.
  if (parsed.task) {
    try { updateCycle(cycle.id, { routing_json: JSON.stringify({ task: parsed.task }) }); } catch { /* best effort */ }
  }

  // 3a) No questions (and no component suggestions) → the gate is clear; Build
  //     starts immediately (ADR-002).
  if (editor.length === 0 && admin.length === 0 && suggestionCount === 0) {
    finishCycle(cycle.id, { status: 'succeeded' });
    insertMessage({ projectId, kind: 'system', cycleId: cycle.id, body: 'Audit passed — no rule questions. Starting the build.' });
    setJob(projectId, { phase: 'building', message: 'Audit passed — starting the build.', cycleId: cycle.id });
    await proceedToBuild({ project, instruction, initiatedBy: cycle.initiated_by, actingAsAdmin, framework, requestId: cycle.request_id ?? null, task: parsed.task });
    return scheduleJobCleanup(projectId);
  }

  // 3b) Editor questions → tappable choices in chat (rule_question rows).
  for (const q of editor) {
    const row = insertQuestion({ projectId, cycleId: cycle.id, route: 'editor', kind: q.kind, question: q.question, choices: q.choices });
    insertMessage({
      projectId, kind: 'rule_question', cycleId: cycle.id, questionId: row.id,
      body: buildRuleQuestionBody({ question: q.question, choices: q.choices }),
    });
  }

  // 3c) Framework deviations → the ADMIN queue (a project's answer never writes
  //     the framework — ADR-002). Each becomes an admin-route question + a
  //     framework_deviation queue item that references it.
  for (const q of admin) {
    const row = insertQuestion({ projectId, cycleId: cycle.id, route: 'admin', kind: q.kind, question: q.question, choices: q.choices });
    try {
      raiseQueueItem({
        kind: 'framework_deviation', project_id: projectId,
        dedupe_key: `mock2-deviation:${row.id}`,
        ref_table: 'mock2_audit_questions', ref_id: row.id,
        detail: `${project.name}: ${q.question}${q.rationale ? ` — ${q.rationale}` : ''}`,
      });
    } catch (e) { console.warn('[mock2] deviation queue raise failed:', e?.message); }
  }

  // 4) Block the build in the derived status and tell the Builder what's next.
  const blocked = blockedBuildStatus({ openEditorQuestions: editor.length + suggestionCount, openAdminItems: admin.length }) || 'awaiting_user';
  updateCycle(cycle.id, { status: blocked });
  const bits = [];
  if (editor.length) bits.push(`${editor.length} rule question${editor.length === 1 ? '' : 's'} to confirm below`);
  if (suggestionCount) bits.push(`${suggestionCount} standard component${suggestionCount === 1 ? '' : 's'} to confirm below`);
  if (admin.length) bits.push(`${admin.length} framework deviation${admin.length === 1 ? '' : 's'} sent to the admin queue`);
  insertMessage({
    projectId, kind: 'system', cycleId: cycle.id,
    body: `Before building, the audit needs ${bits.join(' and ')}. ${(editor.length || suggestionCount) ? 'Answer the questions to continue — Build starts automatically once every one is confirmed.' : 'Build is blocked until an admin resolves the framework deviation(s).'}`,
  });
  setJob(projectId, { phase: blocked, message: `Build blocked: ${bits.join('; ')}.`, cycleId: cycle.id });
  scheduleJobCleanup(projectId);
}

// proceedToBuild — hand off to the runner. Stamps last_built_framework_version_id
// (the drift comparison input) + resolves the drift item (the app is now being
// built against current), then startCycle (which takes the lock as the cycle
// holder and drives the M6 runner). Non-fatal if startCycle refuses.
async function proceedToBuild({ project, instruction, initiatedBy, actingAsAdmin, framework, adminDecisions = '', requestId = null, task = null }) {
  const projectId = Number(project.id);
  updateProject(projectId, { last_built_framework_version_id: framework.id, last_activity_at: nowIso() });
  try { resolveQueueItem(driftDedupeKey(projectId), { resolution: 'built against current framework' }); } catch { /* best effort */ }

  // Deterministic component pre-install (ZERO model tokens): every confirmed
  // selection lands in the container BEFORE the runner's first turn — files
  // (sha256-verified), renumbered migrations, declared npm deps, .env defaults,
  // and pre-declared integration-manifest entries. The writes take the checkout
  // lock like any other writer (ADR-004). A failed install BLOCKS the build —
  // a half-installed component is worse than none; pressing Build retries.
  const holder = { type: 'user', id: initiatedBy };
  const lock = acquireLock({ projectId, requester: holder, role: actingAsAdmin ? 'admin' : 'editor' });
  if (!lock.ok) {
    insertMessage({ projectId, kind: 'system', body: `Build did not start — ${lock.reason || 'the project is checked out by another writer.'}` });
    return { ok: false, error: lock.reason || 'project locked' };
  }
  try {
    const pre = await preinstallComponents({ project: getProject(projectId), initiatedBy, actingAsAdmin });
    if (!pre.ok) {
      const keys = pre.failed.map((f) => f.row.key).join(', ');
      insertMessage({ projectId, kind: 'system', body: `Build not started — component pre-install failed (${keys}). Fix the cause and press Build to retry.` });
      return { ok: false, error: `component pre-install failed: ${keys}` };
    }
  } catch (err) {
    insertMessage({ projectId, kind: 'system', body: `Build not started — component pre-install crashed: ${err?.message || err}` });
    return { ok: false, error: err?.message || String(err) };
  } finally {
    try { releaseLock(projectId, holder); } catch { /* ignore */ }
  }
  // Carry the admin's deviation decisions INTO the build instruction (so they
  // persist on the cycle and survive a resume) — the runner honors an approved
  // exception as an override of the constitution. Without this the runner never
  // learns the admin approved the deviation and silently builds nothing.
  const fullInstruction = adminDecisions ? `${instruction}\n\n${adminDecisions}` : instruction;
  let result;
  try {
    // Thread the umbrella request EXPLICITLY (one build request = one log): the
    // build cycle joins the audit cycle's request instead of relying on the
    // latest-open-request fallback inside startCycle.
    result = await startCycle({ project: getProject(projectId), instruction: fullInstruction, initiatedBy, actingAsAdmin, requestId, segment: 'build', task });
  } catch (err) {
    insertMessage({ projectId, kind: 'system', body: `Could not start the build: ${err?.message || err}` });
    return { ok: false, error: err?.message || String(err) };
  }
  if (result.status === 'error' || result.status === 'refused') {
    insertMessage({ projectId, kind: 'system', body: `Build did not start — ${result.error}` });
    return { ok: false, error: result.error };
  }
  return { ok: true, cycle: result.cycle };
}

// ---- answer an editor question (sign-off #2 — appends to rules.md) ----

// answerAuditQuestion — an editor confirmed a domain rule. Takes the lock, appends
// the answer to state/rules.md (commit + hash-chained change record + anchor),
// marks the question answered, posts a rule_answer, releases the lock, and — if
// this cleared the last blocker — resumes the deferred Build. Free text is always
// allowed (the escape hatch). Returns { ok, question, resumed, error }.
export async function answerAuditQuestion({ project, question, answer, user, actingAsAdmin = 0 }) {
  const projectId = Number(project.id);
  if (project.lifecycle !== 'active') return { ok: false, error: `The project must be online to answer (it is "${project.lifecycle}").` };
  if (question.route !== 'editor') return { ok: false, error: 'This question is routed to an administrator, not an editor.' };
  if (question.status !== 'open') return { ok: false, error: 'This question has already been answered.' };
  const text = String(answer || '').trim();
  if (!text) return { ok: false, error: 'An answer is required.' };

  const containerName = project.container_name || containerNameForProject(projectId);
  const holder = { type: 'user', id: user.id };
  const role = actingAsAdmin ? 'admin' : (user.role === 'admin' ? 'admin' : 'editor');

  // An answer that writes rules.md takes the lock (ADR-004).
  const lock = acquireLock({ projectId, requester: holder, role });
  if (!lock.ok) return { ok: false, error: lock.reason || 'This project is checked out by another writer.' };

  try {
    // 1) Append the confirmed rule to state/rules.md (rule answers only).
    const cur = await readWorkingFile(containerName, RULES_PATH);
    const rulesMd = cur.ok ? String(cur.content || '') : '';
    const { md, anchor } = appendRule(rulesMd, { questionId: question.id, question: question.question, answer: text });
    const w = await writeWorkingFile(containerName, RULES_PATH, md);
    if (!w.ok) { releaseLock(projectId, holder); return { ok: false, error: `Could not write the rule: ${w.error}` }; }
    touchLock(projectId, holder);

    // 2) Checkpoint + a hash-chained change record (a rules-confirmation is a
    //    checkpoint too; the chain must keep verifying). Pin the audit cycle's
    //    framework version for the stamp.
    const pinned = getFrameworkVersion(question.cycle_id ? (getCycle(question.cycle_id)?.framework_version_id) : null) || getCurrentFrameworkVersion();
    const summary = `Rule confirmed: ${question.question.slice(0, 120)}`;
    const sha = await checkpoint(containerName, `mock2: ${summary}`);
    let record = null;
    try {
      record = insertChangeRecord({
        projectId, cycleId: question.cycle_id || null, initiatedBy: user.id, actingAsAdmin,
        frameworkVersion: pinned.version, frameworkVersionId: pinned.id,
        rulesTouched: [anchor], gatesRun: null, commitSha: sha, summary,
      });
    } catch (e) { console.error('[mock2] rule change record insert failed:', e?.message); }
    if (record) {
      try {
        await writeWorkingFile(containerName, `state/changes/${record.seq}.json`, JSON.stringify(changeRecordMirror(record), null, 2));
        await checkpoint(containerName, `mock2: change record ${record.seq}`);
      } catch (e) { console.warn('[mock2] rule change-record mirror failed:', e?.message); }
    }
    await maybePushRemote(projectId);

    // 3) Record the answer + post the rule_answer (linked by question_id, ADR-002).
    const updated = answerQuestion(question.id, { answer: text, answeredBy: user.id, rulesMdAnchor: anchor });
    insertMessage({ projectId, authorUserId: user.id, actingAsAdmin, kind: 'rule_answer', cycleId: question.cycle_id || null, questionId: question.id, body: text });
    // A component_suggestion answer ALSO records the structured decision on the
    // project's selection row (mock2_project_components) — the pre-installer
    // and the build prompt read that, not the rules prose. An ambiguous answer
    // declines (a component is never installed on an unclear yes).
    if (question.kind === 'component_suggestion') {
      try {
        const sel = getProjectComponentByQuestion(question.id);
        if (sel) {
          const { decision } = parseComponentSuggestionAnswer(text);
          decideProjectComponent({
            projectId, componentId: sel.component_id, versionId: sel.version_id,
            status: decision, origin: 'define', options: { answer: text },
            questionId: question.id, decidedBy: user.id,
          });
        }
      } catch (e) { console.warn('[mock2] component decision record failed:', e?.message); }
    }
    updateProject(projectId, { last_activity_at: nowIso() });
    releaseLock(projectId, holder);

    // 4) If that cleared the last blocker, resume the deferred Build.
    const resumed = await maybeResumeBuild({ projectId, auditCycleId: question.cycle_id, actingAsAdmin });
    return { ok: true, question: updated, resumed };
  } catch (err) {
    try { releaseLock(projectId, holder); } catch { /* ignore */ }
    return { ok: false, error: err?.message || String(err) };
  }
}

// maybeResumeBuild — the deferred Build proceeds once no editor question AND no
// admin deviation remain open (auditGateCleared — both DERIVED, never a flag).
// Marks the audit cycle succeeded and hands off to the runner. Returns true when
// the build was (re)started.
async function maybeResumeBuild({ projectId, auditCycleId, actingAsAdmin = 0 }) {
  const openEditorQuestions = countOpenEditorQuestions(projectId);
  const openAdminItems = countOpenAdminQuestions(projectId) + countAwaitingAdminItems(projectId);
  const cleared = auditGateCleared({ openEditorQuestions, openAdminItems });
  if (!cleared) {
    // Still blocked, but the blocking lane may have shifted (e.g. the last editor
    // question was answered while a deviation is still open). Keep the audit
    // cycle's status in step so the poll reflects the right derived state.
    const auditCycle = auditCycleId ? getCycle(auditCycleId) : null;
    const next = blockedBuildStatus({ openEditorQuestions, openAdminItems });
    if (auditCycle && next && auditCycle.status !== next && ['awaiting_user', 'awaiting_admin'].includes(auditCycle.status)) {
      updateCycle(auditCycle.id, { status: next });
    }
    return false;
  }
  const auditCycle = auditCycleId ? getCycle(auditCycleId) : null;
  if (auditCycle && ['awaiting_user', 'awaiting_admin', 'running'].includes(auditCycle.status)) {
    finishCycle(auditCycle.id, { status: 'succeeded' });
  }
  const framework = getCurrentFrameworkVersion();
  const project = getProject(projectId);
  if (!framework || !project) return false;
  // Fold the admin's decisions on this build's framework deviations into the
  // runner's task so an APPROVED deviation is actually implemented (it overrides
  // the constitution) and a DENIED one is skipped.
  const adminDecisions = auditCycle ? buildAdminDecisionsBlock(listQuestionsForCycle(auditCycle.id)) : '';
  // Recover the audit's routing classification stamped on the audit cycle.
  let auditTask = null;
  try { auditTask = auditCycle?.routing_json ? (JSON.parse(auditCycle.routing_json)?.task ?? null) : null; } catch { auditTask = null; }
  insertMessage({ projectId, kind: 'system', cycleId: auditCycle?.id || null, body: 'All rules confirmed — starting the build.' });
  setJob(projectId, { phase: 'building', message: 'Rules confirmed — starting the build.', cycleId: auditCycle?.id || null });
  await proceedToBuild({
    project, instruction: auditCycle?.instruction || 'Build the app from the approved inventory and confirmed rules.',
    initiatedBy: auditCycle?.initiated_by || project.created_by, actingAsAdmin, framework, adminDecisions,
    requestId: auditCycle?.request_id ?? null, task: auditTask,
  });
  scheduleJobCleanup(projectId);
  return true;
}

// ---- admin resolves a framework deviation (unblocks the build) ----

// resolveFrameworkDeviation — an admin cleared a framework_deviation from the
// queue. Dismiss the linked admin-route question (a project's answer never writes
// the framework — the admin either amends the framework via the registry or
// accepts the deviation for this project), then resume the build if this was the
// last blocker. Returns { resumed }.
export async function resolveFrameworkDeviation({ questionId, user, resolution = null, approved = false, editedText = null, conditions = null }) {
  const question = getQuestion(questionId);
  if (!question) return { resumed: false };
  // Record the decision with an APPROVED/DENIED marker so the resume path can
  // build the authoritative decisions block for the runner (an approved deviation
  // overrides the constitution; a denied one is skipped). Marker-prefixed answer
  // rather than a free-text note so the parse can't be fooled.
  //
  // Approve-as-edited (Part 3): when the admin rewrites the deviation text and/or
  // appends conditions, the EDITED text becomes the authoritative approved record —
  // we replace the question text (buildAdminDecisionsBlock reads it) so the runner is
  // handed exactly what the admin signed off on.
  if (question.status === 'open') {
    if (approved && (editedText || conditions)) {
      const edit = approveAsEditedText({ originalText: question.question, editedText: editedText || '', conditions: conditions || '' });
      updateQuestionText(question.id, edit.text);
      dismissQuestion(question.id, { by: user?.id ?? null, answer: markDeviationDecision(true, edit.resolutionNote) });
    } else {
      dismissQuestion(question.id, { by: user?.id ?? null, answer: markDeviationDecision(approved, resolution) });
    }
  }
  const resumed = await maybeResumeBuild({ projectId: question.project_id, auditCycleId: question.cycle_id, actingAsAdmin: 1 });
  return { resumed };
}
