// Who can reach each platform service (2026-09).
//
// Recovery, OpenBao and Infisical are always restricted to the platform's
// networks (VPN ∪ additional addresses) — there is no switch for them. Three
// surfaces have one, each applied only by an explicit, audited dashboard action:
//
//   vaultwarden   restricted (default) | open  — open keeps /admin restricted
//   keycloakAdmin restricted (default) | open  — Keycloak's /admin (admin
//                 console + admin REST API) on the Keycloak route; sign-in and
//                 account pages are always public (every service signs in there)
//   proxypilot    open (default) | restricted  — the dashboard hostname. It is
//                 written by install.sh and never rendered by the backend, so it
//                 imports a backend-owned snippet (ADMIN_ACCESS_SNIPPET, the same
//                 pattern as pp-admin-tls.caddy). Token-authenticated machine
//                 endpoints (MCP, migration agents, git, health) stay reachable.
//                 It starts open because the dashboard is what sets up the VPN;
//                 turning it restricted is refused from a browser outside the
//                 networks, so the action cannot lock out the person doing it.
//
// ProxyPilot's own calls to Keycloak /admin go through the local edge with the
// self-check header (keycloakFetch in lib/sso/oidc.js), so restricting it never
// blocks the observer, the LDAP link or the administrator handoff.

import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { readFullPlatform, installedTargets, fail } from './full-platform-store.js';
import { serviceReaders } from './full-platform-services.js';
import { ownedRoute } from './full-platform-mcp.js';
import { DENIED_BODY } from '../caddy-site-file.js';
import { spawnHostSync } from '../host-exec.js';
import { inDocker } from './local-edge.js';

export const ACCESS_KEYS = ['vaultwarden', 'keycloakAdmin', 'proxypilot'];
export const ACCESS_DEFAULTS = Object.freeze({ vaultwarden: 'restricted', keycloakAdmin: 'restricted', proxypilot: 'open' });
const SETTING = (k) => `platform_access_${k}`;
export const FIXED = Object.freeze([
  { id: 'recovery', name: 'Local recovery sign-in', reason: 'The emergency sign-in that works when SSO is down. It skips SSO, so it never faces the internet.' },
  { id: 'openbao', name: 'OpenBao', reason: 'Machine secrets. Apps reach it from inside the server; people manage it over the VPN.' },
  { id: 'infisical', name: 'Infisical', reason: 'Agent secrets. Agents use the Agent Proxy on the private address; the console stays on the VPN.' },
]);
export const ADMIN_ACCESS_SNIPPET = process.env.CADDY_ADMIN_ACCESS_SNIPPET || '/etc/caddy/pp-admin-access.caddy';
const SITES_DIR = () => process.env.CADDY_SITES_DIR || '/etc/caddy/sites';
// Token-authenticated machine endpoints that must keep working from anywhere.
export const DASHBOARD_MACHINE_PATHS = Object.freeze(['/api/health', '/api/mcp', '/api/mcp/*', '/api/mcp-editor/*', '/api/migrations/agent/*', '/api/mock2/git/*']);
// The snippet lives in /etc/caddy, which the backend container does not mount
// (only sites/, custom/ and the Caddyfile are): written through the host, like
// the admin TLS snippet (lib/tls-cert-store.js). A write into the container's
// own /etc/caddy left the host's import pointing at a missing file, and caddy
// adapt refused the whole change (2026-09-24).
const SAFE_PATH = /^\/[A-Za-z0-9._/-]+$/;
const fsIo = { read: (f) => (existsSync(f) ? readFileSync(f, 'utf8') : null), write: (f, text) => { const tmp = join(dirname(f), `.${Date.now()}.pp-tmp`); writeFileSync(tmp, text, { mode: 0o644 }); renameSync(tmp, f); } };
const hostIo = {
  read: (f) => { if (!SAFE_PATH.test(f)) return null; const r = spawnHostSync('sh', ['-c', `cat '${f}' 2>/dev/null`], { encoding: 'utf8', timeout: 5000 }); return r.status === 0 ? r.stdout : null; },
  write: (f, text) => { if (!SAFE_PATH.test(f)) throw fail('Unsafe snippet path.'); const r = spawnHostSync('sh', ['-c', `cat > '${f}.pp-tmp' && chmod 644 '${f}.pp-tmp' && (chown root:caddy '${f}.pp-tmp' 2>/dev/null || true) && mv '${f}.pp-tmp' '${f}'`], { input: text, encoding: 'utf8', timeout: 8000 }); if (r.error || r.status !== 0) throw new Error(`could not write ${f} on the host`); },
};
/** Snippet file I/O: through the host inside the Docker backend, else the local filesystem. */
export const snippetIo = () => (inDocker() ? hostIo : fsIo);
const choice = z.enum(['restricted', 'open']);
export const accessSchema = z.object({ vaultwarden: choice, keycloakAdmin: choice, proxypilot: choice, reviewed: z.literal(true) }).strict();

