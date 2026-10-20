import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { ensureSetupEngineSchema, claimNextJob, getJob, acquireLock, runnerHeartbeat, readLock, createJob, requestCancel, listEvents } from '../lib/setup-engine/store.js';
import { executeJob, reconcile } from '../lib/setup-engine/executor.js';
import { ownerIdentity, validateRunnerJob, reconcileDecision, RUNNER_JOB_KINDS, MUTATING_JOB_KINDS, EXCLUSIVE_JOB_KINDS, STORAGE_CLEANUP_JOB_KINDS } from '../lib/setup-engine/logic.js';
import { SETTLING_NOTE } from '../lib/setup-engine/storage-cleanup-op.js';
import { createCleanupService } from '../lib/app-storage/cleanup-service.js';
import { submitStorageCleanupJob } from '../lib/app-storage/cleanup-deps.js';
import { unwrapContained } from './helpers/scripted-guest.js';
import { memoryStore, nodusTarget, nodusCheck, projectTarget, ids, releasePath, RELEASES } from './helpers/app-storage-world.js';

const RUNNER = ownerIdentity({ kind: 'runner', host: 'test', pid: 1, instance: 'one' });
const RUNNER2 = ownerIdentity({ kind: 'runner', host: 'test', pid: 2, instance: 'two' });
const T0 = Date.parse('2026-10-20T23:00:00Z');
const CLEANUP_ID = 'cln_11111111-1111-4111-8111-111111111111';
const decode = raw => {
  const body = unwrapContained(raw);
  const m = body.match(/ '([A-Za-z0-9+/=]+)'\n$/);
  return m ? JSON.parse(Buffer.from(m[1], 'base64').toString()) : null;
};

