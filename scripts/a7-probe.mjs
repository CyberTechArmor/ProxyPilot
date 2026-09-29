#!/usr/bin/env node
// A7 target proof harness. Root only, on the proof host, after the A7 live
// install (a7-install-live.py enable) and the probe build (build-probe).
//
// Like a5-probe.mjs (whose world it reuses): the CANDIDATE's A5 coordinator and
// A7 agent-run service (admin/backend/src/lib/operational-agent-runs.js) with a
// proof SQLite database under /var/lib/proxypilot-a7-proof/<stamp>/, against the
// INSTALLED A3 supervisor's backend socket and the INSTALLED A4 broker. Nothing
// live changes: the ProxyPilot backend, its database and its routes are
// untouched, and activation stays off.
//
// The live view goes through the backend path exactly as the dashboard's does:
// the service's openLive/sendLive/closeLive (the launcher's checks and the
// backend relay filter) exposed to the WebRTC viewer (the Go probe,
// cmd/a7-live-probe) on a private socket in the proof directory, with the
// route's access re-check every second. The viewer connects through the TURN
// relay with relay candidates only, so the frame rate, the relay's
// authentication and the input path are the real ones. Takeover, release,
// resume, decisions, practice and the summary go through the same service
// calls as the routes. Page, file and model text never reach the report, the
// proof database or the log: they hold typed fields only.
//
//   node a7-probe.mjs [--only case,case]    run the proof (all cases by default)
//   node a7-probe.mjs --list                print the case names
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { settings as a5Settings, socketCall, createWorld, seed, bindFresh, revokeBinding } from './a5-probe.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.resolve(HERE, '..', 'admin', 'backend', 'src', 'lib');
const lib = name => import(pathToFileURL(path.join(LIB, name)).href);
const SUMMARY_STATEMENT = "Send this profile's finished runs, as typed facts, to the model provider for a summary";
const ZERO = { key: 0, click: 0, scroll: 0 };

// Resolved at call time, so tests can point the harness at their own sockets.
export const settings = () => ({
  ...a5Settings(),
  root: process.env.A7_PROBE_ROOT || '/var/lib/proxypilot-a7-proof',
  viewer: process.env.A7_PROBE_VIEWER || '/var/lib/proxypilot-a7/a7-live-probe',
  turnAddress: process.env.A7_PROBE_TURN_ADDRESS || '',
  guestPeer: process.env.A7_PROBE_GUEST_PEER || '10.185.17.179:18091',
  otherPeers: (process.env.A7_PROBE_OTHER_PEERS || '10.185.17.1:22,127.0.0.1:18091,1.1.1.1:53').split(','),
  minFps: Number(process.env.A7_PROBE_MIN_FPS || 10),
  heldSeconds: Number(process.env.A7_PROBE_HELD_SECONDS || 120),
  submitInFlightMs: Number(process.env.A7_PROBE_SUBMIT_IN_FLIGHT_MS || 300),
});

const coded = (code, detail) => Object.assign(new Error(code), { code, detail });
// A typed code, else the HTTP status an Operations refusal carries (an outsider
// is told 404 with no code), else INTERNAL.
const codeOf = error => (typeof error?.code === 'string' ? error.code
  : Number.isInteger(error?.status) ? `HTTP_${error.status}` : 'INTERNAL');
const check = (condition, what, observed) => { if (!condition) throw coded('ASSERTION', `${what}: ${JSON.stringify(observed)}`); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, what, ms = 60_000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw coded('TIMEOUT', what);
    await sleep(100);
  }
}
const refusal = async promise => { try { await promise; return 'ACCEPTED'; } catch (error) { return codeOf(error); } };
const refusalSync = fn => { try { fn(); return 'ACCEPTED'; } catch (error) { return codeOf(error); } };

// ---------------------------------------------------------------- the world

function addUser(db, name) {
  const id = randomUUID();
  db.prepare('INSERT INTO users(id,username,role) VALUES(?,?,?)').run(id, `a7-proof-${name}-${id.slice(0, 8)}`, 'user');
  return { id, role: 'user' };
}

export async function createA7World(dir) {
  const world = seed(await createWorld(dir));
  const cfg = settings();
  const [{ createAgentRunService }, { createDemoFixtureWriter }, { runHostCapture }] = await Promise.all([
    lib('operational-agent-runs.js'), lib('operational-demo-fixtures.js'), lib('lxc-zip.js')]);
  Object.assign(world, { a7: cfg, audit: [], children: [], relays: [], shared: {} });
  // The same write path into the demo guest the backend uses for practice runs
  // (A7_PROBE_FIXTURES=file:<path> in the local harness test only).
  const fixtureFile = (process.env.A7_PROBE_FIXTURES || '').startsWith('file:') ? process.env.A7_PROBE_FIXTURES.slice(5) : null;
  world.fixtures = fixtureFile ? { apply: async (mode) => { fs.writeFileSync(fixtureFile, JSON.stringify({ mode })); return { mode }; } }
    : createDemoFixtureWriter({ runHostCapture });
  world.viewerUser = addUser(world.db, 'viewer');
  world.outsider = addUser(world.db, 'outsider');
  for (const project of Object.values(world.projects))
    world.store.grant(world.owner, project.id, world.viewerUser.id, world.store.get(world.owner, project.id).revision,
      { role: 'viewer' });
  world.service = (coordinator, { launcher } = {}) => createAgentRunService({ db: world.db, coordinator,
    launcher: launcher ?? world.launcher, fixtures: world.fixtures, renewMs: 5000, stopWaitMs: 5000, log: world.log,
    audit: (actor, action, details) => world.audit.push({ actor: actor?.id ?? null, action, details }) });
  return world;
}

