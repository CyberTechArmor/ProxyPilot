import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {generateKeyPairSync,randomUUID,createHash} from 'node:crypto';
import {mkdtempSync,rmSync,readFileSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import https from 'node:https';
import {createAuthority} from '../authority.mjs';
import {signAuthoritySnapshot} from '../authority-publisher.mjs';
import {createLocalAuthoritySource,readBrokerFacts,openReadonlyDatabase} from '../local-authority-source.mjs';
import {createKeycloakAuthorityReader} from '../keycloak-authority-reader.mjs';
import {startOidcFixture} from '../fixtures/oidc.mjs';
import {readLocalFacts} from '../../../admin/backend/src/lib/broker-authority-facts.js';
import {operationalProjectsMigration1100,operationalProjectsMigration1101} from '../../../admin/backend/src/lib/operational-projects-schema.js';

async function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),'local-authority-'));const ids=Object.fromEntries(['user','project','agent','workload','guide','submission','environment','output','resource','connection','grant','cap','subject'].map(k=>[k,randomUUID()]));let now=1900000000000,keycloakEnabled=true,outage=false;
 const proxy=new DatabaseSync(join(dir,'proxy.db'));proxy.exec('PRAGMA foreign_keys=OFF;CREATE TABLE users(id TEXT PRIMARY KEY,role TEXT,locked_until TEXT,updated_at TEXT,password_hash TEXT);');operationalProjectsMigration1100(proxy);operationalProjectsMigration1101(proxy);
 proxy.exec('CREATE TABLE ops_agent_configurations(id TEXT PRIMARY KEY,project_id TEXT,revision INTEGER,created_by TEXT,workflow_type TEXT,work_json TEXT,controls_json TEXT); CREATE TABLE ops_broker_tasks(id TEXT PRIMARY KEY,user_id TEXT,project_id TEXT,agent_id TEXT,configuration_revision INTEGER,attempt TEXT,fence TEXT,state TEXT,request_digest TEXT);');
 const guideHash='a'.repeat(64),scope={operations:['item.read','item.set_state'],resources:[ids.resource],limits:{max_actions:5,max_seconds:60}},work={guide_ref:{id:ids.guide,hash:guideHash},environment_ref:ids.environment},controls={operations:scope.operations,resources:scope.resources,max_actions:5,max_seconds:60,approval_policy:'writes',output_ref:ids.output};
 proxy.prepare('INSERT INTO users VALUES(?,?,?,?,?)').run(ids.user,'user',null,'now','UNREAD_LOCAL_PASSWORD');proxy.prepare('INSERT INTO ops_projects(id,name,owner_user_id,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(ids.project,'Fixture',ids.user,ids.user,'now','now');proxy.prepare('INSERT INTO ops_guide_versions(id,project_id,version_number,submission_id,approved_by,approved_at,content_hash) VALUES(?,?,?,?,?,?,?)').run(ids.guide,ids.project,1,ids.submission,ids.user,'now',guideHash);proxy.prepare('INSERT INTO ops_agent_configurations VALUES(?,?,?,?,?,?,?)').run(ids.agent,ids.project,1,ids.user,'typed_api_v1',JSON.stringify(work),JSON.stringify(controls));
 const broker=new DatabaseSync(join(dir,'broker.db'));broker.exec('CREATE TABLE records(kind TEXT,id TEXT,body TEXT,PRIMARY KEY(kind,id));');
 const connection={id:ids.connection,name:'Fixture',owner_id:ids.user,project_id:ids.project,adapter_id:'synthetic-ledger-v1',revision:1,policy_revision:1,credential_version:1,status:'active',...structuredClone(scope),permissions:[]},grant={id:ids.grant,user_id:ids.user,connection_id:ids.connection,project_id:ids.project,agent_id:ids.agent,revision:1,revoked:false,expires_at:now+3600000,...structuredClone(scope)};
 const put=(kind,r)=>broker.prepare('INSERT OR REPLACE INTO records VALUES(?,?,?)').run(kind,r.id,JSON.stringify(r));put('connection',connection);put('grant',grant);put('session',{id:randomUUID(),verifier:'NEVER_SELECTED_TOKEN_VERIFIER'});
 const policy={trust_mode:'local_backend_authority',subject_map:[{user_id:ids.user,issuer:'https://keycloak.example/realms/Fractionate',subject:ids.subject}],registrations:[{agent_id:ids.agent,user_id:ids.user,project_id:ids.project,workload_id:ids.workload,environment:{id:ids.environment,name:'Registered API worker',revision:1},output:{id:ids.output,name:'Project activity',revision:1,kind:'project_activity'},configuration_revision:1,guide_id:ids.guide,guide_hash:guideHash,checks_revision:1,expires_at:now+3600000,enabled:true}],ceilings:[{id:ids.cap,user_id:ids.user,project_id:ids.project,actions:['list','get','enroll','test','assign','unassign','approve','revoke','revalidatePolicy'],connection_ids:[],owned_connections:true,task_use:true,adapter_ids:['synthetic-ledger-v1'],...structuredClone(scope),expires_at:now+3600000,enabled:true,grant_rights:['view','use','assign'],manage_actions:['test','revoke']}]};
 const pair=generateKeyPairSync('ed25519'),privateKey=pair.privateKey.export({type:'pkcs8',format:'pem'}),authority=createAuthority({statePath:join(dir,'authority.json'),identity:{authenticate:async()=>({user_id:ids.user,fresh_until:now+30000,proof_type:'human',actions:[]})},sources:[{id:'local',public_key:pair.publicKey.export({type:'spki',format:'pem'}),kinds:['users','projects','agents','tasks','ceilings','policies']}],clock:()=>now});
 const readonly=openReadonlyDatabase(join(dir,'proxy.db')),readonlyBroker=openReadonlyDatabase(join(dir,'broker.db'));let lastRecords;
 const options={statePath:join(dir,'source.db'),readFacts:()=>readLocalFacts(readonly),readBroker:()=>readBrokerFacts(readonlyBroker),readPolicy:()=>policy,readKeycloak:async()=>{if(outage)throw Error('unavailable');return new Map([[ids.user,keycloakEnabled]]);},publisher:{publish:async({sequence,records,lease_ms})=>{lastRecords=records;return authority.ingest(signAuthoritySnapshot(privateKey,{version:'authority.v1',source_id:'local',sequence,challenge:authority.challenge(),issued_at:now,expires_at:now+lease_ms,records}));}},clock:()=>now,leaseMs:15000};let source=createLocalAuthoritySource(options);
 t.after(async()=>{await source.close();authority.close();readonly.close();readonlyBroker.close();proxy.close();broker.close();rmSync(dir,{recursive:true,force:true});});
 const f={authorize:async r=>{proxy.prepare('INSERT OR IGNORE INTO ops_broker_tasks VALUES(?,?,?,?,?,?,?,?,?)').run(r.id,r.user_id,r.project_id,r.agent_id,r.configuration_revision,r.attempt,r.fence,'starting',createHash('sha256').update(JSON.stringify(r)).digest('hex'));return source.authorizeTask(r);},dir,ids,proxy,broker,policy,connection,grant,put,scope,authority,get source(){return source;},get records(){return lastRecords;},tick:n=>now+=n,keycloak:v=>keycloakEnabled=v,outage:v=>outage=v,restart:async()=>{await source.close();source=createLocalAuthoritySource(options);},request:()=>({id:randomUUID(),user_id:ids.user,project_id:ids.project,agent_id:ids.agent,grant_id:ids.grant,connection_id:ids.connection,attempt:randomUUID(),fence:randomUUID(),configuration_revision:1,scope:{...structuredClone(scope),expires_at:now+50000,audience:'fractionate-broker'},steps:[{operation:'item.read',input:{resource_id:ids.resource}}]}),issue:async r=>{const p=authority.issueWorkloadProof(ids.workload,{grant_id:r.grant_id,task_id:r.id,attempt:r.attempt,fence:r.fence,configuration_revision:r.configuration_revision,...r.scope});await authority.authenticate(p);return {user_id:r.user_id,project_id:r.project_id,agent_id:r.agent_id,grant_id:r.grant_id,connection_id:r.connection_id,task_id:r.id,attempt:r.attempt,fence:r.fence,credential_version:1,policy_revision:1,...r.scope};}};return f;
}

