// Mock2 Phase M1 tests — parent-domain validation, the selectable predicate,
// the wildcard-DNS / probe-cert verdicts, the Caddy site-file builders, and the
// verification pipeline driven with injected deps.
//
// Stub-first (risk R9 / docs/known-issues.md): this imports ONLY the pure
// decision modules (domain-logic.js), the pure Caddy string builders
// (caddy.js), and the orchestrator (verify.js) exercised entirely through
// injected fakes. None of these pulls in better-sqlite3 or Express, so the
// suite never worsens the fresh-checkout native-module gap. The DB access
// (domains.js/queue.js) and real DNS/ACME are covered by the manual M1
// verification checklist, not here.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeDomain,
  validateDomain,
  isSelectable,
  publicDomainShape,
  evaluateBaseDomain,
  canaryLabel,
  evaluateWildcardDns,
  classifyProbe,
  nextVerifyStatus,
  parseHostIps,
  looksLikeIp,
} from '../mock2/domain-logic.js';
import {
  buildMock2SiteBlock,
  buildMock2DomainConfig,
  mock2SiteFileName,
  buildCertRmTargets,
} from '../mock2/caddy.js';
import { runVerification } from '../mock2/verify.js';

// ---- domain validation ----

test('validateDomain: accepts a bare multi-label domain', () => {
  const r = validateDomain('dev.example.com');
  assert.equal(r.ok, true);
  assert.equal(r.domain, 'dev.example.com');
});

test('validateDomain: normalizes case, trailing dot, and a stray leading *.', () => {
  assert.equal(validateDomain('  DEV.Example.COM. ').domain, 'dev.example.com');
  assert.equal(validateDomain('*.dev.example.com').domain, 'dev.example.com');
  assert.equal(normalizeDomain('*.DEV.example.com.'), 'dev.example.com');
});

test('validateDomain: rejects an embedded wildcard, a URL, empty, and a bare label', () => {
  assert.equal(validateDomain('foo.*.example.com').ok, false);
  assert.equal(validateDomain('https://dev.example.com').ok, false);
  assert.equal(validateDomain('').ok, false);
  assert.equal(validateDomain('localhost').ok, false); // single label
  assert.equal(validateDomain('-bad.example.com').ok, false); // leading dash
});

// ---- selectable predicate (the M2 gate) ----

test('isSelectable: true when DNS-verified (or legacy cert_ok) AND enabled', () => {
  assert.equal(isSelectable({ verify_status: 'dns_ok', enabled: 1 }), true);
  assert.equal(isSelectable({ verify_status: 'cert_ok', enabled: 1 }), true);
  assert.equal(isSelectable({ verify_status: 'dns_ok', enabled: 0 }), false);
  assert.equal(isSelectable({ verify_status: 'cert_ok', enabled: 0 }), false);
  assert.equal(isSelectable({ verify_status: 'pending', enabled: 1 }), false);
  assert.equal(isSelectable({ verify_status: 'failed', enabled: 1 }), false);
  assert.equal(isSelectable(null), false);
});

test('publicDomainShape: derives selectable, never leaks the DNS credential blob', () => {
  const shaped = publicDomainShape({
    id: 3,
    domain: 'dev.example.com',
    verify_status: 'cert_ok',
    enabled: 1,
    dns_provider: 'route53',
    dns_credentials_enc: 'SECRET-CIPHERTEXT',
    cert_path: null,
  });
  assert.equal(shaped.selectable, true);
  assert.equal(shaped.enabled, true);
  assert.equal(shaped.has_dns_credentials, true);
  assert.equal('dns_credentials_enc' in shaped, false);
  assert.ok(!JSON.stringify(shaped).includes('SECRET-CIPHERTEXT'));
});

// ---- base-domain (apex) availability ----

