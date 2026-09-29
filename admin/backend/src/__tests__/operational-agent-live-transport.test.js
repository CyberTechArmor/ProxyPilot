import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { createSupervisorClient } from '../lib/operational-worker-supervisor.js';
import { attachAgentLiveServer, MAX_VIEWS_PER_USER } from '../routes/agent-live-ws.js';

// A7 live relay transport: the supervisor client's streaming call against a
// Unix socket speaking the supervisor's LiveStream protocol, and the live
// WebSocket route against a real HTTP server and ws client (the service faked).

const PID = '11111111-2222-4333-8444-555555555555';
const RID = '66666666-7777-4888-9999-aaaaaaaaaaaa';
const ICE = [{ urls: ['turns:turn.example.com:5349?transport=tcp'], username: '1790000000:0123456789abcdef',
  credential: `${'A'.repeat(27)}=` }];
const wait = ms => new Promise(done => setTimeout(done, ms));
async function until(fn, label, ms = 3000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await wait(5);
  }
}

// A socket server that answers the first line with `first`, then runs `script`.
function streamServer(first, script = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pp-a7-live-'));
  const path = join(dir, 'backend.sock');
  const lines = [];
  const sockets = [];
  const server = net.createServer(socket => {
    sockets.push(socket);
    let buffer = '', opened = false;
    socket.setEncoding('utf8');
    socket.on('error', () => {});
    socket.on('data', chunk => {
      buffer += chunk;
      for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
        const line = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        lines.push(line);
        if (!opened) { opened = true; socket.write(typeof first === 'string' ? `${first}\n` : `${JSON.stringify(first)}\n`); script(socket); }
      }
    });
  });
  return new Promise(ready => server.listen(path, () => ready({ path, lines, sockets,
    close: () => new Promise(done => { sockets.forEach(s => s.destroy()); server.close(() => { rmSync(dir, { recursive: true, force: true }); done(); }); }) })));
}

test('stream: the first line opens, then relayed lines, drops and exactly one close', async () => {
  const opened = { ok: true, result: { conn: '0123456789abcdef', ice_servers: ICE, ttl_seconds: 3600 } };
  // The first relayed messages arrive in the same chunk as the answer.
  const fake = await streamServer(opened, socket => socket.write(
    `${JSON.stringify({ recv: { event: 'system/init', payload: { session_id: 'x' } } })}\n${JSON.stringify({ dropped: true })}\n`));
  const got = [], closes = [];
  try {
    const client = createSupervisorClient(fake.path);
    const live = await client.stream('live', { run_id: RID, attempt_id: RID, fence: 1 },
      { onMessage: m => got.push(m), onClose: r => closes.push(r) });
    assert.equal(live.conn, '0123456789abcdef');
    assert.deepEqual(live.ice_servers, ICE);
    await until(() => got.length === 2, 'relayed lines');
    assert.deepEqual(got, [{ event: 'system/init', payload: { session_id: 'x' } }, null]);
    assert.equal(live.send({ event: 'signal/answer', payload: { sdp: 'v=0' } }), true);
    assert.equal(live.send({ event: 'signal/answer', payload: { sdp: 'x'.repeat(300 * 1024) } }), false);
    await until(() => fake.lines.length === 2, 'send line');
    assert.deepEqual(fake.lines, [{ method: 'live', params: { run_id: RID, attempt_id: RID, fence: 1 } },
      { send: { event: 'signal/answer', payload: { sdp: 'v=0' } } }]);
    fake.sockets[0].write(`${JSON.stringify({ closed: 'attempt_ended' })}\n`);
    await until(() => closes.length, 'close');
    await wait(20);
    assert.deepEqual(closes, ['attempt_ended']);
    assert.equal(live.send({ event: 'client/heartbeat' }), false);
  } finally { await fake.close(); }
});

