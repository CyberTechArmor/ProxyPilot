// Mock2 — the recorded database exception (mock2_database_exceptions, mock2.db
// migration 565) and the host-side reads that respect it.
//
// One row per project, written only by the sudo + audited route
// (database-exception-routes.js) when a person records that they explicitly
// asked for SQLite, in their own words. Everything that relaxes the "PostgreSQL
// is the only database" rule reads it from HERE — the gate's
// MOCK2_DATABASE_EXCEPTION (runner.runGateBattery), the finish guard, the
// command policy and the build prompt — so a file in the repository can never
// stand in for it. No MCP tool imports this module (ratchet in
// mock2-database-exception.test.js). The decisions are pure in
// database-exception-logic.js; this module only does the reads and writes.
//
// Terminology (risk R7): nothing here is named "agent".

import { getMock2Db } from './db.js';
import { shapeException, introducedEngineHits } from './database-exception-logic.js';
import { buildChangedEngineReadScript, parseChangedEngineRead } from './finish-guard-logic.js';

// The recorded exception, or null. A read failure (a pre-565 database, a
// locked file) is null: the strict rule applies — never the relaxed one.
export function getDatabaseException(projectId) {
  try {
    const row = getMock2Db()
      .prepare('SELECT engine, request_text, recorded_by, created_at FROM mock2_database_exceptions WHERE project_id = ?')
      .get(Number(projectId));
    return shapeException(row);
  } catch (e) {
    console.warn(`[mock2] database exception read failed for project ${projectId} (treated as none):`, e?.message);
    return null;
  }
}

// Record (or replace) the exception. `value` comes from validateExceptionInput.
export function setDatabaseException(projectId, { engine, request_text: requestText }, recordedBy, now = new Date().toISOString()) {
  const db = getMock2Db();
  db.prepare(`
    INSERT INTO mock2_database_exceptions (project_id, engine, request_text, recorded_by, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(project_id) DO UPDATE SET
      engine = excluded.engine, request_text = excluded.request_text,
      recorded_by = excluded.recorded_by, created_at = excluded.created_at
  `).run(Number(projectId), engine, requestText, String(recordedBy ?? ''), now);
  return getDatabaseException(projectId);
}

// Remove it. Returns the row that was removed (null when there was none).
export function clearDatabaseException(projectId) {
  const db = getMock2Db();
  const previous = getDatabaseException(projectId);
  db.prepare('DELETE FROM mock2_database_exceptions WHERE project_id = ?').run(Number(projectId));
  return previous;
}

// The refused engines THIS cycle's diff introduces, read from the container
// by the host (one round trip) and judged here — so a build cannot talk its way
// past it by editing the gate script copied into the container. Fails OPEN on
// a read error: the constitution-lint gate still scans the whole repository in
// every tier (in an app from before the foundation it blocks what is not at
// HEAD), and a container hiccup must not invent a finding.
//   containerSh(containerName, script, { timeoutMs }) → { code, stdout }
//   base: the commit the cycle started from (runner.readCycleBase), so a
//         commit the build made mid-cycle is still judged; HEAD when null.
export async function readIntroducedDatabaseEngines({ containerSh, containerName, appDir, projectId, base = null }) {
  try {
    const r = await containerSh(containerName, buildChangedEngineReadScript({ appDir, base }), { timeoutMs: 120000 });
    if (r?.code !== 0 && !r?.stdout) return [];
    return introducedEngineHits({ files: parseChangedEngineRead(r.stdout || ''), exception: getDatabaseException(projectId) });
  } catch (e) {
    console.warn(`[mock2] database engine diff read failed for project ${projectId} (not blocking; the gate still runs):`, e?.message);
    return [];
  }
}
