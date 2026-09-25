import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { operationsFixture } from './helpers/operations-fixture.js';
import { guideHash } from '../lib/operational-projects-workflow.js';

const refused=(code,fn)=>assert.throws(fn,e=>e.status===code);
const fixture=fn=>()=>{const f=operationsFixture();try{fn(f);}finally{f.close();}};
function setup(f) {
  const owner=f.addUser(),reviewer=f.addUser(),operator=f.addUser(),p=f.store.create(owner,{name:'Human work'});
  const pr=()=>f.store.get(owner,p.id).revision;
  f.store.grant(owner,p.id,reviewer.id,pr(),{role:'reviewer'});
  f.store.grant(owner,p.id,operator.id,pr(),{role:'operator'});
  const draft=()=>f.store.draft(owner,p.id);
  const submit=()=>f.store.submit(owner,p.id,draft().revision,{}).submission;
  const publish=()=>{const s=submit();return f.store.review(reviewer,p.id,s.id,s.revision,{decision:'approve'}).version;};
  f.store.saveDraft(owner,p.id,1,{title:'Guide',instructions:'Exact bytes\nα <script>inert</script>\n'});
  return {owner,reviewer,operator,p,pr,draft,submit,publish};
}
const runInput=version=>({version_id:version.id,idempotency_key:randomUUID(),started_at:'2026-01-01T00:00:00.000Z',ended_at:'2026-01-01T01:00:00.000Z',outcome:'completed',notes:'Human report'});

test('independent review, exact snapshot, publication locking and new iteration provenance',fixture(f=>{
  const {owner,reviewer,p,pr,draft,submit}=setup(f),s=submit();
  refused(409,()=>f.store.saveDraft(owner,p.id,draft().revision,{title:'Mutate pending'}));
  refused(403,()=>f.store.review(owner,p.id,s.id,1,{decision:'approve'}));
  const v=f.store.review(reviewer,p.id,s.id,1,{decision:'approve'}).version;
  assert.equal(v.instructions,'Exact bytes\nα <script>inert</script>\n');
  assert.equal(v.content_hash,guideHash(v.title,v.instructions));
  assert.deepEqual(v.contributors,[owner.id]);
  refused(412,()=>f.store.review(reviewer,p.id,s.id,1,{decision:'approve'}));
  refused(409,()=>f.store.saveDraft(owner,p.id,draft().revision,{title:'No implicit revision'}));
  f.store.startRevision(owner,p.id,draft().revision,{version_id:v.id,discard_draft:true});
  assert.deepEqual(draft().contributors,[]);assert.equal(draft().base_version_id,v.id);
  f.store.saveDraft(owner,p.id,draft().revision,{instructions:'Version two'});
  const s2=submit(),v2=f.store.review(reviewer,p.id,s2.id,1,{decision:'approve'}).version;
  assert.equal(v2.version_number,2);assert.equal(v2.predecessor_id,v.id);
  assert.equal(v2.base_version_id,v.id);
  f.store.update(owner,p.id,pr(),{name:'Rename'});
  assert.equal(f.store.version(owner,p.id,v.id).version.instructions,v.instructions);
}));

test('contributors cannot approve after transfer/removal; pending or revoked reviewer loses authority',fixture(f=>{
  const {owner,reviewer,p,pr,submit}=setup(f);
  f.store.grant(owner,p.id,reviewer.id,pr(),{role:'editor'});
  f.store.saveDraft(reviewer,p.id,2,{title:'Contributed'});
  f.store.grant(owner,p.id,reviewer.id,pr(),{role:'reviewer'});
  const s=submit();refused(403,()=>f.store.review(reviewer,p.id,s.id,1,{decision:'approve'}));
  const independent=f.addUser();f.store.grant(owner,p.id,independent.id,pr(),{role:'reviewer'});
  f.db.prepare("UPDATE users SET role='pending' WHERE id=?").run(independent.id);
  refused(403,()=>f.store.review(independent,p.id,s.id,1,{decision:'approve'}));
  f.db.prepare("UPDATE users SET role='user' WHERE id=?").run(independent.id);
  f.store.remove(owner,p.id,independent.id,pr());
  refused(404,()=>f.store.review(independent,p.id,s.id,1,{decision:'approve'}));
}));

test('changes requested/cancel resume editing; archive blocks decisions and stale submissions',fixture(f=>{
  const {owner,reviewer,p,pr,draft,submit}=setup(f);let s=submit();
  refused(400,()=>f.store.review(reviewer,p.id,s.id,1,{decision:'changes_requested'}));
  f.store.review(reviewer,p.id,s.id,1,{decision:'changes_requested',reason:'Clarify step two'});
  f.store.saveDraft(owner,p.id,draft().revision,{instructions:'Clearer'});s=submit();
  f.store.archive(owner,p.id,pr(),{reason:'Pause'});
  refused(409,()=>f.store.review(reviewer,p.id,s.id,1,{decision:'approve'}));
  f.store.restore(owner,p.id,pr());
  f.store.cancelSubmission(owner,p.id,s.id,1,{reason:'Need another edit'});
  refused(412,()=>f.store.review(reviewer,p.id,s.id,1,{decision:'approve'}));
  f.store.saveDraft(owner,p.id,draft().revision,{title:'Resumed'});
}));

test('approval audit failure rolls back version, decision and published lock',fixture(f=>{
  const {owner,reviewer,p,pr,draft,submit}=setup(f),s=submit(),revision=pr();
  f.db.exec("CREATE TRIGGER fail_approval BEFORE INSERT ON ops_project_events WHEN NEW.action='guide_approved' BEGIN SELECT RAISE(ABORT,'fixture'); END");
  assert.throws(()=>f.store.review(reviewer,p.id,s.id,1,{decision:'approve'}),/fixture/);
  assert.equal(f.store.versions(owner,p.id).versions.length,0);
  assert.equal(f.store.submission(owner,p.id,s.id).submission.state,'pending');
  assert.equal(draft().phase,'draft');assert.equal(pr(),revision);
}));

