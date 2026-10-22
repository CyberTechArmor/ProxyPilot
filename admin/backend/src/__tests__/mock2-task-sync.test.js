// Mock2 task continuity — the integration glue (task-sync.js): how requests,
// cycles, the ask lane, the runner's checkpoint/handoff/resume and the build
// chat keep a task in step, and how "continue" / "stop" / "only explain" are
// routed BEFORE the model receives any tools. Stub-first (risk R9): task-sync
// takes every DB/container/model dependency as an injected `deps` object, so
// this file drives the REAL pure decisions (task-logic.js) through an
// in-memory world and asserts each action's effect: which machinery is called,
// what is echoed into the chat, what is returned. The last block holds source
// ratchets for the wiring in the native modules (the repo's pattern for code
// that cannot be imported without better-sqlite3).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  personWords, goalFromInstruction, checksFromGateReports, checkpointStep,
  planCycleSync, annotateTask, onRequestCreated, onCycleChanged, routeChatMessage,
  recoveryForCycle, sweepTasksOnBoot, onAskStarted, onAskFinished, currentTaskForProject,
  listTaskShapes, getTaskShapeByKey, resumeTaskByKey, stopTaskByKey, onContextHandoff,
  beforeCheckpoint, afterCheckpoint, writeTaskFilesForCycle, LIVE_CYCLE_STATUSES,
} from '../mock2/task-sync.js';
import {
  makeTaskKey, sanitizeTaskText, appendStep, buildTaskStatusFromCycle, buildInvestigationContinuation,
  FINISHED_TASK_STATUSES,
} from '../mock2/task-logic.js';
import { buildContinuationInstruction } from '../mock2/runner-logic.js';
import { buildResumeContextBlock } from '../mock2/unblock-logic.js';

const PLAN_PREAMBLE = 'PLANNING REQUEST — no code changes. Read the app’s CURRENT code and design first, then lay out a scoped plan for the request below.';
const DESIGN_PREAMBLE = 'DESIGN-SCOPED UPDATE — start from the app’s CURRENT design. Change only the screens the request below names.';

// ---- the in-memory world (same semantics as tasks.js / cycles.js) ----

const PATCHABLE = ['status', 'lastCycleId', 'lastVerifiedStep', 'nextStep', 'completedSteps', 'checks', 'blockers', 'remaining', 'uncertain', 'context', 'branch', 'requestId'];
const clone = (v) => (v == null ? null : JSON.parse(JSON.stringify(v)));

function world({ cycles = [], events = {}, queue = [], askJob = null, requests = [], retryResult = null, askResult = null } = {}) {
  const store = new Map();
  let nextTaskId = 1;
  let clock = Date.now() - 600_000;
  const stamp = () => new Date((clock += 1000)).toISOString();
  const cyclesById = new Map(cycles.map((c) => [c.id, { project_id: 1, stage: 'build', segment: 'build', ...c }]));
  const calls = { retryCycle: [], startAsk: [], interrupts: [], messages: [], audits: [], syncs: [], cancels: [], written: [], updates: [] };
  const state = { askJob, queue: [...queue] };

  const d = {
    createTask({ projectId, intent, goal, requestId = null, authorizedBy = null, status = 'active', context = null }) {
      if (requestId != null) {
        const hit = [...store.values()].find((t) => t.requestId === requestId);
        if (hit) return clone(hit);
      }
      const id = nextTaskId++;
      const at = stamp();
      const cleanGoal = sanitizeTaskText(String(goal ?? '').replace(/\s+/g, ' '), { max: 500 }) || 'Untitled task';
      const t = {
        id, key: makeTaskKey(id, cleanGoal), projectId: Number(projectId), intent, status, goal: cleanGoal,
        requestId, lastCycleId: null, authorizedBy, authorizedAt: at, folder: '/srv/app', branch: null,
        lastVerifiedStep: null, nextStep: null, completedSteps: [], checks: [], blockers: [], remaining: [],
        uncertain: [], context, revision: 1, filesRevision: 0, createdAt: at, updatedAt: at,
        finishedAt: FINISHED_TASK_STATUSES.includes(status) ? at : null,
      };
      store.set(id, t);
      return clone(t);
    },
    getTask: (id) => clone(store.get(Number(id)) ?? null),
    getTaskByKey: (pid, key) => clone([...store.values()].find((t) => t.projectId === Number(pid) && t.key === key) ?? null),
    getTaskForRequest: (rid) => (rid == null ? null : clone([...store.values()].find((t) => t.requestId === Number(rid)) ?? null)),
    listTasks: (pid, { limit = 50 } = {}) => [...store.values()]
      .filter((t) => t.projectId === Number(pid))
      .sort((a, b) => (Date.parse(b.updatedAt) - Date.parse(a.updatedAt)) || (b.id - a.id))
      .slice(0, limit).map(clone),
    listTasksByStatus: (statuses) => [...store.values()].filter((t) => statuses.includes(t.status)).map(clone),
    updateTask(id, patch) {
      const t = store.get(Number(id));
      if (!t) return null;
      calls.updates.push({ id: Number(id), patch: clone(patch) });
      for (const k of PATCHABLE) if (k in patch && patch[k] !== undefined) t[k] = clone(patch[k]);
      if ('status' in patch) t.finishedAt = FINISHED_TASK_STATUSES.includes(patch.status) ? stamp() : null;
      t.revision += 1;
      t.updatedAt = stamp();
      return clone(t);
    },
    recordTaskStep(id, step, { verified = false } = {}) {
      const t = store.get(Number(id));
      if (!t) return null;
      t.completedSteps = appendStep(t.completedSteps, step, stamp());
      if (verified) t.lastVerifiedStep = step;
      t.revision += 1;
      t.updatedAt = stamp();
      return clone(t);
    },
    writeTaskFilesInContainer: async (args) => { calls.written.push(args); return { ok: true, paths: [`state/tasks/${args.task.key}/task.json`], error: null }; },
    scheduleTaskFilesSync: (pid) => { calls.syncs.push(Number(pid)); },
    getCycle: (id) => clone(cyclesById.get(Number(id)) ?? null),
    latestCycle: (pid) => clone([...cyclesById.values()].filter((c) => c.project_id === Number(pid)).sort((a, b) => b.id - a.id)[0] ?? null),
    requestCycleInterrupt(cycle, action) {
      calls.interrupts.push({ id: cycle?.id, action });
      if (!cycle) return { ok: false, status: 404, error: 'Cycle not found' };
      if (cycle.status !== 'running') return { ok: false, status: 409, error: `Cycle is "${cycle.status}", not running` };
      cyclesById.get(cycle.id).interrupt_request = action;
      return { ok: true, cycle: clone(cyclesById.get(cycle.id)) };
    },
    listCycleEvents: (id) => events[id] || [],
    getRequest: (id) => clone(requests.find((r) => r.id === Number(id)) ?? null),
    insertMessage: (m) => { calls.messages.push(m); return { id: calls.messages.length, ...m }; },
    listBuildQueue: () => clone(state.queue),
    cancelQueuedBuild: (pid, id) => {
      calls.cancels.push(id);
      const row = state.queue.find((r) => r.id === id);
      if (!row || row.status !== 'queued') return { ok: false, error: 'not queued' };
      row.status = 'cancelled';
      return { ok: true };
    },
    logAudit: (...args) => { calls.audits.push(args); },
    retryCycle: async (args) => {
      calls.retryCycle.push(args);
      if (retryResult) return retryResult;
      const nid = Math.max(0, ...cyclesById.keys()) + 1;
      const c = { id: nid, project_id: Number(args.project.id), stage: 'build', segment: 'resumed', status: 'estimating', request_id: args.cycle.request_id };
      cyclesById.set(nid, c);
      return { status: 'started', cycle: clone(c) };
    },
    containerSh: async () => ({ code: 0, stdout: 'main\n', stderr: '' }),
    startAsk: async (args) => {
      calls.startAsk.push(args);
      if (askResult) return askResult;
      const t = args.task ? d.getTask(args.task.id) : d.createTask({ projectId: args.project.id, intent: 'investigation', goal: args.said || args.question });
      state.askJob = { phase: 'running', taskId: t.id, continued: !!args.task };
      return { status: 'started', taskId: t.id };
    },
    getAskJobStatus: async () => clone(state.askJob),
  };
  return { d, calls, store, state, cyclesById };
}

