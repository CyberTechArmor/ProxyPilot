// Application foundation ADOPTION — the orchestration (mock2/foundation-adopt-
// service.js) and its HTTP surface (foundation-adopt-routes.js), against the
// REAL mock2.db schema (every migration, 566 included), the real foundation
// store, the real checkout locks, and a scripted legacy guest
// (helpers/foundation-adopt-world.js) that answers the service's scripts:
//   * plan: clean legacy project → no blockers, a token, names only;
//   * the success path: the twelve steps in order, the lease held for every
//     guest/host call, data copied and verified, secrets moved (values only in
//     the encrypted store), env lines removed, the platform commit, the REAL
//     foundation deploy check passing, the lock released at the end;
//   * each blocker refuses before anything changes; a stale token → PLAN_STALE;
//   * a failure at EACH step → failed at that step, resumable, rollback
//     available; the rollback restores the snapshot, the original guest
//     settings, the repository, clears foundation_version and the run's rows;
//   * resume, mismatch (not resumable), rollback after success, rollback
//     refused once later builds moved the repository;
//   * a backend restart (boot sweep) → failed with step + reason → resume;
//   * no secret value in any response, audit entry, log line, run record or
//     chat message; no MCP tool reaches any of it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { installFoundationHooks, freshMock2Db, addProject, scriptedStack, world as fworld } from './helpers/foundation-world.js';
import { legacyGuest, createAdoptWorld, PLANTED } from './helpers/foundation-adopt-world.js';
import { buildScaffoldFiles } from '../mock2/scaffold.js';
import { FOUNDATION_NODE_IMPORT, FOUNDATION_DEPENDENCIES } from '../mock2/scaffold-foundation.js';
import { FOUNDATION_GUEST_CONFIG } from '../mock2/foundation-stack-logic.js';
import { FOUNDATION_VERSION } from '../mock2/foundation-contract.js';
import { buildDevServiceUnit, validateDeployEnvironment } from '../mock2/deploy-logic.js';
import { STEP_NAMES, ADOPT_AUDIT } from '../mock2/foundation-adopt-logic.js';
import { MCP_TOOLS } from '../lib/mcp-logic.js';

process.env.TOTP_ENCRYPTION_KEY = 'b'.repeat(64);
installFoundationHooks();
const adopt = await import('../mock2/foundation-adopt-service.js');
const adoptStore = await import('../mock2/foundation-adopt-store.js');
const fstore = await import('../mock2/foundation-store.js');
const locks = await import('../mock2/locks.js');
const { registerFoundationAdoptRoutes } = await import('../mock2/foundation-adopt-routes.js');
const { resolveDeployParams } = await import('../mock2/deploy.js');

// ---- everything any test produced, scanned for secrets at the end ----
const SEEN = { responses: [], audits: [], logs: [], chats: [] };
for (const level of ['log', 'warn', 'error', 'info']) {
  const orig = console[level].bind(console);
  console[level] = (...args) => { SEEN.logs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); if (process.env.ADOPT_TEST_VERBOSE) orig(...args); };
}

