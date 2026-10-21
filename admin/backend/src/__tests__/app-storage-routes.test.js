// /api/app-storage: administrator only; cleanups and policy edits also need
// sudo (a check request does not: it only measures). An empty selection
// changes nothing, a stale or foreign check is refused (409), an unknown
// target is 404, snapshots need the acknowledgement, and until the cleanup
// service is wired cleanup answers 503.

import test from 'node:test';
import assert from 'node:assert/strict';
import { registerAppStorageRoutes, MEMBERS_SHOWN } from '../routes/app-storage.js';
import { createAppStorage } from '../lib/app-storage/index.js';
import * as W from './helpers/app-storage-world.js';

const NOW = Date.parse('2026-10-20T23:00:00Z');

function fixture(t, { cleanupService = null, now = () => NOW, logs = [] } = {}) {
  const root = W.makeRoot(); t.after(() => W.cleanupRoot(root));
  const world = W.buildNodusGuest(root, NOW);
  const { mock2Db, mainDb } = W.databases();
  W.registerNodus(mock2Db, world);
  const exec = W.scriptedExec({ prefix: root, snapshots: [{ name: 'snap0', created_at: '2026-10-18T10:00:00Z' }], snapshotUsed: { snap0: 4e7 } });
  const storage = createAppStorage({ mock2Db, mainDb, exec, now, notifications: { post() {}, resolve() { return false; }, list: () => [], dispatch: async () => {} }, listGuests: async () => new Map(), logger: null });
  if (cleanupService) storage.setCleanupService(cleanupService);
  const routes = new Map(); const audits = [];
  const router = Object.fromEntries(['get', 'post', 'put'].map((m) => [m, (path, ...handlers) => routes.set(`${m} ${path}`, handlers)]));
  const requireAdmin = (_req, _res, next) => next(); const requireSudo = (_req, _res, next) => next();
  registerAppStorageRoutes(router, { storage: () => storage, requireAdmin, requireSudo, audit: (req, action, key, detail) => audits.push([action, key, detail]), now, log: (...a) => logs.push(a) });
  async function request(method, path, extra = {}) {
    const handlers = routes.get(`${method} ${path}`); assert.ok(handlers, path);
    let status = 200; let body;
    const req = { params: {}, query: {}, body: {}, user: { id: 7 }, ip: '10.0.0.5', ...extra };
    const res = { headersSent: false, status(code) { status = code; return this; }, json(v) { body = v; return this; } };
    await handlers.at(-1)(req, res, (e) => { throw e; });
    return { status, body };
  }
  const app = { params: { kind: 'application', id: '1' } };
  return { storage, routes, audits, request, requireAdmin, requireSudo, app };
}

test('every route needs an administrator; cleanups and policy edits also need sudo, a check request does not', (t) => {
  assert.throws(() => registerAppStorageRoutes({ get() {}, post() {}, put() {} }, {}), /dependency is required/);
  const f = fixture(t);
  const sudo = new Set(['post /targets/:kind/:id/cleanups', 'put /targets/:kind/:id/policy']);
  assert.deepEqual([...f.routes.keys()].sort(), ['get /checks/:checkId', 'get /cleanups/:cleanupId', 'get /overview', 'get /targets/:kind/:id', 'get /targets/:kind/:id/policy', 'post /targets/:kind/:id/checks', 'post /targets/:kind/:id/cleanups', 'put /targets/:kind/:id/policy']);
  for (const [route, handlers] of f.routes) {
    assert.equal(handlers[0], f.requireAdmin, route);
    assert.equal(handlers.includes(f.requireSudo), sudo.has(route), route);
  }
});

