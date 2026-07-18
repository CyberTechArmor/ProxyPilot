// Mock2 screen plan — the native half (mock2_screen_plan, migration 531).
// Design approval seeds one row per inventory screen; the Builder approves or
// defers screens and queues them; the DRAIN loop below applies queued screens
// one at a time as scoped MVP build requests, in the background, while the
// Builder keeps reviewing. Sequenced on the existing writer lock: exactly one
// screen builds at a time, and each finished request (requests.closeRequest)
// re-drains the queue so the next screen starts without anyone watching.
//
// Terminology (risk R7): nothing here is named "agent".

import { getMock2Db } from './db.js';
import { getProject } from './projects.js';
import { insertMessage } from './chats.js';
import {
  screenPlanFromInventory, buildScreenBuildInstruction, nextQueuedScreen,
  isTransientStartError, SCREEN_DECISIONS, INITIAL_BUILD_INSTRUCTION_PREFIX,
} from './screen-plan-logic.js';

const nowIso = () => new Date().toISOString();

export function listScreenPlan(projectId) {
  return getMock2Db()
    .prepare(`SELECT * FROM mock2_screen_plan WHERE project_id = ? ORDER BY sort, id`)
    .all(Number(projectId));
}

export function getScreenPlanRow(projectId, id) {
  return getMock2Db()
    .prepare(`SELECT * FROM mock2_screen_plan WHERE project_id = ? AND id = ?`)
    .get(Number(projectId), Number(id)) || null;
}

function updateScreenRow(id, patch) {
  const cols = Object.keys(patch);
  if (!cols.length) return;
  const set = cols.map((c) => `${c} = ?`).join(', ');
  getMock2Db()
    .prepare(`UPDATE mock2_screen_plan SET ${set}, updated_at = ? WHERE id = ?`)
    .run(...cols.map((c) => patch[c]), nowIso(), Number(id));
}

// replaceScreenPlan — (re)seed the plan from an approved inventory. Existing
// rows for screens that survived keep their status (a re-approval after a
// design tweak must not forget what's already built); vanished screens are
// removed unless they're tied to a build; new screens append as 'planned'.
export function replaceScreenPlan(projectId, inventory) {
  const rows = screenPlanFromInventory(inventory);
  const db = getMock2Db();
  const existing = listScreenPlan(projectId);
  const byName = new Map(existing.map((r) => [r.name.toLowerCase(), r]));
  const keep = new Set();
  const tx = db.transaction(() => {
    for (const r of rows) {
      const cur = byName.get(r.name.toLowerCase());
      if (cur) {
        keep.add(cur.id);
        db.prepare(`UPDATE mock2_screen_plan SET purpose = ?, sort = ?, updated_at = ? WHERE id = ?`)
          .run(r.purpose, r.sort, nowIso(), cur.id);
      } else {
        db.prepare(`
          INSERT INTO mock2_screen_plan (project_id, name, purpose, sort, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'planned', ?, ?)
        `).run(Number(projectId), r.name, r.purpose, r.sort, nowIso(), nowIso());
      }
    }
    for (const r of existing) {
      if (!keep.has(r.id) && !r.request_id) {
        db.prepare(`DELETE FROM mock2_screen_plan WHERE id = ?`).run(r.id);
      }
    }
  });
  tx();
  return listScreenPlan(projectId);
}

// decideScreen — the Builder's per-screen call: keep it in the plan or park it.
// Only free rows can flip (a queued/building/built screen is past deciding).
export function decideScreen(projectId, id, status) {
  if (!SCREEN_DECISIONS.includes(status)) return { ok: false, error: 'unknown screen decision' };
  const row = getScreenPlanRow(projectId, id);
  if (!row) return { ok: false, error: 'screen not found' };
  if (!['planned', 'deferred', 'failed'].includes(row.status)) {
    return { ok: false, error: `screen is ${row.status} — it can no longer be ${status}` };
  }
  updateScreenRow(id, { status, error: null });
  return { ok: true, row: getScreenPlanRow(projectId, id) };
}

// queueScreens — mark the chosen (or all planned) screens 'queued' for the
// background drain. Returns how many were queued.
export function queueScreens(projectId, { ids = null, queuedBy = null } = {}) {
  const rows = listScreenPlan(projectId).filter((r) => ['planned', 'failed'].includes(r.status));
  const wanted = ids == null ? rows : rows.filter((r) => ids.map(Number).includes(r.id));
  for (const r of wanted) updateScreenRow(r.id, { status: 'queued', queued_by: queuedBy, error: null });
  return wanted.length;
}

