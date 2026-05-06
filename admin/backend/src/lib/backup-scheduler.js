// In-process cron worker for the Backups feature.
//
// One instance lives in the dashboard process.  Hydrates from the
// `backup_schedules` table on boot and re-registers on every CRUD
// mutation (the routes call register/unregister directly).
//
// Concurrency model: a single in-memory queue with a serial worker.
// The spec calls this out — most operators can't afford two
// parallel `incus export` runs without disk thrashing — and we
// honor it here with a simple boolean lock + FIFO array.  Each
// schedule tick that fires while the worker is busy is enqueued
// and runs when the prior job finishes; if a schedule fires twice
// before the queue drains, the duplicate is dropped (not queued
// twice — there's no value in running an identical backup
// back-to-back).
//
// Retention is part of every successful run: after upload, prune
// past `backups` rows that fail BOTH retention gates (older than
// keep AND older than days), and delete the corresponding S3
// objects.  Failures during prune are logged but don't fail the
// run — the artifact we just wrote is the user-visible value.

import cron from 'node-cron';
import { v4 as uuid } from 'uuid';
import { getDb, logAudit } from '../db.js';
import { decryptSecret } from './secrets.js';
import {
  packConfigTier,
  packConfigPlusDataTier,
  packFullTier,
} from './backup-pack.js';
import { putObject, deleteObject, buildKey } from './s3.js';

// Map of schedule_id → cron task.  Used so we can dispose tasks
// when an operator disables / deletes a schedule.
const tasks = new Map();

// Serial worker state.
let busy = false;
const queue = []; // [{ scheduleId, runOnce: bool }]
const queuedIds = new Set(); // de-dup guard

let logger = (msg, ctx) => console.log(`[backup-scheduler] ${msg}`, ctx ?? '');
let errLogger = (msg, ctx) => console.error(`[backup-scheduler] ${msg}`, ctx ?? '');

export function setLogger(fn) { if (typeof fn === 'function') logger = fn; }
export function setErrLogger(fn) { if (typeof fn === 'function') errLogger = fn; }

// node-cron parser is permissive but not lenient — invalid expressions
// throw at .schedule() time.  Validate up front so the route layer can
// 400 with a clear message rather than uncaught-throw-kill the worker.
export function isValidCronExpr(expr) {
  if (typeof expr !== 'string' || expr.length === 0) return false;
  try {
    return cron.validate(expr);
  } catch {
    return false;
  }
}

// Compute the next firing time of a cron expression in milliseconds
// since epoch.  node-cron doesn't expose a `nextDate` helper directly,
// so we walk the next 366 days at 1-minute resolution looking for
// matches.  The tradeoff: we're O(366*24*60) at register-time, but
// this only runs on schedule mutations (rare) so the cost is fine.
//
// Returns null if no firing happens within the next year (which
// indicates a malformed-but-validate-passed expression).
export function computeNextRunMs(expr, fromMs = Date.now()) {
  if (!isValidCronExpr(expr)) return null;
  // node-cron's docs use 5- or 6-field expressions; both work via
  // its validator.  We don't try to match by sampling minute by
  // minute (~525k iters/year — fine in JS) — instead we let
  // node-cron's parser do the work via getNextRun if available.
  // node-cron@3 exposes `cron.getTasks()` but not nextRun, so the
  // sampling approach is the portable path.
  const start = new Date(fromMs + 60_000); // skip the current minute
  start.setSeconds(0, 0);
  for (let i = 0; i < 366 * 24 * 60; i += 1) {
    const t = new Date(start.getTime() + i * 60_000);
    if (cronMatches(expr, t)) return t.getTime();
  }
  return null;
}

