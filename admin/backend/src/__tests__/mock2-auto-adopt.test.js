// Automatic framework adoption — the pure decision layer (ADR-003 amendment).
// Native-free: exercises auto-adopt-logic.js only, per the stub-first pattern.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldAutoAdopt, adoptInstruction, adoptChatNotice, ACTIVE_CYCLE_STATUSES,
} from '../mock2/auto-adopt-logic.js';

const eligible = () => ({
  enabled: true,
  project: {
    lifecycle: 'active',
    design_approved_at: '2026-07-01T00:00:00.000Z',
    last_built_framework_version_id: 15,
  },
  currentFrameworkId: 16,
  latestCycleStatus: 'succeeded',
  hasCycleOnCurrent: false,
  lockHeld: false,
});

test('shouldAutoAdopt: adopts a drifted, idle, online, previously-built project', () => {
  const v = shouldAutoAdopt(eligible());
  assert.equal(v.adopt, true);
  assert.equal(v.reason, 'drifted');
});

test('shouldAutoAdopt: refuses when the switch is off', () => {
  assert.equal(shouldAutoAdopt({ ...eligible(), enabled: false }).adopt, false);
});

test('shouldAutoAdopt: refuses offline / archived / provisioning projects', () => {
  for (const lifecycle of ['stopped', 'archived', 'provisioning', 'failed_provisioning']) {
    const f = eligible();
    f.project.lifecycle = lifecycle;
    assert.equal(shouldAutoAdopt(f).adopt, false, lifecycle);
  }
});

test('shouldAutoAdopt: refuses before design approval and before the first build', () => {
  const noApproval = eligible();
  noApproval.project.design_approved_at = null;
  assert.equal(shouldAutoAdopt(noApproval).adopt, false);

  // A project that never built has nothing to reconcile — its first build pins
  // the current version by itself.
  const neverBuilt = eligible();
  neverBuilt.project.last_built_framework_version_id = null;
  assert.equal(shouldAutoAdopt(neverBuilt).adopt, false);
});

test('shouldAutoAdopt: refuses when already on the current version', () => {
  const f = eligible();
  f.project.last_built_framework_version_id = 16;
  const v = shouldAutoAdopt(f);
  assert.equal(v.adopt, false);
  assert.equal(v.reason, 'up to date');
});

test('shouldAutoAdopt: never starts over live work — any active cycle status or a held lock refuses', () => {
  for (const status of ACTIVE_CYCLE_STATUSES) {
    assert.equal(shouldAutoAdopt({ ...eligible(), latestCycleStatus: status }).adopt, false, status);
  }
  assert.equal(shouldAutoAdopt({ ...eligible(), lockHeld: true }).adopt, false);
  // Terminal statuses do not block.
  for (const status of ['succeeded', 'failed', 'abandoned', 'refused_quota', 'interrupted', null]) {
    assert.equal(shouldAutoAdopt({ ...eligible(), latestCycleStatus: status }).adopt, true, String(status));
  }
});

test('shouldAutoAdopt: one attempt per version — an existing cycle pinning current refuses', () => {
  // Every cycle (including a refused or failed adoption) pins the current
  // version at insert, so this is what stops a failing adoption from retrying
  // itself forever on the operator's bill.
  const v = shouldAutoAdopt({ ...eligible(), hasCycleOnCurrent: true });
  assert.equal(v.adopt, false);
  assert.equal(v.reason, 'already attempted this version');
});

test('adoptInstruction matches the manual update-cycle shape (BuildMode.remediate)', () => {
  assert.equal(
    adoptInstruction(15, 16),
    'Adopt framework v15 → v16: re-run the full gate battery and reconcile the app with the updated constitution and confirmed rules (Mock2 v15 → v16).',
  );
  // Unknown "from" (pre-tracking rows) still composes a valid instruction.
  assert.equal(
    adoptInstruction(null, 16),
    'Adopt framework v16: re-run the full gate battery and reconcile the app with the updated constitution and confirmed rules (Mock2 v16).',
  );
});

test('adoptChatNotice names the versions and the off switch', () => {
  const s = adoptChatNotice(15, 16);
  assert.match(s, /v15 → v16/);
  assert.match(s, /automatically/);
  assert.match(s, /turned off/);
});
