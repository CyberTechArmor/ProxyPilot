// The check service and the shared instance: one running check per target,
// results stored, the overview, policy reads and edits, check freshness for
// a cleanup, and the 503 stand-in until the cleanup service is wired.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createAppStorage, unavailableCleanupService } from '../lib/app-storage/index.js';
import { checkFreshness, CHECK_MAX_AGE_MS, RUNNING_CHECK_STALE_MS } from '../lib/app-storage/check-service.js';
import * as W from './helpers/app-storage-world.js';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const NOW = Date.parse('2026-10-20T23:00:00Z');
function bell() { const rows = []; return { rows, post: (n) => rows.push(n), resolve: () => false, list: () => rows.map((r) => ({ dedupe_key: r.dedupe_key, level: r.level, title: r.title })), dispatch: async () => {} }; }

function setup(t, { now = () => NOW } = {}) {
  const root = W.makeRoot(); t.after(() => W.cleanupRoot(root));
  const world = W.buildNodusGuest(root, NOW);
  const { mock2Db, mainDb } = W.databases();
  W.addDeployHistory(mock2Db, W.registerNodus(mock2Db, world), { now: NOW });
  mock2Db.prepare("INSERT INTO mock2_projects (id, name, container_name, lifecycle, repo_path, created_at) VALUES (4, 'Shop', 'm2-4', 'active', '/var/lib/proxypilot/mock2/repos/4.git', '2026-10-01 10:00:00')").run();
  const exec = W.scriptedExec({ prefix: root, snapshots: [{ name: 'snap0', created_at: '2026-10-18T10:00:00Z' }], snapshotUsed: { snap0: 4e7 } });
  const guests = new Map([['pp-nodus', { status: 'Running', usedBytes: 2956918784 }], ['m2-4', { status: 'Stopped', usedBytes: null }]]);
  guests.checkedAt = new Date(NOW).toISOString();
  const s = createAppStorage({ mock2Db, mainDb, exec, now, notifications: bell(), listGuests: async () => guests, logger: null });
  return { s, mock2Db, mainDb, root, exec };
}

test('one running check per target; the result is stored and readable; the overview lists every target', async (t) => {
  const { s } = setup(t);
  const a = s.requestCheck('application:1', { userId: 7 });
  assert.equal(a.status, 'running');
  assert.equal(a.reused, false);
  assert.match(a.checkId, /^chk_[a-f0-9-]{36}$/);
  const b = s.requestCheck('application:1', { userId: 8 });
  assert.deepEqual(b, { checkId: a.checkId, status: 'running', reused: true });
  assert.equal(s.getCheck(a.checkId).status, 'running');
  const done = await s.checks.waitForCheck(a.checkId);
  assert.equal(done.status, 'complete');
  assert.equal(done.target.key, 'application:1');
  assert.equal(done.origin, 'user');
  assert.equal(s.latestCheck('application:1').checkId, a.checkId);
  assert.equal(s.store.getCheck(a.checkId).requestedBy, '7');
  assert.throws(() => s.requestCheck('application:42'), (e) => e.code === 'TARGET_NOT_FOUND' && e.status === 404);
  assert.equal(s.getCheck('chk_not-a-real-id'), null);
  const o = await s.overview();
  assert.equal(o.checkedAt, new Date(NOW).toISOString());
  const nodus = o.targets.find((x) => x.key === 'application:1');
  assert.deepEqual([nodus.name, nodus.guest, nodus.guestStatus, nodus.usage.usedBytes], ['Nodus', 'pp-nodus', 'Running', 2956918784]);
  assert.equal(nodus.usage.source, 'incus-root-usage', 'the overview says which "used" it shows');
  assert.match(nodus.usage.label, /including its snapshots/);
  assert.equal(nodus.lastCheck.checkId, a.checkId);
  assert.ok(nodus.lastCheck.eligibleBytes > 0);
  assert.equal(nodus.runningCheckId, null);
  assert.deepEqual(nodus.policy, { source: 'preserved', enabledRules: ['releases', 'snapshots', 'workspaces'], proposedRules: ['caches', 'tempFiles', 'testArtifacts', 'logs', 'history'] });
  const shop = o.targets.find((x) => x.key === 'project:4');
  assert.deepEqual([shop.kind, shop.guestStatus, shop.usage, shop.lastCheck], ['project', 'Stopped', null, null]);
  assert.equal(shop.policy.source, 'defaults-existing');
});

