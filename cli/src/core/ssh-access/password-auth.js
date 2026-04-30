import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { listEntries } from './index.js';
import { audit } from '../../db/audit.js';

export const SSHD_CONFIG_PATH = process.env.PROXYPILOT_SSHD_CONFIG || '/etc/ssh/sshd_config';
export const SSHD_BACKUP_DIR = process.env.PROXYPILOT_SSHD_BACKUP_DIR || '/var/lib/proxypilot';
export const SSHD_BACKUP_PATH = path.join(SSHD_BACKUP_DIR, 'sshd_config.bak');

/**
 * Parse the *effective* PasswordAuthentication value out of sshd_config.
 *
 * Subtleties this handles:
 *   - sshd reads top-down, last-match-wins for non-Match scope. We
 *     return the last unconditional setting.
 *   - Match blocks override per-context but never affect the global
 *     default this command toggles. We expose `match_overrides` so
 *     the caller can warn.
 *   - Default if unset is `yes` (pre-OpenSSH 9.5). We surface
 *     `default` so the operator knows the line isn't there.
 *   - Comments on the same line are ignored.
 *
 * Returns: { value: 'yes'|'no'|'default', line_no, raw, match_overrides }
 */
export function parsePasswordAuthState(text) {
  const lines = text.split(/\r?\n/);
  let value = 'default';
  let lineNo = -1;
  let raw = null;
  let inMatch = false;
  const matchOverrides = [];

  for (let i = 0; i < lines.length; i++) {
    const stripped = lines[i].replace(/#.*$/, '').trim();
    if (!stripped) continue;
    if (/^Match\b/i.test(stripped)) {
      inMatch = true;
      continue;
    }
    // sshd treats indentation as still inside the Match block;
    // `End` isn't a real keyword. Any non-indented top-level
    // directive after a Match block is still affected by it
    // unless followed by another Match. Be conservative: once
    // we've hit a Match, treat *all* subsequent PasswordAuth
    // directives as match-scoped.
    const m = stripped.match(/^PasswordAuthentication\s+(\S+)/i);
    if (m) {
      const v = m[1].toLowerCase();
      if (inMatch) {
        matchOverrides.push({ line_no: i + 1, value: v });
      } else if (v === 'yes' || v === 'no') {
        value = v;
        lineNo = i + 1;
        raw = lines[i];
      }
    }
  }
  return { value, line_no: lineNo, raw, match_overrides: matchOverrides };
}

/**
 * Produce a new sshd_config text with PasswordAuthentication set to
 * `target` ('yes'|'no'). Replaces the last unconditional directive in
 * place; if no directive exists, appends one with a brief explanatory
 * comment.
 */
export function applyPasswordAuthEdit(text, target) {
  if (target !== 'yes' && target !== 'no') {
    throw new Error(`bad target "${target}": expected yes|no`);
  }
  const state = parsePasswordAuthState(text);
  if (state.line_no > 0) {
    const lines = text.split(/\r?\n/);
    lines[state.line_no - 1] = `PasswordAuthentication ${target}`;
    return lines.join('\n');
  }
  // Append. Preserve trailing newline shape.
  const trailing = /\n$/.test(text) ? '' : '\n';
  return text + trailing + `\n# Managed by ProxyPilot ssh password-auth.\nPasswordAuthentication ${target}\n`;
}

/**
 * Run `sshd -t -f <path>` to validate a config text. Used both before
 * we install a candidate config and after, so an interrupted reload
 * leaves the original config untouched.
 */
function sshdTest(configPath) {
  const r = spawnSync('sshd', ['-t', '-f', configPath], { encoding: 'utf-8' });
  return {
    ok: r.status === 0,
    stderr: (r.stderr || '').trim(),
    stdout: (r.stdout || '').trim(),
  };
}

function reloadSshd() {
  // Try systemctl first (modern systemd hosts), fall back to direct
  // signal. Either way the call is idempotent — sshd reloads its
  // config without dropping live sessions.
  const sys = spawnSync('systemctl', ['reload', 'ssh'], { encoding: 'utf-8' });
  if (sys.status === 0) return { ok: true, method: 'systemctl reload ssh' };
  const sys2 = spawnSync('systemctl', ['reload', 'sshd'], { encoding: 'utf-8' });
  if (sys2.status === 0) return { ok: true, method: 'systemctl reload sshd' };
  // Last resort: HUP the daemon directly.
  const pidR = spawnSync('pgrep', ['-x', 'sshd'], { encoding: 'utf-8' });
  if (pidR.status === 0) {
    const pid = (pidR.stdout || '').split(/\s+/).filter(Boolean)[0];
    if (pid) {
      const k = spawnSync('kill', ['-HUP', pid], { encoding: 'utf-8' });
      if (k.status === 0) return { ok: true, method: `kill -HUP ${pid}` };
    }
  }
  return {
    ok: false,
    method: null,
    error: (sys.stderr || sys2.stderr || pidR.stderr || 'no working reload method').trim(),
  };
}

/**
 * Read-only status: parse current PasswordAuthentication, count
 * active SSH access entries (used as the lockout-safety check).
 */
export function passwordAuthStatus() {
  const text = fs.existsSync(SSHD_CONFIG_PATH) ? fs.readFileSync(SSHD_CONFIG_PATH, 'utf-8') : '';
  const state = parsePasswordAuthState(text);
  const active = listEntries({ filter: 'active' });
  return {
    config_path: SSHD_CONFIG_PATH,
    config_exists: fs.existsSync(SSHD_CONFIG_PATH),
    password_auth: state.value,
    line_no: state.line_no,
    raw: state.raw,
    match_overrides: state.match_overrides,
    effective_default: state.value === 'default' ? 'yes' : state.value,
    active_keys_total: active.length,
    active_keys_per_user: active.reduce((m, r) => {
      m[r.unix_user] = (m[r.unix_user] || 0) + 1;
      return m;
    }, {}),
  };
}

/**
 * Toggle PasswordAuthentication. Workflow:
 *   1. Lockout check on disable: refuse unless at least one active
 *      ssh-access row exists for SOME unix user, or --force is set.
 *   2. Atomic write: stage the new config to a sibling tempfile,
 *      `sshd -t -f <tmp>` it, fail loudly if the test rejects.
 *   3. Backup the existing config to /var/lib/proxypilot/sshd_config.bak
 *      (overwriting any previous backup so the operator always has
 *      "the version before the most recent toggle" available).
 *   4. Rename tempfile over sshd_config.
 *   5. Reload sshd. Existing sessions stay alive.
 *   6. Audit-log the change.
 *
 * Returns the same shape as passwordAuthStatus() augmented with
 * `before` / `after` snapshots so the dashboard can render the diff.
 */
export async function setPasswordAuth({ enabled, force = false, actor } = {}) {
  const target = enabled ? 'yes' : 'no';
  if (!fs.existsSync(SSHD_CONFIG_PATH)) {
    throw new Error(`sshd_config not found at ${SSHD_CONFIG_PATH}`);
  }
  const beforeText = fs.readFileSync(SSHD_CONFIG_PATH, 'utf-8');
  const beforeState = parsePasswordAuthState(beforeText);
  const beforeEffective = beforeState.value === 'default' ? 'yes' : beforeState.value;

  if (!enabled && !force) {
    const active = listEntries({ filter: 'active' });
    if (active.length === 0) {
      const err = new Error(
        'refusing to disable password auth: no active ssh-access entries exist. ' +
        'Add and verify a key first, or pass --force after confirming you have console access.',
      );
      err.code = 'NO_ACTIVE_KEYS';
      throw err;
    }
  }

  if (beforeEffective === target) {
    // No-op short circuit, but still record an audit row so the
    // operator's intent is captured.
    audit({
      subsystem: 'ssh-access',
      action: 'ssh-access.password-auth.noop',
      resource: SSHD_CONFIG_PATH,
      actor,
      before: { password_auth: beforeState.value },
      after: { password_auth: target, no_change: true },
    });
    return {
      ok: true,
      no_change: true,
      before: beforeState,
      after: { ...beforeState, value: target },
      reload: { ok: true, method: 'no-op' },
    };
  }

  const newText = applyPasswordAuthEdit(beforeText, target);
  const tmpPath = `${SSHD_CONFIG_PATH}.proxypilot.tmp`;

  // Match owner/perms of the original so sshd doesn't reject the
  // file on permissions grounds after rename.
  const stat = fs.statSync(SSHD_CONFIG_PATH);
  fs.writeFileSync(tmpPath, newText, { mode: stat.mode });
  try { fs.chownSync(tmpPath, stat.uid, stat.gid); } catch { /* best-effort */ }

  const test = sshdTest(tmpPath);
  if (!test.ok) {
    fs.unlinkSync(tmpPath);
    throw new Error(`sshd -t rejected the new config: ${test.stderr || 'unknown'}`);
  }

  // Backup the live config before swapping.
  fs.mkdirSync(SSHD_BACKUP_DIR, { recursive: true });
  fs.copyFileSync(SSHD_CONFIG_PATH, SSHD_BACKUP_PATH);

  fs.renameSync(tmpPath, SSHD_CONFIG_PATH);

  const reload = reloadSshd();
  if (!reload.ok) {
    // Roll back: the new config is in place but sshd refused to
    // reload. Restore the backup and surface the error.
    fs.copyFileSync(SSHD_BACKUP_PATH, SSHD_CONFIG_PATH);
    const err = new Error(`sshd reload failed (${reload.error}); rolled back to backup`);
    err.code = 'RELOAD_FAILED';
    throw err;
  }

  const afterText = fs.readFileSync(SSHD_CONFIG_PATH, 'utf-8');
  const afterState = parsePasswordAuthState(afterText);

  audit({
    subsystem: 'ssh-access',
    action: 'ssh-access.password-auth.set',
    resource: SSHD_CONFIG_PATH,
    actor,
    before: { password_auth: beforeState.value, line_no: beforeState.line_no },
    after: {
      password_auth: afterState.value,
      line_no: afterState.line_no,
      forced: !!force,
      reload_method: reload.method,
      backup_path: SSHD_BACKUP_PATH,
    },
  });

  return {
    ok: true,
    no_change: false,
    forced: !!force,
    before: beforeState,
    after: afterState,
    backup_path: SSHD_BACKUP_PATH,
    reload,
  };
}
