import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { operationsFixture, fixtureRouter } from './helpers/operations-fixture.js';
import { createOperationsRouter } from '../routes/operational-projects.js';
import { createOperationsStore } from '../lib/operational-projects-store.js';
import { createOperationalEvidenceStore } from '../lib/operational-evidence-store.js';
import { operationalEvidenceMigration1103 } from '../lib/operational-evidence-schema.js';
import { operationalEvidenceMigration1105 } from '../lib/operational-evidence-guide-schema.js';
import { guideHash } from '../lib/operational-projects-workflow.js';
import { csrfProtection } from '../middleware/csrf.js';

const refused=(status,fn)=>assert.throws(fn,e=>e.status===status);
const fixture=fn=>async()=>{const f=operationsFixture();try{await fn(f);}finally{f.close();}};
const guide={title:'  Exact title  ',instructions:'Exact UTF-8 α\n<script>inert</script>\n'};
function pending(f,owner,p) {
  f.seedLegacyDraft(owner,p.id,guide);
  return f.store.submit(owner,p.id,f.store.draft(owner,p.id).revision,{}).submission;
}
const count=(f,table)=>f.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;

test('editor save approves exact immutable bytes, provenance and version without a second actor or execution',fixture(f=>{
  const owner=f.addUser(),editor=f.addUser(),p=f.store.create(owner,{name:'Guide',members:[{user_id:editor.id,role:'editor'}]});
  f.seedLegacyDraft(owner,p.id,{title:'Older draft',instructions:'Older text'});
  const before=f.store.get(owner,p.id).revision;
  const result=f.store.saveDraft(editor,p.id,2,guide),v=result.version,s=result.submission;
  assert.equal(result.status,'published');assert.equal(result.revision,3);assert.equal(s.state,'approved');assert.equal(s.revision,2);
  assert.equal(v.title,guide.title);assert.equal(v.instructions,guide.instructions);assert.equal(v.content_hash,guideHash(guide.title,guide.instructions));
  assert.equal(v.approved_by,editor.id);assert.equal(v.submitted_by,editor.id);assert.equal(v.approved_at,v.submitted_at);
  assert.deepEqual(v.contributors.sort(),[owner.id,editor.id].sort());
  assert.equal(v.approved_by_name,`person-${editor.id}`);assert.equal(v.submitted_by_name,`person-${editor.id}`);
  assert.deepEqual(v.contributor_names,[...v.contributors].sort().map(id=>`person-${id}`));
  assert.equal(v.version_number,1);assert.equal(v.predecessor_id,null);assert.equal(v.base_version_id,null);
  assert.equal(f.store.draft(owner,p.id).pending_submission,null);assert.equal(f.store.draft(owner,p.id).phase,'published');
  assert.equal(f.store.get(owner,p.id).revision,before+1);assert.equal(f.store.get(owner,p.id).current_version.id,v.id);
  for(const table of ['ops_manual_runs','ops_agent_runs','ops_agent_profiles','ops_agent_credential_bindings','ops_agent_run_approvals']) assert.equal(count(f,table),0);
  assert.equal(f.store.events(owner,p.id).events.find(e=>e.action==='guide_approved').metadata.approval_method,'save');
  assert.equal(JSON.stringify(f.store.events(owner,p.id)).includes(guide.instructions),false);
  assert.throws(()=>f.db.prepare('UPDATE ops_guide_submissions SET instructions=? WHERE id=?').run('changed',s.id),/immutable/);
  assert.throws(()=>f.db.prepare('UPDATE ops_guide_versions SET content_hash=? WHERE id=?').run('changed',v.id),/immutable/);
  refused(412,()=>f.store.saveDraft(editor,p.id,2,guide));
  refused(409,()=>f.store.saveDraft(editor,p.id,3,guide));
  f.db.prepare('DELETE FROM users WHERE id=?').run(editor.id);
  assert.equal(f.store.version(owner,p.id,v.id).version.approved_by_name,'Deleted account');
  assert.equal(f.store.version(owner,p.id,v.id).version.approved_by,editor.id);
}));

