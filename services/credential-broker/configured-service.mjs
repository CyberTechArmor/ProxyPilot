import https from "node:https";
import { renderHumanConsole } from "./human-console.mjs";
import { createHash, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { createBroker } from "./broker.mjs";
import { createAgentServer } from "./server.mjs";
import { createIntakeHandler } from "./intake.mjs";
import { createIdentity } from "./identity.mjs";
import { createAuthority } from "./authority.mjs";
import { acquireStateLease } from "./recovery.mjs";
import { createTransport, createLedgerAdapter } from "./transport.mjs";
import { createOpenBaoClient, splitVault } from "./openbao.mjs";
import { privateFile, validateConfig, createAllocator } from "./config.mjs";
import {
  VERSION,
  exact,
  uuid,
  string,
  parseJson,
  fail,
  BrokerError,
  safeError,
  digest,
} from "./schema.mjs";
const BUILD = "credential-broker-configured.v1";
const mutations = new Set([
  "enroll",
  "test",
  "update",
  "revoke",
  "rotate",
  "assign",
  "unassign",
]);
const actions = new Set([
  "list",
  "get",
  "assignments",
  "sessions",
  "activity",
  "intent",
  ...mutations,
]);
async function body(req, max = 16384) {
  if (
    req.headers["content-type"] !== "application/json" ||
    req.headers["content-encoding"]
  )
    fail("INVALID_REQUEST");
  let size = 0;
  const chunks = [];
  const timer = setTimeout(() => req.destroy(), 5000);
  try {
    for await (const c of req) {
      size += c.length;
      if (size > max) fail("LIMIT_EXCEEDED", 413);
      chunks.push(c);
    }
    return parseJson(Buffer.concat(chunks));
  } finally {
    clearTimeout(timer);
  }
}
function duplicateHeaders(req) {
  const n = req.rawHeaders
    .filter((_, i) => !(i % 2))
    .map((x) => x.toLowerCase());
  if (new Set(n).size !== n.length) fail("INVALID_REQUEST");
}
const reply = (res, status, value) => {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify({ ...value, contract_version: VERSION }));
};
function token(req) {
  const m = /^Bearer ([A-Za-z0-9_-]{43,128})$/.exec(
    req.headers.authorization || "",
  );
  if (!m) fail("AUTH_REQUIRED", 401);
  return m[1];
}
function noSecrets(value) {
  if (!value || typeof value !== "object") return;
  for (const [k, v] of Object.entries(value)) {
    if (
      /^(credential|value|token|password|secret|secret_id|role_id|headers|url|vault_path)$/i.test(
        k,
      )
    )
      fail("INVALID_REQUEST");
    noSecrets(v);
  }
}
export async function createConfiguredService({
  config: rawConfig,
  dependencies,
} = {}) {
  if (dependencies && dependencies.testOnly !== true) fail("INVALID_CONFIG");
  const config = validateConfig(rawConfig, {
    testOnly: dependencies?.testOnly === true,
  });
  const lease = acquireStateLease(config.state_dir);
  let identity, authority, broker, intake;
  const servers = [];
  const addresses = {};
  let started = false,
    closed = false,
    vaultReadyUntil = 0,
    workerReadyUntil = 0,
    observedWorkerId = null,
    probeTimer;
  const material = (role) => {
    const l = config.listeners[role];
    return {
      key: privateFile(l.tls.key_file),
      cert: privateFile(l.tls.cert_file, { secret: false }),
      ...(l.tls.ca_file
        ? { ca: privateFile(l.tls.ca_file, { secret: false }) }
        : {}),
      minVersion: "TLSv1.2",
      requestTimeout: 7000,
      headersTimeout: 4000,
      maxHeaderSize: 8192,
    };
  };
  const endpoint = (target, allowEmpty = false) => {
    const u = new URL(target.origin);
    return createTransport({
      origin: target.origin,
      ca: target.ca_file
        ? privateFile(target.ca_file, { secret: false })
        : undefined,
      allowEmpty,
      ...(target.approved_address
        ? {
            fixture: {
              host: u.hostname,
              port: Number(u.port || 443),
              address: target.approved_address,
            },
            resolve: async () => [
              { address: target.approved_address, family: 4 },
            ],
          }
        : {}),
    });
  };
  const health = () => {
    const a = authority?.health(),
      i = identity?.health();
    const ready =
      started &&
      !closed &&
      vaultReadyUntil > Date.now() &&
      (a === true || a?.ready === true || a?.healthy === true) &&
      (i === true || i?.ready === true || i?.healthy === true);
    return {
      ready,
      execution_ready:
        ready &&
        workerReadyUntil > Date.now() &&
        authority.workloadReady(observedWorkerId),
      contract_version: VERSION,
      build: BUILD,
      reason: ready
        ? workerReadyUntil > Date.now() &&
          authority.workloadReady(observedWorkerId)
          ? "READY"
          : "WORKER_UNAVAILABLE"
        : vaultReadyUntil <= Date.now()
          ? "VAULT_UNAVAILABLE"
          : "AUTHORITY_UNAVAILABLE",
    };
  };
  const capabilities = () => ({
    ...health(),
    mode: "configured",
    compatible: true,
    intake_origin: config.listeners.human.origin,
    intake_enabled: health().execution_ready,
    execution_enabled: health().execution_ready,
    adapters: [
      { id: "synthetic-ledger-v1", type: "static_api_token", supported: true },
    ],
  });
  const requireReady = () => {
    if (!health().ready) fail("BROKER_UNAVAILABLE", 503);
  };
  const requireIntakeReady = () => {
    requireReady();
    if (!health().execution_ready) fail("BROKER_UNAVAILABLE", 503);
  };
  const principal = async (proof, { direct = false, action } = {}) => {
    const p = await authority.authenticate(proof);
    if (direct && p.proof_type !== "human") fail("NOT_PERMITTED", 403);
    if (p.proof_type === "workload") fail("NOT_PERMITTED", 403);
    if (
      p.proof_type === "delegation" &&
      (!action || !p.actions.includes(action))
    )
      fail("NOT_PERMITTED", 403);
    return p;
  };
  const authorize = async (proof, request, { direct = false } = {}) => {
    requireReady();
    if (["enroll", "rotate"].includes(request.action)) requireIntakeReady();
    const p = await principal(proof, { direct, action: request.action });
    if ((await authority.authorize(p, request)) !== true)
      fail("NOT_PERMITTED", 403);
    return p;
  };
  const connectionFor = async (proof, id) =>
    id ? broker.detail(proof, id) : undefined;
  const close = async () => {
    if (closed) return;
    closed = true;
    clearInterval(probeTimer);
    for (const s of servers) {
      s.closeAllConnections?.();
      await new Promise((r) => s.close(r));
    }
    intake?.close();
    broker?.close();
    authority?.close();
    identity?.close();
    lease.close();
  };
  try {
    identity = createIdentity({
      config: config.identity,
      statePath: join(config.state_dir, "identity.json"),
    });
    authority = createAuthority({
      statePath: join(config.state_dir, "authority.json"),
      identity,
      sources: config.authority.sources,
    });
    const transport = endpoint(config.vault, true),
      reader = createOpenBaoClient({
        transport,
        mount: config.vault.mount,
        roleId: privateFile(config.vault.reader.role_id_file).toString().trim(),
        secretId: privateFile(config.vault.reader.secret_id_file)
          .toString()
          .trim(),
      }),
      enroller = createOpenBaoClient({
        transport,
        mount: config.vault.mount,
        roleId: privateFile(config.vault.enroller.role_id_file)
          .toString()
          .trim(),
        secretId: privateFile(config.vault.enroller.secret_id_file)
          .toString()
          .trim(),
        canWrite: true,
      });
    const probeVault = async () => {
      try {
        const okay = dependencies?.probeVault
          ? await dependencies.probeVault()
          : await transport("GET", "/v1/sys/health").then(
              (r) => r.initialized === true && r.sealed === false,
            );
        vaultReadyUntil = okay === true ? Date.now() + 15000 : 0;
      } catch {
        vaultReadyUntil = 0;
      }
    };
    const baseVault = dependencies?.vault || splitVault({ reader, enroller });
    const vault = {
      ...baseVault,
      write(path, value, options) {
        requireIntakeReady();
        return baseVault.write(path, value, {
          ...options,
          beforeSend: async () => {
            requireIntakeReady();
            await options.beforeSend?.();
            requireIntakeReady();
          },
        });
      },
      allocateCredentialId: createAllocator(
        join(config.state_dir, "allocator.json"),
        config.vault.slots,
      ),
    };
    broker = createBroker({
      dbPath: join(config.state_dir, "broker.db"),
      vault,
      upstream:
        dependencies?.upstream ||
        createLedgerAdapter(endpoint(config.upstream)),
      authority,
      mode: "configured",
    });
    const intakeBroker = {
      detail: (...a) => broker.detail(...a),
      enrollmentStatus: (...a) => broker.enrollmentStatus(...a),
      async enroll(proof, metadata, credential, intentId) {
        await authorize(
          proof,
          { action: "enroll", body: metadata },
          { direct: true },
        );
        return broker.enroll(proof, metadata, credential, intentId);
      },
      async rotate(proof, id, expected, credential) {
        const connection = await connectionFor(proof, id);
        await authorize(
          proof,
          { action: "rotate", id, body: { expected }, connection },
          { direct: true },
        );
        return broker.rotate(proof, id, expected, credential);
      },
    };
    intake = createIntakeHandler({
      mode: "configured",
      identity,
      broker: intakeBroker,
      origin: config.listeners.human.origin,
      statePath: join(config.state_dir, "intake.json"),
      authenticateProof: (proof) => authority.authenticate(proof),
      authenticateRequest: (req) => identity.requestPrincipal(req),
    });
    const identify = (req) => {
      if (!req.socket.authorized) fail("AUTH_REQUIRED", 401);
      const cert = req.socket.getPeerCertificate();
      if (!cert?.raw) fail("AUTH_REQUIRED", 401);
      const fingerprint = createHash("sha256").update(cert.raw).digest("hex"),
        client = config.clients.find((c) => c.fingerprint === fingerprint);
      if (!client) fail("NOT_PERMITTED", 403);
      return client;
    };
    const dispatch = async (proof, r) => {
      exact(
        r,
        ["action", "actor", "id", "body", "query", "expected"],
        ["action", "actor"],
      );
      if (!actions.has(r.action)) fail("INVALID_REQUEST");
      exact(r.actor, ["id"]);
      uuid(r.actor.id);
      if (r.id !== undefined) uuid(r.id);
      noSecrets(r.body);
      noSecrets(r.query);
      const p = await principal(proof, { action: r.action });
      if (p.proof_type !== "delegation" || p.user_id !== r.actor.id)
        fail("NOT_PERMITTED", 403);
      let c = await connectionFor(
        proof,
        ["unassign", "intent"].includes(r.action) ? null : r.id,
      );
      if (r.action === "unassign") {
        c = (await broker.listConnections(proof)).find((c) =>
          c.assignments.some((a) => a.id === r.id),
        );
        if (!c) fail("NOT_FOUND", 404);
      }
      if (r.action !== "list") await authorize(proof, {
        action: r.action,
        id: r.id,
        body: r.body,
        query: r.query,
        connection: c,
      });
      switch (r.action) {
        case "intent":
          return {
            intent: await intake.status(proof, r.id),
            intake_enabled: health().execution_ready,
          };
        case "list": {
          const query = r.query || {};
          exact(query, ["project_id", "assignable_to_agent_id"], []);
          if (query.project_id !== undefined) {
            uuid(query.project_id);
            if (!authority.canViewProject(p, query.project_id)) fail("NOT_PERMITTED", 403);
          }
          if (query.assignable_to_agent_id && !query.project_id) fail("INVALID_REQUEST");
          const candidates = query.assignable_to_agent_id
            ? await broker.listAssignableConnections(proof, {
                project_id: query.project_id,
                agent_id: query.assignable_to_agent_id,
              })
            : await broker.listConnections(proof, query);
          // Global catalogue is the bounded union of current per-connection
          // ceilings, intersected with broker view permission. No global grant
          // is synthesized from project membership or a list-only ceiling.
          const connections = [];
          for (const connection of candidates) {
            try {
              if (await authority.authorize(p, {action: "list", connection}) === true)
                connections.push(connection);
            } catch (e) {
              if (e.code !== "AUTHORITY_DENIED") throw e;
            }
          }
          return {connections, next_cursor: null};
        }
        case "get":
          return { connection: c };
        case "assignments":
          return { assignments: c.assignments };
        case "sessions":
          return { sessions: c.sessions };
        case "activity":
          return { events: await broker.activity(proof, r.id) };
        case "enroll":
          return {
            intent: await intake.reserve(proof, {
              kind: "enroll",
              connection: r.body,
            }),
            intake_enabled: true,
          };
        case "rotate":
          return {
            intent: await intake.reserve(proof, {
              kind: "rotate",
              connection_id: r.id,
              revision: r.expected,
            }),
            intake_enabled: true,
          };
        case "test":
          return {
            connection: await broker.testConnection(proof, r.id, r.expected),
          };
        case "update":
          exact(r.body, ["name"]);
          return {
            connection: await broker.rename(
              proof,
              r.id,
              r.expected,
              r.body.name,
            ),
          };
        case "revoke":
          return { connection: await broker.revoke(proof, r.id, r.expected) };
        case "assign":
          return {
            assignment: await broker.assign(proof, r.id, r.expected, r.body),
          };
        case "unassign":
          return { assignment: await broker.unassign(proof, r.id, r.expected) };
      }
    };
    const management = https.createServer(
      {
        ...material("management"),
        requestCert: true,
        rejectUnauthorized: true,
      },
      async (req, res) => {
        try {
          duplicateHeaders(req);
          if (
            req.headers.host !==
            new URL(config.listeners.management.origin).host
          )
            fail("NOT_PERMITTED", 403);
          const client = identify(req);
          if (
            req.method === "GET" &&
            req.url === "/v1/capabilities" &&
            client.role === "dashboard"
          )
            return reply(res, 200, capabilities());
          if (
            req.method === "GET" &&
            req.url === "/v1/authority/challenge" &&
            client.role === "publisher"
          )
            return reply(res, 200, { challenge: authority.challenge() });
          if (
            req.method === "POST" &&
            req.url === "/v1/authority/snapshot" &&
            client.role === "publisher"
          ) {
            const snapshot = await body(req, 262144);
            if (snapshot.source_id !== client.id) fail("NOT_PERMITTED", 403);
            return reply(res, 200, await authority.ingest(snapshot));
          }
          if (
            req.method === "POST" &&
            req.url === "/v1/dashboard" &&
            client.role === "dashboard"
          ) {
            requireReady();
            return reply(res, 200, await dispatch(token(req), await body(req)));
          }
          fail("NOT_FOUND", 404);
        } catch (e) {
          reply(res, e instanceof BrokerError ? e.status : 503, safeError(e));
        }
      },
    );
    servers.push(management);
    const agent = createAgentServer({
      broker,
      key: material("agent").key,
      cert: material("agent").cert,
    });
    // Session minting uses a separate mTLS listener; agent bearer API remains unchanged.
    const worker = https.createServer(
      { ...material("agent"), requestCert: true, rejectUnauthorized: true },
      async (req, res) => {
        try {
          duplicateHeaders(req);
          if (req.headers.host !== new URL(config.listeners.agent.origin).host)
            fail("NOT_PERMITTED", 403);
          const client = identify(req);
          if (client.role !== "worker") fail("NOT_FOUND", 404);
          if (req.method === "GET" && req.url === "/v1/workloads/ready") {
            requireReady();
            if (!authority.workloadReady(client.id)) fail("NOT_PERMITTED", 403);
            workerReadyUntil = Date.now() + 30000;
            observedWorkerId = client.id;
            return reply(res, 200, { ready: true });
          }
          if (req.method !== "POST") fail("NOT_FOUND", 404);
          if (req.url === "/v1/workloads/tasks/readiness") {
            requireReady();
            const readiness = await authority.checkTask(
              client.id,
              await body(req),
            );
            return reply(res, 200, { readiness });
          }
          const ended = /^\/v1\/workloads\/tasks\/([0-9a-f-]+)\/end$/.exec(
            req.url || "",
          );
          if (ended) {
            const r = await body(req);
            exact(r, ["attempt", "fence"]);
            uuid(ended[1]);
            return reply(res, 200, {
              ...(await authority.endTask(client.id, {
                task_id: ended[1],
                ...r,
              })),
              ended: true,
            });
          }
          if (req.url !== "/v1/workloads/session") fail("NOT_FOUND", 404);
          requireReady();
          const r = await body(req);
          exact(r, [
            "grant_id",
            "task_id",
            "attempt",
            "fence",
            "operations",
            "resources",
            "limits",
            "expires_at",
            "audience",
            "configuration_revision",
          ]);
          uuid(r.grant_id);
          const { grant_id, configuration_revision, ...scope } = r,
            proof = await authority.issueWorkloadProof(client.id, r);
          workerReadyUntil = Date.now() + 30000;
          observedWorkerId = client.id;
          reply(res, 200, await broker.issueSession(proof, grant_id, scope));
        } catch (e) {
          reply(res, e instanceof BrokerError ? e.status : 503, safeError(e));
        }
      },
    );
    // One TLS agent port requests certs optionally: workload route requires verified pin;
    // normal typed operations use only scoped bearer. Distinct from human/management.
    const agentHandler = agent.listeners("request")[0],
      workerHandler = worker.listeners("request")[0];
    agent.removeAllListeners("request");
    worker.removeAllListeners("request");
    worker.close();
    const combined = https.createServer(
      { ...material("agent"), requestCert: true, rejectUnauthorized: false },
      (req, res) =>
        req.url.startsWith("/v1/workloads/")
          ? workerHandler(req, res)
          : agentHandler(req, res),
    );
    servers.push(combined);
    const human = https.createServer(material("human"), async (req, res) => {
      try {
        duplicateHeaders(req);
        if (req.headers.host !== new URL(config.listeners.human.origin).host)
          fail("NOT_PERMITTED", 403);
        if (await identity.handle(req, res)) return;
        if (
          req.url.startsWith("/intake/") ||
          req.url.startsWith("/v1/intake/")
        ) {
          if (req.method === "POST" || req.url.startsWith("/intake/"))
            requireIntakeReady();
          return intake(req, res);
        }
        if (req.method === "GET" && req.url === "/") {
          const auth = await identity.requestPrincipal(req);
          await principal(auth.proof, { direct: true });
          return renderHumanConsole(res, { csrf: auth.csrf_token });
        }
        if (req.method === "GET" && req.url === "/v1/capabilities")
          return reply(res, 200, capabilities());
        if (req.method === "POST" && req.url.startsWith("/v1/human/")) {
          const auth = await identity.requestPrincipal(req);
          if (
            !auth?.proof ||
            req.headers.origin !== config.listeners.human.origin ||
            typeof auth.csrf_token !== "string" ||
            req.headers["x-csrf-token"] !== auth.csrf_token
          )
            fail("NOT_PERMITTED", 403);
          const proof = auth.proof,
            r = await body(req);
          const action = req.url.slice("/v1/human/".length);
          await principal(proof, { direct: true });
          if (action === "approval-preview" || action === "approve") {
            exact(
              r,
              ["session_id", "request", "digest"],
              action === "approve"
                ? ["session_id", "request", "digest"]
                : ["session_id", "request"],
            );
            const preview = await broker.previewApproval(
              proof,
              r.session_id,
              r.request,
            );
            await authorize(
              proof,
              {
                action: "approve",
                id: r.request.connection_id,
                body: preview,
                connection: await broker.detail(proof, r.request.connection_id),
              },
              { direct: true },
            );
            if (action === "approval-preview")
              return reply(res, 200, { preview });
            if (r.digest !== preview.digest) fail("REVISION_MISMATCH", 409);
            return reply(res, 200, {
              approval: await broker.approve(proof, r.session_id, r.request),
            });
          }
          if (action === "permissions") {
            exact(r, ["connection_id", "expected", "permission"]);
            await authorize(
              proof,
              {
                action: "setPermission",
                id: r.connection_id,
                body: r.permission,
                connection: await broker.detail(proof, r.connection_id),
              },
              { direct: true },
            );
            return reply(res, 200, {
              connection: await broker.setPermission(
                proof,
                r.connection_id,
                r.expected,
                r.permission,
              ),
            });
          }
          if (action === "revalidate") {
            exact(r, ["connection_id", "expected"]);
            await authorize(
              proof,
              {
                action: "revalidatePolicy",
                id: r.connection_id,
                connection: await broker.detail(proof, r.connection_id),
              },
              { direct: true },
            );
            return reply(res, 200, {
              connection: await broker.revalidatePolicy(
                proof,
                r.connection_id,
                r.expected,
              ),
            });
          }
          if (action === "reconcile") {
            exact(r, ["operation_id", "decision"]);
            let connection;
            for (const candidate of await broker.listConnections(proof)) {
              if (
                (await broker.activity(proof, candidate.id)).some(
                  (e) => e.type === "operation" && e.id === r.operation_id,
                )
              ) {
                connection = candidate;
                break;
              }
            }
            if (!connection) fail("NOT_FOUND", 404);
            await authorize(
              proof,
              {
                action: "reconcileOperation",
                id: r.operation_id,
                body: r,
                connection,
              },
              { direct: true },
            );
            return reply(res, 200, {
              operation: await broker.reconcileOperation(
                proof,
                r.operation_id,
                r.decision,
              ),
            });
          }
        }
        fail("NOT_FOUND", 404);
      } catch (e) {
        reply(res, e instanceof BrokerError ? e.status : 503, safeError(e));
      }
    });
    servers.push(human);
    return {
      addresses,
      health,
      async start() {
        if (started || closed) fail("INVALID_STATE");
        try {
          for (const [server, role] of [
            [human, "human"],
            [management, "management"],
            [combined, "agent"],
          ]) {
            await new Promise((resolve, reject) => {
              server.once("error", reject);
              server.listen(
                config.listeners[role].port,
                config.listeners[role].host,
                resolve,
              );
            });
            addresses[role] = {
              origin: config.listeners[role].origin,
              host: config.listeners[role].host,
              port: server.address().port,
            };
          }
          started = true;
          await probeVault();
          probeTimer = setInterval(probeVault, 5000);
          probeTimer.unref();
          return addresses;
        } catch (e) {
          await close();
          throw e;
        }
      },
      close,
    };
  } catch (e) {
    await close();
    throw e;
  }
}
