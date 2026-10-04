import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { deflateSync, inflateSync } from 'node:zlib';
import { operationalBrowserArtifactsMigration1119 } from '../lib/operational-browser-artifacts-schema.js';
import { createBrowserArtifactsStore, BROWSER_ASSET_REVIEW_STATEMENT, BROWSER_ARTIFACT_REVIEW_STATEMENT } from '../lib/operational-browser-artifacts-store.js';
import { createBrowserArtifactFiles, browserArtifactByteHash } from '../lib/operational-browser-artifacts-files.js';
import { createBrowserArtifactsService, verifyBrowserArtifactMedia } from '../lib/operational-browser-artifacts-service.js';
import { createBrowserArtifactPdfDecoder } from '../lib/operational-browser-artifacts-pdf-decoder.js';
import { createBrowserArtifactImageRedactor } from '../lib/operational-browser-artifacts-image-decoder.js';
import { fail } from '../lib/operational-projects-logic.js';

const draft = JSON.parse(fs.readFileSync(new URL('../../../../contracts/browser-agent/fixtures/general-agent.draft.json',import.meta.url),'utf8'));
const rejected = (fn,status) => assert.throws(fn,e=>e.status===status);
const rejects = (p,status) => assert.rejects(p,e=>e.status===status);
const metadata = (bytes,mime_type='text/plain',extra={}) => ({idempotency_key:randomUUID(),byte_count:bytes.length,mime_type,
  sha256:browserArtifactByteHash(bytes),...extra});
const ref = a => ({id:a.id,sha256:a.sha256,mime_type:a.mime_type,byte_count:a.byte_count});
const assetReview = {decision:'approve',reviewed_statement:BROWSER_ASSET_REVIEW_STATEMENT};
const releaseReview = purpose => ({purpose,decision:'approve',reviewed_statement:BROWSER_ARTIFACT_REVIEW_STATEMENT});

function fixture(options={}) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON; CREATE TABLE ops_projects(id TEXT PRIMARY KEY); CREATE TABLE audit(actor TEXT,project TEXT,action TEXT,subject TEXT,metadata TEXT);');
  operationalBrowserArtifactsMigration1119(db);
  const owner = {id:randomUUID()}, viewer={id:randomUUID()}, outsider={id:randomUUID()}, project=randomUUID(),otherProject=randomUUID();
  db.prepare('INSERT INTO ops_projects VALUES(?)').run(project); db.prepare('INSERT INTO ops_projects VALUES(?)').run(otherProject);
  let clock=Date.now(), role='owner',active=true,archived=false,runState='active',manualAuth=false,modelConsent=false,fence=1,inputApproval=false,retainedInputApproval=false;
  const configuration=structuredClone(draft), scope={project_id:project,run_id:randomUUID(),attempt_id:randomUUID(),fence:1};
  const access = (actor,p,action='read') => {
    if (!active && actor.id===owner.id) fail(403,'Account unavailable');
    if (![project,otherProject].includes(p) || actor.id===outsider.id || (actor.id===owner.id && role===null)) fail(404,'Operational record not found');
    const r=actor.id===viewer.id?'viewer':role;
    if (action!=='read' && r==='viewer') fail(403,'Insufficient operational access');
    if (archived && action!=='read') fail(409,'Project archived');
    return {p:{id:p,archived_at:archived?'archived':null},role:r};
  };
  const authorizeAttempt = (actor,s,intent) => {
    access(actor,s.project_id,intent==='artifact_read'?'read':'run');
    if (s.project_id!==project || s.run_id!==scope.run_id || s.attempt_id!==scope.attempt_id || s.fence!==fence) fail(409,'Attempt fence changed');
    if (intent!=='artifact_read' && !(intent==='artifact_transform'&&runState==='completed') && !['active','paused'].includes(runState)) fail(409,'Attempt closed');
    return {configuration,manual_auth:manualAuth,model_consent:modelConsent};
  };
  const tx=fn=> {
    db.exec('BEGIN IMMEDIATE');
    try { const v=fn();db.exec('COMMIT');return v; }
    catch(e) {db.exec('ROLLBACK');throw e;}
  };
  const store=createBrowserArtifactsStore({one:(sql,...args)=>db.prepare(sql).get(...args),all:(sql,...args)=>db.prepare(sql).all(...args),
    run:(sql,...args)=>db.prepare(sql).run(...args),tx,access,authorizeAttempt,verifyInputApproval:()=>inputApproval,verifyRetainedInputApproval:()=>retainedInputApproval,
    verifyObservationOrigin:options.verifyObservationOrigin,now:()=>new Date(clock).toISOString(),uuid:randomUUID,
    event:(actor,p,action,subject,metadata)=>db.prepare('INSERT INTO audit VALUES(?,?,?,?,?)').run(actor.id,p,action,subject,JSON.stringify(metadata))},options);
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pp-browser-files-')); fs.chmodSync(root,0o700);
  const files=createBrowserArtifactFiles(root),service=createBrowserArtifactsService({store,files});
  return {db,owner,viewer,outsider,project,otherProject,scope,configuration,store,files,service,root,
    advance(ms){clock+=ms;},revoke(){role=null;},restore(){role='owner';active=true;archived=false;runState='active';},
    deactivate(){active=false;},archive(){archived=true;},cancel(){runState='cancelled';store.cancelAttempt(scope);},
    terminal(){runState='completed';},manual(v=true){manualAuth=v;},consent(v=true){modelConsent=v;},newFence(){fence++;},
    inputApprove(v=true){inputApproval=v;},
    retainedInputApprove(v=true){retainedInputApproval=v;},
    close(){files.close();fs.rmSync(root,{recursive:true,force:true});db.close();}};
}

test('private asset staging preserves exact pins and refuses unknown authority/path fields',async()=> {
  const f=fixture();
  try {
    const bytes=Buffer.from('private task notes'),m=metadata(bytes);
    for (const extra of [{path:'/etc/passwd'},{headers:{Authorization:'secret'}},{credential:'secret'}])
      rejected(()=>f.store.reserveAsset(f.owner,f.project,{...m,...extra}),400);
    const a=await f.service.asset(f.owner,f.project,m,[bytes]);
    assert.equal(a.state,'staged');assert.equal(a.available,true);assert.deepEqual(ref(a),{id:a.id,sha256:m.sha256,mime_type:m.mime_type,byte_count:m.byte_count});
    assert.deepEqual(await f.service.asset(f.owner,f.project,m,[bytes]),a);
    rejected(()=>f.store.reserveAsset(f.owner,f.project,{...m,sha256:'a'.repeat(64)}),409);
    assert.ok(!JSON.stringify(f.db.prepare('SELECT * FROM audit').all()).includes('private task notes'));
    assert.throws(()=>f.db.prepare("UPDATE ops_browser_artifacts SET sha256=? WHERE id=?").run('a'.repeat(64),a.id));
    assert.throws(()=>f.db.prepare('DELETE FROM ops_browser_artifacts WHERE id=?').run(a.id));
  } finally {f.close();}
});

test('exact durable retry cannot report successful staging after mid-body cancellation',async()=> {
  const f=fixture();
  try {
    const bytes=Buffer.from('immutable retry body'),m=metadata(bytes),a=await f.service.asset(f.owner,f.project,m,[bytes]);
    await rejects(f.service.asset(f.owner,f.project,m,{async *[Symbol.asyncIterator](){
      yield bytes.subarray(0,5);f.store.cancel(f.owner,f.project,a.id);yield bytes.subarray(5);
    }}),410);
    assert.equal(f.store.asset(f.owner,f.project,a.id).state,'cancelled');
  } finally {f.close();}
});

