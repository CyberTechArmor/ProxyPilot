// Delegated editing — the pure layer.
//
// ProxyPilot's main MCP server (routes/mcp.js) hands a Claude client the whole
// host: containers, routes, projects, shells. Delegated editing is the other
// shape entirely — an admin turns it on for ONE container, sets ONE editable
// directory, and hands somebody else a key that can edit files in there and
// nothing else.
//
// The trust model is that the key holder is hostile, or that their AI session
// has been talked into being hostile. Every guarantee therefore has to hold
// server-side against a client that sends whatever it likes:
//
//   * SCOPE comes off the key row, never off the request. There is no
//     `container` parameter anywhere in this catalog — not one the server
//     ignores, one that does not exist, so no prompt injection can invent it.
//   * The TOOL SET is a separate catalog, not a filter over the main one. A
//     tool that is not here cannot be reached by name, because the endpoint
//     that would dispatch it never learned the name.
//   * PATHS are relative to the activation's docroot and are canonicalized
//     inside the container (see canonicalizePathScript) before anything opens
//     them, because `..` is only the easy escape — a symlink planted inside
//     the docroot is the interesting one.
//
// This module is native-free on purpose (no better-sqlite3, no incus): the
// containment predicates and the shell script that enforces them are the part
// most worth testing exhaustively, and they test fastest with nothing behind
// them. The store lives in lib/editor-keys.js, the endpoint in
// routes/mcp-editor.js.

import { createHash, randomBytes } from 'node:crypto';

// Control characters and DEL — rejected in every path this module accepts,
// because they are never legitimate and they are how a filename hides what it
// really is in a log or a confirmation prompt.
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

// ---- tokens ----
//
// ppedit_<64 hex>. The prefix is deliberately distinct from the main server's
// ppmcp_ so a leaked secret is identifiable on sight — in a log, in a secret
// scanner, in a screenshot — as a delegated-editing key and not host access.
export const EDITOR_TOKEN_PREFIX = 'ppedit_';

// What the admin list shows so a key in hand can be matched to a row:
// 'ppedit_' + 7 hex. Seven of sixty-four hex digits identifies a row without
// meaningfully narrowing the remaining 228 bits.
export const EDITOR_TOKEN_DISPLAY_LEN = EDITOR_TOKEN_PREFIX.length + 7;

export function mintEditorToken(rand = () => randomBytes(32).toString('hex')) {
  return `${EDITOR_TOKEN_PREFIX}${rand()}`;
}

export function hashEditorToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

export function looksLikeEditorToken(token) {
  return /^ppedit_[0-9a-f]{64}$/.test(String(token || ''));
}

/** The stored display prefix for a freshly minted token. */
export function editorTokenDisplayPrefix(token) {
  return String(token || '').slice(0, EDITOR_TOKEN_DISPLAY_LEN);
}

/**
 * Bearer header first, then the tokenized URL segment — the same two shapes
 * the main server accepts, because claude.ai custom connectors cannot set
 * headers. A token that does not match the shape is never looked up.
 */
export function editorTokenFromRequest({ authorization = '', pathToken = '' } = {}) {
  const m = /^Bearer\s+(\S+)$/i.exec(String(authorization || '').trim());
  if (m && looksLikeEditorToken(m[1])) return m[1];
  if (looksLikeEditorToken(pathToken)) return pathToken;
  return null;
}

// ---- the docroot ----

export const DEFAULT_DOCROOT = '/var/www/html';

/**
 * An activation's editable root: absolute, at least one segment deep, no
 * traversal, no control characters, no trailing slash.
 *
 * '/' is rejected rather than normalized. A docroot of '/' would make every
 * containment check below trivially true and hand the key holder the whole
 * filesystem — the exact thing delegated editing exists not to do.
 */
export function validDocroot(p) {
  const s = String(p ?? '').trim();
  if (!s.startsWith('/') || CONTROL_CHARS.test(s) || s.includes('\\')) return null;
  const kept = [];
  for (const seg of s.split('/')) {
    if (seg === '') continue;                    // collapses '//' and a trailing '/'
    if (seg === '.' || seg === '..') return null;
    kept.push(seg);
  }
  if (!kept.length) return null;                 // '/' itself
  return `/${kept.join('/')}`;
}