test('save and pending approval keep editor/owner, current-account, membership and archive boundaries',fixture(f=>{
  const owner=f.addUser(),p=f.store.create(owner,{name:'Permissions'}),s=pending(f,owner,p);
  for(const role of ['viewer','operator','reviewer','editor']) {
    const actor=f.addUser();f.store.grant(owner,p.id,actor.id,f.store.get(owner,p.id).revision,{role});
    if(role==='editor') continue;
    refused(403,()=>f.store.saveDraft(actor,p.id,2,guide));
    refused(403,()=>f.store.approveSubmission(actor,p.id,s.id,1,{}));
  }
  const actor=f.addUser();f.store.grant(owner,p.id,actor.id,f.store.get(owner,p.id).revision,{role:'editor'});
  for(const restricted of [{...actor,enrollmentOnly:true},{...actor,linkOnly:true}]) {
    refused(403,()=>f.store.saveDraft(restricted,p.id,2,guide));
    refused(403,()=>f.store.approveSubmission(restricted,p.id,s.id,1,{}));
  }
  f.db.prepare("UPDATE users SET role='pending' WHERE id=?").run(actor.id);
  refused(403,()=>f.store.approveSubmission(actor,p.id,s.id,1,{}));
  f.db.prepare("UPDATE users SET role='user' WHERE id=?").run(actor.id);
  f.store.remove(owner,p.id,actor.id,f.store.get(owner,p.id).revision);
  refused(404,()=>f.store.approveSubmission(actor,p.id,s.id,1,{}));
  const admin=f.addUser('admin');refused(404,()=>f.store.saveDraft(admin,p.id,2,guide));
  refused(404,()=>f.store.approveSubmission(admin,p.id,s.id,1,{}));
  f.store.archive(owner,p.id,f.store.get(owner,p.id).revision,{reason:'Pause'});
  refused(409,()=>f.store.approveSubmission(owner,p.id,s.id,1,{}));
  refused(409,()=>f.store.saveDraft(owner,p.id,2,guide));
  f.store.restore(owner,p.id,f.store.get(owner,p.id).revision);
  assert.equal(f.store.approveSubmission(owner,p.id,s.id,1,{}).version.approved_by,owner.id);
}));

test('blank, missing, oversized and unknown save fields change no persisted state',fixture(f=>{
  const owner=f.addUser(),p=f.store.create(owner,{name:'Validation'});
  for(const bad of [{},{title:'Guide'},{instructions:'Steps'},{title:' ',instructions:'Steps'},{title:'Guide',instructions:'\n\t'},
    {...guide,title:'x'.repeat(201)},{...guide,instructions:'🧪'.repeat(25001)},{...guide,approved:true}]) {
    refused(400,()=>f.store.saveDraft(owner,p.id,1,bad));
    assert.equal(f.store.draft(owner,p.id).revision,1);assert.equal(f.store.get(owner,p.id).revision,1);
    assert.equal(count(f,'ops_guide_submissions'),0);assert.equal(count(f,'ops_guide_versions'),0);assert.equal(count(f,'ops_draft_contributors'),0);
  }
}));

test('any publication audit failure rolls back draft, snapshot, version, state and project revision',fixture(f=>{
  const owner=f.addUser(),p=f.store.create(owner,{name:'Atomic save'});
  for(const action of ['draft_saved','guide_submitted','guide_approved']) {
    f.db.exec(`CREATE TRIGGER fail_save BEFORE INSERT ON ops_project_events WHEN NEW.action='${action}' BEGIN SELECT RAISE(ABORT,'audit failure'); END`);
    assert.throws(()=>f.store.saveDraft(owner,p.id,1,guide),/audit failure/);
    assert.equal(f.store.draft(owner,p.id).revision,1);assert.equal(f.store.draft(owner,p.id).phase,'draft');assert.equal(f.store.draft(owner,p.id).title,'');
    assert.equal(count(f,'ops_guide_submissions'),0);assert.equal(count(f,'ops_guide_versions'),0);assert.equal(count(f,'ops_draft_contributors'),0);
    assert.equal(f.store.get(owner,p.id).revision,1);assert.equal(count(f,'ops_project_events'),1);
    f.db.exec('DROP TRIGGER fail_save');
  }
  assert.equal(f.store.saveDraft(owner,p.id,1,guide).version.version_number,1);
}));

