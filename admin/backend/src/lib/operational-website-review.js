import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { OperationsError, parse, assertOperation, assertRevision } from './operational-projects-logic.js';
import { guideDocument } from './operational-run-policy.js';
import { publicUrl, digest, webError, WEB_LIMITS, gatherPublicPages } from './operational-public-web.js';

export const REVIEW_CONSENT = "Send this review agent's approved guide and public page content to the model provider";
const hash=z.string().regex(/^[a-f0-9]{64}$/),uuid=z.string().uuid();
const limitsSchema=z.object({max_pages:z.number().int().min(1).max(3).default(3),
  max_seconds:z.number().int().min(10).max(180).default(120),max_tokens:z.number().int().min(1000).max(20000).default(20000),
  max_usd:z.number().finite().positive().max(0.10).default(0.05)}).strict();
const fields={name:z.string().trim().min(1).max(200),url:z.string().max(2048),objective:z.string().trim().min(1).max(1000).refine(v=>Buffer.byteLength(v)<=1000),
  guide_version_id:uuid,guide_hash:hash,limits:limitsSchema.default({})};
const create=z.object(fields).strict(),patch=z.object(Object.fromEntries(Object.entries(fields).map(([k,v])=>[k,v.optional()]))).strict().refine(v=>Object.keys(v).length);
const consent=z.object({enabled:z.boolean(),reviewed_statement:z.literal(REVIEW_CONSENT).optional()}).strict().refine(v=>!v.enabled||!!v.reviewed_statement);
const start=z.object({agent_id:uuid,agent_revision:z.number().int().positive(),guide_version_id:uuid,guide_hash:hash}).strict();
const modelReview=z.object({summary:z.string().trim().min(40).max(7000),findings:z.array(z.string().trim().min(1).max(1000)).max(8),
  limitations:z.array(z.string().trim().min(1).max(500)).max(8),citations:z.array(z.number().int().min(1).max(3)).min(1).max(3)}).strict();
const ACTIVE=['queued','extracting','reviewing'];
const MESSAGE={DESTINATION_DENIED:'Choose a public website outside private, metadata, vault and installation-management addresses.',
  URL_UNSUPPORTED:'Use a public HTTP or HTTPS URL on its standard port, without credentials or a fragment.',
  CLIENT_RENDER_REQUIRED:'This page requires browser rendering. The current review strategy extracts HTML/text; choose a server-rendered page.',
  SITE_BLOCKED:'The website blocked automated reading. Choose another publicly accessible page; protections are not bypassed.',
  AUTH_REQUIRED:'The page requires authentication. Choose a page that is public without signing in.',
  AUTH_OR_PAYWALL:'The page appears to require a subscription or login. Choose publicly accessible content.',
  ROBOTS_DENIED:'The website robots policy disallows this review crawler.',ROBOTS_UNAVAILABLE:'The website robots policy could not be safely checked.',
  CONTENT_EMPTY:'The response contains too little readable content for a useful review.',CONTENT_UNSUPPORTED:'This strategy supports HTML and plain text pages.',
  CONTENT_TOO_LARGE:'The website response exceeded the bounded content budget.',ENCODING_UNSUPPORTED:'The website returned an unsupported content encoding.',
  FETCH_TIMEOUT:'The website did not respond within the page timeout.',FETCH_FAILED:'The public page could not be reached safely.',
  HTTP_ERROR:'The public page returned an unsuccessful HTTP status.',REDIRECT_LIMIT:'The website exceeded the redirect limit.',REQUEST_LIMIT:'The review reached its request budget.',
  DEADLINE:'The review reached its time limit.',CANCELLED:'The review was cancelled. No further website requests or review publication will occur.',
  STALE_CONFIGURATION:'The guide, agent, project or access changed. Inspect the saved settings and explicitly start a new run.',
  PROVIDER_UNAVAILABLE:'The existing model provider is unavailable. Check the configured A4 provider and reviewed supervisor support.',
  REVIEW_BRIDGE_UNAVAILABLE:'The installed A3/A4 components do not support public review. The operator must update the reviewed runtime and refresh its A8 receipt-key pin.',
  MODEL_INVALID:'The provider did not return a complete cited review. No successful review was recorded.',
  INTERRUPTED:'The dashboard restarted during this review. Work was not resumed; explicitly start a new run.',
  BUDGET_EXHAUSTED:'The model call exceeded its reserved token or spending budget.',PRICE_UNKNOWN:'The existing provider price table is not configured.',
  GUIDE_TOO_LARGE:'This review strategy accepts approved guide documents up to 3500 UTF-8 bytes.',
  PROVIDER_ERROR:'The model call failed. Any uncertain spend remains reserved in the provider ledger.',
  USAGE_MISSING:'The provider usage was missing. The provider ledger retains the worst-case reservation.',
  CALL_UNCERTAIN:'The model call outcome is uncertain. It will not be retried automatically.',
  PROMPT_TOO_LARGE:'The guide and extracted excerpts exceeded the model input limit. Shorten the guide or reduce the page budget.',
  REVIEW_DISABLED:'Agent runs were turned off. Enable the reviewed capability before explicitly starting another review.'};
