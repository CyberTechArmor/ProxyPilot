import { spawnSync } from 'node:child_process';

// Local copy of WG_INTERFACE (also exported from server.js). Duplicated
// rather than imported because server.js drags in better-sqlite3, and this
// module is intentionally db-free so it can be unit-tested in isolation.
const DEFAULT_IFACE = 'wg0';

/**
 * Parse `wg show <iface> dump` into a public-key keyed map. The dump format
 * (per `man wg`) is:
 *
 *   <iface-private-key> <iface-public-key> <listen-port> <fwmark>
 *   <peer-public-key> <preshared-key> <endpoint> <allowed-ips> \
 *     <latest-handshake> <transfer-rx> <transfer-tx> <persistent-keepalive>
 *
 * We drop the first (interface) line and key the rest by public key. All
 * timestamps are unix seconds; 0 means "no handshake yet".
 *
 * Tolerant by design: if `wg` isn't installed, the interface is down, or
 * permissions deny the dump, we return an empty map so `peer list` still
 * works on a fresh host that hasn't run `vpn enable` yet.
 */
const ONLINE_HANDSHAKE_WINDOW_SECONDS = 180;

export function dumpPeers(iface = DEFAULT_IFACE) {
  const r = spawnSync('wg', ['show', iface, 'dump'], { encoding: 'utf-8' });
  if (r.status !== 0) {
    return new Map();
  }
  const lines = (r.stdout ?? '').split('\n').filter(Boolean);
  // First line is the interface itself; subsequent lines are peers.
  const peerLines = lines.slice(1);
  const out = new Map();
  for (const line of peerLines) {
    const parts = line.split('\t');
    if (parts.length < 8) continue;
    const [publicKey, , endpoint, allowedIps, latestHandshake, rx, tx, keepalive] = parts;
    const handshakeTs = Number(latestHandshake);
    out.set(publicKey, {
      publicKey,
      endpoint: endpoint === '(none)' ? null : endpoint,
      allowedIps: allowedIps === '(none)' ? null : allowedIps,
      lastHandshakeAt: Number.isFinite(handshakeTs) && handshakeTs > 0
        ? new Date(handshakeTs * 1000).toISOString()
        : null,
      lastHandshakeUnix: Number.isFinite(handshakeTs) && handshakeTs > 0 ? handshakeTs : 0,
      rxBytes: Number(rx) || 0,
      txBytes: Number(tx) || 0,
      keepalive: keepalive === 'off' ? null : Number(keepalive) || null,
    });
  }
  return out;
}

export function isOnline(handshakeUnix, nowUnix = Math.floor(Date.now() / 1000)) {
  if (!handshakeUnix) return false;
  return nowUnix - handshakeUnix < ONLINE_HANDSHAKE_WINDOW_SECONDS;
}

export { ONLINE_HANDSHAKE_WINDOW_SECONDS };
