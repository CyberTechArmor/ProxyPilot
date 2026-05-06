// Backups feature — full route surface (PR 1 + PR 2).
//
//   Storage destinations:
//     GET    /api/backups/storage
//     POST   /api/backups/storage           (sudo)
//     PUT    /api/backups/storage/:id       (sudo)
//     DELETE /api/backups/storage/:id       (sudo)
//     POST   /api/backups/storage/:id/test  (sudo)  HEAD bucket
//     POST   /api/backups/storage/:id/default (sudo)
//
//   Backup artifacts (on-demand):
//     POST   /api/backups                   (sudo)  create at any tier
//     GET    /api/backups
//     GET    /api/backups/:id               manifest + metadata
//     GET    /api/backups/:id/download      stream from S3
//     DELETE /api/backups/:id               (sudo)
//
//   Schedules (PR 2):
//     GET    /api/backups/schedules
//     POST   /api/backups/schedules         (sudo)
//     PUT    /api/backups/schedules/:id     (sudo)
//     DELETE /api/backups/schedules/:id     (sudo)
//     POST   /api/backups/schedules/:id/run-now (sudo)
//
//   Restore (PR 2):
//     POST   /api/backups/:id/restore       (sudo)  → run_id
//     GET    /api/backups/restores
//     GET    /api/backups/restores/:id      live state machine
//
//   Usage + helpers:
//     GET    /api/backups/usage             per-destination + tier
//                                           breakdown
//     GET    /api/backups/health-classes    declarative table for
//                                           Mode A's per-service
//                                           checks
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
import path from 'node:path';
import { z } from 'zod';
import { v4 as uuid } from 'uuid';
import { getDb, logAudit } from '../db.js';
import { requireAdmin, requireSudo } from '../middleware/auth.js';
import { encryptSecret } from '../lib/secrets.js';
import {
  testConnection, putObject, getObjectStream, deleteObject, buildKey,
} from '../lib/s3.js';
import {
  packConfigTier, packConfigPlusDataTier, packFullTier,
} from '../lib/backup-pack.js';
import {
  writeLocal, deleteLocal, localPathFor, openLocalReadStream, localDiskUsage,
} from '../lib/backup-local-store.js';
import fs from 'node:fs';
import {
  register as schedulerRegister,
  unregister as schedulerUnregister,
  enqueue as schedulerEnqueue,
  isValidCronExpr,
  computeNextRunMs,
} from '../lib/backup-scheduler.js';
import { runModeA, runModeC } from '../lib/restore.js';
import { listHealthClasses } from '../lib/health-checks.js';

const INSTALL_DIR = process.env.PROXYPILOT_INSTALL_DIR || '/opt/proxypilot';
const ENV_PATH = process.env.PROXYPILOT_ENV_PATH || path.join(INSTALL_DIR, '.env');
const CVE_INBOX_DIR = process.env.PROXYPILOT_CVE_INBOX_DIR || '/var/lib/proxypilot/cve-inbox';

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

// ── Backup artifacts ────────────────────────────────────────────────
//
// PR 1 ships create / list / show / download / delete on the
// `backups` table.  Tier is config-only in this round; PR 2 adds
// 'config_plus_data' and 'full' along with restore + scheduling.
//
// The create route packs the current host state into an encrypted
// .ppbackup using lib/backup-pack, uploads it to the chosen
// destination, and persists a `backups` row with the manifest and
// resolved size.

function publicBackupShape(row) {
  if (!row) return null;
  return {
    id: row.id,
    destination_id: row.destination_id,
    tier: row.tier,
    scope: row.scope || null,
    s3_key: row.s3_key,
    size_bytes: row.size_bytes,
    encrypted: !!row.encrypted,
    created_by: row.created_by || null,
    created_at: row.created_at,
    parent_backup: row.parent_backup || null,
    status: row.status,
    error: row.error || null,
    // local-first columns from migration 203.  local_path is
    // surfaced as a boolean flag (the actual filesystem path is
    // operator-irrelevant for the UI); s3_uploaded reports
    // whether a copy made it to the configured destination.
    has_local: !!row.local_path,
    s3_uploaded: !!row.s3_uploaded,
    // manifest_json is parsed lazily — surfaced as `manifest` on
    // GET /:id so list pages don't pay the parse cost N times.
  };
}

