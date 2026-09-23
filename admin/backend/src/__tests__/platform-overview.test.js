// The mcp.platform master flag (Part 1), the Platform overview and its
// actions (Part 2), and the live-host fixes (Part 3) — through the same
// functions the dashboard and the MCP tools call.
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { EventEmitter } from 'node:events';
import { makeDb, approved, handle, keycloakWire } from './helpers/full-platform-fixture.js';
import { readFullPlatform, resyncReview, resyncSharedPlan } from '../lib/setup-engine/full-platform-store.js';
import { keycloakAdmin, reconcileOwnedIdentity, storeProtected } from '../lib/setup-engine/full-platform-keycloak.js';
import { runFullPlatformOperation } from '../lib/setup-engine/full-platform-op.js';
import { readVaultwarden } from '../lib/setup-engine/vaultwarden-store.js';
import { readInfisical } from '../lib/setup-engine/infisical-store.js';
import { startJob, getJob } from '../lib/setup-engine/store.js';
import { createToolkit } from '../routes/mcp-tools/common.js';
import { createPlatformHandlers } from '../routes/mcp-tools/platform.js';
import { createAdminHandlers } from '../routes/mcp-tools/admin.js';
import { createConfirmationStore } from '../lib/mcp-ext/logic.js';
import { MCP_EXT_TOOL_GROUPS } from '../lib/mcp-ext/catalog/index.js';
import { toolResult } from '../lib/mcp-logic.js';
import { migrateMcpPlatformFlag } from '../db.js';
import { setPlatformFlag, platformFlagState, mcpAccess, readFlag } from '../lib/platform-mcp-flag.js';
import { routeEdgeOptionLines } from '../lib/caddy-site-file.js';
import { localEdge, SELF_CHECK_HEADER, selfCheckToken } from '../lib/setup-engine/local-edge.js';
import { infisicalRequest, createInfisicalClient } from '../lib/setup-engine/infisical-api.js';
import { startOwnedContainer, readContainerLogs, classifyDockerError, logConfigCurrent, LOG_ARGS, reasonCodeOf, assertUpstreamListening } from '../lib/setup-engine/owned-runtime.js';
import { dnsVerdict, checkHostnames, clearDnsCache } from '../lib/setup-engine/platform-dns.js';
import { networksReview } from '../lib/setup-engine/full-platform-networks.js';
import { platformOverview, clearOverviewCache } from '../lib/setup-engine/platform-overview.js';
import { platformRouteRefusal } from '../lib/setup-engine/platform-hostnames.js';
import { resetReview } from '../lib/setup-engine/full-platform-reset.js';
import POLICY from '../lib/mcp-policy/mcp-extended-policy.json' with { type: 'json' };

const body = (r) => { try { return JSON.parse(r.content[0].text); } catch { return r.content[0].text; } };
const text = (r) => r.content[0].text;
const terminal = (db, id, status = 'succeeded', verification = null) => db.prepare('UPDATE setup_jobs SET status=?,owner=NULL,verification_json=? WHERE id=?').run(status, verification ? JSON.stringify(verification) : null, id);
const CADDY = '203.0.113.10';
const okResolvers = { host: async (h) => (h.endsWith('example.com') ? [CADDY] : []), public: async (h) => (h.endsWith('example.com') ? [CADDY] : []) };

