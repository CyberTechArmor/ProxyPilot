// Setup engine — the SQL half. Every function takes a SQLite handle that
// offers prepare().get/all/run and exec (better-sqlite3 in the backend and
// the host runner, node:sqlite in the suite) and positional parameters only.
// Decisions live in logic.js; this file writes what they decide.
//
// Tables (migration 1000 in db.js; SETUP_ENGINE_SCHEMA is the same text):
//   setup_locks       one row per app: the lease, its owner, the operation
//   setup_jobs        one row per operation: plan, progress, checkpoint,
//                     configuration references, lease, outcome
//   setup_job_events  append-only progress, redacted on write
//
// Fencing: every mutation a worker makes on a job carries (owner, epoch) and
// is `WHERE owner = ? AND epoch = ?`; a worker whose job was taken over gets
// changes = 0 and must stop. releaseLock / finishJob obey the same rule.

import crypto from 'node:crypto';
import {
  DEFAULT_LEASE_MS, leaseExpiry, lockVerdict, takeoverVerdict, redact, sanitizeReason, parseJson, TERMINAL_STATUS, FencedError, CancelledError,
} from './logic.js';

export const SETUP_ENGINE_SCHEMA = `
CREATE TABLE IF NOT EXISTS setup_locks (
  app              TEXT PRIMARY KEY,
  owner            TEXT NOT NULL,
  operation        TEXT NOT NULL,
  job_id           TEXT,
  epoch            INTEGER NOT NULL DEFAULT 1,
  acquired_at      TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  stale_since      TEXT,
  recovery_job_id  TEXT
);
CREATE TABLE IF NOT EXISTS setup_jobs (
  id                 TEXT PRIMARY KEY,
  kind               TEXT NOT NULL,
  app                TEXT NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed','deferred','refused','recovery_required','cancelled')),
  phase              TEXT,
  plan_json          TEXT NOT NULL DEFAULT '{}',
  progress_json      TEXT NOT NULL DEFAULT '{}',
  checkpoint_json    TEXT NOT NULL DEFAULT '{}',
  config_refs_json   TEXT NOT NULL DEFAULT '{}',
  verification_json  TEXT,
  requested_by       TEXT,
  via                TEXT,
  owner              TEXT,
  epoch              INTEGER NOT NULL DEFAULT 0,
  lease_expires_at   TEXT,
  outcome            TEXT,
  reason             TEXT,
  retry_of           TEXT,
  created_at         TEXT NOT NULL,
  started_at         TEXT,
  finished_at        TEXT,
  updated_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_setup_jobs_app ON setup_jobs(app, created_at);
CREATE INDEX IF NOT EXISTS idx_setup_jobs_status ON setup_jobs(status);
CREATE TABLE IF NOT EXISTS setup_job_events (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id    TEXT NOT NULL,
  at        TEXT NOT NULL,
  kind      TEXT NOT NULL,
  phase     TEXT,
  message   TEXT,
  data_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_setup_job_events_job ON setup_job_events(job_id, id);
`;

// Migration 1001: the runners' liveness. One row per runner identity, its
// heartbeat refreshed every poll tick; the backend submits a deploy to the
// runner only while one is live, and otherwise executes the same operation
// itself (docs/features/setup-engine.md § "Who executes").
export const SETUP_RUNNERS_SCHEMA = `
CREATE TABLE IF NOT EXISTS setup_runners (
  owner        TEXT PRIMARY KEY,
  host         TEXT,
  pid          INTEGER,
  version      TEXT,
  started_at   TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL
);
`;

export function ensureSetupEngineSchema(db) {
  db.exec(SETUP_ENGINE_SCHEMA);
  db.exec(SETUP_RUNNERS_SCHEMA);
}

// ── runners ─────────────────────────────────────────────────────────────

export function runnerHeartbeat(db, { owner, host = null, pid = null, version = null, nowMs = Date.now() }) {
  const now = iso(nowMs);
  db.prepare(`INSERT INTO setup_runners (owner, host, pid, version, started_at, heartbeat_at) VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(owner) DO UPDATE SET heartbeat_at = excluded.heartbeat_at, host = excluded.host, pid = excluded.pid, version = excluded.version`)
    .run(owner, host, pid == null ? null : Number(pid), version, now, now);
}

export function runnerGoodbye(db, { owner }) {
  return db.prepare(`DELETE FROM setup_runners WHERE owner = ?`).run(owner).changes;
}

