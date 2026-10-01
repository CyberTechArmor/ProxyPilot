import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {OperationsError} from './operational-projects-logic.js';
const uuid=z.string().uuid();
const schema=z.object({configuration_revision:z.number().int().positive(),connection_id:uuid,grant_id:uuid,operation:z.enum(['item.read','item.set_state']),resource_id:uuid,state:z.enum(['open','closed']).optional()}).strict();
const fail=(status,code)=>{throw Object.assign(new OperationsError(status,code),{code});};
export function brokerTaskProposalsMigration1115(db){db.exec(`CREATE TABLE ops_broker_task_proposals (
 id TEXT PRIMARY KEY,user_id TEXT NOT NULL,project_id TEXT NOT NULL REFERENCES ops_projects(id),agent_id TEXT NOT NULL REFERENCES ops_agent_configurations(id),
 configuration_revision INTEGER NOT NULL,request_json TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('prepared','consumed')),expires_at INTEGER NOT NULL,created_at INTEGER NOT NULL);`);}
export function createBrokerTaskProposals({db,store,dispatch,clock=Date.now}){
 const get=id=>db.prepare('SELECT * FROM ops_broker_task_proposals WHERE id=?').get(id);
 function access(actor,pid,aid){const p=store.get(actor,pid),{agent}=store.configuration(actor,pid,aid);if(p.archived_at||!['owner','editor'].includes(p.own_role))fail(403,'NOT_PERMITTED');return agent;}
 return {
  async prepare(actor,pid,aid,body){const parsed=schema.safeParse(body);if(!parsed.success)fail(400,'INVALID_REQUEST');const v=parsed.data,a=access(actor,pid,aid);
   if(a.revision!==v.configuration_revision)fail(409,'REVISION_MISMATCH');if(!a.work.environment_ref||!a.controls.output_ref||!a.work.guide_ref)fail(409,'TASK_NOT_READY');
   if((v.operation==='item.read'&&v.state!==undefined)||(v.operation==='item.set_state'&&v.state===undefined))fail(400,'INVALID_REQUEST');
   const now=clock(),expires_at=now+Math.min(a.controls.max_seconds,60)*1000,id=randomUUID();
   const request={task_id:randomUUID(),attempt:randomUUID(),fence:randomUUID(),configuration_revision:a.revision,connection_id:v.connection_id,grant_id:v.grant_id,
    scope:{operations:[v.operation],resources:[v.resource_id],limits:{max_actions:1,max_seconds:Math.min(a.controls.max_seconds,60)},expires_at,audience:'fractionate-broker'},steps:[{operation:v.operation,input:{resource_id:v.resource_id,...(v.state?{state:v.state}:{})}}]};
   const result=await dispatch.readiness(actor,pid,aid,request);
   if(access(actor,pid,aid).revision!==a.revision)fail(409,'REVISION_MISMATCH');
   db.prepare("INSERT INTO ops_broker_task_proposals VALUES(?,?,?,?,?,?, 'prepared',?,?)").run(id,actor.id,pid,aid,a.revision,JSON.stringify(request),expires_at,now);
   return {proposal:{id,expires_at,...v},readiness:result.readiness};
  },
  async start(actor,pid,aid,id){const row=db.transaction(()=>{const a=access(actor,pid,aid),r=get(id);if(!r||r.user_id!==actor.id||r.project_id!==pid||r.agent_id!==aid)fail(404,'NOT_FOUND');if(r.configuration_revision!==a.revision)fail(409,'REVISION_MISMATCH');if(r.state!=='prepared')fail(409,'IDEMPOTENCY_CONFLICT');if(r.expires_at<=clock())fail(409,'TASK_NOT_READY');
    // Consume before contacting source/runner. A lost response cannot repeat
    // authorization or dispatch; the task list is the recovery read path.
    db.prepare("UPDATE ops_broker_task_proposals SET state='consumed' WHERE id=? AND state='prepared'").run(id);return r;
   }).immediate();return dispatch.start(actor,pid,aid,JSON.parse(row.request_json));},
 };
}
