// Supplemental dashboard->real broker policy proof. The vault/upstream adapters
// here are fixtures; disposable real OpenBao proof lives in the service suite.
import {test} from 'node:test';import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import express from 'express';
import {createIntakeHandler} from '../../../../services/credential-broker/intake.mjs';
import {createBroker} from '../../../../services/credential-broker/broker.mjs';
import {createSyntheticBrokerBridge} from '../lib/credential-broker-bridge.js';
import {createConnectionsRouter} from '../routes/connections.js';
import {operationsFixture} from './helpers/operations-fixture.js';
test('HTTP bridge enforces real broker private ownership, assign ceilings and revocation',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'dashboard-broker-')),f=operationsFixture();let server,broker,intake;
 try {
 const owner=f.addUser(),other=f.addUser('admin'),p=f.store.create(owner,{name:'Fixture'});
 const agent=f.store.createConfiguration(owner,p.id,{workflow_type:'typed_api_v1',work:{name:'Draft'}}).agent;
 const resource=randomUUID(),proofs=new Map([[owner.id,randomUUID()],[other.id,randomUUID()]]),secrets=new Map();
 broker=createBroker({mode:'synthetic',dbPath:join(directory,'state.db'),
 authority:{authenticate:async proof=>{const pair=[...proofs].find(([,v])=>v===proof);return pair?{user_id:pair[0],fresh_until:Date.now()+60000}:null;},eligible:async()=>true,canAssign:async(person,g)=>person.user_id===owner.id&&g.user_id===owner.id&&g.project_id===p.id&&g.agent_id===agent.id},
 vault:{write:async(path,value,{intent})=>{secrets.set(path,{value,intent,version:1});return {version:1};},read:async(path)=>secrets.get(path)},upstream:{execute:async(_operation,input)=>({...input,state:'open'})}});
 const connection=await broker.enroll(proofs.get(owner.id),{name:'Synthetic',project_id:p.id,adapter_id:'synthetic-ledger-v1',operations:['item.read'],resources:[resource],limits:{max_actions:20,max_seconds:300}},'fixture-canary-not-a-live-key');
 intake=createIntakeHandler({mode:'synthetic',broker,origin:'https://fixture.test',statePath:join(directory,'intake.json'),authenticateRequest:async()=>null,
   authenticateProof:async proof=>{const pair=[...proofs].find(([,v])=>v===proof);return pair?{user_id:pair[0],fresh_until:Date.now()+60000}:null;}});
 const bridge=createSyntheticBrokerBridge({broker,resolveProof:async id=>proofs.get(id),isolatedFixture:true,intake,intakeOrigin:'https://fixture.test',fixtureScope:{operations:['item.read'],resources:[resource],limits:{max_actions:20,max_seconds:300}}});
 const app=express();app.use(express.json());app.use((req,res,next)=>{req.user=req.get('X-Fixture-User')===other.id?other:owner;next();});
 app.use('/api/connections',createConnectionsRouter({Router:express.Router,store:f.store,bridge,requireSudo:(_q,_r,next)=>next()}));server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const base=`http://127.0.0.1:${server.address().port}/api/connections`;
 const request=(path,method='GET',body,actor=owner)=>fetch(base+path,{method,headers:{'Content-Type':'application/json','X-Fixture-User':actor.id,'If-Match':'"1"'},...(body?{body:JSON.stringify(body)}:{})});
 const caps=await (await request('/capabilities')).json();assert.equal(caps.intake_enabled,true);assert.equal(caps.intake_origin,'https://fixture.test');
 const reserved=await request('/enrollment-intents','POST',{name:'Intake',project_id:p.id,adapter_id:'synthetic-ledger-v1'});assert.equal(reserved.status,200);
 const intent=(await reserved.json()).intent;assert.equal(intent.state,'reserved');assert.equal(new URL(intent.intake_url).origin,'https://fixture.test');
 assert.equal((await request('/enrollment-intents/'+intent.id,'GET',null,other)).status,404);
 assert.equal((await request('/enrollment-intents/'+intent.id)).status,200);
 const list=await (await request('')).json();assert.equal(list.connections.length,1);assert.equal(JSON.stringify(list).includes('fixture-canary'),false);
 assert.equal((await request('/'+connection.id,'GET',null,other)).status,404);
 assert.equal((await (await request('','GET',null,other)).json()).connections.length,0);
 assert.equal((await request('/'+connection.id+'/test','POST',{})).status,200);
 const picker=await request(`?project_id=${p.id}&assignable_to_agent_id=${agent.id}`);
 assert.equal(picker.status,200);assert.equal((await picker.json()).connections.length,1);
 assert.equal((await request(`?project_id=${p.id}&assignable_to_agent_id=${randomUUID()}`)).status,404);
 const grant={user_id:owner.id,project_id:p.id,agent_id:agent.id,operations:['item.read'],resources:[resource],limits:{max_actions:2,max_seconds:60},expires_at:new Date(Date.now()+60000).toISOString()};
 assert.equal((await request('/'+connection.id+'/assignments','POST',{...grant,operations:['item.set_state']})).status,403);
 const assigned=await request('/'+connection.id+'/assignments','POST',grant);assert.equal(assigned.status,200);
 const revoked=await request('/'+connection.id+'/revoke','POST',{});assert.equal(revoked.status,200);assert.equal((await revoked.json()).connection.status,'revoked');
 assert.equal((await request('/'+connection.id+'/activity')).status,200);
 }finally{if(server)await new Promise(r=>server.close(r));intake?.close();broker?.close();f.close();rmSync(directory,{recursive:true,force:true});}
});
