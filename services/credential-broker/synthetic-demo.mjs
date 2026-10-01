import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { createDisposableFixture } from "./fixtures/disposable.mjs";
import { createBroker } from "./broker.mjs";
import { createAgentServer } from "./server.mjs";
import { createSyntheticConsumer } from "./consumer.mjs";
// Deliberately isolated executable fixture, not a production daemon or dashboard activation.
if (!process.argv.includes("--synthetic"))
  throw Error("Pass --synthetic to acknowledge disposable infrastructure");
let fixture, broker, server;
try {
  fixture = await createDisposableFixture();
  const f = fixture,
    proof = randomBytes(32).toString("base64url");
  const authority = {
    async authenticate(p) {
      if (p !== proof) throw Error();
      return { user_id: f.owner, fresh_until: Date.now() + 60000 };
    },
    async eligible(s) {
      return (
        s.user_id === f.owner &&
        s.agent_id === f.agent &&
        s.project_id === f.project
      );
    },
    async canAssign(p, g) {
      return (
        p.user_id === f.owner &&
        g.agent_id === f.agent &&
        g.project_id === f.project
      );
    },
  };
  broker = createBroker({
    dbPath: join(f.dir, "demo.db"),
    vault: f.vault,
    upstream: f.upstream,
    authority,
    mode: "synthetic",
  });
  const scope = {
    operations: ["item.read", "item.set_state"],
    resources: [f.resource],
    limits: { max_actions: 5, max_seconds: 300 },
  };
  const c = await broker.enroll(
    proof,
    {
      name: "Disposable synthetic ledger",
      project_id: f.project,
      adapter_id: "synthetic-ledger-v1",
      ...scope,
    },
    f.credential,
  );
  await broker.testConnection(proof, c.id, c.revision);
  const g = await broker.assign(proof, c.id, c.revision, {
    user_id: f.owner,
    project_id: f.project,
    agent_id: f.agent,
    ...scope,
    expires_at: Date.now() + 300000,
  });
  const s = await broker.issueSession(proof, g.id, {
    task_id: randomUUID(),
    attempt: randomUUID(),
    fence: randomUUID(),
    audience: "fractionate-broker",
    ...scope,
    expires_at: Date.now() + 240000,
  });
  server = createAgentServer({ broker, key: f.key, cert: f.cert });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const consumer = createSyntheticConsumer({
    origin: `https://broker.fixture.test:${port}`,
    ca: f.cert,
    bearer: s.bearer,
    connectionId: c.id,
    fixture: { host: "broker.fixture.test", port, address: "127.0.0.1" },
  });
  const receipt = await consumer.execute(
    "item.read",
    { resource_id: f.resource },
    "demo-read",
  );
  if (receipt.state !== "succeeded") throw Error("Synthetic read failed");
  process.stdout.write(
    JSON.stringify({
      mode: "synthetic",
      operation: receipt,
      secret_values_emitted: false,
    }) + "\n",
  );
  if (process.argv.includes("--prove-write")) {
    const request = {
        connection_id: c.id,
        operation: "item.set_state",
        input: { resource_id: f.resource, state: "closed" },
      },
      a = await broker.approve(proof, s.session.id, request);
    const result = await consumer.execute(
      "item.set_state",
      request.input,
      "demo-write",
      a.id,
    );
    if (result.state !== "succeeded" || f.effects !== 1)
      throw Error("Synthetic write failed");
    process.stdout.write(
      JSON.stringify({
        mode: "synthetic",
        operation: result,
        upstream_effects: f.effects,
      }) + "\n",
    );
  }
} catch {
  process.stderr.write(
    "Synthetic demonstration failed; no upstream diagnostic or credential emitted.\n",
  );
  process.exitCode = 1;
} finally {
  if (server) {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
  broker?.close();
  await fixture?.close();
}
