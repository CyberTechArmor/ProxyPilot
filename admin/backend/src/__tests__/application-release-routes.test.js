import test from 'node:test';
import assert from 'node:assert/strict';
import { registerApplicationReleaseRoutes } from '../routes/application-releases.js';

function fixture(overrides = {}) {
  const calls = [], routes = new Map();
  const router = Object.fromEntries(['get', 'post', 'put'].map(method => [method, (path, ...handlers) => routes.set(`${method} ${path}`, handlers)]));
  const requireAdmin = (_req, _res, next) => next(), requireSudo = (_req, _res, next) => next();
  const application = { id: 'a', targetId: 'nodus' };
  const service = {
    listApplications: () => [application, { id: 'b', targetId: 'other' }], getApplication: id => id === 'a' ? application : null,
    importApplication: async profile => { calls.push(['import', profile]); return application; },
    updateProfile: async (...args) => { calls.push(['update', ...args]); return application; },
    checkpoint: async (...args) => { calls.push(['checkpoint', ...args]); return { application, candidate: { sha: 'a'.repeat(40) } }; },
    prepareCandidate: async (...args) => { calls.push(['prepare', ...args]); return { appId: 'a', profile: { revision: 2 }, candidate: { sha: 'a'.repeat(40) }, gitDir: '/internal/git' }; },
    commitChanges: async (...args) => { calls.push(['commit', ...args]); return { application, candidate: { sha: 'c'.repeat(40) } }; },
    mergeCandidate: async (...args) => { calls.push(['merge', ...args]); return { ok: true }; },
    reconcileOperation: async (...args) => { calls.push(['reconcile', ...args]); return { reconciled: true }; },
    publishCandidate: async (...args) => { calls.push(['publish', ...args]); return { verified: false }; },
    verifyRemote: async (...args) => { calls.push(['remote', ...args]); return { verified: true }; },
  };
  const deps = { service: () => service, requireAdmin, requireSudo, submitJob: async value => { calls.push(['job', value]); return { job: { id: 'j', status: 'queued' }, created: true }; }, listJobs: async () => [{ id: 'j' }], jobDetail: async id => ({ job: { id, status: 'running' }, events: [] }), ...overrides };
  registerApplicationReleaseRoutes(router, deps);
  async function request(method, path, extra = {}) {
    const handlers = routes.get(`${method} ${path}`); assert.ok(handlers, path);
    let status = 200, response;
    const req = { params: { id: 'a' }, query: {}, body: {}, user: { id: 7 }, ...extra };
    const res = { status(code) { status = code; return this; }, json(value) { response = value; return this; } };
    await handlers.at(-1)(req, res, error => { throw error; }); return { status, response, handlers };
  }
  return { calls, routes, requireAdmin, requireSudo, request };
}

test('registration requires read/write guards; target-filtered reads remain scoped', async () => {
  assert.throws(() => registerApplicationReleaseRoutes({}, {}), /service dependency/);
  const f = fixture();
  for (const [route, handlers] of f.routes) {
    assert.equal(handlers[0], f.requireAdmin, route);
    if (!route.startsWith('get ')) assert.equal(handlers[1], f.requireSudo, route);
  }
  const { response } = await f.request('get', '/', { query: { targetId: 'nodus' } });
  assert.deepEqual(response.applications.map(a => a.id), ['a']);
});
test('existing-app import preserves optional preparation script for domain validation', async () => {
  const f = fixture();
  assert.equal((await f.request('post', '/', { body: { installScript: 'dependencies:prepare' } })).status, 201);
  assert.equal(f.calls[0][1].installScript, 'dependencies:prepare');
  f.calls.length = 0;
  assert.equal((await f.request('post', '/', { body: { name: 'Nodus', targetId: 'nodus' } })).status, 201);
  assert.equal(f.calls[0][1].installScript, null);
});
test('jobs resolve exact candidate server-side and never accept client proof', async () => {
  const f = fixture();
  assert.equal((await f.request('post', '/:id/deploy', { body: { sha: 'HEAD' } })).status, 400);
  const r = await f.request('post', '/:id/validate', { body: { sha: 'b'.repeat(40), passed: true, profile: { sourceDir: '/evil' } } });
  assert.equal(r.status, 202);
  assert.deepEqual(f.calls[0], ['job', { kind: 'application_validate', appId: 'a', sha: 'b'.repeat(40), requestedBy: 7, via: 'ui' }]);
});
test('preparation does not expose git transport directory or mark validation complete', async () => {
  const f = fixture(); const r = await f.request('post', '/:id/prepare', { body: { sha: 'a'.repeat(40) } });
  assert.equal(r.response.profileRevision, 2); assert.equal(r.response.gitDir, undefined); assert.equal(r.response.candidate.validation, undefined);
});
test('profile updates require current revision and preserve named preparation', async () => {
  const f = fixture();
  assert.equal((await f.request('put', '/:id/profile', { body: { profile: {} } })).status, 400);
  await f.request('put', '/:id/profile', { body: { expectedRevision: 2, profile: { installScript: 'dependencies:prepare' } } });
  assert.equal(f.calls[0][2].installScript, 'dependencies:prepare');
  f.calls.length = 0;
  await f.request('put', '/:id/profile', { body: { expectedRevision: 2, profile: { name: 'Nodus' } } });
  assert.deepEqual(f.calls[0], ['update', 'a', { name: 'Nodus', installScript: null }, { expectedRevision: 2 }]);
});
test('job details cannot read another application job and unknown apps return 404', async () => {
  const f = fixture();
  assert.equal((await f.request('get', '/:id/jobs/:jobId', { params: { id: 'a', jobId: 'foreign' } })).status, 404);
  const r = await f.request('get', '/:id/jobs/:jobId', { params: { id: 'a', jobId: 'j' } }); assert.equal(r.response.job.status, 'running');
  assert.equal((await f.request('get', '/:id', { params: { id: 'missing' } })).status, 404);
});
test('runner blockers preserve actionable refusal rather than report a job success', async () => {
  const f = fixture({ submitJob: async () => ({ error: 'Current source path is not a supported release symlink.', code: 'UNSUPPORTED_LAYOUT', next_action: 'Prepare a reviewed layout migration.' }) });
  const r = await f.request('post', '/:id/deploy', { body: { sha: 'a'.repeat(40) } });
  assert.equal(r.status, 409); assert.equal(r.response.code, 'UNSUPPORTED_LAYOUT'); assert.equal(r.response.job, undefined);
});