test('a check left "running" by a restart is marked interrupted instead of blocking new checks', (t) => {
  let now = NOW;
  const { s } = setup(t, { now: () => now });
  s.store.insertCheck({ id: 'chk_11111111-1111-4111-8111-111111111111', targetKey: 'application:1', startedAt: NOW - RUNNING_CHECK_STALE_MS - 1000 });
  const r = s.requestCheck('application:1');
  assert.equal(r.reused, false);
  const old = s.getCheck('chk_11111111-1111-4111-8111-111111111111');
  assert.equal(old.status, 'failed');
  assert.equal(old.error.code, 'INTERRUPTED');
  assert.match(old.error.message, /interrupted/);
  now += 1;
});

test('check freshness for a cleanup: the latest finished check of the target, at most an hour old', async (t) => {
  let now = NOW;
  const { s } = setup(t, { now: () => now });
  const first = (await s.runCheck('application:1')).checkId;
  const row = s.store.getCheck(first);
  assert.equal(checkFreshness({ check: row, latest: s.store.latestCheck('application:1'), targetKey: 'application:1', now }), null);
  const other = checkFreshness({ check: row, latest: s.store.latestCheck('application:1'), targetKey: 'project:4', now });
  assert.deepEqual([other.code, other.status], ['CHECK_STALE', 409]);
  const missing = checkFreshness({ check: null, latest: null, targetKey: 'application:1', now });
  assert.equal(missing.code, 'CHECK_STALE');
  const late = checkFreshness({ check: row, latest: row, targetKey: 'application:1', now: now + CHECK_MAX_AGE_MS + 1000 });
  assert.match(late.message, /^Run a new storage check first; this one is from 2026-10-20 23:00 UTC\.$/);
  now += 60_000;
  await s.runCheck('application:1');
  const superseded = checkFreshness({ check: row, latest: s.store.latestCheck('application:1'), targetKey: 'application:1', now });
  assert.match(superseded.message, /a newer check exists/);
  assert.equal(checkFreshness({ check: { ...row, status: 'failed' }, latest: row, targetKey: 'application:1', now }).code, 'CHECK_STALE');
});

test('policy through the shared instance: defaults with their effects, a whole-document edit, its diff and revision', async (t) => {
  const { s } = setup(t);
  await s.runCheck('application:1');
  const p = s.getPolicy('application:1');
  assert.deepEqual([p.source, p.revision, p.stored, p.defaultsSource], ['preserved', 0, false, 'preserved']);
  assert.equal(p.effects.length, 8);
  assert.ok(p.effects.find((e) => e.rule === 'releases').items >= 1, 'the older sealed release would be removed');
  const next = JSON.parse(JSON.stringify(p.policy));
  next.rules.caches.enabled = true;
  const r = s.putPolicy('application:1', next, { userId: 7, expectedRevision: 0 });
  assert.deepEqual([r.revision, r.source], [1, 'edited']);
  assert.deepEqual(r.changed, { 'rules.caches.enabled': [false, true] });
  assert.equal(s.getPolicy('application:1').source, 'edited');
  assert.deepEqual(r.proposedRules, ['tempFiles', 'testArtifacts', 'logs', 'history']);
  assert.deepEqual(s.getPolicy('application:1').proposedRules, ['tempFiles', 'testArtifacts', 'logs', 'history'], 'editing one rule leaves the other proposals proposed');
  const off = JSON.parse(JSON.stringify(s.getPolicy('application:1').policy));
  off.rules.caches.enabled = false;
  s.putPolicy('application:1', off, { expectedRevision: 1 });
  assert.deepEqual(s.getPolicy('application:1').proposedRules, ['tempFiles', 'testArtifacts', 'logs', 'history'], 'a rule turned on and off again is Off, not proposed');
  next.rules.tempFiles.enabled = true;
  assert.throws(() => s.putPolicy('application:1', next, { expectedRevision: 1 }), (e) => e.code === 'POLICY_CHANGED' && e.status === 409);
  assert.throws(() => s.putPolicy('application:1', { version: 1 }, {}), (e) => e.code === 'INVALID_POLICY' && e.status === 400);
  assert.equal(s.effectiveReleaseRetention('nodus').keepReleases, 2);
  assert.deepEqual({ ...s.effectiveSnapshotLimits() }, { 'pp-nodus': 3 });
});

