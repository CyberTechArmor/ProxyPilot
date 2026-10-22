// Actual locks.js against real SQLite. Only native DB/settings imports are
// substituted; production admission, SQL, transactions and token CAS run intact.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MOCK2_MIGRATIONS } from '../mock2/migrations.js';
import { lockHolder, publicLockShape, isLockExpired, shouldAutoRelease } from '../mock2/lock-logic.js';

function adapter(db) {
  const transaction = fn => {
    const immediate = (...args) => {
      db.exec('BEGIN IMMEDIATE');
      try { const result = fn(...args); db.exec('COMMIT'); return result; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    };
    immediate.immediate = immediate; return immediate;
  };
  return { prepare: sql => db.prepare(sql), exec: sql => db.exec(sql), transaction };
}
async function actualLocks(db) {
  const key = `checkout_test_${randomUUID()}`;
  globalThis[key] = adapter(db);
  let source = readFileSync(new URL('../mock2/locks.js', import.meta.url), 'utf8');
  assert.ok(source.includes("import { getMock2Db } from './db.js';"));
  source = source.replace("import { getMock2Db } from './db.js';", `const getMock2Db = () => globalThis[${JSON.stringify(key)}];`)
    .replace("import { getMock2Setting } from './settings.js';", 'const getMock2Setting = (_key, fallback) => fallback;')
    .replace("from './lock-logic.js'", `from ${JSON.stringify(new URL('../mock2/lock-logic.js', import.meta.url).href)}`);
  const module = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  return { module, close: () => delete globalThis[key] };
}
async function world(t) {
  const folder = mkdtempSync(join(tmpdir(), 'mock2-checkout-operation-')), path = join(folder, 'mock2.db');
  const db = new DatabaseSync(path); db.exec('PRAGMA journal_mode=WAL');
  MOCK2_MIGRATIONS.find(m => m.version === 500).up(db);
  db.prepare('INSERT INTO mock2_locks(project_id,holder_user_id,acquired_at,last_write_at) VALUES(?,?,?,?)').run(9, 'existing-owner', '2026-01-01', '2026-01-01');
  const migration = MOCK2_MIGRATIONS.find(m => m.version === 563); assert.ok(migration);
  migration.up(db); migration.up(db); // repeat-safe and preserves old locks
  const second = new DatabaseSync(path), first = await actualLocks(db), other = await actualLocks(second);
  t.after(() => { first.close(); other.close(); db.close(); second.close(); rmSync(folder, { recursive: true, force: true }); });
  return { path, db, second, a: first.module, b: other.module };
}

test('FD0130 checkout operation is a genuine persistent holder and excludes competing writers atomically', async t => {
  const { db, a, b } = await world(t);
  assert.equal(a.getLock(9).holder_user_id, 'existing-owner');
  assert.equal(a.acquireTaskContinuityLease(9).ok, false, 'even an expired human checkout is not stolen');
  const lease = a.acquireTaskContinuityLease(1); assert.equal(lease.ok, true);
  const row = b.getLock(1);
  assert.equal(row.holder_user_id, null); assert.equal(row.holder_cycle_id, null);
  assert.equal(lockHolder(row).type, 'operation');
  assert.equal(b.acquireTaskContinuityLease(1).ok, false);
  for (const requester of [{ type: 'user', id: 'human' }, { type: 'cycle', id: 14 }]) {
    assert.equal(b.acquireLock({ projectId: 1, requester, role: 'admin' }).ok, false);
    assert.equal(b.acquireLock({ projectId: 1, requester, role: 'admin', force: true }).ok, false);
    assert.equal(b.lockGuard({ projectId: 1, requester, role: 'admin' }).ok, false);
  }
  db.prepare("UPDATE mock2_locks SET last_write_at='1900-01-01' WHERE project_id=1").run();
  assert.equal(isLockExpired(a.getLock(1), '2100-01-01', 1), false);
  assert.equal(shouldAutoRelease(a.getLock(1), '2100-01-01', 1), false);
  assert.equal(a.releaseLock(1).released, false, 'admin force release cannot imply a remote process stopped');
  assert.equal(a.requestTakeover(1, 'human').ok, false);
  assert.equal(a.touchLock(1, { type: 'operation', id: lease.token }), false);
  const shape = publicLockShape(a.getLock(1));
  assert.equal(shape.held, true); assert.equal(shape.holder_type, 'maintenance');
  assert.equal(shape.can_force_release, false); assert.ok(!JSON.stringify(shape).includes(lease.token));
  assert.ok(!JSON.stringify(b.acquireLock({ projectId: 1, requester: { type: 'user', id: 'human' }, role: 'admin' })).includes(lease.token));
});

test('FD0130 operation release and uncertainty use project plus random-token CAS, never another holder', async t => {
  const { a, b } = await world(t);
  const lease = a.acquireTaskContinuityLease(1), another = b.acquireTaskContinuityLease(2);
  assert.equal(a.settleTaskContinuityLease(1, another.token), false);
  assert.equal(a.markTaskContinuityLeaseUncertain(2, lease.token), false);
  assert.equal(a.settleTaskContinuityLease(1, 'invalid'), false);
  assert.equal(a.markTaskContinuityLeaseUncertain(1, lease.token), true);
  assert.equal(b.getLock(1).holder_operation_state, 'uncertain');
  assert.match(b.lockGuard({ projectId: 1 }).reason, /Inspect the project.*remote operation has stopped/);
  assert.equal(a.settleTaskContinuityLease(1, lease.token), true);
  assert.equal(a.settleTaskContinuityLease(1, lease.token), false);
  const human = b.acquireLock({ projectId: 1, requester: { type: 'user', id: 'human' }, role: 'editor' });
  assert.equal(human.ok, true);
  assert.equal(a.settleTaskContinuityLease(1, lease.token), false);
  assert.equal(a.getLock(1).holder_user_id, 'human');
  assert.equal(b.releaseLock(1, { type: 'user', id: 'not-human' }).released, false);
  assert.equal(b.releaseLock(1, { type: 'user', id: 'human' }).released, true);
  assert.equal(a.getLock(2).holder_operation_id, another.token);
});

test('FD0130 delayed remote operation retains its holder through success or unknown outcome', async t => {
  const { a, b } = await world(t);
  let finish;
  const settled = new Promise(resolve => { finish = resolve; });
  const lease = a.acquireTaskContinuityLease(3); assert.equal(lease.ok, true);
  const dispatch = (async () => { await settled; assert.equal(a.settleTaskContinuityLease(3, lease.token), true); })();
  assert.equal(b.acquireLock({ projectId: 3, requester: { type: 'user', id: 'human' }, role: 'admin' }).ok, false);
  assert.equal(b.releaseLock(3).released, false);
  finish(); await dispatch;
  assert.equal(b.acquireLock({ projectId: 3, requester: { type: 'cycle', id: 15 } }).ok, true);
  const lost = a.acquireTaskContinuityLease(4);
  assert.equal(a.markTaskContinuityLeaseUncertain(4, lost.token), true);
  assert.equal(b.acquireLock({ projectId: 4, requester: { type: 'cycle', id: 16 }, force: true }).ok, false);
  assert.equal(a.getLock(4).holder_operation_id, lost.token);
});

test('FD0130 boot preserves uncertain operation holders while releasing orphaned cycle holders', async t => {
  const { db, a } = await world(t);
  const lease = a.acquireTaskContinuityLease(5);
  db.exec('CREATE TABLE mock2_cycles(id INTEGER PRIMARY KEY,status TEXT,error TEXT,finished_at TEXT)');
  db.prepare("INSERT INTO mock2_cycles(id,status) VALUES(16,'running')").run();
  a.acquireLock({ projectId: 6, requester: { type: 'cycle', id: 16 } });
  a.acquireLock({ projectId: 7, requester: { type: 'cycle', id: 17 } });
  const attached = a.acquireTaskContinuityLease(7, { cycleId: 17 });
  let source = readFileSync(new URL('../mock2/db.js', import.meta.url), 'utf8');
  const start = source.indexOf('export function sweepMock2OnBoot('), end = source.indexOf('// Test/reset seam:', start);
  const fn = new Function(`return (${source.slice(start, end).replace('export function', 'function')});`)();
  fn(db);
  assert.equal(a.getLock(5).holder_operation_id, lease.token);
  assert.equal(a.getLock(5).holder_operation_state, 'uncertain');
  assert.equal(a.getLock(6), undefined);
  assert.equal(a.getLock(7).holder_operation_id, attached.token);
  assert.equal(a.getLock(7).holder_operation_state, 'uncertain');
  assert.equal(a.getLock(7).holder_cycle_id, null, 'restart detaches the orphan cycle, never its operation fence');
  assert.equal(db.prepare('SELECT status FROM mock2_cycles WHERE id=16').get().status, 'failed');
});

test('FD0130 in-cycle metadata attaches only to its actual cycle and settlement preserves that owner', async t => {
  const { a } = await world(t);
  assert.equal(a.acquireTaskContinuityLease(1, { cycleId: 3 }).ok, false);
  a.acquireLock({ projectId: 1, requester: { type: 'cycle', id: 3 } });
  assert.equal(a.acquireTaskContinuityLease(1, { cycleId: 4 }).ok, false);
  const lease = a.acquireTaskContinuityLease(1, { cycleId: 3 }); assert.equal(lease.ok, true);
  assert.equal(a.getLock(1).holder_cycle_id, 3); assert.equal(a.getLock(1).holder_operation_id, lease.token);
  assert.equal(a.settleTaskContinuityLease(1, lease.token), true);
  assert.equal(a.getLock(1).holder_cycle_id, 3); assert.equal(a.getLock(1).holder_operation_id, null);
  const unknown = a.acquireTaskContinuityLease(1, { cycleId: 3 });
  a.markTaskContinuityLeaseUncertain(1, unknown.token);
  assert.equal(a.releaseLock(1, { type: 'cycle', id: 4 }).released, false);
  const released = a.releaseLock(1, { type: 'cycle', id: 3 });
  assert.equal(released.released, true); assert.equal(released.retainedOperation, true);
  assert.equal(a.getLock(1).holder_cycle_id, null);
  assert.equal(a.getLock(1).holder_operation_id, unknown.token);
  assert.equal(a.getLock(1).holder_operation_state, 'uncertain');
  assert.equal(a.acquireLock({ projectId: 1, requester: { type: 'cycle', id: 4 } }).ok, false);
  assert.equal(a.settleTaskContinuityLease(1, unknown.token), true); assert.equal(a.getLock(1), undefined);
});
