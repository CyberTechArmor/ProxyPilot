import React from 'react';
import {createRoot} from 'react-dom/client';
import '../../src/index.css';
import {BrowserAgents} from '../../src/components/operational-projects/BrowserAgents';
import example from '../../src/components/operational-projects/browser-agent-example.json';
const projectId='11111111-1111-4111-8111-111111111111',configId='22222222-2222-4222-8222-222222222222',runId='33333333-3333-4333-8333-333333333333',attemptId='44444444-4444-4444-8444-444444444444',approvalId='55555555-5555-4555-8555-555555555555',guideId='66666666-6666-4666-8666-666666666666',sha='a'.repeat(64);
const project={id:projectId,revision:8,own_role:'owner',current_version:{id:guideId,content_hash:sha,version_number:1}};
let record={id:configId,project_id:projectId,revision:1,configuration:{...example,name:'Browser agent for an exact authenticated internal destination with a long reviewable name',work:{...example.work,guide_ref:{id:guideId,sha256:sha}}},configuration_sha256:sha,source_text:'  Original instructions — preserve these exact spaces and Unicode.\nReview the requested site.  ',source_sha256:sha};
const ready={contract_version:'selected-browser.v1',can_start:false,pins:{project_revision:8,configuration_revision:1,configuration_sha256:sha,guide_ref:{id:guideId,sha256:sha}},checks:[{kind:'runtime',state:'blocked',code:'INSTALLED_SELECTED_BROWSER_PROOF_REQUIRED'},{kind:'owner_consent',state:'blocked',code:'OWNER_MODEL_CONSENT_REQUIRED'}]};
const mode=new URLSearchParams(location.search),assetId='77777777-7777-4777-8777-777777777777',privateText='Synthetic private review text.',privateBytes=new TextEncoder().encode(privateText),privateSha=[...new Uint8Array(await crypto.subtle.digest('SHA-256',privateBytes))].map(n=>n.toString(16).padStart(2,'0')).join('');
let asset={id:assetId,project_id:projectId,state:'staged',kind:'asset',sha256:privateSha,mime_type:'text/plain',byte_count:privateBytes.length,available:true,reviews:[]};
let detail={run:{id:runId,project_id:projectId,configuration_id:configId,revision:4,state:'awaiting_approval',attempt_id:attemptId,fence:1,policy_sha256:sha,budgets:example.budgets,usage:{actions:3,model_calls:1,tokens:1400,usd:0.005,requests:5,response_bytes:19000,artifact_bytes:0},manual_auth:false,controller_user_id:null,uncertain:false},controls:{can_pause:false,can_resume:false,can_cancel:true,can_takeover:true,can_release:false,can_approve:true,live_available:false,can_clipboard:false},pending_approvals:[{id:approvalId,kind:'off_list_destination',state:'pending',action_sha256:sha,snapshot_ref:{id:guideId,sha256:sha},origin:'https://login.selected-long-domain.example:8443',purpose:'Sign in at the exact selected authentication service before returning to the original website',expires_at:'2099-10-02T23:00:00Z',no_contact:true}],receipts:[],report:{summary:'Fixture report: observations are test data. The actual external outcome is not verified.',citations:[{title:'Original public source',url:'https://example.com/'}],uncertainty:'The installed runner is unavailable.'}};
if(mode.get('approval')==='input')detail.pending_approvals=[{...detail.pending_approvals[0],kind:'input_draft',artifact_ref:{id:assetId,sha256:privateSha,mime_type:'text/plain',byte_count:privateBytes.length},target_ref:{id:guideId,sha256:sha},action_kind:'type',destination:'https://selected.example',url_sha256:sha}];
if(mode.get('transport')==='live'){detail.controls.live_available=true;window.fixtureLiveConnections=0;window.WebSocket=class{constructor(url){window.fixtureLiveConnections++;window.fixtureLiveUrl=url;this.readyState=1;setTimeout(()=>this.onmessage?.({data:JSON.stringify({type:'unavailable',code:'FIXTURE_NO_LIVE_SITE'})}),0);}send(){}close(){this.readyState=3;}};}
window.browserFixtureRequests=[];window.browserFixtureSource=record.source_text;window.browserFixtureRecord=()=>record;window.browserFixtureRejectNext=null;
window.fetch=async(url,options={})=>{
  const path=String(url).replace(`/api/operational-projects/${projectId}`,''),method=options.method||'GET',body=options.body?JSON.parse(options.body):null;
  window.browserFixtureRequests.push({path,method,body,headers:options.headers});
  if(!String(url).startsWith(`/api/operational-projects/${projectId}`))throw new Error('Fixture forbids external contact');
  if(window.browserFixtureRejectNext&&method!=='GET') {const reject=window.browserFixtureRejectNext;window.browserFixtureRejectNext=null;return new Response(JSON.stringify(reject.body),{status:reject.status,headers:{'Content-Type':'application/json'}});}
  let result={},status=200;
  if(path==='/browser-agent-configurations'&&method==='GET')result={configurations:[{id:configId,name:record.configuration.name,revision:record.revision}],next_cursor:null};
  else if(path==='/browser-agent-runs')result={runs:[detail.run]};
  else if(path===`/browser-agent-configurations/${configId}`&&method==='GET')result={configuration:record,readiness:ready};
  else if(path===`/browser-agent-configurations/${configId}/readiness`)result={readiness:{...ready,pins:{...ready.pins,configuration_revision:record.revision}}};
  else if(path==='/browser-agent-configurations/validate')result={valid:true,persisted:false,readiness:ready};
  else if(path===`/browser-agent-configurations/${configId}`&&method==='PATCH'){record={...record,configuration:body.configuration,source_text:body.source_text??record.source_text,revision:record.revision+1};result={configuration:record,readiness:ready};}
  else if(path===`/browser-agent-runs/${runId}`)result=detail;
  else if(path===`/browser-agent-runs/${runId}/sources`)result={sources:[{id:assetId,state:'available',artifact_ref:{id:assetId,sha256:privateSha,mime_type:'text/plain',byte_count:privateBytes.length},content_sha256:privateSha,snapshot_ref:{id:guideId,sha256:sha},configuration_sha256:sha,guide_sha256:sha,consent_sha256:sha,origin:'https://selected.example',url_sha256:sha,captured_at:'2026-10-02T20:00:00Z',original_bytes:10000,truncated:true,chunker_version:'browser-text.v1',disclosed_call_ids:[guideId]}]};
  else if(path===`/browser-agent-runs/${runId}/approvals/${approvalId}/decision`){detail={...detail,pending_approvals:[],run:{...detail.run,revision:5,state:'paused'},controls:{...detail.controls,can_resume:true,can_approve:false}};result=detail;}
  else if(path==='/browser-assets')result={assets:mode.get('private')==='1'?[asset]:[],next_cursor:null};
  else if(path.startsWith(`/browser-assets/${assetId}/content?`)||path.startsWith(`/browser-agent-runs/${runId}/artifacts/${assetId}/content?`))return new Response(privateBytes,{headers:{'Content-Type':'text/plain'}});
  else if(path===`/browser-assets/${assetId}/review`&&method==='PATCH'){asset={...asset,state:body.decision==='approve'?'approved':'rejected',reviews:[...asset.reviews,{purpose:'asset_use',decision:body.decision,sha256:privateSha}]};result={artifact:asset};}
  else if(path===`/browser-assets/${assetId}/model-review`&&method==='POST'){asset={...asset,reviews:[...asset.reviews,{purpose:'model_input',decision:body.decision,sha256:privateSha}]};result={artifact:asset};}
  else if(path==='/browser-agent-configurations/convert/readiness')result={available:true};
  else if(path==='/browser-agent-configurations/convert')result={conversion:{id:guideId,state:'completed',source_text:record.source_text,result:{configuration:{...record.configuration,name:'Converted editable suggestion'},assumptions:['Check exact destinations'],warnings:['No action executed'],ambiguities:[{field:'entry_urls',question:'Confirm the first page'}],provenance:{source_sha256:sha},requires_review:true,persisted:false,execution_enabled:false}}};
  else if(path.endsWith('/model-consent')&&method==='PUT')result={allowed:body.allow};
  else if(path.endsWith('/resume')){detail={...detail,run:{...detail.run,state:'running',revision:6},controls:{...detail.controls,can_resume:false,can_pause:true}};result=detail;}
  else {status=404;result={error:{code:'FIXTURE_PATH_UNAVAILABLE',message:`Unsupported fixture request: ${method} ${path}`}};}
  return new Response(JSON.stringify(result),{status,headers:{'Content-Type':'application/json'}});
};
createRoot(document.getElementById('root')).render(<main className="operations-ui mx-auto w-full max-w-screen-xl p-4 space-y-4"><h1 className="text-2xl font-semibold">Browser agent verification</h1><BrowserAgents base={`/${projectId}`} project={project}/></main>);
