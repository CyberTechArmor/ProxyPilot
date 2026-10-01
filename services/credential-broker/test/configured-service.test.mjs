import test from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import net from "node:net";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  randomUUID,
  generateKeyPairSync,
  sign,
  createHash,
  X509Certificate,
} from "node:crypto";
import { startOidcFixture } from "../fixtures/oidc.mjs";
import { createConfiguredService } from "../configured-service.mjs";
import { createBroker } from "../broker.mjs";
import { canonical } from "../schema.mjs";
import { validateConfig } from "../config.mjs";
const req = (url, ca, { client, method = "GET", headers = {}, data } = {}) =>
  new Promise((resolve, reject) => {
    const r = https.request(
      url,
      {
        ca,
        ...client,
        method,
        headers: {
          ...(data ? { "Content-Type": "application/json" } : {}),
          ...headers,
        },
      },
      (s) => {
        let text = "";
        s.on("data", (b) => (text += b));
        s.on("end", () =>
          resolve({
            status: s.statusCode,
            headers: s.headers,
            text,
            json: () => JSON.parse(text),
          }),
        );
      },
    );
    r.on("error", reject);
    r.end(data ? JSON.stringify(data) : undefined);
  });
const cookie = (r, name) =>
  r.headers["set-cookie"].find((x) => x.startsWith(name + "=")).split(";")[0];
