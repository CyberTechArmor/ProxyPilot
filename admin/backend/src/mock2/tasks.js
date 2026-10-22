// Mock2 task store (mock2_tasks, migration 562) — the thin better-sqlite3 half
// of task continuity. Returns HYDRATED tasks (task-logic.hydrateTask); every
// decision (key, redaction, status mapping, routing, file text) is the pure
// task-logic.js. Native (getMock2Db) — reached only on an enabled host; tests
// stub ./db.js at the module boundary.
//
// The row is authoritative for execution and authorization state. The files
// under state/tasks/<key>/ are written FROM it (task-files.js) and record which
// revision they mirror in files_revision; nothing is ever read back from them.
//
// Terminology (risk R7): nothing here is named "agent".

import { getMock2Db } from './db.js';
import {
  TASK_INTENTS, TASK_STATUSES, FINISHED_TASK_STATUSES, UNFINISHED_TASK_STATUSES,
  DEFAULT_TASK_FOLDER, MAX_COMPLETED_STEPS, MAX_UNCERTAIN,
  makeTaskKey, isValidTaskKey, sanitizeTaskText, hydrateTask, appendStep,
} from './task-logic.js';

const nowIso = () => new Date().toISOString();

const GOAL_MAX = 500;
const TEXT_MAX = 500;

function cleanText(v, max = TEXT_MAX) {
  if (v == null) return null;
  const s = sanitizeTaskText(v, { max });
  return s || null;
}

function cleanList(v, maxItems) {
  if (!Array.isArray(v)) return [];
  return v
    .filter((s) => typeof s === 'string' || typeof s === 'number')
    .map((s) => sanitizeTaskText(String(s), { max: TEXT_MAX }))
    .filter(Boolean)
    .slice(0, maxItems);
}

function cleanSteps(v) {
  if (!Array.isArray(v)) return [];
  return v
    .filter((s) => s && typeof s === 'object' && s.step != null)
    .map((s) => ({ step: sanitizeTaskText(String(s.step).replace(/\s+/g, ' '), { max: 300 }), at: s.at == null ? null : String(s.at) }))
    .filter((s) => s.step)
    .slice(-MAX_COMPLETED_STEPS);
}

function cleanChecks(v) {
  if (!Array.isArray(v)) return [];
  return v
    .filter((c) => c && typeof c === 'object' && c.key != null)
    .slice(0, 40)
    .map((c) => ({ key: sanitizeTaskText(String(c.key), { max: 80 }), status: c.status == null ? null : sanitizeTaskText(String(c.status), { max: 40 }) }));
}

const intOrNull = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
};

// camelCase patch key → [column, serialiser]. Anything else in a patch is
// ignored, so a caller can never write task_key, revision or authorization.
const PATCH_FIELDS = Object.freeze({
  status: ['status', (v) => v],
  lastCycleId: ['last_cycle_id', intOrNull],
  lastVerifiedStep: ['last_verified_step', (v) => cleanText(v)],
  nextStep: ['next_step', (v) => cleanText(v)],
  completedSteps: ['completed_steps_json', (v) => JSON.stringify(cleanSteps(v))],
  checks: ['checks_json', (v) => JSON.stringify(cleanChecks(v))],
  blockers: ['blockers_json', (v) => JSON.stringify(cleanList(v, 10))],
  remaining: ['remaining_json', (v) => JSON.stringify(cleanList(v, 30))],
  uncertain: ['uncertain_json', (v) => JSON.stringify(cleanList(v, MAX_UNCERTAIN))],
  context: ['context_json', (v) => (v && typeof v === 'object' && !Array.isArray(v) ? JSON.stringify(v) : null)],
  branch: ['branch', (v) => cleanText(v, 200)],
  requestId: ['request_id', intOrNull],
});

function rowById(db, id) {
  return db.prepare(`SELECT * FROM mock2_tasks WHERE id = ?`).get(Number(id));
}

// createTask — insert, then stamp task_key = makeTaskKey(id, goal) in the same
// transaction (the key needs the id). One build task per request: a second
// create for a request that already has one returns the existing task instead
// of tripping the unique index, so a retried hook can never fork the task.
export function createTask({
  projectId, intent, goal, requestId = null, authorizedBy = null, folder = DEFAULT_TASK_FOLDER,
  branch = null, context = null, status = 'active',
} = {}) {
  if (!TASK_INTENTS.includes(intent)) throw new Error(`invalid task intent: ${intent}`);
  if (!TASK_STATUSES.includes(status)) throw new Error(`invalid task status: ${status}`);
  const pid = Number(projectId);
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('createTask needs a project id');
  const db = getMock2Db();
  const cleanGoal = sanitizeTaskText(String(goal ?? '').replace(/\s+/g, ' '), { max: GOAL_MAX }) || 'Untitled task';
  const reqId = intOrNull(requestId);
  const now = nowIso();
  const id = db.transaction(() => {
    if (reqId != null) {
      const existing = db.prepare(`SELECT id FROM mock2_tasks WHERE request_id = ?`).get(reqId);
      if (existing) return Number(existing.id);
    }
    const r = db.prepare(
      `INSERT INTO mock2_tasks (
         project_id, intent, status, goal, request_id, authorized_by, authorized_at, folder, branch,
         completed_steps_json, checks_json, blockers_json, remaining_json, uncertain_json, context_json,
         revision, files_revision, created_at, updated_at, finished_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', '[]', '[]', '[]', '[]', ?, 1, 0, ?, ?, ?)`,
    ).run(
      pid, intent, status, cleanGoal, reqId, intOrNull(authorizedBy), now,
      cleanText(folder, 200) || DEFAULT_TASK_FOLDER, cleanText(branch, 200),
      context && typeof context === 'object' && !Array.isArray(context) ? JSON.stringify(context) : null,
      now, now, FINISHED_TASK_STATUSES.includes(status) ? now : null,
    );
    const newId = Number(r.lastInsertRowid);
    db.prepare(`UPDATE mock2_tasks SET task_key = ? WHERE id = ?`).run(makeTaskKey(newId, cleanGoal), newId);
    return newId;
  })();
  return hydrateTask(rowById(db, id));
}

