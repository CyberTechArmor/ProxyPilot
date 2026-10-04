import { createPublicKey, verify } from 'node:crypto';
import { z } from 'zod';
import { OperationsError } from './operational-projects-logic.js';
import { browserAgentProposalSchema, browserDraftHash, canonicalBrowserDraft, validateBrowserDraftImport } from './operational-browser-agent-proposal.js';

export const BROWSER_MODEL_CONTRACT = 'selected-browser-model.v1';
export const BROWSER_MODEL_MAX_PROMPT_BYTES = 16000;
export const BROWSER_MODEL_MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export const browserModelError = (code, status = 409) => Object.assign(new OperationsError(status, code.replaceAll('_', ' ')), { code });
const reject = code => { throw browserModelError(code); };
const uuid = z.string().uuid(), hash = z.string().regex(/^[a-f0-9]{64}$/);
const bytes = (max, min = 0) => z.string().min(min).refine(v => v.isWellFormed() && Buffer.byteLength(v, 'utf8') <= max);
export const browserSourceRefSchema = z.object({ id: uuid, sha256: hash, mime_type: z.string().min(1).max(100), byte_count: z.number().int().min(1).max(67108864) }).strict();
const snapshot = z.object({ id: uuid, sha256: hash }).strict();
const source = z.object({ ref: browserSourceRefSchema, content_sha256: hash, content_kind: z.enum(['text', 'image']), image_mime_type:z.enum(['image/png','image/jpeg']).nullable(),
  text: bytes(12000).nullable(), image_base64: z.string().max(Math.ceil(BROWSER_MODEL_MAX_IMAGE_BYTES / 3) * 4).nullable() }).strict();
const candidate = z.object({ id: uuid, sha256: hash, operation: z.enum(['navigate','read','click','scroll','type','wait','download','copy','paste','screenshot','upload','submit']),
  label: bytes(300), effect: z.enum(['read','local','external_change','unknown']) }).strict();
export const browserModelRequestSchema = z.object({ contract_version: z.literal(BROWSER_MODEL_CONTRACT), purpose: z.enum(['conversion','decision','report','draft_input']),
  run_id: uuid, attempt_id:uuid.nullable(),fence:z.number().int().positive().nullable(),call_id: uuid, project_id: uuid, project_revision: z.number().int().positive(), project_limits_revision: z.number().int().positive(),
  policy_hash: hash, guide_version_id: uuid, guide_hash: hash, consent_hash: hash, price_table_revision:z.number().int().positive(), deadline_at: z.string().datetime(),
  reservation:z.object({tokens:z.number().int().min(1).max(4000000),usd:z.number().finite().min(0).max(20)}).strict(),
  input: z.object({ guide: bytes(4000, 1), instructions: bytes(6000, 1), source_inputs: z.array(source).max(9), snapshot_ref: snapshot.nullable(),
    candidates: z.array(candidate).max(20), facts: z.array(bytes(1000, 1)).max(30) }).strict(),
  limits: z.object({ max_tokens: z.number().int().min(1).max(4000000), max_usd: z.number().finite().positive().max(20),
    max_calls: z.number().int().min(1).max(100), max_output_tokens: z.number().int().min(1).max(6000) }).strict() }).strict();
const decisionSchema = z.union([z.object({kind:z.literal('candidate'),candidate_id:uuid}).strict(),
  z.object({kind:z.enum(['done','escalate']),reason:bytes(1000,1)}).strict()]);
const reportSchema = z.object({summary:bytes(8192,1),citations:z.array(uuid).max(50),limitations:z.array(bytes(1000,1)).max(12)}).strict();
const inputDraftSchema=z.object({candidate_id:uuid,text:bytes(12000,1),purpose:bytes(500,1)}).strict();
const conversionSchema = z.object({configuration:browserAgentProposalSchema, assumptions:z.array(bytes(1000,1)).max(20),
  warnings:z.array(bytes(1000,1)).max(20), ambiguities:z.array(z.object({field:bytes(200,1),question:bytes(1000,1)}).strict()).max(20)}).strict();
