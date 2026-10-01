/** Full configured vertical proof: real OIDC signatures, mTLS, independent signed
 * authority, real OpenBao AppRoles/KV and HTTPS typed upstream. No injected authority,
 * vault, identity or transport. Requires disposable Docker/OpenSSL infrastructure. */
import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import net from 'node:net';
import {mkdtempSync,writeFileSync,readFileSync,readdirSync,rmSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {randomUUID,generateKeyPairSync,createHash,X509Certificate} from 'node:crypto';
import {startOidcFixture} from '../fixtures/oidc.mjs';
import {createDisposableFixture,IMAGE} from '../fixtures/disposable.mjs';
import {createConfiguredService} from '../configured-service.mjs';
import {signAuthoritySnapshot} from '../authority-publisher.mjs';
import {createRunner} from '../runner.mjs';
import {createWorkloadBrokerClient} from '../runner-server.mjs';

const req=(url,ca,{client,method='GET',headers={},data}={})=>new Promise((resolve,reject)=>{
 const r=https.request(url,{ca,...client,method,headers:{...(data?{'Content-Type':'application/json'}:{}),...headers}},s=>{let text='';s.on('data',b=>text+=b);s.on('end',()=>resolve({status:s.statusCode,headers:s.headers,text,json:()=>JSON.parse(text)}));});r.setTimeout(10000,()=>r.destroy(Error('fixture request timeout')));r.on('error',reject);r.end(data?JSON.stringify(data):undefined);
});
const cookie=(r,name)=>r.headers['set-cookie'].find(x=>x.startsWith(name+'=')).split(';')[0];
const port=async()=>{const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;};
const ok=(response)=>{assert.equal(response.status,200,response.text);return response.json();};

test('configured OIDC/intake/mTLS worker through real OpenBao and typed TLS ledger; approval, feed expiry, cancel and revoke', {timeout:120000},async t=>{
 const dir=mkdtempSync(join(tmpdir(),'configured-openbao-'));let idp,f,service,runner;
 try{
  idp=await startOidcFixture();f=await createDisposableFixture();
  const keys=generateKeyPairSync('ed25519'),privateKey=keys.privateKey.export({type:'pkcs8',format:'pem'}),clients={},pins=[],workload=randomUUID();
  const file=(name,value)=>{const p=join(dir,name);writeFileSync(p,value,{mode:0o600});return p;};
  for(const role of ['dashboard','publisher','worker']){
   const key=join(dir,role+'.key'),cert=join(dir,role+'.cert');execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN='+role],{stdio:'ignore'});
   clients[role]={key:readFileSync(key),cert:readFileSync(cert)};pins.push({fingerprint:createHash('sha256').update(new X509Certificate(clients[role].cert).raw).digest('hex'),role,id:role==='publisher'?'fixture-source':role==='worker'?workload:randomUUID()});
  }
  const tls={key_file:file('server.key',idp.key),cert_file:file('server.cert',idp.cert),ca_file:file('clients.ca',Buffer.concat(Object.values(clients).map(c=>c.cert)))};
  const listeners={};for(const role of ['human','management','agent']){const p=await port();listeners[role]={origin:'https://127.0.0.1:'+p,host:'127.0.0.1',port:p,tls};}
  const enrollerRole=await f.baoTransport('GET','/v1/auth/approle/role/broker-enroll/role-id',{headers:{'X-Vault-Token':f.root}}),enrollerSecret=await f.provision('/v1/auth/approle/role/broker-enroll/secret-id',{});
  const stateDir=join(dir,'service');mkdirSync(stateDir,{mode:0o700});
  const config={schema_version:1,mode:'configured',state_dir:stateDir,listeners,clients:pins,
   identity:{issuer:idp.issuer,authorization_endpoint:idp.issuer+'/authorize',token_endpoint:idp.issuer+'/token',jwks_endpoint:idp.issuer+'/jwks',client_id:'fixture-client',broker_origin:listeners.human.origin,dashboard_origin:'https://dashboard.example',subject_map:[{issuer:idp.issuer,subject:'fixture-user',user_id:f.owner}],required_acr:'fixture:mfa',max_age_seconds:300,ca_file:idp.ca_file},
   authority:{sources:[{id:'fixture-source',public_key:keys.publicKey.export({format:'pem',type:'spki'}),kinds:['users','projects','agents','tasks','ceilings','policies']}]},
   vault:{origin:`https://bao.fixture.test:${f.baoPort}`,approved_address:'127.0.0.1',ca_file:file('fixture.ca',f.cert),mount:'fractionate-broker-kv',reader:{role_id_file:file('reader.role',f.readerCredentials.roleId),secret_id_file:file('reader.secret',f.readerCredentials.secretId)},enroller:{role_id_file:file('enroller.role',enrollerRole.data.role_id),secret_id_file:file('enroller.secret',enrollerSecret.data.secret_id)},slots:f.credentialIds.map(credential_id=>({owner_id:f.owner,credential_id}))},
   upstream:{origin:`https://ledger.fixture.test:${f.ledgerPort}`,approved_address:'127.0.0.1',ca_file:join(dir,'fixture.ca')},
  };
  service=await createConfiguredService({config});await service.start();
  const management=listeners.management.origin,human=listeners.human.origin,agent=listeners.agent.origin;
  const remote=(path,options={})=>req(management+path,idp.cert,{client:clients.dashboard,...options});
  assert.equal(ok(await remote('/v1/capabilities')).execution_enabled,false);
  const scope={operations:['item.read','item.set_state'],resources:[f.resource],limits:{max_actions:8,max_seconds:60}},ceil={id:randomUUID(),revision:1,user_id:f.owner,project_id:f.project,actions:['list','get','activity','assignments','sessions','enroll','test','update','revoke','rotate','assign','unassign','approve','setPermission','reconcileOperation','revalidatePolicy'],connection_ids:[],adapter_ids:['synthetic-ledger-v1'],...structuredClone(scope),expires_at:Date.now()+3600000,revoked:false,grant_rights:['view','use','assign','manage'],manage_actions:['test','rename','rotate','revoke']};
  const records={users:[{id:f.owner,revision:1,disabled:false}],projects:[{id:f.project,revision:1,archived:false,user_ids:[f.owner]}],agents:[{id:f.agent,revision:1,project_id:f.project,user_id:f.owner,disabled:false,workload_id:workload}],tasks:[],ceilings:[ceil],policies:[]};
  let sequence=0;const publish=async(lease=55000)=>{const challenge=ok(await remote('/v1/authority/challenge',{client:clients.publisher})).challenge,issued_at=Date.now();return ok(await remote('/v1/authority/snapshot',{client:clients.publisher,method:'POST',data:signAuthoritySnapshot(privateKey,{version:'authority.v1',source_id:'fixture-source',sequence:++sequence,challenge,issued_at,expires_at:issued_at+lease,records})}));};
  await publish();
  // Credential intake is gated on a real registered-worker heartbeat too.
  assert.equal(ok(await remote('/v1/capabilities')).intake_enabled,false);
  const workloadClient=createWorkloadBrokerClient({agentOrigin:agent,ca:idp.cert,...clients.worker});await workloadClient.ready();
  assert.equal(ok(await remote('/v1/capabilities')).intake_enabled,true);
  const start=await req(human+'/auth/login',idp.cert),authorized=await req(start.headers.location,idp.cert),done=await req(authorized.headers.location,idp.cert,{headers:{Cookie:cookie(start,'__Host-fractionate-login')}});assert.equal(done.status,303);
  const humanCookie=cookie(done,'__Host-fractionate-human'),identity=ok(await req(human+'/auth/session',idp.cert,{headers:{Cookie:humanCookie}}));
  const humanHeaders={Cookie:humanCookie,Origin:human,'X-CSRF-Token':identity.csrf_token};
  const delegation=ok(await req(human+'/auth/delegations',idp.cert,{method:'POST',headers:humanHeaders,data:{actions:['list','get','activity','assignments','sessions','enroll','test','revoke','rotate','assign','unassign','intent']}}));
  const call=async(action,id,body,expected)=>ok(await remote('/v1/dashboard',{method:'POST',headers:{Authorization:'Bearer '+delegation.bearer},data:{action,actor:{id:f.owner},...(id?{id}:{}),...(body?{body}:{}),...(expected?{expected}:{})}}));
  const metadata={name:'Configured disposable ledger',project_id:f.project,adapter_id:'synthetic-ledger-v1',...scope};
  const intent=(await call('enroll',null,metadata)).intent;
  const submitted=ok(await req(human+'/v1/intake/intents/'+intent.id+'/submit',idp.cert,{method:'POST',headers:humanHeaders,data:{credential:f.credential}}));assert.equal(submitted.state,'committed');
  const connectionId=submitted.connection_id;assert.ok(connectionId);ceil.connection_ids=[connectionId];ceil.revision++;
  records.policies=[{id:connectionId,revision:1,policy_revision:1,credential_version:1,owner_id:f.owner,project_id:f.project,adapter_id:metadata.adapter_id,status:'saved',...structuredClone(scope)}];await publish();
  let connection=(await call('get',connectionId)).connection;assert.equal(connection.credential_version,1);
  connection=(await call('test',connectionId,null,connection.revision)).connection;assert.equal(connection.status,'active');records.policies[0].revision++;records.policies[0].status='active';await publish();
  const assignment=(await call('assign',connectionId,{user_id:f.owner,project_id:f.project,agent_id:f.agent,...scope,expires_at:Date.now()+600000},connection.revision)).assignment;
  await workloadClient.ready();assert.equal(ok(await remote('/v1/capabilities')).execution_enabled,true);
  const makeTask=()=>{const task={id:randomUUID(),revision:1,project_id:f.project,user_id:f.owner,agent_id:f.agent,attempt:randomUUID(),fence:randomUUID(),status:'running',expires_at:Date.now()+600000,grant_ids:[assignment.id],connection_ids:[connectionId],...structuredClone(scope),configuration_revision:1,readiness:{guide_revision:1,checks_revision:1,environment_revision:1,execution_approved:true}};records.tasks.push(task);return task;};
  const fullRequest=(task,steps)=>({id:task.id,user_id:f.owner,project_id:f.project,agent_id:f.agent,grant_id:assignment.id,connection_id:connectionId,attempt:task.attempt,fence:task.fence,configuration_revision:1,scope:{...structuredClone(scope),expires_at:Date.now()+50000,audience:'fractionate-broker'},steps});
  const read={operation:'item.read',input:{resource_id:f.resource}},write={operation:'item.set_state',input:{resource_id:f.resource,state:'closed'}};
  const first=makeTask();await publish();runner=createRunner({statePath:join(dir,'runner','state.db'),broker:workloadClient});
  const waiting=await runner.startTask(fullRequest(first,[read,write]));assert.equal(waiting.state,'awaiting_approval');assert.equal(waiting.receipts.length,1);assert.equal(f.effects,0);
  const preview=ok(await req(human+'/v1/human/approval-preview',idp.cert,{method:'POST',headers:humanHeaders,data:waiting.pending_approval})).preview;
  const approved=ok(await req(human+'/v1/human/approve',idp.cert,{method:'POST',headers:humanHeaders,data:{...waiting.pending_approval,digest:preview.digest}})).approval;
  const completed=await runner.continueTask(first.id,{approval_id:approved.id});assert.equal(completed.state,'completed');assert.equal(completed.end_confirmed,true);assert.equal(f.effects,1);assert.equal(completed.receipts.length,2);
  await assert.rejects(runner.continueTask(first.id,{approval_id:approved.id}));
  // Second signed task: explicit cancellation while awaiting approval sends no write.
  const second=makeTask();await publish();const beforeCancel=f.requests,cancelWait=await runner.startTask(fullRequest(second,[write]));assert.equal(cancelWait.state,'awaiting_approval');const cancelled=await runner.cancelTask(second.id);assert.equal(cancelled.state,'cancelled');assert.equal(cancelled.end_confirmed,true);assert.equal(f.requests,beforeCancel);
  // Third task: real worker session becomes unusable while signed feed lease is expired.
  const third=makeTask();await publish();const issue={grant_id:assignment.id,task_id:third.id,attempt:third.attempt,fence:third.fence,configuration_revision:1,...scope,expires_at:Date.now()+50000,audience:'fractionate-broker'},session=await workloadClient.issueSession(issue);
  await publish(150);await new Promise(r=>setTimeout(r,180));const beforeOutage=f.requests;await assert.rejects(workloadClient.execute(session.bearer,connectionId,read.operation,read.input,randomUUID()));assert.equal(f.requests,beforeOutage);assert.equal(ok(await remote('/v1/capabilities')).execution_enabled,false);
  await publish();assert.equal((await workloadClient.execute(session.bearer,connectionId,read.operation,read.input,randomUUID())).state,'succeeded');
  connection=(await call('get',connectionId)).connection;await call('revoke',connectionId,null,connection.revision);const beforeRevoke=f.requests;await assert.rejects(workloadClient.execute(session.bearer,connectionId,read.operation,read.input,randomUUID()));assert.equal(f.requests,beforeRevoke);
  const outputs=JSON.stringify([waiting,completed,cancelled,await call('activity',connectionId),await call('sessions',connectionId)]);assert.ok(!outputs.includes(f.credential));assert.ok(!outputs.includes(session.bearer));
  for(const name of readdirSync(stateDir)){if(name.endsWith('.lock'))continue;const bytes=readFileSync(join(stateDir,name));assert.ok(!bytes.includes(Buffer.from(f.credential)),name+' excludes upstream credential');assert.ok(!bytes.includes(Buffer.from(session.bearer)),name+' excludes broker bearer');}
  t.diagnostic('Real configured proof used '+IMAGE+'; no injected identity, authority, vault or upstream. OIDC + mTLS + AppRole/KV + runner read/write and revoke/cancel/feed-expiry assertions passed.');
 }finally{runner?.close();await service?.close();await f?.close();await idp?.close();rmSync(dir,{recursive:true,force:true});}
});