test('pending Save and approve publishes only its actual snapshot, with no migration or duplicate publication',fixture(f=>{
  const owner=f.addUser(),editor=f.addUser(),p=f.store.create(owner,{name:'Pending',members:[{user_id:editor.id,role:'editor'}]}),s=pending(f,owner,p);
  assert.equal(count(f,'ops_guide_versions'),0);assert.equal(f.store.get(owner,p.id).current_version,null);
  // Even a mismatched mutable draft cannot replace what the explicit pending
  // action names; this models imported legacy data, not a supported draft edit.
  f.db.prepare('UPDATE ops_guide_drafts SET title=?,instructions=? WHERE project_id=?').run('Different draft','Different text',p.id);
  refused(412,()=>f.store.approveSubmission(editor,p.id,s.id,2,{}));
  refused(400,()=>f.store.approveSubmission(editor,p.id,s.id,1,{title:'Replacement'}));
  const other=f.store.create(owner,{name:'Other'});refused(404,()=>f.store.approveSubmission(owner,other.id,s.id,1,{}));
  const before=f.store.get(owner,p.id).revision;
  f.db.exec("CREATE TRIGGER fail_pending BEFORE INSERT ON ops_project_events WHEN NEW.action='guide_approved' BEGIN SELECT RAISE(ABORT,'audit failure'); END");
  assert.throws(()=>f.store.approveSubmission(editor,p.id,s.id,1,{}),/audit failure/);
  assert.equal(f.store.submission(owner,p.id,s.id).submission.state,'pending');assert.equal(count(f,'ops_guide_versions'),0);assert.equal(f.store.get(owner,p.id).revision,before);
  f.db.exec('DROP TRIGGER fail_pending');
  const result=f.store.approveSubmission(editor,p.id,s.id,1,{});
  assert.equal(result.version.submission_id,s.id);assert.equal(result.version.instructions,s.instructions);assert.equal(result.version.content_hash,s.content_hash);
  assert.equal(result.version.approved_by,editor.id);assert.equal(result.version.submitted_by,owner.id);assert.equal(result.version.submitted_at,s.submitted_at);
  assert.equal(result.revision,2);assert.equal(count(f,'ops_guide_submissions'),1);assert.equal(count(f,'ops_guide_versions'),1);
  refused(412,()=>f.store.approveSubmission(editor,p.id,s.id,1,{}));refused(409,()=>f.store.approveSubmission(editor,p.id,s.id,2,{}));
}));

test('pending integrity failure cannot approve corrupted snapshot content',fixture(f=>{
  const owner=f.addUser(),p=f.store.create(owner,{name:'Corrupt legacy import'}),s=pending(f,owner,p);
  f.db.exec('DROP TRIGGER ops_submission_content_immutable');
  f.db.prepare('UPDATE ops_guide_submissions SET content_hash=? WHERE id=?').run('0'.repeat(64),s.id);
  refused(409,()=>f.store.approveSubmission(owner,p.id,s.id,1,{}));
  assert.equal(count(f,'ops_guide_versions'),0);assert.equal(f.store.submission(owner,p.id,s.id).submission.state,'pending');
}));

test('new saved version preserves historical run/profile pins and withdrawal semantics',fixture(f=>{
  const owner=f.addUser(),p=f.store.create(owner,{name:'Pins'}),v1=f.store.saveDraft(owner,p.id,1,guide).version;
  const r=f.store.recordRun(owner,p.id,{version_id:v1.id,idempotency_key:randomUUID(),started_at:'2026-01-01T00:00:00.000Z',ended_at:'2026-01-01T01:00:00.000Z',outcome:'completed'}).run;
  const profile=f.store.createProfile(owner,p.id,f.store.get(owner,p.id).revision,{display_name:'Profile',workflow_type:'synthetic_sign_in',proposed_actions:['read'],proposed_origins:[]}).profile;
  f.store.assignProfile(owner,p.id,profile.id,1,{guide_version_id:v1.id});
  f.store.startRevision(owner,p.id,2,{version_id:v1.id,discard_draft:true});
  const v2=f.store.saveDraft(owner,p.id,3,{instructions:'Second version'}).version;
  assert.equal(v2.version_number,2);assert.equal(v2.predecessor_id,v1.id);assert.equal(v2.base_version_id,v1.id);
  assert.equal(f.store.run(owner,p.id,r.id).run.version_id,v1.id);assert.equal(f.store.version(owner,p.id,v1.id).version.instructions,guide.instructions);
  assert.equal(f.store.profile(owner,p.id,profile.id).profile.guide_version_id,v1.id);
  assert.match(f.store.profile(owner,p.id,profile.id).profile.disabled_reasons.join(' '),/no longer current/);
  f.store.withdraw(owner,p.id,v2.id,f.store.get(owner,p.id).revision,{reason:'Withdraw latest'});
  assert.equal(f.store.get(owner,p.id).current_version,null);assert.equal(f.store.run(owner,p.id,r.id).run.version_id,v1.id);
  refused(409,()=>f.store.assignProfile(owner,p.id,profile.id,2,{guide_version_id:v1.id}));
}));

