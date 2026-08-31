// Delegated editing — the restricted MCP endpoint, and its admin API.
//
// Two routers, mirroring the main server's shape:
//
//   createEditorMcpRouter()   — mounted at /api/mcp-editor, authenticated by a
//                               ppedit_ bearer token (header, or /t/<token> in
//                               the URL for claude.ai custom connectors, which
//                               cannot set headers). CSRF-exempt for the same
//                               reason the main endpoint is: no ambient cookie
//                               rides the request.
//   createEditorAdminRouter() — mounted at /api/lxc-editor behind the normal
//                               cookie session, admin only: activate a
//                               container, set its editable root, mint and
//                               revoke keys.
//
// A separate PATH rather than a separate port: ProxyPilot is one Express app
// behind one Caddy site, and a second listener would need its own firewall
// rule, its own TLS story and its own line in every deployment script for no
// isolation this path does not already give. The isolation that matters is the
// catalog, and that is a different object entirely (EDITOR_MCP_TOOLS), not a
// filter applied to the main one.
//
// WHAT MAKES THIS SAFE, in one place, because it is the whole point:
//
//   1. The container is read off the authenticated key row on every call. No
//      tool schema on this endpoint has a container parameter, so there is
//      nothing for a manipulated client to send. Arguments are never spread
//      into the underlying call — each handler's args object is BUILT here,
//      field by field, from the restricted schema plus server-derived values.
//   2. Every path is relative to the activation's docroot and is canonicalized
//      inside the guest before dispatch, so a symlink planted in the docroot
//      resolves and is rejected rather than followed.
//   3. Every auth-relevant fact is read from the database per request. Nothing
//      is cached, so revoking a key or flipping the toggle takes effect on the
//      very next call rather than when something expires.

import express from 'express';
import { logAudit } from '../db.js';
import { requireAdmin } from '../middleware/auth.js';
import {
  rpcResult, rpcError, toolResult,
  RPC_PARSE_ERROR, RPC_INVALID_REQUEST, RPC_METHOD_NOT_FOUND, RPC_INVALID_PARAMS, RPC_INTERNAL_ERROR,
  MCP_PROTOCOL_VERSION, MCP_KNOWN_VERSIONS, validSha256, validFileMode,
} from '../lib/mcp-logic.js';
import {
  EDITOR_MCP_TOOLS, EDITOR_TOOL_MAP, EDITOR_MCP_SERVER_INFO, EDITOR_MCP_INSTRUCTIONS,
  EDITOR_RATE, EDITOR_AUTH_FAIL_RATE, createRateLimiter,
  editorTokenFromRequest, validDelegatedPath, validDocroot, DEFAULT_DOCROOT,
  canonicalizePathScript, CANON_ERRORS, pathInsideRoot, redactDocroot,
  keyStatus, authRejection, EDITOR_TOKEN_DISPLAY_LEN,
} from '../lib/editor-keys-logic.js';
import {
  getActivation, listActivations, setActivation,
  createEditorKey, listEditorKeys, revokeEditorKey, getEditorKey,
  findEditorKeyByToken, touchEditorKey, logEditorCall, logEditorAuthFailure,
} from '../lib/editor-keys.js';
import { runDelegableLxcTool, lxcContainerExists, LXC_CONTAINER_PREFIX } from './mcp.js';
import { runHostCapture } from '../lib/lxc-zip.js';
import { getZipUpload } from '../lib/zip-staging.js';

const LXC_NAME_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9-]*$/;

// Messages one JSON-RPC batch may carry. Comfortably more than any client
// sends, and small enough that a batch cannot be used to queue unbounded work
// inside a single request.
const BATCH_MAX_MESSAGES = 20;

// ---- rate limiting ----
//
// Per key, so one noisy session cannot starve another, and per source IP for
// FAILED auth, so a leaked-token guessing attempt is expensive while a working
// key is not. Both are token buckets: a pause buys capacity back, which is what
// an interactive editing session actually looks like.
const callLimiter = createRateLimiter(EDITOR_RATE);
const authFailLimiter = createRateLimiter(EDITOR_AUTH_FAIL_RATE);
setInterval(() => { callLimiter.sweep(); authFailLimiter.sweep(); }, 5 * 60 * 1000).unref?.();

