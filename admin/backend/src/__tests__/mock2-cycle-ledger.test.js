// Ledger completeness (concludeCycle, run-taxonomy fix #8/A1) — pure logic
// tests plus a source-level regression guard, covering BOTH build harnesses
// (runner.js and its SDK-variant twin runner-sdk.js).
//
// Stub-first (risk R9): the pure half (conclude-logic.js) imports nothing
// native. The source-level guards read the runner files as TEXT — concludeCycle
// itself touches containers and the DB and cannot be exercised in the
// sandbox, but WHICH terminal paths call it (versus a bare finishCycle) is
// exactly the property that regresses silently, so it is checked here the
// same way mock2-project-assets.test.js checks recordAssetsSeen's call sites.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { terminalSummary, terminalRecordPlan } from '../mock2/conclude-logic.js';

// ---- terminalRecordPlan / terminalSummary (pure) ----

test('terminalRecordPlan: container + holder → checkpoint strategy', () => {
  const plan = terminalRecordPlan({ containerName: 'c1', holder: { type: 'cycle', id: 1 }, status: 'failed' });
  assert.equal(plan.strategy, 'checkpoint');
});

test('terminalRecordPlan: no container → minimal strategy', () => {
  const plan = terminalRecordPlan({ containerName: null, holder: { type: 'cycle', id: 1 }, status: 'failed' });
  assert.equal(plan.strategy, 'minimal');
});

test('terminalRecordPlan: holder missing → minimal strategy even with a container', () => {
  const plan = terminalRecordPlan({ containerName: 'c1', holder: null, status: 'failed' });
  assert.equal(plan.strategy, 'minimal');
});

test('terminalSummary: caller summary wins', () => {
  const s = terminalSummary({ summary: 'checkpoint: custom', status: 'failed', error: 'boom' });
  assert.equal(s, 'checkpoint: custom');
});

test('terminalSummary: falls back to "status: error"', () => {
  const s = terminalSummary({ status: 'failed', error: 'could not acquire lock' });
  assert.equal(s, 'failed: could not acquire lock');
});

test('terminalSummary: falls back to "status: no detail" with no error', () => {
  const s = terminalSummary({ status: 'succeeded' });
  assert.equal(s, 'succeeded: no detail');
});

test('terminalSummary: caps at 500 characters', () => {
  const s = terminalSummary({ status: 'failed', error: 'x'.repeat(600) });
  assert.ok(s.length <= 500, `expected <= 500 chars, got ${s.length}`);
  assert.match(s, /…$/);
});

test('terminalSummary: an empty/whitespace summary is treated as absent', () => {
  const s = terminalSummary({ summary: '   ', status: 'failed', error: 'boom' });
  assert.equal(s, 'failed: boom');
});

// ---- source-level regression guard: every terminal path records ----
//
// Before this fix, 12 of 22 finishCycle(...) call sites in runner.js wrote a
// cycle-status flip and NO change record — the "unlogged cycle IDs" in the
// run-taxonomy report. This test enumerates every legitimate bare finishCycle
// call site left after the fix (concludeCycle's own internal call, plus the
// paths that already checkpointed via checkpointAndRecord before this branch
// and remain untouched) and asserts no OTHER bare call exists. A new bare
// finishCycle call added anywhere else fails this test.

// Every bare (not-through-concludeCycle) finishCycle(...) call left in
// runner.js, verbatim. Each one is a path that already wrote its change record
// via checkpointAndRecord earlier in the same branch (the finish-budget,
// interrupt/pause, deploy/smoke/pending/succeeded and max-turns terminals),
// PLUS concludeCycle's own internal call. If a future edit adds a new
// terminal that calls finishCycle directly instead of concludeCycle, its line
// will not be in this set and the test fails — that is the whole point.
const KNOWN_BARE_FINISH_CYCLE_LINES = [
  "finishCycle(cycle.id, { status: 'awaiting_user', error: null });", // concludeFinishBudget — already checkpointed at the budget-exhausted checkpoint
  "finishCycle(cycle.id, { status: 'interrupted', error: 'budget buffer crossed mid-cycle — checkpointed and stopped' });",
  "finishCycle(cycle.id, { status: 'interrupted', error: handoffQueued ? `Paused — ${detail}. The continuation is queued and starts on its own.` : `Paused — ${detail}. Resume to continue where it stopped.` });",
  "finishCycle(cycle.id, { status: 'failed', error: deployed.error });", // post-acceptance deploy failure — already checkpointed at the acceptance checkpoint
  "finishCycle(cycle.id, { status: 'failed', error });", // smoke failure — same shared checkpoint
  "finishCycle(cycle.id, { status: 'awaiting_user', error: null });", // pending-verification terminal — same shared checkpoint (line text intentionally duplicated: it's a distinct occurrence)
  "finishCycle(cycle.id, { status: 'succeeded' });", // plain success — same shared checkpoint
  'finishCycle(cycle.id, { status: \'interrupted\', error: `Paused — reached ${MAX_TURNS} steps without finishing. Resume to continue where it stopped.` });',
  'finishCycle(cycle.id, { status, error });', // concludeCycle's own implementation
  "finishCycle(cycle.id, { status: 'awaiting_admin', error: reason });", // haltCycle — already checkpointed via checkpointAndRecord above it
];