const PROJECT = { id: 1, name: 'Invoices', lifecycle: 'active' };
const USER = { id: 7, role: 'editor' };

// A build task whose request has one cycle in `cycleStatus`.
function buildWorld(cycleOver = {}, worldOver = {}) {
  const cycle = { id: 88, request_id: 34, status: 'interrupted', stage: 'build', segment: 'build', ...cycleOver };
  const w = world({ cycles: [cycle, ...(worldOver.cycles || [])], ...worldOver });
  const t = w.d.createTask({ projectId: 1, intent: 'build', goal: 'Add invoice export', requestId: 34, authorizedBy: 7 });
  w.d.updateTask(t.id, { lastCycleId: 88, status: buildTaskStatusFromCycle(cycle)?.status || 'active' });
  return { ...w, task: w.d.getTask(t.id), cycle };
}

const userEchoes = (calls) => calls.messages.filter((m) => m.kind === 'user');
const systemNotes = (calls) => calls.messages.filter((m) => m.kind === 'system');

// ---- pure helpers ----

test('personWords: a UI preamble never becomes the person\'s words', () => {
  assert.equal(personWords(`${PLAN_PREAMBLE}\n\nAdd CSV export to invoices`), 'Add CSV export to invoices');
  assert.equal(personWords(`${DESIGN_PREAMBLE}\n\ncontinue`), 'continue');
  assert.equal(personWords('RESEARCH & PLAN — no code changes in this turn.\nstep one\n\nREQUEST TO RESEARCH AND PLAN:\nStripe webhooks'), 'Stripe webhooks');
  assert.equal(personWords('  plain text  '), 'plain text');
  assert.equal(personWords(null), '');
});

test('goalFromInstruction: strips the harness continuation section and redacts', () => {
  const cont = buildContinuationInstruction({ original: 'Add invoice export', handoff: 'DONE: x\nNEXT STEPS: y', run: 1 });
  assert.equal(goalFromInstruction(cont), 'Add invoice export');
  assert.ok(!goalFromInstruction('use token=abc123secret for the api').includes('abc123secret'));
  assert.ok(goalFromInstruction('x'.repeat(2000)).length <= 500);
});

test('checksFromGateReports / checkpointStep', () => {
  assert.deepEqual(checksFromGateReports([{ name: 'typecheck', status: 'passed' }, { name: '', status: 'x' }, { name: 'tests' }]),
    [{ key: 'typecheck', status: 'passed' }, { key: 'tests', status: 'pending' }]);
  assert.deepEqual(checksFromGateReports(null), []);
  assert.equal(checkpointStep('1a2b3c4d5e6f'), 'Checkpoint 1a2b3c4 committed');
  assert.equal(checkpointStep(''), null);
  assert.equal(checkpointStep('not a sha'), null);
});

// ---- planCycleSync: the cycle → task patch ----

const T = (over = {}) => ({
  id: 1, key: 't1-x', intent: 'build', status: 'active', goal: 'x', requestId: 34, lastCycleId: null,
  nextStep: null, remaining: [], blockers: [], uncertain: [], completedSteps: [], context: null, ...over,
});
const plan = (task, cycle, uncertainNow = null) => planCycleSync({ task, cycle, info: buildTaskStatusFromCycle(cycle), uncertainNow });

test('planCycleSync: a new running segment is active and records its start', () => {
  const r = plan(T({ status: 'interrupted', lastCycleId: 87, remaining: ['Wire the button'] }), { id: 88, status: 'running', stage: 'build', segment: 'resumed' });
  assert.equal(r.patch.status, 'active');
  assert.equal(r.patch.lastCycleId, 88);
  assert.equal(r.patch.nextStep, 'Wire the button');
  assert.deepEqual(r.patch.blockers, []);
  assert.match(r.steps[0].step, /^Resumed from the last checkpoint/);
});

test('planCycleSync: a passed rules check (define) does not complete the task', () => {
  const r = plan(T({ lastCycleId: 50 }), { id: 50, status: 'succeeded', stage: 'define' });
  assert.equal(r.patch, null, 'still active, same segment');
  const r2 = plan(T({ lastCycleId: 49 }), { id: 50, status: 'succeeded', stage: 'define' });
  assert.equal(r2.patch.status, undefined);
  assert.equal(r2.patch.lastCycleId, 50);
});

test('planCycleSync: interrupted merges what is uncertain; completed clears it', () => {
  const r = plan(T({ lastCycleId: 88, uncertain: ['old item'] }), { id: 88, status: 'interrupted' }, ['Check whether exec_in_container (npm run migrate) completed before repeating it']);
  assert.equal(r.patch.status, 'interrupted');
  assert.deepEqual(r.patch.uncertain, ['Check whether exec_in_container (npm run migrate) completed before repeating it', 'old item']);
  assert.equal(r.patch.nextStep, 'Resume from the last checkpoint');
  const done = plan(T({ lastCycleId: 88, uncertain: ['old'], remaining: ['a'] }), { id: 88, status: 'succeeded' });
  assert.equal(done.patch.status, 'completed');
  assert.deepEqual(done.patch.uncertain, []);
  assert.deepEqual(done.patch.remaining, []);
  assert.equal(done.steps[0].verified, true);
});

