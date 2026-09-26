import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { operationsFixture, fixtureRouter } from './helpers/operations-fixture.js';
import { createOperationsRouter } from '../routes/operational-projects.js';
import { operationalAgentsMigration1106 } from '../lib/operational-agents-schema.js';
import { operationalWorkerMigration1107 } from '../lib/operational-worker-schema.js';
import { operationalAgentLimitsMigration1108 } from '../lib/operational-agent-limits-schema.js';
import { operationalProjectsMigration1100, operationalProjectsMigration1101, operationalProjectsMigration1102 } from '../lib/operational-projects-schema.js';

const actor = u => ({...u,requestId:randomUUID()});
const profile = {display_name:'Sign in',workflow_type:'synthetic_sign_in',
  proposed_actions:['navigate','click','type','read','logout'],proposed_origins:['https://example.test']};
const error = (fn,status) => assert.throws(fn,e=>e.status===status);

test('hidden projects remain private; discoverable cards are redacted and requests require owner approval',()=>{
  const f=operationsFixture();
  try {
    const owner=actor(f.addUser()),outsider=actor(f.addUser()),admin=actor(f.addUser('admin'));
    const p=f.store.create(owner,{name:'Secret',description:'Private details'});
    assert.deepEqual(f.store.directory(outsider).projects,[]);
    error(()=>f.store.request(outsider,p.id),404);
    error(()=>f.store.get(outsider,p.id),404);
    error(()=>f.store.get(admin,p.id),404);
    error(()=>f.store.visibility(owner,p.id,p.revision,{visibility:'read-only'}),400);
    const changed=f.store.visibility(owner,p.id,p.revision,{visibility:'read-only',reviewed_visibility:'Expose redacted project card'});
    assert.equal(changed.revision,2);
    const card=f.store.directory(outsider).projects[0];
    assert.deepEqual(Object.keys(card).sort(),['id','name','request_state','visibility']);
    assert.equal(JSON.stringify(card).includes('Private details'),false);
    const requested=f.store.request(outsider,p.id),repeat=f.store.request(outsider,p.id);
    assert.equal(repeat.request_id,requested.request_id);
    assert.equal(repeat.replayed,true);
    error(()=>f.store.get(outsider,p.id),404);
    error(()=>f.store.decideRequest(admin,p.id,requested.request_id,f.store.get(owner,p.id).revision,{decision:'approve',role:'editor'}),404);
    error(()=>f.store.decideRequest(owner,p.id,requested.request_id,changed.revision,{decision:'approve',role:'viewer'}),412);
    const rev=f.store.get(owner,p.id).revision;
    error(()=>f.store.decideRequest(owner,p.id,requested.request_id,rev,{decision:'approve',role:'editor'}),409);
    f.store.decideRequest(owner,p.id,requested.request_id,rev,{decision:'approve',role:'viewer'});
    assert.equal(f.store.get(outsider,p.id).own_role,'viewer');
    error(()=>f.store.decideRequest(owner,p.id,requested.request_id,rev+1,{decision:'approve',role:'editor'}),409);
    f.store.visibility(owner,p.id,f.store.get(owner,p.id).revision,{visibility:'collaborative'});
    const another=actor(f.addUser()),newRequest=f.store.request(another,p.id);
    f.store.visibility(owner,p.id,f.store.get(owner,p.id).revision,{visibility:'hidden'});
    assert.deepEqual(f.store.directory(another).projects,[]);
    error(()=>f.store.decideRequest(owner,p.id,newRequest.request_id,f.store.get(owner,p.id).revision,{decision:'approve',role:'editor'}),409);
  } finally {f.close();}
});

test('site is owner-only, HTTPS origin-only, revisioned and archived mutations fail',()=>{
  const f=operationsFixture();
  try {
    const owner=actor(f.addUser()),editor=actor(f.addUser()),viewer=actor(f.addUser());
    const p=f.store.create(owner,{name:'Site'});
    f.store.grant(owner,p.id,editor.id,1,{role:'editor'});
    f.store.grant(owner,p.id,viewer.id,2,{role:'viewer'});
    for(const value of ['http://x.test','https://x.test/path','https://x.test?x=1','https://x.test#x','https://u@x.test','https://*.test','https://x.test:bad'])
      error(()=>f.store.site(owner,p.id,3,{site_origin:value}),400);
    error(()=>f.store.site(editor,p.id,3,{site_origin:'https://example.test'}),403);
    error(()=>f.store.site(viewer,p.id,3,{site_origin:null}),403);
    const set=f.store.site(owner,p.id,3,{site_origin:'https://EXAMPLE.test:443/'});
    assert.equal(set.site_origin,'https://example.test');
    assert.equal(f.store.get(viewer,p.id).site_origin,'https://example.test');
    error(()=>f.store.site(owner,p.id,3,{site_origin:null}),412);
    const cleared=f.store.site(owner,p.id,4,{site_origin:null});
    assert.equal(cleared.site_revision,3);
    f.store.archive(owner,p.id,5,{reason:'Done'});
    error(()=>f.store.site(owner,p.id,6,{site_origin:'https://other.test'}),409);
  } finally {f.close();}
});