test('target detail and the cleanup stand-in', async (t) => {
  const { s } = setup(t);
  const check = await s.runCheck('application:1');
  const d = await s.targetDetail('application:1');
  assert.deepEqual(d.target, { key: 'application:1', kind: 'application', id: 1, name: 'Nodus', guest: 'pp-nodus', guestStatus: 'Running' });
  assert.equal(d.latestCheck.checkId, check.checkId);
  assert.equal(d.policy.source, 'preserved');
  assert.deepEqual(d.activity, []);
  const cleanup = s.cleanupService();
  assert.equal(cleanup.available, false);
  await assert.rejects(cleanup.requestCleanup({}), (e) => e.code === 'CLEANUP_UNAVAILABLE' && e.status === 503);
  assert.deepEqual(cleanup.listCleanups('application:1'), []);
  const wired = { available: true, requestCleanup: async () => ({ changed: false }), getCleanup: () => null, listCleanups: () => [] };
  s.setCleanupService(wired);
  assert.equal(s.cleanupService(), wired);
  assert.equal(unavailableCleanupService().getCleanup('x'), null);
  const old = check.items.find((it) => it.kind === 'release' && it.status === 'eligible');
  const est = s.estimateSelection(check.checkId, { items: [old.id] });
  assert.equal(est.count, 1);
  assert.equal(est.bytes, old.allocatedBytes);
});

test('the overview\'s "can be cleaned up" figure is disk only; memory-backed temp files are counted apart', async (t) => {
  const root = W.makeRoot(); t.after(() => W.cleanupRoot(root));
  mkdirSync(join(root, 'tmp'));
  if (spawnSync('mount', ['-t', 'tmpfs', '-o', 'size=64m', 'none', join(root, 'tmp')]).status !== 0) { t.skip('mounting a tmpfs is not permitted here'); return; }
  t.after(() => spawnSync('umount', [join(root, 'tmp')]));
  const world = W.buildNodusGuest(root, NOW);
  const { mock2Db, mainDb } = W.databases();
  W.registerNodus(mock2Db, world);
  const s = createAppStorage({ mock2Db, mainDb, exec: W.scriptedExec({ prefix: root }), now: () => NOW, notifications: bell(), listGuests: async () => new Map(), logger: null });
  const check = await s.runCheck('application:1');
  const temp = check.categories.find((c) => c.key === 'temp');
  const memTemp = check.items.filter((it) => it.category === 'temp' && it.memoryBacked);
  assert.ok(memTemp.length > 0, '/tmp is memory-backed in this fixture');
  assert.equal(temp.memoryBytes, memTemp.reduce((n, it) => n + it.allocatedBytes, 0));
  assert.equal(temp.allocatedBytes, check.items.filter((it) => it.category === 'temp' && !it.memoryBacked).reduce((n, it) => n + it.allocatedBytes, 0), 'only /var/tmp is on disk');
  assert.ok(temp.eligibleMemoryBytes > 0);
  const row = (await s.overview()).targets.find((x) => x.key === 'application:1');
  const diskEligible = check.items.filter((it) => it.status === 'eligible' && !it.memoryBacked && !['snapshots', 'exports'].includes(it.category)).reduce((n, it) => n + (it.kind === 'journal' ? it.recoverableBytes : it.allocatedBytes), 0);
  assert.equal(row.lastCheck.eligibleBytes, diskEligible);
  assert.equal(row.lastCheck.eligibleMemoryBytes, temp.eligibleMemoryBytes);
});