// A coordinator and a service over it. `approve`: 'hold' records the request
// and waits; 'proof' approves as the proof operator (labelled in the report).
function context(world, { approve = 'hold', launcher } = {}) {
  const ctx = { requests: [] };
  ctx.c = world.coordinator({ launcher, onApprovalRequested: (request) => {
    ctx.requests.push(request);
    if (approve !== 'proof') return;
    setImmediate(() => {
      try {
        ctx.c.approve({ id: world.operator.id, elevated: true }, { approval_id: request.approval_id, digest: request.digest });
        world.approvals.push({ approval_id: request.approval_id, source: 'proof-harness', outcome: 'APPROVED' });
      } catch (error) { world.approvals.push({ approval_id: request.approval_id, source: 'proof-harness', outcome: codeOf(error) }); }
    });
  } });
  ctx.s = world.service(ctx.c, { launcher });
  world.contexts = [...(world.contexts ?? []), ctx];
  return ctx;
}

async function startRun(world, ctx, key, { binding, actor = world.operator, practice } = {}) {
  const project = world.projects[key];
  const detail = await ctx.s.start(actor, project.id, { profile_id: project.profiles[key],
    ...(binding ? { credential_binding_id: binding } : {}), ...(practice ? { practice } : {}) });
  return { project, runId: detail.run.id };
}
const held = (world, ctx) => until(() => ctx.requests.length > 0, 'the approval request', world.a7.heldSeconds * 1000);
const detailOf = (world, ctx, projectId, runId) => ctx.s.status(world.owner, projectId, runId);
async function finish(world, ctx, projectId, runId) {
  await ctx.s.settled(runId);
  return until(() => { const d = detailOf(world, ctx, projectId, runId); return d.result && d; }, 'the result', 120_000);
}
async function stopRun(world, ctx, projectId, runId) {
  await ctx.s.stop(world.operator, projectId, runId).catch(() => {});
  return finish(world, ctx, projectId, runId);
}
const publicResult = r => r && { final_state: r.final_state, result_class: r.result_class, needs_human: r.needs_human,
  verified_account: r.verified_account, receipt_verified: r.receipt?.verified === true, logout: r.logout };
async function journalOf(world, attemptId) {
  const { attempt } = await world.operatorCall('journal', { attempt_id: attemptId });
  return { state: attempt.state, stop_reason: attempt.stop_reason ?? null,
    dashboard_takeover: attempt.dashboard_takeover ? { state: attempt.dashboard_takeover.state,
      inputs: attempt.dashboard_takeover.inputs ?? null, uncontrolled_inputs: attempt.dashboard_takeover.uncontrolled_inputs ?? null } : null,
    notes: (attempt.log || []).map(entry => entry[1]).filter(kind => /takeover|refused|receipt/.test(kind)) };
}
const attemptOf = (world, runId) => world.db.prepare(
  'SELECT id,fence FROM ops_agent_worker_attempts WHERE run_id=? ORDER BY attempt_no DESC LIMIT 1').get(runId);

// The backend path for one viewer: the service's live relay behind a private
// socket speaking the supervisor's stream protocol, with the WebSocket route's
// access re-check (every second here).
function relay(world, ctx, actor, sessionId, projectId, runId) {
  const file = path.join(world.dir, `viewer-${randomUUID().slice(0, 8)}.sock`);
  const server = net.createServer((socket) => {
    let viewer = null, buffer = '', first = true;
    const write = value => { if (!socket.destroyed) socket.write(`${JSON.stringify(value)}\n`); };
    const recheck = setInterval(() => {
      if (!viewer) return;
      try { ctx.s.assertLive(actor, projectId, runId); } catch { const v = viewer; viewer = null; ctx.s.closeLive(v, 'access_ended'); }
    }, 1000);
    socket.setEncoding('utf8');
    socket.on('error', () => {});
    socket.on('close', () => { clearInterval(recheck); if (viewer) ctx.s.closeLive(viewer, 'viewer_closed'); viewer = null; });
    socket.on('data', (chunk) => {
      buffer += chunk;
      for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
        let message;
        try { message = JSON.parse(buffer.slice(0, end)); } catch { socket.destroy(); return; }
        buffer = buffer.slice(end + 1);
        if (first) {
          first = false;
          ctx.s.openLive(actor, projectId, runId, { sessionId,
            onMessage: m => write(m === null ? { dropped: true } : { recv: m }),
            onClose: (reason) => { viewer = null; write({ closed: reason }); socket.end(); } })
            .then((opened) => { viewer = opened.viewer; write({ ok: true, result: { conn: opened.viewer,
              ice_servers: opened.ice_servers, ttl_seconds: opened.ttl_seconds } }); },
            (error) => { write({ ok: false, error: codeOf(error) }); socket.end(); });
        } else if (message?.close) {
          if (viewer) ctx.s.closeLive(viewer, 'viewer_closed');
          viewer = null;
        } else if (viewer && message && 'send' in message) ctx.s.sendLive(viewer, actor.id, message.send);
      }
    });
  });
  const ready = new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(file, () => { fs.chmodSync(file, 0o600); resolve(); });
  });
  const handle = { file, ready, close: () => new Promise(done => server.close(() => { fs.rmSync(file, { force: true }); done(); })) };
  world.relays.push(handle);
  return handle;
}

