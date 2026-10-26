import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createToolkit } from '../routes/mcp-tools/common.js';
import { createApplicationReleaseHandlers } from '../routes/mcp-tools/application-releases.js';
import { createConfirmationStore, parseTokenScope, scopeRefusal } from '../lib/mcp-ext/logic.js';
import { MCP_TOOLS } from '../lib/mcp-logic.js';

const auth={id:7,created_by:'owner',scope_json:null};
const parse=r=>JSON.parse(r.content[0].text);
function fixture(){
  const writes=[];const jobs=[];const tickets=new Map(),discarded=[];
  const app={id:1,name:'Nodus',targetId:'nodus',profile:{revision:1,digest:'a'.repeat(64)}};
  const candidate={sha:'b'.repeat(40),treeSha:'c'.repeat(40)};
  const service={
    listApplications:()=>[app,{id:2,targetId:'another'}],getApplication:()=>app,
    prepareCandidate:async()=>({profile:app.profile,candidate}),prepareDeployment:async()=>({profile:app.profile,candidate}),
    commitChanges:async(...args)=>{writes.push(args);return {committed:true};},
    checkpoint:async(...args)=>{writes.push(args);return {application:app,candidate};},
  };
  const kit=createToolkit({
    toolResult:(v,o={})=>({content:[{type:'text',text:JSON.stringify(v)}],isError:!!o.isError}),
    getDb:()=>({prepare:()=>({run:()=>({})})}),logAudit:()=>{},getSetting:()=>null,
    policy:JSON.parse(readFileSync(new URL('../lib/mcp-policy/mcp-extended-policy.json',import.meta.url))),
    confirmations:createConfirmationStore(),mock2Enabled:()=>true,applicationReleaseService:service,
    applicationReleaseJobs:{submitApplicationReleaseJob:async(db,args)=>{jobs.push(args);return{job:{id:'j1'},created:true};},jobDetail:()=>({job:{id:'j1',plan:{params:{applicationId:1}}}})},
    applicationReleaseDb:{},
    takeUploadTicket:async ticket=>{const buf=tickets.get(ticket);if(!buf)throw new Error('Upload ticket unknown, expired, or no bytes were uploaded to it yet');tickets.delete(ticket);return {buf,discard:async()=>{discarded.push(ticket);}};},
  });
  return {handlers:createApplicationReleaseHandlers(kit),app,writes,jobs,kit,tickets,discarded};
}
test('application readers filter scopes and every ID access verifies its target',async()=>{
  const f=fixture();const r=parse(await f.handlers.list_applications({}, {...auth,scope_json:JSON.stringify({lxc_containers:['nodus']})}));
  assert.deepEqual(r.applications.map(a=>a.id),[1]);
  const bad=await f.handlers.get_application({container:'another',application_id:1},auth);
  assert.equal(bad.isError,true);
  for(const name of ['get_application','commit_application_changes','deploy_application_release','get_application_job']){
    const tool=MCP_TOOLS.find(t=>t.name===name);
    assert.match(scopeRefusal(parseTokenScope({lxc_containers:['nodus']}),name,{container:'another',application_id:1},tool),/outside/);
  }
});
test('preview and missing confirmation do not write; exact commit parameters reach service',async()=>{
  const f=fixture();const args={container:'nodus',application_id:1,parent_sha:'d'.repeat(40),branch:'review/one',message:'fix',patch:'patch'};
  await f.handlers.commit_application_changes({...args,dry_run:true},auth);assert.equal(f.writes.length,0);
  assert.equal((await f.handlers.commit_application_changes(args,auth)).isError,true);assert.equal(f.writes.length,0);
  await f.handlers.commit_application_changes({...args,confirm:true},auth);
  assert.deepEqual(f.writes[0],[1,{parentSha:args.parent_sha,branch:'review/one',message:'fix',patch:'patch'}]);
});
test('a large diff can arrive through an upload ticket, taken only when the commit is confirmed',async()=>{
  const f=fixture();const diff='diff --git a/x b/x\n'+'+line\n'.repeat(5000);f.tickets.set('t-large',Buffer.from(diff));
  const args={container:'nodus',application_id:1,parent_sha:'d'.repeat(40),branch:'work/one',message:'large',ticket:'t-large'};
  const preview=parse(await f.handlers.commit_application_changes({...args,dry_run:true},auth));
  assert.equal(preview.would.patch_source,'ticket');assert.equal(preview.would.ticket,'consumed on apply');
  assert.equal((await f.handlers.commit_application_changes(args,auth)).isError,true);
  assert.equal(f.tickets.has('t-large'),true);assert.equal(f.writes.length,0);
  const sha256=createHash('sha256').update(diff).digest('hex');
  await f.handlers.commit_application_changes({...args,sha256,confirm:true},auth);
  assert.deepEqual(f.writes[0],[1,{parentSha:args.parent_sha,branch:'work/one',message:'large',patch:diff}]);
  assert.equal(f.tickets.has('t-large'),false);assert.deepEqual(f.discarded,['t-large']);
  // Single-use: the same ticket cannot commit twice.
  assert.match((await f.handlers.commit_application_changes({...args,confirm:true},auth)).content[0].text,/unknown, expired/);assert.equal(f.writes.length,1);
});
test('a ticketed diff that does not match its sha256, or an ambiguous source, commits nothing',async()=>{
  const f=fixture();f.tickets.set('t-bad',Buffer.from('diff --git a/y b/y\n+changed in transit\n'));
  const args={container:'nodus',application_id:1,parent_sha:'d'.repeat(40),branch:'work/one',message:'bad',confirm:true};
  assert.match((await f.handlers.commit_application_changes({...args,ticket:'t-bad',sha256:'0'.repeat(64)},auth)).content[0].text,/sha256 does not match/);
  assert.match((await f.handlers.commit_application_changes({...args,patch:'p',sha256:'0'.repeat(64)},auth)).content[0].text,/sha256 does not match/);
  for(const source of [{},{patch:'p',ticket:'t-other'},{patch:''}])
    assert.match((await f.handlers.commit_application_changes({...args,...source},auth)).content[0].text,/exactly one of patch/);
  assert.equal(f.writes.length,0);
});
test('deploy confirmation is bound to profile and candidate; queue acceptance returns poll instruction',async()=>{
  const f=fixture();const args={container:'nodus',application_id:1,sha:'b'.repeat(40)};
  const preview=parse(await f.handlers.deploy_application_release(args,auth));assert.equal(f.jobs.length,0);
  f.app.profile.digest='f'.repeat(64);
  assert.equal((await f.handlers.deploy_application_release({...args,confirmation_token:preview.confirmation_token},auth)).isError,true);assert.equal(f.jobs.length,0);
  const newPreview=parse(await f.handlers.deploy_application_release(args,auth));
  const result=parse(await f.handlers.deploy_application_release({...args,confirmation_token:newPreview.confirmation_token},auth));
  assert.equal(f.jobs.length,1);assert.equal(result.next_actions[0].tool,'get_application_job');assert.equal(result.job.id,'j1');
  assert.equal(f.jobs[0].expectedProfileDigest,'f'.repeat(64));assert.equal(f.jobs[0].expectedTreeSha,'c'.repeat(40));
});
test('checkpoint exposes resolved candidate and job reads do not depend on a truncated history list',async()=>{
  const f=fixture();const args={container:'nodus',application_id:1};
  const checkpoint=parse(await f.handlers.checkpoint_application({...args,ref:'main',confirm:true},auth));
  assert.equal(checkpoint.application.id,1);assert.equal(checkpoint.candidate.sha,'b'.repeat(40));
  assert.equal(parse(await f.handlers.get_application_job({...args,job_id:'j1'},auth)).job.id,'j1');
  f.kit.ctx.applicationReleaseJobs.jobDetail=()=>({job:{id:'foreign',plan:{params:{applicationId:2}}}});
  assert.equal((await f.handlers.get_application_job({...args,job_id:'foreign'},auth)).isError,true);
});
test('snapshot remote reader respects disabled Dev Studio before opening optional storage',async()=>{
  const f=fixture();f.kit.ctx.mock2Enabled=()=>false;
  f.kit.ctx.applicationGitConnectors={getTargetRemote:()=>{throw new Error('must not open DB');}};
  assert.match((await f.handlers.get_git_remote({kind:'lxc',target:'nodus'},auth)).content[0].text,/disabled/);
});
test('a job that met an enabled legacy startup unit points at the unit, not at another release job',async()=>{
  const f=fixture();const args={container:'nodus',application_id:1,job_id:'j1'};
  const event={kind:'legacy_startup',message:'enabled',data:{code:'LEGACY_STARTUP_ENABLED',unit:'proxypilot-startup.service'}};
  for(const detail of [{job:{id:'j1',status:'failed',outcome:'LEGACY_STARTUP_ENABLED',plan:{params:{applicationId:1}}},events:[event]},{job:{id:'j1',status:'succeeded',outcome:'validated',plan:{params:{applicationId:1}}},events:[event]}]){
    f.kit.ctx.applicationReleaseJobs.jobDetail=()=>detail;
    const r=parse(await f.handlers.get_application_job(args,auth));
    assert.equal(r.next_actions[0].tool,'get_lxc_startup');assert.deepEqual(r.next_actions[0].arguments,{container:'nodus'});
    assert.match(r.next_actions[0].purpose,/systemctl disable proxypilot-startup\.service/);assert.match(r.next_actions[0].purpose,/do not run it with rerun_startup/);
  }
  // A disabled (still registered) unit and an ordinary job keep the ordinary next actions.
  f.kit.ctx.applicationReleaseJobs.jobDetail=()=>({job:{id:'j1',status:'succeeded',outcome:'live_verified',plan:{params:{applicationId:1}}},events:[{...event,data:{code:'LEGACY_STARTUP_REGISTERED'}}]});
  assert.equal(parse(await f.handlers.get_application_job(args,auth)).next_actions[0].tool,'get_application');
});
