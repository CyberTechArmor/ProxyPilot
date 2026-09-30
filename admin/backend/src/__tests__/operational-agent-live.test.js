import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixtureRouter } from './helpers/operations-fixture.js';
import { agentRunsWorld } from './helpers/agent-runs-world.js';
import { createOperationsRouter } from '../routes/operational-projects.js';
import { createDemoFixtureWriter, DEMO_FIXTURE, fixtureDocument } from '../lib/operational-demo-fixtures.js';
import { fromViewer, toViewer, createLiveOpeningQueue } from '../lib/operational-live-relay.js';
import { createWorkerLauncher } from '../lib/operational-worker-boundary.js';

// A7 live view and dashboard takeover (user decisions 1, 1a-1c): the relay
// carries Neko signalling only and filters it both ways; each viewer gets its
// own TURN credential; takeover needs run access plus the session's own
// agent-control verification and hands control to the caller's own open view;
// one controller; ending it (or leaving) ends the run taken_over with a verified
// receipt. And the automatic model summary (decision 5): consent, typed facts
// the host supervisor accepts, one call per run, never retried.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS = path.join(HERE, '..', '..', '..', '..', 'scripts');
const SUMMARY = "Send this profile's finished runs, as typed facts, to the model provider for a summary";
const sudo = (req, res, next) => req.sudo === true ? next() : res.status(401).json({ error: 'sudo_required', sudo_required: true });
function routed(w) {
  const router = createOperationsRouter({ Router: fixtureRouter, store: w.f.store, enabled: true, agentsEnabled: true,
    lookupLimiter: (_r, _s, n) => n(), agentRuns: w.service, requireSudo: sudo, controlVerified: req => req.verified === true });
  const call = (user, method, route, body = {}, extra = {}) => router.dispatch({ method, path: route, body, user,
    headers: {}, query: {}, sudo: extra.sudo, verified: extra.verified });
  return { call };
}
async function until(fn, label, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await new Promise(done => setTimeout(done, 10));
  }
}
const session = (user, jti) => ({ ...user, jti });
const statusOf = (w, runId) => w.service.status(w.users.owner, w.p.id, runId);

// A run held at its second step (the browser is up, the agent waits).
async function heldRun(w, call, user) {
  w.supervisor.scenario.holds.add('open_login');
  const res = await call(user, 'POST', `/${w.p.id}/agent-runs`, { profile_id: w.profile.id,
    credential_binding_id: w.binding.binding_id });
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  await until(() => w.supervisor.calls.some(c => c.method === 'action' && c.params.action === 'open_login'), 'held step');
  return res.body.run.id;
}
async function openView(w, user, runId, jti) {
  const received = [], closes = [];
  const live = await w.service.openLive(user, w.p.id, runId, { sessionId: jti, onMessage: m => received.push(m),
    onClose: r => closes.push(r) });
  await until(() => received.some(m => m?.event === 'system/init'), 'system/init');
  return { ...live, received, closes };
}

test('relay filter: signalling only, both ways; init and provide are reduced', () => {
  assert.deepEqual(fromViewer({ event: 'signal/answer', payload: { sdp: 'v=0' } }), { event: 'signal/answer', payload: { sdp: 'v=0' } });
  assert.deepEqual(fromViewer({ event: 'client/heartbeat' }), { event: 'client/heartbeat' });
  for (const bad of [{ event: 'control/move', payload: { x: 1, y: 1 } }, { event: 'control/request' },
    { event: 'chat/message', payload: { text: 'hi' } }, { event: 'clipboard/set', payload: { text: 'x' } },
    { event: 'signal/answer', payload: 'v=0' }, { event: 'signal/answer', payload: [] },
    { event: 'signal/answer', payload: { sdp: 'x' }, extra: 1 }, { event: 'system/init' }, null, 'signal/answer',
    { event: 'signal/answer', payload: { sdp: 'x'.repeat(70 * 1024) } }])
    assert.equal(fromViewer(bad), null, JSON.stringify(bad)?.slice(0, 60));
  assert.deepEqual(toViewer({ event: 'system/init', payload: { session_id: 'a', control_host: { has_host: false },
    screen_size: { width: 1, height: 1 }, webrtc: { videos: [] }, sessions: { b: {} }, settings: { x: 1 } } }).payload,
  { session_id: 'a', control_host: { has_host: false }, screen_size: { width: 1, height: 1 }, webrtc: { videos: [] } });
  assert.deepEqual(toViewer({ event: 'signal/provide', payload: { sdp: 's', iceservers: [{ urls: ['stun:x'] }] } }).payload,
    { sdp: 's' });
  for (const hidden of ['chat/message', 'member/created', 'session/created', 'clipboard/updated', 'system/admin',
    'filetransfer/update', 'send/broadcast']) assert.equal(toViewer({ event: hidden, payload: {} }), null, hidden);
});

