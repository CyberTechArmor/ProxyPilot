import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { getDb } from '../../db/index.js';
import { audit } from '../../db/audit.js';
import {
  readVpnConfig,
  readEnabledPeers,
  writeWg0Conf,
  syncconfWg0,
  wgPeerRemove,
  atomicWrite,
  WG_SERVER_PRIVATE,
  WG_SERVER_IP,
} from './server.js';
import { dumpPeers, isOnline } from './status.js';

export const VPN_PEERS_DIR = '/var/lib/proxypilot/vpn-peers';
const POOL_START_SUFFIX = 10;
const POOL_END_SUFFIX = 254;
const POOL_PREFIX = '10.100.0';
const ACTIVE_HANDSHAKE_WINDOW_SEC = 24 * 60 * 60;
const PEER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;

function spawnError(r, fallback = 'unknown error') {
  const stderr = (r.stderr ?? '').trim();
  if (stderr) return stderr;
  const stdout = (r.stdout ?? '').trim();
  if (stdout) return stdout;
  if (r.error) return r.error.message;
  return fallback;
}

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf-8', ...opts });
}

export function validatePeerName(name) {
  if (!PEER_NAME_RE.test(name ?? '')) {
    throw new Error(
      `invalid peer name "${name}": must match ${PEER_NAME_RE} ` +
      `(letters/digits/dot/underscore/hyphen, max 63 chars, no leading punctuation)`,
    );
  }
  return name;
}

function validateScope(scope, services) {
  if (!['full', 'admin', 'services'].includes(scope)) {
    throw new Error(`invalid scope "${scope}": must be full|admin|services`);
  }
  if (scope === 'services') {
    if (!Array.isArray(services) || services.length === 0) {
      throw new Error('scope=services requires --services <list> (non-empty)');
    }
    for (const s of services) {
      if (!/^[A-Za-z0-9_.-]{1,64}$/.test(s)) {
        throw new Error(`invalid service name "${s}"`);
      }
    }
  } else if (services && services.length > 0) {
    throw new Error(`--services is only valid with --scope services`);
  }
}

function generatePeerKeypair() {
  const priv = run('wg', ['genkey']);
  if (priv.status !== 0) throw new Error(`wg genkey failed: ${spawnError(priv)}`);
  const privateKey = (priv.stdout ?? '').trim();
  if (!privateKey) throw new Error('wg genkey produced no output');
  const pub = run('wg', ['pubkey'], { input: privateKey });
  if (pub.status !== 0) throw new Error(`wg pubkey failed: ${spawnError(pub)}`);
  const publicKey = (pub.stdout ?? '').trim();
  if (!publicKey) throw new Error('wg pubkey produced no output');
  return { private: privateKey, public: publicKey };
}

/**
 * Lazy-seed the IP pool with 10.100.0.10–10.100.0.254 on first use, then
 * pick the lowest free /32 (unallocated, or previously-allocated and
 * since released). Returns the IP string. Caller is responsible for
 * setting peer_id once the peer row exists; this runs inside the same
 * transaction that inserts the peer.
 */
function seedPoolIfEmpty(db) {
  const count = db.prepare('SELECT COUNT(*) AS n FROM vpn_ip_pool').get().n;
  if (count > 0) return;
  const ins = db.prepare('INSERT INTO vpn_ip_pool (ip) VALUES (?)');
  for (let i = POOL_START_SUFFIX; i <= POOL_END_SUFFIX; i++) {
    ins.run(`${POOL_PREFIX}.${i}`);
  }
}

function pickFreeIp(db) {
  // Order by the trailing octet so we issue 10.100.0.10 before .100, .200,
  // etc. — matches operator intuition and keeps wg0.conf diffs readable.
  // The fixed offset (10) is safe because the pool is hard-coded to the
  // "10.100.0." prefix; if the CIDR ever changes we'll need to revisit.
  return db.prepare(`
    SELECT ip FROM vpn_ip_pool
    WHERE peer_id IS NULL OR released_at IS NOT NULL
    ORDER BY CAST(substr(ip, 10) AS INTEGER)
    LIMIT 1
  `).get();
}

