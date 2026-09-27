import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { operationsFixture } from './helpers/operations-fixture.js';
import { BROWSER_ACTIONS, WORKER_INSTALL_BASELINE, WORKER_TARGET, createOperationalWorkerStore,
  createWorkerLauncher, validateBrowserAction, validateWorkerLaunch, workerInstallResources } from '../lib/operational-worker-boundary.js';
import { createSyntheticSignInBrowserBroker, permitsSyntheticRequest } from '../lib/operational-browser-broker.js';

const hash = 'a'.repeat(64);
const launch = () => ({run_id:randomUUID(),attempt_id:randomUUID(),fence:1,
  policy_digest:hash,origin:'https://demo.fractionate.ai',target:WORKER_TARGET,limits:{},
  install:{...WORKER_INSTALL_BASELINE}});

test('typed launch and browser broker refuse caller-selected capabilities; absent OS runner fails closed', async () => {
  const spec=launch();
  assert.equal(validateWorkerLaunch(spec).target,WORKER_TARGET);
  assert.deepEqual(validateWorkerLaunch(spec).install,WORKER_INSTALL_BASELINE);
  assert.equal(validateWorkerLaunch({...spec,limits:{cpu:2,memory_mib:4096,max_seconds:3600}}).limits.max_seconds,3600);
  assert.deepEqual(workerInstallResources({cpu:4,memory_mib:8192}),
    {cpu:4,memory_mib:8192,root_disk_gib:12});
  for (const patch of [{argv:['sh']},{origin:'https://other.test'},{limits:{memory_mib:-1}},
    {limits:{shell:true}},{limits:{cpu:1}},{limits:{memory_mib:2048}},
    {install:{cpu:1,memory_mib:4096,root_disk_gib:12}},
    {target:'host-root'},{policy_digest:'bad'}])
    assert.throws(()=>validateWorkerLaunch({...spec,...patch}));
  const action={run_id:spec.run_id,attempt_id:spec.attempt_id,fence:1,action:'open_landing'};
  assert.equal(validateBrowserAction(action).action,'open_landing');
  for (const extra of [{action:'shell'},{url:'file:///etc/shadow'},{selector:'body'},
    {action:'navigate'},{action:'fetch'},{action:'download'}])
    assert.throws(()=>validateBrowserAction({...action,...extra}));
  assert.equal(BROWSER_ACTIONS.length,7);
  await assert.rejects(createWorkerLauncher().launch(spec),{code:'BOUNDARY_UNVERIFIED'});
  await assert.rejects(createWorkerLauncher().stop({run_id:spec.run_id,attempt_id:spec.attempt_id,fence:1}),
    {code:'BOUNDARY_UNVERIFIED'});
});

test('browser request policy pins method, origin and path, including redirects and management destinations', () => {
  for (const [url,method] of [
    ['https://demo.fractionate.ai/','GET'],
    ['https://demo.fractionate.ai/workspace','GET'],
    ['https://demo.fractionate.ai/api/session','GET'],
    ['https://demo.fractionate.ai/assets/index-a1b2.js','GET'],
    ['https://demo.fractionate.ai/api/logout','POST'],
  ]) assert.equal(permitsSyntheticRequest(url,method),true,url);
  for (const [url,method] of [
    ['https://evil.invalid/','GET'],
    ['http://demo.fractionate.ai/','GET'],
    ['https://demo.fractionate.ai.evil.invalid/','GET'],
    ['https://demo.fractionate.ai@evil.invalid/','GET'],
    ['https://demo.fractionate.ai:444/','GET'],
    ['https://demo.fractionate.ai/admin','GET'],
    ['https://demo.fractionate.ai/api/session?token=x','GET'],
    ['https://demo.fractionate.ai/api/files/sample-metrics/download','GET'],
    ['https://demo.fractionate.ai/api/login','GET'],
    ['https://demo.fractionate.ai/api/login','POST'],
    ['https://demo.fractionate.ai/api/files','POST'],
    ['file:///etc/passwd','GET'],
    ['http://127.0.0.1:3001/api/','GET'],
  ]) assert.equal(permitsSyntheticRequest(url,method),false,url);
});

