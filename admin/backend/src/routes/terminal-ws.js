import { WebSocketServer } from 'ws';
import { verifyWsUpgrade } from '../middleware/wsAuth.js';
import { spawnTerminalPty } from '../lib/pty.js';
import {
  logAudit,
  AUDIT_TERMINAL_SESSION_START,
  AUDIT_TERMINAL_SESSION_END,
} from '../db.js';

const MAX_SESSIONS_PER_USER = parseInt(process.env.TERMINAL_MAX_SESSIONS || '3', 10);
const IDLE_TIMEOUT_MS = parseInt(process.env.TERMINAL_IDLE_TIMEOUT_MS || `${15 * 60_000}`, 10);
const BACKPRESSURE_BYTES = parseInt(process.env.TERMINAL_OUTPUT_BACKPRESSURE_BYTES || '1000000', 10);

// userId -> count of live sessions. Decremented on close. Used to enforce
// MAX_SESSIONS_PER_USER without consulting the database — sessions are
// strictly in-memory state.
const sessionsPerUser = new Map();

function incSessions(userId) {
  sessionsPerUser.set(userId, (sessionsPerUser.get(userId) || 0) + 1);
}
function decSessions(userId) {
  const n = (sessionsPerUser.get(userId) || 1) - 1;
  if (n <= 0) sessionsPerUser.delete(userId);
  else sessionsPerUser.set(userId, n);
}
function currentSessions(userId) {
  return sessionsPerUser.get(userId) || 0;
}

// Reject the upgrade with an HTTP-status-like error. The browser surfaces
// these as a `WebSocket close` with the chosen code; we also write the
// status line directly so curl/wscat see something meaningful.
function rejectUpgrade(socket, statusCode, reason) {
  try {
    socket.write(
      `HTTP/1.1 ${statusCode} ${reason}\r\n` +
      `Content-Length: 0\r\n` +
      `Connection: close\r\n\r\n`
    );
  } catch { /* socket may already be dead */ }
  try { socket.destroy(); } catch { /* ignore */ }
}

// Parse `/api/terminal/lxc/<name>` or `/api/terminal/host` from the
// upgrade URL. Returns null on no-match.
function parseTarget(rawUrl) {
  // Strip query string + trailing slashes.
  const url = (rawUrl || '').split('?')[0].replace(/\/+$/, '');
  if (url === '/api/terminal/host') return { kind: 'host', target: null };
  const m = url.match(/^\/api\/terminal\/lxc\/([a-zA-Z0-9_-]{1,64})$/);
  if (m) return { kind: 'lxc', target: m[1] };
  return null;
}

export function attachTerminalServer(httpServer) {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    // Only intercept paths under /api/terminal/. Other upgrade requests
    // (none today, but future code paths) flow through unchanged.
    const url = (req.url || '').split('?')[0];
    if (!url.startsWith('/api/terminal/')) return;

    let user;
    try {
      ({ user } = verifyWsUpgrade(req));
    } catch (e) {
      return rejectUpgrade(socket, e.statusCode || 401, e.message || 'Unauthorized');
    }

    const target = parseTarget(req.url);
    if (!target) {
      return rejectUpgrade(socket, 404, 'Unknown terminal target');
    }

    if (target.kind === 'host' && user.role !== 'admin') {
      return rejectUpgrade(socket, 403, 'Admin role required for host shell');
    }

    if (currentSessions(user.id) >= MAX_SESSIONS_PER_USER) {
      return rejectUpgrade(socket, 429, `Concurrent session cap (${MAX_SESSIONS_PER_USER}) reached`);
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      handleSession(ws, req, user, target);
    });
  });

  return wss;
}