test('planCycleSync: a person\'s stop lands as stopped, and a stopped task stays stopped while its old cycle settles', () => {
  const r = plan(T({ lastCycleId: 88, context: { stopRequestedAt: 'now', x: 1 } }), { id: 88, status: 'interrupted' });
  assert.equal(r.patch.status, 'stopped');
  assert.equal(r.patch.nextStep, null);
  assert.deepEqual(r.patch.context, { x: 1 }, 'the stop flag is consumed');
  const settle = plan(T({ status: 'stopped', lastCycleId: 88 }), { id: 88, status: 'interrupted', deploy_status: null });
  assert.equal(settle.patch, null);
  const resumed = plan(T({ status: 'stopped', lastCycleId: 88 }), { id: 89, status: 'estimating', segment: 'resumed' });
  assert.equal(resumed.patch.status, 'active', 'only a new segment reopens it');
});

test('planCycleSync: a halt says what blocked it and the recommended way forward', () => {
  const cycle = {
    id: 88, status: 'awaiting_admin', halt_reason: 'model_halt', error: 'needs the SMTP host',
    halt_options_json: JSON.stringify([{ id: 'a', label: 'Skip email for now' }, { id: 'b', label: 'Provide SMTP settings', recommended: true }]),
  };
  const r = plan(T({ lastCycleId: 88 }), cycle);
  assert.equal(r.patch.status, 'blocked');
  assert.equal(r.patch.blockers[0], 'Blocked: the build reported it was blocked — needs the SMTP host');
  assert.equal(r.patch.nextStep, 'Choose how to continue: Provide SMTP settings');
});

test('planCycleSync: the handoff\'s specific next step survives the pause', () => {
  const r = plan(T({ lastCycleId: 88, nextStep: 'Add the export route', context: { handoffCycleId: 88 } }), { id: 88, status: 'interrupted' });
  assert.equal(r.patch.nextStep, 'Add the export route');
});

// ---- annotateTask ----

test('annotateTask: live from the project\'s latest cycle of the SAME request; resumed segment; canResume from the last cycle', () => {
  const task = T({ status: 'active', requestId: 34, lastCycleId: 90 });
  const live = annotateTask(task, { lastCycle: { id: 90, status: 'running', request_id: 34 }, liveCycle: { id: 90, status: 'running', request_id: 34, segment: 'resumed' } });
  assert.equal(live.live, true);
  assert.equal(live.resumed, true);
  assert.equal(live.canResume, false);
  const other = annotateTask(task, { liveCycle: { id: 91, status: 'running', request_id: 35 } });
  assert.equal(other.live, false, 'another request\'s cycle is not this task');
  const stopped = annotateTask(T({ status: 'interrupted', lastCycleId: 90 }), { lastCycle: { id: 90, status: 'interrupted', request_id: 34 } });
  assert.equal(stopped.canResume, true);
  const asking = annotateTask(T({ status: 'blocked' }), { lastCycle: { id: 90, status: 'awaiting_user', stage: 'define' } });
  assert.equal(asking.canResume, false);
  const queued = annotateTask(T({ status: 'interrupted', context: { continuationPending: true } }), { continuationQueued: true });
  assert.equal(queued.live, true, 'a queued continuation is the task carrying on');
});

test('annotateTask: an investigation is live only while ITS ask job runs', () => {
  const inv = T({ id: 5, intent: 'investigation', status: 'active' });
  assert.equal(annotateTask(inv, { askJob: { phase: 'running', taskId: 5 } }).live, true);
  assert.equal(annotateTask(inv, { askJob: { phase: 'running', taskId: 6 } }).live, false);
  assert.equal(annotateTask(inv, { askJob: { phase: 'done', taskId: 5 } }).live, false);
  assert.equal(annotateTask(inv, { askJob: { phase: 'running', taskId: 5, continued: true } }).resumed, true);
});

// ---- request hook: one task per request; a continuation keeps its task ----

test('onRequestCreated: one build task per request, goal from the person\'s words, idempotent', async () => {
  const w = world();
  const req = { id: 34, project_id: 1, instruction: `${DESIGN_PREAMBLE}\n\nMake the header blue\n\n---\nREDO context …`, initiated_by: 7 };
  const t = await onRequestCreated(req, { origin: 'operator', goal: 'Make the header blue' }, w.d);
  assert.equal(t.intent, 'build');
  assert.equal(t.goal, 'Make the header blue');
  assert.equal(t.requestId, 34);
  assert.equal(t.authorizedBy, 7);
  assert.match(t.key, /^t1-make-the-header-blue$/);
  const again = await onRequestCreated(req, {}, w.d);
  assert.equal(again.id, t.id);
  assert.equal(w.store.size, 1);
});

test('onRequestCreated: the context-handoff continuation re-attaches to the ORIGINAL task', async () => {
  const w = world();
  const original = await onRequestCreated({ id: 34, project_id: 1, instruction: 'Add invoice export', initiated_by: 7 }, {}, w.d);
  w.d.updateTask(original.id, { lastCycleId: 88, status: 'interrupted', context: { continuationPending: true, handoffRun: 1 } });
  const contInstr = buildContinuationInstruction({ original: 'Add invoice export', handoff: 'NEXT STEPS:\n- wire it', run: 1 });
  const t = await onRequestCreated({ id: 40, project_id: 1, instruction: contInstr, initiated_by: 7 }, { origin: 'system' }, w.d);
  assert.equal(t.id, original.id, 'no new task');
  assert.equal(w.store.size, 1);
  assert.equal(t.requestId, 40);
  assert.equal(t.status, 'active');
  assert.deepEqual(t.context.priorRequestIds, [34]);
  assert.equal(t.context.continuationPending, undefined);
  assert.match(t.completedSteps.at(-1).step, /Continuation started \(run 1\)/);
});

test('onRequestCreated: the marker alone (no pending flag) still finds the original by goal', async () => {
  const w = world();
  const original = await onRequestCreated({ id: 34, project_id: 1, instruction: 'Add invoice export' }, {}, w.d);
  w.d.updateTask(original.id, { status: 'interrupted' });
  const contInstr = buildContinuationInstruction({ original: 'Add invoice export', handoff: 'x', run: 2 });
  const t = await onRequestCreated({ id: 41, project_id: 1, instruction: contInstr }, { origin: 'queued' }, w.d);
  assert.equal(t.id, original.id);
});

test('onRequestCreated: a system-origin request with no waiting task (a polish pass) is new work', async () => {
  const w = world();
  await onRequestCreated({ id: 34, project_id: 1, instruction: 'Add invoice export' }, {}, w.d);
  const t = await onRequestCreated({ id: 35, project_id: 1, instruction: 'Polish: fix the spacing' }, { origin: 'system' }, w.d);
  assert.equal(w.store.size, 2);
  assert.equal(t.requestId, 35);
});

// ---- cycle hook ----

