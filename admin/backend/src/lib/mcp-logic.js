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

// The `instructions` string handed to every client at initialize. It lives
// here rather than inline in the router so it is one thing, testable, and
// impossible to drift from the catalog it describes.
//
// The first paragraph is the expensive one. An MCP call is a full model turn
// — 15-30 seconds whether it moved a megabyte or a line — so an agent that
// orients one file at a time spends its whole budget before it writes
// anything. The tools that fix that only help if the client reaches for them
// FIRST, which is why the working order is stated as an order and not as a
// list of capabilities.
export const MCP_SERVER_INSTRUCTIONS = [
  'ProxyPilot infrastructure control.',
  'WORKING ON PROJECT FILES — follow this order; it is the difference between six calls and sixty.',
  'Every tool call is a full round trip, so the count of calls is what costs you, not the bytes.',
  '(1) ORIENT with project_map — tracked files, line counts and each file\'s exported symbols in one call.',
  'Do not rebuild that picture with list_project_files plus a read per file.',
  '(2) SEARCH with search_project_files and context_lines set (5-10 is usually right):',
  'the surrounding code comes back with the hit, so do NOT follow a search with reads',
  'unless the context genuinely was not enough. files_with_matches answers "does this exist" for almost nothing.',
  '(3) READ what is left with ONE read_project_files call listing every file you need — not one call per file.',
  '(4) WRITE with apply_project_patch: send the whole change as a unified diff, one call, one commit.',
  'A sequence of edit_project_file calls for a multi-file change is the slow path; use the single-file tools',
  'only for a genuinely single-file, single-place edit. dry_run: true checks a patch without touching anything.',
  '(5) VERIFY with run_project_command (e.g. "npm run gates"), then apply with redeploy_project.',
  'Zip deploys are two-phase: inspect first, show the user any files that would be replaced, and only pass',
  'confirm_overwrite after they approve — replaced files are kept as <name>.old. For zips over ~2 MB use',
  'create_upload_ticket and PUT the bytes to its upload_url instead of inlining base64; if you cannot reach',
  'the upload URL, send the bytes over MCP with append_upload_chunk + finish_upload on the same ticket.',
  'Pass sha256 to the inspect tools so transport corruption fails loudly.',
  'File writes verify themselves: every read returns the file sha256, every write is staged, hashed and read',
  'back, and a write that does not verify is refused with the previous file left intact. A patch that does not',
  'apply cleanly leaves the checkout byte-identical. Pass the sha256 you read back as expected_sha256 (a',
  '{ path: sha } map on apply_project_patch) when something else may be editing the same file.',
  'To ADD to a large file use append_project_file or insert_project_file_at_line — neither moves the existing',
  'content, so neither can truncate it.',
  'NO TOOL HERE SPENDS THE PROJECT\'S API BUDGET: this server cannot queue a build, so an app change is',
  'yours to make with the file tools above. create_project and clone_project provision new projects',
  'deterministically; interrupt_project_build and cancel_queued_build stop harness builds started from the UI.',
  'RECLAIMING HOST RESOURCES (archiving idle projects): get_host_usage first (per_project: true says what each',
  'guest holds), then list_projects({ lifecycle: "active", pinned: false }) for the candidates, then ONE',
  'set_project_lifecycle({ action: "archive", confirm: true }) call per project — there is no archive-all verb,',
  'so each project is its own audit row and a pinned project refuses individually rather than being skipped',
  'silently — then get_host_usage again, or reclaim_report with the first snapshot as before, for the delta.',
  'Archive stops the guest and keeps everything; action: "unarchive" reverses it.',
  'STANDARDS: every AI-dev project follows the Mock2 standards (https://mock2.fractionate.ai, source',
  'git.fractionate.ai/mock2/mock2-core) and Continuous Production Readiness (CPR) v1.1. This server does not',
  'inject them — the harness lane does; over MCP they reach you only through the project tree, so before',
  'changing an app read its CLAUDE.md, state/rules.md, state/production-checklist.md and state/decisions.md',
  '(project_map lists them). Rule 0 applies to you too: never invent a gate, flag, allowlist or approval step',
  'the operator did not ask for; classify production-policy questions as a checklist item and keep building.',
  'GIT REMOTES: projects, static sites and LXC containers can be submitted to Gitea/GitHub — list_git_connectors,',
  'then set_git_remote (create_repo makes the repo) and push_git_remote; auto mode pushes after each change.',
].join(' ');

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
  // Only a number or a digit string counts: Number()'s coercion quirks would
  // otherwise read '' (and [] / true) as chunk 0 and silently misorder.
  if (typeof seq !== 'number' && typeof seq !== 'string') return null;
  const s = String(seq).trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
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
//
// Second field defect, same tool, on a host with ~15 guests: the listing began
// failing intermittently with "unparseable JSON (output may have been
// truncated)". `incus list --format json` carries every instance's full state,
// config, devices and snapshot list — roughly 10–20 KB per guest — so a
// fifteen-guest host crosses the 256 KB DEFAULT capture budget and the JSON
// arrives cut mid-object. Incus was never at fault: our own transport budget
// was. Listings therefore get their own, much larger budget, and a capped or
// short capture now SAYS so (with incus's stderr) instead of being reported as
// "incus returned bad JSON", which sent the diagnosis in the wrong direction.

// 16 MB — several hundred guests at the observed per-guest cost. The budget
// exists to stop a runaway, not to size the answer.
export const LXC_LIST_CAPTURE_CAP = 16 * 1024 * 1024;

/** Parse `incus list --format json`. Pass the runHostCapture result as the
 *  second argument and a truncated capture names itself in the error. */
export function parseLxcListJson(stdout, capture = null) {
  let list;
  try {
    list = JSON.parse(String(stdout || ''));
  } catch {
    if (capture?.stdoutTruncated) {
      return {
        error: `unparseable JSON — the output was cut at the ${capture.stdoutBytes ?? '?'}-byte capture budget, so it was truncated`,
      };
    }
    if (capture && capture.stdoutComplete === false) {
      return { error: 'unparseable JSON — stdout was still open when the incus client exited, so the output may have been truncated' };
    }
    return { error: 'unparseable JSON (output may have been truncated)' };
  }
  if (!Array.isArray(list)) return { error: 'a JSON value that is not an array' };
  return { list };
}

/** Everything known about why a listing did not come back usable, in one
 *  string: the parse verdict, how many bytes were actually captured, whether
 *  the budget or an early stdout close cut it, and incus's own stderr — which
 *  the old message dropped entirely on the parse path. */
export function lxcListFailureDetail(capture, parseError = null) {
  const bits = [];
  if (parseError) bits.push(parseError);
  if (capture?.timedOut) bits.push('the incus client timed out');
  if (capture?.error) bits.push(`spawn error: ${capture.error}`);
  if (capture?.status != null && capture.status !== 0) bits.push(`exit ${capture.status}`);
  if (capture?.stdoutBytes != null) bits.push(`${capture.stdoutBytes} bytes captured`);
  if (capture?.stdoutTruncated) bits.push('capture budget exhausted');
  else if (capture && capture.stdoutComplete === false) bits.push('stdout still open at exit');
  const err = String(capture?.stderr || '').trim();
  if (err) bits.push(`stderr: ${err.slice(-300)}`);
  return bits.length ? bits.join('; ') : 'unknown error';
}

// ---- guest addressing: which address is the one the HOST can reach ----
//
// Field defect (mailcow migration): set_route resolved a docker-ready guest's
// upstream to 172.22.1.1 — the gateway of a Docker bridge INSIDE the guest —
// and bound the route to it. The host has no route to that address, so the
// domain 502'd on every request while the binding looked perfectly correct.
// The guest's real address, on the incus-managed bridge, was 10.185.17.145 and
// sat further down the very same list: the resolver took the first non-
// loopback entry, and `incus list` reports a guest's docker0/br-*/veth*
// interfaces right alongside its NIC.
//
// The fix is to stop guessing. The guest's NIC device says which interface is
// attached to a host network (`network:` for an Incus-managed bridge,
// `parent:` for a manual one), that interface carries the address the host can
// reach, and interfaces created by a container runtime inside the guest are
// never it.
//
// The UI path (routes/lxc.js `pickIp`) has filtered docker interfaces since
// the LXC tab shipped — the MCP resolver was the one place that did not, which
// is why the same host served the same guest correctly from the dashboard and
// bound the wrong address over MCP. Reading the device goes one step further
// than `pickIp`'s eth0-first convention: a renamed NIC still resolves.

/** Interfaces a guest's own container/overlay runtime creates. Addresses on
 *  these live in the guest's private topology — routable from inside the guest
 *  and from nowhere else. */
export const GUEST_INTERNAL_IFACE = /^(lo|docker\d*|br-|br\d+|veth|virbr\d*|podman\d*|cni\d*|flannel|cali|kube|tun\d*|tap\d*|wg\d*|tailscale\d*|zt)/i;

export function isGuestInternalInterface(iface) {
  const name = String(iface || '').trim();
  if (!name) return true;
  return GUEST_INTERNAL_IFACE.test(name);
}

/** Guest-side interface names that come from a NIC device attached to a host
 *  network. Instance-level devices override profile-expanded ones — that is
 *  how a pinned eth0 (set_lxc_network) is recorded — and a device's `name` is
 *  the in-guest interface, falling back to the device key when unset, which is
 *  how Incus itself resolves it. */
export function lxcBridgeInterfaces(instance) {
  const devices = { ...(instance?.expanded_devices || {}), ...(instance?.devices || {}) };
  const out = [];
  for (const [key, dev] of Object.entries(devices)) {
    if (!dev || dev.type !== 'nic') continue;
    const network = dev.network || null;
    const parent = dev.parent || null;
    // routed/p2p NICs name no host bridge; nothing to prefer them by.
    if (!network && !parent) continue;
    const iface = String(dev.name || key || '').trim();
    if (!iface) continue;
    out.push({ interface: iface, network, parent, managed: !!network });
  }
  // Managed-network NICs first, then by name, so a multi-NIC guest resolves
  // deterministically rather than by object key order.
  out.sort((a, b) => (Number(b.managed) - Number(a.managed)) || a.interface.localeCompare(b.interface));
  return out;
}

// 0 = on a NIC attached to a host network — what the host can reach.
// 1 = eth0 by convention, for an instance whose devices we were not given.
// 2 = some other interface: unusual, but not provably internal.
// 3 = an interface the guest's own runtime created (docker0, br-*, veth*).
function addressRank(iface, bridgeIfaces) {
  if (bridgeIfaces.includes(iface)) return 0;
  if (iface === 'eth0') return 1;
  if (isGuestInternalInterface(iface)) return 3;
  return 2;
}

/** Every routable address on a guest, ordered so the address the HOST can
 *  reach comes first, each tagged with where it lives: `bridge` marks the
 *  host-attached NIC's address, `internal` marks a guest-runtime interface the
 *  host cannot route to. Consumers that need exactly one address take the
 *  first non-internal entry (lxcReachableAddress). */
export function lxcContainerAddresses(instance) {
  const bridge = lxcBridgeInterfaces(instance).map((d) => d.interface);
  const nets = instance?.state?.network || {};
  const rows = [];
  for (const [iface, net] of Object.entries(nets)) {
    if (iface === 'lo') continue;
    for (const a of net?.addresses || []) {
      // 'local' is loopback scope; 'link' is fe80:: noise — neither is an
      // address anyone routes to.
      if (a.scope === 'local' || a.scope === 'link') continue;
      const onBridge = bridge.includes(iface);
      rows.push({
        interface: iface,
        address: a.address,
        family: a.family,
        netmask: a.netmask ?? null,
        bridge: onBridge,
        internal: !onBridge && isGuestInternalInterface(iface),
      });
    }
  }
  // IPv4 before IPv6 within a rank: a Caddy upstream and an Incus static
  // reservation both want the v4 address.
  const rank = (r) => addressRank(r.interface, bridge) * 2 + (r.family === 'inet' ? 0 : 1);
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => (rank(a.r) - rank(b.r)) || (a.i - b.i))
    .map((x) => x.r);
}

/** The address the host can actually reach, or null. Returns the whole row so
 *  callers can report WHERE the answer came from — and refuse when the only
 *  candidates are internal to the guest. */
export function lxcReachableAddress(instance, { family = 'inet' } = {}) {
  return lxcContainerAddresses(instance)
    .find((r) => !r.internal && (!family || r.family === family)) || null;
}

/** The addresses deliberately passed over, for the error message that has to
 *  explain why a running guest "has no address". */
export function lxcInternalAddresses(instance, { family = 'inet' } = {}) {
  return lxcContainerAddresses(instance)
    .filter((r) => r.internal && (!family || r.family === family));
}

/** First reachable global IPv4 — the host-attached NIC's address when the
 *  instance JSON carries its devices, eth0 by convention otherwise, and never
 *  a docker0/br-* address. Accepts a whole instance (preferred) or the bare
 *  state object earlier callers passed. */
export function lxcContainerIp(stateOrInstance) {
  const o = stateOrInstance;
  const looksLikeInstance = !!o && typeof o === 'object'
    && ('state' in o || 'devices' in o || 'expanded_devices' in o || 'name' in o || 'status' in o);
  return lxcReachableAddress(looksLikeInstance ? o : { state: o })?.address || null;
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
    // The whole instance, not just its state: the devices are what tell a
    // docker-ready guest's bridge address from its internal Docker gateway.
    out.push({ name, status: c.status || null, ip: lxcContainerIp(c) });
  }
  return out;
}

// ---- host-side routability of a resolved upstream ----
//
// The interface filtering above makes the docker-bridge mis-resolution
// impossible, but a literal upstream_ip (or an exotic NIC) can still name an
// address this host has no route to, and the symptom — every request 502s
// while the binding reads correctly everywhere — costs an hour to diagnose.
// One `ip route get` before the route is written turns that into a sentence.
// Parsing only; the probe itself lives in routes/mcp.js.

/** Parse `ip route get <ip>`:
 *    10.185.17.145 dev incusbr0 src 10.185.17.1 uid 0    → directly connected
 *    172.22.1.1 via 192.168.1.1 dev eth0 src 192.168.1.5 → only via a gateway
 *    RTNETLINK answers: Network is unreachable           → no route at all
 */
export function parseIpRouteGet(stdout, stderr = '') {
  const text = `${String(stdout || '')}\n${String(stderr || '')}`.trim();
  if (!text) return { unknown: true };
  if (/unreachable|no route to host|network is down/i.test(text)) return { unreachable: true };
  const dev = text.match(/\bdev\s+(\S+)/);
  const via = text.match(/\bvia\s+(\S+)/);
  const src = text.match(/\bsrc\s+(\S+)/);
  if (!dev && !via) return { unknown: true };
  return { dev: dev?.[1] || null, via: via?.[1] || null, src: src?.[1] || null, direct: !via };
}

/** Operator-facing verdict on a resolved upstream:
 *    { blocked, reason } — refuse; a route bound here answers nothing.
 *    { warning }         — apply, but say what looks wrong.
 *    {}                  — nothing to say.
 *  An unknown or unparsed probe is NEVER a refusal: the probe is a diagnostic,
 *  not an authority, and a host where `ip` answers differently must keep
 *  working exactly as it did. */
export function upstreamRoutability(ip, route) {
  if (!route || route.unknown) return {};
  if (route.unreachable) {
    return {
      blocked: true,
      reason: `the host has no route to ${ip}, so a route bound to it would 502 on every request`,
    };
  }
  if (route.via) {
    return {
      warning: `${ip} is not on a directly connected network — this host reaches it via ${route.via} on ${route.dev || 'an unknown device'}. `
        + 'For an LXC guest that usually means the address belongs to a network INSIDE the guest (a Docker bridge) rather than to its Incus bridge.',
    };
  }
  return {};
}

