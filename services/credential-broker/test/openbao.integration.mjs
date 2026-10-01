import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { createBroker } from "../broker.mjs";
import { createDisposableFixture, IMAGE } from "../fixtures/disposable.mjs";
const uuid = randomUUID,
  secret = () => randomBytes(32).toString("base64url");
test(
  "real OpenBao 2.6.2 AppRole/KV CAS, TLS ledger, ACL, rotation/revoke, secret sinks and uncertain effects",
  { timeout: 120000 },
  async (t) => {
    const f = await createDisposableFixture();
    let broker;
    try {
      const proof = secret(),
        authority = {
          async authenticate(p) {
            assert.equal(p, proof);
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
        dbPath: join(f.dir, "broker.db"),
        vault: f.vault,
        upstream: f.upstream,
        authority,
        mode: "synthetic",
      });
      const meta = {
        name: "Isolated ledger",
        project_id: f.project,
        adapter_id: "synthetic-ledger-v1",
        operations: ["item.read", "item.set_state"],
        resources: [f.resource],
        limits: { max_actions: 20, max_seconds: 300 },
      };
      const c = await broker.enroll(proof, meta, f.credential);
      assert.equal(c.credential_version, 1);
      await broker.testConnection(proof, c.id, 1);
      const grant = await broker.assign(proof, c.id, 1, {
        user_id: f.owner,
        project_id: f.project,
        agent_id: f.agent,
        operations: meta.operations,
        resources: meta.resources,
        limits: meta.limits,
        expires_at: Date.now() + 600000,
      });
      const mint = () =>
        broker.issueSession(proof, grant.id, {
          task_id: uuid(),
          attempt: uuid(),
          fence: uuid(),
          audience: "fractionate-broker",
          operations: meta.operations,
          resources: meta.resources,
          limits: meta.limits,
          expires_at: Date.now() + 290000,
        });
      const s = await mint(),
        read = {
          connection_id: c.id,
          operation: "item.read",
          input: { resource_id: f.resource },
        };
      assert.equal(
        (await broker.execute(s.bearer, read, "read")).state,
        "succeeded",
      );
      const raw = JSON.stringify([
        await broker.detail(proof, c.id),
        await broker.activity(proof, c.id),
      ]);
      assert.ok(!raw.includes(f.credential));
      assert.ok(!raw.includes(s.bearer));
      const login = await f.baoTransport("POST", "/v1/auth/approle/login", {
          body: {
            role_id: f.readerCredentials.roleId,
            secret_id: f.readerCredentials.secretId,
          },
        }),
        token = login.auth.client_token;
      await assert.rejects(
        f.baoTransport("POST", "/v1/sys/policies/acl/escape", {
          body: { policy: 'path "*" { capabilities=["sudo"] }' },
          headers: { "X-Vault-Token": token },
        }),
      );
      await assert.rejects(
        f.baoTransport(
          "GET",
          `/v1/fractionate-broker-kv/data/owners/${uuid()}/credentials/${uuid()}`,
          { headers: { "X-Vault-Token": token } },
        ),
      );
      await assert.rejects(
        f.baoTransport("GET", "/v1/sys/mounts", {
          headers: { "X-Vault-Token": s.bearer },
        }),
      );
      await assert.rejects(
        f.baoTransport(
          "GET",
          `/v1/fractionate-broker-kv/data/owners/${f.owner}/credentials/${uuid()}`,
          { headers: { "X-Vault-Token": token } },
        ),
      );
      await assert.rejects(
        f.baoTransport(
          "POST",
          `/v1/fractionate-broker-kv/data/owners/${f.owner}/credentials/${f.credentialIds[0]}`,
          {
            body: {
              options: { cas: 1 },
              data: { value: secret(), intent: uuid() },
            },
            headers: { "X-Vault-Token": token },
          },
        ),
      );
      await assert.rejects(
        f.enroller.write(
          `owners/${f.owner}/credentials/${f.credentialIds[0]}`,
          secret(),
          { cas: 0, intent: uuid() },
        ),
      );
      const records = readFileSync(join(f.dir, "broker.db") + "-wal");
      assert.ok(!records.includes(f.credential));
      assert.ok(!records.includes(s.bearer));
      for (const mode of [
        "redirect",
        "large",
        "compressed",
        "echo-body",
        "echo-body-base64",
      ]) {
        f.setMode(mode);
        assert.equal(
          (await broker.execute(s.bearer, read, mode)).state,
          "failed",
        );
      }
      f.setMode("echo-header");
      assert.equal(
        (await broker.execute(s.bearer, read, "header")).state,
        "succeeded",
      );
      f.setMode("lost");
      const write = {
          connection_id: c.id,
          operation: "item.set_state",
          input: { resource_id: f.resource, state: "closed" },
        },
        approval = await broker.approve(proof, s.session.id, write);
      const result = await broker.execute(
        s.bearer,
        { ...write, approval_id: approval.id },
        "write",
      );
      assert.equal(result.state, "uncertain");
      assert.equal(f.effects, 1);
      await broker.execute(
        s.bearer,
        { ...write, approval_id: approval.id },
        "write",
      );
      assert.equal(f.effects, 1);
      f.setMode("normal");
      const next = secret();
      f.setCredential(next);
      const rotated = await broker.rotate(proof, c.id, 1, next);
      assert.equal(rotated.credential_version, 2);
      await assert.rejects(broker.execute(s.bearer, read, "stale"));
      await broker.testConnection(proof, c.id, rotated.revision);
      const fresh = await mint();
      await broker.revoke(proof, c.id, rotated.revision);
      await assert.rejects(broker.execute(fresh.bearer, read, "revoked"));
      const path = `owners/${f.owner}/credentials/${f.credentialIds[0]}`;
      await f.enroller.write(path, secret(), { cas: 2, intent: uuid() });
      await assert.rejects(f.reader.read(path, 2), /CREDENTIAL_VERSION_STALE/);
      t.diagnostic(
        `Verified image ${IMAGE}; runtime policy refuses provisioning/other owner; agent bearer denied by OpenBao; one uncertain write effect, no resend.`,
      );
    } finally {
      broker?.close();
      await f.close();
    }
  },
);
