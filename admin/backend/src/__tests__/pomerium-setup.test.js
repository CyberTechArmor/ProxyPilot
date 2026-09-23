import { fork } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,readFileSync,writeFileSync,mkdirSync,rmSync,existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateKeyPairSync } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { makeDb,configInput,apiFixture } from './helpers/pomerium-fixture.js';
import { savePomerium,readPomerium,pomeriumState,pomeriumSecrets,reviewPomeriumRoute,savePomeriumRoute,applyPomerium,pomeriumIntents } from '../lib/setup-engine/pomerium-store.js';
import { POMERIUM_IMAGE,POMERIUM_APP,renderPomeriumConfig } from '../lib/setup-engine/pomerium-logic.js';
import { preparePomeriumFiles,ensurePomeriumRuntime,assertExternalConfig } from '../lib/setup-engine/pomerium-runtime.js';
import { configurePomeriumRoutes,protectionForRoute } from '../lib/setup-engine/pomerium-routes.js';
import { verifyLoopbackSockets,checkGatewayRedirect,verifyPomeriumGateway } from '../lib/setup-engine/pomerium-probes.js';
import { validatePomeriumClient } from '../lib/setup-engine/pomerium-identity.js';
import { getJob } from '../lib/setup-engine/store.js';
import { runOnce,reconcile } from '../lib/setup-engine/executor.js';
import { runBackendSteps } from '../lib/setup-engine/backend-steps.js';
import { validateRunnerJob,reconcileDecision,FencedError } from '../lib/setup-engine/logic.js';
import { verifyAssertion,testApp } from '../../scripts/g4-test-app.mjs';
const {buildDomainCaddyConfig}=await import('../routes/services.js');

