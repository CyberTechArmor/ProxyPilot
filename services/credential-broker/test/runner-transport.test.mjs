import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,randomBytes,X509Certificate} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createRunner} from '../runner.mjs';
import {createRunnerServer,createRemoteRunner,createWorkloadBrokerClient} from '../runner-server.mjs';
const U=randomUUID;
function certificates(){const dir=mkdtempSync(join(tmpdir(),'runner-tls-'));const openssl=(...a)=>execFileSync('openssl',a,{cwd:dir,stdio:'ignore'});openssl('req','-x509','-newkey','rsa:2048','-nodes','-days','1','-keyout','ca.key','-out','ca.pem','-subj','/CN=Disposable runner CA');
 writeFileSync(join(dir,'leaf.ext'),'basicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth,clientAuth\nsubjectAltName=IP:127.0.0.1,DNS:localhost\n');
 const leaf=name=>{openssl('req','-new','-newkey','rsa:2048','-nodes','-keyout',name+'.key','-out',name+'.csr','-subj','/CN='+name);openssl('x509','-req','-in',name+'.csr','-CA','ca.pem','-CAkey','ca.key','-CAcreateserial','-days','1','-extfile','leaf.ext','-out',name+'.pem');const cert=readFileSync(join(dir,name+'.pem'));return{key:readFileSync(join(dir,name+'.key')),cert,fingerprint:new X509Certificate(cert).fingerprint256.replaceAll(':','')};};
 return{dir,ca:readFileSync(join(dir,'ca.pem')),server:leaf('server'),allowed:leaf('dashboard'),other:leaf('other')};}
const listen=async server=>{await new Promise(r=>server.listen(0,'127.0.0.1',r));return 'https://127.0.0.1:'+server.address().port;};
const close=server=>new Promise(r=>server.close(r));
const raw=(origin,tls,options={})=>new Promise((resolve,reject)=>{const req=https.request(origin+(options.path||'/v1/tasks'),{...tls,method:options.method||'POST',headers:options.headers||{'Content-Type':'application/json'}},res=>{let body='';res.on('data',x=>body+=x);res.on('end',()=>resolve({status:res.statusCode,body}));});req.on('error',reject);req.end(options.body||'{}');});
function task(){const resource=U();return{id:U(),user_id:U(),project_id:U(),agent_id:U(),grant_id:U(),connection_id:U(),attempt:U(),fence:U(),configuration_revision:1,scope:{operations:['item.read'],resources:[resource],limits:{max_actions:1,max_seconds:60},expires_at:Date.now()+59000,audience:'fractionate-broker'},steps:[{operation:'item.read',input:{resource_id:resource}}]};}

test('actual mTLS worker requires exact approved certificate; bounds inputs and exposes no bearer',async()=>{
 const f=certificates(),secret=randomBytes(32).toString('base64url');let sends=0,authorized;
 const runner=createRunner({statePath:join(f.dir,'worker.db'),broker:{checkTask:async r=>{authorized=r;return{ready:true,task_id:r.id,user_id:r.user_id,project_id:r.project_id,agent_id:r.agent_id,configuration_revision:r.configuration_revision,attempt:r.attempt,fence:r.fence,expires_at:Date.now()+50000};},issueSession:async()=>({session:{id:U(),user_id:authorized.user_id,project_id:authorized.project_id,agent_id:authorized.agent_id,grant_id:authorized.grant_id,connection_id:authorized.connection_id,task_id:authorized.id,attempt:authorized.attempt,fence:authorized.fence,expires_at:authorized.scope.expires_at,revoked:false},bearer:secret}),execute:async()=>{sends++;return{id:U(),state:'succeeded',raw_secret:secret};},endTask:async()=>({ended:true})}});
 const server=createRunnerServer({runner,tls:{...f.server,ca:f.ca},dashboardFingerprints:[f.allowed.fingerprint]});const origin=await listen(server),allowed={ca:f.ca,...f.allowed},remote=createRemoteRunner({origin,...allowed});
 try{
 await assert.rejects(raw(origin,{ca:f.ca}));
 const denied=await raw(origin,{ca:f.ca,...f.other});assert.equal(denied.status,403);assert.equal(sends,0);
 const r=task();assert.equal((await remote.checkTask(r)).ready,true);assert.equal(sends,0);const result=await remote.startTask(r);assert.equal(result.state,'completed');assert.equal(sends,1);assert.ok(!JSON.stringify(result).includes(secret));assert.ok(!readFileSync(join(f.dir,'worker.db')).includes(Buffer.from(secret)));
 assert.equal((await remote.status(r.id)).state,'completed');await assert.rejects(remote.startTask(r));assert.equal(sends,1);
 assert.equal((await raw(origin,allowed,{headers:['Content-Type','application/json','Content-Type','application/json'],body:JSON.stringify(task())})).status,400);
 await assert.rejects(remote.startTask({padding:'x'.repeat(66000)}),/REQUEST_TOO_LARGE/);assert.equal(sends,1);
 const bad=await raw(origin,allowed,{body:'{"id":"first","id":"second"}'});assert.equal(bad.status,400);assert.ok(!bad.body.includes(secret));
 // Slow trickling bytes must hit the total body deadline despite continued activity.
 const started=Date.now();await new Promise((resolve,reject)=>{const req=https.request(origin+'/v1/tasks',{...allowed,method:'POST',headers:{'Content-Type':'application/json'}},res=>{res.resume();res.on('end',resolve);});const drip=setInterval(()=>req.write(' '),100),guard=setTimeout(()=>{req.destroy();reject(Error('absolute body deadline missing'));},14000);req.on('error',()=>{clearInterval(drip);clearTimeout(guard);resolve();});req.on('close',()=>{clearInterval(drip);clearTimeout(guard);});req.flushHeaders();});assert.ok(Date.now()-started>=9500&&Date.now()-started<11500);assert.equal(sends,1);
 for(const value of ['http://127.0.0.1','https://user:password@127.0.0.1','https://127.0.0.1/path','https://127.0.0.1?target=evil'])assert.throws(()=>createRemoteRunner({origin:value,...allowed}),/INVALID_CONFIGURATION/);
 }finally{await close(server);runner.close();rmSync(f.dir,{recursive:true,force:true});}
});

