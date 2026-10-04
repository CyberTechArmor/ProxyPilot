import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { assertOperation, assertRevision, parse } from './operational-projects-logic.js';
import { guideDocument } from './operational-run-policy.js';
import { browserDraftHash, canonicalBrowserDraft } from './operational-browser-agent-proposal.js';
import { BROWSER_MODEL_CONTRACT, BROWSER_MODEL_MAX_IMAGE_BYTES, browserSourceRefSchema, browserModelError, browserModelRequestDigest,
  validateBrowserModelRequest, validateBrowserModelOutput } from './operational-browser-model.js';

export const BROWSER_CONVERSION_CONTRACT = 'browser-agent-conversion.v1';
export const BROWSER_CONVERSION_DISCLOSURE = 'Send the original instructions and explicitly approved private image or file content to the model provider to suggest an editable browser-agent draft';
const hash=z.string().regex(/^[a-f0-9]{64}$/),uuid=z.string().uuid();
const inputSchema=z.object({source_text:z.string().min(1).refine(v=>v.isWellFormed()&&!!v.trim()&&Buffer.byteLength(v,'utf8')<=6000),
  source_asset_refs:z.array(browserSourceRefSchema).max(8),project_revision:z.number().int().positive(),
  guide_ref:z.object({id:uuid,sha256:hash}).strict(),
  disclosure:z.object({enabled:z.literal(true),reviewed_statement:z.literal(BROWSER_CONVERSION_DISCLOSURE)}).strict(),
  limits:z.object({max_seconds:z.number().int().min(10).max(180),max_tokens:z.number().int().min(1000).max(4000000),max_usd:z.number().finite().positive().max(20)}).strict()}).strict();
