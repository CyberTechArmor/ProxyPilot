// Operator accept-pending valve — pure decision + checklist shaping. The valve
// lets an admin convert a BLOCKED build (fence can't verify a live integration)
// into pending-operator-verification without another model round, never as
// "succeeded", always with an outstanding live check recorded.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  acceptPendingEligibility, buildAcceptPendingChecklist, normalizeAttestation,
} from '../mock2/accept-pending-logic.js';

test('eligibility: a blocked (awaiting_admin) integration-gate cycle is acceptable', () => {
  const e = acceptPendingEligibility({ status: 'awaiting_admin', halt_reason: 'integration_gate' });
  assert.equal(e.ok, true);
  assert.equal(e.warn, null);
});

test('eligibility: a non-integration halt is acceptable but warns', () => {
  const e = acceptPendingEligibility({ status: 'awaiting_admin', halt_reason: 'authorization_request' });
  assert.equal(e.ok, true);
  assert.match(e.warn, /not an unverifiable-integration reason/);
});

test('eligibility: a succeeded or already-pending cycle is refused', () => {
  assert.equal(acceptPendingEligibility({ status: 'succeeded' }).ok, false);
  assert.equal(acceptPendingEligibility({ status: 'awaiting_admin', verification_state: 'pending' }).ok, false);
  assert.equal(acceptPendingEligibility(null).ok, false);
});

test('checklist: reuses the recorded gate checklist when present', () => {
  const gateDecision = { checklist: [{ item_id: 'x', subsystem: 'adp', description: 'verify adp' }] };
  const cl = buildAcceptPendingChecklist({ gateDecision });
  assert.deepEqual(cl, gateDecision.checklist);
});

test('checklist: derives from soft (unverifiable) findings when no checklist', () => {
  const gateDecision = { pending_findings: [{ subsystem: 'people', function: 'probeDirectory' }] };
  const cl = buildAcceptPendingChecklist({ gateDecision, transport: 'ldaps' });
  assert.equal(cl.length, 1);
  assert.equal(cl[0].subsystem, 'people');
  assert.match(cl[0].description, /probeDirectory/);
  assert.match(cl[0].description, /ldaps/);
});

test('checklist: falls back to a per-subsystem item, then a generic one', () => {
  const perSub = buildAcceptPendingChecklist({ gateDecision: null, subsystems: ['adp', 'ldap'] });
  assert.equal(perSub.length, 2);
  assert.ok(perSub.every((i) => i.item_id && i.description));
  const generic = buildAcceptPendingChecklist({ gateDecision: null, subsystems: [] });
  assert.equal(generic.length, 1);
  assert.match(generic[0].description, /production network and credentials/);
});

test('attestation: blank is rejected, real text is kept and bounded', () => {
  assert.equal(normalizeAttestation('   ').ok, false);
  assert.equal(normalizeAttestation('').ok, false);
  const ok = normalizeAttestation('The ldaps transport is real; I will bind against the prod directory.');
  assert.equal(ok.ok, true);
  assert.match(ok.text, /ldaps transport is real/);
  assert.ok(normalizeAttestation('x'.repeat(5000)).text.length <= 2000);
});
