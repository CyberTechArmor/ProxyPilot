// Who can reach each platform service (lib/setup-engine/platform-access.js),
// the path-limited allowlist it renders, and the container → host local edge.
import test from 'node:test';
import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeDb, driveStages } from './helpers/full-platform-fixture.js';
import { accessState, applyAccess, adminAccessSnippet, withAdminImport, inNetworks, clientAddress, refreshAdminSnippet, ACCESS_DEFAULTS, DASHBOARD_MACHINE_PATHS } from '../lib/setup-engine/platform-access.js';
import { installedTargets } from '../lib/setup-engine/full-platform-store.js';
import { serviceReaders } from '../lib/setup-engine/full-platform-services.js';
import { ownedRoute } from '../lib/setup-engine/full-platform-mcp.js';
import { parseRouteEdgeOptions, routeEdgeOptionLines } from '../lib/caddy-site-file.js';
import { defaultGateway, localEdgeAddress, containerSources, recordSelfCheckSources, selfCheckSources } from '../lib/setup-engine/local-edge.js';
import { approvedFetch } from '../lib/sso/oidc.js';

const ADMIN = 'pilot.example.com';
const SITE = `# ProxyPilot Admin Dashboard\n# Domain: ${ADMIN}\n\n${ADMIN} {\n    reverse_proxy 127.0.0.1:3001\n}\n`;

