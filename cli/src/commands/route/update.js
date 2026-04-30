import { getDb } from '../../db/index.js';
import { audit } from '../../db/audit.js';
import { reconcileVpnRoutes } from '../../caddy/reconcile.js';
import * as output from '../../output.js';

const SERVICE_TAG_RE = /^[A-Za-z0-9_.-]{1,64}$/;

function parseBoolFlag(v) {
  // commander emits boolean for switch flags but a string when an
  // explicit value is provided (--vpn-only true). Normalize.
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'boolean') return v;
  if (v === 'true' || v === '1' || v === 'yes') return true;
  if (v === 'false' || v === '0' || v === 'no') return false;
  return undefined;
}

/**
 * Update an existing route's vpn-only flag and/or service tag.
 * Writes the SQLite mutation + audit row, then triggers a Caddy
 * reconcile so the rendered site file converges on the new state.
 *
 * Reconcile sequencing: the mutation lands in SQLite first; the
 * Caddy reconcile follows. If reconcile fails (Caddy down,
 * site-file write error) the SQLite row is already durable —
 * operator can re-run `proxypilot route reconcile` to converge.
 *
 * Audit action: route.update. before/after carries vpn_only +
 * service so the dashboard can render the diff.
 */
export async function routeUpdateCommand(domain, opts, globalOpts) {
  const actor = process.env.SUDO_USER ?? process.env.USER ?? null;
  const vpnOnly = parseBoolFlag(opts.vpnOnly);
  const service = opts.service;

  if (vpnOnly === undefined && service === undefined) {
    const msg = 'route update: at least one of --vpn-only / --no-vpn-only / --service / --service "" required';
    if (globalOpts.json) {
      output.json({ ok: false, error: msg });
      process.exitCode = 1;
      return;
    }
    output.error(msg);
    process.exitCode = 1;
    return;
  }

  if (service !== undefined && service !== '' && !SERVICE_TAG_RE.test(service)) {
    const msg = `invalid service tag "${service}": must match ${SERVICE_TAG_RE}`;
    if (globalOpts.json) {
      output.json({ ok: false, error: msg });
      process.exitCode = 1;
      return;
    }
    output.error(msg);
    process.exitCode = 1;
    return;
  }

  const db = getDb();
  const route = db.prepare('SELECT id, domain, vpn_only, service FROM routes WHERE domain = ?').get(domain);
  if (!route) {
    const msg = `no route with domain "${domain}"`;
    if (globalOpts.json) {
      output.json({ ok: false, error: msg, code: 'NOT_FOUND' });
      process.exitCode = 1;
      return;
    }
    output.error(msg);
    process.exitCode = 1;
    return;
  }

  const before = { vpn_only: !!route.vpn_only, service: route.service ?? null };
  const after = {
    vpn_only: vpnOnly === undefined ? !!route.vpn_only : !!vpnOnly,
    service:
      service === undefined ? (route.service ?? null) :
      service === ''        ? null :
      service,
  };

  // Warn (not error) when --service is set on a route that's NOT
  // vpn-only. The tag is only consulted when vpn_only=1, but
  // allowing a tag on a public route lets the operator preset it
  // before flipping the flag. Same posture as the firewall-side
  // service-tag plumbing in step 7a/5.
  const warnings = [];
  if (after.service && !after.vpn_only) {
    warnings.push(
      `service tag "${after.service}" set on route ${domain} which has vpn_only=0; ` +
      `tag is only consulted when the route is vpn-only`,
    );
  }

  db.prepare(`
    UPDATE routes SET vpn_only = ?, service = ?, updated_at = datetime('now') WHERE id = ?
  `).run(after.vpn_only ? 1 : 0, after.service, route.id);

  audit({
    subsystem: 'caddy',
    action: 'route.update',
    resource: domain,
    actor,
    before,
    after,
  });

  // Trigger reconcile so the new vpn-only / service state lands in
  // the Caddy site file. We always reconcile — turning vpn-only OFF
  // also requires re-rendering (drops the matcher).
  let reconcile;
  try {
    reconcile = await reconcileVpnRoutes({ actor });
  } catch (e) {
    reconcile = { ok: false, warnings: [`reconcile threw: ${e.message}`] };
  }

  if (globalOpts.json) {
    output.json({
      ok: reconcile.ok && warnings.length === 0,
      domain,
      before,
      after,
      warnings: [...warnings, ...(reconcile.warnings ?? [])],
      reconcile,
    });
    if (!reconcile.ok) process.exitCode = 1;
    return;
  }

  for (const w of warnings) output.warn(w);
  for (const w of (reconcile.warnings ?? [])) output.warn(w);
  output.success(
    `route "${domain}" vpn_only: ${before.vpn_only} → ${after.vpn_only}, ` +
    `service: ${before.service ?? '(none)'} → ${after.service ?? '(none)'}`,
  );
  if (reconcile.reload === 'skipped') {
    output.info('caddy reload skipped (no vpn-only routes remain)');
  } else if (reconcile.reload === 'reloaded') {
    output.info(`caddy reloaded (${reconcile.routeCount} vpn-only route(s))`);
  } else {
    output.error(`caddy reload failed — re-run \`proxypilot route reconcile\` to retry`);
    process.exitCode = 1;
  }
}
