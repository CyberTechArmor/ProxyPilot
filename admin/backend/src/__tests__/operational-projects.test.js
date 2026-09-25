import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { operationsFixture, fixtureRouter } from './helpers/operations-fixture.js';
import { assertOperation, operationsEnabled, revision } from '../lib/operational-projects-logic.js';
import { createOperationsRouter } from '../routes/operational-projects.js';
import { csrfProtection } from '../middleware/csrf.js';

const refused = (status, fn) => assert.throws(fn, e => e.status === status);
function withFixture(fn) {
  return async () => { const f = operationsFixture(); try { await fn(f); } finally { f.close(); } };
}
const rev = (f, owner, id) => f.store.get(owner,id).revision;
const add = (f, owner, p, member, role) => f.store.grant(owner,p.id,member.id,rev(f,owner,p.id),{role});

test('create private record/draft; filter lists before pagination; admin does not bypass access', withFixture(f => {
  const a=f.addUser(), b=f.addUser(), admin=f.addUser('admin');
  const p=f.store.create(a,{name:'  Onboarding  '}), hidden=f.store.create(b,{name:'Private'});
  assert.equal(p.name,'Onboarding');
  assert.equal(f.store.draft(a,p.id).status,'draft');
  assert.deepEqual(f.store.list(a).projects.map(p=>p.id),[p.id]);
  assert.equal(f.store.list(admin).projects.length,0);
  for(const actor of [b,admin]) {
    refused(404,()=>f.store.get(actor,p.id));
    refused(404,()=>f.store.draft(actor,p.id));
    refused(404,()=>f.store.update(actor,p.id,1,{name:'Stolen'}));
    refused(404,()=>f.store.events(actor,p.id));
  }
  add(f,a,p,b,'viewer');
  const first=f.store.list(b,{limit:'1'});
  assert.equal(first.projects.length,1);
  const second=f.store.list(b,{limit:'1',after:first.next_cursor});
  assert.equal(new Set([...first.projects,...second.projects].map(p=>p.id)).size,2);
  assert.deepEqual([...first.projects,...second.projects].map(row=>row.id).sort(),[p.id,hidden.id].sort());
}));

test('role matrix separates editing, ownership and read-only roles', withFixture(f => {
  const owner=f.addUser(), p=f.store.create(owner,{name:'Roles'});
  for(const role of ['viewer','operator','editor','reviewer']) {
    const member=f.addUser(); add(f,owner,p,member,role);
    assert.equal(f.store.get(member,p.id).own_role,role);
    refused(403,()=>f.store.roster(member,p.id));
    refused(403,()=>f.store.grant(member,p.id,f.addUser().id,rev(f,owner,p.id),{role:'editor'}));
    refused(403,()=>f.store.archive(member,p.id,rev(f,owner,p.id),{reason:'No'}));
    if(role==='editor') f.store.saveDraft(member,p.id,1,{instructions:'Human instructions'});
    else refused(403,()=>f.store.saveDraft(member,p.id,1,{instructions:'No'}));
  }
  for(const role of ['viewer','operator','editor','reviewer','owner']) {
    assert.doesNotThrow(()=>assertOperation(role,'read',true));
    if(role!=='owner') refused(403,()=>assertOperation(role,'offer',false));
  }
  refused(409,()=>f.store.remove(owner,p.id,owner.id,rev(f,owner,p.id)));
}));

