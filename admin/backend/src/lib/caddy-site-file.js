// Parsing helpers for the per-domain Caddy site files ProxyPilot writes into
// CADDY_SITES_DIR.
//
// Why this module exists
// ----------------------
// Two places used to decide "does this site file belong to container X?" by
// running `content.includes(ip)` against the raw file text. That is wrong twice
// over:
//
//   1. It attributes by ADDRESS rather than by NAME. A guest that picks up an
//      address a site file happens to name — after a DHCP lease is recycled, say
//      — inherits another project's hostnames in the UI. Deleting them from
//      there then removes the wrong thing.
//   2. The match is an unanchored substring, so it collides on prefixes:
//      '10.185.17.224:3000'.includes('10.185.17.22') === true.
//      Two such collisions exist on a 12-guest bridge in the field
//      (.22/.224 and .14/.145) — the second one covering a production mail
//      server. Deleting the guest holding the SHORTER address unlinked the
//      site file of the guest holding the longer one.
//
// See docs/incidents/2026-09-04-route-config-drift.md.
//
// Attribution is by name everywhere now; these helpers exist so that when an
// address genuinely has to be compared (an unmanaged file with no DB row to
// name an owner), the comparison is exact and octet-aware rather than textual.

// A generated site file opens with the site address, optionally prefixed by
// `# proxypilot:` marker comments. Multiple addresses may share one block
// (`a.example.com, b.example.com {`), which Caddy allows and older ProxyPilot
// versions emitted for aliases.
// The `/` is in the class because a site address may carry an `http://` scheme
// prefix — the renderer emits one whenever a route has ssl_enabled = 0.
const SITE_ADDRESS_RE = /^\s*((?:[A-Za-z0-9*_.:/\-]+)(?:\s*,\s*[A-Za-z0-9*_.:/\-]+)*)\s*\{\s*$/;

// `reverse_proxy <upstream> [<upstream>...]` — optionally followed by `{` when
// the route carries a transport/header block. Upstreams may be bare hosts,
// host:port, or scheme-prefixed.
const REVERSE_PROXY_RE = /^\s*reverse_proxy\s+([^{\n]+?)\s*\{?\s*$/;

const HEALTHPATH_RE = /^\s*#\s*proxypilot:\s*healthpath=(\S+)\s*$/;

/**
 * Strict IPv4 test. Rejects the loose shapes a substring match would accept
 * (leading zeros, out-of-range octets, embedded text).
 *
 * @param {string} value
 * @returns {boolean}
 */
export function isIpv4(value) {
  if (typeof value !== 'string') return false;
  const parts = value.split('.');
  if (parts.length !== 4) return false;
  return parts.every((p) => /^(0|[1-9]\d{0,2})$/.test(p) && Number(p) <= 255);
}

/**
 * Compare two addresses for exact equality.
 *
 * This is the function that replaces `content.includes(ip)`. '10.185.17.22'
 * and '10.185.17.224' are different hosts and must never compare equal.
 *
 * @param {string|null|undefined} a
 * @param {string|null|undefined} b
 * @returns {boolean}
 */
export function sameHost(a, b) {
  if (!a || !b) return false;
  return String(a).trim() === String(b).trim();
}

/**
 * Split an upstream token into host and port. Handles `1.2.3.4:3000`,
 * `1.2.3.4`, `http://1.2.3.4:3000`, and bracketed IPv6 (`[::1]:3000`).
 *
 * @param {string} token
 * @returns {{host: string, port: number|null}|null}
 */
export function parseUpstreamToken(token) {
  if (!token) return null;
  let t = String(token).trim();
  if (!t) return null;
  t = t.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  // Bracketed IPv6 literal, with or without a port.
  const v6 = t.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (v6) return { host: v6[1], port: v6[2] ? Number(v6[2]) : null };
  const idx = t.lastIndexOf(':');
  // No colon, or a bare IPv6 literal (several colons, no port).
  if (idx === -1 || t.indexOf(':') !== idx) return { host: t, port: null };
  const host = t.slice(0, idx);
  const portRaw = t.slice(idx + 1);
  if (!/^\d+$/.test(portRaw)) return { host: t, port: null };
  return { host, port: Number(portRaw) };
}

/**
 * Parse one generated Caddy site file.
 *
 * Returns every site address the block serves and every reverse_proxy upstream
 * it names — plural, because the merged renderer emits one `handle` block per
 * path prefix and therefore several upstreams per domain. The old regex took
 * only the first `reverse_proxy` line, which silently mis-reported multi-route
 * domains.
 *
 * @param {string} content raw file text
 * @returns {{
 *   domains: string[],
 *   primaryDomain: string|null,
 *   upstreams: Array<{host: string, port: number|null}>,
 *   healthPath: string|null,
 *   tlsInternal: boolean,
 * }}
 */
export function parseCaddySiteFile(content) {
  const out = {
    domains: [],
    primaryDomain: null,
    upstreams: [],
    healthPath: null,
    tlsInternal: false,
  };
  if (!content || typeof content !== 'string') return out;

  for (const rawLine of content.split('\n')) {
    if (!out.domains.length) {
      const site = rawLine.match(SITE_ADDRESS_RE);
      if (site) {
        out.domains = site[1]
          .split(',')
          .map((d) => d.trim().replace(/^https?:\/\//, ''))
          .filter(Boolean);
        out.primaryDomain = out.domains[0] || null;
        continue;
      }
    }
    const health = rawLine.match(HEALTHPATH_RE);
    if (health) {
      out.healthPath = health[1];
      continue;
    }
    if (/^\s*tls\s+internal\s*$/.test(rawLine)) {
      out.tlsInternal = true;
      continue;
    }
    const rp = rawLine.match(REVERSE_PROXY_RE);
    if (rp) {
      for (const token of rp[1].split(/\s+/)) {
        const parsed = parseUpstreamToken(token);
        if (parsed && parsed.host) out.upstreams.push(parsed);
      }
    }
  }
  return out;
}

/**
 * Does this site file dial the given host, on any of its upstreams?
 *
 * Exact host comparison — the direct replacement for `content.includes(ip)`.
 *
 * @param {string} content raw file text
 * @param {string} host    address to test for
 * @returns {boolean}
 */
export function siteFileTargetsHost(content, host) {
  if (!host) return false;
  const parsed = parseCaddySiteFile(content);
  return parsed.upstreams.some((u) => sameHost(u.host, host));
}

// ---- Site security headers (the `header { … }` block of a rendered site) ----
//
// The dashboard origin that may embed a proxied app in an iframe: the LXC
// Workspace preview. "https://<admin-domain>" or null when the admin domain is
// unknown/invalid (null = the classic SAMEORIGIN posture, preview stays blocked).
export function dashboardFrameAncestor(adminHost) {
  const clean = adminHost ? String(adminHost).trim().toLowerCase() : '';
  if (!clean || !/^[a-z0-9.-]+$/.test(clean)) return null;
  return `https://${clean}`;
}

// Lines for the site-level header block. Three postures:
//   * allowFramingRoute — the operator's per-route escape hatch (MEET, OAuth
//     popups): X-Frame-Options dropped, frame-ancestors = their list or '*'.
//   * frameAncestor     — the default once the admin domain is known: the app
//     may be framed by ITSELF and the ProxyPilot dashboard, nothing else. This
//     is the same scoped allowance the Mock2 module gives project apps for the
//     Flightdeck preview, expressed on the site's own header block so it also
//     covers static sites and apps that send no CSP at all:
//       -X-Frame-Options                      (can't express a cross-origin allowance)
//       Content-Security-Policy <re> <value>  (rewrite an app's own frame-ancestors)
//       +Content-Security-Policy <value>      (and always add one — several CSP
//                                              headers intersect, so an app with no
//                                              frame-ancestors is still fenced)
//     `defer` because these rewrite the UPSTREAM's response headers.
//   * neither           — X-Frame-Options "SAMEORIGIN" (pre-2026-09 behaviour).
export function siteSecurityHeaderLines({ allowFramingRoute = null, frameAncestor = null, indent = '    ' } = {}) {
  const i2 = `${indent}    `;
  const lines = [`${indent}header {`];
  if (allowFramingRoute) {
    lines.push(`${i2}-X-Frame-Options`);
    const ancestors = String(allowFramingRoute.frameAncestors || '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean)
      .join(' ') || '*';
    lines.push(`${i2}Content-Security-Policy "frame-ancestors ${ancestors}"`);
  } else if (frameAncestor && /^https?:\/\/[a-z0-9.-]+(:\d{1,5})?$/i.test(frameAncestor)) {
    const value = `frame-ancestors 'self' ${frameAncestor}`;
    lines.push(`${i2}defer`);
    lines.push(`${i2}-X-Frame-Options`);
    lines.push(`${i2}Content-Security-Policy "frame-ancestors[^;]*" "${value}"`);
    lines.push(`${i2}+Content-Security-Policy "${value}"`);
  } else {
    lines.push(`${i2}X-Frame-Options "SAMEORIGIN"`);
  }
  lines.push(`${i2}X-Content-Type-Options "nosniff"`);
  lines.push(`${i2}X-XSS-Protection "1; mode=block"`);
  lines.push(`${i2}Referrer-Policy "strict-origin-when-cross-origin"`);
  lines.push(`${indent}}`);
  return lines;
}

// Bump when the rendered site-file shape changes in a way every existing file
// must pick up. The backend compares it with app_settings.caddy_site_render_contract
// at boot and regenerates all site files once (index.js).
export const CADDY_SITE_RENDER_CONTRACT = '2';


// ---- per-route edge options (migration 907; set_route_options over MCP) ----
//
// Five nullable JSON/text columns on service_http_routes. NULL everywhere
// renders nothing, so a site file without options is byte-identical to the
// pre-907 output. Rendered INSIDE the route's handle block, and wrapped in a
// `route { }` when a rate limit is present so the plugin directive keeps its
// textual position without a global `order` line.

export function parseRouteEdgeOptions(row = {}) {
  const j = (v) => { if (v == null || v === '') return null; try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return null; } };
  const headers = j(row.extra_headers_json ?? row.extraHeadersJson);
  const basicAuth = j(row.basic_auth_json ?? row.basicAuthJson);
  const ipAllow = j(row.ip_allowlist_json ?? row.ipAllowlistJson);
  const rateLimit = j(row.rate_limit_json ?? row.rateLimitJson);
  const csp = row.csp != null && String(row.csp).trim() !== '' ? String(row.csp).trim() : null;
  const out = {
    headers: headers && typeof headers === 'object' && !Array.isArray(headers) ? headers : null,
    csp,
    basic_auth: Array.isArray(basicAuth) && basicAuth.length ? basicAuth : null,
    ip_allowlist: Array.isArray(ipAllow) && ipAllow.length ? ipAllow : null,
    rate_limit: rateLimit && typeof rateLimit === 'object' && rateLimit.events ? rateLimit : null,
  };
  return Object.values(out).some((v) => v != null) ? out : null;
}

const HEADER_NAME_RE = /^[A-Za-z0-9-]{1,80}$/;
const CIDR_RE = /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$|^[0-9a-fA-F:]+(\/\d{1,3})?$/;
const q = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/**
 * Validate the option object set_route_options accepts. Returns { options }
 * (normalized, ready to store) or { error }. `bcryptHash` hashes basic-auth
 * passwords; the stored form never carries a plaintext password.
 */
export function validateRouteEdgeOptions(input = {}, { bcryptHash = null, rateLimitAvailable = null } = {}) {
  const out = {};
  if (input.headers !== undefined) {
    if (input.headers === null) out.headers = null;
    else {
      if (typeof input.headers !== 'object' || Array.isArray(input.headers)) return { error: 'headers must be an object of { "Header-Name": "value" } (null value removes the header)' };
      const h = {};
      for (const [k, v] of Object.entries(input.headers)) {
        if (!HEADER_NAME_RE.test(k)) return { error: `"${k}" is not a valid header name` };
        if (/^(content-security-policy|set-cookie)$/i.test(k)) return { error: `${k} cannot be set through headers (use csp for the policy)` };
        if (v !== null && (typeof v !== 'string' || v.length > 2000 || /[\r\n]/.test(v))) return { error: `${k}: value must be a single-line string` };
        h[k] = v;
      }
      out.headers = Object.keys(h).length ? h : null;
    }
  }
  if (input.csp !== undefined) {
    if (input.csp === null || input.csp === '') out.csp = null;
    else if (typeof input.csp !== 'string' || input.csp.length > 4000 || /[\r\n"]/.test(input.csp)) return { error: 'csp must be a single-line policy string without double quotes' };
    else out.csp = input.csp.trim();
  }
  if (input.basic_auth !== undefined) {
    if (input.basic_auth === null) out.basic_auth = null;
    else {
      if (!Array.isArray(input.basic_auth) || !input.basic_auth.length) return { error: 'basic_auth must be an array of { username, password } (or null to remove)' };
      if (!bcryptHash) return { error: 'basic_auth needs a password hasher' };
      const users = [];
      for (const u of input.basic_auth) {
        const name = String(u?.username || '');
        if (!/^[A-Za-z0-9._@-]{1,64}$/.test(name)) return { error: 'basic_auth usernames: letters, digits, . _ @ -' };
        if (u.password_hash && /^\$2[aby]\$/.test(String(u.password_hash))) { users.push({ username: name, hash: String(u.password_hash) }); continue; }
        const pw = String(u?.password || '');
        if (pw.length < 8 || pw.length > 256) return { error: `basic_auth: ${name}'s password must be 8–256 characters` };
        users.push({ username: name, hash: bcryptHash(pw) });
      }
      out.basic_auth = users;
    }
  }
  if (input.ip_allowlist !== undefined) {
    if (input.ip_allowlist === null) out.ip_allowlist = null;
    else {
      if (!Array.isArray(input.ip_allowlist) || !input.ip_allowlist.length) return { error: 'ip_allowlist must be a non-empty array of IPs / CIDRs (or null to remove)' };
      const list = input.ip_allowlist.map((s) => String(s).trim());
      const bad = list.filter((s) => !CIDR_RE.test(s) || s === '0.0.0.0/0' || s === '::/0');
      if (bad.length) return { error: `ip_allowlist: not an IP or CIDR: ${bad.join(', ')}` };
      out.ip_allowlist = [...new Set(list)];
    }
  }
  if (input.rate_limit !== undefined) {
    if (input.rate_limit === null) out.rate_limit = null;
    else {
      const rl = input.rate_limit;
      const events = Number(rl?.events);
      const window = String(rl?.window || '1m');
      if (!Number.isInteger(events) || events < 1 || events > 1000000) return { error: 'rate_limit.events must be an integer 1–1000000' };
      if (!/^\d{1,5}(s|m|h)$/.test(window)) return { error: 'rate_limit.window must look like 10s, 1m or 1h' };
      const key = rl?.key === 'path' ? '{http.request.uri.path}' : '{remote_host}';
      if (rateLimitAvailable === false) return { error: 'This Caddy build has no http.handlers.rate_limit module. Install caddy-ratelimit (`caddy add-package github.com/mholt/caddy-ratelimit` on the host, then restart caddy) and retry.' };
      out.rate_limit = { events, window, key };
    }
  }
  return { options: out };
}

/** Caddyfile lines for a route's edge options, to go INSIDE the handle block before the proxy/file_server body. */
export function routeEdgeOptionLines(opts, indent = '        ', { routeId = 'r', selfCheck = null } = {}) {
  if (!opts) return [];
  const lines = [];
  const i2 = `${indent}    `;
  if (opts.ip_allowlist && selfCheck && /^[a-f0-9]{48}$/.test(selfCheck.token || '')) {
    // A platform adapter's own self-check (lib/setup-engine/local-edge.js):
    // loopback source AND the installation's self-check header. Nothing else
    // is let through — not other loopback traffic, not the firewall's LAN
    // address, not the host's public address.
    lines.push(`${indent}@pp_denied {`);
    lines.push(`${i2}not remote_ip ${opts.ip_allowlist.join(' ')}`);
    lines.push(`${i2}not {`);
    lines.push(`${i2}    remote_ip ${(selfCheck.sources || ['127.0.0.1/32', '::1/128']).join(' ')}`);
    lines.push(`${i2}    header ${selfCheck.header || 'X-ProxyPilot-Self-Check'} ${selfCheck.token}`);
    lines.push(`${i2}}`);
    lines.push(`${indent}}`);
    lines.push(`${indent}respond @pp_denied 403`);
  } else if (opts.ip_allowlist) {
    lines.push(`${indent}@pp_denied not remote_ip ${opts.ip_allowlist.join(' ')}`);
    lines.push(`${indent}respond @pp_denied 403`);
  }
  if (opts.basic_auth) {
    lines.push(`${indent}basic_auth {`);
    for (const u of opts.basic_auth) lines.push(`${i2}${u.username} ${u.hash}`);
    lines.push(`${indent}}`);
  }
  if (opts.headers || opts.csp) {
    lines.push(`${indent}header {`);
    for (const [k, v] of Object.entries(opts.headers || {})) {
      lines.push(v === null ? `${i2}-${k}` : `${i2}${k} ${q(v)}`);
    }
    if (opts.csp) lines.push(`${i2}Content-Security-Policy ${q(opts.csp)}`);
    lines.push(`${indent}}`);
  }
  if (opts.rate_limit) {
    const zone = `pp_${String(routeId).replace(/[^A-Za-z0-9]/g, '').slice(0, 24) || 'r'}`;
    lines.push(`${indent}rate_limit {`);
    lines.push(`${i2}zone ${zone} {`);
    lines.push(`${i2}    key ${opts.rate_limit.key || '{remote_host}'}`);
    lines.push(`${i2}    events ${opts.rate_limit.events}`);
    lines.push(`${i2}    window ${opts.rate_limit.window}`);
    lines.push(`${i2}}`);
    lines.push(`${indent}}`);
  }
  return lines;
}

/** Wrap a handler body in `route { }` when the options need textual ordering (rate_limit). */
export function wrapRouteBody(optionLines, bodyLines, opts, indent = '        ') {
  if (!opts?.rate_limit) return [...optionLines, ...bodyLines];
  const shift = (l) => `    ${l}`;
  return [`${indent}route {`, ...optionLines.map(shift), ...bodyLines.map(shift), `${indent}}`];
}
