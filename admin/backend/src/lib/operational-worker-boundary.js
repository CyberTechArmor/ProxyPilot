import { randomUUID } from 'node:crypto';
import { agentLimits } from './operational-projects-logic.js';

// Internal A3 contract. No caller-controlled argv, path, URL, selector or bytes.
// The only OS runner is the host-owned supervisor (scripts/a3-worker-supervisor.py),
// reached through an injected client; without one every launch fails closed.
export const WORKER_TARGET = 'incus-disposable-vm-browser-v1';
// Resource and run caps are project policy. An empty object means that the
// owner has not configured a cap; it never authorizes an unverified runner.
// The VM is finite installed capacity, not a quota. Project CPU, memory and
// temporary-disk limits apply to the worker unit inside it, above a measured
// browser minimum (provisional until the A3 lifecycle proof confirms it).
export const WORKER_INSTALL_BASELINE = Object.freeze({cpu:2,memory_mib:4096,root_disk_gib:12});
export const WORKER_MINIMUM = Object.freeze({cpu:1,memory_mib:1024,temporary_disk_mib:64});
// Guest kernel and OS headroom kept above a configured worker memory limit.
export const WORKER_INSTALL_RESERVE_MIB = 1024;
export const BROWSER_ACTIONS = Object.freeze([
  'open_landing', 'open_login', 'submit_bound_fixture', 'read_workspace',
  'read_session', 'read_files', 'sign_out',
]);
// A5: the runner classifies each bound submit; the class is untrusted page data.
export const SUBMIT_OUTCOMES = Object.freeze(['signed_in','rejected','rate_limited','challenge_required',
  'unexpected_origin','timeout','unknown']);
