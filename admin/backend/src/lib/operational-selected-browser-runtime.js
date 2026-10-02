import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto';
import { createSupervisorClient } from './operational-worker-supervisor.js';
import { createSelectedBrowserService } from './operational-selected-browser-service.js';
import { createBrowserModelBridge } from './operational-browser-model.js';
import { createBrowserConversionService } from './operational-browser-conversion.js';
import { createBrowserArtifactsStore } from './operational-browser-artifacts-store.js';
import { createBrowserArtifactsService } from './operational-browser-artifacts-service.js';
import { createBrowserArtifactFiles } from './operational-browser-artifacts-files.js';
import { createBrowserArtifactImageRedactor } from './operational-browser-artifacts-image-decoder.js';
import { createBrowserArtifactPdfDecoder } from './operational-browser-artifacts-pdf-decoder.js';
import { createEvidenceDecoder } from './operational-evidence-decoder.js';
import { canonicalBrowserDraft, browserDraftHash } from './operational-browser-agent-proposal.js';
import { assertOperation, OperationsError } from './operational-projects-logic.js';
import { hasControlGrant } from './operational-control-grants.js';
import { fromViewer, toViewer } from './operational-live-relay.js';

const CONTRACT='selected-browser.v1';
const SHA=/^[a-f0-9]{64}$/;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const fail=code=>{throw Object.assign(new OperationsError(503,code),{code});};
const identity=value=>Object.fromEntries(['run_id','attempt_id','fence','policy_sha256'].map(k=>[k,value[k]]));
const same=(a,b)=>canonicalBrowserDraft(a)===canonicalBrowserDraft(b);

// Only signed host facts establish readiness or cleanup. The launch proof is
// retained independently of process memory, so recovery cannot adopt a new VM
// boot, a different workspace or a different destination plan as this attempt.
export function operationalSelectedBrowserRuntimeMigration1121(db){db.exec(`
  CREATE TABLE ops_selected_browser_host_pins (
    attempt_id TEXT PRIMARY KEY REFERENCES ops_selected_browser_attempts(id),
    run_id TEXT NOT NULL REFERENCES ops_selected_browser_runs(id),
    original_fence INTEGER NOT NULL CHECK(original_fence>0), policy_sha256 TEXT NOT NULL,
    vm_uuid TEXT NOT NULL, boot_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
    network_plan_sha256 TEXT NOT NULL, launch_json TEXT NOT NULL CHECK(json_valid(launch_json)), created_at TEXT NOT NULL
  );
  CREATE TRIGGER ops_selected_browser_host_pins_immutable BEFORE UPDATE ON ops_selected_browser_host_pins
    BEGIN SELECT RAISE(ABORT,'Selected-browser host pins are immutable'); END;
`);}

export function createSelectedBrowserAttestationVerifier({publicKeyPem,vmUuid,clock=()=>Date.now()}){
  const key=createPublicKey(publicKeyPem);
  if(key.asymmetricKeyType!=='ed25519'||!UUID.test(vmUuid))fail('BROWSER_BOUNDARY_UNVERIFIED');
  return (reply,kind)=>{
    try{
      const parts=String(reply?.attestation).split('.');
      if(parts.length!==3||parts[0]!=='sbr1')return null;
      const body=Buffer.from(parts[1],'base64url'),signature=Buffer.from(parts[2],'base64url');
      if(body.length>100000||signature.length!==64||!verify(null,body,key,signature))return null;
      const payload=JSON.parse(body.toString('utf8'));
      if(payload.kind!==kind||payload.contract_version!==CONTRACT||payload.vm_uuid!==vmUuid)return null;
      for(const [k,v] of Object.entries(reply))if(k!=='attestation'&&!same(payload[k],v))return null;
      if(kind==='selected-browser-status'&&(!Number.isFinite(Date.parse(payload.valid_until))||Date.parse(payload.valid_until)<=clock()||Date.parse(payload.valid_until)>clock()+60000))return null;
      return payload;
    }catch{return null;}
  };
}

