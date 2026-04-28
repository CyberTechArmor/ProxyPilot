import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db.js';

const DEV_JWT_FALLBACK = 'development-secret-change-in-production';
const JWT_SECRET = process.env.JWT_SECRET || DEV_JWT_FALLBACK;

// Session lifetime knobs. The absolute TTL caps how long a single
// login can stay alive; the idle TTL is the sliding inactivity window
// that slams shut after a long break ("closed/reopened if inactive for
// more than 4 hours"). Both are env-tunable so the operator can dial
// them per deployment.
const SESSION_TTL_HOURS = parseInt(process.env.SESSION_TTL_HOURS || '24', 10);
const SESSION_IDLE_HOURS = parseFloat(process.env.SESSION_IDLE_HOURS || '4');

// Stale-row retention: rows revoked or expired more than this many
// days ago are deleted by sweepStaleSessions(). 30 days is enough for
// post-hoc forensics ("when was that session revoked?") without
// letting the table grow without bound.
const SESSION_RETENTION_DAYS = parseInt(process.env.SESSION_RETENTION_DAYS || '30', 10);

// Boot-time assertion: refuse to run in production with a missing,
// default, or weak JWT_SECRET. install.sh and update.sh both generate
// a 64-byte random secret on a fresh deploy or on first .env sync,
// so the only ways to trip this are (a) operator deleted the line by
// hand, (b) operator copied a dev .env into prod. Either way crash
// loud rather than silently accept forged tokens.
//
// Called from index.js *after* dotenv has loaded but *before* server.listen.
export function assertJwtSecret() {
  if (process.env.NODE_ENV !== 'production') return;
  const value = process.env.JWT_SECRET;
  const problems = [];
  if (!value) problems.push('not set');
  else if (value === DEV_JWT_FALLBACK) problems.push('left at the development fallback');
  else if (value.length < 32) problems.push(`only ${value.length} chars (need >= 32)`);
  if (problems.length === 0) return;
  console.error(
    `FATAL: JWT_SECRET is ${problems.join(' and ')}. ` +
    `Refusing to start in production with a forgeable token-signing key. ` +
    `Generate one with \`openssl rand -base64 64\` and put it in /opt/proxypilot/.env.`
  );
  process.exit(1);
}

// Delete session rows whose expires_at OR revoked_at is older than
// SESSION_RETENTION_DAYS. Idempotent; intended to run on backend
// boot and on a 6h interval. Returns the number of rows deleted so
// the caller can log it. Errors are swallowed — a transient sweep
// failure must not crash the long-lived backend process.
export function sweepStaleSessions() {
  try {
    const db = getDb();
    const result = db.prepare(
      `DELETE FROM sessions
        WHERE (revoked_at  IS NOT NULL AND datetime(revoked_at) < datetime('now', '-' || ? || ' days'))
           OR (revoked_at  IS NULL     AND datetime(expires_at) < datetime('now', '-' || ? || ' days'))`
    ).run(SESSION_RETENTION_DAYS, SESSION_RETENTION_DAYS);
    return result.changes;
  } catch (e) {
    console.error('sweepStaleSessions failed:', e?.message || e);
    return 0;
  }
}

// Look up a session by its JWT jti claim and validate it against the
// sessions table. Returns { ok: true, session } on success, or
// { ok: false, status, error } on any failure (revoked, expired,
// idle-timed-out, or — for pre-M tokens that carry no jti — never
// existed). Used by both the HTTP authenticateToken middleware below
// and the WebSocket upgrade path in middleware/wsAuth.js so the two
// can't drift.
export function validateSession(jti) {
  if (!jti) {
    return { ok: false, status: 401, error: 'Session re-authentication required' };
  }
  const db = getDb();
  const session = db.prepare(
    `SELECT id, user_id, expires_at, last_used_at, revoked_at, sudo_until
       FROM sessions WHERE id = ?`
  ).get(jti);
  if (!session || session.revoked_at) {
    return { ok: false, status: 401, error: 'Session revoked' };
  }
  const nowMs = Date.now();
  const expiresAtMs = Date.parse(session.expires_at);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) {
    return { ok: false, status: 401, error: 'Session expired' };
  }
  const lastUsedMs = Date.parse(session.last_used_at);
  const idleMs = SESSION_IDLE_HOURS * 60 * 60 * 1000;
  if (Number.isFinite(lastUsedMs) && nowMs - lastUsedMs > idleMs) {
    db.prepare(`UPDATE sessions SET revoked_at = CURRENT_TIMESTAMP WHERE id = ?`).run(jti);
    return { ok: false, status: 401, error: 'Session idle timeout' };
  }
  // Slide on every successful verify. Effectively means "any
  // authenticated request resets the 4h idle clock", which is what
  // the operator asked for.
  db.prepare(`UPDATE sessions SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?`).run(jti);
  return { ok: true, session };
}

