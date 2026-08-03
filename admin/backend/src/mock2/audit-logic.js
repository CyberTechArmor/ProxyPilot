// Mock2 AUDIT pure decision layer (Phase M8, ADR-002; survey §10; data-model
// mock2_audit_questions / mock2_queue_items). Native-free, unit-tested stub-first
// (risk R9): imports NOTHING that opens a DB, hits the network, or touches Incus.
//
// The audit is the two-way routing that gates Build. When a Builder presses
// Build, the audit compares the approved inventory + any existing state/rules.md +
// the pinned framework and produces a list of questions, SPLIT BY ROUTE (ADR-002):
//   * domain questions (domain_question / rule_contradiction / rule_gap) → the
//     project's EDITORS, as tappable choices in the chat; an answer appends to
//     state/rules.md (the rules-confirmation sign-off — sign-off #2).
//   * framework deviations (framework_deviation) → the ADMIN queue; a project's
//     answer NEVER writes the framework (a genuine standards gap is a separate
//     framework change through the registry, ADR-003).
// The routing is decided HERE by kind, never by convenience (ADR-002). No
// questions → Build starts immediately.
//
// Everything about the audit that can be decided without a model API,
// better-sqlite3, or Incus lives here: the kind→route map, the audit system
// prompt (constitution-injected, exactly as the runner injects constitution_md),
// the audit task assembly, the question-list parse + validation, the rules.md
// append, the gate-cleared predicate, the API shapes, and the cost envelope.
// audit.js (the host/model orchestration half) and the routes import these; the
// tests import ONLY this module.
//
// Terminology (risk R7): nothing here is named "agent".

// ---- kinds + routing (ADR-002 — route by kind, never by convenience) ----

// The four audit-question kinds (migration 502 CHECK). Three are domain questions
// the EDITOR owns; framework_deviation is the ADMIN's.
export const AUDIT_KINDS = Object.freeze([
  'domain_question',
  'rule_contradiction',
  'rule_gap',
  'framework_deviation',
]);

// The editor-owned kinds — a domain rule the (possibly non-technical) editor
// decides. Their answers append to state/rules.md.
export const EDITOR_KINDS = Object.freeze(['domain_question', 'rule_contradiction', 'rule_gap']);

// routeForKind — the ONE place a kind becomes a route (ADR-002). framework
// deviations go to the admin queue; every other kind is an editor domain
// question. Unknown kinds default to editor (a false editor question costs a
// tap; a mis-routed deviation would silently change the framework — the safe
// default is the editor).
export function routeForKind(kind) {
  return kind === 'framework_deviation' ? 'admin' : 'editor';
}

// The queue-item kinds the admin page reads (migration 502 CHECK). M8 adds
// framework_deviation + drift to the set M0–M7 already write.
export const QUEUE_KINDS = Object.freeze([
  'framework_deviation', 'drift', 'retries_exhausted', 'flag', 'orphaned',
  'port_drift', 'quota_exhausted', 'provisioning_failed', 'renewal_failed',
  // A declared outbound-egress grant awaiting admin approval (operational
  // authorization, audit-logged). It does NOT block the build — the code can
  // ship; the egress only becomes reachable once approved — so it is not in
  // AWAITING_ADMIN_QUEUE_KINDS.
  'egress_grant',
]);

export const QUEUE_STATUSES = Object.freeze(['open', 'in_progress', 'resolved', 'dismissed']);

// The admin-attention kinds that DERIVE the "awaiting admin" project status
// (03-data-model.md: awaiting admin ← open admin question/queue item or retries
// exhausted). `drift` is its OWN derived status and `flag` is the `!` overlay, so
// neither is counted here.
export const AWAITING_ADMIN_QUEUE_KINDS = Object.freeze([
  'framework_deviation', 'retries_exhausted', 'port_drift', 'quota_exhausted',
  'provisioning_failed', 'orphaned',
]);

// ---- audit system prompt (constitution-injected, exactly like the runner) ----