// The WebRTC viewer (cmd/a7-live-probe). Its stdout is JSON lines; nothing it
// prints carries a credential or page content.
function viewer(world, relayFile, args = []) {
  const cfg = world.a7;
  const child = spawn(cfg.viewer, ['-socket', relayFile, '-run', randomUUID(), '-attempt', randomUUID(), '-fence', '1',
    ...(cfg.turnAddress ? ['-turn-address', cfg.turnAddress] : []), ...args], { stdio: ['pipe', 'pipe', 'ignore'] });
  world.children.push(child);
  const events = [], waiting = [];
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    let event;
    try { event = JSON.parse(line); } catch { return; }
    events.push(event);
    for (const w of [...waiting]) if (w.match(event)) { waiting.splice(waiting.indexOf(w), 1); w.resolve(event); }
  });
  const exited = new Promise(done => child.on('exit', code => {
    done(code);
    for (const w of waiting.splice(0)) w.resolve({ event: 'exited', code });
  }));
  const next = (name, ms = 60_000) => {
    const seen = events.find(e => e.event === name);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      const w = { match: e => e.event === name || e.event === 'error' || (name !== 'report' && e.event === 'report'), resolve };
      waiting.push(w);
      setTimeout(() => { if (waiting.includes(w)) { waiting.splice(waiting.indexOf(w), 1); reject(coded('VIEWER_TIMEOUT', name)); } }, ms);
    });
  };
  return { child, events, next, exited, write: line => child.stdin.write(`${line}\n`) };
}
async function expectEvent(v, name, ms) {
  const event = await v.next(name, ms);
  check(event.event === name, `viewer ${name}`, event);
  return event;
}

// ------------------------------------------------------------------- cases