// ---- incus snapshot: the CLI shape changed under us ----
//
// Field defect: every mutating LXC tool takes a pre-change snapshot first, and
// on a current Incus every one of them failed with
//     Error: unknown command "pp-mailcow" for "incus snapshot"
// because the shared helper shelled out the legacy LXD spelling
// `incus snapshot <instance> <name>`. Current Incus moved snapshot management
// into subcommands: `incus snapshot create|list|delete|restore <instance> …`.
// set_lxc_network refuses to run at all without its pre-change snapshot, so a
// stale CLI spelling blocked IP pinning outright.
//
// We prefer the subcommand form and detect the host's spelling ONCE, by
// probing `incus snapshot create --help` — rather than paying a guaranteed
// failed call on every snapshot to rediscover something that cannot change
// under a running daemon.

export const SNAPSHOT_CLI_SUBCOMMAND = 'subcommand';   // incus snapshot create <instance> <name>
export const SNAPSHOT_CLI_LEGACY = 'legacy';           // incus snapshot <instance> <name>

/** argv for one snapshot verb in the given CLI form. Only `create` ever had a
 *  positional spelling; list/delete/restore are subcommand-only in both
 *  clients that matter, so they always render as subcommands. */
export function snapshotArgv(verb, instance, snapName = null, form = SNAPSHOT_CLI_SUBCOMMAND) {
  const tail = snapName ? [instance, snapName] : [instance];
  if (verb === 'create' && form === SNAPSHOT_CLI_LEGACY) return ['snapshot', ...tail];
  return ['snapshot', verb, ...tail];
}

/** Read the CLI form off a probe of `incus snapshot create --help`.
 *  null = could not tell (client missing, timed out, unexpected output) — the
 *  caller then uses the CURRENT spelling and lets the one-shot fallback
 *  correct it, which is the right way round: the legacy client is the rare
 *  one. */
export function snapshotCliFormFromProbe(probe) {
  if (!probe || probe.error) return null;
  const text = `${probe.stdout || ''}\n${probe.stderr || ''}`;
  // A client without the subcommand says so in as many words.
  if (/unknown command/i.test(text)) return SNAPSHOT_CLI_LEGACY;
  if (probe.status !== 0) return null;
  return /snapshot\s+create/i.test(text) ? SNAPSHOT_CLI_SUBCOMMAND : SNAPSHOT_CLI_LEGACY;
}

/** Is this failure the OTHER CLI shape talking? `unknown command "X" for
 *  "incus snapshot"` is the only stderr that justifies re-trying a snapshot in
 *  the other spelling — every other failure (name taken, guest gone, pool
 *  full) must surface as itself instead of being retried into a second,
 *  more confusing error. */
export function isSnapshotCliShapeError(stderr) {
  return /unknown command\s+"[^"]*"\s+for\s+"incus snapshot"/i.test(String(stderr || ''));
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
//
// A deny token that is a single short option (`-o`) additionally matches the
// clustered and attached spellings (`-sSo`, `-o/tmp/x`, `-fsSLo`) — anything
// else lets the exact same flag through under a different byte sequence. A
// long-option deny token (`--output`) also matches the joined `--output=/x`
// form. Deny-side over-matching is the safe direction: a false positive costs
// a retry with separated flags, a false negative is arbitrary file delivery.
function tokenMatchesDenyToken(tok, denyTok) {
  if (tok === denyTok) return true;
  if (denyTok.startsWith('--')) return tok.startsWith(`${denyTok}=`);
  if (/^-[A-Za-z]$/.test(denyTok) && /^-[A-Za-z]/.test(tok) && !tok.startsWith('--')) {
    return tok.slice(1).includes(denyTok[1]);
  }
  return false;
}