test('database forbids history mutation, terminal re-review and cross-project references',fixture(f=>{
  const {owner,p,publish}=setup(f),v=publish(),other=f.store.create(owner,{name:'Other'});
  for(const table of ['ops_guide_submissions','ops_guide_versions']) assert.throws(()=>f.db.exec(`DELETE FROM ${table}`),/immutable/);
  assert.throws(()=>f.db.prepare('UPDATE ops_guide_submissions SET title=? WHERE id=?').run('tamper',v.submission_id),/immutable/);
  assert.throws(()=>f.db.prepare("UPDATE ops_guide_submissions SET state='cancelled' WHERE id=?").run(v.submission_id),/immutable/);
  assert.throws(()=>f.db.prepare('UPDATE ops_guide_versions SET content_hash=? WHERE id=?').run('bad',v.id),/immutable/);
  assert.throws(()=>f.db.prepare('UPDATE ops_guide_state SET base_version_id=? WHERE project_id=?').run(v.id,other.id),/FOREIGN KEY/);
  refused(404,()=>f.store.version(owner,other.id,v.id));
  refused(404,()=>f.store.submission(owner,other.id,v.submission_id));
  assert.equal(f.store.get(owner,p.id).current_version.id,v.id);
}));

test('manual records pin versions, retry safely and retain withdrawal history',fixture(f=>{
  const {owner,reviewer,operator,p,pr,draft,publish}=setup(f),v1=publish(),input=runInput(v1);
  const r=f.store.recordRun(operator,p.id,input).run;
  assert.equal(f.store.recordRun(operator,p.id,input).run.id,r.id);
  refused(409,()=>f.store.recordRun(operator,p.id,{...input,notes:'changed'}));
  f.store.startRevision(owner,p.id,draft().revision,{version_id:v1.id,discard_draft:true});
  const v2=publish();
  refused(409,()=>f.store.recordRun(operator,p.id,runInput(v1)));
  assert.equal(f.store.run(owner,p.id,r.id).run.version_id,v1.id);
  f.store.withdraw(reviewer,p.id,v2.id,pr(),{reason:'Unsafe step'});
  assert.equal(f.store.get(owner,p.id).current_version,null);
  refused(409,()=>f.store.recordRun(operator,p.id,runInput(v2)));
  assert.equal(f.store.version(owner,p.id,v2.id).version.withdrawal_reason,'Unsafe step');
  assert.equal(f.store.versions(owner,p.id).current_version_id,null);
}));

test('corrections preserve original recorder/version and form one append-only chain',fixture(f=>{
  const {owner,operator,reviewer,p,pr,publish}=setup(f),v=publish(),r=f.store.recordRun(operator,p.id,runInput(v)).run;
  f.store.withdraw(reviewer,p.id,v.id,pr(),{reason:'Withdraw'});
  const {version_id,...input}=runInput(v);input.reason='Correct reported outcome';input.outcome='blocked';
  refused(403,()=>f.store.correctRun(owner,p.id,r.id,input));
  const c=f.store.correctRun(operator,p.id,r.id,input).run;
  assert.equal(c.version_id,v.id);assert.equal(c.corrects_run_id,r.id);
  assert.equal(f.store.correctRun(operator,p.id,r.id,input).run.id,c.id);
  refused(409,()=>f.store.correctRun(operator,p.id,r.id,{...input,idempotency_key:randomUUID()}));
  const c2=f.store.correctRun(operator,p.id,c.id,{...input,idempotency_key:randomUUID()}).run;
  assert.equal(c2.corrects_run_id,c.id);assert.equal(f.store.run(owner,p.id,r.id).run.outcome,'completed');
  assert.throws(()=>f.db.exec("UPDATE ops_manual_runs SET notes='tamper'"),/immutable/);
  assert.throws(()=>f.db.exec('DELETE FROM ops_manual_runs'),/immutable/);
  f.store.archive(owner,p.id,pr(),{reason:'Close'});
  refused(409,()=>f.store.correctRun(operator,p.id,c2.id,{...input,idempotency_key:randomUUID()}));
}));

test('run validation, scope, permissions and rollback reject invalid records',fixture(f=>{
  const {owner,operator,p,pr,publish}=setup(f),v=publish(),viewer=f.addUser();
  f.store.grant(owner,p.id,viewer.id,pr(),{role:'viewer'});
  refused(403,()=>f.store.recordRun(viewer,p.id,runInput(v)));
  refused(400,()=>f.store.recordRun(operator,p.id,{...runInput(v),started_at:'2026-01-02T00:00:00Z'}));
  refused(400,()=>f.store.recordRun(operator,p.id,{...runInput(v),ended_at:'9999-01-01T00:00:00Z'}));
  refused(400,()=>f.store.recordRun(operator,p.id,{...runInput(v),worker:'forbidden'}));
  const other=f.store.create(owner,{name:'Other'});
  refused(409,()=>f.store.recordRun(owner,other.id,runInput(v)));
  f.db.exec("CREATE TRIGGER fail_run BEFORE INSERT ON ops_project_events WHEN NEW.action='run_recorded' BEGIN SELECT RAISE(ABORT,'fixture'); END");
  assert.throws(()=>f.store.recordRun(operator,p.id,runInput(v)),/fixture/);
  assert.equal(f.store.runs(owner,p.id).runs.length,0);
}));
