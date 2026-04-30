import path from 'node:path';
import { getDb } from '../db/index.js';
import { audit } from '../db/audit.js';
import { atomicWrite } from '../core/vpn/server.js';
import { renderRoute } from './render.js';
import { reloadCaddy } from './client.js';

const CADDY_SITES_DIR = '/etc/caddy/sites';

/**
 * Re-render every vpn_only route's site file with the current
 * enabled-peer set, atomic-write each, and trigger a single Caddy
 * reload at the end. Idempotent: identical (routes × peers) input
 * produces identical site files. Public (non-vpn-only) routes are
 * untouched; the existing imperative addRoute / removeRoute path
 * keeps owning their lifecycle until a future refactor.
 *
 * Invoked from every peer mutation (addPeer, rotatePeer,
 * enablePeer, disablePeer, removePeer, setPeerScope) AFTER the
 * firewall reconcile completes — the firewall is the security
 * boundary, so we land L4 first and L7 second. If Caddy reload
 * fails we surface the error but do NOT roll back the firewall:
 * a stale Caddy matcher is recoverable (re-run reconcileVpnRoutes)
 * while undoing the firewall would re-open already-closed paths.
 *
 * Audit: one `caddy.reconcile` row per call, with the rendered
 * route count and reload status. Aligns with firewall reconcile's
 * audit shape so the dashboard can present a unified history.
 */
export async function reconcileVpnRoutes({ actor } = {}) {
  const db = getDb();

  const routes = db.prepare(`
    SELECT id, domain, upstream_address, path_prefix, tls_auto, vpn_only, service, enabled
    FROM routes
    WHERE vpn_only = 1 AND enabled = 1
    ORDER BY id
  `).all();

  // Empty case: nothing to render. Still safe to reload Caddy
  // (no-op) but skipping the reload avoids an unnecessary syscall
  // when no vpn_only routes exist on the host.
  if (routes.length === 0) {
    audit({
      subsystem: 'caddy',
      action: 'reconcile',
      resource: 'vpn-routes',
      actor,
      after: { route_count: 0, reload: 'skipped' },
    });
    return { ok: true, routeCount: 0, reload: 'skipped', warnings: [] };
  }

  const peers = db.prepare(`
    SELECT name, allowed_ip, scope, scope_services_json
    FROM vpn_peers
    WHERE status = 'enabled'
  `).all();

  const warnings = [];
  const written = [];
  for (const route of routes) {
    const body = renderRoute(route, peers);
    const target = path.join(CADDY_SITES_DIR, route.domain);
    try {
      // Reuse the same atomicWrite helper the wg0.conf and firewall
      // ruleset paths use: tmp.<pid>.<ts> + chmod + rename, with
      // flag: 'wx' so a stale tmp from a crashed prior run never
      // gets inherited. mode 0644 — Caddy reads as its service
      // user, no secrets in the site file (peer keys are private
      // to the peer, never in routes).
      atomicWrite(target, body, 0o644);
      written.push(route.domain);
    } catch (e) {
      warnings.push(
        `failed to write ${target}: ${e.message} — Caddy reload may pick up stale config for this route`,
      );
    }
  }

  let reloadStatus = 'reloaded';
  try {
    await reloadCaddy();
  } catch (e) {
    reloadStatus = 'failed';
    warnings.push(
      `caddy reload failed: ${e.message} — re-run \`proxypilot route reconcile\` ` +
      `or restart caddy manually. Firewall L4 is unaffected.`,
    );
  }

  audit({
    subsystem: 'caddy',
    action: 'reconcile',
    resource: 'vpn-routes',
    actor,
    after: {
      route_count: routes.length,
      written: written.length,
      reload: reloadStatus,
    },
  });

  return {
    ok: reloadStatus === 'reloaded' && warnings.length === 0,
    routeCount: routes.length,
    written: written.length,
    reload: reloadStatus,
    warnings,
  };
}
