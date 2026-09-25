import { z } from 'zod';
import { evidenceHash } from './operational-evidence-logic.js';
import { fail, parse } from './operational-projects-logic.js';

const reference=z.object({demonstration_id:z.string().uuid(),revision_id:z.string().uuid(),
  item_position:z.number().int().min(0).max(49),object_id:z.string().uuid(),annotation_id:z.string().uuid()}).strict();
const selection=z.object({references:z.array(reference).max(20)}).strict();
const identity=r=>({demonstration_id:r.demonstration_id,revision_id:r.revision_id,item_position:r.item_position,
  object_id:r.object_id,annotation_id:r.annotation_id,selector_id:r.selector_id});
const frozen=r=>({...identity(r),sha256:r.sha256,annotation_hash:r.annotation_hash,
  publication_hash:r.publication_hash,provenance:JSON.parse(r.provenance_json)});
export const guideEvidenceHash=references=>evidenceHash({format:1,references});

// Called only beneath Operations access checks. No filesystem or runtime imports.
export function createGuideEvidence({one,all,run,evidence}) {
  // Older isolated fixtures/initializers have no D3 schema and remain evidence-free.
  const installed=()=>!!one("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ops_draft_evidence'");
  const drafts=id=>installed()?all('SELECT * FROM ops_draft_evidence WHERE project_id=? ORDER BY position',id):[];
  const enabled=()=>typeof evidence?.guideReference==='function';
  function resolve(id,r) {
    if(!enabled()) fail(409,'Evidence capability unavailable; restore it before submitting or approving');
    return {...identity(r),...evidence.guideReference(id,r)};
  }
  function view(id,rows,hash=null) {
    return {manifest_hash:hash,references:rows.map(r=>{
      const ref=r.provenance_json?frozen(r):identity(r);
      let available=false;
      if(enabled()) {
        try {const current=resolve(id,r);available=!r.provenance_json || evidenceHash(current)===evidenceHash(ref);} catch { /* tombstone, never removed text */ }
      }
      return {...ref,available,unavailable_reason:available?null:enabled()?'unavailable':'capability_disabled'};
    })};
  }
  function manifest(id,sid) {
    if(!installed()) return {rows:[],hash:null};
    const seal=one('SELECT * FROM ops_submission_evidence_sets WHERE project_id=? AND submission_id=?',id,sid);
    const rows=all('SELECT * FROM ops_submission_evidence_refs WHERE project_id=? AND submission_id=? ORDER BY position',id,sid);
    if(!seal) {if(rows.length) fail(409,'Evidence manifest integrity failure');return {rows:[],hash:null};}
    if(seal.reference_count!==rows.length || rows.some((r,i)=>r.position!==i) || seal.manifest_hash!==guideEvidenceHash(rows.map(frozen))) fail(409,'Evidence manifest integrity failure');
    return {rows,hash:seal.manifest_hash};
  }
  return {
    draft:id=>view(id,drafts(id)),
    submission(id,sid) {const m=manifest(id,sid);return view(id,m.rows,m.hash);},
    replace(actor,id,input) {
      const {references}=parse(selection,input);
      if(!installed() || !enabled()) fail(409,'Evidence capability unavailable');
      if(new Set(references.map(r=>`${r.revision_id}:${r.item_position}`)).size!==references.length) fail(400,'Duplicate evidence reference');
      // Validate the entire selection before changing anything.
      const checked=references.map(r=>resolve(id,{...r,selector_id:actor.id}));
      run('DELETE FROM ops_draft_evidence WHERE project_id=?',id);
      checked.forEach((r,i)=>{
        run('INSERT INTO ops_draft_evidence VALUES (?,?,?,?,?,?,?,?)',id,i,r.demonstration_id,r.revision_id,r.item_position,r.object_id,r.annotation_id,actor.id);
      });
      for(const user of new Set([actor.id,...checked.flatMap(r=>r.provenance)])) run('INSERT OR IGNORE INTO ops_draft_contributors VALUES (?,?)',id,user);
    },
    freeze(id,sid) {
      const refs=drafts(id).map(r=>resolve(id,r));
      if(!installed()) return;
      refs.forEach((r,i)=>run('INSERT INTO ops_submission_evidence_refs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
        id,sid,i,r.demonstration_id,r.revision_id,r.item_position,r.object_id,r.annotation_id,r.selector_id,r.sha256,r.annotation_hash,r.publication_hash,JSON.stringify(r.provenance)));
      run('INSERT INTO ops_submission_evidence_sets VALUES (?,?,?,?)',id,sid,refs.length,guideEvidenceHash(refs));
    },
    approve(id,s,actor) {
      const m=manifest(id,s.id);
      for(const r of m.rows) {
        const ref=frozen(r);
        if(ref.selector_id===actor.id || ref.provenance.includes(actor.id)) fail(403,'Approval requires an independent reviewer');
        if(![ref.selector_id,...ref.provenance].every(u=>s.contributors.includes(u))) fail(409,'Evidence contributor integrity failure');
        if(evidenceHash(resolve(id,r))!==evidenceHash(ref)) fail(409,'Evidence changed; request changes or cancel and resubmit');
      }
    },
    clear(id) {if(installed()) run('DELETE FROM ops_draft_evidence WHERE project_id=?',id);},
  };
}
