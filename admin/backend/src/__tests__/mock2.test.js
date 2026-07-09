// Mock2 Phase M0 tests — gating, status-route authorization, and the
// superadmin protection rule (ADR-001, ADR-007).
//
// Stub-first (risk R9 / docs/known-issues.md): these import ONLY the pure
// decision modules (mock2/gating.js, lib/superadmin.js), neither of which
// pulls in better-sqlite3 or Express. The native DB and route wiring are
// exercised end-to-end by the manual verification checklist, not here — so
// this suite never worsens the fresh-checkout native-module test gap.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveMock2Gate,
  canReadMock2Status,
  MOCK2_PIN_PATH,
} from '../mock2/gating.js';
import { checkSuperadminProtection } from '../lib/superadmin.js';

// existsSync stubs: a pin-present world and a pin-absent world.
const noPin = () => false;
const pinAt = (p) => (path) => path === p;

test('gate: flag unset → disabled (absence defaults to OFF)', () => {
  const gate = resolveMock2Gate({ env: {}, existsSync: noPin });
  assert.equal(gate.enabled, false);
  assert.equal(gate.pinned, false);
  assert.equal(gate.warning, null);
});

test('gate: MOCK2_ENABLED=false → disabled', () => {
  const gate = resolveMock2Gate({ env: { MOCK2_ENABLED: 'false' }, existsSync: noPin });
  assert.equal(gate.enabled, false);
  assert.equal(gate.pinned, false);
});

test('gate: MOCK2_ENABLED=true → enabled', () => {
  const gate = resolveMock2Gate({ env: { MOCK2_ENABLED: 'true' }, existsSync: noPin });
  assert.equal(gate.enabled, true);
  assert.equal(gate.pinned, false);
  assert.equal(gate.warning, null);
});

test('gate: accepts common truthy idioms', () => {
  for (const v of ['true', 'TRUE', '1', 'yes', 'on', ' True ']) {
    assert.equal(resolveMock2Gate({ env: { MOCK2_ENABLED: v }, existsSync: noPin }).enabled, true, v);
  }
  for (const v of ['false', '0', 'no', 'off', '', 'nope', undefined]) {
    assert.equal(resolveMock2Gate({ env: { MOCK2_ENABLED: v }, existsSync: noPin }).enabled, false, String(v));
  }
});

test('gate: pin file present overrides MOCK2_ENABLED=true (hard-off + warning)', () => {
  const gate = resolveMock2Gate({
    env: { MOCK2_ENABLED: 'true' },
    existsSync: pinAt(MOCK2_PIN_PATH),
  });
  assert.equal(gate.enabled, false);
  assert.equal(gate.pinned, true);
  assert.match(gate.warning, /production pin/i);
});

test('gate: pin present with flag already false → disabled, no warning', () => {
  const gate = resolveMock2Gate({
    env: { MOCK2_ENABLED: 'false' },
    existsSync: pinAt(MOCK2_PIN_PATH),
  });
  assert.equal(gate.enabled, false);
  assert.equal(gate.pinned, true);
  assert.equal(gate.warning, null);
});

test('gate: default pin path is /etc/proxypilot/mock2.production.pin', () => {
  assert.equal(MOCK2_PIN_PATH, '/etc/proxypilot/mock2.production.pin');
});

test('status route gating: admins only', () => {
  assert.equal(canReadMock2Status({ role: 'admin' }), true);
  assert.equal(canReadMock2Status({ role: 'user' }), false);
  assert.equal(canReadMock2Status(null), false);
  assert.equal(canReadMock2Status(undefined), false);
  assert.equal(canReadMock2Status({}), false);
});

test('superadmin protection: non-superadmin cannot demote a superadmin', () => {
  const r = checkSuperadminProtection({
    actorIsSuperadmin: false,
    targetIsSuperadmin: true,
    action: 'demote',
  });
  assert.equal(r.allowed, false);
  assert.match(r.error, /superadmin/i);
});

test('superadmin protection: non-superadmin cannot deactivate a superadmin', () => {
  const r = checkSuperadminProtection({
    actorIsSuperadmin: false,
    targetIsSuperadmin: true,
    action: 'deactivate',
  });
  assert.equal(r.allowed, false);
});

test('superadmin protection: a superadmin may act on a superadmin', () => {
  const r = checkSuperadminProtection({
    actorIsSuperadmin: true,
    targetIsSuperadmin: true,
    action: 'demote',
  });
  assert.equal(r.allowed, true);
});

test('superadmin protection: acting on a non-superadmin is always allowed', () => {
  assert.equal(
    checkSuperadminProtection({ actorIsSuperadmin: false, targetIsSuperadmin: false, action: 'demote' }).allowed,
    true,
  );
  assert.equal(
    checkSuperadminProtection({ actorIsSuperadmin: false, targetIsSuperadmin: false, action: 'deactivate' }).allowed,
    true,
  );
});
