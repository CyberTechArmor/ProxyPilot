import { createHash } from 'node:crypto';
import { z } from 'zod';
import proposal from './operational-browser-agent-proposal.schema.json' with { type: 'json' };
import { OperationsError } from './operational-projects-logic.js';

export const BROWSER_DRAFT_CONTRACT = 'browser-agent-draft.v1';
export const BROWSER_DRAFT_MAX_BYTES = 200000;
const refuse = (code) => { throw Object.assign(new OperationsError(400, 'Invalid browser draft configuration'), { code }); };

// Compile only this trusted generated schema's small JSON Schema subset.
// Callers cannot supply schemas or regexes. Unknown schema constructs fail closed.
function compile(s) {
  if (Object.hasOwn(s, 'const')) return z.literal(s.const);
  if (s.enum) return z.union(s.enum.map(v => z.literal(v)));
  if (s.anyOf) return z.union(s.anyOf.map(compile));
  if (s.type === 'null') return z.null();
  if (s.type === 'object') {
    if (s.additionalProperties !== false || Object.keys(s.properties).some(k => !s.required.includes(k)))
      throw new Error('Unsupported browser draft schema');
    return z.object(Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, compile(v)]))).strict();
  }
  if (s.type === 'array') {
    let a = z.array(compile(s.items)).min(s.minItems).max(s.maxItems);
    if (s.uniqueItems) a = a.refine(v => new Set(v.map(canonicalBrowserDraft)).size === v.length);
    return a;
  }
  if (s.type === 'string') {
    let t = z.string().min(s.minLength).max(s.maxLength);
    if (s.pattern) t = t.regex(new RegExp(s.pattern));
    return t;
  }
  if (s.type === 'integer' || s.type === 'number') {
    let n = z.number().finite();
    if (s.type === 'integer') n = n.int();
    if (s.minimum != null) n = n.min(s.minimum);
    if (s.maximum != null) n = n.max(s.maximum);
    if (s.exclusiveMinimum != null) n = n.gt(s.exclusiveMinimum);
    return n;
  }
  throw new Error('Unsupported browser draft schema');
}

export function canonicalBrowserDraft(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalBrowserDraft).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort()
    .map(k => JSON.stringify(k) + ':' + canonicalBrowserDraft(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
export const browserDraftHash = text => createHash('sha256').update(text, 'utf8').digest('hex');
export const browserAgentProposalSchema = compile(proposal);
const source = z.string().min(1).refine(v => !!v.trim() && Buffer.byteLength(v, 'utf8') <= 100000);
const inputSchema = z.object({ configuration: browserAgentProposalSchema, source_text: source.optional() }).strict();

// Only draft shape/cross-field validation. No URL fetch, DNS, filesystem, vault,
// grant, model or browser call occurs. Future runtime policy needs separate proof.
export function validateBrowserDraftImport(input) {
  let bytes;
  try { bytes = Buffer.byteLength(JSON.stringify(input), 'utf8'); } catch { refuse('BROWSER_DRAFT_INVALID'); }
  if (!Number.isFinite(bytes) || bytes > BROWSER_DRAFT_MAX_BYTES) refuse('BROWSER_DRAFT_TOO_LARGE');
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) refuse('BROWSER_DRAFT_INVALID');
  const { configuration: c } = parsed.data;
  if (!c.name.trim() || !c.work.instructions.trim() || c.work.success_criteria.some(v => !v.trim())) refuse('BROWSER_DRAFT_INVALID');
  if (Buffer.byteLength(c.work.instructions, 'utf8') > 100000) refuse('BROWSER_DRAFT_TOO_LARGE');
  // User-selected policy is explicit destinations and per-action approval.
  // Imported network-policy references remain unverified metadata, never grants.
  const destinations = c.destinations.allowed_origins;
  if (new Set(destinations.map(d => d.id)).size !== destinations.length ||
      new Set(destinations.map(d => d.origin)).size !== destinations.length) refuse('BROWSER_DESTINATION_DUPLICATE');
  for (const d of destinations) {
    try { if (new URL(d.origin).origin !== d.origin) refuse('BROWSER_DESTINATION_INVALID'); }
    catch { refuse('BROWSER_DESTINATION_INVALID'); }
    if (d.origin.startsWith('http:') && (d.session_headers !== 'omit' || d.roles.includes('authentication')))
      refuse('BROWSER_INSECURE_SESSION_DESTINATION');
    if (d.roles.length === 1 && d.roles[0] === 'resource' && d.session_headers !== 'omit')
      refuse('BROWSER_RESOURCE_SESSION_HEADERS_DENIED');
  }
  for (const value of c.destinations.entry_urls) {
    let u;
    try { u = new URL(value); } catch { refuse('BROWSER_ENTRY_INVALID'); }
    const authority = value.match(/^https?:\/\/([^/?#]*)/)?.[1] ?? '';
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || /[@%]/.test(authority) ||
        /[\s\\\x00-\x1f]/.test(value) || u.hostname.endsWith('.') ||
        !destinations.some(d => d.origin === u.origin && d.roles.includes('navigation')))
      refuse('BROWSER_ENTRY_OUTSIDE_ALLOWLIST');
  }
  const rules = c.destinations.request_rules;
  if (new Set(rules.map(r => r.id)).size !== rules.length) refuse('BROWSER_REQUEST_RULE_DUPLICATE');
  for (const r of rules) {
    if (!destinations.some(d => d.id === r.destination_id)) refuse('BROWSER_REQUEST_DESTINATION_UNKNOWN');
    if (r.effect === 'read' && r.methods.some(m => !['GET', 'HEAD', 'OPTIONS'].includes(m)))
      refuse('BROWSER_READ_METHOD_REVIEW_REQUIRED');
  }
  const assets = [...c.work.source_inputs, ...c.artifacts.upload_asset_refs];
  const byId = new Map();
  for (const a of assets) {
    if (byId.has(a.id) && byId.get(a.id) !== canonicalBrowserDraft(a)) refuse('BROWSER_ASSET_PIN_CONFLICT');
    byId.set(a.id, canonicalBrowserDraft(a));
  }
  if (c.artifacts.download_max_bytes > c.budgets.max_artifact_bytes ||
      c.artifacts.upload_max_bytes > c.budgets.max_artifact_bytes ||
      c.artifacts.upload_asset_refs.some(a => a.byte_count > c.artifacts.upload_max_bytes))
    refuse('BROWSER_ARTIFACT_BUDGET_CONFLICT');
  const configuration_json = canonicalBrowserDraft(c);
  return { configuration: c, configuration_json, configuration_sha256: browserDraftHash(configuration_json),
    ...(parsed.data.source_text == null ? {} : { source_text: parsed.data.source_text }) };
}
