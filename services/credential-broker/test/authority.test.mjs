import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,generateKeyPairSync} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {authorityFixture} from './authority-fixture.mjs';
import {isConfiguredAuthority} from '../authority.mjs';
import {signAuthoritySnapshot} from '../authority-publisher.mjs';
const denied=fn=>assert.throws(fn,e=>['AUTHORITY_DENIED','AUTHORITY_UNAVAILABLE','INVALID_REQUEST'].includes(e.code));

test('valid independently signed state activates; signature, challenge, lifetime and replay fail closed',async t=>{
 const f=authorityFixture(t);assert.equal(f.authority.health().ready,false);assert.equal(f.authority.eligible(f.session()),false);assert.equal(isConfiguredAuthority(f.authority),true);assert.equal(isConfiguredAuthority({}),false);
 const signed=f.snapshot();const ack=f.authority.ingest(signed);f.reserve();assert.equal(ack.sequence,1);assert.equal(f.authority.eligible(f.session()),true);denied(()=>f.authority.ingest(signed));
 const tampered=f.snapshot();tampered.records.users[0].disabled=true;denied(()=>f.authority.ingest(tampered));
 for(const override of [{challenge:'other'},{expires_at:f.now()+60001},{issued_at:f.now()+1},{expires_at:f.now()}])denied(()=>f.authority.ingest(f.snapshot(override)));
 const impostor=generateKeyPairSync('ed25519').privateKey.export({type:'pkcs8',format:'pem'}),{signature,...payload}=f.snapshot();denied(()=>f.authority.ingest(signAuthoritySnapshot(impostor,payload)));
 f.tick(60001);assert.equal(f.authority.eligible(f.session()),false);await assert.rejects(f.authority.authenticate('human'));assert.equal(f.authority.health().ready,false);
});

test('durable sequence, content revision and omitted-record floors survive restart; boot requires new lease',t=>{
 const f=authorityFixture(t),old=f.snapshot();f.authority.ingest(old);const challenge=f.authority.challenge();f.restart();assert.notEqual(f.authority.challenge(),challenge);assert.equal(f.authority.health().ready,false);denied(()=>f.authority.ingest(old));
 denied(()=>f.authority.ingest(f.snapshot({sequence:1})));f.publish();f.reserve();
 f.records.users[0].disabled=true;denied(()=>f.publish());f.records.users[0].revision++;f.publish();assert.equal(f.authority.eligible(f.session()),false);
 const user=f.records.users.pop();f.publish();f.records.users.push(user);denied(()=>f.publish());user.revision++;user.disabled=false;f.publish();assert.equal(f.authority.eligible(f.session()),false); // Old issued epoch stays invalid after user revision changes.
 assert.ok(readFileSync(f.options.statePath,'utf8').includes('sequence'));assert.ok(!readFileSync(f.options.statePath,'utf8').includes('PRIVATE KEY'));
});

test('current user/project/task/epoch/policy and Controls intersections gate every operation',t=>{
 const f=authorityFixture(t);f.publish();f.reserve();const valid=f.session();assert.equal(f.authority.eligible(valid),true);
 for(const [field,value]of Object.entries({user_id:randomUUID(),project_id:randomUUID(),agent_id:randomUUID(),task_id:randomUUID(),attempt:randomUUID(),fence:randomUUID(),grant_id:randomUUID(),connection_id:randomUUID(),audience:'vault',credential_version:2,policy_revision:2,operations:['arbitrary'],resources:[randomUUID()],limits:{max_actions:6,max_seconds:60}}))assert.equal(f.authority.eligible({...valid,[field]:value}),false,field);
 f.records.projects[0].revision++;f.records.projects[0].archived=true;f.publish();assert.equal(f.authority.eligible(valid),false);
});

