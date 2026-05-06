// Backups feature — PR 1 foundation.
//
// Phase 1 mounts the Storage tab's API surface only:
//   GET    /api/backups/storage          list destinations
//   POST   /api/backups/storage          create a destination
//   PUT    /api/backups/storage/:id      update a destination
//   DELETE /api/backups/storage/:id      remove a destination
//   POST   /api/backups/storage/:id/test connect + HEAD bucket
//   POST   /api/backups/storage/:id/default mark this row default
//
// The on-demand backup creation routes (POST /api/backups,
// GET /api/backups, ...) land in a follow-up commit on this same
// branch so each piece is reviewable in isolation.
//
// Conventions inherited from the existing route modules:
//   * requireAdmin gates reads; requireAdmin + requireSudo gates
//     mutations (the DELETE/PUT/POST chain).
//   * zod parses + 400s on bad input.
//   * All mutations write a logAudit row with the full diff.
//   * Plaintext secret_key is encrypted via lib/secrets before it
//     touches the DB; it never leaves the route handler in the
//     clear.

import { Router } from 'express';
import { z } from 'zod';
import { v4 as uuid } from 'uuid';
import { getDb, logAudit } from '../db.js';
import { requireAdmin, requireSudo } from '../middleware/auth.js';
import { encryptSecret } from '../lib/secrets.js';
import { testConnection } from '../lib/s3.js';

export const backupsRouter = Router();

// Outbound-shape helper. Strips secret_key_enc and any other
// not-for-the-frontend column. is_default / use_ssl / path_style
// are exposed as plain booleans (the DB stores 0/1 INTEGERs).
function publicShape(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    endpoint_url: row.endpoint_url,
    bucket: row.bucket,
    region: row.region || null,
    path_prefix: row.path_prefix || null,
    access_key_id: row.access_key_id,
    use_ssl: !!row.use_ssl,
    path_style: !!row.path_style,
    storage_class: row.storage_class || null,
    is_default: !!row.is_default,
    test_status: row.test_status || null,
    test_at: row.test_at || null,
    created_at: row.created_at,
  };
}

// ── shared validators ───────────────────────────────────────────────
//
// endpoint_url must be an absolute http(s) URL. region is optional
// but, if present, must look like an S3-style region (we allow the
// loose "any printable ASCII" form rather than a strict allowlist —
// MinIO operators routinely use synthetic regions like "minio").
// path_prefix is optional; a trailing slash is normalised away on
// write so the joined object key never double-slashes.

const httpsUrl = z.string().min(1).max(2048).regex(
  /^https?:\/\/[^\s]+$/i,
  'endpoint_url must be a valid http(s) URL'
);
const safeName = z.string().min(1).max(64).regex(
  /^[A-Za-z0-9 ._-]+$/,
  'name must be 1-64 chars: letters, digits, space, dot, underscore, hyphen'
);
const bucketName = z.string().min(3).max(63).regex(
  /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/,
  'bucket must be 3-63 lowercase chars (S3 naming rules)'
);

const createSchema = z.object({
  name: safeName,
  endpoint_url: httpsUrl,
  bucket: bucketName,
  region: z.string().min(1).max(64).optional().nullable(),
  path_prefix: z.string().max(512).optional().nullable(),
  access_key_id: z.string().min(1).max(256),
  secret_key: z.string().min(1).max(512),
  use_ssl: z.boolean().optional(),
  path_style: z.boolean().optional(),
  storage_class: z.string().min(1).max(64).optional().nullable(),
  is_default: z.boolean().optional(),
}).strict();

// PUT body — every field optional; callers can send a partial
// patch. secret_key is intentionally optional on update so the UI
// can edit non-credential fields without forcing the operator to
// re-enter the secret.
const updateSchema = createSchema.partial().strict().refine(
  (obj) => Object.keys(obj).length > 0,
  { message: 'PUT body must not be empty' }
);

function normalizePathPrefix(p) {
  if (p == null) return null;
  const trimmed = String(p).replace(/^\/+/, '').replace(/\/+$/, '');
  return trimmed || null;
}

