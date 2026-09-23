import https from 'node:https';
import http from 'node:http';
import { lookup } from 'node:dns/promises';
import { allowedAddress } from './keycloak-discovery.js';
import { fail, VAULTWARDEN_PORT, VAULTWARDEN_VERSION, expectedSettings, digest } from './vaultwarden-logic.js';
// Only fixed read endpoints and admin authentication, never admin mutations.
export async function vaultwardenRequest(origin, path, { adminToken, resolve = lookup, request = https.request, local = false, edge = null } = {}) {
  const u = new URL(path, origin);
  if (u.origin !== origin || u.username || u.password || u.search || u.hash || !['/api/version', '/alive', '/admin/'].includes(u.pathname) ||
      (local ? origin !== `http://127.0.0.1:${VAULTWARDEN_PORT}` : u.protocol !== 'https:')) throw fail('Vaultwarden request is outside its reviewed origin or read-only endpoints.');
  let addresses;
  try { addresses = local ? [{ address: '127.0.0.1', family: 4 }] : edge ? [{ address: edge.address, family: 4 }] : await Promise.race([resolve(u.hostname, { all: true, family: 4 }), new Promise((_, reject) => { const t = setTimeout(() => reject(Error()), 5000); t.unref(); })]); }
  catch { throw fail('Vaultwarden DNS could not be verified.'); }
  if (!addresses.length || !local && !edge && addresses.some(a => !allowedAddress(a.address))) throw fail('Vaultwarden DNS points to a blocked special-use address.');
  const form = path === '/admin/' && adminToken ? new URLSearchParams({ token: adminToken }).toString() : null;
  return new Promise((done, reject) => {
    let size = 0; const chunks = [];
    const req = (local && request === https.request ? http.request : request)(u, { method: form ? 'POST' : 'GET', agent: false, timeout: 7000,
      lookup: (_h, o, cb) => o.all ? cb(null, [addresses[0]]) : cb(null, addresses[0].address, 4),
      headers: { ...(edge?.headers || {}), Accept: path === '/admin/' ? 'text/html' : 'application/json', ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(form) } : {}) } }, res => {
      res.on('data', b => { size += b.length; if (size > 1024 * 1024) req.destroy(); else chunks.push(b); });
      res.on('error', () => reject(fail('Vaultwarden response failed; upstream details withheld.')));
      res.on('end', () => { let body = null; if (res.statusCode === 200) { const text = Buffer.concat(chunks).toString('utf8'); if (path === '/admin/') body = text; else try { body = JSON.parse(text); } catch {} } done({ status: res.statusCode, body }); });
    });
    const timer = setTimeout(() => req.destroy(), 10000); timer.unref(); req.on('close', () => clearTimeout(timer)); req.on('timeout', () => req.destroy());
    req.on('error', () => reject(fail('Vaultwarden is unavailable (DNS, TLS, timeout or reachability); upstream details withheld.'))); req.end(form);
  });
}
export function createClient(origin, { send = vaultwardenRequest, job, local = false, edge = null } = {}) {
  return async (path, options = {}) => { job?.fence(); const out = await send(origin, path, { ...options, local, ...(edge ? { edge } : {}) }); job?.fence(); return out; };
}
export async function health(api) {
  try { const v = await api('/api/version'); if (v.status !== 200 || typeof v.body !== 'string') return { state: 'unavailable' };
    if (v.body !== VAULTWARDEN_VERSION) return { state: 'unverified_version' };
    const a = await api('/alive'); return { state: a.status === 200 ? 'healthy' : 'unhealthy', version: VAULTWARDEN_VERSION };
  } catch (e) { if (['FENCED', 'CANCELLED'].includes(e.code)) throw e; return { state: 'unavailable' }; }
}
const decode = value => value.replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt);/gi, (_, x) => x[0] === '#' ? String.fromCodePoint(x[1].toLowerCase() === 'x' ? parseInt(x.slice(2), 16) : Number(x.slice(1))) : ({ amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' })[x.toLowerCase()]);
// The pinned release's admin settings form renders EFFECTIVE values, including
// persisted CONFIG_FILE overrides. Parse only our allowlisted inputs; discard all
// other fields and the HTML. Never return the admin page or its secrets to callers.
export function effectiveSettings(html, r, clientSecret) {
  if (typeof html !== 'string' || !html.includes('id="config-form"')) throw fail('Vaultwarden admin authentication or effective configuration readback failed.');
  const expected = { ...expectedSettings(r), sso_client_secret: clientSecret }, observed = {}, overrides = [];
  for (const [key, value] of Object.entries(expected)) {
    const tags = [...html.matchAll(/<input\b[^>]*>/gi)].map(m => m[0]).filter(t => new RegExp(`\\bid="input_${key}"`).test(t));
    if (tags.length !== 1) throw fail('The selected Vaultwarden release did not expose all reviewed effective settings.');
    const tag = tags[0]; observed[key] = typeof value === 'boolean' ? /\schecked(?:\s|=|>)/.test(tag) : decode(tag.match(/\bvalue="([^"]*)"/)?.[1] ?? '');
    if (observed[key] !== value) throw fail(`Effective Vaultwarden setting ${key} differs from the review. Its owner must resolve the persisted override; no configuration was overwritten.`);
    const position = html.indexOf(tag), context = html.slice(Math.max(0, html.lastIndexOf('<div class="row', position)), position);
    if (context.includes('is-overridden-true')) overrides.push(key);
  }
  // Fingerprint excludes credential values. Equality with the protected reference
  // is checked above; only the opaque credential reference binds this proof.
  delete observed.sso_client_secret;
  return { configurationFingerprint: digest([observed, r.credential_ref]), effective: true, persistedOverridesChecked: true, overriddenKeys: overrides };
}
export async function verifyEffective(api, r, credentials) {
  const h = await health(api); if (h.state !== 'healthy') throw fail(`Vaultwarden is ${h.state.replaceAll('_', ' ')}. No service verification was recorded.`);
  const result = await api('/admin/', { adminToken: credentials.admin });
  if (result.status === 429) throw fail('Vaultwarden rate-limited the administrative check (too many admin logins in a short time). Wait a few minutes and retry; nothing was changed.');
  if (result.status !== 200) throw fail(`Vaultwarden read-only administrative configuration check failed (HTTP ${result.status}). Keep existing login and ask its owner to complete the handoff.`);
  return { ...effectiveSettings(result.body, r, credentials.client), version: VAULTWARDEN_VERSION };
}
