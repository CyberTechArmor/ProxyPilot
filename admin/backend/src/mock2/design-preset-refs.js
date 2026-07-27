// Reference images kept WITH a design preset.
//
// A preset carried tokens and nothing else, so "our house style" could not be
// saved. The part that mattered most was the least portable: the reference
// images an operator collected while getting the first app to look right are
// the strongest input the mockup render has, and they lived in one project's
// asset library. The second app started from the platform defaults however much
// was learned building the first.
//
// Bytes on disk under the same asset root as everything else (an 8MB screenshot
// is not a SQLite BLOB), the filenames on the preset row. Copied INTO a new
// project's library at creation, where the render already reads them — so this
// module adds a store and changes no render path.
//
// Terminology (risk R7): nothing here is named "agent".

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { addImage, updateAsset, readAssetImage, findAssetByBytes, listAssets } from './project-assets.js';

// A preset is a look, not an album. Four is what the mockup render looks at.
export const MAX_PRESET_REFERENCES = 4;

function assetRoot() {
  return process.env.MOCK2_ASSET_DIR
    || path.join(process.env.DATA_DIR || path.join(process.cwd(), 'data'), 'mock2-assets');
}

// Presets are keyed by a validated slug (KEY_RE in design-presets.js), but this
// builds a filesystem path, so it is re-checked HERE rather than trusted from
// two modules away.
function presetDir(key) {
  const clean = String(key || '').trim();
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(clean)) return null;
  return path.join(assetRoot(), 'presets', clean);
}

const EXT_FOR_MIME = Object.freeze({
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif', 'image/svg+xml': '.svg',
});

// storePresetReferences(key, images) → the descriptors to save on the row.
// Content-addressed, so re-saving a preset from the same project does not
// accumulate copies of the same picture.
export function storePresetReferences(key, images = []) {
  const dir = presetDir(key);
  if (!dir) return [];
  fs.mkdirSync(dir, { recursive: true });
  const out = [];
  for (const img of images.slice(0, MAX_PRESET_REFERENCES)) {
    if (!img?.buffer?.length) continue;
    const ext = EXT_FOR_MIME[img.media_type] || '.jpg';
    const file = `${crypto.createHash('sha256').update(img.buffer).digest('hex').slice(0, 32)}${ext}`;
    const full = path.join(dir, file);
    try {
      if (!fs.existsSync(full)) {
        const tmp = `${full}.tmp-${process.pid}`;
        fs.writeFileSync(tmp, img.buffer);
        fs.renameSync(tmp, full);
      }
      out.push({ file, media_type: img.media_type, name: img.name || 'reference', bytes: img.buffer.length });
    } catch (e) {
      console.warn(`[mock2] preset reference write failed for ${key}:`, e?.message);
    }
  }
  return out;
}

// The pinned reference images of a project, as buffers — what "save this
// project's look" should carry forward.
export function projectReferenceImages(projectId) {
  const out = [];
  for (const a of listAssets(projectId)) {
    if (a.kind !== 'image') continue;
    if (!a.pinned && a.tag !== 'reference') continue;
    const img = readAssetImage(projectId, a.id);
    if (img?.buffer?.length) out.push({ ...img, name: a.name });
    if (out.length >= MAX_PRESET_REFERENCES) break;
  }
  return out;
}

// applyPresetReferences(projectId, preset) — seed a NEW project's library with
// the preset's references, pinned and tagged so the mockup render sees them on
// the very first turn.
//
// Best-effort and idempotent: a reference already in the library (by content) is
// skipped, and a missing file is a preset saved before a data-dir move, not a
// reason to fail a project creation.
export function applyPresetReferences(projectId, preset, { createdBy = null } = {}) {
  const refs = Array.isArray(preset?.references) ? preset.references : [];
  const dir = presetDir(preset?.key);
  if (!dir || !refs.length) return [];
  const added = [];
  for (const ref of refs.slice(0, MAX_PRESET_REFERENCES)) {
    try {
      const full = path.join(dir, path.basename(String(ref?.file || '')));
      if (!full.startsWith(dir) || !fs.existsSync(full)) continue;
      const buffer = fs.readFileSync(full);
      if (findAssetByBytes(projectId, buffer)) continue;
      const r = addImage({
        projectId,
        name: ref.name || 'design-reference',
        buffer,
        tag: 'reference',
        body: `Reference image from the "${preset.name || preset.key}" design preset.`,
        createdBy,
      });
      if (!r.ok) continue;
      updateAsset({ projectId, id: r.asset.id, pinned: true });
      added.push(r.asset);
    } catch (e) {
      console.warn(`[mock2] preset reference apply failed for project ${projectId}:`, e?.message);
    }
  }
  return added;
}
