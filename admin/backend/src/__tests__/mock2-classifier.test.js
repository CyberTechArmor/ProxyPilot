// Mock2 Phase M9 tests — the rule-change CLASSIFIER pure decision layer (the
// steady-state iteration loop; ADR-002's three-outcome classifier).
//
// Stub-first (risk R9): imports ONLY classifier-logic.js (+ audit-logic.js, both
// native-free — no db.js, no better-sqlite3, no Incus, no model API). The
// three-outcome decision, the BIAS TO FLAG (anything that isn't a confident
// "implements" flags), the outcome→editor-question-kind mapping, the
// constitution-injected prompt, and the tolerant parse are all safety-relevant to
// what gets built without a rule confirmation, so they're unit-tested here.
//
// The verify checklist's fixture idea ("schedulers should see other practices'
// shifts" — implements / contradicts / unaddressed × N paraphrases → outcome 3 →
// question) is exercised against the parse + normalize below.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CLASSIFIER_OUTCOMES, FLAGGING_OUTCOMES,
  normalizeOutcome, proceedsToBuild, classifierQuestionKind,
  buildClassifierSystemPrompt, buildClassifierTask,
  parseClassifierResult, fallbackQuestion, estimateClassifierTokens,
} from '../mock2/classifier-logic.js';
import { routeForKind } from '../mock2/audit-logic.js';

// ---- constants match migration 502's classifier_outcome CHECK ----

test('classifier outcomes match the mock2_cycles.classifier_outcome CHECK', () => {
  assert.deepEqual([...CLASSIFIER_OUTCOMES].sort(), ['contradicts', 'implements', 'unaddressed']);
  // The two flagging outcomes create editor questions; implements does not.
  assert.deepEqual([...FLAGGING_OUTCOMES].sort(), ['contradicts', 'unaddressed']);
  assert.ok(!FLAGGING_OUTCOMES.includes('implements'));
});

// ---- BIAS TO FLAG: anything that is not a confident "implements" flags ----

test('normalizeOutcome: only an explicit "implements" proceeds; everything else flags', () => {
  assert.equal(normalizeOutcome('implements'), 'implements');
  assert.equal(normalizeOutcome('IMPLEMENTS'), 'implements');
  assert.equal(normalizeOutcome('  implements '), 'implements');
  assert.equal(normalizeOutcome('contradicts'), 'contradicts');
  // Unknown / missing / hedged → the SAFE flag (unaddressed). A false question
  // costs a tap; an unruled build is a silent standards miss (ADR-002).
  assert.equal(normalizeOutcome('unaddressed'), 'unaddressed');
  assert.equal(normalizeOutcome('maybe'), 'unaddressed');
  assert.equal(normalizeOutcome(''), 'unaddressed');
  assert.equal(normalizeOutcome(null), 'unaddressed');
  assert.equal(normalizeOutcome(undefined), 'unaddressed');
  assert.equal(normalizeOutcome('implement'), 'unaddressed'); // typo does NOT proceed
});

test('proceedsToBuild: true ONLY for a confident implements', () => {
  assert.equal(proceedsToBuild('implements'), true);
  assert.equal(proceedsToBuild('contradicts'), false);
  assert.equal(proceedsToBuild('unaddressed'), false);
  assert.equal(proceedsToBuild('garbage'), false);
  assert.equal(proceedsToBuild(''), false);
});

// ---- outcome → EDITOR question kind (a domain rule never goes to admin) ----

test('classifierQuestionKind: contradicts→rule_contradiction, unaddressed→rule_gap, implements→null', () => {
  assert.equal(classifierQuestionKind('contradicts'), 'rule_contradiction');
  assert.equal(classifierQuestionKind('unaddressed'), 'rule_gap');
  assert.equal(classifierQuestionKind('implements'), null);
  // Both flagging kinds are EDITOR-routed — an admin answer is rejected for a
  // domain rule because it never enters the admin queue (ADR-002).
  assert.equal(routeForKind(classifierQuestionKind('contradicts')), 'editor');
  assert.equal(routeForKind(classifierQuestionKind('unaddressed')), 'editor');
});

// ---- the classifier prompt injects the pinned constitution (ADR-003) ----

test('buildClassifierSystemPrompt: embeds the constitution, the three outcomes, and the bias to flag', () => {
  const p = buildClassifierSystemPrompt({ constitution: 'STACK: PostgreSQL only', projectName: 'ShiftSwap' });
  assert.match(p, /STACK: PostgreSQL only/);
  assert.match(p, /ShiftSwap/);
  assert.match(p, /implements/);
  assert.match(p, /contradicts/);
  assert.match(p, /unaddressed/);
  assert.match(p, /bias to flag|BIAS TO FLAG|When in doubt, flag/i);
  assert.match(p, /JSON object/i);
});

