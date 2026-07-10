// Mock2 parent-domain pure decision layer (Phase M1).
//
// Stub-first discipline (risk R9 / docs/known-issues.md): this module holds
// EVERY decision that can be made without touching better-sqlite3, Express,
// DNS, or the Caddy binary — domain shape validation, the selectable
// predicate, the wildcard-DNS verdict, and the probe-cert verdict. It is the
// module the M1 unit tests import, so the native/host layers never have to
// run under `node --test`.
//
// ADR-009 (per-slug HTTP-01): a parent domain becomes usable only after a
// two-stage verification — wildcard DNS resolves to this host, then a probe
// certificate is issued on a canary FQDN — and an admin has enabled it. The
// `dns_provider`/`dns_credentials_enc`/`cert_path` columns exist for the
// deferred wildcard DNS-01 upgrade and stay NULL in v1.

// A parent domain is a bare registrable hostname the operator controls
// (dev.example.com), NOT a wildcard and NOT a URL. Wildcard is rejected on
// purpose: the wildcard lives in DNS (`*.dev.example.com` → this host), never
// in the stored domain. Labels are 1–63 chars, LDH, no leading/trailing dash;
// at least two labels (reject bare TLDs and single hostnames).
const LABEL = '(?!-)[a-z0-9-]{1,63}(?<!-)';
const DOMAIN_RE = new RegExp(`^${LABEL}(?:\\.${LABEL})+$`);

// Normalize operator input before validation/storage: trim, lowercase, drop a
// trailing dot (FQDN root) and any accidental leading `*.`. Returns '' for
// nullish so the caller's validation rejects it uniformly.
export function normalizeDomain(raw) {
  let d = String(raw ?? '').trim().toLowerCase();
  if (d.startsWith('*.')) d = d.slice(2);
  if (d.endsWith('.')) d = d.slice(0, -1);
  return d;
}

// validateDomain(raw) → { ok, domain } | { ok:false, error }
export function validateDomain(raw) {
  const domain = normalizeDomain(raw);
  if (!domain) return { ok: false, error: 'Domain is required' };
  if (domain.length > 253) return { ok: false, error: 'Domain is too long' };
  if (domain.includes('*')) return { ok: false, error: 'Wildcards are not allowed — register the bare domain (e.g. dev.example.com)' };
  if (!DOMAIN_RE.test(domain)) {
    return { ok: false, error: 'Invalid domain — use a bare hostname like dev.example.com' };
  }
  return { ok: true, domain };
}

// A parent domain is offerable to project creation once its wildcard DNS is
// verified (dns_ok) AND an admin has flipped it on. The per-slug Let's Encrypt
// cert is issued when a project is created (publishDomain → Caddy HTTP-01), not
// up front — so there is no cert-probe gate (operator decision). A legacy
// cert_ok row still qualifies. Single gate for both the route and the UI.
export function isSelectable(row) {
  return !!row && Number(row.enabled) === 1 &&
    (row.verify_status === 'dns_ok' || row.verify_status === 'cert_ok');
}

// Decorate a stored row for API responses: never leak the encrypted DNS
// credential blob, and surface the derived `selectable` flag the frontend and
// M2 both key off. Pure — takes a plain row, returns a plain object.
export function publicDomainShape(row) {
  if (!row) return null;
  return {
    id: row.id,
    domain: row.domain,
    verify_status: row.verify_status,
    verified_at: row.verified_at || null,
    last_renewal_at: row.last_renewal_at || null,
    renewal_error: row.renewal_error || null,
    enabled: Number(row.enabled) === 1,
    selectable: isSelectable(row),
    created_by: row.created_by ?? null,
    created_at: row.created_at || null,
    // Deferred wildcard DNS-01 columns — present for shape stability, always
    // null in v1 (ADR-009). Credentials are NEVER serialized.
    dns_provider: row.dns_provider || null,
    has_dns_credentials: !!row.dns_credentials_enc,
    cert_path: row.cert_path || null,
  };
}