const hasTable = (db, t) => { try { return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t); } catch { return false; } };
const setting = (db, key) => { try { return db.prepare('SELECT value FROM app_settings WHERE key=?').get(key)?.value ?? null; } catch { return null; } };
const parse = (v) => { try { return v ? JSON.parse(v) : null; } catch { return null; } };
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Saved choices, defaults filled in. */
export function accessChoices(db) {
  const out = {};
  for (const k of ACCESS_KEYS) { const v = setting(db, SETTING(k)); out[k] = v === 'open' || v === 'restricted' ? v : ACCESS_DEFAULTS[k]; }
  return out;
}

/** The route rows each switch drives. */
export function accessRoutes(db) {
  if (!hasTable(db, 'service_http_routes')) return {};
  const row = (id) => (id ? db.prepare('SELECT * FROM service_http_routes WHERE id=?').get(id) || null : null);
  const vw = serviceReaders.vaultwarden?.(db);
  const k = installedTargets(db).keycloak?.row;
  return {
    vaultwarden: vw && vw.config?.mode === 'install' ? row(ownedRoute('vaultwarden', vw)?.route_id) : null,
    keycloakAdmin: k && k.ownership === 'managed' ? row(`keycloak-route-${k.id}`) : null,
  };
}

/** The effective restricted networks (VPN ∪ additional) the platform applied. */
export function accessNetworks(db) {
  const n = readFullPlatform(db)?.config?.recoveryNetworks;
  return Array.isArray(n) ? n.filter(Boolean) : [];
}

/** Text of the dashboard access snippet for a choice. */
export function adminAccessSnippet(restricted, networks) {
  const head = '# ProxyPilot dashboard access — managed by ProxyPilot (Platform Setup → Use your platform → Who can reach each service).\n# Do not edit: the next Apply rewrites this file.\n';
  if (!restricted) return `${head}# access: open\n`;
  if (!networks.length) throw fail('No restricted networks are applied yet, so the dashboard cannot be made VPN-only.');
  const q = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  return `${head}# access: restricted\n@pp_admin_denied {\n    not remote_ip ${networks.join(' ')}\n    not path ${DASHBOARD_MACHINE_PATHS.join(' ')}\n}\nheader @pp_admin_denied Content-Type "text/html; charset=utf-8"\nrespond @pp_admin_denied ${q(DENIED_BODY)} 403\n`;
}

/** The dashboard's site file and whether it imports the snippet (or can be made to). */
export function adminSite(adminDomain, { sitesDir = SITES_DIR(), snippet = ADMIN_ACCESS_SNIPPET } = {}) {
  if (!adminDomain) return { file: null, imports: false, canImport: false, reason: 'No dashboard domain is recorded.' };
  const file = [join(sitesDir, adminDomain), join(sitesDir, `${adminDomain}.caddy`)].find((f) => existsSync(f)) || null;
  if (!file) return { file: null, imports: false, canImport: false, reason: `The dashboard site file for ${adminDomain} was not found in ${sitesDir}.` };
  const text = readFileSync(file, 'utf8');
  const imports = text.split('\n').some((l) => l.trim() === `import ${snippet}`);
  const ours = /^# ProxyPilot Admin Dashboard/m.test(text) && new RegExp(`^${adminDomain.replace(/\./g, '\\.')} \\{`, 'm').test(text);
  return { file, text, imports, canImport: imports || ours, reason: imports || ours ? null : 'The dashboard site file is not the one ProxyPilot installed; add the import line by hand to control it here.' };
}

