import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID, randomBytes } from "node:crypto";
import {
  createMigration,
  createTypedMigrationConsumer,
  createBrokerRotationMigrationIO,
} from "../migration.mjs";
const U = randomUUID;
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "migration-")),
    credential = randomBytes(32).toString("base64url");
  const plan = {
    id: U(),
    consumer_id: U(),
    agent_id: U(),
    source_id: U(),
    source_version: 1,
    target_id: U(),
    target_cas: 0,
    connection_id: U(),
    grant_id: U(),
    legacy_identity_id: U(),
    consumer_revision: 1,
    owner_id: U(),
    project_id: U(),
    operations: ["item.read"],
    resources: [U()],
    limits: { max_actions: 1, max_seconds: 30 },
  };
  let sourceVersion = 1,
    writes = 0,
    revokes = 0,
    revoked = false,
    lost = false,
    grantReady = true,
    cutoverAuth = true;
  const values = new Map();
  const result = { resource_id: plan.resources[0], state: "open" };
  const source = {
    version: async () => sourceVersion,
    read: async (_id, v) => {
      if (v !== sourceVersion) throw Error();
      return { value: credential, version: v };
    },
  };
  const target = {
    write: async (_id, value, { cas, intent }) => {
      if (values.size !== cas) throw Error("CAS");
      writes++;
      values.set(cas + 1, { value, intent, version: cas + 1 });
      if (lost) throw Error(credential);
    },
    read: async (_id, v) => {
      const r = values.get(v);
      if (!r) throw Error();
      return r;
    },
    ready: async () => grantReady,
  };
  const legacy = {
    exclusive: async (i, c) =>
      i === plan.legacy_identity_id && c === plan.consumer_id,
    revoke: async () => {
      revokes++;
      revoked = true;
    },
    proveDenied: async () => revoked,
  };
  const consumer = createTypedMigrationConsumer({
    statePath: join(dir, "consumer.db"),
    registration: {
      id: plan.consumer_id,
      agent_id: plan.agent_id,
      connection_id: plan.connection_id,
      grant_id: plan.grant_id,
      resource_id: plan.resources[0],
    },
    legacyRead: async () => {
      if (revoked) throw Error();
      return result;
    },
    brokerRead: async () => {
      if (!grantReady) throw Error();
      return result;
    },
  });
  const opts = {
    statePath: join(dir, "migration.db"),
    source,
    target,
    legacy,
    consumer,
    authorize: async (proof, { action }) =>
      proof === "approved" && (action !== "cutover" || cutoverAuth),
  };
  let migration = createMigration(opts);
  return {
    plan,
    credential,
    dir,
    source,
    target,
    legacy,
    consumer,
    get migration() {
      return migration;
    },
    counts: () => ({ writes, revokes }),
    sourceChange: () => sourceVersion++,
    lost: () => (lost = true),
    denyCutover: () => (cutoverAuth = false),
    notReady: () => (grantReady = false),
    restart: () => {
      migration.close();
      migration = createMigration(opts);
    },
    close: () => {
      migration.close();
      consumer.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
test("version/CAS transfer then exact consumer switch removes legacy authority and preserves only receipts", async () => {
  const s = setup();
  try {
    await assert.rejects(s.migration.execute("wrong", s.plan));
    assert.deepEqual(s.counts(), { writes: 0, revokes: 0 });
    assert.equal(
      (await s.migration.execute("approved", s.plan)).state,
      "staged",
    );
    assert.equal(
      (await s.migration.execute("approved", s.plan)).state,
      "staged",
    );
    assert.equal(s.counts().writes, 1);
    const receipt = await s.migration.cutover("approved", s.plan.id);
    assert.equal(receipt.state, "completed");
    assert.equal(receipt.legacy_revoked, true);
    assert.equal((await s.consumer.inspect(s.plan.consumer_id)).mode, "broker");
    assert.equal((await s.consumer.use(s.plan.consumer_id)).state, "open");
    assert.equal(
      (await s.migration.cutover("approved", s.plan.id)).state,
      "completed",
    );
    assert.equal(s.counts().revokes, 1);
    assert.ok(!JSON.stringify(receipt).includes(s.credential));
    assert.ok(
      !readFileSync(join(s.dir, "migration.db")).includes(
        Buffer.from(s.credential),
      ),
    );
    assert.ok(
      !readFileSync(join(s.dir, "consumer.db")).includes(
        Buffer.from(s.credential),
      ),
    );
  } finally {
    s.close();
  }
});
test("broker policy revalidation blocks cutover before disabling or revoking legacy authority", async () => {
  const s = setup();
  let rotation;
  try {
    const p = s.plan;
    const connection = {
      id: p.connection_id,
      owner_id: p.owner_id,
      status: "active",
      credential_version: 1,
      readiness: { state: "blocked", code: "POLICY_REVALIDATION_REQUIRED" },
      assignments: [{
        id: p.grant_id,
        revoked: false,
        project_id: p.project_id,
        agent_id: p.agent_id,
        user_id: p.owner_id,
        expires_at: Date.now() + 60000,
        operations: p.operations,
        resources: p.resources,
        limits: p.limits,
      }],
    };
    rotation = createBrokerRotationMigrationIO({
      statePath: join(s.dir, "rotation.db"),
      broker: { detail: async () => connection },
      humanProof: "approved",
      vault: {},
      registration: {
        target_id: p.target_id,
        connection_id: p.connection_id,
        credential_id: U(),
        owner_id: p.owner_id,
        expected_revision: 1,
        expected_version: 1,
      },
    });
    s.target.ready = rotation.ready;
    assert.equal((await s.migration.execute("approved", p)).state, "staged");
    assert.equal(await rotation.ready(p, 1), false);
    const blocked = await s.migration.cutover("approved", p.id);
    assert.equal(blocked.state, "reconcile_required");
    assert.equal(blocked.legacy_revoked, false);
    assert.equal((await s.consumer.inspect(p.consumer_id)).mode, "legacy");
    assert.deepEqual(s.counts(), { writes: 1, revokes: 0 });
    connection.readiness = { state: "ready", code: "SYNTHETIC_ONLY" };
    assert.equal(await rotation.ready(p, 1), true);
    assert.equal((await s.migration.reconcile("approved", p.id)).state, "staged");
    assert.equal((await s.migration.cutover("approved", p.id)).state, "completed");
    assert.deepEqual(s.counts(), { writes: 1, revokes: 1 });
  } finally {
    rotation?.close();
    s.close();
  }
});
test("lost write response persists exact intent, restarts and reconciles without duplicate write", async () => {
  const s = setup();
  try {
    s.lost();
    assert.equal(
      (await s.migration.execute("approved", s.plan)).state,
      "reconcile_required",
    );
    s.restart();
    assert.equal(
      (await s.migration.execute("approved", s.plan)).state,
      "reconcile_required",
    );
    assert.equal(s.counts().writes, 1);
    assert.equal(
      (await s.migration.reconcile("approved", s.plan.id)).state,
      "staged",
    );
    assert.equal(s.counts().writes, 1);
    const changed = { ...s.plan, consumer_id: U() };
    await assert.rejects(
      s.migration.execute("approved", changed),
      /IDEMPOTENCY_CONFLICT/,
    );
  } finally {
    s.close();
  }
});
test("source changes and unready scope prevent retirement; uncertain revoke never silently resumes legacy", async () => {
  let s = setup();
  try {
    s.sourceChange();
    assert.equal(
      (await s.migration.execute("approved", s.plan)).state,
      "reconcile_required",
    );
    assert.equal(s.counts().writes, 0);
  } finally {
    s.close();
  }
  s = setup();
  try {
    await s.migration.execute("approved", s.plan);
    s.notReady();
    assert.equal(
      (await s.migration.cutover("approved", s.plan.id)).state,
      "reconcile_required",
    );
    assert.equal(s.counts().revokes, 0);
    assert.equal((await s.consumer.inspect(s.plan.consumer_id)).mode, "legacy");
  } finally {
    s.close();
  }
  s = setup();
  try {
    await s.migration.execute("approved", s.plan);
    s.legacy.revoke = async () => {
      throw Error(s.credential);
    };
    const r = await s.migration.cutover("approved", s.plan.id);
    assert.equal(r.state, "reconcile_required");
    assert.equal(
      (await s.consumer.inspect(s.plan.consumer_id)).mode,
      "disabled",
    );
    await assert.rejects(
      s.consumer.use(s.plan.consumer_id),
      /CONSUMER_DISABLED/,
    );
    s.restart();
    const status = await s.migration.reconcile("approved", s.plan.id);
    assert.equal(status.state, "disabled");
    assert.equal(status.code, "LEGACY_AUTHORITY_NOT_REVOKED");
    await assert.rejects(
      s.migration.cutover("approved", s.plan.id),
      /MIGRATION_NOT_STAGED/,
    );
  } finally {
    s.close();
  }
});
test("disabled after actual revoke requires explicit fresh-authorized activation, never automatic replay", async () => {
  const s = setup();
  try {
    await s.migration.execute("approved", s.plan);
    const revoke = s.legacy.revoke;
    s.legacy.revoke = async (...a) => {
      await revoke(...a);
      throw Error("lost response");
    };
    assert.equal(
      (await s.migration.cutover("approved", s.plan.id)).state,
      "reconcile_required",
    );
    assert.equal(
      (await s.consumer.inspect(s.plan.consumer_id)).mode,
      "disabled",
    );
    const observed = await s.migration.reconcile("approved", s.plan.id);
    assert.equal(observed.state, "disabled");
    assert.equal(observed.legacy_revoked, true);
    assert.equal(s.counts().revokes, 1);
    await assert.rejects(s.migration.activate("wrong", s.plan.id));
    assert.equal(
      (await s.migration.activate("approved", s.plan.id)).state,
      "completed",
    );
    assert.equal(s.counts().revokes, 1);
  } finally {
    s.close();
  }
});
test("consumer registration drift on restart is rejected and unexpected running binding never called disabled", async () => {
  const dir = mkdtempSync(join(tmpdir(), "migration-registration-")),
    r = {
      id: U(),
      agent_id: U(),
      connection_id: U(),
      grant_id: U(),
      resource_id: U(),
    },
    options = {
      statePath: join(dir, "consumer.db"),
      registration: r,
      brokerRead: async () => ({ resource_id: r.resource_id, state: "open" }),
      legacyRead: async () => ({ resource_id: r.resource_id, state: "open" }),
    };
  let c = createTypedMigrationConsumer(options);
  await c.disable(r.id, { expected_revision: 1, migration_id: U() });
  c.close();
  try {
    assert.throws(
      () =>
        createTypedMigrationConsumer({
          ...options,
          registration: { ...r, connection_id: U() },
        }),
      /CONSUMER_REGISTRATION_CHANGED/,
    );
    c = createTypedMigrationConsumer(options);
    assert.equal((await c.inspect(r.id)).mode, "disabled");
    c.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const s = setup();
  try {
    s.lost();
    await s.migration.execute("approved", s.plan);
    s.consumer.inspect = async () => ({
      mode: "broker",
      revision: 2,
      migration_id: U(),
      connection_id: U(),
      grant_id: U(),
    });
    s.legacy.proveDenied = async () => true;
    const result = await s.migration.reconcile("approved", s.plan.id);
    assert.equal(result.state, "reconcile_required");
    assert.equal(result.code, "CONSUMER_BINDING_UNVERIFIED");
  } finally {
    s.close();
  }
});
test("CAS conflict and concurrent duplicate transfer never overwrite or repeat the selected destination", async () => {
  let s = setup();
  try {
    await s.target.write(s.plan.target_id, "other fixture value", {
      cas: 0,
      intent: U(),
    });
    const receipt = await s.migration.execute("approved", s.plan);
    assert.equal(receipt.state, "reconcile_required");
    assert.equal(s.counts().writes, 1);
    assert.equal(
      (await s.migration.reconcile("approved", s.plan.id)).state,
      "reconcile_required",
    );
  } finally {
    s.close();
  }
  s = setup();
  try {
    let release, started;
    const ready = new Promise((r) => (started = r)),
      read = s.source.read;
    s.source.read = async (...args) => {
      started();
      await new Promise((r) => (release = r));
      s.source.read = read;
      return read(...args);
    };
    const pending = s.migration.execute("approved", s.plan);
    await ready;
    await assert.rejects(
      s.migration.execute("approved", s.plan),
      /MIGRATION_BUSY/,
    );
    release();
    assert.equal((await pending).state, "staged");
    assert.equal(s.counts().writes, 1);
  } finally {
    s.close();
  }
});
