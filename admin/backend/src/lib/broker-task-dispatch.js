import {randomUUID,createHash} from 'node:crypto';
import {z} from 'zod';
import {OperationsError} from './operational-projects-logic.js';
const uuid=z.string().uuid(),operation=z.enum(['item.read','item.set_state']);
const scope=z.object({operations:z.array(operation).min(1).max(2),resources:z.array(uuid).min(1).max(32),limits:z.object({max_actions:z.number().int().min(1).max(20),max_seconds:z.number().int().min(1).max(300)}).strict(),expires_at:z.number().int().positive(),audience:z.literal('fractionate-broker')}).strict();
const input=z.object({resource_id:uuid,state:z.enum(['open','closed']).optional()}).strict();
const startSchema=z.object({task_id:uuid,grant_id:uuid,connection_id:uuid,attempt:uuid,fence:uuid,scope,steps:z.array(z.object({operation,input}).strict()).min(1).max(20),configuration_revision:z.number().int().positive()}).strict();
const fail=(status,code)=>{throw Object.assign(new OperationsError(status,code),{code});};
export function brokerTaskMigration1114(db){db.exec(`CREATE TABLE IF NOT EXISTS ops_broker_tasks (
 id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES ops_projects(id),agent_id TEXT NOT NULL REFERENCES ops_agent_configurations(id),
 user_id TEXT NOT NULL,attempt TEXT NOT NULL,fence TEXT NOT NULL,configuration_revision INTEGER NOT NULL,request_digest TEXT NOT NULL,
 state TEXT NOT NULL,receipt_json TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS ops_broker_tasks_agent ON ops_broker_tasks(project_id,agent_id,created_at);`);}
// Worker output is capability-free: refuse unknown receipt schemas rather than
// returning an arbitrary remote error/session/bearer to the browser.
const state=z.enum(['reserved','starting','preparing','interrupted','queued','issuing','running','awaiting_approval','succeeded','completed','blocked','failed','uncertain','cancelling','cancelled']);
const receipt=z.object({id:uuid,user_id:uuid,project_id:uuid,agent_id:uuid,configuration_revision:z.number().int().positive(),attempt:uuid,fence:uuid,state,session_id:uuid.nullable(),
 step_index:z.number().int().min(0).max(20),end_confirmed:z.boolean(),
 receipts:z.array(z.object({id:uuid,state:z.enum(['succeeded','failed','denied','uncertain']),operation})).max(20),
 pending_approval:z.object({session_id:uuid,request:z.object({connection_id:uuid,operation,input})}).nullable(),
 code:z.enum(['WORKER_RESTARTED','OPERATION_UNCERTAIN','OPERATION_FAILED','SESSION_EXPIRED','SESSION_NOT_ISSUED','TASK_CANCELLED']).nullable()});
