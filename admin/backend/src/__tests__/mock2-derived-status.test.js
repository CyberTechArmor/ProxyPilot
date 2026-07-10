// Mock2 Phase M9 tests — the FINALIZED derived-status function (single source of
// truth; 03-data-model.md). Stub-first (risk R9): imports ONLY project-logic.js
// (native-free). M9 adds the remaining states — building, checked_out,
// quota_exhausted — to the SAME deriveProjectStatus + ctx (never a fork) and this
// pins the full precedence across every state.

import test from 'node:test';
import assert from 'node:assert/strict';

import { deriveProjectStatus, publicProjectShape } from '../mock2/project-logic.js';

const active = { lifecycle: 'active' };

// ---- backward compatibility: the M2/M8 behavior is unchanged with defaults ----

test('deriveProjectStatus: pre-M9 defaults are unchanged (no new inputs)', () => {
  assert.equal(deriveProjectStatus(active, { editorCount: 1 }), 'online');
  assert.equal(deriveProjectStatus(active, { editorCount: 0 }), 'orphaned');
  assert.equal(deriveProjectStatus(active, { editorCount: 1, containerState: 'stopped' }), 'idle');
  assert.equal(deriveProjectStatus({ lifecycle: 'stopped' }, { editorCount: 1 }), 'stopped');
  assert.equal(deriveProjectStatus(active, { editorCount: 1, openEditorQuestions: 1 }), 'awaiting_user');
  assert.equal(deriveProjectStatus(active, { editorCount: 1, openAdminItems: 1 }), 'awaiting_admin');
  assert.equal(deriveProjectStatus(active, { editorCount: 1, driftOpen: true }), 'drift');
});

// ---- the new M9 states ----

test('deriveProjectStatus: a live cycle ⇒ building', () => {
  assert.equal(deriveProjectStatus(active, { editorCount: 1, cycleRunning: true }), 'building');
});

test('deriveProjectStatus: a human-held checkout lock ⇒ checked_out', () => {
  assert.equal(deriveProjectStatus(active, { editorCount: 1, lockHeldByHuman: true }), 'checked_out');
});

test('deriveProjectStatus: budget exhausted ⇒ quota_exhausted', () => {
  assert.equal(deriveProjectStatus(active, { editorCount: 1, quotaExhausted: true }), 'quota_exhausted');
});

// ---- precedence across ALL states ----

test('deriveProjectStatus: lifecycle terminals still win over everything', () => {
  assert.equal(deriveProjectStatus({ lifecycle: 'provisioning' }, { cycleRunning: true, quotaExhausted: true }), 'provisioning');
  assert.equal(deriveProjectStatus({ lifecycle: 'archived' }, { cycleRunning: true }), 'archived');
  assert.equal(deriveProjectStatus({ lifecycle: 'failed_provisioning' }, { cycleRunning: true }), 'failed');
});

test('deriveProjectStatus: building beats the awaiting/quota lanes (the runner is working)', () => {
  assert.equal(deriveProjectStatus(active, { editorCount: 1, cycleRunning: true, openEditorQuestions: 1, quotaExhausted: true }), 'building');
});

test('deriveProjectStatus: quota_exhausted fronts the awaiting/queue lanes when not building', () => {
  // A budget-exhausted project can't proceed regardless of open questions, and its
  // quota_exhausted queue item must not read as a generic "awaiting admin".
  assert.equal(deriveProjectStatus(active, { editorCount: 1, quotaExhausted: true, openEditorQuestions: 1, openAdminItems: 1 }), 'quota_exhausted');
});

test('deriveProjectStatus: awaiting_user beats awaiting_admin beats checked_out beats drift', () => {
  assert.equal(deriveProjectStatus(active, { editorCount: 1, openEditorQuestions: 1, openAdminItems: 1, lockHeldByHuman: true, driftOpen: true }), 'awaiting_user');
  assert.equal(deriveProjectStatus(active, { editorCount: 1, openAdminItems: 1, lockHeldByHuman: true, driftOpen: true }), 'awaiting_admin');
  assert.equal(deriveProjectStatus(active, { editorCount: 1, lockHeldByHuman: true, driftOpen: true }), 'checked_out');
  assert.equal(deriveProjectStatus(active, { editorCount: 1, driftOpen: true }), 'drift');
});

test('deriveProjectStatus: an idle-stopped project (lifecycle stopped) reads stopped even mid-drift', () => {
  // Once idle-stop flips lifecycle to stopped, that shows (drift is checked before
  // orphaned/stopped only for a live project; a stopped project has no live cycle).
  assert.equal(deriveProjectStatus({ lifecycle: 'stopped' }, { editorCount: 1 }), 'stopped');
});

// ---- the shape surfaces the new signals for the UI ----

test('publicProjectShape: exposes cycle_running / checked_out / quota_exhausted', () => {
  const shaped = publicProjectShape(active, {
    editorCount: 1, cycleRunning: true, lockHeldByHuman: false, quotaExhausted: false,
  });
  assert.equal(shaped.status, 'building');
  assert.equal(shaped.cycle_running, true);
  assert.equal(shaped.checked_out, false);
  assert.equal(shaped.quota_exhausted, false);
});

test('publicProjectShape: quota exhaustion surfaces as the status + the flag', () => {
  const shaped = publicProjectShape(active, { editorCount: 1, quotaExhausted: true });
  assert.equal(shaped.status, 'quota_exhausted');
  assert.equal(shaped.quota_exhausted, true);
});
