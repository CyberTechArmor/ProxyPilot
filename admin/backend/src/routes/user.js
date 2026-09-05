import { Router } from 'express';
import bcrypt from 'bcryptjs';
import * as OTPAuth from 'otpauth';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { getDb, logAudit, getSetting, setSetting } from '../db.js';
import { requireAdmin, requireSudo, getUserPermissions } from '../middleware/auth.js';
import { encryptSecret, decryptSecret } from '../lib/secrets.js';
import { checkSuperadminProtection } from '../lib/superadmin.js';
import {
  generateAuthenticationOptions,
  putChallenge,
  getRpId,
  listCredentialDescriptors,
  listCredentialsForUI,
  deleteCredentialByDbId,
  renameCredentialByDbId,
  userHasPasskey,
} from '../lib/webauthn.js';
import { verifyConfirmationFactor } from '../lib/auth-confirm.js';
import { ldapAuthenticate } from '../lib/ldap.js';
import { execSync, spawn } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { checkForUpdates, installedState, startUpdate, updateStatus } from '../lib/self-update.js';
import { flagsFromOptions, isUpdateId, mapAgentErrorToHttp, sanitizeRequestedBy, updateStartRefusal } from '../lib/self-update-logic.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '..', '..', '..', '..');

// Default GitHub repo
const DEFAULT_GITHUB_REPO = 'CyberTechArmor/ProxyPilot';

// Get version from package.json
function getPackageVersion() {
  // Resolve the backend's OWN package.json relative to this module, not to a
  // guessed repo root — inside the Docker image the source lives at
  // /app/backend (no admin/ prefix), so the PROJECT_ROOT-based path missed
  // and every deployed install reported the '1.0.0' fallback in the sidebar,
  // making real updates look like they never installed (operator report).
  // The repo-root path is kept as a fallback for unusual layouts.
  const candidates = [
    fileURLToPath(new URL('../../package.json', import.meta.url)),
    join(PROJECT_ROOT, 'admin', 'backend', 'package.json'),
  ];
  for (const packagePath of candidates) {
    try {
      if (existsSync(packagePath)) {
        const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
        if (pkg.version) return pkg.version;
      }
    } catch (e) {
      console.error('Error reading package.json:', e);
    }
  }
  return '1.0.0';
}

// Get current installed version from database (or initialize from package.json)
export function getCurrentVersion() {
  // Try to get from database first
  const savedVersion = getSetting('installed_version');
  if (savedVersion) {
    return savedVersion;
  }

  // Not in database yet, read from package.json and save it
  const packageVersion = getPackageVersion();
  setSetting('installed_version', packageVersion);
  console.log(`Initialized installed version in database: v${packageVersion}`);
  return packageVersion;
}

// Sync version on server startup (updates DB if package.json version changed)
function syncVersionOnStartup() {
  try {
    const packageVersion = getPackageVersion();
    const savedVersion = getSetting('installed_version');

    if (savedVersion !== packageVersion) {
      setSetting('installed_version', packageVersion);
      if (savedVersion) {
        console.log(`Version synced: v${savedVersion} -> v${packageVersion}`);
      } else {
        console.log(`Version initialized: v${packageVersion}`);
      }
    }
    return packageVersion;
  } catch (e) {
    // Database might not be initialized yet, will sync on first version request
    console.log('Version sync deferred (database not ready)');
    return null;
  }
}

// Try to initialize version on module load (may fail if DB not ready)
syncVersionOnStartup();

// Get GitHub repo from git remote or settings
export function getGitHubRepo() {
  // First check settings
  const savedRepo = getSetting('github_repo');
  if (savedRepo) return savedRepo;

  // Try to get from git remote
  try {
    const remoteUrl = execSync('git remote get-url origin', {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      timeout: 5000,
    }).trim();

    // Parse GitHub URL (supports https and ssh formats)
    const httpsMatch = remoteUrl.match(/github\.com\/([^\/]+\/[^\/\.]+)/);
    const sshMatch = remoteUrl.match(/git@github\.com:([^\/]+\/[^\/\.]+)/);
    const repo = httpsMatch?.[1] || sshMatch?.[1] || null;
    if (repo) return repo.replace(/\.git$/, '');
  } catch (e) {
    // Git not available or not a git repo
  }

  return DEFAULT_GITHUB_REPO;
}

export const userRouter = Router();

// Generate strong random password
function generatePassword(length = 24) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*';
  let password = '';
  const bytes = crypto.randomBytes(length * 4);
  for (let i = 0; i < length; i++) {
    const randomValue = bytes.readUInt32BE(i * 4);
    password += chars[randomValue % chars.length];
  }
  return password;
}

// Validation schemas
const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required'),
  newPassword: z.string().min(12, 'Password must be at least 12 characters'),
  totpCode: z.string().length(6, 'TOTP code must be 6 digits'),
});

const setupTotpSchema = z.object({
  currentPassword: z.string().min(1, 'Password is required'),
  totpCode: z.string().length(6, 'TOTP code must be 6 digits'),
});

const verifyTotpSchema = z.object({
  totpCode: z.string().length(6, 'TOTP code must be 6 digits'),
});

