// Mock2 egress visibility (Phase M4 → post-squid).
//
// Squid — the old host-side filtering proxy that enforced a per-project hostname
// allowlist and was the container's only egress path (ADR-010) — has been
// removed: it was unreliable (a single bad squid.conf line failed every
// provision) and heavier than the guardrail allowed. Each project bridge now
// reaches the internet directly through its own Incus NAT, and the nftables
// fence (network-logic.renderMock2Nft) LOGS every new outbound connection to the
// kernel log while still blocking lateral movement to private ranges.
//
// This module is now read-only: it turns that kernel egress log into the "what
// did this container reach" view the UI shows. There is no host daemon to
// install, configure, or keep alive — so the whole class of squid failures is
// gone. reconcileMock2Egress() is kept as a no-op so existing callers (boot,
// provision, routes) need no change; the actual egress policy is entirely in the
// nftables fence (firewall.js).
//
// The parser (parseNftEgressLog) is PURE (unit-tested stub-first, risk R9); the
// log read shells to the host (mock2/host.js, risk R3).
//
// Terminology (risk R7): nothing here is named "agent".

import { sh } from './host.js';
import { subnetPrefixForCidr, parseNftEgressLog } from './network-logic.js';

// reconcileMock2Egress() — no-op retained for call-site compatibility. Egress
// policy + logging live entirely in the nftables fence now (reconciled by
// reconcileMock2Firewall), so there is nothing host-side to regenerate here.
export async function reconcileMock2Egress() {
  return { ok: true, noop: true };
}

// readEgressLog(cidr, { limit }) — a project's recent egress as the FIREWALL saw
// it. Reads a bounded tail of the kernel log (where the nftables `log` rules
// write) and keeps only the rows whose source IP is in the project's /24. The
// firewall sees IP:port, not hostnames — so entries show the destination address,
// not a URL. Read-only + best-effort: on a host without journald/dmesg access it
// returns an empty list rather than throwing, so the UI degrades gracefully.
export async function readEgressLog(cidr, { limit = 200 } = {}) {
  const prefix = subnetPrefixForCidr(cidr);
  if (!prefix) return { ok: false, error: 'bad cidr', entries: [] };
  // Prefer journald (short-unix keeps a timestamp we can surface); fall back to
  // dmesg, then the classic kern.log. grep our prefixes so we tail only egress
  // lines even out of a large kernel log.
  const cmd = "journalctl -k -n 5000 --no-pager -o short-unix 2>/dev/null | grep -E 'mock2-egress-(ok|deny)' "
    + "|| dmesg 2>/dev/null | grep -E 'mock2-egress-(ok|deny)' "
    + "|| grep -E 'mock2-egress-(ok|deny)' /var/log/kern.log 2>/dev/null "
    + "|| true";
  const r = await sh(cmd, { timeoutMs: 12000 });
  const entries = parseNftEgressLog(r.stdout || '', prefix, limit);
  return { ok: true, source: 'nftables', entries };
}