test('current pending/deleted account state wins over old JWT role and grant', withFixture(f => {
  const owner=f.addUser(), member=f.addUser(), pending=f.addUser('pending');
  const p=f.store.create(owner,{name:'Access'}); add(f,owner,p,member,'editor');
  refused(400,()=>f.store.grant(owner,p.id,pending.id,rev(f,owner,p.id),{role:'viewer'}));
  refused(404,()=>f.store.candidate(owner,p.id,{identifier:pending.id}));
  f.db.prepare("UPDATE users SET role='pending' WHERE id=?").run(member.id);
  for(const fn of [()=>f.store.get(member,p.id),()=>f.store.list(member),()=>f.store.create(member,{name:'No'}),()=>f.store.saveDraft(member,p.id,1,{title:'No'})]) refused(403,fn);
  f.db.prepare("UPDATE users SET role='user' WHERE id=?").run(member.id);
  assert.equal(f.store.get(member,p.id).own_role,'editor');
  refused(403,()=>f.store.list({...member,enrollmentOnly:true}));
  refused(403,()=>f.store.list({...member,linkOnly:true}));
  f.db.prepare('DELETE FROM users WHERE id=?').run(owner.id);
  assert.equal(f.store.get(member,p.id).owner_name,'Deleted account');
  refused(401,()=>f.store.get(owner,p.id));
  refused(403,()=>f.store.roster(member,p.id));
  assert.equal(f.db.prepare('SELECT count(*) n FROM ops_project_events').get().n,2);
}));

test('draft/project optimistic concurrency and contributor provenance; strict bounded input', withFixture(f => {
  const a=f.addUser(), b=f.addUser(), p=f.store.create(a,{name:'Draft'}); add(f,a,p,b,'editor');
  const stale=rev(f,a,p.id);
  f.store.saveDraft(a,p.id,1,{title:'Draft',instructions:'Retained text'});
  refused(412,()=>f.store.saveDraft(b,p.id,1,{instructions:'Overwrite'}));
  refused(412,()=>f.store.update(a,p.id,stale,{name:'Outdated'}));
  f.store.saveDraft(b,p.id,2,{instructions:'Second iteration'});
  f.store.remove(a,p.id,b.id,rev(f,a,p.id));
  assert.deepEqual(f.store.draft(a,p.id).contributors.sort(),[a.id,b.id].sort());
  refused(400,()=>f.store.saveDraft(a,p.id,3,{instructions:'x'.repeat(100001)}));
  refused(400,()=>f.store.saveDraft(a,p.id,3,{instructions:'🧪'.repeat(25001)}));
  refused(400,()=>f.store.create(a,{name:'X',container:'forbidden'}));
  refused(400,()=>f.store.update(a,p.id,rev(f,a,p.id),{owner_user_id:b.id}));
  refused(400,()=>f.store.saveDraft(a,p.id,3,{instructions:'x',approved:true}));
  refused(428,()=>revision(undefined)); refused(400,()=>revision('*'));
  assert.equal(revision('"3"'),3);
  assert.equal(f.store.draft(a,p.id).instructions,'Second iteration');
}));

test('archive freezes mutations, allows revocation/leave/read/restore, and preserves drafts', withFixture(f => {
  const a=f.addUser(), b=f.addUser(), c=f.addUser(), p=f.store.create(a,{name:'Archive'});
  add(f,a,p,b,'editor'); add(f,a,p,c,'viewer');
  f.store.saveDraft(a,p.id,1,{instructions:'Retain me'});
  f.store.archive(a,p.id,rev(f,a,p.id),{reason:'Finished for now'});
  assert.equal(f.store.list(a).projects.length,0);
  assert.equal(f.store.list(a,{state:'archived'}).projects.length,1);
  for(const fn of [()=>f.store.update(a,p.id,rev(f,a,p.id),{name:'No'}),()=>f.store.saveDraft(b,p.id,2,{title:'No'}),()=>f.store.grant(a,p.id,f.addUser().id,rev(f,a,p.id),{role:'viewer'}),()=>f.store.offer(a,p.id,rev(f,a,p.id),{target_user_id:b.id})]) refused(409,fn);
  f.store.remove(c,p.id,c.id,rev(f,a,p.id));
  f.store.remove(a,p.id,b.id,rev(f,a,p.id));
  f.store.restore(a,p.id,rev(f,a,p.id));
  assert.equal(f.store.draft(a,p.id).instructions,'Retain me');
  refused(404,()=>f.store.get(b,p.id));
}));