const ACTIVE=['queued','converting'];
const reject=(code,status=409)=>{throw browserModelError(code,status);};
export function operationalBrowserConversionMigration1120(db){db.exec(`
  CREATE TABLE ops_browser_conversions(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES ops_projects(id),user_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('queued','converting','completed','blocked','cancelled','interrupted')),
    pins_json TEXT NOT NULL CHECK(json_valid(pins_json)),source_text TEXT NOT NULL,source_sha256 TEXT NOT NULL,
    result_json TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
  CREATE INDEX ops_browser_conversions_project ON ops_browser_conversions(project_id,created_at);
  CREATE TRIGGER ops_browser_conversion_identity BEFORE UPDATE OF id,project_id,user_id,pins_json,source_text,source_sha256,created_at ON ops_browser_conversions
    BEGIN SELECT RAISE(ABORT,'Conversion source and pins are immutable'); END;
  CREATE TRIGGER ops_browser_conversion_finished BEFORE UPDATE ON ops_browser_conversions WHEN OLD.state NOT IN ('queued','converting')
    BEGIN SELECT RAISE(ABORT,'Finished conversion evidence is immutable'); END;
  CREATE TRIGGER ops_browser_conversion_no_delete BEFORE DELETE ON ops_browser_conversions
    BEGIN SELECT RAISE(ABORT,'Conversion evidence is immutable'); END;
`);}
function abortable(promise,signal){return new Promise((resolve,rejectPromise)=>{
  let done=false;const finish=(error,value)=>{if(done)return;done=true;signal.removeEventListener('abort',abort);error?rejectPromise(error):resolve(value);};
  const abort=()=>finish(browserModelError('CANCELLED'));signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
  Promise.resolve(promise).then(v=>finish(null,v),e=>finish(e));
});}
export function createBrowserConversionService({db,store,model=null,resolveAsset=null,verifyAsset=null,sourceCapabilities=()=>({mime_types:['text/plain','text/csv']}),clock=()=>Date.now(),schedule=fn=>setImmediate(fn),isEnabled=()=>true}={}) {
  const one=(s,...a)=>db.prepare(s).get(...a),all=(s,...a)=>db.prepare(s).all(...a),run=(s,...a)=>db.prepare(s).run(...a);
  const stamp=()=>new Date(clock()).toISOString(),executing=new Map();let closed=false;
  const open=()=>{if(closed)reject('BROWSER_CONVERSION_CLOSED');};
  const cancelModel=id=>{try{void Promise.resolve(model?.cancel?.(id)).catch(()=>{});}catch{/* uncertain spend is retained */}};
  const interrupted=all("SELECT id FROM ops_browser_conversions WHERE state IN('queued','converting')");
  run("UPDATE ops_browser_conversions SET state='interrupted',result_json=?,updated_at=? WHERE state IN ('queued','converting')",JSON.stringify({code:'INTERRUPTED',requires_new_request:true,model_spend:'may_be_reserved'}),stamp());
  for(const r of interrupted)cancelModel(r.id);
  const access=(actor,pid,action='read')=>{const p=store.get(actor,pid);assertOperation(p.own_role,action,!!p.archived_at);return p;};
  const owner=(actor,pid)=>{const p=access(actor,pid,'edit');if(p.own_role!=='owner'||actor.mcp===true||actor.human===false)reject('OWNER_MODEL_DISCLOSURE_REQUIRED',403);return p;};
  function row(pid,id){const r=one('SELECT * FROM ops_browser_conversions WHERE project_id=? AND id=?',pid,id);if(!r)reject('NOT_FOUND',404);return r;}
  function projection(r){if(browserDraftHash(r.source_text)!==r.source_sha256)reject('CONVERSION_INTEGRITY_FAILED');
    return{id:r.id,project_id:r.project_id,state:r.state,source_text:r.source_text,source_sha256:r.source_sha256,
      pins:JSON.parse(r.pins_json),result:r.result_json?JSON.parse(r.result_json):null,created_at:r.created_at,updated_at:r.updated_at};}
  function currentGuide(p,ref){if(p.current_version?.id!==ref.id||p.current_version?.content_hash!==ref.sha256)reject('STALE_CONFIGURATION');
    const g=one('SELECT s.title,s.instructions FROM ops_guide_versions v JOIN ops_guide_submissions s ON s.id=v.submission_id AND s.project_id=v.project_id WHERE v.project_id=? AND v.id=?',p.id,ref.id);
    if(!g)reject('STALE_CONFIGURATION');const text=guideDocument(g.title,g.instructions);
    if(browserDraftHash(text)!==ref.sha256)reject('STALE_CONFIGURATION');if(Buffer.byteLength(text)>4000)reject('GUIDE_TOO_LARGE');return text;}
  function event(actor,pid,action,id,meta){run('INSERT INTO ops_project_events(project_id,actor_id,action,subject_id,created_at,request_id,metadata_json) VALUES(?,?,?,?,?,?,?)',pid,actor.id,action,id,stamp(),actor.requestId||randomUUID(),JSON.stringify(meta));}
  function finish(pid,id,state,result){const r=row(pid,id);if(!ACTIVE.includes(r.state))return false;
    run('UPDATE ops_browser_conversions SET state=?,result_json=?,updated_at=? WHERE id=?',state,JSON.stringify(result),stamp(),id);return true;}
  function verifySources(actor,pid,refs){
    if(refs.length&&!verifyAsset)reject('SOURCE_RESOLUTION_UNAVAILABLE');
    for(const ref of refs){
      const verified=verifyAsset(actor,pid,ref,{approved_for_model:true});
      if(verified?.project_id!==pid||verified.approved_for_model!==true||canonicalBrowserDraft(verified.ref)!==canonicalBrowserDraft(ref))reject('SOURCE_DISCLOSURE_REQUIRED');
    }
  }
  async function sources(actor,pid,refs){
    if(refs.length&&(!resolveAsset||!verifyAsset))reject('SOURCE_RESOLUTION_UNAVAILABLE');
    const result=[];let imageBytes=0;
    for(const ref of refs){
      const asset=await resolveAsset(actor,pid,ref,{approved_for_model:true});
      if(asset?.project_id!==pid||asset.approved_for_model!==true||canonicalBrowserDraft(asset.ref)!==canonicalBrowserDraft(ref))reject('SOURCE_DISCLOSURE_REQUIRED');
      let text=null,image_base64=null,image_mime_type=null,content_sha256,kind=asset.content?.kind;
      if(kind==='text' && typeof asset.content.text==='string'){
        text=asset.content.text;if(!text.isWellFormed()||Buffer.byteLength(text,'utf8')>12000)reject('SOURCE_TEXT_TOO_LARGE');content_sha256=browserDraftHash(text);
      }
      else if(kind==='image'&&Buffer.isBuffer(asset.content.bytes)&&['image/png','image/jpeg'].includes(ref.mime_type)){
        image_mime_type=asset.content.mime_type;if(!['image/png','image/jpeg'].includes(image_mime_type))reject('SOURCE_CONTENT_UNSUPPORTED');
        imageBytes+=asset.content.bytes.length;image_base64=asset.content.bytes.toString('base64');content_sha256=browserDraftHash(asset.content.bytes);
      }else reject('SOURCE_CONTENT_UNSUPPORTED');
      if(imageBytes>BROWSER_MODEL_MAX_IMAGE_BYTES)reject('BROWSER_MODEL_IMAGE_TOO_LARGE');
      result.push({ref,content_sha256,content_kind:kind,text,image_mime_type,image_base64});
    }
    // Check every source synchronously after the final decoder await: review
    // of an earlier asset can be revoked while a later document is decoding.
    verifySources(actor,pid,refs);
    return result;
  }
  async function currentProjection(actor,r){
    const privateAccess=()=>{const p=access(actor,r.project_id);if(p.own_role!=='owner'||actor.id!==r.user_id||actor.mcp===true||actor.human===false)reject('PRIVATE_MODEL_REQUEST_OWNER_REQUIRED',403);};privateAccess();
    const value=projection(r);
    if(r.state!=='completed')return value;
    const pins=value.pins;
    let available=true;
    try{
      const p=access(actor,r.project_id);
      if(p.archived_at||p.owner_user_id!==pins.owner_user_id)reject('STALE_CONFIGURATION');
      currentGuide(p,pins.guide_ref);
      const fresh=await sources(actor,r.project_id,pins.source_asset_refs);
      const disclosed=fresh.map(s=>({id:s.ref.id,sha256:s.content_sha256,kind:s.content_kind,image_mime_type:s.image_mime_type}));
      if(canonicalBrowserDraft(disclosed)!==canonicalBrowserDraft(value.result?.provenance?.disclosed_content))reject('STALE_SOURCE_INPUT');
      // A parser await can outlive membership, source or guide authority.
      const current=access(actor,r.project_id);
      if(current.archived_at||current.owner_user_id!==pins.owner_user_id)reject('STALE_CONFIGURATION');
      currentGuide(current,pins.guide_ref);
    }catch{available=false;}
    // Lost project access is an authorization failure, not a historical record
    // containing even partially withheld source information.
    privateAccess();
    if(!available)value.result={code:'CONVERSION_SOURCE_UNAVAILABLE',withheld:true,requires_new_request:true,
      requires_review:true,persisted:false,execution_enabled:false};
    return value;
  }
  function check(actor,r,pins,signal){
    open();if(signal?.aborted||!ACTIVE.includes(row(r.project_id,r.id).state))reject('CANCELLED');
    if(!isEnabled())reject('BROWSER_CONVERSION_DISABLED');if(clock()>=Date.parse(pins.deadline_at))reject('DEADLINE');
    const p=owner(actor,r.project_id);currentGuide(p,pins.guide_ref);
    if(p.revision!==pins.project_revision||p.owner_user_id!==pins.owner_user_id||p.agent_limits_revision!==pins.project_limits_revision)reject('STALE_CONFIGURATION');return p;
  }
  async function execute(pid,id,actor){
    if(closed)return;const r=row(pid,id);if(r.state!=='queued')return;const pins=JSON.parse(r.pins_json),control=new AbortController();executing.set(id,control);
    const timer=setTimeout(()=>{control.abort();cancelModel(id);},Math.max(1,Date.parse(pins.deadline_at)-clock()));
    try{
      const p=check(actor,r,pins,control.signal),guide=currentGuide(p,pins.guide_ref);
      const source_inputs=await abortable(sources(actor,pid,pins.source_asset_refs),control.signal);check(actor,r,pins,control.signal);
      const provider=await abortable(model.readiness(),control.signal);check(actor,r,pins,control.signal);if(provider?.available!==true)reject(provider?.code||'PRICE_UNKNOWN');
      const quote=await abortable(model.quote({purpose:'conversion',max_output_tokens:6000,image_encoded_bytes:source_inputs.reduce((n,s)=>n+(s.image_base64?s.image_base64.length+256:0),0)}),control.signal);check(actor,r,pins,control.signal);
      const request=validateBrowserModelRequest({contract_version:BROWSER_MODEL_CONTRACT,purpose:'conversion',run_id:id,attempt_id:null,fence:null,call_id:pins.call_id,project_id:pid,
        project_revision:pins.project_revision,project_limits_revision:pins.project_limits_revision,policy_hash:pins.policy_hash,guide_version_id:pins.guide_ref.id,guide_hash:pins.guide_ref.sha256,
        consent_hash:pins.consent_hash,price_table_revision:quote.price_table_revision,reservation:{tokens:quote.tokens,usd:quote.usd},deadline_at:pins.deadline_at,input:{guide,instructions:r.source_text,source_inputs,snapshot_ref:null,candidates:[],facts:[]},
        limits:{max_tokens:pins.limits.max_tokens,max_usd:pins.limits.max_usd,max_calls:1,max_output_tokens:6000}},{clock});
      // Readiness/quote awaits can outlive source disclosure review. Validate
      // all original immutable byte pins again immediately before dispatch;
      // no await may separate this check from sending the private content.
      verifySources(actor,pid,pins.source_asset_refs);
      run("UPDATE ops_browser_conversions SET state='converting',updated_at=? WHERE id=?",stamp(),id);
        event(actor,pid,'browser_conversion_model_requested',id,{request_sha256:browserModelRequestDigest(request),call_id:pins.call_id,reserved_tokens:quote.tokens,reserved_usd:quote.usd,price_table_revision:quote.price_table_revision});
      const output=await abortable(model.convert(request,{signal:control.signal}),control.signal);check(actor,r,pins,control.signal);
      // Revoking an asset's model-input review while the call is outstanding
      // prevents result publication. Already accepted spend stays reserved.
      const again=await abortable(sources(actor,pid,pins.source_asset_refs),control.signal);check(actor,r,pins,control.signal);
      if(canonicalBrowserDraft(source_inputs)!==canonicalBrowserDraft(again))reject('STALE_SOURCE_INPUT');
      const text=output.text??JSON.stringify(output.proposal),proposal=validateBrowserModelOutput(request,text);
      if(proposal.configuration.work.guide_ref?.id!==pins.guide_ref.id)reject('MODEL_SOURCE_PROVENANCE_INVALID');
      const u=output.usage,total=u?.prompt_tokens+u?.completion_tokens,cost=Number(output.settled_usd);
      if(!Number.isSafeInteger(total)||!Number.isSafeInteger(u?.prompt_tokens)||u.prompt_tokens<0||!Number.isSafeInteger(u?.completion_tokens)||u.completion_tokens<1||!Number.isFinite(cost)||cost<0||!Number.isSafeInteger(output.price_table_revision)||output.price_table_revision<1)reject('USAGE_MISSING');
      if(total>pins.limits.max_tokens||cost>pins.limits.max_usd||u.completion_tokens>6000)reject('BUDGET_EXHAUSTED');
      finish(pid,id,'completed',{...proposal,requires_review:true,persisted:false,execution_enabled:false,
        provenance:{contract_version:BROWSER_CONVERSION_CONTRACT,original_source_sha256:r.source_sha256,guide_ref:pins.guide_ref,source_asset_refs:pins.source_asset_refs,
          disclosed_content:source_inputs.map(s=>({id:s.ref.id,sha256:s.content_sha256,kind:s.content_kind,image_mime_type:s.image_mime_type})),request_sha256:browserModelRequestDigest(request),
          response_sha256:browserDraftHash(text),model:'gpt-6-luna',call_id:pins.call_id,consent_sha256:pins.consent_hash},
        usage:{prompt_tokens:u.prompt_tokens,completion_tokens:u.completion_tokens},settled_usd:output.settled_usd,price_table_revision:output.price_table_revision,receipt:output.attestation});
      event(actor,pid,'browser_conversion_completed',id,{source_sha256:r.source_sha256,response_sha256:browserDraftHash(text),requires_review:true});
    }catch(e){
      const code=clock()>=Date.parse(pins.deadline_at)?'DEADLINE':/^[A-Z][A-Z0-9_]{0,63}$/.test(e.code||'')?e.code:'BROWSER_MODEL_BRIDGE_UNAVAILABLE';
      finish(pid,id,code==='CANCELLED'?'cancelled':'blocked',{code,requires_new_request:true,model_spend:row(pid,id).state==='converting'?'may_be_reserved':'not_requested'});
      // Cancel queued admission, without retry/refund assumptions or publishing
      // private model output after cancellation or staleness.
      cancelModel(id);
    }finally{clearTimeout(timer);executing.delete(id);}
  }
  return{
    async readiness(actor,pid){open();access(actor,pid);let provider;try{provider=await model?.readiness();}catch{provider=null;}open();const p=access(actor,pid);
      return{contract_version:BROWSER_CONVERSION_CONTRACT,available:p.own_role==='owner'&&!p.archived_at&&isEnabled()&&provider?.available===true,
        code:p.own_role!=='owner'?'OWNER_MODEL_DISCLOSURE_REQUIRED':p.archived_at?'PROJECT_ARCHIVED':!isEnabled()?'BROWSER_CONVERSION_DISABLED':provider?.available===true?null:provider?.code||'BROWSER_MODEL_BRIDGE_UNAVAILABLE',
        disclosure_statement:BROWSER_CONVERSION_DISCLOSURE,requires_review:true,automatic_save:false,automatic_start:false,max_source_text_bytes:6000,max_source_assets:8,
        accepted_source_types:sourceCapabilities().mime_types,image_byte_limit:BROWSER_MODEL_MAX_IMAGE_BYTES,provider:'existing_a4',model:'gpt-6-luna',recommended_limits:{max_seconds:120,max_tokens:30000,max_usd:0.1}};},
    async convert(actor,pid,body){open();const v=parse(inputSchema,body),p=owner(actor,pid);assertRevision(v.project_revision,p.revision);currentGuide(p,v.guide_ref);
      if(new Set(v.source_asset_refs.map(r=>r.id)).size!==v.source_asset_refs.length)reject('SOURCE_INPUT_DUPLICATE',400);
      if(!isEnabled())reject('BROWSER_CONVERSION_DISABLED');
      const provider=await model?.readiness();open();if(provider?.available!==true)reject(provider?.code||'BROWSER_MODEL_BRIDGE_UNAVAILABLE');
      // Preflight exact asset review before storing work; recheck after every
      // await and again during execution instead of trusting this result later.
      await sources(actor,pid,v.source_asset_refs);open();
      let id;db.transaction(()=>{open();const current=owner(actor,pid);assertRevision(v.project_revision,current.revision);currentGuide(current,v.guide_ref);
        if(!isEnabled())reject('BROWSER_CONVERSION_DISABLED');
        if(one("SELECT count(*) n FROM ops_browser_conversions WHERE state IN ('queued','converting')").n>=4||one("SELECT count(*) n FROM ops_browser_conversions WHERE project_id=? AND state IN ('queued','converting')",pid).n>=2)reject('CONVERSION_CAPACITY');
        const limits={...v.limits};for(const k of ['max_seconds','max_tokens','max_usd'])if(current.agent_limits?.[k]!=null)limits[k]=Math.min(limits[k],current.agent_limits[k]);
        const source_sha256=browserDraftHash(v.source_text),at=stamp();id=randomUUID();
        const consent_hash=browserDraftHash(canonicalBrowserDraft({actor_id:actor.id,project_id:pid,project_revision:current.revision,guide_ref:v.guide_ref,source_sha256,source_asset_refs:v.source_asset_refs,disclosure:v.disclosure}));
        const pins={project_revision:current.revision,owner_user_id:current.owner_user_id,project_limits_revision:current.agent_limits_revision,guide_ref:v.guide_ref,disclosure:v.disclosure,
          source_asset_refs:v.source_asset_refs,limits,call_id:randomUUID(),consent_hash,deadline_at:new Date(clock()+limits.max_seconds*1000).toISOString()};
        pins.policy_hash=browserDraftHash(canonicalBrowserDraft({contract:BROWSER_CONVERSION_CONTRACT,project_id:pid,source_sha256,...pins}));
        run('INSERT INTO ops_browser_conversions(id,project_id,user_id,state,pins_json,source_text,source_sha256,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',id,pid,actor.id,'queued',JSON.stringify(pins),v.source_text,source_sha256,at,at);
        event(actor,pid,'browser_conversion_requested',id,{source_sha256,consent_sha256:consent_hash,asset_count:v.source_asset_refs.length,automatic_save:false});
      }).immediate();schedule(()=>execute(pid,id,{...actor}));return{contract_version:BROWSER_CONVERSION_CONTRACT,conversion:projection(row(pid,id))};},
    async status(actor,pid,id){access(actor,pid);return{contract_version:BROWSER_CONVERSION_CONTRACT,conversion:await currentProjection(actor,row(pid,id))};},
    list(actor,pid){access(actor,pid);return{contract_version:BROWSER_CONVERSION_CONTRACT,conversions:all('SELECT * FROM ops_browser_conversions WHERE project_id=? ORDER BY created_at DESC,id DESC LIMIT 50',pid).map(r=>({id:r.id,state:r.state,source_sha256:r.source_sha256,created_at:r.created_at,updated_at:r.updated_at}))};},
    async cancel(actor,pid,id){open();owner(actor,pid);const r=row(pid,id);if(ACTIVE.includes(r.state)){executing.get(id)?.abort();finish(pid,id,'cancelled',{code:'CANCELLED',requires_new_request:true,model_spend:r.state==='converting'?'may_be_reserved':'not_requested'});event(actor,pid,'browser_conversion_cancelled',id,{});cancelModel(id);}
      return{conversion:await currentProjection(actor,row(pid,id))};},
    close(){if(closed)return;closed=true;for(const r of all("SELECT * FROM ops_browser_conversions WHERE state IN('queued','converting')")){executing.get(r.id)?.abort();finish(r.project_id,r.id,'interrupted',{code:'INTERRUPTED',requires_new_request:true,model_spend:r.state==='converting'?'may_be_reserved':'not_requested'});cancelModel(r.id);}},
  };
}