// Get user profile
userRouter.get('/profile', (req, res) => {
  try {
    const db = getDb();
    const user = db.prepare(`
      SELECT id, username, display_name, role, auth_source, is_superadmin, totp_enabled, created_at, updated_at
      FROM users WHERE id = ?
    `).get(req.user.id);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({
      user: {
        id: user.id,
        username: user.username,
        displayName: user.display_name,
        role: user.role || 'admin',
        authSource: user.auth_source || 'local',
        isSuperadmin: user.is_superadmin === 1,
        permissions: getUserPermissions(user.id),
        totpEnabled: !!user.totp_enabled,
        hasPasskey: userHasPasskey(user.id),
        createdAt: user.created_at,
        updatedAt: user.updated_at,
      },
    });
  } catch (error) {
    console.error('Error fetching profile:', error);
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

// Passkey management. List / rename / delete are all gated on
// requireSudo so the credential set can't be tampered with from a
// stolen-but-not-elevated session. The challenge endpoint is the
// per-action begin used by destructive dialogs (Step 7).
userRouter.get('/passkeys', (req, res) => {
  try {
    res.json({ passkeys: listCredentialsForUI(req.user.id) });
  } catch (e) {
    console.error('list passkeys error:', e);
    res.status(500).json({ error: 'Failed to list passkeys' });
  }
});

userRouter.put('/passkeys/:id', requireSudo, (req, res) => {
  try {
    const { label } = z.object({ label: z.string().min(1).max(64) }).parse(req.body);
    const dbId = parseInt(req.params.id, 10);
    if (!Number.isFinite(dbId)) return res.status(400).json({ error: 'Bad id' });
    const changes = renameCredentialByDbId(req.user.id, dbId, label);
    if (!changes) return res.status(404).json({ error: 'Passkey not found' });
    logAudit(req.user.id, 'PASSKEY_RENAMED', 'passkey', String(dbId), { label }, req.ip);
    res.json({ success: true });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.errors[0].message });
    }
    console.error('rename passkey error:', error);
    res.status(500).json({ error: 'Failed to rename passkey' });
  }
});

// Passkey delete. EITHER a fresh TOTP code OR a fresh passkey
// assertion proves the operator is in front of the device. We DO NOT
// allow deleting your only TOTP — TOTP is the floor — but deleting
// the last passkey just falls back to TOTP for sudo, so no minimum
// passkey count is enforced here.
userRouter.delete('/passkeys/:id', async (req, res) => {
  try {
    const dbId = parseInt(req.params.id, 10);
    if (!Number.isFinite(dbId)) return res.status(400).json({ error: 'Bad id' });

    const schema = z.object({
      totpCode: z.string().length(6).optional(),
      passkeyAssertion: z.object({
        challengeId: z.string(),
        response: z.any(),
      }).optional(),
    }).refine((v) => v.totpCode || v.passkeyAssertion, { message: 'Confirm with TOTP or passkey' });
    const { totpCode, passkeyAssertion } = schema.parse(req.body || {});

    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const verified = await verifyConfirmationFactor({
      req, user,
      totpCode, passkeyAssertion,
    });
    if (!verified.ok) {
      return res.status(401).json({ error: verified.error });
    }

    const changes = deleteCredentialByDbId(req.user.id, dbId);
    if (!changes) return res.status(404).json({ error: 'Passkey not found' });
    logAudit(req.user.id, 'PASSKEY_REVOKED', 'passkey', String(dbId), {}, req.ip);
    res.json({ success: true, hasPasskey: userHasPasskey(req.user.id) });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.errors[0].message });
    }
    console.error('delete passkey error:', error);
    res.status(500).json({ error: 'Failed to delete passkey' });
  }
});

// Per-action passkey challenge. Returns
// PublicKeyCredentialRequestOptions plus an opaque challengeId; the
// destructive endpoint validates the assertion against this challenge
// (single-use, 5-minute TTL) before going through.
userRouter.post('/passkey/challenge', (req, res) => {
  try {
    const allowCredentials = listCredentialDescriptors(req.user.id);
    if (allowCredentials.length === 0) {
      return res.status(400).json({ error: 'No passkeys registered.' });
    }
    return generateAuthenticationOptions({
      rpID: getRpId(req),
      allowCredentials,
      userVerification: 'preferred',
    }).then((options) => {
      const challengeId = uuidv4();
      putChallenge(`act:${challengeId}`, {
        challenge: options.challenge,
        userId: req.user.id,
      });
      res.json({ ...options, challengeId });
    }).catch((e) => {
      console.error('action passkey challenge error:', e);
      res.status(500).json({ error: 'Could not create challenge' });
    });
  } catch (e) {
    console.error('action passkey challenge error:', e);
    res.status(500).json({ error: 'Could not create challenge' });
  }
});


