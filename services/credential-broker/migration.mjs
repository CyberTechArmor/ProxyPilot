import { openStore } from "./store.mjs";
import {
  exact,
  uuid,
  operation,
  list,
  limits,
  canonical,
  fail,
} from "./schema.mjs";

// Operator-invoked library only; no CLI/network credential arguments or automatic live selection.
export function createMigration({
  statePath,
  source,
  target,
  legacy,
  consumer,
  authorize,
}) {
  if (
    !source ||
    !target ||
    !legacy ||
    !consumer ||
    typeof authorize !== "function"
  )
    fail("MIGRATION_NOT_CONFIGURED");
  const db = openStore(statePath),
    busy = new Set();
  const save = (r) => {
    r.updated_at = Date.now();
    db.put("migration", r);
  };
  for (const r of db.all("migration"))
    if (
      [
        "reading",
        "writing",
        "stopping",
        "revoking",
        "activating",
        "probing",
      ].includes(r.state)
    ) {
      r.state = "reconcile_required";
      r.code = "INTERRUPTED";
      save(r);
    }
  const receipt = (r) => ({
    id: r.id,
    consumer_id: r.plan.consumer_id,
    source_version: r.plan.source_version,
    target_version: r.target_version || null,
    state: r.state,
    code: r.code || null,
    legacy_revoked: r.legacy_revoked === true,
    consumer_revision: r.consumer_revision || null,
    created_at: r.created_at,
    updated_at: r.updated_at,
  });
  const auth = async (proof, action, plan) => {
    let ok = false;
    try {
      ok = await authorize(proof, { action, plan: structuredClone(plan) });
    } catch {}
    if (ok !== true) fail("MIGRATION_NOT_AUTHORIZED", 403);
  };
  const get = (id) => {
    uuid(id);
    const r = db.get("migration", id);
    if (!r) fail("NOT_FOUND", 404);
    return r;
  };
  const locked = async (id, fn) => {
    if (busy.has(id)) fail("MIGRATION_BUSY", 409);
    busy.add(id);
    try {
      return await fn();
    } finally {
      busy.delete(id);
    }
  };
  const validate = (p) => {
    exact(p, [
      "id",
      "consumer_id",
      "agent_id",
      "source_id",
      "source_version",
      "target_id",
      "target_cas",
      "connection_id",
      "grant_id",
      "legacy_identity_id",
      "consumer_revision",
      "owner_id",
      "project_id",
      "operations",
      "resources",
      "limits",
    ]);
    for (const k of [
      "id",
      "consumer_id",
      "agent_id",
      "source_id",
      "target_id",
      "connection_id",
      "grant_id",
      "legacy_identity_id",
      "owner_id",
      "project_id",
    ])
      uuid(p[k]);
    for (const k of ["source_version", "consumer_revision"])
      if (!Number.isSafeInteger(p[k]) || p[k] < 1) fail("INVALID_REQUEST");
    if (!Number.isSafeInteger(p.target_cas) || p.target_cas < 0)
      fail("INVALID_REQUEST");
    list(p.operations, operation);
    list(p.resources, uuid);
    limits(p.limits);
  };
  const version = async (r) => {
    if ((await source.version(r.plan.source_id)) !== r.plan.source_version)
      fail("SOURCE_CHANGED", 409);
  };
  const matching = async (r) => {
    await version(r);
    const original = await source.read(r.plan.source_id, r.plan.source_version);
    const written = await target.read(r.plan.target_id, r.plan.target_cas + 1);
    await version(r);
    if (
      original.version !== r.plan.source_version ||
      written.version !== r.plan.target_cas + 1 ||
      written.intent !== r.id ||
      typeof original.value !== "string" ||
      written.value !== original.value
    )
      fail("TRANSFER_NOT_VERIFIED", 409);
    return written.version;
  };
  return {
    async execute(proof, plan) {
      validate(plan);
      await auth(proof, "transfer", plan);
      return locked(plan.id, async () => {
        const old = db.get("migration", plan.id);
        if (old) {
          if (canonical(old.plan) !== canonical(plan))
            fail("IDEMPOTENCY_CONFLICT", 409);
          return receipt(old);
        }
        const r = {
          id: plan.id,
          plan: structuredClone(plan),
          state: "reading",
          created_at: Date.now(),
        };
        save(r);
        let value;
        try {
          await version(r);
          const read = await source.read(plan.source_id, plan.source_version);
          if (
            read.version !== plan.source_version ||
            typeof read.value !== "string" ||
            !read.value.length ||
            read.value.length > 4096
          )
            fail("TRANSFER_NOT_VERIFIED");
          value = read.value;
          await version(r);
          await auth(proof, "transfer", plan);
          r.state = "writing";
          save(r);
          await target.write(plan.target_id, value, {
            cas: plan.target_cas,
            intent: plan.id,
          });
          r.target_version = await matching(r);
          r.state = "staged";
        } catch {
          r.state = "reconcile_required";
          r.code = "TRANSFER_UNVERIFIED";
        } finally {
          value = null;
        }
        save(r);
        return receipt(r);
      });
    },
    async reconcile(proof, id) {
      const initial = get(id);
      await auth(proof, "reconcile", initial.plan);
      return locked(id, async () => {
        const r = get(id);
        if (r.state !== "reconcile_required") return receipt(r);
        // Reconciliation observes effects only: never repeats a write, revoke or activation.
        try {
          r.target_version = await matching(r);
          const c = await consumer.inspect(r.plan.consumer_id);
          if (
            (await legacy.proveDenied(
              r.plan.legacy_identity_id,
              r.plan.consumer_id,
            )) === true
          ) {
            r.legacy_revoked = true;
            if (
              c.mode === "broker" &&
              c.migration_id === r.id &&
              c.connection_id === r.plan.connection_id &&
              c.grant_id === r.plan.grant_id &&
              (await consumer.probe(r.plan.consumer_id, r.id)) === true
            ) {
              const final = await consumer.inspect(r.plan.consumer_id);
              if (
                final.mode !== "broker" ||
                final.migration_id !== r.id ||
                final.connection_id !== r.plan.connection_id ||
                final.grant_id !== r.plan.grant_id ||
                final.revision !== c.revision
              )
                fail("CONSUMER_BINDING_UNVERIFIED");
              r.state = "completed";
              r.code = null;
              r.consumer_revision = final.revision;
            } else {
              r.state =
                c.mode === "disabled" ? "disabled" : "reconcile_required";
              r.code =
                c.mode === "disabled"
                  ? "EXPLICIT_ACTIVATION_REQUIRED"
                  : "CONSUMER_BINDING_UNVERIFIED";
            }
          } else if (
            c.mode === "legacy" &&
            c.revision === r.plan.consumer_revision
          ) {
            r.state = "staged";
            r.code = null;
          } else {
            r.state = c.mode === "disabled" ? "disabled" : "reconcile_required";
            r.code = "LEGACY_AUTHORITY_NOT_REVOKED";
          }
        } catch {
          r.state = "reconcile_required";
          r.code = "RECONCILIATION_INCOMPLETE";
        }
        save(r);
        return receipt(r);
      });
    },
    async cutover(proof, id) {
      const initial = get(id);
      await auth(proof, "cutover", initial.plan);
      return locked(id, async () => {
        const r = get(id);
        if (r.state === "completed") return receipt(r);
        if (r.state !== "staged") fail("MIGRATION_NOT_STAGED", 409);
        try {
          await matching(r);
          if (
            (await target.ready(r.plan, r.target_version)) !== true ||
            (await legacy.exclusive(
              r.plan.legacy_identity_id,
              r.plan.consumer_id,
            )) !== true
          )
            fail("CUTOVER_NOT_READY");
          const before = await consumer.inspect(r.plan.consumer_id);
          if (
            before.mode !== "legacy" ||
            before.revision !== r.plan.consumer_revision
          )
            fail("CONSUMER_CHANGED");
          await auth(proof, "cutover", r.plan);
          r.state = "stopping";
          save(r);
          await consumer.disable(r.plan.consumer_id, {
            expected_revision: before.revision,
            migration_id: r.id,
          });
          const stopped = await consumer.inspect(r.plan.consumer_id);
          if (stopped.mode !== "disabled" || stopped.migration_id !== r.id)
            fail("CONSUMER_NOT_STOPPED");
          r.consumer_revision = stopped.revision;
          r.state = "revoking";
          save(r);
          await legacy.revoke(r.plan.legacy_identity_id, {
            consumer_id: r.plan.consumer_id,
            migration_id: r.id,
          });
          if (
            (await legacy.proveDenied(
              r.plan.legacy_identity_id,
              r.plan.consumer_id,
            )) !== true
          )
            fail("LEGACY_AUTHORITY_NOT_REVOKED");
          r.legacy_revoked = true;
          await version(r);
          await auth(proof, "activate", r.plan);
          r.state = "activating";
          save(r);
          await consumer.activate(r.plan, {
            expected_revision: stopped.revision,
            migration_id: r.id,
          });
          r.state = "probing";
          save(r);
          if ((await consumer.probe(r.plan.consumer_id, r.id)) !== true)
            fail("BROKER_USE_NOT_VERIFIED");
          const active = await consumer.inspect(r.plan.consumer_id);
          if (
            active.mode !== "broker" ||
            active.migration_id !== r.id ||
            active.connection_id !== r.plan.connection_id ||
            active.grant_id !== r.plan.grant_id
          )
            fail("CONSUMER_BINDING_UNVERIFIED");
          r.consumer_revision = active.revision;
          r.state = "completed";
          r.code = null;
        } catch {
          r.state = "reconcile_required";
          r.code = "CUTOVER_UNCERTAIN";
        }
        save(r);
        return receipt(r);
      });
    },
    async activate(proof, id) {
      const initial = get(id);
      await auth(proof, "activate", initial.plan);
      return locked(id, async () => {
        const r = get(id);
        if (r.state !== "disabled" || r.legacy_revoked !== true)
          fail("EXPLICIT_RECONCILIATION_REQUIRED", 409);
        try {
          await matching(r);
          if (
            (await legacy.proveDenied(
              r.plan.legacy_identity_id,
              r.plan.consumer_id,
            )) !== true ||
            (await target.ready(r.plan, r.target_version)) !== true
          )
            fail("CUTOVER_NOT_READY");
          const c = await consumer.inspect(r.plan.consumer_id);
          if (c.mode !== "disabled" || c.migration_id !== r.id)
            fail("CONSUMER_CHANGED");
          r.state = "activating";
          save(r);
          await consumer.activate(r.plan, {
            expected_revision: c.revision,
            migration_id: r.id,
          });
          r.state = "probing";
          save(r);
          if ((await consumer.probe(r.plan.consumer_id, r.id)) !== true)
            fail("BROKER_USE_NOT_VERIFIED");
          const active = await consumer.inspect(r.plan.consumer_id);
          if (
            active.mode !== "broker" ||
            active.migration_id !== r.id ||
            active.connection_id !== r.plan.connection_id ||
            active.grant_id !== r.plan.grant_id
          )
            fail("CONSUMER_BINDING_UNVERIFIED");
          r.state = "completed";
          r.code = null;
          r.consumer_revision = active.revision;
        } catch {
          r.state = "reconcile_required";
          r.code = "ACTIVATION_UNCERTAIN";
        }
        save(r);
        return receipt(r);
      });
    },
    async status(proof, id) {
      const r = get(id);
      await auth(proof, "view", r.plan);
      return receipt(r);
    },
    close() {
      if (busy.size) fail("MIGRATION_BUSY", 409);
      db.close();
    },
  };
}

