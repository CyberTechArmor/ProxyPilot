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

