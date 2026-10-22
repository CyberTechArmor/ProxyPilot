// Mock2 task continuity — the portable-file writer (task-files.js): the idle
// decision, which tasks and which convention files get written, the
// path-scoped commit (its quoting, and against a real git checkout + bare
// origin), the debounce/backoff/give-up schedule, and that nothing throws.
// Container I/O and the DB are injected — no Incus, no better-sqlite3.

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  taskFilesIdleState, selectTasksToWrite, nextTaskFilesRetryMs, TASK_FILES_RETRY_MS, TASK_FILES_PER_RUN,
  buildPathsExistScript, parseMissingPaths, buildTaskFilesCommitScript, parseCommitOutput, taskFilesCommitMessage,
  writeTaskFilesInContainer, syncTaskFilesNow, scheduleTaskFilesSync,
  _setTaskFilesDepsForTests, _resetTaskFilesForTests, _pendingTaskFilesSyncsForTests,
} from '../mock2/task-files.js';
import { renderTaskJson, renderTaskHandoffMd } from '../mock2/task-logic.js';
import { agentsMd, tasksReadmeMd } from '../mock2/continuity-convention.js';

const SHA = 'a'.repeat(40);
const iso = (min) => new Date(Date.parse('2026-10-21T12:00:00.000Z') - min * 60_000).toISOString();

function task(id, over = {}) {
  return {
    id, key: `t${id}-goal-${id}`, projectId: 3, intent: 'build', status: 'interrupted', goal: `Goal ${id}`,
    requestId: null, lastCycleId: null, authorizedBy: 99, authorizedAt: iso(100), folder: '/srv/app', branch: null,
    lastVerifiedStep: null, nextStep: null, completedSteps: [], checks: [], blockers: [], remaining: [], uncertain: [],
    context: null, revision: 2, filesRevision: 1, createdAt: iso(100), updatedAt: iso(id), finishedAt: null, ...over,
  };
}

// A scripted container + DB: records every write, script and mark. The
// existence check is answered from `existing` (paths decoded from the script's
// base64, exactly as the shell would).
function fakeWorld({ project, lock = null, cycle = null, askJob = null, tasks = [], existing = [], commit, onWrite } = {}) {
  const w = {
    project: project === undefined ? { id: 3, name: 'Demo', lifecycle: 'active', container_name: null } : project,
    lock, cycle, askJob, tasks, existing: new Set(existing), writes: [], scripts: [], marks: [],
    commit: commit || { code: 0, stdout: `${SHA}\n`, stderr: 'PP_TASK_COMMIT_DONE 0\n' },
    leases: [],
  };
  w.deps = {
    acquireTaskContinuityLease: (_pid, { cycleId } = {}) => {
      if (cycleId != null ? w.lock?.holder_cycle_id !== cycleId || w.lock?.holder_operation_id != null : w.lock != null) return { ok: false, reason: 'locked' };
      const token = 'test-operation-token';
      w.lock = { ...w.lock, holder_operation_id: token, holder_operation_state: 'active' };
      w.leases.push('acquired');
      return { ok: true, token };
    },
    settleTaskContinuityLease: (_pid, token) => {
      w.leases.push('settled');
      if (w.lock?.holder_operation_id !== token) return false;
      w.lock = w.lock.holder_cycle_id != null ? { holder_cycle_id: w.lock.holder_cycle_id } : null; return true;
    },
    markTaskContinuityLeaseUncertain: (_pid, token) => {
      w.leases.push('uncertain');
      if (w.lock?.holder_operation_id !== token) return false;
      w.lock.holder_operation_state = 'uncertain'; return true;
    },
    containerNameForProject: (id) => `m2-${id}`,
    getProject: (id) => (w.project && Number(w.project.id) === Number(id) ? w.project : null),
    getLock: () => w.lock,
    latestCycle: () => w.cycle,
    getAskJobStatus: () => w.askJob,
    listTasks: () => w.tasks,
    markFilesRevision: (id, rev) => { w.marks.push([id, rev]); return true; },
    writeFileInContainer: async (containerName, path, content) => {
      w.writes.push({ containerName, path, content });
      const r = onWrite ? onWrite(w, path) : null;
      return r || { ok: true };
    },
    containerSh: async (containerName, script) => {
      w.scripts.push({ containerName, script });
      if (script.includes('PP_EXISTS')) {
        const paths = [...script.matchAll(/printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d\); if/g)].map((m) => Buffer.from(m[1], 'base64').toString('utf8'));
        return { code: 0, stdout: paths.map((p, i) => `${w.existing.has(p) ? 'PP_EXISTS' : 'PP_MISSING'} ${i}`).join('\n'), stderr: '' };
      }
      const acknowledgement = script.match(/printf \"(PP_TASK_COMMIT_[A-Za-z0-9_]+) %s/)?.[1];
      return { ...w.commit, stderr: w.commit.stderr.replaceAll('PP_TASK_COMMIT_DONE', acknowledgement || 'PP_TASK_COMMIT_DONE') };
    },
  };
  return w;
}

