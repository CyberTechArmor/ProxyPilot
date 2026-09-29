// A7 live view, the dashboard's own client end to end in real Chromium. Driven
// by test_a7_live_e2e.py, which starts the real pieces (the runner's
// LiveDesktop with Xvfb, the patched Neko and kiosk Chromium; coturn with the
// installer's rendered configuration; a bridge speaking the supervisor's live
// protocol) and passes the bridge socket and the relay's address.
//
// Here: the real live WebSocket route (admin/backend/src/routes/agent-live-ws.js),
// the real supervisor client and launcher (every answer checked), the backend's
// relay filter, and a page that runs the dashboard's live-client.js and
// live-input.js unchanged. For each TURN transport (UDP, TCP, TLS) the page must
// play the video through a relay candidate of that transport; then, over UDP,
// input sent before control must not reach X and input sent after it must, as
// counted by the runner.
//
//   node a7_live_browser_e2e.mjs --bridge <socket> --turn-address <ip>
// prints one JSON document.
import http from 'node:http';
import net from 'node:net';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const backend = name => import(pathToFileURL(path.join(REPO, 'admin', 'backend', 'src', name)).href);
const { attachAgentLiveServer } = await backend('routes/agent-live-ws.js');
const { createSupervisorClient } = await backend('lib/operational-worker-supervisor.js');
const { createWorkerLauncher } = await backend('lib/operational-worker-boundary.js');
const { fromViewer, toViewer } = await backend('lib/operational-live-relay.js');
const { chromium } = await import(pathToFileURL(path.join(REPO, 'admin', 'backend', 'node_modules', 'playwright-core', 'index.mjs')).href);

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, i, all) =>
  (value.startsWith('--') ? [...pairs, [value.slice(2), all[i + 1]]] : pairs), []));
const PID = '11111111-2222-4333-8444-555555555555';
const REF = { run_id: '66666666-7777-4888-9999-aaaaaaaaaaaa', attempt_id: '77777777-7777-4888-9999-aaaaaaaaaaaa', fence: 1 };
const VM = '49592202-a8b0-45af-9ac6-5439761d73e4';
const COMPONENTS = path.join(REPO, 'admin', 'frontend', 'src', 'components', 'operational-projects');
const wait = ms => new Promise(done => setTimeout(done, ms));

function bridgeCall(method, params) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(args.bridge);
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('error', reject);
    socket.on('connect', () => socket.write(`${JSON.stringify({ method, params })}\n`));
    socket.on('data', chunk => { buffer += chunk; if (buffer.includes('\n')) { socket.destroy(); resolve(JSON.parse(buffer)); } });
  });
}

// The service's part, as operational-agent-runs.js does it: the launcher's
// checked relay, the backend filter both ways. One transport is offered per
// page load, so the browser must use that one.
const launcher = createWorkerLauncher({ client: createSupervisorClient(args.bridge), vmUuid: VM });
const lives = new Map();
let transport = 'udp';
const offered = url => (transport === 'tls' ? url.startsWith('turns:') : url.startsWith('turn:') && url.endsWith(`transport=${transport}`));
const agentRuns = {
  assertLive: () => true,
  async openLive(_actor, _projectId, _runId, { onMessage, onClose }) {
    const handle = await launcher.live(REF, {
      onMessage: message => { if (message === null) onMessage(null); else { const allowed = toViewer(message); if (allowed) onMessage(allowed); } },
      onClose,
    });
    lives.set(handle.viewer, handle);
    return { viewer: handle.viewer, ttl_seconds: handle.ttl_seconds,
      ice_servers: handle.ice_servers.map(server => ({ ...server, urls: server.urls.filter(offered)
        // The test host name has no DNS here; the relay is reached by address.
        .map(url => url.replace('turn.a7.test', args['turn-address'])) })) };
  },
  sendLive(viewer, _actorId, message) { const allowed = fromViewer(message); return allowed ? lives.get(viewer)?.send(allowed) !== false : false; },
  closeLive(viewer) { lives.get(viewer)?.close(); lives.delete(viewer); },
};