test('save and pending API require If-Match and CSRF, expose approval result and use separate run approval boundary',fixture(async f=>{
  const owner=f.addUser(),p=f.store.create(owner,{name:'API'});
  let sudoCalls=0,runApprovals=0;
  const router=createOperationsRouter({Router:fixtureRouter,store:f.store,enabled:true,agentsEnabled:true,
    agentRuns:{execution:{available:true},approve(){runApprovals++;return {ok:true};}},
    requireSudo:(_q,r)=>{sudoCalls++;r.status(401).json({sudo_required:true});}});
  const send=(method,path,body={},headers={},user=owner)=>router.dispatch({method,path,originalUrl:'/api/operational-projects'+path,user,body,
    cookies:{pp_csrf:'proof'},headers:{'x-csrf-token':'proof',...headers}},[csrfProtection]);
  assert.equal((await send('PATCH',`/${p.id}/draft`,guide)).statusCode,428);
  assert.equal((await send('PATCH',`/${p.id}/draft`,guide,{'if-match':'"1"','x-csrf-token':'wrong'})).statusCode,403);
  const saved=await send('PATCH',`/${p.id}/draft`,guide,{'if-match':'"1"'});
  assert.equal(saved.statusCode,200);assert.equal(saved.headers.etag,'"2"');assert.equal(saved.headers['cache-control'],'no-store');assert.equal(saved.body.submission.state,'approved');
  assert.equal((await send('PATCH',`/${p.id}/draft`,guide,{'if-match':'"1"'})).statusCode,412);
  const q=f.store.create(owner,{name:'Pending API'}),s=pending(f,owner,q);
  assert.equal((await send('POST',`/${q.id}/submissions/${s.id}/approve`)).statusCode,428);
  assert.equal((await send('POST',`/${q.id}/submissions/${s.id}/approve`,{}, {'if-match':'"1"','x-csrf-token':'wrong'})).statusCode,403);
  const approved=await send('POST',`/${q.id}/submissions/${s.id}/approve`,{}, {'if-match':'"1"'});
  assert.equal(approved.statusCode,200);assert.equal(approved.headers.etag,'"2"');assert.equal(approved.body.version.submission_id,s.id);
  assert.equal(sudoCalls,0);assert.equal(runApprovals,0);
  assert.equal((await send('POST',`/agent-approvals/${randomUUID()}`,{})).statusCode,401);
  assert.equal(sudoCalls,1);assert.equal(runApprovals,0);
}));

