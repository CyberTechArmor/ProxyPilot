/** Supplemental in-process policy proofs. Vault/upstream are deliberate mocks;
 * real OpenBao/transport evidence is provided separately by integration tests. */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBroker } from "../broker.mjs";

const deny = (promise, code) => assert.rejects(promise, (e) => e.code === code);
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "broker-policy-")),
    dbPath = join(dir, "state.db");
  const ids = Object.fromEntries(
    [
      "owner",
      "user",
      "assigner",
      "manager",
      "other",
      "project",
      "agent",
      "task",
      "attempt",
      "fence",
      "resource",
      "elsewhere",
    ].map((k) => [k, randomUUID()]),
  );
  let time = 1900000000000,
    eligible = true,
    assignable = true,
    readHook = null,
    sendHook = null,
    eligibleHook = null,
    assignHook = null;
  const canary = randomBytes(32).toString("hex"),
    values = new Map(),
    sends = [];
  const scope = {
    operations: ["item.read", "item.set_state"],
    resources: [ids.resource],
    limits: { max_actions: 10, max_seconds: 300 },
  };
  const authority = {
    authenticate: async (proof) => ({
      user_id: ids[proof],
      fresh_until: time + 10000,
    }),
    eligible: async () => {
      if (eligibleHook) await eligibleHook();
      return eligible;
    },
    canAssign: async () => {
      if (assignHook) await assignHook();
      return assignable;
    },
  };
  const vault = {
    write: async (path, value, { cas, intent }) => {
      const versions = values.get(path) || [];
      assert.equal(cas, versions.length);
      versions.push({ value, intent, version: versions.length + 1 });
      values.set(path, versions);
      return { version: versions.length };
    },
    read: async (path, version) => {
      if (readHook) await readHook();
      return values.get(path)[version - 1];
    },
  };
  const upstream = {
    execute: async (op, input, secret) => {
      assert.equal(typeof secret, "string");
      sends.push({ op, input });
      if (sendHook) return sendHook(op, input, secret);
      return {
        resource_id: input.resource_id,
        state: input.state || "open",
        ...(op === "item.read" ? {} : { applied: true }),
      };
    },
  };
  const opts = {
    dbPath,
    vault,
    upstream,
    authority,
    clock: () => time,
    mode: "synthetic",
  };
  let broker = createBroker(opts);
  t.after(() => {
    broker.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const f = {
    ids,
    scope,
    canary,
    dir,
    dbPath,
    values,
    sends,
    get broker() {
      return broker;
    },
    setEligibleHook: (h) => (eligibleHook = h),
    setAssignHook: (h) => (assignHook = h),
    setReadHook: (h) => (readHook = h),
    setSendHook: (h) => (sendHook = h),
    setEligible: (v) => (eligible = v),
    setAssignable: (v) => (assignable = v),
    advance: (n) => (time += n),
    enroll: () =>
      broker.enroll(
        "owner",
        {
          name: "Disposable ledger",
          project_id: ids.project,
          adapter_id: "synthetic-ledger-v1",
          ...scope,
        },
        canary,
      ),
    permission: async (c, user, rights, overrides = {}) =>
      broker.setPermission("owner", c.id, c.revision, {
        user_id: ids[user],
        rights,
        ...scope,
        expires_at: time + 3600000,
        manage_actions: [],
        ...overrides,
      }),
    assign: async (c, proof = "owner", user = "owner", overrides = {}) =>
      broker.assign(proof, c.id, c.revision, {
        user_id: ids[user],
        project_id: ids.project,
        agent_id: ids.agent,
        ...scope,
        expires_at: time + 3600000,
        ...overrides,
      }),
    issue: async (g, proof = "owner", overrides = {}) =>
      broker.issueSession(proof, g.id, {
        task_id: ids.task,
        attempt: ids.attempt,
        fence: ids.fence,
        ...scope,
        expires_at: time + 240000,
        audience: "fractionate-broker",
        ...overrides,
      }),
    read: (c) => ({
      connection_id: c.id,
      operation: "item.read",
      input: { resource_id: ids.resource },
    }),
    write: (c) => ({
      connection_id: c.id,
      operation: "item.set_state",
      input: { resource_id: ids.resource, state: "closed" },
    }),
    restart: () => {
      broker.close();
      broker = createBroker(opts);
    },
  };
  f.ready = async () => {
    const c = await f.enroll();
    return broker.testConnection("owner", c.id, c.revision);
  };
  return f;
}

test("private metadata and use/assign/manage are independently enforced", async (t) => {
  const f = await fixture(t);
  let c = await f.ready();
  assert.deepEqual(await f.broker.listConnections("other"), []);
  await deny(f.broker.detail("other", c.id), "NOT_FOUND");
  c = await f.permission(c, "user", ["view", "use"]);
  c = await f.permission(c, "assigner", ["view", "assign"]);
  c = await f.permission(c, "manager", ["view", "manage"], {
    manage_actions: ["rename"],
  });
  await deny(f.assign(c, "user", "user"), "NOT_PERMITTED");
  await deny(f.broker.rename("user", c.id, c.revision, "No"), "NOT_PERMITTED");
  await deny(
    f.broker.testConnection("manager", c.id, c.revision),
    "NOT_PERMITTED",
  );
  await deny(
    f.broker.setPermission("manager", c.id, c.revision, {
      user_id: f.ids.other,
      rights: ["view", "use"],
      ...f.scope,
      expires_at: 1900000100000,
      manage_actions: [],
    }),
    "NOT_PERMITTED",
  );
  const grant = await f.assign(c, "assigner", "user");
  await deny(f.issue(grant, "assigner"), "NOT_FOUND");
  const s = await f.issue(grant, "user");
  assert.equal(
    (await f.broker.execute(s.bearer, f.read(c), "valid")).state,
    "succeeded",
  );
  await deny(
    f.assign(c, "assigner", "user", { resources: [f.ids.elsewhere] }),
    "SCOPE_EXCEEDED",
  );
  await deny(
    f.assign(c, "owner", "user", { project_id: f.ids.elsewhere }),
    "SCOPE_EXCEEDED",
  );
  f.setAssignable(false);
  await deny(f.assign(c), "NOT_PERMITTED");
});

test("wrong connection/resource, audience, stale revisions, eligibility and expiry deny without send", async (t) => {
  const f = await fixture(t),
    c = await f.ready(),
    g = await f.assign(c),
    s = await f.issue(g);
  const before = f.sends.length;
  await deny(
    f.broker.execute(
      s.bearer,
      { ...f.read(c), connection_id: f.ids.elsewhere },
      "wrong-connection",
    ),
    "NOT_FOUND",
  );
  await deny(
    f.broker.execute(
      s.bearer,
      { ...f.read(c), input: { resource_id: f.ids.elsewhere } },
      "wrong-resource",
    ),
    "SCOPE_EXCEEDED",
  );
  await deny(f.issue(g, "owner", { audience: "vault" }), "INVALID_REQUEST");
  await deny(
    f.broker.rename("owner", c.id, c.revision + 1, "stale"),
    "REVISION_MISMATCH",
  );
  f.setEligible(false);
  await deny(
    f.broker.execute(s.bearer, f.read(c), "disabled"),
    "NOT_PERMITTED",
  );
  f.setEligible(true);
  f.advance(240001);
  await deny(f.broker.execute(s.bearer, f.read(c), "expired"), "NOT_PERMITTED");
  assert.equal(f.sends.length, before);
});

test("removing one assignment preserves other assignments; rotation and revoke invalidate capabilities", async (t) => {
  const f = await fixture(t);
  let c = await f.ready();
  const g1 = await f.assign(c),
    g2 = await f.assign(c),
    s1 = await f.issue(g1),
    s2 = await f.issue(g2);
  await f.broker.unassign("owner", g1.id, g1.revision);
  await deny(
    f.broker.execute(s1.bearer, f.read(c), "removed"),
    "NOT_PERMITTED",
  );
  assert.equal(
    (await f.broker.execute(s2.bearer, f.read(c), "remaining")).state,
    "succeeded",
  );
  const a = await f.broker.approve("owner", s2.session.id, f.write(c));
  c = await f.broker.rotate(
    "owner",
    c.id,
    c.revision,
    randomBytes(32).toString("hex"),
  );
  await deny(
    f.broker.execute(
      s2.bearer,
      { ...f.write(c), approval_id: a.id },
      "rotated",
    ),
    "NOT_PERMITTED",
  );
  c = await f.broker.testConnection("owner", c.id, c.revision);
  const s3 = await f.issue(g2);
  await f.broker.revoke("owner", c.id, c.revision);
  await deny(
    f.broker.execute(s3.bearer, f.read(c), "revoked"),
    "NOT_PERMITTED",
  );
  assert.equal((await f.broker.detail("owner", c.id)).status, "revoked");
});

test("write approval binds exact input and is single use; concurrent duplicate sends once", async (t) => {
  const f = await fixture(t),
    c = await f.ready(),
    g = await f.assign(c),
    s = await f.issue(g),
    request = f.write(c);
  const before = f.sends.length;
  await deny(
    f.broker.execute(s.bearer, request, "no-approval"),
    "APPROVAL_REQUIRED",
  );
  const approval = await f.broker.approve("owner", s.session.id, request);
  await deny(
    f.broker.execute(
      s.bearer,
      {
        ...request,
        input: { ...request.input, state: "open" },
        approval_id: approval.id,
      },
      "changed",
    ),
    "NOT_PERMITTED",
  );
  const approved = { ...request, approval_id: approval.id };
  const results = await Promise.all([
    f.broker.execute(s.bearer, approved, "same"),
    f.broker.execute(s.bearer, approved, "same"),
  ]);
  assert.equal(results[0].id, results[1].id);
  assert.equal(results[0].state, "succeeded");
  assert.equal(f.sends.length, before + 1);
  await deny(f.broker.execute(s.bearer, approved, "replay"), "NOT_PERMITTED");
  await deny(
    f.broker.execute(s.bearer, f.read(c), "same"),
    "IDEMPOTENCY_CONFLICT",
  );
});

test("possible-send timeout is durable uncertain; explicit reconciliation plus fresh approval required for linked recovery", async (t) => {
  const f = await fixture(t),
    c = await f.ready(),
    g = await f.assign(c),
    s = await f.issue(g),
    request = f.write(c);
  const approval = await f.broker.approve("owner", s.session.id, request);
  f.setSendHook(async () => {
    throw Error(f.canary);
  });
  const result = await f.broker.execute(
    s.bearer,
    { ...request, approval_id: approval.id },
    "uncertain",
  );
  assert.equal(result.state, "uncertain");
  const count = f.sends.length;
  assert.deepEqual(
    await f.broker.execute(
      s.bearer,
      { ...request, approval_id: approval.id },
      "uncertain",
    ),
    result,
  );
  assert.equal(f.sends.length, count);
  const recovery = { ...request, recovery_of: result.id };
  await deny(f.broker.execute(s.bearer, recovery, "recovery"), "NOT_PERMITTED");
  await f.broker.reconcileOperation(
    "owner",
    result.id,
    "confirmed_not_applied",
  );
  await deny(
    f.broker.execute(s.bearer, recovery, "recovery"),
    "APPROVAL_REQUIRED",
  );
  const fresh = await f.broker.approve("owner", s.session.id, recovery);
  f.setSendHook(null);
  const recovered = await f.broker.execute(
    s.bearer,
    { ...recovery, approval_id: fresh.id },
    "recovery",
  );
  assert.equal(recovered.state, "succeeded");
  assert.equal(recovered.recovery_of, result.id);
  assert.ok(!JSON.stringify(result).includes(f.canary));
});

test("restart invalidates bearer and approval; projections and persisted metadata exclude canary and bearer", async (t) => {
  const f = await fixture(t),
    c = await f.ready(),
    g = await f.assign(c),
    s = await f.issue(g),
    a = await f.broker.approve("owner", s.session.id, f.write(c));
  const projected = JSON.stringify([
    await f.broker.detail("owner", c.id),
    await f.broker.activity("owner", c.id),
    await f.broker.listConnections("owner"),
  ]);
  for (const secret of [f.canary, s.bearer])
    assert.ok(!projected.includes(secret));
  for (const file of readdirSync(f.dir))
    for (const secret of [f.canary, s.bearer])
      assert.ok(!readFileSync(join(f.dir, file)).includes(Buffer.from(secret)));
  f.restart();
  await deny(
    f.broker.execute(s.bearer, { ...f.write(c), approval_id: a.id }, "restart"),
    "NOT_PERMITTED",
  );
  await deny(f.issue(g), "NOT_PERMITTED");
  assert.equal(
    (await f.broker.detail("owner", c.id)).readiness.code,
    "POLICY_REVALIDATION_REQUIRED",
  );
});

test("revocation during vault await prevents the subsequent operation send", async (t) => {
  const f = await fixture(t),
    c = await f.ready(),
    g = await f.assign(c),
    s = await f.issue(g),
    entered = deferred(),
    release = deferred();
  const count = f.sends.length;
  f.setReadHook(async () => {
    entered.resolve();
    await release.promise;
  });
  const pending = f.broker.execute(s.bearer, f.read(c), "race");
  await entered.promise;
  await f.broker.revoke("owner", c.id, c.revision);
  release.resolve();
  assert.equal((await pending).state, "failed");
  assert.equal(f.sends.length, count);
});

test("upstream schema/echo injection fails closed without arbitrary result or raw error", async (t) => {
  const f = await fixture(t),
    c = await f.ready(),
    g = await f.assign(c),
    s = await f.issue(g);
  for (const [i, response] of [
    { resource_id: f.ids.resource, state: "open", secret: f.canary },
    { resource_id: f.ids.resource, state: f.canary },
  ].entries()) {
    f.setSendHook(async () => response);
    const result = await f.broker.execute(s.bearer, f.read(c), "echo-" + i);
    assert.equal(result.state, "failed");
    assert.equal(result.result, null);
    assert.ok(!JSON.stringify(result).includes(f.canary));
  }
});

test("revocation during connection test vault read prevents send and cannot reactivate connection", async (t) => {
  const f = await fixture(t),
    c = await f.enroll(),
    entered = deferred(),
    release = deferred();
  f.setReadHook(async () => {
    entered.resolve();
    await release.promise;
  });
  const pending = f.broker.testConnection("owner", c.id, c.revision);
  const rejected = assert.rejects(pending);
  await entered.promise;
  await f.broker.revoke("owner", c.id, c.revision);
  release.resolve();
  await rejected;
  assert.equal(f.sends.length, 0);
  assert.equal((await f.broker.detail("owner", c.id)).status, "revoked");
});

test("revocation during assignment authority check cannot publish a new active grant", async (t) => {
  const f = await fixture(t),
    c = await f.ready(),
    entered = deferred(),
    release = deferred();
  f.setAssignHook(async () => {
    entered.resolve();
    await release.promise;
  });
  const pending = f.assign(c);
  const rejected = assert.rejects(pending);
  await entered.promise;
  await f.broker.revoke("owner", c.id, c.revision);
  release.resolve();
  await rejected;
  assert.equal((await f.broker.detail("owner", c.id)).assignments.length, 0);
});

test("revocation during session eligibility check cannot issue a bearer", async (t) => {
  const f = await fixture(t),
    c = await f.ready(),
    g = await f.assign(c),
    entered = deferred(),
    release = deferred();
  f.setEligibleHook(async () => {
    entered.resolve();
    await release.promise;
  });
  const pending = f.issue(g);
  const rejected = assert.rejects(pending);
  await entered.promise;
  await f.broker.revoke("owner", c.id, c.revision);
  release.resolve();
  await rejected;
});

test("revocation cannot undo an already accepted request but blocks queued future sends", async (t) => {
  const f = await fixture(t),
    c = await f.ready(),
    g = await f.assign(c),
    s = await f.issue(g),
    entered = deferred(),
    release = deferred();
  f.setSendHook(async (_op, input) => {
    entered.resolve();
    await release.promise;
    return { resource_id: input.resource_id, state: "open" };
  });
  const inFlight = f.broker.execute(s.bearer, f.read(c), "in-flight");
  await entered.promise;
  const queued = f.broker.execute(s.bearer, f.read(c), "queued");
  const rejected = assert.rejects(queued);
  await f.broker.revoke("owner", c.id, c.revision);
  release.resolve();
  assert.equal((await inFlight).state, "succeeded");
  await rejected;
  assert.equal(f.sends.length, 2);
});

test("enrollment interrupted by revocation leaves visible reconciliation state without resurrection", async (t) => {
  const f = await fixture(t),
    entered = deferred(),
    release = deferred();
  f.setReadHook(async () => {
    entered.resolve();
    await release.promise;
  });
  const pending = f.enroll(),
    rejected = deny(pending, "ENROLLMENT_RECONCILE_REQUIRED");
  await entered.promise;
  const [reserved] = await f.broker.listConnections("owner");
  assert.equal(reserved.status, "saved");
  await f.broker.revoke("owner", reserved.id, reserved.revision);
  release.resolve();
  await rejected;
  const c = await f.broker.detail("owner", reserved.id);
  assert.equal(c.status, "revoked");
  assert.equal(c.credential_version, 0);
  assert.equal(f.sends.length, 0);
});

test("rotation interrupted by revocation cannot commit or reactivate the replacement", async (t) => {
  const f = await fixture(t),
    c = await f.ready(),
    g = await f.assign(c),
    s = await f.issue(g),
    entered = deferred(),
    release = deferred();
  f.setReadHook(async () => {
    entered.resolve();
    await release.promise;
  });
  const pending = f.broker.rotate(
      "owner",
      c.id,
      c.revision,
      randomBytes(32).toString("hex"),
    ),
    rejected = deny(pending, "ENROLLMENT_RECONCILE_REQUIRED");
  await entered.promise;
  const reserved = await f.broker.detail("owner", c.id);
  await f.broker.revoke("owner", c.id, reserved.revision);
  release.resolve();
  await rejected;
  assert.equal((await f.broker.detail("owner", c.id)).status, "revoked");
  await deny(f.broker.execute(s.bearer, f.read(c), "stale"), "NOT_PERMITTED");
});

test("sealed vault burns approval without send and never automatically retries reserved operation", async (t) => {
  const f = await fixture(t),
    c = await f.ready(),
    g = await f.assign(c),
    s = await f.issue(g),
    request = f.write(c),
    a = await f.broker.approve("owner", s.session.id, request),
    count = f.sends.length;
  f.setReadHook(async () => {
    throw Error(f.canary);
  });
  const approved = { ...request, approval_id: a.id },
    r = await f.broker.execute(s.bearer, approved, "sealed");
  assert.equal(r.state, "failed");
  assert.equal(r.code, "BROKER_UNAVAILABLE");
  assert.equal(f.sends.length, count);
  f.setReadHook(null);
  assert.deepEqual(await f.broker.execute(s.bearer, approved, "sealed"), r);
  await deny(
    f.broker.execute(s.bearer, approved, "new-attempt"),
    "NOT_PERMITTED",
  );
  assert.equal(f.sends.length, count);
});

test("expired approval and narrowed session action limits block excess sends", async (t) => {
  const f = await fixture(t),
    c = await f.ready(),
    g = await f.assign(c),
    s = await f.issue(g),
    a = await f.broker.approve("owner", s.session.id, f.write(c));
  f.advance(120001);
  await deny(
    f.broker.execute(
      s.bearer,
      { ...f.write(c), approval_id: a.id },
      "expired-approval",
    ),
    "NOT_PERMITTED",
  );
  const limited = await f.issue(g, "owner", {
    operations: ["item.read"],
    limits: { max_actions: 1, max_seconds: 300 },
  });
  const before = f.sends.length;
  await deny(
    f.broker.execute(limited.bearer, f.write(c), "wrong-operation"),
    "SCOPE_EXCEEDED",
  );
  assert.equal(
    (await f.broker.execute(limited.bearer, f.read(c), "one")).state,
    "succeeded",
  );
  await deny(
    f.broker.execute(limited.bearer, f.read(c), "two"),
    "LIMIT_EXCEEDED",
  );
  assert.equal(f.sends.length, before + 1);
});

test("authorization proof cannot be replaced by agent bearer; no arbitrary URL/path/header inputs", async (t) => {
  const f = await fixture(t),
    c = await f.ready(),
    g = await f.assign(c),
    s = await f.issue(g),
    count = f.sends.length;
  await deny(f.broker.detail(s.bearer, c.id), "AUTH_REQUIRED");
  await deny(f.broker.assign(s.bearer, c.id, c.revision, {}), "AUTH_REQUIRED");
  for (const field of [
    "vault_path",
    "credential_version",
    "url",
    "headers",
    "policy",
  ])
    await deny(
      f.broker.execute(
        s.bearer,
        { ...f.read(c), [field]: "untrusted" },
        "inject-" + field,
      ),
      "INVALID_REQUEST",
    );
  await deny(
    f.broker.execute(
      s.bearer,
      {
        ...f.read(c),
        input: { resource_id: f.ids.resource, url: "http://169.254.169.254" },
      },
      "input-url",
    ),
    "INVALID_REQUEST",
  );
  assert.equal(f.sends.length, count);
});

test("permission revocation and narrowed grants supersede already issued sessions", async (t) => {
  const f = await fixture(t);
  let c = await f.ready();
  c = await f.permission(c, "user", ["view", "use"]);
  const g = await f.assign(c, "owner", "user"),
    s = await f.issue(g, "user"),
    before = f.sends.length;
  c = await f.permission(c, "user", ["view"]);
  await deny(
    f.broker.execute(s.bearer, f.read(c), "removed-use"),
    "NOT_PERMITTED",
  );
  assert.equal(f.sends.length, before);
  c = await f.permission(c, "user", ["view", "use"], {
    operations: ["item.read"],
  });
  await deny(f.issue(g, "user"), "SCOPE_EXCEEDED");
  const narrow = await f.issue(g, "user", { operations: ["item.read"] });
  assert.equal(
    (await f.broker.execute(narrow.bearer, f.read(c), "narrow")).state,
    "succeeded",
  );
});