test('the overview and the policy limits read the stored summary, never a full check result', async (t) => {
  const { s, mock2Db } = setup(t);
  const done = await s.runCheck('application:1');
  const expected = (await s.overview()).targets.find((x) => x.key === 'application:1').lastCheck;
  // Count every read of a full result from here on.
  let fullReads = 0;
  const realPrepare = mock2Db.prepare.bind(mock2Db);
  const seen = (row) => { if (row && typeof row === 'object' && row.result_json != null) fullReads += 1; return row; };
  mock2Db.prepare = (sql) => {
    const st = realPrepare(sql);
    return new Proxy(st, { get(target, prop) {
      if (prop === 'get') return (...a) => seen(target.get(...a));
      if (prop === 'all') return (...a) => { const rows = target.all(...a); rows.forEach(seen); return rows; };
      const v = target[prop]; return typeof v === 'function' ? v.bind(target) : v;
    } });
  };
  t.after(() => { mock2Db.prepare = realPrepare; });
  const o = await s.overview();
  const nodus = o.targets.find((x) => x.key === 'application:1');
  assert.equal(fullReads, 0, 'no full result is read');
  assert.deepEqual(nodus.lastCheck, expected);
  assert.equal(nodus.lastCheck.checkId, done.checkId);
  assert.deepEqual(nodus.lastCheck.totals, done.totals);
  await s.monitor.runOnce();
  assert.equal(fullReads, 0, 'nor by the monitor');
});

test('a new Dev Studio project\'s defaults are stored and audited once, the first time its policy is read; earlier projects and applications are not', async (t) => {
  const root = W.makeRoot(); t.after(() => W.cleanupRoot(root));
  const { mock2Db, mainDb } = W.databases({ installedAt: '2026-10-20T22:00:00.000Z' });
  W.registerNodus(mock2Db, W.buildNodusGuest(root, NOW));
  mock2Db.prepare("INSERT INTO mock2_projects (id, name, container_name, lifecycle, repo_path, created_at) VALUES (4, 'Shop', 'm2-4', 'active', '/x/4.git', '2026-10-01 10:00:00')").run();
  mock2Db.prepare("INSERT INTO mock2_projects (id, name, container_name, lifecycle, repo_path, created_at) VALUES (7, 'Fresh', 'm2-7', 'active', '/x/7.git', '2026-10-20 22:30:00')").run();
  const audits = [];
  const s = createAppStorage({ mock2Db, mainDb, exec: W.scriptedExec({ prefix: root }), now: () => NOW, notifications: bell(), listGuests: async () => new Map(), logger: null, audit: (e) => audits.push(e) });
  assert.equal(s.store.getPolicy('project:7'), null, 'nothing is stored before the policy is first read');
  const p = s.getPolicy('project:7');
  assert.deepEqual([p.source, p.stored, p.revision], ['defaults-new', true, 1]);
  assert.deepEqual(p.proposedRules, []);
  const rulesOn = ['releases', 'snapshots', 'workspaces', 'caches', 'tempFiles', 'testArtifacts', 'logs', 'history'].filter((k) => p.policy.rules[k]?.enabled);
  assert.ok(rulesOn.length >= 6, 'the documented defaults are on');
  assert.deepEqual(audits, [{ action: 'STORAGE_POLICY_CHANGED', targetKey: 'project:7', detail: { origin: 'defaults-for-new-project', source: 'defaults-new', revision: 1, rulesOn: p.enabledRules, actor: 'backend' } }]);
  assert.deepEqual([...p.enabledRules].sort(), [...rulesOn].sort());
  // Read again, through every path: never recorded twice.
  s.getPolicy('project:7'); await s.overview(); s.effectiveSnapshotLimits(); s.policyFor(s.resolveTarget('project:7'));
  assert.equal(audits.length, 1);
  assert.equal(s.store.getPolicy('project:7').revision, 1);
  // An earlier project and a registered application start with proposals: nothing stored, nothing audited.
  assert.equal(s.store.getPolicy('project:4'), null);
  assert.equal(s.store.getPolicy('application:1'), null);
  assert.equal(s.getPolicy('project:4').source, 'defaults-existing');
  // A person's edit afterwards is an ordinary edit.
  const next = JSON.parse(JSON.stringify(p.policy)); next.rules.logs.enabled = false;
  const edited = s.putPolicy('project:7', next, { userId: 3, expectedRevision: 1 });
  assert.deepEqual([edited.source, edited.revision, edited.previousSource], ['edited', 2, 'defaults-new']);
  assert.equal(audits.length, 1, 'the route audits the edit itself');
});