// Stop reasons the backend may give the supervisor. `completed` (A5) is a label
// on a normal teardown; it grants nothing a cancel does not.
export const STOP_REASONS = Object.freeze(['cancelled','blocked','failed','completed']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/i;
const ACTIVE = new Set(['prepared', 'starting', 'running']);
export const REQUIRED_ACTION = Object.freeze({open_landing:'navigate',open_login:'click',
  submit_bound_fixture:'type',read_workspace:'navigate',read_session:'read',read_files:'read',sign_out:'logout'});
// A4 launch pin: operator-authorized UUIDs and revisions only, never a value.
const CREDENTIAL_FIELDS = Object.freeze(['project_id','profile_id','profile_revision','binding_id','binding_revision']);
const fail = (code) => { const e = new Error(code); e.code = code; throw e; };
const fields = (value, names) => value && typeof value === 'object' &&
  !Array.isArray(value) && Object.keys(value).sort().join(',') === [...names].sort().join(',');
const validUuid = value => typeof value === 'string' && UUID.test(value);

// The VM shape a launch needs. A configured limit below the worker minimum is
// refused, never raised; a limit above the installed VM needs a resize first
// (the host supervisor refuses VM_CAPACITY_INSUFFICIENT).
export function workerInstallResources(limits) {
  const parsed=agentLimits.safeParse(limits);
  if (!parsed.success) fail('INVALID_PROJECT_LIMITS');
  for (const [key,minimum] of Object.entries(WORKER_MINIMUM))
    if (parsed.data[key]!=null && parsed.data[key]<minimum) fail('PROJECT_LIMIT_BELOW_WORKER_MINIMUM');
  return Object.freeze({cpu:Math.max(WORKER_INSTALL_BASELINE.cpu,parsed.data.cpu??0),
    memory_mib:Math.max(WORKER_INSTALL_BASELINE.memory_mib,(parsed.data.memory_mib??0)+WORKER_INSTALL_RESERVE_MIB),
    root_disk_gib:WORKER_INSTALL_BASELINE.root_disk_gib});
}

function validCredential(value) {
  return fields(value, CREDENTIAL_FIELDS) && validUuid(value.project_id) && validUuid(value.profile_id) &&
    validUuid(value.binding_id) && Number.isSafeInteger(value.profile_revision) && value.profile_revision >= 1 &&
    Number.isSafeInteger(value.binding_revision) && value.binding_revision >= 1;
}

export function validateWorkerLaunch(value) {
  const base = ['run_id','attempt_id','workspace_id','fence','policy_digest','project_limits_revision',
    'origin','target','limits','install'];
  if (!fields(value, base) && !fields(value, [...base,'credential'])) fail('INVALID_LAUNCH');
  // The host supervisor accepts the credential field absent or valid, never null.
  if ('credential' in value && !validCredential(value.credential)) fail('INVALID_LAUNCH');
  if (!validUuid(value.run_id) || !validUuid(value.attempt_id) || !validUuid(value.workspace_id) ||
      !Number.isSafeInteger(value.fence) || value.fence < 1 || !HASH.test(value.policy_digest || '') ||
      !Number.isSafeInteger(value.project_limits_revision) || value.project_limits_revision < 0 ||
      value.origin !== 'https://demo.fractionate.ai' || value.target !== WORKER_TARGET ||
      !agentLimits.safeParse(value.limits).success) fail('INVALID_LAUNCH');
  const install=workerInstallResources(value.limits);
  if (!fields(value.install,Object.keys(WORKER_INSTALL_BASELINE)) ||
      Object.keys(install).some(key=>value.install[key]!==install[key])) fail('INVALID_LAUNCH');
  return Object.freeze({...value, limits: Object.freeze({...value.limits}),install,
    ...('credential' in value ? {credential:Object.freeze({...value.credential})} : {})});
}

// submit_bound_fixture names its binding; every other action has no extra field.
export function validateBrowserAction(value) {
  const submit = value?.action === 'submit_bound_fixture';
  if (!fields(value, submit ? ['run_id','attempt_id','fence','action','binding_id'] : ['run_id','attempt_id','fence','action']) ||
      (submit && !validUuid(value.binding_id)) || !validUuid(value.run_id) || !validUuid(value.attempt_id) ||
      !Number.isSafeInteger(value.fence) || value.fence < 1 ||
      !BROWSER_ACTIONS.includes(value.action)) fail('INVALID_BROWSER_ACTION');
  return value;
}

// Observations are the typed step claims only (booleans, an outcome class, a
// small count); the supervisor re-validates them. No page text crosses.
const OBSERVATION_CLAIMS = Object.freeze({authenticated:'boolean',as_bound_account:'boolean',sample_present:'boolean',
  signed_out:'boolean',outcome:'outcome',login_requests:'count'});
function validObservation(o) {
  return fields(o,['action','status','claims']) && BROWSER_ACTIONS.includes(o.action) && ['done','failed'].includes(o.status) &&
    o.claims && typeof o.claims==='object' && !Array.isArray(o.claims) && Object.entries(o.claims).every(([k,v]) =>
      OBSERVATION_CLAIMS[k]==='boolean' ? typeof v==='boolean' : OBSERVATION_CLAIMS[k]==='outcome' ?
        SUBMIT_OUTCOMES.includes(v) : OBSERVATION_CLAIMS[k]==='count' && Number.isSafeInteger(v) && v>=0 && v<=10);
}
export function validateModelStep(value) {
  if (!fields(value,['run_id','attempt_id','fence','call_id','policy','guide','observations','allowed']) ||
      !validUuid(value.run_id) || !validUuid(value.attempt_id) || !validUuid(value.call_id) ||
      !Number.isSafeInteger(value.fence) || value.fence<1 || typeof value.policy!=='string' ||
      typeof value.guide!=='string' || !Array.isArray(value.observations) || value.observations.length>20 ||
      !value.observations.every(validObservation) || !Array.isArray(value.allowed) || value.allowed.length<2 ||
      new Set(value.allowed).size!==value.allowed.length || !value.allowed.every(a=>BROWSER_ACTIONS.includes(a)))
    fail('INVALID_MODEL_STEP');
  return value;
}

const MAX_VIEW_BASE64 = 3 * 1024 * 1024;
const PNG_MAGIC = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]);
const validRef = ref => fields(ref, ['run_id','attempt_id','fence']) &&
  validUuid(ref.run_id) && validUuid(ref.attempt_id) && Number.isSafeInteger(ref.fence) && ref.fence >= 1;

