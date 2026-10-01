import test from "node:test";
import assert from "node:assert/strict";
import { world } from "./helpers.mjs";
test("restart/restore quarantines policy until independent reaffirmation", async () => {
  const w = await world();
  try {
    const { c, g, s } = await w.ready();
    w.restart();
    const sends = w.sends;
    await assert.rejects(
      w.broker.testConnection(w.proof, c.id, 1),
      /NOT_PERMITTED/,
    );
    await assert.rejects(
      w.broker.rotate(w.proof, c.id, 1, "synthetic-rotation"),
      /NOT_PERMITTED/,
    );
    assert.equal(w.sends, sends);
    assert.equal(
      (await w.broker.detail(w.proof, c.id)).readiness.code,
      "POLICY_REVALIDATION_REQUIRED",
    );
    await assert.rejects(
      w.broker.issueSession(w.proof, g.id, w.sessionRequest()),
      /NOT_PERMITTED/,
    );
    await assert.rejects(
      w.broker.revalidatePolicy(w.proof, c.id, 1),
      /NOT_PERMITTED/,
    );
    w.authority.revalidatePolicy = async () => false;
    await assert.rejects(
      w.broker.revalidatePolicy(w.proof, c.id, 1),
      /NOT_PERMITTED/,
    );
    w.authority.revalidatePolicy = async () => true;
    const verified = await w.broker.revalidatePolicy(w.proof, c.id, 1);
    assert.equal(verified.revision, 2);
    const fresh = await w.broker.issueSession(
      w.proof,
      g.id,
      w.sessionRequest(),
    );
    assert.ok(fresh.bearer);
    await assert.rejects(
      w.broker.execute(
        s.bearer,
        {
          connection_id: c.id,
          operation: "item.read",
          input: { resource_id: w.resource },
        },
        "old",
      ),
      /NOT_PERMITTED/,
    );
  } finally {
    w.close();
  }
});