// Change password
userRouter.post('/change-password', async (req, res) => {
  try {
    const { currentPassword, newPassword, totpCode } = changePasswordSchema.parse(req.body);
    const db = getDb();

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Directory-backed accounts change their password in LDAP, not here.
    if (user.auth_source === 'ldap') {
      return res.status(400).json({ error: 'Your password is managed by the directory (LDAP) — change it there' });
    }

    // Verify current password
    const passwordValid = await bcrypt.compare(currentPassword, user.password_hash);
    if (!passwordValid) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    // Verify TOTP
    if (user.totp_enabled && user.totp_secret) {
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
        return res.status(401).json({ error: 'Invalid TOTP code' });
      }
    }

    // Hash new password
    const newPasswordHash = await bcrypt.hash(newPassword, 12);

    // Update password
    db.prepare(`
      UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(newPasswordHash, req.user.id);

    logAudit(req.user.id, 'PASSWORD_CHANGED', 'user', req.user.id, {}, req.ip);

    res.json({ success: true, message: 'Password changed successfully' });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.errors[0].message });
    }
    console.error('Error changing password:', error);
    res.status(500).json({ error: 'Failed to change password' });
  }
});

// Generate new TOTP secret (for setup/reset)
userRouter.post('/totp/generate', async (req, res) => {
  try {
    const { currentPassword } = z.object({
      currentPassword: z.string().min(1, 'Password is required'),
    }).parse(req.body);

    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Verify password — against the directory for LDAP-backed accounts
    // (they have no local hash), locally otherwise.
    const passwordValid = user.auth_source === 'ldap'
      ? (await ldapAuthenticate(user.username, currentPassword, { db })).ok
      : await bcrypt.compare(currentPassword, user.password_hash);
    if (!passwordValid) {
      return res.status(401).json({ error: 'Password is incorrect' });
    }

    // Generate new TOTP secret
    const secret = new OTPAuth.Secret({ size: 20 });

    const totp = new OTPAuth.TOTP({
      issuer: 'ProxyPilot',
      label: user.username,
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret: secret,
    });

    const uri = totp.toString();

    res.json({
      secret: secret.base32,
      uri,
      qrData: uri,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.errors[0].message });
    }
    console.error('Error generating TOTP:', error);
    res.status(500).json({ error: 'Failed to generate TOTP secret' });
  }
});

// Verify and save new TOTP
userRouter.post('/totp/verify', async (req, res) => {
  try {
    const { totpCode, secret } = z.object({
      totpCode: z.string().length(6, 'TOTP code must be 6 digits'),
      secret: z.string().min(16, 'Invalid secret'),
    }).parse(req.body);

    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Verify the TOTP code with the new secret
    const totp = new OTPAuth.TOTP({
      issuer: 'ProxyPilot',
      label: user.username,
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret: OTPAuth.Secret.fromBase32(secret),
    });

    const delta = totp.validate({ token: totpCode, window: 1 });
    if (delta === null) {
      return res.status(401).json({ error: 'Invalid TOTP code' });
    }

    // Save the new secret (encrypted at rest)
    db.prepare(`
      UPDATE users SET totp_secret = ?, totp_enabled = 1, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(encryptSecret(secret), req.user.id);

    logAudit(req.user.id, 'TOTP_UPDATED', 'user', req.user.id, {}, req.ip);

    res.json({ success: true, message: 'TOTP updated successfully' });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.errors[0].message });
    }
    console.error('Error verifying TOTP:', error);
    res.status(500).json({ error: 'Failed to verify TOTP' });
  }
});

// ==========================================
// Device Management Endpoints
// ==========================================

// List authenticated devices for current user
userRouter.get('/devices', (req, res) => {
  try {
    const db = getDb();
    const devices = db.prepare(`
      SELECT id, device_name, user_agent, ip_address, last_used_at, created_at
      FROM authenticated_devices
      WHERE user_id = ?
      ORDER BY last_used_at DESC
    `).all(req.user.id);

    res.json({ devices });
  } catch (error) {
    console.error('Error fetching devices:', error);
    res.status(500).json({ error: 'Failed to fetch devices' });
  }
});

// Revoke an authenticated device
userRouter.delete('/devices/:deviceId', async (req, res) => {
  try {
    const { totpCode, passkeyAssertion } = z.object({
      totpCode: z.string().length(6).optional(),
      passkeyAssertion: z.object({ challengeId: z.string(), response: z.any() }).optional(),
    }).refine((v) => v.totpCode || v.passkeyAssertion, { message: 'TOTP or passkey required' }).parse(req.body);

    const db = getDb();

    // Verify device belongs to user
    const device = db.prepare(`
      SELECT * FROM authenticated_devices WHERE id = ? AND user_id = ?
    `).get(req.params.deviceId, req.user.id);

    if (!device) {
      return res.status(404).json({ error: 'Device not found' });
    }

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    const verified = await verifyConfirmationFactor({ req, user, totpCode, passkeyAssertion });
    if (!verified.ok) return res.status(401).json({ error: verified.error });

    // Delete device
    db.prepare('DELETE FROM authenticated_devices WHERE id = ?').run(req.params.deviceId);

    logAudit(req.user.id, 'DEVICE_REVOKED', 'device', req.params.deviceId, { deviceName: device.device_name }, req.ip);

    res.json({ success: true, message: 'Device revoked successfully' });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.errors[0].message });
    }
    console.error('Error revoking device:', error);
    res.status(500).json({ error: 'Failed to revoke device' });
  }
});

// Revoke all devices except current one (logout everywhere else)
userRouter.post('/devices/revoke-all', async (req, res) => {
  try {
    const { totpCode, passkeyAssertion, keepCurrent } = z.object({
      totpCode: z.string().length(6).optional(),
      passkeyAssertion: z.object({ challengeId: z.string(), response: z.any() }).optional(),
      keepCurrent: z.string().optional(), // Device fingerprint to keep
    }).refine((v) => v.totpCode || v.passkeyAssertion, { message: 'TOTP or passkey required' }).parse(req.body);

    const db = getDb();

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    const verified = await verifyConfirmationFactor({ req, user, totpCode, passkeyAssertion });
    if (!verified.ok) return res.status(401).json({ error: verified.error });

    // Delete all devices except current
    if (keepCurrent) {
      db.prepare(`
        DELETE FROM authenticated_devices
        WHERE user_id = ? AND device_fingerprint != ?
      `).run(req.user.id, keepCurrent);
    } else {
      db.prepare('DELETE FROM authenticated_devices WHERE user_id = ?').run(req.user.id);
    }

    logAudit(req.user.id, 'ALL_DEVICES_REVOKED', 'user', req.user.id, { keptCurrent: !!keepCurrent }, req.ip);

    res.json({ success: true, message: 'All other devices have been logged out' });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.errors[0].message });
    }
    console.error('Error revoking devices:', error);
    res.status(500).json({ error: 'Failed to revoke devices' });
  }
});