test('request a check, read it, read the target and the overview; unknown targets are 404', async (t) => {
  const f = fixture(t);
  const r = await f.request('post', '/targets/:kind/:id/checks', f.app);
  assert.equal(r.status, 202);
  assert.equal(r.body.status, 'running');
  assert.deepEqual(f.audits.at(-1), ['STORAGE_CHECK_REQUESTED', 'application:1', { checkId: r.body.checkId, reused: false }]);
  await f.storage.checks.waitForCheck(r.body.checkId);
  const c = await f.request('get', '/checks/:checkId', { params: { checkId: r.body.checkId } });
  assert.equal(c.body.status, 'complete');
  assert.ok(c.body.items.length > 10);
  const d = await f.request('get', '/targets/:kind/:id', f.app);
  assert.deepEqual(Object.keys(d.body).sort(), ['activity', 'cleanups', 'effects', 'latestCheck', 'policy', 'runningCheckId', 'target']);
  assert.equal(d.body.latestCheck.checkId, r.body.checkId);
  assert.deepEqual(d.body.cleanups, []);
  assert.equal(d.body.target.guestStatus, 'Running', 'no guest list in this fixture: the last check carries the status');
  const o = await f.request('get', '/overview');
  assert.equal(o.body.targets[0].key, 'application:1');
  for (const params of [{ kind: 'application', id: '99' }, { kind: 'server', id: '1' }, { kind: 'application', id: '0' }, { kind: 'project', id: '1' }]) {
    const nf = await f.request('post', '/targets/:kind/:id/checks', { params });
    assert.equal(nf.status, 404, JSON.stringify(params));
    assert.equal(nf.body.error.code, 'TARGET_NOT_FOUND');
    assert.equal(typeof nf.body.error.message, 'string');
  }
  assert.equal((await f.request('get', '/checks/:checkId', { params: { checkId: 'chk_00000000-0000-4000-8000-000000000009' } })).status, 404);
});

test('group members are trimmed to the first 50 in the API; all stay server-side', async (t) => {
  const f = fixture(t);
  const id = 'chk_00000000-0000-4000-8000-0000000000aa';
  const members = Array.from({ length: 120 }, (_, i) => ({ path: `/tmp/pulse-${i}`, identity: { ino: i } }));
  f.storage.store.insertCheck({ id, targetKey: 'application:1' });
  f.storage.store.finishCheck(id, { status: 'complete', result: { version: 1, checkId: id, target: { key: 'application:1' }, items: [{ id: 'a'.repeat(16), kind: 'group', memberCount: 120, members }] } });
  const r = await f.request('get', '/checks/:checkId', { params: { checkId: id } });
  assert.equal(r.body.items[0].members.length, MEMBERS_SHOWN);
  assert.equal(r.body.items[0].membersTruncated, true);
  assert.equal(r.body.items[0].memberCount, 120);
  assert.equal(f.storage.store.getCheck(id).result.items[0].members.length, 120);
});

test('cleanup: an empty selection changes nothing and never reaches the cleanup service', async (t) => {
  const calls = [];
  const svc = { requestCleanup: async (a) => { calls.push(a); return { changed: true }; }, getCleanup: () => null, listCleanups: () => [] };
  const f = fixture(t, { cleanupService: svc });
  for (const body of [{}, { checkId: 'chk_00000000-0000-4000-8000-000000000001', items: [], snapshots: [], exports: [] }]) {
    const r = await f.request('post', '/targets/:kind/:id/cleanups', { ...f.app, body });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { changed: false, message: 'Nothing was selected, so nothing was changed.' });
  }
  assert.equal(calls.length, 0);
  assert.equal(f.audits.filter((a) => a[0] === 'STORAGE_CLEANUP_NONE').length, 2);
});

