// PATCH2 Part A — REPRODUCE FIRST: pending-operator-verification is not a
// returnable outcome, and live checks are cycle-scoped not capability-scoped.
//
// Behavioral reds against the CURRENT harness modules (runner-logic.js +
// verification-logic.js both exist) — not missing-module errors. Each asserts the
// DESIRED post-patch behavior, so it is RED now and GREEN once PATCH2 lands.
//
// Reproduced conditions (from ADP3, observed live):
//   A.1 the builder concluded a healthy build that needs live verification, but
//       its only terminal moves are finish (→ succeeded) and halt (→ blocked) —
//       there is no way to RETURN pending-operator-verification directly, so it
//       had to raise a blocker and stuff the pending decision into halt options.
//   A.2 the pending live checks are CYCLE-scoped (derived from the subsystems a
//       cycle touched), so a cycle that doesn't touch the capability drops them
//       entirely — they cannot be a persistent property of the capability.

import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyTurn, RUNNER_TOOL_NAMES } from '../mock2/runner-logic.js';
import { deriveVerificationChecklist } from '../mock2/verification-logic.js';
import * as verificationLogic from '../mock2/verification-logic.js';

// A manifest that declares a live-verification-required capability in subsystem
// `directory` (the ADP/LDAPS shape) whose check cannot run in the fence.
const MANIFEST = {
  schema_version: 1,
  entries: [{
    id: 'directory-provider', subsystem: 'directory',
    actions: [{ name: 'test-connection', operation: 'tls-and-auth' }, { name: 'sync', operation: 'fetch-and-persist' }],
    destination: { source: 'db-config', key: 'directory.url' },
    transport: 'ldaps', provenance: { response_to_output: 'required' },
    live_verification: { required: true }, egress: { classification: 'private' },
  }],
};

// ---- A.1: pending-operator-verification is not a returnable terminal move ----

test('A.1 (RED): the builder has no tool to return pending-operator-verification', () => {
  // The only terminal moves offered to the builder are finish / halt / auth.
  assert.ok(RUNNER_TOOL_NAMES.includes('finish'));
  assert.ok(RUNNER_TOOL_NAMES.includes('halt'));
  // DESIRED (fails now): a first-class pending-verification terminal move exists.
  assert.ok(
    RUNNER_TOOL_NAMES.includes('pending_verification'),
    'the builder must be able to conclude a cycle as pending-operator-verification directly, not via the blocker queue',
  );
});

test('A.1 (RED): classifyTurn does not recognize a pending-verification conclusion', () => {
  const decision = classifyTurn([{
    name: 'pending_verification',
    input: { summary: 'built the ADP/LDAPS integration; two live checks need production creds', acceptance: ['as admin, run Test Connection'], assumptions: { verified: ['src/directory/transport.ts'], assumed: [] } },
  }]);
  // Currently the tool is unknown → not a terminal conclusion (done/halted false),
  // so the runner would try to execute it as a tool. DESIRED: a distinct outcome.
  assert.equal(decision.done, false);
  assert.equal(decision.halted, false);
  assert.ok(
    decision.pendingVerification === true,
    'classifyTurn must classify a pending_verification call as a calm pending conclusion',
  );
});

// ---- A.2: live checks are cycle-scoped, not capability-scoped ----

test('A.2 (RED): a cycle that does not touch the capability drops its live checks entirely', () => {
  // The bootstrap cycle touches `auth`, not `directory` — so the directory
  // capability's live checks vanish from the per-cycle checklist.
  const bootstrapChecklist = deriveVerificationChecklist({ manifest: MANIFEST, subsystems: ['auth'] });
  assert.equal(bootstrapChecklist.length, 0, 'documents the cycle-scoping: an unrelated cycle sees no checks');

  // DESIRED (fails now): a CAPABILITY-scoped status exists — the directory
  // capability has outstanding live checks regardless of which cycle is running,
  // and is NOT dropped just because a cycle did not touch it. verification-logic
  // must expose this project-wide, confirmation-netted status.
  //
  // A namespace import keeps this a BEHAVIORAL red (an assertion on a missing
  // export), never a module-load error.
  assert.equal(
    typeof verificationLogic.capabilityCheckStatus, 'function',
    'a capability-scoped, confirmation-netted live-check status must exist so pending is a property of the capability, not the cycle',
  );
});

// ---- Part C.1: pending is a returnable, calm conclusion ----

