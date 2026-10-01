/** Full configured vertical proof: real OIDC signatures, mTLS, independent signed
 * authority, real OpenBao AppRoles/KV and HTTPS typed upstream. No injected authority,
 * vault, identity or transport. Requires disposable Docker/OpenSSL infrastructure. */
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
import {startLocalAuthoritySource} from '../local-authority-source-main.mjs';
import {operationsFixture} from '../../../admin/backend/src/__tests__/helpers/operations-fixture.js';
import {createAuthoritySourceClient} from '../../../admin/backend/src/lib/broker-authority-source-client.js';
import {createRemoteRunner} from '../../../admin/backend/src/lib/credential-broker-runner-client.js';
import {brokerTaskMigration1114,createBrokerTaskDispatch} from '../../../admin/backend/src/lib/broker-task-dispatch.js';
import {brokerTaskProposalsMigration1115,createBrokerTaskProposals} from '../../../admin/backend/src/lib/broker-task-proposals.js';
import {createRunner} from '../runner.mjs';
import {createWorkloadBrokerClient,createRunnerServer} from '../runner-server.mjs';

const req=(url,ca,{client,method='GET',headers={},data}={})=>new Promise((resolve,reject)=>{
 const r=https.request(url,{ca,...client,method,headers:{...(data?{'Content-Type':'application/json'}:{}),...headers}},s=>{let text='';s.on('data',b=>text+=b);s.on('end',()=>resolve({status:s.statusCode,headers:s.headers,text,json:()=>JSON.parse(text)}));});r.setTimeout(10000,()=>r.destroy(Error('fixture request timeout')));r.on('error',reject);r.end(data?JSON.stringify(data):undefined);
});
const cookie=(r,name)=>r.headers['set-cookie'].find(x=>x.startsWith(name+'=')).split(';')[0];
const port=async()=>{const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;};
const ok=(response)=>{assert.equal(response.status,200,response.text);return response.json();};