test('discard revokes exact source use immediately and preserves pins while reporting deferred physical cleanup',async()=> {
  const f=fixture();
  try {
    const bytes=Buffer.from('Private retained original'),a=await f.service.asset(f.owner,f.project,metadata(bytes),[bytes]);
    f.store.reviewAsset(f.owner,f.project,a.id,assetReview);
    f.store.reviewAssetModel(f.owner,f.project,a.id,{decision:'approve',reviewed_statement:BROWSER_ARTIFACT_REVIEW_STATEMENT});
    const l=f.store.openAssetRead(f.owner,f.project,a.id,'model');
    rejected(()=>f.store.cancel(f.viewer,f.project,a.id),403);
    rejected(()=>f.store.cancel(f.outsider,f.project,a.id),404);
    rejected(()=>f.store.cancel(f.owner,f.otherProject,a.id),404);
    const discarded=f.store.cancel(f.owner,f.project,a.id);
    assert.equal(discarded.available,false);assert.equal(discarded.availability_reason,'cancelled');
    assert.equal(discarded.retention.cleanup_pending,true);assert.equal(discarded.retention.recorded_file_state,'sealed');
    assert.equal(discarded.retention.charged_bytes,bytes.length);assert.equal(discarded.retention.deletion,null);
    assert.equal(discarded.provenance.created_by,f.owner.id);assert.equal(discarded.created_at,a.created_at);
    assert.deepEqual(ref(discarded),ref(a));assert.ok(fs.existsSync(path.join(f.root,`${a.id}.blob`)));
    rejected(()=>f.store.checkRead(f.owner,l),410);
    await rejects(f.service.resolveSourceAsset(f.owner,f.project,ref(a),{approved_for_model:true}),410);
    assert.equal(f.service.maintenance({apply:true}).results[0].outcome,'deleted');
    const deleted=f.store.asset(f.owner,f.project,a.id);
    assert.equal(deleted.availability_reason,'deleted');assert.equal(deleted.retention.cleanup_pending,false);
    assert.equal(deleted.retention.charged_bytes,0);assert.equal(deleted.retention.deletion.outcome,'deleted');
    assert.ok(deleted.retention.deletion.completed_at);assert.deepEqual(ref(deleted),ref(a));assert.equal(deleted.reviews.length,2);
    assert.equal(fs.existsSync(path.join(f.root,`${a.id}.blob`)),false);
    assert.equal(f.store.cancel(f.owner,f.project,a.id).retention.deletion.outcome,'deleted');
    f.revoke();rejected(()=>f.store.asset(f.owner,f.project,a.id),404);
  } finally {f.close();}
});

test('retention receipts distinguish interrupted intake, expiry pending cleanup and missing-object tombstones',async()=> {
  const f=fixture();
  try {
    const bytes=Buffer.from('never finalized'),a=f.store.reserveAsset(f.owner,f.project,metadata(bytes));
    assert.equal(a.availability_reason,'intake_pending');assert.equal(a.retention.cleanup_pending,false);
    f.advance(600001);
    const interrupted=f.store.asset(f.owner,f.project,a.id);
    assert.equal(interrupted.availability_reason,'intake_interrupted');assert.equal(interrupted.retention.cleanup_pending,true);
    assert.equal(f.service.maintenance({apply:true}).results[0].outcome,'missing');
    const missing=f.store.asset(f.owner,f.project,a.id);
    assert.equal(missing.availability_reason,'missing');assert.equal(missing.retention.deletion.outcome,'missing');
    const sealed=await f.service.asset(f.owner,f.project,metadata(bytes),[bytes]);
    f.advance(15*86400000);
    const expired=f.store.asset(f.owner,f.project,sealed.id);
    assert.equal(expired.state,'expired');assert.equal(expired.availability_reason,'expired');
    assert.equal(expired.retention.recorded_state,'staged');assert.equal(expired.retention.cleanup_pending,true);
    assert.equal(expired.retention.deletion,null);assert.equal(expired.retention.recorded_file_state,'sealed');
  } finally {f.close();}
});

test('approved project asset resolution rechecks attempt pins, grants, MIME and manual authentication',async()=> {
  const f=fixture();
  try {
    const bytes=Buffer.from('selected upload'),a=await f.service.asset(f.owner,f.project,metadata(bytes),[bytes]),pin=ref(a);
    f.configuration.artifacts.upload_asset_refs.push(pin);
    await rejects(f.service.resolveUpload(f.owner,f.scope,pin),403);
    f.store.reviewAsset(f.owner,f.project,a.id,assetReview);
    assert.deepEqual((await f.service.resolveUpload(f.owner,f.scope,pin)).bytes,bytes);
    for (const changed of [{sha256:'a'.repeat(64)},{mime_type:'text/csv'},{byte_count:bytes.length+1}])
      await rejects(f.service.resolveUpload(f.owner,f.scope,{...pin,...changed}),403);
    rejected(()=>f.store.asset(f.owner,f.otherProject,a.id),404);
    rejected(()=>f.store.asset(f.outsider,f.project,a.id),404);
    rejected(()=>f.store.reviewAsset(f.viewer,f.project,a.id,assetReview),403);
    f.manual(); await rejects(f.service.resolveUpload(f.owner,f.scope,pin),403); f.manual(false);
    f.configuration.artifacts.upload_asset_refs=[]; await rejects(f.service.resolveUpload(f.owner,f.scope,pin),403);
    f.configuration.artifacts.upload_asset_refs=[pin];f.revoke();await rejects(f.service.resolveUpload(f.owner,f.scope,pin),404);
  } finally {f.close();}
});

test('input readiness verifies existing private bytes and separate source disclosure without contacting a model',async()=> {
  const f=fixture();
  try {
    assert.equal(f.service.validateInputs(f.owner,{project_id:f.project,configuration:f.configuration}),true);
    const bytes=Buffer.from('Readiness source'),a=await f.service.asset(f.owner,f.project,metadata(bytes),[bytes]),pin=ref(a);
    f.configuration.artifacts.upload_asset_refs=[pin];
    rejected(()=>f.service.validateInputs(f.owner,{project_id:f.project,configuration:f.configuration}),403);
    f.store.reviewAsset(f.owner,f.project,a.id,assetReview);
    assert.equal(f.service.validateInputs(f.owner,{project_id:f.project,configuration:f.configuration}),true);
    f.configuration.work.source_inputs=[pin];
    rejected(()=>f.service.validateInputs(f.owner,{project_id:f.project,configuration:f.configuration}),403);
    f.store.reviewAssetModel(f.owner,f.project,a.id,{decision:'approve',reviewed_statement:BROWSER_ARTIFACT_REVIEW_STATEMENT});
    assert.equal(f.service.validateInputs(f.owner,{project_id:f.project,configuration:f.configuration}),true);
    const p=pdfFixture(),b=await f.service.asset(f.owner,f.project,metadata(p,'application/pdf'),[p]);
    f.store.reviewAsset(f.owner,f.project,b.id,assetReview);f.store.reviewAssetModel(f.owner,f.project,b.id,{decision:'approve',reviewed_statement:BROWSER_ARTIFACT_REVIEW_STATEMENT});
    f.configuration.work.source_inputs=[ref(b)];
    assert.equal(f.service.sourceCapabilities().pdf_ready,false);
    rejected(()=>f.service.validateInputs(f.owner,{project_id:f.project,configuration:f.configuration}),503);
    f.configuration.work.source_inputs=[pin];fs.writeFileSync(path.join(f.root,`${a.id}.blob`),Buffer.from('Changed source!!'));
    assert.throws(()=>f.service.validateInputs(f.owner,{project_id:f.project,configuration:f.configuration}),/storage unavailable/);
  } finally {f.close();}
});

