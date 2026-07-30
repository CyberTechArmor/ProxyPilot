// The stall watchdog's decision layer (operator report: an API hiccup killed a
// build mid-flight and the platform sat on "Building now:" with nothing to
// click):
//   A. buildStallVerdict — only a RUNNING cycle can stall; liveness is the
//      newest of started_at / the last event; missing timestamps never kill;
//   B. stallThresholdMinutes — env-tunable, floored so a typo can't turn the
//      watchdog into a build killer;
//   C. modelIdleTimeoutMs — the model-client stream idle watchdog config
//      (default 5 min, "off"/"0" disables, floored at 30s).
// Pure-layer only (native-free, stub-first — risk R9).

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildStallVerdict, stallThresholdMinutes, DEFAULT_STALL_MINUTES,
} from '../mock2/cycle-logic.js';
import { modelIdleTimeoutMs, isTransientModelError } from '../mock2/model-client.js';

const T0 = Date.parse('2026-07-30T12:00:00.000Z');
const minsAgo = (m) => new Date(T0 - m * 60000).toISOString();

// ---- A. buildStallVerdict ----

test('a running cycle silent past the threshold is stalled', () => {
  const v = buildStallVerdict({ nowMs: T0, status: 'running', startedAt: minsAgo(30), lastEventAt: minsAgo(12), thresholdMinutes: 10 });
  assert.equal(v.stalled, true);
  assert.equal(v.idleMs, 12 * 60000);
});

test('recent event activity means not stalled, whatever started_at says', () => {
  const v = buildStallVerdict({ nowMs: T0, status: 'running', startedAt: minsAgo(45), lastEventAt: minsAgo(1), thresholdMinutes: 10 });
  assert.equal(v.stalled, false);
  assert.equal(v.idleMs, 60000);
});

test('a cycle with no events yet is judged from its start', () => {
  assert.equal(buildStallVerdict({ nowMs: T0, status: 'running', startedAt: minsAgo(3), lastEventAt: null, thresholdMinutes: 10 }).stalled, false);
  assert.equal(buildStallVerdict({ nowMs: T0, status: 'running', startedAt: minsAgo(11), lastEventAt: null, thresholdMinutes: 10 }).stalled, true);
});

test('the NEWEST of start/event wins (clock skew cannot fake a stall)', () => {
  // Event older than the (re)start — liveness comes from the start.
  const v = buildStallVerdict({ nowMs: T0, status: 'running', startedAt: minsAgo(2), lastEventAt: minsAgo(20), thresholdMinutes: 10 });
  assert.equal(v.stalled, false);
});

test('only a running cycle can stall', () => {
  for (const status of ['queued', 'estimating', 'awaiting_user', 'awaiting_admin', 'succeeded', 'failed', 'interrupted']) {
    const v = buildStallVerdict({ nowMs: T0, status, startedAt: minsAgo(60), lastEventAt: minsAgo(60), thresholdMinutes: 10 });
    assert.equal(v.stalled, false, status);
  }
});

test('missing/unparseable timestamps never produce a kill verdict', () => {
  assert.equal(buildStallVerdict({ nowMs: T0, status: 'running', startedAt: null, lastEventAt: null }).stalled, false);
  assert.equal(buildStallVerdict({ nowMs: T0, status: 'running', startedAt: 'not-a-date', lastEventAt: '' }).stalled, false);
});

test('threshold default applies when not passed', () => {
  const v = buildStallVerdict({ nowMs: T0, status: 'running', startedAt: minsAgo(DEFAULT_STALL_MINUTES + 1), lastEventAt: null });
  assert.equal(v.stalled, true);
});

// ---- B. stallThresholdMinutes ----

test('stall threshold: default, override, floor, garbage', () => {
  assert.equal(stallThresholdMinutes({}), DEFAULT_STALL_MINUTES);
  assert.equal(stallThresholdMinutes({ MOCK2_STALL_MINUTES: '20' }), 20);
  assert.equal(stallThresholdMinutes({ MOCK2_STALL_MINUTES: '1' }), 2); // floored — never hair-trigger
  assert.equal(stallThresholdMinutes({ MOCK2_STALL_MINUTES: 'soon' }), DEFAULT_STALL_MINUTES);
  assert.equal(stallThresholdMinutes({ MOCK2_STALL_MINUTES: '-5' }), DEFAULT_STALL_MINUTES);
});

// ---- C. modelIdleTimeoutMs ----

test('model idle timeout: default 5 min, off/0 disable, floor 30s', () => {
  assert.equal(modelIdleTimeoutMs({}), 300000);
  assert.equal(modelIdleTimeoutMs({ MOCK2_MODEL_IDLE_TIMEOUT_MS: '600000' }), 600000);
  assert.equal(modelIdleTimeoutMs({ MOCK2_MODEL_IDLE_TIMEOUT_MS: 'off' }), 0);
  assert.equal(modelIdleTimeoutMs({ MOCK2_MODEL_IDLE_TIMEOUT_MS: '0' }), 0);
  assert.equal(modelIdleTimeoutMs({ MOCK2_MODEL_IDLE_TIMEOUT_MS: '5' }), 30000); // floored
  assert.equal(modelIdleTimeoutMs({ MOCK2_MODEL_IDLE_TIMEOUT_MS: 'garbage' }), 300000);
});

// A stall is surfaced as a TIMEOUT (the caller owns recovery), and the
// transient classifier must not treat it as blind-retryable.
test('a stall message is not classified as a transient (auto-retry) error', () => {
  assert.equal(isTransientModelError('model call failed: the response stream went silent for 300s (the connection likely dropped mid-response) — the request was cancelled server-side'), false);
});
