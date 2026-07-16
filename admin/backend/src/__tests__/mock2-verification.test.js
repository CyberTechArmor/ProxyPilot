// B.5 operator-verification lifecycle — pure decision layer. Written RED first:
// the current harness has no state between "gates green → succeeded" and
// "red → not succeeded" (AUDIT.md A.5).

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  REPORTED_OUTCOMES, OUTCOME_CODES, reportedCycleOutcome, deployPendingIsHealthy,
  deriveVerificationChecklist, validateConfirmation, verificationTransition,
  supersessionNeeded, requireActorId, VERIFICATION_SCHEMA_VERSION,
} from '../mock2/verification-logic.js';
import { parseIntegrationManifest } from '../mock2/integration-logic.js';
import { MANIFEST_OK } from './fixtures/integration-fixtures.js';

const manifest = parseIntegrationManifest(MANIFEST_OK).manifest;

// ---- reported outcomes + stable status semantics ----

test('reported outcomes are documented with stable, non-colliding codes', () => {
  assert.deepEqual(Object.keys(REPORTED_OUTCOMES).sort(), [
    'blocked-deviation', 'gate-rejected', 'migration-analysis-incomplete',
    'pending-operator-verification', 'resolution-ineffective', 'succeeded',
  ].sort());
  const codes = Object.values(OUTCOME_CODES);
  assert.equal(new Set(codes).size, codes.length); // no collisions
  assert.equal(OUTCOME_CODES.succeeded, 0);
  // PATCH B.4: the loop-breaker outcome has its own stable, non-colliding code.
  assert.equal(OUTCOME_CODES['resolution-ineffective'], 74);
});

test('reportedCycleOutcome maps stored status + verification_state to the structured outcome', () => {
  assert.equal(reportedCycleOutcome({ status: 'succeeded', verification_state: null }), 'succeeded');
  assert.equal(reportedCycleOutcome({ status: 'awaiting_user', verification_state: 'pending' }), 'pending-operator-verification');
  assert.equal(reportedCycleOutcome({ status: 'awaiting_admin', halt_reason: 'simulation_disclosure' }), 'blocked-deviation');
  assert.equal(reportedCycleOutcome({ status: 'failed', error: 'gates red' }), 'gate-rejected');
  assert.equal(reportedCycleOutcome({ status: 'running' }), null); // nonterminal
});

test('deploy-pending counts as healthy is an explicit, documented decision', () => {
  assert.equal(typeof deployPendingIsHealthy(), 'boolean');
  assert.equal(deployPendingIsHealthy(), true); // the operator needs the running app to verify
});

// ---- checklist derivation from the manifest ----

test('checklist derives one item per live-verification action, carrying manifest id + hash', () => {
  const items = deriveVerificationChecklist({ manifest, subsystems: ['people'] });
  assert.equal(items.length, 2); // test-connection + sync-people
  for (const it of items) {
    assert.equal(it.manifest_id, 'directory-provider');
    assert.match(it.manifest_hash, /^[a-f0-9]{64}$/);
    assert.ok(it.item_id);
    assert.ok(it.action);
    assert.ok(it.description.length > 10);
    assert.equal(it.schema_version, VERIFICATION_SCHEMA_VERSION);
  }
});

test('no manifest-declared integrations in scope → empty checklist (cycle may go straight to succeeded)', () => {
  assert.deepEqual(deriveVerificationChecklist({ manifest, subsystems: ['billing'] }), []);
  assert.deepEqual(deriveVerificationChecklist({ manifest: { schema_version: 1, entries: [] }, subsystems: ['people'] }), []);
});

// ---- confirmation evidence ----

test('a bare checkbox is invalid: confirmation requires an observed result', () => {
  const base = {
    item_id: 'directory-provider:test-connection', manifest_id: 'directory-provider',
    manifest_hash: 'a'.repeat(64), operator_id: 7, environment: 'production',
    endpoint_classification: 'public', observed_result: 'TLS handshake + token issued against api.provider.example; 200 with 41 workers',
  };
  assert.equal(validateConfirmation(base).ok, true);
  assert.equal(validateConfirmation({ ...base, observed_result: '' }).ok, false);
  assert.equal(validateConfirmation({ ...base, observed_result: 'true' }).ok, false); // checkbox-shaped
  assert.equal(validateConfirmation({ ...base, operator_id: null }).ok, false);
});

test('waivers require an admin and a recorded reason', () => {
  const w = {
    item_id: 'x', manifest_id: 'm', manifest_hash: 'a'.repeat(64),
    operator_id: 7, waived: true, waiver_reason: 'endpoint decommissioned; capability disabled in manifest',
    environment: 'production', endpoint_classification: 'public',
  };
  assert.equal(validateConfirmation({ ...w, role: 'admin' }).ok, true);
  assert.equal(validateConfirmation({ ...w, role: 'operator' }).ok, false); // operators confirm; admins waive
  assert.equal(validateConfirmation({ ...w, role: 'admin', waiver_reason: '' }).ok, false);
});

// ---- transitions ----