// req.ip, deliberately, and NOT X-Forwarded-For. ProxyPilot does not set
// Express's `trust proxy`, so an XFF header here would be attacker-controlled
// and would let a guessing client pick a fresh bucket per request — strictly
// worse than one shared bucket. Behind the bundled Caddy this therefore
// degrades to a single bucket for failed auth, which still costs an attacker
// their attempts and cannot lock out a WORKING key (a successful auth never
// touches this limiter). Noted in docs/features/delegated-editing.md.
function clientIp(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

/* --------------------------- authentication ------------------------------ */

/**
 * Resolve a request to { key, activation, docroot } or to a refusal.
 *
 * Every fact is fetched now: the key row, its revocation flag, the container's
 * activation and docroot. The container's EXISTENCE is checked by the caller,
 * and only for calls that actually touch it — `incus info` is a real process,
 * and initialize/tools/list do not need it.
 */
function authenticate(req, pathToken) {
  const token = editorTokenFromRequest({
    authorization: req.headers.authorization,
    pathToken: pathToken || '',
  });
  if (!token) return { status: 401, error: 'Unauthorized: supply a delegated editing key (Authorization: Bearer ppedit_…, or the tokenized URL).' };

  const key = findEditorKeyByToken(token);
  if (!key) return { status: 401, error: 'Unauthorized: this key is not recognised.' };

  // A key the holder can prove they have gets a truthful answer about WHY it
  // no longer works. There is nothing to protect: they already had the secret.
  if (key.revoked_at) {
    return { status: 403, key, error: authRejection('revoked', key.container_name) };
  }
  const activation = getActivation(key.container_name);
  if (!activation || !activation.active) {
    return { status: 403, key, error: authRejection('suspended', key.container_name) };
  }
  const docroot = validDocroot(activation.docroot);
  if (!docroot) {
    // Only reachable if the row were hand-edited; refusing beats guessing.
    return { status: 403, key, error: 'The editable directory configured for this key is not valid — ask the administrator to set it again.' };
  }
  return { key, activation, docroot };
}

/* --------------------- path confinement (per call) ------------------------ */

/**
 * Turn a path the key holder wrote into an absolute path proven to be inside
 * the docroot, or into an error.
 *
 * Two layers, and both are needed. The first rejects '..', backslashes and
 * control characters before anything runs. The second runs `cd -P && pwd -P`
 * IN THE GUEST, which is the only place a symlink can be resolved — a link
 * inside the docroot pointing at /etc looks like an ordinary relative path
 * from out here.
 */
async function confinePath(containerName, docroot, rawPath, { allowRoot = true } = {}) {
  const rel = validDelegatedPath(rawPath, { allowRoot });
  if (rel === null) {
    return { error: 'Invalid path: use a path relative to the editable root, with no ".." segments.' };
  }
  const r = await runHostCapture(
    'incus',
    ['exec', `${LXC_CONTAINER_PREFIX}${containerName}`, '--', 'sh', '-c', canonicalizePathScript(), 'sh', docroot, rel],
    { timeoutMs: 30000 },
  );
  if (r.status !== 0) {
    const known = CANON_ERRORS[r.status];
    if (known) return { error: known };
    return { error: `Could not resolve that path — is the container running? ${(r.stderr || '').trim().slice(-200)}` };
  }
  const abs = r.stdout.trim();
  // Belt and braces: the script already refused anything outside, but the
  // decision that matters is re-made here, on this side, from its output.
  if (!abs.startsWith('/') || !pathInsideRoot(docroot, abs)) {
    return { error: CANON_ERRORS[67] };
  }
  return { rel, abs };
}

/* ------------------------ result transformation --------------------------- */

/**
 * Rewrite a tool result into the holder's coordinate system before it leaves
 * the server: the docroot becomes '/', and a symlink pointing outside it loses
 * its target string.
 *
 * The docroot's real location is not something a delegated session gets to
 * learn — not from a path field, and not from the tail of an error message,
 * which is why the redaction runs over the serialized text rather than over a
 * list of fields somebody has to remember to extend.
 */
function delegatedResult(result, docroot) {
  const block = result?.content?.[0];
  if (!block || typeof block.text !== 'string') return result;

  let text = block.text;
  // A listing shows symlinks; `stat %N` puts their target in the entry. A
  // target outside the editable area is dropped rather than shown — the link
  // itself is the holder's to see, where it points is not.
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed?.entries)) {
      parsed.entries = parsed.entries.map((e) => {
        if (e?.type !== 'symlink' || !e.target) return e;
        const abs = e.target.startsWith('/') ? e.target : null;
        if (abs && !pathInsideRoot(docroot, abs)) {
          const { target, ...rest } = e;
          return { ...rest, target_hidden: true };
        }
        return e;
      });
      text = JSON.stringify(parsed, null, 2);
    }
  } catch { /* not JSON (a plain error string) — the redaction below still applies */ }

  return {
    ...result,
    content: [{ ...block, text: redactDocroot(text, docroot) }],
  };
}

