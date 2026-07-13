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
