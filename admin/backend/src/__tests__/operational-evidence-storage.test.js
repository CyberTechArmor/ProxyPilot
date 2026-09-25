import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {operationsFixture} from './helpers/operations-fixture.js';
import {createOperationsStore} from '../lib/operational-projects-store.js';
import {operationalEvidenceMigration1103} from '../lib/operational-evidence-schema.js';
import {operationalEvidenceMigration1104} from '../lib/operational-evidence-storage-schema.js';
import {createEvidenceIntake} from '../lib/operational-evidence-intake.js';
import {createEvidenceFiles,byteHash} from '../lib/operational-evidence-files.js';
import {evidenceConfiguration} from '../lib/operational-evidence-runtime.js';

function fixture(quota=1073741824,accountBytes=1073741824) {
  const f=operationsFixture();let time=Date.now();
  operationalEvidenceMigration1103(f.adapter);operationalEvidenceMigration1104(f.adapter);
  const store=createOperationsStore(f.adapter,{now:()=>new Date(time).toISOString(),evidenceFactory:c=>createEvidenceIntake(c,{installationBytes:quota,accountBytes})});
  const author=f.addUser(),other=f.addUser(),outsider=f.addUser('admin'),project=store.create(author,{name:'Images'}).id;
  const demo=store.evidence.create(author,project,{title:'Private',idempotency_key:randomUUID()}).id;
  return {...f,store,e:store.evidence,author,other,outsider,project,demo,advance:ms=>{time+=ms;},
    reserve(input={}) {return store.evidence.reserve(author,project,demo,{idempotency_key:randomUUID(),byte_count:3,mime:'image/png',sha256:byteHash(Buffer.from('abc')),kind:'raw',...input});}};
}
function rejected(fn,status) {assert.throws(fn,e=>e.status===status);}
function finalize(f,u) {
  let lease=f.e.claim(f.author,f.project,f.demo,u.id,'bytes');
  f.e.received(f.author,lease,{byte_count:3,sha256:byteHash(Buffer.from('abc'))});
  lease=f.e.claim(f.author,f.project,f.demo,u.id,'finalize');
  return f.e.finalize(f.author,lease,{width:1,height:1,mime:'image/png',byte_count:3,sha256:byteHash(Buffer.from('abc'))});
}

