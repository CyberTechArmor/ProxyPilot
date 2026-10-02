import {test} from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {operationsFixture} from './helpers/operations-fixture.js';import {brokerTaskMigration1114,createBrokerTaskDispatch} from '../lib/broker-task-dispatch.js';import {brokerTaskProposalsMigration1115,createBrokerTaskProposals} from '../lib/broker-task-proposals.js';
const ready=r=>({ready:true,task_id:r.id,user_id:r.user_id,project_id:r.project_id,agent_id:r.agent_id,configuration_revision:r.configuration_revision,attempt:r.attempt,fence:r.fence,expires_at:Date.now()+10000});
test('saved configuration proposals derive epochs and require current source at explicit single-use start',async()=>{
 const f=operationsFixture();try{brokerTaskMigration1114(f.adapter);brokerTaskProposalsMigration1115(f.adapter);const owner=f.addUser(),other=f.addUser(),reviewer=f.addUser(),p=f.store.create(owner,{name:'Saved'}),resource=randomUUID(),environment=randomUUID(),output=randomUUID();f.store.grant(owner,p.id,reviewer.id,p.revision,{role:'reviewer'});
 const v=f.store.saveDraft(owner,p.id,1,{title:'Reviewed',instructions:'Bounded API read'}).version;
 const {agent}=f.store.createConfiguration(owner,p.id,{workflow_type:'typed_api_v1',work:{name:'Saved draft',guide_ref:{id:v.id,hash:v.content_hash},environment_ref:environment},controls:{operations:['item.read'],resources:[resource],max_seconds:60,max_actions:1,output_ref:output}});
 let publishes=0,sends=0,preview=true;const source={previewTask:async r=>{if(!preview)throw Error();return {readiness:ready(r)};},authorizeTask:async r=>{publishes++;assert.equal(f.db.prepare('SELECT state FROM ops_broker_tasks WHERE id=?').get(r.id).state,'starting');return {readiness:ready(r)};}};
 const runner={checkTask:async r=>ready(r),startTask:async r=>{sends++;return {...r,state:'completed',session_id:randomUUID(),step_index:1,end_confirmed:true,receipts:[],pending_approval:null,code:null};}};
 const dispatch=createBrokerTaskDispatch({db:f.adapter,store:f.store,runner,authoritySource:source}),proposals=createBrokerTaskProposals({db:f.adapter,store:f.store,dispatch});
 const body={configuration_revision:1,connection_id:randomUUID(),grant_id:randomUUID(),operation:'item.read',resource_id:resource};
 await assert.rejects(()=>proposals.prepare(other,p.id,agent.id,body));await assert.rejects(()=>proposals.prepare(owner,p.id,agent.id,{...body,operation:'item.set_state',state:'open'}),e=>e.code==='SCOPE_EXCEEDED');
 const result=await proposals.prepare(owner,p.id,agent.id,body);assert.equal(result.readiness.ready,true);assert.equal(publishes,0);assert.equal(sends,0);assert.equal(result.proposal.task_id,undefined);assert.equal(agent.execution_enabled,false);
 preview=false;await assert.rejects(()=>proposals.start(owner,p.id,agent.id,result.proposal.id));assert.equal(sends,0);preview=true;await assert.rejects(()=>proposals.start(owner,p.id,agent.id,result.proposal.id),e=>e.code==='IDEMPOTENCY_CONFLICT');
 const good=await proposals.prepare(owner,p.id,agent.id,body);const started=await proposals.start(owner,p.id,agent.id,good.proposal.id);assert.equal(started.task.state,'completed');assert.equal(publishes,1);assert.equal(sends,1);await assert.rejects(()=>proposals.start(owner,p.id,agent.id,good.proposal.id));
 const stale=await proposals.prepare(owner,p.id,agent.id,body);f.store.updateConfiguration(owner,p.id,agent.id,1,{controls:{...agent.controls,resources:[]}});await assert.rejects(()=>proposals.start(owner,p.id,agent.id,stale.proposal.id),e=>e.code==='REVISION_MISMATCH');assert.equal(sends,1);
 }finally{f.close();}
});

test('saved-task HTTP routes keep fresh proof and Operations feature gates before authorization',async()=>{
 const {fixtureRouter}=await import('./helpers/operations-fixture.js');const {createOperationsRouter}=await import('../routes/operational-projects.js');
 const f=operationsFixture();try{const owner=f.addUser(),p=f.store.create(owner,{name:'Fresh proof'});let starts=0,previews=0;
 const proposals={prepare:async()=>{previews++;return {proposal:{id:randomUUID()}};},start:async()=>{starts++;return {task:{id:randomUUID()}};}};
 const make=opts=>createOperationsRouter({Router:fixtureRouter,store:f.store,enabled:true,agentsEnabled:true,brokerTaskProposals:proposals,...opts});
 const path=`/${p.id}/agent-configurations/${randomUUID()}/task-proposals`,req=(suffix='',body={})=>({method:'POST',path:path+suffix,url:path+suffix,user:owner,body});
 const denied=await make({}).dispatch(req('/'+randomUUID()+'/start'));assert.equal(denied.statusCode,401);assert.equal(starts,0);
 const missing=await make({enabled:false}).dispatch(req());assert.equal(missing.statusCode,404);assert.equal(previews,0);
 const noBody=await make({requireSudo:(_r,_s,next)=>next()}).dispatch(req('/'+randomUUID()+'/start',{unexpected:true}));assert.equal(noBody.statusCode,400);assert.equal(starts,0);
 const allowed=await make({requireSudo:(_r,_s,next)=>next()}).dispatch(req('/'+randomUUID()+'/start'));assert.equal(allowed.statusCode,202);assert.equal(starts,1);
 }finally{f.close();}
});
