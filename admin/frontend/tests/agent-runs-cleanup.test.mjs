import assert from 'node:assert/strict';
import test from 'node:test';
import { agentRunsWorld } from '../../backend/src/__tests__/helpers/agent-runs-world.js';
import { settleHarnessRuns } from './agent-runs-cleanup.mjs';

async function until(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate() && Date.now() < deadline) await new Promise(done => setTimeout(done, 10));
  assert.ok(predicate(), 'scripted run did not reach the regression state');
}
for (const pausedAt of ['supervisor hold', 'approval']) test(`failed-journey cleanup unwinds a real run at ${pausedAt}`, async () => {
  const world = agentRunsWorld();
  try {
    if (pausedAt === 'supervisor hold') world.supervisor.scenario.holds.add('open_login');
    const { run } = await world.service.start(world.users.operator, world.p.id, { profile_id: world.profile.id, credential_binding_id: world.binding.binding_id });
    await until(() => pausedAt === 'supervisor hold'
      ? world.supervisor.calls.some(c => c.method === 'action' && c.params?.action === 'open_login')
      : world.f.db.prepare("SELECT 1 FROM ops_agent_run_approvals WHERE run_id=? AND state='requested'").get(run.id));
    await settleHarnessRuns(world, { stopActive: true, timeoutMs: 3000 });
    assert.equal(world.f.db.prepare('SELECT state FROM ops_agent_runs WHERE id=?').get(run.id).state, 'cancelled');
    assert.equal(world.supervisor.scenario.holds.size, 0);
    assert.ok(world.f.db.prepare('SELECT receipt_attestation FROM ops_agent_run_results WHERE run_id=?').get(run.id)?.receipt_attestation, 'cleanup collects the signed teardown receipt');
  } finally { await settleHarnessRuns(world, { stopActive: true, timeoutMs: 3000 }); world.f.close(); }
});

test('a service settlement that never returns fails within the cleanup deadline', async () => {
  const world = agentRunsWorld();
  const original = world.service.settled;
  try {
    world.supervisor.scenario.holds.add('open_login');
    await world.service.start(world.users.operator, world.p.id, { profile_id: world.profile.id, credential_binding_id: world.binding.binding_id });
    world.service.settled = () => new Promise(() => {});
    await assert.rejects(settleHarnessRuns(world, { stopActive: true, timeoutMs: 100 }), /within 100ms/);
  } finally { world.service.settled = original; await settleHarnessRuns(world, { stopActive: true, timeoutMs: 3000 }); world.f.close(); }
});
