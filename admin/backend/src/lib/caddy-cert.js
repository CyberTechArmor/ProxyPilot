// Caddy cert discovery.
//
// The admin container does NOT bind-mount Caddy's data directory —
// install.sh only exposes /etc/caddy/sites, /etc/caddy/custom and
// the Caddyfile. The actual ACME data (issued certs, account keys)
// lives at /var/lib/caddy/.local/share/caddy/ on the host. To find
// the cert directory for a given hostname we therefore have to
// stat the host filesystem via nsenter, just like the L4 reconciler
// shells out for `incus config device show`.
//
// Layout produced by Caddy's ACME issuer is:
//
//   <base>/certificates/<issuer>/<hostname>/<hostname>.crt
//   <base>/certificates/<issuer>/<hostname>/<hostname>.key
//   <base>/certificates/<issuer>/<hostname>/<hostname>.json
//
// where <issuer> is e.g. `acme-v02.api.letsencrypt.org-directory` or
// `acme-staging-v02.api.letsencrypt.org-directory` or `acme.zerossl.
// com-v2-DV90`. A site can have entries under multiple issuer dirs
// during a staging→prod cutover or an ACME provider migration —
// resolveCertDir() picks the directory whose .crt has the most
// recent mtime and surfaces the issuer name back to the caller so
// the UI / reconciler can show which one is actually live.
//
// Stat-only by design: this module never reads cert / key bytes.
// The only piece of the cert that ever leaves the host filesystem
// in this codebase is the directory path itself — which the
// cert-mount reconciler hands to `incus config device add` as the
// `source=` parameter. The .key inode is never opened by Node.

import { spawnHostSync } from './host-exec.js';

export const DEFAULT_CADDY_ACME_DIR =
  '/var/lib/caddy/.local/share/caddy';

// Default host-side fs adapter. Wraps a tiny set of stat/ls calls
// into spawnHostSync so the rest of the module is unaware of the
// nsenter pivot. Returning structured data here rather than parsing
// shell output downstream keeps the test seam narrow — unit tests
// can pass a fake `fs` with the same shape and never need to mock
// child_process.
function defaultFs() {
  return {
    listDir(path) {
      const r = spawnHostSync(
        'sh',
        ['-c', `ls -1 -- ${shellQuote(path)} 2>/dev/null`],
        { encoding: 'utf-8', timeout: 5_000 }
      );
      if (r.status !== 0) return [];
      return (r.stdout || '')
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
    },
    statFile(path) {
      // %Y = mtime as unix-epoch seconds. We only need an ordering
      // key + an existence test; further metadata would just add
      // surface area for the .key bytes to leak through (they
      // wouldn't, %Y can't carry content, but the rule is to keep
      // this module's shell calls trivially auditable).
      const r = spawnHostSync(
        'sh',
        [
          '-c',
          `stat -c '%Y' -- ${shellQuote(path)} 2>/dev/null`,
        ],
        { encoding: 'utf-8', timeout: 5_000 }
      );
      if (r.status !== 0) return null;
      const n = parseInt((r.stdout || '').trim(), 10);
      if (!Number.isFinite(n)) return null;
      return { mtime: n * 1000 };
    },
  };
}

// Conservative single-quote wrapper. Caddy issuer dirs contain dots
// and dashes only, but hostnames are operator-supplied so we treat
// every path as untrusted and escape it the same way shell-quote.js
// does in the L4 reconciler. Inlined to avoid pulling shell-quote
// into a stat-only module.
function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

// Validate hostname before it's interpolated into a host path.
// Caddy only ever stores certs under a directory whose name is the
// SAN it was issued for, which by RFC 1035 is restricted to letters,
// digits, dots and hyphens (plus a leading * for wildcard certs).
// Anything else is either an injection attempt or a misconfigured
// service.domain — either way we refuse to walk it.
function isPlausibleHostname(h) {
  if (typeof h !== 'string' || h.length === 0 || h.length > 253) return false;
  return /^(\*\.)?[A-Za-z0-9._-]+$/.test(h);
}

/**
 * Resolve the on-disk cert directory for `hostname` under Caddy's
 * ACME data root.
 *
 * Returns:
 *   {
 *     dir,         absolute host path containing <host>.crt + .key
 *     issuer,      issuer dir name (e.g. acme-v02...)
 *     certFile,    absolute path of the .crt
 *     keyFile,     absolute path of the .key
 *     mtime,       Date of the .crt's last rotation
 *   }
 *   or null when no matching dir/files exist (HTTP-only service,
 *   ACME pending, mid-issuance, etc.).
 *
 * Tie-break across issuers: newest .crt mtime wins. Surfaces the
 * issuer name in the result so the caller can show which one is live.
 */
export function resolveCertDir(hostname, opts = {}) {
  if (!isPlausibleHostname(hostname)) return null;
  const base = opts.base || process.env.CADDY_ACME_DIR || DEFAULT_CADDY_ACME_DIR;
  const fs = opts.fs || defaultFs();
  const certsRoot = `${base}/certificates`;
  const issuers = fs.listDir(certsRoot);
  if (!issuers || issuers.length === 0) return null;

  let best = null;
  for (const issuer of issuers) {
    if (!issuer || issuer.startsWith('.')) continue;
    const hostDir = `${certsRoot}/${issuer}/${hostname}`;
    const certFile = `${hostDir}/${hostname}.crt`;
    const keyFile = `${hostDir}/${hostname}.key`;
    const certStat = fs.statFile(certFile);
    if (!certStat) continue;
    // .key must exist too — Caddy writes both atomically post-issue,
    // and a half-populated dir is the symptom of an in-flight ACME
    // run we shouldn't bind-mount yet.
    const keyStat = fs.statFile(keyFile);
    if (!keyStat) continue;
    const mtimeMs = certStat.mtime instanceof Date
      ? certStat.mtime.getTime()
      : certStat.mtime;
    if (!best || mtimeMs > best.mtimeMs) {
      best = {
        dir: hostDir,
        issuer,
        certFile,
        keyFile,
        certFilename: `${hostname}.crt`,
        keyFilename: `${hostname}.key`,
        mtime: new Date(mtimeMs),
        mtimeMs,
      };
    }
  }
  return best;
}
