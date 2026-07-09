// Mock2 idle-stop sweep (Phase M3 groundwork).
//
// Stops the container of any ACTIVE project that has gone untouched for the
// configured window (mock2_settings.idle_stop_days), reclaiming its RAM
// (ADR-008: Postgres runs in-container, so idle projects are the RAM sink).
// This is the mechanism only — M3 wires it as an on-demand + boot pass, and M9
// adds the timer-driven enforcement + the "stopped" derived-status polish. Wake
// is restart-on-visit (provision.startWake), surfaced as a button in the UI.
//
// The decision (isIdleStale) is the pure predicate in project-logic.js so the
// threshold logic is unit-testable without Incus; this module is the
// DB-reading + host-acting shell.
//
// Terminology (risk R7): nothing here is named "agent".

import { listProjects } from './projects.js';
import { isIdleStale } from './project-logic.js';
import { getIdleStopDays } from './settings.js';
import { stopProjectContainer } from './provision.js';

// sweepIdleStops(now) — stop every active project idle ≥ the configured window.
// Returns { stopped, considered, days }. Never throws: a per-project stop
// failure is logged and skipped so one bad container can't abort the sweep. A
// window of 0 disables idle-stop entirely.
export async function sweepIdleStops(now = new Date().toISOString()) {
  const days = getIdleStopDays();
  if (!(days > 0)) return { stopped: 0, considered: 0, days };

  let projects = [];
  try {
    projects = listProjects();
  } catch (err) {
    console.error('[mock2] idle sweep: could not read projects:', err?.message);
    return { stopped: 0, considered: 0, days };
  }

  let stopped = 0;
  let considered = 0;
  for (const p of projects) {
    if (!isIdleStale(p, now, days)) continue;
    considered += 1;
    try {
      await stopProjectContainer(p);
      stopped += 1;
    } catch (err) {
      console.error(`[mock2] idle sweep: failed to stop project ${p.id}:`, err?.message);
    }
  }
  if (considered > 0) {
    console.log(`[mock2] idle sweep: stopped ${stopped}/${considered} project(s) idle ≥ ${days}d`);
  }
  return { stopped, considered, days };
}
