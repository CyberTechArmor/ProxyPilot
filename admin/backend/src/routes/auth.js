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
  totpCode: z.string().length(6, 'TOTP code must be 6 digits').optional().or(z.literal('')),
  totpSetupSecret: z.string().optional(), // For users setting up TOTP for the first time
});

// Login endpoint - TOTP is mandatory for all users
authRouter.post('/login', async (req, res) => {
  try {
    const { username, password, totpCode, totpSetupSecret } = loginSchema.parse(req.body);
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

    // Check if user has TOTP set up
    if (user.totp_enabled && user.totp_secret) {
      // User has TOTP - require code
      if (!totpCode) {
        return res.status(401).json({ error: 'TOTP code required', totpRequired: true });
      }

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
        return res.status(401).json({ error: 'Invalid TOTP code', totpRequired: true });
      }
    } else {
      // User needs to set up TOTP - mandatory for all users
      if (!totpCode || !totpSetupSecret) {
        // Generate new TOTP secret and return QR code
        const secret = new OTPAuth.Secret({ size: 20 });
        const totp = new OTPAuth.TOTP({
          issuer: 'ProxyPilot',
          label: username,
          algorithm: 'SHA1',
          digits: 6,
          period: 30,
          secret: secret,
        });

        return res.status(401).json({
          error: 'TOTP setup required',
          totpSetupRequired: true,
          totpSecret: secret.base32,
          totpUri: totp.toString(),
        });
      }

      // Verify the setup code
      const totp = new OTPAuth.TOTP({
        issuer: 'ProxyPilot',
        label: username,
        algorithm: 'SHA1',
        digits: 6,
        period: 30,
        secret: OTPAuth.Secret.fromBase32(totpSetupSecret),
      });

      const delta = totp.validate({ token: totpCode, window: 1 });
      if (delta === null) {
        logAudit(null, 'LOGIN_FAILED', 'user', user.id, { reason: 'Invalid TOTP setup code' }, req.ip);
        return res.status(401).json({
          error: 'Invalid TOTP code. Please scan the QR code and try again.',
          totpSetupRequired: true,
          totpSecret: totpSetupSecret,
          totpUri: totp.toString(),
        });
      }

      // Save the TOTP secret to the user
      db.prepare('UPDATE users SET totp_secret = ?, totp_enabled = 1 WHERE id = ?')
        .run(totpSetupSecret, user.id);

      logAudit(user.id, 'TOTP_SETUP', 'user', user.id, {}, req.ip);
    }

    // Generate token
    const token = generateToken(user);

    logAudit(user.id, 'LOGIN_SUCCESS', 'user', user.id, {}, req.ip);

    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        displayName: user.display_name,
        role: user.role || 'admin',
        totpEnabled: true, // Always true after successful login
        passwordChangeRequired: !!user.password_change_required,
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
  const user = db.prepare('SELECT id, username, display_name, role, totp_enabled, password_change_required FROM users WHERE id = ?').get(req.user.id);

  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  res.json({
    user: {
      id: user.id,
      username: user.username,
      displayName: user.display_name,
      role: user.role || 'admin',
      totpEnabled: !!user.totp_enabled,
      passwordChangeRequired: !!user.password_change_required,
    },
  });
});

// Logout (just for audit logging, token invalidation is client-side)
authRouter.post('/logout', authenticateToken, (req, res) => {
  logAudit(req.user.id, 'LOGOUT', 'user', req.user.id, {}, req.ip);
  res.json({ success: true });
});
