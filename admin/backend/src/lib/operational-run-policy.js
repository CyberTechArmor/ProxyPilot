import { createHash } from 'node:crypto';
import { z } from 'zod';
import { BROWSER_ACTIONS, SUBMIT_OUTCOMES } from './operational-worker-boundary.js';

// A5 hard rules and policy pin. The rules are one fenced JSON block inside the
// guide's instructions, so they are reviewed, versioned and hashed with the
// guide through the existing independent review path (no second approver path,
// no self-approval). Code enforces them; the model never interprets them.
export const RULES_FENCE = 'proxypilot-rules';
export const POLICY_VERSION = 'a5-policy-1';
export const MODEL_NAME = 'gpt-6-luna';
export const SUBMIT = 'submit_bound_fixture';
export { SUBMIT_OUTCOMES };
// Every sign-in outcome class maps to a distinct durable result (A1 acceptance).
export const OUTCOME_RESULT = Object.freeze({
  rejected: ['blocked', 'credential_rejected'],
  rate_limited: ['blocked', 'rate_limited'],
  challenge_required: ['blocked', 'challenge_required'],
  unexpected_origin: ['blocked', 'unexpected_origin'],
  timeout: ['failed', 'timeout'],
  unknown: ['blocked', 'unverified_account'],
});
const coded = (code) => { const e = new Error(code); e.code = code; return e; };
const action = z.enum(BROWSER_ACTIONS);
const list = (max) => z.array(action).max(max).refine(v => new Set(v).size === v.length);

export const rulesSchema = z.object({
  v: z.literal(1),
  workflow: z.literal('synthetic_sign_in'),
  start: list(4),
  finish: list(2),
  model_actions: list(7),
  forbid: list(7),
  approval_required: list(7),
  stop_when: z.array(z.enum(['verified_account', 'files_read'])).min(1).max(2)
    .refine(v => new Set(v).size === v.length),
  max_steps: z.number().int().min(1).max(20),
  max_model_calls: z.number().int().min(0).max(10),
  model: z.object({ name: z.literal(MODEL_NAME), max_output_tokens: z.number().int().min(1).max(16) })
    .strict().nullable(),
}).strict().superRefine((r, ctx) => {
  const issue = (message) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  if (!r.approval_required.includes(SUBMIT)) issue('submit_bound_fixture always needs a human approval');
  if (!r.stop_when.includes('verified_account')) issue('a sign-in run stops on the verified account');
  for (const a of [...r.start, ...r.finish, ...r.model_actions])
    if (r.forbid.includes(a)) issue(`forbidden action is also required or offered: ${a}`);
  if (r.finish.includes(SUBMIT)) issue('submit cannot be a finish step');
  if (r.forbid.includes('read_session')) issue('the account is verified by reading the session');
  if (r.model === null && r.max_model_calls > 0) issue('model calls need a model');
});

// Exactly one fenced block; anything else (none, two, bad JSON, unknown key)
// refuses the run before any effect.
export function guideRules(instructions) {
  const pattern = new RegExp('^```' + RULES_FENCE + '[ \\t]*\\r?\\n([\\s\\S]*?)\\r?\\n```[ \\t]*$', 'gm');
  const blocks = [...String(instructions ?? '').matchAll(pattern)];
  if (blocks.length !== 1) throw coded(blocks.length ? 'GUIDE_RULES_AMBIGUOUS' : 'GUIDE_RULES_MISSING');
  let parsed;
  try { parsed = JSON.parse(blocks[0][1]); } catch { throw coded('GUIDE_RULES_INVALID'); }
  const result = rulesSchema.safeParse(parsed);
  if (!result.success) throw coded('GUIDE_RULES_INVALID');
  return result.data;
}

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
// The exact bytes ops_guide_versions.content_hash covers (guideHash in
// operational-projects-workflow.js). The supervisor re-hashes these bytes.
export const guideDocument = (title, instructions) => JSON.stringify({ format: 1, title, instructions });

// The run's policy pin. Its sha256 is the run's policy_digest, which the
// worker store, the host supervisor and the broker already pin per run
// (RUN_POLICY_MISMATCH on change). model_step carries these exact bytes.
export function policyDocument({ guideHash, rules, origin, modelGuideConsent }) {
  if (!/^[0-9a-f]{64}$/.test(guideHash || '') || typeof modelGuideConsent !== 'boolean') throw coded('INVALID_POLICY');
  const text = JSON.stringify({ v: POLICY_VERSION, origin, guide_hash: guideHash,
    rules, model_guide_consent: modelGuideConsent });
  return { text, digest: sha256(text) };
}