const commitScripts = (w) => w.scripts.filter((s) => s.script.includes('git add -A'));
const decodedArgs = (script) => {
  const line = script.split('\n').find((l) => l.startsWith('set -- '));
  return [...line.matchAll(/'([A-Za-z0-9+/=]+)'/g)].map((m) => Buffer.from(m[1], 'base64').toString('utf8'));
};

test.afterEach(() => _resetTaskFilesForTests());

// ---- pure decisions ----

test('the module loads its native dependencies lazily: no static import of runner/db/locks/cycles/ask/tasks', () => {
  const src = readFileSync(new URL('../mock2/task-files.js', import.meta.url), 'utf8');
  const statics = [...src.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
  assert.deepEqual(statics.sort(), ['./continuity-convention.js', './task-logic.js', './task-record-write.js', 'node:crypto']);
  for (const m of ['./runner.js', './provision.js', './locks.js', './cycles.js', './ask.js', './tasks.js']) {
    assert.ok(src.includes(`import('${m}')`), m);
  }
});

test('taskFilesIdleState: online, no lock holder, no live cycle, no ask running', () => {
  const project = { lifecycle: 'active' };
  assert.deepEqual(taskFilesIdleState({ project }), { idle: true, reason: null });
  assert.deepEqual(taskFilesIdleState({ project: { lifecycle: 'archived' } }), { idle: false, reason: 'not_active' });
  assert.deepEqual(taskFilesIdleState({ project: null }), { idle: false, reason: 'not_active' });
  assert.equal(taskFilesIdleState({ project, lock: { holder_user_id: 4, holder_cycle_id: null } }).reason, 'locked');
  assert.equal(taskFilesIdleState({ project, lock: { holder_user_id: null, holder_cycle_id: 9 } }).reason, 'locked');
  assert.equal(taskFilesIdleState({ project, lock: { holder_operation_id: 'lease' } }).reason, 'locked');
  assert.equal(taskFilesIdleState({ project, lock: { holder_user_id: null, holder_cycle_id: null } }).idle, true, 'an empty lock row holds nothing');
  for (const status of ['queued', 'estimating', 'running']) {
    assert.equal(taskFilesIdleState({ project, cycle: { status } }).reason, 'cycle_running', status);
  }
  for (const status of ['succeeded', 'failed', 'interrupted', 'awaiting_admin', 'awaiting_user', 'abandoned', 'refused_quota']) {
    assert.equal(taskFilesIdleState({ project, cycle: { status } }).idle, true, status);
  }
  assert.equal(taskFilesIdleState({ project, askJob: { phase: 'thinking' } }).reason, 'ask_running');
  assert.equal(taskFilesIdleState({ project, askJob: { phase: 'done' } }).idle, true);
  assert.equal(taskFilesIdleState({ project, askJob: { phase: 'failed' } }).idle, true);
});

test('selectTasksToWrite: files behind the row, valid keys only, newest first, at most 5', () => {
  const tasks = [
    task(1, { revision: 3, filesRevision: 3 }), // up to date
    task(2, { key: null }), task(3, { key: '../evil' }), // never written
    ...Array.from({ length: 8 }, (_, i) => task(10 + i, { updatedAt: iso(20 - i) })),
  ];
  const picked = selectTasksToWrite(tasks);
  assert.equal(TASK_FILES_PER_RUN, 5);
  assert.deepEqual(picked.map((t) => t.id), [17, 16, 15, 14, 13]);
  assert.deepEqual(selectTasksToWrite(tasks, { max: 2 }).map((t) => t.id), [17, 16]);
  assert.deepEqual(selectTasksToWrite(null), []);
});

test('nextTaskFilesRetryMs: 5s, 15s, 1 min, 5 min, then give up', () => {
  assert.deepEqual([...TASK_FILES_RETRY_MS], [5000, 15000, 60000, 300000]);
  assert.deepEqual([0, 1, 2, 3, 4, -1, 'x'].map(nextTaskFilesRetryMs), [5000, 15000, 60000, 300000, null, null, null]);
});

test('buildPathsExistScript / parseMissingPaths: paths decoded in-shell; an incomplete answer is null', () => {
  const nasty = `odd dir/it's "$(touch /tmp/pwned)" \`x\`.md`;
  const script = buildPathsExistScript(['AGENTS.md', nasty]);
  assert.ok(!script.includes('AGENTS.md') && !script.includes('pwned') && !script.includes("it's"), 'no raw path in the script');
  assert.deepEqual(parseMissingPaths({ code: 0, stdout: 'PP_EXISTS 0\nPP_MISSING 1\n' }, ['a', 'b']), ['b']);
  assert.deepEqual(parseMissingPaths({ code: 0, stdout: 'PP_MISSING 0\nPP_MISSING 1' }, ['a', 'b']), ['a', 'b']);
  assert.equal(parseMissingPaths({ code: 0, stdout: 'PP_MISSING 0' }, ['a', 'b']), null, 'one path unanswered');
  assert.equal(parseMissingPaths({ code: 3, stdout: '' }, ['a']), null, 'no working tree');
  assert.equal(parseMissingPaths(null, ['a']), null);
});

test('buildTaskFilesCommitScript: message as $1 and paths as "$@", never interpolated; identity and push target', () => {
  const message = `flightdeck: it's "$(rm -rf /)" \`whoami\` $HOME`;
  const paths = ['state/tasks/t1-x/task.json', 'state/tasks/t1-x/handoff.md', 'AGENTS.md'];
  const script = buildTaskFilesCommitScript(paths, message);
  for (const raw of ['rm -rf', 'whoami', '$HOME', ...paths]) assert.ok(!script.includes(raw), `${raw} is not in the script text`);
  assert.deepEqual(decodedArgs(script), [message, ...paths]);
  assert.match(script, /^set -e\ntrap '[^\n]*PP_TASK_COMMIT_DONE[^\n]*' EXIT\ncd '\/srv\/app'\n/);
  assert.match(script, /msg="\$1"; shift\ngit add -A -- "\$@"\n/);
  assert.match(script, /git diff --cached --quiet -- "\$@"/);
  assert.match(script, /git -c user\.email=flightdeck@proxypilot -c user\.name="ProxyPilot Flightdeck" commit -q -m "\$msg" -- "\$@"/);
  assert.match(script, /git push -q origin HEAD:main 2>\/dev\/null \|\| echo PP_PUSH_FAILED >&2\ngit rev-parse HEAD\n$/);
  assert.equal(spawnSync('sh', ['-n', '-c', script]).status, 0, 'valid sh');
});

test('parseCommitOutput / taskFilesCommitMessage', () => {
  assert.deepEqual(parseCommitOutput({ code: 0, stdout: `${SHA}\n`, stderr: 'PP_TASK_COMMIT_DONE 0\n' }), { ok: true, settled: true, committed: true, unchanged: false, commit: SHA, pushFailed: false });
  assert.deepEqual(parseCommitOutput({ code: 0, stdout: `PP_NOCHANGE\n${SHA}`, stderr: 'PP_PUSH_FAILED\nPP_TASK_COMMIT_DONE 0\n' }), { ok: true, settled: true, committed: false, unchanged: true, commit: SHA, pushFailed: true });
  assert.equal(parseCommitOutput({ code: 128, stdout: '', stderr: 'fatal' }).ok, false);
  assert.equal(parseCommitOutput(null).ok, false);
  assert.equal(parseCommitOutput({ code: 0, stdout: SHA, stderr: 'PP_TASK_COMMIT_old 0\n' }, 'PP_TASK_COMMIT_current').settled, false, 'stale or unrelated completion output cannot release this operation');
  assert.throws(() => buildTaskFilesCommitScript(['note'], 'message', 'unsafe;marker'), /acknowledgement/);
  assert.equal(taskFilesCommitMessage([task(1), task(2)]), 'flightdeck: task records (t1-goal-1, t2-goal-2)');
  assert.ok(taskFilesCommitMessage(Array.from({ length: 30 }, (_, i) => task(i + 1))).length <= 200);
});

// ---- writeTaskFilesInContainer ----

function cycleDeps(w) { w.lock = { holder_cycle_id: 9 }; return w.deps; }

test('writeTaskFilesInContainer: the two task files, plus only the MISSING convention files; no commit', async () => {
  const w = fakeWorld({ existing: ['AGENTS.md'] });
  const t = task(12, { key: 't12-add-invoice-export' });
  const r = await writeTaskFilesInContainer({ cycleId: 9, containerName: 'm2-3', task: t, project: w.project, deps: cycleDeps(w) });
  assert.deepEqual(r, { ok: true, paths: ['state/tasks/t12-add-invoice-export/task.json', 'state/tasks/t12-add-invoice-export/handoff.md', 'state/tasks/README.md'], error: null });
  assert.equal(w.writes[0].content, renderTaskJson(t));
  assert.equal(w.writes[1].content, renderTaskHandoffMd(t));
  assert.equal(w.writes[2].content, tasksReadmeMd());
  assert.ok(!w.writes.some((x) => x.path === 'AGENTS.md'), 'an existing AGENTS.md is never overwritten');
  assert.equal(commitScripts(w).length, 0, 'the runner\'s checkpoint commits these');
  assert.ok(w.writes.every((x) => x.containerName === 'm2-3'));
});

test('writeTaskFilesInContainer: ensureConvention false, or an uncertain existence answer, writes no convention file', async () => {
  const w = fakeWorld();
  await writeTaskFilesInContainer({ cycleId: 9, containerName: 'm2-3', task: task(1), project: w.project, ensureConvention: false, deps: cycleDeps(w) });
  assert.deepEqual(w.writes.map((x) => x.path), ['state/tasks/t1-goal-1/task.json', 'state/tasks/t1-goal-1/handoff.md']);
  assert.equal(w.scripts.length, 0);
  const garbled = fakeWorld();
  garbled.deps.containerSh = async () => ({ code: 0, stdout: 'garbage', stderr: '' });
  const warn = mock.method(console, 'warn', () => {});
  const r = await writeTaskFilesInContainer({ cycleId: 9, containerName: 'm2-3', task: task(1), project: garbled.project, deps: cycleDeps(garbled) });
  warn.mock.restore();
  assert.equal(r.ok, true);
  assert.deepEqual(garbled.writes.map((x) => x.path), ['state/tasks/t1-goal-1/task.json', 'state/tasks/t1-goal-1/handoff.md']);
  const both = fakeWorld();
  await writeTaskFilesInContainer({ cycleId: 9, containerName: 'm2-3', task: task(1), project: both.project, deps: cycleDeps(both) });
  assert.deepEqual(both.writes.slice(2).map((x) => [x.path, x.content]), [['AGENTS.md', agentsMd(both.project)], ['state/tasks/README.md', tasksReadmeMd()]]);
});

test('writeTaskFilesInContainer: invalid key, no container, a failed write, throwing deps → {ok:false}, never throws', async () => {
  const w = fakeWorld();
  assert.deepEqual(await writeTaskFilesInContainer({ cycleId: 9, containerName: 'm2-3', task: task(1, { key: null }), project: w.project, deps: cycleDeps(w) }), { ok: false, paths: [], error: 'invalid task key' });
  assert.deepEqual(await writeTaskFilesInContainer({ cycleId: 9, containerName: 'm2-3', task: task(1, { key: '../../etc' }), deps: cycleDeps(w) }), { ok: false, paths: [], error: 'invalid task key' });
  assert.deepEqual(await writeTaskFilesInContainer({ cycleId: 9, containerName: '', task: task(1), deps: cycleDeps(w) }), { ok: false, paths: [], error: 'no container' });
  assert.equal(w.writes.length, 0);
  const warn = mock.method(console, 'warn', () => {});
  const failing = fakeWorld({ onWrite: (_w, path) => (path.endsWith('handoff.md') ? { ok: false, error: 'disk full' } : null) });
  const r = await writeTaskFilesInContainer({ cycleId: 9, containerName: 'm2-3', task: task(1), project: failing.project, deps: cycleDeps(failing) });
  assert.equal(r.ok, false);
  assert.deepEqual(r.paths, ['state/tasks/t1-goal-1/task.json']);
  assert.match(r.error, /handoff\.md: disk full/);
  const throwing = fakeWorld();
  throwing.deps.writeFileInContainer = async () => { throw new Error('incus gone'); };
  assert.deepEqual(await writeTaskFilesInContainer({ cycleId: 9, containerName: 'm2-3', task: task(1), deps: cycleDeps(throwing) }), { ok: false, paths: [], error: 'incus gone', uncertain: true });
  assert.equal(throwing.lock.holder_cycle_id, 9, 'uncertain reservation stays attached to its genuine cycle owner');
  assert.equal(throwing.lock.holder_operation_state, 'uncertain');
  assert.deepEqual(throwing.leases, ['acquired', 'uncertain']);
  assert.equal(failing.lock.holder_cycle_id, 9, 'confirmed refusal preserves the original cycle lock');
  assert.equal(failing.lock.holder_operation_id, undefined);
  assert.deepEqual(failing.leases, ['acquired', 'settled']);
  warn.mock.restore();
  assert.equal(warn.mock.callCount() >= 2, true, 'failures are logged');
});

// ---- syncTaskFilesNow ----

test('syncTaskFilesNow: not idle → nothing touched, the reason reported', async () => {
  const cases = [
    [{ project: { id: 3, lifecycle: 'stopped' } }, 'not_active'],
    [{ lock: { holder_user_id: 1 } }, 'locked'],
    [{ lock: { holder_cycle_id: 5 } }, 'locked'],
    [{ cycle: { status: 'running' } }, 'cycle_running'],
    [{ cycle: { status: 'queued' } }, 'cycle_running'],
    [{ askJob: { phase: 'tools' } }, 'ask_running'],
    [{ project: null }, 'no_project'],
  ];
  for (const [opts, reason] of cases) {
    const w = fakeWorld({ tasks: [task(1)], ...opts });
    assert.deepEqual(await syncTaskFilesNow(3, { deps: w.deps }), { ok: false, written: [], skipped: reason }, reason);
    assert.equal(w.writes.length + w.scripts.length + w.marks.length, 0, reason);
  }
  assert.deepEqual(await syncTaskFilesNow('nope'), { ok: false, written: [], skipped: 'no_project' });
});

test('syncTaskFilesNow: idle → writes the due tasks (newest 5) + missing convention files, commits EXACTLY those paths, marks revisions', async () => {
  const tasks = [task(1, { revision: 4, filesRevision: 4 }), ...Array.from({ length: 6 }, (_, i) => task(10 + i, { revision: 3 + i, updatedAt: iso(10 - i) }))];
  const w = fakeWorld({ tasks, existing: ['state/tasks/README.md'], project: { id: 3, name: 'Demo', lifecycle: 'active', container_name: 'custom-ct' } });
  const r = await syncTaskFilesNow(3, { deps: w.deps });
  const due = [15, 14, 13, 12, 11];
  const expectPaths = [...due.flatMap((id) => [`state/tasks/t${id}-goal-${id}/task.json`, `state/tasks/t${id}-goal-${id}/handoff.md`]), 'AGENTS.md'];
  assert.deepEqual(r, { ok: true, written: expectPaths, skipped: null });
  assert.deepEqual(w.writes.map((x) => x.path), expectPaths);
  assert.ok(w.writes.every((x) => x.containerName === 'custom-ct'), 'project.container_name wins');
  const commits = commitScripts(w);
  assert.equal(commits.length, 1);
  const [msg, ...paths] = decodedArgs(commits[0].script);
  assert.deepEqual(paths, expectPaths, 'path-scoped to exactly the written paths');
  assert.equal(msg, 'flightdeck: task records (t15-goal-15, t14-goal-14, t13-goal-13, t12-goal-12, t11-goal-11)');
  assert.deepEqual(w.marks, due.map((id) => [id, tasks.find((t) => t.id === id).revision]));
  // Container name falls back to containerNameForProject.
  const w2 = fakeWorld({ tasks: [task(1)] });
  await syncTaskFilesNow(3, { deps: w2.deps });
  assert.ok(w2.writes.every((x) => x.containerName === 'm2-3'));
});

test('syncTaskFilesNow: nothing due → no container call at all', async () => {
  const w = fakeWorld({ tasks: [task(1, { revision: 2, filesRevision: 2 })] });
  assert.deepEqual(await syncTaskFilesNow(3, { deps: w.deps }), { ok: true, written: [], skipped: 'nothing_to_write' });
  assert.equal(w.scripts.length + w.writes.length, 0);
});

test('syncTaskFilesNow: idle is re-checked right before committing — a build that took the checkout meanwhile blocks the commit', async () => {
  const w = fakeWorld({ tasks: [task(1)], existing: ['AGENTS.md', 'state/tasks/README.md'], onWrite: (world) => { world.lock = { holder_cycle_id: 77 }; return null; } });
  const r = await syncTaskFilesNow(3, { deps: w.deps });
  assert.deepEqual(r, { ok: false, written: ['state/tasks/t1-goal-1/task.json', 'state/tasks/t1-goal-1/handoff.md'], skipped: 'locked' });
  assert.equal(commitScripts(w).length, 0, 'never commits under a build');
  assert.deepEqual(w.marks, [], 'not mirrored until committed');
});

test('syncTaskFilesNow: a failed write or commit marks nothing; a failed push still counts as committed', async () => {
  const warn = mock.method(console, 'warn', () => {});
  const wf = fakeWorld({ tasks: [task(1)], onWrite: () => ({ ok: false, error: 'read-only fs' }) });
  assert.deepEqual(await syncTaskFilesNow(3, { deps: wf.deps }), { ok: false, written: [], skipped: 'write_failed' });
  assert.equal(commitScripts(wf).length, 0);
  const wc = fakeWorld({ tasks: [task(1)], existing: ['AGENTS.md', 'state/tasks/README.md'], commit: { code: 128, stdout: '', stderr: 'fatal: not a git repository\nPP_TASK_COMMIT_DONE 128\n' } });
  const rc = await syncTaskFilesNow(3, { deps: wc.deps });
  assert.equal(rc.skipped, 'commit_failed');
  assert.deepEqual(wc.marks, []);
  const wp = fakeWorld({ tasks: [task(1)], existing: ['AGENTS.md', 'state/tasks/README.md'], commit: { code: 0, stdout: SHA, stderr: 'PP_PUSH_FAILED\nPP_TASK_COMMIT_DONE 0\n' } });
  assert.equal((await syncTaskFilesNow(3, { deps: wp.deps })).ok, true);
  assert.deepEqual(wp.marks, [[1, 2]]);
  warn.mock.restore();
});

test('syncTaskFilesNow: throwing dependencies → skipped "error", never throws; runs are serialised per project', async () => {
  const warn = mock.method(console, 'warn', () => {});
  const w = fakeWorld({ tasks: [task(1)] });
  w.deps.getLock = () => { throw new Error('no such table: mock2_locks'); };
  assert.deepEqual(await syncTaskFilesNow(3, { deps: w.deps }), { ok: false, written: [], skipped: 'error' });
  warn.mock.restore();
  // Two overlapping runs: the second starts only after the first finished.
  const order = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const slow = fakeWorld({ tasks: [task(1)], existing: ['AGENTS.md', 'state/tasks/README.md'] });
  const origWrite = slow.deps.writeFileInContainer;
  slow.deps.writeFileInContainer = async (...a) => { order.push(`write:${a[1]}`); await gate; return origWrite(...a); };
  slow.deps.listTasks = () => { order.push('list'); return slow.tasks; };
  const p1 = syncTaskFilesNow(3, { deps: slow.deps });
  const p2 = syncTaskFilesNow(3, { deps: slow.deps });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(order, ['list', 'write:state/tasks/t1-goal-1/task.json'], 'the second run has not started');
  release();
  await Promise.all([p1, p2]);
  assert.equal(order.filter((x) => x === 'list').length, 2);
});

test('FD0130 idle lease spans remote dispatch through acknowledgement; uncertainty retains its fence', async () => {
  const warn = mock.method(console, 'warn', () => {});
  try {
    for (const mode of ['ack', 'missing-ack', 'throw', 'confirmed-failure']) {
      const w = fakeWorld({ tasks: [task(1)], existing: ['AGENTS.md', 'state/tasks/README.md'] });
      let dispatch;
      const dispatched = new Promise((resolve) => { dispatch = resolve; });
      let finish;
      const gate = new Promise((resolve) => { finish = resolve; });
      const transport = w.deps.containerSh;
      w.deps.containerSh = async (...args) => {
        if (!args[1].includes('git add -A')) return transport(...args);
        assert.equal(w.lock?.holder_operation_state, 'active');
        dispatch(); await gate;
        if (mode === 'throw') throw new Error('transport disconnected');
        if (mode === 'missing-ack') return { code: 0, stdout: SHA, stderr: '' };
        if (mode === 'confirmed-failure') return { code: 128, stdout: '', stderr: `${args[1].match(/printf \"(PP_TASK_COMMIT_[A-Za-z0-9_]+) %s/)[1]} 128\n` };
        return transport(...args);
      };
      const pending = syncTaskFilesNow(3, { deps: w.deps });
      await dispatched;
      assert.deepEqual(w.leases, ['acquired'], 'never released while remote commit is in flight');
      assert.equal(w.deps.acquireTaskContinuityLease(3).ok, false, 'another checkout owner cannot acquire during dispatch');
      finish();
      const result = await pending;
      if (mode === 'ack' || mode === 'confirmed-failure') {
        assert.deepEqual(w.leases, ['acquired', 'settled']); assert.equal(w.lock, null);
      } else {
        assert.deepEqual(w.leases, ['acquired', 'uncertain']);
        assert.equal(w.lock.holder_operation_state, 'uncertain');
        assert.equal(w.deps.acquireTaskContinuityLease(3).ok, false, 'unknown outcome must remain fenced');
      }
      assert.equal(result.ok, mode === 'ack');
      assert.deepEqual(w.marks, mode === 'ack' ? [[1, 2]] : []);
    }
  } finally { warn.mock.restore(); }
});

test('FD0130 idle lease releases on a confirmed writer refusal; unknown write and thrown write retain it', async () => {
  const warn = mock.method(console, 'warn', () => {});
  try {
    for (const mode of ['refused', 'unknown', 'throw']) {
      const w = fakeWorld({ tasks: [task(1)] });
      w.deps.writeFileInContainer = async () => {
        assert.equal(w.lock?.holder_operation_state, 'active');
        if (mode === 'throw') throw new Error('disconnected');
        return { ok: false, settled: mode === 'refused', error: mode === 'refused' ? 'python3_required' : 'task_record_outcome_unknown' };
      };
      assert.equal((await syncTaskFilesNow(3, { deps: w.deps })).ok, false);
      assert.deepEqual(w.leases, ['acquired', mode === 'refused' ? 'settled' : 'uncertain']);
      assert.equal(commitScripts(w).length, 0);
    }
  } finally { warn.mock.restore(); }
});

// ---- debounce / backoff ----

async function flush() {
  for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r));
}

