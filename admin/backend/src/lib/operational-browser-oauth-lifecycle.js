import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';

const id = z.string().uuid(), text = z.string().min(1).max(200);
const principalSchema = z.object({ contributor_id: id, session_id: id, connection_id: id,
  metadata_version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict();
const scopesSchema = z.array(z.string().regex(/^[A-Za-z0-9._:/-]{1,200}$/)).min(1).max(32)
  .refine(values => new Set(values).size === values.length);
const https = z.string().max(2048).refine(value => {
  try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash && !/[\s]/.test(value); }
  catch { return false; }
});
const providerSchema = z.object({ id: text, revision: z.number().int().positive(), client_id: text,
  issuer: https, authorization_endpoint: https, token_endpoint: https, redirect_uri: https,
  allowed_scopes: scopesSchema, callback_issuer_required: z.boolean() }).strict();
const callbackSchema = z.object({ state: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  code: z.string().min(1).max(8192).optional(), error: z.enum(['access_denied', 'temporarily_unavailable', 'server_error']).optional(),
  issuer: https.optional() }).strict().refine(value => !!value.code !== !!value.error);
const fail = code => { throw Object.assign(new Error(code), { code }); };
const parse = (schema, input, code) => { const result = schema.safeParse(input); if (!result.success) fail(code); return result.data; };
const digest = value => createHash('sha256').update(value).digest('hex');
const scopeSubset = (requested, allowed) => requested.every(scope => allowed.includes(scope));

// Protocol mechanics only: there is no registered provider, configured custody,
// HTTP route or token transport in this module. A future adapter must implement
// the real exchange/account/scope/custody checks; a returned fixture is not real
// provider acceptance. Raw code/verifier are transient arguments to that trusted
// adapter and are never returned through these metadata projections.
export function createBrowserOAuthLifecycle({ resolveProvider = () => null, authorize = () => false,
  exchangeToCustody = null, now = Date.now, maxPending = 64, maxPerSession = 4, ttlMs = 300000 } = {}) {
  if (!Number.isSafeInteger(maxPending) || maxPending < 1 || maxPending > 64 || !Number.isSafeInteger(maxPerSession) ||
    maxPerSession < 1 || maxPerSession > maxPending || !Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 300000)
    fail('OAUTH_LIFECYCLE_LIMITS_INVALID');
  const intents = new Map();
  let closed = false;
  const open = () => { if (closed) fail('OAUTH_LIFECYCLE_CLOSED'); };
  function provider(pid) {
    let p;
    try { p = resolveProvider(pid); } catch { fail('OAUTH_PROVIDER_UNAVAILABLE'); }
    if (!p || typeof exchangeToCustody !== 'function') fail('OAUTH_PROVIDER_AND_CUSTODY_UNCONFIGURED');
    const value = parse(providerSchema, p, 'OAUTH_PROVIDER_INVALID');
    if (value.id !== pid) fail('OAUTH_PROVIDER_INVALID');
    return value;
  }
  const providerPin = p => digest(JSON.stringify(p));
  async function authorized(principal) {
    let granted;
    try { granted = await authorize(principal); } catch { open(); fail('OAUTH_AUTHORITY_UNAVAILABLE'); }
    open();
    if (granted !== true) fail('OAUTH_AUTHORITY_LOST');
  }
  const publicIntent = i => ({ id: i.id, connection_id: i.principal.connection_id, metadata_version: i.principal.metadata_version,
    provider_id: i.provider.id, state: i.state, expires_at: new Date(i.expires).toISOString(), replay_allowed: false });
  const wipe = i => { i.verifier = null; i.stateHash = null; };
  function sweep() {
    if (closed) return;
    for (const [key, i] of intents) {
      if (i.expires <= now() && i.state === 'reserved') { i.state = 'expired'; wipe(i); }
      // Completed summaries are bounded by the same maximum count. They hold no
      // state/verifier/code/token and expire without reviving an authorization.
      if (i.expires + ttlMs <= now() && i.state !== 'exchanging') intents.delete(key);
    }
  }
  async function current(i, principal) {
    open();
    if (intents.get(i.id) !== i) fail('OAUTH_INTENT_FENCED');
    if (!['reserved', 'exchanging'].includes(i.state)) fail('OAUTH_INTENT_FENCED');
    if (JSON.stringify(i.principal) !== JSON.stringify(principal)) fail('OAUTH_CONTROLLER_MISMATCH');
    if (i.expires <= now()) { if (i.state === 'reserved') { i.state = 'expired'; wipe(i); } fail('OAUTH_INTENT_EXPIRED'); }
    if (providerPin(provider(i.provider.id)) !== i.providerPin) fail('OAUTH_PROVIDER_CHANGED');
    await authorized(principal);
    if (intents.get(i.id) !== i) fail('OAUTH_INTENT_FENCED');
    if (!['reserved', 'exchanging'].includes(i.state)) fail('OAUTH_INTENT_FENCED');
    if (i.expires <= now()) fail('OAUTH_INTENT_EXPIRED');
    if (providerPin(provider(i.provider.id)) !== i.providerPin) fail('OAUTH_PROVIDER_CHANGED');
  }
  return {
    configured: pid => { try { open(); provider(pid); return true; } catch { return false; } },
    sweep,
    async begin(pid, input, requestedScopes) {
      open();
      const principal = parse(principalSchema, input, 'OAUTH_PRINCIPAL_INVALID');
      const p = provider(pid), scopes = parse(scopesSchema, requestedScopes, 'OAUTH_SCOPE_INVALID');
      if (!scopeSubset(scopes, p.allowed_scopes)) fail('OAUTH_SCOPE_NOT_CONFIGURED');
      await authorized(principal);
      sweep();
      if (intents.size >= maxPending || [...intents.values()].filter(i => i.principal.session_id === principal.session_id &&
        ['reserved', 'exchanging'].includes(i.state)).length >= maxPerSession) fail('OAUTH_INTENT_LIMIT');
      if (providerPin(provider(pid)) !== providerPin(p)) fail('OAUTH_PROVIDER_CHANGED');
      const state = randomBytes(32).toString('base64url'), verifier = randomBytes(32).toString('base64url');
      const i = { id: randomUUID(), principal, provider: p, providerPin: providerPin(p), scopes, state: 'reserved',
        stateHash: digest(state), verifier, expires: now() + ttlMs };
      intents.set(i.id, i);
      const url = new URL(p.authorization_endpoint);
      for (const [key, value] of Object.entries({ response_type: 'code', client_id: p.client_id, redirect_uri: p.redirect_uri,
        scope: scopes.join(' '), state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' }))
        url.searchParams.set(key, value);
      return { intent: publicIntent(i), authorization_url: url.toString() };
    },
    async callback(intentId, input, callback) {
      open();
      const principal = parse(principalSchema, input, 'OAUTH_PRINCIPAL_INVALID');
      const v = parse(callbackSchema, callback, 'OAUTH_CALLBACK_INVALID');
      const i = intents.get(intentId); if (!i) fail('OAUTH_INTENT_UNKNOWN');
      if (i.state !== 'reserved') fail('OAUTH_CALLBACK_REPLAY_REFUSED');
      if (!i.stateHash || i.stateHash !== digest(v.state)) fail('OAUTH_STATE_MISMATCH');
      if ((i.provider.callback_issuer_required && v.issuer !== i.provider.issuer) ||
        (v.issuer && v.issuer !== i.provider.issuer)) fail('OAUTH_ISSUER_MISMATCH');
      await current(i, principal);
      // Claim before any token exchange. Recheck after asynchronous authority
      // validation: concurrent callbacks cannot dispatch the same code twice.
      if (i.state !== 'reserved') fail('OAUTH_CALLBACK_REPLAY_REFUSED');
      if (v.error) { i.state = v.error === 'access_denied' ? 'denied' : 'failed'; wipe(i);
        return { intent: publicIntent(i), code: v.error === 'access_denied' ? 'OAUTH_CONSENT_DENIED' : 'OAUTH_AUTHORIZATION_FAILED', provider_error: v.error }; }
      i.state = 'exchanging';
      const verifier = i.verifier; wipe(i);
      try {
        const receipt = await exchangeToCustody({ intent_id: i.id, provider: i.provider, principal, authorization_code: v.code,
          code_verifier: verifier, requested_scopes: i.scopes, assertCurrent: () => current(i, principal) });
        await current(i, principal);
        const account = parse(z.object({ account_subject: z.string().min(1).max(500),
          granted_scopes: scopesSchema, enrollment_receipt_id: id }).strict(), receipt, 'OAUTH_RECEIPT_INVALID');
        if (!scopeSubset(account.granted_scopes, i.scopes)) fail('OAUTH_SCOPE_EXPANDED');
        i.state = 'review_required';
        return { intent: publicIntent(i), account: { subject: account.account_subject, granted_scopes: account.granted_scopes },
          enrollment_receipt_id: account.enrollment_receipt_id, execution_available: false };
      } catch {
        // A code exchange or custody write might have happened. No automatic
        // retry, new code replay, account binding or execution promotion.
        i.state = 'reconcile_required'; return { intent: publicIntent(i), code: 'OAUTH_EXCHANGE_RECONCILIATION_REQUIRED', execution_available: false };
      }
    },
    async cancel(intentId, input) {
      open();
      const principal = parse(principalSchema, input, 'OAUTH_PRINCIPAL_INVALID');
      const i = intents.get(intentId); if (!i) fail('OAUTH_INTENT_UNKNOWN');
      if (JSON.stringify(i.principal) !== JSON.stringify(principal)) fail('OAUTH_CONTROLLER_MISMATCH');
      if (['exchanging', 'review_required'].includes(i.state)) { i.state = 'reconcile_required'; wipe(i); }
      else if (i.state === 'reserved') { i.state = 'cancelled'; wipe(i); }
      return { intent: publicIntent(i), execution_available: false };
    },
    close() { if (closed) return; closed = true;
      for (const i of intents.values()) { if (i.state === 'exchanging') i.state = 'reconcile_required';
      else if (i.state === 'reserved') i.state = 'cancelled'; wipe(i); } intents.clear(); },
  };
}
