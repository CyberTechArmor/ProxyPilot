import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLiveClient, liveUrl } from '../../../frontend/src/components/operational-projects/live-client.js';
import { OP, encodeButton, encodeKey, encodeMove, encodeScroll, keysymFor, screenPoint, scrollSteps }
  from '../../../frontend/src/components/operational-projects/live-input.js';

// A7 decision 1c: the dashboard's own Neko client. The input bytes follow
// Neko's data-channel format at the pinned commit; the signalling client only
// ever asks for relay candidates, answers Neko's offers, and sends input only
// over the data channel.

const bytes = buffer => [...new Uint8Array(buffer)];

test('input encoding: Neko\'s header (op, big-endian length) and payloads', () => {
  assert.deepEqual(bytes(encodeMove(0x0102, 0x0304)), [OP.MOVE, 0, 4, 1, 2, 3, 4]);
  assert.deepEqual(bytes(encodeMove(-5, 70000)), [OP.MOVE, 0, 4, 0, 0, 0xff, 0xff]);
  assert.deepEqual(bytes(encodeScroll(-1, 3, true)), [OP.SCROLL, 0, 5, 0xff, 0xff, 0, 3, 1]);
  assert.deepEqual(bytes(encodeKey(true, 0xff0d)), [OP.KEY_DOWN, 0, 4, 0, 0, 0xff, 0x0d]);
  assert.deepEqual(bytes(encodeKey(false, 0x01000000 + 0x20ac)), [OP.KEY_UP, 0, 4, 1, 0, 0x20, 0xac]);
  assert.deepEqual(bytes(encodeButton(true, 0)), [OP.BTN_DOWN, 0, 4, 0, 0, 0, 1]);
  assert.deepEqual(bytes(encodeButton(false, 2)), [OP.BTN_UP, 0, 4, 0, 0, 0, 3]);
  assert.deepEqual(bytes(encodeButton(true, 1)), [OP.BTN_DOWN, 0, 4, 0, 0, 0, 2]);
});

test('input mapping: letterboxed video points, wheel steps and keysyms', () => {
  const rect = { left: 10, top: 20, width: 1000, height: 500 };
  const screen = { width: 1280, height: 800 };
  // Shown at 0.625: 800x500, centred with 100 px bands left and right.
  assert.deepEqual(screenPoint(110, 20, rect, screen), { x: 0, y: 0 });
  assert.deepEqual(screenPoint(510, 270, rect, screen), { x: 640, y: 400 });
  assert.equal(screenPoint(60, 100, rect, screen), null);
  assert.equal(screenPoint(950, 100, rect, screen), null);
  assert.equal(screenPoint(100, 100, { width: 0, height: 0 }, screen), null);
  assert.deepEqual(scrollSteps({ deltaMode: 0, deltaX: 0, deltaY: 120 }), { dx: 0, dy: 3 });
  assert.deepEqual(scrollSteps({ deltaMode: 1, deltaX: -2, deltaY: 0 }), { dx: -2, dy: 0 });
  assert.deepEqual(scrollSteps({ deltaMode: 0, deltaX: 0, deltaY: 1 }), { dx: 0, dy: 1 });
  assert.deepEqual(scrollSteps({ deltaMode: 2, deltaX: 0, deltaY: 5 }), { dx: 0, dy: 10 });
  const cases = [[{ key: 'a' }, 0x61], [{ key: 'A' }, 0x41], [{ key: ' ' }, 0x20], [{ key: 'Enter' }, 0xff0d],
    [{ key: 'Backspace' }, 0xff08], [{ key: 'Tab' }, 0xff09], [{ key: 'ArrowLeft' }, 0xff51], [{ key: 'F5' }, 0xffc2],
    [{ key: 'Shift', location: 1 }, 0xffe1], [{ key: 'Shift', location: 2 }, 0xffe2], [{ key: 'Control' }, 0xffe3],
    [{ key: 'é' }, 0xe9], [{ key: '€' }, 0x010020ac], [{ key: 'Unidentified' }, null], [{ key: 'Dead' }, null],
    [{ key: 'Process' }, null], [{ key: 'ab' }, null], [{ key: '\u0007' }, null], [{}, null]];
  for (const [event, keysym] of cases) assert.equal(keysymFor(event), keysym, JSON.stringify(event));
});

