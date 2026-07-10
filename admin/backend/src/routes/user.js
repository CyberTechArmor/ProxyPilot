import { Router } from 'express';
import bcrypt from 'bcryptjs';
import * as OTPAuth from 'otpauth';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { getDb, logAudit, getSetting, setSetting } from '../db.js';
import { requireAdmin, requireSudo, requireDeveloperOrAbove } from '../middleware/auth.js';
import { encryptSecret, decryptSecret } from '../lib/secrets.js';
import { checkSuperadminProtection, checkSuperadminGrant } from '../lib/superadmin.js';
import { effectiveRole, roleToColumns } from '../lib/roles.js';
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
import { execSync, spawn } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '..', '..', '..', '..');

// Check if running in Docker container
const isInDocker = existsSync('/.dockerenv') || process.env.DOCKER_CONTAINER === 'true';

// Host project root path (for when running in Docker and executing on host)
// Can be set via environment variable HOST_PROJECT_ROOT
// Default assumes ~/ProxyPilot on the host
const HOST_PROJECT_ROOT = process.env.HOST_PROJECT_ROOT || '/root/ProxyPilot';

// Execute command on host (uses nsenter when in Docker, direct exec otherwise)
function execOnHost(command, options = {}) {
  const timeout = options.timeout || 30000;
  const cwd = options.cwd || PROJECT_ROOT;

  if (isInDocker) {
    // Use nsenter to execute on the host's namespace
    // Include standard PATH and source profile for proper environment
    // When running in Docker, replace container paths with host paths
    let hostCwd = cwd;
    if (cwd.startsWith('/app')) {
      // Map /app (container) to host project root
      hostCwd = cwd.replace('/app', HOST_PROJECT_ROOT);
    } else if (cwd === PROJECT_ROOT) {
      // Use host project root for PROJECT_ROOT
      hostCwd = HOST_PROJECT_ROOT;
    }
    const pathSetup = 'export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"';
    const fullCommand = `${pathSetup} && cd ${JSON.stringify(hostCwd)} && ${command}`;
    const hostCommand = `nsenter -t 1 -m -u -n -i sh -c ${JSON.stringify(fullCommand)}`;
    return execSync(hostCommand, { encoding: 'utf8', timeout });
  } else {
    // Not in Docker, execute directly
    return execSync(command, { encoding: 'utf8', timeout, cwd });
  }
}

// Default GitHub repo
const DEFAULT_GITHUB_REPO = 'CyberTechArmor/ProxyPilot';

// Get version from package.json
function getPackageVersion() {
  try {
    const packagePath = join(PROJECT_ROOT, 'admin', 'backend', 'package.json');
    if (existsSync(packagePath)) {
      const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
      return pkg.version || '1.0.0';
    }
  } catch (e) {
    console.error('Error reading package.json:', e);
  }
  return '1.0.0';
}

