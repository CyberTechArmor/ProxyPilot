// Manual TLS certificate STORE — the DB + filesystem + encryption side of the
// pasted-cert feature. Pairs with the pure lib/tls-certs.js (parsing/matching)
// and is consumed by routes/tls-certs.js and the three Caddy site builders.
//
// Security (cid-security):
//   * The private key is stored ENCRYPTED at rest (key_pem_enc, AES-256-GCM via
//     lib/secrets) and decrypted only server-side at apply time.
//   * On disk the key is written to a DEDICATED dir (default
//     /etc/caddy/pp-manual-certs) with 0600 perms owned by the caddy user, over
//     stdin so it never appears in argv/logs; the public cert/chain is 0644.
//   * File paths are derived from the integer row id only — no caller-supplied
//     path ever reaches the filesystem, so there is no traversal surface.
//   * getCert()/listCerts() return METADATA ONLY (never the key).

import { getDb, getSetting, getAdminDomain } from '../db.js';
import { encryptSecret, decryptSecret } from './secrets.js';
import { spawnHostSync } from './host-exec.js';
import {
  parseCertificate, assembleServedChain, resolveCertForHost, expiryStatus, daysUntil,
} from './tls-certs.js';

// The dedicated cert directory (outside any web-served path). Override for tests
// / non-standard installs; the default sits alongside the DNS-01 pp-secrets dir.
export const MANUAL_CERT_DIR = process.env.CADDY_MANUAL_CERT_DIR || '/etc/caddy/pp-manual-certs';

// File paths for a cert row — id is an integer PK, so these are injection- and
// traversal-safe by construction.
export function certFilePaths(id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) throw new Error('invalid cert id');
  return { certFile: `${MANUAL_CERT_DIR}/cert-${n}.pem`, keyFile: `${MANUAL_CERT_DIR}/cert-${n}.key` };
}

// Write the served chain (public, 0644) and the decrypted key (0600 caddy) to
// the host, both over stdin. Dir is 0750 root:caddy so only Caddy can list it.
export function materializeCertFiles(id, servedChainPem, keyPem) {
  const { certFile, keyFile } = certFilePaths(id);
  const prep = `umask 077; mkdir -p ${MANUAL_CERT_DIR}; chmod 750 ${MANUAL_CERT_DIR}; chown root:caddy ${MANUAL_CERT_DIR} 2>/dev/null || true`;
  const p = spawnHostSync('sh', ['-c', prep], { encoding: 'utf8', timeout: 10000 });
  if (p.error || p.status !== 0) throw new Error(`could not prepare the cert directory: ${String(p.stderr || p.error?.message || '').slice(0, 200)}`);
  // Public cert/chain — 0644, readable by Caddy.
  const cw = spawnHostSync('sh', ['-c', `cat > '${certFile}'; chmod 644 '${certFile}'; chown root:caddy '${certFile}' 2>/dev/null || true`], { input: servedChainPem, encoding: 'utf8', timeout: 10000 });
  if (cw.error || cw.status !== 0) throw new Error('could not write the certificate file');
  // Private key — 0600, owned by caddy so nothing else can read it.
  const kw = spawnHostSync('sh', ['-c', `cat > '${keyFile}'; chmod 600 '${keyFile}'; chown caddy:caddy '${keyFile}' 2>/dev/null || true`], { input: keyPem, encoding: 'utf8', timeout: 10000 });
  if (kw.error || kw.status !== 0) throw new Error('could not write the private key file');
  return { certFile, keyFile };
}

export function removeCertFiles(id) {
  try {
    const { certFile, keyFile } = certFilePaths(id);
    spawnHostSync('sh', ['-c', `rm -f '${certFile}' '${keyFile}'`], { encoding: 'utf8', timeout: 10000 });
  } catch { /* best effort */ }
}

// ---- DB CRUD (key always encrypted on the way in, never returned raw) ----

export function insertCert({ label, certPem, chainPem = null, normalizedKeyPem, parsed, createdBy = null }) {
  const db = getDb();
  const info = db.prepare(`
    INSERT INTO tls_certificates (label, cert_pem, chain_pem, key_pem_enc, covered_names, fingerprint, not_before, not_after, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    String(label), String(certPem), chainPem ? String(chainPem) : null,
    encryptSecret(normalizedKeyPem), JSON.stringify(parsed.coveredNames || []),
    parsed.fingerprint256, parsed.notBefore, parsed.notAfter, createdBy,
  );
  return Number(info.lastInsertRowid);
}

export function updateCert(id, { label, certPem, chainPem, normalizedKeyPem, parsed }) {
  const db = getDb();
  db.prepare(`
    UPDATE tls_certificates
    SET label = ?, cert_pem = ?, chain_pem = ?, key_pem_enc = ?, covered_names = ?, fingerprint = ?, not_before = ?, not_after = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    String(label), String(certPem), chainPem ? String(chainPem) : null,
    encryptSecret(normalizedKeyPem), JSON.stringify(parsed.coveredNames || []),
    parsed.fingerprint256, parsed.notBefore, parsed.notAfter, Number(id),
  );
}

export function deleteCertRow(id) {
  getDb().prepare('DELETE FROM tls_certificates WHERE id = ?').run(Number(id));
}

export function getCertRow(id) {
  return getDb().prepare('SELECT * FROM tls_certificates WHERE id = ?').get(Number(id)) || null;
}

export function listCertRows() {
  return getDb().prepare('SELECT * FROM tls_certificates ORDER BY id').all();
}

// The decrypted key PEM — server-side apply path ONLY (materializeCertFiles).
export function getCertKeyPem(id) {
  const row = getCertRow(id);
  return row ? decryptSecret(row.key_pem_enc) : null;
}

