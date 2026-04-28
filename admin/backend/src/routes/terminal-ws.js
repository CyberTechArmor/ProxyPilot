import { WebSocketServer } from 'ws';
import { spawnTerminalPty } from '../lib/pty.js';
import { verifyWsUpgrade } from '../middleware/wsAuth.js';
import {
  logAudit,
  AUDIT_TERMINAL_SESSION_START,
  AUDIT_TERMINAL_SESSION_END,
} from '../db.js';

const TERMINAL_MAX_SESSIONS = parseInt(process.env.TERMINAL_MAX_SESSIONS || '3', 10);
const TERMINAL_IDLE_TIMEOUT_MS = parseInt(process.env.TERMINAL_IDLE_TIMEOUT_MS || String(15 * 60_000), 10);
const TERMINAL_OUTPUT_BACKPRESSURE_BYTES = parseInt(process.env.TERMINAL_OUTPUT_BACKPRESSURE_BYTES || '1000000', 10);

const TERMINAL_PATH_RE = /^\/api\/terminal\/(lxc\/[a-zA-Z0-9][a-zA-Z0-9-]*|host)\/?$/;

// Refuse upgrades that match the terminal prefix but not the strict
// path shape so a typo can't leak through to the WebSocket server.
const TERMINAL_PREFIX = '/api/terminal/';

// Per-user session counter. Map<userId, count>. Reset to 0 means
// remove the entry to prevent unbounded growth from one-off users.
const sessionsByUser = new Map();

function incSession(userId) {
  const n = (sessionsByUser.get(userId) || 0) + 1;
  sessionsByUser.set(userId, n);
  return n;
}

function decSession(userId) {
  const n = (sessionsByUser.get(userId) || 1) - 1;
  if (n <= 0) sessionsByUser.delete(userId);
  else sessionsByUser.set(userId, n);
}

function rejectUpgrade(socket, statusCode, body) {
  const message = body || (statusCode === 401 ? 'Unauthorized' : 'Bad request');
  socket.write(
    `HTTP/1.1 ${statusCode} ${statusCode === 401 ? 'Unauthorized' : 'Bad Request'}\r\n` +
    `Content-Type: text/plain\r\n` +
    `Content-Length: ${Buffer.byteLength(message)}\r\n` +
    `Connection: close\r\n\r\n` +
    message
  );
  socket.destroy();
}

function parseTarget(pathname) {
  const m = TERMINAL_PATH_RE.exec(pathname);
  if (!m) return null;
  const tail = m[1];
  if (tail === 'host') return { kind: 'host', target: null };
  // `lxc/<name>`
  const name = tail.slice('lxc/'.length);
  return { kind: 'lxc', target: name };
}

export function attachTerminalServer(httpServer) {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    let pathname;
    try {
      // req.url is path + query; use a dummy origin to parse.
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      return; // not ours; let other listeners (none today) decide
    }

    if (!pathname.startsWith(TERMINAL_PREFIX)) {
      // Not a terminal upgrade — leave it alone. (No other ws path
      // is registered today; this branch is defensive.)
      return;
    }

    const parsed = parseTarget(pathname);
    if (!parsed) {
      return rejectUpgrade(socket, 400, 'Invalid terminal path');
    }

    let user;
    try {
      ({ user } = verifyWsUpgrade(req));
    } catch (e) {
      return rejectUpgrade(socket, e.status || 401, e.message || 'Unauthorized');
    }

    if (parsed.kind === 'host' && user.role !== 'admin') {
      return rejectUpgrade(socket, 403, 'Host shell requires admin role');
    }

    const existing = sessionsByUser.get(user.id) || 0;
    if (existing >= TERMINAL_MAX_SESSIONS) {
      return rejectUpgrade(
        socket,
        429,
        `Too many terminal sessions (max ${TERMINAL_MAX_SESSIONS} per user)`
      );
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      handleSession(ws, req, user, parsed);
    });
  });

  return wss;
}

