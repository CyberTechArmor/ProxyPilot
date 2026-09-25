import { randomUUID } from 'node:crypto';

// Internal A3 contract. No caller-controlled argv, path, URL, selector or bytes.
// An OS runner is deliberately absent until its limits are measured on target.
export const WORKER_TARGET = 'incus-disposable-vm-browser-v1';
export const WORKER_LIMITS = Object.freeze({ cpu: 1, memory_mib: 512,
  temporary_disk_mib: 128, browser_trees: 1, wall_seconds: 300, actions: 20 });
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

export function validateWorkerLaunch(value) {
  if (!fields(value, ['run_id','attempt_id','fence','policy_digest','origin','target','limits'])) fail('INVALID_LAUNCH');
  if (!validUuid(value.run_id) || !validUuid(value.attempt_id) ||
      !Number.isSafeInteger(value.fence) || value.fence < 1 || !HASH.test(value.policy_digest || '') ||
      value.origin !== 'https://demo.fractionate.ai' || value.target !== WORKER_TARGET ||
      !fields(value.limits, Object.keys(WORKER_LIMITS)) ||
      Object.entries(WORKER_LIMITS).some(([key, n]) => value.limits[key] !== n)) fail('INVALID_LAUNCH');
  return Object.freeze({...value, limits: WORKER_LIMITS});
}

export function validateBrowserAction(value) {
  if (!fields(value, ['run_id','attempt_id','fence','action']) ||
      !validUuid(value.run_id) || !validUuid(value.attempt_id) ||
      !Number.isSafeInteger(value.fence) || value.fence < 1 ||
      !BROWSER_ACTIONS.includes(value.action)) fail('INVALID_BROWSER_ACTION');
  return value;
}

