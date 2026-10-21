// Mock2 TASK CONTINUITY — the glue between tasks (task-logic.js decisions,
// tasks.js store, task-files.js writer) and the machinery that already runs
// the work: requests and cycles (builds), the ask lane (investigations), the
// runner's checkpoint / context handoff / resume, and the build chat.
//
// Why a separate module: a task outlives the chat and the in-memory jobs. A
// person closes the browser, the backend restarts, a stall watchdog stops a
// silent build — and the next "continue" must land on the SAME unfinished work,
// with the build tools only when a person authorized a build, and with the list
// of operations whose outcome nobody knows in front of the model before it acts.
// Every hook here is best-effort: task bookkeeping can never fail, block or
// noticeably delay a build, an ask or a cycle transition — each entry point
// catches everything and logs `[mock2] …`.
//
// Native-free at import time ON PURPOSE (stub-first, risk R9): the DB-touching
// modules are loaded lazily (loadDeps) and every entry point takes an optional
// `deps` object, so the routing and sync decisions are unit-tested without
// better-sqlite3, Incus or a model (src/__tests__/mock2-task-sync.test.js).
// The decisions themselves live in task-logic.js; the small pure helpers below
// only adapt cycle/job/queue rows into what those decisions read.
//
// Authority: the ProxyPilot database decides what ran and what was authorized.
// The portable files under state/tasks/ are a mirror and never authorize
// anything — nothing in this module reads them back.
//
// Terminology (risk R7): nothing here is named "agent".

import {
  sanitizeTaskText, buildTaskStatusFromCycle, classifyContinuationMessage,
  resolveTaskRoute, pickCurrentTask, uncertainFromEvents, parseHandoffSections,
  buildRecoverySection, buildInvestigationContinuation, routedNote, publicTaskShape,
  UNFINISHED_TASK_STATUSES, MAX_UNCERTAIN, isValidTaskKey,
} from './task-logic.js';
import { continuationRun, stripContinuationSection, haltReasonLabel } from './runner-logic.js';

const nowIso = () => new Date().toISOString();

// Cycle statuses during which a build segment is actually executing.
export const LIVE_CYCLE_STATUSES = Object.freeze(['queued', 'estimating', 'running']);
// How long an in-cycle task-file write may take before the build goes on without it.
const IN_CYCLE_WRITE_TIMEOUT_MS = 20000;
const GOAL_MAX = 500;
const MAX_REMAINING = 12;

// ---- lazy dependencies (the native half) ----

let depsPromise = null;
let depsOverride = null;

// Test seam: replace every DB/container/model dependency at once.
export function _setTaskSyncDepsForTests(deps) { depsOverride = deps || null; }

async function loadDeps() {
  if (depsOverride) return depsOverride;
  if (!depsPromise) {
    depsPromise = Promise.all([
      import('./tasks.js'), import('./task-files.js'), import('./cycles.js'), import('./cycle-events.js'),
      import('./requests.js'), import('./chats.js'), import('./build-queue.js'), import('../db.js'),
    ]).then(([tasks, files, cycles, events, requests, chats, queue, coreDb]) => ({
      createTask: tasks.createTask,
      getTask: tasks.getTask,
      getTaskByKey: tasks.getTaskByKey,
      getTaskForRequest: tasks.getTaskForRequest,
      listTasks: tasks.listTasks,
      listTasksByStatus: tasks.listTasksByStatus,
      updateTask: tasks.updateTask,
      recordTaskStep: tasks.recordTaskStep,
      writeTaskFilesInContainer: files.writeTaskFilesInContainer,
      scheduleTaskFilesSync: files.scheduleTaskFilesSync,
      getCycle: cycles.getCycle,
      latestCycle: cycles.latestCycle,
      requestCycleInterrupt: cycles.requestCycleInterrupt,
      listCycleEvents: events.listCycleEvents,
      getRequest: requests.getRequest,
      insertMessage: chats.insertMessage,
      listBuildQueue: queue.listBuildQueue,
      cancelQueuedBuild: queue.cancelQueuedBuild,
      logAudit: coreDb.logAudit,
      // The heavy modules (runner.js imports cycles.js, ask.js imports
      // runner.js) are reached only when a hook needs them — at runtime they
      // are already loaded by the router, so this costs nothing.
      retryCycle: async (args) => (await import('./runner.js')).retryCycle(args),
      containerSh: async (name, script, opts) => (await import('./runner.js')).containerSh(name, script, opts),
      startAsk: async (args) => (await import('./ask.js')).startAsk(args),
      getAskJobStatus: async (projectId) => (await import('./ask.js')).getAskJobStatus(projectId),
    }));
    depsPromise.catch(() => { depsPromise = null; });
  }
  return depsPromise;
}

function warn(what, e) {
  console.warn(`[mock2] task ${what} failed:`, e?.message || e);
}

function withTimeout(promise, ms, label) {
  let t = null;
  const timer = new Promise((resolve) => {
    t = setTimeout(() => resolve({ ok: false, error: `${label} timed out after ${ms}ms` }), ms);
    if (typeof t?.unref === 'function') t.unref();
  });
  return Promise.race([promise, timer]).finally(() => clearTimeout(t));
}

// ---- pure helpers (exported for the tests) ----

// The UI wraps some messages in a register preamble before they reach the
// server (Plan: "PLANNING REQUEST — no code changes. …", a design-scoped
// update: "DESIGN-SCOPED UPDATE — …", research: "RESEARCH & PLAN — …"). The
// task's goal and the continuation routing read the PERSON'S words only — a
// preamble must never become a goal, and "continue" sent from Plan is still
// "continue".
const PREAMBLE_RE = /^(?:PLANNING REQUEST|DESIGN-SCOPED UPDATE)\s+—[^\n]*\n\s*\n/;
const RESEARCH_PREAMBLE_RE = /^RESEARCH & PLAN — [\s\S]*?\nREQUEST TO RESEARCH AND PLAN:\n/;