/**
 * A path as the KEY HOLDER writes it: relative to the docroot, which they see
 * as '/'. A leading slash is accepted and means root-relative, because that is
 * how the docroot was described to them — it is stripped, never honoured as an
 * absolute host path.
 *
 * Returns the normalized relative path ('' for the root itself), or null.
 * Rejecting '..' here is the cheap layer; canonicalizePathScript is the one
 * that survives a symlink.
 */
export function validDelegatedPath(p, { allowRoot = true } = {}) {
  const raw = String(p ?? '').trim();
  if (CONTROL_CHARS.test(raw) || raw.includes('\\')) return null;
  const kept = [];
  for (const seg of raw.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') return null;
    kept.push(seg);
  }
  const rel = kept.join('/');
  if (!rel && !allowRoot) return null;
  return rel;
}

/**
 * Containment, as a predicate over two ALREADY-CANONICAL absolute paths.
 *
 * The prefix has to be `root + '/'`, never a bare string prefix: '/var/www' is
 * not a parent of '/var/www-backup', and treating it as one is the classic way
 * this check gets written wrong.
 */
export function pathInsideRoot(canonicalRoot, canonicalTarget) {
  const root = String(canonicalRoot || '');
  const target = String(canonicalTarget || '');
  if (!root.startsWith('/') || !target.startsWith('/')) return false;
  if (root === '/') return false;                // never a valid docroot; see validDocroot
  return target === root || target.startsWith(`${root}/`);
}

/**
 * Rewrite a tool result so it speaks the holder's coordinate system: the
 * docroot is '/', and where it really sits on the host filesystem is not
 * something a delegated session gets to learn.
 *
 * Applied to the SERIALIZED result rather than to known fields, because the
 * paths that leak are the ones nobody enumerated — an error string from a
 * failed stat, a diff header, a conflict list. A blanket replacement over the
 * text catches all of them.
 */
export function redactDocroot(text, docroot) {
  const s = String(text ?? '');
  if (!docroot || !docroot.startsWith('/')) return s;
  // Longest form first: '<root>/' → '/', so '<root>/a' becomes '/a' rather
  // than '//a'. Then any remaining bare mention of the root itself.
  const escaped = docroot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return s
    .replace(new RegExp(`${escaped}/`, 'g'), '/')
    .replace(new RegExp(escaped, 'g'), '/');
}

// ---- in-container canonicalization ----
//
// Once '..' and absolute paths are rejected, the only escape left is a symlink
// planted inside the docroot — and a symlink can only be resolved where it
// lives. So this check runs in the guest, before the tool that would open the
// path is dispatched.
//
// Contract: argv is (docroot, relative-path); prints the canonical absolute
// path on success. The exit codes are the whole vocabulary:
//   65  the docroot does not exist (or is not a directory)
//   66  the parent directory of the target does not exist
//   67  the resolved path is outside the docroot — traversal, or a symlink
//       (of the target itself, or of any directory on the way to it)
//
// `cd -P && pwd -P` is the POSIX canonicalization that works in dash, ash and
// busybox alike, and it resolves every symlink in the directory chain — which
// is why the PARENT is containment-checked too, not just the leaf. A symlinked
// intermediate directory is otherwise a hole straight through the leaf check.
export function canonicalizePathScript() {
  return [
    'root="$1"; rel="$2";',
    'croot=$(cd -P -- "$root" 2>/dev/null && pwd -P) || exit 65;',
    'case "$croot" in /) exit 65;; esac;',
    "if [ -z \"$rel\" ]; then printf '%s\\n' \"$croot\"; exit 0; fi;",
    'tgt="$croot/$rel";',
    'd=$(dirname -- "$tgt"); b=$(basename -- "$tgt");',
    'cdir=$(cd -P -- "$d" 2>/dev/null && pwd -P) || exit 66;',
    'case "$cdir" in "$croot"|"$croot"/*) ;; *) exit 67;; esac;',
    'c="$cdir/$b";',
    'if [ -L "$c" ]; then r=$(readlink -f -- "$c" 2>/dev/null) || exit 67; c="$r"; fi;',
    "case \"$c\" in \"$croot\"|\"$croot\"/*) printf '%s\\n' \"$c\"; exit 0;; *) exit 67;; esac",
  ].join(' ');
}