test('async service getter supports checkpoint, publication, commits and explicit merge', async () => {
  const source = fixture();
  const service = { getApplication: () => ({ id: 'a' }), checkpoint: async () => ({ candidate: { sha: 'a'.repeat(40) } }), publishCandidate: async () => ({ ok: false, error: 'Readback failed' }), commitChanges: async (_id, body) => ({ candidate: { sha: 'b'.repeat(40), parent: body.parentSha } }), mergeCandidate: async (_id, body) => body };
  const f = fixture({ service: async () => service });
  assert.equal((await f.request('post', '/:id/checkpoint', { body: { ref: 'main' } })).response.candidate.sha, 'a'.repeat(40));
  assert.equal((await f.request('post', '/:id/publish', { body: { sha: 'a'.repeat(40) } })).response.publication.ok, false);
  assert.equal((await f.request('post', '/:id/commit', { body: { patch: 'diff --git a/a b/a', message: 'Change', branch: 'feature/change', expectedParentSha: 'a'.repeat(40) } })).response.candidate.parent, 'a'.repeat(40));
  assert.equal((await f.request('post', '/:id/merge', { body: { sha: 'b'.repeat(40), expectedRemoteSha: 'a'.repeat(40) } })).response.publication.expectedRemoteSha, 'a'.repeat(40));
  assert.equal((await source.request('post', '/:id/commit', { body: { patch: 'diff', message: 'Change', branch: 'main', expectedParentSha: 'HEAD' } })).status, 400);
});

test('commit route maps public expected-parent field to the domain parentSha contract', async () => {
  const f = fixture();
  const input = { patch: 'diff --git a/a b/a', message: 'Reviewed change', branch: 'review/change', expectedParentSha: 'a'.repeat(40) };
  await f.request('post', '/:id/commit', { body: input });
  assert.deepEqual(f.calls[0], ['commit', 'a', { patch: input.patch, message: input.message, branch: input.branch, parentSha: input.expectedParentSha }]);
  assert.equal(Object.hasOwn(f.calls[0][2], 'expectedParentSha'), false);
});
test('merge accepts explicit absent branch but never infers absence from an empty or missing SHA', async () => {
  const f = fixture();
  for (const expectedRemoteSha of ['', undefined]) assert.equal((await f.request('post', '/:id/merge', { body: { sha: 'a'.repeat(40), expectedRemoteSha } })).status, 400);
  const r = await f.request('post', '/:id/merge', { body: { sha: 'a'.repeat(40), expectedRemoteSha: null } });
  assert.equal(r.status, 200);
  assert.deepEqual(f.calls[0], ['merge', 'a', { sha: 'a'.repeat(40), expectedRemoteSha: null }]);
});
test('domain preparation validation failure is returned without a successful registration', async () => {
  const f = fixture({ service: async () => ({ importApplication: async () => { throw Object.assign(new Error('Specify a named npm script, not a command.'), { status: 400, code: 'INVALID_PROFILE' }); } }) });
  const r = await f.request('post', '/', { body: { installScript: '/arbitrary/shell' } });
  assert.equal(r.status, 400); assert.equal(r.response.code, 'INVALID_PROFILE'); assert.equal(r.response.application, undefined);
});
