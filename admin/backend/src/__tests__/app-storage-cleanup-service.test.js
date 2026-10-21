import test from 'node:test';
import assert from 'node:assert/strict';
import { createCleanupService, busyFrom, GUEST_BUSY_MESSAGE } from '../lib/app-storage/cleanup-service.js';
import { NOTHING_SELECTED } from '../lib/app-storage/selection.js';
import { estimateSelection } from '../lib/app-storage/accounting.js';
import { memoryStore, nodusTarget, nodusCheck, ids, CHECK_ID, CHECK_ID_2 } from './helpers/app-storage-cleanup-world.js';

const NOW = Date.parse('2026-10-20T23:00:00Z');
const CLEANUP_ID = 'cln_11111111-1111-4111-8111-111111111111';

function world({ activity = { openJobs: [], buildActive: false, leaseHeld: null, reasons: [] }, submit = null, check = nodusCheck() } = {}) {
  const store = memoryStore({ now: () => NOW });
  store.putCheck(check);
  const audits = [], submissions = [], alerts = [], jobs = new Map();
  const service = createCleanupService({
    store,
    getCheck: id => store.getCheck(id),
    submitJob: async spec => { submissions.push(spec); return submit ? submit(spec) : { jobId: 'job-1' }; },
    resolveTarget: key => { if (key !== 'application:1') throw Object.assign(new Error('nope'), { code: 'TARGET_NOT_FOUND', status: 404 }); return nodusTarget(); },
    activityFor: () => activity,
    now: () => NOW,
    audit: entry => audits.push(entry),
    monitor: { postCleanupAlert: (targetKey, outcome, opts) => alerts.push({ targetKey, ...outcome, ...opts }) },
    getJob: id => jobs.get(id) || null,
    newId: () => CLEANUP_ID,
  });
  return { store, service, audits, submissions, alerts, jobs };
}
const expectError = async (promise, code, status) => {
  await assert.rejects(promise, err => { assert.equal(err.code, code); assert.equal(err.status, status); return true; });
};

test('nothing selected: no row, no job, one info audit', async () => {
  const w = world();
  assert.deepEqual(await w.service.requestCleanup({ targetKey: 'application:1', checkId: CHECK_ID, items: [], snapshots: [], exports: [] }), { changed: false, message: NOTHING_SELECTED });
  assert.equal(w.store.cleanupCount(), 0); assert.equal(w.submissions.length, 0);
  assert.deepEqual(w.audits.map(a => a.action), ['STORAGE_CLEANUP_NONE']);
});

test('an approved cleanup stores the selection copied from the check, submits one job and audits the approval', async () => {
  const w = world();
  const r = await w.service.requestCleanup({ targetKey: 'application:1', checkId: CHECK_ID, items: [ids.release, ids.cache, ids.group], snapshots: [ids.snap1], acknowledgeSnapshotLoss: true, scope: 'categories', userId: 7, ip: '10.0.0.1' });
  assert.equal(r.changed, true); assert.equal(r.cleanupId, CLEANUP_ID); assert.equal(r.jobId, 'job-1');
  assert.deepEqual(r.estimate, estimateSelection(nodusCheck(), { items: [ids.release, ids.cache, ids.group], snapshots: [ids.snap1], exports: [] }), 'the estimate is the accounting module\'s, not a second one');
  const row = w.store.getCleanup(CLEANUP_ID);
  assert.equal(row.status, 'queued'); assert.equal(row.jobId, 'job-1'); assert.equal(row.origin, 'user'); assert.equal(row.scope, 'categories'); assert.equal(row.checkId, CHECK_ID);
  assert.deepEqual(row.selection.map(e => e.category), ['temp', 'caches', 'releases', 'snapshots']);
  assert.equal(row.selection[1].path, '/root/.cache/ms-playwright');
  assert.equal(row.selection[1].root, '/root/.cache');
  assert.deepEqual(w.submissions, [{ cleanupId: CLEANUP_ID, targetKey: 'application:1', guest: 'pp-nodus', origin: 'user', requestedBy: '7' }]);
  const approval = w.audits.find(a => a.action === 'STORAGE_CLEANUP_APPROVED');
  assert.deepEqual(approval.details.counts, { items: 3, snapshots: 1, exports: 0 });
  assert.equal(approval.ip, '10.0.0.1');
  assert.ok(approval.details.labels.includes('Playwright browsers'));
  assert.equal(JSON.stringify(approval).includes('/root/.cache'), false, 'the audit names labels, not every path');
});

