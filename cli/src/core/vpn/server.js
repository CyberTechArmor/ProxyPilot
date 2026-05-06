import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { getDb } from '../../db/index.js';
import { audit } from '../../db/audit.js';
import {
  enable as fwEnable,
  disable as fwDisable,
  setPort as fwSetPort,
  readState as fwReadState,
  writeState as fwWriteState,
  reconcile as fwReconcile,
} from '../firewall/index.js';

export const WG_CONFIG_DIR = '/etc/wireguard';
export const WG_CONFIG_FILE = path.join(WG_CONFIG_DIR, 'wg0.conf');
export const WG_SERVER_PRIVATE = path.join(WG_CONFIG_DIR, 'server_private.key');
export const WG_INTERFACE = 'wg0';

// Safe port range for the WireGuard listen port. The default Linux
// ephemeral pool is 32768-60999 and Incus L4 forwards on the host
// commonly carve 50000-60000 for WebRTC media (LiveKit / MEET / etc.).
// 49000-49999 sits below both — gives 1000 ports of headroom which
// is plenty (you only need one WG endpoint per host) and keeps the
// listen port reliably outside any media-range proxy device's bind.
//
// Older deployments default to 51820 (WireGuard's IANA-assigned
// port), which lives inside the typical WebRTC range. The startup
// auto-heal in the backend migrates those to 49000 on first boot
// after upgrade so MEET-style stacks stop racing the WG port.
export const WG_SAFE_PORT_MIN = 49000;
export const WG_SAFE_PORT_MAX = 49999;
export const WG_DEFAULT_PORT = WG_SAFE_PORT_MIN;
export const WG_DEFAULT_CIDR = '10.100.0.0/24';
export const WG_DEFAULT_DNS = '10.100.0.1';
export const WG_SERVER_IP = '10.100.0.1/24';

// 1280 is IPv6's minimum guaranteed MTU and clears every common
// encapsulation overhead stack (PPPoE, double-NAT, mobile carriers,
// Cloudflare Tunnel, Tailscale-over-WG) without fragmentation. The
// kernel default of 1420 silently fails on operator networks with
// non-standard path MTU; pinning a lower value once trades a bit of
// throughput for a config that just works. Operators with a known
// all-Ethernet path can override via PROXYPILOT_VPN_MTU.
export const WG_DEFAULT_MTU = 1280;
export const WG_MTU_MIN = 576;
export const WG_MTU_MAX = 9000;

export function isPortInSafeRange(port) {
  const n = Number(port);
  return Number.isInteger(n) && n >= WG_SAFE_PORT_MIN && n <= WG_SAFE_PORT_MAX;
}

/**
 * Read the configured MTU. Honors PROXYPILOT_VPN_MTU when it parses
 * to an integer in the 576-9000 range; falls back to WG_DEFAULT_MTU
 * (1280) otherwise. An invalid override is silently ignored rather
 * than thrown — startup paths (wg-quick, peer add) shouldn't fail
 * just because a stale shell var is exporting garbage.
 */
export function resolveMtu(override) {
  const raw = override ?? process.env.PROXYPILOT_VPN_MTU;
  if (raw === undefined || raw === null || raw === '') return WG_DEFAULT_MTU;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < WG_MTU_MIN || n > WG_MTU_MAX) return WG_DEFAULT_MTU;
  return n;
}

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf-8', ...opts });
}

/**
 * Pull a useful message out of a spawnSync result. When the binary is
 * missing (ENOENT) or the OS rejected the spawn, status is null and
 * stderr/stdout are undefined; calling .trim() on them throws a
 * confusing TypeError. This helper returns the first non-empty signal
 * available, falling back to the spawn error itself.
 */
function spawnError(result, fallback = 'unknown error') {
  const stderr = (result.stderr ?? '').trim();
  if (stderr) return stderr;
  const stdout = (result.stdout ?? '').trim();
  if (stdout) return stdout;
  if (result.error) return result.error.message;
  return fallback;
}

/**
 * Detect the host's default-route interface. We prefer `ip -j route` JSON
 * because it is unambiguous; if the JSON form is unavailable on this
 * host we fall back to parsing the human-readable form. Either way we
 * validate the result against the same regex the firewall renderer
 * uses so a junk value can never reach the nft ruleset.
 */