const PAGE = `<!doctype html><meta charset="utf-8"><title>A7 live</title>
<video muted playsinline autoplay style="width:640px;height:400px;background:#000"></video>
<script type="module">
import { createLiveClient } from '/live-client.js';
import { encodeButton, encodeKey, encodeMove, encodeScroll } from '/live-input.js';
const pcs = [];
class Recorded extends RTCPeerConnection { constructor(config) { super(config); pcs.push(this); window.__config = config; } }
window.__candidates = async () => { if (!pcs[0]) return null; const r = await pcs[0].getStats(); const out = [];
  r.forEach(s => { if (s.type === 'local-candidate' || s.type === 'remote-candidate') out.push([s.type, s.candidateType, s.protocol, s.relayProtocol ?? null, s.port]);
    if (s.type === 'candidate-pair') out.push(['pair', s.state, s.nominated]); }); return out; };
setInterval(async () => { const c = await window.__candidates(); if (c && c.length) window.__lastCandidates = c; }, 500);
const video = document.querySelector('video');
window.__states = []; window.__control = null; window.__viewer = null;
const client = createLiveClient({ url: 'ws://' + location.host + '/api/operational-projects/${PID}/agent-runs/${REF.run_id}/live',
  PeerConnection: Recorded,
  onState: (state, detail) => { window.__states.push(state); if (detail?.viewer) window.__viewer = detail.viewer; },
  onStream: (stream, track) => { video.srcObject = stream ?? new MediaStream([track]); video.play().catch(() => {}); },
  onControl: control => { window.__control = control; } });
client.start();
window.__frames = () => video.getVideoPlaybackQuality().totalVideoFrames;
window.__pair = async () => {
  const report = await pcs[0].getStats();
  let pair = null;
  report.forEach(s => { if (s.type === 'transport' && s.selectedCandidatePairId) pair = report.get(s.selectedCandidatePairId); });
  if (!pair) report.forEach(s => { if (s.type === 'candidate-pair' && s.state === 'succeeded' && !pair) pair = s; });
  const local = pair && report.get(pair.localCandidateId), remote = pair && report.get(pair.remoteCandidateId);
  return { local: local?.candidateType ?? null, relay_protocol: local?.relayProtocol ?? null, remote_port: remote?.port ?? null };
};
window.__input = {
  keys: (n) => { for (let i = 0; i < n; i += 1) { client.input(encodeKey(true, 0x61)); client.input(encodeKey(false, 0x61)); } },
  click: () => { client.input(encodeMove(640, 400)); client.input(encodeButton(true, 0)); client.input(encodeButton(false, 0)); },
  scroll: () => client.input(encodeScroll(0, 1, false)),
};
</script>`;

const server = http.createServer((req, res) => {
  const name = { '/live-client.js': 'live-client.js', '/live-input.js': 'live-input.js' }[req.url];
  if (name) { res.setHeader('Content-Type', 'text/javascript'); return res.end(readFileSync(path.join(COMPONENTS, name))); }
  res.setHeader('Content-Type', 'text/html');
  return res.end(PAGE);
});
attachAgentLiveServer(server, { agentRuns, enabled: () => true, verify: () => ({ user: { id: 'viewer-user', jti: 'session-1' } }),
  actorOf: user => user });
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXE || '/opt/pw-browsers/chromium', headless: true,
  // No proxy: Chromium would send TURN over TCP and TLS through the sandbox's
  // HTTPS proxy (it honours the proxy environment). The relay's certificate is
  // self-signed here; on the host it is Caddy's certificate for the TURN name.
  args: ['--no-proxy-server', '--ignore-certificate-errors'] });
const out = { transports: {}, input: null };
try {
  for (const name of ['udp', 'tcp', 'tls']) {
    transport = name;
    const page = await (await browser.newContext({ ignoreHTTPSErrors: true })).newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(origin);
    const started = Date.now();
    let live = false;
    while (Date.now() - started < 25_000) {
      const states = await page.evaluate(() => window.__states);
      if (states.includes('live')) { live = true; break; }
      if (states.some(s => ['failed', 'closed', 'unavailable'].includes(s))) break;
      await wait(200);
    }
    const entry = { live, connect_ms: Date.now() - started, states: await page.evaluate(() => window.__states), errors,
      policy: await page.evaluate(() => window.__config?.iceTransportPolicy ?? null),
      urls: await page.evaluate(() => (window.__config?.iceServers ?? []).flatMap(s => s.urls)) };
    if (!live) entry.candidates = await page.evaluate(() => window.__lastCandidates ?? null);
    if (live) {
      await wait(1500);
      const a = await page.evaluate(() => window.__frames());
      await wait(4000);
      const b = await page.evaluate(() => window.__frames());
      entry.fps = (b - a) / 4;
      entry.pair = await page.evaluate(() => window.__pair());
      if (name === 'udp') {
        const viewer = await page.evaluate(() => window.__viewer);
        await page.evaluate(() => { window.__input.keys(2); window.__input.click(); });
        await wait(1000);
        const before = (await bridgeCall('release', {})).result.inputs;
        const given = (await bridgeCall('takeover', { conn: viewer })).result;
        const start = Date.now();
        while (Date.now() - start < 10_000 && !(await page.evaluate(() => window.__control?.mine))) await wait(100);
        const mine = await page.evaluate(() => window.__control?.mine === true);
        await page.evaluate(() => { window.__input.keys(4); window.__input.click(); window.__input.scroll(); window.__input.scroll(); });
        await wait(1000);
        const after = (await bridgeCall('release', {})).result.inputs;
        out.input = { before, given, control_seen: mine, after, sent_after: { key: 4, click: 1, scroll: 2 } };
      }
    }
    out.transports[name] = entry;
    await page.context().close();
  }
} finally {
  await browser.close();
  server.close();
}
process.stdout.write(`${JSON.stringify(out)}\n`);
process.exit(0);