test('cleanup: a stale, superseded or foreign check is refused with 409; snapshots need the acknowledgement', async (t) => {
  let now = NOW;
  const calls = [];
  const svc = { requestCleanup: async (a) => { calls.push(a); return { changed: true, cleanupId: 'cln_00000000-0000-4000-8000-000000000001', jobId: 'job-1', estimate: { bytes: 10 } }; }, getCleanup: () => null, listCleanups: () => [] };
  const f = fixture(t, { cleanupService: svc, now: () => now });
  const first = await f.storage.runCheck('application:1');
  const eligible = first.items.find((it) => it.status === 'eligible' && it.category === 'temp');
  const snap = first.items.find((it) => it.category === 'snapshots');
  const post = (body) => f.request('post', '/targets/:kind/:id/cleanups', { ...f.app, body });
  const noAck = await post({ checkId: first.checkId, snapshots: [snap.id] });
  assert.deepEqual([noAck.status, noAck.body.error.code], [400, 'SNAPSHOT_ACK_REQUIRED']);
  const ok = await post({ checkId: first.checkId, items: [eligible.id], scope: 'all-eligible' });
  assert.equal(ok.status, 202);
  assert.deepEqual(ok.body, { changed: true, cleanupId: 'cln_00000000-0000-4000-8000-000000000001', jobId: 'job-1', estimate: { bytes: 10 } });
  assert.deepEqual(calls[0], { targetKey: 'application:1', checkId: first.checkId, items: [eligible.id], snapshots: [], exports: [], acknowledgeSnapshotLoss: false, scope: 'all-eligible', origin: 'user', userId: 7, ip: '10.0.0.5' });
  now += 61 * 60_000;
  const stale = await post({ checkId: first.checkId, items: [eligible.id] });
  assert.deepEqual([stale.status, stale.body.error.code], [409, 'CHECK_STALE']);
  assert.match(stale.body.error.message, /^Run a new storage check first; this one is from /);
  const second = await f.storage.runCheck('application:1');
  const superseded = await post({ checkId: first.checkId, items: [eligible.id] });
  assert.equal(superseded.status, 409);
  const foreign = await f.request('post', '/targets/:kind/:id/cleanups', { params: { kind: 'application', id: '1' }, body: { checkId: 'chk_00000000-0000-4000-8000-000000000077', items: [eligible.id] } });
  assert.equal(foreign.status, 409);
  const unknown = await f.request('post', '/targets/:kind/:id/cleanups', { params: { kind: 'application', id: '5' }, body: { checkId: second.checkId, items: [eligible.id] } });
  assert.equal(unknown.status, 404);
  const bad = await post({ checkId: second.checkId, items: ['../../etc'] });
  assert.deepEqual([bad.status, bad.body.error.code], [400, 'INVALID_REQUEST']);
  const extra = await post({ checkId: second.checkId, items: [eligible.id], paths: ['/'] });
  assert.equal(extra.status, 400, 'paths are never accepted from the client');
  assert.equal(calls.length, 1);
});

test('cleanup: until the cleanup service is wired the request answers 503; service errors keep their code and status', async (t) => {
  const f = fixture(t);
  const check = await f.storage.runCheck('application:1');
  const id = check.items.find((it) => it.status === 'eligible').id;
  const r = await f.request('post', '/targets/:kind/:id/cleanups', { ...f.app, body: { checkId: check.checkId, items: [id] } });
  assert.deepEqual([r.status, r.body.error.code], [503, 'CLEANUP_UNAVAILABLE']);
  f.storage.setCleanupService({ requestCleanup: async () => { throw Object.assign(new Error('A build or another change is running on this application; try again when it finishes.'), { code: 'GUEST_BUSY', status: 409 }); }, getCleanup: (cid) => (cid === 'cln_00000000-0000-4000-8000-000000000002' ? { id: cid, targetKey: 'application:1', checkId: check.checkId, status: 'running', origin: 'user', scope: 'items', selection: [{ id, label: 'x', category: 'temp', bytes: 5, path: '/secret/path' }], result: null, createdAt: 'now', job: { status: 'running', phase: 'remove', events: [] } } : null), listCleanups: () => [] });
  const busy = await f.request('post', '/targets/:kind/:id/cleanups', { ...f.app, body: { checkId: check.checkId, items: [id] } });
  assert.deepEqual([busy.status, busy.body.error.code], [409, 'GUEST_BUSY']);
  const got = await f.request('get', '/cleanups/:cleanupId', { params: { cleanupId: 'cln_00000000-0000-4000-8000-000000000002' } });
  assert.equal(got.status, 200);
  assert.deepEqual(got.body.selection, [{ id, label: 'x', category: 'temp', kind: undefined, bytes: 5 }]);
  assert.deepEqual(got.body.job, { status: 'running', phase: 'remove', events: [] });
  assert.equal((await f.request('get', '/cleanups/:cleanupId', { params: { cleanupId: 'cln_00000000-0000-4000-8000-000000000003' } })).status, 404);
  assert.equal((await f.request('get', '/cleanups/:cleanupId', { params: { cleanupId: '../x' } })).status, 404);
});