test('opening queue: its byte bound closes once, discards everything and never reopens', () => {
  const sent = [];
  let overflows = 0;
  const q = createLiveOpeningQueue({ send: m => sent.push(m), onOverflow: () => { overflows += 1; } });
  const message = { type: 'neko', message: { event: 'signal/provide', payload: { sdp: 'x'.repeat(63 * 1024) } } };
  for (let n = 0; n < 4; n += 1) assert.equal(q.message(message), true);
  assert.equal(q.message(message), false);
  assert.equal(q.message(message), false);
  assert.equal(q.open({ type: 'ready' }), false);
  assert.equal(overflows, 1);
  assert.deepEqual(sent, []);
});

test('opening queue: messages received while flushing retain order and close discards later ones', () => {
  const sent = [];
  const q = createLiveOpeningQueue({ send: m => {
    sent.push(m);
    if (m === 'ready') q.message('during_flush');
  }, onOverflow: () => assert.fail('not overflowing') });
  q.message('first'); q.message('second');
  assert.equal(q.open('ready'), true);
  q.message('after_open');
  assert.deepEqual(sent, ['ready', 'first', 'second', 'during_flush', 'after_open']);
  q.close();
  assert.equal(q.message('after_close'), false);
  assert.equal(q.open('again'), false);
  assert.equal(sent.length, 5);
});

