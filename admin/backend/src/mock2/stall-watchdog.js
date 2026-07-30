// Mock2 STALL WATCHDOG — the periodic "is anything wedged?" sweep (operator
// report: an API hiccup killed a build mid-flight and the platform sat on
// "Building now:" with nothing to click). Two wedge shapes, both recovered
// here without anyone watching:
//
//   1. a RUNNING cycle with no event activity past the stall threshold — the
//      model call hung and even the model-client idle watchdog's recovery went
//      quiet. Stopped safely: 'interrupted' + pause_reason 'stalled', lock
//      released, a chat note pointing at Restart/Continue (the cycle stays
//      resumable from its last checkpoint via the normal retry machinery).
//   2. a 'started' build-queue row with no live cycle behind it — requeued once
//      (build-queue.requeueOrphanedStartedBuilds) and the queue drained.
//
// The DECISION is the pure cycle-logic.buildStallVerdict; this module is the
// native half. Registered in index.js on a 60s timer (mock2-enabled hosts
// only). Never throws — a sweep failure is logged and the next tick retries.
//
// Terminology (risk R7): nothing here is named "agent".

import { getMock2Db } from './db.js';
import { finishCycle, updateCycle, latestCycle } from './cycles.js';
import { lastCycleEventAt } from './cycle-events.js';
import { buildStallVerdict, queueMayAdvancePast } from './cycle-logic.js';
import { getStallSettings } from './settings.js';
import { releaseLock } from './locks.js';
import { insertMessage } from './chats.js';
import { requeueOrphanedStartedBuilds, drainBuildQueue } from './build-queue.js';

export async function sweepStalledBuilds({ nowMs = Date.now(), env = process.env } = {}) {
  const summary = { interrupted: 0, requeued: 0, dropped: 0 };
  let db;
  try { db = getMock2Db(); } catch { return summary; }
  // The HARD-stop threshold (dashboard-tunable, default 30 min; the manual
  // Restart offer in the chat fires earlier at restart_minutes).
  const threshold = getStallSettings(env).hard_minutes;

  // 1) Running cycles gone silent.
  let running = [];
  try { running = db.prepare(`SELECT * FROM mock2_cycles WHERE status = 'running'`).all(); } catch { running = []; }
  for (const cycle of running) {
    try {
      const verdict = buildStallVerdict({
        nowMs,
        status: cycle.status,
        startedAt: cycle.started_at || cycle.created_at,
        lastEventAt: lastCycleEventAt(cycle.id),
        thresholdMinutes: threshold,
      });
      if (!verdict.stalled) continue;
      const idleMin = Math.max(1, Math.round(verdict.idleMs / 60000));
      finishCycle(cycle.id, {
        status: 'interrupted',
        error: `build stalled: no activity for ~${idleMin} minutes (likely a dropped API connection) — stopped safely by the stall watchdog. Restart/Continue picks up from the last checkpoint.`,
      });
      updateCycle(cycle.id, { pause_reason: 'stalled' });
      try { releaseLock(cycle.project_id, { type: 'cycle', id: cycle.id }); } catch { /* best effort */ }
      try {
        insertMessage({
          projectId: cycle.project_id,
          kind: 'system',
          body: `The build stopped responding for ~${idleMin} minutes (likely an API hiccup) and was stopped safely. Use “Restart build” to pick up from the last checkpoint — no work was lost.`,
        });
      } catch { /* best effort */ }
      summary.interrupted += 1;
      console.warn(`[mock2] stall watchdog stopped cycle ${cycle.id} (project ${cycle.project_id}) after ~${idleMin}m of silence`);
    } catch (err) {
      console.warn('[mock2] stall sweep cycle check failed:', err?.message);
    }
  }

  // 2) Orphaned queue rows, then a drain for every project with queue entries —
  // the drain is what actually starts the requeued work (it settles first,
  // dedupes re-entrancy, and refuses transiently if a writer holds the lock).
  let projectIds = [];
  try {
    projectIds = db.prepare(`SELECT DISTINCT project_id FROM mock2_build_queue WHERE status IN ('queued','started')`).all().map((r) => r.project_id);
  } catch { projectIds = []; }
  for (const pid of projectIds) {
    try {
      const fix = requeueOrphanedStartedBuilds(pid, { nowMs });
      summary.requeued += fix.requeued.length;
      summary.dropped += fix.failed.length;
      // Same guard as the poll-route self-heal: never drain past a BLOCKED
      // cycle (awaiting_admin, or awaiting_user on open rule questions) —
      // its resume needs the checkout lock a queued build would take.
      if (queueMayAdvancePast(latestCycle(pid))) await drainBuildQueue(pid);
    } catch (err) {
      console.warn(`[mock2] stall sweep queue drain failed (project ${pid}):`, err?.message);
    }
  }
  if (summary.interrupted || summary.requeued || summary.dropped) {
    console.log(`[mock2] stall watchdog: interrupted ${summary.interrupted} cycle(s), requeued ${summary.requeued}, dropped ${summary.dropped}`);
  }
  return summary;
}
