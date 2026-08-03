// THE RULES VIEW — sign-off #2 finally has a read side.
//
// The audit (stage 'define') raises rule questions, an editor taps an answer,
// and appendRule commits it to state/rules.md with a hash-chained change
// record. That is the second of the two human approvals that gate all code.
// And nothing in the product ever showed it back: from the moment a rule was
// confirmed, the only way to read what the app was being built against was to
// open a terminal into the container.
//
// The stage indicator drew "Define" as a step the whole time. The step ran.
// Its one artefact was invisible.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  RULES_PATH, parseRulesMd, parseRulesPack, rulesView, rulesStageInfo,
} from '../mock2/rules-view-logic.js';
import { appendRule } from '../mock2/audit-logic.js';
import { CRUD_RULES_PACK } from '../mock2/rules-pack-logic.js';

/* --------------------- it reads what the audit writes --------------------- */

test('IT PARSES THE REAL GENERATOR, not a hand-typed fixture', () => {
  // The one bug this test exists to prevent: a fixture that keeps passing after
  // appendRule's format moves. So the input is built BY appendRule.
  let md = '';
  md = appendRule(md, { questionId: 1, question: 'Can a note be deleted by anyone but its author?', answer: 'No — author and admins only.' }).md;
  md = appendRule(md, { questionId: 2, question: 'Do completed to-dos stay visible?', answer: 'Yes, struck through, with a filter to hide them.' }).md;

  const p = parseRulesMd(md);
  assert.equal(p.rules.length, 2);
  assert.deepEqual(p.rules.map((r) => r.anchor), ['rule-q1', 'rule-q2']);
  assert.match(p.rules[0].question, /deleted by anyone but its author/);
  assert.equal(p.rules[0].answer, 'No — author and admins only.');
  assert.equal(p.rules[1].answer, 'Yes, struck through, with a filter to hide them.');
  assert.equal(p.malformed, 0);
  assert.equal(p.rules[0].origin, 'confirmed');
});

test('the document preamble is not mistaken for a rule', () => {
  const { md } = appendRule('', { questionId: 9, question: 'Q?', answer: 'A.' });
  const p = parseRulesMd(md);
  assert.equal(p.rules.length, 1, 'the "# Project rules" header block is not an entry');
  assert.match(p.intro, /Confirmed domain rules/);
});

test('a hand-written section is shown, not silently dropped', () => {
  // The operator's rule is the operator's rule. Requiring our exact format
  // would make an edited file look empty.
  const p = parseRulesMd('# Project rules\n\n## Something a person typed\n\nNo answer marker here.\n');
  assert.equal(p.rules.length, 1);
  assert.equal(p.rules[0].answer, '', 'the answer is left empty rather than guessed out of the prose');
  assert.equal(p.malformed, 1);
});

test('an empty or absent file is not an error', () => {
  for (const v of ['', '   ', null, undefined]) {
    const p = parseRulesMd(v);
    assert.equal(p.ok, true);
    assert.deepEqual(p.rules, []);
  }
});

/* ------------------------- the floor everyone gets ------------------------ */

test('the baseline comes from the PACK, so there is one definition', () => {
  // Re-typing the eight rules into the panel is how the panel and the builds
  // start disagreeing about what is guaranteed.
  const pack = parseRulesPack(CRUD_RULES_PACK);
  assert.equal(pack.length, 8, 'every numbered rule in the pack must appear');
  assert.ok(pack.every((r) => r.origin === 'baseline'));
  assert.ok(pack.every((r) => r.answer.length > 20), 'a rule that lost its body is worse than no rule');
  // Wrapped entries must be rejoined, not truncated at the first newline.
  assert.match(pack[0].answer, /can create can also be edited and deleted by its creator \(and admins\)/);
  assert.match(pack[6].answer, /Empty states are designed/);
});

test('MOST PROJECTS HAVE NO CONFIRMED RULES, and must not be told they have none', () => {
  // rules.md is only written by the audited Full build lane; the chat's Quick
  // update never writes it. Showing only the confirmed set would tell the
  // majority of projects "you have no rules" while eight are being enforced.
  const v = rulesView({ rulesMd: '', packText: CRUD_RULES_PACK, auditRan: false });
  assert.equal(v.counts.confirmed, 0);
  assert.equal(v.counts.baseline, 8);
  assert.match(v.emptyMessage, /baseline below applies to every build/);
  assert.match(v.emptyMessage, /Full build/, 'and it must say how to get more');
});

