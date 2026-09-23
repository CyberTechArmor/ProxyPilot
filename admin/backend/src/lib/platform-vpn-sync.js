// Built-in VPN networks → the platform's restricted allowlist.
//
// The VPN configuration lives in the host CLI's database (vpn_config.cidr),
// not in the backend's, so it is read through `proxypilot --json vpn status`
// (vpn-startup.js callProxypilot, nsenter-aware). refreshVpnNetworks records
// the observed ranges and, when the applied allowlist no longer matches
// (the VPN subnet changed, it was enabled or disabled, or this is the first
// observation on an existing install), queues the reviewed
// update_platform_networks step, which re-renders every restricted route.
// Called at boot, on an interval, and right after the VPN enable/disable
// routes. An unreadable status changes nothing.

import { getDb, logAudit } from '../db.js';
import { refreshVpnNetworks } from './setup-engine/full-platform-networks.js';
import { callProxypilot } from './vpn-startup.js';

export async function syncPlatformVpnNetworks({ reason = 'interval', readStatus = () => callProxypilot(['vpn', 'status']) } = {}) {
  const db = getDb();
  const out = await refreshVpnNetworks(db, { readStatus });
  if (out.changed || out.queued) {
    logAudit(null, 'PLATFORM_VPN_NETWORKS_FOLLOWED', 'setup_full_platform', '1', { reason, before: out.before ?? null, after: out.observed, job_id: out.queued?.job?.id || null }, null);
  }
  if (out.queued) {
    try { const { drainBackendStepsNow } = await import('../mock2/ops.js'); await drainBackendStepsNow?.(); } catch { /* the periodic drain picks it up */ }
  }
  return out;
}
