// Manual (pasted) TLS certificate logic — the correctness core of the
// ACME-free TLS feature. Pure + Node-crypto only (no DB, no network, no Incus),
// so it is fully unit-testable. The DB/file/encryption side lives in
// tls-cert-store.js; the Caddy wiring is in the three site builders.
//
// THE ONE HARD RULE this module encodes: for every hostname a pasted cert
// covers, Caddy must serve THAT cert and must NOT attempt ACME. In a Caddyfile
// that is a single per-site directive — `tls <cert_file> <key_file>` — which
// both loads the cert and disables automatic HTTPS (ACME) for that site. The
// resolver here decides, for a given hostname, which managed cert (if any)
// covers it; the builders emit the directive when it returns non-null.
//
// Security (cid-security): this module never logs key material and never holds
// a private key at rest — callers pass PEM in, get parsed metadata + a
// normalized (decrypted, unencrypted-PKCS8) key PEM back for the store to
// encrypt. redactKeyMaterial() masks any PEM block that slips into an error.

import { X509Certificate, createPrivateKey, createPublicKey } from 'node:crypto';

// ---- error codes (stable; surfaced to the API and the UI verbatim) ----
export const CERT_ERRORS = Object.freeze({
  INVALID_CERT: 'INVALID_CERT',
  INVALID_KEY: 'INVALID_KEY',
  KEY_ENCRYPTED_NO_PASSPHRASE: 'KEY_ENCRYPTED_NO_PASSPHRASE',
  BAD_PASSPHRASE: 'BAD_PASSPHRASE',
  KEY_CERT_MISMATCH: 'KEY_CERT_MISMATCH',
  INVALID_CHAIN: 'INVALID_CHAIN',
});

// ---- PEM helpers ----

const PEM_BLOCK_RE = /-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g;

// Mask every PEM block (and any obvious key body) so it can never reach a log or
// an error response. Public certs are also masked here — err on the side of
// silence; the API returns cert metadata from the parsed fields, not raw error
// text.
export function redactKeyMaterial(text) {
  return String(text ?? '').replace(PEM_BLOCK_RE, '[REDACTED PEM]');
}

// A key PEM is passphrase-encrypted when it carries the PKCS#8 encrypted header
// or the legacy PEM Proc-Type marker. Detected by header so we never rely on a
// decrypt attempt's (OpenSSL-version-specific) error string.
export function isEncryptedKeyPem(keyPem) {
  const s = String(keyPem || '');
  return /-----BEGIN ENCRYPTED PRIVATE KEY-----/.test(s) || /Proc-Type:\s*4,ENCRYPTED/.test(s);
}

function looksLikePem(pem, label) {
  const s = String(pem || '');
  return new RegExp(`-----BEGIN [A-Z0-9 ]*${label}[A-Z0-9 ]*-----`).test(s) && /-----END /.test(s);
}

// ---- certificate parsing ----

// Parse a leaf certificate's identity + validity. Returns null on anything that
// isn't a well-formed X.509 cert (callers translate null → INVALID_CERT).
// coveredNames = the CN (when host-shaped) plus every DNS subjectAltName,
// lower-cased and de-duped, wildcards preserved (e.g. "*.example.com").
export function parseCertificate(certPem) {
  if (!looksLikePem(certPem, 'CERTIFICATE')) return null;
  let x;
  try { x = new X509Certificate(certPem); } catch { return null; }
  const names = new Set();
  // subjectAltName is a comma-joined string like "DNS:example.com, DNS:*.a.com".
  for (const part of String(x.subjectAltName || '').split(',')) {
    const m = part.trim().match(/^DNS:(.+)$/i);
    if (m) names.add(m[1].trim().toLowerCase());
  }
  // CN fallback (SAN-less certs, and belt-and-braces for SAN certs).
  const cn = (String(x.subject || '').split('\n').map((l) => l.trim()).find((l) => l.startsWith('CN=')) || '').slice(3).trim().toLowerCase();
  if (cn && /^[a-z0-9.*-]+$/.test(cn)) names.add(cn);
  return {
    commonName: cn || null,
    coveredNames: [...names],
    notBefore: new Date(x.validFrom).toISOString(),
    notAfter: new Date(x.validTo).toISOString(),
    fingerprint256: x.fingerprint256, // "AA:BB:..." uppercase hex
  };
}

