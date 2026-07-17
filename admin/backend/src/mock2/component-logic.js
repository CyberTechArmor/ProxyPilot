// Mock2 component-library PURE decision layer (migration 516). Native-free,
// unit-tested stub-first (risk R9). A COMPONENT is a reusable, versioned
// building block — a set of source files plus integration notes (e.g. an LDAPS
// connection module) — that the build runner is offered so a repeated need is
// met with the ONE audited implementation instead of a fresh AI rewrite.
//
// Versioning follows the framework-registry idiom (framework-logic.js): one
// monotonic integer per component, content rows IMMUTABLE, revert = a NEW
// version carrying old content. The one deliberate addition: change_reason is
// REQUIRED on every version — the library's history must say WHY each version
// exists, not just what changed.
//
// Terminology (risk R7): nothing here is named "agent".

import { createHash } from 'node:crypto';

// ---- limits (bounds the prompt/DB cost of a single component) ----

export const MAX_COMPONENT_FILES = 40;
export const MAX_COMPONENT_FILE_CHARS = 200_000;
export const MAX_COMPONENT_TOTAL_CHARS = 600_000;
export const MAX_COMPONENT_PROMPT_CHARS = 60_000; // one get_component tool result

// The export/import document format tag. Bump only on breaking shape changes.
export const COMPONENT_EXPORT_FORMAT = 'proxypilot-component@1';

export const COMPONENT_STATUSES = Object.freeze(['draft', 'published', 'deprecated']);

// ---- key + tags ----

// A component key is the stable handle the runner and imports address it by:
// lowercase slug, 2–64 chars, letters/digits/hyphens, no leading/trailing '-'.
const KEY_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export function validateComponentKey(key) {
  const k = String(key || '').trim();
  if (!k) return { ok: false, error: 'key is required' };
  if (k.length < 2 || k.length > 64) return { ok: false, error: 'key must be 2–64 characters' };
  if (!KEY_RE.test(k)) return { ok: false, error: 'key must be a lowercase slug (letters, digits, hyphens)' };
  return { ok: true, key: k };
}

// Derive a key from a display name ("LDAPS Connection" → "ldaps-connection").
export function deriveComponentKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
}

// Normalize a tags input (array or comma-separated string) to a deduped,
// lowercased array of short tags. Never throws.
export function normalizeTags(input) {
  const raw = Array.isArray(input) ? input : String(input || '').split(',');
  const seen = new Set();
  const out = [];
  for (const t of raw) {
    const tag = String(t || '').trim().toLowerCase().slice(0, 40);
    if (tag && !seen.has(tag)) { seen.add(tag); out.push(tag); }
    if (out.length >= 12) break;
  }
  return out;
}

export function parseTagsJson(tagsJson) {
  try {
    const doc = JSON.parse(tagsJson || '[]');
    return Array.isArray(doc) ? doc.map((t) => String(t)).slice(0, 12) : [];
  } catch { return []; }
}

// ---- files ----