const canonical = (value) => JSON.stringify(Object.keys(value).sort().reduce((o, k) => (o[k] = value[k], o), {}));
export const APPROVAL_FIELDS = Object.freeze(['run_id', 'attempt_id', 'fence', 'action', 'binding_id',
  'binding_revision', 'guide_hash', 'policy_digest', 'origin']);
export function approvalDigest(fields) {
  if (Object.keys(fields).sort().join(',') !== [...APPROVAL_FIELDS].sort().join(',')) throw coded('INVALID_APPROVAL');
  return sha256('a5-approval-1\n' + canonical(fields));
}

// Page results are untrusted. Only these typed fields survive, under short
// names; no page text, URL, value, cookie or token is ever kept.
const CLAIMS = Object.freeze({
  untrusted_page_claim_authenticated: 'authenticated',
  untrusted_page_claim_authenticated_as_bound_account: 'as_bound_account',
  untrusted_page_claim_sample_present: 'sample_present',
  untrusted_page_claim_signed_out: 'signed_out',
});
export function reduceClaims(name, result) {
  const out = {};
  if (!result || typeof result !== 'object') return out;
  for (const [key, short] of Object.entries(CLAIMS)) if (typeof result[key] === 'boolean') out[short] = result[key];
  if (name === SUBMIT) {
    out.outcome = SUBMIT_OUTCOMES.includes(result.outcome) ? result.outcome : 'unknown';
    if (Number.isSafeInteger(result.login_requests) && result.login_requests >= 0 && result.login_requests <= 10)
      out.login_requests = result.login_requests;
  }
  return out;
}

// The hybrid decision: rules first, a model only where they leave a choice.
// `steps` are the run's finished steps in order ({action,status,claims}).
export function nextStep({ rules, steps, permitted, canSubmit }) {
  const tried = (a) => steps.some(s => s.action === a);
  const stop = (state, result) => ({ kind: 'stop', state, result });
  const submitIndex = steps.findIndex(s => s.action === SUBMIT);
  const submit = submitIndex < 0 ? null : steps[submitIndex];
  if (submit && submit.status !== 'done') return stop('blocked', 'submit_failed');
  if (submit && submit.claims.outcome !== 'signed_in') return stop(...OUTCOME_RESULT[submit.claims.outcome] ??
    OUTCOME_RESULT.unknown);
  const failedStart = steps.find(s => rules.start.includes(s.action) && s.status !== 'done');
  if (failedStart) return stop('blocked', 'action_failed');
  // Proof of the intended account is the runner's own session read after the
  // submit naming the bound account; a navigation or model statement never is.
  const after = submit ? steps.slice(submitIndex + 1).filter(s => s.action === 'read_session') : [];
  if (submit && submit.claims.as_bound_account === true && after.length === 0 && !rules.forbid.includes('read_session'))
    return { kind: 'action', action: 'read_session', decided_by: 'rule', rule: 'verify_account' };
  const verified = !!submit && submit.claims.as_bound_account === true &&
    after.some(s => s.status === 'done' && s.claims.as_bound_account === true);
  if (submit && !verified) return stop('blocked', 'unverified_account');
  const met = { verified_account: verified,
    files_read: steps.some(s => s.action === 'read_files' && s.status === 'done' && s.claims.sample_present === true) };
  const done = rules.stop_when.every(c => met[c]);
  if (done) {
    const finish = rules.finish.find(a => !tried(a) && permitted(a));
    if (finish && steps.length < rules.max_steps) return { kind: 'action', action: finish, decided_by: 'rule', rule: 'finish' };
    return stop('completed', 'verified_account');
  }
  if (steps.length >= rules.max_steps) return stop('blocked', 'step_limit');
  const start = rules.start.find(a => !tried(a));
  if (start) {
    if (!permitted(start) || (start === SUBMIT && !canSubmit)) return stop('blocked', 'action_not_permitted');
    return { kind: 'action', action: start, decided_by: 'rule', rule: 'start' };
  }
  const open = rules.model_actions.filter(a => !rules.forbid.includes(a) && !tried(a) && permitted(a) &&
    (a !== SUBMIT || canSubmit));
  if (open.length === 0) return stop('blocked', 'no_allowed_action');
  if (open.length === 1) return { kind: 'action', action: open[0], decided_by: 'rule', rule: 'single_choice' };
  return { kind: 'model', allowed: open };
}
