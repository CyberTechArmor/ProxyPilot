// Mock2 checkout-lock data access (mock2_locks, in mock2.db) + the idle
// auto-release sweep (Phase M6, ADR-004). One row per project; the holder is a
// human, cycle, or a genuine operation reservation. A task mirror may attach
// its operation reservation to the owning cycle until acknowledged completion.
// The idle timer applies to human/cycle holds, never operation reservations.
//
// The DECISIONS (who-holds, time-remaining, may-acquire, should-auto-release)
// are the pure lock-logic.js; this module is the thin better-sqlite3 half plus
// the sweep that checkpoints-then-releases an idle lock (or escalates to
// awaiting_admin when the commit fails). Native (getMock2Db) — reached only on an
// enabled host through the gated router.
//
// Terminology (risk R7): nothing here is named "agent".

import { randomUUID } from 'node:crypto';
import { getMock2Db } from './db.js';
import { getMock2Setting } from './settings.js';
import {
  LOCK_IDLE_MINUTES_KEY, resolveIdleMinutes, lockHolder, mayAcquire,
  shouldAutoRelease, checkoutOperationReason,
} from './lock-logic.js';

const nowIso = () => new Date().toISOString();

// The configured idle-timeout in minutes (ADR-004 default 15). Read through the
// pure clamp so a misconfigured 0/negative can't release a just-taken lock.
export function getLockIdleMinutes() {
  return resolveIdleMinutes(getMock2Setting(LOCK_IDLE_MINUTES_KEY, null));
}

export function getLock(projectId) {
  return getMock2Db().prepare(`SELECT * FROM mock2_locks WHERE project_id = ?`).get(Number(projectId));
}

export function listLocks() {
  return getMock2Db().prepare(`SELECT * FROM mock2_locks`).all();
}

// Acquire (or re-assert) the lock for a project. requester is { type, id }; role
// is the human requester's effective project role (ignored for a cycle). Returns
// { ok, reason, lock, canTakeover, heldBy }. On success writes/refreshes the row
// (last_write_at = now); a takeover-pending flag is cleared when the requested
// holder takes over cleanly.
export function acquireLock({ projectId, requester, role, force = false }) {
  const db = getMock2Db();
  const pid = Number(projectId);
  const idleMinutes = getLockIdleMinutes();
  const tx = db.transaction(() => {
    const current = getLock(pid);
    if (current?.holder_operation_id != null) return operationBusy(current);
    if (!force) {
      const verdict = mayAcquire({ lockRow: current, requester, role, nowIso: nowIso(), idleMinutes });
      if (!verdict.ok) return { ok: false, reason: verdict.reason, lock: current, canTakeover: verdict.canTakeover, heldBy: verdict.heldBy };
    }
    const userId = requester.type === 'user' ? requester.id : null;
    const cycleId = requester.type === 'cycle' ? requester.id : null;
    const now = nowIso();
    // Preserve acquired_at when the SAME holder re-asserts; otherwise stamp fresh.
    const holder = lockHolder(current);
    const sameHolder = holder && holder.type === requester.type && holder.id === requester.id;
    const acquiredAt = sameHolder ? current.acquired_at : now;
    db.prepare(
      `INSERT INTO mock2_locks (project_id, holder_user_id, holder_cycle_id, acquired_at, last_write_at, takeover_requested_by, takeover_requested_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL)
       ON CONFLICT(project_id) DO UPDATE SET
         holder_user_id = excluded.holder_user_id,
         holder_cycle_id = excluded.holder_cycle_id,
         holder_operation_id = NULL, holder_operation_state = NULL, holder_operation_kind = NULL,
         acquired_at = excluded.acquired_at,
         last_write_at = excluded.last_write_at,
         takeover_requested_by = NULL,
         takeover_requested_at = NULL`,
    ).run(pid, userId, cycleId, acquiredAt, now);
    return { ok: true, reason: force ? 'forced' : 'acquired', lock: getLock(pid) };
  });
  return tx.immediate();
}

// Refresh last_write_at — call after any write the holder makes (a cycle exec
// that mutates the tree, a human file-touching action). No-op if the lock is not
// held by the given holder (a stale toucher can't extend someone else's lock).
export function touchLock(projectId, holder) {
  const cur = getLock(projectId);
  const h = lockHolder(cur);
  if (!h || h.type === 'operation' || !holder || h.type !== holder.type || h.id !== holder.id) return false;
  getMock2Db().prepare(`UPDATE mock2_locks SET last_write_at = ? WHERE project_id = ?`).run(nowIso(), Number(projectId));
  return true;
}

