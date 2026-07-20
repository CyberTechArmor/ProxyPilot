// Domain provisioning — pure decision layer for the self-service "Add
// Domain" page. Everything here is native-free and I/O-free (unit-tested
// without better-sqlite3): certificate-method resolution, the DNS-01
// specified-domain list matcher, Caddy site-block generation, input
// validation, ACME error classification, and credential masking.
//
// TWO DISTINCT CREDENTIALS flow through this feature — never conflate them:
//   1. ProxyPilot access API key  — application-level key that authorizes
//      the provisioning page/endpoints. Required for BOTH cert methods.
//      Stored as a sha256 hash; the raw key is shown once at creation.
//   2. Cloudflare API token       — scoped token (Zone→DNS→Edit,
//      Zone→Zone→Read) Caddy uses for the DNS-01 challenge. Only exists
//      for DNS-01 domains. Encrypted at rest in the DB; materialized to a
//      root/caddy-only file referenced from the site block via a
//      {file.…} placeholder so it never appears inline in the Caddyfile
//      and survives restarts for renewals.

import crypto from 'crypto';

// ---- validation ----

// Same shape services.js accepts, minus the wildcard prefix — the wildcard
// is a separate toggle here (it changes the cert method), so the domain
// field itself must be a bare FQDN.
export const DOMAIN_RE = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)+$/;
// host:port — hostname/IPv4 label rules, port 1-65535. No schemes, no
// paths, no whitespace: this string is written into a Caddy directive, so
// the regex doubles as the config-injection guard.
export const UPSTREAM_RE = /^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?:\d{1,5}$/;
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const CERT_METHODS = Object.freeze(['auto', 'http01', 'dns01']);

// Shape check for a Cloudflare API token (per-domain field AND the global
// token saved from the Domains page) — a sanity net, not real validation:
// Cloudflare judges the token when Caddy first uses it.
export const CF_TOKEN_RE = /^[\w.\-]{20,300}$/;

export function validateProvisionInput({ domain, upstream, method = 'auto', wildcard = false, acmeEmail, cfToken = '' } = {}) {
  const errors = [];
  const d = String(domain || '').trim().toLowerCase();
  const u = String(upstream || '').trim();
  const e = String(acmeEmail || '').trim();
  const m = String(method || 'auto').trim();
  if (!DOMAIN_RE.test(d) || d.length > 253) errors.push('Domain must be a bare domain like example.com (no scheme, no wildcard — use the wildcard toggle).');
  if (!UPSTREAM_RE.test(u)) errors.push('Upstream must be host:port, e.g. localhost:8080 or 10.0.0.5:3000.');
  else {
    const port = Number(u.slice(u.lastIndexOf(':') + 1));
    if (!(port >= 1 && port <= 65535)) errors.push('Upstream port must be 1–65535.');
  }
  if (!EMAIL_RE.test(e) || e.length > 254) errors.push('ACME contact email must be a valid email address.');
  if (!CERT_METHODS.includes(m)) errors.push('Certificate method must be auto, http01, or dns01.');
  const t = String(cfToken || '').trim();
  if (t && !CF_TOKEN_RE.test(t)) errors.push('That does not look like a Cloudflare API token.');
  return {
    ok: errors.length === 0,
    errors,
    value: { domain: d, upstream: u, method: m, wildcard: !!wildcard, acmeEmail: e, cfToken: t },
  };
}

// ---- DNS-01 specified-domain list ----

// The operator-maintained list marks domains that must use DNS validation
// (geo-blocked HTTP ports, wildcard-serving zones) without the submitting
// user having to know. Entries are exact domains ("internal.example.com")
// or suffix patterns ("*.example.com" — matches any subdomain at any
// depth, NOT the apex; list the apex separately if it needs DNS-01 too).
export function parseDns01List(raw) {
  let arr = raw;
  if (typeof raw === 'string') {
    try { arr = JSON.parse(raw); } catch { arr = raw.split(/[\n,]+/); }
  }
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const item of arr) {
    const s = String(item || '').trim().toLowerCase();
    if (!s) continue;
    const bare = s.startsWith('*.') ? s.slice(2) : s;
    if (DOMAIN_RE.test(bare)) out.push(s);
  }
  return [...new Set(out)];
}

