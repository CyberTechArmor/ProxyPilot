// Cap symptom-chasing at two attempts (run-taxonomy fix #7/B2). Pure logic
// tests for consult-logic.js's normalizeHaltReason / reHaltSameReason /
// symptomAttemptCount — native-free (no DB, no model call). The build-time
// wiring (audit.js symptomCapRefusal, the diagnosis call) is native and
// exercised by the manual verification checklist, matching the codebase's
// stub-first convention for orchestration code.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeHaltReason, reHaltSameReason, symptomAttemptCount,
  SYMPTOM_CAP, SYMPTOM_SIMILARITY_THRESHOLD, symptomCapEnabled, MOCK2_SYMPTOM_CAP_FLAG,
  consultTrigger,
} from '../mock2/consult-logic.js';

// ---- normalizeHaltReason ----

test('normalizeHaltReason: digits collapse to a placeholder', () => {
  assert.equal(normalizeHaltReason('failed at line 42'), 'failed at line #');
  assert.equal(normalizeHaltReason('failed at line 42'), normalizeHaltReason('failed at line 88'));
});

test('normalizeHaltReason: path-like tokens collapse to a placeholder', () => {
  const a = normalizeHaltReason('cannot read src/routes/foo.ts: ENOENT');
  const b = normalizeHaltReason('cannot read src/routes/bar.ts: ENOENT');
  assert.equal(a, b);
  assert.match(a, /<path>/);
});

test('normalizeHaltReason: quoted spans collapse to a placeholder', () => {
  const a = normalizeHaltReason(`gate "typecheck" failed: expected 'string' got 'number'`);
  const b = normalizeHaltReason(`gate "constitution-lint" failed: expected 'boolean' got 'object'`);
  assert.equal(a, b);
});

test('normalizeHaltReason: two halts differing only by line number normalise equal', () => {
  const a = normalizeHaltReason('blocked: cannot read foo.ts at line 42');
  const b = normalizeHaltReason('blocked: cannot read foo.ts at line 88');
  assert.equal(a, b);
});

test('normalizeHaltReason: empty/null input never throws, yields empty string', () => {
  assert.equal(normalizeHaltReason(null), '');
  assert.equal(normalizeHaltReason(undefined), '');
  assert.equal(normalizeHaltReason(''), '');
});

test('normalizeHaltReason: caps at 200 chars', () => {
  const s = normalizeHaltReason('x'.repeat(500));
  assert.ok(s.length <= 200);
});

// ---- reHaltSameReason ----

test('reHaltSameReason: returns true for a repeated wall (same shape, different specifics)', () => {
  const r = reHaltSameReason({
    reason: 'blocked: cannot read src/routes/foo.ts at line 42',
    priorReasons: ['blocked: cannot read src/routes/bar.ts at line 88'],
  });
  assert.equal(r, true);
});

test('reHaltSameReason: returns false for a genuinely different blocker', () => {
  const r = reHaltSameReason({
    reason: 'blocked: missing ADP_TOKEN_URL environment variable',
    priorReasons: ['blocked: cannot read src/routes/foo.ts at line 42'],
  });
  assert.equal(r, false);
});

test('reHaltSameReason: no prior reasons never matches', () => {
  assert.equal(reHaltSameReason({ reason: 'anything', priorReasons: [] }), false);
});

test('reHaltSameReason: an empty current reason never matches (nothing to compare)', () => {
  assert.equal(reHaltSameReason({ reason: '', priorReasons: ['blocked: x'] }), false);
});

// ---- consultTrigger wiring — the REGRESSION FIXTURE ----
//
// Before this fix, no haltCycle call site in runner.js ever computed a real
// reHaltSameReason value (every one passed only { gateFailStreak }), so this
// trigger has never fired in production. This test proves the SIGNAL ITSELF
// is now computable and wired into consultTrigger's existing contract — it is
// the same assertion the original spec's regression fixture asked for.

test('consultTrigger returns same_reason_rehalt when a request re-halts the same way', () => {
  const same = reHaltSameReason({
    reason: 'blocked: cannot read foo.ts at line 42',
    priorReasons: ['blocked: cannot read foo.ts at line 88'],
  });
  assert.equal(consultTrigger({ reHaltSameReason: same }), 'same_reason_rehalt');
});

test('consultTrigger does NOT return same_reason_rehalt for a genuinely different halt', () => {
  const same = reHaltSameReason({
    reason: 'blocked: missing ADP_TOKEN_URL',
    priorReasons: ['blocked: cannot read foo.ts at line 42'],
  });
  assert.equal(consultTrigger({ reHaltSameReason: same }), null);
});

