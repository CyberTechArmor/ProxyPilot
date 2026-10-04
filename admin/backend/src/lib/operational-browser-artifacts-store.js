import { z } from 'zod';
import { createHash } from 'node:crypto';
import { fail, parse, validId } from './operational-projects-logic.js';

export const BROWSER_ASSET_REVIEW_STATEMENT = 'I reviewed this private file and approve its use as a browser upload or task input';
export const BROWSER_ARTIFACT_REVIEW_STATEMENT = 'I reviewed the exact file for private data and approve this release';
const DAY = 86400000, MAX = 16777216;
const mimeSchema = z.enum(['application/pdf','text/plain','text/csv','image/png','image/jpeg']);
const refSchema = z.object({id:z.string().uuid(),sha256:z.string().regex(/^[a-f0-9]{64}$/),mime_type:mimeSchema,
  byte_count:z.number().int().min(1).max(MAX)}).strict();
const bytesSchema = z.object({idempotency_key:z.string().uuid(),byte_count:refSchema.shape.byte_count,
  mime_type:mimeSchema,sha256:refSchema.shape.sha256}).strict();
const stageSchema = bytesSchema.extend({kind:z.enum(['download','screenshot','screenshot_derivative','clipboard']),
  parent_id:z.string().uuid().optional()}).strict().refine(v => (v.kind === 'screenshot_derivative') === !!v.parent_id);
const scopeSchema = z.object({project_id:z.string().uuid(),run_id:z.string().uuid(),attempt_id:z.string().uuid(),
  fence:z.number().int().positive().max(Number.MAX_SAFE_INTEGER)}).strict();
