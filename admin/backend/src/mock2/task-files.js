// Mock2 task continuity — the portable-file writer. Mirrors each task row
// (tasks.js, authoritative) into the project's repo as
// state/tasks/<key>/task.json + handoff.md (text from the pure task-logic.js),
// and adds the convention files (AGENTS.md, state/tasks/README.md) to an
// existing project only where they are absent — never overwriting them.
//
// Two ways in:
//   * writeTaskFilesInContainer — the runner, while its cycle holds the
//     checkout lock: write only; the cycle's own checkpoint commits the files.
//   * scheduleTaskFilesSync / syncTaskFilesNow — every other transition (an
//     ask, the boot sweep, a stop): debounced per project, and only when the
//     project is IDLE (online, no lock holder, no live cycle, no ask running),
//     fenced by a checkout operation lease across writing and committing, so
//     this never commits under a build or a person's session. The commit is PATH-SCOPED to exactly the written
//     paths (commitProjectPaths in routes/mcp.js) and pushed exactly as the
//     runner's checkpoint pushes (template.buildCheckpointScript: origin
//     HEAD:main into the bare repo).
//
// Container I/O, the DB and the idle checks are DEPENDENCIES, loaded lazily
// (runner.js is large and imports cycles.js; a static import here would close
// an import cycle through the runner hooks) and injectable, so the decisions
// below are unit-tested without Incus or better-sqlite3. Never throws.
//
// Terminology (risk R7): nothing here is named "agent".

import { randomUUID } from 'node:crypto';
import { conventionFilesIfAbsent, taskJsonPath, taskHandoffPath } from './continuity-convention.js';
import { isValidTaskKey, renderTaskJson, renderTaskHandoffMd } from './task-logic.js';
import { writeTaskRecordFile } from './task-record-write.js';

// runner.APP_DIR (and commitProjectPaths' cd) — not imported, see above.
const APP_DIR = '/srv/app';
const COMMIT_NAME = 'ProxyPilot Flightdeck';
const COMMIT_EMAIL = 'flightdeck@proxypilot';
const LIVE_CYCLE_STATUSES = Object.freeze(['queued', 'estimating', 'running']);
const ASK_DONE_PHASES = Object.freeze(['done', 'failed']);

export const TASK_FILES_PER_RUN = 5;
// Busy → try again after 5s, 15s, 1 min, 5 min, then give up: the next task
// transition schedules a fresh sync, so nothing is lost by stopping.
export const TASK_FILES_RETRY_MS = Object.freeze([5000, 15000, 60000, 300000]);
// skipped reasons worth retrying (the project may become idle / the container
// may answer); 'no_project' and 'nothing_to_write' are final.
const RETRY_SKIPS = new Set(['not_active', 'locked', 'cycle_running', 'ask_running', 'write_failed', 'commit_failed', 'error']);

const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');
const errText = (e) => String(e?.message || e || 'unknown error').slice(0, 300);

// ---- dependencies ----

let depsOverride = null;
let defaultDeps = null;

function loadDefaultDeps() {
  if (!defaultDeps) {
    defaultDeps = Promise.all([
      import('./runner.js'), import('./provision.js'), import('./projects.js'),
      import('./locks.js'), import('./cycles.js'), import('./ask.js'), import('./tasks.js'),
    ]).then(([runner, provision, projects, locks, cycles, ask, tasks]) => ({
      containerSh: runner.containerSh,
      // Retain the dependency seam name; production NEVER uses the generic
      // model-file writer for unattended metadata.
      writeFileInContainer: (ct, path, content, options) => writeTaskRecordFile(runner.containerSh, ct, path, content, options),
      acquireTaskContinuityLease: locks.acquireTaskContinuityLease,
      settleTaskContinuityLease: locks.settleTaskContinuityLease,
      markTaskContinuityLeaseUncertain: locks.markTaskContinuityLeaseUncertain,
      containerNameForProject: provision.containerNameForProject,
      getProject: projects.getProject,
      getLock: locks.getLock,
      latestCycle: cycles.latestCycle,
      getAskJobStatus: ask.getAskJobStatus,
      listTasks: tasks.listTasks,
      markFilesRevision: tasks.markFilesRevision,
    }));
    defaultDeps.catch(() => { defaultDeps = null; });
  }
  return defaultDeps;
}

