import { z } from 'zod';
import { createOperationalEvidenceStore } from './operational-evidence-store.js';
import { evidenceHash, evidencePermission } from './operational-evidence-logic.js';
import { fail, parse, validId } from './operational-projects-logic.js';

export const MAX_IMAGE_BYTES=8388608;
const DAY=86400000;
const uploadSchema=z.object({idempotency_key:z.string().uuid(),byte_count:z.number().int().min(1).max(MAX_IMAGE_BYTES),
  mime:z.enum(['image/png','image/jpeg']),sha256:z.string().regex(/^[a-f0-9]{64}$/),kind:z.enum(['raw','derivative']),
  parent_raw_id:z.string().uuid().nullable().default(null),source_kind:z.enum(['manual','recapshare_still']).default('manual')}).strict()
  .refine(v=>(v.kind==='raw')===(v.parent_raw_id===null));

// No DB locator, filesystem, decoder or HTTP dependency. Every policy decision
// including maintenance selection is repeated under an immediate transaction.
export function createEvidenceIntake(ctx,{installationBytes,accountBytes=1073741824,verifyFile}={}) {
  if(!Number.isSafeInteger(installationBytes)||installationBytes<2*MAX_IMAGE_BYTES ||
    !Number.isSafeInteger(accountBytes)||accountBytes<2*MAX_IMAGE_BYTES) throw new Error('Finite evidence quotas required');
  const {one,all,run,tx,access,event,bump,now,uuid}=ctx;
  const later=ms=>new Date(Date.parse(now())+ms).toISOString();
  const validated=o=>!!one(`SELECT 1 FROM ops_evidence_validations v JOIN ops_evidence_files f ON f.id=v.file_id
    WHERE v.object_id=? AND f.state='sealed'`,o.id);
  const metadata=createOperationalEvidenceStore({...ctx,validated});
  function demo(actor,project,id,write=true) {
    const {p,role}=access(actor,project);
    if(!validId(id)) fail(404,'Evidence not found');
    const d=one('SELECT * FROM ops_demonstrations WHERE project_id=? AND id=?',project,id);
    if(!d) fail(404,'Evidence not found');
    if(write) evidencePermission(role,actor,d,'upload',!!p.archived_at);
    return d;
  }
  function upload(actor,project,did,id,write=true) {
    demo(actor,project,did,write);
    if(!validId(id)) fail(404,'Upload not found');
    const u=one('SELECT * FROM ops_evidence_uploads WHERE project_id=? AND demonstration_id=? AND id=? AND actor_id=?',project,did,id,actor.id);
    if(!u) fail(404,'Upload not found');
    return u;
  }
  const live=u=>{if(u.expires_at<=now() || ['cancelled','expired'].includes(u.state)) fail(409,'Upload closed');};
  const idle=u=>{if(u.busy_token && u.busy_until>now()) fail(409,'Upload busy');};
  const status=u=>({id:u.id,state:u.expires_at<=now()&&['reserved','received'].includes(u.state)?'expired':u.state,
    expires_at:u.expires_at,private_expires_at:new Date(Date.parse(u.created_at)+7*DAY).toISOString(),object_id:u.object_id});
  function audit(actor,u,action) { bump(u.project_id); event(actor,u.project_id,action,u.id); }
  const file=(id,slot)=>one('SELECT * FROM ops_evidence_files WHERE upload_id=? AND slot=?',id,slot);
  const held=id=>one('SELECT held FROM ops_evidence_holds WHERE object_id=? ORDER BY sequence DESC LIMIT 1',id)?.held===1;
  const published=id=>!!one('SELECT 1 FROM ops_demonstration_revision_items WHERE object_id=?',id);
  function candidate(f) {
    if(!f || ['deleted','missing'].includes(f.state)) return null;
    if(one('SELECT 1 FROM ops_evidence_read_leases WHERE file_id=? AND expires_at>?',f.id,now())) return null;
    const u=one('SELECT * FROM ops_evidence_uploads WHERE id=?',f.upload_id);
    if(u.busy_token && u.busy_until>now()) return null;
    const v=one('SELECT object_id FROM ops_evidence_validations WHERE file_id=?',f.id);
    if(!v) return (['cancelled','expired','finalized'].includes(u.state)||u.expires_at<=now()) ? {file_id:f.id,reason:'abandoned',upload_id:u.id} : null;
    const o=one('SELECT * FROM ops_evidence_objects WHERE id=?',v.object_id);
    if(held(o.id)) return null;
    const disposition=one(`SELECT min(COALESCE(delete_after,strftime('%Y-%m-%dT%H:%M:%fZ',created_at,'+1 day'))) AS deadline
      FROM ops_evidence_dispositions WHERE object_id=?`,o.id);
    const expiry=new Date(Date.parse(o.expires_at)+DAY).toISOString();
    if((disposition?.deadline && disposition.deadline<=now()) || (!published(o.id) && expiry<=now())) {
      return {file_id:f.id,object_id:o.id,upload_id:u.id,reason:disposition?.deadline?'disposition':'expiry'};
    }
    return null;
  }
  return {
    ...metadata,
    // Only a runtime with the real D2 file adapter can enable guide evidence.
    // Caller holds Operations authorization and (for writes) the immediate lock.
    ...(verifyFile ? {guideReference(project,ref) {
      const result=metadata.sharedReference(project,ref);
      const receipt=one(`SELECT f.id,f.sha256,f.byte_count,o.sha256 AS object_hash,o.byte_count AS object_bytes
        FROM ops_evidence_validations v JOIN ops_evidence_files f ON f.id=v.file_id
        JOIN ops_evidence_objects o ON o.id=v.object_id
        JOIN ops_evidence_uploads u ON u.id=v.upload_id
        WHERE o.project_id=? AND o.demonstration_id=? AND o.id=? AND o.kind='derivative' AND o.mime='image/png'
          AND f.state='sealed' AND f.upload_id=u.id AND f.slot='output'
          AND u.project_id=o.project_id AND u.demonstration_id=o.demonstration_id
          AND u.actor_id=o.uploader_id AND u.object_id=o.id AND u.state='finalized'
          AND u.kind='derivative' AND u.parent_raw_id=o.parent_raw_id
          AND v.validator='operations-still-v1'`,project,ref.demonstration_id,ref.object_id);
      if(!receipt || receipt.sha256!==receipt.object_hash || receipt.byte_count!==receipt.object_bytes) fail(409,'Evidence unavailable or integrity failure');
      try {verifyFile(receipt.id,{sha256:receipt.object_hash,byte_count:receipt.object_bytes});}
      catch {fail(409,'Evidence unavailable or integrity failure');}
      return result;
    }} : {}),
    workspace(actor,project,did,input={}) {
      const d=demo(actor,project,did,false);
      if(d.created_by!==actor.id) fail(404,'Evidence not found');
      const q=parse(z.object({after:z.string().uuid().optional()}).strict(),input);
      const rows=all('SELECT * FROM ops_evidence_uploads WHERE project_id=? AND demonstration_id=? AND actor_id=? AND id>? ORDER BY id LIMIT 26',project,did,actor.id,q.after||'');
      const uploads=rows.slice(0,25).map(u=>({...status(u),kind:u.kind,parent_raw_id:u.parent_raw_id,
        idempotency_key:u.idempotency_key,byte_count:u.expected_bytes,mime:u.expected_mime,sha256:u.expected_sha256}));
      const objects=uploads.filter(u=>u.object_id).map(u=>{
        const o=metadata.object(actor,project,did,u.object_id);
        const annotations=o.available ? all(`SELECT a.id,a.predecessor_id,a.content_hash,p.label,p.text,p.rectangle_json
          FROM ops_evidence_annotations a JOIN ops_evidence_annotation_payloads p ON p.annotation_id=a.id
          WHERE a.project_id=? AND a.demonstration_id=? AND a.object_id=? ORDER BY a.created_at,a.id`,project,did,o.id)
          .filter(a=>a.content_hash===evidenceHash({label:a.label,text:a.text,rectangle:a.rectangle_json?JSON.parse(a.rectangle_json):null})) : [];
        return {...o,held:held(o.id),annotations};
      });
      return {uploads,objects,next_cursor:rows.length>25?rows[24].id:null};
    },
    reserve(actor,project,did,input) {
      const v=parse(uploadSchema,input);
      return tx(()=>{
        demo(actor,project,did);
        const hash=evidenceHash({demonstration_id:did,...v});
        const old=one('SELECT * FROM ops_evidence_uploads WHERE project_id=? AND actor_id=? AND idempotency_key=?',project,actor.id,v.idempotency_key);
        if(old) { if(old.payload_hash!==hash) fail(409,'Idempotency key already used'); return status(old); }
        if(v.parent_raw_id) {
          const raw=metadata.object(actor,project,did,v.parent_raw_id);
          if(!raw.available || raw.kind!=='raw') fail(409,'Original unavailable');
        }
        // Include both durable objects and outstanding reservations in image limits.
        const count=one(`SELECT count(*) AS n FROM ops_evidence_uploads WHERE demonstration_id=? AND kind=?
          AND (? IS NULL OR parent_raw_id=?) AND state NOT IN ('cancelled','expired')`,did,v.kind,v.parent_raw_id,v.parent_raw_id).n;
        if(count>=(v.kind==='raw'?20:3)) fail(409,'Evidence image limit');
        const active=where=>one(`SELECT count(*) AS n FROM ops_evidence_uploads WHERE ${where}
          AND ((state IN ('reserved','received') AND expires_at>?) OR busy_until>?)`,where==='actor_id=?'?actor.id:project,now(),now()).n;
        const globalActive=one(`SELECT count(*) AS n FROM ops_evidence_uploads
          WHERE (state IN ('reserved','received') AND expires_at>?) OR busy_until>?`,now(),now()).n;
        if(active('actor_id=?')>=2 || active('project_id=?')>=4 || globalActive>=8) fail(429,'Upload concurrency limit');
        const charge=v.byte_count+MAX_IMAGE_BYTES;
        const used=(where,args=[])=>one(`SELECT COALESCE(sum(f.charged_bytes),0) AS n FROM ops_evidence_files f
          JOIN ops_evidence_uploads u ON u.id=f.upload_id ${where}`, ...args).n;
        for(const [occupied,limit] of [[used(''),installationBytes],[used('WHERE u.actor_id=?',[actor.id]),accountBytes],
          [used('WHERE u.project_id=?',[project]),1073741824],[used('WHERE u.demonstration_id=?',[did]),209715200]]) {
          if(occupied+charge>limit) fail(413,'Evidence capacity exhausted');
        }
        const id=uuid(),time=now();
        run(`INSERT INTO ops_evidence_uploads(id,project_id,demonstration_id,actor_id,idempotency_key,payload_hash,
          expected_bytes,expected_mime,expected_sha256,kind,parent_raw_id,source_kind,created_at,expires_at,state)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'reserved')`,id,project,did,actor.id,v.idempotency_key,hash,v.byte_count,v.mime,v.sha256,v.kind,v.parent_raw_id,v.source_kind,time,later(DAY));
        for(const [slot,size] of [['input',v.byte_count],['output',MAX_IMAGE_BYTES]]) run("INSERT INTO ops_evidence_files(id,upload_id,slot,charged_bytes,state) VALUES (?,?,?,?,'allocated')",uuid(),id,slot,size);
        audit(actor,{project_id:project,id},'evidence_upload_reserved');
        return status(one('SELECT * FROM ops_evidence_uploads WHERE id=?',id));
      });
    },
    uploadStatus(actor,project,did,id) { return status(upload(actor,project,did,id,false)); },
    claim(actor,project,did,id,action) {
      return tx(()=>{
        const u=upload(actor,project,did,id); if(u.state==='finalized') return {...u,receipt:status(u)};
        live(u); idle(u);
        if(action==='finalize' && u.state!=='received') fail(409,'Upload bytes required');
        const token=uuid();
        run('UPDATE ops_evidence_uploads SET busy_token=?,busy_until=? WHERE id=?',token,later(60000),id);
        return {...u,token,input:file(id,'input'),output:file(id,'output')};
      });
    },
    check(actor,u) {
      const current=upload(actor,u.project_id,u.demonstration_id,u.id);
      live(current);
      if(current.busy_token!==u.token || current.busy_until<=now()) fail(409,'Upload lease lost');
      return current;
    },
    checkRetry(actor,u) { return upload(actor,u.project_id,u.demonstration_id,u.id); },
    withLease(actor,u,write) {
      // Synchronous filesystem work shares the database lock with the last lease
      // check; expired workers cannot create files after maintenance freed quota.
      return tx(()=>{this.check(actor,u);return write();});
    },
    received(actor,u,proof) {
      return tx(()=>{
        this.check(actor,u);
        if(proof.sha256!==u.expected_sha256 || proof.byte_count!==u.expected_bytes) fail(400,'Image digest or size mismatch');
        run("UPDATE ops_evidence_files SET state='sealed',sha256=?,byte_count=?,charged_bytes=? WHERE id=?",proof.sha256,proof.byte_count,proof.byte_count,u.input.id);
        run("UPDATE ops_evidence_uploads SET state='received',busy_token=NULL,busy_until=NULL WHERE id=?",u.id);
        return status(one('SELECT * FROM ops_evidence_uploads WHERE id=?',u.id));
      });
    },
    release(u) { tx(()=>run('UPDATE ops_evidence_uploads SET busy_token=NULL,busy_until=NULL WHERE id=? AND busy_token=?',u.id,u.token)); },
    finalize(actor,u,proof) {
      return tx(()=>{
        this.check(actor,u);
        // Only an injected decoder/service can reach this internal API. Never
        // spread an HTTP body into this trusted validation receipt.
        if(!proof || !['image/png','image/jpeg'].includes(proof.mime) || !Number.isInteger(proof.width) || !Number.isInteger(proof.height) ||
          proof.width<1 || proof.height<1 || proof.width>8192 || proof.height>8192 || proof.width*proof.height>16000000 ||
          !/^[a-f0-9]{64}$/.test(proof.sha256) || proof.byte_count<1 || proof.byte_count>MAX_IMAGE_BYTES) fail(400,'Invalid decoded image');
        const f=u.kind==='raw'?u.input:u.output;
        const id=uuid();
        run("UPDATE ops_evidence_files SET state='sealed',sha256=?,byte_count=?,charged_bytes=? WHERE id=?",proof.sha256,proof.byte_count,proof.byte_count,f.id);
        run('INSERT INTO ops_evidence_objects VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',id,u.project_id,u.demonstration_id,u.actor_id,u.kind,u.parent_raw_id,
          proof.sha256,proof.mime,proof.byte_count,proof.width,proof.height,u.created_at,new Date(Date.parse(u.created_at)+7*DAY).toISOString(),u.source_kind);
        run('INSERT INTO ops_evidence_validations VALUES (?,?,?,?,?)',id,u.id,f.id,'operations-still-v1',now());
        run("UPDATE ops_evidence_uploads SET state='finalized',object_id=?,busy_token=NULL,busy_until=NULL WHERE id=?",id,u.id);
        run('UPDATE ops_demonstrations SET revision=revision+1 WHERE id=?',u.demonstration_id);
        audit(actor,u,'evidence_upload_finalized');
        return status(one('SELECT * FROM ops_evidence_uploads WHERE id=?',u.id));
      });
    },
    cancelUpload(actor,project,did,id) {
      return tx(()=>{
        const u=upload(actor,project,did,id);
        if(u.state==='cancelled') return status(u);
        if(u.state==='finalized') fail(409,'Use an evidence deletion request');
        // Closing a lease prevents an in-flight receiver/decoder from committing.
        run("UPDATE ops_evidence_uploads SET state='cancelled' WHERE id=?",id);
        audit(actor,u,'evidence_upload_cancelled'); return status({...u,state:'cancelled'});
      });
    },
    download(actor,project,did,id) {
      const o=metadata.object(actor,project,did,id);
      if(!o.available) fail(410,'Evidence unavailable');
      const f=one(`SELECT f.* FROM ops_evidence_files f JOIN ops_evidence_validations v ON v.file_id=f.id WHERE v.object_id=? AND f.state='sealed'`,id);
      if(!f) fail(410,'Evidence unavailable');
      return {object:o,file:f};
    },
    openRead(actor,project,did,id) {
      return tx(()=>{
        const f=this.download(actor,project,did,id).file,lease=uuid();
        run('DELETE FROM ops_evidence_read_leases WHERE expires_at<=?',now());
        if(one('SELECT count(*) n FROM ops_evidence_read_leases').n>=8) fail(429,'Download concurrency limit');
        run('INSERT INTO ops_evidence_read_leases VALUES (?,?,?)',lease,f.id,later(60000));return lease;
      });
    },
    checkRead(actor,project,did,id,lease) {
      this.download(actor,project,did,id);
      if(!one('SELECT 1 FROM ops_evidence_read_leases WHERE id=? AND expires_at>?',lease,now())) fail(410,'Download lease expired');
    },
    closeRead(lease) {run('DELETE FROM ops_evidence_read_leases WHERE id=?',lease);},
    maintenancePlan({limit=25,after=''}={}) {
      if(!Number.isInteger(limit)||limit<1||limit>100 || (after && !validId(after))) fail(400,'Invalid maintenance bounds');
      return tx(()=>{
        const rows=all("SELECT * FROM ops_evidence_files WHERE id>? AND state NOT IN ('deleted','missing') ORDER BY id LIMIT ?",after,limit);
        return {items:rows.map(candidate).filter(Boolean),scanned:rows.length,next_cursor:rows.length===limit?rows.at(-1).id:null};
      });
    },
    maintenanceApply(fileId,remove) {
      if(!validId(fileId)) fail(400,'Invalid file identity');
      return tx(()=>{
        const receipt=one('SELECT * FROM ops_evidence_deletions WHERE file_id=?',fileId);
        if(receipt) return receipt;
        const f=one('SELECT * FROM ops_evidence_files WHERE id=?',fileId),c=candidate(f);
        if(!c) return {file_id:fileId,outcome:'retained'};
        const u=one('SELECT * FROM ops_evidence_uploads WHERE id=?',c.upload_id);
        // Audit first: failure must not perform an irreversible unlink.
        event({id:u.actor_id},u.project_id,'evidence_maintenance',c.object_id||u.id,{reason:c.reason});
        bump(u.project_id);
        if(c.object_id && c.reason==='expiry') run('INSERT INTO ops_evidence_dispositions VALUES (?,?,?,?,?,?,?,?,?,?)',uuid(),u.project_id,u.demonstration_id,c.object_id,null,u.actor_id,now(),'restrict','retention',null);
        const outcome=remove(fileId); // synchronous; no hold-vs-unlink interleave
        if(!['missing','deleted'].includes(outcome)) throw new Error('Invalid deletion receipt');
        run('UPDATE ops_evidence_files SET state=?,charged_bytes=0,deleted_at=? WHERE id=?',outcome,now(),fileId);
        run('INSERT INTO ops_evidence_deletions VALUES (?,?,?)',fileId,now(),outcome);
        if(u.expires_at<=now() && ['reserved','received'].includes(u.state)) run("UPDATE ops_evidence_uploads SET state='expired',busy_token=NULL,busy_until=NULL WHERE id=?",u.id);
        if(c.object_id) {
          run('DELETE FROM ops_evidence_annotation_payloads WHERE annotation_id IN (SELECT id FROM ops_evidence_annotations WHERE object_id=?)',c.object_id);
          run('DELETE FROM ops_demonstration_revision_payloads WHERE revision_id IN (SELECT revision_id FROM ops_demonstration_revision_items WHERE object_id=?)',c.object_id);
        }
        return {file_id:fileId,outcome};
      });
    },
    missing(fileId) {
      // Called only after an authorized open found ENOENT, never for generic I/O
      // or integrity errors. Tombstone availability and retain a durable receipt.
      return tx(()=>{
        const f=one('SELECT * FROM ops_evidence_files WHERE id=?',fileId);
        if(!f || ['missing','deleted'].includes(f.state)) return;
        const u=one('SELECT * FROM ops_evidence_uploads WHERE id=?',f.upload_id);
        event({id:u.actor_id},u.project_id,'evidence_file_missing',u.id);
        bump(u.project_id);
        run("UPDATE ops_evidence_files SET state='missing',charged_bytes=0,deleted_at=? WHERE id=?",now(),fileId);
        run("INSERT INTO ops_evidence_deletions VALUES (?,?,'missing')",fileId,now());
      });
    },
  };
}