// buildAuditSystemPrompt — the audit slot's system prompt. Injects the pinned
// framework's constitution verbatim (ADR-003), exactly as the runner injects
// constitution_md and the concept stage injects design_system_md. The audit is
// the gate before Build: it reads the approved inventory + the existing rules and
// the constitution, and asks only the questions that must be answered before the
// app can be built correctly.
export function buildAuditSystemPrompt({ constitution = '', projectName = 'this project' } = {}) {
  return `You are the Mock2 build AUDITOR. Before an app is built, you compare the
approved design inventory, any rules already confirmed, and the framework's
constitution, and you surface ONLY the questions that must be answered first.
This is the gate between Define and Build for "${projectName}".

You produce a list of QUESTIONS, each of exactly one kind:

EDITOR questions — a domain decision the project's editor (who may be
non-technical) must make. Use plain, warm language and offer concrete tappable
choices; a free-text answer is always allowed too.
  - "domain_question": a genuine product/domain ambiguity the inventory leaves
    open (e.g. "Can two bookings overlap for the same room?").
  - "rule_contradiction": the inventory or request contradicts a rule already in
    rules.md — ask the editor to resolve it.
  - "rule_gap": a rule the app clearly needs but rules.md does not yet state.

ADMIN questions — a conflict with the FRAMEWORK itself, which an editor cannot
and must not resolve:
  - "framework_deviation": the inventory or request implies something the
    constitution forbids or replaces a mandated choice (e.g. it implies MySQL
    when the constitution mandates PostgreSQL, or an auth scheme the constitution
    disallows). Never phrase this as a choice for the editor — it goes to an
    administrator. A project's answer never changes the framework.

Rules:
- Ask as FEW questions as possible. If the inventory + rules + constitution are
  already unambiguous and compliant, return an EMPTY list — Build proceeds with
  no questions.
- Never invent ambiguity. Only ask when a real decision blocks a correct build.
- An editor question must carry 2–4 concrete "choices"; a framework_deviation
  states the conflict plainly and needs no choices.
- Do NOT ask the editor to change the framework, the stack, or the constitution.

The pinned framework constitution (binding — this is what a framework_deviation
is measured against):

# Constitution (pinned)
${constitution || '(constitution content is still owed — risk R8)'}

Output ONLY a JSON object, no markdown, no code fences, no commentary:

{
  "task": {
    "kind": "chore|bugfix|feature|refactor|question",
    "difficulty": 1
  },
  "questions": [
    {
      "kind": "domain_question|rule_contradiction|rule_gap|framework_deviation",
      "question": "plain-language question or a plain statement of the deviation",
      "choices": ["option A", "option B"],
      "rationale": "one line: why this must be answered before Build"
    }
  ]
}

"task" classifies the BUILD REQUEST itself (used to pick the model/effort for
the build — be honest, not flattering): kind is what the change fundamentally
is; difficulty is 1 (trivial copy/config tweak) to 5 (large cross-cutting
change, subtle debugging, or architectural work).

An empty "questions" array is the correct answer when nothing blocks the build.`;
}

// buildAuditTask — the audit's user turn: the approved inventory, the existing
// rules.md (may be empty), the Build instruction, and the pinned framework
// version, so the auditor decides against the exact state Build would run on.
export function buildAuditTask({ inventory = null, rulesMd = '', instruction = '', projectName = 'the app', frameworkVersion = null } = {}) {
  const invText = inventory == null
    ? '(no inventory found)'
    : (typeof inventory === 'string' ? inventory : JSON.stringify(inventory, null, 2));
  const rules = String(rulesMd || '').trim();
  const parts = [
    `Project: ${projectName}`,
    frameworkVersion != null ? `Pinned framework version: ${frameworkVersion}` : null,
    `Build request:\n${String(instruction || '(build the app from the approved inventory)').trim()}`,
    `Approved design inventory (state/inventory.json — the UI contract):\n${invText}`,
    `Existing confirmed rules (state/rules.md):\n${rules || '(rules.md is empty — no rules confirmed yet)'}`,
    'Produce the audit questions as the JSON object described. Return an empty list if nothing blocks the build.',
  ];
  return parts.filter(Boolean).join('\n\n');
}

// ---- parse + validate + route the audit output ----