test('buildClassifierTask: carries the change, the rules, and the inventory', () => {
  const t = buildClassifierTask({
    message: 'schedulers should see other practices’ shifts',
    rulesMd: '## Rule\nSchedulers see only their own practice.',
    inventory: { screens: ['Roster'] },
    projectName: 'ShiftSwap',
  });
  assert.match(t, /schedulers should see other practices/);
  assert.match(t, /Schedulers see only their own practice/);
  assert.match(t, /Roster/);
  assert.match(t, /When in doubt, flag|never "implements"/i);
});

// ---- the tolerant parse (biased to flag) ----

test('parseClassifierResult: a clean implements decision', () => {
  const r = parseClassifierResult('{"outcome":"implements","matched_rule":"Managers can edit rosters","question":"","choices":[],"rationale":"covered"}');
  assert.equal(r.ok, true);
  assert.equal(r.outcome, 'implements');
  assert.equal(r.matchedRule, 'Managers can edit rosters');
  assert.equal(proceedsToBuild(r.outcome), true);
});

test('parseClassifierResult: an unaddressed decision with a question + choices (outcome 3)', () => {
  const r = parseClassifierResult(`Here is my decision:
\`\`\`json
{"outcome":"unaddressed","matched_rule":null,"question":"Should schedulers see other practices’ shifts?","choices":["Own practice only","All practices"],"rationale":"no rule covers cross-practice visibility"}
\`\`\``);
  assert.equal(r.ok, true);
  assert.equal(r.outcome, 'unaddressed');
  assert.equal(r.matchedRule, null);
  assert.match(r.question, /other practices/);
  assert.deepEqual(r.choices, ['Own practice only', 'All practices']);
  assert.equal(classifierQuestionKind(r.outcome), 'rule_gap');
});

test('parseClassifierResult: an unknown/garbled outcome is coerced to a FLAG, never implements', () => {
  const r = parseClassifierResult('{"outcome":"probably fine","question":"Confirm?","choices":[]}');
  assert.equal(r.ok, true);
  assert.equal(r.outcome, 'unaddressed'); // biased to flag
  assert.equal(proceedsToBuild(r.outcome), false);
});

test('parseClassifierResult: a hard non-JSON failure is NOT a silent build', () => {
  const r = parseClassifierResult('I could not decide.');
  assert.equal(r.ok, false);
  assert.match(r.error, /not valid JSON|JSON object/i);
});

test('parseClassifierResult: empty response fails (surfaced, not built)', () => {
  assert.equal(parseClassifierResult('').ok, false);
  assert.equal(parseClassifierResult('   ').ok, false);
});

// ---- fallback question (a flagged outcome MUST have something to confirm) ----

test('fallbackQuestion: gives the editor a question when the model returned none', () => {
  const c = fallbackQuestion('contradicts', { message: 'let schedulers see all practices' });
  const u = fallbackQuestion('unaddressed', { message: 'let schedulers see all practices' });
  assert.match(c, /conflict/i);
  assert.match(u, /rule/i);
  assert.match(c, /all practices/);
});

// ---- the "N paraphrases → outcome 3" fixture idea ----

test('the fixture suite: three paraphrases of an unaddressed change all flag (outcome 3)', () => {
  const paraphrases = [
    '{"outcome":"unaddressed","question":"Cross-practice visibility?","choices":["No","Yes"]}',
    '{"outcome":"UNADDRESSED","question":"Show other practices?","choices":["No","Yes"]}',
    // the model hedged with a non-vocabulary word — still flags, never implements
    '{"outcome":"needs-a-rule","question":"Other practices too?","choices":["No","Yes"]}',
  ];
  for (const raw of paraphrases) {
    const r = parseClassifierResult(raw);
    assert.equal(r.ok, true);
    assert.equal(r.outcome, 'unaddressed');
    assert.equal(proceedsToBuild(r.outcome), false);
    assert.equal(classifierQuestionKind(r.outcome), 'rule_gap');
    assert.equal(routeForKind(classifierQuestionKind(r.outcome)), 'editor');
  }
});

// ---- cost envelope ----

test('estimateClassifierTokens: a credible, generous single-call envelope', () => {
  const e = estimateClassifierTokens();
  assert.ok(e.inputTokens > 0 && e.outputTokens > 0);
});