test('actual SQLite metadata yields scoped signed state; preview never approves and explicit authorize is one-shot',async t=>{
 const f=await fixture(t);await f.source.refresh();assert.equal(f.authority.workloadReady(f.ids.workload),true);const r=f.request();assert.equal((await f.source.previewTask(r)).readiness.ready,true);assert.equal(f.records.tasks.length,0);assert.throws(()=>f.authority.issueWorkloadProof(f.ids.workload,{grant_id:r.grant_id,task_id:r.id,attempt:r.attempt,fence:r.fence,configuration_revision:1,...r.scope}));
 await f.authorize(r);assert.equal(f.records.tasks[0].readiness.execution_approved,true);const s=await f.issue(r);assert.equal(f.authority.eligible(s),true);await assert.rejects(f.authorize(r));
 const text=JSON.stringify(f.records);assert.ok(!text.includes('UNREAD_LOCAL_PASSWORD'));assert.ok(!text.includes('NEVER_SELECTED_TOKEN_VERIFIER'));assert.ok(!text.includes('work_json'));assert.equal((await f.source.registrations({user_id:f.ids.user,project_id:f.ids.project})).outputs[0].kind,'project_activity');
});

test('local disable/archive/config/grant changes deny old sessions; later repair never revives approval',async t=>{
 const f=await fixture(t);await f.source.refresh();const r=f.request();await f.authorize(r);const s=await f.issue(r);
 f.proxy.prepare('UPDATE users SET role=? WHERE id=?').run('pending',f.ids.user);await f.source.refresh();assert.equal(f.authority.eligible(s),false);assert.equal(f.records.tasks[0].status,'cancelled');f.proxy.prepare('UPDATE users SET role=? WHERE id=?').run('user',f.ids.user);await f.source.refresh();assert.equal(f.authority.eligible(s),false);
 f.proxy.prepare('UPDATE ops_projects SET archived_at=? WHERE id=?').run('now',f.ids.project);await assert.rejects(f.source.previewTask(f.request()));f.proxy.prepare('UPDATE ops_projects SET archived_at=NULL WHERE id=?').run(f.ids.project);
 f.proxy.prepare('UPDATE ops_agent_configurations SET revision=2 WHERE id=?').run(f.ids.agent);await assert.rejects(f.source.previewTask(f.request()));f.proxy.prepare('UPDATE ops_agent_configurations SET revision=1 WHERE id=?').run(f.ids.agent);
 f.grant.revoked=true;f.grant.revision++;f.put('grant',f.grant);await assert.rejects(f.source.previewTask(f.request()));await f.source.refresh();assert.equal(f.authority.eligible(s),false);
});