// Dedicated storage and explicitly reviewed parser wrappers. No directory or
// OS boundary is created here, and absence never activates a local fallback.
export function browserArtifactsConfiguration(env=process.env){
  const root=env.OPERATIONS_BROWSER_ARTIFACT_DIR;
  const quota=Number(env.OPERATIONS_BROWSER_ARTIFACT_QUOTA_BYTES);
  const checkout=fileURLToPath(new URL('../../../../',import.meta.url));
  const within=(a,b)=>{const r=path.relative(b,a);return !r||(!r.startsWith('..'+path.sep)&&r!=='..'&&!path.isAbsolute(r));};
  if(env.OPERATIONS_BROWSER_ARTIFACT_BOUNDARY_REVIEWED!=='true'||!root||!path.isAbsolute(root)||within(root,checkout)||within(checkout,root)||
    !Number.isSafeInteger(quota)||quota<16777216||quota>2147483648)return {available:false};
  const reviewed=(name,capability)=>env[name+'_CAPABILITY']===capability&&path.isAbsolute(env[name]||'')?env[name]:null;
  return {available:true,root,quota,imageRunner:reviewed('OPERATIONS_BROWSER_IMAGE_RUNNER','browser-artifact-image-v1'),
    redactRunner:reviewed('OPERATIONS_BROWSER_REDACT_RUNNER','browser-artifact-image-redact-v1'),
    pdfRunner:reviewed('OPERATIONS_BROWSER_PDF_RUNNER','browser-artifact-pdf-v1')};
}

