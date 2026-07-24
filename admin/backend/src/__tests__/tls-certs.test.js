// Manual TLS certificate core logic (lib/tls-certs.js): PEM parsing, cert/key
// pairing, chain assembly, the host→cert resolver (most-specific wins), the
// Caddyfile tls directive, and expiry classification. The crypto-backed tests
// generate real certs with openssl (skipped if openssl is absent); the pure
// matching/resolver/expiry tests need no external tools and always run.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseCertificate, validateCertKeyPair, assembleServedChain, CERT_ERRORS,
  normalizeHost, matchScore, certCoversHost, bestScoreForCert, resolveCertForHost,
  manualTlsDirective, expiryStatus, daysUntil, isEncryptedKeyPem, redactKeyMaterial,
} from '../lib/tls-certs.js';

// ---- openssl fixtures ----
let openssl = true;
try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); } catch { openssl = false; }
const dir = openssl ? mkdtempSync(join(tmpdir(), 'ppcert-')) : null;
function ossl(args) { execFileSync('openssl', args, { cwd: dir, stdio: ['ignore', 'ignore', 'ignore'] }); }
function read(f) { return readFileSync(join(dir, f), 'utf8'); }

function makeCert(base, sans, extra = []) {
  const san = sans.map((s) => `DNS:${s}`).join(',');
  ossl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', `${base}.key`, '-out', `${base}.crt`, '-days', '5',
    '-subj', `/CN=${sans[0]}`, '-addext', `subjectAltName=${san}`, ...extra]);
  return { certPem: read(`${base}.crt`), keyPem: read(`${base}.key`) };
}