class FakeSocket {
  static last = null;
  constructor(url) { this.url = url; this.sent = []; this.readyState = 1; FakeSocket.last = this; }
  send(text) { this.sent.push(JSON.parse(text)); }
  close() { this.readyState = 3; this.closed = true; }
  deliver(value) { this.onmessage?.({ data: JSON.stringify(value) }); }
}
class FakePeer {
  static last = null;
  constructor(config) { this.config = config; this.candidates = []; this.connectionState = 'new'; FakePeer.last = this; }
  async setRemoteDescription(d) { this.remote = d; }
  async createAnswer() { return { type: 'answer', sdp: `answer-to:${this.remote.sdp}` }; }
  async setLocalDescription(d) { this.local = d; }
  async addIceCandidate(c) { if (!this.remote) throw new Error('no remote description'); this.candidates.push(c); }
  close() { this.closed = true; }
  connect() { this.connectionState = 'connected'; this.onconnectionstatechange?.(); }
}
const flush = () => new Promise(done => setTimeout(done, 5));
const neko = message => ({ type: 'neko', message });
const ICE = [{ urls: ['turns:turn.example.com:5349?transport=tcp'], username: '1790000000:0123456789abcdef', credential: 'x' }];

test('live client: relay-only peer, answers Neko\'s offer, knows who holds control, input only on the data channel', async () => {
  const states = [], controls = [], screens = [], streams = [];
  const client = createLiveClient({ url: 'wss://pp.example/api/x/live', WebSocketImpl: FakeSocket, PeerConnection: FakePeer,
    onState: (s, d) => states.push([s, d]), onControl: c => controls.push(c), onScreen: s => screens.push(s),
    onStream: (s, t) => streams.push([s, t]) });
  client.start();
  const ws = FakeSocket.last;
  assert.equal(ws.url, 'wss://pp.example/api/x/live');
  assert.deepEqual(states, [['connecting', {}]]);
  ws.deliver({ type: 'ready', viewer: '0123456789abcdef', ice_servers: ICE, ice_transport_policy: 'relay', ttl_seconds: 3600 });
  const pc = FakePeer.last;
  assert.deepEqual(pc.config, { iceServers: ICE, iceTransportPolicy: 'relay' });
  assert.deepEqual(ws.sent.at(-1), neko({ event: 'signal/request', payload: { video: {}, audio: { disabled: true } } }));
  ws.deliver(neko({ event: 'system/init', payload: { session_id: 'me', control_host: { has_host: false },
    screen_size: { width: 1280, height: 720, rate: 25 } } }));
  // Neko trickles its candidate BEFORE the offer (seen with the real Neko): it
  // must wait for the remote description, not be dropped.
  ws.deliver(neko({ event: 'signal/candidate', payload: { candidate: 'candidate:1 1 udp 1 10.185.17.179 18091 typ host', sdpMid: '0' } }));
  await flush();
  assert.equal(pc.candidates.length, 0);
  ws.deliver(neko({ event: 'signal/provide', payload: { sdp: 'offer-1' } }));
  await flush();
  assert.deepEqual(pc.remote, { type: 'offer', sdp: 'offer-1' });
  assert.deepEqual(ws.sent.find(m => m.message?.event === 'signal/answer'), neko({ event: 'signal/answer', payload: { sdp: 'answer-to:offer-1' } }));
  assert.equal(pc.candidates.length, 1);
  assert.deepEqual(screens, [{ width: 1280, height: 720, rate: 25 }]);
  pc.onicecandidate({ candidate: { toJSON: () => ({ candidate: 'candidate:2 1 udp 2 192.0.2.9 49160 typ relay', sdpMid: '0' }) } });
  assert.equal(ws.sent.at(-1).message.event, 'signal/candidate');
  pc.ontrack({ track: { kind: 'video' }, streams: ['stream'] });
  pc.ontrack({ track: { kind: 'audio' }, streams: ['audio'] });
  assert.deepEqual(streams, [['stream', { kind: 'video' }]]);
  pc.connect();
  assert.deepEqual(states.at(-1), ['live', { viewer: '0123456789abcdef' }]);
  // Nothing to send input on until Neko's data channel is open.
  assert.equal(client.input(encodeMove(1, 1)), false);
  const sent = [];
  pc.ondatachannel({ channel: { readyState: 'open', send: b => sent.push(b) } });
  assert.equal(client.input(encodeMove(1, 1)), true);
  assert.equal(sent.length, 1);
  assert.equal(ws.sent.some(m => JSON.stringify(m).includes('control/')), false);
  // Who holds control: someone else, then this view, then nobody.
  ws.deliver(neko({ event: 'control/host', payload: { has_host: true, host_id: 'other' } }));
  ws.deliver(neko({ event: 'control/host', payload: { has_host: true, host_id: 'me' } }));
  ws.deliver(neko({ event: 'control/release', payload: {} }));
  await flush();
  assert.deepEqual(controls, [{ hasHost: false, mine: false }, { hasHost: true, mine: false }, { hasHost: true, mine: true },
    { hasHost: false, mine: false }]);
  // A renegotiation is answered the same way.
  ws.deliver(neko({ event: 'signal/restart', payload: { sdp: 'offer-2' } }));
  await flush();
  assert.equal(ws.sent.filter(m => m.message?.event === 'signal/answer').at(-1).message.payload.sdp, 'answer-to:offer-2');
  // The attempt ends: closed, and control is gone.
  ws.deliver({ type: 'closed', reason: 'attempt_ended' });
  assert.deepEqual(states.at(-1), ['closed', { reason: 'attempt_ended' }]);
  assert.deepEqual(controls.at(-1), { hasHost: false, mine: false, ended: true });
  assert.equal(pc.closed && ws.closed, true);
  assert.equal(client.input(encodeMove(1, 1)), false);
});

