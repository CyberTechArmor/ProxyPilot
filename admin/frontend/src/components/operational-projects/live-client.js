// A7 live view: the dashboard's own Neko client (user decision 1c), without
// React so admin/backend's node:test drives it with fakes
// (agent-live-client.test.js). It speaks to the backend's live WebSocket
// (routes/agent-live-ws.js), which relays Neko's signalling only; the video
// arrives over WebRTC through the TURN relay (relay candidates only: the
// browser never talks to the VM directly), and the input goes back over
// Neko's data channel, applied only while this view holds control.
//
// States: connecting → live (video playing) | unavailable | failed | closed.
export const LIVE_STATES = Object.freeze(['connecting', 'live', 'unavailable', 'failed', 'closed']);

export function liveUrl(base, runId, location = globalThis.location) {
  const scheme = location?.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${location?.host}/api/operational-projects${base}/agent-runs/${runId}/live`;
}

export function createLiveClient({ url, WebSocketImpl = globalThis.WebSocket, PeerConnection = globalThis.RTCPeerConnection,
  onState = () => {}, onStream = () => {}, onControl = () => {}, onScreen = () => {}, connectMs = 20_000 }) {
  let ws = null, pc = null, channel = null, session = null, viewer = null, done = false, timer = null;
  // Neko may trickle a candidate before its offer arrives; those wait for it.
  let early = [], haveRemote = false;
  let chain = Promise.resolve();
  const state = (name, detail = {}) => { if (!done || name === 'closed' || name === 'unavailable' || name === 'failed') onState(name, detail); };
  const send = (event, payload) => {
    if (!ws || ws.readyState !== 1) return false;
    ws.send(JSON.stringify({ type: 'neko', message: payload === undefined ? { event } : { event, payload } }));
    return true;
  };
  const controlOf = host => ({ hasHost: !!host?.has_host, mine: !!host?.has_host && !!session && host?.host_id === session });

  async function answer(sdp) {
    if (!pc || typeof sdp !== 'string') return;
    await pc.setRemoteDescription({ type: 'offer', sdp });
    haveRemote = true;
    for (const candidate of early.splice(0)) await pc.addIceCandidate(candidate).catch(() => {});
    const local = await pc.createAnswer();
    await pc.setLocalDescription(local);
    send('signal/answer', { sdp: local.sdp });
  }
  async function neko(message) {
    const payload = message?.payload ?? {};
    switch (message?.event) {
      case 'system/init':
        session = typeof payload.session_id === 'string' ? payload.session_id : null;
        if (payload.screen_size) onScreen(payload.screen_size);
        onControl(controlOf(payload.control_host));
        return;
      case 'signal/provide': case 'signal/offer': case 'signal/restart':
        return answer(payload.sdp);
      case 'signal/candidate':
        if (!pc || !payload.candidate) return;
        if (!haveRemote) { early.push(payload); return; }
        await pc.addIceCandidate(payload).catch(() => {});
        return;
      case 'control/host': case 'control/release':
        onControl(controlOf(message.event === 'control/release' ? { has_host: false } : payload));
        return;
      case 'screen/updated':
        if (payload.width && payload.height) onScreen(payload);
        return;
      case 'system/disconnect':
        finish('closed', { reason: 'disconnected' });
        return;
      default:
    }
  }
  function ready(data) {
    viewer = data.viewer;
    pc = new PeerConnection({ iceServers: data.ice_servers, iceTransportPolicy: 'relay' });
    pc.onicecandidate = (event) => {
      if (!event.candidate) return;
      send('signal/candidate', typeof event.candidate.toJSON === 'function' ? event.candidate.toJSON() : event.candidate);
    };
    pc.ontrack = (event) => { if (event.track?.kind === 'video') onStream(event.streams?.[0] ?? null, event.track); };
    pc.ondatachannel = (event) => { channel = event.channel; channel.binaryType = 'arraybuffer'; };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') { clearTimeout(timer); state('live', { viewer }); }
      else if (pc.connectionState === 'failed') finish('failed', { reason: 'webrtc_failed' });
    };
    send('signal/request', { video: {}, audio: { disabled: true } });
  }
  function finish(name, detail = {}) {
    if (done) return;
    done = true;
    clearTimeout(timer);
    try { if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'close' })); } catch { /* closing */ }
    try { ws?.close(); } catch { /* closing */ }
    try { pc?.close(); } catch { /* closing */ }
    channel = null;
    onControl({ hasHost: false, mine: false, ended: true });
    onState(name, detail);
  }
  return {
    start() {
      state('connecting');
      try { ws = new WebSocketImpl(url); }
      catch { finish('failed', { reason: 'websocket' }); return; }
      // Without a connected peer in time (TURN blocked, the relay down), the
      // page falls back to the still frames.
      timer = setTimeout(() => finish('failed', { reason: 'timeout' }), connectMs);
      ws.onmessage = (event) => {
        let data;
        try { data = JSON.parse(event.data); } catch { return; }
        if (data?.type === 'ready') ready(data);
        else if (data?.type === 'neko') chain = chain.then(() => neko(data.message)).catch(() => {});
        else if (data?.type === 'unavailable') finish('unavailable', { code: data.code ?? null, message: data.message ?? null });
        else if (data?.type === 'closed') finish('closed', { reason: data.reason ?? 'closed' });
      };
      ws.onclose = () => finish('closed', { reason: 'closed' });
      ws.onerror = () => {};
    },
    // Binary input for Neko's data channel (live-input.js); false if not open.
    input(buffer) {
      if (!channel || channel.readyState !== 'open') return false;
      channel.send(buffer);
      return true;
    },
    close() { finish('closed', { reason: 'viewer_closed' }); },
    get viewer() { return viewer; },
  };
}