function claimIp(db, ip, peerId) {
  db.prepare(`
    UPDATE vpn_ip_pool
    SET peer_id = ?, released_at = NULL
    WHERE ip = ?
  `).run(peerId, ip);
}

function releaseIp(db, ip) {
  db.prepare(`
    UPDATE vpn_ip_pool
    SET peer_id = NULL, released_at = datetime('now')
    WHERE ip = ?
  `).run(ip);
}

function readPeerByName(name) {
  return getDb()
    .prepare('SELECT * FROM vpn_peers WHERE name = ?')
    .get(name);
}

function regenerateWg0() {
  const cfg = readVpnConfig();
  if (!cfg) {
    throw new Error('vpn_config row missing — run `proxypilot vpn enable` first');
  }
  if (!fs.existsSync(WG_SERVER_PRIVATE)) {
    throw new Error(
      `${WG_SERVER_PRIVATE} missing — refusing to render wg0.conf without the server key`,
    );
  }
  const privateKey = fs.readFileSync(WG_SERVER_PRIVATE, 'utf-8').trim();
  const peers = readEnabledPeers();
  writeWg0Conf({
    privateKey,
    listenPort: cfg.listen_port,
    serverIp: WG_SERVER_IP,
    peers,
  });
  return { cfg, peers };
}

function allowedIpsFor(scope) {
  // `full` tunnels everything (default-route VPN). `admin` and `services`
  // route only the VPN subnet — the operator's regular internet stays
  // direct. Step 7 (peer scope) will enforce per-peer reachability inside
  // the VPN subnet via firewall rules; AllowedIPs here is the client's
  // routing table, not an authorization check.
  if (scope === 'full') return '0.0.0.0/0, ::/0';
  return '10.100.0.0/24';
}

function renderClientConfig({ peerPrivateKey, peerIp, scope, cfg }) {
  const lines = [
    '# Generated by ProxyPilot. Save this private key now — the server',
    '# never persisted it and cannot reprint it.',
    '[Interface]',
    `PrivateKey = ${peerPrivateKey}`,
    `Address = ${peerIp}/32`,
    `DNS = ${cfg.dns}`,
    '',
    '[Peer]',
    `PublicKey = ${cfg.server_public_key}`,
    `AllowedIPs = ${allowedIpsFor(scope)}`,
    `Endpoint = ${cfg.endpoint}`,
    'PersistentKeepalive = 25',
  ];
  return lines.join('\n') + '\n';
}

function clientConfigPath(name) {
  return path.join(VPN_PEERS_DIR, `${name}.conf`);
}

function chownToInvoker(filePath) {
  // When run via sudo, hand the file off to the operator who invoked us
  // so they can deliver it without an extra `chown`. Fail soft: on a
  // direct-root invocation (no SUDO_UID) we leave it root-owned.
  const uid = Number(process.env.SUDO_UID);
  const gid = Number(process.env.SUDO_GID);
  if (Number.isInteger(uid) && Number.isInteger(gid) && uid > 0) {
    try { fs.chownSync(filePath, uid, gid); } catch { /* best-effort */ }
  }
}

/**
 * Add a new peer. Generates a fresh keypair (private kept in memory only),
 * allocates the next free /32 from the pool, inserts the SQLite row,
 * re-renders + atomic-writes wg0.conf, hot-applies via `wg syncconf` so
 * existing handshakes survive, then writes the client config + QR.
 *
 * The peer's private key appears exactly twice: in the returned object
 * (so the CLI can print it to the operator's terminal) and inside the
 * client config file at /var/lib/proxypilot/vpn-peers/<name>.conf, mode
 * 0600. It never reaches SQLite or the audit log.
 */