// An explicit or test-installed deps object is used AS IS (complete), so a test
// never falls through to the native modules.
function resolveDeps(explicit) {
  if (explicit) return Promise.resolve(explicit);
  if (depsOverride) return Promise.resolve(depsOverride);
  return loadDefaultDeps();
}

// ---- pure decisions (exported for tests) ----

// Whether the task writer may touch the checkout now. A cycle-held lock, a
// person's lock and a running ask all mean someone else owns the working tree.
export function taskFilesIdleState({ project, lock, cycle, askJob } = {}) {
  if (!project || project.lifecycle !== 'active') return { idle: false, reason: 'not_active' };
  if (lock && (lock.holder_user_id != null || lock.holder_cycle_id != null || lock.holder_operation_id != null)) return { idle: false, reason: 'locked' };
  if (cycle && LIVE_CYCLE_STATUSES.includes(cycle.status)) return { idle: false, reason: 'cycle_running' };
  if (askJob && !ASK_DONE_PHASES.includes(askJob.phase)) return { idle: false, reason: 'ask_running' };
  return { idle: true, reason: null };
}

const updatedMs = (t) => {
  const ms = Date.parse(t?.updatedAt ?? '');
  return Number.isFinite(ms) ? ms : 0;
};

// Tasks whose files are behind their row, newest first, at most `max` per run.
export function selectTasksToWrite(tasks, { max = TASK_FILES_PER_RUN } = {}) {
  return (Array.isArray(tasks) ? tasks : [])
    .filter((t) => t && isValidTaskKey(t.key) && Number(t.filesRevision ?? 0) < Number(t.revision ?? 0))
    .sort((a, b) => (updatedMs(b) - updatedMs(a)) || (Number(b.id) - Number(a.id)))
    .slice(0, Math.max(0, max));
}

export function nextTaskFilesRetryMs(attempt) {
  const i = Math.trunc(Number(attempt));
  return Number.isInteger(i) && i >= 0 && i < TASK_FILES_RETRY_MS.length ? TASK_FILES_RETRY_MS[i] : null;
}

// A repo-relative path we are willing to write: no absolute path, no '..',
// no NUL/backslash. The convention module's paths always pass; this is the
// writer's own guard, not a trust in its input.
function safeRepoPath(p) {
  const s = String(p ?? '');
  if (!s || s.startsWith('/') || s.includes('\0') || s.includes('\\')) return false;
  return !s.split('/').some((seg) => seg === '' || seg === '.' || seg === '..');
}

// One shell line per path: decode in-shell (never interpolate the raw path)
// and answer PP_EXISTS i / PP_MISSING i. A symlink counts as existing.
export function buildPathsExistScript(paths) {
  const lines = [`cd '${APP_DIR}' 2>/dev/null || exit 3`];
  paths.forEach((p, i) => {
    lines.push(`p=$(printf '%s' '${b64(p)}' | base64 -d); if [ -e "$p" ] || [ -L "$p" ]; then echo "PP_EXISTS ${i}"; else echo "PP_MISSING ${i}"; fi`);
  });
  return `${lines.join('\n')}\n`;
}

// The paths reported missing, or null when the answer is incomplete — an
// uncertain answer writes nothing (a convention file is never overwritten).
export function parseMissingPaths(result, paths) {
  if (!result || result.code !== 0) return null;
  const seen = new Map();
  for (const m of String(result.stdout || '').matchAll(/^PP_(EXISTS|MISSING) (\d+)$/gm)) seen.set(Number(m[2]), m[1]);
  if (paths.some((_, i) => !seen.has(i))) return null;
  return paths.filter((_, i) => seen.get(i) === 'MISSING');
}

