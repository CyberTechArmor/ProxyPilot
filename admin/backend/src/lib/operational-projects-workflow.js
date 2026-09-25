import { createHash } from 'node:crypto';
import { assertRevision, fail, parse, schemas, validId } from './operational-projects-logic.js';
import { createGuideEvidence } from './operational-evidence-guide.js';

export const guideHash = (title, instructions) => createHash('sha256').update(JSON.stringify({format:1,title,instructions}), 'utf8').digest('hex');

// Receives the same locked authorization/audit primitives as the foundation store.
export function createOperationsWorkflow({one,all,run,tx,access,event,bump,now,uuid,evidence}) {
  const guideEvidence=createGuideEvidence({one,all,run,evidence});
  const state = id => one('SELECT * FROM ops_guide_state WHERE project_id=?',id);
  const pending = id => one("SELECT * FROM ops_guide_submissions WHERE project_id=? AND state='pending'",id);
  const draftState = id => {
    const p=pending(id),l=one('SELECT id FROM ops_guide_submissions WHERE project_id=? ORDER BY submitted_at DESC,rowid DESC LIMIT 1',id);
    return {...state(id),evidence:guideEvidence.draft(id),pending_submission:p?submission(id,p.id):null,
      latest_submission:l?submission(id,l.id):null};
  };
  function editable(id) {
    if (pending(id)) fail(409,'Cancel the pending review before editing');
    if (state(id)?.phase === 'published') fail(409,'Start a revision before editing published instructions');
  }
  function submission(id,sid) {
    const s=validId(sid) && one('SELECT * FROM ops_guide_submissions WHERE project_id=? AND id=?',id,sid);
    if(!s) fail(404,'Submission not found');
    return {...s,contributors:JSON.parse(s.contributors_json),evidence:guideEvidence.submission(id,s.id)};
  }
  function version(id,vid) {
    const v=validId(vid) && one(`SELECT v.*,s.title,s.instructions,s.contributors_json,s.submitted_by,s.submitted_at,s.base_version_id,
      w.reason AS withdrawal_reason,w.created_at AS withdrawn_at,w.actor_id AS withdrawn_by
      FROM ops_guide_versions v JOIN ops_guide_submissions s ON s.id=v.submission_id AND s.project_id=v.project_id
      LEFT JOIN ops_version_withdrawals w ON w.version_id=v.id WHERE v.project_id=? AND v.id=?`,id,vid);
    if(!v) fail(404,'Version not found');
    return {...v,contributors:JSON.parse(v.contributors_json),evidence:guideEvidence.submission(id,v.submission_id)};
  }
  const latest = id => one('SELECT id FROM ops_guide_versions WHERE project_id=? ORDER BY version_number DESC LIMIT 1',id)?.id;
  function current(id) { const vid=latest(id); const v=vid?version(id,vid):null; return v?.withdrawn_at?null:v; }
  function transition(actor,s,next,reason) {
    run('UPDATE ops_guide_submissions SET state=?,revision=revision+1,decided_by=?,decided_at=?,reason=? WHERE id=?',next,actor.id,now(),reason,s.id);
  }
  function pendingChecked(id,sid,expected) {
    const s=submission(id,sid); assertRevision(expected,s.revision);
    if(s.state!=='pending') fail(409,'Submission is no longer pending');
    return s;
  }
  function getRun(id,rid) {
    const r=validId(rid) && one('SELECT * FROM ops_manual_runs WHERE project_id=? AND id=?',id,rid);
    if(!r) fail(404,'Manual record not found');
    return {...r,corrected_by:one('SELECT id FROM ops_manual_runs WHERE project_id=? AND corrects_run_id=?',id,rid)?.id || null};
  }
  function record(actor,id,input,corrects=null) {
    const v=parse(corrects?schemas.correction:schemas.run,input);
    return tx(()=>{
      access(actor,id,'run');
      const old=corrects?getRun(id,corrects):null;
      if(old && old.recorder_id!==actor.id) fail(403,'Only the original recorder can correct this record');
      const vid=old?.version_id || v.version_id;
      const payloadHash=guideHash('manual-run',JSON.stringify({...v,version_id:vid,corrects_run_id:corrects}));
      const replay=one('SELECT * FROM ops_manual_runs WHERE project_id=? AND recorder_id=? AND idempotency_key=?',id,actor.id,v.idempotency_key);
      if(replay) { if(replay.payload_hash!==payloadHash) fail(409,'Idempotency key already used for different content'); return {run:getRun(id,replay.id),replayed:true}; }
      if(Date.parse(v.started_at)>Date.parse(v.ended_at) || Date.parse(v.ended_at)>Date.parse(now())) fail(400,'Reported times must be ordered and not in the future');
      if(old?.corrected_by) fail(409,'Correct the latest record in this chain');
      if(!old && current(id)?.id!==vid) fail(409,'The guide changed or was withdrawn; review the current version');
      version(id,vid);
      const rid=uuid();
      run(`INSERT INTO ops_manual_runs(id,project_id,version_id,recorder_id,started_at,ended_at,recorded_at,outcome,notes,corrects_run_id,reason,idempotency_key,payload_hash)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,rid,id,vid,actor.id,v.started_at,v.ended_at,now(),v.outcome,v.notes,corrects,v.reason || null,v.idempotency_key,payloadHash);
      event(actor,id,old?'run_corrected':'run_recorded',rid,{version_id:vid,corrects_run_id:corrects}); bump(id);
      return {run:getRun(id,rid),replayed:false};
    });
  }
  return {
    draftState, editable, current,
    methods: {
      replaceDraftEvidence(actor,id,expected,input) {
        return tx(()=>{
          access(actor,id,'edit');editable(id);
          const d=one('SELECT * FROM ops_guide_drafts WHERE project_id=?',id);assertRevision(expected,d.revision);
          guideEvidence.replace(actor,id,input);
          run('UPDATE ops_guide_drafts SET revision=revision+1,updated_by=?,updated_at=? WHERE project_id=?',actor.id,now(),id);
          event(actor,id,'draft_evidence_selected',null,{draft_revision:d.revision+1});bump(id);
          return {revision:d.revision+1};
        });
      },
      submit(actor,id,expected,input) {
        parse(schemas.submit,input);
        return tx(()=>{
          access(actor,id,'edit'); editable(id);
          const d=one('SELECT * FROM ops_guide_drafts WHERE project_id=?',id); assertRevision(expected,d.revision);
          if(!d.title.trim() || !d.instructions.trim()) fail(400,'A title and instructions are required for review');
          const sid=uuid(), contributors=all('SELECT user_id FROM ops_draft_contributors WHERE project_id=? ORDER BY user_id',id).map(r=>r.user_id);
          guideEvidence.freeze(id,sid);
          run(`INSERT INTO ops_guide_submissions(id,project_id,draft_revision,base_version_id,title,instructions,content_hash,contributors_json,submitted_by,submitted_at)
            VALUES(?,?,?,?,?,?,?,?,?,?)`,sid,id,d.revision,state(id).base_version_id,d.title,d.instructions,guideHash(d.title,d.instructions),JSON.stringify(contributors),actor.id,now());
          event(actor,id,'guide_submitted',sid); bump(id);
          return {submission:submission(id,sid),revision:1};
        });
      },
      submission(actor,id,sid) {access(actor,id); return {submission:submission(id,sid)};},
      review(actor,id,sid,expected,input) {
        const v=parse(schemas.review,input);
        return tx(()=>{
          access(actor,id,'review'); const s=pendingChecked(id,sid,expected);
          if(v.decision==='approve' && (s.submitted_by===actor.id || s.contributors.includes(actor.id))) fail(403,'Approval requires an independent reviewer');
          if(s.content_hash!==guideHash(s.title,s.instructions)) fail(409,'Submitted content failed integrity validation');
          let published=null;
          if(v.decision==='approve') {
            guideEvidence.approve(id,s,actor);
            const vid=uuid(), number=one('SELECT COALESCE(MAX(version_number),0)+1 AS n FROM ops_guide_versions WHERE project_id=?',id).n;
            run('INSERT INTO ops_guide_versions VALUES(?,?,?,?,?,?,?,?)',vid,id,number,s.id,actor.id,now(),s.content_hash,latest(id)||null);
            run("UPDATE ops_guide_state SET phase='published' WHERE project_id=?",id);
            published=version(id,vid);
          }
          transition(actor,s,v.decision==='approve'?'approved':'changes_requested',v.reason);
          event(actor,id,v.decision==='approve'?'guide_approved':'guide_changes_requested',sid,{version_id:published?.id || null}); bump(id);
          return {submission:submission(id,sid),version:published,revision:s.revision+1};
        });
      },
      cancelSubmission(actor,id,sid,expected,input) {
        const v=parse(schemas.reason,input);
        return tx(()=>{access(actor,id,'edit'); const s=pendingChecked(id,sid,expected);
          transition(actor,s,'cancelled',v.reason); event(actor,id,'guide_cancelled',sid); bump(id);
          return {revision:s.revision+1};});
      },
      startRevision(actor,id,expected,input) {
        const v=parse(schemas.startRevision,input);
        return tx(()=>{access(actor,id,'edit');
          const d=one('SELECT * FROM ops_guide_drafts WHERE project_id=?',id); assertRevision(expected,d.revision);
          if(pending(id)) fail(409,'Cancel the pending review first');
          const base=version(id,v.version_id);
          run('UPDATE ops_guide_drafts SET title=?,instructions=?,revision=revision+1,updated_by=?,updated_at=? WHERE project_id=?',base.title,base.instructions,actor.id,now(),id);
          run("UPDATE ops_guide_state SET base_version_id=?,phase='draft' WHERE project_id=?",base.id,id);
          run('DELETE FROM ops_draft_contributors WHERE project_id=?',id);
          guideEvidence.clear(id);
          event(actor,id,'guide_revision_started',base.id); bump(id);
          return {revision:d.revision+1};
        });
      },
      versions(actor,id,input={}) {
        access(actor,id); const q=parse(schemas.events,input);
        const rows=all('SELECT id,version_number FROM ops_guide_versions WHERE project_id=? AND version_number>? ORDER BY version_number LIMIT ?',id,q.after,q.limit+1);
        return {versions:rows.slice(0,q.limit).map(r=>version(id,r.id)),current_version_id:current(id)?.id || null,next_cursor:rows.length>q.limit?String(rows[q.limit-1].version_number):null};
      },
      version(actor,id,vid) {access(actor,id);return {version:version(id,vid)};},
      withdraw(actor,id,vid,expected,input) {
        const v=parse(schemas.reason,input);
        return tx(()=>{const {p}=access(actor,id,'withdraw');assertRevision(expected,p.revision);
          if(version(id,vid).withdrawn_at) fail(409,'Version already withdrawn');
          run('INSERT INTO ops_version_withdrawals VALUES(?,?,?,?,?)',id,vid,actor.id,now(),v.reason);
          event(actor,id,'guide_withdrawn',vid);bump(id);return {revision:p.revision+1};});
      },
      recordRun:(actor,id,input)=>record(actor,id,input),
      correctRun:(actor,id,rid,input)=>record(actor,id,input,rid),
      run(actor,id,rid) {access(actor,id);return {run:getRun(id,rid)};},
      runs(actor,id,input={}) {
        access(actor,id);const q=parse(schemas.list,input);
        const rows=all('SELECT id FROM ops_manual_runs WHERE project_id=? AND id>? ORDER BY id LIMIT ?',id,q.after||'',q.limit+1);
        return {runs:rows.slice(0,q.limit).map(r=>getRun(id,r.id)),next_cursor:rows.length>q.limit?rows[q.limit-1].id:null};
      },
    },
  };
}