test('human/delegation management requires independently bounded actions and exact policy review',async t=>{
 const f=authorityFixture(t);f.publish();const p=await f.authority.authenticate('human'),delegation=await f.authority.authenticate('delegation'),c=f.records.policies[0];
 assert.equal(f.authority.authorize(p,{action:'rotate',id:c.id,connection:c}),true);assert.equal(f.authority.authorize(delegation,{action:'get',id:c.id,connection:c}),true);
 denied(()=>f.authority.authorize(delegation,{action:'rotate',id:c.id,connection:c}));denied(()=>f.authority.authorize(delegation,{action:'approve',id:c.id,connection:c}));
 denied(()=>f.authority.authorize(p,{action:'rotate',id:randomUUID(),connection:c}));denied(()=>f.authority.authorize(p,{action:'enroll',body:{project_id:f.ids.project,adapter_id:'unsupported',...f.scope}}));
 assert.equal(f.authority.revalidatePolicy(p,{connection:c}),true);assert.equal(f.authority.revalidatePolicy(p,{connection:{...c,credential_version:2}}),false);assert.equal(f.authority.revalidatePolicy(delegation,{connection:c}),false);
 const g={user_id:f.ids.user,project_id:f.ids.project,agent_id:f.ids.agent,connection_id:c.id,...f.scope};assert.equal(f.authority.canAssign(p,g),true);assert.equal(f.authority.canAssign(p,{...g,resources:[randomUUID()]}),false);
 f.records.ceilings[0].revision++;f.records.ceilings[0].revoked=true;f.publish();denied(()=>f.authority.authorize(p,{action:'rotate',id:c.id,connection:c}));
});

test('workload proof is registered, exact, opaque, single use and task ending cannot revive same epoch',async t=>{
 const f=authorityFixture(t);f.publish();denied(()=>f.authority.issueWorkloadProof(randomUUID(),f.request()));denied(()=>f.authority.issueWorkloadProof(f.ids.workload,{...f.request(),fence:randomUUID()}));
 const proof=f.authority.issueWorkloadProof(f.ids.workload,f.request());assert.deepEqual(Object.keys(proof),[]);const p=await f.authority.authenticate(proof);assert.equal(p.proof_type,'workload');const {configuration_revision,...bound}=f.request();assert.deepEqual(p.workload_scope,bound);await assert.rejects(f.authority.authenticate(proof));denied(()=>f.authority.authorize(p,{action:'get',id:f.ids.connection,connection:f.records.policies[0]}));
 f.authority.endTask(f.ids.workload,{task_id:f.ids.task,attempt:f.ids.attempt,fence:f.ids.fence});assert.equal(f.authority.eligible(f.session()),false);denied(()=>f.authority.issueWorkloadProof(f.ids.workload,f.request()));
 f.records.tasks[0].revision++;f.publish();assert.equal(f.authority.eligible(f.session()),false);f.restart();f.publish();assert.equal(f.authority.eligible(f.session()),false);
 f.ids.attempt=randomUUID();f.ids.fence=randomUUID();Object.assign(f.records.tasks[0],{attempt:f.ids.attempt,fence:f.ids.fence,revision:3});f.publish();f.reserve();assert.equal(f.authority.eligible(f.session()),true);
});

test('task session reservation is durable and cannot multiply per-session Controls budget',async t=>{
 const f=authorityFixture(t);f.publish();const request=f.request();f.authority.issueWorkloadProof(f.ids.workload,request);
 assert.throws(()=>f.authority.issueWorkloadProof(f.ids.workload,request),e=>e.code==='TASK_SESSION_ALREADY_RESERVED');
 f.restart();f.publish();assert.throws(()=>f.authority.issueWorkloadProof(f.ids.workload,request),e=>e.code==='TASK_SESSION_ALREADY_RESERVED');
 f.ids.attempt=randomUUID();f.ids.fence=randomUUID();Object.assign(f.records.tasks[0],{attempt:f.ids.attempt,fence:f.ids.fence,revision:2});f.publish();assert.equal((await f.authority.authenticate(f.authority.issueWorkloadProof(f.ids.workload,f.request()))).proof_type,'workload');
});

test('record shapes, duplicate IDs, unsupported source records and altered same-revision policy are rejected',t=>{
 const f=authorityFixture(t);f.publish();f.reserve();
 for(const mutate of [
  r=>r.users.push({...r.users[0]}),r=>r.users[0].admin=true,r=>r.tasks[0].limits.max_actions=21,
  r=>r.policies[0].resources.push(randomUUID()),r=>r.unknown=[],r=>delete r.ceilings,
 ]){const records=structuredClone(f.records);mutate(records);denied(()=>f.authority.ingest(f.snapshot({records})));}
 assert.equal(f.authority.eligible(f.session()),true);
});

