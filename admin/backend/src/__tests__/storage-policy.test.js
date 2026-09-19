// lib/storage/policy.js + freshness.js — sanoid templates and retention
// classes, per-dataset/per-guest overrides, the rendered sanoid.conf, the
// syncoid replication config, freshness statuses and alert conditions.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolvePolicy, applyPolicyUpdate, classForDataset, effectiveRetention, renderSanoidConf, validateReplication, renderReplicationConf, renderTimerDropIn,
  snapshotMaxAgeMs, replicationMaxAgeMs, DEFAULT_CLASSES,
} from '../lib/storage/policy.js';
import { computeFreshness, storageAlerts, humanAge } from '../lib/storage/freshness.js';
import { fixtureInventory } from './fixtures/storage/load.js';

const MANAGED = { incus: 'tank/incus', backups: 'tank/backups', exports: 'tank/exports' };

test('policy: defaults, class / dataset / guest updates, effective retention', () => {
  const p = resolvePolicy(null);
  assert.deepEqual(p.classes.guests, DEFAULT_CLASSES.guests);
  const p2 = applyPolicyUpdate(p, { class: 'guests', retention: { hourly: 48 } });
  assert.equal(p2.classes.guests.hourly, 48); assert.equal(p2.classes.guests.daily, 14);
  assert.throws(() => applyPolicyUpdate(p, { class: 'nope' }), /class must be one of/);
  assert.throws(() => applyPolicyUpdate(p, { class: 'guests', retention: { daily: -1 } }), /retention.daily/);
  const p3 = applyPolicyUpdate(p2, { dataset: 'tank/exports', retention: { daily: 3 }, enabled: true });
  assert.deepEqual(effectiveRetention('tank/exports', { managed: MANAGED, policy: p3 }), { class: 'exports', enabled: true, retention: { ...DEFAULT_CLASSES.exports, daily: 3 } });
  const p4 = applyPolicyUpdate(p3, { guest: 'pp-db', enabled: false });
  assert.equal(effectiveRetention('tank/incus/containers/pp-db', { managed: MANAGED, policy: p4, guest: 'pp-db' }).enabled, false);
  assert.equal(classForDataset('tank/incus/containers/pp-web', MANAGED, p4), 'guests');
  assert.equal(classForDataset('other/x', MANAGED, p4), null);
  assert.equal(classForDataset('other/x', MANAGED, applyPolicyUpdate(p4, { dataset: 'other/x', class: 'backups' })), 'backups');
  assert.equal(effectiveRetention('other/x', { managed: MANAGED, policy: p4 }).retention, null);
  assert.throws(() => applyPolicyUpdate(p, {}), /needs class, dataset or guest/);
});

test('renderSanoidConf: templates per class, managed sections, guest override sections, extra datasets', () => {
  const policy = applyPolicyUpdate(applyPolicyUpdate(null, { guest: 'pp-db', retention: { frequent: 0, hourly: 6 } }), { dataset: 'other/data', class: 'backups', enabled: false });
  const conf = renderSanoidConf({ policy, managed: MANAGED, guestDatasets: [{ guest: 'pp-web', dataset: 'tank/incus/containers/pp-web' }, { guest: 'pp-db', dataset: 'tank/incus/containers/pp-db' }] });
  assert.match(conf, /\[template_pp_guests\]\n\tfrequently = 4\n\tfrequent_period = 15\n\thourly = 24\n\tdaily = 14\n\tmonthly = 3/);
  assert.match(conf, /\[tank\/incus\]\n\tuse_template = pp_guests\n\trecursive = yes\n\tprocess_children_only = yes/);
  assert.match(conf, /\[tank\/backups\]\n\tuse_template = pp_backups\n\trecursive = no/);
  assert.match(conf, /\[tank\/incus\/containers\/pp-db\]\n\tuse_template = pp_guests\n\trecursive = no\n\tfrequently = 0\n\thourly = 6/);
  assert.ok(!conf.includes('[tank/incus/containers/pp-web]'));
  assert.match(conf, /\[other\/data\]\n\tuse_template = pp_backups\n\trecursive = no\n\tautosnap = no\n\tautoprune = no/);
});