export function addPeer({ name, scope = 'admin', services = null, actor } = {}) {
  validatePeerName(name);
  validateScope(scope, services);
  const cfg = readVpnConfig();
  if (!cfg) {
    throw new Error('VPN is not enabled — run `proxypilot vpn enable` first');
  }
  if (readPeerByName(name)) {
    throw new Error(`peer "${name}" already exists — use \`vpn peer rotate ${name}\` to issue new keys`);
  }

  const kp = generatePeerKeypair();
  const db = getDb();
  const tx = db.transaction(() => {
    seedPoolIfEmpty(db);
    const free = pickFreeIp(db);
    if (!free) {
      throw new Error('VPN IP pool exhausted (10.100.0.10–10.100.0.254 all in use)');
    }
    const ip = free.ip;
    const insert = db.prepare(`
      INSERT INTO vpn_peers (name, public_key, allowed_ip, scope, scope_services_json, status, created_by)
      VALUES (?, ?, ?, ?, ?, 'enabled', ?)
    `).run(
      name,
      kp.public,
      ip,
      scope,
      services ? JSON.stringify(services) : null,
      actor ?? null,
    );
    claimIp(db, ip, insert.lastInsertRowid);
    return { id: insert.lastInsertRowid, ip };
  });
  const { id, ip } = tx();

  // Re-render wg0.conf, write the client artifact, and audit BEFORE
  // hot-applying. That way a syncconf failure (wg0 manually stopped,
  // kernel module unloaded) leaves a recoverable state: the SQLite
  // row, wg0.conf, the client config file, and the audit trail are
  // all durable. The operator can fix wg0 with `systemctl restart
  // wg-quick@wg0` (which reads the already-updated wg0.conf) without
  // re-running `peer add` or losing the just-generated keypair.
  regenerateWg0();

  const confPath = clientConfigPath(name);
  const confBody = renderClientConfig({
    peerPrivateKey: kp.private,
    peerIp: ip,
    scope,
    cfg,
  });
  if (!fs.existsSync(VPN_PEERS_DIR)) {
    fs.mkdirSync(VPN_PEERS_DIR, { recursive: true, mode: 0o700 });
  }
  atomicWrite(confPath, confBody, 0o600);
  chownToInvoker(confPath);

  audit({
    subsystem: 'vpn',
    action: 'peer.add',
    resource: name,
    actor,
    after: { name, ip, scope, services: services ?? null, public_key: kp.public },
  });

  syncconfWg0();

  return {
    id,
    name,
    ip,
    scope,
    services: services ?? null,
    publicKey: kp.public,
    privateKey: kp.private,
    configBody: confBody,
    configPath: confPath,
  };
}

/**
 * Rotate an existing peer's keypair. Same shape as addPeer but reuses
 * the IP, scope, and services. The old key is invalidated the moment
 * `wg syncconf` runs — no overlap window. Used when a device is lost.
 */
export function rotatePeer({ name, actor } = {}) {
  validatePeerName(name);
  const cfg = readVpnConfig();
  if (!cfg) {
    throw new Error('VPN is not enabled — run `proxypilot vpn enable` first');
  }
  const peer = readPeerByName(name);
  if (!peer) throw new Error(`peer "${name}" not found`);

  const kp = generatePeerKeypair();
  const db = getDb();
  db.prepare(`
    UPDATE vpn_peers
    SET public_key = ?, rotated_at = datetime('now')
    WHERE id = ?
  `).run(kp.public, peer.id);

  // Same ordering as addPeer: render + artifact + audit, then hot-apply
  // last so a syncconf failure can't strand the operator without their
  // freshly-generated client config.
  regenerateWg0();

  const services = peer.scope_services_json ? JSON.parse(peer.scope_services_json) : null;
  const confPath = clientConfigPath(name);
  const confBody = renderClientConfig({
    peerPrivateKey: kp.private,
    peerIp: peer.allowed_ip,
    scope: peer.scope,
    cfg,
  });
  if (!fs.existsSync(VPN_PEERS_DIR)) {
    fs.mkdirSync(VPN_PEERS_DIR, { recursive: true, mode: 0o700 });
  }
  atomicWrite(confPath, confBody, 0o600);
  chownToInvoker(confPath);

  audit({
    subsystem: 'vpn',
    action: 'peer.rotate',
    resource: name,
    actor,
    before: { public_key: peer.public_key },
    after: { name, ip: peer.allowed_ip, scope: peer.scope, public_key: kp.public },
  });

  syncconfWg0();
  // Belt-and-braces evict the old key in case syncconf raced with a
  // fresh handshake. Best-effort because syncconf already removed it.
  try { wgPeerRemove(peer.public_key); } catch { /* best-effort */ }

  return {
    id: peer.id,
    name,
    ip: peer.allowed_ip,
    scope: peer.scope,
    services,
    publicKey: kp.public,
    privateKey: kp.private,
    configBody: confBody,
    configPath: confPath,
  };
}