/* ----------------------------- dispatch ---------------------------------- */

/**
 * Build the underlying handler's arguments from scratch.
 *
 * Nothing is spread from `args`. Every field is copied across by name, and the
 * container and the absolute paths come from the key row and the confinement
 * step — which is what makes an unexpected extra parameter in the request a
 * no-op rather than a question of whether the downstream handler ignores it.
 */
async function buildDelegatedCall(tool, args, ctx) {
  const { container_name: container } = ctx.key;
  const { docroot } = ctx;

  switch (tool) {
    case 'list_files': {
      const p = await confinePath(container, docroot, args.path ?? '', { allowRoot: true });
      if (p.error) return { error: p.error };
      return { path: p.rel, call: { container, path: p.abs, recursive: args.recursive === true } };
    }
    case 'read_file': {
      const p = await confinePath(container, docroot, args.path, { allowRoot: false });
      if (p.error) return { error: p.error };
      return { path: p.rel, call: { container, path: p.abs } };
    }
    case 'search_files': {
      const p = await confinePath(container, docroot, args.path ?? '', { allowRoot: true });
      if (p.error) return { error: p.error };
      return {
        path: p.rel,
        call: {
          container, path: p.abs,
          pattern: args.pattern,
          ...(args.glob != null && String(args.glob).trim() !== '' ? { glob: args.glob } : {}),
        },
      };
    }
    case 'write_file': {
      const p = await confinePath(container, docroot, args.path, { allowRoot: false });
      if (p.error) return { error: p.error };
      // Validated here so the refusal names the delegated parameter rather
      // than arriving from a handler the holder cannot see.
      if (args.expected_sha256 != null && String(args.expected_sha256).trim() !== ''
          && !validSha256(args.expected_sha256)) {
        return { error: 'expected_sha256 must be the 64-character hex sha256 that read_file returned.' };
      }
      if (args.mode != null && String(args.mode).trim() !== '' && !validFileMode(args.mode)) {
        return { error: 'mode must be three octal permission digits, e.g. "0644".' };
      }
      return {
        path: p.rel,
        call: {
          container, path: p.abs,
          content: String(args.content ?? ''),
          confirm_overwrite: args.confirm_overwrite === true,
          ...(args.expected_sha256 ? { expected_sha256: args.expected_sha256 } : {}),
          ...(args.mode ? { mode: args.mode } : {}),
        },
      };
    }
    case 'file_diff': {
      const p = await confinePath(container, docroot, args.path, { allowRoot: false });
      if (p.error) return { error: p.error };
      let against;
      if (args.against != null && String(args.against).trim() !== '') {
        const a = await confinePath(container, docroot, args.against, { allowRoot: false });
        if (a.error) return { error: a.error };
        against = a.abs;
      }
      return { path: p.rel, call: { container, path: p.abs, ...(against ? { against } : {}) } };
    }
    case 'restore_file': {
      const p = await confinePath(container, docroot, args.path, { allowRoot: false });
      if (p.error) return { error: p.error };
      return { path: p.rel, call: { container, path: p.abs, confirm: args.confirm === true } };
    }
    case 'inspect_zip': {
      const p = await confinePath(container, docroot, args.target_dir ?? '', { allowRoot: true });
      if (p.error) return { error: p.error };
      if (typeof args.zip_base64 !== 'string' || !args.zip_base64) {
        return { error: 'zip_base64 is required — this endpoint has no upload tickets, so the archive rides inline (up to ~2 MB).' };
      }
      return {
        path: p.rel,
        call: {
          container, target_dir: p.abs, zip_base64: args.zip_base64,
          ...(args.sha256 != null && String(args.sha256).trim() !== '' ? { sha256: args.sha256 } : {}),
        },
      };
    }
    case 'apply_zip': {
      const uploadId = String(args.upload_id || '');
      const rec = getZipUpload(uploadId, 'lxc', container);
      if (!rec) return { error: 'Upload not found or expired — inspect the zip again.' };
      // The staging store is shared with the main MCP server, and the docroot
      // may have been changed by the admin since the inspect. So the target
      // directory recorded on the staged upload is re-checked against the
      // CURRENT docroot here, rather than trusted because an earlier call
      // produced it.
      if (!pathInsideRoot(docroot, String(rec.targetDir || ''))) {
        return { error: 'That upload targets a directory outside the editable area — inspect the zip again.' };
      }
      return {
        path: null,
        call: {
          container, upload_id: uploadId,
          confirm_overwrite: args.confirm_overwrite === true,
          strip_wrapper: args.strip_wrapper !== false,
          // Not parameters on this endpoint, and pinned here so a future
          // change to the underlying handler's defaults cannot turn a
          // delegated file drop into code execution.
          run_startup: false,
          startup_script: null,
        },
      };
    }
    default:
      return { error: `Unknown tool: ${tool}` };
  }
}

