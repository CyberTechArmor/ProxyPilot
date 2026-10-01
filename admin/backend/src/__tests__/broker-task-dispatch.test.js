import {test} from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {operationsFixture} from './helpers/operations-fixture.js';
const ready=r=>({ready:true,task_id:r.id,user_id:r.user_id,project_id:r.project_id,agent_id:r.agent_id,configuration_revision:r.configuration_revision,attempt:r.attempt,fence:r.fence,expires_at:Date.now()+30000});
import {brokerTaskMigration1114,createBrokerTaskDispatch} from '../lib/broker-task-dispatch.js';
test('explicit task dispatch is durable scoped revision-bound and never retries uncertain start',async()=>{
 const f=operationsFixture();try {
 brokerTaskMigration1114(f.adapter);const owner=f.addUser(),other=f.addUser('admin'),project=f.store.create(owner,{name:'Worker'}),resource=randomUUID();
 const {agent}=f.store.createConfiguration(owner,project.id,{workflow_type:'typed_api_v1',work:{name:'Configured'},controls:{operations:['item.read'],resources:[resource],max_actions:2,max_seconds:60}});
 let calls=0,received;const runner={checkTask:async r=>ready(r),startTask:async request=>{calls++;received=request;throw Error('Possible send secret response');},status:async()=>({...received,state:'completed',session_id:randomUUID(),step_index:1,end_confirmed:true,receipts:[],pending_approval:null,code:null,token:'secret-bearer'}),cancelTask:async()=>({...received,state:'cancelled',session_id:null,step_index:0,end_confirmed:true,receipts:[],pending_approval:null,code:null})};
 const dispatch=createBrokerTaskDispatch({db:f.adapter,store:f.store,runner});
 const body={task_id:randomUUID(),grant_id:randomUUID(),connection_id:randomUUID(),attempt:randomUUID(),fence:randomUUID(),configuration_revision:1,scope:{operations:['item.read'],resources:[resource],limits:{max_actions:2,max_seconds:60},expires_at:Date.now()+50000,audience:'fractionate-broker'},steps:[{operation:'item.read',input:{resource_id:resource}}]};
 await assert.rejects(()=>dispatch.start(other,project.id,agent.id,body),e=>e.status===404);assert.equal(calls,0);
 await assert.rejects(()=>dispatch.start(owner,project.id,agent.id,{...body,configuration_revision:2}),e=>e.code==='REVISION_MISMATCH');assert.equal(calls,0);
 await assert.rejects(()=>dispatch.start(owner,project.id,agent.id,{...body,scope:{...body.scope,limits:{max_actions:3,max_seconds:60}}}),e=>e.code==='SCOPE_EXCEEDED');
 runner.checkTask=async r=>({...ready(r),fence:randomUUID()});await assert.rejects(()=>dispatch.start(owner,project.id,agent.id,body),e=>e.code==='TASK_NOT_READY');assert.equal(calls,0);assert.equal(dispatch.list(owner,project.id,agent.id).tasks.length,0);
 for(const expires_at of [Date.now()-1,Date.now()+120000]){runner.checkTask=async r=>({...ready(r),expires_at});await assert.rejects(()=>dispatch.start(owner,project.id,agent.id,body),e=>e.code==='TASK_NOT_READY');}
 assert.equal(calls,0);runner.checkTask=undefined;await assert.rejects(()=>dispatch.start(owner,project.id,agent.id,body),e=>e.code==='TASK_READINESS_UNAVAILABLE');
 runner.checkTask=async r=>ready(r);
 const result=await dispatch.start(owner,project.id,agent.id,body);assert.equal(result.task.state,'uncertain');assert.equal(calls,1);assert.equal(received.user_id,owner.id);
 await assert.rejects(()=>dispatch.start(owner,project.id,agent.id,body),e=>e.code==='IDEMPOTENCY_CONFLICT');assert.equal(calls,1);
 runner.status=async()=>({...received,attempt:randomUUID(),state:'completed',session_id:randomUUID(),step_index:1,end_confirmed:true,receipts:[],pending_approval:null,code:null});
 const stale=await dispatch.status(owner,project.id,agent.id,body.task_id);assert.equal(stale.task.state,'uncertain');assert.equal(stale.task.worker_available,false);
 runner.status=async()=>({...received,state:'completed',session_id:randomUUID(),step_index:1,end_confirmed:true,receipts:[],pending_approval:null,code:null,token:'secret-bearer'});
 const status=await dispatch.status(owner,project.id,agent.id,body.task_id);assert.equal(status.task.state,'completed');assert.equal(JSON.stringify(status).includes('secret-bearer'),false);
 const cancel=await dispatch.cancel(owner,project.id,agent.id,body.task_id);assert.equal(cancel.task.state,'cancelled');
 f.db.prepare("UPDATE ops_broker_tasks SET state='running' WHERE id=?").run(body.task_id);
 const restarted=createBrokerTaskDispatch({db:f.adapter,store:f.store,runner:null});assert.equal((await restarted.status(owner,project.id,agent.id,body.task_id)).task.state,'uncertain');assert.equal(calls,1);
 }finally{f.close();}
});
test('a missing configured worker cannot start or manufacture a persisted task',async()=>{
 const f=operationsFixture();try{brokerTaskMigration1114(f.adapter);const owner=f.addUser(),p=f.store.create(owner,{name:'No worker'}),resource=randomUUID();const {agent}=f.store.createConfiguration(owner,p.id,{workflow_type:'typed_api_v1',work:{name:'Disabled'},controls:{operations:['item.read'],resources:[resource]}});const d=createBrokerTaskDispatch({db:f.adapter,store:f.store,runner:null});await assert.rejects(()=>d.start(owner,p.id,agent.id,{task_id:randomUUID(),grant_id:randomUUID(),connection_id:randomUUID(),attempt:randomUUID(),fence:randomUUID(),configuration_revision:1,scope:{operations:['item.read'],resources:[resource],limits:{max_actions:1,max_seconds:60},expires_at:Date.now()+1000,audience:'fractionate-broker'},steps:[{operation:'item.read',input:{resource_id:resource}}]}),e=>e.code==='BROKER_UNAVAILABLE');assert.equal(d.list(owner,p.id,agent.id).tasks.length,0);}finally{f.close();}
});
test('configured dispatcher reaches real worker over mTLS without persisting its bearer',async()=>{
 const {mkdtempSync,readFileSync,writeFileSync,chmodSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {execFileSync}=await import('node:child_process');const {X509Certificate}=await import('node:crypto');
 const {createRunner}=await import('../../../../services/credential-broker/runner.mjs');const {createRunnerServer}=await import('../../../../services/credential-broker/runner-server.mjs');const {configuredBrokerWorker}=await import('../lib/credential-broker-remote.js');
 const dir=mkdtempSync(join(tmpdir(),'dispatch-worker-')),f=operationsFixture();let worker,server;
 try {
 brokerTaskMigration1114(f.adapter);const owner=f.addUser(),p=f.store.create(owner,{name:'mTLS task'}),resource=randomUUID();const {agent}=f.store.createConfiguration(owner,p.id,{workflow_type:'typed_api_v1',work:{name:'Worker'},controls:{operations:['item.read'],resources:[resource]}});
 const keyPath=join(dir,'key.pem'),certPath=join(dir,'cert.pem');execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=localhost','-addext','subjectAltName=IP:127.0.0.1','-keyout',keyPath,'-out',certPath],{stdio:'ignore'});chmodSync(keyPath,0o600);const key=readFileSync(keyPath),cert=readFileSync(certPath);
 const task_id=randomUUID(),connectionId=randomUUID();let effects=0;worker=createRunner({statePath:join(dir,'worker.db'),broker:{checkTask:async r=>ready(r),issueSession:async r=>{assert.equal(r.task_id,task_id);return {session:{id:randomUUID(),user_id:owner.id,project_id:p.id,agent_id:agent.id,grant_id:r.grant_id,connection_id:connectionId,task_id:r.task_id,attempt:r.attempt,fence:r.fence,expires_at:r.expires_at,revoked:false},bearer:'x'.repeat(43)};},execute:async()=>{effects++;return {id:randomUUID(),state:'succeeded'};},endTask:async()=>({ok:true})}});
 server=createRunnerServer({runner:worker,tls:{key,cert,ca:cert},dashboardFingerprints:[new X509Certificate(cert).fingerprint256.replaceAll(':','')]});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const config=join(dir,'worker.json');writeFileSync(config,JSON.stringify({version:1,origin:`https://127.0.0.1:${server.address().port}`,ca_file:certPath,cert_file:certPath,key_file:keyPath}),{mode:0o600});
 const client=await configuredBrokerWorker({FRACTIONATE_BROKER_WORKER_CONFIG_FILE:config});assert.ok(client);
 const d=createBrokerTaskDispatch({db:f.adapter,store:f.store,runner:client});const r=await d.start(owner,p.id,agent.id,{task_id,grant_id:randomUUID(),connection_id:connectionId,attempt:randomUUID(),fence:randomUUID(),configuration_revision:1,scope:{operations:['item.read'],resources:[resource],limits:{max_actions:1,max_seconds:60},expires_at:Date.now()+50000,audience:'fractionate-broker'},steps:[{operation:'item.read',input:{resource_id:resource}}]});
 assert.equal(r.task.state,'completed');assert.equal(effects,1);assert.equal(JSON.stringify(r).includes('x'.repeat(43)),false);assert.equal(JSON.stringify(f.db.prepare('SELECT * FROM ops_broker_tasks').all()).includes('x'.repeat(43)),false);
 }finally{if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}worker?.close();f.close();rmSync(dir,{recursive:true,force:true});}
});
