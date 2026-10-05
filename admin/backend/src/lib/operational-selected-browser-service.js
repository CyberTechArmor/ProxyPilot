import { randomUUID } from 'node:crypto';
import {isPublicNavigation,publicNavigationConfiguration,publicNavigationInput} from './operational-public-navigation.js';
import { z } from 'zod';
import { assertEligible, assertOperation, assertRevision, resolveOperationsRole, validId } from './operational-projects-logic.js';
import { browserDraftHash, canonicalBrowserDraft, validateBrowserDraftImport } from './operational-browser-agent-proposal.js';
import { browserModelRequestDigest } from './operational-browser-model.js';
import { SELECTED_BROWSER_AUTH_STATEMENT, selectedAuthInventorySchema, selectedAuthConfirmationInputSchema,
  selectedAuthConfirmationPacketSchema, selectedAuthConfirmationAckSchema, selectedAuthDigest,
  selectedAuthInventoryDigest } from './operational-selected-browser-auth-contract.js';
import { SELECTED_BROWSER_CONTRACT, selectedActionSchema, selectedConsentSchema, selectedDecisionSchema,
  selectedEscalationSchema, selectedNetworkRequestSchema, selectedFinalNetworkSchema, selectedHumanInputSchema, selectedInputDraftSchema, selectedCandidateSchema, selectedFail as fail, selectedObservationSchema, selectedParse as parse,
  selectedReconcileSchema, selectedStartSchema, selectedUsageSchema } from './operational-selected-browser-contract.js';