export async function withSavedAgentFixture(t,onReady=null){
 const dir=mkdtempSync(join(tmpdir(),'configured-openbao-'));let idp,f,service,runner,source,ops,workerServer,heartbeat;
 try{
  f=await createDisposableFixture();const subject=randomUUID(),users=new Map([[subject,true]]),serviceSecret=randomUUID();idp=await startOidcFixture({realm:'disposable',users,serviceSecret});idp.setClaims({sub:subject});
  const proxyPath=join(dir,'proxy.db');ops=operationsFixture({path:proxyPath});brokerTaskMigration1114(ops.adapter);brokerTaskProposalsMigration1115(ops.adapter);
  const owner={id:f.owner,role:'user'};ops.db.prepare('INSERT INTO users(id,username,role) VALUES(?,?,?)').run(owner.id,'owner','user');const reviewer=ops.addUser();
  const project=ops.store.create(owner,{name:'Disposable saved-agent project'});f.project=project.id;ops.store.grant(owner,project.id,reviewer.id,project.revision,{role:'reviewer'});
  ops.store.saveDraft(owner,project.id,1,{title:'Bounded ledger',instructions:'Read or set only the assigned synthetic ledger item.'});const submission=ops.store.submit(owner,project.id,ops.store.draft(owner,project.id).revision,{}).submission;
  const guide=ops.store.review(reviewer,project.id,submission.id,submission.revision,{decision:'approve'}).version,environment=randomUUID(),output=randomUUID();
  const {agent:saved}=ops.store.createConfiguration(owner,project.id,{workflow_type:'typed_api_v1',work:{name:'Saved API agent',guide_ref:{id:guide.id,hash:guide.content_hash},environment_ref:environment},controls:{operations:['item.read','item.set_state'],resources:[f.resource],max_seconds:60,max_actions:2,output_ref:output}});f.agent=saved.id;assert.equal(saved.execution_enabled,false);assert.equal(f.effects,0);

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
   identity:{issuer:idp.issuer,authorization_endpoint:idp.issuer+'/authorize',token_endpoint:idp.issuer+'/token',jwks_endpoint:idp.issuer+'/jwks',client_id:'fixture-client',broker_origin:listeners.human.origin,dashboard_origin:'https://dashboard.example',subject_map:[{issuer:idp.issuer,subject,user_id:f.owner}],required_acr:'fixture:mfa',max_age_seconds:300,ca_file:idp.ca_file},
   authority:{sources:[{id:'fixture-source',public_key:keys.publicKey.export({format:'pem',type:'spki'}),kinds:['users','projects','agents','tasks','ceilings','policies']}]},
   vault:{origin:`https://bao.fixture.test:${f.baoPort}`,approved_address:'127.0.0.1',ca_file:file('fixture.ca',f.cert),mount:'fractionate-broker-kv',reader:{role_id_file:file('reader.role',f.readerCredentials.roleId),secret_id_file:file('reader.secret',f.readerCredentials.secretId)},enroller:{role_id_file:file('enroller.role',enrollerRole.data.role_id),secret_id_file:file('enroller.secret',enrollerSecret.data.secret_id)},slots:f.credentialIds.map(credential_id=>({owner_id:f.owner,credential_id}))},
   upstream:{origin:`https://ledger.fixture.test:${f.ledgerPort}`,approved_address:'127.0.0.1',ca_file:join(dir,'fixture.ca')},
  };
  service=await createConfiguredService({config});await service.start();
  const management=listeners.management.origin,human=listeners.human.origin,agent=listeners.agent.origin;
  const remote=(path,options={})=>req(management+path,idp.cert,{client:clients.dashboard,...options});
  const scope={operations:['item.read','item.set_state'],resources:[f.resource],limits:{max_actions:2,max_seconds:60}};
  const policy={trust_mode:'local_backend_authority',subject_map:[{user_id:owner.id,issuer:idp.issuer,subject}],registrations:[{agent_id:saved.id,user_id:owner.id,project_id:project.id,workload_id:workload,environment:{id:environment,name:'Disposable worker',revision:1},output:{id:output,name:'Project activity',revision:1,kind:'project_activity'},configuration_revision:1,guide_id:guide.id,guide_hash:guide.content_hash,checks_revision:1,expires_at:Date.now()+3600000,enabled:true}],ceilings:[{id:randomUUID(),user_id:owner.id,project_id:project.id,actions:['list','get','activity','assignments','sessions','enroll','test','rotate','assign','unassign','approve','revoke'],connection_ids:[],owned_connections:true,task_use:true,adapter_ids:['synthetic-ledger-v1'],...scope,expires_at:Date.now()+3600000,enabled:true,grant_rights:['view','use','assign','manage'],manage_actions:['test','rename','rotate','revoke']}]};
  const policyFile=file('source-policy.json',JSON.stringify(policy)),socket=join(dir,'source.sock');
  source=await startLocalAuthoritySource({trust_mode:'local_backend_authority',proxypilot_db:proxyPath,broker_db:join(stateDir,'broker.db'),state_path:join(dir,'source.db'),socket_path:socket,policy_file:policyFile,keycloak:{issuer:idp.issuer,client_id:'source-fixture',client_secret_file:file('source.secret',serviceSecret),ca_file:idp.ca_file},publisher:{origin:management,ca_file:idp.ca_file,cert_file:file('publisher.cert',clients.publisher.cert),key_file:file('publisher.key',clients.publisher.key),source_id:'fixture-source',signing_key_file:file('signing.key',privateKey)},poll_ms:1000,lease_ms:5000});
  assert.equal(source.health().ready,true);assert.equal(source.health().trust_mode,'local_backend_authority');
  const sourceClient=createAuthoritySourceClient({socketPath:socket});const catalogue=await sourceClient.registrations({user_id:owner.id,project_id:project.id});assert.equal(catalogue.environments[0].id,environment);assert.equal(catalogue.outputs[0].id,output);
  const workloadClient=createWorkloadBrokerClient({agentOrigin:agent,ca:idp.cert,...clients.worker});await workloadClient.ready();heartbeat=setInterval(()=>workloadClient.ready().catch(()=>{}),10000);heartbeat.unref();
  runner=createRunner({statePath:join(dir,'runner','state.db'),broker:workloadClient});workerServer=createRunnerServer({runner,tls:{key:idp.key,cert:idp.cert,ca:clients.dashboard.cert},dashboardFingerprints:[pins.find(p=>p.role==='dashboard').fingerprint]});await new Promise(r=>workerServer.listen(0,'127.0.0.1',r));
  const workerRemote=createRemoteRunner({origin:'https://127.0.0.1:'+workerServer.address().port,ca:idp.cert,...clients.dashboard});
  const dispatch=createBrokerTaskDispatch({db:ops.adapter,store:ops.store,runner:workerRemote,authoritySource:sourceClient}),proposals=createBrokerTaskProposals({db:ops.adapter,store:ops.store,dispatch});
  const start=await req(human+'/auth/login',idp.cert),authorized=await req(start.headers.location,idp.cert),done=await req(authorized.headers.location,idp.cert,{headers:{Cookie:cookie(start,'__Host-fractionate-login')}});assert.equal(done.status,303);
  const humanCookie=cookie(done,'__Host-fractionate-human'),identity=ok(await req(human+'/auth/session',idp.cert,{headers:{Cookie:humanCookie}}));
  const humanHeaders={Cookie:humanCookie,Origin:human,'X-CSRF-Token':identity.csrf_token};
  const delegation=ok(await req(human+'/auth/delegations',idp.cert,{method:'POST',headers:humanHeaders,data:{actions:['list','get','activity','assignments','sessions','enroll','test','assign','revoke','intent']}}));
  const call=async(action,id,body,expected,query)=>ok(await remote('/v1/dashboard',{method:'POST',headers:{Authorization:'Bearer '+delegation.bearer},data:{action,actor:{id:owner.id},...(id?{id}:{}),...(body?{body}:{}),...(expected?{expected}:{}),...(query?{query}:{})}}));
  const intent=(await call('enroll',null,{name:'Saved agent ledger',project_id:project.id,adapter_id:'synthetic-ledger-v1',...scope})).intent;
  const enrolled=ok(await req(human+'/v1/intake/intents/'+intent.id+'/submit',idp.cert,{method:'POST',headers:humanHeaders,data:{credential:f.credential}}));assert.equal(enrolled.state,'committed');
  const connectionId=enrolled.connection_id;
  // Wait only for current metadata publication, never retry a write or intake.
  const eventually=async(fn)=>{const until=Date.now()+10000;let error;while(Date.now()<until){try{return await fn();}catch(e){error=e;await new Promise(r=>setTimeout(r,50));}}throw error;};
  let connection=await eventually(async()=> (await call('get',connectionId)).connection);
  connection=(await call('test',connectionId,null,connection.revision)).connection;
  await eventually(async()=>{const c=(await call('get',connectionId)).connection;assert.equal(c.status,'active');assert.equal(source.health().ready,true);return c;});
  // Source refresh must see the active policy before assignment authorization.
  await new Promise(r=>setTimeout(r,1100));
  const assignment=(await call('assign',connectionId,{user_id:owner.id,project_id:project.id,agent_id:saved.id,...scope,expires_at:Date.now()+600000},connection.revision)).assignment;
  if(onReady){await onReady({ops,owner,project,saved,assignment,connectionId,resource:f.resource,dispatch,proposals,sourceClient,call,human,humanHeaders,idp,req,ok,getEffects:()=>f.effects});return;}
  const input={configuration_revision:1,connection_id:connectionId,grant_id:assignment.id,operation:'item.set_state',resource_id:f.resource,state:'closed'};
  const prepared=await proposals.prepare(owner,project.id,saved.id,input);assert.equal(prepared.readiness.ready,true);assert.equal(f.effects,0);assert.equal(dispatch.list(owner,project.id,saved.id).tasks.length,0);
  const task=(await proposals.start(owner,project.id,saved.id,prepared.proposal.id)).task;assert.equal(task.state,'awaiting_approval');assert.equal(f.effects,0);
  const pending=task.receipt.pending_approval,preview=ok(await req(human+'/v1/human/approval-preview',idp.cert,{method:'POST',headers:humanHeaders,data:pending})).preview;
  const approved=ok(await req(human+'/v1/human/approve',idp.cert,{method:'POST',headers:humanHeaders,data:{...pending,digest:preview.digest}})).approval;
  const finished=(await dispatch.approve(owner,project.id,saved.id,task.id,{approval_id:approved.id})).task;assert.equal(finished.state,'completed');assert.equal(finished.receipt.end_confirmed,true);assert.equal(f.effects,1);
  await assert.rejects(proposals.start(owner,project.id,saved.id,prepared.proposal.id));assert.equal(f.effects,1);
  const stale=await proposals.prepare(owner,project.id,saved.id,{...input,operation:'item.read',state:undefined});
  users.set(subject,false);const before=f.requests;await assert.rejects(proposals.start(owner,project.id,saved.id,stale.proposal.id));assert.equal(f.requests,before);
  users.set(subject,true);ops.store.updateConfiguration(owner,project.id,saved.id,1,{controls:{...saved.controls,resources:[]}});await assert.rejects(proposals.prepare(owner,project.id,saved.id,input));assert.equal(f.effects,1);
  for(const path of [proxyPath,join(stateDir,'broker.db'),join(dir,'source.db'),join(dir,'runner','state.db')])assert.equal(readFileSync(path).includes(Buffer.from(f.credential)),false);
  assert.equal(JSON.stringify([prepared,task,finished,catalogue]).includes(f.credential),false);
  t.diagnostic('Actual file-backed Operations project/approved guide/saved agent, Unix source daemon, Keycloak-shaped HTTPS fixture, signed mTLS publication, worker HTTPS and real OpenBao '+IMAGE+'. Local backend is explicitly trusted; no production Keycloak compatibility claim.');
 }finally{clearInterval(heartbeat);if(workerServer){workerServer.closeAllConnections();await new Promise(r=>workerServer.close(r));}runner?.close();await source?.close();ops?.close();await service?.close();await f?.close();await idp?.close();rmSync(dir,{recursive:true,force:true});}
}
