import test from 'node:test';
import assert from 'node:assert/strict';
import { createCleanupService, busyFrom, GUEST_BUSY_MESSAGE } from '../lib/app-storage/cleanup-service.js';
import { NOTHING_SELECTED } from '../lib/app-storage/selection.js';
import { memoryStore, nodusTarget, nodusCheck, ids } from './helpers/app-storage-world.js';

const NOW = Date.parse('2026-10-20T23:00:00Z');
const CLEANUP_ID = 'cln_11111111-1111-4111-8111-111111111111';

function world({ activity = { openJobs: [], buildActive: false, reasons: [] }, submit = null, check = nodusCheck() } = {}) {
  const store = memoryStore();
  store.putCheck(check);
  const audits = [], submissions = [], alerts = [], jobs = new Map();
  const service = createCleanupService({
    store,
    getCheck: id => store.getCheck(id),
    submitJob: async spec => { submissions.push(spec); return submit ? submit(spec) : { jobId: 'job-1' }; },
    resolveTarget: key => { if (key !== 'application:1') throw Object.assign(new Error('nope'), { code: 'TARGET_NOT_FOUND' }); return nodusTarget(); },
    activityFor: () => activity,
    now: () => NOW,
    audit: entry => audits.push(entry),
    monitor: { postCleanupAlert: event => alerts.push(event) },
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
  assert.deepEqual(await w.service.requestCleanup({ targetKey: 'application:1', checkId: 'chk-1', items: [], snapshots: [], exports: [] }), { changed: false, message: NOTHING_SELECTED });
  assert.equal(w.store.cleanups.size, 0); assert.equal(w.submissions.length, 0);
  assert.deepEqual(w.audits.map(a => a.action), ['STORAGE_CLEANUP_NONE']);
});

test('an approved cleanup stores the selection copied from the check, submits one job and audits the approval', async () => {
  const w = world();
  const r = await w.service.requestCleanup({ targetKey: 'application:1', checkId: 'chk-1', items: [ids.release, ids.cache, ids.group], snapshots: [ids.snap1], acknowledgeSnapshotLoss: true, scope: 'categories', userId: 7, ip: '10.0.0.1' });
  assert.equal(r.changed, true); assert.equal(r.cleanupId, CLEANUP_ID); assert.equal(r.jobId, 'job-1');
  assert.equal(r.estimate.precision, 'estimate'); assert.ok(r.estimate.bytes > 0);
  const row = w.store.cleanups.get(CLEANUP_ID);
  assert.equal(row.status, 'queued'); assert.equal(row.jobId, 'job-1'); assert.equal(row.origin, 'user'); assert.equal(row.scope, 'categories');
  assert.deepEqual(row.selection.map(e => e.category), ['temp', 'caches', 'releases', 'snapshots']);
  assert.equal(row.selection[1].path, '/root/.cache/ms-playwright');
  assert.deepEqual(w.submissions, [{ cleanupId: CLEANUP_ID, targetKey: 'application:1', guest: 'pp-nodus', origin: 'user', requestedBy: '7' }]);
  const approval = w.audits.find(a => a.action === 'STORAGE_CLEANUP_APPROVED');
  assert.deepEqual(approval.details.counts, { items: 3, snapshots: 1, exports: 0 });
  assert.equal(approval.ip, '10.0.0.1');
  assert.ok(approval.details.labels.includes('Playwright browsers'));
  assert.equal(JSON.stringify(approval).includes('/root/.cache'), false, 'the audit names labels, not every path');
});

test('stale checks, ineligible ids and missing snapshot acknowledgement create nothing', async () => {
  const stale = world({ check: nodusCheck({ finishedAt: '2026-10-20T21:00:00Z', startedAt: '2026-10-20T20:59:00Z' }) });
  await expectError(stale.service.requestCleanup({ targetKey: 'application:1', checkId: 'chk-1', items: [ids.cache] }), 'CHECK_STALE', 409);
  const w = world();
  w.store.putCheck(nodusCheck({ checkId: 'chk-2', startedAt: '2026-10-20T22:40:00Z', finishedAt: '2026-10-20T22:41:00Z' }));
  await expectError(w.service.requestCleanup({ targetKey: 'application:1', checkId: 'chk-1', items: [ids.cache] }), 'CHECK_STALE', 409);
  await expectError(w.service.requestCleanup({ targetKey: 'application:1', checkId: 'chk-2', items: [ids.live] }), 'NOT_ELIGIBLE', 409);
  await expectError(w.service.requestCleanup({ targetKey: 'application:1', checkId: 'chk-2', snapshots: [ids.snap1] }), 'SNAPSHOT_ACK_REQUIRED', 400);
  await expectError(w.service.requestCleanup({ targetKey: 'application:9', checkId: 'chk-2', items: [ids.cache] }), 'TARGET_NOT_FOUND', 404);
  await expectError(w.service.requestCleanup({ targetKey: '../etc', checkId: 'chk-2', items: [ids.cache] }), 'TARGET_NOT_FOUND', 404);
  await expectError(w.service.requestCleanup({ targetKey: 'application:1', checkId: 'chk-2', items: [ids.cache], origin: 'mcp' }), 'INVALID_REQUEST', 400);
  assert.equal(stale.store.cleanups.size + w.store.cleanups.size, 0);
  assert.equal(w.submissions.length, 0);
});

test('a busy application is refused with GUEST_BUSY before anything is stored', async () => {
  for (const activity of [{ buildActive: true }, { openJobs: [{ id: 'j', kind: 'application_validate' }] }, { reasons: ['The guest lease is held by a deploy.'] }]) {
    const w = world({ activity });
    await expectError(w.service.requestCleanup({ targetKey: 'application:1', checkId: 'chk-1', items: [ids.cache] }), 'GUEST_BUSY', 409);
    assert.equal(w.store.cleanups.size, 0); assert.equal(w.submissions.length, 0);
  }
  assert.equal(busyFrom({ openJobs: [], buildActive: false, reasons: [] }), null);
});

test('a lease taken between the check and the submission refuses the job; the row records the refusal', async () => {
  const w = world({ submit: () => ({ error: 'deploy (runner@x) is in progress', code: 'CONTAINER_BUSY' }) });
  await assert.rejects(w.service.requestCleanup({ targetKey: 'application:1', checkId: 'chk-1', items: [ids.cache] }), err => err.code === 'GUEST_BUSY' && err.message === GUEST_BUSY_MESSAGE);
  const row = w.store.cleanups.get(CLEANUP_ID);
  assert.equal(row.status, 'refused'); assert.equal(row.result.removed.length, 0);
  const none = world({ submit: () => ({ error: 'Storage cleanup runs on the host runner…', code: 'RUNNER_UNAVAILABLE' }) });
  await expectError(none.service.requestCleanup({ targetKey: 'application:1', checkId: 'chk-1', items: [ids.cache] }), 'RUNNER_UNAVAILABLE', 503);
});

test('a policy cleanup goes through the same checks and audits as retention', async () => {
  const w = world();
  await w.service.requestCleanup({ targetKey: 'application:1', checkId: 'chk-1', items: [ids.cache], origin: 'policy', scope: 'categories' });
  assert.equal(w.store.cleanups.get(CLEANUP_ID).origin, 'policy');
  assert.deepEqual(w.audits.map(a => a.action), ['STORAGE_RETENTION_APPLIED']);
});

test('getCleanup takes the job verdict when the operation never wrote one, and alerts a lost cleanup', async () => {
  const w = world();
  await w.service.requestCleanup({ targetKey: 'application:1', checkId: 'chk-1', items: [ids.cache] });
  assert.equal((await w.service.getCleanup(CLEANUP_ID)).status, 'queued', 'a queued job leaves the row alone');
  w.jobs.set('job-1', { id: 'job-1', status: 'refused', outcome: 'lock_held', reason: "the app's lease is held", finished_at: '2026-10-20T23:00:05Z' });
  const view = await w.service.getCleanup(CLEANUP_ID);
  assert.equal(view.status, 'refused'); assert.match(view.result.reason, /did not start/);
  assert.equal(view.job.status, 'refused');
  assert.deepEqual(view.selection.map(e => e.label), ['Playwright browsers']);
  assert.equal(w.alerts.length, 0, 'a refusal is not a failure');

  const lost = world();
  await lost.service.requestCleanup({ targetKey: 'application:1', checkId: 'chk-1', items: [ids.cache] });
  lost.jobs.set('job-1', { id: 'job-1', status: 'failed', outcome: 'interrupted', reason: 'owner gone' });
  assert.equal((await lost.service.getCleanup(CLEANUP_ID)).status, 'failed');
  assert.equal(lost.alerts.length, 1); assert.equal(lost.alerts[0].kind, 'cleanup');

  const recorded = world();
  await recorded.service.requestCleanup({ targetKey: 'application:1', checkId: 'chk-1', items: [ids.cache] });
  recorded.jobs.set('job-1', { id: 'job-1', status: 'succeeded', progress_json: JSON.stringify({ result: { cleanup: { status: 'partial', removed: [], skipped: [{ id: ids.cache, label: 'x', reason: 'y' }], failed: [] } } }) });
  assert.equal((await recorded.service.getCleanup(CLEANUP_ID)).status, 'partial');
  assert.equal(await recorded.service.getCleanup('not-an-id'), null);
  assert.equal((await recorded.service.listCleanups('application:1')).length, 1);
  assert.deepEqual(await recorded.service.listCleanups('bad'), []);
});