test('runner.js: every finishCycle(...) call is one of the known already-recording paths', async () => {
  const src = await readFile(new URL('../mock2/runner.js', import.meta.url), 'utf8');
  const actualLines = src.split('\n')
    .map((l) => l.trim())
    .filter((l) => l.includes('finishCycle('));

  const expected = [...KNOWN_BARE_FINISH_CYCLE_LINES].sort();
  const actual = [...actualLines].sort();
  assert.deepEqual(
    actual, expected,
    'runner.js has a finishCycle(...) call that is not one of the known, already-recording paths — every new terminal must go through concludeCycle',
  );
});

test('runner.js: every previously-unrecorded gap site now calls concludeCycle', async () => {
  const src = await readFile(new URL('../mock2/runner.js', import.meta.url), 'utf8');
  // Distinctive error strings from each of the 12 original gap sites — assert
  // each is now paired with concludeCycle rather than a bare finishCycle.
  const gapMarkers = [
    'could not acquire checkout lock',
    'runner crashed:',
    'deploy retry crashed:',
    'accept-pending deploy failed:',
    'accept-pending crashed:',
    'could not copy gates into container:',
    'retries exhausted: ${reason}',
  ];
  for (const marker of gapMarkers) {
    const idx = src.indexOf(marker);
    assert.ok(idx !== -1, `expected to find marker "${marker}" in runner.js`);
    const around = src.slice(Math.max(0, idx - 300), idx + 100);
    assert.match(around, /concludeCycle\(/, `expected concludeCycle near "${marker}"`);
  }
});

// ---- runner-sdk.js: the SDK harness has the identical gap ----
//
// runner-sdk.js is a parallel implementation of the same terminal-path
// pattern (its own doc comment: "produces the SAME commit, the SAME change
// record" as the hand-rolled path) — so it carries the exact same class of
// gap. Fixed the same way: every terminal path goes through concludeCycle
// unless it already checkpointed earlier in the same branch.

const KNOWN_BARE_FINISH_CYCLE_LINES_SDK = [
  "finishCycle(cycle.id, { status: 'interrupted', error: 'budget buffer crossed mid-cycle — checkpointed and stopped' });", // already checkpointed just above
  'finishCycle(cycle.id, { status: \'interrupted\', error: `Paused — ${detail}. Resume to continue where it stopped.` });', // already checkpointed just above
  'finishCycle(cycle.id, { status: \'interrupted\', error: `Paused — gates still red after ${SDK_MAX_GATE_ROUNDS} SDK rounds. Resume to continue.` });', // already checkpointed just above
  "finishCycle(cycle.id, { status: 'failed', error: deployed.error });", // deploy failure — already checkpointed at the shared post-gate checkpoint
  'finishCycle(cycle.id, { status: \'failed\', error: `Smoke gate failed after deploy — ${detail}` });', // same shared checkpoint
  "finishCycle(cycle.id, { status: 'awaiting_user', error: null });", // pending-verification terminal — same shared checkpoint
  "finishCycle(cycle.id, { status: 'succeeded' });", // plain success — same shared checkpoint
];

test('runner-sdk.js: every finishCycle(...) call is one of the known already-recording paths', async () => {
  const src = await readFile(new URL('../mock2/runner-sdk.js', import.meta.url), 'utf8');
  const actualLines = src.split('\n')
    .map((l) => l.trim())
    .filter((l) => l.includes('finishCycle('));

  const expected = [...KNOWN_BARE_FINISH_CYCLE_LINES_SDK].sort();
  const actual = [...actualLines].sort();
  assert.deepEqual(
    actual, expected,
    'runner-sdk.js has a finishCycle(...) call that is not one of the known, already-recording paths — every new terminal must go through concludeCycle',
  );
});

test('runner-sdk.js: every previously-unrecorded gap site now calls concludeCycle', async () => {
  const src = await readFile(new URL('../mock2/runner-sdk.js', import.meta.url), 'utf8');
  const gapMarkers = [
    'The Claude harness has no Anthropic API key',
    'is not installed:',
    'could not copy gates into container:',
    'could not sync the project out of the container:',
    "could not sync the SDK's changes back into the container:",
  ];
  for (const marker of gapMarkers) {
    const idx = src.indexOf(marker);
    assert.ok(idx !== -1, `expected to find marker "${marker}" in runner-sdk.js`);
    const around = src.slice(Math.max(0, idx - 300), idx + 100);
    assert.match(around, /concludeCycle\(/, `expected concludeCycle near "${marker}"`);
  }
});

test('runner-sdk.js: the ir.checkpointFirst conditional gap is closed (parity with runner.js)', async () => {
  const src = await readFile(new URL('../mock2/runner-sdk.js', import.meta.url), 'utf8');
  // The old pattern — a bare `if (ir.checkpointFirst) await checkpointAndRecord(...)`
  // immediately followed by an unconditional finishCycle — must be gone.
  assert.doesNotMatch(src, /if \(ir\.checkpointFirst\) await checkpointAndRecord/);
  assert.match(src, /containerName: ir\.checkpointFirst \? containerName : null/);
});
