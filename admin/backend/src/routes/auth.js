import { Router } from 'express';
import bcrypt from 'bcryptjs';
import * as OTPAuth from 'otpauth';
import { z } from 'zod';
import { getDb, logAudit } from '../db.js';
import { generateToken, authenticateToken } from '../middleware/auth.js';

export const authRouter = Router();

// Validation schemas
const loginSchema = z.object({
  username: z.string().min(1, 'Username is required'),
  password: z.string().min(1, 'Password is required'),
  totpCode: z.string().length(6, 'TOTP code must be 6 digits'),
});

// Login endpoint
authRouter.post('/login', async (req, res) => {
  try {
    const { username, password, totpCode } = loginSchema.parse(req.body);
    const db = getDb();

    // Find user
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);

    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Verify password
    const passwordValid = await bcrypt.compare(password, user.password_hash);
    if (!passwordValid) {
      logAudit(null, 'LOGIN_FAILED', 'user', user.id, { reason: 'Invalid password' }, req.ip);
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Verify TOTP
    if (user.totp_enabled && user.totp_secret) {
      const totp = new OTPAuth.TOTP({
        issuer: 'ProxyPilot',
        label: username,
        algorithm: 'SHA1',
        digits: 6,
        period: 30,
        secret: OTPAuth.Secret.fromBase32(user.totp_secret),
      });

      const delta = totp.validate({ token: totpCode, window: 1 });
      if (delta === null) {
        logAudit(null, 'LOGIN_FAILED', 'user', user.id, { reason: 'Invalid TOTP' }, req.ip);
        return res.status(401).json({ error: 'Invalid TOTP code' });
      }
    }

    // Generate token
    const token = generateToken(user);

    logAudit(user.id, 'LOGIN_SUCCESS', 'user', user.id, {}, req.ip);

    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        totpEnabled: !!user.totp_enabled,
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.errors[0].message });
    }
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Verify token endpoint
authRouter.get('/verify', authenticateToken, (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT id, username, totp_enabled FROM users WHERE id = ?').get(req.user.id);

  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  res.json({
    user: {
      id: user.id,
      username: user.username,
      totpEnabled: !!user.totp_enabled,
    },
  });
});

// Logout (just for audit logging, token invalidation is client-side)
authRouter.post('/logout', authenticateToken, (req, res) => {
  logAudit(req.user.id, 'LOGOUT', 'user', req.user.id, {}, req.ip);
  res.json({ success: true });
});