export function createSelectedBrowserRuntime(config,{db,store,readFile=readFileSync,client:injectedClient,
  artifactConfig=browserArtifactsConfiguration(),clock=()=>Date.now(),isEnabled=()=>false,isMetadataEnabled=isEnabled,log=()=>{},
  scheduleInterval=setInterval,cancelInterval=clearInterval}={}){
  if(!db||!store)throw new Error('Selected-browser database and Operations store required');
  const one=(sql,...args)=>db.prepare(sql).get(...args),all=(sql,...args)=>db.prepare(sql).all(...args),write=(sql,...args)=>db.prepare(sql).run(...args);
  const stamp=()=>new Date(clock()).toISOString();
  const access=(actor,pid,operation='read')=>{if(!isMetadataEnabled())fail('BROWSER_METADATA_DISABLED');const p=store.get(actor,pid);assertOperation(p.own_role,operation,!!p.archived_at);return {p,role:p.own_role};};
  const actorFor=ref=>{const r=one('SELECT * FROM ops_selected_browser_runs WHERE id=? AND attempt_id=?',ref.run_id,ref.attempt_id);if(!r)fail('BROWSER_ATTEMPT_UNKNOWN');return {id:r.started_by,jti:r.starter_session_id,human:true};};
  const scopeFor=ref=>{const r=one('SELECT project_id FROM ops_selected_browser_runs WHERE id=? AND attempt_id=?',ref.run_id,ref.attempt_id);if(!r)fail('BROWSER_ATTEMPT_UNKNOWN');return {project_id:r.project_id,...identity(ref),fence:1};};
  // Private storage scope omits execution policy metadata by construction.
  const privateScope=ref=>{const s=scopeFor(ref);return {project_id:s.project_id,run_id:s.run_id,attempt_id:s.attempt_id,fence:s.fence};};
  const liveSession=actor=>{const s=actor?.jti&&one('SELECT * FROM sessions WHERE id=? AND user_id=?',actor.jti,actor.id);return s&&!s.revoked_at&&s.expires_at>stamp()?s:null;};
  const verifyControl=actor=>!!liveSession(actor)&&hasControlGrant(db,{sessionId:actor.jti,userId:actor.id,now:new Date(clock())});
  const verifyElevation=actor=>{const s=liveSession(actor);return !!s&&s.sudo_until>stamp();};
  let client=null,attest=null,model=null,reason=config.reason||'not_configured';
  if(config.execution)try{
    const publicKeyPem=readFile(config.execution.publicKeyPath,'utf8');
    attest=createSelectedBrowserAttestationVerifier({publicKeyPem,vmUuid:config.execution.vmUuid,clock});
    client=injectedClient||createSupervisorClient(config.execution.socket);
    model=createBrowserModelBridge({client:{request:(method,params,options)=>request(method,params,options)},publicKeyPem,clock});reason=null;
  }catch{client=null;attest=null;model=null;reason='invalid_configuration';}
  let runs,artifacts=null,files=null,closed=false,timer=null,busy=false;
  const stagedUploads=new Set();
  if(artifactConfig.available)try{
    // Read-only preflight: a review flag cannot make an absent, replaced or
    // unsafe directory executable. The adapter never creates its root.
    files=createBrowserArtifactFiles(artifactConfig.root);
    const adapter=Object.fromEntries(['read','write','remove'].map(name=>[name,(...args)=>files[name](...args)]));
  const artifactStore=createBrowserArtifactsStore({one,all,run:write,tx:fn=>db.transaction(fn).immediate(),access,
      now:stamp,uuid:randomUUID,authorizeAttempt:(...args)=>{if(!isEnabled())fail('BROWSER_RUN_DISABLED');return runs.authorizeAttempt(...args);},
      verifyInputApproval:(...args)=>runs.verifyInputDraftApproval?.(...args)===true,
      verifyRetainedInputApproval:(...args)=>runs.verifyRetainedInputDraftApproval?.(...args)===true,
      verifyObservationOrigin:(...args)=>runs.verifyObservationOrigin?.(...args)===true,
      event:(actor,pid,action,subject,metadata)=>write('INSERT INTO ops_project_events(project_id,actor_id,action,subject_id,created_at,request_id,metadata_json) VALUES(?,?,?,?,?,?,?)',pid,actor.id,action,subject,stamp(),actor.requestId||randomUUID(),JSON.stringify(metadata))},
      {installationBytes:artifactConfig.quota,accountBytes:Math.min(artifactConfig.quota,134217728),projectBytes:Math.min(artifactConfig.quota,134217728)});
    const decodeImage=artifactConfig.imageRunner?createEvidenceDecoder({runner:artifactConfig.imageRunner,timeoutMs:5000}):null;
    const redactImage=artifactConfig.redactRunner?createBrowserArtifactImageRedactor({runner:artifactConfig.redactRunner,capability:'browser-artifact-image-redact-v1'}):null;
    const decodePdf=artifactConfig.pdfRunner?createBrowserArtifactPdfDecoder({runner:artifactConfig.pdfRunner,capability:'browser-artifact-pdf-v1'}):null;
    artifacts={store:artifactStore,service:createBrowserArtifactsService({store:artifactStore,files:adapter,decodeImage,redactImage,decodePdf})};
  }catch{files?.close();files=null;artifacts=null;log({code:'BROWSER_PRIVATE_STORAGE_UNAVAILABLE'});}
  const request=(method,params,options)=>{
    const cleanup=['selected_browser_stop','selected_browser_deny_request','selected_browser_pause','selected_browser_release','cancel_selected_browser_model'].includes(method);
    if(!cleanup&&!(method==='selected_browser_model_status'||method==='selected_browser_model'&&params?.purpose==='conversion'?isMetadataEnabled():isEnabled()))return Promise.reject(Object.assign(new Error('BROWSER_RUN_DISABLED'),{code:'BROWSER_RUN_DISABLED'}));
    return client?client.request(method,params,options):Promise.reject(Object.assign(new Error('BROWSER_RUNTIME_UNAVAILABLE'),{code:'BROWSER_RUNTIME_UNAVAILABLE'}));
  };
  const verifyReceipt=(receipt,expected)=>{
    const p=attest?.(receipt,'selected-browser-teardown');
    const pins=one('SELECT * FROM ops_selected_browser_host_pins WHERE attempt_id=?',expected.attempt_id);
    return !!p&&!!pins&&same(identity(receipt),identity(expected))&&p.original_fence===pins.original_fence&&p.vm_uuid===pins.vm_uuid&&p.boot_id===pins.boot_id&&p.workspace_id===pins.workspace_id&&p.network_plan_sha256===pins.network_plan_sha256&&same(p.closed,{browser:true,network:true,session:true,temporary_files:true});
  };
  async function settle(ref,raw){
    if(raw?.kind&&raw.kind!=='done')return raw;
    if(['started','pending'].includes(raw?.state))return {kind:'pending'};
    if(raw?.state!=='completed'||!raw.result)fail('BROWSER_RESULT_UNVERIFIED');
    const result=raw.result;
    if(result.status!=='done')return {kind:'uncertain'};
    const usage=raw.usage;
    if(!usage||!['requests','response_bytes','artifact_bytes'].every(k=>Number.isSafeInteger(usage[k])&&usage[k]>=0)||!['delta','cumulative'].includes(raw.usage_mode))fail('BROWSER_USAGE_UNVERIFIED');
    let source_ref=null,artifactBytes=0;
    if(result.artifact){
      if(!artifacts)fail('BROWSER_PRIVATE_STORAGE_UNAVAILABLE');
      const a=result.artifact;
      if(typeof a.bytes_base64!=='string'||a.bytes_base64.length>22369624||!SHA.test(a.sha256)||!Number.isSafeInteger(a.byte_count)||a.byte_count<1||a.byte_count>16777216)fail('BROWSER_ARTIFACT_INVALID');
      if(usage.artifact_bytes<a.byte_count)fail('BROWSER_USAGE_UNVERIFIED');
      const bytes=Buffer.from(a.bytes_base64,'base64');
      try{
        if(bytes.toString('base64')!==a.bytes_base64||bytes.length!==a.byte_count||browserDraftHash(bytes)!==a.sha256)fail('BROWSER_ARTIFACT_INVALID');
        const saved=await artifacts.service.stage(actorFor(ref),privateScope(ref),{kind:a.kind,mime_type:a.mime_type,sha256:a.sha256,byte_count:a.byte_count,idempotency_key:randomUUID()},[bytes]);
        source_ref={id:saved.id,sha256:saved.sha256};artifactBytes=a.byte_count;
      }finally{bytes.fill(0);}
    }
    // Host counters must be present. Missing metering is not a zero-cost action.
    if(usage.artifact_bytes<artifactBytes)fail('BROWSER_USAGE_UNVERIFIED');
    return {kind:'done',facts:[{code:'BROWSER_ACTION_COMPLETED',source_ref}],usage,usage_mode:raw.usage_mode};
  }
  async function verifyPrivateInputs(ref,operation=null,snapshot=null){
    const r=one('SELECT configuration_json,manual_auth FROM ops_selected_browser_runs WHERE id=? AND attempt_id=?',ref.run_id,ref.attempt_id);
    if(!r)fail('BROWSER_ATTEMPT_UNKNOWN');
    const configured=JSON.parse(r.configuration_json).artifacts.upload_asset_refs;
    const uploads=operation?.kind==='upload'?configured.filter(a=>same(a,operation.asset_ref)):operation?[]:configured;
    if(operation?.kind==='upload'&&uploads.length!==1)fail('BROWSER_PRIVATE_INPUT_PINS_STALE');
    for(const asset of uploads){
      if(!artifacts)fail('BROWSER_PRIVATE_STORAGE_UNAVAILABLE');
      if(r.manual_auth){artifacts.service.verifyRetainedUpload(actorFor(ref),privateScope(ref),asset);continue;}
      const resolved=await artifacts.service.resolveUpload(actorFor(ref),privateScope(ref),asset);resolved.bytes.fill(0);
    }
    const wanted=operation?.input_ref??operation?.clipboard_ref;
    const rows=all("SELECT * FROM ops_selected_browser_approvals WHERE run_id=? AND attempt_id=? AND kind='input_draft' AND state='consumed'",ref.run_id,ref.attempt_id);
    const drafts=wanted?rows.filter(a=>{const p=JSON.parse(a.payload_json);return p.artifact_ref.id===wanted.id&&p.artifact_ref.sha256===wanted.sha256;}):operation?[]:rows;
    if(wanted&&!drafts.length){
      if(operation.kind!=='paste'||!artifacts)fail('BROWSER_PRIVATE_INPUT_PINS_STALE');
      if(r.manual_auth){artifacts.service.verifyRetainedClipboard(actorFor(ref),privateScope(ref),wanted);return;}
      const resolved=artifacts.service.resolveClipboard(actorFor(ref),privateScope(ref),wanted.id);
      try{if(resolved.sha256!==wanted.sha256)fail('BROWSER_PRIVATE_INPUT_PINS_STALE');}finally{resolved.bytes.fill(0);}
    }
    for(const a of drafts){
      const p=JSON.parse(a.payload_json);
      if(snapshot&&!same(snapshot,p.snapshot_ref)||operation&&(operation.kind!==p.action_kind||operation.element_ref!==p.element_ref))fail('BROWSER_PRIVATE_INPUT_PINS_STALE');
      const manifest={artifact_ref:p.artifact_ref,target_ref:p.target_ref,snapshot_ref:p.snapshot_ref,purpose:p.purpose,approval_ref:{id:a.id,sha256:a.action_sha256}};
      if(r.manual_auth){artifacts.service.verifyRetainedInputDraft(actorFor(ref),privateScope(ref),manifest,{target_ref:p.target_ref,snapshot_ref:p.snapshot_ref});continue;}
      const resolved=await artifacts.service.resolveInputDraft(actorFor(ref),privateScope(ref),manifest,{target_ref:p.target_ref,snapshot_ref:p.snapshot_ref});resolved.bytes.fill(0);
    }
  }
  const takeoverViewer=(ref,options)=>[...viewers.values()].find(v=>v.run_id===ref.run_id&&v.user_id===options.controller_id&&v.session_id===options.session_id&&same(v.identity,identity(ref)));
  const runner=client?{
    async readiness(input){
      try{files?.verify();}catch{return {contract_version:CONTRACT,available:false,code:'BROWSER_PRIVATE_STORAGE_UNAVAILABLE'};}
      const raw=await request('selected_browser_status',{configuration_json:canonicalBrowserDraft(input.configuration),configuration_sha256:input.configuration_sha256});
      const p=attest(raw,'selected-browser-status');
      if(!p||p.policy_sha256!==input.configuration_sha256)return {contract_version:CONTRACT,available:false,code:'BROWSER_STATUS_UNVERIFIED'};
      return {...raw,verified_isolation:p.isolation===true,verified_destinations:p.destinations===true,verified_site_policy:p.site_policy===true};
    },
    async launch(input){
      const r=one('SELECT * FROM ops_selected_browser_runs WHERE id=? AND attempt_id=?',input.run_id,input.attempt_id);
      const project=r&&one('SELECT agent_limits_json FROM ops_projects WHERE id=?',r.project_id);
      if(!r||!project||!same(identity(input),{run_id:r.id,attempt_id:r.attempt_id,fence:r.fence,policy_sha256:r.configuration_sha256}))fail('BROWSER_LAUNCH_PINS_STALE');
      const params={contract_version:CONTRACT,...identity(input),project_id:r.project_id,workspace_id:r.attempt_id,project_revision:r.project_revision,
        configuration_id:r.configuration_id,configuration_revision:r.configuration_revision,project_limits_revision:r.project_limits_revision,
        project_limits:JSON.parse(project.agent_limits_json),configuration_json:r.configuration_json,configuration_sha256:r.configuration_sha256,
        guide_version_id:r.guide_id,guide_hash:r.guide_sha256,consent_hash:r.consent_sha256,deadline_at:r.deadline_at};
      // policy_sha256 is derived by the host from canonical configuration bytes.
      delete params.policy_sha256;
      const launched=await request('selected_browser_launch',params),proof=attest(launched,'selected-browser-launch');
      if(!proof||!same(identity(proof),identity(input))||proof.workspace_id!==r.attempt_id||proof.original_fence!==r.fence||!UUID.test(proof.boot_id)||!SHA.test(proof.network_plan_sha256))fail('BROWSER_LAUNCH_UNVERIFIED');
      write('INSERT INTO ops_selected_browser_host_pins VALUES(?,?,?,?,?,?,?,?,?,?)',r.attempt_id,r.id,r.fence,r.configuration_sha256,proof.vm_uuid,proof.boot_id,proof.workspace_id,proof.network_plan_sha256,JSON.stringify(launched),stamp());
      return launched;
    },
    async observe(ref){
      const r=one('SELECT configuration_json FROM ops_selected_browser_runs WHERE id=? AND attempt_id=?',ref.run_id,ref.attempt_id);
      if(!r)fail('BROWSER_ATTEMPT_UNKNOWN');
      for(const asset of JSON.parse(r.configuration_json).artifacts.upload_asset_refs){
        if(!artifacts)fail('BROWSER_PRIVATE_STORAGE_UNAVAILABLE');
        // Recheck immutable input approval and current authority on every
        // observation, including when already staged inside this attempt.
        const file=await artifacts.service.resolveUpload(actorFor(ref),privateScope(ref),asset);
        const pin=ref.attempt_id+':'+asset.id+':'+asset.sha256;
        if(!stagedUploads.has(pin)){
          try{await request('selected_browser_stage',{...identity(ref),kind:'upload',ref:asset,mime_type:asset.mime_type,bytes_base64:file.bytes.toString('base64')});}finally{file.bytes.fill(0);}
          stagedUploads.add(pin);
        }else file.bytes.fill(0);
      }
      return request('selected_browser_observe',identity(ref));
    },
    async execute(envelope){await verifyPrivateInputs(envelope,envelope.operation,envelope.snapshot_ref);await request('selected_browser_action',{...identity(envelope),envelope});return settle(envelope,await request('selected_browser_poll_action',{...identity(envelope),ordinal:envelope.ordinal}));},
    pollAction:async ref=>settle(ref,await request('selected_browser_poll_action',{...identity(ref),ordinal:ref.ordinal})),
    pending:ref=>request('selected_browser_pending',identity(ref)),
    async approveRequest(ref,packet){
      await verifyPrivateInputs(ref);
      // A prior paste can feed a later form or autosave. Recheck every used
      // clipboard pin before authorizing a held write, including human input.
      for(const step of all("SELECT action_json FROM ops_selected_browser_steps WHERE run_id=? AND attempt_id=? AND state IN('reserved','done')",ref.run_id,ref.attempt_id)){
        const action=JSON.parse(step.action_json);if(action.operation.kind==='paste')await verifyPrivateInputs(ref,action.operation,action.snapshot_ref);
      }
      const grant={schema:'proxypilot.selected-browser.effect-grant.v1',id:packet.id,identity:{project_id:privateScope(ref).project_id,...identity(ref)},request_ref:packet.request_ref,binding_sha256:packet.binding_sha256,expires_at:Math.floor(Date.parse(packet.expires_at)/1000),purpose_sha256:packet.purpose_sha256};return request('selected_browser_approve_request',{...identity(ref),request_ref:packet.request_ref,grant});},
    denyRequest:(ref,request_ref)=>request('selected_browser_deny_request',{...identity(ref),request_ref}),
    async offerInput(ref,packet,{actor,manifest}={}){
      if(!artifacts||!actor||!manifest)fail('BROWSER_PRIVATE_INPUT_UNAVAILABLE');
      const resolved=await artifacts.service.resolveInputDraft(actor,privateScope(ref),manifest,{target_ref:packet.target_ref,snapshot_ref:packet.snapshot_ref});
      try{
      if(!same(resolved.input_ref,packet.input_ref))fail('BROWSER_PRIVATE_INPUT_PINS_STALE');
      const approved=one("SELECT payload_json FROM ops_selected_browser_approvals WHERE id=? AND run_id=? AND kind='input_draft'",manifest.approval_ref.id,ref.run_id);
      const kind=approved&&JSON.parse(approved.payload_json).action_kind;
      if(!['type','paste'].includes(kind))fail('BROWSER_PRIVATE_INPUT_PINS_STALE');
      // Text goes only to the owned guest's stdin-backed command channel.
      // The HTTP controller and durable approval records carry opaque pins.
      await request('selected_browser_stage',{...identity(ref),kind:kind==='type'?'input':'clipboard',ref:resolved.input_ref,mime_type:'text/plain',bytes_base64:resolved.bytes.toString('base64')});
      return await request('selected_browser_offer_input',{...identity(ref),snapshot_ref:packet.snapshot_ref,target_ref:packet.target_ref,input_ref:resolved.input_ref});
      }finally{resolved.bytes.fill(0);}
    },
    grantDestination(ref,g){if(!['navigation','resource','authentication'].includes(g.role)||g.role==='authentication'&&!g.origin.startsWith('https://'))fail('BROWSER_DESTINATION_GRANT_INVALID');const destination={id:'temporary-'+g.id,origin:g.origin,roles:[g.role],session_headers:g.role==='authentication'?'this_origin_session':'omit'};const grant={schema:'proxypilot.selected-browser.destination-grant.v1',id:g.id,identity:{project_id:privateScope(ref).project_id,...identity(ref)},origin:g.origin,roles:destination.roles,purpose_sha256:browserDraftHash(g.purpose),expires_at:Math.floor(Date.parse(g.expires_at)/1000),persist_to_allowlist:false,wildcards:false};return request('selected_browser_grant_destination',{...identity(ref),destination,grant});},
    pause:ref=>request('selected_browser_pause',identity(ref)),resume:ref=>request('selected_browser_resume',identity(ref)),
    assertTakeover(ref,options){return !!takeoverViewer(ref,options);},
    async takeover(ref,options){
      const r=one('SELECT controller_session_id FROM ops_selected_browser_runs WHERE id=? AND attempt_id=?',ref.run_id,ref.attempt_id);
      const viewer=takeoverViewer(ref,{...options,session_id:r?.controller_session_id});
      if(!viewer)fail('LIVE_VIEW_REQUIRED_FOR_TAKEOVER');
      const result=await request('selected_browser_takeover',{...identity(ref),controller_id:options.controller_id,manual_auth:true,conn:viewer.conn});
      if(!takeoverViewer(ref,{...options,session_id:r?.controller_session_id}))fail('CONTROL_VIEWER_DISCONNECTED');return result;
    },
    release:(ref,options)=>request('selected_browser_release',{...identity(ref),controller_id:options.controller_id}),
    control:(ref,options)=>request('selected_browser_control',{...identity(ref),controller_id:options.controller_id,ordinal:options.ordinal,input:options.input}),
    live:async(ref,options)=>{if(!options.onMessage)return {contract_version:CONTRACT,available:true,transport:'neko',websocket_path:'/api/operational-projects/'+privateScope(ref).project_id+'/browser-agent-runs/'+ref.run_id+'/live'};return client.stream('selected_browser_live',{...identity(ref),viewer_id:options.viewer_id,controller_id:options.controller_id,manual_auth:options.manual_auth},options);},
    renew:ref=>request('selected_browser_renew',identity(ref)),
    async stop(ref){try{return await request('selected_browser_stop',{...identity(ref),reason:ref.reason==='CANCELLED_BY_PERSON'?'cancelled':ref.reason==='REQUESTED_RESULT_REPORTED'?'completed':'failed'});}finally{for(const pin of stagedUploads)if(pin.startsWith(ref.attempt_id+':'))stagedUploads.delete(pin);}},
  }:null;
  runs=createSelectedBrowserService({db,runner,model,artifacts:artifacts?.service,clock:()=>new Date(clock()),verifyControl,verifyElevation,verifyReceipt});
  const conversion=createBrowserConversionService({db,store,model,resolveAsset:artifacts?.service.resolveSourceAsset.bind(artifacts.service),sourceCapabilities:()=>artifacts?.service.sourceCapabilities()||{mime_types:[]},clock,isEnabled});
  const viewers=new Map();
  const viewerEnded=v=>{if(!v||[...viewers.values()].some(other=>other.run_id===v.run_id&&other.user_id===v.user_id&&other.session_id===v.session_id))return;
    void runs.viewerClosed?.(v.identity,{controller_id:v.user_id,session_id:v.session_id}).catch(()=>log({code:'CONTROL_VIEWER_CLEANUP_UNVERIFIED'}));};
  const assertLive=(...args)=>{if(!isEnabled())fail('BROWSER_RUN_DISABLED');return runs.assertLive(...args);};
  const currentViewer=v=>{if(!liveSession(v.actor))fail('LIVE_SESSION_ENDED');const permitted=assertLive(v.actor,v.project_id,v.run_id);if(!same(identity(permitted),v.identity))fail('LIVE_ATTEMPT_ENDED');};
  const live={
    assertLive,
    async openLive(actor,pid,id,options){const permitted=assertLive(actor,pid,id),viewer=randomUUID();let ended=false;const record={actor,identity:identity(permitted),user_id:actor.id,project_id:pid,run_id:id,session_id:actor.jti};
      const opened=await runs.live(actor,pid,id,{...options,viewer_id:actor.id,onMessage:message=>{if(ended)return;try{currentViewer(record);}catch{ended=true;live.closeLive(viewer);options.onClose?.('access_ended');return;}options.onMessage?.(toViewer(message));},onClose:reason=>{ended=true;const v=viewers.get(viewer);viewers.delete(viewer);viewerEnded(v);options.onClose?.(reason);}});
      if(ended){opened.close?.();fail('LIVE_OPENING_ENDED');}try{currentViewer(record);}catch(e){opened.close?.();throw e;}viewers.set(viewer,{...opened,...record});return {...opened,viewer};},
    sendLive(viewer,userId,message){const v=viewers.get(viewer);if(v?.user_id!==userId)return false;try{currentViewer(v);}catch{live.closeLive(viewer);return false;}const filtered=fromViewer(message);return filtered?v.send(filtered):false;},
    closeLive(viewer){const v=viewers.get(viewer);viewers.delete(viewer);v?.close();viewerEnded(v);},
  };
  const tick=async()=>{
    if(busy||closed)return;busy=true;
    try{
      await runs.sweep();
      if(!isEnabled()){for(const r of all("SELECT * FROM ops_selected_browser_runs WHERE state IN('running','paused','awaiting_approval','human_control')"))await runs.cancel(actorFor({run_id:r.id,attempt_id:r.attempt_id}),r.project_id,r.id,r.revision);return;}
      for(const r of all("SELECT * FROM ops_selected_browser_runs WHERE state IN('running','paused','awaiting_approval','human_control')")){
        try{
          const actor=actorFor({run_id:r.id,attempt_id:r.attempt_id});
          await runs.refresh(actor,r.project_id,r.id);
          const current=one('SELECT * FROM ops_selected_browser_runs WHERE id=?',r.id);
          if(['running','paused','awaiting_approval','human_control'].includes(current.state))await runner?.renew(identity({run_id:r.id,attempt_id:r.attempt_id,fence:current.fence,policy_sha256:r.configuration_sha256}));
          // Only an explicitly started/resumed running run advances. Startup
          // recovery has already fenced every previous process's active row.
          if(current.state==='running')void runs.pump(r.id).catch(e=>log({code:e?.code||'BROWSER_PUMP_REFUSED'}));
        }catch(e){log({code:e?.code||'BROWSER_MAINTENANCE_REFUSED'});}
      }
      await artifacts?.service.maintenance({apply:true});
    }finally{busy=false;}
  };
  return {runs,conversion,artifacts,live,execution:{configured:!!runner,reason},
    async startMaintenance(){await runs.recover();if(!closed&&!timer){timer=scheduleInterval(()=>tick().catch(()=>log({code:'BROWSER_MAINTENANCE_REFUSED'})),5000);timer.unref?.();}},
    async close(){closed=true;cancelInterval(timer);for(const id of viewers.keys())live.closeLive(id);await conversion.close();files?.close();}};
}