// A scripted application world: one guest (pp-nodus) answering the cleanup
// program and the release verify, a host answering incus and the host program.
function world({ target = nodusTarget(), check = nodusCheck(), activity = () => ({ openJobs: [], buildActive: false, reasons: [] }), now = () => T0 } = {}) {
  const db = new DatabaseSync(':memory:'); ensureSetupEngineSchema(db);
  runnerHeartbeat(db, { owner: RUNNER, host: 'test', pid: 1, nowMs: now() });
  const store = memoryStore(); store.putCheck(check);
  const state = {
    used: 3_000_000_000, usedAfter: 2_000_000_000, datasetBefore: 2_900_000_000, datasetAfter: 2_000_000_000,
    snapshots: [{ name: 'snap-1', created_at: '2026-10-01T12:00:00.123456789Z' }, { name: 'snap-2', created_at: '2026-10-02T12:00:01Z' }],
    exports: new Map([[7, { id: 7, container: 'pp-nodus', state: 'ready', created_at: '2026-10-03T00:00:00Z', bytes: 5000 }]]),
    live: releasePath(3), rollback: releasePath(2), verify: { ok: true }, fail: new Set(), refuse: new Map(), throwOn: null, measured: false,
  };
  const calls = [], alerts = [], audits = [];
  let datasetReads = 0;
  const answer = data => {
    calls.push(data);
    if (state.throwOn && state.throwOn(data)) throw Object.assign(new Error('fenced'), { code: 'FENCED' });
    if (state.afterAnswer) state.afterAnswer(data);
    if (data.action === 'live') return { ok: true, live: state.live, releases: { root: RELEASES, live: state.live, rollback: state.rollback, candidate: null, protect: [releasePath(2)], backing: [], sealed: [] }, fs: { usedBytes: state.used } };
    if (data.action === 'measure') { state.measured = true; return { ok: true, fs: { usedBytes: state.usedAfter } }; }
    if (data.action === 'verify') return state.verify;
    if (data.action === 'vacuum-journal') return { ok: true, beforeBytes: 600_000_000, afterBytes: 268_435_456 };
    if (data.action === 'finish-quarantine') return { ok: true, removed: [{ dir: data.parents[0], name: `.pp-cleanup-${data.cleanupId}-0`, bytes: 10 }], failed: [], skipped: [] };
    const entries = data.action === 'remove-release' ? [{ path: data.path }] : data.entries;
    return { ok: true, next: 1, results: entries.map(e => state.fail.has(e.path) ? { path: e.path, status: 'failed', code: 'FS_EACCES' } : state.refuse.has(e.path) ? { path: e.path, status: 'refused', code: state.refuse.get(e.path) } : { path: e.path, status: 'removed', bytes: 100, entries: 1 }) };
  };
  const exec = {
    guest: async (container, raw) => {
      assert.equal(container, target.guest);
      if (String(raw).includes('STALE_WRITERS:') && !String(raw).includes('printf')) return { code: 0, stdout: `STALE_WRITERS:${state.survivors ?? 0}\n` };
      const body = unwrapContained(raw);
      if (body.includes('UNIT_LOADED')) { calls.push({ action: 'unit' }); return { code: 0, stdout: `UNIT_LOADED:yes\nUNIT_ENABLED:enabled\nUNIT_ACTIVE:${state.unitActive === false ? 'inactive' : 'active'}\n` }; }
      if (body.includes('PORT_SERVING')) { calls.push({ action: 'port' }); return { code: 0, stdout: 'PORT_SERVING:200\n' }; }
      if (body.includes('ROOT:')) { calls.push({ action: 'health' }); return { code: 0, stdout: 'ROOT:200\nHEALTH:200\nLOGIN:200\n' }; }
      const data = decode(raw);
      const out = answer(data);
      return { code: out.ok === false ? 1 : 0, stdout: JSON.stringify(out), stderr: 'CONTAINMENT:systemd test\n' };
    },
    host: async argv => {
      calls.push({ host: argv });
      if (argv[1] === '-e') { const out = answer(JSON.parse(Buffer.from(argv[3], 'base64').toString())); return { code: 0, stdout: JSON.stringify(out) }; }
      if (argv[0] === 'incus' && argv[1] === 'list') return { code: 0, stdout: JSON.stringify([{ name: target.guest, snapshots: state.snapshots }]) };
      if (argv[0] === 'incus' && argv[1] === 'snapshot' && argv[2] === 'delete') { state.snapshots = state.snapshots.filter(s => s.name !== argv[4]); return { code: 0, stdout: '' }; }
      if (argv[0] === 'incus' && argv[1] === 'query') { datasetReads += 1; return { code: 0, stdout: JSON.stringify({ disk: { root: { usage: datasetReads === 1 ? state.datasetBefore : state.datasetAfter } } }) }; }
      throw new Error(`unexpected host command ${argv.join(' ')}`);
    },
  };
  let activityCalls = 0;
  const sleeps = [];
  const deps = {
    store,
    getCheck: id => store.getCheck(id),
    resolveTarget: () => target,
    activityFor: (t, opts) => { activityCalls += 1; return activity(activityCalls, opts); },
    performCheck: async args => { calls.push({ action: 'rescan', origin: args.origin }); return { checkId: 'chk-after', status: 'complete', totals: { guest: { usedBytes: state.usedAfter } } }; },
    monitor: { postCleanupAlert: event => alerts.push(event) },
    audit: entry => audits.push(entry),
    exports: { get: id => state.exports.get(id) || null, remove: id => { state.exports.delete(id); return { deleted: true, id }; } },
  };
  const service = createCleanupService({ store, getCheck: id => store.getCheck(id), submitJob: spec => submitStorageCleanupJob(db, { ...spec, nowMs: now() }), resolveTarget: () => target, activityFor: () => ({ openJobs: [], buildActive: false, reasons: [] }), now, audit: () => {}, getJob: id => getJob(db, id), newId: () => CLEANUP_ID });
  const run = async (owner = RUNNER, nowMs = now) => {
    const job = claimNextJob(db, { owner, kinds: ['storage_cleanup'], nowMs: nowMs() });
    assert.ok(job, 'a storage cleanup job is queued');
    return { job, r: await executeJob(job, { db, owner, exec, nowMs, appStorage: { cleanup: deps }, sleep: async ms => { sleeps.push(ms); } }) };
  };
  return { db, store, state, calls, alerts, audits, deps, service, run, sleeps, target };
}
const row = w => w.store.cleanups.get(CLEANUP_ID);
const request = (w, extra) => w.service.requestCleanup({ targetKey: w.target.key, checkId: 'chk-1', ...extra });

