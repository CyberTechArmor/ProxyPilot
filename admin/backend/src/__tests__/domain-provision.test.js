// Domain provisioning — pure decision layer (lib/domain-provision-logic.js).
// Stub-first: no db.js import, no better-sqlite3, no Caddy. Covers the
// certificate-method selection order, the DNS-01 specified-domain list,
// Caddy site-block generation (incl. the injection guard), API-key
// hashing/masking, response masking, and ACME error classification.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DOMAIN_RE, UPSTREAM_RE, validateProvisionInput,
  parseDns01List, matchesDns01List, resolveCertMethod,
  buildSiteBlock, provisionFileName, tokenFilePath, PP_SECRETS_DIR,
  generateApiKey, hashApiKey, maskApiKey, PROVISION_SCOPE,
  publicDomainShape, classifyAcmeError,
} from '../lib/domain-provision-logic.js';

test('validation: domain, upstream, email, method, token shape', () => {
  const ok = validateProvisionInput({ domain: 'Example.COM', upstream: 'localhost:8080', acmeEmail: 'ops@example.com' });
  assert.equal(ok.ok, true);
  assert.equal(ok.value.domain, 'example.com'); // lowercased
  assert.equal(ok.value.method, 'auto');

  for (const bad of ['not a domain', 'http://x.com', 'x', '-bad.com', 'a..b.com', '*.example.com']) {
    assert.equal(validateProvisionInput({ domain: bad, upstream: 'h:1', acmeEmail: 'a@b.co' }).ok, false, `domain "${bad}" must fail`);
  }
  for (const bad of ['localhost', 'h:0', 'h:70000', 'h:80/path', 'h :80', 'a{b}:80']) {
    assert.equal(validateProvisionInput({ domain: 'example.com', upstream: bad, acmeEmail: 'a@b.co' }).ok, false, `upstream "${bad}" must fail`);
  }
  assert.equal(validateProvisionInput({ domain: 'example.com', upstream: 'h:80', acmeEmail: 'nope' }).ok, false);
  assert.equal(validateProvisionInput({ domain: 'example.com', upstream: 'h:80', acmeEmail: 'a@b.co', method: 'weird' }).ok, false);
  // IPv4 upstream and deep subdomains pass.
  assert.equal(validateProvisionInput({ domain: 'a.b.example.co.uk', upstream: '10.0.0.5:3000', acmeEmail: 'a@b.co' }).ok, true);
});

test('DNS-01 list: parse (json/lines), exact and suffix matching', () => {
  assert.deepEqual(parseDns01List('["internal.example.com", "*.example.com", "", "bad domain!"]'), ['internal.example.com', '*.example.com']);
  assert.deepEqual(parseDns01List('a.com\n*.b.com, c.com'), ['a.com', '*.b.com', 'c.com']);
  assert.deepEqual(parseDns01List(null), []);

  const list = ['internal.example.com', '*.example.com'];
  assert.equal(matchesDns01List('internal.example.com', list), 'internal.example.com');
  assert.equal(matchesDns01List('app.example.com', list), '*.example.com');
  assert.equal(matchesDns01List('deep.app.example.com', list), '*.example.com');
  // The suffix pattern matches subdomains, NOT the apex, and never a
  // lookalike suffix on a different registrable domain.
  assert.equal(matchesDns01List('example.com', ['*.example.com']), null);
  assert.equal(matchesDns01List('evilexample.com', ['*.example.com']), null);
  assert.equal(matchesDns01List('other.com', list), null);
});

test('method selection order: wildcard > explicit > list > default', () => {
  const base = { domain: 'app.example.com', dns01List: ['*.example.com'], hasGlobalToken: true };
  // 1) wildcard forces DNS-01 even when the user picked http01
  assert.equal(resolveCertMethod({ ...base, method: 'http01', wildcard: true }).method, 'dns01');
  // ...and is rejected cleanly with no token anywhere
  const rej = resolveCertMethod({ domain: 'x.com', wildcard: true, hasGlobalToken: false, hasDomainToken: false });
  assert.match(rej.error, /Wildcard certificates require the Cloudflare DNS-01 method/);
  // 2) explicit choice wins over the default
  assert.equal(resolveCertMethod({ domain: 'plain.com', method: 'dns01', hasGlobalToken: true }).method, 'dns01');
  assert.equal(resolveCertMethod({ ...base, method: 'http01' }).method, 'http01');
  // explicit dns01 without any token is a clear error
  assert.match(resolveCertMethod({ domain: 'plain.com', method: 'dns01' }).error, /needs a Cloudflare API token/);
  // 3) the specified list applies on auto
  const listHit = resolveCertMethod({ ...base, method: 'auto' });
  assert.equal(listHit.method, 'dns01');
  assert.match(listHit.reason, /DNS-01 list/);
  // list hit but no token → actionable error naming the matched pattern
  assert.match(resolveCertMethod({ domain: 'app.example.com', dns01List: ['*.example.com'] }).error, /\*\.example\.com/);
  // 4) default: standard Let's Encrypt, no token involved
  const def = resolveCertMethod({ domain: 'plain.com' });
  assert.equal(def.method, 'http01');
  assert.match(def.reason, /default/);
  // a per-domain token alone satisfies DNS-01
  assert.equal(resolveCertMethod({ domain: 'x.com', method: 'dns01', hasDomainToken: true }).method, 'dns01');
});