const createBackupSchema = z.object({
  // PR 1 only supports the config tier.  PR 2 adds the others; the
  // schema lists them now so a forward-compatible client can pin
  // its expectations without us having to change the wire shape.
  tier: z.enum(['config', 'config_plus_data', 'full']).optional().default('config'),
  scope: z.string().min(1).max(256).optional().nullable(),
  destination_id: z.string().min(1).max(64).optional().nullable(),
  passphrase: z.string().min(8).max(1024),
}).strict();

function pickDestination(db, destinationId) {
  if (destinationId) {
    return db.prepare(`SELECT * FROM backup_destinations WHERE id = ?`).get(destinationId);
  }
  return db.prepare(
    `SELECT * FROM backup_destinations WHERE is_default = 1 LIMIT 1`
  ).get();
}

function readBackup(id) {
  return getDb().prepare(`SELECT * FROM backups WHERE id = ?`).get(id);
}

// GET /api/backups — list, newest first.  Joined to
// backup_destinations so the row carries the destination name
// alongside the id (the UI's delete dialog uses it directly so
// the operator sees 'Remove the copy in S3 (RustFS)' rather
// than 'Remove the copy in S3 (<uuid>)').
backupsRouter.get('/', requireAdmin, (_req, res) => {
  const rows = getDb().prepare(`
    SELECT b.*, d.name AS destination_name
    FROM backups b
    LEFT JOIN backup_destinations d ON d.id = b.destination_id
    ORDER BY b.created_at DESC, b.id DESC
  `).all();
  res.json({
    backups: rows.map((r) => ({
      ...publicBackupShape(r),
      destination_name: r.destination_name || null,
    })),
  });
});

// GET /api/backups/:id — single row, with manifest expanded.
//
// Registered LATE — after all static-named routes (/schedules,
// /restores, /usage, /health-classes) so they don't get matched
// as :id values.  Express routes are tried in order; a leading
// `/:id` with no prefix would swallow every single-segment GET
// under this router.  The handler itself is up here for code
// locality with the other backup-row CRUD; the actual mounting
// happens at the very bottom of the file.
function getBackupHandler(req, res) {
  const row = readBackup(req.params.id);
  if (!row) return res.status(404).json({ error: 'backup not found' });
  let manifest = null;
  try { manifest = JSON.parse(row.manifest_json || '{}'); } catch { manifest = null; }
  res.json({ backup: { ...publicBackupShape(row), manifest } });
}

