import { z } from 'zod';
import { validateRouteEdgeOptions } from '../caddy-site-file.js';

// The same Caddy network validator serves guided recovery and service routes.
// Never widen a confirmed restriction when deriving a managed service route.
export const restrictedNetwork = z.string().max(50).refine(value => !/\/0$/.test(value) && !validateRouteEdgeOptions({ ip_allowlist: [value] }).error, 'Use an approved restricted IP address or CIDR.');

/* ------------------------- VPN ∪ additional networks ------------------------ */
//
// The effective allowlist for local recovery and every restricted platform
// route is (ProxyPilot's built-in VPN networks) ∪ (additional addresses).
//
//   * VPN networks are DERIVED from the VPN configuration (the host CLI's
//     vpn_config.cidr, read through `proxypilot --json vpn status`), recorded
//     here in app_settings by refreshVpnNetworks, never edited by a person, and
//     followed automatically when the VPN subnet changes (index.js interval
//     and the VPN enable/disable routes call the refresh).
//   * Additional addresses are the operator's convenience list, saved in the
//     Full Platform config as `additionalNetworks`.
// This module has no import from the Full Platform stores (it is imported by
// the per-service logic modules).

export const VPN_NETWORKS_KEY = 'platform.vpn_networks';
const has = (db, t) => !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);

/** The recorded VPN networks (possibly []). */
export function vpnNetworks(db) {
  if (!has(db, 'app_settings')) return [];
  try { const v = JSON.parse(db.prepare('SELECT value FROM app_settings WHERE key=?').get(VPN_NETWORKS_KEY)?.value || 'null'); return Array.isArray(v?.networks) ? v.networks : []; } catch { return []; }
}
export function vpnNetworksRecord(db) {
  if (!has(db, 'app_settings')) return null;
  try { return JSON.parse(db.prepare('SELECT value FROM app_settings WHERE key=?').get(VPN_NETWORKS_KEY)?.value || 'null'); } catch { return null; }
}

/** `proxypilot --json vpn status` → the VPN networks it implies. Disabled or unreadable → null (no claim). */
export function vpnFromStatus(status) {
  if (!status || status.ok === false) return null;
  if (!status.enabled) return [];
  const cidr = String(status.cidr || '').trim();
  return restrictedNetwork.safeParse(cidr).success ? [cidr] : null;
}

/** Record a newly observed VPN list. → { changed, before, after } */
export function recordVpnNetworks(db, networks, { nowIso = new Date().toISOString() } = {}) {
  const before = vpnNetworks(db), after = [...new Set(networks)];
  const changed = JSON.stringify(before) !== JSON.stringify(after) || !vpnNetworksRecord(db);
  db.prepare('INSERT INTO app_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(VPN_NETWORKS_KEY, JSON.stringify({ networks: after, observedAt: nowIso }));
  return { changed, before, after };
}

/** The operator's additional list from a saved config (legacy configs: their recoveryNetworks minus the VPN ranges). */
export function additionalOf(config, vpn = []) {
  if (Array.isArray(config?.additionalNetworks)) return config.additionalNetworks;
  return (config?.recoveryNetworks || []).filter((n) => !vpn.includes(n));
}

/** VPN first, then the additional addresses; duplicates dropped. */
export function effectiveNetworks(vpn, additional) {
  return [...new Set([...(vpn || []), ...(additional || [])].map((n) => String(n).trim()).filter(Boolean))];
}

/** The effective allowlist for a saved Full Platform config on this host. */
export function effectiveFor(db, config) {
  const vpn = vpnNetworks(db);
  return effectiveNetworks(vpn, additionalOf(config, vpn));
}
