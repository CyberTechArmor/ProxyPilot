// Smoke test for admin/backend/src/lib/agent.js.
//
// Spins up an in-process JSON-line server on a temporary Unix socket,
// verifies the client round-trips a successful agent.ping, surfaces
// the error envelope as an AgentError, and times out cleanly when
// the server hangs without responding.
//
// We DON'T exercise the real proxypilot-agent binary here — that's
// operator-verified via A.V2/A.V3/A.V4 on the disposable VM. The
// unit test only protects the Node-side parsing + connect/timeout
// state machine.

import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { agentCall, AgentError } from '../lib/agent.js';

// Tiny one-shot agent stub: accepts a connection, reads one JSON
// line, calls handler({id, method, params}), writes back the
// returned envelope, closes. If `hang` is true, accepts but never
// writes — used to exercise the client-side timeout path.
function startStubAgent(socketPath, handler, { hang = false } = {}) {
  const server = net.createServer((conn) => {
    if (hang) {
      // Don't read, don't write — just hold the conn open until
      // the client times out and destroys it.
      return;
    }
    let buf = Buffer.alloc(0);
    conn.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const nl = buf.indexOf(0x0a);
      if (nl < 0) return;
      const line = buf.subarray(0, nl).toString('utf8');
      let req;
      try { req = JSON.parse(line); } catch (e) {
        conn.end(JSON.stringify({ id: 0, error: { code: 'parse_error', message: e.message } }) + '\n');
        return;
      }
      const envelope = handler(req);
      conn.end(JSON.stringify(envelope) + '\n');
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => resolve(server));
  });
}

async function withStub(handler, opts, run) {
  const dir = await mkdtemp(join(tmpdir(), 'pp-agent-test-'));
  const socketPath = join(dir, 'agent.sock');
  const server = await startStubAgent(socketPath, handler, opts);
  try {
    await run(socketPath);
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test('agentCall round-trips agent.ping and returns the result', async () => {
  await withStub(
    (req) => ({ id: req.id, result: 'pong' }),
    {},
    async (socketPath) => {
      const result = await agentCall('agent.ping', {}, { socketPath });
      assert.equal(result, 'pong');
    }
  );
});

test('agentCall throws AgentError when the agent returns an error envelope', async () => {
  await withStub(
    (req) => ({ id: req.id, error: { code: 'method_not_found', message: 'no such method' } }),
    {},
    async (socketPath) => {
      await assert.rejects(
        () => agentCall('does.not.exist', {}, { socketPath }),
        (err) => {
          assert.ok(err instanceof AgentError, 'expected AgentError');
          assert.equal(err.code, 'method_not_found');
          assert.match(err.message, /no such method/);
          return true;
        }
      );
    }
  );
});

test('agentCall times out cleanly when the agent hangs', async () => {
  await withStub(
    () => null, // unused — server is in hang mode
    { hang: true },
    async (socketPath) => {
      await assert.rejects(
        () => agentCall('agent.ping', {}, { socketPath, timeoutMs: 100 }),
        (err) => {
          assert.match(err.message, /timed out after 100ms/);
          return true;
        }
      );
    }
  );
});

test('agentCall surfaces a transport error when the socket does not exist', async () => {
  await assert.rejects(
    () => agentCall('agent.ping', {}, { socketPath: '/tmp/proxypilot-agent-does-not-exist.sock', timeoutMs: 1000 }),
    (err) => {
      // Connection refused or ENOENT depending on platform; both are
      // transport errors, not AgentError.
      assert.ok(!(err instanceof AgentError));
      return true;
    }
  );
});