// POST /api/backups — create on-demand.  Sudo-gated; the operator
// types a passphrase that is used once for KDF + AES-GCM and never
// persisted anywhere in our state (not in the audit log, not in the
// row, not in the manifest).
backupsRouter.post('/', requireAdmin, requireSudo, async (req, res) => {
  let body;
  try {
    body = createBackupSchema.parse(req.body || {});
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  // PR 2 supports all three tiers: config, config_plus_data, full.
  // The packer chosen below is keyed off body.tier; an unknown tier
  // surfaces as a 400 from the zod enum, not silently as a default.

  const db = getDb();
  // Local-first: a missing destination is no longer fatal.  If
  // body.destination_id was supplied but doesn't exist, that's
  // still an operator typo → 404.  Otherwise we proceed local-only
  // (destination = null).  S3 push happens only when destination
  // is non-null AND succeeds.
  let destination = null;
  if (body.destination_id) {
    destination = pickDestination(db, body.destination_id);
    if (!destination) {
      return res.status(404).json({ error: 'destination not found' });
    }
  } else {
    // Use the configured default if one exists; otherwise local-
    // only.  pickDestination(null, null) returns the is_default=1
    // row when present.
    destination = pickDestination(db, null);
  }

  const id = uuid();
  const objectName = `${id}.ppbackup`;
  // s3Key is computed for the row even when there's no destination
  // configured — keeps the column NOT NULL friendly and makes a
  // future upload retry trivial.  Empty string when no destination.
  const s3Key = destination ? buildKey(destination, objectName) : '';

  // Insert the row in 'in_progress' state so the GET list reflects
  // an in-flight backup; the column flips happen after each stage:
  //   pack ok       → size_bytes + manifest_json populated
  //   local write   → local_path populated
  //   S3 upload     → s3_uploaded flipped to 1 (when applicable)
  //   final         → status flipped to 'ok' or 'failed'
  db.prepare(`
    INSERT INTO backups (id, destination_id, tier, scope, s3_key, encrypted,
                        created_by, manifest_json, status, s3_uploaded)
    VALUES (?, ?, ?, ?, ?, 1, ?, '{}', 'in_progress', 0)
  `).run(
    id,
    destination ? destination.id : null,
    body.tier,
    body.scope || null,
    s3Key,
    req.user?.id || null,
  );

  let packed;
  try {
    const sharedMeta = {
      scope: body.scope || 'all',
      backup_id: id,
      destination_name: destination ? destination.name : '(local-only)',
    };
    if (body.tier === 'config') {
      packed = await packConfigTier({
        db,
        passphrase: body.passphrase,
        envPath: ENV_PATH,
        cveInboxDir: CVE_INBOX_DIR,
        meta: sharedMeta,
      });
    } else if (body.tier === 'config_plus_data') {
      packed = await packConfigPlusDataTier({
        db,
        passphrase: body.passphrase,
        envPath: ENV_PATH,
        cveInboxDir: CVE_INBOX_DIR,
        installDir: INSTALL_DIR,
        meta: sharedMeta,
      });
    } else {
      // 'full'
      packed = await packFullTier({
        db,
        passphrase: body.passphrase,
        envPath: ENV_PATH,
        cveInboxDir: CVE_INBOX_DIR,
        installDir: INSTALL_DIR,
        meta: sharedMeta,
      });
    }
  } catch (err) {
    db.prepare(`UPDATE backups SET status = 'failed', error = ? WHERE id = ?`)
      .run(`pack failed: ${err?.message || err}`, id);
    logAudit(req.user.id, 'BACKUP_CREATE_FAILED', 'backup', id, {
      stage: 'pack', error: err?.message || String(err),
      destination_id: destination ? destination.id : null, tier: body.tier,
    }, req.ip);
    return res.status(500).json({ error: `pack failed: ${err?.message || err}` });
  }

  // Local first.  Always.  This is the canonical copy from the
  // dashboard's POV; restore + download read from local before
  // touching S3 so a freshly-created backup is restore-testable
  // without a network round-trip.
  let localPath;
  try {
    localPath = writeLocal(id, packed.buffer);
  } catch (err) {
    db.prepare(`UPDATE backups SET status = 'failed', error = ? WHERE id = ?`)
      .run(`local write failed: ${err?.message || err}`, id);
    logAudit(req.user.id, 'BACKUP_CREATE_FAILED', 'backup', id, {
      stage: 'local-write', error: err?.message || String(err),
    }, req.ip);
    return res.status(500).json({ error: `local write failed: ${err?.message || err}` });
  }
  db.prepare(`UPDATE backups SET local_path = ?, size_bytes = ?, manifest_json = ? WHERE id = ?`)
    .run(localPath, packed.buffer.length, JSON.stringify(packed.manifest), id);

  // Optional S3 upload.  Best-effort: a failed upload doesn't
  // fail the whole create — the local copy is the canonical
  // artifact, the operator can retry the S3 push later (PR
  // follow-up).  status flips to 'ok' regardless of S3 outcome
  // so the row is restorable from local right away.
  let s3Error = null;
  if (destination) {
    try {
      await putObject(destination, s3Key, packed.buffer, {
        contentType: 'application/octet-stream',
      });
      db.prepare(`UPDATE backups SET s3_uploaded = 1 WHERE id = ?`).run(id);
    } catch (err) {
      s3Error = err?.message || String(err);
      logAudit(req.user.id, 'BACKUP_S3_UPLOAD_FAILED', 'backup', id, {
        destination_id: destination.id, error: s3Error,
      }, req.ip);
    }
  }

  db.prepare(`UPDATE backups SET status = 'ok', error = ? WHERE id = ?`)
    .run(s3Error ? `S3 upload failed (local copy ok): ${s3Error}` : null, id);

  logAudit(req.user.id, 'BACKUP_CREATE', 'backup', id, {
    destination_id: destination ? destination.id : null,
    destination_name: destination ? destination.name : null,
    s3_key: s3Key || null,
    s3_uploaded: !s3Error && !!destination,
    s3_error: s3Error,
    local_path: localPath,
    tier: body.tier,
    scope: body.scope || null,
    size_bytes: packed.buffer.length,
    file_count: packed.manifest.files.length,
  }, req.ip);

  res.status(201).json({
    backup: { ...publicBackupShape(readBackup(id)), manifest: packed.manifest },
    s3_error: s3Error,
  });
});

// GET /api/backups/:id/download — stream the encrypted artifact to
// the operator's browser.  Local-first: if local_path exists on
// disk we stream from there (instant, no network).  Otherwise fall
// back to S3.  If neither has a copy, 409.
backupsRouter.get('/:id/download', requireAdmin, async (req, res) => {
  const row = readBackup(req.params.id);
  if (!row) return res.status(404).json({ error: 'backup not found' });
  if (row.status !== 'ok') {
    return res.status(409).json({ error: `backup is ${row.status}, not 'ok'` });
  }

  // Try local first.
  if (row.local_path) {
    try {
      const stat = fs.statSync(row.local_path);
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${row.id}.ppbackup"`);
      res.setHeader('Content-Length', String(stat.size));
      res.setHeader('X-PP-Source', 'local');
      logAudit(req.user.id, 'BACKUP_DOWNLOAD', 'backup', row.id, {
        source: 'local', size_bytes: stat.size,
      }, req.ip);
      const stream = openLocalReadStream(row.id);
      stream.on('error', (err) => {
        try { res.destroy(err); } catch { /* ignore */ }
      });
      return stream.pipe(res);
    } catch (err) {
      // Local file is gone (was pruned out from under us, or perms
      // tightened).  Fall through to S3 if available.
      if (err?.code !== 'ENOENT' && !row.s3_uploaded) {
        return res.status(500).json({ error: `local read failed: ${err?.message || err}` });
      }
    }
  }

  // S3 fallback.
  if (!row.s3_uploaded) {
    return res.status(409).json({ error: 'no copy available — local was pruned and S3 upload never succeeded' });
  }
  const dest = getDb().prepare(
    `SELECT * FROM backup_destinations WHERE id = ?`
  ).get(row.destination_id);
  if (!dest) {
    return res.status(409).json({ error: 'destination row missing — backup is orphaned' });
  }
  let obj;
  try {
    obj = await getObjectStream(dest, row.s3_key);
  } catch (err) {
    return res.status(502).json({ error: `S3 download failed: ${err?.message || err}` });
  }
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${row.id}.ppbackup"`);
  if (obj.contentLength) res.setHeader('Content-Length', String(obj.contentLength));
  res.setHeader('X-PP-Source', 's3');
  logAudit(req.user.id, 'BACKUP_DOWNLOAD', 'backup', row.id, {
    source: 's3', s3_key: row.s3_key, size_bytes: obj.contentLength || row.size_bytes,
  }, req.ip);
  obj.stream.on('error', (err) => {
    try { res.destroy(err); } catch { /* ignore */ }
  });
  obj.stream.pipe(res);
});

// DELETE /api/backups/:id — remove the artifact.  Body controls
// what gets removed:
//
//   { delete_local: bool, delete_s3: bool }
//
// Both default to true for back-compat with the PR-1 callers
// that have no body.  When only one copy is removed, the row
// stays so the dashboard keeps tracking the remaining copy.
// When both copies are gone, the row is dropped.
backupsRouter.delete('/:id', requireAdmin, requireSudo, async (req, res) => {
  const row = readBackup(req.params.id);
  if (!row) return res.status(404).json({ error: 'backup not found' });

  const body = req.body || {};
  const wantDeleteLocal = body.delete_local === undefined ? true : !!body.delete_local;
  const wantDeleteS3 = body.delete_s3 === undefined ? true : !!body.delete_s3;

  let s3Error = null;
  let localRemoved = false;
  let s3Removed = false;

  if (wantDeleteLocal && row.local_path) {
    try {
      localRemoved = deleteLocal(row.local_path);
    } catch (err) {
      // A permission error here shouldn't block S3 cleanup; surface
      // it but keep going.
      s3Error = `local delete failed: ${err?.message || err}`;
    }
  }

  if (wantDeleteS3 && row.s3_uploaded) {
    const dest = getDb().prepare(
      `SELECT * FROM backup_destinations WHERE id = ?`
    ).get(row.destination_id);
    if (dest) {
      try {
        await deleteObject(dest, row.s3_key);
        s3Removed = true;
      } catch (err) {
        const code = err?.Code || err?.name || '';
        if (!/NotFound|NoSuchKey/i.test(code)) {
          s3Error = (s3Error ? s3Error + '; ' : '') + (err?.message || String(err));
        } else {
          s3Removed = true; // already gone counts as removed
        }
      }
    }
  }

  // Recompute what's left.  Drop the row only when both copies are
  // gone (locally removed + S3 removed-or-was-never-uploaded).
  const stillLocal = (!wantDeleteLocal && row.local_path) ? true : false;
  const stillS3 = (!wantDeleteS3 && row.s3_uploaded) ? true : (!s3Removed && row.s3_uploaded);

  if (!stillLocal && !stillS3) {
    getDb().prepare(`DELETE FROM backups WHERE id = ?`).run(row.id);
  } else {
    // Partial delete — clear the columns for the copy we removed.
    const updates = [];
    const args = [];
    if (wantDeleteLocal && (localRemoved || row.local_path)) {
      updates.push('local_path = NULL');
    }
    if (wantDeleteS3 && s3Removed) {
      updates.push('s3_uploaded = 0');
    }
    if (updates.length) {
      args.push(row.id);
      getDb().prepare(`UPDATE backups SET ${updates.join(', ')} WHERE id = ?`).run(...args);
    }
  }

  logAudit(req.user.id, 'BACKUP_DELETE', 'backup', row.id, {
    delete_local: wantDeleteLocal,
    delete_s3: wantDeleteS3,
    local_removed: localRemoved,
    s3_removed: s3Removed,
    s3_key: row.s3_key,
    destination_id: row.destination_id,
    s3_error: s3Error,
    row_dropped: !stillLocal && !stillS3,
  }, req.ip);

  res.json({
    ok: true,
    local_removed: localRemoved,
    s3_removed: s3Removed,
    s3_error: s3Error,
    row_dropped: !stillLocal && !stillS3,
  });
});

// ── Schedules ───────────────────────────────────────────────────────
//
// CRUD on backup_schedules.  Mutating routes register / unregister
// the cron task synchronously in the request handler so an operator
// who creates a schedule sees it pick up the next tick — they don't
// have to wait for the next dashboard reboot.

function publicScheduleShape(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    destination_id: row.destination_id,
    cron_expr: row.cron_expr,
    tier: row.tier,
    scope: row.scope || null,
    retention_keep: row.retention_keep,
    retention_days: row.retention_days,
    passphrase_hint: row.passphrase_hint || null,
    enabled: !!row.enabled,
    last_run_at: row.last_run_at || null,
    last_run_status: row.last_run_status || null,
    last_run_error: row.last_run_error || null,
    next_run_at: row.next_run_at || null,
    created_by: row.created_by || null,
    created_at: row.created_at,
  };
}