const ACTIVE=new Set(['preparing','running','paused','awaiting_approval','human_control','stopping']);
const TERMINAL=new Set(['completed','cancelled','failed','uncertain']);
// Persist only fixed refusal codes. Messages, details and stacks may contain
// credentials or host facts and must never enter a browser run record.
const LAUNCH_FAILURE_CODES=new Set(["ACTIVE_ATTEMPT","ATTEMPT_EXISTS","BOUNDARY_UNVERIFIED","BROWSER_CHROMIUM_POLICY_UNVERIFIED","BROWSER_GATEWAY_HELPER_UNVERIFIED","BROWSER_GATEWAY_UNAVAILABLE_OR_ACTIVE","BROWSER_GUIDE_PIN_MISMATCH","BROWSER_INSTALLED_ACCEPTANCE_STALE","BROWSER_INSTALLED_ACCEPTANCE_UNVERIFIED","BROWSER_INSTALLED_HELPER_CHANGED","BROWSER_LAUNCH_FAILED","BROWSER_LAUNCH_PINS_STALE","BROWSER_LAUNCH_UNVERIFIED","BROWSER_LIVE_INSTALL_UNVERIFIED","BROWSER_POLICY_HASH_MISMATCH","BROWSER_POLICY_NONCANONICAL","BROWSER_PROTECTED_INVENTORY_INVALID","BROWSER_PROTECTED_INVENTORY_REQUIRED","BROWSER_RUNTIME_UNAVAILABLE","BROWSER_RUN_DISABLED","BROWSER_START_FAILED","DEADLINE","DNS_ADDRESS_CHANGED","DNS_LOOKUP_CAPACITY","DNS_LOOKUP_TIMEOUT","DNS_LOOKUP_UNVERIFIED","INTERNAL","INTERNAL_EXACT_POLICY_REQUIRED","INTERNAL_EXACT_POLICY_STALE","INVALID_REQUEST","LAUNCH_IDENTITY_MISMATCH","NETWORK_ROUTE_UNVERIFIED","PROJECT_LIMIT_BELOW_WORKER_MINIMUM","PROTECTED_DESTINATION","PUBLIC_MODEL_PINS_DISABLED","SUPERVISOR_PROTOCOL","SUPERVISOR_TIMEOUT","SUPERVISOR_UNREACHABLE","TEMPORARY_DISK_EXCEEDS_WORKER_MEMORY","VM_CAPACITY_INSUFFICIENT"]);
const launchFailureCode=code=>LAUNCH_FAILURE_CODES.has(code)?code:'BROWSER_LAUNCH_FAILED';
const emptyUsage=()=>({actions:0,model_calls:0,tokens:0,usd:0,requests:0,response_bytes:0,artifact_bytes:0});
const hash=value=>browserDraftHash(canonicalBrowserDraft(value));
const boundedText=(value,max)=>{let text=value;while(Buffer.byteLength(text)>max)text=text.slice(0,Math.max(0,text.length-Math.ceil((Buffer.byteLength(text)-max)/4)));if(text.length&&/[\uD800-\uDBFF]/.test(text.at(-1)))text=text.slice(0,-1);return text;};
const publicNavigationEvidenceSchema=z.object({
  completed_redirects:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  cross_origin_resources:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  last_completed_document_origin:z.string().min(8).max(300).refine(value=>{try{const u=new URL(value);return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password&&u.origin===value;}catch{return false;}}).nullable(),
  last_completed_document_url_sha256:z.string().regex(/^[a-f0-9]{64}$/).nullable(),
}).strict().refine(value=>(value.last_completed_document_origin===null)===(value.last_completed_document_url_sha256===null));
const receiptSchema=z.object({contract_version:z.literal(SELECTED_BROWSER_CONTRACT),run_id:z.string().uuid(),attempt_id:z.string().uuid(),fence:z.number().int().positive(),policy_sha256:z.string().regex(/^[a-f0-9]{64}$/),closed:z.object({browser:z.boolean(),network:z.boolean(),session:z.boolean(),temporary_files:z.boolean()}).strict(),final_network:selectedFinalNetworkSchema,public_navigation_evidence:publicNavigationEvidenceSchema.optional(),attestation:z.string().min(1).max(16000)}).strict().refine(value=>!value.public_navigation_evidence||['completed_redirects','cross_origin_resources'].every(k=>value.public_navigation_evidence[k]<=value.final_network.requests));
const verifiedClosure=receipt=>!!receipt&&Object.values(receipt.closed).every(value=>value===true);
const resultSchema=z.object({kind:z.literal('done'),facts:z.array(z.object({code:z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),source_ref:z.object({id:z.string().uuid(),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict().nullable()}).strict()).max(64).default([]),usage:z.object({requests:z.number().int().nonnegative(),response_bytes:z.number().int().nonnegative(),artifact_bytes:z.number().int().nonnegative()}).strict(),usage_mode:z.enum(['delta','cumulative']).default('delta')}).strict();
const inputPinSchema=z.object({id:z.string().uuid(),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
const inputApprovalManifestSchema=z.object({artifact_ref:inputPinSchema.extend({mime_type:z.literal('text/plain'),byte_count:z.number().int().positive().max(12000)}).strict(),target_ref:inputPinSchema,snapshot_ref:inputPinSchema,purpose:z.string().trim().min(1).max(500),approval_ref:inputPinSchema}).strict();
const attemptScopeSchema=z.object({project_id:z.string().uuid(),run_id:z.string().uuid(),attempt_id:z.string().uuid(),fence:z.number().int().positive()}).strict();
const safeCount=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const networkMeters=z.object({requests:safeCount,response_bytes:safeCount}).strict();
const pendingSchema=z.object({pending:z.array(z.unknown()).max(64),cumulativeusage:networkMeters,usage:networkMeters.optional(),
  inflight:safeCount,effects_sent:safeCount,effects_uncertain:safeCount,auth_effects_acknowledged:safeCount,
  mode:z.enum(['agent','human','paused']).optional(),code:z.string().max(128).nullable().optional()}).strict();
export function normalizeSelectedBrowserPending(input){
  const parsed=pendingSchema.safeParse(input);if(!parsed.success)fail(502,'NETWORK_PENDING_INVALID');
  const p=parsed.data;if(p.usage&&hash(p.usage)!==hash(p.cumulativeusage)||p.auth_effects_acknowledged>p.effects_sent)fail(502,'NETWORK_PENDING_INVALID');
  return {...p,inflight_action:p.inflight>0};
}
const denialSchema=z.object({run_id:z.string().uuid(),attempt_id:z.string().uuid(),fence:z.number().int().positive(),policy_sha256:z.string().regex(/^[a-f0-9]{64}$/),request_ref:z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),denied:z.literal(true),no_contact:z.literal(true),paused:z.boolean(),state:z.enum(['paused','human_control']),manual_auth:z.boolean(),attestation:z.string().min(1).max(16000)}).strict();

// Registration-neutral, dependency injected, no browser/net/host/vault imports.
// Installed supervisor/isolation proofs are required. A local runner is never
// constructed here. All authority and reservations are committed before effects.
export function createSelectedBrowserService({db,runner=null,model=null,artifacts=null,clock=()=>new Date(),uuid=randomUUID,
  verifyControl=()=>false,verifyElevation=()=>false,verifyReceipt=()=>false,verifyScheduledAuthority=()=>false}={}) {
  if(!db)throw new Error('Selected-browser database required');
  const one=(sql,...args)=>db.prepare(sql).get(...args),all=(sql,...args)=>db.prepare(sql).all(...args),write=(sql,...args)=>db.prepare(sql).run(...args);
  const stamp=()=>clock().toISOString(),stops=new Map(),pumps=new Map(),aborters=new Map();
  const tx=fn=>{if(typeof db.transaction==='function')return db.transaction(fn).immediate();if(db.inTransaction===true||db.isTransaction===true)return fn();db.exec('BEGIN IMMEDIATE');try{const v=fn();db.exec('COMMIT');return v;}catch(e){db.exec('ROLLBACK');throw e;}};
  function access(actor,projectId,operation='read'){
    const u=one('SELECT id,role FROM users WHERE id=?',actor?.id??'');assertEligible(actor,u);
    if(actor.mcp===true||actor.human===false)fail(403,'HUMAN_SESSION_REQUIRED');
    if(!validId(projectId))fail(404,'SELECTED_BROWSER_NOT_FOUND');
    const p=one('SELECT * FROM ops_projects WHERE id=?',projectId);
    const role=resolveOperationsRole(p,actor.id,p&&one('SELECT role FROM ops_project_grants WHERE project_id=? AND user_id=?',projectId,actor.id));
    assertOperation(role,operation,!!p?.archived_at);return {p,role};
  }
  function control(actor,{elevation=true}={}){
    if(verifyControl(actor)!==true)fail(403,'AGENT_CONTROL_VERIFICATION_REQUIRED');
    if(elevation&&verifyElevation(actor)!==true)fail(403,'ELEVATION_REQUIRED');
  }
  const currentGuide=projectId=>one(`SELECT v.id,v.content_hash,w.created_at AS withdrawn_at FROM ops_guide_versions v
    LEFT JOIN ops_version_withdrawals w ON w.version_id=v.id WHERE v.project_id=? ORDER BY v.version_number DESC LIMIT 1`,projectId);
  function configuration(projectId,id){
    const r=validId(id)&&one('SELECT * FROM ops_browser_agent_configurations WHERE project_id=? AND id=?',projectId,id);
    if(!r)fail(404,'SELECTED_BROWSER_NOT_FOUND');
    const v=validateBrowserDraftImport({configuration:JSON.parse(r.configuration_json)});
    if(v.configuration_sha256!==r.configuration_sha256)fail(409,'CONFIGURATION_INTEGRITY_FAILED');
    return {...r,configuration:v.configuration};
  }
  const runRow=(projectId,id)=>{const r=validId(id)&&one('SELECT * FROM ops_selected_browser_runs WHERE project_id=? AND id=?',projectId,id);if(!r)fail(404,'SELECTED_BROWSER_NOT_FOUND');return r;};
  const ownsController=(r,actor)=>r.controller_user_id===actor.id&&(!r.controller_session_id||r.controller_session_id===actor.jti);
  const identity=r=>({run_id:r.id,attempt_id:r.attempt_id,fence:r.fence,policy_sha256:r.configuration_sha256});
  const ownsAuthenticationViewer=(r,actor)=>typeof runner?.assertAuthenticationController==='function'&&runner.assertAuthenticationController(identity(r),{controller_id:actor.id,session_id:actor.jti})===true;
  // This workflow has one immutable attempt launched at fence 1. Terminal
  // fencing advances execution authority, never the original receipt scope.
  const confirmedAuthCount=(r,{original=false}={})=>one('SELECT COUNT(*) AS n FROM ops_selected_browser_auth_confirmed_requests WHERE run_id=? AND attempt_id=? AND fence=?',r.id,r.attempt_id,original?1:r.fence).n;
  const hasUnconfirmedEffects=r=>{const n=JSON.parse(r.network_state_json);return n.effects_sent>(n.auth_effects_acknowledged??0)||n.effects_uncertain>0;};
  const event=(r,kind,metadata={},actor=null)=>write('INSERT INTO ops_selected_browser_events(project_id,run_id,attempt_id,actor_id,kind,metadata_json,created_at) VALUES(?,?,?,?,?,?,?)',r.project_id,r.id,r.attempt_id,actor?.id??null,kind,JSON.stringify(metadata),stamp());
  function sourceRecords(r){return all('SELECT * FROM ops_selected_browser_sources WHERE run_id=? ORDER BY captured_at,id',r.id).map(s=>({id:s.id,snapshot_ref:JSON.parse(s.snapshot_ref_json),artifact_ref:JSON.parse(s.artifact_ref_json),content_sha256:s.content_sha256,configuration_sha256:s.configuration_sha256,guide_sha256:s.guide_sha256,consent_sha256:s.consent_sha256,origin:s.origin,url_sha256:s.url_sha256,captured_at:s.captured_at,worker_contract:s.worker_contract,chunker_version:s.chunker_version,original_bytes:s.original_bytes,truncated:s.truncated===1,disclosed_call_ids:JSON.parse(s.disclosed_calls_json)}));}
  function verifyObservationOrigin(actor,scope,origin){try{authorizeAttempt(actor,scope,'artifact_capture');const r=runRow(scope.project_id,scope.run_id),c=JSON.parse(r.configuration_json);return c.destinations.allowed_origins.some(d=>d.origin===origin&&d.roles.includes('navigation'))||!!one("SELECT 1 FROM ops_selected_browser_destination_grants WHERE run_id=? AND attempt_id=? AND fence=? AND origin=? AND json_extract(grant_json,'$.role')='navigation' AND consumed_at IS NOT NULL AND expires_at>?",r.id,r.attempt_id,r.fence,origin,stamp());}catch{return false;}}
  async function captureObservation(r,observation){
    if(r.execution_mode==='public_navigation'||!observation.observation.trim()||typeof artifacts?.stageObservation!=='function')return null;
    const previous=one('SELECT * FROM ops_selected_browser_sources WHERE run_id=? AND snapshot_ref_json=?',r.id,canonicalBrowserDraft(observation.snapshot_ref));if(previous)return JSON.parse(previous.artifact_ref_json);
    const text=boundedText(observation.observation,4000),scope={project_id:r.project_id,run_id:r.id,attempt_id:r.attempt_id,fence:r.fence};
    const captured=await artifacts.stageObservation({id:r.started_by},scope,{snapshot_ref:observation.snapshot_ref,text,origin:observation.page?.origin??null,url_sha256:observation.page?.url_sha256??null,chunker_version:'browser-text.v1'});
    const ref=captured.artifact_ref??captured.ref??captured,parsed=z.object({id:z.string().uuid(),sha256:z.string().regex(/^[a-f0-9]{64}$/),mime_type:z.literal('text/plain'),byte_count:z.number().int().positive().max(4000)}).strict().safeParse(ref);if(!parsed.success||ref.sha256!==browserDraftHash(text)||ref.byte_count!==Buffer.byteLength(text))fail(502,'OBSERVATION_CONTENT_PIN_MISMATCH');
    tx(()=>{const current=runRow(r.project_id,r.id);if(current.fence!==r.fence||current.state!=='running'||current.manual_auth)fail(409,'OBSERVATION_CAPTURE_FENCED');livePins(current);write('INSERT INTO ops_selected_browser_sources(id,run_id,attempt_id,fence,snapshot_ref_json,artifact_ref_json,content_sha256,configuration_sha256,guide_sha256,consent_sha256,origin,url_sha256,captured_at,worker_contract,chunker_version,original_bytes,truncated) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',ref.id,r.id,r.attempt_id,r.fence,canonicalBrowserDraft(observation.snapshot_ref),canonicalBrowserDraft(ref),ref.sha256,r.configuration_sha256,r.guide_sha256,r.consent_sha256,observation.page?.origin??null,observation.page?.url_sha256??null,stamp(),SELECTED_BROWSER_CONTRACT,'browser-text.v1',Buffer.byteLength(observation.observation),Buffer.byteLength(text)<Buffer.byteLength(observation.observation)?1:0);const usage=JSON.parse(current.usage_json);usage.artifact_bytes+=ref.byte_count;if(usage.artifact_bytes>JSON.parse(current.configuration_json).budgets.max_artifact_bytes)fail(409,'ARTIFACT_BUDGET_EXHAUSTED');mutate(current,current.state,{usage_json:JSON.stringify(usage)});event(current,'PRIVATE_PAGE_SOURCE_CAPTURED',{source_id:ref.id,content_sha256:ref.sha256,snapshot_ref:observation.snapshot_ref,chunker_version:'browser-text.v1'});});return ref;
  }
  function mutate(r,state,fields={}){
    const allowed=new Set(['manual_auth','controller_user_id','controller_session_id','ended_at','result_code','report_json','usage_json','network_state_json','ordinal','fence']);
    if(Object.keys(fields).some(k=>!allowed.has(k)))throw new Error('Invalid lifecycle field');
    write(`UPDATE ops_selected_browser_runs SET state=?,revision=revision+1${Object.keys(fields).map(k=>`,${k}=?`).join('')} WHERE id=?`,state,...Object.values(fields),r.id);
    return runRow(r.project_id,r.id);
  }
  function limitsCheck(p,c){
    const caps=JSON.parse(p.agent_limits_json),keys=['cpu','memory_mib','temporary_disk_mib','max_seconds','max_actions','max_tokens','max_usd'];
    return keys.every(k=>caps[k]===undefined||(Number.isFinite(caps[k])&&caps[k]>0&&c.budgets[k]<=caps[k]))&&c.budgets.cpu>=1&&c.budgets.memory_mib>=1024&&c.budgets.temporary_disk_mib>=64;
  }
  function consentRow(p,c){const s=one('SELECT * FROM ops_selected_browser_consents WHERE configuration_id=?',c.id);const g=currentGuide(p.id);
    return s?.allowed===1&&s.owner_user_id===p.owner_user_id&&s.configuration_revision===c.revision&&s.configuration_sha256===c.configuration_sha256&&g&&!g.withdrawn_at&&s.guide_id===g.id&&s.guide_sha256===g.content_hash?s:null;}
  function validGuide(p,c){const g=currentGuide(p.id),ref=c.configuration.work.guide_ref;return !!(g&&!g.withdrawn_at&&ref&&ref.id===g.id&&ref.sha256===g.content_hash);}
  function livePins(r){
    if(r.schedule_occurrence_id&&verifyScheduledAuthority({id:r.started_by,human:true,schedule_occurrence_id:r.schedule_occurrence_id},r.project_id,r.configuration_id)!==true)fail(403,'SCHEDULE_AUTHORIZATION_REVOKED');
    if(r.starter_session_id){const session=one('SELECT user_id,expires_at,revoked_at FROM sessions WHERE id=?',r.starter_session_id);if(!session||session.user_id!==r.started_by||session.revoked_at||session.expires_at<=stamp())fail(403,'STARTER_SESSION_REVOKED');}
    if(r.controller_user_id){access({id:r.controller_user_id},r.project_id,'run');if(r.controller_session_id){const controllerSession=one('SELECT user_id,expires_at,revoked_at FROM sessions WHERE id=?',r.controller_session_id);if(!controllerSession||controllerSession.user_id!==r.controller_user_id||controllerSession.revoked_at||controllerSession.expires_at<=stamp())fail(403,'CONTROLLER_SESSION_REVOKED');}}
    const {p}=access({id:r.started_by},r.project_id,'run'),c=configuration(r.project_id,r.configuration_id);
    const publicMode=isPublicNavigation(c.configuration);
    if((r.execution_mode??'agent')!==(publicMode?'public_navigation':'agent'))fail(409,'SELECTED_BROWSER_MODE_STALE');
    if(p.owner_user_id!==r.owner_user_id||p.agent_limits_revision!==r.project_limits_revision||!limitsCheck(p,c.configuration)||(!publicMode&&!validGuide(p,c))||c.revision!==r.configuration_revision||c.configuration_sha256!==r.configuration_sha256||(!publicMode&&consentRow(p,c)?.consent_sha256!==r.consent_sha256))fail(409,'SELECTED_BROWSER_PINS_STALE');
    if(stamp()>=r.deadline_at)fail(409,'SELECTED_BROWSER_DEADLINE');return {p,c};
  }
  function reportProjection(actor,r){
    if(!r.report_json)return {report:null,report_visibility:'absent',report_code:null};
    if(r.state!=='completed')return {report:null,report_visibility:'withheld',report_code:'REPORT_RUN_NOT_COMPLETED'};
    try{
      const p=one('SELECT * FROM ops_projects WHERE id=?',r.project_id),g=currentGuide(r.project_id),s=one('SELECT * FROM ops_selected_browser_consents WHERE configuration_id=?',r.configuration_id),report=JSON.parse(r.report_json),reportConfiguration=JSON.parse(r.configuration_json);
      if(!g||g.withdrawn_at||g.id!==r.guide_id||g.content_hash!==r.guide_sha256||s?.allowed!==1||s.owner_user_id!==p.owner_user_id||s.consent_sha256!==r.consent_sha256||!Array.isArray(report.evidence_refs)||!report.evidence_refs.length)throw new Error('Evidence unavailable');
      const current=configuration(r.project_id,r.configuration_id);if(consentRow(p,current)?.consent_sha256!==r.consent_sha256)throw new Error('Evidence unavailable');
      if(reportConfiguration.work.source_inputs.length&&(typeof artifacts?.validateInputs!=='function'||artifacts.validateInputs(actor,{project_id:r.project_id,configuration:{...reportConfiguration,artifacts:{...reportConfiguration.artifacts,upload_asset_refs:[]}}})!==true))throw new Error('Evidence unavailable');
      const pages=sourceRecords(r),refs=report.evidence_refs.filter(ref=>pages.some(page=>page.id===ref.id));
      if(refs.length){if(typeof artifacts?.observationStatus!=='function')throw new Error('Evidence unavailable');const status=artifacts.observationStatus(actor,{project_id:r.project_id,run_id:r.id,attempt_id:r.attempt_id,fence:1},refs);if(!Array.isArray(status)||status.length!==refs.length||status.some(item=>item.state!=='available'))throw new Error('Evidence unavailable');}
      if(report.evidence_refs.some(ref=>!pages.some(page=>page.id===ref.id)&&!reportConfiguration.work.source_inputs.some(source=>source.id===ref.id&&source.sha256===ref.sha256)))throw new Error('Evidence unavailable');
      return {report,report_visibility:'available',report_code:null};
    }catch{return {report:null,report_visibility:'withheld',report_code:'REPORT_EVIDENCE_UNAVAILABLE'};}
  }
  function dto(actor,r){
    const {role}=access(actor,r.project_id),canRun=['owner','operator','editor','reviewer'].includes(role),active=ACTIVE.has(r.state),c=JSON.parse(r.configuration_json),network=JSON.parse(r.network_state_json);
    const approvals=all("SELECT * FROM ops_selected_browser_approvals WHERE run_id=? AND state='pending' ORDER BY created_at",r.id).map(a=>({id:a.id,kind:a.kind,state:a.state,action_sha256:a.action_sha256,expires_at:a.expires_at,...JSON.parse(a.payload_json)}));
    const receipts=all('SELECT cleanup_json FROM ops_selected_browser_attempts WHERE run_id=? AND cleanup_json IS NOT NULL',r.id).map(a=>JSON.parse(a.cleanup_json));
    const launchFailure=r.execution_mode==='public_navigation'&&r.result_code==='LAUNCH_UNCERTAIN'?one("SELECT json_extract(metadata_json,'$.code') AS code FROM ops_selected_browser_events WHERE run_id=? AND attempt_id=? AND kind='LAUNCH_REFUSED' LIMIT 1",r.id,r.attempt_id):null;
    return {contract_version:SELECTED_BROWSER_CONTRACT,activity:all('SELECT id,kind,created_at FROM ops_selected_browser_events WHERE run_id=? ORDER BY id DESC LIMIT 100',r.id).reverse(),authorization:{elevated:verifyElevation(actor)===true,control_verified:verifyControl(actor)===true},run:{id:r.id,project_id:r.project_id,configuration_id:r.configuration_id,configuration_name:c.name,revision:r.revision,state:r.state,attempt_id:r.attempt_id,fence:r.fence,artifact_fence:1,policy_sha256:r.configuration_sha256,configuration_revision:r.configuration_revision,execution_mode:r.execution_mode??'agent',started_by:r.started_by,started_at:r.started_at,deadline_at:r.deadline_at,ended_at:r.ended_at,result_code:r.result_code,launch_failure_code:launchFailure?launchFailureCode(launchFailure.code):null,budgets:c.budgets,usage:JSON.parse(r.usage_json),manual_auth:r.manual_auth===1,controller_user_id:r.controller_user_id,uncertain:!!one("SELECT 1 FROM ops_selected_browser_uncertainties WHERE run_id=? AND state='unresolved'",r.id)},controls:{can_start:false,can_pause:canRun&&r.state==='running',can_resume:canRun&&r.state==='paused',can_cancel:canRun&&active,can_takeover:!isPublicNavigation(c)&&canRun&&['running','paused','awaiting_approval'].includes(r.state),can_release:canRun&&r.state==='human_control'&&ownsController(r,actor)&&!hasUnconfirmedEffects(r)&&!network.inflight_action&&!network.pending_count,can_confirm_authentication:canRun&&r.state==='human_control'&&r.manual_auth===1&&ownsController(r,actor)&&!!r.controller_session_id&&hasUnconfirmedEffects(r)&&ownsAuthenticationViewer(r,actor)&&typeof runner?.authenticationInventory==='function'&&typeof runner?.confirmAuthentication==='function',can_approve:canRun&&approvals.length>0&&(!r.manual_auth||ownsController(r,actor)),live_available:typeof runner?.live==='function'&&active&&(r.manual_auth===0||ownsController(r,actor)),can_live:typeof runner?.live==='function'&&active&&(r.manual_auth===0||ownsController(r,actor)),can_clipboard:!isPublicNavigation(c)&&canRun&&active&&(!r.manual_auth||ownsController(r,actor))},authentication_receipts:all('SELECT id,state,acknowledged_count,request_sha256,inventory_sha256,created_at,accepted_at FROM ops_selected_browser_auth_confirmations WHERE run_id=? ORDER BY created_at,id',r.id),pending_approvals:approvals,escalations:approvals.filter(a=>a.kind==='off_list_destination'),receipts,sources:sourceRecords(r),uncertainties:all('SELECT id,kind,state,decision,created_at FROM ops_selected_browser_uncertainties WHERE run_id=? ORDER BY created_at',r.id),...reportProjection(actor,r)};
  }
  async function readiness(actor,projectId,configId){
    const {p}=access(actor,projectId,'run'),c=configuration(projectId,configId),publicMode=isPublicNavigation(c.configuration);
    let status=null;try{status=await runner?.readiness?.({project_id:projectId,configuration_id:c.id,configuration_revision:c.revision,configuration_sha256:c.configuration_sha256,configuration:c.configuration,policy_sha256:c.configuration_sha256});}catch{/* unavailable is explicit */}
    const runtime=!!(status?.contract_version===SELECTED_BROWSER_CONTRACT&&status.policy_sha256===c.configuration_sha256&&status.available===true&&status.verified_supervisor===true&&status.verified_isolation===true&&status.verified_destinations===true&&status.verified_site_policy===true&&typeof status.supervisor_version==='string'&&status.supervisor_version.length&&['launch','observe','execute','pollAction','pending','pause','resume','stop','takeover','assertTakeover','release'].every(k=>typeof runner?.[k]==='function'));
    const assets=[...c.configuration.work.source_inputs,...c.configuration.artifacts.upload_asset_refs];let inputsReady=!assets.length;
    if(assets.length&&artifacts?.validateInputs){try{inputsReady=await artifacts.validateInputs(actor,{project_id:projectId,configuration:c.configuration})===true;}catch{/* unresolved pins */}}
    let modelReady=publicMode;try{if(!publicMode)modelReady=typeof model?.decide==='function'&&typeof model?.quote==='function'&&(await model.readiness?.())?.available===true;}catch{/* provider route stays blocked */}
    const checks=[['runtime',runtime,publicMode&&status?.code||'INSTALLED_SELECTED_BROWSER_PROOF_REQUIRED'],['source_memory',publicMode||typeof artifacts?.stageObservation==='function'&&typeof artifacts?.observationInputs==='function'&&typeof artifacts?.observationStatus==='function','PRIVATE_SOURCE_MEMORY_UNAVAILABLE'],['guide',publicMode||validGuide(p,c),'CURRENT_APPROVED_GUIDE_REQUIRED'],['owner_consent',publicMode||!!consentRow(p,c),'OWNER_MODEL_CONSENT_REQUIRED'],['project_limits',limitsCheck(p,c.configuration),'PROJECT_LIMITS_REQUIRED'],['inputs',inputsReady,'PRIVATE_INPUT_PINS_UNRESOLVED'],['uncertainty',!one("SELECT 1 FROM ops_selected_browser_uncertainties u JOIN ops_selected_browser_runs r ON r.id=u.run_id WHERE r.configuration_id=? AND u.state='unresolved'",configId),'UNRESOLVED_EFFECT'],['active_attempt',!one("SELECT 1 FROM ops_selected_browser_runs WHERE configuration_id=? AND state IN('preparing','running','paused','awaiting_approval','human_control','stopping')",configId),'ATTEMPT_ALREADY_ACTIVE'],['model',modelReady,'MODEL_ROUTE_UNAVAILABLE']].map(([kind,ok,code])=>({kind,state:ok?'ready':'blocked',code:ok?(publicMode&&['source_memory','guide','owner_consent','model'].includes(kind)?'NOT_REQUIRED':'READY'):code}));
    return {contract_version:SELECTED_BROWSER_CONTRACT,model_consent:{allowed:!!consentRow(p,c),configuration_revision:c.revision,configuration_sha256:c.configuration_sha256},can_start:checks.every(c=>c.state==='ready'),state:checks.every(c=>c.state==='ready')?'ready':'blocked',pins:{project_revision:p.revision,configuration_revision:c.revision,configuration_sha256:c.configuration_sha256,guide_ref:c.configuration.work.guide_ref},checks};
  }
  function consent(actor,projectId,configId,input){const v=parse(selectedConsentSchema,input);return tx(()=>{const {p,role}=access(actor,projectId,'edit');if(role!=='owner')fail(403,'OWNER_CONSENT_REQUIRED');if(verifyElevation(actor)!==true)fail(403,'ELEVATION_REQUIRED');const c=configuration(projectId,configId);assertRevision(v.configuration_revision,c.revision);if(v.configuration_sha256!==c.configuration_sha256||!validGuide(p,c))fail(409,'SELECTED_BROWSER_PINS_STALE');const g=c.configuration.work.guide_ref,pin={configuration_id:c.id,configuration_revision:c.revision,configuration_sha256:c.configuration_sha256,guide_id:g.id,guide_sha256:g.sha256,owner_user_id:p.owner_user_id,allowed:v.allow,reviewed_at:stamp()};const digest=hash(pin);write(`INSERT INTO ops_selected_browser_consents VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(configuration_id) DO UPDATE SET configuration_revision=excluded.configuration_revision,configuration_sha256=excluded.configuration_sha256,guide_id=excluded.guide_id,guide_sha256=excluded.guide_sha256,owner_user_id=excluded.owner_user_id,allowed=excluded.allowed,consent_sha256=excluded.consent_sha256,reviewed_at=excluded.reviewed_at`,c.id,p.id,c.revision,c.configuration_sha256,g.id,g.sha256,p.owner_user_id,v.allow?1:0,digest,pin.reviewed_at);return {allowed:v.allow,configuration_id:c.id,consent_sha256:digest};});}
  async function startCore(actor,projectId,configId,input,scheduled=false){
    const v=parse(selectedStartSchema,input);access(actor,projectId,'run');const publicMode=isPublicNavigation(configuration(projectId,configId).configuration);if(scheduled){if(publicMode||verifyScheduledAuthority(actor,projectId,configId)!==true)fail(403,'SCHEDULE_AUTHORIZATION_REQUIRED');}else if(!publicMode)control(actor);
    const previous=one('SELECT * FROM ops_selected_browser_runs WHERE project_id=? AND idempotency_key=?',projectId,v.idempotency_key);
    if(previous){if(previous.configuration_id!==configId||previous.configuration_sha256!==v.configuration_sha256||previous.started_by!==actor.id)fail(409,'IDEMPOTENCY_CONFLICT');return dto(actor,previous);}
    const ready=await readiness(actor,projectId,configId);if(!ready.can_start)fail(409,ready.checks.find(c=>c.state!=='ready').code);
    let r=tx(()=>{if(scheduled&&verifyScheduledAuthority(actor,projectId,configId)!==true)fail(403,'SCHEDULE_AUTHORIZATION_REQUIRED');const {p}=access(actor,projectId,'run'),c=configuration(projectId,configId);assertRevision(v.project_revision,p.revision);assertRevision(v.configuration_revision,c.revision);if(c.configuration_sha256!==v.configuration_sha256||(!publicMode&&!validGuide(p,c))||!limitsCheck(p,c.configuration))fail(409,'SELECTED_BROWSER_PINS_STALE');const s=publicMode?null:consentRow(p,c);if(!publicMode&&!s)fail(409,'OWNER_MODEL_CONSENT_REQUIRED');if(one("SELECT 1 FROM ops_selected_browser_uncertainties u JOIN ops_selected_browser_runs r ON r.id=u.run_id WHERE r.configuration_id=? AND u.state='unresolved'",configId))fail(409,'UNRESOLVED_EFFECT');if(one("SELECT 1 FROM ops_selected_browser_runs WHERE project_id=? AND state IN('preparing','running','paused','awaiting_approval','human_control','stopping')",projectId))fail(409,'ATTEMPT_ALREADY_ACTIVE');const id=uuid(),attemptId=uuid(),at=stamp(),deadline=new Date(Date.parse(at)+c.configuration.budgets.max_seconds*1000).toISOString();write(`INSERT INTO ops_selected_browser_runs(id,project_id,configuration_id,idempotency_key,started_by,starter_session_id,owner_user_id,configuration_revision,configuration_sha256,configuration_json,guide_id,guide_sha256,consent_sha256,project_revision,project_limits_revision,state,attempt_id,usage_json,started_at,deadline_at,execution_mode${scheduled?',schedule_occurrence_id':''}) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'preparing',?,?,?,?,?${scheduled?',?':''})`,id,p.id,c.id,v.idempotency_key,actor.id,actor.jti??null,p.owner_user_id,c.revision,c.configuration_sha256,c.configuration_json,c.configuration.work.guide_ref?.id??null,c.configuration.work.guide_ref?.sha256??null,s?.consent_sha256??null,p.revision,p.agent_limits_revision,attemptId,JSON.stringify(emptyUsage()),at,deadline,publicMode?'public_navigation':'agent',...(scheduled?[actor.schedule_occurrence_id]:[]));write("INSERT INTO ops_selected_browser_attempts(id,run_id,fence,state,started_at) VALUES(?,?,1,'preparing',?)",attemptId,id,at);const row=runRow(projectId,id);event(row,'START_AUTHORIZED',{},actor);return row;});
    try{const launched=await runner.launch({...identity(r),project_id:r.project_id,configuration_id:r.configuration_id,configuration_revision:r.configuration_revision,project_revision:r.project_revision,project_limits_revision:r.project_limits_revision,workspace_id:r.attempt_id,configuration:JSON.parse(r.configuration_json),limits:JSON.parse(r.configuration_json).budgets,deadline_at:r.deadline_at});if(!launched||Object.entries(identity(r)).some(([k,v])=>launched[k]!==v))fail(502,'LAUNCH_IDENTITY_MISMATCH');r=tx(()=>{const current=runRow(projectId,r.id);if(current.state!=='preparing'||current.fence!==r.fence)return current;livePins(current);write("UPDATE ops_selected_browser_attempts SET state='running' WHERE id=?",r.attempt_id);event(current,'BROWSER_LAUNCHED');return mutate(current,'running');});if(r.state!=='running')await terminate(r,'cancelled','START_FENCED');}
    catch(error){
      try{if(publicMode)tx(()=>event(runRow(projectId,r.id),'LAUNCH_REFUSED',{code:launchFailureCode(error?.code)},actor));}
      finally{await terminate(runRow(projectId,r.id),'failed','LAUNCH_UNCERTAIN');}
    }
    if(publicMode&&runRow(projectId,r.id).state==='running'){
      try{const current=runRow(projectId,r.id),observation=parse(selectedObservationSchema,await runner.observe(identity(current)));
        const entry=JSON.parse(current.configuration_json).destinations.entry_urls[0],candidate=observation.candidates.find(c=>c.operation.kind==='navigate'&&c.operation.url===entry);
        if(!candidate)fail(502,'PUBLIC_NAVIGATION_CANDIDATE_UNAVAILABLE');
        await executeCandidate(current,candidate,observation.snapshot_ref);
      }catch(e){await terminate(runRow(projectId,r.id),'failed',e.code??'PUBLIC_NAVIGATION_FAILED');}
    }
    return dto(actor,runRow(projectId,r.id));
  }
  async function publicReadiness(actor,projectId,url){
    const {p}=access(actor,projectId,'run'),c=publicNavigationConfiguration(url),validated=validateBrowserDraftImport({configuration:c});
    // The host is shared: use the same global admission blockers as openPublic.
    // Return only the reason, never another project's run or user identity.
    const cleanup=!!one("SELECT 1 FROM ops_selected_browser_uncertainties WHERE kind='CLEANUP_UNVERIFIED' AND state='unresolved'");
    const active=!!one("SELECT 1 FROM ops_selected_browser_runs WHERE state IN('preparing','running','paused','awaiting_approval','human_control','stopping')");
    // Guest boundary measurements require idle execution. Never invoke that
    // probe while an attempt or unverified cleanup may still own the boundary.
    if(active||cleanup)return {can_start:false,checks:[{kind:'browser_lifecycle',state:'blocked',code:cleanup?'CLEANUP_UNVERIFIED':'ATTEMPT_ALREADY_ACTIVE'}],capabilities:{},helper_hashes:{},protected_inventory_sha256:null,valid_until:null};
    let status;try{status=await runner?.readiness?.({project_id:projectId,configuration:c,configuration_sha256:validated.configuration_sha256,policy_sha256:validated.configuration_sha256});}catch{/* explicit unreachable capability */}
    const ready=!!(status?.available&&status?.verified_supervisor&&status?.verified_isolation&&status?.verified_destinations&&status?.verified_site_policy&&status?.policy_sha256===validated.configuration_sha256);
    const checks=[{kind:'runtime',state:ready?'ready':'blocked',code:ready?'READY':status?.code??'BROWSER_RUNTIME_UNAVAILABLE'},
      {kind:'project_limits',state:limitsCheck(p,c)?'ready':'blocked',code:limitsCheck(p,c)?'READY':'PROJECT_LIMITS_REQUIRED'},
      {kind:'browser_lifecycle',state:!cleanup&&!active?'ready':'blocked',code:cleanup?'CLEANUP_UNVERIFIED':active?'ATTEMPT_ALREADY_ACTIVE':'READY'}];
    return {can_start:checks.every(check=>check.state==='ready'),checks,capabilities:status?.capabilities??{},helper_hashes:status?.helper_hashes??{},protected_inventory_sha256:status?.protected_inventory_sha256??null,valid_until:status?.valid_until??null};
  }
  async function openPublic(actor,projectId,input){
    const v=parse(publicNavigationInput,input);const {p}=access(actor,projectId,'run');assertRevision(v.project_revision,p.revision);
    const old=one('SELECT * FROM ops_selected_browser_runs WHERE project_id=? AND idempotency_key=?',projectId,v.idempotency_key);
    const proposed=validateBrowserDraftImport({configuration:publicNavigationConfiguration(v.url)});
    if(old){if(old.started_by!==actor.id||old.execution_mode!=='public_navigation'||old.configuration_sha256!==proposed.configuration_sha256)fail(409,'IDEMPOTENCY_CONFLICT');return dto(actor,old);}
    const id=tx(()=>{const {p}=access(actor,projectId,'run');assertRevision(v.project_revision,p.revision);
      if(one("SELECT 1 FROM ops_selected_browser_runs WHERE state IN('preparing','running','paused','awaiting_approval','human_control','stopping')"))fail(409,'ATTEMPT_ALREADY_ACTIVE');
      if(one("SELECT 1 FROM ops_selected_browser_uncertainties WHERE kind='CLEANUP_UNVERIFIED' AND state='unresolved'"))fail(409,'CLEANUP_UNVERIFIED');
      if(!limitsCheck(p,proposed.configuration))fail(409,'PROJECT_LIMITS_REQUIRED');
      const id=uuid(),at=stamp(),source=proposed.configuration.work.instructions;
      write('INSERT INTO ops_browser_agent_configurations(id,project_id,configuration_json,configuration_sha256,source_text,source_sha256,created_by,created_at,updated_by,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)',id,projectId,proposed.configuration_json,proposed.configuration_sha256,source,browserDraftHash(source),actor.id,at,actor.id,at);
      write('INSERT INTO ops_browser_agent_configuration_versions VALUES(?,?,?,?,?,?,?,?,?)',id,projectId,1,proposed.configuration_json,proposed.configuration_sha256,source,browserDraftHash(source),actor.id,at);return id;});
    return start(actor,projectId,id,{project_revision:p.revision,configuration_revision:1,configuration_sha256:proposed.configuration_sha256,idempotency_key:v.idempotency_key});
  }
  function get(actor,projectId,runId){access(actor,projectId);return dto(actor,runRow(projectId,runId));}
  async function sources(actor,projectId,runId){access(actor,projectId);const r=runRow(projectId,runId),records=sourceRecords(r),scope={project_id:projectId,run_id:runId,attempt_id:r.attempt_id,fence:1};let status=[];if(typeof artifacts?.observationStatus==='function')for(let offset=0;offset<records.length;offset+=100)status.push(...await artifacts.observationStatus(actor,scope,records.slice(offset,offset+100).map(s=>s.artifact_ref)));access(actor,projectId);return {sources:records.map(source=>({...source,...(status.find(item=>item.id===source.id)??{state:'unverified',code:'PRIVATE_SOURCE_STATUS_UNAVAILABLE'})}))};}
  function list(actor,projectId){access(actor,projectId);return {runs:all('SELECT * FROM ops_selected_browser_runs WHERE project_id=? ORDER BY started_at DESC,id DESC LIMIT 50',projectId).map(r=>dto(actor,r).run)};}
  function uncertainty(r,kind,stepId=null){if(!one("SELECT 1 FROM ops_selected_browser_uncertainties WHERE run_id=? AND kind=? AND state='unresolved'",r.id,kind))write("INSERT INTO ops_selected_browser_uncertainties(id,run_id,step_id,kind,state,created_at) VALUES(?,?,?,?,'unresolved',?)",uuid(),r.id,stepId,kind,stamp());}
  function staleApprovals(r){write("UPDATE ops_selected_browser_approvals SET state='stale' WHERE run_id=? AND state IN('pending','approved')",r.id);}
  function recordFinalNetwork(r,receipt){
    const final=receipt.final_network,previous=JSON.parse(r.network_state_json),usage=JSON.parse(r.usage_json),acknowledged=confirmedAuthCount(r,{original:true});
    if(final.requests<usage.requests||final.response_bytes<usage.response_bytes||final.effects_sent<previous.effects_sent||final.effects_uncertain<previous.effects_uncertain)uncertainty(r,'NETWORK_STATE_UNVERIFIED');
    usage.requests=Math.max(usage.requests,final.requests);usage.response_bytes=Math.max(usage.response_bytes,final.response_bytes);
    const network={...previous,cumulativeusage:{requests:usage.requests,response_bytes:usage.response_bytes},inflight_action:final.inflight>0,inflight_count:final.inflight,pending_count:final.pending_count,effects_sent:Math.max(previous.effects_sent,final.effects_sent),effects_uncertain:Math.max(previous.effects_uncertain,final.effects_uncertain),auth_effects_acknowledged:acknowledged,reported_auth_effects_acknowledged:final.auth_effects_acknowledged,ledger_sha256:final.ledger_sha256,mode:'revoked'};
    if(final.auth_effects_acknowledged!==acknowledged||final.auth_effects_acknowledged>final.effects_sent)uncertainty(r,'AUTHENTICATION_RECEIPT_MISMATCH');
    if(network.effects_sent>acknowledged||network.effects_uncertain)uncertainty(r,'EXTERNAL_EFFECT_UNVERIFIED');
    if(final.inflight||final.pending_count)uncertainty(r,'NETWORK_IN_FLIGHT');
    mutate(r,r.state,{usage_json:JSON.stringify(usage),network_state_json:JSON.stringify(network)});
    event(r,'FINAL_NETWORK_RECORDED',{requests:usage.requests,response_bytes:usage.response_bytes,effects_sent:network.effects_sent,effects_uncertain:network.effects_uncertain,auth_effects_acknowledged:acknowledged,inflight:final.inflight,pending_count:final.pending_count,ledger_sha256:final.ledger_sha256});
  }
  async function terminate(original,target,code){
    if(stops.has(original.id))return stops.get(original.id);
    const promise=(async()=>{
      const r=tx(()=>{const current=runRow(original.project_id,original.id);if(TERMINAL.has(current.state))return current;staleApprovals(current);aborters.get(current.id)?.abort();const steps=all("SELECT id FROM ops_selected_browser_steps WHERE run_id=? AND state='reserved'",current.id);if(current.execution_mode!=='public_navigation')for(const s of steps)uncertainty(current,'ACTION_IN_FLIGHT',s.id);write("UPDATE ops_selected_browser_steps SET state='suppressed',ended_at=? WHERE run_id=? AND state='reserved'",stamp(),current.id);const calls=all("SELECT id FROM ops_selected_browser_model_reservations WHERE run_id=? AND state='reserved'",current.id);for(const c of calls)uncertainty(current,'MODEL_IN_FLIGHT',c.id);write("UPDATE ops_selected_browser_model_reservations SET state='suppressed',ended_at=? WHERE run_id=? AND state='reserved'",stamp(),current.id);const next=mutate(current,'stopping',{fence:current.fence+1,manual_auth:0,controller_user_id:null,controller_session_id:null,result_code:code});write("UPDATE ops_selected_browser_attempts SET fence=?,state='stopping' WHERE id=?",next.fence,current.attempt_id);event(next,'FENCED',{code});return next;});
      if(TERMINAL.has(r.state))return r;
      if(r.execution_mode!=='public_navigation'&&typeof artifacts?.cancelAttempt==='function'){try{await artifacts.cancelAttempt({project_id:r.project_id,run_id:r.id,attempt_id:r.attempt_id,fence:1},{clipboardOnly:target==='completed'});}catch{tx(()=>uncertainty(runRow(r.project_id,r.id),'PRIVATE_ARTIFACT_CLEANUP_UNVERIFIED'));}}
      let receipt=null;try{const raw=await runner?.stop?.({...identity(r),reason:code});receipt=parse(receiptSchema,raw);if(receipt.public_navigation_evidence&&r.execution_mode!=='public_navigation'||Object.entries(identity(r)).some(([k,v])=>receipt[k]!==v)||verifyReceipt(receipt,identity(r))!==true)receipt=null;}catch{receipt=null;/* cleanup never inferred */}
      const stopped=tx(()=>{let current=runRow(r.project_id,r.id);if(current.fence!==r.fence||current.state!=='stopping')return current;const closure=verifiedClosure(receipt);if(!closure)uncertainty(current,'CLEANUP_UNVERIFIED');if(receipt){recordFinalNetwork(current,receipt);current=runRow(r.project_id,r.id);}const unresolved=!!one("SELECT 1 FROM ops_selected_browser_uncertainties WHERE run_id=? AND state='unresolved'",r.id),overBudget=networkBudgetExceeded(current),state=closure?(unresolved?'uncertain':overBudget&&target==='completed'?'failed':target):'uncertain';write('UPDATE ops_selected_browser_attempts SET state=?,ended_at=?,cleanup_json=? WHERE id=?',closure?'closed':'cleanup_unverified',stamp(),receipt?JSON.stringify(receipt):null,r.attempt_id);event(current,closure?'CLEANUP_VERIFIED':'CLEANUP_UNVERIFIED',{target,signed_receipt:!!receipt});return mutate(current,state,{ended_at:stamp(),result_code:overBudget&&target==='completed'?'NETWORK_ARTIFACT_BUDGET_EXHAUSTED':code});});
      if(target==='completed'&&stopped.state!=='completed'&&typeof artifacts?.cancelAttempt==='function'){try{await artifacts.cancelAttempt({project_id:r.project_id,run_id:r.id,attempt_id:r.attempt_id,fence:1},{clipboardOnly:false});}catch{tx(()=>{const current=runRow(r.project_id,r.id);uncertainty(current,'PRIVATE_ARTIFACT_CLEANUP_UNVERIFIED');mutate(current,'uncertain');});}}
      return runRow(r.project_id,r.id);
    })();stops.set(original.id,promise);try{return await promise;}finally{stops.delete(original.id);}
  }
  function checked(actor,projectId,runId,expected,{proof=false}={}){access(actor,projectId,'run');if(proof)control(actor);const r=runRow(projectId,runId);assertRevision(expected,r.revision);return r;}
  async function cancel(actor,projectId,runId,expected){const r=checked(actor,projectId,runId,expected);await terminate(r,'cancelled','CANCELLED_BY_PERSON');return get(actor,projectId,runId);}
  async function pause(actor,projectId,runId,expected){const r=tx(()=>{const row=checked(actor,projectId,runId,expected);if(row.state!=='running')fail(409,'RUN_NOT_RUNNING');if(one("SELECT 1 FROM ops_selected_browser_steps WHERE run_id=? AND state='reserved'",runId)||one("SELECT 1 FROM ops_selected_browser_model_reservations WHERE run_id=? AND state='reserved'",runId))fail(409,'ACTION_IN_FLIGHT_CANCEL_AVAILABLE');staleApprovals(row);event(row,'PAUSE_AUTHORIZED',{},actor);return mutate(row,'preparing',{result_code:'PAUSING'});});try{await runner.pause(identity(r));tx(()=>{const current=runRow(projectId,runId);if(current.state==='preparing'&&current.fence===r.fence){livePins(current);mutate(current,'paused',{result_code:null});event(current,'PAUSED');}});}catch{await terminate(r,'failed','PAUSE_UNCERTAIN');}return get(actor,projectId,runId);}
  async function resume(actor,projectId,runId,expected){const r=tx(()=>{const row=checked(actor,projectId,runId,expected,{proof:true});if(row.state!=='paused'||row.controller_user_id)fail(409,'RUN_NOT_PAUSED');if(one("SELECT 1 FROM ops_selected_browser_approvals WHERE run_id=? AND state='pending'",runId)||one("SELECT 1 FROM ops_selected_browser_steps WHERE run_id=? AND state='reserved'",runId))fail(409,'REQUEST_CONTINUATION_REQUIRED');livePins(row);event(row,'RESUME_AUTHORIZED',{},actor);return mutate(row,'preparing');});try{await runner.resume(identity(r));tx(()=>{const current=runRow(projectId,runId);if(current.state==='preparing'&&current.fence===r.fence)mutate(current,'running');});}catch{await terminate(r,'failed','RESUME_UNCERTAIN');}return get(actor,projectId,runId);}
  function authorizeAttempt(actor,scope,intent){const read=intent==='artifact_read',transform=intent==='artifact_transform',verify=intent==='artifact_verify',historical=read||transform;const {p}=access(actor,scope.project_id,read?'read':transform?'review':'run');const r=runRow(p.id,scope.run_id);if(r.execution_mode==='public_navigation')fail(409,'PUBLIC_ARTIFACTS_UNAVAILABLE');if(r.attempt_id!==scope.attempt_id||(r.fence!==scope.fence&&!(historical&&r.state==='completed'&&scope.fence===1)))fail(409,'STALE_ATTEMPT_FENCE');if(!read&&!(transform&&r.state==='completed')&&!['running','paused','human_control','awaiting_approval'].includes(r.state))fail(409,'ATTEMPT_NOT_ACTIVE');if(!read&&!(transform&&r.state==='completed'))livePins(r);if(r.manual_auth&&(['clipboard_worker'].includes(intent)||intent==='capture'||intent==='model'||intent==='artifact_capture'||intent==='artifact_model'||intent==='artifact_transform'))fail(409,'MANUAL_AUTH_CAPTURE_DISABLED');if(['clipboard_import','clipboard_export'].includes(intent)){control(actor);if(r.manual_auth&&!ownsController(r,actor))fail(403,'TAKEOVER_NOT_YOURS');}
    return {configuration:JSON.parse(r.configuration_json),manual_auth:r.manual_auth===1,model_consent:historical||verify?false:true,policy_sha256:r.configuration_sha256,run:{id:r.id,project_id:r.project_id,state:r.state,attempt_id:r.attempt_id,fence:r.fence,artifact_fence:1,manual_auth:r.manual_auth===1,controller_user_id:r.controller_user_id}};}
  function pendingApproval(r,kind,payload,digest){const at=stamp(),expires=new Date(Math.min(Date.parse(r.deadline_at),Date.parse(at)+15*60*1000)).toISOString(),id=uuid();write("INSERT INTO ops_selected_browser_approvals(id,run_id,attempt_id,fence,kind,state,action_sha256,payload_json,created_at,expires_at) VALUES(?,?,?,?,?,'pending',?,?,?,?)",id,r.id,r.attempt_id,r.fence,kind,digest,JSON.stringify(payload),at,expires);event(r,'APPROVAL_REQUESTED',{approval_id:id,kind,action_sha256:digest});mutate(r,r.state==='human_control'?'human_control':'awaiting_approval');return id;}
  function recordNetworkRequest(r,input){
    const request=parse(selectedNetworkRequestSchema,input),origin=new URL(request.origin);
    if(origin.origin!==request.origin||!['https:','http:'].includes(origin.protocol)||origin.username||origin.password)fail(502,'NETWORK_REQUEST_INVALID');
    if(one("SELECT 1 FROM ops_selected_browser_approvals WHERE run_id=? AND action_sha256=? AND kind='network_effect'",r.id,request.binding_sha256))return;
    if(request.current_action){const s=one('SELECT * FROM ops_selected_browser_steps WHERE run_id=? AND ordinal=? AND fence=?',r.id,request.current_action.ordinal,r.fence);if(!s||s.state!=='reserved')fail(502,'NETWORK_ACTION_BINDING_INVALID');const packet=JSON.parse(s.action_json);if(hash(packet.snapshot_ref)!==hash(request.current_action.snapshot_ref)||hash(packet.candidate_ref)!==hash(request.current_action.candidate_ref))fail(502,'NETWORK_ACTION_BINDING_INVALID');}
    pendingApproval(r,'network_effect',{...request,return_state:r.controller_user_id?'human_control':r.state==='paused'?'paused':'running'},request.binding_sha256);
  }
  function measuredUsage(r,outcome){
    const usage=JSON.parse(r.usage_json);
    for(const key of ['requests','response_bytes'])usage[key]=outcome.usage_mode==='cumulative'?Math.max(usage[key],outcome.usage[key]):usage[key]+outcome.usage[key];
    usage.artifact_bytes+=outcome.usage.artifact_bytes;
    return usage;
  }
  function networkBudgetExceeded(r){const usage=JSON.parse(r.usage_json),c=JSON.parse(r.configuration_json);return usage.requests>c.budgets.max_requests||usage.response_bytes>c.budgets.max_response_bytes||usage.artifact_bytes>c.budgets.max_artifact_bytes;}
  function blockedOutcome(outcome){
    if(!outcome.facts.some(fact=>fact.code==='BROWSER_OPERATION_BLOCKED_BEFORE_EFFECT'))return false;
    if(outcome.facts.length!==1||outcome.facts[0].source_ref!==null||outcome.usage_mode!=='cumulative'||outcome.usage.artifact_bytes!==0)fail(502,'BLOCKED_ACTION_PROOF_INVALID');
    return true;
  }
  async function settlePendingAction(r){
    if(typeof runner?.pollAction!=='function')return;
    const s=one("SELECT * FROM ops_selected_browser_steps WHERE run_id=? AND state='reserved' ORDER BY ordinal LIMIT 1",r.id);if(!s)return;
    const raw=await runner.pollAction({...identity(r),ordinal:s.ordinal});if(!raw||raw.kind==='pending')return;
    const latest=runRow(r.project_id,r.id);if(latest.fence!==r.fence||!['running','human_control','paused','awaiting_approval'].includes(latest.state))return;
    if(raw.kind==='request_approval'){tx(()=>recordNetworkRequest(runRow(r.project_id,r.id),raw.request));return;}
    if(raw.kind==='off_list'){const escalation=parse(selectedEscalationSchema,raw.escalation),digest=hash({...identity(r),...escalation});tx(()=>{const current=runRow(r.project_id,r.id);if(!one("SELECT 1 FROM ops_selected_browser_approvals WHERE run_id=? AND kind='off_list_destination' AND action_sha256=?",r.id,digest))pendingApproval(current,'off_list_destination',{...escalation,return_state:current.controller_user_id?'human_control':'running'},digest);});return;}
    if(raw.kind==='uncertain'){tx(()=>uncertainty(runRow(r.project_id,r.id),'EXTERNAL_EFFECT_UNVERIFIED',s.id));await terminate(r,'failed','EXTERNAL_EFFECT_UNVERIFIED');return;}
    const outcome=parse(resultSchema,raw),blocked=blockedOutcome(outcome);if(!blocked&&one("SELECT 1 FROM ops_selected_browser_approvals WHERE run_id=? AND state='pending'",r.id))return;
    tx(()=>{const current=runRow(r.project_id,r.id),step=one('SELECT state FROM ops_selected_browser_steps WHERE id=?',s.id);if(current.fence!==r.fence||!['running','human_control','paused','awaiting_approval'].includes(current.state)||step.state!=='reserved')return;livePins(current);const usage=measuredUsage(current,outcome);write('UPDATE ops_selected_browser_steps SET state=?,outcome_json=?,ended_at=? WHERE id=?',blocked?'blocked':'done',JSON.stringify(outcome),stamp(),s.id);mutate(current,current.state,{usage_json:JSON.stringify(usage)});event(current,blocked?'ACTION_BLOCKED_BEFORE_EFFECT':'ACTION_CONTINUATION_SETTLED',{step_id:s.id});});
  }
  async function activateApprovedDestinations(r){
    const approvals=all("SELECT * FROM ops_selected_browser_approvals WHERE run_id=? AND kind='off_list_destination' AND state='approved' ORDER BY created_at,id",r.id);
    for(const approval of approvals){
      if(one("SELECT 1 FROM ops_selected_browser_steps WHERE run_id=? AND state='reserved'",r.id))return;
      const activation=tx(()=>{
        const current=runRow(r.project_id,r.id),fresh=one('SELECT * FROM ops_selected_browser_approvals WHERE id=?',approval.id);
        if(!['running','awaiting_approval','human_control'].includes(current.state)||current.fence!==approval.fence||fresh.state!=='approved')return null;
        livePins(current);access({id:approval.decided_by},r.project_id,'run');if(approval.expires_at<=stamp())fail(409,'APPROVAL_STALE');
        const payload=JSON.parse(approval.payload_json),grant={id:uuid(),approval_id:approval.id,...identity(current),...payload,lifetime:'attempt',single_use:true,persist_to_allowlist:false,wildcards:false,expires_at:approval.expires_at};
        write('INSERT INTO ops_selected_browser_destination_grants(id,approval_id,run_id,attempt_id,fence,origin,purpose,request_ref,scope_sha256,grant_json,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',grant.id,grant.approval_id,grant.run_id,grant.attempt_id,grant.fence,grant.origin,grant.purpose,grant.request_ref,hash(grant),JSON.stringify(grant),grant.expires_at);
        write("UPDATE ops_selected_browser_approvals SET state='consumed',consumed_at=? WHERE id=?",stamp(),approval.id);
        return {grant,current};
      });if(!activation)continue;
      try{
        if(typeof runner?.grantDestination!=='function')fail(409,'DESTINATION_GRANT_UNAVAILABLE');await runner.grantDestination(identity(activation.current),activation.grant);
        tx(()=>{const current=runRow(r.project_id,r.id);if(current.fence!==activation.current.fence||!['running','awaiting_approval','human_control'].includes(current.state))return;livePins(current);write('UPDATE ops_selected_browser_destination_grants SET consumed_at=? WHERE id=?',stamp(),activation.grant.id);const hasPending=!!one("SELECT 1 FROM ops_selected_browser_approvals WHERE run_id=? AND state='pending'",r.id);mutate(current,current.controller_user_id?'human_control':hasPending?'awaiting_approval':'running');event(current,'DESTINATION_GRANT_ACTIVATED',{grant_id:activation.grant.id,approval_id:approval.id});});
      }catch{tx(()=>uncertainty(runRow(r.project_id,r.id),'DESTINATION_GRANT_OUTCOME_UNKNOWN'));await terminate(runRow(r.project_id,r.id),'failed','DESTINATION_GRANT_UNCERTAIN');return;}
    }
  }
  async function refresh(actor,projectId,runId){
    access(actor,projectId);let r=runRow(projectId,runId);if(!['running','paused','awaiting_approval','human_control'].includes(r.state))return dto(actor,r);
    try{
      if(typeof runner?.pending==='function'){
        const pending=normalizeSelectedBrowserPending(await runner.pending(identity(r)));
        tx(()=>{
          const current=runRow(projectId,runId);if(current.fence!==r.fence||!ACTIVE.has(current.state)||current.state==='stopping')return;livePins(current);
          const counters=pending.cumulativeusage,previous=JSON.parse(current.network_state_json);
          if(pending.effects_sent<previous.effects_sent||pending.effects_uncertain<previous.effects_uncertain||pending.auth_effects_acknowledged<(previous.auth_effects_acknowledged??0)||previous.cumulativeusage&&['requests','response_bytes'].some(key=>counters[key]<previous.cumulativeusage[key]))fail(502,'NETWORK_COUNTERS_REGRESSED');
          if(pending.auth_effects_acknowledged!==confirmedAuthCount(current))fail(502,'AUTHENTICATION_RECEIPT_MISMATCH');
          const usage=measuredUsage(current,{usage:{...counters,artifact_bytes:0},usage_mode:'cumulative'});if(hash(usage)!==hash(JSON.parse(current.usage_json)))mutate(current,current.state,{usage_json:JSON.stringify(usage)});
          const network={inflight_action:pending.inflight_action,inflight_count:pending.inflight,pending_count:pending.pending.length,effects_sent:pending.effects_sent,effects_uncertain:pending.effects_uncertain,auth_effects_acknowledged:pending.auth_effects_acknowledged,cumulativeusage:counters,mode:pending.mode??null};
          const updated=runRow(projectId,runId);if(hash(network)!==hash(JSON.parse(updated.network_state_json)))mutate(updated,updated.state,{network_state_json:JSON.stringify(network)});
          if(network.effects_uncertain||network.effects_sent>network.auth_effects_acknowledged)uncertainty(current,'EXTERNAL_EFFECT_UNVERIFIED');
          for(const request of pending.pending){
            if(request.kind==='network_effect')recordNetworkRequest(runRow(projectId,runId),request);
            else if(request.kind==='off_list_destination'){const {kind,...input}=request;const escalation=parse(selectedEscalationSchema,input),digest=hash({...identity(current),...escalation});if(!one('SELECT 1 FROM ops_selected_browser_approvals WHERE run_id=? AND action_sha256=?',runId,digest))pendingApproval(runRow(projectId,runId),'off_list_destination',{...escalation,return_state:current.controller_user_id?'human_control':'running'},digest);}
            else fail(502,'NETWORK_PENDING_INVALID');
          }
        });
      }else fail(502,'NETWORK_PENDING_UNAVAILABLE');
      r=runRow(projectId,runId);if(hasUnconfirmedEffects(r)&&!(r.state==='human_control'&&r.manual_auth)){await terminate(r,'failed','EXTERNAL_EFFECT_UNVERIFIED');return get(actor,projectId,runId);}if(networkBudgetExceeded(r)){await terminate(r,'failed','NETWORK_ARTIFACT_BUDGET_EXHAUSTED');return get(actor,projectId,runId);}await settlePendingAction(r);await activateApprovedDestinations(runRow(projectId,runId));if(networkBudgetExceeded(runRow(projectId,runId)))await terminate(runRow(projectId,runId),'failed','NETWORK_ARTIFACT_BUDGET_EXHAUSTED');
    }catch(e){const current=runRow(projectId,runId);if(ACTIVE.has(current.state)){tx(()=>uncertainty(current,e.code==='EXTERNAL_EFFECT_UNVERIFIED'?'EXTERNAL_EFFECT_UNVERIFIED':'NETWORK_STATE_UNVERIFIED'));await terminate(current,'failed',e.code??'NETWORK_STATE_UNVERIFIED');}}
    return get(actor,projectId,runId);
  }
  const networkBusy=r=>{const n=JSON.parse(r.network_state_json);return n.inflight_action||n.pending_count>0||hasUnconfirmedEffects(r)||n.mode==='paused';};
  async function pauseForNetwork(r){
    const current=runRow(r.project_id,r.id);if(current.fence!==r.fence||!['running','awaiting_approval'].includes(current.state)||current.manual_auth)return;
    if(one("SELECT 1 FROM ops_selected_browser_approvals WHERE run_id=? AND state='pending'",r.id))return;
    if(one("SELECT 1 FROM ops_selected_browser_steps WHERE run_id=? AND state='reserved'",r.id)||one("SELECT 1 FROM ops_selected_browser_model_reservations WHERE run_id=? AND state='reserved'",r.id))return;
    const pausing=tx(()=>{const latest=runRow(r.project_id,r.id);if(!['running','awaiting_approval'].includes(latest.state)||latest.fence!==r.fence)return null;return mutate(latest,'preparing',{result_code:'NETWORK_ACTIVITY_PENDING',report_json:null});});if(!pausing)return;
    try{await runner.pause(identity(pausing));tx(()=>{const latest=runRow(r.project_id,r.id);if(latest.state==='preparing'&&latest.fence===r.fence){livePins(latest);mutate(latest,'paused',{result_code:'NETWORK_ACTIVITY_PENDING'});event(latest,'NETWORK_ACTIVITY_PAUSED');}});}catch{await terminate(pausing,'failed','NETWORK_PAUSE_UNCERTAIN');}
  }
  async function networkIdle(r,{pause=true,allowAwaitingApproval=false}={}){
    await refresh({id:r.started_by},r.project_id,r.id);const current=runRow(r.project_id,r.id);
    if(current.fence!==r.fence||!(current.state==='running'||allowAwaitingApproval&&current.state==='awaiting_approval')||current.manual_auth)return false;
    const busy=networkBusy(current)||!!one("SELECT 1 FROM ops_selected_browser_approvals WHERE run_id=? AND state='pending'",r.id);
    if(busy&&pause)await pauseForNetwork(current);return !busy;
  }
  async function executeCandidate(r,candidate,snapshot,approvalId=null,page=null){
    if(!await networkIdle(r)){if(approvalId)write("UPDATE ops_selected_browser_approvals SET state='stale' WHERE id=? AND state='approved'",approvalId);return;}
    const reserved=tx(()=>{const current=runRow(r.project_id,r.id);if(current.state!=='running'||current.fence!==r.fence||current.manual_auth)fail(409,'ATTEMPT_NOT_RUNNING');livePins(current);const config=JSON.parse(current.configuration_json),usage=JSON.parse(current.usage_json);if(!config.permissions.actions.includes(candidate.operation.kind))fail(403,'ACTION_NOT_CONFIGURED');if(usage.actions>=config.budgets.max_actions)fail(409,'ACTION_BUDGET_EXHAUSTED');const packet=parse(selectedActionSchema,{schema:'proxypilot.browser-action.proposal.v1',...identity(current),ordinal:current.ordinal+1,snapshot_ref:snapshot,candidate_ref:candidate.candidate_ref,approval_ref:null,operation:candidate.operation});const digest=hash(packet);
      if(['external_change','unknown'].includes(candidate.effect)||candidate.operation.kind==='submit'||candidate.operation.kind==='upload'){
        if(!approvalId){pendingApproval(current,'consequential_action',{packet,candidate,snapshot_ref:snapshot,purpose:candidate.label||candidate.operation.kind,action_kind:candidate.operation.kind,destination:page?.origin??null,url_sha256:page?.url_sha256??null,page},digest);return null;}
        const a=one('SELECT * FROM ops_selected_browser_approvals WHERE id=? AND run_id=?',approvalId,current.id);if(!a||a.state!=='approved'||a.fence!==current.fence||a.action_sha256!==digest||a.expires_at<=stamp())fail(409,'APPROVAL_STALE');packet.approval_ref={id:a.id,sha256:digest};write("UPDATE ops_selected_browser_approvals SET state='consumed',consumed_at=? WHERE id=?",stamp(),a.id);
      }
      const id=uuid();write("INSERT INTO ops_selected_browser_steps(id,run_id,attempt_id,fence,ordinal,action_sha256,action_json,effect,state,created_at) VALUES(?,?,?,?,?,?,?,?,'reserved',?)",id,current.id,current.attempt_id,current.fence,packet.ordinal,digest,JSON.stringify(packet),candidate.effect,stamp());usage.actions++;const next=mutate(current,'running',{ordinal:packet.ordinal,usage_json:JSON.stringify(usage)});event(next,'ACTION_RESERVED',{step_id:id,ordinal:packet.ordinal,action_sha256:digest});return {id,packet,r:next};});
    if(!reserved)return;
    let result;try{result=await runner.execute(reserved.packet);}catch{tx(()=>{const current=runRow(r.project_id,r.id);uncertainty(current,'ACTION_OUTCOME_UNKNOWN',reserved.id);write("UPDATE ops_selected_browser_steps SET state='uncertain',ended_at=? WHERE id=? AND state='reserved'",stamp(),reserved.id);});await terminate(runRow(r.project_id,r.id),'failed','ACTION_UNCERTAIN');return;}
    try{tx(()=>{const current=runRow(r.project_id,r.id),step=one('SELECT * FROM ops_selected_browser_steps WHERE id=?',reserved.id);if(current.state!=='running'||current.fence!==reserved.r.fence||step.state!=='reserved'){write("UPDATE ops_selected_browser_steps SET state='suppressed',ended_at=? WHERE id=?",stamp(),reserved.id);return;}livePins(current);
      if(result?.kind==='pending'||result?.kind==='started')return;
      if(result?.kind==='request_approval'){recordNetworkRequest(current,result.request);return;}
      if(result?.kind==='uncertain')fail(409,'EXTERNAL_EFFECT_UNVERIFIED');
      if(result?.kind==='off_list'){const escalation=parse(selectedEscalationSchema,result.escalation);const u=new URL(escalation.origin);if(u.origin!==escalation.origin||!['http:','https:'].includes(u.protocol)||u.username||u.password)fail(502,'INVALID_DESTINATION_ESCALATION');pendingApproval(current,'off_list_destination',{...escalation},hash({...identity(current),...escalation}));return;}
      const outcome=parse(resultSchema,result),blocked=blockedOutcome(outcome),usage=measuredUsage(current,outcome);write('UPDATE ops_selected_browser_steps SET state=?,outcome_json=?,ended_at=? WHERE id=?',blocked?'blocked':'done',JSON.stringify(outcome),stamp(),reserved.id);mutate(current,'running',{usage_json:JSON.stringify(usage)});event(current,'ACTION_SETTLED',{step_id:reserved.id});});if(networkBudgetExceeded(runRow(r.project_id,r.id)))await terminate(runRow(r.project_id,r.id),'failed','NETWORK_ARTIFACT_BUDGET_EXHAUSTED');}
    catch{tx(()=>{uncertainty(runRow(r.project_id,r.id),'ACTION_SETTLEMENT_UNKNOWN',reserved.id);});await terminate(runRow(r.project_id,r.id),'failed','ACTION_SETTLEMENT_UNKNOWN');}
  }
  async function modelCall(r,observation,purpose='decision',facts=[]){
    const c=JSON.parse(r.configuration_json),caps=JSON.parse(one('SELECT agent_limits_json FROM ops_projects WHERE id=?',r.project_id).agent_limits_json),limits={max_tokens:Math.min(c.budgets.max_tokens,caps.max_tokens??c.budgets.max_tokens),max_usd:Math.min(c.budgets.max_usd,caps.max_usd??c.budgets.max_usd),max_calls:c.budgets.max_model_calls};
    const guide=one('SELECT s.title,s.instructions FROM ops_guide_versions v JOIN ops_guide_submissions s ON s.id=v.submission_id WHERE v.id=?',r.guide_id),maxOutput=Math.min(limits.max_tokens,purpose==='decision'?c.model.max_decision_output_tokens:c.model.max_report_output_tokens);
    const guideText=JSON.stringify({format:1,title:guide.title,instructions:guide.instructions});
    const actor={id:r.started_by},scope={project_id:r.project_id,run_id:r.id,attempt_id:r.attempt_id,fence:r.fence};
    const sources=typeof artifacts?.modelInputs==='function'?await artifacts.modelInputs(actor,scope,c.work.source_inputs):[];
    if(c.work.source_inputs.length&&sources.length!==c.work.source_inputs.length)fail(409,'PRIVATE_INPUT_PINS_UNRESOLVED');
    const captured=sourceRecords(r).filter(s=>s.snapshot_ref.id===observation?.snapshot_ref.id).at(-1),selectedPageIds=[];
    if(captured&&typeof artifacts?.observationInputs==='function'){const currentInputs=await artifacts.observationInputs(actor,scope,[captured.artifact_ref]);sources.push(...currentInputs);selectedPageIds.push(captured.id);}
    else if(observation?.observation){const text=boundedText(observation.observation,4000);sources.push({ref:{...observation.snapshot_ref,mime_type:'text/plain',byte_count:Buffer.byteLength(text)},content_sha256:browserDraftHash(text),content_kind:'text',text,image_base64:null,image_mime_type:null});}
    const executable=(observation?.candidates??[]).map(x=>({id:x.candidate_ref.id,sha256:x.candidate_ref.sha256,operation:x.operation.kind,label:x.label??x.operation.kind,effect:x.effect})),targets=(observation?.input_targets??[]).map(t=>({id:t.target_ref.id,sha256:t.target_ref.sha256,operation:t.kind,label:t.label,effect:'external_change'}));
    const offered=purpose==='draft_input'?targets:targets.length?[...executable.slice(0,10),...targets.slice(0,10)]:executable;
    const input={guide:guideText,instructions:c.work.instructions,source_inputs:sources,snapshot_ref:observation?.snapshot_ref??null,candidates:['decision','draft_input'].includes(purpose)?offered:[],facts:facts.slice(0,30).map(f=>JSON.stringify(f))};
    if(captured&&typeof artifacts?.observationInputs==='function'){
      const previous=sourceRecords(r).filter(source=>source.id!==captured.id).reverse();
      for(const source of previous){if(input.source_inputs.length>=9)break;let disclosed;try{disclosed=await artifacts.observationInputs(actor,scope,[source.artifact_ref]);}catch{continue;}const proposal=[...input.source_inputs.slice(0,-1),...disclosed,input.source_inputs.at(-1)];const normalized={...input,source_inputs:proposal.map(item=>({...item,image_base64:item.image_base64?'[bounded image]':null}))};if(Buffer.byteLength(JSON.stringify(normalized))+2048>Math.min(c.model.max_prompt_bytes,16000))continue;input.source_inputs=proposal;selectedPageIds.push(source.id);}
    }
    const promptBytes=Buffer.byteLength(JSON.stringify({...input,source_inputs:input.source_inputs.map(source=>({...source,image_base64:source.image_base64?'[bounded image]':null}))}),'utf8');const imageBytes=input.source_inputs.reduce((n,source)=>n+(source.image_base64?source.image_base64.length+256:0),0);if(promptBytes+2048>Math.min(c.model.max_prompt_bytes,16000))fail(409,'MODEL_PROMPT_TOO_LARGE');const quote=await model.quote({purpose,prompt_bytes:promptBytes,max_output_tokens:maxOutput,image_encoded_bytes:imageBytes,limits:{...limits,max_output_tokens:maxOutput}});if(!Number.isSafeInteger(quote?.price_table_revision)||quote.price_table_revision<1||!Number.isSafeInteger(quote?.tokens)||quote.tokens<=0||!Number.isFinite(quote.usd)||quote.usd<0)fail(409,'MODEL_PRICE_UNKNOWN');
    const validateSources=async()=>{
      const current=runRow(r.project_id,r.id);if(!['running','paused','awaiting_approval'].includes(current.state)||current.fence!==r.fence||current.manual_auth)fail(409,'MODEL_RESULT_FENCED');livePins(current);
      const configured=c.work.source_inputs.length?await artifacts.modelInputs(actor,scope,c.work.source_inputs):[];
      const pageRefs=input.source_inputs.filter(source=>selectedPageIds.includes(source.ref.id)).map(source=>source.ref);
      const pages=pageRefs.length?await artifacts.observationInputs(actor,scope,pageRefs):[];
      const resolved=[...configured,...pages];
      if(input.source_inputs.some(source=>{const fresh=resolved.find(item=>item.ref.id===source.ref.id);return !fresh||hash(fresh)!==hash(source);})||resolved.length!==input.source_inputs.length)fail(409,'MODEL_SOURCE_UNAVAILABLE');
      livePins(runRow(r.project_id,r.id));
    };
    await validateSources();
    if(!await networkIdle(r))return null;
    const reservation=tx(()=>{const current=runRow(r.project_id,r.id);if(current.state!=='running'||current.fence!==r.fence||current.manual_auth)fail(409,'ATTEMPT_NOT_RUNNING');if(one("SELECT 1 FROM ops_selected_browser_approvals WHERE run_id=? AND state='pending'",current.id)||networkBusy(current))fail(409,'NETWORK_APPROVAL_PENDING');livePins(current);const usage=JSON.parse(current.usage_json);if(usage.model_calls>=c.budgets.max_model_calls||usage.tokens+quote.tokens>limits.max_tokens||usage.usd+quote.usd>limits.max_usd)fail(409,'MODEL_BUDGET_EXHAUSTED');const id=uuid();write("INSERT INTO ops_selected_browser_model_reservations(id,run_id,attempt_id,fence,ordinal,purpose,state,reserved_tokens,reserved_usd,price_table_revision,created_at) VALUES(?,?,?,?,?,?,'reserved',?,?,?,?)",id,r.id,r.attempt_id,r.fence,usage.model_calls+1,purpose,quote.tokens,quote.usd,quote.price_table_revision,stamp());usage.model_calls++;usage.tokens+=quote.tokens;usage.usd+=quote.usd;mutate(current,'running',{usage_json:JSON.stringify(usage)});event(current,'MODEL_RESERVED',{call_id:id,purpose,tokens:quote.tokens,usd:quote.usd});return {id,current};});
    const request={contract_version:'selected-browser-model.v1',attempt_id:r.attempt_id,fence:r.fence,price_table_revision:quote.price_table_revision,reservation:{tokens:quote.tokens,usd:quote.usd},purpose,run_id:r.id,call_id:reservation.id,project_id:r.project_id,project_revision:r.project_revision,project_limits_revision:r.project_limits_revision,policy_hash:r.configuration_sha256,guide_version_id:r.guide_id,guide_hash:r.guide_sha256,consent_hash:r.consent_sha256,input,limits:{...limits,max_output_tokens:maxOutput},deadline_at:new Date(Math.min(Date.parse(r.deadline_at),Date.parse(stamp())+120000)).toISOString()};
    write('UPDATE ops_selected_browser_model_reservations SET request_sha256=? WHERE id=?',browserModelRequestDigest(request),reservation.id);
    const controller=new AbortController();aborters.set(r.id,controller);let result,knownSpendSettled=false;
    try{
      result=await model[purpose==='report'?'report':purpose==='draft_input'?'draftInput':'decide'](request,{signal:controller.signal});
      const usage=parse(selectedUsageSchema,{tokens:result.usage?.tokens,usd:result.usage?.usd});if(usage.tokens>quote.tokens||usage.usd>quote.usd)fail(502,'MODEL_USAGE_EXCEEDS_RESERVATION');
      const after=runRow(r.project_id,r.id);if(!['running','paused','awaiting_approval'].includes(after.state)||after.fence!==r.fence||one('SELECT state FROM ops_selected_browser_model_reservations WHERE id=?',reservation.id).state!=='reserved')return null;
      const settled=tx(()=>{
        const current=runRow(r.project_id,r.id),row=one('SELECT * FROM ops_selected_browser_model_reservations WHERE id=?',reservation.id);if(!['running','paused','awaiting_approval'].includes(current.state)||current.fence!==r.fence||row.state!=='reserved'||row.run_id!==r.id||row.attempt_id!==r.attempt_id||row.fence!==r.fence)return false;
        // Recording verified spend grants no disclosure or action authority.
        // Current access may have changed while the provider was running.
        const u=JSON.parse(current.usage_json);u.tokens+=usage.tokens-quote.tokens;u.usd=Math.max(0,u.usd+usage.usd-quote.usd);
        write("UPDATE ops_selected_browser_model_reservations SET state='settled',actual_tokens=?,actual_usd=?,ended_at=?,receipt_json=? WHERE id=?",usage.tokens,usage.usd,stamp(),typeof result.attestation==='string'?JSON.stringify({attestation:result.attestation,request_sha256:browserModelRequestDigest(request),usage,price_table_revision:quote.price_table_revision}):null,reservation.id);
        mutate(current,current.state,{usage_json:JSON.stringify(u)});for(const sourceId of selectedPageIds){const source=one('SELECT disclosed_calls_json FROM ops_selected_browser_sources WHERE id=?',sourceId),calls=JSON.parse(source.disclosed_calls_json);calls.push(reservation.id);write('UPDATE ops_selected_browser_sources SET disclosed_calls_json=? WHERE id=?',JSON.stringify(calls),sourceId);}
        return true;
      });
      if(!settled)return null;knownSpendSettled=true;
      let sourceUnavailable=false;try{await validateSources();}catch{sourceUnavailable=true;}
      if(sourceUnavailable){event(runRow(r.project_id,r.id),'MODEL_RESULT_SUPPRESSED',{call_id:reservation.id,reason:'MODEL_SOURCE_UNAVAILABLE'});if(ACTIVE.has(runRow(r.project_id,r.id).state))await terminate(runRow(r.project_id,r.id),'failed','MODEL_SOURCE_UNAVAILABLE');return null;}
      const networkReady=await networkIdle(r,{pause:false,allowAwaitingApproval:true});
      if(!networkReady){event(runRow(r.project_id,r.id),'MODEL_RESULT_SUPPRESSED',{call_id:reservation.id,reason:'NETWORK_ACTIVITY_PENDING'});await pauseForNetwork(runRow(r.project_id,r.id));return null;}
      return {...result,disclosed_source_refs:input.source_inputs.map(source=>source.ref)};
    }
    catch(e){if(knownSpendSettled){const current=runRow(r.project_id,r.id);event(current,'MODEL_RESULT_SUPPRESSED',{call_id:reservation.id,reason:e.code??'MODEL_AUTHORITY_LOST'});if(ACTIVE.has(current.state))await terminate(current,'failed',e.code??'MODEL_AUTHORITY_LOST');return null;}tx(()=>{const current=runRow(r.project_id,r.id);uncertainty(current,'MODEL_OUTCOME_UNKNOWN',reservation.id);write("UPDATE ops_selected_browser_model_reservations SET state='uncertain',ended_at=? WHERE id=? AND state='reserved'",stamp(),reservation.id);});await terminate(runRow(r.project_id,r.id),'failed','MODEL_UNCERTAIN');return null;}
    finally{if(aborters.get(r.id)===controller)aborters.delete(r.id);}
  }
  async function proposeInput(r,observation,target){
    if(typeof model?.draftInput!=='function'||typeof artifacts?.stageInputDraft!=='function'||typeof runner?.offerInput!=='function')fail(409,'PRIVATE_INPUT_DRAFT_UNAVAILABLE');
    const reply=await modelCall(r,{...observation,candidates:[],input_targets:[target]},'draft_input');if(!reply)return;
    const proposed=parse(selectedInputDraftSchema,reply.draft);if(proposed.candidate_id!==target.target_ref.id)fail(502,'INPUT_DRAFT_TARGET_MISMATCH');
    const scope={project_id:r.project_id,run_id:r.id,attempt_id:r.attempt_id,fence:r.fence};
    const staged=await artifacts.stageInputDraft({id:r.started_by},scope,{target_ref:target.target_ref,snapshot_ref:observation.snapshot_ref,text:proposed.text,purpose:proposed.purpose});
    const artifactRef=staged.artifact_ref??staged.ref??staged;const parsed=z.object({id:z.string().uuid(),sha256:z.string().regex(/^[a-f0-9]{64}$/),mime_type:z.literal('text/plain'),byte_count:z.number().int().positive().max(12000)}).strict().safeParse(artifactRef);
    if(!parsed.success||parsed.data.sha256!==browserDraftHash(proposed.text)||parsed.data.byte_count!==Buffer.byteLength(proposed.text))fail(502,'INPUT_DRAFT_PIN_MISMATCH');
    tx(()=>{const current=runRow(r.project_id,r.id);if(current.state!=='running'||current.fence!==r.fence||current.manual_auth)fail(409,'INPUT_DRAFT_FENCED');livePins(current);const usage=JSON.parse(current.usage_json);usage.artifact_bytes+=parsed.data.byte_count;mutate(current,current.state,{usage_json:JSON.stringify(usage)});if(networkBudgetExceeded(runRow(r.project_id,r.id)))fail(409,'ARTIFACT_BUDGET_EXHAUSTED');const payload={artifact_ref:parsed.data,target_ref:target.target_ref,element_ref:target.element_ref,snapshot_ref:observation.snapshot_ref,purpose:proposed.purpose,action_kind:target.kind,destination:observation.page?.origin??null,url_sha256:observation.page?.url_sha256??null};pendingApproval(current,'input_draft',payload,hash({...identity(current),...payload}));});
  }
  function verifyInputDraftApproval(actor,scope,manifest){
    try{access(actor,scope.project_id,'run');const r=runRow(scope.project_id,scope.run_id);if(r.attempt_id!==scope.attempt_id||r.fence!==scope.fence||r.manual_auth||!['running','awaiting_approval'].includes(r.state))return false;livePins(r);const a=one('SELECT * FROM ops_selected_browser_approvals WHERE id=? AND run_id=?',manifest.approval_ref?.id,r.id);if(!a||a.kind!=='input_draft'||!['approved','consumed'].includes(a.state)||a.fence!==r.fence||a.expires_at<=stamp()||a.action_sha256!==manifest.approval_ref.sha256)return false;const p=JSON.parse(a.payload_json);if(['artifact_ref','target_ref','snapshot_ref','purpose'].some(k=>hash(p[k])!==hash(manifest[k])))return false;if(a.state==='approved'){control(actor);if(a.decided_by!==actor.id)return false;}return true;}catch{return false;}
  }
  function verifyRetainedInputDraftApproval(actor,scope,manifest){
    try{
      const s=attemptScopeSchema.parse(scope),m=inputApprovalManifestSchema.parse(manifest);access(actor,s.project_id,'run');
      const r=runRow(s.project_id,s.run_id);if(r.attempt_id!==s.attempt_id||r.fence!==s.fence||!['running','paused','human_control','awaiting_approval'].includes(r.state))return false;livePins(r);
      const a=one('SELECT * FROM ops_selected_browser_approvals WHERE id=? AND run_id=?',m.approval_ref.id,r.id);
      if(!a||a.kind!=='input_draft'||a.state!=='consumed'||!a.consumed_at||a.attempt_id!==r.attempt_id||a.fence!==r.fence||a.expires_at<=stamp()||a.action_sha256!==m.approval_ref.sha256)return false;
      const payload=JSON.parse(a.payload_json);
      return a.action_sha256===hash({...identity(r),...payload})&&['artifact_ref','target_ref','snapshot_ref','purpose'].every(key=>hash(payload[key])===hash(m[key]));
    }catch{return false;}
  }
  async function approveDraft(actor,r,approval){
    try{
      if(!await networkIdle(r,{allowAwaitingApproval:true})){write("UPDATE ops_selected_browser_approvals SET state='stale' WHERE id=? AND state='approved'",approval.id);return;}
      if(typeof artifacts?.approveInputDraft!=='function'||typeof runner?.offerInput!=='function')fail(409,'PRIVATE_INPUT_DRAFT_UNAVAILABLE');
      const scope={project_id:r.project_id,run_id:r.id,attempt_id:r.attempt_id,fence:r.fence},p=approval.payload;
      const manifest={artifact_ref:p.artifact_ref,target_ref:p.target_ref,snapshot_ref:p.snapshot_ref,purpose:p.purpose,approval_ref:{id:approval.id,sha256:approval.action_sha256}};
      const inputRef=await artifacts.approveInputDraft(actor,scope,manifest);
      const ref=inputRef.input_ref??inputRef;const pinned=z.object({id:z.string().uuid(),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict().safeParse(ref);if(!pinned.success||ref.id!==p.artifact_ref.id||ref.sha256!==p.artifact_ref.sha256)fail(502,'INPUT_DRAFT_PIN_MISMATCH');
      const candidate=parse(selectedCandidateSchema,await runner.offerInput(identity(r),{snapshot_ref:p.snapshot_ref,target_ref:p.target_ref,input_ref:ref},{actor,manifest}));
      const source=candidate.operation.kind==='paste'?candidate.operation.clipboard_ref:candidate.operation.input_ref;
      if(candidate.operation.kind!==p.action_kind||candidate.operation.element_ref!==p.element_ref||hash(source)!==hash(ref)||candidate.effect!=='external_change')fail(502,'INPUT_DRAFT_CANDIDATE_MISMATCH');
      tx(()=>{const current=runRow(r.project_id,r.id);if(current.state!=='awaiting_approval'||current.fence!==r.fence||current.manual_auth)fail(409,'INPUT_DRAFT_FENCED');livePins(current);const a=one('SELECT state FROM ops_selected_browser_approvals WHERE id=?',approval.id);if(a?.state!=='approved')fail(409,'APPROVAL_STALE');write("UPDATE ops_selected_browser_approvals SET state='consumed',consumed_at=? WHERE id=?",stamp(),approval.id);mutate(current,'running');event(current,'PRIVATE_INPUT_OFFERED',{approval_id:approval.id,input_ref:ref,candidate_ref:candidate.candidate_ref},actor);});
      await executeCandidate(runRow(r.project_id,r.id),candidate,p.snapshot_ref,null,p.destination?{origin:p.destination,url_sha256:p.url_sha256}:null);
    }catch{const current=runRow(r.project_id,r.id);if(ACTIVE.has(current.state))await terminate(current,'failed','INPUT_DRAFT_ACTIVATION_UNCERTAIN');}
  }
  async function step(actor,projectId,runId,expected){
    if(runRow(projectId,runId).execution_mode==='public_navigation')fail(409,'PUBLIC_MODEL_TASKS_UNAVAILABLE');
    const before=checked(actor,projectId,runId,expected);if(before.state!=='running'||before.manual_auth)fail(409,'ATTEMPT_NOT_RUNNING');await refresh(actor,projectId,runId);const r=runRow(projectId,runId);if(TERMINAL.has(r.state))return get(actor,projectId,runId);if(one("SELECT 1 FROM ops_selected_browser_approvals WHERE run_id=? AND state='pending'",runId))return get(actor,projectId,runId);if(r.state!=='running'||r.manual_auth)fail(409,'ATTEMPT_NOT_RUNNING');if(one("SELECT 1 FROM ops_selected_browser_steps WHERE run_id=? AND state='reserved'",runId)||one("SELECT 1 FROM ops_selected_browser_model_reservations WHERE run_id=? AND state='reserved'",runId))return get(actor,projectId,runId);if(networkBusy(r)){await pauseForNetwork(r);return get(actor,projectId,runId);}
    if(pumps.has(runId))fail(409,'STEP_ALREADY_RUNNING');const task=(async()=>{try{livePins(r);if(one("SELECT 1 FROM ops_selected_browser_steps WHERE run_id=? AND state='reserved'",runId)||one("SELECT 1 FROM ops_selected_browser_model_reservations WHERE run_id=? AND state='reserved'",runId))fail(409,'STEP_ALREADY_RESERVED');const observation=parse(selectedObservationSchema,await runner.observe(identity(r)));await captureObservation(runRow(projectId,runId),observation);const decision=await modelCall(runRow(projectId,runId),observation);if(!decision)return;const chosen=decision.decision??decision;if(chosen.kind==='candidate'){const target=observation.input_targets.find(t=>t.target_ref.id===chosen.candidate_id);if(target){await proposeInput(runRow(projectId,runId),observation,target);return;}const candidate=observation.candidates.find(x=>x.candidate_ref.id===chosen.candidate_id);if(!candidate)fail(502,'MODEL_CANDIDATE_INVALID');await executeCandidate(runRow(projectId,runId),candidate,observation.snapshot_ref,null,observation.page);}else if(chosen.kind==='done'){if(await finishReport(runRow(projectId,runId),observation)){const current=runRow(projectId,runId);if(await networkIdle(current))await terminate(runRow(projectId,runId),'completed','REQUESTED_RESULT_REPORTED');else{const blocked=runRow(projectId,runId);if(ACTIVE.has(blocked.state)&&blocked.report_json)mutate(blocked,blocked.state,{report_json:null});}}}else if(chosen.kind==='escalate'){tx(()=>{const current=runRow(projectId,runId);if(current.state==='running')mutate(current,'paused',{result_code:'MODEL_ESCALATED'});});await runner.pause(identity(runRow(projectId,runId)));}else fail(502,'MODEL_DECISION_INVALID');}
      catch(e){const current=runRow(projectId,runId);if(current.state==='running')await terminate(current,'failed',e.code??'STEP_FAILED');}})();pumps.set(runId,task);try{await task;}finally{pumps.delete(runId);}return get(actor,projectId,runId);
  }
  async function finishReport(r,observation){
    if(!await networkIdle(r))return false;
    if(one("SELECT 1 FROM ops_selected_browser_approvals WHERE run_id=? AND state='pending'",r.id)||one("SELECT 1 FROM ops_selected_browser_steps WHERE run_id=? AND state='reserved'",r.id))return false;
    if(typeof model?.report!=='function')fail(409,'MODEL_REPORT_UNAVAILABLE');
    const steps=all("SELECT outcome_json FROM ops_selected_browser_steps WHERE run_id=? AND state='done' ORDER BY ordinal",r.id),facts=steps.flatMap(s=>JSON.parse(s.outcome_json).facts);
    const response=await modelCall(r,observation,'report',facts);if(!response||!await networkIdle(runRow(r.project_id,r.id)))return false;
    const report=response.report??response,allowed=new Set((response.disclosed_source_refs??[]).map(source=>source.id));
    if(typeof report.summary!=='string'||Buffer.byteLength(report.summary)>8192||!Array.isArray(report.citations)||report.citations.length>50||report.citations.some(id=>typeof id!=='string'||!allowed.has(id)))fail(502,'REPORT_CITATION_INVALID');
    return tx(()=>{const current=runRow(r.project_id,r.id);if(current.state!=='running'||current.fence!==r.fence||networkBusy(current)||one("SELECT 1 FROM ops_selected_browser_approvals WHERE run_id=? AND state='pending'",r.id))return false;livePins(current);mutate(current,'running',{report_json:JSON.stringify({summary:report.summary,citations:report.citations,evidence_refs:response.disclosed_source_refs??[],limitations:Array.isArray(report.limitations)?report.limitations.filter(s=>typeof s==='string'&&s.length<=500).slice(0,10):[]})});return true;});
  }
  async function decision(actor,projectId,runId,approvalId,expected,input){const v=parse(selectedDecisionSchema,input);const approval=tx(()=>{const r=checked(actor,projectId,runId,expected,{proof:true});livePins(r);if(r.manual_auth&&!ownsController(r,actor))fail(403,'TAKEOVER_NOT_YOURS');const a=one('SELECT * FROM ops_selected_browser_approvals WHERE id=? AND run_id=?',approvalId,runId);if(!a||!['awaiting_approval','human_control','paused'].includes(r.state)||a.state!=='pending'||a.fence!==r.fence||a.expires_at<=stamp()||a.action_sha256!==v.action_sha256)fail(409,'APPROVAL_STALE');write('UPDATE ops_selected_browser_approvals SET state=?,decided_by=?,decided_at=? WHERE id=?',v.decision==='approve'?'approved':'denied',actor.id,stamp(),a.id);event(r,v.decision==='approve'?'APPROVAL_GRANTED':'APPROVAL_DENIED',{approval_id:a.id,action_sha256:a.action_sha256},actor);const payload=JSON.parse(a.payload_json);mutate(r,v.decision==='approve'?(['input_draft','off_list_destination'].includes(a.kind)?(r.controller_user_id?'human_control':'awaiting_approval'):payload.return_state??'running'):(r.controller_user_id?'human_control':'paused'));return {...a,payload};});
    if(v.decision==='deny'){
      try{
        const current=runRow(projectId,runId);
        if(approval.kind==='network_effect'){
          if(typeof runner?.denyRequest!=='function')fail(502,'NETWORK_DENIAL_UNAVAILABLE');
          const raw=await runner.denyRequest(identity(current),approval.payload.request_ref),ack=parse(denialSchema,raw),manual=current.manual_auth===1;
          if(Object.entries(identity(current)).some(([key,value])=>ack[key]!==value)||ack.request_ref!==approval.payload.request_ref||ack.manual_auth!==manual||ack.paused===manual||ack.state!==(manual?'human_control':'paused'))fail(502,'NETWORK_DENIAL_PROOF_INVALID');
          tx(()=>{const latest=runRow(projectId,runId);if(latest.fence!==current.fence||!ACTIVE.has(latest.state)||latest.state==='stopping')return;livePins(latest);staleApprovals(latest);mutate(latest,ack.state);event(latest,'NETWORK_REQUEST_DENIED',{approval_id:approval.id,request_ref:ack.request_ref},actor);});
          await settlePendingAction(runRow(projectId,runId));
        }else await runner.pause(identity(current));
      }catch{const current=runRow(projectId,runId);if(ACTIVE.has(current.state)){tx(()=>uncertainty(current,'NETWORK_DENIAL_UNVERIFIED'));await terminate(current,'failed','DENIAL_PAUSE_UNCERTAIN');}}
      return get(actor,projectId,runId);
    }
    const r=runRow(projectId,runId);if(approval.kind==='consequential_action')await executeCandidate(r,approval.payload.candidate,approval.payload.snapshot_ref,approval.id,approval.payload.page);
    else if(approval.kind==='input_draft'){await approveDraft(actor,runRow(projectId,runId),approval);}
    else if(approval.kind==='network_effect'){const grant=tx(()=>{const current=runRow(projectId,runId);livePins(current);if(current.fence!==approval.fence)fail(409,'APPROVAL_STALE');write("UPDATE ops_selected_browser_approvals SET state='consumed',consumed_at=? WHERE id=?",stamp(),approval.id);return{schema:'selected-browser-request-approval.v1',id:approval.id,identity:identity(current),request_ref:approval.payload.request_ref,binding_sha256:approval.payload.binding_sha256,approval_ref:{id:approval.id,sha256:approval.action_sha256},human_context:approval.payload.purpose,expires_at:new Date(Math.min(Date.parse(approval.expires_at),Date.parse(stamp())+30000)).toISOString(),purpose_sha256:browserDraftHash(approval.payload.purpose),request:approval.payload};});try{if(typeof runner.approveRequest!=='function')fail(409,'NETWORK_APPROVAL_UNAVAILABLE');await runner.approveRequest(identity(r),grant);await settlePendingAction(runRow(projectId,runId));}catch{await terminate(runRow(projectId,runId),'failed','NETWORK_APPROVAL_UNCERTAIN');}}
    else{try{await settlePendingAction(r);await activateApprovedDestinations(runRow(projectId,runId));}catch{tx(()=>uncertainty(runRow(projectId,runId),'DESTINATION_BLOCK_SETTLEMENT_UNKNOWN'));await terminate(runRow(projectId,runId),'failed','DESTINATION_BLOCK_UNCERTAIN');}}
    return get(actor,projectId,runId);
  }
  async function takeover(actor,projectId,runId,expected){const r=tx(()=>{const current=checked(actor,projectId,runId,expected,{proof:true});if(current.execution_mode==='public_navigation')fail(409,'PUBLIC_AUTHENTICATION_UNAVAILABLE');if(!['running','paused','awaiting_approval'].includes(current.state)||current.controller_user_id)fail(409,'TAKEOVER_UNAVAILABLE');if(one("SELECT 1 FROM ops_selected_browser_steps WHERE run_id=? AND state='reserved'",runId)||one("SELECT 1 FROM ops_selected_browser_model_reservations WHERE run_id=? AND state='reserved'",runId))fail(409,'ACTION_IN_FLIGHT_CANCEL_AVAILABLE');livePins(current);if(typeof runner?.assertTakeover!=='function'||runner.assertTakeover(identity(current),{controller_id:actor.id,session_id:actor.jti??null})!==true)fail(409,'VERIFIED_LIVE_VIEWER_REQUIRED');staleApprovals(current);event(current,'TAKEOVER_AUTHORIZED',{},actor);return mutate(current,'preparing',{manual_auth:1,controller_user_id:actor.id,controller_session_id:actor.jti??null,result_code:'TAKING_CONTROL'});});try{await runner.takeover(identity(r),{controller_id:actor.id,session_id:actor.jti??null,manual_auth:true});tx(()=>{const current=runRow(projectId,runId);if(current.state==='preparing'&&current.fence===r.fence){livePins(current);if(runner.assertTakeover(identity(current),{controller_id:actor.id,session_id:actor.jti??null})!==true)fail(409,'VERIFIED_LIVE_VIEWER_REQUIRED');mutate(current,'human_control',{result_code:null});}});}catch{await terminate(r,'failed','TAKEOVER_UNCERTAIN');}return get(actor,projectId,runId);}
  function authController(actor,r,{preparing=false}={}){
    access(actor,r.project_id,'run');control(actor);
    if(!(r.state==='human_control'||preparing&&r.state==='preparing'&&r.result_code==='AUTHENTICATION_READBACK_PENDING')||r.manual_auth!==1||!ownsController(r,actor)||!r.controller_session_id||r.controller_session_id!==actor.jti)fail(403,'AUTHENTICATION_CONTROLLER_REQUIRED');
    livePins(r);
    if(typeof runner?.assertTakeover!=='function'||runner.assertTakeover(identity(r),{controller_id:actor.id,session_id:actor.jti})!==true||!ownsAuthenticationViewer(r,actor))fail(409,'VERIFIED_LIVE_VIEWER_REQUIRED');
  }
  function validateAuthInventory(actor,r,input){
    const inventory=parse(selectedAuthInventorySchema,input);authController(actor,r);
    if(Object.entries(identity(r)).some(([key,value])=>inventory[key]!==value)||inventory.controller_id!==actor.id||inventory.session_id!==actor.jti||inventory.inventory_sha256!==selectedAuthInventoryDigest(inventory)||inventory.auth_effects_acknowledged!==confirmedAuthCount(r)||inventory.auth_effects_acknowledged>inventory.effects_sent)fail(502,'AUTHENTICATION_INVENTORY_INVALID');
    if(inventory.inflight||inventory.pending_count||inventory.effects_uncertain||one("SELECT 1 FROM ops_selected_browser_approvals WHERE run_id=? AND state IN('pending','approved')",r.id)||one("SELECT 1 FROM ops_selected_browser_steps WHERE run_id=? AND state='reserved'",r.id)||one("SELECT 1 FROM ops_selected_browser_model_reservations WHERE run_id=? AND state='reserved'",r.id))fail(409,'AUTHENTICATION_REQUESTS_PENDING');
    const network=JSON.parse(r.network_state_json);
    if(inventory.effects_sent<network.effects_sent||inventory.effects_uncertain<network.effects_uncertain)fail(502,'NETWORK_COUNTERS_REGRESSED');
    const refs=new Set(),bindings=new Set(),c=JSON.parse(r.configuration_json);
    for(const request of inventory.requests){
      if(refs.has(request.request_ref)||bindings.has(request.binding_sha256))fail(502,'AUTHENTICATION_INVENTORY_INVALID');refs.add(request.request_ref);bindings.add(request.binding_sha256);
      const origin=new URL(request.origin),allowed=c.destinations.allowed_origins.some(d=>d.origin===request.origin&&d.roles.includes('authentication'))||!!one("SELECT 1 FROM ops_selected_browser_destination_grants WHERE run_id=? AND attempt_id=? AND fence=? AND origin=? AND json_extract(grant_json,'$.role')='authentication' AND consumed_at IS NOT NULL AND expires_at>?",r.id,r.attempt_id,r.fence,request.origin,stamp());
      if(origin.origin!==request.origin||!['https:','http:'].includes(origin.protocol)||origin.username||origin.password||!allowed||!request.path_preview.startsWith('/')||/[?#\r\n]/.test(request.path_preview))fail(502,'AUTHENTICATION_DESTINATION_INVALID');
      const a=one('SELECT * FROM ops_selected_browser_approvals WHERE id=? AND run_id=?',request.approval_ref.id,r.id);
      if(!a||a.kind!=='network_effect'||a.state!=='consumed'||a.attempt_id!==r.attempt_id||a.fence!==r.fence||a.action_sha256!==request.approval_ref.sha256||a.action_sha256!==request.binding_sha256||a.decided_by!==actor.id||!a.consumed_at)fail(502,'AUTHENTICATION_APPROVAL_INVALID');
      const p=JSON.parse(a.payload_json);
      if(['request_ref','binding_sha256','request_sha256','url_sha256','body_sha256','body_bytes','origin','role','method'].some(key=>p[key]!==request[key])||request.purpose_sha256!==browserDraftHash(p.purpose)||request.human_context!==p.purpose||one('SELECT 1 FROM ops_selected_browser_auth_confirmed_requests WHERE run_id=? AND attempt_id=? AND fence=? AND (request_ref=? OR binding_sha256=?)',r.id,r.attempt_id,r.fence,request.request_ref,request.binding_sha256))fail(502,'AUTHENTICATION_APPROVAL_INVALID');
    }
    if(inventory.requests.length>inventory.effects_sent-inventory.auth_effects_acknowledged)fail(502,'AUTHENTICATION_INVENTORY_INVALID');
    return inventory;
  }
  async function authenticationReadback(actor,projectId,runId){
    const initial=runRow(projectId,runId);authController(actor,initial);
    if(typeof runner?.authenticationInventory!=='function'||typeof runner?.confirmAuthentication!=='function')fail(409,'AUTHENTICATION_READBACK_UNAVAILABLE');
    await refresh(actor,projectId,runId);const r=runRow(projectId,runId);authController(actor,r);if(r.fence!==initial.fence)fail(409,'STALE_ATTEMPT_FENCE');
    const raw=await runner.authenticationInventory(identity(r),{controller_id:actor.id,session_id:actor.jti});
    const current=runRow(projectId,runId);authController(actor,current);if(current.fence!==r.fence)fail(409,'STALE_ATTEMPT_FENCE');
    return {revision:current.revision,inventory:validateAuthInventory(actor,current,raw)};
  }
  async function confirmAuthentication(actor,projectId,runId,expected,input){
    const v=parse(selectedAuthConfirmationInputSchema,input),initial=checked(actor,projectId,runId,expected,{proof:true});authController(actor,initial);
    const {inventory}=await authenticationReadback(actor,projectId,runId);
    if(inventory.inventory_sha256!==v.inventory_sha256)fail(409,'AUTHENTICATION_INVENTORY_STALE');
    const selected=new Set();for(const ref of v.request_refs){if(selected.has(ref.request_ref)||!inventory.requests.some(request=>request.request_ref===ref.request_ref&&request.binding_sha256===ref.binding_sha256))fail(409,'AUTHENTICATION_REQUEST_STALE');selected.add(ref.request_ref);}
    const authorized=tx(()=>{
      const current=runRow(projectId,runId);authController(actor,current);if(current.fence!==initial.fence)fail(409,'STALE_ATTEMPT_FENCE');
      validateAuthInventory(actor,current,inventory);
      const id=uuid(),expires=new Date(Math.min(Date.parse(current.deadline_at),Date.parse(stamp())+30000)).toISOString();
      const base={schema:'selected-browser-auth-confirmation.v1',...identity(current),controller_id:actor.id,session_id:actor.jti,viewer_conn_sha256:inventory.viewer_conn_sha256,inventory_sha256:inventory.inventory_sha256,ledger_sha256:inventory.ledger_sha256,request_refs:inventory.requests.filter(request=>selected.has(request.request_ref)),reviewed_statement:SELECTED_BROWSER_AUTH_STATEMENT,expires_at:expires};
      const packet=parse(selectedAuthConfirmationPacketSchema,{...base,confirmation_ref:{id,sha256:selectedAuthDigest(base)}});
      write("INSERT INTO ops_selected_browser_auth_confirmations(id,run_id,attempt_id,fence,controller_user_id,controller_session_id,configuration_sha256,guide_sha256,consent_sha256,inventory_sha256,request_sha256,packet_json,state,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'authorized',?,?)",id,current.id,current.attempt_id,current.fence,actor.id,actor.jti,current.configuration_sha256,current.guide_sha256,current.consent_sha256,inventory.inventory_sha256,selectedAuthDigest(packet),JSON.stringify(packet),stamp(),expires);
      event(current,'AUTHENTICATION_READBACK_AUTHORIZED',{confirmation_id:id,inventory_sha256:inventory.inventory_sha256,request_count:packet.request_refs.length},actor);
      return {packet,r:mutate(current,'preparing',{result_code:'AUTHENTICATION_READBACK_PENDING'}),previous_count:inventory.auth_effects_acknowledged};
    });
    try{
      const ack=parse(selectedAuthConfirmationAckSchema,await runner.confirmAuthentication(identity(authorized.r),authorized.packet));
      if(Object.entries(identity(authorized.r)).some(([key,value])=>ack[key]!==value)||ack.controller_id!==actor.id||ack.session_id!==actor.jti||ack.viewer_conn_sha256!==authorized.packet.viewer_conn_sha256||hash(ack.confirmation_ref)!==hash(authorized.packet.confirmation_ref)||ack.request_sha256!==selectedAuthDigest(authorized.packet)||ack.inventory_sha256!==inventory.inventory_sha256||ack.effects_sent!==inventory.effects_sent||ack.auth_effects_acknowledged!==authorized.previous_count+authorized.packet.request_refs.length||ack.auth_effects_acknowledged>ack.effects_sent)fail(502,'AUTHENTICATION_RECEIPT_INVALID');
      tx(()=>{
        const current=runRow(projectId,runId);authController(actor,current,{preparing:true});if(current.fence!==authorized.r.fence||stamp()>=authorized.packet.expires_at||confirmedAuthCount(current)!==authorized.previous_count)fail(409,'AUTHENTICATION_CONFIRMATION_FENCED');
        for(const request of authorized.packet.request_refs)write('INSERT INTO ops_selected_browser_auth_confirmed_requests(confirmation_id,run_id,attempt_id,fence,request_ref,binding_sha256,approval_id,request_json) VALUES(?,?,?,?,?,?,?,?)',authorized.packet.confirmation_ref.id,current.id,current.attempt_id,current.fence,request.request_ref,request.binding_sha256,request.approval_ref.id,JSON.stringify(request));
        write("UPDATE ops_selected_browser_auth_confirmations SET state='accepted',acknowledged_count=?,receipt_json=?,accepted_at=? WHERE id=? AND state='authorized'",ack.auth_effects_acknowledged,JSON.stringify(ack),stamp(),authorized.packet.confirmation_ref.id);
        const network={...JSON.parse(current.network_state_json),effects_sent:ack.effects_sent,auth_effects_acknowledged:ack.auth_effects_acknowledged};
        if(network.effects_sent===network.auth_effects_acknowledged&&!network.effects_uncertain)write("UPDATE ops_selected_browser_uncertainties SET state='reconciled',decision='human_authentication_readback',decided_by=?,decided_at=? WHERE run_id=? AND kind='EXTERNAL_EFFECT_UNVERIFIED' AND state='unresolved'",actor.id,stamp(),current.id);
        mutate(current,'human_control',{network_state_json:JSON.stringify(network),result_code:null});event(current,'AUTHENTICATION_READBACK_ACCEPTED',{confirmation_id:authorized.packet.confirmation_ref.id,request_sha256:ack.request_sha256,acknowledged_count:ack.auth_effects_acknowledged},actor);
      });
      await refresh(actor,projectId,runId);
    }catch{
      tx(()=>{write("UPDATE ops_selected_browser_auth_confirmations SET state='uncertain' WHERE id=? AND state='authorized'",authorized.packet.confirmation_ref.id);uncertainty(runRow(projectId,runId),'AUTHENTICATION_READBACK_UNVERIFIED');});
      if(ACTIVE.has(runRow(projectId,runId).state))await terminate(runRow(projectId,runId),'failed','AUTHENTICATION_READBACK_UNCERTAIN');
    }
    return get(actor,projectId,runId);
  }
  async function release(actor,projectId,runId,expected){const initial=checked(actor,projectId,runId,expected,{proof:true});if(initial.state!=='human_control'||!ownsController(initial,actor))fail(403,'TAKEOVER_NOT_YOURS');await refresh(actor,projectId,runId);const r=tx(()=>{const current=runRow(projectId,runId);if(current.fence!==initial.fence||current.state!=='human_control'||!ownsController(current,actor))fail(403,'TAKEOVER_NOT_YOURS');control(actor);livePins(current);if(hasUnconfirmedEffects(current))fail(409,'AUTHENTICATION_READBACK_REQUIRED');const n=JSON.parse(current.network_state_json);if(n.inflight_action||n.pending_count||one("SELECT 1 FROM ops_selected_browser_approvals WHERE run_id=? AND state IN('pending','approved')",runId))fail(409,'REQUEST_CONTINUATION_REQUIRED');event(current,'TAKEOVER_RELEASE_AUTHORIZED',{},actor);return mutate(current,'preparing',{result_code:'RELEASING_CONTROL'});});try{await runner.release(identity(r),{controller_id:actor.id,session_id:actor.jti??null});tx(()=>{const current=runRow(projectId,runId);if(current.state==='preparing'&&current.fence===r.fence){livePins(current);mutate(current,'paused',{manual_auth:0,controller_user_id:null,controller_session_id:null,result_code:null});}});}catch{await terminate(r,'failed','RELEASE_UNCERTAIN');}return get(actor,projectId,runId);}
  function assertLive(actor,projectId,runId){access(actor,projectId,'read');const r=runRow(projectId,runId);if(r.execution_mode!=='public_navigation')control(actor,{elevation:false});else livePins(r);if(!ACTIVE.has(r.state)||r.state==='stopping')fail(409,'LIVE_UNAVAILABLE');if(r.manual_auth&&!ownsController(r,actor))fail(403,'MANUAL_AUTH_PRIVATE');return {...identity(r),project_id:projectId,controller_id:ownsController(r,actor)?actor.id:null,session_id:actor.jti??null,manual_auth:r.manual_auth===1};}
  // One transient frame at a time across the shared runner. No frame cache,
  // artifact, model observation, URL, or page text is retained by this service.
  let frameBusy=false,frameNext=0;
  function publicFrameIdentity(actor,projectId,runId,pins){
    if(!validId(pins?.attempt_id)||!Number.isSafeInteger(pins?.fence)||pins.fence<1)fail(400,'PUBLIC_VIEW_PINS_INVALID');
    assertLive(actor,projectId,runId);const r=runRow(projectId,runId);
    const session=validId(actor.jti)&&one('SELECT * FROM sessions WHERE id=? AND user_id=?',actor.jti,actor.id);
    if(!session||session.revoked_at||session.expires_at<=stamp())fail(403,'HUMAN_SESSION_REQUIRED');
    if(r.execution_mode!=='public_navigation'||!isPublicNavigation(JSON.parse(r.configuration_json))||r.manual_auth||r.controller_user_id)fail(409,'PUBLIC_VIEW_UNAVAILABLE');
    if(r.state!=='running'||r.attempt_id!==pins.attempt_id||r.fence!==pins.fence)fail(409,'PUBLIC_VIEW_FENCED');
    return identity(r);
  }
  async function publicFrame(actor,projectId,runId,pins){
    const initial=publicFrameIdentity(actor,projectId,runId,pins);
    if(typeof runner?.view!=='function')fail(503,'PUBLIC_VIEW_UNAVAILABLE');
    if(frameBusy||clock().getTime()<frameNext)fail(429,'PUBLIC_VIEW_RATE_LIMITED');
    frameBusy=true;frameNext=clock().getTime()+2000;
    try{
      const frame=await runner.view(initial);
      const current=publicFrameIdentity(actor,projectId,runId,pins);
      if(hash(current)!==hash(initial))fail(409,'PUBLIC_VIEW_FENCED');
      return {png_base64:frame.png_base64,width:frame.width,height:frame.height,attempt_id:initial.attempt_id,fence:initial.fence,captured_at:stamp()};
    }catch(error){
      // A lost reply does not prove the guest read finished. Avoid queuing
      // another capture during its fixed30s host execution bound.
      frameNext=clock().getTime()+30000;throw error;
    }finally{frameBusy=false;}
  }
  async function live(actor,projectId,runId,options={}){const permitted=assertLive(actor,projectId,runId);return runner.live({run_id:permitted.run_id,attempt_id:permitted.attempt_id,fence:permitted.fence,policy_sha256:permitted.policy_sha256},{...options,controller_id:permitted.controller_id,session_id:permitted.session_id,manual_auth:permitted.manual_auth});}
  async function controlInput(actor,projectId,runId,expected,input){
    const value=parse(selectedHumanInputSchema,input),r=tx(()=>{const current=checked(actor,projectId,runId,expected,{proof:true});if(current.state!=='human_control'||!ownsController(current,actor))fail(403,'TAKEOVER_NOT_YOURS');livePins(current);if(runner.assertTakeover(identity(current),{controller_id:actor.id,session_id:actor.jti??null})!==true)fail(409,'VERIFIED_LIVE_VIEWER_REQUIRED');const usage=JSON.parse(current.usage_json),c=JSON.parse(current.configuration_json);if(usage.actions>=c.budgets.max_actions)fail(409,'ACTION_BUDGET_EXHAUSTED');usage.actions++;const next=mutate(current,'human_control',{ordinal:current.ordinal+1,usage_json:JSON.stringify(usage)});event(next,'HUMAN_INPUT_RESERVED',{kind:value.kind,ordinal:next.ordinal},actor);return next;});
    try{if(typeof runner.control!=='function')fail(409,'HUMAN_INPUT_UNAVAILABLE');await runner.control(identity(r),{controller_id:actor.id,ordinal:r.ordinal,input:value});await refresh(actor,projectId,runId);}catch{tx(()=>uncertainty(runRow(projectId,runId),'HUMAN_INPUT_OUTCOME_UNKNOWN'));await terminate(runRow(projectId,runId),'failed','HUMAN_INPUT_UNCERTAIN');}
    return get(actor,projectId,runId);
  }
  // Called only by the runtime's registered-viewer close callback. It deliberately
  // does not rely on the disconnected session still having control permission.
  async function viewerClosed(ref,holder){
    const r=one('SELECT * FROM ops_selected_browser_runs WHERE id=?',ref?.run_id??'');
    if(!r||!['human_control','preparing'].includes(r.state)||r.manual_auth!==1||Object.entries(identity(r)).some(([key,value])=>ref[key]!==value)||r.controller_user_id!==holder?.controller_id||r.controller_session_id!==(holder.session_id??null))return {closed:false};
    const stopped=await terminate(r,'failed','CONTROL_VIEWER_DISCONNECTED');return {closed:true,run_id:r.id,state:stopped.state};
  }
  async function retryCleanup(actor,projectId,runId,expected){
    const original=checked(actor,projectId,runId,expected,{proof:true});if(original.state!=='uncertain'||!one("SELECT 1 FROM ops_selected_browser_uncertainties WHERE run_id=? AND kind='CLEANUP_UNVERIFIED' AND state='unresolved'",runId))fail(409,'CLEANUP_RETRY_NOT_REQUIRED');
    let receipt;try{receipt=parse(receiptSchema,await runner?.stop?.({...identity(original),reason:'RETRY_CLEANUP_ONLY'}));if(receipt.public_navigation_evidence&&original.execution_mode!=='public_navigation'||Object.entries(identity(original)).some(([k,v])=>receipt[k]!==v)||verifyReceipt(receipt,identity(original))!==true)fail(502,'CLEANUP_RECEIPT_INVALID');}catch{fail(409,'SIGNED_CLEANUP_RECEIPT_REQUIRED');}
    const closure=verifiedClosure(receipt);
    tx(()=>{const current=runRow(projectId,runId);assertRevision(expected,current.revision);if(current.fence!==original.fence)fail(409,'STALE_ATTEMPT_FENCE');recordFinalNetwork(current,receipt);write('UPDATE ops_selected_browser_attempts SET state=?,ended_at=?,cleanup_json=? WHERE id=?',closure?'closed':'cleanup_unverified',stamp(),JSON.stringify(receipt),current.attempt_id);if(closure)write("UPDATE ops_selected_browser_uncertainties SET state='reconciled',decision='signed_cleanup_verified',decided_by=?,decided_at=? WHERE run_id=? AND kind='CLEANUP_UNVERIFIED' AND state='unresolved'",actor.id,stamp(),runId);mutate(current,'uncertain');event(current,closure?'CLEANUP_REVERIFIED':'CLEANUP_STILL_UNVERIFIED',{},actor);});
    if(!closure)fail(409,'SIGNED_CLEANUP_RECEIPT_REQUIRED');return get(actor,projectId,runId);
  }
  function reconcile(actor,projectId,runId,uncertaintyId,expected,input){const v=parse(selectedReconcileSchema,input);return tx(()=>{const r=checked(actor,projectId,runId,expected,{proof:true});if(!TERMINAL.has(r.state))fail(409,'RUN_NOT_TERMINAL');const u=one("SELECT * FROM ops_selected_browser_uncertainties WHERE id=? AND run_id=? AND state='unresolved'",uncertaintyId,r.id);if(!u)fail(409,'UNCERTAINTY_STALE');if(u.kind==='CLEANUP_UNVERIFIED')fail(409,'SIGNED_CLEANUP_RECEIPT_REQUIRED');write("UPDATE ops_selected_browser_uncertainties SET state='reconciled',decided_by=?,decided_at=?,decision=? WHERE id=?",actor.id,stamp(),v.decision,u.id);event(r,'UNCERTAINTY_RECONCILED',{uncertainty_id:u.id,decision:v.decision},actor);mutate(r,r.state);return dto(actor,runRow(projectId,runId));});}
  async function recover(){const rows=all("SELECT * FROM ops_selected_browser_runs WHERE state IN('preparing','running','paused','awaiting_approval','human_control','stopping')");for(const r of rows)await terminate(r,'failed','PROCESS_RECOVERY_NO_REPLAY');return {recovered:rows.length};}
  async function pump(runId,{maxSteps=20}={}){if(one('SELECT execution_mode FROM ops_selected_browser_runs WHERE id=?',runId)?.execution_mode==='public_navigation')return 'running';if(!Number.isSafeInteger(maxSteps)||maxSteps<1||maxSteps>100)fail(400,'INVALID_PUMP_LIMIT');for(let i=0;i<maxSteps;i++){const r=one('SELECT * FROM ops_selected_browser_runs WHERE id=?',runId);if(!r||r.state!=='running')break;await step({id:r.started_by},r.project_id,r.id,r.revision);if(one("SELECT 1 FROM ops_selected_browser_steps WHERE run_id=? AND state='reserved'",runId))break;}return one('SELECT state FROM ops_selected_browser_runs WHERE id=?',runId)?.state??null;}
  async function sweep(){const rows=all("SELECT * FROM ops_selected_browser_runs WHERE state IN('preparing','running','paused','awaiting_approval','human_control')");for(const r of rows){try{livePins(r);}catch(e){await terminate(r,'failed',e.code??'CURRENT_ACCESS_LOST');}}return {checked:rows.length};}
  const start=(actor,pid,cid,input)=>startCore(actor,pid,cid,input);
  const startScheduled=(actor,pid,cid,input)=>startCore(actor,pid,cid,input,true);
  return {readiness,publicReadiness,consent,start,startScheduled,openPublic,get,list,sources,refresh,step,pump,pause,resume,cancel,decision,takeover,release,authenticationReadback,confirmAuthentication,controlInput,viewerClosed,assertLive,live,publicFrame,reconcile,retryCleanup,recover,sweep,authorizeAttempt,verifyInputDraftApproval,verifyRetainedInputDraftApproval,verifyObservationOrigin};
}
