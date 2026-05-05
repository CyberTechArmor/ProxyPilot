// Startup-time L4 forward reconciler.
//
// Why this exists
// ───────────────
// The dashboard backend used to only call reconcileServiceL4Forwards
// in response to operator action (Quick add MEET, Add forward in the
// LXC detail panel, the firewall page). That left a real failure
// mode: when the host reboots, Incus's proxy daemon can fail to bind
// large UDP ranges if any port inside the range is already held by
// an ephemeral socket opened earlier in boot. The forward row is
// still in the DB, but the live device is gone, the firewall rule is
// gone, and nobody notices until a meeting fails.
//
// The companion sysctl reservation in lib/l4-reserved-ports.js stops
// the underlying conflict from happening on FUTURE reboots once
// it's been written. This module addresses the recovery side: on
// every backend boot, walk every service that has L4 forwards and
// re-reconcile so any device that disappeared comes back without
// operator intervention.
//
// Cost: a few `incus config device show` invocations and at most one
// `incus config device add` per stale forward. Idempotent — applying
// already-correct state is a no-op at the Incus layer (`device add`
// returns "already exists" which the reconciler treats as success).

import { reconcileServiceL4Forwards } from './l4-reconciler.js';

/**
 * Reconcile L4 forwards for every service that has at least one
 * enabled forward. Logs progress to stdout so operators can see in
 * docker-compose logs what was healed.
 *
 * Errors per-service are caught and logged but don't propagate —
 * one container being down shouldn't block recovery for the rest.
 *
 * @param {object} opts
 * @param {import('better-sqlite3').Database} opts.db
 * @returns {Promise<{services:number, applied:number, removed:number, errors:Array<{service:string,error:string}>}>}
 */
export async function reconcileAllServiceL4Forwards({ db, log = console.log, errLog = console.error }) {
  if (!db) throw new Error('reconcileAllServiceL4Forwards: db is required');

  // Group enabled forwards by their owning service so we issue one
  // reconcile per LXC (each call lists Incus devices for that LXC,
  // and we don't want to do that N-per-forward times).
  const services = db
    .prepare(
      `SELECT DISTINCT s.id, s.lxc_container_name, s.target_ip, s.name
         FROM services s
         JOIN service_l4_forwards f ON f.service_id = s.id
        WHERE f.enabled = 1
          AND s.lxc_container_name IS NOT NULL
          AND s.lxc_container_name <> ''`
    )
    .all();

  if (services.length === 0) {
    return { services: 0, applied: 0, removed: 0, errors: [] };
  }

  log(`[L4-startup] reconciling ${services.length} service(s) with L4 forwards`);

  let appliedCount = 0;
  let removedCount = 0;
  const errors = [];

  for (const svc of services) {
    if (!svc.target_ip) {
      // No cached IP — skip rather than fail. The user-driven path
      // through Quick add MEET / refresh-ip will populate it later
      // and re-trigger a reconcile.
      log(`[L4-startup] ${svc.lxc_container_name}: skipped (no target_ip cached)`);
      continue;
    }
    try {
      const result = await reconcileServiceL4Forwards({
        db,
        serviceId: svc.id,
        lxcName: svc.lxc_container_name,
        bridgeIp: svc.target_ip,
        serviceTag: svc.lxc_container_name,
      });
      const outcomes = (result && result.applied) || [];
      let svcApplied = 0;
      let svcRemoved = 0;
      const svcErrors = [];
      for (const o of outcomes) {
        if (o.status === 'applied' || o.status === 'present') svcApplied++;
        else if (o.status === 'removed') svcRemoved++;
        else if (o.status === 'error') svcErrors.push(`${o.id}: ${o.error || 'unknown'}`);
      }
      appliedCount += svcApplied;
      removedCount += svcRemoved;
      if (svcErrors.length > 0) {
        errors.push({ service: svc.lxc_container_name, error: svcErrors.join('; ') });
        errLog(`[L4-startup] ${svc.lxc_container_name}: ${svcErrors.length} forward(s) errored: ${svcErrors.join('; ')}`);
      } else {
        log(`[L4-startup] ${svc.lxc_container_name}: ${svcApplied} applied, ${svcRemoved} removed`);
      }
      if (result && result.reservedPorts && result.reservedPorts.error) {
        errLog(`[L4-startup] ${svc.lxc_container_name}: reserved-ports sysctl: ${result.reservedPorts.error}`);
      }
    } catch (e) {
      errors.push({ service: svc.lxc_container_name, error: e.message });
      errLog(`[L4-startup] ${svc.lxc_container_name}: reconcile threw: ${e.message}`);
    }
  }

  return {
    services: services.length,
    applied: appliedCount,
    removed: removedCount,
    errors,
  };
}
