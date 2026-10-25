// Application foundation — orchestration (mock2/foundation-service.js) and the
// HTTP surface (mock2/foundation-routes.js), against the real store over
// migration 564 and a scripted guest (helpers/foundation-world.js):
//   * the switch flow: stage pending → sync → test inside the guest → promote
//     or start the job; promotion stops a service no longer used;
//   * storage: off refused with objects, copy job → poll → promote, fresh,
//     test failure / missing credentials keep the switch staged, nothing applied;
//   * embeddings: no active index promotes at once; an active index re-embeds
//     into a NEW index, validated before the swap; an invalid index never swaps;
//   * one job per deployment; cancel; a refused promotion restores mock2.db;
//     the sweep relaunches a stalled job; legacy projects have no switches;
//   * routes: viewer/editor/sudo/archived chains, 409 { code, message, options },
//     credentials write-only — no secret in any response or audit entry.

import test from 'node:test';
import assert from 'node:assert/strict';
import { installFoundationHooks, freshMock2Db, addProject, scriptedStack } from './helpers/foundation-world.js';
import { SECRET_NAMES, LOCAL_EMBEDDINGS_WARNING, DEPENDENT_CAPABILITIES } from '../mock2/foundation-contract.js';
import { CODES, BUNDLED_APP_IDENTITY } from '../mock2/foundation-logic.js';

process.env.TOTP_ENCRYPTION_KEY = 'b'.repeat(64);
installFoundationHooks();
const store = await import('../mock2/foundation-store.js');
const service = await import('../mock2/foundation-service.js');
const { registerFoundationRoutes } = await import('../mock2/foundation-routes.js');

const S3 = { endpoint: 'https://acct.r2.cloudflarestorage.com', bucket: 'app-files', region: 'auto' };
const KEY_ID = 'AKIAR2EXAMPLE0000001';
const SECRET = 'r2-secret-PLANTED-0123456789abcdefghij';
const API_KEY = 'sk-proj-PLANTED0123456789abcdefXYZ';

function setup({ objects = 0 } = {}) {
  service.resetFoundationServiceCaches();
  const db = freshMock2Db();
  addProject(db, { id: 1 });
  const g = scriptedStack();
  g.guest.objectCount = objects;
  const inputs = store.getFoundationProvisionInputs(1);
  return { db, ...g, inputs };
}

// Routes over a captured router, with the real service.
function routes() {
  const table = new Map(); const audits = [];
  const router = { get: (p, ...h) => table.set(`get ${p}`, h), post: (p, ...h) => table.set(`post ${p}`, h) };
  const requireRole = (role) => Object.assign((req, _res, next) => next(), { role });
  const requireSudo = (_req, _res, next) => next();
  const refuseIfArchived = (_req, _res, next) => next();
  registerFoundationRoutes(router, { requireRole, requireSudo, refuseIfArchived, audit: (req, action, id, detail) => audits.push({ action, id, detail }), service });
  const responses = [];
  async function call(method, path, { params = {}, body } = {}) {
    const handlers = table.get(`${method} ${path}`);
    assert.ok(handlers, path);
    let status = 200; let json;
    const req = { params: { id: '1', ...params }, body, user: { id: 9 }, ip: '10.0.0.2', mock2Project: { id: 1 } };
    const res = { status(c) { status = c; return this; }, json(v) { json = v; return this; } };
    await handlers.at(-1)(req, res, (e) => { throw e; });
    responses.push(json);
    return { status, body: json };
  }
  return { table, audits, call, responses, requireSudo, refuseIfArchived };
}

const noPlanted = (thing, extra = []) => {
  const s = JSON.stringify(thing);
  for (const p of [SECRET, KEY_ID, API_KEY, ...extra]) assert.equal(s.includes(p), false, `secret leaked: ${p.slice(0, 8)}…`);
};

test('routes: GET needs viewer; writes need editor, refuse archived, and need sudo; health needs editor without sudo', () => {
  const r = routes();
  const expect = {
    'get /projects/:id/foundation': ['viewer', false, false],
    'post /projects/:id/foundation/storage': ['editor', true, true],
    'post /projects/:id/foundation/embeddings': ['editor', true, true],
    'post /projects/:id/foundation/health': ['editor', true, false],
    'get /projects/:id/foundation/jobs/:jobId': ['viewer', false, false],
    'post /projects/:id/foundation/jobs/:jobId/cancel': ['editor', true, true],
  };
  assert.deepEqual([...r.table.keys()].sort(), Object.keys(expect).sort());
  for (const [route, [role, archived, sudo]] of Object.entries(expect)) {
    const h = r.table.get(route);
    assert.equal(h[0].role, role, route);
    assert.equal(h.includes(r.refuseIfArchived), archived, route);
    assert.equal(h.includes(r.requireSudo), sudo, route);
  }
  assert.throws(() => registerFoundationRoutes({ get() {}, post() {} }, {}), /dependency is required/);
});