test('profile IDs, roles, exact guide assignment, stale revisions and account loss',()=>{
  const f=operationsFixture();
  try {
    const owner=actor(f.addUser()),editor=actor(f.addUser()),viewer=actor(f.addUser()),operator=actor(f.addUser()),reviewer=actor(f.addUser()),admin=actor(f.addUser('admin'));
    const p=f.store.create(owner,{name:'Profiles'}),other=f.store.create(admin,{name:'Other'});
    for(const [person,role] of [[editor,'editor'],[viewer,'viewer'],[operator,'operator'],[reviewer,'reviewer']])
      f.store.grant(owner,p.id,person.id,f.store.get(owner,p.id).revision,{role});
    const rev=f.store.get(owner,p.id).revision;
    error(()=>f.store.createProfile(viewer,p.id,rev,profile),403);
    error(()=>f.store.createProfile(operator,p.id,rev,profile),403);
    error(()=>f.store.createProfile(reviewer,p.id,rev,profile),403);
    error(()=>f.store.createProfile(admin,p.id,rev,profile),404);
    error(()=>f.store.createProfile(editor,p.id,rev,{...profile,proposed_origins:['http://x.test']}),400);
    error(()=>f.store.createProfile(editor,p.id,rev-1,profile),412);
    const created=f.store.createProfile(editor,p.id,rev,profile).profile;
    assert.equal(created.disabled,true);assert.equal(created.guide_version_id,null);
    assert.match(created.disabled_reasons.join(' '),/Project site is not set/);
    assert.equal(f.store.profiles(viewer,p.id).profiles.length,1);
    error(()=>f.store.profile(owner,other.id,created.id),404);
    error(()=>f.store.assignProfile(owner,p.id,created.id,2,{guide_version_id:randomUUID()}),412);
    error(()=>f.store.assignProfile(owner,p.id,created.id,1,{guide_version_id:randomUUID()}),409);
    f.store.saveDraft(editor,p.id,1,{title:'Guide',instructions:'Sign in safely'});
    const submitted=f.store.submit(editor,p.id,2,{}).submission;
    error(()=>f.store.review(editor,p.id,submitted.id,1,{decision:'approve'}),403);
    const approved=f.store.review(reviewer,p.id,submitted.id,1,{decision:'approve'}).version;
    f.store.grant(admin,other.id,reviewer.id,1,{role:'reviewer'});
    f.store.saveDraft(admin,other.id,1,{title:'Other guide',instructions:'Other project only'});
    const otherSubmission=f.store.submit(admin,other.id,2,{}).submission;
    const otherVersion=f.store.review(reviewer,other.id,otherSubmission.id,1,{decision:'approve'}).version;
    error(()=>f.store.assignProfile(owner,p.id,created.id,1,{guide_version_id:otherVersion.id}),409);
    const assigned=f.store.assignProfile(owner,p.id,created.id,1,{guide_version_id:approved.id}).profile;
    assert.equal(assigned.guide_hash,approved.content_hash);
    error(()=>f.store.updateProfile(editor,p.id,created.id,1,{display_name:'Stale'}),412);
    f.store.site(owner,p.id,f.store.get(owner,p.id).revision,{site_origin:'https://example.test'});
    assert.match(f.store.profile(viewer,p.id,created.id).profile.disabled_reasons.join(' '),/site changed/);
    f.store.assignProfile(owner,p.id,created.id,2,{guide_version_id:approved.id});
    assert.deepEqual(f.store.profile(viewer,p.id,created.id).profile.disabled_reasons,['Execution is unavailable in A2']);
    f.store.site(owner,p.id,f.store.get(owner,p.id).revision,{site_origin:null});
    f.store.site(owner,p.id,f.store.get(owner,p.id).revision,{site_origin:'https://example.test'});
    assert.match(f.store.profile(owner,p.id,created.id).profile.disabled_reasons.join(' '),/site changed/);
    f.store.withdraw(reviewer,p.id,approved.id,f.store.get(owner,p.id).revision,{reason:'Withdrawn'});
    assert.match(f.store.profile(owner,p.id,created.id).profile.disabled_reasons.join(' '),/no longer current/);
    f.db.prepare("UPDATE users SET role='pending' WHERE id=?").run(editor.id);
    error(()=>f.store.updateProfile(editor,p.id,created.id,3,{display_name:'New'}),403);
    f.db.prepare("UPDATE users SET role='user' WHERE id=?").run(editor.id);
    f.store.remove(owner,p.id,editor.id,f.store.get(owner,p.id).revision);
    error(()=>f.store.updateProfile(editor,p.id,created.id,3,{display_name:'New'}),404);
    f.db.prepare('DELETE FROM users WHERE id=?').run(viewer.id);
    error(()=>f.store.profile(viewer,p.id,created.id),401);
    f.store.archive(owner,p.id,f.store.get(owner,p.id).revision,{reason:'Done'});
    error(()=>f.store.deleteProfile(owner,p.id,created.id,3),409);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM ops_agent_runs').get().n,0);
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='ops_credential_bindings'").get().n,0);
  } finally {f.close();}
});

