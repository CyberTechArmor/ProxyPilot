import https from "node:https";
import { VERSION, BrokerError, safeError, parseJson, fail } from "./schema.mjs";
/** Agent listener has no enrollment, management, session minting or vault routes. */
export function createAgentServer({ broker, key, cert, maxConnections = 32 }) {
  if (!key || !cert) fail("TLS_REQUIRED");
  const server = https.createServer(
    {
      key,
      cert,
      requestTimeout: 6000,
      headersTimeout: 3000,
      maxHeaderSize: 8192,
    },
    async (req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Cache-Control", "no-store");
      const send = (status, value) => {
        res.writeHead(status);
        res.end(JSON.stringify(value));
      };
      try {
        const names = req.rawHeaders
          .filter((_, i) => i % 2 === 0)
          .map((x) => x.toLowerCase());
        if (new Set(names).size !== names.length) fail("INVALID_REQUEST");
        const auth = req.headers.authorization;
        if (!auth || !/^Bearer [A-Za-z0-9_-]{43}$/.test(auth))
          fail("AUTH_REQUIRED", 401);
        const token = auth.slice(7);
        if (req.method === "POST" && req.url === "/v1/operations") {
          if (
            req.headers["content-type"] !== "application/json" ||
            req.headers["content-encoding"] ||
            !req.headers["idempotency-key"]
          )
            fail("INVALID_REQUEST");
          let n = 0;
          const chunks = [];
          for await (const chunk of req) {
            n += chunk.length;
            if (n > 16384) fail("LIMIT_EXCEEDED", 429);
            chunks.push(chunk);
          }
          const request = parseJson(Buffer.concat(chunks));
          send(200, {
            operation: await broker.execute(
              token,
              request,
              req.headers["idempotency-key"],
            ),
            contract_version: VERSION,
          });
        } else if (
          req.method === "GET" &&
          /^\/v1\/operations\/[0-9a-f-]+$/i.test(req.url)
        ) {
          send(200, {
            operation: await broker.getOperation(
              token,
              req.url.slice("/v1/operations/".length),
            ),
            contract_version: VERSION,
          });
        } else fail("NOT_FOUND", 404);
      } catch (e) {
        send(e instanceof BrokerError ? e.status : 503, safeError(e));
      }
    },
  );
  server.maxConnections = maxConnections;
  server.maxRequestsPerSocket = 20;
  return server;
}