test('the check must be the target\'s latest finished one and at most an hour old (the route\'s own rule, re-checked)', async () => {
  const old = world({ check: nodusCheck({ startedAt: '2026-10-20T21:00:00.000Z', finishedAt: '2026-10-20T21:01:00.000Z' }) });
  await expectError(old.service.requestCleanup({ targetKey: 'application:1', checkId: CHECK_ID, items: [ids.cache] }), 'CHECK_STALE', 409);
  const w = world();
  w.store.putCheck(nodusCheck({ checkId: CHECK_ID_2, startedAt: '2026-10-20T22:40:00.000Z', finishedAt: '2026-10-20T22:41:00.000Z' }));
  await expectError(w.service.requestCleanup({ targetKey: 'application:1', checkId: CHECK_ID, items: [ids.cache] }), 'CHECK_STALE', 409);
  await expectError(w.service.requestCleanup({ targetKey: 'application:1', checkId: 'chk_00000000-0000-4000-8000-00000000dead', items: [ids.cache] }), 'CHECK_STALE', 409);
  const failed = world({ check: nodusCheck({ status: 'failed' }) });
  await expectError(failed.service.requestCleanup({ targetKey: 'application:1', checkId: CHECK_ID, items: [ids.cache] }), 'CHECK_STALE', 409);
  const partial = world({ check: nodusCheck({ status: 'partial' }) });
  assert.equal((await partial.service.requestCleanup({ targetKey: 'application:1', checkId: CHECK_ID, items: [ids.cache] })).changed, true, 'a partial check may back a cleanup');
});

test('ineligible ids, missing acknowledgement, unknown targets and other origins create nothing', async () => {
  const w = world();
  await assert.rejects(w.service.requestCleanup({ targetKey: 'application:1', checkId: CHECK_ID, items: [ids.live] }), err => {
    assert.equal(err.code, 'NOT_ELIGIBLE'); assert.equal(err.status, 409);
    assert.deepEqual(err.items.map(x => x.id), [ids.live], 'the offending ids and reasons travel as error.items');
    assert.ok(err.items[0].reason && !/^Not eligible/.test(err.items[0].reason), 'the item\'s own reason, no prefix');
    return true;
  });
  await expectError(w.service.requestCleanup({ targetKey: 'application:1', checkId: CHECK_ID, snapshots: [ids.snap1] }), 'SNAPSHOT_ACK_REQUIRED', 400);
  await expectError(w.service.requestCleanup({ targetKey: 'application:9', checkId: CHECK_ID, items: [ids.cache] }), 'TARGET_NOT_FOUND', 404);
  await expectError(w.service.requestCleanup({ targetKey: '../etc', checkId: CHECK_ID, items: [ids.cache] }), 'TARGET_NOT_FOUND', 404);
  await expectError(w.service.requestCleanup({ targetKey: 'application:1', checkId: CHECK_ID, items: [ids.cache], origin: 'mcp' }), 'INVALID_REQUEST', 400);
  assert.equal(w.store.cleanupCount(), 0);
  assert.equal(w.submissions.length, 0);
});