test('bounded intake refuses wrong digest, binary/text MIME, excess bytes and timed-out body',async()=> {
  const f=fixture();
  try {
    const bytes=Buffer.from('abc');
    await rejects(f.service.asset(f.owner,f.project,metadata(bytes),[Buffer.from('xyz')]),400);
    await rejects(f.service.asset(f.owner,f.project,metadata(bytes),[Buffer.from('abcd')]),413);
    for(const row of f.db.prepare('SELECT id FROM ops_browser_artifacts').all()) f.store.cancel(f.owner,f.project,row.id);
    await rejects(f.service.asset(f.owner,f.project,metadata(Buffer.from([0,255]),'text/plain'),[Buffer.from([0,255])]),415);
    await rejects(f.service.asset(f.owner,f.project,metadata(bytes,'application/pdf'),[bytes]),415);
    for(const row of f.db.prepare('SELECT id FROM ops_browser_artifacts').all()) f.store.cancel(f.owner,f.project,row.id);
    const service=createBrowserArtifactsService({store:f.store,files:f.files,bodyTimeoutMs:15});
    await assert.rejects(service.asset(f.owner,f.project,metadata(bytes),{async *[Symbol.asyncIterator](){await new Promise(()=>{});}}),/timed out/);
    assert.equal(f.db.prepare('SELECT count(*) n FROM ops_browser_artifacts WHERE busy_token IS NOT NULL').get().n,0);
  } finally {f.close();}
});

test('cancelled reservations retain quota until safe physical cleanup, including unlink/database failure',async()=> {
  const f=fixture({installationBytes:16777216,accountBytes:16777216,projectBytes:16777216});
  try {
    const a=f.store.reserveAsset(f.owner,f.project,{...metadata(Buffer.from('a')),byte_count:16777216});
    f.store.cancel(f.owner,f.project,a.id);
    rejected(()=>f.store.reserveAsset(f.owner,f.project,metadata(Buffer.from('b'))),413);
    const plan=f.service.maintenance(); assert.equal(plan.items.length,1);
    assert.equal(f.service.maintenance({apply:true}).results[0].outcome,'missing');
    const bytes=Buffer.from('now occupied'),b=await f.service.asset(f.owner,f.project,metadata(bytes),[bytes]);
    f.store.cancel(f.owner,f.project,b.id);
    f.db.exec("CREATE TRIGGER reject_deletion BEFORE INSERT ON ops_browser_artifact_deletions BEGIN SELECT RAISE(ABORT,'DB failed'); END;");
    assert.throws(()=>f.store.maintenanceApply(b.id,id=>f.files.remove(id)),/DB failed/);
    assert.equal(f.db.prepare('SELECT charged_bytes FROM ops_browser_artifacts WHERE id=?').get(b.id).charged_bytes,bytes.length);
    f.db.exec('DROP TRIGGER reject_deletion');
    assert.equal(f.store.maintenanceApply(b.id,id=>f.files.remove(id)).outcome,'missing');
    assert.equal(f.store.maintenanceApply(b.id,()=>{throw Error('must not delete twice');}).outcome,'missing');
  } finally {f.close();}
});

test('attempt artifact budget is cumulative and cleanup never replenishes it',async()=> {
  const f=fixture();
  try {
    f.configuration.budgets.max_artifact_bytes=10;
    const bytes=Buffer.from('123456'),a=await f.service.stage(f.owner,f.scope,metadata(bytes,'text/plain',{kind:'download'}),[bytes]);
    f.store.cancel(f.owner,f.project,a.id,f.scope);assert.equal(f.service.maintenance({apply:true}).results[0].outcome,'deleted');
    assert.equal(f.db.prepare('SELECT sum(charged_bytes) n FROM ops_browser_artifacts').get().n,0);
    rejected(()=>f.store.reserveAttempt(f.owner,f.scope,metadata(bytes,'text/plain',{kind:'download'})),413);
    const four=Buffer.from('1234');assert.equal(f.store.reserveAttempt(f.owner,f.scope,metadata(four,'text/plain',{kind:'download'})).state,'reserved');
    rejected(()=>f.store.reserveAttempt(f.owner,f.scope,metadata(Buffer.from('x'),'text/plain',{kind:'download'})),413);
  } finally {f.close();}
});

test('mid-intake revocation and cancellation cannot seal bytes or free an active writer allocation',async()=> {
  const f=fixture();
  try {
    const bytes=Buffer.from('a private value');
    await rejects(f.service.stage(f.owner,f.scope,metadata(bytes,'text/plain',{kind:'download'}),{
      async *[Symbol.asyncIterator](){yield bytes.subarray(0,4);f.revoke();yield bytes.subarray(4);}
    }),404);
    assert.equal(f.db.prepare("SELECT count(*) n FROM ops_browser_artifacts WHERE file_state='sealed'").get().n,0);
    f.restore();
    const a=f.store.reserveAttempt(f.owner,f.scope,metadata(bytes,'text/plain',{kind:'download'}));
    const l=f.store.claim(f.owner,f.project,a.id,f.scope); f.cancel();
    rejected(()=>f.store.seal(f.owner,l,{sha256:a.sha256,byte_count:a.byte_count,mime_type:a.mime_type}),409);
    assert.ok(!f.store.maintenancePlan().items.some(v=>v.artifact_id===a.id));
    f.store.releaseWrite(l);assert.ok(f.store.maintenancePlan().items.some(v=>v.artifact_id===a.id));
  } finally {f.close();}
});

test('download release needs immutable explicit review and current account/run/attempt/fence access',async()=> {
  const f=fixture();
  try {
    const bytes=Buffer.from('downloaded private report'),a=await f.service.stage(f.owner,f.scope,metadata(bytes,'text/plain',{kind:'download'}),[bytes]);
    rejected(()=>f.store.openRead(f.owner,f.scope,a.id,'download'),403);
    f.store.reviewRelease(f.owner,f.scope,a.id,releaseReview('human_download'));
    const l=f.store.openRead(f.owner,f.scope,a.id,'download');assert.equal(f.store.checkRead(f.owner,l).id,a.id);
    rejected(()=>f.store.reviewRelease(f.owner,f.scope,a.id,releaseReview('human_download')),409);
    assert.throws(()=>f.db.prepare("UPDATE ops_browser_artifact_reviews SET decision='reject'").run());
    for(const s of [{...f.scope,attempt_id:randomUUID()},{...f.scope,project_id:f.otherProject},{...f.scope,fence:2}])
      rejected(()=>f.store.artifact(f.owner,s,a.id),409);
    f.deactivate();rejected(()=>f.store.checkRead(f.owner,l),403);f.restore();
    f.newFence();rejected(()=>f.store.checkRead(f.owner,l),409);f.store.closeRead(l);
  } finally {f.close();}
});

test('serving files uses attachments/no-store/nosniff and aborts after revocation between chunks',async()=> {
  const f=fixture();
  try {
    const bytes=Buffer.alloc(150000,65),a=await f.service.asset(f.owner,f.project,metadata(bytes),[bytes]);
    const res=new EventEmitter();res.headers={};res.sent=[];res.set=(k,v)=>{res.headers[k]=v;return res;};
    res.write=b=>{res.headersSent=true;res.sent.push(b);f.revoke();return true;};
    res.end=()=>{res.ended=true;};res.destroy=()=>{res.destroyed=true;};
    await rejects(f.service.serve(f.owner,{project_id:f.project,id:a.id},{headers:{},method:'GET'},res),404);
    assert.equal(res.sent.length,1);assert.equal(res.destroyed,true);assert.equal(res.headers['X-Content-Type-Options'],'nosniff');
    assert.equal(res.headers['Cache-Control'],'no-store, private');assert.match(res.headers['Content-Disposition'],/^attachment;/);
    f.restore(); await rejects(f.service.serve(f.owner,{project_id:f.project,id:a.id},{headers:{range:'bytes=0-1'},method:'GET'},res),416);
    assert.equal(f.db.prepare('SELECT count(*) n FROM ops_browser_artifact_read_leases').get().n,0);
  } finally {f.close();}
});

