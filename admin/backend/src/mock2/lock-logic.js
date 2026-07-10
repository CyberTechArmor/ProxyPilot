// Mock2 checkout-lock PURE decision layer (Phase M6, ADR-004). Native-free,
// unit-tested stub-first (risk R9). The lock guards the CONTAINER (working tree
// + dev server + project DB), so there is exactly one lock per project, held by
// whatever writes — a human session or a cycle. Branch-per-user is foreclosed by
// this ADR: any future multi-writer feature needs per-writer containers, not a
// second holder on this row.
//
// Everything here is deterministic time/holder arithmetic over a mock2_locks row
// so locks.js (the thin better-sqlite3 half) and the tests can both drive it. The
// idle timer counts from last_write_at; auto-release always checkpoints first
// (the commit lives in the runner, not here — this layer only DECIDES).
//
// Terminology (risk R7): the AI build component is the runner; nothing here is
// named "agent".

// mock2_settings key + default for the idle timeout (ADR-004: default 15 min,
// admin-configurable). Warn window: how long before expiry the holder is warned
// (chat banner + keep-working button in M7; the flag is surfaced now).
export const LOCK_IDLE_MINUTES_KEY = 'lock_idle_minutes';
export const DEFAULT_LOCK_IDLE_MINUTES = 15;
export const LOCK_WARN_SECONDS = 120;

// The holder of a lock row, or null. Exactly one of holder_user_id /
// holder_cycle_id is set on a live lock (03-data-model.md).
export function lockHolder(lockRow) {
  if (!lockRow) return null;
  if (lockRow.holder_cycle_id != null) return { type: 'cycle', id: Number(lockRow.holder_cycle_id) };
  if (lockRow.holder_user_id != null) return { type: 'user', id: Number(lockRow.holder_user_id) };
  return null;
}

// Milliseconds since the last write on this lock (the idle-timer basis). NaN if
// timestamps are unparseable — callers treat NaN as "unknown", never as expired.
export function msSinceWrite(lockRow, nowIso) {
  if (!lockRow?.last_write_at) return NaN;
  const last = Date.parse(lockRow.last_write_at);
  const now = Date.parse(nowIso);
  if (!Number.isFinite(last) || !Number.isFinite(now)) return NaN;
  return now - last;
}

// Milliseconds until this lock idle-expires (negative once past). null when the
// lock is absent or its timestamps are unreadable.
export function timeRemainingMs(lockRow, nowIso, idleMinutes = DEFAULT_LOCK_IDLE_MINUTES) {
  const since = msSinceWrite(lockRow, nowIso);
  if (!Number.isFinite(since)) return null;
  return Math.max(0, Number(idleMinutes)) * 60000 - since;
}

// Has the lock gone idle past its timeout? A malformed timestamp is NOT expired
// (fail safe — never auto-release a lock we can't reason about).
export function isLockExpired(lockRow, nowIso, idleMinutes = DEFAULT_LOCK_IDLE_MINUTES) {
  const remaining = timeRemainingMs(lockRow, nowIso, idleMinutes);
  if (remaining == null) return false;
  return remaining <= 0;
}

// Is the holder inside the warn-before-expiry window (ADR-004)? Used to raise the
// "keep working?" banner. False when already expired (that's auto-release, not a
// warning) or when the lock is unreadable.
export function inWarnWindow(lockRow, nowIso, idleMinutes = DEFAULT_LOCK_IDLE_MINUTES) {
  const remaining = timeRemainingMs(lockRow, nowIso, idleMinutes);
  if (remaining == null || remaining <= 0) return false;
  return remaining <= LOCK_WARN_SECONDS * 1000;
}

// The idle-timeout the auto-release sweep uses (never below 1 minute so a
// misconfigured 0 can't release a lock the instant it's taken). Pure so the
// clamp is unit-testable.
export function resolveIdleMinutes(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_LOCK_IDLE_MINUTES;
  return n;
}

// mayAcquire — the core of the acquire gate (ADR-004). Viewers can never acquire;
// an editor/admin may take a free or expired lock, or re-assert their own hold;
// a lock held live by someone else is refused, but the caller learns it can
// request a takeover.
//
//   lockRow  : the current mock2_locks row (or null when free)
//   requester: { type:'user'|'cycle', id }
//   role     : the requester's effective project role ('admin'|'editor'|'viewer')
//   nowIso   : injected clock
//
// Returns { ok, reason, canTakeover, heldBy }.
export function mayAcquire({ lockRow, requester, role, nowIso, idleMinutes = DEFAULT_LOCK_IDLE_MINUTES } = {}) {
  if (!requester) return { ok: false, reason: 'no requester', canTakeover: false, heldBy: null };
  // Viewers never hold the container lock (ADR-004). A cycle holder is not
  // role-gated (a cycle is authorized at start), so this only bites human holds.
  if (requester.type === 'user' && role === 'viewer') {
    return { ok: false, reason: 'viewers cannot check out a project', canTakeover: false, heldBy: null };
  }
  const holder = lockHolder(lockRow);
  if (!holder) return { ok: true, reason: 'free', canTakeover: false, heldBy: null };
  // Re-assert an existing hold of my own (refreshes last_write_at).
  if (holder.type === requester.type && holder.id === requester.id) {
    return { ok: true, reason: 'already held by requester', canTakeover: false, heldBy: holder };
  }
  // Someone else holds it. Expired ⇒ acquirable (the sweep should have released
  // it, but acquiring also reclaims it); otherwise refuse but offer takeover.
  if (isLockExpired(lockRow, nowIso, idleMinutes)) {
    return { ok: true, reason: 'previous hold expired', canTakeover: false, heldBy: holder };
  }
  return { ok: false, reason: 'held by another writer', canTakeover: true, heldBy: holder };
}

// Should the idle sweep auto-release this lock? True only for a live, expired
// lock. The sweep (locks.js) then checkpoints-then-releases, or escalates to
// awaiting_admin if the commit fails (ADR-004).
export function shouldAutoRelease(lockRow, nowIso, idleMinutes = DEFAULT_LOCK_IDLE_MINUTES) {
  if (!lockHolder(lockRow)) return false;
  return isLockExpired(lockRow, nowIso, idleMinutes);
}

// Client-safe view of a lock for the project detail banner: holder, remaining
// time, warn state, and whether a takeover has already been requested. holderName
// is resolved by the caller (a username or a cycle label).
export function publicLockShape(lockRow, { nowIso, idleMinutes = DEFAULT_LOCK_IDLE_MINUTES, holderName = null } = {}) {
  const holder = lockHolder(lockRow);
  if (!holder) return { held: false };
  const remaining = timeRemainingMs(lockRow, nowIso, idleMinutes);
  return {
    held: true,
    holder_type: holder.type,
    holder_id: holder.id,
    holder_name: holderName,
    acquired_at: lockRow.acquired_at || null,
    last_write_at: lockRow.last_write_at || null,
    remaining_ms: remaining,
    remaining_seconds: remaining == null ? null : Math.floor(remaining / 1000),
    expired: isLockExpired(lockRow, nowIso, idleMinutes),
    warn: inWarnWindow(lockRow, nowIso, idleMinutes),
    takeover_requested_by: lockRow.takeover_requested_by ?? null,
    takeover_requested_at: lockRow.takeover_requested_at || null,
  };
}
