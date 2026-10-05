import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { operationsFixture, fixtureRouter } from './helpers/operations-fixture.js';
import { operationalSelectedBrowserMigration1118 } from '../lib/operational-selected-browser-schema.js';
import { operationalProjectTasksMigration1126 } from '../lib/operational-project-tasks-schema.js';
import { createSelectedBrowserService } from '../lib/operational-selected-browser-service.js';
import { createProjectTasks, PROJECT_DEFAULTS_VERSION } from '../lib/operational-project-tasks.js';
import { nextSchedule, scheduleTiming, occurrenceKey } from '../lib/operational-project-schedule-time.js';
import { createOperationsRouter } from '../routes/operational-projects.js';

const input=()=>({name:'Compare prices',goal:'Read https://example.com/pricing and summarize the plans.',accepted_defaults:PROJECT_DEFAULTS_VERSION,idempotency_key:randomUUID()});
function world() {
  const f=operationsFixture();operationalSelectedBrowserMigration1118(f.adapter);operationalProjectTasksMigration1126(f.adapter);
  const owner=f.addUser();let now=Date.parse('2026-10-05T12:00:00Z'),enabled=true,proof=true;
  const runs=createSelectedBrowserService({db:f.db,verifyElevation:()=>proof,verifyControl:()=>proof});
  const starts=[];runs.startScheduled=async(a,pid,cid,v)=>{starts.push({a,pid,cid,v});throw Object.assign(new Error('No test host'),{code:'TEST_HOST_UNAVAILABLE'});};
  const projects=createProjectTasks({db:f.adapter,store:f.store,runs,clock:()=>now,isEnabled:()=>enabled,verifyControl:()=>proof,verifyElevation:()=>proof});
  return {...f,owner,runs,projects,starts,advance:ms=>{now+=ms;f.advance(ms);},enable:v=>{enabled=v;},proof:v=>{proof=v;}};
}
const withWorld=fn=>async()=>{const w=world();try{await fn(w);}finally{w.close();}};
const refused=(status,fn)=>assert.throws(fn,e=>e.status===status);
const count=(w,t)=>w.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
const editInput=(w,pid,value)=>({...value,project_revision:w.store.get(w.owner,pid).revision,configuration_revision:w.projects.get(w.owner,pid).task.configuration?.revision??null});
const scheduleInput=(w,pid,value)=>({...value,task_revision:w.projects.get(w.owner,pid).task.revision,project_revision:w.store.get(w.owner,pid).revision,configuration_revision:w.projects.get(w.owner,pid).task.configuration.revision});
const timing={frequency:'daily',time:'12:01',timezone:'UTC'};

test('one accept atomically saves project, exact guide, finite defaults, browser configuration and consent; it does not run',withWorld(w=>{
  const v=input(),result=w.projects.create(w.owner,v),c=result.task.configuration;
  assert.equal(result.project.description,v.goal);assert.equal(result.project.current_version.instructions,v.goal);
  assert.equal(c.source_text,v.goal);assert.deepEqual(c.configuration.work.guide_ref,{id:result.project.current_version.id,sha256:result.project.current_version.content_hash});
  for(const [k,value] of Object.entries(result.project.agent_limits))assert.equal(c.configuration.budgets[k],value);
  assert.equal(c.configuration.budgets.memory_mib,1024);assert.equal(c.configuration.artifacts.record_video,false);
  const consent=w.db.prepare('SELECT * FROM ops_selected_browser_consents WHERE configuration_id=?').get(c.id);
  assert.equal(consent.allowed,1);assert.equal(consent.configuration_sha256,c.configuration_sha256);assert.equal(count(w,'ops_selected_browser_runs'),0);
  assert.equal(w.projects.create(w.owner,v).project.id,result.project.id);assert.equal(count(w,'ops_projects'),1);
  refused(409,()=>w.projects.create(w.owner,{...v,goal:'Other goal'}));
}));

test('audit failure rolls back all setup records, including guide and consent',withWorld(w=>{
  w.db.exec("CREATE TRIGGER fail_setup BEFORE INSERT ON ops_project_events WHEN NEW.action='project_setup_accepted' BEGIN SELECT RAISE(ABORT,'fixture'); END");
  assert.throws(()=>w.projects.create(w.owner,input()),/fixture/);
  for(const table of ['ops_projects','ops_guide_versions','ops_browser_agent_configurations','ops_selected_browser_consents','ops_project_tasks'])assert.equal(count(w,table),0,table);
}));

test('name and plain-language goal save without guessing a destination; running explains the missing website',withWorld(async w=>{
  const v={...input(),goal:'Compare the plans and explain which one fits a small team.'},r=w.projects.create(w.owner,v);
  assert.equal(r.task.needs_website,true);assert.equal(count(w,'ops_browser_agent_configurations'),0);
  await assert.rejects(w.projects.start(w.owner,r.project.id,{task_revision:1,idempotency_key:randomUUID()}),e=>e.status===409&&/website/.test(e.message));
  const edited=w.projects.edit(w.owner,r.project.id,1,editInput(w,r.project.id,{name:v.name,goal:v.goal,website:'https://example.com/',accepted_defaults:PROJECT_DEFAULTS_VERSION}));
  assert.equal(edited.task.needs_website,false);assert.equal(edited.project.current_version.version_number,2);
}));

