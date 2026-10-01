import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createBrokerDashboardHarness} from './helpers/broker-dashboard-harness.js';
test('current Controls bound assignment/session scope and config edits permanently stale issued sessions',async()=>{
 const h=await createBrokerDashboardHarness();
 try {
 const owner=h.users.owner,proof=h.proofForUser(owner),operations=['item.read'],resources=[h.resource],limits={max_actions:2,max_seconds:60};
 const controls={operations,resources,...limits};
 const {agent}=h.store.createConfiguration(owner,h.project.id,{workflow_type:'typed_api_v1',work:{name:'Bound'},controls});
 const connection=await h.broker.enroll(proof,{name:'Scope',project_id:h.project.id,adapter_id:'synthetic-ledger-v1',operations:['item.read','item.set_state'],resources,limits:{max_actions:20,max_seconds:300}},h.credential);
 await h.broker.testConnection(proof,connection.id,1);
 const grantInput={user_id:owner.id,project_id:h.project.id,agent_id:agent.id,operations,resources,limits,expires_at:Date.now()+120000};
 await assert.rejects(()=>h.broker.assign(proof,connection.id,1,{...grantInput,operations:['item.set_state']}),e=>e.code==='NOT_PERMITTED');
 await assert.rejects(()=>h.broker.assign(proof,connection.id,1,{...grantInput,limits:{...limits,max_actions:3}}),e=>e.code==='NOT_PERMITTED');
 const grant=await h.broker.assign(proof,connection.id,1,grantInput);
 const sessionInput={task_id:randomUUID(),attempt:randomUUID(),fence:randomUUID(),operations,resources,limits,expires_at:Date.now()+50000,audience:'fractionate-broker'};
 const session=await h.broker.issueSession(proof,grant.id,sessionInput);
 const request={connection_id:connection.id,operation:'item.read',input:{resource_id:h.resource}};
 assert.equal((await h.broker.execute(session.bearer,request,randomUUID())).state,'succeeded');
 h.store.updateConfiguration(owner,h.project.id,agent.id,1,{controls:{...controls,max_actions:1}});
 await assert.rejects(()=>h.broker.execute(session.bearer,request,randomUUID()),e=>e.code==='NOT_PERMITTED');
 await assert.rejects(()=>h.broker.issueSession(proof,grant.id,{...sessionInput,task_id:randomUUID()}),e=>e.code==='NOT_PERMITTED');
 h.store.updateConfiguration(owner,h.project.id,agent.id,2,{controls});
 await assert.rejects(()=>h.broker.execute(session.bearer,request,randomUUID()),e=>e.code==='NOT_PERMITTED');
 const fresh=await h.broker.issueSession(proof,grant.id,{...sessionInput,task_id:randomUUID()});
 assert.equal((await h.broker.execute(fresh.bearer,request,randomUUID())).state,'succeeded');
 h.store.updateConfiguration(owner,h.project.id,agent.id,3,{controls:{...controls,operations:[]}});
 assert.equal((await h.broker.unassign(proof,grant.id,1)).revoked,true);
 }finally{await h.close();}
});
