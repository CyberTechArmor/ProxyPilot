// Application storage store (mock2.db migration 560): the schema, the
// installed-at mark written once, and the retention that keeps the feature
// itself bounded (20 checks per target, 50 cleanups per target, 30 days of
// samples), the policy revisions and the lost-update guard.

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { MOCK2_MIGRATIONS } from '../mock2/migrations.js';
import { createStorageStore, readInstalledAt, INSTALLED_AT_SETTING, CHECKS_PER_TARGET, CLEANUPS_PER_TARGET, APP_STORAGE_SCHEMA } from '../lib/app-storage/store.js';

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE mock2_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT, updated_by INTEGER);');
  return db;
}
const m560 = MOCK2_MIGRATIONS.find((m) => m.version === 560);
const iso = (ms) => new Date(ms).toISOString();

test('migration 560 is the next mock2 migration and creates the four tables and the installed-at mark once', () => {
  assert.ok(m560, 'migration 560 is registered');
  assert.equal(m560.name, 'mock2_app_storage');
  assert.equal(MOCK2_MIGRATIONS.at(-1).version, 560);
  assert.equal(MOCK2_MIGRATIONS.at(-2).version, 559);
  const db = freshDb();
  m560.up(db);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'mock2_storage_%' ORDER BY name").all().map((r) => r.name);
  assert.deepEqual(tables, ['mock2_storage_checks', 'mock2_storage_cleanups', 'mock2_storage_policies', 'mock2_storage_samples']);
  const first = readInstalledAt(db);
  assert.match(first, /^\d{4}-\d\d-\d\dT/);
  db.prepare('UPDATE mock2_settings SET value = ? WHERE key = ?').run('2026-01-01T00:00:00.000Z', INSTALLED_AT_SETTING);
  m560.up(db); // idempotent DDL; the mark is never overwritten
  assert.equal(readInstalledAt(db), '2026-01-01T00:00:00.000Z');
  assert.match(APP_STORAGE_SCHEMA, /idx_mock2_storage_checks_target ON mock2_storage_checks\(target_key, started_at\)/);
});

test('checks: one row per request, finished once, the newest 20 per target kept (never the running one)', () => {
  const db = freshDb(); m560.up(db);
  let t = Date.parse('2026-10-20T00:00:00Z');
  const store = createStorageStore(db, { now: () => t });
  for (let i = 0; i < 25; i += 1) {
    t += 1000;
    store.insertCheck({ id: `chk_${i}`, targetKey: 'application:1', origin: 'user', requestedBy: 7 });
    assert.equal(store.finishCheck(`chk_${i}`, { status: i % 2 ? 'complete' : 'partial', result: { n: i } }), true);
    assert.equal(store.finishCheck(`chk_${i}`, { status: 'failed' }), false, 'a finished check is never finished again');
  }
  t += 1000;
  store.insertCheck({ id: 'chk_running', targetKey: 'application:1' });
  store.insertCheck({ id: 'chk_other', targetKey: 'project:3' });
  const rows = store.listChecks('application:1', { limit: 100 });
  assert.equal(rows.filter((r) => r.status !== 'running').length, CHECKS_PER_TARGET);
  assert.ok(rows.some((r) => r.id === 'chk_running'));
  assert.equal(store.getCheck('chk_0'), null, 'the oldest were pruned');
  assert.equal(store.latestCheck('application:1').id, 'chk_24');
  assert.deepEqual(store.latestCheck('application:1').result, { n: 24 });
  assert.equal(store.latestCheck('application:1', { statuses: ['partial'] }).id, 'chk_24');
  assert.equal(store.runningCheck('application:1').id, 'chk_running');
  assert.equal(store.runningCheck('application:1', { maxAgeMs: 500 }).id, 'chk_running');
  t += 1000;
  assert.equal(store.runningCheck('application:1', { maxAgeMs: 500 }), null, 'an old running row does not count');
  assert.equal(store.listRunningChecks().length, 2);
  assert.equal(store.getCheck('chk_other').targetKey, 'project:3');
  assert.throws(() => store.finishCheck('chk_running', { status: 'running' }), /invalid status/);
});