test('native route gate, If-Match and project-scoped endpoints',async()=>{
  const f=operationsFixture();
  try {
    const owner=actor(f.addUser()),p=f.store.create(owner,{name:'API'});
    const router=createOperationsRouter({Router:fixtureRouter,store:f.store,enabled:true,agentsEnabled:true,lookupLimiter:(_r,_s,n)=>n()});
    const request=(method,path,body={},rev)=>router.dispatch({method,path,body,user:owner,headers:rev?{'if-match':`"${rev}"`}:{}});
    assert.equal((await request('POST',`/${p.id}/agent-profiles`,profile)).statusCode,428);
    assert.deepEqual(f.db.prepare('SELECT action,status FROM ops_agent_denials').all().map(r=>[r.action,r.status]),[['profile_create',428]]);
    const created=await request('POST',`/${p.id}/agent-profiles`,profile,1);
    assert.equal(created.statusCode,201);
    assert.equal(created.body.profile.disabled,true);
    assert.equal((await request('GET',`/${p.id}/agent-profiles/${created.body.profile.id}`)).statusCode,200);
    assert.equal((await request('GET','/directory')).statusCode,200);
    const off=createOperationsRouter({Router:fixtureRouter,store:f.store,enabled:true,agentsEnabled:false,lookupLimiter:(_r,_s,n)=>n()});
    assert.equal((await off.dispatch({method:'GET',path:'/directory',user:owner})).statusCode,404);
  } finally {f.close();}
});

test('project run limits default unbounded, are owner controlled, revisioned and audited',async()=>{
  const f=operationsFixture();
  try {
    const owner=actor(f.addUser()),editor=actor(f.addUser());
    const p=f.store.create(owner,{name:'Limits'});
    f.store.grant(owner,p.id,editor.id,p.revision,{role:'editor'});
    let current=f.store.get(owner,p.id);
    assert.deepEqual(current.agent_limits,{});
    assert.equal(current.agent_limits_revision,1);
    const limits={cpu:2,memory_mib:4096,temporary_disk_mib:8192,
      max_seconds:3600,max_actions:200,max_tokens:200000,max_usd:25};
    error(()=>f.store.agentLimits(editor,p.id,current.revision,{limits}),403);
    error(()=>f.store.agentLimits(owner,p.id,current.revision,{limits:{max_actions:0}}),400);
    error(()=>f.store.agentLimits(owner,p.id,current.revision,{limits:{unknown:1}}),400);
    const saved=f.store.agentLimits(owner,p.id,current.revision,{limits});
    assert.equal(saved.limits_revision,2);
    assert.deepEqual(f.store.get(editor,p.id).agent_limits,limits);
    error(()=>f.store.agentLimits(owner,p.id,current.revision,{limits:{}}),412);
    current=f.store.get(owner,p.id);
    f.db.exec("CREATE TRIGGER deny_agent_limit_audit BEFORE INSERT ON ops_project_events WHEN NEW.action='agent_limits_changed' BEGIN SELECT RAISE(ABORT,'audit unavailable'); END;");
    assert.throws(()=>f.store.agentLimits(owner,p.id,current.revision,{limits:{}}));
    assert.deepEqual(f.store.get(owner,p.id).agent_limits,limits);
    f.db.exec('DROP TRIGGER deny_agent_limit_audit');
    const router=createOperationsRouter({Router:fixtureRouter,store:f.store,enabled:true,agentsEnabled:true,lookupLimiter:(_r,_s,n)=>n()});
    const request=(user,body,rev)=>router.dispatch({method:'PUT',path:`/${p.id}/agent-limits`,body,user,headers:rev?{'if-match':`"${rev}"`}:{}});
    assert.equal((await request(owner,{limits:{}},null)).statusCode,428);
    assert.equal((await request(editor,{limits:{}},current.revision)).statusCode,403);
    assert.equal((await request(owner,{limits:{}},current.revision)).statusCode,200);
    current=f.store.get(owner,p.id);
    assert.deepEqual(current.agent_limits,{});
    assert.equal(current.agent_limits_revision,3);
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM ops_project_events WHERE project_id=? AND action='agent_limits_changed'").get(p.id).n,2);
  } finally {f.close();}
});

