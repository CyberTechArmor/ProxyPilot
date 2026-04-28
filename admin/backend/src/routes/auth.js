import { Router } from 'express';
import bcrypt from 'bcryptjs';
import * as OTPAuth from 'otpauth';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import { getDb, logAudit } from '../db.js';
import { generateToken, authenticateToken } from '../middleware/auth.js';
import { encryptSecret, decryptSecret } from '../lib/secrets.js';

// Account lockout knobs. Defaults: after 10 failed login attempts
// inside a 30-minute window the user is locked for 30 minutes. The
// rate limiter on /api/auth/login (10 req / 15 min) is the first
// line of defence; lockout is the second, so distributed brute-force
// against a single account hits a real wall even with a botnet.
const LOGIN_MAX_FAILURES = parseInt(process.env.LOGIN_MAX_FAILURES || '10', 10);
const LOGIN_FAILURE_WINDOW_MIN = parseInt(process.env.LOGIN_FAILURE_WINDOW_MIN || '30', 10);
const LOGIN_LOCKOUT_MIN = parseInt(process.env.LOGIN_LOCKOUT_MIN || '30', 10);

// Returns { locked: true, retryAfterSec } if user.locked_until is in
// the future, else { locked: false }. Pass `null` for users that
// don't exist (typo'd usernames) — safe no-op.
function checkLockout(user) {
  if (!user || !user.locked_until) return { locked: false };
  const untilMs = Date.parse(user.locked_until);
  if (!Number.isFinite(untilMs) || untilMs <= Date.now()) return { locked: false };
  return { locked: true, retryAfterSec: Math.ceil((untilMs - Date.now()) / 1000), until: user.locked_until };
}

// Record a failed login. Increments failed_attempts, refreshes
// last_failed_at, and — if the new count crosses the threshold and
// the previous failure was inside the window — sets locked_until.
// If the previous failure was OUTSIDE the window, resets the counter
// to 1 (fresh streak) before re-checking.
function recordLoginFailure(db, user, req) {
  if (!user) return;
  const now = Date.now();
  const prevFailedAt = user.last_failed_at ? Date.parse(user.last_failed_at) : 0;
  const windowMs = LOGIN_FAILURE_WINDOW_MIN * 60 * 1000;
  let newCount = (user.failed_attempts || 0) + 1;
  if (prevFailedAt && now - prevFailedAt > windowMs) {
    newCount = 1; // start a fresh streak
  }

  let lockedUntil = null;
  if (newCount >= LOGIN_MAX_FAILURES) {
    lockedUntil = new Date(now + LOGIN_LOCKOUT_MIN * 60 * 1000).toISOString();
  }

  db.prepare(
    `UPDATE users
        SET failed_attempts = ?,
            last_failed_at  = CURRENT_TIMESTAMP,
            locked_until    = ?
      WHERE id = ?`
  ).run(newCount, lockedUntil, user.id);

  if (lockedUntil) {
    logAudit(
      null,
      'LOGIN_LOCKOUT',
      'user',
      user.id,
      { failed_attempts: newCount, locked_until: lockedUntil },
      req.ip,
    );
  }
}

// Reset failed_attempts on a clean win.
function resetLoginFailures(db, userId) {
  db.prepare(
    `UPDATE users
        SET failed_attempts = 0, last_failed_at = NULL, locked_until = NULL
      WHERE id = ?`
  ).run(userId);
}

// Cookie defaults shared by login/setup/logout. HttpOnly on pp_token
// prevents XSS-driven theft; SameSite=Strict prevents cross-site
// abuse; Secure is required in production where HTTPS is enforced.
function authCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
    maxAge: 24 * 60 * 60 * 1000, // 24h, matches JWT TTL
  };
}

// CSRF cookie is intentionally NOT httpOnly so the frontend JS can
// read it and echo via X-CSRF-Token (double-submit pattern).
function csrfCookieOptions() {
  return {
    httpOnly: false,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
    maxAge: 24 * 60 * 60 * 1000,
  };
}

