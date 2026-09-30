import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { relay } from '../a7-probe.mjs';

const opened = { viewer: '0123456789abcdef', ice_servers: [], ttl_seconds: 3600 };
async function serve(openLive, check) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a7-opening-'));
  const world = { dir, relays: [] }, closed = [];
  const r = relay(world, { s: { openLive, closeLive: (viewer, reason) => closed.push({ viewer, reason }), assertLive() {} } },
    { id: 'operator' }, 'session', 'project', 'run');
  let client;
  try {
    await r.ready;
    client = net.createConnection(r.file);
    client.on('error', () => {});
    const lines = [], waiting = [];
    readline.createInterface({ input: client }).on('line', line => {
      lines.push(JSON.parse(line)); waiting.splice(0).forEach(done => done());
    });
    const count = async n => {
      while (lines.length < n) await Promise.race([new Promise(done => waiting.push(done)),
        new Promise((_, reject) => setTimeout(() => reject(new Error('relay response timeout')), 3000).unref())]);
    };
    await new Promise(done => client.once('connect', done));
    client.write('{}\n');
    await check({ client, lines, count, closed });
  } finally {
    client?.destroy(); await r.close(); fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('host proof relay opens before messages emitted synchronously by openLive', async () => {
  const early = [{ event: 'system/init', payload: { session_id: 'me' } }, null,
    { event: 'signal/candidate', payload: { candidate: 'early' } }, { event: 'signal/provide', payload: { sdp: 'v=0' } }];
  await serve(async (_actor, _project, _run, { onMessage }) => {
    early.forEach(onMessage); return opened;
  }, async ({ lines, count }) => {
    await count(5);
    assert.deepEqual(lines[0], { ok: true, result: { conn: opened.viewer, ice_servers: [], ttl_seconds: 3600 } });
    assert.deepEqual(lines.slice(1), early.map(m => m === null ? { dropped: true } : { recv: m }));
  });
});

test('host proof relay discards queued messages when opening rejects', async () => {
  await serve(async (_actor, _project, _run, { onMessage }) => {
    onMessage({ event: 'system/init' }); throw Object.assign(new Error('no'), { code: 'LIVE_UNAVAILABLE' });
  }, async ({ lines, count }) => {
    await count(1);
    assert.deepEqual(lines, [{ ok: false, error: 'LIVE_UNAVAILABLE' }]);
  });
});

test('host proof relay discards queued messages and the handle when opening closes', async () => {
  await serve(async (_actor, _project, _run, { onMessage, onClose }) => {
    onMessage({ event: 'system/init' }); onClose('attempt_ended'); return opened;
  }, async ({ lines, count, closed }) => {
    await count(1);
    assert.deepEqual(lines, [{ closed: 'attempt_ended' }]);
    assert.deepEqual(closed, [{ viewer: opened.viewer, reason: 'viewer_closed' }]);
  });
});