// parseAuditQuestions — parse the auditor's JSON into a canonical, ROUTED
// question list. Tolerant of ```json fences and leading prose (like
// parseInventory). Each valid question is normalized to
// { kind, route, question, choices[], rationale } with route derived by kind
// (never trusted from the model). Invalid entries are dropped, not fatal.
// Returns { ok, questions, task, error } — `task` is the request's routing
// classification ({ kind, difficulty } or null when absent/malformed; the
// routing layer treats null as 'default'). ok:true with an empty list means
// "no questions — build proceeds".
const TASK_KINDS = ['chore', 'bugfix', 'feature', 'refactor', 'question'];
export function parseAuditTask(doc) {
  const t = doc?.task;
  if (!t || typeof t !== 'object') return null;
  const kind = String(t.kind || '').trim().toLowerCase();
  const difficulty = Number(t.difficulty);
  return {
    kind: TASK_KINDS.includes(kind) ? kind : 'default',
    difficulty: Number.isFinite(difficulty) ? Math.min(5, Math.max(1, Math.round(difficulty))) : null,
  };
}

export function parseAuditQuestions(text) {
  let s = String(text || '').trim();
  if (!s) return { ok: false, error: 'empty audit response', questions: [], task: null };
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1]) s = fence[1].trim();
  else {
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start > 0 && end > start) s = s.slice(start, end + 1);
  }
  let doc;
  try { doc = JSON.parse(s); } catch (e) { return { ok: false, error: `audit output is not valid JSON: ${e.message}`, questions: [], task: null }; }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { ok: false, error: 'audit output must be a JSON object', questions: [], task: null };
  const task = parseAuditTask(doc);
  const rawList = Array.isArray(doc.questions) ? doc.questions : [];
  const questions = [];
  for (const q of rawList) {
    if (!q || typeof q !== 'object') continue;
    const kind = String(q.kind || '').trim();
    if (!AUDIT_KINDS.includes(kind)) continue;
    const question = String(q.question || '').trim();
    if (!question) continue;
    const choices = normalizeChoices(q.choices);
    questions.push({
      kind,
      route: routeForKind(kind),
      question,
      choices,
      rationale: String(q.rationale || '').trim(),
    });
  }
  return { ok: true, questions, task };
}

// Normalize a choices value into a clean string array (deduped, trimmed, capped).
// Framework deviations legitimately carry no choices; an editor question that
// arrives without any is still valid (free-text is always allowed).
export function normalizeChoices(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const c of input) {
    const v = String(c == null ? '' : c).trim();
    if (v && !out.includes(v)) out.push(v);
    if (out.length >= 6) break;
  }
  return out;
}

// splitQuestionsByRoute — partition a routed question list into the two lanes the
// orchestrator materializes differently: editor questions (in-chat tappable
// choices) and admin questions (queue items). Order-stable.
export function splitQuestionsByRoute(questions = []) {
  const editor = [];
  const admin = [];
  for (const q of questions || []) {
    if (!q) continue;
    (q.route === 'admin' ? admin : editor).push(q);
  }
  return { editor, admin };
}

// ---- the in-chat rule_question body (carries the choices JSON) ----

// buildRuleQuestionBody — the chat message body for a rule_question row. The
// body carries the plain-language question AND its tappable choices as JSON
// (03-data-model.md: "rule_question bodies carry choices JSON"). The frontend
// parses it to render the buttons; a free-text answer is always allowed.
export function buildRuleQuestionBody({ question = '', choices = [] } = {}) {
  return JSON.stringify({ question: String(question || ''), choices: normalizeChoices(choices) });
}

// parseRuleQuestionBody — the inverse, tolerant of a body that is plain text
// (older/manual rows) rather than JSON. Returns { question, choices }.
export function parseRuleQuestionBody(body) {
  const raw = String(body || '');
  try {
    const j = JSON.parse(raw);
    if (j && typeof j === 'object' && !Array.isArray(j)) {
      return { question: String(j.question || ''), choices: normalizeChoices(j.choices) };
    }
  } catch { /* not JSON — treat as plain text */ }
  return { question: raw, choices: [] };
}

// ---- state/rules.md append (the sign-off #2 write) ----

// A stable, path-safe-ish anchor for a rule confirmation (where the answer landed
// in rules.md — mock2_audit_questions.rules_md_anchor). Derived from the question
// id so it is unique per project without a clock.
export function ruleAnchor(questionId) {
  return `rule-q${Number(questionId)}`;
}

// A short heading for the rules.md section (the question, trimmed to one line).
export function ruleHeading(question) {
  const s = String(question || '').trim().replace(/\s+/g, ' ');
  return s.length > 80 ? `${s.slice(0, 79)}…` : (s || 'Confirmed rule');
}

