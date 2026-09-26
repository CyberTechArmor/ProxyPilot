import { z } from 'zod';

export class OperationsError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export const fail = (status, message) => { throw new OperationsError(status, message); };
export const operationsEnabled = (env = process.env) => env.OPERATIONS_ENABLED === 'true';
export const roles = ['viewer', 'operator', 'editor', 'reviewer'];
const uuid = z.string().uuid();
const text = (max) => z.string().max(max);
const name = z.string().trim().min(1).max(200);
export function siteOrigin(value) {
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 2048 || /[?#@*\s]/.test(value)) fail(400, 'Use an HTTPS site origin without path, query, fragment, userinfo or wildcard');
  let url;
  try { url = new URL(value); } catch { fail(400, 'Invalid HTTPS site origin'); }
  if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash || url.username || url.password || !url.hostname ||
      !/^https:\/\/[^/]+\/?$/i.test(value)) fail(400, 'Use an HTTPS site origin without path, query, fragment, userinfo or wildcard');
  return url.origin;
}
const origin = z.string().max(2048).nullable();
// An absent key means that the project owner has not set that limit.
export const agentLimits = z.object({
  cpu: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  memory_mib: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  temporary_disk_mib: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  max_seconds: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  max_actions: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  max_tokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  max_usd: z.number().finite().positive().optional(),
}).strict();
const profileFields = { display_name: name, workflow_type: z.literal('synthetic_sign_in'),
  proposed_actions: z.array(z.enum(['navigate','click','type','read','download','logout'])).max(6).refine(v => new Set(v).size === v.length),
  proposed_origins: z.array(z.string().max(2048)).max(5) };
export const schemas = {
  create: z.object({ name, description: text(20000).default('') }).strict(),
  project: z.object({ name: name.optional(), description: text(20000).optional() }).strict().refine(v => Object.keys(v).length > 0),
  visibility: z.object({ visibility: z.enum(['hidden','read-only','collaborative']),
    reviewed_visibility: z.literal('Expose redacted project card').optional() }).strict(),
  site: z.object({ site_origin: origin }).strict(),
  agentLimits: z.object({ limits: agentLimits }).strict(),
  profileCreate: z.object(profileFields).strict(),
  profileUpdate: z.object(Object.fromEntries(Object.entries(profileFields).map(([key, value]) => [key, value.optional()])))
    .strict().refine(v => Object.keys(v).length > 0),
  profileAssignment: z.object({ guide_version_id: uuid.nullable() }).strict(),
  accessDecision: z.object({ decision: z.enum(['approve','decline']), role: z.enum(roles).optional() }).strict()
    .refine(v => v.decision !== 'approve' || !!v.role),
  draft: z.object({ title: text(200).optional(), instructions: z.string().refine(v => Buffer.byteLength(v, 'utf8') <= 100000).optional() }).strict().refine(v => Object.keys(v).length > 0),
  grant: z.object({ role: z.enum(roles) }).strict(),
  offer: z.object({ target_user_id: uuid }).strict(),
  decision: z.object({ decision: z.enum(['accept', 'decline', 'cancel']) }).strict(),
  archive: z.object({ reason: z.string().trim().min(1).max(2000) }).strict(),
  empty: z.object({}).strict(),
  submit: z.object({}).strict(),
  review: z.object({ decision: z.enum(['approve','changes_requested']), reason: z.string().trim().max(2000).default('') }).strict()
    .refine(v => v.decision === 'approve' || v.reason.length > 0),
  reason: z.object({ reason: z.string().trim().min(1).max(2000) }).strict(),
  startRevision: z.object({ version_id: uuid, discard_draft: z.literal(true) }).strict(),
  run: z.object({ version_id: uuid, idempotency_key: uuid,
    started_at: z.string().datetime(), ended_at: z.string().datetime(),
    outcome: z.enum(['completed','blocked','aborted']), notes: text(10000).default('') }).strict(),
  correction: z.object({ idempotency_key: uuid,
    started_at: z.string().datetime(), ended_at: z.string().datetime(),
    outcome: z.enum(['completed','blocked','aborted']), notes: text(10000).default(''),
    reason: z.string().trim().min(1).max(2000) }).strict(),
  candidate: z.object({ identifier: z.string().trim().min(1).max(200) }).strict(),
  directory: z.object({ after: uuid.optional(),
    limit: z.string().regex(/^\d{1,3}$/).transform(Number).refine(n => n > 0 && n <= 100).default('25') }).strict(),
  list: z.object({
    state: z.enum(['active', 'archived', 'all']).default('active'),
    after: uuid.optional(),
    limit: z.string().regex(/^\d{1,3}$/).transform(Number).refine(n => n > 0 && n <= 100).default('25'),
  }).strict(),
  events: z.object({
    after: z.string().regex(/^\d{1,15}$/).transform(Number).default('0'),
    limit: z.string().regex(/^\d{1,3}$/).transform(Number).refine(n => n > 0 && n <= 100).default('25'),
  }).strict(),
};
export function parse(schema, input) {
  const result = schema.safeParse(input);
  if (!result.success) fail(400, 'Invalid operational request');
  return result.data;
}
export function validId(id) { return uuid.safeParse(id).success; }
export function revision(header) {
  if (header == null) fail(428, 'If-Match revision required');
  if (typeof header !== 'string' || !/^"[1-9]\d{0,14}"$/.test(header)) fail(400, 'Use a quoted numeric If-Match revision');
  return Number(header.slice(1, -1));
}
export function assertRevision(expected, actual) {
  if (expected !== actual) fail(412, 'The record changed; reload before saving');
}
export function assertEligible(actor, currentUser) {
  if (!actor?.id || !currentUser) fail(401, 'Authentication required');
  if (actor.enrollmentOnly || actor.linkOnly || !['user', 'admin'].includes(currentUser.role)) {
    fail(403, 'An active, fully authenticated account is required');
  }
}
export function resolveOperationsRole(project, actorId, grant) {
  if (project?.owner_user_id === actorId) return 'owner';
  return roles.includes(grant?.role) ? grant.role : null;
}
export function assertOperation(role, action, archived) {
  if (!role) fail(404, 'Operational record not found');
  const allowed = action === 'read' || action === 'leave'
    || (action === 'edit' && ['owner', 'editor'].includes(role))
    || (['review','withdraw'].includes(action) && ['owner','reviewer'].includes(role))
    || (action === 'run' && ['owner','operator','editor','reviewer'].includes(role))
    || (['access', 'grant', 'revoke', 'offer', 'archive', 'restore'].includes(action) && role === 'owner');
  if (!allowed) fail(403, 'Insufficient operational access');
  if (archived && !['read', 'access', 'revoke', 'leave', 'restore'].includes(action)) {
    fail(409, 'Operational record is archived');
  }
}
