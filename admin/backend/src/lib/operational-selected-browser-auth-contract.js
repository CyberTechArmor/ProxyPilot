import { z } from 'zod';
import { browserDraftHash, canonicalBrowserDraft } from './operational-browser-agent-proposal.js';

export const SELECTED_BROWSER_AUTH_STATEMENT = 'I reviewed each selected request and confirm it was solely for sign-in or MFA. I independently observed this browser complete authentication. This confirms authentication only, and does not confirm other website changes.';
export const SELECTED_BROWSER_AUTH_INVENTORY_ATTESTATION_MAX = 262144;
export const SELECTED_BROWSER_AUTH_INVENTORY_BODY_MAX = 196000;
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const requestRef = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const pin = z.object({ id:z.string().uuid(), sha256:sha }).strict();
const identity = {run_id:z.string().uuid(),attempt_id:z.string().uuid(),fence:count.refine(n=>n>0),policy_sha256:sha};
const controller = {controller_id:z.string().uuid(),session_id:z.string().uuid(),viewer_conn_sha256:sha};
const boundedText = max => z.string().refine(value=>Buffer.byteLength(value,'utf8')<=max);
// Match the gateway's controller-private endpoint preview contract. Signatures
// establish the issuing helper, but do not make arbitrary URL paths safe to
// persist: usernames, opaque IDs and token-bearing segments must be redacted.
const authenticationPathWords = new Set(['api','v1','v2','v3','auth','authentication','account','accounts',
  'login','signin','sign-in','logout','signout','oauth','oauth2','oidc','saml','sso','authorize',
  'callback','token','mfa','challenge','verify','verification','otp','session','sessions']);
const authenticationPathPreview = boundedText(1000).refine(value=>value.startsWith('/')&&
  value.split('/').every(segment=>segment===''||segment==='[redacted]'||authenticationPathWords.has(segment.toLowerCase())),
  'Authentication endpoint preview must redact nonstandard path segments');
export const selectedAuthRequestSchema = z.object({
  request_ref:requestRef,binding_sha256:sha,request_sha256:sha,url_sha256:sha,
  body_sha256:sha,body_bytes:count,origin:z.string().max(2048),role:z.literal('authentication'),
  method:z.enum(['GET','HEAD','OPTIONS','POST','PUT','PATCH','DELETE']),
  approval_ref:pin,purpose_sha256:sha,path_preview:authenticationPathPreview,human_context:boundedText(500),
  ledger_send_ref:sha,ledger_response_ref:sha,transport_complete:z.literal(true),
}).strict();
export const selectedAuthInventorySchema = z.object({
  schema:z.literal('selected-browser-auth-inventory.v1'),...identity,...controller,
  inventory_sha256:sha,ledger_sha256:sha,effects_sent:count,effects_uncertain:count,
  inflight:count,pending_count:count,auth_effects_acknowledged:count,
  requests:z.array(selectedAuthRequestSchema).max(64),attestation:z.string().min(1).max(SELECTED_BROWSER_AUTH_INVENTORY_ATTESTATION_MAX),
}).strict();
export const selectedAuthConfirmationInputSchema = z.object({
  inventory_sha256:sha,request_refs:z.array(z.object({request_ref:requestRef,binding_sha256:sha}).strict()).min(1).max(64),
  reviewed_statement:z.literal(SELECTED_BROWSER_AUTH_STATEMENT),
}).strict();
export const selectedAuthConfirmationPacketSchema = z.object({
  schema:z.literal('selected-browser-auth-confirmation.v1'),...identity,...controller,
  inventory_sha256:sha,ledger_sha256:sha,request_refs:z.array(selectedAuthRequestSchema).min(1).max(64),
  reviewed_statement:z.literal(SELECTED_BROWSER_AUTH_STATEMENT),confirmation_ref:pin,
  expires_at:z.string().datetime(),
}).strict();
export const selectedAuthConfirmationAckSchema = z.object({
  schema:z.literal('selected-browser-auth-confirmation-ack.v1'),...identity,...controller,
  confirmation_ref:pin,request_sha256:sha,inventory_sha256:sha,ledger_sha256:sha,
  auth_effects_acknowledged:count,effects_sent:count,confirmed:z.literal(true),
  replay_allowed:z.literal(false),attestation:z.string().min(1).max(16000),
}).strict();
export const selectedAuthDigest = value => browserDraftHash(canonicalBrowserDraft(value));
export function selectedAuthInventoryDigest(inventory) {
  return selectedAuthDigest({requests:inventory.requests,effects_sent:inventory.effects_sent,
    effects_uncertain:inventory.effects_uncertain,inflight:inventory.inflight,pending_count:inventory.pending_count,
    auth_effects_acknowledged:inventory.auth_effects_acknowledged,ledger_sha256:inventory.ledger_sha256});
}