// The only launch/stop surface exposed in A3. Without an injected client for
// the independently installed host supervisor, and the proof VM identity it
// must report, every call fails closed. Silent fallback to spawn/host-exec is
// forbidden. Nothing in the routes constructs a client: A3 activation is off.
export function createWorkerLauncher({client=null, vmUuid=null}={}) {
  const connected = () => {
    if (!client || typeof client.request !== 'function' || !validUuid(vmUuid)) fail('BOUNDARY_UNVERIFIED');
    return client;
  };
  return {
    async launch(spec) {
      const valid=validateWorkerLaunch(spec);
      const result=await connected().request('launch', valid);
      if (!result || result.run_id!==valid.run_id || result.attempt_id!==valid.attempt_id ||
          result.fence!==valid.fence || result.vm_uuid!==vmUuid || !validUuid(result.boot_id) ||
          typeof result.lease_expires_at!=='string') fail('SUPERVISOR_PROTOCOL');
      return Object.freeze({vm_uuid:result.vm_uuid,boot_id:result.boot_id,
        lease_expires_at:result.lease_expires_at,deadline_at:result.deadline_at??null});
    },
    async renew(ref) {
      if (!validRef(ref)) fail('INVALID_STOP');
      return connected().request('renew', {run_id:ref.run_id,attempt_id:ref.attempt_id,fence:ref.fence});
    },
    // The host counts and journals the action before the browser may act; its
    // result is untrusted page data, never an instruction.
    async action(request) {
      validateBrowserAction(request);
      const submit=request.action==='submit_bound_fixture';
      const result=await connected().request('action', {run_id:request.run_id,attempt_id:request.attempt_id,
        fence:request.fence,action:request.action,...(submit?{binding_id:request.binding_id}:{})});
      if (!result || !Number.isSafeInteger(result.ordinal) || result.untrusted!==true) fail('SUPERVISOR_PROTOCOL');
      // A submit result names the binding, revision and outcome; nothing else is expected back.
      if (submit && (result.result?.binding_id!==request.binding_id ||
          !Number.isSafeInteger(result.result?.binding_revision) ||
          !SUBMIT_OUTCOMES.includes(result.result?.outcome))) fail('SUPERVISOR_PROTOCOL');
      return result;
    },
    // A5: one model choice for the live attempt. The supervisor checks the
    // policy bytes against the run's pinned digest and the guide bytes against
    // the policy's guide hash, calls the broker's model route under the run's
    // pinned budget, and returns one action name from `allowed` or a refusal.
    async modelStep(request) {
      const valid=validateModelStep(request);
      const result=await connected().request('model_step', valid);
      if (!result || result.call_id!==valid.call_id) fail('SUPERVISOR_PROTOCOL');
      // The call is settled at the broker; a choice outside the set is refused, never used.
      if (!valid.allowed.includes(result.choice)) fail('MODEL_CHOICE_INVALID');
      return result;
    },
    // A6: one frame of the model's live attempt for the supervision UI. Pixels
    // only; the supervisor drops the page URL, and a reply with any other field,
    // a non-PNG or an oversized frame is a protocol error, never shown.
    async view(ref) {
      if (!validRef(ref)) fail('INVALID_VIEW');
      const result=await connected().request('view', {run_id:ref.run_id,attempt_id:ref.attempt_id,fence:ref.fence});
      if (!fields(result,['png_base64','width','height']) || typeof result.png_base64!=='string' ||
          result.png_base64.length===0 || result.png_base64.length>MAX_VIEW_BASE64 ||
          !/^[A-Za-z0-9+/]+={0,2}$/.test(result.png_base64) ||
          !Buffer.from(result.png_base64.slice(0,12),'base64').subarray(0,8).equals(PNG_MAGIC) ||
          ![result.width,result.height].every(n=>Number.isSafeInteger(n) && n>=1 && n<=4096)) fail('SUPERVISOR_PROTOCOL');
      return Object.freeze({png_base64:result.png_base64,width:result.width,height:result.height});
    },
    async stop(ref, reason='cancelled') {
      if (!validRef(ref) || !STOP_REASONS.includes(reason)) fail('INVALID_STOP');
      const result=await connected().request('stop', {run_id:ref.run_id,attempt_id:ref.attempt_id,
        fence:ref.fence,reason});
      const receipt=result?.receipt;
      if (!fields(receipt,['run_id','attempt_id','fence','descendants_gone','workspace_removed','attestation']) ||
          receipt.run_id!==ref.run_id || receipt.attempt_id!==ref.attempt_id || receipt.fence!==ref.fence)
        fail('SUPERVISOR_PROTOCOL');
      return receipt;
    },
    async status() { return connected().request('status', {}); },
  };
}