export function personWords(text) {
  let s = String(text ?? '');
  s = s.replace(RESEARCH_PREAMBLE_RE, '');
  s = s.replace(PREAMBLE_RE, '');
  return s.trim();
}

// A build task's goal: the person's instruction, without the harness's own
// continuation section (a context handoff appends one) and without a UI
// preamble. Clipped and redacted (task-logic.sanitizeTaskText).
export function goalFromInstruction(instruction) {
  const words = personWords(stripContinuationSection(String(instruction ?? '')));
  return sanitizeTaskText(words, { max: GOAL_MAX });
}

export function checksFromGateReports(reports) {
  const out = [];
  for (const r of Array.isArray(reports) ? reports : []) {
    const key = String(r?.name ?? r?.key ?? '').trim().slice(0, 80);
    if (!key) continue;
    out.push({ key, status: String(r?.status ?? r?.result ?? 'pending').trim().slice(0, 40) || 'pending' });
  }
  return out.slice(0, 40);
}

export function checkpointStep(commitSha) {
  const sha = String(commitSha || '').trim();
  return /^[0-9a-f]{7,64}$/i.test(sha) ? `Checkpoint ${sha.slice(0, 7)} committed` : null;
}

function dedupeList(items, max) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const s = String(item ?? '').trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

function lastStepText(task) {
  const steps = Array.isArray(task?.completedSteps) ? task.completedSteps : [];
  return steps.length ? String(steps[steps.length - 1]?.step || '') : '';
}

function haltOptionsOf(cycle) {
  try {
    const opts = cycle?.halt_options_json ? JSON.parse(cycle.halt_options_json) : [];
    return Array.isArray(opts) ? opts : [];
  } catch { return []; }
}

// What a cycle row means for the task it belongs to: the patch to write and
// the steps to record. PURE — the store calls happen in onCycleChanged.
//   info          buildTaskStatusFromCycle(cycle) (task-logic)
//   uncertainNow  uncertainFromEvents over the cycle's events, computed by the
//                 caller only when the task is entering interrupted/failed
export function planCycleSync({ task, cycle, info, uncertainNow = null }) {
  const steps = [];
  if (!task || !cycle) return { patch: null, steps };
  const newCycle = Number(task.lastCycleId) !== Number(cycle.id);
  const ctx = task.context && typeof task.context === 'object' ? task.context : {};
  if (!info || !info.status) return { patch: newCycle ? { lastCycleId: cycle.id } : null, steps };

  let status = info.status;
  // A passed rules check (define segment) hands over to the build segment —
  // the task is not complete until the BUILD is.
  if (cycle.stage === 'define' && status === 'completed') status = 'active';
  // A person said stop: the build that stopped at its step boundary lands as
  // stopped (their newer instruction), not as an interruption to resume.
  if (ctx.stopRequestedAt && status === 'interrupted') status = 'stopped';
  // A task a person marked stopped stays stopped while its old cycle settles;
  // only a NEW segment (a resume) makes it active again.
  if (task.status === 'stopped' && !newCycle && !LIVE_CYCLE_STATUSES.includes(cycle.status)) status = 'stopped';

  const statusChanged = status !== task.status;
  if (!statusChanged && !newCycle) {
    // Same segment, same status — only a deploy reaching 'serving' is new.
    if (cycle.deploy_status === 'serving' && lastStepText(task) !== 'Deployed — the app is serving this version') {
      steps.push({ step: 'Deployed — the app is serving this version', verified: true });
    }
    return { patch: null, steps };
  }

  const patch = { lastCycleId: cycle.id };
  if (statusChanged) patch.status = status;
  const nextCtx = { ...ctx };
  let ctxChanged = false;

  if (status === 'active') {
    patch.blockers = [];
    // While a segment runs, the next step is the handoff's first remaining
    // item (a continuation works through it) or nothing.
    patch.nextStep = Array.isArray(task.remaining) && task.remaining.length ? task.remaining[0] : null;
    if (newCycle) {
      if (ctx.stopRequestedAt) { delete nextCtx.stopRequestedAt; ctxChanged = true; }
      const label = cycle.stage === 'define'
        ? 'Rules check started'
        : cycle.segment === 'resumed'
          ? `Resumed from the last checkpoint (cycle ${cycle.id})`
          : `Build started (cycle ${cycle.id})`;
      steps.push({ step: label, verified: false });
    }
  } else if (status === 'completed') {
    patch.blockers = [];
    patch.uncertain = [];
    patch.remaining = [];
    patch.nextStep = info.nextStep || null;
    if (cycle.status === 'succeeded') steps.push({ step: `Build succeeded (cycle ${cycle.id})`, verified: true });
    else if (cycle.verification_state === 'pending') steps.push({ step: `Build finished — waiting for the live check (cycle ${cycle.id})`, verified: false });
    else steps.push({ step: `Build finished (cycle ${cycle.id})`, verified: false });
  } else {
    let blockers = Array.isArray(info.blockers) ? info.blockers.map((b) => String(b || '').trim()).filter(Boolean) : [];
    let nextStep = info.nextStep || null;
    // A halt (haltCycle writes halt_reason + options before finishCycle): say
    // what blocked it in words and which way forward the build recommended.
    if (cycle.status === 'awaiting_admin' && cycle.halt_reason) {
      const label = haltReasonLabel(cycle.halt_reason);
      blockers = [sanitizeTaskText(`Blocked: ${label}${cycle.error ? ` — ${cycle.error}` : ''}`, { max: 600 })];
      const opts = haltOptionsOf(cycle);
      const rec = opts.find((o) => o && o.recommended && o.label) || opts.find((o) => o && o.label);
      nextStep = rec ? sanitizeTaskText(`Choose how to continue: ${rec.label}`, { max: 300 }) : 'Resolve the blocker, then resume';
    } else {
      blockers = blockers.map((b) => sanitizeTaskText(b, { max: 600 }));
    }
    // The context handoff already named the specific next step for this
    // segment — keep it over the generic "Resume from the last checkpoint".
    if (Number(ctx.handoffCycleId) === Number(cycle.id) && task.nextStep) nextStep = task.nextStep;
    patch.blockers = status === 'stopped' ? [] : blockers;
    patch.nextStep = status === 'stopped' ? null : nextStep;
    if (Array.isArray(uncertainNow) && (status === 'interrupted' || status === 'failed' || status === 'stopped')) {
      patch.uncertain = dedupeList([...uncertainNow, ...(Array.isArray(task.uncertain) ? task.uncertain : [])], MAX_UNCERTAIN);
    }
    if (ctx.stopRequestedAt && status === 'stopped') { delete nextCtx.stopRequestedAt; ctxChanged = true; }
    if (statusChanged || newCycle) {
      const word = status === 'blocked' ? 'blocked' : status === 'stopped' ? 'stopped' : status === 'failed' ? 'failed' : 'interrupted';
      steps.push({ step: `Cycle ${cycle.id} ${word}`, verified: false });
    }
  }
  if (ctxChanged) patch.context = nextCtx;
  return { patch, steps };
}