// Parse a stored covered_names JSON column safely.
function coveredNamesOf(row) {
  try { const a = JSON.parse(row.covered_names || '[]'); return Array.isArray(a) ? a : []; }
  catch { return []; }
}

// ---- public metadata shape (NEVER the key) ----

export function certPublicShape(row, { nowMs = null } = {}) {
  if (!row) return null;
  return {
    id: row.id,
    label: row.label,
    covered_names: coveredNamesOf(row),
    fingerprint: row.fingerprint,
    not_before: row.not_before,
    not_after: row.not_after,
    status: expiryStatus(row.not_after, nowMs),
    days_until_expiry: daysUntil(row.not_after, nowMs),
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
    // Public PEM is allowed in the detail view; the key never is.
    cert_pem: row.cert_pem,
    chain_pem: row.chain_pem || null,
  };
}

// ---- the DB-backed resolver (host → serving decision) ----

// Lightweight rows for the pure resolver.
export function certsForResolver() {
  return listCertRows().map((r) => ({ id: r.id, coveredNames: coveredNamesOf(r), notAfter: r.not_after }));
}

// resolveTlsForHost — the single decision every Caddy site builder consults.
//   { mode:'manual', certFile, keyFile, certId }  a pasted cert covers the host
//   { mode:'internal' }                            global manual mode, host NOT
//                                                  covered → self-signed, never ACME
//   null                                           global acme mode, uncovered →
//                                                  the builder's existing behavior
// `globalMode` defaults to the stored app_settings tls_mode (via getSetting),
// but callers may pass it to avoid a repeat lookup in a batch reload.
export function resolveTlsForHost(host, { globalMode = null, certs = null } = {}) {
  const pool = certs || certsForResolver();
  const hit = resolveCertForHost(pool, host);
  if (hit) {
    const { certFile, keyFile } = certFilePaths(hit.id);
    return { mode: 'manual', certFile, keyFile, certId: hit.id };
  }
  const mode = globalMode || currentTlsMode();
  if (mode === 'manual') return { mode: 'internal' };
  return null;
}

// The admin dashboard's own site file is owned by install.sh, not the service
// reconciler (the backend deliberately SKIPS the admin domain when regenerating
// service configs). In manual-TLS mode install.sh has that site `import` this
// snippet instead of hardcoding `tls internal`, so the backend can flip the
// admin ORIGIN onto a pasted/seeded cert once one covers the admin domain.
//
// Why this matters for the Cloudflare-proxy case: with the domain proxied
// through Cloudflare, "Full (strict)" origin pulls require the origin to present
// a cert Cloudflare trusts (a Cloudflare Origin CA cert). `tls internal` only
// satisfies "Full" (non-strict). Serving the Origin cert here is what makes
// Full-strict work end to end.
export const ADMIN_TLS_SNIPPET = process.env.CADDY_ADMIN_TLS_SNIPPET || '/etc/caddy/pp-admin-tls.caddy';

// reconcileAdminTls — rewrite the admin TLS snippet to match the current cert
// set. No-op unless the snippet file already exists (i.e. a manual-mode install
// wired the `import`); on an ACME install or a legacy inline `tls internal`
// admin site there is nothing to import, so we never create an orphan file.
// Returns { changed, directive } (directive null when skipped). Never throws.
export function reconcileAdminTls({ adminDomain = null } = {}) {
  try {
    const exists = spawnHostSync('sh', ['-c', `test -f '${ADMIN_TLS_SNIPPET}'`], { encoding: 'utf8', timeout: 5000 });
    if (exists.status !== 0) return { changed: false, directive: null, reason: 'no snippet' };

    const host = adminDomain || getAdminDomain();
    let directive = '    tls internal\n';
    if (host) {
      const decision = resolveTlsForHost(host);
      if (decision && decision.mode === 'manual' && decision.certFile && decision.keyFile) {
        directive = `    tls ${decision.certFile} ${decision.keyFile}\n`;
      }
    }

    const cur = spawnHostSync('sh', ['-c', `cat '${ADMIN_TLS_SNIPPET}' 2>/dev/null || true`], { encoding: 'utf8', timeout: 5000 });
    if ((cur.stdout || '') === directive) return { changed: false, directive };

    const w = spawnHostSync('sh', ['-c', `cat > '${ADMIN_TLS_SNIPPET}'; chmod 644 '${ADMIN_TLS_SNIPPET}'; chown root:caddy '${ADMIN_TLS_SNIPPET}' 2>/dev/null || true`], { input: directive, encoding: 'utf8', timeout: 8000 });
    if (w.error || w.status !== 0) throw new Error('could not write the admin TLS snippet');
    return { changed: true, directive };
  } catch (e) {
    console.warn('[tls] admin TLS snippet reconcile failed:', e?.message);
    return { changed: false, directive: null, reason: 'error' };
  }
}

// The stored global TLS mode ('acme' | 'manual'); defaults to 'acme'.
export function currentTlsMode() {
  const v = String(getSetting('tls_mode') || '').trim().toLowerCase();
  return v === 'manual' ? 'manual' : 'acme';
}

// Reparse a stored cert row's PEM (used when re-materializing files on boot).
export function parseStoredCert(row) {
  return row ? parseCertificate(row.cert_pem) : null;
}

// Build the served chain for a row from its stored cert + chain PEM.
export function servedChainForRow(row) {
  const r = assembleServedChain(row.cert_pem, row.chain_pem);
  return r.ok ? r.chainPem : `${String(row.cert_pem).trim()}\n`;
}