test('attempt clipboard requires explicit exchange, finite bytes, current scope and immediate teardown invalidation',async()=> {
  const f=fixture();
  try {
    const a=await f.service.clipboardImport(f.owner,f.scope,{text:'human private clipboard'});
    assert.deepEqual(f.service.clipboardExport(f.owner,f.scope,a.id),{text:'human private clipboard'});
    rejected(()=>f.store.openRead(f.owner,f.scope,a.id,'model'),403);
    await rejects(f.service.clipboardImport(f.owner,f.scope,{text:'a'.repeat(65537)}),400);
    f.manual(); const explicit=await f.service.clipboardImport(f.owner,f.scope,{text:'manual private human exchange'});
    assert.equal(f.service.clipboardExport(f.owner,f.scope,explicit.id).text,'manual private human exchange');
    rejected(()=>f.service.resolveClipboard(f.owner,f.scope,explicit.id),403);f.manual(false);
    assert.equal(f.service.resolveClipboard(f.owner,f.scope,a.id).bytes.toString(),'human private clipboard');
    const l=f.store.openRead(f.owner,f.scope,a.id,'clipboard');f.cancel();rejected(()=>f.store.checkRead(f.owner,l),409);
    assert.ok(!JSON.stringify(f.db.prepare('SELECT * FROM audit').all()).includes('human private clipboard'));
    assert.equal(f.service.maintenance({apply:true}).results[0].outcome,'deleted');
    assert.equal(f.db.prepare('SELECT charged_bytes FROM ops_browser_artifacts WHERE id=?').get(a.id).charged_bytes,0);
  } finally {f.close();}
});

test('private model source needs owner review of exact bytes, fresh source pin and explicit parser readiness',async()=> {
  const f=fixture();
  try {
    const bytes=Buffer.from('Selected source only.'),a=await f.service.asset(f.owner,f.project,metadata(bytes),[bytes]),pin=ref(a);
    f.store.reviewAsset(f.owner,f.project,a.id,assetReview);
    await rejects(f.service.resolveSourceAsset(f.owner,f.project,pin,{approved_for_model:true}),403);
    f.store.reviewAssetModel(f.owner,f.project,a.id,{decision:'approve',reviewed_statement:BROWSER_ARTIFACT_REVIEW_STATEMENT});
    assert.equal((await f.service.resolveSourceAsset(f.owner,f.project,pin,{approved_for_model:true})).content.text,bytes.toString());
    await rejects(f.service.resolveSourceAsset(f.owner,f.project,pin),403);
    await rejects(f.service.resolveSourceAsset(f.viewer,f.project,pin,{approved_for_model:true}),403);
    await rejects(f.service.resolveSourceAsset(f.owner,f.project,{...pin,sha256:'b'.repeat(64)},{approved_for_model:true}),403);
    fs.writeFileSync(path.join(f.root,`${a.id}.blob`),Buffer.from('Changed source only!'),{mode:0o600});
    await assert.rejects(f.service.resolveSourceAsset(f.owner,f.project,pin,{approved_for_model:true}),/storage unavailable/);
  } finally {f.close();}
});

test('synchronous private source verification checks current disclosure and physical originals without parsing or returning bytes',async()=> {
  const f=fixture();
  try {
    const bytes=Buffer.from('Consented original'),a=await f.service.asset(f.owner,f.project,metadata(bytes),[bytes]),pin=ref(a);
    rejected(()=>f.service.verifySourceAsset(f.owner,f.project,pin,{approved_for_model:true}),403);
    f.store.reviewAsset(f.owner,f.project,a.id,assetReview);
    rejected(()=>f.service.verifySourceAsset(f.owner,f.project,pin,{approved_for_model:true}),403);
    f.store.reviewAssetModel(f.owner,f.project,a.id,{decision:'approve',reviewed_statement:BROWSER_ARTIFACT_REVIEW_STATEMENT});
    rejected(()=>f.service.verifySourceAsset(f.owner,f.project,pin),403);
    rejected(()=>f.service.verifySourceAsset(f.viewer,f.project,pin,{approved_for_model:true}),403);
    const result=f.service.verifySourceAsset(f.owner,f.project,pin,{approved_for_model:true});
    assert.deepEqual(result,{project_id:f.project,ref:pin,approved_for_model:true});
    assert.ok(!JSON.stringify(result).includes(bytes.toString('utf8')));
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM ops_browser_artifact_read_leases').get().n,0);
    f.revoke();rejected(()=>f.service.verifySourceAsset(f.owner,f.project,pin,{approved_for_model:true}),404);f.restore();
    fs.writeFileSync(path.join(f.root,`${a.id}.blob`),Buffer.from('Corrupted original'));
    assert.throws(()=>f.service.verifySourceAsset(f.owner,f.project,pin,{approved_for_model:true}),/storage unavailable/);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM ops_browser_artifact_read_leases').get().n,0);
    f.store.cancel(f.owner,f.project,a.id);
    rejected(()=>f.service.verifySourceAsset(f.owner,f.project,pin,{approved_for_model:true}),410);
  } finally {f.close();}
});

test('private model inputs require current consent, exact per-source model review and aggregate prompt bound',async()=> {
  const f=fixture();
  try {
    const bytes=Buffer.from('Consented bounded source.'),a=await f.service.asset(f.owner,f.project,metadata(bytes),[bytes]),pin=ref(a);
    f.store.reviewAsset(f.owner,f.project,a.id,assetReview);
    f.store.reviewAssetModel(f.owner,f.project,a.id,{decision:'approve',reviewed_statement:BROWSER_ARTIFACT_REVIEW_STATEMENT});
    f.configuration.work.source_inputs=[pin];
    await rejects(f.service.modelInputs(f.owner,f.scope,[pin]),403);f.consent();
    assert.deepEqual(await f.service.modelInputs(f.owner,f.scope,[pin]),[{ref:pin,content_kind:'text',text:bytes.toString(),content_sha256:browserArtifactByteHash(bytes),image_base64:null,image_mime_type:null}]);
    f.configuration.model.max_prompt_bytes=10;await rejects(f.service.modelInputs(f.owner,f.scope,[pin]),413);
    f.configuration.model.max_prompt_bytes=16000;f.manual();await rejects(f.service.modelInputs(f.owner,f.scope,[pin]),403);f.manual(false);
    f.configuration.work.source_inputs=[];await rejects(f.service.modelInputs(f.owner,f.scope,[pin]),403);
    assert.equal(f.db.prepare('SELECT count(*) n FROM ops_browser_artifact_read_leases').get().n,0);
  } finally {f.close();}
});

