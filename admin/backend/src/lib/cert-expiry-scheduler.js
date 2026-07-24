// Manual TLS certificate expiry monitor.
//
// Pasted certs do NOT auto-renew (unlike ACME certs, which Caddy renews on its
// own). A daily in-process node-cron task walks every tls_certificates row,
// classifies it (valid / expiring-soon / expired) and posts a notification for
// anything within the warning window — with the row id in the dedupe_key so a
// chronically-near-expiry cert occupies exactly one bell row. A cert that is
// rotated back into the valid window auto-resolves its notification.
//
// Mirrors lib/backup-s3-healthcheck.js (same register/unregister/hydrate shape,
// same PROXYPILOT_DISABLE_CRONS test guard). The classification itself lives in
// the pure lib/tls-certs.js (expiryStatus/daysUntil), so it is unit-tested there.

import cron from 'node-cron';
import { getDb } from '../db.js';
import { postNotification, resolveNotification } from './notifications.js';
import { expiryStatus, daysUntil, DEFAULT_EXPIRY_WARN_DAYS } from './tls-certs.js';

const DEFAULT_CRON = '15 3 * * *'; // 03:15 host time, daily
let task = null;
let logger = (msg, ctx) => console.log(`[cert-expiry] ${msg}`, ctx ?? '');

export function setLogger(fn) { if (typeof fn === 'function') logger = fn; }

function dedupeKey(id) { return `tls-cert-expiry:${id}`; }

function warnDays() {
  const n = Number(process.env.PROXYPILOT_CERT_EXPIRY_WARN_DAYS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_EXPIRY_WARN_DAYS;
}

// runOnce — classify every pasted cert NOW. Returns a summary the "check now"
// button (if wired) can surface. Expiring/expired → warning/error notification;
// a cert back in the valid window resolves its prior notification.
export function runOnce({ nowMs = null } = {}) {
  let rows = [];
  try { rows = getDb().prepare('SELECT id, label, not_after FROM tls_certificates').all(); }
  catch (err) { logger('query failed', { error: err?.message }); return { checked: 0, flagged: 0 }; }
  const days = warnDays();
  let flagged = 0;
  for (const row of rows) {
    const status = expiryStatus(row.not_after, nowMs, days);
    const key = dedupeKey(row.id);
    if (status === 'expired' || status === 'expiring') {
      flagged += 1;
      const left = daysUntil(row.not_after, nowMs);
      const expired = status === 'expired';
      postNotification({
        level: expired ? 'error' : 'warning',
        title: expired ? `TLS certificate expired: ${row.label}` : `TLS certificate expiring soon: ${row.label}`,
        body: expired
          ? `The pasted certificate "${row.label}" expired ${Math.abs(left ?? 0)} day(s) ago and will not be renewed automatically. Rotate it on the TLS Certificates page.`
          : `The pasted certificate "${row.label}" expires in ${left} day(s). Manual certs do not auto-renew — rotate it on the TLS Certificates page.`,
        source: 'cert-expiry',
        source_id: String(row.id),
        dedupe_key: key,
      });
    } else {
      // Valid (or unparseable) → clear any stale warning.
      resolveNotification(key, { reason: 'rotated or renewed' });
    }
  }
  return { checked: rows.length, flagged };
}

export function register() {
  unregister();
  const expr = process.env.PROXYPILOT_CERT_EXPIRY_CRON || DEFAULT_CRON;
  try {
    task = cron.schedule(expr, () => {
      try { runOnce(); } catch (err) { logger('runOnce threw', { error: err?.message }); }
    }, { scheduled: true, timezone: process.env.TZ || 'UTC' });
    logger(`registered (cron=${expr})`);
  } catch (err) {
    logger('register failed', { error: err?.message });
  }
}

export function unregister() {
  if (task) { try { task.stop(); } catch { /* ignore */ } task = null; }
}

export function hydrate() {
  if (process.env.PROXYPILOT_DISABLE_CRONS === '1') return;
  register();
  // Run once shortly after boot so a cert that expired while the server was down
  // is flagged without waiting for the next 03:15 tick.
  setTimeout(() => { try { runOnce(); } catch { /* best effort */ } }, 5000).unref?.();
}
