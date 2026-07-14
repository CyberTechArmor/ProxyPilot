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
    : `Fetch a component's full source and integration notes with the get_component tool
(pass its key). Copy the files into the app source and adapt only the glue (imports,
config, wiring).`;
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

// Format one component (metadata + files + notes) as a get_component tool
// result. Bounded to MAX_COMPONENT_PROMPT_CHARS so a huge component can't blow
// the context (same R5 discipline as tool-result truncation).
export function formatComponentForModel(component, version) {
  if (!component || !version) return 'error: component not found';
  const files = parseFilesJson(version.files_json);
  let out = `Component ${component.key} v${version.version} — ${component.name}\n`;
  if (component.description) out += `${component.description}\n`;
  if (version.usage_md) out += `\n## Integration notes\n${version.usage_md}\n`;
  out += `\n## Files (${files.length})\n`;
  for (const f of files) {
    out += `\n--- ${f.path} ---\n${f.content}\n`;
    if (out.length > MAX_COMPONENT_PROMPT_CHARS) {
      return `${out.slice(0, MAX_COMPONENT_PROMPT_CHARS)}\n…[truncated — component exceeds the tool-result budget; fetch individual files with read_file after copying, or ask the operator to split the component]`;
    }
  }
  return out;
}
