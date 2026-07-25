'use strict';
// Server-Sent Events hub bound to authenticated user sessions.
// Transport-agnostic contract: publish(userId, event, data). Swappable for WebSocket.
const clients = new Map(); // userId -> Set<{res, sid, id}>
let seq = 0;

function addClient(userId, sid, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write('retry: 3000\n\n');
  const client = { res, sid, id: ++seq };
  if (!clients.has(userId)) clients.set(userId, new Set());
  clients.get(userId).add(client);
  send(res, 'ready', { ts: Date.now() });

  const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) {} }, 25000);
  hb.unref && hb.unref();

  const cleanup = () => {
    clearInterval(hb);
    const set = clients.get(userId);
    if (set) { set.delete(client); if (!set.size) clients.delete(userId); }
  };
  res.on('close', cleanup);
  res.on('error', cleanup);
  return client;
}

function send(res, event, data) {
  try {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  } catch (_) {}
}

function publish(userId, event, data) {
  const set = clients.get(userId);
  if (!set) return 0;
  let n = 0;
  for (const c of set) { send(c.res, event, data); n++; }
  return n;
}

function disconnectUser(userId) {
  const set = clients.get(userId);
  if (!set) return;
  for (const c of set) { try { c.res.end(); } catch (_) {} }
  clients.delete(userId);
}

function stats() {
  const out = {};
  for (const [uid, set] of clients) out[uid] = set.size;
  return out;
}

module.exports = { addClient, publish, disconnectUser, stats };