function legacyPackageJson() {
  const pkg = JSON.parse(buildScaffoldFiles({ name: 'Demo' }).find((f) => f.path === 'package.json').content);
  pkg.scripts.start = pkg.scripts.start.replace(` ${FOUNDATION_NODE_IMPORT}`, '');
  pkg.scripts.dev = pkg.scripts.dev.replace(` ${FOUNDATION_NODE_IMPORT}`, '');
  delete pkg.scripts.foundation; delete pkg.imports;
  for (const k of Object.keys(FOUNDATION_DEPENDENCIES)) delete pkg.dependencies[k];
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

const GUARD = { table: 'auth_connections', schema: 'public', secret_column: 'secret_ciphertext', nonce_column: 'secret_nonce' };
const CONFIGS = [
  { key: 'AUTH_MASTER_SECRET', secret: true, generate: true, protects: GUARD },
  { key: 'SESSION_SECRET', secret: true, generate: true },
  { key: 'SMTP_PASSWORD', secret: true },
];
function seedComponent(db, projectId, configs, key = 'auth') {
  const now = new Date().toISOString();
  const c = db.prepare("INSERT INTO mock2_components (key, name, status, created_by, created_at) VALUES (?, ?, 'published', 1, ?)").run(key, key, now);
  const v = db.prepare("INSERT INTO mock2_component_versions (component_id, version, files_json, change_reason, source, created_by, created_at, contract_json) VALUES (?, 1, '[]', 'seed', 'in_app', 1, ?, ?)").run(c.lastInsertRowid, now, JSON.stringify({ config: configs }));
  db.prepare("INSERT INTO mock2_project_components (project_id, component_id, version_id, status, origin, created_at) VALUES (?, ?, ?, 'installed', 'operator', ?)").run(projectId, c.lastInsertRowid, v.lastInsertRowid, now);
}

const leaseHeld = () => {
  const row = adoptStore.latestAdoption(1);
  if (!row?.lock_token) return null;
  return locks.getLock(1)?.holder_operation_id === row.lock_token;
};

function setup({ guest = {}, project = {} } = {}) {
  adopt._simulateRestartForTests();
  const db = freshMock2Db();
  // locks.js runs its transactions as BEGIN IMMEDIATE (better-sqlite3's
  // .immediate); the test adapter's transactions are already exclusive.
  const tx = db.transaction;
  db.transaction = (fn) => { const run = tx(fn); run.immediate = run; run.deferred = run; run.exclusive = run; return run; };
  addProject(db, { id: 1, container: 'm2-1', foundationVersion: null, ...project });
  db.prepare("UPDATE mock2_projects SET web_port = 3000, repo_path = '/var/lib/proxypilot/mock2/repos/1.git' WHERE id = 1").run();
  const stack = scriptedStack();
  seedComponent(db, 1, CONFIGS);
  const g = Object.assign(legacyGuest({ pkg: legacyPackageJson() }), guest);
  const w = createAdoptWorld({ guest: g, leaseHeld, resolveDeployParams, validateDeployEnvironment, buildDevServiceUnit });
  const notify = w.deps.notify;
  w.deps.notify = async (pid, body) => { SEEN.chats.push(body); return notify(pid, body); };
  adopt._setAdoptionDepsForTests(w.deps);
  return { db, stack, ...w, original: JSON.parse(JSON.stringify(g)) };
}

// The routes over a captured router.
function routes() {
  const table = new Map(); const audits = [];
  const router = { get: (p, ...h) => table.set(`get ${p}`, h), post: (p, ...h) => table.set(`post ${p}`, h) };
  const requireRole = (role) => Object.assign((req, _res, next) => next(), { role });
  const requireSudo = (_req, _res, next) => next();
  const refuseIfArchived = (_req, _res, next) => next();
  registerFoundationAdoptRoutes(router, { requireRole, requireSudo, refuseIfArchived, audit: (req, action, id, detail) => { audits.push({ action, id, detail }); SEEN.audits.push({ action, id, detail }); }, service: adopt });
  async function call(method, path, body) {
    const handlers = table.get(`${method} ${path}`);
    assert.ok(handlers, path);
    let status = 200; let json;
    const req = { params: { id: '1' }, body, user: { id: 'u-1' }, ip: '10.0.0.2', mock2Project: { id: 1 } };
    const res = { status(c) { status = c; return this; }, json(v) { json = v; return this; } };
    await handlers.at(-1)(req, res, (e) => { throw e; });
    SEEN.responses.push(json);
    return { status, body: json };
  }
  return { table, audits, call, requireSudo, refuseIfArchived };
}

async function plan(r) {
  const res = await r.call('post', '/projects/:id/foundation/adopt/plan', {});
  assert.equal(res.status, 200);
  return res.body;
}
async function adoptAll(r, extra = {}) {
  const p = await plan(r);
  assert.deepEqual(p.blockers, [], JSON.stringify(p.blockers));
  const res = await r.call('post', '/projects/:id/foundation/adopt', { plan_token: p.plan_token, acknowledge_downtime: true, ...extra });
  assert.equal(res.status, 202, JSON.stringify(res.body));
  await adopt._whenAdoptionSettled(res.body.adoption.id);
  return { plan: p, started: res.body.adoption, row: adoptStore.getAdoption(res.body.adoption.id) };
}
const getAdoption = async (r) => (await r.call('get', '/projects/:id/foundation/adopt')).body.adoption;
const projectRow = (db) => db.prepare('SELECT * FROM mock2_projects WHERE id = 1').get();

test('routes: plan needs editor; adopt / rollback / resume need editor + sudo and refuse archived; GET needs viewer', () => {
  const r = routes();
  const expect = {
    'post /projects/:id/foundation/adopt/plan': ['editor', true, false],
    'post /projects/:id/foundation/adopt': ['editor', true, true],
    'get /projects/:id/foundation/adopt': ['viewer', false, false],
    'post /projects/:id/foundation/adopt/rollback': ['editor', true, true],
    'post /projects/:id/foundation/adopt/resume': ['editor', true, true],
  };
  assert.deepEqual([...r.table.keys()].sort(), Object.keys(expect).sort());
  for (const [route, [role, archived, sudo]] of Object.entries(expect)) {
    const h = r.table.get(route);
    assert.equal(h[0].role, role, route);
    assert.equal(h.includes(r.refuseIfArchived), archived, route);
    assert.equal(h.includes(r.requireSudo), sudo, route);
  }
  assert.throws(() => registerFoundationAdoptRoutes({ get() {}, post() {} }, {}), /dependency is required/);
});

test('plan: a clean legacy project — no blockers, a token, the steps with labels, secret NAMES only', async () => {
  const w = setup();
  const r = routes();
  const p = await plan(r);
  assert.equal(p.ok, true);
  assert.deepEqual(p.blockers, []);
  assert.match(p.plan_token, /^[0-9a-f]{64}$/);
  assert.deepEqual(p.plan.steps.map((s) => s.name), STEP_NAMES);
  assert.ok(p.plan.steps.every((s) => s.label && s.summary));
  assert.deepEqual(p.plan.secrets_to_move, ['AUTH_MASTER_SECRET', 'SESSION_SECRET']);
  assert.deepEqual(p.plan.database, { size_bytes: w.g.native.size, tables: 3 });
  assert.equal(typeof p.plan.downtime, 'string');
  assert.deepEqual(p.plan.features, { storage: 'on', embeddings: 'on' });
  assert.equal(adoptStore.latestAdoption(1), null, 'a plan records nothing');
  assert.equal(locks.getLock(1), undefined, 'and takes no lock');
  assert.equal(w.snapshots.size, 0);
  assert.deepEqual(w.trace.map((t) => t.what), ['incus list', 'probe'], 'read-only: one Incus read and one guest probe');
  assert.equal((await getAdoption(r)), null);
});

test('the success path: twelve steps in order, the lease held throughout, data verified, secrets moved, the real foundation deploy check passes', async () => {
  const w = setup();
  const r = routes();
  const { row, started } = await adoptAll(r);
  assert.equal(started.state, 'running');
  assert.equal(row.state, 'succeeded', row.error);
  const v = await getAdoption(r);
  assert.equal(v.state, 'succeeded');
  assert.equal(v.step, 'done');
  assert.ok(v.steps.every((s) => s.state === 'done' && s.started_at && s.finished_at && s.label), JSON.stringify(v.steps.filter((s) => s.state !== 'done')));
  assert.equal(v.rollback_available, true);
  assert.equal(v.resume_available, false);
  // Order: the guest/host calls of the run.
  const order = w.trace.map((t) => t.what).filter((x) => !['incus list', 'probe', 'after-restart', 'count', 'cli health'].includes(x));
  const id = row.id;
  assert.deepEqual(order, [
    `snapshot create pre-foundation-${id}`, 'stop_app', 'dump', 'stop_native',
    `config set ${Object.entries(FOUNDATION_GUEST_CONFIG).map(([k, val]) => `${k}=${val}`).join(' ')}`, 'restart',
    'install_runtime', 'port_check', 'master-key', 'bring-up', 'restore', 'read_env', 'rewrite_env', 'module_commit', 'deploy',
  ]);
  // The lease held the checkout lock for every call made after the confirmation.
  const during = w.trace.slice(w.trace.findIndex((t) => t.what.startsWith('snapshot create')));
  assert.ok(during.length > 15);
  assert.ok(during.every((t) => t.lease === true), JSON.stringify(during.filter((t) => t.lease !== true)));
  assert.equal(locks.getLock(1), undefined, 'released at the end');
  // The guest is now what a new foundation guest is.
  for (const [k, val] of Object.entries(FOUNDATION_GUEST_CONFIG)) assert.equal(w.g.config[k], val, k);
  assert.equal(w.g.config['limits.cpu'], '2', 'other settings untouched');
  assert.equal(w.g.docker, true);
  assert.equal(w.g.stack.up, true);
  assert.deepEqual(w.g.stack.tables, w.original.native.tables, 'every table, every row');
  assert.equal(w.g.stack.masterKeyWritten, true);
  // The native database: stopped, disabled, its data left as it was.
  assert.equal(w.g.native.running, false);
  assert.equal(w.g.native.enabled, 'disabled');
  assert.equal(w.g.native.dataDir, 'untouched');
  assert.deepEqual(w.g.native.tables, w.original.native.tables);
  // Secrets: in the encrypted store, out of /etc/environment (with DATABASE_URL).
  assert.equal(fstore.readSecret(1, 'component.AUTH_MASTER_SECRET'), PLANTED.auth);
  assert.equal(fstore.readSecret(1, 'component.SESSION_SECRET'), PLANTED.session);
  const raw = w.db.prepare('SELECT ciphertext FROM mock2_foundation_secrets WHERE project_id = 1').all().map((x) => x.ciphertext).join('\n');
  assert.equal(raw.includes(PLANTED.auth) || raw.includes(PLANTED.session), false, 'ciphertext only');
  assert.equal(w.g.env, 'PATH="/usr/local/bin:/usr/bin"\nOPERATOR_SETTING=keep\n');
  assert.ok(w.stack.guest.lastSync.includes('component.AUTH_MASTER_SECRET'), 'delivered sealed to the app database');
  assert.equal(w.stack.guest.lastSync.includes(PLANTED.auth), false);
  // The project row and its foundation rows.
  const prow = projectRow(w.db);
  assert.equal(prow.foundation_version, FOUNDATION_VERSION);
  assert.deepEqual(w.db.prepare('SELECT feature, state, provider FROM mock2_foundation_features WHERE project_id = 1 ORDER BY feature').all().map((x) => ({ ...x })), [
    { feature: 'embeddings', state: 'on', provider: 'local' }, { feature: 'storage', state: 'on', provider: 'bundled' },
  ]);
  // The repository: one platform commit of foundation/ + package.json, pushed.
  assert.notEqual(w.g.head, w.original.head);
  assert.equal(w.g.bareMain, w.g.head);
  assert.ok(w.g.lastCommitFiles.every((p) => p === 'package.json' || p.startsWith('foundation/')));
  const pkg = JSON.parse(w.g.pkg);
  assert.match(pkg.scripts.start, new RegExp(` ${FOUNDATION_NODE_IMPORT.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')} `));
  assert.equal(pkg.imports['#foundation'], './foundation/index.mjs');
  // The deploy was a foundation deploy and passed the real environment check.
  const deployNote = w.notes.find((n) => n.deployParams);
  assert.deepEqual(deployNote.validation, { ok: true, mode: 'production' });
  assert.deepEqual(deployNote.deployParams.required.sort(), ['AUTH_MASTER_SECRET', 'SESSION_SECRET']);
  assert.equal(w.g.unitFoundation, true);
  assert.equal(w.g.appUnit.active, true);
  // The run's record: facts, never values.
  const data = adoptStore.adoptionData(row);
  assert.equal(data.snapshot.name, `pre-foundation-${id}`);
  assert.deepEqual(data.counts, w.original.native.tables);
  assert.deepEqual(data.moved_secrets, ['AUTH_MASTER_SECRET', 'SESSION_SECRET']);
  assert.equal(data.adopt_commit, w.g.head);
  assert.equal(data.pre_remote, w.original.head);
  assert.ok(w.snapshots.has(`pre-foundation-${id}`), 'the snapshot is kept');
  // Audited.
  assert.deepEqual(r.audits.map((a) => [a.action, a.detail.outcome]), [[ADOPT_AUDIT.start, 'started']]);
  assert.equal(r.audits[0].detail.acknowledge_downtime, true);
  // A finished project is not a legacy project any more.
  assert.deepEqual((await plan(r)).blockers.map((b) => b.code), ['NOT_LEGACY_PROJECT']);
});

test('features chosen at the confirmation: embeddings off starts the stack without it', async () => {
  const w = setup();
  const r = routes();
  const { row } = await adoptAll(r, { features: { embeddings: 'off' } });
  assert.equal(row.state, 'succeeded', row.error);
  assert.equal(w.g.stack.features.embeddings.state, 'off');
  assert.equal(w.g.stack.features.storage.state, 'on');
  assert.equal(fstore.readFeatureRows(1).embeddings.state, 'off');
  assert.deepEqual(r.audits[0].detail.features, { storage: 'on', embeddings: 'off' });
});

test('blockers refuse before anything changes; PLAN_BLOCKED carries them', async () => {
  const cases = [
    [{ project: { foundationVersion: 'mock2-foundation-v1' } }, 'NOT_LEGACY_PROJECT'],
    [{ guest: { busy: { deploy: true } } }, 'DEPLOY_RUNNING'],
    [{ guest: { pkg: JSON.stringify({ scripts: { start: 'node dist/server.js' }, dependencies: { pg: '^8', 'better-sqlite3': '^11' } }) } }, 'APP_USES_SQLITE'],
    [{ guest: { pkg: null } }, 'NOT_MOCK2_APP'],
    [{ guest: { native: { enabled: 'enabled', running: false, size: 0, tables: {}, dataDir: 'untouched' } } }, 'NO_NATIVE_DATABASE'],
    [{ guest: { diskFree: 1024 ** 3 } }, 'NOT_ENOUGH_DISK'],
    [{ guest: { type: 'virtual-machine' } }, 'GUEST_NOT_CONTAINER'],
    [{ guest: { customVolumes: 1 } }, 'GUEST_HAS_CUSTOM_VOLUMES'],
    [{ project: { lifecycle: 'stopped' } }, 'NOT_ONLINE'],
  ];
  for (const [over, code] of cases) {
    const w = setup(over);
    const r = routes();
    const p = await plan(r);
    assert.ok(p.blockers.some((b) => b.code === code), `${code}: ${p.blockers.map((b) => b.code)}`);
    assert.equal(p.plan_token, null, 'a plan with blockers has no usable token');
    for (const b of p.blockers) { assert.equal(typeof b.message, 'string'); assert.equal(typeof b.next_step, 'string'); }
    const res = await r.call('post', '/projects/:id/foundation/adopt', { plan_token: 'f'.repeat(64), acknowledge_downtime: true });
    assert.equal(res.status, 409, code);
    assert.equal(res.body.code, 'PLAN_BLOCKED');
    assert.ok(res.body.blockers.some((b) => b.code === code));
    assert.equal(adoptStore.latestAdoption(1), null);
    assert.equal(locks.getLock(1), undefined);
    assert.equal(w.snapshots.size, 0, `${code}: no snapshot`);
    assert.equal(r.audits.at(-1).detail.outcome, 'refused');
    assert.equal(r.audits.at(-1).detail.code, 'PLAN_BLOCKED');
  }
  // A build holds the checkout lock.
  setup();
  const r = routes();
  assert.equal(locks.acquireLock({ projectId: 1, requester: { type: 'cycle', id: 5 }, role: 'editor' }).ok, true);
  assert.ok((await plan(r)).blockers.some((b) => b.code === 'CHECKOUT_LOCK_HELD'));
  locks.releaseLock(1);
  // An adoption already running.
  adoptStore.insertAdoption({ id: 'fa_00000000000000aa', projectId: 1, data: {} });
  assert.ok((await plan(r)).blockers.some((b) => b.code === 'ADOPTION_RUNNING'));
});

test('a stale token is refused with PLAN_STALE; acknowledge_downtime and features are validated', async () => {
  const w = setup();
  const r = routes();
  const p = await plan(r);
  w.g.head = 'e'.repeat(40); w.g.bareMain = w.g.head; // a build committed in between
  const stale = await r.call('post', '/projects/:id/foundation/adopt', { plan_token: p.plan_token, acknowledge_downtime: true });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'PLAN_STALE');
  assert.deepEqual(stale.body.options, [{ action: 'plan' }]);
  const p2 = await plan(r);
  w.g.env += 'NEW_COMPONENT_KEY=x\n';
  seedComponent(w.db, 1, [{ key: 'NEW_COMPONENT_KEY', secret: true, generate: true }], 'mailer');
  assert.equal((await r.call('post', '/projects/:id/foundation/adopt', { plan_token: p2.plan_token, acknowledge_downtime: true })).body.code, 'PLAN_STALE', 'a new secret to move changes the plan');
  const p3 = await plan(r);
  const noAck = await r.call('post', '/projects/:id/foundation/adopt', { plan_token: p3.plan_token });
  assert.equal(noAck.status, 400);
  assert.equal(noAck.body.code, 'ACKNOWLEDGE_DOWNTIME_REQUIRED');
  const badFeature = await r.call('post', '/projects/:id/foundation/adopt', { plan_token: p3.plan_token, acknowledge_downtime: true, features: { storage: 'maybe' } });
  assert.equal(badFeature.status, 400);
  assert.equal(badFeature.body.code, 'INVALID_REQUEST');
  const extra = await r.call('post', '/projects/:id/foundation/adopt', { plan_token: p3.plan_token, acknowledge_downtime: true, sneaky: 1 });
  assert.equal(extra.status, 400);
  assert.equal(adoptStore.latestAdoption(1), null);
  assert.equal(locks.getLock(1), undefined);
  assert.equal(w.snapshots.size, 0);
});

