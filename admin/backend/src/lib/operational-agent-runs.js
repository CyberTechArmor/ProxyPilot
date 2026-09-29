import { z } from 'zod';
import { OperationsError, assertEligible, assertOperation, resolveOperationsRole, validId } from './operational-projects-logic.js';
import { SUBMIT, guideRules } from './operational-run-policy.js';
import { workerInstallResources } from './operational-worker-boundary.js';

// A6 supervision service: what the Operations routes expose of A5 runs. It reads
// durable state through typed projections only (never a raw row, a receipt body,
// a prompt, page text, a value, a cookie or a token) and forwards the explicit
// human controls to the A5 coordinator unchanged. Without a coordinator (no
// supervisor configured, the default) every execution control fails closed with
// EXECUTION_UNAVAILABLE and the reads still show what is durable. The only live
// data is the browser frame (A6 decision: pixels only), kept in memory for a
// moment and never written to the database or a log.
export class AgentRunError extends OperationsError {
  constructor(status, code, message, extra = {}) { super(status, message); this.code = code; this.extra = extra; }
}
const refuse = (status, code, message, extra) => { throw new AgentRunError(status, code, message, extra); };
export const AGENT_PILOT_ORIGIN = 'https://demo.fractionate.ai';
const ACTIVE = ['prepared', 'starting', 'running', 'cancelling'];
const RUN_ROLES = ['operator', 'editor', 'reviewer'];
const HELP_CLASSES = new Set(['challenge_required', 'interrupted', 'uncertain_step', 'model_uncertain', 'taken_over']);
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
});
const toRunError = (error) => {
  if (error instanceof OperationsError) return error;
  const code = typeof error?.code === 'string' ? error.code : null;
  const [status, message] = CODES[code] ?? [500, 'Unable to complete the agent run request.'];
  return new AgentRunError(status, code && CODES[code] ? code : 'INTERNAL', message);
};
const uuid = z.string().uuid();
const schemas = {
  start: z.object({ profile_id: uuid, credential_binding_id: uuid.nullable().optional() }).strict(),
  approve: z.object({ digest: z.string().regex(/^[0-9a-f]{64}$/), confirmation: z.string().max(200) }).strict(),
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

export function createAgentRunService({ db, coordinator = null, launcher = null, unavailableReason = 'not_configured',
  clock = () => new Date(), log = () => {}, frameMs = 1500, stopWaitMs = 1500 } = {}) {
  const one = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const available = !!(coordinator && launcher);
  const reason = available ? null : (UNAVAILABLE[unavailableReason] ? unavailableReason : 'not_configured');
  const execution = Object.freeze({ available, reason, message: available ? null : UNAVAILABLE[reason] });
  const executing = new Map(), frames = new Map(), viewing = new Map();
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
    const reasons = [];
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
    return { profile_id: row.id, display_name: row.display_name, ready: reasons.length === 0, reasons,
      active_run_id: active?.id ?? null, model_guide_consent: row.model_guide_consent === 1,
      binding: binding ? { binding_id: binding.id, revision: binding.revision, username: binding.username } : null };
  }

  // A help request names the decision: its own class when that class is one a
  // person must decide, otherwise the uncertain step that made it one.
  function help(result) {
    if (!result || result.needs_human !== 1) return null;
    return { result_class: HELP_CLASSES.has(result.result_class) ? result.result_class : 'uncertain_step',
      uncertain_steps: result.uncertain_steps };
  }
  const resultView = (row) => row && ({ final_state: row.final_state, result_class: row.result_class,
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
      started_by: { id: pin.started_by, username: username(pin.started_by) },
      result_class: result?.result_class ?? null, final_state: result?.final_state ?? null,
      needs_human: result?.needs_human === 1, awaiting_approval: !!open && r.state === 'running',
      help: help(result) };
  }
  function detail(r, actor) {
    const v = one('SELECT version_number FROM ops_guide_versions WHERE project_id=? AND id=?', r.project_id, r.guide_version_id);
    const result = one('SELECT * FROM ops_agent_run_results WHERE run_id=?', r.id);
    const running = r.state === 'running';
    return {
      run: { ...summary(r), fence: r.fence, deadline_at: r.deadline_at, policy_digest: r.policy_digest,
        guide_hash: r.guide_hash, guide_version_id: r.guide_version_id, guide_version_number: v?.version_number ?? null,
        max_actions: r.max_actions, credential_binding_id: r.credential_binding_id,
        credential_binding_revision: r.credential_binding_revision },
      steps: all(`SELECT ordinal,action,decided_by,rule,model_call_id,approval_id,state,claims_json,error_code,created_at,
        finished_at FROM ops_agent_run_steps WHERE run_id=? ORDER BY ordinal`, r.id)
        .map(({ claims_json, ...s }) => ({ ...s, claims: JSON.parse(claims_json) })),
      model_calls: all(`SELECT call_id,step_ordinal,allowed_json,state,choice,refusal_code,settled_usd,prompt_tokens,
        completion_tokens,replayed,created_at,finished_at FROM ops_agent_model_calls WHERE run_id=? ORDER BY created_at,call_id`, r.id)
        .map(({ allowed_json, replayed, ...c }) => ({ ...c, allowed: JSON.parse(allowed_json), replayed: replayed === 1 })),
      approvals: all('SELECT * FROM ops_agent_run_approvals WHERE run_id=? ORDER BY requested_at,id', r.id)
        .map(a => approvalView(a, r.state)),
      events: all('SELECT id,kind,created_at FROM ops_agent_worker_events WHERE run_id=? ORDER BY id', r.id),
      result: resultView(result),
      controls: {
        stop: execution.available && ACTIVE.includes(r.state) && r.state !== 'cancelling' ? { enabled: true, reason: null }
          : { enabled: false, reason: !execution.available ? execution.message
            : r.state === 'cancelling' ? 'The run is already stopping.' : 'The run has ended.' },
        view: execution.available && running ? { enabled: true, reason: null }
          : { enabled: false, reason: !execution.available ? execution.message
            : r.state === 'prepared' || r.state === 'starting' ? 'The browser is starting.' : 'The browser is gone: the run is not running.' },
      },
      execution,
    };
  }
  // The execute loop runs in the background; its failures are already durable
  // results, so here they are only logged (codes, never messages from a page).
  function background(runId) {
    const work = coordinator.execute(runId)
      .then(result => note({ event: 'agent_run_finished', run_id: runId, result_class: result?.result_class ?? null }))
      .catch(error => note({ event: 'agent_run_error', run_id: runId, code: toRunError(error).code }))
      .finally(() => { executing.delete(runId); frames.delete(runId); });
    executing.set(runId, work);
    return work;
  }

  return {
    execution,
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
      return detail(runIn(projectId, runId), actor);
    },
    async start(actor, projectId, input) {
      const v = parse(schemas.start, input, 'INVALID_RUN', CODES.INVALID_RUN[1]);
      access(actor, projectId, 'run');
      if (!execution.available) unavailable();
      let started;
      try {
        started = coordinator.start({ id: actor.id }, { project_id: projectId, profile_id: v.profile_id,
          ...(v.credential_binding_id ? { credential_binding_id: v.credential_binding_id } : {}) });
      } catch (error) {
        const mapped = toRunError(error);
        if (mapped.code === 'RUN_ALREADY_ACTIVE') {
          const active = one(`SELECT id FROM ops_agent_runs WHERE profile_id=? AND project_id=? AND state IN (${ACTIVE.map(() => '?').join(',')})`,
            v.profile_id, projectId, ...ACTIVE);
          mapped.extra = { active_run_id: active?.id ?? null };
        }
        throw mapped;
      }
      note({ event: 'agent_run_started', run_id: started.run_id, by: actor.id });
      background(started.run_id);
      return detail(runIn(projectId, started.run_id), actor);
    },
    async stop(actor, projectId, runId) {
      access(actor, projectId, 'run');
      const r = runIn(projectId, runId);
      if (!execution.available) unavailable();
      if (!ACTIVE.includes(r.state)) return { ...detail(r, actor), stopping: false };
      // The fence is synchronous; collecting the verified receipt may take the
      // supervisor a while, so the answer does not wait for more than a moment.
      const outcome = coordinator.stop({ id: actor.id }, runId).then(() => ({ done: true }), error => ({ error }));
      outcome.then(({ error }) => { if (error) note({ event: 'agent_run_stop_error', run_id: runId, code: toRunError(error).code }); });
      const first = await Promise.race([outcome, new Promise(done => { setTimeout(done, stopWaitMs, null).unref?.(); })]);
      if (first?.error) throw toRunError(first.error);
      return { ...detail(runIn(projectId, runId), actor), stopping: !first };
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
      const help = db.prepare(`SELECT r.*, p.name AS project_name FROM ops_agent_runs r JOIN ops_agent_run_results res ON res.run_id=r.id
        JOIN ops_projects p ON p.id=r.project_id WHERE res.needs_human=1 AND ${scope}
        AND NOT EXISTS(SELECT 1 FROM ops_agent_runs n JOIN ops_agent_run_pins np ON np.run_id=n.id
          WHERE n.profile_id=r.profile_id AND n.started_at > r.started_at)
        ORDER BY res.created_at DESC LIMIT 50`).all({ actor: actor.id })
        .map(r => ({ ...summary(r), project_name: r.project_name }));
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
    // At boot, with a coordinator: fence every run a previous process left
    // active and collect its verified receipt. Nothing is resumed.
    async recover() {
      if (!execution.available) return [];
      const results = await coordinator.recover();
      note({ event: 'agent_runs_recovered', runs: results.length });
      return results;
    },
    settled: runId => executing.get(runId) ?? Promise.resolve(),
  };
}