test('onCycleChanged: entering interrupted records the uncertain operations and schedules the file sync', async () => {
  const events = {
    88: [
      { seq: 1, kind: 'tool_call', meta: { name: 'exec_in_container', input: { command: 'npm run migrate' } } },
    ],
  };
  const { d, calls, task } = buildWorld({ status: 'running' }, { events });
  await onCycleChanged(88, d);
  assert.equal(d.getTask(task.id).status, 'active');
  assert.deepEqual(calls.syncs, [], 'nothing to sync while the segment runs');
  // the runner/stall watchdog finishes the cycle
  const w2 = buildWorld({ status: 'interrupted' }, { events });
  w2.d.updateTask(w2.task.id, { status: 'active' });
  const after = await onCycleChanged(88, w2.d);
  assert.equal(after.status, 'interrupted');
  assert.equal(after.uncertain.length, 1);
  assert.match(after.uncertain[0], /npm run migrate/);
  assert.deepEqual(w2.calls.syncs, [1]);
});

test('onCycleChanged: a cycle with no task / a concept cycle is ignored; failures never throw', async () => {
  const w = world({ cycles: [{ id: 5, request_id: 99, status: 'running' }, { id: 6, request_id: null, status: 'running', stage: 'concept' }] });
  assert.equal(await onCycleChanged(5, w.d), null);
  assert.equal(await onCycleChanged(6, w.d), null);
  const broken = { ...w.d, getCycle: () => { throw new Error('db gone'); } };
  assert.equal(await onCycleChanged(5, broken), null);
});

// ---- runner hooks ----

test('writeTaskFilesForCycle: syncs the task to the cycle, fills the branch, writes WITHOUT committing', async () => {
  const { d, calls, task } = buildWorld({ status: 'running' });
  const r = await writeTaskFilesForCycle({ cycle: d.getCycle(88), project: PROJECT, containerName: 'm2-1' }, d);
  assert.equal(r.ok, true);
  assert.equal(calls.written.length, 1);
  // Convention files are the idle sync's job, never part of a build's diff.
  assert.equal(calls.written[0].ensureConvention, false);
  assert.equal(calls.written[0].containerName, 'm2-1');
  assert.equal(calls.written[0].task.branch, 'main');
  assert.equal(d.getTask(task.id).status, 'active');
});

test('beforeCheckpoint / afterCheckpoint: checks before the commit, the verified step after', async () => {
  const { d, calls, task } = buildWorld({ status: 'running' });
  await beforeCheckpoint({ cycle: d.getCycle(88), project: PROJECT, containerName: 'm2-1', gateReports: [{ name: 'typecheck', status: 'passed' }] }, d);
  assert.deepEqual(d.getTask(task.id).checks, [{ key: 'typecheck', status: 'passed' }]);
  assert.deepEqual(calls.written[0].task.checks, [{ key: 'typecheck', status: 'passed' }], 'the refreshed files carry the checks');
  await afterCheckpoint({ cycle: d.getCycle(88), commitSha: 'abcdef0123456789' }, d);
  await afterCheckpoint({ cycle: d.getCycle(88), commitSha: 'abcdef0123456789' }, d);
  const t = d.getTask(task.id);
  assert.equal(t.lastVerifiedStep, 'Checkpoint abcdef0 committed');
  assert.equal(t.completedSteps.filter((s) => s.step === 'Checkpoint abcdef0 committed').length, 1, 'deduped');
});

test('FD0130 cycle mirrors await the actual write and preserve unknown-outcome evidence', async () => {
  for (const hook of [writeTaskFilesForCycle, beforeCheckpoint]) {
    const { d, task } = buildWorld({ status: 'running' });
    let release;
    const pendingWrite = new Promise(resolve => { release = resolve; });
    let entered;
    const writing = new Promise(resolve => { entered = resolve; });
    d.writeTaskFilesInContainer = args => { assert.equal(args.cycleId, 88); entered(); return pendingWrite; };
    let completed = false;
    const pending = hook({ cycle: d.getCycle(88), project: PROJECT, containerName: 'm2-1' }, d).then(result => { completed = true; return result; });
    await writing;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(completed, false, 'never proceeds while the mutation is still running');
    release({ ok: false, uncertain: true, error: 'task_record_outcome_unknown' });
    assert.equal((await pending).uncertain, true);
    assert.match(d.getTask(task.id).uncertain[0], /no confirmed outcome/);
  }
  const source = readFileSync(new URL('../mock2/task-sync.js', import.meta.url), 'utf8');
  assert.ok(!source.includes('Promise.race'), 'the continuity writer never races a mutation against a timer');
});

test('onContextHandoff: remaining / next step from the handoff, and the task waits for its continuation', async () => {
  const { d, task } = buildWorld({ status: 'running' });
  await onContextHandoff({ cycle: d.getCycle(88), handoffText: 'DONE:\n- schema\nNEXT STEPS:\n1. Add the export route\n2. Wire the button\nGOTCHAS:\n- keep the old CSV header', run: 1 }, d);
  const t = d.getTask(task.id);
  assert.deepEqual(t.remaining, ['Add the export route', 'Wire the button']);
  assert.equal(t.nextStep, 'Add the export route');
  assert.equal(t.context.continuationPending, true);
  assert.equal(t.context.handoffCycleId, 88);
  assert.deepEqual(t.context.gotchas, ['keep the old CSV header']);
});

test('recoveryForCycle: the resumed build sees the checkpoint and the verify-before-repeating list', async () => {
  const { d, task } = buildWorld({ status: 'interrupted', deploy_status: 'deploying' });
  d.updateTask(task.id, { status: 'active', lastVerifiedStep: 'Checkpoint 1a2b3c4 committed' });
  const section = await recoveryForCycle(d.getCycle(88), d);
  assert.match(section, /^TASK CHECKPOINT \(state\/tasks\/t1-add-invoice-export\/task\.json\)/);
  assert.match(section, /VERIFY BEFORE REPEATING:\n- A deploy was in progress/);
  assert.match(section, /never repeat a deploy/);
  assert.equal(await recoveryForCycle({ id: 1, request_id: 999, project_id: 1 }, d), '', 'no task → no section');
  assert.equal(await recoveryForCycle(null, d), '');
});

test('buildResumeContextBlock: a recovery-only (bare) resume shows ONLY the checkpoint text; with guidance it precedes the operator message', () => {
  const rec = 'TASK CHECKPOINT (state/tasks/t1-x/task.json)\nVERIFY BEFORE REPEATING:\n- nothing';
  assert.equal(buildResumeContextBlock({ recovery: rec, bare: true }), rec, 'no authoritative-guidance header on a bare resume');
  const block = buildResumeContextBlock({ message: 'skip the tests', recovery: rec, lastCheckpoint: { seq: 3, summary: 'checkpoint: paused' } });
  assert.ok(block.startsWith('Operator guidance on resume'));
  assert.ok(block.indexOf('Last checkpoint before this resume') < block.indexOf('TASK CHECKPOINT'));
  assert.ok(block.indexOf('TASK CHECKPOINT') < block.indexOf('Operator message: skip the tests'));
  assert.equal(buildResumeContextBlock({}), '', 'nothing → still nothing');
});

