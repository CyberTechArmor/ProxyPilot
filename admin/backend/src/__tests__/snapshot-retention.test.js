import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { snapshotRetentionPlan, retentionEventGuest, enforceSnapshotRetention, startSnapshotRetention, SNAPSHOT_RETENTION } from '../lib/snapshot-retention.js';
import { createSnapshotWithFallback } from '../lib/setup-engine/restore-snapshot-op.js';

const snapshot = (name, day) => ({ name, created_at: `2026-10-${String(day).padStart(2, '0')}T12:00:00.123456789Z` });
const inventory = () => ({ name: 'pp-nodus', snapshots: [snapshot('oldest', 1), snapshot('second', 2), snapshot('third', 3)] });
const flush = async () => { for (let i = 0; i < 12; i += 1) await new Promise(resolve => setImmediate(resolve)); };

function hostFor(instance, options = {}) {
  const calls = [];
  return {
    calls,
    host: async argv => {
      calls.push(argv);
      assert.equal(argv[0], 'incus');
      assert.equal(argv[argv[1] === 'list' ? 2 : 3], instance.name);
      if (argv[1] === 'list') return { code: 0, stdout: JSON.stringify([instance]) };
      if (argv[2] === 'create') {
        if (options.creationFails) return { code: 1, stderr: 'pool is full' };
        if (options.legacy) return { code: 1, stderr: 'Error: unknown command "create" for "incus snapshot"' };
        instance.snapshots.push(snapshot(argv[4], 20));
        return { code: 0 };
      }
      if (argv[2] === 'delete') {
        if (options.deleteFails) return { code: 1, stderr: 'busy' };
        if (!options.deleteLies) instance.snapshots = instance.snapshots.filter(row => row.name !== argv[4]);
        return { code: 0 };
      }
      throw new Error(`unexpected command ${argv.join(' ')}`);
    },
  };
}

test('only Nodus is opted into three-snapshot retention', () => {
  assert.deepEqual(SNAPSHOT_RETENTION, { 'pp-nodus': 3 });
});

test('retention uses creation time, not names or returned order, with nanosecond precision', () => {
  const instance = inventory();
  instance.snapshots = [snapshot('z-newest', 8), snapshot('a-middle', 3), snapshot('oldest', 1), snapshot('b-middle', 2)];
  assert.deepEqual(snapshotRetentionPlan(instance, 3).map(row => row.name), ['oldest']);
  const nano = { snapshots: ['000000004', '000000001', '000000003', '000000002'].map((n, i) => ({ name: `snapshot-${i}`, created_at: `2026-10-20T12:00:00.${n}Z` })) };
  assert.equal(snapshotRetentionPlan(nano, 3)[0].name, 'snapshot-1');
});

test('invalid inventory or an ambiguous boundary refuses pruning', () => {
  for (const keep of [0, -1, 1.2, '3', 1001]) assert.throws(() => snapshotRetentionPlan(inventory(), keep));
  assert.throws(() => snapshotRetentionPlan({}, 3));
  assert.throws(() => snapshotRetentionPlan({ snapshots: [{ name: 'x' }] }, 3));
  assert.throws(() => snapshotRetentionPlan({ snapshots: [snapshot('../unsafe', 1)] }, 3));
  assert.throws(() => snapshotRetentionPlan({ snapshots: [snapshot('same', 1), snapshot('same', 2)] }, 3));
  assert.throws(() => snapshotRetentionPlan({ snapshots: ['a', 'b', 'c', 'd'].map(name => snapshot(name, 1)) }, 3));
});

test('the fourth successful snapshot evicts the oldest before creation returns', async () => {
  const instance = inventory();
  const { host, calls } = hostFor(instance);
  const result = await createSnapshotWithFallback(host, instance.name, 'fourth');
  assert.equal(result.ok, true);
  assert.deepEqual(result.retention.deleted, ['oldest']);
  assert.deepEqual(instance.snapshots.map(row => row.name), ['second', 'third', 'fourth']);
  assert.deepEqual(calls.find(argv => argv[2] === 'delete'), ['incus', 'snapshot', 'delete', 'pp-nodus', 'oldest']);
  assert.equal(calls.at(-1)[1], 'list', 'deletion and the retained set are read back');
});

test('failed creation never deletes a snapshot; other guests issue no retention commands', async () => {
  const instance = inventory();
  const failing = hostFor(instance, { creationFails: true });
  assert.equal((await createSnapshotWithFallback(failing.host, instance.name, 'fourth')).ok, false);
  assert.equal(failing.calls.length, 1);
  assert.equal(instance.snapshots.length, 3);
  const other = hostFor({ ...inventory(), name: 'pp-other' });
  assert.equal((await createSnapshotWithFallback(other.host, 'pp-other', 'fourth')).ok, true);
  assert.equal(other.calls.length, 1);
});

test('legacy snapshot creation gets the same retention enforcement', async () => {
  const instance = inventory();
  const current = hostFor(instance);
  const host = async argv => {
    if (argv[2] === 'create') return { code: 1, stderr: 'Error: unknown command "create" for "incus snapshot"' };
    if (argv.length === 4 && argv[1] === 'snapshot') { instance.snapshots.push(snapshot(argv[3], 20)); return { code: 0 }; }
    return current.host(argv);
  };
  const result = await createSnapshotWithFallback(host, 'pp-nodus', 'fourth');
  assert.equal(result.ok, true);
  assert.equal(result.form, 'legacy');
  assert.equal(instance.snapshots.length, 3);
});

