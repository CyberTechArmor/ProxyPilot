// Mock2 EGRESS COMPLETENESS — pure decision layer (B.7). Native-free, unit-tested
// stub-first (risk R9). The AUDIT proved nothing correlated code that dials a
// host with a declared egress entry (the ADP2 `egress:` block stayed commented
// out). This discovers dialed hosts from source and checks each against the
// declared+approved egress and the integration manifest. Unknown dynamic
// destinations cannot silently pass.
//
// Terminology (risk R7): nothing here is named "agent".

export const EGRESS_CHECK_SCHEMA_VERSION = 1;

function isTestPath(path) {
  return /(^|\/)(tests?|__tests__)\//i.test(String(path)) || /\.(test|spec|contract)\.[a-z]+$/i.test(String(path));
}

// classifyHostString(host) → 'private' | 'public' | 'local'. RFC1918 + loopback
// + *.internal/.local/.lan are private/local; everything else is public.
export function classifyHostString(host) {
  const h = String(host || '').trim().toLowerCase().replace(/:\d+$/, '');
  if (!h) return 'public';
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.startsWith('127.')) return 'local';
  // RFC1918 + link-local + CGNAT.
  if (/^10\./.test(h)) return 'private';
  if (/^192\.168\./.test(h)) return 'private';
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return 'private';
  if (/^169\.254\./.test(h)) return 'private';
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h)) return 'private';
  if (/\.(internal|local|lan|intranet|corp)$/.test(h)) return 'private';
  return 'public';
}

