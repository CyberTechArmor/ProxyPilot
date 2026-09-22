// Only the administrator-reviewed origin may be dialled. Reuse the operator
// egress validator; pin DNS per request, reject special-use addresses, keep TLS
// validation, refuse redirects, and bound time/body size. Never send credentials.
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { createPublicKey } from 'node:crypto';
import { isIP } from 'node:net';
import { validateOperatorEgressInput } from '../../mock2/egress-logic.js';
import { issuerFor } from './keycloak-logic.js';
export function allowedAddress(address) {
  // IPv4-only deliberately avoids alternate/mapped IPv6 bypasses. RFC1918 is
  // permitted only at the exact origin explicitly reviewed by the administrator.
  if (isIP(address) !== 4) return false;
  const [a, b] = address.split('.').map(Number);
  return !(a === 0 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127) || (a === 192 && b === 0) || (a === 198 && [18,19].includes(b)));
}
export async function readIssuerJson(url, origin, { resolve = lookup, request = https.get } = {}) {
  const u = new URL(url);
  if (u.origin !== origin || u.protocol !== 'https:' || u.username || u.password || u.hash || u.search || !validateOperatorEgressInput({ host: u.hostname, port: Number(u.port || 443), protocol: 'https' }).ok) throw new Error('Issuer endpoint is outside the approved HTTPS origin.');
  const addresses = await Promise.race([resolve(u.hostname, { all: true, family: 4 }), new Promise((_, reject) => { const t = setTimeout(() => reject(new Error('Issuer DNS timeout.')), 5000); t.unref(); })]);
  if (!addresses.length || addresses.some(a => !allowedAddress(a.address))) throw new Error('Issuer DNS points at a blocked special-use address.');
  return new Promise((resolveBody, reject) => {
    let bytes = 0; const chunks = [];
    const req = request(u, { agent: false, timeout: 5000, lookup: (_host, opts, cb) => opts.all ? cb(null, [addresses[0]]) : cb(null, addresses[0].address, 4), headers: { Accept: 'application/json' } }, res => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error('Issuer endpoint did not return HTTP 200; redirects are refused.')); return; }
      res.on('data', b => { bytes += b.length; if (bytes > 1024 * 1024) req.destroy(new Error('Issuer response exceeds 1 MiB.')); else chunks.push(b); });
      res.on('error', () => reject(new Error('Issuer response failed.')));
      res.on('end', () => { try { resolveBody(JSON.parse(Buffer.concat(chunks))); } catch { reject(new Error('Issuer endpoint did not return JSON.')); } });
    });
    const deadline = setTimeout(() => req.destroy(new Error('Issuer request timeout.')), 7000); deadline.unref();
    req.on('close', () => clearTimeout(deadline));
    req.on('timeout', () => req.destroy(new Error('Issuer request timeout.')));
    req.on('error', () => reject(new Error('Issuer HTTPS request failed (DNS, TLS or reachability).')));
  });
}
export async function verifyKeycloak(target, { readJson = readIssuerJson, now = () => new Date().toISOString() } = {}) {
  const issuer = issuerFor(target);
  const discovery = await readJson(`${issuer}/.well-known/openid-configuration`, target.url);
  if (discovery.issuer !== issuer) throw new Error('Discovery issuer does not exactly match the reviewed realm issuer.');
  const jwks = discovery.jwks_uri;
  if (typeof jwks !== 'string' || jwks !== `${issuer}/protocol/openid-connect/certs`) throw new Error('Signing-key endpoint is not the selected Keycloak realm endpoint.');
  const set = await readJson(jwks, target.url);
  if (!Array.isArray(set.keys) || !set.keys.length || set.keys.length > 100) throw new Error('No usable signing keys were returned.');
  const valid = set.keys.some(key => {
    if (!key || key.d || key.k || key.p || key.q || (key.use && key.use !== 'sig') || !['RSA','EC','OKP'].includes(key.kty)) return false;
    try { const publicKey = createPublicKey({ key, format: 'jwk' }); return publicKey.type === 'public'; } catch { return false; }
  });
  if (!valid) throw new Error('No usable public signing keys were returned.');
  return { issuer, discovery: true, issuerExact: true, signingKeys: true, jwksUri: jwks, administrativePermission: 'not_checked', proxyPilotClient: 'not_registered', ssoActivated: false, verifiedAt: now() };
}
