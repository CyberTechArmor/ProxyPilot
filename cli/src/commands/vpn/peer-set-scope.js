import { setPeerScope } from '../../core/vpn/index.js';
import { reconcile as fwReconcile } from '../../core/firewall/index.js';
import * as output from '../../output.js';

const TYPED_PHRASE = 'demote the last admin peer';

function parseServices(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  return String(raw)
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

/**
 * Update a peer's scope (full | admin | services [--services <list>]).
 * Persists the SQLite mutation, then reconciles the firewall so any
 * vpn-only rule's per-/32 source set picks up the new shape on the
 * same call. Reconcile is the single L4 mutation point; we never
 * touch nft directly here.
 *
 * Lockout gate (LAST_FULL_ADMIN_DEMOTE) refuses to demote the only
 * enabled full|admin peer to scope=services when any vpn-only rule
 * lacks a service tag. --force escapes the gate but only after a
 * typed phrase distinct from peer.disable's "I understand this locks
 * everyone out" and peer.remove's "remove this active peer".
 */
export async function peerSetScopeCommand(name, scope, opts, globalOpts) {
  const services = parseServices(opts.services);
  const actor = process.env.SUDO_USER ?? process.env.USER ?? null;

  try {
    let result;
    try {
      result = setPeerScope({ name, scope, services, force: false, actor });
    } catch (e) {
      if (e.code !== 'LAST_FULL_ADMIN_DEMOTE') throw e;
      if (!opts.force) {
        if (globalOpts.json) {
          output.json({
            ok: false,
            error: e.message,
            code: e.code,
            untagged_rules: e.untaggedRules ?? [],
          });
          process.exitCode = 1;
          return;
        }
        output.error(e.message);
        if (e.untaggedRules?.length) {
          for (const id of e.untaggedRules) output.warn(`  untagged vpn-only rule: ${id}`);
        }
        process.exitCode = 1;
        return;
      }
      if (globalOpts.json) {
        // No interactive prompt over JSON — refuse and tell the caller
        // to re-run interactively. Same posture as peer.disable.
        output.json({
          ok: false,
          error: e.message,
          code: e.code,
          requires_typed_confirm: true,
          untagged_rules: e.untaggedRules ?? [],
        });
        process.exitCode = 1;
        return;
      }
      const banner =
        `Demoting "${name}" to scope=services would leave ${e.untaggedRules?.length ?? '?'} ` +
        `vpn-only rule(s) with no admin peer to reach them.`;
      const ok = await output.confirmTyped(banner, TYPED_PHRASE);
      if (!ok) {
        output.error('typed confirmation did not match — aborting');
        process.exitCode = 1;
        return;
      }
      result = setPeerScope({ name, scope, services, force: true, actor });
    }

    // Reconcile L4 so the new /32 set lands in the live nft ruleset.
    // We pass actor through so the audit trail attributes the
    // resulting firewall_reconciles row to the same operator.
    const fw = await fwReconcile({ actor });

    if (globalOpts.json) {
      output.json({
        ok: true,
        name: result.name,
        ip: result.ip,
        before: result.before,
        after: result.after,
        firewall: {
          ok: fw.ok,
          checksum: fw.checksum ?? null,
          warnings: fw.warnings ?? [],
          rejection: fw.rejection ?? null,
        },
      });
      return;
    }
    output.success(
      `peer "${name}" scope: ${result.before.scope}` +
      (result.before.services ? `(${result.before.services.join(',')})` : '') +
      ` → ${result.after.scope}` +
      (result.after.services ? `(${result.after.services.join(',')})` : ''),
    );
    for (const w of (fw.warnings ?? [])) output.warn(w);
    if (!fw.ok) {
      output.error(`firewall reconcile failed: ${fw.rejection?.reason ?? 'unknown'}`);
      process.exitCode = 1;
      return;
    }
    output.info(`firewall reconciled (${fw.ruleCount} enabled rules, ${fw.checksum})`);
  } catch (e) {
    if (globalOpts.json) {
      output.json({ ok: false, error: e.message, code: e.code ?? null });
      process.exitCode = 1;
      return;
    }
    output.error(`vpn peer set-scope failed: ${e.message}`);
    process.exitCode = 1;
  }
}