// ---- cert/key validation + normalization ----

// Validate that (a) the cert is well-formed, (b) the key is well-formed (and
// decryptable with the passphrase if encrypted), and (c) the key's public half
// MATCHES the certificate. Returns { ok:true, parsed, normalizedKeyPem } where
// normalizedKeyPem is an UNENCRYPTED PKCS#8 PEM (what the store re-encrypts and
// what Caddy ultimately reads), or { ok:false, code, message }. Never throws;
// never echoes key bytes.
export function validateCertKeyPair(certPem, keyPem, passphrase = null) {
  const parsed = parseCertificate(certPem);
  if (!parsed) return { ok: false, code: CERT_ERRORS.INVALID_CERT, message: 'The certificate is not valid PEM-encoded X.509.' };

  if (!looksLikePem(keyPem, 'PRIVATE KEY')) {
    return { ok: false, code: CERT_ERRORS.INVALID_KEY, message: 'The private key is not valid PEM.' };
  }
  const encrypted = isEncryptedKeyPem(keyPem);
  if (encrypted && !String(passphrase || '').length) {
    return { ok: false, code: CERT_ERRORS.KEY_ENCRYPTED_NO_PASSPHRASE, message: 'The private key is passphrase-protected — supply the passphrase.' };
  }

  let keyObj;
  try {
    keyObj = createPrivateKey(encrypted ? { key: keyPem, passphrase: String(passphrase) } : keyPem);
  } catch (err) {
    // With an encrypted key + a supplied passphrase, a failure is almost always
    // the wrong passphrase; otherwise the key itself is malformed.
    const code = encrypted ? CERT_ERRORS.BAD_PASSPHRASE : CERT_ERRORS.INVALID_KEY;
    const message = encrypted ? 'The passphrase did not decrypt the private key.' : 'The private key could not be parsed.';
    void err; // never surface the raw OpenSSL error (may echo key context)
    return { ok: false, code, message };
  }

  let matches = false;
  try {
    const cert = new X509Certificate(certPem);
    // checkPrivateKey is the authoritative pairing test; fall back to comparing
    // exported public keys if an older runtime lacks it.
    matches = typeof cert.checkPrivateKey === 'function'
      ? cert.checkPrivateKey(keyObj)
      : createPublicKey(keyObj).export({ type: 'spki', format: 'der' }).equals(cert.publicKey.export({ type: 'spki', format: 'der' }));
  } catch { matches = false; }
  if (!matches) {
    return { ok: false, code: CERT_ERRORS.KEY_CERT_MISMATCH, message: 'The private key does not match the certificate.' };
  }

  let normalizedKeyPem;
  try {
    normalizedKeyPem = keyObj.export({ type: 'pkcs8', format: 'pem' }).toString();
  } catch {
    return { ok: false, code: CERT_ERRORS.INVALID_KEY, message: 'The private key could not be normalized.' };
  }
  return { ok: true, parsed, normalizedKeyPem };
}

// Assemble the chain Caddy serves: leaf first, then any intermediates, each as a
// clean PEM block separated by a single newline. Returns { ok, chainPem } or
// { ok:false } when the chain blob is present but not PEM.
export function assembleServedChain(leafPem, chainPem = null) {
  const leaf = String(leafPem || '').trim();
  if (!chainPem || !String(chainPem).trim()) return { ok: true, chainPem: `${leaf}\n` };
  const blocks = String(chainPem).match(PEM_BLOCK_RE);
  if (!blocks || !blocks.length) return { ok: false, code: CERT_ERRORS.INVALID_CHAIN, message: 'The chain is not valid PEM.' };
  return { ok: true, chainPem: `${leaf}\n${blocks.map((b) => b.trim()).join('\n')}\n` };
}