test('lifecycle transitions match the specified state machine', () => {
  // building → pending-operator-verification (gates green, integrations in scope)
  assert.equal(verificationTransition({ state: 'building', event: 'gates_green_with_integrations' }).next, 'pending-operator-verification');
  // building → succeeded (no external integrations in scope)
  assert.equal(verificationTransition({ state: 'building', event: 'gates_green_no_integrations' }).next, 'succeeded');
  // building → blocked-deviation / rejected
  assert.equal(verificationTransition({ state: 'building', event: 'simulation_disclosure' }).next, 'blocked-deviation');
  assert.equal(verificationTransition({ state: 'building', event: 'gate_red' }).next, 'rejected');
  // pending → succeeded only when every item is confirmed or waived
  assert.equal(verificationTransition({ state: 'pending-operator-verification', event: 'all_items_confirmed' }).next, 'succeeded');
  // pending → building when a live check fails (remediation reopens the cycle)
  assert.equal(verificationTransition({ state: 'pending-operator-verification', event: 'live_check_failed' }).next, 'building');
  // invalid transitions are refused, not silently accepted
  assert.equal(verificationTransition({ state: 'pending-operator-verification', event: 'gate_red' }).ok, false);
});

test('invariant: pending-operator-verification never legitimizes a failed integration gate', () => {
  const t = verificationTransition({ state: 'building', event: 'gates_green_with_integrations', integrationGateVerdict: 'fail' });
  assert.equal(t.ok, false);
  assert.match(t.reason, /integration gate|blocking deviation/i);
});

// ---- PATCH B.1/B.2 transitions from blocked-deviation ----

test('PATCH B.2: a provenance waiver routes blocked-deviation → pending-operator-verification (never succeeded)', () => {
  const t = verificationTransition({ state: 'blocked-deviation', event: 'provenance_waived', waiverEligible: true });
  assert.equal(t.ok, true);
  assert.equal(t.next, 'pending-operator-verification');
  assert.notEqual(t.next, 'succeeded');
});

test('PATCH B.2 invariant: a waiver is REFUSED for a positively-fabricated finding', () => {
  const t = verificationTransition({ state: 'blocked-deviation', event: 'provenance_waived', waiverEligible: false });
  assert.equal(t.ok, false);
  assert.match(t.reason, /fabricated|refused/i);
});

test('PATCH B.1: backfilling the manifest returns blocked-deviation → building (the gate re-runs)', () => {
  const t = verificationTransition({ state: 'blocked-deviation', event: 'manifest_backfilled' });
  assert.equal(t.ok, true);
  assert.equal(t.next, 'building');
});

test('PATCH B.4: the loop breaker trips blocked-deviation → resolution-ineffective', () => {
  const t = verificationTransition({ state: 'blocked-deviation', event: 'loop_breaker_tripped' });
  assert.equal(t.ok, true);
  assert.equal(t.next, 'resolution-ineffective');
});

test('reportedCycleOutcome surfaces resolution-ineffective from its halt_reason', () => {
  assert.equal(reportedCycleOutcome({ status: 'awaiting_admin', halt_reason: 'resolution_ineffective' }), 'resolution-ineffective');
});

// ---- invalidation / supersession ----

test('supersession: manifest hash change, expiry, or requested reverification invalidates a verified record', () => {
  const verified = { manifest_id: 'directory-provider', manifest_hash: 'a'.repeat(64), expires_at: null };
  assert.equal(supersessionNeeded({ record: verified, currentManifestHash: 'a'.repeat(64), now: '2026-07-15T00:00:00Z' }).needed, false);
  const changed = supersessionNeeded({ record: verified, currentManifestHash: 'b'.repeat(64), now: '2026-07-15T00:00:00Z' });
  assert.equal(changed.needed, true);
  assert.match(changed.reason, /manifest/i);
  const expiring = { ...verified, expires_at: '2026-07-01T00:00:00Z' };
  const expired = supersessionNeeded({ record: expiring, currentManifestHash: 'a'.repeat(64), now: '2026-07-15T00:00:00Z' });
  assert.equal(expired.needed, true);
  assert.match(expired.reason, /expir/i);
  const requested = supersessionNeeded({ record: verified, currentManifestHash: 'a'.repeat(64), now: '2026-07-15T00:00:00Z', requested: true });
  assert.equal(requested.needed, true);
});

// ---- requireActorId: the NOT NULL actor-column guard ----
// users.id is a UUID (TEXT PRIMARY KEY): Number(uuid) is NaN and better-sqlite3
// binds NaN as NULL, so a numeric coercion of the actor id surfaced as an
// opaque "NOT NULL constraint failed" 500 on every button of the
// pending-verification card. The guard passes real ids through AS-IS and fails
// unresolvable ones with an actionable message.

test('requireActorId passes UUID ids through unchanged — never Number-coerced', () => {
  const uuid = '6f1c2a4e-9b3d-4f7a-8c5e-2d1b0a9f8e7d';
  assert.equal(requireActorId(uuid, 'operator_id'), uuid);
  assert.equal(requireActorId('  admin-1  ', 'decided_by'), 'admin-1'); // trimmed, not coerced
});

test('requireActorId tolerates legacy numeric ids', () => {
  assert.equal(requireActorId(7, 'operator_id'), 7);
});

test('requireActorId rejects null/undefined/NaN/empty/zero with an actionable message', () => {
  for (const bad of [null, undefined, NaN, '', '   ', 0, -1, false]) {
    assert.throws(() => requireActorId(bad, 'operator_id'), /sign out, sign back in/);
  }
});