const fail=(status,code)=>{throw Object.assign(new OperationsError(status,MESSAGE[code]||code.replaceAll('_',' ')),{code});};
function abortable(promise,signal) {
  return new Promise((resolve,reject)=>{
    const abort=()=>finish(webError('CANCELLED'));let settled=false;
    const finish=(error,value)=>{if(settled)return;settled=true;signal.removeEventListener('abort',abort);error?reject(error):resolve(value);};
    signal.addEventListener('abort',abort,{once:true});
    if(signal.aborted)abort();
    Promise.resolve(promise).then(value=>finish(null,value),error=>finish(error));
  });
}

export function websiteReviewMigration1116(db) {db.exec(`
  CREATE TABLE ops_website_review_agents (id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES ops_projects(id),
    revision INTEGER NOT NULL DEFAULT 1,name TEXT NOT NULL,url TEXT NOT NULL,objective TEXT NOT NULL,
    guide_version_id TEXT NOT NULL,guide_hash TEXT NOT NULL,limits_json TEXT NOT NULL,model_consent INTEGER NOT NULL DEFAULT 0,
    created_by TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
    FOREIGN KEY(project_id,guide_version_id) REFERENCES ops_guide_versions(project_id,id));
  CREATE TABLE ops_website_review_runs (id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES ops_projects(id),
    agent_id TEXT NOT NULL REFERENCES ops_website_review_agents(id),user_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('queued','extracting','reviewing','completed','blocked','failed','cancelled','interrupted')),
    pins_json TEXT NOT NULL,activity_json TEXT NOT NULL DEFAULT '[]',sources_json TEXT NOT NULL DEFAULT '[]',
    result_json TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
  CREATE INDEX ops_review_runs_project ON ops_website_review_runs(project_id,created_at);
  CREATE UNIQUE INDEX ops_review_one_active ON ops_website_review_runs(agent_id) WHERE state IN ('queued','extracting','reviewing');
  CREATE TRIGGER ops_review_pins_immutable BEFORE UPDATE OF id,project_id,agent_id,user_id,pins_json,created_at ON ops_website_review_runs
    BEGIN SELECT RAISE(ABORT,'Review run identity and pins are immutable'); END;
  CREATE TRIGGER ops_review_finished_immutable BEFORE UPDATE ON ops_website_review_runs WHEN OLD.state NOT IN ('queued','extracting','reviewing')
    BEGIN SELECT RAISE(ABORT,'Finished review evidence is immutable'); END;
  CREATE TRIGGER ops_review_no_delete BEFORE DELETE ON ops_website_review_runs
    BEGIN SELECT RAISE(ABORT,'Review evidence is immutable'); END;
`);}