// The live/resumed/canResume annotations task-logic's routing and the public
// shape read. PURE over rows the caller fetched:
//   lastCycle           the task's last cycle (build tasks)
//   liveCycle           the project's latest cycle
//   askJob              the project's ask job (in-memory)
//   continuationQueued  a context-handoff continuation is waiting in the build queue
//   newestActiveInvestigationId  fallback for an ask job that carries no task id
export function annotateTask(task, { lastCycle = null, liveCycle = null, askJob = null, continuationQueued = false, newestActiveInvestigationId = null } = {}) {
  if (!task) return null;
  if (task.intent === 'investigation') {
    const jobLive = !!askJob && !['done', 'failed'].includes(askJob.phase);
    const live = jobLive && (askJob.taskId != null
      ? Number(askJob.taskId) === Number(task.id)
      : task.status === 'active' && Number(task.id) === Number(newestActiveInvestigationId));
    return {
      ...task,
      live,
      resumed: live && !!askJob?.continued,
      canResume: !live && task.status !== 'completed',
      cycleStatus: null,
    };
  }
  const cycleLive = !!liveCycle && LIVE_CYCLE_STATUSES.includes(liveCycle.status)
    && liveCycle.request_id != null && task.requestId != null
    && Number(liveCycle.request_id) === Number(task.requestId);
  const live = cycleLive || (!!task.context?.continuationPending && !!continuationQueued);
  const info = lastCycle ? buildTaskStatusFromCycle(lastCycle) : null;
  return {
    ...task,
    live,
    resumed: cycleLive && liveCycle.segment === 'resumed',
    canResume: !live && !!lastCycle && !!info?.canResume,
    cycleStatus: lastCycle?.status ?? (cycleLive ? liveCycle.status : null),
  };
}

function shape(task) {
  if (!task) return null;
  return publicTaskShape(task, { live: !!task.live, resumed: !!task.resumed, canResume: task.canResume ?? null });
}

// ---- reads ----

function continuationQueuedFor(projectId, d) {
  try {
    return (d.listBuildQueue(projectId) || [])
      .some((r) => ['queued', 'started'].includes(r.status) && continuationRun(r.instruction) > 0);
  } catch { return false; }
}

// Every task of the project with its annotations. `full` also loads each build
// task's last cycle (canResume) — the routing needs it; the chat poll does not.
async function annotatedTasks(projectId, d, { full = true, limit = 50 } = {}) {
  const tasks = d.listTasks(Number(projectId), { limit }) || [];
  if (!tasks.length) return [];
  const liveCycle = d.latestCycle(Number(projectId)) || null;
  let askJob = null;
  try { askJob = await d.getAskJobStatus(Number(projectId)); } catch { askJob = null; }
  const continuationQueued = tasks.some((t) => t.context?.continuationPending) ? continuationQueuedFor(projectId, d) : false;
  const newestActiveInvestigationId = tasks.find((t) => t.intent === 'investigation' && t.status === 'active')?.id ?? null;
  return tasks.map((t) => {
    let lastCycle = null;
    if (t.intent === 'build' && t.lastCycleId != null) {
      if (liveCycle && Number(liveCycle.id) === Number(t.lastCycleId)) lastCycle = liveCycle;
      else if (full) { try { lastCycle = d.getCycle(t.lastCycleId) || null; } catch { lastCycle = null; } }
    }
    return annotateTask(t, { lastCycle, liveCycle, askJob, continuationQueued, newestActiveInvestigationId });
  });
}

// One task with the full annotation (its last cycle read for canResume).
async function annotateOne(task, d) {
  if (!task) return null;
  const projectId = Number(task.projectId);
  const liveCycle = d.latestCycle(projectId) || null;
  let askJob = null;
  try { askJob = await d.getAskJobStatus(projectId); } catch { askJob = null; }
  let lastCycle = null;
  if (task.intent === 'build' && task.lastCycleId != null) {
    lastCycle = liveCycle && Number(liveCycle.id) === Number(task.lastCycleId)
      ? liveCycle
      : (d.getCycle(task.lastCycleId) || null);
  }
  const continuationQueued = task.context?.continuationPending ? continuationQueuedFor(projectId, d) : false;
  return annotateTask(task, { lastCycle, liveCycle, askJob, continuationQueued });
}

// The task the chat shows above the composer (TaskShape) or null.
export async function currentTaskForProject(projectId, deps = null) {
  try {
    const d = deps || await loadDeps();
    const tasks = await annotatedTasks(projectId, d, { full: false, limit: 20 });
    const current = pickCurrentTask(tasks);
    if (!current) return null;
    return shape(await annotateOne(current, d));
  } catch (e) { warn('current-task read', e); return null; }
}

export async function listTaskShapes(projectId, { scope = 'unfinished', limit = 20 } = {}, deps = null) {
  const d = deps || await loadDeps();
  const all = await annotatedTasks(projectId, d, { full: true, limit: Math.max(limit, 20) });
  const picked = scope === 'all' ? all : all.filter((t) => UNFINISHED_TASK_STATUSES.includes(t.status) || t.live);
  const current = pickCurrentTask(all);
  return { tasks: picked.slice(0, limit).map(shape), current: current ? shape(current) : null };
}

