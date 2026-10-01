import test from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import { randomUUID, randomBytes } from "node:crypto";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { createDisposableFixture, IMAGE } from "../fixtures/disposable.mjs";
import { createBroker } from "../broker.mjs";
import {
  createMigration,
  createOpenBaoMigrationIO,
  createBrokerRotationMigrationIO,
  createTypedMigrationConsumer,
} from "../migration.mjs";
const U = randomUUID;
test(
  "real OpenBao source-version/CAS transfer, scoped broker rotation, concrete consumer cutover and actual legacy token denial",
  { timeout: 120000 },
  async () => {
    const f = await createDisposableFixture();
    let broker, target, consumer, migration;
    try {
      const proof = randomBytes(32).toString("base64url"),
        sourceId = U(),
        targetId = U(),
        legacyId = U(),
        consumerId = U();
      const sourcePath = `owners/${f.owner}/credentials/${f.credentialIds[7]}`;
      await f.enroller.write(sourcePath, f.credential, { cas: 0, intent: U() });
      await f.provision("/v1/sys/policies/acl/migration-legacy", {
        policy: `path "fractionate-broker-kv/data/${sourcePath}" { capabilities = ["read"] }`,
      });
      const issued = await f.provision("/v1/auth/token/create", {
        policies: ["migration-legacy"],
        no_default_policy: true,
        ttl: "5m",
      });
      const legacyToken = issued.auth.client_token;
      const legacyGet = () =>
        new Promise((resolve, reject) => {
          const req = https.request(
            {
              hostname: "127.0.0.1",
              port: f.baoPort,
              servername: "bao.fixture.test",
              ca: f.cert,
              path:
                "/v1/fractionate-broker-kv/data/" + sourcePath + "?version=1",
              headers: { "X-Vault-Token": legacyToken },
              timeout: 5000,
            },
            (res) => {
              let bytes = "";
              res.on("data", (b) => {
                bytes += b;
                if (bytes.length > 16384) res.destroy();
              });
              res.on("end", () =>
                resolve({ status: res.statusCode, body: JSON.parse(bytes) }),
              );
            },
          );
          req.on("timeout", () => req.destroy());
          req.on("error", reject);
          req.end();
        });
      const readerAuth = await f.baoTransport(
        "POST",
        "/v1/auth/approle/login",
        {
          body: {
            role_id: f.readerCredentials.roleId,
            secret_id: f.readerCredentials.secretId,
          },
        },
      );
      const source = createOpenBaoMigrationIO({
        client: f.reader,
        paths: { [sourceId]: sourcePath },
        currentVersion: async (path) =>
          (
            await f.baoTransport(
              "GET",
              "/v1/fractionate-broker-kv/metadata/" + path,
              { headers: { "X-Vault-Token": readerAuth.auth.client_token } },
            )
          ).data.current_version,
      });
      const authority = {
        authenticate: async (p) => {
          assert.equal(p, proof);
          return { user_id: f.owner, fresh_until: Date.now() + 60000 };
        },
        eligible: async (s) =>
          s.user_id === f.owner &&
          s.agent_id === f.agent &&
          s.project_id === f.project,
        canAssign: async (_p, g) =>
          g.user_id === f.owner &&
          g.agent_id === f.agent &&
          g.project_id === f.project,
      };
      broker = createBroker({
        dbPath: join(f.dir, "migration-broker.db"),
        vault: f.vault,
        upstream: f.upstream,
        authority,
        mode: "synthetic",
      });
      const scope = {
        operations: ["item.read"],
        resources: [f.resource],
        limits: { max_actions: 3, max_seconds: 60 },
      };
      const connection = await broker.enroll(
        proof,
        {
          name: "Migration target",
          project_id: f.project,
          adapter_id: "synthetic-ledger-v1",
          ...scope,
        },
        randomBytes(32).toString("base64url"),
      );
      const grant = await broker.assign(proof, connection.id, 1, {
        user_id: f.owner,
        project_id: f.project,
        agent_id: f.agent,
        ...scope,
        expires_at: Date.now() + 60000,
      });
      target = createBrokerRotationMigrationIO({
        statePath: join(f.dir, "migration-target.db"),
        broker,
        humanProof: proof,
        vault: f.reader,
        registration: {
          target_id: targetId,
          connection_id: connection.id,
          credential_id: f.credentialIds[0],
          owner_id: f.owner,
          expected_revision: 1,
          expected_version: 1,
        },
      });
      let brokerCalls = 0,
        legacyCalls = 0;
      consumer = createTypedMigrationConsumer({
        statePath: join(f.dir, "migration-consumer.db"),
        registration: {
          id: consumerId,
          agent_id: f.agent,
          connection_id: connection.id,
          grant_id: grant.id,
          resource_id: f.resource,
        },
        legacyRead: async () => {
          legacyCalls++;
          const r = await legacyGet();
          if (r.status !== 200) throw Error();
          return f.upstream.execute(
            "item.read",
            { resource_id: f.resource },
            r.body.data.data.value,
          );
        },
        brokerRead: async (request) => {
          brokerCalls++;
          const session = await broker.issueSession(proof, request.grant_id, {
            task_id: U(),
            attempt: U(),
            fence: U(),
            ...scope,
            expires_at: Date.now() + 30000,
            audience: "fractionate-broker",
          });
          const r = await broker.execute(
            session.bearer,
            {
              connection_id: request.connection_id,
              operation: request.operation,
              input: request.input,
            },
            U(),
          );
          if (r.state !== "succeeded") throw Error();
          return r.result;
        },
      });
      const plan = {
        id: U(),
        consumer_id: consumerId,
        agent_id: f.agent,
        source_id: sourceId,
        source_version: 1,
        target_id: targetId,
        target_cas: 1,
        connection_id: connection.id,
        grant_id: grant.id,
        legacy_identity_id: legacyId,
        consumer_revision: 1,
        owner_id: f.owner,
        project_id: f.project,
        ...scope,
      };
      let revocations = 0;
      const legacy = {
        exclusive: async (i, c) => i === legacyId && c === consumerId,
        revoke: async (i, { consumer_id }) => {
          assert.equal(i, legacyId);
          assert.equal(consumer_id, consumerId);
          revocations++;
          await f.provision("/v1/auth/token/revoke", { token: legacyToken });
        },
        proveDenied: async (i, c) =>
          i === legacyId &&
          c === consumerId &&
          (await legacyGet()).status === 403,
      };
      migration = createMigration({
        statePath: join(f.dir, "migration-execution.db"),
        source,
        target,
        legacy,
        consumer,
        authorize: async (p, { plan: requested }) =>
          p === proof &&
          requested.consumer_id === consumerId &&
          requested.owner_id === f.owner,
      });
      assert.equal((await consumer.use(consumerId)).state, "open");
      assert.equal(legacyCalls, 1);
      assert.equal((await migration.execute(proof, plan)).state, "staged");
      assert.equal(
        (await broker.detail(proof, connection.id)).credential_version,
        2,
      );
      await broker.testConnection(proof, connection.id, 2);
      const receipt = await migration.cutover(proof, plan.id);
      assert.equal(receipt.state, "completed");
      assert.equal(receipt.legacy_revoked, true);
      assert.equal((await legacyGet()).status, 403);
      assert.equal((await consumer.use(consumerId)).state, "open");
      assert.equal(legacyCalls, 1);
      assert.equal(brokerCalls, 2);
      assert.equal(revocations, 1);
      assert.equal((await migration.execute(proof, plan)).state, "completed");
      assert.equal(
        (await migration.cutover(proof, plan.id)).state,
        "completed",
      );
      assert.equal(revocations, 1);
      for (const name of [
        "migration-execution.db",
        "migration-target.db",
        "migration-consumer.db",
        "migration-broker.db",
      ])
        assert.ok(
          !readFileSync(join(f.dir, name)).includes(Buffer.from(f.credential)),
        );
      assert.ok(!JSON.stringify(receipt).includes(f.credential));
      assert.ok(!JSON.stringify(receipt).includes(legacyToken));
      assert.match(IMAGE, /openbao:2\.6\.2/);
    } finally {
      migration?.close();
      consumer?.close();
      target?.close();
      broker?.close();
      await f.close();
    }
  },
);
