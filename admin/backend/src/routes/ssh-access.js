import { Router } from 'express';
import { z } from 'zod';
import { exec } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import { logAudit } from '../db.js';
import { requireAdmin, requireSudo } from '../middleware/auth.js';

const execAsync = promisify(exec);

// The backend runs in a Docker container with `pid: host` and
// `privileged: true`; the CLI source tree (cli/) is NOT inside the
// container, only on the host at $INSTALL_DIR/cli/. To stay
// consistent with the services.js / lxc.js pattern, every
// state-mutating call shells out to /usr/local/bin/proxypilot via
// nsenter so the action lands on the host's CLI database, audit
// log, and authorized_keys files. The CLI's --json mode is the
// stable contract.
const isInDocker = existsSync('/.dockerenv') || process.env.DOCKER_CONTAINER === 'true';
const PROXYPILOT_BIN = process.env.PROXYPILOT_BIN || '/usr/local/bin/proxypilot';

async function execOnHost(command, { timeout = 15000 } = {}) {
  if (isInDocker) {
    // Wrap the inner command in single-quote shell escaping for the
    // outer `sh -c` argv. shellSingleQuote handles every byte safely
    // (including embedded single quotes); JSON.stringify here would
    // re-introduce the same `$()`-in-double-quotes injection class
    // we deliberately avoid below.
    const hostCommand = `nsenter -t 1 -m -u -n -i sh -c ${shellSingleQuote(command)}`;
    return execAsync(hostCommand, { timeout, maxBuffer: 4 * 1024 * 1024 });
  }
  return execAsync(command, { timeout, maxBuffer: 4 * 1024 * 1024 });
}

/**
 * POSIX single-quote shell escape. Inside single quotes EVERY byte
 * is literal except the single quote itself, which we encode by
 * closing the literal, emitting an escaped quote, and reopening:
 *   foo'bar  →  'foo'\''bar'
 * Safe against `$()`, backticks, `$VAR`, newlines, `;`, `&&`, `|`,
 * etc. The route's argv builder passes every operator-supplied
 * value through this helper before joining with spaces.
 */