// The pinned official image inherits its CA bundle path from its base image.
const pinnedImageEnv=['PATH=/bin','AUTOCERT_DIR=/data/autocert','SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt'];
const jobHandle={id:'test',fence(){},checkpoint(){},generated(){},progress(){},onStep(){}};
function protect(db) {
  const input={expectedRevision:readPomerium(db).revision,routeId:'test-route',subjects:['subject-alice'],action:'protect'};
  const review=reviewPomeriumRoute(db,input);
  return savePomeriumRoute(db,{...input,reviewToken:review.reviewToken,reviewed:true},'admin');
}
function renderer(db,dir) {
  mkdirSync(join(dir,'sites'),{recursive:true});
  let failNext=false,reloads=0;
  const render={
    caddyFilePath:d=>join(dir,'sites',`${d}.caddy`),
    regenerate:async(db,d)=>{const rows=db.prepare('SELECT r.*,s.target_ip,s.kind,s.type FROM service_http_routes r JOIN services s ON s.id=r.service_id WHERE domain=?').all(d).map(r=>({...r,protection:protectionForRoute(db,r.id)}));writeFileSync(render.caddyFilePath(d),buildDomainCaddyConfig(rows,d));},
    adapt:async()=>{if(failNext){failNext=false;throw new Error('scripted invalid Caddy');}},
    reload:async()=>{reloads++;},writeConfig:async(path,content)=>writeFileSync(path,content),removeConfig:async path=>rmSync(path,{force:true}),
    fail(){failNext=true;},get reloads(){return reloads;}
  };return render;
}
function docker() {
  let container=null,failStart=false,interrupt=false;const calls=[];
  return {calls,get container(){return container;},fail(){failStart=true;},interrupt(){interrupt=true;},host:async argv=>{
    calls.push(argv);const a=argv.slice(1),ok=stdout=>({code:0,stdout:stdout||'',stderr:''});
    if(argv[0]!=='docker')throw new Error('Unexpected fixture command');
    if(a[0]==='container' && a[1]==='ls') return ok(container?POMERIUM_APP:'');
    // The start helper's full inspect (no --format): immutable Id and state.
    if(a[0]==='container' && a[1]==='inspect' && a.length===3) return container?ok(JSON.stringify([{Id:'id-pomerium',Name:'/'+POMERIUM_APP,State:{Running:container.running,Status:container.running?'running':'created'},HostConfig:{LogConfig:{Type:'local',Config:{'max-size':'10m','max-file':'3'}}}}])):{code:1,stdout:'',stderr:'No such container'};
    if(a[0]==='container' && a[1]==='inspect') return ok(JSON.stringify(container));
    if(a[0]==='create') {
      assert(!container,'duplicate container');const source=a[a.indexOf('--mount')+1].match(/source=([^,]+)/)[1];
      container={image:POMERIUM_IMAGE,entrypoint:['/bin/pomerium'],command:['--config','/pomerium/config.json'],env:[...pinnedImageEnv],network:'host',ports:{},mounts:[{Type:'bind',Source:source,Destination:'/pomerium',RW:false}],labels:{'io.proxypilot.pomerium':a[a.indexOf('--label')+1].split('=')[1]},running:false,startedAt:'0001-01-01T00:00:00Z'};return ok(POMERIUM_APP);
    }
    if(['start','restart'].includes(a[0])) {if(failStart){failStart=false;return {code:1,stderr:'raw secret'};}container.running=true;container.startedAt=new Date(Date.now()+20).toISOString();if(interrupt){interrupt=false;throw new FencedError('test');}return ok();}
    if(a[0]==='exec' && a.includes('health')) return ok();
    throw new Error('Unexpected Docker argv');
  }};
}
function harness(db,dir,{clientProbe=async()=>({readOnly:true}),privateProbe=async()=>({loopbackOnly:true}),gatewayProbe=async()=>({routes:[{routeId:'test-route',spoofRefused:true}]})}={}) {
  const render=renderer(db,join(dir,'caddy')),runtime=docker();let now=Date.now();
  const deps={db,owner:'runner@g4#123:a',exec:runtime,nowMs:()=>now,pomeriumDeps:{runtime:(db,r,intents,opts)=>ensurePomeriumRuntime(db,r,intents,{...opts,root:join(dir,'pomerium'),attempts:1,sleep:async()=>{}}),providerProbe:async()=>({issuerExact:true}),clientProbe,privateProbe,gatewayProbe}};
  const step=async()=>{now+=35000;await runOnce(deps,{max:1,reconcileFirst:false});await runBackendSteps({db,owner:'backend@g4#124:a',nowMs:()=>now,sleep:async()=>{},deps:{pomeriumStep:args=>configurePomeriumRoutes(db,{...args,render})}});};
  const finish=async()=>{for(let i=0;i<5;i++){await step();const job=getJob(db,readPomerium(db).last_job_id);if(!['queued','running'].includes(job.status))return job;}throw new Error('Operation never settled');};
  return {deps,render,runtime,step,finish,advance(ms){now+=ms;},get now(){return now;}};
}
const withDb=async(fn)=>{const dir=mkdtempSync(join(tmpdir(),'g4-')),db=makeDb();try{await fn(db,dir);}finally{db.close();rmSync(dir,{recursive:true,force:true});}};

