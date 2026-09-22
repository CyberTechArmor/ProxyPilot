import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, unlinkSync, statSync, mkdirSync } from 'node:fs';
import { tmpdir, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { fork, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import https from 'node:https';
import { generateKeyPairSync } from 'node:crypto';
import { ensureSetupEngineSchema, getJob, startJob, runnerHeartbeat, readLock } from '../lib/setup-engine/store.js';
import { emptyChoices, savePlatformPlan, PLATFORM_PLAN_SCHEMA } from '../lib/setup-engine/platform-plan.js';
import { KEYCLOAK_SCHEMA, applyKeycloak, readKeycloak } from '../lib/setup-engine/keycloak-store.js';
import { KEYCLOAK_APP, keycloakTargetSchema, KEYCLOAK_IMAGE, KEYCLOAK_DB_IMAGE, resourceNames } from '../lib/setup-engine/keycloak-logic.js';
import { ensureKeycloakRuntime, prepareKeycloakFiles } from '../lib/setup-engine/keycloak-runtime.js';
import { verifyKeycloak, readIssuerJson, allowedAddress } from '../lib/setup-engine/keycloak-discovery.js';
import { configureKeycloakRoute } from '../lib/setup-engine/keycloak-routes.js';
import { runOnce, reconcile } from '../lib/setup-engine/executor.js';
import { runBackendSteps } from '../lib/setup-engine/backend-steps.js';
import { validateRunnerJob, FencedError } from '../lib/setup-engine/logic.js';

const runner = 'runner@g2#123:first', backend = 'backend@g2#124:first';
const target = { mode: 'install', url: 'https://identity.example.com', realm: 'proxypilot' };
const keys = [generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'jwk' })];
function discoveryReader({ fail = false } = {}) { return async (url, origin) => {
  if (fail) throw new Error('Scripted issuer unreachable');
  return url.endsWith('/certs') ? { keys } : { issuer: `${origin}/realms/proxypilot`, jwks_uri: `${origin}/realms/proxypilot/protocol/openid-connect/certs` };
}; }
function plan(db, t = target) {
  const revision = db.prepare('SELECT revision FROM setup_platform_plan').get()?.revision || 0;
  return savePlatformPlan(db, { schemaVersion: 1, expectedRevision: revision, choices: { ...emptyChoices(), keycloak: t } }, { checks: [] }, 'admin');
}
function schema(db) {
  ensureSetupEngineSchema(db); db.exec(PLATFORM_PLAN_SCHEMA); db.exec(KEYCLOAK_SCHEMA);
  db.exec(`CREATE TABLE IF NOT EXISTS services (id TEXT PRIMARY KEY, name TEXT, domain TEXT, kind TEXT, runtime TEXT, target_ip TEXT, type TEXT, status TEXT);
  CREATE TABLE IF NOT EXISTS service_http_routes (id TEXT PRIMARY KEY, service_id TEXT, domain TEXT, path_prefix TEXT, target_port INTEGER, websocket_enabled INTEGER, ssl_enabled INTEGER, force_https INTEGER, max_upload_size TEXT, strip_prefix INTEGER, UNIQUE(domain,path_prefix));
  CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT);`);
}
function dockerFixture() {
  const objects = new Map(); const calls = []; let failAt = null; let interrupt = null;
  const host = async argv => {
    calls.push(argv);
    if (interrupt && argv.includes(interrupt)) { interrupt = null; throw new FencedError('simulated-dead-owner'); }
    if (failAt && argv.includes(failAt)) return { code: 1, stderr: 'raw secret must not escape' };
    const a = argv.slice(1), ok = stdout => ({ code: 0, stdout: stdout || '', stderr: '' });
    if (a[0] === 'version') return ok('28.0');
    if (a[1] === 'ls') return ok([...objects.values()].filter(x => x.kind === a[0]).map(x => x.name).join('\n'));
    if (a[1] === 'inspect') return ok(JSON.stringify(a.at(-1).includes('.Config.Image') ? objects.get(a[2]).config : objects.get(a[2]).labels));
    if (a[1] === 'create' || a[0] === 'create') {
      const kind = a[0] === 'create' ? 'container' : a[0];
      const name = kind === 'container' ? a[a.indexOf('--name') + 1] : a.at(-1);
      assert.ok(!objects.has(name), `duplicate resource ${name}`);
      const labels = {}; for (let i = 0; i < a.length; i++) if (a[i] === '--label') { const [k,v] = a[i+1].split('='); labels[k] = v; }
      const config = kind === 'container' ? {
        image: a.includes(KEYCLOAK_IMAGE) ? KEYCLOAK_IMAGE : KEYCLOAK_DB_IMAGE,
        network: a[a.indexOf('--network')+1], restart: 'unless-stopped',
        command: a.includes(KEYCLOAK_IMAGE) ? ['start','--import-realm'] : ['postgres'],
        ports: a.includes('--publish') ? {'8080/tcp':[{HostIp:'127.0.0.1',HostPort:'18080'}]} : {},
        mounts: (()=>{const m=Object.fromEntries(a[a.indexOf('--mount')+1].split(',').map(p=>p.split('=')));return [{Type:m.type,Name:m.type==='volume'?m.source:undefined,Source:m.source,Destination:m.target,RW:!('readonly' in m)}];})(),
      } : null;
      objects.set(name, { kind, name, labels, config }); return ok(name);
    }
    if (a[0] === 'start') { assert.ok(objects.has(a[1])); return ok(a[1]); }
    if (a[0] === 'exec') {
      if (a.includes('psql')) return ok(objects.get(a[1]).labels['io.proxypilot.keycloak']);
      return ok();
    }
    throw new Error(`Unhandled scripted Docker argv: ${JSON.stringify(argv)}`);
  };
  return { host, calls, objects, fail(value) { failAt = value; }, interrupt(value) { interrupt = value; } };
}
function renderFixture(dir) {
  mkdirSync(dir, { recursive: true }); let reloads = 0;
  return { get reloads() { return reloads; },
    caddyFilePath: domain => join(dir, `${domain}.caddy`),
    regenerate: async (db, domain) => { const row = db.prepare('SELECT * FROM service_http_routes WHERE domain = ?').get(domain); writeFileSync(join(dir, `${domain}.caddy`), `${domain} {\n reverse_proxy 127.0.0.1:${row.target_port}\n}\n`); },
    adapt: async () => {}, reload: async () => { reloads++; }, writeConfig: async (path, content) => writeFileSync(path, content), removeConfig: async path => { if (existsSync(path)) unlinkSync(path); } };
}
function dependencies(db, dir, docker, opts = {}) {
  let clock = Date.now();
  return { db, owner: runner, exec: docker, nowMs: () => clock, advance: (ms = 20000) => { clock += ms; },
    keycloakDeps: { runtime: (row, { exec, job }) => ensureKeycloakRuntime(row, { exec, job, root: join(dir, 'protected'), attempts: 1, sleep: async () => {} }), verify: t => verifyKeycloak(t, { readJson: discoveryReader(opts) }) } };
}
async function completeManaged(db, deps, dir) {
  await runOnce(deps, { max: 1, kinds: ['keycloak_setup'] });
  const render = renderFixture(join(dir, 'sites'));
  await runBackendSteps({ db, owner: backend, deps: { configureKeycloakRoute: args => configureKeycloakRoute(db, { ...args, render }) } });
  deps.advance(); await runOnce(deps, { max: 1, kinds: ['keycloak_setup'] });
  return render;
}
async function boot(path) {
  const child = fork(new URL('./helpers/platform-api-fixture.js', import.meta.url), [], { env: { ...process.env, PLATFORM_TEST_DB: path, PROXYPILOT_AGENT_SOCKET: `${path}.absent`, JWT_SECRET: 'g2-disposable-api-test-secret', SETUP_EXECUTOR_POLICY: 'runner-required' }, stdio: ['ignore','pipe','pipe','ipc'] });
  let stderr = ''; child.stderr.on('data', b => { stderr += b; });
  const ready = await Promise.race([once(child, 'message').then(([m]) => m), once(child, 'exit').then(([c]) => { throw new Error(`fixture ${c}: ${stderr}`); })]);
  return { ...ready, stop: async () => { const done = once(child, 'exit'); child.kill('SIGTERM'); await done; } };
}
async function request(server, path, { method = 'GET', body, role = 'admin', csrf = true } = {}) {
  const r = await fetch(server.url + path, { method, headers: { 'Content-Type': 'application/json', ...(role ? { Cookie: `pp_token=${server.tokens[role]}; pp_csrf=test-csrf`, ...(csrf ? { 'X-CSRF-Token': 'test-csrf' } : {}) } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, body: await r.json() };
}

test('actual API → saved revision → durable external job → runner verification; auth, CSRF, fresh auth, stale and skip refusals; no takeover', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'g2-api-')); let server; const db = new DatabaseSync(join(dir, 'state.db'));
  try {
    server = await boot(join(dir, 'state.db'));
    const unchanged = () => JSON.stringify(['services','service_http_routes','app_settings','users'].map(t => db.prepare(`SELECT * FROM ${t}`).all()));
    const before = unchanged();
    const baseJobs = db.prepare('SELECT count(*) n FROM setup_jobs').get().n;
    const save = revision => ({ schemaVersion: 1, expectedRevision: revision, reviewed: true, choices: { ...emptyChoices(), keycloak: { ...target, mode: 'connect' } } });
    const saved = await request(server, '/api/setup/platform', { method: 'PUT', body: save(0) }); assert.equal(saved.status, 200);
    assert.equal(db.prepare('SELECT count(*) n FROM setup_jobs').get().n, baseJobs);
    const apply = { expectedRevision: 1, reviewed: true };
    for (const role of [null, 'user', 'coldAdmin']) assert.equal((await request(server, '/api/setup/platform/keycloak/apply', { method: 'POST', body: apply, role })).status, role === 'coldAdmin' ? 401 : 403);
    assert.equal((await request(server, '/api/setup/platform/keycloak/apply', { method: 'POST', body: apply, csrf: false })).status, 403);
    assert.equal((await request(server, '/api/setup/platform/keycloak/apply', { method: 'POST', body: { ...apply, password: 'secret' } })).status, 400);
    assert.equal((await request(server, '/api/setup/platform/keycloak/review?revision=1')).body.review.ownership, 'external');
    await request(server, '/api/setup/platform', { method: 'PUT', body: save(1) });
    assert.equal((await request(server, '/api/setup/platform/keycloak/apply', { method: 'POST', body: apply })).status, 409);
    apply.expectedRevision = 2;
    const accepted = await request(server, '/api/setup/platform/keycloak/apply', { method: 'POST', body: apply });
    assert.equal(accepted.status, 202); assert.equal(accepted.body.runnerAvailable, false); assert.match(accepted.body.job.reason, /runner_unavailable/);
    const id = accepted.body.job.id;
    assert.equal((await request(server, '/api/setup/platform/keycloak/apply', { method: 'POST', body: apply })).body.job.id, id);
    assert.equal((await request(server, `/api/setup/jobs/${id}/retry`, { method: 'POST', body: {} })).status, 409);
    await server.stop(); server = await boot(join(dir, 'state.db'));
    assert.equal((await request(server, `/api/setup/jobs/${id}`)).body.job.status, 'queued');
    const docker = dockerFixture(); const deps = dependencies(db, dir, docker);
    await runOnce(deps, { max: 10, kinds: ['keycloak_setup'] });
    const result = (await request(server, `/api/setup/jobs/${id}`)).body;
    assert.equal(result.job.status, 'succeeded'); assert.equal(result.job.verification.administrativePermission, 'not_checked'); assert.equal(result.job.verification.databaseReady, 'not_checked');
    assert.equal(docker.calls.length, 0); assert.equal(unchanged(), before);
    const state = (await request(server, '/api/setup/platform')).body;
    assert.equal(state.keycloak[0].verification.issuerExact, true);
    assert.equal(state.installation.verifiedServices.find(s=>s.id==='keycloak').state,'keycloak_connected');
    assert.deepEqual(state.installation.installableServices,['keycloak','pomerium']); assert.equal(state.installation.loginActivationAvailable,false);
    const skip = save(2); skip.choices.keycloak = { mode: 'skip', url: '' };
    await request(server, '/api/setup/platform', { method: 'PUT', body: skip });
    assert.equal((await request(server, '/api/setup/platform/keycloak/apply', { method: 'POST', body: { expectedRevision: 3, reviewed: true } })).body.code, 'KEYCLOAK_SKIPPED');
    assert.equal(db.prepare('SELECT count(*) n FROM setup_jobs').get().n, baseJobs + 1);
  } finally { if (server) await server.stop(); db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('managed operation uses actual executor, protected files and route SQL/render handoff; readiness + discovery required; no duplicate resources or rotation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'g2-managed-')); const db = new DatabaseSync(join(dir, 'state.db')); let server;
  try {
    server = await boot(join(dir, 'state.db'));
    for (const [table, columns] of Object.entries({ services: ['kind TEXT','runtime TEXT','target_ip TEXT','type TEXT','status TEXT'], service_http_routes: ['service_id TEXT','path_prefix TEXT','target_port INTEGER','websocket_enabled INTEGER','ssl_enabled INTEGER','force_https INTEGER','max_upload_size TEXT','strip_prefix INTEGER'] })) for (const col of columns) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col}`);
    db.exec("INSERT OR IGNORE INTO app_settings VALUES ('auth_provider','local'), ('admin_domain','pilot.example.com')");
    const saved = await request(server, '/api/setup/platform', { method:'PUT', body:{ schemaVersion:1, expectedRevision:0, reviewed:true, choices:{...emptyChoices(),keycloak:target} } }); assert.equal(saved.status,200);
    const submitted = (await request(server, '/api/setup/platform/keycloak/apply', { method:'POST',body:{expectedRevision:1,reviewed:true} })).body;
    const id = submitted.job.plan.params.installationId;
    const docker = dockerFixture(); const deps = dependencies(db, dir, docker);
    const render = await completeManaged(db, deps, dir);
    const job = (await request(server, `/api/setup/jobs/${submitted.job.id}`)).body.job; assert.equal(job.status, 'succeeded', job.reason);
    const row = readKeycloak(db, id); assert.ok(row.verified_at); assert.equal(JSON.parse(row.verified_json).serviceReady, true);
    const credentials = readFileSync(join(dir, 'protected', id, 'credentials.json'), 'utf8');
    assert.equal(statSync(join(dir, 'protected', id, 'credentials.json')).mode & 0o777, 0o600);
    assert.equal(docker.objects.size, 4); assert.equal(render.reloads, 1);
    assert.equal(db.prepare('SELECT count(*) n FROM service_http_routes').get().n, 2);
    assert.equal(db.prepare("SELECT value FROM app_settings WHERE key='auth_provider'").get().value, 'unchanged-local');
    assert.equal(applyKeycloak(db, { expectedRevision: 1, reviewed: true, retry: true }, 'admin', true).job.id, submitted.job.id);
    assert.equal(readFileSync(join(dir, 'protected', id, 'credentials.json'), 'utf8'), credentials);
    const publicRecords = JSON.stringify(db.prepare('SELECT * FROM setup_jobs').all()) + JSON.stringify(db.prepare('SELECT * FROM setup_job_events').all());
    for (const secret of Object.values(JSON.parse(credentials))) assert.ok(!publicRecords.includes(secret));
    assert.ok(docker.calls.some(a => a.includes(KEYCLOAK_IMAGE))); assert.ok(docker.calls.some(a => a.includes(KEYCLOAK_DB_IMAGE)));
    assert.ok(!docker.calls.some(a => a.includes('down') || a.includes('rm')));
  } finally { if(server) await server.stop(); db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('slow recorded Caddy handoff keeps Keycloak queued under the route locks and automatically completes verification', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'g2-slow-route-')); const db = new DatabaseSync(':memory:'); schema(db);
  let routeRun, releaseReload;
  try {
    plan(db); const submitted = applyKeycloak(db, { expectedRevision: 1, reviewed: true }, 'admin', true);
    const id = submitted.job.plan.params.installationId;
    const docker = dockerFixture(), deps = dependencies(db, dir, docker);
    let verifications = 0;
    const verify = deps.keycloakDeps.verify;
    deps.keycloakDeps.verify = async t => { verifications++; return verify(t); };
    await runOnce(deps, { max: 1, kinds: ['keycloak_setup'] });
    assert.equal(getJob(db, submitted.job.id).status, 'queued');
    const routeId = readKeycloak(db, id).route_job_id;
    const path = join(dir, 'protected', id, 'credentials.json'), credentials = readFileSync(path, 'utf8');
    const render = renderFixture(join(dir, 'sites'));
    const reloadBlocked = new Promise(resolve => { releaseReload = resolve; });
    let signalReload;
    const reloadEntered = new Promise(resolve => { signalReload = resolve; });
    routeRun = runBackendSteps({ db, owner: backend, nowMs: deps.nowMs, max: 1,
      deps: { configureKeycloakRoute: args => configureKeycloakRoute(db, { ...args, render: {
        ...render, reload: async () => { signalReload(); await reloadBlocked; await render.reload(); },
      } }) } });
    await reloadEntered;
    assert.equal(getJob(db, routeId).status, 'running');
    const appLock = readLock(db, KEYCLOAK_APP), routesLock = readLock(db, '@host/routes');
    assert.equal(appLock.job_id, routeId); assert.equal(routesLock.job_id, routeId);
    const callsBeforeWait = docker.calls.length;
    // The parent is due after 15 seconds; the backend still owns both live locks.
    deps.advance(16000);
    const overlap = await runOnce(deps, { max: 1, kinds: ['keycloak_setup'] });
    assert.equal(overlap.ran.length, 1);
    const pending = getJob(db, submitted.job.id);
    assert.equal(pending.status, 'queued');
    assert.equal(pending.finished_at, null);
    assert.ok(Date.parse(JSON.parse(pending.progress_json).not_before) > deps.nowMs());
    assert.equal(pending.phase, 'public_route');
    assert.deepEqual(readLock(db, KEYCLOAK_APP), appLock);
    assert.deepEqual(readLock(db, '@host/routes'), routesLock);
    assert.equal(docker.calls.length, callsBeforeWait); assert.equal(verifications, 0);
    assert.equal(readKeycloak(db, id).verified_at, null);
    releaseReload(); await routeRun;
    assert.equal(getJob(db, routeId).status, 'succeeded');
    deps.advance(); await runOnce(deps, { max: 1, kinds: ['keycloak_setup'] });
    assert.equal(getJob(db, submitted.job.id).status, 'succeeded');
    assert.equal(verifications, 1); assert.ok(readKeycloak(db, id).verified_at);
    assert.equal(readKeycloak(db, id).route_job_id, routeId);
    assert.equal(db.prepare('SELECT count(*) n FROM setup_jobs').get().n, 2);
    assert.equal(db.prepare('SELECT count(*) n FROM service_http_routes').get().n, 1);
    assert.equal(docker.objects.size, 4); assert.equal(render.reloads, 1);
    assert.equal(readFileSync(path, 'utf8'), credentials);
  } finally {
    releaseReload?.(); if (routeRun) await routeRun;
    db.close(); rmSync(dir, { recursive: true, force: true });
  }
});

test('dead runner after database creation is reconciled and resumed using the same credentials/resources; failed public verification remains failed and retry reuses', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'g2-interrupt-')); const db = new DatabaseSync(':memory:'); schema(db);
  try {
    plan(db); const submitted = applyKeycloak(db, { expectedRevision: 1, reviewed: true }, 'admin', true); const id = submitted.job.plan.params.installationId;
    const docker = dockerFixture(); const deps = dependencies(db, dir, docker, { fail: true });
    docker.interrupt('pg_isready');
    await runOnce(deps, { max: 1, kinds: ['keycloak_setup'] }); assert.equal(getJob(db, submitted.job.id).status, 'running');
    const path = join(dir, 'protected', id, 'credentials.json'), saved = readFileSync(path, 'utf8');
    deps.advance(); deps.advance();
    reconcile({ db, owner: 'runner@g2#999:next', nowMs: deps.nowMs() });
    assert.equal(getJob(db, submitted.job.id).status, 'queued');
    await completeManaged(db, deps, dir);
    assert.equal(getJob(db, submitted.job.id).status, 'failed'); assert.equal(readKeycloak(db,id).verified_at, null);
    assert.equal(docker.objects.size, 4); assert.equal(readFileSync(path,'utf8'), saved);
    const retry = applyKeycloak(db, { expectedRevision: 1, reviewed: true, retry: true }, 'admin', true);
    deps.keycloakDeps.verify = t => verifyKeycloak(t, { readJson: discoveryReader() });
    await completeManaged(db, deps, dir);
    assert.equal(getJob(db, retry.job.id).status, 'succeeded', getJob(db, retry.job.id).reason);
    assert.equal(docker.objects.size, 4); assert.equal(readFileSync(path,'utf8'), saved);
    unlinkSync(path);
    assert.throws(() => prepareKeycloakFiles(readKeycloak(db,id), { root: join(dir,'protected'), resourcesExist:true }), /No credentials were regenerated/);
  } finally { db.close(); rmSync(dir,{ recursive:true, force:true }); }
});

test('runner validation, collision refusal, unavailable runtime and backend policy do not mutate unrelated resources', async () => {
  assert.equal(keycloakTargetSchema.safeParse({ ...target, url:'https://identity.example.com/realms/a' }).success,false);
  assert.equal(keycloakTargetSchema.safeParse({ ...target, realm:'master' }).success,false);
  assert.equal(validateRunnerJob({ app:KEYCLOAK_APP, kind:'keycloak_setup', plan:{ params:{ installationId:'kc-0123456789ab', revision:1, command:'whoami' } } }).ok,false);
  const dir=mkdtempSync(join(tmpdir(),'g2-collision-')); const db=new DatabaseSync(':memory:');schema(db);
  try {
    plan(db); const submitted=applyKeycloak(db,{ expectedRevision:1, reviewed:true },'admin',false);
    const docker=dockerFixture(), deps=dependencies(db,dir,docker);
    await runOnce({ ...deps, owner:backend },{ max:1 }); assert.equal(docker.calls.length,0); assert.equal(getJob(db,submitted.job.id).status,'queued');
    deps.advance();deps.advance(); docker.fail('version'); await runOnce(deps,{ max:1 }); assert.equal(getJob(db,submitted.job.id).status,'failed'); assert.equal(docker.objects.size,0);
    assert.ok(!getJob(db,submitted.job.id).reason.includes('raw secret'));
    const retry=applyKeycloak(db,{ expectedRevision:1,reviewed:true,retry:true },'admin',true);docker.fail(null);
    const id=retry.job.plan.params.installationId;
    docker.objects.set(resourceNames(id).volume,{ kind:'volume',name:resourceNames(id).volume,labels:{} });
    await runOnce(deps,{ max:1 }); assert.match(getJob(db,retry.job.id).reason,/collision/); assert.equal(docker.objects.size,1);
    assert.equal(existsSync(join(dir,'protected',id,'credentials.json')),false);
  } finally { db.close();rmSync(dir,{recursive:true,force:true}); }
});

test('discovery refuses wrong issuer, cross-origin keys and unusable keys; network rejects loopback, link-local, mapped IPv6', async () => {
  for(const address of ['127.0.0.1','169.254.169.254','0.0.0.0','::ffff:127.0.0.1','100.100.100.200','224.0.0.1']) assert.equal(allowedAddress(address),false);
  await assert.rejects(verifyKeycloak(target,{readJson:async()=>({issuer:'https://evil.example.com'})}),/exactly/);
  await assert.rejects(verifyKeycloak(target,{readJson:async()=>({issuer:`${target.url}/realms/proxypilot`,jwks_uri:'https://evil.example.com/certs'})}),/Signing-key/);
  await assert.rejects(verifyKeycloak(target,{readJson:async url=>url.endsWith('/certs')?{keys:[{kty:'oct',k:'secret'}]}:{issuer:`${target.url}/realms/proxypilot`,jwks_uri:`${target.url}/realms/proxypilot/protocol/openid-connect/certs`}}),/public signing/);
});

test('real HTTPS transport: TLS hostname/CA validation, pinned DNS, no redirects, bounded body and successful discovery/key parsing', async () => {
  const dir=mkdtempSync(join(tmpdir(),'g2-tls-'));
  // Sandbox exposes only loopback. The transport seam maps one validated test
  // address to the local TLS server; TLS, request bounds and parsing remain real.
  const address='10.23.45.67';
  let server;
  try {
    execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(dir,'key.pem'),'-out',join(dir,'cert.pem'),'-days','1','-subj','/CN=issuer.example.test','-addext','subjectAltName=DNS:issuer.example.test'],{stdio:'ignore'});
    const ca=readFileSync(join(dir,'cert.pem')); let origin; let state='ok';let hits=0;
    server=https.createServer({key:readFileSync(join(dir,'key.pem')),cert:ca},(req,res)=>{hits++;if(state==='redirect'){res.writeHead(302,{Location:'https://evil.example.com'});res.end();return;} if(state==='large'){res.end('x'.repeat(1024*1024+1));return;} res.setHeader('Content-Type','application/json');res.end(JSON.stringify(req.url.endsWith('/certs')?{keys}:{issuer:`${origin}/realms/proxypilot`,jwks_uri:`${origin}/realms/proxypilot/protocol/openid-connect/certs`}));});
    await new Promise(r=>server.listen(0,'0.0.0.0',r));origin=`https://issuer.example.test:${server.address().port}`;
    const resolve=async()=>[{address,family:4}];
    const request=(url,opts,cb)=>{ const pinned=opts.lookup; return https.get(url,{...opts,ca,lookup:(host,options,callback)=>pinned(host,options,(err,found)=>{ assert.equal(err,null); assert.equal(Array.isArray(found)?found[0].address:found,address); callback(null,options.all?[{address:'127.0.0.1',family:4}]:'127.0.0.1',4); })},cb); };
    const readJson=(url,approved)=>readIssuerJson(url,approved,{resolve,request});
    const result=await verifyKeycloak({...target,mode:'connect',url:origin},{readJson});assert.equal(result.signingKeys,true);assert.equal(hits,2);
    await assert.rejects(readIssuerJson(`${origin}/x`,origin,{resolve,request:(url,opts,cb)=>request(url,{...opts,servername:'wrong.example.test'},cb)}),/HTTPS request failed/);
    await assert.rejects(readIssuerJson(`${origin}/x`,origin,{resolve:async()=>[{address:'127.0.0.1',family:4}],request}),/blocked/);
    state='redirect';await assert.rejects(readJson(`${origin}/x`,origin),/redirects/);
    state='large';await assert.rejects(readJson(`${origin}/x`,origin),/failed|MiB/);
  } finally { if(server) await new Promise(r=>server.close(r));rmSync(dir,{recursive:true,force:true}); }
});

test('current D.14 service schema works; Caddy collisions and render failure preserve other routes; lease loss stops writes', async () => {
  const dir = mkdtempSync(join(tmpdir(),'g2-routes-')); const db=new DatabaseSync(':memory:');schema(db);
  try {
    db.exec('ALTER TABLE services DROP COLUMN domain');
    plan(db);const submitted=applyKeycloak(db,{expectedRevision:1,reviewed:true},'admin',true); const id=submitted.job.plan.params.installationId;
    db.prepare('UPDATE setup_keycloak SET resources_json=? WHERE id=?').run(JSON.stringify({serviceReady:true,databaseReady:true}),id);
    const render=renderFixture(join(dir,'sites')); const call=(fence=()=>{})=>configureKeycloakRoute(db,{installationId:id,render,fence});
    mkdirSync(join(dir,'custom')); const custom=join(dir,'custom','external.caddy');
    writeFileSync(custom,'unrelated.example.com {\n}\nidentity.example.com {\n reverse_proxy 192.0.2.9:5000\n}\n');
    await assert.rejects(call(),/unmanaged Caddy/);assert.equal(db.prepare('SELECT count(*) n FROM services').get().n,0);unlinkSync(custom);
    db.exec("INSERT INTO service_http_routes (id,service_id,domain,path_prefix,target_port) VALUES ('other','unrelated','identity.example.com','/a',99)");
    await assert.rejects(call(),/another managed route/);assert.equal(db.prepare("SELECT target_port FROM service_http_routes WHERE id='other'").get().target_port,99);
    db.exec("DELETE FROM service_http_routes WHERE id='other'");
    let checks=0;await assert.rejects(call(()=>{ if(++checks===3) throw Object.assign(new Error('fenced'),{code:'LEASE_LOST'}); }),/fenced/);
    assert.equal(db.prepare('SELECT count(*) n FROM service_http_routes').get().n,0);
    const badRender={...render,adapt:async()=>{throw new Error('scripted invalid Caddy config');}};
    await assert.rejects(configureKeycloakRoute(db,{installationId:id,render:badRender,fence:()=>{}}),/validation/);
    assert.equal(existsSync(render.caddyFilePath('identity.example.com')),false,'failed render restores absent file');
    await call(); assert.equal(db.prepare('SELECT count(*) n FROM service_http_routes').get().n,1,'retry renders the same owned row');
  } finally {db.close();rmSync(dir,{recursive:true,force:true});}
});

test('actual loss of runner epoch fences the operation before further runtime writes; long operations renew runner and job evidence', async () => {
  const dir=mkdtempSync(join(tmpdir(),'g2-fence-'));const db=new DatabaseSync(':memory:');schema(db);
  try {
    plan(db);const submitted=applyKeycloak(db,{expectedRevision:1,reviewed:true},'admin',true);
    const docker=dockerFixture(),deps=dependencies(db,dir,docker);const original=docker.host;
    docker.host=async argv=>{const result=await original(argv);if(argv.includes('version'))db.prepare('UPDATE setup_jobs SET epoch=epoch+1 WHERE id=?').run(submitted.job.id);return result;};
    const result=await runOnce(deps,{max:1,kinds:['keycloak_setup']});assert.equal(result.ran[0].status,'fenced');assert.equal(docker.calls.length,1);assert.equal(docker.objects.size,0);
    assert.equal(db.prepare('SELECT count(*) n FROM setup_runners WHERE owner=?').get(runner).n,1);
  } finally {db.close();rmSync(dir,{recursive:true,force:true});}
});

test('API restart reconciliation resumes an interrupted Caddy handoff with the same route and no new credentials', async () => {
  const { sweepSetupEngineOnBoot } = await import('../lib/setup-engine/backend.js');
  const dir=mkdtempSync(join(tmpdir(),'g2-route-resume-'));const db=new DatabaseSync(':memory:');schema(db);
  try {
    plan(db);const submitted=applyKeycloak(db,{expectedRevision:1,reviewed:true},'admin',true); const id=submitted.job.plan.params.installationId;
    const docker=dockerFixture(),deps=dependencies(db,dir,docker);
    await runOnce(deps,{max:1,kinds:['keycloak_setup']});const row=readKeycloak(db,id);
    const files=readFileSync(join(dir,'protected',id,'credentials.json'),'utf8');
    startJob(db,{id:row.route_job_id,owner:backend,nowMs:deps.nowMs()-60000});
    const render=renderFixture(join(dir,'sites'));
    await configureKeycloakRoute(db,{installationId:id,render,fence:()=>{}}); // writer died before completion was recorded
    sweepSetupEngineOnBoot(db,{owner:'backend@g2#222:restarted',nowMs:deps.nowMs()});
    assert.equal(getJob(db,row.route_job_id).status,'queued');
    await runBackendSteps({db,owner:'backend@g2#222:restarted',deps:{configureKeycloakRoute:args=>configureKeycloakRoute(db,{...args,render})}});
    deps.advance();await runOnce(deps,{max:1,kinds:['keycloak_setup']});
    assert.equal(getJob(db,submitted.job.id).status,'succeeded');assert.equal(db.prepare('SELECT count(*) n FROM service_http_routes').get().n,1);
    assert.equal(readFileSync(join(dir,'protected',id,'credentials.json'),'utf8'),files);assert.equal(docker.objects.size,4);
  } finally {db.close();rmSync(dir,{recursive:true,force:true});}
});

test('database readiness failure never schedules a public route or records verified state', async () => {
  const dir=mkdtempSync(join(tmpdir(),'g2-unready-'));const db=new DatabaseSync(':memory:');schema(db);
  try {
    plan(db);const submitted=applyKeycloak(db,{expectedRevision:1,reviewed:true},'admin',true);const id=submitted.job.plan.params.installationId;
    const docker=dockerFixture();docker.fail('pg_isready');const deps=dependencies(db,dir,docker);
    await runOnce(deps,{max:1,kinds:['keycloak_setup']});
    assert.equal(getJob(db,submitted.job.id).status,'failed');assert.match(getJob(db,submitted.job.id).reason,/readiness/);
    assert.equal(readKeycloak(db,id).route_job_id,null);assert.equal(readKeycloak(db,id).verified_at,null);
    assert.equal(db.prepare("SELECT count(*) n FROM setup_jobs WHERE kind='configure_keycloak_route'").get().n,0);
    assert.equal(docker.objects.size,3,'network, persistent volume and database retained for retry');
  } finally {db.close();rmSync(dir,{recursive:true,force:true});}
});
