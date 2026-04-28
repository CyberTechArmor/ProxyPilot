import jwt from 'jsonwebtoken';
import { getDb } from '../db.js';

const DEV_JWT_FALLBACK = 'development-secret-change-in-production';
const JWT_SECRET = process.env.JWT_SECRET || DEV_JWT_FALLBACK;

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

export function authenticateToken(req, res, next) {
  // Prefer the httpOnly cookie set by the login flow; fall back to the
  // Authorization header so non-browser clients (curl, scripts that
  // POSTed /api/auth/login and grabbed the token from the response)
  // continue to work for now. Cookie is the canonical path for browsers
  // because it can't be exfiltrated by XSS.
  const cookieToken = req.cookies?.pp_token;
  const authHeader = req.headers['authorization'];
  const headerToken = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN
  const token = cookieToken || headerToken;

  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired' });
    }
    return res.status(403).json({ error: 'Invalid token' });
  }
}

export function generateToken(user) {
  return jwt.sign(
    {
      id: user.id,
      username: user.username,
      role: user.role || 'admin', // Default to admin for existing users
    },
    JWT_SECRET,
    { expiresIn: '24h' }
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