function countEnabledPeers() {
  return getDb()
    .prepare(`SELECT COUNT(*) AS n FROM vpn_peers WHERE status = 'enabled'`)
    .get().n;
}

/**
 * Disable a peer without losing its record. The [Peer] block is dropped
 * from wg0.conf on the next render (readEnabledPeers filters by status),
 * and the live interface evicts it via wgPeerRemove. Re-enabling restores
 * the same key + IP.
 */
export function disablePeer({ name, force = false, actor } = {}) {
  validatePeerName(name);
  const peer = readPeerByName(name);
  if (!peer) throw new Error(`peer "${name}" not found`);
  if (peer.status === 'disabled') {
    return { ok: true, alreadyDisabled: true, name, ip: peer.allowed_ip };
  }
  if (countEnabledPeers() === 1 && !force) {
    const err = new Error(
      `refusing to disable "${name}" — it's the only enabled peer. ` +
      `Pass --force (with typed confirmation) if you really want to lock everyone out.`,
    );
    err.code = 'LAST_ENABLED_PEER';
    throw err;
  }

  getDb().prepare(`
    UPDATE vpn_peers SET status = 'disabled', disabled_at = datetime('now') WHERE id = ?
  `).run(peer.id);

  // Re-render before evicting so wg0.conf and the live set converge in
  // the same direction. If wg0 isn't up (e.g. vpn disable already ran)
  // tolerate the syncconf failure — the SQLite mutation is the truth.
  try {
    regenerateWg0();
    syncconfWg0();
  } catch (e) {
    if (!/syncconf|interface|No such device/i.test(e.message)) throw e;
  }
  try { wgPeerRemove(peer.public_key); } catch { /* best-effort */ }

  audit({
    subsystem: 'vpn',
    action: 'peer.disable',
    resource: name,
    actor,
    before: { status: peer.status },
    after: { status: 'disabled', name, ip: peer.allowed_ip, public_key: peer.public_key },
  });
  return { ok: true, name, ip: peer.allowed_ip };
}

export function enablePeer({ name, actor } = {}) {
  validatePeerName(name);
  const peer = readPeerByName(name);
  if (!peer) throw new Error(`peer "${name}" not found`);
  if (peer.status === 'enabled') {
    return { ok: true, alreadyEnabled: true, name, ip: peer.allowed_ip };
  }
  if (peer.status === 'revoked') {
    throw new Error(`peer "${name}" is revoked — use \`vpn peer rotate\` to issue a new key`);
  }

  getDb().prepare(`
    UPDATE vpn_peers SET status = 'enabled', disabled_at = NULL WHERE id = ?
  `).run(peer.id);

  regenerateWg0();
  syncconfWg0();

  audit({
    subsystem: 'vpn',
    action: 'peer.enable',
    resource: name,
    actor,
    before: { status: peer.status },
    after: { status: 'enabled', name, ip: peer.allowed_ip, public_key: peer.public_key },
  });
  return { ok: true, name, ip: peer.allowed_ip };
}

/**
 * Hard-remove a peer record. IP returns to the pool (released_at set so
 * it's reusable, not deleted, so historical audit rows stay joinable).
 * Refuses without force if (a) the peer handshook in the last 24h, or
 * (b) it's the only enabled peer.
 */
