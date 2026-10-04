import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixtureRouter } from './helpers/operations-fixture.js';
import { agentRunsWorld } from './helpers/agent-runs-world.js';
import { createOperationsRouter } from '../routes/operational-projects.js';

function routed(w) {
  const router = createOperationsRouter({ Router: fixtureRouter, store: w.f.store, enabled: true,
    agentsEnabled: true, agentRuns: w.service, lookupLimiter: (_q, _s, next) => next(),
    controlVerified: req => req.verified === true });
  return (user, method, path, body = {}, extra = {}) => router.dispatch({ user, method, path, body,
    headers: {}, query: {}, ...extra });
}
const retired = response => {
  assert.equal(response.statusCode, 410);
  assert.equal(response.body.code, 'DEMO_EXECUTION_RETIRED');
  assert.match(response.body.error, /retired/);
};

test('real router-dispatch demo start and practice refuse before fixture, worker or run creation', async () => {
  const fixtureCalls = [];
  const w = agentRunsWorld({ serviceOptions: { fixtures: { apply: mode => fixtureCalls.push(mode) } } });
  try {
    const call = routed(w);
    for (const user of [w.users.owner, w.users.operator, w.users.editor, w.users.reviewer]) {
      for (const body of [{ profile_id: w.profile.id },
        { profile_id: w.profile.id, practice: { fixture_mode: 'slow' } }, {}])
        retired(await call(user, 'POST', `/${w.p.id}/agent-runs`, body));
    }
    assert.equal((await call(w.users.viewer, 'POST', `/${w.p.id}/agent-runs`)).statusCode, 403);
    assert.equal((await call(w.users.outsider, 'POST', `/${w.p.id}/agent-runs`)).statusCode, 404);
    assert.equal(w.f.db.prepare('SELECT COUNT(*) AS n FROM ops_agent_runs').get().n, 0);
    assert.deepEqual(fixtureCalls, []);
    assert.deepEqual(w.supervisor.calls, []);
    const list = await call(w.users.owner, 'GET', `/${w.p.id}/agent-runs`);
    assert.equal(list.statusCode, 200);
    assert.equal(list.body.profiles[0].ready, false);
    assert.equal(list.body.profiles[0].practice_ready, false);
    assert.match(list.body.profiles[0].reasons[0], /retired/);
  } finally { w.f.close(); }
});

test('historical signed run remains readable and stoppable, but router-dispatch resume cannot create a new run', async () => {
  const w = agentRunsWorld();
  try {
    // A historical lifecycle fixture, created internally, is not a current API launch.
    w.supervisor.scenario.holds.add('open_login');
    const historical = await w.service.start(w.users.owner, w.p.id,
      { profile_id: w.profile.id, credential_binding_id: w.binding.binding_id });
    const id = historical.run.id;
    const call = routed(w);
    const path = `/${w.p.id}/agent-runs/${id}`;
    retired(await call(w.users.owner, 'POST', `${path}/resume`));
    assert.equal((await call(w.users.viewer, 'POST', `${path}/resume`)).statusCode, 403);
    assert.equal((await call(w.users.outsider, 'POST', `${path}/resume`)).statusCode, 404);
    assert.equal((await call(w.users.owner, 'POST', `/${w.p.id}/agent-runs/${randomUUID()}/resume`)).statusCode, 404);
    const detail = await call(w.users.owner, 'GET', path);
    assert.equal(detail.statusCode, 200);
    assert.equal(detail.body.controls.resume.enabled, false);
    assert.match(detail.body.controls.resume.reason, /retired/);
    const stopped = await call(w.users.owner, 'POST', `${path}/stop`);
    assert.ok([200, 202].includes(stopped.statusCode));
    await w.service.settled(id);
    const ended = await call(w.users.owner, 'GET', path);
    assert.equal(ended.statusCode, 200);
    assert.equal(ended.body.run.state, 'cancelled');
    assert.equal(w.f.db.prepare('SELECT COUNT(*) AS n FROM ops_agent_runs').get().n, 1);
    assert.ok(w.supervisor.calls.some(c => c.method === 'stop'));
    retired(await call(w.users.owner, 'POST', `${path}/resume`));
    assert.equal((await call(w.users.owner, 'GET', `/${w.p.id}/agent-profiles/${w.profile.id}`)).statusCode, 200);
  } finally { w.f.close(); }
});