// List the current user's active sessions. The current request's
// session is flagged in the response so the UI can render "this
// device" alongside the others. Revoked rows are filtered out.
userRouter.get('/sessions', (req, res) => {
  const db = getDb();
  const rows = db.prepare(
    `SELECT id, created_at, expires_at, last_used_at, ip, user_agent, sudo_until
       FROM sessions
      WHERE user_id = ? AND revoked_at IS NULL
        AND datetime(expires_at) > datetime('now')
      ORDER BY last_used_at DESC`
  ).all(req.user.id);
  const currentJti = req.user?.jti;
  res.json({
    sessions: rows.map((r) => ({ ...r, current: r.id === currentJti })),
  });
});

// Revoke a specific session by id. Operator-facing UX: clicking
// "log out" on one row in the sessions list. Refuses to revoke a
// session belonging to a different user.
userRouter.post('/sessions/:id/revoke', (req, res) => {
  const db = getDb();
  const row = db.prepare(`SELECT user_id FROM sessions WHERE id = ?`).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Session not found' });
  if (row.user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
  db.prepare(
    `UPDATE sessions SET revoked_at = CURRENT_TIMESTAMP
      WHERE id = ? AND revoked_at IS NULL`
  ).run(req.params.id);
  logAudit(req.user.id, 'SESSION_REVOKED', 'session', req.params.id, {}, req.ip);
  res.json({ success: true });
});

// Revoke every session for the current user EXCEPT the one making
// the request. Lets the operator nuke a stolen / leaked cookie from
// a known-good device without logging themselves out.
userRouter.post('/sessions/revoke-all-others', requireSudo, (req, res) => {
  const db = getDb();
  const currentJti = req.user?.jti || '';
  const result = db.prepare(
    `UPDATE sessions
        SET revoked_at = CURRENT_TIMESTAMP
      WHERE user_id = ? AND revoked_at IS NULL AND id <> ?`
  ).run(req.user.id, currentJti);
  logAudit(
    req.user.id,
    'SESSION_REVOKED',
    'session',
    'all-others',
    { revoked_count: result.changes, kept_jti: currentJti },
    req.ip,
  );
  res.json({ success: true, revoked_count: result.changes });
});

// Get audit log for current user
userRouter.get('/audit-log', (req, res) => {
  try {
    const db = getDb();
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const offset = parseInt(req.query.offset) || 0;

    const logs = db.prepare(`
      SELECT id, action, resource_type, resource_id, details, ip_address, created_at
      FROM audit_log
      WHERE user_id = ?
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `).all(req.user.id, limit, offset);

    const total = db.prepare('SELECT COUNT(*) as count FROM audit_log WHERE user_id = ?')
      .get(req.user.id).count;

    res.json({
      logs: logs.map(log => ({
        ...log,
        details: log.details ? JSON.parse(log.details) : null,
      })),
      total,
      limit,
      offset,
    });
  } catch (error) {
    console.error('Error fetching audit log:', error);
    res.status(500).json({ error: 'Failed to fetch audit log' });
  }
});

// ==========================================
// User Management Endpoints (Admin Only)
// ==========================================

// List all users
userRouter.get('/users', requireAdmin, (req, res) => {
  try {
    const db = getDb();
    const users = db.prepare(`
      SELECT id, username, display_name, role, auth_source, is_superadmin, totp_enabled, password_change_required, created_at, updated_at
      FROM users
      ORDER BY created_at DESC
    `).all();

    // One pass over user_permissions instead of a per-user query.
    const permsByUser = new Map();
    for (const row of db.prepare('SELECT user_id, permission FROM user_permissions ORDER BY permission').all()) {
      if (!permsByUser.has(row.user_id)) permsByUser.set(row.user_id, []);
      permsByUser.get(row.user_id).push(row.permission);
    }

    res.json({
      users: users.map(u => ({
        id: u.id,
        username: u.username,
        displayName: u.display_name,
        role: u.role || 'admin',
        authSource: u.auth_source || 'local',
        isSuperadmin: u.is_superadmin === 1,
        totpEnabled: !!u.totp_enabled,
        passwordChangeRequired: !!u.password_change_required,
        permissions: permsByUser.get(u.id) || [],
        createdAt: u.created_at,
        updatedAt: u.updated_at,
      })),
    });
  } catch (error) {
    console.error('Error listing users:', error);
    res.status(500).json({ error: 'Failed to list users' });
  }
});

// Create new user validation schema
const createUserSchema = z.object({
  username: z.string().min(3, 'Username must be at least 3 characters').max(50),
  displayName: z.string().max(100).optional(),
  role: z.enum(['admin', 'user']).default('user'),
});

// Create new user
userRouter.post('/users', requireAdmin, requireSudo, async (req, res) => {
  try {
    const { username, displayName, role } = createUserSchema.parse(req.body);
    const db = getDb();

    // Check if username already exists
    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (existing) {
      return res.status(400).json({ error: 'Username already exists' });
    }

    // Generate random password
    const password = generatePassword(24);
    const passwordHash = await bcrypt.hash(password, 12);

    // Create user
    const userId = uuidv4();
    db.prepare(`
      INSERT INTO users (id, username, display_name, password_hash, totp_secret, totp_enabled, role, password_change_required)
      VALUES (?, ?, ?, ?, '', 0, ?, 1)
    `).run(userId, username, displayName || null, passwordHash, role);

    logAudit(req.user.id, 'USER_CREATED', 'user', userId, { username, role }, req.ip);

    res.json({
      success: true,
      user: {
        id: userId,
        username,
        displayName,
        role,
        password, // Return the generated password (only time it's shown)
      },
      message: 'User created. Save the password - it will only be shown once!',
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.errors[0].message });
    }
    console.error('Error creating user:', error);
    res.status(500).json({ error: 'Failed to create user' });
  }
});