const querySchema = z.object({after:z.string().uuid().optional(),limit:z.number().int().min(1).max(50).default(25)}).strict();
const digest = v => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const byteDigest = v => createHash('sha256').update(v,'utf8').digest('hex');
const pinSchema=z.object({id:z.string().uuid(),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
const inputApprovalSchema=z.object({artifact_ref:refSchema,target_ref:pinSchema,snapshot_ref:pinSchema,
  purpose:z.string().trim().min(1).max(500),approval_ref:pinSchema}).strict();
const originSchema=z.string().max(2048).refine(value=>{try{const u=new URL(value);return ['https:','http:'].includes(u.protocol)&&u.origin===value&&!u.username&&!u.password;}catch{return false;}});
const observationSchema=bytesSchema.extend({snapshot_ref:pinSchema,origin:originSchema.nullable(),
  url_sha256:refSchema.shape.sha256.nullable(),chunker_version:z.literal('browser-text.v1')}).strict()
  .refine(v=>(v.origin===null)===(v.url_sha256===null));

// Pure, injected metadata store. It cannot open files, connect to destinations,
// reveal secrets, execute artifacts or call a model. Bytes only leave through a
// service holding a fresh authorization and short read lease.
export function createBrowserArtifactsStore({one,all,run,tx,access,event,now,uuid,authorizeAttempt,verifyInputApproval=()=>false,
  verifyRetainedInputApproval=()=>false,verifyObservationOrigin},
  {installationBytes=268435456,accountBytes=134217728,projectBytes=134217728,assetRetentionDays=14} = {}) {
  for (const n of [installationBytes,accountBytes,projectBytes]) {
    if (!Number.isSafeInteger(n) || n < MAX || n > 2147483648) throw new Error('Finite browser artifact quotas required');
  }
  if (!Number.isInteger(assetRetentionDays) || assetRetentionDays < 1 || assetRetentionDays > 30 || typeof authorizeAttempt !== 'function')
    throw new Error('Browser artifact authorization and retention required');
  const later = ms => new Date(Date.parse(now())+ms).toISOString();
  function receipt(a) {
    const expired=a.expires_at<=now(), available=a.file_state==='sealed' && !expired && ['staged','approved'].includes(a.state);
    const deletion=one('SELECT completed_at,outcome FROM ops_browser_artifact_deletions WHERE artifact_id=?',a.id);
    const reason=available?null:['deleted','missing'].includes(a.file_state)?a.file_state:
      ['cancelled','rejected'].includes(a.state)?a.state:expired||a.state==='expired'?'expired':
      a.state==='reserved'&&a.reservation_until<=now()?'intake_interrupted':'intake_pending';
    const observation=a.kind==='observation'?one('SELECT snapshot_ref_json,origin,url_sha256,captured_at,worker_contract,chunker_version FROM ops_browser_observation_sources WHERE artifact_id=?',a.id):null;
    return {id:a.id,project_id:a.project_id,kind:a.kind,state:expired?'expired':a.state,
      sha256:a.sha256,mime_type:a.mime,byte_count:a.byte_count,expires_at:a.expires_at,parent_id:a.parent_id,available,
      availability_reason:reason,created_at:a.created_at,
      retention:{expires_at:a.expires_at,cleanup_pending:!available&&!deletion&&cleanupRequired(a),
        // This is the durable storage receipt, not a fresh integrity probe or a
        // claim about backups, replicas, host-root tampering or secure erasure.
        recorded_file_state:a.file_state,recorded_state:a.state,charged_bytes:a.charged_bytes,deletion:deletion?{...deletion}:null},
      provenance:{created_by:a.actor_id,parent_id:a.parent_id,
        ...(observation?{snapshot_ref:JSON.parse(observation.snapshot_ref_json),origin:observation.origin,
          url_sha256:observation.url_sha256,captured_at:observation.captured_at,
          worker_contract:observation.worker_contract,chunker_version:observation.chunker_version}:{})},
      reviews:all('SELECT purpose,decision,sha256,reviewed_at FROM ops_browser_artifact_reviews WHERE artifact_id=? ORDER BY purpose',a.id),
      ...(a.run_id?{run_id:a.run_id,attempt_id:a.attempt_id,fence:a.fence}:{})};
  }
  function row(project,id) {
    const a = validId(id) && one('SELECT * FROM ops_browser_artifacts WHERE project_id=? AND id=?',project,id);
    if (!a) fail(404,'Private browser artifact not found');
    return a;
  }
  function authorize(actor,scope,intent) {
    const s = parse(scopeSchema,scope);
    if(intent==='observation')intent='artifact_capture';
    access(actor,s.project_id, intent === 'artifact_read' ? 'read' : intent==='artifact_transform'?'review':'run');
    const proof = authorizeAttempt(actor,s,intent);
    if (!proof?.configuration || typeof proof.manual_auth !== 'boolean') fail(409,'Browser attempt authorization unavailable');
    return {...proof,scope:s};
  }
  function scoped(actor,scope,id,intent='artifact_read') {
    const proof = authorize(actor,scope,intent), a = row(proof.scope.project_id,id);
    if (a.run_id !== proof.scope.run_id || a.attempt_id !== proof.scope.attempt_id || a.fence !== proof.scope.fence)
      fail(404,'Private browser artifact not found');
    return {a,proof};
  }
  function asset(actor,project,id,action='read') {
    const {p,role} = access(actor,project,action), a = row(project,id);
    if (a.kind !== 'upload_asset') fail(404,'Private browser artifact not found');
    return {a,p,role};
  }
  const live = a => {
    if (a.expires_at<=now() || ['cancelled','rejected','expired'].includes(a.state)) fail(410,'Private browser artifact unavailable');
  };
  const sealed = a => { live(a); if (a.file_state!=='sealed' || !['staged','approved'].includes(a.state)) fail(409,'Private browser artifact not sealed'); };
  const approved = (a,purpose) => !!one(`SELECT 1 FROM ops_browser_artifact_reviews
    WHERE artifact_id=? AND sha256=? AND purpose=? AND decision='approve'`,a.id,a.sha256,purpose);
  function audit(actor,a,action,metadata={}) {
    // No names, raw bytes, clipboard, URLs, cookies or user-supplied review text.
    event(actor,a.project_id,action,a.id,{kind:a.kind,sha256:a.sha256,byte_count:a.byte_count,...metadata});
  }
  function reserve(actor,project,v,scope=null,proof=null,write_intent=v.kind==='clipboard'?'clipboard_worker':scope?'artifact_capture':'asset') {
    const kind = v.kind || 'upload_asset', parent_id = v.parent_id || null;
    const payload_hash = digest({project,scope,kind,write_intent,parent_id,idempotency_key:v.idempotency_key,sha256:v.sha256,mime:v.mime_type,byte_count:v.byte_count});
    const prior = one('SELECT * FROM ops_browser_artifacts WHERE project_id=? AND actor_id=? AND idempotency_key=?',project,actor.id,v.idempotency_key);
    if (prior) {
      if (prior.payload_hash !== payload_hash) fail(409,'Browser artifact idempotency key already used');
      live(prior); return receipt(prior);
    }
    if (parent_id) {
      const parent = row(project,parent_id); sealed(parent);
      if (parent.kind !== 'screenshot' || parent.run_id !== scope.run_id || parent.attempt_id !== scope.attempt_id || parent.fence !== scope.fence)
        fail(409,'Current screenshot original required');
    }
    const active = where => one(`SELECT count(*) n FROM ops_browser_artifacts WHERE ${where}
      AND ((state='reserved' AND reservation_until>?) OR busy_until>?)`,where==='actor_id=?'?actor.id:project,now(),now()).n;
    const total = one(`SELECT count(*) n FROM ops_browser_artifacts
      WHERE (state='reserved' AND reservation_until>?) OR busy_until>?`,now(),now()).n;
    if (active('actor_id=?')>=2 || active('project_id=?')>=4 || total>=8) fail(429,'Browser artifact concurrency limit');
    const used = (where,args=[]) => one(`SELECT COALESCE(sum(charged_bytes),0) n FROM ops_browser_artifacts ${where}`,...args).n;
    for (const [occupied,limit] of [[used(''),installationBytes],[used('WHERE actor_id=?',[actor.id]),accountBytes],
      [used('WHERE project_id=?',[project]),projectBytes]]) {
      if (occupied + v.byte_count > limit) fail(413,'Browser artifact capacity exhausted');
    }
    // Attempt output allowance is cumulative, including abandoned/deleted
    // receipts. Physical cleanup frees disk quota, never a run's output budget.
    if (scope && one('SELECT COALESCE(sum(byte_count),0) n FROM ops_browser_artifacts WHERE project_id=? AND run_id=? AND attempt_id=?',
      project,scope.run_id,scope.attempt_id).n + v.byte_count > proof.configuration.budgets.max_artifact_bytes)
      fail(413,'Browser attempt artifact budget exhausted');
    let retention = ['clipboard','input_draft'].includes(kind) ? Math.min(proof.configuration.budgets.max_seconds*1000,DAY)
      : (scope ? proof.configuration.artifacts.retention_days : assetRetentionDays)*DAY;
    if(parent_id)retention=Math.min(retention,Date.parse(row(project,parent_id).expires_at)-Date.parse(now()));
    const id = uuid(), at = now();
    run(`INSERT INTO ops_browser_artifacts(id,project_id,actor_id,run_id,attempt_id,fence,kind,write_intent,parent_id,
      idempotency_key,payload_hash,sha256,byte_count,mime,created_at,reservation_until,expires_at,state,charged_bytes,file_state)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'reserved',?,'allocated')`,id,project,actor.id,scope?.run_id??null,
      scope?.attempt_id??null,scope?.fence??null,kind,write_intent,parent_id,v.idempotency_key,payload_hash,v.sha256,v.byte_count,v.mime_type,at,later(600000),later(retention),v.byte_count);
    const a = row(project,id); audit(actor,a,'browser_artifact_reserved'); return receipt(a);
  }
  function stagePolicy(actor,scope,v,intent=v.kind==='clipboard'?'clipboard_worker':'artifact_capture') {
    const proof = authorize(actor,scope,intent);
    if (proof.manual_auth && intent!=='clipboard_import') fail(409,'Private artifacts are disabled during manual authentication');
    const c = proof.configuration;
    if (v.kind==='clipboard' && (v.mime_type!=='text/plain' || v.byte_count>c.artifacts.clipboard.max_bytes ||
      !c.permissions.actions.includes(intent==='clipboard_import'?'paste':'copy'))) fail(403,'Attempt clipboard permission or size refused');
    if (v.kind==='download' && (!c.permissions.actions.includes('download') || !c.artifacts.download_mime_types.includes(v.mime_type) ||
      v.byte_count>c.artifacts.download_max_bytes)) fail(403,'Attempt download permission or type refused');
    if (v.kind.startsWith('screenshot') && (!c.permissions.actions.includes('screenshot') || v.mime_type!=='image/png' ||
      v.byte_count>8388608)) fail(403,'Attempt screenshot permission or size refused');
    if (v.kind==='input_draft' && (v.mime_type!=='text/plain'||v.byte_count>12000||proof.model_consent!==true||
      !c.permissions.actions.some(x=>['type','paste'].includes(x))))fail(403,'Current consented input draft permission required');
    if(v.kind==='observation'&&(v.mime_type!=='text/plain'||v.byte_count>4000||proof.model_consent!==true))
      fail(403,'Current bounded page disclosure consent required');
    if(intent==='artifact_transform'){
      if(v.kind!=='screenshot_derivative'||!v.parent_id)fail(403,'A private screenshot derivative is required');
      const {a}=scoped(actor,proof.scope,v.parent_id,'artifact_read');sealed(a);
      if(a.kind!=='screenshot')fail(403,'Current retained screenshot original required');
    }
    return proof;
  }
  function readAuthorized(actor,scope,id,purpose) {
    const {a,proof} = scoped(actor,scope,id,purpose==='clipboard'?'clipboard_export':purpose==='clipboard_worker'?'clipboard_worker':purpose==='input'?'artifact_input':purpose==='model'?'artifact_model':'artifact_read');
    sealed(a);
    if (['clipboard','clipboard_worker'].includes(purpose) && (a.kind!=='clipboard' ||
      purpose==='clipboard_worker' && (proof.manual_auth || !proof.configuration.permissions.actions.includes('paste')))) fail(403,'Attempt clipboard unavailable');
    if (purpose==='download' && (!['download','screenshot_derivative'].includes(a.kind) || !approved(a,'human_download')))
      fail(403,'Human review required before private file release');
    if (purpose==='model' && (a.kind==='clipboard' || a.kind==='screenshot' ||
      (a.kind==='observation'?!one('SELECT 1 FROM ops_browser_observation_sources WHERE artifact_id=?',a.id):!approved(a,'model_input')) || proof.manual_auth || proof.model_consent!==true))
      fail(403,'Explicit model disclosure approval required');
    if (purpose==='upload') fail(400,'Use a pinned project asset for browser upload');
    if(purpose==='input'&&(a.kind!=='input_draft'||!approved(a,'browser_input')||proof.manual_auth))fail(403,'Exact input draft approval required');
    return a;
  }
  function assetReadAuthorized(actor,project,id,purpose) {
    const {a} = asset(actor,project,id); sealed(a);
    if (purpose==='upload' && (!approved(a,'asset_use') || a.state!=='approved')) fail(403,'Reviewed project upload asset required');
    if (purpose==='model' && (!approved(a,'asset_use') || !approved(a,'model_input'))) fail(403,'Explicit model disclosure approval required');
    return a;
  }
  function lease(actor,a,purpose) {
    const id = uuid();
    run('INSERT INTO ops_browser_artifact_read_leases VALUES(?,?,?,?,?,?)',id,a.id,actor.id,purpose,now(),later(60000));
    return {id,artifact_id:a.id,purpose,actor_id:actor.id,project_id:a.project_id,scope:a.run_id?
      {project_id:a.project_id,run_id:a.run_id,attempt_id:a.attempt_id,fence:a.fence}:null,
      sha256:a.sha256,byte_count:a.byte_count,mime_type:a.mime};
  }
  function cleanupRequired(a) {
    return ['cancelled','rejected','expired'].includes(a.state) || a.expires_at<=now() || (a.state==='reserved' && a.reservation_until<=now());
  }
  function cleanupCandidate(a) {
    if (!a || ['deleted','missing'].includes(a.file_state) || (a.busy_token && a.busy_until>now()) ||
      one('SELECT 1 FROM ops_browser_artifact_read_leases WHERE artifact_id=? AND expires_at>?',a.id,now())) return false;
    return cleanupRequired(a);
  }
  function uploadBinding(actor,scope,input,intent,manualAllowed=false) {
    const ref=parse(refSchema,input),proof=authorize(actor,scope,intent);
    if((!manualAllowed&&proof.manual_auth)||!proof.configuration.permissions.actions.includes('upload'))fail(403,'Current attempt upload permission required');
    const pin=proof.configuration.artifacts.upload_asset_refs.find(v=>v.id===ref.id),{a}=asset(actor,proof.scope.project_id,ref.id);sealed(a);
    if(!pin||pin.sha256!==ref.sha256||pin.mime_type!==ref.mime_type||pin.byte_count!==ref.byte_count||
      a.sha256!==ref.sha256||a.mime!==ref.mime_type||a.byte_count!==ref.byte_count||a.byte_count>proof.configuration.artifacts.upload_max_bytes||
      !approved(a,'asset_use')||a.state!=='approved')fail(403,'Approved upload asset does not match the current attempt pin');
    return {ref,scope:proof.scope};
  }
  function draftBinding(actor,scope,input,{target_ref,snapshot_ref}={},intent='artifact_input',manualAllowed=false) {
    const v=parse(inputApprovalSchema,input),ref={id:v.artifact_ref.id,sha256:v.artifact_ref.sha256},
      {a,proof}=scoped(actor,scope,ref.id,intent);sealed(a);
    const d=one('SELECT * FROM ops_browser_input_drafts WHERE artifact_id=?',a.id),approval=one('SELECT * FROM ops_browser_input_draft_approvals WHERE artifact_id=?',a.id),
      verify=manualAllowed?verifyRetainedInputApproval:verifyInputApproval;
    if(a.kind!=='input_draft'||a.mime!=='text/plain'||a.byte_count>12000||a.sha256!==ref.sha256||!approved(a,'browser_input')||!d||!approval||
      (!manualAllowed&&proof.manual_auth)||a.mime!==v.artifact_ref.mime_type||a.byte_count!==v.artifact_ref.byte_count||
      digest(JSON.parse(d.target_ref_json))!==digest(v.target_ref)||digest(JSON.parse(d.snapshot_ref_json))!==digest(v.snapshot_ref)||
      d.purpose_sha256!==byteDigest(v.purpose)||approval.approval_ref_json!==JSON.stringify(v.approval_ref)||
      verify(actor,proof.scope,v)!==true||
      target_ref&&digest(parse(pinSchema,target_ref))!==digest(JSON.parse(d.target_ref_json))||
      snapshot_ref&&digest(parse(pinSchema,snapshot_ref))!==digest(JSON.parse(d.snapshot_ref_json)))fail(403,'Approved current input draft binding required');
    return {input_ref:ref,target_ref:JSON.parse(d.target_ref_json),snapshot_ref:JSON.parse(d.snapshot_ref_json),
      purpose_sha256:d.purpose_sha256,approval_ref:JSON.parse(approval.approval_ref_json)};
  }
  return {
    authorizeAssetStage(actor,project) {access(actor,project,'edit');return true;},
    reserveAsset(actor,project,input) {
      const v = parse(bytesSchema,input);
      return tx(()=> { access(actor,project,'edit'); return reserve(actor,project,v); });
    },
    reserveAttempt(actor,scope,input) {
      const v = parse(stageSchema,input);
      return tx(()=> { const proof = stagePolicy(actor,scope,v); return reserve(actor,proof.scope.project_id,v,proof.scope,proof); });
    },
    reserveScreenshotDerivative(actor,scope,input) {
      const v=parse(stageSchema,input);
      return tx(()=>{const proof=stagePolicy(actor,scope,v,'artifact_transform');
        return reserve(actor,proof.scope.project_id,v,proof.scope,proof,'artifact_transform');});
    },
    reserveClipboardImport(actor,scope,input) {
      const v = {...parse(bytesSchema,input),kind:'clipboard'};
      return tx(()=> { const proof=stagePolicy(actor,scope,v,'clipboard_import');
        return reserve(actor,proof.scope.project_id,v,proof.scope,proof,'clipboard_import'); });
    },
    reserveInputDraft(actor,scope,input) {
      const v=parse(bytesSchema.extend({target_ref:pinSchema,snapshot_ref:pinSchema,purpose:z.string().trim().min(1).max(500)}).strict(),input);
      return tx(()=>{
        const proof=stagePolicy(actor,scope,{...v,kind:'input_draft'},'input_draft'),r=reserve(actor,proof.scope.project_id,{...v,kind:'input_draft'},proof.scope,proof,'input_draft');
        const previous=one('SELECT * FROM ops_browser_input_drafts WHERE artifact_id=?',r.id),target=JSON.stringify(v.target_ref),snapshot=JSON.stringify(v.snapshot_ref),purposeHash=byteDigest(v.purpose);
        if(previous&&(previous.target_ref_json!==target||previous.snapshot_ref_json!==snapshot||previous.purpose_sha256!==purposeHash))fail(409,'Input draft binding changed');
        if(!previous)run('INSERT INTO ops_browser_input_drafts VALUES(?,?,?,?)',r.id,target,snapshot,purposeHash);
        return r;
      });
    },
    // Only the trusted live observation callback may call this. Public file
    // staging cannot select this kind or borrow bounded page disclosure consent.
    reserveObservation(actor,scope,input) {
      const v=parse(observationSchema,input);
      return tx(()=>{
        const proof=stagePolicy(actor,scope,{...v,kind:'observation'},'observation');
        if(v.origin!==null && !(typeof verifyObservationOrigin==='function'
          ?verifyObservationOrigin(actor,proof.scope,v.origin)===true
          :proof.configuration.destinations.allowed_origins.some(d=>d.origin===v.origin&&d.roles.includes('navigation'))))
          fail(403,'Current selected or approved observation origin required');
        const r=reserve(actor,proof.scope.project_id,{...v,kind:'observation'},proof.scope,proof,'observation'),snapshot=JSON.stringify(v.snapshot_ref);
        const previous=one('SELECT * FROM ops_browser_observation_sources WHERE artifact_id=?',r.id);
        if(previous&&(previous.snapshot_ref_json!==snapshot||previous.origin!==v.origin||previous.url_sha256!==v.url_sha256||previous.chunker_version!==v.chunker_version))
          fail(409,'Observation provenance changed');
        if(!previous)run('INSERT INTO ops_browser_observation_sources VALUES(?,?,?,?,?,?,?)',r.id,snapshot,v.origin,v.url_sha256,now(),'selected-browser.v1',v.chunker_version);
        return r;
      });
    },
    claim(actor,project,id,scope=null) {
      return tx(()=> {
        const a = scope?scoped(actor,scope,id,row(project,id).write_intent).a:asset(actor,project,id,'edit').a;
        if (a.actor_id!==actor.id) fail(403,'Only the staging account can write these bytes');
        live(a);
        if (a.state!=='reserved') { sealed(a); return {receipt:receipt(a)}; }
        if (a.reservation_until<=now()) fail(410,'Browser artifact reservation expired');
        if (a.busy_token && a.busy_until>now()) fail(409,'Browser artifact staging busy');
        const token = uuid(); run('UPDATE ops_browser_artifacts SET busy_token=?,busy_until=? WHERE id=?',token,later(60000),id);
        return {...a,token,scope};
      });
    },
    checkRetry(actor,project,id,scope=null) {
      const a=scope?scoped(actor,scope,id,row(project,id).write_intent).a:asset(actor,project,id,'edit').a;
      if(a.actor_id!==actor.id)fail(403,'Only the staging account can retry these bytes');
      sealed(a);return receipt(a);
    },
    checkWrite(actor,l) {
      const a = l.scope?scoped(actor,l.scope,l.id,l.write_intent).a:asset(actor,l.project_id,l.id,'edit').a;
      live(a);
      if (a.actor_id!==actor.id || a.state!=='reserved' || a.busy_token!==l.token || a.busy_until<=now() || a.reservation_until<=now())
        fail(409,'Browser artifact staging lease lost');
      if (l.scope) stagePolicy(actor,l.scope,{kind:a.kind,mime_type:a.mime,byte_count:a.byte_count,parent_id:a.parent_id},a.write_intent);
      return a;
    },
    withWrite(actor,l,write) { return tx(()=> { this.checkWrite(actor,l); return write(); }); },
    seal(actor,l,proof) {
      return tx(()=> {
        const a = this.checkWrite(actor,l);
        if (proof?.sha256!==a.sha256 || proof?.byte_count!==a.byte_count || proof?.mime_type!==a.mime)
          fail(400,'Browser artifact digest, size or media type mismatch');
        run("UPDATE ops_browser_artifacts SET state='staged',file_state='sealed',busy_token=NULL,busy_until=NULL WHERE id=?",a.id);
        audit(actor,a,'browser_artifact_staged'); return receipt(row(a.project_id,a.id));
      });
    },
    releaseWrite(l) { if (l.token) tx(()=>run('UPDATE ops_browser_artifacts SET busy_token=NULL,busy_until=NULL WHERE id=? AND busy_token=?',l.id,l.token)); },
    listAssets(actor,project,input={}) {
      access(actor,project); const q = parse(querySchema,input);
      const rows = all("SELECT * FROM ops_browser_artifacts WHERE project_id=? AND kind='upload_asset' AND id>? ORDER BY id LIMIT ?",project,q.after||'',q.limit+1);
      return {assets:rows.slice(0,q.limit).map(receipt),next_cursor:rows.length>q.limit?rows[q.limit-1].id:null};
    },
    listAttempt(actor,scope,input={}) {
      const {scope:s} = authorize(actor,scope,'artifact_read'), q = parse(querySchema,input);
      const rows = all('SELECT * FROM ops_browser_artifacts WHERE project_id=? AND run_id=? AND attempt_id=? AND fence=? AND id>? ORDER BY id LIMIT ?',
        s.project_id,s.run_id,s.attempt_id,s.fence,q.after||'',q.limit+1);
      return {artifacts:rows.slice(0,q.limit).map(receipt),next_cursor:rows.length>q.limit?rows[q.limit-1].id:null};
    },
    asset(actor,project,id) { return receipt(asset(actor,project,id).a); },
    artifact(actor,scope,id) { return receipt(scoped(actor,scope,id).a); },
    reviewAsset(actor,project,id,input) {
      const v = parse(z.object({decision:z.enum(['approve','reject']),reviewed_statement:z.literal(BROWSER_ASSET_REVIEW_STATEMENT)}).strict(),input);
      return tx(()=> {
        const {a} = asset(actor,project,id,'review'); sealed(a);
        if (one("SELECT 1 FROM ops_browser_artifact_reviews WHERE artifact_id=? AND purpose='asset_use'",id)) fail(409,'Browser asset review already recorded');
        run('INSERT INTO ops_browser_artifact_reviews VALUES(?,?,?,?,?,?,?)',uuid(),id,a.sha256,'asset_use',v.decision,actor.id,now());
        run('UPDATE ops_browser_artifacts SET state=? WHERE id=?',v.decision==='approve'?'approved':'rejected',id);
        audit(actor,a,'browser_asset_reviewed',{decision:v.decision}); return receipt(row(project,id));
      });
    },
    reviewRelease(actor,scope,id,input) {
      const v = parse(z.object({purpose:z.enum(['human_download','model_input']),decision:z.enum(['approve','reject']),
        reviewed_statement:z.literal(BROWSER_ARTIFACT_REVIEW_STATEMENT)}).strict(),input);
      return tx(()=> {
        // A successful run may retain bytes after its execution fence advances.
        // A fresh human file-release review needs project review access, while
        // model disclosure still needs the current active attempt and consent.
        const {a,proof} = scoped(actor,scope,id,v.purpose==='human_download'?'artifact_read':'artifact_review'); access(actor,proof.scope.project_id,'review'); sealed(a);
        if (!['download','screenshot_derivative'].includes(a.kind)) fail(403,'A reviewed screenshot derivative or download is required');
        if (proof.manual_auth) fail(409,'Artifact release disabled during manual authentication');
        if (v.purpose==='model_input' && proof.model_consent!==true) fail(403,'Current model disclosure consent required');
        if (one('SELECT 1 FROM ops_browser_artifact_reviews WHERE artifact_id=? AND purpose=?',id,v.purpose)) fail(409,'Artifact release decision already recorded');
        run('INSERT INTO ops_browser_artifact_reviews VALUES(?,?,?,?,?,?,?)',uuid(),id,a.sha256,v.purpose,v.decision,actor.id,now());
        audit(actor,a,'browser_artifact_release_reviewed',{purpose:v.purpose,decision:v.decision}); return receipt(a);
      });
    },
    reviewAssetModel(actor,project,id,input) {
      const v = parse(z.object({decision:z.enum(['approve','reject']),reviewed_statement:z.literal(BROWSER_ARTIFACT_REVIEW_STATEMENT)}).strict(),input);
      return tx(()=> {
        const {a,role} = asset(actor,project,id,'review'); sealed(a);
        if (role!=='owner' || !approved(a,'asset_use')) fail(403,'Project owner must approve this exact private source for model disclosure');
        if (one("SELECT 1 FROM ops_browser_artifact_reviews WHERE artifact_id=? AND purpose='model_input'",id)) fail(409,'Artifact release decision already recorded');
        run('INSERT INTO ops_browser_artifact_reviews VALUES(?,?,?,?,?,?,?)',uuid(),id,a.sha256,'model_input',v.decision,actor.id,now());
        audit(actor,a,'browser_artifact_release_reviewed',{purpose:'model_input',decision:v.decision}); return receipt(a);
      });
    },
    openRead(actor,scope,id,purpose='review') {
      if (!['review','download','model','clipboard','clipboard_worker','input'].includes(purpose)) fail(400,'Invalid browser artifact read purpose');
      return tx(()=>lease(actor,readAuthorized(actor,scope,id,purpose),purpose));
    },
    openAssetRead(actor,project,id,purpose='review') {
      if (!['review','download','upload','model'].includes(purpose)) fail(400,'Invalid browser asset read purpose');
      return tx(()=>lease(actor,assetReadAuthorized(actor,project,id,purpose),purpose));
    },
    checkRead(actor,l) {
      const a = l.scope?readAuthorized(actor,l.scope,l.artifact_id,l.purpose):assetReadAuthorized(actor,l.project_id,l.artifact_id,l.purpose);
      const current = one('SELECT * FROM ops_browser_artifact_read_leases WHERE id=? AND artifact_id=? AND actor_id=?',l.id,a.id,actor.id);
      if (!current || current.purpose!==l.purpose || current.expires_at<=now() || l.actor_id!==actor.id || a.sha256!==l.sha256 || a.byte_count!==l.byte_count)
        fail(409,'Private browser artifact read lease lost');
      return receipt(a);
    },
    closeRead(l) { tx(()=>run('DELETE FROM ops_browser_artifact_read_leases WHERE id=? AND artifact_id=?',l.id,l.artifact_id)); },
    resolveUpload(actor,scope,input) {
      return uploadBinding(actor,scope,input,'artifact_upload');
    },
    verifyRetainedUpload(actor,scope,input) {
      const {ref}=uploadBinding(actor,scope,input,'artifact_verify',true);return {ref};
    },
    verifyRetainedClipboard(actor,scope,input) {
      const ref=parse(pinSchema,input),{a,proof}=scoped(actor,scope,ref.id,'artifact_verify');sealed(a);
      if(a.kind!=='clipboard'||a.sha256!==ref.sha256||a.mime!=='text/plain'||a.byte_count>proof.configuration.artifacts.clipboard.max_bytes||
        !proof.configuration.permissions.actions.includes('paste'))fail(403,'Current retained clipboard pin required');
      return {clipboard_ref:ref};
    },
    sourceAsset(actor,project,input,{approved_for_model=false}={}) {
      const ref = parse(refSchema,input), {a,role} = asset(actor,project,ref.id); sealed(a);
      if (role!=='owner' || !approved(a,'asset_use') || a.state!=='approved' || a.sha256!==ref.sha256 || a.mime!==ref.mime_type || a.byte_count!==ref.byte_count)
        fail(403,'Reviewed project source does not match its pin');
      if (approved_for_model!==true || !approved(a,'model_input')) fail(403,'Explicit private source disclosure review required');
      return {project_id:project,ref,approved_for_model:true};
    },
    validateInputs(actor,{project_id,configuration}) {
      access(actor,project_id);
      const inputs=parse(z.object({sources:z.array(refSchema).max(8),uploads:z.array(refSchema).max(32)}).strict(),
        {sources:configuration?.work?.source_inputs,uploads:configuration?.artifacts?.upload_asset_refs});
      for (const [refs,purpose] of [[inputs.sources,'model'],[inputs.uploads,'upload']]) {
        for (const ref of refs) {
          const a=assetReadAuthorized(actor,project_id,ref.id,purpose);
          if (a.state!=='approved' || a.sha256!==ref.sha256 || a.mime!==ref.mime_type || a.byte_count!==ref.byte_count ||
            purpose==='upload' && a.byte_count>configuration.artifacts.upload_max_bytes)
            fail(403,'Reviewed browser input asset does not match its configuration pin');
        }
      }
      return true;
    },
    modelSources(actor,scope,inputs) {
      const refs=parse(z.array(refSchema).max(8).refine(v=>new Set(v.map(r=>r.id)).size===v.length),inputs);
      const proof=authorize(actor,scope,'artifact_model');
      if (proof.manual_auth || proof.model_consent!==true) fail(403,'Current owner consent required for private model sources');
      for (const ref of refs) {
        const pin=proof.configuration.work.source_inputs.find(v=>v.id===ref.id),{a}=asset(actor,proof.scope.project_id,ref.id);sealed(a);
        if (!pin || pin.sha256!==ref.sha256 || pin.mime_type!==ref.mime_type || pin.byte_count!==ref.byte_count ||
          a.sha256!==ref.sha256 || a.mime!==ref.mime_type || a.byte_count!==ref.byte_count ||
          !approved(a,'asset_use') || !approved(a,'model_input') || a.state!=='approved') fail(403,'Reviewed private model source does not match the current attempt pin');
      }
      return {refs,max_prompt_bytes:proof.configuration.model.max_prompt_bytes};
    },
    observationSources(actor,scope,inputs,{model=true}={}) {
      const refs=parse(z.array(refSchema).max(9).refine(v=>new Set(v.map(r=>r.id)).size===v.length),inputs),proof=authorize(actor,scope,model?'artifact_model':'artifact_read');
      if(model&&(proof.manual_auth||proof.model_consent!==true))fail(403,'Current owner consent required for page sources');
      for(const ref of refs){
        const {a}=scoped(actor,proof.scope,ref.id,model?'artifact_model':'artifact_read');sealed(a);
        if(a.kind!=='observation'||a.sha256!==ref.sha256||a.mime!==ref.mime_type||a.byte_count!==ref.byte_count||
          !one('SELECT 1 FROM ops_browser_observation_sources WHERE artifact_id=?',a.id))fail(403,'Exact private page source required');
      }
      return {refs,max_prompt_bytes:proof.configuration.model.max_prompt_bytes};
    },
    approveInputDraft(actor,scope,input) {
      const v=parse(inputApprovalSchema,input);
      return tx(()=>{
        const {a,proof}=scoped(actor,scope,v.artifact_ref.id,'artifact_input_approval');sealed(a);
        const d=one('SELECT * FROM ops_browser_input_drafts WHERE artifact_id=?',a.id);
        if(a.kind!=='input_draft'||a.sha256!==v.artifact_ref.sha256||a.mime!==v.artifact_ref.mime_type||a.byte_count!==v.artifact_ref.byte_count||
          !d||digest(JSON.parse(d.target_ref_json))!==digest(v.target_ref)||digest(JSON.parse(d.snapshot_ref_json))!==digest(v.snapshot_ref)||
          d.purpose_sha256!==byteDigest(v.purpose)||proof.manual_auth||verifyInputApproval(actor,proof.scope,v)!==true)
          fail(403,'Verified exact input draft approval required');
        const previous=one('SELECT * FROM ops_browser_input_draft_approvals WHERE artifact_id=?',a.id);
        if(previous&&previous.approval_ref_json!==JSON.stringify(v.approval_ref))fail(409,'Input draft approval already bound');
        if(!previous){
          run('INSERT INTO ops_browser_input_draft_approvals VALUES(?,?,?,?)',a.id,JSON.stringify(v.approval_ref),actor.id,now());
          run('INSERT INTO ops_browser_artifact_reviews VALUES(?,?,?,?,?,?,?)',uuid(),a.id,a.sha256,'browser_input','approve',actor.id,now());
          audit(actor,a,'browser_input_draft_approved',{approval_id:v.approval_ref.id});
        }
        return {input_ref:{id:a.id,sha256:a.sha256}};
      });
    },
    resolveInputDraft(actor,scope,input,{target_ref,snapshot_ref}={}) {
      return draftBinding(actor,scope,input,{target_ref,snapshot_ref});
    },
    verifyRetainedInputDraft(actor,scope,input,bindings={}) {
      return draftBinding(actor,scope,input,bindings,'artifact_verify',true);
    },
    cancel(actor,project,id,scope=null) {
      return tx(()=> {
        const a = scope?scoped(actor,scope,id,'artifact_capture').a:asset(actor,project,id,'edit').a;
        if (!['cancelled','rejected','expired'].includes(a.state)) run("UPDATE ops_browser_artifacts SET state='cancelled' WHERE id=?",id);
        run('DELETE FROM ops_browser_artifact_read_leases WHERE artifact_id=?',id);
        audit(actor,a,'browser_artifact_cancelled'); return receipt(row(project,id));
      });
    },
    // Trusted lifecycle teardown callback only, never exposed as an unauthenticated
    // route. Revoke leases immediately; keep physical charges until safe unlink.
    cancelAttempt(scope,{clipboardOnly=false}={}) {
      const s = parse(scopeSchema,scope);
      return tx(()=> {
        const rows = all(`SELECT * FROM ops_browser_artifacts WHERE project_id=? AND run_id=? AND attempt_id=? AND fence=?
          ${clipboardOnly?"AND kind IN ('clipboard','input_draft')":''}`,s.project_id,s.run_id,s.attempt_id,s.fence);
        for (const a of rows) {
          if (!['cancelled','rejected','expired'].includes(a.state)) run("UPDATE ops_browser_artifacts SET state='cancelled' WHERE id=?",a.id);
          run('DELETE FROM ops_browser_artifact_read_leases WHERE artifact_id=?',a.id);
        }
        return {cancelled:rows.length};
      });
    },
    maintenancePlan(input={}) {
      const q = parse(querySchema,input);
      return tx(()=> {
        const rows = all("SELECT * FROM ops_browser_artifacts WHERE id>? AND file_state NOT IN ('deleted','missing') ORDER BY id LIMIT ?",q.after||'',q.limit);
        return {items:rows.filter(cleanupCandidate).map(a=>({artifact_id:a.id})),next_cursor:rows.length===q.limit?rows.at(-1).id:null};
      });
    },
    maintenanceApply(id,remove) {
      if (!validId(id) || typeof remove!=='function') fail(400,'Invalid browser artifact cleanup');
      return tx(()=> {
        const a = one('SELECT * FROM ops_browser_artifacts WHERE id=?',id);
        const prior = one('SELECT * FROM ops_browser_artifact_deletions WHERE artifact_id=?',id);
        if (prior) return {artifact_id:id,outcome:prior.outcome};
        if (!cleanupCandidate(a)) return {artifact_id:id,outcome:'deferred'};
        const outcome = remove(id);
        if (!['deleted','missing'].includes(outcome)) throw new Error('Invalid browser artifact cleanup result');
        run('UPDATE ops_browser_artifacts SET file_state=?,charged_bytes=0,busy_token=NULL,busy_until=NULL WHERE id=?',outcome,id);
        run('INSERT INTO ops_browser_artifact_deletions VALUES(?,?,?)',id,now(),outcome);
        return {artifact_id:id,outcome};
      });
    },
  };
}