function readDest(id) {
  return getDb().prepare(
    `SELECT * FROM backup_destinations WHERE id = ?`
  ).get(id);
}

function readDestByName(name) {
  return getDb().prepare(
    `SELECT * FROM backup_destinations WHERE name = ?`
  ).get(name);
}

// "At most one default" enforced at the route layer: when we set
// is_default = 1 on row X, clear it on every other row inside the
// same transaction so the table never observes two defaults
// simultaneously.
function markAsDefault(id) {
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare(`UPDATE backup_destinations SET is_default = 0 WHERE id <> ?`).run(id);
    db.prepare(`UPDATE backup_destinations SET is_default = 1 WHERE id = ?`).run(id);
  });
  tx();
}

// ── routes ──────────────────────────────────────────────────────────

// GET /api/backups/storage — list destinations.
backupsRouter.get('/storage', requireAdmin, (_req, res) => {
  const rows = getDb().prepare(
    `SELECT * FROM backup_destinations ORDER BY is_default DESC, name ASC`
  ).all();
  res.json({ destinations: rows.map(publicShape) });
});

// POST /api/backups/storage — create.
backupsRouter.post('/storage', requireAdmin, requireSudo, (req, res) => {
  let body;
  try {
    body = createSchema.parse(req.body || {});
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  if (readDestByName(body.name)) {
    return res.status(409).json({ error: `destination "${body.name}" already exists` });
  }

  const id = uuid();
  const useSsl = body.use_ssl === false ? 0 : 1; // default ON
  const pathStyle = body.path_style ? 1 : 0;
  const wantsDefault = !!body.is_default;
  const db = getDb();

  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO backup_destinations (
        id, name, endpoint_url, bucket, region, path_prefix,
        access_key_id, secret_key_enc, use_ssl, path_style,
        storage_class, is_default
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).run(
      id,
      body.name,
      body.endpoint_url,
      body.bucket,
      body.region || null,
      normalizePathPrefix(body.path_prefix),
      body.access_key_id,
      encryptSecret(body.secret_key),
      useSsl,
      pathStyle,
      body.storage_class || null,
    );
    if (wantsDefault) {
      // Reuse markAsDefault so the "exactly one default" invariant
      // is enforced even when the operator marks the very-first row
      // default at create time.
      db.prepare(`UPDATE backup_destinations SET is_default = 0 WHERE id <> ?`).run(id);
      db.prepare(`UPDATE backup_destinations SET is_default = 1 WHERE id = ?`).run(id);
    }
  });
  tx();

  logAudit(req.user.id, 'BACKUP_DESTINATION_CREATE', 'backup_destination', id, {
    name: body.name,
    endpoint_url: body.endpoint_url,
    bucket: body.bucket,
    region: body.region || null,
    is_default: wantsDefault,
  }, req.ip);

  res.status(201).json({ destination: publicShape(readDest(id)) });
});

