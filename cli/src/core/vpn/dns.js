// VPN DNS — the resolver VPN peers use (`DNS = 10.100.0.1` in their config).
//
// Peers route only 10.100.0.0/24 through the tunnel, so a platform hostname
// that resolves to the host's public address is reached OUTSIDE the tunnel
// and Caddy sees the client's public address — the VPN never counts for the
// restricted routes. This resolver answers the configured names (the Full
// Platform hostnames the backend pushes, plus the operator's extra domains)
// with the VPN server address, so the request travels through the tunnel and
// arrives from 10.100.0.x; every other query is forwarded unchanged to the
// host's own upstream resolvers.
//
//   A    for a configured name → the VPN server address (TTL 60)
//   AAAA / HTTPS / SVCB for one → empty NOERROR (the client must not take a
//        public IPv6 or an alt-endpoint hint around the tunnel)
//   anything else              → forwarded (UDP, or TCP for a TCP client)
//
// Names are exact hostnames or `*.suffix` (subdomains only). The list lives in
// /var/lib/proxypilot/vpn-dns.json and is re-read when the file changes, so
// `proxypilot vpn dns set` takes effect without a restart. No dependency
// beyond node:dgram/net: the wire format handled here is the question
// section and a single answer record.

import dgram from 'node:dgram';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';

export const VPN_DNS_FILE = '/var/lib/proxypilot/vpn-dns.json';
export const VPN_DNS_ADDRESS = '10.100.0.1';
export const FALLBACK_UPSTREAMS = Object.freeze(['1.1.1.1', '9.9.9.9']);
const TYPE = { A: 1, AAAA: 28, SVCB: 64, HTTPS: 65 };
const HOSTNAME_RE = /^(\*\.)?(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

/* ------------------------------- the list -------------------------------- */

/** Lower-case, trim, de-duplicate and validate a list of hostnames / *.suffix entries. Throws on an invalid one. */
export function normalizeNames(list) {
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const n = String(raw).trim().toLowerCase().replace(/\.$/, '');
    if (!n) continue;
    if (!HOSTNAME_RE.test(n)) throw new Error(`not a DNS hostname (or *.suffix): ${raw}`);
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

export function readDnsConfig(file = VPN_DNS_FILE) {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { managed: normalizeNames(v.managed), extra: normalizeNames(v.extra), updatedAt: v.updatedAt || null };
  } catch {
    return { managed: [], extra: [], updatedAt: null };
  }
}

/** Atomic write (tmp + rename), 0644 — hostnames only, nothing secret. */
export function writeDnsConfig({ managed, extra }, file = VPN_DNS_FILE) {
  const cur = readDnsConfig(file);
  const next = { managed: managed === undefined ? cur.managed : normalizeNames(managed), extra: extra === undefined ? cur.extra : normalizeNames(extra), updatedAt: new Date().toISOString() };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o644 });
  fs.renameSync(tmp, file);
  return next;
}

/** Does `name` match one entry (exact, or a subdomain of a `*.suffix`)? */
export function nameMatches(name, entries) {
  const n = String(name).toLowerCase().replace(/\.$/, '');
  return entries.some((e) => (e.startsWith('*.') ? n.endsWith(e.slice(1)) && n.length > e.length - 1 : n === e));
}

/** The host's own resolvers from resolv.conf, minus the address this server binds. */
export function upstreamsFrom(resolvConf, { exclude = [VPN_DNS_ADDRESS] } = {}) {
  const found = String(resolvConf || '').split('\n').map((l) => l.trim().match(/^nameserver\s+(\S+)/)?.[1]).filter(Boolean)
    .filter((ip) => net.isIPv4(ip) && !exclude.includes(ip));
  return found.length ? found : [...FALLBACK_UPSTREAMS];
}

/* ------------------------------ wire format ------------------------------ */

/** The header and first question of a query; null when it is not one we can read. */
export function parseQuery(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  const id = buf.readUInt16BE(0), flags = buf.readUInt16BE(2), qd = buf.readUInt16BE(4);
  if (flags & 0x8000 || qd !== 1) return null; // a response, or not exactly one question
  const labels = [];
  let o = 12;
  for (;;) {
    if (o >= buf.length) return null;
    const len = buf[o];
    if (len === 0) { o += 1; break; }
    if (len & 0xc0 || len > 63 || o + 1 + len > buf.length) return null; // no compression in a question
    labels.push(buf.toString('latin1', o + 1, o + 1 + len));
    o += 1 + len;
  }
  if (o + 4 > buf.length) return null;
  return { id, flags, name: labels.join('.').toLowerCase(), type: buf.readUInt16BE(o), qclass: buf.readUInt16BE(o + 2), questionEnd: o + 4 };
}

/**
 * The answer for a configured name: the question echoed, then one A record
 * (type A) or none (any other type). Authoritative, recursion available.
 */
export function buildAnswer(buf, q, address, ttl = 60) {
  const question = buf.subarray(12, q.questionEnd);
  const withA = q.type === TYPE.A && q.qclass === 1;
  const header = Buffer.alloc(12);
  header.writeUInt16BE(q.id, 0);
  header.writeUInt16BE(0x8000 | 0x0400 | (q.flags & 0x0100) | 0x0080, 2); // QR, AA, RD echoed, RA; RCODE 0
  header.writeUInt16BE(1, 4); header.writeUInt16BE(withA ? 1 : 0, 6); header.writeUInt16BE(0, 8); header.writeUInt16BE(0, 10);
  if (!withA) return Buffer.concat([header, question]);
  const rr = Buffer.alloc(16);
  rr.writeUInt16BE(0xc00c, 0); rr.writeUInt16BE(TYPE.A, 2); rr.writeUInt16BE(1, 4); rr.writeUInt32BE(ttl, 6); rr.writeUInt16BE(4, 10);
  address.split('.').forEach((octet, i) => rr.writeUInt8(Number(octet), 12 + i));
  return Buffer.concat([header, question, rr]);
}