// One task by key (validated first — an invalid key is "not found").
export async function getAnnotatedTaskByKey(projectId, key, deps = null) {
  if (!isValidTaskKey(String(key ?? ''))) return null;
  const d = deps || await loadDeps();
  const task = d.getTaskByKey(Number(projectId), String(key));
  if (!task) return null;
  const all = await annotatedTasks(projectId, d, { full: true });
  return all.find((t) => Number(t.id) === Number(task.id)) || annotateTask(task, {});
}

export async function getTaskShapeByKey(projectId, key, deps = null) {
  return shape(await getAnnotatedTaskByKey(projectId, key, deps));
}

// ---- request / cycle hooks (requests.js / cycles.js, dynamic import) ----

function findContinuationTask(projectId, instruction, d) {
  const tasks = (d.listTasks(Number(projectId), { limit: 50 }) || []).filter((t) => t.intent === 'build');
  const pending = tasks.find((t) => t.context?.continuationPending);
  if (pending) return pending;
  if (continuationRun(instruction) > 0) {
    const goal = goalFromInstruction(instruction);
    return tasks.find((t) => t.goal === goal && t.status !== 'completed') || null;
  }
  return null;
}

// A build request was opened (audit.startBuild → requests.insertRequest — the
// ONLY place a request is created: the Build press, design approval's first
// build, queued and per-screen builds, MCP start_project_build, auto-adopt).
// One build task per request — EXCEPT the harness's own context-handoff
// continuation, which is the second half of work already authorized: it
// re-points the ORIGINAL task at the new request instead of opening a task.
// Recognised by the continuation marker the runner writes into the queued
// instruction (runner-logic.continuationRun), or a 'system' origin while a task
// is waiting for its continuation (the marker can be cut by the chat length cap).
export async function onRequestCreated(request, { origin = null, goal = null } = {}, deps = null) {
  try {
    if (!request || request.id == null) return null;
    const d = deps || await loadDeps();
    const existing = d.getTaskForRequest(request.id);
    if (existing) return existing;
    const projectId = Number(request.project_id);
    const marker = continuationRun(request.instruction) > 0;
    if (marker || origin === 'system') {
      const original = findContinuationTask(projectId, request.instruction, d);
      if (original && (marker || original.context?.continuationPending)) {
        const ctx = { ...(original.context || {}) };
        const prior = Array.isArray(ctx.priorRequestIds) ? ctx.priorRequestIds : [];
        if (original.requestId != null && !prior.includes(original.requestId)) prior.push(original.requestId);
        ctx.priorRequestIds = prior.slice(-20);
        delete ctx.continuationPending;
        d.updateTask(original.id, { requestId: request.id, status: 'active', blockers: [], context: ctx });
        d.recordTaskStep(original.id, `Continuation started (run ${continuationRun(request.instruction) || ctx.handoffRun || 1})`);
        return d.getTask(original.id);
      }
    }
    try {
      return d.createTask({
        projectId,
        intent: 'build',
        goal: (goal && goalFromInstruction(goal)) || goalFromInstruction(request.instruction) || 'Build request',
        requestId: request.id,
        authorizedBy: request.initiated_by ?? null,
        status: 'active',
      });
    } catch (e) {
      // Lost a create race on the request's unique index — the row exists.
      const again = d.getTaskForRequest(request.id);
      if (again) return again;
      throw e;
    }
  } catch (e) { warn('request hook', e); return null; }
}

// Every status transition of a cycle (insertCycle / updateCycle(status…) /
// finishCycle). Re-reads the cycle, so out-of-order hook calls converge on the
// row's latest state. Entering interrupted/failed records what the stopped
// segment left uncertain; leaving the live states schedules the portable-file
// sync (it waits until the project is idle and commits only its own paths).
export async function onCycleChanged(cycleOrId, deps = null) {
  try {
    const d = deps || await loadDeps();
    const id = cycleOrId && typeof cycleOrId === 'object' ? cycleOrId.id : cycleOrId;
    if (id == null) return null;
    const cycle = d.getCycle(id);
    if (!cycle || cycle.request_id == null || cycle.stage === 'concept') return null;
    const task = d.getTaskForRequest(cycle.request_id);
    if (!task) return null;
    const info = buildTaskStatusFromCycle(cycle);
    let uncertainNow = null;
    const entering = info && ['interrupted', 'failed'].includes(info.status)
      && (task.status !== info.status || Number(task.lastCycleId) !== Number(cycle.id));
    if (entering) {
      try { uncertainNow = uncertainFromEvents(d.listCycleEvents(cycle.id) || [], { cycle }); } catch { uncertainNow = null; }
    }
    const plan = planCycleSync({ task, cycle, info, uncertainNow });
    if (plan.patch) d.updateTask(task.id, plan.patch);
    for (const s of plan.steps) d.recordTaskStep(task.id, s.step, { verified: !!s.verified });
    if (!LIVE_CYCLE_STATUSES.includes(cycle.status)) d.scheduleTaskFilesSync(Number(cycle.project_id));
    return d.getTask(task.id);
  } catch (e) { warn('cycle hook', e); return null; }
}

async function taskForCycle(cycle, d, { fallback = false } = {}) {
  if (!cycle || cycle.request_id == null) return null;
  const exact = d.getTaskForRequest(cycle.request_id);
  if (exact || !fallback) return exact || null;
  // A continuation moved the task to a newer request; an older segment of it
  // still belongs to the same work.
  const tasks = d.listTasks(Number(cycle.project_id), { limit: 50 }) || [];
  return tasks.find((t) => Array.isArray(t.context?.priorRequestIds)
    && t.context.priorRequestIds.map(Number).includes(Number(cycle.request_id))) || null;
}

// ---- runner hooks ----