export function authenticateToken(req, res, next) {
  // Prefer the httpOnly cookie set by the login flow; fall back to the
  // Authorization header so non-browser clients (curl, scripts that
  // POSTed /api/auth/login and grabbed the token from the response)
  // continue to work. Cookie is the canonical path for browsers because
  // it can't be exfiltrated by XSS.
  const cookieToken = req.cookies?.pp_token;
  const authHeader = req.headers['authorization'];
  const headerToken = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN
  const token = cookieToken || headerToken;

  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  let decoded;
  try {
    decoded = jwt.verify(token, JWT_SECRET);
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired' });
    }
    return res.status(403).json({ error: 'Invalid token' });
  }

  const result = validateSession(decoded.jti);
  if (!result.ok) {
    return res.status(result.status).json({ error: result.error });
  }

  req.user = decoded;
  req.session = result.session;
  next();
}

// generateToken issues a new JWT and inserts the matching session
// row in one step. The jti claim is the row's primary key, so
// authenticateToken can revoke the token by flipping revoked_at on
// the row.
//
// The caller MUST pass req.ip + req.headers['user-agent'] so the
// session row carries an audit trail of where the token was minted.
export function generateToken(user, { ip, userAgent } = {}) {
  const db = getDb();
  const jti = uuidv4();
  const expiresAtMs = Date.now() + SESSION_TTL_HOURS * 60 * 60 * 1000;
  const expiresAtISO = new Date(expiresAtMs).toISOString();

  db.prepare(
    `INSERT INTO sessions (id, user_id, expires_at, ip, user_agent)
     VALUES (?, ?, ?, ?, ?)`
  ).run(
    jti,
    user.id,
    expiresAtISO,
    ip ? String(ip).slice(0, 64) : null,
    userAgent ? String(userAgent).slice(0, 200) : null,
  );

  return jwt.sign(
    {
      id: user.id,
      username: user.username,
      role: user.role || 'admin',
      jti,
    },
    JWT_SECRET,
    { expiresIn: `${SESSION_TTL_HOURS}h` }
  );
}

// Middleware to require admin role
export function requireAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }

  next();
}

// Check if user can access a service (view)
export function canViewService(userId, serviceId) {
  const db = getDb();
  const user = db.prepare('SELECT role FROM users WHERE id = ?').get(userId);

  // Admins can view all services
  if (user?.role === 'admin') {
    return true;
  }

  // Check specific access
  const access = db.prepare(
    'SELECT can_view FROM user_service_access WHERE user_id = ? AND service_id = ?'
  ).get(userId, serviceId);

  return access?.can_view === 1;
}

// Check if user can modify a service (write)
export function canWriteService(userId, serviceId) {
  const db = getDb();
  const user = db.prepare('SELECT role FROM users WHERE id = ?').get(userId);

  // Admins can write to all services
  if (user?.role === 'admin') {
    return true;
  }

  // Check specific access
  const access = db.prepare(
    'SELECT can_write FROM user_service_access WHERE user_id = ? AND service_id = ?'
  ).get(userId, serviceId);

  return access?.can_write === 1;
}

// Get list of services a user can access
export function getAccessibleServices(userId) {
  const db = getDb();
  const user = db.prepare('SELECT role FROM users WHERE id = ?').get(userId);

  // Admins can access all services
  if (user?.role === 'admin') {
    return db.prepare('SELECT * FROM services ORDER BY name').all();
  }

  // Get services with user access
  return db.prepare(`
    SELECT s.* FROM services s
    INNER JOIN user_service_access usa ON s.id = usa.service_id
    WHERE usa.user_id = ? AND usa.can_view = 1
    ORDER BY s.name
  `).all(userId);
}