function handleSession(ws, req, user, parsed) {
  let term;
  try {
    term = spawnTerminalPty({ kind: parsed.kind, target: parsed.target });
  } catch (e) {
    try {
      ws.send(JSON.stringify({ type: 'error', message: e.message }));
    } catch { /* socket already closed */ }
    ws.close(1011, 'spawn failed');
    return;
  }

  incSession(user.id);

  const startedAt = Date.now();
  const sourceIp = req.socket?.remoteAddress || null;
  const targetId = parsed.kind === 'lxc' ? parsed.target : 'host';
  let bytesIn = 0;   // bytes the client sent us (stdin → pty)
  let bytesOut = 0;  // bytes the pty produced (stdout → client)
  let exitReason = 'closed';
  let closed = false;
  let paused = false;

  logAudit(
    user.id,
    AUDIT_TERMINAL_SESSION_START,
    'terminal',
    targetId,
    { target_kind: parsed.kind, target_id: targetId, source_ip: sourceIp },
    sourceIp
  );

  // ---- idle timer ----
  let idleTimer = null;
  function bumpIdle() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (closed) return;
      exitReason = 'idle';
      try { ws.send(JSON.stringify({ type: 'closed', reason: 'idle' })); } catch { /* ignore */ }
      try { term.kill(); } catch { /* ignore */ }
      try { ws.close(1000, 'idle'); } catch { /* ignore */ }
    }, TERMINAL_IDLE_TIMEOUT_MS);
  }
  bumpIdle();

  // ---- pty -> ws (with backpressure) ----
  term.onData((data) => {
    bytesOut += Buffer.byteLength(data);
    bumpIdle();
    if (ws.readyState !== ws.OPEN) return;
    ws.send(data, { binary: true }, () => {
      if (paused && ws.bufferedAmount < TERMINAL_OUTPUT_BACKPRESSURE_BYTES / 2) {
        paused = false;
        try { term.resume(); } catch { /* ignore */ }
      }
    });
    if (!paused && ws.bufferedAmount > TERMINAL_OUTPUT_BACKPRESSURE_BYTES) {
      paused = true;
      try { term.pause(); } catch { /* ignore */ }
    }
  });

  // ---- ws -> pty ----
  ws.on('message', (raw, isBinary) => {
    bumpIdle();
    if (!isBinary) {
      // Try JSON envelope first; fall through to raw-string input
      // for legacy clients.
      const asString = raw.toString('utf8');
      if (asString.startsWith('{')) {
        let env;
        try { env = JSON.parse(asString); } catch { env = null; }
        if (env && typeof env === 'object') {
          if (env.type === 'input' && typeof env.data === 'string') {
            bytesIn += Buffer.byteLength(env.data);
            try { term.write(env.data); } catch { /* ignore */ }
            return;
          }
          if (env.type === 'resize' && Number.isFinite(env.cols) && Number.isFinite(env.rows)) {
            try { term.resize(Math.max(1, env.cols | 0), Math.max(1, env.rows | 0)); } catch { /* ignore */ }
            return;
          }
          // Unknown envelope type — ignore quietly. The MVP does not
          // expose anything else; falling through and treating it as
          // raw input would feed JSON syntax to the shell.
          return;
        }
      }
      bytesIn += Buffer.byteLength(asString);
      try { term.write(asString); } catch { /* ignore */ }
      return;
    }
    // Binary frame: write through unchanged.
    bytesIn += raw.length;
    try { term.write(raw); } catch { /* ignore */ }
  });

  // ---- pty exit ----
  term.onExit(({ exitCode, signal }) => {
    if (closed) return;
    if (!exitReason || exitReason === 'closed') {
      exitReason = signal ? `signal:${signal}` : `exit:${exitCode ?? 0}`;
    }
    try { ws.send(JSON.stringify({ type: 'closed', reason: exitReason })); } catch { /* ignore */ }
    try { ws.close(1000, 'pty exit'); } catch { /* ignore */ }
  });

  // ---- ws close → cleanup ----
  ws.on('close', () => {
    if (closed) return;
    closed = true;
    if (idleTimer) clearTimeout(idleTimer);
    try { term.kill(); } catch { /* ignore */ }
    decSession(user.id);
    logAudit(
      user.id,
      AUDIT_TERMINAL_SESSION_END,
      'terminal',
      targetId,
      {
        target_kind: parsed.kind,
        target_id: targetId,
        duration_ms: Date.now() - startedAt,
        bytes_in: bytesIn,
        bytes_out: bytesOut,
        exit_reason: exitReason,
      },
      sourceIp
    );
  });

  ws.on('error', () => {
    // Surface in logs; the close handler will run after this and do
    // the actual cleanup. Swallow here to avoid an unhandled-error
    // crash on socket teardown.
  });
}