function setAuthCookies(res, token) {
  res.cookie('pp_token', token, authCookieOptions());
  res.cookie('pp_csrf', crypto.randomBytes(32).toString('hex'), csrfCookieOptions());
}

function clearAuthCookies(res) {
  res.clearCookie('pp_token', { path: '/' });
  res.clearCookie('pp_csrf', { path: '/' });
}

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

// Check if initial setup is needed (public endpoint - no auth required)
authRouter.get('/setup-status', (req, res) => {
  const db = getDb();
  // Setup is needed if any admin user has an empty password_hash
  const needsSetup = db.prepare(
    "SELECT id, username FROM users WHERE role = 'admin' AND (password_hash = '' OR password_hash IS NULL) LIMIT 1"
  ).get();

  res.json({
    needsSetup: !!needsSetup,
    username: needsSetup?.username || null,
  });
});

// Initial setup endpoint - set password for first-time admin (public, no auth required)
const initialSetupSchema = z.object({
  username: z.string().min(1, 'Username is required'),
  newPassword: z.string().min(12, 'Password must be at least 12 characters'),
  confirmPassword: z.string().min(1, 'Password confirmation is required'),
});

authRouter.post('/initial-setup', async (req, res) => {
  try {
    const { username, newPassword, confirmPassword } = initialSetupSchema.parse(req.body);
    const db = getDb();

    if (newPassword !== confirmPassword) {
      return res.status(400).json({ error: 'Passwords do not match' });
    }

    // Only allow setup for admin users with no password set
    const user = db.prepare(
      "SELECT * FROM users WHERE username = ? AND role = 'admin' AND (password_hash = '' OR password_hash IS NULL)"
    ).get(username);

    if (!user) {
      return res.status(400).json({ error: 'Initial setup is not available for this user' });
    }

    // Hash and save the new password
    const passwordHash = await bcrypt.hash(newPassword, 12);
    db.prepare(
      'UPDATE users SET password_hash = ?, password_change_required = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
    ).run(passwordHash, user.id);

    logAudit(user.id, 'INITIAL_PASSWORD_SET', 'user', user.id, {}, req.ip);

    // Generate token so user is logged in immediately (still needs TOTP setup)
    const token = generateToken(user, { ip: req.ip, userAgent: req.headers["user-agent"] });
    setAuthCookies(res, token);

    res.json({
      success: true,
      message: 'Password set successfully. Please set up two-factor authentication.',
      // token still returned in body for one transition release so
      // existing non-browser clients keep working. Browser clients
      // ignore it and use the httpOnly cookie set above.
      token,
      user: {
        id: user.id,
        username: user.username,
        displayName: user.display_name,
        role: user.role || 'admin',
        totpEnabled: false,
        passwordChangeRequired: false,
      },
      // Include TOTP setup info so user can set it up right away
      totpSetupRequired: true,
      totpSecret: (() => {
        const secret = new OTPAuth.Secret({ size: 20 });
        const totp = new OTPAuth.TOTP({
          issuer: 'ProxyPilot',
          label: username,
          algorithm: 'SHA1',
          digits: 6,
          period: 30,
          secret: secret,
        });
        return { secret: secret.base32, uri: totp.toString() };
      })(),
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.errors[0].message });
    }
    console.error('Initial setup error:', error);
    res.status(500).json({ error: 'Setup failed' });
  }
});