// The only launch/stop surface exposed in A3. A target implementation must be
// supplied after independent OS proof. Silent fallback to spawn/host-exec is forbidden.
export function createWorkerLauncher() {
  return {
    async launch(spec) {
      validateWorkerLaunch(spec);
      fail('BOUNDARY_UNVERIFIED');
    },
    async stop(ref) {
      if (!fields(ref, ['run_id','attempt_id','fence']) ||
          !validUuid(ref.run_id) || !validUuid(ref.attempt_id) ||
          !Number.isSafeInteger(ref.fence) || ref.fence < 1) fail('INVALID_STOP');
      fail('BOUNDARY_UNVERIFIED');
    },
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
        !profile || profile.revision!==r.profile_revision || profile.guide_version_id!==r.guide_version_id ||
        profile.guide_hash!==r.guide_hash || profile.assigned_site_revision!==r.site_revision ||
        !guide || withdrawn || guide.id!==r.guide_version_id || guide.content_hash!==r.guide_hash)
      fail('STALE_CONFIGURATION');
    return profile;
  }
  function profilePolicy(profile, origin) {
    let origins, actions, budgets;
    try {
      origins=JSON.parse(profile.proposed_origins_json);
      actions=JSON.parse(profile.proposed_actions_json);
      budgets=JSON.parse(profile.budgets_json);
    } catch { fail('INVALID_PROFILE_POLICY'); }
    if (profile.workflow_type!=='synthetic_sign_in' || !Array.isArray(origins) ||
        !origins.includes(origin) || !Array.isArray(actions) ||
        !Number.isSafeInteger(budgets?.max_seconds) || budgets.max_seconds<1 || budgets.max_seconds>300 ||
        !Number.isSafeInteger(budgets?.max_actions) || budgets.max_actions<1 || budgets.max_actions>20)
      fail('INVALID_PROFILE_POLICY');
    return {actions,budgets};
  }
  function current(runId, attemptId, fence) {
    const r = one('SELECT * FROM ops_agent_runs WHERE id=?', runId);
    const a = one('SELECT * FROM ops_agent_worker_attempts WHERE id=? AND run_id=?', attemptId, runId);
    if (!r || !a || r.fence !== fence || a.fence !== fence ||
        r.state !== 'running' || a.state !== 'running' ||
        stamp() >= r.deadline_at || stamp() >= a.lease_expires_at) fail('STALE_WORKER');
    const profile=assertPinnedConfiguration(r);
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
        const {budgets}=profilePolicy(p,input.site_origin);
        const id = uuid(), now = clock(), deadline = new Date(now.getTime() + budgets.max_seconds*1000).toISOString();
        run(`INSERT INTO ops_agent_runs(id,project_id,profile_id,profile_revision,site_origin,site_revision,
          guide_version_id,guide_hash,policy_digest,max_seconds,max_actions,state,started_at,deadline_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,'prepared',?,?,?)`, id,input.project_id,input.profile_id,input.profile_revision,
          input.site_origin,input.site_revision,input.guide_version_id,input.guide_hash,input.policy_digest,
          budgets.max_seconds,budgets.max_actions,
          now.toISOString(),deadline,now.toISOString());
        event(id,null,'prepared');
        return {run_id:id,deadline_at:deadline};
      });
    },
    reserveAttempt(runId) {
      if (!validUuid(runId)) fail('INVALID_RUN');
      return tx(() => {
        const r=one('SELECT * FROM ops_agent_runs WHERE id=?',runId);
        if (!r || r.state !== 'prepared' || stamp() >= r.deadline_at) fail('RUN_NOT_PREPARED');
        assertPinnedConfiguration(r);
        const id=uuid(), workspaceId=uuid(), fence=r.fence+1;
        run("UPDATE ops_agent_runs SET state='starting',fence=?,revision=revision+1,updated_at=? WHERE id=?",fence,stamp(),runId);
        run(`INSERT INTO ops_agent_worker_attempts(id,run_id,attempt_no,fence,state,lease_expires_at,workspace_id,created_at)
          VALUES(?,?,1,?,'starting',?,?,?)`,id,runId,fence,r.deadline_at,workspaceId,stamp());
        event(runId,id,'attempt_reserved');
        return {run_id:runId,attempt_id:id,fence,workspace_id:workspaceId};
      });
    },
    markRunning(ref) {
      return tx(() => {
        const r=one('SELECT * FROM ops_agent_runs WHERE id=?',ref.run_id);
        const a=one('SELECT * FROM ops_agent_worker_attempts WHERE id=? AND run_id=?',ref.attempt_id,ref.run_id);
        if (!r || !a || r.state!=='starting' || a.state!=='starting' ||
            r.fence!==ref.fence || a.fence!==ref.fence || stamp()>=r.deadline_at) fail('STALE_WORKER');
        assertPinnedConfiguration(r);
        run("UPDATE ops_agent_runs SET state='running',revision=revision+1,updated_at=? WHERE id=?",stamp(),ref.run_id);
        run("UPDATE ops_agent_worker_attempts SET state='running' WHERE id=?",ref.attempt_id);
        event(ref.run_id,ref.attempt_id,'running');
      });
    },
    authorizeAction(request) {
      validateBrowserAction(request);
      return tx(() => {
        const {r,profile}=current(request.run_id,request.attempt_id,request.fence);
        if (request.action==='submit_bound_fixture') fail('CREDENTIAL_BROKER_UNAVAILABLE');
        const {actions}=profilePolicy(profile,r.site_origin);
        if (!actions.includes(REQUIRED_ACTION[request.action])) fail('ACTION_NOT_CONFIGURED');
        if (r.action_count >= r.max_actions) fail('ACTION_LIMIT');
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
        const attempt=one('SELECT id,fence,workspace_id FROM ops_agent_worker_attempts WHERE run_id=? ORDER BY attempt_no DESC LIMIT 1',runId);
        if (!fields(receipt,['run_id','attempt_id','fence','descendants_gone','workspace_removed','attestation']) ||
            receipt.run_id!==runId || receipt.attempt_id!==(attempt?.id??null) ||
            receipt.fence!==(attempt?.fence??0) || receipt.descendants_gone!==true ||
            receipt.workspace_removed!==true || typeof receipt.attestation!=='string' ||
            !verifyTeardown || verifyTeardown(receipt,{run_id:runId,attempt_id:attempt?.id??null,
              fence:attempt?.fence??0,workspace_id:attempt?.workspace_id??null})!==true)
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