test('one settings save revises guide and consent, preserves history and pauses schedules; stale edits cannot win',withWorld(w=>{
  const r=w.projects.create(w.owner,input()),pid=r.project.id,s=w.projects.saveSchedule(w.owner,pid,scheduleInput(w,pid,{timing,authorize_unattended:true}));
  const edited=w.projects.edit(w.owner,pid,1,editInput(w,pid,{name:'Revised project',goal:'Read https://example.com/new and summarize it.',limits:{max_seconds:600},accepted_defaults:PROJECT_DEFAULTS_VERSION}));
  assert.equal(edited.project.current_version.version_number,2);assert.equal(count(w,'ops_guide_versions'),2);
  assert.equal(edited.task.configuration.revision,2);assert.equal(edited.project.agent_limits.max_seconds,600);
  assert.equal(edited.schedules[0].state,'paused');assert.equal(edited.schedules[0].next_run_at,null);
  refused(412,()=>w.projects.edit(w.owner,pid,1,editInput(w,pid,{name:'Stale',goal:'Stale',accepted_defaults:PROJECT_DEFAULTS_VERSION})));
  refused(412,()=>w.projects.scheduleState(w.owner,pid,s.schedules[0].id,1,{state:'deleted'}));
}));

test('setup and schedules require owner, current human proof and explicit acceptance',withWorld(w=>{
  refused(400,()=>w.projects.create(w.owner,{...input(),accepted_defaults:undefined}));
  refused(403,()=>w.projects.create({...w.owner,mcp:true},input()));
  const p=w.projects.create(w.owner,input()).project,other=w.addUser();
  w.store.grant(w.owner,p.id,other.id,w.store.get(w.owner,p.id).revision,{role:'editor'});
  refused(403,()=>w.projects.edit(other,p.id,1,editInput(w,p.id,{name:'Other',goal:'Other',accepted_defaults:PROJECT_DEFAULTS_VERSION})));
  refused(403,()=>w.projects.saveSchedule(other,p.id,scheduleInput(w,p.id,{timing,authorize_unattended:true})));
  refused(400,()=>w.projects.saveSchedule(w.owner,p.id,{timing}));
  w.proof(false);refused(403,()=>w.projects.saveSchedule(w.owner,p.id,scheduleInput(w,p.id,{timing,authorize_unattended:true})));
}));

test('open simple editors and schedule acceptance cannot overwrite unseen advanced settings',withWorld(w=>{
  const saved=w.projects.create(w.owner,input()),pid=saved.project.id,
    stale=editInput(w,pid,{name:saved.project.name,goal:saved.project.description,accepted_defaults:PROJECT_DEFAULTS_VERSION}),
    unattended=scheduleInput(w,pid,{timing,authorize_unattended:true});
  const c=saved.task.configuration,configuration=structuredClone(c.configuration);configuration.budgets.max_seconds=600;
  w.store.updateBrowserConfiguration(w.owner,pid,c.id,c.revision,{configuration});
  refused(412,()=>w.projects.edit(w.owner,pid,1,stale));
  // Consent must be current before the schedule's optimistic check can pass.
  const current=w.store.browserConfiguration(w.owner,pid,c.id).configuration;
  w.runs.consent(w.owner,pid,c.id,{configuration_revision:current.revision,configuration_sha256:current.configuration_sha256,allow:true,reviewed_statement:'Send this approved guide and bounded selected-site content to the model provider'});
  refused(412,()=>w.projects.saveSchedule(w.owner,pid,unattended));
  assert.equal(w.store.browserConfiguration(w.owner,pid,c.id).configuration.configuration.budgets.max_seconds,600);
}));

test('durable minute claim launches once, skips missed runs and reports unavailable host',withWorld(async w=>{
  const p=w.projects.create(w.owner,input()).project;w.projects.saveSchedule(w.owner,p.id,scheduleInput(w,p.id,{timing,authorize_unattended:true}));
  w.advance(60000);await Promise.all([w.projects.tick(),w.projects.tick()]);await w.projects.tick();assert.equal(w.starts.length,1);
  let s=w.projects.get(w.owner,p.id).schedules[0];assert.equal(s.last_occurrence.state,'blocked');assert.equal(s.last_occurrence.result_code,'TEST_HOST_UNAVAILABLE');assert.equal(s.next_run_at,'2026-10-06T12:01:00.000Z');
  w.advance(86400000+600000);await w.projects.tick();s=w.projects.get(w.owner,p.id).schedules[0];assert.equal(s.last_occurrence.state,'missed');assert.equal(w.starts.length,1);
}));