test('scheduleTaskFilesSync: debounced per project — a burst of transitions is one run', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const w = fakeWorld({ tasks: [task(1)], existing: ['AGENTS.md', 'state/tasks/README.md'] });
    let runs = 0;
    const list = w.deps.listTasks;
    w.deps.listTasks = (...a) => { runs += 1; return list(...a); };
    _setTaskFilesDepsForTests(w.deps);
    scheduleTaskFilesSync(3);
    mock.timers.tick(2000);
    scheduleTaskFilesSync(3);
    mock.timers.tick(2000);
    await flush();
    assert.equal(runs, 0, 'the second call pushed the run back');
    mock.timers.tick(1000);
    await flush();
    assert.equal(runs, 1);
    assert.equal(commitScripts(w).length, 1);
    assert.deepEqual(_pendingTaskFilesSyncsForTests(), [], 'done — nothing left armed');
  } finally {
    mock.timers.reset();
  }
});

test('scheduleTaskFilesSync: busy → retried after 5s, 15s, 1 min, 5 min, then gives up; becoming idle stops the retries', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const warn = mock.method(console, 'warn', () => {});
  try {
    const w = fakeWorld({ tasks: [task(1)], lock: { holder_user_id: 2 }, existing: ['AGENTS.md', 'state/tasks/README.md'] });
    let runs = 0;
    const getLock = w.deps.getLock;
    w.deps.getLock = (...a) => { runs += 1; return getLock(...a); };
    _setTaskFilesDepsForTests(w.deps);
    scheduleTaskFilesSync(3, { delayMs: 3000 });
    mock.timers.tick(3000); await flush();
    assert.equal(runs, 1);
    for (const [i, wait] of TASK_FILES_RETRY_MS.entries()) {
      assert.deepEqual(_pendingTaskFilesSyncsForTests(), [{ projectId: 3, attempt: i + 1, armed: true }]);
      mock.timers.tick(wait - 1); await flush();
      assert.equal(runs, i + 1, `not before ${wait}ms`);
      mock.timers.tick(1); await flush();
      assert.equal(runs, i + 2, `retry ${i + 1} after ${wait}ms`);
    }
    assert.deepEqual(_pendingTaskFilesSyncsForTests(), [], 'gave up after the last retry');
    assert.ok(warn.mock.calls.some((c) => /giving up until the next task change/.test(c.arguments[0])));
    mock.timers.tick(3_600_000); await flush();
    assert.equal(runs, 5, 'nothing more until the next transition');
    assert.equal(commitScripts(w).length, 0);

    // The next transition starts over; the project is idle by the 2nd retry.
    scheduleTaskFilesSync(3, { delayMs: 3000 });
    mock.timers.tick(3000); await flush();
    mock.timers.tick(5000); await flush();
    w.lock = null;
    mock.timers.tick(15000); await flush();
    assert.equal(commitScripts(w).length, 1);
    assert.deepEqual(_pendingTaskFilesSyncsForTests(), []);
  } finally {
    warn.mock.restore();
    mock.timers.reset();
  }
});