test('an unverified or failed deletion fails creation honestly without deleting newer snapshots', async () => {
  for (const options of [{ deleteFails: true }, { deleteLies: true }]) {
    const instance = inventory();
    const { host, calls } = hostFor(instance, options);
    const result = await createSnapshotWithFallback(host, 'pp-nodus', 'fourth');
    assert.equal(result.ok, false);
    assert.equal(result.created, true);
    assert.match(result.error, /was created but retention failed/);
    assert.deepEqual(calls.filter(argv => argv[2] === 'delete').map(argv => argv[4]), ['oldest']);
    assert.equal(instance.snapshots.length, 4);
  }
});

test('restoring the oldest retained snapshot can defer pruning until its job releases the lease', async () => {
  const instance = inventory();
  const { host, calls } = hostFor(instance);
  assert.equal((await createSnapshotWithFallback(host, 'pp-nodus', 'pre-restore', { deferRetention: true })).ok, true);
  assert.equal(instance.snapshots.length, 4);
  assert.equal(calls.length, 1);
  const afterRestore = await enforceSnapshotRetention(host, 'pp-nodus');
  assert.equal(afterRestore.ok, true);
  assert.deepEqual(afterRestore.deleted, ['oldest']);
});

test('events are scoped to Nodus in the default project', () => {
  const event = { type: 'lifecycle', project: 'default', metadata: { action: 'instance-snapshot-created', source: '/1.0/instances/pp-nodus/snapshots/fourth' } };
  assert.equal(retentionEventGuest(event), 'pp-nodus');
  assert.equal(retentionEventGuest({ ...event, project: 'elsewhere' }), null);
  assert.equal(retentionEventGuest({ ...event, project: undefined, metadata: { ...event.metadata, source: `${event.metadata.source}?project=elsewhere` } }), null);
  assert.equal(retentionEventGuest({ ...event, metadata: { ...event.metadata, source: '/1.0/instances/pp-other/snapshots/fourth' } }), null);
  assert.equal(retentionEventGuest({ ...event, metadata: { ...event.metadata, action: 'instance-exec' } }), null);
  assert.equal(retentionEventGuest({ ...event, metadata: { ...event.metadata, source: 'https://elsewhere/1.0/instances/pp-nodus' } }), null);
});

function fakeMonitor() {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => { child.killed = true; };
  return child;
}

test('a creation event triggers cleanup immediately, respecting a busy guest and binding snapshot identity', async () => {
  const instance = inventory();
  const child = fakeMonitor();
  const timers = [];
  const removals = [];
  let busy = true;
  const stop = startSnapshotRetention({
    spawnMonitor: () => child,
    listInstance: async () => structuredClone(instance),
    deleteSnapshot: async (guest, row) => {
      removals.push({ guest, row });
      if (busy) return { ok: false, code: 'CONTAINER_BUSY' };
      instance.snapshots = instance.snapshots.filter(snapshot => snapshot.name !== row.name);
      return { ok: true };
    },
    schedule: (fn, ms) => { const timer = { fn, ms }; timers.push(timer); return timer; },
    cancel: () => {}, log: () => {},
  });
  await flush();
  assert.equal(removals.length, 0, 'boot inventory already satisfies retention');
  instance.snapshots.push(snapshot('fourth', 20));
  child.stdout.write(JSON.stringify({ type: 'lifecycle', metadata: { action: 'instance-snapshot-created', source: '/1.0/instances/pp-nodus/snapshots/fourth' } }) + '\n\n');
  await flush();
  assert.equal(removals.length, 1, 'the event starts cleanup without waiting for a periodic timer');
  assert.equal(instance.snapshots.length, 4, 'a busy guest is untouched');
  assert.equal(timers[0].ms, 1000);
  busy = false;
  timers.shift().fn();
  await flush();
  assert.equal(instance.snapshots.length, 3);
  assert.equal(removals.at(-1).row.created_at, snapshot('oldest', 1).created_at);
  stop(); assert.equal(child.killed, true);
});

test('event stream reconnect reconciles snapshots created while disconnected', async () => {
  const instance = inventory();
  const children = [];
  const timers = [];
  const stop = startSnapshotRetention({
    spawnMonitor: () => { const child = fakeMonitor(); children.push(child); return child; },
    listInstance: async () => structuredClone(instance),
    deleteSnapshot: async (_guest, row) => { instance.snapshots = instance.snapshots.filter(snapshot => snapshot.name !== row.name); return { ok: true }; },
    schedule: (fn, ms) => { const timer = { fn, ms }; timers.push(timer); return timer; },
    cancel: () => {}, log: () => {},
  });
  await flush();
  children[0].emit('close', 1);
  instance.snapshots.push(snapshot('while-disconnected', 20));
  assert.equal(timers[0].ms, 3000);
  timers.shift().fn();
  await flush();
  assert.equal(children.length, 2);
  assert.equal(instance.snapshots.length, 3);
  stop();
});