export function detectDefaultIface() {
  const j = run('ip', ['-j', 'route', 'show', 'default']);
  if (j.status === 0 && j.stdout.trim()) {
    try {
      const arr = JSON.parse(j.stdout);
      const dev = arr?.[0]?.dev;
      if (dev && /^[A-Za-z0-9_.-]{1,15}$/.test(dev)) return dev;
    } catch { /* fall through */ }
  }
  const t = run('ip', ['route', 'show', 'default']);
  if (t.status === 0) {
    const m = t.stdout.match(/\bdev\s+([A-Za-z0-9_.-]{1,15})\b/);
    if (m) return m[1];
  }
  throw new Error('could not detect default-route interface (`ip route show default` returned nothing)');
}

export function generateServerKeypair() {
  const priv = run('wg', ['genkey']);
  if (priv.status !== 0) {
    throw new Error(`wg genkey failed: ${spawnError(priv)}`);
  }
  const privateKey = (priv.stdout ?? '').trim();
  if (!privateKey) throw new Error('wg genkey produced no output');
  const pub = run('wg', ['pubkey'], { input: privateKey });
  if (pub.status !== 0) {
    throw new Error(`wg pubkey failed: ${spawnError(pub)}`);
  }
  const publicKey = (pub.stdout ?? '').trim();
  if (!publicKey) throw new Error('wg pubkey produced no output');
  return { private: privateKey, public: publicKey };
}

export function readVpnConfig() {
  const db = getDb();
  return db.prepare('SELECT * FROM vpn_config WHERE id = 1').get() ?? null;
}

function writeVpnConfig({ serverPublicKey, endpoint, listenPort, cidr, defaultIface, dns }) {
  const db = getDb();
  db.prepare(`
    INSERT INTO vpn_config (id, server_public_key, endpoint, listen_port, cidr, default_iface, dns)
    VALUES (1, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      server_public_key = excluded.server_public_key,
      endpoint          = excluded.endpoint,
      listen_port       = excluded.listen_port,
      cidr              = excluded.cidr,
      default_iface     = excluded.default_iface,
      dns               = excluded.dns
  `).run(serverPublicKey, endpoint, listenPort, cidr, defaultIface, dns);
}

export function readEnabledPeers() {
  const db = getDb();
  return db.prepare(`
    SELECT id, name, public_key, allowed_ip, preshared_key_hash
    FROM vpn_peers
    WHERE status = 'enabled'
    ORDER BY id
  `).all();
}

/**
 * Render `/etc/wireguard/wg0.conf`. Deterministic: identical state →
 * identical bytes. No PostUp/PostDown — NAT is emitted by the firewall
 * manager into proxypilot.nat_postrouting.
 */
export function renderWg0Conf({ privateKey, listenPort, serverIp, peers, mtu }) {
  const m = resolveMtu(mtu);
  const lines = [
    '# Generated by ProxyPilot VPN manager. Do not edit by hand.',
    '# NAT/forwarding live in nft table inet proxypilot, chain nat_postrouting.',
    '[Interface]',
    `Address = ${serverIp}`,
    `MTU = ${m}`,
    `ListenPort = ${listenPort}`,
    `PrivateKey = ${privateKey}`,
  ];
  for (const p of peers) {
    lines.push('', `# ${p.name}`, '[Peer]', `PublicKey = ${p.public_key}`, `AllowedIPs = ${p.allowed_ip}/32`);
  }
  return lines.join('\n') + '\n';
}

export function atomicWrite(filePath, content, mode = 0o600) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  // flag 'wx' fails if a stale tmp from a crashed prior run exists, so
  // we never inherit unexpected perms. Then chmod explicitly: the mode
  // arg of writeFileSync only applies on file *create* and respects
  // umask, so chmod is the only way to guarantee the bits we asked for.
  fs.writeFileSync(tmp, content, { mode, flag: 'wx' });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, filePath);
}

export function writeWg0Conf({ privateKey, listenPort, serverIp, peers, mtu }) {
  const body = renderWg0Conf({ privateKey, listenPort, serverIp, peers, mtu });
  atomicWrite(WG_CONFIG_FILE, body, 0o600);
}

/**
 * Hot-apply the on-disk wg0.conf onto the live interface without bouncing
 * it. The canonical idiom is `wg syncconf wg0 <(wg-quick strip wg0)` —
 * `wg-quick strip` drops the [Interface] PostUp/PostDown lines that wg
 * proper rejects, and process substitution feeds the result as a file.
 *
 * Process substitution is a bash feature, so we invoke bash explicitly
 * rather than relying on the system /bin/sh (Debian's dash, for one,
 * does not support it). The wg0.conf path is hard-coded and quoted; no
 * caller-supplied data ever lands on the command line.
 *
 * Tolerates "interface not up" with a clear error so the caller can
 * decide whether to surface it (e.g. peer add when wg0 hasn't been
 * brought up yet should fail loudly; peer disable during teardown
 * shouldn't).
 */