test('browser broker refuses an unverified routing capability and closes its context', async () => {
  let closed=0;
  const browser={newContext:async()=>({route:async()=>{},newPage:async()=>({}),close:async()=>{closed++;}})};
  await assert.rejects(createSyntheticSignInBrowserBroker({browser,reserveAction:async()=>{}}),
    {code:'BROWSER_BOUNDARY_UNAVAILABLE'});
  assert.equal(closed,1);
});

test('browser broker delegates project action totals to the durable reservation', async () => {
  let reserved=0, closed=0;
  const page={setDefaultTimeout(){},setDefaultNavigationTimeout(){},
    evaluate:async()=>({authenticated:false})};
  const context={route:async()=>{},routeWebSocket:async()=>{},on(){},
    newPage:async()=>page,close:async()=>{closed++;}};
  const broker=await createSyntheticSignInBrowserBroker({browser:{newContext:async()=>context},
    reserveAction:async()=>{if (++reserved>25) {
      const error=new Error('ACTION_LIMIT'); error.code='ACTION_LIMIT'; throw error;
    }}});
  const request={...launch(),action:'read_session'};
  const action={run_id:request.run_id,attempt_id:request.attempt_id,fence:request.fence,
    action:request.action};
  for(let i=0;i<25;i++)
    assert.deepEqual(await broker.perform(action),{untrusted_page_claim_authenticated:false});
  await assert.rejects(broker.perform(action),{code:'ACTION_LIMIT'});
  assert.equal(reserved,26);
  await broker.close();
  assert.equal(closed,1);
});

