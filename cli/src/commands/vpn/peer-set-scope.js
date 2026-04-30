import { setPeerScope } from '../../core/vpn/index.js';
import { surfacePeerMutationResult } from './_firewall-feedback.js';
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
 * The core mutation persists the SQLite change, writes the audit row,
 * AND triggers a firewall reconcile so vpn-only rules' per-/32 source
 * sets pick up the new shape on the same operator action. Reconcile
 * is the single L4 mutation point; we never call nft directly.
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
      result = await setPeerScope({ name, scope, services, force: false, actor });
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
      result = await setPeerScope({ name, scope, services, force: true, actor });
    }

    if (globalOpts.json) {
      output.json({
        ok: true,
        name: result.name,
        ip: result.ip,
        before: result.before,
        after: result.after,
        firewall: result.firewall ?? null,
        caddy: result.caddy ?? null,
      });
      return;
    }
    output.success(
      `peer "${name}" scope: ${result.before.scope}` +
      (result.before.services ? `(${result.before.services.join(',')})` : '') +
      ` → ${result.after.scope}` +
      (result.after.services ? `(${result.after.services.join(',')})` : ''),
    );
    surfacePeerMutationResult(result);
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
