// Extended MCP surface — the PURE layer shared by every new tool family
// (routes/mcp-tools/*.js). Native-free: no better-sqlite3, no host exec, so
// the whole module tests in a fresh checkout.
//
// What lives here, and why it is one module:
//
//   * confirmation tokens   — the one-time token every delete / reboot /
//                             restore / rollback verb demands. Issued by the
//                             tool itself on the first call (after every
//                             precondition passed), bound to (tool, subject,
//                             token owner), consumed exactly once, expired
//                             after CONFIRMATION_TTL_MS. A token minted for
//                             one subject can never confirm another.
//   * token scopes          — mcp_tokens.scope_json (migration 903): a key
//                             may be limited to a tool allowlist, to named
//                             LXC guests, to project ids, and must OPT IN to
//                             the self-editing family. An unscoped key is
//                             the full admin surface minus self-editing.
//   * argument redaction    — what the ledger row and the audit entry keep
//                             of a call's arguments: never file contents,
//                             patches, secrets, credentials or upload bytes.
//   * small validators      — shared by more than one family.

import { createHash, randomBytes } from 'node:crypto';

/* ------------------------- confirmation tokens ------------------------- */

export const CONFIRMATION_TTL_MS = 10 * 60 * 1000;
export const CONFIRMATION_PREFIX = 'ppconf_';

export function looksLikeConfirmationToken(s) {
  return typeof s === 'string' && /^ppconf_[0-9a-f]{32}$/.test(s);
}

/**
 * An in-memory, single-process store. A backend restart voids every pending
 * token, which is the right failure: the caller re-reads the current state and
 * asks again rather than confirming against a picture that may have moved.
 */
export function createConfirmationStore({ now = () => Date.now(), ttlMs = CONFIRMATION_TTL_MS, rand = () => randomBytes(16).toString('hex') } = {}) {
  const pending = new Map();

  function sweep() {
    const t = now();
    for (const [k, v] of pending) if (v.expiresAt <= t) pending.delete(k);
  }

  return {
    /** Mint a token bound to one (tool, subject, actor). Returns { token, expires_in_seconds }. */
    issue({ tool, subject, actor }) {
      sweep();
      const token = `${CONFIRMATION_PREFIX}${rand()}`;
      pending.set(token, { tool: String(tool), subject: String(subject), actor: String(actor ?? ''), expiresAt: now() + ttlMs });
      return { token, expires_in_seconds: Math.round(ttlMs / 1000) };
    },
    /**
     * Consume a token. Returns { ok: true } or { error }. A token is deleted on
     * ANY consume attempt that reaches it, matching or not, so a wrong-subject
     * replay burns it instead of leaving it live for a second try.
     */
    consume(token, { tool, subject, actor }) {
      sweep();
      if (!looksLikeConfirmationToken(token)) return { error: 'confirmation_token is malformed — call the tool without it to be issued one.' };
      const rec = pending.get(token);
      if (!rec) return { error: 'confirmation_token is unknown, already used, or expired (tokens live 10 minutes). Call the tool again without it to be issued a fresh one.' };
      pending.delete(token);
      if (rec.tool !== String(tool)) return { error: `confirmation_token was issued for ${rec.tool}, not ${tool}.` };
      if (rec.subject !== String(subject)) return { error: `confirmation_token was issued for a different target (${rec.subject}); it cannot confirm ${subject}.` };
      if (rec.actor !== String(actor ?? '')) return { error: 'confirmation_token was issued to a different MCP key.' };
      return { ok: true };
    },
    size() { sweep(); return pending.size; },
  };
}

/* ------------------------------ token scopes --------------------------- */

export const SELF_EDIT_TOOLS = Object.freeze([
  'get_self_status', 'read_self_file', 'apply_self_patch', 'run_self_checks', 'promote_self', 'rollback_self',
]);

// Tools a container-scoped or project-scoped key may always call: they carry
// no target, or their target is checked by the tool itself.
const SCOPE_NEUTRAL_TOOLS = Object.freeze([
  'list_lxc_containers', 'list_projects', 'create_upload_ticket', 'append_upload_chunk', 'finish_upload',
]);