test('model input drafts stay quarantined until exact human approval and bind every resolved byte to snapshot/target/purpose',async()=> {
  const f=fixture();try{
    const target_ref={id:randomUUID(),sha256:'b'.repeat(64)},snapshot_ref={id:randomUUID(),sha256:'c'.repeat(64)},input={target_ref,snapshot_ref,text:'User-reviewed form response',purpose:'Answer selected field'};
    await rejects(f.service.stageInputDraft(f.owner,f.scope,input),403);f.consent();
    const draft=await f.service.stageInputDraft(f.owner,f.scope,input),manifest={artifact_ref:draft.artifact_ref,target_ref,snapshot_ref,purpose:input.purpose,approval_ref:{id:randomUUID(),sha256:'d'.repeat(64)}};
    assert.equal(draft.requires_review,true);assert.ok(!Object.hasOwn(draft,'text'));
    rejected(()=>f.service.resolveInputDraft(f.owner,f.scope,manifest),403);
    rejected(()=>f.service.approveInputDraft(f.owner,f.scope,manifest),403);f.inputApprove();
    const approved=f.service.approveInputDraft(f.owner,f.scope,manifest);assert.deepEqual(approved.input_ref,{id:draft.artifact_ref.id,sha256:draft.artifact_ref.sha256});
    assert.equal(f.service.resolveInputDraft(f.owner,f.scope,manifest).bytes.toString(),input.text);
    for(const changed of [{purpose:'Other purpose'},{target_ref:{...target_ref,id:randomUUID()}},{snapshot_ref:{...snapshot_ref,sha256:'e'.repeat(64)}},
      {approval_ref:{...manifest.approval_ref,sha256:'f'.repeat(64)}}])rejected(()=>f.service.resolveInputDraft(f.owner,f.scope,{...manifest,...changed}),403);
    f.inputApprove(false);rejected(()=>f.service.resolveInputDraft(f.owner,f.scope,manifest),403);f.inputApprove();
    assert.throws(()=>f.db.prepare("UPDATE ops_browser_input_drafts SET purpose_sha256=?").run('a'.repeat(64)));
    const stored=JSON.stringify(f.db.prepare('SELECT * FROM ops_browser_input_drafts').all())+JSON.stringify(f.db.prepare('SELECT * FROM audit').all());
    assert.ok(!stored.includes(input.text));assert.ok(!stored.includes(input.purpose));
    rejected(()=>f.store.openRead(f.owner,f.scope,draft.artifact_ref.id,'model'),403);
    f.store.cancelAttempt(f.scope,{clipboardOnly:true});rejected(()=>f.service.resolveInputDraft(f.owner,f.scope,manifest),410);
    assert.equal(f.service.maintenance({apply:true}).results[0].outcome,'deleted');
  }finally{f.close();}
});

function tinyPng() {
  // Independent tiny fixture encoder: two rows of red/green/blue/white pixels,
  // no metadata. Output pixels are compared by an independent PNG inflate read.
  const crc=bytes=> {let c=0xffffffff;for(const b of bytes){c^=b;for(let i=0;i<8;i++)c=c&1?0xedb88320^(c>>>1):c>>>1;}return(c^0xffffffff)>>>0;};
  const chunk=(type,data)=> {const b=Buffer.alloc(data.length+12);b.writeUInt32BE(data.length,0);b.write(type,4);data.copy(b,8);b.writeUInt32BE(crc(b.subarray(4,-4)),b.length-4);return b;};
  const ihdr=Buffer.from([0,0,0,2,0,0,0,2,8,6,0,0,0]);
  const pixels=Buffer.from([0,255,0,0,255,0,255,0,255,0,0,0,255,255,255,255,255,255]);
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);
}
// V8 reserves virtual address cages larger than its resident heap. The fixture
// pins CPU/descriptors and --max-old-space-size; release needs real process
// memory isolation (for example a reviewed cgroup), not a false RLIMIT_AS proof.
const localImageLaunch=(program,args)=>spawn('/usr/bin/prlimit',['--cpu=3','--nofile=32','--',program,...args],
  {shell:false,detached:true,env:{},stdio:['pipe','pipe','ignore']});

test('real screenshot redactor masks selected pixels and refuses corrupt/oversized/outside images',async()=> {
  const bytes=tinyPng(),refused=createBrowserArtifactImageRedactor();assert.equal(refused.ready,false);await rejects(refused(bytes,[]),503);
  const redact=createBrowserArtifactImageRedactor({launch:localImageLaunch,capability:'browser-artifact-image-redact-v1'});
  const result=await redact(bytes,[{x:0,y:0,width:1,height:1}]);assert.equal(result.width,2);assert.equal(result.height,2);
  const n=result.bytes.readUInt32BE(33),pixels=inflateSync(result.bytes.subarray(41,41+n));
  assert.deepEqual([...pixels],[0,0,0,0,255,0,255,0,255,0,0,0,255,255,255,255,255,255]);
  await rejects(redact(bytes,[{x:2,y:0,width:1,height:1}]),415);
  const corrupt=Buffer.from(bytes);corrupt[45]^=1;await rejects(redact(corrupt,[]),415);
  await rejects(redact(bytes,[{x:0,y:0,width:1,height:1,path:'/etc/passwd'}]),400);
});

test('raw screenshot is private review-only; normalization and selected redaction still require exact derivative review',async()=> {
  const f=fixture();
  try {
    const bytes=tinyPng(),redact=createBrowserArtifactImageRedactor({launch:localImageLaunch,capability:'browser-artifact-image-redact-v1'});
    const service=createBrowserArtifactsService({store:f.store,files:f.files,decodeImage:b=>redact(b,[]),redactImage:redact});
    const a=await service.stage(f.owner,f.scope,metadata(bytes,'image/png',{kind:'screenshot'}),[bytes]);
    rejected(()=>f.store.openRead(f.owner,f.scope,a.id,'download'),403);
    rejected(()=>f.store.reviewRelease(f.owner,f.scope,a.id,releaseReview('human_download')),403);
    const d=await service.normalizeScreenshot(f.owner,f.scope,a.id,{redactions:[{x:0,y:0,width:1,height:1}]});
    assert.equal(d.kind,'screenshot_derivative');assert.equal(d.parent_id,a.id);assert.notEqual(d.sha256,a.sha256);
    rejected(()=>f.store.openRead(f.owner,f.scope,d.id,'download'),403);
    f.store.reviewRelease(f.owner,f.scope,d.id,releaseReview('human_download'));
    const l=f.store.openRead(f.owner,f.scope,d.id,'download');assert.equal(l.sha256,d.sha256);f.store.closeRead(l);
    rejected(()=>f.store.openRead(f.owner,f.scope,d.id,'model'),403);
    f.consent();f.store.reviewRelease(f.owner,f.scope,d.id,releaseReview('model_input'));
    const model=f.store.openRead(f.owner,f.scope,d.id,'model');f.store.closeRead(model);
    f.manual();await rejects(service.stage(f.owner,f.scope,metadata(bytes,'image/png',{kind:'screenshot'}),[bytes]),409);
  } finally {f.close();}
});

test('lease and retention expiry never re-enable released files; bounded cleanup respects read leases',async()=> {
  const f=fixture();
  try {
    const bytes=Buffer.from('short retention'),a=await f.service.asset(f.owner,f.project,metadata(bytes),[bytes]);
    const l=f.store.openAssetRead(f.owner,f.project,a.id,'review');f.advance(60001);
    rejected(()=>f.store.checkRead(f.owner,l),409);f.store.closeRead(l);
    f.advance(14*86400000);rejected(()=>f.store.openAssetRead(f.owner,f.project,a.id),410);
    assert.equal(f.service.maintenance({apply:true,limit:1}).results[0].outcome,'deleted');
    assert.equal(f.store.asset(f.owner,f.project,a.id).available,false);
    const b=await f.service.asset(f.owner,f.project,metadata(bytes),[bytes]),hold=f.store.openAssetRead(f.owner,f.project,b.id);
    f.store.cancel(f.owner,f.project,b.id); // cancellation revokes leases deliberately
    rejected(()=>f.store.checkRead(f.owner,hold),410);
    assert.equal(f.store.maintenanceApply(b.id,id=>f.files.remove(id)).outcome,'deleted');
  } finally {f.close();}
});