const FAIL_AT = ['snapshot', 'stop_app', 'dump_database', 'stop_native_database', 'docker_ready', 'install_runtime', 'start_foundation', 'restore_database', 'move_secrets', 'install_foundation_module', 'deploy'];

function assertRolledBack(w, row, { snapshotTaken = true } = {}) {
  assert.equal(row.state, 'rolled_back', row.error);
  // The guest as it was before the run.
  assert.deepEqual(w.g.config, w.original.config, 'the original guest settings');
  assert.equal(w.g.native.enabled, 'enabled');
  assert.equal(w.g.native.running, true);
  assert.equal(w.g.appUnit.enabled, 'enabled');
  assert.equal(w.g.appUnit.active, true);
  assert.equal(w.g.env, w.original.env, 'the environment file with its secrets is back (from the snapshot)');
  assert.equal(w.g.pkg, w.original.pkg);
  assert.equal(w.g.bareMain, w.original.bareMain, 'the repository main is back');
  assert.equal(w.g.docker, false);
  // mock2.db: no foundation left.
  assert.equal(projectRow(w.db).foundation_version, null);
  assert.deepEqual(adoptStore.foundationRowCounts(1), { features: 0, secrets: 0, jobs: 0 });
  assert.equal(locks.getLock(1), undefined, 'the lock is released');
  if (snapshotTaken) assert.ok(w.snapshots.has(`pre-rollback-${row.id}`), 'what the run left is kept in the pre-rollback snapshot');
}

