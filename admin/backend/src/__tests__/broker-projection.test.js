import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {projectBrokerResponse} from '../lib/credential-broker-projection.js';
const id=randomUUID(),actor_id=randomUUID(),connection_id=randomUUID();
const receipt={id,type:'operation',connection_id,actor_id,revision:1,operation:'item.read',state:'succeeded',status:'succeeded',code:null,created_at:1,completed_at:2,at:2,recovery_of:null,cost:{state:'not_applicable',amount:null}};
test('operation activity retains bounded receipt metadata and strips every content/capability field',()=>{
 const canary='secret-value-not-for-dashboard';
 const result=projectBrokerResponse('activity',{events:[{...receipt,result:{resource_id:randomUUID(),state:'open',echo:canary},input:{secret:canary},token:canary,vault_path:canary,cost:{...receipt.cost,raw:canary}},{id:randomUUID(),type:'policy_revalidated',connection_id,actor_id,revision:2,at:3,proof:canary}]});
 assert.equal(result.events[0].status,'succeeded');assert.equal(result.events[1].type,'policy_revalidated');
 assert.equal(JSON.stringify(result).includes(canary),false);assert.equal('result' in result.events[0],false);
 for(const state of ['reserved','sending','succeeded','failed','uncertain'])assert.equal(projectBrokerResponse('activity',{events:[{...receipt,state,status:state,code:state==='uncertain'?'OPERATION_UNCERTAIN':null}]}).events[0].state,state);
 assert.throws(()=>projectBrokerResponse('activity',{events:[{...receipt,code:canary}]}));
 assert.throws(()=>projectBrokerResponse('activity',{events:[{...receipt,status:'failed'}]}));
});
test('policy quarantine is faithfully displayed without credential data',()=>{
 const connection={id:connection_id,name:'Fixture',owner_id:actor_id,project_id:null,adapter_id:'synthetic-ledger-v1',revision:2,policy_revision:1,credential_version:1,status:'active',operations:['item.read'],resources:[randomUUID()],limits:{max_seconds:300,max_actions:20},rights:['view','manage'],readiness:{state:'blocked',code:'POLICY_REVALIDATION_REQUIRED'},assignments:[],sessions:[],credential:'canary'};
 const projected=projectBrokerResponse('get',{connection});assert.equal(projected.connection.readiness.code,'POLICY_REVALIDATION_REQUIRED');assert.equal('credential' in projected.connection,false);
});
