// Mock2 per-cycle event log (mock2_cycle_events, migration 512) — the durable
// transcript of a build. setJob carries only ephemeral progress; this records the
// actual steps so a cycle can be reviewed and downloaded after the fact ("how did
// it do?"): the task text, each AI message, each tool call + (truncated) result,
// gate outcomes, the checkpoint, and the deploy.
//
// Writes are best-effort — logging must NEVER break a build — so insertCycleEvent
// swallows its own errors and the runner wraps calls defensively too. Native
// (getMock2Db); reached only on an enabled host.
//
// Terminology (risk R7): nothing here is named "agent".

import { getMock2Db } from './db.js';

const nowIso = () => new Date().toISOString();

// How much of a tool result / AI message we persist. Bounds row size while
// keeping enough to evaluate what happened (a huge exec dump is truncated).
export const MAX_EVENT_CONTENT_CHARS = 8000;

function clip(text) {
  const s = String(text ?? '');
  if (s.length <= MAX_EVENT_CONTENT_CHARS) return s;
  return `${s.slice(0, MAX_EVENT_CONTENT_CHARS)}\n…[truncated ${s.length - MAX_EVENT_CONTENT_CHARS} chars]`;
}

// Append one event to a cycle's log. seq is derived per-cycle inside the insert
// so concurrent appends can't collide. kind ∈ task | ai_message | tool_call |
// tool_result | gate | checkpoint | deploy | note. Best-effort: never throws.
export function insertCycleEvent({ projectId, cycleId, kind, role = null, content = null, meta = null }) {
  try {
    const db = getMock2Db();
    const last = db.prepare(`SELECT MAX(seq) AS m FROM mock2_cycle_events WHERE cycle_id = ?`).get(Number(cycleId));
    const seq = (last?.m || 0) + 1;
    db.prepare(
      `INSERT INTO mock2_cycle_events (project_id, cycle_id, seq, kind, role, content, meta_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      Number(projectId), Number(cycleId), seq, String(kind), role,
      content == null ? null : clip(content),
      meta == null ? null : JSON.stringify(meta),
      nowIso(),
    );
  } catch (err) {
    // Logging is never allowed to fail a build.
    console.warn('[mock2] cycle-event write failed:', err?.message);
  }
}

function shapeEvent(row) {
  let meta = null;
  try { meta = row.meta_json ? JSON.parse(row.meta_json) : null; } catch { meta = null; }
  return {
    seq: row.seq, kind: row.kind, role: row.role || null,
    content: row.content || null, meta, created_at: row.created_at,
  };
}

export function listCycleEvents(cycleId) {
  return getMock2Db()
    .prepare(`SELECT * FROM mock2_cycle_events WHERE cycle_id = ? ORDER BY seq ASC`)
    .all(Number(cycleId))
    .map(shapeEvent);
}

export function listProjectCycleEvents(projectId) {
  return getMock2Db()
    .prepare(`SELECT * FROM mock2_cycle_events WHERE project_id = ? ORDER BY id ASC`)
    .all(Number(projectId))
    .map(shapeEvent);
}

// The Builder's thumbs up/down verdict on a finished build, stored as a normal
// event (kind 'feedback') so it rides the downloadable log for later evaluation.
// A thumbs-down carries the required note. getCycleFeedback returns the latest one
// (or null) — the UI uses it to know whether a build still needs rating before the
// next cycle. NOT best-effort: a feedback write must land (it gates the flow), so
// this one is allowed to throw.
export function recordCycleFeedback({ projectId, cycleId, rating, note = null, userId = null }) {
  const db = getMock2Db();
  const last = db.prepare(`SELECT MAX(seq) AS m FROM mock2_cycle_events WHERE cycle_id = ?`).get(Number(cycleId));
  const seq = (last?.m || 0) + 1;
  db.prepare(
    `INSERT INTO mock2_cycle_events (project_id, cycle_id, seq, kind, role, content, meta_json, created_at)
     VALUES (?, ?, ?, 'feedback', 'user', ?, ?, ?)`,
  ).run(
    Number(projectId), Number(cycleId), seq,
    note == null ? null : clip(note),
    JSON.stringify({ rating, user_id: userId }),
    nowIso(),
  );
  return getCycleFeedback(cycleId);
}

// The most recent thumbs-DOWN notes for a project (deduped, newest first) —
// distilled into every build task as standing operator taste ("stop repeating
// what I already flagged"). Up-rated builds carry no note and are skipped.
export function listRecentDownNotes(projectId, limit = 5) {
  const rows = getMock2Db()
    .prepare(`SELECT content, meta_json FROM mock2_cycle_events
              WHERE project_id = ? AND kind = 'feedback' AND content IS NOT NULL AND content != ''
              ORDER BY id DESC LIMIT 40`)
    .all(Number(projectId));
  const notes = [];
  for (const r of rows) {
    let rating = null;
    try { rating = JSON.parse(r.meta_json || '{}').rating; } catch { continue; }
    if (rating !== 'down') continue;
    const t = String(r.content).trim();
    if (t && !notes.includes(t)) notes.push(t);
    if (notes.length >= limit) break;
  }
  return notes;
}

export function getCycleFeedback(cycleId) {
  const row = getMock2Db()
    .prepare(`SELECT * FROM mock2_cycle_events WHERE cycle_id = ? AND kind = 'feedback' ORDER BY seq DESC LIMIT 1`)
    .get(Number(cycleId));
  if (!row) return null;
  const ev = shapeEvent(row);
  return { rating: ev.meta?.rating || null, note: ev.content || null, created_at: ev.created_at };
}
