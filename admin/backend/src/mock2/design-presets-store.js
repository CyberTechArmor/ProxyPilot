// Custom design presets — the DB half of the preset registry (migration 533).
// The pure module (design-presets.js) holds the built-ins and an injected
// overlay of these rows; this store owns persistence and keeps the overlay in
// sync (loaded at enabled boot, refreshed after every mutation), so every
// existing consumer — seed files, prompt binding, key normalization, the
// picker — sees custom presets with no changes.

import { getMock2Db } from './db.js';
import { setCustomPresets, DESIGN_PRESETS } from './design-presets.js';

const nowIso = () => new Date().toISOString();

function rowToPreset(r) {
  let tokens = null;
  try { tokens = JSON.parse(r.tokens_json); } catch { tokens = null; }
  if (!tokens) return null;
  let references = [];
  try { references = JSON.parse(r.references_json || '[]'); } catch { references = []; }
  return {
    key: r.key,
    name: r.name,
    description: r.description || '',
    tokens,
    // A preset is a LOOK, and a look is more than a palette: the components
    // that carry it, how fast it moves (in tokens), and the pictures the
    // operator was working from. Without these, every project re-derived the
    // same house style and the second app started where the first one did.
    componentsCss: r.components_css || '',
    references: Array.isArray(references) ? references : [],
  };
}

// Load all custom rows into the pure overlay. Called at boot and after writes.
export function loadCustomDesignPresets() {
  const rows = getMock2Db().prepare(`SELECT * FROM mock2_design_presets ORDER BY key`).all();
  const presets = rows.map(rowToPreset).filter(Boolean);
  setCustomPresets(presets);
  return presets;
}

export function isBuiltinDesignPreset(key) {
  return DESIGN_PRESETS.some((p) => p.key === String(key || '').trim());
}

// Insert or (for an existing CUSTOM key with overwrite) replace. Built-in keys
// are never writable — an upload can shadow nothing the platform ships.
export function saveCustomDesignPreset({
  key, name, description = '', tokens, componentsCss = '', references = null,
  createdBy = null, overwrite = false,
}) {
  if (isBuiltinDesignPreset(key)) return { ok: false, error: `"${key}" is a built-in preset — pick a different key` };
  const db = getMock2Db();
  const existing = db.prepare(`SELECT key FROM mock2_design_presets WHERE key = ?`).get(key);
  if (existing && !overwrite) return { ok: false, error: `a custom preset "${key}" already exists — pass overwrite to replace it` };
  const now = nowIso();
  // references === null means "leave whatever is stored alone" — an edit that
  // only changes the palette must not silently drop the reference images.
  const refsJson = references === null ? undefined : JSON.stringify(references || []);
  if (existing) {
    db.prepare(`UPDATE mock2_design_presets SET name = ?, description = ?, tokens_json = ?, components_css = ?, references_json = COALESCE(?, references_json), updated_at = ? WHERE key = ?`)
      .run(name, description, JSON.stringify(tokens), componentsCss || null, refsJson ?? null, now, key);
  } else {
    db.prepare(`INSERT INTO mock2_design_presets (key, name, description, tokens_json, components_css, references_json, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(key, name, description, JSON.stringify(tokens), componentsCss || null, refsJson ?? '[]', createdBy, now, now);
  }
  loadCustomDesignPresets();
  return { ok: true, created: !existing };
}

export function deleteCustomDesignPreset(key) {
  if (isBuiltinDesignPreset(key)) return { ok: false, error: 'built-in presets cannot be deleted' };
  const r = getMock2Db().prepare(`DELETE FROM mock2_design_presets WHERE key = ?`).run(String(key || '').trim());
  loadCustomDesignPresets();
  return { ok: r.changes > 0, error: r.changes > 0 ? null : 'no custom preset with that key' };
}