function shellSingleQuote(s) {
  if (s === undefined || s === null) return "''";
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/**
 * Run `proxypilot --json ssh access <args>` on the host and return the
 * parsed JSON result. The CLI exits non-zero on validation failures,
 * but it ALSO emits a structured `{ ok: false, error: ... }` JSON body
 * before exiting, so we capture stdout regardless of exit status and
 * parse first; only treat exec errors that produced no JSON as fatal.
 */
async function callProxypilot(args, { stdin, timeout } = {}) {
  // Every token (including operator-supplied --label / --reason
  // values) is wrapped in POSIX single-quote escaping so embedded
  // shell metacharacters cannot break out of the argv list. Do NOT
  // switch this back to JSON.stringify — JSON's double-quote form
  // leaves $() and backticks live for shell command substitution,
  // which would let a label like `$(rm -rf /)` execute as root in
  // the host PID namespace.
  const cmd = [shellSingleQuote(PROXYPILOT_BIN), '--json', 'ssh', 'access', ...args.map(shellSingleQuote)].join(' ');
  // Heredoc sentinel includes a random-ish 64-bit suffix so a
  // pubkey containing the literal sentinel string cannot terminate
  // the heredoc early. The sentinel is single-quoted on the
  // opener (`<<'TAG'`) so the shell does no expansion on the body.
  const sentinel = `PP_SSH_PUBKEY_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 14).toUpperCase()}`;
  const wrapped = stdin
    ? `cat <<'${sentinel}' | ${cmd}\n${stdin}\n${sentinel}`
    : cmd;
  let result;
  try {
    result = await execOnHost(wrapped, { timeout });
  } catch (e) {
    // exec rejects on non-zero exit AND on signal — but also surfaces
    // stdout/stderr on the error object. Try to recover the JSON body
    // before declaring failure.
    if (e?.stdout) {
      try {
        const parsed = JSON.parse(e.stdout);
        return parsed;
      } catch {
        // fall through
      }
    }
    const stderr = (e?.stderr || '').toString().trim();
    const stdout = (e?.stdout || '').toString().trim();
    throw new Error(stderr || stdout || e.message || 'proxypilot ssh access failed');
  }
  const out = (result.stdout || '').toString();
  try {
    return JSON.parse(out);
  } catch {
    throw new Error(`proxypilot ssh access produced non-JSON output: ${out.slice(0, 200)}`);
  }
}

export const sshAccessRouter = Router();

sshAccessRouter.use(requireAdmin);

const filterSchema = z.enum(['all', 'active', 'revoked']).default('active');

sshAccessRouter.get('/', async (req, res) => {
  let filter;
  try {
    filter = filterSchema.parse(req.query.filter || 'active');
  } catch (e) {
    return res.status(400).json({ ok: false, error: e.message });
  }
  try {
    const flag = filter === 'all' ? '--all' : filter === 'revoked' ? '--revoked' : '--active';
    const result = await callProxypilot(['list', flag]);
    if (!result.ok) return res.status(400).json(result);
    res.json({ ok: true, filter, entries: result.entries || [] });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

sshAccessRouter.get('/:id', async (req, res) => {
  try {
    const result = await callProxypilot(['show', req.params.id]);
    if (!result.ok) {
      return res.status(404).json(result);
    }
    res.json({ ok: true, entry: result.entry });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Allowlist of shell variants. The CLI's renderer also validates,
// but we constrain at the boundary so a junk value never reaches
// the shellSingleQuote+execOnHost path. Keep in sync with
// BOOTSTRAP_SHELLS in cli/src/core/ssh-access/bootstrap.js.
const ALLOWED_BOOTSTRAP_SHELLS = new Set(['bash', 'powershell']);

sshAccessRouter.get('/:id/bootstrap-script', async (req, res) => {
  try {
    const args = ['bootstrap-script', req.params.id];
    if (typeof req.query.user === 'string' && req.query.user) args.push('--user', req.query.user);
    if (typeof req.query.server === 'string' && req.query.server) args.push('--server', req.query.server);
    if (typeof req.query.shell === 'string' && req.query.shell) {
      if (!ALLOWED_BOOTSTRAP_SHELLS.has(req.query.shell)) {
        return res.status(400).json({ ok: false, error: `unknown shell: ${req.query.shell}` });
      }
      args.push('--shell', req.query.shell);
    }
    const result = await callProxypilot(args);
    if (!result.ok) return res.status(400).json(result);
    res.json({ ok: true, id: req.params.id, shell: result.shell ?? 'bash', script: result.script });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

const addSchema = z.object({
  id: z.string().min(1).max(63).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  unix_user: z.string().min(1).max(32).regex(/^[a-z_][a-z0-9_-]*\$?$/),
  public_key: z.string().min(1),
  label: z.string().max(255).optional().nullable(),
});

sshAccessRouter.post('/', requireSudo, async (req, res) => {
  let body;
  try {
    body = addSchema.parse(req.body || {});
  } catch (e) {
    return res.status(400).json({ ok: false, error: e.message });
  }
  try {
    const args = ['add', body.id, '--user', body.unix_user, '--pubkey', '-'];
    if (body.label) args.push('--label', body.label);
    const result = await callProxypilot(args, { stdin: body.public_key });
    if (!result.ok) {
      return res.status(400).json(result);
    }
    logAudit(req.user.id, 'SSH_ACCESS_ADD', 'ssh_access', body.id, {
      unix_user: body.unix_user,
      fingerprint: result.fingerprint,
      label: body.label ?? null,
    }, req.ip);
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

const revokeSchema = z.object({
  reason: z.string().max(255).optional().nullable(),
  force: z.boolean().optional(),
});

sshAccessRouter.post('/:id/revoke', requireSudo, async (req, res) => {
  let body;
  try {
    body = revokeSchema.parse(req.body || {});
  } catch (e) {
    return res.status(400).json({ ok: false, error: e.message });
  }
  try {
    const args = ['revoke', req.params.id];
    if (body.reason) args.push('--reason', body.reason);
    if (body.force) args.push('--force');
    const result = await callProxypilot(args);
    if (!result.ok) {
      // Lockout-gate: CLI returns code=WOULD_STRAND with
      // requires_typed_confirm:true when stranding without a typed
      // phrase. The dashboard prompts the user, then re-sends with
      // force:true. Re-surface as 409 so the frontend's existing
      // ApiError handler picks up `code` and switches the modal to
      // the typed-phrase view.
      if (result.code === 'WOULD_STRAND') {
        return res.status(409).json(result);
      }
      return res.status(400).json(result);
    }
    logAudit(req.user.id, 'SSH_ACCESS_REVOKE', 'ssh_access', req.params.id, {
      unix_user: result.unix_user,
      fingerprint: result.fingerprint,
      reason: body.reason ?? null,
      forced: !!body.force,
    }, req.ip);
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

const removeBodySchema = z.object({ force: z.boolean().optional() });

sshAccessRouter.delete('/:id', requireSudo, async (req, res) => {
  let body;
  try {
    body = removeBodySchema.parse(req.body || {});
  } catch (e) {
    return res.status(400).json({ ok: false, error: e.message });
  }
  try {
    const args = ['remove', req.params.id];
    if (body.force) args.push('--force');
    const result = await callProxypilot(args);
    if (!result.ok) {
      if (result.code === 'WOULD_STRAND') {
        return res.status(409).json(result);
      }
      return res.status(400).json(result);
    }
    logAudit(req.user.id, 'SSH_ACCESS_REMOVE', 'ssh_access', req.params.id, {
      unix_user: result.unix_user,
      fingerprint: result.fingerprint,
      forced: !!body.force,
    }, req.ip);
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

const reconcileSchema = z.object({ dry_run: z.boolean().optional() });

// ── Password authentication toggle ─────────────────────────────────────
// Wraps `proxypilot ssh password-auth status|enable|disable`. The CLI
// performs the dangerous bits (atomic write, sshd -t validation,
// reload-with-rollback); the backend just relays operator intent and
// surfaces the lockout-gate code so the dashboard can flip its modal
// to the typed-phrase view.
async function callProxypilotSshPasswordAuth(args, opts = {}) {
  // Reuse the shellSingleQuote + execOnHost helpers but route through
  // a different subcommand path.
  const cmd = [
    shellSingleQuote(PROXYPILOT_BIN),
    '--json',
    'ssh',
    'password-auth',
    ...args.map(shellSingleQuote),
  ].join(' ');
  let result;
  try {
    result = await execOnHost(cmd, { timeout: opts.timeout ?? 20000 });
  } catch (e) {
    if (e?.stdout) {
      try { return JSON.parse(e.stdout); } catch { /* fall through */ }
    }
    throw new Error((e?.stderr || e?.stdout || e.message || 'proxypilot ssh password-auth failed').toString().trim());
  }
  const out = (result.stdout || '').toString();
  try { return JSON.parse(out); }
  catch { throw new Error(`proxypilot ssh password-auth produced non-JSON output: ${out.slice(0, 200)}`); }
}

sshAccessRouter.get('/password-auth/status', async (req, res) => {
  try {
    const result = await callProxypilotSshPasswordAuth(['status']);
    if (result?.ok === false) return res.status(400).json(result);
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

const passwordAuthSetSchema = z.object({
  enabled: z.boolean(),
  force: z.boolean().optional(),
});

sshAccessRouter.post('/password-auth', requireSudo, async (req, res) => {
  let body;
  try { body = passwordAuthSetSchema.parse(req.body || {}); }
  catch (e) { return res.status(400).json({ ok: false, error: e.message }); }
  try {
    const args = [body.enabled ? 'enable' : 'disable'];
    if (!body.enabled && body.force) args.push('--force');
    const result = await callProxypilotSshPasswordAuth(args);
    if (result?.ok === false) {
      // NO_ACTIVE_KEYS is the only code the disable path raises.
      // Mirror the WOULD_STRAND posture from the revoke route.
      if (result.code === 'NO_ACTIVE_KEYS') {
        return res.status(409).json({ ...result, requires_force: true });
      }
      return res.status(400).json(result);
    }
    logAudit(req.user.id, 'SSH_PASSWORD_AUTH_SET', 'sshd_config', null, {
      target: body.enabled ? 'yes' : 'no',
      forced: !!body.force,
      no_change: !!result?.no_change,
      reload_method: result?.reload?.method ?? null,
    }, req.ip);
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

sshAccessRouter.post('/reconcile', requireSudo, async (req, res) => {
  let body;
  try {
    body = reconcileSchema.parse(req.body || {});
  } catch (e) {
    return res.status(400).json({ ok: false, error: e.message });
  }
  try {
    const args = ['reconcile'];
    if (body.dry_run) args.push('--dry-run');
    const result = await callProxypilot(args);
    if (!result.ok) return res.status(400).json(result);
    if (!body.dry_run) {
      logAudit(req.user.id, 'SSH_ACCESS_RECONCILE', 'ssh_access', null, {
        users_changed: (result.users || []).filter(u => u.changed).map(u => u.user),
      }, req.ip);
    }
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});
