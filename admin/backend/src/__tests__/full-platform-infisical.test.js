import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { makeDb,configInput,ids } from './helpers/infisical-fixture.js';
import { FULL_PLATFORM_SCHEMA } from '../lib/setup-engine/full-platform-store.js';
import { saveInfisical,readInfisical,applyInfisical,reviewInfisical,infisicalSecrets } from '../lib/setup-engine/infisical-store.js';
import { provisionManagedInfisical,personalRef } from '../lib/setup-engine/full-platform-infisical.js';
import { protectedValue,storeProtected } from '../lib/setup-engine/full-platform-keycloak.js';
import { expectedPolicies } from '../lib/setup-engine/infisical-logic.js';
const token=p=>'header.'+Buffer.from(JSON.stringify(p)).toString('base64url')+'.fixture';
function fixture(){
 const db=makeDb();db.exec(FULL_PLATFORM_SCHEMA);saveInfisical(db,{...configInput,basic:true,agentVm:undefined});const q=applyInfisical(db,{revision:1,reviewToken:reviewInfisical(db).reviewToken,reviewed:true},'admin');
 const r=readInfisical(db),job={id:q.job.id,fence(){}};storeProtected(db,personalRef(r),{email:'alice@example.com',password:'personal-credential-not-retained',expiresAt:Date.now()+900000});
 const state={initialized:false,original:token({identityAccessTokenId:randomUUID()}),limited:'limited-authority',originalRevoked:false,detached:false,identities:{},roles:[],folders:[],services:[],writes:[],fault:null};
 const ok=body=>({status:200,body}),missing=()=>({status:404,body:null});let project;
 const api=async(path,{method='GET',body,token:authority}={})=>{
  if(method!=='GET')state.writes.push({path,method});
  if(state.seedProject&&!project)project={id:ids.project,name:'ProxyPilot',orgId:ids.org,slug:`proxypilot-${r.credential_ref.slice(-12)}`,description:`ProxyPilot ${r.credential_ref}`,environments:[]};
  const kind=Object.keys(state.identities).find(k=>authority===token({identityId:state.identities[k].id}));
  if(path==='/api/v1/admin/config')return ok({config:{initialized:state.initialized}});
  if(path==='/api/v1/admin/bootstrap'){state.initialized=true;return ok({organization:{id:ids.org},user:{id:ids.workload},identity:{id:ids.agent,credentials:{token:state.original}}});}
  if(path==='/api/v1/identities/details')return kind?ok({identityDetails:{organization:{id:ids.org}}}):authority===state.original&&!state.originalRevoked||authority===state.limited&&!state.detached?ok({identityDetails:{}}):{status:401,body:null};
  if(path.includes('/token-auth/')&&path.endsWith('/revoke')){state.originalRevoked=true;return ok({});}
  if(path.includes('/token-auth/')){
   if(method==='PATCH'){if(state.fault==='lifetime')return {status:403,body:null};assert.equal(body.accessTokenTTL,900);return ok({});}
   if(path.endsWith('/tokens'))return ok({accessToken:state.limited,expiresIn:900});
   if(method==='DELETE'){state.detached=true;if(state.fault==='retire'){state.fault=null;throw Error('response lost after remote retirement');}return ok({});}
  }
  if(path==='/api/v1/projects'){
   if(method==='POST'&&project)return {status:400,body:{message:`A project with the slug "${body.slug}" already exists in your organization.`}};
   if(method==='POST'){project={id:ids.project,name:body.projectName,orgId:ids.org,slug:body.slug,description:body.projectDescription,environments:[]};return ok({project});}
   return ok({projects:project&&!state.hiddenProject?[project]:[]});
  }
  // Organization-admin routes: every org project, and joining one as the calling admin.
  // Like Infisical, `search` matches the project NAME ("ProxyPilot"), never the slug.
  if(path.startsWith('/api/v1/organization-admin/projects?')){const q=new URLSearchParams(path.split('?')[1]).get('search');const all=project?[project]:[];const list=q?all.filter(p=>p.name.toLowerCase().includes(q.toLowerCase())):all;state.orgAdminLists=(state.orgAdminLists||0)+1;return ok({projects:list,count:list.length});}
  if(path===`/api/v1/organization-admin/projects/${ids.project}/grant-admin-access`){state.hiddenProject=false;state.granted=(state.granted||0)+1;return ok({membership:{projectId:ids.project}});}
  if(path===`/api/v1/projects/${ids.project}`)return ok({project});
  if(path.endsWith('/environments')){project.environments.push({slug:body.slug});return ok({});}
  if(path.startsWith('/api/v2/folders')){if(method==='POST')state.folders.push(body);return ok({folders:state.folders});}
  if(path.startsWith('/api/v1/identities?'))return ok({identities:Object.values(state.identities).map(identity=>({identity}))});
  if(path==='/api/v1/identities'&&method==='POST'){const k=body.name.split('-').at(-1),identity={...body,id:ids[k]};state.identities[k]=identity;return ok({identity});}
  if(path.startsWith('/api/v1/identities/')){const identity=Object.values(state.identities).find(i=>i.id===path.split('/').at(-1));return ok({identity:{identity,metadata:identity.metadata}});}
  // Free self-hosted edition (licence rbac:false): custom project roles are refused.
  if(path.endsWith('/roles')){if(method==='POST'){state.roles.push(body);return {status:400,body:{message:'Failed to create custom role due to plan RBAC restriction. Upgrade to Infisical Enterprise plan to create custom roles.'}};}return ok({roles:[]});}
  if(path.includes('/permissions/audit')){const k=Object.keys(state.identities).find(k=>path.includes(state.identities[k].id)),identities=Object.fromEntries(Object.entries(state.identities).map(([k,i])=>[k,{identityId:i.id}]));return ok({sources:[{permissions:expectedPolicies(identities,'install')[k].map(p=>[p.action.join(','),p.subject,p.conditions])}]});}
  if(path.includes('/memberships/identities/')){const i=Object.values(state.identities).find(i=>path.endsWith(i.id));if(method==='POST'||method==='PATCH'){i.membership={identityMembership:{roles:body.roles.map(r=>({...r,customRoleId:null}))}};return ok({});}return i.membership?ok(i.membership):missing();}
  if(path==='/api/v1/auth/universal-auth/login'){const i=Object.values(state.identities).find(i=>i.id===body.clientId);return i?.secret===body.clientSecret?ok({accessToken:token({identityId:i.id}),expiresIn:300}):{status:403,body:null};}
  if(path.includes('/universal-auth/identities/')){const i=Object.values(state.identities).find(i=>path.includes(i.id));
   if(path.endsWith('/client-secrets')){if(method==='POST'){i.secret='machine-'+randomUUID();if(state.fault==='secret'){state.fault=null;throw Error('response lost after credential issuance');}return ok({clientSecret:i.secret});}return ok({clientSecretData:i.secret?[{id:'one-issued-secret'}]:[]});}
   if(method==='POST')i.ua={...body,clientId:i.id};return i.ua?ok({identityUniversalAuth:i.ua}):missing();
  }
  // Like Infisical v0.165: a proxied service may only reference an existing secret.
  if(path.startsWith('/api/v1/proxied-services')){if(method==='POST'){if(!state.proxySecret)return {status:400,body:null,error:'Referenced secret(s) not found in folder or its imports: PP_G5_PROXY_CREDENTIAL'};state.services.push(body);}return ok({services:state.services});}
  throw Error('Unscripted Infisical path '+method+' '+path);
 };
 return {db,state,api,r,run:(opts={})=>provisionManagedInfisical(db,readInfisical(db),api,{job,ensureProxySecret:async(projectId)=>{state.proxySecret=projectId;},...opts}),ref:`full-infisical-provision-${r.credential_ref}`};
}
test('FP-2 Infisical owned basic provisioning creates exact scoped identities, uses their credentials, retires bootstrap authority and reuses receipts',async()=>{
 const f=fixture();try{assert((await f.run()).ready);assert(f.state.originalRevoked&&f.state.detached);assert.equal(f.state.roles.length,0,'no custom role is attempted on the free edition');assert.deepEqual(Object.fromEntries(Object.entries(f.state.identities).map(([k,i])=>[k,i.membership.identityMembership.roles.map(r=>r.role)])),{workload:['member'],proxy:['viewer'],agent:['admin']});assert.equal(Object.keys(f.state.identities).length,3);assert(!f.db.prepare('SELECT id FROM setup_full_credentials WHERE id=?').get(personalRef(f.r)));
 const protectedState=protectedValue(f.db,f.ref);assert(protectedState.complete);assert(!protectedState.token&&!protectedState.originalToken);assert(Object.values(protectedState.identities).every(i=>!i.clientSecret));
 const secrets=infisicalSecrets(f.db,readInfisical(f.db)),before=f.state.writes.length;assert((await f.run()).ready);assert.equal(f.state.writes.length,before);assert.deepEqual(infisicalSecrets(f.db,readInfisical(f.db)),secrets);
 const visible=JSON.stringify([readInfisical(f.db),f.db.prepare('SELECT * FROM setup_jobs').all()]);for(const secret of Object.values(secrets))assert(!visible.includes(secret));
 }finally{f.db.close();}
});
test('FP-2 Infisical final retirement response loss resumes by verifying existing scoped credentials without new issuance',async()=>{
 const f=fixture();try{f.state.fault='retire';await assert.rejects(f.run(),/response lost/);assert(f.state.detached);const count=()=>f.state.writes.filter(w=>!w.path.endsWith('/login')).length,n=count();assert((await f.run()).ready);assert.equal(count(),n);}finally{f.db.close();}
});
test('FP-2 Infisical unknown secret receipt refuses reissuance and preserves existing organization and machine resources',async()=>{
 const f=fixture();try{f.state.fault='secret';await assert.rejects(f.run(),/response lost/);const secret=f.state.identities.workload.secret;await assert.rejects(f.run(),/interrupted/);assert.equal(f.state.identities.workload.secret,secret);assert.equal(f.state.writes.filter(w=>w.path.endsWith('/client-secrets')).length,1);assert(f.state.originalRevoked);}finally{f.db.close();}
});
test('FP-2 Infisical lifetime reduction failure retires unrestricted token and clears personal input; existing unowned instance is never adopted',async()=>{
 const f=fixture();try{f.state.fault='lifetime';await assert.rejects(f.run(),/Bound bootstrap token/);assert(f.state.originalRevoked);assert(!protectedValue(f.db,f.ref).originalToken);assert(!f.db.prepare('SELECT id FROM setup_full_credentials WHERE id=?').get(personalRef(f.r)));}finally{f.db.close();}
 const g=fixture();try{g.state.initialized=true;await assert.rejects(g.run(),/without this installation/);assert.equal(g.state.writes.length,0);assert(!g.db.prepare('SELECT id FROM setup_full_credentials WHERE id=?').get(personalRef(g.r)));}finally{g.db.close();}
});