export function syncconfWg0() {
  const r = run('bash', [
    '-c',
    `wg syncconf "${WG_INTERFACE}" <(wg-quick strip "${WG_INTERFACE}")`,
  ]);
  if (r.status !== 0) {
    throw new Error(`wg syncconf ${WG_INTERFACE} failed: ${spawnError(r)}`);
  }
}

/**
 * Evict a peer from the live interface immediately. wg syncconf already
 * removes peers absent from the new config, but on disable we want the
 * eviction to land even if the operator skips a follow-up syncconf.
 * No-op (returns false) if wg can't talk to the interface.
 */
export function wgPeerRemove(publicKey) {
  if (!publicKey || typeof publicKey !== 'string') {
    throw new Error('wgPeerRemove: publicKey required');
  }
  const r = run('wg', ['set', WG_INTERFACE, 'peer', publicKey, 'remove']);
  return r.status === 0;
}

function setNatIface(iface) {
  const state = fwReadState();
  state.nat = { ...(state.nat ?? {}), vpn_masquerade_iface: iface };
  fwWriteState(state);
}

function clearNatIface() {
  const state = fwReadState();
  if (state.nat?.vpn_masquerade_iface) {
    delete state.nat.vpn_masquerade_iface;
    if (Object.keys(state.nat).length === 0) delete state.nat;
    fwWriteState(state);
  }
}

/**
 * Validate a peer-dialable endpoint string. We accept "<host>:<port>"
 * where host is a DNS name, IPv4 literal, or bracketed IPv6 literal,
 * and port is 1-65535. Reject anything that could surprise the
 * operator at peer-config-render time (step 6) — better to fail at
 * `vpn enable` than to ship a broken QR code.
 */
export function validateEndpoint(endpoint) {
  if (typeof endpoint !== 'string' || endpoint.length === 0 || endpoint.length > 253) {
    throw new Error(`invalid --endpoint: must be host:port`);
  }
  const m = endpoint.match(/^(?:\[([0-9a-fA-F:]+)\]|([A-Za-z0-9.-]+)):(\d{1,5})$/);
  if (!m) throw new Error(`invalid --endpoint "${endpoint}": expected host:port (IPv6 in brackets)`);
  const port = Number(m[3]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid --endpoint "${endpoint}": port out of range`);
  }
  return { host: m[1] ?? m[2], port };
}

function validateListenPort(p) {
  const n = Number(p);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`invalid --port "${p}": expected integer 1-65535`);
  }
  return n;
}

/**
 * Bring up the VPN. Reuses the existing private key if `vpn_config`
 * + the on-disk private key are both present, so re-running enable is
 * idempotent and never silently rotates the server key. If vpn_config
 * is present but the private key file is missing we refuse rather than
 * generate a new keypair — that would invalidate every peer's client
 * config, and the operator probably wants to know the key was lost.
 *
 * Order matters here: write config + start the interface BEFORE
 * touching the firewall. If wg-quick fails we abort without ever
 * having advertised an open port; the operator's previous state is
 * untouched.
 */
export async function enable({ endpoint, listenPort = WG_DEFAULT_PORT, dns = WG_DEFAULT_DNS, actor } = {}) {
  if (!endpoint) throw new Error('endpoint is required (host:port the peer dials)');
  validateEndpoint(endpoint);
  listenPort = validateListenPort(listenPort);
  const existing = readVpnConfig();
  const iface = detectDefaultIface();

  let privateKey;
  let publicKey;
  if (existing) {
    if (!fs.existsSync(WG_SERVER_PRIVATE)) {
      throw new Error(
        `vpn_config row exists but ${WG_SERVER_PRIVATE} is missing. ` +
        `Refusing to silently rotate the server key (would invalidate every peer). ` +
        `Restore the key file from backup, or run \`proxypilot vpn disable\` and re-enable to start fresh.`,
      );
    }
    privateKey = fs.readFileSync(WG_SERVER_PRIVATE, 'utf-8').trim();
    publicKey = existing.server_public_key;
  } else {
    const kp = generateServerKeypair();
    privateKey = kp.private;
    publicKey = kp.public;
    if (!fs.existsSync(WG_CONFIG_DIR)) fs.mkdirSync(WG_CONFIG_DIR, { recursive: true, mode: 0o700 });
    atomicWrite(WG_SERVER_PRIVATE, privateKey + '\n', 0o600);
  }

  writeVpnConfig({
    serverPublicKey: publicKey,
    endpoint,
    listenPort,
    cidr: WG_DEFAULT_CIDR,
    defaultIface: iface,
    dns,
  });

  const peers = readEnabledPeers();
  writeWg0Conf({ privateKey, listenPort, serverIp: WG_SERVER_IP, peers });

  // enable for boot-persistence + restart to re-read wg0.conf (covers
  // both the cold-start and the "operator changed --port" cases).
  const en = run('systemctl', ['enable', `wg-quick@${WG_INTERFACE}`]);
  if (en.status !== 0) {
    throw new Error(`failed to enable wg-quick@${WG_INTERFACE}: ${spawnError(en)}`);
  }
  const up = run('systemctl', ['restart', `wg-quick@${WG_INTERFACE}`]);
  if (up.status !== 0) {
    throw new Error(`failed to start wg-quick@${WG_INTERFACE}: ${spawnError(up)}`);
  }

  fwEnable({ id: 'base-wireguard', actor });
  setNatIface(iface);
  const r = await fwReconcile({ actor });
  if (!r.ok) {
    throw new Error(`firewall reconcile failed: ${JSON.stringify(r.rejection)}`);
  }

  audit({
    subsystem: 'vpn',
    action: 'enable',
    resource: WG_INTERFACE,
    actor,
    after: { endpoint, listen_port: listenPort, default_iface: iface, public_key: publicKey },
  });

  return { endpoint, listenPort, defaultIface: iface, publicKey };
}

