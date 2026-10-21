// Mock2 task store (tasks.js) over migration 562 — the schema, the key stamped
// in the create transaction, one task per request, revision/updated_at/
// finished_at bookkeeping, ignored unknown patch keys, and the files_revision
// mark. ./db.js is stubbed at the module boundary (node:sqlite stands in for
// better-sqlite3), so this never opens the real mock2.db.

import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { MOCK2_MIGRATIONS } from '../mock2/migrations.js';
import { makeTaskKey, isValidTaskKey } from '../mock2/task-logic.js';

const fixture = { db: null };
globalThis.__mock2TasksStoreFixture = fixture;
const storeUrl = new URL('../mock2/tasks.js', import.meta.url).href;
const hook = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL === storeUrl && specifier === './db.js') {
      return { url: `data:text/javascript,${encodeURIComponent('export const getMock2Db = () => globalThis.__mock2TasksStoreFixture.db;')}`, shortCircuit: true };
    }
    return next(specifier, context);
  },
});
const store = await import(storeUrl);
hook.deregister();

const m562 = MOCK2_MIGRATIONS.find((m) => m.version === 562);

// better-sqlite3's surface the store uses: prepare / exec / transaction.
function freshDb() {
  const db = new DatabaseSync(':memory:');
  const transaction = (fn) => (...args) => {
    db.exec('BEGIN');
    try { const v = fn(...args); db.exec('COMMIT'); return v; } catch (e) { db.exec('ROLLBACK'); throw e; }
  };
  const adapter = { prepare: (sql) => db.prepare(sql), exec: (sql) => db.exec(sql), transaction, raw: db };
  m562.up(adapter);
  fixture.db = adapter;
  return adapter;
}

const col = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => `${c.name} ${c.type}${c.notnull ? ' NOT NULL' : ''}${c.dflt_value != null ? ` DEFAULT ${c.dflt_value}` : ''}${c.pk ? ' PK' : ''}`);

test('migration 562 is the newest mock2 migration and creates mock2_tasks exactly as specified; re-running is harmless', () => {
  assert.ok(m562, 'registered');
  assert.equal(m562.name, 'mock2_tasks');
  assert.equal(MOCK2_MIGRATIONS.at(-1).version, 562);
  const versions = MOCK2_MIGRATIONS.map((m) => m.version);
  assert.equal(new Set(versions).size, versions.length, 'no duplicate version');
  const db = freshDb();
  assert.deepEqual(col(db, 'mock2_tasks'), [
    'id INTEGER PK', 'project_id INTEGER NOT NULL', 'task_key TEXT', 'intent TEXT NOT NULL', 'status TEXT NOT NULL', 'goal TEXT NOT NULL',
    'request_id INTEGER', 'last_cycle_id INTEGER', 'authorized_by INTEGER', 'authorized_at TEXT', 'folder TEXT', 'branch TEXT',
    'last_verified_step TEXT', 'next_step TEXT', 'completed_steps_json TEXT', 'checks_json TEXT', 'blockers_json TEXT',
    'remaining_json TEXT', 'uncertain_json TEXT', 'context_json TEXT', 'revision INTEGER NOT NULL DEFAULT 1',
    'files_revision INTEGER NOT NULL DEFAULT 0', 'created_at TEXT NOT NULL', 'updated_at TEXT NOT NULL', 'finished_at TEXT',
  ]);
  const idx = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='mock2_tasks' AND sql IS NOT NULL ORDER BY name").all();
  assert.deepEqual(idx.map((r) => r.name), ['idx_mock2_tasks_project', 'idx_mock2_tasks_request']);
  assert.match(idx[1].sql, /UNIQUE INDEX .* ON mock2_tasks\(request_id\) WHERE request_id IS NOT NULL/);
  m562.up(db);
  const src = MOCK2_MIGRATIONS.find((m) => m.version === 562).up.toString();
  assert.match(src, /CREATE TABLE IF NOT EXISTS mock2_tasks/, 'the DDL is written out in the migration');
});