test('the job kind is registered in every list and validates references only', () => {
  assert.deepEqual([...STORAGE_CLEANUP_JOB_KINDS], ['storage_cleanup']);
  for (const list of [RUNNER_JOB_KINDS, MUTATING_JOB_KINDS, EXCLUSIVE_JOB_KINDS]) assert.ok(list.includes('storage_cleanup'));
  const params = { cleanupId: CLEANUP_ID, targetKey: 'application:1' };
  assert.equal(validateRunnerJob({ kind: 'storage_cleanup', app: 'pp-nodus', plan: { params } }).ok, true);
  assert.equal(validateRunnerJob({ kind: 'storage_cleanup', app: 'pp-nodus', plan: { steps: [], params: { ...params, container: 'pp-nodus' } } }).ok, true);
  for (const bad of [
    { params: { ...params, path: '/etc' } }, { params: { ...params, command: 'rm -rf /' } }, { params: { ...params, container: 'pp-other' } },
    { params: { ...params, cleanupId: 'cln_x' } }, { params: { ...params, targetKey: 'application:0' } }, { params, retryOf: 'job-0' }, { params, steps: ['remove'] },
  ]) assert.equal(validateRunnerJob({ kind: 'storage_cleanup', app: 'pp-nodus', plan: bad }).ok, false, JSON.stringify(bad));
  const running = { status: 'running', kind: 'storage_cleanup', lease_expires_at: new Date(T0 - 1).toISOString() };
  assert.equal(reconcileDecision({ job: { ...running, checkpoint_json: JSON.stringify({ storageCleanup: true, resumable: true }) }, nowMs: T0 }).action, 'resume');
  assert.equal(reconcileDecision({ job: { ...running, checkpoint_json: null }, nowMs: T0 }).action, 'record_interrupted');
});

test('a cleanup is refused while the lease is held, and with no live runner; nothing is queued', async () => {
  const w = world();
  acquireLock(w.db, { app: 'pp-nodus', owner: RUNNER2, operation: 'application_validate', nowMs: T0 });
  await assert.rejects(request(w, { items: [ids.cache] }), err => err.code === 'GUEST_BUSY' && err.status === 409);
  assert.equal(row(w).status, 'refused');
  assert.equal(w.db.prepare("SELECT COUNT(*) AS n FROM setup_jobs WHERE kind = 'storage_cleanup'").get().n, 0);
  const idle = world({ now: () => T0 + 10 * 60_000 });
  idle.db.prepare('DELETE FROM setup_runners').run();
  await assert.rejects(request(idle, { items: [ids.cache] }), err => err.code === 'RUNNER_UNAVAILABLE');
});

test('a lease taken after submission refuses the claimed job before anything runs', async () => {
  const w = world();
  await request(w, { items: [ids.cache] });
  acquireLock(w.db, { app: 'pp-nodus', owner: RUNNER2, operation: 'deploy', nowMs: T0 });
  const { r } = await w.run();
  assert.equal(r.status, 'refused'); assert.equal(r.outcome, 'lock_held');
  assert.equal(w.calls.length, 0, 'no guest or host command was issued');
  const view = await w.service.getCleanup(CLEANUP_ID);
  assert.equal(view.status, 'refused');
});

test('an approved cleanup removes in order, deletes snapshots and exports, checks health, rescans and measures', async () => {
  const w = world();
  const approved = await request(w, { items: [ids.release, ids.group, ids.cache, ids.journal, ids.dump, ids.staging, ids.hostBundle], snapshots: [ids.snap1], exports: [ids.export1], acknowledgeSnapshotLoss: true });
  const { job, r } = await w.run();
  assert.equal(r.status, 'succeeded', JSON.stringify(getJob(w.db, job.id).reason));
  const result = row(w).result;
  assert.equal(row(w).status, 'succeeded');
  assert.deepEqual(result.removed.map(x => x.id), [ids.group, ids.cache, ids.journal, ids.dump, ids.hostBundle, ids.staging, ids.release, ids.snap1, ids.export1]);
  assert.equal(result.skipped.length, 0); assert.equal(result.failed.length, 0);
  assert.equal(result.health, 'passed');
  assert.equal(result.afterCheckId, 'chk-after');
  const actions = w.calls.map(c => c.action || (c.host ? c.host.slice(0, 3).join(' ') : '?'));
  assert.ok(actions.indexOf('remove-release') > actions.indexOf('remove'), 'releases go last among files');
  const host = w.calls.find(c => c.host?.[1] === '-e');
  assert.equal(JSON.parse(Buffer.from(host.host[3], 'base64').toString()).approvedRoots[0], '/var/lib/proxypilot/application-release-transfers', 'host items run the same program on the host');
  const release = w.calls.find(c => c.action === 'remove-release');
  assert.equal(release.rollback, releasePath(2)); assert.deepEqual(release.protect, [releasePath(2)]);
  assert.equal(w.state.snapshots.some(s => s.name === 'snap-1'), false);
  assert.equal(w.state.exports.has(7), false);
  assert.ok(w.calls.some(c => c.action === 'verify' && c.expected === releasePath(3) && c.sha === '3'.repeat(40)), 'the deploy op verify proves the live release is untouched');
  assert.ok(w.calls.some(c => c.action === 'rescan' && c.origin === 'cleanup'));
  assert.deepEqual(w.sleeps, [10_000], 'one settle wait before the delayed re-read');
  assert.equal(result.reclaimed.guestBytes, 1_000_000_000); assert.equal(result.reclaimed.datasetBytes, 900_000_000); assert.equal(result.reclaimed.settling, false);
  assert.ok(result.estimateBytes >= approved.estimate.diskBytes);
  assert.deepEqual(w.alerts.map(a => [a.kind, a.ok]), [['cleanup', true], ['health', true]], 'success resolves both alerts');
  assert.equal(w.audits.at(-1).action, 'STORAGE_CLEANUP_FINISHED');
  assert.equal(readLock(w.db, 'pp-nodus'), null, 'the lease is released');
  assert.equal(w.calls.some(c => c.host?.includes('create')), false, 'no snapshot is created');
});

