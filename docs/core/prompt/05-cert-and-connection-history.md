<!-- Split from proxypilot-core-infrastructure-prompt.md (lines 226-289) -->
<!-- Index: docs/core/prompt/README.md -->

## Certificate & Connection History

### Certificate Tracking

ProxyPilot polls Caddy admin API to detect cert changes and records the full lifecycle.

```sql
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
```

```
proxypilot certs list                    # current certs, expiry, status
proxypilot certs history <domain>        # full lifecycle for a domain
proxypilot certs expiring [--days <n>]   # certs expiring within N days
```

### SSH Session History

Parsed from systemd journal:

```sql
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
```

### PgBouncer Connection History (Compliant)

```sql
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
```

```
proxypilot db connections [name] [--since <datetime>]
```