// A short, DNS-safe random label for the two verification probes. Callers
// inject the randomness (a hex string) so this stays pure and the tests are
// deterministic. The label is intentionally recognizable as Mock2's own so an
// operator who greps DNS logs during a failed verify knows what issued it.
export function canaryLabel(rand) {
  const suffix = String(rand || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12) || 'probe';
  return `_mock2-verify-${suffix}`;
}

// Parse MOCK2_PUBLIC_IP (comma-separated) into a clean list of host IPs.
// Defensive: docker-compose `env_file` and systemd `EnvironmentFile` do NOT
// strip an inline `# comment` the way dotenv does, so a `.env` line like
// `MOCK2_PUBLIC_IP=  # TODO: review` (as update.sh's sync_env_keys used to
// append) can reach process.env verbatim as `# TODO: review`. Keeping only
// entries that actually look like an IPv4/IPv6 address means a stray comment
// downgrades to "host IP unknown → resolves but not cross-checked" instead of
// the nonsensical "wildcard resolves to X but this host answers on # TODO:
// review". Pure + exported so it is unit-testable and shared by verify.js and
// the routes' A-record check.
const IPV4_RE = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const IPV6_RE = /^[0-9a-f]{0,4}(:[0-9a-f]{0,4}){2,7}$/i;
export function looksLikeIp(value) {
  const v = String(value ?? '').trim();
  return IPV4_RE.test(v) || IPV6_RE.test(v);
}
export function parseHostIps(raw) {
  return String(raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(looksLikeIp);
}

// evaluateWildcardDns — decide whether a random label under the parent domain
// resolves to this host. `resolvedIps` is what DNS returned for the random
// label; `expectedIps` is what we believe this host answers on (may be empty
// when the host IP is unknown — then we accept "resolves at all" but flag that
// it was not cross-checked, per ADR-009's pragmatic v1 stance).
//
// Returns { ok, matched, reason }.
export function evaluateWildcardDns({ resolvedIps = [], expectedIps = [] } = {}) {
  const got = (resolvedIps || []).filter(Boolean);
  if (got.length === 0) {
    return { ok: false, matched: false, reason: 'wildcard label did not resolve (no A/AAAA record — is *.<domain> pointed at this host?)' };
  }
  const expect = (expectedIps || []).filter(Boolean);
  if (expect.length === 0) {
    return { ok: true, matched: false, reason: 'wildcard resolves, but this host\'s public IP is unknown so it was not cross-checked (set MOCK2_PUBLIC_IP to enforce)' };
  }
  const hit = got.some((ip) => expect.includes(ip));
  if (hit) return { ok: true, matched: true, reason: 'wildcard resolves to this host' };
  return {
    ok: false,
    matched: false,
    reason: `wildcard resolves to ${got.join(', ')} but this host answers on ${expect.join(', ')}`,
  };
}

// classifyProbe — decide whether a probe-cert issuance succeeded. `status` is
// the HTTP status the canary FQDN returned over TLS; `tlsAuthorized` is whether
// Node accepted the presented certificate (i.e. a real Let's Encrypt cert, not
// Caddy's internal fallback). `error` is any transport error string.
//
// Success requires BOTH a 2xx response AND an authorized TLS chain — a 200 over
// Caddy's self-signed internal CA means ACME did NOT complete.
export function classifyProbe({ status = 0, tlsAuthorized = false, error = null } = {}) {
  if (error) return { ok: false, reason: `probe request failed: ${error}` };
  if (!tlsAuthorized) return { ok: false, reason: 'probe served a cert that is not publicly trusted — ACME (HTTP-01) did not complete (check port 80 reachability and Let\'s Encrypt rate limits)' };
  if (status >= 200 && status < 400) return { ok: true, reason: 'probe FQDN served a publicly-trusted certificate' };
  return { ok: false, reason: `probe FQDN returned HTTP ${status}` };
}

// The verify_status the pipeline should land on after each stage — kept here so
// the state machine (pending → dns_ok → cert_ok, or → failed) is one testable
// function rather than scattered string literals in the orchestrator.
export function nextVerifyStatus(stage, ok) {
  if (!ok) return 'failed';
  if (stage === 'dns') return 'dns_ok';
  if (stage === 'cert') return 'cert_ok';
  return 'pending';
}