// appendRule — append one confirmed rule to state/rules.md. Pure string
// transform so the exact bytes committed are unit-tested. Returns { md, anchor }.
// The anchor is embedded as an HTML comment so the section is addressable without
// polluting the rendered markdown; the heading is the question, and the answer is
// the editor's confirmation (a tapped choice or free text).
export function appendRule(rulesMd, { questionId, question, answer } = {}) {
  const anchor = ruleAnchor(questionId);
  const heading = ruleHeading(question);
  const block = `## ${heading}\n<!-- ${anchor} -->\n\n${String(question || '').trim()}\n\n**Answer:** ${String(answer || '').trim()}\n`;
  const base = String(rulesMd || '').replace(/\s+$/, '');
  const md = base
    ? `${base}\n\n${block}`
    : `# Project rules\n\nConfirmed domain rules for this project. Each entry is an editor sign-off from the build audit (ADR-002).\n\n${block}`;
  return { md, anchor };
}

// ---- the build gate (derived, never set by hand) ----

// auditGateCleared — may the deferred Build proceed? Only when there is no open
// editor question AND no open admin question/deviation for this build. Both
// counts are DERIVED from open rows (03-data-model.md), never a stored flag.
export function auditGateCleared({ openEditorQuestions = 0, openAdminItems = 0 } = {}) {
  return Number(openEditorQuestions) === 0 && Number(openAdminItems) === 0;
}

// The blocked status a build sits in given its open questions (awaiting_user when
// any editor question is open — editors act first; otherwise awaiting_admin when
// a deviation blocks). Returns null when nothing blocks (build may proceed).
export function blockedBuildStatus({ openEditorQuestions = 0, openAdminItems = 0 } = {}) {
  if (Number(openEditorQuestions) > 0) return 'awaiting_user';
  if (Number(openAdminItems) > 0) return 'awaiting_admin';
  return null;
}

// The marker prefix an admin decision writes into a deviation question's answer,
// so the resume path can tell an approval from a denial reliably (not by parsing
// free-text resolution notes).
export const DEVIATION_APPROVED = 'APPROVED';
export const DEVIATION_DENIED = 'DENIED';
export function markDeviationDecision(approved, resolution = '') {
  return `${approved ? DEVIATION_APPROVED : DEVIATION_DENIED}${resolution ? `: ${resolution}` : ''}`;
}

// buildAdminDecisionsBlock — the AUTHORITATIVE block the runner is handed once an
// admin has decided the framework deviations for a build. An APPROVED deviation
// OVERRIDES the pinned constitution for this project and MUST be implemented (this
// is the whole point of the admin gate — a human signed off on the exception); a
// DENIED one must not be built. Without this the runner never learns the admin
// approved anything and keeps obeying the constitution, so the requested change
// (e.g. a login page) is silently never built. Pure; unit-tested. `questions` are
// the audit cycle's rows (route + question + answer). Returns '' when there are no
// decided deviations.
export function buildAdminDecisionsBlock(questions = []) {
  const decided = (questions || [])
    .filter((q) => q && q.route === 'admin')
    .map((q) => {
      const ans = String(q.answer || '').trim();
      const approved = ans.toUpperCase().startsWith(DEVIATION_APPROVED);
      const denied = ans.toUpperCase().startsWith(DEVIATION_DENIED);
      return { text: String(q.question || '').trim(), approved, denied };
    })
    .filter((d) => d.text && (d.approved || d.denied));
  if (!decided.length) return '';
  const lines = decided.map((d) => (d.approved
    ? `- APPROVED — you MUST implement this even though it deviates from the constitution: ${d.text}`
    : `- DENIED — do NOT implement this; build the compliant remainder instead: ${d.text}`));
  const anyApproved = decided.some((d) => d.approved);
  const tail = anyApproved
    ? ['When you implement an APPROVED deviation, apply it EVERYWHERE — the backend AND',
       'the user-facing surface: update the screens, the on-page copy, and state/inventory.json',
       'so nothing still advertises the superseded approach (e.g. a login page must not read',
       '"single sign-on with MFA" once password/JWT login is the approved reality). Stale',
       'user-facing copy that contradicts the approved change is a defect.']
    : [];
  return [
    'Administrator decisions on framework deviations (AUTHORITATIVE for this project —',
    'an administrator has signed these off. An APPROVED item OVERRIDES the pinned',
    'constitution and MUST be built exactly as requested; a DENIED item must not be built):',
    ...lines,
    ...tail,
  ].join('\n');
}

