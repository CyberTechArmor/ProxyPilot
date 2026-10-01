import https from "node:https";
import dns from "node:dns/promises";
import net from "node:net";
import { fail, parseJson, exact, input } from "./schema.mjs";
export function publicAddress(address) {
  // First adapter intentionally supports IPv4 only; fail closed on IPv6 and mixed answers.
  if (net.isIP(address) !== 4) return false;
  const [a, b] = address.split(".").map(Number);
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && [0, 168].includes(b)) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && [18, 19, 51].includes(b)) ||
    (a === 203 && b === 0)
  );
}
/** Fixed server-owned destination. Fixture exception is exact host/address/port, never a CIDR. */
export function createTransport({
  origin,
  ca,
  resolve = dns.lookup,
  fixture = null,
  maxBytes = 32768,
  timeoutMs = 5000,
  allowEmpty = false,
}) {
  const u = new URL(origin);
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    u.pathname !== "/" ||
    u.search ||
    u.hash ||
    !u.hostname ||
    net.isIP(u.hostname) ||
    !Number.isInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > 65536 ||
    timeoutMs < 1 ||
    timeoutMs > 5000
  )
    fail("INVALID_TARGET");
  const port = Number(u.port || 443);
  if (
    fixture &&
    (fixture.host !== u.hostname ||
      fixture.port !== port ||
      net.isIP(fixture.address) !== 4 ||
      !ca)
  )
    fail("INVALID_TARGET");
  if (!fixture && port !== 443) fail("INVALID_TARGET");
  return async function request(
    method,
    path,
    { body, headers = {}, beforeSend = async () => {} } = {},
  ) {
    if (
      !["GET", "POST"].includes(method) ||
      !/^\/[A-Za-z0-9_/-]+(?:\?version=[1-9][0-9]*)?$/.test(path) ||
      path.includes("//") ||
      path.includes("..")
    )
      fail("INVALID_REQUEST");
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    if (data && data.length > 16384) fail("LIMIT_EXCEEDED", 429);
    for (const [k, v] of Object.entries(headers))
      if (
        !["Authorization", "X-Vault-Token", "Idempotency-Key"].includes(k) ||
        typeof v !== "string" ||
        /[\r\n]/.test(v)
      )
        fail("INVALID_REQUEST");
    const deadline = Date.now() + timeoutMs;
    let timer;
    try {
      const answers = await Promise.race([
        resolve(u.hostname, { all: true, verbatim: true }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error()), timeoutMs);
        }),
      ]);
      clearTimeout(timer);
      if (
        !Array.isArray(answers) ||
        !answers.length ||
        answers.some(
          (x) =>
            x.family !== 4 ||
            !(fixture
              ? x.address === fixture.address
              : publicAddress(x.address)),
        )
      )
        fail("DESTINATION_DENIED", 403);
      const address = answers[0].address;
      return await new Promise((resolveResult, reject) => {
        let settled = false;
        const done = (e, v) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          e ? reject(e) : resolveResult(v);
        };
        const req = https.request(
          {
            hostname: u.hostname,
            port,
            method,
            path,
            ca,
            rejectUnauthorized: true,
            servername: u.hostname,
            agent: false,
            lookup: (_host, options, cb) =>
              options.all
                ? cb(null, [{ address, family: 4 }])
                : cb(null, address, 4),
            headers: {
              Accept: "application/json",
              "Accept-Encoding": "identity",
              ...(data
                ? {
                    "Content-Type": "application/json",
                    "Content-Length": data.length,
                  }
                : {}),
              ...headers,
            },
          },
          (res) => {
            let length = 0;
            const chunks = [];
            if (allowEmpty && res.statusCode === 204) {
              res.resume();
              done(null, {});
              return;
            }
            if (
              res.statusCode < 200 ||
              res.statusCode >= 300 ||
              (res.headers["content-encoding"] &&
                res.headers["content-encoding"] !== "identity") ||
              !/^application\/json(?:;|$)/i.test(
                res.headers["content-type"] || "",
              )
            ) {
              res.destroy();
              done(new Error());
              return;
            }
            const names = res.rawHeaders
              .filter((_, i) => i % 2 === 0)
              .map((x) => x.toLowerCase());
            if (new Set(names).size !== names.length) {
              res.destroy();
              done(new Error());
              return;
            }
            if (Number(res.headers["content-length"] || 0) > maxBytes) {
              res.destroy();
              done(new Error());
              return;
            }
            res.on("data", (chunk) => {
              length += chunk.length;
              if (length > maxBytes) {
                res.destroy();
                done(new Error());
              } else chunks.push(chunk);
            });
            res.on("error", () => done(new Error()));
            res.on("end", () => {
              try {
                done(null, parseJson(Buffer.concat(chunks)));
              } catch {
                done(new Error());
              }
            });
          },
        );
        timer = setTimeout(
          () => {
            req.destroy();
            done(new Error());
          },
          Math.max(1, deadline - Date.now()),
        );
        req.on("error", () => done(new Error()));
        req.on("socket", (socket) =>
          socket.once("secureConnect", () => {
            Promise.resolve()
              .then(beforeSend)
              .then(() => {
                if (settled) return;
                if (data) req.write(data);
                req.end();
              })
              .catch(() => {
                req.destroy();
                done(new Error());
              });
          }),
        );
      });
    } catch {
      fail("UPSTREAM_UNAVAILABLE", 503);
    } finally {
      clearTimeout(timer);
    }
  };
}
export function createLedgerAdapter(transport) {
  return {
    async execute(operation, request, credential, { beforeSend } = {}) {
      input(operation, request);
      if (
        typeof credential !== "string" ||
        !credential.length ||
        credential.length > 4096 ||
        /[\r\n]/.test(credential)
      )
        fail("UPSTREAM_REJECTED", 502);
      const read = operation === "item.read";
      const result = await transport(
        read ? "GET" : "POST",
        `/v1/items/${request.resource_id}`,
        {
          body: read ? undefined : { state: request.state },
          headers: { Authorization: `Bearer ${credential}` },
          beforeSend,
        },
      );
      exact(
        result,
        read ? ["resource_id", "state"] : ["resource_id", "state", "applied"],
      );
      if (
        result.resource_id !== request.resource_id ||
        !["open", "closed"].includes(result.state) ||
        (!read &&
          (typeof result.applied !== "boolean" ||
            result.state !== request.state))
      )
        fail("UPSTREAM_REJECTED", 502);
      return result;
    },
  };
}
