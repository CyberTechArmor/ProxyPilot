// Mock2 Phase M8 tests — the AUDIT pure decision layer (audit, rule questions,
// admin queue; the two-way routing that gates Build, ADR-002).
//
// Stub-first (risk R9): imports ONLY audit-logic.js (native-free — no db.js, no
// better-sqlite3, no Incus, no model API). The kind→route split (the heart of
// ADR-002), the constitution-injected audit prompt, the question-list parse +
// validation, the rules.md append (sign-off #2), the build-gate predicate, drift
// detection, and the API shapes are all safety-relevant to Build, so they're
// unit-tested here.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AUDIT_KINDS, EDITOR_KINDS, QUEUE_KINDS, QUEUE_STATUSES, AWAITING_ADMIN_QUEUE_KINDS,
  routeForKind, buildAuditSystemPrompt, buildAuditTask,
  parseAuditQuestions, normalizeChoices, splitQuestionsByRoute,
  buildRuleQuestionBody, parseRuleQuestionBody,
  ruleAnchor, ruleHeading, appendRule,
  auditGateCleared, blockedBuildStatus,
  isFrameworkDrifted, driftLabel,
  publicQuestionShape, publicQueueItemShape, estimateAuditTokens,
} from '../mock2/audit-logic.js';

// ---- routing (ADR-002 — route by kind, never by convenience) ----

test('routeForKind: framework_deviation → admin; every other kind → editor', () => {
  assert.equal(routeForKind('framework_deviation'), 'admin');
  assert.equal(routeForKind('domain_question'), 'editor');
  assert.equal(routeForKind('rule_contradiction'), 'editor');
  assert.equal(routeForKind('rule_gap'), 'editor');
  // Unknown kinds default to the SAFE lane (editor) — a mis-routed deviation
  // would silently change the framework; a false editor question costs a tap.
  assert.equal(routeForKind('anything_else'), 'editor');
});

test('kind + queue constants match the migration-502 CHECKs', () => {
  assert.deepEqual([...AUDIT_KINDS].sort(), ['domain_question', 'framework_deviation', 'rule_contradiction', 'rule_gap'].sort());
  assert.ok(EDITOR_KINDS.every((k) => routeForKind(k) === 'editor'));
  assert.ok(!EDITOR_KINDS.includes('framework_deviation'));
  for (const k of AWAITING_ADMIN_QUEUE_KINDS) assert.ok(QUEUE_KINDS.includes(k));
  // drift + flag are NOT "awaiting admin" (drift is its own status; flag is the overlay).
  assert.ok(!AWAITING_ADMIN_QUEUE_KINDS.includes('drift'));
  assert.ok(!AWAITING_ADMIN_QUEUE_KINDS.includes('flag'));
  assert.deepEqual(QUEUE_STATUSES, ['open', 'in_progress', 'resolved', 'dismissed']);
});

// ---- the audit prompt injects the pinned constitution (ADR-003) ----

test('buildAuditSystemPrompt: embeds the constitution + the never-change-framework rule', () => {
  const p = buildAuditSystemPrompt({ constitution: 'STACK: PostgreSQL only', projectName: 'ShiftSwap' });
  assert.match(p, /STACK: PostgreSQL only/);
  assert.match(p, /ShiftSwap/);
  assert.match(p, /framework_deviation/);
  assert.match(p, /administrator/i);
  assert.match(p, /never change the framework|answer never changes the framework/i);
  // instructs JSON output + the empty-list (no-questions) contract
  assert.match(p, /JSON object/i);
  assert.match(p, /empty/i);
});

test('buildAuditTask: carries inventory + rules + instruction + pinned version', () => {
  const t = buildAuditTask({
    inventory: { screens: [{ name: 'Home' }] },
    rulesMd: '# rules\n- no overlap',
    instruction: 'store bookings in MySQL',
    projectName: 'Rooms', frameworkVersion: 3,
  });
  assert.match(t, /Rooms/);
  assert.match(t, /version: 3/i);
  assert.match(t, /MySQL/);
  assert.match(t, /Home/);
  assert.match(t, /no overlap/);
  // empty rules render an explicit "no rules yet" marker, not a blank
  assert.match(buildAuditTask({ inventory: {}, rulesMd: '' }), /empty|no rules/i);
});

// ---- parse + validate + route the audit output ----

test('parseAuditQuestions: routes each kind, tolerates fences, drops invalid', () => {
  const raw = '```json\n' + JSON.stringify({
    questions: [
      { kind: 'domain_question', question: 'Can bookings overlap?', choices: ['Yes', 'No'] },
      { kind: 'framework_deviation', question: 'Inventory implies MySQL; constitution mandates PostgreSQL.' },
      { kind: 'not_a_kind', question: 'ignored' },
      { kind: 'rule_gap', question: '' }, // empty question dropped
    ],
  }) + '\n```';
  const r = parseAuditQuestions(raw);
  assert.equal(r.ok, true);
  assert.equal(r.questions.length, 2);
  assert.equal(r.questions[0].route, 'editor');
  assert.deepEqual(r.questions[0].choices, ['Yes', 'No']);
  assert.equal(r.questions[1].route, 'admin');
  assert.equal(r.questions[1].kind, 'framework_deviation');
});