// liveRunners(db, { nowMs, maxAgeMs }) → runner rows with a fresh heartbeat.
export function liveRunners(db, { nowMs = Date.now(), maxAgeMs = 30_000 } = {}) {
  const cutoff = iso(nowMs - maxAgeMs);
  return db.prepare(`SELECT * FROM setup_runners WHERE heartbeat_at > ? ORDER BY heartbeat_at DESC`).all(cutoff);
}

// requeueJob(db, { id, by, reason }) — a running job whose owner is gone goes
// back to the queue for a new owner (a claim bumps the epoch). Unfenced by
// design: it is the reconciler's write about a dead owner.
export function requeueJob(db, { id, by, reason, notBeforeMs = null, nowMs = Date.now() }) {
  const now = iso(nowMs);
  const row = getJob(db, id);
  if (!row) return 0;
  const prog = { ...(parseJson(row.progress_json) || {}) };
  if (notBeforeMs) prog.not_before = iso(notBeforeMs); else delete prog.not_before;
  prog.requeues = (Number(prog.requeues) || 0) + 1;
  const r = db.prepare(`UPDATE setup_jobs SET status = 'queued', owner = NULL, lease_expires_at = NULL, progress_json = ?, updated_at = ? WHERE id = ? AND status = 'running'`).run(JSON.stringify(prog), now, String(id));
  if (r.changes) insertEvent(db, { jobId: id, at: now, kind: 'requeued', message: reason, data: { by, not_before: prog.not_before || null, requeues: prog.requeues } });
  return r.changes;
}

// recordVerificationRung(db, { id, rung, value, detail, by }) — a rung added
// to a FINISHED job's verification by a party other than its executor (the
// backend's application-owned credential check). Unfenced: the job is
// terminal; the write says who added what.
export function recordVerificationRung(db, { id, rung, value, detail = null, by, state = null, nowMs = Date.now() }) {
  const row = getJob(db, id);
  if (!row) return 0;
  const cur = parseJson(row.verification_json) || {};
  const rungs = { ...(cur.rungs || {}), [rung]: { value, detail: detail == null ? null : sanitizeReason(detail), by, at: iso(nowMs) } };
  const next = { ...cur, rungs, ...(state ? { state, label: state } : {}) };
  const r = db.prepare(`UPDATE setup_jobs SET verification_json = ?, updated_at = ? WHERE id = ?`).run(JSON.stringify(redact(next)), iso(nowMs), String(id));
  if (r.changes) insertEvent(db, { jobId: id, at: iso(nowMs), kind: 'verification', phase: rung, message: detail, data: { rung, value, by, state } });
  return r.changes;
}

const iso = (ms) => new Date(ms).toISOString();

// ── locks ───────────────────────────────────────────────────────────────

export function readLock(db, app) {
  return db.prepare(`SELECT * FROM setup_locks WHERE app = ?`).get(String(app)) || null;
}

export function listLocks(db) {
  return db.prepare(`SELECT * FROM setup_locks ORDER BY acquired_at`).all();
}

// acquireLock(db, { app, owner, operation, jobId, leaseMs, nowMs }) →
//   { ok: true, lock }  |  { ok: false, reason: 'held' | 'stale', … }
// Atomic under BEGIN IMMEDIATE. A stale lease is REFUSED, not taken.
export function acquireLock(db, { app, owner, operation, jobId = null, leaseMs = DEFAULT_LEASE_MS, nowMs = Date.now() }) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const current = readLock(db, app);
    const verdict = lockVerdict({ lock: current, owner, nowMs });
    if (!verdict.ok) { db.exec('ROLLBACK'); return verdict; }
    const expires = leaseExpiry(nowMs, leaseMs);
    if (current) {
      db.prepare(`UPDATE setup_locks SET operation = ?, job_id = ?, lease_expires_at = ?, stale_since = NULL WHERE app = ? AND owner = ?`)
        .run(operation, jobId, expires, String(app), owner);
    } else {
      db.prepare(`INSERT INTO setup_locks (app, owner, operation, job_id, epoch, acquired_at, lease_expires_at) VALUES (?, ?, ?, ?, 1, ?, ?)`)
        .run(String(app), owner, operation, jobId, iso(nowMs), expires);
    }
    db.exec('COMMIT');
    return { ok: true, reason: verdict.reason, lock: readLock(db, app) };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* */ }
    throw e;
  }
}

