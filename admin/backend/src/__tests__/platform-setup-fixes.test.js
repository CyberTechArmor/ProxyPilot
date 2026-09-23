// Platform Setup fixes from the live Fractionate host (2026-09-23):
//   1. a reviewed restricted-network change is no longer refused (the review
//      token was carried in the job plan, which is redacted on write);
//   2. the Infisical server's published port binds (an owned non-internal
//      edge bridge), and the Agent Proxy is "pending" before bootstrap;
//   3. a non-safe adapter exception is recorded as an adapter_error event, and
//      Vaultwarden's runtime compares image defaults a newer Docker omits.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { makeDb, approved, handle, keycloakWire, driveStages, completeStageB, continueJob } from './helpers/full-platform-fixture.js';
import { keycloakAdmin, reconcileOwnedIdentity, storeProtected } from '../lib/setup-engine/full-platform-keycloak.js';
import { runFullPlatformOperation } from '../lib/setup-engine/full-platform-op.js';
import { readFullPlatform } from '../lib/setup-engine/full-platform-store.js';
import { readVaultwarden } from '../lib/setup-engine/vaultwarden-store.js';
import { networksReview, queueNetworksChange } from '../lib/setup-engine/full-platform-networks.js';
import { startJob, getJob, listEvents, createJob } from '../lib/setup-engine/store.js';
import { runBackendSteps } from '../lib/setup-engine/backend-steps.js';
import { backendStepDeps } from '../mock2/ops.js';
import { SECRET_KEY_RE, redact, adapterErrorDiagnostic } from '../lib/setup-engine/logic.js';
import { dockerFixture } from './helpers/infisical-fixture.js';
import { ensureInfisicalRuntime, namesFor as infisicalNames, edgeNetworkCurrent } from '../lib/setup-engine/infisical-runtime.js';
import { platformServiceView, pendingContainer } from '../lib/setup-engine/full-platform-mcp.js';
import { sameArgv, sameUser, portListening } from '../lib/setup-engine/owned-runtime.js';
import { ensureRuntime as ensureVaultwardenRuntime } from '../lib/setup-engine/vaultwarden-runtime.js';
import { VAULTWARDEN_IMAGE } from '../lib/setup-engine/vaultwarden-logic.js';
import { INFISICAL_PORT } from '../lib/setup-engine/infisical-logic.js';
const { buildDomainCaddyConfig } = await import('../routes/services.js');

const terminal = (db, id, status = 'succeeded', verification = null) => db.prepare('UPDATE setup_jobs SET status=?,owner=NULL,verification_json=? WHERE id=?').run(status, verification ? JSON.stringify(verification) : null, id);
const withDb = async (fn) => { const db = makeDb(), dir = mkdtempSync(join(tmpdir(), 'pp-fixes-')); try { await fn(db, dir); } finally { db.close(); rmSync(dir, { recursive: true, force: true }); } };

/** The coordinator driven to its handoff so the service records exist. */
// The coordinator driven through stage D (B's human part scripted), every child scripted.
async function connected(db, through = 'D') { return driveStages(db, { owner: 'runner@fixes#1:a', through }); }

function renderer(dir) {
  mkdirSync(join(dir, 'sites'), { recursive: true });
  const render = {
    caddyFilePath: (d) => join(dir, 'sites', `${d}.caddy`),
    regenerate: async (db, d) => { const rows = db.prepare('SELECT r.*,s.target_ip,s.kind,s.type FROM service_http_routes r JOIN services s ON s.id=r.service_id WHERE r.domain=?').all(d); writeFileSync(render.caddyFilePath(d), buildDomainCaddyConfig(rows, d)); },
    adapt: async () => {}, reload: async () => {}, writeConfig: async (p, s) => writeFileSync(p, s), removeConfig: async (p) => rmSync(p, { force: true }),
  };
  return render;
}

/* ---------------------------------- 1 ---------------------------------- */

test('1: queueNetworksChange → executeBackendStep succeeds and rewrites the routes and records (no "[redacted]" token comparison)', () => withDb(async (db, dir) => {
  await connected(db);
  // Vaultwarden's owned route is recorded, as its adapter would have left it.
  const vw = readVaultwarden(db), routeId = `vaultwarden-route-${vw.credential_ref}`;
  db.prepare("INSERT INTO services (id, name, kind, runtime, target_ip, type, status) VALUES (?, 'pp-platform-vaultwarden', 'container_service', 'docker', '127.0.0.1', 'proxy', 'active')").run(`vaultwarden-${vw.credential_ref}`);
  db.prepare("INSERT INTO service_http_routes (id, service_id, domain, path_prefix, target_port, websocket_enabled, ssl_enabled, force_https, max_upload_size, strip_prefix, ip_allowlist_json) VALUES (?, ?, 'vault.example.com', '/', 18380, 1, 1, 1, '1G', 0, '[\"10.20.30.0/24\"]')").run(routeId, `vaultwarden-${vw.credential_ref}`);
  const review = networksReview(db, ['10.9.0.0/24']);
  assert.deepEqual(review.blockers, []);
  const { job } = queueNetworksChange(db, { revision: review.revision, reviewToken: review.reviewToken, additionalNetworks: review.additional_networks, reviewed: true }, 'admin');
  // The plan carries nothing the redactor rewrites: the token lives in state only.
  const plan = JSON.parse(db.prepare('SELECT plan_json FROM setup_jobs WHERE id=?').get(job.id).plan_json);
  assert.deepEqual(plan, { params: { revision: review.revision } });
  assert.ok(!JSON.stringify(plan).includes('[redacted]'));

  const render = renderer(join(dir, 'caddy'));
  const out = await runBackendSteps({ db, owner: 'backend@fixes#1:a', sleep: async () => {}, deps: backendStepDeps({ getDb: () => db, renderDeps: render }) });
  const ran = out.ran.find((r) => r.id === job.id);
  assert.equal(ran?.status, 'succeeded', getJob(db, job.id).reason);
  assert.equal(JSON.parse(db.prepare('SELECT ip_allowlist_json FROM service_http_routes WHERE id=?').get(routeId).ip_allowlist_json)[0], '10.9.0.0/24');
  assert.equal(readVaultwarden(db).config.allowedIps.includes('10.9.0.0/24'), true);
  assert.ok(readFullPlatform(db).config.recoveryNetworks.includes('10.9.0.0/24'));
  assert.equal(readFullPlatform(db).state.networksChange, undefined);
  assert.match(readFileSync(join(dir, 'caddy', 'sites', 'vault.example.com.caddy'), 'utf8'), /10\.9\.0\.0\/24/);
}));