/** Parse mcp_tokens.scope_json. null / '' / malformed → the unscoped default. */
export function parseTokenScope(raw) {
  const base = { tools: null, lxc_containers: null, project_ids: null, self_edit: false };
  if (raw == null || raw === '') return base;
  let j;
  try { j = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return base; }
  if (!j || typeof j !== 'object') return base;
  const list = (v) => (Array.isArray(v) && v.length ? v.map((x) => String(x)) : null);
  return {
    tools: list(j.tools),
    lxc_containers: list(j.lxc_containers),
    project_ids: Array.isArray(j.project_ids) && j.project_ids.length ? j.project_ids.map((x) => Number(x)).filter(Number.isInteger) : null,
    self_edit: j.self_edit === true,
  };
}

/** Validate a scope object a caller wants to mint. Returns { scope } or { error }. */
export function validateTokenScope(input, { knownTools = [] } = {}) {
  if (input == null) return { scope: null };
  if (typeof input !== 'object' || Array.isArray(input)) return { error: 'scope must be an object' };
  const out = {};
  if (input.tools != null) {
    if (!Array.isArray(input.tools) || !input.tools.every((t) => typeof t === 'string')) return { error: 'scope.tools must be an array of tool names' };
    const unknown = input.tools.filter((t) => knownTools.length && !knownTools.includes(t));
    if (unknown.length) return { error: `scope.tools names unknown tools: ${unknown.join(', ')}` };
    out.tools = [...new Set(input.tools)];
  }
  if (input.lxc_containers != null) {
    if (!Array.isArray(input.lxc_containers) || !input.lxc_containers.every((c) => /^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(String(c)))) {
      return { error: 'scope.lxc_containers must be an array of container names (without the pp- prefix)' };
    }
    out.lxc_containers = [...new Set(input.lxc_containers.map(String))];
  }
  if (input.project_ids != null) {
    if (!Array.isArray(input.project_ids) || !input.project_ids.every((p) => Number.isInteger(Number(p)) && Number(p) > 0)) {
      return { error: 'scope.project_ids must be an array of positive integers' };
    }
    out.project_ids = [...new Set(input.project_ids.map(Number))];
  }
  if (input.self_edit != null) {
    if (typeof input.self_edit !== 'boolean') return { error: 'scope.self_edit must be a boolean' };
    out.self_edit = input.self_edit;
  }
  return { scope: Object.keys(out).length ? out : null };
}

function toolTakes(tool, prop) {
  return !!tool?.inputSchema?.properties?.[prop];
}

/**
 * May this key call this tool with these arguments? `tool` is the catalog
 * entry (for its schema), `scope` a parsed scope. Returns null when allowed,
 * else the refusal string.
 */
export function scopeRefusal(scope, toolName, args = {}, tool = null) {
  const s = scope || parseTokenScope(null);
  if (SELF_EDIT_TOOLS.includes(toolName) && !s.self_edit) {
    return `${toolName} is on the self-editing scope, which this MCP key does not carry. Mint a key with create_scoped_key({ scope: { self_edit: true } }) — self-editing is never granted implicitly.`;
  }
  if (s.tools && !s.tools.includes(toolName)) {
    return `This MCP key is limited to: ${s.tools.join(', ')}. ${toolName} is not on its allowlist.`;
  }
  if (s.lxc_containers) {
    const neutral = SCOPE_NEUTRAL_TOOLS.includes(toolName);
    const takesContainer = tool ? toolTakes(tool, 'container') : args.container != null;
    if (!neutral && !takesContainer && !(s.tools && s.tools.includes(toolName))) {
      return `This MCP key is limited to LXC guest(s) ${s.lxc_containers.join(', ')} and may only call container tools.`;
    }
    if (takesContainer && args.container != null && !s.lxc_containers.includes(String(args.container))) {
      return `This MCP key is limited to LXC guest(s) ${s.lxc_containers.join(', ')}; ${args.container} is outside its scope.`;
    }
    if (args.new_name != null && !s.lxc_containers.includes(String(args.new_name))) {
      return `This MCP key may not create or name a guest outside its scope (${s.lxc_containers.join(', ')}).`;
    }
  }
  if (s.project_ids) {
    const neutral = SCOPE_NEUTRAL_TOOLS.includes(toolName);
    const takesProject = tool ? toolTakes(tool, 'project_id') : args.project_id != null;
    if (!neutral && !takesProject && !(s.tools && s.tools.includes(toolName))) {
      return `This MCP key is limited to project(s) ${s.project_ids.join(', ')} and may only call project tools.`;
    }
    if (takesProject && args.project_id != null && !s.project_ids.includes(Number(args.project_id))) {
      return `This MCP key is limited to project(s) ${s.project_ids.join(', ')}; project ${args.project_id} is outside its scope.`;
    }
  }
  return null;
}

