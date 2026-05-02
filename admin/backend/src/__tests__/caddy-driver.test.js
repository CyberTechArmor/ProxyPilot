// Tests for the Phase B dual-track Caddy driver
// (admin/backend/src/lib/caddy-driver.js).
//
// Strategy:
// * Flag-OFF path is the existing nsenter/execOnHost code path; we
//   don't unit-test it here because it's a literal exec to the host
//   and the test runner doesn't have caddy installed. Operator V1
//   covers it on the disposable VM.
// * Flag-ON path is what's new — we stand up a stub Unix-socket
//   server that speaks the agent's JSON-line wire and drive
//   caddyAdapt/caddyReload through it.
// * Path-validation regressions on the agent side are covered by
//   cmd/agent/methods/caddy_test.go; this file only protects the
//   backend-side glue (flag toggle, error shape, agent-call wiring).

import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';

const FLAG = 'PROXYPILOT_USE_AGENT_FOR_CADDY';

// startStubAgent: identical pattern to agent.test.js — accepts one
// JSON request line, calls handler({id, method, params}), writes
// the returned envelope, closes.
function startStubAgent(socketPath, handler) {
  const server = net.createServer((conn) => {
    let buf = Buffer.alloc(0);
    conn.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const nl = buf.indexOf(0x0a);
      if (nl < 0) return;
      const line = buf.subarray(0, nl).toString('utf8');
      const req = JSON.parse(line);
      const envelope = handler(req);
      conn.end(JSON.stringify(envelope) + '\n');
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => resolve(server));
  });
}

async function withAgentOn(handler, run) {
  const dir = await mkdtemp(join(tmpdir(), 'pp-caddy-driver-test-'));
  const socketPath = join(dir, 'agent.sock');
  const caddyfilePath = join(dir, 'Caddyfile');
  await writeFile(caddyfilePath, ':80 {\n  respond \"ok\"\n}\n');
  const server = await startStubAgent(socketPath, handler);
  const prevFlag = process.env[FLAG];
  const prevSocket = process.env.PROXYPILOT_AGENT_SOCKET;
  process.env[FLAG] = 'true';
  process.env.PROXYPILOT_AGENT_SOCKET = socketPath;
  try {
    // Re-import the driver fresh so the test sees the env it set.
    // ESM caches modules, so we use a cache-busting query string to
    // get a clean copy each call.
    const mod = await import(`../lib/caddy-driver.js?t=${Date.now()}-${Math.random()}`);
    await run({ ...mod, caddyfilePath, socketPath });
  } finally {
    server.close();
    if (prevFlag === undefined) delete process.env[FLAG];
    else process.env[FLAG] = prevFlag;
    if (prevSocket === undefined) delete process.env.PROXYPILOT_AGENT_SOCKET;
    else process.env.PROXYPILOT_AGENT_SOCKET = prevSocket;
    await rm(dir, { recursive: true, force: true });
  }
}

test('flag OFF: caddyAdapt does not call agent (uses execOnHost path)', async () => {
  // No env, no agent socket — caddyAdapt should NOT throw an
  // AgentError. It will throw an execOnHost error because caddy
  // isn't installed on the test runner; we just assert the failure
  // shape is exec-like, not agent-like.
  delete process.env[FLAG];
  const { caddyAdapt } = await import(`../lib/caddy-driver.js?t=${Date.now()}-off-adapt`);
  await assert.rejects(
    () => caddyAdapt({ configPath: '/nonexistent/Caddyfile', timeoutMs: 2000 }),
    (err) => {
      // execAsync surfaces ENOENT-ish errors with .stderr or
      // .message — either way, it's not an AgentError.
      assert.ok(err.message);
      assert.ok(!('code' in err) || err.code !== 'method_not_found');
      return true;
    }
  );
});

test('flag ON: caddyAdapt forwards Caddyfile contents as config_text', async () => {
  let captured = null;
  await withAgentOn(
    (req) => {
      captured = req;
      return { id: req.id, result: { ok: true, adapted_json: '{\"apps\":{}}' } };
    },
    async ({ caddyAdapt, caddyfilePath }) => {
      const { stdout } = await caddyAdapt({ configPath: caddyfilePath, timeoutMs: 2000 });
      assert.equal(captured.method, 'caddy.adapt');
      assert.match(captured.params.config_text, /respond "ok"/);
      assert.match(stdout, /apps/);
    }
  );
});

