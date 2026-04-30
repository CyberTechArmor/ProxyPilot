import { removeEntry, inspectFallbacks, showEntry } from '../../core/ssh-access/index.js';
import * as output from '../../output.js';

/**
 * Same lockout-gate phrase as revoke. `remove` is the harder action of
 * the two (no audit-recoverable revoke trail), so it gets the gate
 * applied with the same stranding semantics: refuse when the active
 * row is the last access path for its unix user without --force +
 * typed phrase. Already-revoked rows skip the gate (they don't grant
 * access; deleting them only loses the audit trail).
 */
const TYPED_PHRASE = 'i have another way into this account';

export async function removeCommand(id, opts, globalOpts) {
  try {
    const row = showEntry(id);
    const isActive = !row.revoked_at;
    let wouldStrand = false;
    let fb = { fallbacks: [], remainingManaged: 0 };

    if (isActive) {
      fb = inspectFallbacks({ unixUser: row.unix_user, idBeingRevoked: id });
      wouldStrand = fb.fallbacks.length === 0 && fb.remainingManaged === 0;
    }

    if (wouldStrand && !opts.force) {
      const msg =
        `refusing to remove "${id}" — it's the last active access path for ` +
        `unix user "${row.unix_user}". Pass --force (with typed confirmation) ` +
        `to proceed, or revoke instead so the row stays in the audit log.`;
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
          error: 'typed confirmation required for --force on a stranding remove; re-run interactively',
          code: 'WOULD_STRAND',
          requires_typed_confirm: true,
        });
        process.exitCode = 1;
        return;
      }
      const ok = await output.confirmTyped(
        `Removing "${id}" would leave unix user "${row.unix_user}" with NO authorized_keys access ` +
        `(no operator fallback, no other managed entries). Removing also deletes the row entirely — ` +
        `prefer revoke if you want the audit trail.`,
        TYPED_PHRASE,
      );
      if (!ok) {
        output.error('typed confirmation did not match — aborting');
        process.exitCode = 1;
        return;
      }
    }

    const result = await removeEntry({ id });

    if (globalOpts.json) {
      output.json({
        ok: true,
        id: result.id,
        unix_user: result.unix_user,
        fingerprint: result.fingerprint,
        reconcile: result.reconcile,
      });
      return;
    }

    output.success(`ssh-access "${id}" removed  user=${result.unix_user}  fingerprint=${result.fingerprint}`);
    const userInfo = result.reconcile.users.find(u => u.user === result.unix_user);
    if (userInfo?.changed) {
      output.info(`authorized_keys for ${result.unix_user} rewritten (${userInfo.before_count} → ${userInfo.after_count} managed lines)`);
    }
  } catch (e) {
    if (globalOpts.json) {
      output.json({ ok: false, error: e.message });
      process.exitCode = 1;
      return;
    }
    output.error(`ssh access remove failed: ${e.message}`);
    process.exitCode = 1;
  }
}