// ---- drift (ADR-003 — pinned-at-last-build vs current) ----

// isFrameworkDrifted — has the framework moved since this project last built?
// Only meaningful once the project HAS built at least once (lastBuiltId set); a
// never-built project is not "drifted", it is simply new. Compared by version id
// (monotonic). Pure so the comparison is unit-tested without the registry.
export function isFrameworkDrifted(lastBuiltId, currentId) {
  if (lastBuiltId == null || currentId == null) return false;
  return Number(lastBuiltId) !== Number(currentId);
}

// The label for a remediation (Mock2 X → Y) the drift banner offers — the
// explicit-consent adoption cycle (ADR-003). Pure so the copy is one place.
export function driftLabel(fromVersion, toVersion) {
  return `Mock2 v${fromVersion} → v${toVersion}`;
}

// ---- rule-coverage gate / Define enforcement (run-taxonomy fix #4/C2) ----
//
// rule-coverage (the full-build gate, framework-seed/gates.json) used to exit 0
// whenever state/rules.md had no confirmed rules — a vacuous pass that was
// green on 11 of 11 fleet projects, because nothing else in the battery checks
// BEHAVIOUR. Firing only at gate-run time, on full builds, after the cycle was
// already paid for, was too late; this predicate backs a pre-build refusal
// (audit.js's startBuild) that catches it before any spend.

// rulesGateApplies — does the Define-stage block apply to this build? The
// FIRST build of a project cannot have rules (the interview follows design
// approval, and the greenfield cycle runs at MVP), so the block applies only
// once a project has built at least once — on every mode from then on. A
// quick update to a project that never ran Define is exactly the case that
// produced the fleet's specification-failure waste; exempting the quick lane
// would exempt most of it.
export function rulesGateApplies({ hasBuiltBefore = false, buildMode = null } = {}) {
  return !!hasBuiltBefore;
}

// countConfirmedRules — how many confirmed rules state/rules.md carries. Mirrors
// the gate script's own check exactly: `grep -Ec "<!--[[:space:]]*rule-q[0-9]+"`
// counts matching LINES, not total occurrences, so this does too (appendRule
// always puts one anchor per line, but a hand-edited rules.md could not).
export function countConfirmedRules(text) {
  const lines = String(text || '').split('\n');
  return lines.filter((line) => /<!--\s*rule-q\d+/i.test(line)).length;
}

// ---- API shapes ----

// publicQuestionShape — client-safe view of an audit-question row. The choices
// live both on the row (choices_json) and in the rule_question chat body; this
// exposes them parsed for a non-chat consumer (the admin queue detail).
export function publicQuestionShape(row) {
  if (!row) return null;
  let choices = [];
  try { choices = row.choices_json ? normalizeChoices(JSON.parse(row.choices_json)) : []; } catch { choices = []; }
  return {
    id: row.id,
    project_id: row.project_id,
    cycle_id: row.cycle_id,
    route: row.route,
    kind: row.kind,
    question: row.question || '',
    choices,
    status: row.status,
    answer: row.answer ?? null,
    answered_by: row.answered_by ?? null,
    answered_at: row.answered_at ?? null,
    rules_md_anchor: row.rules_md_anchor ?? null,
    created_at: row.created_at ?? null,
  };
}

// publicQueueItemShape — client-safe view of a queue-item row for the admin
// queue page. projectName is joined in by the caller (cross-DB soft ref).
export function publicQueueItemShape(row, { projectName = null } = {}) {
  if (!row) return null;
  return {
    id: row.id,
    project_id: row.project_id || null,
    project_name: projectName,
    kind: row.kind,
    ref_table: row.ref_table || null,
    ref_id: row.ref_id ?? null,
    detail: row.detail || null,
    status: row.status,
    dedupe_key: row.dedupe_key || null,
    raised_at: row.raised_at || null,
    resolved_by: row.resolved_by ?? null,
    resolved_at: row.resolved_at || null,
    resolution: row.resolution || null,
  };
}

// ---- cost envelope (R5 — the audit step spends too) ----

// The audit is a single model call: the constitution + inventory + rules in, a
// short question list out. Deliberately generous, like the concept/runner
// envelopes — the reservation only has to be credible.
export function estimateAuditTokens() {
  return { inputTokens: 12000, outputTokens: 2500 };
}
