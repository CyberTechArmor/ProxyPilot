export const BROWSER_CONSENT = 'Send this approved guide and bounded selected-site content to the model provider';
export const CONVERSION_DISCLOSURE = 'Send the original instructions and explicitly approved private image or file content to the model provider to suggest an editable browser-agent draft';
export const ASSET_REVIEW = 'I reviewed this private file and approve its use as a browser upload or task input';
export const ARTIFACT_REVIEW = 'I reviewed the exact file for private data and approve this release';
export const ACTIONS = Object.freeze(['navigate','read','click','scroll','type','wait','download','copy','paste','screenshot','upload','submit']);
export const TERMINAL = Object.freeze(['completed','cancelled','failed','uncertain']);
export const budgetFields = Object.freeze([
  ['max_seconds','Maximum seconds',1,3600,1],['max_actions','Maximum actions',1,200,1],
  ['max_model_calls','Maximum model calls',1,100,1],['max_tokens','Maximum tokens',1,200000,1],
  ['max_usd','Maximum spend (USD)',0.001,20,0.001],['max_requests','Maximum requests',1,2000,1],
  ['max_response_bytes','Maximum response bytes',1,268435456,1],['max_artifact_bytes','Maximum artifact bytes',1,67108864,1],
  ['cpu','CPU limit',1,8,1],['memory_mib','Memory (MiB)',1024,8192,1],['temporary_disk_mib','Temporary disk (MiB)',64,2048,1],
]);
export const browserPaths = base => ({ configurations:`${base}/browser-agent-configurations`, runs:`${base}/browser-agent-runs`, assets:`${base}/browser-assets` });
export function parseDraft(text) {
  if (typeof text !== 'string' || new TextEncoder().encode(text).length > 200000) throw new Error('Structured settings exceed 200,000 UTF-8 bytes.');
  let input; try { input=JSON.parse(text); } catch { throw new Error('Structured settings must be valid JSON. Your input is retained.'); }
  if(input?.configuration&&(Object.keys(input).some(key=>!['configuration','source_text'].includes(key))||'source_text'in input&&typeof input.source_text!=='string')) throw new Error('The import wrapper accepts configuration and optional original source_text only.');
  const configuration=input?.configuration ?? input;
  if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration) || configuration.schema !== 'proxypilot.browser-agent.proposal.v1' || configuration.workflow !== 'selected_browser_v1') throw new Error('Use the selected-browser v1 configuration.');
  return configuration;
}
export function wrappedSourceText(text) {
  parseDraft(text);const input=JSON.parse(text);
  return input.configuration&&typeof input.source_text==='string'?input.source_text:null;
}
export function hasEditableDraftShape(config) {
  const strings=value=>Array.isArray(value)&&value.every(v=>typeof v==='string');
  return !!config&&typeof config.name==='string'&&typeof config.work?.instructions==='string'&&strings(config.work.success_criteria)&&
    strings(config.destinations?.entry_urls)&&Array.isArray(config.destinations.allowed_origins)&&config.destinations.allowed_origins.every(d=>d&&typeof d.id==='string'&&typeof d.origin==='string'&&strings(d.roles)&&typeof d.session_headers==='string')&&
    strings(config.permissions?.actions)&&config.budgets&&typeof config.budgets==='object'&&!Array.isArray(config.budgets)&&Array.isArray(config.artifacts?.upload_asset_refs)&&config.artifacts.upload_asset_refs.every(ref=>ref&&typeof ref.id==='string'&&typeof ref.sha256==='string');
}
export function readyForStart(ready, saved, project, draft = {}) {
  return !draft.dirty && !draft.conflict && !!saved && ready?.contract_version==='selected-browser.v1'&&ready.can_start===true && !project.archived_at && ['owner','operator','editor','reviewer'].includes(project.own_role) &&
    ready.pins?.project_revision===project.revision && ready.pins?.configuration_revision===saved.revision &&
    ready.pins?.configuration_sha256===saved.configuration_sha256 &&
    saved.configuration.work.guide_ref?.id===project.current_version?.id &&
    saved.configuration.work.guide_ref?.sha256===project.current_version?.content_hash;
}
export function startPayload(saved, project, key) {
  return {project_revision:project.revision,configuration_revision:saved.revision,configuration_sha256:saved.configuration_sha256,idempotency_key:key};
}
export function approvalPayload(approval, run, decision) {
  if (!['approve','deny'].includes(decision) || !approval?.id || !/^[a-f0-9]{64}$/.test(approval.action_sha256??'') || approval.state!=='pending') throw new Error('This approval is no longer pending. Refresh the run.');
  return {decision,action_sha256:approval.action_sha256};
}
export function safeBrowserCitation(value) {
  try {const u=new URL(value);return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password?u.href:null;}catch{return null;}
}
export function browserLiveEndpoint(base, id, location=globalThis.location) {
  if (!/^\/[a-f0-9-]{36}$/i.test(base) || !/^[a-f0-9-]{36}$/i.test(id)) throw new Error('Invalid browser run identity.');
  return `${location.protocol==='https:'?'wss':'ws'}://${location.host}/api/operational-projects${base}/browser-agent-runs/${id}/live`;
}
export function assetRef(asset) {return {id:asset.id,sha256:asset.sha256,mime_type:asset.mime_type,byte_count:asset.byte_count};}
export async function verifyPrivateBlob(blob, ref) {
  if (!ref || !/^[a-f0-9]{64}$/.test(ref.sha256??'') || blob.size!==ref.byte_count || blob.size>16777216) throw new Error('Private file bytes do not match the reviewed reference. Refresh before reviewing.');
  const digest=new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256',await blob.arrayBuffer()));
  if([...digest].map(n=>n.toString(16).padStart(2,'0')).join('')!==ref.sha256) throw new Error('Private file hash changed. Refresh before reviewing.');
  return blob;
}
export async function filePayload(file, key) {
  if (!file || file.size<1 || file.size>16777216) throw new Error('Choose a private file between 1 byte and 16 MiB.');
  const bytes=new Uint8Array(await file.arrayBuffer());
  const digest=new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256',bytes));
  let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
  if(!['application/pdf','text/plain','text/csv','image/png','image/jpeg'].includes(file.type))throw new Error('Choose a PDF, plain text, CSV, PNG or JPEG file.');
  return {idempotency_key:key,byte_count:bytes.length,mime_type:file.type,sha256:[...digest].map(n=>n.toString(16).padStart(2,'0')).join(''),bytes_base64:btoa(binary)};
}
