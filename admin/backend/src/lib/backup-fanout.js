// Multi-destination fan-out helpers.
//
// Pack the artifact once (lib/backup-pack.pack), write it to
// local disk once (lib/backup-local-store.writeLocal), then push
// the same buffer to N S3 destinations in turn.  Each per-
// destination upload outcome lands in
// backup_destinations_x_backups so the dashboard can render a
// 'this backup is on local + B2 + MinIO' detail and an operator
// can retry a single failed destination without re-encrypting.
//
// Why a helper rather than inlining the fan-out: both the
// on-demand POST /api/backups handler and the scheduler's
// runSchedule() execute the same fan-out, and the audit /
// notification semantics need to be identical between them.
// Centralising removes a class of drift.

import { getDb, logAudit } from '../db.js';
import { putObject, deleteObject, buildKey } from './s3.js';
import { postNotification, resolveNotification } from './notifications.js';

// resolveScheduleDestinations(scheduleId) → [destination row, ...]
// in junction insertion order.  Returns [] for local-only
// schedules.
export function resolveScheduleDestinations(scheduleId) {
  return getDb().prepare(`
    SELECT d.*
    FROM backup_schedule_destinations bsd
    JOIN backup_destinations d ON d.id = bsd.destination_id
    WHERE bsd.schedule_id = ?
    ORDER BY bsd.created_at ASC
  `).all(scheduleId);
}

// resolveBackupDestinations(backupId) → junction rows JOINed to
// backup_destinations.  Used by the UI to render per-destination
// upload state.
export function resolveBackupDestinations(backupId) {
  return getDb().prepare(`
    SELECT bdxb.*, d.name AS destination_name, d.bucket AS destination_bucket
    FROM backup_destinations_x_backups bdxb
    LEFT JOIN backup_destinations d ON d.id = bdxb.destination_id
    WHERE bdxb.backup_id = ?
    ORDER BY bdxb.uploaded_at ASC, bdxb.destination_id ASC
  `).all(backupId);
}

// fanOutUpload({ buffer, backupId, destinations, audit }) → { results }
//
// Drives the per-destination upload loop.  buffer is the packed
// .ppbackup bytes (already encrypted + authenticated).  Each
// destination gets:
//
//   1. A pending row in backup_destinations_x_backups so the UI
//      can render 'in flight' state without polling for an INSERT.
//   2. A putObject() call.
//   3. Status flipped to 'uploaded' on success or 'failed' on
//      error; the per-row error column carries the message.
//
// On failure, posts a notification keyed off
// `backup-upload:${destination_id}` so a chronically-broken
// destination doesn't flood the bell.  On success, resolves the
// previous notification (matches the daily-S3-probe behaviour).
//
// The first destination's row also primes the legacy
// backups.s3_key + backups.s3_uploaded columns for back-compat
// with PR-1/PR-2 readers.
export async function fanOutUpload({
  buffer, backupId, destinations, audit = {},
}) {
  const results = [];
  const db = getDb();

  for (let i = 0; i < destinations.length; i += 1) {
    const dest = destinations[i];
    const objectName = `${backupId}.ppbackup`;
    const s3Key = buildKey(dest, objectName);

    // Insert pending junction row up front so the UI sees a row
    // for each destination as soon as the fan-out starts.
    db.prepare(`
      INSERT OR REPLACE INTO backup_destinations_x_backups
        (backup_id, destination_id, s3_key, status, size_bytes)
      VALUES (?, ?, ?, 'pending', ?)
    `).run(backupId, dest.id, s3Key, buffer.length);

    let error = null;
    try {
      await putObject(dest, s3Key, buffer, {
        contentType: 'application/octet-stream',
      });
      db.prepare(`
        UPDATE backup_destinations_x_backups
        SET status = 'uploaded', uploaded_at = CURRENT_TIMESTAMP, error = NULL
        WHERE backup_id = ? AND destination_id = ?
      `).run(backupId, dest.id);
      // Recovery: if a previous run posted a 'destination
      // unreachable for upload' notification, drop it.
      try {
        resolveNotification(`backup-upload:${dest.id}`, { reason: 'upload ok' });
      } catch { /* tolerated */ }
    } catch (err) {
      error = err?.message || String(err);
      db.prepare(`
        UPDATE backup_destinations_x_backups
        SET status = 'failed', error = ?
        WHERE backup_id = ? AND destination_id = ?
      `).run(error.slice(0, 1024), backupId, dest.id);

      // Surface the failure in the bell.  Dedupe per destination
      // so a chronically-broken target doesn't spam.
      try {
        postNotification({
          level: 'error',
          title: `Backup upload failed: ${dest.name}`,
          body: `Pushing backup ${backupId.slice(0, 8)}… to "${dest.name}" (${dest.bucket}) failed: ${error}`,
          source: 'backup-upload',
          source_id: dest.id,
          dedupe_key: `backup-upload:${dest.id}`,
        });
      } catch { /* tolerated */ }

      try {
        logAudit(audit.user_id || null, 'BACKUP_UPLOAD_FAILED', 'backup', backupId, {
          destination_id: dest.id, destination_name: dest.name, error,
          ...audit,
        }, audit.ip || null);
      } catch { /* tolerated */ }
    }

    // First-destination back-compat: prime legacy columns from
    // the lead destination.  Subsequent destinations don't
    // touch them.
    if (i === 0) {
      const uploaded = error ? 0 : 1;
      db.prepare(`
        UPDATE backups
        SET destination_id = ?, s3_key = ?, s3_uploaded = ?
        WHERE id = ?
      `).run(dest.id, s3Key, uploaded, backupId);
    }

    results.push({
      destination_id: dest.id,
      destination_name: dest.name,
      ok: !error,
      error,
      s3_key: s3Key,
    });
  }

  return { results };
}