test('replication: validation of local and remote targets, key path, schedule; rendered config is shell-safe', () => {
  assert.match(validateReplication({ name: 'Bad Name', sources: ['tank/incus'], target: 'tank2/incus' }).error, /name:/);
  assert.match(validateReplication({ name: 'a', target: 'tank2/x' }).error, /sources/);
  assert.match(validateReplication({ name: 'a', sources: ['tank/incus'], target: 'host:' }).error, /target must be/);
  assert.match(validateReplication({ name: 'a', sources: ['tank/incus'], target: 'backup@nas.local:tank/pp' }).error, /ssh_key_path/);
  assert.match(validateReplication({ name: 'a', sources: ['tank/incus'], target: 'backup@nas.local:tank/pp', ssh_key_path: '/root/.ssh/../x' }).error, /ssh_key_path/);
  assert.match(validateReplication({ name: 'a', sources: ['tank/incus'], target: 'tank2/x', schedule: 'rm -rf' }).error, /schedule/);
  const local = validateReplication({ name: 'local', sources: ['tank/incus', 'tank/backups'], target: 'tank2/pp', schedule: 'daily' }).config;
  assert.equal(local.kind, 'local'); assert.equal(local.schedule, '*-*-* 02:30:00'); assert.equal(local.ssh_key_path, null);
  const remote = validateReplication({ name: 'offsite', sources: ['tank/incus'], target: 'backup@nas.local:tank/pp', ssh_key_path: "/root/.ssh/it's", ssh_port: 2222, extra_args: ['--no-sync-snap', '--bad;arg'] }).config;
  assert.equal(remote.kind, 'remote'); assert.equal(remote.schedule, 'hourly'); assert.deepEqual(remote.extra_args, ['--no-sync-snap']);
  const conf = renderReplicationConf(remote);
  assert.match(conf, /PP_REPL_SSH_KEY='\/root\/.ssh\/it'\\''s'/);
  assert.match(conf, /PP_REPL_SOURCES='tank\/incus'/); assert.match(conf, /PP_REPL_SSH_PORT='2222'/);
  assert.match(renderTimerDropIn('hourly'), /OnCalendar=\nOnCalendar=hourly/);
  assert.equal(snapshotMaxAgeMs(DEFAULT_CLASSES.guests), 3600000); assert.equal(snapshotMaxAgeMs(DEFAULT_CLASSES.backups), 30 * 3600000); assert.equal(snapshotMaxAgeMs({ frequent: 0, hourly: 0, daily: 0, monthly: 0 }), null);
  assert.equal(replicationMaxAgeMs('hourly'), 3 * 3600000); assert.equal(replicationMaxAgeMs('*-*-* 02:30:00'), 30 * 3600000); assert.equal(replicationMaxAgeMs('Sun *-*-* 03:00:00'), 8 * 86400000);
});

test('freshness: pools (health, scrub age), guests (snapshot age vs policy), replication (schedule), alerts with stable keys', () => {
  const inv = fixtureInventory();
  const now = Date.parse('2025-09-19T10:00:00Z'); // fixtures are epoch-based → 2025
  const repl = [
    { name: 'offsite', sources: ['tank/incus'], target: 'b@nas:tank/pp', schedule: 'hourly', enabled: true, last_run_at: '2025-09-19T09:30:00Z', last_success_at: '2025-09-19T09:31:00Z', last_error: null },
    { name: 'broken', sources: ['tank/backups'], target: 'tank2/pp', schedule: 'daily', enabled: true, last_run_at: '2025-09-19T02:30:00Z', last_success_at: '2025-09-17T02:31:00Z', last_error: 'cannot receive: destination has snapshots' },
  ];
  const f = computeFreshness({ pools: inv.pools, poolStatus: inv.poolStatus, datasets: inv.datasets, snapshots: inv.snapshots, instances: inv.instances, managed: MANAGED, policy: resolvePolicy(null), replication: repl, now });
  const tank = f.pools.find((p) => p.name === 'tank');
  assert.equal(tank.healthy, true); assert.equal(tank.scrub.status, 'ok'); assert.equal(tank.scrub.errors, 0);
  const data = f.pools.find((p) => p.name === 'data');
  assert.equal(data.healthy, false); assert.equal(data.scrub.in_progress, true); assert.equal(data.device_errors, 2); assert.match(data.data_errors, /3 data errors/);
  assert.deepEqual(data.degraded_members, [{ name: '17915845734211201414', state: 'FAULTED' }]);
  const web = f.guests.find((g) => g.name === 'pp-web');
  assert.equal(web.on_managed_pool, true); assert.equal(web.snapshot_status, 'ok'); assert.deepEqual(web.replicated_by, ['offsite']); assert.equal(web.replication_status, 'ok');
  const db = f.guests.find((g) => g.name === 'pp-db');
  assert.equal(db.snapshot_status, 'stale'); // last snapshot two days old under the guests class (1 h window)
  const legacy = f.guests.find((g) => g.name === 'pp-legacy');
  assert.equal(legacy.on_managed_pool, false); assert.equal(legacy.snapshot_status, 'unmanaged');
  const exportsDs = f.datasets.find((d) => d.name === 'tank/exports');
  assert.equal(exportsDs.class, 'exports'); assert.equal(exportsDs.status, 'stale');
  assert.equal(f.replication.find((r) => r.name === 'offsite').status, 'ok');
  assert.equal(f.replication.find((r) => r.name === 'broken').status, 'failed');
  assert.equal(f.summary.unhealthy_pools, 1); assert.equal(f.summary.guests_stale, 1);
  const alerts = storageAlerts(f, inv.devices);
  const keys = alerts.map((a) => a.key);
  assert.ok(keys.includes('storage:pool-health:data'));
  assert.ok(keys.includes('storage:pool-errors:data'));
  assert.ok(keys.includes('storage:smart:ZDH1DDDD'));
  assert.equal(alerts.find((a) => a.key === 'storage:smart:ZDH1DDDD').level, 'error');
  assert.equal(alerts.find((a) => a.key === 'storage:smart:WD-WCC7K1BBBBBB').level, 'warning');
  assert.ok(keys.includes('storage:snapshot-stale:tank/incus/containers/pp-db'));
  assert.ok(keys.includes('storage:snapshot-stale:tank/exports'));
  assert.equal(alerts.find((a) => a.key === 'storage:replication:broken').event, 'storage.replication_failed');
  assert.ok(!keys.includes('storage:replication:offsite'));
  assert.ok(!keys.includes('storage:pool-health:tank'));
  assert.ok(alerts.every((a) => a.title && a.body && a.event.startsWith('storage.')));
  assert.equal(humanAge(90 * 60000), '2 h'); assert.equal(humanAge(null), 'never');
  // a year later everything is stale/overdue
  const later = computeFreshness({ pools: inv.pools, poolStatus: inv.poolStatus, datasets: inv.datasets, snapshots: inv.snapshots, instances: inv.instances, managed: MANAGED, policy: resolvePolicy(null), replication: repl, now: now + 500 * 86400000 });
  assert.equal(later.pools[0].scrub.status, 'overdue');
  assert.ok(storageAlerts(later, []).some((a) => a.key === 'storage:scrub-overdue:tank'));
});
