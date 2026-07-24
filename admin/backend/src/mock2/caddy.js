// Mock2-owned Caddy site generation (Phase M1, ADR-009).
//
// Mock2 NEVER touches the per-service generator (routes/services.js owns
// /etc/caddy/sites/*) nor the operator's /etc/caddy/custom/*. It writes its
// own site files under a dedicated directory (default /etc/caddy/mock2) and
// wires them in with a SINGLE idempotent import line added to the main
// Caddyfile — and only ever on an enabled host (ADR-001: a disabled/pinned
// host is byte-for-byte unchanged, so nothing here runs unless the module
// was imported behind the gate).
//
// Shape chosen for M1 (recorded in docs/mock2/04-phased-plan.md §M1): one
// EXPLICIT site block per active slug/canary FQDN, each obtaining its own
// Let's Encrypt certificate via Caddy's ordinary HTTP-01 automation. No
// wildcard address, no on-demand-TLS `ask` endpoint (that would force a
// global-options edit shared with the per-service generator). The block
// template below is exactly what M2 reuses for real project slugs — M1
// exercises it via the verification canary.
//
// The pure string builders (buildMock2SiteBlock / buildMock2DomainConfig)
// import nothing native, so the M1 unit tests assert their output directly.

import { writeFile, mkdir, readFile, unlink, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { caddyAdapt, caddyReload } from '../lib/caddy-driver.js';
import { manualTlsDirective } from '../lib/tls-certs.js';
import { sh } from './host.js';

export const MOCK2_CADDY_DIR = process.env.MOCK2_CADDY_DIR || '/etc/caddy/mock2';
const CADDY_CONFIG_FILE = process.env.CADDY_CONFIG_FILE || '/etc/caddy/Caddyfile';
// Caddy's on-disk certificate/key store. Removing a Mock2 site block stops
// SERVING an FQDN, but Caddy keeps the issued cert on disk until it expires, so
// a deleted project leaves cert files behind. removeMock2Certs purges them.
// Default matches the Debian caddy service ("FileStorage:/var/lib/caddy/.local/
// share/caddy" — seen in `caddy` logs); override for a non-standard data dir.
const CADDY_DATA_DIR = process.env.MOCK2_CADDY_DATA_DIR || '/var/lib/caddy/.local/share/caddy';
// An FQDN safe to interpolate into a host `rm` glob: letters, digits, dot, dash
// only — no spaces, quotes, slashes, or shell metacharacters.
const SAFE_CERT_FQDN = /^[a-z0-9][a-z0-9.-]{0,252}$/i;
// The import line Mock2 adds to the main Caddyfile. `.caddy` glob so a
// stray README or editor swap file in the dir can't break config parse
// (mirrors the per-service custom-dir convention in services.js).
const MOCK2_IMPORT_LINE = `import ${MOCK2_CADDY_DIR}/*.caddy`;

// A Caddyfile-safe site-file name for a parent domain. Domains are already
// validated to LDH-only by domain-logic.validateDomain, so this is belt-and-
// suspenders against a caller passing something odd.
export function mock2SiteFileName(domain) {
  return `${String(domain).replace(/[^a-z0-9.-]/gi, '_')}.caddy`;
}

export function mock2SiteFilePath(domain) {
  return `${MOCK2_CADDY_DIR}/${mock2SiteFileName(domain)}`;
}

// Escape a string for safe inclusion inside a Caddyfile double-quoted body.
// Caddy quoted strings may span newlines, so only the quote and backslash
// need escaping. FQDNs are validated upstream; the placeholder text is ours.
function q(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// A bridge-address upstream is `<ip>:<port>` — the container's address on the
// shared Incus bridge and its DECLARED web port (mock2.yaml, ADR-005). Never a
// host port. Validated defensively before it reaches a Caddy directive: an
// IPv4/IPv6 host plus a 1-65535 port. Returns the normalized string or null.
export function normalizeUpstream(upstream) {
  if (!upstream) return null;
  const s = String(upstream).trim();
  const m = s.match(/^([0-9a-fA-F:.]+):(\d{1,5})$/);
  if (!m) return null;
  const port = Number(m[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return `${m[1]}:${port}`;
}

// One site block for a single FQDN. Carries, per ADR-009 / the brief:
//   - an explicit address → Caddy fetches a per-host LE cert via HTTP-01
//   - X-Robots-Tag: noindex on every response (dev plane stays de-indexed)
//   - a robots.txt deny handler independent of whatever the app serves
//   - a forward_auth block rendered but DISABLED — the day-one SSO seam
//   - the terminal handler:
//       * M2 with an `upstream` → reverse_proxy to the container's bridge
//         IP + declared web port (the live project route), OR
//       * no upstream → the placeholder handler (an M1 canary FQDN, or a
//         slug whose container isn't up yet).
// The headers/robots/forward_auth lines are identical in both shapes so the
// block template stays stable (04-phased-plan §M1 Caddy-shape decision).
// tlsDecision (optional) from the manual-cert resolver — resolved by the caller
// so this builder stays DB-free. { mode:'manual', certFile, keyFile } emits
// `tls <cert> <key>` (serves the pasted cert AND disables ACME for this FQDN);
// { mode:'internal' } emits `tls internal`; null keeps per-slug HTTP-01 (ADR-009).
export function buildMock2SiteBlock({ fqdn, note = '', upstream = null, tlsDecision = null } = {}) {
  const host = q(fqdn);
  const up = normalizeUpstream(upstream);
  const tlsLine = tlsDecision && tlsDecision.mode === 'manual' && tlsDecision.certFile && tlsDecision.keyFile
    ? `${manualTlsDirective(tlsDecision.certFile, tlsDecision.keyFile, '\t')}\n\n`
    : tlsDecision && tlsDecision.mode === 'internal' ? `\ttls internal\n\n` : '';

  // The terminal handler is a `handle {}` block in BOTH shapes so it stays
  // mutually exclusive with the `handle /robots.txt` block above (mixing a
  // bare directive with `handle` blocks is a Caddy footgun — everything routes
  // through `handle` here).
  const terminal = up
    ? `	# Live project route — reverse_proxy to the container's bridge IP +
	# declared web port (mock2.yaml, ADR-005). No host port is involved.
	handle {
		reverse_proxy ${up}
		encode gzip zstd
	}`
    : `	# Placeholder handler (no upstream yet — canary FQDN or a slug whose
	# container is still provisioning). Swapped for reverse_proxy once the
	# project's container has a bridge IP.
	handle {
		header Content-Type "text/html; charset=utf-8"
		respond "${q(buildPlaceholderHtml(fqdn))}" 200
	}`;

  return `${note ? `\t# ${note}\n` : ''}${host} {
${tlsLine}	# Dev plane must never be indexed by search engines.
	header X-Robots-Tag "noindex, nofollow, noarchive"

	# Deny all crawlers regardless of what the app's own robots.txt says.
	handle /robots.txt {
		header Content-Type "text/plain; charset=utf-8"
		respond "User-agent: *
Disallow: /
" 200
	}

	# forward_auth hook — RENDERED BUT DISABLED (the day-one seam for
	# per-project SSO). A later phase uncomments this and points it at the
	# Mock2 auth endpoint; leaving it inert keeps the block shape stable.
	# forward_auth 127.0.0.1:3001 {
	#	uri /api/mock2/forward-auth
	#	copy_headers X-Mock2-User X-Mock2-Project
	# }

${terminal}
}
`;
}

// The dev-preview placeholder body served by a block with no upstream.
function buildPlaceholderHtml(fqdn) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<meta name="robots" content="noindex, nofollow">` +
    `<title>ProxyPilot dev preview</title></head>` +
    `<body style="font-family:system-ui,sans-serif;max-width:34rem;margin:12vh auto;padding:0 1rem;color:#334155">` +
    `<h1 style="font-size:1.25rem">Dev preview host ready</h1>` +
    `<p>This hostname is served by a ProxyPilot Mock2 parent domain. ` +
    `A project deployed to this slug will appear here.</p>` +
    `<p style="color:#94a3b8;font-size:.85rem">${fqdn}</p>` +
    `</body></html>`;
}

// The full site file for one parent domain: a provenance header plus one
// block per active FQDN. An empty `fqdns` list yields a header-only file
// (valid — Caddy imports it as a no-op), which is the steady state in M1
// before any project slugs exist (M2). `fqdns` entries may be strings or
// { fqdn, note } objects.
// resolveTls (optional) maps an FQDN → tlsDecision (manual cert / internal /
// null). Injected by the caller (publish.js) so this module stays DB-free and
// unit-testable; defaults to "always ACME" (unchanged behavior).
export function buildMock2DomainConfig({ domain, fqdns = [], resolveTls = null } = {}) {
  const decide = typeof resolveTls === 'function' ? resolveTls : () => null;
  const blocks = (fqdns || [])
    .map((f) => (typeof f === 'string' ? { fqdn: f } : f))
    .filter((f) => f && f.fqdn)
    .map((f) => buildMock2SiteBlock({ ...f, tlsDecision: decide(f.fqdn) }))
    .join('\n');
  const header =
    `# Mock2-managed — regenerated by ProxyPilot. Do NOT edit by hand.\n` +
    `# Parent domain: ${domain}\n` +
    `# Covered FQDNs use a pasted cert (tls) when one matches; others use per-slug HTTP-01 (ADR-009).\n`;
  return blocks ? `${header}\n${blocks}` : header;
}

// ---- Host-side writers (only reached on an enabled host) ----

async function ensureMock2Dir() {
  await mkdir(MOCK2_CADDY_DIR, { recursive: true, mode: 0o755 }).catch(() => {});
}

// Add the Mock2 import line to the main Caddyfile if it isn't already there.
// Idempotent and additive — never rewrites or removes anything else, so it
// cannot disturb the per-service generator's ownership of the file. Only
// called on an enabled host, so a disabled host's Caddyfile is untouched.
export async function ensureMock2CaddyImport() {
  if (!existsSync(CADDY_CONFIG_FILE)) {
    // The per-service generator creates the main Caddyfile on first service.
    // If it doesn't exist yet, there's nothing to import into; the line gets
    // added the next time a domain is written after the base file exists.
    return false;
  }
  let current;
  try {
    current = await readFile(CADDY_CONFIG_FILE, 'utf-8');
  } catch {
    return false;
  }
  if (current.includes(MOCK2_IMPORT_LINE)) return false;
  const appended = (current.endsWith('\n') ? current : `${current}\n`) + `${MOCK2_IMPORT_LINE}\n`;
  await writeFile(CADDY_CONFIG_FILE, appended);
  return true;
}

// Write (or overwrite) the site file for one parent domain. The /etc/caddy
// tree is bind-mounted into the admin container, so a plain writeFile lands
// on the host filesystem (same assumption services.js relies on); only the
// caddy binary itself needs the nsenter pivot, which happens inside reload.
export async function writeMock2DomainSite(domain, fqdns = []) {
  await ensureMock2Dir();
  await ensureMock2CaddyImport();
  const resolveTls = await mock2TlsResolver();
  const content = buildMock2DomainConfig({ domain, fqdns, resolveTls });
  await writeFile(mock2SiteFilePath(domain), content);
  return mock2SiteFilePath(domain);
}

// Lazily load the manual-cert resolver so this module stays native-free at
// IMPORT time (its pure builders are unit-tested without a DB / better-sqlite3).
// Batches the cert list once per domain write; fail-safe to a null resolver
// (unchanged ACME behavior) if the store can't load.
async function mock2TlsResolver() {
  try {
    const store = await import('../lib/tls-cert-store.js');
    const certs = store.certsForResolver();
    const mode = store.currentTlsMode();
    return (fqdn) => store.resolveTlsForHost(fqdn, { globalMode: mode, certs });
  } catch { return () => null; }
}

// Remove a parent domain's site file (on disable/delete). Best-effort; a
// missing file is success.
export async function removeMock2DomainSite(domain) {
  const p = mock2SiteFilePath(domain);
  try {
    await unlink(p);
  } catch (err) {
    if (err && err.code !== 'ENOENT') throw err;
  }
  return p;
}

// Validate the merged Caddy config then reload. Returns { ok } or
// { ok:false, error } — never throws, so callers can surface the ACME/reload
// failure as a notification instead of a 500 (ADR-009 watch-item).
export async function reloadMock2Caddy() {
  try {
    await caddyAdapt({ configPath: CADDY_CONFIG_FILE });
  } catch (err) {
    return { ok: false, stage: 'adapt', error: err.stderr || err.message };
  }
  try {
    await caddyReload({ configPath: CADDY_CONFIG_FILE });
  } catch (err) {
    return { ok: false, stage: 'reload', error: err.stderr || err.message };
  }
  return { ok: true };
}

// Tear down everything Mock2 wrote for a domain: site file gone, config
// reloaded. Used by delete and by the probe cleanup.
export async function unpublishMock2Domain(domain) {
  await removeMock2DomainSite(domain);
  return reloadMock2Caddy();
}

// buildCertRmTargets(fqdns, dataDir) — the validated `certificates/<ca>/<fqdn>`
// glob targets to remove for a set of FQDNs. Pure + exported so the shell-safety
// filter is unit-testable without touching the host. Drops any FQDN that isn't
// plain letters/digits/dot/dash (so nothing shell-unsafe reaches the rm), and
// de-dupes. The `*` is the issuer dir (Let's Encrypt, ZeroSSL, …).
export function buildCertRmTargets(fqdns = [], dataDir = CADDY_DATA_DIR) {
  const safe = [...new Set(
    (fqdns || []).map((f) => String(f || '').trim().toLowerCase()).filter((f) => SAFE_CERT_FQDN.test(f)),
  )];
  return safe.map((f) => `"${dataDir}/certificates"/*/"${f}"`);
}

// removeMock2Certs(fqdns) — best-effort purge of a deleted project's issued
// certificates from Caddy's on-disk store. The site block is already gone
// (publishDomain), so no reload is needed — this just stops the cert/key files
// lingering until expiry. Runs host-side (rm reaches the caddy data dir, which
// is NOT mounted into the container). Never throws; a missing file is success.
export async function removeMock2Certs(fqdns = []) {
  const targets = buildCertRmTargets(fqdns);
  if (targets.length === 0) return { ok: true, removed: 0 };
  const r = await sh(`rm -rf ${targets.join(' ')} 2>&1`, { timeoutMs: 30000 });
  return r.code === 0
    ? { ok: true, removed: targets.length }
    : { ok: false, removed: 0, error: (r.stderr || r.stdout || '').trim().slice(-300) };
}

// Remove the whole Mock2 caddy dir (used by tests / full teardown). Never
// called in the normal request path.
export async function _removeMock2CaddyDirForTests() {
  await rm(MOCK2_CADDY_DIR, { recursive: true, force: true }).catch(() => {});
}