export function createWebsiteReviewService({db,store,fetchPage=null,model=null,protectedHosts=[],clock=()=>Date.now(),schedule=fn=>setImmediate(fn),isEnabled=()=>true}={}) {
  const one=(sql,...a)=>db.prepare(sql).get(...a),all=(sql,...a)=>db.prepare(sql).all(...a),run=(sql,...a)=>db.prepare(sql).run(...a);
  const timestamp=()=>new Date(clock()).toISOString(),executing=new Map();
  const validatedUrl=value=>{try{return publicUrl(value,protectedHosts);}catch(e){fail(400,e.code);}};
  run("UPDATE ops_website_review_runs SET state='interrupted',result_json=?,updated_at=? WHERE state IN ('queued','extracting','reviewing')",
    JSON.stringify({code:'INTERRUPTED',message:MESSAGE.INTERRUPTED,model_spend:'may_be_reserved'}),timestamp());
  const access=(actor,pid,action='read')=>{const p=store.get(actor,pid);assertOperation(p.own_role,action,!!p.archived_at);return p;};
  function agentRow(pid,aid) {const a=one('SELECT * FROM ops_website_review_agents WHERE project_id=? AND id=?',pid,aid);if(!a)fail(404,'NOT_FOUND');return a;}
  const agent=a=>{const {limits_json,...value}=a;return {...value,model_consent:!!a.model_consent,limits:JSON.parse(limits_json),workflow_type:'public_website_review',strategy:'http_extract_v1',credential_binding_required:false};};
  const projection=r=>({id:r.id,project_id:r.project_id,agent_id:r.agent_id,user_id:r.user_id,state:r.state,
    pins:JSON.parse(r.pins_json),activity:JSON.parse(r.activity_json),sources:JSON.parse(r.sources_json),result:r.result_json?JSON.parse(r.result_json):null,
    created_at:r.created_at,updated_at:r.updated_at});
  function row(pid,id) {const r=one('SELECT * FROM ops_website_review_runs WHERE project_id=? AND id=?',pid,id);if(!r)fail(404,'NOT_FOUND');return r;}
  function guide(p,v) {if(p.current_version?.id!==v.guide_version_id||p.current_version?.content_hash!==v.guide_hash)fail(409,'STALE_CONFIGURATION');
    const g=one('SELECT s.title,s.instructions FROM ops_guide_versions v JOIN ops_guide_submissions s ON s.id=v.submission_id AND s.project_id=v.project_id WHERE v.project_id=? AND v.id=?',p.id,v.guide_version_id);
    if(!g||digest(guideDocument(g.title,g.instructions))!==v.guide_hash)fail(409,'STALE_CONFIGURATION');
    if(Buffer.byteLength(guideDocument(g.title,g.instructions))>3500)fail(409,'GUIDE_TOO_LARGE');return g;}
  function event(actor,pid,action,id) {run('INSERT INTO ops_project_events(project_id,actor_id,action,subject_id,created_at,request_id,metadata_json) VALUES(?,?,?,?,?,?,?)',pid,actor.id,action,id,timestamp(),actor.requestId||randomUUID(),'{}');}
  function effective(p,a) {const selected=JSON.parse(a.limits_json),ceiling=p.agent_limits||{};
    for(const key of ['max_seconds','max_tokens','max_usd'])if(ceiling[key]!=null)selected[key]=Math.min(selected[key],ceiling[key]);
    if(ceiling.max_actions!=null)selected.max_pages=Math.min(selected.max_pages,ceiling.max_actions);
    return selected;}
  async function readiness(actor,pid,aid) {
    const p=access(actor,pid),a=agentRow(pid,aid),checks=[];
    const add=(kind,ready,code,next)=>checks.push({kind,state:ready?'ready':'blocked',code:ready?'READY':code,next_action:ready?null:next});
    let g;try{g=guide(p,a);add('guide',true);}catch(e){add('guide',false,e.code,'select_current_approved_guide');}
    add('consent',!!a.model_consent,'MODEL_CONSENT_REQUIRED','owner_model_consent');
    add('project',!p.archived_at,'PROJECT_ARCHIVED','restore_project');
    add('feature',isEnabled(),'REVIEW_DISABLED','enable_agent_runs');
    add('access',['owner','operator','editor','reviewer'].includes(p.own_role),'RUN_ACCESS_DENIED','request_run_access');
    let provider;try{provider=await model?.readiness();}catch{provider=null;}
    add('provider',provider?.available===true,provider?.code||'PROVIDER_UNAVAILABLE','review_existing_provider_configuration');
    add('strategy',!!fetchPage,'EXTRACTION_UNAVAILABLE','review_runtime_configuration');
    add('concurrency',!one("SELECT id FROM ops_website_review_runs WHERE agent_id=? AND state IN ('queued','extracting','reviewing')",aid),'RUN_ALREADY_ACTIVE','open_active_run');
    return {contract_version:'website-review.v1',can_start:checks.every(c=>c.state==='ready'),checks,
      pins:{agent_revision:a.revision,project_revision:p.revision,guide_version_id:a.guide_version_id,guide_hash:a.guide_hash},
      capabilities:{workflow:'public_website_review',strategy:'http_extract_v1',read_only:true,credential_binding_required:false,
        javascript_rendering:false,ipv6:false,supported_content:['text/html','text/plain'],limits:effective(p,a),network_limits:WEB_LIMITS,
        model:'gpt-6-luna',max_model_calls:1,max_output_tokens:1500}};
  }
  function updateRun(id,fields) {const r=one('SELECT * FROM ops_website_review_runs WHERE id=?',id);if(!r||!ACTIVE.includes(r.state))return;
    run(`UPDATE ops_website_review_runs SET ${Object.keys(fields).map(k=>`${k}=?`).join(',')},updated_at=? WHERE id=?`,...Object.values(fields),timestamp(),id);}
  function activity(id,kind,details={}) {const r=one('SELECT * FROM ops_website_review_runs WHERE id=?',id);if(!r||!ACTIVE.includes(r.state))return;
    updateRun(id,{activity_json:JSON.stringify([...JSON.parse(r.activity_json),{at:timestamp(),kind,...details}].slice(-30))});}
  const finish=(id,state,result)=>updateRun(id,{state,result_json:JSON.stringify(result)});
  async function execute(id,actor) {
    const r=one('SELECT * FROM ops_website_review_runs WHERE id=?',id);if(!r||r.state!=='queued')return;
    const pins=JSON.parse(r.pins_json),control=new AbortController(),deadline=clock()+pins.limits.max_seconds*1000;
    executing.set(id,control);
    const check=()=>{if(control.signal.aborted||row(r.project_id,id).state==='cancelled')throw webError('CANCELLED');
      if(!isEnabled())throw webError('REVIEW_DISABLED');
      if(clock()>=deadline)throw webError('DEADLINE');let p,a;
      try{p=access(actor,r.project_id,'run');a=agentRow(r.project_id,r.agent_id);guide(p,a);}catch{throw webError('STALE_CONFIGURATION');}
      if(p.revision!==pins.project_revision||p.owner_user_id!==pins.owner_user_id||p.own_role!==pins.actor_role||a.revision!==pins.agent_revision||!a.model_consent)throw webError('STALE_CONFIGURATION');};
    const budget={signal:control.signal,requests:0,bytes:0,check,remaining:()=>Math.max(1,deadline-clock())};
    const timer=setTimeout(()=>{control.abort();void model?.cancel?.(id).catch(()=>{});},pins.limits.max_seconds*1000);
    try {
      check();updateRun(id,{state:'extracting'});activity(id,'extraction_started');
      const pages=await gatherPublicPages({url:pins.url,maxPages:pins.limits.max_pages,budget,fetchPage,protectedHosts,onPage:page=>{
        activity(id,'page_extracted',{url:page.url,bytes:page.bytes,content_hash:page.content_hash});}});
      check();const sources=pages.map((p,i)=>({id:i+1,url:p.url,title:p.title,content_hash:p.content_hash,
        excerpt:p.text.slice(0,3000).toWellFormed(),excerpt_hash:digest(p.text.slice(0,3000).toWellFormed()),extracted_at:timestamp()}));
      // JSON/UTF-8 bytes, rather than character count, bound multilingual or
      // heavily escaped excerpts inside the existing provider prompt ceiling.
      while(Buffer.byteLength(JSON.stringify(sources))>9000){
        const largest=sources.reduce((a,b)=>Buffer.byteLength(a.excerpt)>=Buffer.byteLength(b.excerpt)?a:b);
        largest.excerpt=largest.excerpt.slice(0,Math.floor(largest.excerpt.length*0.8)).toWellFormed();
        if(!largest.excerpt)throw webError('PROMPT_TOO_LARGE');largest.excerpt_hash=digest(largest.excerpt);
      }
      updateRun(id,{sources_json:JSON.stringify(sources)});
      check();const g=guide(access(actor,r.project_id),agentRow(r.project_id,r.agent_id));
      updateRun(id,{state:'reviewing'});activity(id,'model_reserved',{model:'gpt-6-luna',call_id:pins.call_id});
      const output=await abortable(model.review({run_id:id,call_id:pins.call_id,task_hash:pins.task_hash,project_id:r.project_id,
        agent_id:r.agent_id,agent_revision:pins.agent_revision,project_limits_revision:pins.project_limits_revision,
        guide:guideDocument(g.title,g.instructions),guide_hash:pins.guide_hash,objective:pins.objective,
        sources,limits:{max_tokens:pins.limits.max_tokens,max_usd:pins.limits.max_usd},deadline_at:new Date(deadline).toISOString()}, {signal:control.signal}),control.signal);
      check();let parsed;try{parsed=modelReview.parse(JSON.parse(output.text));}catch{throw webError('MODEL_INVALID');}
      if(parsed.citations.some(n=>!sources.some(s=>s.id===n))||new Set(parsed.citations).size!==parsed.citations.length)throw webError('MODEL_INVALID');
      const total=output.usage?.prompt_tokens+output.usage?.completion_tokens;
      if(!Number.isSafeInteger(total)||total<1||!Number.isSafeInteger(output.usage?.prompt_tokens)||output.usage.prompt_tokens<0
        ||!Number.isSafeInteger(output.usage?.completion_tokens)||output.usage.completion_tokens<1
        ||!Number.isFinite(Number(output.settled_usd))||Number(output.settled_usd)<0
        ||!Number.isSafeInteger(output.price_table_revision)||output.price_table_revision<1)throw webError('USAGE_MISSING');
      if(total>pins.limits.max_tokens||Number(output.settled_usd)>pins.limits.max_usd)throw webError('BUDGET_EXHAUSTED');
      activity(id,'review_completed',{call_id:pins.call_id});
      finish(id,'completed',{review:{...parsed,citations:parsed.citations.map(n=>({source_id:n,url:sources[n-1].url}))},
        model:'gpt-6-luna',usage:output.usage,settled_usd:output.settled_usd,price_table_revision:output.price_table_revision,
        receipt:output.attestation,scope:'Public HTML/text extraction; no login, browser JavaScript or website writes.'});
    } catch(e) {
      const code=clock()>=deadline?'DEADLINE':MESSAGE[e.code]?e.code:'PROVIDER_UNAVAILABLE';
      activity(id,'review_stopped',{code});finish(id,code==='CANCELLED'?'cancelled':['DEADLINE','FETCH_TIMEOUT','FETCH_FAILED','PROVIDER_ERROR','USAGE_MISSING','CALL_UNCERTAIN'].includes(code)?'failed':'blocked',
        {code,message:MESSAGE[code],model_spend:row(r.project_id,id).state==='reviewing'?'may_be_reserved':'not_requested'});
    } finally {clearTimeout(timer);executing.delete(id);}
  }
  return {
    readiness,
    listAgents(actor,pid){access(actor,pid);return {agents:all('SELECT * FROM ops_website_review_agents WHERE project_id=? ORDER BY created_at,id',pid).map(agent)};},
    getAgent(actor,pid,aid){access(actor,pid);return {agent:agent(agentRow(pid,aid))};},
    createAgent(actor,pid,body){const v=parse(create,body);return db.transaction(()=>{const p=access(actor,pid,'edit');guide(p,v);v.url=validatedUrl(v.url);
      const id=randomUUID(),at=timestamp();run('INSERT INTO ops_website_review_agents(id,project_id,name,url,objective,guide_version_id,guide_hash,limits_json,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',id,pid,v.name,v.url,v.objective,v.guide_version_id,v.guide_hash,JSON.stringify(v.limits),actor.id,at,at);
      event(actor,pid,'website_review_agent_saved',id);return {agent:agent(agentRow(pid,id))};}).immediate();},
    updateAgent(actor,pid,aid,expected,body){const v=parse(patch,body);return db.transaction(()=>{const p=access(actor,pid,'edit'),old=agentRow(pid,aid);assertRevision(expected,old.revision);
      const next={...agent(old),...v};guide(p,next);next.url=validatedUrl(next.url);
      run('UPDATE ops_website_review_agents SET name=?,url=?,objective=?,guide_version_id=?,guide_hash=?,limits_json=?,model_consent=0,revision=revision+1,updated_at=? WHERE id=?',next.name,next.url,next.objective,next.guide_version_id,next.guide_hash,JSON.stringify(next.limits),timestamp(),aid);
      event(actor,pid,'website_review_agent_saved',aid);return {agent:agent(agentRow(pid,aid))};}).immediate();},
    setConsent(actor,pid,aid,expected,body){const v=parse(consent,body);return db.transaction(()=>{access(actor,pid,'access');const a=agentRow(pid,aid);assertRevision(expected,a.revision);
      run('UPDATE ops_website_review_agents SET model_consent=?,revision=revision+1,updated_at=? WHERE id=?',v.enabled?1:0,timestamp(),aid);
      event(actor,pid,'website_review_model_consent',aid);return {agent:agent(agentRow(pid,aid))};}).immediate();},
    async start(actor,pid,body){const v=parse(start,body);access(actor,pid,'run');const ready=await readiness(actor,pid,v.agent_id);
      if(!ready.can_start)fail(409,ready.checks.find(c=>c.state!=='ready').code);
      let id;db.transaction(()=>{const p=access(actor,pid,'run'),a=agentRow(pid,v.agent_id);guide(p,v);
        if(a.revision!==v.agent_revision||a.guide_version_id!==v.guide_version_id||a.guide_hash!==v.guide_hash||!a.model_consent||p.revision!==ready.pins.project_revision)fail(409,'STALE_CONFIGURATION');
        if(one("SELECT id FROM ops_website_review_runs WHERE agent_id=? AND state IN ('queued','extracting','reviewing')",a.id))fail(409,'RUN_ALREADY_ACTIVE');
        if(one("SELECT count(*) AS n FROM ops_website_review_runs WHERE state IN ('queued','extracting','reviewing')").n>=4||one("SELECT count(*) AS n FROM ops_website_review_runs WHERE project_id=? AND state IN ('queued','extracting','reviewing')",pid).n>=2)fail(409,'REVIEW_CAPACITY');
        id=randomUUID();const pins={workflow:'public_website_review',strategy:'http_extract_v1',agent_revision:a.revision,project_revision:p.revision,
          project_limits_revision:p.agent_limits_revision,owner_user_id:p.owner_user_id,actor_role:p.own_role,guide_version_id:a.guide_version_id,guide_hash:a.guide_hash,
          url:a.url,objective:a.objective,limits:effective(p,a),call_id:randomUUID()};pins.task_hash=digest(JSON.stringify({run_id:id,project_id:pid,agent_id:a.id,user_id:actor.id,...pins}));
        run('INSERT INTO ops_website_review_runs(id,project_id,agent_id,user_id,state,pins_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',id,pid,a.id,actor.id,'queued',JSON.stringify(pins),timestamp(),timestamp());
        event(actor,pid,'website_review_started',id);}).immediate();
      schedule(()=>execute(id,{...actor}));return {run:projection(row(pid,id))};},
    listRuns(actor,pid){access(actor,pid);return {runs:all('SELECT * FROM ops_website_review_runs WHERE project_id=? ORDER BY created_at DESC,id DESC LIMIT 50',pid).map(projection)};},
    status(actor,pid,id){access(actor,pid);return {run:projection(row(pid,id))};},
    cancel(actor,pid,id){access(actor,pid,'run');const r=row(pid,id);if(ACTIVE.includes(r.state)){
      executing.get(id)?.abort();activity(id,'cancel_requested');finish(id,'cancelled',{code:'CANCELLED',message:MESSAGE.CANCELLED,model_spend:r.state==='reviewing'?'may_be_reserved':'not_requested'});
      event(actor,pid,'website_review_cancelled',id);void model?.cancel?.(id).catch(()=>{});}
      return {run:projection(row(pid,id))};},
    // Test/service shutdown only; not an HTTP action and never resumes a run.
    close(){for(const c of executing.values())c.abort();},
  };
}