// Update user validation schema. 'pending' is the parked state for
// LDAP-provisioned accounts awaiting a manually-assigned role; an
// admin can also send a user back to it to revoke all access.
const updateUserSchema = z.object({
  displayName: z.string().max(100).optional(),
  role: z.enum(['admin', 'user', 'pending']).optional(),
  resetPassword: z.boolean().optional(),
});

// Update user
userRouter.put('/users/:id', requireAdmin, requireSudo, async (req, res) => {
  try {
    const { id } = req.params;
    const { displayName, role, resetPassword } = updateUserSchema.parse(req.body);
    const db = getDb();

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const isDemotion = (role === 'user' || role === 'pending') && user.role === 'admin';

    // Superadmin protection (ADR-007): a non-superadmin cannot demote a
    // superadmin (role admin -> user/pending). Actor's flag is read from
    // the DB — the JWT does not carry is_superadmin.
    if (isDemotion) {
      const actor = db.prepare('SELECT is_superadmin FROM users WHERE id = ?').get(req.user.id);
      const guard = checkSuperadminProtection({
        actorIsSuperadmin: actor?.is_superadmin === 1,
        targetIsSuperadmin: user.is_superadmin === 1,
        action: 'demote',
      });
      if (!guard.allowed) {
        return res.status(403).json({ error: guard.error });
      }
    }

    // Prevent demoting the last admin
    if (isDemotion) {
      const adminCount = db.prepare('SELECT COUNT(*) as count FROM users WHERE role = ?').get('admin').count;
      if (adminCount <= 1) {
        return res.status(400).json({ error: 'Cannot demote the last admin user' });
      }
    }

    // Directory-backed accounts have no local password to reset.
    if (resetPassword && user.auth_source === 'ldap') {
      return res.status(400).json({ error: 'This account authenticates via LDAP — its password is managed in the directory' });
    }

    let newPassword = null;
    if (resetPassword) {
      newPassword = generatePassword(24);
      const passwordHash = await bcrypt.hash(newPassword, 12);
      db.prepare(`
        UPDATE users SET password_hash = ?, password_change_required = 1, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(passwordHash, id);
    }

    // Update display name and role
    const updates = [];
    const params = [];
    if (displayName !== undefined) {
      updates.push('display_name = ?');
      params.push(displayName);
    }
    if (role !== undefined) {
      updates.push('role = ?');
      params.push(role);
    }

    if (updates.length > 0) {
      updates.push('updated_at = CURRENT_TIMESTAMP');
      params.push(id);
      db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    }

    logAudit(req.user.id, 'USER_UPDATED', 'user', id, { displayName, role, resetPassword }, req.ip);

    res.json({
      success: true,
      newPassword, // Only returned if password was reset
      message: resetPassword ? 'User updated. Save the new password - it will only be shown once!' : 'User updated',
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.errors[0].message });
    }
    console.error('Error updating user:', error);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

// Delete user. Gated on requireSudo (fresh password+TOTP or passkey
// within the sliding window), same as create/update. The old extra
// per-request TOTP check on top of requireSudo was removed: when the
// sudo modal interjected, the retried DELETE carried a by-then-expired
// TOTP code from the delete dialog, failed with a bare 401, and the
// frontend treated that as session expiry — the operator cycled
// through two verification passes and the user never got deleted.
userRouter.delete('/users/:id', requireAdmin, requireSudo, async (req, res) => {
  try {
    const { id } = req.params;
    const db = getDb();

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Prevent deleting yourself
    if (id === req.user.id) {
      return res.status(400).json({ error: 'Cannot delete your own account' });
    }

    // Superadmin protection (ADR-007): a non-superadmin cannot deactivate
    // (delete) a superadmin account.
    {
      const actor = db.prepare('SELECT is_superadmin FROM users WHERE id = ?').get(req.user.id);
      const guard = checkSuperadminProtection({
        actorIsSuperadmin: actor?.is_superadmin === 1,
        targetIsSuperadmin: user.is_superadmin === 1,
        action: 'deactivate',
      });
      if (!guard.allowed) {
        return res.status(403).json({ error: guard.error });
      }
    }

    // Prevent deleting the last admin
    if (user.role === 'admin') {
      const adminCount = db.prepare('SELECT COUNT(*) as count FROM users WHERE role = ?').get('admin').count;
      if (adminCount <= 1) {
        return res.status(400).json({ error: 'Cannot delete the last admin user' });
      }
    }

    // Delete user. Access/session/device/passkey rows cascade via their
    // FKs; audit_log, file_versions and service_config_versions reference
    // users(id) with NO delete action, so any user with a login history
    // would trip "FOREIGN KEY constraint failed" (the root cause of the
    // delete button silently failing). Detach those rows first — the
    // history itself is preserved, only the author link is cleared.
    const deleteUserTx = db.transaction(() => {
      db.prepare('UPDATE audit_log SET user_id = NULL WHERE user_id = ?').run(id);
      db.prepare('UPDATE file_versions SET created_by = NULL WHERE created_by = ?').run(id);
      db.prepare('UPDATE service_config_versions SET created_by = NULL WHERE created_by = ?').run(id);
      db.prepare('DELETE FROM users WHERE id = ?').run(id);
    });
    deleteUserTx();

    logAudit(req.user.id, 'USER_DELETED', 'user', id, { username: user.username }, req.ip);

    res.json({ success: true, message: 'User deleted' });
  } catch (error) {
    console.error('Error deleting user:', error);
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

// One-time sign-in link (migration 603): replaces reading a generated
// password over the phone. The user opens the URL, sets their OWN password,
// and signs in — TOTP enrollment still runs at first sign-in as usual.
// Consumed when the password is set; validation GETs never spend it, so
// email/SMS link previews are harmless. Also the manual password-reset path
// (the old password keeps working until the link is used). Admin + sudo,
// same bar as a password reset.
userRouter.post('/users/:id/login-link', requireAdmin, requireSudo, (req, res) => {
  try {
    const { id } = req.params;
    const db = getDb();
    const user = db.prepare('SELECT id, username, auth_source FROM users WHERE id = ?').get(id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if ((user.auth_source || 'local') !== 'local') {
      return res.status(409).json({ error: 'LDAP accounts sign in with their directory password — sign-in links are for local accounts.' });
    }
    const token = crypto.randomBytes(32).toString('base64url');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
    db.prepare(`
      INSERT INTO user_login_links (id, user_id, token_hash, created_by, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(uuidv4(), id, tokenHash, req.user.id, expiresAt);
    logAudit(req.user.id, 'USER_LOGIN_LINK_ISSUED', 'user', id, { username: user.username }, req.ip);
    res.json({ path: `/login#link=${token}`, expiresAt, username: user.username });
  } catch (error) {
    console.error('Error issuing sign-in link:', error);
    res.status(500).json({ error: 'Failed to issue the sign-in link' });
  }
});

// Get user's service access (includes folder access)
userRouter.get('/users/:id/access', requireAdmin, (req, res) => {
  try {
    const { id } = req.params;
    const db = getDb();

    const user = db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // If admin, they have access to everything
    if (user.role === 'admin') {
      return res.json({
        isAdmin: true,
        access: [],
        folderAccess: [],
        permissions: [],
        message: 'Admin users have full access to all services and folders',
      });
    }

    // Get service access. services.domain moved to service_http_routes when
    // multi-route support landed — the bare `s.domain` here made this whole
    // route 500 ("Failed to get user access" on every Access Control open).
    // A service can hold several routes; show its first domain alphabetically.
    const access = db.prepare(`
      SELECT usa.service_id, usa.can_view, usa.can_write, s.name as service_name,
             (SELECT r.domain FROM service_http_routes r WHERE r.service_id = s.id ORDER BY r.domain LIMIT 1) as domain
      FROM user_service_access usa
      INNER JOIN services s ON usa.service_id = s.id
      WHERE usa.user_id = ?
    `).all(id);

    // Get folder access
    const folderAccess = db.prepare(`
      SELECT folder_path, can_view, can_write
      FROM user_folder_access
      WHERE user_id = ?
    `).all(id);

    res.json({
      isAdmin: false,
      permissions: getUserPermissions(id),
      access: access.map(a => ({
        serviceId: a.service_id,
        serviceName: a.service_name,
        domain: a.domain,
        canView: !!a.can_view,
        canWrite: !!a.can_write,
      })),
      folderAccess: folderAccess.map(f => ({
        folderPath: f.folder_path,
        canView: !!f.can_view,
        canWrite: !!f.can_write,
      })),
    });
  } catch (error) {
    console.error('Error getting user access:', error);
    res.status(500).json({ error: 'Failed to get user access' });
  }
});

// Update user's service access validation schema
const updateAccessSchema = z.object({
  access: z.array(z.object({
    serviceId: z.string().uuid(),
    canView: z.boolean(),
    canWrite: z.boolean(),
  })),
});

// Update user's service access
userRouter.put('/users/:id/access', requireAdmin, (req, res) => {
  try {
    const { id } = req.params;
    const { access } = updateAccessSchema.parse(req.body);
    const db = getDb();

    const user = db.prepare('SELECT id, role FROM users WHERE id = ?').get(id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (user.role === 'admin') {
      return res.status(400).json({ error: 'Cannot modify access for admin users - they have full access' });
    }

    // Start a transaction
    const updateAccess = db.transaction(() => {
      // Delete all existing access for this user
      db.prepare('DELETE FROM user_service_access WHERE user_id = ?').run(id);

      // Insert new access entries
      const insert = db.prepare(`
        INSERT INTO user_service_access (id, user_id, service_id, can_view, can_write)
        VALUES (?, ?, ?, ?, ?)
      `);

      for (const a of access) {
        if (a.canView || a.canWrite) {
          insert.run(uuidv4(), id, a.serviceId, a.canView ? 1 : 0, a.canWrite ? 1 : 0);
        }
      }
    });

    updateAccess();

    logAudit(req.user.id, 'USER_ACCESS_UPDATED', 'user', id, { access }, req.ip);

    res.json({ success: true, message: 'User access updated' });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.errors[0].message });
    }
    console.error('Error updating user access:', error);
    res.status(500).json({ error: 'Failed to update user access' });
  }
});

// Update a user's feature permissions ('proxy' = containers/routing,
// 'developer' = Projects module). Enforcement reads the DB on every
// request, so a change here is live immediately for the target user.
const updatePermissionsSchema = z.object({
  permissions: z.array(z.enum(['proxy', 'developer'])).max(10),
});

userRouter.put('/users/:id/permissions', requireAdmin, (req, res) => {
  try {
    const { id } = req.params;
    const { permissions } = updatePermissionsSchema.parse(req.body);
    const db = getDb();

    const user = db.prepare('SELECT id, role FROM users WHERE id = ?').get(id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    if (user.role === 'admin') {
      return res.status(400).json({ error: 'Admins hold every permission implicitly' });
    }
    if (user.role === 'pending') {
      return res.status(400).json({ error: 'Assign the user a role before granting permissions' });
    }

    const unique = [...new Set(permissions)];
    const updatePermissions = db.transaction(() => {
      db.prepare('DELETE FROM user_permissions WHERE user_id = ?').run(id);
      const insert = db.prepare(
        'INSERT INTO user_permissions (user_id, permission, granted_by) VALUES (?, ?, ?)'
      );
      for (const permission of unique) {
        insert.run(id, permission, req.user.id);
      }
    });
    updatePermissions();

    logAudit(req.user.id, 'USER_PERMISSIONS_UPDATED', 'user', id, { permissions: unique }, req.ip);

    res.json({ success: true, permissions: unique });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.errors[0].message });
    }
    console.error('Error updating user permissions:', error);
    res.status(500).json({ error: 'Failed to update user permissions' });
  }
});

