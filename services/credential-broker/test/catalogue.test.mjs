import test from "node:test";
import assert from "node:assert/strict";
import { world, key, U } from "./helpers.mjs";
test("project view includes permitted private reusable connection and typed operation activity", async () => {
  const w = await world();
  try {
    const c = await w.broker.enroll(
      w.proof,
      { ...w.meta, project_id: null },
      key(),
    );
    assert.equal(
      (await w.broker.listConnections(w.proof, { project_id: w.project }))[0]
        .id,
      c.id,
    );
    const other = key();
    w.users.set(other, U());
    assert.deepEqual(
      await w.broker.listConnections(other, { project_id: w.project }),
      [],
    );
    await w.broker.testConnection(w.proof, c.id, 1);
    const g = await w.broker.assign(w.proof, c.id, 1, w.grantRequest()),
      s = await w.broker.issueSession(w.proof, g.id, w.sessionRequest());
    const o = await w.broker.execute(
      s.bearer,
      {
        connection_id: c.id,
        operation: "item.read",
        input: { resource_id: w.resource },
      },
      "visible",
    );
    const events = await w.broker.activity(w.proof, c.id);
    assert.equal(events.find((e) => e.id === o.id).status, "succeeded");
    assert.ok(!JSON.stringify(events).includes(s.bearer));
  } finally {
    w.close();
  }
});
