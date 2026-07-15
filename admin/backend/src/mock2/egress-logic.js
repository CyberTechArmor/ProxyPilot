// Declared, admin-approved outbound egress — the PURE decision layer.
//
// The same "declared, never discovered" discipline as ports (ADR-005), extended
// to egress: an app declares the internal hosts it must reach in mock2.yaml
// `egress:`; each entry becomes a grant that an admin must approve; only approved
// grants are wired into the project's nftables fence. Nothing is inferred, and
// anything not declared+approved stays blocked.
//
// This module imports NOTHING native — parsing, validation, and the nft rule
// rendering are all here so they unit-test at the module boundary. The DB store
// (egress-grants.js), the deploy/reconcile wiring (firewall.js / runner.js), and
// the host-reachability probe (network.js) live in the host-acting shells.

// The kernel-log prefix for an ALLOWED grant connection — distinct from the
// deny (policy-blocked) and ok (general internet) prefixes so the firewall log
// tells apart "blocked by policy" from "allowed" (a failed allowed connection is
// then host-down, not policy). Kept short (the kernel truncates long prefixes).
export const EGRESS_LOG_PREFIX_GRANT = 'mock2-egress-grant';

const PROTOCOLS = { tcp: 'tcp', udp: 'udp', tls: 'tcp', ldaps: 'tcp', https: 'tcp', ldap: 'tcp', http: 'tcp' };

export function normalizeProtocol(p) {
  const s = String(p || 'tcp').trim().toLowerCase();
  return PROTOCOLS[s] || (s === '' ? 'tcp' : null);
}

export function isIpv4(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(host || '').trim());
  if (!m) return false;
  return m.slice(1).every((o) => Number(o) >= 0 && Number(o) <= 255);
}

// A declared host is either an IPv4 literal or an RFC-1123 hostname. Hostnames
// are resolved to IP(s) at wire time; IPs go straight into the rule. Rejects a
// scheme, path, port, whitespace, or anything that could break an nft rule.
export function isEgressHost(host) {
  const h = String(host || '').trim().toLowerCase();
  if (!h || h.length > 253) return false;
  if (isIpv4(h)) return true;
  return /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(h);
}

export function isEgressPort(port) {
  const n = Number(port);
  return Number.isInteger(n) && n >= 1 && n <= 65535;
}

// Stable identity for a declared/stored grant (dedupe + diff declared vs stored).
export function grantKey(g) {
  return `${String(g.host || '').trim().toLowerCase()}|${Number(g.port)}|${normalizeProtocol(g.protocol) || 'tcp'}`;
}

// validateOperatorEgressInput({ host, port, protocol }) — an operator-initiated
// grant is admin-typed, so validate it with the SAME discipline a mock2.yaml
// declaration gets before it ever reaches the fence renderer. Pure.
export function validateOperatorEgressInput({ host, port, protocol = 'tcp' } = {}) {
  const proto = normalizeProtocol(protocol);
  if (!isEgressHost(host)) return { ok: false, error: 'host must be an IPv4 literal or a valid hostname (no scheme, path, or port).' };
  if (!isEgressPort(port)) return { ok: false, error: 'port must be an integer in 1–65535.' };
  if (!proto) return { ok: false, error: 'protocol must be tcp or udp.' };
  return { ok: true, host: String(host).trim().toLowerCase(), port: Number(port), protocol: proto };
}

function stripQuotes(v) {
  const s = String(v ?? '').trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
  return s;
}

// parseDeclaredEgress(yamlText) — read the `egress:` list-of-maps from mock2.yaml
// (dependency-free, like parseRunContract). Each entry is { host, port, protocol,
// reason }. Tolerant of the two YAML list forms:
//   egress:
//     - host: 10.0.0.5
//       port: 636
//       protocol: tcp
//       reason: LDAPS directory
// Invalid entries (bad host/port/protocol) are dropped, never guessed. Returns []
// when there is no egress block.
export function parseDeclaredEgress(yamlText) {
  const lines = String(yamlText || '').split(/\r?\n/);
  let inEgress = false;
  const raws = [];
  let cur = null;
  const flush = () => { if (cur) { raws.push(cur); cur = null; } };
  for (const line of lines) {
    if (/^egress:\s*(#.*)?$/.test(line)) { inEgress = true; continue; }
    if (!inEgress) continue;
    if (/^\S/.test(line)) break;          // a non-indented line ends the block
    if (line.trim() === '' || /^\s*#/.test(line)) continue;
    const dash = line.match(/^\s*-\s*(.*)$/);
    if (dash) {
      flush();
      cur = {};
      const kv = dash[1].match(/^([a-zA-Z_]+):\s*(.*)$/);
      if (kv) cur[kv[1].toLowerCase()] = stripQuotes(kv[2]);
      continue;
    }
    const kv = line.match(/^\s+([a-zA-Z_]+):\s*(.*)$/);
    if (kv && cur) cur[kv[1].toLowerCase()] = stripQuotes(kv[2]);
  }
  flush();

  const out = [];
  const seen = new Set();
  for (const e of raws) {
    const host = String(e.host || '').trim();
    const port = Number(e.port);
    const protocol = normalizeProtocol(e.protocol);
    if (!isEgressHost(host) || !isEgressPort(port) || !protocol) continue;
    const g = { host: host.toLowerCase(), port, protocol, reason: String(e.reason || '').trim() };
    const k = grantKey(g);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(g);
  }
  return out;
}

// publicEgressGrantShape(row) — the API view of a stored grant. `reachable` is
// the host-reachability probe result (ok/refused/timeout/unreachable/dns_fail or
// null before a probe) so the UI can show whether the HOST can even route to the
// destination — the acceptance-#5 "is it policy or host-down?" signal.
export function publicEgressGrantShape(row) {
  if (!row) return null;
  return {
    id: row.id,
    project_id: row.project_id,
    host: row.host,
    port: row.port,
    protocol: row.protocol,
    reason: row.reason || '',
    status: row.status,
    reachable: row.reachable || null,
    requested_at: row.requested_at || null,
    decided_by: row.decided_by || null,
    decided_at: row.decided_at || null,
  };
}

// renderEgressGrantRules(cidr, projectId, grants) — the forward-chain nft lines
// for a project's APPROVED grants. Placed BEFORE the private-range block so a
// grant to an internal host is allowed while everything else internal stays
// blocked. Each grant is logged with the grant prefix (allowed, distinct from the
// policy-deny log). `grants` carry a resolved `ip` (== host for an IP literal);
// grants without a usable ip are skipped. Pure + safe (values pre-validated).
export function renderEgressGrantRules(cidr, projectId, grants = []) {
  const out = [];
  for (const g of grants) {
    const ip = String(g.ip || (isIpv4(g.host) ? g.host : '')).trim();
    const proto = normalizeProtocol(g.protocol);
    if (!ip || !isIpv4(ip) || !proto || !isEgressPort(g.port)) continue;
    const tag = `mock2 p${projectId} egress-grant`;
    out.push(`    ip saddr ${cidr} ip daddr ${ip} ${proto} dport ${g.port} ct state new log prefix "${EGRESS_LOG_PREFIX_GRANT} p${projectId}: " comment "${tag}-log"`);
    out.push(`    ip saddr ${cidr} ip daddr ${ip} ${proto} dport ${g.port} accept comment "${tag}"`);
  }
  return out;
}