test('a busy application is refused with GUEST_BUSY before anything is stored', async () => {
  for (const activity of [{ buildActive: true, reasons: ['An application validate job is running.'] }, { openJobs: [{ id: 'j', kind: 'application_validate' }] }, { leaseHeld: { operation: 'deploy', jobId: 'x', stale: false } }, { reasons: ['The guest is busy (deploy).'] }]) {
    const w = world({ activity });
    await expectError(w.service.requestCleanup({ targetKey: 'application:1', checkId: CHECK_ID, items: [ids.cache] }), 'GUEST_BUSY', 409);
    assert.equal(w.store.cleanupCount(), 0); assert.equal(w.submissions.length, 0);
  }
  assert.equal(busyFrom({ openJobs: [], buildActive: false, leaseHeld: null, reasons: [] }), null);
  assert.equal(busyFrom({ leaseHeld: { operation: 'deploy' }, reasons: [] }), 'Another operation holds the application.');
});

test('a lease taken between the check and the submission refuses the job; the row records the refusal', async () => {
  const w = world({ submit: () => ({ error: 'deploy (runner@x) is in progress', code: 'CONTAINER_BUSY' }) });
  await assert.rejects(w.service.requestCleanup({ targetKey: 'application:1', checkId: CHECK_ID, items: [ids.cache] }), err => err.code === 'GUEST_BUSY' && err.message === GUEST_BUSY_MESSAGE);
  const row = w.store.getCleanup(CLEANUP_ID);
  assert.equal(row.status, 'refused'); assert.equal(row.result.removed.length, 0);
  const none = world({ submit: () => ({ error: 'Storage cleanup runs on the host runner…', code: 'RUNNER_UNAVAILABLE' }) });
  await expectError(none.service.requestCleanup({ targetKey: 'application:1', checkId: CHECK_ID, items: [ids.cache] }), 'RUNNER_UNAVAILABLE', 503);
});

test('a policy cleanup goes through the same checks and audits as retention', async () => {
  const w = world();
  await w.service.requestCleanup({ targetKey: 'application:1', checkId: CHECK_ID, items: [ids.cache], origin: 'policy', scope: 'categories' });
  assert.equal(w.store.getCleanup(CLEANUP_ID).origin, 'policy');
  assert.deepEqual(w.audits.map(a => a.action), ['STORAGE_RETENTION_APPLIED']);
});

test('getCleanup takes the job verdict when the operation never wrote one, and alerts a lost cleanup', async () => {
  const w = world();
  await w.service.requestCleanup({ targetKey: 'application:1', checkId: CHECK_ID, items: [ids.cache] });
  assert.equal((await w.service.getCleanup(CLEANUP_ID)).status, 'queued', 'a queued job leaves the row alone');
  w.jobs.set('job-1', { id: 'job-1', status: 'refused', outcome: 'lock_held', reason: "the app's lease is held", finished_at: '2026-10-20T23:00:05Z' });
  const view = await w.service.getCleanup(CLEANUP_ID);
  assert.equal(view.status, 'refused'); assert.match(view.result.reason, /did not start/);
  assert.equal(view.job.status, 'refused');
  assert.deepEqual(view.selection.map(e => e.label), ['Playwright browsers']);
  assert.equal(w.alerts.length, 0, 'a refusal is not a failure');

  const lost = world();
  await lost.service.requestCleanup({ targetKey: 'application:1', checkId: CHECK_ID, items: [ids.cache] });
  lost.jobs.set('job-1', { id: 'job-1', status: 'failed', outcome: 'interrupted', reason: 'owner gone' });
  assert.equal((await lost.service.getCleanup(CLEANUP_ID)).status, 'failed');
  assert.deepEqual(lost.alerts, [{ targetKey: 'application:1', ok: false, failedCount: 0, name: 'Nodus' }]);

  const cancelled = world();
  await cancelled.service.requestCleanup({ targetKey: 'application:1', checkId: CHECK_ID, items: [ids.cache] });
  cancelled.jobs.set('job-1', { id: 'job-1', status: 'cancelled', outcome: 'cancelled' });
  assert.equal((await cancelled.service.getCleanup(CLEANUP_ID)).status, 'cancelled');
  assert.equal(cancelled.alerts.length, 0);

  const recorded = world();
  await recorded.service.requestCleanup({ targetKey: 'application:1', checkId: CHECK_ID, items: [ids.cache] });
  recorded.jobs.set('job-1', { id: 'job-1', status: 'succeeded', progress_json: JSON.stringify({ result: { cleanup: { status: 'partial', removed: [], skipped: [{ id: ids.cache, label: 'x', reason: 'y' }], failed: [] } } }) });
  assert.equal((await recorded.service.getCleanup(CLEANUP_ID)).status, 'partial');
  assert.equal(await recorded.service.getCleanup('not-an-id'), null);
  assert.equal((await recorded.service.listCleanups('application:1')).length, 1);
  assert.deepEqual(await recorded.service.listCleanups('bad'), []);
});