test('G4 API enforces admin, CSRF, sudo, strict inputs and secret-free inert save; skip is inert',()=>withDb(async db=>{
  const a=await apiFixture(db);try {
    assert.equal((await a.request('/pomerium',{who:null})).status,401);
    assert.equal((await a.request('/pomerium',{who:'user'})).status,403);
    assert.equal((await a.request('/pomerium',{method:'PUT',body:configInput,csrf:false})).status,403);
    assert.equal((await a.request('/pomerium',{who:'cold',method:'PUT',body:configInput})).status,401);
    assert.equal((await a.request('/pomerium',{method:'PUT',body:{...configInput,command:'rm'}})).status,400);
    const result=await a.request('/pomerium',{method:'PUT',body:configInput});assert.equal(result.status,200);assert(!JSON.stringify(result).includes(configInput.clientSecret));
    assert.equal(db.prepare('SELECT count(*) AS n FROM setup_jobs').get().n,0);
    const choices=JSON.parse(db.prepare('SELECT choices_json FROM setup_platform_plan').get().choices_json);choices.pomerium={mode:'skip',url:''};db.prepare('UPDATE setup_platform_plan SET choices_json=?').run(JSON.stringify(choices));
    assert.equal((await a.request('/pomerium/apply',{method:'POST',body:{expectedRevision:1,reviewed:true}})).status,409);
    assert.equal(db.prepare('SELECT count(*) AS n FROM setup_jobs').get().n,0);
  }finally{await a.close();}
}));
test('G4 preserves G3 and refuses its client, missing verification, stale revisions and secret rotation',()=>withDb(db=>{
  const before=db.prepare('SELECT * FROM sso_config').get();
  assert.throws(()=>savePomerium(db,{...configInput,clientId:'proxypilot'}),/separate/);
  assert.throws(()=>savePomerium(db,{...configInput,expectedPlanRevision:2}),/plan changed/);
  savePomerium(db,configInput);const secrets=pomeriumSecrets(db,readPomerium(db));
  savePomerium(db,{...configInput,expectedRevision:1});assert.deepEqual(pomeriumSecrets(db,readPomerium(db)),secrets);
  assert.throws(()=>savePomerium(db,{...configInput,expectedRevision:1,clientSecret:'different-client-secret-value'}),/preserve/);
  assert.deepEqual(db.prepare('SELECT * FROM sso_config').get(),before);
  assert(!JSON.stringify(pomeriumState(db)).includes(secrets.shared));
}));
test('G4.2 validates exact dedicated Keycloak client, callbacks, flow and S256; wildcards fail',()=>{
  const config={clientId:'pomerium',origin:'https://access.example.com'};
  const client={clientId:'pomerium',protocol:'openid-connect',enabled:true,publicClient:false,standardFlowEnabled:true,redirectUris:['https://access.example.com/oauth2/callback'],webOrigins:['https://access.example.com'],attributes:{'pkce.code.challenge.method':'S256'}};
  assert.equal(validatePomeriumClient(config,client).pkce,'S256');
  for(const change of [{redirectUris:['https://access.example.com/*']},{webOrigins:['*']},{serviceAccountsEnabled:true},{directAccessGrantsEnabled:true},{attributes:{}}])assert.throws(()=>validatePomeriumClient(config,{...client,...change}));
});
test('G4.3 review binds full route and small verified subject allow list; machine and unsupported routes refuse',()=>withDb(db=>{
  savePomerium(db,configInput);const input={expectedRevision:1,routeId:'test-route',subjects:['subject-alice'],action:'protect'};
  const review=reviewPomeriumRoute(db,input);
  assert.throws(()=>reviewPomeriumRoute(db,{...input,subjects:['unknown']}),/verified/);
  db.prepare("UPDATE service_http_routes SET csp='default-src self' WHERE id='test-route'").run();
  assert.throws(()=>savePomeriumRoute(db,{...input,reviewToken:review.reviewToken,reviewed:true},'admin'),/changed after review/);
  for(const [field,value,reason] of [['target_port',3001,/independent/],['websocket_enabled',1,/Unsupported/],['basic_auth_json','[]',/Unsupported/],['path_prefix','/api',/single HTTPS/]]) {
    const old=db.prepare(`SELECT ${field} AS value FROM service_http_routes WHERE id='test-route'`).get().value;
    db.prepare(`UPDATE service_http_routes SET ${field}=? WHERE id='test-route'`).run(value);assert.throws(()=>reviewPomeriumRoute(db,input),reason);db.prepare(`UPDATE service_http_routes SET ${field}=? WHERE id='test-route'`).run(old);
  }
}));
test('G4.3 SQL route ownership prevents aliases, edits, delete and moving the protected upstream',()=>withDb(db=>{
  savePomerium(db,configInput);protect(db);
  assert.throws(()=>db.exec("UPDATE service_http_routes SET target_port=9999 WHERE id='test-route'"),/owns/);
  assert.throws(()=>db.exec("DELETE FROM service_http_routes WHERE id='test-route'"),/explicit removal/);
  assert.throws(()=>db.exec("UPDATE services SET target_ip='10.0.0.1' WHERE id='app'"),/stable/);
  assert.throws(()=>db.exec("INSERT INTO service_http_routes(id,service_id,domain,path_prefix,target_port) VALUES('alias','app','bypass.example.com','/',18443)"),/bypass/);
}));
test('G4.3 native private listener proof rejects wildcard, duplicate public listener, Docker publish and missing process identity',()=>{
  const intents=[{upstream:'http://127.0.0.1:18443',action:'protect'}];
  const valid='LISTEN 0 511 127.0.0.1:18443 0.0.0.0:* users:(("node",pid=123,fd=3))';
  assert(verifyLoopbackSockets(valid,intents).loopbackOnly);
  for(const invalid of [valid.replace('127.0.0.1:18443','0.0.0.0:18443'),valid+'\n'+valid.replace('127.0.0.1:18443','[::]:8000'),valid.replace('node','docker-proxy'),valid.replace(/users:.+/,'')]) assert.throws(()=>verifyLoopbackSockets(invalid,intents));
});
test('G4.4 API → durable runner → existing Caddy renderer; repeat apply reuses credentials and routes',()=>withDb(async(db,dir)=>{
  const a=await apiFixture(db);try {
    await a.request('/pomerium',{method:'PUT',body:configInput});
    const body={expectedRevision:1,routeId:'test-route',subjects:['subject-alice'],action:'protect'};
    const review=(await a.request('/pomerium/routes/review',{method:'POST',body})).body.review;
    const queued=await a.request('/pomerium/routes/apply',{method:'POST',body:{...body,reviewToken:review.reviewToken,reviewed:true}});assert.equal(queued.status,202);
    const h=harness(db,dir),secrets=pomeriumSecrets(db,readPomerium(db));
    const completed=await h.finish();assert.equal(completed.status,'succeeded');
    assert.equal(pomeriumState(db).intents[0].state,'protected');
    const generated=JSON.parse(readFileSync(join(dir,'pomerium','config.json'),'utf8'));assert.equal(generated.authorize_service_url,'http://127.0.0.1:18082');assert.equal(generated.databroker_service_url,generated.authorize_service_url);
    const caddy=readFileSync(h.render.caddyFilePath('app.example.com'),'utf8');assert(caddy.includes('127.0.0.1:18081'));assert(!caddy.includes('127.0.0.1:18443'));assert(caddy.includes('header_up -X-Pomerium-*'));assert(!caddy.includes('forward_auth'));
    const again=applyPomerium(db,2,'admin');assert.equal(again.created,false);assert.equal(again.job.id,completed.id);
    assert.deepEqual(pomeriumSecrets(db,readPomerium(db)),secrets);assert.equal(h.runtime.calls.filter(a=>a[1]==='create').length,1);assert.equal(db.prepare('SELECT count(*) AS n FROM service_http_routes').get().n,2);
  }finally{await a.close();}
}));
test('G4.4 failed runtime leaves denied route; retry uses same resource/credentials and succeeds',()=>withDb(async(db,dir)=>{
  savePomerium(db,configInput);protect(db);const h=harness(db,dir);h.runtime.fail();
  const failed=await h.finish();assert.equal(failed.status,'failed');assert.equal(pomeriumState(db).intents[0].state,'denied');
  const caddy=readFileSync(h.render.caddyFilePath('app.example.com'),'utf8');assert(caddy.includes('503'));assert(!caddy.includes('18443'));
  const secrets=pomeriumSecrets(db,readPomerium(db));applyPomerium(db,2,'admin');assert.equal((await h.finish()).status,'succeeded');assert.deepEqual(pomeriumSecrets(db,readPomerium(db)),secrets);assert.equal(h.runtime.calls.filter(a=>a[1]==='create').length,1);
}));
test('G4.4 invalid Caddy apply retains denial, does not restore old direct file, and retries durably',()=>withDb(async(db,dir)=>{
  savePomerium(db,configInput);protect(db);const h=harness(db,dir);await h.render.regenerate(db,'app.example.com');h.render.fail();
  assert.equal((await h.finish()).status,'failed');assert(readFileSync(h.render.caddyFilePath('app.example.com'),'utf8').includes('503'));
  applyPomerium(db,2,'admin');assert.equal((await h.finish()).status,'succeeded');
}));
test('G4.4 restart/retry resumes saved intent and fenced writer issues no later mutation',()=>withDb(async(db,dir)=>{
  savePomerium(db,configInput);protect(db);const h=harness(db,dir);h.runtime.interrupt();await h.step();await h.step();
  const job=getJob(db,readPomerium(db).last_job_id);assert.equal(job.status,'running');
  assert.equal(reconcileDecision({job:{...job,lease_expires_at:new Date(0).toISOString()},nowMs:Date.now()}).action,'resume');
  h.advance(3600000);
  await reconcile({...h.deps,owner:'runner@g4#555:restarted',nowMs:h.now});
  h.deps.owner='runner@g4#555:restarted';
  const done=await h.finish();assert.equal(done.status,'succeeded');assert.equal(h.runtime.calls.filter(a=>a[1]==='create').length,1);
  const before=h.runtime.calls.length;await assert.rejects(ensurePomeriumRuntime(db,readPomerium(db),pomeriumIntents(db),{exec:h.runtime,job:{...jobHandle,fence(){throw new FencedError('lost');}},root:join(dir,'pomerium')}),/fenced|owned|lost/i);assert.equal(h.runtime.calls.length,before);
}));
test('G4.4 explicit removal requires new review, preserves route restrictions and never drops native app authentication',()=>withDb(async(db,dir)=>{
  db.exec(`UPDATE service_http_routes SET ip_allowlist_json='["10.1.0.0/16"]',extra_headers_json='{"X-Test":"kept"}' WHERE id='test-route'`);
  savePomerium(db,configInput);protect(db);const h=harness(db,dir);await h.finish();
  const input={expectedRevision:2,routeId:'test-route',subjects:[],action:'remove'},review=reviewPomeriumRoute(db,input);
  assert.throws(()=>savePomeriumRoute(db,{...input,reviewToken:'0'.repeat(64),reviewed:true},'admin'),/review/);
  savePomeriumRoute(db,{...input,reviewToken:review.reviewToken,reviewed:true},'admin');assert.equal((await h.finish()).status,'succeeded');
  const source=readFileSync(h.render.caddyFilePath('app.example.com'),'utf8');assert(source.includes('127.0.0.1:18443'));assert(source.includes('10.1.0.0/16'));assert(source.includes('X-Test'));assert.equal(pomeriumState(db).intents[0].state,'removed');
}));
test('G4.1 external handoff verification preserves unrelated routes and refuses overlapping/weakening policy',()=>withDb((db,dir)=>{
  savePomerium(db,configInput);protect(db);const files=preparePomeriumFiles(db,readPomerium(db),pomeriumIntents(db),{root:join(dir,'pm')});
  const actual=structuredClone(files.config);actual.routes.push({name:'unrelated',from:'https://other.example.net',to:'https://192.168.30.10:8080',allow_any_authenticated_user:true});
  const before=JSON.stringify(actual);assertExternalConfig(actual,files.config);assert.equal(JSON.stringify(actual),before);
  actual.routes[0].allow_any_authenticated_user=true;assert.throws(()=>assertExternalConfig(actual,files.config),/exactly match/);
  assert.throws(()=>assertExternalConfig({...files.config,authenticate_service_url:''},files.config),/authenticate_service_url/);
}));
test('G4.1 protected files retain credentials, reject drift/missing marker, and never emit secrets to state/jobs',()=>withDb((db,dir)=>{
  savePomerium(db,configInput);const r=readPomerium(db),root=join(dir,'pm'),files=preparePomeriumFiles(db,r,[],{root});assert.equal(files.content,preparePomeriumFiles(db,r,[],{root}).content);
  writeFileSync(files.candidate,'{}');assert.throws(()=>preparePomeriumFiles(db,r,[],{root}),/differs/);
  assert(!JSON.stringify(pomeriumState(db)).includes(configInput.clientSecret));
  assert.equal(validateRunnerJob({app:POMERIUM_APP,kind:'pomerium_apply',plan_json:JSON.stringify({params:{revision:1,command:'restart'}})}).ok,false);
}));
test('G4.6 probes perform real HTTP command contracts, reject direct success and inspect spoof refusal',async()=>{
  const header='HTTP/1.1 302 Found\r\nLocation: https://access.example.com/.pomerium/sign_in?x=1\r\n\r\n';
  assert.equal(checkGatewayRedirect(header,'https://access.example.com','app.example.com').status,302);
  assert.throws(()=>checkGatewayRedirect(header.replace('302 Found','200 OK'),'https://access.example.com','app.example.com'));
  const calls=[];const result=await verifyPomeriumGateway({origin:'https://access.example.com'},[{routeId:'test',domain:'app.example.com',action:'protect',restrictions:{}}],{job:jobHandle,exec:{host:async args=>{calls.push(args);return {code:0,stdout:header};}}});
  assert.equal(result.routes[0].spoofRefused,true);assert(calls.every(a=>a.includes('X-Pomerium-Jwt-Assertion: forged')));assert(calls[1].includes('app.example.com:443:127.0.0.1'));
});
test('G4.6 test app executes signed assertion contract: authorized identity, forgery, spoof, audience, issuer, expiry and direct access',async()=>{
  const {privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),keys=[publicKey.export({format:'jwk'})],domain='app.example.com';
  const signed=(claims={},opts={})=>jwt.sign({sub:'subject-alice',...claims},privateKey,{algorithm:'ES256',issuer:domain,audience:domain,expiresIn:60,...opts});
  assert.equal(verifyAssertion(signed(),{keys,domain}).sub,'subject-alice');
  for(const token of ['forged',signed({},{issuer:'attacker.example.com'}),signed({},{audience:'other.example.com'}),signed({},{expiresIn:-1})]) assert.throws(()=>verifyAssertion(token,{keys,domain}));
  const server=testApp({keys,domain});server.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  try {const url=`http://127.0.0.1:${server.address().port}`;assert.equal((await fetch(url)).status,401);assert.equal((await fetch(url,{headers:{'X-Pomerium-Jwt-Assertion':signed()}})).status,200);assert.equal((await fetch(url,{headers:{'X-Pomerium-Jwt-Assertion':signed(),'X-Forwarded-User':'administrator'}})).status,401);}finally{await new Promise(r=>server.close(r));}
});