async function inCycleWrite({ cycle, project, containerName }, d) {
  let task = await taskForCycle(cycle, d);
  if (!task && cycle?.request_id != null) {
    // The request hook is fire-and-forget; make sure the task exists now.
    task = await onRequestCreated(d.getRequest(cycle.request_id), {}, d);
  }
  if (!task) return { ok: false, error: 'no task for this cycle' };
  await onCycleChanged(cycle.id, d);
  // Fill the branch when it is cheap to know (one git call in the container).
  try {
    const r = await d.containerSh(containerName, 'git -C /srv/app rev-parse --abbrev-ref HEAD 2>/dev/null', { timeoutMs: 10000 });
    const branch = String(r?.stdout || '').trim().split('\n').pop();
    if (r?.code === 0 && /^[A-Za-z0-9._/-]{1,100}$/.test(branch) && branch !== 'HEAD' && branch !== task.branch) {
      d.updateTask(task.id, { branch });
    }
  } catch { /* the branch stays null */ }
  const fresh = d.getTask(task.id);
  // ensureConvention: false — AGENTS.md / state/tasks/README.md missing from an
  // older project are NOT the build's work, and written here they would ride
  // its diff and change record. The idle sync after the cycle adds them in
  // their own path-scoped commit.
  return d.writeTaskFilesInContainer({ containerName, task: fresh, project, ensureConvention: false });
}

// Right after a cycle takes the lock, before the model's first turn: the
// task's portable files go into the working tree (no commit — the cycle's own
// checkpoint commits them), so a session that opens the repo mid-build sees
// the task, and the files ride every checkpoint.
export async function writeTaskFilesForCycle({ cycle, project, containerName }, deps = null) {
  try {
    const d = deps || await loadDeps();
    const r = await withTimeout(inCycleWrite({ cycle, project, containerName }, d), IN_CYCLE_WRITE_TIMEOUT_MS, 'task file write');
    if (r && r.ok === false && r.error !== 'no task for this cycle') console.warn(`[mock2] task files not written for cycle ${cycle?.id}: ${r.error}`);
    return r;
  } catch (e) { warn('in-cycle file write', e); return { ok: false, error: e?.message || String(e) }; }
}

// checkpointAndRecord, BEFORE its commit: the checks the gate battery reported
// so far land on the task, and the files are refreshed so this checkpoint
// commits them.
export async function beforeCheckpoint({ cycle, project, containerName, gateReports }, deps = null) {
  try {
    const d = deps || await loadDeps();
    const task = await taskForCycle(cycle, d);
    if (!task) return null;
    const checks = checksFromGateReports(gateReports);
    if (checks.length) d.updateTask(task.id, { checks });
    if (!containerName) return null;
    return await withTimeout(
      Promise.resolve(d.writeTaskFilesInContainer({ containerName, task: d.getTask(task.id), project, ensureConvention: false })),
      IN_CYCLE_WRITE_TIMEOUT_MS, 'task file refresh',
    );
  } catch (e) { warn('checkpoint refresh', e); return null; }
}

// checkpointAndRecord, AFTER its commit: the verified step.
export async function afterCheckpoint({ cycle, commitSha }, deps = null) {
  try {
    const step = checkpointStep(commitSha);
    if (!step) return null;
    const d = deps || await loadDeps();
    const task = await taskForCycle(cycle, d);
    if (!task || lastStepText(task) === step) return null;
    d.recordTaskStep(task.id, step, { verified: true });
    return d.getTask(task.id);
  } catch (e) { warn('checkpoint step', e); return null; }
}

// The runner wrote a context handoff and queued the continuation: what is
// left becomes the task's remaining list and next step, and the task waits
// for its continuation (onRequestCreated re-points it at the new request).
export async function onContextHandoff({ cycle, handoffText, run = null }, deps = null) {
  try {
    const d = deps || await loadDeps();
    const task = await taskForCycle(cycle, d);
    if (!task) return null;
    const sections = parseHandoffSections(String(handoffText || ''));
    const remaining = dedupeList((sections.next || []).map((s) => sanitizeTaskText(s, { max: 300 })), MAX_REMAINING);
    const gotchas = dedupeList((sections.gotchas || []).map((s) => sanitizeTaskText(s, { max: 300 })), 6);
    d.updateTask(task.id, {
      remaining,
      nextStep: remaining[0] || 'Continue from the context handoff',
      context: {
        ...(task.context || {}),
        continuationPending: true,
        handoffCycleId: cycle.id,
        handoffRun: run,
        ...(gotchas.length ? { gotchas } : {}),
      },
    });
    d.recordTaskStep(task.id, `Context handoff written — continuation${run ? ` ${run}` : ''} queued`);
    return d.getTask(task.id);
  } catch (e) { warn('context handoff hook', e); return null; }
}

// retryCycle (every resume path: the Retry button, Restart build, the stall
// recovery, a "continue" in the chat, the task Resume button): the recovery
// section the resumed model reads before its tools run — the task checkpoint
// and the operations it must verify before repeating. '' when there is no task.
export async function recoveryForCycle(cycle, deps = null) {
  try {
    if (!cycle) return '';
    const d = deps || await loadDeps();
    // Converge the task on the cycle first: the stall/restart paths finish the
    // cycle a moment before they resume it, and the hook may not have run yet.
    await onCycleChanged(cycle.id, d);
    const task = await taskForCycle(cycle, d, { fallback: true });
    if (!task || task.intent !== 'build') return '';
    return String(buildRecoverySection(task) || '').trim();
  } catch (e) { warn('recovery section', e); return ''; }
}

// ---- ask-lane hooks (ask.js) ----

