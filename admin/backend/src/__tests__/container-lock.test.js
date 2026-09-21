import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withContainerLock, containerLockHolder, ContainerBusyError } from '../mock2/container-lock.js';

const tick = () => new Promise((r) => setImmediate(r));
const gate = () => { let open; const p = new Promise((r) => { open = r; }); return { p, open }; };

test('operations on one container run one after another, in arrival order', async () => {
  const order = [];
  const g1 = gate();
  const a = withContainerLock('c1', 'deploy', async () => { order.push('a:start'); await g1.p; order.push('a:end'); return 'A'; });
  const b = withContainerLock('c1', 'deploy', async () => { order.push('b:start'); order.push('b:end'); return 'B'; });
  await tick();
  assert.deepEqual(order, ['a:start'], 'the second waits for the first');
  assert.deepEqual(containerLockHolder('c1'), { holder: 'deploy', since: containerLockHolder('c1').since, waiting: 1 });
  g1.open();
  assert.deepEqual(await Promise.all([a, b]), ['A', 'B']);
  assert.deepEqual(order, ['a:start', 'a:end', 'b:start', 'b:end']);
  assert.equal(containerLockHolder('c1'), null, 'released after the last one');
});

test('different containers do not wait for each other', async () => {
  const g = gate();
  const order = [];
  const a = withContainerLock('x', 'deploy', async () => { await g.p; order.push('x'); });
  const b = withContainerLock('y', 'deploy', async () => { order.push('y'); });
  await b;
  assert.deepEqual(order, ['y']);
  g.open(); await a;
});

test('a throwing operation releases the lock and does not poison the next one', async () => {
  const a = withContainerLock('c2', 'deploy', async () => { throw new Error('boom'); });
  const b = withContainerLock('c2', 'deploy', async () => 'fine');
  await assert.rejects(a, /boom/);
  assert.equal(await b, 'fine');
  assert.equal(containerLockHolder('c2'), null);
});

test('wait: false refuses while the container is held, naming the holder, and never runs the operation', async () => {
  const g = gate();
  let ran = false;
  const deploy = withContainerLock('c3', 'deploy', async () => { await g.p; return 'deployed'; });
  await tick();
  await assert.rejects(
    withContainerLock('c3', 'restore_project_db', async () => { ran = true; }, { wait: false }),
    (e) => e instanceof ContainerBusyError && e.code === 'CONTAINER_BUSY' && e.holder === 'deploy' && e.container === 'c3',
  );
  assert.equal(ran, false);
  g.open();
  assert.equal(await deploy, 'deployed');
  // Free again: the restore goes through, and holds the lock for its lifetime.
  const g2 = gate();
  const restore = withContainerLock('c3', 'restore_project_db', async () => { await g2.p; return 'restored'; }, { wait: false });
  await tick();
  assert.equal(containerLockHolder('c3').holder, 'restore_project_db');
  let deployStarted = false;
  const queued = withContainerLock('c3', 'deploy', async () => { deployStarted = true; return 'after'; });
  await tick();
  assert.equal(deployStarted, false, 'a deploy arriving during a restore queues behind it');
  g2.open();
  assert.deepEqual(await Promise.all([restore, queued]), ['restored', 'after']);
  assert.equal(containerLockHolder('c3'), null);
});

test('the holder label follows the operation that is actually running', async () => {
  const g = gate();
  const a = withContainerLock('c4', 'deploy', async () => { await g.p; });
  const b = withContainerLock('c4', 'retry-secrets', async () => { assert.equal(containerLockHolder('c4').holder, 'retry-secrets'); });
  await tick();
  assert.equal(containerLockHolder('c4').holder, 'deploy');
  g.open();
  await Promise.all([a, b]);
});