test('free edition: an identity holding a different or extra role is corrected to its built-in role, and the agent risk is reported',async()=>{
 const f=fixture();try{
  const { sameBuiltinRole } = await import('../lib/setup-engine/infisical-api.js');
  assert(sameBuiltinRole({identityMembership:{roles:[{role:'viewer',isTemporary:false}]}},'viewer'));
  assert(!sameBuiltinRole({identityMembership:{roles:[{role:'viewer'},{role:'admin'}]}},'viewer'));
  assert(!sameBuiltinRole({identityMembership:{roles:[{role:'custom',customRoleId:'x'}]}},'custom'));
  assert(!sameBuiltinRole({identityMembership:{roles:[{role:'admin',isTemporary:true}]}},'admin'));
  const { reviewInfisical } = await import('../lib/setup-engine/infisical-store.js');
  const review=reviewInfisical(f.db);assert.match(review.handoff.risk,/Admin of the dedicated ProxyPilot project/);assert.deepEqual(review.handoff.builtinRoles,{workload:'member',proxy:'viewer',agent:'admin'});
 }finally{f.db.close();}
});

test('resume: a project the caller cannot list is found organization-wide and joined, never created twice',async()=>{
 const f=fixture();try{
  // The project already exists (made on an earlier run by another Infisical identity) and the caller is not a member.
  f.state.seedProject=true;f.state.hiddenProject=true;
  assert((await f.run()).ready);
  assert.equal(f.state.writes.filter(w=>w.path==='/api/v1/projects'&&w.method==='POST').length,0,'no second project creation');
  assert.equal(f.state.granted,1,'joined the existing project as organization admin');
 }finally{f.db.close();}
});

