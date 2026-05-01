import { WebSocketServer } from 'ws';
import { exec } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import { verifyWsUpgrade } from '../middleware/wsAuth.js';
import { spawnTerminalPty } from '../lib/pty.js';
import {
  logAudit,
  AUDIT_TERMINAL_SESSION_START,
  AUDIT_TERMINAL_SESSION_END,
} from '../db.js';

const execAsync = promisify(exec);
const isInDocker = existsSync('/.dockerenv') || process.env.DOCKER_CONTAINER === 'true';

// Run `incus info pp-<name> --format json` with a hard 3s budget and
// return true iff the instance reports at least one routable IPv4 on a
// non-loopback interface. That's the closest "guest agent is talking"
// signal Incus exposes — agentless VMs report state but no `network`
// payload because the agent is the source of that data.
//
// Returns false on any error (timeout, parse failure, missing
// instance) so the caller falls back to the safer `incus console`
// path. We never throw out of here.
async function vmHasGuestAgent(name) {
  const cmd = isInDocker
    ? `nsenter -t 1 -m -u -n -i incus info ${name} --format json`
    : `incus info ${name} --format json`;
  try {
    const { stdout } = await execAsync(cmd, { timeout: 3000, encoding: 'utf8' });
    const info = JSON.parse(stdout || '{}');
    const networks = info?.state?.network || info?.network || {};
    for (const [iface, n] of Object.entries(networks)) {
      if (iface === 'lo') continue;
      const addrs = n?.addresses || [];
      for (const a of addrs) {
        if (a?.family === 'inet' && a?.scope !== 'link' && a?.scope !== 'local' && a?.address) {
          return true;
        }
      }
    }
    return false;
  } catch {
    return false;
  }
}

const MAX_SESSIONS_PER_USER = parseInt(process.env.TERMINAL_MAX_SESSIONS || '3', 10);
const IDLE_TIMEOUT_MS = parseInt(process.env.TERMINAL_IDLE_TIMEOUT_MS || `${15 * 60_000}`, 10);
const BACKPRESSURE_BYTES = parseInt(process.env.TERMINAL_OUTPUT_BACKPRESSURE_BYTES || '1000000', 10);
// WebSocket ping interval — kept under typical reverse-proxy idle
// timeouts (Caddy/nginx default ~60s, browsers ~120s) so quiet periods
// during long-running scripts (apt-get download, docker pull) don't get
// the connection torn down by an intermediary that thinks it's dead.
const PING_INTERVAL_MS = parseInt(process.env.TERMINAL_PING_INTERVAL_MS || '25000', 10);
// If we don't see a pong this long after a ping, treat the connection
// as half-open and terminate so the client can reconnect cleanly.
const PONG_TIMEOUT_MS = parseInt(process.env.TERMINAL_PONG_TIMEOUT_MS || '20000', 10);

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
// upgrade URL plus the optional `?cwd=<absolute-path>` and `?type=vm`
// query. Returns null on no-match for the path. The cwd is sanity-checked
// so bogus values don't make it to pty.spawn. `type` is a hint from the
// frontend — when set to 'vm' the WS handler runs an agent probe and
// chooses between `incus exec` (agent up) and `incus console` (agentless).
function parseTarget(rawUrl) {
  const [pathPart, queryPart = ''] = (rawUrl || '').split('?');
  const url = pathPart.replace(/\/+$/, '');

  let cwd = null;
  let typeHint = null;
  try {
    const params = new URLSearchParams(queryPart);
    const raw = params.get('cwd');
    // Only accept absolute paths up to a sane length, rule out any
    // shell-significant characters that have no business in a directory
    // name. Anything else → ignore and let bash start in HOME.
    if (raw && raw.startsWith('/') && raw.length <= 4096 && !/[\0\n\r]/.test(raw)) {
      cwd = raw;
    }
    const t = params.get('type');
    if (t === 'vm' || t === 'virtual-machine') typeHint = 'vm';
  } catch { /* malformed query → no cwd / typeHint */ }

  if (url === '/api/terminal/host') return { kind: 'host', target: null, cwd, typeHint: null };
  const m = url.match(/^\/api\/terminal\/lxc\/([a-zA-Z0-9_-]{1,64})$/);
  if (m) return { kind: 'lxc', target: m[1], cwd, typeHint };
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
      handleSession(ws, req, user, target).catch((e) => {
        try { ws.send(JSON.stringify({ type: 'closed', reason: 'spawn-failed', error: e?.message })); } catch {}
        try { ws.close(1011, 'PTY spawn failed'); } catch {}
      });
    });
  });

  return wss;
}