test('the snapshot limits record a new project\'s defaults before they decide anything; the recorded alert level still follows the disk limit', async (t) => {
  const root = W.makeRoot(); t.after(() => W.cleanupRoot(root));
  const { mock2Db, mainDb } = W.databases({ installedAt: '2026-10-20T22:00:00.000Z' });
  mock2Db.prepare("INSERT INTO mock2_projects (id, name, container_name, lifecycle, repo_path, created_at) VALUES (8, 'Newer', 'm2-8', 'active', '/x/8.git', '2026-10-20 22:40:00')").run();
  const audits = [];
  const s = createAppStorage({ mock2Db, mainDb, exec: W.scriptedExec({ prefix: root }), now: () => NOW, notifications: bell(), listGuests: async () => new Map(), logger: null, audit: (e) => audits.push(e) });
  const limits = s.effectiveSnapshotLimits();
  assert.equal(audits.length, 1);
  assert.equal(audits[0].detail.origin, 'defaults-for-new-project');
  assert.equal(s.store.getPolicy('project:8').source, 'defaults-new');
  assert.ok(Number.isInteger(limits['m2-8']), 'the recorded snapshot rule decides');
  // The first check gives the disk limit: the untouched defaults' warning level follows it.
  s.store.insertCheck({ id: 'chk_00000000-0000-4000-8000-0000000000aa', targetKey: 'project:8' });
  s.store.finishCheck('chk_00000000-0000-4000-8000-0000000000aa', { status: 'complete', result: { totals: { limit: { bytes: 50e9 } }, categories: [] } });
  assert.equal(s.policyFor(s.resolveTarget('project:8')).policy.alerts.warnBytes, 40e9);
});

/* ---- re-review N3: whichever side resolves a new project's policy first records it ---- */

