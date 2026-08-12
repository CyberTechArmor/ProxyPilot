// ProxyPilot MCP server — PURE protocol + catalog layer (native-free).
//
// ProxyPilot exposes a remote MCP server (Model Context Protocol, Streamable
// HTTP transport) so an AI client on a Claude subscription — claude.ai custom
// connectors, Claude Desktop, Claude Code — can operate the parts of
// ProxyPilot an operator would otherwise drive by hand: deploy zips to static
// sites and LXC containers (with the same two-phase inspect → confirm →
// apply flow the UI uses), and list/build/clone AI-dev projects.
//
// This module is the pure half: JSON-RPC envelope helpers, the tool catalog
// (names, descriptions, input schemas), and token shape/hash helpers. The
// impure dispatch (auth lookup, host commands, DB) lives in routes/mcp.js.
//
// Transport notes (kept deliberately minimal, per the 2025-03-26 spec):
// - POST with a single JSON-RPC request → application/json response body.
// - Notifications (no id) → 202 with no body.
// - GET (server-initiated stream) is not offered → 405, which the spec
//   explicitly allows; every feature here is plain request/response.

import { createHash, randomBytes } from 'node:crypto';

export const MCP_PROTOCOL_VERSION = '2025-03-26';
// Versions we accept from clients (echoed back when known; otherwise we answer
// with our own and the client may disconnect per spec).
export const MCP_KNOWN_VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18'];

export const MCP_SERVER_INFO = { name: 'proxypilot', version: '1.0.0' };

// ---- JSON-RPC helpers ----

export function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

export function rpcError(id, code, message, data) {
  const err = { code, message };
  if (data !== undefined) err.data = data;
  return { jsonrpc: '2.0', id: id ?? null, error: err };
}

export const RPC_PARSE_ERROR = -32700;
export const RPC_INVALID_REQUEST = -32600;
export const RPC_METHOD_NOT_FOUND = -32601;
export const RPC_INVALID_PARAMS = -32602;
export const RPC_INTERNAL_ERROR = -32603;

// A tool RESULT that carries structured data: MCP tool results are content
// blocks; we return one text block of pretty JSON (every client renders it,
// and Claude reads it natively). isError marks tool-level failures so the
// model sees them as tool output, not protocol errors.
export function toolResult(data, { isError = false } = {}) {
  return {
    content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }],
    isError,
  };
}

// ---- access tokens ----

// ppmcp_<64 hex> — the URL-safe bearer secret. Stored server-side only as a
// sha256 hash; shown to the operator exactly once at mint time.
export function mintMcpToken(rand = () => randomBytes(32).toString('hex')) {
  return `ppmcp_${rand()}`;
}

export function hashMcpToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

export function looksLikeMcpToken(token) {
  return /^ppmcp_[0-9a-f]{64}$/.test(String(token || ''));
}

// Extract the bearer token from a request: Authorization header first
// (Claude Desktop / Claude Code / SDK clients), then the tokenized-URL path
// segment (claude.ai custom connectors can't set headers — the connector URL
// is https://<host>/api/mcp/t/<token>).
export function tokenFromRequest({ authorization = '', pathToken = '' } = {}) {
  const m = /^Bearer\s+(\S+)$/i.exec(String(authorization || '').trim());
  if (m && looksLikeMcpToken(m[1])) return m[1];
  if (looksLikeMcpToken(pathToken)) return pathToken;
  return null;
}

// ---- upload tickets (zip transfer) ----
//
// Tool arguments are JSON, so multi-MB zips would bloat 4/3× as base64 and
// trip message-size limits. The two-step path: `create_upload_ticket` returns
// a short-lived ticket + URL; the client PUTs the raw zip bytes there, then
// references the ticket in inspect_*_zip. Small zips (≤ ~2 MB decoded) may
// instead ride inline as `zip_base64`.

export const UPLOAD_TICKET_TTL_MS = 30 * 60 * 1000;
export const INLINE_ZIP_MAX_BYTES = 2 * 1024 * 1024;

export function mintUploadTicket(rand = () => randomBytes(24).toString('hex')) {
  return `ppup_${rand()}`;
}

export function looksLikeUploadTicket(t) {
  return /^ppup_[0-9a-f]{48}$/.test(String(t || ''));
}

// ---- zip integrity (transport checksum) ----
//
// Inline base64 was observed corrupting in the field ("Zip entry size mismatch
// (declared 3472, got 3460)") with nothing in the transport saying so — the
// damage surfaced as a confusing EXTRACTION error. An optional sha256 on the
// inspect tools (and a mandatory one on finish_upload) turns that into a
// transport-corruption error BEFORE any bytes touch a target.

export function validSha256(s) {
  const v = String(s ?? '').trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(v) ? v : null;
}

export function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/** null when the bytes match the declared checksum; a caller-facing message
 *  when they don't (or the declared value isn't a sha256 at all). */
export function zipChecksumError(buf, declared) {
  const want = validSha256(declared);
  if (!want) return 'sha256 must be the 64-character hex SHA-256 of the zip bytes';
  const got = sha256Hex(buf);
  if (got === want) return null;
  return `Zip bytes do not match the declared sha256 — the transfer corrupted them `
    + `(declared ${want}, got ${got} over ${buf.length} bytes). Re-send the archive and inspect again.`;
}

// ---- chunked upload fallback ----
//
// The documented big-zip path (create_upload_ticket → PUT raw bytes) assumes
// the client can reach the upload URL — egress-restricted agent sandboxes
// often cannot (observed: CONNECT 403 to the edge host). These helpers back
// append_upload_chunk/finish_upload, which deliver the same bytes through the
// already-working MCP channel in ordered base64 chunks.

// Decoded per-chunk cap. The MCP endpoint accepts 8 MB JSON bodies; 4 MB of
// payload is ~5.4 MB as base64, leaving comfortable envelope headroom.
export const UPLOAD_CHUNK_MAX_BYTES = 4 * 1024 * 1024;