test('additive migration leaves existing project and older-writer fields intact',()=>{
  const f=operationsFixture();
  try {
    const owner=actor(f.addUser()),p=f.store.create(owner,{name:'Old writer'});
    assert.equal(f.store.get(owner,p.id).visibility,'hidden');
    assert.equal(f.store.get(owner,p.id).site_origin,null);
    // An older writer's legacy name/description update retains the new columns.
    f.db.prepare('UPDATE ops_projects SET name=?,description=? WHERE id=?').run('Legacy changed','Text',p.id);
    assert.equal(f.store.get(owner,p.id).visibility,'hidden');
    assert.equal(f.store.get(owner,p.id).site_revision,1);
    assert.equal(typeof operationalAgentsMigration1106,'function');
  } finally {f.close();}
});

test('1106 upgrades populated legacy tables and older writer cannot erase A2 columns',()=>{
  const db=new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys=ON');
    for(const migration of [operationalProjectsMigration1100,operationalProjectsMigration1101,operationalProjectsMigration1102])migration(db);
    const id=randomUUID(),owner=randomUUID(),time=new Date().toISOString();
    db.prepare('INSERT INTO ops_projects(id,name,owner_user_id,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(id,'Before A2',owner,owner,time,time);
    operationalAgentsMigration1106(db);
    let row=db.prepare('SELECT * FROM ops_projects WHERE id=?').get(id);
    assert.equal(row.visibility,'hidden');assert.equal(row.site_origin,null);
    db.prepare('UPDATE ops_projects SET site_origin=?,site_revision=site_revision+1 WHERE id=?').run('https://example.test',id);
    db.prepare('UPDATE ops_projects SET name=?,description=? WHERE id=?').run('Older writer','Legacy edit',id);
    row=db.prepare('SELECT * FROM ops_projects WHERE id=?').get(id);
    assert.equal(row.site_origin,'https://example.test');assert.equal(row.site_revision,2);
  } finally {db.close();}
});