// The path-scoped commit (commitProjectPaths' shape): the message rides as $1
// and the paths as "$@" — set from base64 decoded in-shell, so neither is ever
// interpolated into the script text. Pushed like the runner's checkpoint.
export function buildTaskFilesCommitScript(paths, message, acknowledgement = 'PP_TASK_COMMIT_DONE') {
  if (!/^PP_TASK_COMMIT_[A-Za-z0-9_]+$/.test(acknowledgement)) throw new TypeError('Invalid commit acknowledgement');
  const args = [message, ...paths].map((s) => `"$(printf '%s' '${b64(s)}' | base64 -d)"`).join(' ');
  return [
    'set -e',
    `trap 'rc=$?; printf \"${acknowledgement} %s\\n\" \"$rc\" >&2' EXIT`,
    `cd '${APP_DIR}'`,
    `set -- ${args}`,
    'msg="$1"; shift',
    'git add -A -- "$@"',
    'if git diff --cached --quiet -- "$@"; then echo PP_NOCHANGE; '
      + `else git -c user.email=${COMMIT_EMAIL} -c user.name="${COMMIT_NAME}" commit -q -m "$msg" -- "$@"; fi`,
    'git push -q origin HEAD:main 2>/dev/null || echo PP_PUSH_FAILED >&2',
    'git rev-parse HEAD',
    '',
  ].join('\n');
}

export function parseCommitOutput(result, acknowledgement = 'PP_TASK_COMMIT_DONE') {
  const stdout = String(result?.stdout || '');
  const sha = (stdout.trim().split('\n').pop() || '').trim();
  const settled = new RegExp(`(?:^|\\n)${acknowledgement} ${Number(result?.code)}(?:\\n|$)`).test(String(result?.stderr || ''));
  const ok = result?.code === 0 && settled;
  const unchanged = /PP_NOCHANGE/.test(stdout);
  return {
    ok,
    settled,
    committed: ok && !unchanged,
    unchanged,
    commit: /^[0-9a-f]{40}$/.test(sha) ? sha : null,
    pushFailed: /PP_PUSH_FAILED/.test(String(result?.stderr || '')),
  };
}

export function taskFilesCommitMessage(tasks) {
  return `flightdeck: task records (${tasks.map((t) => t.key).join(', ')})`.slice(0, 200);
}

function taskFileEntries(task) {
  return [
    { path: taskJsonPath(task.key), content: renderTaskJson(task) },
    { path: taskHandoffPath(task.key), content: renderTaskHandoffMd(task) },
  ];
}

// ---- container I/O ----

async function missingConventionFiles(d, containerName, project) {
  const entries = conventionFilesIfAbsent(project).filter((f) => f && safeRepoPath(f.path) && typeof f.content === 'string');
  if (!entries.length) return [];
  const paths = entries.map((f) => f.path);
  const r = await d.containerSh(containerName, buildPathsExistScript(paths), { timeoutMs: 30000 });
  const missing = parseMissingPaths(r, paths);
  if (missing == null) {
    console.warn(`[mock2] task files: could not tell which convention files exist in ${containerName} — leaving them alone`);
    return [];
  }
  return entries.filter((f) => missing.includes(f.path)).map((f) => ({ ...f, createOnly: true }));
}

async function writeFiles(d, containerName, files) {
  const paths = [];
  for (const f of files) {
    if (!safeRepoPath(f.path)) return { ok: false, paths, error: `refused path ${JSON.stringify(String(f.path).slice(0, 80))}` };
    const w = await d.writeFileInContainer(containerName, f.path, f.content, { createOnly: f.createOnly === true });
    if (!w?.ok) return { ok: false, paths, error: `${f.path}: ${String(w?.error || 'write failed').slice(0, 200)}`, ...(w?.settled === false ? { uncertain: true } : {}) };
    if (w.written !== false) paths.push(f.path);
  }
  return { ok: true, paths, error: null };
}