test('a failure at EACH step: failed at that step, resumable, lock kept, rollback available — and the rollback restores everything', async () => {
  for (const step of FAIL_AT) {
    const w = setup();
    w.fail[step] = `injected ${step} failure`;
    const r = routes();
    const { row } = await adoptAll(r);
    assert.equal(row.state, 'failed', step);
    assert.equal(row.step, step);
    assert.match(row.error, new RegExp(`^${step}: `));
    const v = await getAdoption(r);
    assert.equal(v.steps.find((s) => s.name === step).state, 'failed');
    assert.ok(v.steps.slice(0, STEP_NAMES.indexOf(step)).every((s) => s.state === 'done'), step);
    assert.ok(v.steps.slice(STEP_NAMES.indexOf(step) + 1).every((s) => s.state === 'pending'), step);
    assert.equal(v.rollback_available, true, step);
    assert.equal(v.resume_available, true, step);
    assert.equal(leaseHeld(), true, `${step}: the checkout lock stays with the failed run`);
    assert.equal(locks.acquireLock({ projectId: 1, requester: { type: 'cycle', id: 9 }, role: 'editor' }).ok, false, `${step}: a build cannot start`);
    const rb = await r.call('post', '/projects/:id/foundation/adopt/rollback', {});
    assert.equal(rb.status, 202, JSON.stringify(rb.body));
    assert.equal(rb.body.adoption.state, 'rolling_back');
    await adopt._whenAdoptionSettled(row.id);
    assertRolledBack(w, adoptStore.getAdoption(row.id), { snapshotTaken: step !== 'snapshot' });
    assert.equal((await getAdoption(r)).rollback_available, false);
    assert.deepEqual(r.audits.map((a) => [a.action, a.detail.outcome]), [[ADOPT_AUDIT.start, 'started'], [ADOPT_AUDIT.rollback, 'started']]);
    assert.deepEqual((await plan(r)).blockers, [], `${step}: after the rollback the project can be planned again`);
  }
});