// Get user's folder access
userRouter.get('/users/:id/folder-access', requireAdmin, (req, res) => {
  try {
    const { id } = req.params;
    const db = getDb();

    const user = db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // If admin, they have access to everything
    if (user.role === 'admin') {
      return res.json({
        isAdmin: true,
        folderAccess: [],
        message: 'Admin users have full access to all folders',
      });
    }

    const folderAccess = db.prepare(`
      SELECT folder_path, can_view, can_write
      FROM user_folder_access
      WHERE user_id = ?
    `).all(id);

    res.json({
      isAdmin: false,
      folderAccess: folderAccess.map(f => ({
        folderPath: f.folder_path,
        canView: !!f.can_view,
        canWrite: !!f.can_write,
      })),
    });
  } catch (error) {
    console.error('Error getting user folder access:', error);
    res.status(500).json({ error: 'Failed to get user folder access' });
  }
});

// Update folder access validation schema
const updateFolderAccessSchema = z.object({
  folderAccess: z.array(z.object({
    folderPath: z.string().min(1),
    canView: z.boolean(),
    canWrite: z.boolean(),
  })),
});

// Update user's folder access
userRouter.put('/users/:id/folder-access', requireAdmin, (req, res) => {
  try {
    const { id } = req.params;
    const { folderAccess } = updateFolderAccessSchema.parse(req.body);
    const db = getDb();

    const user = db.prepare('SELECT id, role FROM users WHERE id = ?').get(id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (user.role === 'admin') {
      return res.status(400).json({ error: 'Cannot modify access for admin users - they have full access' });
    }

    // Start a transaction
    const updateAccess = db.transaction(() => {
      // Delete all existing folder access for this user
      db.prepare('DELETE FROM user_folder_access WHERE user_id = ?').run(id);

      // Insert new folder access entries
      const insert = db.prepare(`
        INSERT INTO user_folder_access (id, user_id, folder_path, can_view, can_write)
        VALUES (?, ?, ?, ?, ?)
      `);

      for (const f of folderAccess) {
        if (f.canView || f.canWrite) {
          insert.run(uuidv4(), id, f.folderPath, f.canView ? 1 : 0, f.canWrite ? 1 : 0);
        }
      }
    });

    updateAccess();

    logAudit(req.user.id, 'USER_FOLDER_ACCESS_UPDATED', 'user', id, { folderAccess }, req.ip);

    res.json({ success: true, message: 'User folder access updated' });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.errors[0].message });
    }
    console.error('Error updating user folder access:', error);
    res.status(500).json({ error: 'Failed to update user folder access' });
  }
});

