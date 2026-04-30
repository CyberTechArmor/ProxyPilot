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
    const hostCommand = `nsenter -t 1 -m -u -n -i sh -c ${JSON.stringify(command)}`;
    return execAsync(hostCommand, { timeout, maxBuffer: 4 * 1024 * 1024 });
  }
  return execAsync(command, { timeout, maxBuffer: 4 * 1024 * 1024 });
}

/**
 * Run `proxypilot --json ssh access <args>` on the host and return the
 * parsed JSON result. The CLI exits non-zero on validation failures,
 * but it ALSO emits a structured `{ ok: false, error: ... }` JSON body
 * before exiting, so we capture stdout regardless of exit status and
 * parse first; only treat exec errors that produced no JSON as fatal.
 */
async function callProxypilot(args, { stdin, timeout } = {}) {
  // args is a list of pre-validated, shell-safe tokens (we control
  // every value going in). We pass them through `printf %q` style
  // quoting via JSON.stringify so an unexpected character can't break
  // out of the argv list.
  const cmd = [`${JSON.stringify(PROXYPILOT_BIN)}`, '--json', 'ssh', 'access', ...args.map(a => JSON.stringify(a))].join(' ');
  const wrapped = stdin
    ? `cat <<'PP_SSH_PUBKEY_HEREDOC' | ${cmd}\n${stdin}\nPP_SSH_PUBKEY_HEREDOC`
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

sshAccessRouter.get('/:id/bootstrap-script', async (req, res) => {
  try {
    const args = ['bootstrap-script', req.params.id];
    if (typeof req.query.user === 'string' && req.query.user) args.push('--user', req.query.user);
    if (typeof req.query.server === 'string' && req.query.server) args.push('--server', req.query.server);
    const result = await callProxypilot(args);
    if (!result.ok) return res.status(400).json(result);
    res.json({ ok: true, id: req.params.id, script: result.script });
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