test('evaluateBaseDomain: free when nothing else answers on the hostname', () => {
  const r = evaluateBaseDomain({
    domain: 'Example.COM.',
    services: [{ id: 's1', name: 'other', domain: 'app.example.com' }],
    routes: [{ id: 'r1', domain: 'api.example.com' }],
    projects: [{ id: 4, name: 'Sibling', custom_domain: 'demo.example.com' }],
    adminDomain: 'admin.example.com',
  });
  assert.equal(r.available, true);
  assert.equal(r.domain, 'example.com'); // normalized before comparing
  assert.equal(r.claimed_by, null);
});

test('evaluateBaseDomain: a service, a route, a project, or the dashboard claims it', () => {
  const svc = evaluateBaseDomain({
    domain: 'example.com',
    services: [{ id: 's1', name: 'Marketing site', domain: 'example.com' }],
  });
  assert.equal(svc.available, false);
  assert.equal(svc.claimed_by.kind, 'service');
  assert.match(svc.claimed_by.label, /Marketing site/);

  const route = evaluateBaseDomain({ domain: 'example.com', routes: [{ id: 'r1', domain: 'EXAMPLE.com' }] });
  assert.equal(route.available, false);
  assert.equal(route.claimed_by.kind, 'route');

  const proj = evaluateBaseDomain({
    domain: 'example.com',
    projects: [{ id: 7, name: 'Landing', custom_domain: 'example.com' }],
  });
  assert.equal(proj.available, false);
  assert.equal(proj.claimed_by.kind, 'project');
  assert.equal(proj.claimed_by.id, 7);

  // An archived project still holds its hostname (it is rehydratable) and says so.
  const archived = evaluateBaseDomain({
    domain: 'example.com',
    projects: [{ id: 7, name: 'Landing', custom_domain: 'example.com', lifecycle: 'archived' }],
  });
  assert.equal(archived.available, false);
  assert.match(archived.claimed_by.label, /archived/);

  const admin = evaluateBaseDomain({ domain: 'example.com', adminDomain: 'example.com' });
  assert.equal(admin.available, false);
  assert.equal(admin.claimed_by.kind, 'admin');
});

test('evaluateBaseDomain: a Caddy site file with no DB row still blocks it', () => {
  const r = evaluateBaseDomain({ domain: 'example.com', siteFileExists: true });
  assert.equal(r.available, false);
  assert.equal(r.claimed_by.kind, 'caddy_site');
});

test('evaluateBaseDomain: excludeProjectId lets a project keep its own hostname', () => {
  const projects = [{ id: 7, name: 'Landing', custom_domain: 'example.com' }];
  assert.equal(evaluateBaseDomain({ domain: 'example.com', projects, excludeProjectId: 7 }).available, true);
  assert.equal(evaluateBaseDomain({ domain: 'example.com', projects, excludeProjectId: 8 }).available, false);
});

test('evaluateBaseDomain: a subdomain claim never blocks the apex (and vice versa)', () => {
  assert.equal(
    evaluateBaseDomain({ domain: 'example.com', services: [{ id: 's', name: 'wild', domain: '*.example.com' }] }).available,
    true,
  );
  assert.equal(
    evaluateBaseDomain({ domain: 'dev.example.com', services: [{ id: 's', name: 'root', domain: 'example.com' }] }).available,
    true,
  );
});

test('evaluateBaseDomain: an empty/invalid domain is never available', () => {
  assert.equal(evaluateBaseDomain({ domain: '' }).available, false);
  assert.equal(evaluateBaseDomain({}).available, false);
});

test('publicDomainShape: carries the base-domain verdict, null when not computed', () => {
  const row = { id: 3, domain: 'example.com', verify_status: 'dns_ok', enabled: 1 };
  const plain = publicDomainShape(row);
  assert.equal(plain.base_domain_available, null);
  assert.equal(plain.base_domain_claimed_by, null);

  const withVerdict = publicDomainShape(row, {
    baseDomain: evaluateBaseDomain({
      domain: 'example.com',
      services: [{ id: 's1', name: 'Marketing site', domain: 'example.com' }],
    }),
  });
  assert.equal(withVerdict.base_domain_available, false);
  assert.equal(withVerdict.base_domain_claimed_by.kind, 'service');
});

