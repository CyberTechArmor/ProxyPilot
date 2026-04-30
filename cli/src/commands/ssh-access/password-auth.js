import { passwordAuthStatus, setPasswordAuth } from '../../core/ssh-access/password-auth.js';
import * as output from '../../output.js';

const TYPED_PHRASE = 'i have another way into this account';

export async function passwordAuthStatusCommand(_opts, globalOpts) {
  try {
    const s = passwordAuthStatus();
    if (globalOpts.json) {
      output.json({ ok: true, ...s });
      return;
    }
    output.info(`config           ${s.config_path}${s.config_exists ? '' : ' (MISSING)'}`);
    output.info(`PasswordAuth     ${s.password_auth}${s.password_auth === 'default' ? ` (effective: ${s.effective_default})` : ''}`);
    if (s.match_overrides.length) {
      output.warn(`Match-block overrides: ${s.match_overrides.length} (per-context, not affected by toggle)`);
    }
    output.info(`Active SSH keys  ${s.active_keys_total} (${Object.entries(s.active_keys_per_user).map(([u, n]) => `${u}=${n}`).join(', ') || 'none'})`);
  } catch (e) {
    if (globalOpts.json) {
      output.json({ ok: false, error: e.message });
      process.exitCode = 1;
      return;
    }
    output.error(`ssh password-auth status failed: ${e.message}`);
    process.exitCode = 1;
  }
}

export async function passwordAuthEnableCommand(_opts, globalOpts) {
  const actor = process.env.SUDO_USER ?? process.env.USER ?? null;
  try {
    const r = await setPasswordAuth({ enabled: true, actor });
    if (globalOpts.json) {
      output.json({ ok: true, action: 'enable', ...r });
      return;
    }
    if (r.no_change) {
      output.info('PasswordAuthentication is already enabled. No change.');
      return;
    }
    output.success(`PasswordAuthentication enabled (sshd ${r.reload.method}, backup at ${r.backup_path})`);
  } catch (e) {
    if (globalOpts.json) {
      output.json({ ok: false, error: e.message, code: e.code ?? null });
      process.exitCode = 1;
      return;
    }
    output.error(`ssh password-auth enable failed: ${e.message}`);
    process.exitCode = 1;
  }
}

/**
 * Disable password auth. Three gates apply, in order:
 *  1. NO_ACTIVE_KEYS — refused unless --force when no ssh-access row
 *     is active. The CLI lets --force escape this gate after the
 *     typed phrase; the dashboard collects the phrase client-side.
 *  2. sshd -t on the candidate config (always; not bypassable).
 *  3. systemctl reload (always; rolls back on failure).
 */
export async function passwordAuthDisableCommand(opts, globalOpts) {
  const actor = process.env.SUDO_USER ?? process.env.USER ?? null;
  try {
    let r;
    try {
      r = await setPasswordAuth({ enabled: false, force: !!opts.force, actor });
    } catch (e) {
      if (e.code !== 'NO_ACTIVE_KEYS') throw e;
      if (!opts.force) {
        if (globalOpts.json) {
          output.json({ ok: false, error: e.message, code: e.code });
          process.exitCode = 1;
          return;
        }
        output.error(e.message);
        process.exitCode = 1;
        return;
      }
      // --force was set but the JSON caller cannot type interactively.
      // Refuse and tell the caller to re-run with a TTY. Same posture
      // as ssh-access.revoke / vpn.peer.disable.
      if (globalOpts.json) {
        output.json({ ok: false, error: e.message, code: e.code, requires_typed_confirm: true });
        process.exitCode = 1;
        return;
      }
      const ok = await output.confirmTyped(
        'Disabling password auth with NO active ssh-access keys risks locking ' +
        'EVERYONE out of this host. Make sure you have console access or a ' +
        'sealed recovery key before proceeding.',
        TYPED_PHRASE,
      );
      if (!ok) {
        output.error('typed confirmation did not match — aborting');
        process.exitCode = 1;
        return;
      }
      r = await setPasswordAuth({ enabled: false, force: true, actor });
    }
    if (globalOpts.json) {
      output.json({ ok: true, action: 'disable', ...r });
      return;
    }
    if (r.no_change) {
      output.info('PasswordAuthentication is already disabled. No change.');
      return;
    }
    output.success(`PasswordAuthentication disabled (sshd ${r.reload.method}, backup at ${r.backup_path})`);
  } catch (e) {
    if (globalOpts.json) {
      output.json({ ok: false, error: e.message, code: e.code ?? null });
      process.exitCode = 1;
      return;
    }
    output.error(`ssh password-auth disable failed: ${e.message}`);
    process.exitCode = 1;
  }
}
