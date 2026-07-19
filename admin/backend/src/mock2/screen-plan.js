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
  screenItemsFromInventory, buildItemsBuildInstruction,
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
  // Seed the per-screen FEATURE CHECKLIST (actions + states from the same
  // inventory). Best-effort — a checklist hiccup must not fail approval.
  try { syncScreenItems(projectId, inventory); } catch (e) { console.warn('[mock2] screen-item sync failed:', e?.message); }
  return listScreenPlan(projectId);
}

// ---- feature checklist items (mock2_screen_items, migration 536) ----

export function listScreenItems(projectId) {
  return getMock2Db()
    .prepare(`SELECT * FROM mock2_screen_items WHERE project_id = ? ORDER BY screen_id, id`)
    .all(Number(projectId));
}

// Sync the checklist to the (re-)approved inventory: items that survived keep
// their status (a design tweak must not forget what's finished); vanished
// items are removed unless a build is targeting them; new ones append pending.
function syncScreenItems(projectId, inventory) {
  const items = screenItemsFromInventory(inventory);
  const screenIdByName = new Map(listScreenPlan(projectId).map((s) => [s.name.toLowerCase(), s.id]));
  const db = getMock2Db();
  const existing = listScreenItems(projectId);
  const keyOf = (screenId, name, kind) => `${screenId}:${kind}:${String(name).toLowerCase()}`;
  const byKey = new Map(existing.map((r) => [keyOf(r.screen_id, r.name, r.kind), r]));
  const keep = new Set();
  const tx = db.transaction(() => {
    for (const it of items) {
      const sid = screenIdByName.get(it.screen_name.toLowerCase());
      if (!sid) continue;
      const cur = byKey.get(keyOf(sid, it.name, it.kind));
      if (cur) { keep.add(cur.id); continue; }
      db.prepare(`
        INSERT INTO mock2_screen_items (project_id, screen_id, name, kind, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'pending', ?, ?)
      `).run(Number(projectId), sid, it.name, it.kind, nowIso(), nowIso());
    }
    for (const r of existing) {
      if (!keep.has(r.id) && !r.request_id) db.prepare(`DELETE FROM mock2_screen_items WHERE id = ?`).run(r.id);
    }
  });
  tx();
}

// Manual is/isn't-done toggle (editor): the honest override for work verified
// by a human, or an item the initial build actually finished.
export function setScreenItemStatus(projectId, itemId, status) {
  if (!['pending', 'built'].includes(status)) return { ok: false, error: 'status must be pending or built' };
  const db = getMock2Db();
  const row = db.prepare(`SELECT * FROM mock2_screen_items WHERE project_id = ? AND id = ?`).get(Number(projectId), Number(itemId));
  if (!row) return { ok: false, error: 'item not found' };
  db.prepare(`UPDATE mock2_screen_items SET status = ?, updated_at = ? WHERE id = ?`).run(status, nowIso(), row.id);
  return { ok: true, row: db.prepare(`SELECT * FROM mock2_screen_items WHERE id = ?`).get(row.id) };
}