function argvMatchesDeny(argv, prefix) {
  if (argvHasPrefix(argv, prefix)) return true;
  if (!Array.isArray(prefix) || prefix.length < 2) return false;
  if (argv[0] !== prefix[0]) return false;
  return prefix.slice(1).every((tok) => argv.some((a) => tokenMatchesDenyToken(a, tok)));
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
  // Ordered host-reachable-first and tagged (bridge / internal), because
  // every consumer of this list — set_route's upstream, set_lxc_network's
  // "current" address, the agent reading the tool output — wants the address
  // the HOST can reach, and a docker-ready guest reports its internal Docker
  // gateway in exactly the same list.
  const addresses = lxcContainerAddresses(instance);
  const primary = addresses.find((a) => !a.internal && a.family === 'inet') || null;
  return {
    status: instance?.status || null,
    created_at: instance?.created_at || null,
    ephemeral: !!instance?.ephemeral,
    profiles: instance?.profiles || [],
    addresses,
    // The one address other tools should bind to. Null with a non-empty
    // `addresses` means every address the guest holds is internal to it.
    primary_address: primary?.address || null,
    primary_interface: primary?.interface || null,
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

/**
 * Summarize Caddy JSON access-log lines over a time window.
 *
 * Every merged site file logs to /var/log/caddy/<domain>.log in Caddy's
 * default JSON encoding (`ts` = unix seconds). The caller tails the file and
 * hands the text here; unparseable lines are skipped, entries outside the
 * window ignored. Only counts leave — no URLs, no headers, no bodies — so
 * nothing sensitive can ride out through an error summary.
 */
export function summarizeAccessLog(text, nowMs, windowSeconds = 3600) {
  const windowStartMs = nowMs - windowSeconds * 1000;
  let requests = 0;
  let errors5xx = 0;
  const byErrorStatus = {};
  let oldestSeenMs = null;
  for (const line of String(text ?? '').split('\n')) {
    if (!line) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const ts = Number(e?.ts);
    const status = Number(e?.status);
    if (!Number.isFinite(ts) || !Number.isFinite(status)) continue;
    const tsMs = ts * 1000;
    if (oldestSeenMs === null || tsMs < oldestSeenMs) oldestSeenMs = tsMs;
    if (tsMs < windowStartMs || tsMs > nowMs + 60000) continue;
    requests += 1;
    if (status >= 500 && status <= 599) {
      errors5xx += 1;
      byErrorStatus[status] = (byErrorStatus[status] || 0) + 1;
    }
  }
  return {
    window_seconds: windowSeconds,
    requests,
    errors_5xx: errors5xx,
    by_error_status: byErrorStatus,
    // When the tail we read starts INSIDE the window, older requests exist
    // that we did not see — the counts are a floor, and the caller says so.
    partial_window: oldestSeenMs !== null && oldestSeenMs > windowStartMs,
  };
}

/** The access-log path the merged Caddy site file writes for a domain
 *  (wildcards sanitized the same way caddyFileName does). */
export function caddyAccessLogPath(domain) {
  return `/var/log/caddy/${String(domain).replace(/\*/g, '_wildcard_')}.log`;
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

// ---- LXC observe: file listings, unit names, systemctl parsing ----

/**
 * Parse `stat -c '%A|%s|%Y|%N' …` lines into file entries. %N renders as
 * 'name' or 'name' -> 'target' for symlinks; %A's first char gives the type.
 */
export function parseStatFileList(stdout) {
  const entries = [];
  for (const line of String(stdout ?? '').split('\n')) {
    if (!line) continue;
    const m = /^([A-Za-z-]{10,11})\|(\d+)\|(\d+)\|(.*)$/.exec(line);
    if (!m) continue;
    const mode = m[1];
    const names = /^'(.*?)'(?: -> '(.*)')?$/.exec(m[4]);
    const type = mode[0] === 'd' ? 'dir' : mode[0] === 'l' ? 'symlink' : 'file';
    entries.push({
      path: names ? names[1] : m[4],
      type,
      size: Number(m[2]),
      mode: mode.slice(1, 10),
      mtime: new Date(Number(m[3]) * 1000).toISOString(),
      ...(type === 'symlink' && names?.[2] ? { target: names[2] } : {}),
    });
  }
  return entries;
}

/** Parse `systemctl show -p A,B` key=value output. */
export function parseSystemctlShow(stdout) {
  const out = {};
  for (const line of String(stdout ?? '').split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

/** A systemd unit name safe to hand journalctl as an argv token. */
export function validUnitName(s) {
  const v = String(s ?? '').trim();
  if (!v || v.length > 128 || v.startsWith('-')) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9@._-]*(\.(service|socket|timer|target|mount|path))?$/.test(v)) return null;
  return v;
}

/** A probe target host: IPv4 or a DNS name label chain. */
export function validProbeHost(s) {
  const v = String(s ?? '').trim();
  if (!v || v.length > 253 || v.startsWith('-')) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(v)) return null;
  return v;
}

/** A simple filename glob for grep --include (no paths, no traversal). */
export function validFileGlob(s) {
  const v = String(s ?? '').trim();
  if (!v || v.length > 100) return null;
  if (!/^[A-Za-z0-9*?\[\]._-]+$/.test(v)) return null;
  return v;
}

/** A static-site/service id: uuid or legacy integer, as stored (TEXT column).
 *  The old Number() coercion turned every uuid id into NaN — which read as
 *  "Static site not found" for every UI-created site. */
export function normalizeServiceId(v) {
  const s = String(v ?? '').trim();
  if (!s || s.length > 64) return null;
  if (!/^[A-Za-z0-9-]+$/.test(s)) return null;
  return s;
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
        service_id: { type: ['number', 'string'], description: 'Static site id from list_static_sites (uuid string for UI-created sites, integer for legacy ones).' },
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
        service_id: { type: ['number', 'string'] },
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
    description: 'Full detail for one LXC/Incus guest: status, every non-loopback IP address (host-reachable first, each tagged bridge/internal, with primary_address naming the one on the guest\'s Incus bridge — addresses tagged internal belong to a Docker/overlay network INSIDE the guest and the host cannot route to them), the security/limits/boot config subset (security.nesting, security.privileged, limits.*, boot.autostart), profiles, snapshots, and the registered startup script (path + working dir). The LXC counterpart of get_project — use it before planning changes instead of probing with file reads.',
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
    name: 'list_lxc_files',
    description: 'List files under a directory inside an LXC guest (path, type, size, mode, mtime, symlink target). Counterpart of list_project_files. Capped at 2000 entries. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        container: { type: 'string' },
        path: { type: 'string', description: 'Absolute directory inside the guest, e.g. /opt/app.' },
        recursive: { type: 'boolean', description: 'Recurse into subdirectories (default false).' },
      },
      required: ['container', 'path'],
      additionalProperties: false,
    },
  },
  {
    name: 'search_lxc_files',
    description: 'Grep text files under a directory inside an LXC guest (extended regex, binary files skipped). Counterpart of search_project_files: returns path + line_number + the matching line, capped at 200 matches. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        container: { type: 'string' },
        path: { type: 'string', description: 'Absolute directory to search under.' },
        pattern: { type: 'string', description: 'Extended regular expression.' },
        glob: { type: 'string', description: 'Optional filename glob filter, e.g. *.yml.' },
      },
      required: ['container', 'path', 'pattern'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_lxc_logs',
    description: 'Fetch recent log output from inside an LXC guest without redeploying anything: the registered ProxyPilot startup service (source=startup), any systemd unit (source=journal + unit), or docker compose logs (source=docker-compose + compose_dir). Last N lines (default 100, max 1000). Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        container: { type: 'string' },
        source: { type: 'string', enum: ['startup', 'journal', 'docker-compose'] },
        unit: { type: 'string', description: 'systemd unit name when source=journal, e.g. docker.service.' },
        compose_dir: { type: 'string', description: 'Directory containing docker-compose.yml when source=docker-compose.' },
        lines: { type: 'number', description: 'Line count, default 100, max 1000.' },
      },
      required: ['container', 'source'],
      additionalProperties: false,
    },
  },
  {
    name: 'probe_lxc_port',
    description: 'From inside an LXC guest, probe a host:port: TCP reachability, and for http/https the status code, server header, response time, and optionally whether a WebSocket upgrade completes. Never returns a response body. The one-call answer to "is the app up behind the proxy" — an in-guest 401 with an edge 502 means the proxy binding is broken, not the app (pair with test_route for the edge side).',
    inputSchema: {
      type: 'object',
      properties: {
        container: { type: 'string' },
        host: { type: 'string', description: 'Target host, default 127.0.0.1.' },
        port: { type: 'number' },
        scheme: { type: 'string', enum: ['tcp', 'http', 'https'], description: 'Default http.' },
        path: { type: 'string', description: 'URL path for http/https probes, default /.' },
        test_websocket: { type: 'boolean', description: 'Also attempt a WebSocket upgrade on the same path (default false).' },
        timeout_seconds: { type: 'number', description: 'Default 10, max 60.' },
      },
      required: ['container', 'port'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_lxc_startup',
    description: 'The registered startup script for an LXC guest: script path, working dir, full content, and the systemd unit\'s state — last exit code, last start/exit timestamps. Previously visible only as a side effect of inspect_lxc_zip. Read-only.',
    inputSchema: {
      type: 'object',
      properties: { container: { type: 'string' } },
      required: ['container'],
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
    description: 'Read a text file from inside an LXC container (e.g. /opt/app/config.json). Use this to see the current content before proposing an edit with write_lxc_file. Returns up to 512 KB, plus the file\'s sha256 and total_lines; refuses binary files. A read that came back short of the file\'s real size is an error, never a silently partial result — so what you get is either the whole file or an explicit truncated: true.',
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
    description: 'Write one text file inside an LXC container. If the file already exists and confirm_overwrite is not true, this returns the current file info instead of writing — show the user your proposed change and get their go-ahead first. On overwrite the previous version is kept as `<path>.old`. Parent directories are created. The write is staged, hashed and read back before it counts as done, so a partial or corrupted write is reported as an error with the previous file left intact — it never lands silently. Pass mode (e.g. "0755") to make a script executable in the same call. After config/code edits, redeploy with rerun_startup.',
    inputSchema: {
      type: 'object',
      properties: {
        container: { type: 'string' },
        path: { type: 'string', description: 'Absolute file path inside the container.' },
        content: { type: 'string', description: 'The complete new file content (UTF-8).' },
        confirm_overwrite: { type: 'boolean', description: 'Set true only after the user approved replacing the existing file.' },
        mode: { type: 'string', description: 'Optional file permissions as three octal digits, e.g. "0755" for an executable script or "644". Default: the existing file\'s mode, which is preserved across the write.' },
        expected_sha256: { type: 'string', description: 'Optional precondition: the SHA-256 the file had when you read it (read_lxc_file returns it as sha256). The call is refused if the file has changed since — the guard against two agents editing the same file at once.' },
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
    name: 'create_static_site',
    description: 'Register a new static site: name, domain, a docroot with a placeholder index, and TLS issuance through the same pipeline the UI uses. Creation-only — fails if the domain is already routed, never replaces. Returns the site id the zip-deploy and file tools take. Requires confirm: true.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        domain: { type: 'string' },
        tls: { type: 'boolean', description: 'HTTPS with automatic certificates. Default true.' },
        confirm: { type: 'boolean', description: 'Must be true.' },
      },
      required: ['name', 'domain', 'confirm'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_static_site',
    description: 'Detail for one static site: routed domains, docroot path with file count / total bytes / newest mtime, TLS policy, and the issued certificate\'s validity when one is on disk. Counterpart of get_project. Read-only.',
    inputSchema: {
      type: 'object',
      properties: { site_id: { type: ['number', 'string'], description: 'From list_static_sites.' } },
      required: ['site_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_static_site_files',
    description: 'List the deployed files of a static site (path, size, mtime), optionally under one subdirectory. Capped at 2000 entries. The zip apply is no longer write-only. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        site_id: { type: ['number', 'string'] },
        subdir: { type: 'string', description: 'Limit the listing to a subdirectory of the docroot.' },
      },
      required: ['site_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_static_site_file',
    description: 'Read one text file from a static site\'s docroot (up to 512 KB, refuses binary) — same contract as read_lxc_file. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        site_id: { type: ['number', 'string'] },
        path: { type: 'string', description: 'Path relative to the docroot.' },
      },
      required: ['site_id', 'path'],
      additionalProperties: false,
    },
  },
  {
    name: 'write_static_site_file',
    description: 'Write one text file into a static site\'s docroot with the write_lxc_file safety contract: existing files need confirm_overwrite: true and the previous version is kept as <path>.old. Single-file fixes (a typo, robots.txt, one stylesheet) without a full zip redeploy; changes serve immediately.',
    inputSchema: {
      type: 'object',
      properties: {
        site_id: { type: ['number', 'string'] },
        path: { type: 'string', description: 'Path relative to the docroot.' },
        content: { type: 'string' },
        confirm_overwrite: { type: 'boolean', description: 'Required (true) when the file exists.' },
      },
      required: ['site_id', 'path', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_static_site_cert',
    description: 'TLS certificate status for a static site\'s primary domain: policy (ACME vs manual), issuer, validity window, days until expiry, and status. Read-only.',
    inputSchema: {
      type: 'object',
      properties: { site_id: { type: ['number', 'string'] } },
      required: ['site_id'],
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
    description: 'Full detail for one hostname: every route on the domain with its upstream resolution, the TLS policy (ACME vs manual cert), the issued certificate\'s validity when one is on disk, and recent error counts from the domain\'s access log (requests and 5xx totals over the last hour, by status — counts only, never URLs or headers). Read-only.',
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
        upstream_container: { type: 'string', description: 'LXC guest name (without pp-); mutually exclusive with upstream_ip. Preferred: the address is resolved from the guest\'s Incus-bridge NIC (never a Docker bridge inside the guest) and it pairs with set_lxc_network so IP changes cannot silently break the route.' },
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
    description: 'List ProxyPilot AI-dev projects (id, name, url, lifecycle, pinned, latest build status). Optional filters: lifecycle (active | stopped | archived | all, default all — matched exactly, so a stopped project is neither active nor archived) and pinned (boolean). pinned is the Projects-page star, read project-wide: true when ANY user has pinned it, and set_project_lifecycle refuses to archive a pinned project. The archive flow starts here: list_projects({ lifecycle: "active", pinned: false }) is the set of candidates.',
    inputSchema: {
      type: 'object',
      properties: {
        lifecycle: { type: 'string', enum: ['active', 'stopped', 'archived', 'all'], description: 'Keep only projects in this lifecycle. Default all.' },
        pinned: { type: 'boolean', description: 'Keep only pinned (true) or unpinned (false) projects. Omit for both.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_project',
    description: 'Details for one AI-dev project: lifecycle, pinned, live URL, container (the Incus instance name — project guests are named m2-<id> and carry no pp- prefix) and container_status (running | stopped | none), latest build cycle status, the build queue, and shipped builds still awaiting operator verification. This server cannot start a build — the queue is reported so you can see, cancel or stop harness work that was started from the UI.',
    inputSchema: {
      type: 'object',
      properties: { project_id: { type: 'number' } },
      required: ['project_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'set_project_lifecycle',
    description: 'Archive or unarchive ONE AI-dev project, reversibly. archive: refused while the project is pinned (unpin it in the UI or with set_project_pinned first — never silently skipped) or while a build is running or queued (interrupt_project_build / cancel_queued_build). Otherwise it checkpoints the working tree into the bare repo, snapshots the guest (same auto-snapshot set_lxc_config takes), cleanly stops the container when stop_container is true (default), sets boot.autostart=false so it stays down across a host reboot, and marks lifecycle archived. Routes, DNS, the checkout, the database and the container itself are all KEPT — nothing is freed except memory and CPU — so unarchive is a pure reversal: previous lifecycle back, boot.autostart restored, the container started if the archive stopped it, the route republished and re-verified with test_route. The result carries previous_lifecycle plus the snapshot name so a second call undoes it, and a change record is appended. There is deliberately no archive-all verb: one project per call, so every archive is its own audit row. Requires confirm: true. Policy: lib/mcp-policy/project-lifecycle-allowlist.json.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'number' },
        action: { type: 'string', enum: ['archive', 'unarchive'] },
        confirm: { type: 'boolean', description: 'Must be true.' },
        stop_container: { type: 'boolean', description: 'archive only: cleanly stop the guest (default true). false keeps it running (and fenced) — useful to archive the project record while a long job finishes. Ignored on unarchive.' },
      },
      required: ['project_id', 'action', 'confirm'],
      additionalProperties: false,
    },
  },
  {
    name: 'set_project_pinned',
    description: 'Pin or unpin an AI-dev project — the same star the Projects page shows, which set_project_lifecycle treats as "do not archive". pinned:true stars it for the token\'s owner; pinned:false removes every user\'s star so the project-wide flag reads false afterwards. Pinning an archived project is allowed (it just protects it from bulk operations). Returns previous_pinned so the change can be reversed. Requires confirm: true.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'number' },
        pinned: { type: 'boolean' },
        confirm: { type: 'boolean', description: 'Must be true.' },
      },
      required: ['project_id', 'pinned', 'confirm'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_host_usage',
    description: 'Snapshot of the ProxyPilot HOST\'s resources, read from the host itself (never from inside a guest): CPU cores + load averages, memory, swap, disk for / plus the Incus storage pool, the pool\'s own usage, and container counts with the top running guests by memory (from incus list). per_project: true adds one row per AI-dev project (container, status, memory_mb, disk_gb) so you can say what archiving a project would reclaim before doing it. Read-only, no confirm. Take one before and one after a batch of set_project_lifecycle calls and hand both to reclaim_report.',
    inputSchema: {
      type: 'object',
      properties: {
        per_project: { type: 'boolean', description: 'Add per-project container usage (default false).' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'reclaim_report',
    description: 'Deterministic before/after comparison of two get_host_usage snapshots: memory_freed_mb, containers_stopped, load_delta, disk_freed_gb and a one-paragraph summary. Pass the earlier snapshot as before; omit after to have the server take a fresh snapshot now. Pure arithmetic — it exists so the comparison is not left to the agent. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        before: { type: 'object', description: 'A get_host_usage result taken earlier.' },
        after: { type: 'object', description: 'A later get_host_usage result. Omitted: a fresh snapshot is taken.' },
      },
      required: ['before'],
      additionalProperties: false,
    },
  },
  {
    name: 'upload_project_reference',
    description: 'Add a text reference file (spec, notes, exported page) to a project\'s asset library. Stored as-is: this server never runs the paid summary pass, so the project reads the full file rather than a brief (summarize it from the UI if a brief is wanted).',
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
    description: 'Stop the build currently running on an AI-dev project (builds are started from the UI — this server cannot start one). Default action stop_after_step checkpoints at the next step boundary (resumable from the UI); abandon discards the in-progress cycle. Use this when a build was queued by mistake or is burning API budget on the wrong thing.',
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
    description: 'Cancel a queued (not yet started) build on an AI-dev project — one queued from the UI, since this server cannot start builds. get_project lists queued builds with their ids. A build that has already started must be stopped with interrupt_project_build instead.',
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
    description: 'List the tracked source files of an AI-dev project (git ls-files in its app checkout) — paths only. To ORIENT in a repo you do not know, call project_map instead: the same listing plus line counts and each file\'s exported symbols, so you can choose what to open without reading anything first. Optionally limit to a subdirectory.',
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
    description: 'Read one text file from an AI-dev project\'s app checkout (path relative to the app root, e.g. src/server/routes.ts). Returns up to 512 KB; refuses binary files. Pass offset/limit to read a LINE RANGE instead of the whole file — pair it with search_project_files (which gives you path + line_number) to read just the part you need. total_lines always reports the file\'s real length, whether or not a range was requested. Reading more than one file? Use read_project_files instead — same semantics, several files, one call. Also returns sha256, the file\'s hash as computed inside the container — pass it back as expected_sha256 on a later edit/write to be sure nothing changed underneath you. A read that arrives short of the file\'s real size is reported as an error rather than returned as if it were the file.',
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
    description: 'Search an AI-dev project\'s tracked files for a regular expression (git grep -E). SET context_lines — with it the result carries the surrounding code, which is the whole point: a search that returns bare line numbers costs a further read_project_file call per hit, and each of those is a full round trip. Default to context_lines 5-10 and only read a file afterwards if the context genuinely was not enough. Pass files_with_matches: true for a cheap "does this symbol exist anywhere" probe (paths only). Binary files are skipped; the search covers tracked files only.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'number' },
        pattern: { type: 'string', description: 'Extended regular expression (POSIX ERE, as git grep -E takes).' },
        glob: { type: 'string', description: 'Optional git pathspec to limit the search, e.g. "src/**/*.ts" or "apps/freshcut".' },
        max_results: { type: 'number', description: 'Cap on returned matches (default 200, max 1000).' },
        ignore_case: { type: 'boolean', description: 'Case-insensitive match.' },
        context_lines: { type: 'number', description: 'Lines of context around each hit (git grep -C), 0-20, default 0. With this set the result is `blocks` — contiguous runs of { path, start_line, lines[], match_lines[] } — instead of bare matching lines, and you usually will not need to read the file at all.' },
        files_with_matches: { type: 'boolean', description: 'Return only the paths that contain a match (git grep -l), not the lines. The cheapest way to ask whether something exists and where it lives.' },
        max_bytes: { type: 'number', description: 'Byte budget for the returned text (default 128 KB, max 512 KB), so a wide context_lines cannot blow up the response. Anything cut is reported as truncated.' },
      },
      required: ['project_id', 'pattern'],
      additionalProperties: false,
    },
  },
  {
    name: 'project_map',
    description: 'One-call orientation in an AI-dev project: every tracked file with its line count, plus the top-level symbols each one declares (exported functions, classes, consts, types, default exports, and route registrations). Start here when you do not already know where the code lives — it replaces the list-then-read-a-bit-of-each loop that otherwise costs a round trip per file. The symbol index is REGEX-EXTRACTED and approximate: it is a map for deciding what to open, not a compiler, so treat a missing symbol as "look again", not as "it is not there". Narrow it with subdir on a big repo.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'number' },
        subdir: { type: 'string', description: 'Relative directory to map, e.g. src/server. Omit for the whole checkout.' },
        max_files: { type: 'number', description: 'Cap on files in the map (default 400, max 2000). Anything omitted is counted and reported, never silently dropped.' },
        max_symbols_per_file: { type: 'number', description: 'Cap on symbols listed per file (default 40, max 200).' },
      },
      required: ['project_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_project_files',
    description: 'Read SEVERAL text files (or line ranges) from an AI-dev project in ONE call — same semantics, same 512 KB per-file cap and same sha256 as read_project_file, up to 50 files at a time. Use this rather than a sequence of read_project_file calls whenever you already know which files you need: the round trip, not the bytes, is what costs you. Nothing is ever partially returned — a file over the per-file cap, or one that does not fit in what is left of the response budget, comes back in `dropped` with its size and the reason, so a short answer never reads like a complete one.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'number' },
        files: {
          type: 'array',
          description: 'Up to 50 entries. Each is { path, offset?, limit? } with the same meaning as read_project_file — omit offset/limit for the whole file. The same path may appear more than once with different ranges.',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'File path relative to the app root.' },
              offset: { type: 'number', description: 'First line to return, 1-based (default 1).' },
              limit: { type: 'number', description: 'How many lines to return from offset (default: the rest of the file).' },
            },
            required: ['path'],
            additionalProperties: false,
          },
        },
        max_total_bytes: { type: 'number', description: 'Response budget across all files (default 512 KB, max 1 MB). Files are read in the order given; anything that will not fit is listed in `dropped` rather than truncated.' },
      },
      required: ['project_id', 'files'],
      additionalProperties: false,
    },
  },
  {
    name: 'apply_project_patch',
    description: 'Apply a unified diff to an AI-dev project\'s checkout and commit it — ONE call for a change of any shape or size, instead of the 2-3 calls per file a sequence of edit_project_file/write_project_file costs. This is the right tool for any multi-file change, and for a multi-hunk change to a single file. Send exactly what `git diff` produces (paths as a/… and b/…); adds, deletes and renames are all supported. Applied with `git apply --3way --index`, ALL OR NOTHING: if any hunk does not fit, nothing is written, the checkout is left byte-identical, and the result names the rejected hunks and why. Set dry_run: true to check the same thing without touching anything. Pass expected_sha256 as a { path: sha } map to refuse the patch if any of those files changed since you read them. Refused while a build is running.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'number' },
        patch: { type: 'string', description: 'The unified diff, verbatim (up to 1 MB inline). For anything larger use create_upload_ticket and pass the ticket instead.' },
        ticket: { type: 'string', description: 'Upload ticket carrying the diff bytes, as an alternative to inline patch for large diffs — create_upload_ticket, then PUT the bytes to its upload_url (or append_upload_chunk + finish_upload), then pass the ticket here.' },
        sha256: { type: 'string', description: 'Optional but recommended: hex SHA-256 of the patch bytes. Verified before git sees the diff, so a corrupted transfer fails as a checksum mismatch rather than as a confusing rejected hunk.' },
        dry_run: { type: 'boolean', description: 'Report what the patch WOULD change (per-file paths, change types and line counts) and whether it applies cleanly, without writing anything. Nothing is committed and no file is touched.' },
        commit_message: { type: 'string', description: 'Git commit message (a sensible default is used if omitted).' },
        expected_sha256: {
          type: 'object',
          description: 'Optional precondition map, path → the SHA-256 that file had when you read it (read_project_file / read_project_files return it). The whole patch is refused if any of them has changed since — the guard against two agents editing the same files at once.',
          additionalProperties: { type: 'string' },
        },
      },
      required: ['project_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'edit_project_file',
    description: 'Replace an exact string in ONE file of an AI-dev project and commit the change — the surgical alternative to write_project_file, which rewrites the whole file. Changing several files, or several places at once? Send a unified diff to apply_project_patch instead: one call, one commit, and it is refused as a whole rather than landing half a change. Fails if old_string is absent, or if it matches a different number of times than expected (default: exactly once), so an edit can never land somewhere you did not mean. The result is also checked against arithmetic — a string replacement has exactly one possible byte length, and a write that misses it is refused with the file left untouched — then staged, hashed and read back before it counts as done. Refused while a build is running.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'number' },
        path: { type: 'string', description: 'File path relative to the app root.' },
        old_string: { type: 'string', description: 'The exact text to replace, copied from read_project_file. Include enough surrounding lines to make it unique.' },
        new_string: { type: 'string', description: 'What to put in its place. May be empty to delete the text.' },
        expect_occurrences: { type: 'number', description: 'How many times old_string should appear. Default 1. The edit is refused unless the real count matches exactly.' },
        expected_sha256: { type: 'string', description: 'Optional precondition: the SHA-256 the file had when you read it (read_project_file returns it as sha256). The call is refused if the file has changed since — the guard against two agents editing the same file at once.' },
        commit_message: { type: 'string', description: 'Git commit message (a sensible default is used if omitted).' },
      },
      required: ['project_id', 'path', 'old_string', 'new_string'],
      additionalProperties: false,
    },
  },
  {
    name: 'append_project_file',
    description: 'Append text to the end of one file in an AI-dev project and commit it. Unlike write_project_file this never moves the existing content anywhere — the file stays where it is and only the new bytes travel — so it works on files of any size, including ones too large for edit_project_file. The file must end up exactly its previous length plus what you sent; if it does not, the append is rolled back and reported as an error. Refused while a build is running.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'number' },
        path: { type: 'string', description: 'File path relative to the app root.' },
        content: { type: 'string', description: 'Text to append verbatim. Include your own leading/trailing newlines — nothing is added.' },
        create: { type: 'boolean', description: 'Create the file if it does not exist yet (default false: appending to a missing file is an error).' },
        expected_sha256: { type: 'string', description: 'Optional precondition: the SHA-256 the file had when you read it (read_project_file returns it as sha256). The call is refused if the file has changed since — the guard against two agents editing the same file at once.' },
        commit_message: { type: 'string', description: 'Git commit message (a sensible default is used if omitted).' },
      },
      required: ['project_id', 'path', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'insert_project_file_at_line',
    description: 'Insert text into one file of an AI-dev project BEFORE a given 1-based line, and commit it. Like append_project_file, the existing content never leaves the container, so this is the way to add an import, a route or a block to a file too big to read whole. Use search_project_files or read_project_file (offset/limit) to find the line first. A trailing newline is added if you leave it off; line = total_lines + 1 inserts at the end. The result must be exactly the old size plus what you sent, or nothing is written. Refused while a build is running.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'number' },
        path: { type: 'string', description: 'File path relative to the app root.' },
        line: { type: 'number', description: '1-based line number to insert BEFORE. 1 puts the text at the top of the file.' },
        content: { type: 'string', description: 'Text to insert. A trailing newline is added if missing so the following line is not welded onto yours.' },
        expected_sha256: { type: 'string', description: 'Optional precondition: the SHA-256 the file had when you read it (read_project_file returns it as sha256). The call is refused if the file has changed since — the guard against two agents editing the same file at once.' },
        commit_message: { type: 'string', description: 'Git commit message (a sensible default is used if omitted).' },
      },
      required: ['project_id', 'path', 'line', 'content'],
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
    description: 'Write one text file in an AI-dev project\'s app checkout and commit it to the project\'s git history (the previous version stays recoverable via git — no build tokens are spent). If the file exists and confirm_overwrite is not true, returns the current file info instead of writing — show the user the proposed change first. The write is staged, hashed and read back before it counts as done, so a partial write is an error with the previous file intact rather than a silent truncation. Returns bytes, total_lines and sha256 of what actually landed. Refused while a build is running (interrupt it first). After your edits, apply them with redeploy_project.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'number' },
        path: { type: 'string', description: 'File path relative to the app root.' },
        content: { type: 'string', description: 'The complete new file content (UTF-8).' },
        commit_message: { type: 'string', description: 'Git commit message for this edit (a sensible default is used if omitted).' },
        confirm_overwrite: { type: 'boolean', description: 'Set true only after the user approved replacing the existing file.' },
        expected_sha256: { type: 'string', description: 'Optional precondition: the SHA-256 the file had when you read it (read_project_file returns it as sha256). The call is refused if the file has changed since — the guard against two agents editing the same file at once.' },
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
    name: 'create_project',
    description: 'Create a new AI-dev project from scratch (the counterpart to clone_project): mints <slug>.<parent domain> from the name, provisions the container and seeds the base app. Returns immediately — poll get_project on the new id until lifecycle is active. parent_domain_id is optional when the install has exactly one usable parent domain; otherwise pass it (or parent_domain by name) and an ambiguous call answers with the choices. Spends no API budget: provisioning is deterministic and no build is started.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Project name; the subdomain is derived from it ("My App" -> my-app.<domain>). A duplicate name is refused, not disambiguated.' },
        description: { type: 'string', description: 'Optional one-line description.' },
        parent_domain_id: { type: 'number', description: 'Parent domain to mint the subdomain under. Optional when exactly one is usable.' },
        parent_domain: { type: 'string', description: 'Parent domain by name (e.g. example.com), instead of parent_domain_id.' },
        use_base_domain: { type: 'boolean', description: 'Also serve on the parent domain itself (example.com), not just the minted subdomain. Refused when another service already answers there.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_git_connectors',
    description: 'List the git connectors an admin configured under Projects → Connectors → Git connectors (Gitea base URL + API token, GitHub token, generic HTTPS/SSH). Read-only; credentials are never returned. Use a connector name or id with set_git_remote.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'set_git_remote',
    description: 'Bind a git remote to something ProxyPilot hosts so it can be submitted to Gitea (or GitHub): kind "project" (target = project id; the bare repo is pushed), "static_site" (target = site id; the docroot is snapshotted into a mirror and pushed) or "lxc" (target = container name; the directory inside the guest — source_dir, default the registered startup directory — is snapshotted and pushed). Optional at any time: before the first content lands or after. create_repo (default true) creates the repository on a Gitea/GitHub token connector when it does not exist. push_mode "auto" pushes after every checkpoint (project) or every content change ProxyPilot makes (static_site/lxc); "manual" (default) only on push_git_remote. Credentials stay on the connector and never enter a container.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['project', 'static_site', 'lxc'] },
        target: { type: ['string', 'number'], description: 'Project id, static site id, or container name (no pp- prefix).' },
        connector: { type: 'string', description: 'Git connector name (or id as text). Optional when exactly one connector exists.' },
        connector_id: { type: 'number' },
        remote_repo: { type: 'string', description: 'owner/name on the connector\'s host (e.g. fractionate/my-site), or a full https/ssh URL.' },
        push_mode: { type: 'string', enum: ['manual', 'auto'] },
        source_dir: { type: 'string', description: 'lxc only: absolute directory inside the container to mirror. Default: the registered startup working dir.' },
        create_repo: { type: 'boolean', description: 'Create the repository on the remote if missing (Gitea/GitHub token connectors). Default true.' },
      },
      required: ['kind', 'target', 'remote_repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'push_git_remote',
    description: 'Push a project, static site or LXC container to the git remote set with set_git_remote, now. For static_site/lxc this snapshots the current content into the mirror (one commit, message carries `reason`) and pushes main; unchanged content answers unchanged: true and pushes nothing. The outcome is recorded on the remote (last_push_at / last_push_error).',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['project', 'static_site', 'lxc'] },
        target: { type: ['string', 'number'] },
        reason: { type: 'string', description: 'Short note for the commit message (static_site/lxc), e.g. "before startup change".' },
      },
      required: ['kind', 'target'],
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

// ---- write integrity: the byte-count invariant, the read-back, the
//      precondition ----
//
// Five silent file corruptions came out of one shape of bug: a read that came
// back short (the host capture wrapper stopped at 256 KB while the tool
// advertised 512 KB), a replacement applied to that partial copy, and the
// partial copy written back over the real file. Nothing errored. The cut
// points varied with the chunk boundary, so it read as a race rather than a
// limit, which is exactly why eyeballing the result never caught it.
//
// The defence is three layers, cheapest first:
//
//   1. expectedEditBytes — for a literal string replacement the size of the
//      result is not an estimate, it is arithmetic. If the buffer about to be
//      written is not exactly that many bytes, the read was short. Refuse.
//   2. a read-back after every write — the file that landed is hashed on the
//      far side and compared to what we meant to write. Structural, not
//      probabilistic.
//   3. expected_sha256 — an optional caller-supplied precondition, so an edit
//      built against a file someone else has since changed is refused instead
//      of silently clobbering their work.

/** The exact byte length a literal replacement must produce. Not a heuristic:
 *  original − (old × n) + (new × n), in BYTES, because a multi-byte character
 *  makes string length and file length different numbers. */
export function expectedEditBytes(originalBytes, oldString, newString, occurrences) {
  const n = Number(occurrences) || 0;
  return Number(originalBytes)
    - (Buffer.byteLength(String(oldString ?? ''), 'utf8') * n)
    + (Buffer.byteLength(String(newString ?? ''), 'utf8') * n);
}

/**
 * Null when the edited content is exactly the size it must be; a caller-facing
 * message when it isn't. `originalBytes` MUST come from the file on disk
 * (wc -c), never from the length of what was read — comparing a short read
 * against itself proves nothing.
 */
export function editByteInvariantError({ path, originalBytes, oldString, newString, replaced, content }) {
  const want = expectedEditBytes(originalBytes, oldString, newString, replaced);
  const got = Buffer.byteLength(String(content ?? ''), 'utf8');
  if (got === want) return null;
  const missing = want - got;
  return `Refusing to write ${path}: the edited content is ${got} bytes but a `
    + `${replaced}-occurrence replacement on a ${originalBytes}-byte file must produce exactly ${want} `
    + `(${missing > 0 ? `${missing} bytes short` : `${-missing} bytes over`}). `
    + 'That means the copy this edit was applied to was not the whole file, so nothing was written — '
    + 'the file on disk is untouched. Re-read the file and try again.';
}

/** Null when the file's current hash satisfies the caller's precondition; a
 *  message when it doesn't. An absent precondition is not an error — but an
 *  ill-formed one is, rather than being ignored. */
export function expectedSha256Error(path, declared, actualSha) {
  if (declared === undefined || declared === null || String(declared).trim() === '') return null;
  const want = validSha256(declared);
  if (!want) return 'expected_sha256 must be the 64-character hex SHA-256 of the file you read.';
  if (!actualSha || actualSha === NO_SHA) {
    return `Cannot check expected_sha256 for ${path}: the container has neither sha256sum nor openssl, `
      + 'so the precondition cannot be verified. Re-call without expected_sha256 to proceed unchecked.';
  }
  if (actualSha === want) return null;
  return `${path} has changed since you read it (expected ${want}, found ${actualSha}). `
    + 'Someone else — or another agent — edited it. Re-read the file and rebuild your edit on the current content.';
}

/** Null when the bytes we received are the whole file; a message when the
 *  container's own hash of the file disagrees with what arrived. This is the
 *  read-side twin of the read-back: it catches a truncated or mangled
 *  transfer BEFORE the content is used as the basis for a write. */
export function readIntegrityError(path, expectedBytes, containerSha, received) {
  const buf = Buffer.isBuffer(received) ? received : Buffer.from(String(received ?? ''), 'utf8');
  const want = Number(expectedBytes);
  if (buf.length < want) {
    return `Read of ${path} came back short: the file is ${want} bytes but ${buf.length} arrived. `
      + 'Nothing was written. This is a transport truncation, not a file change — retry the call.';
  }
  if (buf.length > want) {
    // Re-encoding grew the content, which means the decode replaced bytes it
    // could not read. Writing that back would rewrite every one of them.
    return `${path} is ${want} bytes on disk but ${buf.length} after decoding, so it is not valid UTF-8 text. `
      + 'These tools edit text files only — nothing was written.';
  }
  if (containerSha && containerSha !== NO_SHA && sha256Hex(buf) !== containerSha) {
    return `Read of ${path} does not match the file's own SHA-256 (${containerSha}). `
      + 'The transfer corrupted it; nothing was written. Retry the call.';
  }
  return null;
}

/** What the in-container sha helper prints when the container has no way to
 *  hash. Byte counts still apply; the hash checks degrade to skipped. */
export const NO_SHA = 'NOSHA';

/** POSIX-sh definition of pp_sha(), used by every script below. Kept in one
 *  place so "how do we hash in there" has a single answer. */
export const PP_SHA_FN =
  'pp_sha() { if command -v sha256sum >/dev/null 2>&1; then sha256sum < "$1" | cut -d" " -f1; '
  + 'elif command -v openssl >/dev/null 2>&1; then openssl dgst -sha256 < "$1" | sed "s/.*= *//"; '
  + `else echo ${NO_SHA}; fi; }; `;

/** Copy a file's mode and ownership onto its replacement.
 *
 *  A staged write replaces the inode, so without this an 0755 startup script
 *  comes back 0644 and a file owned by the app user comes back owned by root —
 *  both silent, both breaking. `--reference` is GNU; busybox containers fall
 *  back to `stat -c`, and a container with neither keeps the defaults rather
 *  than failing the write. */
export const PP_CLONE_META_FN =
  'pp_clone_meta() { src="$1"; dst="$2"; if [ ! -e "$src" ]; then return 0; fi; '
  + 'if ! chmod --reference="$src" -- "$dst" 2>/dev/null; then '
  +   'om=$(stat -c %a -- "$src" 2>/dev/null || echo ""); '
  +   'if [ -n "$om" ]; then chmod "$om" -- "$dst" 2>/dev/null || true; fi; fi; '
  + 'if ! chown --reference="$src" -- "$dst" 2>/dev/null; then '
  +   'ow=$(stat -c %u:%g -- "$src" 2>/dev/null || echo ""); '
  +   'if [ -n "$ow" ]; then chown "$ow" -- "$dst" 2>/dev/null || true; fi; fi; '
  + 'return 0; }; ';

/** Header the read scripts print before the content: byte count, line count
 *  (optional), then the file's SHA-256 — the hash is computed on the far side,
 *  which is what makes it a check on the transfer rather than a restatement
 *  of it. */
export const READ_HEADER_LINES_WITH_COUNT = 3;

/**
 * A write that cannot silently corrupt the target.
 *
 * Content goes to a sibling temp file, is verified there (bytes, then hash),
 * and only then replaces the target — so a failed verification leaves the
 * original exactly as it was and there is no rollback to get wrong. After the
 * rename the target itself is re-read and re-hashed, because "the temp file
 * was right" and "the file at this path is right" are different claims.
 *
 * Positional: $1 path, $2 expected bytes, $3 expected sha (or NOSHA to skip),
 * $4 chmod mode or empty, $5 "1" to keep a .old copy of what was replaced,
 * $6 expected CURRENT sha of the target (precondition) or empty to skip.
 *
 * Exit codes: 64 precondition failed, 65 staged content bad, 66 read-back bad.
 */
export function verifiedWriteScript() {
  return 'set -e; p="$1"; want_bytes="$2"; want_sha="$3"; m="$4"; keep_old="$5"; pre_sha="$6"; '
    + PP_SHA_FN + PP_CLONE_META_FN
    + 'if [ -n "$pre_sha" ]; then '
    +   'if [ -e "$p" ]; then cur=$(pp_sha "$p"); else cur=ABSENT; fi; '
    +   'if [ "$cur" != "$pre_sha" ]; then echo "PP_PRECONDITION $cur" >&2; exit 64; fi; '
    + 'fi; '
    + 'mkdir -p -- "$(dirname -- "$p")"; '
    + 'tmp="$p.pp-write.$$"; '
    + 'trap \'rm -f -- "$tmp"\' EXIT; '
    + 'cat > "$tmp"; '
    + 'got_bytes=$(wc -c < "$tmp" | tr -d " "); '
    + 'if [ "$got_bytes" != "$want_bytes" ]; then echo "PP_STAGE_BYTES $got_bytes" >&2; exit 65; fi; '
    + 'got_sha=$(pp_sha "$tmp"); '
    + `if [ "$got_sha" != ${NO_SHA} ] && [ "$got_sha" != "$want_sha" ]; then echo "PP_STAGE_SHA $got_sha" >&2; exit 65; fi; `
    // Keep the target's mode and owner: the temp file is a new inode, so
    // without this a 0755 script silently becomes a root-owned 0644 one.
    + 'pp_clone_meta "$p" "$tmp"; '
    + 'if [ -n "$m" ]; then chmod "$m" -- "$tmp"; fi; '
    + 'if [ "$keep_old" = "1" ] && [ -e "$p" ]; then rm -rf -- "$p.old"; cp -a -- "$p" "$p.old"; fi; '
    + 'mv -f -- "$tmp" "$p"; '
    + 'trap - EXIT; '
    + 'final_bytes=$(wc -c < "$p" | tr -d " "); final_sha=$(pp_sha "$p"); '
    + 'if [ "$final_bytes" != "$want_bytes" ]; then echo "PP_READBACK_BYTES $final_bytes" >&2; exit 66; fi; '
    + `if [ "$final_sha" != ${NO_SHA} ] && [ "$final_sha" != "$want_sha" ]; then echo "PP_READBACK_SHA $final_sha" >&2; exit 66; fi; `
    + 'nl=$(wc -l < "$p" | tr -d " "); '
    + 'echo "PP_OK $final_bytes $final_sha $nl"';
}

/**
 * Append to a file without moving it over the wire.
 *
 * The size invariant here is the same arithmetic as an edit, one term
 * shorter: after == before + appended. On mismatch the file is truncated back
 * to its original length, which is an exact undo for an append.
 *
 * Positional: $1 path, $2 appended byte count, $3 "1" to require the file to
 * already exist, $4 expected current sha (precondition) or empty.
 * Exit codes: 64 precondition failed, 66 size invariant violated, 67 absent.
 */
export function appendScript() {
  return 'set -e; p="$1"; add_bytes="$2"; must_exist="$3"; pre_sha="$4"; '
    + PP_SHA_FN + PP_CLONE_META_FN
    + 'if [ ! -e "$p" ]; then '
    +   'if [ "$must_exist" = "1" ]; then echo PP_ABSENT >&2; exit 67; fi; '
    +   'mkdir -p -- "$(dirname -- "$p")"; : > "$p"; '
    + 'fi; '
    + 'test -f "$p" || { echo PP_NOT_A_FILE >&2; exit 67; }; '
    + 'if [ -n "$pre_sha" ]; then cur=$(pp_sha "$p"); '
    +   'if [ "$cur" != "$pre_sha" ]; then echo "PP_PRECONDITION $cur" >&2; exit 64; fi; fi; '
    + 'before=$(wc -c < "$p" | tr -d " "); '
    + 'cat >> "$p"; '
    + 'after=$(wc -c < "$p" | tr -d " "); '
    + 'want=$((before + add_bytes)); '
    // Roll back to the pre-append length. truncate(1) where it exists; a
    // head -c rewrite where it does not, so the rollback is not best-effort.
    + 'if [ "$after" != "$want" ]; then '
    +   'if ! truncate -s "$before" -- "$p" 2>/dev/null; then '
    +     'back="$p.pp-rollback.$$"; { head -c "$before" -- "$p" > "$back" && pp_clone_meta "$p" "$back" && mv -f -- "$back" "$p"; } || true; '
    +     'rm -f -- "$back"; fi; '
    +   'echo "PP_APPEND_BYTES $after $want" >&2; exit 66; fi; '
    + 'final_sha=$(pp_sha "$p"); nl=$(wc -l < "$p" | tr -d " "); '
    + 'echo "PP_OK $after $final_sha $nl"';
}

/**
 * Insert text before a given 1-based line, again without shipping the file
 * anywhere. head/tail build the new file next to the old one; the size
 * invariant (before + inserted) is checked on the staged copy, so a bad
 * insert never reaches the target.
 *
 * Positional: $1 path, $2 line number, $3 inserted byte count,
 * $4 expected current sha (precondition) or empty.
 * Exit codes: 64 precondition failed, 65 size invariant violated,
 * 66 read-back bad, 67 not a file, 68 line past end of file.
 */
export function insertAtLineScript() {
  return 'set -e; p="$1"; ln="$2"; add_bytes="$3"; pre_sha="$4"; '
    + PP_SHA_FN + PP_CLONE_META_FN
    + 'test -f "$p" || { echo PP_NOT_A_FILE >&2; exit 67; }; '
    + 'if [ -n "$pre_sha" ]; then cur=$(pp_sha "$p"); '
    +   'if [ "$cur" != "$pre_sha" ]; then echo "PP_PRECONDITION $cur" >&2; exit 64; fi; fi; '
    + 'before=$(wc -c < "$p" | tr -d " "); total=$(wc -l < "$p" | tr -d " "); '
    + 'if [ "$ln" -gt "$((total + 1))" ]; then echo "PP_PAST_END $total" >&2; exit 68; fi; '
    + 'tmp="$p.pp-insert.$$"; stage="$p.pp-stage.$$"; '
    + 'trap \'rm -f -- "$tmp" "$stage"\' EXIT; '
    + 'cat > "$stage"; '
    + 'head -n "$((ln - 1))" -- "$p" > "$tmp"; '
    + 'cat -- "$stage" >> "$tmp"; '
    + 'tail -n "+$ln" -- "$p" >> "$tmp"; '
    + 'got=$(wc -c < "$tmp" | tr -d " "); want=$((before + add_bytes)); '
    + 'if [ "$got" != "$want" ]; then echo "PP_INSERT_BYTES $got $want" >&2; exit 65; fi; '
    + 'pp_clone_meta "$p" "$tmp"; '
    + 'mv -f -- "$tmp" "$p"; rm -f -- "$stage"; trap - EXIT; '
    + 'final=$(wc -c < "$p" | tr -d " "); '
    + 'if [ "$final" != "$want" ]; then echo "PP_READBACK_BYTES $final" >&2; exit 66; fi; '
    + 'final_sha=$(pp_sha "$p"); nl=$(wc -l < "$p" | tr -d " "); '
    + 'echo "PP_OK $final $final_sha $nl"';
}

/** Parse the `PP_OK <bytes> <sha> <newlines>` trailer every verified write
 *  prints. Returns null when the trailer isn't there — which is itself a
 *  failure, since the script only reaches it after every check passed. */
export function parseWriteOk(stdout) {
  const line = String(stdout ?? '').split('\n').map((l) => l.trim()).filter(Boolean).pop();
  if (!line || !line.startsWith('PP_OK ')) return null;
  const [, bytes, sha, newlines] = line.split(' ');
  const n = Number(bytes);
  if (!Number.isInteger(n)) return null;
  return {
    bytes: n,
    sha256: sha === NO_SHA ? null : sha,
    // wc -l counts newlines; an unterminated last line still counts as a line.
    total_lines: n === 0 ? 0 : Math.max(Number(newlines) || 0, 1),
  };
}

/** A 1-based line number for insert_project_file_at_line. Rejects 0, negatives
 *  and fractions rather than rounding them into a wrong-place insert. */
export function normalizeInsertLine(n) {
  const v = Number(n);
  if (!Number.isInteger(v) || v < 1) return null;
  return v;
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

// ---- apply_project_patch ----
//
// The round-trip problem, stated plainly: a five-file change through
// edit_project_file is ten to fifteen MCP calls, and every one of them is a
// full model turn. A unified diff is the format the model already produces —
// applying it in ONE call collapses that to one turn, and `git apply` is a
// far better judge of whether the edit still fits the file than a string
// match is.
//
// The write discipline does not relax for it. The patch itself is delivered
// over stdin, staged to a temp file, byte-counted and hashed before git is
// allowed near it; the checkout is refused if the touched paths are dirty;
// and a failed apply is rolled back to the exact bytes that were there
// before. See applyPatchScript.

/** Inline `patch` cap. Bigger diffs ride an upload ticket — the MCP body
 *  limit is 8 MB and a JSON string burns it fast on escaping. */
export const PATCH_INLINE_MAX_BYTES = 1024 * 1024;
/** Absolute cap on a patch from any source. */
export const PATCH_MAX_BYTES = 8 * 1024 * 1024;

/**
 * The paths a unified diff touches, read off its headers.
 *
 * Needed before anything runs: to check the expected_sha256 preconditions, to
 * scope the dirty-tree guard and the rollback, and to commit exactly the paths
 * the patch claimed. Reading them here rather than trusting git's output also
 * means a diff that tries to escape the app root (../, /etc/passwd, .git/)
 * is refused before it is ever handed to `git apply`.
 *
 * Both sides of a rename are returned, because both move.
 */
export function parseUnifiedDiffPaths(patch) {
  const text = String(patch ?? '');
  if (!text.trim()) return { error: 'patch is empty — there is nothing to apply.' };
  const files = [];
  let cur = null;
  const push = () => { if (cur) files.push(cur); cur = null; };
  // Strip a/ and b/ prefixes; /dev/null marks the absent side of an add or
  // a delete. Quoted paths ("a/with space.ts") are unquoted by git only when
  // the name needs it, so handle both.
  const strip = (p, prefix) => {
    let s = String(p ?? '').trim();
    if (s === '/dev/null') return null;
    if (s.startsWith('"') && s.endsWith('"') && s.length > 1) {
      try { s = JSON.parse(s); } catch { return undefined; }
    }
    // Diffs made with -pN other than 1 are not something we can guess at.
    if (prefix && (s.startsWith('a/') || s.startsWith('b/'))) s = s.slice(2);
    return s;
  };
  for (const raw of text.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      push();
      cur = { change: 'modified', from: null, to: null };
      // `diff --git a/x b/y` — split on " b/" is ambiguous for paths
      // containing that string, so the ---/+++ lines below are authoritative
      // and this only opens the record.
      continue;
    }
    if (!cur) {
      // A bare diff with no `diff --git` header (git diff --no-prefix, or a
      // hand-written patch) still starts a file at its --- line.
      if (raw.startsWith('--- ')) cur = { change: 'modified', from: null, to: null };
      else continue;
    }
    if (raw.startsWith('new file mode')) cur.change = 'added';
    else if (raw.startsWith('deleted file mode')) cur.change = 'deleted';
    else if (raw.startsWith('rename from ')) { cur.change = 'renamed'; cur.from = strip(raw.slice(12), false); }
    else if (raw.startsWith('rename to ')) { cur.change = 'renamed'; cur.to = strip(raw.slice(10), false); }
    else if (raw.startsWith('--- ') && cur.from === null) cur.from = strip(raw.slice(4).split('\t')[0], true);
    else if (raw.startsWith('+++ ') && cur.to === null) cur.to = strip(raw.slice(4).split('\t')[0], true);
  }
  push();
  if (!files.length) {
    return { error: 'No file headers found in the patch — it does not look like a unified diff (expected "diff --git a/… b/…" or "--- a/… / +++ b/…" lines).' };
  }

  const paths = [];
  const out = [];
  for (const f of files) {
    if (f.from === undefined || f.to === undefined) {
      return { error: 'A file header in the patch has an unreadable quoted path — re-generate the diff with `git diff` and send it verbatim.' };
    }
    if (f.from === null && f.to === null) {
      return { error: 'A file header in the patch names /dev/null on both sides — the diff is malformed.' };
    }
    if (f.change === 'modified') {
      if (f.from === null) f.change = 'added';
      else if (f.to === null) f.change = 'deleted';
      else if (f.from !== f.to) f.change = 'renamed';
    }
    for (const p of [f.from, f.to]) {
      if (p === null) continue;
      const rel = validProjectFilePath(p);
      if (!rel) {
        return { error: `The patch touches ${p}, which is not a path inside the app checkout. Patches may only change files under the app root (no absolute paths, no .., nothing under .git).` };
      }
      if (!paths.includes(rel)) paths.push(rel);
    }
    out.push({
      path: validProjectFilePath(f.to ?? f.from),
      ...(f.change === 'renamed' && f.from ? { from: validProjectFilePath(f.from) } : {}),
      change: f.change,
    });
  }
  return { files: out, paths };
}

/**
 * `git apply --numstat` output → per-file line counts.
 *
 * Format is `added<TAB>removed<TAB>path`, with `-` for both on a binary file.
 * A rename is reported with git's brace notation (`src/{old => new}.ts`), which
 * is for humans; the path we report comes from the diff headers instead, so
 * this only has to key off something stable. That is the LAST tab-field,
 * normalized through the same brace expansion git uses.
 */
export function parseApplyNumstat(stdout) {
  const rows = [];
  for (const raw of String(stdout ?? '').split('\n')) {
    if (!raw.trim()) continue;
    const parts = raw.split('\t');
    if (parts.length < 3) continue;
    const [added, removed] = parts;
    const pathField = parts.slice(2).join('\t').trim();
    const binary = added === '-' && removed === '-';
    rows.push({
      path: expandRenameBraces(pathField),
      lines_added: binary ? null : (Number(added) || 0),
      lines_removed: binary ? null : (Number(removed) || 0),
      binary,
    });
  }
  return rows;
}

/** `src/{a => b}.ts` → `src/b.ts`; `a => b` → `b`. git's own rename shorthand,
 *  resolved to the destination so the row can be matched to a file. */
export function expandRenameBraces(p) {
  const s = String(p ?? '').trim();
  const brace = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(s);
  if (brace) return `${brace[1]}${brace[3]}${brace[4]}`.replace(/\/\//g, '/');
  const plain = /^(.*) => (.*)$/.exec(s);
  if (plain) return plain[2].trim();
  return s;
}

/**
 * Turn `git apply`'s stderr into per-hunk rejection detail.
 *
 * "failed" on its own is useless to a model: it cannot tell whether the file
 * moved, the context drifted by two lines, or the file was never there. git
 * says all of that, one line at a time, and this keeps the structure.
 *
 * `conflicted` is the case that matters most and reads least like a failure:
 * with --3way git can APPLY a patch "with conflicts", leaving markers in the
 * file and (in --check mode) still exiting 0. Treated as a rejection here.
 */
export function parseGitApplyFailure(stderr) {
  const rejects = [];
  let conflicted = false;
  const conflictPaths = [];
  for (const raw of String(stderr ?? '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    let m;
    if ((m = /^Applied patch to '(.+)' with conflicts\.$/.exec(line))) {
      conflicted = true;
      conflictPaths.push(m[1]);
      rejects.push({
        path: m[1],
        reason: 'applied with conflicts — the file has changed since the diff was made, and a 3-way merge could not resolve it cleanly',
      });
    } else if ((m = /^error: patch failed: (.+):(\d+)$/.exec(line))) {
      rejects.push({ path: m[1], line: Number(m[2]), reason: 'hunk context does not match the file at this line' });
    } else if ((m = /^error: (.+): patch does not apply$/.exec(line))) {
      rejects.push({ path: m[1], reason: 'patch does not apply' });
    } else if ((m = /^error: (.+): No such file or directory$/.exec(line))) {
      rejects.push({ path: m[1], reason: 'file is not in the checkout' });
    } else if ((m = /^error: (.+): already exists in working directory$/.exec(line))) {
      rejects.push({ path: m[1], reason: 'the patch adds this file but it is already there' });
    } else if ((m = /^error: (.+): does not exist in index$/.exec(line))) {
      rejects.push({ path: m[1], reason: 'file is not tracked by git in this checkout' });
    } else if (/^error: corrupt patch at line (\d+)$/.test(line) || /^fatal: /.test(line)) {
      rejects.push({ reason: line.replace(/^(error|fatal): /, '') });
    }
  }
  return { rejects, conflicted, conflict_paths: conflictPaths };
}

/** Noise git prints on a SUCCESSFUL 3-way attempt when the pre-image blob is
 *  not in the repo. It is not an error and must not be shown as one. */
export function stripApplyNoise(stderr) {
  return String(stderr ?? '')
    .split('\n')
    .filter((l) => !/^error: repository lacks the necessary blob/.test(l.trim()))
    .filter((l) => l.trim() !== 'Falling back to direct application...')
    .join('\n')
    .trim();
}

/** Validate the expected_sha256 precondition map (path → sha). Mirrors the
 *  single-file guard on edit_project_file, one entry per file. */
export function normalizeExpectedShaMap(v) {
  if (v === undefined || v === null) return { map: null };
  if (typeof v !== 'object' || Array.isArray(v)) {
    return { error: 'expected_sha256 must be an object mapping each path to the SHA-256 you read for it, e.g. { "src/a.ts": "ab12…" }.' };
  }
  const map = new Map();
  for (const [k, val] of Object.entries(v)) {
    const rel = validProjectFilePath(k);
    if (!rel) return { error: `expected_sha256 key ${k} is not a path relative to the app root.` };
    const sha = validSha256(val);
    if (!sha) return { error: `expected_sha256["${k}"] must be the 64-character hex SHA-256 read_project_file returned for it.` };
    map.set(rel, sha);
  }
  return { map: map.size ? map : null };
}

/**
 * Null when every declared precondition holds; a caller-facing message when
 * one does not. `actual` maps path → sha, with null for a path that is absent
 * from the checkout.
 */
export function patchPreconditionError(map, actual) {
  if (!map) return null;
  for (const [path, want] of map) {
    const got = actual.get(path);
    if (got === undefined || got === null) {
      return `expected_sha256 names ${path}, but that file is not in the checkout. Nothing was applied — re-read the files and rebuild the patch.`;
    }
    if (got === NO_SHA) {
      return `The container cannot hash ${path}, so the expected_sha256 precondition cannot be verified. Nothing was applied.`;
    }
    if (got !== want) {
      return `${path} has changed since you read it (expected ${want}, found ${got}). Nothing was applied — someone else, or another agent, edited it. Re-read the file and rebuild your patch on the current content.`;
    }
  }
  return null;
}

/**
 * Apply a unified diff, atomically, inside the project container.
 *
 * The shape of the guarantee: the checkout is either exactly what it was
 * before the call, or exactly the patch applied — never half of one. Three
 * things make that true.
 *
 *   1. The patch is staged and verified like any other write. Byte count and
 *      SHA-256 are checked on the temp file before git reads it, so a
 *      truncated transfer is a refusal rather than a half-diff that happens
 *      to parse.
 *   2. The touched paths must be clean. `git apply` is atomic for the paths
 *      it owns, but --3way can leave conflict markers behind; scoping the
 *      rollback to paths with no uncommitted work means restoring them is
 *      exact (checkout from HEAD, or delete if HEAD never had them) and
 *      cannot destroy anyone's in-flight edit.
 *   3. Every failure path rolls back before it returns. Including the one
 *      that looks like success: `--check --3way` exits 0 on a patch it could
 *      only apply WITH CONFLICTS, so the caller has to read stderr, not just
 *      the exit code — hence the markers below.
 *
 * Positional: $1 expected patch bytes, $2 expected patch sha (or empty to
 * skip), $3 mode ("check" for a dry run, "apply"), $4 the expected_sha256
 * preconditions as "<sha> <path>" lines (or empty), then the touched paths.
 * The patch itself arrives on stdin.
 *
 * The preconditions are checked HERE rather than in the caller, because a
 * caller-side check on hashes the script reported can only ever run after the
 * apply — which would make expected_sha256 a report that a collision happened
 * rather than the guard that stops one.
 *
 * Exit codes: 64 dirty checkout, 65 patch transfer bad, 66 patch does not
 * apply (nothing touched), 67 apply failed and was rolled back,
 * 69 an expected_sha256 precondition failed.
 */
export function applyPatchScript() {
  return 'want_bytes="$1"; want_sha="$2"; mode="$3"; pre="$4"; shift 4; '
    + PP_SHA_FN
    + 'cd /srv/app || { echo PP_NO_CHECKOUT >&2; exit 68; }; '
    + 'd="/tmp/pp-patch.$$"; rm -rf -- "$d"; mkdir -p "$d" || { echo PP_NO_TMP >&2; exit 68; }; '
    + 'trap \'rm -rf -- "$d"\' EXIT INT TERM; '
    + 'tmp="$d/p.diff"; ef="$d/err"; '
    + 'cat > "$tmp"; '
    // 1. the patch is a write like any other: counted, then hashed.
    + 'got_bytes=$(wc -c < "$tmp" | tr -d " "); '
    + 'if [ "$got_bytes" != "$want_bytes" ]; then echo "PP_PATCH_BYTES $got_bytes" >&2; exit 65; fi; '
    + 'if [ -n "$want_sha" ]; then got_sha=$(pp_sha "$tmp"); '
    + `if [ "$got_sha" != ${NO_SHA} ] && [ "$got_sha" != "$want_sha" ]; then echo "PP_PATCH_SHA $got_sha" >&2; exit 65; fi; fi; `
    // 2. no uncommitted work on the paths we are about to own. This is what
    //    makes the rollback below exact rather than best-effort.
    + 'dirty=$(git status --porcelain -- "$@" 2>/dev/null); '
    + 'if [ -n "$dirty" ]; then echo PP_DIRTY >&2; echo "$dirty" >&2; exit 64; fi; '
    // 2b. the expected_sha256 preconditions, before anything is applied. Read
    //     from a file rather than a pipe so the loop runs in THIS shell and
    //     its exit is the script's exit.
    + 'if [ -n "$pre" ]; then printf "%s\\n" "$pre" > "$d/pre"; '
    +   'while IFS=" " read -r want_p_sha want_p_path; do '
    +     '[ -n "$want_p_path" ] || continue; '
    +     'if [ -f "$want_p_path" ]; then cur=$(pp_sha "$want_p_path"); else cur=ABSENT; fi; '
    +     'if [ "$cur" != "$want_p_sha" ]; then echo "PP_PRECONDITION $want_p_path $cur" >&2; exit 69; fi; '
    +   'done < "$d/pre"; fi; '
    // 3. the before-state: hash every touched path, so the preconditions are
    //    checked against what is actually on disk.
    + 'echo PP_BEFORE_BEGIN; '
    + 'for p in "$@"; do if [ -f "$p" ]; then echo "$(pp_sha "$p") $p"; else echo "ABSENT $p"; fi; done; '
    + 'echo PP_BEFORE_END; '
    // 4. numstat: what the patch claims it will do. Reads the diff only.
    + 'echo PP_NUMSTAT_BEGIN; git apply --numstat -- "$tmp" 2>/dev/null || true; echo PP_NUMSTAT_END; '
    // 5. --check: does it fit? stderr carries the per-hunk detail — and the
    //    "with conflicts" line, which exits 0 while meaning no.
    + 'if ! git apply --check --3way -- "$tmp" 2>"$ef"; then '
    +   'cat "$ef" >&2; echo PP_CHECK_FAILED >&2; exit 66; fi; '
    + 'cat "$ef" >&2; '
    + 'if grep -q "with conflicts" "$ef" 2>/dev/null; then echo PP_CHECK_FAILED >&2; exit 66; fi; '
    + 'if [ "$mode" = "check" ]; then echo PP_DRYRUN_OK; exit 0; fi; '
    // 6. the apply. On any failure, put the touched paths back exactly:
    //    they were clean, so HEAD is their previous content, and a path HEAD
    //    never had is one the patch created.
    + 'if ! git apply --3way --index -- "$tmp" 2>"$ef"; then '
    +   'cat "$ef" >&2; '
    +   'git reset -q -- "$@" 2>/dev/null || true; '
    +   'for p in "$@"; do if git cat-file -e "HEAD:$p" 2>/dev/null; then '
    +     'git checkout -f -q HEAD -- "$p" 2>/dev/null || true; '
    +   'else git rm -q --cached --ignore-unmatch -- "$p" 2>/dev/null || true; rm -f -- "$p"; fi; done; '
    +   'echo PP_APPLY_FAILED >&2; exit 67; fi; '
    + 'cat "$ef" >&2; '
    // 7. the after-state, read back off the files themselves rather than
    //    taken from git's account of them.
    + 'echo PP_AFTER_BEGIN; '
    + 'for p in "$@"; do if [ -f "$p" ]; then '
    +   'echo "$(pp_sha "$p") $(wc -c < "$p" | tr -d " ") $(wc -l < "$p" | tr -d " ") $p"; '
    +   'else echo "ABSENT 0 0 $p"; fi; done; '
    + 'echo PP_AFTER_END; '
    + 'echo PP_OK';
}

/** Pull one `BEGIN…END` block out of the patch script's stdout. */
export function patchScriptBlock(stdout, name) {
  const text = String(stdout ?? '');
  const begin = `PP_${name}_BEGIN`;
  const end = `PP_${name}_END`;
  const i = text.indexOf(begin);
  if (i === -1) return [];
  const j = text.indexOf(end, i);
  return text.slice(i + begin.length, j === -1 ? undefined : j).split('\n').filter((l) => l.trim() !== '');
}

/** `<sha|ABSENT> <path>` → Map(path → sha | null). */
export function parseBeforeBlock(lines) {
  const map = new Map();
  for (const line of lines) {
    const sp = line.indexOf(' ');
    if (sp === -1) continue;
    const sha = line.slice(0, sp);
    map.set(line.slice(sp + 1), sha === 'ABSENT' ? null : sha);
  }
  return map;
}

/** `<sha|ABSENT> <bytes> <newlines> <path>` → Map(path → {sha256,bytes,lines}). */
export function parseAfterBlock(lines) {
  const map = new Map();
  for (const line of lines) {
    const m = /^(\S+) (\d+) (\d+) ([\s\S]*)$/.exec(line);
    if (!m) continue;
    const bytes = Number(m[2]);
    map.set(m[4], m[1] === 'ABSENT' ? null : {
      sha256: m[1] === NO_SHA ? null : m[1],
      size_bytes: bytes,
      // wc -l counts newlines; an unterminated last line is still a line.
      total_lines: bytes === 0 ? 0 : Math.max(Number(m[3]) || 0, 1),
    });
  }
  return map;
}

/**
 * Merge what the diff SAID it would do (parsed headers), what git said it
 * would do (numstat) and what is actually on disk now (the after-block) into
 * one row per file.
 *
 * The change type comes from the headers and is corrected against reality: a
 * patch header claiming "modified" for a path that is now absent is reported
 * as a delete, because the file is the fact and the header is the claim.
 */
export function buildPatchFileReport(files, numstat, after) {
  const stats = new Map(numstat.map((r) => [r.path, r]));
  return files.map((f) => {
    const st = stats.get(f.path) || null;
    const now = after ? after.get(f.path) : undefined;
    let change = f.change;
    if (after) {
      if (now === null || now === undefined) change = 'deleted';
      else if (change === 'deleted') change = 'modified';
    }
    return {
      path: f.path,
      ...(f.from ? { from: f.from } : {}),
      change,
      lines_added: st ? st.lines_added : null,
      lines_removed: st ? st.lines_removed : null,
      ...(st && st.binary ? { binary: true } : {}),
      ...(now ? { size_bytes: now.size_bytes, total_lines: now.total_lines, sha256: now.sha256 } : {}),
      ...(after && !now ? { sha256: null } : {}),
    };
  });
}

// ---- read_project_files: the batch read ----
//
// One file per call is one model turn per file. Orientation is where agents
// spend their wall-clock, and it is almost never one file — it is the route,
// the handler, the schema and the test. This reads them together.
//
// What it does NOT do is return part of a file. read_project_file errors
// rather than handing back a short read, because a short read that looks
// normal is how five files got truncated in the field. A batch has a second
// way to lie — quietly dropping files off the end of a budget — so anything
// that does not fit comes back in `dropped`, named, with the reason.

export const BATCH_READ_MAX_FILES = 50;
export const BATCH_READ_BUDGET_DEFAULT = 512 * 1024;
export const BATCH_READ_BUDGET_CAP = 1024 * 1024;

export function normalizeBatchReadBudget(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 1) return BATCH_READ_BUDGET_DEFAULT;
  return Math.min(Math.floor(v), BATCH_READ_BUDGET_CAP);
}

/** Validate the `files` array into container-ready triples. Every entry is
 *  checked before ANY of them is read, so a typo in the last path does not
 *  cost a round trip that half-worked. */
export function normalizeBatchReadRequest(files) {
  if (!Array.isArray(files) || files.length === 0) {
    return { error: 'files must be a non-empty array of { path, offset?, limit? } objects.' };
  }
  if (files.length > BATCH_READ_MAX_FILES) {
    return { error: `files is capped at ${BATCH_READ_MAX_FILES} entries per call (got ${files.length}) — split the batch.` };
  }
  const items = [];
  for (const entry of files) {
    const spec = typeof entry === 'string' ? { path: entry } : entry;
    if (!spec || typeof spec !== 'object') {
      return { error: 'each entry of files must be an object like { "path": "src/a.ts" } (offset and limit optional).' };
    }
    const rel = validProjectFilePath(spec.path);
    if (!rel) {
      return { error: `${spec.path == null ? '(missing path)' : spec.path} is not a file path relative to the app root, e.g. src/server/routes.ts` };
    }
    const range = normalizeReadRange(spec.offset, spec.limit);
    items.push({
      path: rel,
      range,
      start: range.ranged ? String(range.start) : 'all',
      end: range.ranged ? (range.end === null ? '$' : String(range.end)) : '0',
    });
  }
  return { items };
}

/**
 * Read many files in one container round trip.
 *
 * Each file is framed by a nonce marker so content — which is arbitrary text,
 * including text that looks like a marker — cannot be confused with the
 * protocol. Size, line count and SHA-256 are computed on the far side before
 * the content is emitted, which is what lets the caller check that what
 * arrived IS the file rather than a prefix of it.
 *
 * A file is emitted whole or not at all: over the per-file cap, or too big for
 * what is left of the response budget, and it is announced with its size and
 * skipped. There is deliberately no partial-content path.
 *
 * Positional: $1 nonce, $2 per-file cap, $3 total budget, then (path, start,
 * end) triples — start is "all" for a whole-file read.
 */
export function batchReadScript() {
  return 'n="$1"; cap="$2"; budget="$3"; shift 3; '
    + PP_SHA_FN
    + 'cd /srv/app || { echo PP_NO_CHECKOUT >&2; exit 68; }; '
    + 'd="/tmp/pp-read.$$"; rm -rf -- "$d"; mkdir -p "$d" || exit 68; '
    + 'trap \'rm -rf -- "$d"\' EXIT INT TERM; '
    + 'used=0; '
    + 'while [ $# -gt 2 ]; do '
    +   'p="$1"; s="$2"; e="$3"; shift 3; '
    +   'if [ ! -f "$p" ]; then printf "PP_%s_H missing 0 0 - 0 %s\\n" "$n" "$p"; continue; fi; '
    +   'size=$(wc -c < "$p" | tr -d " "); nl=$(wc -l < "$p" | tr -d " "); sha=$(pp_sha "$p"); '
    +   'if [ "$s" = "all" ]; then src="$p"; want="$size"; '
    +   'else sed -n "$s,${e}p" "$p" > "$d/w"; src="$d/w"; want=$(wc -c < "$d/w" | tr -d " "); fi; '
    +   'if [ "$want" -gt "$cap" ]; then printf "PP_%s_H toobig %s %s %s %s %s\\n" "$n" "$size" "$nl" "$sha" "$want" "$p"; continue; fi; '
    +   'if [ $((used + want)) -gt "$budget" ]; then printf "PP_%s_H budget %s %s %s %s %s\\n" "$n" "$size" "$nl" "$sha" "$want" "$p"; continue; fi; '
    +   'used=$((used + want)); '
    +   'printf "PP_%s_H ok %s %s %s %s %s\\n" "$n" "$size" "$nl" "$sha" "$want" "$p"; '
    +   'cat "$src"; printf "\\nPP_%s_E\\n" "$n"; '
    + 'done; '
    + 'printf "PP_%s_DONE %s\\n" "$n" "$used"';
}

/**
 * Parse the framed batch-read stream.
 *
 * Header: `PP_<nonce>_H <status> <size> <lines> <sha> <bytes> <path>` — path
 * last, because a path may contain spaces and nothing else may. Content runs
 * from the end of that line to the `\nPP_<nonce>_E\n` terminator, and the
 * newline the terminator carries is the one the script added, so the content
 * is byte-exact whether or not the file ended with one.
 *
 * `complete: false` means the stream stopped mid-flight (a capture cap, a
 * killed exec) — the caller must treat every file it did not see as dropped
 * rather than as absent.
 */
export function parseBatchReadOutput(stdout, nonce) {
  const text = String(stdout ?? '');
  const H = `PP_${nonce}_H `;
  const E = `\nPP_${nonce}_E\n`;
  const files = [];
  let i = text.indexOf(H);
  while (i !== -1) {
    const eol = text.indexOf('\n', i);
    if (eol === -1) break;
    const m = /^(\S+) (\d+) (\d+) (\S+) (\d+) ([\s\S]*)$/.exec(text.slice(i + H.length, eol));
    if (!m) { i = text.indexOf(H, eol); continue; }
    const rec = {
      status: m[1],
      size_bytes: Number(m[2]),
      total_lines: Number(m[3]) === 0 && Number(m[2]) > 0 ? 1 : Number(m[3]),
      sha256: m[4] === '-' || m[4] === NO_SHA ? null : m[4],
      returned_bytes: Number(m[5]),
      path: m[6],
    };
    if (rec.status !== 'ok') {
      files.push(rec);
      i = text.indexOf(H, eol);
      continue;
    }
    const end = text.indexOf(E, eol);
    if (end === -1) { rec.status = 'incomplete'; files.push(rec); break; }
    rec.content = text.slice(eol + 1, end);
    files.push(rec);
    i = text.indexOf(H, end + E.length);
  }
  const done = new RegExp(`PP_${nonce}_DONE (\\d+)`).exec(text);
  return { files, complete: Boolean(done), used_bytes: done ? Number(done[1]) : null };
}

// ---- search_project_files: context lines ----
//
// The search → read → read → read chain is the single most common shape in an
// agent transcript, and every link in it is a full model turn. `git grep -C`
// answers the follow-up questions in the same call the search was made in.

export const SEARCH_CONTEXT_MAX = 20;
export const SEARCH_BYTE_BUDGET_DEFAULT = 128 * 1024;
export const SEARCH_BYTE_BUDGET_CAP = 512 * 1024;

export function normalizeContextLines(n) {
  if (n === undefined || n === null || n === '') return 0;
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return 0;
  return Math.min(Math.floor(v), SEARCH_CONTEXT_MAX);
}

export function normalizeSearchByteBudget(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 1) return SEARCH_BYTE_BUDGET_DEFAULT;
  return Math.min(Math.floor(v), SEARCH_BYTE_BUDGET_CAP);
}

/**
 * Parse `git grep -n -C k` into contiguous blocks.
 *
 * git marks a matching line `path:line:text` and a context line
 * `path-line-text`, and separates non-adjacent runs with a bare `--`. That is
 * enough to rebuild each run as a block: a path, the line number it starts
 * at, its lines in order, and which of those lines actually matched.
 *
 * Two budgets, both explicit in the result: `max_results` counts MATCHES (not
 * context lines, which are free riders on someone else's hit), and
 * `maxBytes` stops a wide -C from turning a 40-hit search into a megabyte.
 */
export function parseGitGrepContext(stdout, { maxResults = SEARCH_MAX_RESULTS_DEFAULT, maxBytes = SEARCH_BYTE_BUDGET_DEFAULT } = {}) {
  const blocks = [];
  let cur = null;
  let matchCount = 0;
  let bytes = 0;
  let truncated = false;
  const close = () => { if (cur && cur.lines.length) blocks.push(cur); cur = null; };

  for (const raw of String(stdout ?? '').split('\n')) {
    if (raw === '') continue;
    if (raw === '--') { close(); continue; }
    // path:line:text (a hit) or path-line-text (context). The path is greedy-
    // free so a path containing a separator resolves at the FIRST one that is
    // followed by digits and another separator, which is the line number.
    const m = /^(.*?)([:-])(\d+)\2([\s\S]*)$/.exec(raw);
    if (!m) continue;
    const [, path, sep, lineNo, text] = m;
    const isMatch = sep === ':';
    const n = Number(lineNo);
    if (isMatch && matchCount >= maxResults) { truncated = true; close(); break; }
    const capped = text.slice(0, SEARCH_LINE_CAP);
    bytes += capped.length + 1;
    if (bytes > maxBytes) { truncated = true; close(); break; }
    if (!cur || cur.path !== path || n !== cur.start_line + cur.lines.length) { close(); cur = { path, start_line: n, lines: [], match_lines: [] }; }
    cur.lines.push(capped);
    if (isMatch) { cur.match_lines.push(n); matchCount += 1; }
  }
  close();
  return { blocks, match_count: matchCount, bytes, truncated };
}

/** `git grep -l` prints one path per line — nothing to parse, everything to
 *  cap. */
export function parseGitGrepFileList(stdout, maxResults = SEARCH_MAX_RESULTS_DEFAULT) {
  const all = String(stdout ?? '').split('\n').filter((l) => l !== '');
  return { files: all.slice(0, maxResults), truncated: all.length > maxResults, total: all.length };
}

// ---- project_map: one-call orientation ----
//
// Approximate BY DESIGN. This is a map for deciding what to open next, not an
// index: the symbols come out of a regex, so a name inside a template literal
// can show up and a clever re-export can go missing. That trade is worth one
// call instead of twenty.

export const PROJECT_MAP_MAX_FILES_DEFAULT = 400;
export const PROJECT_MAP_MAX_FILES_CAP = 2000;
export const PROJECT_MAP_SYMBOLS_PER_FILE = 40;

/** The ERE handed to `git grep`. Deliberately generous — a line that reaches
 *  Node and yields no name is dropped there, which is cheaper than trying to
 *  be precise in a single POSIX regex across five languages. */
export const PROJECT_MAP_SYMBOL_PATTERN =
  '^(export[ \t{*]|exports\\.[A-Za-z_$]|module\\.exports|declare[ \t]|(async[ \t]+)?function[ \t*]'
  + '|class[ \t]|const[ \t]|let[ \t]|var[ \t]|type[ \t]|interface[ \t]|enum[ \t]|def[ \t]|func[ \t]'
  + '|struct[ \t]|impl[ \t]|CREATE[ \t]+(TABLE|INDEX|VIEW)[ \t])'
  + '|^[ \t]*(app|router|api|server|r)\\.(get|post|put|patch|delete|use|all|options|head)[ \t]*\\(';

const SYMBOL_RULES = [
  [/^export\s+default\s+(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)?/, 'function', true],
  [/^export\s+default\s+class\s+([A-Za-z_$][\w$]*)?/, 'class', true],
  [/^export\s+default\b/, 'default', true],
  [/^export\s+(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, 'function', true],
  [/^export\s+class\s+([A-Za-z_$][\w$]*)/, 'class', true],
  [/^export\s+(?:abstract\s+)?interface\s+([A-Za-z_$][\w$]*)/, 'interface', true],
  [/^export\s+type\s+([A-Za-z_$][\w$]*)/, 'type', true],
  [/^export\s+enum\s+([A-Za-z_$][\w$]*)/, 'enum', true],
  [/^export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/, 'const', true],
  [/^export\s*\{\s*([^}]*)\}/, 're-export', true],
  [/^export\s*\*/, 're-export', true],
  [/^exports\.([A-Za-z_$][\w$]*)/, 'const', true],
  [/^module\.exports\b/, 'module.exports', true],
  [/^(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, 'function', false],
  [/^class\s+([A-Za-z_$][\w$]*)/, 'class', false],
  [/^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/, 'const', false],
  [/^(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/, 'type', false],
  [/^def\s+([A-Za-z_][\w]*)/, 'function', false],
  [/^func\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)/, 'function', false],
  [/^(?:struct|impl)\s+([A-Za-z_][\w]*)/, 'type', false],
  [/^CREATE\s+(?:TABLE|INDEX|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"]?([A-Za-z_][\w]*)/i, 'table', false],
];

const ROUTE_RE = /^\s*(?:app|router|api|server|r)\.(get|post|put|patch|delete|use|all|options|head)\s*\(\s*['"`]([^'"`]*)['"`]/;

/** One grepped line → { kind, name } or null. Regex-based and honest about
 *  it: a line that does not resolve to a name is dropped rather than guessed
 *  at. */
export function extractSymbol(text) {
  const line = String(text ?? '').replace(/\s+$/, '');
  if (!line) return null;
  const route = ROUTE_RE.exec(line);
  if (route) return { kind: 'route', name: `${route[1].toUpperCase()} ${route[2]}` };
  const trimmed = line.replace(/^\s+/, '');
  for (const [re, kind, exported] of SYMBOL_RULES) {
    const m = re.exec(trimmed);
    if (!m) continue;
    let name = (m[1] || '').trim();
    if (kind === 're-export') name = name ? name.split(',').map((s) => s.trim()).filter(Boolean).join(', ') : '*';
    if (!name && kind !== 'default' && kind !== 'module.exports') return { kind, name: '(anonymous)', exported };
    return { kind, name: name || kind, ...(exported ? { exported: true } : {}) };
  }
  return null;
}

/**
 * Join the three cheap container answers — the tracked file list, per-file
 * line counts, and one grep for symbol-shaped lines — into a map.
 *
 * Everything that is cut is named: `truncated` for the file list,
 * `symbols_truncated` for the per-file symbol cap. A map that quietly stops
 * at 400 files reads as "that is the whole repo", which is worse than no map.
 */
export function buildProjectMap({
  files = [], counts = new Map(), symbolHits = [],
  maxFiles = PROJECT_MAP_MAX_FILES_DEFAULT,
  maxSymbolsPerFile = PROJECT_MAP_SYMBOLS_PER_FILE,
} = {}) {
  const byPath = new Map();
  for (const hit of symbolHits) {
    const sym = extractSymbol(hit.line);
    if (!sym) continue;
    const list = byPath.get(hit.path) || [];
    list.push({ line: hit.line_number, ...sym });
    byPath.set(hit.path, list);
  }
  const shown = files.slice(0, maxFiles);
  const symbolsTruncated = [];
  const rows = shown.map((path) => {
    const all = byPath.get(path) || [];
    if (all.length > maxSymbolsPerFile) symbolsTruncated.push({ path, shown: maxSymbolsPerFile, total: all.length });
    const lines = counts.has(path) ? counts.get(path) : null;
    return {
      path,
      lines,
      ...(lines === null ? { note: 'binary or unreadable — not counted' } : {}),
      symbols: all.slice(0, maxSymbolsPerFile),
    };
  });
  return {
    file_count: files.length,
    files: rows,
    truncated: files.length > shown.length,
    ...(files.length > shown.length
      ? { omitted: files.length - shown.length, omitted_note: `${files.length - shown.length} tracked files are not in this map — narrow it with subdir, or raise max_files.` }
      : {}),
    ...(symbolsTruncated.length ? { symbols_truncated: symbolsTruncated } : {}),
  };
}

/** `git grep -c -e ''` prints `path:<line count>` for every tracked TEXT file
 *  — one command, no `wc` total row to disambiguate, binaries skipped. */
export function parseLineCounts(stdout) {
  const counts = new Map();
  for (const raw of String(stdout ?? '').split('\n')) {
    if (!raw) continue;
    const i = raw.lastIndexOf(':');
    if (i === -1) continue;
    const n = Number(raw.slice(i + 1));
    if (!Number.isFinite(n)) continue;
    counts.set(raw.slice(0, i), n);
  }
  return counts;
}

// ---- project archive / pin / host usage (set_project_lifecycle & co.) ----
//
// Pure decision + parsing layer for the reclaim tools. Everything that touches
// Incus or the DB lives in lib/project-lifecycle.js (injected deps) and
// routes/mcp.js; this section is what the unit tests exercise.

export const LIFECYCLE_FILTERS = Object.freeze(['active', 'stopped', 'archived', 'all']);

/** list_projects filter arguments → { lifecycle, pinned } or { error }. */
export function normalizeProjectFilters(args = {}) {
  let lifecycle = 'all';
  if (args.lifecycle != null) {
    lifecycle = String(args.lifecycle).trim().toLowerCase();
    if (!LIFECYCLE_FILTERS.includes(lifecycle)) {
      return { error: `lifecycle must be one of ${LIFECYCLE_FILTERS.join(', ')}` };
    }
  }
  let pinned = null;
  if (args.pinned != null) {
    if (typeof args.pinned !== 'boolean') return { error: 'pinned must be a boolean' };
    pinned = args.pinned;
  }
  return { lifecycle, pinned };
}

/**
 * Apply list_projects filters to summary rows (each row carries `lifecycle`
 * and `pinned`). No filter = every row, unchanged.
 */
export function filterProjectSummaries(rows, { lifecycle = 'all', pinned = null } = {}) {
  return (Array.isArray(rows) ? rows : []).filter((r) => {
    if (lifecycle !== 'all' && r.lifecycle !== lifecycle) return false;
    if (pinned !== null && !!r.pinned !== pinned) return false;
    return true;
  });
}

// Container status as the tools report it — three words, never a raw Incus
// state string, so an agent can branch on it.
export function containerStatusWord(status) {
  if (status === null || status === undefined) return 'none';
  const s = String(status).toLowerCase();
  if (s === 'running') return 'running';
  if (s === 'stopped' || s === 'frozen') return 'stopped';
  if (s === 'none' || s === '') return 'none';
  return s;
}

// Cycle statuses that mean a build is live (mirrors LIVE_CYCLE_STATUSES in
// routes/mcp.js — a queued row counts too, the prompt is "running or queued").
export const LIVE_BUILD_STATUSES = Object.freeze(['queued', 'estimating', 'running']);

/**
 * Why a set_project_lifecycle call must be refused, or null when it may
 * proceed. `policy` is lib/mcp-policy/project-lifecycle-allowlist.json (the
 * transition table is read from it, not hard-coded here).
 *
 *   project      — the DB row ({ id, name, lifecycle })
 *   action       — 'archive' | 'unarchive'
 *   pinned       — project-wide pin flag
 *   latestCycle  — the project's latest build cycle row (or null)
 *   queuedBuilds — count of queued build-queue rows
 *   containerStatus — 'running' | 'stopped' | 'none' | null (null = unknown)
 */
export function lifecycleRefusal({ project, action, pinned = false, latestCycle = null, queuedBuilds = 0, containerStatus = null }, policy) {
  if (!project) return 'Project not found';
  const rule = policy?.tools?.set_project_lifecycle?.actions?.[action];
  if (!rule) return "action must be 'archive' or 'unarchive'";
  const name = project.name || `#${project.id}`;
  if (!rule.from.includes(project.lifecycle)) {
    if (action === 'archive' && project.lifecycle === 'archived') return `${name} is already archived`;
    if (action === 'unarchive' && project.lifecycle !== 'archived') return `${name} is ${project.lifecycle}, not archived — nothing to unarchive`;
    return `Cannot ${action} ${name} while it is ${project.lifecycle} (allowed from: ${rule.from.join(', ')})`;
  }
  const refuse = rule.refuse_when || [];
  if (refuse.includes('pinned') && pinned) {
    return `${name} (project ${project.id}) is pinned — unpin it in the UI (or with set_project_pinned) first. Pinned projects are never archived silently.`;
  }
  if (refuse.includes('build_live')) {
    if (latestCycle && LIVE_BUILD_STATUSES.includes(latestCycle.status)) {
      return `A build is ${latestCycle.status} on ${name} — stop it first with interrupt_project_build (cycle ${latestCycle.id}).`;
    }
    if (Number(queuedBuilds) > 0) {
      return `${queuedBuilds} build(s) are queued on ${name} — cancel them first with cancel_queued_build.`;
    }
  }
  if (refuse.includes('container_missing') && containerStatus === 'none') {
    return `${name} has no container on this host — it was archived from the UI (which destroys the guest), so rehydrate it from the UI instead.`;
  }
  return null;
}

/** The JSON stored in mock2_projects.archive_state_json, or null. */
export function parseArchiveState(json) {
  if (json == null || json === '') return null;
  try {
    const v = JSON.parse(String(json));
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

// ---- host usage parsing ----

const MB = 1024 * 1024;
const GB = 1024 * 1024 * 1024;
const round1 = (n) => Math.round(n * 10) / 10;
const round2 = (n) => Math.round(n * 100) / 100;

/** `/proc/loadavg` → { load_1m, load_5m, load_15m } (null fields when unreadable). */
export function parseProcLoadavg(text) {
  const parts = String(text ?? '').trim().split(/\s+/).filter(Boolean);
  const num = (i) => (parts[i] !== undefined && Number.isFinite(Number(parts[i])) ? Number(parts[i]) : null);
  return { load_1m: num(0), load_5m: num(1), load_15m: num(2) };
}

/** `/proc/meminfo` → { memory: {...mb}, swap: {...mb} }. Values in kB in the file. */
export function parseProcMeminfo(text) {
  const kb = {};
  for (const line of String(text ?? '').split('\n')) {
    const m = /^([A-Za-z_()]+):\s+(\d+)/.exec(line);
    if (m) kb[m[1]] = Number(m[2]);
  }
  const toMb = (k) => (Number.isFinite(kb[k]) ? Math.round(kb[k] / 1024) : null);
  const total = toMb('MemTotal');
  // MemAvailable is the kernel's own "how much can be claimed without
  // swapping" — the number that matters; "used" is total minus it.
  const available = toMb('MemAvailable') ?? (toMb('MemFree') != null ? toMb('MemFree') + (toMb('Buffers') || 0) + (toMb('Cached') || 0) : null);
  const used = total != null && available != null ? total - available : null;
  const swapTotal = toMb('SwapTotal');
  const swapFree = toMb('SwapFree');
  return {
    memory: {
      total_mb: total,
      used_mb: used,
      available_mb: available,
      percent_used: total ? round1((used / total) * 100) : null,
    },
    swap: {
      total_mb: swapTotal,
      used_mb: swapTotal != null && swapFree != null ? swapTotal - swapFree : null,
    },
  };
}

/**
 * `df -kP <path>` output → { mount, filesystem, total_gb, used_gb,
 * available_gb, percent_used } or null. POSIX format keeps every entry on one
 * line: filesystem 1024-blocks used available capacity mounted-on.
 */
export function parseDfOutput(text) {
  const lines = String(text ?? '').trim().split('\n').filter(Boolean);
  const data = lines.find((l, i) => i > 0 || !/^Filesystem/i.test(l));
  if (!data) return null;
  const parts = data.trim().split(/\s+/);
  if (parts.length < 6) return null;
  const [filesystem, total, used, avail, cap, ...mount] = parts;
  const k = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  if (k(total) === null) return null;
  return {
    mount: mount.join(' '),
    filesystem,
    total_gb: round2((k(total) * 1024) / GB),
    used_gb: round2((k(used) * 1024) / GB),
    available_gb: round2((k(avail) * 1024) / GB),
    percent_used: Number.isFinite(parseFloat(cap)) ? parseFloat(cap) : null,
  };
}

/**
 * Pick the Incus storage pool the host actually uses from `incus storage list
 * --format json`: the default profile's root pool when known, else `default`,
 * else the only/first pool. Returns { name, driver, source } or null.
 */
export function pickStoragePool(list, defaultProfileRootPool = null) {
  const pools = (Array.isArray(list) ? list : []).filter((p) => p && p.name);
  if (pools.length === 0) return null;
  const pick = (defaultProfileRootPool && pools.find((p) => p.name === defaultProfileRootPool))
    || pools.find((p) => p.name === 'default')
    || pools[0];
  return { name: pick.name, driver: pick.driver || null, source: pick.config?.source || null };
}

/** `incus profile show default` (YAML) → the root disk device's pool name, or null. */
export function parseProfileRootPool(yaml) {
  const lines = String(yaml ?? '').split('\n');
  let inRoot = false;
  for (const line of lines) {
    if (/^\s{2}root:\s*$/.test(line)) { inRoot = true; continue; }
    if (inRoot) {
      if (/^\s{2}\S/.test(line)) inRoot = false;
      const m = /^\s{4}pool:\s*(\S+)/.exec(line);
      if (m) return m[1];
    }
  }
  return null;
}

/** `incus query /1.0/storage-pools/<pool>/resources` JSON → { total_gb, used_gb } or null. */
export function parsePoolResources(json) {
  let v = json;
  if (typeof json === 'string') {
    try { v = JSON.parse(json); } catch { return null; }
  }
  const space = v?.space;
  if (!space || !Number.isFinite(Number(space.total))) return null;
  return {
    total_gb: round2(Number(space.total) / GB),
    used_gb: Number.isFinite(Number(space.used)) ? round2(Number(space.used) / GB) : null,
  };
}

/** `incus storage info <pool> --bytes` text → { total_gb, used_gb } or null. */
export function parseStorageInfoText(text) {
  const grab = (label) => {
    const m = new RegExp(`^\\s*${label}:\\s*([0-9.]+)\\s*([KMGT]i?B)?`, 'mi').exec(String(text ?? ''));
    if (!m) return null;
    const n = Number(m[1]);
    if (!Number.isFinite(n)) return null;
    const unit = (m[2] || '').toUpperCase();
    const mult = unit.startsWith('K') ? 1024 : unit.startsWith('M') ? MB : unit.startsWith('G') ? GB : unit.startsWith('T') ? GB * 1024 : 1;
    return n * mult;
  };
  const total = grab('total space');
  if (total === null) return null;
  const used = grab('space used');
  return { total_gb: round2(total / GB), used_gb: used === null ? null : round2(used / GB) };
}

/** One `incus list --format json` instance → its usage row. */
export function containerUsageRow(instance) {
  const state = instance?.state || {};
  const mem = Number(state.memory?.usage);
  const cpuNs = Number(state.cpu?.usage);
  const disk = Number(state.disk?.root?.usage);
  return {
    name: String(instance?.name || ''),
    status: containerStatusWord(instance?.status),
    memory_mb: Number.isFinite(mem) ? round1(mem / MB) : 0,
    cpu_seconds: Number.isFinite(cpuNs) ? Math.round(cpuNs / 1e9) : 0,
    disk_gb: Number.isFinite(disk) ? round2(disk / GB) : null,
  };
}

/** Container counts + the top running guests by memory from `incus list` JSON. */
export function summarizeContainers(list, { top = 10 } = {}) {
  const seen = new Set();
  const rows = [];
  for (const c of Array.isArray(list) ? list : []) {
    const name = String(c?.name || '');
    if (!name || seen.has(name)) continue;   // --all-projects can repeat a name
    seen.add(name);
    rows.push(containerUsageRow(c));
  }
  const running = rows.filter((r) => r.status === 'running');
  return {
    running: running.length,
    stopped: rows.filter((r) => r.status === 'stopped').length,
    total: rows.length,
    top_by_memory: running
      .slice()
      .sort((a, b) => b.memory_mb - a.memory_mb)
      .slice(0, top)
      .map(({ name, memory_mb, cpu_seconds, disk_gb }) => ({ name, memory_mb, cpu_seconds, disk_gb })),
    _rows: rows,
  };
}

/**
 * Assemble the get_host_usage payload from already-parsed pieces. Pure so the
 * shape is testable; the host reads happen in routes/mcp.js.
 */
export function buildHostUsage({ takenAt, cores, loadavg, meminfo, disks, pool, containers, perProject = null }) {
  const { _rows, ...counts } = containers || summarizeContainers([]);
  return {
    taken_at: takenAt,
    cpu: { cores: Number.isFinite(Number(cores)) ? Number(cores) : null, ...(loadavg || parseProcLoadavg('')) },
    memory: (meminfo || parseProcMeminfo('')).memory,
    swap: (meminfo || parseProcMeminfo('')).swap,
    disk: (disks || []).filter(Boolean),
    incus_pool: pool || null,
    containers: counts,
    ...(perProject ? { per_project: perProject } : {}),
  };
}

/** Per-project usage rows: project rows joined to the parsed container rows. */
export function perProjectUsage(projects, containerRows) {
  const byName = new Map((containerRows || []).map((r) => [r.name, r]));
  return (projects || []).map((p) => {
    const row = p.container_name ? byName.get(p.container_name) : null;
    return {
      project_id: p.id,
      name: p.name,
      lifecycle: p.lifecycle,
      pinned: !!p.pinned,
      container: p.container_name || null,
      container_status: row ? row.status : 'none',
      memory_mb: row ? row.memory_mb : 0,
      disk_gb: row ? row.disk_gb : null,
    };
  });
}

/** Schema check for a get_host_usage payload → array of problems (empty = valid). */
export function validateHostUsage(u) {
  const problems = [];
  if (!u || typeof u !== 'object') return ['not an object'];
  if (typeof u.taken_at !== 'string' || Number.isNaN(Date.parse(u.taken_at))) problems.push('taken_at must be an ISO-8601 timestamp');
  const numOrNull = (v) => v === null || Number.isFinite(v);
  for (const k of ['cores', 'load_1m', 'load_5m', 'load_15m']) {
    if (!u.cpu || !numOrNull(u.cpu[k])) problems.push(`cpu.${k} must be a number`);
  }
  for (const k of ['total_mb', 'used_mb', 'available_mb', 'percent_used']) {
    if (!u.memory || !numOrNull(u.memory[k])) problems.push(`memory.${k} must be a number`);
  }
  for (const k of ['total_mb', 'used_mb']) {
    if (!u.swap || !numOrNull(u.swap[k])) problems.push(`swap.${k} must be a number`);
  }
  if (!Array.isArray(u.disk)) problems.push('disk must be an array');
  else u.disk.forEach((d, i) => {
    if (!d || typeof d.mount !== 'string') problems.push(`disk[${i}].mount must be a string`);
    for (const k of ['total_gb', 'used_gb', 'available_gb', 'percent_used']) {
      if (!d || !numOrNull(d[k])) problems.push(`disk[${i}].${k} must be a number`);
    }
  });
  if (u.incus_pool !== null && u.incus_pool !== undefined) {
    if (typeof u.incus_pool !== 'object' || typeof u.incus_pool.name !== 'string') problems.push('incus_pool must be null or { name, total_gb, used_gb }');
    else for (const k of ['total_gb', 'used_gb']) if (!numOrNull(u.incus_pool[k])) problems.push(`incus_pool.${k} must be a number`);
  } else if (u.incus_pool === undefined) problems.push('incus_pool must be present (null when unknown)');
  const c = u.containers;
  if (!c || typeof c !== 'object') problems.push('containers must be an object');
  else {
    for (const k of ['running', 'stopped', 'total']) if (!Number.isInteger(c[k])) problems.push(`containers.${k} must be an integer`);
    if (!Array.isArray(c.top_by_memory)) problems.push('containers.top_by_memory must be an array');
    else if (c.top_by_memory.length > 10) problems.push('containers.top_by_memory holds at most 10 rows');
    else c.top_by_memory.forEach((r, i) => {
      if (!r || typeof r.name !== 'string') problems.push(`containers.top_by_memory[${i}].name must be a string`);
      if (!r || !Number.isFinite(r.memory_mb)) problems.push(`containers.top_by_memory[${i}].memory_mb must be a number`);
    });
  }
  if (u.per_project !== undefined) {
    if (!Array.isArray(u.per_project)) problems.push('per_project must be an array');
    else u.per_project.forEach((r, i) => {
      if (!r || !Number.isInteger(r.project_id)) problems.push(`per_project[${i}].project_id must be an integer`);
      if (!r || !['running', 'stopped', 'none'].includes(r.container_status)) problems.push(`per_project[${i}].container_status must be running|stopped|none`);
    });
  }
  return problems;
}

/**
 * reclaim_report arithmetic: before − after, matched by disk mount. Positive
 * numbers mean resources came back. Pure.
 */
export function reclaimDelta(before, after) {
  const d = (a, b) => (Number.isFinite(a) && Number.isFinite(b) ? round2(a - b) : null);
  const beforeMounts = new Map((before.disk || []).map((x) => [x.mount, x]));
  let diskFreed = 0;
  let diskMatched = false;
  for (const x of after.disk || []) {
    const b = beforeMounts.get(x.mount);
    if (b && Number.isFinite(b.used_gb) && Number.isFinite(x.used_gb)) {
      diskFreed += b.used_gb - x.used_gb;
      diskMatched = true;
    }
  }
  const memoryFreed = d(before.memory?.used_mb, after.memory?.used_mb);
  const containersStopped = Number.isInteger(before.containers?.running) && Number.isInteger(after.containers?.running)
    ? before.containers.running - after.containers.running
    : null;
  const loadDelta = {
    load_1m: d(before.cpu?.load_1m, after.cpu?.load_1m),
    load_5m: d(before.cpu?.load_5m, after.cpu?.load_5m),
    load_15m: d(before.cpu?.load_15m, after.cpu?.load_15m),
  };
  const poolFreed = d(before.incus_pool?.used_gb, after.incus_pool?.used_gb);
  const out = {
    before_taken_at: before.taken_at || null,
    after_taken_at: after.taken_at || null,
    memory_freed_mb: memoryFreed,
    containers_stopped: containersStopped,
    load_delta: loadDelta,
    disk_freed_gb: diskMatched ? round2(diskFreed) : null,
    incus_pool_freed_gb: poolFreed,
  };
  out.summary = reclaimSummary(out, before, after);
  return out;
}

function reclaimSummary(delta, before, after) {
  const parts = [];
  const mem = delta.memory_freed_mb;
  if (mem === null) parts.push('Memory could not be compared.');
  else if (mem > 0) parts.push(`Memory in use fell by ${mem} MB (${before.memory.used_mb} MB → ${after.memory.used_mb} MB, ${after.memory.percent_used}% of ${after.memory.total_mb} MB now used).`);
  else if (mem < 0) parts.push(`Memory in use ROSE by ${Math.abs(mem)} MB (${before.memory.used_mb} MB → ${after.memory.used_mb} MB) — nothing was reclaimed, or something else started meanwhile.`);
  else parts.push('Memory in use did not change.');
  const cs = delta.containers_stopped;
  if (cs === null) parts.push('Container counts could not be compared.');
  else if (cs > 0) parts.push(`${cs} container${cs === 1 ? '' : 's'} stopped running (${before.containers.running} → ${after.containers.running} running of ${after.containers.total}).`);
  else if (cs < 0) parts.push(`${Math.abs(cs)} more container${cs === -1 ? '' : 's'} are running than before (${before.containers.running} → ${after.containers.running}).`);
  else parts.push(`The running-container count is unchanged at ${after.containers.running}.`);
  const l1 = delta.load_delta.load_1m;
  if (l1 !== null) {
    parts.push(l1 > 0
      ? `1-minute load dropped by ${l1} (${before.cpu.load_1m} → ${after.cpu.load_1m}).`
      : l1 < 0 ? `1-minute load rose by ${Math.abs(l1)} (${before.cpu.load_1m} → ${after.cpu.load_1m}).` : '1-minute load is unchanged.');
  }
  if (delta.disk_freed_gb === null) parts.push('Disk was not compared (no matching mounts).');
  else if (Math.abs(delta.disk_freed_gb) < 0.01) parts.push('Disk usage did not change — archiving stops guests but frees no disk by design.');
  else parts.push(`Disk usage ${delta.disk_freed_gb > 0 ? 'fell' : 'rose'} by ${Math.abs(delta.disk_freed_gb)} GB across matched mounts.`);
  return parts.join(' ');
}
