// Self-service domain provisioning — the "Add Domain" page's API.
//
// Auth model (two credentials, never conflated):
//   * Provisioning endpoints (/provision/*) authenticate with a ProxyPilot
//     access API key in X-API-Key — an application-level credential admins
//     mint on the Domain Provisioning page. No cookies are involved, so
//     these endpoints ride the CSRF exempt list (same rationale as the
//     mock2 git endpoints: the key header IS the binding token).
//   * Admin endpoints (/admin/*) use the normal cookie session
//     (authenticateToken + requireAdmin, sudo for mutations) and keep
//     full CSRF protection.
//   * The Cloudflare API token (DNS-01 only) is a third thing entirely:
//     a Caddy-facing credential, encrypted at rest, never logged, never
//     returned to any client.
//
// Caddy integration follows the repo architecture: a generated site file
// in /etc/caddy/sites (validated with `caddy adapt`, applied with the
// graceful `caddy reload` through lib/caddy-driver.js). For DNS-01 the
// token is materialized to /etc/caddy/pp-secrets/<domain>.token on the
// HOST (0640 root:caddy, written over stdin so it never appears in argv
// or logs) and referenced from the site block via a {file.…} placeholder
// — never inline in the Caddyfile. The file persists, so Caddy can renew
// months later without ProxyPilot's involvement; renewals for both
// methods are Caddy's built-in behavior, no cron here.