// A normal ask (plain, Plan, Research) opens an investigation task whose goal
// is the person's own question; a continued investigation reuses its task.
export async function onAskStarted({ project, question, said = null, research = false, task = null, user = null }, deps = null) {
  try {
    const d = deps || await loadDeps();
    if (task && task.id != null) {
      d.updateTask(task.id, { status: 'active', blockers: [], nextStep: null });
      d.recordTaskStep(task.id, 'Investigation continued');
      return d.getTask(task.id);
    }
    const raw = String(question ?? '');
    const mode = research ? 'research' : /^PLANNING REQUEST\s+—/.test(raw) ? 'plan' : 'ask';
    const created = d.createTask({
      projectId: Number(project.id),
      intent: 'investigation',
      goal: sanitizeTaskText(String(said ?? '').trim() || personWords(raw), { max: GOAL_MAX }) || 'Question',
      authorizedBy: user?.id ?? null,
      status: 'active',
      context: { mode },
    });
    if (created) d.recordTaskStep(created.id, 'Investigation started');
    return created ? d.getTask(created.id) || created : null;
  } catch (e) { warn('ask start hook', e); return null; }
}

// The ask finished: completed with the answer excerpt, or failed / ran out of
// steps (unfinished — "continue" picks it up read-only). A person's "stop"
// while it ran stays the newer instruction.
export async function onAskFinished({ taskId, outcome = 'completed', answer = '', error = '' }, deps = null) {
  try {
    if (taskId == null) return null;
    const d = deps || await loadDeps();
    const task = d.getTask(taskId);
    if (!task) return null;
    const excerpt = answer ? sanitizeTaskText(answer, { max: 1500 }) : (task.context?.answerExcerpt || null);
    const context = { ...(task.context || {}), ...(excerpt ? { answerExcerpt: excerpt } : {}) };
    const stopped = task.status === 'stopped';
    const status = stopped ? 'stopped' : outcome === 'completed' ? 'completed' : outcome === 'failed' ? 'failed' : 'interrupted';
    d.updateTask(task.id, {
      status,
      context,
      blockers: status === 'failed' && error ? [sanitizeTaskText(error, { max: 300 })] : [],
      nextStep: status === 'completed' || status === 'stopped' ? null : 'Continue the investigation from what was found so far',
    });
    d.recordTaskStep(task.id, outcome === 'completed' ? 'Answer posted' : outcome === 'failed' ? 'Investigation failed' : 'Ran out of steps before finishing');
    d.scheduleTaskFilesSync(Number(task.projectId));
    return d.getTask(task.id);
  } catch (e) { warn('ask finish hook', e); return null; }
}

// ---- boot sweep (index.js, right after sweepMock2OnBoot) ----

// sweepMock2OnBoot failed every running/estimating cycle ('orphaned by
// restart') with raw SQL — no cycle hook ran. Each active build task whose
// cycle is no longer live becomes what its cycle now says (interrupted for an
// orphaned one) with what that segment left uncertain; each active
// investigation (ask jobs are in-memory) becomes interrupted.
export async function sweepTasksOnBoot(deps = null) {
  const summary = { interrupted: 0, updated: 0 };
  try {
    const d = deps || await loadDeps();
    const active = d.listTasksByStatus(['active']) || [];
    const projects = new Set();
    for (const task of active) {
      try {
        if (task.intent === 'investigation') {
          d.updateTask(task.id, { status: 'interrupted', nextStep: 'Continue the investigation from what was found so far' });
          d.recordTaskStep(task.id, 'Stopped by a restart');
          summary.interrupted += 1;
          projects.add(Number(task.projectId));
          continue;
        }
        const cycle = task.lastCycleId != null ? d.getCycle(task.lastCycleId) : null;
        if (cycle && LIVE_CYCLE_STATUSES.includes(cycle.status)) continue;
        if (!cycle) {
          d.updateTask(task.id, { status: 'interrupted', nextStep: 'Start the build again — it stopped before its first segment' });
          summary.interrupted += 1;
          projects.add(Number(task.projectId));
          continue;
        }
        const info = buildTaskStatusFromCycle(cycle);
        let uncertain = null;
        try { uncertain = uncertainFromEvents(d.listCycleEvents(cycle.id) || [], { cycle }); } catch { uncertain = null; }
        const plan = planCycleSync({ task: { ...task, lastCycleId: null }, cycle, info, uncertainNow: uncertain });
        const patch = { ...(plan.patch || {}) };
        // Still "active" with nothing live behind it (a passed rules check
        // whose build never started): the work is interrupted, not running.
        if (!patch.status || patch.status === 'active') patch.status = 'interrupted';
        if (patch.status === 'interrupted' && !patch.nextStep) patch.nextStep = 'Resume from the last checkpoint';
        d.updateTask(task.id, patch);
        for (const s of plan.steps.filter((x) => !/ started/.test(x.step))) d.recordTaskStep(task.id, s.step, { verified: !!s.verified });
        if (patch.status === 'interrupted') summary.interrupted += 1; else summary.updated += 1;
        projects.add(Number(task.projectId));
      } catch (e) { warn(`boot sweep (task ${task?.id})`, e); }
    }
    for (const pid of projects) { try { d.scheduleTaskFilesSync(pid, { delayMs: 30000 }); } catch { /* best effort */ } }
    if (summary.interrupted || summary.updated) {
      console.log(`[mock2] task boot sweep: ${summary.interrupted} interrupted, ${summary.updated} updated`);
    }
  } catch (e) { warn('boot sweep', e); }
  return summary;
}

// ---- actions (the chat routing and the task routes share these) ----

// Resume a BUILD task: the existing retry machinery on its last cycle, with
// the person's guidance as the resume message (retryCycle adds the recovery
// section itself). Only a build task a person authorized reaches here — an
// investigation never gets build tools.
async function resumeBuild({ project, task, guidance, user, actingAsAdmin }, d) {
  if (!task || task.intent !== 'build') return { ok: false, status: 409, error: 'Only a build can be resumed as a build.' };
  if (task.live) return { ok: false, status: 409, error: 'This build is already running.' };
  if (!task.canResume) return { ok: false, status: 409, error: 'This build cannot be resumed from here — answer its open questions or start it again.' };
  const cycle = task.lastCycleId != null ? d.getCycle(task.lastCycleId) : null;
  if (!cycle || Number(cycle.project_id) !== Number(project.id)) return { ok: false, status: 409, error: 'This build has no segment to resume.' };
  const res = await d.retryCycle({
    project, cycle, initiatedBy: user?.id ?? null, actingAsAdmin: actingAsAdmin ? 1 : 0,
    message: String(guidance || '').slice(0, 4000),
  });
  if (!res || res.status === 'error') return { ok: false, status: 409, error: res?.error || 'The build could not be resumed.' };
  return { ok: true, refused: res.status === 'refused', reason: res.error || null, cycle: res.cycle || null };
}

