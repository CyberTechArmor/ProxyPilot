import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'development-secret-change-in-production';

// Parse the raw Cookie request header into a name->value map. The
// upgrade request handed to us by http.Server's 'upgrade' event does
// NOT pass through Express's cookie-parser, so we have to crack the
// header ourselves. Browsers separate cookies with '; '. Whitespace
// around the '=' is tolerated. Decoding mirrors cookie-parser's
// default (URL-decode the value).
function parseCookieHeader(header) {
  const out = {};
  if (!header || typeof header !== 'string') return out;
  for (const segment of header.split(';')) {
    const eq = segment.indexOf('=');
    if (eq < 0) continue;
    const name = segment.slice(0, eq).trim();
    if (!name) continue;
    const raw = segment.slice(eq + 1).trim();
    try {
      out[name] = decodeURIComponent(raw);
    } catch {
      out[name] = raw;
    }
  }
  return out;
}

// Validate a WebSocket upgrade request. Returns { user } on success,
// throws on missing or invalid token. CSRF is NOT enforced on the
// upgrade itself: SameSite=Strict on pp_token already blocks cross-
// origin browsers from initiating the upgrade with the cookie
// attached, which is the only attack a CSRF token would mitigate.
export function verifyWsUpgrade(req) {
  const cookies = parseCookieHeader(req.headers?.cookie);
  const token = cookies.pp_token;
  if (!token) {
    const err = new Error('Authentication required');
    err.status = 401;
    throw err;
  }
  try {
    const user = jwt.verify(token, JWT_SECRET);
    return { user };
  } catch (e) {
    const err = new Error(e.name === 'TokenExpiredError' ? 'Token expired' : 'Invalid token');
    err.status = 401;
    throw err;
  }
}