test('createTask: inserts, stamps task_key = makeTaskKey(id, goal) in the same transaction, sanitizes the goal', () => {
  freshDb();
  const t = store.createTask({ projectId: 3, intent: 'build', goal: '  Add invoice export\nwith CSV  ', requestId: 34, authorizedBy: 7 });
  assert.equal(t.key, makeTaskKey(t.id, 'Add invoice export with CSV'));
  assert.ok(isValidTaskKey(t.key));
  assert.equal(t.goal, 'Add invoice export with CSV');
  assert.equal(t.status, 'active');
  assert.equal(t.intent, 'build');
  assert.equal(t.requestId, 34);
  assert.equal(t.authorizedBy, 7);
  assert.match(t.authorizedAt, /^\d{4}-\d\d-\d\dT/);
  assert.equal(t.folder, '/srv/app');
  assert.equal(t.revision, 1);
  assert.equal(t.filesRevision, 0);
  assert.equal(t.finishedAt, null);
  assert.deepEqual([t.completedSteps, t.checks, t.blockers, t.remaining, t.uncertain], [[], [], [], [], []]);
  const secret = store.createTask({ projectId: 3, intent: 'investigation', goal: 'Why does password=hunter2 fail?', context: { answerExcerpt: 'x' } });
  assert.doesNotMatch(secret.goal + secret.key, /hunter2/);
  assert.deepEqual(secret.context, { answerExcerpt: 'x' });
  assert.equal(store.createTask({ projectId: 3, intent: 'investigation', goal: '' }).goal, 'Untitled task');
  const stopped = store.createTask({ projectId: 3, intent: 'build', goal: 'x', status: 'stopped' });
  assert.ok(stopped.finishedAt);
  assert.throws(() => store.createTask({ projectId: 3, intent: 'deploy', goal: 'x' }), /invalid task intent/);
  assert.throws(() => store.createTask({ projectId: 3, intent: 'build', goal: 'x', status: 'running' }), /invalid task status/);
  assert.throws(() => store.createTask({ intent: 'build', goal: 'x' }), /project id/);
});

test('createTask: one build task per request — a second create returns the existing task', () => {
  freshDb();
  const a = store.createTask({ projectId: 3, intent: 'build', goal: 'First', requestId: 9 });
  const b = store.createTask({ projectId: 3, intent: 'build', goal: 'Second', requestId: 9 });
  assert.equal(b.id, a.id);
  assert.equal(b.goal, 'First');
  assert.equal(store.getTaskForRequest(9).id, a.id);
  assert.equal(store.getTaskForRequest(null), null);
  assert.equal(store.getTaskForRequest(404), null);
  // Tasks without a request never collide.
  assert.notEqual(store.createTask({ projectId: 3, intent: 'investigation', goal: 'q' }).id, store.createTask({ projectId: 3, intent: 'investigation', goal: 'q' }).id);
});

test('getTask / getTaskByKey: hydrated, scoped to the project, invalid keys never queried', () => {
  freshDb();
  const t = store.createTask({ projectId: 3, intent: 'build', goal: 'Add export' });
  assert.equal(store.getTask(t.id).key, t.key);
  assert.equal(store.getTask(999), null);
  assert.equal(store.getTaskByKey(3, t.key).id, t.id);
  assert.equal(store.getTaskByKey(4, t.key), null, 'another project');
  assert.equal(store.getTaskByKey(3, "x' OR 1=1 --"), null);
  assert.equal(store.getTaskByKey(3, null), null);
});

test('updateTask: bumps revision + updated_at, serialises lists, ignores unknown keys, stamps/clears finished_at', async () => {
  const db = freshDb();
  const t = store.createTask({ projectId: 3, intent: 'build', goal: 'Add export', requestId: 1 });
  db.prepare('UPDATE mock2_tasks SET updated_at = ? WHERE id = ?').run('2026-01-01T00:00:00.000Z', t.id);
  const u = store.updateTask(t.id, {
    status: 'interrupted', lastCycleId: 88, lastVerifiedStep: 'Checkpoint abc', nextStep: 'Resume',
    completedSteps: [{ step: 'Build started', at: 'A' }], checks: [{ key: 'lint', status: 'passed' }],
    blockers: ['b'], remaining: ['r1', 'r2'], uncertain: ['Check whether x completed before repeating it'],
    context: { answerExcerpt: 'e' }, branch: 'main',
    // never writable through a patch:
    taskKey: 'evil', key: 'evil', revision: 99, authorizedBy: 1, projectId: 9, intent: 'investigation', filesRevision: 50, goal: 'changed',
  });
  assert.equal(u.revision, 2);
  assert.notEqual(u.updatedAt, '2026-01-01T00:00:00.000Z');
  assert.equal(u.status, 'interrupted');
  assert.equal(u.lastCycleId, 88);
  assert.equal(u.lastVerifiedStep, 'Checkpoint abc');
  assert.deepEqual(u.completedSteps, [{ step: 'Build started', at: 'A' }]);
  assert.deepEqual(u.checks, [{ key: 'lint', status: 'passed' }]);
  assert.deepEqual(u.remaining, ['r1', 'r2']);
  assert.deepEqual(u.context, { answerExcerpt: 'e' });
  assert.equal(u.branch, 'main');
  assert.deepEqual([u.key, u.intent, u.goal, u.projectId, u.authorizedBy, u.filesRevision], [t.key, 'build', 'Add export', 3, null, 0], 'unknown keys ignored');
  assert.equal(u.finishedAt, null);
  const done = store.updateTask(t.id, { status: 'completed' });
  assert.ok(done.finishedAt, 'completed stamps finished_at');
  assert.equal(done.revision, 3);
  assert.equal(store.updateTask(t.id, { status: 'stopped' }).finishedAt != null, true);
  assert.equal(store.updateTask(t.id, { status: 'active' }).finishedAt, null, 'an unfinished status clears it');
  // Nothing writable → no bump; an unknown status is ignored.
  const before = store.getTask(t.id).revision;
  assert.equal(store.updateTask(t.id, { nope: 1 }).revision, before);
  const origWarn = console.warn; console.warn = () => {};
  try { assert.equal(store.updateTask(t.id, { status: 'running' }).status, 'active'); } finally { console.warn = origWarn; }
  assert.equal(store.getTask(t.id).revision, before);
  // Text is redacted and lists bounded on the way in; null clears a text field.
  const r = store.updateTask(t.id, { nextStep: 'use token=abc123', uncertain: Array.from({ length: 20 }, (_, i) => `u${i}`), blockers: 'not a list' });
  assert.doesNotMatch(r.nextStep, /abc123/);
  assert.equal(r.uncertain.length, 8);
  assert.deepEqual(r.blockers, []);
  assert.equal(store.updateTask(t.id, { nextStep: null }).nextStep, null);
  assert.equal(store.updateTask(12345, { status: 'active' }), null);
});

