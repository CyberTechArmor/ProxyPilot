import { WebSocketServer } from 'ws';
import { verifyWsUpgrade } from '../middleware/wsAuth.js';
import { MAX_MESSAGE_BYTES, MAX_VIEWER_RATE } from '../lib/operational-live-relay.js';

// A7 live view of an agent run: one WebSocket per viewer at
//   /api/operational-projects/:id/agent-runs/:runId/live
// carrying Neko's WebRTC signalling between the dashboard's own client and the
// Neko instance inside the proof VM, through the supervisor's backend socket.
// The video and the takeover input never pass through here: they go over
// WebRTC through the TURN relay, with a short-lived TURN credential minted per
// viewer by the host supervisor. Nothing is stored or logged but the codes.
//
// Authentication is the dashboard session cookie (verifyWsUpgrade: exact
// Origin, live session), then the Operations toggles and run access, checked
// before the upgrade and again every few seconds while the view is open.
//
// Browser -> backend: {type:'neko', message:{event, payload}} (signalling only;
//   anything else is dropped by the relay filter).
// Backend -> browser: {type:'ready', viewer, ice_servers, ice_transport_policy,
//   ttl_seconds}, {type:'neko', message}, {type:'dropped'}, {type:'closed',
//   reason}, {type:'unavailable', code, message}.
const PATH = /^\/api\/operational-projects\/([0-9a-f-]{36})\/agent-runs\/([0-9a-f-]{36})\/live$/;
export const MAX_VIEWS_PER_USER = 3;

function rejectUpgrade(socket, status, reason) {
  try { socket.write(`HTTP/1.1 ${status} ${reason}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`); } catch { /* gone */ }
  try { socket.destroy(); } catch { /* gone */ }
}

// `enabled()` is the three Operations toggles (read per check); `actorOf(user)`
// is the Operations store's eligibility check; `agentRuns` the A6/A7 service.
export function attachAgentLiveServer(httpServer, { agentRuns, enabled = () => false, actorOf = user => user,
  verify = verifyWsUpgrade, recheckMs = 10_000, heartbeatMs = 20_000, pingMs = 25_000 } = {}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES + 1024 });
  const perUser = new Map();

  httpServer.on('upgrade', (req, socket, head) => {
    const match = (req.url || '').split('?')[0].match(PATH);
    if (!match) return;
    const [, projectId, runId] = match;
    let user, actor;
    try { ({ user } = verify(req)); }
    catch (error) { return rejectUpgrade(socket, error.statusCode || 401, 'Unauthorized'); }
    if (!agentRuns || enabled() !== true) return rejectUpgrade(socket, 404, 'Not Found');
    try {
      actor = actorOf(user);
      agentRuns.assertLive(actor, projectId, runId);
    } catch (error) {
      const status = [401, 403, 404, 409, 503].includes(error?.status) ? error.status : 403;
      return rejectUpgrade(socket, status, status === 409 ? 'Conflict' : status === 404 ? 'Not Found' : 'Forbidden');
    }
    if ((perUser.get(user.id) || 0) >= MAX_VIEWS_PER_USER) return rejectUpgrade(socket, 429, 'Too Many Requests');
    perUser.set(user.id, (perUser.get(user.id) || 0) + 1);
    wss.handleUpgrade(req, socket, head, ws => {
      viewSession({ ws, req, user, actor, projectId, runId }).catch(() => { try { ws.close(1011); } catch { /* gone */ } });
    });
    return undefined;
  });

  async function viewSession({ ws, req, user, actor, projectId, runId }) {
    let viewer = null, closed = false, alive = true;
    let window = Date.now(), count = 0;
    const timers = [];
    const send = value => { if (!closed && ws.readyState === ws.OPEN) ws.send(JSON.stringify(value)); };
    const finish = (code = 1000, reason = 'closed') => {
      if (closed) return;
      send({ type: 'closed', reason });
      closed = true;
      timers.forEach(clearInterval);
      if (viewer) agentRuns.closeLive(viewer, reason);
      const left = (perUser.get(user.id) || 1) - 1;
      if (left > 0) perUser.set(user.id, left); else perUser.delete(user.id);
      try { ws.close(code, reason.slice(0, 64)); } catch { /* gone */ }
    };
    ws.on('close', () => finish(1000, 'viewer_closed'));
    ws.on('error', () => finish(1011, 'closed'));
    ws.on('pong', () => { alive = true; });
    ws.on('message', (data, binary) => {
      if (closed || !viewer) return;
      if (binary) return finish(1003, 'invalid');
      const now = Date.now();
      if (now - window >= 1000) { window = now; count = 0; }
      if (++count > MAX_VIEWER_RATE) return finish(1008, 'rate_limited');
      let value;
      try { value = JSON.parse(String(data)); } catch { return finish(1003, 'invalid'); }
      if (value?.type === 'close') return finish(1000, 'viewer_closed');
      if (value?.type !== 'neko') return finish(1003, 'invalid');
      agentRuns.sendLive(viewer, actor.id, value.message);
      return undefined;
    });
    let opened;
    try {
      opened = await agentRuns.openLive(actor, projectId, runId, {
        sessionId: user.jti ?? null,
        onMessage: message => send(message === null ? { type: 'dropped' } : { type: 'neko', message }),
        onClose: reason => { viewer = null; finish(1000, reason); },
      });
    } catch (error) {
      send({ type: 'unavailable', code: error?.code ?? 'LIVE_UNAVAILABLE',
        message: typeof error?.message === 'string' ? error.message.slice(0, 300) : null });
      return finish(1000, 'unavailable');
    }
    if (closed) { agentRuns.closeLive(opened.viewer, 'viewer_closed'); return undefined; }
    viewer = opened.viewer;
    send({ type: 'ready', viewer, ice_servers: opened.ice_servers, ice_transport_policy: 'relay',
      ttl_seconds: opened.ttl_seconds });
    // Neko expects a client heartbeat; the backend sends it, not the browser.
    timers.push(setInterval(() => { if (viewer) agentRuns.sendLive(viewer, actor.id, { event: 'client/heartbeat' }); },
      heartbeatMs));
    // Session, toggles and run access, again, while the view is open.
    timers.push(setInterval(() => {
      try {
        verify(req);
        if (enabled() !== true) throw new Error('off');
        agentRuns.assertLive(actorOf(user), projectId, runId);
      } catch { finish(1008, 'access_ended'); }
    }, recheckMs));
    timers.push(setInterval(() => {
      if (!alive) return finish(1001, 'viewer_lost');
      alive = false;
      try { ws.ping(); } catch { /* close follows */ }
      return undefined;
    }, pingMs));
    timers.forEach(t => t.unref?.());
    return undefined;
  }

  return wss;
}
