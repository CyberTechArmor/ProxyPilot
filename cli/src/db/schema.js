/**
 * Initialize all database tables and seed default data.
 * All statements use IF NOT EXISTS so they are safe to run repeatedly.
 */
export function initSchema(db) {
  // ── Routes ──────────────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS routes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      domain TEXT NOT NULL UNIQUE,
      upstream_type TEXT NOT NULL CHECK (upstream_type IN ('static', 'docker', 'lxc')),
      upstream_address TEXT,
      path_prefix TEXT DEFAULT '/',
      middleware_json TEXT,
      health_status TEXT DEFAULT 'unknown' CHECK (health_status IN ('healthy', 'degraded', 'down', 'unknown')),
      health_last_checked_at TEXT,
      health_response_ms INTEGER,
      tls_auto INTEGER DEFAULT 1,
      enabled INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // ── Containers ──────────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS containers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      incus_name TEXT NOT NULL UNIQUE,
      image TEXT NOT NULL,
      profile TEXT NOT NULL DEFAULT 'medium',
      bridge_ip TEXT,
      port INTEGER,
      status TEXT DEFAULT 'stopped' CHECK (status IN ('running', 'stopped', 'frozen', 'error')),
      cpu_limit INTEGER,
      memory_limit_mb INTEGER,
      disk_limit_mb INTEGER,
      init_script TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // ── Container-Route junction ────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS container_routes (
      container_id INTEGER NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
      route_id INTEGER NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
      PRIMARY KEY (container_id, route_id)
    );
  `);

  // ── Snapshots ───────────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      container_id INTEGER NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      incus_snapshot_name TEXT NOT NULL,
      size_bytes INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // ── Backups ─────────────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS backups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      container_id INTEGER,
      backup_type TEXT NOT NULL CHECK (backup_type IN ('lxc_export', 'static_site', 'state')),
      file_path TEXT NOT NULL,
      size_bytes INTEGER,
      status TEXT DEFAULT 'completed' CHECK (status IN ('completed', 'failed', 'in_progress')),
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // ── Backup schedules ────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS backup_schedules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      container_id INTEGER REFERENCES containers(id) ON DELETE CASCADE,
      schedule_type TEXT NOT NULL CHECK (schedule_type IN ('snapshot', 'export')),
      cron_expression TEXT NOT NULL,
      retention_count INTEGER DEFAULT 5,
      last_run_at TEXT,
      next_run_at TEXT,
      enabled INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // ── Templates ───────────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      incus_alias TEXT NOT NULL,
      base_image TEXT,
      init_script TEXT,
      default_profile TEXT DEFAULT 'medium',
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // ── Firewall rules (mirror of firewall.json) ────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS firewall_rules (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL CHECK (source IN ('base','manual','lxc','docker','caddy-l4','host')),
      container TEXT,
      process TEXT,
      port_start INTEGER NOT NULL,
      port_end INTEGER,
      proto TEXT NOT NULL CHECK (proto IN ('tcp','udp')),
      scope TEXT NOT NULL CHECK (scope IN ('public','lan-only','vpn-only','localhost-only')),
      source_cidrs_json TEXT,
      enabled INTEGER NOT NULL DEFAULT 0,
      reason TEXT,
      first_seen TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      enabled_at TEXT,
      enabled_by TEXT,
      disabled_at TEXT,
      disabled_by TEXT
    );
  `);

  // ── Firewall reconciles (apply history) ─────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS firewall_reconciles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ruleset_checksum TEXT NOT NULL,
      rule_count INTEGER NOT NULL,
      applied INTEGER NOT NULL,
      rejection_reason TEXT,
      reconciled_at TEXT DEFAULT (datetime('now')),
      reconciled_by TEXT
    );
  `);

  // ── Audit log (state mutations across all subsystems) ───────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subsystem TEXT NOT NULL,
      action TEXT NOT NULL,
      resource TEXT,
      actor TEXT,
      before_json TEXT,
      after_json TEXT,
      detail TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // ── Profiles ────────────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      cpu_limit INTEGER NOT NULL,
      memory_limit_mb INTEGER NOT NULL,
      disk_limit_mb INTEGER NOT NULL,
      description TEXT,
      is_default INTEGER DEFAULT 0
    );
  `);

  // ── Seed default profiles ───────────────────────────────────────────────
  const insertProfile = db.prepare(`
    INSERT OR IGNORE INTO profiles (name, cpu_limit, memory_limit_mb, disk_limit_mb, description, is_default)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const seedProfiles = db.transaction(() => {
    insertProfile.run('small', 1, 512, 5120, '1 CPU, 512MB RAM, 5GB disk', 0);
    insertProfile.run('medium', 2, 2048, 20480, '2 CPU, 2GB RAM, 20GB disk', 1);
    insertProfile.run('large', 4, 8192, 51200, '4 CPU, 8GB RAM, 50GB disk', 0);
  });

  seedProfiles();
}
