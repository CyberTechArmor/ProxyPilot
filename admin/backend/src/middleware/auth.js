import jwt from 'jsonwebtoken';
import { getDb } from '../db.js';

const JWT_SECRET = process.env.JWT_SECRET || 'development-secret-change-in-production';

export function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

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
