// Screen plan (screen-plan-logic.js) — the pure decision layer for per-screen
// apply: inventory → plan rows, scoped build instructions, drain ordering, and
// transient-vs-real start failures. Native-free (risk R9).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SCREEN_STATUSES, SCREEN_DECISIONS, screenPlanFromInventory,
  buildScreenBuildInstruction, nextQueuedScreen, isTransientStartError,
  screenPlanCounts, publicScreenShape, PRODUCTION_CHECK_INSTRUCTION,
} from '../mock2/screen-plan-logic.js';

test('screenPlanFromInventory: screens → ordered rows, deduped, tolerant of junk', () => {
  const rows = screenPlanFromInventory({
    screens: [
      { name: 'Dashboard', purpose: 'Overview of everything' },
      { name: 'Settings' },
      { name: 'dashboard', purpose: 'dupe by case' },
      { name: '', purpose: 'nameless is dropped' },
      null,
    ],
  });
  assert.deepEqual(rows.map((r) => r.name), ['Dashboard', 'Settings']);
  assert.deepEqual(rows.map((r) => r.sort), [0, 1]);
  assert.equal(rows[0].purpose, 'Overview of everything');
  assert.equal(rows[1].purpose, null);
  assert.deepEqual(screenPlanFromInventory(null), []);
  assert.deepEqual(screenPlanFromInventory({}), []);
});

test('buildScreenBuildInstruction: scoped to one screen, behind wired auth, styled', () => {
  const s = buildScreenBuildInstruction({ name: 'Admin Console — Users', purpose: 'Manage accounts' });
  assert.match(s, /ONLY the screen "Admin Console — Users"/);
  assert.match(s, /Manage accounts/);
  assert.match(s, /do not touch the auth wiring/);
  assert.match(s, /requireAuth\/requireRole/);
  assert.match(s, /design-tokens\.json/);
  assert.match(s, /one screen, not the app/);
});

test('nextQueuedScreen: sort order; nothing while a screen is building', () => {
  const rows = [
    { id: 1, name: 'A', status: 'built', sort: 0 },
    { id: 3, name: 'C', status: 'queued', sort: 2 },
    { id: 2, name: 'B', status: 'queued', sort: 1 },
  ];
  assert.equal(nextQueuedScreen(rows).name, 'B');
  assert.equal(nextQueuedScreen([...rows, { id: 4, name: 'D', status: 'building', sort: 3 }]), null);
  assert.equal(nextQueuedScreen([]), null);
  assert.equal(nextQueuedScreen([{ id: 1, status: 'deferred', sort: 0 }]), null);
});

test('isTransientStartError: lock/contention retries, real failures do not', () => {
  assert.equal(isTransientStartError('This project is checked out by another writer. Wait, or request a takeover.'), true);
  assert.equal(isTransientStartError('An audit is already running for this project.'), true);
  assert.equal(isTransientStartError('Project must be online to build (it is "stopped").'), true);
  assert.equal(isTransientStartError('No build_runner slot is assigned'), false);
  assert.equal(isTransientStartError(''), false);
});

test('screenPlanCounts + publicScreenShape + statuses', () => {
  assert.deepEqual([...SCREEN_DECISIONS], ['planned', 'deferred']);
  assert.ok(SCREEN_STATUSES.includes('built'));
  const counts = screenPlanCounts([
    { status: 'planned' }, { status: 'queued' }, { status: 'built' }, { status: 'built' },
  ]);
  assert.equal(counts.total, 4);
  assert.equal(counts.built, 2);
  assert.equal(counts.deferred, 0);
  const shaped = publicScreenShape({ id: 7, name: 'X', purpose: null, sort: 3, status: 'queued', request_id: 42, error: null, updated_at: 't' });
  assert.deepEqual(shaped, { id: 7, name: 'X', purpose: null, sort: 3, status: 'queued', request_id: 42, error: null, updated_at: 't' });
  assert.equal(publicScreenShape(null), null);
});

test('production check instruction: readiness only, full battery, no features', () => {
  assert.match(PRODUCTION_CHECK_INSTRUCTION, /add NO new features/);
  assert.match(PRODUCTION_CHECK_INSTRUCTION, /acceptance/);
  assert.match(PRODUCTION_CHECK_INSTRUCTION, /first-admin bootstrap/);
});