test('live view: run access only, each viewer its own TURN credential, closed when the attempt ends', async () => {
  const w = agentRunsWorld();
  const { call } = routed(w);
  const runId = await heldRun(w, call, w.users.operator);
  const a = await openView(w, w.users.operator, runId, 'sess-op');
  assert.match(a.viewer, /^[0-9a-f]{16}$/);
  assert.equal(a.ice_servers.length, 1);
  assert.match(a.ice_servers[0].username, new RegExp(`^[0-9]{10}:${a.viewer}$`));
  assert.deepEqual(a.ice_servers[0].urls, ['turn:turn.example.com:3478?transport=udp',
    'turn:turn.example.com:3478?transport=tcp', 'turns:turn.example.com:5349?transport=tcp']);
  // The viewer's init names only itself, the control holder and the screen.
  assert.deepEqual(Object.keys(a.received[0].payload).sort(), ['control_host', 'screen_size', 'session_id', 'webrtc']);
  assert.equal(w.service.sendLive(a.viewer, w.users.operator.id, { event: 'signal/request', payload: { video: {} } }), true);
  const provide = await until(() => a.received.find(m => m?.event === 'signal/provide'), 'provide');
  assert.equal('iceservers' in provide.payload, false);
  // Input, chat, clipboard and control requests never cross; nor does anything
  // sent on someone else's view.
  for (const bad of [{ event: 'control/move', payload: { x: 5, y: 5 } }, { event: 'control/request' },
    { event: 'chat/message', payload: { text: 'hello' } }, { event: 'signal/answer', payload: 'v=0' }])
    assert.equal(w.service.sendLive(a.viewer, w.users.operator.id, bad), false);
  assert.equal(w.service.sendLive(a.viewer, w.users.editor.id, { event: 'client/heartbeat' }), false);
  assert.deepEqual(w.supervisor.viewers.get(a.viewer).received.map(m => m.event), ['signal/request']);
  const b = await openView(w, w.users.editor, runId, 'sess-ed');
  assert.notEqual(b.ice_servers[0].credential, a.ice_servers[0].credential);
  await assert.rejects(w.service.openLive(w.users.viewer, w.p.id, runId, {}), e => e.status === 403 && e.code === 'RUN_ACCESS_DENIED');
  await assert.rejects(w.service.openLive(w.users.outsider, w.p.id, runId, {}), e => e.status === 404);
  assert.throws(() => w.service.assertLive(w.users.viewer, w.p.id, runId), e => e.status === 403);
  assert.equal(w.service.assertLive(w.users.reviewer, w.p.id, runId), true);
  const stop = await call(w.users.editor, 'POST', `/${w.p.id}/agent-runs/${runId}/stop`);
  assert.ok([200, 202].includes(stop.statusCode));
  await until(() => a.closes.includes('attempt_ended') && b.closes.includes('attempt_ended'), 'views closed');
  await w.service.settled(runId);
  assert.throws(() => w.service.assertLive(w.users.operator, w.p.id, runId), e => e.code === 'LIVE_UNAVAILABLE');
  await assert.rejects(w.service.openLive(w.users.operator, w.p.id, runId, {}), e => e.code === 'LIVE_UNAVAILABLE');
  // A supervisor that has no live desktop for this attempt says so plainly.
  const w2 = agentRunsWorld();
  const r2 = routed(w2);
  const run2 = await heldRun(w2, r2.call, w2.users.operator);
  w2.supervisor.scenario.liveError = 'LIVE_UNAVAILABLE';
  await assert.rejects(w2.service.openLive(w2.users.operator, w2.p.id, run2, {}), e => e.code === 'LIVE_UNAVAILABLE' && e.status === 409);
  await r2.call(w2.users.operator, 'POST', `/${w2.p.id}/agent-runs/${run2}/stop`);
  await w2.service.settled(run2);
});

