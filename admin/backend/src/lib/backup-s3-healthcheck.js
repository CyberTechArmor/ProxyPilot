// Daily S3 connection probe.
//
// One in-process node-cron task runs at 02:30 host time, walks
// every backup_destinations row, fires testConnection() on each,
// and posts a notification on failure (with the destination's
// row id baked into the dedupe_key so a chronically-broken
// destination occupies exactly one row in the bell).
//
// Why 02:30: most operators run nightly backups at 03:00 (the
// schedule picker's default), so probing 30 minutes earlier
// gives a heads-up before the night's backup tries to write to
// a degraded bucket.  The default cron expression is
// overridable via PROXYPILOT_S3_HEALTHCHECK_CRON for operators
// on different schedules.
//
// Recovery handling: a destination that probes ok after one or
// more failures auto-resolves the existing notification via
// resolveNotification(dedupe_key) — operators see the bell row
// disappear when the underlying issue is fixed, not just sit
// there as an artifact of yesterday's outage.

import cron from 'node-cron';
import { getDb } from '../db.js';
import { testConnection } from './s3.js';
import { postNotification, resolveNotification } from './notifications.js';

const DEFAULT_CRON = '30 2 * * *';
let task = null;
let logger = (msg, ctx) => console.log(`[s3-healthcheck] ${msg}`, ctx ?? '');

export function setLogger(fn) { if (typeof fn === 'function') logger = fn; }

function dedupeKey(destId) {
  return `backup-s3-healthcheck:${destId}`;
}

// runOnce — fire the probe NOW for every destination.  Used by
// both the scheduled task and the operator's 'Run health check
// now' button (POST /api/backups/storage/healthcheck).
export async function runOnce() {
  const rows = getDb().prepare(
    `SELECT * FROM backup_destinations`
  ).all();

  const results = [];
  for (const dest of rows) {
    const verdict = await testConnection(dest);
    const status = verdict.ok ? 'ok' : `error: ${verdict.error || 'unknown'}`;
    const ts = new Date().toISOString();
    getDb().prepare(
      `UPDATE backup_destinations SET test_status = ?, test_at = ? WHERE id = ?`
    ).run(status, ts, dest.id);

    if (verdict.ok) {
      // Recovery: drop the previous failure notification (if any).
      resolveNotification(dedupeKey(dest.id), { reason: 'probe ok' });
    } else {
      try {
        postNotification({
          level: 'error',
          title: `Backup destination unreachable: ${dest.name}`,
          body: `S3-compatible destination "${dest.name}" (${dest.bucket} @ ${dest.endpoint_url}) failed its health check: ${verdict.error || 'unknown error'}.\n\nScheduled backups targeting this destination will fail until it recovers.`,
          source: 'backup-s3-healthcheck',
          source_id: dest.id,
          dedupe_key: dedupeKey(dest.id),
        });
      } catch (err) {
        // Tolerated: notification posting failure shouldn't kill
        // the probe.  The verdict is still persisted on the
        // destination row above.
        logger('postNotification failed', { dest: dest.id, error: err?.message });
      }
    }

    results.push({
      destination_id: dest.id,
      name: dest.name,
      ok: verdict.ok,
      latency_ms: verdict.latency_ms,
      error: verdict.error || null,
    });
  }
  return results;
}

// register / unregister the cron task.  hydrate() is called from
// index.js on boot alongside the backup-scheduler hydrate.
export function register() {
  unregister();
  const expr = process.env.PROXYPILOT_S3_HEALTHCHECK_CRON || DEFAULT_CRON;
  try {
    task = cron.schedule(expr, () => {
      runOnce().catch((err) => logger('runOnce threw', { error: err?.message }));
    }, {
      scheduled: true,
      timezone: process.env.TZ || 'UTC',
    });
    logger(`registered (cron=${expr})`);
  } catch (err) {
    logger('register failed', { error: err?.message });
  }
}

export function unregister() {
  if (task) {
    try { task.stop(); } catch { /* ignore */ }
    task = null;
  }
}

export function hydrate() {
  // Skip in test/dev unless explicitly enabled — saves a 30 ms
  // cron registration per node --test invocation.
  if (process.env.PROXYPILOT_DISABLE_CRONS === '1') return;
  register();
}