/**
 * Change the WireGuard listen port in place.
 *
 * Re-uses everything else (server keypair, peers, CIDR, default
 * iface) and just rewrites wg0.conf with the new ListenPort, restarts
 * wg-quick@wg0 to bind it, then re-reconciles the firewall so the
 * `base-wireguard` allow rule moves to the new port too. The endpoint
 * string is also rewritten — the host part is preserved, only the
 * `:port` suffix changes. Existing peer client configs use the
 * endpoint string verbatim, so re-rendering each peer (downloading
 * a fresh config / regenerating QR) picks up the new port without a
 * key rotation.
 *
 * Refuses to act when:
 *   - The new port is outside WG_SAFE_PORT_MIN..MAX. Operators who
 *     really need WG outside the safe range should call enable()
 *     directly with --port; this function is the dashboard-driven
 *     happy path and pins to the safe range to keep the UI from
 *     reintroducing the WebRTC-conflict footgun.
 *   - vpn_config is missing. Without an existing config there's no
 *     keypair, no endpoint, no peers — the operator wants `enable`,
 *     not a port change.
 *   - The on-disk private key is missing. Same reasoning as enable():
 *     refuse to silently rotate the server key.
 *
 * No-op when the new port equals the current port.
 */
export async function setListenPort({ port, actor } = {}) {
  const n = validateListenPort(port);
  if (!isPortInSafeRange(n)) {
    throw new Error(
      `port ${n} is outside the safe range ${WG_SAFE_PORT_MIN}-${WG_SAFE_PORT_MAX}. ` +
      `Reserved to stay clear of the kernel ephemeral pool and the typical WebRTC media range. ` +
      `Use \`vpn enable --port <p>\` directly if you need an unsafe port.`
    );
  }
  const cfg = readVpnConfig();
  if (!cfg) {
    throw new Error('vpn_config is missing — run `vpn enable` first');
  }

  // If the port matches AND the base-wireguard firewall rule is
  // already aligned, this is a true no-op. But if the rule's
  // port_start drifted (e.g. earlier setListenPort ran before the
  // setPort fix landed, leaving the rule at the old port and silently
  // dropping every handshake), we need to re-align even though the
  // listen_port column hasn't moved.
  const fwState = fwReadState();
  const wgRule = (fwState.base ?? []).find((r) => r.id === 'base-wireguard');
  const ruleAligned = wgRule && wgRule.port_start === n;
  if (n === cfg.listen_port && ruleAligned) {
    return { ok: true, listen_port: n, endpoint: cfg.endpoint, unchanged: true };
  }

  // Listen port already correct but the firewall rule drifted. Don't
  // restart wg-quick — just realign the rule + reconcile. This is the
  // recovery path for hosts where a previous setListenPort moved the
  // listen port without moving the rule (the bug we just fixed).
  if (n === cfg.listen_port && !ruleAligned) {
    try {
      fwSetPort({ id: 'base-wireguard', port: n, actor });
    } catch (e) {
      if (e.code !== 'NOT_FOUND') throw e;
    }
    const r = await fwReconcile({ actor });
    if (!r.ok) {
      throw new Error(`firewall reconcile failed during rule realign: ${JSON.stringify(r.rejection)}`);
    }
    audit({
      subsystem: 'vpn',
      action: 'realign-firewall-rule',
      resource: WG_INTERFACE,
      actor,
      before: { base_wireguard_port: wgRule ? wgRule.port_start : null },
      after: { base_wireguard_port: n },
    });
    return { ok: true, listen_port: n, endpoint: cfg.endpoint, realigned: true };
  }

  if (!fs.existsSync(WG_SERVER_PRIVATE)) {
    throw new Error(
      `${WG_SERVER_PRIVATE} is missing — refusing to silently rotate the server key. ` +
      `Restore it from backup or run \`vpn disable && vpn enable\` to start fresh.`
    );
  }

  // Rewrite the endpoint's port suffix. The validator already
  // enforced the host:port shape on enable — splitting on the LAST
  // ":" handles bracketed IPv6 literals correctly without re-parsing.
  const lastColon = cfg.endpoint.lastIndexOf(':');
  const newEndpoint = lastColon >= 0
    ? `${cfg.endpoint.slice(0, lastColon)}:${n}`
    : `${cfg.endpoint}:${n}`;

  const before = { listen_port: cfg.listen_port, endpoint: cfg.endpoint };
  const privateKey = fs.readFileSync(WG_SERVER_PRIVATE, 'utf-8').trim();
  const peers = readEnabledPeers();

  writeVpnConfig({
    serverPublicKey: cfg.server_public_key,
    endpoint: newEndpoint,
    listenPort: n,
    cidr: cfg.cidr,
    defaultIface: cfg.default_iface,
    dns: cfg.dns,
  });
  writeWg0Conf({ privateKey, listenPort: n, serverIp: WG_SERVER_IP, peers });

  // Full restart — wg syncconf would re-bind peer state but won't
  // change the listen port on a running interface. Only an actual
  // socket re-bind moves it.
  const up = run('systemctl', ['restart', `wg-quick@${WG_INTERFACE}`]);
  if (up.status !== 0) {
    throw new Error(`failed to restart wg-quick@${WG_INTERFACE} on new port: ${spawnError(up)}`);
  }

  // Move the base-wireguard firewall rule's port to match. Without
  // this, the reconcile below would re-emit `udp dport <old>` and
  // every WG handshake on the new port would be silently dropped at
  // the host edge — exactly the symptom that bit prod (vpn-only SSH
  // also stuck because WG never came up). setPort tolerates the rule
  // not being present yet (NOT_FOUND); enable() below ensures it.
  try {
    fwSetPort({ id: 'base-wireguard', port: n, actor });
  } catch (e) {
    if (e.code !== 'NOT_FOUND') throw e;
  }

  const r = await fwReconcile({ actor });
  if (!r.ok) {
    throw new Error(`firewall reconcile failed after port change: ${JSON.stringify(r.rejection)}`);
  }

  audit({
    subsystem: 'vpn',
    action: 'set-listen-port',
    resource: WG_INTERFACE,
    actor,
    before,
    after: { listen_port: n, endpoint: newEndpoint },
  });
  return { ok: true, listen_port: n, endpoint: newEndpoint, unchanged: false };
}

