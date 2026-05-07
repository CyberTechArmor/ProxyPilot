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
import { putObjectWithControl, deleteObject, buildKey, getObjectStream } from './s3.js';
import { postNotification, resolveNotification } from './notifications.js';
import { spawnHostSync, spawnHost, hasHostBinary } from './host-exec.js';

// Async wrapper around spawnHost.  Drop-in replacement for
// spawnHostSync that does NOT block the Node event loop — using
// spawnSync to shell out to a multi-minute `incus copy` /
// `incus export` froze the entire admin process on small VMs
// (operator reported a ~60s UI lockup on a 2 vCPU Linode).  The
// resulting object mirrors spawnSync's shape (status / stdout /
// stderr / error / signal) so callers don't change.
function runHost(bin, args = [], opts = {}) {
  return new Promise((resolve) => {
    const enc = opts.encoding;
    const child = spawnHost(bin, args, {
      ...opts,
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: undefined,
    });
    const outChunks = [];
    const errChunks = [];
    let outBytes = 0;
    let errBytes = 0;
    let killed = false;
    let timer;
    if (opts.timeout) {
      timer = setTimeout(() => {
        killed = true;
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
      }, opts.timeout);
    }
    if (child.stdout) {
      child.stdout.on('data', (c) => { outChunks.push(c); outBytes += c.length; });
    }
    if (child.stderr) {
      child.stderr.on('data', (c) => { errChunks.push(c); errBytes += c.length; });
    }
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      resolve({
        status: null, signal: null, error: err,
        stdout: enc === 'buffer'
          ? Buffer.concat(outChunks, outBytes)
          : Buffer.concat(outChunks, outBytes).toString(enc || 'utf-8'),
        stderr: enc === 'buffer'
          ? Buffer.concat(errChunks, errBytes)
          : Buffer.concat(errChunks, errBytes).toString(enc || 'utf-8'),
      });
    });
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({
        status: killed ? null : code,
        signal,
        stdout: enc === 'buffer'
          ? Buffer.concat(outChunks, outBytes)
          : Buffer.concat(outChunks, outBytes).toString(enc || 'utf-8'),
        stderr: enc === 'buffer'
          ? Buffer.concat(errChunks, errBytes)
          : Buffer.concat(errChunks, errBytes).toString(enc || 'utf-8'),
      });
    });
    if (opts.input != null && child.stdin) {
      try { child.stdin.write(opts.input); } catch { /* ignore */ }
      try { child.stdin.end(); } catch { /* ignore */ }
    }
  });
}

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
export async function exportSnapshotToTmp({ incusName, snapshotName }) {
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
    const mkdir = await runHost('mkdir', ['-p', hostTmpDir], { encoding: 'utf-8' });
    if (mkdir.status !== 0) {
      throw new Error(
        `mkdir on host failed: ${(mkdir.stderr || mkdir.error?.message || 'unknown').trim()}`
      );
    }

    // Step 1: copy snapshot → temp instance.  Wrapped in `nice`
    // so the snapshot dance doesn't starve the dashboard / Caddy
    // / other host processes on small VMs.
    const cp = await runHost('nice', [
      '-n', '19', 'incus',
      'copy', `${incusName}/${snapshotName}`, tempInstance,
    ], { encoding: 'utf-8', timeout: 60 * 60_000 });
    if (cp.status !== 0) {
      throw new Error(
        `incus copy snapshot failed: ${(cp.stderr || cp.stdout || 'unknown').trim()}`
      );
    }
    copyDone = true;

    // Step 2: export the temp instance.
    const ex = await runHost('nice', [
      '-n', '19', 'incus',
      'export', tempInstance, hostOut,
      '--instance-only', '--compression', 'gzip',
    ], { encoding: 'utf-8', timeout: 60 * 60_000 });
    if (ex.status !== 0) {
      throw new Error(
        `incus export failed: ${(ex.stderr || ex.stdout || 'unknown').trim()}`
      );
    }

    // Step 3: pipe the host tarball into the container.
    const cat = await runHost('cat', [hostOut], {
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
    // Cleanup runs regardless of outcome.  Synchronous because the
    // whole function is now async; awaiting in finally is fine
    // and the cleanup is short.
    if (copyDone) {
      const del = await runHost('incus', ['delete', '--force', tempInstance], {
        encoding: 'utf-8', timeout: 60_000,
      });
      if (del.status !== 0) {
        await runHost('incus', ['stop', '--force', tempInstance], {
          encoding: 'utf-8', timeout: 30_000,
        });
        const del2 = await runHost('incus', ['delete', '--force', tempInstance], {
          encoding: 'utf-8', timeout: 60_000,
        });
        if (del2.status !== 0) {
          // eslint-disable-next-line no-console
          console.error(
            `[snapshot-s3-export] failed to delete temp instance ${tempInstance}: ` +
            `${(del2.stderr || del2.stdout || del.stderr || 'unknown').trim()}`
          );
        }
      }
    }
    await runHost('rm', ['-rf', hostTmpDir], { encoding: 'utf-8' });
  }
}

// importSnapshotFromS3({ destination, s3Key, incusName, snapshotName,
//                        audit }) → { ok, error?, sizeBytes? }
//
// The reverse of exportSnapshotToTmp + S3 upload: stream the
// tarball from S3 into a host /tmp file, `incus import` it as a
// throwaway temp instance, then `incus copy <temp> <orig>/<snap>`
// to land it as a snapshot on the original container.  Caller is
// responsible for verifying the orig instance exists.
//
// This intentionally uses spawnHostSync for the long-running
// incus calls — the queue (lib/snapshot-export-queue) serialises
// imports the same way it serialises exports, and the operator
// expects a blocking response (mirror of the regular import
// flow).
export async function importSnapshotFromS3({
  destination, s3Key, incusName, snapshotName, audit = {},
}) {
  if (!SAFE_NAME.test(incusName)) {
    return { ok: false, error: `unsafe instance name: ${incusName}` };
  }
  if (!SAFE_NAME.test(snapshotName)) {
    return { ok: false, error: `unsafe snapshot name: ${snapshotName}` };
  }
  if (!hasHostBinary('incus')) {
    return { ok: false, error: 'incus binary not found on host' };
  }

  const shortId = Math.random().toString(36).slice(2, 10);
  const tempInstance = `pp-snapxp-imp-${shortId}`;
  const hostTmpDir = `/tmp/pp-snap-import-${process.pid}-${Date.now()}-${shortId}`;
  const hostTarball = `${hostTmpDir}/import.tar.gz`;

  let importDone = false;
  try {
    const mkdir = spawnHostSync('mkdir', ['-p', hostTmpDir], { encoding: 'utf-8' });
    if (mkdir.status !== 0) {
      throw new Error(
        `mkdir on host failed: ${(mkdir.stderr || mkdir.error?.message || 'unknown').trim()}`
      );
    }

    // Stream S3 object → buffer in the container, then pipe into
    // a host file via `cat`.  Buffering matches exportSnapshotToTmp's
    // approach; tarballs north of host RAM aren't realistic at the
    // 'snapshot of a single LXC' scale this feature targets.
    const obj = await getObjectStream(destination, s3Key);
    const chunks = [];
    let downloaded = 0;
    await new Promise((resolve, reject) => {
      obj.stream.on('data', (c) => { chunks.push(c); downloaded += c.length; });
      obj.stream.on('end', resolve);
      obj.stream.on('error', reject);
    });
    const buffer = Buffer.concat(chunks, downloaded);

    const cat = spawnHostSync('sh', ['-c', `cat > ${hostTarball}`], {
      input: buffer, encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 * 1024,
    });
    if (cat.status !== 0) {
      throw new Error(
        `host cat failed: ${(cat.stderr?.toString?.() || 'unknown').trim()}`
      );
    }

    // Step 1: incus import <tarball> <temp-instance>.  Creates a
    // new instance from the tarball.  Snapshot itself is not
    // restored as a snapshot yet — that's step 2.
    const imp = spawnHostSync('incus', [
      'import', hostTarball, tempInstance,
    ], { encoding: 'utf-8', timeout: 60 * 60_000 });
    if (imp.status !== 0) {
      throw new Error(
        `incus import failed: ${(imp.stderr || imp.stdout || 'unknown').trim()}`
      );
    }
    importDone = true;

    // Step 2: copy the temp instance AS a new snapshot of the
    // target container.  Incus accepts `<source> <target>/<snap>`
    // which lands the source's state as a snapshot on target.
    const cp = spawnHostSync('incus', [
      'copy', tempInstance, `${incusName}/${snapshotName}`,
    ], { encoding: 'utf-8', timeout: 60 * 60_000 });
    if (cp.status !== 0) {
      throw new Error(
        `incus copy → snapshot failed: ${(cp.stderr || cp.stdout || 'unknown').trim()}`
      );
    }

    try {
      logAudit(audit.user_id || null, 'LXC_SNAPSHOT_S3_RESTORE', 'lxc_snapshot',
        `${incusName}/${snapshotName}`, {
          destination_id: destination?.id || null, s3_key: s3Key,
          size_bytes: buffer.length,
        }, audit.ip || null);
    } catch { /* tolerated */ }

    return { ok: true, sizeBytes: buffer.length };
  } catch (err) {
    return { ok: false, error: (err?.message || String(err)).slice(0, 1024) };
  } finally {
    // Always clean up the temp instance (whether copy succeeded
    // or not) — the snapshot is on the original container at this
    // point and the temp is just a staging area.
    if (importDone) {
      const del = spawnHostSync('incus', ['delete', '--force', tempInstance], {
        encoding: 'utf-8', timeout: 60_000,
      });
      if (del.status !== 0) {
        spawnHostSync('incus', ['stop', '--force', tempInstance], {
          encoding: 'utf-8', timeout: 30_000,
        });
        spawnHostSync('incus', ['delete', '--force', tempInstance], {
          encoding: 'utf-8', timeout: 60_000,
        });
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
    // Both export-time temps (pp-snapxp-<id>) and import-time
    // temps (pp-snapxp-imp-<id>) share the same prefix.
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

// In-process export queue.  Caps the number of `incus export`
// dances running in parallel — the export step is CPU + IO heavy
// and on small VMs (2 vCPU / 4 GB Linode-class) firing two at
// once starves the dashboard process.  Default 1 (serialized);
// configurable via PROXYPILOT_SNAPSHOT_EXPORT_CONCURRENCY for
// beefier hosts where parallelism is worth it.
//
// Pending rows in lxc_snapshot_s3_exports are inserted up front
// (so the UI shows 'pending' chips immediately even for queued
// jobs); the worker just dequeues a runFn and awaits it.
const QUEUE = {
  maxConcurrency: (() => {
    const raw = parseInt(process.env.PROXYPILOT_SNAPSHOT_EXPORT_CONCURRENCY || '1', 10);
    return Number.isFinite(raw) && raw >= 1 ? raw : 1;
  })(),
  running: new Map(), // jobId -> { containerName, snapshotName, startedAt }
  queue: [], // [{ jobId, containerName, snapshotName, runFn, resolve }]
};

function tickSnapshotExportQueue() {
  while (QUEUE.running.size < QUEUE.maxConcurrency && QUEUE.queue.length > 0) {
    const job = QUEUE.queue.shift();
    QUEUE.running.set(job.jobId, {
      containerName: job.containerName,
      snapshotName: job.snapshotName,
      startedAt: Date.now(),
    });
    Promise.resolve()
      .then(() => job.runFn())
      .then((result) => {
        QUEUE.running.delete(job.jobId);
        try { job.resolve(result); } catch { /* ignore */ }
        tickSnapshotExportQueue();
      })
      .catch((err) => {
        QUEUE.running.delete(job.jobId);
        try { job.resolve({ error: err?.message || String(err) }); } catch { /* ignore */ }
        tickSnapshotExportQueue();
      });
  }
}

function enqueueSnapshotExportJob({ jobId, containerName, snapshotName, runFn }) {
  return new Promise((resolve) => {
    QUEUE.queue.push({ jobId, containerName, snapshotName, runFn, resolve });
    tickSnapshotExportQueue();
  });
}

// getSnapshotExportQueueStatus() — feed for the global 'export in
// progress' banner.  Returns running + queued jobs + the
// configured concurrency cap, plus live byte progress for each
// running job (joined from lxc_snapshot_s3_exports so the banner
// can render a percentage without a separate query).
export function getSnapshotExportQueueStatus() {
  const db = getDb();
  const running = [];
  for (const [jobId, entry] of QUEUE.running) {
    let rows = [];
    try {
      rows = db.prepare(`
        SELECT e.id, e.destination_id, d.name AS destination_name,
               e.bytes_uploaded, e.bytes_total, e.cancel_requested, e.status
        FROM lxc_snapshot_s3_exports e
        LEFT JOIN backup_destinations d ON d.id = e.destination_id
        WHERE e.container_name = ? AND e.snapshot_name = ?
          AND e.status = 'pending'
      `).all(entry.containerName, entry.snapshotName);
    } catch { /* tolerated */ }
    const totalBytes = rows.reduce((s, r) => s + (r.bytes_total || 0), 0);
    const uploadedBytes = rows.reduce((s, r) => s + (r.bytes_uploaded || 0), 0);
    running.push({
      job_id: jobId,
      container_name: entry.containerName,
      snapshot_name: entry.snapshotName,
      started_at: entry.startedAt,
      bytes_uploaded: uploadedBytes,
      bytes_total: totalBytes || null,
      destinations: rows.map((r) => ({
        export_id: r.id,
        destination_id: r.destination_id,
        destination_name: r.destination_name || null,
        bytes_uploaded: r.bytes_uploaded || 0,
        bytes_total: r.bytes_total || null,
        cancel_requested: !!r.cancel_requested,
      })),
    });
  }
  return {
    max_concurrency: QUEUE.maxConcurrency,
    running,
    queued: QUEUE.queue.map((j) => ({
      job_id: j.jobId,
      container_name: j.containerName,
      snapshot_name: j.snapshotName,
    })),
    queue_depth: QUEUE.queue.length,
  };
}

// fanOutSnapshotExport({ incusName, snapshotName, destinations,
//                       audit }) → { results, size_bytes }
//
// Drives the export-and-push.  Inserts a 'pending' row in
// lxc_snapshot_s3_exports per destination up front so the UI
// renders 'in flight' immediately, then enqueues the actual
// export-and-upload work onto the in-process queue (concurrency
// capped — see QUEUE above).  Awaiting the returned promise
// blocks until this snapshot's queued slot has run.
//
// Cleanup of the tmp dir always runs via the worker's finally.
export async function fanOutSnapshotExport({
  containerName, incusName, snapshotName, destinations, audit = {},
}) {
  if (!Array.isArray(destinations) || destinations.length === 0) {
    return { results: [], skipped: 'no destinations' };
  }

  const db = getDb();

  // Insert 'pending' rows immediately so the UI sees the export
  // state without waiting for the worker to pick the job up.
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

  return enqueueSnapshotExportJob({
    jobId: uuid(),
    containerName,
    snapshotName,
    runFn: () => runSnapshotExport({
      containerName, incusName, snapshotName, destinations, exportIds, audit,
    }),
  });
}

// runSnapshotExport — the actual incus-export-and-S3-upload work.
// Called by the queue worker; never invoked directly by routes.
async function runSnapshotExport({
  containerName, incusName, snapshotName, destinations, exportIds, audit,
}) {
  const db = getDb();
  const results = [];

  // Early exit: an operator may have cancelled every destination
  // while this job sat in the queue.  Bail before the expensive
  // `incus copy/export` dance kicks off.
  const checkCanceled = db.prepare(
    `SELECT cancel_requested FROM lxc_snapshot_s3_exports WHERE id = ?`
  );
  const allCanceled = [...exportIds.values()].every((id) => {
    const r = checkCanceled.get(id);
    return r && r.cancel_requested;
  });
  if (allCanceled) {
    for (const dest of destinations) {
      db.prepare(`
        UPDATE lxc_snapshot_s3_exports
        SET status = 'failed', error = 'canceled by operator',
            finished_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(exportIds.get(dest.id));
      results.push({
        destination_id: dest.id, destination_name: dest.name,
        ok: false, error: 'canceled by operator', canceled: true,
      });
    }
    return { results, skipped: 'all destinations canceled' };
  }

  // One shared `incus export` for every destination — same
  // tarball pushed N times.
  const exported = await exportSnapshotToTmp({ incusName, snapshotName });
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
