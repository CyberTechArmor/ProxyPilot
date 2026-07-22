import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { mkdirSync, existsSync, chmodSync } from 'fs';
import { dirname, resolve, join } from 'path';
import { fileURLToPath } from 'url';
import { migrateUnencryptedTotpSecrets, assertEncryptionKey } from './lib/secrets.js';
import {
  lbpMigration700, lbpMigration701Blockers, lbpMigration702BoardOrder, lbpMigration703Schedules,
} from './lib/lean-beaf-schema.js';

const __dbFilename = fileURLToPath(import.meta.url);
const __dbDirname = dirname(__dbFilename);
// Project root is 3 levels up from src/db.js (src -> backend -> admin -> root)
const PROJECT_ROOT = resolve(__dbDirname, '..', '..', '..');

// Resolve DATABASE_PATH: if relative, resolve against project root (not CWD).
// The DB lives in its own dedicated subdirectory (data/db/) so that
// chmod'ing the dir to 0700 below cannot accidentally lock other content
// (Caddy-served files under data/services/) away from the caddy user.
const rawDbPath = process.env.DATABASE_PATH || './data/db/proxypilot.db';
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

// Schema-migrations registry. Every named migration registers its
// version + name here; runMigration() consults the schema_migrations
// table to decide whether to execute. New phases MUST add their
// migrations to this registry — do not call CREATE TABLE / ALTER
// TABLE / table-rebuild helpers directly from initDatabase() without
// a version row, otherwise existing installs cannot tell whether the
// migration has run.
//
// Reserved version numbers:
//   1   Phase 2  — UNIQUE(domain) → UNIQUE(domain, path_prefix)
//   2   Phase 2b — services → service_http_routes backfill (A.3)
//   3   Phase 2b — drop legacy route-owned columns from services (D.14)
//   4   Phase 2b — D.14 admin-domain snapshot (post-D.14 hotfix)
//   5   B5 — encrypt plaintext totp_secret rows at rest
//   6   M  — sessions table (revocable JWT jti, sliding last_used_at, sudo_until)
//   7   J  — user lockout columns (failed_attempts, last_failed_at, locked_until)
//   8   N  — webauthn_credentials table + users.webauthn_user_handle
//   100 Phase 2c — per-route knobs on service_http_routes (strip_prefix,
//                  read/write timeouts, max_body_bytes, host_header_override)
//   101 Phase 2c — service_l4_forwards (Incus proxy device emission target)
//   102 Phase 2c — service_detected_ports (cache for the always-visible chip row)
//   103 Phase 2c hotfix — strip trailing `/*` from service_http_routes.path_prefix
//   104 Phase 2c — allow_framing + frame_ancestors columns
//   105 P  — cve_pins (per-user CVE pinning + note)
//   200 Backups — backup_destinations (S3-compatible storage settings)
//   201 Backups — backups (one row per packed artifact uploaded to S3)
//   202 Backups — backup_schedules + restore_runs (PR 2)
//   203 Backups — local_path + s3_uploaded on backups (local-first)
//   204 Backups — backup_schedule_destinations (multi-target fan-out)
//                 + backup_destinations on the backups table
//                 (per-destination upload tracking)
//   205 LXC snapshot S3 export — lxc_snapshot_s3_exports
//   206 LXC snapshot S3 export — bytes_uploaded / bytes_total /
//                                 cancel_requested for live progress
//   207 Backups — restore_runs.backup_id ON DELETE CASCADE
//   300 Notifications — durable backend-posted notifications
//   400 Cert mounts — service_cert_mounts (TLS cert bind-mount intent
//                     into sibling LXCs; consumed by lib/cert-mount-reconciler)
//   500 Mock2 (M0) — users.is_superadmin (the ONLY main-schema touch Mock2
//                     makes; ADR-007). Additive + harmless when Mock2 is
//                     disabled. Note: Mock2's OWN tables live in a separate
//                     file (data/db/mock2.db) and also claim block 500 in
//                     THAT database's schema_migrations — a different table,
//                     no collision (see src/mock2/migrations.js).
//   600 LDAPS — users table rebuild: role CHECK gains 'pending' (LDAP
//               auto-provisioned accounts awaiting a manually-assigned
//               role) + auth_source column ('local' | 'ldap').
//   601 LDAPS — ldap_connections table (directory connection settings;
//               bind password encrypted at rest via lib/secrets.js).
//   602 Permissions — user_permissions table ('proxy' = containers/
//               routing pages, 'developer' = Projects module) granted
//               per user-role account from the access dialog.
//   700 Lean BEAF Pro — team-shared innovation project management
//               (lbp_* tables: projects, rollout scope, locations,
//               activity, meeting markers/schedule, metric catalog +
//               immutable reports, time events, feedback, learnings,
//               files, links, tasks). Body lives in
//               lib/lean-beaf-schema.js; block 700 is reserved for LBP.
//   701 Lean BEAF Pro — lbp_blockers (blocked flag + break-barrier audit
//               trail; one row per block→resolve cycle).
//   702 Lean BEAF Pro — lbp_projects.board_pos (manual Kanban column order).
//   703 Lean BEAF Pro — lbp_schedules (multiple recurring meeting schedules,
//               daily|weekly; migrates the legacy single weekly schedule).
const SCHEMA_MIGRATIONS = [];

function ensureSchemaMigrationsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      run_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

// Backfill version markers for installs that pre-date this framework.
// Detects already-applied migrations by inspecting the live schema
// state, then records them so the runMigration() guards correctly skip
// them. Idempotent: only writes rows that don't already exist.
function backfillSchemaMigrations(db) {
  const insertIfMissing = db.prepare(
    `INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (?, ?)`
  );

  // Version 1: Phase 2 unique-constraint rebuild. Detected by the
  // services table's CREATE statement carrying the (domain, path_prefix)
  // tuple — fresh installs and migrated installs both have it.
  try {
    const row = db
      .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='services'`)
      .get();
    if (row && row.sql && /UNIQUE\s*\(\s*domain\s*,\s*path_prefix/.test(row.sql)) {
      insertIfMissing.run(1, 'phase2_services_unique_domain_path');
    }
  } catch { /* tolerate */ }

  // Version 2: Phase 2b A.3 — service_http_routes table exists.
  try {
    const row = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='service_http_routes'`)
      .get();
    if (row) {
      insertIfMissing.run(2, 'phase2b_services_to_routes_backfill');
    }
  } catch { /* tolerate */ }

  // Version 3: Phase 2b D.14 — services table no longer has the legacy
  // route-owned `domain` column.
  try {
    const cols = db
      .prepare(`PRAGMA table_info(services)`)
      .all()
      .map((c) => c.name);
    if (cols.length > 0 && !cols.includes('domain')) {
      insertIfMissing.run(3, 'phase2b_drop_legacy_route_columns');
    }
  } catch { /* tolerate */ }

  // Version 4: D.14 admin-domain snapshot. Detected by app_settings
  // having the admin_domain key OR the column being absent (which
  // implies the snapshot path either ran or was unnecessary).
  try {
    const row = db
      .prepare(`SELECT value FROM app_settings WHERE key = 'admin_domain'`)
      .get();
    if (row && row.value) {
      insertIfMissing.run(4, 'phase2b_d14_admin_domain_snapshot');
    }
  } catch { /* tolerate */ }
}

// Ensure at least one superadmin exists (ADR-007). Idempotent and
// non-destructive: acts ONLY when zero superadmins are present, promoting
// the oldest admin. This covers the fresh-install ordering gap (the first
// admin is seeded after migration 500 runs) without ever overriding a
// deliberate demotion once a superadmin has been established.
function backfillSuperadmin(db) {
  try {
    const hasSuper = db
      .prepare(`SELECT 1 FROM users WHERE is_superadmin = 1 LIMIT 1`)
      .get();
    if (hasSuper) return;
    const firstAdmin = db
      .prepare(`SELECT id FROM users WHERE role = 'admin' ORDER BY created_at ASC, username ASC LIMIT 1`)
      .get();
    if (firstAdmin) {
      db.prepare(`UPDATE users SET is_superadmin = 1 WHERE id = ?`).run(firstAdmin.id);
      console.log('Backfilled is_superadmin on the first admin user');
    }
  } catch (e) {
    // Column absent (very old snapshot mid-migration) or no users table
    // yet — tolerate; the next boot after migration 500 lands retries.
  }
}