const price=z.string().regex(/^(0|[1-9][0-9]{0,3})(\.[0-9]{1,6})?$/);
const statusSchema=z.object({contract_version:z.literal(BROWSER_MODEL_CONTRACT),available:z.literal(true),
  price_table_revision:z.number().int().positive(),prices:z.object({input:price,cache_write:price,output:price,cached_input:price}).strict(),
  valid_until:z.string().datetime(),attestation:z.string().min(1)}).strict();

export function browserModelRequestDigest(request) {
  const n = Buffer.alloc(8); n.writeDoubleBE(request.limits.max_usd);
  const reserved=Buffer.alloc(8);reserved.writeDoubleBE(request.reservation.usd);
  return browserDraftHash(canonicalBrowserDraft({...request, limits:{...request.limits,max_usd:n.toString('hex')},reservation:{...request.reservation,usd:reserved.toString('hex')}}));
}
export function validateBrowserModelRequest(input, {clock=()=>Date.now()}={}) {
  const parsed = browserModelRequestSchema.safeParse(input);
  if (!parsed.success) reject('BROWSER_MODEL_REQUEST_INVALID');
  const r = parsed.data;
  if (Date.parse(r.deadline_at) <= clock() || Date.parse(r.deadline_at) > clock()+180000) reject('DEADLINE');
  if (browserDraftHash(r.input.guide) !== r.guide_hash) reject('BROWSER_MODEL_GUIDE_MISMATCH');
  if(r.purpose==='conversion'?(r.attempt_id!==null||r.fence!==null):(!r.attempt_id||r.fence==null))reject('BROWSER_MODEL_ATTEMPT_INVALID');
  if(r.reservation.tokens>r.limits.max_tokens||r.reservation.usd>r.limits.max_usd)reject('BUDGET_EXHAUSTED');
  if (new Set(r.input.candidates.map(c=>c.id)).size !== r.input.candidates.length || new Set(r.input.source_inputs.map(s=>s.ref.id)).size !== r.input.source_inputs.length) reject('BROWSER_MODEL_INPUT_DUPLICATE');
  if (r.purpose === 'decision' && (!r.input.snapshot_ref || r.limits.max_output_tokens>256)) reject('BROWSER_MODEL_REQUEST_INVALID');
  if (!['decision','draft_input'].includes(r.purpose) && r.input.candidates.length) reject('BROWSER_MODEL_REQUEST_INVALID');
  if (r.purpose==='conversion' && (r.limits.max_calls!==1 || r.input.snapshot_ref || r.input.source_inputs.length>8)) reject('BROWSER_MODEL_REQUEST_INVALID');
  if (r.purpose==='report' && r.limits.max_output_tokens>2000) reject('BROWSER_MODEL_REQUEST_INVALID');
  if(r.purpose==='draft_input'&&(!r.input.snapshot_ref||!r.input.candidates.length||r.input.candidates.some(c=>!['type','paste'].includes(c.operation))||r.limits.max_output_tokens>2000))reject('BROWSER_MODEL_REQUEST_INVALID');
  let totalImages = 0;
  for (const s of r.input.source_inputs) {
    if (s.content_kind==='text') {
      if (s.text==null || s.image_base64!==null || s.image_mime_type!==null || browserDraftHash(s.text)!==s.content_sha256) reject('BROWSER_MODEL_SOURCE_INVALID');
    } else {
      if(s.text!==null || !s.image_base64 || !s.image_mime_type || !['image/png','image/jpeg'].includes(s.ref.mime_type) || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(s.image_base64)) reject('BROWSER_MODEL_SOURCE_INVALID');
      const b=Buffer.from(s.image_base64,'base64');totalImages+=b.length;
      if(!b.length || b.toString('base64')!==s.image_base64 || browserDraftHash(b)!==s.content_sha256) reject('BROWSER_MODEL_SOURCE_INVALID');
    }
  }
  if(totalImages>BROWSER_MODEL_MAX_IMAGE_BYTES||r.input.source_inputs.filter(s=>s.content_kind==='image').length>8)reject('BROWSER_MODEL_IMAGE_TOO_LARGE');
  // Image bytes are separately capped and conservatively reserved by the host.
  const prompt = {...r.input,source_inputs:r.input.source_inputs.map(s=>({...s,image_base64:s.image_base64?'[bounded image]':null}))};
  if(Buffer.byteLength(canonicalBrowserDraft(prompt))+2048>BROWSER_MODEL_MAX_PROMPT_BYTES)reject('PROMPT_TOO_LARGE');
  return r;
}
export function validateBrowserModelOutput(request, text) {
  let v;try {v=JSON.parse(text);}catch {reject('MODEL_INVALID');}
  const schema=request.purpose==='decision'?decisionSchema:request.purpose==='report'?reportSchema:request.purpose==='draft_input'?inputDraftSchema:conversionSchema;
  const parsed=schema.safeParse(v);if(!parsed.success)reject('MODEL_INVALID');v=parsed.data;
  if(request.purpose==='decision' && v.kind==='candidate' && !request.input.candidates.some(c=>c.id===v.candidate_id))reject('MODEL_OUTSIDE_CANDIDATES');
  if(request.purpose==='draft_input'&&!request.input.candidates.some(c=>c.id===v.candidate_id&&['type','paste'].includes(c.operation)))reject('MODEL_OUTSIDE_CANDIDATES');
  if(request.purpose==='report') {
    const ids=new Set(request.input.source_inputs.map(s=>s.ref.id));
    if(new Set(v.citations).size!==v.citations.length || v.citations.some(id=>!ids.has(id)))reject('MODEL_CITATION_INVALID');
  }
  if(request.purpose==='conversion') {
    try {validateBrowserDraftImport({configuration:v.configuration});}catch {reject('MODEL_INVALID');}
    // The model has no authority to rewrite the original instructions, input
    // pins, or current approved guide. Its exact proposed sites remain drafts.
    if(v.configuration.work.instructions!==request.input.instructions || canonicalBrowserDraft(v.configuration.work.source_inputs)!==canonicalBrowserDraft(request.input.source_inputs.map(s=>s.ref)) ||
      v.configuration.work.guide_ref?.sha256!==request.guide_hash || v.configuration.work.guide_ref?.id!==request.guide_version_id)reject('MODEL_SOURCE_PROVENANCE_INVALID');
    if(v.configuration.destinations.network_policy_ref!==null || v.configuration.artifacts.upload_asset_refs.some(ref=>!request.input.source_inputs.some(s=>canonicalBrowserDraft(s.ref)===canonicalBrowserDraft(ref))))reject('MODEL_SOURCE_PROVENANCE_INVALID');
  }
  return v;
}
function validUsage(r,request) {
  const u=r.usage;
  if(!u || Object.keys(u).sort().join(',')!=='completion_tokens,prompt_tokens' || ![u.prompt_tokens,u.completion_tokens].every(n=>Number.isSafeInteger(n)&&n>=0) || u.completion_tokens<1 ||
    !Number.isFinite(Number(r.settled_usd)) || Number(r.settled_usd)<0 || !Number.isSafeInteger(r.price_table_revision)||r.price_table_revision<1)reject('USAGE_MISSING');
  if(u.prompt_tokens+u.completion_tokens>request.limits.max_tokens || u.prompt_tokens+u.completion_tokens>request.reservation.tokens || u.completion_tokens>request.limits.max_output_tokens || Number(r.settled_usd)>request.limits.max_usd || Number(r.settled_usd)>request.reservation.usd)reject('BUDGET_EXHAUSTED');
}
export function createBrowserModelBridge({client,publicKeyPem,clock=()=>Date.now()}) {
  const key=createPublicKey(publicKeyPem);if(key.asymmetricKeyType!=='ed25519')reject('BROWSER_MODEL_BRIDGE_UNAVAILABLE');
  let prices=null;
  const attest=(r,prefix,kind)=>{
    const parts=String(r?.attestation).split('.');if(parts.length!==3||parts[0]!==prefix)reject('BROWSER_MODEL_RECEIPT_INVALID');
    const body=Buffer.from(parts[1],'base64url');let p;try {p=JSON.parse(body.toString('utf8'));}catch {reject('BROWSER_MODEL_RECEIPT_INVALID');}
    if(!verify(null,body,key,Buffer.from(parts[2],'base64url'))||p.kind!==kind)reject('BROWSER_MODEL_RECEIPT_INVALID');return p;
  };
  async function call(purpose,input,{signal}={}) {
    if(signal?.aborted)reject('CANCELLED');
    const request=validateBrowserModelRequest({...input,purpose},{clock});
    const r=await client.request('selected_browser_model',request,{signal});if(signal?.aborted)reject('CANCELLED');
    const p=attest(r,'pbm1','selected-browser-model');
    for(const field of ['run_id','attempt_id','fence','call_id','project_id','project_revision','project_limits_revision','purpose','policy_hash','guide_version_id','guide_hash','consent_hash'])if(p[field]!==request[field])reject('BROWSER_MODEL_RECEIPT_INVALID');
    if(p.request_hash!==browserModelRequestDigest(request)||p.response_hash!==browserDraftHash(r.text)||canonicalBrowserDraft(p.usage)!==canonicalBrowserDraft(r.usage)||p.settled_usd!==r.settled_usd||p.price_table_revision!==r.price_table_revision||r.price_table_revision!==request.price_table_revision)reject('BROWSER_MODEL_RECEIPT_INVALID');
    validUsage(r,request);const output=validateBrowserModelOutput(request,r.text);
    return {...r,...(purpose==='decision'?{decision:output}:purpose==='report'?{report:output}:purpose==='draft_input'?{draft:output}:{proposal:output}),usage:{...r.usage,tokens:r.usage.prompt_tokens+r.usage.completion_tokens,usd:Number(r.settled_usd)}};
  }
  const readiness=async()=>{
      prices=null;
      try {
        const r=await client.request('selected_browser_model_status',{});
        if(r?.contract_version!==BROWSER_MODEL_CONTRACT||r.available!==true)return{available:false,code:r?.code||'BROWSER_MODEL_BRIDGE_UNAVAILABLE'};
        if(!statusSchema.safeParse(r).success)reject('BROWSER_MODEL_RECEIPT_INVALID');
        const p=attest(r,'pbm1','selected-browser-model-status');
        if(p.contract_version!==BROWSER_MODEL_CONTRACT||p.available!==true||p.price_table_revision!==r.price_table_revision||canonicalBrowserDraft(p.prices)!==canonicalBrowserDraft(r.prices)||p.valid_until!==r.valid_until||Date.parse(p.valid_until)<=clock()||Date.parse(p.valid_until)>clock()+60000)reject('BROWSER_MODEL_RECEIPT_INVALID');
        prices={...r.prices,revision:r.price_table_revision,valid_until:r.valid_until};return{available:true,contract_version:BROWSER_MODEL_CONTRACT,multimodal:true,price_table_revision:r.price_table_revision};
      }catch(e){return{available:false,code:e.code||'BROWSER_MODEL_BRIDGE_UNAVAILABLE'};}
    };
  return {
    readiness,
    async quote({purpose,max_output_tokens,image_encoded_bytes=0}) {
      if(!prices||Date.parse(prices.valid_until)<=clock())if((await readiness()).available!==true)reject('PRICE_UNKNOWN');
      if(!['decision','report','conversion','draft_input'].includes(purpose)||!Number.isSafeInteger(max_output_tokens)||max_output_tokens<1||max_output_tokens>6000||!Number.isSafeInteger(image_encoded_bytes)||image_encoded_bytes<0||image_encoded_bytes>2796204+8*256)reject('BROWSER_MODEL_REQUEST_INVALID');
      // The host reserves the actual full prompt. The coordinator uses this
      // upper ceiling for text decisions; conversion images have a separate
      // broker reservation of every encoded byte, never assumed cheap.
      const input=BROWSER_MODEL_MAX_PROMPT_BYTES+48+image_encoded_bytes,rate=Math.max(Number(prices.input),Number(prices.cache_write)),out=Number(prices.output);
      if(![rate,out].every(v=>Number.isFinite(v)&&v>=0))reject('PRICE_UNKNOWN');
      return{tokens:input+max_output_tokens,usd:(Math.ceil(input*rate*1000)+Math.ceil(max_output_tokens*out*1000))/1e9,price_table_revision:prices.revision};
    },
    convert:(r,o)=>call('conversion',r,o),decide:(r,o)=>call('decision',r,o),report:(r,o)=>call('report',r,o),draftInput:(r,o)=>call('draft_input',r,o),
    cancel:run_id=>client.request('cancel_selected_browser_model',{run_id}),
  };
}