export function createOperationalWorkerStore(db, clock = () => new Date(), uuid = randomUUID, verifyTeardown = null) {
  const one = (sql, ...args) => db.prepare(sql).get(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  function tx(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  const stamp = () => clock().toISOString();
  const event = (runId, attemptId, kind) => run(
    'INSERT INTO ops_agent_worker_events(run_id,attempt_id,kind,created_at) VALUES(?,?,?,?)',
    runId, attemptId, kind, stamp());
  function assertPinnedBinding(r) {
    if (r.credential_binding_id == null) return null;
    const binding=one('SELECT * FROM ops_agent_credential_bindings WHERE id=?',r.credential_binding_id);
    if (!binding || binding.project_id!==r.project_id || binding.profile_id!==r.profile_id) fail('CREDENTIAL_BINDING_STALE');
    if (binding.state!=='active') fail('CREDENTIAL_BINDING_REVOKED');
    if (binding.revision!==r.credential_binding_revision) fail('CREDENTIAL_REVISION_MISMATCH');
    return binding;
  }
  function assertPinnedConfiguration(r) {
    const p=one('SELECT * FROM ops_projects WHERE id=?',r.project_id);
    const profile=one('SELECT * FROM ops_agent_profiles WHERE project_id=? AND id=? AND deleted_at IS NULL',r.project_id,r.profile_id);
    const guide=one('SELECT id,content_hash FROM ops_guide_versions WHERE project_id=? ORDER BY version_number DESC LIMIT 1',r.project_id);
    const withdrawn=guide && one('SELECT 1 FROM ops_version_withdrawals WHERE project_id=? AND version_id=?',r.project_id,guide.id);
    if (!p || p.archived_at || p.site_origin!==r.site_origin || p.site_revision!==r.site_revision ||
        p.agent_limits_revision!==r.project_limits_revision ||
        !profile || profile.revision!==r.profile_revision || profile.guide_version_id!==r.guide_version_id ||
        profile.guide_hash!==r.guide_hash || profile.assigned_site_revision!==r.site_revision ||
        !guide || withdrawn || guide.id!==r.guide_version_id || guide.content_hash!==r.guide_hash)
      fail('STALE_CONFIGURATION');
    // Rotation or revocation refuses the pinned revision at launch and at every use.
    const binding=assertPinnedBinding(r);
    return {profile,project:p,binding};
  }
  function profilePolicy(profile, origin) {
    let origins, actions;
    try {
      origins=JSON.parse(profile.proposed_origins_json);
      actions=JSON.parse(profile.proposed_actions_json);
    } catch { fail('INVALID_PROFILE_POLICY'); }
    if (profile.workflow_type!=='synthetic_sign_in' || !Array.isArray(origins) ||
        !origins.includes(origin) || !Array.isArray(actions))
      fail('INVALID_PROFILE_POLICY');
    return {actions};
  }
  function projectLimits(project) {
    let parsed;
    try { parsed=JSON.parse(project.agent_limits_json); } catch { fail('INVALID_PROJECT_LIMITS'); }
    const result=agentLimits.safeParse(parsed);
    if (!result.success) fail('INVALID_PROJECT_LIMITS');
    return result.data;
  }
  function current(runId, attemptId, fence) {
    const r = one('SELECT * FROM ops_agent_runs WHERE id=?', runId);
    const a = one('SELECT * FROM ops_agent_worker_attempts WHERE id=? AND run_id=?', attemptId, runId);
    if (!r || !a || r.fence !== fence || a.fence !== fence ||
        r.state !== 'running' || a.state !== 'running' ||
        (r.deadline_at && stamp() >= r.deadline_at) || stamp() >= a.lease_expires_at) fail('STALE_WORKER');
    const {profile}=assertPinnedConfiguration(r);
    return {r,a,profile};
  }
  return {
    // Only an internal test/coordinator may call this; no route or starter exists.
    // `within(runId)` runs inside the same transaction (A5: the policy pin row),
    // so the run and everything pinned with it commit together or not at all.
    prepare(input, within=null) {
      const names=['project_id','profile_id','profile_revision','site_origin','site_revision',
        'guide_version_id','guide_hash','policy_digest'];
      if (!(fields(input, names) || (fields(input, [...names,'credential_binding_id']) &&
          validUuid(input.credential_binding_id))) ||
        ![input.project_id,input.profile_id,input.guide_version_id].every(validUuid) ||
        !Number.isSafeInteger(input.profile_revision) || input.profile_revision < 1 ||
        !Number.isSafeInteger(input.site_revision) || input.site_revision < 1 ||
        input.site_origin !== 'https://demo.fractionate.ai' ||
        !HASH.test(input.guide_hash || '') || !HASH.test(input.policy_digest || '')) fail('INVALID_RUN');
      return tx(() => {
        const p = one('SELECT * FROM ops_agent_profiles WHERE id=? AND project_id=? AND deleted_at IS NULL', input.profile_id, input.project_id);
        const project = one('SELECT * FROM ops_projects WHERE id=?', input.project_id);
        const guide = one('SELECT id,content_hash FROM ops_guide_versions WHERE project_id=? ORDER BY version_number DESC LIMIT 1', input.project_id);
        const withdrawn = guide && one('SELECT 1 FROM ops_version_withdrawals WHERE project_id=? AND version_id=?',input.project_id,guide.id);
        if (!p || !project || project.archived_at || p.revision !== input.profile_revision ||
            p.guide_version_id !== input.guide_version_id || p.guide_hash !== input.guide_hash ||
            !guide || withdrawn || guide.id !== input.guide_version_id || guide.content_hash !== input.guide_hash ||
            p.assigned_site_revision !== input.site_revision ||
            project.site_origin !== input.site_origin || project.site_revision !== input.site_revision)
          fail('STALE_CONFIGURATION');
        const {actions}=profilePolicy(p,input.site_origin);
        let binding=null;
        if (input.credential_binding_id) {
          binding=one('SELECT * FROM ops_agent_credential_bindings WHERE id=?',input.credential_binding_id);
          if (!binding || binding.project_id!==input.project_id || binding.profile_id!==input.profile_id ||
              binding.origin!==input.site_origin) fail('CREDENTIAL_BINDING_STALE');
          if (binding.state!=='active') fail('CREDENTIAL_BINDING_REVOKED');
          if (!actions.includes('type')) fail('ACTION_NOT_CONFIGURED');
        }
        const limits=projectLimits(project);
        workerInstallResources(limits);
        const id = uuid(), now = clock();
        const deadlineMs=limits.max_seconds == null ? null : now.getTime() + limits.max_seconds*1000;
        if (deadlineMs != null && (!Number.isFinite(deadlineMs) || deadlineMs > 8.64e15)) fail('INVALID_PROJECT_LIMITS');
        const deadline=deadlineMs == null ? null : new Date(deadlineMs).toISOString();
        run(`INSERT INTO ops_agent_runs(id,project_id,profile_id,profile_revision,site_origin,site_revision,
          guide_version_id,guide_hash,policy_digest,project_limits_revision,max_seconds,max_actions,state,started_at,deadline_at,updated_at,
          credential_binding_id,credential_binding_revision)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'prepared',?,?,?,?,?)`, id,input.project_id,input.profile_id,input.profile_revision,
          input.site_origin,input.site_revision,input.guide_version_id,input.guide_hash,input.policy_digest,
          project.agent_limits_revision,limits.max_seconds??null,limits.max_actions??null,
          now.toISOString(),deadline,now.toISOString(),binding?.id??null,binding?.revision??null);
        event(id,null,'prepared');
        if (within) within(id);
        return {run_id:id,deadline_at:deadline,credential_binding_revision:binding?.revision??null};
      });
    },
    reserveAttempt(runId) {
      if (!validUuid(runId)) fail('INVALID_RUN');
      return tx(() => {
        const r=one('SELECT * FROM ops_agent_runs WHERE id=?',runId);
        if (!r || r.state !== 'prepared' || (r.deadline_at && stamp() >= r.deadline_at)) fail('RUN_NOT_PREPARED');
        assertPinnedConfiguration(r);
        const id=uuid(), workspaceId=uuid(), fence=r.fence+1;
        const lease=new Date(Math.min(clock().getTime()+30_000,r.deadline_at?Date.parse(r.deadline_at):Infinity)).toISOString();
        run("UPDATE ops_agent_runs SET state='starting',fence=?,revision=revision+1,updated_at=? WHERE id=?",fence,stamp(),runId);
        run(`INSERT INTO ops_agent_worker_attempts(id,run_id,attempt_no,fence,state,lease_expires_at,workspace_id,created_at)
          VALUES(?,?,1,?,'starting',?,?,?)`,id,runId,fence,lease,workspaceId,stamp());
        event(runId,id,'attempt_reserved');
        return {run_id:runId,attempt_id:id,fence,workspace_id:workspaceId};
      });
    },
    // `binding` is the supervisor's launch readback: the exact VM and guest boot
    // this attempt runs on. Teardown receipts must name the same identity.
    markRunning(ref, binding=null) {
      if (binding!==null && (!fields(binding,['vm_uuid','boot_id']) ||
          !validUuid(binding.vm_uuid) || !validUuid(binding.boot_id))) fail('INVALID_BINDING');
      return tx(() => {
        const r=one('SELECT * FROM ops_agent_runs WHERE id=?',ref.run_id);
        const a=one('SELECT * FROM ops_agent_worker_attempts WHERE id=? AND run_id=?',ref.attempt_id,ref.run_id);
        if (!r || !a || r.state!=='starting' || a.state!=='starting' ||
            r.fence!==ref.fence || a.fence!==ref.fence ||
            (r.deadline_at && stamp()>=r.deadline_at) || stamp()>=a.lease_expires_at) fail('STALE_WORKER');
        assertPinnedConfiguration(r);
        run("UPDATE ops_agent_runs SET state='running',revision=revision+1,updated_at=? WHERE id=?",stamp(),ref.run_id);
        run("UPDATE ops_agent_worker_attempts SET state='running',vm_uuid=?,boot_id=? WHERE id=?",
          binding?.vm_uuid??null,binding?.boot_id??null,ref.attempt_id);
        event(ref.run_id,ref.attempt_id,'running');
      });
    },
    renewLease(ref) {
      return tx(() => {
        const {r,a}=current(ref.run_id,ref.attempt_id,ref.fence);
        const next=new Date(Math.min(clock().getTime()+30_000,r.deadline_at?Date.parse(r.deadline_at):Infinity)).toISOString();
        run('UPDATE ops_agent_worker_attempts SET lease_expires_at=? WHERE id=?',next,a.id);
        return {lease_expires_at:next};
      });
    },
    launchSpec(ref) {
      const r=one('SELECT * FROM ops_agent_runs WHERE id=?',ref.run_id);
      const a=one('SELECT * FROM ops_agent_worker_attempts WHERE id=? AND run_id=?',ref.attempt_id,ref.run_id);
      if (!r || !a || r.state!=='starting' || a.state!=='starting' ||
          r.fence!==ref.fence || a.fence!==ref.fence || stamp()>=a.lease_expires_at ||
          (r.deadline_at && stamp()>=r.deadline_at)) fail('STALE_WORKER');
      const {project,binding}=assertPinnedConfiguration(r);
      const limits=projectLimits(project);
      return validateWorkerLaunch({run_id:r.id,attempt_id:a.id,workspace_id:a.workspace_id,fence:a.fence,
        policy_digest:r.policy_digest,project_limits_revision:r.project_limits_revision,
        origin:r.site_origin,target:WORKER_TARGET,limits,install:workerInstallResources(limits),
        ...(binding ? {credential:{project_id:r.project_id,profile_id:r.profile_id,profile_revision:r.profile_revision,
          binding_id:binding.id,binding_revision:r.credential_binding_revision}} : {})});
    },
    // `within(ordinal, run)` runs inside the reservation transaction (A5: the
    // durable step row and the approval consumption commit with the count).
    authorizeAction(request, within=null) {
      validateBrowserAction(request);
      return tx(() => {
        const {r,profile}=current(request.run_id,request.attempt_id,request.fence);
        if (request.action==='submit_bound_fixture') {
          if (r.credential_binding_id==null) fail('CREDENTIAL_NOT_BOUND');
          if (request.binding_id!==r.credential_binding_id) fail('BINDING_MISMATCH');
        }
        const {actions}=profilePolicy(profile,r.site_origin);
        if (!actions.includes(REQUIRED_ACTION[request.action])) fail('ACTION_NOT_CONFIGURED');
        if (r.max_actions != null && r.action_count >= r.max_actions) fail('ACTION_LIMIT');
        run('UPDATE ops_agent_runs SET action_count=action_count+1,revision=revision+1,updated_at=? WHERE id=?',stamp(),r.id);
        event(r.id,request.attempt_id,`action:${request.action}`);
        if (within) within(r.action_count+1, r);
        return {ordinal:r.action_count+1};
      });
    },
    fence(runId, reason='cancelled', within=null) {
      if (!validUuid(runId) || !STOP_REASONS.includes(reason)) fail('INVALID_STOP');
      return tx(() => {
        const r=one('SELECT * FROM ops_agent_runs WHERE id=?',runId);
        if (!r || !ACTIVE.has(r.state)) fail('RUN_NOT_ACTIVE');
        const attempt=one("SELECT id,fence FROM ops_agent_worker_attempts WHERE run_id=? AND state IN ('starting','running')",runId);
        run("UPDATE ops_agent_runs SET state='cancelling',fence=fence+1,revision=revision+1,updated_at=? WHERE id=?",stamp(),runId);
        event(runId,null,`fenced:${reason}`);
        if (within) within(r);
        return {run_id:runId,attempt_id:attempt?.id??null,previous_fence:r.fence,reason};
      });
    },
    // `within(run)` runs inside the same transaction (A5: the durable result row).
    finishStop(runId, reason, receipt, within=null) {
      if (!validUuid(runId) || !STOP_REASONS.includes(reason)) fail('INVALID_STOP');
      return tx(() => {
        const r=one('SELECT * FROM ops_agent_runs WHERE id=?',runId);
        if (!r || r.state!=='cancelling') fail('RUN_NOT_CANCELLING');
        const attempt=one('SELECT id,fence,workspace_id,vm_uuid,boot_id FROM ops_agent_worker_attempts WHERE run_id=? ORDER BY attempt_no DESC LIMIT 1',runId);
        if (!fields(receipt,['run_id','attempt_id','fence','descendants_gone','workspace_removed','attestation']) ||
            receipt.run_id!==runId || receipt.attempt_id!==(attempt?.id??null) ||
            receipt.fence!==(attempt?.fence??0) || receipt.descendants_gone!==true ||
            receipt.workspace_removed!==true || typeof receipt.attestation!=='string' ||
            !verifyTeardown || verifyTeardown(receipt,{run_id:runId,attempt_id:attempt?.id??null,
              fence:attempt?.fence??0,workspace_id:attempt?.workspace_id??null,
              vm_uuid:attempt?.vm_uuid??null,boot_id:attempt?.boot_id??null})!==true)
          fail('TEARDOWN_UNVERIFIED');
        run("UPDATE ops_agent_worker_attempts SET state='stopped',stopped_at=? WHERE run_id=? AND state IN ('starting','running')",stamp(),runId);
        if (within) within(r);
        run('UPDATE ops_agent_runs SET state=?,revision=revision+1,updated_at=? WHERE id=?',reason,stamp(),runId);
        event(runId,null,reason);
      });
    },
    // A run that never reserved an attempt was never sent to the supervisor, so
    // there is nothing to tear down and no receipt to wait for.
    abandonUnlaunched(runId, reason, within=null) {
      if (!validUuid(runId) || !STOP_REASONS.includes(reason)) fail('INVALID_STOP');
      return tx(() => {
        const r=one('SELECT * FROM ops_agent_runs WHERE id=?',runId);
        if (!r || r.state!=='cancelling') fail('RUN_NOT_CANCELLING');
        if (one('SELECT 1 FROM ops_agent_worker_attempts WHERE run_id=?',runId)) fail('RUN_HAS_ATTEMPT');
        if (within) within(r);
        run('UPDATE ops_agent_runs SET state=?,revision=revision+1,updated_at=? WHERE id=?',reason,stamp(),runId);
        event(runId,null,`${reason}:unlaunched`);
      });
    },
    recover(within=null) {
      return tx(() => {
        const rows=db.prepare("SELECT id FROM ops_agent_runs WHERE state IN ('prepared','starting','running')").all();
        for (const {id} of rows) {
          // Keep the per-profile active slot occupied until a trusted runner
          // proves descendant and workspace teardown. Never replay an action.
          run("UPDATE ops_agent_runs SET state='cancelling',fence=fence+1,revision=revision+1,updated_at=? WHERE id=?",stamp(),id);
          run("UPDATE ops_agent_worker_attempts SET state='lost',stopped_at=? WHERE run_id=? AND state IN ('starting','running')",stamp(),id);
          event(id,null,'recovery_fenced');
          if (within) within(id);
        }
        return rows.map(row=>row.id);
      });
    },
  };
}