export const CANON_ERRORS = {
  65: 'The editable directory configured for this key does not exist in the container — ask the administrator to check it.',
  66: 'No such directory (the parent of that path does not exist).',
  67: 'That path is outside the editable directory.',
};

// ---- key status, as the admin list shows it ----
//
// Four states, and only one of them is a property of the key row itself.
// Revocation is permanent and per key; suspension is the container's toggle
// and reversible; orphaned means the container the key was pinned to is gone.
export function keyStatus(row, { activationActive = false, containerExists = true } = {}) {
  if (row?.revoked_at) return 'revoked';
  if (!containerExists) return 'orphaned';
  if (!activationActive) return 'suspended';
  return 'active';
}

/** Why the endpoint refused — one message per non-active state. */
export function authRejection(status, containerName) {
  switch (status) {
    case 'revoked':
      return 'This key has been revoked.';
    case 'orphaned':
      return `The container this key was issued for (${containerName}) no longer exists.`;
    case 'suspended':
      return `Delegated editing is currently turned off for ${containerName}.`;
    default:
      return null;
  }
}

// ---- rate limiting ----
//
// Generous for an interactive editing session — a burst of reads while the
// model orients, then a trickle of writes — and mean enough that a leaked key
// cannot be used to enumerate a container at speed. A token bucket rather than
// a fixed window, so a pause actually buys back capacity.
export const EDITOR_RATE = { capacity: 120, refillPerMinute: 60 };
export const EDITOR_AUTH_FAIL_RATE = { capacity: 10, refillPerMinute: 5 };

/**
 * Token bucket over an injected clock. `take` returns null when allowed, or
 * the seconds to wait when it refuses — the caller turns that into a
 * Retry-After.
 */
export function createRateLimiter({ capacity, refillPerMinute }, now = () => Date.now()) {
  const buckets = new Map();
  const perMs = refillPerMinute / 60000;
  return {
    take(key) {
      const t = now();
      const b = buckets.get(key) || { tokens: capacity, at: t };
      b.tokens = Math.min(capacity, b.tokens + (t - b.at) * perMs);
      b.at = t;
      if (b.tokens < 1) {
        buckets.set(key, b);
        return Math.max(1, Math.ceil((1 - b.tokens) / perMs / 1000));
      }
      b.tokens -= 1;
      buckets.set(key, b);
      return null;
    },
    // Bounded memory: a bucket sitting at full capacity is indistinguishable
    // from an absent one, so it can be dropped.
    sweep() {
      const t = now();
      for (const [k, b] of buckets) {
        if (b.tokens + (t - b.at) * perMs >= capacity) buckets.delete(k);
      }
    },
    size: () => buckets.size,
  };
}