test('C.1 (GREEN): pending_verification is a first-class terminal move, distinct from finish and halt', () => {
  const d = classifyTurn([{
    name: 'pending_verification',
    input: { summary: 'ADP/LDAPS integration built; live checks need production creds', acceptance: ['as admin, run Test Connection'], assumptions: { verified: ['src/directory/transport.ts'], assumed: [] } },
  }]);
  assert.equal(d.pendingVerification, true);
  assert.equal(d.done, false, 'pending is NOT finish/succeeded');
  assert.equal(d.halted, false, 'pending is NOT a block');
  // Carries the finish-shaped payload so the runner records the same acceptance evidence.
  assert.equal(d.finishSummary, 'ADP/LDAPS integration built; live checks need production creds');
  assert.deepEqual(d.finishAssumptions, { verified: ['src/directory/transport.ts'], assumed: [] });
});

test('C.1: halt still takes precedence over pending (a turn pairing both is treated conservatively)', () => {
  const d = classifyTurn([
    { name: 'halt', input: { reason: 'blocked', options: [{ label: 'a', kind: 'abandon' }, { label: 'b', kind: 'abandon' }] } },
    { name: 'pending_verification', input: { summary: 's', acceptance: ['x'], assumptions: { verified: [], assumed: [] } } },
  ]);
  assert.equal(d.halted, true);
  assert.equal(d.pendingVerification, false);
});

// ---- Part C.2/C.3: capability-scoped status, independent verification ----

const CHECKLIST = [
  { item_id: 'directory-provider:test-connection', manifest_id: 'directory-provider', manifest_hash: 'a'.repeat(64), subsystem: 'directory', description: 'ADP Test Connection' },
  { item_id: 'directory-provider:sync', manifest_id: 'directory-provider', manifest_hash: 'a'.repeat(64), subsystem: 'directory', description: 'LDAPS bind + directory login' },
];

test('C.2: capability checks are project-wide and persist regardless of the current cycle', () => {
  const { capabilityCheckStatus } = verificationLogic;
  // No confirmations yet → both outstanding, app not production-ready.
  const s0 = capabilityCheckStatus({ checklistItems: CHECKLIST, activeVerifications: [] });
  assert.equal(s0.outstanding_count, 2);
  assert.equal(s0.production_ready, false);
});

test('C.3: confirming a capability check independently moves it to verified; app becomes production-ready when none remain', () => {
  const { capabilityCheckStatus } = verificationLogic;
  // One live confirmation (matching manifest_hash) → one verified, one outstanding.
  const oneConfirmed = [{ item_id: 'directory-provider:test-connection', manifest_hash: 'a'.repeat(64), operator_id: 7, created_at: '2026-07-15T00:00:00Z' }];
  const s1 = capabilityCheckStatus({ checklistItems: CHECKLIST, activeVerifications: oneConfirmed });
  assert.equal(s1.verified_count, 1);
  assert.equal(s1.outstanding_count, 1);
  assert.equal(s1.production_ready, false);
  // Both confirmed → production ready.
  const bothConfirmed = [...oneConfirmed, { item_id: 'directory-provider:sync', manifest_hash: 'a'.repeat(64), operator_id: 7, created_at: '2026-07-15T00:00:00Z' }];
  const s2 = capabilityCheckStatus({ checklistItems: CHECKLIST, activeVerifications: bothConfirmed });
  assert.equal(s2.production_ready, true);
  assert.equal(s2.outstanding_count, 0);
});

test('C.3: a manifest-hash change re-opens a previously-confirmed capability check (supersession)', () => {
  const { capabilityCheckStatus } = verificationLogic;
  // The checklist item's manifest_hash changed (the capability was modified), but
  // the confirmation carries the OLD hash → the check is outstanding again (stale).
  const staleConfirm = [{ item_id: 'directory-provider:test-connection', manifest_hash: 'OLD'.padEnd(64, '0'), operator_id: 7 }];
  const s = capabilityCheckStatus({ checklistItems: [CHECKLIST[0]], activeVerifications: staleConfirm });
  assert.equal(s.production_ready, false);
  assert.equal(s.outstanding[0].stale_verification, true);
});

// ---- Part C.4: a stub can never reach pending (the invariant holds) ----

test('C.4: pending is refused when the integration gate is red (stub/fabricated stays blocked)', () => {
  // The lifecycle invariant: pending-operator-verification is unreachable when the
  // integration gate failed. verificationTransition enforces it.
  const refused = verificationLogic.verificationTransition({ state: 'building', event: 'gates_green_with_integrations', integrationGateVerdict: 'fail' });
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /integration gate|blocking deviation/i);
});