// Continue an INVESTIGATION read-only in the ask lane (or start one for an
// "only explain" sent to the build lane). The ask echoes the person's words.
async function runInvestigation({ project, task = null, question, echo, said = null, user, actingAsAdmin, images }, d) {
  const res = await d.startAsk({
    project, question, user, actingAsAdmin: actingAsAdmin ? 1 : 0, images: images || [],
    research: task?.context?.mode === 'research',
    task, routed: true, echoBody: echo, said,
  });
  if (!res || res.status === 'error') return { ok: false, status: 409, error: res?.error || 'The question could not start.' };
  return { ok: true, taskId: res.taskId ?? task?.id ?? null };
}

// Stop a live BUILD: the same effect as the interrupt route (stop_after_step
// through cycles.requestCycleInterrupt — one rule for both), and the person's
// stop is remembered so the stopped segment lands as "stopped". A continuation
// still waiting in the queue is cancelled instead.
async function stopBuild({ project, task, user, ip }, d) {
  const live = d.latestCycle(Number(project.id));
  const cycleLive = live && LIVE_CYCLE_STATUSES.includes(live.status) && Number(live.request_id) === Number(task.requestId);
  if (!cycleLive) {
    if (task.context?.continuationPending) {
      const row = (d.listBuildQueue(Number(project.id)) || []).find((r) => r.status === 'queued' && continuationRun(r.instruction) > 0);
      if (row) {
        const c = d.cancelQueuedBuild(Number(project.id), row.id);
        if (c?.ok) {
          const ctx = { ...(task.context || {}) };
          delete ctx.continuationPending;
          d.updateTask(task.id, { status: 'stopped', nextStep: null, context: ctx });
          d.recordTaskStep(task.id, 'Queued continuation cancelled by a person');
          d.scheduleTaskFilesSync(Number(project.id));
          return { ok: true };
        }
      }
      return { ok: false, status: 409, error: 'The continuation is starting right now — stop it again in a moment.' };
    }
    return { ok: false, status: 409, error: 'This build is not running.' };
  }
  if (live.stage !== 'build') {
    return { ok: false, status: 409, error: 'The build is still being prepared (rules check) — stop it once it has started.' };
  }
  if (live.status !== 'running') {
    return { ok: false, status: 409, error: 'The build is still starting — stop it again in a moment.' };
  }
  const r = d.requestCycleInterrupt(live, 'stop_after_step');
  if (!r?.ok) return { ok: false, status: r?.status || 409, error: r?.error || 'The build could not be stopped.' };
  d.logAudit(user?.id ?? null, 'MOCK2_CYCLE_INTERRUPT', 'mock2_cycle', live.id, { action: 'stop_after_step', via: 'task' }, ip);
  d.updateTask(task.id, { context: { ...(task.context || {}), stopRequestedAt: nowIso() } });
  d.recordTaskStep(task.id, 'Stop requested — the build stops after its current step');
  return { ok: true, cycle: r.cycle };
}

function stopIdle(task, d) {
  d.updateTask(task.id, { status: 'stopped', nextStep: null });
  d.recordTaskStep(task.id, 'Stopped by a person');
  d.scheduleTaskFilesSync(Number(task.projectId));
}

// ---- the chat routing (POST /ask and POST /cycles) ----

// Before the model receives any tools: does this message continue, stop or
// narrow an unfinished task? Returns { handled: false } (today's behaviour
// runs untouched) or { handled: true, status, body } — body is
// { routed: { action, task, note } } or { error }. The person's message is
// echoed exactly once (kind 'user') and the routing note posted as a system
// message. Any failure BEFORE an action starts passes the message through;
// after an action starts it is answered, never passed (that would start the
// work twice).
export async function routeChatMessage({ project, message, said = null, lane, user, actingAsAdmin = 0, images = [], ip = null }, deps = null) {
  const PASS = { handled: false };
  let d;
  let route;
  let tasks;
  let words;
  try {
    // The person's own words: `said` when the UI sent them alongside a
    // preamble-wrapped message, else the message with any known preamble cut.
    words = String(said ?? '').trim() || personWords(message);
    if (!words) return PASS;
    // Cheap first: an ordinary request never touches the task store.
    if (classifyContinuationMessage(words)?.kind === 'other') return PASS;
    d = deps || await loadDeps();
    tasks = await annotatedTasks(project.id, d, { full: true });
    route = resolveTaskRoute({ message: words, lane: lane === 'ask' ? 'ask' : 'build', tasks, nowMs: Date.now() });
    if (!route || !route.action || route.action === 'pass') return PASS;
    // A screenshot cannot ride a resume (the resume turn carries text only):
    // a "try again" with images stays a new build, as before.
    if (route.action === 'resume_build' && Array.isArray(images) && images.length) return PASS;
  } catch (e) { warn('routing', e); return PASS; }

  const action = route.action;
  const task = route.taskKey ? tasks.find((t) => t.key === route.taskKey) || null : null;
  const guidance = String(route.guidance || '').trim();
  const projectId = Number(project.id);
  const acting = actingAsAdmin ? 1 : 0;

  const answer = async (status, { echo = true, taskId = task?.id ?? null, note = null } = {}) => {
    let fresh = null;
    try { fresh = taskId != null ? await annotateOne(d.getTask(taskId), d) : null; } catch { fresh = null; }
    const text = note || routedNote(action, fresh || task);
    if (echo) {
      try { d.insertMessage({ projectId, authorUserId: user?.id ?? null, actingAsAdmin: acting, kind: 'user', body: words }); } catch (e) { warn('chat echo', e); }
    }
    try { d.insertMessage({ projectId, kind: 'system', body: text }); } catch (e) { warn('routing note', e); }
    try {
      d.logAudit(user?.id ?? null, 'MOCK2_TASK_ROUTED', 'mock2_project', projectId,
        { action, task_key: (fresh || task)?.key || null, lane, reason: route.reason || null }, ip);
    } catch { /* audit is best-effort here */ }
    return { handled: true, status, body: { routed: { action, task: shape(fresh || task), note: text } } };
  };
  const refuse = (r) => ({ handled: true, status: r.status || 409, body: { error: r.error } });

  try {
    switch (action) {
      case 'attach':
      case 'answer_required':
        return await answer(200);
      case 'nothing_to_stop':
        return await answer(200);
      case 'stop_task': {
        if (!task) return PASS;
        stopIdle(task, d);
        return await answer(200);
      }
      case 'stop_build': {
        if (!task) return PASS;
        const r = await stopBuild({ project, task, user, ip }, d);
        if (!r.ok) return refuse(r);
        return await answer(200);
      }
      case 'resume_build': {
        if (!task) return PASS;
        const r = await resumeBuild({ project, task, guidance, user, actingAsAdmin: acting }, d);
        if (!r.ok) return refuse(r);
        if (r.refused) return await answer(200, { note: `Not resumed: ${r.reason || 'the build was refused'}` });
        return await answer(202);
      }
      case 'continue_investigation': {
        if (!task) return PASS;
        const question = buildInvestigationContinuation({ task, guidance });
        const r = await runInvestigation({ project, task, question, echo: words, user, actingAsAdmin: acting, images }, d);
        if (!r.ok) return refuse(r);
        return await answer(202, { echo: false, taskId: r.taskId });
      }
      case 'investigate': {
        const r = await runInvestigation({ project, question: words, echo: words, said: words, user, actingAsAdmin: acting, images }, d);
        if (!r.ok) return refuse(r);
        return await answer(202, { echo: false, taskId: r.taskId });
      }
      default:
        return PASS;
    }
  } catch (e) {
    warn(`routed ${action}`, e);
    return { handled: true, status: 500, body: { error: `Could not ${action.replace(/_/g, ' ')}: ${e?.message || 'unknown error'}` } };
  }
}

