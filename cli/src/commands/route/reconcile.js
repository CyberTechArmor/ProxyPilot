import { reconcileVpnRoutes } from '../../caddy/reconcile.js';
import * as output from '../../output.js';

/**
 * Manually re-render every vpn-only route's site file and reload
 * Caddy. Operators reach for this when:
 *   - a peer mutation's auto-reconcile failed and they fixed the
 *     underlying issue (Caddy was down, etc.),
 *   - they edited firewall.json or vpn_peers out-of-band and want
 *     L7 to catch up,
 *   - they suspect drift between SQLite and the rendered Caddyfiles.
 *
 * Idempotent: identical (routes × peers) input produces identical
 * site files. Audit row is written by the orchestrator.
 */
export async function routeReconcileCommand(opts, globalOpts) {
  const actor = process.env.SUDO_USER ?? process.env.USER ?? null;
  let result;
  try {
    result = await reconcileVpnRoutes({ actor });
  } catch (e) {
    if (globalOpts.json) {
      output.json({ ok: false, error: e.message });
      process.exitCode = 1;
      return;
    }
    output.error(`route reconcile failed: ${e.message}`);
    process.exitCode = 1;
    return;
  }

  if (globalOpts.json) {
    output.json({
      ok: result.ok,
      route_count: result.routeCount,
      written: result.written ?? 0,
      reload: result.reload,
      warnings: result.warnings ?? [],
    });
    if (!result.ok) process.exitCode = 1;
    return;
  }

  for (const w of (result.warnings ?? [])) output.warn(w);
  if (result.reload === 'skipped') {
    output.info('No vpn-only routes — Caddy reload skipped.');
    return;
  }
  if (result.reload === 'reloaded') {
    output.success(`Reconciled ${result.routeCount} vpn-only route(s) and reloaded Caddy.`);
    return;
  }
  output.error('Caddy reload failed — see warnings above.');
  process.exitCode = 1;
}