const scheduleSchema = z.object({
  name: z.string().min(1).max(128),
  destination_id: z.string().min(1).max(64),
  cron_expr: z.string().min(1).max(128),
  tier: z.enum(['config', 'config_plus_data', 'full']),
  scope: z.string().min(1).max(256).optional().nullable(),
  retention_keep: z.number().int().min(0).max(10_000).optional(),
  retention_days: z.number().int().min(1).max(36500).optional().nullable(),
  passphrase: z.string().min(8).max(1024),
  passphrase_hint: z.string().max(256).optional().nullable(),
  enabled: z.boolean().optional(),
}).strict();

const scheduleUpdateSchema = scheduleSchema.partial().strict().refine(
  (obj) => Object.keys(obj).length > 0,
  { message: 'PUT body must not be empty' },
);

function readSchedule(id) {
  return getDb().prepare(`SELECT * FROM backup_schedules WHERE id = ?`).get(id);
}

backupsRouter.get('/schedules', requireAdmin, (_req, res) => {
  const rows = getDb().prepare(
    `SELECT * FROM backup_schedules ORDER BY created_at DESC`
  ).all();
  res.json({ schedules: rows.map(publicScheduleShape) });
});

backupsRouter.post('/schedules', requireAdmin, requireSudo, (req, res) => {
  let body;
  try { body = scheduleSchema.parse(req.body || {}); }
  catch (e) { return res.status(400).json({ error: e.message }); }

  if (!isValidCronExpr(body.cron_expr)) {
    return res.status(400).json({ error: `invalid cron_expr: ${body.cron_expr}` });
  }
  const dest = getDb().prepare(`SELECT id FROM backup_destinations WHERE id = ?`)
    .get(body.destination_id);
  if (!dest) return res.status(409).json({ error: 'destination not found' });

  const id = uuid();
  const enabled = body.enabled === false ? 0 : 1;
  const nextMs = computeNextRunMs(body.cron_expr);

  getDb().prepare(`
    INSERT INTO backup_schedules (id, name, destination_id, cron_expr, tier, scope,
                                  retention_keep, retention_days,
                                  passphrase_hint, passphrase_enc,
                                  enabled, next_run_at, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, body.name, body.destination_id, body.cron_expr, body.tier, body.scope || null,
    body.retention_keep ?? 30,
    body.retention_days ?? null,
    body.passphrase_hint || null,
    encryptSecret(body.passphrase),
    enabled,
    nextMs ? new Date(nextMs).toISOString() : null,
    req.user?.id || null,
  );

  const row = readSchedule(id);
  if (enabled) schedulerRegister(row);

  logAudit(req.user.id, 'BACKUP_SCHEDULE_CREATE', 'backup_schedule', id, {
    name: body.name, cron_expr: body.cron_expr, tier: body.tier,
    destination_id: body.destination_id, enabled: !!enabled,
  }, req.ip);

  res.status(201).json({ schedule: publicScheduleShape(row) });
});

backupsRouter.put('/schedules/:id', requireAdmin, requireSudo, (req, res) => {
  const existing = readSchedule(req.params.id);
  if (!existing) return res.status(404).json({ error: 'schedule not found' });

  let body;
  try { body = scheduleUpdateSchema.parse(req.body || {}); }
  catch (e) { return res.status(400).json({ error: e.message }); }

  if (body.cron_expr !== undefined && !isValidCronExpr(body.cron_expr)) {
    return res.status(400).json({ error: `invalid cron_expr: ${body.cron_expr}` });
  }
  if (body.destination_id !== undefined) {
    const ok = getDb().prepare(`SELECT id FROM backup_destinations WHERE id = ?`)
      .get(body.destination_id);
    if (!ok) return res.status(409).json({ error: 'destination not found' });
  }

  const updates = [];
  const args = [];
  function set(col, val) { updates.push(`${col} = ?`); args.push(val); }
  if (body.name !== undefined) set('name', body.name);
  if (body.destination_id !== undefined) set('destination_id', body.destination_id);
  if (body.cron_expr !== undefined) set('cron_expr', body.cron_expr);
  if (body.tier !== undefined) set('tier', body.tier);
  if (body.scope !== undefined) set('scope', body.scope || null);
  if (body.retention_keep !== undefined) set('retention_keep', body.retention_keep);
  if (body.retention_days !== undefined) set('retention_days', body.retention_days || null);
  if (body.passphrase !== undefined) set('passphrase_enc', encryptSecret(body.passphrase));
  if (body.passphrase_hint !== undefined) set('passphrase_hint', body.passphrase_hint || null);
  if (body.enabled !== undefined) set('enabled', body.enabled ? 1 : 0);

  if (body.cron_expr !== undefined) {
    const nextMs = computeNextRunMs(body.cron_expr);
    set('next_run_at', nextMs ? new Date(nextMs).toISOString() : null);
  }

  if (updates.length > 0) {
    args.push(existing.id);
    getDb().prepare(
      `UPDATE backup_schedules SET ${updates.join(', ')} WHERE id = ?`
    ).run(...args);
  }

  const after = readSchedule(existing.id);
  // Re-register so the worker picks up the new cron / enabled state.
  schedulerUnregister(existing.id);
  if (after.enabled) schedulerRegister(after);

  logAudit(req.user.id, 'BACKUP_SCHEDULE_UPDATE', 'backup_schedule', existing.id, {
    fields_changed: Object.keys(body).filter((k) => k !== 'passphrase'),
    passphrase_rotated: body.passphrase !== undefined,
  }, req.ip);

  res.json({ schedule: publicScheduleShape(after) });
});

backupsRouter.delete('/schedules/:id', requireAdmin, requireSudo, (req, res) => {
  const existing = readSchedule(req.params.id);
  if (!existing) return res.status(404).json({ error: 'schedule not found' });

  schedulerUnregister(existing.id);
  getDb().prepare(`DELETE FROM backup_schedules WHERE id = ?`).run(existing.id);

  logAudit(req.user.id, 'BACKUP_SCHEDULE_DELETE', 'backup_schedule', existing.id, {
    name: existing.name,
  }, req.ip);

  res.json({ ok: true });
});

// POST /api/backups/schedules/:id/run-now — fire a job immediately
// without waiting for the cron tick.  Subject to the same serial-
// queue rule, so a run-now during a long-running backup queues
// instead of overlapping.
backupsRouter.post('/schedules/:id/run-now', requireAdmin, requireSudo, (req, res) => {
  const existing = readSchedule(req.params.id);
  if (!existing) return res.status(404).json({ error: 'schedule not found' });

  const queued = schedulerEnqueue(existing.id, { runOnce: true });
  logAudit(req.user.id, 'BACKUP_SCHEDULE_RUN_NOW', 'backup_schedule', existing.id, {
    name: existing.name, queued,
  }, req.ip);
  res.json({ ok: true, queued });
});

// ── Usage ──────────────────────────────────────────────────────────
//
// Per-destination + per-tier size + count breakdown.  Cheap — pure
// SQL aggregation against the local backups table.  PR 2 follow-up
// could augment with a live S3 ListObjects to surface drift between
// the dashboard's view and the bucket's, but that's a network
// round-trip per destination so we keep it out of the hot path.

backupsRouter.get('/usage', requireAdmin, (_req, res) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT b.destination_id, d.name AS destination_name, b.tier,
           COUNT(*) AS count, COALESCE(SUM(b.size_bytes), 0) AS bytes
    FROM backups b
    LEFT JOIN backup_destinations d ON d.id = b.destination_id
    WHERE b.status = 'ok'
    GROUP BY b.destination_id, b.tier
    ORDER BY destination_name, b.tier
  `).all();

  // Total + per-destination summaries for the dashboard card.
  const perDestination = {};
  let totalBytes = 0;
  let totalCount = 0;
  for (const r of rows) {
    totalBytes += r.bytes;
    totalCount += r.count;
    const key = r.destination_id || 'unknown';
    if (!perDestination[key]) {
      perDestination[key] = {
        destination_id: r.destination_id,
        destination_name: r.destination_name,
        bytes: 0,
        count: 0,
        tiers: [],
      };
    }
    perDestination[key].bytes += r.bytes;
    perDestination[key].count += r.count;
    perDestination[key].tiers.push({ tier: r.tier, bytes: r.bytes, count: r.count });
  }

  // Local-first reporting: count rows that have a local copy
  // separately, plus the on-disk footprint from a real fs scan.
  // The fs scan catches orphaned files (DB row dropped but file
  // left behind) — operators want to see those so they can clean
  // up.
  const localRows = db.prepare(`
    SELECT COUNT(*) AS count, COALESCE(SUM(size_bytes), 0) AS bytes
    FROM backups WHERE local_path IS NOT NULL AND status = 'ok'
  `).get();
  const s3Rows = db.prepare(`
    SELECT COUNT(*) AS count, COALESCE(SUM(size_bytes), 0) AS bytes
    FROM backups WHERE s3_uploaded = 1 AND status = 'ok'
  `).get();
  const onDisk = localDiskUsage();

  res.json({
    total: { bytes: totalBytes, count: totalCount },
    per_destination: Object.values(perDestination),
    rows, // raw aggregate rows for clients that want to render their own breakdown
    local: {
      // From the DB perspective — what we expect to find on disk.
      tracked: { bytes: localRows.bytes, count: localRows.count },
      // From the FS perspective — what's actually there.  Drift
      // between the two surfaces orphans / missing files.
      on_disk: onDisk,
    },
    s3: {
      tracked: { bytes: s3Rows.bytes, count: s3Rows.count },
    },
  });
});

