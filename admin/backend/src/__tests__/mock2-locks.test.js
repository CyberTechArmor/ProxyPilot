// Mock2 Phase M6 tests — the checkout-lock pure decision layer (ADR-004).
//
// Stub-first (risk R9): imports ONLY lock-logic.js (native-free). The lock guards
// the container; getting acquire/expiry/warn right is safety-critical, so it is
// unit-tested here without better-sqlite3.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  lockHolder, msSinceWrite, timeRemainingMs, isLockExpired, inWarnWindow,
  resolveIdleMinutes, mayAcquire, shouldAutoRelease, publicLockShape,
  DEFAULT_LOCK_IDLE_MINUTES, LOCK_WARN_SECONDS,
} from '../mock2/lock-logic.js';

const T0 = '2026-07-10T12:00:00.000Z';
const plus = (ms) => new Date(Date.parse(T0) + ms).toISOString();

test('lockHolder: user XOR cycle, else null', () => {
  assert.deepEqual(lockHolder({ holder_user_id: 7 }), { type: 'user', id: 7 });
  assert.deepEqual(lockHolder({ holder_cycle_id: 3 }), { type: 'cycle', id: 3 });
  assert.equal(lockHolder(null), null);
  assert.equal(lockHolder({}), null);
});

test('timeRemainingMs / isLockExpired: counts from last_write_at', () => {
  const lock = { holder_user_id: 1, last_write_at: T0 };
  // 15 min idle window; 10 min elapsed → 5 min remaining, not expired.
  assert.equal(timeRemainingMs(lock, plus(10 * 60000), 15), 5 * 60000);
  assert.equal(isLockExpired(lock, plus(10 * 60000), 15), false);
  // 15 min elapsed → expired.
  assert.equal(isLockExpired(lock, plus(15 * 60000), 15), true);
  // malformed timestamp → never expired (fail safe).
  assert.equal(isLockExpired({ holder_user_id: 1, last_write_at: 'nope' }, T0, 15), false);
});

test('msSinceWrite: NaN on bad input', () => {
  assert.ok(Number.isNaN(msSinceWrite(null, T0)));
  assert.equal(msSinceWrite({ last_write_at: T0 }, plus(1000)), 1000);
});

test('inWarnWindow: only inside the last LOCK_WARN_SECONDS, not once expired', () => {
  const lock = { holder_user_id: 1, last_write_at: T0 };
  const idle = 15;
  // 14 min elapsed → 60s remaining ≤ 120s warn → warn.
  assert.equal(inWarnWindow(lock, plus(14 * 60000), idle), true);
  // 10 min elapsed → 5 min remaining → no warn.
  assert.equal(inWarnWindow(lock, plus(10 * 60000), idle), false);
  // expired → not a warning (that's auto-release).
  assert.equal(inWarnWindow(lock, plus(16 * 60000), idle), false);
  assert.equal(LOCK_WARN_SECONDS, 120);
});

test('resolveIdleMinutes: clamps to a safe floor', () => {
  assert.equal(resolveIdleMinutes('30'), 30);
  assert.equal(resolveIdleMinutes(0), DEFAULT_LOCK_IDLE_MINUTES); // 0 can't release instantly
  assert.equal(resolveIdleMinutes(-5), DEFAULT_LOCK_IDLE_MINUTES);
  assert.equal(resolveIdleMinutes('bad'), DEFAULT_LOCK_IDLE_MINUTES);
  assert.equal(resolveIdleMinutes(1), 1);
});

test('mayAcquire: viewers never acquire', () => {
  const r = mayAcquire({ lockRow: null, requester: { type: 'user', id: 1 }, role: 'viewer', nowIso: T0 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /viewer/);
});

test('mayAcquire: free lock → ok for editor', () => {
  const r = mayAcquire({ lockRow: null, requester: { type: 'user', id: 1 }, role: 'editor', nowIso: T0 });
  assert.equal(r.ok, true);
});

test('mayAcquire: same holder re-asserts', () => {
  const lock = { holder_user_id: 1, last_write_at: T0 };
  const r = mayAcquire({ lockRow: lock, requester: { type: 'user', id: 1 }, role: 'editor', nowIso: plus(1000), idleMinutes: 15 });
  assert.equal(r.ok, true);
  assert.match(r.reason, /already held/);
});

test('mayAcquire: held live by another → refuse, offer takeover', () => {
  const lock = { holder_user_id: 2, last_write_at: T0 };
  const r = mayAcquire({ lockRow: lock, requester: { type: 'user', id: 1 }, role: 'editor', nowIso: plus(60000), idleMinutes: 15 });
  assert.equal(r.ok, false);
  assert.equal(r.canTakeover, true);
  assert.deepEqual(r.heldBy, { type: 'user', id: 2 });
});

test('mayAcquire: expired hold by another → acquirable', () => {
  const lock = { holder_user_id: 2, last_write_at: T0 };
  const r = mayAcquire({ lockRow: lock, requester: { type: 'user', id: 1 }, role: 'editor', nowIso: plus(20 * 60000), idleMinutes: 15 });
  assert.equal(r.ok, true);
  assert.match(r.reason, /expired/);
});

test('mayAcquire: a cycle is not role-gated', () => {
  const r = mayAcquire({ lockRow: null, requester: { type: 'cycle', id: 9 }, role: undefined, nowIso: T0 });
  assert.equal(r.ok, true);
});

test('shouldAutoRelease: only live, expired locks', () => {
  assert.equal(shouldAutoRelease(null, T0, 15), false);
  const live = { holder_user_id: 1, last_write_at: plus(-60000) };
  assert.equal(shouldAutoRelease(live, T0, 15), false);
  const stale = { holder_user_id: 1, last_write_at: plus(-20 * 60000) };
  assert.equal(shouldAutoRelease(stale, T0, 15), true);
});

test('publicLockShape: held view carries remaining + warn + takeover', () => {
  const lock = { holder_user_id: 5, acquired_at: T0, last_write_at: T0, takeover_requested_by: 9, takeover_requested_at: plus(14 * 60000) };
  const shaped = publicLockShape(lock, { nowIso: plus(14 * 60000 + 30000), idleMinutes: 15, holderName: 'alice' });
  assert.equal(shaped.held, true);
  assert.equal(shaped.holder_type, 'user');
  assert.equal(shaped.holder_name, 'alice');
  assert.equal(shaped.warn, true);
  assert.equal(shaped.takeover_requested_by, 9);
  assert.deepEqual(publicLockShape(null, { nowIso: T0 }), { held: false });
});