// Hand-rolled cron matcher — node-cron doesn't expose .test() in
// v3.  Supports the standard 5-field form (m h dom mon dow) and
// the optional 6-field (with seconds prefix).  Each field accepts
// '*', a comma list, a range, a /step, or a literal int.
function cronMatches(expr, dt) {
  const parts = expr.trim().split(/\s+/);
  if (parts.length < 5 || parts.length > 6) return false;
  // Drop seconds field if present — we only schedule at minute
  // resolution.  6-field expressions where seconds != 0 will never
  // match at our 1-minute sampling and that's fine.
  const fields = parts.length === 5 ? parts : parts.slice(1);
  const [mField, hField, domField, monField, dowField] = fields;
  return (
    matchField(mField, dt.getMinutes(), 0, 59)
    && matchField(hField, dt.getHours(), 0, 23)
    && matchField(domField, dt.getDate(), 1, 31)
    && matchField(monField, dt.getMonth() + 1, 1, 12)
    && matchField(dowField, dt.getDay(), 0, 7) // 0 + 7 both = Sunday
  );
}

function matchField(field, value, lo, hi) {
  if (field === '*') return true;
  for (const piece of field.split(',')) {
    let step = 1;
    let body = piece;
    if (body.includes('/')) {
      const [b, s] = body.split('/');
      body = b || '*';
      step = parseInt(s, 10) || 1;
    }
    let from = lo;
    let to = hi;
    if (body !== '*') {
      if (body.includes('-')) {
        const [a, b] = body.split('-').map((n) => parseInt(n, 10));
        from = a; to = b;
      } else {
        const n = parseInt(body, 10);
        if (Number.isNaN(n)) continue;
        from = n; to = n;
      }
    }
    for (let v = from; v <= to; v += step) {
      // Day-of-week: '7' equals Sunday (== 0).
      if (lo === 0 && hi === 7 && v === 7) {
        if (value === 0) return true;
        continue;
      }
      if (v === value) return true;
    }
  }
  return false;
}

// ── registration ────────────────────────────────────────────────────

// register(row) — idempotent; replaces an existing task for the
// same id.  Updates next_run_at on the row so the UI can render
// "next in N hours".
export function register(row) {
  if (!row || !row.id) throw new Error('register: row.id is required');
  unregister(row.id);
  if (!row.enabled) return;

  if (!isValidCronExpr(row.cron_expr)) {
    errLogger('skipping schedule with invalid cron_expr', { id: row.id, cron_expr: row.cron_expr });
    return;
  }

  const task = cron.schedule(row.cron_expr, () => enqueue(row.id), {
    scheduled: true,
    timezone: process.env.TZ || 'UTC',
  });
  tasks.set(row.id, task);

  const nextMs = computeNextRunMs(row.cron_expr);
  if (nextMs) {
    try {
      getDb().prepare(`UPDATE backup_schedules SET next_run_at = ? WHERE id = ?`)
        .run(new Date(nextMs).toISOString(), row.id);
    } catch (err) {
      errLogger('failed to persist next_run_at', { id: row.id, error: err?.message });
    }
  }
}

export function unregister(id) {
  const t = tasks.get(id);
  if (!t) return;
  try { t.stop(); } catch { /* ignore */ }
  tasks.delete(id);
}

// hydrate — call once at server boot.  Reads every enabled
// schedule and registers it.  No-op when the schedules table
// doesn't exist yet (i.e. an install that hasn't run migration
// 202 — which can't happen on the same release cycle, but the
// defensive check costs nothing).
export function hydrate() {
  try {
    const rows = getDb()
      .prepare(`SELECT * FROM backup_schedules WHERE enabled = 1`)
      .all();
    for (const r of rows) register(r);
    logger(`hydrated ${rows.length} schedule(s)`);
  } catch (err) {
    errLogger('hydrate failed', { error: err?.message });
  }
}

// ── enqueue + worker ───────────────────────────────────────────────

export function enqueue(scheduleId, { runOnce = false } = {}) {
  if (queuedIds.has(scheduleId) && !runOnce) {
    // Cron tick fired before the previous run finished.  Drop the
    // duplicate — there's no value in running the same backup
    // twice in succession.  The next tick will re-evaluate.
    return false;
  }
  queue.push({ scheduleId, runOnce });
  queuedIds.add(scheduleId);
  setImmediate(drain);
  return true;
}