// ---- the task routes (task-routes.js) ----

// POST /tasks/:key/resume — a build resumes through retryCycle, an
// investigation continues read-only in the ask lane.
export async function resumeTaskByKey({ project, key, message = '', user, actingAsAdmin = 0, ip = null }, deps = null) {
  const d = deps || await loadDeps();
  const task = await getAnnotatedTaskByKey(project.id, key, d);
  if (!task) return { status: 404, body: { error: 'Task not found' } };
  const guidance = String(message || '').trim();
  const acting = actingAsAdmin ? 1 : 0;
  let action;
  let taskId = task.id;
  let note = null;
  if (task.intent === 'build') {
    action = 'resume_build';
    const r = await resumeBuild({ project, task, guidance, user, actingAsAdmin: acting }, d);
    if (!r.ok) return { status: r.status || 409, body: { error: r.error } };
    if (r.refused) note = `Not resumed: ${r.reason || 'the build was refused'}`;
  } else {
    action = 'continue_investigation';
    if (task.live) return { status: 409, body: { error: 'This investigation is still running.' } };
    if (task.status === 'completed' && !guidance) return { status: 409, body: { error: 'This investigation is complete — ask a follow-up question instead.' } };
    const question = buildInvestigationContinuation({ task, guidance });
    const r = await runInvestigation({ project, task, question, echo: guidance, user, actingAsAdmin: acting, images: [] }, d);
    if (!r.ok) return { status: r.status || 409, body: { error: r.error } };
    taskId = r.taskId ?? task.id;
  }
  const fresh = await annotateOne(d.getTask(taskId), d);
  const text = note || routedNote(action, fresh || task);
  if (task.intent === 'build' && guidance) {
    try { d.insertMessage({ projectId: Number(project.id), authorUserId: user?.id ?? null, actingAsAdmin: acting, kind: 'user', body: guidance }); } catch (e) { warn('chat echo', e); }
  }
  try { d.insertMessage({ projectId: Number(project.id), kind: 'system', body: text }); } catch (e) { warn('resume note', e); }
  try { d.logAudit(user?.id ?? null, 'MOCK2_TASK_RESUME', 'mock2_project', Number(project.id), { task_key: task.key, intent: task.intent, has_message: !!guidance, refused: !!note }, ip); } catch { /* best effort */ }
  return { status: note ? 200 : 202, body: { routed: { action, task: shape(fresh || task), note: text } } };
}

// POST /tasks/:key/stop — a live build stops after its current step (the
// interrupt route's effect); anything else not finished is marked stopped.
export async function stopTaskByKey({ project, key, user, ip = null }, deps = null) {
  const d = deps || await loadDeps();
  const task = await getAnnotatedTaskByKey(project.id, key, d);
  if (!task) return { status: 404, body: { error: 'Task not found' } };
  let action;
  if (task.intent === 'build' && task.live) {
    action = 'stop_build';
    const r = await stopBuild({ project, task, user, ip }, d);
    if (!r.ok) return { status: r.status || 409, body: { error: r.error } };
  } else if (UNFINISHED_TASK_STATUSES.includes(task.status) || task.live) {
    action = 'stop_task';
    stopIdle(task, d);
  } else {
    return { status: 409, body: { error: `This task is already ${task.status}.` } };
  }
  const fresh = await annotateOne(d.getTask(task.id), d);
  const text = routedNote(action, fresh || task);
  try { d.insertMessage({ projectId: Number(project.id), kind: 'system', body: text }); } catch (e) { warn('stop note', e); }
  try { d.logAudit(user?.id ?? null, 'MOCK2_TASK_STOP', 'mock2_project', Number(project.id), { task_key: task.key, intent: task.intent, action }, ip); } catch { /* best effort */ }
  return { status: 200, body: { routed: { action, task: shape(fresh || task), note: text } } };
}
