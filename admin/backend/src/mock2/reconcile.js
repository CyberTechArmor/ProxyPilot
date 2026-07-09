// Mock2 boot reconcile (Phase M1) — re-publish the Caddy site files for every
// enabled parent domain after a backend restart, mirroring the l4-reconciler
// boot pattern. On a disabled/pinned host this is never imported (ADR-001), so
// no Mock2 Caddy file is ever written there.
//
// In M1 an enabled domain has no project slugs yet (M2), so each file is the
// steady-state header-only shape; the value of running it at boot is that the
// `import /etc/caddy/mock2/*.caddy` line is (re)asserted and the directory
// exists, so M2's first slug write lands in an already-wired tree. Non-fatal:
// a reconcile failure logs and leaves the running Caddy config alone.

import { listParentDomains } from './domains.js';
import { isSelectable } from './domain-logic.js';
import { writeMock2DomainSite, reloadMock2Caddy } from './caddy.js';

export async function reconcileMock2Domains() {
  let enabled = [];
  try {
    enabled = listParentDomains().filter(isSelectable);
  } catch (err) {
    console.error('[mock2] domain reconcile: could not read domains:', err?.message);
    return;
  }
  if (enabled.length === 0) return; // nothing to publish — don't touch Caddy.

  for (const row of enabled) {
    try {
      // No project slugs in M1 → steady-state file. M2 passes the domain's
      // active FQDNs here instead of [].
      await writeMock2DomainSite(row.domain, []);
    } catch (err) {
      console.error(`[mock2] domain reconcile: failed writing ${row.domain}:`, err?.message);
    }
  }

  try {
    const r = await reloadMock2Caddy();
    if (!r.ok) console.error(`[mock2] domain reconcile: caddy reload failed (${r.stage}):`, r.error);
    else console.log(`[mock2] domain reconcile: published ${enabled.length} enabled domain(s)`);
  } catch (err) {
    console.error('[mock2] domain reconcile: caddy reload threw:', err?.message);
  }
}