test('live client: unavailable, a connect timeout and a failed peer fall back', async () => {
  const run = (options = {}) => {
    const states = [];
    const client = createLiveClient({ url: 'ws://x/live', WebSocketImpl: FakeSocket, PeerConnection: FakePeer,
      onState: (s, d) => states.push([s, d]), ...options });
    client.start();
    return { states, ws: FakeSocket.last, client };
  };
  const a = run();
  a.ws.deliver({ type: 'unavailable', code: 'LIVE_UNAVAILABLE', message: 'The live view is not available.' });
  assert.deepEqual(a.states.at(-1), ['unavailable', { code: 'LIVE_UNAVAILABLE', message: 'The live view is not available.' }]);
  const b = run({ connectMs: 20 });
  await new Promise(done => setTimeout(done, 40));
  assert.deepEqual(b.states.at(-1), ['failed', { reason: 'timeout' }]);
  assert.deepEqual(b.ws.sent.at(-1), { type: 'close' });
  const c = run();
  c.ws.deliver({ type: 'ready', viewer: 'v', ice_servers: ICE });
  FakePeer.last.connectionState = 'failed';
  FakePeer.last.onconnectionstatechange();
  assert.deepEqual(c.states.at(-1), ['failed', { reason: 'webrtc_failed' }]);
  // Closing twice reports once.
  const d = run();
  d.client.close(); d.client.close();
  assert.equal(d.states.filter(s => s[0] === 'closed').length, 1);
  assert.equal(liveUrl('/abc', 'run-1', { protocol: 'https:', host: 'pp.example' }),
    'wss://pp.example/api/operational-projects/abc/agent-runs/run-1/live');
  assert.equal(liveUrl('/abc', 'run-1', { protocol: 'http:', host: '127.0.0.1:5173' }),
    'ws://127.0.0.1:5173/api/operational-projects/abc/agent-runs/run-1/live');
});
