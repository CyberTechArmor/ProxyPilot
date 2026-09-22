import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn,fork } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import { makeDb,apiFixture,configInput,identityInput,ids,vm,dockerFixture,infisicalApiFixture } from './helpers/infisical-fixture.js';
import { saveInfisical,saveInfisicalIdentities,readInfisical,reviewInfisical,applyInfisical,infisicalSecrets,infisicalState } from '../lib/setup-engine/infisical-store.js';
import { prepareInfisicalFiles,ensureInfisicalRuntime,ensureAgentProxyRuntime,assertIsolatedAgentVm,assertLocalTestHost,namesFor } from '../lib/setup-engine/infisical-runtime.js';
import { verifyPolicies,infisicalRequest,createInfisicalClient,verifyInfisicalIdentities } from '../lib/setup-engine/infisical-api.js';
import { verifyCredentialFlows,testDestination,testAgentScript,testConsumerScript } from '../lib/setup-engine/infisical-flows.js';
import { configureInfisicalRoute } from '../lib/setup-engine/infisical-routes.js';
import { expectedPolicies,INFISICAL_APP,TEST_KEY,PROXY_KEY,PLACEHOLDER } from '../lib/setup-engine/infisical-logic.js';
import { getJob,acquireLock,releaseLock,claimNextJob } from '../lib/setup-engine/store.js';
import { runOnce,reconcile,executeJob } from '../lib/setup-engine/executor.js';
import { runBackendSteps } from '../lib/setup-engine/backend-steps.js';
import { backendStepDeps } from '../mock2/ops.js';
import { choicesSchema,emptyChoices } from '../lib/setup-engine/platform-plan.js';
import { validateRunnerJob,FencedError } from '../lib/setup-engine/logic.js';
const {buildDomainCaddyConfig}=await import('../routes/services.js');
const handle={id:'fixture',fence(){},checkpoint(){},generated(){},onStep(){},progress(){}};
const withDb=async(fn,options)=>{const dir=mkdtempSync(join(tmpdir(),'g5-')),db=makeDb(join(dir,'db.sqlite'),options);try{await fn(db,dir);}finally{db.close();rmSync(dir,{recursive:true,force:true});}};
function setup(db,{agentMode='install'}={}){saveInfisical(db,{...configInput,agentMode,...(agentMode==='connect'?{externalProxyContainer:'external-proxy'}:{})});const input={...identityInput};if(agentMode==='skip'){delete input.proxy;delete input.agent;}saveInfisicalIdentities(db,input);}
function apply(db){const r=reviewInfisical(db);return applyInfisical(db,{revision:r.revision,reviewToken:r.reviewToken,reviewed:true},'admin');}
function renderer(db,dir){mkdirSync(join(dir,'sites'),{recursive:true});let fail=false;const render={caddyFilePath:d=>join(dir,'sites',d+'.caddy'),regenerate:async(db,d)=>{const rows=db.prepare('SELECT r.*,s.target_ip,s.kind,s.type FROM service_http_routes r JOIN services s ON s.id=r.service_id WHERE r.domain=?').all(d);writeFileSync(render.caddyFilePath(d),buildDomainCaddyConfig(rows,d));},adapt:async()=>{if(fail){fail=false;throw Error('scripted Caddy failure');}},reload:async()=>{},writeConfig:async(p,s)=>writeFileSync(p,s),removeConfig:async p=>rmSync(p,{force:true}),fail(){fail=true;}};return render;}
function harness(db,dir,{flows=async()=>({consumer:'verified',agentProxy:'scripted_flow_only'}),...overrides}={}){const docker=dockerFixture(),api=infisicalApiFixture(db),render=renderer(db,join(dir,'caddy'));let now=Date.now();
  const deps={db,owner:'runner@g5#123:a',exec:docker,nowMs:()=>now,infisicalDeps:{root:join(dir,'protected'),send:api.send,hostProbe:()=>{},runtime:(r,o)=>ensureInfisicalRuntime(r,{...o,attempts:1,sleep:async()=>{}}),flows,...overrides}};
  const step=async()=>{now+=35000;await runOnce(deps,{max:1,reconcileFirst:false});await runBackendSteps({db,owner:'backend@g5#124:a',nowMs:()=>now,sleep:async()=>{},deps:backendStepDeps({getDb:()=>db,renderDeps:render})});};
  return {deps,docker,api,render,step,advance(ms){now+=ms;},get now(){return now;},async finish(){for(let i=0;i<5;i++){await step();const job=getJob(db,readInfisical(db).last_job_id);if(!['queued','running'].includes(job.status))return job;}throw Error('G5 never settled');}};
}
test('G5.1 production HTTP admin, CSRF, fresh-auth, strict inputs; save is inert and encrypted',()=>withDb(async db=>{const f=await apiFixture(db);try{
  assert.equal((await f.request('/infisical',{who:null})).status,401);assert.equal((await f.request('/infisical',{who:'user'})).status,403);
  for(const options of [{csrf:false},{who:'cold'}])assert([401,403].includes((await f.request('/infisical',{method:'PUT',body:configInput,...options})).status));
  assert.equal((await f.request('/infisical',{method:'PUT',body:{...configInput,image:'arbitrary'}})).status,400);
  assert.equal((await f.request('/infisical',{method:'PUT',body:configInput})).status,200);
  const response=await f.request('/infisical/identities',{method:'PUT',body:identityInput});assert.equal(response.status,200);assert(!JSON.stringify(response.body).includes(identityInput.agent.clientSecret));
  assert.equal(db.prepare('SELECT count(*) AS n FROM setup_jobs').get().n,0);
  const stored=db.prepare('SELECT value FROM setup_infisical_credentials').get().value;assert(stored.startsWith('enc:v1:'));assert(!stored.includes(identityInput.proxy.clientSecret));
  assert(!JSON.stringify(db.prepare('SELECT * FROM audit').all()).includes(identityInput.proxy.clientSecret));
  assert.equal((await f.request('/infisical/apply',{method:'POST',body:{revision:2,reviewed:true,reviewToken:'0'.repeat(64)}})).status,409);
}finally{await f.close();}}));
test('G5.1 independent Agent Proxy skip and full skip install nothing',()=>withDb(db=>{
  const choices={...emptyChoices(),infisical:{mode:'install',url:'https://secrets.example.com',agentProxyMode:'skip',agentProxyUrl:''}};assert(choicesSchema.safeParse(choices).success);
  db.prepare('UPDATE setup_platform_plan SET choices_json=?').run(JSON.stringify(choices));setup(db,{agentMode:'skip'});
  assert.equal(readInfisical(db).config.agentMode,'skip');assert(!readInfisical(db).identities.proxy);assert.deepEqual(Object.keys(reviewInfisical(db).handoff.policies),['workload']);
  choices.infisical={mode:'skip',url:'',agentProxyUrl:''};db.prepare('UPDATE setup_platform_plan SET choices_json=?').run(JSON.stringify(choices));assert.throws(()=>apply(db),/skipped/);assert.equal(db.prepare('SELECT count(*) AS n FROM setup_jobs').get().n,0);
}));
test('G5.2 retry refuses identity/credential rotation and stale or mutable target configuration',()=>withDb(db=>{setup(db);const before=infisicalSecrets(db,readInfisical(db));saveInfisicalIdentities(db,{...identityInput,expectedRevision:2});assert.deepEqual(infisicalSecrets(db,readInfisical(db)),before);
  assert.throws(()=>saveInfisicalIdentities(db,{...identityInput,expectedRevision:2,agent:{...identityInput.agent,clientSecret:'new-unapproved-credential'}}),/preserve/);
  assert.throws(()=>saveInfisical(db,{...configInput,expectedRevision:2,testHost:'10.20.30.41'}),/bind|immutable/);
  assert.throws(()=>saveInfisicalIdentities(db,identityInput),/changed/);
}));
test('G5.2 audited exact effective rules reject broader and hidden folder grants',()=>withDb(async db=>{setup(db);const r=readInfisical(db),api=infisicalApiFixture(db);const expected=expectedPolicies(r.identities,'install').agent;
  assert(verifyPolicies([{permissions:[['proxy','proxied-services',{environment:'g5',secretPath:'/proxypilot-g5'}]]}],expected));
  for(const bad of [[['readValue','secrets',{}]],[['proxy','proxied-services',{}]],[['proxy','proxied-services',{environment:'g5',secretPath:'/proxypilot-g5'},1]]])assert.throws(()=>verifyPolicies([{permissions:bad}],expected));
  api.badAgent=true;await assert.rejects(verifyInfisicalIdentities(r,infisicalSecrets(db,r),createInfisicalClient(r.config.origin,{send:api.send})),/permissions differ/);
}));
test('G5.1/.5 managed production runtime and Caddy adapters create once, reuse keys and preserve unrelated state',()=>withDb(async(db,dir)=>{setup(db);const before=db.prepare('SELECT * FROM sso_config').get(),h=harness(db,dir);apply(db);let job=await h.finish();assert.equal(job.status,'succeeded',job.reason);
  const key=readFileSync(join(dir,'protected','protected.json'),'utf8'),count=h.docker.calls.filter(a=>a.includes('create')).length;
  const caddy=readFileSync(join(dir,'caddy/sites/secrets.example.com.caddy'),'utf8');assert(caddy.includes('127.0.0.1:18085'));assert(caddy.includes('192.0.2.40'));
  apply(db);job=await h.finish();assert.equal(job.status,'succeeded',job.reason);assert.equal(h.docker.calls.filter(a=>a.includes('create')).length,count);assert.equal(readFileSync(join(dir,'protected','protected.json'),'utf8'),key);
  assert.deepEqual(h.api.writes,[TEST_KEY,PROXY_KEY]);assert.deepEqual(db.prepare('SELECT * FROM sso_config').get(),before);assert.equal(db.prepare("SELECT target_port FROM service_http_routes WHERE id='test-route'").get().target_port,18443);
  const combined=JSON.stringify([db.prepare('SELECT * FROM setup_jobs').all(),db.prepare('SELECT * FROM setup_job_events').all(),infisicalState(db)]);for(const value of [...Object.values(infisicalSecrets(db,readInfisical(db))),JSON.parse(key).test,JSON.parse(key).proxyTest,JSON.parse(key).encryption])assert(!combined.includes(value));
}));
test('G5.2 incomplete handoff fails truthfully and retry preserves services and credentials',()=>withDb(async(db,dir)=>{saveInfisical(db,configInput);const h=harness(db,dir);apply(db);const first=await h.finish();assert.equal(first.status,'failed');assert.match(first.reason,/handoff/);const before=readFileSync(join(dir,'protected/protected.json'),'utf8');saveInfisicalIdentities(db,identityInput);h.api.serviceReady=false;apply(db);const second=await h.finish();assert.equal(second.status,'failed');assert.match(second.reason,/proxied service/);assert.equal(h.api.secrets.size,2);h.api.serviceReady=true;apply(db);assert.equal((await h.finish()).status,'succeeded');assert.equal(readFileSync(join(dir,'protected/protected.json'),'utf8'),before);
}));
test('G5.3 conflicting existing disposable secret is never overwritten',()=>withDb(async(db,dir)=>{setup(db);const h=harness(db,dir);h.api.secrets.set(TEST_KEY,{secretValue:'unrelated-preserve-me',secretComment:'foreign'});apply(db);const job=await h.finish();assert.equal(job.status,'failed');assert.match(job.reason,/Nothing was overwritten/);assert.equal(h.api.secrets.get(TEST_KEY).secretValue,'unrelated-preserve-me');assert.deepEqual(h.api.writes,[]);}));
test('G5.1 connect Infisical leaves its runtime/Caddy untouched; Agent Proxy skipped reports application only',()=>withDb(async(db,dir)=>{setup(db,{agentMode:'skip'});const h=harness(db,dir,{flows:async()=>({consumer:'verified',agentProxy:'skipped'})});apply(db);const job=await h.finish();assert.equal(job.status,'succeeded',job.reason);assert.equal(JSON.parse(job.verification_json).state,'application_secret_verified');assert(!h.docker.calls.some(a=>a[0]==='docker'));assert.equal(db.prepare('SELECT count(*) AS n FROM service_http_routes').get().n,1);assert.deepEqual(h.api.writes,[TEST_KEY]);},{mode:'connect',agentMode:'skip'}));
test('G5.1 existing Agent Proxy verification is read-only and refuses changed command/environment/listeners',()=>withDb(async(db,dir)=>{setup(db);const r=readInfisical(db),d=dockerFixture(),root=join(dir,'protected'),values=infisicalSecrets(db,r);prepareInfisicalFiles(r,{root});await ensureAgentProxyRuntime(r,values,{exec:d,job:handle,root});const name=namesFor(r).proxy;r.config.agentMode='connect';r.config.externalProxyContainer=name;const before=d.calls.length;await ensureAgentProxyRuntime(r,values,{exec:d,job:handle,root});assert(!d.calls.slice(before).some(a=>['create','start','restart'].includes(a[1])));
  const actual=d.objects.container.get(name);actual.Config.Cmd.push('--unmatched-host=allow');await assert.rejects(ensureAgentProxyRuntime(r,values,{exec:d,job:handle,root}),/command/);actual.Config.Cmd.pop();actual.Config.Env.push('HTTPS_PROXY=http://foreign');await assert.rejects(ensureAgentProxyRuntime(r,values,{exec:d,job:handle,root}),/environment/);actual.Config.Env.pop();actual.HostConfig.PortBindings['17322/tcp'][0].HostIp='0.0.0.0';await assert.rejects(ensureAgentProxyRuntime(r,values,{exec:d,job:handle,root}),/isolation/);
}));
test('G5.5 foreign Docker collision and missing protected keys fail without replacement',()=>withDb(async(db,dir)=>{setup(db);const r=readInfisical(db),d=dockerFixture(),root=join(dir,'protected'),n=namesFor(r);d.objects.volume.set(n.databaseVolume,{Labels:{}});await assert.rejects(ensureInfisicalRuntime(r,{exec:d,job:handle,root}),/collision/);assert(!d.calls.some(a=>a[1]==='create'));d.objects.volume.clear();await ensureInfisicalRuntime(r,{exec:d,job:handle,root,attempts:1});rmSync(join(root,'protected.json'));await assert.rejects(ensureInfisicalRuntime(r,{exec:d,job:handle,root}),/Restore/);
}));
test('G5.5 failed runtime and Caddy failures retry with the same references; raw failures redacted',()=>withDb(async(db,dir)=>{setup(db);const h=harness(db,dir);h.docker.failOnce(a=>a[0]==='start');apply(db);let job=await h.finish();assert.equal(job.status,'failed');assert(!job.reason.includes('DO-NOT-LOG'));const key=readFileSync(join(dir,'protected/protected.json'),'utf8');h.render.fail();apply(db);job=await h.finish();assert.equal(job.status,'failed');assert.match(job.reason,/Caddy/);apply(db);assert.equal((await h.finish()).status,'succeeded');assert.equal(readFileSync(join(dir,'protected/protected.json'),'utf8'),key);h.api.available=false;apply(db);job=await h.finish();assert.equal(job.status,'failed');assert(!JSON.stringify(db.prepare('SELECT * FROM setup_job_events').all()).includes('DO-NOT-LOG'));}));
test('G5.5 runner interruption reconciles and resumes from saved keys; backend never runs host setup',()=>withDb(async(db,dir)=>{setup(db);const h=harness(db,dir);apply(db);await h.step();let job=getJob(db,readInfisical(db).last_job_id);assert.equal(job.status,'queued');
  const claimed=claimNextJob(db,{owner:'runner@dead#1:a',kinds:['infisical_apply'],nowMs:h.now+40000,leaseMs:1});assert(claimed);h.advance(200000);await reconcile({...h.deps,nowMs:h.now});assert.equal((await h.finish()).status,'succeeded');
  apply(db);const backend=claimNextJob(db,{owner:'backend@g5#2:a',kinds:['infisical_apply'],nowMs:h.now+40000});const result=await executeJob(backend,{...h.deps,owner:'backend@g5#2:a'});assert.equal(result.outcome,'runner_unavailable');
}));
test('G5.5 recorded slow route child keeps parent queued; unrelated VM lock prevents delivery',()=>withDb(async(db,dir)=>{setup(db);const h=harness(db,dir);apply(db);await runOnce(h.deps,{max:1,reconcileFirst:false});const row=readInfisical(db),child=getJob(db,row.edge_job_id);const lease=acquireLock(db,{app:INFISICAL_APP,owner:'backend@slow#5:a',operation:'configure_infisical_route',jobId:child.id,leaseMs:999999,nowMs:h.now});h.advance(35000);await runOnce(h.deps,{max:1,reconcileFirst:false});assert.equal(getJob(db,row.last_job_id).status,'queued');releaseLock(db,{app:INFISICAL_APP,owner:'backend@slow#5:a',epoch:lease.lock.epoch});
  acquireLock(db,{app:configInput.agentVm,owner:'runner@other#9:a',operation:'deploy',jobId:'other',leaseMs:999999});const job=await h.finish();assert.equal(job.status,'failed');assert.match(job.reason,/test VM.*lock/);
}));
test('G5.4 isolation refuses containers, shared devices, raw VM options and non-local private listeners',async()=>{for(const altered of [{...vm,type:'container'},{...vm,expanded_devices:{...vm.expanded_devices,host:{type:'disk',source:'/var/lib/proxypilot',path:'/host'}}},{...vm,expanded_config:{'raw.qemu':'unreviewed'}}])await assert.rejects(assertIsolatedAgentVm(configInput,{job:handle,exec:{host:async()=>({code:0,stdout:JSON.stringify([altered])})}}),/VM|isolated/);assert.throws(()=>assertLocalTestHost(configInput,{interfaces:{}}),/not assigned/);});
test('G5.5 job schema refuses commands/secrets; review token and platform intention are mandatory',()=>withDb(db=>{setup(db);const job=apply(db).job;assert(validateRunnerJob({...job,plan_json:JSON.stringify({params:{revision:2}})}).ok);assert(!validateRunnerJob({...job,plan_json:JSON.stringify({params:{revision:2,secret:'forbidden'}})}).ok);const p=db.prepare('SELECT choices_json FROM setup_platform_plan').get(),choices=JSON.parse(p.choices_json);choices.infisical.mode='skip';db.prepare('UPDATE setup_platform_plan SET choices_json=?').run(JSON.stringify(choices));assert.throws(()=>apply(db),/skipped/);}));
test('G5 transport pins DNS, refuses redirects and strips error bodies',async()=>{let sent;const fake=(url,options,cb)=>{sent={url,options};const req=new (awaitImportEventEmitter())();req.end=()=>{const res=new (awaitImportEventEmitter())();res.statusCode=302;cb(res);queueMicrotask(()=>{res.emit('data',Buffer.from('credential-value'));res.emit('end');req.emit('close');});};req.destroy=()=>req.emit('error',Error());return req;};
  const {EventEmitter}=await import('node:events');function awaitImportEventEmitter(){return EventEmitter;}
  const result=await infisicalRequest('https://secrets.example.com','/api/status',{resolve:async()=>[{address:'10.20.30.40'}],request:fake});assert.deepEqual(result,{status:302,body:null});assert.equal(sent.options.agent,false);assert.equal(sent.options.rejectUnauthorized,undefined);
  await assert.rejects(infisicalRequest('https://secrets.example.com','/api/status',{resolve:async()=>[{address:'169.254.169.254'}],request:fake}),/blocked/);await assert.rejects(infisicalRequest('https://secrets.example.com','https://other.example/api/status'),/outside/);
});
test('G5.5 real API process restart preserves encrypted references and queued job',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'g5-api-restart-')),path=join(dir,'db.sqlite');let child;
  const start=async()=>{child=fork(new URL('./helpers/infisical-api-process.js',import.meta.url),[path],{stdio:['ignore','ignore','inherit','ipc']});return (await once(child,'message'))[0];};
  const stop=async()=>{const exited=once(child,'exit');child.send('close');await exited;child=null;};
  const request=async(f,path,method='GET',body)=>{const res=await fetch(f.url+'/api/setup/platform/infisical'+path,{method,headers:{Cookie:`pp_token=${f.tokens.admin}; pp_csrf=fixture-csrf`,'X-CSRF-Token':'fixture-csrf','Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});assert(res.ok);return res.json();};
  try{
    let f=await start();await request(f,'','PUT',configInput);await request(f,'/identities','PUT',identityInput);
    const before=await request(f,''),input={revision:before.review.revision,reviewToken:before.review.reviewToken,reviewed:true};
    const queued=await request(f,'/apply','POST',input);await stop();f=await start();const after=await request(f,'');
    assert.deepEqual(after.state.identities,before.state.identities);assert.equal(after.state.credentialRef,before.state.credentialRef);assert.equal(after.state.job.id,queued.job.id);
    assert.equal((await request(f,'/apply','POST',input)).job.id,queued.job.id);
    assert(!JSON.stringify(after).includes(identityInput.proxy.clientSecret));
  }finally{if(child)await stop();rmSync(dir,{recursive:true,force:true});}
});
test('G5.4 retry rejects volume driver and private network drift before proxy start',()=>withDb(async(db,dir)=>{
  setup(db);const r=readInfisical(db),d=dockerFixture(),root=join(dir,'protected'),values=infisicalSecrets(db,r),n=namesFor(r);
  prepareInfisicalFiles(r,{root});await ensureAgentProxyRuntime(r,values,{exec:d,job:handle,root});
  d.objects.volume.get(n.proxyVolume).Options={device:'/host',type:'none',o:'bind'};
  await assert.rejects(ensureAgentProxyRuntime(r,values,{exec:d,job:handle,root}),/isolation/);
  d.objects.volume.get(n.proxyVolume).Options={};d.objects.network.get(n.proxyNetwork).Driver='host';
  await assert.rejects(ensureAgentProxyRuntime(r,values,{exec:d,job:handle,root}),/isolation/);
}));
test('G5.1 Connect accepts an existing dedicated bridge/volume without renaming or writing external resources',()=>withDb(async(db,dir)=>{
  setup(db);const r=readInfisical(db),d=dockerFixture(),root=join(dir,'protected'),values=infisicalSecrets(db,r),n=namesFor(r);
  prepareInfisicalFiles(r,{root});await ensureAgentProxyRuntime(r,values,{exec:d,job:handle,root});
  const actual=d.objects.container.get(n.proxy);actual.HostConfig.NetworkMode='operator-proxy-bridge';actual.NetworkSettings.Networks={'operator-proxy-bridge':{}};actual.Mounts[0].Name='operator-proxy-state';actual.Config.Labels={};
  d.objects.network.set('operator-proxy-bridge',{Driver:'bridge',Internal:false,Options:{},Containers:{proxy:{Name:n.proxy}}});
  d.objects.volume.set('operator-proxy-state',{Driver:'local',Options:{}});
  r.config.agentMode='connect';r.config.externalProxyContainer=n.proxy;const before=d.calls.length;
  const result=await ensureAgentProxyRuntime(r,values,{exec:d,job:handle,root});assert.equal(result.network,'operator-proxy-bridge');assert.equal(result.volume,'operator-proxy-state');
  assert(!d.calls.slice(before).some(a=>['create','start','restart','rm'].includes(a[1])));
  d.objects.network.get('operator-proxy-bridge').Containers.other={Name:'unrelated-container'};
  await assert.rejects(ensureAgentProxyRuntime(r,values,{exec:d,job:handle,root}),/shared/);
}));
