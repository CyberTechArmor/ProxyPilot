// LXC snapshot → S3 export pipeline.
//
// The dashboard's existing 'create snapshot' flow runs `incus
// snapshot create <instance> <snapshot>` and stops there — the
// snapshot lives on the host's Incus storage pool and that's it.
// This helper extends that flow with an opt-in S3 export pass:
//
//   1. `incus export <instance>/<snapshot> <tmp-tarball>` (gzip).
//   2. Upload the tarball to each chosen backup_destinations row.
//   3. Track per-destination state in lxc_snapshot_s3_exports so
//      the UI can render 'on-site ✓ · off-site ✓' rollups and
//      operators can later delete from S3 selectively.
//
// All writes go through `incus export` rather than reaching into
// the storage pool directly because Incus's tarball format is
// the only stable, restorable representation of a snapshot.
//
// Errors are surfaced via the same notification dedupe key shape
// as the regular backup-fanout (`backup-upload:<dest_id>`) so a
// chronically-broken destination occupies one bell row across
// both the backup feature and the snapshot feature.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { v4 as uuid } from 'uuid';
import { getDb, logAudit } from '../db.js';
import { putObject, deleteObject, buildKey } from './s3.js';
import { postNotification, resolveNotification } from './notifications.js';

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

// exportSnapshotToTmp({ incusName, snapshotName }) → { ok, path?, error? }
//
// Shells `incus export` into a 0700 tmp dir.  The caller is
// responsible for cleaning up the dir.  Returns the tarball path
// on success.  Refuses unsafe Incus identifiers up front so a
// tampered DB row can't smuggle shell metacharacters into the
// exec line.
export function exportSnapshotToTmp({ incusName, snapshotName }) {
  if (!SAFE_NAME.test(incusName)) {
    return { ok: false, error: `unsafe instance name: ${incusName}` };
  }
  if (!SAFE_NAME.test(snapshotName)) {
    return { ok: false, error: `unsafe snapshot name: ${snapshotName}` };
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-snap-export-'));
  try { fs.chmodSync(dir, 0o700); } catch { /* ignore */ }
  const out = path.join(dir, `${incusName}-${snapshotName}.tar.gz`);

  // `--instance-only` skips other snapshots of the same instance.
  // `--compression gzip` matches what the full-tier backup uses.
  // Timeout is generous — exporting large stateful instances
  // (Postgres) can take 10+ minutes.
  const r = spawnSync('incus', [
    'export', `${incusName}/${snapshotName}`, out,
    '--instance-only', '--compression', 'gzip',
  ], { encoding: 'utf-8', timeout: 60 * 60_000 });
  if (r.status !== 0) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    return {
      ok: false,
      error: (r.stderr || r.stdout || 'incus export failed').trim().slice(0, 1024),
    };
  }
  try {
    const stat = fs.statSync(out);
    return { ok: true, dir, path: out, size: stat.size };
  } catch (err) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    return { ok: false, error: `incus export wrote no readable artifact: ${err?.message || err}` };
  }
}

function buildSnapshotKey(dest, incusName, snapshotName) {
  // Mirrors the layout of the regular backup keys:
  // <prefix>/snapshots/<instance>/<snapshot>.tar.gz so an
  // operator browsing the bucket sees them grouped.
  const objectName = `snapshots/${incusName}/${snapshotName}.tar.gz`;
  return buildKey(dest, objectName);
}

