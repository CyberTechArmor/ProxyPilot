// Project asset library — the DB + filesystem half.
//
// Pairs with the pure project-assets-logic.js (shapes, validation, the harness
// context projection). Rows in SQLite, bytes on disk.
//
// Why bytes on disk: an 8 MB screenshot stored as a BLOB makes every
// `SELECT *` on this table expensive and grows the WAL without bound. The row
// carries `stored_as`, a generated name — the operator's filename is kept for
// display only and is never used as a path.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getMock2Db } from './db.js';
import {
  toAsset, sortAssets, sanitizeName, normalizeTag,
  validateImageUpload, validateContent, ASSET_MIMES,
} from './project-assets-logic.js';

const nowIso = () => new Date().toISOString();

// Same root the rest of mock2 uses for project state, so a backup that takes
// the data directory takes the assets with it.
function assetRoot() {
  const base = process.env.MOCK2_ASSET_DIR
    || path.join(process.env.DATA_DIR || path.join(process.cwd(), 'data'), 'mock2-assets');
  return base;
}
function projectDir(projectId) {
  return path.join(assetRoot(), String(Number(projectId)));
}

/* ------------------------------- reads ---------------------------------- */

export function listAssets(projectId) {
  try {
    const rows = getMock2Db()
      .prepare('SELECT * FROM mock2_project_assets WHERE project_id = ? ORDER BY id')
      .all(Number(projectId));
    return sortAssets(rows).map(toAsset);
  } catch { return []; }   // pre-migration
}

export function getAssetRow(projectId, id) {
  try {
    return getMock2Db()
      .prepare('SELECT * FROM mock2_project_assets WHERE project_id = ? AND id = ?')
      .get(Number(projectId), Number(id)) || null;
  } catch { return null; }
}

export function getAsset(projectId, id) { return toAsset(getAssetRow(projectId, id)); }

// Absolute path to an image's bytes, or null. Recomputed from the row rather
// than stored, and re-checked against the project directory so a tampered
// stored_as cannot escape it.
export function assetFilePath(projectId, id) {
  const row = getAssetRow(projectId, id);
  if (!row || row.kind !== 'image' || !row.stored_as) return null;
  const dir = projectDir(projectId);
  const full = path.join(dir, path.basename(String(row.stored_as)));
  return full.startsWith(dir) ? full : null;
}

/* ------------------------------- writes --------------------------------- */

// addImage — validate, write the bytes, then insert. Bytes first so a failed
// write never leaves a row pointing at a file that does not exist; a failed
// insert leaves an orphan file, which is inert and collectable.
export function addImage({ projectId, name, buffer, tag = null, body = '', width = null, height = null, createdBy = null }) {
  const clean = sanitizeName(name, 'image');
  const check = validateImageUpload({ name: clean, size: buffer ? buffer.length : 0 });
  if (!check.ok) return { ok: false, ...check.error };

  const dir = projectDir(projectId);
  fs.mkdirSync(dir, { recursive: true });
  const storedAs = `${crypto.randomUUID()}${check.ext}`;
  fs.writeFileSync(path.join(dir, storedAs), buffer);

  const ts = nowIso();
  const info = getMock2Db().prepare(`
    INSERT INTO mock2_project_assets
      (project_id, kind, name, body, mime, size, width, height, stored_as, tag, pinned, created_by, created_at, updated_at)
    VALUES (?, 'image', ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
  `).run(
    Number(projectId), clean, String(body || '').slice(0, 2000), check.mime, buffer.length,
    width ? Number(width) : null, height ? Number(height) : null,
    storedAs, normalizeTag(tag, 'image'), createdBy ? String(createdBy) : null, ts, ts,
  );
  return { ok: true, asset: getAsset(projectId, info.lastInsertRowid) };
}

export function addContent({ projectId, name, body, tag = null, createdBy = null }) {
  const check = validateContent({ name, body });
  if (!check.ok) return { ok: false, ...check.error };
  const ts = nowIso();
  const info = getMock2Db().prepare(`
    INSERT INTO mock2_project_assets
      (project_id, kind, name, body, tag, pinned, created_by, created_at, updated_at)
    VALUES (?, 'content', ?, ?, ?, 0, ?, ?, ?)
  `).run(
    Number(projectId), check.name, check.body, normalizeTag(tag, 'content'),
    createdBy ? String(createdBy) : null, ts, ts,
  );
  return { ok: true, asset: getAsset(projectId, info.lastInsertRowid) };
}

// updateAsset — name, caption/body, tag and pin. The kind and the bytes are
// immutable: changing either means a different asset, so re-upload instead.
export function updateAsset({ projectId, id, name, body, tag, pinned }) {
  const row = getAssetRow(projectId, id);
  if (!row) return { ok: false, code: 'NOT_FOUND', message: 'Asset not found.' };

  const next = {
    name: name === undefined ? row.name : sanitizeName(name, row.name || 'asset'),
    body: body === undefined ? row.body : String(body || ''),
    tag: tag === undefined ? row.tag : normalizeTag(tag, row.kind),
    pinned: pinned === undefined ? row.pinned : (pinned ? 1 : 0),
  };
  if (row.kind === 'content') {
    const check = validateContent({ name: next.name, body: next.body });
    if (!check.ok) return { ok: false, ...check.error };
    next.body = check.body;
    next.name = check.name;
  } else {
    next.body = next.body.slice(0, 2000);   // caption
  }
  getMock2Db().prepare(`
    UPDATE mock2_project_assets SET name = ?, body = ?, tag = ?, pinned = ?, updated_at = ?
    WHERE project_id = ? AND id = ?
  `).run(next.name, next.body, next.tag, next.pinned, nowIso(), Number(projectId), Number(id));
  return { ok: true, asset: getAsset(projectId, id) };
}

export function removeAsset(projectId, id) {
  const row = getAssetRow(projectId, id);
  if (!row) return { ok: false, code: 'NOT_FOUND', message: 'Asset not found.' };
  if (row.kind === 'image' && row.stored_as) {
    try {
      const dir = projectDir(projectId);
      const full = path.join(dir, path.basename(String(row.stored_as)));
      if (full.startsWith(dir)) fs.unlinkSync(full);
    } catch { /* blob already gone — still drop the row */ }
  }
  getMock2Db().prepare('DELETE FROM mock2_project_assets WHERE project_id = ? AND id = ?')
    .run(Number(projectId), Number(id));
  return { ok: true, asset: toAsset(row) };
}

// Called when a project is deleted, so an asset directory does not outlive it.
export function removeProjectAssets(projectId) {
  try { fs.rmSync(projectDir(projectId), { recursive: true, force: true }); } catch { /* nothing to remove */ }
  try {
    getMock2Db().prepare('DELETE FROM mock2_project_assets WHERE project_id = ?').run(Number(projectId));
  } catch { /* pre-migration */ }
}

export { ASSET_MIMES };
