// DNS for the Full Platform hostnames (3e) — one implementation for the apply
// and continue refusals, the coordinator, platform_preflight and the Platform
// overview.
//
// A hostname passes only when BOTH the host's own resolver and a public
// resolver (1.1.1.1) answer with the Caddy host's address:
//   * expected (public) = what 1.1.1.1 resolves for the ProxyPilot
//     administrator hostname, or MOCK2_PUBLIC_IP when the operator pinned it;
//   * expected (host)   = what the host resolves for that same hostname, so a
//     split-horizon override that points every name at the LAN address still
//     compares like with like.
// A disagreement between the two resolvers is reported as such (a cached
// answer or a local override on the firewall's resolver, e.g. OPNsense/
// Unbound). Whether the zone can be changed from here is reported too: on
// the stored Cloudflare token → set_dns_record; otherwise the exact record to
// set at the external DNS host.
//
// Facts are cached for 15 s (the overview refreshes every 30 s); the
// refusals pass { fresh: true }.

import { lookup, Resolver } from 'node:dns/promises';
import { decryptSecret } from '../secrets.js';

export const PUBLIC_RESOLVER = '1.1.1.1';
const TTL_MS = 15_000;
const ZONE_TTL_MS = 10 * 60_000;
const cache = new Map();
const zoneCache = new Map();

const withTimeout = (p, ms = 5000) => Promise.race([p, new Promise((_, reject) => { const t = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'ETIMEOUT' })), ms); t.unref?.(); })]);

export const defaultResolvers = {
  host: async (h) => (await withTimeout(lookup(h, { all: true, family: 4 }))).map((a) => a.address),
  public: async (h) => { const r = new Resolver({ timeout: 4000, tries: 1 }); r.setServers([PUBLIC_RESOLVER]); return withTimeout(r.resolve4(h)); },
};

async function one(fn, h) {
  try { return { addresses: [...new Set(await fn(h))].sort(), error: null }; }
  catch (e) { return { addresses: [], error: e?.code || 'unresolved' }; }
}

/** { host: {addresses, error}, public: {addresses, error} } for one hostname. */
export async function resolveBoth(hostname, { resolvers = defaultResolvers, fresh = false, now = Date.now() } = {}) {
  const hit = cache.get(hostname);
  if (!fresh && hit && now - hit.at < TTL_MS && hit.resolvers === resolvers) return hit.value;
  const [host, pub] = await Promise.all([one(resolvers.host, hostname), one(resolvers.public, hostname)]);
  const value = { host, public: pub };
  cache.set(hostname, { at: now, value, resolvers });
  return value;
}

const adminHostname = (db) => db.prepare("SELECT value FROM app_settings WHERE key='admin_domain'").get()?.value || null;
const pinned = () => String(process.env.MOCK2_PUBLIC_IP || '').split(',').map((s) => s.trim()).filter((s) => /^\d{1,3}(\.\d{1,3}){3}$/.test(s));

/** The Caddy host's addresses, as each resolver sees them. */
export async function caddyAddresses(db, opts = {}) {
  const admin = adminHostname(db);
  const r = admin ? await resolveBoth(admin, opts) : { host: { addresses: [] }, public: { addresses: [] } };
  const pin = pinned();
  return { from: pin.length ? 'MOCK2_PUBLIC_IP' : admin, public: pin.length ? pin : r.public.addresses.length ? r.public.addresses : r.host.addresses, host: r.host.addresses.length ? r.host.addresses : pin };
}

function cloudflareToken(db) {
  try { const v = db.prepare("SELECT value FROM app_settings WHERE key='cloudflare_global_token'").get()?.value; if (v) { const t = String(decryptSecret(v) || '').trim(); if (t) return t; } } catch { /* fall through */ }
  return String(process.env.CLOUDFLARE_API_TOKEN || '').trim() || null;
}