export function createBrokerTaskDispatch({db,store,runner,authoritySource=null,clock=()=>new Date().toISOString()}) {
 // A process restart cannot replay dispatch or presume completion.
 db.prepare("UPDATE ops_broker_tasks SET state='uncertain' WHERE state IN ('starting','preparing','running','issuing','cancelling')").run();
 const get=id=>db.prepare('SELECT * FROM ops_broker_tasks WHERE id=?').get(id);
 const publicRow=row=>({id:row.id,project_id:row.project_id,agent_id:row.agent_id,user_id:row.user_id,configuration_revision:row.configuration_revision,attempt:row.attempt,fence:row.fence,state:row.state,created_at:row.created_at,updated_at:row.updated_at,...(row.receipt_json?{receipt:JSON.parse(row.receipt_json)}:{})});
 function access(actor,projectId,agentId,mutation=false){const p=store.get(actor,projectId);const {agent}=store.configuration(actor,projectId,agentId);if(mutation&&(p.archived_at||!['owner','editor'].includes(p.own_role)))fail(403,'NOT_PERMITTED');return agent;}
 function own(actor,projectId,agentId,id,mutation=false){access(actor,projectId,agentId,mutation);const row=get(id);if(!row||row.project_id!==projectId||row.agent_id!==agentId||row.user_id!==actor.id)fail(404,'NOT_FOUND');return row;}
 function persist(id,result){const value=receipt.parse(result?.task??result);const row=get(id);if(value.id!==id||value.user_id!==row.user_id||value.project_id!==row.project_id||value.agent_id!==row.agent_id||value.configuration_revision!==row.configuration_revision||value.attempt!==row.attempt||value.fence!==row.fence)throw Error();db.prepare('UPDATE ops_broker_tasks SET state=?,receipt_json=?,updated_at=? WHERE id=?').run(value.state,JSON.stringify(value),clock(),id);return publicRow(get(id));}
 async function call(id,fn,uncertainOnFailure=true){try{return persist(id,await fn());}catch{if(uncertainOnFailure)db.prepare("UPDATE ops_broker_tasks SET state='uncertain',receipt_json=NULL,updated_at=? WHERE id=?").run(clock(),id);return {...publicRow(get(id)),worker_available:false};}}
 function prepare(actor,pid,aid,body){const parsed=startSchema.safeParse(body);if(!parsed.success)fail(400,'INVALID_REQUEST');const v=parsed.data;const agent=access(actor,pid,aid,true);if(!runner)fail(503,'BROKER_UNAVAILABLE');if(agent.revision!==v.configuration_revision)fail(409,'REVISION_MISMATCH');
   const c=agent.controls,s=v.scope;if(!s.operations.every(x=>c.operations.includes(x))||!s.resources.every(x=>c.resources.includes(x))||s.limits.max_actions>c.max_actions||s.limits.max_seconds>c.max_seconds||v.steps.length>s.limits.max_actions||s.expires_at<=Date.parse(clock())||s.expires_at>Date.parse(clock())+s.limits.max_seconds*1000)fail(403,'SCOPE_EXCEEDED');
   if(v.steps.some(step=>!s.operations.includes(step.operation)||!s.resources.includes(step.input.resource_id)||(step.operation==='item.read'&&step.input.state!==undefined)||(step.operation==='item.set_state'&&step.input.state===undefined)))fail(400,'INVALID_REQUEST');
   const request={id:v.task_id,user_id:actor.id,project_id:pid,agent_id:aid,grant_id:v.grant_id,connection_id:v.connection_id,attempt:v.attempt,fence:v.fence,scope:s,steps:v.steps,configuration_revision:v.configuration_revision};
   return {v,request};
 }
 async function verifyTask(request,sourceMethod=null){
   if(!sourceMethod&&typeof runner?.checkTask!=='function')fail(503,'TASK_READINESS_UNAVAILABLE');
   let value;try{value=sourceMethod?(await authoritySource[sourceMethod](request))?.readiness:await runner.checkTask(request);}catch{fail(503,'TASK_READINESS_UNAVAILABLE');}
   const parsed=z.object({ready:z.literal(true),task_id:uuid,user_id:uuid,project_id:uuid,agent_id:uuid,configuration_revision:z.number().int().positive(),attempt:uuid,fence:uuid,expires_at:z.number().int().positive()}).safeParse(value);
   if(!parsed.success)fail(409,'TASK_NOT_READY');const r=parsed.data;
   for(const k of ['user_id','project_id','agent_id','configuration_revision','attempt','fence'])if(r[k]!==request[k])fail(409,'TASK_NOT_READY');
   const now=Date.parse(clock());if(r.task_id!==request.id||r.expires_at<=now||r.expires_at>now+60000)fail(409,'TASK_NOT_READY');
   return r;
 }
 const api={
  async registrations(actor,pid){store.get(actor,pid);if(!authoritySource)fail(503,'AUTHORITY_SOURCE_UNAVAILABLE');try{return await authoritySource.registrations({user_id:actor.id,project_id:pid});}catch{fail(503,'AUTHORITY_SOURCE_UNAVAILABLE');}},
  list(actor,pid,aid){access(actor,pid,aid);return {tasks:db.prepare('SELECT * FROM ops_broker_tasks WHERE project_id=? AND agent_id=? AND user_id=? ORDER BY created_at DESC LIMIT 100').all(pid,aid,actor.id).map(publicRow)};},
  async readiness(actor,pid,aid,body){const {request}=prepare(actor,pid,aid,body);return {readiness:await verifyTask(request,authoritySource?'previewTask':null)};},
  async start(actor,pid,aid,body){const {v,request}=prepare(actor,pid,aid,body);if(get(v.task_id))fail(409,'IDEMPOTENCY_CONFLICT');await verifyTask(request,authoritySource?'previewTask':null);
   const digest=createHash('sha256').update(JSON.stringify(request)).digest('hex'),timestamp=clock();
   db.transaction(()=>{if(get(v.task_id))fail(409,'IDEMPOTENCY_CONFLICT');if(access(actor,pid,aid,true).revision!==v.configuration_revision)fail(409,'REVISION_MISMATCH');db.prepare('INSERT INTO ops_broker_tasks(id,project_id,agent_id,user_id,attempt,fence,configuration_revision,request_digest,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(v.task_id,pid,aid,actor.id,v.attempt,v.fence,v.configuration_revision,digest,'starting',timestamp,timestamp);}).immediate();
   if(authoritySource){try{await verifyTask(request,'authorizeTask');await verifyTask(request);}catch(e){db.prepare("UPDATE ops_broker_tasks SET state='blocked',updated_at=? WHERE id=?").run(clock(),v.task_id);throw e;}}
   return {task:await call(v.task_id,()=>runner.startTask(request))};
  },
  async status(actor,pid,aid,id){own(actor,pid,aid,id);if(!runner)return {task:publicRow(get(id))};return {task:await call(id,()=>runner.status(id),false)};},
  async cancel(actor,pid,aid,id){own(actor,pid,aid,id);if(!runner)fail(503,'BROKER_UNAVAILABLE');return {task:await call(id,()=>runner.cancelTask(id))};},
  async approve(actor,pid,aid,id,body){const parsed=z.object({approval_id:uuid}).strict().safeParse(body);if(!parsed.success)fail(400,'INVALID_REQUEST');const row=own(actor,pid,aid,id,true);if(access(actor,pid,aid,true).revision!==row.configuration_revision)fail(409,'REVISION_MISMATCH');if(!runner)fail(503,'BROKER_UNAVAILABLE');if(row.state!=='awaiting_approval')fail(409,'NOT_PERMITTED');return {task:await call(id,()=>runner.continueTask(id,parsed.data))};}
 };
 return api;
}