export const CASES = {
  // The real-time view: through the backend path and the TURN relay, relay
  // candidates only, to the VM's one Neko port; its frame rate.
  async live_view(world) {
    const ctx = context(world);
    const binding = await bindFresh(world, 'rules');
    const { project, runId } = await startRun(world, ctx, 'rules', { binding });
    await held(world, ctx);
    const r = relay(world, ctx, world.operator, 'session-operator', project.id, runId);
    await r.ready;
    const v = viewer(world, r.file, ['-seconds', '12']);
    const opened = await expectEvent(v, 'opened');
    const connected = await expectEvent(v, 'connected', 60_000);
    const report = await expectEvent(v, 'report', 60_000);
    check(opened.username_expiry_and_viewer === true && opened.turn_url.startsWith('turn:'), 'a per-viewer TURN credential', opened);
    check(report.connected === true && report.pair.local === 'relay' && report.pair.local_protocol === 'udp' &&
      report.pair.remote_port === 18091, 'relay candidates to the one Neko port', report);
    check(report.fps >= world.a7.minFps && report.frames > 0, `at least ${world.a7.minFps} frames a second`, report);
    const controls = detailOf(world, ctx, project.id, runId).controls;
    check(controls.live.enabled && controls.takeover.enabled, 'live view and takeover offered', controls);
    const done = await stopRun(world, ctx, project.id, runId);
    check(done.result.receipt.verified, 'verified receipt', done.result);
    return { connect_ms: connected.after_ms, fps: report.fps, frames: report.frames, pair: report.pair,
      result: publicResult(done.result) };
  },

  // Authentication of the view and of takeover: roles, the relay's credential
  // and scope, the session's verification, the caller's own view.
  async live_refusals(world) {
    const ctx = context(world);
    const binding = await bindFresh(world, 'rules');
    const { project, runId } = await startRun(world, ctx, 'rules', { binding });
    await held(world, ctx);
    const found = {
      viewer_role: await refusal(ctx.s.openLive(world.viewerUser, project.id, runId, {})),
      outsider: await refusal(ctx.s.openLive(world.outsider, project.id, runId, {})),
    };
    const bad = viewer(world, (await (async () => { const r = relay(world, ctx, world.operator, 's-op', project.id, runId); await r.ready; return r; })()).file,
      ['-seconds', '12', '-bad-credential']);
    const badReport = await expectEvent(bad, 'report', 60_000);
    found.wrong_credential_connected = badReport.connected;
    const scope = relay(world, ctx, world.operator, 's-op', project.id, runId);
    await scope.ready;
    const peers = [world.a7.guestPeer, ...world.a7.otherPeers];
    const checker = viewer(world, scope.file, ['-relay-check', peers.join(',')]);
    const relayCheck = await expectEvent(checker, 'relay_check', 60_000);
    found.relay_peers = relayCheck.peers;
    // The fallback listeners (3478/TCP, 5349/TLS): the same credential, the
    // certificate verified for the TURN name, the same scope.
    found.fallback = {};
    for (const transport of ['tcp', 'tls']) {
      const fallback = relay(world, ctx, world.operator, 's-op', project.id, runId);
      await fallback.ready;
      const c = viewer(world, fallback.file, ['-relay-check', [world.a7.guestPeer, world.a7.otherPeers[0]].join(','),
        '-relay-transport', transport]);
      const e = await expectEvent(c, 'relay_check', 60_000);
      found.fallback[transport] = { allocated: e.allocated, code: e.code ?? null, tls: e.tls ?? null, peers: e.peers ?? {} };
    }
    const mine = relay(world, ctx, world.reviewer, 's-rev', project.id, runId);
    await mine.ready;
    const reviewerView = viewer(world, mine.file, ['-seconds', '30']);
    const theirs = await expectEvent(reviewerView, 'opened');
    found.unverified = await refusal(ctx.s.takeover(world.operator, project.id, runId, { viewer: theirs.conn }, { verified: false, sessionId: 's-op' }));
    found.someone_elses_view = await refusal(ctx.s.takeover(world.operator, project.id, runId, { viewer: theirs.conn }, { verified: true, sessionId: 's-op' }));
    found.other_session = await refusal(ctx.s.takeover(world.reviewer, project.id, runId, { viewer: theirs.conn }, { verified: true, sessionId: 's-other' }));
    found.viewer_role_takeover = await refusal(ctx.s.takeover(world.viewerUser, project.id, runId, { viewer: theirs.conn }, { verified: true, sessionId: 's-rev' }));
    check(found.viewer_role === 'RUN_ACCESS_DENIED' && found.outsider === 'HTTP_404', 'view refusals', found);
    check(found.wrong_credential_connected === false, 'a wrong TURN credential gets nothing', found);
    check(relayCheck.allocated && found.relay_peers[world.a7.guestPeer] === 'permitted' &&
      world.a7.otherPeers.every(p => /403/.test(found.relay_peers[p] ?? '')), 'the relay reaches the VM only', found.relay_peers);
    for (const transport of ['tcp', 'tls']) {
      const f = found.fallback[transport];
      check(f.allocated && f.peers[world.a7.guestPeer] === 'permitted' && /403/.test(f.peers[world.a7.otherPeers[0]] ?? ''),
        `the ${transport} listener allocates, to the VM only`, f);
    }
    check(typeof found.fallback.tls.tls?.verified_name === 'string', 'the TLS certificate verified for the TURN name', found.fallback.tls);
    check(found.unverified === 'CONTROL_VERIFICATION_REQUIRED' && found.someone_elses_view === 'TAKEOVER_VIEWER_UNKNOWN' &&
      found.other_session === 'TAKEOVER_VIEWER_UNKNOWN' && found.viewer_role_takeover === 'RUN_ACCESS_DENIED', 'takeover refusals', found);
    check(!world.audit.some(a => a.action === 'AGENT_RUN_TAKEN_OVER'), 'nothing was taken over', world.audit);
    const done = await stopRun(world, ctx, project.id, runId);
    return { found, result: publicResult(done.result) };
  },

  // Dashboard takeover through the backend path: the model stops, one person
  // controls, a second viewer's input is ignored, input counted by kind only;
  // giving it back ends the run taken_over with a verified receipt.
  async dashboard_takeover(world) {
    const ctx = context(world);
    const binding = await bindFresh(world, 'rules');
    const { project, runId } = await startRun(world, ctx, 'rules', { binding });
    await held(world, ctx);
    const holderRelay = relay(world, ctx, world.operator, 'session-operator', project.id, runId);
    const otherRelay = relay(world, ctx, world.reviewer, 'session-reviewer', project.id, runId);
    await Promise.all([holderRelay.ready, otherRelay.ready]);
    const holder = viewer(world, holderRelay.file, ['-seconds', '40', '-control', '-keys', '5']);
    const other = viewer(world, otherRelay.file, ['-seconds', '40', '-control', '-keys', '3', '-force-input']);
    const opened = await expectEvent(holder, 'opened');
    await Promise.all([expectEvent(holder, 'ready_for_control', 60_000), expectEvent(other, 'ready_for_control', 60_000)]);
    await sleep(1000);
    const taken = await ctx.s.takeover(world.operator, project.id, runId, { viewer: opened.conn },
      { verified: true, sessionId: 'session-operator' });
    const audit = world.audit.filter(a => a.action === 'AGENT_RUN_TAKEN_OVER').at(-1)?.details ?? {};
    check(JSON.stringify(audit.uncontrolled_inputs) === JSON.stringify(ZERO) && audit.password_fields_empty === true,
      'no input from anyone before control; no filled password field', audit);
    check(taken.controls.takeover.holder?.state === 'holding' && taken.approvals.every(a => a.state !== 'requested'),
      'one holder; the open approval closed', { holder: taken.controls.takeover.holder, approvals: taken.approvals.map(a => [a.state, a.stale_reason]) });
    holder.write('control');
    const sent = await expectEvent(holder, 'input_sent', 30_000);
    other.write('control');
    await expectEvent(other, 'input_sent', 30_000);
    await sleep(1500);
    const second = await refusal(ctx.s.takeover(world.reviewer, project.id, runId,
      { viewer: other.events.find(e => e.event === 'opened').conn }, { verified: true, sessionId: 'session-reviewer' }));
    const notYours = await refusal(ctx.s.endTakeover(world.reviewer, project.id, runId));
    await ctx.s.endTakeover(world.operator, project.id, runId);
    const done = await finish(world, ctx, project.id, runId);
    const takeover = done.takeovers[0];
    check(second === 'TAKEOVER_HELD' && notYours === 'TAKEOVER_NOT_YOURS', 'one controller', { second, notYours });
    check(takeover.inputs.key === 5 && takeover.inputs.click === 1 && takeover.inputs.scroll >= 2,
      'exactly the holder\'s input reached the browser (the second viewer\'s did not)', takeover.inputs);
    check(done.result.result_class === 'taken_over' && done.result.needs_human && done.result.receipt.verified,
      'the run ends taken_over, needing a person, with a verified receipt', done.result);
    const journal = await journalOf(world, attemptOf(world, runId).id);
    check(journal.stop_reason === 'taken_over', 'the taken_over stop reason', journal);
    world.shared.takenOver = { projectId: project.id, runId, binding };
    return { sent: sent.sent, counted: takeover.inputs, end_reason: takeover.end_reason, audit_before: audit.uncontrolled_inputs,
      journal, result: publicResult(done.result) };
  },

  // Resume: a new linked run with the same pins, a new attempt and fence, its
  // own approval; the old attempt stays gone.
  async resume_new_run(world) {
    const prior = world.shared.takenOver;
    check(prior, 'dashboard_takeover ran first', null);
    const ctx = context(world, { approve: 'proof' });
    await ctx.s.reconcile(world.operator, prior.projectId, prior.runId, { subject: 'run', decision: 'acknowledged' }, { verified: true });
    const oldAttempt = attemptOf(world, prior.runId);
    const resumed = await ctx.s.resume(world.operator, prior.projectId, prior.runId);
    const done = await finish(world, ctx, prior.projectId, resumed.run.id);
    const newAttempt = attemptOf(world, resumed.run.id);
    const oldRenew = await refusal(world.launcher.renew({ run_id: prior.runId, attempt_id: oldAttempt.id, fence: oldAttempt.fence }));
    const again = await refusal(ctx.s.resume(world.operator, prior.projectId, prior.runId));
    check(done.origin.resumed_from_run_id === prior.runId && newAttempt.id !== oldAttempt.id, 'a new linked run and attempt', done.origin);
    check(done.result.result_class === 'verified_account' && done.approvals.length === 1 && done.approvals[0].state === 'consumed',
      'the resumed run needs and uses its own approval', { result: done.result, approvals: done.approvals.map(a => a.state) });
    check(oldRenew !== 'ACCEPTED' && again === 'RESUME_ALREADY_STARTED', 'the old attempt stays gone; one resume', { oldRenew, again });
    return { new_run: resumed.run.id, new_fence: newAttempt.fence, old_attempt_renew: oldRenew, second_resume: again,
      result: publicResult(done.result) };
  },

  // The credential stays out of reach: a takeover asked for while the submit
  // is in flight is handed over only after it finished and cleared the fields.
  async takeover_during_submit(world) {
    const timing = {};
    let takeover = null;
    // The takeover is asked for once the submit is at the supervisor (in
    // flight in the runner), not before it: then the model is fenced first and
    // the submit is refused, which is a different (and already proven) case.
    const wrapped = { ...world.launcher, action: async (request) => {
      const submit = request.action === 'submit_bound_fixture';
      if (!submit) return world.launcher.action(request);
      timing.submit_started = Date.now();
      const sent = world.launcher.action(request);
      const asked = sleep(world.a7.submitInFlightMs).then(() => { takeover = timing.onSubmit?.(); });
      try { return await sent; } finally { timing.submit_ended = Date.now(); await asked; }
    } };
    const ctx = context(world, { launcher: wrapped });
    const binding = await bindFresh(world, 'rules');
    const { project, runId } = await startRun(world, ctx, 'rules', { binding });
    const request = await held(world, ctx).then(() => ctx.requests[0]);
    const r = relay(world, ctx, world.operator, 'session-operator', project.id, runId);
    await r.ready;
    const v = viewer(world, r.file, ['-seconds', '60']);
    const opened = await expectEvent(v, 'opened');
    await expectEvent(v, 'connected', 60_000);
    timing.onSubmit = () => ctx.s.takeover(world.operator, project.id, runId, { viewer: opened.conn },
      { verified: true, sessionId: 'session-operator' }).then(value => { timing.handed = Date.now(); return value; });
    ctx.c.approve({ id: world.operator.id, elevated: true }, { approval_id: request.approval_id, digest: request.digest });
    world.approvals.push({ approval_id: request.approval_id, source: 'proof-harness', outcome: 'APPROVED' });
    await until(() => takeover, 'the takeover request', 60_000);
    await takeover;
    const audit = world.audit.filter(a => a.action === 'AGENT_RUN_TAKEN_OVER').at(-1)?.details ?? {};
    check(timing.handed >= timing.submit_ended, 'control handed over only after the submit finished', timing);
    check(audit.password_fields_empty === true, 'no password field held a value', audit);
    await ctx.s.endTakeover(world.operator, project.id, runId);
    const done = await finish(world, ctx, project.id, runId);
    const submit = done.steps.find(s => s.action === 'submit_bound_fixture');
    check(submit?.state === 'done' && submit.claims.outcome === 'signed_in', 'the submit completed', submit);
    return { submit_ms: timing.submit_ended - timing.submit_started, handed_after_submit_ms: timing.handed - timing.submit_ended,
      password_fields_empty: audit.password_fields_empty, result: publicResult(done.result) };
  },

  // Grant loss while holding control: the view closes at the next check and
  // the takeover ends for them (their access is gone); the run ends.
  async grant_loss_while_holding(world) {
    const ctx = context(world);
    const binding = await bindFresh(world, 'rules');
    const { project, runId } = await startRun(world, ctx, 'rules', { binding });
    await held(world, ctx);
    const r = relay(world, ctx, world.reviewer, 'session-reviewer', project.id, runId);
    await r.ready;
    const v = viewer(world, r.file, ['-seconds', '60']);
    const opened = await expectEvent(v, 'opened');
    await expectEvent(v, 'connected', 60_000);
    await ctx.s.takeover(world.reviewer, project.id, runId, { viewer: opened.conn }, { verified: true, sessionId: 'session-reviewer' });
    world.store.remove(world.owner, project.id, world.reviewer.id, world.store.get(world.owner, project.id).revision);
    try {
      const done = await finish(world, ctx, project.id, runId);
      const closed = await v.next('report', 30_000);
      check(done.takeovers[0].end_reason === 'viewer_left' && done.result.result_class === 'taken_over' &&
        done.result.receipt.verified, 'the takeover ended with the view; the run ended', { takeovers: done.takeovers, result: done.result });
      return { end_reason: done.takeovers[0].end_reason, viewer_closed: closed.closed ?? closed.event, result: publicResult(done.result) };
    } finally {
      world.store.grant(world.owner, project.id, world.reviewer.id, world.store.get(world.owner, project.id).revision, { role: 'reviewer' });
    }
  },

  // Kill case: the coordinator dies while a person holds control. After the
  // restart the run is fenced and never resumed; the takeover is closed.
  async coordinator_killed_while_holding(world) {
    const project = world.projects.rules;
    const binding = await bindFresh(world, 'rules');
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--child-takeover', world.dir, binding],
      { stdio: ['ignore', 'pipe', 'ignore'], env: process.env });
    world.children.push(child);
    let line = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { line += chunk; });
    const code = await new Promise(done => child.on('exit', (c, signal) => done(signal ?? c)));
    const holding = JSON.parse(line.trim().split('\n').at(-1) || '{}');
    check(code === 'SIGKILL' && holding.run_id, 'the child held control and was killed', { code, holding });
    const ctx = context(world);
    const recovered = await ctx.c.recover();
    const done = await finish(world, ctx, project.id, holding.run_id);
    check(done.takeovers[0].end_reason === 'coordinator_restart' && done.result.needs_human && done.result.receipt.verified,
      'fenced and closed after the restart', { takeovers: done.takeovers, result: done.result });
    return { recovered: recovered.length, end_reason: done.takeovers[0].end_reason, result: publicResult(done.result) };
  },

  // Decision 6: a sign-in the demo answers too slowly is a timeout, a help
  // request that gates the profile until a person decides it. A practice run
  // in the `slow` fixture mode, set through the backend's fixture writer.
  async timeout_is_a_decision(world) {
    const ctx = context(world, { approve: 'proof' });
    const binding = await bindFresh(world, 'rules');
    const { project, runId } = await startRun(world, ctx, 'rules', { binding, practice: { fixture_mode: 'slow' } });
    const done = await finish(world, ctx, project.id, runId);
    const submit = done.steps.find(s => s.action === 'submit_bound_fixture');
    const gate = await refusal(ctx.s.start(world.operator, project.id, { profile_id: project.profiles.rules, credential_binding_id: binding }));
    const item = done.reconciliation.items.find(i => i.kind === 'write');
    check(done.result.result_class === 'timeout' && done.result.needs_human && item?.gates && gate === 'RECONCILIATION_REQUIRED',
      'a timeout needs a person and gates the profile', { result: done.result, item, gate });
    check(submit.claims.outcome === 'timeout' && (submit.claims.login_requests ?? 1) === 1, 'one sign-in request', submit.claims);
    // The slow demo completes the sign-in after the proxy gave up: it happened.
    const decided = await ctx.s.reconcile(world.operator, project.id, runId, { subject: item.subject, decision: 'happened' }, { verified: true });
    const fixture = world.db.prepare('SELECT mode,applied FROM ops_agent_fixture_state WHERE id=1').get();
    check(!decided.reconciliation.items.some(i => i.gates) && fixture.mode === 'normal' && fixture.applied === 1,
      'the decision lifts the gate; the demo is back to normal', { items: decided.reconciliation.items, fixture });
    return { result: publicResult(done.result), submit_claims: submit.claims, gate, decided: item.subject, fixture };
  },

  // Decision 6: the two model classes proven through the broker's operator-only
  // proof switches (a fixed reply, no provider call).
  async model_proof_switches(world) {
    const out = {};
    for (const [proof, expected] of [['reply_outside_set', ['blocked', 'model_choice_invalid']],
      ['usage_missing', ['failed', 'usage_unknown']]]) {
      const { createWorkerLauncher } = await lib('operational-worker-boundary.js');
      const client = { request: (method, params) => (method === 'model_step'
        ? socketCall(world.cfg.operatorSocket, 'model_step', { ...params, proof }) : world.client.request(method, params)),
      stream: (...a) => world.client.stream(...a) };
      const launcher = createWorkerLauncher({ client, vmUuid: world.cfg.vmUuid });
      const ctx = context(world, { approve: 'proof', launcher });
      const binding = await bindFresh(world, 'main');
      const { project, runId } = await startRun(world, ctx, 'main', { binding });
      const done = await finish(world, ctx, project.id, runId);
      const ledger = await world.broker('ledger', { run_id: runId });
      out[proof] = { result: publicResult(done.result), calls: ledger.calls.map(c => ({ state: c.state, refusal: c.refusal ?? null,
        proof: c.proof ?? null, provider_contacted: c.provider_contacted ?? null })) };
      check([done.result.final_state, done.result.result_class].join('/') === expected.join('/'), `class for ${proof}`, out[proof]);
      check(ledger.calls.length === 1 && ledger.calls[0].provider_contacted === false, 'no provider call', out[proof].calls);
    }
    return out;
  },

  // Decision 5: with the owner's consent, a finished run gets one model summary
  // from typed facts (one real provider call, under the run's budget).
  async model_summary(world) {
    const project = world.projects.rules, profileId = project.profiles.rules;
    const profile = world.store.profile(world.owner, project.id, profileId).profile;
    world.store.modelSummaryConsent(world.owner, project.id, profileId, profile.revision,
      { model_summary_consent: true, reviewed_statement: SUMMARY_STATEMENT });
    try {
      const ctx = context(world, { approve: 'proof' });
      const binding = await bindFresh(world, 'rules');
      const { runId } = await startRun(world, ctx, 'rules', { binding });
      const done = await finish(world, ctx, project.id, runId);
      const summary = await until(() => { const s = detailOf(world, ctx, project.id, runId).summary; return s && s.state !== 'reserved' && s; },
        'the summary', 120_000);
      const ledger = await world.broker('ledger', { run_id: runId });
      check(summary.state === 'written' && summary.text.length > 0 && summary.text.length <= 800, 'a bounded summary', { state: summary.state });
      check(ledger.calls.some(c => c.kind === 'summary' && c.state === 'settled'), 'one settled summary call', ledger.calls.map(c => [c.kind, c.state]));
      return { result: publicResult(done.result), summary: { state: summary.state, chars: summary.text.length,
        prompt_tokens: summary.prompt_tokens, completion_tokens: summary.completion_tokens, settled_usd: summary.settled_usd } };
    } finally {
      const now = world.store.profile(world.owner, project.id, profileId).profile;
      world.store.modelSummaryConsent(world.owner, project.id, profileId, now.revision, { model_summary_consent: false });
    }
  },
};
export const ORDER = ['live_view', 'live_refusals', 'dashboard_takeover', 'resume_new_run', 'takeover_during_submit',
  'grant_loss_while_holding', 'coordinator_killed_while_holding', 'timeout_is_a_decision', 'model_proof_switches',
  'model_summary'];