// fanOutSnapshotExport({ incusName, snapshotName, destinations,
//                       audit }) → [exportRow, ...]
//
// Drives the export-and-push.  Inserts a 'pending' row in
// lxc_snapshot_s3_exports per destination up front so the UI can
// render 'in flight'; flips to 'exported' or 'failed' as each
// upload resolves.
//
// Returns the per-destination outcome so the route layer can
// surface them in the kickoff response.  Cleanup of the tmp dir
// always runs via the finally block.
export async function fanOutSnapshotExport({
  containerName, incusName, snapshotName, destinations, audit = {},
}) {
  if (!Array.isArray(destinations) || destinations.length === 0) {
    return { results: [], skipped: 'no destinations' };
  }

  const db = getDb();
  const results = [];

  // Insert 'pending' rows immediately so the UI sees the export
  // state without waiting for the shell-out to finish.
  const exportIds = new Map(); // destination_id -> exportRowId
  for (const dest of destinations) {
    const exportId = uuid();
    const s3Key = buildSnapshotKey(dest, incusName, snapshotName);
    db.prepare(`
      INSERT INTO lxc_snapshot_s3_exports
        (id, container_name, snapshot_name, destination_id, s3_key, status, created_by)
      VALUES (?, ?, ?, ?, ?, 'pending', ?)
    `).run(
      exportId, containerName, snapshotName, dest.id, s3Key,
      audit.user_id || null,
    );
    exportIds.set(dest.id, exportId);
  }

  // One shared `incus export` for every destination — same
  // tarball pushed N times.
  const exported = exportSnapshotToTmp({ incusName, snapshotName });
  if (!exported.ok) {
    // Mark every pending row failed with the same export error.
    for (const dest of destinations) {
      db.prepare(`
        UPDATE lxc_snapshot_s3_exports
        SET status = 'failed', error = ?, finished_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(exported.error, exportIds.get(dest.id));
      results.push({
        destination_id: dest.id, destination_name: dest.name,
        ok: false, error: `export failed: ${exported.error}`,
      });
    }
    return { results };
  }

  try {
    const buffer = fs.readFileSync(exported.path);
    for (const dest of destinations) {
      const exportId = exportIds.get(dest.id);
      const row = db.prepare(`SELECT s3_key FROM lxc_snapshot_s3_exports WHERE id = ?`)
        .get(exportId);
      let error = null;
      try {
        await putObject(dest, row.s3_key, buffer, {
          contentType: 'application/gzip',
        });
        try {
          resolveNotification(`backup-upload:${dest.id}`, { reason: 'snapshot upload ok' });
        } catch { /* tolerated */ }
      } catch (err) {
        error = err?.message || String(err);
      }
      if (error) {
        db.prepare(`
          UPDATE lxc_snapshot_s3_exports
          SET status = 'failed', error = ?, finished_at = CURRENT_TIMESTAMP,
              size_bytes = ?
          WHERE id = ?
        `).run(error.slice(0, 1024), buffer.length, exportId);
        try {
          postNotification({
            level: 'error',
            title: `Snapshot upload failed: ${dest.name}`,
            body: `Pushing ${incusName}/${snapshotName} to "${dest.name}" failed: ${error}`,
            source: 'snapshot-export',
            source_id: dest.id,
            dedupe_key: `backup-upload:${dest.id}`,
          });
        } catch { /* tolerated */ }
        results.push({
          destination_id: dest.id, destination_name: dest.name, ok: false, error,
        });
      } else {
        db.prepare(`
          UPDATE lxc_snapshot_s3_exports
          SET status = 'exported', finished_at = CURRENT_TIMESTAMP,
              size_bytes = ?, error = NULL
          WHERE id = ?
        `).run(buffer.length, exportId);
        results.push({
          destination_id: dest.id, destination_name: dest.name, ok: true,
        });
      }
    }
  } finally {
    // Cleanup the tmp dir whether or not all uploads succeeded.
    try { fs.rmSync(exported.dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  try {
    logAudit(audit.user_id || null, 'LXC_SNAPSHOT_S3_EXPORT', 'lxc_snapshot',
      `${containerName}/${snapshotName}`, {
        destinations: results.map((r) => ({
          destination_id: r.destination_id, ok: r.ok, error: r.error || null,
        })),
        size_bytes: exported.size,
      }, audit.ip || null);
  } catch { /* tolerated */ }

  return { results, size_bytes: exported.size };
}

// listSnapshotExports({ containerName, snapshotName? }) — UI feed.
// Joined to backup_destinations so each row carries the
// destination's display name + bucket without a second query.
export function listSnapshotExports({ containerName, snapshotName = null }) {
  const db = getDb();
  if (snapshotName) {
    return db.prepare(`
      SELECT e.*, d.name AS destination_name, d.bucket AS destination_bucket
      FROM lxc_snapshot_s3_exports e
      LEFT JOIN backup_destinations d ON d.id = e.destination_id
      WHERE e.container_name = ? AND e.snapshot_name = ?
      ORDER BY e.started_at DESC
    `).all(containerName, snapshotName);
  }
  return db.prepare(`
    SELECT e.*, d.name AS destination_name, d.bucket AS destination_bucket
    FROM lxc_snapshot_s3_exports e
    LEFT JOIN backup_destinations d ON d.id = e.destination_id
    WHERE e.container_name = ?
    ORDER BY e.started_at DESC
  `).all(containerName);
}

// deleteSnapshotExport({ exportId, audit }) — operator-driven
// removal.  Reads the row, deletes the S3 object, marks the
// row deleted (status='deleted').  Tolerates already-gone
// objects (NotFound / NoSuchKey) the same way the backup
// fan-out delete does.
export async function deleteSnapshotExport({ exportId, audit = {} }) {
  const db = getDb();
  const row = db.prepare(`
    SELECT e.*, d.bucket
    FROM lxc_snapshot_s3_exports e
    LEFT JOIN backup_destinations d ON d.id = e.destination_id
    WHERE e.id = ?
  `).get(exportId);
  if (!row) return { ok: false, error: 'export not found' };
  if (row.status === 'deleted') return { ok: true, alreadyDeleted: true };

  const dest = db.prepare(`SELECT * FROM backup_destinations WHERE id = ?`)
    .get(row.destination_id);
  if (!dest) {
    return { ok: false, error: 'destination missing' };
  }

  let error = null;
  try {
    await deleteObject(dest, row.s3_key);
  } catch (err) {
    const code = err?.Code || err?.name || '';
    if (!/NotFound|NoSuchKey/i.test(code)) {
      error = err?.message || String(err);
    }
  }
  if (error) {
    return { ok: false, error };
  }
  db.prepare(`
    UPDATE lxc_snapshot_s3_exports
    SET status = 'deleted', finished_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(exportId);
  try {
    logAudit(audit.user_id || null, 'LXC_SNAPSHOT_S3_EXPORT_DELETE', 'lxc_snapshot',
      `${row.container_name}/${row.snapshot_name}`, {
        destination_id: dest.id, s3_key: row.s3_key,
      }, audit.ip || null);
  } catch { /* tolerated */ }
  return { ok: true };
}
