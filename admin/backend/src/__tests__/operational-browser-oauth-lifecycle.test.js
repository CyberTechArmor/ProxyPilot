import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createBrowserOAuthLifecycle } from '../lib/operational-browser-oauth-lifecycle.js';

const principal = () => ({ contributor_id: randomUUID(), session_id: randomUUID(), connection_id: randomUUID(), metadata_version: 1 });
const initialProvider = () => ({ id: 'fixture-provider', revision: 1, client_id: 'fixture-client', issuer: 'https://idp.example.com',
  authorization_endpoint: 'https://idp.example.com/authorize', token_endpoint: 'https://idp.example.com/token',
  redirect_uri: 'https://broker.example.com/oauth/callback', allowed_scopes: ['read:items', 'read:profile'], callback_issuer_required: true });
function world({ authorize = () => true, exchange } = {}) {
  let clock = Date.now(), provider = initialProvider(); const calls = [];
  const service = createBrowserOAuthLifecycle({ resolveProvider: id => provider?.id === id ? provider : null, authorize, now: () => clock,
    exchangeToCustody: async input => { calls.push(input); return exchange ? exchange(input) :
      { account_subject: 'actual-adapter-fixture-subject', granted_scopes: ['read:items'], enrollment_receipt_id: randomUUID() }; } });
  const owner = principal();
  const begin = () => service.begin(provider.id, owner, ['read:items']);
  const callback = (started, input = {}, actor = owner) => service.callback(started.intent.id, actor, {
    state: new URL(started.authorization_url).searchParams.get('state'), code: 'private-fixture-code', issuer: 'https://idp.example.com', ...input });
  return { service, owner, calls, begin, callback, setProvider: value => { provider = value; },
    advance: ms => { clock += ms; }, close: () => service.close() };
}

test('without provider and custody protocol configuration no authorization is fabricated', async () => {
  const service = createBrowserOAuthLifecycle();
  assert.equal(service.configured('unselected'), false);
  await assert.rejects(() => service.begin('unselected', principal(), ['read']), error => error.code === 'OAUTH_PROVIDER_AND_CUSTODY_UNCONFIGURED');
});

test('provider registry and authority errors use static codes without exposing private exception text', async () => {
  const registry = createBrowserOAuthLifecycle({ resolveProvider: () => { throw new Error('PRIVATE_REGISTRY_CANARY'); }, exchangeToCustody: async () => ({}) });
  await assert.rejects(() => registry.begin('fixture-provider', principal(), ['read:items']),
    error => error.code === 'OAUTH_PROVIDER_UNAVAILABLE' && !error.message.includes('CANARY'));
  const w = world({ authorize: async () => { throw new Error('PRIVATE_AUTHORITY_CANARY'); } });
  try { await assert.rejects(w.begin, error => error.code === 'OAUTH_AUTHORITY_UNAVAILABLE' && !error.message.includes('CANARY')); }
  finally { w.close(); }
});

test('exact pinned authorization URL carries one-use state and PKCE S256 with no verifier exposure', async () => {
  const w = world();
  try {
    const started = await w.begin(), url = new URL(started.authorization_url);
    assert.equal(url.origin + url.pathname, initialProvider().authorization_endpoint);
    assert.equal(url.searchParams.get('client_id'), initialProvider().client_id);
    assert.equal(url.searchParams.get('redirect_uri'), initialProvider().redirect_uri);
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('scope'), 'read:items'); assert.equal(url.searchParams.get('state').length, 43);
    assert.equal(started.intent.state, 'reserved'); assert.equal(started.intent.replay_allowed, false);
    assert.equal(w.calls.length, 0);
    const out = await w.callback(started);
    assert.equal(w.calls.length, 1); assert.equal(w.calls[0].authorization_code, 'private-fixture-code');
    assert.equal(createHash('sha256').update(w.calls[0].code_verifier).digest('base64url'), url.searchParams.get('code_challenge'));
    assert.equal(out.intent.state, 'review_required'); assert.equal(out.execution_available, false);
    assert.equal(JSON.stringify(out).includes('private-fixture-code'), false);
    assert.equal(JSON.stringify(out).includes(w.calls[0].code_verifier), false);
    await assert.rejects(() => w.callback(started), error => error.code === 'OAUTH_CALLBACK_REPLAY_REFUSED');
  } finally { w.close(); }
});

