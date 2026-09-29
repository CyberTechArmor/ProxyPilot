import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { fixtureRouter } from './helpers/operations-fixture.js';
import { agentRunsWorld, baseRules, guideWith, CONSENT, VM } from './helpers/agent-runs-world.js';
import { createOperationsRouter } from '../routes/operational-projects.js';
import { agentRunsConfiguration, createAgentRunRuntime } from '../lib/operational-agent-runtime.js';
import { createAgentRunService, digestConfirmation } from '../lib/operational-agent-runs.js';
import { createRunCoordinator } from '../lib/operational-run-coordinator.js';

const sudo = (req, res, next) => req.sudo === true ? next()
  : res.status(401).json({ error: 'sudo_required', sudo_required: true });
function routed(w, options = {}) {
  const router = createOperationsRouter({ Router: fixtureRouter, store: w.f.store, enabled: true, agentsEnabled: true,
    lookupLimiter: (_r, _s, n) => n(), agentRuns: w.service, requireSudo: sudo, ...options });
  const call = (user, method, path, body = {}, extra = {}) =>
    router.dispatch({ method, path, body, user, headers: extra.headers ?? {}, query: extra.query ?? {}, sudo: extra.sudo });
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
const pendingApproval = (w, runId) => until(() => statusOf(w, runId).approvals.find(a => a.state === 'requested'), 'approval');
const finished = async (w, runId) => { await w.service.settled(runId); return statusOf(w, runId); };
const leaks = (body) => {
  const text = JSON.stringify(body);
  for (const needle of ['a3r1.', 'attestation', 'Ignore the rules', 'untrusted_', 'policy_json', 'claims_json',
    'vault_path', 'provider_response_id', 'chatcmpl'])
    assert.equal(text.includes(needle), false, `response leaks ${needle}`);
};

test('flags: agent-run routes answer 404 unless Operations, agent metadata and the A6 service are on', async () => {
  const w = agentRunsWorld();
  const off = routed(w, { agentRuns: null });
  assert.equal((await off.call(w.users.owner, 'GET', '/capabilities')).body.agent_runs_enabled, false);
  for (const [method, path] of [['GET', `/${w.p.id}/agent-runs`], ['POST', `/${w.p.id}/agent-runs`], ['GET', '/agent-approvals'],
    ['POST', `/agent-approvals/${w.p.id}`], ['GET', `/${w.p.id}/agent-profiles/${w.profile.id}/rules`],
    ['PUT', `/${w.p.id}/agent-profiles/${w.profile.id}/model-guide-consent`]])
    assert.equal((await off.call(w.users.owner, method, path)).statusCode, 404, `${method} ${path}`);
  const noMetadata = routed(w, { agentsEnabled: false });
  assert.equal((await noMetadata.call(w.users.owner, 'GET', `/${w.p.id}/agent-runs`)).statusCode, 404);
  const on = routed(w);
  const caps = (await on.call(w.users.owner, 'GET', '/capabilities')).body;
  assert.deepEqual([caps.agent_runs_enabled, caps.agent_execution_available], [true, true]);
  // The manual-run routes are untouched and distinct.
  assert.equal((await on.call(w.users.owner, 'GET', `/${w.p.id}/runs`)).statusCode, 200);
});

test('configuration: execution needs the supervisor configured; without it EXECUTION_UNAVAILABLE, never a launch', async () => {
  // Whether agent runs exist at all is the administrators' toggle (operations-toggles.test.js);
  // the environment only names the supervisor socket, its key and the VM.
  const flags = {};
  assert.deepEqual(agentRunsConfiguration({}), { enabled: true, execution: null, reason: 'not_configured' });
  assert.deepEqual(agentRunsConfiguration({ OPERATIONS_AGENT_RUNS_ENABLED: 'true' }), { enabled: true, execution: null, reason: 'not_configured' });
  assert.equal(agentRunsConfiguration({ ...flags, OPERATIONS_AGENT_SUPERVISOR_SOCKET: '/run/x.sock' }).reason, 'invalid_configuration');
  assert.equal(agentRunsConfiguration({ ...flags, OPERATIONS_AGENT_SUPERVISOR_SOCKET: 'relative.sock',
    OPERATIONS_AGENT_SUPERVISOR_PUBLIC_KEY: '/k.pem', OPERATIONS_AGENT_VM_UUID: VM }).reason, 'invalid_configuration');
  const full = agentRunsConfiguration({ ...flags, OPERATIONS_AGENT_SUPERVISOR_SOCKET: '/run/proxypilot-a3/supervisor.sock',
    OPERATIONS_AGENT_SUPERVISOR_PUBLIC_KEY: '/etc/pub.pem', OPERATIONS_AGENT_VM_UUID: VM });
  assert.deepEqual(full.execution, { socket: '/run/proxypilot-a3/supervisor.sock', publicKeyPath: '/etc/pub.pem', vmUuid: VM });
  const w = agentRunsWorld({ execution: false });
  assert.equal(createAgentRunRuntime(agentRunsConfiguration({}), { db: w.f.db }).execution.reason, 'not_configured');
  const pem = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' });
  assert.equal(createAgentRunRuntime(full, { db: w.f.db, readFile: () => pem }).execution.available, true);
  assert.equal(createAgentRunRuntime(full, { db: w.f.db, readFile: () => 'not a key' }).execution.reason, 'invalid_configuration');
  const service = createAgentRunRuntime(agentRunsConfiguration(flags), { db: w.f.db });
  const { call } = routed(w, { agentRuns: service });
  const list = await call(w.users.operator, 'GET', `/${w.p.id}/agent-runs`);
  assert.equal(list.statusCode, 200);
  assert.equal(list.body.execution.available, false);
  assert.equal(list.body.profiles[0].ready, false);
  assert.match(list.body.profiles[0].reasons[0], /no worker supervisor is configured/);
  const start = await call(w.users.operator, 'POST', `/${w.p.id}/agent-runs`, { profile_id: w.profile.id });
  assert.deepEqual([start.statusCode, start.body.code, start.body.reason], [503, 'EXECUTION_UNAVAILABLE', 'not_configured']);
  const approve = await call(w.users.operator, 'POST', `/agent-approvals/${w.p.id}`, {}, { sudo: true });
  assert.equal(approve.statusCode, 400);
  assert.equal(w.supervisor.calls.length, 0);
  assert.equal(w.f.db.prepare('SELECT COUNT(*) AS n FROM ops_agent_runs').get().n, 0);
});

test('roles: run roles see and start runs; a viewer is refused with the reason; an outsider gets 404; denials are audited', async () => {
  const w = agentRunsWorld();
  const { call } = routed(w);
  for (const role of ['owner', 'operator', 'editor', 'reviewer']) {
    const list = await call(w.users[role], 'GET', `/${w.p.id}/agent-runs`);
    assert.equal(list.statusCode, 200, role);
    assert.equal(list.body.own_role, role);
    assert.equal(list.body.profiles[0].ready, true, `${role}: ${list.body.profiles[0].reasons}`);
    assert.equal(list.body.profiles[0].binding.username, 'a4-fixture@demo.fractionate.ai');
  }
  const viewer = await call(w.users.viewer, 'GET', `/${w.p.id}/agent-runs`);
  assert.deepEqual([viewer.statusCode, viewer.body.code], [403, 'RUN_ACCESS_DENIED']);
  assert.match(viewer.body.error, /owner, operator, editor or reviewer/);
  const viewerStart = await call(w.users.viewer, 'POST', `/${w.p.id}/agent-runs`, { profile_id: w.profile.id });
  assert.equal(viewerStart.statusCode, 403);
  const outsider = await call(w.users.outsider, 'GET', `/${w.p.id}/agent-runs`);
  assert.equal(outsider.statusCode, 404);
  assert.equal((await call(w.users.outsider, 'GET', `/${w.p.id}/agent-profiles/${w.profile.id}/rules`)).statusCode, 404);
  // Reading the parsed rules is a read of the approved guide: a viewer may.
  const rules = await call(w.users.viewer, 'GET', `/${w.p.id}/agent-profiles/${w.profile.id}/rules`);
  assert.deepEqual([rules.statusCode, rules.body.rules.approval_required, rules.body.refusal],
    [200, ['submit_bound_fixture'], null]);
  const denials = w.f.db.prepare('SELECT action,status FROM ops_agent_denials ORDER BY id').all().map(d => `${d.action}:${d.status}`);
  assert.deepEqual(denials, ['agent_runs_read:403', 'agent_run_start:403', 'agent_runs_read:404', 'profile_rules_read:404']);
  assert.equal(w.supervisor.calls.length, 0);
});

test('one supervised run: start, rule and model steps, approval with sudo and a typed digest prefix, verified result', async () => {
  const w = agentRunsWorld();
  const { call } = routed(w);
  const started = await call(w.users.operator, 'POST', `/${w.p.id}/agent-runs`,
    { profile_id: w.profile.id, credential_binding_id: w.binding.binding_id });
  assert.equal(started.statusCode, 201);
  const runId = started.body.run.id;
  assert.equal(started.body.run.started_by.username, 'omar-operator');
  const duplicate = await call(w.users.owner, 'POST', `/${w.p.id}/agent-runs`, { profile_id: w.profile.id });
  assert.deepEqual([duplicate.statusCode, duplicate.body.code, duplicate.body.active_run_id], [409, 'RUN_ALREADY_ACTIVE', runId]);
  const approval = await pendingApproval(w, runId);
  assert.equal(approval.action, 'submit_bound_fixture');
  assert.equal(approval.open, true);
  for (const field of ['run_id', 'attempt_id', 'fence', 'binding_id', 'binding_revision', 'guide_hash', 'policy_digest', 'origin'])
    assert.notEqual(approval[field], undefined, field);
  // The inbox: every run role sees it; a viewer and an outsider do not.
  for (const role of ['owner', 'operator', 'editor', 'reviewer'])
    assert.deepEqual((await call(w.users[role], 'GET', '/agent-approvals')).body.approvals.map(a => a.id), [approval.id], role);
  for (const role of ['viewer', 'outsider'])
    assert.deepEqual((await call(w.users[role], 'GET', '/agent-approvals')).body.approvals, [], role);
  const path = `/agent-approvals/${approval.id}`;
  const body = { digest: approval.digest, confirmation: approval.digest.slice(0, 12) };
  const noSudo = await call(w.users.reviewer, 'POST', path, body);
  assert.deepEqual([noSudo.statusCode, noSudo.body.sudo_required], [401, true]);
  const short = await call(w.users.reviewer, 'POST', path, { ...body, confirmation: approval.digest.slice(0, 11) }, { sudo: true });
  assert.deepEqual([short.statusCode, short.body.code], [400, 'APPROVAL_CONFIRMATION_MISMATCH']);
  const wrong = await call(w.users.reviewer, 'POST', path, { ...body, confirmation: 'f'.repeat(12) }, { sudo: true });
  assert.equal(wrong.body.code, 'APPROVAL_CONFIRMATION_MISMATCH');
  const other = await call(w.users.reviewer, 'POST', path, { digest: 'e'.repeat(64), confirmation: 'e'.repeat(12) }, { sudo: true });
  assert.deepEqual([other.statusCode, other.body.code], [409, 'APPROVAL_DIGEST_MISMATCH']);
  const viewer = await call(w.users.viewer, 'POST', path, body, { sudo: true });
  assert.equal(viewer.statusCode, 403);
  const outsider = await call(w.users.outsider, 'POST', path, body, { sudo: true });
  assert.deepEqual([outsider.statusCode, outsider.body.code], [404, 'APPROVAL_UNKNOWN']);
  assert.equal(statusOf(w, runId).approvals[0].state, 'requested');
  // 13 characters, capitals and spaces are all a correct human answer (A5 lesson).
  const typed = approval.digest.slice(0, 13).toUpperCase().replace(/(.{4})/g, '$1 ');
  const approved = await call(w.users.reviewer, 'POST', path, { ...body, confirmation: typed }, { sudo: true });
  assert.deepEqual([approved.statusCode, approved.body.approval.state], [200, 'approved']);
  const again = await call(w.users.reviewer, 'POST', path, body, { sudo: true });
  assert.deepEqual([again.statusCode, again.body.code], [409, 'APPROVAL_NOT_PENDING']);
  const done = await finished(w, runId);
  assert.deepEqual([done.run.state, done.result.result_class, done.result.verified_account, done.result.logout],
    ['completed', 'verified_account', true, 'done']);
  assert.deepEqual(done.result.receipt, { verified: true, key_id: w.supervisor.keyId });
  assert.deepEqual(done.steps.map(s => `${s.ordinal}:${s.action}:${s.decided_by}:${s.rule ?? '-'}:${s.state}`), [
    '1:open_landing:rule:start:done', '2:open_login:rule:start:done', '3:submit_bound_fixture:model:-:done',
    '4:read_session:rule:verify_account:done', '5:read_files:model:-:done', '6:sign_out:rule:finish:done']);
  assert.deepEqual(done.steps[2].claims, { as_bound_account: true, outcome: 'signed_in', login_requests: 1 });
  assert.deepEqual(done.model_calls.map(c => [c.state, c.choice, c.allowed.length, c.settled_usd]), [
    ['chosen', 'submit_bound_fixture', 3, '0.000004625'], ['chosen', 'read_files', 2, '0.000004625']]);
  assert.deepEqual(done.approvals.map(a => [a.state, a.decided_by.username, a.open]), [['consumed', 'rita-reviewer', false]]);
  assert.deepEqual([done.controls.stop.enabled, done.controls.view.enabled], [false, false]);
  const read = await call(w.users.editor, 'GET', `/${w.p.id}/agent-runs/${runId}`);
  assert.equal(read.statusCode, 200);
  leaks(read.body);
  const list = await call(w.users.editor, 'GET', `/${w.p.id}/agent-runs`);
  assert.deepEqual(list.body.runs.map(r => [r.id, r.result_class, r.needs_human]), [[runId, 'verified_account', false]]);
  leaks(list.body);
  assert.equal(w.supervisor.calls.filter(c => c.method === 'action' && c.params.action === 'submit_bound_fixture').length, 1);
});

test('the starter may approve their own run (user decision 3); digest confirmation accepts every correct prefix', async () => {
  const digest = 'ab'.repeat(32);
  for (const typed of [digest.slice(0, 12), digest.slice(0, 13), digest, ` ${digest.slice(0, 20).toUpperCase()} `, 'abab abab abab'])
    assert.equal(digestConfirmation(digest, typed), true, typed);
  for (const typed of ['', digest.slice(0, 11), 'ba'.repeat(6), `${digest}0`, 'abababababaz', null])
    assert.equal(digestConfirmation(digest, typed), false, String(typed));
  const w = agentRunsWorld();
  const { call } = routed(w);
  const runId = (await call(w.users.operator, 'POST', `/${w.p.id}/agent-runs`, { profile_id: w.profile.id,
    credential_binding_id: w.binding.binding_id })).body.run.id;
  const approval = await pendingApproval(w, runId);
  const approved = await call(w.users.operator, 'POST', `/agent-approvals/${approval.id}`,
    { digest: approval.digest, confirmation: approval.digest }, { sudo: true });
  assert.equal(approved.statusCode, 200);
  assert.equal((await finished(w, runId)).result.result_class, 'verified_account');
});

test('stop mid-run: the fence holds, the receipt is verified, and nothing further happens', async () => {
  const w = agentRunsWorld();
  const { call } = routed(w);
  w.supervisor.scenario.holds.add('open_login');
  const runId = (await call(w.users.operator, 'POST', `/${w.p.id}/agent-runs`, { profile_id: w.profile.id,
    credential_binding_id: w.binding.binding_id })).body.run.id;
  await until(() => statusOf(w, runId).steps.some(s => s.action === 'open_login'), 'step reserved');
  const viewer = await call(w.users.viewer, 'POST', `/${w.p.id}/agent-runs/${runId}/stop`);
  assert.equal(viewer.statusCode, 403);
  const stopped = await call(w.users.editor, 'POST', `/${w.p.id}/agent-runs/${runId}/stop`);
  assert.ok([200, 202].includes(stopped.statusCode));
  const done = await finished(w, runId);
  assert.deepEqual([done.run.state, done.result.result_class, done.result.receipt.verified], ['cancelled', 'cancelled', true]);
  assert.equal(done.steps.at(-1).action, 'open_login');
  assert.equal(w.supervisor.calls.filter(c => c.method === 'action' && c.params.action === 'submit_bound_fixture').length, 0);
  const late = await call(w.users.editor, 'POST', `/${w.p.id}/agent-runs/${runId}/stop`);
  assert.deepEqual([late.statusCode, late.body.stopping, late.body.run.state], [200, false, 'cancelled']);
});

test('a stop whose receipt did not arrive stays fenced and can be retried; the run never resumes', async () => {
  const w = agentRunsWorld();
  const { call } = routed(w);
  w.supervisor.scenario.holds.add('open_login');
  const runId = (await call(w.users.operator, 'POST', `/${w.p.id}/agent-runs`, { profile_id: w.profile.id,
    credential_binding_id: w.binding.binding_id })).body.run.id;
  await until(() => statusOf(w, runId).steps.length === 2, 'step reserved');
  w.supervisor.scenario.stopError = 'SUPERVISOR_UNREACHABLE';
  const first = await call(w.users.operator, 'POST', `/${w.p.id}/agent-runs/${runId}/stop`);
  assert.deepEqual([first.statusCode, first.body.code], [503, 'SUPERVISOR_UNREACHABLE']);
  assert.match(first.body.error, /Stop again retries/);
  await until(() => statusOf(w, runId).run.state === 'cancelling', 'fenced');
  const stuck = statusOf(w, runId);
  assert.deepEqual(stuck.controls.stop, { enabled: true, reason: null, retry: true });
  assert.equal(stuck.result, null);
  const again = await call(w.users.operator, 'POST', `/${w.p.id}/agent-runs/${runId}/stop`);
  assert.equal(again.statusCode, 200);
  const done = await finished(w, runId);
  assert.deepEqual([done.run.state, done.result.result_class, done.result.receipt.verified], ['cancelled', 'cancelled', true]);
  assert.equal(w.supervisor.calls.filter(c => c.params?.action === 'submit_bound_fixture').length, 0);
});

test('approval racing a stop: stop then approve is refused; approve then stop never submits', async () => {
  for (const order of ['stop_first', 'approve_first']) {
    const w = agentRunsWorld();
    const { call } = routed(w);
    const runId = (await call(w.users.operator, 'POST', `/${w.p.id}/agent-runs`, { profile_id: w.profile.id,
      credential_binding_id: w.binding.binding_id })).body.run.id;
    const approval = await pendingApproval(w, runId);
    w.supervisor.scenario.holds.add('submit_bound_fixture');
    const approve = () => call(w.users.owner, 'POST', `/agent-approvals/${approval.id}`,
      { digest: approval.digest, confirmation: approval.digest.slice(0, 12) }, { sudo: true });
    const stop = () => call(w.users.operator, 'POST', `/${w.p.id}/agent-runs/${runId}/stop`);
    if (order === 'stop_first') {
      await stop();
      const refused = await approve();
      assert.deepEqual([refused.statusCode, refused.body.code, refused.body.stale_reason], [409, 'APPROVAL_NOT_PENDING', 'run_stopping']);
    } else {
      assert.equal((await approve()).statusCode, 200);
      await stop();
    }
    const done = await finished(w, runId);
    assert.equal(done.run.state, 'cancelled', order);
    assert.equal(done.steps.filter(s => s.action === 'submit_bound_fixture' && s.state === 'done').length, 0, order);
    const delivered = w.supervisor.calls.filter(c => c.method === 'action' && c.params.action === 'submit_bound_fixture');
    assert.ok(delivered.length <= 1, order);
    assert.notEqual(done.result.submit_outcome, 'signed_in', order);
  }
});

test('stale approvals: a rotated or revoked binding and a newly approved guide close the approval as stale', async () => {
  for (const change of ['rotate', 'revoke', 'guide']) {
    const w = agentRunsWorld();
    const { call } = routed(w);
    const runId = (await call(w.users.operator, 'POST', `/${w.p.id}/agent-runs`, { profile_id: w.profile.id,
      credential_binding_id: w.binding.binding_id })).body.run.id;
    const approval = await pendingApproval(w, runId);
    if (change === 'rotate') w.bindings.rotate(w.users.owner, { binding_id: w.binding.binding_id, expected_revision: 1, vault_version: 2 });
    if (change === 'revoke') w.bindings.revoke(w.users.owner, { binding_id: w.binding.binding_id });
    if (change === 'guide') w.approveGuide(guideWith(baseRules, ' Revised.'));
    const refused = await call(w.users.owner, 'POST', `/agent-approvals/${approval.id}`,
      { digest: approval.digest, confirmation: approval.digest.slice(0, 12) }, { sudo: true });
    assert.deepEqual([refused.statusCode, refused.body.code], [409, 'APPROVAL_STALE'], change);
    assert.equal(refused.body.stale_reason, change === 'revoke' ? 'binding_revoked' : 'state_changed', change);
    const done = await finished(w, runId);
    assert.deepEqual([done.run.state, done.result.result_class], ['blocked', 'approval_stale'], change);
    assert.equal(done.approvals[0].open, false);
    assert.equal(w.supervisor.calls.filter(c => c.params?.action === 'submit_bound_fixture').length, 0, change);
  }
});

test('a removed grant stops observing and approving at the next request', async () => {
  const w = agentRunsWorld();
  const { call } = routed(w);
  const runId = (await call(w.users.operator, 'POST', `/${w.p.id}/agent-runs`, { profile_id: w.profile.id,
    credential_binding_id: w.binding.binding_id })).body.run.id;
  const approval = await pendingApproval(w, runId);
  const frame = await call(w.users.operator, 'GET', `/${w.p.id}/agent-runs/${runId}/view`);
  assert.equal(frame.statusCode, 200);
  assert.equal(Buffer.from(frame.body.frame.png_base64, 'base64').subarray(1, 4).toString(), 'PNG');
  assert.deepEqual(Object.keys(frame.body.frame).sort(), ['action_count', 'captured_at', 'height', 'png_base64', 'width']);
  w.f.store.remove(w.users.owner, w.p.id, w.users.operator.id, w.f.store.get(w.users.owner, w.p.id).revision);
  for (const path of [`/${w.p.id}/agent-runs/${runId}/view`, `/${w.p.id}/agent-runs/${runId}`, `/${w.p.id}/agent-runs`])
    assert.equal((await call(w.users.operator, 'GET', path)).statusCode, 404, path);
  const approve = await call(w.users.operator, 'POST', `/agent-approvals/${approval.id}`,
    { digest: approval.digest, confirmation: approval.digest.slice(0, 12) }, { sudo: true });
  assert.deepEqual([approve.statusCode, approve.body.code], [404, 'APPROVAL_UNKNOWN']);
  assert.deepEqual((await call(w.users.operator, 'GET', '/agent-approvals')).body.approvals, []);
  assert.equal(statusOf(w, runId).approvals[0].state, 'requested');
  await call(w.users.owner, 'POST', `/${w.p.id}/agent-runs/${runId}/stop`);
  await finished(w, runId);
});

test('view: pixels only, one supervisor call per moment, and a typed reason when there is no browser', async () => {
  const w = agentRunsWorld({ serviceOptions: { frameMs: 60_000 } });
  const { call } = routed(w);
  w.supervisor.scenario.holds.add('open_login');
  const runId = (await call(w.users.operator, 'POST', `/${w.p.id}/agent-runs`, { profile_id: w.profile.id,
    credential_binding_id: w.binding.binding_id })).body.run.id;
  await until(() => statusOf(w, runId).run.state === 'running', 'running');
  const frames = await Promise.all([1, 2, 3].map(() => call(w.users.reviewer, 'GET', `/${w.p.id}/agent-runs/${runId}/view`)));
  assert.deepEqual(frames.map(f => f.statusCode), [200, 200, 200]);
  assert.equal(w.supervisor.calls.filter(c => c.method === 'view').length, 1);
  const attempt = w.f.db.prepare('SELECT id,fence FROM ops_agent_worker_attempts WHERE run_id=?').get(runId);
  assert.deepEqual(w.supervisor.calls.find(c => c.method === 'view').params,
    { run_id: runId, attempt_id: attempt.id, fence: attempt.fence });
  assert.equal((await call(w.users.viewer, 'GET', `/${w.p.id}/agent-runs/${runId}/view`)).statusCode, 403);
  await call(w.users.operator, 'POST', `/${w.p.id}/agent-runs/${runId}/stop`);
  await finished(w, runId);
  const gone = await call(w.users.operator, 'GET', `/${w.p.id}/agent-runs/${runId}/view`);
  assert.deepEqual([gone.statusCode, gone.body.code], [409, 'VIEW_UNAVAILABLE']);
  assert.match(gone.body.error, /not running/);
});

test('each outcome class, uncertainty and takeover become a durable result; help requests reach the inbox', async () => {
  const cases = [
    [{ outcome: 'rejected' }, 'blocked', 'credential_rejected', false],
    [{ outcome: 'rate_limited' }, 'blocked', 'rate_limited', false],
    [{ outcome: 'challenge_required' }, 'blocked', 'challenge_required', true],
    [{ outcome: 'unexpected_origin' }, 'blocked', 'unexpected_origin', false],
    [{ outcome: 'timeout' }, 'failed', 'timeout', false],
    [{ outcome: 'unknown' }, 'blocked', 'unverified_account', false],
    [{ actionErrors: { open_login: 'SUPERVISOR_TIMEOUT' } }, 'failed', 'uncertain_step', true],
    [{ modelError: 'CALL_UNCERTAIN' }, 'failed', 'model_uncertain', true],
    [{ modelError: 'BUDGET_EXHAUSTED' }, 'blocked', 'budget_exhausted', false],
    [{ takeover: 'open_login' }, 'blocked', 'taken_over', true],
  ];
  for (const [scenario, state, resultClass, needsHuman] of cases) {
    const w = agentRunsWorld();
    const { call } = routed(w);
    Object.assign(w.supervisor.scenario, scenario);
    const runId = (await call(w.users.operator, 'POST', `/${w.p.id}/agent-runs`, { profile_id: w.profile.id,
      credential_binding_id: w.binding.binding_id })).body.run.id;
    const approval = await until(() => { const s = statusOf(w, runId); return s.result || s.approvals.find(a => a.state === 'requested'); },
      'approval or result');
    if (!approval.result_class) await call(w.users.owner, 'POST', `/agent-approvals/${approval.id}`,
      { digest: approval.digest, confirmation: approval.digest.slice(0, 12) }, { sudo: true });
    const done = await finished(w, runId);
    assert.deepEqual([done.run.state, done.result.result_class, done.result.needs_human], [state, resultClass, needsHuman],
      JSON.stringify(scenario));
    assert.equal(done.result.receipt.verified, true);
    const inbox = (await call(w.users.operator, 'GET', '/agent-approvals')).body;
    assert.deepEqual(inbox.help_requests.map(h => [h.id, h.help?.result_class]), needsHuman ? [[runId, resultClass]] : [],
      resultClass);
    leaks(inbox);
  }
});

test('restart recovery: an active run is fenced, never resumed, and needs a human', async () => {
  const w = agentRunsWorld();
  w.supervisor.scenario.holds.add('open_login');
  const run = await w.service.start(w.users.operator, w.p.id, { profile_id: w.profile.id,
    credential_binding_id: w.binding.binding_id });
  await until(() => statusOf(w, run.run.id).steps.length === 2, 'step reserved');
  // A second process on the same database, as after a backend restart.
  const restarted = createAgentRunService({ db: w.f.db, launcher: w.supervisor.launcher,
    coordinator: createRunCoordinator({ db: w.f.db, launcher: w.supervisor.launcher, verifyTeardown: w.supervisor.verifyTeardown }) });
  const [result] = await restarted.recover();
  assert.deepEqual([result.final_state, result.result_class, result.needs_human], ['failed', 'interrupted', 1]);
  // The help request keeps its own class and counts the uncertain step.
  assert.deepEqual(w.service.inbox(w.users.owner).help_requests.map(h => h.help),
    [{ result_class: 'interrupted', uncertain_steps: 1 }]);
  await w.service.settled(run.run.id);
  const done = statusOf(w, run.run.id);
  assert.deepEqual([done.steps[1].state, done.steps[1].error_code], ['uncertain', 'COORDINATOR_RESTART']);
  assert.equal(done.result.receipt.verified, true);
});

test('profile settings: consent is owner-only with If-Match and the typed statement; rules show the parse refusal', async () => {
  const w = agentRunsWorld({ consent: false });
  const { call } = routed(w);
  const path = `/${w.p.id}/agent-profiles/${w.profile.id}/model-guide-consent`;
  const list = await call(w.users.owner, 'GET', `/${w.p.id}/agent-runs`);
  assert.match(list.body.profiles[0].reasons.join(' '), /not consented/);
  assert.equal((await call(w.users.owner, 'PUT', path, { model_guide_consent: true, reviewed_statement: CONSENT })).statusCode, 428);
  const rev = { headers: { 'if-match': `"${w.profile.revision}"` } };
  assert.equal((await call(w.users.owner, 'PUT', path, { model_guide_consent: true }, rev)).statusCode, 400);
  assert.equal((await call(w.users.editor, 'PUT', path, { model_guide_consent: true, reviewed_statement: CONSENT }, rev)).statusCode, 403);
  assert.equal((await call(w.users.owner, 'PUT', path, { model_guide_consent: true, reviewed_statement: CONSENT },
    { headers: { 'if-match': '"99"' } })).statusCode, 412);
  const ok = await call(w.users.owner, 'PUT', path, { model_guide_consent: true, reviewed_statement: CONSENT }, rev);
  assert.deepEqual([ok.statusCode, ok.body.profile.model_guide_consent], [200, true]);
  assert.equal((await call(w.users.owner, 'GET', `/${w.p.id}/agent-runs`)).body.profiles[0].ready, true);
  const version = w.approveGuide('A guide with no hard rules.');
  const profile = w.f.store.profile(w.users.owner, w.p.id, w.profile.id).profile;
  w.f.store.assignProfile(w.users.owner, w.p.id, w.profile.id, profile.revision, { guide_version_id: version.id });
  const rules = await call(w.users.viewer, 'GET', `/${w.p.id}/agent-profiles/${w.profile.id}/rules`);
  assert.deepEqual([rules.body.rules, rules.body.refusal], [null, 'GUIDE_RULES_MISSING']);
  const readiness = (await call(w.users.owner, 'GET', `/${w.p.id}/agent-runs`)).body.profiles[0];
  assert.equal(readiness.ready, false);
  assert.match(readiness.reasons.join(' '), /no hard-rules block/);
  const start = await call(w.users.owner, 'POST', `/${w.p.id}/agent-runs`, { profile_id: w.profile.id,
    credential_binding_id: w.binding.binding_id });
  assert.deepEqual([start.statusCode, start.body.code], [409, 'GUIDE_RULES_MISSING']);
});

test('human-only: no MCP tool, catalog entry or policy reaches agent runs, approvals or the live view', async () => {
  const { readdirSync, readFileSync, statSync } = await import('node:fs');
  const { join } = await import('node:path');
  const src = new URL('..', import.meta.url).pathname;
  const files = [];
  const walk = (dir) => { for (const name of readdirSync(dir)) { const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path); else if (/\.(js|json)$/.test(name)) files.push(path); } };
  for (const dir of ['routes/mcp-tools', 'lib/mcp-ext', 'lib/mcp-policy']) walk(join(src, dir));
  files.push(join(src, 'routes/mcp.js'), join(src, 'lib/mcp-logic.js'));
  const hits = files.filter(path => /operational-(run-coordinator|agent-runs|agent-runtime)|agent-runs|agent-approvals|model-guide-consent/
    .test(readFileSync(path, 'utf8')));
  assert.deepEqual(hits, []);
});
