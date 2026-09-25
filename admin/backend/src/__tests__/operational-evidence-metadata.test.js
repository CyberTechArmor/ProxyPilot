import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { operationsFixture } from './helpers/operations-fixture.js';
import { createOperationsStore } from '../lib/operational-projects-store.js';
import { createOperationalEvidenceStore } from '../lib/operational-evidence-store.js';
import { operationalEvidenceMigration1103 } from '../lib/operational-evidence-schema.js';

function fixture(t) {
  const f=operationsFixture(); t.after(()=>f.close());
  operationalEvidenceMigration1103(f.adapter);
  let time=Date.now();
  const now=()=>new Date(time).toISOString();
  const store=createOperationsStore(f.adapter,{now,evidenceFactory:ctx=>createOperationalEvidenceStore({...ctx,validated:()=>true})});
  const owner=f.addUser(), author=f.addUser(), viewer=f.addUser(), reviewer=f.addUser(), editor=f.addUser();
  const p=store.create(owner,{name:'Evidence operation'}).id;
  const rev=()=>store.get(owner,p).revision;
  for (const [u,role] of [[author,'operator'],[viewer,'viewer'],[reviewer,'reviewer'],[editor,'editor']]) store.grant(owner,p,u.id,rev(),{role});
  const e=store.evidence;
  const create=(u=author,project=p)=>e.create(u,project,{title:'Private title',purpose:'Private purpose',idempotency_key:randomUUID()}).id;
  const d=create();
  const dr=(id=d)=>f.db.prepare('SELECT revision FROM ops_demonstrations WHERE id=?').get(id).revision;
  // Internal metadata fixtures, never a client-facing validation interface.
  const object=(kind='raw',parent=null,demo=d,project=p,u=author)=>{
    const id=randomUUID();
    f.db.prepare('INSERT INTO ops_evidence_objects VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id,project,demo,u.id,kind,parent,'a'.repeat(64),'image/png',100,10,10,now(),new Date(time+7*86400000).toISOString(),'manual');
    return id;
  };
  const raw=object(), derivative=object('derivative',raw);
  const annotate=(oid=derivative,u=author)=>e.annotate(u,p,d,dr(),{object_id:oid,label:'Step one',text:'Text alternative',idempotency_key:randomUUID()}).id;
  const share=(aid=annotate())=>e.share(author,p,d,dr(),{summary:'Reviewed summary',annotation_ids:[aid],privacy_reviewed:true,idempotency_key:randomUUID()}).id;
  return {...f,store,e,owner,author,viewer,reviewer,editor,p,d,dr,rev,create,object,raw,derivative,annotate,share,
    advance:ms=>{time+=ms;}};
}
const denied=(fn,status)=>assert.throws(fn,e=>e.status===status);

test('metadata fixture image counts and derivative parent rules are enforced in SQLite',t=>{
  const f=fixture(t);
  f.object('derivative',f.raw); f.object('derivative',f.raw);
  assert.throws(()=>f.object('derivative',f.raw),/limit/);
  assert.throws(()=>f.object('derivative',f.derivative),/parent/);
  for (let i=1;i<20;i++) f.object();
  assert.throws(()=>f.object(),/limit/);
});

test('share audit rollback leaves no sealed revision, items or receipt; published versions stay exact',t=>{
  const f=fixture(t), aid=f.annotate(), before=f.dr();
  f.db.exec("CREATE TRIGGER share_audit_failure BEFORE INSERT ON ops_project_events WHEN NEW.action='evidence_shared' BEGIN SELECT RAISE(ABORT,'audit failure'); END;");
  assert.throws(()=>f.share(aid),/audit failure/);
  for (const table of ['ops_demonstration_revisions','ops_demonstration_revision_items','ops_demonstration_revision_payloads']) {
    assert.equal(f.db.prepare(`SELECT count(*) n FROM ${table}`).get().n,0);
  }
  assert.equal(f.dr(),before);
  f.db.exec('DROP TRIGGER share_audit_failure');
  const rid=f.share(aid), first=JSON.stringify(f.e.get(f.viewer,f.p,f.d).revisions.find(r=>r.id===rid));
  f.share(f.annotate());
  assert.equal(JSON.stringify(f.e.get(f.viewer,f.p,f.d).revisions.find(r=>r.id===rid)),first);
  f.e.disposition(f.owner,f.p,f.d,f.dr(),{revision_id:rid,action:'restrict',reason:'privacy'});
  const revisions=f.e.get(f.viewer,f.p,f.d).revisions;
  assert.equal(revisions.find(r=>r.id===rid).available,false);
  assert.equal(revisions.filter(r=>r.available).length,1);
});

test('private originals stay author-only; shared views expose exact derivatives without private metadata',t=>{
  const f=fixture(t);
  for (const u of [f.owner,f.editor,f.reviewer,f.viewer]) {
    denied(()=>f.e.get(u,f.p,f.d),404);
    denied(()=>f.e.object(u,f.p,f.d,f.raw),404);
    denied(()=>f.e.object(u,f.p,f.d,f.derivative),404);
    assert.equal(f.e.list(u,f.p).demonstrations.length,0);
  }
  const aid=f.annotate(), rid=f.share(aid);
  for (const u of [f.owner,f.editor,f.reviewer,f.viewer]) {
    const view=f.e.get(u,f.p,f.d);
    assert.equal(view.title,undefined); assert.equal(view.purpose,undefined);
    assert.equal(view.revisions[0].id,rid);
    assert.equal(view.revisions[0].items[0].annotation_id,aid);
    assert.equal(f.e.object(u,f.p,f.d,f.derivative).available,true);
    assert.equal(JSON.stringify(view).includes(f.raw),false);
    denied(()=>f.e.object(u,f.p,f.d,f.raw),404);
  }
});

test('every role can author except viewers; owners cannot annotate another author’s evidence',t=>{
  const f=fixture(t);
  for (const u of [f.owner,f.author,f.editor,f.reviewer]) assert.ok(f.create(u));
  denied(()=>f.create(f.viewer),403);
  for (const u of [f.owner,f.editor,f.reviewer,f.viewer]) denied(()=>f.annotate(f.derivative,u),403);
  f.store.grant(f.owner,f.p,f.author.id,f.rev(),{role:'viewer'});
  assert.equal(f.e.object(f.author,f.p,f.d,f.raw).available,true);
  denied(()=>f.annotate(),403);
});

test('current membership, eligible account, session restrictions and no admin bypass',t=>{
  const f=fixture(t), admin=f.addUser('admin');
  denied(()=>f.e.get(admin,f.p,f.d),404);
  for (const role of ['pending','suspended']) {
    f.db.prepare('UPDATE users SET role=? WHERE id=?').run(role,f.author.id);
    denied(()=>f.e.object(f.author,f.p,f.d,f.raw),403);
  }
  f.db.prepare("UPDATE users SET role='user' WHERE id=?").run(f.author.id);
  for (const flags of [{enrollmentOnly:true},{linkOnly:true}]) denied(()=>f.e.get({...f.author,...flags},f.p,f.d),403);
  f.store.remove(f.owner,f.p,f.author.id,f.rev());
  denied(()=>f.e.get(f.author,f.p,f.d),404);
  f.db.prepare('DELETE FROM users WHERE id=?').run(f.author.id);
  denied(()=>f.e.get(f.author,f.p,f.d),401);
  assert.equal(f.db.prepare('SELECT uploader_id FROM ops_evidence_objects WHERE id=?').get(f.raw).uploader_id,f.author.id);
});

test('deleted owner leaves surviving roles intact and no ownership recovery',t=>{
  const f=fixture(t); f.db.prepare('DELETE FROM users WHERE id=?').run(f.owner.id);
  f.annotate(); assert.ok(f.create(f.editor));
  denied(()=>f.e.hold(f.editor,f.p,f.d,f.dr(),{object_id:f.raw,held:true,reason:'retention'}),403);
  denied(()=>f.e.get(f.owner,f.p,f.d),401);
});

test('archive freezes all metadata mutations, including restrictions and holds; reads survive',t=>{
  const f=fixture(t); const aid=f.annotate(); f.share(aid);
  f.store.archive(f.owner,f.p,f.rev(),{reason:'pause'});
  for (const fn of [()=>f.create(),()=>f.annotate(),()=>f.share(aid),
    ()=>f.e.update(f.author,f.p,f.d,f.dr(),{title:'Changed',purpose:''}),
    ()=>f.e.archive(f.owner,f.p,f.d,f.dr()),
    ()=>f.e.disposition(f.owner,f.p,f.d,f.dr(),{object_id:f.raw,action:'restrict',reason:'privacy'}),
    ()=>f.e.hold(f.owner,f.p,f.d,f.dr(),{object_id:f.raw,held:true,reason:'retention'})]) denied(fn,409);
  assert.ok(f.e.get(f.viewer,f.p,f.d));
  f.store.restore(f.owner,f.p,f.rev()); f.annotate();
});

test('owner restriction/deletion needs no raw access, withholds dependent text, retains immutable identity',t=>{
  const f=fixture(t); const rid=f.share();
  denied(()=>f.e.object(f.owner,f.p,f.d,f.raw),404);
  f.e.disposition(f.owner,f.p,f.d,f.dr(),{object_id:f.derivative,action:'delete_requested',reason:'privacy'});
  const r=f.e.get(f.viewer,f.p,f.d).revisions[0];
  assert.equal(r.id,rid); assert.equal(r.summary,null); assert.equal(r.items[0].annotation,null);
  assert.equal(r.available,false); assert.equal(f.e.object(f.author,f.p,f.d,f.derivative).available,false);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM ops_evidence_objects').get().n,2);
  assert.ok(f.db.prepare('SELECT delete_after FROM ops_evidence_dispositions').get().delete_after);
});

test('fixed expiry, owner holds, release and restriction are separate from erasure',t=>{
  const f=fixture(t);
  denied(()=>f.e.hold(f.author,f.p,f.d,f.dr(),{object_id:f.raw,held:true,reason:'retention'}),403);
  f.e.hold(f.owner,f.p,f.d,f.dr(),{object_id:f.raw,held:true,reason:'retention'});
  f.advance(8*86400000);
  assert.equal(f.e.object(f.author,f.p,f.d,f.raw).available,true);
  assert.equal(f.e.object(f.author,f.p,f.d,f.derivative).available,false);
  f.e.hold(f.owner,f.p,f.d,f.dr(),{object_id:f.raw,held:false,reason:'retention'});
  assert.equal(f.e.object(f.author,f.p,f.d,f.raw).available,false);
  denied(()=>f.e.hold(f.owner,f.p,f.d,f.dr(),{object_id:f.raw,held:true,reason:'retention'}),409);
});

test('shared candidates survive expiry; raw-bound annotations and unreviewed sharing refused',t=>{
  const f=fixture(t); const rawAnnotation=f.annotate(f.raw);
  denied(()=>f.share(rawAnnotation),409);
  denied(()=>f.e.share(f.author,f.p,f.d,f.dr(),{summary:'',annotation_ids:[rawAnnotation],privacy_reviewed:false,idempotency_key:randomUUID()}),400);
  f.share(); f.advance(8*86400000);
  assert.equal(f.e.object(f.viewer,f.p,f.d,f.derivative).available,true);
  assert.equal(f.e.object(f.author,f.p,f.d,f.raw).available,false);
});

test('strict validation, correction chain and provenance remain immutable',t=>{
  const f=fixture(t), aid=f.annotate();
  for (const extra of [{validated:true},{rectangle:{x:0.9,y:0,width:0.2,height:1}},{text:''}]) {
    denied(()=>f.e.annotate(f.author,f.p,f.d,f.dr(),{object_id:f.derivative,label:'Step',text:'Alt',idempotency_key:randomUUID(),...extra}),400);
  }
  const correction={object_id:f.derivative,predecessor_id:aid,label:'Corrected',text:'New description',idempotency_key:randomUUID()};
  f.e.annotate(f.author,f.p,f.d,f.dr(),correction);
  denied(()=>f.e.annotate(f.author,f.p,f.d,f.dr(),{...correction,idempotency_key:randomUUID()}),409);
  const rid=f.share(aid);
  const before=f.db.prepare('SELECT * FROM ops_demonstration_revisions WHERE id=?').get(rid);
  assert.deepEqual(JSON.parse(before.provenance_json),[f.author.id]);
  f.e.update(f.author,f.p,f.d,f.dr(),{title:'New private title',purpose:'new'});
  assert.deepEqual(f.db.prepare('SELECT * FROM ops_demonstration_revisions WHERE id=?').get(rid),before);
});

test('idempotent retry rechecks permission, rejects changed payload, and revisions reject concurrent stale writes',t=>{
  const f=fixture(t), expected=f.dr();
  const v={object_id:f.derivative,label:'Step',text:'Alt',idempotency_key:randomUUID()};
  const result=f.e.annotate(f.author,f.p,f.d,expected,v);
  assert.deepEqual(f.e.annotate(f.author,f.p,f.d,expected,v),result);
  denied(()=>f.e.annotate(f.author,f.p,f.d,expected,{...v,text:'Different'}),409);
  denied(()=>f.e.annotate(f.author,f.p,f.d,expected,{...v,idempotency_key:randomUUID()}),412);
  denied(()=>f.e.update(f.author,f.p,f.d,null,{title:'x',purpose:''}),428);
  f.store.remove(f.owner,f.p,f.author.id,f.rev());
  denied(()=>f.e.annotate(f.author,f.p,f.d,expected,v),404);
});

test('every successful mutation invalidates ownership offers and emits no secret-bearing text',t=>{
  const f=fixture(t);
  const offer=f.store.offer(f.owner,f.p,f.rev(),{target_user_id:f.editor.id}).offer;
  const before=f.dr();
  f.e.update(f.author,f.p,f.d,before,{title:'SECRET TITLE',purpose:'SECRET PURPOSE'});
  assert.equal(f.dr(),before+1);
  denied(()=>f.store.decideOffer(f.editor,f.p,offer.id,f.rev(),{decision:'accept'}),409);
  assert.equal(JSON.stringify(f.store.events(f.owner,f.p,{limit:'100'})).includes('SECRET'),false);
});

test('audit failure rolls back rows, receipts, demo and project revisions atomically',t=>{
  const f=fixture(t), before=f.dr(), projectRev=f.rev();
  f.db.exec("CREATE TRIGGER evidence_audit_failure BEFORE INSERT ON ops_project_events WHEN NEW.action LIKE 'evidence_%' BEGIN SELECT RAISE(ABORT,'audit failure'); END;");
  assert.throws(()=>f.annotate(),/audit failure/);
  assert.equal(f.dr(),before); assert.equal(f.rev(),projectRev);
  assert.equal(f.db.prepare('SELECT count(*) n FROM ops_evidence_annotations').get().n,0);
  assert.equal(f.db.prepare("SELECT count(*) n FROM ops_evidence_receipts WHERE action='annotated'").get().n,0);
});

test('same-project child scopes and cross-project SQL foreign keys refuse mismatches',t=>{
  const f=fixture(t), other=f.store.create(f.author,{name:'Other'}).id, demo=f.create(f.author,other);
  const raw=f.object('raw',null,demo,other);
  denied(()=>f.e.object(f.author,f.p,f.d,raw),404);
  denied(()=>f.e.get(f.author,f.p,demo),404);
  denied(()=>f.e.annotate(f.author,f.p,f.d,f.dr(),{object_id:raw,label:'x',text:'x',idempotency_key:randomUUID()}),404);
  denied(()=>f.e.disposition(f.owner,f.p,f.d,f.dr(),{object_id:raw,action:'restrict',reason:'privacy'}),404);
  denied(()=>f.e.hold(f.owner,f.p,f.d,f.dr(),{object_id:raw,held:true,reason:'retention'}),404);
  assert.throws(()=>f.object('derivative',raw),/FOREIGN KEY/);
  assert.throws(()=>f.db.prepare('INSERT INTO ops_evidence_annotations VALUES (?,?,?,?,?,?,?,?)').run(randomUUID(),f.p,f.d,raw,null,f.author.id,new Date().toISOString(),'hash'),/FOREIGN KEY/);
  assert.throws(()=>f.db.prepare('INSERT INTO ops_evidence_dispositions VALUES (?,?,?,?,?,?,?,?,?,?)').run(randomUUID(),f.p,f.d,raw,null,f.author.id,new Date().toISOString(),'restrict','privacy',null),/FOREIGN KEY/);
});

test('database seals identities and published item membership, permits only private payload erasure',t=>{
  const f=fixture(t), aid=f.annotate(), rid=f.share(aid);
  f.e.hold(f.owner,f.p,f.d,f.dr(),{object_id:f.raw,held:true,reason:'retention'});
  f.e.disposition(f.owner,f.p,f.d,f.dr(),{object_id:f.raw,action:'restrict',reason:'privacy'});
  for (const table of ['ops_evidence_objects','ops_evidence_annotations','ops_demonstration_revisions',
    'ops_demonstration_revision_items','ops_evidence_dispositions','ops_evidence_holds','ops_evidence_receipts']) {
    assert.throws(()=>f.db.exec(`DELETE FROM ${table}`),/immutable/);
    const column=table==='ops_evidence_receipts' || table==='ops_demonstration_revision_items' ? 'project_id' : 'id';
    assert.throws(()=>f.db.exec(`UPDATE ${table} SET ${column}=${column}`),/immutable/);
  }
  assert.throws(()=>f.db.prepare('INSERT INTO ops_demonstration_revision_items VALUES (?,?,?,?,?,?)').run(f.p,f.d,rid,1,f.derivative,aid),/sealed/);
  assert.throws(()=>f.db.exec("UPDATE ops_demonstrations SET created_by='other',revision=revision+1"),/immutable/);
  assert.throws(()=>f.db.exec('DELETE FROM ops_demonstrations'),/immutable/);
  assert.throws(()=>f.db.exec("UPDATE ops_evidence_annotation_payloads SET text='changed'"),/Append/);
  assert.throws(()=>f.db.prepare('DELETE FROM ops_evidence_annotation_payloads WHERE annotation_id=?').run(aid),/Restrict/);
  f.e.disposition(f.owner,f.p,f.d,f.dr(),{object_id:f.derivative,action:'restrict',reason:'privacy'});
  f.db.prepare('DELETE FROM ops_evidence_annotation_payloads WHERE annotation_id=?').run(aid);
  assert.throws(()=>f.db.prepare('INSERT INTO ops_evidence_annotation_payloads VALUES (?,?,?,?)').run(aid,'new','new',null),/restored/);
  assert.equal(f.e.get(f.viewer,f.p,f.d).revisions[0].items[0].annotation,null);
  assert.equal(f.db.prepare('SELECT id FROM ops_evidence_annotations WHERE id=?').get(aid).id,aid);
});