import { Router } from 'express';
import { z } from 'zod';
import { writeFile, unlink, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { getDb, logAudit, getSetting, setSetting } from '../db.js';
import { authenticateToken, requireAdmin, requireSudo } from '../middleware/auth.js';
import { encryptSecret } from '../lib/secrets.js';
import { caddyAdapt, caddyReload } from '../lib/caddy-driver.js';
import { resolveCertDir } from '../lib/caddy-cert.js';
import { spawnHostSync } from '../lib/host-exec.js';
import {
  validateProvisionInput, resolveCertMethod, parseDns01List,
  buildSiteBlock, provisionFileName, tokenFilePath, PP_SECRETS_DIR,
  generateApiKey, hashApiKey, PROVISION_SCOPE, publicDomainShape,
  classifyAcmeError,
} from '../lib/domain-provision-logic.js';

const CADDY_SITES_DIR = process.env.CADDY_SITES_DIR || '/etc/caddy/sites';

export const domainsRouter = Router();
const router = domainsRouter;

// ---- helpers ----

function globalCfToken() {
  const t = String(process.env.CLOUDFLARE_API_TOKEN || '').trim();
  return t || null;
}

function dns01List() {
  return parseDns01List(getSetting('dns01_domains') || '[]');
}

// Is Caddy built with the cloudflare DNS provider? Stock Caddy is not —
// `caddy add-package github.com/caddy-dns/cloudflare` adds it. Returns
// true/false, or null when the check itself failed (fail open: `caddy
// adapt` still catches a missing module with its own error).
function cloudflarePluginPresent() {
  try {
    const r = spawnHostSync('caddy', ['list-modules'], { encoding: 'utf8', timeout: 15000 });
    if (r.error || r.status !== 0) return null;
    return /dns\.providers\.cloudflare/.test(String(r.stdout || ''));
  } catch {
    return null;
  }
}

const PLUGIN_HINT = 'Caddy on this server is not built with the Cloudflare DNS provider. Run `caddy add-package github.com/caddy-dns/cloudflare` on the host (then retry) to enable DNS-01 issuance.';

// Write the Cloudflare token to the host-side secrets file. The token
// travels over stdin — it must never appear in a command line, the
// process list, or any log. Directory 0750 root:caddy, file 0640
// root:caddy (Caddy reads it via the {file.…} placeholder at config load
// and at every renewal).
function writeTokenFileHost(path, token) {
  const script = `umask 027; mkdir -p ${PP_SECRETS_DIR}; chmod 750 ${PP_SECRETS_DIR}; chown root:caddy ${PP_SECRETS_DIR} 2>/dev/null || true; cat > '${path}'; chmod 640 '${path}'; chown root:caddy '${path}' 2>/dev/null || true`;
  const r = spawnHostSync('sh', ['-c', script], { input: token, encoding: 'utf8', timeout: 10000 });
  if (r.error || r.status !== 0) {
    throw new Error(`could not write the DNS credential file: ${String(r.stderr || r.error?.message || 'unknown error').slice(0, 200)}`);
  }
}

function removeTokenFileHost(path) {
  try { spawnHostSync('sh', ['-c', `rm -f '${path}'`], { encoding: 'utf8', timeout: 10000 }); } catch { /* best effort */ }
}

function siteFilePath(domain) {
  return `${CADDY_SITES_DIR}/${provisionFileName(domain)}`;
}

// A domain already handled anywhere else on this server is a 409 — this
// page must never silently fight the Services surface or an earlier
// provision. Fail-open on missing tables (fresh installs mid-migration).
function findDomainConflict(domain) {
  const db = getDb();
  const existing = db.prepare(`SELECT id FROM provisioned_domains WHERE domain = ?`).get(domain);
  if (existing) return 'This domain is already provisioned here. Remove it first (Domain Provisioning → Provisioned domains) to re-provision.';
  try {
    const svc = db.prepare(`SELECT 1 FROM service_http_routes WHERE domain = ? OR domain = ? LIMIT 1`).get(domain, `*.${domain}`);
    if (svc) return 'This domain is managed in Service Settings. Edit it there instead.';
  } catch { /* table may not exist on old snapshots */ }
  try {
    const legacy = db.prepare(`SELECT 1 FROM services WHERE domain = ? LIMIT 1`).get(domain);
    if (legacy) return 'This domain is managed in Service Settings. Edit it there instead.';
  } catch { /* legacy column may be gone */ }
  if (existsSync(`${CADDY_SITES_DIR}/${domain.replace(/\*/g, '_wildcard_')}`)) {
    return 'A Caddy site file for this domain already exists on the server.';
  }
  return null;
}

// ---- access API key middleware (provisioning endpoints) ----

function requireProvisionKey(req, res, next) {
  const raw = String(req.headers['x-api-key'] || '').trim();
  if (!raw) {
    return res.status(401).json({ error: 'Missing API key. Send your ProxyPilot access API key in the X-API-Key header.' });
  }
  const row = getDb()
    .prepare(`SELECT * FROM provision_api_keys WHERE key_hash = ? AND revoked_at IS NULL`)
    .get(hashApiKey(raw));
  if (!row || !String(row.scope || '').split(',').includes(PROVISION_SCOPE)) {
    return res.status(401).json({ error: 'Invalid or revoked API key.' });
  }
  getDb().prepare(`UPDATE provision_api_keys SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?`).run(row.id);
  req.provisionKey = row;
  next();
}

// requireProvisionAccess — dual auth for the provisioning endpoints.
// The /add-domain page is ADMIN-GATED: browser requests ride the normal
// cookie session (admin role required; CSRF enforced by the global
// middleware, whose exemption applies only when X-API-Key is present).
// Scripted/API clients authenticate with a provisioning API key instead.
function requireProvisionAccess(req, res, next) {
  if (String(req.headers['x-api-key'] || '').trim()) {
    return requireProvisionKey(req, res, next);
  }
  return authenticateToken(req, res, () => requireAdmin(req, res, next));
}

// ---- provisioning endpoints (admin session OR X-API-Key) ----

// Access probe. Returns non-secret context the form needs: whether a
// global Cloudflare token exists (so the CF field's helper text is
// accurate) — never the token itself.
router.post('/provision/verify-key', requireProvisionAccess, (req, res) => {
  res.json({ ok: true, keyName: req.provisionKey?.name || null, globalTokenAvailable: !!globalCfToken() });
});

// Live method-resolution preview: the form calls this as the user types so
// the resolved method (and any blocking problem) is visible BEFORE submit.
router.post('/provision/resolve', requireProvisionAccess, (req, res) => {
  const v = validateProvisionInput(req.body || {});
  if (!v.ok) return res.status(400).json({ errors: v.errors });
  const { domain, method, wildcard, cfToken } = v.value;
  const resolved = resolveCertMethod({
    domain, method, wildcard,
    dns01List: dns01List(),
    hasDomainToken: !!cfToken,
    hasGlobalToken: !!globalCfToken(),
  });
  if (resolved.error) {
    // method/needsToken ride along so the form can keep the Cloudflare
    // token field visible — entering a token IS the fix for these errors.
    return res.json({ ok: false, error: resolved.error, method: resolved.method || null, needsToken: !!resolved.needsToken });
  }
  res.json({ ok: true, method: resolved.method, reason: resolved.reason, globalTokenAvailable: !!globalCfToken() });
});

const provisionSchema = z.object({
  domain: z.string().min(1),
  upstream: z.string().min(1),
  method: z.enum(['auto', 'http01', 'dns01']).default('auto'),
  wildcard: z.boolean().default(false),
  acmeEmail: z.string().min(3),
  cfToken: z.string().optional().default(''),
});

router.post('/provision', requireProvisionAccess, async (req, res) => {
  const parsed = provisionSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: 'Invalid request body.', errors: parsed.error.issues.map((i) => i.message) });
  const v = validateProvisionInput(parsed.data);
  if (!v.ok) return res.status(400).json({ error: v.errors[0], errors: v.errors });
  const { domain, upstream, method, wildcard, acmeEmail, cfToken } = v.value;

  // 1) Resolve the certificate method (wildcard > explicit > list > default).
  const resolved = resolveCertMethod({
    domain, method, wildcard,
    dns01List: dns01List(),
    hasDomainToken: !!cfToken,
    hasGlobalToken: !!globalCfToken(),
  });
  if (resolved.error) return res.status(400).json({ error: resolved.error });

  // 2) Duplicate / cross-surface conflicts before any side effect.
  const conflict = findDomainConflict(domain);
  if (conflict) return res.status(409).json({ error: conflict });

  // 3) DNS-01 prerequisites: effective token + the Caddy plugin.
  let effectiveToken = null;
  let tokenSource = null;
  if (resolved.method === 'dns01') {
    effectiveToken = cfToken || globalCfToken();
    tokenSource = cfToken ? 'domain' : 'global';
    if (!effectiveToken) return res.status(400).json({ error: 'The DNS-01 method needs a Cloudflare API token, and none is available.' });
    if (cloudflarePluginPresent() === false) return res.status(412).json({ error: PLUGIN_HINT });
  }

  // 4) Provision, rolling back EVERY side effect on any failure — a failed
  //    submit must leave no site file, no token file, and no DB row.
  const db = getDb();
  const sitePath = siteFilePath(domain);
  const tokenPath = resolved.method === 'dns01' ? tokenFilePath(domain) : null;
  let recordId = null;
  let siteWritten = false;
  let tokenWritten = false;
  const rollback = async () => {
    if (siteWritten) await unlink(sitePath).catch(() => undefined);
    if (tokenWritten && tokenPath) removeTokenFileHost(tokenPath);
    if (recordId) { try { db.prepare(`DELETE FROM provisioned_domains WHERE id = ?`).run(recordId); } catch { /* leave for admin cleanup */ } }
  };

  try {
    const info = db.prepare(`
      INSERT INTO provisioned_domains
        (domain, upstream, method_requested, method_resolved, wildcard, acme_email, cf_token_encrypted, cf_token_source, status, api_key_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    `).run(
      domain, upstream, method, resolved.method, wildcard ? 1 : 0, acmeEmail,
      // DNS-01 only: encrypted at rest so the token can be re-materialized
      // (restore, host rebuild). HTTP-01 domains store no token at all.
      effectiveToken ? encryptSecret(effectiveToken) : null,
      tokenSource, req.provisionKey?.id ?? null,
    );
    recordId = info.lastInsertRowid;

    if (tokenPath) {
      writeTokenFileHost(tokenPath, effectiveToken);
      tokenWritten = true;
    }

    await mkdir(CADDY_SITES_DIR, { recursive: true }).catch(() => undefined);
    await writeFile(sitePath, buildSiteBlock({ domain, upstream, acmeEmail, method: resolved.method, wildcard }));
    siteWritten = true;

    // Validate the merged config before touching the running Caddy.
    try {
      await caddyAdapt();
    } catch (e) {
      await rollback();
      const detail = String(e.stderr || e.message || '').slice(0, 400);
      const pluginMiss = /cloudflare|unrecognized|unknown module/i.test(detail) && resolved.method === 'dns01';
      return res.status(422).json({ error: pluginMiss ? PLUGIN_HINT : `Caddy rejected the generated config: ${detail}` });
    }

    try {
      await caddyReload();
    } catch (e) {
      await rollback();
      return res.status(502).json({ error: `Caddy reload failed — nothing was applied: ${String(e.stderr || e.message || '').slice(0, 400)}` });
    }

    logAudit(req.user?.id ?? null, 'DOMAIN_PROVISIONED', 'domain', String(recordId), {
      domain, upstream, method: resolved.method, wildcard,
      via: req.provisionKey ? `api-key:${req.provisionKey.name}` : 'admin-session',
    }, req.ip);

    res.json({
      ok: true,
      domain,
      method: resolved.method,
      methodReason: resolved.reason,
      wildcard,
      status: 'pending',
      message: resolved.method === 'dns01'
        ? 'Site loaded. Caddy is completing the DNS-01 challenge via Cloudflare — this usually takes under two minutes.'
        : "Site loaded. Caddy is completing the Let's Encrypt HTTP challenge — this usually takes under a minute.",
    });
  } catch (e) {
    await rollback();
    console.error('[domains] provision failed:', e?.message); // token never logged
    res.status(500).json({ error: `Provisioning failed and was rolled back: ${String(e?.message || 'unknown error').slice(0, 300)}` });
  }
});

