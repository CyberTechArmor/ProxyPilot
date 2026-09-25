import { assertRevision, fail, parse, validId } from './operational-projects-logic.js';
import { evidenceHash, evidencePermission, evidenceSchemas as schemas } from './operational-evidence-logic.js';

// Metadata policy; D2 injects durable file validation. Absence of that boundary
// fails closed. D1 tests explicitly opt into their metadata-only fixture policy.
export function createOperationalEvidenceStore({one,all,run,tx,access,event,bump,now,uuid,validated=()=>false}) {
  function scoped(table, project, demo, id) {
    if (!validId(id)) fail(404,'Evidence not found');
    const row=one(`SELECT * FROM ${table} WHERE project_id=? AND demonstration_id=? AND id=?`,project,demo,id);
    if (!row) fail(404,'Evidence not found');
    return row;
  }
  function demonstration(project,id) {
    if (!validId(id)) fail(404,'Evidence not found');
    const d=one('SELECT * FROM ops_demonstrations WHERE project_id=? AND id=?',project,id);
    if (!d) fail(404,'Evidence not found');
    return d;
  }
  function restricted(project,demo,objectId,revisionId=null) {
    return !!one(`SELECT 1 FROM ops_evidence_dispositions WHERE project_id=? AND demonstration_id=?
      AND (object_id=? OR revision_id=?)`,project,demo,objectId,revisionId);
  }
  function shared(objectId) {
    return !!one('SELECT 1 FROM ops_demonstration_revision_items WHERE object_id=?',objectId);
  }
  function available(o) {
    if (!validated(o)) return false;
    if (restricted(o.project_id,o.demonstration_id,o.id)) return false;
    if (o.kind==='derivative' && shared(o.id)) return true;
    const hold=one('SELECT held FROM ops_evidence_holds WHERE object_id=? ORDER BY sequence DESC LIMIT 1',o.id);
    return o.expires_at>now() || hold?.held===1;
  }
  function safeObject(o) {
    return {id:o.id,sha256:o.sha256,mime:o.mime,byte_count:o.byte_count,width:o.width,height:o.height};
  }
  function retry(actor,project,action,v,fn) {
    const hash=evidenceHash({action,...v});
    const old=one('SELECT * FROM ops_evidence_receipts WHERE project_id=? AND actor_id=? AND idempotency_key=?',project,actor.id,v.idempotency_key);
    if (old) {
      if (old.payload_hash!==hash || old.action!==action) fail(409,'Idempotency key already used');
      return JSON.parse(old.result_json);
    }
    const result=fn();
    run('INSERT INTO ops_evidence_receipts VALUES (?,?,?,?,?,?)',project,actor.id,v.idempotency_key,action,hash,JSON.stringify(result));
    return result;
  }
  function change(actor,project,demoId,expected,action,v,fn) {
    return tx(()=>{
      const {p,role}=access(actor,project);
      const d=demonstration(project,demoId);
      evidencePermission(role,actor,d,action,!!p.archived_at);
      const apply=()=>{
        if (expected==null) fail(428,'Demonstration revision required');
        assertRevision(expected,d.revision);
        const {updates={},...output}=fn(d);
        run('UPDATE ops_demonstrations SET title=?,purpose=?,archived_at=?,revision=revision+1 WHERE id=?',
          updates.title ?? d.title,updates.purpose ?? d.purpose,updates.archived_at ?? d.archived_at,d.id);
        bump(project);
        event(actor,project,`evidence_${action}`,d.id,{demonstration_revision:d.revision+1});
        return {...output,demonstration_revision:d.revision+1};
      };
      return v?.idempotency_key ? retry(actor,project,action,{demonstration_id:demoId,...v},apply) : apply();
    });
  }
  function revisionView(project,demoId,rid) {
    const r=scoped('ops_demonstration_revisions',project,demoId,rid);
    const items=all('SELECT * FROM ops_demonstration_revision_items WHERE revision_id=? ORDER BY position',r.id);
    const summary=one('SELECT summary FROM ops_demonstration_revision_payloads WHERE revision_id=?',r.id);
    let withheld=restricted(project,demoId,null,r.id) || !summary || evidenceHash(summary.summary)!==r.summary_hash;
    const visible=items.map(item=>{
      const o=scoped('ops_evidence_objects',project,demoId,item.object_id);
      const a=scoped('ops_evidence_annotations',project,demoId,item.annotation_id);
      const payload=one('SELECT label,text,rectangle_json FROM ops_evidence_annotation_payloads WHERE annotation_id=?',a.id);
      const intact=payload && a.content_hash===evidenceHash({label:payload.label,text:payload.text,
        rectangle:payload.rectangle_json ? JSON.parse(payload.rectangle_json) : null});
      const ok=!withheld && available(o) && !!intact;
      if (!ok) withheld=true;
      return {position:item.position,object:safeObject(o),annotation_id:a.id,content_hash:a.content_hash,
        available:ok,annotation:ok ? payload : null};
    });
    // Withhold all dependent text when any selected object is restricted/missing.
    if (withheld) for (const item of visible) { item.annotation=null; item.available=false; }
    return {...r,summary:withheld ? null : summary.summary,
      available:!withheld,items:visible};
  }
  return {
    // Internal guide boundary: exact published membership, never a private object
    // lookup. Recompute the publication hash as well as removable text integrity.
    sharedReference(project,ref) {
      const r=scoped('ops_demonstration_revisions',project,ref.demonstration_id,ref.revision_id);
      const rows=all(`SELECT i.position,i.object_id,o.sha256,i.annotation_id,a.content_hash,
        o.uploader_id,a.actor_id FROM ops_demonstration_revision_items i
        JOIN ops_evidence_objects o ON o.id=i.object_id
        JOIN ops_evidence_annotations a ON a.id=i.annotation_id
        WHERE i.project_id=? AND i.demonstration_id=? AND i.revision_id=? ORDER BY i.position`,project,ref.demonstration_id,r.id);
      const item=rows.find(i=>i.position===ref.item_position && i.object_id===ref.object_id && i.annotation_id===ref.annotation_id);
      if(!item) fail(404,'Evidence not found');
      const d=demonstration(project,ref.demonstration_id);
      const provenance=[...new Set([d.created_by,r.publisher_id,...rows.flatMap(i=>[i.uploader_id,i.actor_id])])].sort();
      const items=rows.map(({position,object_id,sha256,annotation_id,content_hash})=>({position,object_id,sha256,annotation_id,content_hash}));
      if(JSON.stringify(provenance)!==r.provenance_json ||
        r.manifest_hash!==evidenceHash({format:1,items,provenance,summary_hash:r.summary_hash}) ||
        !revisionView(project,d.id,r.id).available) fail(409,'Evidence unavailable or integrity failure');
      const o=scoped('ops_evidence_objects',project,d.id,item.object_id);
      if(o.kind!=='derivative') fail(409,'Reviewed derivative required');
      return {sha256:o.sha256,annotation_hash:item.content_hash,publication_hash:r.manifest_hash,provenance};
    },
    create(actor,project,input) {
      const v=parse(schemas.create,input);
      return tx(()=>{
        const {p,role}=access(actor,project);
        evidencePermission(role,actor,null,'create',!!p.archived_at);
        return retry(actor,project,'create',v,()=>{
          if (v.context_version_id && !one('SELECT 1 FROM ops_guide_versions WHERE project_id=? AND id=?',project,v.context_version_id)) fail(404,'Guide not found');
          const id=uuid();
          run(`INSERT INTO ops_demonstrations(id,project_id,created_by,created_at,title,purpose,context_version_id)
            VALUES (?,?,?,?,?,?,?)`,id,project,actor.id,now(),v.title,v.purpose,v.context_version_id);
          bump(project); event(actor,project,'evidence_created',id);
          return {id,demonstration_revision:1};
        });
      });
    },
    list(actor,project,input={}) {
      access(actor,project); const q=parse(schemas.list,input);
      const rows=all(`SELECT d.id FROM ops_demonstrations d WHERE project_id=? AND id>?
        AND (created_by=? OR EXISTS(SELECT 1 FROM ops_demonstration_revisions r WHERE r.demonstration_id=d.id))
        ORDER BY id LIMIT ?`,project,q.after || '',actor.id,q.limit+1);
      return {demonstrations:rows.slice(0,q.limit).map(r=>this.get(actor,project,r.id)),next_cursor:rows.length>q.limit ? rows[q.limit-1].id : null};
    },
    get(actor,project,demoId) {
      const {role}=access(actor,project); const d=demonstration(project,demoId);
      const revisions=all('SELECT id FROM ops_demonstration_revisions WHERE project_id=? AND demonstration_id=? ORDER BY published_at,id',project,demoId)
        .map(r=>revisionView(project,demoId,r.id));
      if (d.created_by!==actor.id && !revisions.length) fail(404,'Evidence not found');
      return {id:d.id,created_by:d.created_by,archived_at:d.archived_at,revisions,
        ...(role==='owner' ? {demonstration_revision:d.revision} : {}),
        ...(d.created_by===actor.id ? {title:d.title,purpose:d.purpose,context_version_id:d.context_version_id,demonstration_revision:d.revision} : {})};
    },
    publication(actor,project,demoId,revisionId) {
      access(actor,project); demonstration(project,demoId);
      return revisionView(project,demoId,revisionId);
    },
    object(actor,project,demoId,objectId) {
      access(actor,project); const d=demonstration(project,demoId);
      const o=scoped('ops_evidence_objects',project,demoId,objectId);
      if (d.created_by!==actor.id && (o.kind==='raw' || !all('SELECT revision_id FROM ops_demonstration_revision_items WHERE object_id=?',o.id)
        .some(r=>!restricted(project,demoId,null,r.revision_id)))) fail(404,'Evidence not found');
      if (!available(o)) return {id:o.id,available:false};
      return {...safeObject(o),available:true,...(d.created_by===actor.id ? {kind:o.kind,expires_at:o.expires_at,parent_raw_id:o.parent_raw_id} : {})};
    },
    update(actor,project,demoId,expected,input) {
      const v=parse(schemas.update,input);
      return change(actor,project,demoId,expected,'update',v,()=>{
        return {ok:true,updates:v};
      });
    },
    annotate(actor,project,demoId,expected,input) {
      const v=parse(schemas.annotation,input);
      return change(actor,project,demoId,expected,'annotated',v,()=>{
        const o=scoped('ops_evidence_objects',project,demoId,v.object_id);
        if (!available(o)) fail(409,'Evidence unavailable');
        if (v.predecessor_id) {
          const prior=scoped('ops_evidence_annotations',project,demoId,v.predecessor_id);
          if (prior.object_id!==o.id || one('SELECT 1 FROM ops_evidence_annotations WHERE predecessor_id=?',prior.id)) fail(409,'Annotation changed');
        }
        const id=uuid(), hash=evidenceHash({label:v.label,text:v.text,rectangle:v.rectangle});
        run('INSERT INTO ops_evidence_annotations VALUES (?,?,?,?,?,?,?,?)',id,project,demoId,o.id,v.predecessor_id,actor.id,now(),hash);
        run('INSERT INTO ops_evidence_annotation_payloads VALUES (?,?,?,?)',id,v.label,v.text,v.rectangle ? JSON.stringify(v.rectangle) : null);
        return {id};
      });
    },
    share(actor,project,demoId,expected,input) {
      const v=parse(schemas.share,input);
      return change(actor,project,demoId,expected,'shared',v,d=>{
        const id=uuid(), provenance=new Set([actor.id,d.created_by]);
        const items=v.annotation_ids.map((aid,position)=>{
          const a=scoped('ops_evidence_annotations',project,demoId,aid);
          const o=scoped('ops_evidence_objects',project,demoId,a.object_id);
          const payload=one('SELECT * FROM ops_evidence_annotation_payloads WHERE annotation_id=?',aid);
          if (o.kind!=='derivative' || !available(o) || !payload) fail(409,'Reviewed derivative and text required');
          if (a.content_hash!==evidenceHash({label:payload.label,text:payload.text,rectangle:payload.rectangle_json ? JSON.parse(payload.rectangle_json) : null})) fail(409,'Annotation integrity failure');
          provenance.add(a.actor_id); provenance.add(o.uploader_id);
          return {position,object_id:o.id,sha256:o.sha256,annotation_id:a.id,content_hash:a.content_hash};
        });
        if (new Set(items.map(i=>i.object_id)).size>20) fail(400,'Too many images');
        for (const i of items) run('INSERT INTO ops_demonstration_revision_items VALUES (?,?,?,?,?,?)',project,demoId,id,i.position,i.object_id,i.annotation_id);
        const actors=[...provenance].sort(), summaryHash=evidenceHash(v.summary);
        run('INSERT INTO ops_demonstration_revisions VALUES (?,?,?,?,?,?,?,?)',id,project,demoId,actor.id,now(),summaryHash,
          evidenceHash({format:1,items,provenance:actors,summary_hash:summaryHash}),JSON.stringify(actors));
        run('INSERT INTO ops_demonstration_revision_payloads VALUES (?,?)',id,v.summary);
        return {id};
      });
    },
    disposition(actor,project,demoId,expected,input) {
      const v=parse(schemas.disposition,input);
      return change(actor,project,demoId,expected,'restrict',v,()=>{
        scoped(v.object_id ? 'ops_evidence_objects' : 'ops_demonstration_revisions',project,demoId,v.object_id || v.revision_id);
        const id=uuid(), timestamp=now();
        run('INSERT INTO ops_evidence_dispositions VALUES (?,?,?,?,?,?,?,?,?,?)',id,project,demoId,v.object_id ?? null,v.revision_id ?? null,actor.id,timestamp,v.action,v.reason,
          v.action==='delete_requested' ? new Date(Date.parse(timestamp)+86400000).toISOString() : null);
        return {id};
      });
    },
    hold(actor,project,demoId,expected,input) {
      const v=parse(schemas.hold,input);
      return change(actor,project,demoId,expected,'hold',v,()=>{
        const o=scoped('ops_evidence_objects',project,demoId,v.object_id);
        const prior=one('SELECT held FROM ops_evidence_holds WHERE object_id=? ORDER BY sequence DESC LIMIT 1',o.id);
        if (v.held && o.expires_at<=now() && !shared(o.id) && prior?.held!==1) fail(409,'Evidence already expired');
        const id=uuid();
        run('INSERT INTO ops_evidence_holds(id,project_id,demonstration_id,object_id,actor_id,created_at,held,reason) VALUES (?,?,?,?,?,?,?,?)',id,project,demoId,o.id,actor.id,now(),Number(v.held),v.reason);
        return {id};
      });
    },
    archive(actor,project,demoId,expected) {
      return change(actor,project,demoId,expected,'archive',null,()=>{
        return {ok:true,updates:{archived_at:now()}};
      });
    },
  };
}