test('takeover: session verification, the caller\'s own view, one controller, the holder ends it', async () => {
  const audit = [];
  const w = agentRunsWorld({ serviceOptions: { renewMs: 20, audit: (a, action, d) => audit.push([a?.id ?? null, action, d]) } });
  const { call } = routed(w);
  const op = session(w.users.operator, 'sess-op'), ed = session(w.users.editor, 'sess-ed');
  const runId = await heldRun(w, call, op);
  const mine = await openView(w, op, runId, 'sess-op');
  const theirs = await openView(w, ed, runId, 'sess-ed');
  const url = `/${w.p.id}/agent-runs/${runId}/takeover`;
  const unverified = await call(op, 'POST', url, { viewer: mine.viewer });
  assert.deepEqual([unverified.statusCode, unverified.body.code, unverified.body.control_verification_required],
    [401, 'CONTROL_VERIFICATION_REQUIRED', true]);
  // Control only ever goes to the caller's own view in this session.
  assert.equal((await call(ed, 'POST', url, { viewer: mine.viewer }, { verified: true })).body.code, 'TAKEOVER_VIEWER_UNKNOWN');
  assert.equal((await call(session(w.users.operator, 'sess-other'), 'POST', url, { viewer: mine.viewer }, { verified: true }))
    .body.code, 'TAKEOVER_VIEWER_UNKNOWN');
  const malformed = await call(op, 'POST', url, { viewer: 'not-a-viewer' }, { verified: true });
  assert.deepEqual([malformed.statusCode, malformed.body.code], [400, 'TAKEOVER_VIEWER_UNKNOWN']);
  assert.equal((await call(session(w.users.viewer, 'v'), 'POST', url, { viewer: mine.viewer }, { verified: true })).statusCode, 403);
  assert.equal((await call(session(w.users.outsider, 'o'), 'POST', url, { viewer: mine.viewer }, { verified: true })).statusCode, 404);
  assert.equal(w.supervisor.calls.some(c => c.method === 'takeover'), false);
  const taken = await call(op, 'POST', url, { viewer: mine.viewer }, { verified: true });
  assert.equal(taken.statusCode, 200, JSON.stringify(taken.body));
  assert.deepEqual(w.supervisor.calls.filter(c => c.method === 'takeover').map(c => c.params.conn), [mine.viewer]);
  assert.equal(taken.body.controls.takeover.enabled, false);
  assert.deepEqual([taken.body.controls.takeover.holder.user, taken.body.controls.takeover.holder.state],
    ['omar-operator', 'holding']);
  // Every open view learns who holds control (Neko's own control/host event).
  await until(() => theirs.received.some(m => m?.event === 'control/host' && m.payload.host_id === mine.viewer), 'control/host');
  // The agent's loop stopped; the backend keeps the attempt's lease alive.
  const renewsBefore = w.supervisor.calls.filter(c => c.method === 'renew').length;
  await until(() => w.supervisor.calls.filter(c => c.method === 'renew').length >= renewsBefore + 3, 'lease renewals');
  assert.equal(statusOf(w, runId).run.state, 'running');
  // One controller: a second person is refused, and cannot end someone else's.
  assert.equal((await call(ed, 'POST', url, { viewer: theirs.viewer }, { verified: true })).body.code, 'TAKEOVER_HELD');
  const notYours = await call(ed, 'POST', `${url}/end`);
  assert.deepEqual([notYours.statusCode, notYours.body.code], [403, 'TAKEOVER_NOT_YOURS']);
  const end = await call(op, 'POST', `${url}/end`);
  assert.ok([200, 202].includes(end.statusCode), JSON.stringify(end.body));
  await w.service.settled(runId);
  const done = statusOf(w, runId);
  assert.deepEqual([done.result.final_state, done.result.result_class, done.result.needs_human, done.result.receipt.verified],
    ['blocked', 'taken_over', true, true]);
  assert.deepEqual(done.takeovers.map(t => [t.user, t.state, t.end_reason, t.inputs]),
    [['omar-operator', 'ended', 'ended_by_person', { key: 3, click: 1, scroll: 2 }]]);
  assert.equal(w.supervisor.calls.find(c => c.method === 'stop').params.reason, 'taken_over');
  assert.ok(w.supervisor.calls.some(c => c.method === 'release'));
  assert.ok(done.events.some(e => e.kind === 'a7:takeover_holding') && done.events.some(e => e.kind === 'a7:takeover_ended'));
  assert.ok(done.critique.check.some(c => c.code === 'takeover'));
  assert.deepEqual(audit.filter(a => a[1].startsWith('AGENT_RUN_TAKE')).map(a => [a[0], a[1]]),
    [[w.users.operator.id, 'AGENT_RUN_TAKEN_OVER'], [w.users.operator.id, 'AGENT_RUN_TAKEOVER_ENDED']]);
  assert.deepEqual(audit.find(a => a[1] === 'AGENT_RUN_TAKEN_OVER')[2].uncontrolled_inputs, { key: 0, click: 0, scroll: 0 });
  assert.equal(audit.find(a => a[1] === 'AGENT_RUN_TAKEN_OVER')[2].password_fields_empty, true);
  // Renewal stopped with the takeover.
  const renewsAfter = w.supervisor.calls.filter(c => c.method === 'renew').length;
  await new Promise(done2 => setTimeout(done2, 80));
  assert.equal(w.supervisor.calls.filter(c => c.method === 'renew').length, renewsAfter);
  assert.equal((await call(op, 'POST', `${url}/end`)).body.code, 'TAKEOVER_NONE');
  // Resumable, as any needs-a-person run (a new linked run, decision 2).
  assert.equal(done.controls.resume.enabled, true);
});

