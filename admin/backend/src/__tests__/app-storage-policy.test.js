// Retention policies: the document and its validation, the defaults for new
// targets, existing targets (every destructive rule a proposal) and Nodus
// (its existing settings preserved), the effective release and snapshot
// retention the existing mechanisms read (a stored policy decides, a rule
// turned off runs nothing; the static JSON applies only without a stored
// policy or without a readable mock2.db; a proposal never takes effect), and
// the two pure views over a check.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_POLICY, RULE_KEYS, validatePolicy, defaultPolicyFor, resolvePolicy, effectiveReleaseRetention, effectiveSnapshotLimits,
  policySelection, policyEffects, policyDiff, ruleStates, proposedAfterEdit, isNewTarget, STATIC_RELEASE_RETENTION, STATIC_SNAPSHOT_RETENTION, NEW_TRIM_BEFORE_SEAL,
} from '../lib/app-storage/policy.js';
import { createStorageStore } from '../lib/app-storage/store.js';
import { databases, registerNodus } from './helpers/app-storage-world.js';
import { startSnapshotRetention } from '../lib/snapshot-retention.js';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

const NOW = Date.parse('2026-10-20T23:00:00Z');
const DAY = 86_400_000;
const INSTALLED = '2026-10-20T22:00:00.000Z';
const nodus = { key: 'application:1', kind: 'application', id: 1, targetId: 'nodus', guest: 'pp-nodus', createdAt: '2026-09-27T10:00:00.000Z' };
const oldApp = { key: 'application:2', kind: 'application', id: 2, targetId: 'legacy', guest: 'pp-legacy', createdAt: '2026-08-01T10:00:00.000Z' };
const newApp = { key: 'application:3', kind: 'application', id: 3, targetId: 'fresh', guest: 'pp-fresh', createdAt: '2026-10-21T08:00:00.000Z' };
const newProject = { key: 'project:9', kind: 'project', id: 9, guest: 'm2-9', createdAt: '2026-10-21 08:00:00' };
const clone = (o) => JSON.parse(JSON.stringify(o));

test('the static files are what Nodus runs with today', () => {
  assert.deepEqual({ ...STATIC_RELEASE_RETENTION }, { nodus: { keepReleases: 2, trimBuildCache: true } });
  assert.deepEqual({ ...STATIC_SNAPSHOT_RETENTION }, { 'pp-nodus': 3 });
  assert.ok(Object.isFrozen(DEFAULT_POLICY) && Object.isFrozen(DEFAULT_POLICY.rules.releases));
  assert.deepEqual(RULE_KEYS, ['releases', 'snapshots', 'workspaces', 'caches', 'tempFiles', 'testArtifacts', 'logs', 'history']);
  assert.deepEqual(DEFAULT_POLICY.alerts, { enabled: true, warnBytes: 20e9, growthBytes: 2e9, growthWindowHours: 24 });
});

test('Nodus is preserved: 2 releases with the .cache trim, 3 snapshots, workspaces on, alerts at 10 GB / 2 GB per 24 h, the rest proposed', () => {
  const { policy, source } = defaultPolicyFor(nodus, { installedAt: INSTALLED });
  assert.equal(source, 'preserved');
  assert.deepEqual(policy.rules.releases, { enabled: true, keepReleases: 2, trimBeforeSeal: ['.cache'] });
  assert.deepEqual(policy.rules.snapshots, { enabled: true, keep: 3 });
  assert.equal(policy.rules.workspaces.enabled, true);
  for (const k of ['caches', 'tempFiles', 'testArtifacts', 'logs', 'history']) assert.equal(policy.rules[k].enabled, false, `${k} is a proposal`);
  assert.deepEqual(policy.alerts, { enabled: true, warnBytes: 10e9, growthBytes: 2e9, growthWindowHours: 24 });
  assert.deepEqual(ruleStates(policy, source), { enabledRules: ['releases', 'snapshots', 'workspaces'], proposedRules: ['caches', 'tempFiles', 'testArtifacts', 'logs', 'history'] });
  assert.doesNotThrow(() => validatePolicy(policy));
});