async function drain() {
  if (busy) return;
  const next = queue.shift();
  if (!next) return;
  busy = true;
  try {
    await runSchedule(next.scheduleId);
  } catch (err) {
    errLogger('runSchedule threw', { id: next.scheduleId, error: err?.message });
  } finally {
    queuedIds.delete(next.scheduleId);
    busy = false;
    if (queue.length) setImmediate(drain);
  }
}

async function runSchedule(scheduleId) {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM backup_schedules WHERE id = ?`).get(scheduleId);
  if (!row) return;
  const dest = db.prepare(`SELECT * FROM backup_destinations WHERE id = ?`).get(row.destination_id);
  if (!dest) {
    db.prepare(
      `UPDATE backup_schedules SET last_run_status = 'failed',
                                   last_run_error = 'destination missing',
                                   last_run_at = CURRENT_TIMESTAMP WHERE id = ?`
    ).run(row.id);
    return;
  }

  const id = uuid();
  const objectName = `${id}.ppbackup`;
  const s3Key = buildKey(dest, objectName);

  db.prepare(`
    INSERT INTO backups (id, destination_id, tier, scope, s3_key, encrypted,
                        created_by, manifest_json, status)
    VALUES (?, ?, ?, ?, ?, 1, ?, '{}', 'in_progress')
  `).run(
    id, dest.id, row.tier, row.scope || null, s3Key,
    `schedule:${row.id}`,
  );

  let passphrase;
  try {
    passphrase = decryptSecret(row.passphrase_enc);
  } catch (err) {
    fail(id, row.id, `passphrase decrypt failed: ${err?.message || err}`);
    return;
  }
  if (!passphrase) {
    fail(id, row.id, 'schedule has no stored passphrase');
    return;
  }

  let packed;
  try {
    if (row.tier === 'config') {
      packed = await packConfigTier({
        db, passphrase,
        envPath: process.env.PROXYPILOT_ENV_PATH || '/opt/proxypilot/.env',
        cveInboxDir: process.env.PROXYPILOT_CVE_INBOX_DIR || '/var/lib/proxypilot/cve-inbox',
        meta: { backup_id: id, schedule_id: row.id, schedule_name: row.name },
      });
    } else if (row.tier === 'config_plus_data') {
      packed = await packConfigPlusDataTier({
        db, passphrase,
        envPath: process.env.PROXYPILOT_ENV_PATH || '/opt/proxypilot/.env',
        cveInboxDir: process.env.PROXYPILOT_CVE_INBOX_DIR || '/var/lib/proxypilot/cve-inbox',
        installDir: process.env.PROXYPILOT_INSTALL_DIR || '/opt/proxypilot',
        meta: { backup_id: id, schedule_id: row.id, schedule_name: row.name },
      });
    } else if (row.tier === 'full') {
      packed = await packFullTier({
        db, passphrase,
        envPath: process.env.PROXYPILOT_ENV_PATH || '/opt/proxypilot/.env',
        cveInboxDir: process.env.PROXYPILOT_CVE_INBOX_DIR || '/var/lib/proxypilot/cve-inbox',
        installDir: process.env.PROXYPILOT_INSTALL_DIR || '/opt/proxypilot',
        meta: { backup_id: id, schedule_id: row.id, schedule_name: row.name },
      });
    } else {
      throw new Error(`unsupported tier ${row.tier}`);
    }
  } catch (err) {
    fail(id, row.id, `pack failed: ${err?.message || err}`);
    return;
  }

  try {
    await putObject(dest, s3Key, packed.buffer, {
      contentType: 'application/octet-stream',
    });
  } catch (err) {
    fail(id, row.id, `upload failed: ${err?.message || err}`);
    return;
  }

  db.prepare(`
    UPDATE backups SET status = 'ok', size_bytes = ?, manifest_json = ?
    WHERE id = ?
  `).run(packed.buffer.length, JSON.stringify(packed.manifest), id);

  db.prepare(`
    UPDATE backup_schedules
    SET last_run_at = CURRENT_TIMESTAMP, last_run_status = 'ok', last_run_error = NULL
    WHERE id = ?
  `).run(row.id);

  logAudit(null, 'BACKUP_SCHEDULED_RUN', 'backup', id, {
    schedule_id: row.id,
    schedule_name: row.name,
    destination_id: dest.id,
    s3_key: s3Key,
    tier: row.tier,
    size_bytes: packed.buffer.length,
  }, null);

  await applyRetention(row, dest);

  // Re-compute next_run_at so the UI updates without waiting for
  // a manual refresh of the schedule page.
  const nextMs = computeNextRunMs(row.cron_expr);
  if (nextMs) {
    db.prepare(`UPDATE backup_schedules SET next_run_at = ? WHERE id = ?`)
      .run(new Date(nextMs).toISOString(), row.id);
  }
}

function fail(backupId, scheduleId, reason) {
  const db = getDb();
  db.prepare(`UPDATE backups SET status = 'failed', error = ? WHERE id = ?`)
    .run(reason, backupId);
  db.prepare(`
    UPDATE backup_schedules
    SET last_run_at = CURRENT_TIMESTAMP, last_run_status = 'failed', last_run_error = ?
    WHERE id = ?
  `).run(reason, scheduleId);
  errLogger('schedule run failed', { schedule_id: scheduleId, backup_id: backupId, reason });
}

// applyRetention — drop rows + S3 objects that fail BOTH retention
// gates.  Both gates additive; either NULL disables that axis.
//
// Safety rail: never prune the most recent backup for a given
// schedule.  Even with keep=0, the operator deserves at least one
// successful artifact in the bucket.
export async function applyRetention(scheduleRow, destRow) {
  const keep = scheduleRow.retention_keep ?? null;
  const days = scheduleRow.retention_days ?? null;
  if (keep == null && days == null) return;

  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM backups
    WHERE created_by = ? AND status = 'ok'
    ORDER BY created_at DESC, id DESC
  `).all(`schedule:${scheduleRow.id}`);

  if (rows.length <= 1) return; // never prune the only remaining

  const cutoffMs = days != null ? Date.now() - days * 86400_000 : null;

  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    const ageMs = Date.now() - new Date(r.created_at).getTime();
    const failsKeep = keep != null ? i >= keep : true;
    const failsDays = cutoffMs != null ? ageMs > days * 86400_000 : true;

    // Both axes must say "prune" before we drop anything.  And i=0
    // (newest) is always preserved.
    if (i === 0) continue;
    if (!(failsKeep && failsDays)) continue;

    try {
      await deleteObject(destRow, r.s3_key);
    } catch (err) {
      errLogger('retention: S3 delete failed', { backup_id: r.id, error: err?.message });
      // Don't drop the DB row if S3 still has the object —
      // otherwise the dashboard loses visibility into the
      // orphan.  Operator can rerun retention manually after
      // S3 recovers.
      continue;
    }
    db.prepare(`DELETE FROM backups WHERE id = ?`).run(r.id);
    logAudit(null, 'BACKUP_RETENTION_PRUNE', 'backup', r.id, {
      schedule_id: scheduleRow.id,
      reason: { keep, days, age_days: Math.floor(ageMs / 86400_000), index: i },
    }, null);
  }
}

// Test hook — drains the queue synchronously for the current task
// without setImmediate scheduling.  Tests use this to assert
// register → enqueue → run round-trip without a wall-clock wait.
export async function __drainForTest() {
  while (queue.length || busy) {
    if (!busy && queue.length) {
      const next = queue.shift();
      busy = true;
      try { await runSchedule(next.scheduleId); }
      finally {
        queuedIds.delete(next.scheduleId);
        busy = false;
      }
    } else {
      await new Promise((r) => setImmediate(r));
    }
  }
}

export const __test = Object.freeze({
  cronMatches, matchField, register, unregister, hydrate, computeNextRunMs,
});