test('D2 gates are exact false defaults; finite quota and reviewed boundary required',()=>{
  for(const env of [{},{OPERATIONS_ENABLED:'true'},{OPERATIONS_ENABLED:'true',OPERATIONS_EVIDENCE_ENABLED:'true'},
    {OPERATIONS_ENABLED:'TRUE',OPERATIONS_EVIDENCE_ENABLED:'true'}]) assert.equal(evidenceConfiguration(env).enabled,false);
});
test('reservation identity, quotas, concurrent slots, cancellation and durable retries',()=>{
  const f=fixture(16777222);
  try {
    const key=randomUUID(),u=f.reserve({idempotency_key:key});assert.equal(f.reserve({idempotency_key:key}).id,u.id);
    rejected(()=>f.reserve({idempotency_key:key,sha256:'a'.repeat(64)}),409);
    const second=f.reserve();rejected(()=>f.reserve(),429);
    f.e.cancelUpload(f.author,f.project,f.demo,u.id);
    rejected(()=>f.reserve(),413); // cancelled files still consume their allocation
    const plan=f.e.maintenancePlan();assert.equal(plan.items.length,2);
    for(const item of plan.items) f.e.maintenanceApply(item.file_id,()=> 'missing');
    assert.equal(f.reserve().state,'reserved');
    assert.equal(f.e.uploadStatus(f.author,f.project,f.demo,u.id).state,'cancelled');
    assert.equal(second.state,'reserved');
  } finally {f.close();}
});
test('author privacy, current account, grant, role, child scope and archive checks precede leases',()=>{
  const f=fixture();
  try {
    const u=f.reserve();
    rejected(()=>f.e.claim(f.outsider,f.project,f.demo,u.id,'bytes'),404);
    f.store.grant(f.author,f.project,f.other.id,f.store.get(f.author,f.project).revision,{role:'editor'});
    rejected(()=>f.e.claim(f.other,f.project,f.demo,u.id,'bytes'),403);
    rejected(()=>f.e.uploadStatus(f.other,f.project,f.demo,u.id),404);
    const p2=f.store.create(f.author,{name:'Second'}).id;
    rejected(()=>f.e.claim(f.author,p2,f.demo,u.id,'bytes'),404);
    f.db.prepare("UPDATE users SET role='pending' WHERE id=?").run(f.author.id);
    assert.throws(()=>f.e.claim(f.author,f.project,f.demo,u.id,'bytes'));
    f.db.prepare("UPDATE users SET role='user' WHERE id=?").run(f.author.id);
    f.store.archive(f.author,f.project,f.store.get(f.author,f.project).revision,{reason:'Archive'});
    rejected(()=>f.e.claim(f.author,f.project,f.demo,u.id,'bytes'),409);
  } finally {f.close();}
});
test('account quota spans projects; project concurrency spans authors; cancelled reservations stay occupied',()=>{
  const f=fixture(4*1073741824,16777216);
  try {
    const first=f.reserve();f.e.cancelUpload(f.author,f.project,f.demo,first.id);
    const p2=f.store.create(f.author,{name:'Other account scope'}).id,d2=f.e.create(f.author,p2,{title:'Other',idempotency_key:randomUUID()}).id;
    rejected(()=>f.e.reserve(f.author,p2,d2,{idempotency_key:randomUUID(),byte_count:3,mime:'image/png',sha256:'a'.repeat(64),kind:'raw'}),413);
  } finally {f.close();}
  const g=fixture(4*1073741824);
  try {
    g.reserve();g.reserve();
    g.store.grant(g.author,g.project,g.other.id,g.store.get(g.author,g.project).revision,{role:'operator'});
    const d=g.e.create(g.other,g.project,{title:'Other',idempotency_key:randomUUID()}).id;
    const input=()=>({idempotency_key:randomUUID(),byte_count:3,mime:'image/png',sha256:'a'.repeat(64),kind:'raw'});
    g.e.reserve(g.other,g.project,d,input());g.e.reserve(g.other,g.project,d,input());
    g.store.grant(g.author,g.project,g.outsider.id,g.store.get(g.author,g.project).revision,{role:'reviewer'});
    const d3=g.e.create(g.outsider,g.project,{title:'Third',idempotency_key:randomUUID()}).id;
    rejected(()=>g.e.reserve(g.outsider,g.project,d3,input()),429);
  } finally {g.close();}
});
test('demonstration and project occupied-byte ceilings include cancelled and pending deletion files',()=>{
  const f=fixture(4*1073741824,2*1073741824);
  try {
    // No bytes written: these are real outstanding allocations, not objects.
    let refused=false;
    for(let n=0;n<30;n++) {
      try {const u=f.reserve();f.e.cancelUpload(f.author,f.project,f.demo,u.id);}
      catch(e) {assert.equal(e.status,413);refused=true;break;}
    }
    assert.equal(refused,true);
    let count=0;
    for(let dn=0;dn<8;dn++) {
      const demo=f.e.create(f.author,f.project,{title:'Capacity',idempotency_key:randomUUID()}).id;
      for(let n=0;n<20;n++) {
        try {
          const u=f.e.reserve(f.author,f.project,demo,{idempotency_key:randomUUID(),byte_count:8388608,mime:'image/png',sha256:'a'.repeat(64),kind:'raw'});
          f.e.cancelUpload(f.author,f.project,demo,u.id);count++;
        } catch(e) {assert.equal(e.status,413);break;}
      }
    }
    assert.ok(count>40 && count<64);
    assert.ok(f.db.prepare('SELECT sum(charged_bytes) n FROM ops_evidence_files').get().n<=1073741824);
  } finally {f.close();}
});
test('lease races, cancellation during receipt, expiry cannot revive, audit failure rolls reservation back',()=>{
  const f=fixture();
  try {
    const u=f.reserve(),lease=f.e.claim(f.author,f.project,f.demo,u.id,'bytes');
    rejected(()=>f.e.claim(f.author,f.project,f.demo,u.id,'bytes'),409);
    f.e.cancelUpload(f.author,f.project,f.demo,u.id);
    rejected(()=>f.e.received(f.author,lease,{byte_count:3,sha256:u.sha256}),409);
    assert.equal(f.e.maintenancePlan().items.length,0);
    f.e.release(lease);assert.equal(f.e.maintenancePlan().items.length,2);
    const next=f.reserve();f.advance(86400001);
    rejected(()=>f.e.claim(f.author,f.project,f.demo,next.id,'bytes'),409);
    f.db.exec("CREATE TRIGGER deny_event BEFORE INSERT ON ops_project_events BEGIN SELECT RAISE(ABORT,'audit failure'); END;");
    const before=f.db.prepare('SELECT count(*) n FROM ops_evidence_uploads').get().n;
    assert.throws(()=>f.reserve());assert.equal(f.db.prepare('SELECT count(*) n FROM ops_evidence_uploads').get().n,before);
  } finally {f.close();}
});
test('validated receipt required, finalization immutable/idempotent, missing receipt withholds bytes',()=>{
  const f=fixture();
  try {
    const fake=randomUUID(),time=new Date().toISOString();
    f.db.prepare('INSERT INTO ops_evidence_objects VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(fake,f.project,f.demo,f.author.id,'raw',null,'a'.repeat(64),'image/png',3,1,1,time,'2099-01-01T00:00:00.000Z','manual');
    assert.equal(f.e.object(f.author,f.project,f.demo,fake).available,false);
    rejected(()=>f.e.download(f.author,f.project,f.demo,fake),410);
    const u=f.reserve(),result=finalize(f,u);
    assert.equal(f.e.claim(f.author,f.project,f.demo,u.id,'finalize').receipt.object_id,result.object_id);
    const download=f.e.download(f.author,f.project,f.demo,result.object_id);
    assert.equal(download.object.available,true);
    assert.throws(()=>f.db.prepare("UPDATE ops_evidence_validations SET validator='fake'").run());
    assert.throws(()=>f.db.prepare('DELETE FROM ops_evidence_uploads').run());
    f.e.missing(download.file.id);
    rejected(()=>f.e.download(f.author,f.project,f.demo,result.object_id),410);
    assert.equal(f.e.object(f.author,f.project,f.demo,result.object_id).available,false);
  } finally {f.close();}
});
test('unlink followed by transaction failure keeps charge until missing-file retry',()=>{
  const f=fixture();try {
    const u=f.reserve();f.e.cancelUpload(f.author,f.project,f.demo,u.id);
    const item=f.e.maintenancePlan().items[0];let present=true;
    assert.throws(()=>f.e.maintenanceApply(item.file_id,()=>{present=false;throw Error('crash after unlink');}));
    assert.equal(present,false);
    assert.ok(f.db.prepare('SELECT charged_bytes FROM ops_evidence_files WHERE id=?').get(item.file_id).charged_bytes>0);
    assert.equal(f.e.maintenanceApply(item.file_id,()=> 'missing').outcome,'missing');
    assert.equal(f.db.prepare('SELECT charged_bytes FROM ops_evidence_files WHERE id=?').get(item.file_id).charged_bytes,0);
  } finally {f.close();}
});
test('holds, read leases, grace, deletion failure, repeat apply, audit rollback and deleted author',()=>{
  const f=fixture();
  try {
    const result=finalize(f,f.reserve()),id=result.object_id;
    const revision=()=>f.e.get(f.author,f.project,f.demo).demonstration_revision;
    f.e.hold(f.author,f.project,f.demo,revision(),{object_id:id,held:true,reason:'retention'});
    f.e.disposition(f.author,f.project,f.demo,revision(),{object_id:id,action:'delete_requested',reason:'privacy'});
    const target=f.db.prepare('SELECT file_id FROM ops_evidence_validations WHERE object_id=?').get(id).file_id;
    f.advance(86400001);assert.equal(f.e.maintenanceApply(target,()=>{throw Error('must not delete');}).outcome,'retained');
    f.e.hold(f.author,f.project,f.demo,revision(),{object_id:id,held:false,reason:'retention'});
    assert.throws(()=>f.e.maintenanceApply(target,()=>{throw Error('disk failure');}));
    assert.equal(f.db.prepare('SELECT charged_bytes FROM ops_evidence_files WHERE id=?').get(target).charged_bytes,3);
    f.db.exec("CREATE TRIGGER deny_event BEFORE INSERT ON ops_project_events BEGIN SELECT RAISE(ABORT,'audit failure'); END;");
    let touched=false;assert.throws(()=>f.e.maintenanceApply(target,()=>{touched=true;return 'deleted';}));assert.equal(touched,false);
    f.db.exec('DROP TRIGGER deny_event');f.db.prepare('DELETE FROM users WHERE id=?').run(f.author.id);
    assert.equal(f.e.maintenanceApply(target,()=> 'deleted').outcome,'deleted');
    assert.equal(f.e.maintenanceApply(target,()=>{throw Error('repeat');}).outcome,'deleted');
  } finally {f.close();}
});
test('active download lease prevents maintenance; expired private bytes receive grace',()=>{
  const f=fixture();try {
    const result=finalize(f,f.reserve()),id=result.object_id;
    f.advance(7*86400000-1000);
    const lease=f.e.openRead(f.author,f.project,f.demo,id);
    const target=f.e.download(f.author,f.project,f.demo,id).file.id;
    f.advance(2000);rejected(()=>f.e.download(f.author,f.project,f.demo,id),410);
    assert.equal(f.e.maintenanceApply(target,()=> 'deleted').outcome,'retained');
    f.e.closeRead(lease);f.advance(86400000);
    assert.equal(f.e.maintenanceApply(target,()=> 'missing').outcome,'missing');
  } finally {f.close();}
});
test('generated filesystem namespace refuses paths, symlinks, hardlinks, root swaps; siblings preserved',()=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'ops-d2-')),root=path.join(base,'private');fs.mkdirSync(root,{mode:0o700});
  fs.writeFileSync(path.join(base,'sentinel'),'keep');let files;
  try {
    files=createEvidenceFiles(root);const id=randomUUID(),bytes=Buffer.from('abc'),proof=files.write(id,bytes);
    assert.deepEqual(files.read(id,proof),bytes);
    for(const bad of ['../sentinel','..%2fsentinel','C:\\x','\\\\server\\share','CON','a:b','a/b','a%5cb',id+'.blob']) assert.throws(()=>files.read(bad,proof));
    assert.throws(()=>files.write(id,bytes));
    const linked=randomUUID();fs.linkSync(path.join(root,id+'.blob'),path.join(root,linked+'.blob'));
    assert.throws(()=>files.read(linked,proof));assert.throws(()=>files.remove(linked));
    fs.unlinkSync(path.join(root,linked+'.blob'));
    assert.equal(files.remove(id),'deleted');assert.equal(files.remove(id),'missing');
    files.close();files=null;
    const original=path.join(base,'original');fs.renameSync(root,original);fs.symlinkSync(original,root,'junction');
    assert.throws(()=>createEvidenceFiles(root));fs.unlinkSync(root);
    assert.equal(fs.readFileSync(path.join(base,'sentinel'),'utf8'),'keep');
  } finally {files?.close();fs.rmSync(base,{recursive:true,force:true});}
});