// ---- ask hooks ----

test('onAskStarted: an investigation task with the person\'s own words as its goal', async () => {
  const w = world();
  const plan = await onAskStarted({ project: PROJECT, question: `${PLAN_PREAMBLE}\n\nHow should invoices export?`, user: USER }, w.d);
  assert.equal(plan.intent, 'investigation');
  assert.equal(plan.goal, 'How should invoices export?');
  assert.equal(plan.context.mode, 'plan');
  const said = await onAskStarted({ project: PROJECT, question: 'wrapped …', said: 'Why is login slow?', user: USER }, w.d);
  assert.equal(said.goal, 'Why is login slow?');
  const research = await onAskStarted({ project: PROJECT, question: 'Stripe webhooks', research: true, user: USER }, w.d);
  assert.equal(research.context.mode, 'research');
  const reused = await onAskStarted({ project: PROJECT, question: 'continue …', task: plan, user: USER }, w.d);
  assert.equal(reused.id, plan.id, 'a continuation reuses its task');
  assert.equal(w.store.size, 3);
});

test('onAskFinished: completed with a redacted excerpt; failed / ran-out stay unfinished; a stop wins', async () => {
  const w = world();
  const t = await onAskStarted({ project: PROJECT, question: 'Why is login slow?', user: USER }, w.d);
  const done = await onAskFinished({ taskId: t.id, outcome: 'completed', answer: 'The query lacks an index. password=hunter2' }, w.d);
  assert.equal(done.status, 'completed');
  assert.match(done.context.answerExcerpt, /lacks an index/);
  assert.ok(!done.context.answerExcerpt.includes('hunter2'));
  assert.deepEqual(w.calls.syncs, [1]);
  const t2 = await onAskStarted({ project: PROJECT, question: 'Q2', user: USER }, w.d);
  assert.equal((await onAskFinished({ taskId: t2.id, outcome: 'failed', error: 'model 529' }, w.d)).status, 'failed');
  const t3 = await onAskStarted({ project: PROJECT, question: 'Q3', user: USER }, w.d);
  assert.equal((await onAskFinished({ taskId: t3.id, outcome: 'interrupted', answer: 'partial' }, w.d)).status, 'interrupted');
  const t4 = await onAskStarted({ project: PROJECT, question: 'Q4', user: USER }, w.d);
  w.d.updateTask(t4.id, { status: 'stopped' });
  assert.equal((await onAskFinished({ taskId: t4.id, outcome: 'completed', answer: 'x' }, w.d)).status, 'stopped');
});

// ---- boot sweep ----

test('sweepTasksOnBoot: orphaned build → interrupted with uncertain; investigation → interrupted; a live cycle is left alone', async () => {
  const events = { 88: [{ seq: 1, kind: 'deploy', meta: {} }] };
  const w = world({
    cycles: [
      { id: 88, request_id: 34, status: 'failed', error: 'orphaned by restart' },
      { id: 89, request_id: 35, status: 'queued' },
    ],
    events,
  });
  const a = w.d.createTask({ projectId: 1, intent: 'build', goal: 'A', requestId: 34 });
  w.d.updateTask(a.id, { lastCycleId: 88 });
  const b = w.d.createTask({ projectId: 1, intent: 'build', goal: 'B', requestId: 35 });
  w.d.updateTask(b.id, { lastCycleId: 89 });
  const inv = w.d.createTask({ projectId: 1, intent: 'investigation', goal: 'Q' });
  const summary = await sweepTasksOnBoot(w.d);
  assert.equal(summary.interrupted, 2);
  const at = w.d.getTask(a.id);
  assert.equal(at.status, 'interrupted');
  assert.match(at.uncertain[0], /A deploy was in progress/);
  assert.equal(at.nextStep, 'Resume from the last checkpoint');
  assert.equal(w.d.getTask(b.id).status, 'active', 'its cycle is still live');
  assert.equal(w.d.getTask(inv.id).status, 'interrupted');
  assert.ok(w.calls.syncs.includes(1));
});

// ---- the chat routing: every action ----

test('route: an ordinary message passes untouched — no store read, no echo', async () => {
  const w = world();
  const spy = { ...w.d, listTasks: () => { throw new Error('should not read'); } };
  const r = await routeChatMessage({ project: PROJECT, message: 'Add a dark mode toggle', lane: 'build', user: USER }, spy);
  assert.deepEqual(r, { handled: false });
  assert.equal(w.calls.messages.length, 0);
});

test('route: "continue" with nothing unfinished passes (today\'s behaviour)', async () => {
  const w = world();
  assert.deepEqual(await routeChatMessage({ project: PROJECT, message: 'continue', lane: 'build', user: USER }, w.d), { handled: false });
});

test('route resume_build: retryCycle on the task\'s last cycle with the guidance; echoed once; 202', async () => {
  const { d, calls, task } = buildWorld({ status: 'interrupted' });
  const r = await routeChatMessage({ project: PROJECT, message: 'continue but skip the PDF part', lane: 'build', user: USER, ip: '1.2.3.4' }, d);
  assert.equal(r.handled, true);
  assert.equal(r.status, 202);
  assert.equal(r.body.routed.action, 'resume_build');
  assert.equal(r.body.routed.note, 'Resuming build: Add invoice export');
  assert.equal(r.body.routed.task.key, task.key);
  assert.equal(calls.retryCycle.length, 1);
  assert.equal(calls.retryCycle[0].cycle.id, 88);
  assert.equal(calls.retryCycle[0].message, 'skip the PDF part');
  assert.equal(calls.retryCycle[0].initiatedBy, 7);
  assert.equal(calls.startAsk.length, 0);
  assert.deepEqual(userEchoes(calls).map((m) => m.body), ['continue but skip the PDF part']);
  assert.deepEqual(systemNotes(calls).map((m) => m.body), ['Resuming build: Add invoice export']);
  assert.equal(calls.audits[0][1], 'MOCK2_TASK_ROUTED');
  assert.deepEqual(calls.audits[0][4], { action: 'resume_build', task_key: task.key, lane: 'build', reason: 'resume_build' });
  assert.equal(calls.audits[0][5], '1.2.3.4');
});

test('route resume_build: a failed start is refused (409) with nothing echoed; a screenshot keeps today\'s path', async () => {
  const w = buildWorld({ status: 'interrupted' }, { retryResult: { status: 'error', error: 'This project is checked out by another writer.' } });
  const r = await routeChatMessage({ project: PROJECT, message: 'try again', lane: 'build', user: USER }, w.d);
  assert.equal(r.status, 409);
  assert.match(r.body.error, /another writer/);
  assert.equal(w.calls.messages.length, 0);
  const w2 = buildWorld({ status: 'interrupted' });
  const withImage = await routeChatMessage({ project: PROJECT, message: 'try again', lane: 'build', user: USER, images: [{ media_type: 'image/png' }] }, w2.d);
  assert.deepEqual(withImage, { handled: false });
  assert.equal(w2.calls.retryCycle.length, 0);
});

