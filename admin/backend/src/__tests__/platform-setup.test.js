import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { choicesSchema, emptyChoices, planDependencies, PLATFORM_PLAN_SCHEMA, checkPlatformPlan, platformState, savePlanSchema, savePlatformPlan } from '../lib/setup-engine/platform-plan.js';
import { ensureSetupEngineSchema, runnerHeartbeat } from '../lib/setup-engine/store.js';

const draft = () => ({ schemaVersion: 1, choices: { ...emptyChoices(), keycloak: { mode: 'install', url: 'https://identity.example.com' }, infisical: { mode: 'connect', url: 'https://secrets.example.com', agentProxyUrl: 'https://proxy.example.com' } } });
const saveBody = (revision = 0) => ({ ...draft(), expectedRevision: revision, reviewed: true });
function memoryDb() {
  const db = new DatabaseSync(':memory:'); ensureSetupEngineSchema(db); db.exec(PLATFORM_PLAN_SCHEMA);
  db.exec('CREATE TABLE services (id TEXT, name TEXT, domain TEXT); CREATE TABLE service_http_routes (id TEXT, domain TEXT); CREATE TABLE app_settings (key TEXT, value TEXT)');
  return db;
}
const stats = async () => ({ cpu: { cores: 6 }, memory: { total: 32 * 1024 ** 3, free: 12 * 1024 ** 3 }, disk: { total: 1000, free: 500 } });

test('strict non-secret schema: all five choices, origins, no browser state or credentials', () => {
  assert.ok(choicesSchema.safeParse(emptyChoices()).success);
  assert.ok(savePlanSchema.safeParse(saveBody()).success);
  const overlap = draft().choices; overlap.pomerium = { mode: 'install', url: overlap.keycloak.url };
  assert.ok(planDependencies(overlap).some(issue => issue.includes('shares identity.example.com')));
  for (const url of ['https://user:password@example.com', 'https://example.com?token=secret', 'https://example.com/#secret', 'https://example.com/secret', 'file:///etc/passwd', 'http://bad host', 'https://example.com\\secret', 'https://example.com/#', 'ftp://example.com']) {
    const input = draft(); input.choices.keycloak.url = url;
    assert.equal(choicesSchema.safeParse(input.choices).success, false, url);
  }
  for (const extra of [{ fresh: true }, { installed: true }, { password: 'secret' }, { checks: { status: 'pass' } }, { schemaVersion: 2 }, { reviewed: false }]) assert.equal(savePlanSchema.safeParse({ ...saveBody(), ...extra }).success, false);
  const c = emptyChoices(); c.keycloak.mode = 'install'; assert.equal(choicesSchema.safeParse(c).success, false);
  c.keycloak = { mode: 'skip', url: 'https://example.com' }; assert.equal(choicesSchema.safeParse(c).success, false);
  const i = draft(); i.choices.infisical.agentProxyUrl = ''; assert.equal(choicesSchema.safeParse(i.choices).success, false);
});

test('empty inventory never declares fresh or installed; intended state remains separate', () => {
  const db = memoryDb(); const state = platformState(db);
  assert.equal(state.classification, 'unknown'); assert.equal(state.installationAvailable, false); assert.equal(state.loginActivationAvailable, false);
  assert.ok(state.verifiedServices.every(s => s.state === 'not_checked'));
  savePlatformPlan(db, savePlanSchema.parse(saveBody()), { checks: [] }, 'admin');
  assert.deepEqual(platformState(db), state); db.close();
});

test('preflight uses existing read interfaces, reports missing capabilities and route/dependency conflicts truthfully', async () => {
  const db = memoryDb(); const c = draft().choices;
  c.pomerium = { mode: 'install', url: 'https://identity.example.com' }; c.keycloak = { mode: 'skip', url: '' };
  db.exec("INSERT INTO service_http_routes VALUES ('route', 'identity.example.com')");
  const calls = [];
  const out = await checkPlatformPlan(db, c, { callAgent: async method => { calls.push(method); throw new Error('absent'); }, systemStats: stats });
  assert.deepEqual(calls.sort(), ['agent.ping', 'caddy.version']);
  assert.equal(out.checks.find(c => c.id === 'runner').status, 'fail');
  assert.equal(out.checks.find(c => c.id === 'pomerium-url-route').status, 'fail');
  assert.equal(out.checks.find(c => c.id === 'agent').status, 'not_checked');
  assert.equal(out.checks.find(c => c.id === 'caddy').status, 'not_checked');
  assert.equal(out.checks.find(c => c.id === 'runtime').status, 'not_checked');
  assert.equal(out.checks.find(c => c.id === 'capacity').facts.cpuCores, 6);
  assert.ok(out.dependencies.some(x => x.includes('identity provider')));
  assert.ok(out.checks.filter(c => c.id.endsWith('-network')).every(c => c.status === 'not_checked'));
  assert.equal(db.prepare('SELECT count(*) n FROM setup_jobs').get().n, 0);
  c.pomerium.mode = 'connect';
  const connected = await checkPlatformPlan(db, c, { callAgent: async () => { throw new Error(); }, systemStats: stats });
  assert.equal(connected.checks.find(c => c.id === 'pomerium-url-route').status, 'not_checked'); db.close();
});