// renewLock → changes (1 when this owner+epoch still holds it).
export function renewLock(db, { app, owner, epoch, leaseMs = DEFAULT_LEASE_MS, nowMs = Date.now() }) {
  return db.prepare(`UPDATE setup_locks SET lease_expires_at = ? WHERE app = ? AND owner = ? AND epoch = ?`)
    .run(leaseExpiry(nowMs, leaseMs), String(app), owner, Number(epoch)).changes;
}

// releaseLock → changes. Fenced: only the owner at its epoch releases.
export function releaseLock(db, { app, owner, epoch }) {
  return db.prepare(`DELETE FROM setup_locks WHERE app = ? AND owner = ? AND epoch = ?`).run(String(app), owner, Number(epoch)).changes;
}

// takeoverLock(db, { app, by, operation, jobId, reason, leaseMs, nowMs }) →
// { ok, lock, previous } — a reconciler taking a STALE lease. The epoch is
// bumped (fencing the dead holder) and the takeover is recorded as an event
// on the job it was taken for.
export function takeoverLock(db, { app, by, operation, jobId = null, reason, leaseMs = DEFAULT_LEASE_MS, nowMs = Date.now() }) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const current = readLock(db, app);
    const v = takeoverVerdict({ lock: current, nowMs });
    if (!v.ok) { db.exec('ROLLBACK'); return { ok: false, reason: v.reason, holder: v.holder || null }; }
    const epoch = v.epoch + 1;
    db.prepare(`UPDATE setup_locks SET owner = ?, operation = ?, job_id = ?, epoch = ?, acquired_at = ?, lease_expires_at = ?, stale_since = NULL, recovery_job_id = NULL WHERE app = ?`)
      .run(by, operation, jobId, epoch, iso(nowMs), leaseExpiry(nowMs, leaseMs), String(app));
    if (jobId) insertEvent(db, { jobId, at: iso(nowMs), kind: 'lock_takeover', phase: operation, message: sanitizeReason(reason || 'stale lease taken over'), data: { previous_owner: current.owner, previous_epoch: current.epoch, epoch } });
    db.exec('COMMIT');
    return { ok: true, lock: readLock(db, app), previous: current };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* */ }
    throw e;
  }
}

// markLockStale — the reconciler's RECORD when it cannot act: the lease stays,
// flagged with when it went stale and which recovery job (if any) is waiting.
export function markLockStale(db, { app, nowMs = Date.now(), recoveryJobId = null }) {
  return db.prepare(`UPDATE setup_locks SET stale_since = COALESCE(stale_since, ?), recovery_job_id = COALESCE(?, recovery_job_id) WHERE app = ?`)
    .run(iso(nowMs), recoveryJobId, String(app)).changes;
}

