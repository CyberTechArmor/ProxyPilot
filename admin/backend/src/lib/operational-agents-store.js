import { assertRevision, fail, parse, schemas, siteOrigin, validId } from './operational-projects-logic.js';

// Metadata and membership only. The only dependencies are the Operations DB
// primitives, so a profile write has no path to a worker, vault or provider.
export function createOperationalAgentsStore({ one, all, run, tx, access, eligible, event, bump, now, uuid, user, workflow }) {
  const project = id => one('SELECT * FROM ops_projects WHERE id=?', id);
  const profileRow = (id, profileId) => validId(profileId) && one(
    'SELECT * FROM ops_agent_profiles WHERE project_id=? AND id=? AND deleted_at IS NULL', id, profileId);
  function profile(id, row) {
    const p = project(id), current = workflow.current(id);
    const proposed_origins = JSON.parse(row.proposed_origins_json);
    const disabled_reasons = ['Execution is unavailable in A2'];
    if (!p.site_origin) disabled_reasons.push('Project site is not set');
    else if (!proposed_origins.includes(p.site_origin)) disabled_reasons.push('Project site is outside proposed origins');
    if (row.guide_version_id && row.assigned_site_revision !== p.site_revision)
      disabled_reasons.push('Project site changed since guide assignment');
    if (!row.guide_version_id) disabled_reasons.push('No guide assigned');
    else if (current?.id !== row.guide_version_id || current?.content_hash !== row.guide_hash)
      disabled_reasons.push('Assigned guide is no longer current');
    return { id: row.id, project_id: id, display_name: row.display_name, workflow_type: row.workflow_type,
      proposed_actions: JSON.parse(row.proposed_actions_json), proposed_origins,
      budgets: JSON.parse(row.budgets_json), guide_version_id: row.guide_version_id,
      guide_hash: row.guide_hash, guide_version_number: current?.id === row.guide_version_id ? current.version_number : null,
      revision: row.revision, site_revision: p.site_revision, assigned_site_revision: row.assigned_site_revision,
      disabled: true, disabled_reasons,
      created_by: row.created_by, created_at: row.created_at, updated_by: row.updated_by, updated_at: row.updated_at };
  }
  function fields(input, schema) {
    const v = parse(schema, input);
    if ('proposed_origins' in v) {
      v.proposed_origins = v.proposed_origins.map(siteOrigin);
      if (v.proposed_origins.includes(null) || new Set(v.proposed_origins).size !== v.proposed_origins.length)
        fail(400, 'Proposed origins must be distinct HTTPS origins');
    }
    return v;
  }
  return {
    auditDenied(actor,requestedProjectId,action,status) {
      if (!actor?.id) return;
      run('INSERT INTO ops_agent_denials(actor_id,requested_project_id,action,status,created_at) VALUES(?,?,?,?,?)',
        actor.id,validId(requestedProjectId)?requestedProjectId:null,action,status,now());
    },
    directory(actor,input={}) {
      eligible(actor);
      const q=parse(schemas.directory,input);
      const rows=all(`SELECT p.id,p.name,p.visibility FROM ops_projects p WHERE p.visibility!='hidden'
        AND p.archived_at IS NULL AND p.owner_user_id!=?
        AND NOT EXISTS(SELECT 1 FROM ops_project_grants g WHERE g.project_id=p.id AND g.user_id=?)
        AND p.id>? ORDER BY p.id LIMIT ?`, actor.id, actor.id,q.after||'',q.limit+1);
      return { projects: rows.slice(0,q.limit).map(p => ({...p,
          request_state: one("SELECT state FROM ops_access_requests WHERE project_id=? AND user_id=? ORDER BY requested_at DESC,rowid DESC LIMIT 1",p.id,actor.id)?.state || null })),
        next_cursor:rows.length>q.limit?rows[q.limit-1].id:null };
    },
    visibility(actor, id, expected, input) {
      const v = parse(schemas.visibility, input);
      return tx(() => {
        const {p} = access(actor,id,'access'); assertRevision(expected,p.revision);
        if (p.archived_at) fail(409,'Operational record is archived');
        if (p.visibility === 'hidden' && v.visibility !== 'hidden' && v.reviewed_visibility !== 'Expose redacted project card')
          fail(400,'Review and confirm the redacted discovery change');
        if (v.visibility !== p.visibility) {
          run('UPDATE ops_projects SET visibility=? WHERE id=?',v.visibility,id);
          if (v.visibility === 'hidden') run("UPDATE ops_access_requests SET state='cancelled',revision=revision+1,decided_at=?,decided_by=? WHERE project_id=? AND state='pending'",now(),actor.id,id);
          event(actor,id,'visibility_changed',null,{from:p.visibility,to:v.visibility,reviewed:v.reviewed_visibility=== 'Expose redacted project card'});
          bump(id);
        }
        return {visibility:v.visibility,revision:p.revision+(v.visibility===p.visibility?0:1)};
      });
    },
    site(actor,id,expected,input) {
      const v=parse(schemas.site,input), origin=siteOrigin(v.site_origin);
      return tx(()=>{
        const {p}=access(actor,id,'access'); assertRevision(expected,p.revision);
        if(p.archived_at) fail(409,'Operational record is archived');
        if(p.site_origin!==origin) {
          run('UPDATE ops_projects SET site_origin=?,site_revision=site_revision+1 WHERE id=?',origin,id);
          event(actor,id,'site_origin_changed',null,{site_revision:p.site_revision+1,cleared:origin===null});bump(id);
        }
        return {site_origin:origin,site_revision:p.site_revision+(p.site_origin===origin?0:1),revision:p.revision+(p.site_origin===origin?0:1)};
      });
    },
    request(actor,id) {
      return tx(()=>{
        eligible(actor);
        if(!validId(id)) fail(404,'Operational record not found');
        const p=project(id);
        if(!p || p.visibility==='hidden' || p.archived_at) fail(404,'Operational record not found');
        if(p.owner_user_id===actor.id || one('SELECT 1 FROM ops_project_grants WHERE project_id=? AND user_id=?',id,actor.id)) fail(409,'Already a member');
        const pending=one("SELECT id FROM ops_access_requests WHERE project_id=? AND user_id=? AND state='pending'",id,actor.id);
        if(pending) return {request_id:pending.id,state:'pending',replayed:true};
        const requestId=uuid();
        run('INSERT INTO ops_access_requests(id,project_id,user_id,requested_at) VALUES(?,?,?,?)',requestId,id,actor.id,now());
        event(actor,id,'access_requested',requestId);bump(id);
        return {request_id:requestId,state:'pending',replayed:false};
      });
    },
    requests(actor,id) {
      access(actor,id,'access');
      return {requests:all(`SELECT r.*,u.username FROM ops_access_requests r LEFT JOIN users u ON u.id=r.user_id
        WHERE r.project_id=? AND r.state='pending' ORDER BY r.requested_at,r.id LIMIT 100`,id)};
    },
    decideRequest(actor,id,requestId,expected,input) {
      const v=parse(schemas.accessDecision,input);
      return tx(()=>{
        const {p}=access(actor,id,'access');assertRevision(expected,p.revision);
        if(p.archived_at) fail(409,'Operational record is archived');
        const r=validId(requestId)&&one('SELECT * FROM ops_access_requests WHERE project_id=? AND id=?',id,requestId);
        if(!r || r.state!=='pending') fail(409,'Membership request is no longer pending');
        if(p.visibility==='hidden') fail(409,'Project is hidden');
        if(v.decision==='approve' && p.visibility==='read-only' && v.role!=='viewer') fail(409,'Read-only discovery requests may receive viewer access only');
        const target=user(r.user_id);
        if(!target || !['user','admin'].includes(target.role)) fail(409,'Requester account is no longer eligible');
        if(v.decision==='approve') run(`INSERT INTO ops_project_grants(project_id,user_id,role,granted_by,granted_at) VALUES(?,?,?,?,?)
          ON CONFLICT(project_id,user_id) DO UPDATE SET role=excluded.role,granted_by=excluded.granted_by,granted_at=excluded.granted_at`,id,r.user_id,v.role,actor.id,now());
        run('UPDATE ops_access_requests SET state=?,revision=revision+1,decided_at=?,decided_by=? WHERE id=?',v.decision==='approve'?'approved':'declined',now(),actor.id,requestId);
        event(actor,id,v.decision==='approve'?'access_approved':'access_declined',requestId,{user_id:r.user_id,role:v.role||null});bump(id);
        return {ok:true,revision:p.revision+1};
      });
    },
    profiles(actor,id) {
      access(actor,id);
      return {profiles:all('SELECT * FROM ops_agent_profiles WHERE project_id=? AND deleted_at IS NULL ORDER BY id',id).map(r=>profile(id,r))};
    },
    profile(actor,id,profileId) {
      access(actor,id);
      const r=profileRow(id,profileId);if(!r) fail(404,'Profile not found');
      return {profile:profile(id,r)};
    },
    createProfile(actor,id,expected,input) {
      const v=fields(input,schemas.profileCreate);
      return tx(()=>{
        const {p}=access(actor,id,'edit');assertRevision(expected,p.revision);
        const timestamp=now(),profileId=uuid();
        run(`INSERT INTO ops_agent_profiles(id,project_id,display_name,workflow_type,proposed_actions_json,proposed_origins_json,budgets_json,created_by,created_at,updated_by,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?)`,profileId,id,v.display_name,v.workflow_type,JSON.stringify(v.proposed_actions),JSON.stringify(v.proposed_origins),JSON.stringify(v.budgets),actor.id,timestamp,actor.id,timestamp);
        event(actor,id,'profile_created',profileId);bump(id);
        return {profile:profile(id,profileRow(id,profileId))};
      });
    },
    updateProfile(actor,id,profileId,expected,input) {
      const v=fields(input,schemas.profileUpdate);
      return tx(()=>{
        access(actor,id,'edit');const r=profileRow(id,profileId);if(!r) fail(404,'Profile not found');assertRevision(expected,r.revision);
        run(`UPDATE ops_agent_profiles SET display_name=?,workflow_type=?,proposed_actions_json=?,proposed_origins_json=?,budgets_json=?,
          revision=revision+1,updated_by=?,updated_at=? WHERE id=?`,v.display_name??r.display_name,v.workflow_type??r.workflow_type,
          JSON.stringify(v.proposed_actions??JSON.parse(r.proposed_actions_json)),JSON.stringify(v.proposed_origins??JSON.parse(r.proposed_origins_json)),
          JSON.stringify(v.budgets??JSON.parse(r.budgets_json)),actor.id,now(),profileId);
        event(actor,id,'profile_updated',profileId,{fields:Object.keys(v)});bump(id);
        return {profile:profile(id,profileRow(id,profileId))};
      });
    },
    assignProfile(actor,id,profileId,expected,input) {
      const v=parse(schemas.profileAssignment,input);
      return tx(()=>{
        const {p}=access(actor,id,'edit');const r=profileRow(id,profileId);if(!r) fail(404,'Profile not found');assertRevision(expected,r.revision);
        const current=workflow.current(id);
        if(v.guide_version_id && (!current || current.id!==v.guide_version_id)) fail(409,'Assign the current independently approved guide only');
        run('UPDATE ops_agent_profiles SET guide_version_id=?,guide_hash=?,assigned_site_revision=?,revision=revision+1,updated_by=?,updated_at=? WHERE id=?',
          v.guide_version_id,v.guide_version_id?current.content_hash:null,v.guide_version_id?p.site_revision:null,actor.id,now(),profileId);
        event(actor,id,'profile_guide_assigned',profileId,{guide_version_id:v.guide_version_id,guide_hash:v.guide_version_id?current.content_hash:null});bump(id);
        return {profile:profile(id,profileRow(id,profileId))};
      });
    },
    deleteProfile(actor,id,profileId,expected) {
      return tx(()=>{
        access(actor,id,'edit');const r=profileRow(id,profileId);if(!r) fail(404,'Profile not found');assertRevision(expected,r.revision);
        run('UPDATE ops_agent_profiles SET deleted_at=?,revision=revision+1,updated_by=?,updated_at=? WHERE id=?',now(),actor.id,now(),profileId);
        event(actor,id,'profile_deleted',profileId);bump(id);return {ok:true};
      });
    },
  };
}