test('live and stale runner evidence; runtime responses; missing capacity never reads as pass', async () => {
  const db = memoryDb(); const nowMs = Date.now();
  runnerHeartbeat(db, { owner: 'runner@host#123:abc', host: 'host', pid: 123, nowMs });
  const deps = { nowMs, callAgent: async method => method === 'agent.ping' ? 'pong' : { version: 'v2.10.2' }, systemStats: stats };
  const live = await checkPlatformPlan(db, emptyChoices(), deps);
  for (const id of ['runner', 'agent', 'caddy', 'capacity']) assert.equal(live.checks.find(c => c.id === id).status, 'pass');
  const stale = await checkPlatformPlan(db, emptyChoices(), { ...deps, nowMs: nowMs + 60000, systemStats: async () => { throw new Error(); } });
  assert.equal(stale.checks.find(c => c.id === 'runner').status, 'fail'); assert.equal(stale.checks.find(c => c.id === 'capacity').status, 'not_checked'); db.close();
});

async function boot(path) {
  const child = fork(new URL('./helpers/platform-api-fixture.js', import.meta.url), [], { env: { ...process.env, PLATFORM_TEST_DB: path, PROXYPILOT_AGENT_SOCKET: `${path}.absent`, JWT_SECRET: 'g1-disposable-test-secret-with-no-production-use' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let stderr = ''; child.stderr.on('data', b => { stderr += b; });
  const ready = await Promise.race([once(child, 'message').then(([m]) => m), once(child, 'exit').then(([code]) => { throw new Error(`fixture exited ${code}: ${stderr}`); })]);
  return { ...ready, stop: async () => { const done = once(child, 'exit'); child.kill('SIGTERM'); await done; } };
}
async function request(server, path, { method = 'GET', body, role = 'admin', csrf = true } = {}) {
  const response = await fetch(server.url + path, { method, headers: { 'Content-Type': 'application/json', ...(role ? { Cookie: `pp_token=${server.tokens[role]}; pp_csrf=test-csrf`, ...(csrf ? { 'X-CSRF-Token': 'test-csrf' } : {}) } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, body: await response.json() };
}

test('real HTTP save → reload → separate API process restart → reopen; auth, CSRF, fresh auth, CAS and unchanged settings', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'platform-g1-')); const path = join(dir, 'state.db'); let server;
  try {
    server = await boot(path);
    const db = new DatabaseSync(path);
    const snapshot = () => JSON.stringify(['services', 'service_http_routes', 'app_settings', 'users', 'setup_jobs', 'setup_job_events'].map(table => db.prepare(`SELECT * FROM ${table}`).all()));
    const before = snapshot();
    for (const route of ['/api/setup/platform', '/api/setup/overview', '/api/setup/jobs', '/api/setup/jobs/fixture-succeeded']) {
      assert.equal((await request(server, route, { role: 'user' })).status, 403);
      assert.equal((await request(server, route, { role: null })).status, 401);
    }
    for (const [path, method, body] of [['/api/setup/platform', 'PUT', saveBody()], ['/api/setup/platform/checks', 'POST', draft()]]) {
      assert.equal((await request(server, path, { method, body, role: 'user' })).status, 403);
      assert.equal((await request(server, path, { method, body, csrf: false })).status, 403);
    }
    assert.equal((await request(server, '/api/setup/platform', { method: 'PUT', body: saveBody(), role: 'coldAdmin' })).body.sudo_required, true);
    const malformed = saveBody(); malformed.choices.keycloak.password = 'must-not-persist';
    assert.equal((await request(server, '/api/setup/platform', { method: 'PUT', body: malformed })).status, 400);
    const saved = await request(server, '/api/setup/platform', { method: 'PUT', body: saveBody() });
    assert.equal(saved.status, 200); assert.equal(saved.body.plan.status, 'saved_plan'); assert.equal(saved.body.plan.revision, 1);
    assert.equal((await request(server, '/api/setup/platform', { method: 'PUT', body: saveBody() })).status, 409);
    assert.deepEqual((await request(server, '/api/setup/platform')).body.plan, saved.body.plan);
    await server.stop(); server = await boot(path);
    const reopened = await request(server, '/api/setup/platform'); assert.deepEqual(reopened.body.plan, saved.body.plan);
    assert.equal(reopened.body.installation.classification, 'existing_configuration');
    assert.equal(snapshot(), before, 'existing services, routes, settings, users and jobs byte-identical');
    assert.equal((await request(server, '/api/setup/platform', { method: 'PUT', body: saveBody(1) })).body.plan.revision, 2);
    const overview = (await request(server, '/api/setup/overview')).body;
    assert.deepEqual(new Set(overview.jobs.map(j => j.status)), new Set(['queued', 'running', 'succeeded', 'failed', 'deferred', 'recovery_required']));
    const detail = (await request(server, '/api/setup/jobs/fixture-succeeded')).body;
    assert.equal(detail.job.status, 'succeeded'); assert.equal(detail.job.verification.state, 'configured');
    assert.ok(!JSON.stringify(detail).includes('must-not-appear')); assert.equal(detail.events.find(e => e.kind === 'fixture').data.password, '[redacted]');
    assert.equal((await request(server, '/api/setup/jobs/no-such-job')).status, 404);
    assert.equal(db.prepare('SELECT count(*) n FROM audit WHERE action = ?').get('PLATFORM_PLAN_SAVED').n, 2);
    db.close();
  } finally { if (server) await server.stop(); rmSync(dir, { recursive: true, force: true }); }
});
