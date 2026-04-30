import { listPeers } from '../../core/vpn/index.js';
import * as output from '../../output.js';

function fmtBytes(n) {
  if (!n) return '0';
  const u = ['B', 'K', 'M', 'G', 'T'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return v >= 100 ? `${v.toFixed(0)}${u[i]}` : `${v.toFixed(1)}${u[i]}`;
}

function fmtHandshake(iso, online) {
  if (!iso) return 'never';
  const ageSec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (online) return `${ageSec}s ago`;
  if (ageSec < 60) return `${ageSec}s ago`;
  if (ageSec < 3600) return `${Math.floor(ageSec / 60)}m ago`;
  if (ageSec < 86400) return `${Math.floor(ageSec / 3600)}h ago`;
  return `${Math.floor(ageSec / 86400)}d ago`;
}

export async function peerListCommand(_opts, globalOpts) {
  try {
    const peers = listPeers();
    if (globalOpts.json) {
      output.json({ ok: true, peers });
      return;
    }
    if (peers.length === 0) {
      output.info('no VPN peers configured (use `proxypilot vpn peer add <name>`)');
      return;
    }
    const rows = peers.map(p => [
      p.name,
      p.ip,
      p.scope + (p.services ? `(${p.services.join(',')})` : ''),
      p.status,
      p.online ? 'yes' : 'no',
      fmtHandshake(p.lastHandshakeAt, p.online),
      fmtBytes(p.rxBytes),
      fmtBytes(p.txBytes),
    ]);
    output.table(
      ['NAME', 'IP', 'SCOPE', 'STATUS', 'ONLINE', 'HANDSHAKE', 'RX', 'TX'],
      rows,
    );
  } catch (e) {
    if (globalOpts.json) {
      output.json({ ok: false, error: e.message });
      process.exitCode = 1;
      return;
    }
    output.error(`vpn peer list failed: ${e.message}`);
    process.exitCode = 1;
  }
}