// The killed coordinator: holds control through the backend path, then dies.
async function childTakeover([dir, binding]) {
  const world = await createWorld(dir);
  const first = world.db.prepare("SELECT id FROM users WHERE username LIKE 'a5-proof-operator-%'").get();
  const project = world.db.prepare("SELECT p.id, pr.id AS profile FROM ops_projects p JOIN ops_agent_profiles pr ON pr.project_id=p.id WHERE p.name='A5 proof rules'").get();
  world.operator = { id: first.id, role: 'user' };
  world.projects = { rules: { id: project.id, profiles: { rules: project.profile } } };
  Object.assign(world, { a7: settings(), audit: [], children: [], relays: [], approvals: [] });
  const { createAgentRunService } = await lib('operational-agent-runs.js');
  world.service = (coordinator) => createAgentRunService({ db: world.db, coordinator, launcher: world.launcher,
    fixtures: { apply: async () => ({}) }, renewMs: 5000, audit: () => {} });
  const ctx = context(world);
  const { runId } = await startRun(world, ctx, 'rules', { binding });
  await held(world, ctx);
  const r = relay(world, ctx, world.operator, 'session-operator', project.id, runId);
  await r.ready;
  const v = viewer(world, r.file, ['-seconds', '120']);
  const opened = await expectEvent(v, 'opened');
  await expectEvent(v, 'connected', 60_000);
  await ctx.s.takeover(world.operator, project.id, runId, { viewer: opened.conn }, { verified: true, sessionId: 'session-operator' });
  process.stdout.write(`${JSON.stringify({ run_id: runId, holding: true })}\n`);
  await sleep(500);
  process.kill(process.pid, 'SIGKILL');
}

