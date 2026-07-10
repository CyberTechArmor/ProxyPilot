// Mock2 rule-change CLASSIFIER pure decision layer (Phase M9, ADR-002; the
// steady-state iteration loop). Native-free, unit-tested stub-first (risk R9):
// imports NOTHING that opens a DB, hits the network, or touches Incus.
//
// Every iteration message (a chat message sent AFTER the design is approved)
// runs the classifier before anything is built. It compares the requested change
// against the project's confirmed state/rules.md + the pinned constitution and
// returns exactly one of THREE outcomes (ADR-002):
//
//   * "implements"  — the change is already covered by a confirmed rule; build
//                     it directly, no question.
//   * "contradicts" — the change conflicts with a confirmed rule; ask the editor
//                     to reconfirm (outcome-2 reconfirm flow, EDITOR-ONLY — an
//                     admin answer is rejected for a domain rule because it never
//                     goes to the admin queue; it is a rule_contradiction).
//   * "unaddressed" — no rule speaks to this change; ask the editor a lazy rule
//                     question (rule_gap), then build.
//
// BIAS TO FLAG (ADR-002): a false positive costs a tap, a false negative ships an
// unruled change. So the outcome normalization treats ANYTHING that is not an
// explicit "implements" as a flag — an unknown/missing/garbled outcome collapses
// to "unaddressed". Only a confident "implements" proceeds straight to build.
//
// The orchestration (classifier.js) REUSES the M8 audit question plumbing:
// contradicts / unaddressed both create EDITOR questions (questions.insertQuestion
// + the rule_question chat message), exactly like the audit's editor questions,
// and the SAME answer path (audit.answerAuditQuestion) appends to rules.md and
// resumes the deferred build. There is no second question path.
//
// Terminology (risk R7): nothing here is named "agent".

import { normalizeChoices } from './audit-logic.js';

// The three classifier outcomes (mock2_cycles.classifier_outcome CHECK,
// migration 502). Order is meaningful only for readability.
export const CLASSIFIER_OUTCOMES = Object.freeze(['implements', 'contradicts', 'unaddressed']);

// The two outcomes that FLAG (create an editor question before the build). Only
// "implements" proceeds straight to build.
export const FLAGGING_OUTCOMES = Object.freeze(['contradicts', 'unaddressed']);

// normalizeOutcome — the bias-to-flag core. An explicit "implements" is the ONLY
// value that proceeds directly; an explicit "contradicts" flags a reconfirm;
// EVERYTHING else (a plausible-but-unrecognized string, an empty value, a typo,
// the model hedging) collapses to "unaddressed" — the safe flag. A false editor
// question costs a tap; an unruled build is a silent standards miss (ADR-002).
export function normalizeOutcome(raw) {
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  if (v === 'implements') return 'implements';
  if (v === 'contradicts') return 'contradicts';
  return 'unaddressed';
}

// Does this outcome proceed straight to build (no question)? Only "implements".
export function proceedsToBuild(outcome) {
  return normalizeOutcome(outcome) === 'implements';
}

// The audit-question KIND an outcome materializes as (both EDITOR-routed via
// audit-logic.routeForKind — a domain rule NEVER goes to the admin queue, so an
// admin answer is rejected for it, ADR-002). "implements" has no question.
export function classifierQuestionKind(outcome) {
  switch (normalizeOutcome(outcome)) {
    case 'contradicts': return 'rule_contradiction';
    case 'unaddressed': return 'rule_gap';
    default: return null; // implements — no question
  }
}

// ---- the classifier system prompt (constitution-injected, like the audit) ----