test('route resume_build: a quota refusal answers 200 with what happened', async () => {
  const w = buildWorld({ status: 'failed', error: 'boom' }, { retryResult: { status: 'refused', error: 'Over the monthly budget' } });
  const r = await routeChatMessage({ project: PROJECT, message: 'retry', lane: 'build', user: USER }, w.d);
  assert.equal(r.status, 200);
  assert.equal(r.body.routed.note, 'Not resumed: Over the monthly budget');
});

test('route: "continue" typed in the ASK lane still resumes the authorized build (with its build tools via retryCycle)', async () => {
  const { d, calls } = buildWorld({ status: 'interrupted' });
  const r = await routeChatMessage({ project: PROJECT, message: 'continue', lane: 'ask', user: USER }, d);
  assert.equal(r.body.routed.action, 'resume_build');
  assert.equal(calls.retryCycle.length, 1);
});

test('route attach: the build is already running — nothing starts, the UI is pointed at it', async () => {
  const { d, calls } = buildWorld({ status: 'running' });
  d.updateTask(1, { status: 'active' });
  const r = await routeChatMessage({ project: PROJECT, message: 'keep going', lane: 'build', user: USER }, d);
  assert.equal(r.status, 200);
  assert.equal(r.body.routed.action, 'attach');
  assert.equal(r.body.routed.task.live, true);
  assert.match(r.body.routed.note, /^Already running: Add invoice export/);
  assert.equal(calls.retryCycle.length + calls.startAsk.length, 0);
  assert.equal(userEchoes(calls).length, 1);
});

test('route answer_required: a build waiting on rule answers cannot be resumed by "continue"', async () => {
  const { d, calls } = buildWorld({ status: 'awaiting_user', stage: 'define' });
  const r = await routeChatMessage({ project: PROJECT, message: 'continue', lane: 'build', user: USER }, d);
  assert.equal(r.body.routed.action, 'answer_required');
  assert.equal(r.status, 200);
  assert.equal(calls.retryCycle.length, 0);
});

test('route continue_investigation: read-only in either lane — startAsk with the continuation question, never retryCycle', async () => {
  for (const lane of ['build', 'ask']) {
    const w = world();
    const inv = w.d.createTask({ projectId: 1, intent: 'investigation', goal: 'Why is login slow?', context: { answerExcerpt: 'The sessions table has no index.' } });
    w.d.updateTask(inv.id, { status: 'interrupted' });
    const r = await routeChatMessage({ project: PROJECT, message: 'continue: check the cache too', lane, user: USER }, w.d);
    assert.equal(r.status, 202, lane);
    assert.equal(r.body.routed.action, 'continue_investigation');
    assert.equal(w.calls.retryCycle.length, 0, 'an investigation never authorizes a build');
    assert.equal(w.calls.startAsk.length, 1);
    const call = w.calls.startAsk[0];
    assert.equal(call.routed, true);
    assert.equal(call.task.id, inv.id);
    assert.equal(call.echoBody, 'continue: check the cache too', 'the ask echoes the person\'s words, once');
    assert.equal(call.question, buildInvestigationContinuation({ task: w.d.getTask(inv.id), guidance: 'check the cache too' }));
    assert.match(call.question, /read-only investigation/);
    assert.equal(userEchoes(w.calls).length, 0, 'the router itself does not echo a second time');
    assert.deepEqual(systemNotes(w.calls).map((m) => m.body), ['Continuing investigation: Why is login slow?']);
  }
});

test('route investigate: "only explain" in the build lane runs the read-only ask lane; in the ask lane it passes', async () => {
  const { d, calls } = buildWorld({ status: 'interrupted' });
  const msg = "Only explain why the export fails — don't change anything";
  const r = await routeChatMessage({ project: PROJECT, message: msg, lane: 'build', user: USER }, d);
  assert.equal(r.status, 202);
  assert.equal(r.body.routed.action, 'investigate');
  assert.equal(r.body.routed.note, 'Answering without changing anything');
  assert.equal(calls.retryCycle.length, 0);
  assert.equal(calls.startAsk.length, 1);
  assert.equal(calls.startAsk[0].routed, true, 'the design-options/polish detectors (which can queue a build) are skipped');
  assert.equal(calls.startAsk[0].question, msg);
  assert.equal(r.body.routed.task.intent, 'investigation');
  const w = buildWorld({ status: 'interrupted' });
  assert.deepEqual(await routeChatMessage({ project: PROJECT, message: msg, lane: 'ask', user: USER }, w.d), { handled: false });
});

test('route stop_build: the live build stops after its current step (stop_after_step), and lands as stopped', async () => {
  const { d, calls, task } = buildWorld({ status: 'running' });
  d.updateTask(task.id, { status: 'active' });
  const r = await routeChatMessage({ project: PROJECT, message: 'stop', lane: 'build', user: USER }, d);
  assert.equal(r.status, 200);
  assert.equal(r.body.routed.action, 'stop_build');
  assert.deepEqual(calls.interrupts, [{ id: 88, action: 'stop_after_step' }]);
  assert.ok(calls.audits.some((a) => a[1] === 'MOCK2_CYCLE_INTERRUPT'), 'the same audit row as the interrupt route');
  assert.ok(d.getTask(task.id).context.stopRequestedAt);
  // the runner honours it: the cycle ends interrupted → the task is stopped
  const c = d.getCycle(88);
  const p = planCycleSync({ task: d.getTask(task.id), cycle: { ...c, status: 'interrupted' }, info: buildTaskStatusFromCycle({ ...c, status: 'interrupted' }) });
  assert.equal(p.patch.status, 'stopped');
});

test('route stop_build: a rules check or a starting build is not interruptible yet — refused, nothing echoed', async () => {
  const define = buildWorld({ status: 'running', stage: 'define' });
  define.d.updateTask(1, { status: 'active' });
  const r = await routeChatMessage({ project: PROJECT, message: 'stop the build', lane: 'build', user: USER }, define.d);
  assert.equal(r.status, 409);
  assert.equal(define.calls.interrupts.length, 0);
  assert.equal(define.calls.messages.length, 0);
  const starting = buildWorld({ status: 'estimating' });
  starting.d.updateTask(1, { status: 'active' });
  assert.equal((await routeChatMessage({ project: PROJECT, message: 'stop', lane: 'build', user: USER }, starting.d)).status, 409);
});

test('route stop_build: a continuation waiting in the queue is cancelled', async () => {
  const contInstr = buildContinuationInstruction({ original: 'Add invoice export', handoff: 'x', run: 1 });
  const w = buildWorld({ status: 'interrupted' }, { queue: [{ id: 9, status: 'queued', instruction: contInstr }] });
  w.d.updateTask(1, { context: { continuationPending: true } });
  const r = await routeChatMessage({ project: PROJECT, message: 'cancel', lane: 'build', user: USER }, w.d);
  assert.equal(r.body.routed.action, 'stop_build');
  assert.deepEqual(w.calls.cancels, [9]);
  assert.equal(w.d.getTask(1).status, 'stopped');
});

