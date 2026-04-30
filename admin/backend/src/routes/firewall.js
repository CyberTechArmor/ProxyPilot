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
// consistent with the services.js / lxc.js / ssh-access.js pattern,
// every state-mutating call shells out to /usr/local/bin/proxypilot
// via nsenter so the action lands on the host's CLI database, audit
// log, and firewall.json. The CLI's --json mode is the stable
// contract.
const isInDocker = existsSync('/.dockerenv') || process.env.DOCKER_CONTAINER === 'true';
const PROXYPILOT_BIN = process.env.PROXYPILOT_BIN || '/usr/local/bin/proxypilot';

async function execOnHost(command, { timeout = 20000 } = {}) {
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
 * etc. Every operator-supplied value (rule id, reason text, source
 * cidr, service name, container name) is passed through this helper
 * before joining with spaces.
 */
function shellSingleQuote(s) {
  if (s === undefined || s === null) return "''";
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/**
 * Run `proxypilot --json firewall <args>` on the host and return the
 * parsed JSON result. The CLI exits non-zero on validation failures
 * AND on reconcile rejections; in --json mode it normally emits a
 * structured `{ ok: false, error: ... }` body before exiting, so we
 * capture stdout regardless of exit status and parse first. Some
 * firewall toggle paths still emit non-JSON `output.error` text on
 * pre-mutation validation failures (a known gap in the CLI's --json
 * contract); those surface here as a 500 with the raw error string.
 */
async function callProxypilot(args, { timeout } = {}) {
  // Every token is wrapped in POSIX single-quote escaping so embedded
  // shell metacharacters cannot break out of the argv list. Do NOT
  // switch this back to JSON.stringify — JSON's double-quote form
  // leaves $() and backticks live for shell command substitution,
  // which would let a reason like `$(rm -rf /)` execute as root in
  // the host PID namespace.
  const cmd = [shellSingleQuote(PROXYPILOT_BIN), '--json', 'firewall', ...args.map(shellSingleQuote)].join(' ');
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
    throw new Error(stderr || stdout || e.message || 'proxypilot firewall failed');
  }
  const out = (result.stdout || '').toString();
  try {
    return JSON.parse(out);
  } catch {
    throw new Error(`proxypilot firewall produced non-JSON output: ${out.slice(0, 200)}`);
  }
}

export const firewallRouter = Router();

firewallRouter.use(requireAdmin);

// ── reads ──────────────────────────────────────────────────────────────
// `firewall list --json` returns a bare array of rule objects (no
// {ok, entries} wrap); `status --json` returns a bare object. Both
// are lifted into a uniform `{ ok: true, ... }` shape here so the
// frontend never has to discriminate by absence of a key.

firewallRouter.get('/', async (_req, res) => {
  try {
    const [rules, status] = await Promise.all([
      callProxypilot(['list', '--all']),
      callProxypilot(['status']),
    ]);
    if (Array.isArray(rules)) {
      res.json({ ok: true, status, rules });
    } else if (rules && rules.ok === false) {
      res.status(400).json(rules);
    } else {
      // Defensive: unexpected shape.
      res.json({ ok: true, status, rules: rules?.rules ?? [] });
    }
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

firewallRouter.get('/status', async (_req, res) => {
  try {
    const status = await callProxypilot(['status']);
    if (status && status.ok === false) return res.status(400).json(status);
    res.json({ ok: true, status });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

firewallRouter.get('/egress', async (_req, res) => {
  try {
    const result = await callProxypilot(['egress', 'list']);
    if (result && result.ok === false) return res.status(400).json(result);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── mutations ──────────────────────────────────────────────────────────

const ruleIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const scopeSchema = z.enum(['public', 'lan-only', 'vpn-only', 'localhost-only']);
const cidrSchema = z.string().min(1).max(64).regex(/^[0-9A-Fa-f.:/]+$/);
const protoSchema = z.enum(['tcp', 'udp']);
const serviceSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/);
const reasonSchema = z.string().min(1).max(255);
const containerSchema = z.string().min(1).max(63).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const portSchema = z.number().int().min(1).max(65535);

function handleToggleResult(res, result) {
  // toggle.js emits `{ ok, action, rule, warnings, reconcile }` on
  // success; on a reconcile rejection it emits `{ ok: false, action,
  // rule, reconcile_error|reconcile.rejection }`. Surface 200 only
  // when the reconcile actually applied; otherwise 400 so the
  // dashboard can show the rejection reason.
  if (!result || result.ok === false) {
    return res.status(400).json(result ?? { ok: false, error: 'no result' });
  }
  res.json(result);
}

const enableSchema = z.object({
  scope: scopeSchema.optional(),
  service: serviceSchema.optional().nullable(),
  source_cidrs: z.array(cidrSchema).max(64).optional(),
  // The frontend collects the "open this port to the public internet"
  // typed-phrase confirmation client-side, then echoes confirm:true
  // here. The CLI's interactive prompt is bypassed by passing --yes;
  // we only do that when the dashboard signals confirmation.
  confirm: z.boolean().optional(),
});

firewallRouter.post('/:id/enable', requireSudo, async (req, res) => {
  let body;
  try { ruleIdSchema.parse(req.params.id); }
  catch (e) { return res.status(400).json({ ok: false, error: `bad id: ${e.message}` }); }
  try { body = enableSchema.parse(req.body || {}); }
  catch (e) { return res.status(400).json({ ok: false, error: e.message }); }
  try {
    const args = ['enable', req.params.id];
    if (body.scope) args.push('--scope', body.scope);
    if (body.service) args.push('--service', body.service);
    for (const cidr of body.source_cidrs ?? []) args.push('--source-cidr', cidr);
    // Always pass --yes — the CLI's interactive y/N is meaningless
    // over JSON anyway, and the dashboard handles the public-internet
    // typed-phrase confirm before issuing the call.
    args.push('--yes');
    const result = await callProxypilot(args);
    if (result?.ok) {
      logAudit(req.user.id, 'FIREWALL_RULE_ENABLE', 'firewall_rule', req.params.id, {
        scope: body.scope ?? null,
        service: body.service ?? null,
        source_cidrs: body.source_cidrs ?? [],
        confirm: !!body.confirm,
      }, req.ip);
    }
    handleToggleResult(res, result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

firewallRouter.post('/:id/disable', requireSudo, async (req, res) => {
  try { ruleIdSchema.parse(req.params.id); }
  catch (e) { return res.status(400).json({ ok: false, error: `bad id: ${e.message}` }); }
  try {
    const result = await callProxypilot(['disable', req.params.id]);
    if (result?.ok) {
      logAudit(req.user.id, 'FIREWALL_RULE_DISABLE', 'firewall_rule', req.params.id, {}, req.ip);
    }
    handleToggleResult(res, result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

const setScopeSchema = z.object({
  scope: scopeSchema,
  service: serviceSchema.optional().nullable(),
  source_cidrs: z.array(cidrSchema).max(64).optional(),
});

firewallRouter.post('/:id/set-scope', requireSudo, async (req, res) => {
  let body;
  try { ruleIdSchema.parse(req.params.id); }
  catch (e) { return res.status(400).json({ ok: false, error: `bad id: ${e.message}` }); }
  try { body = setScopeSchema.parse(req.body || {}); }
  catch (e) { return res.status(400).json({ ok: false, error: e.message }); }
  try {
    const args = ['set-scope', req.params.id, body.scope];
    if (body.service) args.push('--service', body.service);
    for (const cidr of body.source_cidrs ?? []) args.push('--source-cidr', cidr);
    const result = await callProxypilot(args);
    if (result?.ok) {
      logAudit(req.user.id, 'FIREWALL_RULE_SET_SCOPE', 'firewall_rule', req.params.id, {
        scope: body.scope,
        service: body.service ?? null,
        source_cidrs: body.source_cidrs ?? [],
      }, req.ip);
    }
    handleToggleResult(res, result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

const manualSchema = z.object({
  port_start: portSchema,
  port_end: portSchema.optional().nullable(),
  proto: protoSchema,
  scope: scopeSchema,
  reason: reasonSchema,
  service: serviceSchema.optional().nullable(),
  source_cidrs: z.array(cidrSchema).max(64).optional(),
});

firewallRouter.post('/manual', requireSudo, async (req, res) => {
  let body;
  try { body = manualSchema.parse(req.body || {}); }
  catch (e) { return res.status(400).json({ ok: false, error: e.message }); }
  try {
    const args = [
      'add-manual',
      '--port', String(body.port_start),
      '--proto', body.proto,
      '--scope', body.scope,
      '--reason', body.reason,
    ];
    if (body.port_end != null) args.push('--port-end', String(body.port_end));
    if (body.service) args.push('--service', body.service);
    for (const cidr of body.source_cidrs ?? []) args.push('--source-cidr', cidr);
    const result = await callProxypilot(args);
    if (result?.ok) {
      logAudit(req.user.id, 'FIREWALL_RULE_ADD_MANUAL', 'firewall_rule', result.rule?.id ?? null, {
        port_start: body.port_start,
        port_end: body.port_end ?? null,
        proto: body.proto,
        scope: body.scope,
        reason: body.reason,
        service: body.service ?? null,
        source_cidrs: body.source_cidrs ?? [],
      }, req.ip);
    }
    handleToggleResult(res, result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

firewallRouter.delete('/manual/:id', requireSudo, async (req, res) => {
  try { ruleIdSchema.parse(req.params.id); }
  catch (e) { return res.status(400).json({ ok: false, error: `bad id: ${e.message}` }); }
  try {
    const result = await callProxypilot(['remove-manual', req.params.id]);
    if (result?.ok) {
      logAudit(req.user.id, 'FIREWALL_RULE_REMOVE_MANUAL', 'firewall_rule', req.params.id, {}, req.ip);
    }
    handleToggleResult(res, result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

const reconcileSchema = z.object({ dry_run: z.boolean().optional() });

firewallRouter.post('/reconcile', requireSudo, async (req, res) => {
  let body;
  try { body = reconcileSchema.parse(req.body || {}); }
  catch (e) { return res.status(400).json({ ok: false, error: e.message }); }
  try {
    const args = ['reconcile'];
    if (body.dry_run) args.push('--dry-run');
    const result = await callProxypilot(args);
    if (result?.ok === false) return res.status(400).json(result);
    if (!body.dry_run && result?.ok) {
      logAudit(req.user.id, 'FIREWALL_RECONCILE', 'firewall', null, {
        rule_count: result.rule_count ?? null,
        checksum: result.checksum ?? null,
      }, req.ip);
    }
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

firewallRouter.post('/scan', requireSudo, async (req, res) => {
  try {
    const result = await callProxypilot(['scan']);
    if (result?.ok === false) return res.status(400).json(result);
    logAudit(req.user.id, 'FIREWALL_SCAN', 'firewall', null, {
      added: result?.added ?? 0,
      refreshed: result?.refreshed ?? 0,
      gc: result?.gc ?? 0,
    }, req.ip);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

firewallRouter.post('/panic-close', requireSudo, async (req, res) => {
  try {
    // --yes bypasses the CLI's interactive y/N (meaningless over JSON).
    // The dashboard collects the typed-phrase confirm client-side
    // before issuing the call.
    const result = await callProxypilot(['panic-close', '--yes']);
    if (result?.ok === false) return res.status(400).json(result);
    logAudit(req.user.id, 'FIREWALL_PANIC_CLOSE', 'firewall', null, {
      rule_count: result?.rule_count ?? null,
      checksum: result?.checksum ?? null,
    }, req.ip);
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

firewallRouter.post('/panic-open', requireSudo, async (req, res) => {
  try {
    const result = await callProxypilot(['panic-open']);
    if (result?.ok === false) return res.status(400).json(result);
    logAudit(req.user.id, 'FIREWALL_PANIC_OPEN', 'firewall', null, {
      already_open: !!result?.alreadyOpen,
    }, req.ip);
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── per-container egress allow/deny ────────────────────────────────────
// The CLI's egress allow/deny take a NAMED service (one of the
// NAMED_SERVICES the firewall renderer knows) plus a container name
// and an optional pinned container ip. The spec listed
// `{container, target_cidr, proto, port}`, but no such CLI surface
// exists and inventing one here would either bypass the rendering
// path or duplicate it. Wire to the actual contract.

const egressSchema = z.object({
  container: containerSchema,
  service: serviceSchema,
  reason: reasonSchema.optional().nullable(),
  container_ip: z.string().min(1).max(64).regex(/^[0-9A-Fa-f.:/]+$/).optional().nullable(),
});

firewallRouter.post('/egress/allow', requireSudo, async (req, res) => {
  let body;
  try { body = egressSchema.parse(req.body || {}); }
  catch (e) { return res.status(400).json({ ok: false, error: e.message }); }
  try {
    const args = ['egress', 'allow', body.container, body.service];
    if (body.reason) args.push('--reason', body.reason);
    if (body.container_ip) args.push('--container-ip', body.container_ip);
    const result = await callProxypilot(args);
    if (result?.ok === false) return res.status(400).json(result);
    logAudit(req.user.id, 'FIREWALL_EGRESS_ALLOW', 'firewall_egress', `${body.container}:${body.service}`, {
      reason: body.reason ?? null,
      container_ip: body.container_ip ?? null,
    }, req.ip);
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

const egressDenySchema = z.object({
  container: containerSchema,
  service: serviceSchema,
});

firewallRouter.post('/egress/deny', requireSudo, async (req, res) => {
  let body;
  try { body = egressDenySchema.parse(req.body || {}); }
  catch (e) { return res.status(400).json({ ok: false, error: e.message }); }
  try {
    const args = ['egress', 'deny', body.container, body.service];
    const result = await callProxypilot(args);
    if (result?.ok === false) return res.status(400).json(result);
    logAudit(req.user.id, 'FIREWALL_EGRESS_DENY', 'firewall_egress', `${body.container}:${body.service}`, {}, req.ip);
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});
