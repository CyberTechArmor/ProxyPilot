import test from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createTransport, publicAddress } from "../transport.mjs";
import { parseJson } from "../schema.mjs";
test("strict JSON and special destination classes", () => {
  for (const x of [
    "127.0.0.1",
    "10.1.1.1",
    "169.254.169.254",
    "192.168.1.1",
    "172.16.1.1",
    "100.64.0.1",
    "::1",
    "::ffff:127.0.0.1",
    "2001:db8::1",
  ])
    assert.equal(publicAddress(x), false);
  for (const raw of ['{"x":1,"x":2}', '{"x":1,"\\u0078":2}', '{"x":1e999}'])
    assert.throws(() => parseJson(Buffer.from(raw)), /INVALID_REQUEST/);
  assert.throws(() => parseJson(Buffer.from([0xff])));
});
test(
  "TLS pinning, rebinding, redirects, bounds, timeout and final send cutoff",
  { timeout: 20000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "broker-tls-"));
    let server;
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
          join(dir, "key"),
          "-out",
          join(dir, "cert"),
          "-subj",
          "/CN=fixture.test",
          "-addext",
          "subjectAltName=DNS:fixture.test",
        ],
        { stdio: "ignore" },
      );
      const key = readFileSync(join(dir, "key")),
        cert = readFileSync(join(dir, "cert"));
      let mode = "normal",
        sends = 0;
      server = https.createServer({ key, cert }, (req, res) => {
        sends++;
        if (mode === "slow") return;
        if (mode === "redirect") {
          res.writeHead(302, { Location: "https://169.254.169.254/" });
          res.end();
          return;
        }
        res.setHeader("Content-Type", "application/json");
        if (mode === "compressed") res.setHeader("Content-Encoding", "gzip");
        res.end(mode === "large" ? "x".repeat(40000) : '{"ok":true}');
      });
      await new Promise((r) => server.listen(0, "127.0.0.1", r));
      const port = server.address().port,
        base = {
          origin: `https://fixture.test:${port}`,
          ca: cert,
          fixture: { host: "fixture.test", port, address: "127.0.0.1" },
          timeoutMs: 200,
        };
      let addresses = [{ address: "127.0.0.1", family: 4 }];
      const transport = createTransport({
        ...base,
        resolve: async () => addresses,
      });
      assert.deepEqual(await transport("GET", "/ok"), { ok: true });
      const before = sends;
      addresses = [{ address: "8.8.8.8", family: 4 }];
      await assert.rejects(transport("GET", "/ok"));
      addresses = [
        { address: "127.0.0.1", family: 4 },
        { address: "169.254.169.254", family: 4 },
      ];
      await assert.rejects(transport("GET", "/ok"));
      assert.equal(sends, before);
      addresses = [{ address: "127.0.0.1", family: 4 }];
      await assert.rejects(
        transport("GET", "/ok", {
          beforeSend: async () => {
            throw Error("revoked");
          },
        }),
      );
      assert.equal(sends, before);
      for (const path of ["/foo%2fbar", "//evil", "/../bad", "https://evil"])
        await assert.rejects(transport("GET", path));
      for (const m of ["redirect", "large", "compressed", "slow"]) {
        mode = m;
        await assert.rejects(transport("GET", "/ok"));
      }
      await assert.rejects(
        createTransport({
          ...base,
          ca: undefined,
          fixture: null,
          origin: "https://fixture.test",
          resolve: async () => addresses,
        })("GET", "/ok"),
      );
    } finally {
      server?.closeAllConnections();
      if (server) await new Promise((r) => server.close(r));
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