test('the host runner resolving a new project\'s snapshot limits first records its defaults once (user NULL, actor in details); the backend reading later adds no second audit', async (t) => {
  const { runnerAppStorage } = await import('../lib/app-storage/cleanup-deps.js');
  const { currentSnapshotLimits, setSnapshotLimitsProvider } = await import('../lib/snapshot-retention.js');
  const { effectiveSnapshotLimits } = await import('../lib/app-storage/policy.js');
  t.after(() => setSnapshotLimitsProvider(null));
  const { mock2Db, mainDb } = W.databases({ installedAt: '2026-10-20T22:00:00.000Z' });
  mainDb.exec('CREATE TABLE audit_log (id TEXT PRIMARY KEY, user_id TEXT, action TEXT NOT NULL, resource_type TEXT, resource_id TEXT, details TEXT, ip_address TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)');
  mock2Db.prepare("INSERT INTO mock2_projects (id, name, container_name, lifecycle, repo_path, created_at) VALUES (9, 'Brand new', 'm2-9', 'active', '/x/9.git', '2026-10-20 22:50:00')").run();
  // The runner, exactly as it installs its limits.
  const runner = runnerAppStorage({ mainDb, mock2DbPath: '/nonexistent/mock2.db', openDb: () => mock2Db });
  await runner.installSnapshotLimits();
  assert.equal(currentSnapshotLimits()['m2-9'], 3, 'the recorded default decides');
  const audits = () => mainDb.prepare('SELECT * FROM audit_log').all();
  assert.equal(audits().length, 1);
  const row = audits()[0];
  assert.deepEqual([row.user_id, row.action, row.resource_type, row.resource_id], [null, 'STORAGE_POLICY_CHANGED', 'app_storage', 'project:9']);
  const detail = JSON.parse(row.details);
  assert.deepEqual([detail.origin, detail.source, detail.revision, detail.actor], ['defaults-for-new-project', 'defaults-new', 1, 'host-runner']);
  assert.ok(detail.rulesOn.includes('snapshots'));
  assert.equal(s0(mock2Db).revision, 1);
  // The runner again: no second record.
  effectiveSnapshotLimits({ mock2Db, mainDb });
  assert.equal(audits().length, 1);
  // The backend later, through every path that resolves a policy: no second audit.
  const backendAudits = [];
  const s = createAppStorage({ mock2Db, mainDb, exec: { host: async () => ({ code: 1 }), guest: async () => ({ code: 1 }) }, now: () => NOW, notifications: bell(), listGuests: async () => new Map(), logger: null, audit: (e) => backendAudits.push(e) });
  const p = s.getPolicy('project:9');
  s.effectiveSnapshotLimits(); await s.overview(); await s.monitor.runOnce();
  assert.deepEqual([p.source, p.stored, p.revision], ['defaults-new', true, 1]);
  assert.equal(backendAudits.length, 0);
  assert.equal(audits().length, 1);
});

test('defaults are never stored without their audit: when the audit cannot be written nothing is recorded, and the next side records it once', async (t) => {
  const { effectiveSnapshotLimits, recordNewProjectDefaults } = await import('../lib/app-storage/policy.js');
  const { mock2Db, mainDb } = W.databases({ installedAt: '2026-10-20T22:00:00.000Z' });
  mock2Db.prepare("INSERT INTO mock2_projects (id, name, container_name, lifecycle, repo_path, created_at) VALUES (9, 'Brand new', 'm2-9', 'active', '/x/9.git', '2026-10-20 22:50:00')").run();
  // No audit_log table in this main DB: the runner's audit fails.
  const limits = effectiveSnapshotLimits({ mock2Db, mainDb });
  assert.equal(limits['m2-9'], 3, 'the defaults still apply');
  assert.equal(s0(mock2Db), null, 'but they are not stored without their audit');
  const audits = [];
  const target = { key: 'project:9', kind: 'project', id: 9, guest: 'm2-9', createdAt: '2026-10-20 22:50:00' };
  assert.equal(recordNewProjectDefaults(target, { mock2Db, audit: null }), null, 'no audit sink: nothing recorded');
  assert.ok(recordNewProjectDefaults(target, { mock2Db, audit: (e) => audits.push(e), actor: 'backend' }));
  assert.equal(recordNewProjectDefaults(target, { mock2Db, audit: (e) => audits.push(e), actor: 'backend' }), null, 'idempotent');
  assert.equal(audits.length, 1);
  assert.equal(recordNewProjectDefaults({ ...target, key: 'project:4', id: 4, createdAt: '2026-10-01 10:00:00' }, { mock2Db, audit: (e) => audits.push(e) }), null, 'an earlier project is never recorded');
});

function s0(mock2Db) { return mock2Db.prepare("SELECT revision, source FROM mock2_storage_policies WHERE target_key = 'project:9'").get() || null; }