const port = async () => {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
};
for (const scopeName of ["project", "global"]) test(
  `configured listeners and ${scopeName} catalogue enforce independent authority`,
  { timeout: 30000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "broker-service-test-")),
      idp = await startOidcFixture();
    let service;
    try {
      const owner = randomUUID(),
        project = randomUUID(),
        connectionProject = scopeName === "project" ? project : null,
        agent = randomUUID(),
        resource = randomUUID(),
        keys = generateKeyPairSync("ed25519"),
        clients = {},
        pins = [];
      for (const role of ["dashboard", "publisher", "worker"]) {
        const key = join(dir, role + ".key"),
          cert = join(dir, role + ".cert");
        execFileSync(
          "openssl",
          [
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-keyout",
            key,
            "-out",
            cert,
            "-days",
            "1",
            "-subj",
            "/CN=" + role,
          ],
          { stdio: "ignore" },
        );
        clients[role] = { key: readFileSync(key), cert: readFileSync(cert) };
        pins.push({
          fingerprint: createHash("sha256")
            .update(new X509Certificate(clients[role].cert).raw)
            .digest("hex"),
          role,
          id: role === "publisher" ? "fixture-source" : randomUUID(),
        });
      }
      const file = (name, value) => {
        const p = join(dir, name);
        writeFileSync(p, value, { mode: 0o600 });
        return p;
      };
      const tls = {
        key_file: file("server.key", idp.key),
        cert_file: file("server.cert", idp.cert),
        ca_file: file(
          "clients.ca",
          Buffer.concat(Object.values(clients).map((c) => c.cert)),
        ),
      };
      const listeners = {};
      for (const role of ["human", "management", "agent"]) {
        const p = await port();
        listeners[role] = {
          origin: "https://127.0.0.1:" + p,
          host: "127.0.0.1",
          port: p,
          tls,
        };
      }
      const config = {
        schema_version: 1,
        mode: "configured",
        state_dir: dir,
        listeners,
        clients: pins,
        identity: {
          issuer: idp.issuer,
          authorization_endpoint: idp.issuer + "/authorize",
          token_endpoint: idp.issuer + "/token",
          jwks_endpoint: idp.issuer + "/jwks",
          client_id: "fixture-client",
          broker_origin: listeners.human.origin,
          dashboard_origin: "https://dashboard.example",
          subject_map: [
            { issuer: idp.issuer, subject: "fixture-user", user_id: owner },
          ],
          required_acr: "fixture:mfa",
          max_age_seconds: 300,
          ca_file: idp.ca_file,
        },
        authority: {
          sources: [
            {
              id: "fixture-source",
              public_key: keys.publicKey.export({
                format: "pem",
                type: "spki",
              }),
              kinds: [
                "users",
                "projects",
                "agents",
                "tasks",
                "ceilings",
                "policies",
              ],
            },
          ],
        },
        vault: {
          origin: "https://vault.fixture.test:8200",
          approved_address: "127.0.0.1",
          ca_file: tls.cert_file,
          mount: "fractionate-broker-kv",
          reader: {
            role_id_file: file("read.role", "fixture-role"),
            secret_id_file: file("read.secret", "fixture-secret"),
          },
          enroller: {
            role_id_file: file("write.role", "fixture-role"),
            secret_id_file: file("write.secret", "fixture-secret"),
          },
          slots: [{ owner_id: owner, credential_id: randomUUID() }],
        },
        upstream: {
          origin: "https://ledger.fixture.test:8443",
          approved_address: "127.0.0.1",
          ca_file: tls.cert_file,
        },
      };
      assert.throws(
        () =>
          createBroker({
            mode: "configured",
            authority: { authenticate() {}, eligible() {}, canAssign() {} },
          }),
        /BROKER_NOT_ACTIVATED/,
      );
      assert.throws(() => validateConfig({ ...config, unknown: true }));
      const values = new Map(),
        vault = {
          async write(path, value, { cas, intent, beforeSend }) {
            await beforeSend?.();
            const old = values.get(path) || [];
            if (old.length !== cas) throw Error();
            old.push({ value, intent, version: cas + 1 });
            values.set(path, old);
            return { version: cas + 1 };
          },
          async read(path, version) {
            return values.get(path)[version - 1];
          },
        };
      service = await createConfiguredService({
        config,
        dependencies: {
          testOnly: true,
          probeVault: async () => true,
          vault,
          upstream: {
            async execute(op, r, _key, { beforeSend } = {}) {
              await beforeSend?.();
              return { resource_id: r.resource_id, state: "open" };
            },
          },
        },
      });
      await service.start();
      const management = listeners.management.origin,
        human = listeners.human.origin;
      const remote = (path, options = {}) =>
        req(management + path, idp.cert, {
          client: clients.dashboard,
          ...options,
        });
      assert.equal(
        (await remote("/v1/capabilities")).json().intake_enabled,
        false,
      );
      await assert.rejects(req(management + "/v1/capabilities", idp.cert));
      assert.equal(
        (
          await remote("/v1/dashboard", {
            client: clients.worker,
            method: "POST",
            data: {},
          })
        ).status,
        404,
      );
      const challenge = (
        await remote("/v1/authority/challenge", { client: clients.publisher })
      ).json().challenge;
      const envelope = {
        version: "authority.v1",
        source_id: "fixture-source",
        sequence: 1,
        challenge,
        issued_at: Date.now() - 1,
        expires_at: Date.now() + 55000,
        records: {
          users: [{ id: owner, revision: 1, disabled: false }],
          projects: [
            { id: project, revision: 1, archived: false, user_ids: [owner] },
          ],
          agents: [
            {
              id: agent,
              revision: 1,
              project_id: project,
              user_id: owner,
              disabled: false,
              workload_id: pins.find((p) => p.role === "worker").id,
            },
          ],
          tasks: [],
          ceilings: [
            {
              id: randomUUID(),
              revision: 1,
              user_id: owner,
              project_id: connectionProject,
              actions: ["list", "enroll"],
              connection_ids: [],
              adapter_ids: ["synthetic-ledger-v1"],
              operations: ["item.read"],
              resources: [resource],
              limits: { max_actions: 2, max_seconds: 60 },
              expires_at: Date.now() + 55000,
              revoked: false,
              grant_rights: ["view", "use"],
              manage_actions: [],
            },
          ],
          policies: [],
        },
      };
      envelope.signature = sign(
        null,
        Buffer.from(canonical(envelope)),
        keys.privateKey,
      ).toString("base64url");
      assert.equal(
        (
          await remote("/v1/authority/snapshot", {
            client: clients.publisher,
            method: "POST",
            data: envelope,
          })
        ).status,
        200,
      );
      assert.equal(
        (await remote("/v1/capabilities")).json().intake_enabled,
        false,
      );
      const start = await req(human + "/auth/login", idp.cert),
        authorized = await req(start.headers.location, idp.cert),
        done = await req(authorized.headers.location, idp.cert, {
          headers: { Cookie: cookie(start, "__Host-fractionate-login") },
        });
      assert.equal(done.status, 303);
      const humanCookie = cookie(done, "__Host-fractionate-human"),
        state = (
          await req(human + "/auth/session", idp.cert, {
            headers: { Cookie: humanCookie },
          })
        ).json();
      const delegation = (
        await req(human + "/auth/delegations", idp.cert, {
          method: "POST",
          headers: {
            Cookie: humanCookie,
            Origin: human,
            "X-CSRF-Token": state.csrf_token,
          },
          data: { actions: ["list", "enroll", "intent"] },
        })
      ).json();
      assert.ok(delegation.bearer);
      const call = (data) =>
        remote("/v1/dashboard", {
          method: "POST",
          headers: { Authorization: "Bearer " + delegation.bearer },
          data,
        });
      assert.equal(
        (await call({ action: "list", actor: { id: owner } })).status,
        200,
      );
      assert.equal(
        (await call({ action: "list", actor: { id: randomUUID() } })).status,
        403,
      );
      assert.equal(
        (
          await call({
            action: "enroll",
            actor: { id: owner },
            body: { credential: "never-accepted" },
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await call({
            action: "enroll",
            actor: { id: owner },
            body: {
              name: "Denied before runner",
              project_id: connectionProject,
              adapter_id: "synthetic-ledger-v1",
              operations: ["item.read"],
              resources: [resource],
              limits: { max_actions: 2, max_seconds: 60 },
            },
          })
        ).status,
        503,
      );
      assert.equal(
        (
          await req(human + "/v1/intake/intents", idp.cert, {
            method: "POST",
            headers: {
              Cookie: humanCookie,
              Origin: human,
              "X-CSRF-Token": state.csrf_token,
            },
            data: { kind: "enroll", connection: {} },
          })
        ).status,
        503,
      );
      assert.equal(
        (
          await req(listeners.agent.origin + "/v1/workloads/ready", idp.cert, {
            client: clients.worker,
          })
        ).status,
        200,
      );
      assert.equal(
        (await remote("/v1/capabilities")).json().intake_enabled,
        true,
      );
      const metadata = {
          name: "Fixture",
          project_id: connectionProject,
          adapter_id: "synthetic-ledger-v1",
          operations: ["item.read"],
          resources: [resource],
          limits: { max_actions: 2, max_seconds: 60 },
        },
        intent = (
          await call({ action: "enroll", actor: { id: owner }, body: metadata })
        ).json().intent;
      assert.ok(intent.id);
      const submit = await req(
        human + "/v1/intake/intents/" + intent.id + "/submit",
        idp.cert,
        {
          method: "POST",
          headers: {
            Cookie: humanCookie,
            Origin: human,
            "X-CSRF-Token": state.csrf_token,
          },
          data: { credential: "disposable-generated-fixture-only" },
        },
      );
      assert.equal(submit.json().state, "committed");
      assert.equal(
        (
          await call({ action: "intent", actor: { id: owner }, id: intent.id })
        ).json().intent.state,
        "committed",
      );
      // Project-only list authority must work through the global catalogue,
      // while a locally visible connection without its own ceiling stays hidden.
      assert.deepEqual((await call({action:"list",actor:{id:owner}})).json().connections, []);
      const connectionId = submit.json().connection_id;
      assert.ok(connectionId);
      const publishCeiling = async (ids) => {
        envelope.sequence++;
        envelope.records.ceilings[0].revision++;
        envelope.records.ceilings[0].connection_ids = ids;
        const {signature: ignored, ...payload} = envelope;
        envelope.signature = sign(null, Buffer.from(canonical(payload)), keys.privateKey).toString("base64url");
        assert.equal((await remote("/v1/authority/snapshot", {client:clients.publisher,method:"POST",data:envelope})).status,200);
      };
      await publishCeiling([connectionId]);
      const globalList = await call({action:"list",actor:{id:owner}});
      assert.equal(globalList.status,200);
      assert.deepEqual(globalList.json().connections.map(c=>c.id),[connectionId]);
      const projectList = await call({action:"list",actor:{id:owner},query:{project_id:project}});
      assert.equal(projectList.status,200);
      assert.deepEqual(projectList.json().connections.map(c=>c.id),[connectionId]);
      assert.equal((await call({action:"list",actor:{id:owner},query:{project_id:randomUUID()}})).status,403);
      await publishCeiling([]);
      assert.deepEqual((await call({action:"list",actor:{id:owner}})).json().connections,[]);
      const consolePage = await req(human + "/", idp.cert, {
        headers: { Cookie: humanCookie },
      });
      assert.equal(consolePage.status, 200);
      assert.match(consolePage.text, /Review exact operation/);
      assert.equal(
        (
          await req(human + "/v1/human/revalidate", idp.cert, {
            method: "POST",
            headers: {
              Cookie: humanCookie,
              Origin: "https://evil.example",
              "X-CSRF-Token": state.csrf_token,
            },
            data: { connection_id: randomUUID(), expected: 1 },
          })
        ).status,
        403,
      );
    } finally {
      await service?.close();
      await idp.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