test('scheduleTaskFilesSync: a new transition during a backoff wait resets the backoff; bad ids and broken deps never throw', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const warn = mock.method(console, 'warn', () => {});
  try {
    const w = fakeWorld({ tasks: [task(1)], cycle: { status: 'running' } });
    _setTaskFilesDepsForTests(w.deps);
    scheduleTaskFilesSync(3, { delayMs: 0 });
    mock.timers.tick(0); await flush();
    mock.timers.tick(5000); await flush();
    assert.equal(_pendingTaskFilesSyncsForTests()[0].attempt, 2);
    scheduleTaskFilesSync(3, { delayMs: 10 });
    assert.deepEqual(_pendingTaskFilesSyncsForTests(), [{ projectId: 3, attempt: 0, armed: true }]);
    assert.doesNotThrow(() => scheduleTaskFilesSync(null));
    assert.doesNotThrow(() => scheduleTaskFilesSync('abc'));
    assert.doesNotThrow(() => scheduleTaskFilesSync(-1));
    w.deps.getProject = () => { throw new Error('db closed'); };
    mock.timers.tick(10); await flush();
    assert.equal(_pendingTaskFilesSyncsForTests()[0].attempt, 1, 'an error is retried like busy');
  } finally {
    warn.mock.restore();
    mock.timers.reset();
  }
});

