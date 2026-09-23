// Which hostnames and routes belong to the Full Platform service adapters.
//
// An owned platform route is created by its service adapter; a hand-made
// route on the same hostname blocks the adapter from creating its own. So
// set_route / set_route_path (MCP) and the Routes page's create/edit (UI)
// refuse any hostname in the saved Full Platform plan, and the Routes page
// lists the owned routes read-only, labelled with their service.
//
// Reads setup_full_platform directly (no store import): routes/services.js
// imports this, and pulling the platform stores into its load order would
// reorder module evaluation for every route.

const NAMES = { keycloak: 'Keycloak', pomerium: 'Pomerium', infisical: 'Infisical', openbao: 'OpenBao', vaultwarden: 'Vaultwarden', recovery: 'ProxyPilot recovery route' };
const has = (db, t) => { try { return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t); } catch { return false; } };
const host = (url) => { try { return new URL(url).hostname.toLowerCase(); } catch { return null; } };

/** { hostname: { service, name } } for every hostname in the saved plan (not the ProxyPilot admin hostname). */
export function platformHostnames(db) {
  if (!db || !has(db, 'setup_full_platform')) return {};
  const row = db.prepare('SELECT config_json FROM setup_full_platform WHERE id=1').get();
  if (!row) return {};
  let c; try { c = JSON.parse(row.config_json); } catch { return {}; }
  const out = {};
  const r = host(c.recoveryOrigin); if (r) out[r] = { service: 'recovery', name: NAMES.recovery };
  for (const [id, s] of Object.entries(c.services || {})) { const h = s?.mode !== 'skip' ? host(s?.url) : null; if (h) out[h] = { service: id, name: NAMES[id] || id }; }
  return out;
}

/** The service that owns a route/service row, by the ids the adapters write. */
export function platformOwnerOfRoute(routeId, serviceId = null) {
  const id = String(routeId || ''), sid = String(serviceId || '');
  let m = /^(keycloak|infisical|openbao|vaultwarden)-route-/.exec(id) || /^(keycloak|infisical|openbao|vaultwarden)-(?:kc-)?[A-Za-z0-9_-]+$/.exec(sid);
  if (m) return { service: m[1], name: NAMES[m[1]] };
  if (id === 'pomerium-auth-route' || sid === 'pomerium-auth') return { service: 'pomerium', name: NAMES.pomerium };
  if (id === 'proxypilot-local-recovery' || sid === 'proxypilot-local-recovery') return { service: 'recovery', name: NAMES.recovery };
  return null;
}

export const platformPanelLink = (service) => `/platform-setup?panel=${encodeURIComponent(service)}`;

/** The refusal for creating/editing a route on a platform hostname or an owned platform route. */
export function platformRouteRefusal(db, { hostname = null, routeId = null, serviceId = null } = {}) {
  const h = hostname ? String(hostname).trim().toLowerCase() : null;
  const byHost = h ? platformHostnames(db)[h] : null;
  const byRow = platformOwnerOfRoute(routeId, serviceId);
  const owner = byHost || byRow;
  if (!owner) return null;
  return { code: 'PLATFORM_OWNED_HOSTNAME', service: owner.service, link: platformPanelLink(owner.service),
    error: `${h || 'This route'} belongs to the saved Full Platform plan (${owner.name}). The ${owner.name} service adapter creates and owns that route; a hand-made route on the same hostname would block the adapter from creating its own. Manage it from Platform Setup → Platform overview → ${owner.name}.` };
}
