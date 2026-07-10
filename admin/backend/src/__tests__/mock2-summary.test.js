// Mock2 Phase M9 tests — the adaptive-summary pure decision layer (the versioned,
// diffable summary regenerated on qualifying cycles from change records + rules.md
// only; 03-data-model.md mock2_summaries).
//
// Stub-first (risk R9): imports ONLY summary-logic.js (native-free). The
// deterministic TRIGGER (a qualifying cycle regenerates; a pure-chat/no-op does
// not; the same qualifying change never triggers twice), the version bump, the
// change-record digest, the identical-body guard, and the clean diff are all
// exercised here — the verify checklist's "regenerates ONLY on qualifying cycles
// and diffs cleanly".

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isQualifyingRecord, changeSeqHighWater, latestQualifyingSeq, summaryTrigger,
  nextSummaryVersion, buildSummarySystemPrompt, buildSummaryTask, summarizeChangeRecords,
  normalizeSummaryBody, summaryBodyChanged, diffSummaries,
  publicSummaryShape, estimateSummaryTokens,
} from '../mock2/summary-logic.js';

// ---- qualifying-change predicate ----

test('isQualifyingRecord: rules.md touched qualifies', () => {
  assert.equal(isQualifyingRecord({ seq: 1, rules_touched: '["rule-q3"]' }), true);
  assert.equal(isQualifyingRecord({ seq: 1, rules_touched: ['rule-q3'] }), true);
});

test('isQualifyingRecord: a build checkpoint (gates_run) qualifies — screens±actions moved', () => {
  assert.equal(isQualifyingRecord({ seq: 2, gates_run: '[{"name":"test","result":"passed"}]' }), true);
  assert.equal(isQualifyingRecord({ seq: 2, gates_run: [{ name: 'test', result: 'passed' }] }), true);
});

test('isQualifyingRecord: a design approval (inventory) qualifies via its summary', () => {
  assert.equal(isQualifyingRecord({ seq: 1, summary: 'Design approved — inventory extracted (3 screens)' }), true);
});

test('isQualifyingRecord: a pure/no-op record does NOT qualify', () => {
  assert.equal(isQualifyingRecord({ seq: 5, rules_touched: null, gates_run: null, summary: 'checkpoint: auto-release' }), false);
  assert.equal(isQualifyingRecord({ seq: 5, rules_touched: '[]', gates_run: '[]', summary: 'note' }), false);
  assert.equal(isQualifyingRecord(null), false);
});

// ---- high-water marks ----

test('changeSeqHighWater / latestQualifyingSeq', () => {
  const records = [
    { seq: 1, summary: 'Design approved — inventory extracted' }, // qualifying
    { seq: 2, summary: 'checkpoint: auto-release' },              // not
    { seq: 3, gates_run: '[{"name":"test","result":"passed"}]' }, // qualifying
    { seq: 4, summary: 'checkpoint: note' },                      // not
  ];
  assert.equal(changeSeqHighWater(records), 4);
  assert.equal(latestQualifyingSeq(records), 3);
  assert.equal(changeSeqHighWater([]), 0);
  assert.equal(latestQualifyingSeq([]), null);
});

// ---- the deterministic trigger (regenerate ONLY on qualifying cycles) ----

test('summaryTrigger: regenerates on the first qualifying change', () => {
  const records = [{ seq: 1, summary: 'Design approved — inventory' }];
  const t = summaryTrigger(records, null);
  assert.equal(t.shouldRegen, true);
  assert.equal(t.derivedFromSeq, 1);
  assert.equal(t.qualifyingSeq, 1);
});

test('summaryTrigger: does NOT regenerate when only non-qualifying churn arrived', () => {
  const last = { version: 1, derived_from_change_seq: 3 };
  const records = [
    { seq: 1, summary: 'Design approved — inventory' },
    { seq: 2, gates_run: '[{"name":"test","result":"passed"}]' },
    { seq: 3, summary: 'checkpoint: budget buffer crossed' }, // non-qualifying, was the high-water at gen
    { seq: 4, summary: 'checkpoint: auto-release' },          // non-qualifying churn since
    { seq: 5, summary: 'checkpoint: max turns reached' },     // non-qualifying churn since
  ];
  const t = summaryTrigger(records, last);
  assert.equal(t.qualifyingSeq, 2);       // last qualifying is still seq 2
  assert.equal(t.shouldRegen, false);     // 2 is not beyond the last summary's high-water (3)
});