test('getCleanup shows the job with its newest events, and the journal at its recoverable size', async () => {
  const store = memoryStore({ now: () => NOW }); store.putCheck(nodusCheck());
  const service = createCleanupService({
    store, getCheck: id => store.getCheck(id), submitJob: async () => ({ jobId: 'job-1' }), resolveTarget: () => nodusTarget(),
    activityFor: () => ({}), now: () => NOW, newId: () => CLEANUP_ID,
    getJob: () => ({ id: 'job-1', status: 'running', phase: 'cleanup:item' }),
    listEvents: () => Array.from({ length: 30 }, (_, i) => ({ id: i, at: `t${i}`, kind: 'step', message: `step ${i}`, data_json: '{"secret":"x"}' })),
  });
  await service.requestCleanup({ targetKey: 'application:1', checkId: CHECK_ID, items: [ids.journal] });
  const view = await service.getCleanup(CLEANUP_ID);
  assert.equal(view.job.status, 'running'); assert.equal(view.job.phase, 'cleanup:item');
  assert.equal(view.job.events.length, 20); assert.equal(view.job.events.at(-1).message, 'step 29');
  assert.equal('data_json' in view.job.events[0], false, 'event data is not passed through');
  assert.equal(view.selection[0].bytes, 331_564_544, 'the journal counts what vacuuming returns, not its whole size');
});

test('approval applies the job\'s own location rules: an item the cleanup job would refuse is not approved', async () => {
  const base = nodusCheck();
  const tampered = nodusCheck({
    guest: { status: 'Running', running: true, service: null }, // the service home is unknown
    items: base.items.map(it => {
      if (it.id === ids.dump) return { ...it, path: '/opt/nodus/app-pre-deploy-x.sql' }; // outside every cleanup location
      if (it.id === ids.cache) return { ...it, path: '/var/lib/nodus/.cache/ms-playwright', root: '/var/lib/nodus/.cache' }; // preserved data, no known home
      return it;
    }),
  });
  const w = world({ check: tampered });
  await assert.rejects(w.service.requestCleanup({ targetKey: 'application:1', checkId: CHECK_ID, items: [ids.dump, ids.cache, ids.staging] }), err => {
    assert.equal(err.code, 'NOT_ELIGIBLE'); assert.equal(err.status, 409);
    assert.deepEqual(err.items.map(x => [x.id, x.reason]), [[ids.dump, 'Outside the locations this cleanup may change.'], [ids.cache, 'Outside the locations this cleanup may change.']]);
    return true;
  });
  assert.equal(w.store.cleanupCount(), 0); assert.equal(w.submissions.length, 0);
  // With the home the check's collector resolved, the same cache is approved.
  const ok = world({ check: { ...tampered, guest: { ...tampered.guest, service: { unit: 'nodus.service', user: 'nodus', uid: 989, home: '/var/lib/nodus' } } } });
  const r = await ok.service.requestCleanup({ targetKey: 'application:1', checkId: CHECK_ID, items: [ids.cache, ids.staging] });
  assert.equal(r.changed, true);
});