test('a busy port after the native server stops fails step 4 with what to do; resume after it is free', async () => {
  const w = setup();
  w.fail.port_busy = 'yes';
  const r = routes();
  const { row } = await adoptAll(r);
  assert.equal(row.step, 'stop_native_database');
  assert.match(row.error, /something still listens on port 5432 .*ss -ltnp/);
  const res = await r.call('post', '/projects/:id/foundation/adopt/resume', {});
  assert.equal(res.status, 202);
  await adopt._whenAdoptionSettled(row.id);
  assert.equal(adoptStore.getAdoption(row.id).state, 'succeeded');
});

test('the published port after the restart: busy → start_foundation stops with what to do; the stack\'s own port on a resume is fine', async () => {
  const w = setup({ guest: { portSquatter: true } });
  const r = routes();
  const { row } = await adoptAll(r);
  assert.equal(row.step, 'start_foundation');
  assert.match(row.error, /port 5432 in the guest is in use .*ss -ltnp/);
  assert.equal(w.trace.filter((t) => t.what === 'stop_native').length, 2, 'the native server is stopped once more before giving up');
  assert.equal(w.g.stack.up, false, 'nothing was started on a busy port');
  w.g.portSquatter = false;
  w.fail.start_foundation_late = 'storage identities failed';
  await r.call('post', '/projects/:id/foundation/adopt/resume', {});
  await adopt._whenAdoptionSettled(row.id);
  const second = adoptStore.getAdoption(row.id);
  assert.equal(second.step, 'start_foundation');
  assert.equal(w.g.stack.up, true, 'the stack\'s PostgreSQL now publishes the port');
  const res = await r.call('post', '/projects/:id/foundation/adopt/resume', {});
  assert.equal(res.status, 202);
  await adopt._whenAdoptionSettled(row.id);
  assert.equal(adoptStore.getAdoption(row.id).state, 'succeeded', 'its own published port does not block the resume');
});

