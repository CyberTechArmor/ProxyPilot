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
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/i;
const ACTIVE = new Set(['prepared', 'starting', 'running']);
const REQUIRED_ACTION = Object.freeze({open_landing:'navigate',open_login:'click',
  read_workspace:'navigate',read_session:'read',read_files:'read',sign_out:'logout'});
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

export function validateWorkerLaunch(value) {
  if (!fields(value, ['run_id','attempt_id','workspace_id','fence','policy_digest','project_limits_revision',
    'origin','target','limits','install'])) fail('INVALID_LAUNCH');
  if (!validUuid(value.run_id) || !validUuid(value.attempt_id) || !validUuid(value.workspace_id) ||
      !Number.isSafeInteger(value.fence) || value.fence < 1 || !HASH.test(value.policy_digest || '') ||
      !Number.isSafeInteger(value.project_limits_revision) || value.project_limits_revision < 0 ||
      value.origin !== 'https://demo.fractionate.ai' || value.target !== WORKER_TARGET ||
      !agentLimits.safeParse(value.limits).success) fail('INVALID_LAUNCH');
  const install=workerInstallResources(value.limits);
  if (!fields(value.install,Object.keys(WORKER_INSTALL_BASELINE)) ||
      Object.keys(install).some(key=>value.install[key]!==install[key])) fail('INVALID_LAUNCH');
  return Object.freeze({...value, limits: Object.freeze({...value.limits}),install});
}

export function validateBrowserAction(value) {
  if (!fields(value, ['run_id','attempt_id','fence','action']) ||
      !validUuid(value.run_id) || !validUuid(value.attempt_id) ||
      !Number.isSafeInteger(value.fence) || value.fence < 1 ||
      !BROWSER_ACTIONS.includes(value.action)) fail('INVALID_BROWSER_ACTION');
  return value;
}

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
      const result=await connected().request('action', {run_id:request.run_id,attempt_id:request.attempt_id,
        fence:request.fence,action:request.action});
      if (!result || !Number.isSafeInteger(result.ordinal) || result.untrusted!==true) fail('SUPERVISOR_PROTOCOL');
      return result;
    },
    async stop(ref, reason='cancelled') {
      if (!validRef(ref) || !['cancelled','blocked','failed'].includes(reason)) fail('INVALID_STOP');
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
    return {profile,project:p};
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
    prepare(input) {
      if (!fields(input, ['project_id','profile_id','profile_revision','site_origin','site_revision',
        'guide_version_id','guide_hash','policy_digest']) ||
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
        profilePolicy(p,input.site_origin);
        const limits=projectLimits(project);
        workerInstallResources(limits);
        const id = uuid(), now = clock();
        const deadlineMs=limits.max_seconds == null ? null : now.getTime() + limits.max_seconds*1000;
        if (deadlineMs != null && (!Number.isFinite(deadlineMs) || deadlineMs > 8.64e15)) fail('INVALID_PROJECT_LIMITS');
        const deadline=deadlineMs == null ? null : new Date(deadlineMs).toISOString();
        run(`INSERT INTO ops_agent_runs(id,project_id,profile_id,profile_revision,site_origin,site_revision,
          guide_version_id,guide_hash,policy_digest,project_limits_revision,max_seconds,max_actions,state,started_at,deadline_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'prepared',?,?,?)`, id,input.project_id,input.profile_id,input.profile_revision,
          input.site_origin,input.site_revision,input.guide_version_id,input.guide_hash,input.policy_digest,
          project.agent_limits_revision,limits.max_seconds??null,limits.max_actions??null,
          now.toISOString(),deadline,now.toISOString());
        event(id,null,'prepared');
        return {run_id:id,deadline_at:deadline};
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
      const {project}=assertPinnedConfiguration(r);
      const limits=projectLimits(project);
      return validateWorkerLaunch({run_id:r.id,attempt_id:a.id,workspace_id:a.workspace_id,fence:a.fence,
        policy_digest:r.policy_digest,project_limits_revision:r.project_limits_revision,
        origin:r.site_origin,target:WORKER_TARGET,limits,install:workerInstallResources(limits)});
    },
    authorizeAction(request) {
      validateBrowserAction(request);
      return tx(() => {
        const {r,profile}=current(request.run_id,request.attempt_id,request.fence);
        if (request.action==='submit_bound_fixture') fail('CREDENTIAL_BROKER_UNAVAILABLE');
        const {actions}=profilePolicy(profile,r.site_origin);
        if (!actions.includes(REQUIRED_ACTION[request.action])) fail('ACTION_NOT_CONFIGURED');
        if (r.max_actions != null && r.action_count >= r.max_actions) fail('ACTION_LIMIT');
        run('UPDATE ops_agent_runs SET action_count=action_count+1,revision=revision+1,updated_at=? WHERE id=?',stamp(),r.id);
        event(r.id,request.attempt_id,`action:${request.action}`);
        return {ordinal:r.action_count+1};
      });
    },
    fence(runId, reason='cancelled') {
      if (!validUuid(runId) || !['cancelled','blocked','failed'].includes(reason)) fail('INVALID_STOP');
      return tx(() => {
        const r=one('SELECT * FROM ops_agent_runs WHERE id=?',runId);
        if (!r || !ACTIVE.has(r.state)) fail('RUN_NOT_ACTIVE');
        const attempt=one("SELECT id,fence FROM ops_agent_worker_attempts WHERE run_id=? AND state IN ('starting','running')",runId);
        run("UPDATE ops_agent_runs SET state='cancelling',fence=fence+1,revision=revision+1,updated_at=? WHERE id=?",stamp(),runId);
        event(runId,null,`fenced:${reason}`);
        return {run_id:runId,attempt_id:attempt?.id??null,previous_fence:r.fence,reason};
      });
    },
    finishStop(runId, reason, receipt) {
      if (!validUuid(runId) || !['cancelled','blocked','failed'].includes(reason)) fail('INVALID_STOP');
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
        run('UPDATE ops_agent_runs SET state=?,revision=revision+1,updated_at=? WHERE id=?',reason,stamp(),runId);
        event(runId,null,reason);
      });
    },
    recover() {
      return tx(() => {
        const rows=db.prepare("SELECT id FROM ops_agent_runs WHERE state IN ('prepared','starting','running')").all();
        for (const {id} of rows) {
          // Keep the per-profile active slot occupied until a trusted runner
          // proves descendant and workspace teardown. Never replay an action.
          run("UPDATE ops_agent_runs SET state='cancelling',fence=fence+1,revision=revision+1,updated_at=? WHERE id=?",stamp(),id);
          run("UPDATE ops_agent_worker_attempts SET state='lost',stopped_at=? WHERE run_id=? AND state IN ('starting','running')",stamp(),id);
          event(id,null,'recovery_fenced');
        }
        return rows.map(row=>row.id);
      });
    },
  };
}