test('only the snapshot whose creation time still matches is deleted', async () => {
  const w = world();
  w.state.snapshots[1].created_at = '2026-10-02T13:00:00Z'; // snap-2 was deleted and re-created under the same name
  await request(w, { snapshots: [ids.snap1, ids.snap2], acknowledgeSnapshotLoss: true });
  await w.run();
  const result = row(w).result;
  assert.deepEqual(result.removed.map(x => x.id), [ids.snap1]);
  assert.match(result.skipped.find(x => x.id === ids.snap2).reason, /changed since the check/);
  assert.deepEqual(w.state.snapshots.map(s => s.name), ['snap-2']);
  assert.equal(row(w).status, 'partial');
});

test('one failed removal does not stop the others: partial, alert posted, then resolved by a later success', async () => {
  const w = world();
  w.state.fail.add('/root/.cache/ms-playwright');
  await request(w, { items: [ids.group, ids.cache, ids.dump] });
  await w.run();
  const result = row(w).result;
  assert.equal(row(w).status, 'partial');
  assert.deepEqual(result.removed.map(x => x.id), [ids.group, ids.dump]);
  assert.equal(result.failed[0].id, ids.cache);
  assert.ok(w.calls.some(c => c.action === 'finish-quarantine'), 'a failed removal\'s quarantine is finished at the end');
  const alert = w.alerts.find(a => a.kind === 'cleanup');
  assert.equal(alert.ok, false); assert.equal(alert.level, 'error'); assert.match(alert.title, /did not finish/);
  // A later, successful cleanup of the same target resolves the alert.
  w.state.fail.clear(); w.store.cleanups.clear();
  await request(w, { items: [ids.cache] });
  await w.run();
  assert.equal(row(w).status, 'succeeded');
  assert.deepEqual(w.alerts.filter(a => a.kind === 'cleanup').map(a => a.ok), [false, true]);
});

test('a build starting mid-cleanup stops it; the remaining items are reported skipped', async () => {
  const items = [
    { id: 'p1'.padEnd(16, '0'), category: 'temp', kind: 'directory', path: '/tmp/old-run', status: 'eligible', action: 'remove', location: 'guest', identity: { dev: 1, ino: 5 }, allocatedBytes: 10, label: 'old-run' },
    { id: 'p2'.padEnd(16, '0'), category: 'caches', kind: 'directory', path: '/srv/app/.mock2/cache', status: 'eligible', action: 'remove', location: 'guest', identity: { dev: 1, ino: 6 }, allocatedBytes: 10, label: 'Check cache' },
    { id: 'p3'.padEnd(16, '0'), category: 'test_reports', kind: 'directory', path: '/srv/app/test-results', status: 'eligible', action: 'remove', location: 'guest', identity: { dev: 1, ino: 7 }, allocatedBytes: 10, label: 'Test results' },
  ];
  const check = { ...nodusCheck({ target: { key: 'project:4', kind: 'project', id: 4, guest: 'm2-4' } }), items };
  // Activity: clear at the start and before the first item, then a build starts.
  const w = world({ target: projectTarget(), check, activity: n => ({ openJobs: [], buildActive: n >= 3, reasons: [] }) });
  await w.service.requestCleanup({ targetKey: 'project:4', checkId: 'chk-1', items: items.map(i => i.id) });
  await w.run();
  const result = row(w).result;
  assert.deepEqual(result.removed.map(x => x.id), [items[0].id]);
  assert.deepEqual(result.skipped.map(x => x.id), [items[1].id, items[2].id]);
  for (const s of result.skipped) assert.match(s.reason, /the application changed during cleanup \(a build started\)/);
  assert.equal(w.calls.filter(c => c.action === 'remove').length, 1);
  assert.equal(row(w).status, 'partial');
  assert.ok(w.calls.some(c => c.action === 'unit'), 'the project health ladder runs after a change');
  assert.equal(result.health, 'passed');
});