function evidenceWorld(f) {
  operationalEvidenceMigration1103(f.adapter);operationalEvidenceMigration1105(f.adapter);
  let available=true;
  // D3 workflow test with the real shared-publication policy. The D2 file
  // validator is an explicit double; no media/storage validation is claimed.
  const store=createOperationsStore(f.adapter,{evidenceFactory:ctx=>{
    const metadata=createOperationalEvidenceStore({...ctx,validated:()=>true});
    return {...metadata,guideReference(id,ref){if(!available) throw new Error('File unavailable');return metadata.sharedReference(id,ref);}};
  }});
  const owner=f.addUser(),p=store.create(owner,{name:'Evidence'}),e=store.evidence;
  const d=e.create(owner,p.id,{title:'Private',purpose:'Fixture',idempotency_key:randomUUID()}).id;
  const now=new Date().toISOString(),expiry=new Date(Date.now()+86400000).toISOString();
  const raw=randomUUID(),derivative=randomUUID();
  for(const [id,kind,parent] of [[raw,'raw',null],[derivative,'derivative',raw]])
    f.db.prepare('INSERT INTO ops_evidence_objects VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,p.id,d,owner.id,kind,parent,'a'.repeat(64),'image/png',100,10,10,now,expiry,'manual');
  const dr=()=>f.db.prepare('SELECT revision FROM ops_demonstrations WHERE id=?').get(d).revision;
  const annotation=e.annotate(owner,p.id,d,dr(),{object_id:derivative,label:'Step',text:'Text',idempotency_key:randomUUID()}).id;
  const publication=e.share(owner,p.id,d,dr(),{summary:'Reviewed image',annotation_ids:[annotation],privacy_reviewed:true,idempotency_key:randomUUID()}).id;
  const ref={demonstration_id:d,revision_id:publication,item_position:0,object_id:derivative,annotation_id:annotation};
  const selection=store.replaceDraftEvidence(owner,p.id,1,{references:[ref]});
  assert.equal(selection.revision,2);assert.equal(store.draft(owner,p.id).title,'');assert.equal(store.draft(owner,p.id).instructions,'');
  assert.equal(count(f,'ops_guide_versions'),0);assert.equal(count(f,'ops_guide_submissions'),0);
  return {store,owner,p,d,e,dr,ref,unavailable:()=>{available=false;},restore:()=>{available=true;}};
}

test('save approves own selected evidence while freezing manifest and retaining restriction checks',fixture(f=>{
  const w=evidenceWorld(f),{store,owner,p,e,d,dr,ref}=w;
  const v=store.saveDraft(owner,p.id,2,guide).version;
  assert.equal(v.evidence.references.length,1);assert.equal(v.evidence.references[0].selector_id,owner.id);
  assert.equal(v.evidence.references[0].available,true);assert.match(v.evidence.manifest_hash,/^[a-f0-9]{64}$/);
  assert.throws(()=>f.db.exec('UPDATE ops_submission_evidence_refs SET publication_hash=publication_hash'),/immutable/);
  e.disposition(owner,p.id,d,dr(),{object_id:ref.object_id,action:'restrict',reason:'privacy'});
  assert.equal(store.version(owner,p.id,v.id).version.evidence.references[0].available,false);
  store.startRevision(owner,p.id,3,{version_id:v.id,discard_draft:true});
  refused(409,()=>store.replaceDraftEvidence(owner,p.id,4,{references:[ref]}));
}));

test('unavailable/disabled or restricted pending evidence cannot publish and leaves snapshot pending',fixture(f=>{
  const w=evidenceWorld(f),{store,owner,p,e,d,dr,ref}=w;
  f.seedLegacyDraft(owner,p.id,guide);
  const s=store.submit(owner,p.id,3,{}).submission;
  w.unavailable();
  assert.throws(()=>store.approveSubmission(owner,p.id,s.id,1,{}));
  const disabled=createOperationsStore(f.adapter);
  refused(409,()=>disabled.approveSubmission(owner,p.id,s.id,1,{}));
  w.restore();
  e.disposition(owner,p.id,d,dr(),{object_id:ref.object_id,action:'restrict',reason:'privacy'});
  refused(409,()=>store.approveSubmission(owner,p.id,s.id,1,{}));
  assert.equal(count(f,'ops_guide_versions'),0);assert.equal(store.submission(owner,p.id,s.id).submission.state,'pending');
}));

test('unavailable selected evidence rolls back an atomic guide save without discarding references',fixture(f=>{
  const w=evidenceWorld(f),{store,owner,p}=w,before=store.get(owner,p.id).revision;
  w.unavailable();
  assert.throws(()=>store.saveDraft(owner,p.id,2,guide));
  assert.equal(store.draft(owner,p.id).revision,2);assert.equal(store.draft(owner,p.id).title,'');
  assert.equal(store.draft(owner,p.id).evidence.references.length,1);assert.equal(store.get(owner,p.id).revision,before);
  assert.equal(count(f,'ops_guide_submissions'),0);assert.equal(count(f,'ops_guide_versions'),0);assert.equal(count(f,'ops_submission_evidence_refs'),0);
}));
