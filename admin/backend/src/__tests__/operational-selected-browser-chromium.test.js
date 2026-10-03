import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { operationsFixture } from './helpers/operations-fixture.js';
import { operationalSelectedBrowserMigration1118 } from '../lib/operational-selected-browser-schema.js';
import { operationalBrowserArtifactsMigration1119 } from '../lib/operational-browser-artifacts-schema.js';
import { operationalBrowserConversionMigration1120 } from '../lib/operational-browser-conversion.js';
import { createSelectedBrowserRuntime, operationalSelectedBrowserRuntimeMigration1121 } from '../lib/operational-selected-browser-runtime.js';
import { operationalSelectedBrowserAuthMigration1122 } from '../lib/operational-selected-browser-auth-schema.js';
import { recordControlGrant } from '../lib/operational-control-grants.js';
import { SELECTED_BROWSER_CONSENT } from '../lib/operational-selected-browser-contract.js';

const root = fileURLToPath(new URL('../../../../', import.meta.url));

// Cross-language local composition, never installed isolation acceptance. This
// test injects only the supervisor transport, provider and installed OS boundary;
// there are no synthetic blocked polls or direct-host destination grants.
test('service approval settles actual Chromium off-list action before a temporary grant and fresh next action',
  { skip: !process.env.CI && !existsSync('/usr/bin/chromium') && 'Local Chromium is required', timeout: 60000 }, async t => {
  assert.equal(existsSync('/usr/bin/chromium'),true,'CI must install the fixed /usr/bin/chromium test browser');
  const child = spawn('python3', ['-u', path.join(root, 'scripts/tests/selected_browser_backend_bridge.py')],
    { cwd: root, stdio: ['pipe','pipe','pipe'] });
  const pending = new Map(), rpcHistory=[], stageTimings=[]; let sequence = 0, stderr = '', ended = false, transportFailure = null, bridgeEvidence=null, launchEvidence=null;
  const remember = value => { rpcHistory.push(value);if(rpcHistory.length>32)rpcHistory.shift();
    if(['fixture_bootstrap','selected_browser_status','selected_browser_model_status','selected_browser_launch','selected_browser_stop'].includes(value.method)){stageTimings.push(value);if(stageTimings.length>8)stageTimings.shift();} };
  const rejectPending = error => { for (const job of pending.values()) { clearTimeout(job.timer); job.reject(error); } pending.clear(); };
  let resolveExit; const exited = new Promise(resolve => { resolveExit=resolve; });
  child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-10000); });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    let value;
    try { value=JSON.parse(line);if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Unexpected reply'); } catch {
      transportFailure??=new Error('Malformed browser fixture reply\n'+stderr); rejectPending(transportFailure); child.kill('SIGTERM'); return;
    }
    if(value.event==='fixture_diagnostics'){
      if(typeof value.phase!=='string'||value.phase.length>64||!value.evidence||typeof value.evidence!=='object'||Array.isArray(value.evidence)||Buffer.byteLength(JSON.stringify(value.evidence))>16000){
        transportFailure??=new Error('Invalid browser fixture diagnostics\n'+stderr);rejectPending(transportFailure);child.kill('SIGTERM');return;
      }
      bridgeEvidence={phase:value.phase,evidence:value.evidence};if(value.phase.startsWith('launch_'))launchEvidence=bridgeEvidence;return;
    }
    const job = pending.get(value.id);
    if (!job) return; pending.delete(value.id); clearTimeout(job.timer);
    remember({method:job.method,elapsed_ms:Date.now()-job.started,status:value.error?'refused':'returned',code:value.error?.code??null});
    if (value.error) job.reject(Object.assign(new Error(value.error.code + ': ' + value.error.detail + '\n' + value.error.diagnostics), value.error));
    else job.resolve(value.result);
  });
  child.on('error', error => { transportFailure??=error; ended=true; rejectPending(transportFailure); resolveExit(); });
  child.on('exit', code => { ended=true; rejectPending(new Error('Browser fixture exited ' + code + '\n' + stderr)); resolveExit(); });
  child.stdin.on('error', error => { transportFailure??=error; rejectPending(transportFailure); });
  const client = { request(method, params = {}) {
    if(ended||transportFailure)return Promise.reject(transportFailure??new Error('Browser fixture has exited\n'+stderr));
    return new Promise((resolve, reject) => {
      const id = ++sequence, started=Date.now(), timer = setTimeout(() => {
        transportFailure=Object.assign(new Error('Browser fixture deadline: '+method+'\n'+stderr),{code:'FIXTURE_RPC_DEADLINE'});
        remember({method,elapsed_ms:Date.now()-started,status:'deadline',code:transportFailure.code});
        // A timed-out command may still be running. Never reuse its stream or
        // enqueue cleanup/diagnostics behind it; the owned child performs cleanup.
        rejectPending(transportFailure);child.kill('SIGTERM');
      }, method==='fixture_close'?5000:20000);
      pending.set(id, {resolve, reject, timer,method,started});
      child.stdin.write(JSON.stringify({id,method,params})+'\n',error=>{if(error){transportFailure??=error;rejectPending(transportFailure);}});
    });
  } };
  const waitExit = ms => new Promise(resolve=>{if(ended)return resolve(true);const timer=setTimeout(()=>resolve(false),ms);exited.then(()=>{clearTimeout(timer);resolve(true);});});
  const f = operationsFixture(); let runtime, runId;
  const storage = mkdtempSync(path.join(tmpdir(),'pp-node-chromium-')); chmodSync(storage,0o700);
  try {
    const bootstrap = await client.request('fixture_bootstrap');
    for (const migrate of [operationalSelectedBrowserMigration1118, operationalBrowserArtifactsMigration1119,
      operationalBrowserConversionMigration1120, operationalSelectedBrowserRuntimeMigration1121, operationalSelectedBrowserAuthMigration1122]) migrate(f.adapter);
    f.db.exec('ALTER TABLE sessions ADD COLUMN sudo_until TEXT');
    const owner = f.addUser(), p = f.store.create(owner,{name:'Cross-language browser proof'});
    const guide = f.store.saveDraft(owner,p.id,1,{title:'Selected local pages',instructions:'Read selected pages with explicit destination approval.'}).version;
    const c = bootstrap.configuration; c.work.guide_ref={id:guide.id,sha256:guide.content_hash};
    const configuration = f.store.createBrowserConfiguration(owner,p.id,f.store.get(owner,p.id).revision,{configuration:c}).configuration;
    owner.jti=randomUUID(); const expires=new Date(Date.now()+3600000).toISOString();
    f.db.prepare('INSERT INTO sessions(id,user_id,expires_at,sudo_until) VALUES(?,?,?,?)').run(owner.jti,owner.id,expires,expires);
    recordControlGrant(f.adapter,{sessionId:owner.jti,userId:owner.id,factor:'passkey',at:new Date().toISOString()});
    runtime=createSelectedBrowserRuntime({execution:{socket:'/fixture-injected',publicKeyPath:bootstrap.public_key_path,vmUuid:bootstrap.vm_uuid}},
      {db:f.adapter,store:f.store,client,artifactConfig:{available:true,root:storage,quota:134217728},
        isEnabled:()=>true,isMetadataEnabled:()=>true,scheduleInterval:()=>({unref(){}}),cancelInterval(){}});
    runtime.runs.consent(owner,p.id,configuration.id,{configuration_revision:configuration.revision,
      configuration_sha256:configuration.configuration_sha256,allow:true,reviewed_statement:SELECTED_BROWSER_CONSENT});
    const started=await runtime.runs.start(owner,p.id,configuration.id,{configuration_revision:configuration.revision,
      configuration_sha256:configuration.configuration_sha256,project_revision:f.store.get(owner,p.id).revision,idempotency_key:randomUUID()});
    runId=started.run.id;
    const get=()=>runtime.runs.get(owner,p.id,runId);
    const assertRunning=async(dto,phase)=>{
      if(dto.run.state==='running')return;
      let inspection=null,inspectionError=null;
      if(!ended&&!transportFailure)try{inspection=await client.request('fixture_diagnostics');}catch(error){inspectionError={code:error.code??null,message:error.message.slice(0,2000)};}
      assert.fail('Actual browser '+phase+' failed before step: '+JSON.stringify({
        run:{state:dto.run.state,result_code:dto.run.result_code,revision:dto.run.revision,fence:dto.run.fence,usage:dto.run.usage},
        uncertainties:dto.uncertainties,receipts:dto.receipts.map(receipt=>({closed:receipt.closed,final_network:receipt.final_network})),
        rpc_history:rpcHistory,transport_failure:transportFailure?{code:transportFailure.code??null,message:transportFailure.message.slice(0,2000)}:null,
        launch_evidence:launchEvidence,bridge_evidence:bridgeEvidence,inspection,inspection_error:inspectionError,stderr}));
    };
    await assertRunning(started,'launch');
    const step=async()=>{const current=get();await assertRunning(current,'continuation');return runtime.runs.step(owner,p.id,runId,current.run.revision);};
    const settle=async predicate=>{
      const until=Date.now()+5000;
      while(Date.now()<until) { await runtime.runs.refresh(owner,p.id,runId); if(predicate(get())) return get(); await delay(25); }
      assert.fail('Actual host continuation did not settle: '+JSON.stringify({dto:get(),host:await client.request('fixture_inspect')}));
    };
    await step(); await settle(()=>f.db.prepare("SELECT state FROM ops_selected_browser_steps WHERE run_id=? AND ordinal=1").get(runId)?.state==='done');
    // Delay only delivery of the next real guest result. Poll/grant responses
    // still come from the host, so this proves an unfinished action cannot grant.
    await client.request('fixture_hold_completion');
    await step(); const waiting=await settle(d=>d.pending_approvals.some(a=>a.kind==='off_list_destination'));
    const approval=waiting.pending_approvals.find(a=>a.kind==='off_list_destination');
    assert.equal(approval.origin,'https://frame.example'); assert.equal(approval.no_contact,true);
    const before=await client.request('fixture_inspect');
    assert.equal(before.contacts.some(([,host])=>host==='frame.example'),false);
    assert.equal(before.upstream.some(([host])=>host==='frame.example'),false);
    await assert.rejects(runtime.runs.decision(owner,p.id,runId,approval.id,get().run.revision-1,{decision:'approve',action_sha256:approval.action_sha256}),{status:412});
    await assert.rejects(runtime.runs.decision(owner,p.id,runId,approval.id,get().run.revision,{decision:'approve',action_sha256:'0'.repeat(64)}),{code:'APPROVAL_STALE'});
    await runtime.runs.decision(owner,p.id,runId,approval.id,get().run.revision,{decision:'approve',action_sha256:approval.action_sha256});
    await runtime.runs.refresh(owner,p.id,runId);
    assert.equal(get().run.state,'awaiting_approval');
    assert.equal(f.db.prepare('SELECT state FROM ops_selected_browser_steps WHERE run_id=? AND ordinal=2').get(runId).state,'reserved');
    assert.equal(f.db.prepare('SELECT state FROM ops_selected_browser_approvals WHERE id=?').get(approval.id).state,'approved');
    const unfinished=await client.request('fixture_inspect');
    assert.deepEqual(unfinished.attempts[0].pending,before.attempts[0].pending);
    assert.equal(unfinished.calls.filter(c=>c.method==='selected_browser_grant_destination').length,0);
    await client.request('fixture_release_completion');
    await settle(d=>d.run.state==='running'&&f.db.prepare('SELECT state FROM ops_selected_browser_steps WHERE run_id=? AND ordinal=2').get(runId).state==='blocked');
    const granted=await client.request('fixture_inspect');
    assert.equal(granted.calls.filter(c=>c.method==='selected_browser_grant_destination').length,1);
    assert.equal(granted.attempts[0].actions[1].state,'blocked');
    assert.deepEqual(JSON.parse(granted.attempts[0].configuration_json).destinations,c.destinations);
    assert.equal(granted.contacts.filter(([,host])=>host==='frame.example').length,1); // Exact approved network-plan resolution.
    assert.equal(granted.upstream.some(([host])=>host==='frame.example'),false);
    assert.equal(granted.received.some(r=>r.host==='frame.example'),false);
    const consumed=f.db.prepare('SELECT * FROM ops_selected_browser_approvals WHERE id=?').get(approval.id);
    assert.equal(consumed.state,'consumed');
    await assert.rejects(runtime.runs.decision(owner,p.id,runId,approval.id,get().run.revision,{decision:'approve',action_sha256:approval.action_sha256}),{code:'APPROVAL_STALE'});
    const meters=get().run.usage;
    await runtime.runs.refresh(owner,p.id,runId); await runtime.runs.refresh(owner,p.id,runId);
    assert.deepEqual(get().run.usage,meters); // Duplicate polls neither charge twice nor refund.
    await step(); await settle(()=>f.db.prepare('SELECT state FROM ops_selected_browser_steps WHERE run_id=? AND ordinal=3').get(runId)?.state==='done');
    const after=await client.request('fixture_inspect');
    const actions=after.calls.filter(c=>c.method==='selected_browser_action').map(c=>c.params.envelope);
    assert.deepEqual(actions.map(a=>a.ordinal),[1,2,3]);
    assert.equal(actions[2].operation.kind,'read');
    assert.notDeepEqual(actions[2].candidate_ref,actions[1].candidate_ref);
    assert.notDeepEqual(actions[2].snapshot_ref,actions[1].snapshot_ref);
    assert.deepEqual(after.received,granted.received); // New local read sends no old blocked request.
    // A destination grant is not a request-effect grant. A fresh navigation to
    // the temporary origin still waits for its own exact wire approval.
    await step(); const wireWaiting=await settle(d=>d.pending_approvals.some(a=>a.kind==='network_effect'));
    const wire=wireWaiting.pending_approvals.find(a=>a.kind==='network_effect');
    assert.equal(wire.origin,'https://frame.example'); assert.equal(wire.current_action.ordinal,4);
    assert.equal(wire.no_contact,true);
    const beforeWire=await client.request('fixture_inspect');
    assert.equal(beforeWire.received.some(r=>r.host==='frame.example'),false);
    await runtime.runs.decision(owner,p.id,runId,wire.id,get().run.revision,{decision:'approve',action_sha256:wire.action_sha256});
    await settle(d=>['uncertain','failed'].includes(d.run.state));
    const transmitted=await client.request('fixture_inspect');
    assert.deepEqual(transmitted.received.filter(r=>r.host==='frame.example').map(r=>r.path),['/visit']);
    const navigations=transmitted.calls.filter(c=>c.method==='selected_browser_action').map(c=>c.params.envelope);
    assert.deepEqual(navigations.map(a=>a.ordinal),[1,2,3,4]);
    assert.notDeepEqual(navigations[3].candidate_ref,navigations[1].candidate_ref);
    assert.equal(navigations[3].operation.destination_id.startsWith('temporary'),true);
    assert.equal(get().run.usage.actions,4); assert.equal(get().run.usage.tokens,440);
    assert.equal(get().run.state,'uncertain'); // Unclassified GET has no generic business readback.
    assert.equal(get().report,null);
    t.diagnostic('Cross-language browser stages: '+JSON.stringify({browser_version:launchEvidence?.evidence?.browser_version??null,
      startup_phases:launchEvidence?.evidence?.startup_phases??null,browser_processes:launchEvidence?.evidence?.browser_processes??[],
      rpc_deadline_ms:20000,stages:stageTimings,final_state:get().run.state,actions:get().run.usage.actions}));
    runId=null;
  } finally {
    if (runId&&runtime) {
      const row=f.db.prepare('SELECT * FROM ops_selected_browser_runs WHERE id=?').get(runId);
      if(row&&!['completed','cancelled','failed','uncertain'].includes(row.state)) {
        try { await runtime.runs.cancel({id:row.started_by,jti:row.starter_session_id},row.project_id,runId,row.revision); } catch { /* Python fixture owns unconditional child cleanup. */ }
      }
    }
    let closeConfirmed=false;
    try {
      await runtime?.close();
      if(!ended&&!transportFailure)try { await client.request('fixture_close');closeConfirmed=true; } catch { /* Bounded owned-child teardown below. */ }
    } finally {
      child.stdin.end();
      if(!await waitExit(3000)){child.kill('SIGTERM');if(!await waitExit(5000)){child.kill('SIGKILL');assert.equal(await waitExit(3000),true,'Owned Python fixture did not exit\n'+stderr);}}
      lines.close(); rmSync(storage,{recursive:true,force:true}); f.close();
      if(closeConfirmed)assert.equal(child.exitCode,0,'Fixture must verify its owned Chromium group was cleaned up\n'+stderr);
    }
  }
});
