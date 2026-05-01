import { Router } from 'express';
import { z } from 'zod';
import { exec } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import { logAudit } from '../db.js';
import { requireAdmin, requireSudo } from '../middleware/auth.js';
import { shellSingleQuote } from '../lib/shell-quote.js';

const execAsync = promisify(exec);

// The backend runs in a Docker container with `pid: host` and
// `privileged: true`; the CLI source tree (cli/) is NOT inside the
// container, only on the host at $INSTALL_DIR/cli/. To stay
// consistent with the services.js / lxc.js / ssh-access.js /
// firewall.js pattern, every state-mutating call shells out to
// /usr/local/bin/proxypilot via nsenter so the action lands on the
// host's CLI database, audit log, wg0.conf, and live wg show. The
// CLI's --json mode is the stable contract.
const isInDocker = existsSync('/.dockerenv') || process.env.DOCKER_CONTAINER === 'true';
const PROXYPILOT_BIN = process.env.PROXYPILOT_BIN || '/usr/local/bin/proxypilot';

async function execOnHost(command, { timeout = 25000 } = {}) {
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
 * Run `proxypilot --json vpn <args>` on the host and return the
 * parsed JSON result. The CLI exits non-zero on validation failures
 * AND on lockout-gate refusals; in --json mode it emits a structured
 * `{ ok: false, error, code? }` body before exiting, so we capture
 * stdout regardless of exit status and parse first.
 */
async function callProxypilot(args, { timeout } = {}) {
  // Every token is wrapped in POSIX single-quote escaping so embedded
  // shell metacharacters cannot break out of the argv list. Do NOT
  // switch this back to JSON.stringify — JSON's double-quote form
  // leaves $() and backticks live for shell command substitution,
  // which would let a peer name like `$(rm -rf /)` execute as root
  // in the host PID namespace.
  const cmd = [shellSingleQuote(PROXYPILOT_BIN), '--json', 'vpn', ...args.map(shellSingleQuote)].join(' ');
  let result;
  try {
    result = await execOnHost(cmd, { timeout });
  } catch (e) {
    if (e?.stdout) {
      try {
        return JSON.parse(e.stdout);
      } catch {
        // fall through
      }
    }
    const stderr = (e?.stderr || '').toString().trim();
    const stdout = (e?.stdout || '').toString().trim();
    throw new Error(stderr || stdout || e.message || 'proxypilot vpn failed');
  }
  const out = (result.stdout || '').toString();
  try {
    return JSON.parse(out);
  } catch {
    throw new Error(`proxypilot vpn produced non-JSON output: ${out.slice(0, 200)}`);
  }
}

/**
 * Lockout-gate codes the CLI can return on destructive peer actions.
 * Surface as 409 with `requires_force: true` so the dashboard's
 * ApiError handler picks up `code` and switches the modal to the
 * typed-phrase view, then re-issues the call with `force: true`.
 *
 * Note: the CLI's --json mode currently refuses --force on these
 * gates and returns `requires_typed_confirm: true` — same posture as
 * ssh-access.js's WOULD_STRAND. The dashboard surfaces the second
 * 409 to the operator unchanged; bypassing the gate fully requires
 * an interactive CLI session. This matches the existing SSH access
 * pattern.
 */
const LOCKOUT_CODES = new Set([
  'LAST_ENABLED_PEER',
  'LAST_FULL_ADMIN_DEMOTE',
  'RECENTLY_ACTIVE',
]);

function lockoutResponse(res, result) {
  return res.status(409).json({ ...result, requires_force: true });
}

export const vpnRouter = Router();

vpnRouter.use(requireAdmin);

// ── reads ──────────────────────────────────────────────────────────────

vpnRouter.get('/', async (_req, res) => {
  try {
    // peerListCommand returns { ok, peers }; statusCommand returns the
    // server-config payload at the top level (also { ok, ... }).
    const [status, peerList] = await Promise.all([
      callProxypilot(['status']),
      callProxypilot(['peer', 'list']),
    ]);
    if (status?.ok === false) return res.status(400).json(status);
    if (peerList?.ok === false) return res.status(400).json(peerList);
    res.json({ ok: true, status, peers: peerList?.peers ?? [] });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

const peerNameSchema = z.string().min(1).max(63).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);

vpnRouter.get('/:name', async (req, res) => {
  try { peerNameSchema.parse(req.params.name); }
  catch (e) { return res.status(400).json({ ok: false, error: `bad peer name: ${e.message}` }); }
  try {
    const result = await callProxypilot(['peer', 'show', req.params.name]);
    if (result?.ok === false) return res.status(404).json(result);
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── server-level enable/disable ────────────────────────────────────────

const endpointSchema = z.string().min(3).max(255).regex(/^[A-Za-z0-9._:-]+$/);
const portSchema = z.number().int().min(1).max(65535);
const dnsSchema = z.string().min(2).max(64).regex(/^[0-9A-Fa-f.:]+$/);

const enableSchema = z.object({
  endpoint: endpointSchema,
  port: portSchema.optional(),
  dns: dnsSchema.optional(),
});

vpnRouter.post('/enable', requireSudo, async (req, res) => {
  let body;
  try { body = enableSchema.parse(req.body || {}); }
  catch (e) { return res.status(400).json({ ok: false, error: e.message }); }
  try {
    const args = ['enable', '--endpoint', body.endpoint];
    if (body.port != null) args.push('--port', String(body.port));
    if (body.dns) args.push('--dns', body.dns);
    const result = await callProxypilot(args);
    if (result?.ok === false) return res.status(400).json(result);
    logAudit(req.user.id, 'VPN_ENABLE', 'vpn', null, {
      endpoint: body.endpoint,
      port: body.port ?? null,
      dns: body.dns ?? null,
      public_key: result?.public_key ?? null,
    }, req.ip);
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

vpnRouter.post('/disable', requireSudo, async (req, res) => {
  try {
    const result = await callProxypilot(['disable']);
    if (result?.ok === false) return res.status(400).json(result);
    logAudit(req.user.id, 'VPN_DISABLE', 'vpn', null, {
      already_disabled: !!result?.already_disabled,
    }, req.ip);
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── peer lifecycle ─────────────────────────────────────────────────────

const scopeSchema = z.enum(['full', 'admin', 'services']);
const serviceTagSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/);

const peerAddSchema = z.object({
  name: peerNameSchema,
  scope: scopeSchema.optional(),
  services: z.array(serviceTagSchema).max(32).optional(),
});

vpnRouter.post('/peers', requireSudo, async (req, res) => {
  let body;
  try { body = peerAddSchema.parse(req.body || {}); }
  catch (e) { return res.status(400).json({ ok: false, error: e.message }); }
  try {
    const args = ['peer', 'add', body.name];
    if (body.scope) args.push('--scope', body.scope);
    if (body.services?.length) args.push('--services', body.services.join(','));
    const result = await callProxypilot(args);
    if (result?.ok === false) return res.status(400).json(result);
    // The CLI's --json response carries `private_key` (the one-shot
    // delivery channel). Audit ONLY the public key + fingerprint
    // shape — never persist the private key, never log it.
    logAudit(req.user.id, 'VPN_PEER_ADD', 'vpn_peer', body.name, {
      scope: body.scope ?? 'admin',
      services: body.services ?? null,
      ip: result?.ip ?? null,
      public_key: result?.public_key ?? null,
    }, req.ip);
    // Forward the result verbatim so the frontend can render the QR
    // + config + private key once. The backend does not retain it.
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

vpnRouter.post('/peers/:name/rotate', requireSudo, async (req, res) => {
  try { peerNameSchema.parse(req.params.name); }
  catch (e) { return res.status(400).json({ ok: false, error: `bad peer name: ${e.message}` }); }
  try {
    const result = await callProxypilot(['peer', 'rotate', req.params.name]);
    if (result?.ok === false) return res.status(400).json(result);
    logAudit(req.user.id, 'VPN_PEER_ROTATE', 'vpn_peer', req.params.name, {
      ip: result?.ip ?? null,
      public_key: result?.public_key ?? null,
    }, req.ip);
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

vpnRouter.post('/peers/:name/enable', requireSudo, async (req, res) => {
  try { peerNameSchema.parse(req.params.name); }
  catch (e) { return res.status(400).json({ ok: false, error: `bad peer name: ${e.message}` }); }
  try {
    const result = await callProxypilot(['peer', 'enable', req.params.name]);
    if (result?.ok === false) return res.status(400).json(result);
    logAudit(req.user.id, 'VPN_PEER_ENABLE', 'vpn_peer', req.params.name, {
      already_enabled: !!result?.already_enabled,
    }, req.ip);
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

const forceSchema = z.object({ force: z.boolean().optional() });

vpnRouter.post('/peers/:name/disable', requireSudo, async (req, res) => {
  let body;
  try { peerNameSchema.parse(req.params.name); }
  catch (e) { return res.status(400).json({ ok: false, error: `bad peer name: ${e.message}` }); }
  try { body = forceSchema.parse(req.body || {}); }
  catch (e) { return res.status(400).json({ ok: false, error: e.message }); }
  try {
    const args = ['peer', 'disable', req.params.name];
    if (body.force) args.push('--force');
    const result = await callProxypilot(args);
    if (result?.ok === false) {
      if (LOCKOUT_CODES.has(result.code)) return lockoutResponse(res, result);
      return res.status(400).json(result);
    }
    logAudit(req.user.id, 'VPN_PEER_DISABLE', 'vpn_peer', req.params.name, {
      forced: !!body.force,
      already_disabled: !!result?.already_disabled,
    }, req.ip);
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

vpnRouter.delete('/peers/:name', requireSudo, async (req, res) => {
  let body;
  try { peerNameSchema.parse(req.params.name); }
  catch (e) { return res.status(400).json({ ok: false, error: `bad peer name: ${e.message}` }); }
  try { body = forceSchema.parse(req.body || {}); }
  catch (e) { return res.status(400).json({ ok: false, error: e.message }); }
  try {
    const args = ['peer', 'remove', req.params.name];
    if (body.force) args.push('--force');
    const result = await callProxypilot(args);
    if (result?.ok === false) {
      if (LOCKOUT_CODES.has(result.code)) return lockoutResponse(res, result);
      return res.status(400).json(result);
    }
    logAudit(req.user.id, 'VPN_PEER_REMOVE', 'vpn_peer', req.params.name, {
      forced: !!body.force,
      ip: result?.ip ?? null,
    }, req.ip);
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

const setScopeSchema = z.object({
  scope: scopeSchema,
  services: z.array(serviceTagSchema).max(32).optional(),
  force: z.boolean().optional(),
});

vpnRouter.post('/peers/:name/set-scope', requireSudo, async (req, res) => {
  let body;
  try { peerNameSchema.parse(req.params.name); }
  catch (e) { return res.status(400).json({ ok: false, error: `bad peer name: ${e.message}` }); }
  try { body = setScopeSchema.parse(req.body || {}); }
  catch (e) { return res.status(400).json({ ok: false, error: e.message }); }
  try {
    const args = ['peer', 'set-scope', req.params.name, body.scope];
    if (body.services?.length) args.push('--services', body.services.join(','));
    if (body.force) args.push('--force');
    const result = await callProxypilot(args);
    if (result?.ok === false) {
      if (LOCKOUT_CODES.has(result.code)) return lockoutResponse(res, result);
      return res.status(400).json(result);
    }
    logAudit(req.user.id, 'VPN_PEER_SET_SCOPE', 'vpn_peer', req.params.name, {
      scope: body.scope,
      services: body.services ?? null,
      forced: !!body.force,
      before: result?.before ?? null,
      after: result?.after ?? null,
    }, req.ip);
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});
