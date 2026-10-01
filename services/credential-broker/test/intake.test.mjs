import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  symlinkSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import { createIntakeHandler, recoverIntakeLock } from "../intake.mjs";

test("independent human intake: origin, ownership, single send, lost response status and no secret metadata", async () => {
  const dir = mkdtempSync(join(tmpdir(), "intake-"));
  const path = join(dir, "intents.json");
  const owner = randomUUID(),
    other = randomUUID(),
    connection = randomUUID(),
    csrf = randomBytes(24).toString("hex"),
    canary = randomBytes(32).toString("hex");
  let writes = 0,
    throwUpstream = false;
  const options = {
    mode: "synthetic",
    origin: "https://broker.test",
    statePath: path,
    authenticateProof: async (proof) => ({
      user_id: proof === "owner" ? owner : other,
      fresh_until: Date.now() + 60000,
    }),
    authenticateRequest: async (req) =>
      req.headers.authorization
        ? { proof: req.headers.authorization, csrf_token: csrf }
        : null,
    broker: {
      enroll: async (_p, _m, secret) => {
        assert.equal(secret, canary);
        writes++;
        if (throwUpstream) throw Error(canary);
        await new Promise((r) => setTimeout(r, 30));
        return { id: connection, revision: 1, credential_version: 1 };
      },
    },
  };
  let handler = createIntakeHandler(options);
  const server = http.createServer((req, res) => handler(req, res));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const call = (method, url, data, extra = {}) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: server.address().port,
          path: url,
          method,
          headers: {
            Host: "broker.test",
            authorization: "owner",
            Origin: "https://broker.test",
            "X-CSRF-Token": csrf,
            "Content-Type": "application/json",
            ...extra,
          },
        },
        (res) => {
          let body = "";
          res.on("data", (b) => (body += b));
          res.on("end", () =>
            resolve({ status: res.statusCode, body, headers: res.headers }),
          );
        },
      );
      req.on("error", reject);
      req.end(data === undefined ? undefined : JSON.stringify(data));
    });
  try {
    const metadata = {
      kind: "enroll",
      connection: {
        name: "Disposable fixture",
        project_id: null,
        adapter_id: "synthetic-ledger-v1",
        operations: ["item.read"],
        resources: [randomUUID()],
        limits: { max_actions: 2, max_seconds: 30 },
      },
    };
    assert.equal(
      (
        await call("POST", "/v1/intake/intents", metadata, {
          Origin: "https://evil.test",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await call("POST", "/v1/intake/intents", metadata, {
          "X-CSRF-Token": "bad",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await call("POST", "/v1/intake/intents", {
          ...metadata,
          credential: canary,
        })
      ).status,
      400,
    );
    const r = await call("POST", "/v1/intake/intents", metadata);
    assert.equal(r.status, 201);
    const intent = JSON.parse(r.body),
      url = "/v1/intake/intents/" + intent.id;
    assert.equal(
      (await call("GET", url, undefined, { authorization: "other" })).status,
      404,
    );
    const html = await call("GET", "/intake/" + intent.id);
    assert.match(html.body, /type="password"/);
    assert.match(
      html.headers["content-security-policy"],
      /frame-ancestors 'none'/,
    );
    const results = await Promise.all([
      call("POST", url + "/submit", { credential: canary }),
      call("POST", url + "/submit", { credential: canary }),
    ]);
    assert.deepEqual(results.map((x) => x.status).sort(), [200, 409]);
    assert.equal(writes, 1);
    const status = await call("GET", url);
    assert.equal(JSON.parse(status.body).state, "committed");
    assert.equal(JSON.parse(status.body).connection_id, connection);
    assert.ok(!readFileSync(path, "utf8").includes(canary));
    assert.ok(results.every((r) => !r.body.includes(canary)));
    handler.close();
    handler = createIntakeHandler(options);
    assert.equal(
      (await call("POST", url + "/submit", { credential: canary })).status,
      409,
    );
    assert.equal(writes, 1);
    throwUpstream = true;
    const uncertain = await handler.reserve("owner", metadata);
    const failed = await call(
      "POST",
      "/v1/intake/intents/" + uncertain.id + "/submit",
      { credential: canary },
    );
    assert.equal(JSON.parse(failed.body).state, "reconcile_required");
    assert.ok(!failed.body.includes(canary));
    assert.equal(
      (
        await call("POST", "/v1/intake/intents/" + uncertain.id + "/submit", {
          credential: canary,
        })
      ).status,
      409,
    );
    assert.throws(() => recoverIntakeLock(path), /BROKER_UNAVAILABLE/);
  } finally {
    await new Promise((r) => server.close(r));
    handler.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("production disabled; uncertain write prevents replay and suppresses raw failures", async () => {
  assert.throws(
    () => createIntakeHandler({ mode: "production" }),
    /BROKER_NOT_ACTIVATED/,
  );
  const dir = mkdtempSync(join(tmpdir(), "intake-")),
    user = randomUUID();
  const h = createIntakeHandler({
    mode: "synthetic",
    origin: "https://broker.test",
    statePath: join(dir, "state"),
    authenticateRequest: async () => ({
      proof: "p",
      csrf_token: "01234567890123456789",
    }),
    authenticateProof: async () => ({
      user_id: user,
      fresh_until: Date.now() + 60000,
    }),
    broker: {
      enroll: async () => {
        throw Error("SECRET RAW ERROR");
      },
    },
  });
  try {
    const r = await h.reserve("p", {
      kind: "enroll",
      connection: {
        name: "Fixture",
        project_id: null,
        adapter_id: "synthetic-ledger-v1",
        operations: ["item.read"],
        resources: [randomUUID()],
        limits: { max_actions: 1, max_seconds: 1 },
      },
    });
    assert.equal((await h.status("p", r.id)).state, "reserved");
    assert.throws(
      () =>
        createIntakeHandler({
          mode: "synthetic",
          origin: "https://broker.test",
          statePath: join(dir, "state"),
          authenticateRequest: () => {},
          authenticateProof: () => {},
          broker: {},
        }),
      /EEXIST/,
    );
  } finally {
    h.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dead-process lock recovery preserves uncertain state and rejects cross-owner lookup", async () => {
  const dir = mkdtempSync(join(tmpdir(), "intake-")),
    path = join(dir, "state"),
    owner = randomUUID(),
    id = randomUUID();
  const child = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  assert.equal(child.status, 0);
  writeFileSync(path + ".lock", JSON.stringify({ pid: child.pid }), {
    mode: 0o600,
  });
  writeFileSync(
    path,
    JSON.stringify([
      {
        id,
        user_id: owner,
        state: "submitting",
        expires_at: Date.now() + 60000,
        request: { kind: "enroll" },
      },
    ]),
    { mode: 0o600 },
  );
  recoverIntakeLock(path);
  const h = createIntakeHandler({
    mode: "synthetic",
    origin: "https://broker.test",
    statePath: path,
    authenticateRequest: async () => null,
    authenticateProof: async () => ({
      user_id: owner,
      fresh_until: Date.now() + 60000,
    }),
    broker: {
      enrollmentStatus: async () => ({
        connection_id: randomUUID(),
        status: "reconcile_required",
        revision: 1,
      }),
    },
  });
  try {
    const result = await h.status("proof", id);
    assert.equal(result.state, "reconcile_required");
    assert.equal(result.code, "ENROLLMENT_RECONCILE_REQUIRED");
    assert.equal(JSON.parse(readFileSync(path))[0].state, "reconcile_required");
  } finally {
    h.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rejects shared directories and symlink state before reading", () => {
  const dir = mkdtempSync(join(tmpdir(), "intake-")),
    path = join(dir, "state");
  const opts = {
    mode: "synthetic",
    origin: "https://broker.test",
    statePath: path,
    authenticateRequest: () => {},
    authenticateProof: () => {},
    broker: {},
  };
  try {
    chmodSync(dir, 0o755);
    assert.throws(() => createIntakeHandler(opts), /BROKER_UNAVAILABLE/);
    chmodSync(dir, 0o700);
    writeFileSync(join(dir, "target"), "[]", { mode: 0o600 });
    symlinkSync(join(dir, "target"), path);
    assert.throws(() => createIntakeHandler(opts), /BROKER_UNAVAILABLE/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
