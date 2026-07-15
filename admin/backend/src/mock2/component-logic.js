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
  return {
    format: COMPONENT_EXPORT_FORMAT,
    key: component.key,
    name: component.name,
    description: component.description || null,
    category: component.category || null,
    tags: parseTagsJson(component.tags),
    version: Number(version.version),
    usage_md: version.usage_md || null,
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
  return {
    ok: true,
    data: {
      key: keyCheck.key,
      name,
      description: String(doc.description || '').trim().slice(0, 2000) || null,
      category: String(doc.category || '').trim().slice(0, 80) || null,
      tags: normalizeTags(doc.tags),
      usage_md: typeof doc.usage_md === 'string' ? doc.usage_md.slice(0, 20000) : null,
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
This installation maintains a library of approved, versioned components — audited
implementations of recurring needs. When the task overlaps one of these, REUSE IT:
take the component's code as-is and write only the minimal glue to connect it,
instead of writing your own version. That keeps every project consistent and keeps
review cost near zero. Only build from scratch what no component covers.

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