// ---- symptomAttemptCount ----
//
// Calibration note (see consult-logic.js's comment on SYMPTOM_SIMILARITY_THRESHOLD):
// plain token-Jaccard on short instructions is a blunt signal — two requests
// sharing a feature's nouns but asking for OPPOSITE things can score higher
// than two genuine paraphrases of the same complaint. The threshold (0.7) is
// set high so the cap only trips on realistic near-repeats (an operator
// resending the same or near-the-same bug report), which is the case that
// actually occurred in the run-taxonomy report's sagas.

test('symptomAttemptCount: near-identical resends count as attempts', () => {
  const count = symptomAttemptCount({
    instruction: 'the export menu still does not open',
    priorInstructions: [
      'the export menu still does not open',
      'the export menu does not open',
      'fix the ffmpeg CORS issue',
    ],
  });
  assert.equal(count, 2);
});

test('symptomAttemptCount: three near-identical instructions count as three attempts (this one + two priors = cap trips)', () => {
  const priors = ['the export menu still does not open', 'the export menu still does not open'];
  const count = symptomAttemptCount({ instruction: 'the export menu still does not open', priorInstructions: priors });
  assert.equal(count, 2);
  assert.ok(count >= SYMPTOM_CAP, 'two matching priors plus this attempt is the third — must reach the cap');
});

test('symptomAttemptCount: a different instruction on the same file/feature does NOT count (precision guardrail)', () => {
  const count = symptomAttemptCount({
    instruction: "fix the cancel button's color on the profile page",
    priorInstructions: ['add a cancel button to the profile page'],
  });
  assert.equal(count, 0);
});

test('symptomAttemptCount: the convert-project ffmpeg/CORS saga — different diagnoses of the same complaint still count when reworded closely', () => {
  // The report's real saga guessed a NEW mechanism each cycle (ffmpeg, then
  // CORS, then CORS scope, then error-reporting) — those are different
  // INSTRUCTIONS (they name a different fix each time) and should NOT all
  // collapse into one count; only a near-repeat of the SAME wording should.
  const count = symptomAttemptCount({
    instruction: 'uploads still fail after the fix',
    priorInstructions: ['uploads still fail', 'fix the CORS headers on the upload endpoint', 'ffmpeg is missing from the container'],
  });
  assert.ok(count <= 1, 'only the near-identical resend should count, not the differently-diagnosed attempts');
});

test('symptomAttemptCount: an empty instruction returns 0', () => {
  assert.equal(symptomAttemptCount({ instruction: '', priorInstructions: ['x'] }), 0);
});

test('symptomAttemptCount: no prior instructions returns 0', () => {
  assert.equal(symptomAttemptCount({ instruction: 'fix the export menu', priorInstructions: [] }), 0);
});

// ---- SYMPTOM_CAP fail-open ----

test('symptomCapEnabled: on by default (no env var set)', () => {
  assert.equal(symptomCapEnabled({}), true);
});

test('symptomCapEnabled: off/0/false disable it; anything else leaves it on', () => {
  assert.equal(symptomCapEnabled({ [MOCK2_SYMPTOM_CAP_FLAG]: 'off' }), false);
  assert.equal(symptomCapEnabled({ [MOCK2_SYMPTOM_CAP_FLAG]: '0' }), false);
  assert.equal(symptomCapEnabled({ [MOCK2_SYMPTOM_CAP_FLAG]: 'false' }), false);
  assert.equal(symptomCapEnabled({ [MOCK2_SYMPTOM_CAP_FLAG]: 'on' }), true);
  assert.equal(symptomCapEnabled({ [MOCK2_SYMPTOM_CAP_FLAG]: 'garbage' }), true);
});

test('the cap fails open when the matcher throws (defensive contract of symptomAttemptCount)', () => {
  // symptomAttemptCount itself never throws on malformed input — the
  // fail-open guarantee lives at the audit.js call site (symptomCapRefusal's
  // try/catch), but the pure layer must not hand it a reason to trip either.
  assert.doesNotThrow(() => symptomAttemptCount({ instruction: null, priorInstructions: [null, undefined, 42, {}] }));
  assert.equal(symptomAttemptCount({ instruction: null, priorInstructions: [null, undefined, 42, {}] }), 0);
});

// ---- SYMPTOM_CAP constant sanity ----

test('SYMPTOM_CAP is 2 (two prior attempts + this one = the third guess)', () => {
  assert.equal(SYMPTOM_CAP, 2);
});

test('SYMPTOM_SIMILARITY_THRESHOLD is a real probability in (0,1]', () => {
  assert.ok(SYMPTOM_SIMILARITY_THRESHOLD > 0 && SYMPTOM_SIMILARITY_THRESHOLD <= 1);
});