/** SERVFAIL for a query we could not forward. */
export function buildServfail(buf, q) {
  const out = Buffer.from(buf.subarray(0, q ? q.questionEnd : Math.min(buf.length, 12)));
  if (out.length < 12) return null;
  out.writeUInt16BE(0x8000 | ((q?.flags ?? out.readUInt16BE(2)) & 0x0100) | 0x0080 | 2, 2);
  out.writeUInt16BE(q ? 1 : 0, 4); out.writeUInt16BE(0, 6); out.writeUInt16BE(0, 8); out.writeUInt16BE(0, 10);
  return out;
}

/** The local decision for one query: an answer buffer, or null → forward. */
export function localAnswer(buf, entries, address) {
  const q = parseQuery(buf);
  if (!q || !nameMatches(q.name, entries)) return null;
  return buildAnswer(buf, q, address);
}

/* -------------------------------- forward -------------------------------- */

function forwardUdp(buf, upstreams, { timeoutMs = 2500, port = 53 } = {}) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    let i = 0, done = false, timer = null;
    const finish = (v) => { if (done) return; done = true; clearTimeout(timer); try { sock.close(); } catch { /* */ } resolve(v); };
    const tryNext = () => {
      if (i >= upstreams.length) return finish(null);
      const up = upstreams[i++];
      clearTimeout(timer); timer = setTimeout(tryNext, timeoutMs);
      sock.send(buf, port, up, (e) => { if (e) tryNext(); });
    };
    sock.on('message', (msg) => { if (msg.length >= 2 && msg.readUInt16BE(0) === buf.readUInt16BE(0)) finish(msg); });
    sock.on('error', () => finish(null));
    tryNext();
  });
}

function forwardTcp(buf, upstreams, { timeoutMs = 4000, port = 53 } = {}) {
  return new Promise((resolve) => {
    let i = 0;
    const tryNext = () => {
      if (i >= upstreams.length) return resolve(null);
      const up = upstreams[i++];
      const s = net.connect({ host: up, port });
      let got = Buffer.alloc(0), settled = false;
      const end = (v) => { if (settled) return; settled = true; s.destroy(); v ? resolve(v) : tryNext(); };
      s.setTimeout(timeoutMs, () => end(null));
      s.on('error', () => end(null));
      s.on('connect', () => { const len = Buffer.alloc(2); len.writeUInt16BE(buf.length); s.write(Buffer.concat([len, buf])); });
      s.on('data', (d) => { got = Buffer.concat([got, d]); if (got.length >= 2 && got.length >= 2 + got.readUInt16BE(0)) end(got.subarray(2, 2 + got.readUInt16BE(0))); });
    };
    tryNext();
  });
}

/* -------------------------------- server --------------------------------- */

/**
 * Serve DNS on address:port (UDP and TCP). `names()` returns the current
 * entries; `upstreams()` the forward targets. Resolves once both listeners
 * are bound; `close()` stops them.
 */
export async function startDnsServer({ address = VPN_DNS_ADDRESS, port = 53, answerAddress = address, names, upstreams, upstreamPort = 53, log = () => {} }) {
  const respond = async (buf, forward) => {
    const q = parseQuery(buf);
    const local = q && nameMatches(q.name, names()) ? buildAnswer(buf, q, answerAddress) : null;
    if (local) return local;
    const fwd = await forward(buf, upstreams(), { port: upstreamPort });
    return fwd || buildServfail(buf, q);
  };
  const udp = dgram.createSocket('udp4');
  udp.on('message', (msg, rinfo) => {
    respond(msg, forwardUdp).then((out) => { if (out) udp.send(out, rinfo.port, rinfo.address); }).catch((e) => log('udp', e?.message || e));
  });
  const tcp = net.createServer((sock) => {
    let pending = Buffer.alloc(0);
    sock.setTimeout(10000, () => sock.destroy());
    sock.on('error', () => {});
    sock.on('data', (d) => {
      pending = Buffer.concat([pending, d]);
      while (pending.length >= 2 && pending.length >= 2 + pending.readUInt16BE(0)) {
        const msg = pending.subarray(2, 2 + pending.readUInt16BE(0));
        pending = pending.subarray(2 + msg.length);
        respond(msg, forwardTcp).then((out) => { if (out) { const len = Buffer.alloc(2); len.writeUInt16BE(out.length); sock.write(Buffer.concat([len, out])); } }).catch(() => sock.destroy());
      }
    });
  });
  await new Promise((ok, no) => { udp.once('error', no); udp.bind(port, address, () => { udp.off('error', no); ok(); }); });
  await new Promise((ok, no) => { tcp.once('error', no); tcp.listen(port, address, () => { tcp.off('error', no); ok(); }); });
  const bound = { udp: udp.address().port, tcp: tcp.address().port };
  return { ...bound, close: () => Promise.all([new Promise((r) => udp.close(r)), new Promise((r) => tcp.close(r))]) };
}
