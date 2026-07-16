// integration_gate_mode operator switch — the block/approve loop relief valve.
// Exercises the PURE decision layer (accept-pending-logic.js): mode normalization
// and the downgrade of a blocking integration-truthfulness decision under the
// relaxed modes. No DB/container, so it runs at the module boundary (risk R9).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeGateMode, applyIntegrationGateMode,
  GATE_MODE_ENFORCE, GATE_MODE_PENDING, GATE_MODE_MONITOR, INTEGRATION_GATE_MODES,
} from '../mock2/accept-pending-logic.js';

// A representative BLOCKING integration-gate decision (a fabricated-data finding
// plus a touched subsystem), shaped like evaluateIntegrationTruthfulness output.
function blockingDecision() {
  return {
    schema_version: 1,
    outcome: 'blocked-deviation',
    blocking: true,
    reasons: ['[integration:provenance_not_established] src/payments.js#charge: no real transport'],
    gate: { verdict: 'fail', findings: [{ kind: 'provenance_not_established', subsystem: 'payments' }] },
    egress: { ok: true, findings: [] },
    screening: { blocking: false, candidates: [] },
    checklist: [],
    pending_findings: [],
    touched_subsystems: ['payments'],
  };
}

test('INTEGRATION_GATE_MODES exposes exactly the three modes', () => {
  assert.deepEqual([...INTEGRATION_GATE_MODES], ['enforce', 'pending', 'monitor']);
});

test('normalizeGateMode accepts known modes and case-folds', () => {
  assert.equal(normalizeGateMode('enforce'), GATE_MODE_ENFORCE);
  assert.equal(normalizeGateMode('pending'), GATE_MODE_PENDING);
  assert.equal(normalizeGateMode('MONITOR'), GATE_MODE_MONITOR);
  assert.equal(normalizeGateMode('  Pending  '), GATE_MODE_PENDING);
});

test('normalizeGateMode falls back to enforce for unknown/empty/nullish', () => {
  assert.equal(normalizeGateMode('loose'), GATE_MODE_ENFORCE);
  assert.equal(normalizeGateMode(''), GATE_MODE_ENFORCE);
  assert.equal(normalizeGateMode(undefined), GATE_MODE_ENFORCE);
  assert.equal(normalizeGateMode(null), GATE_MODE_ENFORCE);
});

test('enforce mode leaves a blocking decision untouched (still blocks)', () => {
  const decision = blockingDecision();
  const res = applyIntegrationGateMode({ decision, mode: 'enforce' });
  assert.equal(res.downgraded, false);
  assert.equal(res.decision.blocking, true);
  assert.equal(res.decision, decision); // returned as-is, not cloned
});

test('a non-blocking decision is never downgraded, whatever the mode', () => {
  const clean = { blocking: false, outcome: 'succeeded', reasons: [], checklist: [] };
  for (const mode of ['enforce', 'pending', 'monitor']) {
    const res = applyIntegrationGateMode({ decision: clean, mode });
    assert.equal(res.downgraded, false);
    assert.equal(res.decision.blocking, false);
  }
});

test('unknown mode normalizes to enforce — no accidental bypass', () => {
  const res = applyIntegrationGateMode({ decision: blockingDecision(), mode: 'yolo' });
  assert.equal(res.mode, GATE_MODE_ENFORCE);
  assert.equal(res.downgraded, false);
  assert.equal(res.decision.blocking, true);
});

test('pending mode downgrades the block to pending-operator-verification with a live checklist', () => {
  const decision = blockingDecision();
  const res = applyIntegrationGateMode({ decision, mode: 'pending' });
  assert.equal(res.downgraded, true);
  assert.equal(res.mode, GATE_MODE_PENDING);
  assert.equal(res.decision.blocking, false);
  assert.equal(res.decision.outcome, 'pending-operator-verification');
  // A concrete live check is synthesized from the touched subsystem so the
  // operator is always handed something to verify.
  assert.ok(Array.isArray(res.decision.checklist) && res.decision.checklist.length >= 1);
  assert.ok(res.decision.checklist.some((c) => c.subsystem === 'payments'));
  // The original block reasons are preserved for the audit trail.
  assert.deepEqual(res.decision.would_block_reasons, decision.reasons);
  assert.equal(res.decision.relaxed_from_block, true);
  assert.equal(res.decision.relaxed_mode, 'pending');
  // The input object is not mutated (the runner re-records the returned copy).
  assert.equal(decision.blocking, true);
});

test('pending mode falls back to a generic live check when no subsystem is known', () => {
  const decision = { ...blockingDecision(), touched_subsystems: [] };
  const res = applyIntegrationGateMode({ decision, mode: 'pending', subsystems: [] });
  assert.equal(res.downgraded, true);
  assert.ok(res.decision.checklist.length >= 1);
});

test('monitor mode clears the block without forcing a pending checklist (build proceeds)', () => {
  const decision = blockingDecision();
  const res = applyIntegrationGateMode({ decision, mode: 'monitor' });
  assert.equal(res.downgraded, true);
  assert.equal(res.mode, GATE_MODE_MONITOR);
  assert.equal(res.decision.blocking, false);
  assert.equal(res.decision.outcome, 'monitor-recorded');
  // No checklist manufactured — an empty-checklist decision succeeds downstream.
  assert.equal(res.decision.checklist.length, 0);
  assert.deepEqual(res.decision.would_block_reasons, decision.reasons);
});
