import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { readDnsConfig, writeDnsConfig, startDnsServer, upstreamsFrom, VPN_DNS_FILE, VPN_DNS_ADDRESS } from '../../core/vpn/dns.js';
import * as output from '../../output.js';

// `vpn dns …` — the resolver VPN peers use (core/vpn/dns.js).
//   status                       names, extra domains, whether the unit is active
//   set [--managed a,b] [--extra c,d]   replace either list (the backend pushes
//                                the Full Platform hostnames as --managed; the
//                                operator's domains are --extra)
//   serve                        the daemon (proxypilot-vpn-dns.service)

const csv = (v) => (v === undefined ? undefined : String(v).split(',').map((s) => s.trim()).filter(Boolean));
const unitActive = () => { try { return spawnSync('systemctl', ['is-active', 'proxypilot-vpn-dns.service'], { encoding: 'utf8' }).stdout.trim(); } catch { return 'unknown'; } };

export async function dnsStatusCommand(_opts, globalOpts) {
  const cfg = readDnsConfig();
  const payload = { ok: true, address: VPN_DNS_ADDRESS, file: VPN_DNS_FILE, managed: cfg.managed, extra: cfg.extra, updated_at: cfg.updatedAt, service: unitActive() };
  if (globalOpts.json) return output.json(payload);
  output.info(`VPN DNS ${VPN_DNS_ADDRESS}:53 · service ${payload.service}`);
  output.info(`Managed (Full Platform): ${cfg.managed.join(', ') || '—'}`);
  output.info(`Extra: ${cfg.extra.join(', ') || '—'}`);
}

export async function dnsSetCommand(opts, globalOpts) {
  try {
    const next = writeDnsConfig({ managed: csv(opts.managed), extra: csv(opts.extra) });
    if (globalOpts.json) return output.json({ ok: true, managed: next.managed, extra: next.extra, updated_at: next.updatedAt });
    output.success(`VPN DNS names saved (${next.managed.length} managed, ${next.extra.length} extra). The running resolver picks them up within seconds.`);
  } catch (e) {
    if (globalOpts.json) { output.json({ ok: false, error: e.message }); process.exitCode = 1; return; }
    output.error(`vpn dns set failed: ${e.message}`); process.exitCode = 1;
  }
}

export async function dnsServeCommand(opts) {
  const address = opts.address || VPN_DNS_ADDRESS, port = Number(opts.port || 53);
  let entries = [], mtime = -1;
  const reload = () => {
    let m = 0; try { m = fs.statSync(VPN_DNS_FILE).mtimeMs; } catch { m = 0; }
    if (m === mtime) return;
    mtime = m; const cfg = readDnsConfig(); entries = [...cfg.managed, ...cfg.extra];
    console.log(`${new Date().toISOString()} vpn-dns: serving ${entries.length} name(s): ${entries.join(', ') || '(none)'}`);
  };
  let upstreams = [];
  const readUpstreams = () => { try { upstreams = upstreamsFrom(fs.readFileSync('/etc/resolv.conf', 'utf8'), { exclude: [address] }); } catch { upstreams = upstreamsFrom(''); } };
  reload(); readUpstreams();
  // Exits on a bind failure (wg0 not up yet): systemd restarts it until the address exists.
  const server = await startDnsServer({ address, port, names: () => entries, upstreams: () => upstreams, log: (...a) => console.error('vpn-dns:', ...a) });
  console.log(`${new Date().toISOString()} vpn-dns: listening on ${address}:${port} (udp+tcp); forwarding to ${upstreams.join(', ')}`);
  setInterval(() => { reload(); readUpstreams(); }, 5000).unref();
  const stop = () => server.close().then(() => process.exit(0));
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  await new Promise(() => {});
}