// ---- the background drain (one screen build at a time) ----

// In-process re-entrancy guard: one drain per project at a time. The DB state
// ('building' rows / the writer lock) is the real serializer; this just stops
// a double-kick from racing startBuild.
const draining = new Set();

export async function drainScreenQueue(projectId) {
  const pid = Number(projectId);
  if (draining.has(pid)) return { status: 'draining' };
  draining.add(pid);
  try {
    const rows = listScreenPlan(pid);
    const next = nextQueuedScreen(rows);
    if (!next) return { status: 'idle' };
    const project = getProject(pid);
    if (!project || project.lifecycle !== 'active') return { status: 'idle' };

    // Lazy import: audit.js (startBuild) sits above this module in the import
    // graph via concept.js — a static import would be a cycle.
    const { startBuild } = await import('./audit.js');
    const res = await startBuild({
      project,
      instruction: buildScreenBuildInstruction(next),
      user: { id: next.queued_by ?? project.created_by ?? null },
      buildMode: 'mvp',
    });
    if (res.status === 'started') {
      updateScreenRow(next.id, { status: 'building', request_id: res.cycle?.request_id ?? null });
      return { status: 'started', screen: next.name };
    }
    if (isTransientStartError(res.error)) {
      // Another writer holds the checkout — stay queued; the next request close
      // (or the next apply press) re-drains.
      return { status: 'waiting', error: res.error };
    }
    updateScreenRow(next.id, { status: 'failed', error: String(res.error || 'build did not start').slice(0, 500) });
    try {
      insertMessage({ projectId: pid, kind: 'system', body: `Screen "${next.name}" could not start building: ${res.error}` });
    } catch { /* best effort */ }
    // Try the next screen rather than stalling the whole queue.
    draining.delete(pid);
    return drainScreenQueue(pid);
  } finally {
    draining.delete(pid);
  }
}

// onRequestClosed — called (via dynamic import) from requests.closeRequest
// whenever ANY build request reaches a terminal status. Settles the screen the
// request implemented (if it was a screen build) and drains the next one.
export async function onRequestClosed(requestRow) {
  if (!requestRow?.id) return;
  const db = getMock2Db();
  const row = db.prepare(`SELECT * FROM mock2_screen_plan WHERE request_id = ?`).get(Number(requestRow.id));
  const pid = Number(requestRow.project_id ?? row?.project_id);
  if (row) {
    const ok = requestRow.status === 'succeeded';
    updateScreenRow(row.id, {
      status: ok ? 'built' : 'failed',
      error: ok ? null : `build request ${requestRow.id} ended ${requestRow.status}`,
    });
    if (ok) {
      const left = listScreenPlan(row.project_id).filter((r) => r.status === 'queued').length;
      try {
        insertMessage({
          projectId: row.project_id, kind: 'system',
          body: `Screen "${row.name}" is built and live.${left ? ` ${left} queued screen${left === 1 ? '' : 's'} remaining — continuing in the background.` : ' The screen queue is empty.'}`,
        });
      } catch { /* best effort */ }
    }
  } else if (
    requestRow.status === 'succeeded'
    && String(requestRow.instruction || '').startsWith(INITIAL_BUILD_INSTRUCTION_PREFIX)
    && Number.isFinite(pid)
  ) {
    // The initial "everything at once" build implements EVERY inventory screen
    // in one pass — settle all still-open rows as built, or the Screens panel
    // shows "0/N built" over a fully working app and invites a redundant
    // screen-by-screen rebuild of things that already exist.
    const open = listScreenPlan(pid).filter((r) => ['planned', 'queued', 'building'].includes(r.status));
    for (const r of open) updateScreenRow(r.id, { status: 'built', error: null });
    if (open.length) {
      try {
        insertMessage({
          projectId: pid, kind: 'system',
          body: `The initial build implemented all ${open.length} screen${open.length === 1 ? '' : 's'} from the approved design — the Screens panel now shows them as built. Use Quick updates to refine them, and the Production check when you're ready to harden what stays.`,
        });
      } catch { /* best effort */ }
    }
  }
  if (Number.isFinite(pid)) {
    try { await drainScreenQueue(pid); } catch (e) { console.warn('[mock2] screen queue drain failed:', e?.message); }
  }
}
