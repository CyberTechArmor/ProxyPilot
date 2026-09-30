import { randomUUID } from 'node:crypto';
import { assertOperation, resolveOperationsRole } from './operational-projects-logic.js';
import { REQUIRED_ACTION, createOperationalWorkerStore } from './operational-worker-boundary.js';
import { SUBMIT, approvalDigest, guideDocument, guideRules, nextStep, policyDocument, reduceClaims }
  from './operational-run-policy.js';
import { FIXTURE_MODES, profileGate } from './operational-recovery.js';

// A5 coordinator: one bounded, supervised run of the synthetic sign-in workflow.
// It drives the installed A3 supervisor's backend socket (through an injected
// createWorkerLauncher) and never the operator socket. Nothing constructs it in
// the routes: A2/A3/Operations activation stays off; only the proof harness
// (scripts/a5-probe.mjs, host root, a proof database) runs it.
//
// Precedence each step: the A3/A4 host boundaries refuse everything outside the
// pinned launch; the guide's hard rules (operational-run-policy.js) decide
// wherever they apply, with no model call; otherwise the model picks one action
// from the rule-filtered set through the supervisor's model_step. Every choice is
// validated, reserved durably (authorizeAction) and only then performed. Page
// results are untrusted and reduced to typed claims. An uncertain step or model
// call is never retried; it becomes a human decision.
//
// A7 adds: a submit that timed out is a human decision (the site may have
// signed in); Start is refused while the profile has an uncertain write nobody
// has decided; each run records how it came to be (practice with a demo fixture
// mode, or a resume of an earlier run pinned to the same policy); and a
// dashboard takeover (begin, hold, end) hands the live attempt to one person,
// after which the run ends taken_over and never resumes in that attempt.
const ACTIVE = new Set(['prepared', 'starting', 'running']);
const TRANSPORT = new Set(['SUPERVISOR_TIMEOUT', 'SUPERVISOR_UNREACHABLE', 'SUPERVISOR_PROTOCOL', 'CHANNEL_CLOSED']);
const NEEDS_HUMAN = new Set(['challenge_required', 'interrupted', 'uncertain_step', 'model_uncertain', 'taken_over',
  'timeout']);
const MODEL_REFUSAL = Object.freeze({
  MODEL_CHOICE_INVALID: ['blocked', 'model_choice_invalid'],
  BUDGET_EXHAUSTED: ['blocked', 'budget_exhausted'],
  PRICE_UNKNOWN: ['failed', 'price_unknown'],
  USAGE_MISSING: ['failed', 'usage_unknown'],
  MODEL_MISMATCH: ['failed', 'usage_unknown'],
  PROVIDER_ERROR: ['failed', 'provider_error'],
  PROVIDER_KEY_UNBOUND: ['failed', 'provider_error'],
  MODEL_NOT_ALLOWED: ['blocked', 'model_unavailable'],
  GUIDE_NOT_SHAREABLE: ['blocked', 'guide_not_shareable'],
  GUIDE_HASH_MISMATCH: ['blocked', 'stale_configuration'],
  RUN_POLICY_MISMATCH: ['blocked', 'stale_configuration'],
  REVISION_MISMATCH: ['blocked', 'stale_configuration'],
  PROMPT_TOO_LARGE: ['blocked', 'prompt_too_large'],
  CALL_UNCERTAIN: ['failed', 'model_uncertain'],
});
const ACTION_STOP = Object.freeze({
  ACTION_LIMIT: ['blocked', 'action_limit'],
  DEADLINE: ['failed', 'deadline'],
  LEASE_EXPIRED: ['failed', 'lease_expired'],
  STALE_FENCE: ['failed', 'attempt_lost'],
  ATTEMPT_NOT_ACTIVE: ['failed', 'attempt_lost'],
  // The supervisor never sent the step: the runner had already exited (A7).
  WORKER_EXITED: ['failed', 'attempt_lost'],
  UNKNOWN_ATTEMPT: ['failed', 'attempt_lost'],
  STALE_WORKER: ['failed', 'lease_expired'],
  STALE_CONFIGURATION: ['blocked', 'stale_configuration'],
  INVALID_PROFILE_POLICY: ['blocked', 'stale_configuration'],
  ACTION_NOT_CONFIGURED: ['blocked', 'action_not_permitted'],
  APPROVAL_STALE: ['blocked', 'approval_stale'],
  RUN_POLICY_MISMATCH: ['blocked', 'stale_configuration'],
  CREDENTIAL_BINDING_STALE: ['blocked', 'binding_changed'],
  CREDENTIAL_BINDING_REVOKED: ['blocked', 'binding_changed'],
  CREDENTIAL_REVISION_MISMATCH: ['blocked', 'binding_changed'],
  BINDING_REVOKED: ['blocked', 'binding_changed'],
  BINDING_REVISION_MISMATCH: ['blocked', 'binding_changed'],
  BINDING_UNKNOWN: ['blocked', 'binding_changed'],
  BINDING_MISMATCH: ['blocked', 'binding_changed'],
  CREDENTIAL_NOT_BOUND: ['blocked', 'binding_changed'],
  CREDENTIAL_BROKER_UNAVAILABLE: ['failed', 'broker_unavailable'],
  STEP_ALREADY_RESERVED: ['failed', 'attempt_lost'],
});
const coded = (code, detail) => { const e = new Error(code); e.code = code; if (detail !== undefined) e.detail = detail; return e; };
const fail = (code, detail) => { throw coded(code, detail); };
const codeOf = (error) => (typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
  ? error.code : 'INTERNAL');