test('resume retries only the failed step and finishes; the steps before are not run again', async () => {
  const w = setup();
  w.fail.deploy = 'the health window closed';
  const r = routes();
  const { row } = await adoptAll(r);
  assert.equal(row.step, 'deploy');
  const before = w.trace.length;
  const res = await r.call('post', '/projects/:id/foundation/adopt/resume', {});
  assert.equal(res.status, 202, JSON.stringify(res.body));
  assert.equal(res.body.adoption.state, 'running');
  await adopt._whenAdoptionSettled(row.id);
  const after = adoptStore.getAdoption(row.id);
  assert.equal(after.state, 'succeeded', after.error);
  const again = w.trace.slice(before).map((t) => t.what);
  assert.ok(again.includes('deploy'));
  for (const x of ['stop_app', 'dump', 'restore', 'module_commit', 'install_runtime']) assert.equal(again.includes(x), false, x);
  assert.equal(locks.getLock(1), undefined);
  assert.equal(r.audits.at(-1).action, ADOPT_AUDIT.resume);
  // Nothing to resume now.
  const none = await r.call('post', '/projects/:id/foundation/adopt/resume', {});
  assert.equal(none.status, 409);
  assert.equal(none.body.code, 'NOT_RESUMABLE');
});

test('row counts that differ stop the run, not resumable; the rollback is offered and works', async () => {
  const w = setup({ guest: { restoreDropsRow: true } });
  const r = routes();
  const { row } = await adoptAll(r);
  assert.equal(row.state, 'failed');
  assert.equal(row.step, 'restore_database');
  assert.match(row.error, /row counts differ from the dump: public\.health_checks: dump 1 rows, foundation 0 rows/);
  const v = await getAdoption(r);
  assert.equal(v.resume_available, false);
  assert.equal(v.rollback_available, true);
  const res = await r.call('post', '/projects/:id/foundation/adopt/resume', {});
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'NOT_RESUMABLE');
  assert.deepEqual(res.body.options, [{ action: 'rollback' }]);
  await r.call('post', '/projects/:id/foundation/adopt/rollback', {});
  await adopt._whenAdoptionSettled(row.id);
  assertRolledBack(w, adoptStore.getAdoption(row.id));
});

test('a foundation database that already holds other data is never overwritten', async () => {
  const w = setup({ guest: { preexistingTables: { 'public.leftover': 4 } } });
  const r = routes();
  const { row } = await adoptAll(r);
  assert.equal(row.step, 'restore_database');
  assert.match(row.error, /already holds tables that do not match the dump .* roll back/);
  assert.equal(Number(row.resumable), 0);
  assert.equal(w.trace.some((t) => t.what === 'restore'), false, 'pg_restore never ran');
});

