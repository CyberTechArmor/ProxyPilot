'use strict';
// Dependency-free file storage for credentialing documents.
// Files are uploaded as a raw binary body (Content-Type = the file's MIME,
// original name in the X-Filename header), stored on disk under data/uploads/
// with a random name, and indexed in the JSON store under `files`.
const fs = require('fs');
const path = require('path');
const store = require('./store');
const { uuid } = require('./util');

const DATA_DIR = process.env.APP_DATA_DIR || path.join(__dirname, '..', 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const MAX_BYTES = +(process.env.MAX_UPLOAD_BYTES || 25 * 1024 * 1024); // 25 MB

// Allowlist: extension -> canonical MIME. Only these types can be stored/served,
// and they are served with a fixed Content-Type (never sniffed) to avoid stored
// XSS. HTML/SVG are intentionally excluded (script-bearing).
const ALLOWED = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
};
// Types that browsers can render inline safely; everything else is served as a
// download (Office docs are opened via the Office Online viewer instead).
const INLINE = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'text/plain; charset=utf-8', 'text/csv; charset=utf-8']);
const OFFICE_EXT = new Set(['.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx']);

function ensureDir() { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); }
function index() { const db = store.get(); if (!Array.isArray(db.files)) db.files = []; return db.files; }

// Keep only a clean base name for display; never used as a filesystem path.
function sanitizeName(name) {
  const base = path.basename(String(name || 'document')).replace(/[\u0000-\u001f\u007f]/g, '').replace(/[\\/:*?"<>|]/g, '_').trim();
  return base.slice(0, 200) || 'document';
}

function extFor(name, mime) {
  let ext = path.extname(String(name || '')).toLowerCase();
  if (ALLOWED[ext]) return ext;
  // fall back to matching by declared MIME
  const byMime = Object.keys(ALLOWED).find(e => ALLOWED[e] === String(mime).toLowerCase());
  return byMime || '';
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BYTES) { reject(Object.assign(new Error('PAYLOAD_TOO_LARGE'), { code: 'TOO_LARGE' })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function toRecord(rec) {
  return { id: rec.id, name: rec.name, mime: rec.mime, size: rec.size, ext: rec.ext, url: '/api/files/' + rec.id, inline: INLINE.has(rec.mime), office: OFFICE_EXT.has(rec.ext), docKey: rec.docKey || null, status: rec.status || 'pending', note: rec.note || '', expiresAt: rec.expiresAt || null, ownerId: rec.ownerId || null, createdAt: rec.createdAt };
}

const REVIEW_STATUS = new Set(['pending', 'approved', 'attention']);

// Save an uploaded raw body. `filename` from X-Filename, `mime` from Content-Type.
async function save(req, { filename, mime, ownerId, docKey }) {
  const name = sanitizeName(filename);
  const ext = extFor(name, mime);
  if (!ext || !ALLOWED[ext]) { const e = new Error('UNSUPPORTED_TYPE'); e.code = 'UNSUPPORTED_TYPE'; throw e; }
  const body = await readRawBody(req);
  if (!body.length) { const e = new Error('EMPTY'); e.code = 'EMPTY'; throw e; }
  ensureDir();
  const id = uuid();
  const storedAs = id + ext;
  fs.writeFileSync(path.join(UPLOAD_DIR, storedAs), body);
  const rec = { id, name: name.endsWith(ext) ? name : name + ext, mime: ALLOWED[ext], size: body.length, ext, storedAs, ownerId: ownerId || null, docKey: docKey ? String(docKey).slice(0, 64) : null, status: 'pending', note: '', createdAt: new Date().toISOString() };
  index().push(rec);
  store.save();
  return toRecord(rec);
}

function get(id) { return index().find(f => f.id === id) || null; }

function readBuffer(id) {
  const rec = get(id);
  if (!rec) return null;
  const full = path.join(UPLOAD_DIR, rec.storedAs);
  if (!full.startsWith(UPLOAD_DIR)) return null;
  try { return fs.readFileSync(full); } catch (_) { return null; }
}

// Permanently delete a stored file: remove the blob from disk and its index row.
function remove(id) {
  const list = index();
  const idx = list.findIndex(f => f.id === id);
  if (idx === -1) return null;
  const rec = list[idx];
  try {
    const full = path.join(UPLOAD_DIR, rec.storedAs);
    if (full.startsWith(UPLOAD_DIR)) fs.unlinkSync(full);
  } catch (e) { /* blob already gone — still drop the index row */ }
  list.splice(idx, 1);
  store.save();
  return toRecord(rec);
}

// All files uploaded by a given user, newest first.
function listByOwner(ownerId) {
  return index().filter(f => f.ownerId === ownerId).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).map(toRecord);
}

// Update the review outcome for a document (credentialing team action).
function setReview(id, { status, note, expiresAt }) {
  const rec = get(id);
  if (!rec) return null;
  if (status != null) { if (!REVIEW_STATUS.has(status)) { const e = new Error('BAD_STATUS'); e.code = 'BAD_STATUS'; throw e; } rec.status = status; }
  if (note != null) rec.note = String(note).slice(0, 2000);
  if (expiresAt !== undefined) rec.expiresAt = expiresAt ? String(expiresAt).slice(0, 40) : null;
  store.save();
  return toRecord(rec);
}

// Stream a stored file to the response with safe headers.
function stream(res, id, { download, forceInline } = {}) {
  const rec = get(id);
  if (!rec) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
  const full = path.join(UPLOAD_DIR, rec.storedAs);
  // Guard against any traversal via a tampered index entry.
  if (!full.startsWith(UPLOAD_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.stat(full, (err, st) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    const disposition = forceInline ? 'inline' : ((download || !INLINE.has(rec.mime)) ? 'attachment' : 'inline');
    res.writeHead(200, {
      'Content-Type': rec.mime,
      'Content-Length': st.size,
      'Content-Disposition': `${disposition}; filename="${rec.name.replace(/"/g, '')}"`,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cache-Control': 'private, max-age=0, must-revalidate'
    });
    fs.createReadStream(full).pipe(res);
  });
}

module.exports = { save, get, readBuffer, remove, listByOwner, setReview, stream, toRecord, ALLOWED, OFFICE_EXT, MAX_BYTES, UPLOAD_DIR };