// ---- hostname coverage + resolver (most-specific wins) ----

// Normalize a hostname for matching: lower-case, strip a trailing dot and any
// :port. IP literals and empty strings return '' (never matched).
export function normalizeHost(host) {
  let h = String(host || '').trim().toLowerCase();
  h = h.replace(/\.$/, '').replace(/:\d+$/, '');
  return h;
}

// Score how well one covered name matches a host: exact = 100 (most specific),
// single-label wildcard = 50, no match = 0. A wildcard `*.example.com` covers
// exactly one extra non-empty label (foo.example.com) — never the apex and
// never a deeper label (a.b.example.com). Apex coverage requires the apex to be
// an explicit SAN (an exact match).
export function matchScore(coveredName, host) {
  const name = normalizeHost(coveredName);
  const h = normalizeHost(host);
  if (!name || !h) return 0;
  if (name === h) return 100;
  if (name.startsWith('*.')) {
    const base = name.slice(2);
    if (!h.endsWith(`.${base}`)) return 0;
    const label = h.slice(0, h.length - base.length - 1);
    if (label.length && !label.includes('.')) return 50;
  }
  return 0;
}

// Does any of a cert's covered names cover this host?
export function certCoversHost(coveredNames, host) {
  return (coveredNames || []).some((n) => matchScore(n, host) > 0);
}

// The best score a cert (its coveredNames array) achieves for a host, 0 if none.
export function bestScoreForCert(coveredNames, host) {
  let best = 0;
  for (const n of coveredNames || []) best = Math.max(best, matchScore(n, host));
  return best;
}

// resolveCertForHost — pick the managed cert that should serve `host`, or null.
// certs: [{ id, coveredNames:[], notAfter?, ... }]. Most-specific wins (exact
// beats wildcard). Deterministic tie-break: later notAfter (the fresher cert),
// then higher id — so overlapping certs always resolve the same way.
export function resolveCertForHost(certs, host) {
  let winner = null;
  let winnerScore = 0;
  for (const c of certs || []) {
    const score = bestScoreForCert(c.coveredNames, host);
    if (score === 0) continue;
    if (score > winnerScore) { winner = c; winnerScore = score; continue; }
    if (score === winnerScore && winner) {
      const a = Date.parse(c.notAfter || 0) || 0;
      const b = Date.parse(winner.notAfter || 0) || 0;
      if (a > b || (a === b && Number(c.id) > Number(winner.id))) winner = c;
    }
  }
  return winner;
}

// ---- Caddyfile directive ----

// The per-site TLS directive that serves a manual cert AND disables ACME for
// that site. Emitted by every builder for a covered host. Indent matches the
// builder's block body.
export function manualTlsDirective(certFile, keyFile, indent = '    ') {
  return `${indent}tls ${certFile} ${keyFile}`;
}

// ---- expiry ----

export const DEFAULT_EXPIRY_WARN_DAYS = 21;
export const MS_PER_DAY = 86400000;

// Classify a cert by its not_after: 'expired' | 'expiring' | 'valid'. Pure over
// an ISO string + a millisecond clock so it is testable without a real cert.
export function expiryStatus(notAfterIso, nowMs = null, warnDays = DEFAULT_EXPIRY_WARN_DAYS) {
  const end = Date.parse(notAfterIso);
  if (!Number.isFinite(end)) return 'unknown';
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  if (end <= now) return 'expired';
  if (end - now <= warnDays * MS_PER_DAY) return 'expiring';
  return 'valid';
}

// Whole days until expiry (negative if already expired), for the UI badge/body.
export function daysUntil(notAfterIso, nowMs = null) {
  const end = Date.parse(notAfterIso);
  if (!Number.isFinite(end)) return null;
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  return Math.floor((end - now) / MS_PER_DAY);
}
