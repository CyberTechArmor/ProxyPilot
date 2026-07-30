// Mock2 BUILD REQUEST QUEUE (migration 538) — quick updates submitted while
// another build holds the writer lock wait here and run back-to-back
// automatically, in submission order. Split-request groups (the pre-pass's
// feature-scale split card) enqueue the same way, so "part 1 deploys while
// part 2 builds" needs nobody watching.
//
// Mirrors the screen-plan drain: requests.closeRequest re-drains on every
// finished request; a transient start refusal (another writer) stays queued;
// a hard failure marks the entry failed with a chat note and moves on.
//
// Terminology (risk R7): nothing here is named "agent".

import { getMock2Db } from './db.js';
import { getProject } from './projects.js';
import { insertMessage } from './chats.js';
import { isTransientStartError } from './screen-plan-logic.js';
import { queueRowConcluded } from './cycle-logic.js';

const nowIso = () => new Date().toISOString();

export function enqueueBuild({ projectId, instruction, buildMode = 'quick', label = null, initiatedBy = null }) {
  const db = getMock2Db();
  const info = db.prepare(`
    INSERT INTO mock2_build_queue (project_id, instruction, build_mode, label, initiated_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(Number(projectId), String(instruction), String(buildMode), label, initiatedBy == null ? null : String(initiatedBy), nowIso(), nowIso());
  return db.prepare(`SELECT * FROM mock2_build_queue WHERE id = ?`).get(info.lastInsertRowid);
}

// The live view: everything still queued plus the currently-started entry —
// the UI's "building now: X, then Y, then Z" strip. Terminal rows age out of
// the view (they stay in the table as the durable record).
export function listBuildQueue(projectId) {
  return getMock2Db().prepare(`
    SELECT * FROM mock2_build_queue
    WHERE project_id = ? AND (status = 'queued' OR (status = 'started' AND updated_at > datetime('now', '-1 day')))
    ORDER BY id
  `).all(Number(projectId));
}

export function cancelQueuedBuild(projectId, id) {
  const db = getMock2Db();
  const row = db.prepare(`SELECT * FROM mock2_build_queue WHERE project_id = ? AND id = ?`).get(Number(projectId), Number(id));
  if (!row) return { ok: false, error: 'queue entry not found' };
  if (row.status !== 'queued') return { ok: false, error: `entry is ${row.status} — only a queued build can be cancelled` };
  db.prepare(`UPDATE mock2_build_queue SET status = 'cancelled', updated_at = ? WHERE id = ?`).run(nowIso(), row.id);
  return { ok: true };
}

function markQueueRow(id, patch) {
  const db = getMock2Db();
  const cols = Object.keys(patch);
  db.prepare(`UPDATE mock2_build_queue SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
    .run(...cols.map((c) => patch[c]), nowIso(), Number(id));
}

// A started entry whose build finished: settle it (the request hook calls
// this before draining the next one, so the queue view stays truthful).
export function settleStartedBuilds(projectId) {
  const db = getMock2Db();
  const started = db.prepare(`SELECT * FROM mock2_build_queue WHERE project_id = ? AND status = 'started'`).all(Number(projectId));
  for (const row of started) {
    if (!row.request_id) continue;
    const req = db.prepare(`SELECT status FROM mock2_requests WHERE id = ?`).get(row.request_id);
    if (req && req.status !== 'open' && req.status !== 'running') {
      // Terminal either way — the queue entry's job is done; the request/cycle
      // record carries the outcome.
      db.prepare(`DELETE FROM mock2_build_queue WHERE id = ?`).run(row.id);
      continue;
    }
    // The request can be STILL OPEN with the build nonetheless concluded:
    // pending-operator-verification deliberately keeps the request open (a
    // failed live check resumes it as a new segment), and a crash between
    // finishCycle and closeRequest leaves the same shape. Judge by the CYCLE:
    // its latest segment settled in a state the queue may advance past means
    // this slot is done — otherwise "Building now:" sits forever over a build
    // that already deployed, and everything queued behind it is wedged.
    const latest = db.prepare(`SELECT status, verification_state FROM mock2_cycles WHERE request_id = ? ORDER BY id DESC LIMIT 1`).get(row.request_id);
    if (latest && queueRowConcluded(latest)) {
      db.prepare(`DELETE FROM mock2_build_queue WHERE id = ?`).run(row.id);
    }
  }
}

// A 'started' row whose request has NO live cycle behind it is an ORPHAN: the
// start died between marking the row and the cycle surviving (the observed
// wedge — "Building now: …" over an idle chat after an API hiccup killed the
// start, with nothing to click). Requeue it ONCE (the error column carries the
// marker so a second orphaning means the instruction itself cannot start —
// that one is marked failed with a chat note and the queue moves on). Rows
// younger than graceMs are left alone: a row legitimately flips 'started'
// moments before its cycle exists. Settles finished rows first so a
// legitimately-completed request is deleted, not requeued.
const ORPHAN_REQUEUED_MARKER = 'requeued after a stall';
const LIVE_CYCLE_STATUSES = `('queued','estimating','running','awaiting_user','awaiting_admin')`;

export function requeueOrphanedStartedBuilds(projectId, { nowMs = Date.now(), graceMs = 3 * 60000 } = {}) {
  const pid = Number(projectId);
  const db = getMock2Db();
  settleStartedBuilds(pid);
  const started = db.prepare(`SELECT * FROM mock2_build_queue WHERE project_id = ? AND status = 'started'`).all(pid);
  const requeued = [];
  const failed = [];
  for (const row of started) {
    const updated = Date.parse(row.updated_at || row.created_at || '');
    if (Number.isFinite(updated) && nowMs - updated < graceMs) continue;
    const live = row.request_id
      ? db.prepare(`SELECT id FROM mock2_cycles WHERE request_id = ? AND status IN ${LIVE_CYCLE_STATUSES} LIMIT 1`).get(row.request_id)
      : null;
    if (live) continue;
    if (row.error === ORPHAN_REQUEUED_MARKER) {
      markQueueRow(row.id, { status: 'failed', error: 'could not restart after a stall (orphaned twice)' });
      failed.push(row.id);
      try {
        insertMessage({ projectId: pid, kind: 'system', body: `A queued build could not be restarted after a stall and was dropped: ${row.label || row.instruction.slice(0, 80)}. Submit it again to retry.` });
      } catch { /* best effort */ }
      continue;
    }
    markQueueRow(row.id, { status: 'queued', request_id: null, error: ORPHAN_REQUEUED_MARKER });
    requeued.push(row.id);
    try {
      insertMessage({ projectId: pid, kind: 'system', body: `A build start was lost (likely an API hiccup) — requeued: ${row.label || row.instruction.slice(0, 80)}` });
    } catch { /* best effort */ }
  }
  return { requeued, failed };
}

// In-process re-entrancy guard (the DB writer lock is the real serializer).
const draining = new Set();

export async function drainBuildQueue(projectId) {
  const pid = Number(projectId);
  if (draining.has(pid)) return { status: 'draining' };
  draining.add(pid);
  try {
    settleStartedBuilds(pid);
    const db = getMock2Db();
    if (db.prepare(`SELECT id FROM mock2_build_queue WHERE project_id = ? AND status = 'started'`).get(pid)) {
      return { status: 'busy' }; // one at a time; the close hook re-drains
    }
    const next = db.prepare(`SELECT * FROM mock2_build_queue WHERE project_id = ? AND status = 'queued' ORDER BY id LIMIT 1`).get(pid);
    if (!next) return { status: 'idle' };
    const project = getProject(pid);
    if (!project || project.lifecycle !== 'active') return { status: 'idle' };

    // Lazy import (audit.js sits above this module via concept.js).
    const { startBuild } = await import('./audit.js');
    const res = await startBuild({
      project, instruction: next.instruction,
      user: { id: next.initiated_by ?? project.created_by ?? null },
      buildMode: next.build_mode || 'quick',
    });
    if (res.status === 'started') {
      markQueueRow(next.id, { status: 'started', request_id: res.cycle?.request_id ?? null });
      try {
        insertMessage({ projectId: pid, kind: 'system', body: `Queued build started: ${next.label || next.instruction.slice(0, 120)}` });
      } catch { /* best effort */ }
      return { status: 'started', id: next.id };
    }
    if (isTransientStartError(res.error)) return { status: 'waiting', error: res.error };
    markQueueRow(next.id, { status: 'failed', error: String(res.error || 'build did not start').slice(0, 500) });
    try {
      insertMessage({ projectId: pid, kind: 'system', body: `Queued build could not start (${next.label || next.instruction.slice(0, 80)}): ${res.error}` });
    } catch { /* best effort */ }
    draining.delete(pid);
    return drainBuildQueue(pid); // move on to the next entry
  } finally {
    draining.delete(pid);
  }
}

// The UI shape.
export function publicQueueShape(row) {
  return {
    id: row.id,
    label: row.label || null,
    instruction: row.instruction,
    build_mode: row.build_mode,
    status: row.status,
    request_id: row.request_id ?? null,
    created_at: row.created_at,
  };
}
