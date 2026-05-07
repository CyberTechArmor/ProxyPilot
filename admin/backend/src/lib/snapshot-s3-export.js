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
import { v4 as uuid } from 'uuid';
import { getDb, logAudit } from '../db.js';
import { putObjectWithControl, deleteObject, buildKey } from './s3.js';
import { postNotification, resolveNotification } from './notifications.js';
import { spawnHostSync, hasHostBinary } from './host-exec.js';

// In-memory map of in-flight uploads so the cancel route can
// abort them.  Keyed by export row id; value carries the Upload
// instance + a cancellation flag the progress callback polls.
//
// Map content disappears on dashboard restart — that's fine: the
// upload also dies with the process, and the row's status flips
// to 'failed' on next boot via the stale-pending sweeper (PR
// follow-up; for now an orphaned 'pending' row gets cleaned up
// when the operator next clicks the row's cancel button).
const ACTIVE_UPLOADS = new Map();

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

// exportSnapshotToTmp({ incusName, snapshotName }) → { ok, path?, error? }
//
// Shells `incus export` into a 0700 tmp dir.  The caller is
// responsible for cleaning up the dir.  Returns the tarball path
// on success.  Refuses unsafe Incus identifiers up front so a
// tampered DB row can't smuggle shell metacharacters into the
// exec line.
// exportSnapshotToTmp({ incusName, snapshotName }) → { ok, path?, error? }
//
// Materialises the named snapshot into a tarball.  `incus export
// <instance>/<snapshot>` looks like the right invocation but
// Incus 6.0.0 rejects it with 'Create instance backup: Invalid
// instance name' — `incus export` only accepts a plain instance
// name, not the `instance/snapshot` form.
//
// The supported pattern is a three-step dance:
//   1. `incus copy <instance>/<snapshot> <temp-instance>` —
//      materialises the snapshot's frozen state into a fresh
//      throwaway instance.  On copy-on-write storage backends
//      (btrfs / zfs / lvm-thin) this is instant and zero-cost;
//      on the dir backend it's a full filesystem copy.
//   2. `incus export <temp-instance> <out> --instance-only` —
//      tarballs the temp's filesystem.  --instance-only because
//      the temp has no sub-snapshots.
//   3. `incus delete --force <temp-instance>` — cleanup.
// We always run step 3 in finally so a failure in step 2 doesn't
// leak the temp instance.
//
// Cross-namespace caveat: Incus is on the host, so the export
// path must be host-side.  We write to /tmp on the host then
// `cat` the bytes back into the dashboard container.  Same
// dance backup-pack's exportIncusInstance uses.
export function exportSnapshotToTmp({ incusName, snapshotName }) {
  if (!SAFE_NAME.test(incusName)) {
    return { ok: false, error: `unsafe instance name: ${incusName}` };
  }
  if (!SAFE_NAME.test(snapshotName)) {
    return { ok: false, error: `unsafe snapshot name: ${snapshotName}` };
  }
  if (!hasHostBinary('incus')) {
    return { ok: false, error: 'incus binary not found on host' };
  }

  // Random 8-char id for the temp instance name + the host-side
  // /tmp dir.  Incus instance names match
  // [a-zA-Z][a-zA-Z0-9-]{0,62} — alphanumeric is a safe subset.
  const shortId = Math.random().toString(36).slice(2, 10);
  const tempInstance = `pp-snapxp-${shortId}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-snap-export-'));
  try { fs.chmodSync(dir, 0o700); } catch { /* ignore */ }
  const hostTmpDir = `/tmp/pp-snap-export-${process.pid}-${Date.now()}-${shortId}`;
  const hostOut = `${hostTmpDir}/${incusName}-${snapshotName}.tar.gz`;

  let copyDone = false;
  try {
    const mkdir = spawnHostSync('mkdir', ['-p', hostTmpDir], { encoding: 'utf-8' });
    if (mkdir.status !== 0) {
      throw new Error(
        `mkdir on host failed: ${(mkdir.stderr || mkdir.error?.message || 'unknown').trim()}`
      );
    }

    // Step 1: copy snapshot → temp instance.
    const cp = spawnHostSync('incus', [
      'copy', `${incusName}/${snapshotName}`, tempInstance,
    ], { encoding: 'utf-8', timeout: 60 * 60_000 });
    if (cp.status !== 0) {
      throw new Error(
        `incus copy snapshot failed: ${(cp.stderr || cp.stdout || 'unknown').trim()}`
      );
    }
    copyDone = true;

    // Step 2: export the temp instance.
    const ex = spawnHostSync('incus', [
      'export', tempInstance, hostOut,
      '--instance-only', '--compression', 'gzip',
    ], { encoding: 'utf-8', timeout: 60 * 60_000 });
    if (ex.status !== 0) {
      throw new Error(
        `incus export failed: ${(ex.stderr || ex.stdout || 'unknown').trim()}`
      );
    }

    // Step 3: pipe the host tarball into the container.
    const cat = spawnHostSync('cat', [hostOut], {
      encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 * 1024,
    });
    if (cat.status !== 0) {
      throw new Error((cat.stderr?.toString?.() || 'cat failed').trim());
    }
    const containerOut = path.join(dir, `${incusName}-${snapshotName}.tar.gz`);
    fs.writeFileSync(containerOut, cat.stdout);
    const stat = fs.statSync(containerOut);
    return { ok: true, dir, path: containerOut, size: stat.size };
  } catch (err) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    return { ok: false, error: (err?.message || String(err)).slice(0, 1024) };
  } finally {
    // Cleanup runs regardless of outcome.  Capture stderr so a
    // silent delete failure (e.g. incus daemon mid-stop, network
    // hiccup talking to the daemon, instance left in a state
    // --force doesn't recover from) is logged + visible to the
    // sweeper that runs periodically.
    if (copyDone) {
      // First try: plain --force delete (handles a running
      // temp in one shot).
      const del = spawnHostSync('incus', ['delete', '--force', tempInstance], {
        encoding: 'utf-8', timeout: 60_000,
      });
      if (del.status !== 0) {
        // Fallback: stop-then-delete in case the temp is in a
        // state --force alone won't budge.  Some incus versions
        // require an explicit stop before delete on certain
        // storage backends.
        spawnHostSync('incus', ['stop', '--force', tempInstance], {
          encoding: 'utf-8', timeout: 30_000,
        });
        const del2 = spawnHostSync('incus', ['delete', '--force', tempInstance], {
          encoding: 'utf-8', timeout: 60_000,
        });
        if (del2.status !== 0) {
          // Log loudly — the sweeper will pick it up later, but
          // an immediate hint in stderr lets the operator
          // correlate with their dashboard activity.
          // eslint-disable-next-line no-console
          console.error(
            `[snapshot-s3-export] failed to delete temp instance ${tempInstance}: ` +
            `${(del2.stderr || del2.stdout || del.stderr || 'unknown').trim()}`
          );
        }
      }
    }
    spawnHostSync('rm', ['-rf', hostTmpDir], { encoding: 'utf-8' });
  }
}

// Sweep orphaned pp-snapxp-* temp instances on the host.
//
// Even with the dual-attempt cleanup above, failure modes still
// exist — process killed mid-export, daemon restart, host reboot.
// This sweeper finds any pp-snapxp-* instance and deletes it
// regardless of how it got stuck.  Conservative: only fires
// against the prefix we own; other operator-created instances
// are untouched.
//
// Called from the in-process scheduler (lib/backup-scheduler
// hydrate path) every 30 minutes.  Synchronous host calls are
// fine for this scale (<100 instances on any reasonable
// deployment).
export function sweepOrphanTempInstances() {
  if (!hasHostBinary('incus')) return { ok: false, error: 'incus unavailable' };
  const list = spawnHostSync('incus', ['list', '-c', 'n', '-f', 'csv'], {
    encoding: 'utf-8', timeout: 30_000,
  });
  if (list.status !== 0) {
    return { ok: false, error: (list.stderr || 'incus list failed').trim() };
  }
  const names = (list.stdout || '')
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.startsWith('pp-snapxp-'));

  const deleted = [];
  const failed = [];
  for (const name of names) {
    spawnHostSync('incus', ['stop', '--force', name], {
      encoding: 'utf-8', timeout: 30_000,
    });
    const del = spawnHostSync('incus', ['delete', '--force', name], {
      encoding: 'utf-8', timeout: 60_000,
    });
    if (del.status === 0) {
      deleted.push(name);
    } else {
      failed.push({ name, error: (del.stderr || del.stdout || 'unknown').trim() });
    }
  }
  if (deleted.length > 0) {
    // eslint-disable-next-line no-console
    console.log(`[snapshot-s3-export] swept ${deleted.length} orphan temp instance(s): ${deleted.join(', ')}`);
  }
  return { ok: true, deleted, failed };
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
    // Stamp every pending row with the artifact's total byte
    // count up front so the UI's progress percentage works on
    // first paint — no need to wait for the first
    // httpUploadProgress event.
    db.prepare(`
      UPDATE lxc_snapshot_s3_exports
      SET bytes_total = ?
      WHERE id IN (${[...exportIds.values()].map(() => '?').join(',')})
    `).run(buffer.length, ...exportIds.values());

    // Throttle progress writes to the DB.  AWS SDK can emit
    // dozens of httpUploadProgress events per second on a fast
    // upload; writing each would churn SQLite for no UI gain
    // (operators aren't watching at sub-second resolution).
    const PROGRESS_THROTTLE_MS = 500;

    for (const dest of destinations) {
      const exportId = exportIds.get(dest.id);
      const row = db.prepare(`SELECT s3_key FROM lxc_snapshot_s3_exports WHERE id = ?`)
        .get(exportId);
      let error = null;
      let lastProgressWriteAt = 0;
      const updateBytes = db.prepare(`
        UPDATE lxc_snapshot_s3_exports SET bytes_uploaded = ? WHERE id = ?
      `);
      const isCanceledRow = db.prepare(`
        SELECT cancel_requested FROM lxc_snapshot_s3_exports WHERE id = ?
      `);
      // Pre-register a placeholder so the cancel route can find
      // and abort even if the very first putObjectWithControl()
      // call is still being constructed.
      ACTIVE_UPLOADS.set(exportId, { aborted: false, uploader: null });

      try {
        const handle = putObjectWithControl(dest, row.s3_key, buffer, {
          contentType: 'application/gzip',
          onProgress: ({ loaded }) => {
            const now = Date.now();
            if (now - lastProgressWriteAt >= PROGRESS_THROTTLE_MS) {
              try { updateBytes.run(loaded, exportId); } catch { /* ignore */ }
              lastProgressWriteAt = now;
            }
          },
          isCanceled: () => {
            try {
              const r = isCanceledRow.get(exportId);
              return !!(r && r.cancel_requested);
            } catch { return false; }
          },
        });
        ACTIVE_UPLOADS.set(exportId, { aborted: false, uploader: handle.uploader });
        await handle.done;
        // Final progress write at completion so the UI sees 100%
        // even if the throttled callback skipped the last event.
        try { updateBytes.run(buffer.length, exportId); } catch { /* ignore */ }
        try {
          resolveNotification(`backup-upload:${dest.id}`, { reason: 'snapshot upload ok' });
        } catch { /* tolerated */ }
      } catch (err) {
        // AWS SDK aborts surface as an error.  Distinguish a
        // canceled-by-operator from a real failure so the bell
        // doesn't claim 'upload failed' for a deliberate cancel.
        const canceled = (ACTIVE_UPLOADS.get(exportId)?.aborted)
          || /aborted|canceled/i.test(err?.name || '')
          || /aborted|canceled/i.test(err?.message || '');
        error = canceled
          ? 'canceled by operator'
          : (err?.message || String(err));
      } finally {
        ACTIVE_UPLOADS.delete(exportId);
      }

      if (error) {
        const canceled = error === 'canceled by operator';
        db.prepare(`
          UPDATE lxc_snapshot_s3_exports
          SET status = 'failed', error = ?, finished_at = CURRENT_TIMESTAMP,
              size_bytes = ?
          WHERE id = ?
        `).run(error.slice(0, 1024), buffer.length, exportId);
        if (!canceled) {
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
        }
        results.push({
          destination_id: dest.id, destination_name: dest.name, ok: false, error,
          canceled,
        });
      } else {
        db.prepare(`
          UPDATE lxc_snapshot_s3_exports
          SET status = 'exported', finished_at = CURRENT_TIMESTAMP,
              size_bytes = ?, error = NULL,
              bytes_uploaded = ?
          WHERE id = ?
        `).run(buffer.length, buffer.length, exportId);
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

// cancelSnapshotExport({ exportId, audit }) — flip the row's
// cancel_requested flag and abort the in-flight Upload if we
// have one in our active map.  Idempotent: a cancel against a
// row that's already 'failed' / 'exported' / 'deleted' returns
// { ok: true, alreadyFinished } without touching anything.
//
// The actual state transition to 'failed (canceled by operator)'
// happens in fanOutSnapshotExport's catch block — calling
// uploader.abort() rejects the done() promise with an
// AbortError-shaped error, which the caller's try/catch
// recognises and writes 'canceled by operator' into the row.
export async function cancelSnapshotExport({ exportId, audit = {} }) {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM lxc_snapshot_s3_exports WHERE id = ?`)
    .get(exportId);
  if (!row) return { ok: false, error: 'export not found' };
  if (row.status !== 'pending') {
    return { ok: true, alreadyFinished: true, status: row.status };
  }
  db.prepare(`
    UPDATE lxc_snapshot_s3_exports SET cancel_requested = 1 WHERE id = ?
  `).run(exportId);
  const handle = ACTIVE_UPLOADS.get(exportId);
  if (handle) {
    handle.aborted = true;
    if (handle.uploader) {
      try { handle.uploader.abort(); } catch { /* ignore */ }
    }
  }
  try {
    logAudit(audit.user_id || null, 'LXC_SNAPSHOT_S3_EXPORT_CANCEL', 'lxc_snapshot',
      `${row.container_name}/${row.snapshot_name}`, {
        export_id: exportId, destination_id: row.destination_id,
      }, audit.ip || null);
  } catch { /* tolerated */ }
  return { ok: true };
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

  // 'failed' rows have no S3 object to delete — the upload never
  // succeeded.  Operator action here is 'dismiss the row from
  // the UI'; we drop the DB row outright.  Same path for
  // 'pending' rows that the operator wants to drop after a
  // cancel finished (the cancel itself flips them to 'failed'
  // first; this branch covers stale pending rows from a
  // previous process / clean-shutdown gap).
  if (row.status === 'failed' || row.status === 'pending') {
    db.prepare(`DELETE FROM lxc_snapshot_s3_exports WHERE id = ?`).run(exportId);
    try {
      logAudit(audit.user_id || null, 'LXC_SNAPSHOT_S3_EXPORT_DISMISS', 'lxc_snapshot',
        `${row.container_name}/${row.snapshot_name}`, {
          destination_id: row.destination_id, status_before: row.status,
          error: row.error || null,
        }, audit.ip || null);
    } catch { /* tolerated */ }
    return { ok: true, dismissed: true, status_before: row.status };
  }

  // 'exported' rows have a real S3 object — actually call the
  // delete endpoint and only drop the row when the bucket
  // confirms.
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