/** Is the hostname's zone on the stored Cloudflare token? → { managed: true, zone } | { managed: false, zone: null, reason } */
export async function zoneFor(db, hostname, { fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  const token = cloudflareToken(db);
  if (!token) return { managed: false, zone: null, reason: 'No Cloudflare token is stored; DNS is managed outside ProxyPilot.' };
  const hit = zoneCache.get(hostname);
  if (hit && now - hit.at < ZONE_TTL_MS) return hit.value;
  const labels = hostname.split('.');
  let value = { managed: false, zone: null, reason: 'The stored Cloudflare token does not cover this zone; DNS is managed outside ProxyPilot.' };
  try {
    for (let i = 0; i < labels.length - 1; i += 1) {
      const zone = labels.slice(i).join('.');
      const res = await fetchImpl(`https://api.cloudflare.com/client/v4/zones?name=${encodeURIComponent(zone)}&status=active`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000) });
      const j = await res.json().catch(() => null);
      if (!res.ok || !j?.success) { value = { managed: false, zone: null, reason: 'The Cloudflare API did not answer for this zone; treat DNS as managed outside ProxyPilot until it does.', unknown: true }; break; }
      if (j.result?.length) { value = { managed: true, zone: j.result[0].name }; break; }
    }
  } catch { value = { managed: false, zone: null, reason: 'The Cloudflare API is unreachable from here; treat DNS as managed outside ProxyPilot until it answers.', unknown: true }; }
  if (!value.unknown) zoneCache.set(hostname, { at: now, value });
  return value;
}

const overlap = (a, b) => a.some((x) => b.includes(x));

/**
 * The verdict for one hostname (pure):
 *   { hostname, ok, host, public, expected, points: {host, public}, agree, zone, reason, record }
 */
export function dnsVerdict(hostname, facts, expected, zone) {
  const pointsHost = facts.host.addresses.length && expected.host.length ? overlap(facts.host.addresses, expected.host) : false;
  const pointsPublic = facts.public.addresses.length && expected.public.length ? overlap(facts.public.addresses, expected.public) : false;
  const agree = facts.host.addresses.join(',') === facts.public.addresses.join(',');
  const want = expected.public[0] || null;
  const ok = !!(pointsHost && pointsPublic);
  const record = want ? `${hostname}. A ${want}` : null;
  let reason = null;
  if (!ok) {
    const show = (r) => (r.addresses.length ? r.addresses.join(', ') : `nothing (${r.error || 'no answer'})`);
    const parts = [`${hostname}: the host resolves ${show(facts.host)}; the public resolver ${PUBLIC_RESOLVER} resolves ${show(facts.public)}; expected ${want || 'the Caddy host address (unknown: the administrator hostname did not resolve)'}.`];
    if (!agree) parts.push('The two resolvers disagree — a cached answer or a local override on this network\'s resolver (for example OPNsense/Unbound host overrides).');
    if (zone?.managed) parts.push(`The zone ${zone.zone} is on the stored Cloudflare token: set the record with set_dns_record({ name: "${hostname}", type: "A", content: "${want || '<Caddy host IP>'}", confirm: true }) or the Domains page.`);
    else parts.push(`The zone is not on the stored Cloudflare token, so the record must be changed at the external DNS host${record ? `: ${record}` : ''}.`);
    reason = parts.join(' ');
  }
  return { hostname, ok, host: facts.host, public: facts.public, expected: { address: want, host: expected.host, public: expected.public, from: expected.from }, points: { host: !!pointsHost, public: !!pointsPublic }, agree, zone: zone || null, reason, record };
}

/** Check several hostnames against the Caddy host. → { expected, results: { [hostname]: verdict } } */
export async function checkHostnames(db, hostnames, { resolvers = defaultResolvers, fresh = false, zones = true, fetchImpl } = {}) {
  const expected = await caddyAddresses(db, { resolvers, fresh });
  const results = {};
  for (const h of [...new Set(hostnames.filter(Boolean))]) {
    const facts = await resolveBoth(h, { resolvers, fresh });
    const zone = zones ? await zoneFor(db, h, { fetchImpl }) : null;
    results[h] = dnsVerdict(h, facts, expected, zone);
  }
  return { expected, results };
}

/** The first refusal among the given hostnames, or null. */
export async function dnsRefusal(db, hostnames, opts = {}) {
  const { results } = await checkHostnames(db, hostnames, { ...opts, fresh: true });
  const bad = Object.values(results).filter((r) => !r.ok);
  return bad.length ? { error: `DNS does not point at the Caddy host. ${bad.map((b) => b.reason).join(' ')}`, code: 'DNS_NOT_READY', reason_code: 'dns_mismatch', hostnames: bad } : null;
}

export function clearDnsCache() { cache.clear(); zoneCache.clear(); }