// ── Restore ────────────────────────────────────────────────────────

const restoreSchema = z.object({
  mode: z.enum(['dry_run', 'apply']).optional().default('dry_run'),
  target: z.enum(['manifest_only', 'in_place', 'sandbox']).optional().default('sandbox'),
  passphrase: z.string().min(8).max(1024),
  import_incus: z.boolean().optional(),
}).strict();

backupsRouter.post('/:id/restore', requireAdmin, requireSudo, async (req, res) => {
  const backup = readBackup(req.params.id);
  if (!backup) return res.status(404).json({ error: 'backup not found' });
  if (backup.status !== 'ok') {
    return res.status(409).json({ error: `backup is ${backup.status}, not 'ok'` });
  }

  let body;
  try { body = restoreSchema.parse(req.body || {}); }
  catch (e) { return res.status(400).json({ error: e.message }); }

  // PR 2 explicitly does NOT ship in_place restore — that's the
  // operator-overhead-heavy Mode B from the spec.  Reject it with
  // a clear hint pointing at sandbox / manifest_only.
  if (body.target === 'in_place') {
    return res.status(400).json({
      error: 'in_place restore is out of scope for PR 2; pick target=sandbox or manifest_only',
    });
  }

  const destination = getDb().prepare(
    `SELECT * FROM backup_destinations WHERE id = ?`
  ).get(backup.destination_id);
  if (!destination) {
    return res.status(409).json({ error: 'destination row missing — backup is orphaned' });
  }

  const runId = uuid();
  getDb().prepare(`
    INSERT INTO restore_runs (id, backup_id, mode, target, status, initiated_by)
    VALUES (?, ?, ?, ?, 'running', ?)
  `).run(runId, backup.id, body.mode, body.target, req.user.id);

  logAudit(req.user.id, 'BACKUP_RESTORE_START', 'restore_run', runId, {
    backup_id: backup.id, mode: body.mode, target: body.target,
  }, req.ip);

  // Respond with the runId before the engine work starts so the UI
  // can switch into 'tail logs' mode immediately.  The engine runs
  // in the background; clients poll GET /restores/:id for state.
  res.status(202).json({ run_id: runId, status: 'running' });

  // Fire-and-forget — the engine writes back into restore_runs
  // incrementally and finalize() flips status when it's done.
  // We deliberately don't await: the response is already out.
  setImmediate(async () => {
    try {
      if (body.target === 'manifest_only') {
        await runModeC({ runId, backup, destination, passphrase: body.passphrase });
      } else {
        await runModeA({
          runId,
          backup,
          destination,
          passphrase: body.passphrase,
          importIncus: !!body.import_incus,
        });
      }
    } catch (err) {
      // Last-ditch failure path — runModeA/C should normally
      // finalize() the row themselves.  Ensure something lands so
      // a restore_run never sits in 'running' forever.
      try {
        getDb().prepare(`
          UPDATE restore_runs SET status = 'failed', finished_at = CURRENT_TIMESTAMP,
                                  notes = ? WHERE id = ? AND status = 'running'
        `).run(`engine threw: ${err?.message || err}`, runId);
      } catch { /* ignore — best effort */ }
    }
  });
});