test('route stop_task / nothing_to_stop', async () => {
  const { d, calls, task } = buildWorld({ status: 'interrupted' });
  const r = await routeChatMessage({ project: PROJECT, message: 'never mind', lane: 'ask', user: USER }, d);
  assert.equal(r.body.routed.action, 'stop_task');
  assert.equal(d.getTask(task.id).status, 'stopped');
  assert.equal(r.body.routed.note, 'Stopped: Add invoice export');
  assert.equal(calls.interrupts.length, 0);
  const w = world();
  const n = await routeChatMessage({ project: PROJECT, message: 'stop', lane: 'build', user: USER }, w.d);
  assert.equal(n.status, 200);
  assert.equal(n.body.routed.action, 'nothing_to_stop');
  assert.equal(n.body.routed.note, 'Nothing is running to stop.');
  assert.equal(n.body.routed.task, null);
});

test('route: `said` (the person\'s words beside a preamble-wrapped message) is what is classified and echoed', async () => {
  const { d, calls } = buildWorld({ status: 'interrupted' });
  const r = await routeChatMessage({ project: PROJECT, message: `${PLAN_PREAMBLE}\n\nwhatever`, said: 'try again', lane: 'ask', user: USER }, d);
  assert.equal(r.body.routed.action, 'resume_build');
  assert.equal(userEchoes(calls)[0].body, 'try again');
  // and without `said`, a known preamble is cut before classifying
  const w = buildWorld({ status: 'interrupted' });
  const r2 = await routeChatMessage({ project: PROJECT, message: `${DESIGN_PREAMBLE}\n\ncontinue`, lane: 'build', user: USER }, w.d);
  assert.equal(r2.body.routed.action, 'resume_build');
});

test('FD0130-1 recognized controls fail closed when the task store is unavailable; ordinary text stays unchanged', async () => {
  for (const message of ['continue', 'stop', 'only explain why', 'continue, but only explain why']) {
    const w = buildWorld({ status: 'interrupted' });
    const broken = { ...w.d, listTasks: () => { throw new Error('untrusted db detail'); } };
    const result = await routeChatMessage({ project: PROJECT, message, lane: 'build', user: USER }, broken);
    assert.equal(result.handled, true, message);
    assert.equal(result.status, 503, message);
    assert.doesNotMatch(result.body.error, /untrusted db detail/);
    assert.equal(w.calls.retryCycle.length + w.calls.startAsk.length, 0);
  }
  const w = world();
  const broken = { ...w.d, listTasks: () => { throw new Error('should not read'); } };
  assert.deepEqual(await routeChatMessage({ project: PROJECT, message: 'Build a read-only table', lane: 'build', user: USER }, broken), { handled: false });
});

// ---- reads + task routes ----

test('currentTaskForProject / listTaskShapes: the live task first, snake_case shapes, no identity fields', async () => {
  const { d, task } = buildWorld({ status: 'running', segment: 'resumed' });
  d.updateTask(task.id, { status: 'active' });
  const cur = await currentTaskForProject(1, d);
  assert.equal(cur.key, task.key);
  assert.equal(cur.live, true);
  assert.equal(cur.resumed, true);
  assert.equal(cur.can_resume, false);
  assert.equal('authorized_by' in cur, false);
  assert.deepEqual(cur.files, { task_json: `state/tasks/${task.key}/task.json`, handoff_md: `state/tasks/${task.key}/handoff.md` });
  const list = await listTaskShapes(1, { scope: 'all', limit: 10 }, d);
  assert.equal(list.tasks.length, 1);
  assert.equal(list.current.key, task.key);
  assert.equal(await currentTaskForProject(2, d), null);
});

test('task routes: an invalid or unknown key is 404 and never reaches a lookup', async () => {
  const { d } = buildWorld({ status: 'interrupted' });
  const spy = { ...d, getTaskByKey: () => { throw new Error('should not look up'); } };
  assert.equal(await getTaskShapeByKey(1, '../../etc/passwd', spy), null);
  assert.equal((await resumeTaskByKey({ project: PROJECT, key: 'T1-BAD', user: USER }, spy)).status, 404);
  assert.equal((await stopTaskByKey({ project: PROJECT, key: 't1-', user: USER }, spy)).status, 404);
  assert.equal((await resumeTaskByKey({ project: PROJECT, key: 't999-nope', user: USER }, d)).status, 404);
});

test('resumeTaskByKey: a build resumes through retryCycle (MOCK2_TASK_RESUME); a live or blocked one is 409', async () => {
  const { d, calls, task } = buildWorld({ status: 'interrupted' });
  const r = await resumeTaskByKey({ project: PROJECT, key: task.key, message: 'use the new API', user: USER, ip: '::1' }, d);
  assert.equal(r.status, 202);
  assert.equal(r.body.routed.action, 'resume_build');
  assert.equal(calls.retryCycle[0].message, 'use the new API');
  assert.ok(calls.audits.some((a) => a[1] === 'MOCK2_TASK_RESUME'));
  assert.deepEqual(userEchoes(calls).map((m) => m.body), ['use the new API']);
  const live = buildWorld({ status: 'running' });
  assert.equal((await resumeTaskByKey({ project: PROJECT, key: live.task.key, user: USER }, live.d)).status, 409);
  const asking = buildWorld({ status: 'awaiting_user', stage: 'define' });
  assert.equal((await resumeTaskByKey({ project: PROJECT, key: asking.task.key, user: USER }, asking.d)).status, 409);
});

test('FD0130-1 direct Resume guidance honors explain and stop before retrying an authorized build', async () => {
  for (const message of ['only explain why it failed', 'continue, but only explain the error', 'try again, just explain why']) {
    const w = buildWorld({ status: 'interrupted' });
    const result = await resumeTaskByKey({ project: PROJECT, key: w.task.key, message, user: USER }, w.d);
    assert.equal(result.status, 202, message);
    assert.equal(result.body.routed.action, 'investigate', message);
    assert.equal(w.calls.retryCycle.length, 0, message);
    assert.equal(w.calls.startAsk.length, 1, message);
    assert.equal(w.calls.startAsk[0].task, null, 'does not change the original build into an investigation');
    assert.equal(w.calls.startAsk[0].said, message);
    assert.equal(w.d.getTask(w.task.id).status, 'interrupted');
  }
  const w = buildWorld({ status: 'interrupted' });
  const stopped = await resumeTaskByKey({ project: PROJECT, key: w.task.key, message: 'stop', user: USER }, w.d);
  assert.equal(stopped.status, 200);assert.equal(stopped.body.routed.action, 'stop_task');
  assert.equal(w.calls.retryCycle.length, 0);assert.equal(w.d.getTask(w.task.id).status, 'stopped');
});