test('takeover: the holder leaving (even after losing access) ends it; a refused hand-over stops the run', async () => {
  const w = agentRunsWorld({ serviceOptions: { renewMs: 20 } });
  const { call } = routed(w);
  const ed = session(w.users.editor, 'sess-ed');
  const runId = await heldRun(w, call, ed);
  const view = await openView(w, ed, runId, 'sess-ed');
  assert.equal((await call(ed, 'POST', `/${w.p.id}/agent-runs/${runId}/takeover`, { viewer: view.viewer },
    { verified: true })).statusCode, 200);
  // The owner removes the holder's grant; their view is closed by the route.
  const project = w.f.store.get(w.users.owner, w.p.id);
  w.f.store.remove(w.users.owner, w.p.id, w.users.editor.id, project.revision);
  w.service.closeLive(view.viewer, 'access_ended');
  await until(() => statusOf(w, runId).result, 'result');
  await w.service.settled(runId);
  const done = statusOf(w, runId);
  assert.deepEqual([done.result.result_class, done.takeovers[0].end_reason, done.takeovers[0].inputs],
    ['taken_over', 'viewer_left', { key: 3, click: 1, scroll: 2 }]);
  assert.equal(w.supervisor.calls.find(c => c.method === 'stop').params.reason, 'taken_over');

  const w2 = agentRunsWorld();
  const r2 = routed(w2);
  const op = session(w2.users.operator, 'sess-op');
  const run2 = await heldRun(w2, r2.call, op);
  const v2 = await openView(w2, op, run2, 'sess-op');
  w2.supervisor.scenario.takeoverError = 'LIVE_CONTROL_FAILED';
  const refused = await r2.call(op, 'POST', `/${w2.p.id}/agent-runs/${run2}/takeover`, { viewer: v2.viewer }, { verified: true });
  assert.deepEqual([refused.statusCode, refused.body.code, refused.body.cause], [502, 'TAKEOVER_FAILED', 'LIVE_CONTROL_FAILED']);
  await until(() => statusOf(w2, run2).result, 'result');
  await w2.service.settled(run2);
  const failed = statusOf(w2, run2);
  assert.deepEqual([failed.result.result_class, failed.result.needs_human, failed.takeovers[0].end_reason],
    ['taken_over', true, 'refused:LIVE_CONTROL_FAILED']);
});