test('rollback after success: the guest, the repository and mock2.db go back; a new plan is possible', async () => {
  const w = setup();
  w.db.prepare('UPDATE mock2_projects SET deployed_commit = ? WHERE id = 1').run(w.original.head);
  const r = routes();
  const { row } = await adoptAll(r);
  assert.equal(row.state, 'succeeded');
  w.db.prepare('UPDATE mock2_projects SET deployed_commit = ? WHERE id = 1').run(w.g.head); // the deploy's stamp
  const rb = await r.call('post', '/projects/:id/foundation/adopt/rollback', {});
  assert.equal(rb.status, 202);
  await adopt._whenAdoptionSettled(row.id);
  const done = adoptStore.getAdoption(row.id);
  assertRolledBack(w, done);
  assert.equal(projectRow(w.db).deployed_commit, w.original.head, 'the served commit is the one before the run');
  assert.ok(w.trace.some((t) => t.what === 'repo reset'));
  const pre = w.snapshots.get(`pre-rollback-${row.id}`).state;
  assert.equal(pre.docker, true, 'the adopted state is kept in the pre-rollback snapshot');
  assert.equal(pre.stack.up, true);
  assert.equal((await getAdoption(r)).state, 'rolled_back');
  assert.deepEqual((await plan(r)).blockers, []);
});

test('rollback after success is refused once later builds moved the repository; nothing changes', async () => {
  const w = setup();
  const r = routes();
  const { row } = await adoptAll(r);
  w.g.bareMain = 'f'.repeat(40);
  const v = await getAdoption(r);
  assert.equal(v.rollback_available, false);
  const rb = await r.call('post', '/projects/:id/foundation/adopt/rollback', {});
  assert.equal(rb.status, 409);
  assert.equal(rb.body.code, 'ROLLBACK_REPO_MOVED');
  assert.equal(adoptStore.getAdoption(row.id).state, 'succeeded');
  assert.equal(locks.getLock(1), undefined, 'the lease taken for the check is given back');
  assert.equal(projectRow(w.db).foundation_version, FOUNDATION_VERSION);
});

test('a missing rollback snapshot is refused before anything is touched', async () => {
  const w = setup();
  w.fail.deploy = 'x';
  const r = routes();
  const { row } = await adoptAll(r);
  w.snapshots.delete(`pre-foundation-${row.id}`);
  const rb = await r.call('post', '/projects/:id/foundation/adopt/rollback', {});
  assert.equal(rb.status, 409);
  assert.equal(rb.body.code, 'SNAPSHOT_MISSING');
  assert.equal(adoptStore.getAdoption(row.id).state, 'failed');
  assert.equal(leaseHeld(), true, 'the failed run keeps its lease');
});

test('archiving is refused while an adoption is unfinished (its rollback snapshot lives in the guest)', async () => {
  const w = setup();
  w.fail.deploy = 'x';
  const r = routes();
  const { row } = await adoptAll(r);
  const refused = adopt.archiveAdoptionRefusal(1);
  assert.equal(refused.code, 'ADOPTION_UNFINISHED');
  assert.match(refused.message, /Archiving deletes the guest and its rollback snapshot/);
  assert.deepEqual(refused.options, [{ action: 'resume' }, { action: 'rollback' }]);
  await r.call('post', '/projects/:id/foundation/adopt/resume', {});
  await adopt._whenAdoptionSettled(row.id);
  assert.equal(adopt.archiveAdoptionRefusal(1), null, 'a finished adoption does not hold the archive');
  const src = await readFile(new URL('../mock2/routes.js', import.meta.url), 'utf8');
  const archive = src.slice(src.indexOf("router.post('/projects/:id/archive'"), src.indexOf("router.post('/projects/:id/rehydrate'"));
  assert.ok(archive.indexOf('archiveAdoptionRefusal') > 0 && archive.indexOf('archiveAdoptionRefusal') < archive.indexOf('startArchive(project)'), 'the archive route asks before it destroys the guest');
});

test('a backend restart: the running adoption becomes failed with its step and reason; resume finishes; the late step changes nothing', async () => {
  const w = setup();
  let releaseDeploy;
  const hung = new Promise((resolve) => { releaseDeploy = resolve; });
  const realDeploy = w.deps.deploy;
  let first = true;
  w.deps.deploy = async (project) => { if (first) { first = false; await hung; return { ok: true }; } return realDeploy(project); };
  const r = routes();
  const p = await plan(r);
  const res = await r.call('post', '/projects/:id/foundation/adopt', { plan_token: p.plan_token, acknowledge_downtime: true });
  const id = res.body.adoption.id;
  for (let i = 0; i < 200 && adoptStore.getAdoption(id).step !== 'deploy'; i++) await new Promise((x) => setTimeout(x, 5));
  assert.equal(adoptStore.getAdoption(id).step, 'deploy');
  assert.equal(locks.acquireLock({ projectId: 1, requester: { type: 'cycle', id: 3 }, role: 'editor' }).ok, false, 'no build while the run holds the lock');
  // The restart: memory is gone, the boot sweeps run.
  adopt._simulateRestartForTests();
  w.db.prepare("UPDATE mock2_locks SET holder_operation_state='uncertain',holder_cycle_id=NULL WHERE holder_operation_id IS NOT NULL").run();
  assert.equal(adopt.sweepAdoptionsOnBoot(), 1);
  const v = await getAdoption(r);
  assert.equal(v.state, 'failed');
  assert.equal(v.step, 'deploy');
  assert.match(v.error, /deploy: interrupted by a backend restart\. Resume retries this step/);
  assert.equal(v.steps.find((s) => s.name === 'deploy').state, 'failed');
  assert.equal(v.resume_available, true);
  assert.equal(v.rollback_available, true);
  const resumed = await r.call('post', '/projects/:id/foundation/adopt/resume', {});
  assert.equal(resumed.status, 202, JSON.stringify(resumed.body));
  await adopt._whenAdoptionSettled(id);
  assert.equal(adoptStore.getAdoption(id).state, 'succeeded');
  assert.equal(locks.getLock(1), undefined);
  const settled = JSON.stringify(adoptStore.getAdoption(id));
  releaseDeploy();
  await new Promise((x) => setTimeout(x, 20));
  assert.equal(JSON.stringify(adoptStore.getAdoption(id)), settled, 'the old run\'s late result is discarded');
  // An interrupted rollback: failed, rollback offered again, no resume.
  adoptStore.updateAdoption(id, { state: 'rolling_back' });
  assert.equal(adopt.sweepAdoptionsOnBoot(), 1);
  const rb = await getAdoption(r);
  assert.equal(rb.state, 'failed');
  assert.match(rb.error, /Rollback failed: interrupted by a backend restart/);
  assert.equal(rb.resume_available, false);
  assert.equal(rb.rollback_available, true);
});

