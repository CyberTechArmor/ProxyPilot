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
    description: 'Write one text file inside an LXC container. If the file already exists and confirm_overwrite is not true, this returns the current file info instead of writing — show the user your proposed change and get their go-ahead first. On overwrite the previous version is kept as `<path>.old`. Parent directories are created. After config/code edits, redeploy with rerun_startup.',
    inputSchema: {
      type: 'object',
      properties: {
        container: { type: 'string' },
        path: { type: 'string', description: 'Absolute file path inside the container.' },
        content: { type: 'string', description: 'The complete new file content (UTF-8).' },
        confirm_overwrite: { type: 'boolean', description: 'Set true only after the user approved replacing the existing file.' },
      },
      required: ['container', 'path', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'rerun_startup',
    description: 'Re-run the startup script registered for an LXC container (the redeploy step after write_lxc_file edits). Returns the run output and exit code. Fails if no startup script has been registered — register one via apply_lxc_zip.',
    inputSchema: {
      type: 'object',
      properties: {
        container: { type: 'string' },
      },
      required: ['container'],
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