function supervisorAccepts(facts) {
  const dir = mkdtempSync(path.join(tmpdir(), 'a7-facts-'));
  try {
    writeFileSync(path.join(dir, 'facts.json'), JSON.stringify(facts));
    const script = `import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('s', sys.argv[1])
s = importlib.util.module_from_spec(spec); spec.loader.exec_module(s)
try:
    s.validate_facts(json.load(open(sys.argv[2]))); print('accepted')
except s.Refused as e:
    print('refused', e.code, e.detail)`;
    const out = spawnSync('python3', ['-c', script, path.join(SCRIPTS, 'a3-worker-supervisor.py'), path.join(dir, 'facts.json')],
      { encoding: 'utf8', timeout: 60_000 });
    return (out.stdout || out.stderr).trim();
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('summary: written automatically with consent, from typed facts the supervisor accepts, once', async () => {
  const w = agentRunsWorld();
  const { call } = routed(w);
  const finish = async () => {
    const res = await call(w.users.operator, 'POST', `/${w.p.id}/agent-runs`, { profile_id: w.profile.id,
      credential_binding_id: w.binding.binding_id });
    const runId = res.body.run.id;
    const approval = await until(() => statusOf(w, runId).approvals.find(a => a.state === 'requested'), 'approval');
    await call(w.users.owner, 'POST', `/agent-approvals/${approval.id}`, { digest: approval.digest,
      confirmation: approval.digest.slice(0, 12) }, { sudo: true });
    await w.service.settled(runId);
    return statusOf(w, runId);
  };
  // No consent: no call, no row.
  const plain = await finish();
  assert.equal(plain.summary, null);
  assert.equal(w.supervisor.calls.some(c => c.method === 'summarize'), false);
  const profile = w.f.store.profile(w.users.owner, w.p.id, w.profile.id).profile;
  w.f.store.modelSummaryConsent(w.users.owner, w.p.id, w.profile.id, profile.revision,
    { model_summary_consent: true, reviewed_statement: SUMMARY });
  const done = await finish();
  assert.deepEqual([done.summary.state, done.summary.text, done.summary.prompt_tokens, done.summary.settled_usd],
    ['written', w.supervisor.scenario.summaryText, 310, '0.000011250']);
  const sent = w.supervisor.calls.filter(c => c.method === 'summarize');
  assert.equal(sent.length, 1);
  assert.deepEqual(Object.keys(sent[0].params).sort(), ['call_id', 'facts', 'run_id']);
  const facts = sent[0].params.facts;
  assert.deepEqual([facts.result_class, facts.final_state, facts.verified_account, facts.receipt_verified, facts.logout],
    ['verified_account', 'completed', true, true, 'done']);
  assert.ok(facts.critique.good.includes('verified_account'));
  // Nothing free-form: no digest, binding, username, URL or page claim.
  const text = JSON.stringify(facts);
  for (const needle of [w.binding.binding_id, 'a4-fixture@', 'https://', 'untrusted', done.approvals[0].digest])
    assert.equal(text.includes(needle), false, needle);
  assert.equal(supervisorAccepts(facts), 'accepted');
  // A summary is never sent twice.
  assert.equal(await w.service.summarize(done.run.id), null);
  assert.equal(w.supervisor.calls.filter(c => c.method === 'summarize').length, 1);
  assert.throws(() => w.f.db.prepare("UPDATE ops_agent_run_summaries SET summary_text='x'").run(), /immutable/);
  // A transport failure is uncertain (never retried); a refusal is recorded as one.
  w.supervisor.scenario.summaryError = 'SUPERVISOR_TIMEOUT';
  assert.equal((await finish()).summary.state, 'uncertain');
  w.supervisor.scenario.summaryError = 'BUDGET_EXHAUSTED';
  const refused = await finish();
  assert.deepEqual([refused.summary.state, refused.summary.refusal_code, refused.summary.text], ['refused', 'BUDGET_EXHAUSTED', null]);
});

test('summary facts of a taken-over practice run are accepted by the supervisor too', async () => {
  const applied = [];
  const w = agentRunsWorld({ serviceOptions: { renewMs: 20, fixtures: { apply: async mode => { applied.push(mode); } } } });
  const { call } = routed(w);
  const profile = w.f.store.profile(w.users.owner, w.p.id, w.profile.id).profile;
  w.f.store.modelSummaryConsent(w.users.owner, w.p.id, w.profile.id, profile.revision,
    { model_summary_consent: true, reviewed_statement: SUMMARY });
  const op = session(w.users.operator, 'sess-op');
  w.supervisor.scenario.holds.add('open_login');
  const res = await call(op, 'POST', `/${w.p.id}/agent-runs`, { profile_id: w.profile.id,
    credential_binding_id: w.binding.binding_id, practice: { fixture_mode: 'challenge' } });
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  const runId = res.body.run.id;
  await until(() => w.supervisor.calls.some(c => c.method === 'action' && c.params.action === 'open_login'), 'held');
  const view = await openView(w, op, runId, 'sess-op');
  await call(op, 'POST', `/${w.p.id}/agent-runs/${runId}/takeover`, { viewer: view.viewer }, { verified: true });
  await call(op, 'POST', `/${w.p.id}/agent-runs/${runId}/takeover/end`);
  await w.service.settled(runId);
  const facts = w.supervisor.calls.find(c => c.method === 'summarize').params.facts;
  assert.deepEqual([facts.practice, facts.fixture_mode, facts.expected_result, facts.takeovers.length],
    [true, 'challenge', 'challenge_required', 1]);
  assert.equal(supervisorAccepts(facts), 'accepted');
  assert.deepEqual(applied, ['challenge', 'normal']);
});

test('demo fixture writer: fixed argv, the document on stdin, byte-exact read-back', async () => {
  const calls = [];
  let stored = null, corrupt = false;
  const runHostCapture = async (bin, args, options = {}) => {
    calls.push([bin, args, options.input ?? null]);
    if (args.includes('sh')) { stored = options.input; return { status: 0, stdout: '', timedOut: false }; }
    const { createHash } = await import('node:crypto');
    const sum = createHash('sha256').update(corrupt ? 'other' : stored ?? '').digest('hex');
    return { status: 0, stdout: `${sum}  ${DEMO_FIXTURE}\n`, timedOut: false };
  };
  const writer = createDemoFixtureWriter({ runHostCapture });
  assert.deepEqual(await writer.apply('slow'), { mode: 'slow', sha256: (await import('node:crypto')).createHash('sha256')
    .update(fixtureDocument('slow')).digest('hex') });
  assert.equal(fixtureDocument('slow'), '{"v":1,"mode":"slow","injection":false}\n');
  const [bin, args, input] = calls[0];
  assert.equal(bin, 'incus');
  assert.deepEqual(args.slice(0, 5), ['exec', 'pp-fractionate-demo', '--', 'sh', '-c']);
  assert.equal(args.length, 6);
  assert.equal(args[5].includes('slow'), false);
  assert.equal(input, fixtureDocument('slow'));
  assert.deepEqual(calls[1][1], ['exec', 'pp-fractionate-demo', '--', 'sha256sum', DEMO_FIXTURE]);
  await assert.rejects(writer.apply('normal; rm -rf /'), e => e.code === 'INVALID_FIXTURE_MODE');
  assert.equal(calls.length, 2);
  corrupt = true;
  await assert.rejects(writer.apply('normal'), e => e.code === 'FIXTURE_READBACK_FAILED');
  assert.throws(() => createDemoFixtureWriter({ runHostCapture, instance: 'pp-nodus' }), e => e.code === 'FIXTURE_WRITER_INVALID');
  const failing = createDemoFixtureWriter({ runHostCapture: async () => ({ status: 1, stdout: '' }) });
  await assert.rejects(failing.apply('normal'), e => e.code === 'FIXTURE_WRITE_FAILED');
});

test('launcher: a live answer, a takeover, a release or a summary of the wrong shape is refused', async () => {
  const VM = '49592202-a8b0-45af-9ac6-5439761d73e4';
  const ref = { run_id: '5a1f2f3e-6b7c-4d8e-9f00-112233445566', attempt_id: '6b1f2f3e-6b7c-4d8e-9f00-112233445566', fence: 1 };
  let answer = null, closed = 0;
  const client = {
    request: async () => answer,
    stream: async () => ({ ...answer, send: () => true, close: () => { closed += 1; } }),
  };
  const launcher = createWorkerLauncher({ client, vmUuid: VM });
  const good = { conn: '0123456789abcdef', ttl_seconds: 3600, ice_servers: [{ urls: ['turns:turn.example.com:5349?transport=tcp'],
    username: '1790000000:0123456789abcdef', credential: `${'A'.repeat(27)}=` }] };
  answer = good;
  assert.equal((await launcher.live(ref)).viewer, '0123456789abcdef');
  // The ports are the host installer's (A7 moved off 3478/5349, which a meeting
  // service's TURN server owned on the proof host).
  answer = { ...good, ice_servers: [{ ...good.ice_servers[0], urls: ['turn:turn.example.com:3479?transport=udp',
    'turn:turn.example.com:3479?transport=tcp', 'turns:turn.example.com:5350?transport=tcp'] }] };
  assert.equal((await launcher.live(ref)).viewer, '0123456789abcdef');
  for (const bad of [{ ...good, conn: 'XYZ' },
    { ...good, ice_servers: [{ ...good.ice_servers[0], urls: ['turn:evil.example.com:80'] }] },
    { ...good, ice_servers: [{ ...good.ice_servers[0], urls: ['turns:turn.example.com:65536?transport=tcp'] }] },
    { ...good, ice_servers: [{ ...good.ice_servers[0], urls: ['turns:turn.example.com:0?transport=tcp'] }] },
    { ...good, ice_servers: [{ ...good.ice_servers[0], urls: ['turns:turn.example.com:5350?transport=udp'] }] },
    { ...good, ice_servers: [{ ...good.ice_servers[0], urls: ['stun:turn.example.com:3478'] }] },
    { ...good, ice_servers: [{ ...good.ice_servers[0], username: '1790000000:ffffffffffffffff' }] },
    { ...good, ice_servers: [{ ...good.ice_servers[0], extra: 1 }] },
    { ...good, ice_servers: [good.ice_servers[0], good.ice_servers[0]] },
    { ...good, ttl_seconds: 10 }]) {
    answer = bad;
    await assert.rejects(launcher.live(ref), e => e.code === 'SUPERVISOR_PROTOCOL');
  }
  assert.equal(closed, 10);
  const zero = { key: 0, click: 0, scroll: 0 };
  answer = { state: 'human', controlling: true, uncontrolled_inputs: zero, password_fields_empty: true };
  assert.deepEqual(await launcher.takeover(ref, '0123456789abcdef'),
    { state: 'human', password_fields_empty: true, uncontrolled_inputs: zero });
  await assert.rejects(launcher.takeover(ref, 'nope'), e => e.code === 'INVALID_TAKEOVER');
  // Without the runner's two facts (or with a field still filled) nothing is handed over.
  for (const bad of [{ state: 'running', controlling: true, uncontrolled_inputs: zero, password_fields_empty: true },
    { state: 'human', controlling: true }, { state: 'human', controlling: true, uncontrolled_inputs: zero, password_fields_empty: false },
    { state: 'human', controlling: true, uncontrolled_inputs: { key: -1, click: 0, scroll: 0 }, password_fields_empty: true }]) {
    answer = bad;
    await assert.rejects(launcher.takeover(ref, '0123456789abcdef'), e => e.code === 'SUPERVISOR_PROTOCOL');
  }
  answer = { inputs: { key: 1, click: 0, scroll: 0 } };
  assert.deepEqual(await launcher.release(ref), { inputs: { key: 1, click: 0, scroll: 0 } });
  for (const bad of [{ inputs: { key: -1, click: 0, scroll: 0 } }, { inputs: { key: 1, click: 0 } },
    { inputs: { key: 1, click: 0, scroll: 0, text: 'secret' } }, { inputs: { key: 1, click: 0, scroll: 0 }, typed: 'x' }]) {
    answer = bad;
    await assert.rejects(launcher.release(ref), e => e.code === 'SUPERVISOR_PROTOCOL');
  }
  const callId = '7c1f2f3e-6b7c-4d8e-9f00-112233445566';
  answer = { call_id: callId, text: 'Signed in.', usage: { prompt_tokens: 1, completion_tokens: 2 }, settled_usd: '0.000001000' };
  assert.equal((await launcher.summarize({ run_id: ref.run_id, call_id: callId, facts: {} })).text, 'Signed in.');
  for (const bad of [{ ...answer, call_id: ref.run_id }, { ...answer, text: '' }, { ...answer, text: 'x'.repeat(801) },
    { ...answer, text: 'line\u0007bell' }]) {
    answer = bad;
    await assert.rejects(launcher.summarize({ run_id: ref.run_id, call_id: callId, facts: {} }), e => e.code === 'SUPERVISOR_PROTOCOL');
  }
});
