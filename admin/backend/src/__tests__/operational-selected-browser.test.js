import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {readFileSync,mkdtempSync,chmodSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {operationsFixture} from './helpers/operations-fixture.js';
import {operationalSelectedBrowserAuthMigration1122} from '../lib/operational-selected-browser-auth-schema.js';
import {SELECTED_BROWSER_AUTH_STATEMENT,selectedAuthDigest,selectedAuthInventoryDigest} from '../lib/operational-selected-browser-auth-contract.js';
import {operationalSelectedBrowserMigration1118,operationalPublicNavigationMigration1123} from '../lib/operational-selected-browser-schema.js';
import {createSelectedBrowserService,normalizeSelectedBrowserPending} from '../lib/operational-selected-browser-service.js';
import {SELECTED_BROWSER_CONSENT} from '../lib/operational-selected-browser-contract.js';
import {validateBrowserModelRequest,browserModelRequestDigest} from '../lib/operational-browser-model.js';
import {operationalBrowserArtifactsMigration1119} from '../lib/operational-browser-artifacts-schema.js';
import {createBrowserArtifactsStore} from '../lib/operational-browser-artifacts-store.js';
import {createBrowserArtifactsService} from '../lib/operational-browser-artifacts-service.js';
import {createBrowserArtifactFiles} from '../lib/operational-browser-artifacts-files.js';
import {assertOperation} from '../lib/operational-projects-logic.js';
const draft=()=>JSON.parse(readFileSync(new URL('../../../../contracts/browser-agent/fixtures/general-agent.draft.json',import.meta.url),'utf8'));
const ref=()=>({id:randomUUID(),sha256:'b'.repeat(64)});
const pendingPacket=(overrides={})=>{const meters=overrides.cumulativeusage??{requests:0,response_bytes:0};return{pending:[],inflight:0,effects_sent:0,effects_uncertain:0,auth_effects_acknowledged:0,mode:'agent',code:null,...overrides,cumulativeusage:meters,usage:meters};};
function world({runnerChanges={},modelChanges={},configurationChanges=()=>{},proof=true,receipt=true,artifacts=null}={}){
  const f=operationsFixture();operationalSelectedBrowserMigration1118(f.adapter);operationalSelectedBrowserAuthMigration1122(f.adapter);operationalPublicNavigationMigration1123(f.adapter);
  const owner=f.addUser(),viewer=f.addUser(),outsider=f.addUser('admin'),p=f.store.create(owner,{name:'Selected-browser fixtures',members:[{user_id:viewer.id,role:'viewer'}]});
  const guide=f.store.saveDraft(owner,p.id,f.store.draft(owner,p.id).revision,{title:'Current guide',instructions:'Read selected pages and report sources.'}).version;
  const c=draft();c.work.guide_ref={id:guide.id,sha256:guide.content_hash};configurationChanges(c);
  const config=f.store.createBrowserConfiguration(owner,p.id,f.store.get(owner,p.id).revision,{configuration:c}).configuration;
  let time=Date.now();const calls=[],snapshot=ref(),candidate={candidate_ref:ref(),operation:{kind:'read',scope:'visible_page',selection_ref:null},effect:'read'};
  const runner={readiness:async request=>({contract_version:'selected-browser.v1',policy_sha256:request.policy_sha256,available:true,verified_supervisor:true,verified_isolation:true,verified_destinations:true,verified_site_policy:true,supervisor_version:'fixture.v1'}),launch:async identity=>{calls.push(['launch',identity]);return identity;},observe:async()=>({snapshot_ref:snapshot,observation:'Selected page text',candidates:[candidate]}),execute:async packet=>{calls.push(['execute',packet]);return{kind:'done',facts:[{code:'PAGE_READ',source_ref:snapshot}],usage:{requests:1,response_bytes:20,artifact_bytes:0}};},pause:async identity=>{calls.push(['pause',identity]);},resume:async identity=>{calls.push(['resume',identity]);},stop:async identity=>{calls.push(['stop',identity]);const row=f.db.prepare('SELECT usage_json,network_state_json FROM ops_selected_browser_runs WHERE id=?').get(identity.run_id),usage=JSON.parse(row.usage_json),network=JSON.parse(row.network_state_json);return{final_network:{requests:usage.requests,response_bytes:usage.response_bytes,effects_sent:network.effects_sent,effects_uncertain:network.effects_uncertain,auth_effects_acknowledged:f.db.prepare('SELECT COUNT(*) AS n FROM ops_selected_browser_auth_confirmed_requests WHERE run_id=? AND attempt_id=? AND fence=1').get(identity.run_id,identity.attempt_id).n,inflight:0,pending_count:0,ledger_sha256:'f'.repeat(64)},contract_version:'selected-browser.v1',run_id:identity.run_id,attempt_id:identity.attempt_id,fence:identity.fence,policy_sha256:identity.policy_sha256,closed:{browser:true,network:true,session:true,temporary_files:true},attestation:'fixture-signature'};},pollAction:async()=>({kind:'pending'}),pending:async()=>pendingPacket(),takeover:async()=>{},assertTakeover:()=>true,release:async()=>{},grantDestination:async(identity,g)=>calls.push(['grant',g]),live:async()=>({fixture:true}),...runnerChanges};
  const model={readiness:async()=>({available:true}),quote:()=>({tokens:100,usd:0.01,price_table_revision:1}),decide:async request=>{validateBrowserModelRequest(request,{clock:()=>time});calls.push(['model',request]);return{decision:{kind:'candidate',candidate_id:candidate.candidate_ref.id},usage:{tokens:30,usd:0.003,prompt_tokens:20,completion_tokens:10}};},report:async request=>({report:{summary:'A bounded cited report.',citations:request.input.source_inputs.map(s=>s.ref.id),limitations:[]},usage:{tokens:20,usd:0.002}}),...modelChanges};
  const pages=new Map();
  const memory={validateInputs:()=>true,modelInputs:()=>[],stageObservation:async(actor,scope,input)=>{const bytes=Buffer.from(input.text),artifact_ref={id:randomUUID(),sha256:createHash('sha256').update(bytes).digest('hex'),mime_type:'text/plain',byte_count:bytes.length};pages.set(artifact_ref.id,{ref:artifact_ref,text:input.text});return{artifact_ref};},observationInputs:(actor,scope,refs)=>refs.map(ref=>{const p=pages.get(ref.id);if(!p||p.ref.sha256!==ref.sha256)throw Object.assign(new Error('Page source unavailable'),{status:409,code:'PRIVATE_SOURCE_UNAVAILABLE'});return{ref:p.ref,content_sha256:p.ref.sha256,content_kind:'text',text:p.text,image_base64:null,image_mime_type:null};}),observationStatus:(actor,scope,refs)=>refs.map(ref=>({id:ref.id,state:pages.get(ref.id)?.ref.sha256===ref.sha256?'available':'unavailable',code:pages.has(ref.id)?null:'PRIVATE_SOURCE_UNAVAILABLE'})),cancelAttempt:(scope,options)=>{if(!options?.clipboardOnly)pages.clear();}};
  const service=createSelectedBrowserService({db:f.adapter,runner,model,artifacts:artifacts??memory,clock:()=>new Date(time),verifyControl:()=>proof,verifyElevation:()=>proof,verifyReceipt:()=>receipt});
  const consent=()=>service.consent(owner,p.id,config.id,{configuration_revision:config.revision,configuration_sha256:config.configuration_sha256,allow:true,reviewed_statement:SELECTED_BROWSER_CONSENT});
  const start=()=>service.start(owner,p.id,config.id,{project_revision:f.store.get(owner,p.id).revision,configuration_revision:config.revision,configuration_sha256:config.configuration_sha256,idempotency_key:randomUUID()});
  return{f,owner,viewer,outsider,p,config,guide,service,runner,model,memory,pages,calls,snapshot,candidate,consent,start,now:()=>new Date(time).toISOString(),advance:ms=>{time+=ms;f.advance(ms);}};
}
const check=(status,fn,code)=>assert.throws(fn,e=>e.status===status&&(!code||e.code===code));
const rejected=(status,fn,code)=>assert.rejects(fn,e=>e.status===status&&(!code||e.code===code));
const waitFor=async fn=>{for(let i=0;i<1000;i++){if(fn())return;await new Promise(resolve=>setImmediate(resolve));}assert.fail('Expected asynchronous boundary was not reached');};
const withWorld=(fn,options)=>async()=>{const w=world(options);try{await fn(w);}finally{w.f.close();}};
async function authFlow(w,{requests=1,businessWrites=0}={}){
  const session=randomUUID();w.f.db.prepare('INSERT INTO sessions(id,user_id,expires_at) VALUES(?,?,?)').run(session,w.owner.id,new Date(Date.parse(w.now())+3600000).toISOString());w.owner.jti=session;
  let sent=0,acknowledged=0,mode='human',held=[];w.runner.assertAuthenticationController=()=>true;
  const entries=[];
  w.runner.pending=async()=>pendingPacket({pending:held,effects_sent:sent,auth_effects_acknowledged:acknowledged,mode,cumulativeusage:{requests:sent,response_bytes:sent*10}});
  w.runner.authenticationInventory=async identity=>{
    const inventory={schema:'selected-browser-auth-inventory.v1',...identity,controller_id:w.owner.id,session_id:session,viewer_conn_sha256:'9'.repeat(64),ledger_sha256:'8'.repeat(64),effects_sent:sent,effects_uncertain:0,inflight:0,pending_count:held.length,auth_effects_acknowledged:acknowledged,requests:entries.filter(entry=>!entry.acknowledged).map(({acknowledged,...entry})=>entry),attestation:'verified-inventory-fixture'};
    inventory.inventory_sha256=selectedAuthInventoryDigest(inventory);return inventory;
  };
  w.runner.confirmAuthentication=async(identity,packet)=>{
    w.calls.push(['confirm-auth',packet]);for(const entry of entries)if(packet.request_refs.some(ref=>ref.request_ref===entry.request_ref))entry.acknowledged=true;
    acknowledged+=packet.request_refs.length;
    return{schema:'selected-browser-auth-confirmation-ack.v1',...identity,controller_id:w.owner.id,session_id:session,viewer_conn_sha256:packet.viewer_conn_sha256,confirmation_ref:packet.confirmation_ref,request_sha256:selectedAuthDigest(packet),inventory_sha256:packet.inventory_sha256,ledger_sha256:'7'.repeat(64),auth_effects_acknowledged:acknowledged,effects_sent:sent,confirmed:true,replay_allowed:false,attestation:'verified-auth-fixture'};
  };
  w.runner.release=async()=>{mode='paused';w.calls.push(['release']);};w.runner.resume=async()=>{mode='agent';w.calls.push(['resume']);};
  w.consent();const started=await w.start(),controlled=await w.service.takeover(w.owner,w.p.id,started.run.id,started.run.revision);sent=businessWrites;
  w.runner.approveRequest=async(identity,grant)=>{
    w.calls.push(['request-grant',grant]);const request=held.find(item=>item.request_ref===grant.request_ref);held=held.filter(item=>item.request_ref!==grant.request_ref);sent++;
    entries.push({request_ref:request.request_ref,binding_sha256:request.binding_sha256,request_sha256:request.request_sha256,url_sha256:request.url_sha256,body_sha256:request.body_sha256,body_bytes:request.body_bytes,origin:request.origin,role:'authentication',method:request.method,approval_ref:grant.approval_ref,purpose_sha256:grant.purpose_sha256,path_preview:`/sign-in/${sent}`,human_context:grant.human_context,ledger_send_ref:createHash('sha256').update(`send${sent}`).digest('hex'),ledger_response_ref:createHash('sha256').update(`response${sent}`).digest('hex'),transport_complete:true});
  };
  for(let i=0;i<requests;i++){
    held=[{kind:'network_effect',request_ref:`auth-${i}`,binding_sha256:createHash('sha256').update(`binding${i}`).digest('hex'),url_sha256:createHash('sha256').update(`https://example.com/sign-in/${i}`).digest('hex'),origin:'https://example.com',role:'authentication',method:'POST',body_sha256:'c'.repeat(64),body_bytes:53,purpose:'Manual sign-in or MFA',request_sha256:createHash('sha256').update(`request${i}`).digest('hex'),no_contact:true}];
    const pending=await w.service.refresh(w.owner,w.p.id,started.run.id),a=pending.pending_approvals[0];
    await w.service.decision(w.owner,w.p.id,started.run.id,a.id,pending.run.revision,{decision:'approve',action_sha256:a.action_sha256});
  }
  return{runId:started.run.id,entries,inventory:()=>w.service.authenticationReadback(w.owner,w.p.id,started.run.id),confirm:async(selectedEntries=entries.filter(entry=>!entry.acknowledged))=>{const preview=await w.service.authenticationReadback(w.owner,w.p.id,started.run.id);return w.service.confirmAuthentication(w.owner,w.p.id,started.run.id,preview.revision,{inventory_sha256:preview.inventory.inventory_sha256,request_refs:selectedEntries.map(({request_ref,binding_sha256})=>({request_ref,binding_sha256})),reviewed_statement:SELECTED_BROWSER_AUTH_STATEMENT});}};
}
const authOptions={configurationChanges:c=>c.destinations.allowed_origins[0].roles.push('authentication')};
function privateWorld(options={}){
  let privateService;
  const artifacts=Object.fromEntries(['validateInputs','modelInputs','stageInputDraft','approveInputDraft','cancelAttempt','stageObservation','observationInputs','observationStatus'].map(method=>[method,(...args)=>privateService[method](...args)]));
  const w=world({...options,artifacts}),root=mkdtempSync(path.join(os.tmpdir(),'pp-selected-memory-integration-'));chmodSync(root,0o700);
  operationalBrowserArtifactsMigration1119(w.f.adapter);
  const tx=fn=>{w.f.db.exec('BEGIN IMMEDIATE');try{const result=fn();w.f.db.exec('COMMIT');return result;}catch(e){w.f.db.exec('ROLLBACK');throw e;}};
  const store=createBrowserArtifactsStore({one:(sql,...args)=>w.f.db.prepare(sql).get(...args),all:(sql,...args)=>w.f.db.prepare(sql).all(...args),run:(sql,...args)=>w.f.db.prepare(sql).run(...args),tx,
    access:(actor,project,action='read')=>{const p=w.f.store.get(actor,project);assertOperation(p.own_role,action,!!p.archived_at);return{p,role:p.own_role};},
    authorizeAttempt:w.service.authorizeAttempt,verifyInputApproval:w.service.verifyInputDraftApproval,verifyRetainedInputApproval:w.service.verifyRetainedInputDraftApproval,verifyObservationOrigin:w.service.verifyObservationOrigin,now:w.now,uuid:randomUUID,
    event:(actor,project,action,subject,metadata)=>w.f.db.prepare('INSERT INTO ops_project_events(project_id,actor_id,action,subject_id,created_at,request_id,metadata_json) VALUES(?,?,?,?,?,?,?)').run(project,actor.id,action,subject,w.now(),randomUUID(),JSON.stringify(metadata))});
  const files=createBrowserArtifactFiles(root);privateService=createBrowserArtifactsService({store,files});
  return {...w,privateService,privateStore:store,files,close:()=>{files.close();rmSync(root,{recursive:true,force:true});w.f.close();}};
}

test('selected runtime stays unavailable without versioned installed proofs; pasted config never grants execution',withWorld(async w=>{
  const absent=createSelectedBrowserService({db:w.f.adapter});assert.equal((await absent.readiness(w.owner,w.p.id,w.config.id)).can_start,false);
  w.consent();w.runner.readiness=async()=>({available:true});assert.equal((await w.service.readiness(w.owner,w.p.id,w.config.id)).can_start,false);
  await rejected(409,w.start,'INSTALLED_SELECTED_BROWSER_PROOF_REQUIRED');assert.equal(w.calls.length,0);
}));
test('owner consent and current-account project roles have no admin bypass or forged proof flags',withWorld(async w=>{
  check(403,()=>w.service.consent(w.viewer,w.p.id,w.config.id,{configuration_revision:1,configuration_sha256:w.config.configuration_sha256,allow:true,reviewed_statement:SELECTED_BROWSER_CONSENT}));
  check(404,()=>w.service.get(w.outsider,w.p.id,randomUUID()));
  const locked=createSelectedBrowserService({db:w.f.adapter,runner:w.runner,model:w.model});
  await rejected(403,()=>locked.start({...w.owner,elevated:true,controlVerified:true},w.p.id,w.config.id,{project_revision:w.f.store.get(w.owner,w.p.id).revision,configuration_revision:1,configuration_sha256:w.config.configuration_sha256,idempotency_key:randomUUID()}),'AGENT_CONTROL_VERIFICATION_REQUIRED');
  w.f.db.prepare("UPDATE users SET role='disabled' WHERE id=?").run(w.owner.id);check(403,()=>w.service.get(w.owner,w.p.id,randomUUID()));
}));
test('start pins exact config/guide, omits unset project caps, remains separate from synthetic records and is idempotent',withWorld(async w=>{
  w.consent();assert.equal((await w.service.readiness(w.owner,w.p.id,w.config.id)).can_start,true);
  const input={project_revision:w.f.store.get(w.owner,w.p.id).revision,configuration_revision:1,configuration_sha256:w.config.configuration_sha256,idempotency_key:randomUUID()};
  const started=await w.service.start(w.owner,w.p.id,w.config.id,input);assert.equal(started.run.state,'running');assert.equal((await w.service.start(w.owner,w.p.id,w.config.id,input)).run.id,started.run.id);assert.equal(w.calls.filter(c=>c[0]==='launch').length,1);
  const launch=w.calls[0][1];assert.equal(launch.project_id,w.p.id);assert.equal(launch.configuration_revision,1);assert.equal(launch.workspace_id,started.run.attempt_id);
  assert.equal(w.f.db.prepare('SELECT COUNT(*) AS n FROM ops_agent_runs').get().n,0);
  assert.throws(()=>w.f.db.prepare("UPDATE ops_selected_browser_runs SET configuration_sha256=? WHERE id=?").run('a'.repeat(64),started.run.id),/immutable/);
}));
test('configured owner cap narrows finite agent budget; missing cap never invents a default',withWorld(async w=>{
  w.consent();w.f.store.agentLimits(w.owner,w.p.id,w.f.store.get(w.owner,w.p.id).revision,{limits:{max_actions:1}});assert.equal((await w.service.readiness(w.owner,w.p.id,w.config.id)).checks.find(c=>c.kind==='project_limits').state,'blocked');
}));
test('model envelope matches real bridge schema and durable reservation settles actual usage before action',withWorld(async w=>{
  w.consent();const started=await w.start(),done=await w.service.step(w.owner,w.p.id,started.run.id,started.run.revision);assert.equal(done.run.usage.model_calls,1);assert.equal(done.run.usage.tokens,30);assert.equal(done.run.usage.actions,1);assert.equal(done.run.usage.requests,1);
  const model=w.calls.find(c=>c[0]==='model')[1];assert.equal(model.limits.max_tokens,w.config.configuration.budgets.max_tokens);assert.equal(model.guide_version_id,w.guide.id);assert(model.input.source_inputs[0].text.includes('Selected page'));
  assert.equal(w.f.db.prepare('SELECT request_sha256 FROM ops_selected_browser_model_reservations').get().request_sha256,browserModelRequestDigest(model));
  const packet=w.calls.find(c=>c[0]==='execute')[1];assert.equal(packet.approval_ref,null);assert.equal(packet.snapshot_ref.id,w.snapshot.id);
}));
test('consequential candidates require exact single-use approval before any effect',withWorld(async w=>{
  w.candidate.operation={kind:'submit',form_ref:'form-1',field_set_sha256:'d'.repeat(64)};w.candidate.effect='external_change';w.consent();const run=await w.start(),pending=await w.service.step(w.owner,w.p.id,run.run.id,run.run.revision);assert.equal(pending.run.state,'awaiting_approval');assert.equal(w.calls.filter(c=>c[0]==='execute').length,0);const a=pending.pending_approvals[0];
  await rejected(409,()=>w.service.decision(w.owner,w.p.id,run.run.id,a.id,pending.run.revision,{decision:'approve',action_sha256:'c'.repeat(64)}),'APPROVAL_STALE');
  const approved=await w.service.decision(w.owner,w.p.id,run.run.id,a.id,pending.run.revision,{decision:'approve',action_sha256:a.action_sha256});assert.equal(w.calls.filter(c=>c[0]==='execute').length,1);assert.equal(w.calls.find(c=>c[0]==='execute')[1].approval_ref.id,a.id);
  await rejected(409,()=>w.service.decision(w.owner,w.p.id,run.run.id,a.id,approved.run.revision,{decision:'approve',action_sha256:a.action_sha256}),'APPROVAL_STALE');
}));
test('deny and pause remain durable and cannot resume an expired approval',withWorld(async w=>{
  w.candidate.effect='unknown';w.consent();const run=await w.start(),pending=await w.service.step(w.owner,w.p.id,run.run.id,run.run.revision),a=pending.pending_approvals[0];const denied=await w.service.decision(w.owner,w.p.id,run.run.id,a.id,pending.run.revision,{decision:'deny',action_sha256:a.action_sha256});assert.equal(denied.run.state,'paused');assert.equal(w.calls.filter(c=>c[0]==='execute').length,0);await rejected(409,()=>w.service.step(w.owner,w.p.id,run.run.id,denied.run.revision),'ATTEMPT_NOT_RUNNING');
  const resumed=await w.service.resume(w.owner,w.p.id,run.run.id,denied.run.revision);assert.equal(resumed.run.state,'running');
}));
test('off-list approval is exact attempt purpose and single-use; base allowlist and blocked action are never replayed',withWorld(async w=>{
  w.runner.execute=async packet=>{w.calls.push(['execute',packet]);return{kind:'off_list',escalation:{origin:'https://login.example.com',role:'navigation',purpose:'Selected-site authentication redirect',request_ref:'pending-1',method:'GET',url_sha256:'a'.repeat(64),request_sha256:'c'.repeat(64),no_contact:true}};};w.runner.pollAction=async()=>({kind:'done',facts:[{code:'BROWSER_OPERATION_BLOCKED_BEFORE_EFFECT',source_ref:null}],usage:{requests:1,response_bytes:0,artifact_bytes:0},usage_mode:'cumulative'});w.consent();const r=await w.start(),pending=await w.service.step(w.owner,w.p.id,r.run.id,r.run.revision),a=pending.pending_approvals[0];assert.equal(a.kind,'off_list_destination');
  await w.service.decision(w.owner,w.p.id,r.run.id,a.id,pending.run.revision,{decision:'approve',action_sha256:a.action_sha256});const grant=w.calls.find(c=>c[0]==='grant')[1];assert.equal(grant.origin,'https://login.example.com');assert.equal(grant.persist_to_allowlist,false);assert.equal(grant.wildcards,false);assert.equal(grant.single_use,true);assert.equal(w.calls.filter(c=>c[0]==='execute').length,1);assert.equal(w.f.store.browserConfiguration(w.owner,w.p.id,w.config.id).configuration.configuration.destinations.allowed_origins.length,2);
}));
test('late action after cancellation is suppressed; uncertain effect remains gated and no replay occurs',withWorld(async w=>{
  let resolve;w.runner.execute=packet=>{w.calls.push(['execute',packet]);return new Promise(r=>{resolve=r;});};w.consent();const r=await w.start(),working=w.service.step(w.owner,w.p.id,r.run.id,r.run.revision);await waitFor(()=>resolve);const current=w.service.get(w.owner,w.p.id,r.run.id);const stopped=await w.service.cancel(w.owner,w.p.id,r.run.id,current.run.revision);assert.equal(stopped.run.fence,2);assert.equal(stopped.run.state,'uncertain');resolve({kind:'done',facts:[],usage:{requests:1,response_bytes:1,artifact_bytes:0}});await working;const step=w.f.db.prepare('SELECT state,outcome_json FROM ops_selected_browser_steps').get();assert.equal(step.state,'suppressed');assert.equal(step.outcome_json,null);assert.equal(w.calls.filter(c=>c[0]==='execute').length,1);await rejected(409,w.start,'UNRESOLVED_EFFECT');
}));
test('unknown external outcome is never completed or automatically retried',withWorld(async w=>{
  w.runner.execute=async()=>({kind:'uncertain',code:'EXTERNAL_EFFECT_UNVERIFIED'});w.consent();const r=await w.start(),out=await w.service.step(w.owner,w.p.id,r.run.id,r.run.revision);assert.equal(out.run.state,'uncertain');assert.equal(out.receipts.length,1);assert.equal(out.run.uncertain,true);
}));
test('manual takeover is exclusive, private, capture-disabled, and release leaves durable pause',withWorld(async w=>{
  w.consent();const r=await w.start(),held=await w.service.takeover(w.owner,w.p.id,r.run.id,r.run.revision);assert.equal(held.run.manual_auth,true);assert.equal(held.controls.can_live,true);
  check(409,()=>w.service.authorizeAttempt(w.owner,{project_id:w.p.id,run_id:r.run.id,attempt_id:r.run.attempt_id,fence:1},'artifact_model'),'MANUAL_AUTH_CAPTURE_DISABLED');await rejected(403,()=>w.service.live(w.viewer,w.p.id,r.run.id),'MANUAL_AUTH_PRIVATE');
  await rejected(409,()=>w.service.takeover(w.owner,w.p.id,r.run.id,held.run.revision),'TAKEOVER_UNAVAILABLE');const released=await w.service.release(w.owner,w.p.id,r.run.id,held.run.revision);assert.equal(released.run.state,'paused');assert.equal(released.run.manual_auth,false);
}));
test('owner consent withdrawal, current guide change, access revocation and deadline sweep fence existing run',withWorld(async w=>{
  w.consent();const r=await w.start();w.f.db.prepare('UPDATE ops_selected_browser_consents SET allowed=0').run();await w.service.sweep();assert.equal(w.service.get(w.owner,w.p.id,r.run.id).run.state,'failed');assert.equal(w.calls.filter(c=>c[0]==='stop').length,1);
}));
test('cleanup receipt must bind exact fence and policy and pass independent signature verification',withWorld(async w=>{
  w.consent();const r=await w.start(),out=await w.service.cancel(w.owner,w.p.id,r.run.id,r.run.revision);assert.equal(out.run.state,'uncertain');assert.equal(out.receipts.length,0);assert(out.uncertainties.some(u=>u.kind==='CLEANUP_UNVERIFIED'));
},{receipt:false}));
test('process recovery fences every active attempt and never resumes action/model dispatch',withWorld(async w=>{
  w.consent();const r=await w.start();assert.equal((await w.service.recover()).recovered,1);const out=w.service.get(w.owner,w.p.id,r.run.id);assert.equal(out.run.state,'failed');assert.equal(out.run.fence,2);assert.equal(w.calls.filter(c=>['model','execute'].includes(c[0])).length,0);
}));
test('model budget exhaustion stops before another model or action call',withWorld(async w=>{
  w.consent();const r=await w.start(),first=await w.service.step(w.owner,w.p.id,r.run.id,r.run.revision);const out=await w.service.step(w.owner,w.p.id,r.run.id,first.run.revision);assert.equal(out.run.state,'failed');assert.equal(w.calls.filter(c=>c[0]==='model').length,1);
},{configurationChanges:c=>{c.budgets.max_model_calls=1;}}));
test('cited report only accepts observed source IDs and completes after verified cleanup',withWorld(async w=>{
  w.model.decide=async()=>({decision:{kind:'done',reason:'Result ready'},usage:{tokens:10,usd:0.001}});w.consent();const r=await w.start(),out=await w.service.step(w.owner,w.p.id,r.run.id,r.run.revision);assert.equal(out.run.state,'completed');assert.deepEqual(out.report.citations,out.sources.map(source=>source.id));assert.equal(out.receipts.length,1);
}));
test('HTTP effect approval binds immutable payload after DOM approval and continues original action without replay',withWorld(async w=>{
  const request={kind:'network_effect',request_ref:'request-1',binding_sha256:'a'.repeat(64),url_sha256:'e'.repeat(64),origin:'https://example.com',role:'resource',method:'POST',body_sha256:'c'.repeat(64),body_bytes:53,purpose:'Save selected form',request_sha256:'d'.repeat(64),no_contact:true};
  w.candidate.effect='external_change';w.runner.execute=async packet=>{w.calls.push(['execute',packet]);return{kind:'request_approval',request:{...request,current_action:{ordinal:packet.ordinal,snapshot_ref:packet.snapshot_ref,candidate_ref:packet.candidate_ref}}};};
  w.runner.approveRequest=async(identity,grant)=>w.calls.push(['request-grant',grant]);w.runner.pollAction=async()=>({kind:'done',facts:[{code:'LOCAL_BROWSER_ACTION_PERFORMED',source_ref:w.snapshot}],usage:{requests:1,response_bytes:3,artifact_bytes:0}});
  w.consent();const r=await w.start(),dom=await w.service.step(w.owner,w.p.id,r.run.id,r.run.revision),a=dom.pending_approvals[0],net=await w.service.decision(w.owner,w.p.id,r.run.id,a.id,dom.run.revision,{decision:'approve',action_sha256:a.action_sha256});
  assert.equal(net.pending_approvals[0].kind,'network_effect');assert.equal(w.calls.filter(c=>c[0]==='request-grant').length,0);
  const n=net.pending_approvals[0];assert.equal(n.body_sha256,request.body_sha256);const out=await w.service.decision(w.owner,w.p.id,r.run.id,n.id,net.run.revision,{decision:'approve',action_sha256:n.action_sha256});assert.equal(out.run.state,'running');assert.equal(out.pending_approvals.length,0);assert.equal(w.calls.filter(c=>c[0]==='execute').length,1);assert.equal(w.calls.filter(c=>c[0]==='request-grant').length,1);assert.equal(w.f.db.prepare('SELECT state FROM ops_selected_browser_steps').get().state,'done');
}));
test('manual-auth HTTP approval preserves the sole controller and blocks model until human release',withWorld(async w=>{
  w.consent();const r=await w.start(),held=await w.service.takeover(w.owner,w.p.id,r.run.id,r.run.revision);
  const request={kind:'network_effect',request_ref:'request-auth',binding_sha256:'a'.repeat(64),url_sha256:'e'.repeat(64),origin:'https://example.com',role:'resource',method:'POST',body_sha256:'c'.repeat(64),body_bytes:53,purpose:'Manual sign in',request_sha256:'d'.repeat(64),no_contact:true};
  let granted=false;w.runner.pending=async()=>pendingPacket({pending:granted?[]:[request],mode:'human'});w.runner.approveRequest=async()=>{granted=true;};const pending=await w.service.refresh(w.owner,w.p.id,r.run.id);assert.equal(pending.run.state,'human_control');assert.equal(pending.run.manual_auth,true);const a=pending.pending_approvals[0];const out=await w.service.decision(w.owner,w.p.id,r.run.id,a.id,pending.run.revision,{decision:'approve',action_sha256:a.action_sha256});assert.equal(out.run.state,'human_control');assert.equal(out.run.controller_user_id,w.owner.id);assert.equal(out.run.manual_auth,true);assert.equal(w.calls.filter(c=>c[0]==='model').length,0);
}));
test('pause and takeover acknowledgments cannot race resume or release before supervisor settles',withWorld(async w=>{
  w.consent();const r=await w.start();let ack;w.runner.pause=()=>new Promise(resolve=>{ack=resolve;});const pausing=w.service.pause(w.owner,w.p.id,r.run.id,r.run.revision);assert(ack);let current=w.service.get(w.owner,w.p.id,r.run.id);assert.equal(current.run.state,'preparing');await rejected(409,()=>w.service.resume(w.owner,w.p.id,r.run.id,current.run.revision),'RUN_NOT_PAUSED');ack();const paused=await pausing;assert.equal(paused.run.state,'paused');
  let controlAck;w.runner.takeover=()=>new Promise(resolve=>{controlAck=resolve;});const taking=w.service.takeover(w.owner,w.p.id,r.run.id,paused.run.revision);assert(controlAck);current=w.service.get(w.owner,w.p.id,r.run.id);assert.equal(current.run.manual_auth,true);await rejected(403,()=>w.service.release(w.owner,w.p.id,r.run.id,current.run.revision),'TAKEOVER_NOT_YOURS');controlAck();assert.equal((await taking).run.state,'human_control');
}));
test('current starter session revocation fences a run even when the account is still eligible',withWorld(async w=>{
  const session=randomUUID();w.f.db.prepare('INSERT INTO sessions(id,user_id,expires_at) VALUES(?,?,?)').run(session,w.owner.id,new Date(Date.now()+3600000).toISOString());w.owner.jti=session;w.consent();const r=await w.start();w.f.db.prepare('UPDATE sessions SET revoked_at=? WHERE id=?').run(new Date().toISOString(),session);await w.service.sweep();assert.equal(w.service.get({...w.owner,jti:null},w.p.id,r.run.id).run.state,'failed');assert.equal(w.calls.filter(c=>c[0]==='execute').length,0);
}));
test('approval expiration is refused before dispatch and deadline cleanup is durable',withWorld(async w=>{
  w.candidate.effect='unknown';w.consent();const r=await w.start(),pending=await w.service.step(w.owner,w.p.id,r.run.id,r.run.revision),a=pending.pending_approvals[0];w.advance(901000);await rejected(409,()=>w.service.decision(w.owner,w.p.id,r.run.id,a.id,pending.run.revision,{decision:'approve',action_sha256:a.action_sha256}),'SELECTED_BROWSER_DEADLINE');await w.service.sweep();assert.equal(w.service.get(w.owner,w.p.id,r.run.id).run.state,'failed');assert.equal(w.calls.filter(c=>c[0]==='execute').length,0);
}));
test('receipt with a different policy fails cleanup despite signature callback accepting it',withWorld(async w=>{
  const original=w.runner.stop;w.runner.stop=async packet=>({...await original(packet),policy_sha256:'a'.repeat(64)});w.consent();const r=await w.start(),out=await w.service.cancel(w.owner,w.p.id,r.run.id,r.run.revision);assert.equal(out.run.state,'uncertain');assert.equal(out.receipts.length,0);
}));
test('invalid report citations never produce a completed result',withWorld(async w=>{
  w.model.decide=async()=>({decision:{kind:'done',reason:'Result ready'},usage:{tokens:10,usd:0.001}});w.model.report=async()=>({report:{summary:'Unsupported report',citations:[randomUUID()],limitations:[]},usage:{tokens:20,usd:0.002}});w.consent();const r=await w.start(),out=await w.service.step(w.owner,w.p.id,r.run.id,r.run.revision);assert.equal(out.run.state,'failed');assert.equal(out.report,null);assert.equal(out.run.result_code,'REPORT_CITATION_INVALID');
}));
test('model cancellation keeps worst-case reservation and suppresses late candidate response',withWorld(async w=>{
  let answer;w.model.decide=()=>new Promise(resolve=>{answer=resolve;});w.consent();const r=await w.start(),working=w.service.step(w.owner,w.p.id,r.run.id,r.run.revision);await waitFor(()=>answer);const current=w.service.get(w.owner,w.p.id,r.run.id);await w.service.cancel(w.owner,w.p.id,r.run.id,current.run.revision);answer({decision:{kind:'candidate',candidate_id:w.candidate.candidate_ref.id},usage:{tokens:1,usd:0.001}});await working;const out=w.service.get(w.owner,w.p.id,r.run.id);assert.equal(out.run.usage.tokens,100);assert.equal(out.run.usage.usd,0.01);assert.equal(w.calls.filter(c=>c[0]==='execute').length,0);assert.equal(w.f.db.prepare('SELECT state FROM ops_selected_browser_model_reservations').get().state,'suppressed');
}));
test('bounded human inputs reserve actions and never persist secret text',withWorld(async w=>{
  w.consent();const r=await w.start(),held=await w.service.takeover(w.owner,w.p.id,r.run.id,r.run.revision);const seen=[];w.runner.control=async(identity,input)=>seen.push(input);const secret='fixture-secret-never-persisted';const out=await w.service.controlInput(w.owner,w.p.id,r.run.id,held.run.revision,{kind:'text',text:secret});assert.equal(out.run.usage.actions,1);assert.equal(seen[0].input.text,secret);assert(!JSON.stringify(w.f.db.prepare('SELECT * FROM ops_selected_browser_events').all()).includes(secret));await rejected(400,()=>w.service.controlInput(w.owner,w.p.id,r.run.id,out.run.revision,{kind:'key',key:'F12'}),'SELECTED_BROWSER_INVALID_REQUEST');
}));
test('completed retained artifacts use immutable launch generation while execution fence advances',withWorld(async w=>{
  w.model.decide=async()=>({decision:{kind:'done',reason:'Result ready'},usage:{tokens:10,usd:0.001}});w.consent();const r=await w.start(),out=await w.service.step(w.owner,w.p.id,r.run.id,r.run.revision);assert.equal(out.run.fence,2);assert.equal(out.run.artifact_fence,1);assert.equal(w.service.authorizeAttempt(w.viewer,{project_id:w.p.id,run_id:r.run.id,attempt_id:r.run.attempt_id,fence:1},'artifact_read').run.state,'completed');check(409,()=>w.service.authorizeAttempt(w.owner,{project_id:w.p.id,run_id:r.run.id,attempt_id:r.run.attempt_id,fence:1},'artifact_capture'),'STALE_ATTEMPT_FENCE');
}));
test('uncertain action requires deliberate reconciliation before a fresh start, never replay',withWorld(async w=>{
  w.runner.execute=async packet=>{w.calls.push(['execute',packet]);return {kind:'uncertain',code:'EXTERNAL_EFFECT_UNVERIFIED'};};w.consent();const r=await w.start(),out=await w.service.step(w.owner,w.p.id,r.run.id,r.run.revision);const unresolved=out.uncertainties.filter(u=>u.state==='unresolved');assert(unresolved.length);let current=out;for(const u of unresolved)current=w.service.reconcile(w.owner,w.p.id,r.run.id,u.id,current.run.revision,{decision:'abandon_without_replay'});assert.equal(current.run.uncertain,false);assert.equal(current.run.state,'uncertain');assert.equal((await w.service.readiness(w.owner,w.p.id,w.config.id)).can_start,true);assert.equal(w.calls.filter(c=>c[0]==='execute').length,1);
}));
test('queued browser primitive is reserved once and continuation settles without a second execute',withWorld(async w=>{
  let completed=false;w.runner.execute=async packet=>{w.calls.push(['execute',packet]);return{kind:'pending'};};w.runner.pollAction=async()=>completed?{kind:'done',facts:[{code:'LOCAL_BROWSER_ACTION_PERFORMED',source_ref:w.snapshot}],usage:{requests:0,response_bytes:0,artifact_bytes:0}}:{kind:'pending'};
  w.consent();const r=await w.start(),pending=await w.service.step(w.owner,w.p.id,r.run.id,r.run.revision);assert.equal(pending.run.state,'running');assert.equal(w.f.db.prepare('SELECT state FROM ops_selected_browser_steps').get().state,'reserved');await w.service.pump(r.run.id,{maxSteps:5});assert.equal(w.calls.filter(c=>c[0]==='execute').length,1);completed=true;await w.service.refresh(w.owner,w.p.id,r.run.id);assert.equal(w.f.db.prepare('SELECT state FROM ops_selected_browser_steps').get().state,'done');assert.equal(w.calls.filter(c=>c[0]==='execute').length,1);
}));
test('composed field text stays quarantined until exact human approval, then mints a pinned separately approved action',async()=>{
  let privateService;
  const artifacts=Object.fromEntries(['validateInputs','modelInputs','stageInputDraft','approveInputDraft','cancelAttempt','stageObservation','observationInputs','observationStatus'].map(method=>[method,(...args)=>privateService[method](...args)]));
  const w=world({artifacts}),root=mkdtempSync(path.join(os.tmpdir(),'pp-selected-input-integration-'));chmodSync(root,0o700);let files;
  try{
    operationalBrowserArtifactsMigration1119(w.f.adapter);
    const tx=fn=>{w.f.db.exec('BEGIN IMMEDIATE');try{const result=fn();w.f.db.exec('COMMIT');return result;}catch(e){w.f.db.exec('ROLLBACK');throw e;}};
    const store=createBrowserArtifactsStore({one:(sql,...args)=>w.f.db.prepare(sql).get(...args),all:(sql,...args)=>w.f.db.prepare(sql).all(...args),run:(sql,...args)=>w.f.db.prepare(sql).run(...args),tx,
      access:(actor,project,action='read')=>{const p=w.f.store.get(actor,project);assertOperation(p.own_role,action,!!p.archived_at);return{p,role:p.own_role};},
      authorizeAttempt:w.service.authorizeAttempt,verifyInputApproval:w.service.verifyInputDraftApproval,verifyObservationOrigin:w.service.verifyObservationOrigin,now:()=>new Date().toISOString(),uuid:randomUUID,
      event:(actor,project,action,subject,metadata)=>w.f.db.prepare('INSERT INTO ops_project_events(project_id,actor_id,action,subject_id,created_at,request_id,metadata_json) VALUES(?,?,?,?,?,?,?)').run(project,actor.id,action,subject,new Date().toISOString(),randomUUID(),JSON.stringify(metadata))});
    files=createBrowserArtifactFiles(root);privateService=createBrowserArtifactsService({store,files});
    const target={target_ref:ref(),element_ref:'field-1',kind:'type',label:'Support request'},text='Please send the requested account report to my verified address.';
    w.runner.observe=async()=>({snapshot_ref:w.snapshot,observation:'Support form',candidates:[],input_targets:[target],page:{origin:'https://example.com',url_sha256:'a'.repeat(64)}});
    w.model.decide=async request=>{validateBrowserModelRequest(request);return{decision:{kind:'candidate',candidate_id:target.target_ref.id},usage:{tokens:20,usd:0.002}};};
    w.model.draftInput=async request=>{validateBrowserModelRequest(request);assert.equal(request.input.candidates.length,1);return{draft:{candidate_id:target.target_ref.id,text,purpose:'Fill the support request field'},usage:{tokens:30,usd:0.003}};};
    w.runner.offerInput=async(identity,packet,context)=>{w.calls.push(['offer-input',packet]);const scope={project_id:w.p.id,run_id:identity.run_id,attempt_id:identity.attempt_id,fence:identity.fence};const resolved=privateService.resolveInputDraft(context.actor,scope,context.manifest);assert.equal(resolved.bytes.toString(),text);return{candidate_ref:ref(),operation:{kind:'type',element_ref:target.element_ref,input_ref:packet.input_ref},effect:'external_change',label:'Support request'};};
    w.consent();const r=await w.start(),drafted=await w.service.step(w.owner,w.p.id,r.run.id,r.run.revision),approval=drafted.pending_approvals[0];assert.equal(approval.kind,'input_draft');assert.equal(w.calls.filter(c=>c[0]==='offer-input').length,0);assert.equal(w.calls.filter(c=>c[0]==='execute').length,0);
    const scope={project_id:w.p.id,run_id:r.run.id,attempt_id:r.run.attempt_id,fence:1};check(403,()=>privateService.resolveInputDraft(w.owner,scope,{artifact_ref:approval.artifact_ref,target_ref:target.target_ref,snapshot_ref:w.snapshot,purpose:approval.purpose,approval_ref:{id:approval.id,sha256:approval.action_sha256}}));
    assert(!JSON.stringify(w.f.db.prepare('SELECT * FROM ops_selected_browser_approvals').all()).includes(text));assert(!JSON.stringify(w.f.db.prepare('SELECT * FROM ops_browser_input_drafts').all()).includes(text));
    const action=await w.service.decision(w.owner,w.p.id,r.run.id,approval.id,drafted.run.revision,{decision:'approve',action_sha256:approval.action_sha256});assert.equal(w.calls.filter(c=>c[0]==='offer-input').length,1);assert.equal(w.calls.filter(c=>c[0]==='execute').length,0);assert.equal(action.pending_approvals[0].kind,'consequential_action');
    const a=action.pending_approvals[0];await w.service.decision(w.owner,w.p.id,r.run.id,a.id,action.run.revision,{decision:'approve',action_sha256:a.action_sha256});assert.equal(w.calls.filter(c=>c[0]==='execute').length,1);
  }finally{files?.close();rmSync(root,{recursive:true,force:true});w.f.close();}
});

test('private multi-site memory preserves pinned provenance and actually disclosed citations; lost evidence withholds retained report',async()=>{
  const w=privateWorld({configurationChanges:c=>{c.destinations.allowed_origins.push({id:'second-site',origin:'https://second.example.com',roles:['navigation','resource'],session_headers:'this_origin_session'});}});
  try{
    const first=ref(),second=ref(),privateFirst='First selected site unique evidence.',privateSecond='Second selected site unique evidence.';let page=1;
    w.runner.observe=async()=>({snapshot_ref:page===1?first:second,observation:page===1?privateFirst:privateSecond,candidates:[w.candidate],page:{origin:page===1?'https://example.com':'https://second.example.com',url_sha256:page===1?'a'.repeat(64):'c'.repeat(64)}});
    w.model.decide=async request=>{validateBrowserModelRequest(request);w.calls.push(['model',request]);return{decision:page===1?{kind:'candidate',candidate_id:w.candidate.candidate_ref.id}:{kind:'done',reason:'Both pages read'},usage:{tokens:20,usd:0.002}};};
    w.model.report=async request=>{validateBrowserModelRequest(request);w.calls.push(['report',request]);assert.equal(request.input.source_inputs.length,2);assert(request.input.source_inputs.some(source=>source.text===privateFirst));assert(request.input.source_inputs.some(source=>source.text===privateSecond));return{report:{summary:'Both selected sites support the result.',citations:request.input.source_inputs.map(source=>source.ref.id),limitations:[]},usage:{tokens:20,usd:0.002}};};
    w.consent();const run=await w.start(),one=await w.service.step(w.owner,w.p.id,run.run.id,run.run.revision);page=2;w.advance(1);const completed=await w.service.step(w.owner,w.p.id,run.run.id,one.run.revision);
    assert.equal(completed.run.state,'completed');assert.equal(completed.report_visibility,'available');assert.equal(completed.sources.length,2);assert.equal(completed.report.citations.length,2);
    for(const source of completed.sources){assert.equal(source.worker_contract,'selected-browser.v1');assert.equal(source.chunker_version,'browser-text.v1');assert.equal(source.configuration_sha256,w.config.configuration_sha256);assert.equal(source.guide_sha256,w.guide.content_hash);assert(source.disclosed_call_ids.length);assert.equal(source.content_sha256,source.artifact_ref.sha256);assert(source.captured_at);}
    assert(!JSON.stringify(w.f.db.prepare('SELECT * FROM ops_selected_browser_sources').all()).includes(privateFirst));assert(!JSON.stringify(w.f.db.prepare('SELECT * FROM ops_project_events').all()).includes(privateSecond));
    assert.throws(()=>w.f.db.prepare('UPDATE ops_selected_browser_sources SET content_sha256=?').run('d'.repeat(64)),/immutable/);
    const history=w.f.db.prepare('SELECT report_json FROM ops_selected_browser_runs').get().report_json;
    w.files.remove(completed.sources[0].id);const withheld=w.service.get(w.owner,w.p.id,run.run.id);assert.equal(withheld.report,null);assert.equal(withheld.report_visibility,'withheld');assert.equal(withheld.report_code,'REPORT_EVIDENCE_UNAVAILABLE');assert.equal(w.f.db.prepare('SELECT report_json FROM ops_selected_browser_runs').get().report_json,history);
    const sources=await w.service.sources(w.owner,w.p.id,run.run.id);assert.equal(sources.sources.find(source=>source.id===completed.sources[0].id).state,'unavailable');assert.equal(sources.sources.find(source=>source.id===completed.sources[1].id).state,'available');
    assert.throws(()=>w.f.db.prepare('UPDATE ops_selected_browser_runs SET report_json=NULL').run(),/immutable/);
  }finally{w.close();}
});
test('expired evidence, consent withdrawal and guide withdrawal each withhold a completed derived report',async()=>{
  for(const cause of ['expiry','consent','guide']){
    const w=privateWorld();try{
      w.model.decide=async()=>({decision:{kind:'done',reason:'Evidence ready'},usage:{tokens:20,usd:0.002}});w.consent();const run=await w.start(),completed=await w.service.step(w.owner,w.p.id,run.run.id,run.run.revision);assert.equal(completed.report_visibility,'available');
      if(cause==='expiry')w.advance(31*86400000);
      else if(cause==='consent')w.service.consent(w.owner,w.p.id,w.config.id,{configuration_revision:1,configuration_sha256:w.config.configuration_sha256,allow:false,reviewed_statement:SELECTED_BROWSER_CONSENT});
      else w.f.store.withdraw(w.owner,w.p.id,w.guide.id,w.f.store.get(w.owner,w.p.id).revision,{reason:'Withdraw this guide'});
      const read=w.service.get(w.owner,w.p.id,run.run.id);assert.equal(read.report,null,cause);assert.equal(read.report_visibility,'withheld',cause);assert(w.f.db.prepare('SELECT report_json FROM ops_selected_browser_runs').get().report_json);
    }finally{w.close();}
  }
});
test('source deletion during the provider await suppresses the candidate while settling known spend without replay',async()=>{
  const w=privateWorld();try{
    let answer;w.model.decide=()=>new Promise(resolve=>{answer=resolve;});w.consent();const run=await w.start(),pending=w.service.step(w.owner,w.p.id,run.run.id,run.run.revision);await waitFor(()=>answer);const source=w.f.db.prepare('SELECT id FROM ops_selected_browser_sources').get();w.files.remove(source.id);answer({decision:{kind:'candidate',candidate_id:w.candidate.candidate_ref.id},usage:{tokens:21,usd:0.002}});const out=await pending;
    assert.equal(out.run.state,'failed');assert.equal(out.run.result_code,'MODEL_SOURCE_UNAVAILABLE');assert.equal(out.run.usage.tokens,21);assert.equal(out.run.usage.usd,0.002);assert.equal(w.calls.filter(call=>call[0]==='execute').length,0);assert.equal(w.f.db.prepare('SELECT state FROM ops_selected_browser_model_reservations').get().state,'settled');assert.equal(out.report,null);
  }finally{w.close();}
});
test('source loss after quote refuses provider dispatch before making a durable spending reservation',withWorld(async w=>{
  w.model.quote=async()=>{w.pages.clear();return{tokens:100,usd:0.01,price_table_revision:1};};w.consent();const run=await w.start(),out=await w.service.step(w.owner,w.p.id,run.run.id,run.run.revision);assert.equal(out.run.state,'failed');assert.equal(out.run.usage.model_calls,0);assert.equal(w.calls.filter(call=>call[0]==='model').length,0);assert.equal(w.f.db.prepare('SELECT COUNT(*) AS n FROM ops_selected_browser_model_reservations').get().n,0);
}));
test('gateway cumulative counters cover manual traffic and action settlement without double charging',withWorld(async w=>{
  let requests=2;w.runner.pending=async()=>pendingPacket({cumulativeusage:{requests,response_bytes:requests*10}});w.runner.execute=async()=>{requests=3;return{kind:'done',facts:[],usage:{requests:3,response_bytes:30,artifact_bytes:0},usage_mode:'cumulative'};};
  w.consent();const run=await w.start(),out=await w.service.step(w.owner,w.p.id,run.run.id,run.run.revision);assert.equal(out.run.usage.requests,3);assert.equal(out.run.usage.response_bytes,30);const again=await w.service.refresh(w.owner,w.p.id,run.run.id);assert.equal(again.run.usage.requests,3);assert.equal(again.run.usage.response_bytes,30);
}));
test('host inflight and uncertain external requests prevent report or further model dispatch',withWorld(async w=>{
  let uncertain=0;w.runner.pending=async()=>pendingPacket({inflight:1,cumulativeusage:{requests:1,response_bytes:1},effects_sent:uncertain,effects_uncertain:uncertain});w.consent();const run=await w.start(),held=await w.service.refresh(w.owner,w.p.id,run.run.id);assert.equal(held.run.state,'running');uncertain=1;const out=await w.service.refresh(w.owner,w.p.id,run.run.id);assert.equal(out.run.state,'uncertain');assert.equal(w.calls.filter(call=>call[0]==='model').length,0);assert.equal(out.report,null);
}));
test('missing action meter cannot settle as zero-cost success',withWorld(async w=>{
  w.runner.execute=async()=>({kind:'done',facts:[]});w.consent();const run=await w.start(),out=await w.service.step(w.owner,w.p.id,run.run.id,run.run.revision);assert.equal(out.run.state,'uncertain');assert.equal(out.run.result_code,'ACTION_SETTLEMENT_UNKNOWN');assert.equal(w.f.db.prepare('SELECT state FROM ops_selected_browser_steps').get().state,'suppressed');
}));
test('takeover without a verified current live viewer refuses before state changes or approval invalidation',withWorld(async w=>{
  w.candidate.effect='external_change';w.consent();const run=await w.start(),pending=await w.service.step(w.owner,w.p.id,run.run.id,run.run.revision);w.runner.assertTakeover=()=>false;await rejected(409,()=>w.service.takeover(w.owner,w.p.id,run.run.id,pending.run.revision),'VERIFIED_LIVE_VIEWER_REQUIRED');const current=w.service.get(w.owner,w.p.id,run.run.id);assert.equal(current.run.state,'awaiting_approval');assert.equal(current.run.revision,pending.run.revision);assert.equal(current.pending_approvals.length,1);assert.equal(current.run.manual_auth,false);
}));
test('manual controller is exclusive to the verified session rather than every session of the same user',withWorld(async w=>{
  const original=randomUUID(),other=randomUUID();for(const id of [original,other])w.f.db.prepare('INSERT INTO sessions(id,user_id,expires_at) VALUES(?,?,?)').run(id,w.owner.id,new Date(Date.now()+3600000).toISOString());w.owner.jti=original;w.consent();const run=await w.start(),held=await w.service.takeover(w.owner,w.p.id,run.run.id,run.run.revision),second={...w.owner,jti:other};assert.equal(held.run.manual_auth,true);assert.equal(w.service.get(second,w.p.id,run.run.id).controls.can_live,false);assert.equal(w.service.get(second,w.p.id,run.run.id).controls.can_release,false);
  check(403,()=>w.service.assertLive(second,w.p.id,run.run.id),'MANUAL_AUTH_PRIVATE');await rejected(403,()=>w.service.release(second,w.p.id,run.run.id,held.run.revision),'TAKEOVER_NOT_YOURS');await rejected(403,()=>w.service.controlInput(second,w.p.id,run.run.id,held.run.revision,{kind:'key',key:'Tab'}),'TAKEOVER_NOT_YOURS');check(403,()=>w.service.authorizeAttempt(second,{project_id:w.p.id,run_id:run.run.id,attempt_id:run.run.attempt_id,fence:1},'clipboard_import'),'TAKEOVER_NOT_YOURS');
}));
test('historical screenshot transform grants review-only current access and cannot revive cancelled attempts',withWorld(async w=>{
  w.model.decide=async()=>({decision:{kind:'done',reason:'Result ready'},usage:{tokens:10,usd:0.001}});w.consent();const run=await w.start(),completed=await w.service.step(w.owner,w.p.id,run.run.id,run.run.revision),scope={project_id:w.p.id,run_id:run.run.id,attempt_id:run.run.attempt_id,fence:1};assert.equal(completed.run.state,'completed');const proof=w.service.authorizeAttempt(w.owner,scope,'artifact_transform');assert.equal(proof.model_consent,false);check(403,()=>w.service.authorizeAttempt(w.viewer,scope,'artifact_transform'));check(409,()=>w.service.authorizeAttempt(w.owner,scope,'artifact_model'),'STALE_ATTEMPT_FENCE');
  const next=await w.start();await w.service.cancel(w.owner,w.p.id,next.run.id,next.run.revision);check(409,()=>w.service.authorizeAttempt(w.owner,{...scope,run_id:next.run.id,attempt_id:next.run.attempt_id},'artifact_transform'),'STALE_ATTEMPT_FENCE');
}));
test('last registered controlling viewer closure fences cleanup despite session revocation; stale viewer callbacks are inert',withWorld(async w=>{
  const session=randomUUID();w.f.db.prepare('INSERT INTO sessions(id,user_id,expires_at) VALUES(?,?,?)').run(session,w.owner.id,new Date(Date.now()+3600000).toISOString());w.owner.jti=session;w.consent();const run=await w.start(),held=await w.service.takeover(w.owner,w.p.id,run.run.id,run.run.revision),identity={run_id:run.run.id,attempt_id:run.run.attempt_id,fence:held.run.fence,policy_sha256:held.run.policy_sha256},holder={controller_id:w.owner.id,session_id:session};
  assert.equal((await w.service.viewerClosed({...identity,fence:2},holder)).closed,false);assert.equal((await w.service.viewerClosed(identity,{...holder,session_id:randomUUID()})).closed,false);assert.equal(w.calls.filter(call=>call[0]==='stop').length,0);
  w.f.db.prepare('UPDATE sessions SET revoked_at=? WHERE id=?').run(new Date().toISOString(),session);const result=await w.service.viewerClosed(identity,holder);assert.equal(result.closed,true);const stopped=w.service.get({...w.owner,jti:null},w.p.id,run.run.id);assert.equal(stopped.run.state,'failed');assert.equal(stopped.run.result_code,'CONTROL_VIEWER_DISCONNECTED');assert.equal(stopped.run.fence,2);assert.equal(stopped.run.manual_auth,false);assert.equal(stopped.receipts.length,1);assert.equal((await w.service.viewerClosed(identity,holder)).closed,false);
}));
test('viewer close while takeover awaits supervisor acknowledgment prevents late human-control activation',withWorld(async w=>{
  let acknowledge;w.runner.takeover=()=>new Promise(resolve=>{acknowledge=resolve;});w.consent();const run=await w.start(),taking=w.service.takeover(w.owner,w.p.id,run.run.id,run.run.revision);assert(acknowledge);const current=w.service.get(w.owner,w.p.id,run.run.id);assert.equal(current.run.state,'preparing');await w.service.viewerClosed({run_id:run.run.id,attempt_id:run.run.attempt_id,fence:1,policy_sha256:run.run.policy_sha256},{controller_id:w.owner.id,session_id:null});acknowledge();const out=await taking;assert.equal(out.run.state,'failed');assert.equal(out.run.manual_auth,false);assert.equal(w.calls.filter(call=>call[0]==='stop').length,1);
}));
test('observed gateway budget breach records full measured usage and stops before provider dispatch',withWorld(async w=>{
  w.runner.pending=async()=>pendingPacket({cumulativeusage:{requests:2,response_bytes:25}});w.consent();const run=await w.start(),out=await w.service.step(w.owner,w.p.id,run.run.id,run.run.revision);assert.equal(out.run.state,'failed');assert.equal(out.run.result_code,'NETWORK_ARTIFACT_BUDGET_EXHAUSTED');assert.equal(out.run.usage.requests,2);assert.equal(out.run.usage.response_bytes,25);assert.equal(w.calls.filter(call=>call[0]==='model').length,0);
},{configurationChanges:c=>{c.budgets.max_requests=1;}}));
test('retained input proof during manual authentication is read-only, consumed-only and cannot revive activation or capture',async()=>{
  const w=privateWorld();try{
    const target={target_ref:ref(),element_ref:'retained-field',kind:'type',label:'Reviewed form field'};
    w.runner.observe=async()=>({snapshot_ref:w.snapshot,observation:'Selected form context',candidates:[],input_targets:[target],page:{origin:'https://example.com',url_sha256:'a'.repeat(64)}});
    w.model.decide=async()=>({decision:{kind:'candidate',candidate_id:target.target_ref.id},usage:{tokens:20,usd:0.002}});
    w.model.draftInput=async()=>({draft:{candidate_id:target.target_ref.id,text:'An explicitly reviewed field response.',purpose:'Fill the selected form field'},usage:{tokens:20,usd:0.002}});
    w.runner.offerInput=async(identity,packet)=>({candidate_ref:ref(),operation:{kind:'type',element_ref:target.element_ref,input_ref:packet.input_ref},effect:'external_change',label:target.label});
    w.consent();const run=await w.start(),draft=await w.service.step(w.owner,w.p.id,run.run.id,run.run.revision),approval=draft.pending_approvals[0],scope={project_id:w.p.id,run_id:run.run.id,attempt_id:run.run.attempt_id,fence:1},manifest={artifact_ref:approval.artifact_ref,target_ref:approval.target_ref,snapshot_ref:approval.snapshot_ref,purpose:approval.purpose,approval_ref:{id:approval.id,sha256:approval.action_sha256}};
    assert.equal(w.service.verifyRetainedInputDraftApproval(w.owner,scope,manifest),false);
    const offered=await w.service.decision(w.owner,w.p.id,run.run.id,approval.id,draft.run.revision,{decision:'approve',action_sha256:approval.action_sha256});assert.equal(w.service.verifyRetainedInputDraftApproval(w.owner,scope,manifest),true);const action=offered.pending_approvals[0];const done=await w.service.decision(w.owner,w.p.id,run.run.id,action.id,offered.run.revision,{decision:'approve',action_sha256:action.action_sha256});const held=await w.service.takeover(w.owner,w.p.id,run.run.id,done.run.revision);
    const before=w.f.db.prepare('SELECT state,revision,usage_json FROM ops_selected_browser_runs').get(),calls=w.calls.length;
    assert.equal(w.service.verifyRetainedInputDraftApproval(w.owner,scope,manifest),true);assert.equal(w.service.authorizeAttempt(w.owner,scope,'artifact_verify').model_consent,false);assert.equal(w.service.verifyInputDraftApproval(w.owner,scope,manifest),false);
    const retained=w.privateService.verifyRetainedInputDraft(w.owner,scope,manifest,{target_ref:target.target_ref,snapshot_ref:w.snapshot});assert.deepEqual(retained.input_ref,{id:manifest.artifact_ref.id,sha256:manifest.artifact_ref.sha256});assert.equal(retained.bytes,undefined);assert.equal(retained.text,undefined);
    check(403,()=>w.privateService.verifyRetainedInputDraft(w.owner,scope,{...manifest,purpose:'Another purpose'}));check(403,()=>w.privateService.verifyRetainedInputDraft(w.owner,scope,manifest,{target_ref:ref()}));
    for(const changed of [{...manifest,purpose:'Another purpose'},{...manifest,target_ref:ref()},{...manifest,snapshot_ref:ref()},{...manifest,approval_ref:ref()},{...manifest,artifact_ref:{...manifest.artifact_ref,byte_count:manifest.artifact_ref.byte_count+1}},{...manifest,selector:'#arbitrary'}])assert.equal(w.service.verifyRetainedInputDraftApproval(w.owner,scope,changed),false);
    assert.equal(w.service.verifyRetainedInputDraftApproval(w.viewer,scope,manifest),false);assert.equal(w.service.verifyRetainedInputDraftApproval(w.owner,{...scope,fence:2},manifest),false);check(409,()=>w.service.authorizeAttempt(w.owner,scope,'artifact_model'),'MANUAL_AUTH_CAPTURE_DISABLED');check(409,()=>w.service.authorizeAttempt(w.owner,scope,'artifact_capture'),'MANUAL_AUTH_CAPTURE_DISABLED');
    check(403,()=>w.privateService.resolveInputDraft(w.owner,scope,manifest));assert.deepEqual(w.f.db.prepare('SELECT state,revision,usage_json FROM ops_selected_browser_runs').get(),before);assert.equal(w.calls.length,calls);
    w.f.db.prepare('UPDATE ops_selected_browser_consents SET allowed=0').run();assert.equal(w.service.verifyRetainedInputDraftApproval(w.owner,scope,manifest),false);w.f.db.prepare('UPDATE ops_selected_browser_consents SET allowed=1').run();w.advance(901000);assert.equal(w.service.verifyRetainedInputDraftApproval(w.owner,scope,manifest),false);await w.service.cancel(w.owner,w.p.id,run.run.id,held.run.revision);assert.equal(w.service.verifyRetainedInputDraftApproval(w.owner,scope,manifest),false);
  }finally{w.close();}
});

test('actual host pending counters are required finite safe integers and never silently default',()=>{
  const actual=pendingPacket({inflight:2,effects_sent:1,cumulativeusage:{requests:3,response_bytes:41}});
  assert.equal(normalizeSelectedBrowserPending(actual).inflight_action,true);
  for(const key of ['inflight','effects_sent','effects_uncertain','auth_effects_acknowledged']){
    const missing={...actual};delete missing[key];check(502,()=>normalizeSelectedBrowserPending(missing),'NETWORK_PENDING_INVALID');
    for(const value of [-1,0.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1,'0',true])check(502,()=>normalizeSelectedBrowserPending({...actual,[key]:value}),'NETWORK_PENDING_INVALID');
  }
  check(502,()=>normalizeSelectedBrowserPending({...actual,auth_effects_acknowledged:2}),'NETWORK_PENDING_INVALID');
  check(502,()=>normalizeSelectedBrowserPending({...actual,usage:{requests:0,response_bytes:0}}),'NETWORK_PENDING_INVALID');
  check(502,()=>normalizeSelectedBrowserPending({...actual,inflight_action:false}),'NETWORK_PENDING_INVALID');
});
test('numeric inflight payload pauses before any model, report or browser action',withWorld(async w=>{
  w.runner.pending=async()=>pendingPacket({inflight:1,cumulativeusage:{requests:1,response_bytes:0}});w.consent();const run=await w.start(),out=await w.service.step(w.owner,w.p.id,run.run.id,run.run.revision);
  assert.equal(out.run.state,'paused');assert.equal(out.run.result_code,'NETWORK_ACTIVITY_PENDING');assert.equal(out.run.usage.requests,1);assert.equal(out.report,null);assert.equal(w.calls.filter(([kind])=>['model','execute'].includes(kind)).length,0);assert.equal(w.f.db.prepare('SELECT COUNT(*) AS n FROM ops_selected_browser_model_reservations').get().n,0);
}));
test('background HTTP200 write without a DOM step stays unverified and prevents model/report dispatch',withWorld(async w=>{
  w.runner.pending=async()=>pendingPacket({effects_sent:1,effects_uncertain:0,cumulativeusage:{requests:1,response_bytes:20}});w.consent();const run=await w.start(),out=await w.service.step(w.owner,w.p.id,run.run.id,run.run.revision);
  assert.equal(out.run.state,'uncertain');assert.equal(out.run.result_code,'EXTERNAL_EFFECT_UNVERIFIED');assert(out.uncertainties.some(item=>item.kind==='EXTERNAL_EFFECT_UNVERIFIED'));assert.equal(out.run.usage.requests,1);assert.equal(out.report,null);assert.equal(w.calls.filter(([kind])=>['model','execute'].includes(kind)).length,0);assert.equal(w.f.db.prepare('SELECT COUNT(*) AS n FROM ops_selected_browser_steps').get().n,0);
}));
test('new network traffic during model quote refuses dispatch before reserving spend',withWorld(async w=>{
  let inflight=0;w.runner.pending=async()=>pendingPacket({inflight});w.model.quote=async()=>{inflight=1;return{tokens:100,usd:0.01,price_table_revision:1};};w.consent();const run=await w.start(),out=await w.service.step(w.owner,w.p.id,run.run.id,run.run.revision);
  assert.equal(out.run.state,'paused');assert.equal(out.run.usage.model_calls,0);assert.equal(w.calls.filter(([kind])=>kind==='model').length,0);
}));
test('traffic appearing during provider await suppresses a late candidate and settles exact known spend',withWorld(async w=>{
  let answer,inflight=0;w.runner.pending=async()=>pendingPacket({inflight});w.model.decide=request=>{w.calls.push(['model',request]);return new Promise(resolve=>{answer=resolve;});};w.consent();const run=await w.start(),work=w.service.step(w.owner,w.p.id,run.run.id,run.run.revision);await waitFor(()=>answer);inflight=1;answer({decision:{kind:'candidate',candidate_id:w.candidate.candidate_ref.id},usage:{tokens:30,usd:0.003}});const out=await work;
  assert.equal(out.run.state,'paused');assert.equal(out.run.usage.tokens,30);assert(Math.abs(out.run.usage.usd-0.003)<1e-12);assert.equal(w.f.db.prepare('SELECT state,actual_tokens FROM ops_selected_browser_model_reservations').get().state,'settled');assert.equal(w.calls.filter(([kind])=>kind==='execute').length,0);
}));
test('fresh network refusal after a verified provider receipt never replaces known spend with worst-case cost',withWorld(async w=>{
  w.model.decide=async request=>{w.calls.push(['model',request]);w.runner.pending=async()=>{throw Object.assign(new Error('Host unavailable'),{code:'HOST_UNAVAILABLE'});};return{decision:{kind:'candidate',candidate_id:w.candidate.candidate_ref.id},usage:{tokens:30,usd:0.003}};};w.consent();const run=await w.start(),out=await w.service.step(w.owner,w.p.id,run.run.id,run.run.revision);
  assert.equal(out.run.state,'uncertain');assert.equal(out.run.usage.tokens,30);assert(Math.abs(out.run.usage.usd-0.003)<1e-12);assert.equal(w.f.db.prepare('SELECT state FROM ops_selected_browser_model_reservations').get().state,'settled');assert.equal(w.calls.filter(([kind])=>kind==='execute').length,0);assert(!out.uncertainties.some(item=>item.kind==='MODEL_OUTCOME_UNKNOWN'||item.kind==='MODEL_IN_FLIGHT'));
}));
test('a write arriving during provider await keeps exact spend and requires external-effect reconciliation',withWorld(async w=>{
  let sent=0;w.runner.pending=async()=>pendingPacket({effects_sent:sent,cumulativeusage:{requests:sent,response_bytes:sent*10}});w.model.decide=async()=>{sent=1;return{decision:{kind:'done',reason:'Read complete'},usage:{tokens:30,usd:0.003}};};let reports=0;w.model.report=async()=>{reports++;};w.consent();const run=await w.start(),out=await w.service.step(w.owner,w.p.id,run.run.id,run.run.revision);
  assert.equal(out.run.state,'uncertain');assert.equal(out.run.usage.tokens,30);assert(Math.abs(out.run.usage.usd-0.003)<1e-12);assert.equal(reports,0);assert.equal(out.report,null);assert.equal(w.calls.filter(([kind])=>kind==='execute').length,0);
}));
test('traffic appearing while a report is generated withholds the report and preserves known report spend',withWorld(async w=>{
  let inflight=0;w.runner.pending=async()=>pendingPacket({inflight});w.model.decide=async()=>({decision:{kind:'done',reason:'Read complete'},usage:{tokens:10,usd:0.001}});w.model.report=async request=>{inflight=1;return{report:{summary:'Must remain private',citations:request.input.source_inputs.map(source=>source.ref.id),limitations:[]},usage:{tokens:20,usd:0.002}};};w.consent();const run=await w.start(),out=await w.service.step(w.owner,w.p.id,run.run.id,run.run.revision);
  assert.equal(out.run.state,'paused');assert.equal(out.run.usage.tokens,30);assert(Math.abs(out.run.usage.usd-0.003)<1e-12);assert.equal(out.report,null);assert.equal(w.f.db.prepare('SELECT report_json FROM ops_selected_browser_runs').get().report_json,null);
}));
test('a delayed no-effect off-list proof settles once before exact grant and the next action uses a fresh ordinal',withWorld(async w=>{
  let blocked=false,granted=false;
  w.runner.pending=async()=>pendingPacket({cumulativeusage:{requests:blocked?1:0,response_bytes:0}});
  w.runner.execute=async packet=>{w.calls.push(['execute',packet]);return granted?{kind:'done',facts:[],usage:{requests:1,response_bytes:0,artifact_bytes:0},usage_mode:'cumulative'}:{kind:'off_list',escalation:{origin:'https://login.example.com',role:'authentication',purpose:'Follow selected sign-in',request_ref:'offlist-delayed',method:'GET',url_sha256:'a'.repeat(64),request_sha256:'c'.repeat(64),no_contact:true}};};
  w.runner.pollAction=async()=>blocked?{kind:'done',facts:[{code:'BROWSER_OPERATION_BLOCKED_BEFORE_EFFECT',source_ref:null}],usage:{requests:1,response_bytes:0,artifact_bytes:0},usage_mode:'cumulative'}:{kind:'pending'};
  w.runner.grantDestination=async(identity,grant)=>{granted=true;w.calls.push(['grant',grant]);};w.consent();const run=await w.start(),pending=await w.service.step(w.owner,w.p.id,run.run.id,run.run.revision),a=pending.pending_approvals[0];
  const waiting=await w.service.decision(w.owner,w.p.id,run.run.id,a.id,pending.run.revision,{decision:'approve',action_sha256:a.action_sha256});assert.equal(waiting.run.state,'awaiting_approval');assert.equal(w.f.db.prepare('SELECT state FROM ops_selected_browser_steps').get().state,'reserved');assert.equal(w.calls.filter(([kind])=>kind==='grant').length,0);
  blocked=true;const settled=await w.service.refresh(w.owner,w.p.id,run.run.id);assert.equal(settled.run.state,'running');assert.equal(w.f.db.prepare('SELECT state FROM ops_selected_browser_steps').get().state,'blocked');assert.equal(settled.run.usage.actions,1);await w.service.refresh(w.owner,w.p.id,run.run.id);assert.equal(w.calls.filter(([kind])=>kind==='grant').length,1);
  const current=w.service.get(w.owner,w.p.id,run.run.id);await w.service.step(w.owner,w.p.id,run.run.id,current.run.revision);assert.deepEqual(w.calls.filter(([kind])=>kind==='execute').map(([,packet])=>packet.ordinal),[1,2]);assert.equal(w.f.store.browserConfiguration(w.owner,w.p.id,w.config.id).configuration.configuration.destinations.allowed_origins.length,2);
}));
test('manual sign-in writes preserve the sole viewer and capture-off mode until explicit readback',withWorld(async w=>{
  const flow=await authFlow(w),preview=await flow.inventory(),current=w.service.get(w.owner,w.p.id,flow.runId);
  assert.equal(current.run.state,'human_control');assert.equal(current.run.manual_auth,true);assert.equal(current.run.controller_user_id,w.owner.id);assert.equal(current.controls.can_live,true);assert.equal(current.controls.can_release,false);assert.equal(current.controls.can_confirm_authentication,true);assert.equal(preview.inventory.requests[0].human_context,'Manual sign-in or MFA');
  await rejected(409,()=>w.service.release(w.owner,w.p.id,flow.runId,current.run.revision),'AUTHENTICATION_READBACK_REQUIRED');check(409,()=>w.service.authorizeAttempt(w.owner,{project_id:w.p.id,run_id:flow.runId,attempt_id:current.run.attempt_id,fence:1},'artifact_model'),'MANUAL_AUTH_CAPTURE_DISABLED');assert.equal(w.calls.filter(([kind])=>kind==='model').length,0);
},authOptions));
test('explicit authentication readback is separate from Giveback and permits only later paused Resume',withWorld(async w=>{
  const flow=await authFlow(w),confirmed=await flow.confirm();assert.equal(confirmed.run.state,'human_control');assert.equal(confirmed.run.manual_auth,true);assert.equal(confirmed.controls.can_release,true);assert.equal(confirmed.run.uncertain,false);assert.equal(confirmed.authentication_receipts[0].state,'accepted');assert.equal(w.calls.filter(([kind])=>kind==='release').length,0);
  const row=w.f.db.prepare('SELECT * FROM ops_selected_browser_auth_confirmations').get(),packet=JSON.parse(row.packet_json),receipt=JSON.parse(row.receipt_json);assert.equal(row.request_sha256,selectedAuthDigest(packet));assert.equal(receipt.request_sha256,row.request_sha256);assert.equal(receipt.confirmed,true);assert.equal(packet.reviewed_statement,SELECTED_BROWSER_AUTH_STATEMENT);assert.throws(()=>w.f.db.prepare("UPDATE ops_selected_browser_auth_confirmations SET receipt_json='{}' WHERE id=?").run(row.id),/immutable/);
  const released=await w.service.release(w.owner,w.p.id,flow.runId,confirmed.run.revision);assert.equal(released.run.state,'paused');assert.equal(released.run.manual_auth,false);assert.equal(w.calls.filter(([kind])=>kind==='model').length,0);const resumed=await w.service.resume(w.owner,w.p.id,flow.runId,released.run.revision);assert.equal(resumed.run.state,'running');
},authOptions));
test('authentication readback only acknowledges selected requests; unselected writes keep Giveback blocked',withWorld(async w=>{
  const flow=await authFlow(w,{requests:2}),out=await flow.confirm([flow.entries[0]]);assert.equal(out.run.state,'human_control');assert.equal(out.controls.can_release,false);assert.equal(out.run.uncertain,true);assert.equal(out.authentication_receipts[0].acknowledged_count,1);await rejected(409,()=>w.service.release(w.owner,w.p.id,flow.runId,out.run.revision),'AUTHENTICATION_READBACK_REQUIRED');const remaining=await flow.inventory();assert.deepEqual(remaining.inventory.requests.map(item=>item.request_ref),[flow.entries[1].request_ref]);assert.equal(w.calls.filter(([kind])=>kind==='execute').length,0);
},authOptions));
test('business writes cannot be cleared by authentication receipts or HTTP200',withWorld(async w=>{
  const flow=await authFlow(w,{businessWrites:1}),out=await flow.confirm();assert.equal(out.run.state,'human_control');assert.equal(out.run.uncertain,true);assert.equal(out.controls.can_release,false);await rejected(409,()=>w.service.release(w.owner,w.p.id,flow.runId,out.run.revision),'AUTHENTICATION_READBACK_REQUIRED');assert.equal(w.calls.filter(([kind])=>kind==='model').length,0);
},authOptions));
test('readback refuses another session, wrong request, duplicates, and missing fixed human statement before host acknowledgement',withWorld(async w=>{
  const flow=await authFlow(w),preview=await flow.inventory(),entry=preview.inventory.requests[0],input={inventory_sha256:preview.inventory.inventory_sha256,request_refs:[{request_ref:entry.request_ref,binding_sha256:entry.binding_sha256}],reviewed_statement:SELECTED_BROWSER_AUTH_STATEMENT};
  await rejected(403,()=>w.service.authenticationReadback({...w.owner,jti:randomUUID()},w.p.id,flow.runId),'AUTHENTICATION_CONTROLLER_REQUIRED');await rejected(400,()=>w.service.confirmAuthentication(w.owner,w.p.id,flow.runId,preview.revision,{...input,reviewed_statement:'HTTP 200 looked good'}),'SELECTED_BROWSER_INVALID_REQUEST');await rejected(409,()=>w.service.confirmAuthentication(w.owner,w.p.id,flow.runId,preview.revision,{...input,request_refs:[...input.request_refs,...input.request_refs]}),'AUTHENTICATION_REQUEST_STALE');await rejected(409,()=>w.service.confirmAuthentication(w.owner,w.p.id,flow.runId,preview.revision,{...input,request_refs:[{request_ref:entry.request_ref,binding_sha256:'a'.repeat(64)}]}),'AUTHENTICATION_REQUEST_STALE');assert.equal(w.calls.filter(([kind])=>kind==='confirm-auth').length,0);
},authOptions));
test('held/inflight requests and transport uncertainty prevent authentication confirmation',withWorld(async w=>{
  const flow=await authFlow(w),original=w.runner.authenticationInventory;
  for(const changes of [{inflight:1},{pending_count:1},{effects_uncertain:1}]){w.runner.authenticationInventory=async identity=>{const inventory={...await original(identity),...changes};inventory.inventory_sha256=selectedAuthInventoryDigest(inventory);return inventory;};await rejected(409,flow.inventory,'AUTHENTICATION_REQUESTS_PENDING');}
  assert.equal(w.calls.filter(([kind])=>kind==='confirm-auth').length,0);assert.equal(w.service.get(w.owner,w.p.id,flow.runId).run.state,'human_control');
},authOptions));
test('authentication inventory cannot change payload/URL/purpose or use an unconsumed or non-auth approval',withWorld(async w=>{
  const flow=await authFlow(w),original=w.runner.authenticationInventory;
  for(const changes of [{url_sha256:'a'.repeat(64)},{body_sha256:'a'.repeat(64)},{body_bytes:54},{request_sha256:'a'.repeat(64)},{human_context:'Save customer record'},{approval_ref:{id:randomUUID(),sha256:'a'.repeat(64)}}]){w.runner.authenticationInventory=async identity=>{const inventory=await original(identity);inventory.requests=[{...inventory.requests[0],...changes}];inventory.inventory_sha256=selectedAuthInventoryDigest(inventory);return inventory;};await rejected(502,flow.inventory,'AUTHENTICATION_APPROVAL_INVALID');}
  assert.equal(w.calls.filter(([kind])=>kind==='confirm-auth').length,0);
},authOptions));
test('late authentication receipt after viewer loss cannot activate authenticated model or browser work',withWorld(async w=>{
  const flow=await authFlow(w),original=w.runner.confirmAuthentication;let ack;w.runner.confirmAuthentication=(identity,packet)=>new Promise(resolve=>{ack=()=>original(identity,packet).then(resolve);});const pending=flow.confirm();await waitFor(()=>ack);w.runner.assertTakeover=()=>false;await ack();const out=await pending;assert.equal(out.run.state,'uncertain');assert.equal(out.run.manual_auth,false);assert.equal(out.authentication_receipts[0].state,'uncertain');assert.equal(w.f.db.prepare('SELECT COUNT(*) AS n FROM ops_selected_browser_auth_confirmed_requests').get().n,0);assert.equal(w.calls.filter(([kind])=>['model','execute'].includes(kind)).length,0);
},authOptions));
test('authorized readback suppresses concurrent refresh and human actions until exact signed acknowledgement settles',withWorld(async w=>{
  const flow=await authFlow(w),original=w.runner.confirmAuthentication;let finish;w.runner.confirmAuthentication=async(identity,packet)=>{const receipt=await original(identity,packet);return new Promise(resolve=>{finish=()=>resolve(receipt);});};
  const confirming=flow.confirm();await waitFor(()=>finish);const during=await w.service.refresh(w.owner,w.p.id,flow.runId);assert.equal(during.run.state,'preparing');assert.equal(during.run.manual_auth,true);assert.equal(during.run.controller_user_id,w.owner.id);assert.equal(during.authentication_receipts[0].state,'authorized');
  await rejected(403,()=>w.service.controlInput(w.owner,w.p.id,flow.runId,during.run.revision,{kind:'key',key:'Tab'}),'TAKEOVER_NOT_YOURS');await rejected(403,()=>w.service.release(w.owner,w.p.id,flow.runId,during.run.revision),'TAKEOVER_NOT_YOURS');assert.equal(await w.service.pump(flow.runId),'preparing');finish();const out=await confirming;assert.equal(out.run.state,'human_control');assert.equal(out.authentication_receipts[0].state,'accepted');assert.equal(out.run.uncertain,false);
},authOptions));
test('inventory semantic changes are stale while meter-only revision refresh preserves the reviewed request pins',withWorld(async w=>{
  const flow=await authFlow(w),preview=await flow.inventory(),entry=preview.inventory.requests[0],input={inventory_sha256:preview.inventory.inventory_sha256,request_refs:[{request_ref:entry.request_ref,binding_sha256:entry.binding_sha256}],reviewed_statement:SELECTED_BROWSER_AUTH_STATEMENT};
  const original=w.runner.authenticationInventory;w.runner.authenticationInventory=async identity=>{const inventory=await original(identity);inventory.ledger_sha256='5'.repeat(64);inventory.inventory_sha256=selectedAuthInventoryDigest(inventory);return inventory;};
  await rejected(409,()=>w.service.confirmAuthentication(w.owner,w.p.id,flow.runId,preview.revision,input),'AUTHENTICATION_INVENTORY_STALE');assert.equal(w.calls.filter(([kind])=>kind==='confirm-auth').length,0);
  w.runner.authenticationInventory=original;const current=await flow.inventory(),pending=w.runner.pending;w.runner.pending=async identity=>{const raw=await pending(identity);raw.cumulativeusage.response_bytes++;raw.usage={...raw.cumulativeusage};return raw;};
  const accepted=await w.service.confirmAuthentication(w.owner,w.p.id,flow.runId,current.revision,{...input,inventory_sha256:current.inventory.inventory_sha256});assert.equal(accepted.run.state,'human_control');assert.equal(accepted.authentication_receipts[0].state,'accepted');assert.equal(accepted.run.usage.response_bytes,11);
},authOptions));
test('unverified acknowledged counts cannot bypass a durable human authentication receipt',withWorld(async w=>{
  w.runner.pending=async()=>pendingPacket({effects_sent:1,auth_effects_acknowledged:1,cumulativeusage:{requests:1,response_bytes:1}});w.consent();const run=await w.start(),out=await w.service.step(w.owner,w.p.id,run.run.id,run.run.revision);assert.equal(out.run.state,'uncertain');assert.equal(out.run.result_code,'AUTHENTICATION_RECEIPT_MISMATCH');assert.equal(out.report,null);assert.equal(w.calls.filter(([kind])=>kind==='model').length,0);
}));
test('a background write between the last report guard and revoked cleanup withholds the report and preserves final meters',withWorld(async w=>{
  w.model.decide=async()=>({decision:{kind:'done',reason:'Read complete'},usage:{tokens:10,usd:0.001}});const stop=w.runner.stop;w.runner.stop=async identity=>{const receipt=await stop(identity);return{...receipt,final_network:{...receipt.final_network,requests:2,response_bytes:92,effects_sent:1,effects_uncertain:0}};};w.consent();const run=await w.start(),out=await w.service.step(w.owner,w.p.id,run.run.id,run.run.revision);
  assert.equal(out.run.state,'uncertain');assert.equal(out.receipts.length,1);assert.equal(out.receipts[0].closed.network,true);assert.equal(out.run.usage.requests,2);assert.equal(out.run.usage.response_bytes,92);assert(out.uncertainties.some(item=>item.kind==='EXTERNAL_EFFECT_UNVERIFIED'));assert(!out.uncertainties.some(item=>item.kind==='CLEANUP_UNVERIFIED'));assert.equal(out.report,null);assert.equal(out.report_visibility,'withheld');assert(w.f.db.prepare('SELECT report_json FROM ops_selected_browser_runs').get().report_json);assert.equal(w.pages.size,0);
}));
test('missing final network meters cannot prove selected cleanup or publish a report',withWorld(async w=>{
  w.model.decide=async()=>({decision:{kind:'done',reason:'Read complete'},usage:{tokens:10,usd:0.001}});const stop=w.runner.stop;w.runner.stop=async identity=>{const receipt=await stop(identity);delete receipt.final_network;return receipt;};w.consent();const run=await w.start(),out=await w.service.step(w.owner,w.p.id,run.run.id,run.run.revision);assert.equal(out.run.state,'uncertain');assert.equal(out.receipts.length,0);assert(out.uncertainties.some(item=>item.kind==='CLEANUP_UNVERIFIED'));assert.equal(out.report,null);
}));
test('still-inflight final traffic and contradictory auth counts remain uncertain despite closed browser flags',withWorld(async w=>{
  w.model.decide=async()=>({decision:{kind:'done',reason:'Read complete'},usage:{tokens:10,usd:0.001}});const stop=w.runner.stop;w.runner.stop=async identity=>{const receipt=await stop(identity);return{...receipt,final_network:{...receipt.final_network,inflight:1,pending_count:1,auth_effects_acknowledged:1,effects_sent:1}};};w.consent();const run=await w.start(),out=await w.service.step(w.owner,w.p.id,run.run.id,run.run.revision);assert.equal(out.run.state,'uncertain');assert.equal(out.receipts.length,1);assert(out.uncertainties.some(item=>item.kind==='NETWORK_IN_FLIGHT'));assert(out.uncertainties.some(item=>item.kind==='AUTHENTICATION_RECEIPT_MISMATCH'));assert.equal(out.report,null);
}));
test('signed final meter budget crossings fail completion without refunding measured traffic',withWorld(async w=>{
  w.model.decide=async()=>({decision:{kind:'done',reason:'Read complete'},usage:{tokens:10,usd:0.001}});const stop=w.runner.stop;w.runner.stop=async identity=>{const receipt=await stop(identity);return{...receipt,final_network:{...receipt.final_network,requests:w.config.configuration.budgets.max_requests+1,response_bytes:31}};};w.consent();const run=await w.start(),out=await w.service.step(w.owner,w.p.id,run.run.id,run.run.revision);assert.equal(out.run.state,'failed');assert.equal(out.run.result_code,'NETWORK_ARTIFACT_BUDGET_EXHAUSTED');assert.equal(out.run.usage.requests,w.config.configuration.budgets.max_requests+1);assert.equal(out.report,null);assert.equal(out.receipts.length,1);
}));
test('confirmed authentication remains bound to its original attempt fence during final cleanup',withWorld(async w=>{
  const flow=await authFlow(w),confirmed=await flow.confirm(),released=await w.service.release(w.owner,w.p.id,flow.runId,confirmed.run.revision),resumed=await w.service.resume(w.owner,w.p.id,flow.runId,released.run.revision);w.model.decide=async()=>({decision:{kind:'done',reason:'Authenticated page read complete'},usage:{tokens:10,usd:0.001}});const out=await w.service.step(w.owner,w.p.id,flow.runId,resumed.run.revision);assert.equal(out.run.state,'completed');assert.equal(out.run.fence,2);assert.equal(out.receipts[0].final_network.auth_effects_acknowledged,1);assert.equal(out.receipts[0].final_network.effects_sent,1);assert.equal(out.run.uncertain,false);assert(out.report);
},authOptions));
test('authentic partial cleanup retains measured traffic but a signature alone never proves physical closure',withWorld(async w=>{
  w.model.decide=async()=>({decision:{kind:'done',reason:'Read complete'},usage:{tokens:10,usd:0.001}});const stop=w.runner.stop;w.runner.stop=async identity=>{const receipt=await stop(identity);return{...receipt,closed:{...receipt.closed,network:false},final_network:{...receipt.final_network,requests:2,response_bytes:200,inflight:1}};};w.consent();const run=await w.start(),out=await w.service.step(w.owner,w.p.id,run.run.id,run.run.revision);
  assert.equal(out.run.state,'uncertain');assert.equal(out.receipts.length,1);assert.equal(out.receipts[0].closed.network,false);assert.equal(out.run.usage.requests,2);assert.equal(out.run.usage.response_bytes,200);assert.equal(w.f.db.prepare('SELECT state FROM ops_selected_browser_attempts').get().state,'cleanup_unverified');assert(out.uncertainties.some(item=>item.kind==='CLEANUP_UNVERIFIED'));assert.equal(out.report,null);
  w.runner.stop=async identity=>{const receipt=await stop(identity);return{...receipt,closed:{...receipt.closed,network:false},final_network:{...receipt.final_network,requests:3,response_bytes:220,inflight:1}};};await rejected(409,()=>w.service.retryCleanup(w.owner,w.p.id,run.run.id,out.run.revision),'SIGNED_CLEANUP_RECEIPT_REQUIRED');const partial=w.service.get(w.owner,w.p.id,run.run.id);assert.equal(partial.run.usage.requests,3);assert.equal(partial.run.usage.response_bytes,220);assert.equal(w.f.db.prepare('SELECT state FROM ops_selected_browser_attempts').get().state,'cleanup_unverified');assert(partial.uncertainties.some(item=>item.kind==='CLEANUP_UNVERIFIED'&&item.state==='unresolved'));
  w.runner.stop=async identity=>{const receipt=await stop(identity);return{...receipt,final_network:{...receipt.final_network,requests:3,response_bytes:220,inflight:0,ledger_sha256:'e'.repeat(64)}};};const closed=await w.service.retryCleanup(w.owner,w.p.id,run.run.id,partial.run.revision);assert.equal(w.f.db.prepare('SELECT state FROM ops_selected_browser_attempts').get().state,'closed');assert(closed.uncertainties.some(item=>item.kind==='CLEANUP_UNVERIFIED'&&item.state==='reconciled'));assert(closed.uncertainties.some(item=>item.kind==='NETWORK_IN_FLIGHT'&&item.state==='unresolved'));assert.equal(closed.run.usage.requests,3);assert.equal(closed.report,null);assert.equal(w.calls.filter(([kind])=>kind==='execute').length,0);
}));

function publicWorld(options={}){
 const w=world({proof:false,artifacts:{cancelAttempt(){assert.fail('Public browsing touched private storage');}},...options});
 w.runner.observe=async()=>({snapshot_ref:w.snapshot,observation:'Public page text',source_refs:[],input_targets:[],page:null,candidates:[{candidate_ref:w.candidate.candidate_ref,effect:'read',operation:{kind:'navigate',destination_id:'public-entry',url:'https://selected.example/'}}]});
 w.open=()=>w.service.openPublic(w.owner,w.p.id,{url:'https://selected.example/',project_revision:w.f.store.get(w.owner,w.p.id).revision,idempotency_key:randomUUID()});return w;
}
test('public mode navigates without guide, model consent, model calls, elevation or private storage; stops and relaunches',async()=>{
 const w=publicWorld();try{
  const started=await w.open();assert.equal(started.run.execution_mode,'public_navigation');assert.equal(started.run.state,'running');
  assert.equal(w.calls.filter(c=>c[0]==='execute').length,1);assert.equal(w.calls.filter(c=>c[0]==='model').length,0);
  const row=w.f.db.prepare('SELECT * FROM ops_selected_browser_runs WHERE id=?').get(started.run.id);
  for(const key of ['guide_id','guide_sha256','consent_sha256'])assert.equal(row[key],null);
  assert.equal(w.f.db.prepare('SELECT COUNT(*) AS n FROM ops_selected_browser_consents').get().n,0);
  assert.equal(w.service.assertLive(w.owner,w.p.id,row.id).run_id,row.id);
  assert.equal(started.controls.can_takeover,false);assert.equal(started.controls.can_clipboard,false);
  for(const intent of ['artifact_capture','artifact_model','clipboard_import','clipboard_export'])check(409,()=>w.service.authorizeAttempt(w.owner,{project_id:w.p.id,run_id:row.id,attempt_id:row.attempt_id,fence:1},intent),'PUBLIC_ARTIFACTS_UNAVAILABLE');
  await w.service.pump(row.id);assert.equal(w.calls.filter(c=>c[0]==='model').length,0);
  await rejected(409,w.open,'ATTEMPT_ALREADY_ACTIVE');
  const stopped=await w.service.cancel(w.owner,w.p.id,row.id,w.service.get(w.owner,w.p.id,row.id).run.revision);
  assert.equal(stopped.run.state,'cancelled');assert.equal(stopped.run.uncertain,false);assert.equal(stopped.receipts[0].closed.network,true);
  assert.equal((await w.open()).run.state,'running');
 }finally{w.f.close();}
});
test('public pending read cancellation and process recovery fence attempts without replay',async()=>{
 const w=publicWorld({runnerChanges:{execute:async()=>({kind:'pending'})}});try{
  const started=await w.open();assert.equal(started.run.state,'running');await w.service.recover();
  const stopped=w.service.get(w.owner,w.p.id,started.run.id);assert.equal(stopped.run.state,'failed');assert.equal(stopped.run.result_code,'PROCESS_RECOVERY_NO_REPLAY');assert.equal(stopped.run.uncertain,false);
  assert.equal(w.calls.filter(c=>c[0]==='model').length,0);assert.equal((await w.open()).run.state,'running');
 }finally{w.f.close();}
});
test('public cleanup failure remains recorded and prevents another launch',async()=>{
 const w=publicWorld({receipt:false});try{
  const started=await w.open(),stopped=await w.service.cancel(w.owner,w.p.id,started.run.id,started.run.revision);
  assert.equal(stopped.run.state,'uncertain');assert(stopped.uncertainties.some(u=>u.kind==='CLEANUP_UNVERIFIED'));
  await rejected(409,w.open,'CLEANUP_UNVERIFIED');
 }finally{w.f.close();}
});
test('public final signed effect counters remain uncertain even when closure is complete',async()=>{
 const w=publicWorld();try{
  const normal=w.runner.stop;w.runner.stop=async identity=>{const receipt=await normal(identity);receipt.final_network.effects_sent=1;return receipt;};
  const started=await w.open(),stopped=await w.service.cancel(w.owner,w.p.id,started.run.id,started.run.revision);
  assert.equal(stopped.run.state,'uncertain');assert(stopped.uncertainties.some(u=>u.kind==='EXTERNAL_EFFECT_UNVERIFIED'));
 }finally{w.f.close();}
});
test('1123 copies historical run pins and dependent records, retains triggers and enforces nullable public-only pins',()=>{
 const f=operationsFixture();try{
  operationalSelectedBrowserMigration1118(f.adapter);operationalSelectedBrowserAuthMigration1122(f.adapter);
  const owner=f.addUser(),project=f.store.create(owner,{name:'Migration preservation'}),c=draft();
  const saved=f.store.createBrowserConfiguration(owner,project.id,project.revision,{configuration:c}).configuration;
  const run=randomUUID(),attempt=randomUUID(),at=new Date().toISOString();
  f.db.prepare(`INSERT INTO ops_selected_browser_runs(id,project_id,configuration_id,idempotency_key,started_by,owner_user_id,configuration_revision,configuration_sha256,configuration_json,guide_id,guide_sha256,consent_sha256,project_revision,project_limits_revision,state,attempt_id,usage_json,started_at,deadline_at) VALUES(?,?,?,?,?,?,1,?,?,?,?,?,1,1,'cancelled',?,?,?,?)`).run(run,project.id,saved.id,randomUUID(),owner.id,owner.id,saved.configuration_sha256,JSON.stringify(c),randomUUID(),'a'.repeat(64),'b'.repeat(64),attempt,'{}',at,at);
  f.db.prepare("INSERT INTO ops_selected_browser_attempts VALUES(?,?,1,'closed',?,?,NULL)").run(attempt,run,at,at);
  const before=f.db.prepare('SELECT * FROM ops_selected_browser_runs WHERE id=?').get(run);
  f.db.exec('PRAGMA foreign_keys=OFF');f.adapter.transaction(()=>operationalPublicNavigationMigration1123(f.adapter))();f.db.exec('PRAGMA foreign_keys=ON');
  const {execution_mode,...after}=f.db.prepare('SELECT * FROM ops_selected_browser_runs WHERE id=?').get(run);
  assert.equal(execution_mode,'agent');assert.deepEqual(after,{...before});assert.equal(f.db.prepare('SELECT run_id FROM ops_selected_browser_attempts WHERE id=?').get(attempt).run_id,run);assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(),[]);
  assert.throws(()=>f.db.prepare("UPDATE ops_selected_browser_runs SET execution_mode='public_navigation' WHERE id=?").run(run),/immutable/);
  assert.throws(()=>f.db.prepare('UPDATE ops_selected_browser_runs SET guide_id=NULL WHERE id=?').run(run),/immutable/);
 }finally{f.close();}
});