test('admission: one request at a time; a running adoption refuses resume and rollback', async () => {
  const w = setup();
  let release;
  const gate = new Promise((x) => { release = x; });
  const real = w.deps.bringUpFoundation;
  w.deps.bringUpFoundation = async (a) => { await gate; return real(a); };
  const r = routes();
  const p = await plan(r);
  const res = await r.call('post', '/projects/:id/foundation/adopt', { plan_token: p.plan_token, acknowledge_downtime: true });
  for (let i = 0; i < 200 && adoptStore.getAdoption(res.body.adoption.id).step !== 'start_foundation'; i++) await new Promise((x) => setTimeout(x, 5));
  for (const path of ['rollback', 'resume']) {
    const x = await r.call('post', `/projects/:id/foundation/adopt/${path}`, {});
    assert.equal(x.status, 409, path);
    assert.equal(x.body.code, 'ADOPTION_RUNNING', path);
  }
  const again = await r.call('post', '/projects/:id/foundation/adopt', { plan_token: p.plan_token, acknowledge_downtime: true });
  assert.equal(again.status, 409);
  assert.equal(again.body.code, 'PLAN_BLOCKED');
  release();
  await adopt._whenAdoptionSettled(res.body.adoption.id);
  assert.equal(adoptStore.getAdoption(res.body.adoption.id).state, 'succeeded');
});

test('no secret value in any response, audit entry, log line, run record or chat message', () => {
  const planted = [PLANTED.auth, PLANTED.session, PLANTED.dbPassword];
  const rows = fworld.db.prepare('SELECT * FROM mock2_foundation_adoptions').all();
  const corpus = JSON.stringify({ ...SEEN, rows });
  assert.ok(SEEN.responses.length > 40 && SEEN.audits.length > 10 && SEEN.chats.length > 5, 'the earlier tests produced material to scan');
  for (const p of planted) assert.equal(corpus.includes(p), false, `leaked: ${p.slice(0, 10)}…`);
});

test('ratchet: no MCP tool names, describes or reaches the foundation adoption', async () => {
  for (const t of MCP_TOOLS) {
    const text = `${t.name} ${t.description || ''} ${JSON.stringify(t.inputSchema || t.input_schema || {})}`;
    assert.doesNotMatch(text, /foundation[_ -]?adopt|adopt[_ -](?:the[_ -])?(?:application[_ -])?foundation|foundation\/adopt|mock2_foundation_adoptions/i, `MCP tool ${t.name}`);
  }
  const roots = ['../routes/mcp.js', '../routes/mcp-editor.js', '../routes/mcp-tools/', '../lib/mcp-logic.js', '../lib/mcp-ext/', '../lib/mcp-policy/'];
  const files = [];
  async function walk(url) {
    if (!url.pathname.endsWith('/')) { files.push(url); return; }
    for (const e of await readdir(url, { withFileTypes: true })) await walk(new URL(`${e.name}${e.isDirectory() ? '/' : ''}`, url));
  }
  for (const r of roots) await walk(new URL(r, import.meta.url));
  assert.ok(files.length > 10);
  for (const f of files) {
    const src = await readFile(f, 'utf8');
    assert.doesNotMatch(src, /foundation-adopt-(?:service|routes|store|logic)\.js|mock2_foundation_adoptions|startAdoption|rollbackAdoption|resumeAdoption|foundation\/adopt/, f.pathname);
  }
  // The dashboard router is the only mount, with the project role chain.
  const src = await readFile(new URL('../mock2/routes.js', import.meta.url), 'utf8');
  assert.match(src, /registerFoundationAdoptRoutes\(router, \{\n\s+requireRole: requireMock2Role, requireSudo, refuseIfArchived,/);
});