// startItemsBuild — "finish THESE next": one scoped build over the selected
// pending items (or all of them), stamped with the request so success settles
// exactly those items as built (failure returns them to selectable).
export async function startItemsBuild(projectId, { itemIds = null, initiatedBy = null } = {}) {
  const pid = Number(projectId);
  const project = getProject(pid);
  if (!project || project.lifecycle !== 'active') return { status: 'error', error: 'The project must be online to build.' };
  const pending = listScreenItems(pid).filter((r) => r.status === 'pending' && !r.request_id);
  const wanted = itemIds == null ? pending : pending.filter((r) => itemIds.map(Number).includes(r.id));
  if (!wanted.length) return { status: 'error', error: 'No pending checklist items selected.' };
  const screenName = new Map(listScreenPlan(pid).map((s) => [s.id, s.name]));
  const byScreen = new Map();
  for (const it of wanted) {
    const name = screenName.get(it.screen_id) || 'App';
    if (!byScreen.has(name)) byScreen.set(name, []);
    byScreen.get(name).push(it.name);
  }
  const groups = [...byScreen.entries()].map(([screen, items]) => ({ screen, items }));
  // Lazy import (same cycle-avoidance as the drain).
  const { startBuild } = await import('./audit.js');
  const res = await startBuild({
    project, instruction: buildItemsBuildInstruction(groups),
    user: { id: initiatedBy ?? project.created_by ?? null }, buildMode: 'quick',
  });
  if (res.status !== 'started') {
    return { status: 'error', error: res.error || res.reason || 'The build could not start.' };
  }
  const reqId = res.cycle?.request_id ?? null;
  if (reqId) {
    const db = getMock2Db();
    for (const it of wanted) {
      db.prepare(`UPDATE mock2_screen_items SET request_id = ?, updated_at = ? WHERE id = ?`).run(Number(reqId), nowIso(), it.id);
    }
  }
  return { status: 'started', count: wanted.length, request_id: reqId };
}

// reconcileScreenPlan — self-heal on read: rows still 'planned' although a
// LATER initial "everything at once" build SUCCEEDED settle as built (the
// request-close hook is fire-and-forget, so a hiccup there must not leave the
// panel stuck on "0/N built" forever). Only rows that existed BEFORE that
// build finished settle — a screen added by a later re-approval stays planned.
export function reconcileScreenPlan(projectId) {
  const pid = Number(projectId);
  const stale = listScreenPlan(pid).filter((r) => r.status === 'planned' && !r.request_id);
  if (!stale.length) return { settled: 0 };
  const req = getMock2Db().prepare(`
    SELECT id, finished_at FROM mock2_requests
    WHERE project_id = ? AND status = 'succeeded' AND instruction LIKE ?
    ORDER BY id DESC LIMIT 1
  `).get(pid, `${INITIAL_BUILD_INSTRUCTION_PREFIX}%`);
  if (!req?.finished_at) return { settled: 0 };
  const settleable = stale.filter((r) => String(r.created_at || '') <= String(req.finished_at));
  if (!settleable.length) return { settled: 0 };
  for (const r of settleable) updateScreenRow(r.id, { status: 'built', error: null });
  try {
    insertMessage({
      projectId: pid, kind: 'system',
      body: `Screens reconciled: the initial build succeeded, so ${settleable.length} screen${settleable.length === 1 ? ' is' : 's are'} now marked built. The feature checklist under each screen tracks what still needs finishing — select items and press "Build selected" to finish them next.`,
    });
  } catch { /* best effort */ }
  return { settled: settleable.length };
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
  // Feature-checklist items THIS request targeted settle with it: built on
  // success, back to selectable (stamp cleared) otherwise.
  try {
    const items = db.prepare(`SELECT * FROM mock2_screen_items WHERE request_id = ?`).all(Number(requestRow.id));
    if (items.length) {
      const ok = requestRow.status === 'succeeded';
      for (const it of items) {
        db.prepare(`UPDATE mock2_screen_items SET status = ?, request_id = NULL, updated_at = ? WHERE id = ?`)
          .run(ok ? 'built' : it.status, nowIso(), it.id);
      }
      const p = Number(requestRow.project_id);
      if (Number.isFinite(p)) {
        insertMessage({
          projectId: p, kind: 'system',
          body: ok
            ? `Checklist: ${items.length} feature${items.length === 1 ? '' : 's'} finished and marked built (${items.slice(0, 5).map((i) => i.name).join('; ')}${items.length > 5 ? '…' : ''}).`
            : `Checklist: the build targeting ${items.length} feature${items.length === 1 ? '' : 's'} ended ${requestRow.status} — they are selectable again.`,
        });
      }
    }
  } catch (e) { console.warn('[mock2] screen-item settle failed:', e?.message); }
  if (Number.isFinite(pid)) {
    try { await drainScreenQueue(pid); } catch (e) { console.warn('[mock2] screen queue drain failed:', e?.message); }
  }
}