test('a build already running refuses a project cleanup before anything is removed', async () => {
  const items = [{ id: 'p1'.padEnd(16, '0'), category: 'temp', kind: 'directory', path: '/tmp/old-run', status: 'eligible', action: 'remove', location: 'guest', identity: { dev: 1, ino: 5 }, allocatedBytes: 10, label: 'old-run' }];
  const check = { ...nodusCheck({ target: { key: 'project:4', kind: 'project', id: 4, guest: 'm2-4' } }), items };
  const w = world({ target: projectTarget(), check, activity: () => ({ openJobs: [], buildActive: true, reasons: [] }) });
  await w.service.requestCleanup({ targetKey: 'project:4', checkId: 'chk-1', items: [items[0].id] });
  const { r } = await w.run();
  assert.equal(r.status, 'refused');
  assert.equal(row(w).status, 'refused'); assert.equal(row(w).result.reason, 'A build started; nothing was removed.');
  assert.equal(w.calls.filter(c => c.action === 'remove').length, 0);
});

test('an interrupted cleanup resumes: quarantine is finished, done items are not redone, a changed item is not removed', async () => {
  let clock = T0;
  const w = world({ now: () => clock });
  await request(w, { items: [ids.group, ids.cache, ids.dump] });
  // The runner dies while removing the second item.
  w.state.throwOn = data => data.action === 'remove' && data.entries[0].path === '/root/.cache/ms-playwright';
  const first = await w.run(RUNNER, () => clock);
  assert.equal(first.r.status, 'fenced');
  const cp = JSON.parse(getJob(w.db, first.job.id).checkpoint_json);
  assert.equal(cp.storageCleanup, true); assert.deepEqual(cp.done, [ids.group]); assert.equal(cp.current, ids.cache);
  assert.ok(cp.parents.guest.includes('/root/.cache'), 'the parent is recorded before the rename');
  // The lease lapses; another runner reconciles and resumes.
  clock = T0 + 5 * 60_000;
  runnerHeartbeat(w.db, { owner: RUNNER2, host: 'test', pid: 2, nowMs: clock });
  const rec = reconcile({ db: w.db, owner: RUNNER2, nowMs: clock });
  assert.deepEqual(rec.requeued, [first.job.id]);
  w.state.throwOn = null;
  w.state.refuse.set('/root/.cache/ms-playwright', 'CHANGED_SINCE_CHECK');
  const before = w.calls.length;
  const second = await w.run(RUNNER2, () => clock);
  assert.equal(second.r.status, 'succeeded');
  const after = w.calls.slice(before);
  const finish = after.find(c => c.action === 'finish-quarantine');
  assert.ok(finish && finish.parents.includes('/root/.cache'), 'the resumed job first finishes this cleanup\'s quarantine');
  assert.equal(finish.cleanupId, CLEANUP_ID);
  assert.equal(after.filter(c => c.action === 'remove' && c.entries.some(e => e.path.startsWith('/tmp/nodus-embed'))).length, 0, 'a finished item is never redone');
  const result = row(w).result;
  assert.deepEqual(result.removed.map(x => x.id), [ids.group, ids.dump]);
  assert.match(result.skipped.find(x => x.id === ids.cache).reason, /changed after the storage check/);
  assert.equal(row(w).status, 'partial');
  assert.ok(result.notes.some(n => /set aside/.test(n)));
});

test('a failing health check is reported and alerted; nothing is rolled back and no snapshot is taken', async () => {
  const w = world();
  w.state.verify = { ok: false, code: 'HEALTH_FAILED' };
  await request(w, { items: [ids.cache] });
  await w.run();
  const result = row(w).result;
  assert.equal(result.health, 'failed'); assert.equal(result.healthDetail, 'HEALTH_FAILED');
  assert.equal(row(w).status, 'partial');
  assert.equal(w.calls.filter(c => c.action === 'verify').length, 3, 'health is retried briefly, never repaired');
  const alert = w.alerts.find(a => a.kind === 'health');
  assert.equal(alert.ok, false); assert.match(alert.body, /no snapshot was taken/);
  assert.equal(w.calls.some(c => c.host?.includes('snapshot') && (c.host.includes('create') || c.host.length === 4)), false);
  assert.equal(w.calls.some(c => c.action === 'switch'), false);
});

