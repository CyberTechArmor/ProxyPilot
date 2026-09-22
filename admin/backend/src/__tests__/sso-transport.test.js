import test from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approvedFetch } from "../lib/sso/oidc.js";

test("G3 credential transport uses real TLS, pinned DNS, exact origin, redirect refusal and bounded responses", async () => {
  const dir = mkdtempSync(join(tmpdir(), "g3-tls-"));
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
      "/CN=identity.example.com",
      "-addext",
      "subjectAltName=DNS:identity.example.com",
    ],
    { stdio: "ignore" },
  );
  const cert = readFileSync(join(dir, "cert.pem"));
  let requests = 0;
  const server = https.createServer(
    { key: readFileSync(join(dir, "key.pem")), cert },
    (req, res) => {
      requests++;
      if (req.url === "/redirect") {
        res.writeHead(302, { Location: "https://outside.example.com/token" });
        res.end();
        return;
      }
      if (req.url === "/large") {
        res.end("x".repeat(3 * 1024 * 1024));
        return;
      }
      const chunks = [];
      req.on("data", (b) => chunks.push(b));
      req.on("end", () => {
        assert.equal(req.method, "POST");
        assert.equal(
          Buffer.concat(chunks).toString(),
          "client_secret=secret-marker",
        );
        res.setHeader("content-type", "application/json");
        res.end('{"ok":true}');
      });
    },
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const resolve = async () => [{ address: "10.20.30.40", family: 4 }];
  // Production validates/pins the approved address. This sole test seam routes
  // that approved private address to a disposable loopback HTTPS listener.
  const request = (url, options, cb) => {
    options.lookup(url.hostname, {}, (err, address) =>
      assert.equal(address, "10.20.30.40"),
    );
    return https.request(
      url,
      {
        ...options,
        port: server.address().port,
        ca: cert,
        lookup: (_host, opts, cb) =>
          opts.all
            ? cb(null, [{ address: "127.0.0.1", family: 4 }])
            : cb(null, "127.0.0.1", 4),
      },
      cb,
    );
  };
  try {
    const fetch = approvedFetch("https://identity.example.com", {
      resolve,
      request,
    });
    assert.deepEqual(
      await (
        await fetch("https://identity.example.com/token", {
          method: "POST",
          body: new URLSearchParams({ client_secret: "secret-marker" }),
        })
      ).json(),
      { ok: true },
    );
    await assert.rejects(fetch("https://outside.example.com/token"), /outside/);
    await assert.rejects(
      fetch("https://identity.example.com/redirect"),
      /redirects/,
    );
    assert.equal(requests, 2);
    await assert.rejects(
      fetch("https://identity.example.com/large"),
      (e) => !e.message.includes("secret-marker"),
    );
    await assert.rejects(
      approvedFetch("https://identity.example.com", {
        resolve: async () => [{ address: "127.0.0.1" }],
        request,
      })("https://identity.example.com/token"),
      /blocked/,
    );
    const untrusted = (url, opts, cb) =>
      https.request(
        url,
        {
          ...opts,
          port: server.address().port,
          lookup: (_h, o, cb) =>
            o.all
              ? cb(null, [{ address: "127.0.0.1", family: 4 }])
              : cb(null, "127.0.0.1", 4),
        },
        cb,
      );
    await assert.rejects(
      approvedFetch("https://identity.example.com", {
        resolve,
        request: untrusted,
      })("https://identity.example.com/token", {
        method: "POST",
        body: "client_secret=secret-marker",
      }),
      /HTTPS request failed/,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});