test('policy: read with defaults and effects; edit needs a valid whole document, is audited with what changed, refuses a lost update', async (t) => {
  const f = fixture(t);
  const g = await f.request('get', '/targets/:kind/:id/policy', f.app);
  assert.equal(g.status, 200);
  for (const k of ['policy', 'defaults', 'source', 'revision', 'effects', 'proposedRules']) assert.ok(k in g.body, k);
  assert.equal(g.body.source, 'preserved');
  const next = JSON.parse(JSON.stringify(g.body.policy));
  next.rules.tempFiles.enabled = true;
  const bad = await f.request('put', '/targets/:kind/:id/policy', { ...f.app, body: { policy: { ...next, rules: { ...next.rules, caches: { enabled: true, maxAgeDays: 0 } } }, expectedRevision: 0 } });
  assert.deepEqual([bad.status, bad.body.error.code], [400, 'INVALID_POLICY']);
  assert.ok(bad.body.error.issues.some((i) => i.path === 'rules.caches.maxAgeDays'));
  const put = await f.request('put', '/targets/:kind/:id/policy', { ...f.app, body: { policy: next, expectedRevision: 0 } });
  assert.equal(put.status, 200);
  assert.deepEqual([put.body.revision, put.body.source], [1, 'edited']);
  assert.deepEqual(put.body.proposedRules, ['caches', 'testArtifacts', 'logs', 'history'], 'the other proposals stay proposed');
  assert.deepEqual(f.audits.at(-1), ['STORAGE_POLICY_CHANGED', 'application:1', { revision: 1, changed: { 'rules.tempFiles.enabled': [false, true] }, previousSource: 'preserved' }]);
  const lost = await f.request('put', '/targets/:kind/:id/policy', { ...f.app, body: { policy: next, expectedRevision: 0 } });
  assert.deepEqual([lost.status, lost.body.error.code], [409, 'POLICY_CHANGED']);
  const shape = await f.request('put', '/targets/:kind/:id/policy', { ...f.app, body: next });
  assert.equal(shape.status, 400, 'the body is { policy, expectedRevision }');
});

test('PUT /policy requires expectedRevision, so a lost update is always detected', async (t) => {
  const f = fixture(t);
  const g = await f.request('get', '/targets/:kind/:id/policy', f.app);
  const next = JSON.parse(JSON.stringify(g.body.policy));
  next.rules.tempFiles.enabled = true;
  const missing = await f.request('put', '/targets/:kind/:id/policy', { ...f.app, body: { policy: next } });
  assert.deepEqual([missing.status, missing.body.error.code], [400, 'INVALID_REQUEST']);
  assert.match(missing.body.error.message, /expectedRevision is required/);
  assert.equal(f.storage.getPolicy('application:1').revision, g.body.revision, 'nothing was saved');
  const notNumber = await f.request('put', '/targets/:kind/:id/policy', { ...f.app, body: { policy: next, expectedRevision: '0' } });
  assert.equal(notNumber.status, 400);
  const ok = await f.request('put', '/targets/:kind/:id/policy', { ...f.app, body: { policy: next, expectedRevision: g.body.revision } });
  assert.equal(ok.status, 200);
});

test('only a typed error reaches the caller; a database or other error is a generic 500, logged on the server', async (t) => {
  const logs = [];
  const f = fixture(t, { logs });
  f.storage.overview = () => { throw Object.assign(new Error('SQLITE_BUSY: database is locked (mock2_storage_checks)'), { code: 'SQLITE_BUSY' }); };
  const busy = await f.request('get', '/overview');
  assert.deepEqual(busy, { status: 500, body: { error: { code: 'APP_STORAGE_FAILED', message: 'The storage request failed.' } } });
  assert.equal(logs.length, 1);
  assert.match(String(logs[0].at(-1)), /database is locked/, 'the detail is in the server log only');
  f.storage.overview = () => { throw new TypeError('x is not a function'); };
  assert.deepEqual((await f.request('get', '/overview')).body.error, { code: 'APP_STORAGE_FAILED', message: 'The storage request failed.' });
  f.storage.overview = () => { throw Object.assign(new Error('weird'), { code: 'SOMETHING', status: 'bad' }); };
  assert.equal((await f.request('get', '/overview')).status, 500);
  // A typed error keeps its status, code and plain message.
  const unknown = await f.request('get', '/targets/:kind/:id', { params: { kind: 'application', id: '999' } });
  assert.equal(unknown.status, 404);
  assert.equal(typeof unknown.body.error.code, 'string');
  assert.notEqual(unknown.body.error.code, 'APP_STORAGE_FAILED');
});
