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
};

export const MCP_TOOLS = [
  {
    name: 'list_static_sites',
    description: 'List the static sites ProxyPilot serves (id, name, domain). Use the id with inspect_static_site_zip / apply_static_site_zip to deploy new content.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'create_upload_ticket',
    description: 'Create a short-lived upload slot for a zip file. Returns { ticket, upload_url, expires_in_seconds }. PUT the raw zip bytes to upload_url (Content-Type: application/zip, same auth not required — the ticket in the URL is the secret), then pass the ticket to an inspect tool. Tickets are single-use and expire in 30 minutes.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
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
    name: 'list_projects',
    description: 'List ProxyPilot AI-dev projects (id, name, url, lifecycle, latest build status).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_project',
    description: 'Details for one AI-dev project: lifecycle, live URL, latest build cycle status, build queue.',
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
