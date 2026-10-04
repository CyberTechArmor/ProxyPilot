import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { OperationsError, assertEligible, assertOperation, resolveOperationsRole, validId } from './operational-projects-logic.js';
import { SUBMIT, guideRules } from './operational-run-policy.js';
import { workerInstallResources } from './operational-worker-boundary.js';
import { DECISIONS, EXPECTED_RESULT, FIXTURE_MODES, critique, profileGate, runSubjects, summaryFacts } from './operational-recovery.js';
import { fromViewer, toViewer } from './operational-live-relay.js';

// A6 supervision service: what the Operations routes expose of A5 runs. It reads
// durable state through typed projections only (never a raw row, a receipt body,
// a prompt, page text, a value, a cookie or a token) and forwards the explicit
// human controls to the A5 coordinator unchanged. Without a coordinator (no
// supervisor configured, the default) every execution control fails closed with
// EXECUTION_UNAVAILABLE and the reads still show what is durable. The only live
// data is the browser frame (A6 decision: pixels only), kept in memory for a
// moment and never written to the database or a log.
//
// A7 adds practice runs (the demo's fixture mode set through an injected,
// audited fixture writer; one practice run at a time, alone on the demo), resume
// (a new run linked to one that needs a person, pinned to the same policy),
// reconciliation (a person's typed decision about each uncertain step or model
// call; an undecided uncertain write gates the profile), the rule-based critique
// and the run's model summary, read from durable state. It also relays the live
// view (Neko signalling only, filtered here and in the VM; the video and the
// input go over WebRTC through the TURN relay, never through the backend or its
// database) and hands a running attempt to one person (takeover), after the
// session's own agent-control verification. With the owner's consent, a
// finished run gets one model summary written from typed facts.
export class AgentRunError extends OperationsError {
  constructor(status, code, message, extra = {}) { super(status, message); this.code = code; this.extra = extra; }
}
const refuse = (status, code, message, extra) => { throw new AgentRunError(status, code, message, extra); };
export const AGENT_PILOT_ORIGIN = 'https://demo.fractionate.ai';
const DEMO_RETIRED_MESSAGE = 'Demo sign-in execution has been retired. Use the public or selected-site browser. Existing runs remain available for history and cleanup.';
const ACTIVE = ['prepared', 'starting', 'running', 'cancelling'];
const RUN_ROLES = ['operator', 'editor', 'reviewer'];
const HELP_CLASSES = new Set(['challenge_required', 'interrupted', 'uncertain_step', 'model_uncertain', 'taken_over',
  'timeout']);
const UNAVAILABLE = Object.freeze({
  flag_off: 'Agent runs are turned off on this installation.',
  not_configured: 'Execution is unavailable: no worker supervisor is configured on this installation.',
  invalid_configuration: 'Execution is unavailable: the worker supervisor configuration is incomplete or invalid.',
});
// Coordinator and store codes, in the words the UI shows. The code travels too.
const CODES = Object.freeze({
  ACTOR_NOT_ELIGIBLE: [403, 'An active, fully authenticated account is required.'],
  RUN_ACCESS_DENIED: [403, 'Agent runs need run access: owner, operator, editor or reviewer.'],
  ELEVATION_REQUIRED: [403, 'Approving needs a fresh sudo confirmation.'],
  INVALID_RUN: [400, 'Choose a profile (and its credential binding) to start.'],
  RUN_ALREADY_ACTIVE: [409, 'This profile already has an active run. Open it instead of starting another.'],
  RUN_UNKNOWN: [404, 'Agent run not found.'],
  STALE_CONFIGURATION: [409, 'The profile, its guide or the project site changed; the run cannot start or continue with it.'],
  INVALID_PROFILE_POLICY: [409, 'The profile\'s workflow or origins do not allow this run.'],
  INVALID_PROJECT_LIMITS: [409, 'The project limits are invalid.'],
  PROJECT_LIMIT_BELOW_WORKER_MINIMUM: [409, 'A project limit is below the worker minimum (1 CPU, 1024 MiB, 64 MiB disk).'],
  CREDENTIAL_BINDING_STALE: [409, 'The credential binding no longer matches this profile.'],
  CREDENTIAL_BINDING_REVOKED: [409, 'The credential binding was revoked.'],
  ACTION_NOT_CONFIGURED: [409, 'The profile does not allow typing a credential (the "type" action).'],
  GUIDE_RULES_MISSING: [409, 'The assigned guide has no hard-rules block.'],
  GUIDE_RULES_AMBIGUOUS: [409, 'The assigned guide has more than one hard-rules block.'],
  GUIDE_RULES_INVALID: [409, 'The assigned guide\'s hard-rules block is invalid.'],
  INVALID_POLICY: [409, 'The run policy could not be built from the profile.'],
  INVALID_APPROVAL: [400, 'Send the digest you were shown.'],
  APPROVAL_UNKNOWN: [404, 'Approval not found.'],
  APPROVAL_NOT_PENDING: [409, 'This approval is closed: it was already decided, used, expired or made stale.'],
  APPROVAL_DIGEST_MISMATCH: [409, 'The digest you were shown is not this approval\'s digest. Reload the approval.'],
  APPROVAL_STALE: [409, 'The approval is stale: the run, its binding, the guide or the policy changed after it was requested. The run does not submit.'],
  SUPERVISOR_UNREACHABLE: [503, 'The worker supervisor did not answer. A fenced run stays stopped; Stop again retries collecting its verified receipt.'],
  SUPERVISOR_TIMEOUT: [503, 'The worker supervisor did not answer in time. A fenced run stays stopped; Stop again retries collecting its verified receipt.'],
  SUPERVISOR_PROTOCOL: [503, 'The worker supervisor gave an answer that was refused. A fenced run stays stopped; Stop again retries.'],
  TEARDOWN_UNVERIFIED: [502, 'The teardown receipt did not verify, so the run stays fenced until a verified receipt arrives.'],
  RECONCILIATION_REQUIRED: [409, 'A sign-in or sign-out of an earlier run of this profile may or may not have happened. A person decides it on that run before the profile runs again.'],
  RESUME_UNKNOWN: [404, 'The run to resume was not found for this profile.'],
  RESUME_NOT_ALLOWED: [409, 'Only a run that ended needing a person can be resumed.'],
  RESUME_ALREADY_STARTED: [409, 'This run was already resumed. Open the resumed run instead.'],
  RESUME_STALE: [409, 'The profile, its guide, the binding or the policy changed since this run, so it cannot be resumed with the same pins. Start a new run instead.'],
  PRACTICE_BUSY: [409, 'Another agent run is active. A practice run changes how the demo signs in the synthetic account, so it runs alone.'],
  PRACTICE_ACTIVE: [409, 'A practice run is active. It has put the demo into a fixture mode, so no other run starts until it ends.'],
  FIXTURE_UNAVAILABLE: [503, 'Practice runs are unavailable: no demo fixture writer is configured on this installation.'],
  FIXTURE_FAILED: [502, 'The demo fixture mode could not be set, so the practice run was not started.'],
  FIXTURE_NOT_RESET: [409, 'The demo is still in a practice fixture mode and could not be reset. No run starts until it is.'],
  TAKEOVER_NOT_RUNNING: [409, 'Only a running agent run can be taken over.'],
  TAKEOVER_HELD: [409, 'Someone already holds this run. There is one controller at a time.'],
  TAKEOVER_NOT_YOURS: [403, 'Only the person who took over can end the takeover; Stop ends the run for anyone with run access.'],
  TAKEOVER_NONE: [409, 'Nobody holds this run.'],
  TAKEOVER_STARTING: [409, 'Control is still being handed over. Try again in a moment.'],
  TAKEOVER_VIEWER_UNKNOWN: [409, 'Open the live view of this run first: control is handed to the view you are watching.'],
  TAKEOVER_FAILED: [502, 'The browser could not be handed to you. The agent\'s run was stopped and can be resumed.'],
  LIVE_UNAVAILABLE: [409, 'The live view is not available for this run; the still frames are shown instead.'],
  LIVE_BUSY: [409, 'Too many people are watching this run live. Try again when someone closes their view.'],
  RECONCILE_SUBJECT_UNKNOWN: [404, 'That step or model call has no decision to make.'],
  RECONCILE_DECISION_INVALID: [400, 'Choose one of the decisions offered for this item.'],
});
const toRunError = (error) => {
  if (error instanceof OperationsError) return error;
  const code = typeof error?.code === 'string' ? error.code : null;
  const [status, message] = CODES[code] ?? [500, 'Unable to complete the agent run request.'];
  return new AgentRunError(status, code && CODES[code] ? code : 'INTERNAL', message);
};
const uuid = z.string().uuid();
const schemas = {
  start: z.object({ profile_id: uuid, credential_binding_id: uuid.nullable().optional(),
    practice: z.object({ fixture_mode: z.enum(FIXTURE_MODES) }).strict().optional() }).strict(),
  reconcile: z.object({ subject: z.string().regex(/^(step:[1-9][0-9]{0,2}|call:[0-9a-f-]{36}|run)$/),
    decision: z.enum([...DECISIONS, 'acknowledged']) }).strict(),
  approve: z.object({ digest: z.string().regex(/^[0-9a-f]{64}$/), confirmation: z.string().max(200) }).strict(),
  takeover: z.object({ viewer: z.string().regex(/^[0-9a-f]{16}$/) }).strict(),
  list: z.object({ before: z.string().datetime().optional() }).strict(),
};
const parse = (schema, input, code, message) => {
  const result = schema.safeParse(input ?? {});
  if (!result.success) refuse(400, code, message);
  return result.data;
};
// A person may type the digest with spaces or in capitals; any correct prefix of
// at least 12 characters is accepted (A5 lesson: 13 correct characters are fine).
export function digestConfirmation(digest, typed) {
  const value = String(typed ?? '').replace(/\s+/g, '').toLowerCase();
  return value.length >= 12 && value.length <= 64 && /^[0-9a-f]+$/.test(value) && digest.startsWith(value);
}
function receiptKeyId(attestation) {
  try {
    const payload = JSON.parse(Buffer.from(String(attestation).split('.')[1], 'base64url').toString('utf8'));
    return typeof payload.key_id === 'string' && /^[0-9a-f]{64}$/.test(payload.key_id) ? payload.key_id : null;
  } catch { return null; }
}