test('durable single profile run, attempt fence, action quota, launch failure and restart block', async () => {
  const f=operationsFixture();
  try {
    const owner=f.addUser(), reviewer=f.addUser();
    const p=f.store.create(owner,{name:'A3 fixture'});
    f.store.grant(owner,p.id,reviewer.id,p.revision,{role:'reviewer'});
    f.store.site(owner,p.id,f.store.get(owner,p.id).revision,{site_origin:'https://demo.fractionate.ai'});
    f.store.agentLimits(owner,p.id,f.store.get(owner,p.id).revision,
      {limits:{cpu:2,memory_mib:4096,temporary_disk_mib:256,max_seconds:300,max_actions:20}});
    const created=f.store.createProfile(owner,p.id,f.store.get(owner,p.id).revision,
      {display_name:'Synthetic',workflow_type:'synthetic_sign_in',proposed_actions:['navigate','read'],
        proposed_origins:['https://demo.fractionate.ai']}).profile;
    f.store.saveDraft(owner,p.id,1,{title:'Guide',instructions:'Synthetic only'});
    const submitted=f.store.submit(owner,p.id,2,{}).submission;
    const version=f.store.review(reviewer,p.id,submitted.id,1,{decision:'approve'}).version;
    const profile=f.store.assignProfile(owner,p.id,created.id,created.revision,{guide_version_id:version.id}).profile;
    const project=f.store.get(owner,p.id);
    let now=new Date('2026-09-25T00:00:00Z');
    const workers=createOperationalWorkerStore(f.db,()=>now,randomUUID,
      (receipt,expected)=>receipt.attestation===`test-only:${expected.workspace_id}`);
    const teardown=(runId,attempt)=>({run_id:runId,attempt_id:attempt.attempt_id,fence:attempt.fence,
      descendants_gone:true,workspace_removed:true,attestation:`test-only:${attempt.workspace_id}`});
    const config={project_id:p.id,profile_id:profile.id,profile_revision:profile.revision,
      site_origin:'https://demo.fractionate.ai',site_revision:project.site_revision,
      guide_version_id:version.id,guide_hash:version.content_hash,policy_digest:hash};
    const r=workers.prepare(config);
    assert.throws(()=>workers.prepare(config),/UNIQUE/);
    const a=workers.reserveAttempt(r.run_id);
    assert.deepEqual(workers.launchSpec(a).limits,
      {cpu:2,memory_mib:4096,temporary_disk_mib:256,max_seconds:300,max_actions:20});
    assert.deepEqual(workers.launchSpec(a).install,WORKER_INSTALL_BASELINE);
    const actionRef={run_id:a.run_id,attempt_id:a.attempt_id,fence:a.fence};
    assert.throws(()=>workers.reserveAttempt(r.run_id),{code:'RUN_NOT_PREPARED'});
    workers.markRunning(a);
    for(let i=0;i<20;i++) assert.equal(workers.authorizeAction({...actionRef,action:'read_session'}).ordinal,i+1);
    assert.throws(()=>workers.authorizeAction({...actionRef,action:'read_session'}),{code:'ACTION_LIMIT'});
    assert.deepEqual(workers.fence(r.run_id),
      {run_id:r.run_id,attempt_id:a.attempt_id,previous_fence:a.fence,reason:'cancelled'});
    assert.throws(()=>workers.fence(r.run_id),{code:'RUN_NOT_ACTIVE'});
    assert.throws(()=>workers.authorizeAction({...actionRef,action:'read_session'}),{code:'STALE_WORKER'});
    assert.throws(()=>workers.finishStop(r.run_id,'cancelled',{}),{code:'TEARDOWN_UNVERIFIED'});
    assert.throws(()=>createOperationalWorkerStore(f.db,()=>now).finishStop(r.run_id,'cancelled',
      teardown(r.run_id,a)),{code:'TEARDOWN_UNVERIFIED'});
    workers.finishStop(r.run_id,'cancelled',teardown(r.run_id,a));
    assert.throws(()=>workers.markRunning(a),{code:'STALE_WORKER'});
    const launchFail=workers.prepare(config), failedAttempt=workers.reserveAttempt(launchFail.run_id);
    await assert.rejects(createWorkerLauncher().launch({...launch(),run_id:launchFail.run_id,
      attempt_id:failedAttempt.attempt_id,fence:failedAttempt.fence}),{code:'BOUNDARY_UNVERIFIED'});
    workers.fence(launchFail.run_id,'failed');
    assert.throws(()=>workers.markRunning(failedAttempt),{code:'STALE_WORKER'});
    workers.finishStop(launchFail.run_id,'failed',teardown(launchFail.run_id,failedAttempt));
    const next=workers.prepare(config), pending=workers.reserveAttempt(next.run_id);
    assert.deepEqual(workers.recover(),[next.run_id]);
    assert.throws(()=>workers.markRunning(pending),{code:'STALE_WORKER'});
    assert.deepEqual(workers.recover(),[]);
    assert.throws(()=>workers.prepare(config),/UNIQUE/);
    workers.finishStop(next.run_id,'blocked',teardown(next.run_id,pending));
    const expiring=workers.prepare(config), expiringAttempt=workers.reserveAttempt(expiring.run_id);
    workers.markRunning(expiringAttempt);
    now=new Date(now.getTime()+300_001);
    assert.throws(()=>workers.authorizeAction({run_id:expiring.run_id,attempt_id:expiringAttempt.attempt_id,
      fence:expiringAttempt.fence,action:'read_session'}),{code:'STALE_WORKER'});
    assert.deepEqual(workers.recover(),[expiring.run_id]);
    workers.finishStop(expiring.run_id,'blocked',teardown(expiring.run_id,expiringAttempt));
    f.store.agentLimits(owner,p.id,f.store.get(owner,p.id).revision,
      {limits:{max_seconds:30,max_actions:2}});
    const narrow=f.store.createProfile(owner,p.id,f.store.get(owner,p.id).revision,
      {display_name:'Narrow',workflow_type:'synthetic_sign_in',proposed_actions:['navigate'],
        proposed_origins:['https://demo.fractionate.ai']}).profile;
    const narrowAssigned=f.store.assignProfile(owner,p.id,narrow.id,narrow.revision,{guide_version_id:version.id}).profile;
    const narrowRun=workers.prepare({...config,profile_id:narrow.id,profile_revision:narrowAssigned.revision});
    const narrowAttempt=workers.reserveAttempt(narrowRun.run_id);
    workers.markRunning(narrowAttempt);
    const narrowAction={run_id:narrowRun.run_id,attempt_id:narrowAttempt.attempt_id,fence:narrowAttempt.fence};
    assert.throws(()=>workers.authorizeAction({...narrowAction,action:'read_session'}),{code:'ACTION_NOT_CONFIGURED'});
    assert.equal(workers.authorizeAction({...narrowAction,action:'open_landing'}).ordinal,1);
    assert.equal(workers.authorizeAction({...narrowAction,action:'open_landing'}).ordinal,2);
    assert.throws(()=>workers.authorizeAction({...narrowAction,action:'open_landing'}),{code:'ACTION_LIMIT'});
    now=new Date(now.getTime()+30_001);
    assert.throws(()=>workers.authorizeAction({...narrowAction,action:'open_landing'}),{code:'STALE_WORKER'});
    workers.recover();
    workers.finishStop(narrowRun.run_id,'blocked',teardown(narrowRun.run_id,narrowAttempt));
    f.store.agentLimits(owner,p.id,f.store.get(owner,p.id).revision,{limits:{}});
    const unbounded=workers.prepare(config),unboundedAttempt=workers.reserveAttempt(unbounded.run_id);
    assert.equal(unbounded.deadline_at,null);
    assert.deepEqual(workers.launchSpec(unboundedAttempt).limits,{});
    workers.markRunning(unboundedAttempt);
    const unboundedAction={run_id:unbounded.run_id,attempt_id:unboundedAttempt.attempt_id,
      fence:unboundedAttempt.fence,action:'read_session'};
    for(let i=0;i<25;i++) assert.equal(workers.authorizeAction(unboundedAction).ordinal,i+1);
    now=new Date(now.getTime()+20_000);
    workers.renewLease(unboundedAttempt);
    now=new Date(now.getTime()+20_000);
    assert.equal(workers.authorizeAction(unboundedAction).ordinal,26);
    f.store.agentLimits(owner,p.id,f.store.get(owner,p.id).revision,{limits:{max_actions:1}});
    assert.throws(()=>workers.authorizeAction(unboundedAction),{code:'STALE_CONFIGURATION'});
    assert.deepEqual(workers.recover(),[unbounded.run_id]);
    workers.finishStop(unbounded.run_id,'blocked',teardown(unbounded.run_id,unboundedAttempt));
    f.store.agentLimits(owner,p.id,f.store.get(owner,p.id).revision,{limits:{cpu:1}});
    assert.throws(()=>workers.prepare(config),{code:'PROJECT_LIMIT_BELOW_WORKER_MINIMUM'});
    f.store.agentLimits(owner,p.id,f.store.get(owner,p.id).revision,{limits:{max_actions:1}});
    const siteChange=workers.prepare(config), siteAttempt=workers.reserveAttempt(siteChange.run_id);
    workers.markRunning(siteAttempt);
    f.store.site(owner,p.id,f.store.get(owner,p.id).revision,{site_origin:null});
    assert.throws(()=>workers.authorizeAction({run_id:siteChange.run_id,attempt_id:siteAttempt.attempt_id,
      fence:siteAttempt.fence,action:'read_session'}),{code:'STALE_CONFIGURATION'});
    workers.recover();
    const events=f.db.prepare('SELECT kind FROM ops_agent_worker_events WHERE run_id=? ORDER BY id').all(r.run_id);
    assert.equal(events.filter(x=>x.kind==='action:read_session').length,20);
    assert.throws(()=>f.db.exec('DELETE FROM ops_agent_worker_events'));
    assert.throws(()=>f.db.prepare("UPDATE ops_agent_runs SET state='running' WHERE id=?").run(r.run_id));
    assert.throws(()=>f.db.prepare('DELETE FROM ops_agent_runs WHERE id=?').run(r.run_id));
    assert.throws(()=>f.db.prepare("UPDATE ops_agent_worker_attempts SET state='running' WHERE id=?").run(a.attempt_id));
  } finally {f.close();}
});