test('private file adapter refuses symlinks/hardlinks/non-private modes, changed bytes and swapped root',()=> {
  const parent=fs.mkdtempSync(path.join(os.tmpdir(),'pp-browser-root-')),root=path.join(parent,'private'),other=path.join(parent,'other');
  fs.mkdirSync(root,{mode:0o700});fs.mkdirSync(other,{mode:0o700});
  const files=createBrowserArtifactFiles(root),bytes=Buffer.from('abc'),proof={byte_count:3,sha256:browserArtifactByteHash(bytes)};
  try {
    assert.throws(()=>files.write('../escape',bytes));
    const a=randomUUID();files.write(a,bytes);fs.chmodSync(path.join(root,`${a}.blob`),0o644);assert.throws(()=>files.read(a,proof));fs.chmodSync(path.join(root,`${a}.blob`),0o600);
    const link=randomUUID();fs.linkSync(path.join(root,`${a}.blob`),path.join(root,`${link}.blob`));assert.throws(()=>files.read(a,proof));assert.throws(()=>files.remove(link));
    fs.unlinkSync(path.join(root,`${link}.blob`));
    const symlink=randomUUID();fs.symlinkSync(path.join(root,`${a}.blob`),path.join(root,`${symlink}.blob`));assert.throws(()=>files.read(symlink,proof));
    fs.writeFileSync(path.join(root,`${a}.blob`),Buffer.from('xyz'));assert.throws(()=>files.read(a,proof));
    fs.renameSync(root,path.join(parent,'old'));fs.renameSync(other,root);assert.throws(()=>files.write(randomUUID(),bytes));
    fs.rmSync(root,{recursive:true});fs.symlinkSync(path.join(parent,'old'),root);assert.throws(()=>createBrowserArtifactFiles(root));
  } finally {files.close();fs.rmSync(parent,{recursive:true,force:true});}
});

