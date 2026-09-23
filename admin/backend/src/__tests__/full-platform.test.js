import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeDb, config, approved, handle, keycloakWire, apiFixture } from './helpers/full-platform-fixture.js';
import { saveFullPlatform, readFullPlatform, fullPlatformState, configSchema, reviewFullPlatform, applyFullPlatform } from '../lib/setup-engine/full-platform-store.js';
import { connectManagedKeycloak, keycloakAdmin, reconcileOwnedIdentity, protectedValue, storeProtected } from '../lib/setup-engine/full-platform-keycloak.js';
import { runFullPlatformOperation } from '../lib/setup-engine/full-platform-op.js';
import { queueAdministrator, runAdministrator } from '../lib/setup-engine/full-platform-admin.js';
import { lifecycleReview, queueLifecycle, runLifecycle } from '../lib/setup-engine/full-platform-lifecycle.js';
import { readPlatformPlan } from '../lib/setup-engine/platform-plan.js';
import { readOpenBao, secrets as baoSecrets } from '../lib/setup-engine/openbao-store.js';
import { readVaultwarden, secrets as vaultSecrets } from '../lib/setup-engine/vaultwarden-store.js';
import { readInfisical } from '../lib/setup-engine/infisical-store.js';
import { readConfig, recordEvidence, activationReadiness } from '../lib/sso/store.js';
import { createJob, getJob, startJob, acquireLock } from '../lib/setup-engine/store.js';
import { runOnce, executeJob } from '../lib/setup-engine/executor.js';
import { validateRunnerJob } from '../lib/setup-engine/logic.js';

