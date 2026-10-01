import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import https from "node:https";
import { randomUUID, randomBytes } from "node:crypto";
import { createTransport, createLedgerAdapter } from "../transport.mjs";
import { createOpenBaoClient, splitVault } from "../openbao.mjs";
export const IMAGE =
  "openbao/openbao:2.6.2@sha256:11fd73a2102cda9c55d5d881a8c3210303146a7ec1e8ac76f526e175c6d24641";
const docker = (...args) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
export async function createDisposableFixture(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "fractionate-broker-fixture-")),
    name = `fractionate-broker-${randomUUID()}`;
  let ledger,
    container = false;
  try {
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-keyout",
        join(dir, "key.pem"),
        "-out",
        join(dir, "cert.pem"),
        "-subj",
        "/CN=broker.fixture.test",
        "-addext",
        "subjectAltName=DNS:bao.fixture.test,DNS:ledger.fixture.test,DNS:broker.fixture.test",
      ],
      { stdio: "ignore" },
    );
    chmodSync(join(dir, "key.pem"), 0o600);
    const key = readFileSync(join(dir, "key.pem")),
      cert = readFileSync(join(dir, "cert.pem"));
    writeFileSync(
      join(dir, "bao.hcl"),
      'disable_mlock = true\napi_addr = "https://bao.fixture.test:8200"\nstorage "inmem" {}\nlistener "tcp" {\n address = "0.0.0.0:8200"\n tls_cert_file = "/fixture/cert.pem"\n tls_key_file = "/fixture/key.pem"\n}\n',
      { mode: 0o600 },
    );
    docker(
      "create",
      "--name",
      name,
      "--label",
      "fractionate.synthetic-broker=true",
      "--user",
      "0",
      "--entrypoint",
      "bao",
      "-p",
      "127.0.0.1::8200",
      IMAGE,
      "server",
      "-config=/fixture/bao.hcl",
    );
    container = true;
    docker("cp", dir + "/.", name + ":/fixture");
    docker("start", name);
    const baoPort = Number(docker("port", name, "8200/tcp").split(":").at(-1));
    const resolve = async () => [{ address: "127.0.0.1", family: 4 }];
    const baoTransport = createTransport({
      origin: `https://bao.fixture.test:${baoPort}`,
      allowEmpty: true,
      ca: cert,
      resolve,
      fixture: {
        host: "bao.fixture.test",
        port: baoPort,
        address: "127.0.0.1",
      },
    });
    let init;
    for (let i = 0; i < 60; i++) {
      try {
        init = await baoTransport("POST", "/v1/sys/init", {
          body: { secret_shares: 1, secret_threshold: 1 },
        });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    if (!init?.root_token)
      throw Error("Disposable OpenBao initialization failed");
    await baoTransport("POST", "/v1/sys/unseal", {
      body: { key: init.keys_base64[0] },
    });
    const root = init.root_token;
    const provision = async (path, body) =>
      baoTransport("POST", path, { body, headers: { "X-Vault-Token": root } });
    await provision("/v1/sys/mounts/fractionate-broker-kv", {
      type: "kv",
      options: { version: "2" },
    });
    await provision("/v1/sys/auth/approle", { type: "approle" });
    const owner = options.owner || randomUUID(),
      project = options.project || randomUUID(),
      agent = options.agent || randomUUID(),
      resource = options.resource || randomUUID(),
      credential = randomBytes(32).toString("base64url");
    // Provision exact opaque slots before service startup; runtime never provisions ACLs.
    const credentialIds = Array.from({ length: 8 }, () => randomUUID()),
      available = [...credentialIds];
    const role = async (name, capabilities) => {
      const policy = credentialIds
        .map(
          (cid) =>
            `path "fractionate-broker-kv/data/owners/${owner}/credentials/${cid}" { capabilities = [${capabilities.map((x) => `"${x}"`).join(",")}] }\npath "fractionate-broker-kv/metadata/owners/${owner}/credentials/${cid}" { capabilities = ["read"] }`,
        )
        .join("\n");
      await provision(`/v1/sys/policies/acl/${name}`, { policy });
      await provision(`/v1/auth/approle/role/${name}`, {
        token_policies: [name],
        token_ttl: "60s",
        token_max_ttl: "300s",
        secret_id_ttl: "1h",
        token_no_default_policy: true,
      });
      const rid = await baoTransport(
        "GET",
        `/v1/auth/approle/role/${name}/role-id`,
        { headers: { "X-Vault-Token": root } },
      );
      const sid = await provision(
        `/v1/auth/approle/role/${name}/secret-id`,
        {},
      );
      return { roleId: rid.data.role_id, secretId: sid.data.secret_id };
    };
    const readerCredentials = await role("broker-read", ["read"]),
      enrollerCredentials = await role("broker-enroll", [
        "create",
        "update",
        "read",
      ]);
    const reader = createOpenBaoClient({
        transport: baoTransport,
        ...readerCredentials,
      }),
      enroller = createOpenBaoClient({
        transport: baoTransport,
        ...enrollerCredentials,
        canWrite: true,
      });
    let accepted = credential,
      state = "open",
      effects = 0,
      requests = 0,
      mode = "normal";
    ledger = https.createServer({ key, cert }, async (req, res) => {
      requests++;
      if (req.headers.authorization !== `Bearer ${accepted}`) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end('{"error":"denied"}');
        return;
      }
      if (req.url !== `/v1/items/${resource}`) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end("{}");
        return;
      }
      let raw = "";
      for await (const c of req) raw += c;
      if (mode === "redirect") {
        res.writeHead(302, { Location: "https://169.254.169.254/" });
        res.end();
        return;
      }
      if (mode === "slow") {
        return;
      }
      if (req.method === "POST") {
        state = JSON.parse(raw).state;
        effects++;
        if (mode === "lost") {
          req.socket.destroy();
          return;
        }
      }
      res.setHeader("Content-Type", "application/json");
      if (mode === "compressed") {
        res.setHeader("Content-Encoding", "gzip");
        res.end("bad");
        return;
      }
      if (mode === "large") {
        res.end("x".repeat(40000));
        return;
      }
      if (mode === "echo-header") res.setHeader("X-Credential-Echo", accepted);
      if (mode.startsWith("echo-body")) {
        res.end(
          JSON.stringify({
            resource_id: resource,
            state: "open",
            echo: mode.endsWith("base64")
              ? Buffer.from(accepted).toString("base64")
              : accepted,
          }),
        );
        return;
      }
      res.end(
        JSON.stringify({
          resource_id: resource,
          state,
          ...(req.method === "POST" ? { applied: true } : {}),
        }),
      );
    });
    await new Promise((r) => ledger.listen(0, "127.0.0.1", r));
    const ledgerPort = ledger.address().port;
    const upstream = createLedgerAdapter(
      createTransport({
        origin: `https://ledger.fixture.test:${ledgerPort}`,
        ca: cert,
        resolve,
        fixture: {
          host: "ledger.fixture.test",
          port: ledgerPort,
          address: "127.0.0.1",
        },
      }),
    );
    return {
      dir,
      key,
      cert,
      owner,
      project,
      agent,
      resource,
      credential,
      credentialIds,
      vault: {
        ...splitVault({ reader, enroller }),
        allocateCredentialId(requestOwner) {
          if (requestOwner !== owner || !available.length)
            throw Error("Fixture slot unavailable");
          return available.shift();
        },
      },
      reader,
      enroller,
      upstream,
      baoTransport,
      readerCredentials,
      provision,
      root,
      baoPort,
      ledgerPort,
      get effects() {
        return effects;
      },
      get requests() {
        return requests;
      },
      setMode(value) {
        mode = value;
      },
      setCredential(value) {
        accepted = value;
      },
      async close() {
        ledger.closeAllConnections();
        await new Promise((r) => ledger.close(r));
        docker("rm", "-f", name);
        rmSync(dir, { recursive: true, force: true });
      },
    };
  } catch (e) {
    if (ledger) ledger.close();
    if (container)
      try {
        docker("rm", "-f", name);
      } catch {}
    rmSync(dir, { recursive: true, force: true });
    throw new Error("Disposable fixture setup failed", { cause: e });
  }
}
