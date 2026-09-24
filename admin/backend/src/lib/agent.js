// Node client for the host-side proxypilot-agent (Phase A scaffold —
// see docs/features/security-completion/master-spec.md § Phase A).
//
// Wire protocol — JSON-over-newline, one request/response per
// connection (the agent does not pool):
//
//   Request:  {"id":<int>,"method":"<name>","params":{...}}\n
//   Response: {"id":<int>,"result":<any>}\n
//             {"id":<int>,"error":{"code":"<code>","message":"<msg>"}}\n
//
// This client is used by the partial host-agent migration. The web backend
// still has direct host access; see docs/core/security-host-boundary.md.
//
// The default socket path comes from PROXYPILOT_AGENT_SOCKET (set in
// docker-compose.yml). Override per-call via opts.socketPath for
// tests or alternate setups.

import net from 'node:net';

const DEFAULT_SOCKET = '/run/proxypilot-agent/proxypilot-agent.sock';
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_REQUEST_BYTES = 64 * 1024;

let nextId = 1;

/**
 * Call a method on the host-side agent.
 *
 * @param {string} method  Dotted method name, e.g. "agent.ping".
 * @param {object} [params]  JSON-serialisable params object.
 * @param {object} [opts]
 * @param {string} [opts.socketPath]  Override the default socket path.
 * @param {number} [opts.timeoutMs]  End-to-end timeout in ms (default 30s).
 * @param {number} [opts.maxResponseBytes]  Response ceiling (default 64 KiB; storage.* methods pass more).
 * @returns {Promise<any>}  The `result` field on success.
 * @throws {AgentError}  On a structured method error.
 * @throws {Error}  On transport or protocol failure.
 */
export function agentCall(method, params = {}, opts = {}) {
  const socketPath =
    opts.socketPath ||
    process.env.PROXYPILOT_AGENT_SOCKET ||
    DEFAULT_SOCKET;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = opts.maxResponseBytes ?? MAX_RESPONSE_BYTES;
  const id = nextId++;

  return new Promise((resolve, reject) => {
    if (typeof method !== 'string' || method.length > 128 || !/^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+$/.test(method)) {
      throw new Error('Invalid agent method');
    }
    // Serialize inside the Promise, before connecting: cyclic/oversized input
    // rejects the call instead of throwing from a later socket event callback.
    const line = JSON.stringify({ id, method, params }) + '\n';
    if (Buffer.byteLength(line) > MAX_REQUEST_BYTES) throw new Error('Agent request exceeds 64 KiB line limit');
    const socket = net.createConnection(socketPath);
    const buffers = [];
    let totalBytes = 0;
    let done = false;
    let timer = null;

    const finish = (err, value) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else resolve(value);
    };

    timer = setTimeout(() => {
      finish(new Error(`agent call ${method} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    socket.on('error', (err) => finish(err));

    socket.on('connect', () => {
      socket.write(line);
    });

    socket.on('data', (chunk) => {
      // The agent writes exactly one line then closes. We accumulate
      // until we see the newline (or hit the byte ceiling) and parse
      // the first line. Trailing bytes after \n would be a protocol
      // bug on the agent side — we ignore them.
      if (done) return;
      totalBytes += chunk.length;
      if (totalBytes > maxResponseBytes) {
        finish(new Error(`agent response exceeds ${maxResponseBytes} bytes`));
        return;
      }
      buffers.push(chunk);
    });

    socket.on('end', () => parseAndResolve(method, id, buffers, finish));
    socket.on('close', () => parseAndResolve(method, id, buffers, finish));
  });
}

function parseAndResolve(method, expectedId, buffers, finish) {
  const buf = Buffer.concat(buffers);
  if (buf.length === 0) {
    finish(new Error(`agent closed connection without responding to ${method}`));
    return;
  }
  const newlineIdx = buf.indexOf(0x0a); // \n
  const lineBuf = newlineIdx >= 0 ? buf.subarray(0, newlineIdx) : buf;
  let resp;
  try {
    resp = JSON.parse(lineBuf.toString('utf8'));
  } catch (err) {
    finish(new Error('agent returned invalid JSON'));
    return;
  }
  if (resp == null || typeof resp !== 'object') {
    finish(new Error('agent response was not a JSON object'));
    return;
  }
  if (resp.id !== expectedId) {
    // Phase A is one-call-per-connection; an id mismatch means the
    // agent broke protocol. Treat as fatal so misbehaving builds
    // surface immediately rather than silently corrupting callers.
    finish(new Error(`agent response id ${resp.id} did not match request id ${expectedId}`));
    return;
  }
  if (resp.error) {
    finish(new AgentError(resp.error.code || 'unknown', resp.error.message || ''));
    return;
  }
  finish(null, resp.result);
}

/**
 * Structured method error returned by the agent (`{"code":...,"message":...}`).
 * Distinguishable from transport errors via `instanceof`.
 */
export class AgentError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'AgentError';
    this.code = code;
  }
}