function pdfFixture(value='Private PDF fixture') {
  const stream=`BT /F1 12 Tf 72 720 Td (${value.replace(/[()\\]/g,'\\$&')}) Tj ET`;
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`];
  let result='%PDF-1.4\n',offsets=[];
  for(let i=0;i<objects.length;i++){offsets.push(Buffer.byteLength(result));result+=`${i+1} 0 obj\n${objects[i]}\nendobj\n`;}
  const xref=Buffer.byteLength(result);result+=`xref\n0 6\n0000000000 65535 f \n${offsets.map(n=>`${String(n).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(result);
}

test('PDF decoder refuses missing isolation capability and verifies real bounded fixed-command extraction',async()=> {
  const bytes=pdfFixture();verifyBrowserArtifactMedia(bytes,'application/pdf');
  const refused=createBrowserArtifactPdfDecoder();assert.equal(refused.ready,false);await rejects(refused(bytes),503);
  const launched=[];
  const launch=(program,args)=> {
    launched.push([program,...args]);
    return spawn('/usr/bin/prlimit',['--cpu=3','--as=268435456','--nofile=32','--fsize=1048576','--',program,...args],
      {shell:false,detached:true,env:{},stdio:['pipe','pipe','ignore']});
  };
  const decode=createBrowserArtifactPdfDecoder({launch,capability:'browser-artifact-pdf-v1'});
  assert.equal(decode.ready,true);assert.match(await decode(bytes),/Private PDF fixture/);
  assert.deepEqual(launched[0],['/usr/bin/pdftotext','-enc','UTF-8','-nopgbrk','-','-']);
  await rejects(createBrowserArtifactPdfDecoder({launch,capability:'browser-artifact-pdf-v1',maxOutputBytes:4})(bytes),415);
  await rejects(decode(Buffer.from('%PDF-1.4\nno valid objects\n%%EOF\n')),415);
});

const observationInput=(value='Bounded private page evidence',extra={})=>({snapshot_ref:{id:randomUUID(),sha256:'b'.repeat(64)},
  text:value,origin:'https://example.com',url_sha256:'c'.repeat(64),chunker_version:'browser-text.v1',...extra});

test('internal page capture pins immutable bounded provenance and cannot borrow ordinary file disclosure',async()=>{
  const f=fixture();
  try{
    const input=observationInput();
    await rejects(f.service.stageObservation(f.owner,f.scope,input),403);f.consent();
    for(const extra of [{origin:'https://other.example.com'},{origin:'https://example.com/path'},{origin:null},
      {url_sha256:'bad'},{chunker_version:'anything'},{path:'/etc/passwd'},{text:'x'.repeat(4001)},{text:'😀'.repeat(1001)},{text:'\ud800'},{text:'  '}])
      await rejects(f.service.stageObservation(f.owner,f.scope,{...input,...extra}),extra.origin==='https://other.example.com'?403:400);
    const bytes=Buffer.from(input.text);
    rejected(()=>f.store.reserveAttempt(f.owner,f.scope,metadata(bytes,'text/plain',{kind:'observation'})),400);
    const staged=await f.service.stageObservation(f.owner,f.scope,input),a=f.store.artifact(f.owner,f.scope,staged.artifact_ref.id);
    assert.equal(a.kind,'observation');assert.deepEqual(staged.artifact_ref,ref(a));assert.equal(a.sha256,browserArtifactByteHash(bytes));
    const provenance=f.db.prepare('SELECT * FROM ops_browser_observation_sources WHERE artifact_id=?').get(a.id);
    assert.deepEqual(JSON.parse(provenance.snapshot_ref_json),input.snapshot_ref);assert.equal(provenance.origin,input.origin);
    assert.equal(provenance.url_sha256,input.url_sha256);assert.equal(provenance.worker_contract,'selected-browser.v1');
    assert.deepEqual(a.provenance.snapshot_ref,input.snapshot_ref);assert.equal(a.provenance.origin,input.origin);
    assert.equal(a.provenance.url_sha256,input.url_sha256);assert.equal(a.provenance.chunker_version,'browser-text.v1');
    assert.ok(!JSON.stringify(a).includes(input.text));
    assert.throws(()=>f.db.prepare('UPDATE ops_browser_observation_sources SET origin=? WHERE artifact_id=?').run('https://other.example.com',a.id));
    assert.ok(!JSON.stringify(f.db.prepare('SELECT * FROM ops_browser_artifacts').all()).includes(input.text));
    assert.ok(!JSON.stringify(f.db.prepare('SELECT * FROM audit').all()).includes(input.text));
    rejected(()=>f.store.openRead(f.owner,f.scope,a.id,'download'),403);
    rejected(()=>f.store.reviewRelease(f.owner,f.scope,a.id,releaseReview('model_input')),403);
    assert.equal(f.service.observationInputs(f.owner,f.scope,[ref(a)])[0].text,input.text);
    const ordinary=await f.service.asset(f.owner,f.project,metadata(bytes),[bytes]);
    rejected(()=>f.service.observationInputs(f.owner,f.scope,[ref(ordinary)]),404);
    rejected(()=>f.service.observationInputs(f.owner,f.scope,[{...ref(a),sha256:'d'.repeat(64)}]),403);
    rejected(()=>f.service.observationInputs(f.owner,{...f.scope,run_id:randomUUID()},[ref(a)]),409);
    f.manual();await rejects(f.service.stageObservation(f.owner,f.scope,input),409);rejected(()=>f.service.observationInputs(f.owner,f.scope,[ref(a)]),403);
  }finally{f.close();}
});

test('captured page grants authorize capture only; private source reads recheck access, consent and bytes',async()=>{
  let granted=true;
  const checks=[],f=fixture({verifyObservationOrigin:(actor,scope,origin)=>{checks.push({actor,scope,origin});return granted&&origin==='https://approved.example.com';}});
  try{
    f.consent();const input=observationInput('Private approved destination evidence',{origin:'https://approved.example.com'}),
      captured=await f.service.stageObservation(f.owner,f.scope,input),pin=captured.artifact_ref;
    assert.deepEqual(checks[0].scope,f.scope);assert.equal(checks[0].origin,input.origin);granted=false;
    const disclosure=f.service.observationInputs(f.owner,f.scope,[pin]);assert.deepEqual(disclosure,[{ref:pin,content_kind:'text',
      content_sha256:pin.sha256,text:input.text,image_base64:null,image_mime_type:null}]);
    assert.equal(checks.length,1);await rejects(f.service.stageObservation(f.owner,f.scope,input),403);
    assert.deepEqual(f.service.observationStatus(f.owner,f.scope,[pin]),[{id:pin.id,state:'available',code:null}]);
    assert.equal(f.db.prepare('SELECT count(*) n FROM ops_browser_artifact_read_leases').get().n,0);
    f.consent(false);rejected(()=>f.service.observationInputs(f.owner,f.scope,[pin]),403);
    assert.equal(f.service.observationStatus(f.owner,f.scope,[pin])[0].state,'available');f.consent();
    fs.writeFileSync(path.join(f.root,`${pin.id}.blob`),Buffer.from('Forged private destination evidence!'));
    assert.throws(()=>f.service.observationInputs(f.owner,f.scope,[pin]),/storage unavailable/);
    assert.equal(f.service.observationStatus(f.owner,f.scope,[pin])[0].state,'unavailable');
    f.revoke();rejected(()=>f.service.observationStatus(f.owner,f.scope,[pin]),404);f.restore();
    f.store.cancelAttempt(f.scope);assert.equal(f.service.observationStatus(f.owner,f.scope,[pin])[0].state,'unavailable');
    assert.equal(f.service.maintenance({apply:true}).results[0].outcome,'deleted');
  }finally{f.close();}
});

test('page model memory has finite aggregate bounds and retained terminal source review never grants model use',async()=>{
  const f=fixture();
  try{
    f.consent();const refs=[];
    for(let i=0;i<5;i++)refs.push((await f.service.stageObservation(f.owner,f.scope,observationInput(`${i}${'x'.repeat(3999)}`))).artifact_ref);
    assert.equal(f.service.observationInputs(f.owner,f.scope,refs.slice(0,4)).length,4);
    rejected(()=>f.service.observationInputs(f.owner,f.scope,refs),413);
    rejected(()=>f.service.observationInputs(f.owner,f.scope,[refs[0],refs[0]]),400);
    f.terminal();assert.equal(f.service.observationStatus(f.viewer,f.scope,refs)[0].state,'available');
    const l=f.store.openRead(f.viewer,f.scope,refs[0].id,'review');assert.equal(l.sha256,refs[0].sha256);f.store.closeRead(l);
    rejected(()=>f.service.observationInputs(f.owner,f.scope,[refs[0]]),409);
    f.advance(f.configuration.artifacts.retention_days*86400000+1);
    assert.ok(f.service.observationStatus(f.owner,f.scope,refs).every(item=>item.state==='unavailable'));
    assert.equal(f.service.maintenance({apply:true}).results.length,5);
  }finally{f.close();}
});

test('retained completed downloads permit fresh exact human release without restoring model or execution authority',async()=>{
  const f=fixture();
  try{
    const bytes=Buffer.from('Finished run retained output'),a=await f.service.stage(f.owner,f.scope,metadata(bytes,'text/plain',{kind:'download'}),[bytes]);
    f.terminal();
    rejected(()=>f.store.reviewRelease(f.viewer,f.scope,a.id,releaseReview('human_download')),403);
    f.store.reviewRelease(f.owner,f.scope,a.id,releaseReview('human_download'));
    const lease=f.store.openRead(f.viewer,f.scope,a.id,'download');assert.equal(lease.sha256,a.sha256);f.store.closeRead(lease);
    rejected(()=>f.store.reviewRelease(f.owner,f.scope,a.id,releaseReview('model_input')),409);
    rejected(()=>f.store.openRead(f.owner,f.scope,a.id,'model'),409);
    await rejects(f.service.stage(f.owner,f.scope,metadata(bytes,'text/plain',{kind:'download'}),[bytes]),409);
    f.revoke();rejected(()=>f.store.openRead(f.owner,f.scope,a.id,'download'),404);
  }finally{f.close();}
});

test('completed retained screenshot transformation needs current review authority and keeps original retention and budgets',async()=>{
  const f=fixture();
  try{
    const bytes=tinyPng(),redact=createBrowserArtifactImageRedactor({launch:localImageLaunch,capability:'browser-artifact-image-redact-v1'}),
      service=createBrowserArtifactsService({store:f.store,files:f.files,decodeImage:b=>redact(b,[]),redactImage:redact}),
      source=await service.stage(f.owner,f.scope,metadata(bytes,'image/png',{kind:'screenshot'}),[bytes]);
    f.terminal();f.advance(1000);
    await rejects(service.normalizeScreenshot(f.viewer,f.scope,source.id),403);
    const normalized=await service.normalizeScreenshot(f.owner,f.scope,source.id,{redactions:[{x:0,y:0,width:1,height:1}]});
    assert.equal(normalized.expires_at,source.expires_at);assert.equal(normalized.parent_id,source.id);
    assert.equal(f.db.prepare('SELECT write_intent FROM ops_browser_artifacts WHERE id=?').get(normalized.id).write_intent,'artifact_transform');
    assert.equal(f.db.prepare('SELECT SUM(charged_bytes) n FROM ops_browser_artifacts').get().n,source.byte_count+normalized.byte_count);
    f.store.reviewRelease(f.owner,f.scope,normalized.id,releaseReview('human_download'));
    rejected(()=>f.store.reviewRelease(f.owner,f.scope,normalized.id,releaseReview('model_input')),409);
    f.configuration.budgets.max_artifact_bytes=source.byte_count+normalized.byte_count;
    await rejects(service.normalizeScreenshot(f.owner,f.scope,source.id),413);
    f.store.cancelAttempt(f.scope);await rejects(service.normalizeScreenshot(f.owner,f.scope,source.id),410);
  }finally{f.close();}
});

test('a source revoked during awaited screenshot decoding cannot seal or return a derived private file',async()=>{
  const f=fixture();
  try{
    const bytes=tinyPng(),source=await f.service.stage(f.owner,f.scope,metadata(bytes,'image/png',{kind:'screenshot'}),[bytes]);
    const service=createBrowserArtifactsService({store:f.store,files:f.files,decodeImage:async()=>{
      await new Promise(resolve=>setImmediate(resolve));f.store.cancelAttempt(f.scope);return{width:2,height:2,bytes};}});
    await rejects(service.normalizeScreenshot(f.owner,f.scope,source.id),410);
    assert.equal(f.db.prepare("SELECT count(*) n FROM ops_browser_artifacts WHERE kind='screenshot_derivative'").get().n,0);
    assert.equal(f.db.prepare('SELECT count(*) n FROM ops_browser_artifact_read_leases').get().n,0);
  }finally{f.close();}
});

test('manual authentication can verify exact retained upload bytes without activation, model disclosure or durable changes',async()=>{
  const f=fixture();
  try{
    const bytes=Buffer.from('Approved existing private upload'),a=await f.service.asset(f.owner,f.project,metadata(bytes),[bytes]),pin=ref(a);
    f.configuration.artifacts.upload_asset_refs=[pin];f.manual();
    rejected(()=>f.service.verifyRetainedUpload(f.owner,f.scope,pin),403);
    f.store.reviewAsset(f.owner,f.project,a.id,assetReview);
    const snapshot=()=>JSON.stringify({artifacts:f.db.prepare('SELECT * FROM ops_browser_artifacts').all(),reviews:f.db.prepare('SELECT * FROM ops_browser_artifact_reviews').all(),audit:f.db.prepare('SELECT * FROM audit').all()}),before=snapshot();
    const copies=[],service=createBrowserArtifactsService({store:f.store,files:{...f.files,read:(...args)=>{const copy=f.files.read(...args);copies.push(copy);return copy;}}});
    assert.deepEqual(service.verifyRetainedUpload(f.owner,f.scope,pin),{ref:pin});
    assert.equal(snapshot(),before);assert.equal(f.db.prepare('SELECT count(*) n FROM ops_browser_artifact_read_leases').get().n,0);
    assert.ok(copies.length&&copies.every(copy=>copy.every(v=>v===0)));assert.deepEqual(f.files.read(a.id,{sha256:pin.sha256,byte_count:pin.byte_count}),bytes);
    await rejects(service.resolveUpload(f.owner,f.scope,pin),403);
    await rejects(service.resolveSourceAsset(f.owner,f.project,pin,{approved_for_model:true}),403);
    for(const extra of [{sha256:'f'.repeat(64)},{byte_count:pin.byte_count+1},{mime_type:'text/csv'}])
      rejected(()=>service.verifyRetainedUpload(f.owner,f.scope,{...pin,...extra}),403);
    rejected(()=>service.verifyRetainedUpload(f.viewer,f.scope,pin),403);
    rejected(()=>service.verifyRetainedUpload(f.owner,{...f.scope,run_id:randomUUID()},pin),409);
    const wrong=await f.service.asset(f.owner,f.otherProject,metadata(bytes),[bytes]);f.store.reviewAsset(f.owner,f.otherProject,wrong.id,assetReview);
    f.configuration.artifacts.upload_asset_refs.push(ref(wrong));rejected(()=>service.verifyRetainedUpload(f.owner,f.scope,ref(wrong)),404);
    fs.writeFileSync(path.join(f.root,`${pin.id}.blob`),Buffer.from('Changed private upload bytes!!!!'));
    assert.throws(()=>service.verifyRetainedUpload(f.owner,f.scope,pin),/storage unavailable/);
    f.advance(14*86400000);rejected(()=>service.verifyRetainedUpload(f.owner,f.scope,pin),410);
  }finally{f.close();}
});

test('retained input verification requires separate consumed proof and exact purpose, target, snapshot and approval',async()=>{
  const f=fixture();
  try{
    f.consent();f.inputApprove();
    const input={target_ref:{id:randomUUID(),sha256:'b'.repeat(64)},snapshot_ref:{id:randomUUID(),sha256:'c'.repeat(64)},text:'Previously approved form text',purpose:'Answer exact prior field'},
      staged=await f.service.stageInputDraft(f.owner,f.scope,input),manifest={artifact_ref:staged.artifact_ref,target_ref:input.target_ref,snapshot_ref:input.snapshot_ref,purpose:input.purpose,approval_ref:{id:randomUUID(),sha256:'d'.repeat(64)}};
    f.service.approveInputDraft(f.owner,f.scope,manifest);f.manual();
    rejected(()=>f.service.verifyRetainedInputDraft(f.owner,f.scope,manifest),403); // Activation approval is insufficient.
    f.retainedInputApprove();
    const before=JSON.stringify(f.db.prepare('SELECT * FROM ops_browser_artifacts').all())+JSON.stringify(f.db.prepare('SELECT * FROM audit').all()),
      result=f.service.verifyRetainedInputDraft(f.owner,f.scope,manifest,{target_ref:input.target_ref,snapshot_ref:input.snapshot_ref});
    assert.deepEqual(result,{input_ref:{id:staged.artifact_ref.id,sha256:staged.artifact_ref.sha256},target_ref:input.target_ref,snapshot_ref:input.snapshot_ref,
      purpose_sha256:browserArtifactByteHash(Buffer.from(input.purpose)),approval_ref:manifest.approval_ref});
    assert.ok(!Object.hasOwn(result,'bytes')&&!Object.hasOwn(result,'text'));
    assert.equal(JSON.stringify(f.db.prepare('SELECT * FROM ops_browser_artifacts').all())+JSON.stringify(f.db.prepare('SELECT * FROM audit').all()),before);
    rejected(()=>f.service.resolveInputDraft(f.owner,f.scope,manifest),403);
    rejected(()=>f.store.openRead(f.owner,f.scope,staged.artifact_ref.id,'model'),403);
    for(const extra of [{purpose:'Changed purpose'},{target_ref:{...input.target_ref,id:randomUUID()}},{snapshot_ref:{...input.snapshot_ref,sha256:'a'.repeat(64)}},
      {artifact_ref:{...manifest.artifact_ref,byte_count:manifest.artifact_ref.byte_count+1}},{approval_ref:{...manifest.approval_ref,id:randomUUID()}}])
      rejected(()=>f.service.verifyRetainedInputDraft(f.owner,f.scope,{...manifest,...extra}),403);
    rejected(()=>f.service.verifyRetainedInputDraft(f.owner,f.scope,manifest,{target_ref:{...input.target_ref,sha256:'a'.repeat(64)}}),403);
    f.retainedInputApprove(false);rejected(()=>f.service.verifyRetainedInputDraft(f.owner,f.scope,manifest),403);f.retainedInputApprove();
    const copies=[],race=createBrowserArtifactsService({store:f.store,files:{...f.files,read:(...args)=>{const copy=f.files.read(...args);copies.push(copy);f.retainedInputApprove(false);return copy;}}});
    rejected(()=>race.verifyRetainedInputDraft(f.owner,f.scope,manifest),403);assert.ok(copies[0].every(v=>v===0));
    assert.equal(f.db.prepare('SELECT count(*) n FROM ops_browser_artifact_read_leases').get().n,0);
    f.retainedInputApprove();f.advance(f.configuration.budgets.max_seconds*1000+1);
    rejected(()=>f.service.verifyRetainedInputDraft(f.owner,f.scope,manifest),410);
  }finally{f.close();}
});

test('retained clipboard verification exposes no text and refuses changed, cancelled, terminal or stale-generation sources',async()=>{
  const f=fixture();
  try{
    const a=await f.service.clipboardImport(f.owner,f.scope,{text:'Private clipboard used before takeover'}),pin={id:a.id,sha256:a.sha256};f.manual();
    assert.deepEqual(f.service.verifyRetainedClipboard(f.owner,f.scope,pin),{clipboard_ref:pin});
    rejected(()=>f.service.resolveClipboard(f.owner,f.scope,a.id),403);
    rejected(()=>f.service.verifyRetainedClipboard(f.owner,f.scope,{...pin,sha256:'a'.repeat(64)}),403);
    rejected(()=>f.service.verifyRetainedClipboard(f.owner,f.scope,{...pin,manual_auth:true}),400);
    const copies=[],race=createBrowserArtifactsService({store:f.store,files:{...f.files,read:(...args)=>{const copy=f.files.read(...args);copies.push(copy);f.newFence();return copy;}}});
    rejected(()=>race.verifyRetainedClipboard(f.owner,f.scope,pin),409);assert.ok(copies[0].every(v=>v===0));
    assert.equal(f.db.prepare('SELECT count(*) n FROM ops_browser_artifact_read_leases').get().n,0);
  }finally{f.close();}
  const f2=fixture();try{
    const a=await f2.service.clipboardImport(f2.owner,f2.scope,{text:'Current private clipboard'}),pin={id:a.id,sha256:a.sha256};
    f2.terminal();rejected(()=>f2.service.verifyRetainedClipboard(f2.owner,f2.scope,pin),409);f2.restore();
    f2.store.cancelAttempt(f2.scope);rejected(()=>f2.service.verifyRetainedClipboard(f2.owner,f2.scope,pin),410);
  }finally{f2.close();}
});
