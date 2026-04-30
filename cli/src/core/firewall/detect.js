import { spawnSync } from 'node:child_process';

/**
 * Detect the host's managed Incus bridge. Returns
 * `{ iface, cidr, gw }` for the first managed bridge whose
 * `config['ipv4.address']` is set, or `null` if Incus is unavailable
 * or no managed bridge has IPv4 configured.
 *
 * Why query Incus rather than reading `ip -j addr`: Incus is the
 * source of truth for the LXC bridge ProxyPilot uses. Reading `ip
 * addr` would also surface unrelated Linux bridges (Docker's
 * `docker0`, libvirt's `virbr0`) that ProxyPilot isn't responsible
 * for. Only managed Incus bridges are candidates.
 *
 * Tolerant on failure: if `incus` isn't on PATH (fresh install
 * before `install-incus.sh` runs), the daemon isn't up yet, or no
 * managed bridge exists, return null. Callers decide whether absence
 * is a hard error.
 */
export function detectBridge() {
  const r = spawnSync('incus', ['network', 'list', '--format', 'json'], { encoding: 'utf-8' });
  if (r.status !== 0) return null;

  let entries;
  try {
    entries = JSON.parse(r.stdout || '[]');
  } catch {
    return null;
  }
  if (!Array.isArray(entries)) return null;

  // Sort by name so two operators inspecting the same host get the
  // same answer (Incus's list order is implementation-defined).
  const candidates = entries
    .filter(e => e?.type === 'bridge' && e?.managed === true)
    .filter(e => typeof e?.config?.['ipv4.address'] === 'string' && e.config['ipv4.address'] !== 'none')
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));

  if (candidates.length === 0) return null;
  const e = candidates[0];

  const ipv4 = e.config['ipv4.address']; // e.g. "10.64.250.1/24"
  const m = ipv4.match(/^((?:\d{1,3}\.){3}\d{1,3})\/(\d|[12]\d|3[0-2])$/);
  if (!m) return null;
  const gw = m[1];
  const mask = Number(m[2]);
  const cidr = `${networkAddress(gw, mask)}/${mask}`;

  return {
    iface: String(e.name),
    cidr,
    gw,
    // Surface the rest so callers can warn the operator if multiple
    // managed bridges exist (we picked one — the operator may want
    // a different one).
    candidatesCount: candidates.length,
  };
}

function ipToInt(ip) {
  return ip.split('.').reduce((a, b) => (a << 8) + Number(b), 0) >>> 0;
}
function intToIp(n) {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join('.');
}
function networkAddress(addr, mask) {
  const m = mask === 0 ? 0 : ((~0 << (32 - mask)) >>> 0);
  return intToIp(ipToInt(addr) & m);
}