test('Keycloak disabled, source outage/lease expiry and restart fail closed without automatic task revival',async t=>{
 const f=await fixture(t);await f.source.refresh();const r=f.request();await f.authorize(r);const s=await f.issue(r);f.keycloak(false);await f.source.refresh();assert.equal(f.authority.eligible(s),false);f.keycloak(true);await f.source.refresh();assert.equal(f.authority.eligible(s),false);
 const r2=f.request();await f.authorize(r2);const s2=await f.issue(r2);f.outage(true);await assert.rejects(f.source.refresh());f.tick(15000);assert.equal(f.authority.eligible(s2),false);f.outage(false);await f.source.refresh();await f.restart();await f.source.refresh();assert.equal(f.authority.eligible(s2),false);assert.equal(f.records.tasks.find(t=>t.id===r2.id).status,'cancelled');await assert.rejects(f.authorize(r2));
});

test('list/view-only ceiling cannot authorize execution; no implicit private access or fallback withdrawn guide',async t=>{
 const f=await fixture(t);f.policy.ceilings[0].task_use=false;f.policy.ceilings[0].actions=['list'];f.policy.ceilings[0].grant_rights=['view'];await f.source.refresh();await assert.rejects(f.authorize(f.request()));
 f.policy.ceilings[0].task_use=true;f.policy.ceilings[0].owned_connections=false;await assert.rejects(f.authorize(f.request()));f.policy.ceilings[0].connection_ids=[f.ids.connection];
 f.proxy.prepare('INSERT INTO ops_version_withdrawals VALUES(?,?,?,?,?)').run(f.ids.project,f.ids.guide,f.ids.user,'now','withdrawn');await assert.rejects(f.authorize(f.request()));assert.equal(readLocalFacts(f.proxy).projects[0].current_guide,null);
});