// A failed case must not leave a live run (or a viewer) behind for the next.
async function stopActive(world) {
  const stopped = [];
  for (const child of world.children) if (child.exitCode === null && !child.killed) child.kill('SIGTERM');
  const ctx = context(world);
  for (const run of world.db.prepare("SELECT id,project_id FROM ops_agent_runs WHERE state IN ('prepared','starting','running','cancelling')").all()) {
    try { await ctx.s.stop(world.operator, run.project_id, run.id); await ctx.s.settled(run.id); stopped.push(run.id); }
    catch (error) { stopped.push({ id: run.id, error: codeOf(error) }); }
  }
  return stopped;
}

async function cleanup(world) {
  const out = { stopped: [], revoked: [], fixture: null, viewers: 0 };
  for (const child of world.children) if (child.exitCode === null && !child.killed) { child.kill('SIGTERM'); out.viewers += 1; }
  for (const r of world.relays) await r.close().catch(() => {});
  const active = world.db.prepare("SELECT id,project_id FROM ops_agent_runs WHERE state IN ('prepared','starting','running','cancelling')").all();
  const ctx = context(world);
  for (const run of active) {
    try { await ctx.s.stop(world.operator, run.project_id, run.id); out.stopped.push(run.id); }
    catch (error) { out.stopped.push({ id: run.id, error: codeOf(error) }); }
  }
  for (const id of world.boundIds) {
    try { await revokeBinding(world, id); out.revoked.push(id); } catch (error) { out.revoked.push({ id, error: codeOf(error) }); }
  }
  try { await world.fixtures.apply('normal'); out.fixture = 'normal'; } catch (error) { out.fixture = codeOf(error); }
  return out;
}