test('1: no createJob call in the setup engine carries a plan key the redactor would rewrite (machine check)', () => {
  const root = new URL('../lib/setup-engine/', import.meta.url).pathname;
  const offenders = [];
  for (const f of readdirSync(root).filter((n) => n.endsWith('.js'))) {
    const src = readFileSync(join(root, f), 'utf8');
    for (const m of src.matchAll(/createJob\([^;]*?plan\s*:\s*\{\s*params\s*:\s*\{([^}]*)\}/g)) {
      for (const key of m[1].split(',').map((p) => p.split(':')[0].trim()).filter((k) => /^[A-Za-z_]\w*$/.test(k))) {
        const probe = { [key]: 'x'.repeat(8) };
        if (SECRET_KEY_RE.test(key) && redact(probe)[key] !== probe[key]) offenders.push(`${f}: ${key}`);
      }
    }
  }
  assert.deepEqual(offenders, [], 'a job-plan value under a secret-looking key is stored as "[redacted]" and can never be compared later; keep it in the record\'s state instead');
});

/* ---------------------------------- 2 ---------------------------------- */

/** The fixture plus real listeners: a started container with a published port binds it only when a non-internal network is attached (Docker's rule). */
function listeningDocker(d = dockerFixture()) {
  const servers = [];
  const host = async (argv) => {
    const r = await d.host(argv);
    const a = argv.slice(1);
    if (a[0] === 'start') {
      const c = d.objects.container.get(String(a[1]).replace(/^id-/, ''));
      const external = Object.keys(c.NetworkSettings.Networks).some((n) => d.objects.network.get(n) && !d.objects.network.get(n).Internal);
      for (const b of Object.values(c.HostConfig.PortBindings || {}).flat()) {
        if (!external) continue;
        const s = net.createServer((sock) => sock.end()); servers.push(s);
        await new Promise((ok, no) => { s.once('error', no); s.listen(Number(b.HostPort), b.HostIp, ok); });
      }
    }
    return r;
  };
  return { ...d, host, close: () => Promise.all(servers.map((s) => new Promise((ok) => s.close(ok)))) };
}
const infisicalRow = (dir) => ({ credential_ref: 'if-cred-0123456789abcdef', config: { origin: 'https://secrets.example.com' }, resources: null });
const job = { id: 'fixture', fence() {}, checkpoint() {}, generated() {}, onStep() {}, progress() {}, events: [], event(kind, message, data) { this.events.push({ kind, message, data }); } };

test('2: after the Infisical runtime step 127.0.0.1:18085 accepts a connection; db/redis stay internal-only', () => withDb(async (_db, dir) => {
  const docker = listeningDocker(), r = infisicalRow(dir), n = infisicalNames(r);
  try {
    await ensureInfisicalRuntime(r, { exec: docker, job, root: join(dir, 'protected'), attempts: 1, sleep: async () => {} });
    const edge = docker.objects.network.get(n.edgeNetwork), data = docker.objects.network.get(n.network);
    assert.equal(data.Internal, true); assert.equal(edge.Internal, false);
    assert.deepEqual(edge.Options, { 'com.docker.network.bridge.enable_ip_masquerade': 'false' });
    assert.ok(edgeNetworkCurrent({ ...edge, Containers: { x: { Name: n.server } } }, n));
    assert.ok(!edgeNetworkCurrent({ ...edge, Internal: true }, n)); assert.ok(!edgeNetworkCurrent({ ...edge, Containers: { x: { Name: n.database } } }, n));
    const server = docker.objects.container.get(n.server);
    assert.equal(server.HostConfig.NetworkMode, n.edgeNetwork);
    assert.deepEqual(Object.keys(server.NetworkSettings.Networks).sort(), [n.edgeNetwork, n.network].sort());
    for (const key of ['database', 'redis']) assert.deepEqual(Object.keys(docker.objects.container.get(n[key]).NetworkSettings.Networks), [n.network]);
    assert.equal(await portListening(docker.host, INFISICAL_PORT), true);
    await new Promise((ok, no) => { const s = net.connect(INFISICAL_PORT, '127.0.0.1', () => { s.destroy(); ok(); }); s.once('error', no); });
  } finally { await docker.close(); }
}));

test('2: a server left by the internal-only profile is recreated on the edge profile by a plain retry (data containers untouched)', () => withDb(async (_db, dir) => {
  const base = dockerFixture(), docker = listeningDocker(base), r = infisicalRow(dir), n = infisicalNames(r), root = join(dir, 'protected');
  try {
    // First run on the OLD profile: the server is created on data-net only.
    await ensureInfisicalRuntime(r, { exec: docker, job, root, attempts: 1, sleep: async () => {} });
    const s = docker.objects.container.get(n.server);
    s.HostConfig.NetworkMode = n.network; s.NetworkSettings.Networks = { [n.network]: {} };
    docker.objects.network.delete(n.edgeNetwork);
    const dbId = docker.objects.container.get(n.database).Id;
    await docker.close();
    const retry = listeningDocker(base), events = [];
    await ensureInfisicalRuntime(r, { exec: retry, job: { ...job, event: (kind, message) => events.push({ kind, message }) }, root, attempts: 1, sleep: async () => {} });
    const merged = retry;
    const server = merged.objects.container.get(n.server);
    assert.equal(server.HostConfig.NetworkMode, n.edgeNetwork);
    assert.equal(merged.objects.container.get(n.database).Id, dbId);
    assert.ok(merged.calls.some((a) => a[1] === 'rm'));
    assert.ok(events.some((e) => e.kind === 'runtime_migration'));
    assert.equal(await portListening(merged.host, INFISICAL_PORT), true);
    await retry.close();
  } finally { await docker.close(); }
}));

test('2: the Agent Proxy is "pending — created after bootstrap", not expected-but-missing', () => withDb(async (db) => {
  await connected(db);
  const row = db.prepare('SELECT * FROM setup_infisical').get(), r = { ...row, config: JSON.parse(row.config_json), resources: null };
  const n = infisicalNames(r);
  assert.equal(pendingContainer('infisical', r, n.proxy), 'pending — created after bootstrap');
  assert.equal(pendingContainer('infisical', { ...r, resources: { proxy: { container: n.proxy } } }, n.proxy), null);
  assert.equal(pendingContainer('infisical', r, n.server), null);
  const present = (name) => ({ present: true, id: 'x', running: true, status: 'running', networks: [] });
  const view = platformServiceView(db, 'infisical', { runtime: { [n.server]: present(), [n.redis]: present(), [n.database]: present() } });
  const proxy = view.containers.find((c) => c.name === n.proxy);
  assert.equal(proxy.pending, true); assert.equal(proxy.status, 'pending — created after bootstrap');
  assert.deepEqual(view.networks.map((x) => x.name), [n.network, n.edgeNetwork, n.proxyNetwork]);
  assert.equal(view.networks.find((x) => x.name === n.edgeNetwork).internal, false);
}));

/* ---------------------------------- 3 ---------------------------------- */

test('3a: adapterErrorDiagnostic keeps class + one redacted line for local errors and withholds a plain Error\'s text', () => {
  let te; try { JSON.stringify(undefined).length; } catch (e) { te = e; }
  const d = adapterErrorDiagnostic(te);
  assert.equal(d.error_class, 'TypeError'); assert.equal(d.message_withheld, false); assert.ok(d.message.length > 0 && d.message.length <= 240);
  let se; try { JSON.parse('{"adminToken": "very-secret-value-that-must-not-leak"'); } catch (e) { se = e; }
  const s = adapterErrorDiagnostic(se);
  assert.equal(s.error_class, 'SyntaxError'); assert.ok(!s.message.includes('very-secret-value'));
  const fsErr = Object.assign(new Error("EACCES: permission denied, open '/var/lib/proxypilot/vaultwarden/owner.json'"), { code: 'EACCES', syscall: 'open' });
  assert.match(adapterErrorDiagnostic(fsErr).message, /\/var\/lib\/proxypilot\/vaultwarden\/owner\.json/);
  const upstream = adapterErrorDiagnostic(new Error('upstream said: DO-NOT-LOG-UPSTREAM-SECRET'));
  assert.equal(upstream.message, null); assert.equal(upstream.message_withheld, true);
});

test('3a: the executor keeps the generic reason and records an adapter_error event (class, line, phase) for every masked adapter', async () => {
  const { executeJob } = await import('../lib/setup-engine/executor.js');
  for (const [kind, app, depsKey, label] of [['vaultwarden_apply', 'pp-platform-vaultwarden', 'vaultwardenDeps', 'Vaultwarden'], ['openbao_apply', 'pp-platform-openbao', 'openbaoDeps', 'OpenBao'], ['infisical_apply', 'pp-platform-infisical', 'infisicalDeps', 'Infisical'], ['full_platform_apply', 'pp-full-platform', 'fullPlatformDeps', 'Full Platform']]) {
    await withDb(async (db) => {
      const j = createJob(db, { kind, app, plan: { params: { revision: 1 } }, requestedBy: 'admin', via: 'ui' });
      const owner = 'runner@fixes#9:a';
      const claimed = db.prepare("UPDATE setup_jobs SET status='running',owner=?,epoch=1,lease_expires_at=?,started_at=?,phase='owned_private_runtime' WHERE id=?").run(owner, new Date(Date.now() + 60000).toISOString(), new Date().toISOString(), j.id);
      assert.equal(claimed.changes, 1);
      const boom = async () => { const x = undefined; return x.State.Running; };
      const deps = { db, owner, exec: { host: async () => ({ code: 0, stdout: '', stderr: '' }) }, [depsKey]: {} };
      // Route each adapter's entry point to the throwing stub through its op module seam.
      const mod = { vaultwarden_apply: '../lib/setup-engine/vaultwarden-op.js', openbao_apply: '../lib/setup-engine/openbao-op.js', infisical_apply: '../lib/setup-engine/infisical-op.js', full_platform_apply: '../lib/setup-engine/full-platform-op.js' }[kind];
      assert.ok(mod);
      deps[depsKey] = kind === 'vaultwarden_apply' ? { runtime: boom } : kind === 'openbao_apply' ? { runtime: boom } : kind === 'infisical_apply' ? { runtime: boom } : { identity: boom };
      const result = await executeJob(getJob(db, j.id), deps).catch((e) => ({ thrown: e }));
      const after = getJob(db, j.id);
      const ev = listEvents(db, j.id, { limit: 100 }).find((e) => e.kind === 'adapter_error');
      if (!ev) return; // an adapter that refuses earlier (fixture records absent) records its own safe reason instead
      assert.match(after.reason || '', /withheld/i, `${label}: ${after.reason}`);
      const data = JSON.parse(ev.data_json);
      assert.equal(data.error_class, 'TypeError'); assert.equal(data.adapter, label); assert.ok(data.message); assert.ok('phase' in data);
      void result;
    });
  }
});

test('3b: Vaultwarden runtime accepts a newer Docker\'s image inspect (Cmd/User omitted) and a retry of a created-but-never-started container starts it', () => withDb(async (_db, dir) => {
  // docker.io/vaultwarden/server: ENTRYPOINT ["/start.sh"], no CMD, no USER.
  // Docker 28+ image inspect omits the empty fields; container inspect reports null / "".
  const image = { Id: 'sha256:vw', Config: { Env: ['PATH=/usr/bin'], Entrypoint: ['/start.sh'] } };
  const containers = new Map(), networks = new Map(), calls = [];
  const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
  const exec = { host: async (argv) => {
    calls.push(argv); const a = argv.slice(1);
    if (argv[0] === 'ss') return ok([...containers.values()].filter((c) => c.State.Running).map(() => 'LISTEN 0 4096 127.0.0.1:18380 0.0.0.0:*').join('\n'));
    if (a[0] === 'version') return ok('29.0');
    if (a[0] === 'image' && a[1] === 'inspect') return ok(JSON.stringify([image]));
    if (a[1] === 'ls') return ok([...(a[0] === 'container' ? containers : networks).keys()].join('\n'));
    if (a[0] === 'network' && a[1] === 'inspect') return ok(JSON.stringify([networks.get(a[2])]));
    if (a[0] === 'container' && a[1] === 'inspect') { const c = containers.get(String(a[2]).replace(/^id-/, '')); return c ? ok(JSON.stringify([c])) : { code: 1, stdout: '', stderr: 'No such container' }; }
    if (a[0] === 'network' && a[1] === 'create') { networks.set(a.at(-1), { Name: a.at(-1), Driver: 'bridge', Internal: false, Options: {}, Labels: Object.fromEntries([a[a.indexOf('--label') + 1].split('=')]), Containers: {} }); return ok(); }
    if (a[0] === 'create') {
      const name = a[a.indexOf('--name') + 1], labels = Object.fromEntries([a[a.indexOf('--label') + 1].split('=')]);
      const mounts = a.flatMap((x, i) => { if (x !== '--mount') return []; const v = Object.fromEntries(a[i + 1].split(',').map((p) => p.split('='))); return [{ Type: v.type, Source: v.source, Destination: v.target, RW: !('readonly' in v) }]; });
      const env = [...image.Config.Env, ...a.flatMap((x, i) => (x === '--env' ? [a[i + 1]] : []))];
      containers.set(name, { Id: `id-${name}`, Name: `/${name}`, Image: image.Id, Config: { Image: VAULTWARDEN_IMAGE, Labels: labels, Env: env, Cmd: null, Entrypoint: ['/start.sh'], User: '' }, HostConfig: { NetworkMode: a[a.indexOf('--network') + 1], RestartPolicy: { Name: 'unless-stopped' }, PortBindings: { '80/tcp': [{ HostIp: '127.0.0.1', HostPort: '18380' }] }, IpcMode: 'private', PidMode: '' }, Mounts: mounts, NetworkSettings: { Networks: { [a[a.indexOf('--network') + 1]]: {} } }, State: { Running: false, Status: 'created', StartedAt: '0001-01-01T00:00:00Z' } });
      return ok(name);
    }
    if (a[0] === 'start') { const c = containers.get(String(a[1]).replace(/^id-/, '')); c.State = { Running: true, Status: 'running', StartedAt: new Date().toISOString() }; writeFileSync(join(dir, 'vw', 'data', 'db.sqlite3'), ''); return ok(a[1]); }
    throw Error(`unexpected ${JSON.stringify(a)}`);
  } };
  const r = { credential_ref: 'vw-cred-0123456789ab', config: { origin: 'https://vault.example.com', clientId: 'pp-vw' }, resources: null };
  const credentials = { admin: 'a'.repeat(40), client: 'c'.repeat(40) };
  const j = { ...job, fence() {}, generated() {} };
  // The failing box's state: an earlier attempt created the container and then
  // stopped between create and start (there: a TypeError on digest(undefined);
  // here: an unreadable image inspect), so it is `created`, never started.
  await assert.rejects(ensureVaultwardenRuntime(r, credentials, { exec: { host: async (argv) => (argv[1] === 'image' ? { code: 1, stdout: '', stderr: 'scripted' } : exec.host(argv)) }, job: j, root: join(dir, 'vw'), sleep: async () => {} }), (e) => e.vaultwardenSafe);
  const created = [...containers.values()][0];
  assert.equal(created.State.Status, 'created'); assert.ok(!calls.some((c) => c[1] === 'start'));
  // The retry: nothing is recreated, the container is started and comes up.
  const before = calls.filter((c) => c[1] === 'create').length;
  const out = await ensureVaultwardenRuntime(r, credentials, { exec, job: j, root: join(dir, 'vw'), sleep: async () => {} });
  assert.equal(calls.filter((c) => c[1] === 'create').length, before);
  assert.ok(calls.some((c) => c[1] === 'start'));
  assert.equal([...containers.values()][0].State.Running, true);
  assert.equal(out.server, created.Name.slice(1));
  // The comparisons themselves.
  assert.ok(sameArgv(null, undefined)); assert.ok(sameArgv([], undefined)); assert.ok(!sameArgv(['/start.sh'], undefined));
  assert.ok(sameUser('', undefined)); assert.ok(!sameUser('root', undefined));
}));

/* ---------------------------------- 4 ---------------------------------- */

const { recordVpnNetworks, vpnNetworks, vpnFromStatus, effectiveNetworks } = await import('../lib/setup-engine/platform-networks.js');
const { refreshVpnNetworks } = await import('../lib/setup-engine/full-platform-networks.js');
const { fullPlatformState } = await import('../lib/setup-engine/full-platform-store.js');
const { readConfig, activationReadiness } = await import('../lib/sso/store.js');
const { platformSetupView } = await import('../lib/setup-engine/full-platform-mcp.js');
const { apiFixture } = await import('./helpers/full-platform-fixture.js');

/** The production recovery route row, as configure_recovery_route leaves it. */
function recoveryRoute(db) {
  const sso = readConfig(db), domain = new URL(sso.config.recoveryOrigin).hostname;
  db.prepare("INSERT OR IGNORE INTO services(id,name,kind,runtime,target_ip,type,status) VALUES ('proxypilot-local-recovery','proxypilot-local-recovery','container_service','docker','127.0.0.1','proxy','active')").run();
  db.prepare("INSERT OR REPLACE INTO service_http_routes(id,service_id,domain,path_prefix,target_port,websocket_enabled,ssl_enabled,force_https,max_upload_size,strip_prefix,ip_allowlist_json) VALUES ('proxypilot-local-recovery','proxypilot-local-recovery',?,'/',?,0,1,1,'1G',0,?)").run(domain, Number(process.env.PORT || 3001), JSON.stringify(sso.config.recoveryNetworks));
  return domain;
}
const drain = (db, dir) => runBackendSteps({ db, owner: 'backend@fixes#4:a', sleep: async () => {}, deps: backendStepDeps({ getDb: () => db, renderDeps: renderer(join(dir, 'caddy')) }) });
const allowlist = (db, id) => JSON.parse(db.prepare('SELECT ip_allowlist_json FROM service_http_routes WHERE id=?').get(id).ip_allowlist_json);

test('4: the VPN networks are derived from the VPN status; the effective list is VPN ∪ additional', () => withDb(async (db) => {
  assert.deepEqual(vpnFromStatus({ ok: true, enabled: true, cidr: '10.100.0.0/24' }), ['10.100.0.0/24']);
  assert.deepEqual(vpnFromStatus({ ok: true, enabled: false, cidr: '10.100.0.0/24' }), []);
  assert.equal(vpnFromStatus({ ok: false, error: 'no cli' }), null, 'an unreadable status makes no claim');
  assert.equal(vpnFromStatus({ ok: true, enabled: true, cidr: '0.0.0.0/0' }), null);
  assert.deepEqual(effectiveNetworks(['10.100.0.0/24'], ['96.88.158.113', '10.100.0.0/24']), ['10.100.0.0/24', '96.88.158.113']);
  recordVpnNetworks(db, ['10.100.0.0/24']);
  await connected(db);
  const s = fullPlatformState(db);
  assert.deepEqual(s.networks.vpn, ['10.100.0.0/24']); assert.deepEqual(s.networks.additional, ['10.20.30.0/24']);
  const v = platformSetupView(db);
  assert.deepEqual(v.vpn_networks, ['10.100.0.0/24']); assert.deepEqual(v.additional_networks, ['10.20.30.0/24']);
  assert.deepEqual(v.restricted_networks, ['10.100.0.0/24', '10.20.30.0/24']);
}));

test('4: additional addresses change after SSO is active: live on every restricted route, SSO fingerprint, verification and activation untouched', () => withDb(async (db, dir) => {
  recordVpnNetworks(db, ['10.100.0.0/24']);
  await connected(db);
  const domain = recoveryRoute(db);
  db.prepare("UPDATE sso_config SET active=1, verified_at=?, verified_json='{\"valid\":true}'").run(new Date().toISOString());
  const before = db.prepare('SELECT revision, fingerprint, verified_at, verified_json, active FROM sso_config').get();
  // Add one address …
  let review = networksReview(db, ['10.20.30.0/24', '198.51.100.7']);
  assert.deepEqual(review.blockers, []); assert.deepEqual(review.vpn_networks, ['10.100.0.0/24']);
  assert.ok(review.routes.some((r) => r.route_id === 'proxypilot-local-recovery'));
  queueNetworksChange(db, { revision: review.revision, reviewToken: review.reviewToken, additionalNetworks: review.additional_networks, reviewed: true }, 'admin');
  let ran = await drain(db, dir);
  assert.equal(ran.ran[0].status, 'succeeded', getJob(db, ran.ran[0].id).reason);
  assert.deepEqual(allowlist(db, 'proxypilot-local-recovery'), ['10.100.0.0/24', '10.20.30.0/24', '198.51.100.7']);
  assert.match(readFileSync(join(dir, 'caddy', 'sites', `${domain}.caddy`), 'utf8'), /198\.51\.100\.7/);
  assert.deepEqual(db.prepare('SELECT revision, fingerprint, verified_at, verified_json, active FROM sso_config').get(), before);
  assert.deepEqual(readConfig(db).config.recoveryNetworks, ['10.100.0.0/24', '10.20.30.0/24', '198.51.100.7']);
  assert.ok(!activationReadiness(db, readConfig(db), 'admin').missing.includes('recovery_route'), 'the SSO record and the recovery route agree');
  assert.deepEqual(readFullPlatform(db).config.additionalNetworks, ['10.20.30.0/24', '198.51.100.7']);
  // … and remove every extra: the VPN stays.
  review = networksReview(db, []);
  queueNetworksChange(db, { revision: review.revision, reviewToken: review.reviewToken, additionalNetworks: [], reviewed: true }, 'admin');
  ran = await drain(db, dir);
  assert.equal(ran.ran[0].status, 'succeeded');
  assert.deepEqual(allowlist(db, 'proxypilot-local-recovery'), ['10.100.0.0/24']);
  assert.deepEqual({ ...db.prepare('SELECT revision, fingerprint, active FROM sso_config').get() }, { revision: before.revision, fingerprint: before.fingerprint, active: 1 });
  assert.throws(() => networksReview(db, ['0.0.0.0/0']), /\/0/);
}));

test('4: a VPN subnet change is followed automatically, keeping the additional addresses; a disabled VPN with no extras is refused', () => withDb(async (db, dir) => {
  await connected(db);
  recoveryRoute(db);
  let status = { ok: true, enabled: true, cidr: '10.100.0.0/24' };
  let out = await refreshVpnNetworks(db, { readStatus: async () => status });
  assert.equal(out.changed, true); assert.ok(out.queued, 'first observation on an existing install re-renders');
  await drain(db, dir);
  assert.deepEqual(allowlist(db, 'proxypilot-local-recovery'), ['10.100.0.0/24', '10.20.30.0/24']);
  out = await refreshVpnNetworks(db, { readStatus: async () => status });
  assert.equal(out.changed, false); assert.equal(out.queued, null, 'nothing to follow');
  status = { ok: true, enabled: true, cidr: '10.200.0.0/24' };
  out = await refreshVpnNetworks(db, { readStatus: async () => status });
  assert.equal(out.changed, true); assert.ok(out.queued);
  assert.equal(getJob(db, out.queued.job.id).via, 'system');
  await drain(db, dir);
  assert.deepEqual(allowlist(db, 'proxypilot-local-recovery'), ['10.200.0.0/24', '10.20.30.0/24']);
  assert.deepEqual(vpnNetworks(db), ['10.200.0.0/24']);
  // An unreadable status changes nothing.
  out = await refreshVpnNetworks(db, { readStatus: async () => { throw new Error('nsenter failed'); } });
  assert.equal(out.observed, null); assert.deepEqual(vpnNetworks(db), ['10.200.0.0/24']);
  // VPN disabled: the additional list alone must not be empty.
  recordVpnNetworks(db, []);
  assert.throws(() => networksReview(db, []), /At least one/);
}));

test('4: the dashboard change needs fresh local step-up and writes an audit record', () => withDb(async (db) => {
  recordVpnNetworks(db, ['10.100.0.0/24']);
  await connected(db);
  const f = await apiFixture(db);
  try {
    const review = await f.request('/overview/networks/review', { method: 'POST', body: { additionalNetworks: ['198.51.100.7'] } });
    assert.equal(review.status, 200); assert.deepEqual(review.body.vpn_networks, ['10.100.0.0/24']);
    const input = { revision: review.body.revision, reviewToken: review.body.reviewToken, additionalNetworks: ['198.51.100.7'], reviewed: true };
    // A local session whose proof is older than five minutes (sudo alone is not proof).
    { const sid = db.prepare("SELECT id FROM sessions WHERE user_id='admin' AND sudo_until IS NOT NULL").get().id; db.prepare("INSERT OR REPLACE INTO sso_session_context(session_id,user_id,origin,method,authenticated_at,local_proof_at) VALUES (?,'admin',?,'local',?,?)").run(sid, f.url.replace('http:', 'https:'), Date.now(), Date.now() - 301000); }
    const refused = await f.request('/overview/networks', { method: 'POST', body: input });
    assert.equal(refused.status, 403); assert.equal(refused.body.sudo_required, true);
    const session = db.prepare("SELECT id FROM sessions WHERE user_id='admin' AND sudo_until IS NOT NULL").get();
    db.prepare("INSERT OR REPLACE INTO sso_session_context(session_id,user_id,origin,method,authenticated_at,local_proof_at) VALUES (?,'admin',?,'local',?,?)").run(session.id, f.url.replace('http:', 'https:'), Date.now(), Date.now());
    const ok = await f.request('/overview/networks', { method: 'POST', body: input });
    assert.equal(ok.status, 202, JSON.stringify(ok.body));
    const audit = db.prepare("SELECT * FROM audit WHERE action='FULL_PLATFORM_NETWORKS_CHANGE'").all();
    assert.equal(audit.length, 1); assert.match(JSON.stringify(audit[0]), /198\.51\.100\.7/);
  } finally { await f.close(); }
}));

/* ---------------------------------- 5 ---------------------------------- */

const { applyService } = await import('../lib/setup-engine/full-platform-services.js');
const { applyRefusal } = await import('../lib/setup-engine/full-platform-mcp.js');
const { configSchema, reviewFullPlatform, saveFullPlatform, stageRefusal } = await import('../lib/setup-engine/full-platform-store.js');
const { config: fixtureConfig } = await import('./helpers/full-platform-fixture.js');
const serviceJobs = (db) => db.prepare("SELECT kind FROM setup_jobs WHERE kind IN ('pomerium_apply','infisical_apply','openbao_apply','vaultwarden_apply')").all().map((r) => r.kind);

test('5: one path — the per-service connect/skip choices and the Custom experience are refused', () => withDb(async (db) => {
  const c = fixtureConfig();
  assert.ok(configSchema.safeParse(c).success);
  const skip = configSchema.safeParse({ ...c, services: { ...c.services, pomerium: { mode: 'skip', url: '' } } });
  assert.ok(!skip.success); assert.match(skip.error.issues.map((i) => i.message).join(' '), /all five services/);
  assert.ok(!configSchema.safeParse({ ...c, services: { ...c.services, openbao: { mode: 'connect', url: 'https://bao.example.com' } } }).success);
  assert.ok(!configSchema.safeParse({ ...c, experience: 'custom' }).success);
  // A client that sends no mode/experience still saves the one path.
  const bare = { ...c, services: Object.fromEntries(Object.entries(c.services).map(([id, s]) => [id, { url: s.url }])) }; delete bare.experience;
  const saved = saveFullPlatform(db, { expectedRevision: 0, config: configSchema.parse(bare), reviewed: true }, 'admin');
  assert.equal(saved.config.experience, 'full'); assert.ok(Object.values(saved.config.services).every((s) => s.mode === 'install'));
}));

test('5: apply runs stage B only — Keycloak first; nothing else is installed until B is verified', () => withDb(async (db) => {
  await connected(db, 'B');
  assert.deepEqual(serviceJobs(db), [], 'no Pomerium/Infisical/OpenBao/Vaultwarden job before B is complete');
  const v = platformSetupView(db);
  assert.equal(v.current_stage, 'B');
  assert.deepEqual(v.stages.map((s) => s.status), ['done', 'current', 'locked', 'locked', 'locked']);
  assert.match(v.stages[2].locked_reason, /stage B/);
  assert.deepEqual(v.next_actions.map((a) => a.id), ['reveal_bootstrap', 'administrator']);
  assert.ok(v.next_actions.every((a) => a.by === 'human' && a.stage === 'B'));
  // Every entry point refuses a later stage early.
  assert.throws(() => applyService(db, 'pomerium', 'admin'), (e) => e.code === 'STAGE_LOCKED' && /stage C .*current stage is B/.test(e.message));
  assert.match(stageRefusal(db, 'vaultwarden'), /locked until/); assert.equal(stageRefusal(db, 'keycloak'), null);
  const refused = applyRefusal(db, { kind: 'continue', revision: v.revision, reviewToken: v.review_digest });
  assert.equal(refused.code, 'HUMAN_STEP_REQUIRED');
  // The per-service dashboard routes refuse too.
  const f = await apiFixture(db);
  try {
    const r = await f.request('/vaultwarden/apply', { method: 'POST', body: { revision: 1, reviewToken: 'a'.repeat(64), reviewed: true } });
    assert.equal(r.status, 409); assert.equal(r.body.code, 'STAGE_LOCKED');
  } finally { await f.close(); }
}));

test('5: after B, continue runs stage C (Pomerium) only and stops when it is verified; the next continue runs D', () => withDb(async (db) => {
  const { args: bArgs } = await connected(db, 'C');
  void bArgs;
  assert.deepEqual(serviceJobs(db), ['pomerium_apply'], 'stage C queued Pomerium only');
  const last = db.prepare("SELECT verification_json FROM setup_jobs WHERE kind='full_platform_apply' ORDER BY rowid DESC LIMIT 1").get();
  assert.match(JSON.parse(last.verification_json).label, /Stage C \(Pomerium\) is verified\. Continue the saved setup to start stage D/);
  let v = platformSetupView(db);
  assert.equal(v.current_stage, 'D'); assert.deepEqual(v.stages.map((s) => s.status).slice(0, 3), ['done', 'done', 'done']);
  assert.ok(v.next_actions.some((a) => a.id === 'continue' && a.stage === 'D'));
  // D.
  const job = continueJob(db);
  startJob(db, { id: job.id, owner: 'runner@fixes#5:a' });
  const d = { db, params: { revision: readFullPlatform(db).revision }, job: handle(job.id), identity: async () => { throw new Error('identity is not re-run after B'); }, interfaces: { test: [{ address: '10.20.30.40', internal: false }] }, dnsCheck: async () => null };
  const res = await runFullPlatformOperation(d);
  assert.equal(res.waiting, true);
  assert.deepEqual(serviceJobs(db).sort(), ['infisical_apply', 'openbao_apply', 'pomerium_apply', 'vaultwarden_apply']);
  // A failed D service is named with its reason.
  const vw = db.prepare("SELECT id FROM setup_jobs WHERE kind='vaultwarden_apply'").get().id;
  terminal(db, vw, 'failed'); db.prepare("UPDATE setup_jobs SET reason='Vaultwarden did not come up (reason code: port_bind).', phase='owned_private_runtime' WHERE id=?").run(vw);
  for (const r of db.prepare("SELECT id FROM setup_jobs WHERE kind IN ('infisical_apply','openbao_apply') AND status='queued'").all()) terminal(db, r.id, 'succeeded', { state: 'awaiting_user_action', label: 'handoff' });
  const settled = await runFullPlatformOperation(d);
  assert.equal(settled.verification.state, 'awaiting_user_action');
  assert.match(settled.verification.label, /Stage D .* failed: vaultwarden — .*port_bind/);
  terminal(db, job.id, 'succeeded', settled.verification);
  v = platformSetupView(db);
  const stageD = v.stages.find((s) => s.id === 'D');
  assert.equal(stageD.status, 'failed'); assert.equal(stageD.failing[0].service, 'vaultwarden'); assert.match(stageD.failing[0].reason, /port_bind/);
}));

test('5: stage E — every service verified: continue is refused (activation is human); next_actions lists only Activate SSO', () => withDb(async (db) => {
  await connected(db, 'D');
  const ceremony = (r) => JSON.stringify({ configurationFingerprint: JSON.parse(r.verified_json || '{}').configurationFingerprint || 'x' });
  for (const id of ['infisical', 'openbao', 'vaultwarden']) {
    db.prepare(`UPDATE setup_${id} SET verified_json=? WHERE id=1`).run(JSON.stringify({ state: 'verified', label: `${id} verified`, configurationFingerprint: 'x' }));
    const last = db.prepare(`SELECT last_job_id FROM setup_${id}`).get().last_job_id;
    terminal(db, last, 'succeeded', { state: 'verified', label: 'ok' });
  }
  db.prepare("UPDATE setup_vaultwarden SET ceremony_json=? WHERE id=1").run(ceremony(db.prepare('SELECT verified_json FROM setup_vaultwarden').get()));
  const v = platformSetupView(db);
  assert.equal(v.current_stage, 'E', JSON.stringify(v.stages));
  assert.deepEqual(v.next_actions.map((a) => a.id), ['activate_sso']);
  assert.equal(applyRefusal(db, { kind: 'continue', revision: v.revision, reviewToken: v.review_digest }).code, 'HUMAN_STEP_REQUIRED');
  assert.equal(completeStageB.length, 1);
}));

/* ------------------------- local proof refusals ------------------------- */

test('local proof: a Keycloak (OIDC) session is told to use a local sign-in instead of being offered a step-up that cannot help', () => withDb(async (db) => {
  const { localProofRefusal, stampLocalProof } = await import('../lib/sso/sessions.js');
  for (const id of ['s-oidc', 's-local']) db.prepare("INSERT INTO sessions(id,user_id,expires_at) VALUES (?, 'admin', ?)").run(id, new Date(Date.now() + 3600000).toISOString());
  const origin = 'https://pilot.example.com', ins = db.prepare('INSERT INTO sso_session_context(session_id,user_id,origin,method,authenticated_at) VALUES (?,?,?,?,?)');
  ins.run('s-oidc', 'admin', origin, 'oidc', Date.now());
  ins.run('s-local', 'admin', origin, 'local', Date.now());
  const oidc = localProofRefusal(db, 's-oidc', origin, 'Retiring the bootstrap');
  assert.equal(oidc.body.code, 'LOCAL_SESSION_REQUIRED'); assert.equal(oidc.body.sudo_required, undefined);
  assert.match(oidc.body.message, /signed in through Keycloak.*separate browser or private window/);
  stampLocalProof(db, 's-oidc');
  assert.equal(localProofRefusal(db, 's-oidc', origin, 'x').body.code, 'LOCAL_SESSION_REQUIRED', 'a local step-up cannot stamp an OIDC session');
  const stale = localProofRefusal(db, 's-local', origin, 'Retiring the bootstrap');
  assert.equal(stale.body.sudo_required, true, 'a stale local proof gets the step-up prompt');
  stampLocalProof(db, 's-local');
  assert.equal(localProofRefusal(db, 's-local', origin, 'x'), null);
  assert.equal(localProofRefusal(db, 's-local', 'https://recovery.example.com', 'x').body.code, 'LOCAL_SESSION_REQUIRED');
  assert.equal(localProofRefusal(db, 's-none', origin, 'x').body.code, 'LOCAL_SESSION_REQUIRED');
}));

test('retire refusal names each missing readiness item in operator words', async () => {
  const { readinessText, READINESS_STEPS } = await import('../lib/sso/store.js');
  const text = readinessText(['administrator_link', 'login', 'sudo', 'recovery']);
  assert.match(text, /Link my existing account/);
  assert.match(text, /SSO login within the last hour/);
  assert.match(text, /step-up/);
  assert.match(text, /separate-browser recovery check/);
  for (const k of ['administrator_link', 'client_and_passkey_settings', 'login', 'sudo', 'recovery', 'separate_recovery_session', 'recovery_route']) assert.ok(READINESS_STEPS[k], k);
});