test('existing targets get every destructive rule as a proposal; only new Dev Studio projects get every rule on', () => {
  const existing = defaultPolicyFor(oldApp, { installedAt: INSTALLED, diskLimitBytes: 50e9 });
  assert.equal(existing.source, 'defaults-existing');
  assert.ok(RULE_KEYS.every((k) => existing.policy.rules[k].enabled === false));
  assert.equal(existing.policy.alerts.enabled, true, 'alerts only notify, so they are on');
  assert.equal(existing.policy.alerts.warnBytes, 40e9, '80 % of a known disk limit');
  const fresh = defaultPolicyFor(newProject, { installedAt: INSTALLED });
  assert.equal(fresh.source, 'defaults-new', 'SQLite datetime text is read as UTC');
  assert.ok(RULE_KEYS.every((k) => fresh.policy.rules[k].enabled === true));
  assert.deepEqual(fresh.policy.rules.releases.trimBeforeSeal, [...NEW_TRIM_BEFORE_SEAL]);
  assert.equal(fresh.policy.alerts.warnBytes, 20e9, '20 GB when the limit is unknown');
  assert.equal(defaultPolicyFor({ ...newProject, createdAt: null }, { installedAt: INSTALLED }).source, 'defaults-existing', 'unknown age counts as existing');
  assert.equal(defaultPolicyFor(newProject, { installedAt: null }).source, 'defaults-existing', 'without the install mark nothing is new');
  assert.equal(isNewTarget(newApp, INSTALLED), true);
  const registered = defaultPolicyFor(newApp, { installedAt: INSTALLED });
  assert.equal(registered.source, 'defaults-existing', 'a registered application always starts with proposals, however recently it was registered');
  assert.ok(RULE_KEYS.every((k) => registered.policy.rules[k].enabled === false));
  assert.deepEqual(ruleStates(registered.policy, registered.source).proposedRules, RULE_KEYS);
  assert.equal(defaultPolicyFor({ key: 'project:2', kind: 'project', guest: 'pp-nodus' }, { installedAt: INSTALLED }).policy.rules.snapshots.keep, 3, 'a guest in the snapshot file is preserved too');
});

test('validation: whole documents only, safe ranges, no arbitrary trim paths', () => {
  const ok = validatePolicy(clone(DEFAULT_POLICY));
  assert.deepEqual(ok, clone(DEFAULT_POLICY));
  const bad = (mut, re) => { const p = clone(DEFAULT_POLICY); mut(p); assert.throws(() => validatePolicy(p), (e) => e.code === 'INVALID_POLICY' && e.status === 400 && re.test(e.message)); };
  bad((p) => { p.rules.releases.keepReleases = 1; }, /rules\.releases\.keepReleases/);
  bad((p) => { p.rules.releases.trimBeforeSeal = ['../etc']; }, /trimBeforeSeal/);
  bad((p) => { p.rules.releases.trimBeforeSeal = ['.cache', '.cache']; }, /twice/);
  bad((p) => { p.rules.snapshots.keep = 0; }, /snapshots\.keep/);
  bad((p) => { p.rules.caches.command = 'rm -rf /'; }, /Unrecognized key/);
  bad((p) => { delete p.rules.logs; }, /rules\.logs/);
  bad((p) => { p.alerts.warnBytes = 5; }, /alerts\.warnBytes/);
  bad((p) => { p.version = 2; }, /version/);
  assert.throws(() => validatePolicy(null), (e) => e.code === 'INVALID_POLICY');
});

test('resolvePolicy: a stored valid row wins; an invalid stored row falls back to the defaults and says so', () => {
  const { mock2Db } = databases();
  const store = createStorageStore(mock2Db);
  assert.equal(resolvePolicy(nodus, { store, installedAt: INSTALLED }).source, 'preserved');
  assert.equal(resolvePolicy(nodus, { store, installedAt: INSTALLED }).stored, false);
  const edited = clone(DEFAULT_POLICY); edited.rules.caches.maxAgeDays = 3;
  store.putPolicy(nodus.key, { policy: edited, source: 'edited' });
  const r = resolvePolicy(nodus, { store, installedAt: INSTALLED });
  assert.deepEqual([r.source, r.revision, r.stored, r.policy.rules.caches.maxAgeDays], ['edited', 1, true, 3]);
  store.putPolicy(oldApp.key, { policy: { version: 1, nonsense: true }, source: 'edited' });
  const broken = resolvePolicy(oldApp, { store, installedAt: INSTALLED });
  assert.equal(broken.invalidStored, true);
  assert.equal(broken.source, 'defaults-existing');
});

