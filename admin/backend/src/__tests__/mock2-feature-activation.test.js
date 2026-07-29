// FEATURE ACTIVATION — the ledger that answers "did that actually run?"
//
// Six features shipped in a week, every one unit-tested, not one observed on a
// live build. Asked "did demo content run on this build?", the only way to find
// out was to scroll a chat hunting for a note that may never have been written
// — because a feature that DECLINES to act writes nothing, and silence reads
// identically to never having run at all.
//
// The skip rows are the point. A `fired` row was always discoverable somehow;
// "it ran and decided not to act, because X" was not discoverable at all.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  FEATURES, ACTIVATION_STATES, isKnownFeature, normaliseActivation,
  mergeActivations, activationNote, activationSummary,
} from '../mock2/feature-activation-logic.js';
import {
  recordFeature, takeFeatureLedger, peekFeatureLedger, _resetFeatureLedgers,
} from '../mock2/feature-activation.js';

const E = (feature, state, detail = '') => ({ feature, state, detail });

/* ------------------------------ the entries ------------------------------- */

test('an unknown feature or state is dropped, not stored', () => {
  // A typo must be an absence, never a junk row that looks like data.
  assert.equal(normaliseActivation(E('not_a_feature', 'fired')), null);
  assert.equal(normaliseActivation(E('clarifier', 'maybe')), null);
  assert.equal(normaliseActivation(null), null);
  assert.equal(normaliseActivation({}), null);
  assert.ok(isKnownFeature('demo_content'));
  assert.ok(!isKnownFeature('demo content'));
});

test('every declared state is one of the three, and every feature has a label', () => {
  assert.deepEqual([...ACTIVATION_STATES], ['fired', 'skipped', 'failed']);
  for (const [k, v] of Object.entries(FEATURES)) {
    assert.equal(typeof v, 'string', k);
    assert.ok(v.length, k);
  }
});

test('detail is capped so one runaway string cannot become the note', () => {
  const e = normaliseActivation(E('clarifier', 'fired', 'x'.repeat(500)));
  assert.equal(e.detail.length, 240);
});

/* ------------------------------- the merge -------------------------------- */

test('the LAST word wins, and the first position is kept', () => {
  // A feature can report twice (read at the gate, again at smoke). Keeping both
  // makes the ledger a log; keeping the first freezes an early "skipped" over a
  // later "fired".
  const m = mergeActivations([
    E('shell_contract', 'skipped', 'nothing declared'),
    E('clarifier', 'fired', 'asked'),
    E('shell_contract', 'fired', 'nav: side'),
  ]);
  assert.deepEqual(m.map((e) => e.feature), ['shell_contract', 'clarifier']);
  assert.equal(m[0].state, 'fired');
  assert.equal(m[0].detail, 'nav: side');
});

test('A FAILURE IS NEVER OVERWRITTEN BY A LATER SUCCESS', () => {
  // A feature that threw and then partially recovered is a thing to look at,
  // not a thing to forget. This is the one case where last-wins is wrong.
  const m = mergeActivations([
    E('removal_claims', 'failed', 'boom'),
    E('removal_claims', 'fired', 'all good'),
  ]);
  assert.equal(m[0].state, 'failed');
  assert.equal(m[0].detail, 'boom');
});

/* -------------------------------- the note -------------------------------- */

test('EVERY declared feature appears — including the ones that never reported', () => {
  // "not reached" is a real and different answer from "skipped": it is what an
  // operator sees when the build never got that far. Inventing a "skipped" for
  // it would be a lie in the direction of everything-is-fine.
  const note = activationNote([E('clarifier', 'skipped', 'a continuation')]);
  for (const label of Object.values(FEATURES)) {
    assert.ok(note.includes(label), `${label} must be accounted for`);
  }
  assert.match(note, /Request clarifier\s+a continuation/);
  assert.match(note, /not reached/);
});

test('the three states are visually distinct', () => {
  const note = activationNote([
    E('clarifier', 'fired', 'asked'),
    E('demo_content', 'skipped', 'already seeded'),
    E('design_review', 'failed', 'browser error'),
  ]);
  assert.match(note, /✓ Request clarifier/);
  assert.match(note, /– Demo content/);
  assert.match(note, /! Design review/);
});

test('a failure says whose fault it is', () => {
  // The operator's first instinct on a red line is to look at their own app.
  const note = activationNote([E('design_review', 'failed', 'AUTOMATION_CONTEXT is not defined')]);
  assert.match(note, /platform defect, not something your app did/);
  assert.match(note, /Design review/);
});