// discoverDialedHosts(files) → [{ file, line, kind, host?, port?, configKey? }].
// kind: 'literal' (a URL/IP in source), 'env' (process.env.X used as a URL),
// 'config' (cfg.apiBaseUrl-style). Test paths are excluded (local contract-test
// endpoints are never deploy egress).
export function discoverDialedHosts(files = []) {
  const out = [];
  for (const f of files || []) {
    if (isTestPath(f.path)) continue;
    const lines = String(f.content || '').split('\n');
    lines.forEach((line, i) => {
      const ln = i + 1;
      // Literal URLs: scheme://host[:port]
      const urlRe = /\b([a-z][a-z0-9+.-]*):\/\/([A-Za-z0-9_.-]+)(?::(\d+))?/gi;
      let m;
      while ((m = urlRe.exec(line)) !== null) {
        const scheme = m[1].toLowerCase();
        if (scheme === 'file' || scheme === 'data') continue;
        const host = m[2];
        const port = m[3] ? Number(m[3]) : defaultPortForScheme(scheme);
        out.push({ file: f.path, line: ln, kind: 'literal', host, port, scheme });
      }
      // Bare IP:port literals (e.g. ldaps client url '10.0.0.5:636' already caught
      // above if it has a scheme; catch scheme-less host:port in createClient).
      const ipRe = /['"](\d{1,3}(?:\.\d{1,3}){3}):(\d+)['"]/g;
      while ((m = ipRe.exec(line)) !== null) {
        if (out.some((d) => d.line === ln && d.host === m[1])) continue;
        out.push({ file: f.path, line: ln, kind: 'literal', host: m[1], port: Number(m[2]) });
      }
      // env-sourced destination used in a dial: fetch(process.env.X) / url: process.env.X
      const envRe = /(?:fetch|request|get|createClient|connect)\s*\(\s*process\.env\.([A-Z0-9_]+)|url:\s*process\.env\.([A-Z0-9_]+)/g;
      while ((m = envRe.exec(line)) !== null) {
        out.push({ file: f.path, line: ln, kind: 'env', configKey: m[1] || m[2] });
      }
      // config-sourced destination: fetch(cfg.apiBaseUrl + …) / createClient({ url: cfg.x })
      const cfgRe = /(?:fetch|request|get|createClient|connect)\s*\(\s*(?:\{[^}]*url:\s*)?(?:cfg|config)\.([A-Za-z0-9_]+)/g;
      while ((m = cfgRe.exec(line)) !== null) {
        out.push({ file: f.path, line: ln, kind: 'config', configKey: m[1] });
      }
    });
  }
  return out;
}

function defaultPortForScheme(scheme) {
  switch (scheme) {
    case 'https': case 'ldaps': case 'wss': return 443;
    case 'http': case 'ws': return 80;
    case 'ldap': return 389;
    case 'postgres': case 'postgresql': return 5432;
    default: return null;
  }
}

function declaredCovers(declared, host, port) {
  return (declared || []).some((d) => String(d.host) === String(host) && (port == null || Number(d.port) === Number(port)));
}
function grantApproved(grants, host, port) {
  return (grants || []).some((g) => String(g.host) === String(host) && (port == null || Number(g.port) === Number(port)) && g.status === 'approved');
}
function manifestCoversKey(manifest, key) {
  return (manifest?.entries || []).some((e) => {
    const dkey = String(e.destination?.key || '');
    return dkey.split(/[\s+]+/).map((s) => s.trim()).filter(Boolean).includes(key)
      || dkey.includes(key);
  });
}

function note(kind, message) { return { kind, message, schema_version: EGRESS_CHECK_SCHEMA_VERSION }; }
function egFinding(kind, message) { return { kind, message, schema_version: EGRESS_CHECK_SCHEMA_VERSION }; }

// egressCompleteness({ discovered, declaredEgress, manifest, approvedGrants }) →
// { ok, findings, notes }. Three destination classes (B.7):
//   private/internal — must be declared AND admin-approved before deploy is healthy.
//   public — allowed per fence policy, noted.
//   local contract-test — never deploy egress (excluded at discovery).
export function egressCompleteness({ discovered = [], declaredEgress = [], manifest = { entries: [] }, approvedGrants = [] } = {}) {
  const findings = [];
  const notes = [];
  for (const d of discovered || []) {
    if (d.kind === 'literal') {
      const cls = classifyHostString(d.host);
      if (cls === 'local') continue; // never deploy egress
      if (cls === 'private') {
        if (!declaredCovers(declaredEgress, d.host, d.port)) {
          findings.push(egFinding('undeclared_private_egress',
            `${d.file}:${d.line} dials private/internal host ${d.host}${d.port ? ':' + d.port : ''} but mock2.yaml declares no matching egress entry. Declare it (host/port/protocol/reason) — an admin must approve it before deploy reports healthy.`));
        } else if (!grantApproved(approvedGrants, d.host, d.port)) {
          findings.push(egFinding('egress_grant_not_approved',
            `${d.file}:${d.line} dials private host ${d.host}${d.port ? ':' + d.port : ''}: declared but the egress grant is not yet admin-approved. The capability stays blocked until approved.`));
        }
      } else {
        notes.push(note('public_egress_noted', `${d.file}:${d.line} dials public host ${d.host}${d.port ? ':' + d.port : ''} — allowed per fence policy, noted.`));
      }
    } else if (d.kind === 'env' || d.kind === 'config') {
      // Dynamic destination: the host is not statically known, so the config key
      // it comes from must be declared — either as a manifest destination key or
      // (for a private host) a declared egress entry. Otherwise it cannot pass.
      const key = d.configKey;
      const coveredByManifest = manifestCoversKey(manifest, key);
      if (!coveredByManifest) {
        findings.push(egFinding('undeclared_dynamic_destination',
          `${d.file}:${d.line} dials a destination from ${d.kind === 'env' ? 'env var' : 'config'} "${key}" whose host cannot be resolved statically and is not declared by any integration manifest entry (destination.key) or egress policy. Declare the configuration source + egress classification — an unknown dynamic destination cannot silently pass.`));
      }
    }
  }
  return { ok: findings.length === 0, findings, notes, schema_version: EGRESS_CHECK_SCHEMA_VERSION };
}