test('G4.4 failed gateway verification queues durable denial before reporting failure',()=>withDb(async(db,dir)=>{
  savePomerium(db,configInput);protect(db);const h=harness(db,dir,{gatewayProbe:async()=>{throw new Error('unexpected 200');}});
  assert.equal((await h.finish()).status,'failed');
  assert.equal(pomeriumState(db).intents[0].state,'denied');
  assert(readFileSync(h.render.caddyFilePath('app.example.com'),'utf8').includes('503'));
}));
test('G4.4 unavailable Caddy never certifies initial denial and names the remaining runtime bypass',()=>withDb(async(db,dir)=>{
  savePomerium(db,configInput);protect(db);const render=renderer(db,join(dir,'caddy'));render.reload=async()=>{throw new Error('offline');};
  await assert.rejects(configurePomeriumRoutes(db,{revision:2,stage:'deny',render,fence(){}}),/app.example.com.*running configuration.*previous upstream/);
  assert.equal(pomeriumState(db).intents[0].state,'pending');
  assert(readFileSync(render.caddyFilePath('app.example.com'),'utf8').includes('503'));
}));
test('G4.1 existing Core connection is read-only, preserves its keys and unrelated route, and retries without restart',()=>withDb(async(db,dir)=>{
  const choices=JSON.parse(db.prepare('SELECT choices_json FROM setup_platform_plan').get().choices_json);choices.pomerium.mode='connect';db.prepare('UPDATE setup_platform_plan SET choices_json=?').run(JSON.stringify(choices));
  savePomerium(db,{...configInput,externalContainer:'external-core'});protect(db);
  const r=readPomerium(db),secrets=pomeriumSecrets(db,r),existingKeys={...secrets,shared:Buffer.alloc(32,1).toString('base64'),cookie:Buffer.alloc(32,2).toString('base64')};
  const actual=renderPomeriumConfig(r.config,pomeriumIntents(db),existingKeys);actual.routes.push({name:'unrelated',from:'https://other.example.net',to:'https://192.168.30.10:8080',allow_any_authenticated_user:true});
  const path=join(dir,'external.json');writeFileSync(path,JSON.stringify(actual),{mode:0o600});const before=readFileSync(path,'utf8'),calls=[];
  const instance={image:POMERIUM_IMAGE,entrypoint:['/bin/pomerium'],command:['--config','/pomerium/config.json'],env:[...pinnedImageEnv],network:'host',ports:{},mounts:[{Type:'bind',Source:path,Destination:'/pomerium/config.json',RW:false}],labels:{},running:true,startedAt:new Date(Date.now()+1000).toISOString()};
  const exec={host:async args=>{calls.push(args);return {code:0,stdout:args[2]==='ls'?'external-core':args[2]==='inspect'?JSON.stringify(instance):''};}};
  const opts={exec,job:jobHandle,root:join(dir,'pm'),attempts:1};
  assert.equal((await ensurePomeriumRuntime(db,r,pomeriumIntents(db),opts)).ownership,'external');
  await ensurePomeriumRuntime(db,r,pomeriumIntents(db),opts);
  assert.equal(readFileSync(path,'utf8'),before);assert.equal(pomeriumSecrets(db,r).shared,existingKeys.shared);
  assert(calls.every(a=>a[1]==='container'||a[1]==='exec'));assert(!calls.some(a=>a.includes('restart')||a.includes('create')));
}));
test('G4.4 real API process restart retains encrypted references, policy and queued job; repeat submission is idempotent',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'g4-process-')),path=join(dir,'db.sqlite');let child;
  const start=async()=>{child=fork(new URL('./helpers/pomerium-api-process.js',import.meta.url),[path],{stdio:['ignore','ignore','inherit','ipc']});return (await once(child,'message'))[0];};
  const stop=async()=>{const end=once(child,'exit');child.send('close');await end;child=null;};
  const request=async(f,path,method='GET',body)=>{const res=await fetch(f.url+'/api/setup/platform/pomerium'+path,{method,headers:{Cookie:`pp_token=${f.tokens.admin}; pp_csrf=fixture-csrf`,'X-CSRF-Token':'fixture-csrf','Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});assert(res.ok,await res.clone().text());return res.json();};
  try {
    let f=await start();await request(f,'','PUT',configInput);
    const input={expectedRevision:1,routeId:'test-route',subjects:['subject-alice'],action:'protect'};
    const {review}=await request(f,'/routes/review','POST',input);
    const queued=await request(f,'/routes/apply','POST',{...input,reviewToken:review.reviewToken,reviewed:true});const before=await request(f,'');
    await stop();f=await start();const after=await request(f,'');
    assert.deepEqual(after.state.intents,before.state.intents);assert.equal(after.state.credentialRef,before.state.credentialRef);assert.equal(after.state.job.id,queued.job.id);
    assert.equal((await request(f,'/apply','POST',{expectedRevision:2,reviewed:true})).job.id,queued.job.id);
  } finally {if(child)await stop();rmSync(dir,{recursive:true,force:true});}
});

test('G4.5 dashboard, identity, recovery and machine API route rendering remains byte-identical',()=>withDb(async(db,dir)=>{
  for(const [id,domain,port] of [['dashboard','pilot.example.com',3001],['recovery','recovery.example.com',3001],['identity','identity.example.com',18080]]) {
    db.prepare("INSERT INTO service_http_routes(id,service_id,domain,path_prefix,target_port) VALUES (?, 'app', ?, '/', ?)").run(id,domain,port);
  }
  const h=harness(db,dir),before={};for(const domain of ['pilot.example.com','recovery.example.com','identity.example.com']){await h.render.regenerate(db,domain);before[domain]=readFileSync(h.render.caddyFilePath(domain),'utf8');}
  savePomerium(db,configInput);
  for(const id of ['dashboard','recovery','identity']) assert.throws(()=>reviewPomeriumRoute(db,{expectedRevision:1,routeId:id,subjects:['subject-alice'],action:'protect'}),/independent/);
  protect(db);assert.equal((await h.finish()).status,'succeeded');
  for(const [domain,source] of Object.entries(before)){assert.equal(readFileSync(h.render.caddyFilePath(domain),'utf8'),source);await h.render.regenerate(db,domain);const normalized=x=>x.replace(/^# Generated:.*$/m,'# Generated: timestamp');assert.equal(normalized(readFileSync(h.render.caddyFilePath(domain),'utf8')),normalized(source));assert(!source.includes('18081'));}
  // MCP/delegated editing/provisioning/migration/terminal/health all retain this
  // backend route and their existing middleware; no path-level gateway is added.
  assert(before['pilot.example.com'].includes('127.0.0.1:3001'));
}));


test('G4.1 official image supports repeat runtime apply and protecting a route after installation',()=>withDb(async(db,dir)=>{
  savePomerium(db,configInput);applyPomerium(db,1,'admin');const h=harness(db,dir);
  assert.equal((await h.finish()).status,'succeeded','initial managed installation');
  const r=readPomerium(db),secrets=pomeriumSecrets(db,r),owner=readFileSync(join(dir,'pomerium','owner.json'),'utf8');
  const callsBefore=h.runtime.calls.length;
  await ensurePomeriumRuntime(db,r,[],{exec:h.runtime,job:jobHandle,root:join(dir,'pomerium'),attempts:1});
  assert.deepEqual(h.runtime.calls.slice(callsBefore).map(a=>a.slice(1,3)),[['container','ls'],['container','inspect'],['exec',POMERIUM_APP]],'repeat runtime apply inspects the inherited environment without creating or restarting');
  protect(db);assert.equal((await h.finish()).status,'succeeded','protection after installation must not stop at denied');
  assert.equal(pomeriumState(db).intents[0].state,'protected');
  assert.equal(h.runtime.calls.filter(a=>a[1]==='create').length,1);
  assert.equal(h.runtime.calls.filter(a=>a[1]==='restart').length,1,'only the changed route configuration restarts the owned container');
  assert.deepEqual(pomeriumSecrets(db,readPomerium(db)),secrets);
  assert.equal(readFileSync(join(dir,'pomerium','owner.json'),'utf8'),owner);
  assert.equal(db.prepare('SELECT count(*) AS n FROM service_http_routes').get().n,2);
}));
test('G4.1 only the exact pinned CA default is allowed; unauthorized environment overrides remain blocked',()=>withDb(async(db,dir)=>{
  savePomerium(db,configInput);const r=readPomerium(db),runtime=docker(),root=join(dir,'pm');
  const opts={exec:runtime,job:jobHandle,root,attempts:1};
  await ensurePomeriumRuntime(db,r,[],opts);
  const before=readFileSync(join(root,'config.json'),'utf8'),secrets=pomeriumSecrets(db,r);
  const cases=[
    pinnedImageEnv.map(e=>e.startsWith('SSL_CERT_FILE=')?'SSL_CERT_FILE=/tmp/untrusted-ca.pem':e),
    pinnedImageEnv.map(e=>e.startsWith('SSL_CERT_FILE=')?'SSL_CERT_FILE=':e),
    [...pinnedImageEnv,'SSL_CERT_FILE=/tmp/untrusted-ca.pem'],
    [...pinnedImageEnv,'SSL_CERT_DIR=/tmp/untrusted-certs'],
    [...pinnedImageEnv,'AUTOCERT_DIR=/tmp/other'],
    [...pinnedImageEnv,'ADDRESS=0.0.0.0:443'],
    [...pinnedImageEnv,'AUTHENTICATE_SERVICE_URL=https://unreviewed.example.com'],
  ];
  for(const env of cases) {
    runtime.container.env=env;const start=runtime.calls.length;
    await assert.rejects(ensurePomeriumRuntime(db,r,[],opts),/environment overrides are unsupported/);
    assert.deepEqual(runtime.calls.slice(start).map(a=>a.slice(1,3)),[['container','ls'],['container','inspect']],'reject before runtime mutation or health execution');
    assert.equal(readFileSync(join(root,'config.json'),'utf8'),before);
    assert.deepEqual(pomeriumSecrets(db,r),secrets);
  }
}));