test('all independent source leases required and no source may replace another source record kind',async t=>{
 const f=authorityFixture();f.authority.close();
 const {createAuthority,AUTHORITY_KINDS}=await import('../authority.mjs');
 const sources=[{id:'identity',public_key:f.publicKey,kinds:['users']},{id:'policy',public_key:f.publicKey,kinds:AUTHORITY_KINDS.filter(k=>k!=='users')}];
 const a=createAuthority({...f.options,sources});t.after(()=>{a.close();f.close();});
 const publish=(source_id,records,sequence=1)=>a.ingest(signAuthoritySnapshot(f.privateKey,{version:'authority.v1',source_id,sequence,challenge:a.challenge(),issued_at:f.now(),expires_at:f.now()+60000,records}));
 publish('identity',{users:f.records.users});assert.equal(a.health().ready,false);
 const {users,...policyRecords}=f.records;publish('policy',policyRecords);assert.equal(a.health().ready,true);
 denied(()=>publish('identity',f.records,2));f.tick(60000);assert.equal(a.health().ready,false);assert.equal(a.eligible(f.session()),false);
});

test('body project cannot reinterpret independently global private connection scope',async t=>{
 const f=authorityFixture(t);f.records.policies[0].project_id=null;f.publish();const p=await f.authority.authenticate('human'),c=f.records.policies[0];
 denied(()=>f.authority.authorize(p,{action:'rotate',id:c.id,connection:c,body:{project_id:f.ids.project}}));
 f.records.ceilings[0].revision++;f.records.ceilings[0].project_id=null;f.publish();assert.equal(f.authority.authorize(p,{action:'rotate',id:c.id,connection:c}),true);
});

test('workload readiness requires current independent registration/user/project without reserving a task',async t=>{
 const f=authorityFixture(t);assert.equal(f.authority.workloadReady(f.ids.workload),false);f.publish();assert.equal(f.authority.workloadReady(f.ids.workload),true);assert.equal(f.authority.workloadReady(randomUUID()),false);assert.equal(f.authority.workloadReady('malformed'),false);
 // Readiness probes never reserve issuance or require a running task.
 f.records.tasks[0].revision++;f.records.tasks[0].status='ended';f.publish();assert.equal(f.authority.workloadReady(f.ids.workload),true);
 f.records.agents[0].revision++;f.records.agents[0].disabled=true;f.publish();assert.equal(f.authority.workloadReady(f.ids.workload),false);
 f.records.agents[0].revision++;f.records.agents[0].disabled=false;f.records.users[0].revision++;f.records.users[0].disabled=true;f.publish();assert.equal(f.authority.workloadReady(f.ids.workload),false);
 f.records.users[0].revision++;f.records.users[0].disabled=false;f.records.projects[0].revision++;f.records.projects[0].archived=true;f.publish();assert.equal(f.authority.workloadReady(f.ids.workload),false);
 f.records.projects[0].revision++;f.records.projects[0].archived=false;f.publish();assert.equal(f.authority.workloadReady(f.ids.workload),true);f.tick(60000);assert.equal(f.authority.workloadReady(f.ids.workload),false);
});

test('safe tests and write approvals remain inside actual protected operation/resource ceilings',async t=>{
 const f=authorityFixture(t),outside=randomUUID();f.records.policies[0].resources.unshift(outside);f.publish();const p=await f.authority.authenticate('human'),c=f.records.policies[0];
 denied(()=>f.authority.authorize(p,{action:'test',id:c.id,connection:c}));
 const preview={request:{connection_id:c.id,operation:'item.set_state',input:{resource_id:outside,state:'closed'}},limits:f.scope.limits};
 denied(()=>f.authority.authorize(p,{action:'approve',id:c.id,connection:c,body:preview}));
 preview.request.input.resource_id=f.ids.resource;assert.equal(f.authority.authorize(p,{action:'approve',id:c.id,connection:c,body:preview}),true);
 f.records.ceilings[0].revision++;f.records.ceilings[0].operations=['item.read'];f.publish();denied(()=>f.authority.authorize(p,{action:'approve',id:c.id,connection:c,body:preview}));
});

test('unassign-only authority permits removal but never assignment expansion',async t=>{
 const f=authorityFixture(t);f.records.ceilings[0].actions=['unassign'];f.publish();const p={...await f.authority.authenticate('human'),proof_type:'delegation',actions:['unassign']};const g={user_id:f.ids.user,project_id:f.ids.project,agent_id:f.ids.agent,connection_id:f.ids.connection,...f.scope};
 assert.equal(f.authority.canUnassign(p,g),true);assert.equal(f.authority.canAssign(p,g),false);assert.equal(f.authority.canUnassign(p,{...g,agent_id:randomUUID()}),false);assert.equal(f.authority.canUnassign({...p,actions:['assign']},g),false);
});