// writeTaskFilesInContainer — write one task's files (+ missing convention
// files when ensureConvention). NO commit: the caller holds the lock and its
// checkpoint commits them. `deps` is the optional test seam.
export async function writeTaskFilesInContainer({ containerName, task, project, cycleId, ensureConvention = true, deps } = {}) {
  let d = null; let lease = null; let uncertain = false;
  try {
    if (!containerName) return { ok: false, paths: [], error: 'no container' };
    if (!task || !isValidTaskKey(task.key)) return { ok: false, paths: [], error: 'invalid task key' };
    if (!Number.isInteger(Number(cycleId)) || Number(cycleId) <= 0) return { ok: false, paths: [], error: 'cycle checkout ownership required' };
    d = await resolveDeps(deps);
    lease = d.acquireTaskContinuityLease(Number(task.projectId), { cycleId: Number(cycleId) });
    if (!lease?.ok || !lease.token) return { ok: false, paths: [], error: 'cycle checkout ownership unavailable' };
    const files = taskFileEntries(task);
    if (ensureConvention && project) files.push(...await missingConventionFiles(d, containerName, project));
    uncertain = true;
    const w = await writeFiles(d, containerName, files);
    uncertain = w.uncertain === true;
    if (!w.ok) console.warn(`[mock2] task files: write failed for task ${task.key}: ${w.error}`);
    return w;
  } catch (e) {
    console.warn(`[mock2] task files: write error: ${errText(e)}`);
    return { ok: false, paths: [], error: errText(e), ...(uncertain ? { uncertain: true } : {}) };
  } finally {
    if (lease?.ok && lease.token) {
      if (uncertain) d.markTaskContinuityLeaseUncertain(Number(task.projectId), lease.token);
      else d.settleTaskContinuityLease(Number(task.projectId), lease.token);
    }
  }
}

// ---- the idle sync ----

function idleNow(d, pid, project, ownToken = null) {
  const lock = d.getLock(pid);
  const owned = ownToken && lock?.holder_operation_id === ownToken
    && lock.holder_user_id == null && lock.holder_cycle_id == null;
  return taskFilesIdleState({
    project,
    lock: owned ? null : lock,
    cycle: d.latestCycle(pid),
    askJob: d.getAskJobStatus(pid),
  });
}

async function doSync(pid, depsArg) {
  const d = await resolveDeps(depsArg);
  const done = (ok, written, skipped) => ({ ok, written, skipped });
  const project = d.getProject(pid);
  if (!project) return done(false, [], 'no_project');
  const idle = idleNow(d, pid, project);
  if (!idle.idle) return done(false, [], idle.reason);

  const due = selectTasksToWrite(d.listTasks(pid, { limit: 50 }));
  if (!due.length) return done(true, [], 'nothing_to_write');

  // This reservation is a real checkout owner. Human/build/MCP/restore
  // admission must honor it until every remote mutation has acknowledged its
  // outcome. A timeout is NOT evidence that the remote process stopped.
  const lease = d.acquireTaskContinuityLease(pid);
  if (!lease?.ok || !lease.token) return done(false, [], 'locked');
  let uncertain = false;
  let paths = [];
  try {
    const admitted = idleNow(d, pid, d.getProject(pid) || project, lease.token);
    if (!admitted.idle) return done(false, [], admitted.reason);
    const containerName = project.container_name || d.containerNameForProject(pid);
    const files = due.flatMap(taskFileEntries);
    files.push(...await missingConventionFiles(d, containerName, project));
    uncertain = true;
    const w = await writeFiles(d, containerName, files);
    paths = w.paths;
    uncertain = w.uncertain === true;
    if (!w.ok) {
      console.warn(`[mock2] task files: project ${pid}: ${w.error}`);
      return done(false, paths, uncertain ? 'outcome_unknown' : 'write_failed');
    }
    const again = idleNow(d, pid, d.getProject(pid) || project, lease.token);
    if (!again.idle) return done(false, paths, again.reason);
    uncertain = true;
    const acknowledgement = `PP_TASK_COMMIT_${randomUUID().replaceAll('-', '')}`;
    const c = parseCommitOutput(await d.containerSh(containerName, buildTaskFilesCommitScript(paths, taskFilesCommitMessage(due), acknowledgement), { timeoutMs: 60000 }), acknowledgement);
    uncertain = !c.settled;
    if (!c.ok) {
      console.warn(`[mock2] task files: project ${pid}: commit failed`);
      return done(false, paths, uncertain ? 'outcome_unknown' : 'commit_failed');
    }
    if (c.pushFailed) console.warn(`[mock2] task files: project ${pid}: committed but the push to the bare repo failed (the next checkpoint push carries it)`);
    for (const t of due) d.markFilesRevision(t.id, t.revision);
    return done(true, paths, null);
  } finally {
    if (uncertain) d.markTaskContinuityLeaseUncertain(pid, lease.token);
    else d.settleTaskContinuityLease(pid, lease.token);
  }
}