test('wrong state/session/contributor/version and missing or changed issuer cannot exchange', async () => {
  const w = world();
  try {
    const started = await w.begin();
    await assert.rejects(() => w.callback(started, { state: 'a'.repeat(43) }), error => error.code === 'OAUTH_STATE_MISMATCH');
    for (const change of [{ session_id: randomUUID() }, { contributor_id: randomUUID() }, { connection_id: randomUUID() }, { metadata_version: 2 }])
      await assert.rejects(() => w.callback(started, {}, { ...w.owner, ...change }), error => error.code === 'OAUTH_CONTROLLER_MISMATCH');
    for (const issuer of [undefined, 'https://wrong.example.com'])
      await assert.rejects(() => w.callback(started, { issuer }), error => error.code === 'OAUTH_ISSUER_MISMATCH');
    assert.equal(w.calls.length, 0);
  } finally { w.close(); }
});

test('unknown/expanded scopes, caller endpoint/secret fields and insecure configuration are refused', async () => {
  const w = world();
  try {
    await assert.rejects(() => w.service.begin('fixture-provider', w.owner, ['write:items']), error => error.code === 'OAUTH_SCOPE_NOT_CONFIGURED');
    await assert.rejects(() => w.service.begin('fixture-provider', { ...w.owner, client_secret: 'private' }, ['read:items']), error => error.code === 'OAUTH_PRINCIPAL_INVALID');
    w.setProvider({ ...initialProvider(), authorization_endpoint: 'https://idp.example.com/authorize?redirect_uri=evil' });
    assert.equal(w.service.configured('fixture-provider'), false);
    await assert.rejects(w.begin, error => error.code === 'OAUTH_PROVIDER_INVALID');
    w.setProvider({ ...initialProvider(), token_endpoint: 'http://idp.example.com/token' });
    await assert.rejects(w.begin, error => error.code === 'OAUTH_PROVIDER_INVALID');
    assert.equal(w.calls.length, 0);
  } finally { w.close(); }
});

test('provider revision/endpoint drift refuses an old callback before exchange', async () => {
  const w = world();
  try {
    const started = await w.begin(); w.setProvider({ ...initialProvider(), revision: 2 });
    await assert.rejects(() => w.callback(started), error => error.code === 'OAUTH_PROVIDER_CHANGED');
    assert.equal(w.calls.length, 0);
  } finally { w.close(); }
});

test('explicit consent denial consumes intent without token exchange or activation', async () => {
  const w = world();
  try {
    const started = await w.begin(), out = await w.callback(started, { code: undefined, error: 'access_denied' });
    assert.equal(out.intent.state, 'denied'); assert.equal(w.calls.length, 0);
    await assert.rejects(() => w.callback(started), error => error.code === 'OAUTH_CALLBACK_REPLAY_REFUSED');
  } finally { w.close(); }
});

test('provider authorization errors remain failures and are not reported as human denial', async () => {
  for (const error of ['temporarily_unavailable', 'server_error']) {
    const w = world();
    try {
      const started = await w.begin(), out = await w.callback(started, { code: undefined, error });
      assert.equal(out.intent.state, 'failed'); assert.equal(out.code, 'OAUTH_AUTHORIZATION_FAILED');
      assert.equal(out.provider_error, error); assert.equal(w.calls.length, 0);
    } finally { w.close(); }
  }
});

test('lost code exchange remains uncertain, secret errors are suppressed and replay cannot retry', async () => {
  const w = world({ exchange: async () => { throw new Error('PRIVATE_TOKEN_FROM_UPSTREAM'); } });
  try {
    const started = await w.begin(), out = await w.callback(started);
    assert.equal(out.intent.state, 'reconcile_required'); assert.equal(out.execution_available, false);
    assert.equal(JSON.stringify(out).includes('PRIVATE_TOKEN_FROM_UPSTREAM'), false);
    await assert.rejects(() => w.callback(started), error => error.code === 'OAUTH_CALLBACK_REPLAY_REFUSED');
    assert.equal(w.calls.length, 1);
  } finally { w.close(); }
});

test('expanded returned scopes or secret-bearing receipts cannot bind an account', async () => {
  for (const receipt of [{ account_subject: 'fixture', granted_scopes: ['write:items'], enrollment_receipt_id: randomUUID() },
    { account_subject: 'fixture', granted_scopes: ['read:items'], enrollment_receipt_id: randomUUID(), access_token: 'PRIVATE_TOKEN' }]) {
    const w = world({ exchange: async () => receipt });
    try { const out = await w.callback(await w.begin()); assert.equal(out.intent.state, 'reconcile_required'); assert.equal('account' in out, false); }
    finally { w.close(); }
  }
});