test('resumeTaskByKey: an investigation continues read-only (startAsk), no echo without a message', async () => {
  const w = world();
  const inv = w.d.createTask({ projectId: 1, intent: 'investigation', goal: 'Why is login slow?' });
  w.d.updateTask(inv.id, { status: 'failed' });
  const r = await resumeTaskByKey({ project: PROJECT, key: inv.key, user: USER }, w.d);
  assert.equal(r.status, 202);
  assert.equal(r.body.routed.action, 'continue_investigation');
  assert.equal(w.calls.retryCycle.length, 0);
  assert.equal(w.calls.startAsk[0].echoBody, '', 'the built question is never shown as the person\'s message');
  assert.equal(w.calls.startAsk[0].task.id, inv.id);
});

test('stopTaskByKey: a live build gets stop_after_step (MOCK2_TASK_STOP); an idle one is marked stopped; a finished one is 409', async () => {
  const live = buildWorld({ status: 'running' });
  live.d.updateTask(1, { status: 'active' });
  const r = await stopTaskByKey({ project: PROJECT, key: live.task.key, user: USER }, live.d);
  assert.equal(r.status, 200);
  assert.equal(r.body.routed.action, 'stop_build');
  assert.deepEqual(live.calls.interrupts, [{ id: 88, action: 'stop_after_step' }]);
  assert.ok(live.calls.audits.some((a) => a[1] === 'MOCK2_TASK_STOP'));
  const idle = buildWorld({ status: 'interrupted' });
  const r2 = await stopTaskByKey({ project: PROJECT, key: idle.task.key, user: USER }, idle.d);
  assert.equal(r2.body.routed.action, 'stop_task');
  assert.equal(idle.d.getTask(1).status, 'stopped');
  assert.equal((await stopTaskByKey({ project: PROJECT, key: idle.task.key, user: USER }, idle.d)).status, 409);
});

test('LIVE_CYCLE_STATUSES matches the cycle statuses a build executes in', () => {
  assert.deepEqual([...LIVE_CYCLE_STATUSES], ['queued', 'estimating', 'running']);
});

// ---- wiring ratchets (native modules, read as source) ----

const src = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const between = (s, from, to) => {
  const a = s.indexOf(from);
  assert.ok(a >= 0, `anchor not found: ${from}`);
  const b = to ? s.indexOf(to, a + from.length) : s.length;
  return s.slice(a, b < 0 ? s.length : b);
};

test('ratchet: routes.js routes a chat message BEFORE the ask starts and before the build\'s probe/clarifier', () => {
  const routes = src('../mock2/routes.js');
  const ask = between(routes, "router.post('/projects/:id/ask'", "router.get('/projects/:id/design-options/screens'");
  assert.ok(ask.indexOf('routeChatMessage(') > 0 && ask.indexOf('routeChatMessage(') < ask.indexOf('startAsk('));
  const cycles = between(routes, "router.post('/projects/:id/cycles'", "router.post('/projects/:id/build-groups'");
  const at = cycles.indexOf('routeChatMessage(');
  assert.ok(at > 0);
  for (const later of ['redoContextSection(', 'probeSplitProposal(', 'clarifyRequest(', 'startBuild(']) assert.ok(at < cycles.indexOf(later), later);
  assert.match(cycles, /cardResend = !!\(parsed\.data\.redo \|\| parsed\.data\.skip_clarify/);
  assert.match(between(routes, "router.get('/projects/:id/chat'", 'ASK lane'), /current_task: currentTask/);
  assert.match(routes, /registerTaskRoutes\(router, refuseIfArchived\);/);
  // the interrupt route and a task stop share one rule
  assert.match(between(routes, "router.post('/projects/:id/cycles/:cycleId/interrupt'", 'RESTART a stuck build'), /requestCycleInterrupt\(cycle, parsed\.data\.action\)/);
});

test('ratchet: request + cycle transitions feed the task hooks; project delete removes tasks', () => {
  const requests = src('../mock2/requests.js');
  assert.match(between(requests, 'export function insertRequest(', 'export function closeRequest('), /onRequestCreated\(request, \{ origin, goal: taskGoal \}\)/);
  const cycles = src('../mock2/cycles.js');
  for (const fn of ['export function insertCycle(', 'export function updateCycle(', 'export function finishCycle(']) {
    assert.match(between(cycles, fn, '\nexport function'), /notifyTaskSync\(cycle\)/, fn);
  }
  assert.match(src('../mock2/audit.js'), /insertRequest\(\{[^}]*origin, taskGoal \}\)/);
  assert.match(between(src('../mock2/projects.js'), 'export function deleteProject(', 'DELETE FROM mock2_projects WHERE id = ?'), /deleteTasksForProject\(id\)/);
  const boot = src('../index.js');
  assert.ok(boot.indexOf('await sweepTasksOnBoot()') > boot.indexOf('sweepMock2OnBoot();'));
});

test('ratchet: the runner writes task files before the first turn, refreshes them before the checkpoint commit, and every resume carries the recovery section', () => {
  const runner = src('../mock2/runner.js');
  const drive = between(runner, 'const driveCycle = async () => {', 'harness.runTask(args)');
  assert.match(drive, /writeTaskFilesForCycle\(/);
  const cp = between(runner, 'export async function checkpointAndRecord(', 'export async function concludeCycle(');
  assert.ok(cp.indexOf('beforeCheckpoint(') < cp.indexOf('buildCheckpointScript('));
  assert.ok(cp.indexOf('afterCheckpoint(') > cp.indexOf('rev-parse HEAD'));
  const retry = between(runner, 'export async function retryCycle(', 'export async function retryDeploy(');
  assert.match(retry, /recoveryForCycle\(cycle\)/);
  assert.match(retry, /startCycle\(\{[^}]*resumeContext, recovery,/);
  // a bare resume stays bare: recovery never makes resumeContext non-null
  assert.doesNotMatch(between(retry, 'const resumeContext = (', ';'), /recovery/);
  assert.match(runner, /\{ recovery: rec, bare: true \}/);
  assert.match(between(runner, "if (pauseReason === 'context_handoff') {", 'await checkpointAndRecord('), /onContextHandoff\(\{ cycle, handoffText, run: nextRun \}\)/);
});

test('ratchet: the ask lane stays read-only — a task never changes its tools', () => {
  const ask = src('../mock2/ask.js');
  assert.match(ask, /tools: ASK_TOOLS,/);
  assert.doesNotMatch(ask, /RUNNER_TOOLS|runnerToolsForCycle|retryCycle|startBuild/);
  const sync = src('../mock2/task-sync.js');
  // an investigation's resume never reaches the build machinery
  const inv = between(sync, 'async function runInvestigation(', '\n}\n');
  assert.doesNotMatch(inv, /retryCycle|startBuild|startCycle/);
});
