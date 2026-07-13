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