test('ownership needs target acceptance, expires, and stale grants/archive/offers cannot transfer', withFixture(f => {
  const a=f.addUser(), b=f.addUser(), other=f.addUser(), p=f.store.create(a,{name:'Transfer'});
  add(f,a,p,b,'viewer'); add(f,a,p,other,'editor');
  const offer=()=>f.store.offer(a,p.id,rev(f,a,p.id),{target_user_id:b.id}).offer;
  let o=offer();
  refused(403,()=>f.store.decideOffer(other,p.id,o.id,rev(f,a,p.id),{decision:'accept'}));
  refused(403,()=>f.store.decideOffer(a,p.id,o.id,rev(f,a,p.id),{decision:'accept'}));
  f.advance(86400001);
  refused(409,()=>f.store.decideOffer(b,p.id,o.id,rev(f,a,p.id),{decision:'accept'}));
  o=offer(); add(f,a,p,b,'editor');
  refused(409,()=>f.store.decideOffer(b,p.id,o.id,rev(f,a,p.id),{decision:'accept'}));
  o=offer(); f.store.archive(a,p.id,rev(f,a,p.id),{reason:'Freeze'}); f.store.restore(a,p.id,rev(f,a,p.id));
  refused(409,()=>f.store.decideOffer(b,p.id,o.id,rev(f,a,p.id),{decision:'accept'}));
  o=offer(); const replacement=offer();
  refused(409,()=>f.store.decideOffer(b,p.id,o.id,rev(f,a,p.id),{decision:'accept'}));
  f.store.decideOffer(b,p.id,replacement.id,rev(f,a,p.id),{decision:'accept'});
  assert.equal(f.store.get(b,p.id).own_role,'owner');
  assert.equal(f.store.get(a,p.id).own_role,'editor');
  refused(409,()=>f.store.decideOffer(b,p.id,replacement.id,rev(f,b,p.id),{decision:'accept'}));
}));

test('ownership refusal on removed/pending/deleted target and explicit cancel/decline', withFixture(f => {
  const a=f.addUser(), b=f.addUser(), p=f.store.create(a,{name:'Offers'}); add(f,a,p,b,'viewer');
  const offer=()=>f.store.offer(a,p.id,rev(f,a,p.id),{target_user_id:b.id}).offer;
  let o=offer(); f.store.decideOffer(b,p.id,o.id,rev(f,a,p.id),{decision:'decline'});
  assert.equal(f.store.get(a,p.id).ownership_offer,null);
  o=offer(); f.store.decideOffer(a,p.id,o.id,rev(f,a,p.id),{decision:'cancel'});
  assert.equal(f.store.get(a,p.id).ownership_offer,null);
  o=offer(); f.db.prepare("UPDATE users SET role='pending' WHERE id=?").run(b.id);
  refused(403,()=>f.store.decideOffer(b,p.id,o.id,rev(f,a,p.id),{decision:'accept'}));
  f.db.prepare("UPDATE users SET role='user' WHERE id=?").run(b.id);
  f.store.remove(a,p.id,b.id,rev(f,a,p.id));
  refused(404,()=>f.store.decideOffer(b,p.id,o.id,rev(f,a,p.id),{decision:'accept'}));
  add(f,a,p,b,'viewer'); o=offer(); f.db.prepare('DELETE FROM users WHERE id=?').run(b.id);
  refused(401,()=>f.store.decideOffer(b,p.id,o.id,rev(f,a,p.id),{decision:'accept'}));
}));