const terminal=(db,id,verification=null)=>db.prepare("UPDATE setup_jobs SET status='succeeded',owner=NULL,verification_json=? WHERE id=?").run(verification?JSON.stringify(verification):null,id);
const withDb=async fn=>{const db=makeDb();try{await fn(db);}finally{db.close();}};
async function connected(db) {
  const job=approved(db), k=db.prepare('SELECT * FROM setup_keycloak').get(),wire=keycloakWire(k);
  storeProtected(db,`keycloak-bootstrap-${k.id}`,{installationId:k.id,password:'b'.repeat(43),retired:false});
  const identity=async(db,k,full,{job})=>{const admin=await keycloakAdmin(k,'b'.repeat(43),{send:wire.send,job});try{return await reconcileOwnedIdentity(db,k,full,admin.api,job);}finally{await admin.close();}};
  startJob(db,{id:job.id,owner:'runner@full-test#1:a'});
  const args={db,params:{revision:1},job:handle(job.id),identity,interfaces:{test:[{address:'10.20.30.40',internal:false}]}};
  for(let i=0;i<5;i++){
    const result=await runFullPlatformOperation(args);
    const children=db.prepare("SELECT id,kind FROM setup_jobs WHERE id!=? AND status='queued'").all(job.id);
    for(const c of children){terminal(db,c.id,{state:'awaiting_user_action',label:'Scripted handoff pending'});if(c.kind==='verify_sso')db.prepare("UPDATE sso_config SET verified_at=?,verified_json=?").run(new Date().toISOString(),JSON.stringify({valid:true}));}
    if(!result.waiting){terminal(db,job.id,result.verification);return {job,k,wire,args,result};}
  }
  throw Error('Coordinator did not settle');
}
test('FP-1 inert CAS save, exact domains, restrictive networks and migration boundaries',()=>withDb(db=>{
  const n=db.prepare('SELECT count(*) n FROM setup_jobs').get().n;
  const input={expectedRevision:0,config:config(),reviewed:true};saveFullPlatform(db,input,'admin');assert.equal(db.prepare('SELECT count(*) n FROM setup_jobs').get().n,n);
  assert.equal(saveFullPlatform(db,{...input,expectedRevision:1},'admin').revision,1);
  assert.throws(()=>saveFullPlatform(db,input,'admin'),/another session/);
  for(const origin of ['https://10.20.30.40','http://pilot.example.com','https://pilot.example.com:8443','https://pilot.example.com/path'])assert(!configSchema.safeParse({...config(),publicOrigin:origin}).success);
  assert(!configSchema.safeParse({...config(),recoveryOrigin:config().publicOrigin}).success);
  assert(!configSchema.safeParse({...config(),recoveryNetworks:['0.0.0.0/0']}).success);
  const changed=config();changed.services.keycloak.url='https://different.example.com';assert.throws(()=>saveFullPlatform(db,{...input,expectedRevision:1,config:changed},'admin'),/migration/);
  assert(!fullPlatformState(db).complete);
}));
test('FP-2 existing managed Keycloak continuation connects all clients without reinstall, preserves secrets and retries without duplicate writes',()=>withDb(async db=>{
  const old=db.prepare('SELECT * FROM setup_keycloak').get(),{wire,args,k}=await connected(db);
  assert.equal(db.prepare('SELECT last_job_id FROM setup_keycloak').get().last_job_id,old.last_job_id);
  assert.equal(readOpenBao(db).config.basic,true);assert.equal(readOpenBao(db).config.database,undefined);
  assert.equal(readInfisical(db).config.agentVm,undefined);assert.equal(readInfisical(db).config.basic,true);
  assert.equal(readVaultwarden(db).config.matchExistingEmail,false);
  const realm=wire.realms.get(k.realm);assert.equal(realm.realm.unrelated,'preserved');assert.equal(realm.clients.length,6);
  const mutations=wire.calls.filter(c=>['PUT','POST','DELETE'].includes(c.method)&&!c.path.includes('protocol/openid-connect')).length;
  const before=[baoSecrets(db,readOpenBao(db)),vaultSecrets(db,readVaultwarden(db))];
  await args.identity(db,k,readFullPlatform(db),{job:args.job});
  assert.equal(wire.calls.filter(c=>['PUT','POST','DELETE'].includes(c.method)&&!c.path.includes('protocol/openid-connect')).length,mutations);
  assert.deepEqual([baoSecrets(db,readOpenBao(db)),vaultSecrets(db,readVaultwarden(db))],before);
  assert(!fullPlatformState(db).complete);assert.equal(fullPlatformState(db).stage,'administrator');
  const publicState=JSON.stringify(fullPlatformState(db));for(const v of before)assert(!publicState.includes(v.client));
  const client=realm.clients.find(c=>c.clientId.endsWith('-proxypilot'));client.secret='foreign-new-value';await assert.rejects(args.identity(db,k,readFullPlatform(db),{job:args.job}),/will not rotate/);assert.equal(client.secret,'foreign-new-value');
}));
test('FP-2 protected root ownership and existing bootstrap credential are required; external realm mutations refused',()=>withDb(async db=>{
  const job=approved(db),k=db.prepare('SELECT * FROM setup_keycloak').get(),dir=mkdtempSync(join(tmpdir(),'fp-keycloak-'));mkdirSync(join(dir,k.id),{mode:0o700});
  try{for(const [name,value] of [['owner.json',{id:k.id,origin:k.origin,realm:k.realm}],['credentials.json',{bootstrap:'b'.repeat(43),database:'d'.repeat(43)}]])writeFileSync(join(dir,k.id,name),JSON.stringify(value),{mode:0o600});
    const wire=keycloakWire(k);await connectManagedKeycloak(db,k,readFullPlatform(db),{job:handle(job.id),root:dir,send:wire.send});
    assert.equal(protectedValue(db,`keycloak-bootstrap-${k.id}`).password,'b'.repeat(43));
    await assert.rejects(connectManagedKeycloak(db,{...k,ownership:'external'},readFullPlatform(db),{job:handle(job.id),root:dir,send:wire.send}),/External/);
    writeFileSync(join(dir,k.id,'owner.json'),JSON.stringify({id:'someone-else'}));await assert.rejects(connectManagedKeycloak(db,k,readFullPlatform(db),{job:handle(job.id),root:dir,send:wire.send}),/ownership/);
  }finally{rmSync(dir,{recursive:true,force:true});}
}));
test('FP-3 HTTP reveal requires current admin, CSRF, sudo and actual recent local proof; audit and status never contain the value',()=>withDb(async db=>{
  await connected(db);const f=await apiFixture(db);try{
    for(const who of [null,'user','cold'])assert([401,403].includes((await f.request('/full/keycloak/reveal',{method:'POST',who,body:{}})).status));
    assert.equal((await f.request('/full/keycloak/reveal',{method:'POST',body:{},csrf:false})).status,403);
    assert.equal((await f.request('/full/keycloak/reveal',{method:'POST',body:{}})).status,403);
    const session=db.prepare("SELECT id FROM sessions WHERE user_id='admin' AND sudo_until IS NOT NULL").get();
    db.prepare("INSERT INTO sso_session_context(session_id,user_id,origin,method,authenticated_at,local_proof_at) VALUES (?,'admin',?,'local',?,?)").run(session.id,f.url.replace('http:','https:'),Date.now(),Date.now());
    const result=await f.request('/full/keycloak/reveal',{method:'POST',body:{}});assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(result.body.password,'b'.repeat(43));assert.equal(result.headers.get('cache-control'),'no-store');
    const publicRows=JSON.stringify([fullPlatformState(db),db.prepare('SELECT * FROM audit').all(),db.prepare('SELECT * FROM setup_jobs').all(),db.prepare('SELECT * FROM setup_job_events').all()]);assert(!publicRows.includes(result.body.password));
    db.prepare('UPDATE sso_session_context SET local_proof_at=?').run(Date.now()-301000);assert.equal((await f.request('/full/keycloak/reveal',{method:'POST',body:{}})).status,403);
    db.prepare('UPDATE sso_session_context SET local_proof_at=?').run(Date.now());storeProtected(db,readFullPlatform(db).state.identity.bootstrapRef,{installationId:'kc-aabbccddeeff',retired:true});
    assert.equal((await f.request('/full/keycloak/reveal',{method:'POST',body:{}})).body.retired,true);
  }finally{await f.close();}
}));
function proof(db,applicationId){const sso=readConfig(db);db.prepare('INSERT OR REPLACE INTO sso_links VALUES (?,?,?,?)').run(sso.config.issuer,applicationId,'admin',new Date().toISOString());
  for(const id of ['login-proof','recovery-proof'])db.prepare('INSERT OR REPLACE INTO sessions(id,user_id,expires_at) VALUES (?,?,?)').run(id,'admin',new Date(Date.now()+3600000).toISOString());
  for(const kind of ['login','sudo','recovery'])recordEvidence(db,sso,'admin',kind,kind==='recovery'?'recovery-proof':'login-proof');
  db.prepare("INSERT OR REPLACE INTO services(id,name,target_ip) VALUES ('proxypilot-local-recovery','proxypilot-local-recovery','127.0.0.1')").run();
  db.prepare("INSERT OR REPLACE INTO service_http_routes(id,service_id,domain,path_prefix,target_port,ssl_enabled,force_https,ip_allowlist_json) VALUES ('proxypilot-local-recovery','proxypilot-local-recovery','recovery.example.com','/',3001,1,1,?)").run(JSON.stringify(sso.config.recoveryNetworks));
  assert(activationReadiness(db,readConfig(db),'admin').ready);
}
test('FP-3 permanent master/application users resume without replacement; retirement requires fresh administration, linked SSO and separate recovery',()=>withDb(async db=>{
  const {wire}=await connected(db),localBefore=db.prepare('SELECT * FROM users').all();const input={revision:1,action:'create',email:'alice@example.com',useCurrent:true,password:'personal-password-unchanged',reviewed:true},user={id:'admin',username:'Alice'};
  const create=async()=>{const queued=queueAdministrator(db,input,user);startJob(db,{id:queued.job.id,owner:'runner@full-admin#1:a'});const result=await runAdministrator(db,readFullPlatform(db),'administrator',handle(queued.job.id),{send:wire.send});terminal(db,queued.job.id,result.verification);};
  await create();const profile=readFullPlatform(db).state.administrator;await create();assert.deepEqual(readFullPlatform(db).state.administrator,profile);assert.equal(wire.realms.get('master').users.length,2);assert.equal(wire.realms.get('proxypilot').users.length,1);assert.equal(wire.passwords.get('master:Alice'),input.password);
  assert.deepEqual(db.prepare('SELECT * FROM users').all(),localBefore);assert.throws(()=>queueAdministrator(db,{...input,action:'verify_and_retire'},user),/SSO/);
  proof(db,profile.applicationId);
  const runRetire=async password=>{const q=queueAdministrator(db,{...input,action:'verify_and_retire',password},user);startJob(db,{id:q.job.id,owner:'runner@full-admin#1:a'});try{return await runAdministrator(db,readFullPlatform(db),'retire',handle(q.job.id),{send:wire.send});}finally{terminal(db,q.job.id);}};
  await assert.rejects(runRetire('incorrect-personal-password'),/fresh login failed/);assert(wire.realms.get('master').users.some(u=>u.username==='bootstrap-admin'));
  await runRetire(input.password);assert(!wire.realms.get('master').users.some(u=>u.username==='bootstrap-admin'));assert(protectedValue(db,readFullPlatform(db).state.identity.bootstrapRef).retired);assert(readFullPlatform(db).state.administratorVerified);
  assert(!fullPlatformState(db).complete);assert.equal(db.prepare("SELECT count(*) n FROM setup_full_credentials WHERE id LIKE 'full-administrator-%'").get().n,0);
}));
test('FP-4 container-only removal requires ownership and retained mounts; blocks identity dependencies and never deletes data',()=>withDb(async db=>{
  const {k}=await connected(db);assert(lifecycleReview(db,'keycloak','remove').blockers.length);db.prepare("UPDATE setup_keycloak SET ownership='external'").run();assert.throws(()=>lifecycleReview(db,'keycloak','remove'),/External/);db.prepare("UPDATE setup_keycloak SET ownership='managed'").run();
  const r=readOpenBao(db),dir=mkdtempSync(join(tmpdir(),'fp-lifecycle-')),snapshot='retained-recovery-and-data';writeFileSync(join(dir,'owner.json'),JSON.stringify({ref:r.credential_ref,origin:r.config.origin}),{mode:0o600});writeFileSync(join(dir,'data-sentinel'),snapshot);
  try{const review=lifecycleReview(db,'openbao','remove'),input={revision:1,service:'openbao',action:'remove',reviewToken:review.reviewToken,reviewed:true,retainData:true};assert.throws(()=>queueLifecycle(db,{...input,retainData:false},'admin'));
    const q=queueLifecycle(db,input,'admin');startJob(db,{id:q.job.id,owner:'runner@fp-life#1:a'});const calls=[],n=(await import('../lib/setup-engine/openbao-logic.js')).namesFor(r);let foreign=true;
    const exec={host:async args=>{calls.push(args);return {code:0,stdout:args[2]==='ls'?n.server:args[2]==='inspect'?JSON.stringify([{Id:'immutable-owned-id',Config:{Labels:{'io.proxypilot.openbao':foreign?'foreign':r.credential_ref}},State:{Running:true},Mounts:[{Type:'volume',Name:n.volume,Destination:'/openbao/file',RW:true},{Type:'volume',Name:n.logs,Destination:'/openbao/logs',RW:true}]}]):''};}};
    await assert.rejects(runLifecycle(db,readFullPlatform(db),handle(q.job.id),exec,{roots:{openbao:dir}}),/another installation/);assert(!calls.some(c=>c.includes('stop')||c.includes('rm')));foreign=false;
    await runLifecycle(db,readFullPlatform(db),handle(q.job.id),exec,{roots:{openbao:dir}});assert(calls.some(c=>c.join(' ')==='docker rm immutable-owned-id'));assert(!calls.flat().includes('--volumes'));assert(!calls.some(c=>c[1]==='volume'));assert.equal(readFileSync(join(dir,'data-sentinel'),'utf8'),snapshot);assert.equal(fullPlatformState(db).services.find(s=>s.id==='openbao').state,'runtime_removed');
  }finally{rmSync(dir,{recursive:true,force:true});}
}));
test('FP-5 production executor enforces runner policy and strict revision-only job envelope',()=>withDb(async db=>{
  const q=approved(db);assert(validateRunnerJob(q).ok);assert(!validateRunnerJob({...q,plan_json:JSON.stringify({params:{revision:1,password:'forbidden'}})}).ok);
  const claimed=startJob(db,{id:q.id,owner:'backend@fp#1:a'});const out=await executeJob(getJob(db,q.id),{db,owner:'backend@fp#1:a',exec:{host(){throw Error('No backend host fallback');}}});assert.equal(out.outcome,'runner_unavailable');
}));
