import { z } from 'zod';
import action from './operational-selected-browser-action.schema.json' with {type:'json'};
import { OperationsError } from './operational-projects-logic.js';
export const SELECTED_BROWSER_CONTRACT='selected-browser.v1';
export const SELECTED_BROWSER_CONSENT='Send this approved guide and bounded selected-site content to the model provider';
export const selectedFail=(status,code)=>{throw Object.assign(new OperationsError(status,code),{code});};
export function selectedParse(schema,input){const p=schema.safeParse(input);if(!p.success)selectedFail(400,'SELECTED_BROWSER_INVALID_REQUEST');return p.data;}
const hash=z.string().regex(/^[a-f0-9]{64}$/),id=z.string().uuid(),int=z.number().int().positive().max(2147483647);
export const selectedRef=z.object({id,sha256:hash}).strict();
export const selectedStartSchema=z.object({project_revision:int,configuration_revision:int,configuration_sha256:hash,idempotency_key:id}).strict();
export const selectedConsentSchema=z.object({configuration_revision:int,configuration_sha256:hash,allow:z.boolean(),reviewed_statement:z.literal(SELECTED_BROWSER_CONSENT)}).strict();
export const selectedDecisionSchema=z.object({decision:z.enum(['approve','deny']),action_sha256:hash}).strict();
export const selectedReconcileSchema=z.object({decision:z.enum(['verified_effect','verified_no_effect','abandon_without_replay'])}).strict();
export const selectedHumanInputSchema=z.union([
  z.object({kind:z.literal('click'),x:z.number().int().min(0).max(1279),y:z.number().int().min(0).max(799)}).strict(),
  z.object({kind:z.literal('scroll'),x:z.number().int().min(0).max(1279),y:z.number().int().min(0).max(799),dy:z.number().int().min(-2000).max(2000)}).strict(),
  z.object({kind:z.literal('key'),key:z.enum(['Enter','Tab','Escape','Backspace','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'])}).strict(),
  z.object({kind:z.literal('text'),text:z.string().min(1).max(256).refine(s=>!/[\x00-\x1f\x7f]/.test(s))}).strict(),
]);
export const selectedEscalationSchema=z.object({origin:z.string().min(8).max(300),role:z.enum(['navigation','resource','authentication']),purpose:z.string().trim().min(1).max(500),request_ref:z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),method:z.enum(['GET','HEAD','OPTIONS','POST','PUT','PATCH','DELETE']),url_sha256:hash,request_sha256:hash,no_contact:z.literal(true)}).strict();
export const selectedNetworkRequestSchema=z.object({kind:z.literal('network_effect'),request_ref:z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),binding_sha256:hash,origin:z.string().min(8).max(300),role:z.enum(['navigation','resource','authentication']),method:z.enum(['GET','HEAD','OPTIONS','POST','PUT','PATCH','DELETE']),body_sha256:hash,body_bytes:z.number().int().min(0).max(67108864),purpose:z.string().trim().min(1).max(500),request_sha256:hash,no_contact:z.literal(true),current_action:z.object({ordinal:int,snapshot_ref:selectedRef,candidate_ref:selectedRef}).strict().optional()}).strict();
// The schema is static checked-in data; callers cannot submit validation code.
function compile(s){
  if(Object.hasOwn(s,'const'))return z.literal(s.const);
  if(s.enum)return z.enum(s.enum);
  if(s.oneOf||s.anyOf)return z.union((s.oneOf||s.anyOf).map(compile));
  if(s.type==='null')return z.null();
  if(s.type==='object')return z.object(Object.fromEntries(Object.entries(s.properties).map(([k,v])=>[k,compile(v)]))).strict();
  if(s.type==='string'){let t=z.string().min(s.minLength).max(s.maxLength);if(s.pattern)t=t.regex(new RegExp(s.pattern));return t;}
  if(s.type==='integer')return z.number().int().min(s.minimum).max(s.maximum);
  throw new Error('Unsupported selected-browser action schema');
}
export const selectedActionSchema=compile(action);
export const selectedCandidateSchema=z.object({candidate_ref:selectedRef,operation:selectedActionSchema.shape.operation,effect:z.enum(['read','local','external_change','unknown']),label:z.string().max(200).optional()}).strict();
export const selectedInputTargetSchema=z.object({target_ref:selectedRef,element_ref:z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),kind:z.enum(['type','paste']),label:z.string().max(200)}).strict();
export const selectedObservationSchema=z.object({snapshot_ref:selectedRef,observation:z.string().refine(s=>Buffer.byteLength(s)<=16000),candidates:z.array(selectedCandidateSchema).max(20),input_targets:z.array(selectedInputTargetSchema).max(20).default([]),source_refs:z.array(selectedRef).max(64).default([]),page:z.object({origin:z.string().min(8).max(300),url_sha256:hash}).strict().nullable().default(null)}).strict();
export const selectedInputDraftSchema=z.object({candidate_id:id,text:z.string().min(1).refine(s=>Buffer.byteLength(s)<=12000),purpose:z.string().trim().min(1).max(500)}).strict();
export const selectedUsageSchema=z.object({tokens:z.number().int().nonnegative().max(10000000),usd:z.number().finite().nonnegative().max(10000)}).strict();
