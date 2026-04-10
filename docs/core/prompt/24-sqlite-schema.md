<!-- Split from proxypilot-core-infrastructure-prompt.md (lines 1150-1345) -->
<!-- Index: docs/core/prompt/README.md -->

## Full SQLite Schema Additions

```sql
CREATE TABLE databases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  pg_role TEXT NOT NULL UNIQUE,
  work_mem TEXT DEFAULT '32MB',
  temp_file_limit TEXT DEFAULT '1GB',
  pool_size INTEGER DEFAULT 20,
  infisical_secret_path TEXT,
  size_warning_mb INTEGER DEFAULT 5120,
  classification TEXT CHECK (classification IN ('phi', 'pii', 'confidential', 'internal', 'public')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE container_databases (
  container_id INTEGER NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
  database_id INTEGER NOT NULL REFERENCES databases(id) ON DELETE RESTRICT,
  PRIMARY KEY (container_id, database_id)
);

CREATE TABLE certificate_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT NOT NULL,
  issuer TEXT,
  serial_number TEXT,
  issued_at TEXT,
  expires_at TEXT,
  renewed_from_id INTEGER REFERENCES certificate_history(id),
  status TEXT CHECK (status IN ('active', 'renewed', 'expired', 'revoked')),
  fingerprint_sha256 TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_cert_history_domain ON certificate_history (domain);

CREATE TABLE ssh_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  source_ip TEXT NOT NULL,
  auth_method TEXT,
  session_start TEXT NOT NULL,
  session_end TEXT,
  duration_seconds INTEGER,
  success INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_ssh_sessions_username ON ssh_sessions (username);

CREATE TABLE db_connections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  database_name TEXT NOT NULL,
  pg_role TEXT NOT NULL,
  source_ip TEXT NOT NULL,
  connected_at TEXT NOT NULL,
  disconnected_at TEXT,
  duration_seconds INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_db_conn_database ON db_connections (database_name);

CREATE TABLE admin_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  email TEXT,
  ssh_key_fingerprint TEXT,
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'locked')),
  last_login_at TEXT,
  last_login_ip TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE access_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reviewed_by TEXT NOT NULL,
  accounts_reviewed INTEGER NOT NULL,
  accounts_revoked INTEGER DEFAULT 0,
  notes TEXT,
  reviewed_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE compliance_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  framework TEXT NOT NULL,
  total_controls INTEGER NOT NULL,
  passing_controls INTEGER NOT NULL,
  failing_controls INTEGER NOT NULL,
  results_json TEXT NOT NULL,
  checked_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE baa_tracker (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vendor_name TEXT NOT NULL,
  vendor_contact TEXT,
  signed_date TEXT,
  review_date TEXT,
  status TEXT CHECK (status IN ('active', 'pending', 'expired', 'not_required')),
  notes TEXT,
  document_path TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE resource_classifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  resource_type TEXT NOT NULL,
  resource_name TEXT NOT NULL,
  classification TEXT NOT NULL CHECK (classification IN ('phi', 'pii', 'confidential', 'internal', 'public')),
  classified_by TEXT NOT NULL,
  classified_at TEXT DEFAULT (datetime('now')),
  UNIQUE (resource_type, resource_name)
);

CREATE TABLE snapshot_expiry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  container_id INTEGER NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
  snapshot_name TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('pre_patch', 'manual')),
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE patch_schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  container_id INTEGER NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
  cron_expression TEXT NOT NULL,
  snapshot_retention_hours INTEGER DEFAULT 72,
  last_run_at TEXT,
  last_result TEXT CHECK (last_result IN ('success', 'failure', 'rollback')),
  next_run_at TEXT,
  enabled INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE audit_sync_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_synced_offset INTEGER DEFAULT 0,
  last_synced_at TEXT,
  last_file_inode INTEGER
);

CREATE TABLE core_services (
  name TEXT PRIMARY KEY,
  systemd_unit TEXT NOT NULL,
  status TEXT DEFAULT 'unknown',
  last_checked_at TEXT,
  details_json TEXT
);

CREATE TABLE vpn_peers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL UNIQUE,
  allowed_ips TEXT NOT NULL,
  endpoint TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  last_handshake_at TEXT,
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'revoked'))
);

CREATE TABLE aide_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  result TEXT NOT NULL CHECK (result IN ('clean', 'changes_detected', 'error')),
  files_added INTEGER DEFAULT 0,
  files_removed INTEGER DEFAULT 0,
  files_modified INTEGER DEFAULT 0,
  details_json TEXT,
  checked_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE aide_baselines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reason TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE instance_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE observability_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- Seeded if enabled: enabled, grafana_route_domain, loki_retention_hours,
-- alert_webhook_url, alert_email
```
