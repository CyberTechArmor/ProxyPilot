import { randomBytes } from "node:crypto";
import { openStore } from "./store.mjs";
import { isConfiguredAuthority } from "./authority.mjs";
import {
  VERSION,
  fail,
  exact,
  uuid,
  string,
  list,
  operation,
  limits,
  subset,
  narrow,
  input,
  digest,
  id,
  BrokerError,
} from "./schema.mjs";

/** Synthetic only. authority authenticates fresh independent operator proof and current identity/task facts.
 * Neither an agent bearer nor a dashboard-signed assertion is operator authority. */
export function createBroker({
  dbPath,
  vault,
  upstream,
  authority,
  clock = () => Date.now(),
  mode = "disabled",
}) {
  if (
    (mode !== "synthetic" &&
      !(mode === "configured" && isConfiguredAuthority(authority))) ||
    !vault ||
    !upstream ||
    !authority?.authenticate ||
    !authority?.eligible ||
    !authority?.canAssign
  )
    fail("BROKER_NOT_ACTIVATED", 503);
  const db = openStore(dbPath),
    locks = new Map();
  const now = () => clock();
  const lock = async (key, fn) => {
    const prev = locks.get(key) || Promise.resolve();
    let release;
    const next = new Promise((r) => (release = r));
    locks.set(key, next);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (locks.get(key) === next) locks.delete(key);
    }
  };
  const event = (type, c, actor) =>
    db.put("event", {
      id: id(),
      type,
      connection_id: c.id,
      revision: c.revision,
      actor_id: actor,
      at: now(),
    });
  const get = (kind, key) => {
    uuid(key);
    const r = db.get(kind, key);
    if (!r) fail("NOT_FOUND", 404);
    return r;
  };
  const human = async (proof, action = "management") => {
    let p;
    try {
      p = await authority.authenticate(proof);
    } catch {
      fail("AUTH_REQUIRED", 401);
    }
    if (!p || !p.user_id) fail("AUTH_REQUIRED", 401);
    if (mode === "configured") {
      if (p.proof_type === "workload" && action !== "issueSession")
        fail("NOT_PERMITTED", 403);
      if (action === "issueSession" && p.proof_type !== "workload")
        fail("NOT_PERMITTED", 403);
      if (
        [
          "approve",
          "previewApproval",
          "setPermission",
          "reconcileOperation",
          "revalidatePolicy",
          "enroll",
          "rotate",
        ].includes(action) &&
        p.proof_type !== "human"
      )
        fail("NOT_PERMITTED", 403);
    }
    uuid(p.user_id);
    if (p.disabled === true) fail("NOT_PERMITTED", 403);
    if (!Number.isFinite(p.fresh_until) || p.fresh_until <= now())
      fail("FRESH_PROOF_REQUIRED", 401);
    return p;
  };
  const configuredAuthorize = async (proof, action, connection, body = {}) => {
    if (mode !== "configured") return;
    const principal = await human(proof, action);
    if (
      (await authority.authorize(principal, {
        action,
        id: connection?.id,
        connection,
        body,
      })) !== true
    )
      fail("NOT_PERMITTED", 403);
  };
  const rights = (c, u) =>
    c.owner_id === u
      ? {
          rights: ["view", "use", "assign", "manage"],
          operations: c.operations,
          resources: c.resources,
          limits: c.limits,
          manage_actions: ["test", "rename", "rotate", "revoke", "permissions"],
        }
      : c.permissions.find((p) => p.user_id === u && p.expires_at > now()) || {
          rights: [],
        };
  const access = (c, u, right) => {
    const r = rights(c, u);
    if (!r.rights.includes("view")) fail("NOT_FOUND", 404);
    if (!r.rights.includes(right)) fail("NOT_PERMITTED", 403);
    return r;
  };
  const management = (c, u, action) => {
    const r = access(c, u, "manage");
    if (
      c.policy_revalidation_required &&
      (action !== "revoke" || c.owner_id !== u)
    )
      fail("NOT_PERMITTED", 403);
    if (!r.manage_actions?.includes(action)) fail("NOT_PERMITTED", 403);
    return r;
  };
  const rev = (c, r) => {
    if (!Number.isSafeInteger(r)) fail("REVISION_REQUIRED", 428);
    if (c.revision !== r) fail("REVISION_MISMATCH", 409);
  };
  const publicSession = (s) => ({
    id: s.id,
    user_id: s.user_id,
    agent_id: s.agent_id,
    task_id: s.task_id,
    project_id: s.project_id,
    attempt: s.attempt,
    fence: s.fence,
    audience: s.audience,
    operations: s.operations,
    resources: s.resources,
    limits: s.limits,
    credential_version: s.credential_version,
    policy_revision: s.policy_revision,
    grant_revision: s.grant_revision,
    grant_id: s.grant_id,
    connection_id: s.connection_id,
    expires_at: s.expires_at,
    revoked: s.revoked,
    connection_revision: s.connection_revision,
  });
  const projection = (c, u) => ({
    id: c.id,
    name: c.name,
    owner_id: c.owner_id,
    project_id: c.project_id,
    adapter_id: c.adapter_id,
    revision: c.revision,
    policy_revision: c.policy_revision,
    credential_version: c.credential_version,
    status: c.status,
    operations: c.operations,
    resources: c.resources,
    limits: c.limits,
    rights: rights(c, u).rights,
    readiness: {
      state:
        c.status === "active" && !c.policy_revalidation_required
          ? "ready"
          : "blocked",
      code: c.policy_revalidation_required
        ? "POLICY_REVALIDATION_REQUIRED"
        : c.status === "active"
          ? "SYNTHETIC_ONLY"
          : c.status === "revoked"
            ? "CONNECTION_REVOKED"
            : "CONNECTION_UNVERIFIED",
    },
    assignments: db
      .all("grant")
      .filter(
        (g) =>
          g.connection_id === c.id && (c.owner_id === u || g.user_id === u),
      )
      .map((g) => ({ ...g })),
    sessions: db
      .all("session")
      .filter(
        (s) =>
          s.connection_id === c.id && (c.owner_id === u || s.user_id === u),
      )
      .map(publicSession),
  });
  const validateCurrent = (s) => {
    const stored = db.get("session", s.id);
    if (
      s.revoked ||
      stored?.revoked ||
      s.expires_at <= now() ||
      s.audience !== "fractionate-broker"
    )
      fail("NOT_PERMITTED", 403);
    const c = get("connection", s.connection_id),
      g = get("grant", s.grant_id);
    if (
      c.policy_revalidation_required ||
      c.status !== "active" ||
      c.revision !== s.connection_revision ||
      c.credential_version !== s.credential_version ||
      g.revoked ||
      g.revision !== s.grant_revision ||
      g.expires_at <= now()
    )
      fail("NOT_PERMITTED", 403);
    const permission = rights(c, s.user_id);
    if (!permission.rights.includes("use")) fail("NOT_PERMITTED", 403);
    for (const scope of [c, g, permission]) {
      subset(s.operations, scope.operations);
      subset(s.resources, scope.resources);
      narrow(s.limits, scope.limits);
    }
    return { c, g };
  };
  const current = async (s) => {
    validateCurrent(s);
    let eligible = false;
    try {
      eligible = await authority.eligible({ ...s });
    } catch {
      fail("BROKER_UNAVAILABLE", 503);
    }
    if (eligible !== true) fail("NOT_PERMITTED", 403);
    return validateCurrent(s);
  };
  const unchanged = (c) => {
    const latest = get("connection", c.id);
    if (
      latest.policy_revalidation_required !== c.policy_revalidation_required ||
      latest.revision !== c.revision ||
      latest.status === "revoked"
    )
      fail("NOT_PERMITTED", 403);
    return latest;
  };
  const session = (token) => {
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token))
      fail("AUTH_REQUIRED", 401);
    const s = db.all("session").find((s) => s.verifier === digest(token));
    if (!s) fail("AUTH_REQUIRED", 401);
    return s;
  };
  const normalized = (s, request) => {
    exact(
      request,
      ["connection_id", "operation", "input", "approval_id", "recovery_of"],
      ["connection_id", "operation", "input"],
    );
    uuid(request.connection_id);
    operation(request.operation);
    input(request.operation, request.input);
    if (request.approval_id) uuid(request.approval_id);
    if (request.recovery_of) uuid(request.recovery_of);
    if (request.connection_id !== s.connection_id) fail("NOT_FOUND", 404);
    subset([request.operation], s.operations);
    subset([request.input.resource_id], s.resources);
    return {
      connection_id: request.connection_id,
      operation: request.operation,
      input: request.input,
      recovery_of: request.recovery_of || null,
    };
  };
  const opDigest = (s, r) =>
    digest({
      request: r,
      session_id: s.id,
      user_id: s.user_id,
      agent_id: s.agent_id,
      project_id: s.project_id,
      task_id: s.task_id,
      attempt: s.attempt,
      fence: s.fence,
      audience: s.audience,
      expires_at: s.expires_at,
      connection_revision: s.connection_revision,
      grant_revision: s.grant_revision,
      credential_version: s.credential_version,
    });
  const receipt = (o) => ({
    id: o.id,
    connection_id: o.connection_id,
    operation: o.operation,
    state: o.state,
    code: o.code || null,
    result: o.result || null,
    created_at: o.created_at,
    completed_at: o.completed_at || null,
    recovery_of: o.recovery_of,
    cost: { state: "not_applicable", amount: null },
  });
  const invalidate = (c) => {
    for (const s of db.all("session"))
      if (s.connection_id === c.id) db.put("session", { ...s, revoked: true });
    for (const a of db.all("approval"))
      if (a.connection_id === c.id)
        db.put("approval", { ...a, consumed: true });
  };
  const validateScope = (r) => {
    list(r.operations, operation);
    list(r.resources, uuid);
    limits(r.limits);
  };
  async function enroll(proof, request, credential, externalIntentId = null) {
    if (externalIntentId !== null) uuid(externalIntentId);
    const p = await human(proof, "enroll");
    if (
      externalIntentId &&
      db
        .all("connection")
        .some((c) => c.enrollment.external_intent_id === externalIntentId)
    )
      fail("IDEMPOTENCY_CONFLICT", 409);
    exact(request, [
      "name",
      "project_id",
      "adapter_id",
      "operations",
      "resources",
      "limits",
    ]);
    string(request.name);
    if (request.project_id !== null) uuid(request.project_id);
    if (request.adapter_id !== "synthetic-ledger-v1") fail("INVALID_REQUEST");
    validateScope(request);
    string(credential, 4096);
    const cid = id(),
      credential_id = uuid(
        vault.allocateCredentialId
          ? vault.allocateCredentialId(p.user_id)
          : id(),
      ),
      intent = id();
    const path = `owners/${p.user_id}/credentials/${credential_id}`;
    const c = {
      ...request,
      id: cid,
      owner_id: p.user_id,
      revision: 1,
      policy_revision: 1,
      credential_version: 0,
      status: "saved",
      credential_id,
      vault_path: path,
      permissions: [],
      enrollment: {
        id: intent,
        external_intent_id: externalIntentId,
        state: "reserved",
        expected_version: 1,
      },
    };
    return lock(cid, async () => {
      db.put("connection", c);
      event("enrollment_reserved", c, p.user_id);
      try {
        const written = await vault.write(path, credential, {
          cas: 0,
          intent,
          beforeSend: () =>
            configuredAuthorize(proof, "enroll", undefined, request),
        });
        const read = await vault.read(path, written.version);
        if (
          written.version !== 1 ||
          read.value !== credential ||
          read.intent !== intent
        )
          fail("BROKER_UNAVAILABLE", 503);
        if (
          get("connection", c.id).revision !== c.revision ||
          get("connection", c.id).status === "revoked"
        )
          fail("NOT_PERMITTED", 403);
        c.credential_version = 1;
        c.enrollment.state = "committed";
        db.put("connection", c);
        event("enrolled", c, p.user_id);
        return projection(c, p.user_id);
      } catch {
        const latest = get("connection", c.id);
        latest.enrollment.state = "reconcile_required";
        db.put("connection", latest);
        event("enrollment_reconcile_required", c, p.user_id);
        fail("ENROLLMENT_RECONCILE_REQUIRED", 409);
      }
    });
  }
  async function reconcileEnrollment(proof, connectionId, revision) {
    const p = await human(proof);
    return lock(connectionId, async () => {
      const c = get("connection", connectionId);
      management(c, p.user_id, "rotate");
      rev(c, revision);
      if (c.enrollment.state !== "reconcile_required") fail("INVALID_REQUEST");
      let r;
      try {
        r = await vault.read(c.vault_path, c.enrollment.expected_version);
      } catch {
        fail("BROKER_UNAVAILABLE", 503);
      }
      if (
        r.intent !== c.enrollment.id ||
        r.version !== c.enrollment.expected_version
      )
        fail("ENROLLMENT_RECONCILE_REQUIRED", 409);
      unchanged(c);
      c.credential_version = r.version;
      c.enrollment.state = "committed";
      c.revision++;
      db.put("connection", c);
      event("enrollment_reconciled", c, p.user_id);
      return projection(c, p.user_id);
    });
  }
  async function rotate(proof, connectionId, revision, credential) {
    const p = await human(proof, "rotate");
    string(credential, 4096);
    return lock(connectionId, async () => {
      const c = get("connection", connectionId);
      management(c, p.user_id, "rotate");
      rev(c, revision);
      if (c.status === "revoked" || c.enrollment.state !== "committed")
        fail("NOT_PERMITTED", 403);
      c.status = "saved";
      c.revision++;
      c.enrollment = {
        id: id(),
        state: "reserved",
        expected_version: c.credential_version + 1,
      };
      db.tx(() => {
        invalidate(c);
        db.put("connection", c);
        event("rotation_reserved", c, p.user_id);
      });
      try {
        const w = await vault.write(c.vault_path, credential, {
          cas: c.credential_version,
          intent: c.enrollment.id,
          beforeSend: () =>
            configuredAuthorize(proof, "rotate", projection(c, p.user_id)),
        });
        const r = await vault.read(c.vault_path, w.version);
        if (
          w.version !== c.enrollment.expected_version ||
          r.value !== credential ||
          r.intent !== c.enrollment.id
        )
          fail("BROKER_UNAVAILABLE", 503);
        if (
          get("connection", c.id).revision !== c.revision ||
          get("connection", c.id).status === "revoked"
        )
          fail("NOT_PERMITTED", 403);
        c.credential_version = w.version;
        c.enrollment.state = "committed";
        db.put("connection", c);
        event("rotated", c, p.user_id);
        return projection(c, p.user_id);
      } catch {
        const latest = get("connection", c.id);
        latest.enrollment.state = "reconcile_required";
        db.put("connection", latest);
        fail("ENROLLMENT_RECONCILE_REQUIRED", 409);
      }
    });
  }
  async function testConnection(proof, connectionId, revision) {
    const p = await human(proof);
    return lock(connectionId, async () => {
      const c = get("connection", connectionId);
      management(c, p.user_id, "test");
      rev(c, revision);
      if (c.status === "revoked" || c.enrollment.state !== "committed")
        fail("NOT_PERMITTED", 403);
      try {
        const secret = await vault.read(c.vault_path, c.credential_version);
        unchanged(c);
        await upstream.execute(
          "item.read",
          { resource_id: c.resources[0] },
          secret.value,
          {
            beforeSend: async () => {
              await configuredAuthorize(
                proof,
                "test",
                projection(c, p.user_id),
                {
                  operation: "item.read",
                  input: { resource_id: c.resources[0] },
                },
              );
              unchanged(c);
            },
          },
        );
        if (
          get("connection", c.id).revision !== c.revision ||
          get("connection", c.id).status === "revoked"
        )
          fail("NOT_PERMITTED", 403);
        c.status = "active";
        db.put("connection", c);
        event("tested", c, p.user_id);
        return projection(c, p.user_id);
      } catch {
        fail("CONNECTION_TEST_FAILED", 503);
      }
    });
  }
  async function assign(proof, connectionId, revision, request) {
    const p = await human(proof);
    exact(request, [
      "user_id",
      "project_id",
      "agent_id",
      "operations",
      "resources",
      "limits",
      "expires_at",
    ]);
    uuid(request.user_id);
    uuid(request.agent_id);
    uuid(request.project_id);
    validateScope(request);
    return lock(connectionId, async () => {
      const c = get("connection", connectionId),
        r = access(c, p.user_id, "assign");
      if (c.policy_revalidation_required) fail("NOT_PERMITTED", 403);
      rev(c, revision);
      subset(request.operations, r.operations);
      subset(request.resources, r.resources);
      narrow(request.limits, r.limits);
      if (c.project_id !== null && request.project_id !== c.project_id)
        fail("SCOPE_EXCEEDED", 403);
      const receiver = rights(c, request.user_id);
      if (!receiver.rights.includes("use")) fail("SCOPE_EXCEEDED", 403);
      subset(request.operations, receiver.operations);
      subset(request.resources, receiver.resources);
      narrow(request.limits, receiver.limits);
      if (r.expires_at && request.expires_at > r.expires_at)
        fail("SCOPE_EXCEEDED", 403);
      if (
        !Number.isFinite(request.expires_at) ||
        request.expires_at <= now() ||
        request.expires_at > now() + 86400000
      )
        fail("INVALID_REQUEST");
      if (
        (await authority.canAssign(p, { ...request, connection_id: c.id })) !==
        true
      )
        fail("NOT_PERMITTED", 403);
      unchanged(c);
      const g = {
        ...request,
        id: id(),
        connection_id: c.id,
        revision: 1,
        revoked: false,
        authorizing_event: id(),
      };
      db.put("grant", g);
      event("assigned", c, p.user_id);
      return g;
    });
  }
  async function setPermission(proof, connectionId, revision, request) {
    const p = await human(proof, "setPermission");
    exact(request, [
      "user_id",
      "rights",
      "operations",
      "resources",
      "limits",
      "expires_at",
      "manage_actions",
    ]);
    uuid(request.user_id);
    if (
      !Array.isArray(request.manage_actions) ||
      request.manage_actions.some(
        (x) => !["test", "rename", "rotate", "revoke"].includes(x),
      )
    )
      fail("INVALID_REQUEST");
    list(request.rights, (x) => {
      if (!["view", "use", "assign", "manage"].includes(x))
        fail("INVALID_REQUEST");
    });
    validateScope(request);
    return lock(connectionId, async () => {
      const c = get("connection", connectionId);
      access(c, p.user_id, "manage");
      if (c.policy_revalidation_required) fail("NOT_PERMITTED", 403);
      if (c.owner_id !== p.user_id) fail("NOT_PERMITTED", 403);
      rev(c, revision);
      if (
        !request.rights.includes("view") ||
        !Number.isFinite(request.expires_at) ||
        request.expires_at <= now() ||
        request.expires_at > now() + 86400000
      )
        fail("INVALID_REQUEST");
      subset(request.operations, c.operations);
      subset(request.resources, c.resources);
      narrow(request.limits, c.limits);
      c.permissions = c.permissions
        .filter((x) => x.user_id !== request.user_id)
        .concat(request);
      c.revision++;
      c.policy_revision++;
      db.tx(() => {
        invalidate(c);
        db.put("connection", c);
        event("permission_changed", c, p.user_id);
      });
      return projection(c, p.user_id);
    });
  }
  async function issueSession(proof, grantId, request) {
    const p = await human(proof, "issueSession");
    if (
      mode === "configured" &&
      digest(p.workload_scope) !== digest({ grant_id: grantId, ...request })
    )
      fail("NOT_PERMITTED", 403);
    exact(request, [
      "task_id",
      "attempt",
      "fence",
      "operations",
      "resources",
      "limits",
      "expires_at",
      "audience",
    ]);
    uuid(request.task_id);
    uuid(request.attempt);
    uuid(request.fence);
    validateScope(request);
    if (request.audience !== "fractionate-broker") fail("INVALID_REQUEST");
    const g = get("grant", grantId);
    if (g.user_id !== p.user_id) fail("NOT_FOUND", 404);
    return lock(g.connection_id, async () => {
      const c = get("connection", g.connection_id);
      access(c, p.user_id, "use");
      if (g.user_id !== p.user_id || g.revoked) fail("NOT_PERMITTED", 403);
      subset(request.operations, g.operations);
      subset(request.resources, g.resources);
      narrow(request.limits, g.limits);
      const r = rights(c, p.user_id);
      subset(request.operations, r.operations);
      subset(request.resources, r.resources);
      narrow(request.limits, r.limits);
      if (
        !Number.isFinite(request.expires_at) ||
        request.expires_at <= now() ||
        request.expires_at >
          Math.min(g.expires_at, now() + request.limits.max_seconds * 1000)
      )
        fail("INVALID_REQUEST");
      const token = randomBytes(32).toString("base64url");
      const s = {
        ...request,
        id: id(),
        verifier: digest(token),
        connection_id: c.id,
        grant_id: g.id,
        user_id: g.user_id,
        agent_id: g.agent_id,
        project_id: g.project_id,
        connection_revision: c.revision,
        credential_version: c.credential_version,
        policy_revision: c.policy_revision,
        grant_revision: g.revision,
        revoked: false,
        used: 0,
      };
      await current(s);
      db.put("session", s);
      event("session_issued", c, p.user_id);
      return { session: publicSession(s), bearer: token };
    });
  }
  async function previewApproval(proof, sessionId, request) {
    const p = await human(proof, "previewApproval"),
      s = get("session", sessionId);
    if (s.user_id !== p.user_id) fail("NOT_FOUND", 404);
    await current(s);
    const r = normalized(s, request);
    if (r.operation !== "item.set_state") fail("INVALID_REQUEST");
    return {
      digest: opDigest(s, r),
      request: r,
      session_id: s.id,
      user_id: s.user_id,
      agent_id: s.agent_id,
      project_id: s.project_id,
      task_id: s.task_id,
      attempt: s.attempt,
      fence: s.fence,
      connection_revision: s.connection_revision,
      credential_version: s.credential_version,
      grant_revision: s.grant_revision,
      limits: s.limits,
      expires_at: Math.min(now() + 120000, s.expires_at),
    };
  }
  async function approve(proof, sessionId, request) {
    const p = await human(proof, "approve"),
      s = get("session", sessionId);
    if (s.user_id !== p.user_id) fail("NOT_FOUND", 404);
    return lock(s.connection_id, async () => {
      const { c } = await current(s);
      if (
        p.user_id !== s.user_id ||
        !rights(c, p.user_id).rights.includes("use")
      )
        fail("NOT_PERMITTED", 403);
      const r = normalized(s, request);
      if (r.operation !== "item.set_state") fail("INVALID_REQUEST");
      const a = {
        id: id(),
        connection_id: c.id,
        session_id: s.id,
        digest: opDigest(s, r),
        expires_at: Math.min(now() + 120000, s.expires_at),
        consumed: false,
      };
      db.put("approval", a);
      event("approved", c, p.user_id);
      return { id: a.id, digest: a.digest, expires_at: a.expires_at };
    });
  }
  async function execute(token, request, idempotencyKey) {
    string(idempotencyKey, 128);
    if (!/^[A-Za-z0-9_-]+$/.test(idempotencyKey)) fail("INVALID_REQUEST");
    const initial = session(token),
      r = normalized(initial, request);
    return lock(initial.connection_id, async () => {
      const s = session(token),
        { c } = await current(s),
        d = opDigest(s, r);
      const key = digest(s.id + ":" + idempotencyKey);
      const old = db.all("operation").find((o) => o.key === key);
      if (old) {
        if (old.digest !== d) fail("IDEMPOTENCY_CONFLICT", 409);
        return receipt(old);
      }
      if (r.recovery_of) {
        const old = get("operation", r.recovery_of);
        if (
          old.connection_id !== s.connection_id ||
          old.state !== "uncertain" ||
          old.reconciled?.decision !== "confirmed_not_applied"
        )
          fail("NOT_PERMITTED", 403);
      }
      if (
        db
          .all("operation")
          .filter((o) => o.task_id === s.task_id && o.connection_id === c.id)
          .length >= s.limits.max_actions ||
        db
          .all("operation")
          .filter(
            (o) => o.connection_id === c.id && o.created_at > now() - 60000,
          ).length >= 10
      )
        fail("LIMIT_EXCEEDED", 429);
      let a;
      if (r.operation === "item.set_state") {
        if (!request.approval_id) fail("APPROVAL_REQUIRED", 403);
        a = get("approval", request.approval_id);
        if (
          a.consumed ||
          a.expires_at <= now() ||
          a.session_id !== s.id ||
          a.digest !== d
        )
          fail("NOT_PERMITTED", 403);
      }
      const o = {
        id: id(),
        key,
        digest: d,
        session_id: s.id,
        task_id: s.task_id,
        connection_id: c.id,
        operation: r.operation,
        state: "reserved",
        created_at: now(),
        recovery_of: r.recovery_of,
      };
      db.tx(() => {
        if (a) db.put("approval", { ...a, consumed: true });
        db.put("session", { ...s, used: s.used + 1 });
        db.put("operation", o);
      });
      let secret;
      try {
        secret = await vault.read(c.vault_path, c.credential_version);
        await current(session(token));
        if (a && a.expires_at <= now()) fail("NOT_PERMITTED", 403);
      } catch {
        db.put("operation", {
          ...o,
          state: "failed",
          code: "BROKER_UNAVAILABLE",
          completed_at: now(),
        });
        return receipt(db.get("operation", o.id));
      }
      db.put("operation", { ...o, state: "sending" });
      try {
        const result = await upstream.execute(
          r.operation,
          r.input,
          secret.value,
          {
            beforeSend: async () => {
              await current(session(token));
              if (a && a.expires_at <= now()) fail("NOT_PERMITTED", 403);
            },
          },
        ); // Result schema checked again at trust boundary, even for injected adapters.
        exact(
          result,
          r.operation === "item.read"
            ? ["resource_id", "state"]
            : ["resource_id", "state", "applied"],
        );
        if (
          result.resource_id !== r.input.resource_id ||
          !["open", "closed"].includes(result.state) ||
          (r.operation !== "item.read" &&
            (typeof result.applied !== "boolean" ||
              result.state !== r.input.state))
        )
          fail("UPSTREAM_REJECTED", 502);
        db.put("operation", {
          ...o,
          state: "succeeded",
          result,
          completed_at: now(),
        });
      } catch {
        db.put("operation", {
          ...o,
          state: r.operation === "item.read" ? "failed" : "uncertain",
          code:
            r.operation === "item.read"
              ? "UPSTREAM_REJECTED"
              : "OPERATION_UNCERTAIN",
          completed_at: now(),
        });
      }
      return receipt(db.get("operation", o.id));
    });
  }
  async function revoke(proof, connectionId, revision) {
    const p = await human(proof);
    return (async () => {
      const c = get("connection", connectionId);
      management(c, p.user_id, "revoke");
      rev(c, revision);
      c.status = "revoked";
      c.revision++;
      db.tx(() => {
        invalidate(c);
        db.put("connection", c);
        event("revoked", c, p.user_id);
      });
      return projection(c, p.user_id);
    })();
  }
  async function unassign(proof, grantId, revision) {
    const p = await human(proof),
      g = get("grant", grantId);
    return (async () => {
      const c = get("connection", g.connection_id);
      access(c, p.user_id, "assign");
      const currentGrant = get("grant", grantId);
      rev(currentGrant, revision);
      if (
        (await (mode === "configured"
          ? authority.canUnassign(p, currentGrant)
          : authority.canAssign(p, currentGrant))) !== true
      )
        fail("NOT_PERMITTED", 403);
      unchanged(c);
      rev(get("grant", grantId), revision);
      db.tx(() => {
        db.put("grant", {
          ...currentGrant,
          revoked: true,
          revision: currentGrant.revision + 1,
        });
        for (const s of db.all("session"))
          if (s.grant_id === g.id) db.put("session", { ...s, revoked: true });
        event("unassigned", c, p.user_id);
      });
      return { id: g.id, revoked: true, revision: currentGrant.revision + 1 };
    })();
  }
  async function enrollmentStatus(proof, externalIntentId) {
    uuid(externalIntentId);
    const p = await human(proof),
      c = db
        .all("connection")
        .find(
          (c) =>
            c.owner_id === p.user_id &&
            c.enrollment.external_intent_id === externalIntentId,
        );
    if (!c) fail("NOT_FOUND", 404);
    return {
      connection_id: c.id,
      status: c.enrollment.state,
      enrollment_state: c.enrollment.state,
      credential_version: c.credential_version,
      revision: c.revision,
    };
  }
  async function listAssignableConnections(proof, { project_id, agent_id }) {
    uuid(project_id);
    uuid(agent_id);
    const p = await human(proof);
    const result = [];
    for (const c of db.all("connection")) {
      const r = rights(c, p.user_id);
      if (
        !r.rights.includes("view") ||
        !r.rights.includes("assign") ||
        (c.project_id && c.project_id !== project_id) ||
        c.status === "revoked"
      )
        continue;
      if (
        (await authority.canAssign(p, {
          project_id,
          agent_id,
          connection_id: c.id,
          user_id: p.user_id,
        })) === true
      ) {
        unchanged(c);
        result.push(projection(c, p.user_id));
      }
    }
    return result;
  }
  async function detail(proof, connectionId) {
    const p = await human(proof),
      c = get("connection", connectionId);
    access(c, p.user_id, "view");
    return projection(c, p.user_id);
  }
  async function listConnections(proof, { project_id = null } = {}) {
    const p = await human(proof);
    if (project_id !== null) uuid(project_id);
    return db
      .all("connection")
      .filter(
        (c) =>
          rights(c, p.user_id).rights.includes("view") &&
          (!project_id || c.project_id === null || c.project_id === project_id),
      )
      .map((c) => projection(c, p.user_id));
  }
  async function activity(proof, connectionId) {
    const p = await human(proof),
      c = get("connection", connectionId);
    access(c, p.user_id, "view");
    const events = db
      .all("event")
      .filter(
        (e) =>
          e.connection_id === c.id &&
          (c.owner_id === p.user_id || e.actor_id === p.user_id),
      );
    const operations = db
      .all("operation")
      .filter(
        (o) =>
          o.connection_id === c.id &&
          (c.owner_id === p.user_id ||
            db.get("session", o.session_id)?.user_id === p.user_id),
      )
      .map((o) => ({
        ...receipt(o),
        type: "operation",
        status: o.state,
        actor_id: db.get("session", o.session_id)?.user_id,
        revision: db.get("session", o.session_id)?.connection_revision,
        at: o.completed_at || o.created_at,
      }));
    return [...events, ...operations].sort((a, b) => a.at - b.at);
  }
  async function rename(proof, connectionId, revision, name) {
    const p = await human(proof);
    string(name);
    return lock(connectionId, async () => {
      const c = get("connection", connectionId);
      management(c, p.user_id, "rename");
      rev(c, revision);
      c.name = name;
      c.revision++;
      db.tx(() => {
        invalidate(c);
        db.put("connection", c);
        event("renamed", c, p.user_id);
      });
      return projection(c, p.user_id);
    });
  }
  async function getOperation(token, operationId) {
    const s = session(token);
    await current(s);
    const o = get("operation", operationId);
    if (o.session_id !== s.id) fail("NOT_FOUND", 404);
    return receipt(o);
  }
  async function reconcileOperation(proof, operationId, decision) {
    const p = await human(proof, "reconcileOperation"),
      o = get("operation", operationId),
      c = get("connection", o.connection_id);
    if (c.owner_id !== p.user_id) fail("NOT_FOUND", 404);
    if (
      !["confirmed_applied", "confirmed_not_applied", "abandon"].includes(
        decision,
      ) ||
      o.state !== "uncertain" ||
      o.reconciled
    )
      fail("INVALID_REQUEST");
    db.put("operation", {
      ...o,
      reconciled: { decision, actor_id: p.user_id, at: now() },
    });
    event("operation_reconciled", c, p.user_id);
    return receipt(o);
  }
  async function revalidatePolicy(proof, connectionId, revision) {
    const p = await human(proof, "revalidatePolicy");
    return lock(connectionId, async () => {
      const c = get("connection", connectionId);
      if (c.owner_id !== p.user_id) fail("NOT_FOUND", 404);
      rev(c, revision);
      if (
        typeof authority.revalidatePolicy !== "function" ||
        (await authority.revalidatePolicy(p, {
          connection: projection(c, p.user_id),
        })) !== true
      )
        fail("NOT_PERMITTED", 403);
      unchanged(c);
      c.policy_revalidation_required = false;
      c.revision++;
      db.put("connection", c);
      event("policy_revalidated", c, p.user_id);
      return projection(c, p.user_id);
    });
  }
  return {
    revalidatePolicy,
    enroll,
    enrollmentStatus,
    listAssignableConnections,
    reconcileEnrollment,
    rotate,
    testConnection,
    assign,
    setPermission,
    issueSession,
    approve,
    previewApproval,
    execute,
    revoke,
    unassign,
    detail,
    listConnections,
    activity,
    rename,
    getOperation,
    reconcileOperation,
    capabilities: () => ({
      contract_version: VERSION,
      mode,
      intake_enabled: true,
      execution_enabled: true,
      adapters: [
        {
          id: "synthetic-ledger-v1",
          type: "static_api_token",
          supported: true,
        },
      ],
      reason:
        mode === "synthetic"
          ? "SYNTHETIC_ONLY"
          : "CONFIGURED_AUTHORITY_REQUIRED",
    }),
    close: () => db.close(),
  };
}
