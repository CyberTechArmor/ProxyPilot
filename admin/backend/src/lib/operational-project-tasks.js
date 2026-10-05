import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { assertOperation, assertRevision, fail, parse, agentLimits } from './operational-projects-logic.js';
import { browserDraftHash } from './operational-browser-agent-proposal.js';
import { SELECTED_BROWSER_CONSENT } from './operational-selected-browser-contract.js';
import { scheduleTiming, nextSchedule, occurrenceKey } from './operational-project-schedule-time.js';

const template=JSON.parse(readFileSync(new URL('./operational-project-defaults.json',import.meta.url),'utf8'));
export const PROJECT_DEFAULTS_VERSION='project-defaults.v1';
export const projectDefaults=()=>({version:PROJECT_DEFAULTS_VERSION,model:template.model.name,budgets:{...template.budgets},
  record_video:template.artifacts.record_video,retention_days:template.artifacts.retention_days,disclosure:SELECTED_BROWSER_CONSENT});
const fields={name:z.string().trim().min(1).max(200),goal:z.string().trim().min(1).max(20000),
  websites:z.union([z.string().max(66000),z.array(z.string().max(2048)).max(32)]).optional(),
  accepted_defaults:z.literal(PROJECT_DEFAULTS_VERSION)};
const createSchema=z.object({...fields,idempotency_key:z.string().uuid()}).strict();
const editSchema=z.object({...fields,project_revision:z.number().int().positive(),configuration_revision:z.number().int().positive().nullable(),website:z.string().max(2048).optional(),limits:agentLimits.optional()}).strict();
const scheduleSchema=z.object({timing:z.unknown(),authorize_unattended:z.literal(true),task_revision:z.number().int().positive(),project_revision:z.number().int().positive(),configuration_revision:z.number().int().positive()}).strict();
const stateSchema=z.object({state:z.enum(['paused','deleted'])}).strict();
const active="('preparing','running','paused','awaiting_approval','human_control','stopping')";
const limitFields=['cpu','memory_mib','temporary_disk_mib','max_seconds','max_actions','max_tokens','max_usd'];