// Get current installed version from database (or initialize from package.json)
function getCurrentVersion() {
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

// Update the installed version in database (called after successful update)
function updateInstalledVersion() {
  const packageVersion = getPackageVersion();
  setSetting('installed_version', packageVersion);
  console.log(`Updated installed version in database: v${packageVersion}`);
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
function getGitHubRepo() {
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
      SELECT id, username, display_name, role, is_superadmin, totp_enabled, created_at, updated_at
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
        isSuperadmin: user.is_superadmin === 1,
        effectiveRole: effectiveRole(user),
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

    // Verify password
    const passwordValid = await bcrypt.compare(currentPassword, user.password_hash);
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
      SELECT id, username, display_name, role, is_superadmin, totp_enabled, password_change_required, created_at, updated_at
      FROM users
      ORDER BY created_at DESC
    `).all();

    res.json({
      users: users.map(u => ({
        id: u.id,
        username: u.username,
        displayName: u.display_name,
        role: u.role || 'admin',
        isSuperadmin: u.is_superadmin === 1,
        effectiveRole: effectiveRole(u),
        totpEnabled: !!u.totp_enabled,
        passwordChangeRequired: !!u.password_change_required,
        createdAt: u.created_at,
        updatedAt: u.updated_at,
      })),
    });
  } catch (error) {
    console.error('Error listing users:', error);
    res.status(500).json({ error: 'Failed to list users' });
  }
});

// Minimal user directory for the Mock2 share/add-members picker (ADR-011).
// A developer sharing a project they own needs to pick a collaborator, but the
// full /users list is admin-only and exposes roles/secrets. This returns only
// id + username + displayName for real (non-pending) accounts, and is open to
// developer+ (pending is denied). No role, no security state, no secrets.
userRouter.get('/users/pickable', requireDeveloperOrAbove, (req, res) => {
  try {
    const db = getDb();
    const rows = db.prepare(`
      SELECT id, username, display_name
      FROM users
      WHERE role IN ('admin', 'developer')
      ORDER BY username
    `).all();
    res.json({
      users: rows.map((u) => ({ id: u.id, username: u.username, displayName: u.display_name })),
    });
  } catch (error) {
    console.error('Error listing pickable users:', error);
    res.status(500).json({ error: 'Failed to list users' });
  }
});

// Create new user validation schema. `role` is an effective-role token
// (ADR-011); it is translated to the { role, is_superadmin } column pair on
// write. Default 'developer' — the API onboarding role — even though the DB
// column DEFAULT is the inert 'pending' (future LDAP safety).
const createUserSchema = z.object({
  username: z.string().min(3, 'Username must be at least 3 characters').max(50),
  displayName: z.string().max(100).optional(),
  role: z.enum(['superadmin', 'admin', 'developer', 'pending']).default('developer'),
});

// Create new user. requireAdmin (both admin tiers) may create users and assign
// admin/developer/pending; only a superadmin may create a superadmin
// (checkSuperadminGrant).
userRouter.post('/users', requireAdmin, requireSudo, async (req, res) => {
  try {
    const { username, displayName, role } = createUserSchema.parse(req.body);
    const db = getDb();

    const cols = roleToColumns(role);
    if (!cols) return res.status(400).json({ error: 'Invalid role' });

    // Only a superadmin may grant the superadmin role.
    const actor = db.prepare('SELECT is_superadmin FROM users WHERE id = ?').get(req.user.id);
    const grant = checkSuperadminGrant({
      actorIsSuperadmin: actor?.is_superadmin === 1,
      grantingSuperadmin: cols.is_superadmin === 1,
    });
    if (!grant.allowed) return res.status(403).json({ error: grant.error });

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
      INSERT INTO users (id, username, display_name, password_hash, totp_secret, totp_enabled, role, is_superadmin, password_change_required)
      VALUES (?, ?, ?, ?, '', 0, ?, ?, 1)
    `).run(userId, username, displayName || null, passwordHash, cols.role, cols.is_superadmin);

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

// Update user validation schema. `role` is an effective-role token (ADR-011).
const updateUserSchema = z.object({
  displayName: z.string().max(100).optional(),
  role: z.enum(['superadmin', 'admin', 'developer', 'pending']).optional(),
  resetPassword: z.boolean().optional(),
});

// Update user. requireAdmin may edit users and assign admin/developer/pending;
// the superadmin guards below add: (1) a non-superadmin cannot touch a
// superadmin target AT ALL (any field), (2) only a superadmin may grant the
// superadmin role, (3) the last superadmin can never be demoted.
userRouter.put('/users/:id', requireAdmin, requireSudo, async (req, res) => {
  try {
    const { id } = req.params;
    const { displayName, role, resetPassword } = updateUserSchema.parse(req.body);
    const db = getDb();

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const actor = db.prepare('SELECT is_superadmin FROM users WHERE id = ?').get(req.user.id);
    const actorIsSuperadmin = actor?.is_superadmin === 1;
    const targetIsSuperadmin = user.is_superadmin === 1;

    // (1) Superadmin protection (ADR-011): a non-superadmin cannot modify a
    // superadmin account at all — role change, display-name edit, or password
    // reset. Actor's flag is read from the DB (the JWT does not carry it).
    {
      const guard = checkSuperadminProtection({
        actorIsSuperadmin,
        targetIsSuperadmin,
        action: 'modify',
      });
      if (!guard.allowed) {
        return res.status(403).json({ error: guard.error });
      }
    }

    // Translate the effective-role token to columns (when a role change is
    // requested) and apply the remaining superadmin rules.
    let cols = null;
    if (role !== undefined) {
      cols = roleToColumns(role);
      if (!cols) return res.status(400).json({ error: 'Invalid role' });

      // (2) Only a superadmin may grant the superadmin role.
      const grant = checkSuperadminGrant({
        actorIsSuperadmin,
        grantingSuperadmin: cols.is_superadmin === 1 && !targetIsSuperadmin,
      });
      if (!grant.allowed) return res.status(403).json({ error: grant.error });

      // (3) The last superadmin can never be demoted (applies even to a
      // superadmin actor demoting themselves / another).
      if (targetIsSuperadmin && cols.is_superadmin !== 1) {
        const superCount = db.prepare(
          'SELECT COUNT(*) as count FROM users WHERE is_superadmin = 1'
        ).get().count;
        if (superCount <= 1) {
          return res.status(400).json({ error: 'Cannot remove the last superadmin' });
        }
      }
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

    // Update display name, role, and the superadmin flag together.
    const updates = [];
    const params = [];
    if (displayName !== undefined) {
      updates.push('display_name = ?');
      params.push(displayName);
    }
    if (cols) {
      updates.push('role = ?', 'is_superadmin = ?');
      params.push(cols.role, cols.is_superadmin);
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

// Delete user
userRouter.delete('/users/:id', requireAdmin, requireSudo, async (req, res) => {
  try {
    const { id } = req.params;
    const { totpCode, passkeyAssertion } = req.body || {};
    const db = getDb();

    const adminUser = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    const verified = await verifyConfirmationFactor({ req, user: adminUser, totpCode, passkeyAssertion });
    if (!verified.ok) return res.status(401).json({ error: verified.error });

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Prevent deleting yourself
    if (id === req.user.id) {
      return res.status(400).json({ error: 'Cannot delete your own account' });
    }

    // Superadmin protection (ADR-011): a non-superadmin cannot delete a
    // superadmin account.
    {
      const actor = db.prepare('SELECT is_superadmin FROM users WHERE id = ?').get(req.user.id);
      const guard = checkSuperadminProtection({
        actorIsSuperadmin: actor?.is_superadmin === 1,
        targetIsSuperadmin: user.is_superadmin === 1,
        action: 'delete',
      });
      if (!guard.allowed) {
        return res.status(403).json({ error: guard.error });
      }
    }

    // Prevent deleting the last superadmin (a plain admin being the last admin
    // is fine — the platform only guards its last break-glass account).
    if (user.is_superadmin === 1) {
      const superCount = db.prepare('SELECT COUNT(*) as count FROM users WHERE is_superadmin = 1').get().count;
      if (superCount <= 1) {
        return res.status(400).json({ error: 'Cannot delete the last superadmin' });
      }
    }

    // Delete user (service access will cascade delete)
    db.prepare('DELETE FROM users WHERE id = ?').run(id);

    logAudit(req.user.id, 'USER_DELETED', 'user', id, { username: user.username }, req.ip);

    res.json({ success: true, message: 'User deleted' });
  } catch (error) {
    console.error('Error deleting user:', error);
    res.status(500).json({ error: 'Failed to delete user' });
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
        message: 'Admin users have full access to all services and folders',
      });
    }

    // Get service access
    const access = db.prepare(`
      SELECT usa.service_id, usa.can_view, usa.can_write, s.name as service_name, s.domain
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

// Check for updates
userRouter.get('/version/check', async (req, res) => {
  try {
    const currentVersion = getCurrentVersion();
    const githubRepo = getGitHubRepo();

    // Fetch latest release from GitHub API
    const response = await fetch(`https://api.github.com/repos/${githubRepo}/releases/latest`, {
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'ProxyPilot-Update-Checker',
      },
    });

    if (!response.ok) {
      // If no releases, check the package.json in the main branch
      const pkgResponse = await fetch(`https://raw.githubusercontent.com/${githubRepo}/main/admin/backend/package.json`, {
        headers: { 'User-Agent': 'ProxyPilot-Update-Checker' },
      });

      if (pkgResponse.ok) {
        const pkg = await pkgResponse.json();
        const latestVersion = pkg.version || currentVersion;

        return res.json({
          currentVersion,
          latestVersion,
          updateAvailable: compareVersions(latestVersion, currentVersion) > 0,
          releaseUrl: `https://github.com/${githubRepo}`,
          releaseNotes: null,
        });
      }

      return res.json({
        currentVersion,
        latestVersion: currentVersion,
        updateAvailable: false,
        releaseUrl: null,
        releaseNotes: null,
      });
    }

    const release = await response.json();
    const latestVersion = release.tag_name.replace(/^v/, '');

    res.json({
      currentVersion,
      latestVersion,
      updateAvailable: compareVersions(latestVersion, currentVersion) > 0,
      releaseUrl: release.html_url,
      releaseNotes: release.body,
    });
  } catch (error) {
    console.error('Error checking for updates:', error);
    res.status(500).json({ error: 'Failed to check for updates' });
  }
});

// Compare semantic versions
function compareVersions(v1, v2) {
  const parts1 = v1.split('.').map(Number);
  const parts2 = v2.split('.').map(Number);

  for (let i = 0; i < 3; i++) {
    const a = parts1[i] || 0;
    const b = parts2[i] || 0;
    if (a > b) return 1;
    if (a < b) return -1;
  }
  return 0;
}

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

// Store for tracking update progress
const updateProgress = {
  status: 'idle', // idle, running, success, error
  message: '',
  logs: [],
};

// Find git executable (on host if in Docker)
function findGit() {
  // Allow override via environment variable
  if (process.env.GIT_PATH) {
    try {
      execOnHost(`${process.env.GIT_PATH} --version`, { timeout: 5000 });
      return process.env.GIT_PATH;
    } catch (e) {
      console.error(`GIT_PATH env var set to ${process.env.GIT_PATH} but git not found there`);
    }
  }

  // Try using 'which' first to find git in PATH
  try {
    const result = execOnHost('which git', { timeout: 5000 });
    const foundPath = result.trim();
    if (foundPath) {
      execOnHost(`${foundPath} --version`, { timeout: 5000 });
      return foundPath;
    }
  } catch (e) {
    // which failed, try common paths
  }

  // Common git installation paths (including nvm, homebrew, snap, etc.)
  const gitPaths = [
    '/usr/bin/git',
    '/usr/local/bin/git',
    '/opt/homebrew/bin/git',
    '/snap/bin/git',
    '/home/linuxbrew/.linuxbrew/bin/git',
  ];

  for (const gitPath of gitPaths) {
    try {
      execOnHost(`${gitPath} --version`, { timeout: 5000 });
      return gitPath;
    } catch (e) {
      // Try next path
    }
  }
  return null;
}

// Find npm executable (on host if in Docker)
function findNpm() {
  // Allow override via environment variable
  if (process.env.NPM_PATH) {
    try {
      execOnHost(`${process.env.NPM_PATH} --version`, { timeout: 5000 });
      return process.env.NPM_PATH;
    } catch (e) {
      console.error(`NPM_PATH env var set to ${process.env.NPM_PATH} but npm not found there`);
    }
  }

  // Try using 'which' first to find npm in PATH
  try {
    const result = execOnHost('which npm', { timeout: 5000 });
    const foundPath = result.trim();
    if (foundPath) {
      execOnHost(`${foundPath} --version`, { timeout: 5000 });
      return foundPath;
    }
  } catch (e) {
    // which failed, try common paths
  }

  // Common npm installation paths (including nvm, homebrew, snap, etc.)
  const npmPaths = [
    '/usr/bin/npm',
    '/usr/local/bin/npm',
    '/opt/homebrew/bin/npm',
    '/snap/bin/npm',
    '/home/linuxbrew/.linuxbrew/bin/npm',
  ];

  for (const npmPath of npmPaths) {
    try {
      execOnHost(`${npmPath} --version`, { timeout: 5000 });
      return npmPath;
    } catch (e) {
      // Try next path
    }
  }
  return null;
}

// Perform update (Admin only)
userRouter.post('/version/update', requireAdmin, requireSudo, async (req, res) => {
  try {
    // Check if update is already running
    if (updateProgress.status === 'running') {
      return res.status(409).json({ error: 'Update already in progress' });
    }

    updateProgress.status = 'running';
    updateProgress.message = 'Starting update...';
    updateProgress.logs = [];

    // Find git and npm
    const gitCmd = findGit();
    const npmCmd = findNpm();

    if (!gitCmd) {
      updateProgress.status = 'error';
      updateProgress.message = 'Git not found on host. See logs for setup instructions.';
      updateProgress.logs.push('Error: Git not found in PATH or common locations on the host system');
      updateProgress.logs.push('');
      updateProgress.logs.push('To fix this issue:');
      updateProgress.logs.push('1. Install git on the HOST system (not inside Docker):');
      updateProgress.logs.push('   Ubuntu/Debian: sudo apt-get install git');
      updateProgress.logs.push('   CentOS/RHEL: sudo yum install git');
      updateProgress.logs.push('');
      updateProgress.logs.push('2. Or specify the git path in docker-compose.yml:');
      updateProgress.logs.push('   environment:');
      updateProgress.logs.push('     - GIT_PATH=/path/to/git');
      updateProgress.logs.push('');
      updateProgress.logs.push(`Running in Docker: ${isInDocker}`);
      updateProgress.logs.push(`Host project root: ${HOST_PROJECT_ROOT}`);
      return res.status(400).json({ error: 'Git not found on host system' });
    }

    if (!npmCmd) {
      updateProgress.status = 'error';
      updateProgress.message = 'NPM not found on host. See logs for setup instructions.';
      updateProgress.logs.push('Error: NPM not found in PATH or common locations on the host system');
      updateProgress.logs.push('');
      updateProgress.logs.push('To fix this issue:');
      updateProgress.logs.push('1. Install Node.js/NPM on the HOST system (not inside Docker):');
      updateProgress.logs.push('   Ubuntu/Debian: sudo apt-get install nodejs npm');
      updateProgress.logs.push('   Or use nvm: curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash');
      updateProgress.logs.push('');
      updateProgress.logs.push('2. Or specify the npm path in docker-compose.yml:');
      updateProgress.logs.push('   environment:');
      updateProgress.logs.push('     - NPM_PATH=/path/to/npm');
      return res.status(400).json({ error: 'NPM not found on host system' });
    }

    // Send immediate response
    res.json({ success: true, message: 'Update started' });

    // Run update in background
    try {
      updateProgress.logs.push(`Running in Docker: ${isInDocker}`);
      updateProgress.logs.push(`Using git: ${gitCmd}`);
      updateProgress.logs.push(`Using npm: ${npmCmd}`);
      updateProgress.logs.push('Fetching latest changes...');
      updateProgress.message = 'Fetching latest changes...';

      // Git fetch and pull (on host)
      execOnHost(`${gitCmd} fetch origin main`, {
        cwd: PROJECT_ROOT,
        timeout: 60000,
      });

      updateProgress.logs.push('Pulling latest code...');
      updateProgress.message = 'Pulling latest code...';

      execOnHost(`${gitCmd} pull origin main`, {
        cwd: PROJECT_ROOT,
        timeout: 120000,
      });

      updateProgress.logs.push('Installing backend dependencies...');
      updateProgress.message = 'Installing backend dependencies...';

      // Install backend dependencies (on host)
      execOnHost(`${npmCmd} install`, {
        cwd: join(PROJECT_ROOT, 'admin', 'backend'),
        timeout: 300000,
      });

      updateProgress.logs.push('Installing frontend dependencies...');
      updateProgress.message = 'Installing frontend dependencies...';

      // Install frontend dependencies (on host)
      execOnHost(`${npmCmd} install`, {
        cwd: join(PROJECT_ROOT, 'admin', 'frontend'),
        timeout: 300000,
      });

      updateProgress.logs.push('Building frontend...');
      updateProgress.message = 'Building frontend...';

      // Build frontend (on host)
      execOnHost(`${npmCmd} run build`, {
        cwd: join(PROJECT_ROOT, 'admin', 'frontend'),
        timeout: 300000,
      });

      updateProgress.logs.push('Update completed successfully!');
      updateProgress.message = 'Update completed successfully! Please restart the application.';
      updateProgress.status = 'success';

      // Update the installed version in the database
      const newVersion = updateInstalledVersion();
      updateProgress.logs.push(`Version updated to v${newVersion}`);

      // Clear dismissed update since we just updated
      setSetting('update_dismissed', 'false');
      setSetting('dismissed_version', '');

    } catch (updateError) {
      console.error('Update error:', updateError);
      updateProgress.status = 'error';
      updateProgress.message = `Update failed: ${updateError.message}`;
      updateProgress.logs.push(`Error: ${updateError.message}`);
    }

  } catch (error) {
    console.error('Error starting update:', error);
    updateProgress.status = 'error';
    updateProgress.message = error.message;
    res.status(500).json({ error: 'Failed to start update' });
  }
});

// Get update progress
userRouter.get('/version/update/progress', requireAdmin, (req, res) => {
  res.json(updateProgress);
});

// Reset update status (after viewing result)
userRouter.post('/version/update/reset', requireAdmin, (req, res) => {
  updateProgress.status = 'idle';
  updateProgress.message = '';
  updateProgress.logs = [];
  res.json({ success: true });
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