// Release the lock. When holder is given, only releases if that holder still
// holds it (so a stale releaser can't drop a lock someone else took over). An
// admin force-release passes no holder.
export function releaseLock(projectId, holder = null) {
  const db = getMock2Db();
  return db.transaction(() => {
    const cur = getLock(projectId);
    if (!cur) return { released: false, reason: 'not held' };
    if (cur.holder_operation_id != null) {
      if (holder?.type === 'cycle' && cur.holder_cycle_id != null && Number(cur.holder_cycle_id) === holder.id) {
        db.prepare("UPDATE mock2_locks SET holder_cycle_id=NULL,holder_operation_state='uncertain' WHERE project_id=? AND holder_operation_id=? AND holder_cycle_id=?").run(Number(projectId), cur.holder_operation_id, holder.id);
        return { released: true, retainedOperation: true, reason: checkoutOperationReason({ ...cur, holder_operation_state: 'uncertain' }) };
      }
      return { released: false, reason: checkoutOperationReason(cur) };
    }
    if (holder) {
      const h = lockHolder(cur);
      if (!h || h.type !== holder.type || h.id !== holder.id) return { released: false, reason: 'held by another writer' };
    }
    db.prepare(`DELETE FROM mock2_locks WHERE project_id = ? AND holder_operation_id IS NULL`).run(Number(projectId));
    return { released: true };
  }).immediate();
}

// These are internal capabilities, not public API tokens. Admission and the
// holder row are one SQLite transaction; no clock or administrator can infer
// that an unacknowledged remote write has stopped.
const operationBusy = row => ({ ok: false, reason: checkoutOperationReason(row), lock: null, canTakeover: false, heldBy: { type: 'maintenance', id: null } });
const validOperation = (projectId, token) => Number.isSafeInteger(Number(projectId)) && Number(projectId) > 0
  && typeof token === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(token);

export function acquireCheckoutOperationLease(projectId, kind = 'task-continuity', { cycleId = null } = {}) {
  const pid = Number(projectId);
  if (!Number.isSafeInteger(pid) || pid <= 0 || !['task-continuity','mcp-write','project-write','restore'].includes(kind)) return { ok: false, reason: 'invalid project or operation' };
  const db = getMock2Db();
  return db.transaction(() => {
    const current = getLock(pid);
    const holder = lockHolder(current);
    const attached = kind === 'task-continuity' && Number.isSafeInteger(cycleId) && cycleId > 0 && holder?.type === 'cycle' && holder.id === cycleId;
    if (cycleId !== null && !attached) return { ok: false, reason: 'the original cycle no longer owns this project' };
    if (holder && !attached) return { ok: false, reason: current?.holder_operation_id != null ? checkoutOperationReason(current) : 'held by another writer' };
    const token = randomUUID(), now = nowIso();
    if (attached) {
      const saved = db.prepare("UPDATE mock2_locks SET holder_operation_id=?,holder_operation_state='active',holder_operation_kind=? WHERE project_id=? AND holder_cycle_id=? AND holder_user_id IS NULL AND holder_operation_id IS NULL").run(token, kind, pid, cycleId);
      return saved.changes === 1 ? { ok: true, token } : { ok: false, reason: 'the original cycle no longer owns this project' };
    }
    db.prepare(`INSERT INTO mock2_locks(project_id, holder_user_id, holder_cycle_id, acquired_at, last_write_at, holder_operation_id, holder_operation_state, holder_operation_kind)
      VALUES(?,NULL,NULL,?,?,?,'active',?) ON CONFLICT(project_id) DO UPDATE SET
      holder_user_id=NULL,holder_cycle_id=NULL,acquired_at=excluded.acquired_at,last_write_at=excluded.last_write_at,
      holder_operation_id=excluded.holder_operation_id,holder_operation_state='active',holder_operation_kind=excluded.holder_operation_kind,takeover_requested_by=NULL,takeover_requested_at=NULL`).run(pid, now, now, token, kind);
    return { ok: true, token };
  }).immediate();
}

