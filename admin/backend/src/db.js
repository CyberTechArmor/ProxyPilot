import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';

const dbPath = process.env.DATABASE_PATH || './data/proxypilot.db';
let db;

export function getDb() {
  if (!db) {
    // Ensure the directory exists
    const dbDir = dirname(dbPath);
    if (!existsSync(dbDir)) {
      mkdirSync(dbDir, { recursive: true });
    }
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
  }
  return db;
}

export function initDatabase() {
  const db = getDb();

  // Create users table
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      display_name TEXT,
      password_hash TEXT NOT NULL,
      totp_secret TEXT NOT NULL,
      totp_enabled INTEGER DEFAULT 1,
      role TEXT DEFAULT 'user' CHECK(role IN ('admin', 'user')),
      password_change_required INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Add new columns if they don't exist (migration for existing DBs)
  try {
    db.exec(`ALTER TABLE users ADD COLUMN display_name TEXT`);
  } catch (e) {
    // Column already exists
  }
  try {
    db.exec(`ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'admin' CHECK(role IN ('admin', 'user'))`);
  } catch (e) {
    // Column already exists
  }
  try {
    db.exec(`ALTER TABLE users ADD COLUMN password_change_required INTEGER DEFAULT 0`);
  } catch (e) {
    // Column already exists
  }

  // Fix existing admin users that were created without role set
  // The first user or any user without a role should be admin
  try {
    db.exec(`UPDATE users SET role = 'admin' WHERE role IS NULL OR role = ''`);
    // Also ensure the first created user is always admin
    const firstUser = db.prepare('SELECT id FROM users ORDER BY created_at ASC LIMIT 1').get();
    if (firstUser) {
      db.prepare('UPDATE users SET role = ? WHERE id = ?').run('admin', firstUser.id);
    }
  } catch (e) {
    console.error('Error fixing user roles:', e);
  }

  // Create user_service_access table for granular permissions
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_service_access (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      service_id TEXT NOT NULL,
      can_view INTEGER DEFAULT 1,
      can_write INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (service_id) REFERENCES services(id) ON DELETE CASCADE,
      UNIQUE(user_id, service_id)
    )
  `);

  // Create user_folder_access table for folder-level permissions
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_folder_access (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      folder_path TEXT NOT NULL,
      can_view INTEGER DEFAULT 1,
      can_write INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE(user_id, folder_path)
    )
  `);

  // Create services table
  // Note: 'proxy' type is kept for the admin dashboard service but not available for new user services
  db.exec(`
    CREATE TABLE IF NOT EXISTS services (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      domain TEXT UNIQUE NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('proxy', 'static', 'docker')),
      target TEXT,
      port INTEGER,
      root_dir TEXT,
      container_name TEXT,
      ssl_enabled INTEGER DEFAULT 1,
      force_https INTEGER DEFAULT 1,
      websocket_enabled INTEGER DEFAULT 0,
      max_upload_size TEXT DEFAULT '1G',
      data_dir TEXT,
      status TEXT DEFAULT 'active' CHECK(status IN ('active', 'inactive', 'error')),
      is_admin INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Add data_dir column if it doesn't exist (migration for existing DBs)
  try {
    db.exec(`ALTER TABLE services ADD COLUMN data_dir TEXT`);
  } catch (e) {
    // Column already exists
  }

  // Add is_favorite column if it doesn't exist
  try {
    db.exec(`ALTER TABLE services ADD COLUMN is_favorite INTEGER DEFAULT 0`);
  } catch (e) {
    // Column already exists
  }

  // Create file versions table for version control
  db.exec(`
    CREATE TABLE IF NOT EXISTS file_versions (
      id TEXT PRIMARY KEY,
      service_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      content TEXT NOT NULL,
      version INTEGER NOT NULL,
      notes TEXT,
      created_by TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (service_id) REFERENCES services(id) ON DELETE CASCADE,
      FOREIGN KEY (created_by) REFERENCES users(id)
    )
  `);

  // Add notes column if it doesn't exist (migration for existing DBs)
  try {
    db.exec(`ALTER TABLE file_versions ADD COLUMN notes TEXT`);
  } catch (e) {
    // Column already exists
  }

  // Create index for faster file version lookups
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_file_versions_lookup
    ON file_versions(service_id, file_path, version DESC)
  `);

  // Create audit log table
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      action TEXT NOT NULL,
      resource_type TEXT,
      resource_id TEXT,
      details TEXT,
      ip_address TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  // Create app settings table
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Check if admin user exists, create if not
  const adminUser = db.prepare('SELECT id FROM users WHERE username = ?').get(process.env.ADMIN_USERNAME);

  if (!adminUser && process.env.ADMIN_USERNAME && process.env.ADMIN_PASSWORD) {
    const passwordHash = bcrypt.hashSync(process.env.ADMIN_PASSWORD, 12);
    const userId = uuidv4();

    db.prepare(`
      INSERT INTO users (id, username, password_hash, totp_secret, totp_enabled, role)
      VALUES (?, ?, ?, ?, 1, 'admin')
    `).run(userId, process.env.ADMIN_USERNAME, passwordHash, process.env.ADMIN_TOTP_SECRET || '');

    console.log('Admin user created');

    // Mark the admin dashboard service
    if (process.env.DOMAIN) {
      const serviceId = uuidv4();
      db.prepare(`
        INSERT OR IGNORE INTO services (id, name, domain, type, target, port, ssl_enabled, force_https, is_admin)
        VALUES (?, 'ProxyPilot Admin', ?, 'proxy', '127.0.0.1', ?, 1, 1, 1)
      `).run(serviceId, process.env.DOMAIN, process.env.PORT || 3001);
    }
  }

  console.log('Database initialized');
}

export function logAudit(userId, action, resourceType, resourceId, details, ipAddress) {
  const db = getDb();
  const id = uuidv4();

  db.prepare(`
    INSERT INTO audit_log (id, user_id, action, resource_type, resource_id, details, ip_address)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, userId, action, resourceType, resourceId, JSON.stringify(details), ipAddress);
}

export function getSetting(key) {
  const db = getDb();
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

export function setSetting(key, value) {
  const db = getDb();
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = CURRENT_TIMESTAMP
  `).run(key, value, value);
}