// Runs are serialised per project: a sync started while another is writing
// waits for it, then sees fresh revisions.
const chains = new Map();

export function syncTaskFilesNow(projectId, { deps } = {}) {
  const pid = Number(projectId);
  if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve({ ok: false, written: [], skipped: 'no_project' });
  const prev = chains.get(pid) || Promise.resolve();
  const run = prev.then(() => doSync(pid, deps)).catch((e) => {
    console.warn(`[mock2] task files: project ${pid}: ${errText(e)}`);
    return { ok: false, written: [], skipped: 'error' };
  });
  chains.set(pid, run);
  run.then(() => { if (chains.get(pid) === run) chains.delete(pid); });
  return run;
}

// ---- debounce + backoff ----

const timers = new Map(); // pid → { timer, attempt }

function arm(pid, entry, ms) {
  entry.timer = setTimeout(() => { void runScheduled(pid, entry); }, ms);
  entry.timer?.unref?.();
}

async function runScheduled(pid, entry) {
  try {
    entry.timer = null;
    const r = await syncTaskFilesNow(pid);
    if (timers.get(pid) !== entry) return; // a newer transition rescheduled
    if (r.ok || !RETRY_SKIPS.has(r.skipped)) { timers.delete(pid); return; }
    const wait = nextTaskFilesRetryMs(entry.attempt);
    entry.attempt += 1;
    if (wait == null) {
      timers.delete(pid);
      console.warn(`[mock2] task files: project ${pid} stayed busy (${r.skipped}) — giving up until the next task change`);
      return;
    }
    arm(pid, entry, wait);
  } catch (e) {
    timers.delete(pid);
    console.warn(`[mock2] task files: scheduler error: ${errText(e)}`);
  }
}

// scheduleTaskFilesSync — debounced per project: a new transition replaces a
// pending run (and resets the backoff). Fire-and-forget; never throws.
export function scheduleTaskFilesSync(projectId, { delayMs = 3000 } = {}) {
  try {
    const pid = Number(projectId);
    if (!Number.isInteger(pid) || pid <= 0) return;
    const prev = timers.get(pid);
    if (prev?.timer) clearTimeout(prev.timer);
    const entry = { timer: null, attempt: 0 };
    timers.set(pid, entry);
    arm(pid, entry, Math.max(0, Number(delayMs) || 0));
  } catch (e) {
    console.warn(`[mock2] task files: schedule error: ${errText(e)}`);
  }
}

// ---- test seams ----

export function _setTaskFilesDepsForTests(deps) {
  depsOverride = deps || null;
}

export function _resetTaskFilesForTests() {
  for (const e of timers.values()) if (e.timer) clearTimeout(e.timer);
  timers.clear();
  chains.clear();
  depsOverride = null;
}

export function _pendingTaskFilesSyncsForTests() {
  return [...timers.entries()].map(([pid, e]) => ({ projectId: pid, attempt: e.attempt, armed: !!e.timer }));
}