/** Concrete KV-v2 endpoints through already restricted authenticated clients.
 * IDs map to exact server-owned paths. No manifest can supply a vault path/token. */
export function createOpenBaoMigrationIO({ client, paths, currentVersion }) {
  const path = (id) => {
    uuid(id);
    const p = paths[id];
    if (!p || !/^owners\/[0-9a-f-]{36}\/credentials\/[0-9a-f-]{36}$/.test(p))
      fail("UNKNOWN_MIGRATION_REFERENCE");
    return p;
  };
  return {
    version: async (id) => currentVersion(path(id)),
    read: (id, v) => client.read(path(id), v),
    write: (id, value, options) => client.write(path(id), value, options),
  };
}

/** Durable selected typed consumer. Its broker callback must use an actual scoped
 * broker session; it never receives or stores upstream credentials. */
export function createTypedMigrationConsumer({
  statePath,
  registration,
  brokerRead,
  legacyRead,
}) {
  registration = structuredClone(registration);
  exact(registration, [
    "id",
    "agent_id",
    "connection_id",
    "grant_id",
    "resource_id",
  ]);
  Object.values(registration).forEach(uuid);
  const db = openStore(statePath);
  const previous = db.get("consumer", registration.id);
  if (
    previous &&
    Object.keys(registration).some((k) => registration[k] !== previous[k])
  ) {
    db.close();
    fail("CONSUMER_REGISTRATION_CHANGED", 409);
  }
  if (!previous)
    db.put("consumer", {
      ...registration,
      revision: 1,
      mode: "legacy",
      migration_id: null,
    });
  const row = (id) => {
    if (id !== registration.id) fail("NOT_FOUND", 404);
    return db.get("consumer", id);
  };
  const inspect = async (id) => ({ ...row(id) });
  const use = async (id) => {
    const r = row(id);
    if (r.mode === "disabled") fail("CONSUMER_DISABLED", 409);
    let result;
    try {
      result = await (r.mode === "broker"
        ? brokerRead({
            connection_id: r.connection_id,
            grant_id: r.grant_id,
            operation: "item.read",
            input: { resource_id: r.resource_id },
          })
        : legacyRead());
    } catch {
      fail("CONSUMER_USE_FAILED", 503);
    }
    exact(result, ["resource_id", "state"]);
    if (
      result.resource_id !== r.resource_id ||
      !["open", "closed"].includes(result.state)
    )
      fail("INVALID_UPSTREAM_RESULT");
    return { resource_id: result.resource_id, state: result.state };
  };
  return {
    inspect,
    use,
    async disable(id, { expected_revision, migration_id }) {
      const r = row(id);
      uuid(migration_id);
      if (r.revision !== expected_revision || r.mode !== "legacy")
        fail("CONSUMER_CHANGED", 409);
      db.put("consumer", {
        ...r,
        mode: "disabled",
        revision: r.revision + 1,
        migration_id,
      });
    },
    async activate(plan, { expected_revision, migration_id }) {
      const r = row(plan.consumer_id);
      if (
        r.mode !== "disabled" ||
        r.revision !== expected_revision ||
        r.migration_id !== migration_id ||
        plan.connection_id !== r.connection_id ||
        plan.grant_id !== r.grant_id ||
        plan.agent_id !== r.agent_id ||
        !plan.resources.includes(registration.resource_id) ||
        !plan.operations.includes("item.read")
      )
        fail("CONSUMER_CHANGED", 409);
      db.put("consumer", { ...r, mode: "broker", revision: r.revision + 1 });
    },
    async probe(id, migration_id) {
      const r = row(id);
      if (r.mode !== "broker" || r.migration_id !== migration_id) return false;
      await use(id);
      return true;
    },
    close: () => db.close(),
  };
}