async function handleSession(ws, req, user, target) {
  const startedAt = Date.now();
  const remoteIp = req.socket?.remoteAddress || null;
  let bytesIn = 0;
  let bytesOut = 0;
  let lastActivity = Date.now();
  let paused = false;
  let closed = false;

  // VM-aware mode selection. The frontend signals VM-ness via the
  // `?type=vm` query param (see Step 7); we then decide `exec` vs
  // `console` by probing the guest agent. The probe is bounded to
  // 3s so a long timeout never wedges session start. Containers and
  // host shells skip this path entirely.
  let mode = 'exec';
  let banner = null;
  if (target.kind === 'lxc' && target.typeHint === 'vm') {
    const incusName = `pp-${target.target}`;
    const agentUp = await vmHasGuestAgent(incusName);
    if (!agentUp) {
      mode = 'console';
      banner = '\r\n\x1b[33m[VM console — agent shortcuts disabled]\x1b[0m\r\n';
    }
  }

  let term;
  try {
    term = spawnTerminalPty({
      kind: target.kind,
      target: target.target,
      mode,
      cwd: target.cwd || undefined,
    });
  } catch (e) {
    try { ws.send(JSON.stringify({ type: 'closed', reason: 'spawn-failed', error: e.message })); } catch {}
    try { ws.close(1011, 'PTY spawn failed'); } catch {}
    return;
  }

  if (banner) {
    try { ws.send(Buffer.from(banner, 'utf8')); } catch { /* socket may be gone */ }
  }

  incSessions(user.id);

  logAudit(
    user.id,
    AUDIT_TERMINAL_SESSION_START,
    'terminal',
    `${target.kind}:${target.target || 'host'}`,
    { kind: target.kind, target: target.target, cwd: target.cwd || null, source_ip: remoteIp },
    remoteIp,
  );

  const idleTimer = setInterval(() => {
    if (closed) return;
    if (Date.now() - lastActivity >= IDLE_TIMEOUT_MS) {
      try { ws.send(JSON.stringify({ type: 'closed', reason: 'idle' })); } catch {}
      cleanup('idle');
    }
  }, Math.min(60_000, Math.max(5_000, Math.floor(IDLE_TIMEOUT_MS / 4))));

  // Heartbeat: send a WebSocket-protocol-level ping every PING_INTERVAL_MS.
  // Browsers respond automatically with pong frames at the protocol level
  // even when the tab is backgrounded, which keeps reverse proxies from
  // closing the upgraded connection during long quiet periods (apt-get
  // download bursts, docker pull, sleeping prompt) where there's no PTY
  // output to keep the wire warm. If a pong doesn't arrive within
  // PONG_TIMEOUT_MS, we declare the connection half-open and terminate
  // so the client surfaces "Disconnected" instead of hanging silently.
  let awaitingPong = false;
  let pongTimer = null;
  const onPong = () => {
    awaitingPong = false;
    if (pongTimer) { clearTimeout(pongTimer); pongTimer = null; }
  };
  ws.on('pong', onPong);
  const heartbeatTimer = setInterval(() => {
    if (closed) return;
    if (ws.readyState !== ws.OPEN) return;
    if (awaitingPong) {
      // Previous ping never came back — handled by pongTimer below; skip.
      return;
    }
    awaitingPong = true;
    try { ws.ping(); } catch {
      awaitingPong = false;
      return;
    }
    pongTimer = setTimeout(() => {
      if (closed) return;
      try { ws.terminate(); } catch {}
      cleanup('pong-timeout');
    }, PONG_TIMEOUT_MS);
  }, PING_INTERVAL_MS);

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
    clearInterval(heartbeatTimer);
    if (pongTimer) { clearTimeout(pongTimer); pongTimer = null; }
    try { ws.off('pong', onPong); } catch {}
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