// buildClassifierSystemPrompt — the classifier slot's system prompt. Injects the
// pinned constitution verbatim (ADR-003) — the rules a change is measured against
// were confirmed UNDER this constitution — and states the three-outcome contract
// with the explicit bias to flag.
export function buildClassifierSystemPrompt({ constitution = '', projectName = 'this project' } = {}) {
  return `You are the Mock2 rule-change CLASSIFIER for "${projectName}". A Builder has
asked for a change to an app that is already live. Before anything is built you
decide how the requested change relates to the project's CONFIRMED rules
(state/rules.md) — the domain decisions the editors have already signed off.

Return EXACTLY ONE outcome:

  - "implements": a confirmed rule already covers this change — it is a normal
    build that respects the existing rules. Nothing to ask; the build proceeds.
  - "contradicts": the change conflicts with a confirmed rule (it would break or
    reverse a decision already made). The editor must reconfirm before building —
    quote the rule it conflicts with.
  - "unaddressed": no confirmed rule speaks to this change. It raises a NEW domain
    decision the editor should make once, so the rule is captured for next time.

BIAS TO FLAG. If you are not confident a confirmed rule already covers the change,
do NOT answer "implements" — answer "unaddressed" (or "contradicts" if it clashes).
A needless question costs the editor one tap; a wrongly-waved-through change ships
an app that violates an unstated rule. When in doubt, flag.

For "contradicts" and "unaddressed", write a plain-language question the editor
(who may be non-technical) can answer, with 2–4 concrete tappable choices; a
free-text answer is always allowed too. For "implements", no question is needed.

The pinned framework constitution (the rules were confirmed under this):

# Constitution (pinned)
${constitution || '(constitution content is still owed — risk R8)'}

Output ONLY a JSON object, no markdown, no code fences, no commentary:

{
  "outcome": "implements|contradicts|unaddressed",
  "matched_rule": "the confirmed rule this implements or contradicts, or null",
  "question": "plain-language question for the editor (empty for implements)",
  "choices": ["option A", "option B"],
  "rationale": "one line: why this outcome"
}`;
}

// buildClassifierTask — the classifier's user turn: the requested change, the
// confirmed rules.md (may be empty), and the approved inventory, so the classifier
// decides against the exact state the build would run on.
export function buildClassifierTask({ message = '', rulesMd = '', inventory = null, projectName = 'the app' } = {}) {
  const invText = inventory == null
    ? '(no inventory found)'
    : (typeof inventory === 'string' ? inventory : JSON.stringify(inventory, null, 2));
  const rules = String(rulesMd || '').trim();
  return [
    `Project: ${projectName}`,
    `Requested change (the Builder's iteration message):\n${String(message || '').trim() || '(no message)'}`,
    `Confirmed rules (state/rules.md):\n${rules || '(rules.md is empty — no rules confirmed yet)'}`,
    `Approved design inventory (state/inventory.json — the UI contract):\n${invText}`,
    'Classify the requested change against the confirmed rules. Return the JSON object described. When in doubt, flag (never "implements").',
  ].join('\n\n');
}

// ---- parse + validate the classifier output (biased to flag) ----

// parseClassifierResult — parse the classifier's JSON into a canonical decision.
// Tolerant of ```json fences and leading prose (like parseAuditQuestions /
// parseInventory). The outcome is normalized through normalizeOutcome, so an
// invalid/missing outcome is a FLAG (unaddressed), never an accidental build.
// Returns { ok, outcome, matchedRule, question, choices, rationale, error }.
// ok:false only when the response is not JSON at all (a hard model failure — the
// orchestrator surfaces it and does NOT silently build).
export function parseClassifierResult(text) {
  let s = String(text || '').trim();
  if (!s) return { ok: false, error: 'empty classifier response' };
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1]) s = fence[1].trim();
  else {
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start > 0 && end > start) s = s.slice(start, end + 1);
  }
  let doc;
  try { doc = JSON.parse(s); } catch (e) { return { ok: false, error: `classifier output is not valid JSON: ${e.message}` }; }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { ok: false, error: 'classifier output must be a JSON object' };
  }
  const outcome = normalizeOutcome(doc.outcome);
  const question = String(doc.question || '').trim();
  const choices = normalizeChoices(doc.choices);
  const matchedRule = doc.matched_rule == null ? null : String(doc.matched_rule).trim() || null;
  const rationale = String(doc.rationale || '').trim();
  return { ok: true, outcome, matchedRule, question, choices, rationale };
}

// A safe fallback question when the classifier flags an outcome but returns no
// question text (it must never proceed to build on a flagged outcome, and the
// editor must be given SOMETHING to confirm). Plain language, no choices —
// free-text is always the escape hatch.
export function fallbackQuestion(outcome, { message = '' } = {}) {
  const change = String(message || '').trim().replace(/\s+/g, ' ').slice(0, 160);
  if (normalizeOutcome(outcome) === 'contradicts') {
    return `This change may conflict with a rule you already confirmed${change ? `: “${change}”` : ''}. Should we go ahead with it?`;
  }
  return `This change isn't covered by a confirmed rule yet${change ? `: “${change}”` : ''}. How should it behave?`;
}

// ---- cost envelope (R5 — the classifier spends on every iteration message) ----

// The classifier is a single, cheap model call: rules + the message in, a small
// JSON decision out. Deliberately generous like the audit envelope — the
// reservation only has to be credible.
export function estimateClassifierTokens() {
  return { inputTokens: 8000, outputTokens: 1200 };
}