/** The site file with the snippet import added right after the domain line. */
export function withAdminImport(text, adminDomain, snippet = ADMIN_ACCESS_SNIPPET) {
  if (text.split('\n').some((l) => l.trim() === `import ${snippet}`)) return text;
  const lines = text.split('\n'), i = lines.findIndex((l) => l.startsWith(`${adminDomain} {`));
  if (i < 0) throw fail('The dashboard site block was not found; nothing was changed.');
  lines.splice(i + 1, 0, `    import ${snippet}`);
  return lines.join('\n');
}

/** What each switch is set to and what is actually applied. */
export function accessState(db, { adminDomain = null, snippet = ADMIN_ACCESS_SNIPPET, sitesDir, io = snippetIo() } = {}) {
  const choices = accessChoices(db), routes = accessRoutes(db), networks = accessNetworks(db);
  const vwPaths = parse(routes.vaultwarden?.ip_allowlist_paths_json);
  const kcAllow = parse(routes.keycloakAdmin?.ip_allowlist_json);
  let snippetText = null; try { snippetText = io.read(snippet); } catch { snippetText = null; }
  const site = adminSite(adminDomain, { sitesDir, snippet });
  const applied = {
    vaultwarden: routes.vaultwarden ? (same(vwPaths, ['/admin']) ? 'open' : 'restricted') : null,
    keycloakAdmin: routes.keycloakAdmin ? (Array.isArray(kcAllow) && kcAllow.length ? 'restricted' : 'open') : null,
    proxypilot: site.imports && /# access: restricted/.test(snippetText || '') ? 'restricted' : 'open',
  };
  return {
    networks, choices, applied,
    pending: ACCESS_KEYS.filter((k) => applied[k] !== null && applied[k] !== choices[k]),
    fixed: FIXED.map((f) => ({ ...f, access: 'restricted' })),
    switches: [
      { id: 'vaultwarden', name: 'Vaultwarden', available: !!routes.vaultwarden, host: routes.vaultwarden?.domain || null, open: 'Anyone can reach it; /admin stays VPN-only. Sign-in still needs Keycloak, and the vault still needs your master password.', restricted: 'VPN and your additional networks only. Phone and browser-extension sync need the VPN.' },
      { id: 'keycloakAdmin', name: 'Keycloak admin console', available: !!routes.keycloakAdmin, host: routes.keycloakAdmin?.domain || null, open: 'Anyone can load the admin console and admin API (sign-in still required).', restricted: 'The admin console and admin API (/admin) answer only the VPN and your additional networks. Sign-in and account pages stay public.' },
      { id: 'proxypilot', name: 'ProxyPilot dashboard', available: site.canImport, host: adminDomain, reason: site.reason, open: 'Anyone can reach the sign-in page (sign-in, passkey and step-up still required).', restricted: 'VPN and your additional networks only. MCP, migration agents and git keep working from anywhere with their own tokens.' },
    ],
  };
}

/** The address a request came from, as Caddy saw it (Caddy overwrites X-Forwarded-For). */
export function clientAddress(req) {
  const xff = String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  return xff || String(req.ip || '').replace(/^::ffff:/, '');
}

const v4 = (ip) => { const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip); return m && m.slice(1).every((x) => +x <= 255) ? m.slice(1).reduce((n, x) => n * 256 + +x, 0) : null; };
/** Is an IPv4 address inside any of the networks (IPv4 CIDRs or single addresses)? */
export function inNetworks(ip, networks) {
  const a = v4(ip); if (a === null) return false;
  return networks.some((n) => { const [base, bits = '32'] = String(n).split('/'); const b = v4(base), m = +bits; if (b === null || !(m >= 0 && m <= 32)) return false; const mask = m === 0 ? 0 : (0xffffffff << (32 - m)) >>> 0; return ((a & mask) >>> 0) === ((b & mask) >>> 0); });
}

/**
 * Apply the saved switches: route rows, the dashboard snippet (+ its import),
 * one Caddy regenerate/validate/reload, everything restored if any step fails.
 * deps: { regenerate(domain), adapt(), reload() } from routes/services.js.
 */