test('effective release retention: a stored policy decides (off is off); the static entry only without one or without a readable DB', () => {
  const { mock2Db } = databases({ installedAt: INSTALLED });
  registerNodus(mock2Db, null);
  registerNodus(mock2Db, null, { targetId: 'legacy', name: 'Legacy', createdAt: '2026-08-01T10:00:00.000Z' });
  registerNodus(mock2Db, null, { targetId: 'fresh', name: 'Fresh', createdAt: '2026-10-21T08:00:00.000Z' });
  const store = createStorageStore(mock2Db);
  const STATIC = { keepReleases: 2, trimBeforeSeal: ['.cache'], workspaces: { enabled: true, abandonedAfterHours: 1 }, source: 'static' };
  assert.deepEqual(effectiveReleaseRetention('nodus', { mock2Db }), STATIC, 'no stored policy yet: the static file (Nodus\'s seed)');
  assert.equal(effectiveReleaseRetention('legacy', { mock2Db }), null, 'an existing target\'s proposal does nothing');
  assert.equal(effectiveReleaseRetention('fresh', { mock2Db }), null, 'an application registered after installation starts with proposals too');
  // Saving Nodus's preserved settings as they are: the policy decides, same numbers.
  store.putPolicy('application:1', { policy: clone(defaultPolicyFor(nodus, { installedAt: INSTALLED }).policy) });
  assert.deepEqual(effectiveReleaseRetention('nodus', { mock2Db }), { ...STATIC, source: 'policy' });
  // Turning Nodus's rule off really stops it: nothing runs, the static file does not come back.
  const off = clone(defaultPolicyFor(nodus, { installedAt: INSTALLED }).policy); off.rules.releases.enabled = false;
  store.putPolicy('application:1', { policy: off });
  assert.equal(effectiveReleaseRetention('nodus', { mock2Db }), null);
  // Turning the legacy proposal on makes it effective, with the edited numbers.
  const on = clone(defaultPolicyFor(oldApp, { installedAt: INSTALLED }).policy); on.rules.releases = { enabled: true, keepReleases: 4, trimBeforeSeal: [] }; on.rules.workspaces.enabled = false;
  store.putPolicy('application:2', { policy: on });
  assert.deepEqual(effectiveReleaseRetention('legacy', { mock2Db }), { keepReleases: 4, trimBeforeSeal: [], workspaces: { enabled: false, abandonedAfterHours: 1 }, source: 'policy' });
  // Without mock2.db, or when it cannot be read, the static file decides (fail-safe).
  assert.deepEqual(effectiveReleaseRetention('nodus', {}), STATIC);
  const unreadable = { prepare() { throw new Error('SQLITE_CANTOPEN'); } };
  assert.deepEqual(effectiveReleaseRetention('nodus', { mock2Db: unreadable }), STATIC);
  assert.equal(effectiveReleaseRetention('legacy', { mock2Db: unreadable }), null);
  assert.equal(effectiveReleaseRetention('unknown', { mock2Db }), null);
  // A stored row that does not validate counts as no stored policy.
  mock2Db.prepare("UPDATE mock2_storage_policies SET policy_json = '{\"version\":1}' WHERE target_key = 'application:1'").run();
  assert.deepEqual(effectiveReleaseRetention('nodus', { mock2Db }), STATIC);
});

test('effective snapshot limits: a stored policy decides (off is off); defaults otherwise; the static file without a readable DB', () => {
  const { mock2Db } = databases({ installedAt: INSTALLED });
  registerNodus(mock2Db, null);
  registerNodus(mock2Db, null, { targetId: 'legacy', name: 'Legacy', createdAt: '2026-08-01T10:00:00.000Z' });
  registerNodus(mock2Db, null, { targetId: 'crm', name: 'Legacy CRM', createdAt: '2026-10-21T08:00:00.000Z' });
  mock2Db.prepare("INSERT INTO mock2_projects (id, name, container_name, lifecycle, repo_path, created_at) VALUES (9, 'Fresh', 'm2-9', 'active', '/x/9.git', '2026-10-21 08:00:00')").run();
  assert.deepEqual({ ...effectiveSnapshotLimits({ mock2Db }) }, { 'pp-nodus': 3, 'm2-9': 3 }, 'an application registered after installation is not limited');
  const store = createStorageStore(mock2Db);
  const on = clone(defaultPolicyFor(oldApp, { installedAt: INSTALLED }).policy); on.rules.snapshots = { enabled: true, keep: 5 };
  store.putPolicy('application:2', { policy: on });
  const off = clone(defaultPolicyFor(nodus, { installedAt: INSTALLED }).policy); off.rules.snapshots.enabled = false;
  store.putPolicy('application:1', { policy: off });
  assert.deepEqual({ ...effectiveSnapshotLimits({ mock2Db }) }, { 'pp-legacy': 5, 'm2-9': 3 }, 'Nodus turned off is not limited any more');
  assert.deepEqual({ ...effectiveSnapshotLimits({ mock2Db, staticLimits: { 'pp-nodus': 3, 'pp-other': 4 } }) }, { 'pp-legacy': 5, 'm2-9': 3, 'pp-other': 4 }, 'a static guest that is no target still applies');
  assert.deepEqual({ ...effectiveSnapshotLimits({}) }, { 'pp-nodus': 3 });
  assert.deepEqual({ ...effectiveSnapshotLimits({ mock2Db: { prepare() { throw new Error('locked'); } } }) }, { 'pp-nodus': 3 }, 'unreadable mock2.db: the static file');
  mock2Db.exec('DROP TABLE mock2_storage_policies');
  assert.deepEqual({ ...effectiveSnapshotLimits({ mock2Db }) }, { 'pp-nodus': 3 }, 'no policy table: the static file');
  assert.ok(Object.isFrozen(effectiveSnapshotLimits({ mock2Db })));
});

