// Mock2 boot reconcile — re-publish the Caddy site files for every enabled
// parent domain after a backend restart, mirroring the l4-reconciler boot
// pattern. On a disabled/pinned host this is never imported (ADR-001), so no
// Mock2 Caddy file is ever written there.
//
// M1 published a header-only file per enabled domain (no slugs yet). M2
// computes each domain's REAL active-FQDN set — every project's current slug,
// plus any rotation-grace slugs still inside their window, each pointing at the
// container's bridge upstream (publish.js / project-logic.projectActiveFqdns).
// Rewriting the file at boot re-asserts the `import /etc/caddy/mock2/*.caddy`
// line and restores every live route after a restart. Non-fatal: a reconcile
// failure logs and leaves the running Caddy config alone.
//
// Note: container_ip is cached on the row (migration 504). After a host
// reboot the shared-bridge DHCP lease may hand a project a new IP; refreshing
// that cache from `incus list` is the idle-stop/restart concern of a later
// phase — M2 republishes from the last-known upstream, which is correct for a
// plain backend restart (the containers kept their addresses).

import { listParentDomains } from './domains.js';
import { isSelectable } from './domain-logic.js';
import { publishDomain } from './publish.js';

export async function reconcileMock2Domains() {
  let enabled = [];
  try {
    enabled = listParentDomains().filter(isSelectable);
  } catch (err) {
    console.error('[mock2] domain reconcile: could not read domains:', err?.message);
    return;
  }
  if (enabled.length === 0) return; // nothing to publish — don't touch Caddy.

  let ok = 0;
  for (const row of enabled) {
    try {
      const r = await publishDomain(row.id);
      if (r.ok) ok += 1;
      else console.error(`[mock2] domain reconcile: caddy reload failed for ${row.domain}:`, r.error);
    } catch (err) {
      console.error(`[mock2] domain reconcile: failed publishing ${row.domain}:`, err?.message);
    }
  }
  console.log(`[mock2] domain reconcile: published ${ok}/${enabled.length} enabled domain(s) with active slugs`);
}
