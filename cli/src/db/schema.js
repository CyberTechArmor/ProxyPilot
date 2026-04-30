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

  // ── Routes: additive `vpn_only` + `service` columns (step 7b) ──────────
  // vpn_only=1 makes the route render with a per-/32 Caddy matcher
  // listing exactly the peers allowed to reach it (joined the same way
  // as firewall vpn-only rules); requests from other sources get 403.
  // `service` is the optional join tag — when set, only services-scope
  // peers whose scope_services_json includes the tag get a /32 in the
  // matcher; full+admin peers are always included regardless of the
  // tag. Both columns are nullable / default 0 so existing rows keep
  // their current public-internet semantics.
  const routeCols = db.prepare(`PRAGMA table_info(routes)`).all().map(c => c.name);
  if (!routeCols.includes('vpn_only')) {
    db.exec(`ALTER TABLE routes ADD COLUMN vpn_only INTEGER NOT NULL DEFAULT 0`);
  }
  if (!routeCols.includes('service')) {
    db.exec(`ALTER TABLE routes ADD COLUMN service TEXT`);
  }

  // ── Firewall rules: additive `service` column (step 7a) ─────────────────
  // Tag string for vpn-only rules so per-peer scope can join peers with
  // a `services` scope to the rules they're allowed to reach. Additive
  // and idempotent: the PRAGMA guard makes re-runs a no-op on installs
  // that already have the column.
  if (!db.prepare(`PRAGMA table_info(firewall_rules)`).all().some(c => c.name === 'service')) {
    db.exec(`ALTER TABLE firewall_rules ADD COLUMN service TEXT`);
  }

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

  // ── VPN config (singleton row) ──────────────────────────────────────────
  // Row only exists once `proxypilot vpn enable` has run. Reads return
  // null on Standard installs that never opted in. server_public_key is
  // the public half only — the private half lives in
  // /etc/wireguard/server_private.key (mode 0600) and Infisical.
  db.exec(`
    CREATE TABLE IF NOT EXISTS vpn_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      server_public_key TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      listen_port INTEGER NOT NULL DEFAULT 51820,
      cidr TEXT NOT NULL DEFAULT '10.100.0.0/24',
      default_iface TEXT NOT NULL,
      dns TEXT NOT NULL DEFAULT '10.100.0.1',
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // ── VPN peers ───────────────────────────────────────────────────────────
  // public_key is stored; private keys never touch this table.
  db.exec(`
    CREATE TABLE IF NOT EXISTS vpn_peers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      public_key TEXT NOT NULL UNIQUE,
      preshared_key_hash TEXT,
      allowed_ip TEXT NOT NULL UNIQUE,
      scope TEXT NOT NULL DEFAULT 'admin'
            CHECK (scope IN ('full','admin','services')),
      scope_services_json TEXT,
      status TEXT NOT NULL DEFAULT 'enabled'
            CHECK (status IN ('enabled','disabled','revoked')),
      created_at TEXT DEFAULT (datetime('now')),
      created_by TEXT,
      last_handshake_at TEXT,
      last_endpoint TEXT,
      rotated_at TEXT,
      disabled_at TEXT,
      revoked_at TEXT
    );
  `);

  // ── VPN IP pool ─────────────────────────────────────────────────────────
  // Tracks per-/32 allocation in the VPN subnet. peer_id is null for
  // unallocated rows; released_at marks rows freed by `peer remove` so
  // they can be re-issued without churning the pool order.
  db.exec(`
    CREATE TABLE IF NOT EXISTS vpn_ip_pool (
      ip TEXT PRIMARY KEY,
      peer_id INTEGER REFERENCES vpn_peers(id),
      released_at TEXT
    );
  `);

  // ── SSH access (per-device authorized_keys ledger) ─────────────────────
  // Mirror of /var/lib/proxypilot/ssh-access.json. id is operator-supplied
  // and is the revoke key. fingerprint is UNIQUE so the same physical key
  // can't be added under two ids; revoked rows still occupy the
  // fingerprint slot so re-adding a known-bad key forces the operator to
  // pick a fresh keypair. Active rows have revoked_at IS NULL.
  db.exec(`
    CREATE TABLE IF NOT EXISTS ssh_access (
      id TEXT PRIMARY KEY,
      unix_user TEXT NOT NULL,
      public_key TEXT NOT NULL,
      fingerprint TEXT NOT NULL UNIQUE,
      device_label TEXT,
      added_at TEXT NOT NULL,
      added_by TEXT,
      revoked_at TEXT,
      revoked_by TEXT,
      revoked_reason TEXT,
      last_seen_at TEXT
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
