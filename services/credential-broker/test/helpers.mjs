import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import { createBroker } from "../broker.mjs";
export const U = randomUUID,
  key = () => randomBytes(32).toString("base64url");
export async function world({
  vault: providedVault,
  upstream: providedUpstream,
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "broker-test-"));
  let time = Date.now();
  const owner = U(),
    project = U(),
    agent = U(),
    resource = U(),
    proof = key();
  let eligible = true,
    sends = 0;
  const secrets = new Map();
  const vault = providedVault || {
    async write(path, value, { cas, intent }) {
      const old = secrets.get(path) || [];
      if (old.length !== cas) throw Error("CAS");
      old.push({ value, intent, version: old.length + 1 });
      secrets.set(path, old);
      return { version: old.length };
    },
    async read(path, version) {
      const r = secrets.get(path)?.[version - 1];
      if (!r) throw Error("sealed");
      return r;
    },
  };
  const upstream = providedUpstream || {
    async execute(op, r) {
      sends++;
      return {
        resource_id: r.resource_id,
        state: r.state || "open",
        ...(op === "item.read" ? {} : { applied: true }),
      };
    },
  };
  const users = new Map([[proof, owner]]);
  const authority = {
    async authenticate(p) {
      if (!users.has(p)) throw Error();
      return { user_id: users.get(p), fresh_until: time + 60000 };
    },
    async eligible(s) {
      return (
        eligible &&
        s.user_id === owner &&
        s.agent_id === agent &&
        s.project_id === project
      );
    },
    async canAssign(p, g) {
      return (
        p.user_id === owner && g.project_id === project && g.agent_id === agent
      );
    },
  };
  const options = {
    dbPath: join(dir, "state.db"),
    vault,
    upstream,
    authority,
    clock: () => time,
    mode: "synthetic",
  };
  let broker = createBroker(options);
  const meta = {
    name: "Synthetic ledger",
    project_id: project,
    adapter_id: "synthetic-ledger-v1",
    operations: ["item.read", "item.set_state"],
    resources: [resource],
    limits: { max_actions: 20, max_seconds: 300 },
  };
  const grantRequest = () => ({
    user_id: owner,
    project_id: project,
    agent_id: agent,
    operations: meta.operations,
    resources: meta.resources,
    limits: meta.limits,
    expires_at: time + 600000,
  });
  const sessionRequest = () => ({
    task_id: U(),
    attempt: U(),
    fence: U(),
    operations: meta.operations,
    resources: meta.resources,
    limits: meta.limits,
    expires_at: time + 290000,
    audience: "fractionate-broker",
  });
  return {
    dir,
    owner,
    project,
    agent,
    resource,
    proof,
    users,
    meta,
    options,
    authority,
    vault,
    upstream,
    secrets,
    grantRequest,
    sessionRequest,
    get broker() {
      return broker;
    },
    get sends() {
      return sends;
    },
    tick(n) {
      time += n;
    },
    disable() {
      eligible = false;
    },
    async ready() {
      const c = await broker.enroll(proof, meta, key());
      await broker.testConnection(proof, c.id, c.revision);
      const g = await broker.assign(proof, c.id, c.revision, grantRequest());
      const s = await broker.issueSession(proof, g.id, sessionRequest());
      return { c, g, s };
    },
    restart() {
      broker.close();
      broker = createBroker(options);
    },
    close() {
      broker.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
