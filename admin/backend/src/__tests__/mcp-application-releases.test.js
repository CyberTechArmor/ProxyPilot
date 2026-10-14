import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createToolkit } from '../routes/mcp-tools/common.js';
import { createApplicationReleaseHandlers } from '../routes/mcp-tools/application-releases.js';
import { createConfirmationStore, parseTokenScope, scopeRefusal } from '../lib/mcp-ext/logic.js';
import { MCP_TOOLS } from '../lib/mcp-logic.js';

const auth={id:7,created_by:'owner',scope_json:null};
const parse=r=>JSON.parse(r.content[0].text);
function fixture(){
  const writes=[];const jobs=[];
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
  });
  return {handlers:createApplicationReleaseHandlers(kit),app,writes,jobs,kit};
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