test('public readiness reflects global cleanup and active guards without leaking project identity',async()=>{
 const w=publicWorld({receipt:false});try{
  const p2=w.f.store.create(w.owner,{name:'Another project'}),started=await w.open();
  const active=await w.service.publicReadiness(w.owner,p2.id,'https://selected.example/');
  assert.equal(active.can_start,false);assert(active.checks.some(c=>c.code==='ATTEMPT_ALREADY_ACTIVE'));
  const stopped=await w.service.cancel(w.owner,w.p.id,started.run.id,started.run.revision);
  const ready=await w.service.publicReadiness(w.owner,p2.id,'https://selected.example/');
  assert.equal(ready.can_start,false);assert(ready.checks.some(c=>c.code==='CLEANUP_UNVERIFIED'));
  for(const privateValue of [stopped.run.id,w.p.id,w.owner.id])assert(!JSON.stringify(ready).includes(privateValue));
  await rejected(403,()=>w.service.retryCleanup(w.owner,w.p.id,stopped.run.id,stopped.run.revision),'AGENT_CONTROL_VERIFICATION_REQUIRED');
 }finally{w.f.close();}
});
test('explicit public cleanup recovery retains the failed run and permits a fresh launch without replay',async()=>{
 const w=publicWorld({receipt:false,proof:true});try{
  const started=await w.open(),stopped=await w.service.cancel(w.owner,w.p.id,started.run.id,started.run.revision),before=w.calls.filter(c=>c[0]==='execute').length;
  const recovery=createSelectedBrowserService({db:w.f.adapter,runner:w.runner,clock:()=>new Date(w.now()),verifyControl:()=>true,verifyElevation:()=>true,verifyReceipt:()=>true});
  const resolved=await recovery.retryCleanup(w.owner,w.p.id,stopped.run.id,stopped.run.revision);
  assert.equal(resolved.run.state,'uncertain');assert.equal(resolved.run.uncertain,false);assert.equal(resolved.run.id,stopped.run.id);
  assert.equal(resolved.uncertainties[0].state,'reconciled');assert(resolved.receipts[0].closed.network);
  assert.equal(w.calls.filter(c=>c[0]==='execute').length,before);
  assert.equal((await recovery.publicReadiness(w.owner,w.p.id,'https://selected.example/')).can_start,true);
  const next=await recovery.openPublic(w.owner,w.p.id,{url:'https://selected.example/',project_revision:w.f.store.get(w.owner,w.p.id).revision,idempotency_key:randomUUID()});
  assert.equal(next.run.state,'running');assert.notEqual(next.run.id,stopped.run.id);
  assert.equal(w.calls.filter(c=>c[0]==='model').length,0);
 }finally{w.f.close();}
});