async function callDelegatedTool(tool, args, ctx, req) {
  const built = await buildDelegatedCall(tool, args, ctx);
  if (built.error) {
    logEditorCall({ key: ctx.key, tool, path: args?.path ?? null, outcome: 'refused', ip: clientIp(req), extra: { reason: built.error } });
    return toolResult(built.error, { isError: true });
  }
  // The delegated caller has no ProxyPilot user account; the key id is the
  // identity that goes into the underlying handlers' own audit rows.
  const auth = { created_by: null, editor_key_id: ctx.key.id };
  const result = await runDelegableLxcTool(EDITOR_TOOL_MAP[tool], built.call, auth);
  logEditorCall({
    key: ctx.key, tool, path: built.path, ip: clientIp(req),
    outcome: result?.isError ? 'error' : 'ok',
  });
  return delegatedResult(result, ctx.docroot);
}

/* ---------------------------- JSON-RPC core ------------------------------ */

async function handleEditorRpc(message, ctx, req) {
  if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return rpcError(message?.id, RPC_INVALID_REQUEST, 'Invalid JSON-RPC request');
  }
  const { id, method, params } = message;
  const isNotification = id === undefined || id === null;

  switch (method) {
    case 'initialize': {
      const requested = params?.protocolVersion;
      const version = MCP_KNOWN_VERSIONS.includes(requested) ? requested : MCP_PROTOCOL_VERSION;
      return rpcResult(id, {
        protocolVersion: version,
        capabilities: { tools: {} },
        serverInfo: EDITOR_MCP_SERVER_INFO,
        instructions: EDITOR_MCP_INSTRUCTIONS,
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;
    case 'tools/list':
      return rpcResult(id, { tools: EDITOR_MCP_TOOLS });
    case 'tools/call': {
      const name = params?.name;
      // The catalog IS the dispatch table. A name that is not in it was never
      // registered on this endpoint, so there is nothing to deny — it simply
      // does not resolve, exactly as an unknown method would on any server.
      if (!Object.prototype.hasOwnProperty.call(EDITOR_TOOL_MAP, name)) {
        logEditorCall({ key: ctx.key, tool: String(name).slice(0, 60), outcome: 'unknown_tool', ip: clientIp(req) });
        return rpcError(id, RPC_INVALID_PARAMS, `Unknown tool: ${name}`);
      }
      // The rate limit is charged HERE, per call, and not once per HTTP
      // request: a JSON-RPC batch is an array of messages, so charging the
      // request would let one POST carrying two hundred calls through for the
      // price of one. Protocol chatter (initialize, ping, tools/list) is left
      // to the global /api/ limiter — it touches nothing.
      const wait = callLimiter.take(`key:${ctx.key.id}`);
      if (wait) {
        logEditorCall({ key: ctx.key, tool: String(name).slice(0, 60), outcome: 'throttled', ip: clientIp(req) });
        return rpcResult(id, toolResult(`Rate limit reached for this key — retry in ${wait}s.`, { isError: true }));
      }
      // Checked per call, never cached: a container deleted a second ago must
      // fail now, not when a TTL runs out.
      const exists = await lxcContainerExists(ctx.key.container_name);
      if (exists === false) {
        return rpcResult(id, toolResult(authRejection('orphaned', ctx.key.container_name), { isError: true }));
      }
      if (exists === null) {
        return rpcResult(id, toolResult('Cannot reach the container host right now — try again shortly.', { isError: true }));
      }
      try {
        return rpcResult(id, await callDelegatedTool(name, params?.arguments || {}, ctx, req));
      } catch (err) {
        console.error(`[mcp-editor] tool ${name} failed:`, err?.message || err);
        return rpcResult(id, toolResult(`Tool failed: ${err?.message || 'unknown error'}`, { isError: true }));
      }
    }
    default:
      if (isNotification) return null;
      return rpcError(id, RPC_METHOD_NOT_FOUND, `Method not found: ${method}`);
  }
}

export function createEditorMcpRouter() {
  const router = express.Router();

  const endpoint = (usePathToken) => async (req, res) => {
    const ip = clientIp(req);
    const ctx = authenticate(req, usePathToken ? req.params.token : '');
    if (ctx.error) {
      // Only FAILED auth is IP-limited, so a working key's session is never
      // throttled by somebody else's guessing from behind the same NAT.
      const wait = authFailLimiter.take(ip);
      // The display prefix, so an admin can tell "Sarah's revoked key is still
      // being used" from "somebody is guessing". When the key was not found
      // there is no row to take it from, so it comes off the header — bounded
      // to the same 14 characters the list already shows, never the whole
      // secret.
      logEditorAuthFailure({
        reason: ctx.error, ip,
        prefix: ctx.key?.token_prefix || String(req.headers.authorization || '').slice(7, 7 + EDITOR_TOKEN_DISPLAY_LEN),
      });
      if (wait) {
        res.set('Retry-After', String(wait));
        return res.status(429).json({ error: 'Too many failed attempts — slow down.' });
      }
      return res.status(ctx.status).json({ error: ctx.error });
    }
    if (req.method === 'GET' || req.method === 'DELETE') {
      return res.status(405).json({ error: 'Method not allowed — POST JSON-RPC messages to this endpoint' });
    }
    touchEditorKey(ctx.key.id);

    const body = req.body;
    if (body == null || typeof body !== 'object') {
      return res.status(400).json(rpcError(null, RPC_PARSE_ERROR, 'Body must be a JSON-RPC message'));
    }
    try {
      if (Array.isArray(body)) {
        // A bound on the work one request can queue, on top of the per-call
        // rate limit each message inside it still pays.
        if (body.length > BATCH_MAX_MESSAGES) {
          return res.status(400).json(rpcError(null, RPC_INVALID_REQUEST,
            `A batch may carry at most ${BATCH_MAX_MESSAGES} messages`));
        }
        const responses = (await Promise.all(body.map((m) => handleEditorRpc(m, ctx, req)))).filter(Boolean);
        if (responses.length === 0) return res.status(202).end();
        return res.json(responses);
      }
      const response = await handleEditorRpc(body, ctx, req);
      if (response == null) return res.status(202).end();
      return res.json(response);
    } catch (err) {
      console.error('[mcp-editor] request failed:', err?.message || err);
      return res.status(500).json(rpcError(body?.id ?? null, RPC_INTERNAL_ERROR, 'Internal error'));
    }
  };

  router.all('/t/:token', express.json({ limit: '8mb' }), endpoint(true));
  router.all('/', express.json({ limit: '8mb' }), endpoint(false));
  return router;
}

/* ------------------------------ admin API -------------------------------- */

function publicBaseUrl(req) {
  const host = req.get('host');
  const proto = req.get('x-forwarded-proto') || req.protocol || 'https';
  return `${proto}://${host}`;
}

/** The key row as the admin UI shows it — never the hash, never the token. */
function shapeKey(row, { activationActive, containerExists }) {
  return {
    id: row.id,
    container_name: row.container_name,
    label: row.label,
    token_prefix: row.token_prefix,
    created_at: row.created_at,
    last_used_at: row.last_used_at,
    revoked_at: row.revoked_at,
    status: keyStatus(row, { activationActive, containerExists }),
  };
}

export function createEditorAdminRouter() {
  const router = express.Router();

  // Every container's activation at once — the LXC list page uses it to badge
  // which containers have delegated editing on without a call per row.
  router.get('/activations', requireAdmin, (req, res) => {
    res.json({
      activations: listActivations().map((a) => ({
        container_name: a.container_name,
        docroot: a.docroot,
        active: !!a.active,
        updated_at: a.updated_at,
      })),
      default_docroot: DEFAULT_DOCROOT,
    });
  });

  // One container: its activation plus its keys, with each key's live status.
  router.get('/:container', requireAdmin, async (req, res) => {
    const name = String(req.params.container);
    if (!LXC_NAME_REGEX.test(name)) return res.status(400).json({ error: 'Invalid container name' });
    const activation = getActivation(name);
    const exists = await lxcContainerExists(name);
    const rows = listEditorKeys(name);
    res.json({
      container_name: name,
      // null while the host cannot be asked — the UI says "unknown" rather
      // than showing every key as orphaned because incus was busy.
      container_exists: exists,
      default_docroot: DEFAULT_DOCROOT,
      activation: activation
        ? { docroot: activation.docroot, active: !!activation.active, updated_at: activation.updated_at }
        : null,
      endpoint: `${publicBaseUrl(req)}/api/mcp-editor`,
      keys: rows.map((r) => shapeKey(r, {
        activationActive: !!activation?.active,
        containerExists: exists !== false,
      })),
    });
  });

  // Activate / deactivate, and set the editable root. Activation cannot
  // complete without a docroot (setActivation enforces it); deactivating
  // suspends every key for this container at once and is reversible.
  router.put('/:container/activation', requireAdmin, async (req, res) => {
    const name = String(req.params.container);
    if (!LXC_NAME_REGEX.test(name)) return res.status(400).json({ error: 'Invalid container name' });
    const exists = await lxcContainerExists(name);
    if (exists === false) return res.status(404).json({ error: `No container named ${name}` });
    if (exists === null) return res.status(503).json({ error: 'Cannot reach the container host right now — try again shortly.' });

    const active = req.body?.active !== false;
    const docroot = req.body?.docroot === undefined ? undefined : String(req.body.docroot);
    const r = setActivation({ containerName: name, docroot, active, createdBy: req.user.id });
    if (r.error) return res.status(400).json({ error: r.error });
    logAudit(req.user.id, active ? 'LXC_EDITOR_ACTIVATED' : 'LXC_EDITOR_DEACTIVATED', 'lxc', name, {
      docroot: r.activation.docroot,
    }, req.ip);
    res.json({
      activation: { docroot: r.activation.docroot, active: !!r.activation.active, updated_at: r.activation.updated_at },
    });
  });

  // Mint a key. The plaintext token — and the ready-to-paste connector URL —
  // is in this response and nowhere else, ever again.
  router.post('/:container/keys', requireAdmin, async (req, res) => {
    const name = String(req.params.container);
    if (!LXC_NAME_REGEX.test(name)) return res.status(400).json({ error: 'Invalid container name' });
    // A key may only ever be created for a container that exists RIGHT NOW.
    const exists = await lxcContainerExists(name);
    if (exists === false) return res.status(404).json({ error: `No container named ${name} — a key can only be created for a container that exists.` });
    if (exists === null) return res.status(503).json({ error: 'Cannot reach the container host right now — try again shortly.' });

    const activation = getActivation(name);
    if (!activation) {
      return res.status(409).json({ error: 'Turn delegated editing on for this container first — a key needs an editable directory to be scoped to.' });
    }
    const label = String(req.body?.label || '').trim().slice(0, 120);
    if (!label) return res.status(400).json({ error: 'A label is required — it is how you will recognise this key later.' });

    const { token, row } = createEditorKey({ containerName: name, label, createdBy: req.user.id });
    logAudit(req.user.id, 'LXC_EDITOR_KEY_CREATED', 'lxc', name, {
      key_id: row.id, label, token_prefix: row.token_prefix, docroot: activation.docroot,
    }, req.ip);
    const base = publicBaseUrl(req);
    res.status(201).json({
      key: shapeKey(row, { activationActive: !!activation.active, containerExists: true }),
      token,
      endpoint: `${base}/api/mcp-editor`,
      connector_url: `${base}/api/mcp-editor/t/${token}`,
      docroot: activation.docroot,
      note: 'Copy this key now — it is shown only once and cannot be recovered.',
    });
  });

  // Revocation: permanent, immediate, and the row stays for the audit trail.
  router.delete('/:container/keys/:id', requireAdmin, (req, res) => {
    const name = String(req.params.container);
    const row = getEditorKey(req.params.id);
    if (!row || row.container_name !== name) return res.status(404).json({ error: 'Key not found' });
    if (!revokeEditorKey(row.id)) return res.status(409).json({ error: 'Key is already revoked' });
    logAudit(req.user.id, 'LXC_EDITOR_KEY_REVOKED', 'lxc', name, {
      key_id: row.id, label: row.label, token_prefix: row.token_prefix,
    }, req.ip);
    res.json({ revoked: true });
  });

  return router;
}