test('canaryLabel: DNS-safe, recognizable, bounded', () => {
  assert.equal(canaryLabel('AB!@#cd1234ef99zz'), '_mock2-verify-abcd1234ef99');
  assert.equal(canaryLabel(''), '_mock2-verify-probe');
});

// ---- wildcard DNS verdict ----

test('evaluateWildcardDns: no resolution → not ok', () => {
  const v = evaluateWildcardDns({ resolvedIps: [], expectedIps: ['1.2.3.4'] });
  assert.equal(v.ok, false);
  assert.match(v.reason, /did not resolve/);
});

test('evaluateWildcardDns: resolves but host IP unknown → ok, not cross-checked', () => {
  const v = evaluateWildcardDns({ resolvedIps: ['1.2.3.4'], expectedIps: [] });
  assert.equal(v.ok, true);
  assert.equal(v.matched, false);
});

test('evaluateWildcardDns: match / mismatch', () => {
  assert.equal(evaluateWildcardDns({ resolvedIps: ['1.2.3.4'], expectedIps: ['1.2.3.4'] }).matched, true);
  const miss = evaluateWildcardDns({ resolvedIps: ['9.9.9.9'], expectedIps: ['1.2.3.4'] });
  assert.equal(miss.ok, false);
  assert.match(miss.reason, /answers on 1\.2\.3\.4/);
});

// ---- MOCK2_PUBLIC_IP parsing (defensive against a polluted env value) ----

test('parseHostIps: keeps valid IPv4/IPv6, drops blanks', () => {
  assert.deepEqual(parseHostIps('1.2.3.4'), ['1.2.3.4']);
  assert.deepEqual(parseHostIps('1.2.3.4, 5.6.7.8'), ['1.2.3.4', '5.6.7.8']);
  assert.deepEqual(parseHostIps('2001:db8::1'), ['2001:db8::1']);
  assert.deepEqual(parseHostIps(''), []);
  assert.deepEqual(parseHostIps(undefined), []);
});

test('parseHostIps: drops a stray inline comment left in the env value', () => {
  // Regression: docker-compose env_file / systemd EnvironmentFile do not strip
  // an inline `# comment`, so `MOCK2_PUBLIC_IP=  # TODO: review` reached
  // process.env as the literal string `# TODO: review` and the DNS cross-check
  // reported "wildcard resolves to X but this host answers on # TODO: review".
  assert.deepEqual(parseHostIps('# TODO: review'), []);
  assert.deepEqual(parseHostIps('  # TODO: review'), []);
  // A real IP with an un-stripped trailing note in the SAME comma-field can't
  // be safely salvaged, so it is dropped (conservative → "not cross-checked").
  assert.deepEqual(parseHostIps('96.88.158.118 # TODO: review'), []);
  // With the garbage filtered out, evaluateWildcardDns downgrades to
  // "resolves but not cross-checked" (ok) rather than a false mismatch.
  const v = evaluateWildcardDns({ resolvedIps: ['96.88.158.118'], expectedIps: parseHostIps('# TODO: review') });
  assert.equal(v.ok, true);
  assert.equal(v.matched, false);
});

test('looksLikeIp: basic shape guard', () => {
  assert.equal(looksLikeIp('10.0.0.1'), true);
  assert.equal(looksLikeIp('::1'), true);
  assert.equal(looksLikeIp('999.1.1.1'), false);
  assert.equal(looksLikeIp('# TODO: review'), false);
  assert.equal(looksLikeIp('review'), false);
});

// ---- probe-cert verdict ----

test('classifyProbe: needs BOTH a 2xx AND a publicly-trusted chain', () => {
  assert.equal(classifyProbe({ status: 200, tlsAuthorized: true }).ok, true);
  assert.equal(classifyProbe({ status: 200, tlsAuthorized: false }).ok, false); // Caddy internal CA
  assert.equal(classifyProbe({ status: 502, tlsAuthorized: true }).ok, false);
  assert.equal(classifyProbe({ error: 'ECONNREFUSED' }).ok, false);
});

