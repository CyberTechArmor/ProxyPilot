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
const m561 = MOCK2_MIGRATIONS.find((m) => m.version === 561);
const migrate = (db) => { m560.up(db); m561.up(db); return db; };
const iso = (ms) => new Date(ms).toISOString();

test('migration 560 is the next mock2 migration and creates the four tables and the installed-at mark once', () => {
  assert.ok(m560, 'migration 560 is registered');
  assert.equal(m560.name, 'mock2_app_storage');
  // 559 → 560 → 561 in order; later features append after them (562 mock2_tasks).
  const i560 = MOCK2_MIGRATIONS.indexOf(m560);
  assert.equal(MOCK2_MIGRATIONS[i560 + 1].version, 561);
  assert.equal(MOCK2_MIGRATIONS[i560 - 1].version, 559);
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
  const db = migrate(freshDb());
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
  const db = migrate(freshDb());
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
  const db = migrate(freshDb());
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
  const db = migrate(freshDb());
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

/* ------------------------- migrations 560/561 and the summary ------------------------- */

const columnsOf = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => `${c.name} ${c.type}${c.notnull ? ' NOT NULL' : ''}${c.pk ? ' PK' : ''}`);
const indexesOf = (db) => db.prepare("SELECT name, tbl_name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_mock2_storage_%' ORDER BY name").all().map((r) => `${r.tbl_name}.${r.name}`);

test('migration 560 carries its own DDL (never the store module), and 560 + 561 give exactly the current schema', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../mock2/migrations.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /from '\.\.\/lib\/app-storage\/store\.js'/, 'migrations.js does not import the store');
  assert.doesNotMatch(src, /APP_STORAGE_SCHEMA|INSTALLED_AT_SETTING/);
  const viaMigrations = migrate(freshDb());
  const viaSchema = freshDb(); viaSchema.exec(APP_STORAGE_SCHEMA);
  for (const table of ['mock2_storage_checks', 'mock2_storage_policies', 'mock2_storage_cleanups', 'mock2_storage_samples']) {
    assert.deepEqual(columnsOf(viaMigrations, table), columnsOf(viaSchema, table), table);
  }
  assert.deepEqual(indexesOf(viaMigrations), indexesOf(viaSchema));
  assert.ok(columnsOf(viaMigrations, 'mock2_storage_checks').includes('summary_json TEXT'));
  // 561 is additive and safe to run again; 560 alone (an install from before 561) gains the column.
  const older = freshDb(); m560.up(older);
  assert.equal(columnsOf(older, 'mock2_storage_checks').some((c) => c.startsWith('summary_json')), false);
  m561.up(older); m561.up(older);
  assert.ok(columnsOf(older, 'mock2_storage_checks').includes('summary_json TEXT'));
  assert.equal(readInstalledAt(older) != null, true);
});

test('a finished check stores a small summary beside its result; the latest summary is read without the full result', () => {
  const db = migrate(freshDb());
  let t = Date.parse('2026-10-20T00:00:00Z');
  const store = createStorageStore(db, { now: () => t });
  const result = { totals: { limit: { bytes: 20e9 }, guest: { usedBytes: 5e9 } }, categories: [{ key: 'temp', eligibleBytes: 100, eligibleMemoryBytes: 40 }, { key: 'caches', eligibleBytes: 50 }, { key: 'snapshots', eligibleBytes: 9e9 }, { key: 'exports', eligibleBytes: 7e9 }], items: Array.from({ length: 50 }, (_, i) => ({ id: String(i) })) };
  store.insertCheck({ id: 'chk_a', targetKey: 'application:1' });
  store.finishCheck('chk_a', { status: 'complete', result });
  const row = db.prepare("SELECT summary_json FROM mock2_storage_checks WHERE id = 'chk_a'").get();
  assert.deepEqual(JSON.parse(row.summary_json), { totals: result.totals, eligibleBytes: 150, eligibleMemoryBytes: 40 }, 'snapshots and exports are separate selections');
  const s = store.latestCheckSummary('application:1');
  assert.equal(s.id, 'chk_a');
  assert.equal('result' in s, false, 'the full result is not read');
  assert.deepEqual(s.summary.totals.limit, { bytes: 20e9 });
  // A row from before migration 561 is summarised once from its result, then stored.
  t += 1000;
  store.insertCheck({ id: 'chk_b', targetKey: 'application:1' });
  db.prepare("UPDATE mock2_storage_checks SET status = 'partial', finished_at = ?, result_json = ? WHERE id = 'chk_b'").run(iso(t), JSON.stringify(result));
  assert.equal(store.latestCheckSummary('application:1').summary.eligibleBytes, 150);
  assert.notEqual(db.prepare("SELECT summary_json FROM mock2_storage_checks WHERE id = 'chk_b'").get().summary_json, null);
  assert.equal(store.latestCheckSummary('project:9'), null);
});

test('dropGoneTargets: checks and samples of targets not listed now go (never a running check); cleanups and the policy go only when the record is gone', () => {
  const db = migrate(freshDb());
  const t = Date.parse('2026-10-20T00:00:00Z');
  const store = createStorageStore(db, { now: () => t });
  for (const key of ['application:1', 'project:4', 'project:5', 'project:9']) {
    store.insertCheck({ id: `chk_${key}`, targetKey: key }); store.finishCheck(`chk_${key}`, { status: 'complete', result: { n: 1 } });
    store.addSample(key, 100, t);
    store.insertCleanup({ id: `cln_${key}`, targetKey: key, checkId: `chk_${key}`, selection: [], status: 'succeeded' });
    store.putPolicy(key, { policy: { version: 1 } });
  }
  store.insertCheck({ id: 'chk_running9', targetKey: 'project:9' });
  store.insertCleanup({ id: 'cln_open9', targetKey: 'project:9', checkId: 'chk_project:9', selection: [] });
  // project:5 is archived (record kept, not listed); project:9 was deleted.
  const r = store.dropGoneTargets({ live: new Set(['application:1', 'project:4']), known: new Set(['application:1', 'project:4', 'project:5']) });
  assert.deepEqual(r, { checks: 2, samples: 2, cleanups: 1, policies: 1 });
  assert.ok(store.getCheck('chk_application:1') && store.getCheck('chk_project:4'));
  assert.equal(store.getCheck('chk_project:5'), null);
  assert.ok(store.getCheck('chk_running9'), 'a running check is never dropped');
  assert.ok(store.getPolicy('project:5'), 'an archived project keeps its rules');
  assert.ok(store.getCleanup('cln_project:5'));
  assert.equal(store.getPolicy('project:9'), null);
  assert.equal(store.getCleanup('cln_project:9'), null);
  assert.ok(store.getCleanup('cln_open9'), 'an open cleanup is never dropped');
  assert.deepEqual(store.dropGoneTargets({ live: new Set() }), { checks: 0, samples: 0, cleanups: 0, policies: 0 }, 'both sets are required');
});