test('flag ON: caddyAdapt surfaces agent ok=false as exec-like error', async () => {
  await withAgentOn(
    (req) => ({ id: req.id, result: { ok: false, error: 'syntax error: line 3' } }),
    async ({ caddyAdapt, caddyfilePath }) => {
      await assert.rejects(
        () => caddyAdapt({ configPath: caddyfilePath, timeoutMs: 2000 }),
        (err) => {
          assert.match(err.stderr, /syntax error: line 3/);
          assert.match(err.message, /caddy adapt/);
          return true;
        }
      );
    }
  );
});

test('flag ON: caddyAdapt surfaces transport error with exec-like shape', async () => {
  const prevFlag = process.env[FLAG];
  const prevSocket = process.env.PROXYPILOT_AGENT_SOCKET;
  process.env[FLAG] = 'true';
  process.env.PROXYPILOT_AGENT_SOCKET = '/tmp/proxypilot-agent-does-not-exist.sock';
  try {
    const { caddyAdapt } = await import(`../lib/caddy-driver.js?t=${Date.now()}-tx`);
    const dir = await mkdtemp(join(tmpdir(), 'pp-caddy-driver-tx-'));
    const caddyfilePath = join(dir, 'Caddyfile');
    await writeFile(caddyfilePath, ':80 {\n}\n');
    try {
      await assert.rejects(
        () => caddyAdapt({ configPath: caddyfilePath, timeoutMs: 1000 }),
        (err) => {
          assert.ok(err.stderr !== undefined, 'expected exec-like .stderr');
          return true;
        }
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  } finally {
    if (prevFlag === undefined) delete process.env[FLAG];
    else process.env[FLAG] = prevFlag;
    if (prevSocket === undefined) delete process.env.PROXYPILOT_AGENT_SOCKET;
    else process.env.PROXYPILOT_AGENT_SOCKET = prevSocket;
  }
});

test('flag ON: caddyReload forwards config_path to agent', async () => {
  let captured = null;
  await withAgentOn(
    (req) => {
      captured = req;
      return { id: req.id, result: { ok: true } };
    },
    async ({ caddyReload }) => {
      await caddyReload({ configPath: '/etc/caddy/Caddyfile', timeoutMs: 2000 });
      assert.equal(captured.method, 'caddy.reload');
      assert.equal(captured.params.config_path, '/etc/caddy/Caddyfile');
    }
  );
});

test('flag ON: caddyReload surfaces agent ok=false as exec-like error', async () => {
  await withAgentOn(
    (req) => ({ id: req.id, result: { ok: false, error: 'address already in use' } }),
    async ({ caddyReload }) => {
      await assert.rejects(
        () => caddyReload({ configPath: '/etc/caddy/Caddyfile', timeoutMs: 2000 }),
        (err) => {
          assert.match(err.stderr, /address already in use/);
          assert.match(err.message, /caddy reload/);
          return true;
        }
      );
    }
  );
});

test('flag literal "false" disables agent path', async () => {
  // Defence-in-depth: only the literal string 'true' enables the
  // agent path. 'false', '1', '0', 'TRUE', missing — all use nsenter.
  for (const value of ['false', '1', '0', 'TRUE', 'yes', '']) {
    process.env[FLAG] = value;
    const { caddyAdapt } = await import(`../lib/caddy-driver.js?t=${Date.now()}-${value}`);
    await assert.rejects(
      // Will fail with execOnHost error because caddy isn't installed,
      // but the failure must NOT be an agent-call failure.
      () => caddyAdapt({ configPath: '/nonexistent/Caddyfile', timeoutMs: 1000 }),
      (err) => {
        assert.ok(!err.message.includes('caddy.adapt'),
          `flag value ${JSON.stringify(value)} should not have triggered agent path`);
        return true;
      }
    );
  }
  delete process.env[FLAG];
});