test('concurrent callbacks dispatch at most one token exchange across awaited authority checks', async () => {
  let hold = false; const checks = [];
  const w = world({ authorize: () => hold ? new Promise(resolve => checks.push(resolve)) : true });
  try {
    const started = await w.begin(); hold = true;
    const first = w.callback(started), second = w.callback(started);
    await new Promise(resolve => setImmediate(resolve)); assert.equal(checks.length, 2);
    hold = false; for (const release of checks) release(true);
    const outcomes = await Promise.allSettled([first, second]);
    assert.equal(w.calls.length, 1); assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(outcomes.filter(r => r.status === 'rejected').length, 1);
  } finally { w.close(); }
});

test('cancel during token exchange cannot be overwritten by a late account result', async () => {
  let finish; const w = world({ exchange: () => new Promise(resolve => { finish = resolve; }) });
  try {
    const started = await w.begin(), pending = w.callback(started);
    await new Promise(resolve => setImmediate(resolve)); assert.ok(finish);
    const cancelled = await w.service.cancel(started.intent.id, w.owner); assert.equal(cancelled.intent.state, 'reconcile_required');
    finish({ account_subject: 'late-fixture', granted_scopes: ['read:items'], enrollment_receipt_id: randomUUID() });
    const out = await pending; assert.equal(out.intent.state, 'reconcile_required'); assert.equal('account' in out, false);
  } finally { w.close(); }
});

test('authority expiry during provider await withholds returned account and needs reconciliation', async () => {
  let eligible = true;
  const w = world({ authorize: () => eligible, exchange: async () => { eligible = false;
    return { account_subject: 'late-fixture', granted_scopes: ['read:items'], enrollment_receipt_id: randomUUID() }; } });
  try { const out = await w.callback(await w.begin()); assert.equal(out.intent.state, 'reconcile_required'); assert.equal('account' in out, false); }
  finally { w.close(); }
});

test('closing lifecycle fences late provider results and cannot return account acceptance', async () => {
  let finish; const w = world({ exchange: () => new Promise(resolve => { finish = resolve; }) });
  try {
    const started = await w.begin(), pending = w.callback(started);
    await new Promise(resolve => setImmediate(resolve)); assert.ok(finish);
    w.service.close();
    finish({ account_subject: 'late-fixture', granted_scopes: ['read:items'], enrollment_receipt_id: randomUUID() });
    const out = await pending; assert.equal(out.intent.state, 'reconcile_required'); assert.equal('account' in out, false);
    assert.equal(w.calls[0].intent_id, started.intent.id);
  } finally { w.close(); }
});

test('reserved intents expire, cancel and restart without inheriting callback authority', async () => {
  const w = world();
  try {
    let started = await w.begin(); w.advance(300001); w.service.sweep();
    await assert.rejects(() => w.callback(started), error => error.code === 'OAUTH_CALLBACK_REPLAY_REFUSED');
    started = await w.begin(); const cancelled = await w.service.cancel(started.intent.id, w.owner); assert.equal(cancelled.intent.state, 'cancelled');
    await assert.rejects(() => w.callback(started), error => error.code === 'OAUTH_CALLBACK_REPLAY_REFUSED');
    started = await w.begin(); w.service.close();
    await assert.rejects(() => w.callback(started), error => error.code === 'OAUTH_LIFECYCLE_CLOSED');
    assert.equal(w.calls.length, 0);
  } finally { w.close(); }
});

test('close is terminal and fences begin awaiting authority before any URL or intent can be created', async () => {
  let approve; const w = world({ authorize: () => new Promise(resolve => { approve = resolve; }) });
  try {
    const pending = w.begin(); assert.ok(approve); assert.equal(w.service.configured('fixture-provider'), true);
    w.service.close(); approve(true);
    await assert.rejects(() => pending, error => error.code === 'OAUTH_LIFECYCLE_CLOSED');
    assert.equal(w.service.configured('fixture-provider'), false);
    await assert.rejects(w.begin, error => error.code === 'OAUTH_LIFECYCLE_CLOSED');
    await assert.rejects(() => w.service.callback(randomUUID(), w.owner, {}), error => error.code === 'OAUTH_LIFECYCLE_CLOSED');
    await assert.rejects(() => w.service.cancel(randomUUID(), w.owner), error => error.code === 'OAUTH_LIFECYCLE_CLOSED');
    assert.equal(w.calls.length, 0);
    w.service.close(); w.service.sweep();
  } finally { w.close(); }
});

test('bounded pending intents do not silently evict still-authorized callbacks', async () => {
  const w = world();
  try {
    for (let n = 0; n < 4; n++) await w.begin();
    await assert.rejects(w.begin, error => error.code === 'OAUTH_INTENT_LIMIT');
    assert.equal(w.calls.length, 0);
  } finally { w.close(); }
});