// Public API for future migrations. Wraps a migration function in the
// version guard. Returns true if the migration ran, false if it was
// already recorded as applied.
//
// Usage from a phase-specific helper:
//
//     runMigration(db, 100, 'phase2c_service_port_forwards', (d) => {
//       d.exec('CREATE TABLE service_port_forwards (...)');
//     });
//
// Pass { disableFks: true } for migrations that rebuild a parent table
// via DROP/RENAME — without it, ON DELETE CASCADE on dependent tables
// will cascade-delete during the DROP. PRAGMA foreign_keys can only be
// set outside any transaction, so the toggle has to happen in the
// wrapper, not inside the migration body.
//
// The registered fn must be idempotent in case run_at recording fails
// after the SQL succeeds; SQLite's PRIMARY KEY conflict catches the
// double-insert case automatically.
export function runMigration(db, version, name, fn, opts = {}) {
  ensureSchemaMigrationsTable(db);
  const existing = db
    .prepare(`SELECT 1 FROM schema_migrations WHERE version = ?`)
    .get(version);
  if (existing) return false;

  let fkWasOn = false;
  if (opts.disableFks) {
    fkWasOn = !!db.pragma('foreign_keys', { simple: true });
    if (fkWasOn) db.pragma('foreign_keys = OFF');
  }
  try {
    const tx = db.transaction(() => {
      fn(db);
      db.prepare(
        `INSERT INTO schema_migrations (version, name) VALUES (?, ?)`
      ).run(version, name);
    });
    tx();
  } finally {
    if (opts.disableFks && fkWasOn) {
      db.pragma('foreign_keys = ON');
    }
  }
  console.log(`Applied schema migration ${version}: ${name}`);
  return true;
}