test('summaryTrigger: regenerates again when a NEW qualifying change lands', () => {
  const last = { version: 1, derived_from_change_seq: 3 };
  const records = [
    { seq: 1, summary: 'Design approved — inventory' },
    { seq: 2, gates_run: '["x"]' },
    { seq: 3, summary: 'checkpoint: note' },
    { seq: 4, rules_touched: '["rule-q9"]' }, // NEW qualifying change beyond 3
  ];
  const t = summaryTrigger(records, last);
  assert.equal(t.qualifyingSeq, 4);
  assert.equal(t.derivedFromSeq, 4);
  assert.equal(t.shouldRegen, true);
});

test('summaryTrigger: no records at all never regenerates', () => {
  assert.equal(summaryTrigger([], null).shouldRegen, false);
});

// ---- version bump ----

test('nextSummaryVersion: monotonic from the last row', () => {
  assert.equal(nextSummaryVersion(null), 1);
  assert.equal(nextSummaryVersion({ version: 1 }), 2);
  assert.equal(nextSummaryVersion({ version: 7 }), 8);
});

// ---- the prompt/task read change records + rules.md ONLY (never chat) ----

test('buildSummaryTask: carries rules + change history, mentions no chat', () => {
  const t = buildSummaryTask({
    rulesMd: '## Rule\nSchedulers see only their own practice.',
    records: [{ seq: 1, summary: 'Design approved' }, { seq: 2, summary: 'Add roster export' }],
    projectName: 'ShiftSwap',
  });
  assert.match(t, /Schedulers see only their own practice/);
  assert.match(t, /#1 — Design approved/);
  assert.match(t, /#2 — Add roster export/);
});

test('buildSummarySystemPrompt: instructs "work only from confirmed rules and recorded changes" (not chat)', () => {
  const p = buildSummarySystemPrompt({ projectName: 'ShiftSwap' });
  assert.match(p, /ShiftSwap/);
  assert.match(p, /NOT given the chat|not.*chat/i);
  assert.match(p, /rules|changes/i);
});

test('summarizeChangeRecords: oldest-first, capped, human fields only', () => {
  const digest = summarizeChangeRecords([{ seq: 2, summary: 'b' }, { seq: 1, summary: 'a' }]);
  assert.equal(digest, '#1 — a\n#2 — b');
});

// ---- identical-body guard + clean diff ----

test('summaryBodyChanged: cosmetic-only differences are treated as unchanged', () => {
  assert.equal(summaryBodyChanged('Hello\n\n\nWorld  ', 'Hello\n\nWorld'), false);
  assert.equal(summaryBodyChanged('Hello', 'Hello world'), true);
});

test('normalizeSummaryBody: trims, collapses blank runs, strips trailing space', () => {
  assert.equal(normalizeSummaryBody('  a  \n\n\n b \n'), 'a\n\n b');
});

test('diffSummaries: reports added + removed lines cleanly', () => {
  const prev = '# ShiftSwap\nSchedulers see their own practice.';
  const next = '# ShiftSwap\nSchedulers see all practices.\nRoster export added.';
  const d = diffSummaries(prev, next);
  assert.ok(d.changed);
  assert.deepEqual(d.removed, ['Schedulers see their own practice.']);
  assert.deepEqual(d.added, ['Schedulers see all practices.', 'Roster export added.']);
});

test('diffSummaries: identical bodies diff to nothing', () => {
  const d = diffSummaries('same\nlines', 'same\nlines');
  assert.equal(d.changed, false);
  assert.deepEqual(d.added, []);
  assert.deepEqual(d.removed, []);
});

// ---- shapes + envelope ----

test('publicSummaryShape: client-safe view', () => {
  const s = publicSummaryShape({ id: 1, project_id: 5, version: 2, body_md: '# X', derived_from_change_seq: 7, created_at: 't' });
  assert.deepEqual(s, { id: 1, project_id: 5, version: 2, body_md: '# X', derived_from_change_seq: 7, created_at: 't' });
  assert.equal(publicSummaryShape(null), null);
});

test('estimateSummaryTokens: a credible envelope', () => {
  const e = estimateSummaryTokens();
  assert.ok(e.inputTokens > 0 && e.outputTokens > 0);
});