/** The MCP kit over a real sqlite DB (settings in app_settings, as in production). */
function tools(db, { host = null, resolvers = okResolvers } = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS mcp_ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, token_id INTEGER, actor TEXT, tool TEXT NOT NULL, subject_type TEXT, subject_id TEXT, project_id INTEGER, args_json TEXT,
    outcome TEXT NOT NULL, dry_run INTEGER NOT NULL DEFAULT 0, confirmation_used INTEGER NOT NULL DEFAULT 0, snapshot TEXT, summary TEXT, detail_json TEXT, duration_ms INTEGER)`);
  const hostCalls = [];
  const ctx = {
    getDb: () => db, logAudit: () => {}, getSetting: (k) => db.prepare('SELECT value FROM app_settings WHERE key=?').get(k)?.value ?? null,
    setSetting: (k, v) => db.prepare('INSERT INTO app_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, v),
    toolResult, policy: POLICY, confirmations: createConfirmationStore({}),
    runHostCapture: async (bin, args) => { hostCalls.push([bin, ...args]); return host ? host([bin, ...args]) : { status: 1, stdout: '', stderr: 'no host' }; },
    platformResolvers: resolvers,
  };
  const kit = createToolkit(ctx);
  const h = createPlatformHandlers(kit), admin = createAdminHandlers(kit);
  const auth = { id: 7, created_by: 'admin' };
  return { call: (name, args = {}) => (h[name] || admin[name])(args, auth, {}), hostCalls, ctx };
}
const setFlag = (db, name, on) => db.prepare('INSERT INTO app_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(`feature_flag:${name}`, on ? '1' : '0');

// The coordinator driven to its handoff so every service record exists.
async function connected(db) {
  const job = approved(db), k = db.prepare('SELECT * FROM setup_keycloak').get(), wire = keycloakWire(k);
  storeProtected(db, `keycloak-bootstrap-${k.id}`, { installationId: k.id, password: 'b'.repeat(43), retired: false });
  const identity = async (db2, kk, full, { job: j }) => { const a = await keycloakAdmin(kk, 'b'.repeat(43), { send: wire.send, job: j }); try { return await reconcileOwnedIdentity(db2, kk, full, a.api, j); } finally { await a.close(); } };
  startJob(db, { id: job.id, owner: 'runner@overview#1:a' });
  const args = { db, params: { revision: 1 }, job: handle(job.id), identity, interfaces: { test: [{ address: '10.20.30.40', internal: false }] }, dnsCheck: async () => null };
  for (let i = 0; i < 6; i++) {
    const result = await runFullPlatformOperation(args);
    for (const c of db.prepare("SELECT id,kind FROM setup_jobs WHERE id!=? AND status='queued'").all(job.id)) {
      terminal(db, c.id, 'succeeded', { state: 'awaiting_user_action', label: 'Scripted handoff pending' });
      if (c.kind === 'verify_sso') db.prepare('UPDATE sso_config SET verified_at=?,verified_json=?').run(new Date().toISOString(), JSON.stringify({ valid: true }));
    }
    if (!result.waiting) { terminal(db, job.id, 'succeeded', result.verification); return { job, k }; }
  }
  throw Error('Coordinator did not settle');
}
const withDb = async (fn) => { const db = makeDb(); try { await fn(db); } finally { db.close(); } };

/* -------------------------------- Part 1 -------------------------------- */

test('every Platform MCP tool refuses before any work while mcp.platform is off, and is not flag-refused when on', () => withDb(async (db) => {
  await connected(db);
  const names = MCP_EXT_TOOL_GROUPS.platform.map((t) => t.name);
  assert.equal(names.length, 16);
  const argsFor = { get_platform_service: { service: 'vaultwarden' }, get_platform_job: { id: 'x' }, verify_platform_service: { service: 'vaultwarden' }, get_platform_service_logs: { service: 'vaultwarden' },
    control_platform_container: { service: 'vaultwarden', container: 'x', action: 'stop' }, manage_platform_service: { service: 'vaultwarden', action: 'repair', dry_run: true },
    set_platform_restricted_networks: { restricted_networks: ['10.9.0.0/24'], dry_run: true }, resync_platform_plan: { revision: 1, dry_run: true }, save_platform_setup: { if_revision: 1, dry_run: true },
    apply_platform_setup: { revision: 1, review_digest: 'x', dry_run: true }, continue_platform_setup: { revision: 1, review_digest: 'x', dry_run: true }, reset_platform_setup: { dry_run: true }, recover_keycloak_bootstrap: { dry_run: true } };
  const jobsBefore = db.prepare('SELECT count(*) n FROM setup_jobs').get().n;
  setFlag(db, 'mcp.platform', false);
  const t = tools(db);
  for (const name of names) {
    const r = await t.call(name, argsFor[name] || {});
    assert.equal(r.isError, true, `${name} must refuse`);
    assert.match(text(r), /mcp\.platform is off/, name);
    assert.match(text(r), /dashboard/i, `${name} names where a human turns it on`);
  }
  assert.equal(t.hostCalls.length, 0, 'no docker inspect or other host command while off');
  assert.equal(db.prepare('SELECT count(*) n FROM setup_jobs').get().n, jobsBefore, 'no job created');
  setFlag(db, 'mcp.platform', true);
  const t2 = tools(db);
  for (const name of names) assert.doesNotMatch(text(await t2.call(name, argsFor[name] || {})), /mcp\.platform is off/, `${name} passes the flag when on`);
}));

test('set_feature_flag cannot change mcp.platform over MCP, on or off; other flags still change', () => withDb(async (db) => {
  const t = tools(db);
  for (const enabled of [true, false]) {
    const r = await t.call('set_feature_flag', { name: 'mcp.platform', enabled, confirm: true });
    assert.equal(r.isError, true); assert.match(text(r), /human-only/);
  }
  assert.equal(db.prepare("SELECT value FROM app_settings WHERE key='feature_flag:mcp.platform'").get(), undefined);
  const other = await t.call('set_feature_flag', { name: 'mcp.dns', enabled: false, confirm: true });
  assert.ok(!other.isError);
  assert.equal(body(await t.call('list_feature_flags')).flags.find((f) => f.name === 'mcp.platform').human_only, true);
}));

test('reset with purge stays refused while mcp.platform is off even with mcp.platform.purge and mcp.destructive on', () => withDb(async (db) => {
  await connected(db);
  setFlag(db, 'mcp.platform', false); setFlag(db, 'mcp.platform.purge', true); setFlag(db, 'mcp.destructive', true);
  const r = await tools(db).call('reset_platform_setup', { purge_data: true });
  assert.equal(r.isError, true); assert.match(text(r), /mcp\.platform is off/);
  assert.equal(mcpAccess(db).effective.purge, false);
  setFlag(db, 'mcp.platform', true);
  assert.equal(mcpAccess(db).effective.purge, true);
}));

test('migration 915 turns mcp.platform on for existing installs only, audited; new installs default off', () => {
  const mk = () => { const d = new Database(':memory:'); d.exec("CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT); CREATE TABLE audit_log (id TEXT PRIMARY KEY, user_id TEXT, action TEXT, resource_type TEXT, resource_id TEXT, details TEXT, ip_address TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)"); return d; };
  const existing = mk(); migrateMcpPlatformFlag(existing, { existingInstall: true });
  assert.equal(readFlag(existing, 'mcp.platform'), true);
  const row = existing.prepare("SELECT * FROM audit_log WHERE action='FEATURE_FLAG_CHANGED'").get();
  assert.equal(JSON.parse(row.details).enabled, true); assert.equal(JSON.parse(row.details).via, 'migration 915');
  const fresh = mk(); migrateMcpPlatformFlag(fresh, { existingInstall: false });
  assert.equal(readFlag(fresh, 'mcp.platform'), false);
  const explicit = mk(); explicit.prepare("INSERT INTO app_settings VALUES ('feature_flag:mcp.platform','0')").run(); migrateMcpPlatformFlag(explicit, { existingInstall: true });
  assert.equal(readFlag(explicit, 'mcp.platform'), false, 'an explicit choice is never overwritten');
  assert.equal(POLICY.feature_flags['mcp.platform'].default, false);
});

test('the dashboard toggle is admin-only, audited (who, old, new) and changes MCP access immediately; running jobs are untouched', () => withDb(async (db) => {
  await connected(db);
  db.exec("CREATE TABLE IF NOT EXISTS audit_log (id TEXT PRIMARY KEY, user_id TEXT, action TEXT NOT NULL, resource_type TEXT, resource_id TEXT, details TEXT, ip_address TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)");
  db.prepare("INSERT OR IGNORE INTO users (id, username, role) VALUES ('u-admin','thomas','admin')").run();
  const queued = db.prepare("SELECT id FROM setup_jobs WHERE app LIKE 'pp-platform-%' LIMIT 1").get();
  db.prepare("UPDATE setup_jobs SET status='running' WHERE id=?").run(queued.id);
  assert.throws(() => setPlatformFlag(db, true, { id: 'u-op', role: 'user' }), /administrator/);
  const on = setPlatformFlag(db, true, { id: 'u-admin', role: 'admin' });
  assert.equal(on.enabled, true); assert.equal(mcpAccess(db).effective.platform, true);
  const off = setPlatformFlag(db, false, { id: 'u-admin', role: 'admin' }, '192.0.2.1');
  assert.equal(off.enabled, false); assert.equal(mcpAccess(db).callable.length, 0);
  assert.equal(off.last_change.by.username, 'thomas'); assert.equal(off.last_change.previous, true); assert.equal(off.last_change.enabled, false);
  assert.equal(getJob(db, queued.id).status, 'running', 'turning it off cancels nothing');
  assert.ok(platformFlagState(db).active_jobs.count >= 1);
}));

/* -------------------------------- Part 3 -------------------------------- */

// Evaluate the rendered restricted matcher (what Caddy does with it).
function denied(lines, { remote, headers = {} }) {
  const text = lines.join('\n');
  const allow = /not remote_ip ([^\n]+)/.exec(text)[1].trim().split(/\s+/);
  const inList = (ip, list) => list.some((c) => (c.includes('/') ? (c === '127.0.0.1/32' && ip === '127.0.0.1') || (c === '::1/128' && ip === '::1') || ip.startsWith(c.split('/')[0].split('.').slice(0, Number(c.split('/')[1]) / 8).join('.') + '.') : ip === c));
  const self = /not \{\s*remote_ip ([^\n]+)\n\s*header (\S+) (\S+)/.exec(text);
  const selfOk = self && inList(remote, self[1].trim().split(/\s+/)) && headers[self[2]] === self[3];
  return !inList(remote, allow) && !selfOk;
}

test('3c: a service route restricted to one external IP still passes its own bootstrap check through the local Caddy', async () => withDb(async (db) => {
  const token = selfCheckToken(db);
  const lines = routeEdgeOptionLines({ ip_allowlist: ['198.51.100.7'] }, '        ', { routeId: 'infisical-route-abc', selfCheck: { token } });
  // The hairpin through the firewall (the Fractionate failure) is still refused…
  assert.equal(denied(lines, { remote: '192.168.88.1' }), true);
  assert.equal(denied(lines, { remote: '96.88.158.118' }), true);
  // …plain loopback without the header too, and the allowed IP passes.
  assert.equal(denied(lines, { remote: '127.0.0.1' }), true);
  assert.equal(denied(lines, { remote: '198.51.100.7' }), false);
  // The adapter's own bootstrap check: connected to the local edge, SNI/Host kept.
  let seen = null;
  const request = (u, opts, cb) => { seen = { url: String(u), opts }; opts.lookup('secrets.example.com', { all: false }, (_e, address) => { seen.address = address; }); const res = new EventEmitter(); res.statusCode = 200; setImmediate(() => { cb(res); res.emit('data', Buffer.from('{"date":"x"}')); res.emit('end'); }); return { on() {}, end() {}, destroy() {} }; };
  const api = createInfisicalClient('https://secrets.example.com', { send: (o, p, x) => infisicalRequest(o, p, { ...x, request }), edge: localEdge(db) });
  const r = await api('/api/status');
  assert.equal(r.status, 200);
  assert.equal(seen.address, '127.0.0.1'); assert.equal(new URL(seen.url).hostname, 'secrets.example.com');
  assert.equal(seen.opts.headers[SELF_CHECK_HEADER], token);
  assert.equal(denied(lines, { remote: seen.address, headers: seen.opts.headers }), false, 'the bootstrap check passes the restricted route');
  // Other restricted routes keep the plain matcher.
  assert.doesNotMatch(routeEdgeOptionLines({ ip_allowlist: ['198.51.100.7'] }, '  ', { routeId: 'app-route' }).join('\n'), /header/);
}));

function fakeDocker(state) {
  const calls = [];
  const run = async (argv) => {
    calls.push(argv);
    const [bin, ...a] = argv;
    if (bin === 'journalctl') return { code: 0, stdout: 'j1\nj2 password=hunter2\n', stderr: '' };
    if (a[0] === 'container' && a[1] === 'inspect') return state.c ? { code: 0, stdout: JSON.stringify([state.c]), stderr: '' } : { code: 1, stdout: '', stderr: 'No such container' };
    if (a[0] === 'start') { if (state.startErr) return { code: 1, stdout: '', stderr: state.startErr }; state.onStart?.(); return { code: 0, stdout: a[1], stderr: '' }; }
    if (a[0] === 'logs') return { code: 0, stdout: '2026-09-23T10:00:01Z out line\n', stderr: '2026-09-23T10:00:00Z err line token=abcdef\n' };
    throw Error(`unexpected ${argv.join(' ')}`);
  };
  return { run, calls };
}
const failErr = (m) => Object.assign(new Error(m), { fullPlatformSafe: true });

test('3b: start by ID, wait for running then healthy; reason codes with State.Error and redacted log lines; an already healthy container is left alone', async () => {
  const base = { Id: 'sha-1', Name: '/pp-vw', HostConfig: { LogConfig: { Type: 'local', Config: { 'max-size': '10m', 'max-file': '3' } } } };
  // created → start → exits 1
  let st = { c: { ...base, State: { Running: false, Status: 'created', StartedAt: '0001-01-01T00:00:00Z' } } };
  st.onStart = () => { st.c = { ...base, State: { Running: false, Status: 'exited', ExitCode: 1, Error: 'boom secret=hunter2', StartedAt: 'x' } }; };
  const events = []; const job = { fence() {}, event: (k, m, d) => events.push({ k, m, d }) };
  let d = fakeDocker(st);
  await assert.rejects(startOwnedContainer({ run: d.run, name: 'pp-vw', fail: failErr, job, sleep: async () => {} }), (e) => { assert.equal(e.reasonCode, 'exited:1'); assert.match(e.message, /reason code: exited:1/); assert.doesNotMatch(e.message, /hunter2|withheld/); return true; });
  assert.ok(d.calls.some((c) => c[1] === 'start' && c[2] === 'sha-1'), 'started by inspected ID');
  assert.equal(events[0].d.reason_code, 'exited:1'); assert.ok(events[0].d.log_tail.length); assert.ok(!JSON.stringify(events).includes('abcdef'), 'log tail redacted');
  // port bind at start
  st = { c: { ...base, State: { Running: false, Status: 'created' } }, startErr: 'Error response from daemon: driver failed programming external connectivity: Bind for 127.0.0.1:18380 failed: port is already allocated' };
  d = fakeDocker(st);
  await assert.rejects(startOwnedContainer({ run: d.run, name: 'pp-vw', fail: failErr, sleep: async () => {} }), /reason code: port_bind/);
  // healthy after start
  st = { c: { ...base, State: { Running: false, Status: 'created' } } };
  let polls = 0; st.onStart = () => { st.c = { ...base, State: { Running: true, Status: 'running', Health: { Status: 'starting' } } }; };
  d = fakeDocker(st);
  const origRun = d.run; const run = async (argv) => { if (argv[2] === 'inspect' && st.c.State.Running && ++polls > 2) st.c.State.Health.Status = 'healthy'; return origRun(argv); };
  assert.equal((await startOwnedContainer({ run, name: 'pp-vw', fail: failErr, sleep: async () => {} })).health, 'healthy');
  // health never passes → health_timeout
  st = { c: { ...base, State: { Running: true, Status: 'running', Health: { Status: 'starting' } } } };
  let t = 0; d = fakeDocker(st);
  await assert.rejects(startOwnedContainer({ run: d.run, name: 'pp-vw', fail: failErr, sleep: async () => {}, now: () => (t += 60000), healthTimeoutMs: 100000 }), /reason code: health_timeout/);
  // already running and healthy → nothing started (retry continues from there)
  st = { c: { ...base, State: { Running: true, Status: 'running', Health: { Status: 'healthy' } } } };
  d = fakeDocker(st);
  assert.equal((await startOwnedContainer({ run: d.run, name: 'pp-vw', fail: failErr })).already, true);
  assert.ok(!d.calls.some((c) => c[1] === 'start'));
  assert.equal(classifyDockerError('pull access denied for x'), 'image_pull');
  assert.equal(classifyDockerError('error mounting "/x": permission denied'), 'mount_permission');
  assert.equal(reasonCodeOf('Vaultwarden server did not come up (reason code: exited:137): x'), 'exited:137');
});

test('3a: owned containers use the local log driver; logs are read redacted, journald falls back to journalctl, "none" says why', async () => {
  assert.deepEqual(LOG_ARGS, ['--log-driver', 'local', '--log-opt', 'max-size=10m', '--log-opt', 'max-file=3']);
  assert.equal(logConfigCurrent({ LogConfig: { Type: 'local', Config: { 'max-size': '10m', 'max-file': '3' } } }), true);
  assert.equal(logConfigCurrent({ LogConfig: { Type: 'none', Config: {} } }), false);
  const mk = (Type) => fakeDocker({ c: { Id: 'id1', Name: '/c', HostConfig: { LogConfig: { Type } }, State: { Running: true } } });
  let d = mk('local'); let r = await readContainerLogs({ run: d.run, name: 'c', lines: 50 });
  assert.equal(r.readable, true); assert.equal(r.lines.length, 2); assert.match(r.lines[0], /err line/); assert.ok(!r.lines.join('\n').includes('abcdef'));
  d = mk('journald'); r = await readContainerLogs({ run: d.run, name: 'c' });
  assert.equal(r.source, 'journalctl'); assert.ok(d.calls.some((c) => c[0] === 'journalctl' && c[1] === 'CONTAINER_NAME=c')); assert.ok(!r.lines.join('\n').includes('hunter2'));
  d = mk('none'); r = await readContainerLogs({ run: d.run, name: 'c' });
  assert.equal(r.readable, false); assert.match(r.reason, /Repair/);
});

test('3d: a recorded route whose upstream nothing listens on fails with upstream_not_listening', async () => {
  const run = async () => ({ code: 0, stdout: 'LISTEN 0 4096 127.0.0.1:18080 0.0.0.0:*\n', stderr: '' });
  await assert.rejects(assertUpstreamListening({ run, port: 18085, fail: failErr, label: 'Infisical' }), /upstream_not_listening/);
  assert.equal(await assertUpstreamListening({ run, port: 18080, fail: failErr, label: 'Keycloak' }), true);
});

test('3e: DNS verdict needs both resolvers on the Caddy host, names a disagreement and where to change the record', async () => withDb(async (db) => {
  const expected = { host: ['192.168.88.20'], public: ['96.88.158.118'], from: 'pilot.example.com' };
  const ok = dnsVerdict('vault.fractionate.ai', { host: { addresses: ['192.168.88.20'] }, public: { addresses: ['96.88.158.118'] } }, expected, { managed: false });
  assert.equal(ok.ok, true);
  const bad = dnsVerdict('vault.fractionate.ai', { host: { addresses: ['192.168.88.99'] }, public: { addresses: ['104.21.3.4'] } }, expected, { managed: false });
  assert.equal(bad.ok, false);
  for (const part of ['192.168.88.99', '104.21.3.4', '96.88.158.118', 'disagree', 'external DNS host', 'vault.fractionate.ai. A 96.88.158.118']) assert.ok(bad.reason.includes(part), part);
  const cf = dnsVerdict('vault.example.org', { host: { addresses: ['1.2.3.4'] }, public: { addresses: ['1.2.3.4'] } }, expected, { managed: true, zone: 'example.org' });
  assert.match(cf.reason, /set_dns_record/); assert.equal(cf.agree, true);
  // A continue for one service is refused while its hostname points elsewhere.
  await connected(db);
  clearDnsCache();
  const elsewhere = { host: async (h) => (h === 'vault.example.com' ? ['192.0.2.50'] : [CADDY]), public: async (h) => (h === 'vault.example.com' ? ['192.0.2.50'] : [CADDY]) };
  setFlag(db, 'mcp.platform', true);
  const full = readFullPlatform(db);
  const { reviewFullPlatform } = await import('../lib/setup-engine/full-platform-store.js');
  const res = await tools(db, { resolvers: elsewhere }).call('continue_platform_setup', { revision: full.revision, review_digest: reviewFullPlatform(db).reviewToken, service: 'vaultwarden', confirm: true });
  assert.equal(res.isError, true); assert.match(text(res), /vault\.example\.com.*192\.0\.2\.50/);
  const { results } = await checkHostnames(db, ['vault.example.com'], { resolvers: elsewhere, fresh: true });
  assert.equal(results['vault.example.com'].ok, false);
}));

test('3f: restricted networks change through a review; /0 and an empty list are refused; active SSO blocks', () => withDb(async (db) => {
  await connected(db);
  assert.throws(() => networksReview(db, []), /At least one/);
  assert.throws(() => networksReview(db, ['0.0.0.0/0']), /\/0/);
  const r = networksReview(db, ['10.9.0.0/24']);
  assert.deepEqual(r.after, ['10.9.0.0/24']); assert.match(r.reviewToken, /^[a-f0-9]{64}$/);
  assert.ok(r.records.some((x) => x.record === 'setup_vaultwarden'));
  db.prepare('UPDATE sso_config SET active=1').run();
  assert.ok(networksReview(db, ['10.9.0.0/24']).blockers.some((b) => /SSO is active/.test(b)));
}));

test('3g: resync creates a new Full Platform revision from the saved values and keeps it applied', () => withDb(async (db) => {
  await connected(db);
  assert.ok(resyncReview(db).blockers.some((b) => /already matches/.test(b)));
  db.prepare('UPDATE setup_platform_plan SET revision=revision+5').run();
  const before = readFullPlatform(db);
  const review = resyncReview(db);
  assert.deepEqual(review.blockers, []);
  const after = resyncSharedPlan(db, { revision: before.revision }, 'admin');
  assert.equal(after.revision, before.revision + 1); assert.equal(after.approved_revision, after.revision);
  assert.deepEqual(after.config, before.config);
}));

test('3i: the data-kept reset preview says the fixed-path data is moved aside', () => withDb(async (db) => {
  await connected(db);
  const r = resetReview(db, { purgeData: false });
  assert.equal(r.retain.data_handling, 'moved_aside');
  assert.ok(r.retain.directories.filter((d) => d.service !== 'keycloak').every((d) => d.action === 'moved aside' && /\.retained-/.test(d.moved_to)));
}));

/* -------------------------------- Part 2 -------------------------------- */

test('the overview: health from inspect, broken when the upstream is not listening, Vaultwarden retry disabled with the DNS reason, no secrets', () => withDb(async (db) => {
  await connected(db);
  clearOverviewCache(); clearDnsCache();
  const vw = readVaultwarden(db), inf = readInfisical(db);
  const { containerNames } = await import('../lib/setup-engine/full-platform-mcp.js');
  const infNames = containerNames('infisical', inf), vwName = containerNames('vaultwarden', vw)[0];
  const inspect = (name, service, ref) => ({ Id: `id-${name}`, Name: `/${name}`, Config: { Image: 'img', Labels: { [`io.proxypilot.${service}`]: ref } }, HostConfig: { LogConfig: { Type: 'local' } }, State: { Running: true, Status: 'running', Health: { Status: 'healthy' } } });
  const present = new Map([[vwName, inspect(vwName, 'vaultwarden', vw.credential_ref)], ...infNames.slice(1).map((n) => [n, inspect(n, 'infisical', inf.credential_ref)])]);
  const host = ([bin, ...a]) => {
    if (bin === 'docker' && a[0] === 'info') return { status: 0, stdout: '"28.3" "journald"', stderr: '' };
    if (bin === 'docker' && a[1] === 'ls') return { status: 0, stdout: [...present.keys()].join('\n'), stderr: '' };
    if (bin === 'docker' && a[1] === 'inspect') return { status: 0, stdout: JSON.stringify(a.slice(2).map((n) => present.get(n)).filter(Boolean)), stderr: '' };
    if (bin === 'ss') return { status: 0, stdout: 'LISTEN 0 1 127.0.0.1:18380 0.0.0.0:*\nLISTEN 0 1 127.0.0.1:18080 0.0.0.0:*', stderr: '' };
    return { status: 1, stdout: '', stderr: '' };
  };
  // Infisical's route is recorded; its upstream 18085 is not listening.
  db.prepare("INSERT INTO services (id, name, kind, runtime, target_ip, type, status) VALUES (?, 'pp-platform-infisical', 'container_service', 'docker', '127.0.0.1', 'proxy', 'active')").run(`infisical-${inf.credential_ref}`);
  db.prepare("INSERT INTO service_http_routes (id, service_id, domain, path_prefix, target_port, websocket_enabled, ssl_enabled, force_https, max_upload_size, strip_prefix, ip_allowlist_json) VALUES (?, ?, 'secrets.example.com', '/', 18085, 1, 1, 1, '1G', 0, '[\"10.20.30.0/24\"]')").run(`infisical-route-${inf.credential_ref}`, `infisical-${inf.credential_ref}`);
  const resolvers = { host: async (h) => (h === 'vault.example.com' ? ['192.0.2.50'] : [CADDY]), public: async (h) => (h === 'vault.example.com' ? ['198.51.100.9'] : [CADDY]) };
  const run = async (argv) => host(argv);
  const o = await platformOverview(db, { run, resolvers, fresh: true });
  const by = Object.fromEntries(o.services.map((s) => [s.id, s]));
  assert.equal(o.docker.default_log_driver, 'journald');
  assert.equal(by.infisical.health.status, 'broken');
  assert.match(by.infisical.health.reason, /missing: .*proxy/); assert.match(by.infisical.health.reason, /127\.0\.0\.1:18085 is not listening/);
  assert.equal(by.vaultwarden.route.recorded, false);
  assert.equal(by.vaultwarden.dns.ok, false); assert.equal(by.vaultwarden.dns.agree, false);
  const retry = by.vaultwarden.actions.find((a) => a.id === 'retry');
  assert.equal(retry.enabled, false); assert.match(retry.reason, /vault\.example\.com/);
  assert.equal(by.recovery.name, 'ProxyPilot recovery route');
  assert.deepEqual(Object.keys(o.flag).includes('enabled'), true);
  const blob = JSON.stringify(o);
  assert.doesNotMatch(blob, /b{43}|clientSecret|client_secret"\s*:\s*"[^"]|credential_ref/);
  // The MCP access column follows the switch immediately.
  setFlag(db, 'mcp.platform', true);
  const on = await platformOverview(db, { run, resolvers });
  setFlag(db, 'mcp.platform', false);
  const off = await platformOverview(db, { run, resolvers });
  assert.ok(on.services[0].mcp.callable.length > 0); assert.equal(off.services[0].mcp.callable.length, 0);
}));

test('set_route / set_route_path and the UI route writers refuse a hostname in the saved Full Platform plan', () => withDb(async (db) => {
  const { config } = await import('./helpers/full-platform-fixture.js');
  const c = config(); c.services.vaultwarden.url = 'https://lock.fractionate.ai';
  approved(db, c);
  const r = platformRouteRefusal(db, { hostname: 'lock.fractionate.ai' });
  assert.equal(r.service, 'vaultwarden'); assert.match(r.error, /service adapter creates and owns that route/);
  assert.equal(platformRouteRefusal(db, { hostname: 'unrelated.example.net' }), null);
  assert.equal(platformRouteRefusal(db, { routeId: 'infisical-route-abc' }).service, 'infisical');
  const t = tools(db);
  setFlag(db, 'mcp.platform', true);
  const { createEdgeHandlers } = await import('../routes/mcp-tools/edge.js');
  const edge = createEdgeHandlers(createToolkit({ ...t.ctx, ROUTE_SELECT: '', validDomainName: (d) => d, normalizePort: (p) => Number(p) }));
  const res = await edge.set_route_path({ domain: 'lock.fractionate.ai', path_prefix: '/api', upstream_port: 80, upstream_ip: '10.0.0.5' }, { id: 1, created_by: 'admin' }, {});
  assert.equal(res.isError, true); assert.match(text(res), /Vaultwarden/);
}));

test('3h: bootstrap recovery runs kc.sh bootstrap-admin in the owned container with a protected, verified credential, then the coordinator resumes', () => withDb(async (db) => {
  const { mkdtempSync, mkdirSync, existsSync, readFileSync, readdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { recoveryReview, queueRecovery } = await import('../lib/setup-engine/full-platform-kc-recovery.js');
  const { protectedValue } = await import('../lib/setup-engine/full-platform-keycloak.js');
  const { createJob } = await import('../lib/setup-engine/store.js');
  const { k } = await connected(db);
  // connect_managed_identity recorded that the bootstrap administrator cannot authenticate.
  const failed = createJob(db, { app: 'pp-full-platform', kind: 'full_platform_apply', plan: { params: { revision: 1 } }, requestedBy: 'admin', via: 'ui' });
  db.prepare("UPDATE setup_jobs SET status='failed', reason=? WHERE id=?").run('The existing Keycloak bootstrap administrator cannot authenticate. Keep the realm and use the reviewed bootstrap-administrator recovery.', failed.id);
  db.prepare('UPDATE setup_full_platform SET last_job_id=? WHERE id=1').run(failed.id);
  const review = recoveryReview(db);
  assert.deepEqual(review.blockers, []);
  assert.throws(() => queueRecovery(db, { revision: review.revision, reviewToken: 'f'.repeat(64), reviewed: true }, 'admin'), /stale/);
  const queued = queueRecovery(db, { revision: review.revision, reviewToken: review.reviewToken, reviewed: true }, 'admin');
  const root = mkdtempSync(join(tmpdir(), 'kc-recovery-')); mkdirSync(join(root, k.id), { mode: 0o700 });
  const calls = []; let envSeen = null;
  const exec = { host: async (argv) => { calls.push(argv); const f = argv[argv.indexOf('--env-file') + 1]; envSeen = readFileSync(f, 'utf8'); return { code: 0, stdout: '', stderr: '' }; } };
  const created = new Set();
  const admin = async (_k, password, { username }) => { if (!created.has(`${username}:${password}`)) throw Object.assign(new Error('401'), { fullPlatformSafe: true }); return { close: async () => {} }; };
  // The fake container records the account kc.sh would create from the env file.
  const hostWrap = { host: async (argv) => { const r = await exec.host(argv); const u = /PP_RECOVERY_USERNAME=(\S+)/.exec(envSeen)[1], p = /PP_RECOVERY_PASSWORD=(\S+)/.exec(envSeen)[1]; created.add(`${u}:${p}`); return r; } };
  startJob(db, { id: queued.job.id, owner: 'runner@overview#1:a' });
  const wire = keycloakWire(k);
  const identity = async (db2, kk, full, { job: j }) => { const a = await keycloakAdmin(kk, 'b'.repeat(43), { send: wire.send, job: j }); try { return await reconcileOwnedIdentity(db2, kk, full, a.api, j); } finally { await a.close(); } };
  const result = await runFullPlatformOperation({ db, params: { revision: 1, operation: 'keycloak_recovery' }, exec: hostWrap, job: { ...handle(queued.job.id), event() {} }, identity, interfaces: { test: [{ address: '10.20.30.40', internal: false }] }, dnsCheck: async () => null, recoveryDeps: { root, admin } });
  assert.ok(result, 'the coordinator continued after the recovery');
  const cmd = calls.find((c) => c.includes('bootstrap-admin'));
  assert.deepEqual(cmd.slice(0, 2), ['docker', 'exec']); assert.ok(cmd.includes('--no-prompt')); assert.ok(cmd.includes('--password:env'));
  assert.ok(!cmd.join(' ').match(/PP_RECOVERY_PASSWORD=/), 'the password never appears in argv');
  assert.deepEqual(readdirSync(join(root, k.id)).filter((f) => f.endsWith('.env')), [], 'the env file is removed');
  const stored = protectedValue(db, `keycloak-bootstrap-${k.id}`);
  assert.equal(stored.recovered, queued.job.id); assert.match(stored.username, /^pp-recovery-/); assert.equal(stored.retired, false);
  assert.equal(existsSync(join(root, k.id, 'owner.json')), false, 'no ownership file was written by recovery');
}));