export async function applyAccess(db, raw, { client, adminDomain, deps, snippet = ADMIN_ACCESS_SNIPPET, sitesDir, io = snippetIo() } = {}) {
  const p = accessSchema.parse(raw), routes = accessRoutes(db), networks = accessNetworks(db);
  if ((p.proxypilot === 'restricted' || p.keycloakAdmin === 'restricted') && !networks.length) throw fail('No restricted networks are applied yet. Finish stage A (domains, realm and networks) first.');
  const site = adminSite(adminDomain, { sitesDir, snippet });
  if (p.proxypilot === 'restricted') {
    if (!site.canImport) throw fail(site.reason || 'The dashboard cannot be restricted from here.');
    if (!inNetworks(client, networks)) throw fail(`This browser is connecting from ${client || 'an unknown address'}, which is outside the restricted networks (${networks.join(', ')}). Making the dashboard VPN-only now would lock you out. Connect through the VPN (or add this address under restricted networks) and try again.`);
  }
  const updates = [];
  if (routes.vaultwarden) updates.push({ row: routes.vaultwarden, set: { ip_allowlist_paths_json: p.vaultwarden === 'open' ? JSON.stringify(['/admin']) : null } });
  if (routes.keycloakAdmin) updates.push({ row: routes.keycloakAdmin, set: p.keycloakAdmin === 'restricted' ? { ip_allowlist_json: JSON.stringify(networks), ip_allowlist_paths_json: JSON.stringify(['/admin']) } : { ip_allowlist_json: null, ip_allowlist_paths_json: null } });
  const snippetBefore = io.read(snippet), siteBefore = site.file ? site.text : null;
  const write = (file, text) => { const tmp = join(dirname(file), `.${Date.now()}.pp-tmp`); writeFileSync(tmp, text, { mode: 0o644 }); renameSync(tmp, file); };
  const restore = async () => {
    for (const u of updates) { const cols = Object.keys(u.set); db.prepare(`UPDATE service_http_routes SET ${cols.map((c) => `${c}=?`).join(',')} WHERE id=?`).run(...cols.map((c) => u.row[c] ?? null), u.row.id); }
    // With no earlier snippet an open one is left behind: harmless, and the
    // restored site file may still import it.
    try { io.write(snippet, snippetBefore ?? adminAccessSnippet(false, [])); } catch { /* best effort */ }
    try { if (site.file && siteBefore !== null) write(site.file, siteBefore); } catch { /* best effort */ }
    for (const d of new Set(updates.map((u) => u.row.domain))) { try { await deps.regenerate(d); } catch { /* best effort */ } }
    try { await deps.reload(); } catch { /* best effort */ }
  };
  try {
    for (const u of updates) { const cols = Object.keys(u.set); db.prepare(`UPDATE service_http_routes SET ${cols.map((c) => `${c}=?`).join(',')} WHERE id=?`).run(...cols.map((c) => u.set[c]), u.row.id); }
    if (site.canImport) {
      io.write(snippet, adminAccessSnippet(p.proxypilot === 'restricted', networks));
      if (!site.imports) write(site.file, withAdminImport(site.text, adminDomain, snippet));
    }
    for (const d of new Set(updates.map((u) => u.row.domain))) await deps.regenerate(d);
    await deps.adapt();
    await deps.reload();
  } catch (e) {
    await restore();
    throw fail(`The access change was not applied and everything was restored: ${String(e?.stderr || e?.message || e).slice(0, 300)}`);
  }
  const put = db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  for (const k of ACCESS_KEYS) put.run(SETTING(k), p[k]);
  return accessState(db, { adminDomain, snippet, sitesDir, io });
}

/** After a restricted-network change: rewrite a restricted dashboard snippet with the new list (no-op otherwise). → true when rewritten */
export function refreshAdminSnippet(db, networks, { snippet = ADMIN_ACCESS_SNIPPET, io = snippetIo() } = {}) {
  try {
    if (!/# access: restricted/.test(io.read(snippet) || '') || !networks.length) return false;
    io.write(snippet, adminAccessSnippet(true, networks));
    return true;
  } catch { return false; }
}