test('nextVerifyStatus: state machine', () => {
  assert.equal(nextVerifyStatus('dns', true), 'dns_ok');
  assert.equal(nextVerifyStatus('cert', true), 'cert_ok');
  assert.equal(nextVerifyStatus('dns', false), 'failed');
  assert.equal(nextVerifyStatus('cert', false), 'failed');
});

// ---- Caddy site-file builders ----

test('buildMock2SiteBlock: carries the dev-plane guarantees', () => {
  const block = buildMock2SiteBlock({ fqdn: 'p-abc123.dev.example.com' });
  assert.match(block, /^p-abc123\.dev\.example\.com \{/m);
  assert.match(block, /X-Robots-Tag "noindex/);
  assert.match(block, /handle \/robots\.txt/);
  assert.match(block, /Disallow: \//);
  // forward_auth is present but every line disabled (commented).
  assert.match(block, /#\s*forward_auth/);
  assert.doesNotMatch(block, /^\s*forward_auth/m);
  assert.match(block, /respond ".*Dev preview host ready/s);
});

test('buildMock2SiteBlock: placeholder HTML quotes are escaped for the Caddyfile', () => {
  // Regression: the placeholder HTML is embedded in `respond "..."`. Its own
  // attribute quotes (lang="en", style="...") were emitted raw, so Caddy read
  // `respond "<!doctype html><html lang="` as the token and `caddy adapt`
  // failed ("Caddy reload failed during probe (adapt)"). Every double quote
  // inside the respond body must be backslash-escaped.
  const block = buildMock2SiteBlock({ fqdn: 'p-abc123.dev.example.com' });
  // The HTML's own attribute quotes must be backslash-escaped, never raw.
  assert.match(block, /lang=\\"en\\"/);
  assert.doesNotMatch(block, /lang="en"/);
});

test('buildMock2SiteBlock: frameAncestor relaxes the live route so the dashboard can embed it', () => {
  // The generated app refuses framing (constitution §5); when the caller supplies
  // the admin origin, the live route drops X-Frame-Options and scopes CSP
  // frame-ancestors to that origin so ONLY the dashboard preview can embed it.
  const block = buildMock2SiteBlock({
    fqdn: 'notes.mock2.example.com', upstream: '10.0.0.5:8080', frameAncestor: 'https://admin.example.com',
  });
  assert.match(block, /reverse_proxy 10\.0\.0\.5:8080 \{/);
  assert.match(block, /header_down -X-Frame-Options/);
  assert.match(block, /header_down Content-Security-Policy "frame-ancestors\[\^;\]\*" "frame-ancestors 'self' https:\/\/admin\.example\.com"/);
});

test('buildMock2SiteBlock: no frameAncestor (or no upstream) leaves headers untouched', () => {
  // Default: unchanged behavior — no header rewrite at all.
  assert.doesNotMatch(buildMock2SiteBlock({ fqdn: 'x.example.com', upstream: '10.0.0.5:8080' }), /header_down/);
  // A malformed frame origin is ignored (defensive; never injected into Caddy).
  assert.doesNotMatch(
    buildMock2SiteBlock({ fqdn: 'x.example.com', upstream: '10.0.0.5:8080', frameAncestor: 'javascript:alert(1)' }),
    /header_down/,
  );
  // A placeholder block (no upstream) never carries the framing headers.
  assert.doesNotMatch(buildMock2SiteBlock({ fqdn: 'x.example.com', frameAncestor: 'https://admin.example.com' }), /header_down/);
});

test('buildMock2DomainConfig: empty slug set → header-only (valid no-op file)', () => {
  const cfg = buildMock2DomainConfig({ domain: 'dev.example.com', fqdns: [] });
  assert.match(cfg, /# Parent domain: dev\.example\.com/);
  assert.doesNotMatch(cfg, /\{/); // no site blocks at all
});

test('buildMock2DomainConfig: one block per FQDN', () => {
  const cfg = buildMock2DomainConfig({
    domain: 'dev.example.com',
    fqdns: ['a.dev.example.com', { fqdn: 'b.dev.example.com', note: 'canary' }],
  });
  assert.match(cfg, /a\.dev\.example\.com \{/);
  assert.match(cfg, /b\.dev\.example\.com \{/);
  assert.match(cfg, /# canary/);
});

test('buildMock2SiteBlock: a manual-cert tlsDecision emits `tls <cert> <key>` (disables ACME for the FQDN)', () => {
  const block = buildMock2SiteBlock({
    fqdn: 'p-abc.dev.example.com', upstream: '10.0.0.2:8080',
    tlsDecision: { mode: 'manual', certFile: '/etc/caddy/pp-manual-certs/cert-1.pem', keyFile: '/etc/caddy/pp-manual-certs/cert-1.key' },
  });
  assert.match(block, /\ttls \/etc\/caddy\/pp-manual-certs\/cert-1\.pem \/etc\/caddy\/pp-manual-certs\/cert-1\.key/);
  assert.match(block, /reverse_proxy 10\.0\.0\.2:8080/);
});

test('buildMock2SiteBlock: internal mode emits `tls internal`; no decision keeps ACME behavior', () => {
  assert.match(buildMock2SiteBlock({ fqdn: 'x.dev.example.com', tlsDecision: { mode: 'internal' } }), /\ttls internal/);
  assert.doesNotMatch(buildMock2SiteBlock({ fqdn: 'x.dev.example.com' }), /\ttls /); // unchanged: no tls directive
});

test('buildMock2DomainConfig: resolveTls callback applies per-FQDN manual certs', () => {
  const cfg = buildMock2DomainConfig({
    domain: 'dev.example.com',
    fqdns: ['covered.dev.example.com', 'plain.dev.example.com'],
    resolveTls: (fqdn) => (fqdn === 'covered.dev.example.com'
      ? { mode: 'manual', certFile: '/c/c.pem', keyFile: '/c/c.key' } : null),
  });
  assert.match(cfg, /covered\.dev\.example\.com \{\n\ttls \/c\/c\.pem \/c\/c\.key/);
  // The uncovered FQDN gets no tls directive (still ACME/HTTP-01).
  const plainBlock = cfg.slice(cfg.indexOf('plain.dev.example.com'));
  assert.doesNotMatch(plainBlock, /tls /);
});

test('buildCertRmTargets: builds per-issuer globs, dedupes, drops unsafe FQDNs', () => {
  const t = buildCertRmTargets(['my-app.dev.example.com', 'my-app.dev.example.com'], '/data');
  assert.deepEqual(t, ['"/data/certificates"/*/"my-app.dev.example.com"']);
  // Shell-unsafe values never reach the rm command.
  assert.deepEqual(buildCertRmTargets(['a.com; rm -rf /', 'b $(x)`y`', 'ok.dev.example.com'], '/d'),
    ['"/d/certificates"/*/"ok.dev.example.com"']);
  assert.deepEqual(buildCertRmTargets([], '/d'), []);
  assert.deepEqual(buildCertRmTargets(['', null, undefined], '/d'), []);
});

test('mock2SiteFileName: filesystem-safe', () => {
  assert.equal(mock2SiteFileName('dev.example.com'), 'dev.example.com.caddy');
});

// ---- verification pipeline (injected deps, no real IO) ----

function recordingHooks() {
  const calls = { progress: [], fail: [], succeed: 0 };
  return {
    hooks: {
      progress: (s) => calls.progress.push(s),
      fail: (r) => calls.fail.push(r),
      succeed: () => { calls.succeed += 1; },
    },
    calls,
  };
}

test('runVerification: default is DNS-only → dns_ok, no canary/Caddy write', async () => {
  // Operator decision: verification proves the wildcard DNS points here and
  // stops — the per-slug cert is minted at project-create time, so there is no
  // canary probe and no Caddy write during registration.
  const { hooks, calls } = recordingHooks();
  let siteWritten = false;
  const status = await runVerification('dev.example.com', hooks, {
    resolve: async () => ['1.2.3.4'],
    expectedHostIps: () => ['1.2.3.4'],
    probe: async () => { throw new Error('probe must not run by default'); },
    writeSite: async () => { siteWritten = true; },
    reload: async () => ({ ok: true }),
  });
  assert.equal(status, 'dns_ok');
  assert.deepEqual(calls.progress, ['pending', 'dns_ok']);
  assert.equal(calls.succeed, 1);
  assert.equal(calls.fail.length, 0);
  assert.equal(siteWritten, false);
});

test('runVerification: opt-in probe → dns_ok then cert_ok, canary published then cleaned', async () => {
  const { hooks, calls } = recordingHooks();
  const siteWrites = [];
  const status = await runVerification('dev.example.com', hooks, {
    resolve: async () => ['1.2.3.4'],
    expectedHostIps: () => ['1.2.3.4'],
    probe: async () => ({ status: 200, tlsAuthorized: true }),
    writeSite: async (domain, fqdns) => { siteWrites.push(fqdns); },
    reload: async () => ({ ok: true }),
    randHex: () => 'deadbeef',
    probeAttempts: 1,
    probeDelayMs: 0,
    runProbe: true,
  });
  assert.equal(status, 'cert_ok');
  assert.deepEqual(calls.progress, ['pending', 'dns_ok']);
  assert.equal(calls.succeed, 1);
  assert.equal(calls.fail.length, 0);
  // First write publishes the canary block; last write returns to steady state.
  assert.equal(siteWrites[0][0].fqdn, '_mock2-verify-deadbeef.dev.example.com');
  assert.deepEqual(siteWrites[siteWrites.length - 1], []);
});

test('runVerification: DNS failure → fail, no probe/site write', async () => {
  const { hooks, calls } = recordingHooks();
  let siteWritten = false;
  const status = await runVerification('dev.example.com', hooks, {
    resolve: async () => [], // NXDOMAIN
    expectedHostIps: () => ['1.2.3.4'],
    probe: async () => { throw new Error('should not probe'); },
    writeSite: async () => { siteWritten = true; },
    reload: async () => ({ ok: true }),
  });
  assert.equal(status, 'failed');
  assert.equal(siteWritten, false);
  assert.equal(calls.fail.length, 1);
  assert.match(calls.fail[0], /DNS check failed/);
});

test('runVerification: probe never trusts cert → fail after cleanup', async () => {
  const { hooks, calls } = recordingHooks();
  const siteWrites = [];
  const status = await runVerification('dev.example.com', hooks, {
    resolve: async () => ['1.2.3.4'],
    expectedHostIps: () => [],
    probe: async () => ({ status: 200, tlsAuthorized: false }), // Caddy internal CA
    writeSite: async (d, fqdns) => { siteWrites.push(fqdns); },
    reload: async () => ({ ok: true }),
    probeAttempts: 2,
    probeDelayMs: 0,
    runProbe: true,
  });
  assert.equal(status, 'failed');
  assert.equal(calls.succeed, 0);
  assert.match(calls.fail[0], /Probe certificate not issued/);
  // Cleanup still returns the file to steady state.
  assert.deepEqual(siteWrites[siteWrites.length - 1], []);
});

test('runVerification: reload failure during probe → fail', async () => {
  const { hooks, calls } = recordingHooks();
  const status = await runVerification('dev.example.com', hooks, {
    resolve: async () => ['1.2.3.4'],
    expectedHostIps: () => ['1.2.3.4'],
    probe: async () => ({ status: 200, tlsAuthorized: true }),
    writeSite: async () => {},
    reload: async () => ({ ok: false, stage: 'adapt', error: 'bad config' }),
    runProbe: true,
  });
  assert.equal(status, 'failed');
  assert.match(calls.fail[0], /reload failed/);
});