test('"the audit ran and you answered nothing" reads differently', () => {
  const v = rulesView({ rulesMd: '', packText: CRUD_RULES_PACK, auditRan: true });
  assert.match(v.emptyMessage, /every question was left unanswered/);
});

test('confirmed and baseline are never merged', () => {
  // Different authority: a baseline rule is a platform default, a confirmed one
  // is a person signing off on their domain. Blurring them makes the sign-off
  // worth less than it is.
  const { md } = appendRule('', { questionId: 1, question: 'Q?', answer: 'A.' });
  const v = rulesView({ rulesMd: md, packText: CRUD_RULES_PACK });
  assert.equal(v.confirmed.length, 1);
  assert.equal(v.baseline.length, 8);
  assert.equal(v.emptyMessage, '', 'nothing to explain once a rule exists');
  assert.ok(v.confirmed.every((r) => r.origin === 'confirmed'));
  assert.ok(v.baseline.every((r) => r.origin === 'baseline'));
});

/* ---------------------------- the stage indicator ------------------------- */

test('the indicator only ever gains detail — it never moves backwards', () => {
  const concept = { current: 'concept', build_unlocked: false };
  assert.equal(rulesStageInfo(concept, { confirmedCount: 0 }).current, 'concept',
    'Define is not the current step on a project that has not approved a design');

  const build = { current: 'build', build_unlocked: true };
  assert.equal(rulesStageInfo(build, { confirmedCount: 0 }).current, 'define',
    'build unlocked with no rules confirmed IS the Define step');
  assert.equal(rulesStageInfo(build, { confirmedCount: 3 }).current, 'build');
  assert.equal(rulesStageInfo(build, { confirmedCount: 3 }).define_done, true);
});

test('with no count supplied, the indicator is byte-identical to before', () => {
  // This must be invisible to every caller that does not opt in.
  const base = { current: 'build', build_unlocked: true, stages: ['concept', 'define', 'build', 'run'] };
  assert.deepEqual(rulesStageInfo(base, {}), base);
  assert.deepEqual(rulesStageInfo(base, { confirmedCount: null }), base);
  assert.equal(rulesStageInfo(null, { confirmedCount: 2 }), null);
});

/* ------------------------------- the wiring ------------------------------- */

test('RATCHET: the route serves BOTH sources and does not lie when unreachable', () => {
  const src = readFileSync(new URL('../mock2/routes.js', import.meta.url), 'utf8');
  const i = src.indexOf("router.get('/projects/:id/rules'");
  assert.ok(i > 0, 'the read side must exist');
  const block = src.slice(i, i + 2000);
  assert.match(block, /CRUD_RULES_PACK/, 'the floor must be served, or most projects read as ruleless');
  assert.match(block, /reachable = false/, 'an unreachable container is not "no rules"');
  assert.match(block, /listQuestionsForProject/);
  assert.match(block, /requireMock2Role\('viewer'\)/, 'reading your own rules is not an editor action');
});

test('RATCHET: the reader is shared with the writer', () => {
  // A second file-reading helper is a second APP_DIR and a second not-found
  // convention to keep in step.
  const audit = readFileSync(new URL('../mock2/audit.js', import.meta.url), 'utf8');
  assert.match(audit, /export async function readProjectFile/);
  assert.equal(RULES_PATH, 'state/rules.md');
  // audit.js used to hand-maintain its OWN 'state/rules.md' literal — a second
  // copy of the exact path this module canonicalizes. It now imports RULES_PATH
  // from here instead (C2), so there is one declaration, not two to keep in
  // step; a stray re-declared literal would be the regression this guards.
  assert.match(audit, /import \{ RULES_PATH \} from '\.\/rules-view-logic\.js'/, 'audit.js must import the canonical RULES_PATH, not redeclare it');
  assert.doesNotMatch(audit, /const RULES_PATH = 'state\/rules\.md'/, 'audit.js must not hand-maintain a second copy of the path');
});