/** The catalog a scoped key is shown by tools/list. */
export function filterCatalogForScope(tools, scope) {
  const s = scope || parseTokenScope(null);
  return tools.filter((t) => scopeRefusal(s, t.name, {}, t) === null);
}

/* ---------------------------- arg redaction ---------------------------- */

const REDACT_KEYS = new Set([
  'content', 'html', 'patch', 'value', 'values', 'vars', 'env', 'password', 'private_key', 'certificate', 'chain',
  'passphrase', 'token', 'cloudflare_token', 'secret', 'zip_base64', 'chunk_base64', 'sql', 'dump', 'crontab',
  'inventory', 'document', 'doc', 'body', 'text', 'note', 'rule', 'answer', 'answers', 'task', 'instruction',
]);

/** What a ledger row keeps of the arguments: shape, targets and flags — never payloads. */
export function redactArgs(args, { keep = [] } = {}) {
  if (!args || typeof args !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(args)) {
    if (keep.includes(k)) { out[k] = v; continue; }
    if (k === 'confirmation_token') { out[k] = '[used]'; continue; }
    if (REDACT_KEYS.has(k)) {
      out[k] = typeof v === 'string' ? `[redacted ${Buffer.byteLength(v, 'utf8')} bytes]` : '[redacted]';
      continue;
    }
    if (v && typeof v === 'object' && !Array.isArray(v)) { out[k] = redactArgs(v); continue; }
    out[k] = typeof v === 'string' && v.length > 200 ? `${v.slice(0, 200)}…` : v;
  }
  return out;
}

/* ------------------------------ validators ------------------------------ */

export function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

export const LXC_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9-]*$/;
export const UNIT_NAME_RE = /^[A-Za-z0-9_.@:\\-]+(\.(service|timer|socket|target|mount|path))?$/;
export const APT_PACKAGE_RE = /^[a-z0-9][a-z0-9+.-]+$/;
export const ENV_KEY_RE = /^[A-Z_][A-Z0-9_]*$/;
export const GIT_REF_RE = /^(?![-.\/])(?!.*[\s~^:?*\[\\])(?!.*\.\.)(?!.*\/\/)(?!.*@\{)(?!.*\.lock$)[A-Za-z0-9._\/-]+(?<![\/.])$/;
export const CRON_LINE_RE = /^(@(reboot|yearly|annually|monthly|weekly|daily|hourly)|(\S+\s+){4}\S+)\s+\S.*$/;

/** A branch/tag name git will accept and that carries no option-lookalike. */
export function validGitRefName(s) {
  const v = String(s || '').trim();
  return GIT_REF_RE.test(v) && v.length <= 120 ? v : null;
}

/** Positive integer in [min,max], else null. */
export function intIn(v, min, max) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) return null;
  return n;
}

/** Octal file mode ("0644" / "755") → normalized 4-digit string, else null. */
export function validOctalMode(v) {
  const s = String(v ?? '').trim();
  if (!/^[0-7]{3,4}$/.test(s)) return null;
  return s.length === 3 ? `0${s}` : s;
}

/** Only statements that cannot write: SELECT / WITH … SELECT / EXPLAIN / SHOW. One statement. */
export function readOnlySqlError(sql) {
  const s = String(sql || '').trim();
  if (!s) return 'sql is required';
  if (s.length > 20000) return 'sql is too long (max 20000 chars)';
  const body = s.replace(/;\s*$/, '');
  if (/;/.test(body)) return 'one statement per call — no semicolons';
  if (!/^(select|with|explain|show|table|values)\b/i.test(body)) return 'run_project_sql is read-only: the statement must start with SELECT, WITH, EXPLAIN, SHOW, TABLE or VALUES';
  if (/\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|vacuum|call|do|lock|refresh|reindex|cluster|comment|security|set\s+role|reset|listen|notify|unlisten|prepare|execute|deallocate)\b/i.test(body) && !/^explain\b/i.test(body)) {
    // A CTE can hide a data-modifying statement (WITH x AS (DELETE …)); the
    // transaction is opened READ ONLY as well, so this is belt and braces.
    return 'run_project_sql is read-only: data-modifying or DDL keywords are refused even inside a CTE';
  }
  return null;
}