export const acquireTaskContinuityLease = (projectId, options = {}) => acquireCheckoutOperationLease(projectId, 'task-continuity', options);

export function markTaskContinuityLeaseUncertain(projectId, token) {
  if (!validOperation(projectId, token)) return false;
  return getMock2Db().prepare(`UPDATE mock2_locks SET holder_operation_state='uncertain' WHERE project_id=? AND holder_operation_id=?`).run(Number(projectId), token).changes === 1;
}

// Call only after a recognized, confirmed remote completion/refusal. Transport
// loss, timeout or an exception must retain the reservation as uncertain.
export function settleTaskContinuityLease(projectId, token) {
  if (!validOperation(projectId, token)) return false;
  const db = getMock2Db();
  return db.transaction(() => {
    const row = getLock(projectId);
    if (row?.holder_operation_id !== token) return false;
    if (row.holder_cycle_id != null || row.holder_user_id != null) return db.prepare("UPDATE mock2_locks SET holder_operation_id=NULL,holder_operation_state=NULL,holder_operation_kind=NULL,last_write_at=? WHERE project_id=? AND holder_operation_id=?").run(nowIso(), Number(projectId), token).changes === 1;
    return db.prepare('DELETE FROM mock2_locks WHERE project_id=? AND holder_operation_id=?').run(Number(projectId), token).changes === 1;
  }).immediate();
}

export const markCheckoutOperationLeaseUncertain = markTaskContinuityLeaseUncertain;
export const settleCheckoutOperationLease = settleTaskContinuityLease;

// Request a takeover: pings the current holder (surfaced in the banner). Records
// who asked and when; does not release anything (the holder decides, or the lock
// idle-expires, or an admin force-releases).
export function requestTakeover(projectId, userId) {
  const cur = getLock(projectId);
  if (cur?.holder_operation_id != null) return { ok: false, reason: checkoutOperationReason(cur) };
  if (!lockHolder(cur)) return { ok: false, reason: 'not held' };
  getMock2Db()
    .prepare(`UPDATE mock2_locks SET takeover_requested_by = ?, takeover_requested_at = ? WHERE project_id = ?`)
    .run(userId ?? null, nowIso(), Number(projectId));
  return { ok: true, lock: getLock(projectId) };
}

// Is the lock free for this requester to take (or already theirs)? A read-only
// probe for the routes layer to short-circuit before doing container work.
export function lockGuard({ projectId, requester, role }) {
  return mayAcquire({ lockRow: getLock(projectId), requester, role, nowIso: nowIso(), idleMinutes: getLockIdleMinutes() });
}

// sweepMock2Locks(now, { onIdle }) — auto-release idle locks (ADR-004). For each
// live lock past its idle timeout, call onIdle(lock) — the caller (index.js /
// runner) performs the checkpoint-then-release, or escalates to awaiting_admin if
// it cannot commit. Never throws: a per-lock failure is logged and skipped.
//
// A CYCLE-held lock is left to the runner / boot sweep (a running cycle refreshes
// last_write on each exec; a crashed one is failed by sweepMock2OnBoot, which
// releases its lock). This sweep primarily reclaims stale HUMAN checkouts.
export async function sweepMock2Locks(now = nowIso(), { onIdle } = {}) {
  const idleMinutes = getLockIdleMinutes();
  let locks = [];
  try { locks = listLocks(); } catch (err) { console.error('[mock2] lock sweep read failed:', err?.message); return { released: 0, considered: 0 }; }
  let released = 0;
  let considered = 0;
  for (const lock of locks) {
    if (!shouldAutoRelease(lock, now, idleMinutes)) continue;
    const holder = lockHolder(lock);
    if (holder?.type === 'cycle') continue; // runner/boot-sweep owns cycle locks
    considered += 1;
    try {
      if (typeof onIdle === 'function') {
        const handled = await onIdle(lock);
        if (handled === false) continue; // caller escalated (awaiting_admin) — leave the lock
      }
      releaseLock(lock.project_id);
      released += 1;
    } catch (err) {
      console.error(`[mock2] lock sweep: failed to auto-release project ${lock.project_id}:`, err?.message);
    }
  }
  if (considered > 0) console.log(`[mock2] lock sweep: auto-released ${released}/${considered} idle checkout(s)`);
  return { released, considered };
}