test('an empty ledger produces no note at all', () => {
  // A build that recorded nothing must not post a wall of "not reached" — that
  // is noise, and noise is how a useful note stops being read.
  assert.equal(activationNote([]), '');
  assert.equal(activationNote([E('nope', 'fired')]), '');
});

test('the summary counts what the note shows', () => {
  const s = activationSummary([
    E('clarifier', 'fired'), E('demo_content', 'skipped'), E('design_review', 'failed'),
  ]);
  assert.deepEqual([s.total, s.fired, s.skipped, s.failed], [3, 1, 1, 1]);
  assert.equal(s.notReached, Object.keys(FEATURES).length - 3);
});

/* ------------------------------ the collector ----------------------------- */

test('the collector round-trips, and CLEARS on take', () => {
  _resetFeatureLedgers();
  recordFeature(7, 'clarifier', 'skipped', 'a continuation');
  recordFeature(7, 'removal_claims', 'fired', '1 claim');
  assert.equal(peekFeatureLedger(7).length, 2);

  const taken = takeFeatureLedger(7);
  assert.equal(taken.entries.length, 2);
  assert.match(taken.note, /Request clarifier/);
  // A retried cycle must not inherit the previous attempt's ledger and report
  // features that did not run this time.
  assert.deepEqual(peekFeatureLedger(7), []);
  assert.equal(takeFeatureLedger(7).note, '');
});

test('ledgers do not bleed between projects', () => {
  _resetFeatureLedgers();
  recordFeature(1, 'clarifier', 'fired', 'p1');
  recordFeature(2, 'clarifier', 'fired', 'p2');
  assert.equal(takeFeatureLedger(1).entries[0].detail, 'p1');
  assert.equal(takeFeatureLedger(2).entries[0].detail, 'p2');
});

test('RECORDING NEVER THROWS, whatever it is handed', () => {
  // Instrumentation that can break a build is worse than no instrumentation.
  _resetFeatureLedgers();
  for (const args of [
    [null, null, null], [undefined, 'clarifier', 'fired'], [1, 'bogus', 'fired'],
    [1, 'clarifier', 'bogus'], [{}, 'clarifier', 'fired'], [1, 'clarifier', 'fired', { toString() { throw new Error('x'); } }],
  ]) {
    assert.doesNotThrow(() => recordFeature(...args), JSON.stringify(args.slice(1)));
  }
});

test('a runaway loop cannot grow the ledger without bound', () => {
  _resetFeatureLedgers();
  for (let i = 0; i < 500; i++) recordFeature(9, 'clarifier', 'fired', `n${i}`);
  assert.ok(peekFeatureLedger(9).length <= 60);
});

/* ------------------------------- the wiring ------------------------------- */

test('RATCHET: the SKIP branches are wired, not just the interesting ones', () => {
  // The whole value is the quiet case. Recording only when a feature acts
  // rebuilds the exact blind spot this exists to remove.
  const clarify = readFileSync(new URL('../mock2/clarify.js', import.meta.url), 'utf8');
  assert.match(clarify, /if \(!verdict\.clarify\) \{[\s\S]*recordFeature\([^)]*'clarifier', 'skipped'/,
    'the clarifier staying quiet must leave a row');
  assert.match(clarify, /recordFeature\([^)]*'clarifier', 'failed'/);
  assert.match(clarify, /recordFeature\([^)]*'clarifier', 'fired'/);

  const runner = readFileSync(new URL('../mock2/runner.js', import.meta.url), 'utf8');
  assert.match(runner, /'removal_claims',\s*\n?\s*verdict\.claims\.length \? 'fired' : 'skipped'/,
    'a build claiming no removal must still say so');
  assert.match(runner, /recordFeature\(projectId, 'removal_claims', 'failed'/);
});

test('RATCHET: the ledger is written where the build reports, and cannot break it', () => {
  const runner = readFileSync(new URL('../mock2/runner.js', import.meta.url), 'utf8');
  assert.match(runner, /const ledger = takeFeatureLedger\(project\.id\)/);
  assert.match(runner, /insertMessage\(\{ projectId, kind: 'system', cycleId: cycle\.id, body: ledger\.note \}\)/,
    'a note nobody can see is not instrumentation');
  const block = runner.slice(runner.indexOf('const ledger = takeFeatureLedger'));
  assert.match(block.slice(0, 400), /catch \(e\) \{ console\.warn\('\[mock2\] feature ledger failed/,
    'the ledger must never be able to fail a build');
});