/** Existing connection rotation: broker owns CAS/storage and session invalidation.
 * A protected receipt maps migration intent to the broker's actual vault marker.
 * A crash before that receipt is committed stays blocked; never infer attribution. */
export function createBrokerRotationMigrationIO({
  statePath,
  broker,
  humanProof,
  vault,
  registration,
}) {
  registration = structuredClone(registration);
  exact(registration, [
    "target_id",
    "connection_id",
    "credential_id",
    "owner_id",
    "expected_revision",
    "expected_version",
  ]);
  for (const k of ["target_id", "connection_id", "credential_id", "owner_id"])
    uuid(registration[k]);
  for (const k of ["expected_revision", "expected_version"])
    if (!Number.isSafeInteger(registration[k]) || registration[k] < 1)
      fail("INVALID_REQUEST");
  const db = openStore(statePath),
    path = `owners/${registration.owner_id}/credentials/${registration.credential_id}`;
  let busy = false;
  const check = (id) => {
    if (id !== registration.target_id) fail("UNKNOWN_MIGRATION_REFERENCE");
  };
  return {
    async write(id, value, { cas, intent }) {
      check(id);
      uuid(intent);
      if (busy) fail("MIGRATION_BUSY", 409);
      if (cas !== registration.expected_version || db.all("rotation").length)
        fail("MIGRATION_ALREADY_RESERVED", 409);
      busy = true;
      try {
        db.put("rotation", { id: intent, state: "reserved", version: cas + 1 });
        const c = await broker.rotate(
          humanProof,
          registration.connection_id,
          registration.expected_revision,
          value,
        );
        const read = await vault.read(path, cas + 1);
        if (
          c.id !== registration.connection_id ||
          c.revision !== registration.expected_revision + 1 ||
          c.credential_version !== cas + 1 ||
          read.value !== value
        )
          fail("TRANSFER_NOT_VERIFIED");
        db.put("rotation", {
          id: intent,
          state: "committed",
          version: cas + 1,
          vault_intent: uuid(read.intent),
        });
        return { version: cas + 1 };
      } finally {
        busy = false;
      }
    },
    async read(id, version) {
      check(id);
      const r = db.all("rotation")[0];
      if (!r || r.state !== "committed" || r.version !== version)
        fail("ROTATION_RECONCILE_REQUIRED", 409);
      const c = await broker.detail(humanProof, registration.connection_id);
      if (
        c.credential_version !== version ||
        c.revision !== registration.expected_revision + 1
      )
        fail("TARGET_CHANGED", 409);
      const raw = await vault.read(path, version);
      if (raw.intent !== r.vault_intent) fail("TARGET_CHANGED", 409);
      return { value: raw.value, version: raw.version, intent: r.id };
    },
    async ready(plan, version) {
      check(plan.target_id);
      const c = await broker.detail(humanProof, registration.connection_id);
      const g = c.assignments.find((x) => x.id === plan.grant_id);
      return (
        c.id === plan.connection_id &&
        c.owner_id === plan.owner_id &&
        c.status === "active" &&
        c.readiness?.state === "ready" &&
        c.credential_version === version &&
        g?.revoked === false &&
        g.project_id === plan.project_id &&
        g.agent_id === plan.agent_id &&
        g.user_id === plan.owner_id &&
        g.expires_at > Date.now() &&
        plan.operations.every((x) => g.operations.includes(x)) &&
        plan.resources.every((x) => g.resources.includes(x)) &&
        plan.limits.max_actions <= g.limits.max_actions &&
        plan.limits.max_seconds <= g.limits.max_seconds
      );
    },
    close() {
      if (busy) fail("MIGRATION_BUSY", 409);
      db.close();
    },
  };
}