test('policies: revision + 1 on every save, lost updates refused with POLICY_CHANGED', () => {
  const db = freshDb(); m560.up(db);
  const store = createStorageStore(db);
  assert.equal(store.getPolicy('application:1'), null);
  const a = store.putPolicy('application:1', { policy: { version: 1, x: 1 }, source: 'edited', updatedBy: 7, expectedRevision: 0 });
  assert.equal(a.revision, 1);
  assert.equal(a.updatedBy, '7');
  const b = store.putPolicy('application:1', { policy: { version: 1, x: 2 }, expectedRevision: 1 });
  assert.equal(b.revision, 2);
  assert.deepEqual(b.policy, { version: 1, x: 2 });
  assert.throws(() => store.putPolicy('application:1', { policy: { version: 1 }, expectedRevision: 1 }), (e) => e.code === 'POLICY_CHANGED' && e.status === 409);
  assert.equal(store.putPolicy('application:1', { policy: { version: 1, x: 3 } }).revision, 3, 'no expected revision = last write wins');
  assert.equal(store.getPolicy('application:1').proposedRules, null);
  assert.deepEqual(store.putPolicy('application:1', { policy: { version: 1 }, proposedRules: ['logs', 'history'] }).proposedRules, ['logs', 'history'], 'the per-rule proposal marker is kept with the row');
  assert.equal(store.listPolicies().length, 1);
});

test('cleanups: created queued, updated in place, the newest 50 per target kept (never an open one)', () => {
  const db = freshDb(); m560.up(db);
  let t = Date.parse('2026-10-20T00:00:00Z');
  const store = createStorageStore(db, { now: () => t });
  const open = store.insertCleanup({ id: 'cln_open', targetKey: 'application:1', checkId: 'chk_1', selection: [{ id: 'a', label: 'x' }], scope: 'items', requestedBy: 7 });
  assert.equal(open.status, 'queued');
  assert.deepEqual(open.selection, [{ id: 'a', label: 'x' }]);
  for (let i = 0; i < 55; i += 1) {
    t += 1000;
    store.insertCleanup({ id: `cln_${i}`, targetKey: 'application:1', checkId: 'chk_1', selection: [], status: 'succeeded' });
  }
  const all = db.prepare("SELECT COUNT(*) AS n FROM mock2_storage_cleanups WHERE target_key = 'application:1'").get().n;
  assert.equal(all, CLEANUPS_PER_TARGET + 1, '50 finished plus the open one');
  assert.ok(store.getCleanup('cln_open'));
  assert.equal(store.getCleanup('cln_0'), null);
  assert.equal(store.updateCleanup('cln_open', { status: 'running', jobId: 'job-1' }), true);
  assert.equal(store.updateCleanup('cln_open', { status: 'partial', result: { removed: [] }, finishedAt: t }), true);
  const done = store.getCleanup('cln_open');
  assert.equal(done.status, 'partial');
  assert.equal(done.jobId, 'job-1');
  assert.deepEqual(done.result, { removed: [] });
  assert.throws(() => store.updateCleanup('cln_open', { status: 'bogus' }), /invalid status/);
  assert.equal(store.listCleanups('application:1', { limit: 10 }).length, 10);
});

test('samples: 30 days kept, newest first available, the window query is inclusive', () => {
  const db = freshDb(); m560.up(db);
  let t = Date.parse('2026-10-20T00:00:00Z');
  const store = createStorageStore(db, { now: () => t });
  store.addSample('application:1', 100, t - 40 * 86_400_000);
  store.addSample('application:1', 200, t - 10 * 86_400_000);
  store.addSample('application:1', 300, t);
  assert.equal(store.addSample('application:1', -5), false);
  const rows = store.samplesSince('application:1', 0);
  assert.deepEqual(rows.map((r) => r.usedBytes), [200, 300], 'a sample older than 30 days was pruned on insert');
  assert.deepEqual(store.latestSample('application:1'), { sampledAt: iso(t), usedBytes: 300 });
  assert.deepEqual(store.samplesSince('application:1', t).map((r) => r.usedBytes), [300]);
  t += 25 * 86_400_000;
  assert.deepEqual(store.prune(), { checks: 0, cleanups: 0, samples: 1 });
});