export function matchesDns01List(domain, list = []) {
  const d = String(domain || '').trim().toLowerCase();
  for (const entry of list) {
    if (entry.startsWith('*.')) {
      if (d.endsWith(entry.slice(1)) && d.length > entry.length - 1) return entry;
    } else if (d === entry) {
      return entry;
    }
  }
  return null;
}

// ---- certificate method selection ----
// Order (spec): 1) wildcard forces DNS-01; 2) explicit user choice;
// 3) the specified-domain list; 4) default standard Let's Encrypt.
// Returns { method: 'http01'|'dns01', reason } or { error } when the
// combination is impossible (wildcard without any Cloudflare token).
export function resolveCertMethod({ domain, method = 'auto', wildcard = false, dns01List = [], hasDomainToken = false, hasGlobalToken = false }) {
  const tokenAvailable = hasDomainToken || hasGlobalToken;
  if (wildcard) {
    if (!tokenAvailable) {
      return { error: "Wildcard certificates require the Cloudflare DNS-01 method, and no Cloudflare API token is available. Enter a token for this domain or configure the server's global CLOUDFLARE_API_TOKEN.", method: 'dns01', needsToken: true };
    }
    return { method: 'dns01', reason: 'Wildcard certificates can only be issued via DNS validation.' };
  }
  if (method === 'dns01') {
    if (!tokenAvailable) {
      return { error: 'The Cloudflare DNS-01 method needs a Cloudflare API token. Enter one for this domain or configure the global token.', method: 'dns01', needsToken: true };
    }
    return { method: 'dns01', reason: 'You selected Cloudflare DNS-01 for this domain.' };
  }
  if (method === 'http01') {
    return { method: 'http01', reason: 'You selected standard Let’s Encrypt for this domain.' };
  }
  const listHit = matchesDns01List(domain, dns01List);
  if (listHit) {
    if (!tokenAvailable) {
      return { error: `"${domain}" is configured as a DNS-01 domain (matches "${listHit}"), but no Cloudflare API token is available. Enter one or configure the global token.`, method: 'dns01', needsToken: true };
    }
    return { method: 'dns01', reason: `This domain is on the server's DNS-01 list (matches "${listHit}") — typically geo-blocked or wildcard-serving domains.` };
  }
  return { method: 'http01', reason: 'Standard Let’s Encrypt (HTTP-01 / TLS-ALPN) — the default; nothing to configure.' };
}

// ---- Caddy site block generation ----

// Filesystem-safe site-file name, prefixed so ownership is unambiguous
// next to the Services-managed files in /etc/caddy/sites.
export function provisionFileName(domain) {
  return `pp-provision_${String(domain).replace(/\*/g, '_wildcard_')}`;
}

// Token files live OUTSIDE the sites dir (the Caddyfile imports sites/*,
// which would parse a token file as config). /etc/caddy/pp-secrets is
// created 0700 root-owned with files 0640 root:caddy.
export const PP_SECRETS_DIR = '/etc/caddy/pp-secrets';
export function tokenFilePath(domain) {
  return `${PP_SECRETS_DIR}/cf_${String(domain).replace(/[^a-zA-Z0-9.-]/g, '_')}.token`;
}

