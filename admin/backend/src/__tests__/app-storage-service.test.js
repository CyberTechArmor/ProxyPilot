// The check service and the shared instance: one running check per target,
// results stored, the overview, policy reads and edits, check freshness for
// a cleanup, and the 503 stand-in until the cleanup service is wired.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createAppStorage, unavailableCleanupService } from '../lib/app-storage/index.js';
import { checkFreshness, CHECK_MAX_AGE_MS, RUNNING_CHECK_STALE_MS } from '../lib/app-storage/check-service.js';
import * as W from './helpers/app-storage-world.js';

const NOW = Date.parse('2026-10-20T23:00:00Z');
function bell() { const rows = []; return { rows, post: (n) => rows.push(n), resolve: () => false, list: () => rows.map((r) => ({ dedupe_key: r.dedupe_key, level: r.level, title: r.title })), dispatch: async () => {} }; }

function setup(t, { now = () => NOW } = {}) {
  const root = W.makeRoot(); t.after(() => W.cleanupRoot(root));
  const world = W.buildNodusGuest(root, NOW);
  const { mock2Db, mainDb } = W.databases();
  W.registerNodus(mock2Db, world);
  mock2Db.prepare("INSERT INTO mock2_projects (id, name, container_name, lifecycle, repo_path, created_at) VALUES (4, 'Shop', 'm2-4', 'active', '/var/lib/proxypilot/mock2/repos/4.git', '2026-10-01 10:00:00')").run();
  const exec = W.scriptedExec({ prefix: root, snapshots: [{ name: 'snap0', created_at: '2026-10-18T10:00:00Z' }], snapshotUsed: { snap0: 4e7 } });
  const guests = new Map([['pp-nodus', { status: 'running', usedBytes: 2956918784 }], ['m2-4', { status: 'stopped', usedBytes: null }]]);
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
  assert.deepEqual([nodus.name, nodus.guest, nodus.guestStatus, nodus.usage.usedBytes], ['Nodus', 'pp-nodus', 'running', 2956918784]);
  assert.equal(nodus.lastCheck.checkId, a.checkId);
  assert.ok(nodus.lastCheck.eligibleBytes > 0);
  assert.equal(nodus.runningCheckId, null);
  assert.deepEqual(nodus.policy, { source: 'preserved', enabledRules: ['releases', 'snapshots', 'workspaces'], proposedRules: ['caches', 'tempFiles', 'testArtifacts', 'logs', 'history'] });
  const shop = o.targets.find((x) => x.key === 'project:4');
  assert.deepEqual([shop.kind, shop.guestStatus, shop.usage, shop.lastCheck], ['project', 'stopped', null, null]);
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
  assert.deepEqual(s.getPolicy('application:1').proposedRules, [], 'an edited policy has no proposals, only rules on or off');
  assert.throws(() => s.putPolicy('application:1', next, { expectedRevision: 0 }), (e) => e.code === 'POLICY_CHANGED' && e.status === 409);
  assert.throws(() => s.putPolicy('application:1', { version: 1 }, {}), (e) => e.code === 'INVALID_POLICY' && e.status === 400);
  assert.equal(s.effectiveReleaseRetention('nodus').keepReleases, 2);
  assert.deepEqual({ ...s.effectiveSnapshotLimits() }, { 'pp-nodus': 3 });
});

test('target detail and the cleanup stand-in', async (t) => {
  const { s } = setup(t);
  const check = await s.runCheck('application:1');
  const d = s.targetDetail('application:1');
  assert.deepEqual(d.target, { key: 'application:1', kind: 'application', id: 1, name: 'Nodus', guest: 'pp-nodus' });
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