/**
 * Bring the VPN down without losing state. Peer rows, IP allocations,
 * the server keypair, and the SQLite vpn_config row are all preserved
 * — only the live interface, the base allowlist toggle, and the NAT
 * field are reverted. Reverse of `enable` so a follow-up `enable`
 * comes back up identically.
 */
export async function disable({ actor } = {}) {
  // Bail early if the VPN was never enabled. Without this short-circuit
  // we'd fight wg-quick over a non-existent unit, churn the
  // base-wireguard rule timestamps, and emit a confusing audit row for
  // a no-op. Operators running `vpn disable` on a fresh host is a
  // common "is it off?" sanity-check; treat it as a success.
  if (!readVpnConfig()) {
    return { ok: true, alreadyDisabled: true };
  }

  const down = run('systemctl', ['disable', '--now', `wg-quick@${WG_INTERFACE}`]);
  // Tolerate "Unit is not loaded" / already-down: surface only hard failures.
  if (down.status !== 0 && !/not loaded|not found/i.test(down.stderr || '')) {
    throw new Error(`failed to stop wg-quick@${WG_INTERFACE}: ${spawnError(down)}`);
  }

  try { fwDisable({ id: 'base-wireguard', actor }); } catch (e) {
    if (e.code !== 'NOT_FOUND') throw e;
  }
  clearNatIface();
  const r = await fwReconcile({ actor });
  if (!r.ok) {
    throw new Error(`firewall reconcile failed: ${JSON.stringify(r.rejection)}`);
  }

  audit({ subsystem: 'vpn', action: 'disable', resource: WG_INTERFACE, actor });
  return { ok: true };
}
