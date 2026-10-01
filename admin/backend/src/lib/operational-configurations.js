import { z } from 'zod';
import { parse, fail, validId } from './operational-projects-logic.js';
export function operationalConfigurationsMigration1113(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS ops_agent_configurations (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES ops_projects(id),
    revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0),
    lifecycle TEXT NOT NULL DEFAULT 'draft' CHECK(lifecycle='draft'),
    execution_enabled INTEGER NOT NULL DEFAULT 0 CHECK(execution_enabled=0),
    workflow_type TEXT NOT NULL CHECK(workflow_type='typed_api_v1'),
    work_json TEXT NOT NULL, controls_json TEXT NOT NULL,
    created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS ops_configurations_project ON ops_agent_configurations(project_id,id);`);
}
const narrative = z.string().max(4096).default('');
// Inert bounded narrative only: these strings are never fetched or executed.
const texts = z.array(z.string().max(4096)).max(32).default([]);
const work = z.object({ name:z.string().trim().min(1).max(200), role:narrative, task:narrative,
  expected_outcome:narrative, inputs:texts, supporting_material:texts,
  guide_ref:z.object({id:z.string().uuid(),hash:z.string().regex(/^[a-f0-9]{64}$/)}).strict().nullable().default(null),
  environment_ref:z.string().uuid().nullable().default(null) }).strict();
const controls = z.object({ operations:z.array(z.enum(['item.read','item.set_state'])).max(2).default([]),
  resources:z.array(z.string().uuid()).max(32).default([]), max_seconds:z.number().int().min(1).max(300).default(300),
  max_actions:z.number().int().min(1).max(20).default(20), approval_policy:z.literal('writes').default('writes'),
  output_ref:z.string().uuid().nullable().default(null), escalation_user_ids:z.array(z.string().uuid()).max(32).default([]) }).strict();
const create = z.object({workflow_type:z.literal('typed_api_v1'),work,controls:controls.default({})}).strict();
const patch = z.object({work:work.optional(),controls:controls.optional()}).strict().refine(v=>Object.keys(v).length>0);
export function createConfigurationsStore({one,all,run,tx,access,event,now,uuid,workflow}) {
  const projectAgent=(id,agentId)=> {
    const row=validId(agentId)&&one('SELECT * FROM ops_agent_configurations WHERE project_id=? AND id=?',id,agentId);
    if(!row) fail(404,'Operational record not found');
    const {work_json,controls_json,...a}=row;
    return {...a,execution_enabled:false,work:JSON.parse(work_json),controls:JSON.parse(controls_json)};
  };
  function guide(id,v) { if(v?.guide_ref) {
    const current=workflow.current(id);
    if(current?.id!==v.guide_ref.id || current?.content_hash!==v.guide_ref.hash) fail(400,'Guide is not current');
  }}
  function readiness(p,a) {
    const current=workflow.current(p.id), approved=a.work.guide_ref && current?.id===a.work.guide_ref.id && current?.content_hash===a.work.guide_ref.hash;
    return {contract_version:'broker.v1',agent_id:a.id,state:'blocked',can_start:false,execution_enabled:false,
      pins:{agent_revision:a.revision,project_revision:p.revision},checks:[
        {kind:'broker',state:'unavailable',code:'BROKER_NOT_ACTIVATED',next_action:'review_deployment'},
        {kind:'guide',state:approved?'ready':a.work.guide_ref?'stale':'unfinished',code:approved?'GUIDE_APPROVED':'GUIDE_REQUIRED',next_action:approved?null:'select_guide'},
        {kind:'environment',state:a.work.environment_ref?'unverified':'unfinished',code:a.work.environment_ref?'ENVIRONMENT_UNVERIFIED':'ENVIRONMENT_REQUIRED',next_action:'verify_environment'},
        {kind:'assignment',state:'unverified',code:'ASSIGNMENT_UNVERIFIED',next_action:'select_connection'},
        {kind:'project',state:p.archived_at?'unavailable':'ready',code:p.archived_at?'PROJECT_ARCHIVED':'PROJECT_ACTIVE',next_action:p.archived_at?'restore_project':null}]};
  }
  return {
    configurations(actor,id) {access(actor,id); return {agents:all('SELECT id FROM ops_agent_configurations WHERE project_id=? ORDER BY id',id).map(r=>projectAgent(id,r.id))};},
    configuration(actor,id,agentId) {const {p}=access(actor,id); const agent=projectAgent(id,agentId); return {agent,readiness:readiness(p,agent)};},
    createConfiguration(actor,id,input) {const v=parse(create,input);return tx(()=>{
      const {p}=access(actor,id,'edit');guide(id,v.work);const aid=uuid(),at=now();
      run('INSERT INTO ops_agent_configurations(id,project_id,workflow_type,work_json,controls_json,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',aid,id,v.workflow_type,JSON.stringify(v.work),JSON.stringify(v.controls),actor.id,at,at);
      event(actor,id,'agent_configuration_created',aid);const agent=projectAgent(id,aid);return {agent,readiness:readiness(p,agent)};
    });},
    updateConfiguration(actor,id,agentId,expected,input) {const v=parse(patch,input);return tx(()=>{
      const {p}=access(actor,id,'edit');const old=projectAgent(id,agentId);
      if(expected!==old.revision) fail(409,'The record changed; reload before saving');guide(id,v.work);
      run('UPDATE ops_agent_configurations SET work_json=?,controls_json=?,revision=revision+1,updated_at=? WHERE id=?',JSON.stringify(v.work??old.work),JSON.stringify(v.controls??old.controls),now(),agentId);
      event(actor,id,'agent_configuration_updated',agentId);const agent=projectAgent(id,agentId);return {agent,readiness:readiness(p,agent)};
    });}
  };
}
