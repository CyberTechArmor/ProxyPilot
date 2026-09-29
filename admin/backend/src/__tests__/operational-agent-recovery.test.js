import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixtureRouter } from './helpers/operations-fixture.js';
import { agentRunsWorld, baseRules, guideWith } from './helpers/agent-runs-world.js';
import { createOperationsRouter } from '../routes/operational-projects.js';
import { critique, reconciliationState, uncertainSubjects, EXPECTED_RESULT } from '../lib/operational-recovery.js';
import { hasControlGrant, recordControlGrant } from '../lib/operational-control-grants.js';

// A7 practice and recovery: the Start gate on uncertain writes, reconciliation,
// resume, practice runs, the rule-based critique, the coordinator's dashboard
// takeover claim, the once-per-session control grant and the summary consent.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sudo = (req, res, next) => req.sudo === true ? next() : res.status(401).json({ error: 'sudo_required', sudo_required: true });
function routed(w, options = {}) {
  const router = createOperationsRouter({ Router: fixtureRouter, store: w.f.store, enabled: true, agentsEnabled: true,
    lookupLimiter: (_r, _s, n) => n(), agentRuns: w.service, requireSudo: sudo,
    controlVerified: req => req.verified === true, ...options });
  const call = (user, method, route, body = {}, extra = {}) => router.dispatch({ method, path: route, body, user,
    headers: extra.headers ?? {}, query: {}, sudo: extra.sudo, verified: extra.verified });
  return { router, call };
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
const statusOf = (w, runId) => w.service.status(w.users.owner, w.p.id, runId);
const finished = async (w, runId) => { await w.service.settled(runId); return statusOf(w, runId); };
async function runTo(w, call, user, body = {}) {
  const res = await call(user, 'POST', `/${w.p.id}/agent-runs`, { profile_id: w.profile.id,
    credential_binding_id: w.binding.binding_id, ...body });
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  const runId = res.body.run.id;
  const approval = await until(() => { const s = statusOf(w, runId); return s.result || s.approvals.find(a => a.state === 'requested'); },
    'approval or result');
  if (!approval.result_class) {
    const ok = await call(w.users.owner, 'POST', `/agent-approvals/${approval.id}`,
      { digest: approval.digest, confirmation: approval.digest.slice(0, 12) }, { sudo: true });
    assert.equal(ok.statusCode, 200, JSON.stringify(ok.body));
  }
  return finished(w, runId);
}
function fakeFixtures({ fail = new Set() } = {}) {
  const applied = [];
  return { applied, fail, apply: async (mode) => {
    if (fail.has(mode)) { const e = new Error('FIXTURE_WRITE_FAILED'); e.code = 'FIXTURE_WRITE_FAILED'; throw e; }
    applied.push(mode);
  } };
}

test('a timed-out submit is a human decision that gates the profile until someone decides it', async () => {
  const audit = [];
  const w = agentRunsWorld({ serviceOptions: { audit: (a, action, d) => audit.push([a?.id ?? null, action, d]) } });
  const { call } = routed(w);
  w.supervisor.scenario.outcome = 'timeout';
  const done = await runTo(w, call, w.users.operator);
  assert.deepEqual([done.result.final_state, done.result.result_class, done.result.needs_human], ['failed', 'timeout', true]);
  const submit = done.steps.find(s => s.action === 'submit_bound_fixture');
  assert.deepEqual(done.reconciliation.items.map(i => [i.subject, i.kind, i.reason, i.open, i.gates]),
    [[`step:${submit.ordinal}`, 'write', 'timeout', true, true]]);
  assert.equal(done.controls.resume.enabled, false);
  assert.match(done.controls.resume.reason, /Decide the uncertain sign-in/);
  // The profile is gated, with the run named.
  const list = (await call(w.users.operator, 'GET', `/${w.p.id}/agent-runs`)).body;
  assert.equal(list.profiles[0].ready, false);
  assert.equal(list.profiles[0].reconcile_run_id, done.run.id);
  assert.ok(list.profiles[0].reasons.some(r => /may or may not have happened/.test(r)));
  w.supervisor.scenario.outcome = 'signed_in';
  const refused = await call(w.users.operator, 'POST', `/${w.p.id}/agent-runs`, { profile_id: w.profile.id,
    credential_binding_id: w.binding.binding_id });
  assert.deepEqual([refused.statusCode, refused.body.code, refused.body.run_id], [409, 'RECONCILIATION_REQUIRED', done.run.id]);
  // The inbox lists it as a gating help request.
  const inbox = (await call(w.users.reviewer, 'GET', '/agent-approvals')).body;
  assert.deepEqual(inbox.help_requests.map(h => [h.id, h.help.result_class, h.help.gating]), [[done.run.id, 'timeout', true]]);
  const url = `/${w.p.id}/agent-runs/${done.run.id}/reconcile`;
  const subject = `step:${submit.ordinal}`;
  // Without the session's verification: refused with the envelope the UI knows.
  const unverified = await call(w.users.editor, 'POST', url, { subject, decision: 'happened' });
  assert.deepEqual([unverified.statusCode, unverified.body.code, unverified.body.control_verification_required],
    [401, 'CONTROL_VERIFICATION_REQUIRED', true]);
  // A viewer and an outsider never decide.
  assert.equal((await call(w.users.viewer, 'POST', url, { subject, decision: 'happened' }, { verified: true })).statusCode, 403);
  assert.equal((await call(w.users.outsider, 'POST', url, { subject, decision: 'happened' }, { verified: true })).statusCode, 404);
  // Typed decisions only.
  assert.equal((await call(w.users.editor, 'POST', url, { subject, decision: 'acknowledged' }, { verified: true })).body.code,
    'RECONCILE_DECISION_INVALID');
  assert.equal((await call(w.users.editor, 'POST', url, { subject: 'step:99', decision: 'happened' }, { verified: true })).body.code,
    'RECONCILE_SUBJECT_UNKNOWN');
  assert.equal((await call(w.users.editor, 'POST', url, { subject, decision: 'happened', note: 'x' }, { verified: true })).statusCode, 400);
  // "unknown" is recorded and keeps the gate.
  const unknown = await call(w.users.editor, 'POST', url, { subject, decision: 'unknown' }, { verified: true });
  assert.equal(unknown.statusCode, 200);
  assert.deepEqual(unknown.body.reconciliation.items.map(i => [i.decision.decision, i.open, i.gates]), [['unknown', true, true]]);
  assert.equal((await call(w.users.operator, 'POST', `/${w.p.id}/agent-runs`, { profile_id: w.profile.id,
    credential_binding_id: w.binding.binding_id })).body.code, 'RECONCILIATION_REQUIRED');
  // The starter may decide too (decision 3); "it happened" lifts the gate.
  const decided = await call(w.users.operator, 'POST', url, { subject, decision: 'happened' }, { verified: true });
  assert.deepEqual(decided.body.reconciliation.items.map(i => [i.decision.decision, i.open, i.gates]), [['happened', false, false]]);
  assert.equal(decided.body.reconciliation.open, false);
  assert.ok(decided.body.events.some(e => e.kind === 'a7:reconciled:write:happened'));
  assert.deepEqual(audit.filter(a => a[1] === 'AGENT_RUN_RECONCILED').map(a => [a[0], a[2].decision]),
    [[w.users.editor.id, 'unknown'], [w.users.operator.id, 'happened']]);
  assert.equal((await call(w.users.reviewer, 'GET', '/agent-approvals')).body.help_requests.length, 0);
  // Nothing was re-sent: exactly one submit reached the supervisor.
  assert.equal(w.supervisor.calls.filter(c => c.method === 'action' && c.params.action === 'submit_bound_fixture').length, 1);
  const again = await runTo(w, call, w.users.operator);
  assert.equal(again.result.result_class, 'verified_account');
  // History is append-only.
  assert.throws(() => w.f.db.prepare('UPDATE ops_agent_reconciliations SET decision=?').run('did_not_happen'), /immutable/);
  assert.throws(() => w.f.db.prepare('DELETE FROM ops_agent_reconciliations').run(), /immutable/);
});

test('an uncertain read closes its help request when decided but never gates the profile', async () => {
  const w = agentRunsWorld();
  const { call } = routed(w);
  w.supervisor.scenario.actionErrors.open_login = 'SUPERVISOR_TIMEOUT';
  const done = await runTo(w, call, w.users.operator);
  assert.equal(done.result.result_class, 'uncertain_step');
  assert.deepEqual(done.reconciliation.items.map(i => [i.subject, i.kind, i.gates]), [['step:2', 'read', false]]);
  const list = (await call(w.users.operator, 'GET', `/${w.p.id}/agent-runs`)).body;
  assert.equal(list.profiles[0].reconcile_run_id, null);
  assert.equal((await call(w.users.owner, 'GET', '/agent-approvals')).body.help_requests.length, 1);
  const res = await call(w.users.owner, 'POST', `/${w.p.id}/agent-runs/${done.run.id}/reconcile`,
    { subject: 'step:2', decision: 'did_not_happen' }, { verified: true });
  assert.equal(res.body.reconciliation.open, false);
  assert.equal((await call(w.users.owner, 'GET', '/agent-approvals')).body.help_requests.length, 0);
});

test('a help request with nothing uncertain is acknowledged; resume starts a new linked run with the same pins', async () => {
  const audit = [];
  const w = agentRunsWorld({ serviceOptions: { audit: (a, action, d) => audit.push([action, d]) } });
  const { call } = routed(w);
  w.supervisor.scenario.outcome = 'challenge_required';
  const done = await runTo(w, call, w.users.operator);
  assert.equal(done.result.result_class, 'challenge_required');
  assert.deepEqual(done.reconciliation.items.map(i => [i.subject, i.kind]), [['run', 'run']]);
  assert.equal(done.controls.resume.enabled, true);
  // A run that did not need a person cannot be resumed.
  w.supervisor.scenario.outcome = 'rejected';
  const other = await runTo(w, call, w.users.operator);
  const notAllowed = await call(w.users.operator, 'POST', `/${w.p.id}/agent-runs/${other.run.id}/resume`);
  assert.deepEqual([notAllowed.statusCode, notAllowed.body.code], [409, 'RESUME_NOT_ALLOWED']);
  // Resume: a new run from step 1 in a fresh attempt, linked, with its own approval.
  w.supervisor.scenario.outcome = 'signed_in';
  assert.equal((await call(w.users.viewer, 'POST', `/${w.p.id}/agent-runs/${done.run.id}/resume`)).statusCode, 403);
  const resumed = await call(w.users.editor, 'POST', `/${w.p.id}/agent-runs/${done.run.id}/resume`);
  assert.equal(resumed.statusCode, 201, JSON.stringify(resumed.body));
  const newId = resumed.body.run.id;
  assert.notEqual(newId, done.run.id);
  assert.deepEqual([resumed.body.origin.resumed_from_run_id, resumed.body.origin.practice], [done.run.id, false]);
  assert.deepEqual([resumed.body.run.policy_digest, resumed.body.run.guide_hash, resumed.body.run.credential_binding_revision],
    [done.run.policy_digest, done.run.guide_hash, done.run.credential_binding_revision]);
  const approval = await until(() => statusOf(w, newId).approvals.find(a => a.state === 'requested'), 'approval');
  assert.notEqual(approval.attempt_id, done.approvals[0]?.attempt_id);
  await call(w.users.owner, 'POST', `/agent-approvals/${approval.id}`, { digest: approval.digest,
    confirmation: approval.digest.slice(0, 12) }, { sudo: true });
  const after = await finished(w, newId);
  assert.equal(after.result.result_class, 'verified_account');
  assert.equal(after.steps[0].action, 'open_landing');
  assert.ok(after.events.some(e => e.kind === 'a7:resumed'));
  assert.equal(after.critique.check.find(c => c.code === 'resumed_from')?.run_id, done.run.id);
  // The old run now shows where it went, is no longer an open help request, and resumes once only.
  const old = statusOf(w, done.run.id);
  assert.equal(old.origin.resumed_as_run_id, newId);
  assert.equal(old.controls.resume.enabled, false);
  assert.deepEqual((await call(w.users.owner, 'GET', '/agent-approvals')).body.help_requests, []);
  assert.equal((await call(w.users.editor, 'POST', `/${w.p.id}/agent-runs/${done.run.id}/resume`)).body.code, 'RESUME_ALREADY_STARTED');
  assert.deepEqual(audit.filter(a => a[0] === 'AGENT_RUN_RESUMED').map(a => [a[1].run_id, a[1].resumed_as]), [[done.run.id, newId]]);
  // Two launches, two distinct attempts: never the old attempt.
  const launches = w.supervisor.calls.filter(c => c.method === 'launch').map(c => c.params.attempt_id);
  assert.equal(new Set(launches).size, launches.length);
});

test('resume is refused with the reason when a pin changed', async () => {
  const w = agentRunsWorld();
  const { call } = routed(w);
  w.supervisor.scenario.outcome = 'challenge_required';
  const done = await runTo(w, call, w.users.operator);
  // A newly approved guide, reassigned: the guide pin changed.
  const version = w.approveGuide(guideWith(baseRules, ' Revised.'));
  const current = w.f.store.profile(w.users.owner, w.p.id, w.profile.id).profile;
  w.f.store.assignProfile(w.users.owner, w.p.id, w.profile.id, current.revision, { guide_version_id: version.id });
  const res = await call(w.users.operator, 'POST', `/${w.p.id}/agent-runs/${done.run.id}/resume`);
  assert.equal(res.body.code, 'RESUME_STALE');
  assert.equal(['profile_changed', 'guide_changed'].includes(res.body.stale_reason), true, res.body.stale_reason);
  assert.equal(w.supervisor.calls.filter(c => c.method === 'launch').length, 1);
});

test('practice runs: the fixture mode is set before the pin, reset after, one practice run at a time, alone', async () => {
  const fixtures = fakeFixtures();
  const audit = [];
  const w = agentRunsWorld({ serviceOptions: { fixtures, audit: (a, action, d) => audit.push([action, d]) } });
  const { call } = routed(w);
  // Unavailable without a fixture writer.
  const bare = agentRunsWorld();
  const noWriter = await routed(bare).call(bare.users.operator, 'POST', `/${bare.p.id}/agent-runs`,
    { profile_id: bare.profile.id, credential_binding_id: bare.binding.binding_id, practice: { fixture_mode: 'expired' } });
  assert.deepEqual([noWriter.statusCode, noWriter.body.code], [503, 'FIXTURE_UNAVAILABLE']);
  // A mode outside the list is refused before anything happens.
  assert.equal((await call(w.users.operator, 'POST', `/${w.p.id}/agent-runs`, { profile_id: w.profile.id,
    credential_binding_id: w.binding.binding_id, practice: { fixture_mode: 'evil' } })).statusCode, 400);
  // expired: the demo answers 401 for the synthetic account after a correct password.
  w.supervisor.scenario.outcome = 'rejected';
  const done = await runTo(w, call, w.users.operator, { practice: { fixture_mode: 'expired' } });
  assert.deepEqual(fixtures.applied, ['expired', 'normal']);
  assert.deepEqual([done.origin.practice, done.origin.fixture_mode, done.origin.expected_result], [true, 'expired', 'credential_rejected']);
  assert.ok(done.events.some(e => e.kind === 'a7:practice:expired'));
  assert.deepEqual(done.critique.good.find(g => g.code === 'practice_matched'),
    { code: 'practice_matched', fixture_mode: 'expired', expected: 'credential_rejected', actual: 'credential_rejected' });
  assert.equal(w.f.db.prepare('SELECT mode,applied,run_id FROM ops_agent_fixture_state').get().mode, 'normal');
  assert.deepEqual(audit.filter(a => a[0] === 'AGENT_PRACTICE_RUN_STARTED').map(a => a[1].fixture_mode), ['expired']);
  // The list marks it Practice.
  const list = (await call(w.users.operator, 'GET', `/${w.p.id}/agent-runs`)).body;
  assert.equal(list.runs[0].origin.practice, true);
  // A practice run runs alone: while one holds, no other run starts, and a practice run waits for the others.
  w.supervisor.scenario.outcome = 'signed_in';
  w.supervisor.scenario.holds.add('open_login');
  const practice = await call(w.users.operator, 'POST', `/${w.p.id}/agent-runs`, { profile_id: w.profile.id,
    credential_binding_id: w.binding.binding_id, practice: { fixture_mode: 'normal' } });
  assert.equal(practice.statusCode, 201);
  const second = agentRunsWorld();
  assert.equal(practice.body.origin.practice, true);
  const blocked = await call(w.users.editor, 'POST', `/${w.p.id}/agent-runs`, { profile_id: w.profile.id,
    credential_binding_id: w.binding.binding_id });
  assert.ok(['PRACTICE_ACTIVE', 'RUN_ALREADY_ACTIVE'].includes(blocked.body.code), blocked.body.code);
  const listNow = (await call(w.users.operator, 'GET', `/${w.p.id}/agent-runs`)).body;
  assert.equal(listNow.profiles[0].practice_ready, false);
  await call(w.users.operator, 'POST', `/${w.p.id}/agent-runs/${practice.body.run.id}/stop`);
  w.supervisor.release('open_login');
  await w.service.settled(practice.body.run.id);
  // The second practice run used `normal`, so nothing is left to reset after it.
  assert.deepEqual(fixtures.applied, ['expired', 'normal', 'normal']);
  second.f.close();
});

test('practice: a mode that cannot be set starts nothing; a reset that failed is retried before the next start', async () => {
  const fixtures = fakeFixtures({ fail: new Set(['locked']) });
  const w = agentRunsWorld({ serviceOptions: { fixtures } });
  const { call } = routed(w);
  const refused = await call(w.users.operator, 'POST', `/${w.p.id}/agent-runs`, { profile_id: w.profile.id,
    credential_binding_id: w.binding.binding_id, practice: { fixture_mode: 'locked' } });
  assert.deepEqual([refused.statusCode, refused.body.code], [502, 'FIXTURE_FAILED']);
  assert.equal(w.supervisor.calls.filter(c => c.method === 'launch').length, 0);
  assert.equal(w.f.db.prepare('SELECT COUNT(*) AS n FROM ops_agent_runs').get().n, 0);
  // The reset back to normal ran after the failure.
  assert.deepEqual(fixtures.applied, ['normal']);
  // A failed reset blocks the next ordinary start until a reset succeeds.
  fixtures.fail.add('normal');
  w.f.db.prepare("UPDATE ops_agent_fixture_state SET mode='challenge',applied=0").run();
  const stuck = await call(w.users.operator, 'POST', `/${w.p.id}/agent-runs`, { profile_id: w.profile.id,
    credential_binding_id: w.binding.binding_id });
  assert.deepEqual([stuck.statusCode, stuck.body.code], [409, 'FIXTURE_NOT_RESET']);
  fixtures.fail.delete('normal');
  const ok = await runTo(w, call, w.users.operator);
  assert.equal(ok.result.result_class, 'verified_account');
});

test('the rule-based critique reads typed durable state only', () => {
  const base = { run: { state: 'completed' }, model_calls: [], approvals: [] };
  const steps = [
    { ordinal: 1, action: 'open_landing', decided_by: 'rule', state: 'done', created_at: '2026-09-29T10:00:00Z', finished_at: '2026-09-29T10:00:01Z' },
    { ordinal: 2, action: 'submit_bound_fixture', decided_by: 'model', state: 'done', created_at: '2026-09-29T10:00:02Z', finished_at: '2026-09-29T10:00:12Z' },
  ];
  const good = critique({ ...base, steps, approvals: [{ state: 'consumed' }], model_calls: [{ state: 'chosen',
    prompt_tokens: 200, completion_tokens: 4, settled_usd: '0.000004' }], result: { verified_account: true,
    result_class: 'verified_account', final_state: 'completed', logout: 'done', receipt: { verified: true } } });
  assert.deepEqual(good.good.map(g => g.code), ['verified_account', 'rule_steps', 'approval_used', 'no_uncertain_steps',
    'signed_out', 'receipt_verified']);
  assert.deepEqual(good.check.map(c => c.code), ['slow_step', 'model_cost']);
  assert.equal(good.check[1].tokens, 204);
  const bad = critique({ ...base, steps: [{ ...steps[0], state: 'uncertain' }], approvals: [{ state: 'stale', stale_reason: 'binding_revoked' }],
    model_calls: [{ state: 'refused', refusal_code: 'BUDGET_EXHAUSTED' }], origin: { practice: true, fixture_mode: 'locked' },
    result: { verified_account: false, result_class: 'budget_exhausted', final_state: 'blocked', logout: 'failed', receipt: { verified: true } } });
  assert.deepEqual(bad.bad.map(b => b.code), ['result', 'approval_stale', 'uncertain_steps', 'model_call_refused', 'sign_out_failed',
    'practice_mismatch']);
  assert.equal(bad.bad.at(-1).expected, EXPECTED_RESULT.locked);
  assert.equal(JSON.stringify([good, bad]).includes('Ignore'), false);
  assert.deepEqual(critique({ ...base, run: { state: 'running' }, steps, result: null }).check, [{ code: 'still_running', state: 'running' }]);
  // Uncertain subjects and the latest decision.
  const subjects = uncertainSubjects({ steps: [{ ordinal: 3, action: 'sign_out', state: 'uncertain', error_code: 'COORDINATOR_RESTART' }],
    model_calls: [{ call_id: '11111111-1111-4111-8111-111111111111', state: 'uncertain', refusal_code: 'CALL_UNCERTAIN' }], result: null });
  const state = reconciliationState(subjects, [
    { subject: 'step:3', decision: 'did_not_happen', decided_by: 'a', decided_at: '2026-09-29T10:00:00Z' },
    { subject: 'step:3', decision: 'unknown', decided_by: 'b', decided_at: '2026-09-29T10:05:00Z' }]);
  assert.deepEqual(state.items.map(i => [i.subject, i.kind, i.decision?.decision ?? null, i.gates]),
    [['step:3', 'write', 'unknown', true], ['call:11111111-1111-4111-8111-111111111111', 'model_call', null, false]]);
});

test('dashboard takeover claim: one controller, the loop stops, the run ends taken_over with the taken_over stop reason', async () => {
  const w = agentRunsWorld();
  const { call } = routed(w);
  const start = await call(w.users.operator, 'POST', `/${w.p.id}/agent-runs`, { profile_id: w.profile.id,
    credential_binding_id: w.binding.binding_id });
  const runId = start.body.run.id;
  const approval = await until(() => statusOf(w, runId).approvals.find(a => a.state === 'requested'), 'approval');
  assert.throws(() => w.coordinator.beginTakeover(w.users.viewer, runId), /RUN_ACCESS_DENIED/);
  const claim = w.coordinator.beginTakeover(w.users.editor, runId);
  assert.equal(claim.ref.run_id, runId);
  assert.throws(() => w.coordinator.beginTakeover(w.users.operator, runId), /TAKEOVER_HELD/);
  // The open approval is closed: approving it now changes nothing.
  const stale = statusOf(w, runId).approvals.find(a => a.id === approval.id);
  assert.deepEqual([stale.state, stale.stale_reason], ['stale', 'taken_over']);
  w.coordinator.holdTakeover(claim.takeover_id);
  await assert.rejects(w.coordinator.endTakeover(w.users.operator, runId), /TAKEOVER_NOT_YOURS/);
  const result = await w.coordinator.endTakeover(w.users.editor, runId,
    { reason: 'ended_by_person', inputs: { key: 12, click: 3, scroll: 1 } });
  assert.deepEqual([result.final_state, result.result_class, result.needs_human], ['blocked', 'taken_over', 1]);
  await w.service.settled(runId);
  const done = statusOf(w, runId);
  assert.deepEqual(done.takeovers.map(t => [t.user, t.state, t.end_reason, t.inputs]),
    [['edie-editor', 'ended', 'ended_by_person', { key: 12, click: 3, scroll: 1 }]]);
  // No submit happened; the stop carried the taken_over reason.
  assert.equal(w.supervisor.calls.some(c => c.method === 'action' && c.params.action === 'submit_bound_fixture'), false);
  assert.deepEqual(w.supervisor.calls.filter(c => c.method === 'stop').map(c => c.params.reason), ['taken_over']);
  assert.ok(done.events.some(e => e.kind === 'a7:takeover_requested') && done.events.some(e => e.kind === 'a7:takeover_ended'));
  assert.equal(done.critique.check.find(c => c.code === 'takeover').inputs.key, 12);
  assert.throws(() => w.f.db.prepare("UPDATE ops_agent_takeovers SET inputs_json='{}'").run(), /immutable/);
  // Stop ends a held takeover too.
  const w2 = agentRunsWorld();
  const r2 = routed(w2);
  const s2 = await r2.call(w2.users.operator, 'POST', `/${w2.p.id}/agent-runs`, { profile_id: w2.profile.id,
    credential_binding_id: w2.binding.binding_id });
  await until(() => statusOf(w2, s2.body.run.id).approvals.find(a => a.state === 'requested'), 'approval');
  w2.coordinator.beginTakeover(w2.users.operator, s2.body.run.id);
  await r2.call(w2.users.owner, 'POST', `/${w2.p.id}/agent-runs/${s2.body.run.id}/stop`);
  await w2.service.settled(s2.body.run.id);
  assert.equal(statusOf(w2, s2.body.run.id).takeovers[0].state, 'ended');
});

test('the agent-control grant is per session, per user, and ends with the session; it is never sudo', () => {
  const w = agentRunsWorld();
  const db = w.f.db;
  const future = new Date(Date.now() + 3600_000).toISOString();
  db.prepare('INSERT INTO sessions(id,user_id,expires_at,revoked_at) VALUES(?,?,?,NULL)').run('s-live', w.users.operator.id, future);
  db.prepare('INSERT INTO sessions(id,user_id,expires_at,revoked_at) VALUES(?,?,?,NULL)').run('s-old', w.users.operator.id, '2020-01-01T00:00:00Z');
  db.prepare('INSERT INTO sessions(id,user_id,expires_at,revoked_at) VALUES(?,?,?,?)').run('s-revoked', w.users.operator.id, future, future);
  assert.equal(hasControlGrant(db, { sessionId: 's-live', userId: w.users.operator.id }), false);
  for (const id of ['s-live', 's-old', 's-revoked']) recordControlGrant(db, { sessionId: id, userId: w.users.operator.id, factor: 'totp' });
  assert.equal(hasControlGrant(db, { sessionId: 's-live', userId: w.users.operator.id }), true);
  assert.equal(hasControlGrant(db, { sessionId: 's-live', userId: w.users.editor.id }), false);
  assert.equal(hasControlGrant(db, { sessionId: 's-old', userId: w.users.operator.id }), false);
  assert.equal(hasControlGrant(db, { sessionId: 's-revoked', userId: w.users.operator.id }), false);
  assert.equal(hasControlGrant(db, { sessionId: 'none', userId: w.users.operator.id }), false);
  assert.throws(() => recordControlGrant(db, { sessionId: 's-live', userId: w.users.operator.id, factor: 'sms' }), /INVALID_CONTROL_GRANT/);
  // The verification route never writes sudo_until (a separate route file from the sudo handlers).
  const source = readFileSync(path.join(HERE, '..', 'routes', 'agent-control-auth.js'), 'utf8');
  assert.doesNotMatch(source, /sudo_until/);
  assert.match(source, /recordControlGrant/);
});

test('model summary consent: owner only, typed statement, not part of the run policy (no revision bump)', async () => {
  const w = agentRunsWorld();
  const { call } = routed(w);
  const url = `/${w.p.id}/agent-profiles/${w.profile.id}/model-summary-consent`;
  const before = w.f.store.profile(w.users.owner, w.p.id, w.profile.id).profile;
  assert.equal(before.model_summary_consent, false);
  const etag = { headers: { 'if-match': `"${before.revision}"` } };
  assert.equal((await call(w.users.editor, 'PUT', url, { model_summary_consent: true,
    reviewed_statement: "Send this profile's finished runs, as typed facts, to the model provider for a summary" }, etag)).statusCode, 403);
  assert.equal((await call(w.users.owner, 'PUT', url, { model_summary_consent: true }, etag)).statusCode, 400);
  const ok = await call(w.users.owner, 'PUT', url, { model_summary_consent: true,
    reviewed_statement: "Send this profile's finished runs, as typed facts, to the model provider for a summary" }, etag);
  assert.equal(ok.statusCode, 200, JSON.stringify(ok.body));
  assert.deepEqual([ok.body.profile.model_summary_consent, ok.body.profile.revision], [true, before.revision]);
});

test('ratchet: no MCP tool, catalog entry or policy file reaches resume, reconciliation, takeover, practice or agent control', () => {
  const root = path.join(HERE, '..');
  const files = [];
  const walk = (dir) => { for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p); else if (/\.(js|json)$/.test(e.name)) files.push(p);
  } };
  for (const dir of ['routes/mcp-tools', 'lib/mcp-ext', 'lib/mcp-policy']) walk(path.join(root, dir));
  files.push(path.join(root, 'routes', 'mcp.js'), path.join(root, 'lib', 'mcp-logic.js'));
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const needle of ['agent-runs', 'agentRuns', '/reconcile', 'resumed_from', 'beginTakeover', 'endTakeover', 'agent-control',
      'ops_agent_takeovers', 'ops_agent_reconciliations', 'ops_agent_control_grants', 'fixture_mode', 'model-summary-consent'])
      assert.equal(text.includes(needle), false, `${path.relative(root, file)} mentions ${needle}`);
  }
});