test('audit insertion failure atomically rolls back create and save; audit append-only and redacted', withFixture(f => {
  const a=f.addUser(), b=f.addUser(), p=f.store.create(a,{name:'Audit'}); add(f,a,p,b,'viewer');
  f.db.exec("CREATE TRIGGER fixture_audit_failure BEFORE INSERT ON ops_project_events BEGIN SELECT RAISE(ABORT,'fixture'); END");
  assert.throws(()=>f.store.create(a,{name:'Rolled back'}),/fixture/);
  assert.equal(f.store.list(a).projects.length,1);
  assert.throws(()=>f.store.saveDraft(a,p.id,1,{instructions:'Private content'}),/fixture/);
  assert.equal(f.store.draft(a,p.id).revision,1);
  assert.equal(f.store.draft(a,p.id).contributors.length,0);
  assert.equal(rev(f,a,p.id),2);
  f.db.exec('DROP TRIGGER fixture_audit_failure');
  f.store.saveDraft(a,p.id,1,{instructions:'Private content'});
  assert.equal(JSON.stringify(f.store.events(a,p.id)).includes('Private content'),false);
  const grantEvent=f.store.events(b,p.id).events.find(e=>e.action==='member_set');
  assert.equal(grantEvent.subject_id,null); assert.deepEqual(grantEvent.metadata,{});
  assert.throws(()=>f.db.exec('DELETE FROM ops_project_events'),/immutable/);
  assert.throws(()=>f.db.exec("UPDATE ops_project_events SET action='forged'"),/immutable/);
}));

test('schema replay, account deletion, child constraints and existing data survive additive migration', withFixture(f => {
  const a=f.addUser(), p=f.store.create(a,{name:'Keep'});
  f.migrate();
  assert.equal(f.db.prepare('SELECT count(*) n FROM schema_migrations WHERE version=1100').get().n,1);
  assert.throws(()=>f.db.prepare('INSERT INTO ops_guide_drafts(project_id,updated_by,updated_at) VALUES(?,?,?)').run(randomUUID(),a.id,'now'),/FOREIGN KEY/);
  assert.throws(()=>f.db.prepare('DELETE FROM ops_projects WHERE id=?').run(p.id),/FOREIGN KEY/);
  f.db.prepare('DELETE FROM users WHERE id=?').run(a.id);
  assert.equal(f.db.prepare('SELECT count(*) n FROM ops_projects').get().n,1);
  assert.equal(f.db.prepare('SELECT name FROM mock2_projects').get().name,'Existing Dev Studio');
  assert.equal(f.db.prepare('SELECT value FROM app_settings').get().value,'Existing custom name');
  assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(),[]);
}));

test('registered handlers enforce feature gate, revisions, strict body and existing CSRF middleware', withFixture(async f => {
  const a=f.addUser();
  const make=enabled=>createOperationsRouter({Router:fixtureRouter,store:enabled?f.store:null,enabled,lookupLimiter:(_r,_s,n)=>n()});
  const request=(router,method,path,body,extra={})=>router.dispatch({method,path,originalUrl:'/api/operational-projects'+path,user:a,body,
    cookies:{pp_csrf:'fixture'},headers:{'x-csrf-token':'fixture'},...extra},[csrfProtection]);
  assert.equal(operationsEnabled({}),false);
  assert.equal(operationsEnabled({OPERATIONS_ENABLED:'1'}),false);
  assert.equal(operationsEnabled({OPERATIONS_ENABLED:'true'}),true);
  const off=make(false);
  assert.equal((await request(off,'GET','/capabilities')).body.enabled,false);
  assert.equal((await request(off,'POST','/',{name:'No'})).statusCode,404);
  const on=make(true);
  assert.equal((await request(on,'POST','/',{name:'No'},{headers:{}})).statusCode,403);
  const created=await request(on,'POST','/',{name:'Via API'});
  assert.equal(created.statusCode,201); assert.equal(created.headers.etag,'"1"');
  assert.equal(created.headers['cache-control'],'no-store');
  const id=created.body.project.id;
  assert.equal((await request(on,'PATCH',`/${id}`,{name:'No'})).statusCode,428);
  assert.equal((await request(on,'PATCH',`/${id}`,{name:'New'},{headers:{'x-csrf-token':'fixture','if-match':'"1"'}})).statusCode,200);
  assert.equal((await request(on,'PATCH',`/${id}`,{name:'Stale'},{headers:{'x-csrf-token':'fixture','if-match':'"1"'}})).statusCode,412);
  assert.equal((await request(on,'GET',`/${id}`,undefined,{user:f.addUser('admin')})).statusCode,404);
  assert.equal((await request(on,'DELETE',`/${id}`)).statusCode,404);
  assert.equal((await request(on,'POST',`/${id}/runs`,{})).statusCode,400);
  assert.equal((await request(on,'GET','/',undefined,{user:undefined})).statusCode,401);
  assert.equal((await request(on,'POST','/',{name:'bad',worker:'no'})).statusCode,400);
}));