// A safe relative path, same rule as the runner's container file tools: no
// absolute paths, no traversal. Null on rejection.
export function safeComponentPath(path) {
  const p = String(path || '').trim().replace(/^\.\//, '');
  if (!p || p.length > 400) return null;
  if (p.startsWith('/') || p.includes('\\') || p.split('/').some((seg) => seg === '..' || seg === '')) return null;
  return p;
}

// Validate + normalize a candidate version's files ([{path, content}]).
// Returns { ok, error } or { ok: true, files } with paths normalized and the
// list ordered as given. Duplicate paths, unsafe paths and size blowouts are
// refused here so no route can persist them.
export function validateComponentFiles(files) {
  if (!Array.isArray(files) || files.length === 0) return { ok: false, error: 'at least one file is required' };
  if (files.length > MAX_COMPONENT_FILES) return { ok: false, error: `too many files (max ${MAX_COMPONENT_FILES})` };
  const seen = new Set();
  const out = [];
  let total = 0;
  for (const f of files) {
    if (!f || typeof f !== 'object') return { ok: false, error: 'each file must be an object with path and content' };
    const path = safeComponentPath(f.path);
    if (!path) return { ok: false, error: `invalid file path "${String(f.path || '').slice(0, 80)}" — must be relative, no traversal` };
    if (seen.has(path)) return { ok: false, error: `duplicate file path "${path}"` };
    if (typeof f.content !== 'string') return { ok: false, error: `file "${path}" needs string content` };
    if (f.content.length > MAX_COMPONENT_FILE_CHARS) return { ok: false, error: `file "${path}" is too large (max ${MAX_COMPONENT_FILE_CHARS} chars)` };
    total += f.content.length;
    if (total > MAX_COMPONENT_TOTAL_CHARS) return { ok: false, error: `component is too large overall (max ${MAX_COMPONENT_TOTAL_CHARS} chars)` };
    seen.add(path);
    out.push({ path, content: f.content });
  }
  return { ok: true, files: out };
}

export function parseFilesJson(filesJson) {
  try {
    const doc = JSON.parse(filesJson || '[]');
    return Array.isArray(doc) ? doc.filter((f) => f && typeof f.path === 'string' && typeof f.content === 'string') : [];
  } catch { return []; }
}

// ---- versioning (same rule as the framework registry) ----

export function nextComponentVersion(rows = []) {
  let max = 0;
  for (const r of rows) {
    const v = Number(r?.version || 0);
    if (v > max) max = v;
  }
  return max + 1;
}

// change_reason is the library's annotated history — REQUIRED, non-trivial.
export function validateChangeReason(reason) {
  const r = String(reason || '').trim();
  if (r.length < 3) return { ok: false, error: 'change_reason is required — say why this version exists' };
  if (r.length > 2000) return { ok: false, error: 'change_reason is too long (max 2000 chars)' };
  return { ok: true, reason: r };
}

// ---- client-safe shapes ----

export function publicComponentShape(row, { currentVersion = null, includeFiles = false } = {}) {
  if (!row) return null;
  const out = {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description || null,
    category: row.category || null,
    tags: parseTagsJson(row.tags),
    status: row.status || 'published',
    current_version_id: row.current_version_id ?? null,
    current_version: currentVersion ? Number(currentVersion.version) : null,
    created_by: row.created_by ?? null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
  if (currentVersion) out.contract = parseContractJson(currentVersion.contract_json);
  if (includeFiles && currentVersion) {
    out.files = parseFilesJson(currentVersion.files_json);
    out.usage_md = currentVersion.usage_md || null;
  }
  return out;
}

export function publicComponentVersionShape(row, { includeFiles = false } = {}) {
  if (!row) return null;
  const out = {
    id: row.id,
    component_id: row.component_id,
    version: row.version,
    change_reason: row.change_reason || null,
    reverted_from_version: row.reverted_from_version ?? null,
    source: row.source || 'in_app',
    source_project_id: row.source_project_id ?? null,
    submission_id: row.submission_id ?? null,
    created_by: row.created_by ?? null,
    created_at: row.created_at || null,
  };
  out.contract = parseContractJson(row.contract_json);
  if (includeFiles) {
    out.files = parseFilesJson(row.files_json);
    out.usage_md = row.usage_md || null;
  }
  return out;
}

export function publicSubmissionShape(row, { includeFiles = false } = {}) {
  if (!row) return null;
  const out = {
    id: row.id,
    project_id: row.project_id,
    component_id: row.component_id ?? null,
    proposed_key: row.proposed_key || null,
    proposed_name: row.proposed_name,
    description: row.description || null,
    category: row.category || null,
    tags: parseTagsJson(row.tags),
    notes: row.notes || null,
    status: row.status || 'pending',
    review_reason: row.review_reason || null,
    reviewed_by: row.reviewed_by ?? null,
    reviewed_at: row.reviewed_at || null,
    result_component_id: row.result_component_id ?? null,
    result_version_id: row.result_version_id ?? null,
    created_by: row.created_by ?? null,
    created_at: row.created_at || null,
    file_count: parseFilesJson(row.files_json).length,
  };
  if (includeFiles) {
    out.files = parseFilesJson(row.files_json);
    out.usage_md = row.usage_md || null;
  }
  return out;
}

// ---- export / import ----

// The portable JSON document for one component at one version. Everything a
// receiving install needs to recreate it (files, notes, metadata); nothing
// install-specific (ids, authors).
export function buildComponentExport(component, version) {
  const contract = parseContractJson(version.contract_json);
  return {
    format: COMPONENT_EXPORT_FORMAT,
    key: component.key,
    name: component.name,
    description: component.description || null,
    category: component.category || null,
    tags: parseTagsJson(component.tags),
    version: Number(version.version),
    usage_md: version.usage_md || null,
    ...(contract ? { contract } : {}),
    files: parseFilesJson(version.files_json),
  };
}

// Validate an import document (the output of buildComponentExport, possibly
// hand-edited). Returns { ok, error } or { ok: true, data } with normalized
// fields ready for insert.
export function parseComponentImport(doc) {
  if (!doc || typeof doc !== 'object') return { ok: false, error: 'import must be a JSON object' };
  if (doc.format !== COMPONENT_EXPORT_FORMAT) {
    return { ok: false, error: `unsupported format "${String(doc.format || '(none)').slice(0, 60)}" — expected ${COMPONENT_EXPORT_FORMAT}` };
  }
  const name = String(doc.name || '').trim();
  if (!name || name.length > 120) return { ok: false, error: 'name is required (max 120 chars)' };
  const keyCheck = validateComponentKey(doc.key || deriveComponentKey(name));
  if (!keyCheck.ok) return { ok: false, error: keyCheck.error };
  const filesCheck = validateComponentFiles(doc.files);
  if (!filesCheck.ok) return { ok: false, error: filesCheck.error };
  const contractCheck = validateComponentContract(doc.contract === undefined ? null : doc.contract);
  if (!contractCheck.ok) return { ok: false, error: contractCheck.error };
  return {
    ok: true,
    data: {
      key: keyCheck.key,
      name,
      description: String(doc.description || '').trim().slice(0, 2000) || null,
      category: String(doc.category || '').trim().slice(0, 80) || null,
      tags: normalizeTags(doc.tags),
      usage_md: typeof doc.usage_md === 'string' ? doc.usage_md.slice(0, 20000) : null,
      contract: contractCheck.contract,
      files: filesCheck.files,
    },
  };
}

// ---- runner integration (prompt + tool result) ----

// The catalog section appended to the runner's system prompt (hand-rolled) or
// CLAUDE.md (SDK). `access` picks the wording for HOW the runner reaches the
// source: 'tool' → the get_component tool; 'files' → reference copies
// materialized under `dir` in the working directory. Empty catalog → ''.
export function buildComponentCatalogSection(components = [], { access = 'tool', dir = '.claude/components' } = {}) {
  const list = (Array.isArray(components) ? components : []).filter((c) => c && c.key);
  if (!list.length) return '';
  const lines = list.map((c) => {
    const tags = parseTagsJson(c.tags);
    const tagStr = tags.length ? ` [${tags.join(', ')}]` : '';
    return `- ${c.key} (v${c.current_version ?? c.version ?? '?'}): ${c.name}${c.description ? ` — ${c.description}` : ''}${tagStr}`;
  }).join('\n');
  const how = access === 'files'
    ? `Full sources are materialized as REFERENCE COPIES under \`${dir}/<key>/\` in your
working directory (with the integration notes in \`${dir}/<key>/USAGE.md\`). Copy the
files you need into the app source and adapt only the glue (imports, config, wiring);
never import from \`${dir}/\` directly — it is ephemeral to this run and is not synced back.`
    : `Adopt a component with the materialize_component tool (pass its key): the platform
copies its files verbatim into the app source server-side — byte-exact at any size, the
contents never transit your context — and returns a path/size/sha256 manifest. Inspect
first with get_component (integration notes + file manifest; small components include
their sources inline). Then adapt only the glue (imports, config, wiring).`;
  return `

# Component library (reuse before you rebuild)
Checking this list against the task is a REQUIRED first step of every build cycle,
not an optional optimization. This installation maintains a library of approved,
versioned components — audited implementations of recurring needs. When the task
overlaps one of these, REUSE IT: take the component's code as-is and write only the
minimal glue to connect it, instead of writing your own version. That keeps every
project consistent and keeps review cost near zero. Re-implementing what a component
already provides is a defect, not thoroughness. Only build from scratch what no
component covers.

Available components:
${lines}

${how}`;
}

// ---- manifest + server-side materialization (the pure halves) ----
//
// File CONTENT must never be forced through a token-limited tool result to be
// adopted — that path truncates (the get_component budget here, and the
// runner's own tool-result cap besides). Instead the platform materializes a
// component's files INTO the app source server-side (runner.js, over the same
// channel write_file uses) and the model works from the MANIFEST: each file's
// path, byte size, and sha256 — enough to know exactly what landed and to
// read/adapt the real files from disk afterward.

export function sha256Hex(content) {
  return createHash('sha256').update(String(content ?? ''), 'utf8').digest('hex');
}

// [{path, bytes, sha256}] for a version's files — the identity of the content
// without the content.
export function buildComponentManifest(files = []) {
  return (Array.isArray(files) ? files : [])
    .filter((f) => f && typeof f.path === 'string' && typeof f.content === 'string')
    .map((f) => ({ path: f.path, bytes: Buffer.byteLength(f.content, 'utf8'), sha256: sha256Hex(f.content) }));
}

export function formatManifestLines(manifest = []) {
  return manifest.map((m) => `- ${m.path} (${m.bytes} bytes, sha256 ${m.sha256})`).join('\n');
}

// Format one component (metadata + files + notes) as a get_component tool
// result. Small components (full render within MAX_COMPONENT_PROMPT_CHARS)
// return files inline exactly as before. A component that would exceed the
// budget is NEVER cut mid-file: it returns the metadata + full file MANIFEST
// + notes, and directs the runner to materialize_component — which delivers
// every file verbatim regardless of size. The manifest leads and usage_md
// trails so the runner's own tool-result cap can only ever cost notes, not
// the file list.
export function formatComponentForModel(component, version) {
  if (!component || !version) return 'error: component not found';
  const files = parseFilesJson(version.files_json);
  let out = `Component ${component.key} v${version.version} — ${component.name}\n`;
  if (component.description) out += `${component.description}\n`;
  if (version.usage_md) out += `\n## Integration notes\n${version.usage_md}\n`;
  out += `\n## Files (${files.length})\n`;
  for (const f of files) out += `\n--- ${f.path} ---\n${f.content}\n`;
  if (out.length <= MAX_COMPONENT_PROMPT_CHARS) return out;

  const manifest = buildComponentManifest(files);
  const total = manifest.reduce((n, m) => n + m.bytes, 0);
  let alt = `Component ${component.key} v${version.version} — ${component.name}\n`;
  if (component.description) alt += `${component.description}\n`;
  alt += `\n## Files (${files.length}, ${total} bytes total — inline contents withheld: they exceed the ${MAX_COMPONENT_PROMPT_CHARS}-char tool budget)\n`;
  alt += `${formatManifestLines(manifest)}\n`;
  alt += `\nThese files are NOT in this result and are NOT yet on disk. To adopt this component, call materialize_component with key "${component.key}" — the platform writes every file verbatim into the app source (byte-exact, sizes and hashes above), then read/adapt them with read_file/write_file.\n`;
  if (version.usage_md) alt += `\n## Integration notes\n${version.usage_md}\n`;
  return alt;
}

// The in-container script halves of materialization. Paths were validated at
// import (safeComponentPath) but may contain spaces/quotes, so each rides
// base64 and is only ever expanded inside double quotes.

const b64path = (p) => Buffer.from(String(p), 'utf8').toString('base64');

// Which target paths already exist (they are KEPT unless overwrite is asked).
export function buildPathsExistScript(paths = [], { appDir = '/srv/app' } = {}) {
  return `cd "${appDir}" || exit 1
for b in ${paths.map(b64path).join(' ')}; do
  p=$(printf '%s' "$b" | base64 -d)
  if [ -e "$p" ]; then echo "EXISTS $p"; else echo "ABSENT $p"; fi
done
`;
}

export function parsePathsExistOutput(stdout) {
  const existing = new Set();
  for (const line of String(stdout || '').split('\n')) {
    const m = line.match(/^EXISTS (.+)$/);
    if (m) existing.add(m[1]);
  }
  return existing;
}

// Byte-exactness check for the files just written: sha256 each in-container,
// compared (in Node) against the stored content's hash from the manifest.
export function buildManifestVerifyScript(paths = [], { appDir = '/srv/app' } = {}) {
  return `cd "${appDir}" || exit 1
for b in ${paths.map(b64path).join(' ')}; do
  p=$(printf '%s' "$b" | base64 -d)
  if [ -f "$p" ]; then sha256sum -- "$p"; else echo "MISSING  $p"; fi
done
`;
}

// sha256sum lines ("<hex>  <path>") → Map path → hex; MISSING lines → null.
export function parseShaVerifyOutput(stdout) {
  const out = new Map();
  for (const line of String(stdout || '').split('\n')) {
    let m = line.match(/^([0-9a-f]{64})\s[\s*](.+)$/);
    if (m) { out.set(m[2], m[1]); continue; }
    m = line.match(/^MISSING\s+(.+)$/);
    if (m) out.set(m[1], null);
  }
  return out;
}

// ---- the component CONTRACT (machine-readable half of usage_md) ----
//
// A contract makes a component API-DRIVEN: it declares what the component IS
// (provides), when the define stage should suggest it (requires_when), the HTTP
// surface the build wires the mockup to (api), the exported code surface
// (exports), structured config (config — the machine half of usage_md §3),
// external connections (connections — pre-declares integration-manifest entries
// and egress), dependency installs (dependencies), and which files are SQL
// migrations to renumber on install (migrations). Everything here is validated
// pure so no route or import can persist a malformed contract; automation reads
// ONLY the contract (usage_md stays the model-facing narrative).

export const MAX_CONTRACT_PROVIDES = 64;
export const MAX_CONTRACT_API = 64;
export const MAX_CONTRACT_CONFIG = 48;
export const MAX_CONTRACT_CONNECTIONS = 8;
export const MAX_CONTRACT_EXPORTS = 64;

const API_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const capSlug = (v, n = 80) => String(v || '').trim().slice(0, n);

// A capability/provides slug: lowercase, dot-separated segments of [a-z0-9-].
const CAPABILITY_RE = /^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)*$/;
export function normalizeCapability(value) {
  const v = String(value || '').trim().toLowerCase().slice(0, 80);
  return CAPABILITY_RE.test(v) ? v : null;
}

// validateComponentContract — validate + normalize a candidate contract object.
// Absent/empty input is fine ({ ok: true, contract: null }) — the contract is
// optional; components without one behave exactly as before. Returns
// { ok, error } or { ok: true, contract } with every field normalized.
export function validateComponentContract(input) {
  if (input == null) return { ok: true, contract: null };
  if (typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'contract must be a JSON object' };
  const out = {};

  if (input.provides !== undefined) {
    if (!Array.isArray(input.provides)) return { ok: false, error: 'contract.provides must be an array of capability slugs' };
    const seen = new Set();
    out.provides = [];
    for (const p of input.provides.slice(0, MAX_CONTRACT_PROVIDES)) {
      const cap = normalizeCapability(p);
      if (!cap) return { ok: false, error: `contract.provides has an invalid capability "${String(p).slice(0, 40)}" — lowercase slug segments separated by dots` };
      if (!seen.has(cap)) { seen.add(cap); out.provides.push(cap); }
    }
  }

  if (input.requires_when !== undefined) {
    const rw = input.requires_when;
    if (!rw || typeof rw !== 'object' || Array.isArray(rw)) return { ok: false, error: 'contract.requires_when must be an object' };
    const caps = Array.isArray(rw.capabilities_any) ? rw.capabilities_any : [];
    const normalized = [];
    for (const c of caps.slice(0, MAX_CONTRACT_PROVIDES)) {
      const cap = normalizeCapability(c);
      if (!cap) return { ok: false, error: `contract.requires_when.capabilities_any has an invalid capability "${String(c).slice(0, 40)}"` };
      if (!normalized.includes(cap)) normalized.push(cap);
    }
    out.requires_when = {
      capabilities_any: normalized,
      suggest_prompt: String(rw.suggest_prompt || '').trim().slice(0, 500),
    };
  }

  if (input.api !== undefined) {
    if (!Array.isArray(input.api)) return { ok: false, error: 'contract.api must be an array of endpoint entries' };
    if (input.api.length > MAX_CONTRACT_API) return { ok: false, error: `contract.api has too many entries (max ${MAX_CONTRACT_API})` };
    out.api = [];
    for (const e of input.api) {
      if (!e || typeof e !== 'object') return { ok: false, error: 'each contract.api entry must be an object' };
      const method = String(e.method || '').trim().toUpperCase();
      if (!API_METHODS.includes(method)) return { ok: false, error: `contract.api entry has an invalid method "${String(e.method).slice(0, 12)}"` };
      const path = String(e.path || '').trim().slice(0, 200);
      if (!path.startsWith('/')) return { ok: false, error: `contract.api path "${path.slice(0, 60)}" must start with "/"` };
      out.api.push({
        method, path,
        summary: capSlug(e.summary, 300),
        auth: capSlug(e.auth, 40) || 'user',
      });
    }
  }

  if (input.exports !== undefined) {
    if (!Array.isArray(input.exports)) return { ok: false, error: 'contract.exports must be an array of names' };
    out.exports = input.exports.slice(0, MAX_CONTRACT_EXPORTS).map((x) => capSlug(x, 120)).filter(Boolean);
  }

  if (input.config !== undefined) {
    if (!Array.isArray(input.config)) return { ok: false, error: 'contract.config must be an array of {key, ...} entries' };
    if (input.config.length > MAX_CONTRACT_CONFIG) return { ok: false, error: `contract.config has too many entries (max ${MAX_CONTRACT_CONFIG})` };
    out.config = [];
    const seen = new Set();
    for (const c of input.config) {
      if (!c || typeof c !== 'object') return { ok: false, error: 'each contract.config entry must be an object' };
      const key = String(c.key || '').trim().slice(0, 120);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return { ok: false, error: `contract.config key "${key.slice(0, 40)}" is not a valid env var name` };
      if (seen.has(key)) return { ok: false, error: `contract.config has a duplicate key "${key}"` };
      seen.add(key);
      out.config.push({
        key,
        secret: c.secret === true,
        required: c.required === true,
        default: c.default === undefined || c.default === null ? null : String(c.default).slice(0, 400),
        description: capSlug(c.description, 300),
      });
    }
  }

  if (input.connections !== undefined) {
    if (!Array.isArray(input.connections)) return { ok: false, error: 'contract.connections must be an array' };
    if (input.connections.length > MAX_CONTRACT_CONNECTIONS) return { ok: false, error: `contract.connections has too many entries (max ${MAX_CONTRACT_CONNECTIONS})` };
    out.connections = [];
    for (const c of input.connections) {
      if (!c || typeof c !== 'object') return { ok: false, error: 'each contract.connections entry must be an object' };
      const id = normalizeCapability(c.id);
      if (!id) return { ok: false, error: `contract.connections entry needs a slug id (got "${String(c.id).slice(0, 40)}")` };
      const classification = String(c.egress?.classification || 'private');
      if (!['public', 'private', 'local'].includes(classification)) return { ok: false, error: `connection "${id}" has an invalid egress.classification` };
      out.connections.push({
        id,
        transport: capSlug(c.transport, 40) || 'https',
        optional: c.optional === true,
        egress: {
          classification,
          port: Number.isInteger(c.egress?.port) && c.egress.port > 0 && c.egress.port < 65536 ? c.egress.port : null,
          protocol: ['tcp', 'udp'].includes(c.egress?.protocol) ? c.egress.protocol : 'tcp',
        },
        config_keys: (Array.isArray(c.config_keys) ? c.config_keys : []).map((k) => capSlug(k, 120)).filter(Boolean).slice(0, 12),
        live_verification: { required: c.live_verification?.required !== false },
      });
    }
  }

  if (input.dependencies !== undefined) {
    const d = input.dependencies;
    if (!d || typeof d !== 'object' || Array.isArray(d)) return { ok: false, error: 'contract.dependencies must be {runtime, peers, dev} arrays' };
    const pkgList = (arr) => (Array.isArray(arr) ? arr : []).map((p) => String(p || '').trim().slice(0, 120))
      .filter((p) => /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*(@[\w.^~>=<-]+)?$/.test(p)).slice(0, 40);
    out.dependencies = { runtime: pkgList(d.runtime), peers: pkgList(d.peers), dev: pkgList(d.dev) };
  }

  if (input.migrations !== undefined) {
    const m = input.migrations;
    if (!m || typeof m !== 'object' || Array.isArray(m)) return { ok: false, error: 'contract.migrations must be an object' };
    const dir = safeComponentPath(m.dir || 'migrations');
    if (!dir) return { ok: false, error: 'contract.migrations.dir must be a safe relative path' };
    out.migrations = { dir, renumber: m.renumber === 'none' ? 'none' : 'append' };
  }

  return { ok: true, contract: Object.keys(out).length ? out : null };
}

export function parseContractJson(contractJson) {
  try {
    const doc = JSON.parse(contractJson || 'null');
    const check = validateComponentContract(doc);
    return check.ok ? check.contract : null;
  } catch { return null; }
}

// ---- define-time capability matching (pure — no model, no DB) ----

// extractCapabilities — pull the capability hints out of an inventory document
// (state/inventory.json). Tolerant of any shape; returns a deduped slug list.
// `required_capabilities` is written by the concept-stage extraction
// (concept-logic.js) as {users: true, roles: [...], external_directories: [...]}
// or a plain array of slugs — both forms are accepted.
export function extractCapabilities(inventory) {
  const rc = inventory?.required_capabilities;
  const out = new Set();
  const add = (v) => { const cap = normalizeCapability(v); if (cap) out.add(cap); };
  if (Array.isArray(rc)) {
    for (const v of rc) add(v);
  } else if (rc && typeof rc === 'object') {
    for (const [k, v] of Object.entries(rc)) {
      if (v === true) add(k);
      else if (Array.isArray(v) && v.length) { add(k); for (const item of v) add(item); }
    }
  }
  return [...out];
}

// suggestComponentsForCapabilities — join the app's capabilities against the
// published components' contracts. A component is suggested when any of its
// requires_when.capabilities_any matches, unless it was already decided for
// this project (decidedKeys — confirmed OR declined; a decline must not nag).
// `components` are catalog rows carrying contract (parsed). Order-stable by key.
export function suggestComponentsForCapabilities(components = [], capabilities = [], decidedKeys = new Set()) {
  const caps = new Set(capabilities || []);
  const out = [];
  for (const c of components || []) {
    if (!c || !c.key || decidedKeys.has(c.key)) continue;
    const rw = c.contract?.requires_when;
    if (!rw || !Array.isArray(rw.capabilities_any) || !rw.capabilities_any.length) continue;
    const matched = rw.capabilities_any.filter((cap) => caps.has(cap));
    if (!matched.length) continue;
    out.push({ key: c.key, name: c.name, matched, suggest_prompt: rw.suggest_prompt || '' });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

// The tappable choices for a component_suggestion question, and the parse of
// the editor's answer. The affirmative choice leads; anything that reads as a
// refusal declines; unrecognized free text also DECLINES — a component must
// never be installed on an ambiguous answer (the build can still adopt it
// explicitly via the catalog).
export const COMPONENT_SUGGESTION_ACCEPT = 'Use the standard component';
export const COMPONENT_SUGGESTION_DECLINE = 'Skip it — build this from scratch';

export function buildComponentSuggestionQuestion({ key, name, suggest_prompt = '' }) {
  const question = suggest_prompt
    || `This app appears to need "${name}". Use the standard ${key} component (installed automatically, no build credits) instead of building it from scratch?`;
  return { question, choices: [COMPONENT_SUGGESTION_ACCEPT, COMPONENT_SUGGESTION_DECLINE] };
}

export function parseComponentSuggestionAnswer(answer) {
  const a = String(answer || '').trim();
  if (a === COMPONENT_SUGGESTION_ACCEPT || /^(use|yes|install|adopt)\b/i.test(a)) return { decision: 'confirmed' };
  return { decision: 'declined' };
}

// ---- auto-apply (operator policy — every published component, every build) ----
//
// The suggest-on-capability-match flow above only offers a component when the
// inventory's capabilities happen to match its contract, and only installs it
// after an editor taps confirm — so a library of known-good components mostly
// sat unused while builds re-implemented them from scratch. Auto-apply is the
// operator switch that flips the default: every PUBLISHED component is
// confirmed for every build (origin 'auto') and lands via the same
// deterministic zero-token pre-install. Explicit human decisions are never
// overridden: a declined component stays declined.

export const COMPONENT_AUTO_APPLY_ON = 'on';
export const COMPONENT_AUTO_APPLY_OFF = 'off';

// normalizeComponentAutoApply — 'on'/'off' (case/space tolerant, common
// boolean spellings accepted). Unknown/empty falls back to ON: the whole point
// of the policy is that reuse is the default.
export function normalizeComponentAutoApply(raw) {
  const v = String(raw ?? '').trim().toLowerCase();
  if (['off', 'false', '0', 'no', 'disabled'].includes(v)) return COMPONENT_AUTO_APPLY_OFF;
  return COMPONENT_AUTO_APPLY_ON;
}

// selectAutoApplyComponents — the catalog rows auto-apply should confirm for a
// project: published components with no selection row yet, or still sitting at
// 'suggested' (an unanswered suggestion question). Anything a human decided
// (confirmed/declined) or that already ran an install (installed/
// install_failed — retried by the pre-installer itself) is left alone.
// Order-stable by key.
export function selectAutoApplyComponents(catalog = [], existingRows = []) {
  const statusByKey = new Map((existingRows || []).map((r) => [r.key, r.status]));
  return (catalog || [])
    .filter((c) => {
      if (!c || !c.key) return false;
      const status = statusByKey.get(c.key);
      return status === undefined || status === 'suggested';
    })
    .sort((a, b) => a.key.localeCompare(b.key));
}

// ---- deterministic install plans (pure halves of component-install.js) ----

// planMigrationRenumber — slot a component's SQL migrations AFTER the project's
// existing migrations/*.sql. `componentFiles` are the version's files; those
// under contract.migrations.dir become {from, to} renames numbered from the
// highest existing NNNN_ prefix. A component migration whose SUFFIX (the part
// after the number) already exists in the project is skipped — the component
// was installed before; re-numbering it again would re-run its DDL.
export function planMigrationRenumber(componentFiles = [], existingNames = [], migrations = { dir: 'migrations', renumber: 'append' }) {
  const dir = (migrations?.dir || 'migrations').replace(/\/+$/, '');
  const isMigration = (p) => p.startsWith(`${dir}/`) && p.endsWith('.sql') && !p.slice(dir.length + 1).includes('/');
  const inDir = (componentFiles || []).filter((f) => f && isMigration(f.path));
  if (!inDir.length || migrations?.renumber === 'none') {
    return { renames: [], skipped: [], migrationPaths: new Set(inDir.map((f) => f.path)) };
  }
  const suffixOf = (name) => name.replace(/^\d+/, '');
  let max = 0;
  const existingSuffixes = new Set();
  for (const n of existingNames || []) {
    const base = String(n || '').trim();
    if (!base.endsWith('.sql')) continue;
    const m = base.match(/^(\d+)/);
    if (m) max = Math.max(max, Number(m[1]));
    existingSuffixes.add(suffixOf(base));
  }
  const width = Math.max(4, String(max).length);
  const renames = [];
  const skipped = [];
  // Stable order: the component's own numbering decides relative order.
  const ordered = [...inDir].sort((a, b) => a.path.localeCompare(b.path));
  for (const f of ordered) {
    const base = f.path.slice(dir.length + 1);
    if (existingSuffixes.has(suffixOf(base))) { skipped.push(f.path); continue; }
    max += 1;
    renames.push({ from: f.path, to: `${dir}/${String(max).padStart(width, '0')}${suffixOf(base)}`, content: f.content });
  }
  return { renames, skipped, migrationPaths: new Set(inDir.map((f) => f.path)) };
}

// mergeEnvDefaults — append a contract's NON-SECRET defaults to a project .env,
// preserving everything already there. Secrets are NEVER written (they go to
// the operator verification checklist). Returns { text, added } — added empty
// means no write needed.
export function mergeEnvDefaults(envText = '', config = []) {
  const existing = new Set();
  for (const line of String(envText || '').split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (m) existing.add(m[1]);
  }
  const added = [];
  const lines = [];
  for (const c of config || []) {
    if (!c || c.secret === true || c.default == null || existing.has(c.key)) continue;
    lines.push(`${c.key}=${c.default}`);
    added.push(c.key);
  }
  if (!added.length) return { text: String(envText || ''), added };
  const base = String(envText || '').replace(/\s+$/, '');
  return { text: `${base ? `${base}\n\n` : ''}# Added by component install (defaults — override as needed)\n${lines.join('\n')}\n`, added };
}

// manifestEntryFromConnection — pre-declare a component connection in
// state/integrations.json (the exact shape integration-logic validates), so the
// truthfulness gate sees an honest manifest from cycle start instead of relying
// on the build to declare it.
export function manifestEntryFromConnection({ componentKey, connection, subsystem = null }) {
  return {
    id: `${componentKey}-${connection.id}`.slice(0, 80),
    subsystem: subsystem || componentKey,
    actions: [{ name: 'connect', operation: connection.transport || 'https' }],
    destination: { source: 'env', key: connection.config_keys?.[0] || `${componentKey.replace(/-/g, '_').toUpperCase()}_URL` },
    transport: connection.transport || 'https',
    provenance: { response_to_output: 'required' },
    live_verification: { required: connection.live_verification?.required !== false },
    egress: { classification: connection.egress?.classification || 'private' },
  };
}

// deriveComponentSubsystem — the src/<subsystem>/ a component's code lands in
// (the integration manifest's `subsystem` field). First src/* file wins; a
// component with no src/ files falls back to its key.
export function deriveComponentSubsystem(files = [], fallback = null) {
  for (const f of files || []) {
    const m = String(f?.path || '').match(/^src\/([^/]+)\//);
    if (m) return m[1];
  }
  return fallback;
}

// publicProjectComponentShape — client-safe view of one project-selection row
// (joined with component key/name and the pinned version's contract).
export function publicProjectComponentShape(row) {
  if (!row) return null;
  let options = null;
  try { options = row.options_json ? JSON.parse(row.options_json) : null; } catch { options = null; }
  let manifest = null;
  try { manifest = row.install_manifest_json ? JSON.parse(row.install_manifest_json) : null; } catch { manifest = null; }
  const contract = parseContractJson(row.contract_json);
  return {
    id: row.id,
    project_id: row.project_id,
    component_id: row.component_id,
    key: row.key,
    name: row.name || row.key,
    description: row.description || null,
    status: row.status,
    origin: row.origin,
    version: row.pinned_version ?? null,
    options,
    question_id: row.question_id ?? null,
    decided_at: row.decided_at || null,
    installed_at: row.installed_at || null,
    install_error: row.install_error || null,
    files_installed: Array.isArray(manifest) ? manifest.length : null,
    provides: contract?.provides || [],
    api_count: Array.isArray(contract?.api) ? contract.api.length : 0,
  };
}

// ---- state/components.json (the repo mirror of the project's selection) ----

export const COMPONENTS_STATE_PATH = 'state/components.json';

// buildComponentsStateDoc — the committed artifact recording WHICH components
// this project uses, at what version, and why. Entries ride the hash-chained
// history like integrations.json; the build runner and the gates read it.
// `api` (the contract's endpoints) and `files` (the installed file paths from the
// install manifest) are what the component-reuse gate matches the working-tree
// diff against — an endpoint or file re-implemented OUTSIDE these paths is a
// duplication, an edit INSIDE them is adaptation.
export function buildComponentsStateDoc(entries = []) {
  return `${JSON.stringify({
    schema_version: 1,
    entries: (entries || []).map((e) => ({
      key: e.key,
      version: e.version ?? null,
      status: e.status,
      origin: e.origin || null,
      options: e.options ?? null,
      api: Array.isArray(e.api) ? e.api : undefined,
      files: Array.isArray(e.files) ? e.files : undefined,
      installed_at: e.installed_at || null,
    })),
  }, null, 2)}\n`;
}

// ---- installed-components prompt section (the build wiring contract) ----

// buildInstalledComponentsSection — the section the BUILD prompt carries when
// components were pre-installed by the platform. Unlike the catalog (things the
// runner MAY adopt), these are already on disk and audited: the runner's job is
// to WIRE the approved design to their API surface, not to rebuild them.
// Entries carry {key, name, version, contract, usage_md?}. Empty → ''.
export function buildInstalledComponentsSection(entries = []) {
  const list = (entries || []).filter((e) => e && e.key);
  if (!list.length) return '';
  const blocks = list.map((e) => {
    const c = e.contract || {};
    const lines = [`## ${e.key} v${e.version ?? '?'} — ${e.name || e.key}`];
    if (Array.isArray(c.provides) && c.provides.length) lines.push(`Provides: ${c.provides.join(', ')}`);
    if (Array.isArray(c.api) && c.api.length) {
      lines.push('API surface (wire the UI to these — they exist and are audited):');
      for (const a of c.api) lines.push(`- ${a.method} ${a.path} [${a.auth}]${a.summary ? ` — ${a.summary}` : ''}`);
    }
    if (Array.isArray(c.exports) && c.exports.length) lines.push(`Code exports for glue: ${c.exports.join(', ')}`);
    if (Array.isArray(c.config) && c.config.length) {
      const secrets = c.config.filter((k) => k.secret).map((k) => k.key);
      if (secrets.length) lines.push(`Secrets the operator supplies (never hardcode): ${secrets.join(', ')}`);
    }
    lines.push(`Integration notes: get_component "${e.key}" (do NOT re-materialize — the files are already in the source tree).`);
    return lines.join('\n');
  });
  return `

# Installed components (already in the source tree — wire, don't rebuild)
CHECK this list against the task BEFORE writing anything: if one of these already
provides what the task asks for, your job is to WIRE it, not to rebuild it. The
platform pre-installed these audited components into this project (files,
migrations, and dependencies are already in place). Treat them as the app's
standard infrastructure: connect the approved design to their API surface and
write only the glue (mounts, config, calls). Do NOT rewrite, fork, or duplicate
what they provide, and do not re-implement their endpoints — a task whose capability
an installed component already ships needs wiring or nothing at all, never a
from-scratch reimplementation.

${blocks.join('\n\n')}`;
}

// The materialize_component tool result: what landed where, verbatim-verified —
// paths, sizes, hashes, and per-file status. Never file contents.
export function formatMaterializeResult({ component, version, manifest = [], statuses = {} }) {
  const st = (p) => statuses[p] || 'unknown';
  const count = (s) => manifest.filter((m) => st(m.path) === s).length;
  const written = count('written');
  const kept = count('kept');
  const failed = manifest.length - written - kept;
  let out = `Materialized component ${component.key} v${version.version} — ${component.name}\n`;
  out += `${written} written, ${kept} kept (already existed — pass overwrite=true to replace), ${failed} failed\n`;
  out += `\n## Files (${manifest.length})\n`;
  for (const m of manifest) out += `- [${st(m.path)}] ${m.path} (${m.bytes} bytes, sha256 ${m.sha256})\n`;
  out += `\nEvery [written] file is on disk verbatim (sha256-verified against the library copy). `;
  out += `Read/adapt them with read_file/write_file and wire the glue per the integration notes (get_component "${component.key}").\n`;
  if (failed > 0) out += `\nWARNING: ${failed} file(s) did not land intact — re-run materialize_component, or stop and report if it persists. Do NOT reconstruct their contents from memory.\n`;
  return out;
}