async function platform() {
  const db = makeDb(); await driveStages(db, { through: 'D' });
  const cols = db.prepare('PRAGMA table_info(service_http_routes)').all().map((c) => c.name);
  for (const c of ['ip_allowlist_json', 'ip_allowlist_paths_json']) if (!cols.includes(c)) db.exec(`ALTER TABLE service_http_routes ADD COLUMN ${c} TEXT`);
  const k = installedTargets(db).keycloak.row, vw = serviceReaders.vaultwarden(db);
  const ins = db.prepare("INSERT INTO service_http_routes (id, service_id, domain, path_prefix, target_port, ssl_enabled, force_https, ip_allowlist_json) VALUES (?, ?, ?, '/', ?, 1, 1, ?)");
  ins.run(`keycloak-route-${k.id}`, `keycloak-${k.id}`, 'id.example.com', 18080, null);
  const vwRoute = ownedRoute('vaultwarden', vw).route_id;
  ins.run(vwRoute, `vaultwarden-x`, 'vault.example.com', 18380, JSON.stringify(['10.20.30.0/24']));
  const dir = mkdtempSync(join(tmpdir(), 'pp-access-')), sites = join(dir, 'sites'); mkdirSync(sites);
  writeFileSync(join(sites, ADMIN), SITE);
  const calls = [];
  const deps = { regenerate: async (d) => calls.push(`regen ${d}`), adapt: async () => calls.push('adapt'), reload: async () => calls.push('reload') };
  return { db, dir, sites, snippet: join(dir, 'pp-admin-access.caddy'), deps, calls, kcId: `keycloak-route-${k.id}`, vwRoute, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const route = (db, id) => db.prepare('SELECT * FROM service_http_routes WHERE id=?').get(id);

test('defaults: Vaultwarden and Keycloak admin restricted, dashboard open; recovery/OpenBao/Infisical always restricted', async () => {
  const p = await platform();
  try {
    assert.deepEqual(ACCESS_DEFAULTS, { vaultwarden: 'restricted', keycloakAdmin: 'restricted', proxypilot: 'open' });
    const s = accessState(p.db, { adminDomain: ADMIN, snippet: p.snippet, sitesDir: p.sites });
    assert.deepEqual(s.fixed.map((f) => [f.id, f.access]), [['recovery', 'restricted'], ['openbao', 'restricted'], ['infisical', 'restricted']]);
    assert.deepEqual(s.applied, { vaultwarden: 'restricted', keycloakAdmin: 'open', proxypilot: 'open' });
    assert.deepEqual(s.pending, ['keycloakAdmin'], 'Keycloak admin is restricted by default but only after Apply');
  } finally { p.cleanup(); }
});

test('apply: Vaultwarden open keeps /admin restricted; Keycloak /admin restricted; dashboard snippet + import; one validate + reload', async () => {
  const p = await platform();
  try {
    const s = await applyAccess(p.db, { vaultwarden: 'open', keycloakAdmin: 'restricted', proxypilot: 'restricted', reviewed: true }, { client: '10.20.30.7', adminDomain: ADMIN, deps: p.deps, snippet: p.snippet, sitesDir: p.sites });
    assert.deepEqual(s.applied, { vaultwarden: 'open', keycloakAdmin: 'restricted', proxypilot: 'restricted' });
    const vw = route(p.db, p.vwRoute), kc = route(p.db, p.kcId);
    assert.equal(vw.ip_allowlist_json, JSON.stringify(['10.20.30.0/24']), 'Vaultwarden keeps its allowlist (the adapter checks it)');
    assert.equal(vw.ip_allowlist_paths_json, '["/admin"]');
    assert.equal(kc.ip_allowlist_json, JSON.stringify(['10.20.30.0/24'])); assert.equal(kc.ip_allowlist_paths_json, '["/admin"]');
    const snip = readFileSync(p.snippet, 'utf8');
    assert.match(snip, /# access: restricted/); assert.match(snip, /not remote_ip 10\.20\.30\.0\/24/);
    for (const path of DASHBOARD_MACHINE_PATHS) assert.ok(snip.includes(path), `machine path ${path} stays reachable`);
    assert.match(readFileSync(join(p.sites, ADMIN), 'utf8'), new RegExp(`${ADMIN} \\{\\n    import ${p.snippet.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n    reverse_proxy`));
    assert.deepEqual(p.calls.filter((c) => !c.startsWith('regen')), ['adapt', 'reload']);
    assert.deepEqual(p.calls.filter((c) => c.startsWith('regen')).sort(), ['regen id.example.com', 'regen vault.example.com']);
    // Back to open: the snippet opens, the import stays (harmless), Keycloak's allowlist is removed.
    const back = await applyAccess(p.db, { vaultwarden: 'restricted', keycloakAdmin: 'open', proxypilot: 'open', reviewed: true }, { client: '203.0.113.9', adminDomain: ADMIN, deps: p.deps, snippet: p.snippet, sitesDir: p.sites });
    assert.deepEqual(back.applied, { vaultwarden: 'restricted', keycloakAdmin: 'open', proxypilot: 'open' });
    assert.equal(route(p.db, p.kcId).ip_allowlist_json, null); assert.equal(route(p.db, p.vwRoute).ip_allowlist_paths_json, null);
    assert.match(readFileSync(p.snippet, 'utf8'), /# access: open/);
  } finally { p.cleanup(); }
});

test('the dashboard cannot be made VPN-only from a browser outside the networks', async () => {
  const p = await platform();
  try {
    await assert.rejects(applyAccess(p.db, { vaultwarden: 'restricted', keycloakAdmin: 'restricted', proxypilot: 'restricted', reviewed: true }, { client: '203.0.113.9', adminDomain: ADMIN, deps: p.deps, snippet: p.snippet, sitesDir: p.sites }), /lock you out/);
    assert.equal(existsSync(p.snippet), false); assert.deepEqual(p.calls, [], 'nothing was touched');
    assert.equal(readFileSync(join(p.sites, ADMIN), 'utf8'), SITE);
  } finally { p.cleanup(); }
});

test('a failed reload restores the routes, the snippet and the site file', async () => {
  const p = await platform();
  try {
    const deps = { ...p.deps, reload: async () => { p.calls.push('reload'); if (p.calls.filter((c) => c === 'reload').length === 1) throw Object.assign(new Error('reload failed'), { stderr: 'caddy: bad config' }); } };
    await assert.rejects(applyAccess(p.db, { vaultwarden: 'open', keycloakAdmin: 'restricted', proxypilot: 'restricted', reviewed: true }, { client: '10.20.30.7', adminDomain: ADMIN, deps, snippet: p.snippet, sitesDir: p.sites }), /restored: caddy: bad config/);
    assert.equal(route(p.db, p.vwRoute).ip_allowlist_paths_json, null); assert.equal(route(p.db, p.kcId).ip_allowlist_json, null);
    assert.equal(readFileSync(join(p.sites, ADMIN), 'utf8'), SITE);
    assert.match(readFileSync(p.snippet, 'utf8'), /# access: open/);
    assert.deepEqual(accessState(p.db, { adminDomain: ADMIN, snippet: p.snippet, sitesDir: p.sites }).choices, ACCESS_DEFAULTS, 'the choices are not saved');
  } finally { p.cleanup(); }
});

test('helpers: networks match, client address, import placement, snippet refresh, a foreign site file is refused', async () => {
  assert.ok(inNetworks('10.100.0.11', ['10.100.0.0/24'])); assert.ok(!inNetworks('10.100.1.11', ['10.100.0.0/24'])); assert.ok(inNetworks('203.0.113.9', ['203.0.113.9'])); assert.ok(!inNetworks('fe80::1', ['10.0.0.0/8']));
  assert.equal(clientAddress({ headers: { 'x-forwarded-for': '10.100.0.11, 172.18.0.1' }, ip: '172.18.0.1' }), '10.100.0.11');
  assert.throws(() => adminAccessSnippet(true, []), /No restricted networks/);
  assert.throws(() => withAdminImport('other.example.com {\n}\n', ADMIN), /not found/);
  assert.equal(withAdminImport(withAdminImport(SITE, ADMIN, '/s'), ADMIN, '/s').split('import /s').length, 2, 'the import is added once');
  const dir = mkdtempSync(join(tmpdir(), 'pp-snip-')), f = join(dir, 's.caddy');
  try {
    writeFileSync(f, adminAccessSnippet(false, [])); assert.equal(refreshAdminSnippet(null, ['10.1.0.0/24'], { snippet: f }), false, 'an open snippet is left alone');
    writeFileSync(f, adminAccessSnippet(true, ['10.0.0.0/24'])); assert.equal(refreshAdminSnippet(null, ['10.1.0.0/24'], { snippet: f }), true);
    assert.match(readFileSync(f, 'utf8'), /not remote_ip 10\.1\.0\.0\/24/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  const p = await platform();
  try {
    writeFileSync(join(p.sites, ADMIN), `${ADMIN} {\n    reverse_proxy 127.0.0.1:3001\n}\n`);
    const s = accessState(p.db, { adminDomain: ADMIN, snippet: p.snippet, sitesDir: p.sites });
    assert.equal(s.switches.find((x) => x.id === 'proxypilot').available, false);
    await assert.rejects(applyAccess(p.db, { vaultwarden: 'restricted', keycloakAdmin: 'restricted', proxypilot: 'restricted', reviewed: true }, { client: '10.20.30.7', adminDomain: ADMIN, deps: p.deps, snippet: p.snippet, sitesDir: p.sites }), /not the one ProxyPilot installed/);
  } finally { p.cleanup(); }
});

test('Caddy: an allowlist limited to paths guards only those paths, self-check sources included', () => {
  const o = parseRouteEdgeOptions({ ip_allowlist_json: '["10.100.0.0/24"]', ip_allowlist_paths_json: '["/admin"]' });
  const lines = routeEdgeOptionLines(o, '    ', { selfCheck: { token: 'a'.repeat(48), sources: ['127.0.0.1/32', '172.18.0.5/32'] } }).join('\n');
  assert.match(lines, /@pp_denied \{\n        path \/admin \/admin\/\*\n        not remote_ip 10\.100\.0\.0\/24\n        not \{\n            remote_ip 127\.0\.0\.1\/32 172\.18\.0\.5\/32/);
  const plain = routeEdgeOptionLines(o).join('\n');
  assert.match(plain, /@pp_denied \{\n\s+path \/admin \/admin\/\*\n\s+not remote_ip 10\.100\.0\.0\/24\n\s+\}/);
  assert.equal(parseRouteEdgeOptions({ ip_allowlist_paths_json: '["/admin"]' }), null, 'paths alone restrict nothing');
  assert.equal(parseRouteEdgeOptions({ ip_allowlist_json: '["10.0.0.0/8"]', ip_allowlist_paths_json: '["/a*b"]' }).ip_allowlist_paths, null, 'an unsafe path is ignored (whole route stays restricted)');
});

test('local edge: the container dials the bridge gateway and records its own address for the renderer', () => {
  assert.equal(defaultGateway('Iface\tDestination\tGateway\neth0\t00000000\t010012AC\t0003\neth0\t000012AC\t00000000\t0001\n'), '172.18.0.1');
  assert.equal(defaultGateway('Iface\tDestination\tGateway\n'), null);
  assert.equal(localEdgeAddress({}, { docker: false }), '127.0.0.1');
  assert.equal(localEdgeAddress({}, { docker: true, gateway: () => '172.18.0.1' }), '172.18.0.1');
  assert.equal(localEdgeAddress({ PROXYPILOT_LOCAL_EDGE: '10.0.0.5' }, { docker: true, gateway: () => '172.18.0.1' }), '10.0.0.5');
  assert.equal(localEdgeAddress({ PROXYPILOT_LOCAL_EDGE: '8.8.8.8' }, { docker: false }), '127.0.0.1', 'a public override is ignored');
  const ifaces = { lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true, cidr: '127.0.0.1/8' }], eth0: [{ address: '172.18.0.5', family: 'IPv4', internal: false, cidr: '172.18.0.5/16' }, { address: 'fe80::1', family: 'IPv6', internal: false, cidr: 'fe80::1/64' }] };
  assert.deepEqual(containerSources(ifaces), ['172.18.0.5/32']);
  const db = makeDb();
  assert.deepEqual(recordSelfCheckSources(db, { docker: true, ifaces }), { changed: true, sources: ['172.18.0.5/32'] });
  assert.equal(recordSelfCheckSources(db, { docker: true, ifaces }).changed, false);
  assert.deepEqual(selfCheckSources(db), ['127.0.0.1/32', '::1/128', '172.18.0.5/32']);
  db.prepare("UPDATE app_settings SET value=? WHERE key='platform_self_check_sources'").run('["8.8.8.8/32","10.0.0.0/8"]');
  assert.deepEqual(selfCheckSources(db), ['127.0.0.1/32', '::1/128'], 'only private /32 addresses are admitted');
});

test('approvedFetch through the edge pins the address and adds the self-check header', async () => {
  let seen;
  const request = (url, opts, cb) => { seen = { host: url.hostname, headers: opts.headers, pinned: null }; opts.lookup('x', {}, (_e, addr) => { seen.pinned = addr; }); const res = new EventEmitter(); res.statusCode = 200; setImmediate(() => { cb(res); res.emit('end'); }); return { on() {}, write() {}, end() {}, destroy() {} }; };
  const fetcher = approvedFetch('https://id.example.com', { request, edge: { address: '172.18.0.1', headers: { 'X-ProxyPilot-Self-Check': 'b'.repeat(48) } }, resolve: async () => { throw new Error('DNS must not be used'); } });
  const r = await fetcher('https://id.example.com/admin/realms/x', { headers: { Accept: 'application/json' } });
  assert.equal(r.status, 200); assert.equal(seen.pinned, '172.18.0.1'); assert.equal(seen.host, 'id.example.com');
  assert.equal(seen.headers['X-ProxyPilot-Self-Check'], 'b'.repeat(48)); assert.equal(seen.headers.accept, 'application/json');
});