export function removePeer({ name, force = false, actor } = {}) {
  validatePeerName(name);
  const peer = readPeerByName(name);
  if (!peer) throw new Error(`peer "${name}" not found`);

  if (!force) {
    if (peer.status === 'enabled' && countEnabledPeers() === 1) {
      const err = new Error(
        `refusing to remove "${name}" — it's the only enabled peer. ` +
        `Pass --force (with typed confirmation) to proceed.`,
      );
      err.code = 'LAST_ENABLED_PEER';
      throw err;
    }
    const live = dumpPeers().get(peer.public_key);
    const handshake = live?.lastHandshakeUnix ?? 0;
    const nowSec = Math.floor(Date.now() / 1000);
    if (handshake && nowSec - handshake < ACTIVE_HANDSHAKE_WINDOW_SEC) {
      const err = new Error(
        `refusing to remove "${name}" — handshook ${nowSec - handshake}s ago ` +
        `(within the 24h active window). Pass --force to proceed.`,
      );
      err.code = 'RECENTLY_ACTIVE';
      throw err;
    }
  }

  const db = getDb();
  db.transaction(() => {
    releaseIp(db, peer.allowed_ip);
    db.prepare('DELETE FROM vpn_peers WHERE id = ?').run(peer.id);
  })();

  // Re-render and evict from the live interface. Both are best-effort
  // when wg0 is down (consistent with disablePeer).
  try {
    regenerateWg0();
    syncconfWg0();
  } catch (e) {
    if (!/syncconf|interface|No such device/i.test(e.message)) throw e;
  }
  try { wgPeerRemove(peer.public_key); } catch { /* best-effort */ }

  // Best-effort delete the client config file. Operators may have
  // already moved/deleted it; absent is fine, errors otherwise.
  const confPath = clientConfigPath(name);
  try { fs.unlinkSync(confPath); } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }

  audit({
    subsystem: 'vpn',
    action: 'peer.remove',
    resource: name,
    actor,
    before: {
      name, ip: peer.allowed_ip, scope: peer.scope,
      status: peer.status, public_key: peer.public_key,
    },
  });
  return { ok: true, name, ip: peer.allowed_ip };
}

/**
 * Live peer table. Left-joins SQLite vpn_peers with `wg show wg0 dump`
 * (tolerated empty if wg0 isn't up). Returns rows shaped for `vpn peer
 * list` — the CLI is responsible for column formatting / JSON shape.
 */
export function listPeers() {
  const db = getDb();
  const rows = db.prepare(`
    SELECT id, name, public_key, allowed_ip, scope, scope_services_json,
           status, created_at, rotated_at, disabled_at
    FROM vpn_peers
    ORDER BY id
  `).all();
  const live = dumpPeers();
  const nowSec = Math.floor(Date.now() / 1000);
  return rows.map(r => {
    const wg = live.get(r.public_key);
    return {
      id: r.id,
      name: r.name,
      ip: r.allowed_ip,
      scope: r.scope,
      services: r.scope_services_json ? JSON.parse(r.scope_services_json) : null,
      status: r.status,
      publicKey: r.public_key,
      lastHandshakeAt: wg?.lastHandshakeAt ?? null,
      online: isOnline(wg?.lastHandshakeUnix ?? 0, nowSec),
      rxBytes: wg?.rxBytes ?? 0,
      txBytes: wg?.txBytes ?? 0,
      endpoint: wg?.endpoint ?? null,
      createdAt: r.created_at,
      rotatedAt: r.rotated_at,
      disabledAt: r.disabled_at,
    };
  });
}

export function showPeer(name) {
  validatePeerName(name);
  const peer = readPeerByName(name);
  if (!peer) throw new Error(`peer "${name}" not found`);
  const live = dumpPeers().get(peer.public_key);
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    id: peer.id,
    name: peer.name,
    ip: peer.allowed_ip,
    scope: peer.scope,
    services: peer.scope_services_json ? JSON.parse(peer.scope_services_json) : null,
    status: peer.status,
    publicKey: peer.public_key,
    lastHandshakeAt: live?.lastHandshakeAt ?? null,
    online: isOnline(live?.lastHandshakeUnix ?? 0, nowSec),
    rxBytes: live?.rxBytes ?? 0,
    txBytes: live?.txBytes ?? 0,
    endpoint: live?.endpoint ?? null,
    createdAt: peer.created_at,
    rotatedAt: peer.rotated_at,
    disabledAt: peer.disabled_at,
  };
}