// `fixtures` (A7) sets the demo's fixture mode for practice runs:
// { apply(mode) -> Promise }. Without it, practice runs are unavailable.
// `audit(actor, action, details)` records the human decisions A7 adds.
// Supervisor codes that leave it unknown whether a model summary call reached
// the provider: the reserved summary becomes `uncertain`, never retried.
const SUMMARY_UNCERTAIN = new Set(['SUPERVISOR_TIMEOUT', 'SUPERVISOR_UNREACHABLE', 'SUPERVISOR_PROTOCOL', 'INTERNAL',
  'CREDENTIAL_BROKER_UNAVAILABLE', 'CHANNEL_CLOSED']);
export function createAgentRunService({ db, coordinator = null, launcher = null, unavailableReason = 'not_configured',
  clock = () => new Date(), log = () => {}, frameMs = 1500, stopWaitMs = 1500, fixtures = null,
  audit = () => {}, renewMs = 10_000 } = {}) {
  const one = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const available = !!(coordinator && launcher);
  const reason = available ? null : (UNAVAILABLE[unavailableReason] ? unavailableReason : 'not_configured');
  const execution = Object.freeze({ available, reason, message: available ? null : UNAVAILABLE[reason] });
  const executing = new Map(), frames = new Map(), viewing = new Map();
  // A7: open live viewers (viewer id -> who, which run, the relay handle) and
  // the lease renewal of a held takeover (run id -> timer). Memory only.
  const lives = new Map(), renewals = new Map();
  let practicePending = false;
  const note = (entry) => { try { log({ at: clock().toISOString(), ...entry }); } catch { /* never changes a run */ } };
  const unavailable = () => refuse(503, 'EXECUTION_UNAVAILABLE', execution.message, { reason: execution.reason });
  const username = id => (id && one('SELECT username FROM users WHERE id=?', id)?.username) || null;

  // Operations semantics: an outsider sees 404, a member without the action 403.
  function access(actor, projectId, action) {
    assertEligible(actor, actor?.id ? one('SELECT id,role FROM users WHERE id=?', actor.id) : null);
    if (!validId(projectId)) refuse(404, 'NOT_FOUND', 'Operational record not found');
    const p = one('SELECT * FROM ops_projects WHERE id=?', projectId);
    if (!p) refuse(404, 'NOT_FOUND', 'Operational record not found');
    const grant = one('SELECT role FROM ops_project_grants WHERE project_id=? AND user_id=?', projectId, actor.id);
    const role = resolveOperationsRole(p, actor.id, grant);
    try { assertOperation(role, action, !!p.archived_at); }
    catch (error) {
      if (error.status === 403 && action === 'run') refuse(403, 'RUN_ACCESS_DENIED', CODES.RUN_ACCESS_DENIED[1]);
      throw error;
    }
    return { p, role };
  }
  function runIn(projectId, runId) {
    const r = validId(runId) && one(`SELECT r.* FROM ops_agent_runs r JOIN ops_agent_run_pins pin ON pin.run_id=r.id
      WHERE r.id=? AND r.project_id=?`, runId, projectId);
    if (!r) refuse(404, 'RUN_UNKNOWN', CODES.RUN_UNKNOWN[1]);
    return r;
  }
  const currentGuide = projectId => {
    const v = one('SELECT id,version_number,content_hash FROM ops_guide_versions WHERE project_id=? ORDER BY version_number DESC LIMIT 1', projectId);
    return v && !one('SELECT 1 FROM ops_version_withdrawals WHERE project_id=? AND version_id=?', projectId, v.id) ? v : null;
  };
  const assignedRules = (projectId, profile) => {
    if (!profile.guide_version_id) return { rules: null, refusal: 'NO_GUIDE' };
    const guide = one(`SELECT s.instructions FROM ops_guide_versions v JOIN ops_guide_submissions s ON s.id=v.submission_id
      AND s.project_id=v.project_id WHERE v.project_id=? AND v.id=?`, projectId, profile.guide_version_id);
    try { return { rules: guideRules(guide?.instructions), refusal: null }; }
    catch (error) { return { rules: null, refusal: error.code ?? 'GUIDE_RULES_INVALID' }; }
  };
  const activeBinding = profileId => one(`SELECT id,revision,username FROM ops_agent_credential_bindings
    WHERE profile_id=? AND state='active'`, profileId);

  // Why a profile cannot start, in words; empty means Start can act.
  function readiness(p, row) {
    const reasons = [DEMO_RETIRED_MESSAGE];
    if (!execution.available) reasons.push(execution.message);
    if (p.archived_at) reasons.push('The operation is archived.');
    if (!p.site_origin) reasons.push('The project site is not set.');
    else if (p.site_origin !== AGENT_PILOT_ORIGIN) reasons.push(`Only ${AGENT_PILOT_ORIGIN} is supported in this pilot.`);
    let origins = [], actions = [];
    try { origins = JSON.parse(row.proposed_origins_json); actions = JSON.parse(row.proposed_actions_json); } catch { /* reported below */ }
    if (p.site_origin && !origins.includes(p.site_origin)) reasons.push('The project site is outside the profile\'s proposed origins.');
    const current = currentGuide(p.id);
    if (!row.guide_version_id) reasons.push('No guide is assigned.');
    else if (current?.id !== row.guide_version_id || current?.content_hash !== row.guide_hash)
      reasons.push('The assigned guide is no longer the current approved version.');
    else if (row.assigned_site_revision !== p.site_revision) reasons.push('The project site changed since the guide was assigned.');
    const { rules, refusal } = assignedRules(p.id, row);
    if (row.guide_version_id && refusal) reasons.push(CODES[refusal]?.[1] ?? CODES.GUIDE_RULES_INVALID[1]);
    const binding = activeBinding(row.id);
    const submits = rules && (rules.start.includes(SUBMIT) || rules.model_actions.includes(SUBMIT));
    if (submits && !binding) reasons.push('No active credential binding: the host operator binds the synthetic account first.');
    if (submits && !actions.includes('type')) reasons.push(CODES.ACTION_NOT_CONFIGURED[1]);
    if (rules?.model && rules.max_model_calls > 0 && row.model_guide_consent !== 1)
      reasons.push('The owner has not consented to sending this profile\'s guide to the model provider.');
    try { workerInstallResources(JSON.parse(p.agent_limits_json)); }
    catch (error) { reasons.push((CODES[error.code] ?? CODES.INVALID_PROJECT_LIMITS)[1]); }
    const active = one(`SELECT id FROM ops_agent_runs WHERE profile_id=? AND state IN (${ACTIVE.map(() => '?').join(',')})`,
      row.id, ...ACTIVE);
    if (active) reasons.push('A run is already active for this profile.');
    const gate = profileGate(db, row.id);
    if (gate) reasons.push(`A sign-in or sign-out in run ${gate.run_id.slice(0, 8)} may or may not have happened. Decide it on that run first.`);
    const practice = activePractice();
    if (practice && !active) reasons.push('A practice run is active; no other run starts until it ends.');
    const practiceReasons = [...reasons];
    if (!fixtures) practiceReasons.push(CODES.FIXTURE_UNAVAILABLE[1]);
    if (!practice && !active && anyActive()) practiceReasons.push('A practice run runs alone, and another agent run is active.');
    return { profile_id: row.id, display_name: row.display_name, ready: reasons.length === 0, reasons,
      practice_ready: practiceReasons.length === 0, practice_reasons: practiceReasons, reconcile_run_id: gate?.run_id ?? null,
      active_run_id: active?.id ?? null, model_guide_consent: row.model_guide_consent === 1,
      model_summary_consent: row.model_summary_consent === 1,
      binding: binding ? { binding_id: binding.id, revision: binding.revision, username: binding.username } : null };
  }

  // A help request names the decision: its own class when that class is one a
  // person must decide, otherwise the uncertain step that made it one.
  function help(result) {
    if (!result || result.needs_human !== 1) return null;
    const state = runSubjects(db, result.run_id);
    const resumed = one('SELECT run_id FROM ops_agent_run_origins WHERE resumed_from_run_id=?', result.run_id);
    return { result_class: HELP_CLASSES.has(result.result_class) ? result.result_class : 'uncertain_step',
      uncertain_steps: result.uncertain_steps, open: state.open && !resumed, gating: state.gating.length > 0,
      resumed_as: resumed?.run_id ?? null };
  }
  const originOf = (runId) => {
    const o = one('SELECT practice,fixture_mode,resumed_from_run_id FROM ops_agent_run_origins WHERE run_id=?', runId);
    const next = one('SELECT run_id FROM ops_agent_run_origins WHERE resumed_from_run_id=?', runId);
    return { practice: o?.practice === 1, fixture_mode: o?.fixture_mode ?? null, resumed_from_run_id: o?.resumed_from_run_id ?? null,
      resumed_as_run_id: next?.run_id ?? null,
      expected_result: o?.practice === 1 ? EXPECTED_RESULT[o.fixture_mode] ?? null : null };
  };
  const activePractice = () => one(`SELECT r.id FROM ops_agent_runs r JOIN ops_agent_run_origins o ON o.run_id=r.id
    WHERE o.practice=1 AND r.state IN (${ACTIVE.map(() => '?').join(',')})`, ...ACTIVE) ?? (practicePending ? { id: null } : null);
  const anyActive = () => !!one(`SELECT 1 FROM ops_agent_runs WHERE state IN (${ACTIVE.map(() => '?').join(',')})`, ...ACTIVE);
  const takeoversOf = runId => all(`SELECT t.*, u.username FROM ops_agent_takeovers t LEFT JOIN users u ON u.id=t.user_id
    WHERE t.run_id=? ORDER BY t.started_at`, runId).map(t => ({ id: t.id, state: t.state, user: t.username ?? t.user_id,
    user_id: t.user_id, started_at: t.started_at, control_at: t.control_at, ended_at: t.ended_at, end_reason: t.end_reason,
    inputs: JSON.parse(t.inputs_json) }));
  const summaryOf = runId => {
    const row = one('SELECT * FROM ops_agent_run_summaries WHERE run_id=?', runId);
    return row ? { state: row.state, text: row.summary_text, refusal_code: row.refusal_code, prompt_tokens: row.prompt_tokens,
      completion_tokens: row.completion_tokens, settled_usd: row.settled_usd, created_at: row.created_at } : null;
  };
  const resultView = (row) => !row ? null : ({ final_state: row.final_state, result_class: row.result_class,
    verified_account: row.verified_account === 1, needs_human: row.needs_human === 1, steps: row.steps,
    rule_steps: row.rule_steps, model_steps: row.model_steps, model_calls: row.model_calls,
    uncertain_steps: row.uncertain_steps, binding_id: row.binding_id, binding_revision: row.binding_revision,
    submit_outcome: row.submit_outcome, logout: row.logout, created_at: row.created_at,
    // Stored only after the store verified the signature: "verified" plus its key.
    receipt: row.receipt_attestation ? { verified: true, key_id: receiptKeyId(row.receipt_attestation) } : { verified: false, key_id: null } });
  const approvalView = (a, runState) => ({ id: a.id, action: a.action, state: a.state, run_id: a.run_id,
    attempt_id: a.attempt_id, fence: a.fence, binding_id: a.binding_id, binding_revision: a.binding_revision,
    guide_hash: a.guide_hash, policy_digest: a.policy_digest, origin: a.origin, digest: a.digest,
    requested_at: a.requested_at, decided_by: a.decided_by ? { id: a.decided_by, username: username(a.decided_by) } : null,
    decided_at: a.decided_at, closed_at: a.closed_at, stale_reason: a.stale_reason,
    open: a.state === 'requested' && runState === 'running' });
  function summary(r) {
    const pin = one('SELECT started_by FROM ops_agent_run_pins WHERE run_id=?', r.id);
    const result = one('SELECT * FROM ops_agent_run_results WHERE run_id=?', r.id);
    const open = one("SELECT id FROM ops_agent_run_approvals WHERE run_id=? AND state='requested'", r.id);
    const profile = one('SELECT display_name FROM ops_agent_profiles WHERE id=?', r.profile_id);
    return { id: r.id, project_id: r.project_id, profile_id: r.profile_id, profile_name: profile?.display_name ?? null,
      state: r.state, started_at: r.started_at, updated_at: r.updated_at, action_count: r.action_count,
      started_by: { id: pin?.started_by ?? null, username: username(pin?.started_by) },
      result_class: result?.result_class ?? null, final_state: result?.final_state ?? null,
      needs_human: result?.needs_human === 1, awaiting_approval: !!open && r.state === 'running',
      help: help(result), origin: originOf(r.id) };
  }
  function detail(r) {
    const v = one('SELECT version_number FROM ops_guide_versions WHERE project_id=? AND id=?', r.project_id, r.guide_version_id);
    const result = one('SELECT * FROM ops_agent_run_results WHERE run_id=?', r.id);
    const running = r.state === 'running';
    const base = summary(r);
    const view = { run: base,
      steps: all(`SELECT ordinal,action,decided_by,rule,model_call_id,approval_id,state,claims_json,error_code,created_at,
        finished_at FROM ops_agent_run_steps WHERE run_id=? ORDER BY ordinal`, r.id)
        .map(({ claims_json, ...s }) => ({ ...s, claims: JSON.parse(claims_json) })),
      model_calls: all(`SELECT call_id,step_ordinal,allowed_json,state,choice,refusal_code,settled_usd,prompt_tokens,
        completion_tokens,replayed,created_at,finished_at FROM ops_agent_model_calls WHERE run_id=? ORDER BY created_at,call_id`, r.id)
        .map(({ allowed_json, replayed, ...c }) => ({ ...c, allowed: JSON.parse(allowed_json), replayed: replayed === 1 })),
      approvals: all('SELECT * FROM ops_agent_run_approvals WHERE run_id=? ORDER BY requested_at,id', r.id)
        .map(a => approvalView(a, r.state)), result: resultView(result) };
    const reconciliation = result ? runSubjects(db, r.id) : null;
    const takeovers = takeoversOf(r.id);
    const origin = base.origin;
    return {
      run: { ...base, fence: r.fence, deadline_at: r.deadline_at, policy_digest: r.policy_digest,
        guide_hash: r.guide_hash, guide_version_id: r.guide_version_id, guide_version_number: v?.version_number ?? null,
        max_actions: r.max_actions, credential_binding_id: r.credential_binding_id,
        credential_binding_revision: r.credential_binding_revision },
      steps: view.steps, model_calls: view.model_calls, approvals: view.approvals,
      events: all('SELECT id,kind,created_at FROM ops_agent_worker_events WHERE run_id=? ORDER BY id', r.id),
      result: view.result,
      origin, takeovers, reconciliation: reconciliation ? { open: reconciliation.open, items: reconciliation.items } : null,
      critique: critique({ ...view, origin, takeovers, reconciliation }),
      summary: summaryOf(r.id),
      controls: {
        // A fenced run whose receipt has not arrived (the supervisor was
        // unreachable) may be stopped again: the coordinator retries the
        // teardown and never resumes the run.
        stop: execution.available && ACTIVE.includes(r.state) ? { enabled: true, reason: null, retry: r.state === 'cancelling' }
          : { enabled: false, reason: !execution.available ? execution.message : 'The run has ended.' },
        view: execution.available && running ? { enabled: true, reason: null }
          : { enabled: false, reason: !execution.available ? execution.message
            : r.state === 'prepared' || r.state === 'starting' ? 'The browser is starting.' : 'The browser is gone: the run is not running.' },
        resume: { enabled: false, reason: DEMO_RETIRED_MESSAGE },
        reconcile: reconciliation?.items.length ? { enabled: true, reason: null }
          : { enabled: false, reason: result ? 'Nothing in this run needs a decision.' : 'The run has not ended.' },
        live: execution.available && running ? { enabled: true, reason: null }
          : { enabled: false, reason: !execution.available ? execution.message : 'The browser is not running.' },
        takeover: takeoverControl(r, takeovers),
      },
      execution,
    };
  }
  function takeoverControl(r, takeovers) {
    if (!execution.available) return { enabled: false, reason: execution.message, holder: null };
    const held = takeovers.find(t => t.state === 'taking' || t.state === 'holding');
    if (held) return { enabled: false, reason: `${held.user} has control.`, holder: { user_id: held.user_id, user: held.user,
      state: held.state, since: held.control_at ?? held.started_at } };
    return r.state === 'running' ? { enabled: true, reason: null, holder: null }
      : { enabled: false, reason: 'Only a running agent run can be taken over.', holder: null };
  }
  // The execute loop runs in the background; its failures are already durable
  // results, so here they are only logged (codes, never messages from a page).
  // The demo leaves a practice fixture mode only when told to. A failure is
  // recorded (applied 0) and the next start tries the reset again first.
  async function setFixture(mode, runId, actorId) {
    let applied = 0;
    try { await fixtures.apply(mode); applied = 1; }
    catch (error) { note({ event: 'fixture_failed', mode, code: toRunError(error).code }); }
    db.prepare(`INSERT INTO ops_agent_fixture_state(id,mode,run_id,set_by,set_at,applied) VALUES(1,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET mode=excluded.mode,run_id=excluded.run_id,set_by=excluded.set_by,set_at=excluded.set_at,
      applied=excluded.applied`).run(mode, runId, actorId, clock().toISOString(), applied);
    audit(actorId ? { id: actorId } : null, 'AGENT_PRACTICE_FIXTURE', { mode, run_id: runId, applied: applied === 1 });
    return applied === 1;
  }
  async function fixtureReset() {
    const state = one('SELECT mode,applied FROM ops_agent_fixture_state WHERE id=1');
    if (!state || (state.mode === 'normal' && state.applied === 1)) return true;
    if (!fixtures) return false;
    return setFixture('normal', null, null);
  }
  function background(runId) {
    const practice = one('SELECT practice FROM ops_agent_run_origins WHERE run_id=?', runId)?.practice === 1;
    const work = coordinator.execute(runId)
      .then(result => note({ event: 'agent_run_finished', run_id: runId, result_class: result?.result_class ?? null }))
      .catch(error => note({ event: 'agent_run_error', run_id: runId, code: toRunError(error).code }))
      .then(() => (practice ? fixtureReset() : null))
      .then(() => summarize(runId))
      .catch(error => note({ event: 'agent_run_summary_error', run_id: runId, code: toRunError(error).code }))
      .finally(() => { executing.delete(runId); frames.delete(runId); stopRenewal(runId); });
    executing.set(runId, work);
    return work;
  }
  // A7 decision 5: with the profile owner's consent, one model summary of the
  // finished run from typed facts only. Reserved first (one per run, immutable
  // once decided); a transport failure leaves it `uncertain` and it is never
  // sent again.
  async function summarize(runId) {
    if (!execution.available || typeof launcher.summarize !== 'function') return null;
    const r = one('SELECT * FROM ops_agent_runs WHERE id=?', runId);
    const consent = r && one('SELECT model_summary_consent FROM ops_agent_profiles WHERE id=?', r.profile_id);
    if (consent?.model_summary_consent !== 1) return null;
    if (one('SELECT 1 FROM ops_agent_run_summaries WHERE run_id=?', runId)) return null;
    const view = detail(runIn(r.project_id, runId));
    if (!view.result) return null;
    const facts = summaryFacts(view);
    const callId = randomUUID();
    try {
      db.prepare(`INSERT INTO ops_agent_run_summaries(run_id,call_id,state,created_at) VALUES(?,?,'reserved',?)`)
        .run(runId, callId, clock().toISOString());
    } catch { return null; }
    try {
      const out = await launcher.summarize({ run_id: runId, call_id: callId, facts });
      db.prepare(`UPDATE ops_agent_run_summaries SET state='written',summary_text=?,prompt_tokens=?,completion_tokens=?,
        settled_usd=?,price_table_revision=?,finished_at=? WHERE run_id=? AND state='reserved'`)
        .run(out.text, out.prompt_tokens, out.completion_tokens, out.settled_usd, out.price_table_revision,
          clock().toISOString(), runId);
      note({ event: 'agent_run_summary', run_id: runId, state: 'written' });
      return 'written';
    } catch (error) {
      const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? error.code : 'INTERNAL';
      const state = SUMMARY_UNCERTAIN.has(code) ? 'uncertain' : 'refused';
      db.prepare(`UPDATE ops_agent_run_summaries SET state=?,refusal_code=?,finished_at=? WHERE run_id=? AND state='reserved'`)
        .run(state, code, clock().toISOString(), runId);
      note({ event: 'agent_run_summary', run_id: runId, state, code });
      return state;
    }
  }

  // A7 takeover lease: while a person holds the attempt, the backend renews its
  // lease (the agent's heartbeat stopped when it saw the takeover). It stops as
  // soon as the takeover is no longer held or the supervisor refuses.
  function startRenewal(runId, ref) {
    stopRenewal(runId);
    const timer = setInterval(() => {
      const held = one("SELECT 1 FROM ops_agent_takeovers WHERE run_id=? AND fence=? AND state='holding'", runId, ref.fence);
      if (!held) return stopRenewal(runId);
      launcher.renew(ref).catch((error) => {
        note({ event: 'takeover_renew_failed', run_id: runId, code: toRunError(error).code });
        stopRenewal(runId);
      });
      return undefined;
    }, renewMs);
    timer.unref?.();
    renewals.set(runId, timer);
  }
  function stopRenewal(runId) {
    const timer = renewals.get(runId);
    if (timer) clearInterval(timer);
    renewals.delete(runId);
  }
  // A viewer went away (closed tab, lost network, revoked access, the attempt
  // ended). Whoever held control through that view gives it up: the takeover
  // ends and the run ends taken_over, needing a person (it can be resumed).
  function viewerGone(entry, reason) {
    if (!entry || entry.gone) return;
    entry.gone = true;
    lives.delete(entry.viewer);
    note({ event: 'live_closed', run_id: entry.runId, reason: String(reason).slice(0, 32) });
    if (!entry.holding) return;
    finishTakeover({ id: entry.actorId }, entry.runId, 'viewer_left', { system: true })
      .catch(error => note({ event: 'takeover_end_error', run_id: entry.runId, code: toRunError(error).code }));
  }
  async function finishTakeover(actor, runId, reason, { system = false } = {}) {
    const t = one("SELECT * FROM ops_agent_takeovers WHERE run_id=? AND state IN ('taking','holding')", runId);
    if (!t) return null;
    if (!system && t.user_id !== actor.id) refuse(403, 'TAKEOVER_NOT_YOURS', CODES.TAKEOVER_NOT_YOURS[1]);
    if (!system && t.state === 'taking') refuse(409, 'TAKEOVER_STARTING', CODES.TAKEOVER_STARTING[1]);
    stopRenewal(runId);
    for (const entry of lives.values()) if (entry.runId === runId) entry.holding = false;
    let inputs = null;
    if (t.state === 'holding') {
      try { inputs = (await launcher.release({ run_id: runId, attempt_id: t.attempt_id, fence: t.fence })).inputs; }
      catch (error) { note({ event: 'takeover_release_failed', run_id: runId, code: toRunError(error).code }); }
    }
    const ending = system ? coordinator.dropTakeover(t.id, { reason, inputs }) : coordinator.endTakeover(actor, runId, { reason, inputs });
    const outcome = ending.then(() => ({ done: true }), error => ({ error }));
    outcome.then(({ error }) => { if (error) note({ event: 'takeover_end_error', run_id: runId, code: toRunError(error).code }); });
    audit(actor, 'AGENT_RUN_TAKEOVER_ENDED', { run_id: runId, reason, inputs });
    const first = await Promise.race([outcome, new Promise(done => { setTimeout(done, stopWaitMs, null).unref?.(); })]);
    if (first?.error) throw toRunError(first.error);
    return !first;
  }
  function runningRef(r) {
    if (r.state !== 'running') return null;
    const attempt = one("SELECT id,fence FROM ops_agent_worker_attempts WHERE run_id=? AND state='running'", r.id);
    return attempt && attempt.fence === r.fence ? { run_id: r.id, attempt_id: attempt.id, fence: r.fence } : null;
  }

  // Start, practice start and resume share one path. A practice mode is set on
  // the demo before the run is pinned (and the run is refused if it cannot be);
  // any other start first makes sure no practice mode is left behind.
  async function launch(actor, projectId, input, origin, mode) {
    if (mode) {
      practicePending = true;
      try {
        if (!(await setFixture(mode, null, actor.id))) {
          await fixtureReset();
          refuse(502, 'FIXTURE_FAILED', CODES.FIXTURE_FAILED[1]);
        }
      } catch (error) { practicePending = false; throw error; }
    } else if (!(await fixtureReset())) refuse(409, 'FIXTURE_NOT_RESET', CODES.FIXTURE_NOT_RESET[1]);
    let started;
    try {
      started = coordinator.start({ id: actor.id }, input, origin);
    } catch (error) {
      if (mode) { practicePending = false; await fixtureReset(); }
      const mapped = toRunError(error);
      if (mapped.code === 'RUN_ALREADY_ACTIVE') {
        const active = one(`SELECT id FROM ops_agent_runs WHERE profile_id=? AND project_id=? AND state IN (${ACTIVE.map(() => '?').join(',')})`,
          input.profile_id, projectId, ...ACTIVE);
        mapped.extra = { active_run_id: active?.id ?? null };
      }
      if (mapped.code === 'RECONCILIATION_REQUIRED') mapped.extra = { run_id: typeof error.detail === 'string' ? error.detail : null };
      if (mapped.code === 'RESUME_STALE') mapped.extra = { stale_reason: typeof error.detail === 'string' ? error.detail : null };
      throw mapped;
    }
    practicePending = false;
    if (mode) db.prepare('UPDATE ops_agent_fixture_state SET run_id=? WHERE id=1').run(started.run_id);
    note({ event: 'agent_run_started', run_id: started.run_id, by: actor.id, practice: !!mode });
    background(started.run_id);
    return detail(runIn(projectId, started.run_id));
  }

  return {
    execution,
    // Public routes never reach the dormant legacy launch methods below. Keep
    // those methods for historical lifecycle fixtures; they have no wire entry.
    rejectNewDemoRun(actor, projectId, runId = null) {
      access(actor, projectId, 'run');
      if (runId !== null) runIn(projectId, runId);
      refuse(410, 'DEMO_EXECUTION_RETIRED', DEMO_RETIRED_MESSAGE);
    },
    capabilities: () => ({ agent_runs_enabled: true, agent_execution_available: execution.available,
      agent_execution_reason: execution.reason, agent_execution_message: execution.message }),
    list(actor, projectId, input = {}) {
      const { p, role } = access(actor, projectId, 'run');
      const q = parse(schemas.list, input, 'INVALID_QUERY', 'Invalid agent run query.');
      const rows = all(`SELECT r.* FROM ops_agent_runs r JOIN ops_agent_run_pins pin ON pin.run_id=r.id
        WHERE r.project_id=? AND (? IS NULL OR r.started_at < ?) ORDER BY r.started_at DESC, r.id DESC LIMIT 26`,
      projectId, q.before ?? null, q.before ?? null);
      const profiles = all('SELECT * FROM ops_agent_profiles WHERE project_id=? AND deleted_at IS NULL ORDER BY display_name,id', projectId);
      return { own_role: role, execution, runs: rows.slice(0, 25).map(summary),
        next_before: rows.length > 25 ? rows[24].started_at : null, profiles: profiles.map(row => readiness(p, row)) };
    },
    status(actor, projectId, runId) {
      access(actor, projectId, 'run');
      return detail(runIn(projectId, runId));
    },
    // A8: the existing run-detail HTTP projection alone reads host records.
    // Internal status remains synchronous; controls never depend on this read.
    async statusWithRecords(actor, projectId, runId) {
      access(actor, projectId, 'run');
      const view = detail(runIn(projectId, runId));
      const items = view.reconciliation?.items ?? [];
      const steps = items.filter(i => i.subject.startsWith('step:'));
      // Four bounded reads at a time; no lease renewal, journal write or replay.
      for (let offset = 0; offset < steps.length; offset += 4) {
        await Promise.all(steps.slice(offset, offset + 4).map(async item => {
          item.supervisor_record = { status: 'unavailable', record: null };
          if (!execution.available || typeof launcher.stepRecord !== 'function') return;
          const step = one(`SELECT attempt_id,fence,ordinal,action FROM ops_agent_run_steps
            WHERE run_id=? AND ordinal=?`, runId, item.ordinal);
          if (!step || step.action !== item.action) return;
          try {
            const record = await launcher.stepRecord({ run_id: runId, ...step });
            item.supervisor_record = { status: record === null ? 'missing' : 'recorded', record };
          } catch { /* No error content or partial host reply reaches the page. */ }
        }));
      }
      // A grant or account can be revoked while a socket read is pending.
      access(actor, projectId, 'run');
      return view;
    },
    async start(actor, projectId, input) {
      const v = parse(schemas.start, input, 'INVALID_RUN', CODES.INVALID_RUN[1]);
      access(actor, projectId, 'run');
      if (!execution.available) unavailable();
      const practice = v.practice ?? null;
      if (practice) {
        if (!fixtures) refuse(503, 'FIXTURE_UNAVAILABLE', CODES.FIXTURE_UNAVAILABLE[1]);
        if (activePractice() || anyActive()) refuse(409, 'PRACTICE_BUSY', CODES.PRACTICE_BUSY[1]);
      } else if (activePractice()) refuse(409, 'PRACTICE_ACTIVE', CODES.PRACTICE_ACTIVE[1]);
      const started = await launch(actor, projectId, { project_id: projectId, profile_id: v.profile_id,
        ...(v.credential_binding_id ? { credential_binding_id: v.credential_binding_id } : {}) },
      practice ? { practice: true, fixture_mode: practice.fixture_mode } : null, practice?.fixture_mode ?? null);
      if (practice) audit(actor, 'AGENT_PRACTICE_RUN_STARTED', { project_id: projectId, run_id: started.run.id,
        fixture_mode: practice.fixture_mode });
      return started;
    },
    // A7 decision 2: a new run linked to one that needed a person, pinned to its
    // exact policy, profile, guide and binding revisions, from step 1 in a fresh
    // browser. It is never the old attempt, and it asks for its own approval.
    async resume(actor, projectId, runId) {
      access(actor, projectId, 'run');
      const r = runIn(projectId, runId);
      if (!execution.available) unavailable();
      const origin = one('SELECT practice,fixture_mode FROM ops_agent_run_origins WHERE run_id=?', runId);
      const mode = origin?.practice === 1 ? origin.fixture_mode : null;
      if (mode && !fixtures) refuse(503, 'FIXTURE_UNAVAILABLE', CODES.FIXTURE_UNAVAILABLE[1]);
      if (mode ? (activePractice() || anyActive()) : activePractice())
        refuse(409, mode ? 'PRACTICE_BUSY' : 'PRACTICE_ACTIVE', CODES[mode ? 'PRACTICE_BUSY' : 'PRACTICE_ACTIVE'][1]);
      const started = await launch(actor, projectId, { project_id: projectId, profile_id: r.profile_id,
        ...(r.credential_binding_id ? { credential_binding_id: r.credential_binding_id } : {}) }, { resumed_from: runId }, mode);
      audit(actor, 'AGENT_RUN_RESUMED', { project_id: projectId, run_id: runId, resumed_as: started.run.id });
      return started;
    },
    // A7 decision 3: a person's typed decision about one uncertain step, model
    // call or help request. Nothing is re-sent; the decision is recorded,
    // audited, and (for a write) lifts the profile's Start gate unless "unknown".
    reconcile(actor, projectId, runId, input, { verified = false } = {}) {
      const v = parse(schemas.reconcile, input, 'RECONCILE_DECISION_INVALID', CODES.RECONCILE_DECISION_INVALID[1]);
      access(actor, projectId, 'run');
      runIn(projectId, runId);
      if (!verified) refuse(401, 'CONTROL_VERIFICATION_REQUIRED',
        'Confirm it is you (password and authenticator code, or a passkey) once in this session to decide agent runs.',
        { control_verification_required: true });
      const state = runSubjects(db, runId);
      const item = state.items.find(i => i.subject === v.subject);
      if (!item) refuse(404, 'RECONCILE_SUBJECT_UNKNOWN', CODES.RECONCILE_SUBJECT_UNKNOWN[1]);
      if ((item.kind === 'run') !== (v.decision === 'acknowledged'))
        refuse(400, 'RECONCILE_DECISION_INVALID', CODES.RECONCILE_DECISION_INVALID[1]);
      const at = clock().toISOString();
      db.prepare(`INSERT INTO ops_agent_reconciliations(id,run_id,subject,kind,decision,decided_by,decided_at)
        VALUES(?,?,?,?,?,?,?)`).run(randomUUID(), runId, v.subject, item.kind, v.decision, actor.id, at);
      db.prepare('INSERT INTO ops_agent_worker_events(run_id,attempt_id,kind,created_at) VALUES(?,?,?,?)')
        .run(runId, null, `a7:reconciled:${item.kind}:${v.decision}`, at);
      audit(actor, 'AGENT_RUN_RECONCILED', { project_id: projectId, run_id: runId, subject: v.subject, kind: item.kind,
        decision: v.decision });
      note({ event: 'reconciled', run_id: runId, subject: v.subject, decision: v.decision });
      return detail(runIn(projectId, runId));
    },
    async stop(actor, projectId, runId) {
      access(actor, projectId, 'run');
      const r = runIn(projectId, runId);
      if (!execution.available) unavailable();
      if (!ACTIVE.includes(r.state)) return { ...detail(r), stopping: false };
      // The fence is synchronous; collecting the verified receipt may take the
      // supervisor a while, so the answer does not wait for more than a moment.
      const outcome = coordinator.stop({ id: actor.id }, runId).then(() => ({ done: true }), error => ({ error }));
      outcome.then(({ error }) => { if (error) note({ event: 'agent_run_stop_error', run_id: runId, code: toRunError(error).code }); });
      const first = await Promise.race([outcome, new Promise(done => { setTimeout(done, stopWaitMs, null).unref?.(); })]);
      if (first?.error) throw toRunError(first.error);
      return { ...detail(runIn(projectId, runId)), stopping: !first };
    },
    approve(actor, approvalId, input, { elevated = false } = {}) {
      const v = parse(schemas.approve, input, 'INVALID_APPROVAL', CODES.INVALID_APPROVAL[1]);
      const row = validId(approvalId) && one('SELECT * FROM ops_agent_run_approvals WHERE id=?', approvalId);
      if (!row) refuse(404, 'APPROVAL_UNKNOWN', CODES.APPROVAL_UNKNOWN[1]);
      const r = one('SELECT project_id,state FROM ops_agent_runs WHERE id=?', row.run_id);
      try { access(actor, r.project_id, 'run'); }
      catch (error) { if (error.status === 404) refuse(404, 'APPROVAL_UNKNOWN', CODES.APPROVAL_UNKNOWN[1]); throw error; }
      if (!execution.available) unavailable();
      if (!digestConfirmation(v.digest, v.confirmation))
        refuse(400, 'APPROVAL_CONFIRMATION_MISMATCH', 'Type at least the first 12 characters of the digest shown, exactly as shown.');
      try {
        return { approval: coordinator.approve({ id: actor.id, elevated: elevated === true },
          { approval_id: approvalId, digest: v.digest }) };
      } catch (error) {
        const mapped = toRunError(error);
        const closed = one('SELECT state,stale_reason FROM ops_agent_run_approvals WHERE id=?', approvalId);
        mapped.extra = { approval_state: closed?.state ?? null, stale_reason: closed?.stale_reason ?? null };
        throw mapped;
      }
    },
    // The caller's pending approvals, and the latest help request per profile,
    // across the projects where the caller may run agents.
    inbox(actor) {
      assertEligible(actor, actor?.id ? one('SELECT id,role FROM users WHERE id=?', actor.id) : null);
      const scope = `p.archived_at IS NULL AND (p.owner_user_id=:actor OR EXISTS(SELECT 1 FROM ops_project_grants g
        WHERE g.project_id=p.id AND g.user_id=:actor AND g.role IN (${RUN_ROLES.map(role => `'${role}'`).join(',')})))`;
      const approvals = db.prepare(`SELECT a.*, r.project_id, r.state AS run_state, r.profile_id, p.name AS project_name
        FROM ops_agent_run_approvals a JOIN ops_agent_runs r ON r.id=a.run_id JOIN ops_projects p ON p.id=r.project_id
        WHERE a.state='requested' AND r.state='running' AND ${scope} ORDER BY a.requested_at LIMIT 50`).all({ actor: actor.id })
        .map(a => ({ ...approvalView(a, a.run_state), project_id: a.project_id, project_name: a.project_name,
          profile_name: one('SELECT display_name FROM ops_agent_profiles WHERE id=?', a.profile_id)?.display_name ?? null }));
      // A help request stays listed until a person has decided it (or resumed
      // the run). A newer run of the profile closes one with nothing that gates
      // the profile, as before A7; an undecided write stays listed regardless.
      const help = db.prepare(`SELECT r.*, p.name AS project_name,
        EXISTS(SELECT 1 FROM ops_agent_runs n JOIN ops_agent_run_pins np ON np.run_id=n.id
          WHERE n.profile_id=r.profile_id AND n.started_at > r.started_at) AS superseded
        FROM ops_agent_runs r JOIN ops_agent_run_results res ON res.run_id=r.id
        JOIN ops_projects p ON p.id=r.project_id WHERE res.needs_human=1 AND ${scope}
        ORDER BY res.created_at DESC LIMIT 200`).all({ actor: actor.id })
        .map(r => ({ ...summary(r), project_name: r.project_name, superseded: r.superseded === 1 }))
        .filter(r => r.help?.open && (r.help.gating || !r.superseded)).slice(0, 50)
        .map(({ superseded, ...r }) => r);
      return { approvals, help_requests: help, execution };
    },
    rules(actor, projectId, profileId) {
      access(actor, projectId, 'read');
      const row = validId(profileId) && one('SELECT * FROM ops_agent_profiles WHERE project_id=? AND id=? AND deleted_at IS NULL',
        projectId, profileId);
      if (!row) refuse(404, 'PROFILE_UNKNOWN', 'Profile not found');
      const { rules, refusal } = assignedRules(projectId, row);
      return { profile_id: row.id, guide_version_id: row.guide_version_id, guide_hash: row.guide_hash, rules,
        refusal, refusal_message: refusal === 'NO_GUIDE' ? 'No guide is assigned.' : refusal ? CODES[refusal]?.[1] ?? null : null };
    },
    // One live frame of the running browser, pixels only. Access is checked on
    // every call, so a removed grant stops observing at the next frame.
    async view(actor, projectId, runId) {
      access(actor, projectId, 'run');
      const r = runIn(projectId, runId);
      if (!execution.available) unavailable();
      if (r.state !== 'running') {
        frames.delete(runId);
        refuse(409, 'VIEW_UNAVAILABLE', r.state === 'prepared' || r.state === 'starting' ? 'The browser is starting.'
          : 'The browser is gone: the run is not running.', { run_state: r.state });
      }
      const attempt = one("SELECT id,fence FROM ops_agent_worker_attempts WHERE run_id=? AND state='running'", runId);
      if (!attempt) refuse(409, 'VIEW_UNAVAILABLE', 'The browser is starting.', { run_state: r.state });
      const cached = frames.get(runId);
      const fresh = cached && cached.fence === r.fence && clock().getTime() - cached.at < frameMs;
      if (fresh) return { frame: cached.frame };
      if (!viewing.has(runId)) {
        const ref = { run_id: runId, attempt_id: attempt.id, fence: r.fence };
        viewing.set(runId, launcher.view(ref).then(frame => {
          const at = clock();
          const current = one('SELECT action_count FROM ops_agent_runs WHERE id=?', runId);
          const entry = { at: at.getTime(), fence: r.fence, frame: { png_base64: frame.png_base64, width: frame.width,
            height: frame.height, captured_at: at.toISOString(), action_count: current?.action_count ?? null } };
          frames.set(runId, entry);
          return entry;
        }).finally(() => viewing.delete(runId)));
      }
      try { return { frame: (await viewing.get(runId)).frame }; }
      catch (error) {
        if (error?.code === 'VIEW_BUSY' && cached) return { frame: cached.frame };
        if (error?.code === 'TAKEN_OVER') refuse(409, 'VIEW_UNAVAILABLE', 'An operator took over this run on the host; the view is theirs.');
        if (['ATTEMPT_NOT_ACTIVE', 'STALE_FENCE', 'UNKNOWN_ATTEMPT', 'LEASE_EXPIRED', 'DEADLINE'].includes(error?.code))
          refuse(409, 'VIEW_UNAVAILABLE', 'The browser is gone: the run is not running.');
        if (error?.code === 'VIEW_BUSY') refuse(409, 'VIEW_BUSY', 'A frame is already on its way; try again in a second.');
        refuse(503, 'VIEW_FAILED', 'The browser frame could not be read from the supervisor.', { cause: toRunError(error).code });
      }
    },
    // A7 live view. Checked before the WebSocket upgrade and again every few
    // seconds while it is open, so a removed grant stops the view.
    assertLive(actor, projectId, runId) {
      access(actor, projectId, 'run');
      const r = runIn(projectId, runId);
      if (!execution.available) unavailable();
      if (!runningRef(r)) refuse(409, 'LIVE_UNAVAILABLE', 'The browser is not running.', { run_state: r.state });
      return true;
    },
    // One viewer's relay: the service filters every message both ways; the
    // WebSocket route owns the browser side. Resolves with the viewer id and
    // that viewer's own TURN credentials.
    async openLive(actor, projectId, runId, { sessionId, onMessage = () => {}, onClose = () => {} } = {}) {
      access(actor, projectId, 'run');
      const r = runIn(projectId, runId);
      if (!execution.available) unavailable();
      const ref = runningRef(r);
      if (!ref || typeof launcher.live !== 'function') refuse(409, 'LIVE_UNAVAILABLE', CODES.LIVE_UNAVAILABLE[1]);
      let entry = null, early = null;
      const closed = (reason) => {
        if (!entry) { early = reason; return; }
        viewerGone(entry, reason);
        try { onClose(reason); } catch { /* the route's socket may be gone */ }
      };
      let handle;
      try {
        handle = await launcher.live(ref, {
          onMessage: (message) => {
            if (message === null) return onMessage(null);
            const allowed = toViewer(message);
            return allowed ? onMessage(allowed) : undefined;
          },
          onClose: closed,
        });
      } catch (error) {
        const code = error?.code;
        if (code === 'LIVE_UNAVAILABLE' || code === 'LIVE_BUSY')
          refuse(409, code, CODES[code][1]);
        if (['ATTEMPT_NOT_ACTIVE', 'STALE_FENCE', 'UNKNOWN_ATTEMPT', 'LEASE_EXPIRED', 'DEADLINE', 'CHANNEL_CLOSED',
          'WORKER_EXITED'].includes(code))
          refuse(409, 'LIVE_UNAVAILABLE', 'The browser is not running.');
        throw toRunError(error);
      }
      entry = { viewer: handle.viewer, actorId: actor.id, sessionId, runId, projectId, handle, holding: false, gone: false };
      lives.set(handle.viewer, entry);
      note({ event: 'live_opened', run_id: runId, by: actor.id });
      if (early) closed(early);
      return { viewer: handle.viewer, ice_servers: handle.ice_servers, ttl_seconds: handle.ttl_seconds };
    },
    // From the viewer's browser: signalling only, the rest is dropped here.
    sendLive(viewer, actorId, message) {
      const entry = lives.get(viewer);
      if (!entry || entry.actorId !== actorId || entry.gone) return false;
      const allowed = fromViewer(message);
      return allowed ? entry.handle.send(allowed) !== false : false;
    },
    closeLive(viewer, reason = 'viewer_closed') {
      const entry = lives.get(viewer);
      if (!entry) return;
      try { entry.handle.close(); } catch { /* already closed */ }
      viewerGone(entry, reason);
    },
    // A7 takeover: anyone with run access (the starter too), after this
    // session's agent-control verification; never sudo, never a host privilege.
    // The claim (one controller) is durable first; then the supervisor fences
    // the model and Neko gives control to the caller's own live view.
    async takeover(actor, projectId, runId, input, { verified = false, sessionId = null } = {}) {
      const v = parse(schemas.takeover, input, 'TAKEOVER_VIEWER_UNKNOWN', CODES.TAKEOVER_VIEWER_UNKNOWN[1]);
      access(actor, projectId, 'run');
      const r = runIn(projectId, runId);
      if (!verified) refuse(401, 'CONTROL_VERIFICATION_REQUIRED',
        'Confirm it is you (password and authenticator code, or a passkey) once in this session to take over agent runs.',
        { control_verification_required: true });
      if (!execution.available) unavailable();
      const entry = lives.get(v.viewer);
      if (!entry || entry.gone || entry.actorId !== actor.id || entry.sessionId !== sessionId || entry.runId !== r.id)
        refuse(409, 'TAKEOVER_VIEWER_UNKNOWN', CODES.TAKEOVER_VIEWER_UNKNOWN[1]);
      let begun;
      try { begun = coordinator.beginTakeover({ id: actor.id }, runId); }
      catch (error) { throw toRunError(error); }
      let handed;
      try {
        handed = await launcher.takeover(begun.ref, v.viewer);
      } catch (error) {
        const cause = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? error.code : 'INTERNAL';
        note({ event: 'takeover_failed', run_id: runId, code: cause });
        coordinator.abandonTakeover(begun.takeover_id, cause)
          .catch(err => note({ event: 'takeover_abandon_error', run_id: runId, code: toRunError(err).code }));
        audit(actor, 'AGENT_RUN_TAKEOVER_FAILED', { project_id: projectId, run_id: runId, code: cause });
        refuse(502, 'TAKEOVER_FAILED', CODES.TAKEOVER_FAILED[1], { cause });
      }
      coordinator.holdTakeover(begun.takeover_id);
      entry.holding = true;
      startRenewal(runId, begun.ref);
      // X input while nobody had control should be none; recorded either way.
      audit(actor, 'AGENT_RUN_TAKEN_OVER', { project_id: projectId, run_id: runId,
        uncontrolled_inputs: handed.uncontrolled_inputs, password_fields_empty: handed.password_fields_empty });
      note({ event: 'takeover_holding', run_id: runId, by: actor.id, uncontrolled_inputs: handed.uncontrolled_inputs });
      // The view may have closed while control was being handed over.
      if (entry.gone) { entry.gone = false; viewerGone(entry, 'viewer_left'); }
      return detail(runIn(projectId, runId));
    },
    // The person who took over gives the browser back. The attempt is torn down
    // (stop reason taken_over, verified receipt); the run ends taken_over and
    // needs a person: they decide what happened and may resume it.
    async endTakeover(actor, projectId, runId) {
      access(actor, projectId, 'run');
      runIn(projectId, runId);
      if (!execution.available) unavailable();
      if (!one("SELECT 1 FROM ops_agent_takeovers WHERE run_id=? AND state IN ('taking','holding')", runId))
        refuse(409, 'TAKEOVER_NONE', CODES.TAKEOVER_NONE[1]);
      const stopping = await finishTakeover({ id: actor.id }, runId, 'ended_by_person');
      return { ...detail(runIn(projectId, runId)), stopping: stopping === true };
    },
    // At boot, with a coordinator: fence every run a previous process left
    // active and collect its verified receipt. Nothing is resumed.
    async recover() {
      if (!execution.available) return [];
      const results = await coordinator.recover();
      note({ event: 'agent_runs_recovered', runs: results.length });
      return results;
    },
    settled: runId => executing.get(runId) ?? Promise.resolve(),
    summarize,
  };
}