backupsRouter.get('/restores', requireAdmin, (_req, res) => {
  const rows = getDb().prepare(
    `SELECT * FROM restore_runs ORDER BY started_at DESC, id DESC LIMIT 200`
  ).all();
  res.json({
    restores: rows.map((r) => ({
      id: r.id,
      backup_id: r.backup_id,
      mode: r.mode,
      target: r.target,
      sandbox_dir: r.sandbox_dir || null,
      started_at: r.started_at,
      finished_at: r.finished_at || null,
      status: r.status,
      step_count: r.steps_json ? JSON.parse(r.steps_json).length : 0,
      initiated_by: r.initiated_by,
      notes: r.notes || null,
    })),
  });
});

backupsRouter.get('/restores/:id', requireAdmin, (req, res) => {
  const row = getDb().prepare(`SELECT * FROM restore_runs WHERE id = ?`)
    .get(req.params.id);
  if (!row) return res.status(404).json({ error: 'restore run not found' });
  let steps = [];
  try { steps = JSON.parse(row.steps_json || '[]'); } catch { steps = []; }
  res.json({
    restore: {
      id: row.id,
      backup_id: row.backup_id,
      mode: row.mode,
      target: row.target,
      sandbox_dir: row.sandbox_dir || null,
      started_at: row.started_at,
      finished_at: row.finished_at || null,
      status: row.status,
      steps,
      initiated_by: row.initiated_by,
      notes: row.notes || null,
    },
  });
});

// GET /api/backups/health-classes — declarative table of supported
// health-check classes for the restore Mode A UI.
backupsRouter.get('/health-classes', requireAdmin, (_req, res) => {
  res.json({ classes: listHealthClasses() });
});

// ── Late-mounted dynamic /:id routes ───────────────────────────────
//
// These MUST be registered after every static-named route above
// (/schedules, /restores, /usage, /health-classes) — otherwise
// Express's first-match routing turns 'schedules' / 'restores' /
// 'usage' / 'health-classes' into :id values and the handler
// 4xx's with 'backup not found'.  The handlers themselves are
// defined up where the rest of the per-row backup CRUD lives;
// only the mounting is late.

backupsRouter.get('/:id', requireAdmin, getBackupHandler);