// ---- the restricted catalog ----
//
// A SEPARATE list, not a filter. Every name here maps to one of the main
// server's LXC content handlers (EDITOR_TOOL_MAP); nothing else is reachable,
// and in particular: no run_lxc_command, no container lifecycle, no networking
// or config, no snapshots, no logs, no port probes, no projects, no routes, no
// static sites, no upload tickets, no host operations.
//
// Note what the schemas do NOT contain: a container parameter, an absolute
// path, or (on apply_zip) a startup script. Those are the ways a request could
// otherwise widen its own scope, so they are not parameters at all.
export const EDITOR_MCP_TOOLS = [
  {
    name: 'list_files',
    description: 'List files and directories in the editable area. Paths are relative to the editable root, which is "/" from here — there is nothing above it. Set recursive for the whole tree.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory relative to the root, e.g. "assets", or "/" for the root itself. Default: the root.' },
        recursive: { type: 'boolean', description: 'Descend into subdirectories (default false).' },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'read_file',
    description: 'Read one text file from the editable area. Returns the content plus its sha256, which write_file takes as an optional expected_sha256 precondition so a concurrent edit cannot be silently overwritten.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'File path relative to the editable root.' } },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'search_files',
    description: 'Search the editable area with an extended regular expression (grep -rnIE). Returns path + line number + the matching line. Optionally limited to a subdirectory and a filename glob.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Extended regular expression.' },
        path: { type: 'string', description: 'Subdirectory to search, relative to the root. Default: the whole editable area.' },
        glob: { type: 'string', description: 'Filename glob, e.g. *.php.' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
  },
  {
    name: 'write_file',
    description: 'Write one text file in the editable area. An existing file is NOT replaced until you re-call with confirm_overwrite: true — show the user your proposed change first. The previous version is always kept alongside as <name>.old, which file_diff and restore_file work from.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the editable root.' },
        content: { type: 'string', description: 'The complete new file content.' },
        confirm_overwrite: { type: 'boolean', description: 'Required to replace a file that already exists.' },
        expected_sha256: { type: 'string', description: 'Optional precondition: the sha256 read_file returned. The write is refused if the file changed since.' },
        mode: { type: 'string', description: 'Optional octal permissions, e.g. "0644".' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'file_diff',
    description: 'Unified diff between a file and its .old backup (or another file in the editable area) — what your last write actually changed.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the editable root.' },
        against: { type: 'string', description: 'Compare against this file instead of <path>.old. Relative to the root.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'restore_file',
    description: 'Put a file\'s .old backup back. The swap is itself reversible — calling again restores what you just replaced. Needs confirm: true.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the editable root.' },
        confirm: { type: 'boolean', description: 'Required. Show the user file_diff first.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'inspect_zip',
    description: 'Phase one of a zip deploy: report what the archive contains and which existing files it would replace, without touching anything. Show the user the conflicts, then call apply_zip with the returned upload_id. The zip rides inline as base64 (up to ~2 MB) — this endpoint has no upload tickets.',
    inputSchema: {
      type: 'object',
      properties: {
        zip_base64: { type: 'string', description: 'The archive, base64-encoded.' },
        target_dir: { type: 'string', description: 'Directory to extract into, relative to the editable root. Default: the root.' },
        sha256: { type: 'string', description: 'Optional checksum of the zip bytes, verified before parsing.' },
      },
      required: ['zip_base64'],
      additionalProperties: false,
    },
  },
  {
    name: 'apply_zip',
    description: 'Phase two: extract a zip inspected by inspect_zip. Replacing existing files needs confirm_overwrite: true, and every replaced file is kept as <name>.old. Nothing is executed — this endpoint cannot register or run a startup script.',
    inputSchema: {
      type: 'object',
      properties: {
        upload_id: { type: 'string', description: 'From inspect_zip.' },
        confirm_overwrite: { type: 'boolean', description: 'Required when inspect_zip reported conflicts.' },
        strip_wrapper: { type: 'boolean', description: 'Drop a single top-level wrapper directory (default true).' },
      },
      required: ['upload_id'],
      additionalProperties: false,
    },
  },
];

/** Restricted tool name → the main server's handler that does the work. */
export const EDITOR_TOOL_MAP = {
  list_files: 'list_lxc_files',
  read_file: 'read_lxc_file',
  search_files: 'search_lxc_files',
  write_file: 'write_lxc_file',
  file_diff: 'lxc_file_diff',
  restore_file: 'restore_lxc_file',
  inspect_zip: 'inspect_lxc_zip',
  apply_zip: 'apply_lxc_zip',
};

export const EDITOR_MCP_SERVER_INFO = { name: 'proxypilot-editor', version: '1.0.0' };

export const EDITOR_MCP_INSTRUCTIONS = [
  'Delegated file editing for one directory of one container.',
  'Every path you pass is relative to that editable root, and the root is "/" as far as this connection is concerned —',
  'there is no path above it, no other container, and no way to name one.',
  'The working loop: list_files or search_files to find the file, read_file to see it (keep the sha256),',
  'write_file to change it. A file that already exists is never replaced on the first call:',
  'you get needs_confirmation back, so show the user the change and re-call with confirm_overwrite: true.',
  'Every replacement is kept as <name>.old — file_diff shows what changed and restore_file puts it back.',
  'For many files at once, inspect_zip then apply_zip (inline base64, ~2 MB).',
  'This endpoint edits files and nothing else: it cannot run commands, restart or reconfigure the container,',
  'read logs, or reach anything outside the editable directory. Do not tell the user it can.',
].join(' ');
