import { spawnSync } from 'node:child_process';
import { getDb } from '../../db/index.js';

/**
 * Best-effort `last_seen_at` tracker. Parses `last -F -i -n 200`, takes
 * the most-recent login per unix_user, and updates last_seen_at for
 * every ACTIVE ssh_access row of that user.
 *
 * Limitation per spec: `last` doesn't tell us which key authenticated,
 * only that <user> logged in from <ip> at <time>. So every active row
 * of the same unix_user gets the same timestamp. If the operator
 * enables sshd LogLevel VERBOSE plus a journal scan, per-key matching
 * becomes possible — but the dashboard tooltip already documents the
 * coarseness.
 *
 * Idempotent: only updates rows where the candidate timestamp is
 * strictly newer than the stored one. Safe to run on a 5-minute timer
 * AND on every dashboard load.
 */
export function touchLastSeen({ now = new Date() } = {}) {
  const r = spawnSync('last', ['-F', '-i', '-n', '200'], { encoding: 'utf-8' });
  if (r.status !== 0) {
    return { ok: false, reason: `last invocation failed: ${(r.stderr || '').trim() || r.error?.message || 'unknown'}`, updated: 0 };
  }
  const lines = (r.stdout || '').split('\n');
  const latestByUser = new Map();
  for (const line of lines) {
    const parsed = parseLastLine(line);
    if (!parsed) continue;
    const prev = latestByUser.get(parsed.user);
    if (!prev || parsed.start > prev) {
      latestByUser.set(parsed.user, parsed.start);
    }
  }

  const db = getDb();
  const stmt = db.prepare(`
    UPDATE ssh_access
    SET last_seen_at = ?
    WHERE unix_user = ?
      AND revoked_at IS NULL
      AND (last_seen_at IS NULL OR last_seen_at < ?)
  `);
  let updated = 0;
  const tx = db.transaction(() => {
    for (const [user, when] of latestByUser) {
      // Defensive: never set last_seen_at into the future (clock skew or
      // mis-parse). Cap at "now".
      const ts = (when > now ? now : when).toISOString();
      const res = stmt.run(ts, user, ts);
      updated += res.changes;
    }
  });
  tx();
  return { ok: true, updated, users_seen: latestByUser.size };
}

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

/**
 * `last -F -i` lines look like:
 *   root pts/0 1.2.3.4 Wed Apr 30 14:21:00 2026   still logged in
 *   alice pts/1 5.6.7.8 Wed Apr 30 13:00:00 2026 - Wed Apr 30 14:00:00 2026 (01:00)
 *   reboot system boot 6.1.0-x Wed Apr 30 12:00:00 2026 ...
 * Skip wtmp begins / no entries / reboot / blank lines. Be lenient about
 * the trailing duration; we only care about the start time.
 */
export function parseLastLine(line) {
  if (!line || /^wtmp begins/.test(line) || /^$/.test(line)) return null;
  const parts = line.trim().split(/\s+/);
  if (parts.length < 8) return null;
  const user = parts[0];
  if (user === 'reboot' || user === 'shutdown' || user === '~') return null;
  // The date sits at parts[3..7]: Wed Apr 30 14:21:00 2026
  // (parts[2] is the IP / hostname; parts[3] is the weekday).
  const monthIdx = MONTHS.indexOf(parts[4]);
  if (monthIdx < 0) return null;
  const day = Number(parts[5]);
  const time = parts[6];
  const year = Number(parts[7]);
  if (!Number.isInteger(day) || !Number.isInteger(year) || !/^\d{2}:\d{2}:\d{2}$/.test(time)) {
    return null;
  }
  const [h, m, s] = time.split(':').map(Number);
  const start = new Date(Date.UTC(year, monthIdx, day, h, m, s));
  // Convert from local-time interpretation: `last` prints local time.
  // We assume the host's TZ; `Date` constructed with UTC fields and the
  // host's offset gives an approximation that's good enough for relative
  // "5 minutes ago" displays. Sub-day precision is plenty here.
  const offsetMin = new Date(year, monthIdx, day, h, m, s).getTimezoneOffset();
  start.setUTCMinutes(start.getUTCMinutes() + offsetMin);
  if (Number.isNaN(start.getTime())) return null;
  return { user, start };
}
