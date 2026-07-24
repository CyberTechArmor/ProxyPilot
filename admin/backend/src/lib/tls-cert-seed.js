// Install-time TLS certificate seeder.
//
// When an operator chooses MANUAL TLS at install and provides a certificate
// (e.g. a Cloudflare Origin CA cert, or any PEM cert+key), install.sh stages it
// into the mounted data dir (default /data/seed-tls). On first boot the backend
// validates it and seeds it into the SAME store the TLS Certificates admin page
// manages (tls_certificates) — so it appears there, is served by Caddy for the
// domains it covers, and is never a separate/parallel mechanism.
//
// Security (cid-security): the staged private key is read once, stored ENCRYPTED
// via the normal cert store, then the staging files are DELETED so no plaintext
// key lingers on disk. Idempotent: a cert whose fingerprint is already present
// is skipped (safe to re-run install.sh).

import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { setSetting, logAudit } from '../db.js';
import { validateCertKeyPair, assembleServedChain, redactKeyMaterial } from './tls-certs.js';
import { insertCert, materializeCertFiles, listCertRows } from './tls-cert-store.js';

export const SEED_DIR = process.env.PROXYPILOT_SEED_TLS_DIR || '/data/seed-tls';

function cleanup(dir) {
  for (const f of ['cert.pem', 'key.pem', 'chain.pem', 'meta.json']) {
    try { unlinkSync(join(dir, f)); } catch { /* already gone */ }
  }
}

// seedTlsCertFromInstall — run once on boot. Reads the staged cert (if any),
// validates + seeds it, applies Caddy, then removes the staging files. Never
// throws (a bad seed must not stop the server from starting).
export async function seedTlsCertFromInstall({ dir = SEED_DIR } = {}) {
  try {
    const certPath = join(dir, 'cert.pem');
    const keyPath = join(dir, 'key.pem');
    if (!existsSync(certPath) || !existsSync(keyPath)) return { seeded: false, reason: 'nothing staged' };

    const certPem = readFileSync(certPath, 'utf8');
    const keyPem = readFileSync(keyPath, 'utf8');
    const chainPem = existsSync(join(dir, 'chain.pem')) ? readFileSync(join(dir, 'chain.pem'), 'utf8') : null;
    let meta = {};
    try { meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')); } catch { /* optional */ }
    const passphrase = meta.passphrase || process.env.PROXYPILOT_SEED_TLS_PASSPHRASE || null;
    const label = String(meta.label || 'Imported at install').slice(0, 120);

    const v = validateCertKeyPair(certPem, keyPem, passphrase);
    if (!v.ok) {
      console.error(`[tls-seed] staged certificate rejected (${v.code}): ${v.message} — removing staged files.`);
      cleanup(dir); // don't loop on a bad paste; operator can re-add via the UI
      return { seeded: false, reason: v.code };
    }

    // Idempotent: skip if this exact cert is already stored.
    if (listCertRows().some((r) => r.fingerprint === v.parsed.fingerprint256)) {
      cleanup(dir);
      return { seeded: false, reason: 'already present' };
    }

    const assembled = assembleServedChain(certPem, chainPem);
    const id = insertCert({ label, certPem, chainPem, normalizedKeyPem: v.normalizedKeyPem, parsed: v.parsed, createdBy: null });
    materializeCertFiles(id, assembled.ok ? assembled.chainPem : `${certPem.trim()}\n`, v.normalizedKeyPem);
    setSetting('tls_mode', 'manual');

    // Apply through the SAME pipeline the API uses, so covered hosts (e.g. the
    // admin domain, if the cert covers it) start serving the pasted cert.
    try {
      const { applyManagedTls } = await import('../routes/tls-certs.js');
      const applied = await applyManagedTls();
      if (!applied.ok) console.warn(`[tls-seed] cert stored but Caddy apply reported: ${applied.error}`);
    } catch (e) { console.warn('[tls-seed] Caddy apply skipped:', e?.message); }

    logAudit(null, 'TLS_CERT_SEEDED', 'tls_certificate', String(id), { label, covered_names: v.parsed.coveredNames, fingerprint: v.parsed.fingerprint256, source: 'install' }, null);
    console.log(`[tls-seed] seeded pasted certificate #${id} "${label}" covering: ${v.parsed.coveredNames.join(', ') || '(none)'} — now on the TLS Certificates page.`);
    cleanup(dir);
    return { seeded: true, id, coveredNames: v.parsed.coveredNames };
  } catch (err) {
    console.error('[tls-seed] seeding failed:', redactKeyMaterial(err?.message || String(err)));
    return { seeded: false, reason: 'error' };
  }
}
