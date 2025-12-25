import { Router } from 'express';
import bcrypt from 'bcryptjs';
import * as OTPAuth from 'otpauth';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { getDb, logAudit } from '../db.js';
import { requireAdmin } from '../middleware/auth.js';

export const userRouter = Router();

// Generate strong random password
function generatePassword(length = 24) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*';
  let password = '';
  const array = new Uint32Array(length);
  crypto.getRandomValues(array);
  for (let i = 0; i < length; i++) {
    password += chars[array[i] % chars.length];
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
      SELECT id, username, display_name, role, totp_enabled, created_at, updated_at
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
        totpEnabled: !!user.totp_enabled,
        createdAt: user.created_at,
        updatedAt: user.updated_at,
      },
    });
  } catch (error) {
    console.error('Error fetching profile:', error);
    res.status(500).json({ error: 'Failed to fetch profile' });
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
        secret: OTPAuth.Secret.fromBase32(user.totp_secret),
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

    // Save the new secret
    db.prepare(`
      UPDATE users SET totp_secret = ?, totp_enabled = 1, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(secret, req.user.id);

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
      SELECT id, username, display_name, role, totp_enabled, password_change_required, created_at, updated_at
      FROM users
      ORDER BY created_at DESC
    `).all();

    res.json({
      users: users.map(u => ({
        id: u.id,
        username: u.username,
        displayName: u.display_name,
        role: u.role || 'admin',
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

// Create new user validation schema
const createUserSchema = z.object({
  username: z.string().min(3, 'Username must be at least 3 characters').max(50),
  displayName: z.string().max(100).optional(),
  role: z.enum(['admin', 'user']).default('user'),
});

// Create new user
userRouter.post('/users', requireAdmin, async (req, res) => {
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

// Update user validation schema
const updateUserSchema = z.object({
  displayName: z.string().max(100).optional(),
  role: z.enum(['admin', 'user']).optional(),
  resetPassword: z.boolean().optional(),
});

// Update user
userRouter.put('/users/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { displayName, role, resetPassword } = updateUserSchema.parse(req.body);
    const db = getDb();

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Prevent demoting the last admin
    if (role === 'user' && user.role === 'admin') {
      const adminCount = db.prepare('SELECT COUNT(*) as count FROM users WHERE role = ?').get('admin').count;
      if (adminCount <= 1) {
        return res.status(400).json({ error: 'Cannot demote the last admin user' });
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

// Delete user
userRouter.delete('/users/:id', requireAdmin, (req, res) => {
  try {
    const { id } = req.params;
    const { totpCode } = req.body;
    const db = getDb();

    // Verify TOTP for dangerous action
    const adminUser = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (adminUser.totp_enabled && adminUser.totp_secret) {
      const totp = new OTPAuth.TOTP({
        issuer: 'ProxyPilot',
        label: adminUser.username,
        algorithm: 'SHA1',
        digits: 6,
        period: 30,
        secret: OTPAuth.Secret.fromBase32(adminUser.totp_secret),
      });
      const delta = totp.validate({ token: totpCode, window: 1 });
      if (delta === null) {
        return res.status(401).json({ error: 'Invalid TOTP code' });
      }
    }

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Prevent deleting yourself
    if (id === req.user.id) {
      return res.status(400).json({ error: 'Cannot delete your own account' });
    }

    // Prevent deleting the last admin
    if (user.role === 'admin') {
      const adminCount = db.prepare('SELECT COUNT(*) as count FROM users WHERE role = ?').get('admin').count;
      if (adminCount <= 1) {
        return res.status(400).json({ error: 'Cannot delete the last admin user' });
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

// Get user's service access
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
        message: 'Admin users have full access to all services',
      });
    }

    const access = db.prepare(`
      SELECT usa.service_id, usa.can_view, usa.can_write, s.name as service_name, s.domain
      FROM user_service_access usa
      INNER JOIN services s ON usa.service_id = s.id
      WHERE usa.user_id = ?
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