test('parseAuditQuestions: empty question list is OK (build proceeds)', () => {
  const r = parseAuditQuestions(JSON.stringify({ questions: [] }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.questions, []);
});

test('parseAuditQuestions: non-JSON / non-object is a graceful failure, not a throw', () => {
  assert.equal(parseAuditQuestions('the app looks fine to me').ok, false);
  assert.equal(parseAuditQuestions('').ok, false);
  assert.equal(parseAuditQuestions('[1,2,3]').ok, false);
});

test('normalizeChoices: trims, dedupes, caps, coerces', () => {
  assert.deepEqual(normalizeChoices([' A ', 'A', 'B', '', null, 3]), ['A', 'B', '3']);
  assert.deepEqual(normalizeChoices('nope'), []);
  assert.equal(normalizeChoices(['a', 'b', 'c', 'd', 'e', 'f', 'g']).length, 6);
});

test('splitQuestionsByRoute: partitions editor vs admin, order-stable', () => {
  const { editor, admin } = splitQuestionsByRoute([
    { route: 'editor', question: 'q1' },
    { route: 'admin', question: 'd1' },
    { route: 'editor', question: 'q2' },
  ]);
  assert.deepEqual(editor.map((q) => q.question), ['q1', 'q2']);
  assert.deepEqual(admin.map((q) => q.question), ['d1']);
});

// ---- the in-chat rule_question body ----

test('rule_question body: round-trips question + choices as JSON', () => {
  const body = buildRuleQuestionBody({ question: 'Overlap?', choices: ['Yes', 'No'] });
  const parsed = parseRuleQuestionBody(body);
  assert.equal(parsed.question, 'Overlap?');
  assert.deepEqual(parsed.choices, ['Yes', 'No']);
  // tolerant of a plain-text (non-JSON) body
  assert.equal(parseRuleQuestionBody('just text').question, 'just text');
  assert.deepEqual(parseRuleQuestionBody('just text').choices, []);
});

// ---- rules.md append (sign-off #2) ----

test('appendRule: seeds a header on empty rules, embeds an addressable anchor', () => {
  const { md, anchor } = appendRule('', { questionId: 7, question: 'Can bookings overlap?', answer: 'No' });
  assert.equal(anchor, 'rule-q7');
  assert.match(md, /# Project rules/);
  assert.match(md, /## Can bookings overlap\?/);
  assert.match(md, /<!-- rule-q7 -->/);
  assert.match(md, /\*\*Answer:\*\* No/);
});

test('appendRule: appends after existing content without clobbering it', () => {
  const first = appendRule('', { questionId: 1, question: 'Q one', answer: 'A one' }).md;
  const { md, anchor } = appendRule(first, { questionId: 2, question: 'Q two', answer: 'A two' });
  assert.equal(anchor, 'rule-q2');
  assert.match(md, /Q one/);
  assert.match(md, /Q two/);
  // exactly one top header, both anchors present
  assert.equal((md.match(/# Project rules/g) || []).length, 1);
  assert.match(md, /rule-q1/);
  assert.match(md, /rule-q2/);
});

test('ruleHeading: single-lines and truncates long questions', () => {
  assert.equal(ruleHeading('  a\n  b  '), 'a b');
  assert.ok(ruleHeading('x'.repeat(200)).length <= 80);
  assert.equal(ruleAnchor(42), 'rule-q42');
});

// ---- the build gate (DERIVED) ----

test('auditGateCleared / blockedBuildStatus: editors act first, then admins', () => {
  assert.equal(auditGateCleared({ openEditorQuestions: 0, openAdminItems: 0 }), true);
  assert.equal(auditGateCleared({ openEditorQuestions: 1, openAdminItems: 0 }), false);
  assert.equal(auditGateCleared({ openEditorQuestions: 0, openAdminItems: 2 }), false);
  assert.equal(blockedBuildStatus({ openEditorQuestions: 2, openAdminItems: 1 }), 'awaiting_user');
  assert.equal(blockedBuildStatus({ openEditorQuestions: 0, openAdminItems: 1 }), 'awaiting_admin');
  assert.equal(blockedBuildStatus({ openEditorQuestions: 0, openAdminItems: 0 }), null);
});

// ---- drift (ADR-003) ----

test('isFrameworkDrifted: only a built-before project can drift', () => {
  assert.equal(isFrameworkDrifted(null, 3), false); // never built
  assert.equal(isFrameworkDrifted(2, null), false);
  assert.equal(isFrameworkDrifted(2, 2), false);
  assert.equal(isFrameworkDrifted(2, 3), true);
  assert.equal(driftLabel(2, 3), 'Mock2 v2 → v3');
});

// ---- API shapes ----

test('publicQuestionShape: parses choices_json, never leaks raw columns', () => {
  const s = publicQuestionShape({
    id: 5, project_id: 1, cycle_id: 9, route: 'editor', kind: 'domain_question',
    question: 'Q', choices_json: '["A","B"]', status: 'open', answer: null,
    answered_by: null, answered_at: null, rules_md_anchor: null, created_at: 't',
  });
  assert.deepEqual(s.choices, ['A', 'B']);
  assert.equal(s.route, 'editor');
  assert.equal('choices_json' in s, false);
});

test('publicQueueItemShape: joins the project name, keeps status/resolution', () => {
  const s = publicQueueItemShape(
    { id: 1, project_id: 4, kind: 'framework_deviation', ref_table: 'mock2_audit_questions', ref_id: 5, detail: 'd', status: 'open', dedupe_key: 'k', raised_at: 't' },
    { projectName: 'Rooms' },
  );
  assert.equal(s.project_name, 'Rooms');
  assert.equal(s.kind, 'framework_deviation');
  assert.equal(s.status, 'open');
});

test('estimateAuditTokens: a credible non-zero reservation', () => {
  const e = estimateAuditTokens();
  assert.ok(e.inputTokens > 0 && e.outputTokens > 0);
});