test('exact account lookup is owner-only and rejects pending targets and unknown inputs', withFixture(f => {
  const a=f.addUser(), b=f.addUser(), pending=f.addUser('pending'), p=f.store.create(a,{name:'Access'});
  add(f,a,p,b,'editor');
  assert.equal(f.store.candidate(a,p.id,{identifier:b.id}).user_id,b.id);
  const username=f.db.prepare('SELECT username FROM users WHERE id=?').get(b.id).username;
  assert.equal(f.store.candidate(a,p.id,{identifier:username}).user_id,b.id);
  refused(403,()=>f.store.candidate(b,p.id,{identifier:a.id}));
  refused(404,()=>f.store.candidate(a,p.id,{identifier:pending.id}));
  refused(400,()=>f.store.grant(a,p.id,pending.id,rev(f,a,p.id),{role:'viewer'}));
  refused(400,()=>f.store.candidate(a,p.id,{identifier:b.id,search:'*'}));
  refused(404,()=>f.store.candidate(a,p.id,{identifier:username.slice(0,-1)}));
}));

test('failed ownership audit restores owner, membership, offer and revision atomically', withFixture(f => {
  const a=f.addUser(), b=f.addUser(), p=f.store.create(a,{name:'Atomic transfer'}); add(f,a,p,b,'viewer');
  const offered=f.store.offer(a,p.id,rev(f,a,p.id),{target_user_id:b.id});
  f.db.exec("CREATE TRIGGER fixture_transfer_failure BEFORE INSERT ON ops_project_events WHEN NEW.action='ownership_accept' BEGIN SELECT RAISE(ABORT,'fixture transfer'); END");
  assert.throws(()=>f.store.decideOffer(b,p.id,offered.offer.id,offered.revision,{decision:'accept'}),/fixture transfer/);
  assert.equal(f.store.get(a,p.id).own_role,'owner');
  assert.equal(f.store.get(b,p.id).own_role,'viewer');
  assert.equal(rev(f,a,p.id),offered.revision);
  assert.equal(f.store.get(a,p.id).ownership_offer.id,offered.offer.id);
}));

test('composition preserves authoritative auth/CSRF and new modules have no runtime imports', () => {
  const source=readFileSync(new URL('../index.js',import.meta.url),'utf8');
  assert.match(source,/app\.use\('\/api\/operational-projects', authenticateToken, blockPendingRole/);
  assert.ok(source.indexOf("app.use('/api/', csrfProtection)")<source.indexOf("app.use('/api/operational-projects', authenticateToken"));
  assert.ok(source.indexOf("res.set('Cache-Control','no-store')")<source.indexOf("app.use('/api/', csrfProtection)"));
  const csrf=readFileSync(new URL('../middleware/csrf.js',import.meta.url),'utf8');
  assert.equal(csrf.includes('operational-projects'),false);
  for(const name of ['operational-projects-store.js','operational-projects-logic.js','operational-projects-schema.js','operational-projects-workflow.js',
    'operational-evidence-guide.js','operational-evidence-guide-schema.js','operational-evidence-logic.js']) {
    const content=readFileSync(new URL('../lib/'+name,import.meta.url),'utf8');
    const imports=[...content.matchAll(/(?:from\s+|import\s*\()(['"])([^'"]+)\1/g)].map(m=>m[2]);
    assert.ok(imports.every(i=>['node:crypto','zod','./operational-projects-logic.js','./operational-projects-workflow.js',
      './operational-evidence-guide.js','./operational-evidence-logic.js'].includes(i)),imports.join(','));
  }
});