export function getTask(id) {
  return hydrateTask(rowById(getMock2Db(), id));
}

export function getTaskByKey(projectId, key) {
  if (!isValidTaskKey(key)) return null;
  return hydrateTask(getMock2Db()
    .prepare(`SELECT * FROM mock2_tasks WHERE project_id = ? AND task_key = ?`)
    .get(Number(projectId), key));
}

export function getTaskForRequest(requestId) {
  const reqId = intOrNull(requestId);
  if (reqId == null) return null;
  return hydrateTask(getMock2Db().prepare(`SELECT * FROM mock2_tasks WHERE request_id = ?`).get(reqId));
}

// Newest updated first (ties → higher id, the later task).
export function listTasks(projectId, { limit = 50, unfinishedOnly = false } = {}) {
  const lim = Math.min(Math.max(Math.trunc(Number(limit)) || 50, 1), 500);
  const where = unfinishedOnly
    ? `AND status IN (${UNFINISHED_TASK_STATUSES.map(() => '?').join(', ')})`
    : '';
  return getMock2Db()
    .prepare(`SELECT * FROM mock2_tasks WHERE project_id = ? ${where} ORDER BY updated_at DESC, id DESC LIMIT ?`)
    .all(Number(projectId), ...(unfinishedOnly ? UNFINISHED_TASK_STATUSES : []), lim)
    .map(hydrateTask);
}

// Every project's tasks in the given statuses — the boot sweep's view.
export function listTasksByStatus(statuses) {
  const wanted = (Array.isArray(statuses) ? statuses : [statuses]).filter((s) => TASK_STATUSES.includes(s));
  if (!wanted.length) return [];
  return getMock2Db()
    .prepare(`SELECT * FROM mock2_tasks WHERE status IN (${wanted.map(() => '?').join(', ')}) ORDER BY id ASC`)
    .all(...wanted)
    .map(hydrateTask);
}

// The UPDATE behind updateTask / recordTaskStep. Returns false when the patch
// names nothing writable — no revision bump, so no pointless file rewrite.
function applyPatch(db, id, patch) {
  const sets = [];
  const args = [];
  for (const [k, v] of Object.entries(patch || {})) {
    if (!Object.hasOwn(PATCH_FIELDS, k) || v === undefined) continue;
    if (k === 'status' && !TASK_STATUSES.includes(v)) {
      console.warn(`[mock2] task ${id}: ignored unknown status ${JSON.stringify(String(v).slice(0, 40))}`);
      continue;
    }
    const [col, ser] = PATCH_FIELDS[k];
    sets.push(`${col} = ?`);
    args.push(ser(v));
  }
  if (!sets.length) return false;
  const now = nowIso();
  if (Object.hasOwn(patch, 'status') && TASK_STATUSES.includes(patch.status)) {
    // completed/stopped stamp finished_at; any unfinished status clears it
    // (a resumed task is not finished any more).
    sets.push('finished_at = ?');
    args.push(FINISHED_TASK_STATUSES.includes(patch.status) ? now : null);
  }
  sets.push('revision = revision + 1', 'updated_at = ?');
  args.push(now);
  return db.prepare(`UPDATE mock2_tasks SET ${sets.join(', ')} WHERE id = ?`).run(...args, Number(id)).changes > 0;
}

// updateTask(id, patch) — camelCase patch keys (PATCH_FIELDS); unknown keys
// ignored. Returns the hydrated task (null when it does not exist).
export function updateTask(id, patch = {}) {
  const db = getMock2Db();
  applyPatch(db, id, patch);
  return hydrateTask(rowById(db, id));
}

// recordTaskStep — append one completed step (and, when verified, make it the
// last verified step) as one read-modify-write, so two hooks recording at once
// cannot drop each other's step.
export function recordTaskStep(id, step, { verified = false, at } = {}) {
  const db = getMock2Db();
  db.transaction(() => {
    const task = hydrateTask(rowById(db, id));
    if (!task || !sanitizeTaskText(step, { max: 300 })) return; // nothing to record
    const steps = appendStep(task.completedSteps, step, at || nowIso());
    applyPatch(db, id, { completedSteps: steps, ...(verified ? { lastVerifiedStep: step } : {}) });
  })();
  return hydrateTask(rowById(db, id));
}

// The task revision the committed files now mirror. Only ever moves forward,
// and is not itself a change to the task (no revision bump).
export function markFilesRevision(id, revision) {
  const rev = Math.trunc(Number(revision));
  if (!Number.isFinite(rev)) return false;
  return getMock2Db()
    .prepare(`UPDATE mock2_tasks SET files_revision = ? WHERE id = ? AND files_revision < ?`)
    .run(rev, Number(id), rev).changes > 0;
}

export function deleteTasksForProject(projectId) {
  return getMock2Db().prepare(`DELETE FROM mock2_tasks WHERE project_id = ?`).run(Number(projectId)).changes;
}