test('1108 migrates populated run history and child references without restoring mock caps',()=>{
  const db=new DatabaseSync(':memory:');
  try {
    db.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE ops_projects(id TEXT PRIMARY KEY);
      CREATE TABLE ops_agent_profiles(project_id TEXT,id TEXT,PRIMARY KEY(project_id,id));
      CREATE TABLE ops_guide_versions(project_id TEXT,id TEXT,PRIMARY KEY(project_id,id));`);
    operationalWorkerMigration1107(db);
    const project=randomUUID(),profileId=randomUUID(),guide=randomUUID(),run=randomUUID(),attempt=randomUUID();
    db.prepare('INSERT INTO ops_projects(id) VALUES(?)').run(project);
    db.prepare('INSERT INTO ops_agent_profiles(project_id,id) VALUES(?,?)').run(project,profileId);
    db.prepare('INSERT INTO ops_guide_versions(project_id,id) VALUES(?,?)').run(project,guide);
    db.prepare(`INSERT INTO ops_agent_runs(id,project_id,profile_id,profile_revision,site_origin,site_revision,
      guide_version_id,guide_hash,policy_digest,max_seconds,max_actions,state,started_at,deadline_at,updated_at)
      VALUES(?,?,?,1,'https://demo.fractionate.ai',1,?,?,?,300,20,'blocked',?,?,?)`)
      .run(run,project,profileId,guide,'a'.repeat(64),'b'.repeat(64),
        '2026-09-25T00:00:00Z','2026-09-25T00:05:00Z','2026-09-25T00:05:00Z');
    db.prepare(`INSERT INTO ops_agent_worker_attempts(id,run_id,attempt_no,fence,state,lease_expires_at,workspace_id,created_at)
      VALUES(?,?,1,1,'lost',?,?,?)`).run(attempt,run,'2026-09-25T00:01:00Z',randomUUID(),'2026-09-25T00:00:00Z');
    db.prepare('INSERT INTO ops_agent_worker_events(run_id,attempt_id,kind,created_at) VALUES(?,?,?,?)')
      .run(run,attempt,'recovery_fenced','2026-09-25T00:05:00Z');
    db.exec('PRAGMA foreign_keys=OFF');
    operationalAgentLimitsMigration1108(db);
    db.exec('PRAGMA foreign_keys=ON');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
    // Legacy runs had profile-local caps, so they cannot be reinterpreted as
    // the new project's initially unbounded policy.
    assert.equal(db.prepare('SELECT project_limits_revision AS n FROM ops_agent_runs WHERE id=?').get(run).n,0);
    assert.equal(db.prepare('SELECT run_id FROM ops_agent_worker_attempts WHERE id=?').get(attempt).run_id,run);
    assert.equal(db.prepare('SELECT run_id FROM ops_agent_worker_events WHERE attempt_id=?').get(attempt).run_id,run);
    assert.deepEqual(JSON.parse(db.prepare('SELECT agent_limits_json AS json FROM ops_projects WHERE id=?').get(project).json),{});
    assert.throws(()=>db.prepare('UPDATE ops_agent_runs SET max_actions=200 WHERE id=?').run(run));
    assert.throws(()=>db.prepare('DELETE FROM ops_agent_runs WHERE id=?').run(run));
  } finally {db.close();}
});

test('audit failure rolls back profile and site writes',()=>{
  const f=operationsFixture();
  try {
    const owner=actor(f.addUser()),p=f.store.create(owner,{name:'Audit'});
    f.db.exec("CREATE TRIGGER deny_a2_audit BEFORE INSERT ON ops_project_events WHEN NEW.action IN ('profile_created','site_origin_changed') BEGIN SELECT RAISE(ABORT,'audit unavailable'); END;");
    assert.throws(()=>f.store.createProfile(owner,p.id,1,profile));
    assert.equal(f.store.profiles(owner,p.id).profiles.length,0);
    assert.throws(()=>f.store.site(owner,p.id,1,{site_origin:'https://example.test'}));
    assert.equal(f.store.get(owner,p.id).site_origin,null);
    assert.equal(f.store.get(owner,p.id).revision,1);
  } finally {f.close();}
});

test('a newer approved guide disables an older assignment until explicitly reassigned',()=>{
  const f=operationsFixture();
  try {
    const owner=actor(f.addUser()),reviewer=actor(f.addUser()),p=f.store.create(owner,{name:'Versions'});
    f.store.grant(owner,p.id,reviewer.id,1,{role:'reviewer'});
    const created=f.store.createProfile(owner,p.id,2,profile).profile;
    f.store.saveDraft(owner,p.id,1,{title:'One',instructions:'First'});
    const firstSubmission=f.store.submit(owner,p.id,2,{}).submission;
    const first=f.store.review(reviewer,p.id,firstSubmission.id,1,{decision:'approve'}).version;
    f.store.assignProfile(owner,p.id,created.id,1,{guide_version_id:first.id});
    f.store.startRevision(owner,p.id,2,{version_id:first.id,discard_draft:true});
    f.store.saveDraft(owner,p.id,3,{instructions:'Second'});
    const secondSubmission=f.store.submit(owner,p.id,4,{}).submission;
    const second=f.store.review(reviewer,p.id,secondSubmission.id,1,{decision:'approve'}).version;
    assert.notEqual(second.id,first.id);
    assert.match(f.store.profile(owner,p.id,created.id).profile.disabled_reasons.join(' '),/no longer current/);
    const reassigned=f.store.assignProfile(owner,p.id,created.id,2,{guide_version_id:second.id}).profile;
    assert.equal(reassigned.guide_hash,second.content_hash);
  } finally {f.close();}
});
