import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixtureRouter } from './helpers/operations-fixture.js';
import { agentRunsWorld, VM } from './helpers/agent-runs-world.js';
import { createOperationsRouter } from '../routes/operational-projects.js';
import { createWorkerLauncher } from '../lib/operational-worker-boundary.js';
import { createSupervisorClient } from '../lib/operational-worker-supervisor.js';

async function uncertain() {
  const w = agentRunsWorld();
  w.supervisor.scenario.actionErrors.open_login = 'SUPERVISOR_TIMEOUT';
  const started = await w.service.start(w.users.operator, w.p.id, { profile_id: w.profile.id,
    credential_binding_id: w.binding.binding_id });
  await w.service.settled(started.run.id);
  w.runId = started.run.id;
  return w;
}
function route(w, options = {}) {
  const router = createOperationsRouter({ Router: fixtureRouter, store: w.f.store, enabled: true, agentsEnabled: true,
    lookupLimiter: (_q, _s, next) => next(), agentRuns: w.service, ...options });
  return user => router.dispatch({ method: 'GET', path: `/${w.p.id}/agent-runs/${w.runId}`, user });
}
const recordItem = view => view.reconciliation.items.find(i => i.subject.startsWith('step:'));

test('A8 detail reads the original step/fence, projects a terminal record and writes nothing', async () => {
  const w = await uncertain();
  try {
    const step = w.f.db.prepare("SELECT * FROM ops_agent_run_steps WHERE run_id=? AND state='uncertain'").get(w.runId);
    const before = w.f.db.prepare('SELECT total_changes() AS n').get().n;
    const body = (await route(w)(w.users.operator)).body;
    const item = recordItem(body);
    assert.equal(item.supervisor_record.status, 'recorded');
    assert.deepEqual(Object.keys(item.supervisor_record.record).sort(), ['action','at','error','ordinal','state']);
    assert.equal(item.supervisor_record.record.state, 'uncertain');
    assert.deepEqual(w.supervisor.calls.filter(c => c.method === 'step_record').map(c => c.params),
      [{ run_id: w.runId, attempt_id: step.attempt_id, fence: step.fence, ordinal: step.ordinal, action: step.action }]);
    assert.equal(w.f.db.prepare('SELECT total_changes() AS n').get().n, before);
    assert.equal(recordItem(w.service.status(w.users.operator, w.p.id, w.runId)).decision, null);
    for (const needle of ['untrusted_', 'a3r1.', 'attestation', 'vault_path']) assert.equal(JSON.stringify(body).includes(needle), false);
  } finally { w.f.close(); }
});

test('A8 unauthorized roles and disabled routes do not read the supervisor', async () => {
  const w = await uncertain();
  try {
    const call = route(w);
    assert.equal((await call(w.users.viewer)).statusCode, 403);
    assert.equal((await call(w.users.outsider)).statusCode, 404);
    for (const options of [{ enabled: false }, { agentsEnabled: false }, { agentRuns: null }])
      assert.equal((await route(w, options)(w.users.owner)).statusCode, 404);
    assert.equal(w.supervisor.calls.some(c => c.method === 'step_record'), false);
  } finally { w.f.close(); }
});

test('A8 an unavailable, absent or malformed record stays explicitly inconclusive', async () => {
  const w = await uncertain();
  const original = w.supervisor.client.request;
  try {
    for (const [answer, expected] of [[null, 'missing'], ['secret exception', 'unavailable'],
      [{ ordinal: 2, action: 'open_login', state: 'done', at: '2026-09-30T12:00:00Z', page: 'secret page' }, 'unavailable']]) {
      w.supervisor.client.request = async (method, params) => {
        if (method !== 'step_record') return original(method, params);
        if (typeof answer === 'string') throw new Error(answer);
        return { record: answer };
      };
      const body = (await route(w)(w.users.owner)).body;
      assert.deepEqual(recordItem(body).supervisor_record, { status: expected, record: null });
      assert.equal(JSON.stringify(body).includes('secret'), false);
      assert.equal(recordItem(body).decision, null);
    }
  } finally { w.f.close(); }
});

test('A8 revocation during a pending record read denies the completed response', async () => {
  const w = await uncertain();
  try {
    let entered, release;
    const pending = new Promise(done => { entered = done; });
    const held = new Promise(done => { release = done; });
    const original = w.supervisor.client.request;
    w.supervisor.client.request = async (method, params) => {
      if (method === 'step_record') { entered(); await held; }
      return original(method, params);
    };
    const request = route(w)(w.users.operator);
    await pending;
    w.f.store.remove(w.users.owner, w.p.id, w.users.operator.id, w.f.store.get(w.users.owner, w.p.id).revision);
    release();
    const denied = await request;
    assert.equal(denied.statusCode, 404);
    assert.equal(denied.body.reconciliation, undefined);
  } finally { w.f.close(); }
});

test('A8 launcher rejects mismatched or excessive records and noncanonical timestamps', async () => {
  const w = await uncertain();
  try {
    const step = w.f.db.prepare("SELECT attempt_id,fence,ordinal,action FROM ops_agent_run_steps WHERE run_id=? AND state='uncertain'").get(w.runId);
    const ref = { run_id: w.runId, ...step };
    const good = { ordinal: step.ordinal, action: step.action, state: 'done', at: '2026-09-30T12:00:00Z' };
    let reply = { record: good };
    const launcher = createWorkerLauncher({ client: { request: async () => reply }, vmUuid: VM });
    assert.deepEqual(await launcher.stepRecord(ref), good);
    for (const update of [{ ordinal: step.ordinal + 1 }, { action: 'sign_out' }, { state: 'approved' },
      { at: '2026-02-30T12:00:00Z' }, { at: 'secret' }, { error: 'secret value' }, { latency_ms: -1 }, { claims: {} }]) {
      reply = { record: { ...good, ...update } };
      await assert.rejects(launcher.stepRecord(ref), { code: 'SUPERVISOR_PROTOCOL' });
    }
    for (const record of [false, 'secret', [], 3]) {
      reply = { record };
      await assert.rejects(launcher.stepRecord(ref), { code: 'SUPERVISOR_PROTOCOL' });
    }
    await assert.rejects(launcher.stepRecord({ ...ref, url: 'https://example.com' }), { code: 'INVALID_REQUEST' });
  } finally { w.f.close(); }
});

test('A8 record transport stops oversized and slow-drip replies within the read deadline', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pp-a8-record-'));
  const path = join(root, 's.sock');
  let mode = 'oversized';
  const server = net.createServer(socket => {
    socket.on('error', () => {});
    socket.once('data', () => {
      if (mode === 'oversized') return socket.write('x'.repeat(2049));
      const drip = setInterval(() => socket.write(' '), 10);
      socket.on('close', () => clearInterval(drip));
    });
  });
  await new Promise(done => server.listen(path, done));
  try {
    const client = createSupervisorClient(path, { timeoutMs: 80 });
    await assert.rejects(client.request('step_record', {}), { code: 'SUPERVISOR_PROTOCOL' });
    mode = 'drip';
    const at = Date.now();
    await assert.rejects(client.request('step_record', {}), { code: 'SUPERVISOR_TIMEOUT' });
    assert.ok(Date.now() - at < 1000);
  } finally {
    await new Promise(done => server.close(done));
    rmSync(root, { recursive: true, force: true });
  }
});