// Initial password change for new users
userRouter.post('/change-initial-password', async (req, res) => {
  try {
    const { currentPassword, newPassword } = z.object({
      currentPassword: z.string().min(1, 'Current password is required'),
      newPassword: z.string().min(12, 'Password must be at least 12 characters'),
    }).parse(req.body);

    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (!user.password_change_required) {
      return res.status(400).json({ error: 'Password change not required' });
    }

    // Verify current password
    const passwordValid = await bcrypt.compare(currentPassword, user.password_hash);
    if (!passwordValid) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    // Hash new password
    const newPasswordHash = await bcrypt.hash(newPassword, 12);

    // Update password and clear the flag
    db.prepare(`
      UPDATE users SET password_hash = ?, password_change_required = 0, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(newPasswordHash, req.user.id);

    logAudit(req.user.id, 'INITIAL_PASSWORD_CHANGED', 'user', req.user.id, {}, req.ip);

    res.json({ success: true, message: 'Password changed successfully. Please set up TOTP.' });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.errors[0].message });
    }
    console.error('Error changing initial password:', error);
    res.status(500).json({ error: 'Failed to change password' });
  }
});

// ==========================================
// Version and Update Endpoints
// ==========================================

// Get current version and settings
userRouter.get('/version', (req, res) => {
  try {
    const version = getCurrentVersion();
    const githubRepo = getGitHubRepo();
    const updateDismissed = getSetting('update_dismissed') === 'true';
    const dismissedVersion = getSetting('dismissed_version');

    res.json({
      version,
      githubRepo,
      updateDismissed,
      dismissedVersion,
    });
  } catch (error) {
    console.error('Error getting version:', error);
    res.status(500).json({ error: 'Failed to get version' });
  }
});

// Check for updates. GitHub (latest release + latest commit on the installed
// branch, cached 10 min — ?force=1 bypasses), the Mock2 standards site
// manifest, and the host checkout facts via the agent. A network failure is a
// field in the answer, not a 500; lib/self-update.js owns the shape.
userRouter.get('/version/check', requireAdmin, async (req, res) => {
  try {
    const force = req.query.force === '1' || req.query.force === 'true';
    const data = await checkForUpdates({ repo: getGitHubRepo(), currentVersion: getCurrentVersion(), force });
    res.json(data);
  } catch (error) {
    console.error('Error checking for updates:', error);
    res.status(500).json({ error: 'Failed to check for updates' });
  }
});

// Update GitHub repo setting (Admin only)
userRouter.put('/settings/github-repo', requireAdmin, (req, res) => {
  try {
    const { githubRepo } = z.object({
      githubRepo: z.string().regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/, 'Invalid GitHub repo format (owner/repo)'),
    }).parse(req.body);

    setSetting('github_repo', githubRepo);
    logAudit(req.user.id, 'GITHUB_REPO_UPDATED', 'settings', 'github_repo', { githubRepo }, req.ip);

    res.json({ success: true, githubRepo });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.errors[0].message });
    }
    console.error('Error updating GitHub repo:', error);
    res.status(500).json({ error: 'Failed to update GitHub repo' });
  }
});

// Dismiss update notification
userRouter.post('/version/dismiss', (req, res) => {
  try {
    const { version } = req.body;
    setSetting('update_dismissed', 'true');
    if (version) {
      setSetting('dismissed_version', version);
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error dismissing update:', error);
    res.status(500).json({ error: 'Failed to dismiss update' });
  }
});

// Reset dismissed update (show notification again)
userRouter.post('/version/reset-dismiss', (req, res) => {
  try {
    setSetting('update_dismissed', 'false');
    setSetting('dismissed_version', '');

    res.json({ success: true });
  } catch (error) {
    console.error('Error resetting dismiss:', error);
    res.status(500).json({ error: 'Failed to reset dismiss' });
  }
});

// ==========================================
// Self-update (docs/features/self-update.md)
//
// The backend never runs update.sh: it lives in Docker and dies at the
// `docker compose down` update.sh performs. POST /version/update asks the
// host agent to drop a request file; the root-owned proxypilot-update
// systemd oneshot validates it and runs `update.sh --yes`. Progress lives in
// state.json on the host, so GET /version/update/progress answers before,
// during and after this process is replaced.
// ==========================================

// Request an update (Admin + sudo). 202 with the run id; 409 when it cannot
// run right now (agent unreachable, uncommitted changes on the host, a run
// already live) with the reason the UI shows verbatim.
userRouter.post('/version/update', requireAdmin, requireSudo, async (req, res) => {
  try {
    const { rebuild } = z.object({ rebuild: z.boolean().optional() }).parse(req.body || {});
    const [installed, progress] = await Promise.all([installedState({ force: true }), updateStatus({ logTailBytes: 0 })]);
    const refusal = updateStartRefusal({ installed, progress });
    if (refusal) {
      logAudit(req.user.id, 'SELF_UPDATE_REFUSED', 'system', 'self-update', { via: 'dashboard', reason: refusal }, req.ip);
      return res.status(409).json({ error: refusal, installed, progress });
    }
    const requestedBy = sanitizeRequestedBy(req.user.username || req.user.email || req.user.id);
    const started = await startUpdate({ requestedBy, flags: flagsFromOptions({ rebuild: !!rebuild }) });
    logAudit(req.user.id, 'SELF_UPDATE_REQUESTED', 'system', started.id, {
      via: 'dashboard', flags: started.flags, from_sha: installed.sha, branch: installed.branch, rebuild: !!rebuild,
    }, req.ip);
    res.status(202).json({ id: started.id, flags: started.flags, requested_at: started.requested_at, log_path: started.log_path });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.errors[0].message });
    }
    const status = mapAgentErrorToHttp(error.code);
    if (status !== 502) {
      return res.status(status).json({ error: error.message, code: error.code });
    }
    console.error('Error requesting update:', error);
    res.status(502).json({ error: error.message || 'Failed to request update', code: error.code || 'agent_unreachable' });
  }
});

// Progress of the latest run (or ?id=<uuid> for a specific one), with the
// ANSI-stripped tail of its log (?tail=<bytes>, default 16 KiB, max 48 KiB).
userRouter.get('/version/update/progress', requireAdmin, async (req, res) => {
  try {
    const id = isUpdateId(req.query.id) ? req.query.id : undefined;
    const tail = req.query.tail === undefined ? undefined : Number(req.query.tail);
    const progress = await updateStatus({ id, logTailBytes: Number.isFinite(tail) ? tail : undefined });
    res.json(progress);
  } catch (error) {
    console.error('Error reading update progress:', error);
    res.status(500).json({ error: 'Failed to read update progress' });
  }
});

// Kept for API compatibility with the old in-process flow: there is no
// in-memory state to reset any more, so this just returns the current state.
userRouter.post('/version/update/reset', requireAdmin, async (req, res) => {
  try {
    res.json({ success: true, ...(await updateStatus({ logTailBytes: 0 })) });
  } catch (error) {
    res.status(500).json({ error: 'Failed to read update progress' });
  }
});

// Restart the application (Admin only)
userRouter.post('/version/restart', requireAdmin, (req, res) => {
  try {
    const restartScript = join(PROJECT_ROOT, 'restart.sh');

    if (!existsSync(restartScript)) {
      return res.status(404).json({ error: 'Restart script not found' });
    }

    // Send response before restarting
    res.json({ success: true, message: 'Restart initiated' });

    // Delay restart to allow response to be sent
    setTimeout(() => {
      try {
        // Execute restart script in detached mode
        const child = spawn('bash', [restartScript], {
          cwd: PROJECT_ROOT,
          detached: true,
          stdio: 'ignore',
        });
        child.unref();
      } catch (e) {
        console.error('Restart error:', e);
      }
    }, 1000);

  } catch (error) {
    console.error('Error initiating restart:', error);
    res.status(500).json({ error: 'Failed to initiate restart' });
  }
});
