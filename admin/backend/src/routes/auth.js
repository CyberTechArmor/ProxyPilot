import { Router } from 'express';
import bcrypt from 'bcryptjs';
import * as OTPAuth from 'otpauth';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import { getDb, logAudit } from '../db.js';
import { generateToken, authenticateToken } from '../middleware/auth.js';

export const authRouter = Router();

// Generate a device fingerprint from request headers
function generateDeviceFingerprint(req) {
  const components = [
    req.headers['user-agent'] || '',
    req.headers['accept-language'] || '',
    req.headers['accept-encoding'] || '',
  ].join('|');
  return crypto.createHash('sha256').update(components).digest('hex').substring(0, 32);
}

// Get device name from user agent
function getDeviceName(userAgent) {
  if (!userAgent) return 'Unknown Device';

  // Parse browser
  let browser = 'Browser';
  if (userAgent.includes('Firefox')) browser = 'Firefox';
  else if (userAgent.includes('Chrome') && !userAgent.includes('Edg')) browser = 'Chrome';
  else if (userAgent.includes('Safari') && !userAgent.includes('Chrome')) browser = 'Safari';
  else if (userAgent.includes('Edg')) browser = 'Edge';

  // Parse OS
  let os = 'Unknown';
  if (userAgent.includes('Windows')) os = 'Windows';
  else if (userAgent.includes('Mac OS')) os = 'macOS';
  else if (userAgent.includes('Linux')) os = 'Linux';
  else if (userAgent.includes('Android')) os = 'Android';
  else if (userAgent.includes('iPhone') || userAgent.includes('iPad')) os = 'iOS';

  return `${browser} on ${os}`;
}

// Validation schemas
const loginSchema = z.object({
  username: z.string().min(1, 'Username is required'),
  password: z.string().min(1, 'Password is required'),
  totpCode: z.string().length(6, 'TOTP code must be 6 digits').optional().or(z.literal('')),
  totpSetupSecret: z.string().optional(), // For users setting up TOTP for the first time
  deviceFingerprint: z.string().optional(), // For trusted device login
  registerDevice: z.boolean().optional(), // Whether to register this device as trusted
});

// Login endpoint - TOTP is mandatory for all users, but can skip for trusted devices
authRouter.post('/login', async (req, res) => {
  try {
    const { username, password, totpCode, totpSetupSecret, deviceFingerprint, registerDevice } = loginSchema.parse(req.body);
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

    // Generate fingerprint from request
    const requestFingerprint = deviceFingerprint || generateDeviceFingerprint(req);

    // Check if this is a trusted device
    const trustedDevice = db.prepare(`
      SELECT * FROM authenticated_devices
      WHERE user_id = ? AND device_fingerprint = ?
    `).get(user.id, requestFingerprint);

    // Check if user has TOTP set up
    if (user.totp_enabled && user.totp_secret) {
      // If trusted device, allow login without TOTP
      if (trustedDevice) {
        // Update last used timestamp
        db.prepare(`
          UPDATE authenticated_devices
          SET last_used_at = CURRENT_TIMESTAMP, ip_address = ?
          WHERE id = ?
        `).run(req.ip, trustedDevice.id);

        // Generate token
        const token = generateToken(user);
        logAudit(user.id, 'LOGIN_SUCCESS_TRUSTED_DEVICE', 'user', user.id, { deviceName: trustedDevice.device_name }, req.ip);

        return res.json({
          token,
          user: {
            id: user.id,
            username: user.username,
            displayName: user.display_name,
            role: user.role || 'admin',
            totpEnabled: true,
            passwordChangeRequired: !!user.password_change_required,
          },
          trustedDevice: true,
        });
      }

      // Not a trusted device - require TOTP
      if (!totpCode) {
        return res.status(401).json({
          error: 'TOTP code required',
          totpRequired: true,
          deviceFingerprint: requestFingerprint, // Send back for device registration
        });
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
        return res.status(401).json({
          error: 'Invalid TOTP code',
          totpRequired: true,
          deviceFingerprint: requestFingerprint,
        });
      }

      // TOTP verified - register device if requested
      if (registerDevice) {
        const deviceId = uuidv4();
        const deviceName = getDeviceName(req.headers['user-agent']);

        try {
          db.prepare(`
            INSERT INTO authenticated_devices (id, user_id, device_name, device_fingerprint, user_agent, ip_address)
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(deviceId, user.id, deviceName, requestFingerprint, req.headers['user-agent'], req.ip);

          logAudit(user.id, 'DEVICE_REGISTERED', 'device', deviceId, { deviceName }, req.ip);
        } catch (e) {
          // Device might already exist, update it
          db.prepare(`
            UPDATE authenticated_devices
            SET last_used_at = CURRENT_TIMESTAMP, ip_address = ?, user_agent = ?
            WHERE user_id = ? AND device_fingerprint = ?
          `).run(req.ip, req.headers['user-agent'], user.id, requestFingerprint);
        }
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
          deviceFingerprint: requestFingerprint,
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
          deviceFingerprint: requestFingerprint,
        });
      }

      // Save the TOTP secret to the user
      db.prepare('UPDATE users SET totp_secret = ?, totp_enabled = 1 WHERE id = ?')
        .run(totpSetupSecret, user.id);

      logAudit(user.id, 'TOTP_SETUP', 'user', user.id, {}, req.ip);

      // Register device on first TOTP setup if requested
      if (registerDevice) {
        const deviceId = uuidv4();
        const deviceName = getDeviceName(req.headers['user-agent']);

        db.prepare(`
          INSERT INTO authenticated_devices (id, user_id, device_name, device_fingerprint, user_agent, ip_address)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(deviceId, user.id, deviceName, requestFingerprint, req.headers['user-agent'], req.ip);

        logAudit(user.id, 'DEVICE_REGISTERED', 'device', deviceId, { deviceName }, req.ip);
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
