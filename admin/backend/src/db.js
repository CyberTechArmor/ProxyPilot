import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { mkdirSync, existsSync } from 'fs';
import { dirname, resolve, join } from 'path';
import { fileURLToPath } from 'url';

const __dbFilename = fileURLToPath(import.meta.url);
const __dbDirname = dirname(__dbFilename);
// Project root is 3 levels up from src/db.js (src -> backend -> admin -> root)
const PROJECT_ROOT = resolve(__dbDirname, '..', '..', '..');

// Resolve DATABASE_PATH: if relative, resolve against project root (not CWD)
const rawDbPath = process.env.DATABASE_PATH || './data/proxypilot.db';
const dbPath = rawDbPath.startsWith('/') ? rawDbPath : resolve(PROJECT_ROOT, rawDbPath);
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
  // Note: 'proxy' type is kept for the admin dashboard service but not available for new user services.
  // Phase 2: multiple services can share a domain on different path prefixes,
  // so the UNIQUE constraint is on the (domain, path_prefix) tuple instead of
  // domain alone. Existing installs that still have UNIQUE(domain) are rebuilt
  // to this shape by migrateServicesUniqueConstraint() below.
  db.exec(`
    CREATE TABLE IF NOT EXISTS services (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      domain TEXT NOT NULL,
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
      path_prefix TEXT NOT NULL DEFAULT '/',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(domain, path_prefix)
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

  // Add path_prefix column for wildcard/path-based routing
  // Defaults to '/' so existing services continue to match all paths on their domain.
  try {
    db.exec(`ALTER TABLE services ADD COLUMN path_prefix TEXT NOT NULL DEFAULT '/'`);
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

  // Create authenticated devices table for TOTP-free login on trusted devices
  db.exec(`
    CREATE TABLE IF NOT EXISTS authenticated_devices (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      device_name TEXT NOT NULL,
      device_fingerprint TEXT NOT NULL,
      user_agent TEXT,
      ip_address TEXT,
      last_used_at TEXT DEFAULT CURRENT_TIMESTAMP,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE(user_id, device_fingerprint)
    )
  `);

  // Create index for device lookups
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_devices_user_fingerprint
    ON authenticated_devices(user_id, device_fingerprint)
  `);

  // Create service config versions table for version control on settings
  db.exec(`
    CREATE TABLE IF NOT EXISTS service_config_versions (
      id TEXT PRIMARY KEY,
      service_id TEXT NOT NULL,
      config_json TEXT NOT NULL,
      version INTEGER NOT NULL,
      notes TEXT,
      created_by TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (service_id) REFERENCES services(id) ON DELETE CASCADE,
      FOREIGN KEY (created_by) REFERENCES users(id)
    )
  `);

  // Create index for config version lookups
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_config_versions_lookup
    ON service_config_versions(service_id, version DESC)
  `);

  // Create access log table for detailed access tracking
  db.exec(`
    CREATE TABLE IF NOT EXISTS access_log (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      action TEXT NOT NULL,
      endpoint TEXT,
      method TEXT,
      ip_address TEXT,
      user_agent TEXT,
      response_status INTEGER,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
    )
  `);

  // Create index for access log lookups
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_access_log_user
    ON access_log(user_id, created_at DESC)
  `);

  // Create snapshot notes table for multiple notes per snapshot
  db.exec(`
    CREATE TABLE IF NOT EXISTS snapshot_notes (
      id TEXT PRIMARY KEY,
      container_name TEXT NOT NULL,
      snapshot_name TEXT NOT NULL,
      note TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_snapshot_notes_lookup
    ON snapshot_notes(container_name, snapshot_name, created_at DESC)
  `);

  // Check if admin user exists, create if not
  const adminUser = db.prepare('SELECT id FROM users WHERE username = ?').get(process.env.ADMIN_USERNAME);

  if (!adminUser && process.env.ADMIN_USERNAME) {
    const userId = uuidv4();

    if (process.env.ADMIN_PASSWORD) {
      // Legacy mode: password provided via env (from older installs)
      const passwordHash = bcrypt.hashSync(process.env.ADMIN_PASSWORD, 12);
      db.prepare(`
        INSERT INTO users (id, username, password_hash, totp_secret, totp_enabled, role, password_change_required)
        VALUES (?, ?, ?, ?, 1, 'admin', 0)
      `).run(userId, process.env.ADMIN_USERNAME, passwordHash, process.env.ADMIN_TOTP_SECRET || '');
      console.log('Admin user created with provided password');
    } else {
      // New mode: no password - user sets it from the web UI on first login
      db.prepare(`
        INSERT INTO users (id, username, password_hash, totp_secret, totp_enabled, role, password_change_required)
        VALUES (?, ?, '', '', 0, 'admin', 1)
      `).run(userId, process.env.ADMIN_USERNAME);
      console.log('Admin user created - initial setup required via web UI');
    }

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

// Phase 2 migration: rebuild the services table so that UNIQUE(domain) is
// replaced with UNIQUE(domain, path_prefix). Idempotent — a services table
// that already carries the new constraint is left alone. Runs inside a
// transaction so a crash mid-rebuild does not corrupt the DB.
//
// SQLite FKs are not enforced in this app (no `PRAGMA foreign_keys = ON`),
// so child tables (user_service_access, file_versions, service_config_versions)
// keep their service_id values across the DROP/RENAME without cascading.
// Their indexes live on the child tables and are unaffected by this rebuild;
// we explicitly (re)create idx_services_domain_path on the rebuilt table so
// lookups on the new tuple stay fast.
export function migrateServicesUniqueConstraint(dbInstance) {
  const db = dbInstance || getDb();
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='services'")
    .get();
  if (!row || !row.sql) {
    return; // table does not exist yet — initDatabase will create it fresh
  }

  const currentSql = row.sql;
  if (currentSql.includes('UNIQUE(domain, path_prefix)')) {
    // Already migrated — make sure the helper index exists and return.
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_services_domain_path ON services(domain, path_prefix)`
    );
    return;
  }

  console.log(
    'Migrating services table: UNIQUE(domain) -> UNIQUE(domain, path_prefix)'
  );

  const runMigration = db.transaction(() => {
    // Discover the actual column set on the current table so we copy every
    // column the deployed install already has (including any future columns
    // added via ALTER TABLE in initDatabase). This keeps the rebuild safe
    // across installs that may be one or more migrations behind.
    const existingCols = db.prepare(`PRAGMA table_info(services)`).all();
    const colNames = existingCols.map((c) => c.name);

    // Ensure path_prefix is present in the column list — if an older install
    // somehow got here without the ALTER TABLE having run (defensive), add it
    // so the rebuilt table has a value to copy from.
    if (!colNames.includes('path_prefix')) {
      db.exec(`ALTER TABLE services ADD COLUMN path_prefix TEXT NOT NULL DEFAULT '/'`);
      colNames.push('path_prefix');
    }

    // Build the CREATE TABLE for services_new. We emit the canonical column
    // set (matching the fresh-install CREATE TABLE) with the new UNIQUE
    // constraint. Any legacy columns the old table carries that are NOT in
    // this canonical list are dropped — they are not referenced anywhere
    // in the current codebase.
    db.exec(`
      CREATE TABLE services_new (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        domain TEXT NOT NULL,
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
        is_favorite INTEGER DEFAULT 0,
        path_prefix TEXT NOT NULL DEFAULT '/',
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(domain, path_prefix)
      )
    `);

    // Copy every row. COALESCE path_prefix to '/' so NULLs from pre-wildcard
    // installs land on the canonical root value the rest of the app expects.
    // Columns the old table lacks (e.g. is_favorite on very old installs)
    // fall back to their schema defaults via NULL.
    const has = (name) => colNames.includes(name) ? name : `NULL AS ${name}`;
    const copySql = `
      INSERT INTO services_new (
        id, name, domain, type, target, port, root_dir, container_name,
        ssl_enabled, force_https, websocket_enabled, max_upload_size,
        data_dir, status, is_admin, is_favorite, path_prefix,
        created_at, updated_at
      )
      SELECT
        id, name, domain, type, target, port, root_dir, container_name,
        ${has('ssl_enabled')}, ${has('force_https')},
        ${has('websocket_enabled')}, ${has('max_upload_size')},
        ${has('data_dir')}, ${has('status')}, ${has('is_admin')},
        ${colNames.includes('is_favorite') ? 'is_favorite' : '0 AS is_favorite'},
        COALESCE(path_prefix, '/') AS path_prefix,
        created_at, updated_at
      FROM services
    `;
    db.exec(copySql);

    db.exec(`DROP TABLE services`);
    db.exec(`ALTER TABLE services_new RENAME TO services`);
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_services_domain_path ON services(domain, path_prefix)`
    );
  });

  runMigration();
  console.log('Services table migration complete');
}
