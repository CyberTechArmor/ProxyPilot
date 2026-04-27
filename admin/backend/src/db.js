import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { mkdirSync, existsSync, chmodSync } from 'fs';
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
    // Ensure the directory exists with restrictive perms (0700). The data
    // directory holds the SQLite DB plus pre-update backups; nothing in it
    // should be world-readable.
    const dbDir = dirname(dbPath);
    if (!existsSync(dbDir)) {
      mkdirSync(dbDir, { recursive: true, mode: 0o700 });
    } else {
      try { chmodSync(dbDir, 0o700); } catch { /* best effort */ }
    }
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    // Lock the DB file (and WAL/SHM if present) to 0600 every boot. The DB
    // contains password hashes, JWT-issuing material via SESSION_SECRET
    // joins, and TOTP secrets — leaking it = full account compromise.
    for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      if (existsSync(f)) {
        try { chmodSync(f, 0o600); } catch { /* best effort */ }
      }
    }
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
  //
  // Phase 2b: a service now represents one logical workload (typically an LXC
  // or Docker container) that can expose multiple HTTP routes through the
  // sibling `service_http_routes` table. The new Phase 2b columns are
  // ADDITIVE only in this commit (A.1) — the legacy route-owned columns
  // (`domain`, `path_prefix`, `port`, `ssl_enabled`, `force_https`,
  // `websocket_enabled`, `max_upload_size`) plus the `UNIQUE(domain,
  // path_prefix)` constraint stay in place until D.14 drops them via a
  // table-rebuild, after every endpoint has been refactored to read and
  // write from the routes table. This keeps every intermediate commit
  // runtime-correct.
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
      kind TEXT NOT NULL DEFAULT 'container_service' CHECK(kind IN ('static_site', 'container_service')),
      runtime TEXT CHECK(runtime IN ('lxc', 'docker') OR runtime IS NULL),
      target_ip TEXT,
      lxc_container_name TEXT,
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
  //
  // Phase 2b D.14 guard: if the services table no longer has the legacy
  // `domain` column, it has been rebuilt in post-D.14 shape and path_prefix
  // was dropped along with it. Do NOT re-add it here — the column now
  // lives on service_http_routes.
  try {
    const colsNow = db
      .prepare(`PRAGMA table_info(services)`)
      .all()
      .map((c) => c.name);
    if (colsNow.includes('domain') && !colsNow.includes('path_prefix')) {
      db.exec(
        `ALTER TABLE services ADD COLUMN path_prefix TEXT NOT NULL DEFAULT '/'`
      );
    }
  } catch (e) {
    // Column already exists or introspection failed — safe to ignore.
  }

  // Phase 2 migration: rebuild the services table so UNIQUE(domain) becomes
  // UNIQUE(domain, path_prefix). Idempotent — skipped on fresh installs (the
  // CREATE TABLE above already carries the new constraint) and on already-
  // migrated existing installs.
  migrateServicesUniqueConstraint(db);

  // Phase 2b additive columns — MUST run AFTER migrateServicesUniqueConstraint
  // because that helper does a table rebuild with a hardcoded canonical column
  // set; any Phase 2b columns added BEFORE the rebuild would get dropped by
  // it. Running after the Phase 2 rebuild means:
  //   - Fresh installs: CREATE TABLE IF NOT EXISTS already created the table
  //     with the Phase 2b columns, so these ALTER TABLEs no-op via try/catch.
  //   - Pre-Phase-2 installs: the rebuild runs first (producing a Phase 2
  //     shape services table), then these ALTER TABLEs add the Phase 2b
  //     columns on top.
  //   - Already-Phase-2b installs: both the rebuild and these ALTER TABLEs
  //     no-op.
  //
  // These columns are additive only in A.1; existing data is backfilled by
  // A.3's migrateServicesToRoutes(db) and the legacy route-owned columns
  // stay in place until D.14 drops them via a table rebuild, after every
  // endpoint has been refactored to read and write from service_http_routes.
  try {
    db.exec(`ALTER TABLE services ADD COLUMN kind TEXT NOT NULL DEFAULT 'container_service' CHECK(kind IN ('static_site', 'container_service'))`);
  } catch (e) {
    // Column already exists
  }
  try {
    db.exec(`ALTER TABLE services ADD COLUMN runtime TEXT CHECK(runtime IN ('lxc', 'docker') OR runtime IS NULL)`);
  } catch (e) {
    // Column already exists
  }
  try {
    db.exec(`ALTER TABLE services ADD COLUMN target_ip TEXT`);
  } catch (e) {
    // Column already exists
  }
  try {
    db.exec(`ALTER TABLE services ADD COLUMN lxc_container_name TEXT`);
  } catch (e) {
    // Column already exists
  }

  // Phase 2b: sibling table that carries one row per HTTP route exposed by
  // a service. A single service (one workload / container) can expose many
  // routes at once — e.g. example.com/ and example.com/api pointing at
  // different ports of the same container. The Phase 2 (domain, path_prefix)
  // uniqueness constraint migrates from `services` to this table, which is
  // the only place that carries the tuple after D.14 drops the legacy
  // columns from `services`.
  //
  // Populated by A.3's migrateServicesToRoutes() backfill on installs that
  // already have Phase 2 services rows. Fresh installs start empty and the
  // create/update endpoints (section D) will insert rows as the operator
  // adds routes.
  //
  // FK to services(id) is declared but not enforced at the SQLite level —
  // this app does not `PRAGMA foreign_keys = ON`. The service-level DELETE
  // handler (C.5) walks child rows explicitly before deleting the parent.
  db.exec(`
    CREATE TABLE IF NOT EXISTS service_http_routes (
      id TEXT PRIMARY KEY,
      service_id TEXT NOT NULL,
      domain TEXT NOT NULL,
      path_prefix TEXT NOT NULL DEFAULT '/',
      target_port INTEGER,
      websocket_enabled INTEGER DEFAULT 0,
      ssl_enabled INTEGER DEFAULT 1,
      force_https INTEGER DEFAULT 1,
      max_upload_size TEXT DEFAULT '1G',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (service_id) REFERENCES services(id) ON DELETE CASCADE,
      UNIQUE(domain, path_prefix)
    )
  `);

  // Index on service_id so the routes-for-a-service lookup (used by the
  // list + service-detail endpoints in section D and by the per-service
  // routes CRUD in section C) stays O(log n).
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_routes_service
    ON service_http_routes(service_id)
  `);

  // Phase 2b data backfill: populate service_http_routes rows from the
  // legacy Phase 2 services columns and derive the new (kind, runtime,
  // target_ip) values from the legacy `type` and `target` fields.
  //
  // Idempotent — runs silently on every boot and only logs + mutates when
  // there is actually something to backfill. Must run AFTER:
  //   (a) the services CREATE TABLE + Phase 2b ALTER TABLEs above, so
  //       `kind`/`runtime`/`target_ip`/`lxc_container_name` exist on every
  //       row, and
  //   (b) the service_http_routes CREATE TABLE directly above, so the
  //       INSERT has somewhere to write.
  migrateServicesToRoutes(db);

  // Phase 2b D.14: drop the legacy route-owned columns from `services`.
  // Runs AFTER migrateServicesToRoutes so every existing row has been
  // mirrored into `service_http_routes` before the physical drop. This
  // call is idempotent — installs already rebuilt on a prior boot are
  // a no-op. Post-D.14 the legacy columns are gone and the Phase 2b
  // endpoints read/write only the routes table.
  dropLegacyRouteColumnsFromServices(db);

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

// Returns the admin service's domain, falling back through:
//   1. services.domain on the admin row (pre-D.14)
//   2. app_settings.admin_domain (post-D.14, written by the D.14 patch)
//   3. process.env.DOMAIN (final fallback for fresh installs)
// Used by Caddy regeneration and the discover endpoint so admin keeps
// working after the legacy services.domain column is dropped.
export function getAdminDomain() {
  const db = getDb();
  try {
    const cols = db
      .prepare(`PRAGMA table_info(services)`)
      .all()
      .map((c) => c.name);
    if (cols.includes('domain')) {
      const row = db
        .prepare(
          `SELECT domain FROM services WHERE is_admin = 1 AND domain IS NOT NULL LIMIT 1`
        )
        .get();
      if (row && row.domain) return row.domain;
    }
  } catch { /* fall through */ }
  const fromSettings = getSetting('admin_domain');
  if (fromSettings) return fromSettings;
  return process.env.DOMAIN || null;
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

  // Phase 2b D.14 guard: if the services table no longer has the legacy
  // `domain` column at all, this Phase 2 rebuild doesn't apply anymore.
  // Post-D.14 the (domain, path_prefix) UNIQUE constraint lives on
  // service_http_routes instead.
  const cols = db
    .prepare(`PRAGMA table_info(services)`)
    .all()
    .map((c) => c.name);
  if (!cols.includes('domain')) {
    return;
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

// Phase 2b backfill: splits legacy Phase 2 services rows into (services,
// service_http_routes) pairs by copying the legacy route-owned columns
// (domain, path_prefix, port, ssl_enabled, force_https, websocket_enabled,
// max_upload_size) into a new child row and deriving the new service-level
// columns (kind, runtime, target_ip) from the legacy `type` and `target`.
//
// This helper is ADDITIVE only — it does NOT drop any legacy columns from
// the `services` table. The legacy columns stay in place until D.14 runs a
// table-rebuild, after every endpoint has been refactored to read and write
// from `service_http_routes`. That invariant keeps every intermediate
// commit runtime-correct (existing Phase 2 endpoints keep working against
// the legacy columns while the Phase 2b read paths come online).
//
// Idempotent — safe to call on every `initDatabase()`:
//   - Detects whether the services table still carries the legacy route
//     columns (domain/path_prefix/port). Post-D.14 installs no longer have
//     them, so there is nothing to backfill and the helper returns early.
//   - The INSERT's `WHERE id NOT IN (SELECT service_id FROM
//     service_http_routes)` clause ensures only services that lack a
//     corresponding route row get backfilled. Admin services are skipped
//     because their Caddy block is installer-managed.
//   - Each UPDATE's WHERE clause targets only rows whose new column is
//     still in the unpopulated state, so a second run matches zero rows.
//   - Only logs when at least one route was actually inserted.
export function migrateServicesToRoutes(dbInstance) {
  const db = dbInstance || getDb();

  // Post-D.14 detection: if the services table no longer has the legacy
  // route columns, there is nothing left to backfill.
  const cols = db
    .prepare(`PRAGMA table_info(services)`)
    .all()
    .map((c) => c.name);
  const hasLegacyCols =
    cols.includes('domain') &&
    cols.includes('path_prefix') &&
    cols.includes('port');
  if (!hasLegacyCols) {
    return;
  }

  // Guard: if the Phase 2b columns are missing the helper is being called
  // before A.1's ALTER TABLE has run (unit-test seeding a raw Phase 2 shape
  // without going through initDatabase). Bail out cleanly rather than
  // crashing on an unknown column.
  const hasPhase2bCols =
    cols.includes('kind') &&
    cols.includes('runtime') &&
    cols.includes('target_ip') &&
    cols.includes('lxc_container_name');
  if (!hasPhase2bCols) {
    return;
  }

  const runBackfill = db.transaction(() => {
    // (1) One service_http_routes row per non-admin service that does not
    // yet have one. `lower(hex(randomblob(16)))` gives a 32-char random
    // hex string for the primary key, keeping the helper dependency-free
    // (no uuidv4 imported into SQL). COALESCE wraps each legacy column so
    // NULLs from very old installs land on sensible defaults.
    const insertResult = db
      .prepare(
        `
      INSERT INTO service_http_routes (
        id, service_id, domain, path_prefix, target_port,
        websocket_enabled, ssl_enabled, force_https, max_upload_size
      )
      SELECT
        lower(hex(randomblob(16))),
        id,
        domain,
        COALESCE(path_prefix, '/'),
        port,
        COALESCE(websocket_enabled, 0),
        COALESCE(ssl_enabled, 1),
        COALESCE(force_https, 1),
        COALESCE(max_upload_size, '1G')
      FROM services
      WHERE is_admin = 0
        AND domain IS NOT NULL
        AND id NOT IN (SELECT service_id FROM service_http_routes)
    `
      )
      .run();

    // (2) Derive `kind` from legacy `type`: static -> static_site,
    // docker/proxy -> container_service. A.1's ALTER TABLE set the
    // default to 'container_service' on every existing row, so we only
    // need to flip static rows. Admin rows stay at the default — their
    // kind is not meaningful (they bypass the routes pipeline entirely).
    db.prepare(
      `UPDATE services
         SET kind = 'static_site'
       WHERE is_admin = 0 AND type = 'static' AND kind != 'static_site'`
    ).run();

    // (3) Derive `runtime` from legacy `type`. Only 'docker' maps to a
    // non-NULL runtime; 'proxy' and 'static' stay NULL (operator can set
    // runtime='lxc' later via the wizard). Idempotent via the NULL check.
    db.prepare(
      `UPDATE services
         SET runtime = 'docker'
       WHERE is_admin = 0 AND runtime IS NULL AND type = 'docker'`
    ).run();

    // (4) Copy legacy `target` into the new `target_ip` column for
    // non-static services. Static sites use `root_dir`, not an IP target,
    // so they stay at NULL. Idempotent via the `target_ip IS NULL` check.
    db.prepare(
      `UPDATE services
         SET target_ip = target
       WHERE is_admin = 0
         AND target_ip IS NULL
         AND target IS NOT NULL
         AND type != 'static'`
    ).run();

    return insertResult.changes;
  });

  const insertedRoutes = runBackfill();
  if (insertedRoutes > 0) {
    console.log(
      `Backfilled services → service_http_routes (${insertedRoutes} routes)`
    );
  }
}

// Phase 2b D.14: drop the legacy route-owned columns from `services`.
//
// Runs LAST in the initDatabase() pipeline, after migrateServicesToRoutes
// has backfilled every existing service into service_http_routes. The
// rebuild keeps only the Phase 2b canonical column set:
//   id, name, kind, runtime, type, target, target_ip, lxc_container_name,
//   root_dir, container_name, data_dir, status, is_admin, is_favorite,
//   created_at, updated_at
//
// Dropped columns: domain, path_prefix, port, ssl_enabled, force_https,
// websocket_enabled, max_upload_size — all now owned by
// service_http_routes rows instead. The UNIQUE(domain, path_prefix)
// constraint on the services table goes with them.
//
// Idempotent — inspects the current `services` CREATE TABLE sql and
// returns early if the legacy columns are already gone.
export function dropLegacyRouteColumnsFromServices(dbInstance) {
  const db = dbInstance || getDb();

  const row = db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='services'"
    )
    .get();
  if (!row || !row.sql) {
    return;
  }

  // Post-drop detection: if the table sql no longer mentions any legacy
  // route column, the drop has already run. The column names are unique
  // enough that a substring match is safe here.
  const legacyMarkers = [
    ' domain ',
    ' path_prefix ',
    ' port ',
    ' ssl_enabled ',
    ' force_https ',
    ' websocket_enabled ',
    ' max_upload_size ',
  ];
  const hasAnyLegacy = legacyMarkers.some((m) => row.sql.includes(m));
  if (!hasAnyLegacy) {
    return;
  }

  console.log(
    'Phase 2b D.14: dropping legacy route columns from services via table rebuild'
  );

  // D.14 patch: capture the admin service's domain into app_settings before
  // the column is dropped. The admin service is intentionally excluded from
  // the routes backfill (it bypasses the route-driven Caddy generator), so
  // without this snapshot the admin domain is lost forever after the drop.
  // Idempotent: only writes if app_settings.admin_domain is empty.
  try {
    const existing = db
      .prepare(`SELECT value FROM app_settings WHERE key = 'admin_domain'`)
      .get();
    if (!existing || !existing.value) {
      const adminRow = db
        .prepare(
          `SELECT domain FROM services WHERE is_admin = 1 AND domain IS NOT NULL LIMIT 1`
        )
        .get();
      if (adminRow && adminRow.domain) {
        db.prepare(
          `INSERT INTO app_settings (key, value, updated_at)
           VALUES ('admin_domain', ?, CURRENT_TIMESTAMP)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`
        ).run(adminRow.domain);
        console.log(
          `D.14 patch: captured admin domain '${adminRow.domain}' into app_settings`
        );
      }
    }
  } catch (e) {
    console.error('D.14 patch: failed to capture admin domain', e);
  }

  const runDrop = db.transaction(() => {
    // Discover actual column set so we only copy columns that exist on
    // the deployed install. Any legacy columns on the old table that are
    // NOT in the Phase 2b canonical set are simply not copied.
    const existingCols = db.prepare(`PRAGMA table_info(services)`).all();
    const colNames = new Set(existingCols.map((c) => c.name));
    const has = (name) => (colNames.has(name) ? name : `NULL AS ${name}`);

    db.exec(`
      CREATE TABLE services_new (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'container_service' CHECK(kind IN ('static_site', 'container_service')),
        runtime TEXT CHECK(runtime IN ('lxc', 'docker') OR runtime IS NULL),
        type TEXT NOT NULL CHECK(type IN ('proxy', 'static', 'docker')),
        target TEXT,
        target_ip TEXT,
        lxc_container_name TEXT,
        root_dir TEXT,
        container_name TEXT,
        data_dir TEXT,
        status TEXT DEFAULT 'active' CHECK(status IN ('active', 'inactive', 'error')),
        is_admin INTEGER DEFAULT 0,
        is_favorite INTEGER DEFAULT 0,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);

    db.exec(`
      INSERT INTO services_new (
        id, name, kind, runtime, type, target, target_ip, lxc_container_name,
        root_dir, container_name, data_dir, status, is_admin, is_favorite,
        created_at, updated_at
      )
      SELECT
        id, name,
        ${has('kind')},
        ${has('runtime')},
        type, target,
        ${has('target_ip')},
        ${has('lxc_container_name')},
        ${has('root_dir')},
        ${has('container_name')},
        ${has('data_dir')},
        ${has('status')},
        ${has('is_admin')},
        ${has('is_favorite')},
        created_at, updated_at
      FROM services
    `);

    db.exec(`DROP TABLE services`);
    db.exec(`ALTER TABLE services_new RENAME TO services`);
  });

  runDrop();
  console.log('Phase 2b D.14: services table rebuild complete');
}
