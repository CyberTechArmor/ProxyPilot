// Mock2 singleton settings (mock2_settings key/value, in mock2.db). Native
// (better-sqlite3) via getMock2Db — reached only on an enabled host through the
// gated router. M3 uses it for the idle-stop window; later phases add the lock
// idle timeout (ADR-004) and quota buffer through the same table.
//
// The pure decision logic (isIdleStale) lives in project-logic.js so it stays
// unit-testable without this module.
//
// Terminology (risk R7): nothing here is named "agent".

import { getMock2Db } from './db.js';

const nowIso = () => new Date().toISOString();

export const IDLE_STOP_DAYS_KEY = 'idle_stop_days';
// Default idle window when the operator has not set one. 0 = DISABLED: M3 ships
// idle-stop as opt-in groundwork, so an enabled host does not start stopping
// containers until the operator sets a positive window (M9 adds the timer-driven
// enforcement + derived-status polish). Overridable at deploy time via env.
const DEFAULT_IDLE_STOP_DAYS = 0;

export function getMock2Setting(key, fallback = null) {
  const row = getMock2Db().prepare(`SELECT value FROM mock2_settings WHERE key = ?`).get(key);
  return row ? row.value : fallback;
}

export function setMock2Setting(key, value, updatedBy = null) {
  getMock2Db()
    .prepare(
      `INSERT INTO mock2_settings (key, value, updated_at, updated_by)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    )
    .run(key, String(value), nowIso(), updatedBy);
  return getMock2Setting(key);
}

// The configured idle-stop window in days. 0 (or an unparseable value) disables
// idle-stop entirely. Precedence: stored setting → MOCK2_IDLE_STOP_DAYS env →
// built-in default.
export function getIdleStopDays() {
  const raw = getMock2Setting(IDLE_STOP_DAYS_KEY, process.env.MOCK2_IDLE_STOP_DAYS || String(DEFAULT_IDLE_STOP_DAYS));
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_IDLE_STOP_DAYS;
  return n;
}