for(const [provided,expected] of [['NETWORK_ROUTE_UNVERIFIED','NETWORK_ROUTE_UNVERIFIED'],['DNS_LOOKUP_UNVERIFIED','DNS_LOOKUP_UNVERIFIED'],['PRIVATE_TOKEN_SENTINEL','BROWSER_LAUNCH_FAILED'],['secret\nstack','BROWSER_LAUNCH_FAILED'],[undefined,'BROWSER_LAUNCH_FAILED']])test('public launch retains only a fixed refusal code: '+String(provided),async()=>{
 let launches=0;const w=publicWorld({runnerChanges:{launch:async()=>{launches++;throw Object.assign(new Error('private-url-and-secret-sentinel'),{code:provided,detail:'private-host-sentinel'});}}});
 try{
  const out=await w.open();assert.equal(out.run.state,'failed');assert.equal(out.run.result_code,'LAUNCH_UNCERTAIN');assert.equal(out.run.launch_failure_code,expected);assert.equal(out.run.uncertain,false);assert(out.receipts.length);
  assert.equal(w.service.get(w.viewer,w.p.id,out.run.id).run.launch_failure_code,expected);
  const metadata=w.f.db.prepare("SELECT metadata_json FROM ops_selected_browser_events WHERE run_id=? AND kind='LAUNCH_REFUSED'").get(out.run.id);
  assert.deepEqual(JSON.parse(metadata.metadata_json),{code:expected});assert(!JSON.stringify(out).includes('sentinel'));
  assert.equal(launches,1);assert.equal(w.calls.filter(c=>['execute','model'].includes(c[0])).length,0);
  assert.equal((await w.service.publicReadiness(w.owner,w.p.id,'https://selected.example/')).can_start,true);
 }finally{w.f.close();}
});
test('public launch diagnostic never substitutes for unverified cleanup or permits another launch',async()=>{
 const w=publicWorld({receipt:false,runnerChanges:{launch:async()=>{throw Object.assign(new Error('hidden detail'),{code:'NETWORK_ROUTE_UNVERIFIED'});}}});try{
  const out=await w.open();assert.equal(out.run.state,'uncertain');assert.equal(out.run.launch_failure_code,'NETWORK_ROUTE_UNVERIFIED');assert.equal(out.run.uncertain,true);
  assert.equal(out.receipts.length,0);assert(out.uncertainties.some(u=>u.kind==='CLEANUP_UNVERIFIED'&&u.state==='unresolved'));
  const ready=await w.service.publicReadiness(w.owner,w.p.id,'https://selected.example/');assert.equal(ready.can_start,false);assert(ready.checks.some(c=>c.code==='CLEANUP_UNVERIFIED'));
  await rejected(409,w.open,'CLEANUP_UNVERIFIED');
 }finally{w.f.close();}
});

test('a failed launch diagnostic write still performs fenced cleanup',async()=>{
 const w=publicWorld({runnerChanges:{launch:async()=>{throw Object.assign(new Error('launch refusal'),{code:'NETWORK_ROUTE_UNVERIFIED'});}}});try{
  w.f.db.exec("CREATE TRIGGER refuse_launch_diagnostic BEFORE INSERT ON ops_selected_browser_events WHEN NEW.kind='LAUNCH_REFUSED' BEGIN SELECT RAISE(ABORT,'diagnostic write refused'); END");
  await assert.rejects(w.open,/diagnostic write refused/);
  const run=w.service.list(w.owner,w.p.id).runs[0],record=w.service.get(w.owner,w.p.id,run.id);
  assert.equal(run.state,'failed');assert.equal(run.uncertain,false);assert.equal(run.launch_failure_code,null);
  assert.equal(record.receipts.length,1);assert(record.receipts[0].closed.network);assert.equal(w.calls.filter(c=>c[0]==='stop').length,1);
 }finally{w.f.close();}
});
