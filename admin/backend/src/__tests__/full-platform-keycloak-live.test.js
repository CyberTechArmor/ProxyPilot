// Disposable loopback Keycloak. No real browser passkey/login ceremony claimed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync,mkdirSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeDb,approved,handle } from './helpers/full-platform-fixture.js';
import { connectManagedKeycloak,keycloakAdmin,protectedValue } from '../lib/setup-engine/full-platform-keycloak.js';
import { readFullPlatform } from '../lib/setup-engine/full-platform-store.js';
import { queueAdministrator } from '../lib/setup-engine/full-platform-admin.js';
import { getJob } from '../lib/setup-engine/store.js';
import { runOnce } from '../lib/setup-engine/executor.js';
const enabled=process.env.FP_KEYCLOAK_HOME&&process.env.FP_JAVA_HOME;
test('FP real Keycloak 26.7.4: coordinator clients/flows/readback, permanent users and credential-preserving retry through runner', {skip:!enabled,timeout:180000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'fp-kc-real-')),db=makeDb(),local='http://127.0.0.1:18480';let child;
 try{
  child=spawn(join(process.env.FP_KEYCLOAK_HOME,'bin/kc.sh'),['start-dev','--http-host=127.0.0.1','--http-port=18480','--http-management-port=19000','--hostname='+local,'--db-url=jdbc:h2:file:'+join(dir,'db')+';NON_KEYWORDS=VALUE','--log-level=error'],{env:{...process.env,JAVA_HOME:process.env.FP_JAVA_HOME,KC_BOOTSTRAP_ADMIN_USERNAME:'bootstrap-admin',KC_BOOTSTRAP_ADMIN_PASSWORD:'b'.repeat(43)},stdio:['ignore','ignore','inherit']});
  const send=async(url,options)=>{const response=await fetch(local+new URL(url).pathname+new URL(url).search,options);if(process.env.FP_DEBUG_POLICY&&new URL(url).pathname==='/admin/realms/proxypilot'&&(!options?.method||options.method==='GET')){const data=await response.clone().json();console.error('Keycloak policy',Object.fromEntries(Object.entries(data).filter(([k])=>k.startsWith('webAuthnPolicyPasswordless'))));}return response;};
  let ready=false;for(let i=0;i<300;i++){if(child.exitCode!==null)throw Error('Disposable Keycloak exited before readiness');try{if((await fetch(local+'/realms/master')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,200));}assert(ready,'Keycloak startup');
  const k=db.prepare('SELECT * FROM setup_keycloak').get(),authority=await keycloakAdmin(k,'b'.repeat(43),{send});
  await authority.api('/admin/realms',{method:'POST',body:{realm:k.realm,enabled:true,attributes:{'proxypilot.installation':k.id}}});await authority.close();
  mkdirSync(join(dir,k.id),{mode:0o700});for(const [file,value]of Object.entries({'owner.json':{id:k.id,origin:k.origin,realm:k.realm},'credentials.json':{bootstrap:'b'.repeat(43),database:'d'.repeat(43)}}))writeFileSync(join(dir,k.id,file),JSON.stringify(value),{mode:0o600});
  const job=approved(db),identity=(db,k,full,{job})=>connectManagedKeycloak(db,k,full,{job,root:dir,send});
  const deps={db,owner:'runner@fp-real#1:a',exec:{host(){throw Error('No Docker or live host mutation in loopback test');}},fullPlatformDeps:{identity,interfaces:{test:[{address:'10.20.30.40',internal:false}]},administratorDeps:{send},dnsCheck:async()=>null}};
  await runOnce(deps,{max:1,kinds:['full_platform_apply'],reconcileFirst:false});
  const full=readFullPlatform(db);assert(full.state.identity?.clients?.vaultwarden,JSON.stringify(getJob(db,job.id)));const refs=Object.values(full.state.identity.clients).map(c=>[c.ref,protectedValue(db,c.ref)]);
  await identity(db,k,full,{job:handle(job.id)});assert.deepEqual(refs.map(([ref])=>[ref,protectedValue(db,ref)]),refs);
  const admin=await keycloakAdmin(k,'b'.repeat(43),{send});const realm=await admin.api('/admin/realms/'+k.realm);assert(realm.webAuthnPolicyPasswordlessResidentKey==='required'||realm.webAuthnPolicyPasswordlessRequireResidentKey==='Yes');assert.equal(realm.webAuthnPolicyPasswordlessRpId,'identity.example.com');const clients=await admin.api('/admin/realms/'+k.realm+'/clients');for(const c of Object.values(full.state.identity.clients))assert(clients.some(actual=>actual.clientId===c.id));await admin.close();
  db.prepare("UPDATE setup_jobs SET status='succeeded',owner=NULL WHERE id=?").run(job.id);
  const request={revision:1,action:'create',email:'alice@example.com',firstName:'Alice',lastName:'Administrator',password:'personal-fixture-password',reviewed:true};
  const q=queueAdministrator(db,request,{id:'admin',username:'Alice'});await runOnce(deps,{max:1,kinds:['full_platform_apply'],reconcileFirst:false});assert.equal(getJob(db,q.job.id).status,'succeeded',JSON.stringify(getJob(db,q.job.id)));
  const profile=readFullPlatform(db).state.administrator;assert(profile.masterId&&profile.applicationId);
  const login=await send(k.origin+'/realms/master/protocol/openid-connect/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:'admin-cli',grant_type:'password',username:'alice',password:request.password})});assert.equal(login.status,200,'Permanent master login');
  const retry=queueAdministrator(db,request,{id:'admin',username:'Alice'});await runOnce(deps,{max:1,kinds:['full_platform_apply'],reconcileFirst:false});assert.equal(getJob(db,retry.job.id).status,'succeeded');assert.deepEqual(readFullPlatform(db).state.administrator,profile);
  assert.equal(db.prepare("SELECT password_hash FROM users WHERE id='admin'").get().password_hash,'unchanged');
 }finally{if(child&&child.exitCode===null){const ended=once(child,'exit');child.kill('SIGTERM');await ended;}db.close();rmSync(dir,{recursive:true,force:true});}
});
