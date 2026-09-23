// VPN DNS names — which hostnames the VPN resolver (proxypilot-vpn-dns on
// 10.100.0.1, cli/src/core/vpn/dns.js) answers with the VPN server address, so
// VPN peers reach them THROUGH the tunnel and Caddy sees 10.100.0.x.
//
//   managed  the Full Platform hostnames (ProxyPilot, recovery and the five
//            services), derived from the saved plan — not editable. A
//            hostname whose route carries an allowlist WITHOUT the VPN
//            networks is left out (sending it through the tunnel would lock
//            VPN users out of it) and reported in `skipped` with the reason.
//   extra    the operator's own domains (exact hostnames or *.suffix) served
//            by this host's Caddy — app_settings `platform.vpn_dns_extra`.
//
// The backend runs in a container without the CLI source, so the list is
// pushed to the host with `proxypilot --json vpn dns set` (lib/platform-vpn-sync.js).

import { vpnNetworks } from './platform-networks.js';

export const VPN_DNS_EXTRA_KEY = 'platform.vpn_dns_extra';
export const VPN_DNS_PUSH_KEY = 'platform.vpn_dns_pushed';
export const VPN_DNS_ADDRESS = '10.100.0.1';
const HOSTNAME_RE = /^(\*\.)?(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
const has = (db, t) => !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
const setting = (db, key) => (has(db, 'app_settings') ? db.prepare('SELECT value FROM app_settings WHERE key=?').get(key)?.value ?? null : null);
const json = (v, d) => { try { return v == null ? d : JSON.parse(v); } catch { return d; } };

/** Lower-case, trim, de-duplicate; throws on an entry that is not a hostname or *.suffix. */
export function normalizeDnsNames(list) {
  if (!Array.isArray(list)) throw Object.assign(new Error('VPN DNS names must be a list of hostnames.'), { status: 400 });
  const out = [];
  for (const raw of list) {
    const n = String(raw).trim().toLowerCase().replace(/\.$/, '');
    if (!n) continue;
    if (!HOSTNAME_RE.test(n)) throw Object.assign(new Error(`"${raw}" is not a hostname (use host.example.com or *.example.com).`), { status: 400 });
    if (!out.includes(n)) out.push(n);
  }
  if (out.length > 100) throw Object.assign(new Error('At most 100 VPN DNS names.'), { status: 400 });
  return out;
}

export const vpnDnsExtra = (db) => { try { return normalizeDnsNames(json(setting(db, VPN_DNS_EXTRA_KEY), [])); } catch { return []; } };
export function setVpnDnsExtra(db, list) {
  const next = normalizeDnsNames(list);
  db.prepare('INSERT INTO app_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(VPN_DNS_EXTRA_KEY, JSON.stringify(next));
  return next;
}

/** Does every route on this hostname admit VPN sources? (no allowlist, or one that contains a VPN network) */
function routeAdmitsVpn(db, hostname, vpn) {
  if (!has(db, 'service_http_routes')) return { ok: true };
  const cols = db.prepare('PRAGMA table_info(service_http_routes)').all().map((c) => c.name);
  if (!cols.includes('ip_allowlist_json')) return { ok: true };
  for (const r of db.prepare('SELECT id, ip_allowlist_json FROM service_http_routes WHERE domain=?').all(hostname)) {
    const list = json(r.ip_allowlist_json, null);
    if (Array.isArray(list) && list.length && !list.some((n) => vpn.includes(n))) return { ok: false, reason: `route ${r.id} admits only ${list.join(', ')} — not the VPN networks; through the tunnel it would refuse VPN users` };
  }
  return { ok: true };
}

/** The Full Platform hostnames to send through the tunnel, and the ones left out with why. */
export function vpnDnsManaged(db) {
  const row = has(db, 'setup_full_platform') ? db.prepare('SELECT config_json FROM setup_full_platform WHERE id=1').get() : null;
  const config = json(row?.config_json, null);
  if (!config) return { managed: [], skipped: [] };
  const vpn = vpnNetworks(db);
  const hosts = [config.publicOrigin, config.recoveryOrigin, ...Object.values(config.services || {}).map((s) => s?.url)]
    .filter(Boolean).map((u) => { try { return new URL(u).hostname.toLowerCase(); } catch { return null; } }).filter(Boolean);
  const managed = [], skipped = [];
  for (const h of [...new Set(hosts)]) {
    const v = routeAdmitsVpn(db, h, vpn);
    if (v.ok) managed.push(h); else skipped.push({ name: h, reason: v.reason });
  }
  return { managed, skipped };
}

/** What the dashboard and get_platform_setup show. */
export function vpnDnsView(db) {
  const { managed, skipped } = vpnDnsManaged(db);
  const pushed = json(setting(db, VPN_DNS_PUSH_KEY), null);
  return {
    address: VPN_DNS_ADDRESS, managed, extra: vpnDnsExtra(db), skipped,
    pushed: pushed ? { at: pushed.at, ok: !!pushed.ok, error: pushed.error || null, in_sync: !!pushed.ok && JSON.stringify(pushed.managed) === JSON.stringify(managed) && JSON.stringify(pushed.extra) === JSON.stringify(vpnDnsExtra(db)) } : null,
    peer_config: `Peer configs issued now carry "DNS = ${VPN_DNS_ADDRESS}". Add that line under [Interface] in configs issued earlier.`,
  };
}

export function recordVpnDnsPush(db, { ok, error = null, managed, extra }) {
  db.prepare('INSERT INTO app_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(VPN_DNS_PUSH_KEY, JSON.stringify({ at: new Date().toISOString(), ok, error, managed, extra }));
}