test('restart never replays a claimed occurrence; pauses, edits, access loss and feature disable revoke authority',withWorld(async w=>{
  const p=w.projects.create(w.owner,input()).project;w.projects.saveSchedule(w.owner,p.id,scheduleInput(w,p.id,{timing,authorize_unattended:true}));
  const s=w.projects.get(w.owner,p.id).schedules[0],id=randomUUID();
  w.db.prepare("INSERT INTO ops_project_schedule_occurrences(id,schedule_id,schedule_revision,due_at,local_key,state,created_at) VALUES(?,?,?,?,?,'starting',?)").run(id,s.id,s.revision,s.next_run_at,'2026-10-05T12:01','2026-10-05T12:00:00Z');
  const actor={id:w.owner.id,human:true,schedule_occurrence_id:id},cid=w.projects.get(w.owner,p.id).task.configuration_id;
  assert.equal(w.projects.verifyScheduledAuthority(actor,p.id,cid),true);
  assert.equal(w.projects.verifyScheduledAuthority({...actor,jti:'pretend-session'},p.id,cid),false);
  w.enable(false);assert.equal(w.projects.verifyScheduledAuthority(actor,p.id,cid),false);w.enable(true);
  w.projects.recover();assert.equal(w.projects.verifyScheduledAuthority(actor,p.id,cid),false);
  w.advance(60000);await w.projects.tick();assert.equal(w.starts.length,0);
  assert.equal(w.projects.get(w.owner,p.id).schedules[0].last_occurrence.state,'interrupted');
}));

test('once, daily and weekly follow selected timezone; spring gap skips and fall overlap is one wall-time occurrence',()=>{
  const daily=scheduleTiming({frequency:'daily',time:'02:30',timezone:'America/Detroit'});
  assert.equal(nextSchedule(daily,new Date('2026-03-08T05:00Z')),'2026-03-09T06:30:00.000Z');
  const fall=scheduleTiming({frequency:'daily',time:'01:30',timezone:'America/Detroit'}),first=nextSchedule(fall,new Date('2026-11-01T04:00Z'));
  assert.equal(first,'2026-11-01T05:30:00.000Z');
  assert.equal(nextSchedule(fall,new Date(first),{excludeKey:occurrenceKey(fall,new Date(first))}),'2026-11-02T06:30:00.000Z');
  assert.equal(nextSchedule({frequency:'weekly',weekday:1,time:'09:00',timezone:'America/Detroit'},new Date('2026-10-04T20:00Z')),'2026-10-05T13:00:00.000Z');
  refused(400,()=>scheduleTiming({frequency:'once',date:'2026-02-30',time:'09:00',timezone:'UTC'}));
  refused(400,()=>scheduleTiming({frequency:'daily',time:'09:00',timezone:'Mars/Test'}));
  assert.equal(nextSchedule({frequency:'once',date:'2026-03-08',time:'02:30',timezone:'America/Detroit'},new Date('2026-03-08T05:00Z')),null);
});

test('new owner must accept setup and can replace the former owner schedule mandate',withWorld(w=>{
  const saved=w.projects.create(w.owner,input()),pid=saved.project.id;
  w.projects.saveSchedule(w.owner,pid,scheduleInput(w,pid,{timing,authorize_unattended:true}));
  const next=w.addUser();w.store.grant(w.owner,pid,next.id,w.store.get(w.owner,pid).revision,{role:'editor'});
  const offered=w.store.offer(w.owner,pid,w.store.get(w.owner,pid).revision,{target_user_id:next.id}).offer;
  w.store.decideOffer(next,pid,offered.id,offered.revision,{decision:'accept'});
  const c=w.projects.get(next,pid).task.configuration;
  const edited=w.projects.edit(next,pid,1,{name:saved.project.name,goal:saved.project.description,accepted_defaults:PROJECT_DEFAULTS_VERSION,project_revision:w.store.get(next,pid).revision,configuration_revision:c.revision});
  const resumed=w.projects.saveSchedule(next,pid,{timing,authorize_unattended:true,task_revision:edited.task.revision,project_revision:edited.project.revision,configuration_revision:edited.task.configuration.revision},edited.schedules[0].revision);
  assert.equal(w.db.prepare('SELECT owner_user_id FROM ops_project_schedules WHERE id=?').get(resumed.schedules[0].id).owner_user_id,next.id);
}));

test('HTTP surface retains feature and sudo gates and has no unattended-start endpoint',withWorld(async w=>{
  const router=fixtureRouter();createOperationsRouter({Router:()=>router,store:w.store,enabled:true,agentsEnabled:true,browserRuntime:{projects:w.projects,runs:w.runs,execution:{configured:false}},requireSudo:(_r,res)=>res.status(401).json({sudo_required:true})});
  const request=(method,path,body)=>router.dispatch({method,path,body,user:w.owner});
  assert.equal((await request('POST','/project-tasks',input())).statusCode,401);
  assert.equal((await request('POST','/project-tasks/start-scheduled',{})).statusCode,404);
  const caps=await request('GET','/capabilities');assert.equal(caps.body.streamlined_project_setup,true);
}));
