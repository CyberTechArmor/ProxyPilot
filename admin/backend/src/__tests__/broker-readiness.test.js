import {test} from 'node:test';import assert from 'node:assert/strict';
import {createBrokerDashboardHarness} from './helpers/broker-dashboard-harness.js';
import {assessConfigurationConnections} from '../lib/operational-configuration-readiness.js';
test('readiness HTTP observes assignment, rotation and revocation while execution remains unavailable',async()=>{
 const h=await createBrokerDashboardHarness();let server;
 try {
 const owner=h.users.owner,proof=h.proofForUser(owner),controls={operations:['item.read'],resources:[h.resource],max_actions:2,max_seconds:60};
 const {agent}=h.store.createConfiguration(owner,h.project.id,{workflow_type:'typed_api_v1',work:{name:'Readiness'},controls});
 server=h.app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const cookies=Object.entries(h.dashboardCookies(owner)).map(([k,v])=>`${k}=${v}`).join('; ');
 const url=`http://127.0.0.1:${server.address().port}/operational-projects/${h.project.id}/agent-configurations/${agent.id}/readiness`;
 const read=async()=>{const res=await fetch(url,{headers:{Cookie:cookies}});assert.equal(res.status,200);const data=await res.json();assert.equal(data.can_start,false);assert.equal(data.execution_enabled,false);return data;};
 assert.equal((await read()).checks.find(c=>c.kind==='assignment').state,'unverified');
 const c=await h.broker.enroll(proof,{name:'Fixture',project_id:h.project.id,adapter_id:'synthetic-ledger-v1',operations:controls.operations,resources:controls.resources,limits:{max_actions:20,max_seconds:300}},h.credential);
 await h.broker.testConnection(proof,c.id,1);
 await h.broker.assign(proof,c.id,1,{user_id:owner.id,agent_id:agent.id,project_id:h.project.id,operations:controls.operations,resources:controls.resources,limits:{max_actions:2,max_seconds:60},expires_at:Date.now()+60000});
 const assigned=await read();assert.equal(assigned.checks.find(c=>c.kind==='assignment').state,'ready');assert.equal(assigned.connections[0].credential_version,1);assert.equal(assigned.connections[0].effective_limits.max_actions,2);
 const rotated=await h.broker.rotate(proof,c.id,1,h.credential);
 const rotation=await read();assert.equal(rotation.connections[0].credential_version,2);assert.equal(rotation.checks.find(c=>c.kind==='credential').state,'unverified');assert.equal(rotation.checks.find(c=>c.kind==='assignment').state,'unverified');
 await h.broker.testConnection(proof,c.id,rotated.revision);assert.equal((await read()).checks.find(c=>c.kind==='assignment').state,'ready');
 await h.broker.revoke(proof,c.id,rotated.revision);const revoked=await read();assert.equal(revoked.checks.find(c=>c.kind==='assignment').state,'revoked');assert.equal(revoked.connections[0].credential_status,'revoked');assert.equal(JSON.stringify(revoked).includes(h.credential),false);
 }finally{if(server)await new Promise(r=>server.close(r));await h.close();}
});
test('malformed or unavailable metadata fails closed with no error content',async()=>{
 const readiness={checks:[{kind:'broker',state:'unavailable'}],state:'blocked',can_start:false};
 const failed=await assessConfigurationConnections({readConnections:async()=>{throw Error('secret-canary');},actor:{},agent:{},readiness});
 assert.equal(failed.checks.find(c=>c.kind==='broker').code,'BROKER_UNAVAILABLE');assert.equal(JSON.stringify(failed).includes('secret-canary'),false);assert.deepEqual(failed.connections,[]);
 assert.equal(await assessConfigurationConnections({readConnections:null,readiness}),readiness);
});
test('shared permission ceiling absent from public projection cannot claim an effective scope',async()=>{
 const {randomUUID}=await import('node:crypto');const user=randomUUID(),agentId=randomUUID(),project=randomUUID(),resource=randomUUID();
 const agent={id:agentId,project_id:project,controls:{operations:['item.read'],resources:[resource],max_actions:20,max_seconds:300}};
 const connection={id:randomUUID(),owner_id:randomUUID(),project_id:project,name:'Shared',adapter_id:'synthetic-ledger-v1',revision:1,policy_revision:1,credential_version:1,status:'active',operations:['item.read'],resources:[resource],limits:{max_actions:20,max_seconds:300},rights:['view','use'],readiness:{state:'ready',code:'SYNTHETIC_ONLY'},sessions:[],assignments:[{id:randomUUID(),agent_id:agentId,project_id:project,user_id:user,revision:1,revoked:false,operations:['item.read'],resources:[resource],limits:{max_actions:20,max_seconds:300},expires_at:Date.now()+60000}]};
 const result=await assessConfigurationConnections({readConnections:async()=>({connections:[connection],next_cursor:null}),actor:{id:user},agent,readiness:{checks:[]}});
 assert.equal(result.checks.find(c=>c.kind==='assignment').state,'unverified');assert.equal(result.connections[0].code,'PERMISSION_SCOPE_UNVERIFIED');assert.deepEqual(result.connections[0].effective_operations,[]);assert.equal(result.connections[0].effective_limits.max_actions,0);
});