test('resume with a recorded project id joins that project directly, without an organization-wide search',async()=>{
 const f=fixture();try{
  f.state.seedProject=true;f.state.hiddenProject=true;
  storeProtected(f.db,f.ref,{identities:{},owner:f.r.credential_ref,projectId:ids.project});
  assert((await f.run()).ready);
  assert.equal(f.state.orgAdminLists||0,0,'no search needed');
  assert.equal(f.state.granted,1);
  assert.equal(f.state.writes.filter(w=>w.path==='/api/v1/projects'&&w.method==='POST').length,0);
 }finally{f.db.close();}
});

test('FP-2b the proxied service is created only after its referenced secret exists; Infisical\'s refusal text reaches the operator',async()=>{
  const f=fixture();
  await assert.rejects(f.run({ensureProxySecret:null}),/Owned proxied destination unavailable \(HTTP 400\)\. Infisical said: "Referenced secret\(s\) not found in folder or its imports: PP_G5_PROXY_CREDENTIAL"/);
  assert.equal(f.state.services.length,0);
  const out=await f.run();assert.equal(out.ready,true);assert.equal(f.state.proxySecret,f.state.services[0].projectId,'secret created in the same project first');
});

test('generated password: bootstrap uses the password generated into OpenBao; ProxyPilot keeps no copy and a later sign-in reads it back by itself',async()=>{
 const f=fixture();try{
  storeProtected(f.db,personalRef(f.r),{email:'alice@example.com',generate:true,expiresAt:Date.now()+900000});
  const vault={calls:[],password:'Gen3ra-tedPwd-inOpen-Bao123'};
  const adminVault=async args=>{vault.calls.push(args);return vault.password;};
  let bootstrapBody;
  const api=async(path,opts={})=>{if(path==='/api/v1/admin/bootstrap')bootstrapBody=opts.body;return f.api(path,opts);};
  // Stop before completion (lost machine-credential response) so a resume is needed.
  f.state.fault='secret';
  await assert.rejects(provisionManagedInfisical(f.db,readInfisical(f.db),api,{job:{id:readInfisical(f.db).last_job_id,fence(){}},ensureProxySecret:async p=>{f.state.proxySecret=p;},adminVault}),/response lost/);
  assert.deepEqual(vault.calls,[{email:'alice@example.com',origin:f.r.config.origin,fresh:true}]);
  assert.equal(bootstrapBody.password,vault.password);assert.equal(bootstrapBody.email,'alice@example.com');
  assert(!f.db.prepare('SELECT id FROM setup_full_credentials WHERE id=?').get(personalRef(f.r)),'the handoff is deleted');
  const kept=protectedValue(f.db,f.ref);assert.equal(kept.passwordInOpenBao,true);
  assert(!JSON.stringify([kept,f.db.prepare('SELECT * FROM setup_jobs').all()]).includes(vault.password),'the password is not stored by ProxyPilot');
  // Later: the 15-minute authority has expired and nobody re-entered anything.
  const later=Date.now()+3600_000,logins=[];
  const resumeApi=async(path,opts={})=>{
   if(path==='/api/v3/auth/login'){logins.push(opts.body);return opts.body.password===vault.password?{status:200,body:{accessToken:'login-token'}}:{status:400,body:null,error:'Invalid credentials'};}
   if(path==='/api/v3/auth/select-organization')return {status:200,body:{token:token({userId:ids.workload,exp:Math.floor(later/1000)+900}),isMfaEnabled:false}};
   return f.api(path,opts);
  };
  const run=()=>provisionManagedInfisical(f.db,readInfisical(f.db),resumeApi,{job:{id:readInfisical(f.db).last_job_id,fence(){}},now:later,ensureProxySecret:async p=>{f.state.proxySecret=p;},adminVault});
  await assert.rejects(run(),/interrupted/,'resumes up to the recorded unknown-secret refusal');
  assert.deepEqual(vault.calls.at(-1),{email:'alice@example.com',origin:f.r.config.origin,fresh:false});
  assert.deepEqual(logins.at(-1),{email:'alice@example.com',password:vault.password});
  // A password changed in Infisical but not in OpenBao is named as such.
  vault.password='changed-elsewhere-not-in-openbao';logins.length=0;
  const mismatch=async(path,opts={})=>path==='/api/v3/auth/login'?{status:400,body:null,error:'Invalid credentials'}:resumeApi(path,opts);
  await assert.rejects(provisionManagedInfisical(f.db,readInfisical(f.db),mismatch,{job:{id:readInfisical(f.db).last_job_id,fence(){}},now:later,adminVault}),/password stored in OpenBao \(team\/infisical-administrator\) does not match/);
 }finally{f.db.close();}
});