// ---- against a real checkout ----

function gitWorld() {
  const root = mkdtempSync(join(tmpdir(), 'pp-task-files-'));
  const bare = join(root, 'repo.git');
  const app = join(root, 'app');
  const env = { ...process.env, HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
  const git = (cwd, ...args) => {
    const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.replace(/\n$/, '');
  };
  git(root, 'init', '-q', '--bare', '-b', 'main', bare);
  git(root, 'clone', '-q', bare, app);
  writeFileSync(join(app, 'README.md'), 'app\n');
  writeFileSync(join(app, 'src.js'), 'v1\n');
  git(app, 'add', '-A');
  git(app, '-c', 'user.name=Dev', '-c', 'user.email=dev@example', 'commit', '-q', '-m', 'init');
  git(app, 'push', '-q', 'origin', 'HEAD:main');
  const w = fakeWorld({ tasks: [task(1, { key: 't1-add-export', goal: 'Add export' })] });
  w.deps.writeFileInContainer = async (_c, path, content) => {
    w.writes.push({ path, content });
    mkdirSync(dirname(join(app, path)), { recursive: true });
    writeFileSync(join(app, path), content);
    return { ok: true };
  };
  w.deps.containerSh = async (_c, script) => {
    w.scripts.push({ script });
    const r = spawnSync('sh', ['-c', script.replaceAll(`cd '/srv/app'`, `cd '${app}'`)], { env, encoding: 'utf8' });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  return { root, app, bare, git, w, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const hasGit = spawnSync('git', ['--version']).status === 0;

test('real git: the commit carries exactly the task and missing convention files, leaves other work alone, and pushes to origin main', { skip: !hasGit }, async () => {
  const g = gitWorld();
  try {
    // Someone's unrelated work in the checkout: a modified tracked file and a staged new file.
    writeFileSync(join(g.app, 'src.js'), 'v2 (unsaved work)\n');
    writeFileSync(join(g.app, 'staged.txt'), 'staged by a person\n');
    g.git(g.app, 'add', 'staged.txt');
    // An operator-written AGENTS.md exists already (untracked) and must survive.
    writeFileSync(join(g.app, 'AGENTS.md'), '# my own agents file\n');
    const r = await syncTaskFilesNow(3, { deps: g.w.deps });
    assert.deepEqual(r, { ok: true, written: ['state/tasks/t1-add-export/task.json', 'state/tasks/t1-add-export/handoff.md', 'state/tasks/README.md'], skipped: null });
    assert.equal(readFileSync(join(g.app, 'AGENTS.md'), 'utf8'), '# my own agents file\n');
    const files = g.git(g.app, 'show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean).sort();
    assert.deepEqual(files, ['state/tasks/README.md', 'state/tasks/t1-add-export/handoff.md', 'state/tasks/t1-add-export/task.json']);
    assert.equal(g.git(g.app, 'log', '-1', '--format=%an <%ae>|%s'), 'ProxyPilot Flightdeck <flightdeck@proxypilot>|flightdeck: task records (t1-add-export)');
    assert.equal(g.git(g.bare, 'rev-parse', 'main'), g.git(g.app, 'rev-parse', 'HEAD'), 'pushed like the checkpoint: origin HEAD:main');
    const status = g.git(g.app, 'status', '--porcelain').split('\n').filter(Boolean).sort();
    assert.deepEqual(status, [' M src.js', '?? AGENTS.md', 'A  staged.txt'], 'the person\'s work is untouched and uncommitted');
    assert.equal(JSON.parse(readFileSync(join(g.app, 'state/tasks/t1-add-export/task.json'), 'utf8')).taskId, 't1-add-export');
    assert.deepEqual(g.w.marks, [[1, 2]]);
    // Same content again → nothing to commit, still mirrored.
    g.w.tasks = [{ ...g.w.tasks[0], filesRevision: 1 }];
    const head = g.git(g.app, 'rev-parse', 'HEAD');
    assert.equal((await syncTaskFilesNow(3, { deps: g.w.deps })).ok, true);
    assert.equal(g.git(g.app, 'rev-parse', 'HEAD'), head, 'no empty commit');
  } finally {
    g.cleanup();
  }
});

test('real shell: the existence check decodes odd paths in-shell; the commit message is taken literally', { skip: !hasGit }, async () => {
  const g = gitWorld();
  try {
    const odd = `odd dir/it's "$(touch pwned)" \`x\`.md`;
    mkdirSync(join(g.app, 'odd dir'), { recursive: true });
    writeFileSync(join(g.app, odd), 'x');
    const r = await g.w.deps.containerSh('ct', buildPathsExistScript(['AGENTS.md', odd, 'state/none.md']));
    assert.deepEqual(parseMissingPaths(r, ['AGENTS.md', odd, 'state/none.md']), ['AGENTS.md', 'state/none.md']);
    assert.equal(existsSync(join(g.app, 'pwned')), false, 'nothing in a path was executed');
    writeFileSync(join(g.app, 'note.md'), 'n\n');
    const message = `msg with "$(touch pwned2)" and \`id\` and $HOME`;
    const c = parseCommitOutput(await g.w.deps.containerSh('ct', buildTaskFilesCommitScript(['note.md', odd], message)));
    assert.equal(c.ok && c.committed, true);
    assert.equal(g.git(g.app, 'log', '-1', '--format=%s'), message);
    assert.equal(existsSync(join(g.app, 'pwned2')), false);
  } finally {
    g.cleanup();
  }
});