test('GET: the state, defaults, dependents and the local-embeddings warning; never a secret', async () => {
  const { inputs } = setup();
  const r = routes();
  const { status, body } = await r.call('get', '/projects/:id/foundation');
  assert.equal(status, 200);
  assert.equal(body.storage.provider, 'bundled');
  assert.equal(body.storage.has_secret, true);
  assert.deepEqual(body.storage.dependents, [...DEPENDENT_CAPABILITIES.storage]);
  assert.equal(body.embeddings.warning, LOCAL_EMBEDDINGS_WARNING);
  assert.equal(body.embeddings.health.status, 'unavailable', 'no probe has run');
  noPlanted(body, [inputs.masterKey, inputs.storageCredentials.app.secretAccessKey, inputs.storageCredentials.admin.secretAccessKey]);
  const h = await r.call('post', '/projects/:id/foundation/health', { body: {} });
  assert.equal(h.body.database.health.status, 'ready');
  assert.equal(h.body.storage.health.status, 'ready');
});

test('storage: bundled holding objects cannot be turned off — 409 { code, message, options }, nothing changed, audited as refused', async () => {
  const { calls } = setup({ objects: 4 });
  const r = routes();
  const res = await r.call('post', '/projects/:id/foundation/storage', { body: { action: 'off' } });
  assert.equal(res.status, 409);
  assert.deepEqual(Object.keys(res.body).sort(), ['code', 'message', 'object_count', 'options']);
  assert.equal(res.body.code, CODES.STORAGE_HAS_OBJECTS);
  assert.equal(res.body.object_count, 4);
  assert.equal(store.readFeatureRows(1).storage.state, 'on');
  assert.deepEqual(calls.services, []);
  assert.equal(calls.counts.length, 1);
  assert.deepEqual(calls.counts[0], store.bundledAdminCredentials(1), 'counted with the host-only admin identity');
  assert.deepEqual(r.audits.at(-1), { action: 'MOCK2_FOUNDATION_STORAGE_OFF', id: 1, detail: { feature: 'storage', action: 'off', provider: null, mode: null, acknowledge: false, credentials_supplied: [], outcome: 'refused', code: CODES.STORAGE_HAS_OBJECTS } });
});

