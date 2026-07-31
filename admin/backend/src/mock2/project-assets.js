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
  validateImageUpload, validateContent, ASSET_MIMES, extFor, selectMockupImages,
  validateDocumentUpload, docAssetPath,
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
  if (!row || (row.kind !== 'image' && row.kind !== 'document') || !row.stored_as) return null;
  const dir = projectDir(projectId);
  const full = path.join(dir, path.basename(String(row.stored_as)));
  return full.startsWith(dir) ? full : null;
}

// readAssetText — a document asset's full content as UTF-8, or null. Used
// by the summary pass and by materialization; prompts get only the stored
// summary (row.body).
export function readAssetText(projectId, id) {
  try {
    const row = getAssetRow(projectId, id);
    if (!row || row.kind !== 'document') return null;
    const full = assetFilePath(projectId, id);
    if (!full || !fs.existsSync(full)) return null;
    return fs.readFileSync(full, 'utf-8');
  } catch { return null; }
}

// readAssetImage — an image asset as a model-ready block, or null.
//
// Same shape hydrateAttachments produces for chat images ({ media_type, data }),
// so a caller can concatenate the two lists and hand them straight to a turn.
// The mime comes from the stored row (which derived it from the EXTENSION at
// upload, never the client's declared type), so a mislabelled upload cannot be
// presented to the model as something it is not.
export function readAssetImage(projectId, id) {
  try {
    const row = getAssetRow(projectId, id);
    if (!row || row.kind !== 'image') return null;
    const file = assetFilePath(projectId, id);
    if (!file) return null;
    const buffer = fs.readFileSync(file);
    if (!buffer?.length) return null;
    return { media_type: row.mime || ASSET_MIMES[extFor(row.name)] || 'image/png', data: buffer.toString('base64') };
  } catch { return null; }
}

// hydrateMockupAssetImages — the ranked selection above, read off disk.
// Returns { images, used } so the caller can NAME the pictures it attached;
// an image block the model cannot identify is just a picture.
export function hydrateMockupAssetImages(projectId, assets, opts = {}) {
  const picked = selectMockupImages(assets, opts);
  const images = [];
  const used = [];
  for (const a of picked) {
    const img = readAssetImage(projectId, a.id);
    if (!img) continue;              // row without bytes — skip, never throw
    images.push(img);
    used.push({ name: a.name, tag: a.tag });
  }
  return { images, used };
}

// findAssetByBytes — is this exact image already in the library?
//
// Content identity, not filename: an operator pasting the same reference
// screenshot into the design chat on three turns means it three times, and
// three copies of one picture would push the render's image budget onto
// duplicates of the same thing.
//
// Size is the pre-filter (a column, free) and sha256 is the answer, so a
// library of twenty images hashes at most the handful that are the same length.
export function findAssetByBytes(projectId, buffer) {
  if (!buffer?.length) return null;
  const want = crypto.createHash('sha256').update(buffer).digest('hex');
  let rows = [];
  try {
    rows = getMock2Db()
      .prepare("SELECT * FROM mock2_project_assets WHERE project_id = ? AND kind = 'image' AND size = ?")
      .all(Number(projectId), buffer.length);
  } catch { return null; }
  for (const r of rows) {
    try {
      const file = assetFilePath(projectId, r.id);
      if (!file) continue;
      if (crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') === want) return toAsset(r);
    } catch { /* a row whose bytes are gone is not a match */ }
  }
  return null;
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

// addDocument — an uploaded reference file (or one text file out of a zip).
// Bytes on disk like images; `body` starts as the caller-provided summary
// (usually null — the summary pass fills it in asynchronously). `name` may
// carry archive path separators; it is display + materialization key, never
// a filesystem path here (stored name is a uuid).
export function addDocument({ projectId, name, buffer, tag = null, summary = null, createdBy = null }) {
  const clean = String(name || '').includes('/') ? docAssetPath(name) : sanitizeName(name, 'document.txt');
  const check = validateDocumentUpload({ name: clean, buffer });
  if (!check.ok) return { ok: false, code: check.error };

  const dir = projectDir(projectId);
  fs.mkdirSync(dir, { recursive: true });
  const rawExt = extFor(clean);
  const ext = /^\.[a-z0-9]{1,10}$/.test(rawExt) ? rawExt : '.txt';
  const storedAs = `${crypto.randomUUID()}${ext}`;
  fs.writeFileSync(path.join(dir, storedAs), buffer);

  const ts = nowIso();
  const info = getMock2Db().prepare(`
    INSERT INTO mock2_project_assets
      (project_id, kind, name, body, mime, size, stored_as, tag, pinned, created_by, created_at, updated_at)
    VALUES (?, 'document', ?, ?, 'text/plain', ?, ?, ?, 0, ?, ?, ?)
  `).run(
    Number(projectId), clean, summary == null ? null : String(summary).slice(0, 20000),
    buffer.length, storedAs, normalizeTag(tag, 'document'),
    createdBy ? String(createdBy) : null, ts, ts,
  );
  return { ok: true, asset: getAsset(projectId, info.lastInsertRowid) };
}

// setDocumentSummary — the async summary pass writes its result here.
export function setDocumentSummary(projectId, id, summary) {
  try {
    getMock2Db()
      .prepare(`UPDATE mock2_project_assets SET body = ?, updated_at = ? WHERE project_id = ? AND id = ? AND kind = 'document'`)
      .run(String(summary || '').slice(0, 20000), nowIso(), Number(projectId), Number(id));
    return true;
  } catch { return false; }
}

// materializeDocAssetsToDir — copy every document asset's full content into
// <dir>/state/assets/<docAssetPath(name)> so the build harness can read it
// with its normal file tools (the prompt only ever carries the summary +
// this path). Best-effort per file; returns { written, bytes }.
export function materializeDocAssetsToDir(dir, assets) {
  const rootDir = path.resolve(path.join(dir, 'state', 'assets'));
  let written = 0; let bytes = 0;
  for (const a of assets || []) {
    if (a.kind !== 'document') continue;
    try {
      const content = readAssetText(a.projectId ?? a.project_id, a.id);
      if (content == null) continue;
      const rel = docAssetPath(a.name);
      const dest = path.resolve(path.join(rootDir, rel));
      if (dest !== rootDir && !dest.startsWith(rootDir + path.sep)) continue; // defense in depth
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, content);
      written++; bytes += Buffer.byteLength(content);
    } catch { /* per-file best effort */ }
  }
  return { written, bytes };
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
  } else if (row.kind === 'document') {
    next.body = next.body.slice(0, 20000);  // summary/index
    // Archive-path names keep their separators (sanitizeName strips to the
    // basename, which would collapse a website export's structure).
    next.name = name === undefined ? row.name : docAssetPath(name);
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
  if (row.stored_as) { // images AND documents keep bytes on disk
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