test('site block generation: three variants, tokens via {file…}, never inline', () => {
  const base = { domain: 'example.com', upstream: 'localhost:8080', acmeEmail: 'ops@example.com' };
  const std = buildSiteBlock({ ...base, method: 'http01' });
  assert.match(std, /^example\.com \{$/m);
  assert.match(std, /tls ops@example\.com$/m);
  assert.match(std, /reverse_proxy localhost:8080/);
  assert.doesNotMatch(std, /cloudflare/);

  const dns = buildSiteBlock({ ...base, method: 'dns01' });
  assert.match(dns, /dns cloudflare \{file\./);
  assert.ok(dns.includes(tokenFilePath('example.com')));

  const wild = buildSiteBlock({ ...base, method: 'dns01', wildcard: true });
  assert.match(wild, /^example\.com, \*\.example\.com \{$/m);
  assert.match(wild, /dns cloudflare/);

  // Injection guard: unvalidated input throws instead of emitting config.
  assert.throws(() => buildSiteBlock({ ...base, domain: 'a.com {\nadmin off' , method: 'http01' }), /unvalidated/);
  assert.throws(() => buildSiteBlock({ ...base, upstream: 'h:80\nweird', method: 'http01' }), /unvalidated/);

  // File names: ownership-prefixed site file; token file outside sites/.
  assert.equal(provisionFileName('example.com'), 'pp-provision_example.com');
  assert.ok(tokenFilePath('example.com').startsWith(`${PP_SECRETS_DIR}/cf_`));
  assert.doesNotMatch(tokenFilePath('example.com'), /sites/);
});

test('api keys: prefixed, hashed, masked; scope constant', () => {
  const raw = generateApiKey();
  assert.match(raw, /^pp_dom_/);
  assert.ok(raw.length > 30);
  assert.notEqual(generateApiKey(), raw);
  assert.match(hashApiKey(raw), /^[0-9a-f]{64}$/);
  assert.notEqual(hashApiKey(raw), hashApiKey(raw + 'x'));
  const masked = maskApiKey(raw);
  assert.ok(masked.length < raw.length);
  assert.ok(!masked.includes(raw.slice(8, 20)));
  assert.equal(PROVISION_SCOPE, 'domains:provision');
});

test('publicDomainShape: the Cloudflare token never leaves the server', () => {
  const shaped = publicDomainShape({
    id: 1, domain: 'x.com', upstream: 'h:80', method_requested: 'auto', method_resolved: 'dns01',
    wildcard: 1, acme_email: 'a@b.co', cf_token_encrypted: 'enc:v1:aa:bb:cc', cf_token_source: 'global',
    status: 'issued', last_error: null, created_at: 't', updated_at: 't',
  });
  assert.equal(shaped.cf_token, 'set');
  assert.ok(!JSON.stringify(shaped).includes('enc:v1'));
  assert.equal(publicDomainShape({ id: 2, domain: 'y.com', cf_token_encrypted: null }).cf_token, null);
});

test('ACME error classification: actionable hints per failure class', () => {
  assert.equal(classifyAcmeError('urn:ietf:params:acme:error:rateLimited: too many certificates').code, 'rate_limited');
  assert.equal(classifyAcmeError('cloudflare: could not determine zone for domain').code, 'cf_wrong_zone');
  assert.equal(classifyAcmeError('cloudflare API authentication error 403 dns record').code, 'cf_bad_token');
  assert.equal(classifyAcmeError('acme: error presenting token: dial tcp 1.2.3.4:80: timeout during connect').code, 'http_unreachable');
  assert.match(classifyAcmeError('timeout during connect http challenge').hint, /geo-block/);
  assert.equal(classifyAcmeError('challenge failed for example.com').code, 'acme_failed');
  assert.equal(classifyAcmeError('caddy started'), null);
  assert.equal(classifyAcmeError(''), null);
});