test('mTLS transport rejects redirects, oversized responses, wrong versions and false task-end acknowledgements',async()=>{
 const f=certificates();let mode='version',calls=0,redirectHits=0;const observed=[];
 const target=https.createServer({...f.server,ca:f.ca,requestCert:true,rejectUnauthorized:true},(req,res)=>{redirectHits++;res.end();});const otherOrigin=await listen(target);
 const server=https.createServer({...f.server,ca:f.ca,requestCert:true,rejectUnauthorized:true},async(req,res)=>{calls++;let body='';for await(const chunk of req)body+=chunk;observed.push({url:req.url,bearer:req.headers.authorization,idempotency:req.headers['idempotency-key'],body});res.setHeader('Content-Type','application/json');
 if(mode==='wrong-type'){res.setHeader('Content-Type','application/jsonp');res.end('{}');return;}
 if(mode==='redirect'){res.writeHead(302,{Location:otherOrigin});res.end('{}');return;}
 if(mode==='large'){res.end(JSON.stringify({padding:'x'.repeat(70000)}));return;}
 if(mode==='delay'){setTimeout(()=>res.end('{}'),250).unref();return;}
 if(mode==='task-injection'){res.end(JSON.stringify({contract_version:'runner.v1',task:{bearer:'not-allowed'}}));return;}
 if(mode==='worker'){res.end(JSON.stringify({contract_version:'runner.v2',task:{}}));return;}
 if(mode==='good'){res.end(JSON.stringify(req.url==='/v1/workloads/ready'?{contract_version:'broker.v1',ready:true}:req.url==='/v1/workloads/session'?{contract_version:'broker.v1',bearer:'b'.repeat(43),session:{id:U()}}:req.url==='/v1/operations'?{contract_version:'broker.v1',operation:{id:U(),state:'succeeded'}}:{contract_version:'broker.v1',ended:true}));return;}
 res.end(JSON.stringify({contract_version:'broker.v0',ended:true}));});const origin=await listen(server),config={origin,agentOrigin:origin,ca:f.ca,...f.allowed,timeoutMs:2000};const client=createWorkloadBrokerClient(config);
 try{
 await assert.rejects(client.issueSession({}),/BROKER_INCOMPATIBLE/);await assert.rejects(client.endTask({task_id:U()}),/BROKER_INCOMPATIBLE/);
 mode='worker';await assert.rejects(createRemoteRunner(config).status(U()),/WORKER_INCOMPATIBLE/);
 mode='task-injection';await assert.rejects(createRemoteRunner(config).status(U()));
 mode='redirect';await assert.rejects(client.issueSession({}),/REMOTE_UNAVAILABLE/);assert.equal(redirectHits,0);
 mode='wrong-type';await assert.rejects(client.issueSession({}),/REMOTE_UNAVAILABLE/);
 mode='large';await assert.rejects(client.issueSession({}),/REMOTE_UNAVAILABLE/);
 mode='delay';await assert.rejects(createWorkloadBrokerClient({...config,timeoutMs:100}).issueSession({}),/REMOTE_UNAVAILABLE/);
 mode='good';const fixedClient=createWorkloadBrokerClient({...config,origin:otherOrigin});assert.equal((await fixedClient.ready()).ready,true);await fixedClient.issueSession({});await fixedClient.endTask({task_id:U()});assert.equal(redirectHits,0);const issued=await client.issueSession({grant_id:U()});const key=U();const receipt=await client.execute(issued.bearer,U(),'item.read',{resource_id:U()},key);assert.equal(receipt.state,'succeeded');assert.ok(!JSON.stringify(receipt).includes(issued.bearer));const end=await client.endTask({task_id:U(),attempt:U(),fence:U()});assert.equal(end.ended,true);
 assert.ok(observed.filter(x=>x.url!=='/v1/operations').every(x=>!x.bearer));const op=observed.find(x=>x.url==='/v1/operations');assert.equal(op.bearer,'Bearer '+issued.bearer);assert.equal(op.idempotency,key);assert.ok(!op.body.includes(issued.bearer));assert.ok(calls>0);
 }finally{await close(server);await close(target);rmSync(f.dir,{recursive:true,force:true});}
});