// holdStaleLock — the durable EXCLUSION for an unresolved condition: the dead
// owner's lease row is flagged stale and pointed at the job that records the
// condition; when no row is left (a lease that had already expired and been
// removed), one is written in the dead owner's name, already expired and
// stale. Either way every exclusive operation on the app is refused with the
// recorded condition until clearStaleLock releases it.
export function holdStaleLock(db, { app, owner, operation, jobId, epoch = 1, nowMs = Date.now() }) {
  const now = iso(nowMs);
  const current = readLock(db, app);
  if (current) return markLockStale(db, { app, nowMs, recoveryJobId: jobId });
  return db.prepare(`INSERT INTO setup_locks (app, owner, operation, job_id, epoch, acquired_at, lease_expires_at, stale_since, recovery_job_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(String(app), owner, operation, jobId, Number(epoch) || 1, now, now, now, jobId).changes;
}

// clearStaleLock — an operator's explicit resolution: the stale lease that
// records THIS job's condition is released. Nothing else releases it: not a
// live lease, not a lease recording another job.
export function clearStaleLock(db, { app, recoveryJobId }) {
  return db.prepare(`DELETE FROM setup_locks WHERE app = ? AND stale_since IS NOT NULL AND recovery_job_id = ?`).run(String(app), String(recoveryJobId)).changes;
}

// ── jobs ────────────────────────────────────────────────────────────────

export function getJob(db, id) {
  return db.prepare(`SELECT * FROM setup_jobs WHERE id = ?`).get(String(id)) || null;
}

export function listJobs(db, { app = null, status = null, limit = 50 } = {}) {
  const where = [];
  const params = [];
  if (app) { where.push('app = ?'); params.push(String(app)); }
  if (status) { where.push('status = ?'); params.push(String(status)); }
  params.push(Math.max(1, Math.min(500, Number(limit) || 50)));
  return db.prepare(`SELECT * FROM setup_jobs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(...params);
}

export function listEvents(db, jobId, { limit = 500 } = {}) {
  return db.prepare(`SELECT * FROM setup_job_events WHERE job_id = ? ORDER BY id LIMIT ?`).all(String(jobId), Math.max(1, Math.min(5000, Number(limit) || 500)));
}

function insertEvent(db, { jobId, at, kind, phase = null, message = null, data = null }) {
  db.prepare(`INSERT INTO setup_job_events (job_id, at, kind, phase, message, data_json) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(String(jobId), at, kind, phase, message == null ? null : sanitizeReason(message, 2000), data == null ? null : JSON.stringify(redact(data)));
}

// appendEvent — public, redacted on write.
export function appendEvent(db, { jobId, kind, phase = null, message = null, data = null, nowMs = Date.now() }) {
  insertEvent(db, { jobId, at: iso(nowMs), kind, phase, message, data });
}

// createJob(db, { kind, app, plan, configRefs, requestedBy, via, retryOf, status, nowMs, id }) → row
// Plans and references are redacted on write — a value that looks like a
// secret never lands in the row, whatever the caller passed.
export function createJob(db, { id = crypto.randomUUID(), kind, app, plan = {}, configRefs = {}, requestedBy = null, via = 'system', retryOf = null, status = 'queued', reason = null, nowMs = Date.now() }) {
  const now = iso(nowMs);
  db.prepare(`
    INSERT INTO setup_jobs (id, kind, app, status, plan_json, config_refs_json, requested_by, via, retry_of, reason, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, kind, String(app), status, JSON.stringify(redact(plan)), JSON.stringify(redact(configRefs)), requestedBy, via, retryOf, reason == null ? null : sanitizeReason(reason), now, now);
  insertEvent(db, { jobId: id, at: now, kind: 'created', message: `${kind} for ${app} requested via ${via}${requestedBy ? ` by ${requestedBy}` : ''}` });
  return getJob(db, id);
}

// startJob(db, { id, owner, leaseMs, nowMs }) — a job the caller created and
// executes itself (the backend's deploy): queued → running under this owner,
// epoch 1. Returns the row or null when it was not queued any more.
export function startJob(db, { id, owner, leaseMs = DEFAULT_LEASE_MS, nowMs = Date.now() }) {
  const now = iso(nowMs);
  const r = db.prepare(`UPDATE setup_jobs SET status = 'running', owner = ?, epoch = 1, lease_expires_at = ?, started_at = ?, updated_at = ? WHERE id = ? AND status = 'queued'`)
    .run(owner, leaseExpiry(nowMs, leaseMs), now, now, String(id));
  if (!r.changes) return null;
  insertEvent(db, { jobId: id, at: now, kind: 'started', data: { owner } });
  return getJob(db, id);
}

// claimNextJob(db, { owner, kinds, leaseMs, nowMs }) → the claimed row or
// null. Compare-and-swap: two runners racing for one queued job see one
// winner. The claimed job's epoch is bumped so a previous owner (a resumed
// job) is fenced out.
export function claimNextJob(db, { owner, kinds, leaseMs = DEFAULT_LEASE_MS, nowMs = Date.now() }) {
  if (!Array.isArray(kinds) || !kinds.length) return null;
  const marks = kinds.map(() => '?').join(', ');
  db.exec('BEGIN IMMEDIATE');
  try {
    // A requeued follow-up may carry progress.not_before; it waits its turn.
    const candidates = db.prepare(`SELECT id, epoch, progress_json FROM setup_jobs WHERE status = 'queued' AND kind IN (${marks}) ORDER BY created_at, rowid LIMIT 50`).all(...kinds);
    const next = candidates.find((c) => { const nb = (parseJson(c.progress_json) || {}).not_before; return !nb || Date.parse(nb) <= nowMs; });
    if (!next) { db.exec('COMMIT'); return null; }
    const now = iso(nowMs);
    const r = db.prepare(`UPDATE setup_jobs SET status = 'running', owner = ?, epoch = epoch + 1, lease_expires_at = ?, started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ? AND status = 'queued' AND epoch = ?`)
      .run(owner, leaseExpiry(nowMs, leaseMs), now, now, next.id, next.epoch);
    if (!r.changes) { db.exec('ROLLBACK'); return null; }
    // The wait is over: the not-before is consumed with the claim.
    const prog = parseJson(next.progress_json) || {};
    if (prog.not_before) { delete prog.not_before; db.prepare(`UPDATE setup_jobs SET progress_json = ? WHERE id = ?`).run(JSON.stringify(prog), next.id); }
    insertEvent(db, { jobId: next.id, at: now, kind: 'claimed', data: { owner, epoch: next.epoch + 1 } });
    db.exec('COMMIT');
    return getJob(db, next.id);
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* */ }
    throw e;
  }
}

// heartbeat → changes (0 = fenced out: stop working).
export function heartbeat(db, { id, owner, epoch, leaseMs = DEFAULT_LEASE_MS, nowMs = Date.now() }) {
  return db.prepare(`UPDATE setup_jobs SET lease_expires_at = ?, updated_at = ? WHERE id = ? AND owner = ? AND epoch = ? AND status = 'running'`)
    .run(leaseExpiry(nowMs, leaseMs), iso(nowMs), String(id), owner, Number(epoch)).changes;
}

// checkpoint(db, { id, owner, epoch, phase, checkpoint, progress, message }) →
// changes. THE write before a disruptive step: it replaces checkpoint_json
// (merged with what was there), records the phase and appends an event.
// Fenced. Secrets are redacted on write.
export function checkpoint(db, { id, owner, epoch, phase, checkpoint: cp = {}, progress = null, message = null, nowMs = Date.now() }) {
  const row = getJob(db, id);
  if (!row) return 0;
  const merged = { ...(parseJson(row.checkpoint_json) || {}), ...redact(cp), phase };
  const prog = progress == null ? row.progress_json : JSON.stringify(redact({ ...(parseJson(row.progress_json) || {}), ...progress }));
  const now = iso(nowMs);
  const r = db.prepare(`UPDATE setup_jobs SET phase = ?, checkpoint_json = ?, progress_json = ?, lease_expires_at = ?, updated_at = ? WHERE id = ? AND owner = ? AND epoch = ? AND status = 'running'`)
    .run(phase, JSON.stringify(merged), prog, leaseExpiry(nowMs), now, String(id), owner, Number(epoch));
  if (r.changes) insertEvent(db, { jobId: id, at: now, kind: 'checkpoint', phase, message, data: cp });
  return r.changes;
}

// recordGenerated(db, { id, owner, epoch, resource }) — a resource this attempt
// created (a secret NAME and where it was written, a snapshot, a dump file) so
// a retry reuses it. Fenced.
export function recordGenerated(db, { id, owner, epoch, resource, nowMs = Date.now() }) {
  const row = getJob(db, id);
  if (!row) return 0;
  const prog = parseJson(row.progress_json) || {};
  const generated = Array.isArray(prog.generated) ? prog.generated : [];
  generated.push(redact({ kind: resource.kind, name: resource.name, where: resource.where || null, ...(resource.sha256 ? { sha256: String(resource.sha256) } : {}), ...(resource.bytes != null ? { bytes: Number(resource.bytes) } : {}), ...(resource.created_at ? { created_at: String(resource.created_at) } : {}), at: iso(nowMs) }));
  return db.prepare(`UPDATE setup_jobs SET progress_json = ?, updated_at = ? WHERE id = ? AND owner = ? AND epoch = ? AND status = 'running'`)
    .run(JSON.stringify({ ...prog, generated }), iso(nowMs), String(id), owner, Number(epoch)).changes;
}

// recordProgress(db, { id, owner, epoch, progress }) → changes. Merges into
// progress_json (redacted). Fenced. The executor's own result lands here as
// progress.result so every caller reads one shape back.
export function recordProgress(db, { id, owner, epoch, progress, nowMs = Date.now() }) {
  const row = getJob(db, id);
  if (!row) return 0;
  const merged = { ...(parseJson(row.progress_json) || {}), ...redact(progress || {}) };
  return db.prepare(`UPDATE setup_jobs SET progress_json = ?, updated_at = ? WHERE id = ? AND owner = ? AND epoch = ? AND status = 'running'`)
    .run(JSON.stringify(merged), iso(nowMs), String(id), owner, Number(epoch)).changes;
}

// finishJob(db, { id, owner, epoch, status, outcome, reason, verification }) →
// changes. Terminal statuses only. Fenced.
export function finishJob(db, { id, owner, epoch, status, outcome = null, reason = null, verification = null, progress = null, nowMs = Date.now() }) {
  if (!TERMINAL_STATUS.includes(status)) throw new Error(`finishJob: '${status}' is not a terminal status`);
  const now = iso(nowMs);
  if (progress) recordProgress(db, { id, owner, epoch, progress, nowMs });
  const r = db.prepare(`UPDATE setup_jobs SET status = ?, outcome = ?, reason = ?, verification_json = ?, finished_at = ?, updated_at = ?, lease_expires_at = NULL WHERE id = ? AND owner = ? AND epoch = ? AND status = 'running'`)
    .run(status, outcome, reason == null ? null : sanitizeReason(reason), verification == null ? null : JSON.stringify(redact(verification)), now, now, String(id), owner, Number(epoch));
  if (r.changes) insertEvent(db, { jobId: id, at: now, kind: 'finished', message: reason, data: { status, outcome } });
  return r.changes;
}

// recordJobOutcome(db, { id, status, outcome, reason, verification, by }) —
// UNFENCED: the reconciler's write about a job whose owner is dead. Records
// who decided.
export function recordJobOutcome(db, { id, status, outcome = null, reason = null, verification = null, by, nowMs = Date.now() }) {
  if (!TERMINAL_STATUS.includes(status)) throw new Error(`recordJobOutcome: '${status}' is not a terminal status`);
  const now = iso(nowMs);
  const r = db.prepare(`UPDATE setup_jobs SET status = ?, outcome = ?, reason = ?, verification_json = COALESCE(?, verification_json), finished_at = ?, updated_at = ?, lease_expires_at = NULL WHERE id = ? AND status = 'running'`)
    .run(status, outcome, reason == null ? null : sanitizeReason(reason), verification == null ? null : JSON.stringify(redact(verification)), now, now, String(id));
  if (r.changes) insertEvent(db, { jobId: id, at: now, kind: 'reconciled', message: reason, data: { status, outcome, by } });
  return r.changes;
}

// annotateTerminalOutcome(db, { id, fromStatus, outcome, reason, nowMs }) →
// changes. A terminal job's outcome refined by a later, recorded fact (an
// operator's acknowledgement): the status stays what it was; only the
// outcome and the reason change. Never touches a queued or running job.
export function annotateTerminalOutcome(db, { id, fromStatus, outcome, reason, nowMs = Date.now() }) {
  if (!TERMINAL_STATUS.includes(fromStatus)) throw new Error(`annotateTerminalOutcome: '${fromStatus}' is not a terminal status`);
  return db.prepare(`UPDATE setup_jobs SET outcome = ?, reason = ?, updated_at = ? WHERE id = ? AND status = ?`)
    .run(outcome, reason == null ? null : sanitizeReason(reason, 1200), iso(nowMs), String(id), fromStatus).changes;
}

// annotateJobProgress(db, { id, progress }) → changes. UNFENCED and status-
// agnostic: a note another job leaves on a record (a follow-up's outcome on
// the phase it was delegated — `routes` on a guest_setup, the setup summary
// on the create that queued it). Merges into progress_json, redacted; never
// touches the status, the outcome or the checkpoint.
export function annotateJobProgress(db, { id, progress, nowMs = Date.now() }) {
  const row = getJob(db, id);
  if (!row) return 0;
  const merged = { ...(parseJson(row.progress_json) || {}), ...redact(progress || {}) };
  return db.prepare(`UPDATE setup_jobs SET progress_json = ?, updated_at = ? WHERE id = ?`).run(JSON.stringify(merged), iso(nowMs), String(id)).changes;
}

// requestCancel(db, { id, by }) → changes. Recorded on a queued or running
// job; the executor honours it at its next safe checkpoint (before the
// disruptive step) and declines it after. A queued job is cancelled outright.
// cancelQueuedJob(db, { id, outcome, reason, by }) — a job that never ran
// (the orchestrator refused it before any executor took it) ends cancelled
// with the outcome that says why; never touches a running job.
export function cancelQueuedJob(db, { id, outcome = 'cancelled', reason = null, by = null, nowMs = Date.now() }) {
  const now = iso(nowMs);
  const r = db.prepare(`UPDATE setup_jobs SET status = 'cancelled', outcome = ?, reason = ?, finished_at = ?, updated_at = ? WHERE id = ? AND status = 'queued'`)
    .run(outcome, reason == null ? null : sanitizeReason(reason), now, now, String(id));
  if (r.changes) insertEvent(db, { jobId: id, at: now, kind: 'cancelled', message: reason, data: { outcome, by } });
  return r.changes;
}

export function requestCancel(db, { id, by, nowMs = Date.now() }) {
  const row = getJob(db, id);
  if (!row) return { ok: false, reason: 'no such job' };
  const now = iso(nowMs);
  if (row.status === 'queued') {
    const r = db.prepare(`UPDATE setup_jobs SET status = 'cancelled', outcome = 'cancelled', reason = ?, finished_at = ?, updated_at = ? WHERE id = ? AND status = 'queued'`).run(`cancelled by ${by} before it started`, now, now, String(id));
    if (r.changes) insertEvent(db, { jobId: id, at: now, kind: 'cancelled', message: `cancelled by ${by} before it started` });
    return { ok: r.changes === 1, state: 'cancelled' };
  }
  if (row.status !== 'running') return { ok: false, reason: `job is ${row.status}` };
  const prog = parseJson(row.progress_json) || {};
  db.prepare(`UPDATE setup_jobs SET progress_json = ?, updated_at = ? WHERE id = ?`).run(JSON.stringify({ ...prog, cancel_requested: { by, at: now } }), now, String(id));
  insertEvent(db, { jobId: id, at: now, kind: 'cancel_requested', message: `cancel requested by ${by}; honoured at the next safe checkpoint` });
  return { ok: true, state: 'requested' };
}

// fenceJob(db, { id, owner, epoch, safe, leaseMs, nowMs }) — the executor's
// gate before every guest command: renews the lease (a heartbeat that changes
// nothing means ownership moved → FencedError) and, at a SAFE point, honours a
// pending cancel (CancelledError).
export function fenceJob(db, { id, owner, epoch, safe = false, leaseMs = DEFAULT_LEASE_MS, nowMs = Date.now() }) {
  if (!heartbeat(db, { id, owner, epoch, leaseMs, nowMs })) throw new FencedError(id);
  if (safe) {
    const row = getJob(db, id);
    const c = (parseJson(row?.progress_json) || {}).cancel_requested;
    if (c) throw new CancelledError(id, c.by);
  }
}

// staleRunningJobs(db, { nowMs, ownerKind }) → running jobs whose lease expired.
export function staleRunningJobs(db, { nowMs = Date.now(), ownerKind = null } = {}) {
  const rows = db.prepare(`SELECT * FROM setup_jobs WHERE status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`).all(iso(nowMs));
  return ownerKind ? rows.filter((r) => String(r.owner || '').startsWith(`${ownerKind}@`)) : rows;
}

// openJobsFor(db, app, kinds) → the queued/running jobs of these kinds for
// the app (what a restore must not be queued behind).
export function openJobsFor(db, app, kinds) {
  if (!Array.isArray(kinds) || !kinds.length) return [];
  const marks = kinds.map(() => '?').join(', ');
  return db.prepare(`SELECT * FROM setup_jobs WHERE app = ? AND kind IN (${marks}) AND status IN ('queued', 'running') ORDER BY created_at`).all(String(app), ...kinds);
}

export function openRecoveryJobFor(db, app) {
  return db.prepare(`SELECT * FROM setup_jobs WHERE app = ? AND kind = 'recover_app' AND status IN ('queued', 'running') ORDER BY created_at DESC LIMIT 1`).get(String(app)) || null;
}

// jobView(row) → the API shape: JSON columns parsed, nothing added.
export function jobView(row) {
  if (!row) return null;
  return {
    ...row,
    plan: parseJson(row.plan_json) || {},
    progress: parseJson(row.progress_json) || {},
    checkpoint: parseJson(row.checkpoint_json) || {},
    config_refs: parseJson(row.config_refs_json) || {},
    verification: parseJson(row.verification_json),
    plan_json: undefined, progress_json: undefined, checkpoint_json: undefined, config_refs_json: undefined, verification_json: undefined,
  };
}

// G1: reviewed intentions, separate from executable jobs (migration 1002).
export const PLATFORM_PLAN_SCHEMA = `
CREATE TABLE IF NOT EXISTS setup_platform_plan (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL CHECK (revision > 0),
  schema_version INTEGER NOT NULL,
  choices_json TEXT NOT NULL,
  checks_json TEXT NOT NULL,
  reviewed_at TEXT NOT NULL,
  reviewed_by TEXT NOT NULL
);`;
