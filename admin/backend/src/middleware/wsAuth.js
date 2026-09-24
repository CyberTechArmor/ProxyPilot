import jwt from 'jsonwebtoken';
import { requestOrigin } from '../lib/sso/sessions.js';
import { getAdminDomain, getDb } from '../db.js';
import { readConfig } from '../lib/sso/store.js';
import { validateSession } from './auth.js';

const JWT_SECRET = process.env.JWT_SECRET || 'development-secret-change-in-production';

// Parse the Cookie request header into a flat { name: value } map.
// Mirrors the subset of cookie-parser semantics we actually need on the
// upgrade path — node's http upgrade event hands us the raw IncomingMessage
// before any express middleware has run, so cookies are still a string.
function parseCookieHeader(header) {
  const out = {};
  if (!header || typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

// verifyWsUpgrade(req) — validates an incoming WebSocket upgrade request.
// Reads the JWT from the canonical `pp_token` cookie (set by the cookie
// auth flow, B4); falls back to the `Authorization: Bearer ...` header for
// non-browser clients to mirror authenticateToken.
//
// Cookie-authenticated browsers must present an exact configured Origin. A
// non-browser client may omit Origin only when using a Bearer header without
// an authentication cookie. Neither Host nor SameSite establishes that proof.
//
// Returns `{ user }` on success. Throws on missing / invalid / expired token.
export function verifyWsUpgrade(req) {
  const cookies = parseCookieHeader(req.headers?.cookie);
  const cookieToken = cookies.pp_token;
  const authHeader = req.headers?.authorization;
  const headerToken = authHeader && authHeader.split(' ')[1];
  const token = cookieToken || headerToken;
  const origin = req.headers?.origin;
  const reject = (message, statusCode = 403) => { const e = new Error(message); e.statusCode = statusCode; throw e; };
  if (origin) {
    const configured = readConfig(getDb());
    const origins = new Set([getAdminDomain() && `https://${getAdminDomain()}`,
      configured?.config?.publicOrigin, configured?.config?.recoveryOrigin,
      ...(process.env.TERMINAL_ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean)]);
    let parsed; try { parsed = new URL(origin); } catch { reject('Invalid terminal origin'); }
    if (!origins.has(origin) || parsed.origin !== origin || parsed.host !== req.headers.host ||
        !['https:', 'http:'].includes(parsed.protocol)) reject('Terminal origin denied');
  } else if (cookieToken || !/^Bearer \S+$/i.test(authHeader || '')) {
    reject('Terminal Origin required');
  }


  if (!token) {
    const err = new Error('Authentication required');
    err.statusCode = 401;
    throw err;
  }

  let decoded;
  try {
    decoded = jwt.verify(token, JWT_SECRET);
  } catch (e) {
    const err = new Error(e.name === 'TokenExpiredError' ? 'Token expired' : 'Invalid token');
    err.statusCode = e.name === 'TokenExpiredError' ? 401 : 403;
    throw err;
  }

  // Same session lookup as the HTTP path. A revoked session must
  // not be able to open a new WebSocket — without this check the
  // logout / revoke-all-others flow would leave any open WS pinhole
  // unaffected, and a stolen pre-revocation cookie could still
  // upgrade.
  const result = validateSession(decoded.jti, requestOrigin(req));
  if (!result.ok) {
    const err = new Error(result.error);
    err.statusCode = result.status;
    throw err;
  }
  if (decoded.id !== result.session.user_id) reject('Session identity mismatch', 401);
  if (!['admin', 'user'].includes(result.session.currentRole) || decoded.enrollmentOnly || result.session.enrollmentOnly) reject('Terminal access denied');
  if (result.session.linkOnly) { const err = new Error('Complete Keycloak linking before opening a terminal.'); err.statusCode = 403; throw err; }
  return { user: { ...decoded, role: result.session.currentRole }, session: result.session };
}