function receiptPayload(receipt) {
  try { return JSON.parse(Buffer.from(String(receipt.attestation).split('.')[1], 'base64url').toString('utf8')); }
  catch { return {}; }
}

export function createRunCoordinator({ db, launcher, verifyTeardown, clock = () => new Date(), uuid = randomUUID,
  heartbeatMs = 10_000, pollMs = 500, approvalTimeoutMs = 15 * 60_000, takeoverWaitMs = 30 * 60_000,
  onApprovalRequested = null, log = () => {}, hooks = {} } = {}) {
  const workers = createOperationalWorkerStore(db, clock, uuid, verifyTeardown);
  const one = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  const stamp = () => clock().toISOString();
  function tx(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const event = (runId, attemptId, kind) => run(
    'INSERT INTO ops_agent_worker_events(run_id,attempt_id,kind,created_at) VALUES(?,?,?,?)', runId, attemptId, kind, stamp());
  const note = (entry) => { try { log({ at: stamp(), ...entry }); } catch { /* logging never changes a run */ } };
  const terminating = new Map();

  // Human-only authority: an eligible account with run access on the project.
  // Approval also needs an elevated session (a route may pass that only after
  // sudo elevation). MCP, a page, evidence or model output has no path here.
  function assertRunAccess(actor, projectId, { elevated = false } = {}) {
    const u = one('SELECT id,role FROM users WHERE id=?', actor?.id ?? '');
    if (!u || !['user', 'admin'].includes(u.role)) fail('ACTOR_NOT_ELIGIBLE');
    if (elevated && actor.elevated !== true) fail('ELEVATION_REQUIRED');
    const p = one('SELECT * FROM ops_projects WHERE id=?', projectId);
    const grant = p && one('SELECT role FROM ops_project_grants WHERE project_id=? AND user_id=?', projectId, u.id);
    try { assertOperation(resolveOperationsRole(p, u.id, grant), 'run', !!p?.archived_at); }
    catch { fail('RUN_ACCESS_DENIED'); }
    return u;
  }
  const guideText = (projectId, versionId) => one(`SELECT s.title,s.instructions,v.content_hash FROM ops_guide_versions v
    JOIN ops_guide_submissions s ON s.id=v.submission_id AND s.project_id=v.project_id WHERE v.project_id=? AND v.id=?`,
  projectId, versionId);
  const latestGuide = projectId => one(`SELECT v.id,v.content_hash FROM ops_guide_versions v WHERE v.project_id=?
    AND NOT EXISTS(SELECT 1 FROM ops_version_withdrawals w WHERE w.project_id=v.project_id AND w.version_id=v.id)
    ORDER BY v.version_number DESC LIMIT 1`, projectId);
  const pinOf = runId => one('SELECT * FROM ops_agent_run_pins WHERE run_id=?', runId);
  const runOf = runId => one('SELECT * FROM ops_agent_runs WHERE id=?', runId);
  const finished = runId => all(`SELECT action,state,claims_json FROM ops_agent_run_steps WHERE run_id=?
    AND state IN ('done','failed') ORDER BY ordinal`, runId)
    .map(s => ({ action: s.action, status: s.state, claims: JSON.parse(s.claims_json) }));

  // --------------------------------------------------------------- start

  // `origin` (A7) is how the run came to be: {practice, fixture_mode} for a
  // practice run, {resumed_from} for a resume. A resume copies the practice
  // flag and mode of the run it resumes and must pin exactly its policy.
  function validOrigin(origin) {
    if (origin == null) return { practice: false, fixture_mode: null, resumed_from: null };
    const names = Object.keys(origin).sort().join(',');
    if (names === 'fixture_mode,practice' && origin.practice === true && FIXTURE_MODES.includes(origin.fixture_mode))
      return { practice: true, fixture_mode: origin.fixture_mode, resumed_from: null };
    if (names === 'resumed_from' && typeof origin.resumed_from === 'string')
      return { practice: false, fixture_mode: null, resumed_from: origin.resumed_from };
    fail('INVALID_RUN');
  }
  function resumable(from, projectId, profileId) {
    const r = runOf(from);
    if (!r || r.project_id !== projectId || r.profile_id !== profileId) fail('RESUME_UNKNOWN');
    const result = resultOf(from);
    if (!result || result.needs_human !== 1) fail('RESUME_NOT_ALLOWED');
    if (one('SELECT 1 FROM ops_agent_run_origins WHERE resumed_from_run_id=?', from)) fail('RESUME_ALREADY_STARTED');
    const origin = one('SELECT practice,fixture_mode FROM ops_agent_run_origins WHERE run_id=?', from);
    return { r, practice: origin?.practice === 1, fixture_mode: origin?.fixture_mode ?? null };
  }

  function start(actor, input, origin = null) {
    const names = Object.keys(input ?? {}).sort().join(',');
    if (!['profile_id,project_id', 'credential_binding_id,profile_id,project_id'].includes(names)) fail('INVALID_RUN');
    const how = validOrigin(origin);
    const starter = assertRunAccess(actor, input.project_id);
    const project = one('SELECT * FROM ops_projects WHERE id=?', input.project_id);
    const profile = one('SELECT * FROM ops_agent_profiles WHERE project_id=? AND id=? AND deleted_at IS NULL',
      input.project_id, input.profile_id);
    if (!project || !profile || !profile.guide_version_id) fail('STALE_CONFIGURATION');
    const guide = guideText(input.project_id, profile.guide_version_id);
    if (!guide || guide.content_hash !== profile.guide_hash) fail('STALE_CONFIGURATION');
    const rules = guideRules(guide.instructions);
    const policy = policyDocument({ guideHash: profile.guide_hash, rules, origin: project.site_origin,
      modelGuideConsent: profile.model_guide_consent === 1 });
    // An uncertain write (a sign-in or sign-out that may or may not have
    // happened) waits for a person's decision before this profile runs again.
    const gate = profileGate(db, profile.id);
    if (gate) fail('RECONCILIATION_REQUIRED', gate.run_id);
    let resumeOf = null;
    if (how.resumed_from) {
      resumeOf = resumable(how.resumed_from, input.project_id, input.profile_id);
      const was = resumeOf.r;
      const binding = input.credential_binding_id ?? null;
      const current = binding && one('SELECT revision FROM ops_agent_credential_bindings WHERE id=? AND state=\'active\'', binding);
      const changed = was.profile_revision !== profile.revision ? 'profile_changed'
        : was.guide_version_id !== profile.guide_version_id || was.guide_hash !== profile.guide_hash ? 'guide_changed'
          : (was.credential_binding_id ?? null) !== binding ||
            (binding && current?.revision !== was.credential_binding_revision) ? 'binding_changed'
            : was.policy_digest !== policy.digest ? 'policy_changed' : null;
      if (changed) fail('RESUME_STALE', changed);
    }
    const practice = resumeOf ? resumeOf.practice : how.practice;
    const fixtureMode = resumeOf ? resumeOf.fixture_mode : how.fixture_mode;
    let prepared;
    try {
      // One transaction pins the guide, profile, site, limits, binding revision
      // and policy digest; a change after this refuses the next use.
      prepared = workers.prepare({ project_id: project.id, profile_id: profile.id, profile_revision: profile.revision,
        site_origin: project.site_origin, site_revision: project.site_revision, guide_version_id: profile.guide_version_id,
        guide_hash: profile.guide_hash, policy_digest: policy.digest,
        ...(input.credential_binding_id ? { credential_binding_id: input.credential_binding_id } : {}) },
      (runId) => {
        run(`INSERT INTO ops_agent_run_pins(run_id,started_by,policy_json,policy_digest,rules_version,model_guide_consent,created_at)
          VALUES(?,?,?,?,?,?,?)`, runId, starter.id, policy.text, policy.digest, rules.v, profile.model_guide_consent, stamp());
        run(`INSERT INTO ops_agent_run_origins(run_id,practice,fixture_mode,resumed_from_run_id,created_at)
          VALUES(?,?,?,?,?)`, runId, practice ? 1 : 0, practice ? fixtureMode : null, resumeOf?.r.id ?? null, stamp());
        event(runId, null, 'a5:started');
        if (practice) event(runId, null, `a7:practice:${fixtureMode}`);
        if (resumeOf) event(runId, null, 'a7:resumed');
      });
    } catch (error) {
      if (/ops_agent_run_origins\.resumed_from_run_id|ops_agent_one_resume/.test(String(error?.message)))
        fail('RESUME_ALREADY_STARTED');
      if (/UNIQUE/.test(String(error?.message))) fail('RUN_ALREADY_ACTIVE');
      throw error;
    }
    note({ event: 'run_started', run_id: prepared.run_id, policy_digest: policy.digest, practice,
      resumed_from: resumeOf?.r.id ?? null });
    return { run_id: prepared.run_id, policy_digest: policy.digest, deadline_at: prepared.deadline_at,
      credential_binding_revision: prepared.credential_binding_revision, practice, fixture_mode: practice ? fixtureMode : null,
      resumed_from: resumeOf?.r.id ?? null };
  }

  // ------------------------------------------------------------- results

  function writeResult(r, state, resultClass, receipt, needsHuman) {
    const steps = all('SELECT decided_by,state,action,claims_json FROM ops_agent_run_steps WHERE run_id=?', r.id);
    const submit = steps.find(s => s.action === SUBMIT && s.state === 'done');
    const payload = receipt ? receiptPayload(receipt) : {};
    const logout = payload.credential?.logout ?? payload.evidence?.logout ?? null;
    const uncertain = steps.filter(s => s.state === 'uncertain').length;
    const calls = one('SELECT COUNT(*) AS n FROM ops_agent_model_calls WHERE run_id=?', r.id).n;
    run(`INSERT INTO ops_agent_run_results(run_id,final_state,result_class,verified_account,needs_human,steps,rule_steps,
      model_steps,model_calls,uncertain_steps,binding_id,binding_revision,submit_outcome,logout,receipt_attestation,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, r.id, state, resultClass,
    state === 'completed' && resultClass === 'verified_account' ? 1 : 0,
    needsHuman || uncertain > 0 || NEEDS_HUMAN.has(resultClass) ? 1 : 0, steps.length,
    steps.filter(s => s.decided_by === 'rule').length, steps.filter(s => s.decided_by === 'model').length, calls, uncertain,
    r.credential_binding_id, r.credential_binding_revision,
    submit ? JSON.parse(submit.claims_json).outcome ?? null : null,
    ['done', 'failed', 'not_run'].includes(logout) ? logout : null, receipt?.attestation ?? null, stamp());
  }
  const closeApprovals = (runId, reason) => run(`UPDATE ops_agent_run_approvals SET state='stale',stale_reason=?,closed_at=?
    WHERE run_id=? AND state IN ('requested','approved')`, reason, stamp(), runId);
  const resultOf = runId => one('SELECT * FROM ops_agent_run_results WHERE run_id=?', runId) ?? null;

  // Fence, stop at the supervisor, verify the signed receipt, and write the
  // durable result in the same transaction as the terminal state. Serialized
  // per run: an operator stop and the loop's own stop share one teardown.
  function terminate(runId, state, resultClass, { needsHuman = false, stopReason = null } = {}) {
    if (terminating.has(runId)) return terminating.get(runId);
    const work = (async () => {
      const r = runOf(runId);
      if (!r) fail('RUN_UNKNOWN');
      if (ACTIVE.has(r.state)) workers.fence(runId, state, () => {
        closeApprovals(runId, 'run_stopping');
        run(`UPDATE ops_agent_takeovers SET state='ended',ended_at=?,end_reason='run_stopping'
          WHERE run_id=? AND state!='ended'`, stamp(), runId);
      });
      else if (r.state !== 'cancelling') return resultOf(runId);
      const attempt = one('SELECT id,fence FROM ops_agent_worker_attempts WHERE run_id=? ORDER BY attempt_no DESC LIMIT 1', runId);
      if (!attempt) {
        workers.abandonUnlaunched(runId, state, (row) => writeResult(row, state, resultClass, null, needsHuman));
      } else {
        const receipt = await launcher.stop({ run_id: runId, attempt_id: attempt.id, fence: attempt.fence },
          stopReason ?? state);
        workers.finishStop(runId, state, receipt, (row) => writeResult(row, state, resultClass, receipt, needsHuman));
      }
      const result = resultOf(runId);
      note({ event: 'run_finished', run_id: runId, final_state: result.final_state, result_class: result.result_class,
        verified_account: result.verified_account === 1, needs_human: result.needs_human === 1 });
      return result;
    })();
    terminating.set(runId, work);
    return work.finally(() => terminating.delete(runId));
  }

  // ------------------------------------------------------------ approvals

  function approvalFields(runId, action) {
    const r = runOf(runId);
    const attempt = one("SELECT id FROM ops_agent_worker_attempts WHERE run_id=? AND state='running'", runId);
    const binding = r.credential_binding_id == null ? null
      : one('SELECT revision,state FROM ops_agent_credential_bindings WHERE id=?', r.credential_binding_id);
    const project = one('SELECT site_origin FROM ops_projects WHERE id=?', r.project_id);
    return { r, binding, attempt, fields: { run_id: runId, attempt_id: attempt?.id ?? null, fence: r.fence, action,
      binding_id: r.credential_binding_id ?? null,
      binding_revision: binding && binding.state === 'active' ? binding.revision : null,
      guide_hash: latestGuide(r.project_id)?.content_hash ?? null, policy_digest: r.policy_digest,
      origin: project?.site_origin ?? null } };
  }

  function requestApproval(ref, action) {
    return tx(() => {
      const { fields } = approvalFields(ref.run_id, action);
      if (fields.attempt_id !== ref.attempt_id || fields.fence !== ref.fence) fail('STALE_WORKER');
      const id = uuid(), digest = approvalDigest(fields);
      run(`INSERT INTO ops_agent_run_approvals(id,run_id,attempt_id,fence,action,binding_id,binding_revision,guide_hash,
        policy_digest,origin,digest,state,requested_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,'requested',?)`, id, ref.run_id,
      ref.attempt_id, ref.fence, action, fields.binding_id, fields.binding_revision, fields.guide_hash, fields.policy_digest,
      fields.origin, digest, stamp());
      event(ref.run_id, ref.attempt_id, `a5:approval_requested:${action}`);
      return { approval_id: id, run_id: ref.run_id, action, digest, fields };
    });
  }

  // The approver sends back the digest they were shown. It must still equal
  // a digest recomputed from the current run, attempt, fence, binding, guide,
  // policy and origin; otherwise the approval is stale and has no effect.
  function approve(actor, input) {
    if (!input || Object.keys(input).sort().join(',') !== 'approval_id,digest' ||
        typeof input.approval_id !== 'string' || typeof input.digest !== 'string') fail('INVALID_APPROVAL');
    const outcome = tx(() => {
      const row = one('SELECT * FROM ops_agent_run_approvals WHERE id=?', input.approval_id);
      if (!row) return 'APPROVAL_UNKNOWN';
      const r = runOf(row.run_id);
      assertRunAccess(actor, r.project_id, { elevated: true });
      if (row.state !== 'requested') return 'APPROVAL_NOT_PENDING';
      if (input.digest !== row.digest) return 'APPROVAL_DIGEST_MISMATCH';
      const stale = (reason) => {
        run("UPDATE ops_agent_run_approvals SET state='stale',stale_reason=?,closed_at=? WHERE id=?", reason, stamp(), row.id);
        event(row.run_id, row.attempt_id, `a5:approval_stale:${reason}`);
        return 'APPROVAL_STALE';
      };
      if (r.state !== 'running') return stale('run_not_running');
      const { fields, binding } = approvalFields(row.run_id, row.action);
      if (row.binding_id && (!binding || binding.state !== 'active')) return stale('binding_revoked');
      if (approvalDigest(fields) !== row.digest) return stale('state_changed');
      run("UPDATE ops_agent_run_approvals SET state='approved',decided_by=?,decided_at=? WHERE id=?", actor.id, stamp(), row.id);
      event(row.run_id, row.attempt_id, `a5:approved:${row.action}`);
      return 'APPROVED';
    });
    note({ event: 'approval_decision', approval_id: input.approval_id, outcome });
    if (outcome !== 'APPROVED') fail(outcome);
    return { approval_id: input.approval_id, state: 'approved' };
  }

  // Inside the action reservation: an approval is used once, for this exact
  // action, attempt and fence, and only while its digest still holds.
  function consumeApproval(approvalId, ref, action) {
    const row = one('SELECT * FROM ops_agent_run_approvals WHERE id=?', approvalId);
    if (!row || row.state !== 'approved' || row.action !== action || row.run_id !== ref.run_id ||
        row.attempt_id !== ref.attempt_id || row.fence !== ref.fence) fail('APPROVAL_STALE');
    if (approvalDigest(approvalFields(ref.run_id, action).fields) !== row.digest) fail('APPROVAL_STALE');
    run("UPDATE ops_agent_run_approvals SET state='consumed',closed_at=? WHERE id=?", stamp(), approvalId);
  }

  async function checkpoint(ref, action) {
    const request = requestApproval(ref, action);
    note({ event: 'approval_requested', run_id: ref.run_id, approval_id: request.approval_id, action,
      digest: request.digest });
    if (onApprovalRequested) {
      try { onApprovalRequested(request); } catch { /* the hook never decides */ }
    }
    const until = Date.now() + approvalTimeoutMs;
    for (;;) {
      const row = one('SELECT state FROM ops_agent_run_approvals WHERE id=?', request.approval_id);
      if (row.state === 'approved') return { approval_id: request.approval_id };
      if (takenOver(ref.run_id)) return { takeover: true };
      if (row.state !== 'requested') return { stop: ['blocked', 'approval_stale'] };
      if (runOf(ref.run_id).state !== 'running') return { stop: null };
      if (Date.now() >= until) {
        const expired = tx(() => run(`UPDATE ops_agent_run_approvals SET state='expired',closed_at=? WHERE id=?
          AND state='requested'`, stamp(), request.approval_id).changes);
        if (expired) return { stop: ['blocked', 'approval_timeout'] };
        continue;
      }
      await sleep(pollMs);
    }
  }

  // -------------------------------------------------------------- model

  async function modelChoice(ref, pin, rules, allowed, observations) {
    const policy = JSON.parse(pin.policy_json);
    // Refused before any provider call: no model in the rules, no consent to
    // send this profile's guide to the provider, or the call cap reached.
    if (!rules.model) return { stop: ['blocked', 'model_unavailable'] };
    if (policy.model_guide_consent !== true) return { stop: ['blocked', 'guide_not_shareable'] };
    const r = runOf(ref.run_id);
    const calls = one('SELECT COUNT(*) AS n FROM ops_agent_model_calls WHERE run_id=?', ref.run_id).n;
    if (calls >= rules.max_model_calls) return { stop: ['blocked', 'model_call_limit'] };
    const guide = guideText(r.project_id, r.guide_version_id);
    const document = guide && guideDocument(guide.title, guide.instructions);
    if (!guide || guide.content_hash !== r.guide_hash) return { stop: ['blocked', 'stale_configuration'] };
    const callId = uuid();
    // Durable before the supervisor or provider sees anything; a restart turns
    // it uncertain and it is never re-sent under a new ID.
    tx(() => run(`INSERT INTO ops_agent_model_calls(call_id,run_id,attempt_id,fence,step_ordinal,allowed_json,state,created_at)
      VALUES(?,?,?,?,?,?,'reserved',?)`, callId, ref.run_id, ref.attempt_id, ref.fence, r.action_count + 1,
    JSON.stringify(allowed), stamp()));
    note({ event: 'model_step', run_id: ref.run_id, call_id: callId, allowed });
    if (hooks.afterModelReserved) await hooks.afterModelReserved({ ...ref, call_id: callId });
    let result;
    try {
      result = await launcher.modelStep({ ...ref, call_id: callId, policy: pin.policy_json, guide: document,
        observations, allowed });
    } catch (error) {
      const code = codeOf(error);
      const uncertain = TRANSPORT.has(code) || code === 'CALL_UNCERTAIN';
      tx(() => run(`UPDATE ops_agent_model_calls SET state=?,refusal_code=?,finished_at=? WHERE call_id=?`,
        uncertain ? 'uncertain' : 'refused', code, stamp(), callId));
      note({ event: 'model_refused', run_id: ref.run_id, call_id: callId, code });
      if (code === 'TAKEN_OVER') return { takeover: true };
      if (uncertain) return { stop: ['failed', 'model_uncertain'], needsHuman: true };
      return { stop: MODEL_REFUSAL[code] ?? ['failed', 'model_refused'] };
    }
    // The launcher already refused a choice outside `allowed`; check again here.
    if (!allowed.includes(result.choice)) return { stop: ['blocked', 'model_choice_invalid'] };
    tx(() => run(`UPDATE ops_agent_model_calls SET state='chosen',choice=?,settled_usd=?,prompt_tokens=?,completion_tokens=?,
      price_table_revision=?,provider_response_id=?,replayed=?,finished_at=? WHERE call_id=?`, result.choice,
    typeof result.settled_usd === 'string' ? result.settled_usd.slice(0, 32) : null,
    Number.isSafeInteger(result.usage?.prompt_tokens) ? result.usage.prompt_tokens : null,
    Number.isSafeInteger(result.usage?.completion_tokens) ? result.usage.completion_tokens : null,
    Number.isSafeInteger(result.price_table_revision) ? result.price_table_revision : null,
    typeof result.provider_response_id === 'string' ? result.provider_response_id.slice(0, 200) : null,
    result.replayed === true ? 1 : 0, stamp(), callId));
    note({ event: 'model_chosen', run_id: ref.run_id, call_id: callId, choice: result.choice });
    return { choice: result.choice, call_id: callId };
  }

  // ---------------------------------------------------------------- loop

  function heartbeat(ref, state) {
    const timer = setInterval(async () => {
      try { await launcher.renew(ref); } catch (error) { state.renewError = codeOf(error); }
      try { workers.renewLease(ref); } catch (error) {
        const code = codeOf(error);
        if (code !== 'STALE_WORKER') state.stale = code;
      }
    }, heartbeatMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  const takenOver = runId => !!one("SELECT 1 FROM ops_agent_takeovers WHERE run_id=? AND state IN ('taking','holding')", runId);

  async function awaitTakeover(ref) {
    event(ref.run_id, ref.attempt_id, 'a5:taken_over');
    note({ event: 'taken_over', run_id: ref.run_id });
    const until = Date.now() + takeoverWaitMs;
    while (Date.now() < until) {
      if (terminating.has(ref.run_id) || !ACTIVE.has(runOf(ref.run_id).state)) break;
      let status = null;
      try { status = await launcher.status(); } catch { /* keep waiting */ }
      if (status && status.active?.attempt_id !== ref.attempt_id) break;
      await sleep(Math.max(pollMs, 1000));
    }
    const dashboard = one('SELECT id FROM ops_agent_takeovers WHERE run_id=? ORDER BY started_at DESC LIMIT 1', ref.run_id);
    if (dashboard) closeTakeover(dashboard.id, 'run_ended', null);
    return terminate(ref.run_id, 'blocked', 'taken_over', dashboard ? { stopReason: 'taken_over' } : {});
  }

  // ------------------------------------------------- dashboard takeover (A7)

  const takeoverRow = id => one('SELECT * FROM ops_agent_takeovers WHERE id=?', id);
  function closeTakeover(id, reason, inputs) {
    run(`UPDATE ops_agent_takeovers SET state='ended',ended_at=?,end_reason=?,inputs_json=? WHERE id=? AND state!='ended'`,
      stamp(), reason, JSON.stringify(inputs ?? {}), id);
  }

  // One person takes the live attempt: the durable claim (one controller per
  // run) comes first and closes any open approval, so the agent's loop stops
  // before its next step. The service then asks the supervisor to hand the
  // browser to that person (after any in-flight submit) and calls holdTakeover.
  function beginTakeover(actor, runId) {
    const r = runOf(runId);
    if (!r) fail('RUN_UNKNOWN');
    const user = assertRunAccess(actor, r.project_id);
    return tx(() => {
      const now = runOf(runId);
      if (now.state !== 'running') fail('TAKEOVER_NOT_RUNNING');
      const attempt = one("SELECT id,fence FROM ops_agent_worker_attempts WHERE run_id=? AND state='running'", runId);
      if (!attempt || attempt.fence !== now.fence) fail('TAKEOVER_NOT_RUNNING');
      const id = uuid();
      try {
        run(`INSERT INTO ops_agent_takeovers(id,run_id,attempt_id,fence,user_id,state,started_at) VALUES(?,?,?,?,?,'taking',?)`,
          id, runId, attempt.id, now.fence, user.id, stamp());
      } catch (error) {
        if (/UNIQUE|ops_agent_one_controller/.test(String(error?.message))) fail('TAKEOVER_HELD');
        throw error;
      }
      closeApprovals(runId, 'taken_over');
      event(runId, attempt.id, 'a7:takeover_requested');
      return { takeover_id: id, ref: { run_id: runId, attempt_id: attempt.id, fence: now.fence } };
    });
  }
  function holdTakeover(takeoverId) {
    tx(() => {
      const t = takeoverRow(takeoverId);
      if (!t || t.state !== 'taking') fail('TAKEOVER_UNKNOWN');
      run("UPDATE ops_agent_takeovers SET state='holding',control_at=? WHERE id=?", stamp(), takeoverId);
      event(t.run_id, t.attempt_id, 'a7:takeover_holding');
    });
    note({ event: 'takeover_holding', takeover_id: takeoverId });
  }
  // The person ends it (or it failed to start): the attempt is stopped with the
  // supervisor stop reason taken_over, and the run ends blocked / taken_over
  // with its verified receipt. The count and kind of inputs are kept, never
  // what was typed.
  async function endTakeover(actor, runId, { reason = 'ended_by_person', inputs = null } = {}) {
    const r = runOf(runId);
    if (!r) fail('RUN_UNKNOWN');
    assertRunAccess(actor, r.project_id);
    const t = one("SELECT * FROM ops_agent_takeovers WHERE run_id=? AND state IN ('taking','holding')", runId);
    if (!t) return resultOf(runId);
    if (t.user_id !== actor.id) fail('TAKEOVER_NOT_YOURS');
    closeTakeover(t.id, reason, inputs);
    event(runId, t.attempt_id, 'a7:takeover_ended');
    note({ event: 'takeover_ended', run_id: runId, reason });
    if (!ACTIVE.has(r.state) && r.state !== 'cancelling') return resultOf(runId);
    return terminate(runId, 'blocked', 'taken_over', { stopReason: 'taken_over' });
  }
  // The holder's live view is gone (closed, lost, or their run access was
  // removed): the service ends the takeover on their behalf, with the same
  // teardown as endTakeover. No actor: it is never a person's new decision.
  async function dropTakeover(takeoverId, { reason = 'viewer_left', inputs = null } = {}) {
    const t = takeoverRow(takeoverId);
    if (!t) return null;
    if (t.state === 'ended') return resultOf(t.run_id);
    closeTakeover(t.id, reason, inputs);
    event(t.run_id, t.attempt_id, 'a7:takeover_ended');
    note({ event: 'takeover_ended', run_id: t.run_id, reason });
    const r = runOf(t.run_id);
    if (!ACTIVE.has(r.state) && r.state !== 'cancelling') return resultOf(t.run_id);
    return terminate(t.run_id, 'blocked', 'taken_over', { stopReason: 'taken_over' });
  }
  // A takeover the supervisor refused before handing anything over: the claim
  // is closed and the agent's run ends as a normal stop would (the agent is
  // never resumed after a takeover was asked for).
  async function abandonTakeover(takeoverId, code) {
    const t = takeoverRow(takeoverId);
    if (!t || t.state === 'ended') return null;
    closeTakeover(t.id, `refused:${String(code).slice(0, 55)}`, null);
    event(t.run_id, t.attempt_id, 'a7:takeover_refused');
    const r = runOf(t.run_id);
    if (!ACTIVE.has(r.state) && r.state !== 'cancelling') return resultOf(t.run_id);
    return terminate(t.run_id, 'blocked', 'taken_over', { needsHuman: true });
  }

  async function execute(runId) {
    const pin = pinOf(runId);
    if (!pin) fail('RUN_NOT_PINNED');
    const rules = JSON.parse(pin.policy_json).rules;
    let ref;
    try {
      const a = workers.reserveAttempt(runId);
      ref = { run_id: runId, attempt_id: a.attempt_id, fence: a.fence };
      const launched = await launcher.launch(workers.launchSpec(a));
      workers.markRunning(ref, { vm_uuid: launched.vm_uuid, boot_id: launched.boot_id });
      note({ event: 'launched', run_id: runId, attempt_id: a.attempt_id, boot_id: launched.boot_id });
    } catch (error) {
      const code = codeOf(error);
      note({ event: 'launch_refused', run_id: runId, code });
      const [state, result] = ACTION_STOP[code] ?? ['failed', 'launch_failed'];
      return terminate(runId, state, result);
    }
    const state = {};
    const stopHeartbeat = heartbeat(ref, state);
    try {
      return await loop(ref, pin, rules, state, stopHeartbeat);
    } finally {
      stopHeartbeat();
    }
  }

  async function loop(ref, pin, rules, state, stopHeartbeat) {
    const runId = ref.run_id;
    const stopped = async () => (terminating.get(runId) ?? Promise.resolve()).then(() => resultOf(runId));
    for (;;) {
      const r = runOf(runId);
      if (r.state !== 'running') return stopped();
      if (takenOver(runId)) { stopHeartbeat(); return awaitTakeover(ref); }
      if (state.stale) return terminate(runId, ...(ACTION_STOP[state.stale] ?? ['blocked', 'stale_configuration']));
      const profile = one('SELECT proposed_actions_json FROM ops_agent_profiles WHERE id=?', r.profile_id);
      const kinds = JSON.parse(profile.proposed_actions_json);
      const steps = finished(runId);
      let decision = nextStep({ rules, steps, permitted: a => kinds.includes(REQUIRED_ACTION[a]),
        canSubmit: r.credential_binding_id != null });
      if (decision.kind === 'stop') return terminate(runId, decision.state, decision.result);
      let modelCallId = null;
      if (decision.kind === 'model') {
        const chosen = await modelChoice(ref, pin, rules, decision.allowed, steps);
        if (chosen.takeover) { stopHeartbeat(); return awaitTakeover(ref); }
        if (chosen.stop) return terminate(runId, ...chosen.stop, { needsHuman: chosen.needsHuman });
        decision = { kind: 'action', action: chosen.choice, decided_by: 'model', rule: null };
        modelCallId = chosen.call_id;
      }
      let approvalId = null;
      if (rules.approval_required.includes(decision.action)) {
        const approval = await checkpoint(ref, decision.action);
        if (approval.takeover) { stopHeartbeat(); return awaitTakeover(ref); }
        if (approval.stop === null) return stopped();
        if (approval.stop) return terminate(runId, ...approval.stop);
        approvalId = approval.approval_id;
      }
      // A person may have taken over while the model or the approval was
      // pending: never reserve another step for the agent then.
      if (takenOver(runId)) { stopHeartbeat(); return awaitTakeover(ref); }
      const request = { ...ref, action: decision.action,
        ...(decision.action === SUBMIT ? { binding_id: r.credential_binding_id } : {}) };
      let ordinal;
      try {
        ({ ordinal } = workers.authorizeAction(request, (next) => {
          if (approvalId) consumeApproval(approvalId, ref, decision.action);
          run(`INSERT INTO ops_agent_run_steps(run_id,attempt_id,fence,ordinal,action,decided_by,rule,model_call_id,
            approval_id,state,created_at) VALUES(?,?,?,?,?,?,?,?,?,'reserved',?)`, runId, ref.attempt_id, ref.fence, next,
          decision.action, decision.decided_by, decision.rule, modelCallId, approvalId, stamp());
        }));
      } catch (error) {
        const code = codeOf(error);
        note({ event: 'step_refused', run_id: runId, action: decision.action, code });
        if (runOf(runId).state !== 'running') return stopped();
        return terminate(runId, ...(ACTION_STOP[code] ?? ['blocked', 'step_refused']));
      }
      note({ event: 'step', run_id: runId, ordinal, action: decision.action, decided_by: decision.decided_by,
        rule: decision.rule });
      if (hooks.afterStepReserved) await hooks.afterStepReserved({ ...ref, ordinal, action: decision.action });
      let result = null, code = null;
      try { result = await launcher.action({ ...request, ordinal }); } catch (error) { code = codeOf(error); }
      const finish = (stepState, claims, errorCode) => tx(() => run(`UPDATE ops_agent_run_steps SET state=?,claims_json=?,
        error_code=?,finished_at=? WHERE run_id=? AND ordinal=?`, stepState, JSON.stringify(claims), errorCode, stamp(),
      runId, ordinal));
      if (code === null) {
        const claims = reduceClaims(decision.action, result.result);
        if (decision.action === 'sign_out' && claims.signed_out !== true) {
          finish('uncertain', claims, 'SIGN_OUT_UNCONFIRMED');
          note({ event: 'step_failed', run_id: runId, ordinal, action: decision.action, code: 'SIGN_OUT_UNCONFIRMED' });
          if (runOf(runId).state !== 'running') return stopped();
          return terminate(runId, 'failed', 'uncertain_step', { needsHuman: true });
        }
        finish('done', claims, null);
        note({ event: 'step_done', run_id: runId, ordinal, action: decision.action, claims });
        continue;
      }
      note({ event: 'step_failed', run_id: runId, ordinal, action: decision.action, code });
      if (TRANSPORT.has(code) || (decision.action === 'sign_out' && code === 'SIGN_OUT_UNCONFIRMED')) {
        // The browser may have acted. Record it as uncertain; never replay it.
        finish('uncertain', {}, code);
        if (runOf(runId).state !== 'running') return stopped();
        return terminate(runId, 'failed', 'uncertain_step', { needsHuman: true });
      }
      finish('failed', {}, code);
      if (code === 'TAKEN_OVER') { stopHeartbeat(); return awaitTakeover(ref); }
      if (runOf(runId).state !== 'running') return stopped();
      if (ACTION_STOP[code]) return terminate(runId, ...ACTION_STOP[code]);
      // A typed browser refusal (element missing, readback failed, ...) is a
      // failed step; the rules decide what follows.
    }
  }

  // -------------------------------------------------------- stop/recover

  async function stop(actor, runId) {
    const r = runOf(runId);
    if (!r) fail('RUN_UNKNOWN');
    assertRunAccess(actor, r.project_id);
    if (!ACTIVE.has(r.state) && r.state !== 'cancelling') return resultOf(runId);
    note({ event: 'operator_stop', run_id: runId, by: actor.id });
    return terminate(runId, 'cancelled', 'cancelled');
  }

  // After a coordinator restart: fence every active run first (no step or
  // model call is ever resumed), then collect the verified receipt for each.
  async function recover() {
    const fenced = workers.recover((runId) => {
      run(`UPDATE ops_agent_run_steps SET state='uncertain',error_code='COORDINATOR_RESTART',finished_at=?
        WHERE run_id=? AND state='reserved'`, stamp(), runId);
      run(`UPDATE ops_agent_model_calls SET state='uncertain',refusal_code='COORDINATOR_RESTART',finished_at=?
        WHERE run_id=? AND state='reserved'`, stamp(), runId);
      closeApprovals(runId, 'coordinator_restart');
      run(`UPDATE ops_agent_takeovers SET state='ended',ended_at=?,end_reason='coordinator_restart'
        WHERE run_id=? AND state!='ended'`, stamp(), runId);
    });
    const pending = all("SELECT id FROM ops_agent_runs WHERE state='cancelling'").map(row => row.id);
    const results = [];
    for (const runId of pending) {
      const fencedEvent = one(`SELECT kind FROM ops_agent_worker_events WHERE run_id=? AND kind LIKE 'fenced:%'
        ORDER BY id DESC LIMIT 1`, runId);
      const reason = fenced.includes(runId) ? 'failed' : (fencedEvent?.kind.slice(7) || 'failed');
      try {
        results.push(await terminate(runId, reason, fenced.includes(runId) ? 'interrupted' :
          reason === 'cancelled' ? 'cancelled' : 'interrupted', { needsHuman: true }));
      } catch (error) {
        results.push({ run_id: runId, error: codeOf(error) });
      }
    }
    note({ event: 'recovered', runs: pending.length });
    return results;
  }

  function status(actor, runId) {
    const r = runOf(runId);
    if (!r) fail('RUN_UNKNOWN');
    assertRunAccess(actor, r.project_id);
    return {
      run: { id: r.id, state: r.state, fence: r.fence, action_count: r.action_count, policy_digest: r.policy_digest,
        guide_hash: r.guide_hash, credential_binding_id: r.credential_binding_id,
        credential_binding_revision: r.credential_binding_revision },
      steps: all(`SELECT ordinal,action,decided_by,rule,model_call_id,approval_id,state,claims_json,error_code FROM
        ops_agent_run_steps WHERE run_id=? ORDER BY ordinal`, runId).map(s => ({ ...s, claims: JSON.parse(s.claims_json),
        claims_json: undefined })),
      model_calls: all(`SELECT call_id,state,choice,refusal_code,settled_usd,prompt_tokens,completion_tokens,
        price_table_revision,replayed FROM ops_agent_model_calls WHERE run_id=? ORDER BY created_at`, runId),
      approvals: all(`SELECT id,action,state,digest,decided_by,stale_reason FROM ops_agent_run_approvals WHERE run_id=?
        ORDER BY requested_at`, runId),
      events: all('SELECT kind,created_at FROM ops_agent_worker_events WHERE run_id=? ORDER BY id', runId),
      result: resultOf(runId),
    };
  }

  return { start, execute, approve, stop, recover, status, beginTakeover, holdTakeover, endTakeover, abandonTakeover,
    dropTakeover,
    workers };
}