// The generated site block. Inputs MUST have passed validateProvisionInput
// — the regexes are the injection guard (no whitespace, braces, or
// newlines can reach this template). For DNS-01 the token rides a
// {file.…} placeholder: Caddy resolves it at config load, so the secret
// never sits inline in the Caddyfile and renewals keep working after
// restarts (the file persists on the host).
export function buildSiteBlock({ domain, upstream, acmeEmail, method, wildcard = false }) {
  if (!DOMAIN_RE.test(domain) || !UPSTREAM_RE.test(upstream) || !EMAIL_RE.test(acmeEmail)) {
    throw new Error('buildSiteBlock called with unvalidated input');
  }
  const address = wildcard ? `${domain}, *.${domain}` : domain;
  const tls = method === 'dns01'
    ? `    tls ${acmeEmail} {
        dns cloudflare {file.${tokenFilePath(domain)}}
    }`
    : `    tls ${acmeEmail}`;
  return `# Managed by ProxyPilot domain provisioning — do not edit by hand.
# domain=${domain} method=${method}${wildcard ? ' wildcard' : ''}
${address} {
${tls}
    reverse_proxy ${upstream}
}
`;
}

// ---- access API keys ----

export function generateApiKey() {
  // pp_dom_ prefix identifies the credential class in any leak/scan.
  return `pp_dom_${crypto.randomBytes(24).toString('base64url')}`;
}

export function hashApiKey(raw) {
  return crypto.createHash('sha256').update(String(raw || '')).digest('hex');
}

export const PROVISION_SCOPE = 'domains:provision';

// ---- masking (nothing secret ever goes back to a client) ----

export function maskApiKey(raw) {
  const s = String(raw || '');
  return s.length <= 8 ? '••••' : `${s.slice(0, 7)}…${s.slice(-4)}`;
}

export function publicDomainShape(row) {
  if (!row) return null;
  return {
    id: row.id,
    domain: row.domain,
    upstream: row.upstream,
    method_requested: row.method_requested,
    method_resolved: row.method_resolved,
    wildcard: !!row.wildcard,
    acme_email: row.acme_email,
    // The Cloudflare token NEVER leaves the server — presence only.
    cf_token: row.cf_token_encrypted ? 'set' : null,
    cf_token_source: row.cf_token_source || null,
    status: row.status,
    last_error: row.last_error || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// ---- ACME failure classification (actionable messages) ----

// Map a caddy log line about a failed issuance to a human diagnosis. Fed
// from `journalctl -u caddy` scoped to the domain; fail-open to null so
// an unrecognized line just stays "pending" with the raw detail.
export function classifyAcmeError(line) {
  const s = String(line || '');
  if (!s) return null;
  if (/rateLimited|too many certificates|too many failed authorizations/i.test(s)) {
    return { code: 'rate_limited', hint: "Let's Encrypt rate limit hit for this domain. Wait for the limit window to pass (usually a week for duplicate certs, an hour for failed authorizations) before retrying." };
  }
  if (/could not determine zone|zone.*not found/i.test(s)) {
    return { code: 'cf_wrong_zone', hint: 'Cloudflare could not find the DNS zone for this domain. Check that the domain lives in the Cloudflare account the token belongs to.' };
  }
  if (/authentication error|invalid.*token|401|403/i.test(s) && /cloudflare|dns/i.test(s)) {
    return { code: 'cf_bad_token', hint: 'Cloudflare rejected the API token. It needs Zone → DNS → Edit and Zone → Zone → Read scopes for this zone.' };
  }
  if (/no valid A records|connection refused|timeout during connect|Fetching http:\/\/|dial tcp.*(80|443)/i.test(s)) {
    return { code: 'http_unreachable', hint: "Let's Encrypt could not reach this domain over HTTP. Check the domain's DNS points at this server and port 80/443 is reachable — note Let's Encrypt validates from multiple regions, so a geo-block breaks HTTP validation; mark the domain as a DNS-01 domain instead." };
  }
  if (/CAA record|caa/i.test(s) && /forbid|prohibit/i.test(s)) {
    return { code: 'caa_forbids', hint: "The domain's CAA DNS record forbids Let's Encrypt. Add 'letsencrypt.org' to the CAA record or remove it." };
  }
  if (/obtaining certificate|could not get certificate|challenge failed/i.test(s)) {
    return { code: 'acme_failed', hint: 'The ACME challenge failed. See the detail below; the Caddy log has the full exchange.' };
  }
  return null;
}
