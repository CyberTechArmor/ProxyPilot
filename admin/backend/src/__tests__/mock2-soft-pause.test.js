// Pure soft-pause decision: a build cycle checkpoints and PAUSES (resumable)
// once this run crosses a token or wall-clock budget, instead of failing on a
// turn count. These thresholds gate real spend/time, so pin them.

import test from 'node:test';
import assert from 'node:assert/strict';
import { softPauseReason, SOFT_PAUSE_TOKENS, SOFT_PAUSE_MS } from '../mock2/runner-logic.js';

test('softPauseReason: under both budgets → keep going (null)', () => {
  assert.equal(softPauseReason({ usedTokens: 0, elapsedMs: 0 }), null);
  assert.equal(softPauseReason({ usedTokens: SOFT_PAUSE_TOKENS - 1, elapsedMs: SOFT_PAUSE_MS - 1 }), null);
});

test('softPauseReason: crossing the token budget pauses on tokens', () => {
  assert.equal(softPauseReason({ usedTokens: SOFT_PAUSE_TOKENS, elapsedMs: 0 }), 'budget_tokens');
  assert.equal(softPauseReason({ usedTokens: SOFT_PAUSE_TOKENS + 5000, elapsedMs: 0 }), 'budget_tokens');
});

test('softPauseReason: crossing the time budget pauses on time', () => {
  assert.equal(softPauseReason({ usedTokens: 10, elapsedMs: SOFT_PAUSE_MS }), 'budget_time');
  assert.equal(softPauseReason({ usedTokens: 10, elapsedMs: SOFT_PAUSE_MS + 1 }), 'budget_time');
});

test('softPauseReason: tokens take precedence when both are crossed', () => {
  assert.equal(softPauseReason({ usedTokens: SOFT_PAUSE_TOKENS, elapsedMs: SOFT_PAUSE_MS }), 'budget_tokens');
});

test('softPauseReason: custom limits are honored (testable thresholds)', () => {
  assert.equal(softPauseReason({ usedTokens: 100, elapsedMs: 0, tokenLimit: 100 }), 'budget_tokens');
  assert.equal(softPauseReason({ usedTokens: 0, elapsedMs: 100, timeLimitMs: 100 }), 'budget_time');
  assert.equal(softPauseReason({ usedTokens: 99, elapsedMs: 99, tokenLimit: 100, timeLimitMs: 100 }), null);
});

test('soft-pause budgets are generous (guard against accidental drift)', () => {
  assert.equal(SOFT_PAUSE_TOKENS, 1_000_000);
  assert.equal(SOFT_PAUSE_MS, 45 * 60 * 1000);
});

test('context sweet spot: checked first, and the continuation chain round-trips', async () => {
  const {
    softPauseReason, CONTEXT_HANDOFF_TOKENS, CONTEXT_HANDOFF_MAX_CHAIN,
    continuationRun, stripContinuationSection, buildContinuationInstruction,
  } = await import('../mock2/runner-logic.js');
  // Live context past the line → handoff, even when spend budgets are fine.
  assert.equal(softPauseReason({ contextTokens: CONTEXT_HANDOFF_TOKENS, usedTokens: 0, elapsedMs: 0 }), 'context_handoff');
  assert.equal(softPauseReason({ contextTokens: CONTEXT_HANDOFF_TOKENS - 1, usedTokens: 0, elapsedMs: 0 }), null);
  // Context outranks the token budget — the handoff loop is the productive outcome.
  assert.equal(softPauseReason({ contextTokens: CONTEXT_HANDOFF_TOKENS, usedTokens: 10_000_000, elapsedMs: 0 }), 'context_handoff');

  // The chain: original → run 1 → run 2; each rebuild starts from the ORIGINAL.
  const original = 'Build the reporting module end to end';
  assert.equal(continuationRun(original), 0);
  const run1 = buildContinuationInstruction({ original, handoff: 'DONE: schema. NEXT STEPS: routes, UI.', run: 1 });
  assert.equal(continuationRun(run1), 1);
  assert.equal(stripContinuationSection(run1), original);
  const run2 = buildContinuationInstruction({ original: run1, handoff: 'DONE: routes. NEXT STEPS: UI.', run: 2 });
  assert.equal(continuationRun(run2), 2);
  // Never nests: run 2 carries the original once and only the newest handoff.
  assert.equal((run2.match(/CONTINUATION \(auto-handoff/g) || []).length, 1);
  assert.match(run2, /DONE: routes/);
  assert.ok(!run2.includes('DONE: schema'));
  assert.ok(Number.isFinite(CONTEXT_HANDOFF_MAX_CHAIN) && CONTEXT_HANDOFF_MAX_CHAIN >= 1);
});
