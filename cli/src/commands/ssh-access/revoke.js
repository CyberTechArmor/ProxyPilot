import { revokeEntry, inspectFallbacks, showEntry } from '../../core/ssh-access/index.js';
import * as output from '../../output.js';

/**
 * Lockout-gate phrase. Distinct from the four already in use across the
 * VPN module so muscle memory can't approve the wrong gate. The intent
 * is the operator promises they have another route in (recovery key,
 * console access, another managed device) before revoking the last
 * managed key for a unix user.
 */
const TYPED_PHRASE = 'i have another way into this account';

export async function revokeCommand(id, opts, globalOpts) {
  try {
    // Look up the row first so we can run the lockout gate without
    // mutating state.
    const row = showEntry(id);
    if (row.revoked_at) {
      // Already revoked — short-circuit with a friendly message instead
      // of running the gate twice.
      const result = await revokeEntry({ id });
      if (globalOpts.json) {
        output.json({ ok: true, already_revoked: true, id: result.id });
        return;
      }
      output.info(`ssh-access "${id}" was already revoked`);
      return;
    }

    const fb = inspectFallbacks({ unixUser: row.unix_user, idBeingRevoked: id });
    const wouldStrand = fb.fallbacks.length === 0 && fb.remainingManaged === 0;

    if (wouldStrand && !opts.force) {
      const msg =
        `refusing to revoke "${id}" — it's the last access path for unix user ` +
        `"${row.unix_user}" (no operator-added authorized_keys lines, no other ` +
        `ProxyPilot-managed entries). Pass --force (with typed confirmation) ` +
        `to proceed.`;
      if (globalOpts.json) {
        output.json({
          ok: false,
          error: msg,
          code: 'WOULD_STRAND',
          unix_user: row.unix_user,
          fallbacks: fb.fallbacks,
          remaining_managed: fb.remainingManaged,
        });
        process.exitCode = 1;
        return;
      }
      output.error(msg);
      process.exitCode = 1;
      return;
    }

    if (wouldStrand && opts.force) {
      if (globalOpts.json) {
        output.json({
          ok: false,
          error: 'typed confirmation required for --force on a stranding revoke; re-run interactively',
          code: 'WOULD_STRAND',
          requires_typed_confirm: true,
        });
        process.exitCode = 1;
        return;
      }
      const ok = await output.confirmTyped(
        `Revoking "${id}" would leave unix user "${row.unix_user}" with NO authorized_keys access ` +
        `(no operator fallback, no other managed entries). Make sure you have console access ` +
        `or a sealed recovery key before proceeding.`,
        TYPED_PHRASE,
      );
      if (!ok) {
        output.error('typed confirmation did not match — aborting');
        process.exitCode = 1;
        return;
      }
    }

    if (!wouldStrand && fb.fallbacks.length === 0) {
      // Soft warning: no operator fallback, but other managed entries
      // remain. Worth surfacing so the operator can spot a missing
      // fallback before it becomes urgent.
      output.warn(
        `note: unix user "${row.unix_user}" has no operator-added (non-ProxyPilot) ` +
        `authorized_keys lines. ${fb.remainingManaged} managed entr${fb.remainingManaged === 1 ? 'y' : 'ies'} ` +
        `will remain after this revoke.`,
      );
    }

    const result = await revokeEntry({ id, reason: opts.reason ?? null });

    if (globalOpts.json) {
      output.json({
        ok: true,
        id: result.id,
        unix_user: result.unix_user,
        fingerprint: result.fingerprint,
        revoked_at: result.revoked_at,
        revoked_reason: result.revoked_reason,
        fallbacks: fb.fallbacks,
        remaining_managed: fb.remainingManaged,
        reconcile: result.reconcile,
      });
      return;
    }

    output.success(`ssh-access "${id}" revoked  user=${result.unix_user}`);
    const userInfo = result.reconcile.users.find(u => u.user === result.unix_user);
    if (userInfo?.changed) {
      output.info(`authorized_keys for ${result.unix_user} rewritten (${userInfo.before_count} → ${userInfo.after_count} managed lines)`);
    }
    for (const w of result.reconcile.warnings) {
      output.warn(`reconcile warning [${w.unix_user}]: ${w.message}`);
    }
  } catch (e) {
    if (globalOpts.json) {
      output.json({ ok: false, error: e.message });
      process.exitCode = 1;
      return;
    }
    output.error(`ssh access revoke failed: ${e.message}`);
    process.exitCode = 1;
  }
}