export function initDatabase() {
  const db = getDb();

  // Fail-loud startup check: in production, TOTP_ENCRYPTION_KEY must be
  // set or the secrets module will crash on first TOTP write. Trip the
  // guard here so the server refuses to boot rather than silently
  // running until something tries to encrypt.
  assertEncryptionKey();

  // Bootstrap the migrations registry first so backfill + future
  // runMigration() calls have somewhere to write.
  ensureSchemaMigrationsTable(db);
  backfillSchemaMigrations(db);

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
  // UNIQUE(domain, path_prefix). Wrapped in runMigration so the version row
  // is recorded after the first successful run; backfillSchemaMigrations
  // inserts the version row for already-migrated installs at boot.
  // disableFks: this migration DROPs the services table, which would
  // cascade-delete every dependent row. The flag turns FKs off for the
  // duration so the rebuild is non-destructive.
  runMigration(
    db,
    1,
    'phase2_services_unique_domain_path',
    (d) => migrateServicesUniqueConstraint(d),
    { disableFks: true }
  );

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
  // FK to services(id) IS enforced — better-sqlite3 enables
  // `PRAGMA foreign_keys = ON` by default, and ON DELETE CASCADE means
  // deleting a service automatically removes its routes. Table-rebuild
  // migrations (migrateServicesUniqueConstraint, dropLegacyRouteColumnsFromServices)
  // must use `PRAGMA defer_foreign_keys = ON` so the intermediate
  // DROP/RENAME does not cascade-delete this table's rows. The service
  // DELETE handler (C.5) still walks child rows explicitly to log them
  // for audit before the cascade fires.
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
  runMigration(db, 2, 'phase2b_services_to_routes_backfill', (d) => {
    migrateServicesToRoutes(d);
  });

  // Phase 2b D.14: drop the legacy route-owned columns from `services`.
  // Runs AFTER the routes backfill so every existing row has been mirrored
  // into `service_http_routes` before the physical drop. The wrapped
  // helper also captures the admin row's domain into app_settings before
  // dropping (B6 fix), so admin keeps a discoverable domain post-D.14.
  // disableFks: same reason as migration 1 — this rebuilds the services
  // table and would cascade-wipe service_http_routes (and other child
  // tables) on the DROP TABLE step without the FK toggle.
  runMigration(
    db,
    3,
    'phase2b_drop_legacy_route_columns',
    (d) => dropLegacyRouteColumnsFromServices(d),
    { disableFks: true }
  );

  // B5: encrypt any plaintext totp_secret rows that pre-date the
  // at-rest-encryption module. Idempotent — already-encrypted rows
  // are skipped. New TOTP writes go through encryptSecret() at the
  // route layer.
  runMigration(db, 5, 'b5_encrypt_totp_secrets_at_rest', (d) => {
    migrateUnencryptedTotpSecrets(d);
  });

  // Version 7: J — account lockout columns on users. Tracks failed
  // login attempts and computes a lockout window. Storing on the user
  // row (not a separate login_attempts table) keeps the lockout check
  // a single primary-key lookup; the audit_log table already keeps
  // every LOGIN_FAILED row if forensics needs the full per-attempt
  // history.
  runMigration(db, 7, 'j_user_lockout_columns', (d) => {
    // SQLite ALTER TABLE ADD COLUMN is non-destructive; safe on installs
    // that already have the columns from a manual hand-fix.
    const cols = d.prepare(`PRAGMA table_info(users)`).all().map((c) => c.name);
    if (!cols.includes('failed_attempts')) {
      d.exec(`ALTER TABLE users ADD COLUMN failed_attempts INTEGER NOT NULL DEFAULT 0`);
    }
    if (!cols.includes('last_failed_at')) {
      d.exec(`ALTER TABLE users ADD COLUMN last_failed_at TEXT`);
    }
    if (!cols.includes('locked_until')) {
      d.exec(`ALTER TABLE users ADD COLUMN locked_until TEXT`);
    }
  });

  // Version 6: M — JWT session table (revocable sessions backing the
  // jti claim in issued tokens). Each successful login inserts a row;
  // authenticateToken refuses any token whose jti has no active row,
  // is past expires_at, has revoked_at set, or has been idle longer
  // than the inactivity window. The K-phase sudo grant lives in the
  // same row so a single session lookup answers both "is this token
  // still valid?" and "is sudo currently granted?".
  runMigration(db, 6, 'm_sessions_table', (d) => {
    d.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        expires_at TEXT NOT NULL,
        last_used_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        revoked_at TEXT,
        sudo_until TEXT,
        ip TEXT,
        user_agent TEXT,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
    `);
    d.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);`);
    d.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_revoked_at ON sessions(revoked_at);`);
    d.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_last_used_at ON sessions(last_used_at);`);
  });

  // Version 8: N — passkey (WebAuthn) support. Adds the credentials
  // table plus a stable per-user random handle on the users row that
  // we hand to the authenticator as `user.id`. The handle is a random
  // 32-byte buffer (NOT the username, NOT the user.id UUID) so a
  // credential leak never reveals the operator's account name.
  // Idempotent: PRAGMA table_info gates the ALTER TABLE so a
  // re-run can't duplicate the column.
  runMigration(db, 8, 'n_webauthn_credentials', (d) => {
    d.exec(`
      CREATE TABLE IF NOT EXISTS webauthn_credentials (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        credential_id TEXT NOT NULL UNIQUE,
        public_key BLOB NOT NULL,
        counter INTEGER NOT NULL DEFAULT 0,
        transports TEXT,
        label TEXT,
        aaguid TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        last_used_at TEXT
      )
    `);
    d.exec(`CREATE INDEX IF NOT EXISTS idx_webauthn_user ON webauthn_credentials(user_id)`);
    const cols = d.prepare(`PRAGMA table_info(users)`).all().map((c) => c.name);
    if (!cols.includes('webauthn_user_handle')) {
      d.exec(`ALTER TABLE users ADD COLUMN webauthn_user_handle BLOB`);
    }
  });

  // Version 100: Phase 2c — per-route knobs needed for fan-out workloads
  // (Jitsi-style stacks, LiveKit, anything with a WebSocket leg or a
  // body-size-sensitive upload endpoint). The existing service_http_routes
  // table only carried a coarse `websocket_enabled` flag and a string
  // `max_upload_size`; this migration adds the per-route fields the Caddy
  // emitter now needs to render `transport http { read_timeout 24h … }`,
  // `flush_interval -1`, `handle` vs `handle_path`, and explicit
  // `header_up Host` overrides without leaking any of those decisions
  // into the per-domain merge step.
  //
  // Additive only. Existing rows keep behaving as before:
  //   - strip_prefix defaults to 0; the renderer falls back to its
  //     pre-100 behavior (treat path_prefix != '/' as strip) when the
  //     column is 0 AND there is no path_prefix-strip override at the
  //     write path. The new write paths (Phase 5) set strip_prefix
  //     explicitly so future rows are unambiguous.
  //   - read/write timeout and max_body_bytes default NULL; renderer
  //     uses Caddy defaults when NULL, escalating to 24h timeouts only
  //     when websocket_enabled = 1 (preserves single-domain MEET
  //     semantics without forcing every WS route to spell out timeouts).
  //   - host_header_override defaults NULL; renderer omits the
  //     header_up directive entirely, matching today's pass-through.
  runMigration(db, 100, 'phase2c_route_extra_columns', (d) => {
    const cols = d
      .prepare(`PRAGMA table_info(service_http_routes)`)
      .all()
      .map((c) => c.name);
    if (!cols.includes('strip_prefix')) {
      d.exec(`ALTER TABLE service_http_routes ADD COLUMN strip_prefix INTEGER NOT NULL DEFAULT 0`);
    }
    if (!cols.includes('read_timeout_seconds')) {
      d.exec(`ALTER TABLE service_http_routes ADD COLUMN read_timeout_seconds INTEGER`);
    }
    if (!cols.includes('write_timeout_seconds')) {
      d.exec(`ALTER TABLE service_http_routes ADD COLUMN write_timeout_seconds INTEGER`);
    }
    if (!cols.includes('max_body_bytes')) {
      d.exec(`ALTER TABLE service_http_routes ADD COLUMN max_body_bytes INTEGER`);
    }
    if (!cols.includes('host_header_override')) {
      d.exec(`ALTER TABLE service_http_routes ADD COLUMN host_header_override TEXT`);
    }
    // Backfill: pre-100 renderer treated path_prefix != '/' as "strip
    // the prefix" (handle_path semantics in Caddy). New rows default
    // strip_prefix=0, so without this backfill an upgrade would silently
    // change every prefixed route's matching from `handle_path /foo*`
    // to `handle /foo*` and break upstream apps that assumed the
    // prefix would be gone. Run once, idempotent: only flips rows
    // that are still at the column default.
    d.exec(
      `UPDATE service_http_routes
         SET strip_prefix = 1
       WHERE path_prefix IS NOT NULL
         AND path_prefix != '/'
         AND strip_prefix = 0`
    );
  });

  // Version 101: Phase 2c — service_l4_forwards table. Captures the
  // raw L4 (UDP / TCP) ports that have to bypass Caddy entirely:
  // WebRTC media (udp/50000-60000), TCP fallbacks, anything Caddy
  // can't reverse-proxy. One row per forward; the reconciler emits
  // one Incus proxy device per row (named `ppl4-<id>` so the cleanup
  // pass can identify ProxyPilot-managed devices by prefix) plus a
  // paired firewall_rules entry with source='service-l4'.
  //
  // The bridge IP is intentionally NOT stored here — it always comes
  // from services.target_ip so a container-IP change updates every
  // forward in one place. Storing connect_ip would create a drift
  // surface where the row's IP and the service's IP can disagree.
  //
  // listen_port_end / connect_port_end are NULL for single-port
  // forwards. When set, the range must be the same width on both
  // sides; the write endpoint validates this so the schema doesn't
  // need a CHECK that would block table rebuilds.
  //
  // UNIQUE(proto, listen_port, listen_port_end) prevents two services
  // from claiming the same host edge port — the operator gets a
  // clear conflict at create time instead of a silent reconcile race.
  runMigration(db, 101, 'phase2c_service_l4_forwards', (d) => {
    d.exec(`
      CREATE TABLE IF NOT EXISTS service_l4_forwards (
        id TEXT PRIMARY KEY,
        service_id TEXT NOT NULL,
        proto TEXT NOT NULL CHECK (proto IN ('tcp', 'udp')),
        listen_port INTEGER NOT NULL,
        listen_port_end INTEGER,
        connect_port INTEGER NOT NULL,
        connect_port_end INTEGER,
        description TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (service_id) REFERENCES services(id) ON DELETE CASCADE,
        UNIQUE(proto, listen_port, listen_port_end)
      )
    `);
    d.exec(`
      CREATE INDEX IF NOT EXISTS idx_service_l4_forwards_service
      ON service_l4_forwards(service_id)
    `);
  });

  // Version 102: Phase 2c — service_detected_ports cache. The
  // detector (Phase 3) writes the last-known set of ports the
  // service is actually listening on; the service detail panel
  // reads from here so the always-visible chip row doesn't re-probe
  // the LXC on every page load.
  //
  // `port_end` is set when the detector collapses ≥ 8 contiguous
  // ports of the same proto into a single range chip. The Caddy
  // can't-reverse-proxy-a-range constraint is enforced at the UI
  // layer (range chips disable the "Add as HTTP route" action).
  //
  // `source` distinguishes scan origin: 'proc_net' for direct
  // /proc/net/{tcp,udp} reads, 'docker_compose' for ports declared
  // in a compose file inside the LXC, 'declared' for operator-
  // entered metadata. The detector picks the most authoritative
  // source per (proto, port) and writes one row.
  //
  // UNIQUE(service_id, proto, port, port_end) lets the rescan
  // reconciler do a delete-then-insert per (service, source) batch
  // without producing duplicate chips. detected_at is a wall-clock
  // ISO timestamp so the UI can show "last scan: 14:02".
  runMigration(db, 102, 'phase2c_service_detected_ports', (d) => {
    d.exec(`
      CREATE TABLE IF NOT EXISTS service_detected_ports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        service_id TEXT NOT NULL,
        proto TEXT NOT NULL CHECK (proto IN ('tcp', 'udp')),
        port INTEGER NOT NULL,
        port_end INTEGER,
        source TEXT NOT NULL CHECK (source IN ('proc_net', 'docker_compose', 'declared')),
        detected_at TEXT NOT NULL,
        FOREIGN KEY (service_id) REFERENCES services(id) ON DELETE CASCADE,
        UNIQUE(service_id, proto, port, port_end)
      )
    `);
    d.exec(`
      CREATE INDEX IF NOT EXISTS idx_service_detected_ports_service
      ON service_detected_ports(service_id)
    `);
  });

  // Version 103: Phase 2c hotfix — strip trailing /* from path_prefix.
  // The first cut of the LXC Quick Add MEET preset stored paths as
  // `/api/*`, `/livekit/*`, etc. with the conventional Caddy-glob
  // suffix baked in. The merged-config renderer in services.js
  // appends `*` itself when emitting `handle ${pathPrefix}*`, so
  // those rows produced `handle /api/**` — a literal-string
  // matcher that never matches a real request, falling all traffic
  // through to the catch-all and breaking /api / /livekit routing.
  //
  // This migration normalizes any stored row that ends in /* to the
  // bare-prefix form the renderer expects. Idempotent — only flips
  // rows that match the bad pattern. The root path '/' is left
  // alone (it matches /\/$/ but not /\/\*$/).
  runMigration(db, 103, 'phase2c_strip_trailing_glob_from_paths', (d) => {
    d.exec(`
      UPDATE service_http_routes
         SET path_prefix = SUBSTR(path_prefix, 1, LENGTH(path_prefix) - 2)
       WHERE path_prefix LIKE '%/*'
         AND path_prefix != '/*'
    `);
  });

  // Version 104: Phase 2c — allow-framing knob on service_http_routes.
  // The renderer hard-codes `X-Frame-Options: SAMEORIGIN` in the site
  // header block, which is correct for vanilla apps but wrong for
  // anything that NEEDS to be embeddable (MEET's meeting page, any
  // OAuth/iframe-driven flow). Two columns:
  //
  //   allow_framing    INTEGER 0|1     when 1, the site emits
  //                                    `-X-Frame-Options` (Caddy's
  //                                    delete-header syntax) instead
  //                                    of setting it, and adds a
  //                                    `Content-Security-Policy:
  //                                    frame-ancestors <list>` header.
  //   frame_ancestors  TEXT            comma-separated origin list
  //                                    that becomes the CSP value.
  //                                    NULL/empty → wildcard '*'.
  //
  // Site-level effect: any single route on the domain having
  // allow_framing=1 flips the whole site's header block to the
  // framing-friendly variant. Site headers are global to all paths
  // by Caddy's design, so per-route would just paper over that.
  runMigration(db, 104, 'phase2c_allow_framing', (d) => {
    const cols = d
      .prepare(`PRAGMA table_info(service_http_routes)`)
      .all()
      .map((c) => c.name);
    if (!cols.includes('allow_framing')) {
      d.exec(`ALTER TABLE service_http_routes ADD COLUMN allow_framing INTEGER NOT NULL DEFAULT 0`);
    }
    if (!cols.includes('frame_ancestors')) {
      d.exec(`ALTER TABLE service_http_routes ADD COLUMN frame_ancestors TEXT`);
    }
  });

  // CVE pins — per-operator "starred" flags for inbox entries the
  // operator wants to come back to. Lives in the dashboard DB
  // rather than the YAML so:
  //   - The engine contract (only mutates state.status / .last_updated
  //     / .history) is preserved.
  //   - Each operator sees their own pins; one team mate flagging
  //     something doesn't pollute the others' view.
  // The optional `note` is a one-line label so the pin can mean
  // something specific ("waiting for upstream DSA", "manual mit
  // applied", etc.).
  runMigration(db, 105, 'p_cve_pins', (d) => {
    d.exec(`
      CREATE TABLE IF NOT EXISTS cve_pins (
        user_id   TEXT NOT NULL,
        cve_id    TEXT NOT NULL,
        pinned_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        note      TEXT,
        PRIMARY KEY (user_id, cve_id),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);
    d.exec(`CREATE INDEX IF NOT EXISTS idx_cve_pins_user ON cve_pins(user_id)`);
  });

  // Backups feature (PR 1 — foundation). One row per S3-compatible
  // destination the operator has registered. The secret_key column
  // stores AES-GCM ciphertext via lib/secrets.encryptSecret() — same
  // at-rest envelope as totp_secret. test_status / test_at carry the
  // last "test connection" verdict so the UI can surface it without
  // re-issuing a HEAD on every page load. Exactly one row may have
  // is_default = 1 at any time; the route layer enforces that with
  // a transaction (SQLite has no WHERE-clause partial unique-index
  // form that's portable across the older client we target).
  runMigration(db, 200, 'backups_destinations', (d) => {
    d.exec(`
      CREATE TABLE IF NOT EXISTS backup_destinations (
        id              TEXT PRIMARY KEY,
        name            TEXT UNIQUE NOT NULL,
        endpoint_url    TEXT NOT NULL,
        bucket          TEXT NOT NULL,
        region          TEXT,
        path_prefix     TEXT,
        access_key_id   TEXT NOT NULL,
        secret_key_enc  TEXT NOT NULL,
        use_ssl         INTEGER NOT NULL DEFAULT 1,
        path_style      INTEGER NOT NULL DEFAULT 0,
        storage_class   TEXT,
        is_default      INTEGER NOT NULL DEFAULT 0,
        test_status     TEXT,
        test_at         TEXT,
        created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    d.exec(`
      CREATE INDEX IF NOT EXISTS idx_backup_destinations_default
        ON backup_destinations(is_default)
    `);
  });

  // Backups feature — one row per packed-and-uploaded backup
  // artifact. status starts at 'in_progress'; the route flips it
  // to 'ok' (with size_bytes + manifest_json) or 'failed' (with
  // error) at the end of the upload. parent_backup is reserved
  // for incremental chains in a future round; PR 1 always sets
  // it NULL. backup_schedules + restore_runs land in PR 2.
  runMigration(db, 201, 'backups_artifacts', (d) => {
    d.exec(`
      CREATE TABLE IF NOT EXISTS backups (
        id              TEXT PRIMARY KEY,
        destination_id  TEXT NOT NULL REFERENCES backup_destinations(id),
        tier            TEXT NOT NULL,
        scope           TEXT,
        s3_key          TEXT NOT NULL,
        size_bytes      INTEGER NOT NULL DEFAULT 0,
        encrypted       INTEGER NOT NULL DEFAULT 1,
        created_by      TEXT,
        created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        manifest_json   TEXT NOT NULL DEFAULT '{}',
        parent_backup   TEXT REFERENCES backups(id),
        status          TEXT NOT NULL,
        error           TEXT
      )
    `);
    d.exec(`
      CREATE INDEX IF NOT EXISTS idx_backups_destination
        ON backups(destination_id)
    `);
    d.exec(`
      CREATE INDEX IF NOT EXISTS idx_backups_created
        ON backups(created_at DESC)
    `);
  });

  // PR 2 — schedules + restore runs.
  //
  // backup_schedules: one row per cron-driven recurring backup.
  // The cron worker (lib/backup-scheduler) hydrates from this
  // table on boot and re-registers on every CRUD mutation. The
  // last_run_* columns are updated by the worker when each
  // scheduled job finishes; next_run_at is updated each time the
  // schedule is (re-)registered so the UI can surface "next run
  // in N hours" without computing the next tick from cron_expr.
  //
  // retention_keep + retention_days work additively: a schedule
  // with keep=30 + days=90 prunes anything that fails BOTH gates
  // (i.e. older than 30 backups AND older than 90 days). Either
  // can be NULL to disable that axis.
  //
  // restore_runs: one row per restore attempt — both dry-run and
  // apply land here so the dashboard's history view is uniform.
  // steps_json carries the per-step outcomes (start/finish ts,
  // status, optional output blob) for the live-log panel; the
  // worker writes it incrementally as each step completes.
  runMigration(db, 202, 'backups_schedules_and_restores', (d) => {
    d.exec(`
      CREATE TABLE IF NOT EXISTS backup_schedules (
        id              TEXT PRIMARY KEY,
        name            TEXT NOT NULL,
        destination_id  TEXT NOT NULL REFERENCES backup_destinations(id),
        cron_expr       TEXT NOT NULL,
        tier            TEXT NOT NULL,
        scope           TEXT,
        retention_keep  INTEGER NOT NULL DEFAULT 30,
        retention_days  INTEGER,
        passphrase_hint TEXT,
        passphrase_enc  TEXT,
        enabled         INTEGER NOT NULL DEFAULT 1,
        last_run_at     TEXT,
        last_run_status TEXT,
        last_run_error  TEXT,
        next_run_at     TEXT,
        created_by      TEXT,
        created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    d.exec(`
      CREATE INDEX IF NOT EXISTS idx_backup_schedules_destination
        ON backup_schedules(destination_id)
    `);
    d.exec(`
      CREATE INDEX IF NOT EXISTS idx_backup_schedules_enabled
        ON backup_schedules(enabled)
    `);

    d.exec(`
      CREATE TABLE IF NOT EXISTS restore_runs (
        id              TEXT PRIMARY KEY,
        backup_id       TEXT NOT NULL REFERENCES backups(id),
        mode            TEXT NOT NULL,
        target          TEXT NOT NULL,
        sandbox_dir     TEXT,
        started_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        finished_at     TEXT,
        status          TEXT NOT NULL,
        steps_json      TEXT NOT NULL DEFAULT '[]',
        initiated_by    TEXT NOT NULL,
        notes           TEXT
      )
    `);
    d.exec(`
      CREATE INDEX IF NOT EXISTS idx_restore_runs_backup
        ON restore_runs(backup_id)
    `);
    d.exec(`
      CREATE INDEX IF NOT EXISTS idx_restore_runs_started
        ON restore_runs(started_at DESC)
    `);
  });

  // Local-first backups (operator request).
  //
  // Pre-203 behaviour: backups went straight from packer to S3.
  // Pulling them down for restore meant a network round-trip even
  // when the backup was 10 minutes old.  Operators (rightly)
  // pushed back: 'I want a local cache so download/restore is
  // instant; S3 is for off-host durability and long-term storage.'
  //
  // New shape:
  //
  //   local_path     filesystem path of the on-disk artifact, NULL
  //                  if the local copy was pruned by retention.
  //   s3_uploaded    1 once the upload to the destination resolved
  //                  successfully; 0 if local-only or if the upload
  //                  failed.  destination_id stays NOT NULL because
  //                  the row tracks where it eventually went; the
  //                  bool decides whether the object is actually
  //                  in the bucket yet.
  //
  // Existing rows: backfilled to local_path=NULL, s3_uploaded=1
  // (PR 1 + PR 2 always uploaded; an existing row that has a
  // status='ok' must be in S3, otherwise it wouldn't be here).
  //
  // destination_id loosened to nullable so a future commit can
  // ship local-only backups (no S3 dest configured).  The route
  // layer takes care of the 'no dest = local-only' path.
  runMigration(db, 203, 'backups_local_first', (d) => {
    // ALTER TABLE ADD COLUMN with a constant default works in
    // SQLite and respects existing rows.  No tx wrap needed —
    // runMigration's outer transaction covers the whole thing.
    d.exec(`ALTER TABLE backups ADD COLUMN local_path TEXT`);
    d.exec(`ALTER TABLE backups ADD COLUMN s3_uploaded INTEGER NOT NULL DEFAULT 0`);
    d.exec(`UPDATE backups SET s3_uploaded = 1 WHERE status = 'ok'`);
  });

  // Multi-destination fan-out (operator request).
  //
  // Pre-204: each schedule + each on-demand backup pointed at
  // exactly one destination (or none, with the local-first
  // rework).  Operators with both an on-site MinIO and an off-
  // site B2 want to push the same nightly backup to BOTH so a
  // host fire doesn't take the bucket with it.
  //
  // Two new shapes:
  //
  //   backup_schedule_destinations (junction)
  //     One row per (schedule, destination) edge.  A schedule
  //     with zero edges is local-only; one edge = legacy
  //     behaviour; many edges = fan-out.  ON DELETE CASCADE so
  //     dropping a schedule or destination cleans both sides.
  //
  //   backup_destinations_x_backups (junction)
  //     One row per (backup-artifact, destination) edge with
  //     the per-destination upload state (uploaded vs failed
  //     vs deleted) and the destination-specific S3 key.
  //     Replaces the single backups.s3_key + backups.s3_uploaded
  //     pair when fan-out happens; the legacy columns stay for
  //     back-compat with PR-1/PR-2 callers and are kept in
  //     lockstep with the junction's "first destination" row.
  //
  // The legacy backups.destination_id column is retained but
  // becomes informational ("primary destination at create time").
  // Authoritative state lives in the junction.
  runMigration(db, 204, 'backups_multi_destination', (d) => {
    d.exec(`
      CREATE TABLE IF NOT EXISTS backup_schedule_destinations (
        schedule_id    TEXT NOT NULL REFERENCES backup_schedules(id) ON DELETE CASCADE,
        destination_id TEXT NOT NULL REFERENCES backup_destinations(id) ON DELETE CASCADE,
        created_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (schedule_id, destination_id)
      )
    `);
    d.exec(`CREATE INDEX IF NOT EXISTS idx_bsd_schedule
      ON backup_schedule_destinations(schedule_id)`);
    d.exec(`CREATE INDEX IF NOT EXISTS idx_bsd_destination
      ON backup_schedule_destinations(destination_id)`);

    d.exec(`
      CREATE TABLE IF NOT EXISTS backup_destinations_x_backups (
        backup_id      TEXT NOT NULL REFERENCES backups(id) ON DELETE CASCADE,
        destination_id TEXT NOT NULL REFERENCES backup_destinations(id) ON DELETE CASCADE,
        s3_key         TEXT NOT NULL,
        status         TEXT NOT NULL CHECK(status IN ('pending','uploaded','failed','deleted')),
        size_bytes     INTEGER,
        error          TEXT,
        uploaded_at    TEXT,
        deleted_at     TEXT,
        PRIMARY KEY (backup_id, destination_id)
      )
    `);
    d.exec(`CREATE INDEX IF NOT EXISTS idx_bdxb_backup
      ON backup_destinations_x_backups(backup_id)`);
    d.exec(`CREATE INDEX IF NOT EXISTS idx_bdxb_destination
      ON backup_destinations_x_backups(destination_id)`);

    // Backfill: every existing schedule with a destination_id
    // gets a junction row so fan-out reads see it.  Existing
    // backups with s3_uploaded=1 get a junction row in
    // 'uploaded' state targeting the same destination.
    d.exec(`
      INSERT OR IGNORE INTO backup_schedule_destinations (schedule_id, destination_id)
      SELECT id, destination_id FROM backup_schedules
      WHERE destination_id IS NOT NULL
    `);
    d.exec(`
      INSERT OR IGNORE INTO backup_destinations_x_backups
        (backup_id, destination_id, s3_key, status, size_bytes, uploaded_at)
      SELECT id, destination_id, s3_key, 'uploaded', size_bytes, created_at
      FROM backups
      WHERE destination_id IS NOT NULL AND s3_uploaded = 1
    `);
  });

  // LXC snapshot S3 export (operator request).
  //
  // Snapshots produced by `incus snapshot create` live exclusively
  // on the host's Incus storage pool today.  An operator running
  // multiple hosts wants the option to also push the snapshot
  // tarball (`incus export`) to one or more S3 destinations so
  // host-level disk loss doesn't take the snapshot with it.
  //
  // We track each (instance, snapshot, destination) export in its
  // own table — keyed off names (no FK to a host snapshot row,
  // since Incus snapshots aren't a DB construct in this app).  A
  // single snapshot can have multiple export rows (one per
  // destination) so the UI can render 'on-site ✓ · off-site ✓'
  // alongside the existing snapshot list.
  //
  // status:
  //   pending  — `incus export` started; tarball not yet on S3.
  //   exported — tarball uploaded successfully.
  //   failed   — either the export shell-out or the S3 upload
  //              tripped; error column has the detail.
  //   deleted  — tarball removed from S3 by the operator.
  runMigration(db, 205, 'lxc_snapshot_s3_exports', (d) => {
    d.exec(`
      CREATE TABLE IF NOT EXISTS lxc_snapshot_s3_exports (
        id              TEXT PRIMARY KEY,
        container_name  TEXT NOT NULL,
        snapshot_name   TEXT NOT NULL,
        destination_id  TEXT NOT NULL REFERENCES backup_destinations(id) ON DELETE CASCADE,
        s3_key          TEXT NOT NULL,
        size_bytes      INTEGER,
        status          TEXT NOT NULL CHECK(status IN ('pending','exported','failed','deleted')),
        error           TEXT,
        started_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        finished_at     TEXT,
        created_by      TEXT
      )
    `);
    d.exec(`
      CREATE INDEX IF NOT EXISTS idx_lxc_snap_export_container
        ON lxc_snapshot_s3_exports(container_name, snapshot_name)
    `);
    d.exec(`
      CREATE INDEX IF NOT EXISTS idx_lxc_snap_export_destination
        ON lxc_snapshot_s3_exports(destination_id)
    `);
  });

  // LXC snapshot S3 export — live progress (operator request).
  //
  // The 205 schema only captured terminal state (pending →
  // exported / failed / deleted).  Operators want to:
  //   * see a percentage while a multi-GB tarball uploads,
  //   * cancel an in-flight upload from the UI,
  //   * leave the dashboard and come back without losing
  //     progress visibility.
  //
  // bytes_uploaded + bytes_total are written by the Upload's
  // httpUploadProgress callback (throttled to ~once/500ms so the
  // DB doesn't churn on every chunk).  cancel_requested is the
  // poll-and-abort signal — the route layer flips it to 1, the
  // upload promise's progress callback observes it next tick,
  // calls upload.abort(), and the helper records status='failed'
  // with error='canceled by operator'.
  runMigration(db, 206, 'lxc_snapshot_s3_exports_progress', (d) => {
    d.exec(`ALTER TABLE lxc_snapshot_s3_exports ADD COLUMN bytes_uploaded INTEGER NOT NULL DEFAULT 0`);
    d.exec(`ALTER TABLE lxc_snapshot_s3_exports ADD COLUMN bytes_total INTEGER`);
    d.exec(`ALTER TABLE lxc_snapshot_s3_exports ADD COLUMN cancel_requested INTEGER NOT NULL DEFAULT 0`);
  });

  // restore_runs.backup_id missed an ON DELETE CASCADE in
  // migration 202.  Without it, any backup that's ever been the
  // subject of a restore dry-run cannot be deleted — DELETE FROM
  // backups trips 'FOREIGN KEY constraint failed' because
  // restore_runs is still pointing at the parent.  Operators
  // hitting an orphan backup row (retention pruned local + S3
  // copy gone) couldn't drop it from the dashboard.
  //
  // SQLite doesn't support ALTER TABLE to change a foreign key,
  // so we follow the standard recreate-and-copy pattern:
  //   1. Build a new table with the corrected schema.
  //   2. Copy every row from the old table.
  //   3. Drop the old table.
  //   4. Rename the new table into place.
  // disableFks: true on this migration is critical — we're about
  // to violate referential integrity briefly inside the rename
  // shuffle and the global FK enforcement would block it.  The
  // outer runMigration transaction wraps everything, so a partial
  // failure rolls back cleanly.
  runMigration(db, 207, 'restore_runs_cascade', (d) => {
    d.exec(`
      CREATE TABLE restore_runs__new (
        id              TEXT PRIMARY KEY,
        backup_id       TEXT NOT NULL REFERENCES backups(id) ON DELETE CASCADE,
        mode            TEXT NOT NULL,
        target          TEXT NOT NULL,
        sandbox_dir     TEXT,
        started_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        finished_at     TEXT,
        status          TEXT NOT NULL,
        steps_json      TEXT NOT NULL DEFAULT '[]',
        initiated_by    TEXT NOT NULL,
        notes           TEXT
      )
    `);
    d.exec(`
      INSERT INTO restore_runs__new
        (id, backup_id, mode, target, sandbox_dir, started_at,
         finished_at, status, steps_json, initiated_by, notes)
      SELECT id, backup_id, mode, target, sandbox_dir, started_at,
             finished_at, status, steps_json, initiated_by, notes
      FROM restore_runs
    `);
    d.exec(`DROP TABLE restore_runs`);
    d.exec(`ALTER TABLE restore_runs__new RENAME TO restore_runs`);
    d.exec(`
      CREATE INDEX IF NOT EXISTS idx_restore_runs_backup
        ON restore_runs(backup_id)
    `);
    d.exec(`
      CREATE INDEX IF NOT EXISTS idx_restore_runs_started
        ON restore_runs(started_at DESC)
    `);
  }, { disableFks: true });

  // Loosen backups.destination_id to nullable.
  //
  // The 203 migration's comment promised this would be loosened
  // 'in a future commit' so local-only backups could ship.  That
  // future commit never landed; the route layer started inserting
  // NULL for local-only backups and tripped 'NOT NULL constraint
  // failed: backups.destination_id' (May 2026 review).
  //
  // SQLite doesn't support ALTER COLUMN to drop NOT NULL, so we
  // recreate the table with the loosened constraint, copy rows
  // through, drop, rename — same dance as 207.
  runMigration(db, 208, 'backups_destination_id_nullable', (d) => {
    d.exec(`
      CREATE TABLE backups__new (
        id              TEXT PRIMARY KEY,
        destination_id  TEXT REFERENCES backup_destinations(id),
        tier            TEXT NOT NULL,
        scope           TEXT,
        s3_key          TEXT NOT NULL,
        size_bytes      INTEGER NOT NULL DEFAULT 0,
        encrypted       INTEGER NOT NULL DEFAULT 1,
        created_by      TEXT,
        created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        manifest_json   TEXT NOT NULL DEFAULT '{}',
        parent_backup   TEXT REFERENCES backups(id),
        status          TEXT NOT NULL,
        error           TEXT,
        local_path      TEXT,
        s3_uploaded     INTEGER NOT NULL DEFAULT 0
      )
    `);
    d.exec(`
      INSERT INTO backups__new
        (id, destination_id, tier, scope, s3_key, size_bytes, encrypted,
         created_by, created_at, manifest_json, parent_backup, status,
         error, local_path, s3_uploaded)
      SELECT id, destination_id, tier, scope, s3_key, size_bytes, encrypted,
             created_by, created_at, manifest_json, parent_backup, status,
             error, local_path, s3_uploaded
      FROM backups
    `);
    d.exec(`DROP TABLE backups`);
    d.exec(`ALTER TABLE backups__new RENAME TO backups`);
    d.exec(`
      CREATE INDEX IF NOT EXISTS idx_backups_destination
        ON backups(destination_id)
    `);
    d.exec(`
      CREATE INDEX IF NOT EXISTS idx_backups_created
        ON backups(created_at DESC)
    `);
  }, { disableFks: true });

  // Durable notifications.
  //
  // Pre-300: the bell + unread count in Layout.jsx were powered
  // entirely by the in-memory toast history (cap 50, lost on
  // refresh).  Fine for ephemeral 'I just clicked Save' feedback
  // but useless for things the operator needs to see hours later
  // — like 'last night's backup failed' or 'S3 destination has
  // been unreachable for 12h'.
  //
  // Schema notes:
  //   level         info | warning | error
  //   source        free-form short string identifying which
  //                 subsystem fired this — 'backup-schedule' /
  //                 'backup-s3-healthcheck' / 'firewall' / etc.
  //                 The route layer doesn't enforce a vocabulary
  //                 since each subsystem owns its own keys.
  //   source_id     optional id of the subject row (e.g. a
  //                 backup_destinations.id when the source is
  //                 'backup-s3-healthcheck').  Lets the UI link
  //                 the notification to its origin without us
  //                 needing a polymorphic FK.
  //   dedupe_key    when set, posting a new notification with
  //                 the same dedupe_key updates the existing
  //                 row's body + last_seen_at instead of
  //                 inserting a new one.  Keeps the bell from
  //                 flooding when a daily probe fails 30 days
  //                 in a row.
  //   read_at       NULL until the operator clicks/dismisses;
  //                 unread count = COUNT(*) WHERE read_at IS NULL.
  runMigration(db, 300, 'notifications', (d) => {
    d.exec(`
      CREATE TABLE IF NOT EXISTS notifications (
        id            TEXT PRIMARY KEY,
        level         TEXT NOT NULL CHECK(level IN ('info', 'warning', 'error')),
        title         TEXT NOT NULL,
        body          TEXT,
        source        TEXT NOT NULL,
        source_id     TEXT,
        dedupe_key    TEXT,
        seen_count    INTEGER NOT NULL DEFAULT 1,
        first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_seen_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        read_at       TEXT,
        dismissed_at  TEXT
      )
    `);
    d.exec(`CREATE INDEX IF NOT EXISTS idx_notifications_unread
      ON notifications(read_at, last_seen_at DESC)`);
    d.exec(`CREATE INDEX IF NOT EXISTS idx_notifications_source
      ON notifications(source, source_id)`);
    d.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_dedupe
      ON notifications(dedupe_key) WHERE dedupe_key IS NOT NULL`);
  });

  // Notification channels — the admin-configurable "standard connections" that
  // fan a notification out beyond the in-app bell: an SMTP email channel and a
  // provider-agnostic SMS-over-HTTP channel. One row per kind. The secret (SMTP
  // password / SMS auth token) is stored encrypted at rest (lib/secrets.js);
  // config_json holds only non-secret settings. test_status caches the last
  // send-a-test verdict for the admin UI.
  runMigration(db, 301, 'notification_channels', (d) => {
    d.exec(`
      CREATE TABLE IF NOT EXISTS notification_channels (
        kind        TEXT PRIMARY KEY CHECK(kind IN ('smtp', 'sms')),
        enabled     INTEGER NOT NULL DEFAULT 0,
        config_json TEXT,
        secret_enc  TEXT,
        test_status TEXT CHECK(test_status IN ('ok', 'fail') OR test_status IS NULL),
        test_error  TEXT,
        test_at     TEXT,
        updated_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
  });

  // Cert mounts — TLS cert bind-mount intent. ProxyPilot stores intent
  // only; Incus owns the live device. Same source-of-truth split as
  // service_l4_forwards: lib/cert-mount-reconciler reads this table on
  // boot + on operator action and emits `incus config device add ...
  // disk source=<host-cert-dir> path=<target> readonly=true` calls so
  // the consumer LXC sees the same inode Caddy is rotating, no copy
  // and no admin-API dependency.
  //
  // Field notes:
  //   hostname        snapshotted from services.domain at create time —
  //                   a later rename of the parent service must not
  //                   silently repoint the live mount at a different
  //                   cert directory.
  //   cert_dir        absolute host path resolved via lib/caddy-cert
  //                   resolveCertDir() (CADDY_ACME_DIR + issuer +
  //                   hostname). Stored verbatim so reconcile can match
  //                   the live device's `source=` without re-resolving
  //                   (which could pick a different issuer dir
  //                   mid-rotation).
  //   container_name  operator-facing, no `pp-` prefix imposed by
  //                   ProxyPilot — any container `incus list` returns
  //                   is a valid target so the same workflow covers
  //                   sibling LXCs that ProxyPilot didn't create.
  //   device_name     operator-friendly (default 'meet-tls' to match
  //                   the MEET helper's published spec). UNIQUE
  //                   (container_name, device_name) prevents this
  //                   table from issuing two `device add` calls that
  //                   collide on the live container.
  runMigration(db, 400, 'cert_mounts_service_cert_mounts', (d) => {
    d.exec(`
      CREATE TABLE IF NOT EXISTS service_cert_mounts (
        id              TEXT PRIMARY KEY,
        service_id      TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
        hostname        TEXT NOT NULL,
        cert_dir        TEXT NOT NULL,
        container_name  TEXT NOT NULL,
        device_name     TEXT NOT NULL,
        target_path     TEXT NOT NULL,
        readonly        INTEGER NOT NULL DEFAULT 1,
        created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        created_by      TEXT,
        UNIQUE (container_name, device_name)
      )
    `);
    d.exec(`
      CREATE INDEX IF NOT EXISTS idx_cert_mounts_service
        ON service_cert_mounts(service_id)
    `);
  });

  // Mock2 (M0) — users.is_superadmin (ADR-007). The local break-glass
  // marker that outlives the future LDAPS provisioning layer. Additive
  // and harmless on hosts where Mock2 is disabled: the column exists, the
  // rule that references it (routes/user.js) is inert until a superadmin
  // is targeted. Backfills the oldest admin as superadmin for installs
  // that already have users at upgrade time; fresh installs (no users yet)
  // are handled by backfillSuperadmin() below on the next boot.
  runMigration(db, 500, 'mock2_users_is_superadmin', (d) => {
    d.exec(`ALTER TABLE users ADD COLUMN is_superadmin INTEGER NOT NULL DEFAULT 0`);
    const firstAdmin = d
      .prepare(`SELECT id FROM users WHERE role = 'admin' ORDER BY created_at ASC, username ASC LIMIT 1`)
      .get();
    if (firstAdmin) {
      d.prepare(`UPDATE users SET is_superadmin = 1 WHERE id = ?`).run(firstAdmin.id);
    }
  });

  // Self-heal the superadmin backfill. On a fresh install the first admin
  // is created (via initial-setup) AFTER migrations run, so migration 500's
  // backfill is a no-op there. Whenever NO superadmin exists, promote the
  // oldest admin. Guarded on "zero superadmins" so it never demotes or
  // overrides a deliberate assignment — once one exists, this stops acting.
  backfillSuperadmin(db);

  // Version 600: LDAPS — loosen the users.role CHECK to allow 'pending'
  // and add auth_source. LDAP-authenticated users are auto-provisioned
  // with role='pending' and see nothing but their profile page until an
  // admin assigns a real role. SQLite can't ALTER a CHECK constraint, so
  // this is a table rebuild (copy → drop → rename), same dance as 207/208.
  // disableFks: sessions, user_service_access, webauthn_credentials, etc.
  // all FK into users(id) with ON DELETE CASCADE — the DROP would wipe
  // them without the toggle.
  runMigration(db, 600, 'ldaps_users_pending_role_and_auth_source', (d) => {
    const cols = new Set(
      d.prepare(`PRAGMA table_info(users)`).all().map((c) => c.name)
    );
    const has = (name, fallback) =>
      cols.has(name) ? name : `${fallback} AS ${name}`;
    d.exec(`
      CREATE TABLE users__new (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        display_name TEXT,
        password_hash TEXT NOT NULL,
        totp_secret TEXT NOT NULL,
        totp_enabled INTEGER DEFAULT 1,
        role TEXT DEFAULT 'user' CHECK(role IN ('admin', 'user', 'pending')),
        password_change_required INTEGER DEFAULT 0,
        failed_attempts INTEGER NOT NULL DEFAULT 0,
        last_failed_at TEXT,
        locked_until TEXT,
        webauthn_user_handle BLOB,
        is_superadmin INTEGER NOT NULL DEFAULT 0,
        auth_source TEXT NOT NULL DEFAULT 'local' CHECK(auth_source IN ('local', 'ldap')),
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);
    d.exec(`
      INSERT INTO users__new (
        id, username, display_name, password_hash, totp_secret, totp_enabled,
        role, password_change_required, failed_attempts, last_failed_at,
        locked_until, webauthn_user_handle, is_superadmin, auth_source,
        created_at, updated_at
      )
      SELECT
        id, username,
        ${has('display_name', 'NULL')},
        password_hash, totp_secret,
        ${has('totp_enabled', '1')},
        COALESCE(role, 'admin'),
        ${has('password_change_required', '0')},
        ${has('failed_attempts', '0')},
        ${has('last_failed_at', 'NULL')},
        ${has('locked_until', 'NULL')},
        ${has('webauthn_user_handle', 'NULL')},
        ${has('is_superadmin', '0')},
        'local',
        created_at, updated_at
      FROM users
    `);
    d.exec(`DROP TABLE users`);
    d.exec(`ALTER TABLE users__new RENAME TO users`);
  }, { disableFks: true });

  // Version 601: LDAPS — directory connection settings. One row per
  // configured directory; the login flow tries every enabled row in
  // creation order until one authenticates the user. bind_password_enc
  // is AES-GCM ciphertext via lib/secrets.encryptSecret() — same at-rest
  // envelope as totp_secret. ca_cert holds an optional PEM chain for
  // directories with a private CA; tls_verify=0 skips certificate
  // verification entirely (lab use only, the UI warns about it).
  runMigration(db, 601, 'ldaps_ldap_connections', (d) => {
    d.exec(`
      CREATE TABLE IF NOT EXISTS ldap_connections (
        id                TEXT PRIMARY KEY,
        name              TEXT UNIQUE NOT NULL,
        host              TEXT NOT NULL,
        port              INTEGER NOT NULL DEFAULT 636,
        bind_dn           TEXT,
        bind_password_enc TEXT,
        base_dn           TEXT NOT NULL,
        user_filter       TEXT NOT NULL DEFAULT '(|(uid={username})(sAMAccountName={username}))',
        tls_verify        INTEGER NOT NULL DEFAULT 1,
        ca_cert           TEXT,
        enabled           INTEGER NOT NULL DEFAULT 1,
        last_test_status  TEXT,
        last_test_error   TEXT,
        last_test_at      TEXT,
        created_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    d.exec(`
      CREATE INDEX IF NOT EXISTS idx_ldap_connections_enabled
        ON ldap_connections(enabled)
    `);
  });

  // Version 602: feature permissions for the 'user' role. Admins have
  // everything implicitly; 'pending' accounts are blocked wholesale —
  // this table only widens what a regular user can reach:
  //   proxy      containers + routing (the Incus/LXC surface)
  //   developer  the Projects (Mock2) module
  // Checked from the DB on every request (requireAdminOrPermission) so
  // a grant/revoke takes effect in realtime, no re-login needed.
  runMigration(db, 602, 'user_feature_permissions', (d) => {
    d.exec(`
      CREATE TABLE IF NOT EXISTS user_permissions (
        user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        permission TEXT NOT NULL CHECK(permission IN ('proxy', 'developer')),
        granted_by TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, permission)
      )
    `);
    d.exec(`
      CREATE INDEX IF NOT EXISTS idx_user_permissions_user
        ON user_permissions(user_id)
    `);
  });

  // 603 One-time sign-in links: admin-issued URL that lets a local user set
  // their own password — no temporary password ever changes hands. The raw
  // token exists only in the URL (sha256 stored here). Validation GETs never
  // consume a link (mail/SMS previewers prefetch URLs); it is spent only when
  // the password is actually set, which also voids the user's other open links.
  runMigration(db, 603, 'user_login_links', (d) => {
    d.exec(`
      CREATE TABLE IF NOT EXISTS user_login_links (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        created_by TEXT,
        expires_at TEXT NOT NULL,
        completed_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    d.exec(`
      CREATE INDEX IF NOT EXISTS idx_user_login_links_user
        ON user_login_links(user_id)
    `);
  });

  // Version 604: self-service domain provisioning ("Add Domain" page).
  // Two credentials, kept structurally separate: provision_api_keys holds
  // sha256 hashes of ProxyPilot access API keys (page/endpoint auth, both
  // cert methods); provisioned_domains.cf_token_encrypted holds the
  // per-domain Cloudflare API token (DNS-01 only), AES-256-GCM via
  // lib/secrets.js — never returned to any client. The operator's DNS-01
  // specified-domain list lives in app_settings ('dns01_domains').
  runMigration(db, 604, 'domain_provisioning', (d) => {
    d.exec(`
      CREATE TABLE IF NOT EXISTS provision_api_keys (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        key_hash TEXT NOT NULL UNIQUE,
        scope TEXT NOT NULL DEFAULT 'domains:provision',
        created_by TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_used_at TEXT,
        revoked_at TEXT
      )
    `);
    d.exec(`
      CREATE TABLE IF NOT EXISTS provisioned_domains (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        domain TEXT NOT NULL UNIQUE,
        upstream TEXT NOT NULL,
        method_requested TEXT NOT NULL DEFAULT 'auto',
        method_resolved TEXT NOT NULL,
        wildcard INTEGER NOT NULL DEFAULT 0,
        acme_email TEXT NOT NULL,
        cf_token_encrypted TEXT,
        cf_token_source TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        last_error TEXT,
        api_key_id INTEGER,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
  });

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

  // Rolling history of completed snapshot durations. Used to give the
  // operator an ETA the next time they snapshot the same container.
  // Pruned to the most recent N rows per container at write time so
  // it can't grow without bound.
  db.exec(`
    CREATE TABLE IF NOT EXISTS snapshot_durations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      container_name TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      size_bytes INTEGER,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_snapshot_durations_container
    ON snapshot_durations(container_name, created_at DESC)
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
  }

  // Seed the admin service row if missing. Decoupled from the admin-user
  // seed above because Phase 2b D.14 dropped the columns the original
  // INSERT referenced (domain, port, ssl_enabled, force_https). On a
  // truly fresh install, the old INSERT throws "table services has no
  // column named domain" and crashes the server mid-seed — the user row
  // committed first, but the service row never landed. Subsequent boots
  // saw the admin user already present and skipped the entire if-block,
  // leaving the install with a user but no admin service forever.
  //
  // Now: gate on `is_admin = 1` instead of `!adminUser`, so installs
  // already in the broken state self-heal on next boot. Use only
  // post-D.14 columns. Capture process.env.DOMAIN into
  // app_settings.admin_domain so getAdminDomain() resolves correctly
  // — this also covers the (B6 patch) post-migration snapshot path
  // when the admin row pre-dates D.14.
  if (process.env.DOMAIN) {
    const adminService = db
      .prepare('SELECT id FROM services WHERE is_admin = 1 LIMIT 1')
      .get();
    if (!adminService) {
      const serviceId = uuidv4();
      db.prepare(`
        INSERT INTO services (id, name, type, target, is_admin)
        VALUES (?, 'ProxyPilot Admin', 'proxy', '127.0.0.1', 1)
      `).run(serviceId);
      console.log('Admin service row seeded (post-D.14 schema)');
    }
    // Idempotent UPSERT — if admin_domain is already set, this just
    // refreshes it from the current process.env.DOMAIN. The .env is
    // authoritative for the admin's reachable domain.
    setSetting('admin_domain', process.env.DOMAIN);
  }

  // Lean BEAF Pro (block 700) — see lib/lean-beaf-schema.js.
  runMigration(db, 700, 'lean_beaf_pro_core', lbpMigration700);
  runMigration(db, 701, 'lean_beaf_pro_blockers', lbpMigration701Blockers);
  runMigration(db, 702, 'lean_beaf_pro_board_order', lbpMigration702BoardOrder);
  runMigration(db, 703, 'lean_beaf_pro_schedules', lbpMigration703Schedules);

  console.log('Database initialized');
}

// Audit event taxonomy. Action strings flow through `logAudit()` as the
// `action` column; constants here document the recognised values for
// the streaming-terminal feature so callers don't drift on spelling.
export const AUDIT_TERMINAL_SESSION_START = 'TERMINAL_SESSION_START';
export const AUDIT_TERMINAL_SESSION_END = 'TERMINAL_SESSION_END';

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
// IMPORTANT: better-sqlite3 enables `PRAGMA foreign_keys = ON` by default,
// and child tables (service_http_routes, user_service_access, file_versions,
// service_config_versions) declare ON DELETE CASCADE foreign keys to
// services(id). DROP TABLE services would therefore wipe every dependent
// row. We use `PRAGMA defer_foreign_keys = ON` for the duration of the
// rebuild transaction so FK checks happen at COMMIT — by which time the
// new services table has been RENAMEd into place and the FKs are valid
// again. (defer_foreign_keys auto-resets at end-of-transaction.)
//
// We explicitly (re)create idx_services_domain_path on the rebuilt table
// so lookups on the new tuple stay fast.
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

  // foreign_keys MUST be off when this runs — see comment block above.
  // The runMigration() wrapper in initDatabase() passes
  // { disableFks: true } for migration version 1 so the toggle happens
  // outside any transaction (PRAGMA foreign_keys is a no-op inside a
  // transaction in SQLite).
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
  //
  // Ensure app_settings exists first — the canonical CREATE for this table
  // lives later in initDatabase() but D.14 runs ahead of that ordering.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);
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

  // FKs must be off during the rebuild — runMigration's { disableFks:
  // true } flag for migration version 3 toggles them outside the
  // transaction (PRAGMA foreign_keys is a no-op inside a transaction).
  // Without that toggle, DROP TABLE services cascade-deletes every
  // service_http_routes row.
  runDrop();
  console.log('Phase 2b D.14: services table rebuild complete');
}