/** Parse `KEY=value` lines of /etc/environment into a key list (values never returned). */
export function envFileKeys(text) {
  const keys = [];
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=/);
    if (m && !keys.includes(m[1])) keys.push(m[1]);
  }
  return keys;
}

/** Merge {K: V} into an /etc/environment body: existing keys replaced in place, new keys appended, null deletes. */
export function mergeEnvFile(text, vars) {
  const lines = String(text || '').split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const seen = new Set();
  const out = [];
  const quote = (v) => `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
  for (const line of lines) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=/);
    if (m && Object.prototype.hasOwnProperty.call(vars, m[1])) {
      seen.add(m[1]);
      if (vars[m[1]] === null) continue;
      out.push(`${m[1]}=${quote(vars[m[1]])}`);
      continue;
    }
    out.push(line);
  }
  for (const [k, v] of Object.entries(vars)) {
    if (seen.has(k) || v === null) continue;
    out.push(`${k}=${quote(v)}`);
  }
  return `${out.join('\n')}\n`;
}

/** Validate a { KEY: value|null } map for set_project_env. */
export function validateEnvVars(vars) {
  if (!vars || typeof vars !== 'object' || Array.isArray(vars)) return { error: 'vars must be an object of KEY: value (null deletes a key)' };
  const keys = Object.keys(vars);
  if (!keys.length) return { error: 'vars is empty' };
  if (keys.length > 100) return { error: 'at most 100 keys per call' };
  for (const k of keys) {
    if (!ENV_KEY_RE.test(k)) return { error: `"${k}" is not a valid environment variable name (A-Z, 0-9, _; must not start with a digit)` };
    const v = vars[k];
    if (v !== null && typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') return { error: `${k}: values must be strings (or null to delete)` };
    if (typeof v === 'string' && v.length > 8192) return { error: `${k}: value is too long (max 8192 chars)` };
    if (typeof v === 'string' && /[\u0000]/.test(v)) return { error: `${k}: value contains a NUL byte` };
  }
  return { vars: Object.fromEntries(keys.map((k) => [k, vars[k] === null ? null : String(vars[k])])) };
}

/* --------------------------- checklist parsing --------------------------- */

/** Parse a markdown checklist into items: `- [ ] text`, `- [x] text`, `- [~] text` (waived). */
export function parseChecklist(md) {
  const items = [];
  const lines = String(md || '').split('\n');
  lines.forEach((line, i) => {
    const m = line.match(/^\s*[-*]\s+\[([ xX~])\]\s+(.*)$/);
    if (!m) return;
    const mark = m[1].toLowerCase();
    items.push({
      line: i + 1,
      status: mark === 'x' ? 'pass' : mark === '~' ? 'waived' : 'open',
      text: m[2].trim(),
    });
  });
  return items;
}

/**
 * Record a check in a markdown checklist. `match` is the item text (exact or
 * case-insensitive substring, must be unique). Returns { md, item } or { error }.
 * A note is appended as an indented line under the item, stamped with a date.
 */
export function recordChecklistItem(md, { match, status, note = null, date = new Date().toISOString().slice(0, 10) }) {
  const marks = { pass: 'x', fail: ' ', open: ' ', waived: '~' };
  if (!marks[status]) return { error: 'status must be pass, fail, open or waived' };
  const lines = String(md || '').split('\n');
  const needle = String(match || '').trim().toLowerCase();
  if (!needle) return { error: 'item is required' };
  const hits = [];
  lines.forEach((line, i) => {
    const m = line.match(/^(\s*[-*]\s+)\[([ xX~])\]\s+(.*)$/);
    if (m && m[3].trim().toLowerCase().includes(needle)) hits.push(i);
  });
  if (!hits.length) return { error: `no checklist item matches "${match}"` };
  const exact = hits.filter((i) => lines[i].replace(/^(\s*[-*]\s+)\[([ xX~])\]\s+/, '').trim().toLowerCase() === needle);
  const idx = exact.length === 1 ? exact[0] : hits.length === 1 ? hits[0] : null;
  if (idx == null) return { error: `"${match}" matches ${hits.length} items — be more specific` };
  const m = lines[idx].match(/^(\s*[-*]\s+)\[([ xX~])\]\s+(.*)$/);
  lines[idx] = `${m[1]}[${marks[status]}] ${m[3]}`;
  const stamp = `${m[1].replace(/[-*]/, ' ')}  - ${date} ${status.toUpperCase()}${note ? `: ${String(note).replace(/\n/g, ' ').trim()}` : ''}`;
  lines.splice(idx + 1, 0, stamp);
  return { md: lines.join('\n'), item: { line: idx + 1, status, text: m[3].trim() } };
}

/* ----------------------------- run ledger ------------------------------ */

/** The one place the S/M/L size vocabulary maps onto the build lanes. */
export const BUILD_SIZE_TO_MODE = Object.freeze({ S: 'quick', M: 'mvp', L: 'full' });

export function resolveBuildMode({ size, mode } = {}) {
  if (mode != null && mode !== '') {
    const m = String(mode).toLowerCase();
    if (!['quick', 'mvp', 'full'].includes(m)) return { error: 'mode must be quick, mvp or full' };
    return { mode: m };
  }
  if (size != null && size !== '') {
    const s = String(size).toUpperCase();
    if (!BUILD_SIZE_TO_MODE[s]) return { error: 'size must be S, M or L' };
    return { mode: BUILD_SIZE_TO_MODE[s], size: s };
  }
  return { mode: 'full' };
}

/* ---------------------------- releases registry ------------------------- */

export const RELEASES_PATH = 'state/releases.json';

export function parseReleases(text) {
  try {
    const j = JSON.parse(String(text || ''));
    if (!j || typeof j !== 'object' || !Array.isArray(j.releases)) return { releases: [], current: null };
    return { releases: j.releases, current: j.current || null };
  } catch { return { releases: [], current: null }; }
}

export function renderReleases(reg) {
  return `${JSON.stringify({ releases: reg.releases, current: reg.current }, null, 2)}\n`;
}

/* --------------------------- systemd list parsing ---------------------- */

/** `systemctl list-units --output=json` rows → compact objects; tolerates text output. */
export function parseSystemctlUnits(stdout) {
  const text = String(stdout || '').trim();
  if (text.startsWith('[')) {
    try {
      return JSON.parse(text).map((u) => ({ unit: u.unit, load: u.load, active: u.active, sub: u.sub, description: u.description }));
    } catch { /* fall through */ }
  }
  const out = [];
  for (const line of text.split('\n')) {
    const m = line.trim().replace(/^●\s*/, '').match(/^(\S+\.(?:service|timer|socket|target|mount|path))\s+(\S+)\s+(\S+)\s+(\S+)\s*(.*)$/);
    if (m) out.push({ unit: m[1], load: m[2], active: m[3], sub: m[4], description: m[5] });
  }
  return out;
}

/** dpkg-query -W -f '${binary:Package}\t${Version}\t${Status}\n' rows. */
export function parseDpkgList(stdout) {
  const out = [];
  for (const line of String(stdout || '').split('\n')) {
    const [name, version, status] = line.split('\t');
    if (name && version && /installed$/.test(status || 'installed')) out.push({ name, version });
  }
  return out;
}

/** `apt list --upgradable` lines: pkg/suite newver arch [upgradable from: old]. */
export function parseAptUpgradable(stdout) {
  const out = [];
  for (const line of String(stdout || '').split('\n')) {
    const m = line.match(/^([^\/\s]+)\/\S+\s+(\S+)\s+\S+\s+\[upgradable from:\s+([^\]]+)\]/);
    if (m) out.push({ name: m[1], candidate: m[2], installed: m[3] });
  }
  return out;
}

/* --------------------------------- misc -------------------------------- */

export function nowIso() { return new Date().toISOString(); }

/** A filesystem-safe timestamp for snapshot / export names. */
export function stamp(d = new Date()) {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

/** Host path guard for the exports directory: no traversal, stays under root. */
export function pathUnder(root, rel) {
  const r = String(rel || '');
  if (!r || r.includes('..') || r.includes('\0') || r.startsWith('/')) return null;
  return `${root.replace(/\/+$/, '')}/${r}`;
}