function handleSession(ws, req, user, target) {
  const startedAt = Date.now();
  const remoteIp = req.socket?.remoteAddress || null;
  let bytesIn = 0;
  let bytesOut = 0;
  let lastActivity = Date.now();
  let paused = false;
  let closed = false;

  let term;
  try {
    term = spawnTerminalPty({ kind: target.kind, target: target.target });
  } catch (e) {
    try { ws.send(JSON.stringify({ type: 'closed', reason: 'spawn-failed', error: e.message })); } catch {}
    try { ws.close(1011, 'PTY spawn failed'); } catch {}
    return;
  }

  incSessions(user.id);

  logAudit(
    user.id,
    AUDIT_TERMINAL_SESSION_START,
    'terminal',
    `${target.kind}:${target.target || 'host'}`,
    { kind: target.kind, target: target.target, source_ip: remoteIp },
    remoteIp,
  );

  const idleTimer = setInterval(() => {
    if (closed) return;
    if (Date.now() - lastActivity >= IDLE_TIMEOUT_MS) {
      try { ws.send(JSON.stringify({ type: 'closed', reason: 'idle' })); } catch {}
      cleanup('idle');
    }
  }, Math.min(60_000, Math.max(5_000, Math.floor(IDLE_TIMEOUT_MS / 4))));

  const onPtyData = (data) => {
    lastActivity = Date.now();
    const buf = Buffer.from(data, 'utf8');
    bytesOut += buf.length;
    if (ws.readyState !== ws.OPEN) return;

    // Backpressure: if the WS buffer is over the high-water mark, pause
    // the PTY so a runaway process can't self-DoS the browser. Resume
    // once the buffer drains.
    if (!paused && ws.bufferedAmount > BACKPRESSURE_BYTES) {
      paused = true;
      try { term.pause(); } catch { /* node-pty pause is best-effort */ }
      const drainTimer = setInterval(() => {
        if (closed) { clearInterval(drainTimer); return; }
        if (ws.bufferedAmount < BACKPRESSURE_BYTES / 2) {
          paused = false;
          try { term.resume(); } catch {}
          clearInterval(drainTimer);
        }
      }, 100);
    }

    try { ws.send(buf); } catch { /* socket closing */ }
  };

  const ptyDataSub = term.onData(onPtyData);
  const ptyExitSub = term.onExit(({ exitCode, signal }) => {
    cleanup(`pty-exit code=${exitCode ?? '?'} signal=${signal ?? '?'}`);
  });

  ws.on('message', (raw, isBinary) => {
    lastActivity = Date.now();
    bytesIn += raw.length;

    // JSON envelope: {type:'input',data} | {type:'resize',cols,rows}.
    // Plain string/binary frames are also accepted as raw stdin so the
    // client doesn't have to envelope every keystroke if it doesn't want
    // to.
    if (!isBinary) {
      const text = raw.toString('utf8');
      if (text.length > 0 && text.charCodeAt(0) === 0x7b /* { */) {
        try {
          const msg = JSON.parse(text);
          if (msg && msg.type === 'input' && typeof msg.data === 'string') {
            term.write(msg.data);
            return;
          }
          if (msg && msg.type === 'resize') {
            const cols = Math.max(1, Math.min(500, parseInt(msg.cols, 10) || 80));
            const rows = Math.max(1, Math.min(500, parseInt(msg.rows, 10) || 24));
            try { term.resize(cols, rows); } catch { /* ignore */ }
            return;
          }
        } catch {
          // Not JSON — fall through to write as raw input.
        }
      }
      term.write(text);
      return;
    }

    // Binary frame — write as raw bytes.
    term.write(raw);
  });

  ws.on('close', () => cleanup('client-close'));
  ws.on('error', () => cleanup('ws-error'));

  function cleanup(reason) {
    if (closed) return;
    closed = true;
    clearInterval(idleTimer);
    try { ptyDataSub?.dispose?.(); } catch {}
    try { ptyExitSub?.dispose?.(); } catch {}
    try { term.kill(); } catch { /* already dead */ }
    try { ws.close(1000, reason.slice(0, 64)); } catch {}
    decSessions(user.id);

    logAudit(
      user.id,
      AUDIT_TERMINAL_SESSION_END,
      'terminal',
      `${target.kind}:${target.target || 'host'}`,
      {
        kind: target.kind,
        target: target.target,
        duration_ms: Date.now() - startedAt,
        bytes_in: bytesIn,
        bytes_out: bytesOut,
        exit_reason: reason,
      },
      remoteIp,
    );
  }
}
