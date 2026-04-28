import jwt from 'jsonwebtoken';

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
// CSRF intentionally NOT enforced here: SameSite=Strict on pp_token blocks
// cross-site WebSocket upgrades at the browser level, and the upgrade
// request body is empty (no double-submit token to verify against). The
// per-frame messages are authenticated by the surviving connection.
//
// Returns `{ user }` on success. Throws on missing / invalid / expired token.
export function verifyWsUpgrade(req) {
  const cookies = parseCookieHeader(req.headers?.cookie);
  const cookieToken = cookies.pp_token;
  const authHeader = req.headers?.authorization;
  const headerToken = authHeader && authHeader.split(' ')[1];
  const token = cookieToken || headerToken;

  if (!token) {
    const err = new Error('Authentication required');
    err.statusCode = 401;
    throw err;
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    return { user: decoded };
  } catch (e) {
    const err = new Error(e.name === 'TokenExpiredError' ? 'Token expired' : 'Invalid token');
    err.statusCode = e.name === 'TokenExpiredError' ? 401 : 403;
    throw err;
  }
}