// Complete TOTP setup after initial password setup (requires token from initial-setup)
authRouter.post('/complete-totp-setup', authenticateToken, async (req, res) => {
  try {
    const { totpCode, totpSecret, registerDevice } = z.object({
      totpCode: z.string().length(6, 'TOTP code must be 6 digits'),
      totpSecret: z.string().min(16, 'Invalid secret'),
      registerDevice: z.boolean().optional(),
    }).parse(req.body);

    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Verify the TOTP code
    const totp = new OTPAuth.TOTP({
      issuer: 'ProxyPilot',
      label: user.username,
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret: OTPAuth.Secret.fromBase32(totpSecret),
    });

    const delta = totp.validate({ token: totpCode, window: 1 });
    if (delta === null) {
      return res.status(401).json({ error: 'Invalid TOTP code. Please try again.' });
    }

    // Save TOTP secret (encrypted at rest)
    db.prepare('UPDATE users SET totp_secret = ?, totp_enabled = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(encryptSecret(totpSecret), user.id);

    logAudit(user.id, 'TOTP_SETUP', 'user', user.id, {}, req.ip);

    // Register device if requested
    if (registerDevice) {
      const requestFingerprint = generateDeviceFingerprint(req);
      const deviceId = uuidv4();
      const deviceName = getDeviceName(req.headers['user-agent']);

      try {
        db.prepare(`
          INSERT INTO authenticated_devices (id, user_id, device_name, device_fingerprint, user_agent, ip_address)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(deviceId, user.id, deviceName, requestFingerprint, req.headers['user-agent'], req.ip);
        logAudit(user.id, 'DEVICE_REGISTERED', 'device', deviceId, { deviceName }, req.ip);
      } catch (e) {
        // Ignore duplicate
      }
    }

    // Generate fresh token with updated user info
    const freshUser = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    const token = generateToken(freshUser, { ip: req.ip, userAgent: req.headers["user-agent"] });
    setAuthCookies(res, token);

    res.json({
      success: true,
      message: 'Two-factor authentication set up successfully!',
      token,
      user: {
        id: freshUser.id,
        username: freshUser.username,
        displayName: freshUser.display_name,
        role: freshUser.role || 'admin',
        totpEnabled: true,
        passwordChangeRequired: false,
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.errors[0].message });
    }
    console.error('TOTP setup error:', error);
    res.status(500).json({ error: 'TOTP setup failed' });
  }
});

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

    // Lockout check — runs BEFORE password compare so a locked account
    // doesn't reveal whether the password was correct via timing.
    const lockState = checkLockout(user);
    if (lockState.locked) {
      return res
        .status(429)
        .set('Retry-After', String(lockState.retryAfterSec))
        .json({
          error: 'Account temporarily locked due to repeated failed login attempts.',
          lockedUntil: lockState.until,
          retryAfterSec: lockState.retryAfterSec,
        });
    }

    // Check if user needs initial setup (empty password)
    if (!user.password_hash) {
      return res.status(401).json({
        error: 'Initial setup required. Please set your password.',
        setupRequired: true,
      });
    }

    // Verify password
    const passwordValid = await bcrypt.compare(password, user.password_hash);
    if (!passwordValid) {
      recordLoginFailure(db, user, req);
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

        // Generate token + set cookies (canonical browser path)
        resetLoginFailures(db, user.id);
        const token = generateToken(user, { ip: req.ip, userAgent: req.headers["user-agent"] });
        setAuthCookies(res, token);
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
        secret: OTPAuth.Secret.fromBase32(decryptSecret(user.totp_secret)),
      });

      const delta = totp.validate({ token: totpCode, window: 1 });
      if (delta === null) {
        recordLoginFailure(db, user, req);
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
        recordLoginFailure(db, user, req);
        logAudit(null, 'LOGIN_FAILED', 'user', user.id, { reason: 'Invalid TOTP setup code' }, req.ip);
        return res.status(401).json({
          error: 'Invalid TOTP code. Please scan the QR code and try again.',
          totpSetupRequired: true,
          totpSecret: totpSetupSecret,
          totpUri: totp.toString(),
          deviceFingerprint: requestFingerprint,
        });
      }

      // Save the TOTP secret to the user (encrypted at rest)
      db.prepare('UPDATE users SET totp_secret = ?, totp_enabled = 1 WHERE id = ?')
        .run(encryptSecret(totpSetupSecret), user.id);

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

    // Generate token + set cookies (canonical browser path)
    resetLoginFailures(db, user.id);
    const token = generateToken(user, { ip: req.ip, userAgent: req.headers["user-agent"] });
    setAuthCookies(res, token);

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

// Sudo-mode re-auth. Caller must already be authenticated AND must
// re-prove password + TOTP. On success we set sudo_until on the
// current session row to NOW + SUDO_GRANT_HOURS (default 4h). The
// requireSudo middleware (next commit) checks this column on every
// destructive endpoint; expiry is sliding because that middleware
// re-arms sudo_until on every successful sudo-protected call.
//
// Failures here count toward the J.2 lockout machinery just like a
// regular login fail — same threat model (an attacker who got a
// session token still has to clear password + TOTP to take a
// destructive action).
const SUDO_GRANT_HOURS = parseFloat(process.env.SUDO_GRANT_HOURS || '4');

authRouter.post('/sudo', authenticateToken, async (req, res) => {
  try {
    const { password, totpCode } = req.body || {};
    if (!password || !totpCode) {
      return res.status(400).json({ error: 'password and totpCode are required' });
    }
    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!user) return res.status(401).json({ error: 'User not found' });

    const lockState = checkLockout(user);
    if (lockState.locked) {
      return res
        .status(429)
        .set('Retry-After', String(lockState.retryAfterSec))
        .json({
          error: 'Account temporarily locked due to repeated failed sudo attempts.',
          lockedUntil: lockState.until,
          retryAfterSec: lockState.retryAfterSec,
        });
    }

    const passwordValid = await bcrypt.compare(password, user.password_hash);
    if (!passwordValid) {
      recordLoginFailure(db, user, req);
      logAudit(req.user.id, 'SUDO_DENIED', 'user', req.user.id, { reason: 'Invalid password' }, req.ip);
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const totp = new OTPAuth.TOTP({
      issuer: 'ProxyPilot',
      label: user.username,
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret: OTPAuth.Secret.fromBase32(decryptSecret(user.totp_secret)),
    });
    const delta = totp.validate({ token: totpCode, window: 1 });
    if (delta === null) {
      recordLoginFailure(db, user, req);
      logAudit(req.user.id, 'SUDO_DENIED', 'user', req.user.id, { reason: 'Invalid TOTP' }, req.ip);
      return res.status(401).json({ error: 'Invalid TOTP code' });
    }

    resetLoginFailures(db, user.id);
    const sudoUntilISO = new Date(Date.now() + SUDO_GRANT_HOURS * 60 * 60 * 1000).toISOString();
    db.prepare(
      `UPDATE sessions SET sudo_until = ? WHERE id = ? AND revoked_at IS NULL`
    ).run(sudoUntilISO, req.user.jti);
    logAudit(req.user.id, 'SUDO_GRANTED', 'session', req.user.jti, { sudo_until: sudoUntilISO }, req.ip);

    res.json({ success: true, sudoUntil: sudoUntilISO });
  } catch (e) {
    console.error('sudo error:', e);
    res.status(500).json({ error: 'Internal error' });
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

// Logout — revokes the current session row server-side AND clears the
// auth cookies on the browser side. After M.2, JWT verification fails
// the moment revoked_at is set, so even if the token is exfiltrated
// (despite httpOnly + SameSite=Strict) it cannot be replayed past this
// point. Idempotent: a missing or already-revoked row is a no-op.
authRouter.post('/logout', authenticateToken, (req, res) => {
  const db = getDb();
  if (req.user?.jti) {
    db.prepare(
      `UPDATE sessions
          SET revoked_at = CURRENT_TIMESTAMP
        WHERE id = ? AND revoked_at IS NULL`
    ).run(req.user.jti);
  }
  logAudit(req.user.id, 'LOGOUT', 'user', req.user.id, { jti: req.user.jti }, req.ip);
  clearAuthCookies(res);
  res.json({ success: true });
});