test('the boot reconcile prunes nothing for a newly registered application, and stops pruning Nodus once its rule is off', async () => {
  const { mock2Db } = databases({ installedAt: INSTALLED });
  registerNodus(mock2Db, null);
  registerNodus(mock2Db, null, { targetId: 'crm', name: 'Legacy CRM', createdAt: '2026-10-21T08:00:00.000Z' });
  const snaps = (n) => Array.from({ length: n }, (_, i) => ({ name: `s${i}`, created_at: `2026-10-0${i + 1}T00:00:00Z` }));
  const inventory = { 'pp-nodus': snaps(5), 'pp-crm': snaps(5) };
  const deleted = [];
  const run = async () => {
    const monitor = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill() {} });
    const stop = startSnapshotRetention({
      spawnMonitor: () => monitor,
      listInstance: async (name) => ({ name, snapshots: inventory[name] }),
      deleteSnapshot: async (name, snap) => { deleted.push(`${name}/${snap.name}`); inventory[name] = inventory[name].filter((x) => x.name !== snap.name); return { ok: true }; },
      limits: () => effectiveSnapshotLimits({ mock2Db }), log: () => {}, schedule: () => null, cancel: () => {},
    });
    stop.reconcile();
    await new Promise((r) => setTimeout(r, 50));
    stop();
  };
  await run();
  assert.deepEqual(deleted, ['pp-nodus/s0', 'pp-nodus/s1'], 'Nodus keeps its 3; the registered application is untouched');
  const off = clone(defaultPolicyFor(nodus, { installedAt: INSTALLED }).policy); off.rules.snapshots.enabled = false;
  createStorageStore(mock2Db).putPolicy('application:1', { policy: off });
  inventory['pp-nodus'] = snaps(5);
  deleted.length = 0;
  await run();
  assert.deepEqual(deleted, [], 'turned off: nothing is pruned');
});

const it = (o) => ({ id: o.id, label: o.id, category: 'temp', status: 'eligible', kind: 'directory', allocatedBytes: 10, newestMtimeMs: NOW - 30 * DAY, ...o });
const check = { items: [
  it({ id: 'tmp-old', category: 'temp', newestMtimeMs: NOW - 3 * DAY }),
  it({ id: 'tmp-young', category: 'temp', newestMtimeMs: NOW - 1.5 * DAY }),
  it({ id: 'cache', category: 'caches', newestMtimeMs: NOW - 20 * DAY }),
  it({ id: 'cache-new', category: 'caches', newestMtimeMs: NOW - 2 * DAY }),
  it({ id: 'ws', category: 'workspaces', newestMtimeMs: NOW - 2 * 3_600_000 }),
  it({ id: 'bundle', category: 'archives', newestMtimeMs: NOW - 2 * 3_600_000 }),
  it({ id: 'rotated', category: 'logs', newestMtimeMs: NOW - 15 * DAY }),
  it({ id: 'journal', category: 'logs', kind: 'journal', recoverableBytes: 500, allocatedBytes: 900 }),
  it({ id: 'hist-2', category: 'history', rank: 2, newestMtimeMs: NOW - 40 * DAY }),
  it({ id: 'hist-3', category: 'history', rank: 3, newestMtimeMs: NOW - 40 * DAY }),
  it({ id: 'hist-young', category: 'history', rank: 4, newestMtimeMs: NOW - 5 * DAY }),
  it({ id: 'report', category: 'test_reports', newestMtimeMs: NOW - 20 * DAY }),
  it({ id: 'protected-old', category: 'temp', status: 'protected' }),
  it({ id: 'old-release', category: 'releases', kind: 'release', sub: 'sealed', identity: { mtimeMs: NOW - 9 * DAY } }),
  it({ id: 'snap-a', category: 'snapshots', kind: 'snapshot', allocatedBytes: 7, identity: { createdAt: '2026-10-01T00:00:00Z' } }),
  it({ id: 'snap-b', category: 'snapshots', kind: 'snapshot', allocatedBytes: 8, identity: { createdAt: '2026-10-02T00:00:00Z' } }),
  it({ id: 'export', category: 'exports', kind: 'export' }),
] };