test('recordTaskStep: appends (max 30, newest last), a verified step becomes the last verified step', () => {
  freshDb();
  const t = store.createTask({ projectId: 3, intent: 'build', goal: 'x' });
  let cur = store.recordTaskStep(t.id, 'Build started', { at: '2026-10-21T10:00:00.000Z' });
  assert.deepEqual(cur.completedSteps, [{ step: 'Build started', at: '2026-10-21T10:00:00.000Z' }]);
  assert.equal(cur.lastVerifiedStep, null);
  assert.equal(cur.revision, 2);
  cur = store.recordTaskStep(t.id, 'Checkpoint 1a2b3c4 committed', { verified: true });
  assert.equal(cur.lastVerifiedStep, 'Checkpoint 1a2b3c4 committed');
  assert.match(cur.completedSteps.at(-1).at, /^\d{4}-/);
  for (let i = 0; i < 40; i += 1) store.recordTaskStep(t.id, `s${i}`);
  cur = store.getTask(t.id);
  assert.equal(cur.completedSteps.length, 30);
  assert.equal(cur.completedSteps.at(-1).step, 's39');
  const rev = cur.revision;
  assert.equal(store.recordTaskStep(t.id, '   ').revision, rev, 'an empty step changes nothing');
  assert.equal(store.recordTaskStep(999, 'x'), null);
});

test('listTasks (newest updated first, unfinishedOnly, limit) and listTasksByStatus (all projects)', () => {
  const db = freshDb();
  const mk = (pid, goal, status, at) => {
    const t = store.createTask({ projectId: pid, intent: 'build', goal, status });
    db.prepare('UPDATE mock2_tasks SET updated_at = ? WHERE id = ?').run(at, t.id);
    return t;
  };
  const a = mk(3, 'a', 'active', '2026-10-21T10:00:00.000Z');
  const b = mk(3, 'b', 'completed', '2026-10-21T12:00:00.000Z');
  const c = mk(3, 'c', 'interrupted', '2026-10-21T11:00:00.000Z');
  const d = mk(4, 'd', 'active', '2026-10-21T09:00:00.000Z');
  const e = mk(3, 'e', 'blocked', '2026-10-21T11:00:00.000Z'); // tie with c → higher id first
  assert.deepEqual(store.listTasks(3).map((t) => t.goal), ['b', 'e', 'c', 'a']);
  assert.deepEqual(store.listTasks(3, { unfinishedOnly: true }).map((t) => t.goal), ['e', 'c', 'a']);
  assert.deepEqual(store.listTasks(3, { limit: 2 }).map((t) => t.goal), ['b', 'e']);
  assert.deepEqual(store.listTasks(99), []);
  assert.deepEqual(store.listTasksByStatus(['active']).map((t) => t.id), [a.id, d.id]);
  assert.deepEqual(store.listTasksByStatus('interrupted').map((t) => t.id), [c.id]);
  assert.deepEqual(store.listTasksByStatus(['bogus']), []);
  assert.deepEqual(store.listTasksByStatus([]), []);
  assert.ok(b && e);
});

test('markFilesRevision: forward only, not itself a change; deleteTasksForProject', () => {
  freshDb();
  const t = store.createTask({ projectId: 3, intent: 'build', goal: 'x' });
  store.updateTask(t.id, { nextStep: 'n' });
  assert.equal(store.markFilesRevision(t.id, 2), true);
  const after = store.getTask(t.id);
  assert.equal(after.filesRevision, 2);
  assert.equal(after.revision, 2, 'no revision bump');
  assert.equal(store.markFilesRevision(t.id, 1), false, 'never moves back');
  assert.equal(store.markFilesRevision(t.id, 'x'), false);
  store.createTask({ projectId: 3, intent: 'investigation', goal: 'q' });
  store.createTask({ projectId: 4, intent: 'investigation', goal: 'q' });
  assert.equal(store.deleteTasksForProject(3), 2);
  assert.deepEqual(store.listTasks(3), []);
  assert.equal(store.listTasks(4).length, 1);
});