test('stream: a refusal, a garbage answer, an unreachable socket and a viewer close', async () => {
  for (const [first, code] of [[{ ok: false, error: 'LIVE_UNAVAILABLE' }, 'LIVE_UNAVAILABLE'],
    [{ ok: false, error: 'not a code' }, 'SUPERVISOR_PROTOCOL'], ['not json', 'SUPERVISOR_PROTOCOL']]) {
    const fake = await streamServer(first);
    try {
      await assert.rejects(createSupervisorClient(fake.path).stream('live', {}), { code });
    } finally { await fake.close(); }
  }
  await assert.rejects(createSupervisorClient('/nonexistent/a3.sock').stream('live', {}), { code: 'SUPERVISOR_UNREACHABLE' });
  await assert.rejects(createSupervisorClient('/nonexistent/a3.sock').stream('status', {}), { code: 'METHOD_NOT_ALLOWED' });
  const fake = await streamServer({ ok: true, result: { conn: '0123456789abcdef', ice_servers: ICE, ttl_seconds: 3600 } });
  const closes = [];
  try {
    const live = await createSupervisorClient(fake.path).stream('live', {}, { onClose: r => closes.push(r) });
    live.close();
    await until(() => fake.lines.some(l => l.close === true), 'close line');
    fake.sockets[0].end(`${JSON.stringify({ closed: 'viewer_closed' })}\n`);
    await until(() => closes.length, 'closed');
    assert.deepEqual(closes, ['viewer_closed']);
  } finally { await fake.close(); }
});

// A live route on a real server, with a fake service and session check.
async function liveServer(options = {}) {
  const calls = { opened: [], sent: [], closed: [] };
  const state = { enabled: true, allow: true, verify: true, unavailable: null };
  const handles = [];
  const agentRuns = {
    assertLive(actor, projectId, runId) {
      if (!state.allow) { const e = new Error('no'); e.status = 403; throw e; }
      assert.deepEqual([projectId, runId], [PID, RID]);
      return true;
    },
    async openLive(actor, projectId, runId, { sessionId, onMessage, onClose }) {
      if (state.unavailable) { const e = new Error('The live view is not available.'); e.code = state.unavailable; throw e; }
      const viewer = `${handles.length}`.padStart(16, '0');
      handles.push({ viewer, onMessage, onClose });
      calls.opened.push({ actor: actor.id, sessionId, viewer });
      return { viewer, ice_servers: ICE, ttl_seconds: 3600 };
    },
    sendLive(viewer, actorId, message) { calls.sent.push({ viewer, actorId, message }); return true; },
    closeLive(viewer, reason) { calls.closed.push({ viewer, reason }); },
  };
  const verify = req => {
    if (!state.verify) { const e = new Error('Token expired'); e.statusCode = 401; throw e; }
    const user = String(req.headers['x-user'] || 'u1');
    return { user: { id: user, jti: `jti-${user}` } };
  };
  const server = http.createServer((_req, res) => res.end());
  attachAgentLiveServer(server, { agentRuns, enabled: () => state.enabled, verify, actorOf: u => ({ id: u.id }),
    recheckMs: 40, heartbeatMs: 30, pingMs: 1000, ...options });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const url = `ws://127.0.0.1:${server.address().port}/api/operational-projects/${PID}/agent-runs/${RID}/live`;
  const open = (user = 'u1') => new Promise((resolve) => {
    const ws = new WebSocket(url, { headers: { 'x-user': user } });
    const messages = [];
    ws.on('message', data => messages.push(JSON.parse(String(data))));
    ws.on('unexpected-response', (_req, res) => resolve({ refused: res.statusCode }));
    ws.on('open', () => resolve({ ws, messages }));
    ws.on('error', () => {});
  });
  return { calls, state, handles, open, close: () => new Promise(done => server.close(done)) };
}