test('Keycloak reader uses exact HTTPS client-credential and user-id paths and hides remote token/errors',async t=>{
 const fixture=await startOidcFixture();let server;const subject=randomUUID(),user=randomUUID(),secret='isolated-keycloak-client-secret',token='isolated-keycloak-access-token';let enabled=true,broken=false,seen=[];
 try{server=https.createServer({key:fixture.key,cert:fixture.cert},async(req,res)=>{seen.push(req.url);if(req.url==='/realms/Fractionate/protocol/openid-connect/token'){let body='';for await(const b of req)body+=b;assert.equal(new URLSearchParams(body).get('client_secret'),secret);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({access_token:token,token_type:'Bearer'}));return;}assert.equal(req.headers.authorization,'Bearer '+token);res.setHeader('Content-Type','application/json');if(broken){res.writeHead(500);res.end(token);return;}res.end(JSON.stringify({id:subject,enabled}));});await new Promise(r=>server.listen(0,'127.0.0.1',r));const issuer='https://127.0.0.1:'+server.address().port+'/realms/Fractionate',reader=createKeycloakAuthorityReader({issuer,client_id:'source-reader',client_secret:secret,ca:fixture.cert}),map=[{user_id:user,issuer,subject}];assert.equal((await reader(map)).get(user),true);enabled=false;assert.equal((await reader(map)).get(user),false);broken=true;await assert.rejects(reader(map),e=>!e.message.includes(token)&&!e.message.includes(secret));assert.ok(seen.includes('/admin/realms/Fractionate/users/'+subject));await assert.rejects(reader([{...map[0],issuer:'https://other.example/realms/Fractionate'}]));
 }finally{if(server)await new Promise(r=>server.close(r));await fixture.close();}
});

test('source durable floors reject restored stale connection policy/credential and divergent grant revisions',async t=>{
 const f=await fixture(t);await f.source.refresh();f.connection.revision=2;f.connection.policy_revision=2;f.connection.credential_version=2;f.put('connection',f.connection);await f.source.refresh();
 f.connection.revision=1;f.connection.policy_revision=1;f.connection.credential_version=1;f.put('connection',f.connection);await assert.rejects(f.source.refresh(),e=>e.code==='SOURCE_BROKER_ROLLBACK');await f.restart();await assert.rejects(f.source.refresh(),e=>e.code==='SOURCE_BROKER_ROLLBACK');
 f.connection.revision=2;f.connection.policy_revision=2;f.connection.credential_version=2;f.put('connection',f.connection);await f.source.refresh();f.grant.resources=[randomUUID()];f.put('grant',f.grant);await assert.rejects(f.source.refresh(),e=>e.code==='SOURCE_BROKER_ROLLBACK');
});

test('shared registration references produce one canonical catalogue entry and reject conflicting definitions',async t=>{
 const f=await fixture(t),second=structuredClone(f.policy.registrations[0]);second.agent_id=randomUUID();second.enabled=false;f.policy.registrations.push(second);
 const query={user_id:f.ids.user,project_id:f.ids.project};let catalogue=await f.source.registrations(query);assert.equal(catalogue.environments.length,1);assert.equal(catalogue.outputs.length,1);assert.equal(catalogue.environments[0].status,'ready');assert.equal(catalogue.outputs[0].status,'ready');
 f.policy.registrations.reverse();assert.deepEqual(await f.source.registrations(query),catalogue);
 for(const [object,key,value]of [[second.environment,'name','Conflicting name'],[second.environment,'revision',2],[second,'workload_id',randomUUID()],[second.output,'name','Conflicting output'],[second.output,'revision',2]]){const old=object[key];object[key]=value;await assert.rejects(f.source.registrations(query),e=>e.code==='CONFLICTING_SOURCE_REGISTRATION');object[key]=old;}
 f.policy.registrations.forEach(r=>r.enabled=false);catalogue=await f.source.registrations(query);assert.equal(catalogue.environments[0].status,'unavailable');assert.equal(catalogue.outputs[0].status,'unavailable');
});
