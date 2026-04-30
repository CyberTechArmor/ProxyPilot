import { readState } from '../../core/firewall/index.js';
import { getDb } from '../../db/index.js';
import * as output from '../../output.js';

export async function statusCommand(opts, globalOpts) {
  const state = readState();
  const db = getDb();
  const lastReconcile = db.prepare(`
    SELECT ruleset_checksum, rule_count, applied, rejection_reason, reconciled_at
    FROM firewall_reconciles
    ORDER BY id DESC
    LIMIT 1
  `).get();

  const enabledBase = state.base.filter(r => r.enabled).length;
  const enabledDiscovered = state.discovered.filter(r => r.enabled).length;
  const needsReview = state.discovered.filter(r => !r.enabled).length;

  if (globalOpts.json) {
    output.json({
      backend: 'nftables',
      table: 'inet/proxypilot',
      default_policy: state.default_policy,
      panic_close: state.panic_close,
      enabled_base: enabledBase,
      enabled_discovered: enabledDiscovered,
      needs_review: needsReview,
      last_reconcile: lastReconcile ?? null,
    });
    return;
  }

  output.info(`Backend          nftables (table inet/proxypilot)`);
  output.info(`Default policy   ${state.default_policy}`);
  output.info(`Panic-close      ${state.panic_close ? 'YES' : 'no'}`);
  output.info(`Enabled (base)         ${enabledBase}`);
  output.info(`Enabled (discovered)   ${enabledDiscovered}`);
  output.info(`Needs review           ${needsReview}`);
  if (lastReconcile) {
    const status = lastReconcile.applied ? 'applied' : `rejected (${lastReconcile.rejection_reason ?? '?'})`;
    output.info(`Last reconcile   ${lastReconcile.reconciled_at} — ${status}`);
    output.info(`                 ${lastReconcile.ruleset_checksum} (${lastReconcile.rule_count} rules)`);
  } else {
    output.warn(`Last reconcile   (never run)`);
  }
}