export function normalizeChunkSeq(seq) {
  const n = Number(seq);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

export function decodeChunkBase64(s, cap = UPLOAD_CHUNK_MAX_BYTES) {
  const raw = String(s ?? '').replace(/\s+/g, '');
  if (!raw) return { error: 'chunk_base64 is required and must not be empty' };
  if (!/^[A-Za-z0-9+/]+=*$/.test(raw)) return { error: 'chunk_base64 is not valid base64' };
  const buf = Buffer.from(raw, 'base64');
  if (buf.length === 0) return { error: 'chunk_base64 decoded to zero bytes' };
  if (buf.length > cap) {
    return { error: `Chunks are limited to ${Math.floor(cap / (1024 * 1024))} MB decoded — split the archive into smaller chunks` };
  }
  return { buf };
}

// ---- LXC container listing ----
//
// Field defect: list_lxc_containers answered `[]` while a live, name-addressed
// guest was serving traffic — the incus failure (non-zero exit, or JSON made
// unparseable by the 256 KB host-capture cap) was swallowed and presented as
// an empty host, and the caller planned to CREATE a duplicate container on the
// strength of it. An empty list and a failed list are different answers; these
// helpers keep them apart.

export function parseLxcListJson(stdout) {
  let list;
  try {
    list = JSON.parse(String(stdout || ''));
  } catch {
    return { error: 'unparseable JSON (output may have been truncated)' };
  }
  if (!Array.isArray(list)) return { error: 'a JSON value that is not an array' };
  return { list };
}

/** First global IPv4 on an interface, preferring eth0 but not assuming it —
 *  a guest with a renamed or macvlan NIC still has an address worth showing. */
export function lxcContainerIp(state) {
  const nets = state?.network || {};
  const inet = (iface) => nets[iface]?.addresses
    ?.find((a) => a.family === 'inet' && a.scope !== 'local')?.address || null;
  const eth0 = inet('eth0');
  if (eth0) return eth0;
  for (const name of Object.keys(nets)) {
    if (name === 'lo') continue;
    const addr = inet(name);
    if (addr) return addr;
  }
  return null;
}

export function lxcContainerSummaries(list, prefix) {
  const seen = new Set();
  const out = [];
  for (const c of Array.isArray(list) ? list : []) {
    const full = String(c?.name || '');
    if (!full.startsWith(prefix)) continue;
    const name = full.slice(prefix.length);
    if (!name || seen.has(name)) continue;   // --all-projects can repeat a name
    seen.add(name);
    out.push({ name, status: c.status || null, ip: lxcContainerIp(c.state) });
  }
  return out;
}

// ---- run_lxc_command: the policy-driven allowlist ----
//
// Same posture as parseProjectCommand, generalized to a data-driven policy
// (lib/mcp-policy/lxc-command-allowlist.json — the enforcement source of
// truth; the tool description only summarizes it). Matching is on argv
// prefix after whitespace-split; no shell ever sees the tokens. deny_always
// wins over any allow rule. mutating_scoped commands are legal only when the
// effective working dir IS the guest's registered startup working dir, so an
// agent can manage the app it deployed and nothing else.

function argvHasPrefix(argv, prefix) {
  if (!Array.isArray(prefix) || prefix.length === 0 || prefix.length > argv.length) return false;
  return prefix.every((tok, i) => argv[i] === tok);
}

// Deny entries also match LOOSELY: same head token + every remaining deny
// token present anywhere in the argv. Strict prefix alone would let
// `curl -sS -o /tmp/x` slip past the ["curl","-o"] entry by reordering
// flags — and curl's output flags are denied precisely because writing
// fetched bytes to disk is arbitrary code delivery.
function argvMatchesDeny(argv, prefix) {
  if (argvHasPrefix(argv, prefix)) return true;
  if (!Array.isArray(prefix) || prefix.length < 2) return false;
  if (argv[0] !== prefix[0]) return false;
  return prefix.slice(1).every((tok) => argv.includes(tok));
}

const LXC_SAFE_ARG = /^[A-Za-z0-9._/@:=+-]+$/;

/**
 * Validate a command against the LXC exec policy.
 * Returns { argv, scope: 'read_only' | 'mutating_scoped' } or { error }.
 * Every rejection says what IS allowed — a tool that only says "no" gets
 * retried verbatim.
 */
export function parseLxcCommand(command, policy, { workingDir = null, registeredWorkingDir = null } = {}) {
  const raw = String(command ?? '').trim();
  if (!raw) return { error: 'command is required — e.g. "docker compose ps" or "ss -ltnp"' };
  if (/[\u0000-\u001f\u007f]/.test(raw)) {
    return { error: 'command must not contain control characters or newlines' };
  }
  const argv = raw.split(/\s+/);

  const shellTokens = policy.shell_syntax_rejected || [];
  const shellHit = argv.find((tok) => shellTokens.some((sym) => tok.includes(sym)));
  if (shellHit) {
    return { error: `"${shellHit}" is shell syntax. This tool runs ONE command without a shell — pipes, redirects, ;, && and $(…) are not supported. Run the steps as separate calls.` };
  }
  const badTok = argv.find((tok) => !LXC_SAFE_ARG.test(tok));
  if (badTok) {
    return { error: `"${badTok}" is not a plain argument (quotes and special characters are not supported — the command is split on whitespace and executed directly).` };
  }

  for (const deny of policy.deny_always?.commands || []) {
    if (argvMatchesDeny(argv, deny)) {
      return {
        error: `"${deny.join(' ')}" is never allowed over MCP (removal and destructive operations stay host-side by design). `
          + 'Allowed: read/observe commands (docker ps/logs, systemctl status, ip, ss, journalctl, curl probes, df, free, ls, stat, du) '
          + 'and docker compose up/restart/stop/pull in the registered app directory.',
      };
    }
  }
  for (const allow of policy.read_only || []) {
    if (argvHasPrefix(argv, allow)) return { argv, scope: 'read_only' };
  }
  for (const allow of policy.mutating_scoped?.commands || []) {
    if (argvHasPrefix(argv, allow)) {
      if (!registeredWorkingDir || workingDir !== registeredWorkingDir) {
        return {
          error: `"${allow.join(' ')}" is a mutating command, allowed only in the guest's registered startup working dir`
            + (registeredWorkingDir ? ` (${registeredWorkingDir})` : ' — and this guest has no registered startup script')
            + '. It manages the app that was deployed there, nothing else.',
        };
      }
      return { argv, scope: 'mutating_scoped' };
    }
  }
  return {
    error: `"${argv[0]}" is not in the allowlist. Permitted: docker/compose status and logs, systemctl status/is-active/is-enabled, `
      + 'journalctl, ip addr/route, ss, sysctl -n, curl (probe only), df, free, uname, cat /etc/os-release, ls, stat, du — '
      + 'plus docker compose up/restart/stop/pull scoped to the registered app dir. No shells, no package managers, no deletion.',
  };
}

/** Clamp a caller timeout to the policy window (defaults mirror the policy
 *  file: 120s default, 1800s max). */
export function lxcCommandTimeoutMs(seconds, policy = {}) {
  const dflt = Number(policy.default_timeout_seconds) > 0 ? Number(policy.default_timeout_seconds) : 120;
  const max = Number(policy.max_timeout_seconds) > 0 ? Number(policy.max_timeout_seconds) : 1800;
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return Math.min(dflt, max) * 1000;
  return Math.min(Math.round(n), max) * 1000;
}

// ---- get_lxc_container: instance detail mapping ----

/** Map one incus instance (list --format json shape) to the tool's detail
 *  view: addresses on every non-lo NIC, the security/limits/boot config
 *  subset, and snapshots. Pure so the shape is testable. */
export function lxcContainerDetail(instance) {
  const config = instance?.config || {};
  const picked = {};
  for (const key of Object.keys(config)) {
    if (/^(security\.|limits\.|boot\.)/.test(key)) picked[key] = config[key];
  }
  const addresses = [];
  const nets = instance?.state?.network || {};
  for (const [iface, net] of Object.entries(nets)) {
    if (iface === 'lo') continue;
    for (const a of net?.addresses || []) {
      // 'local' is loopback scope; 'link' is fe80:: noise — neither is an
      // address anyone routes to.
      if (a.scope === 'local' || a.scope === 'link') continue;
      addresses.push({ interface: iface, address: a.address, family: a.family, netmask: a.netmask ?? null });
    }
  }
  return {
    status: instance?.status || null,
    created_at: instance?.created_at || null,
    ephemeral: !!instance?.ephemeral,
    profiles: instance?.profiles || [],
    addresses,
    config: picked,
    snapshots: (instance?.snapshots || []).map((s) => ({ name: s.name, created_at: s.created_at || null })),
  };
}

// ---- LXC lifecycle: snapshots + gated config writes ----
//
// Snapshot-before-mutate is the safety primitive that makes the mutating LXC
// tools safe to expose at all; the config allowlist
// (lib/mcp-policy/lxc-config-allowlist.json) is the enforcement source of
// truth for which Incus keys are writable and what each write requires.

export function validSnapshotName(s) {
  const v = String(s ?? '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(v)) return null;
  return v;
}

/** Default snapshot name from a Date — filesystem/incus-safe, sortable. */
export function defaultSnapshotName(date, prefix = 'pp-mcp') {
  const d = date instanceof Date ? date : new Date(date);
  const pad = (n) => String(n).padStart(2, '0');
  return `${prefix}-${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

/**
 * Validate a set_lxc_config request against the config policy.
 * Returns { key, value, restartRequired, warning|null } or { error }.
 *
 * security.privileged=true additionally requires acknowledgeRisk — and the
 * policy's warning text rides back on SUCCESS too, because the tool's job is
 * to present the trade-off, not just apply the flip (a real operator chose
 * this path in the field after being steered away; the warning exists for
 * the next one).
 */
export function validateLxcConfigChange(key, value, { acknowledgeRisk = false } = {}, policy) {
  const keys = policy?.keys || {};
  const k = String(key ?? '').trim();
  const rule = keys[k];
  if (!rule) {
    const blocked = policy?.explicitly_not_writable?.[k];
    if (blocked) return { error: `"${k}" is deliberately not writable over MCP: ${blocked}` };
    return { error: `"${k}" is not a writable config key. Writable: ${Object.keys(keys).join(', ')}.` };
  }
  const v = String(value ?? '').trim();
  if (Array.isArray(rule.values)) {
    if (!rule.values.includes(v)) return { error: `${k} accepts only: ${rule.values.join(', ')}` };
  } else if (k === 'limits.cpu') {
    if (!/^[1-9][0-9]*$/.test(v)) return { error: 'limits.cpu must be a positive whole number of vCPUs, e.g. "4"' };
  } else if (k === 'limits.memory') {
    if (!/^[1-9][0-9]*(\.[0-9]+)?(GB|GiB|MB|MiB)$/i.test(v)) return { error: 'limits.memory must be a size string, e.g. "4GB" or "512MiB"' };
  }
  if (k === 'security.privileged' && v === 'true' && acknowledgeRisk !== true) {
    return {
      error: `Setting security.privileged=true requires acknowledge_risk: true. ${rule.warning || ''}`.trim(),
    };
  }
  return {
    key: k,
    value: v,
    restartRequired: !!rule.restart_required,
    warning: (k === 'security.privileged' && v === 'true') ? (rule.warning || null) : null,
  };
}

export function validIpv4(s) {
  const v = String(s ?? '').trim();
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(v);
  if (!m) return null;
  for (let i = 1; i <= 4; i += 1) {
    if (Number(m[i]) > 255 || (m[i].length > 1 && m[i].startsWith('0'))) return null;
  }
  return v;
}

/** An Incus image alias like images:debian/12 or ubuntu:24.04. Argv-passed
 *  (never a shell), so this only rejects confusing shapes — most importantly
 *  a leading '-' that incus would read as an option. */
export function validImageAlias(s) {
  const v = String(s ?? '').trim();
  if (!v || v.length > 200 || v.startsWith('-')) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9:/._-]*$/.test(v)) return null;
  return v;
}

// ---- routing tools: domain/port validation + host-curl probe parsing ----
//
// test_route probes run as host `curl` (through the same nsenter seam every
// other host command uses) so they see exactly what the edge proxy serves —
// pinned to loopback with --resolve, so the test exercises THIS Caddy even
// when public DNS points elsewhere. Bodies are never returned: the probe
// keeps -o /dev/null and parses only a whitelisted set of header fields,
// because response bodies (and cookies) can carry credentials echoed by
// misconfigured apps.

export function validDomainName(s) {
  const v = String(s ?? '').trim().toLowerCase();
  if (!v || v.length > 253) return null;
  if (!/^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/.test(v)) return null;
  return v;
}

export function normalizePort(p) {
  const n = Number(p);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
}

/**
 * Parse a curl run that used `-o /dev/null -D -` plus a
 * `PP_TIME:%{time_total}` / `PP_CODE:%{http_code}` write-out trailer.
 * Returns fields from the LAST response block (redirect chains report their
 * final hop) — and ONLY whitelisted headers; Set-Cookie and friends never
 * leave this function.
 */
export function parseCurlProbeOutput(stdout) {
  const src = String(stdout ?? '');
  const statuses = [];
  let server = null, location = null, contentType = null;
  let sawStatusInBlock = false;
  for (const line of src.split(/\r?\n/)) {
    const st = /^HTTP\/([0-9.]+)\s+(\d{3})/.exec(line);
    if (st) {
      statuses.push(Number(st[2]));
      sawStatusInBlock = true;
      server = null; location = null; contentType = null;   // new block resets
      continue;
    }
    if (!sawStatusInBlock) continue;
    const h = /^([A-Za-z0-9-]+):\s*(.*)$/.exec(line);
    if (!h) continue;
    const key = h[1].toLowerCase();
    if (key === 'server') server = h[2].trim().slice(0, 100);
    else if (key === 'location') location = h[2].trim().slice(0, 300);
    else if (key === 'content-type') contentType = h[2].trim().slice(0, 100);
  }
  const time = /PP_TIME:([\d.]+)/.exec(src);
  const code = /PP_CODE:(\d+)/.exec(src);
  return {
    status_code: statuses.length ? statuses[statuses.length - 1] : (code ? Number(code[1]) || null : null),
    status_chain: statuses,
    server, location, content_type: contentType,
    time_seconds: time ? Number(time[1]) : null,
  };
}

/** Map a curl exit code to a failure class a caller can act on. */
export function classifyCurlExit(code) {
  const map = {
    6: ['dns', 'the hostname did not resolve'],
    7: ['connect_refused', 'TCP connection refused — nothing is listening there'],
    28: ['timeout', 'the probe timed out'],
    35: ['tls', 'TLS handshake failed'],
    52: ['empty_reply', 'the server closed the connection without a response'],
    56: ['reset', 'the connection was reset mid-transfer'],
    60: ['tls_untrusted', 'the certificate could not be verified'],
    127: ['curl_missing', 'curl is not installed'],
  };
  const [cls, hint] = map[Number(code)] || ['error', `curl exited ${code}`];
  return { class: cls, hint };
}

// ---- write_lxc_file: the mode parameter ----

/** Three octal permission digits, with or without a leading zero ("0755",
 *  "644"). Returns them normalized for chmod, or null. Deliberately no
 *  setuid/setgid/sticky digit: nothing the file tools deploy needs one. */
export function validFileMode(m) {
  const s = String(m ?? '').trim();
  if (!/^0?[0-7]{3}$/.test(s)) return null;
  return s.slice(-3);
}

// ---- tool catalog ----

const uploadSourceProps = {
  ticket: {
    type: 'string',
    description: 'Upload ticket from create_upload_ticket whose URL has received the zip bytes (preferred for zips over ~2 MB).',
  },
  zip_base64: {
    type: 'string',
    description: 'The zip file base64-encoded, for small archives (≤ 2 MB decoded). Use an upload ticket for anything larger.',
  },
  sha256: {
    type: 'string',
    description: 'Optional but recommended: hex SHA-256 of the raw zip bytes. Verified before anything is parsed or staged, so transport corruption fails loudly as a checksum mismatch instead of surfacing later as a confusing extraction error.',
  },
};

export const MCP_TOOLS = [
  {
    name: 'list_static_sites',
    description: 'List the static sites ProxyPilot serves (id, name, domain). Use the id with inspect_static_site_zip / apply_static_site_zip to deploy new content.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'create_upload_ticket',
    description: 'Create a short-lived upload slot for a zip file. Returns { ticket, upload_url, expires_in_seconds }. PUT the raw zip bytes to upload_url (Content-Type: application/zip, same auth not required — the ticket in the URL is the secret), then pass the ticket to an inspect tool. If your environment cannot reach the upload URL (egress-restricted sandbox), deliver the bytes over MCP instead with append_upload_chunk + finish_upload on the same ticket. Tickets are single-use and expire in 30 minutes.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'append_upload_chunk',
    description: 'Deliver part of a zip to an upload ticket through MCP itself — the fallback for clients that cannot reach the ticket\'s PUT upload_url. Send base64 chunks (≤ 4 MB decoded each) in order, seq starting at 0; out-of-order or repeated chunks are refused. Finish with finish_upload, then pass the ticket to an inspect tool as usual.',
    inputSchema: {
      type: 'object',
      properties: {
        ticket: { type: 'string', description: 'From create_upload_ticket.' },
        seq: { type: 'number', description: 'Chunk sequence number, starting at 0, incrementing by 1.' },
        chunk_base64: { type: 'string', description: 'This chunk of the zip, base64-encoded (≤ 4 MB decoded).' },
      },
      required: ['ticket', 'seq', 'chunk_base64'],
      additionalProperties: false,
    },
  },
  {
    name: 'finish_upload',
    description: 'Seal a chunked upload: verifies the assembled bytes against the required sha256 (hex SHA-256 of the COMPLETE zip) and makes the ticket usable by the inspect tools. A checksum mismatch discards the ticket — create a new one and re-send, rather than extracting corrupted bytes.',
    inputSchema: {
      type: 'object',
      properties: {
        ticket: { type: 'string' },
        sha256: { type: 'string', description: 'Hex SHA-256 of the complete zip file.' },
      },
      required: ['ticket', 'sha256'],
      additionalProperties: false,
    },
  },
  {
    name: 'inspect_static_site_zip',
    description: 'Step 1 of deploying a zip to a static site: parse and validate the archive and report its file count, any single wrapper folder (e.g. dist/), and which existing files would be replaced. Nothing is written. Returns an upload_id for apply_static_site_zip. Always show the user the conflict list and get their go-ahead before applying with confirm_overwrite.',
    inputSchema: {
      type: 'object',
      properties: {
        service_id: { type: 'number', description: 'Static site id from list_static_sites.' },
        ...uploadSourceProps,
      },
      required: ['service_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'apply_static_site_zip',
    description: 'Step 2: extract a previously inspected zip into the static site. If files would be replaced and confirm_overwrite is not true, this returns the conflict list instead of writing — confirm with the user first. On confirm, each replaced file is kept as `<name>.old`.',
    inputSchema: {
      type: 'object',
      properties: {
        service_id: { type: 'number' },
        upload_id: { type: 'string', description: 'From inspect_static_site_zip.' },
        strip_wrapper: { type: 'boolean', description: 'Strip the single top-level wrapper folder (default true when one exists).' },
        confirm_overwrite: { type: 'boolean', description: 'Set true only after the user approved replacing the listed files.' },
      },
      required: ['service_id', 'upload_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_lxc_containers',
    description: 'List LXC/Incus containers ProxyPilot manages (name, status, IP). Use the name with inspect_lxc_zip / apply_lxc_zip.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_lxc_container',
    description: 'Full detail for one LXC/Incus guest: status, every non-loopback IP address, the security/limits/boot config subset (security.nesting, security.privileged, limits.*, boot.autostart), profiles, snapshots, and the registered startup script (path + working dir). The LXC counterpart of get_project — use it before planning changes instead of probing with file reads.',
    inputSchema: {
      type: 'object',
      properties: {
        container: { type: 'string', description: 'Container name from list_lxc_containers (without the pp- prefix).' },
      },
      required: ['container'],
      additionalProperties: false,
    },
  },
  {
    name: 'run_lxc_command',
    description: 'Run one allowlisted command inside an LXC guest — the observe/debug loop without editing boot scripts or redeploying. Same contract as run_project_command: whitespace-split argv executed directly (no shell — pipes, redirects, ;, && and $() are rejected), last 64 KB of each stream returned, exit_code + timed_out reported. The allowlist is read-biased: docker/compose status+logs, systemctl status, journalctl, ip, ss, sysctl -n, curl (probe only — output-writing flags are denied), df, free, ls, stat, du; docker compose up/restart/stop/pull are allowed only in the registered startup working dir. No shells, no package managers, no deletion — those stay host-side by design.',
    inputSchema: {
      type: 'object',
      properties: {
        container: { type: 'string' },
        command: { type: 'string', description: 'e.g. "docker compose ps" or "ss -ltnp". Validated against the allowlist before execution.' },
        working_dir: { type: 'string', description: 'Absolute directory to run in; default the registered startup working dir (or /).' },
        timeout_seconds: { type: 'number', description: 'Kill after this many seconds. Default 120, max 1800.' },
      },
      required: ['container', 'command'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_lxc_container',
    description: 'Create a new LXC/Incus guest. Creation-only, so inherently non-destructive: fails if the name already exists, never replaces. docker_ready (default true) sets security.nesting plus the syscall intercepts Docker needs at birth, so the keyring/nesting failures do not occur on new guests — privileged mode is NOT included and stays behind set_lxc_config\'s risk gate. Waits briefly for a DHCP lease and returns the same detail as get_lxc_container. Requires confirm: true.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Guest name (ProxyPilot adds its pp- prefix). Fails if taken.' },
        image: { type: 'string', description: 'Incus image alias, default images:debian/12.' },
        cpu: { type: 'number', description: 'vCPU limit, default 2.' },
        memory_gb: { type: 'number', description: 'RAM limit in GB, default 4. Browser workloads need >= 4 — Chrome OOMs at 2.' },
        disk_gb: { type: 'number', description: 'Root disk in GB (best-effort override of the profile default).' },
        docker_ready: { type: 'boolean', description: 'Set nesting + syscall intercepts for running Docker inside. Default true.' },
        autostart: { type: 'boolean', description: 'boot.autostart, default true.' },
        confirm: { type: 'boolean', description: 'Must be true.' },
      },
      required: ['name', 'confirm'],
      additionalProperties: false,
    },
  },
  {
    name: 'control_lxc_container',
    description: 'Start, stop (clean shutdown only — no force-kill), or restart an LXC guest. The step that applies restart-required config changes (set_lxc_config reports when one is needed). No delete verb exists, by design. Requires confirm: true.',
    inputSchema: {
      type: 'object',
      properties: {
        container: { type: 'string' },
        action: { type: 'string', enum: ['start', 'stop', 'restart'] },
        confirm: { type: 'boolean', description: 'Must be true.' },
      },
      required: ['container', 'action', 'confirm'],
      additionalProperties: false,
    },
  },
  {
    name: 'set_lxc_config',
    description: 'Set one allowlisted Incus config key on a guest: security.nesting, security.privileged, limits.cpu, limits.memory, boot.autostart (the allowlist in lib/mcp-policy/lxc-config-allowlist.json is the source of truth — anything else, notably raw.lxc and device passthrough, is rejected). Takes an automatic snapshot before every write and reports whether a restart is needed. security.privileged=true additionally requires acknowledge_risk: true and returns the warning that container root becomes host root — prefer raising kernel.keys.* sysctls on the host for Docker keyring failures. Requires confirm: true.',
    inputSchema: {
      type: 'object',
      properties: {
        container: { type: 'string' },
        key: { type: 'string', enum: ['security.nesting', 'security.privileged', 'limits.cpu', 'limits.memory', 'boot.autostart'] },
        value: { type: 'string', description: 'New value, e.g. "true", "4", "8GB".' },
        confirm: { type: 'boolean', description: 'Must be true.' },
        acknowledge_risk: { type: 'boolean', description: 'Required (true) only when setting security.privileged=true.' },
      },
      required: ['container', 'key', 'value', 'confirm'],
      additionalProperties: false,
    },
  },
  {
    name: 'set_lxc_network',
    description: 'Pin a guest\'s IPv4 address: reserve-current converts the address the guest holds now into a static reservation (recommended — a working deployment on a dynamic lease reproduces its edge 502 at the next renewal); static assigns a specific address. Snapshots first, warns when routed domains still target an address the change abandons, and says when a restart is needed for the lease to apply. Requires confirm: true.',
    inputSchema: {
      type: 'object',
      properties: {
        container: { type: 'string' },
        mode: { type: 'string', enum: ['reserve-current', 'static'] },
        ip: { type: 'string', description: 'IPv4 address, required when mode=static.' },
        confirm: { type: 'boolean', description: 'Must be true.' },
      },
      required: ['container', 'mode', 'confirm'],
      additionalProperties: false,
    },
  },
  {
    name: 'snapshot_lxc_container',
    description: 'Take a named snapshot of a guest — the safety primitive every mutating LXC tool leans on (they all snapshot before changing anything). With list: true it just returns the existing snapshots. No restore or delete verb over MCP: restoring is a deliberate host-side act (incus restore).',
    inputSchema: {
      type: 'object',
      properties: {
        container: { type: 'string' },
        name: { type: 'string', description: 'Snapshot name; default a timestamp.' },
        list: { type: 'boolean', description: 'If true, just return existing snapshots and take none.' },
      },
      required: ['container'],
      additionalProperties: false,
    },
  },
  {
    name: 'lxc_file_diff',
    description: 'Diff a file inside a guest against its .old backup (written by write_lxc_file / apply_lxc_zip on overwrite), or against any other text file via `against`. Read-only; pairs with restore_lxc_file. Unified diff, truncated past 128 KB.',
    inputSchema: {
      type: 'object',
      properties: {
        container: { type: 'string' },
        path: { type: 'string', description: 'File to diff; compared against <path>.old unless against is set.' },
        against: { type: 'string', description: 'Optional second absolute path to diff against instead of the .old backup.' },
      },
      required: ['container', 'path'],
      additionalProperties: false,
    },
  },
  {
    name: 'restore_lxc_file',
    description: 'Restore a file from its .old backup by SWAPPING the two — the previous live version lands in .old, so a restore is itself reversible by calling again. Check the change first with lxc_file_diff. Requires confirm: true.',
    inputSchema: {
      type: 'object',
      properties: {
        container: { type: 'string' },
        path: { type: 'string', description: 'The live file path; its .old must exist.' },
        confirm: { type: 'boolean', description: 'Must be true.' },
      },
      required: ['container', 'path', 'confirm'],
      additionalProperties: false,
    },
  },
  {
    name: 'inspect_lxc_zip',
    description: 'Step 1 of deploying a zip into an LXC container: validate the archive against a target directory inside the container and report conflicts, startup-script candidates (*.sh, e.g. startup.sh), and any previously registered startup script. Nothing is written. Returns an upload_id for apply_lxc_zip.',
    inputSchema: {
      type: 'object',
      properties: {
        container: { type: 'string', description: 'Container name from list_lxc_containers (without the pp- prefix).' },
        target_dir: { type: 'string', description: 'Absolute directory inside the container (default /opt/app).' },
        ...uploadSourceProps,
      },
      required: ['container'],
      additionalProperties: false,
    },
  },
  {
    name: 'apply_lxc_zip',
    description: 'Step 2: extract a previously inspected zip into the container. Replaced files are kept as `<name>.old` after confirm_overwrite. Optionally register startup_script (a .sh from the zip) as the container boot service and run it now; replacing an existing registered script needs confirm_replace_startup. Returns the startup run output and exit code when run.',
    inputSchema: {
      type: 'object',
      properties: {
        container: { type: 'string' },
        upload_id: { type: 'string' },
        strip_wrapper: { type: 'boolean' },
        confirm_overwrite: { type: 'boolean' },
        startup_script: { type: 'string', description: 'Relative path of a .sh inside the zip to register + run (e.g. startup.sh).' },
        run_startup: { type: 'boolean', description: 'Run the startup script now (default true when startup_script is set).' },
        confirm_replace_startup: { type: 'boolean' },
      },
      required: ['container', 'upload_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_lxc_file',
    description: 'Read a text file from inside an LXC container (e.g. /opt/app/config.json). Use this to see the current content before proposing an edit with write_lxc_file. Returns up to 512 KB; refuses binary files.',
    inputSchema: {
      type: 'object',
      properties: {
        container: { type: 'string', description: 'Container name from list_lxc_containers (without the pp- prefix).' },
        path: { type: 'string', description: 'Absolute file path inside the container.' },
      },
      required: ['container', 'path'],
      additionalProperties: false,
    },
  },
  {
    name: 'write_lxc_file',
    description: 'Write one text file inside an LXC container. If the file already exists and confirm_overwrite is not true, this returns the current file info instead of writing — show the user your proposed change and get their go-ahead first. On overwrite the previous version is kept as `<path>.old`. Parent directories are created. Pass mode (e.g. "0755") to make a script executable in the same call. After config/code edits, redeploy with rerun_startup.',
    inputSchema: {
      type: 'object',
      properties: {
        container: { type: 'string' },
        path: { type: 'string', description: 'Absolute file path inside the container.' },
        content: { type: 'string', description: 'The complete new file content (UTF-8).' },
        confirm_overwrite: { type: 'boolean', description: 'Set true only after the user approved replacing the existing file.' },
        mode: { type: 'string', description: 'Optional file permissions as three octal digits, e.g. "0755" for an executable script or "644". Default: whatever the write leaves (existing files keep their mode).' },
      },
      required: ['container', 'path', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'rerun_startup',
    description: 'Re-run the startup script registered for an LXC container (the redeploy step after write_lxc_file edits). Returns the last 64 KB of stdout/stderr (the tail — a failure explains itself at the end), the exit code, and timed_out. Long first-boot installs should pass timeout_seconds (default 120, max 1800). Fails if no startup script has been registered — register one via apply_lxc_zip.',
    inputSchema: {
      type: 'object',
      properties: {
        container: { type: 'string' },
        timeout_seconds: { type: 'number', description: 'Kill the run after this many seconds (default 120, max 1800). A run that hits the deadline reports timed_out: true and may still be running inside the container.' },
      },
      required: ['container'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_routes',
    description: 'List every hostname the edge proxy serves: domain, path prefix, upstream (container ip:port or static-site id), websocket flag, TLS stance — and flags orphaned routes whose upstream is unrecorded (they render but 502). Read-only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_route',
    description: 'Full detail for one hostname: every route on the domain with its upstream resolution, the TLS policy (ACME vs manual cert), and — when an issued certificate is on disk — its issuer, validity window, days until expiry, and status. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Fully qualified hostname, e.g. web.example.com.' },
      },
      required: ['domain'],
      additionalProperties: false,
    },
  },
  {
    name: 'test_route',
    description: 'Probe a hostname from the edge host\'s own vantage point, pinned to the local proxy (so the test exercises THIS Caddy even when public DNS points elsewhere): DNS resolution, HTTP status + timing through the full proxy path, a direct probe of the recorded upstream, and optionally a WebSocket upgrade handshake. Distinguishes in one call the three failure classes that look identical from outside — proxy down, proxy-to-upstream (stale binding), and app-level — and says which one it found. Never returns response bodies. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string' },
        path: { type: 'string', description: 'URL path to probe, default /.' },
        test_websocket: { type: 'boolean', description: 'Attempt a WS upgrade through the proxy (default: whatever the route has configured).' },
      },
      required: ['domain'],
      additionalProperties: false,
    },
  },
  {
    name: 'set_route',
    description: 'Create or update the root-path binding for one hostname: upstream container name + port (preferred — the container\'s current IP is resolved and recorded) or a literal ip:port, websocket upgrade on/off (default ON — modern upstreams break without it and the failure mode, page-loads-then-black-screen, is misleading), and TLS. Updating an existing binding requires confirm_overwrite: true and the result carries the previous binding, so the change is reversible by a second call. Refuses domains bound to static sites. No delete verb — removal stays a UI/host operation.',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string' },
        upstream_container: { type: 'string', description: 'LXC guest name (without pp-); mutually exclusive with upstream_ip. Preferred: pairs with set_lxc_network so IP changes cannot silently break the route.' },
        upstream_ip: { type: 'string', description: 'Literal upstream IPv4; mutually exclusive with upstream_container.' },
        upstream_port: { type: 'number' },
        websocket: { type: 'boolean', description: 'Pass Upgrade/Connection headers. Default true.' },
        tls: { type: 'boolean', description: 'HTTPS with automatic certificates. Default true.' },
        confirm_overwrite: { type: 'boolean', description: 'Required (true) when the domain already has a binding.' },
      },
      required: ['domain', 'upstream_port'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_projects',
    description: 'List ProxyPilot AI-dev projects (id, name, url, lifecycle, latest build status).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_project',
    description: 'Details for one AI-dev project: lifecycle, live URL, latest build cycle status, build queue, and shipped builds still awaiting operator verification. Check pending_verification before queuing a build — re-requesting already-shipped work pays for it twice.',
    inputSchema: {
      type: 'object',
      properties: { project_id: { type: 'number' } },
      required: ['project_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'send_project_build',
    description: 'Queue a build instruction (quick update) on an AI-dev project — e.g. "Add a CSV export to the reports page". The project builds it with its own AI harness; poll get_project for status. If a build is already running the instruction queues behind it.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'number' },
        instruction: { type: 'string', description: 'What to build or change, in plain language.' },
      },
      required: ['project_id', 'instruction'],
      additionalProperties: false,
    },
  },
  {
    name: 'upload_project_reference',
    description: 'Add a text reference file (spec, notes, exported page) to a project\'s asset library. The project\'s builds see a summary of it and can read the full content.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'number' },
        name: { type: 'string', description: 'Filename, e.g. spec.md.' },
        content: { type: 'string', description: 'The file text (UTF-8).' },
      },
      required: ['project_id', 'name', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'interrupt_project_build',
    description: 'Stop the build currently running on an AI-dev project. Default action stop_after_step checkpoints at the next step boundary (resumable from the UI); abandon discards the in-progress cycle. Use this when a build was queued by mistake or is burning API budget on the wrong thing.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'number' },
        action: { type: 'string', enum: ['stop_after_step', 'abandon'], description: 'stop_after_step (default): checkpoint and stop, resumable. abandon: discard the cycle.' },
      },
      required: ['project_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'cancel_queued_build',
    description: 'Cancel a queued (not yet started) build on an AI-dev project. get_project lists queued builds with their ids. A build that has already started must be stopped with interrupt_project_build instead.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'number' },
        queue_id: { type: 'number', description: 'Queue entry id from get_project.queued_builds.' },
      },
      required: ['project_id', 'queue_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_project_files',
    description: 'List the tracked source files of an AI-dev project (git ls-files in its app checkout). Use this to find the files to read/edit with read_project_file / write_project_file. Optionally limit to a subdirectory.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'number' },
        subdir: { type: 'string', description: 'Relative directory to limit the listing to, e.g. src/server.' },
      },
      required: ['project_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_project_file',
    description: 'Read one text file from an AI-dev project\'s app checkout (path relative to the app root, e.g. src/server/routes.ts). Returns up to 512 KB; refuses binary files. Pass offset/limit to read a LINE RANGE instead of the whole file — pair it with search_project_files (which gives you path + line_number) to read just the part you need. total_lines always reports the file\'s real length, whether or not a range was requested.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'number' },
        path: { type: 'string', description: 'File path relative to the app root.' },
        offset: { type: 'number', description: 'First line to return, 1-based (default 1).' },
        limit: { type: 'number', description: 'How many lines to return from offset (default: the rest of the file, capped at 512 KB).' },
      },
      required: ['project_id', 'path'],
      additionalProperties: false,
    },
  },
  {
    name: 'search_project_files',
    description: 'Search an AI-dev project\'s tracked files for a regular expression (git grep -E) and return path + line_number + the matching line. Use this instead of reading whole files to find something — then read_project_file with offset/limit for the surrounding code. Binary files are skipped; the search covers tracked files only.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'number' },
        pattern: { type: 'string', description: 'Extended regular expression (POSIX ERE, as git grep -E takes).' },
        glob: { type: 'string', description: 'Optional git pathspec to limit the search, e.g. "src/**/*.ts" or "apps/freshcut".' },
        max_results: { type: 'number', description: 'Cap on returned matches (default 200, max 1000).' },
        ignore_case: { type: 'boolean', description: 'Case-insensitive match.' },
      },
      required: ['project_id', 'pattern'],
      additionalProperties: false,
    },
  },
  {
    name: 'edit_project_file',
    description: 'Replace an exact string in one file of an AI-dev project and commit the change — the surgical alternative to write_project_file, which rewrites the whole file. Fails if old_string is absent, or if it matches a different number of times than expected (default: exactly once), so an edit can never land somewhere you did not mean. Refused while a build is running.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'number' },
        path: { type: 'string', description: 'File path relative to the app root.' },
        old_string: { type: 'string', description: 'The exact text to replace, copied from read_project_file. Include enough surrounding lines to make it unique.' },
        new_string: { type: 'string', description: 'What to put in its place. May be empty to delete the text.' },
        expect_occurrences: { type: 'number', description: 'How many times old_string should appear. Default 1. The edit is refused unless the real count matches exactly.' },
        commit_message: { type: 'string', description: 'Git commit message (a sensible default is used if omitted).' },
      },
      required: ['project_id', 'path', 'old_string', 'new_string'],
      additionalProperties: false,
    },
  },
  {
    name: 'delete_project_file',
    description: 'Delete one file from an AI-dev project\'s checkout and commit the removal (git rm). The file stays recoverable from the project\'s git history. Refused while a build is running.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'number' },
        path: { type: 'string', description: 'File path relative to the app root.' },
        commit_message: { type: 'string' },
      },
      required: ['project_id', 'path'],
      additionalProperties: false,
    },
  },
  {
    name: 'move_project_file',
    description: 'Move or rename one file in an AI-dev project\'s checkout and commit it (git mv), so history follows the file. Parent directories of the destination are created. Refused while a build is running, or if the destination already exists.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'number' },
        from: { type: 'string', description: 'Current path, relative to the app root.' },
        to: { type: 'string', description: 'New path, relative to the app root.' },
        commit_message: { type: 'string' },
      },
      required: ['project_id', 'from', 'to'],
      additionalProperties: false,
    },
  },
  {
    name: 'write_project_file',
    description: 'Write one text file in an AI-dev project\'s app checkout and commit it to the project\'s git history (the previous version stays recoverable via git — no build tokens are spent). If the file exists and confirm_overwrite is not true, returns the current file info instead of writing — show the user the proposed change first. Refused while a build is running (interrupt it first). After your edits, apply them with redeploy_project.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'number' },
        path: { type: 'string', description: 'File path relative to the app root.' },
        content: { type: 'string', description: 'The complete new file content (UTF-8).' },
        commit_message: { type: 'string', description: 'Git commit message for this edit (a sensible default is used if omitted).' },
        confirm_overwrite: { type: 'boolean', description: 'Set true only after the user approved replacing the existing file.' },
      },
      required: ['project_id', 'path', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'redeploy_project',
    description: 'Deploy an AI-dev project\'s current checkout: install dependencies (skipped when unchanged), run migrations, build, restart the app service, and health-check it. The apply step after write_project_file edits. Can take a few minutes when dependencies changed. Refused while a build is running.',
    inputSchema: {
      type: 'object',
      properties: { project_id: { type: 'number' } },
      required: ['project_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'run_project_command',
    description: 'Run one allowlisted command in an AI-dev project\'s app checkout — the verification step the file tools cannot do themselves (e.g. "npm run gates", "npm run typecheck", "npx playwright test"). Runs in the SAME container and environment redeploy_project builds in, so a green result means what it says. Allowed: `npm ci`, `npm run <script>`, `npx playwright …`, and read-only `git` subcommands. No shell syntax — pipes, redirects, ;, && and $() are rejected. Returns exit_code plus the last 64 KB of stdout/stderr. Refused while a build is running.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'number' },
        command: {
          type: 'string',
          description: 'The command, e.g. "npm run gates". Split on whitespace and executed directly — not through a shell.',
        },
        timeout_seconds: {
          type: 'number',
          description: 'Kill the command after this many seconds (default 600, max 1800). A run that hits the timeout reports timed_out: true.',
        },
      },
      required: ['project_id', 'command'],
      additionalProperties: false,
    },
  },
  {
    name: 'project_git_log',
    description: 'Recent commits in an AI-dev project\'s checkout, as structured rows ({ sha, author, date, subject }) rather than raw git output. Use it to see what the harness and the chat lane have actually committed. (Raw `git log` is also reachable through run_project_command when you want a specific format.)',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'number' },
        limit: { type: 'number', description: 'How many commits (default 20, max 200).' },
        path: { type: 'string', description: 'Only commits touching this path, relative to the app root.' },
      },
      required: ['project_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'project_git_diff',
    description: 'Diff an AI-dev project\'s checkout. With no ref this shows UNCOMMITTED work — the working tree against HEAD, PLUS the untracked files, which is how you catch a build that wrote a file and never committed it (invisible to `git log` and to every reviewer, but still on disk and still running). With a ref it diffs that revision or range instead.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'number' },
        ref: { type: 'string', description: 'A revision or range, e.g. "HEAD~3", "abc123..def456". Omit for uncommitted changes.' },
        path: { type: 'string', description: 'Limit the diff to this path, relative to the app root.' },
        stat_only: { type: 'boolean', description: 'Return the --stat summary instead of the full patch.' },
      },
      required: ['project_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'project_git_show',
    description: 'Show one commit in an AI-dev project: its metadata and its patch. Pass a sha from project_git_log.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'number' },
        ref: { type: 'string', description: 'Commit sha or revision, e.g. "abc1234" or "HEAD~1".' },
        path: { type: 'string', description: 'Limit the patch to this path.' },
        stat_only: { type: 'boolean', description: 'Return the --stat summary instead of the full patch.' },
      },
      required: ['project_id', 'ref'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_build_log',
    description: 'The recorded event stream of one build cycle: its status, any error, and the steps/messages it produced. A failed build otherwise surfaces as a status with no output, which leaves nothing to diagnose from. Cycle ids come from get_project.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'number' },
        build_id: { type: 'number', description: 'Cycle id, from get_project (latest_build.id, queued_builds, or pending_verification.cycle_id).' },
        limit: { type: 'number', description: 'Most recent events to return (default 200, max 1000).' },
      },
      required: ['project_id', 'build_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'append_change_record',
    description: 'Append a hash-chained change record to an AI-dev project\'s audit trail, for work done through the MCP file tools (which write no record of their own). ProxyPilot computes the chain itself — seq, prev_hash and hash are derived server-side inside a transaction from the project\'s last record, so the chain keeps verifying. Also mirrors the record to state/changes/<seq>.json in the checkout and commits it, the same way a build cycle does. Never hand-compute these hashes: the canonical payload is an explicit field allowlist, not "the record minus its hashes".',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'number' },
        summary: { type: 'string', description: 'What this checkpoint recorded, in plain language.' },
        commit_sha: { type: 'string', description: 'The commit this record attests to (e.g. from write_project_file or project_git_log).' },
        gates_run: { type: 'string', description: 'What verification ran, e.g. the run_project_command result. JSON or plain text.' },
        rules_touched: { type: 'string', description: 'Which rules this change touched, if any.' },
        cycle_id: { type: 'number', description: 'Associate the record with a build cycle. Omit for chat-lane work, which has none.' },
      },
      required: ['project_id', 'summary'],
      additionalProperties: false,
    },
  },
  {
    name: 'clone_project',
    description: 'Clone an AI-dev project under a new name. mode "fresh": full app + git history + asset library with a fresh database; mode "full": also copies the source database. Returns the new project; poll get_project on it for provisioning progress.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'number', description: 'Source project id.' },
        name: { type: 'string', description: 'Name for the clone (its URL is derived from this).' },
        mode: { type: 'string', enum: ['fresh', 'full'] },
      },
      required: ['project_id', 'name'],
      additionalProperties: false,
    },
  },
];

// A file path RELATIVE to a project's app root, as accepted by the project
// file tools. Rejects absolute paths, traversal, control characters, and
// anything under .git (the repo plumbing is not an editing surface).
export function validProjectFilePath(p) {
  const s = String(p || '').trim().replace(/^\.\//, '');
  if (!s || s.startsWith('/') || s.includes('\\') || /[\u0000-\u001f\u007f]/.test(s)) return null;
  const segments = s.split('/');
  if (segments.some((seg) => seg === '' || seg === '.' || seg === '..')) return null;
  if (segments[0] === '.git') return null;
  return s;
}

// ---- edit_project_file: the replacement itself ----

/**
 * Apply a literal string replacement, refusing anything ambiguous.
 *
 * The whole point of a surgical edit is that it cannot land somewhere the
 * caller did not mean, so the count is a precondition rather than a result:
 * absent → refuse, and a count other than expected → refuse, naming both
 * numbers. Default 1, because "replace the one place this appears" is what a
 * caller means when they don't say.
 *
 * Literal, never regex: the caller pastes text back from read_project_file,
 * and quietly treating `.` or `(` as a metacharacter there is a trap.
 */
export function applyStringEdit(content, oldString, newString, expectOccurrences) {
  const src = String(content ?? '');
  const from = String(oldString ?? '');
  const to = String(newString ?? '');
  if (!from) return { error: 'old_string is required and must not be empty.' };
  if (from === to) return { error: 'old_string and new_string are identical — nothing to change.' };

  let count = 0;
  for (let i = src.indexOf(from); i !== -1; i = src.indexOf(from, i + from.length)) count += 1;
  if (count === 0) {
    return { error: 'old_string was not found in the file. Re-read the file (whitespace and indentation must match exactly) and try again.' };
  }

  let expected = 1;
  if (expectOccurrences !== undefined && expectOccurrences !== null) {
    expected = Number(expectOccurrences);
    if (!Number.isInteger(expected) || expected < 1) {
      return { error: 'expect_occurrences must be a positive whole number.' };
    }
  }
  if (count !== expected) {
    return {
      error: `old_string appears ${count} time(s) but expect_occurrences is ${expected}. `
        + (count > expected
          ? 'Add surrounding context to make it unique, or set expect_occurrences to replace them all.'
          : 'The file does not look the way you think — re-read it before editing.'),
    };
  }
  return { content: src.split(from).join(to), replaced: count };
}

// ---- search_project_files ----

export const SEARCH_MAX_RESULTS_DEFAULT = 200;
export const SEARCH_MAX_RESULTS_CAP = 1000;
/** Matching lines get truncated at this width — a minified bundle line is not
 *  worth 200 KB of context, and the point of a hit is its location. */
export const SEARCH_LINE_CAP = 500;

/** A git pathspec, e.g. "src/**\/*.ts". Rejects absolutes, traversal and
 *  control characters; the glob metacharacters git wants are left alone. */
export function validPathspec(g) {
  const s = String(g ?? '').trim();
  if (!s) return null;
  if (s.startsWith('/') || /[\u0000-\u001f\u007f]/.test(s)) return null;
  if (s.split('/').includes('..')) return null;
  return s;
}

/** The search pattern. Passed to git as a positional argument (never through a
 *  shell), so regex punctuation is safe as-is — only control characters and
 *  absurd lengths are refused. */
export function validSearchPattern(p) {
  const s = String(p ?? '');
  if (!s.trim()) return null;
  if (s.length > 1000 || /[\u0000-\u001f\u007f]/.test(s)) return null;
  return s;
}

export function normalizeMaxResults(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 1) return SEARCH_MAX_RESULTS_DEFAULT;
  return Math.min(Math.floor(v), SEARCH_MAX_RESULTS_CAP);
}

/**
 * Parse `git grep -n` output into structured hits.
 *
 * Format is `path:line:content`. A path containing a colon would split early
 * here — accepted, because git grep offers no unambiguous machine format worth
 * the complexity, and a source path with a colon in it is vanishingly rare.
 */
export function parseGitGrepOutput(stdout, maxResults = SEARCH_MAX_RESULTS_DEFAULT) {
  const hits = [];
  for (const raw of String(stdout ?? '').split('\n')) {
    if (!raw) continue;
    const m = /^(.*?):(\d+):([\s\S]*)$/.exec(raw);
    if (!m) continue;
    hits.push({ path: m[1], line_number: Number(m[2]), line: m[3].slice(0, SEARCH_LINE_CAP) });
    if (hits.length >= maxResults) break;
  }
  return hits;
}

// ---- read_project_file: line ranges ----

/**
 * Normalize an (offset, limit) pair into a 1-based inclusive line window.
 *
 * `ranged` says whether the caller actually asked for a window: when they did
 * not, the reader keeps its original whole-file behaviour byte for byte, so
 * existing callers see no change.
 */
export function normalizeReadRange(offset, limit) {
  const off = Number(offset);
  const lim = Number(limit);
  const hasOff = Number.isFinite(off) && off >= 1;
  const hasLim = Number.isFinite(lim) && lim >= 1;
  const start = hasOff ? Math.floor(off) : 1;
  const count = hasLim ? Math.floor(lim) : null;
  return {
    start,
    count,
    end: count === null ? null : start + count - 1,
    ranged: hasOff || hasLim,
  };
}

// ---- project git history ----

export const GIT_LOG_LIMIT_DEFAULT = 20;
export const GIT_LOG_LIMIT_MAX = 200;
/** Patches are unbounded in principle; this is what comes back before the
 *  result says it truncated. Larger than the command-output cap because a
 *  review diff is the thing being read, not a byproduct. */
export const GIT_PATCH_CAP = 128 * 1024;

/**
 * A revision or range, as `git log`/`show` take it.
 *
 * Passed to git as a positional argument, so the containment is the same as
 * everywhere else in this module — this refuses the shapes that would be
 * CONFUSING rather than dangerous, most importantly a leading `-` that git
 * would read as an option rather than a revision.
 */
export function validGitRef(ref) {
  const s = String(ref ?? '').trim();
  if (!s || s.length > 200) return null;
  if (s.startsWith('-')) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._/~^@{}-]*(\.\.\.?[A-Za-z0-9._/~^@{}-]+)?$/.test(s)) return null;
  return s;
}

export function normalizeGitLogLimit(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 1) return GIT_LOG_LIMIT_DEFAULT;
  return Math.min(Math.floor(v), GIT_LOG_LIMIT_MAX);
}

/** The unit separator. Chosen because it cannot appear in a commit subject,
 *  author name or ISO date, so the split needs no escaping rules. */
export const GIT_LOG_SEP = '\u001f';
export const GIT_LOG_FORMAT = ['%H', '%an', '%aI', '%s'].join('%x1f');

export function parseGitLogOutput(stdout) {
  const rows = [];
  for (const line of String(stdout ?? '').split('\n')) {
    if (!line.trim()) continue;
    const [sha, author, date, ...rest] = line.split(GIT_LOG_SEP);
    if (!sha) continue;
    rows.push({
      sha,
      short_sha: sha.slice(0, 8),
      author: author || null,
      date: date || null,
      // A subject containing the separator would have split; rejoin so the
      // message survives intact rather than being silently clipped.
      subject: rest.join(GIT_LOG_SEP),
    });
  }
  return rows;
}

/** Split `git status --porcelain` into staged/unstaged/untracked buckets.
 *  Untracked is the interesting one: a file written but never committed is
 *  invisible to git log and to every reviewer, while still being on disk. */
export function parseGitStatusPorcelain(stdout) {
  const tracked = [];
  const untracked = [];
  for (const line of String(stdout ?? '').split('\n')) {
    if (line.length < 4) continue;
    const code = line.slice(0, 2);
    const path = line.slice(3);
    if (code === '??') untracked.push(path);
    else tracked.push({ status: code.trim(), path });
  }
  return { tracked, untracked };
}

/** Cap a patch/diff body, reporting whether anything was dropped. */
export function capPatch(text, cap = GIT_PATCH_CAP) {
  const s = String(text ?? '');
  return s.length > cap
    ? { text: s.slice(0, cap), truncated: true }
    : { text: s, truncated: false };
}

// ---- build logs ----

export const BUILD_LOG_LIMIT_DEFAULT = 200;
export const BUILD_LOG_LIMIT_MAX = 1000;

export function normalizeBuildLogLimit(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 1) return BUILD_LOG_LIMIT_DEFAULT;
  return Math.min(Math.floor(v), BUILD_LOG_LIMIT_MAX);
}

/**
 * Flatten cycle events into a readable log, newest LAST.
 *
 * `limit` keeps the TAIL, because a failed build's reason is at the end — the
 * same argument run_project_command's output makes.
 */
export function buildLogFromEvents(events = [], limit = BUILD_LOG_LIMIT_DEFAULT) {
  const all = Array.isArray(events) ? events : [];
  const kept = all.length > limit ? all.slice(-limit) : all;
  const lines = kept.map((e) => {
    const who = e.role ? ` ${e.role}` : '';
    const body = String(e.content ?? '').replace(/\s+$/, '');
    return `[${e.created_at || ''}] ${e.kind}${who}${body ? `: ${body}` : ''}`;
  });
  return {
    steps: kept,
    log: lines.join('\n'),
    omitted: all.length - kept.length,
    total_events: all.length,
  };
}

// ---- run_project_command: the allowlist ----
//
// WHAT THIS DOES AND DOES NOT BUY YOU. The allowlist bounds the COMMAND
// SURFACE, not privilege. `npm run <script>` executes whatever package.json
// says, and write_project_file can edit package.json — so any client that can
// call run_project_command can already reach arbitrary code by writing a
// script and invoking it. That is accepted, not overlooked: the same token
// already drives redeploy_project, which builds and runs the checkout. The
// allowlist exists so the ORDINARY case is narrow and auditable (a typo or a
// confused model cannot `rm -rf /` or curl something out), and so the audit
// row records an intention a human can read. It is not a sandbox, and
// docs/features/mcp.md says so in those words.
//
// The caller's tokens never reach a shell parser: the argv is handed to
// `sh -c '… "$@" …' sh <argv…>` as POSITIONAL PARAMETERS and invoked as
// `"$@"`, so each token goes to execve exactly as written. The charset check
// below is therefore belt-and-braces — it exists
// so a command carrying `;` or `$(…)` is REFUSED with a clear message rather
// than silently running as a single weird argument.

export const PROJECT_COMMAND_TIMEOUT_DEFAULT_S = 600;
export const PROJECT_COMMAND_TIMEOUT_MAX_S = 1800;
/** How much of each stream comes back. The TAIL, not the head: a failing test
 *  run prints its summary last, and that is the whole reason to call this. */
export const PROJECT_COMMAND_OUTPUT_CAP = 64 * 1024;

// Deliberately excludes `branch`, `tag`, `checkout` and `stash` — each has a
// destructive form (-D, -d, --force) and none is worth the parsing needed to
// tell the read from the write. Anything that mutates the checkout belongs in
// write_project_file, where it is committed and audited.
const GIT_READ_ONLY_SUBCOMMANDS = [
  'blame', 'cat-file', 'count-objects', 'describe', 'diff', 'diff-tree',
  'log', 'ls-files', 'ls-tree', 'rev-list', 'rev-parse', 'shortlog',
  'show', 'status',
];

// One token of an argv. No whitespace, quotes, or shell metacharacters; the
// permitted punctuation covers flags (--reporter=list), paths (e2e/a.spec.ts)
// and npm script names (test:unit).
const SAFE_ARG = /^[A-Za-z0-9._/@:=+-]+$/;

/**
 * Validate a command string against the allowlist.
 *
 * Returns `{ argv }` for something runnable, or `{ error }` with a message
 * written for the model that called it — every rejection says what IS allowed,
 * because a tool that only says "no" gets retried verbatim.
 */
export function parseProjectCommand(command) {
  const raw = String(command ?? '').trim();
  if (!raw) return { error: 'command is required — e.g. "npm run gates"' };
  if (/[\u0000-\u001f\u007f]/.test(raw)) {
    return { error: 'command must not contain control characters or newlines' };
  }
  const argv = raw.split(/\s+/);
  const bad = argv.find((tok) => !SAFE_ARG.test(tok));
  if (bad) {
    return {
      error: `"${bad}" is not a plain argument. This tool runs ONE command without a shell, so pipes, redirects, quotes, ;, && and $(…) are not supported. Run the steps as separate calls.`,
    };
  }

  const [head, ...rest] = argv;
  if (head === 'npm') {
    if (rest.length === 1 && rest[0] === 'ci') return { argv };
    if (rest.length >= 2 && rest[0] === 'run') return { argv };
    return { error: 'npm is allowed as "npm ci" or "npm run <script> [args…]" only. A package.json "test" script is reachable as "npm run test".' };
  }
  if (head === 'npx') {
    if (rest[0] === 'playwright') return { argv };
    return { error: 'npx is allowed for playwright only — e.g. "npx playwright test". Everything else should be a package.json script, run via "npm run <script>".' };
  }
  if (head === 'git') {
    if (rest.length && GIT_READ_ONLY_SUBCOMMANDS.includes(rest[0])) return { argv };
    return {
      error: `git is allowed for read-only subcommands only (${GIT_READ_ONLY_SUBCOMMANDS.join(', ')}). Changes to the checkout go through write_project_file so they are committed and audited.`,
    };
  }
  return {
    error: `"${head}" is not an allowed command. Permitted: "npm ci", "npm run <script>", "npx playwright …", and read-only git (${GIT_READ_ONLY_SUBCOMMANDS.join(', ')}).`,
  };
}

/** Clamp a caller-supplied timeout to the permitted window. */
export function projectCommandTimeoutMs(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return PROJECT_COMMAND_TIMEOUT_DEFAULT_S * 1000;
  return Math.min(Math.round(n), PROJECT_COMMAND_TIMEOUT_MAX_S) * 1000;
}

// ---- rerun_startup: timeout + tail capture ----
//
// A first-boot startup script was observed doing a full Docker engine install
// plus a 910 MB image pull inside ONE blocking rerun_startup call — no timeout
// parameter, no way to cancel, and the output slice was the tail of the FIRST
// 256 KB the host capture kept (the head of the run, not its end). The fix is
// run_project_command's own recipe: a caller-clamped deadline, and each stream
// tail'd inside the container so the last 64 KB is what comes back.

export const STARTUP_RUN_TIMEOUT_MAX_S = PROJECT_COMMAND_TIMEOUT_MAX_S;

/** Caller timeout wins (clamped to the max); otherwise the operator's
 *  configured default, itself clamped so an env var cannot exceed the cap. */
export function startupRunTimeoutMs(seconds, envDefaultMs = 120000) {
  const n = Number(seconds);
  if (Number.isFinite(n) && n > 0) return Math.min(Math.round(n), STARTUP_RUN_TIMEOUT_MAX_S) * 1000;
  const d = Number(envDefaultMs);
  if (Number.isFinite(d) && d > 0) return Math.min(Math.round(d), STARTUP_RUN_TIMEOUT_MAX_S * 1000);
  return 120000;
}

/**
 * Parse the marker-framed wrapper output shared by run_project_command and
 * rerun_startup: `PP_<nonce>_EXIT:<code>`, then the stdout tail after
 * `PP_<nonce>_OUT`, then the stderr tail after `PP_<nonce>_ERR`. The nonce is
 * per-call so output that happens to contain the marker text cannot confuse
 * the parse. `found: false` means the wrapper never reported — container
 * down, incus refused, or the deadline killed it.
 */
export function parseMarkedStreams(output, nonce) {
  const mark = (k) => `PP_${nonce}_${k}`;
  const src = String(output ?? '');
  const exitMatch = new RegExp(`${mark('EXIT')}:(-?\\d+)`).exec(src);
  if (!exitMatch) return { found: false, exit_code: null, stdout: '', stderr: '' };
  const outAt = src.indexOf(`${mark('OUT')}\n`);
  const errAt = src.indexOf(mark('ERR'));
  const stdout = outAt >= 0 && errAt > outAt
    ? src.slice(outAt + mark('OUT').length + 1, errAt).replace(/\n$/, '')
    : '';
  const stderr = errAt >= 0 ? src.slice(errAt + mark('ERR').length).replace(/^\n/, '') : '';
  return { found: true, exit_code: Number(exitMatch[1]), stdout, stderr };
}

// Trivial but shared with the LXC UI semantics: candidate startup scripts are
// the .sh files in the (effective) entry list; startup.sh at the root is the
// convention-default.
export function startupCandidates(entries) {
  const scripts = entries
    .filter((e) => !e.isDirectory && e.path.endsWith('.sh'))
    .map((e) => e.path)
    .slice(0, 100);
  return { scripts, defaultScript: scripts.includes('startup.sh') ? 'startup.sh' : null };
}