export async function main(argv = process.argv.slice(2)) {
  if (argv[0] === '--child-takeover') return childTakeover(argv.slice(1));
  if (argv[0] === '--list') { process.stdout.write(`${ORDER.join('\n')}\n`); return 0; }
  const only = argv[0] === '--only' ? String(argv[1] || '').split(',').filter(Boolean) : ORDER;
  const unknown = only.filter(name => !CASES[name]);
  if (unknown.length) throw coded('UNKNOWN_CASE', unknown.join(','));
  if (process.getuid?.() !== 0) throw coded('ROOT_REQUIRED');
  const cfg = settings();
  if (!fs.existsSync(cfg.viewer)) throw coded('VIEWER_MISSING', `${cfg.viewer} (a7-install-live.py build-probe)`);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const dir = path.join(cfg.root, stamp);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const status = await socketCall(cfg.backendSocket, 'status', {});
  if (!status.accepting_launch) throw coded('SUPERVISOR_NOT_ACCEPTING', JSON.stringify(status.blockers));
  if (status.live !== true) throw coded('LIVE_NOT_ENABLED', 'a7-install-live.py enable');
  const world = await createA7World(dir);
  await world.fixtures.apply('normal');
  const report = { a7_proof: 'running', dir, started_at: new Date().toISOString(), node: process.versions.node,
    supervisor: { key_id: status.supervisor?.key_id, supervisor_sha256: status.supervisor?.supervisor_sha256,
      runner_sha256: status.supervisor?.runner_sha256, boot_id: status.boundary?.boot_id, live: status.live,
      credential_broker: status.credential_broker },
    harness_sha256: createHash('sha256').update(fs.readFileSync(fileURLToPath(import.meta.url))).digest('hex'),
    viewer_sha256: createHash('sha256').update(fs.readFileSync(cfg.viewer)).digest('hex'), cases: [] };
  try {
    for (const name of only) {
      const started = Date.now();
      const entry = { case: name };
      try {
        entry.observed = await CASES[name](world);
        entry.passed = true;
      } catch (error) {
        entry.passed = false;
        entry.error = { code: codeOf(error), detail: String(error?.detail ?? error?.message ?? '').slice(0, 1500) };
        entry.cleanup = await stopActive(world);
      }
      entry.seconds = Math.round((Date.now() - started) / 100) / 10;
      report.cases.push(entry);
      process.stdout.write(`${JSON.stringify({ case: name, passed: entry.passed, seconds: entry.seconds,
        ...(entry.error ? { error: entry.error } : {}) })}\n`);
    }
  } finally {
    report.cleanup = await cleanup(world);
    report.approvals = world.approvals;
    report.bindings = world.boundIds;
    report.audit = world.audit.map(a => ({ action: a.action, run_id: a.details?.run_id ?? null }));
    report.finished_at = new Date().toISOString();
    report.a7_proof = report.cases.every(c => c.passed) ? 'passed' : 'failed';
    const file = path.join(dir, `a7-proof-${stamp}.json`);
    fs.writeFileSync(file, `${JSON.stringify(report, null, 1)}\n`, { mode: 0o600 });
    fs.writeFileSync(path.join(dir, 'last-binding'), `${world.boundIds.at(-1) ?? ''}\n`, { mode: 0o600 });
    world.proof.close();
    process.stdout.write(`${JSON.stringify({ a7_proof: report.a7_proof, report: file,
      cases: report.cases.map(c => [c.case, c.passed]), last_binding: world.boundIds.at(-1) ?? null })}\n`);
  }
  return report.a7_proof === 'passed' ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().then(code => process.exit(code ?? 0), (error) => {
    process.stderr.write(`A7 proof stopped: ${codeOf(error)}${error?.detail ? ` (${String(error.detail).slice(0, 300)})` : ''}\n`);
    process.exit(1);
  });
}