test.after(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

// ================= crypto-backed (openssl) =================

test('parseCertificate: extracts CN, SANs incl. wildcard, validity, fingerprint', { skip: !openssl }, () => {
  const { certPem } = makeCert('a', ['example.com', '*.example.com', 'www.example.com']);
  const p = parseCertificate(certPem);
  assert.equal(p.commonName, 'example.com');
  assert.ok(p.coveredNames.includes('example.com'));
  assert.ok(p.coveredNames.includes('*.example.com'));
  assert.ok(p.coveredNames.includes('www.example.com'));
  assert.match(p.fingerprint256, /^[0-9A-F:]+$/);
  assert.ok(!Number.isNaN(Date.parse(p.notBefore)) && !Number.isNaN(Date.parse(p.notAfter)));
});

test('parseCertificate: garbage / non-cert PEM returns null', () => {
  assert.equal(parseCertificate('not a cert'), null);
  assert.equal(parseCertificate('-----BEGIN CERTIFICATE-----\nZm9v\n-----END CERTIFICATE-----'), null);
  assert.equal(parseCertificate(''), null);
});

test('validateCertKeyPair: matching cert+key passes and returns a normalized key', { skip: !openssl }, () => {
  const { certPem, keyPem } = makeCert('b', ['b.example.com']);
  const r = validateCertKeyPair(certPem, keyPem);
  assert.equal(r.ok, true);
  assert.match(r.normalizedKeyPem, /-----BEGIN PRIVATE KEY-----/); // unencrypted PKCS#8
  assert.equal(r.parsed.coveredNames[0], 'b.example.com');
});

test('validateCertKeyPair: mismatched key is rejected', { skip: !openssl }, () => {
  const { certPem } = makeCert('c', ['c.example.com']);
  const other = makeCert('c2', ['c2.example.com']);
  const r = validateCertKeyPair(certPem, other.keyPem);
  assert.equal(r.ok, false);
  assert.equal(r.code, CERT_ERRORS.KEY_CERT_MISMATCH);
});

test('validateCertKeyPair: malformed cert and malformed key each get a specific code', { skip: !openssl }, () => {
  const { certPem, keyPem } = makeCert('d', ['d.example.com']);
  assert.equal(validateCertKeyPair('bogus', keyPem).code, CERT_ERRORS.INVALID_CERT);
  assert.equal(validateCertKeyPair(certPem, 'bogus').code, CERT_ERRORS.INVALID_KEY);
});

test('validateCertKeyPair: passphrase-protected key needs the passphrase', { skip: !openssl }, () => {
  // Encrypted PKCS#8 key + its self-signed cert.
  ossl(['genpkey', '-algorithm', 'RSA', '-pkeyopt', 'rsa_keygen_bits:2048',
    '-aes256', '-pass', 'pass:s3cret', '-out', 'e.key']);
  ossl(['req', '-x509', '-key', 'e.key', '-passin', 'pass:s3cret', '-out', 'e.crt',
    '-days', '5', '-subj', '/CN=e.example.com', '-addext', 'subjectAltName=DNS:e.example.com']);
  const certPem = read('e.crt'); const keyPem = read('e.key');
  assert.equal(isEncryptedKeyPem(keyPem), true);
  assert.equal(validateCertKeyPair(certPem, keyPem).code, CERT_ERRORS.KEY_ENCRYPTED_NO_PASSPHRASE);
  assert.equal(validateCertKeyPair(certPem, keyPem, 'wrong').code, CERT_ERRORS.BAD_PASSPHRASE);
  const ok = validateCertKeyPair(certPem, keyPem, 's3cret');
  assert.equal(ok.ok, true);
  assert.match(ok.normalizedKeyPem, /-----BEGIN PRIVATE KEY-----/); // stored decrypted → we re-encrypt
});

test('assembleServedChain: leaf-first, intermediates appended; bad chain rejected', { skip: !openssl }, () => {
  const leaf = makeCert('lf', ['lf.example.com']);
  const inter = makeCert('in', ['inter.example.com']);
  const none = assembleServedChain(leaf.certPem);
  assert.match(none.chainPem.trim(), /-----END CERTIFICATE-----$/);
  const withChain = assembleServedChain(leaf.certPem, inter.certPem);
  assert.equal(withChain.ok, true);
  assert.equal((withChain.chainPem.match(/BEGIN CERTIFICATE/g) || []).length, 2);
  assert.ok(withChain.chainPem.indexOf(leaf.certPem.trim().slice(30)) >= 0);
  assert.equal(assembleServedChain(leaf.certPem, 'not pem').ok, false);
});

// ================= pure logic (always runs) =================

test('normalizeHost: lower-cases, strips trailing dot and port', () => {
  assert.equal(normalizeHost('WWW.Example.com.'), 'www.example.com');
  assert.equal(normalizeHost('app.example.com:8443'), 'app.example.com');
  assert.equal(normalizeHost(''), '');
});

test('matchScore: exact=100, single-label wildcard=50, apex & deep-label not covered', () => {
  assert.equal(matchScore('example.com', 'example.com'), 100);
  assert.equal(matchScore('*.example.com', 'foo.example.com'), 50);
  assert.equal(matchScore('*.example.com', 'example.com'), 0);        // wildcard != apex
  assert.equal(matchScore('*.example.com', 'a.b.example.com'), 0);    // one label only
  assert.equal(matchScore('*.example.com', 'foo.other.com'), 0);
  assert.equal(matchScore('EXAMPLE.com', 'example.com'), 100);        // case-insensitive
});

test('certCoversHost / bestScoreForCert', () => {
  const names = ['example.com', '*.example.com'];
  assert.equal(certCoversHost(names, 'example.com'), true);
  assert.equal(certCoversHost(names, 'api.example.com'), true);
  assert.equal(certCoversHost(names, 'other.com'), false);
  assert.equal(bestScoreForCert(names, 'example.com'), 100);
  assert.equal(bestScoreForCert(names, 'api.example.com'), 50);
});

test('resolveCertForHost: most-specific wins; deterministic tie-break by notAfter then id', () => {
  const wild = { id: 1, coveredNames: ['*.example.com'], notAfter: '2027-01-01T00:00:00Z' };
  const exact = { id: 2, coveredNames: ['api.example.com'], notAfter: '2026-06-01T00:00:00Z' };
  // exact (100) beats wildcard (50) even though the wildcard lives longer.
  assert.equal(resolveCertForHost([wild, exact], 'api.example.com').id, 2);
  // wildcard covers a different subdomain.
  assert.equal(resolveCertForHost([wild, exact], 'web.example.com').id, 1);
  // no coverage → null.
  assert.equal(resolveCertForHost([wild, exact], 'nope.org'), null);
  // tie on score → later notAfter wins.
  const a = { id: 3, coveredNames: ['*.t.com'], notAfter: '2026-01-01T00:00:00Z' };
  const b = { id: 4, coveredNames: ['*.t.com'], notAfter: '2028-01-01T00:00:00Z' };
  assert.equal(resolveCertForHost([a, b], 'x.t.com').id, 4);
  assert.equal(resolveCertForHost([b, a], 'x.t.com').id, 4); // order-independent
});

test('manualTlsDirective: emits the Caddyfile line that disables ACME for the site', () => {
  assert.equal(manualTlsDirective('/c/x.crt', '/c/x.key'), '    tls /c/x.crt /c/x.key');
  assert.equal(manualTlsDirective('/c/x.crt', '/c/x.key', '  '), '  tls /c/x.crt /c/x.key');
});

test('expiryStatus / daysUntil: expired, expiring-soon, valid', () => {
  const now = Date.parse('2026-07-01T00:00:00Z');
  assert.equal(expiryStatus('2026-06-01T00:00:00Z', now), 'expired');
  assert.equal(expiryStatus('2026-07-10T00:00:00Z', now), 'expiring'); // within 21d
  assert.equal(expiryStatus('2026-12-01T00:00:00Z', now), 'valid');
  assert.equal(expiryStatus('not-a-date', now), 'unknown');
  assert.equal(daysUntil('2026-07-11T00:00:00Z', now), 10);
  assert.equal(daysUntil('2026-06-21T00:00:00Z', now), -10);
});

test('redactKeyMaterial: masks any PEM block that reaches an error/log path', () => {
  const leaked = 'oops: -----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----';
  assert.equal(redactKeyMaterial(leaked), 'oops: [REDACTED PEM]');
  assert.ok(!redactKeyMaterial(leaked).includes('MIIabc'));
});