test('storage: bundled and empty → off: synced first, then the container stopped; back on starts it again', async () => {
  const { guest, calls } = setup({ objects: 0 });
  const r = routes();
  const off = await r.call('post', '/projects/:id/foundation/storage', { body: { action: 'off' } });
  assert.equal(off.status, 200);
  assert.equal(off.body.state, 'off');
  assert.equal(store.readFeatureRows(1).storage.state, 'off');
  assert.match(guest.lastSync, /VALUES \('storage', 'off', 'bundled'/);
  assert.deepEqual(calls.services, [['storage', 'stop']]);
  const on = await r.call('post', '/projects/:id/foundation/storage', { body: { action: 'on' } });
  assert.equal(on.body.state, 'on');
  assert.deepEqual(calls.services, [['storage', 'stop'], ['storage', 'start']]);
  assert.equal((await r.call('post', '/projects/:id/foundation/storage', { body: { action: 'on' } })).body.noop, true);
});

test('storage: switch to external with mode copy — staged, tested in the guest, job in both databases, polled, promoted, bundled stopped', async () => {
  const { guest, calls, inputs } = setup({ objects: 7 });
  const r = routes();
  const res = await r.call('post', '/projects/:id/foundation/storage', { body: { action: 'switch', provider: 'external', config: S3, credentials: { access_key_id: KEY_ID, secret_access_key: SECRET }, mode: 'copy' } });
  assert.equal(res.status, 202);
  const jobId = res.body.job.id;
  assert.match(jobId, /^fj_/);
  assert.equal(res.body.job.kind, 'storage_migrate');
  assert.deepEqual(calls.cli.map((c) => c.args), [['storage-test', '--pending', '--json'], ['health', '--json']].slice(0, 1));
  assert.equal(calls.cli[0].opts.appDir, '/srv/app');
  const staged = store.readFeatureRows(1).storage;
  assert.equal(staged.provider, 'bundled', 'not promoted while the copy runs');
  assert.equal(staged.pending.provider, 'external');
  assert.equal(staged.pending.job_id, jobId);
  assert.equal(staged.pending.test.ok, true);
  assert.equal(store.readSecret(1, 'pending.storage.secret_access_key'), SECRET);
  assert.ok(guest.jobs[jobId], 'the job row is in the app database');
  assert.deepEqual(calls.detached.map((d) => d.jobId), [jobId]);
  assert.match(calls.psql.find((c) => c.sql.includes('MF_GENERATION')).sql, /"provider":"external"/, 'the pending provider was synced before the test');
  // Another write while the job runs is refused.
  const busy = await r.call('post', '/projects/:id/foundation/embeddings', { body: { action: 'off' } });
  assert.deepEqual([busy.status, busy.body.code], [409, CODES.FOUNDATION_JOB_RUNNING]);
  // Running → still staged.
  guest.jobs[jobId].state = 'running'; guest.jobs[jobId].progress = { copied: 3, total: 7 };
  const mid = await r.call('get', '/projects/:id/foundation/jobs/:jobId', { params: { jobId } });
  assert.deepEqual([mid.body.job.state, mid.body.job.progress.copied], ['running', 3]);
  // Succeeded → promoted: storage.* are the external credentials; bundled identity retained; bundled stopped.
  guest.jobs[jobId].state = 'succeeded';
  const done = await r.call('get', '/projects/:id/foundation/jobs/:jobId', { params: { jobId } });
  assert.equal(done.body.job.state, 'succeeded');
  const rows = store.readFeatureRows(1).storage;
  assert.deepEqual([rows.state, rows.provider, rows.pending], ['on', 'external', null]);
  assert.equal(rows.config.bucket, 'app-files');
  assert.equal(store.readSecret(1, SECRET_NAMES.storageSecretAccessKey), SECRET);
  assert.equal(store.hasSecret(1, 'pending.storage.secret_access_key'), false);
  assert.equal(store.readSecret(1, BUNDLED_APP_IDENTITY.secretAccessKey), inputs.storageCredentials.app.secretAccessKey, 'kept for a switch back');
  assert.deepEqual(calls.services.at(-1), ['storage', 'stop']);
  const view = await r.call('get', '/projects/:id/foundation');
  assert.equal(view.body.storage.provider, 'external');
  assert.equal(view.body.storage.has_secret, true);
  for (const resp of r.responses) noPlanted(resp);
  for (const a of r.audits) noPlanted(a);
  assert.deepEqual(r.audits[0].detail.credentials_supplied, ['access_key_id', 'secret_access_key']);
  assert.equal(r.audits[0].detail.job_id, jobId);
  // The provisioning inputs did not change under the switch.
  assert.deepEqual(store.getFoundationProvisionInputs(1).storageCredentials, inputs.storageCredentials);
});

test('storage: fresh needs acknowledge; with it the external provider is promoted at once (bundled objects stay in the preserved volume)', async () => {
  const { calls } = setup({ objects: 2 });
  const r = routes();
  const body = { action: 'switch', provider: 'external', config: S3, credentials: { access_key_id: KEY_ID, secret_access_key: SECRET }, mode: 'fresh' };
  const noAck = await r.call('post', '/projects/:id/foundation/storage', { body });
  assert.equal(noAck.body.code, CODES.ACKNOWLEDGE_REQUIRED);
  assert.equal(store.readFeatureRows(1).storage.pending, null, 'a refusal stages nothing');
  const ok = await r.call('post', '/projects/:id/foundation/storage', { body: { ...body, acknowledge: true } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.promoted, true);
  assert.equal(store.readFeatureRows(1).storage.provider, 'external');
  assert.deepEqual(calls.services, [['storage', 'stop']], 'stopped, never removed');
  // And back: external → bundled fresh restores the bundled identity and starts the container.
  const back = await r.call('post', '/projects/:id/foundation/storage', { body: { action: 'switch', provider: 'bundled', mode: 'fresh', acknowledge: true } });
  assert.equal(back.body.promoted, true);
  assert.equal(store.readSecret(1, SECRET_NAMES.storageAccessKeyId), store.readSecret(1, BUNDLED_APP_IDENTITY.accessKeyId));
  assert.deepEqual(calls.services.slice(1), [['storage', 'start']], 'started for the test and left running (in use)');
  for (const resp of r.responses) noPlanted(resp);
});

test('storage: a failed test or missing credentials applies nothing; the switch stays staged; the CLI output never leaks the secret', async () => {
  const { guest } = setup({ objects: 0 });
  const r = routes();
  guest.cli['storage-test'] = { code: 1, stdout: JSON.stringify({ status: 'degraded', detail: { message: `SignatureDoesNotMatch for ${KEY_ID} using ${SECRET}` } }) };
  const body = { action: 'switch', provider: 'external', config: S3, credentials: { access_key_id: KEY_ID, secret_access_key: SECRET } };
  const fail = await r.call('post', '/projects/:id/foundation/storage', { body });
  assert.deepEqual([fail.status, fail.body.code], [409, CODES.PROVIDER_TEST_FAILED]);
  const rows = store.readFeatureRows(1).storage;
  assert.equal(rows.provider, 'bundled');
  assert.equal(rows.pending.test.ok, false);
  noPlanted(rows.pending);
  noPlanted(fail.body);
  noPlanted((await r.call('get', '/projects/:id/foundation')).body);
  guest.cli['storage-test'] = { code: 2, stdout: '{"status":"missing_credentials","detail":{"message":"no credentials"}}' };
  const missing = await r.call('post', '/projects/:id/foundation/storage', { body });
  assert.equal(missing.body.code, CODES.MISSING_CREDENTIALS);
  assert.equal(store.readFeatureRows(1).storage.provider, 'bundled');
});

test('embeddings: local → OpenAI with no active index promotes at once and stops the local container; with no key it is refused', async () => {
  const { calls, guest } = setup();
  const r = routes();
  const missing = await r.call('post', '/projects/:id/foundation/embeddings', { body: { action: 'switch', provider: 'openai' } });
  assert.equal(missing.body.code, CODES.MISSING_CREDENTIALS);
  const ok = await r.call('post', '/projects/:id/foundation/embeddings', { body: { action: 'switch', provider: 'openai', credentials: { api_key: API_KEY } } });
  assert.equal(ok.status, 200);
  assert.deepEqual([ok.body.promoted, ok.body.reembedded], [true, false]);
  const row = store.readFeatureRows(1).embeddings;
  assert.deepEqual([row.provider, row.config.model, row.config.dimensions], ['openai', 'text-embedding-3-small', 1536]);
  assert.equal(store.readSecret(1, SECRET_NAMES.embeddingsApiKey), API_KEY);
  assert.deepEqual(calls.services, [['embeddings', 'stop']]);
  assert.equal(guest.lastSync.includes(API_KEY), false);
  const view = (await r.call('get', '/projects/:id/foundation')).body;
  assert.equal(view.embeddings.warning, undefined, 'no local warning once OpenAI is active');
  assert.equal(view.warnings.some((w) => w.code === 'LOCAL_EMBEDDINGS'), false);
  for (const resp of r.responses) noPlanted(resp);
  for (const a of r.audits) noPlanted(a);
});

test('embeddings: with an active index a provider change re-embeds into a NEW index; it is swapped only once validated', async () => {
  const { guest, calls } = setup();
  guest.activeIndex = { id: 'ix_local0001', provider: 'local', model: 'BAAI/bge-small-en-v1.5', dimensions: 384, metric: 'cosine', item_count: 50 };
  guest.indexes.ix_local0001 = { ...guest.activeIndex, state: 'active' };
  const r = routes();
  const res = await r.call('post', '/projects/:id/foundation/embeddings', { body: { action: 'switch', provider: 'openai', credentials: { api_key: API_KEY } } });
  assert.equal(res.status, 202);
  const { id: jobId, target_index: target } = res.body.job;
  assert.equal(res.body.job.kind, 'reembed');
  assert.deepEqual(res.body.job.from, { provider: 'local', model: 'BAAI/bge-small-en-v1.5', dimensions: 384 });
  assert.equal(guest.indexes[target].state, 'building', 'the target index row exists, building');
  assert.equal(guest.indexes[target].dimensions, 1536);
  // The job "succeeds" but the index never validated: nothing is swapped.
  guest.jobs[jobId].state = 'succeeded';
  const bad = await service.getJob(1, jobId);
  assert.equal(bad.state, 'failed');
  assert.match(bad.error, /did not validate/);
  assert.equal(store.readFeatureRows(1).embeddings.provider, 'local');
  assert.equal(guest.activeIndex.id, 'ix_local0001');
  // Again, and this time the index is ready: one transaction swaps index and provider.
  const again = await r.call('post', '/projects/:id/foundation/embeddings', { body: { action: 'switch', provider: 'openai', credentials: { api_key: API_KEY } } });
  const job2 = again.body.job;
  guest.jobs[job2.id].state = 'succeeded';
  guest.indexes[job2.target_index].state = 'ready';
  const done = await service.getJob(1, job2.id);
  assert.equal(done.state, 'succeeded');
  assert.equal(guest.activeIndex.id, job2.target_index);
  assert.equal(guest.indexes.ix_local0001.state, 'retired', 'the old index is kept, retired');
  const promoteSql = guest.lastSync;
  assert.ok(promoteSql.indexOf("SET state = 'retired'") < promoteSql.indexOf("INSERT INTO mock2_foundation.features"), 'index swap and provider switch in the same transaction');
  assert.equal(store.readFeatureRows(1).embeddings.provider, 'openai');
  assert.deepEqual(calls.services.at(-1), ['embeddings', 'stop'], 'the local model is no longer used');
});

test('embeddings: an active index that does not match the provider (a full clone, an old restore) is warned and repaired by switching to the current provider', async () => {
  const { guest } = setup();
  // The feature row says OpenAI (with its key); the database brought a local index.
  const r = routes();
  const toOpenai = await r.call('post', '/projects/:id/foundation/embeddings', { body: { action: 'switch', provider: 'openai', credentials: { api_key: API_KEY } } });
  assert.equal(toOpenai.body.promoted, true);
  guest.activeIndex = { id: 'ix_local0001', provider: 'local', model: 'BAAI/bge-small-en-v1.5', dimensions: 384, metric: 'cosine', item_count: 12 };
  guest.indexes.ix_local0001 = { ...guest.activeIndex, state: 'active' };
  service.resetFoundationServiceCaches();
  const view = (await r.call('get', '/projects/:id/foundation')).body;
  const w = view.warnings.find((x) => x.code === 'INDEX_PROVIDER_MISMATCH');
  assert.ok(w, 'GET warns');
  assert.deepEqual(w.options[0].provider, 'openai');
  // The next step: "switch to the current provider" re-embeds into a NEW index (the stored key is reused).
  const repair = await r.call('post', '/projects/:id/foundation/embeddings', { body: { action: 'switch', provider: 'openai' } });
  assert.equal(repair.status, 202, JSON.stringify(repair.body));
  assert.equal(repair.body.job.kind, 'reembed');
  assert.deepEqual(repair.body.job.from, { provider: 'local', model: 'BAAI/bge-small-en-v1.5', dimensions: 384 });
  assert.deepEqual(repair.body.job.to, { provider: 'openai', model: 'text-embedding-3-small', dimensions: 1536 });
  assert.equal(store.readSecret(1, 'pending.embeddings.api_key'), API_KEY, 'reuse_active');
  const target = repair.body.job.target_index;
  guest.jobs[repair.body.job.id].state = 'succeeded';
  Object.assign(guest.indexes[target], { state: 'ready', item_count: 12 });
  assert.equal((await service.getJob(1, repair.body.job.id)).state, 'succeeded');
  assert.equal(guest.activeIndex.id, target);
  assert.equal(guest.indexes.ix_local0001.state, 'retired');
  service.resetFoundationServiceCaches();
  assert.equal((await r.call('get', '/projects/:id/foundation')).body.warnings.some((x) => x.code === 'INDEX_PROVIDER_MISMATCH'), false);
  for (const resp of r.responses) noPlanted(resp);
});

test('embeddings: switching the provider to the space the active index is already in promotes at once (nothing to rebuild)', async () => {
  const { guest } = setup();
  // The feature row is local; a restored dump brought an OpenAI index.
  guest.activeIndex = { id: 'ix_openai001', provider: 'openai', model: 'text-embedding-3-small', dimensions: 1536, metric: 'cosine', item_count: 3 };
  guest.indexes.ix_openai001 = { ...guest.activeIndex, state: 'active' };
  const r = routes();
  const res = await r.call('post', '/projects/:id/foundation/embeddings', { body: { action: 'switch', provider: 'openai', credentials: { api_key: API_KEY } } });
  assert.equal(res.status, 200);
  assert.deepEqual([res.body.promoted, res.body.reembedded], [true, false]);
  assert.equal(store.readFeatureRows(1).embeddings.provider, 'openai');
  assert.equal(guest.activeIndex.id, 'ix_openai001', 'the matching index stays active');
});

test('a promotion the app database refuses leaves mock2.db exactly as it was (the job keeps promoting)', async () => {
  const { guest } = setup({ objects: 1 });
  const r = routes();
  const res = await r.call('post', '/projects/:id/foundation/storage', { body: { action: 'switch', provider: 'external', config: S3, credentials: { access_key_id: KEY_ID, secret_access_key: SECRET }, mode: 'copy' } });
  const jobId = res.body.job.id;
  const before = store.readFeatureRows(1).storage;
  guest.jobs[jobId].state = 'succeeded';
  guest.failSync = true;
  const j = await service.getJob(1, jobId);
  assert.equal(j.state, 'running');
  assert.match(j.error, /promotion pending/);
  const after = store.readFeatureRows(1).storage;
  assert.deepEqual([after.provider, after.pending.job_id], [before.provider, jobId]);
  assert.equal(store.readSecret(1, 'pending.storage.secret_access_key'), SECRET, 'pending credentials restored');
  assert.notEqual(store.readSecret(1, SECRET_NAMES.storageSecretAccessKey), SECRET, 'active credentials restored');
  guest.failSync = false;
  const out = await service.sweepFoundationJobs();
  assert.equal(out.polled, 1);
  assert.equal(store.getJob(jobId).state, 'succeeded');
  assert.equal(store.readFeatureRows(1).storage.provider, 'external');
});

test('cancel: the job ends host-side, the guest is told, the staged switch is abandoned; a finished job cannot be cancelled', async () => {
  const { guest } = setup({ objects: 3 });
  const r = routes();
  const res = await r.call('post', '/projects/:id/foundation/storage', { body: { action: 'switch', provider: 'external', config: S3, credentials: { access_key_id: KEY_ID, secret_access_key: SECRET }, mode: 'copy' } });
  const jobId = res.body.job.id;
  const c = await r.call('post', '/projects/:id/foundation/jobs/:jobId/cancel', { params: { jobId } });
  assert.equal(c.status, 200);
  assert.equal(c.body.job.state, 'cancelled');
  assert.equal(c.body.app_cancelled, true);
  assert.equal(guest.jobs[jobId].state, 'cancelled');
  assert.equal(store.readFeatureRows(1).storage.pending, null);
  assert.equal(store.hasSecret(1, 'pending.storage.secret_access_key'), false);
  const again = await r.call('post', '/projects/:id/foundation/jobs/:jobId/cancel', { params: { jobId } });
  assert.deepEqual([again.status, again.body.code], [409, CODES.JOB_NOT_ACTIVE]);
  const nf = await r.call('post', '/projects/:id/foundation/jobs/:jobId/cancel', { params: { jobId: 'fj_000000000000' } });
  assert.deepEqual([nf.status, nf.body.code], [404, CODES.JOB_NOT_FOUND]);
  assert.equal((await r.call('get', '/projects/:id/foundation/jobs/:jobId', { params: { jobId: '../etc' } })).status, 404);
  assert.deepEqual(r.audits.at(-1).detail, { job_id: 'fj_000000000000', outcome: 'refused', code: CODES.JOB_NOT_FOUND });
});

test('a cancel never interleaves with a promotion: during it the cancel is refused busy; before it nothing is promoted', async () => {
  {
    const { guest, stack } = setup({ objects: 2 });
    const r = routes();
    const res = await r.call('post', '/projects/:id/foundation/storage', { body: { action: 'switch', provider: 'external', config: S3, credentials: { access_key_id: KEY_ID, secret_access_key: SECRET }, mode: 'copy' } });
    const jobId = res.body.job.id;
    guest.jobs[jobId].state = 'succeeded';
    const cli = stack.foundationCli;
    stack.foundationCli = async (...a) => { await new Promise((ok) => setTimeout(ok, 150)); return cli(...a); };
    const sweep = service.sweepFoundationJobs();
    await new Promise((ok) => setTimeout(ok, 40));
    const c = await r.call('post', '/projects/:id/foundation/jobs/:jobId/cancel', { params: { jobId } });
    assert.deepEqual([c.status, c.body.code], [409, CODES.FOUNDATION_BUSY], 'a cancel during the promotion is refused, not falsely "cancelled"');
    await sweep;
    assert.equal(store.getJob(jobId).state, 'succeeded');
    assert.equal(store.readFeatureRows(1).storage.provider, 'external');
  }
  {
    const { guest } = setup({ objects: 2 });
    const r = routes();
    const res = await r.call('post', '/projects/:id/foundation/storage', { body: { action: 'switch', provider: 'external', config: S3, credentials: { access_key_id: KEY_ID, secret_access_key: SECRET }, mode: 'copy' } });
    const jobId = res.body.job.id;
    const c = await r.call('post', '/projects/:id/foundation/jobs/:jobId/cancel', { params: { jobId } });
    assert.equal(c.body.job.state, 'cancelled');
    guest.jobs[jobId].state = 'succeeded';   // the guest finished anyway
    await service.sweepFoundationJobs();
    assert.equal(store.getJob(jobId).state, 'cancelled');
    assert.equal(store.readFeatureRows(1).storage.provider, 'bundled', 'a cancelled job is never promoted');
  }
});

test('sweep: a job whose app row stopped moving is relaunched (resumable), then failed after the relaunch limit', async () => {
  const { guest, calls } = setup({ objects: 1 });
  const r = routes();
  const res = await r.call('post', '/projects/:id/foundation/storage', { body: { action: 'switch', provider: 'external', config: S3, credentials: { access_key_id: KEY_ID, secret_access_key: SECRET }, mode: 'copy' } });
  const jobId = res.body.job.id;
  guest.jobs[jobId].state = 'running';
  guest.jobs[jobId].updated_at = new Date(Date.now() - service.JOB_STALE_MS - 1000).toISOString();
  await service.sweepFoundationJobs();
  assert.equal(calls.detached.length, 2, 'relaunched');
  store.updateJob(jobId, { progress: { launches: service.RELAUNCH_MAX, relaunched_at: new Date(Date.now() - service.JOB_STALE_MS - 1000).toISOString() } });
  await service.sweepFoundationJobs();
  const j = store.getJob(jobId);
  assert.equal(j.state, 'failed');
  assert.match(j.error, /stopped making progress/);
});

test('a stale job is relaunched once per stale window, not on every poll; the count starts over when the app row moves', async () => {
  const { guest, calls } = setup({ objects: 1 });
  const r = routes();
  const res = await r.call('post', '/projects/:id/foundation/storage', { body: { action: 'switch', provider: 'external', config: S3, credentials: { access_key_id: KEY_ID, secret_access_key: SECRET }, mode: 'copy' } });
  const jobId = res.body.job.id;
  const old = () => new Date(Date.now() - service.JOB_STALE_MS - 1000).toISOString();
  guest.jobs[jobId].state = 'running';
  guest.jobs[jobId].updated_at = old();
  // The 3 s watch, a GET and the sweep keep polling a long copy whose row is quiet.
  for (let i = 0; i < 3 * service.RELAUNCH_MAX; i++) await service.getJob(1, jobId);
  let j = store.getJob(jobId);
  assert.equal(j.state, 'running', 'polling alone never fails the job');
  assert.equal(calls.detached.length, 2, 'one relaunch for the stale window');
  assert.equal(JSON.parse(j.progress_json).launches, 2);
  // A whole window later it is still quiet: one more relaunch.
  store.updateJob(jobId, { progress: { relaunched_at: old() } });
  await service.getJob(1, jobId);
  await service.getJob(1, jobId);
  assert.equal(calls.detached.length, 3);
  assert.equal(JSON.parse(store.getJob(jobId).progress_json).launches, 3);
  // The relaunched job writes again: the count starts over.
  guest.jobs[jobId].updated_at = new Date(Date.now() + 1000).toISOString();
  await service.getJob(1, jobId);
  j = store.getJob(jobId);
  assert.deepEqual([j.state, JSON.parse(j.progress_json).launches, JSON.parse(j.progress_json).relaunched_at], ['running', 1, null]);
  assert.equal(calls.detached.length, 3);
});

test('polls that overlap a promotion (sweep + GET job + GET foundation) promote once and never report the job failed', async () => {
  // A promotion takes seconds (sync, stop the unused service, a health probe).
  // A second poll during it saw the app job succeeded with the switch no longer
  // staged and marked the promoted job failed — for good when its write landed
  // last (found while writing foundation-e2e.docker.test.js).
  for (const lateMs of [30, 160]) {
    const { guest, calls, stack } = setup({ objects: 2 });
    const r = routes();
    const res = await r.call('post', '/projects/:id/foundation/storage', { body: { action: 'switch', provider: 'external', config: S3, credentials: { access_key_id: KEY_ID, secret_access_key: SECRET }, mode: 'copy' } });
    const jobId = res.body.job.id;
    guest.jobs[jobId].state = 'succeeded';
    const cli = stack.foundationCli;
    stack.foundationCli = async (...a) => { await new Promise((ok) => setTimeout(ok, 120)); return cli(...a); };
    const psql = stack.foundationPsql;
    stack.foundationPsql = async (c, sql, o) => { if (sql.includes("'type', 'job'")) await new Promise((ok) => setTimeout(ok, 80)); return psql(c, sql, o); };
    const seen = [];
    const sweep = service.sweepFoundationJobs();
    await new Promise((ok) => setTimeout(ok, lateMs));
    const viaJob = r.call('get', '/projects/:id/foundation/jobs/:jobId', { params: { jobId } }).then((x) => seen.push(x.body.job.state));
    const viaGet = service.getFoundation(1, { refresh: true }).then((f) => seen.push(f.jobs[0].state));
    await Promise.all([sweep, viaJob, viaGet]);
    assert.deepEqual(seen, ['succeeded', 'succeeded'], `overlap at ${lateMs} ms`);
    const job = store.getJob(jobId);
    assert.deepEqual([job.state, job.error], ['succeeded', null]);
    assert.equal(store.readFeatureRows(1).storage.provider, 'external');
    assert.deepEqual(calls.services.filter(([, a]) => a === 'stop'), [['storage', 'stop']], 'promoted once');
  }
});

test('a service that will not start refuses the change and changes nothing (a throw or a non-zero result)', async () => {
  const { stack, calls } = setup({ objects: 0 });
  const r = routes();
  assert.equal((await r.call('post', '/projects/:id/foundation/storage', { body: { action: 'off' } })).status, 200);
  stack.setFoundationService = async (c, service, action) => { calls.services.push([service, action]); return { code: 1, stderr: 'no such service' }; };
  const on = await r.call('post', '/projects/:id/foundation/storage', { body: { action: 'on' } });
  assert.deepEqual([on.status, on.body.code], [409, CODES.FOUNDATION_UNAVAILABLE]);
  assert.match(on.body.message, /no such service/);
  assert.equal(store.readFeatureRows(1).storage.state, 'off');
  stack.setFoundationService = async () => { throw new Error('docker unreachable'); };
  assert.equal((await r.call('post', '/projects/:id/foundation/embeddings', { body: { action: 'switch', provider: 'local' } })).body.noop, true);
  const offLocal = await r.call('post', '/projects/:id/foundation/embeddings', { body: { action: 'off' } });
  assert.equal(offLocal.status, 200, 'turning off still applies (the app is told first)');
  assert.match(offLocal.body.warning, /could not be stopped/);
});

test('a pre-foundation project has no switches; an offline project refuses writes; invalid bodies are 400', async () => {
  const { db } = setup();
  addProject(db, { id: 2, foundationVersion: null });
  const r = routes();
  const legacyGet = await service.getFoundation(2);
  assert.deepEqual(legacyGet, { foundation_version: null, database: null, storage: null, embeddings: null, jobs: [], warnings: [] });
  const legacyWrite = await service.featureAction(2, 'storage', { action: 'off' });
  assert.equal(legacyWrite.code, CODES.NOT_A_FOUNDATION_PROJECT);
  addProject(db, { id: 3, lifecycle: 'stopped' });
  assert.equal((await service.featureAction(3, 'embeddings', { action: 'off' })).code, CODES.FOUNDATION_UNAVAILABLE);
  for (const body of [{ action: 'explode' }, { action: 'off', extra: 1 }, { action: 'switch', mode: 'move' }, {}]) {
    const res = await r.call('post', '/projects/:id/foundation/storage', { body });
    assert.deepEqual([res.status, res.body.code], [400, CODES.INVALID_REQUEST], JSON.stringify(body));
  }
  const badCfg = await r.call('post', '/projects/:id/foundation/storage', { body: { action: 'switch', provider: 'external', config: { ...S3, bucket: 'Bad_Bucket' }, credentials: { access_key_id: KEY_ID, secret_access_key: SECRET } } });
  assert.deepEqual([badCfg.status, badCfg.body.code], [400, CODES.INVALID_CONFIG]);
  for (const resp of r.responses) noPlanted(resp);
  for (const a of r.audits) noPlanted(a);
});
