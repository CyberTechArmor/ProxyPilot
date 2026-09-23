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

export const SELF_CHECK_HEADER = 'X-ProxyPilot-Self-Check';
export const SELF_CHECK_SETTING = 'platform_self_check_token';
export const LOOPBACK_SOURCES = Object.freeze(['127.0.0.1/32', '::1/128']);

/** Where the host's Caddy listens for the runner. PROXYPILOT_LOCAL_EDGE overrides 127.0.0.1 (IPv4 only). */
export function localEdgeAddress(env = process.env) {
  const v = String(env.PROXYPILOT_LOCAL_EDGE || '').trim();
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v) ? v : '127.0.0.1';
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