test('live route: refusals before the upgrade, then ready, relay both ways and filtered closing', async () => {
  const s = await liveServer();
  try {
    s.state.verify = false;
    assert.deepEqual(await s.open(), { refused: 401 });
    s.state.verify = true; s.state.enabled = false;
    assert.deepEqual(await s.open(), { refused: 404 });
    s.state.enabled = true; s.state.allow = false;
    assert.deepEqual(await s.open(), { refused: 403 });
    s.state.allow = true;
    const a = await s.open('u1');
    const ready = await until(() => a.messages.find(m => m.type === 'ready'), 'ready');
    assert.deepEqual(ready, { type: 'ready', viewer: '0000000000000000', ice_servers: ICE, ice_transport_policy: 'relay',
      ttl_seconds: 3600 });
    assert.deepEqual(s.calls.opened, [{ actor: 'u1', sessionId: 'jti-u1', viewer: '0000000000000000' }]);
    s.handles[0].onMessage({ event: 'signal/provide', payload: { sdp: 'v=0' } });
    s.handles[0].onMessage(null);
    await until(() => a.messages.length >= 3, 'relayed');
    assert.deepEqual(a.messages.slice(1), [{ type: 'neko', message: { event: 'signal/provide', payload: { sdp: 'v=0' } } },
      { type: 'dropped' }]);
    a.ws.send(JSON.stringify({ type: 'neko', message: { event: 'signal/answer', payload: { sdp: 'v=1' } } }));
    await until(() => s.calls.sent.some(c => c.message.event === 'signal/answer'), 'sent');
    // The backend, not the browser, keeps Neko's heartbeat.
    await until(() => s.calls.sent.some(c => c.message.event === 'client/heartbeat'), 'heartbeat');
    assert.ok(s.calls.sent.every(c => c.viewer === '0000000000000000' && c.actorId === 'u1'));
    // The attempt ends: the browser learns why, and the socket closes.
    s.handles[0].onClose('attempt_ended');
    await until(() => a.messages.some(m => m.type === 'closed'), 'closed');
    assert.deepEqual(a.messages.find(m => m.type === 'closed'), { type: 'closed', reason: 'attempt_ended' });
    assert.deepEqual(s.calls.closed, []);
    // Garbage from the browser closes that view.
    const b = await s.open('u2');
    await until(() => b.messages.some(m => m.type === 'ready'), 'ready b');
    b.ws.send('not json');
    await until(() => s.calls.closed.some(c => c.reason === 'invalid'), 'invalid');
    // A flood closes it too.
    const c = await s.open('u3');
    await until(() => c.messages.some(m => m.type === 'ready'), 'ready c');
    for (let i = 0; i < 60; i += 1) c.ws.send(JSON.stringify({ type: 'neko', message: { event: 'client/heartbeat' } }));
    await until(() => s.calls.closed.some(c2 => c2.reason === 'rate_limited'), 'rate limited');
    // Access removed while watching: closed at the next check.
    const d = await s.open('u4');
    await until(() => d.messages.some(m => m.type === 'ready'), 'ready d');
    s.state.allow = false;
    await until(() => d.messages.some(m => m.type === 'closed' && m.reason === 'access_ended'), 'access ended');
    s.state.allow = true;
    // A session that ends while watching, likewise.
    const e = await s.open('u5');
    await until(() => e.messages.some(m => m.type === 'ready'), 'ready e');
    s.state.verify = false;
    await until(() => e.messages.some(m => m.type === 'closed' && m.reason === 'access_ended'), 'session ended');
    s.state.verify = true;
    // The viewer closing its own socket closes its relay.
    const f = await s.open('u6');
    await until(() => f.messages.some(m => m.type === 'ready'), 'ready f');
    const viewer = f.messages.find(m => m.type === 'ready').viewer;
    f.ws.close();
    await until(() => s.calls.closed.some(x => x.viewer === viewer && x.reason === 'viewer_closed'), 'viewer closed');
  } finally { await s.close(); }
});

test('live route: an unavailable view says why; at most three views per person', async () => {
  const s = await liveServer({ recheckMs: 60_000, heartbeatMs: 60_000 });
  try {
    s.state.unavailable = 'LIVE_UNAVAILABLE';
    const a = await s.open('u1');
    const note = await until(() => a.messages.find(m => m.type === 'unavailable'), 'unavailable');
    assert.deepEqual([note.code, note.message], ['LIVE_UNAVAILABLE', 'The live view is not available.']);
    await until(() => a.ws.readyState === WebSocket.CLOSED, 'closed');
    s.state.unavailable = null;
    const views = [];
    for (let i = 0; i < MAX_VIEWS_PER_USER; i += 1) {
      const v = await s.open('u7');
      await until(() => v.messages.some(m => m.type === 'ready'), 'ready');
      views.push(v);
    }
    assert.deepEqual(await s.open('u7'), { refused: 429 });
    views[0].ws.close();
    await until(() => s.calls.closed.length >= 1, 'freed');
    const again = await s.open('u7');
    assert.ok(again.ws);
    for (const v of [...views.slice(1), again]) v.ws.close();
  } finally { await s.close(); }
});