test('little measured reclaim yields the settling note', async () => {
  const w = world();
  w.state.usedAfter = w.state.used - 50; // removed ~300 bytes on disk, the filesystem shows 50 so far
  await request(w, { items: [ids.cache, ids.dump] });
  await w.run();
  const result = row(w).result;
  assert.equal(result.reclaimed.guestBytes, 50);
  assert.equal(result.reclaimed.settling, true);
  assert.ok(result.notes.includes(SETTLING_NOTE));
  assert.equal(w.state.measured, true, 'the guest is measured again after the settle wait');
});

test('a protected-now item is skipped, a mismatched or out-of-bounds selection is never acted on, and a finished row is returned as is', async () => {
  const w = world();
  await request(w, { items: [ids.release, ids.cache, ids.dump, ids.group] });
  // Since the check, the selected release became the rollback target.
  w.state.rollback = releasePath(1);
  const sel = row(w).selection;
  sel.find(e => e.id === ids.cache).path = '/etc'; // a tampered row: outside every approved root
  sel.find(e => e.id === ids.dump).path = '/var/backups/proxypilot-db/app-other.sql'; // allowed place, but not what the check saw
  await w.run();
  const result = row(w).result;
  assert.equal(result.skipped.find(x => x.id === ids.release).reason, 'Now protected: kept so you can roll back to the previous version.');
  assert.equal(result.skipped.find(x => x.id === ids.cache).reason, 'Outside the locations this cleanup may change.');
  assert.equal(result.skipped.find(x => x.id === ids.dump).reason, 'It does not match the storage check it was approved from.');
  assert.deepEqual(result.removed.map(x => x.id), [ids.group]);
  assert.equal(w.calls.some(c => c.action === 'remove-release'), false);
  assert.equal(w.calls.some(c => c.action === 'remove' && c.entries.some(e => e.path === '/etc' || e.path.includes('app-other'))), false);
  createJob(w.db, { kind: 'storage_cleanup', app: 'pp-nodus', plan: { steps: [], params: { cleanupId: CLEANUP_ID, targetKey: 'application:1', container: 'pp-nodus' } }, nowMs: T0 });
  const calls = w.calls.length;
  const { r } = await w.run();
  assert.equal(r.status, 'succeeded', 'the stored partial result is returned; the job itself completed');
  assert.equal(w.calls.length, calls, 'a finished cleanup is never run twice');
});

test('a cancel is honoured between items only: done items are reported, the rest skipped, the row cancelled', async () => {
  const w = world();
  await request(w, { items: [ids.group, ids.cache, ids.dump] });
  w.state.afterAnswer = data => {
    if (data.action === 'remove' && data.entries[0].path.startsWith('/tmp/nodus-embed')) {
      const job = w.db.prepare("SELECT id FROM setup_jobs WHERE kind = 'storage_cleanup'").get();
      requestCancel(w.db, { id: job.id, by: 'operator' });
    }
  };
  const { job, r } = await w.run();
  assert.equal(r.status, 'cancelled');
  assert.equal(row(w).status, 'cancelled');
  const result = row(w).result;
  assert.deepEqual(result.removed.map(x => x.id), [ids.group], 'the item whose removal had run is recorded');
  assert.deepEqual(result.skipped.map(x => x.id), [ids.cache, ids.dump]);
  for (const x of result.skipped) assert.match(x.reason, /cancelled/);
  assert.ok(listEvents(w.db, job.id).some(e => e.kind === 'step' && e.message === 'Cleaning up nodus-embed-* (2 folders)'), 'progress is told in plain words');
});

test('the executor requeues a storage cleanup claimed by the backend (runner only)', async () => {
  const w = world();
  await request(w, { items: [ids.cache] });
  const backend = ownerIdentity({ kind: 'backend', host: 'test', pid: 9, instance: 'b' });
  const job = claimNextJob(w.db, { owner: backend, kinds: ['storage_cleanup'], nowMs: T0 });
  const r = await executeJob(job, { db: w.db, owner: backend, exec: { guest: async () => { throw new Error('no'); } }, nowMs: () => T0 });
  assert.equal(r.outcome, 'runner_unavailable');
  assert.equal(getJob(w.db, job.id).status, 'queued');
});
