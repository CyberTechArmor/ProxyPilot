// Adapter self-checks through THIS host's Caddy (3c).
//
// A service adapter used to dial its own public hostname. Behind a NAT
// firewall that request hairpins through the firewall and reaches Caddy from
// the firewall's LAN address (192.168.88.1 on the Fractionate host), which a
// route restricted to the administrator networks answers with 403 — the
// Infisical bootstrap check failed exactly that way. Self-checks now go to the
// local Caddy the same way test_route probes: the connection is pinned to the
// loopback edge address while the URL (so TLS SNI, certificate validation and
// the Host header) keeps the service hostname.
//
// The restricted matcher lets the loopback source through ONLY together with
// the per-installation self-check header, so ordinary loopback traffic stays
// restricted and nothing is added for the firewall's LAN address or the
// host's public address. The token grants nothing a process that can already
// open 127.0.0.1:443 on this host does not have; it is not a credential and
// is never shown on any surface.
//
// No heavy imports: routes/services.js (the Caddy renderer) imports this.

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';

export const SELF_CHECK_HEADER = 'X-ProxyPilot-Self-Check';
export const SELF_CHECK_SETTING = 'platform_self_check_token';
export const LOOPBACK_SOURCES = Object.freeze(['127.0.0.1/32', '::1/128']);

// The backend runs in a Docker container on a bridge network: there 127.0.0.1
// is the container itself, so a "local" request fell back to the public name,
// hairpinned through the NAT firewall and was refused (403 from 192.168.88.1 —
// OpenBao status and the auto-unseal sweep, Vaultwarden status). Inside the
// container the host's Caddy is the bridge gateway, and Caddy sees the
// container's own address, which the backend records (recordSelfCheckSources)
// so the renderer can admit it — still only together with the header.
export const SELF_CHECK_SOURCES_SETTING = 'platform_self_check_sources';
export const inDocker = (env = process.env, exists = existsSync) => env.DOCKER_CONTAINER === 'true' || exists('/.dockerenv');
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const privateV4 = (ip) => { const m = IPV4.exec(ip); if (!m || m.slice(1).some((x) => +x > 255)) return false; const [a, b] = [+m[1], +m[2]]; return a === 10 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168; };
/** The default gateway from /proc/net/route (little-endian hex), or null. */
export function defaultGateway(text = (() => { try { return readFileSync('/proc/net/route', 'utf8'); } catch { return ''; } })()) {
  for (const line of String(text).split('\n').slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f[1] !== '00000000' || !/^[0-9A-Fa-f]{8}$/.test(f[2] || '')) continue;
    const ip = [6, 4, 2, 0].map((i) => parseInt(f[2].slice(i, i + 2), 16)).join('.');
    if (privateV4(ip)) return ip;
  }
  return null;
}
/** Where the host's Caddy is: PROXYPILOT_LOCAL_EDGE (127.x or a private IPv4), the Docker bridge gateway inside the container, else 127.0.0.1. */
export function localEdgeAddress(env = process.env, { docker = inDocker(env), gateway = () => defaultGateway() } = {}) {
  const v = String(env.PROXYPILOT_LOCAL_EDGE || '').trim();
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v) || privateV4(v)) return v;
  return (docker && gateway()) || '127.0.0.1';
}
/** The container's own private IPv4 networks (CIDR), as Caddy sees its requests. */
export function containerSources(ifaces = networkInterfaces()) {
  const out = [];
  for (const list of Object.values(ifaces || {})) for (const i of list || []) {
    if (i.internal || i.family !== 'IPv4' && i.family !== 4 || !privateV4(i.address) || !/^\d+\.\d+\.\d+\.\d+\/\d{1,2}$/.test(i.cidr || '')) continue;
    const [addr, bits] = i.cidr.split('/'); if (+bits < 8) continue;
    out.push(`${addr}/32`);
  }
  return [...new Set(out)].sort();
}
/** Record (backend boot, inside Docker) the addresses the renderer admits with the header. → { changed, sources } */
export function recordSelfCheckSources(db, { docker = inDocker(), ifaces } = {}) {
  if (!db || !hasSettings(db)) return { changed: false, sources: [] };
  const sources = docker ? containerSources(ifaces) : [];
  const before = db.prepare('SELECT value FROM app_settings WHERE key=?').get(SELF_CHECK_SOURCES_SETTING)?.value || '[]';
  const value = JSON.stringify(sources);
  if (before !== value) db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(SELF_CHECK_SOURCES_SETTING, value);
  return { changed: before !== value, sources };
}
/** Loopback plus the recorded container addresses (each a private /32). */
export function selfCheckSources(db) {
  let extra = [];
  try { extra = JSON.parse(db?.prepare('SELECT value FROM app_settings WHERE key=?').get(SELF_CHECK_SOURCES_SETTING)?.value || '[]'); } catch { extra = []; }
  extra = (Array.isArray(extra) ? extra : []).filter((c) => /^\d+\.\d+\.\d+\.\d+\/32$/.test(c) && privateV4(c.slice(0, -3)));
  return [...LOOPBACK_SOURCES, ...extra];
}

const hasSettings = (db) => { try { return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='app_settings'").get(); } catch { return false; } };

/** The installation's self-check token; created on first use. */
export function selfCheckToken(db, { create = true } = {}) {
  if (!db || !hasSettings(db)) return null;
  const row = db.prepare('SELECT value FROM app_settings WHERE key=?').get(SELF_CHECK_SETTING);
  if (row?.value && /^[a-f0-9]{48}$/.test(row.value)) return row.value;
  if (!create) return null;
  const token = randomBytes(24).toString('hex');
  db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(SELF_CHECK_SETTING, token);
  return token;
}

/** What an adapter's HTTP client needs to reach its own route through the local Caddy. */
export function localEdge(db, env = process.env) {
  return { address: localEdgeAddress(env), headers: { [SELF_CHECK_HEADER]: selfCheckToken(db) } };
}

// Route ids the Full Platform service adapters own. Only these get the
// self-check exception; every other restricted route is unchanged.
const OWNED_ROUTE = /^(?:(?:keycloak|infisical|openbao|vaultwarden)-route-[A-Za-z0-9_-]+|pomerium-auth-route|proxypilot-local-recovery)$/;
export const isPlatformOwnedRoute = (routeId) => OWNED_ROUTE.test(String(routeId || ''));

/** The renderer's view: the token for an owned platform route, else null. */
export function selfCheckForRoute(db, routeId) {
  if (!isPlatformOwnedRoute(routeId)) return null;
  try { return selfCheckToken(db); } catch { return null; }
}
