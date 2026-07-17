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
import { GATE_MODE_ENFORCE, normalizeGateMode } from './accept-pending-logic.js';
import { COMPONENT_AUTO_APPLY_ON, normalizeComponentAutoApply } from './component-logic.js';

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

// ---- Egress policy mode (M4/ADR-010 monitor mode) ----
export const EGRESS_MODE_KEY = 'egress_mode';
export const EGRESS_MODE_ALLOWLIST = 'allowlist';
export const EGRESS_MODE_ALLOW_ALL = 'allow-all';

// The egress policy mode:
//   'allowlist' (default) — each project container may reach ONLY its
//     per-project allowlisted hosts (the ADR-010 containment posture).
//   'allow-all' (monitor) — the proxy permits EVERY destination for the project
//     bridges, but egress is STILL funneled through squid (the bridge fence
//     blocks any bypass), so squid's access log records every host each container
//     reaches. Use it to discover what to allowlist, then switch back to enforce.
// Precedence: stored setting → MOCK2_EGRESS_MODE env → 'allowlist'.
export function getEgressMode() {
  const raw = String(getMock2Setting(EGRESS_MODE_KEY, process.env.MOCK2_EGRESS_MODE || EGRESS_MODE_ALLOWLIST)).trim();
  return raw === EGRESS_MODE_ALLOW_ALL ? EGRESS_MODE_ALLOW_ALL : EGRESS_MODE_ALLOWLIST;
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

// ---- Concept chat message limit (max characters per chat message) ----
export const CHAT_MAX_CHARS_KEY = 'chat_max_chars';
// The selectable ceilings the operator may choose from. Bounded at 32k so a
// single chat turn can't blow past the concept model's input budget.
export const CHAT_MAX_CHARS_OPTIONS = [4000, 8000, 16000, 32000];
const DEFAULT_CHAT_MAX_CHARS = 16000;

// The configured per-message character ceiling for the concept chat composer.
// Only the discrete CHAT_MAX_CHARS_OPTIONS are honoured; any stored/env value
// outside that set falls back to the default. Precedence: stored setting →
// MOCK2_CHAT_MAX_CHARS env → built-in default.
export function getChatMaxChars() {
  const raw = getMock2Setting(CHAT_MAX_CHARS_KEY, process.env.MOCK2_CHAT_MAX_CHARS || String(DEFAULT_CHAT_MAX_CHARS));
  const n = Number(raw);
  return CHAT_MAX_CHARS_OPTIONS.includes(n) ? n : DEFAULT_CHAT_MAX_CHARS;
}

// ---- Integration-gate mode (the block/approve loop relief valve) ----
export const INTEGRATION_GATE_MODE_KEY = 'integration_gate_mode';

// The integration-truthfulness gate mode the runner consults at finish. The
// decision logic + mode meanings live in accept-pending-logic.js (pure); this is
// just the native reader. Precedence: stored setting → MOCK2_INTEGRATION_GATE_MODE
// env → 'enforce' (safe default). Any unknown value normalizes to 'enforce'.
export function getIntegrationGateMode() {
  const raw = getMock2Setting(INTEGRATION_GATE_MODE_KEY, process.env.MOCK2_INTEGRATION_GATE_MODE || GATE_MODE_ENFORCE);
  return normalizeGateMode(raw);
}

// ---- Component auto-apply (every published component, every build) ----
export const COMPONENT_AUTO_APPLY_KEY = 'component_auto_apply';

// Whether the platform confirms EVERY published standard component for every
// build (origin 'auto', installed by the deterministic zero-token pre-install)
// instead of only suggesting on a capability match and waiting for a per-project
// confirm. Returns a boolean. Precedence: stored setting →
// MOCK2_COMPONENT_AUTO_APPLY env → 'on' (reuse is the default — the component
// library exists to be used, not rebuilt from scratch).
export function getComponentAutoApply() {
  const raw = getMock2Setting(COMPONENT_AUTO_APPLY_KEY, process.env.MOCK2_COMPONENT_AUTO_APPLY || COMPONENT_AUTO_APPLY_ON);
  return normalizeComponentAutoApply(raw) === COMPONENT_AUTO_APPLY_ON;
}
