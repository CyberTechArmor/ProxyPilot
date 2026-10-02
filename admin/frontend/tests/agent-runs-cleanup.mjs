import assert from 'node:assert/strict';

// A failed assertion can leave the scripted supervisor held or a run waiting
// for approval. Fence it before waiting for the service loop to settle.
export async function settleHarnessRuns(world, { stopActive = false, timeoutMs = 20000 } = {}) {
  let timer;
  const deadline = Date.now() + timeoutMs;
  const active = () => world.f.db.prepare(`SELECT id FROM ops_agent_runs
    WHERE state IN ('prepared','starting','running','cancelling')`).all();
  try {
    await Promise.race([
      (async () => {
        for (const action of [...world.supervisor.scenario.holds]) world.supervisor.release(action);
        const runs = active();
        if (stopActive) for (const { id } of runs) await world.coordinator.stop(world.users.owner, id);
        for (const { id } of runs) await world.service.settled(id);
        while (active().length && Date.now() < deadline) await new Promise(done => setTimeout(done, 50));
        assert.deepEqual(active(), [], 'a run is still active');
      })(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Run cleanup did not settle within ${timeoutMs}ms`)), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}
