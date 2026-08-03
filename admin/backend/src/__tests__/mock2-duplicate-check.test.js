// "IS THIS ALREADY DONE?" pre-build check (run-taxonomy fix #6/D2). Pure logic
// tests for duplicate-check-logic.js — native-free (no DB, no model call). The
// build-time wiring (audit.js's duplicateCheckRefusal, listing recent
// successful change records) is native and exercised by the manual
// verification checklist, matching the codebase's stub-first convention (see
// mock2-symptom-cap.test.js for the same split).

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  findLikelyDuplicate, duplicateRefusalMessage,
  DUPLICATE_EXACT_THRESHOLD, DUPLICATE_FUZZY_THRESHOLD,
} from '../mock2/duplicate-check-logic.js';

// ---- findLikelyDuplicate ----

test('exact-after-normalisation instructions score as duplicates', () => {
  // Encapsoul 650/652 style: identical modulo whitespace.
  const dup = findLikelyDuplicate({
    instruction: '  Fix the CORS bug on   the upload endpoint  ',
    recentRecords: [{ cycleId: 650, seq: 12, summary: 'Fix the CORS bug on the upload endpoint', createdAt: '2026-01-01' }],
  });
  assert.ok(dup);
  assert.equal(dup.kind, 'exact');
  assert.equal(dup.match.cycleId, 650);
  assert.ok(dup.score >= DUPLICATE_EXACT_THRESHOLD);
});

test('a fuzzy re-request of shipped work scores above the fuzzy floor', () => {
  // Docs 740-vs-738 style: a re-request, reworded, of already-shipped work.
  const dup = findLikelyDuplicate({
    instruction: 're-run the folder export so nested subfolders keep their structure',
    recentRecords: [{ cycleId: 738, seq: 9, summary: 'reorganized the folder export — nested subfolders now keep their structure', createdAt: '2026-01-01' }],
  });
  assert.ok(dup);
  assert.equal(dup.kind, 'fuzzy');
  assert.ok(dup.score >= DUPLICATE_FUZZY_THRESHOLD && dup.score < DUPLICATE_EXACT_THRESHOLD);
});

test('two different instructions touching the same file do NOT match (precision guardrail)', () => {
  // Opposite requests that merely share a noun phrase. Calibration note: at a
  // naive 0.55 floor this pair scores 0.625 and WOULD have matched — the
  // threshold was raised to 0.70 specifically to exclude it (see
  // duplicate-check-logic.js's module comment for the measured scores).
  const dup = findLikelyDuplicate({
    instruction: 'add a cancel button to the profile page',
    recentRecords: [{ cycleId: 1, seq: 1, summary: "fix the cancel button's color on the profile page", createdAt: '2026-01-01' }],
  });
  assert.equal(dup, null);
});

test('same-tokens-different-target pairs also do NOT match', () => {
  const dup = findLikelyDuplicate({
    instruction: 'fix the login page CSS',
    recentRecords: [{ cycleId: 2, seq: 2, summary: 'fix the signup page CSS', createdAt: '2026-01-01' }],
  });
  assert.equal(dup, null);
});

test('the most recent match wins when multiple records score above the floor', () => {
  // recentRecords is caller-sorted most-recent-first. The FIRST record
  // (cycleId 900, a fuzzy 0.714 match) sits ahead of a later, higher-scoring
  // exact match (cycleId 800, 1.0) — recency wins over raw score.
  const dup = findLikelyDuplicate({
    instruction: 'add search by tag to the notes list',
    recentRecords: [
      { cycleId: 900, seq: 20, summary: 'search by tag added to the notes list', createdAt: '2026-02-01' },
      { cycleId: 800, seq: 10, summary: 'add search by tag to the notes list', createdAt: '2026-01-01' },
    ],
  });
  assert.ok(dup);
  assert.equal(dup.match.cycleId, 900);
  assert.equal(dup.kind, 'fuzzy');
});

test('findLikelyDuplicate returns null on an empty record list', () => {
  assert.equal(findLikelyDuplicate({ instruction: 'anything', recentRecords: [] }), null);
  assert.equal(findLikelyDuplicate({ instruction: 'anything' }), null);
});

test('findLikelyDuplicate returns null for an empty/missing instruction', () => {
  assert.equal(findLikelyDuplicate({ instruction: '', recentRecords: [{ cycleId: 1, summary: 'x' }] }), null);
  assert.equal(findLikelyDuplicate({ recentRecords: [{ cycleId: 1, summary: 'x' }] }), null);
});

test('the matcher fails open: malformed records never throw, yield no false match', () => {
  assert.doesNotThrow(() => findLikelyDuplicate({
    instruction: 'do something',
    recentRecords: [null, undefined, {}, { cycleId: 1, summary: null }, { cycleId: 2 }],
  }));
  assert.equal(findLikelyDuplicate({
    instruction: 'do something',
    recentRecords: [null, undefined, {}, { cycleId: 1, summary: null }, { cycleId: 2 }],
  }), null);
});

// ---- duplicateRefusalMessage ----

test('duplicateRefusalMessage names the specific prior cycle and offers the override', () => {
  const msg = duplicateRefusalMessage({
    kind: 'exact',
    match: { cycleId: 650, seq: 12, summary: 'Fix the CORS bug on the upload endpoint' },
  });
  assert.match(msg, /change record 12/);
  assert.match(msg, /Fix the CORS bug on the upload endpoint/);
  assert.match(msg, /If this is genuinely new work, send it again to build anyway\./);
});

test('duplicateRefusalMessage: fuzzy match uses softer "may already be covered" wording', () => {
  const msg = duplicateRefusalMessage({ kind: 'fuzzy', match: { seq: 3, summary: 'shipped it already' } });
  assert.match(msg, /may already be covered by/);
});

test('duplicateRefusalMessage: exact match uses "looks identical to" wording', () => {
  const msg = duplicateRefusalMessage({ kind: 'exact', match: { seq: 3, summary: 'shipped it already' } });
  assert.match(msg, /looks identical to/);
});