test('policySelection: only enabled rules, only eligible items that meet the rule\'s age; never snapshots, exports or releases', () => {
  const all = clone(DEFAULT_POLICY);
  all.rules.history.keepNewest = 3;
  const sel = policySelection(check, all, NOW);
  assert.deepEqual(sel.items.sort(), ['bundle', 'cache', 'hist-3', 'journal', 'report', 'rotated', 'tmp-old', 'ws'].sort());
  assert.deepEqual(sel.snapshots, []);
  assert.deepEqual(sel.exports, []);
  assert.equal(sel.byRule.logs.bytes, 10 + 500, 'a journal counts what it frees');
  assert.equal(sel.count, 8);
  const proposals = defaultPolicyFor(oldApp, { installedAt: INSTALLED }).policy;
  assert.deepEqual(policySelection(check, proposals, NOW).items, [], 'proposed rules select nothing');
  const strict = clone(DEFAULT_POLICY); strict.rules.workspaces.abandonedAfterHours = 3;
  assert.equal(policySelection(check, strict, NOW).items.includes('ws'), false);
  assert.deepEqual(policySelection(null, all, NOW).items, []);
});

test('policyEffects: what each rule (on or proposed) would do now', () => {
  const p = clone(defaultPolicyFor(oldApp, { installedAt: INSTALLED }).policy);
  p.rules.snapshots.keep = 1;
  const releasesCheck = { items: [...check.items, it({ id: 'live', category: 'running_app', kind: 'release', sub: 'live' }), it({ id: 'rb', category: 'releases', kind: 'release', sub: 'rollback', status: 'protected' }), it({ id: 'older', category: 'releases', kind: 'release', sub: 'sealed', identity: { mtimeMs: NOW - 20 * DAY } })] };
  const fx = Object.fromEntries(policyEffects(releasesCheck, p, NOW).map((e) => [e.rule, e]));
  assert.deepEqual(Object.keys(fx), RULE_KEYS);
  assert.equal(fx.snapshots.enabled, false);
  assert.deepEqual([fx.snapshots.items, fx.snapshots.bytes, fx.snapshots.examples], [1, 7, ['snap-a']]);
  assert.equal(fx.snapshots.note, 'Would delete the oldest 1, keeping the newest 1.');
  assert.deepEqual([fx.releases.items, fx.releases.examples], [2, ['old-release', 'older']]);
  assert.match(fx.releases.note, /Keeps the live release, the rollback release and any waiting candidate; would remove 2 older releases\./);
  assert.equal(fx.caches.items, 1);
  assert.match(fx.caches.note, /^Would remove 1 item, about 10 B, now\.$/);
  assert.equal(fx.tempFiles.items, 1);
  assert.equal(policyEffects(null, p, NOW)[0].note, 'Run a storage check to see what this rule would do.');
});

test('proposals: a stored list survives edits of other rules; turning a rule on ends its proposal', () => {
  const { policy } = defaultPolicyFor(oldApp, { installedAt: INSTALLED });
  assert.deepEqual(ruleStates(policy, 'defaults-existing').proposedRules, RULE_KEYS);
  assert.deepEqual(ruleStates(policy, 'defaults-new').proposedRules, []);
  const edited = clone(policy); edited.rules.caches.enabled = true;
  const left = proposedAfterEdit(RULE_KEYS, edited);
  assert.deepEqual(left, RULE_KEYS.filter((k) => k !== 'caches'));
  assert.deepEqual(ruleStates(edited, 'edited', left), { enabledRules: ['caches'], proposedRules: left });
  edited.rules.caches.enabled = false;
  assert.equal(ruleStates(edited, 'edited', proposedAfterEdit(left, edited)).proposedRules.includes('caches'), false, 'turned on then off reads Off');
  assert.deepEqual(ruleStates(edited, 'edited', null).proposedRules, [], 'an edited row without a list has no proposals');
});

test('policyDiff names exactly what changed (for the audit)', () => {
  const a = clone(DEFAULT_POLICY); const b = clone(DEFAULT_POLICY);
  b.rules.caches.enabled = false; b.rules.releases.trimBeforeSeal = ['.cache', 'coverage']; b.alerts.warnBytes = 11e9;
  assert.deepEqual(policyDiff(a, b), { 'rules.releases.trimBeforeSeal': [['.cache'], ['.cache', 'coverage']], 'rules.caches.enabled': [true, false], 'alerts.warnBytes': [20e9, 11e9] });
  assert.deepEqual(policyDiff(a, a), {});
});