test('generated password: without OpenBao the job refuses before bootstrapping anything',async()=>{
 const f=fixture();try{
  storeProtected(f.db,personalRef(f.r),{email:'alice@example.com',generate:true,expiresAt:Date.now()+900000});
  await assert.rejects(f.run(),/kept in OpenBao, which this operation cannot reach/);
  assert.equal(f.state.initialized,false);assert.equal(f.state.writes.length,0);
 }finally{f.db.close();}
});

test('administrator handoff input: a chosen password or generate, never both, and nothing else',async()=>{
 const { personalSchema } = await import('../lib/setup-engine/full-platform-infisical.js');
 const base={revision:1,email:'alice@example.com',reviewed:true};
 assert(personalSchema.safeParse({...base,password:'a-long-chosen-password'}).success);
 assert(personalSchema.safeParse({...base,generate:true}).success);
 for(const bad of [{...base,generate:true,password:'a-long-chosen-password'},{...base},{...base,generate:false},{...base,password:'short'}])assert(!personalSchema.safeParse(bad).success,JSON.stringify(bad));
});

test('chosen password kept in OpenBao: written before bootstrap as chosen, and on a resume only after Infisical accepts it',async()=>{
 const f=fixture();try{
  const chosen='alices-own-chosen-password';
  storeProtected(f.db,personalRef(f.r),{email:'alice@example.com',password:chosen,keepInOpenBao:true,expiresAt:Date.now()+900000});
  const calls=[];const adminVault=async a=>{calls.push(a);return a.password;};
  const job={id:readInfisical(f.db).last_job_id,fence(){}};
  f.state.fault='secret';
  await assert.rejects(provisionManagedInfisical(f.db,readInfisical(f.db),f.api,{job,ensureProxySecret:async p=>{f.state.proxySecret=p;},adminVault}),/response lost/);
  assert.deepEqual(calls,[{email:'alice@example.com',origin:f.r.config.origin,fresh:true,password:chosen}]);
  assert.equal(protectedValue(f.db,f.ref).passwordInOpenBao,true);
  const schema=(await import('../lib/setup-engine/full-platform-infisical.js')).personalSchema;
  assert(schema.safeParse({revision:1,email:'a@example.com',password:'a-long-chosen-password',keepInOpenBao:true,reviewed:true}).success);
  assert(!schema.safeParse({revision:1,email:'a@example.com',generate:true,keepInOpenBao:true,reviewed:true}).success);
 }finally{f.db.close();}
 // Resume with a chosen password: nothing is stored when Infisical refuses it.
 const g=fixture();try{
  const calls=[];const adminVault=async a=>{calls.push(a);return a.password;};
  storeProtected(g.db,g.ref,{identities:{},owner:g.r.credential_ref,organizationId:ids.org,userId:ids.workload,email:'alice@example.com'});
  g.state.initialized=true;
  storeProtected(g.db,personalRef(g.r),{email:'alice@example.com',password:'wrong-chosen-password',keepInOpenBao:true,expiresAt:Date.now()+900000});
  const api=async(path,o={})=>path==='/api/v3/auth/login'?{status:400,body:null,error:'Invalid credentials'}:g.api(path,o);
  await assert.rejects(provisionManagedInfisical(g.db,readInfisical(g.db),api,{job:{id:readInfisical(g.db).last_job_id,fence(){}},adminVault}),/does not match/);
  assert.deepEqual(calls,[],'a refused password is never stored');
 }finally{g.db.close();}
});