test('source revision changes permanently invalidate issued epoch through disable/reenable or scope restoration',t=>{
 const f=authorityFixture(t);f.publish();f.reserve();const issued=f.session();assert.equal(f.authority.eligible(issued),true);
 f.records.agents[0].revision++;f.records.agents[0].disabled=true;f.publish();assert.equal(f.authority.eligible(issued),false);
 f.records.agents[0].revision++;f.records.agents[0].disabled=false;f.publish();assert.equal(f.authority.eligible(issued),false);
 f.records.tasks[0].revision++;f.records.tasks[0].operations=['item.read'];f.publish();assert.equal(f.authority.eligible(issued),false);
 f.records.tasks[0].revision++;f.records.tasks[0].operations=[...f.scope.operations];f.publish();assert.equal(f.authority.eligible(issued),false);
 f.ids.attempt=randomUUID();f.ids.fence=randomUUID();Object.assign(f.records.tasks[0],{attempt:f.ids.attempt,fence:f.ids.fence,revision:5});f.publish();f.reserve();assert.equal(f.authority.eligible(f.session()),true);
});

test('signed guide/check/environment readiness and exact configuration pin gate preflight and actual issuance',t=>{
 const f=authorityFixture(t);f.publish();const request={id:f.ids.task,user_id:f.ids.user,project_id:f.ids.project,agent_id:f.ids.agent,grant_id:f.ids.grant,connection_id:f.ids.connection,attempt:f.ids.attempt,fence:f.ids.fence,configuration_revision:1,scope:{...f.scope,expires_at:f.now()+30000,audience:'fractionate-broker'},steps:[{operation:'item.read',input:{resource_id:f.ids.resource}}]};
 assert.equal(f.authority.checkTask(f.ids.workload,request).ready,true);
 denied(()=>f.authority.checkTask(f.ids.workload,{...request,configuration_revision:2}));denied(()=>f.authority.checkTask(f.ids.workload,{...request,agent_id:randomUUID()}));denied(()=>f.authority.issueWorkloadProof(f.ids.workload,{...f.request(),configuration_revision:2}));
 f.records.tasks[0].revision++;f.records.tasks[0].readiness.execution_approved=false;f.publish();denied(()=>f.authority.checkTask(f.ids.workload,request));denied(()=>f.reserve());
 f.records.tasks[0].revision++;f.records.tasks[0].readiness.execution_approved=true;f.publish();assert.equal(f.authority.checkTask(f.ids.workload,request).ready,true);f.reserve();denied(()=>f.authority.checkTask(f.ids.workload,request));assert.equal(f.authority.eligible(f.session()),true);
});

test('independent approval ceiling revision invalidates existing workload session and cannot revive it',t=>{
 const f=authorityFixture(t);f.publish();f.reserve();const session=f.session();assert.equal(f.authority.eligible(session),true);f.records.ceilings[0].revision++;f.records.ceilings[0].actions=f.records.ceilings[0].actions.filter(a=>a!=='approve');f.publish();assert.equal(f.authority.eligible(session),false);f.records.ceilings[0].revision++;f.records.ceilings[0].actions.push('approve');f.publish();assert.equal(f.authority.eligible(session),false);
});

test('catalogue project context requires current membership and list delegation but grants no connection permission',async t=>{
 const f=authorityFixture(t);f.publish();const p=await f.authority.authenticate('human');
 assert.equal(f.authority.canViewProject(p,f.ids.project),true);
 assert.equal(f.authority.canViewProject(p,randomUUID()),false);
 assert.equal(f.authority.canViewProject({...p,proof_type:'workload'},f.ids.project),false);
 assert.equal(f.authority.canViewProject({...p,proof_type:'delegation',actions:['get']},f.ids.project),false);
 assert.equal(f.authority.canViewProject({...p,proof_type:'delegation',actions:['list']},f.ids.project),true);
 f.records.ceilings=[];f.publish();assert.equal(f.authority.canViewProject(p,f.ids.project),true);
 denied(()=>f.authority.authorize(p,{action:'list',connection:f.records.policies[0]}));
 f.records.projects[0].revision++;f.records.projects[0].archived=true;f.publish();assert.equal(f.authority.canViewProject(p,f.ids.project),false);
 f.records.projects[0].revision++;f.records.projects[0].archived=false;f.records.users[0].revision++;f.records.users[0].disabled=true;f.publish();assert.equal(f.authority.canViewProject(p,f.ids.project),false);
});