export function createProjectTasks({db,store,runs,clock=()=>Date.now(),uuid=randomUUID,isEnabled=()=>false,
  verifyControl=()=>false,verifyElevation=()=>false}={}) {
  const one=(sql,...args)=>db.prepare(sql).get(...args),all=(sql,...args)=>db.prepare(sql).all(...args),write=(sql,...args)=>db.prepare(sql).run(...args);
  const tx=fn=>db.transaction(fn).immediate(),stamp=()=>new Date(clock()).toISOString();
  const access=(actor,pid,operation='read')=>{
    if(actor?.mcp===true||actor?.human===false)fail(403,'A human must accept project setup');
    const p=store.get(actor,pid);assertOperation(p.own_role,operation,!!p.archived_at);return p;
  };
  const owner=(actor,pid)=>{const p=access(actor,pid,'edit');if(p.own_role!=='owner')fail(403,'Only the project owner can accept settings or schedules');return p;};
  const elevated=actor=>{if(verifyElevation(actor)!==true)fail(403,'Re-authenticate to accept this setup');};
  const task=pid=>{const t=one('SELECT * FROM ops_project_tasks WHERE project_id=?',pid);if(!t)fail(404,'Streamlined project setup not found');return t;};
  const audit=(actor,pid,action,subject,metadata={})=>write('INSERT INTO ops_project_events(project_id,actor_id,action,subject_id,created_at,request_id,metadata_json) VALUES(?,?,?,?,?,?,?)',pid,actor.id,action,subject,stamp(),actor.requestId||uuid(),JSON.stringify(metadata));
  function websites(v) {
    const explicit=v.websites!==undefined||v.website!==undefined;
    const values=v.websites!==undefined?(Array.isArray(v.websites)?v.websites:v.websites.split(/[\n,]+/)):v.website!==undefined?[v.website]:[v.goal.match(/https?:\/\/[^\s<>"']+/i)?.[0]?.replace(/[.,;!?)]+$/,'')||''];
    const entries=values.map(value=>value.trim()).filter(Boolean);
    if(!entries.length){if(explicit)fail(400,'Add at least one domain or website address in Websites');return null;}
    if(entries.length>32)fail(400,'Use up to 32 website addresses');
    const urls=entries.map(value=>{
      if(value.length>2048||/[\s\\]/.test(value))fail(400,'Use one domain or website address per line, or separate them with commas');
      let u;try{u=new URL((value.includes('://')||/^(?:https?|file|data|javascript|ftp):/i.test(value))?value:`https://${value}`);}catch{fail(400,'Enter a valid domain or website address in Websites');}
      if(!['https:','http:'].includes(u.protocol)||u.username||u.password||!u.hostname||u.hostname.includes('*')||u.hostname.endsWith('.')||(!u.hostname.startsWith('[')&&u.hostname.split('.').some(part=>!part||part.length>63||!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(part))))fail(400,'Use HTTP or HTTPS websites without credentials or wildcard domains');
      return u;
    });
    return [...new Map(urls.map(u=>[u.href,u])).values()];
  }
  function structuredGuide(goal,sites) {
    return `## Objective\n${goal}\n\n## Websites\n${sites.map(u=>`- ${u.href}`).join('\n')}\n\n## Procedure\n1. Open the listed websites and carry out the objective.\n2. Ask for approval before using another website or making an external change.\n3. If sign-in is needed, pause for the user to sign in through live takeover.\n\n## Completion\nReport the result with sources. Explain any incomplete work or blockers. Stay within the saved run limits.`;
  }
  function save(actor,p,v,old=null) {
    const sites=websites(v),explicit=v.websites!==undefined;
    const instructions=explicit?structuredGuide(v.goal,sites):v.goal;
    let d=store.draft(actor,p.id);
    if(d.phase==='published'||d.status==='published') {
      store.startRevision(actor,p.id,d.revision,{version_id:p.current_version.id,discard_draft:true});d=store.draft(actor,p.id);
    }
    const guide=store.saveDraft(actor,p.id,d.revision,{title:v.name,instructions}).version;
    const previous=old?.configuration_id?store.browserConfiguration(actor,p.id,old.configuration_id).configuration:null;
    const config=previous?structuredClone(previous.configuration):structuredClone(template);
    if(old&&!previous)Object.assign(config.budgets,p.agent_limits);
    config.name=v.name;config.work.instructions=instructions;config.work.guide_ref={id:guide.id,sha256:guide.content_hash};
    if(!previous||previous.configuration.work.instructions!==instructions)config.work.success_criteria=['Complete the stated goal and report the result with sources.'];
    if(sites&&(!previous||((explicit||v.website!==undefined)&&JSON.stringify(sites.map(u=>u.href))!==JSON.stringify(previous.configuration.destinations.entry_urls)))){
      config.destinations.allowed_origins=[...new Map(sites.map(u=>[u.origin,u])).values()].map((u,i)=>({id:`site-${i+1}`,origin:u.origin,roles:['navigation','resource'],session_headers:u.protocol==='https:'?'this_origin_session':'omit'}));
      config.destinations.entry_urls=sites.map(u=>u.href);config.destinations.network_policy_ref=null;config.destinations.request_rules=[];
    }
    if(v.limits)Object.assign(config.budgets,v.limits);
    if(config.budgets.memory_mib<1024||config.budgets.temporary_disk_mib<64)fail(400,'Browser runs need at least 1024 MB memory and 64 MB temporary storage');
    const limits=Object.fromEntries(limitFields.map(k=>[k,config.budgets[k]]));
    store.agentLimits(actor,p.id,store.get(actor,p.id).revision,{limits});
    let saved=null;
    if(sites||previous) {
      saved=old?.configuration_id?store.updateBrowserConfiguration(actor,p.id,old.configuration_id,previous.revision,{configuration:config,source_text:v.goal}).configuration
        :store.createBrowserConfiguration(actor,p.id,store.get(actor,p.id).revision,{configuration:config,source_text:v.goal}).configuration;
      runs.consent(actor,p.id,saved.id,{configuration_revision:saved.revision,configuration_sha256:saved.configuration_sha256,allow:true,reviewed_statement:SELECTED_BROWSER_CONSENT});
    }
    if(old) {
      store.update(actor,p.id,store.get(actor,p.id).revision,{name:v.name,description:v.goal});
      write('UPDATE ops_project_tasks SET configuration_id=?,revision=revision+1,updated_at=? WHERE project_id=?',saved?.id??null,stamp(),p.id);
      write("UPDATE ops_project_schedules SET state='paused',revision=revision+1,next_run_at=NULL,updated_at=? WHERE project_id=? AND state!='deleted'",stamp(),p.id);
    }
    return saved;
  }
  function get(actor,pid) {
    const p=access(actor,pid),t=one('SELECT * FROM ops_project_tasks WHERE project_id=?',pid);
    if(!t)return {task:null};
    const c=t.configuration_id?store.browserConfiguration(actor,pid,t.configuration_id).configuration:null;
    const schedules=all("SELECT * FROM ops_project_schedules WHERE project_id=? AND state!='deleted'",pid).map(s=>({id:s.id,revision:s.revision,state:s.state,timing:JSON.parse(s.timing_json),next_run_at:s.next_run_at,
      last_occurrence:one('SELECT state,due_at,run_id,result_code FROM ops_project_schedule_occurrences WHERE schedule_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1',s.id)??null}));
    return {task:{revision:t.revision,configuration_id:t.configuration_id,defaults:projectDefaults(),
      configuration:c,needs_website:!c,can_edit:p.own_role==='owner'&&!p.archived_at},schedules};
  }
  function create(actor,input) {
    const v=parse(createSchema,input);store.assertActor(actor);elevated(actor);
    if(actor?.mcp===true||actor?.human===false)fail(403,'A human must accept project setup');
    const hash=browserDraftHash(JSON.stringify(v));
    return tx(()=>{
      const old=one('SELECT * FROM ops_project_tasks WHERE owner_user_id=? AND request_key=?',actor.id,v.idempotency_key);
      if(old){if(old.request_sha256!==hash)fail(409,'This save key was already used for different project details');return {project:store.get(actor,old.project_id),...get(actor,old.project_id)};}
      const p=store.create(actor,{name:v.name,description:v.goal,members:[]});
      const c=save(actor,p,v);
      write('INSERT INTO ops_project_tasks(project_id,owner_user_id,request_key,request_sha256,configuration_id,defaults_version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',p.id,actor.id,v.idempotency_key,hash,c?.id??null,PROJECT_DEFAULTS_VERSION,stamp(),stamp());
      audit(actor,p.id,'project_setup_accepted',c?.id??null,{defaults_version:PROJECT_DEFAULTS_VERSION});
      return {project:store.get(actor,p.id),...get(actor,p.id)};
    });
  }
  function edit(actor,pid,expected,input) {
    const v=parse(editSchema,input);elevated(actor);
    return tx(()=>{const p=owner(actor,pid),t=task(pid);assertRevision(expected,t.revision);assertRevision(v.project_revision,p.revision);
      const c=t.configuration_id?store.browserConfiguration(actor,pid,t.configuration_id).configuration:null;
      if((c?.revision??null)!==v.configuration_revision)fail(412,'Agent settings changed; refresh to compare before saving');
      if(one(`SELECT 1 FROM ops_selected_browser_runs WHERE project_id=? AND state IN${active}`,pid))fail(409,'Stop the active run before changing its goal or settings');
      save(actor,p,v,t);audit(actor,pid,'project_setup_accepted',t.configuration_id,{defaults_version:PROJECT_DEFAULTS_VERSION});return {project:store.get(actor,pid),...get(actor,pid)};});
  }
  async function readiness(actor,pid) {
    access(actor,pid,'run');const t=task(pid);
    const activeRun=one(`SELECT id,state FROM ops_selected_browser_runs WHERE project_id=? AND state IN${active} ORDER BY started_at DESC,id DESC LIMIT 1`,pid)??null;
    const latestRun=one('SELECT id,state FROM ops_selected_browser_runs WHERE project_id=? ORDER BY started_at DESC,id DESC LIMIT 1',pid)??null;
    if(activeRun)return {can_start:false,state:'active',active_run:{...activeRun},latest_run:{...latestRun},checks:[]};
    if(!isEnabled()||!t.configuration_id)return {can_start:false,state:'blocked',active_run:null,latest_run:latestRun?{...latestRun}:null,checks:[{kind:'setup',state:'blocked',code:!isEnabled()?'BROWSER_EXECUTION_DISABLED':'WEBSITES_REQUIRED'}]};
    const result=await runs.readiness(actor,pid,t.configuration_id);
    return {...result,active_run:null,latest_run:latestRun?{...latestRun}:null};
  }
  async function start(actor,pid,input) {
    parse(z.object({idempotency_key:z.string().uuid(),task_revision:z.number().int().positive()}).strict(),input);
    if(!isEnabled())fail(503,'Browser execution is disabled');
    const p=access(actor,pid,'run'),t=task(pid);assertRevision(input.task_revision,t.revision);
    if(!t.configuration_id)fail(409,'Add a domain or website in Websites using Edit goal & settings, then save.');
    const c=store.browserConfiguration(actor,pid,t.configuration_id).configuration;
    return runs.start(actor,pid,c.id,{project_revision:p.revision,configuration_revision:c.revision,configuration_sha256:c.configuration_sha256,idempotency_key:input.idempotency_key});
  }
  function pins(actor,pid) {
    const p=owner(actor,pid),t=task(pid);
    if(!t.configuration_id)fail(409,'Add a domain or website in Websites before scheduling');
    const c=store.browserConfiguration(actor,pid,t.configuration_id).configuration,s=one('SELECT * FROM ops_selected_browser_consents WHERE configuration_id=?',c.id),g=p.current_version;
    if(!g||s?.allowed!==1||s.owner_user_id!==p.owner_user_id||s.configuration_sha256!==c.configuration_sha256||s.configuration_revision!==c.revision||s.guide_id!==g.id||s.guide_sha256!==g.content_hash||c.configuration.work.guide_ref?.id!==g.id||c.configuration.work.guide_ref?.sha256!==g.content_hash)fail(409,'Accept the current goal and settings before scheduling');
    return {p,c,s,g};
  }
  function saveSchedule(actor,pid,input,expected=null) {
    const v=parse(scheduleSchema,input),timing=scheduleTiming(v.timing);elevated(actor);
    if(!isEnabled())fail(503,'Browser execution is disabled');
    if(!verifyControl(actor))fail(403,'Verify agent control before authorizing an unattended run');
    const next=nextSchedule(timing,new Date(clock()));if(!next)fail(400,'Choose a future time. That local time may not exist during a daylight-saving change.');
    return tx(()=>{
      const {p,c,s,g}=pins(actor,pid),old=one("SELECT * FROM ops_project_schedules WHERE project_id=? AND state!='deleted'",pid);
      assertRevision(v.task_revision,task(pid).revision);assertRevision(v.project_revision,p.revision);assertRevision(v.configuration_revision,c.revision);
      if(old)assertRevision(expected,old.revision);else if(expected!=null)fail(412,'Schedule changed; refresh to compare');
      const id=old?.id??uuid();
      write(`INSERT INTO ops_project_schedules(id,project_id,owner_user_id,state,timing_json,next_run_at,configuration_id,configuration_revision,configuration_sha256,guide_id,guide_sha256,consent_sha256,limits_revision,created_at,updated_at)
        VALUES(?,?,?,'enabled',?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=revision+1,owner_user_id=excluded.owner_user_id,state='enabled',timing_json=excluded.timing_json,next_run_at=excluded.next_run_at,configuration_id=excluded.configuration_id,configuration_revision=excluded.configuration_revision,configuration_sha256=excluded.configuration_sha256,guide_id=excluded.guide_id,guide_sha256=excluded.guide_sha256,consent_sha256=excluded.consent_sha256,limits_revision=excluded.limits_revision,updated_at=excluded.updated_at`,id,pid,actor.id,JSON.stringify(timing),next,c.id,c.revision,c.configuration_sha256,g.id,g.content_hash,s.consent_sha256,p.agent_limits_revision,old?.created_at??stamp(),stamp());
      audit(actor,pid,'schedule_accepted',id,{configuration_sha256:c.configuration_sha256});return get(actor,pid);
    });
  }
  function scheduleState(actor,pid,id,expected,input) {
    const v=parse(stateSchema,input);owner(actor,pid);
    const s=one("SELECT * FROM ops_project_schedules WHERE id=? AND project_id=? AND state!='deleted'",id,pid);if(!s)fail(404,'Schedule not found');assertRevision(expected,s.revision);
    return tx(()=>{owner(actor,pid);assertRevision(expected,one('SELECT revision FROM ops_project_schedules WHERE id=?',id).revision);write('UPDATE ops_project_schedules SET state=?,revision=revision+1,next_run_at=NULL,updated_at=? WHERE id=?',v.state,stamp(),id);audit(actor,pid,'schedule_'+v.state,id);return get(actor,pid);});
  }
  function verifyScheduledAuthority(actor,pid,cid) {
    if(!isEnabled()||actor?.jti||!actor?.schedule_occurrence_id)return false;
    const o=one('SELECT * FROM ops_project_schedule_occurrences WHERE id=?',actor.schedule_occurrence_id),s=o&&one('SELECT * FROM ops_project_schedules WHERE id=?',o.schedule_id);
    if(!s||s.state!=='enabled'||s.revision!==o.schedule_revision||s.project_id!==pid||s.configuration_id!==cid||s.owner_user_id!==actor.id||!['starting','started'].includes(o.state))return false;
    try{const {p,c,g,s:consent}=pins({id:actor.id,human:true},pid);return p.agent_limits_revision===s.limits_revision&&c.revision===s.configuration_revision&&c.configuration_sha256===s.configuration_sha256&&g.id===s.guide_id&&g.content_hash===s.guide_sha256&&consent.consent_sha256===s.consent_sha256;}catch{return false;}
  }
  let ticking=false;
  async function tick() {
    if(ticking||!isEnabled())return;ticking=true;
    try {
      const due=all("SELECT * FROM ops_project_schedules WHERE state='enabled' AND next_run_at<=? ORDER BY next_run_at LIMIT 20",stamp());
      for(const s of due) {
        const occurrence=tx(()=>{
          const current=one('SELECT * FROM ops_project_schedules WHERE id=?',s.id);
          if(current.state!=='enabled'||current.next_run_at!==s.next_run_at||current.revision!==s.revision)return null;
          const timing=JSON.parse(s.timing_json),key=occurrenceKey(timing,new Date(s.next_run_at)),id=uuid();
          const state=Date.parse(s.next_run_at)<clock()-300000?'missed':one(`SELECT 1 FROM ops_selected_browser_runs WHERE state IN${active}`)?'overlap':'starting';
          const inserted=write('INSERT OR IGNORE INTO ops_project_schedule_occurrences(id,schedule_id,schedule_revision,due_at,local_key,state,created_at) VALUES(?,?,?,?,?,?,?)',id,s.id,s.revision,s.next_run_at,key,state,stamp());
          write('UPDATE ops_project_schedules SET next_run_at=?,updated_at=? WHERE id=?',timing.frequency==='once'?null:nextSchedule(timing,new Date(clock()),{excludeKey:key}),stamp(),s.id);
          return inserted.changes&&state==='starting'?{id}:null;
        });
        if(!occurrence)continue;
        const actor={id:s.owner_user_id,human:true,schedule_occurrence_id:occurrence.id};
        try {
          if(!verifyScheduledAuthority(actor,s.project_id,s.configuration_id)) {
            write("UPDATE ops_project_schedules SET state='paused',revision=revision+1,next_run_at=NULL,updated_at=? WHERE id=? AND revision=?",stamp(),s.id,s.revision);
            throw Object.assign(new Error('Scheduled setup changed'),{code:'SCHEDULE_SETUP_CHANGED'});
          }
          const p=store.get(actor,s.project_id);
          const result=await runs.startScheduled(actor,s.project_id,s.configuration_id,{project_revision:p.revision,configuration_revision:s.configuration_revision,configuration_sha256:s.configuration_sha256,idempotency_key:occurrence.id});
          write("UPDATE ops_project_schedule_occurrences SET state='started',run_id=? WHERE id=?",result.run.id,occurrence.id);
        }catch(e){write("UPDATE ops_project_schedule_occurrences SET state='blocked',result_code=? WHERE id=?",typeof e.code==='string'?e.code:'SCHEDULE_START_REFUSED',occurrence.id);}
      }
    } finally {ticking=false;}
  }
  function recover(){write("UPDATE ops_project_schedule_occurrences SET state='interrupted',result_code='PROCESS_RECOVERY_NO_REPLAY' WHERE state='starting'");}
  return {get,create,edit,start,readiness,saveSchedule,scheduleState,tick,recover,verifyScheduledAuthority,
    authorization:actor=>({control_verified:verifyControl(actor)===true,elevated:verifyElevation(actor)===true})};
}
