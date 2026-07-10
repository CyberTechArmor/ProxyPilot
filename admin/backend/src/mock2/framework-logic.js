// Mock2 framework-registry PURE decision layer (Phase M5, ADR-003). Native-free,
// unit-tested stub-first (risk R9). The framework is a versioned bundle
// (constitution + four skills + gate scripts + design system + project template)
// in mock2_framework_versions: one monotonic integer across the bundle, content
// rows IMMUTABLE, revert = a NEW version carrying old content. A cycle pins
// current_framework_version_id at start (M6); this module owns the versioning
// and validation rules that keep the registry honest.
//
// Terminology (risk R7): nothing here is named "agent".

// The immutable content columns of a version row (03-data-model.md, mig 501).
export const FRAMEWORK_CONTENT_FIELDS = Object.freeze([
  'constitution_md',
  'skills_json',
  'gates_json',
  'design_system_md',
  'project_template_ref',
]);

// The next monotonic version number given the existing rows. 1 when empty.
export function nextVersionNumber(rows = []) {
  let max = 0;
  for (const r of rows) {
    const v = Number(r?.version || 0);
    if (v > max) max = v;
  }
  return max + 1;
}

// Validate a candidate version's content. skills_json/gates_json must parse;
// gates must be an array of {name, script, order}. Returns { ok, error }.
export function validateFrameworkContent(content = {}) {
  for (const f of ['constitution_md', 'design_system_md', 'project_template_ref']) {
    if (!String(content[f] || '').trim()) return { ok: false, error: `${f} is required` };
  }
  let skills;
  try { skills = JSON.parse(content.skills_json); } catch { return { ok: false, error: 'skills_json must be valid JSON' }; }
  if (skills == null || typeof skills !== 'object') return { ok: false, error: 'skills_json must be a JSON object or array' };

  let gates;
  try { gates = JSON.parse(content.gates_json); } catch { return { ok: false, error: 'gates_json must be valid JSON' }; }
  if (!Array.isArray(gates)) return { ok: false, error: 'gates_json must be a JSON array of gate objects' };
  for (const g of gates) {
    if (!g || typeof g !== 'object') return { ok: false, error: 'each gate must be an object' };
    if (!String(g.name || '').trim()) return { ok: false, error: 'each gate needs a name' };
    if (typeof g.script !== 'string') return { ok: false, error: `gate "${g.name}" needs a script string` };
  }
  return { ok: true };
}

// Build the content for a revert-as-new-version: copy the source version's
// immutable content verbatim, stamp reverted_from_version, and default the
// changelog. The caller assigns the new monotonic version number.
export function buildRevertContent(sourceRow, { changelog = null } = {}) {
  if (!sourceRow) throw new Error('buildRevertContent: no source version');
  const content = {};
  for (const f of FRAMEWORK_CONTENT_FIELDS) content[f] = sourceRow[f];
  content.reverted_from_version = Number(sourceRow.version);
  content.changelog = changelog || `Revert to v${sourceRow.version}`;
  return content;
}

// Client-safe view. Metadata always; the (large) content fields only when
// asked (the editor and the diff view need them, the list does not).
export function publicFrameworkShape(row, { includeContent = false } = {}) {
  if (!row) return null;
  const out = {
    id: row.id,
    version: row.version,
    changelog: row.changelog || null,
    reverted_from_version: row.reverted_from_version ?? null,
    source: row.source || 'in_app',
    source_git_commit: row.source_git_commit || null,
    created_by: row.created_by ?? null,
    created_at: row.created_at || null,
  };
  if (includeContent) {
    for (const f of FRAMEWORK_CONTENT_FIELDS) out[f] = row[f];
  }
  return out;
}