// PUT /api/backups/storage/:id — partial update. secret_key omitted
// means "keep what's stored"; sending an empty string is rejected
// because that would leak past the zod min(1) into a confusing
// "secret got cleared" state.
backupsRouter.put('/storage/:id', requireAdmin, requireSudo, (req, res) => {
  const existing = readDest(req.params.id);
  if (!existing) return res.status(404).json({ error: 'destination not found' });

  let body;
  try {
    body = updateSchema.parse(req.body || {});
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  if (body.name && body.name !== existing.name) {
    const conflict = readDestByName(body.name);
    if (conflict && conflict.id !== existing.id) {
      return res.status(409).json({ error: `destination "${body.name}" already exists` });
    }
  }

  const before = publicShape(existing);
  const updates = [];
  const args = [];
  function set(col, val) { updates.push(`${col} = ?`); args.push(val); }

  if (body.name        !== undefined) set('name', body.name);
  if (body.endpoint_url!== undefined) set('endpoint_url', body.endpoint_url);
  if (body.bucket      !== undefined) set('bucket', body.bucket);
  if (body.region      !== undefined) set('region', body.region || null);
  if (body.path_prefix !== undefined) set('path_prefix', normalizePathPrefix(body.path_prefix));
  if (body.access_key_id !== undefined) set('access_key_id', body.access_key_id);
  if (body.secret_key  !== undefined) set('secret_key_enc', encryptSecret(body.secret_key));
  if (body.use_ssl     !== undefined) set('use_ssl', body.use_ssl ? 1 : 0);
  if (body.path_style  !== undefined) set('path_style', body.path_style ? 1 : 0);
  if (body.storage_class !== undefined) set('storage_class', body.storage_class || null);

  // Any field-level edit invalidates the prior "test_status" verdict
  // because the credentials / endpoint may have changed under the
  // last verdict's feet. Operators must re-test after any edit.
  if (updates.length > 0) {
    set('test_status', null);
    set('test_at', null);
    args.push(existing.id);
    getDb().prepare(
      `UPDATE backup_destinations SET ${updates.join(', ')} WHERE id = ?`
    ).run(...args);
  }

  if (body.is_default === true) {
    markAsDefault(existing.id);
  } else if (body.is_default === false && existing.is_default) {
    getDb().prepare(`UPDATE backup_destinations SET is_default = 0 WHERE id = ?`).run(existing.id);
  }

  const after = publicShape(readDest(existing.id));
  logAudit(req.user.id, 'BACKUP_DESTINATION_UPDATE', 'backup_destination', existing.id, {
    before, after,
    fields_changed: Object.keys(body).filter((k) => k !== 'secret_key'),
    secret_rotated: body.secret_key !== undefined,
  }, req.ip);

  res.json({ destination: after });
});

// DELETE /api/backups/storage/:id — remove. PR 2 will reject when a
// backup_schedule row references this destination; for now there's
// no schedules table yet, so the delete is unconditional.
backupsRouter.delete('/storage/:id', requireAdmin, requireSudo, (req, res) => {
  const existing = readDest(req.params.id);
  if (!existing) return res.status(404).json({ error: 'destination not found' });

  getDb().prepare(`DELETE FROM backup_destinations WHERE id = ?`).run(existing.id);

  logAudit(req.user.id, 'BACKUP_DESTINATION_DELETE', 'backup_destination', existing.id, {
    name: existing.name,
    bucket: existing.bucket,
  }, req.ip);

  res.json({ ok: true });
});

// POST /api/backups/storage/:id/test — issue a HEAD bucket. The S3
// helper resolves rather than throws on failure so the verdict is
// always written into test_status.
backupsRouter.post('/storage/:id/test', requireAdmin, requireSudo, async (req, res) => {
  const existing = readDest(req.params.id);
  if (!existing) return res.status(404).json({ error: 'destination not found' });

  const verdict = await testConnection(existing);
  const status = verdict.ok ? 'ok' : `error: ${verdict.error || 'unknown'}`;
  const ts = new Date().toISOString();
  getDb().prepare(
    `UPDATE backup_destinations SET test_status = ?, test_at = ? WHERE id = ?`
  ).run(status, ts, existing.id);

  logAudit(req.user.id, 'BACKUP_DESTINATION_TEST', 'backup_destination', existing.id, {
    ok: verdict.ok,
    latency_ms: verdict.latency_ms,
    error: verdict.error || null,
  }, req.ip);

  res.json({
    ok: verdict.ok,
    latency_ms: verdict.latency_ms,
    error: verdict.error || null,
    test_status: status,
    test_at: ts,
  });
});

// POST /api/backups/storage/:id/default — mark this destination as
// the one new schedules / on-demand backups will target.
backupsRouter.post('/storage/:id/default', requireAdmin, requireSudo, (req, res) => {
  const existing = readDest(req.params.id);
  if (!existing) return res.status(404).json({ error: 'destination not found' });

  markAsDefault(existing.id);

  logAudit(req.user.id, 'BACKUP_DESTINATION_SET_DEFAULT', 'backup_destination', existing.id, {
    name: existing.name,
  }, req.ip);

  res.json({ destination: publicShape(readDest(existing.id)) });
});