// fanOutDelete({ backupId, destinationIds }) → { results }
//
// Walks the junction's pending S3 objects for the named
// destinations and removes each.  Used by the per-row delete
// path when delete_s3=true (multi-destination version of the
// existing single-destination behaviour).
export async function fanOutDelete({ backupId, destinationIds = null }) {
  const db = getDb();
  // null = walk every uploaded edge; otherwise restrict.
  const edges = destinationIds === null
    ? db.prepare(`
        SELECT bdxb.*, d.bucket
        FROM backup_destinations_x_backups bdxb
        LEFT JOIN backup_destinations d ON d.id = bdxb.destination_id
        WHERE bdxb.backup_id = ? AND bdxb.status = 'uploaded'
      `).all(backupId)
    : db.prepare(`
        SELECT bdxb.*, d.bucket
        FROM backup_destinations_x_backups bdxb
        LEFT JOIN backup_destinations d ON d.id = bdxb.destination_id
        WHERE bdxb.backup_id = ? AND bdxb.status = 'uploaded'
          AND bdxb.destination_id IN (${destinationIds.map(() => '?').join(',') || '\'\''})
      `).all(backupId, ...destinationIds);

  const results = [];
  for (const e of edges) {
    const dest = db.prepare(`SELECT * FROM backup_destinations WHERE id = ?`)
      .get(e.destination_id);
    if (!dest) {
      results.push({ destination_id: e.destination_id, ok: false, error: 'destination missing' });
      continue;
    }
    let error = null;
    try {
      await deleteObject(dest, e.s3_key);
    } catch (err) {
      const code = err?.Code || err?.name || '';
      if (!/NotFound|NoSuchKey/i.test(code)) {
        error = err?.message || String(err);
      }
    }
    if (error) {
      results.push({ destination_id: dest.id, ok: false, error });
      continue;
    }
    db.prepare(`
      UPDATE backup_destinations_x_backups
      SET status = 'deleted', deleted_at = CURRENT_TIMESTAMP
      WHERE backup_id = ? AND destination_id = ?
    `).run(backupId, dest.id);
    results.push({ destination_id: dest.id, ok: true });
  }
  return { results };
}