// Issuance status: certificate present on disk → issued; otherwise scan
// recent Caddy logs for a classified ACME failure so the user gets an
// actionable reason instead of an endless spinner. Caddy keeps retrying
// with backoff, so "failed" here is a diagnosis, not a terminal state.
router.get('/provision/:domain/status', requireProvisionAccess, (req, res) => {
  const domain = String(req.params.domain || '').trim().toLowerCase();
  const row = getDb().prepare(`SELECT * FROM provisioned_domains WHERE domain = ?`).get(domain);
  if (!row) return res.status(404).json({ error: 'Domain not found.' });

  const apex = resolveCertDir(domain);
  const wild = row.wildcard ? resolveCertDir(`wildcard_.${domain}`) : null;
  const issued = !!apex && (!row.wildcard || !!wild);
  if (issued) {
    if (row.status !== 'issued') {
      getDb().prepare(`UPDATE provisioned_domains SET status = 'issued', last_error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(row.id);
    }
    return res.json({ status: 'issued', method: row.method_resolved, wildcard: !!row.wildcard, issuer: apex.issuer });
  }

  // Pending: after a grace period, look for the failure in Caddy's journal.
  const ageMs = Date.now() - new Date(`${row.created_at}Z`).getTime();
  let diagnosis = null;
  if (ageMs > 45000) {
    try {
      const r = spawnHostSync('sh', ['-c',
        `journalctl -u caddy --since '-30 min' --no-pager 2>/dev/null | grep -F '${domain}' | grep -iE 'error|fail' | tail -5`,
      ], { encoding: 'utf8', timeout: 10000 });
      const lines = String(r.stdout || '').trim().split('\n').filter(Boolean);
      for (const line of lines.reverse()) {
        const c = classifyAcmeError(line);
        if (c) { diagnosis = { ...c, detail: line.slice(0, 300) }; break; }
      }
    } catch { /* status stays pending */ }
  }
  if (diagnosis) {
    getDb().prepare(`UPDATE provisioned_domains SET status = 'failed', last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(`${diagnosis.code}: ${diagnosis.hint}`, row.id);
    return res.json({ status: 'failed', method: row.method_resolved, wildcard: !!row.wildcard, error: diagnosis.hint, detail: diagnosis.detail, code: diagnosis.code });
  }
  res.json({ status: 'pending', method: row.method_resolved, wildcard: !!row.wildcard });
});

// ---- admin endpoints (cookie session + admin; mutations need sudo) ----

router.get('/admin/status', authenticateToken, requireAdmin, (req, res) => {
  res.json({
    globalTokenAvailable: !!globalCfToken(),
    cloudflarePlugin: cloudflarePluginPresent(), // true | false | null (unknown)
  });
});

router.get('/admin/keys', authenticateToken, requireAdmin, (req, res) => {
  const rows = getDb().prepare(`SELECT id, name, scope, created_at, last_used_at, revoked_at FROM provision_api_keys ORDER BY created_at DESC`).all();
  res.json({ keys: rows });
});

router.post('/admin/keys', authenticateToken, requireAdmin, requireSudo, (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 60);
  if (!name) return res.status(400).json({ error: 'Give the key a name (who or what will use it).' });
  const raw = generateApiKey();
  const info = getDb().prepare(`INSERT INTO provision_api_keys (name, key_hash, scope, created_by) VALUES (?, ?, ?, ?)`)
    .run(name, hashApiKey(raw), PROVISION_SCOPE, req.user.id);
  logAudit(req.user.id, 'PROVISION_KEY_CREATED', 'provision_api_key', String(info.lastInsertRowid), { name }, req.ip);
  // The raw key is returned exactly ONCE — only its hash is stored.
  res.json({ id: info.lastInsertRowid, name, key: raw });
});

router.post('/admin/keys/:id/revoke', authenticateToken, requireAdmin, requireSudo, (req, res) => {
  const info = getDb().prepare(`UPDATE provision_api_keys SET revoked_at = CURRENT_TIMESTAMP WHERE id = ? AND revoked_at IS NULL`).run(Number(req.params.id));
  if (!info.changes) return res.status(404).json({ error: 'Key not found or already revoked.' });
  logAudit(req.user.id, 'PROVISION_KEY_REVOKED', 'provision_api_key', String(req.params.id), {}, req.ip);
  res.json({ ok: true });
});

router.get('/admin/dns01-list', authenticateToken, requireAdmin, (req, res) => {
  res.json({ list: dns01List() });
});

router.put('/admin/dns01-list', authenticateToken, requireAdmin, requireSudo, (req, res) => {
  const list = parseDns01List(req.body?.list);
  setSetting('dns01_domains', JSON.stringify(list));
  logAudit(req.user.id, 'DNS01_LIST_UPDATED', 'app_settings', 'dns01_domains', { count: list.length }, req.ip);
  res.json({ list });
});

router.get('/admin/domains', authenticateToken, requireAdmin, (req, res) => {
  const rows = getDb().prepare(`SELECT * FROM provisioned_domains ORDER BY created_at DESC`).all();
  res.json({ domains: rows.map(publicDomainShape) });
});

// Deprovision: remove the site file + token file + record, then reload.
// The issued certificate stays in Caddy's data dir (harmless; re-adding
// the domain reuses it instead of burning a rate-limited re-issue).
router.delete('/admin/domains/:id', authenticateToken, requireAdmin, requireSudo, async (req, res) => {
  const row = getDb().prepare(`SELECT * FROM provisioned_domains WHERE id = ?`).get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Domain not found.' });
  await unlink(siteFilePath(row.domain)).catch(() => undefined);
  if (row.cf_token_encrypted) removeTokenFileHost(tokenFilePath(row.domain));
  getDb().prepare(`DELETE FROM provisioned_domains WHERE id = ?`).run(row.id);
  try {
    await caddyReload();
  } catch (e) {
    return res.status(502).json({ error: `The domain was removed but the Caddy reload failed: ${String(e.stderr || e.message || '').slice(0, 300)}` });
  }
  logAudit(req.user.id, 'DOMAIN_DEPROVISIONED', 'domain', String(row.id), { domain: row.domain }, req.ip);
  res.json({ ok: true });
});

