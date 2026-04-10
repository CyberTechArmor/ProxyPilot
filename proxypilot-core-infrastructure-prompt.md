# ProxyPilot Core Infrastructure Upgrade — Implementation Prompt

## Project Context

ProxyPilot is an infrastructure management CLI tool that manages reverse proxy routes (Caddy), static site hosting, Docker containers, and LXC containers (Incus) from a single CLI. The Caddy migration and LXC/Incus integration are complete.

This upgrade adds the **core infrastructure layer** — the native services, security hardening, compliance automation, and operational tooling that every ProxyPilot host needs to operate as a secure, auditable, secrets-managed platform. After this upgrade, `proxypilot init` bootstraps a complete infrastructure host from a fresh Debian installation — including SSH hardening, secrets management, database services, security tooling, audit logging, and compliance documentation — and `proxypilot lxc create --db myapp_db` creates a container with its own database, credentials in a secrets manager, TLS route, and firewall rules in one command.

## Design Principles

1. **Single control plane**: ProxyPilot manages everything on the host. No separate tools, dashboards, or manual configuration for core services.
2. **Native core services**: Services that ProxyPilot depends on to function run natively on the host via systemd — not in containers. Core services must be available before any workload.
3. **Sensible defaults with operator override**: ProxyPilot sets secure, production-ready defaults for every configuration. The operator can tune anything. ProxyPilot never silently overrides operator changes.
4. **Audit everything**: Every mutation ProxyPilot makes is recorded in an append-only audit log file and asynchronously synced to Postgres for queryability.
5. **Secrets never touch disk in plaintext** (after bootstrap): All credentials are stored in Infisical. The only exception is the initial bootstrap sequence, where temporary credentials are generated, used to stand up Infisical, rotated into Infisical, and then deleted from disk.
6. **Safe transitions**: When hardening access (SSH, firewall rules), always verify the new access path works before closing the old one. Never lock the operator out of a remote machine.
7. **Compliance from live state**: Compliance checks and documentation are generated from actual system state, not static templates. Documents are always current because they reflect what is deployed.

## Installation Profiles

`proxypilot init` presents an interactive profile selection. Each profile is additive — higher profiles include everything from lower ones.

```
proxypilot init

Welcome to ProxyPilot.

Select installation profile:

  1. Standard
     Core services: Postgres, PgBouncer, Valkey, Infisical, Caddy, Incus.
     DNS-over-TLS. Basic audit logging. No additional hardening.

  2. Hardened
     Standard + CrowdSec (Caddy + SSH bouncers), WireGuard VPN for admin
     access, AIDE filesystem integrity monitoring, nftables bridge logging,
     SSH hardening with per-person access, unattended security updates,
     Incus network ACLs, host hardening baseline.

  3. Compliant (SOC 2 Type 2 + HIPAA)
     Hardened + full audit trail with Postgres sync, pgAudit, certificate
     history tracking, connection history logging, per-person SSH with
     quarterly access review enforcement, compliance checker with scheduled
     checks, documentation generator, data classification tagging, BAA
     tracker, enhanced encryption requirements, breach notification
     workflow template.

  4. Custom
     Choose individual components.
```

Non-interactive mode: `proxypilot init --profile standard|hardened|compliant`

### Component Matrix

| Component | Standard | Hardened | Compliant |
|---|---|---|---|
| PostgreSQL 16 + PgBouncer + Valkey | ✓ | ✓ | ✓ |
| Infisical (secrets management) | ✓ | ✓ | ✓ |
| Caddy (reverse proxy + TLS) | ✓ | ✓ | ✓ |
| Incus (LXC container runtime) | ✓ | ✓ | ✓ |
| pgBackRest (Postgres backup) | ✓ | ✓ | ✓ |
| Basic audit log (file only) | ✓ | ✓ | ✓ |
| SQLite state store | ✓ | ✓ | ✓ |
| DNS-over-TLS (systemd-resolved) | ✓ | ✓ | ✓ |
| CrowdSec (Caddy bouncer) | — | ✓ | ✓ |
| CrowdSec (SSH bouncer) | — | ✓ | ✓ |
| WireGuard VPN (admin access) | — | ✓ | ✓ |
| AIDE (filesystem integrity monitoring) | — | ✓ | ✓ |
| nftables bridge logging | — | ✓ | ✓ |
| SSH hardening + per-person access | — | ✓ | ✓ |
| Unattended security updates (host) | — | ✓ | ✓ |
| Incus network ACLs | — | ✓ | ✓ |
| Host hardening baseline (sysctl, disabled services) | — | ✓ | ✓ |
| Full audit trail (file + Postgres sync) | — | — | ✓ |
| pgAudit (DDL + role logging) | — | — | ✓ |
| Certificate history tracking | — | — | ✓ |
| Connection history logging (SSH + PgBouncer) | — | — | ✓ |
| Compliance checker | — | — | ✓ |
| Scheduled compliance checks (weekly) | — | — | ✓ |
| Documentation generator | — | — | ✓ |
| Quarterly access review enforcement | — | — | ✓ |
| Data classification tagging | — | — | ✓ |
| BAA tracker | — | — | ✓ |
| Breach notification workflow template | — | — | ✓ |

### Optional Components

These are offered as yes/no choices during `proxypilot init` regardless of profile. They are independent of the profile tier — a Standard install can enable observability, a Compliant install can skip it.

```
Optional components:
  Observability stack (Grafana + Loki + Alloy)?
  Provides dashboards, log search, and alerting for all
  ProxyPilot-managed services. [y/N]
```

Non-interactive: `proxypilot init --profile hardened --with-observability`

| Optional Component | What It Adds |
|---|---|
| Observability (Grafana + Loki + Alloy) | Log aggregation, dashboards, alerting for all ProxyPilot data |

## Core Service Stack

All services run natively on the host, managed by ProxyPilot-generated systemd units.

| Component | Systemd Unit | Purpose | Depends On |
|---|---|---|---|
| PostgreSQL 16 | `proxypilot-postgres.service` | Core database | — |
| PgBouncer | `proxypilot-pgbouncer.service` | Connection pooling | postgres |
| Valkey | `proxypilot-valkey.service` | Cache/queue for Infisical | — |
| Infisical | `proxypilot-infisical.service` | Secrets management | pgbouncer, valkey |
| Infisical Agent | `proxypilot-infisical-agent.service` | Template rendering | infisical |
| Caddy | `proxypilot-caddy.service` | Reverse proxy + TLS | — |
| Incus | `incus.service` (system-provided) | Container runtime | — |
| CrowdSec | `crowdsec.service` (system-provided) | Threat detection | — |
| WireGuard | `wg-quick@wg0.service` (system-provided) | Admin VPN access | — |
| AIDE | `proxypilot-aide-check.timer` | Daily filesystem integrity check | — |
| pgBackRest full | `proxypilot-pgbackrest-full.timer` | Weekly full backup | postgres |
| pgBackRest diff | `proxypilot-pgbackrest-diff.timer` | Daily diff backup | postgres |
| Audit sync | `proxypilot-audit-sync.timer` | File → Postgres sync | pgbouncer |
| Health check | `proxypilot-health.timer` | Route/service checks | — |
| Compliance check | `proxypilot-compliance.timer` | Weekly compliance | — |
| Patch check | `proxypilot-patch-check.timer` | Pending updates check | — |
| Snapshot cleanup | `proxypilot-snapshot-cleanup.timer` | Expired snapshot removal | — |
| Session log | `proxypilot-session-log.timer` | SSH session parser | — |
| Loki | `proxypilot-loki.service` | Log aggregation (optional) | — |
| Alloy | `proxypilot-alloy.service` | Log shipper to Loki (optional) | loki |
| Grafana | `proxypilot-grafana.service` | Dashboards + alerting (optional) | loki |

The `proxypilot-` prefix on all unit names avoids collisions with system packages.

## SSH Access Management

### Safe Transition Sequence

On a remote machine, getting locked out of SSH means losing the machine. ProxyPilot verifies the new access path works before closing the old one.

```
1. Create per-person admin accounts
   - useradd with sudo group, install SSH keys
   - chmod 700 .ssh, chmod 600 authorized_keys

2. TEST: Verify new access works BEFORE changing anything
   - Programmatic: SSH key installed, home dir exists, user in sudo group
   - Interactive: "Verify you can SSH as <username> from another terminal NOW."
   - Operator confirmation: "Can all administrators log in? [y/N]"
   - If no: STOP. Do not proceed. Old access remains active.

3. Only after confirmation: Harden sshd_config
   - PermitRootLogin no
   - PasswordAuthentication no
   - PubkeyAuthentication yes
   - MaxAuthTries 3
   - X11Forwarding no
   - AllowTcpForwarding no (unless needed — ask operator)
   - ClientAliveInterval 300
   - ClientAliveCountMax 2
   - AllowUsers <created usernames>

4. Reload sshd (NOT restart — preserves existing sessions)

5. TEST AGAIN: Verify access after lockdown
   - "Verify you can still SSH from another terminal."
   - If operator says no: revert sshd_config, reload, print error.

6. Install CrowdSec SSH bouncer (Hardened/Compliant)
```

Non-interactive mode uses programmatic verification only.

### Admin Specification

```
proxypilot init --admin "thomas:ssh-ed25519 AAAA..." --admin "jane:ssh-ed25519 AAAA..."
```

Or via config YAML:

```yaml
admins:
  - username: thomas
    ssh_public_key: "ssh-ed25519 AAAA..."
    email: thomas@example.com
```

### Ongoing Access Management

```
proxypilot access add <username> --ssh-key "<key>" [--email <email>]
```
- Creates system user with sudo, installs SSH key
- Adds to sshd AllowUsers, reloads sshd
- Records in SQLite + audit log

```
proxypilot access remove <username> [--force]
```
- Removes from AllowUsers, reloads sshd
- Locks system account (does not delete home dir — audit preservation)
- Audit log entry

```
proxypilot access list
```
- Table: username, email, SSH key fingerprint, last login, status

```
proxypilot access history [username] [--since <datetime>] [--failed]
```
- SSH session history parsed from journal
- Flags: unusual IPs, off-hours logins, brute force patterns

```
proxypilot access review
```
- Compliant only. Presents each account for confirm/revoke.
- Records review date and reviewer.
- `proxypilot compliance check` flags overdue reviews (quarterly).

### Actor Identity in Audit Logs

All commands read `$SUDO_USER` (or `$USER`) for the `actor` field: `cli:<username>`.

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

## PostgreSQL Architecture

### Single Instance, Multiple Databases

One Postgres instance hosts all databases. SOC 2 Type 2 and HIPAA satisfied through logical access controls.

### Core Databases

| Database | Owner Role | Purpose |
|---|---|---|
| `infisical` | `infisical_app` | Infisical backend |
| `proxypilot_audit` | `proxypilot_audit` | Audit log sync target |
| `proxypilot` | `proxypilot_app` | Reserved for future use |

### Role Isolation

Every role: `LOGIN`, `NOSUPERUSER`, `NOCREATEDB`, `NOCREATEROLE`. Grants only to own database. `REVOKE PUBLIC`. Per-role `work_mem` (default 32MB) and `temp_file_limit` (default 1GB).

### No statement_timeout

Not set by ProxyPilot. Causes more problems than it solves. Protection from PgBouncer limits, `work_mem`, `temp_file_limit`, monitoring.

### Postgres Configuration

RAM-tuned: `shared_buffers` 25% (cap 8GB), `effective_cache_size` 75%, `wal_level` replica, `archive_mode` on, `shared_preload_libraries` pg_stat_statements (+ pgaudit for Compliant).

`pg_hba.conf`: local scram-sha-256, localhost TCP scram-sha-256, bridge deny, all else reject.

### pgAudit (Compliant)

`pgaudit.log = 'ddl, role'` — logs DDL and role changes to Postgres log.

## PgBouncer Architecture

Dual listener: `127.0.0.1:6432` (host services) + `10.0.100.1:6432` (LXC containers). Transaction pooling, scram-sha-256, per-database pool sizes. Userlist rendered by Infisical Agent.

Per-container nftables rules gate PgBouncer access: `--db` flag enables, no flag means no access.

## Valkey

Localhost only, no persistence, 256MB max. Exclusively for Infisical.

## Infisical

Project structure: core (service passwords), databases (workload credentials), workloads (operator-defined). Agent templates render PgBouncer userlist and Valkey config. Container secrets injected via ProxyPilot-mediated tmpfs (containers never access Infisical directly).

## Audit Logging

### Dual-Write

1. Append-only `/var/log/proxypilot/audit.log` (JSON Lines, synchronous)
2. Postgres `proxypilot_audit.audit_log` (async sync, Compliant profile)

### Postgres Schema

```sql
CREATE TABLE audit_log (
  id BIGSERIAL PRIMARY KEY,
  timestamp TIMESTAMPTZ NOT NULL,
  action TEXT NOT NULL,
  actor TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_name TEXT,
  details JSONB,
  result TEXT NOT NULL CHECK (result IN ('success', 'failure', 'partial')),
  duration_ms INTEGER,
  synced_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_audit_log_timestamp ON audit_log (timestamp);
CREATE INDEX idx_audit_log_action ON audit_log (action);
CREATE INDEX idx_audit_log_resource ON audit_log (resource_type, resource_name);
CREATE INDEX idx_audit_log_actor ON audit_log (actor);
```

### Audited Actions

Container (create, start, stop, restart, destroy, resize, snapshot, restore), route (add, remove, update), database (create, drop, tune), static (deploy, rollback), backup (export, restore), template (create, delete), access (user.add, user.remove, access.review), core (init, credential.rotate, service.restart), compliance (check.run, docs.generate), patch (run, rollback, schedule.create).

### Log Rotation

365 days (Compliant) or 90 days (Standard/Hardened). `copytruncate` for uninterrupted writes. Sync tracks inode for truncation handling.

## CrowdSec (Hardened/Compliant)

Installed during init: engine + Caddy bouncer + SSH bouncer. `proxypilot core status` shows CrowdSec state. `proxypilot security bans` and `proxypilot security alerts` for operational visibility.

## DNS-over-TLS (All Profiles)

Configured during init for every profile. No downside to encrypted DNS — it should be default on every infrastructure host.

ProxyPilot writes `/etc/systemd/resolved.conf`:

```ini
[Resolve]
DNS=1.1.1.1#cloudflare-dns.com 9.9.9.9#dns.quad9.net
FallbackDNS=8.8.8.8#dns.google
DNSSEC=yes
DNSOverTLS=yes
```

Then restarts `systemd-resolved` and verifies with `resolvectl status` (checks for `DNSOverTLS: yes` in output).

No ongoing management needed. No CLI commands. If the operator wants custom DNS servers, they edit `resolved.conf` directly — ProxyPilot does not overwrite operator changes on subsequent `init` runs (checks if already configured).

## WireGuard VPN (Hardened/Compliant)

### Purpose

Provides encrypted tunnel for operator access to admin-only services (Infisical UI, Grafana, n8n, PgBouncer stats, any management interface) without exposing them to the public internet. Admin services are bound to the WireGuard interface or localhost — Caddy only routes them for requests arriving via the VPN.

This also serves as the foundation for multi-ProxyPilot federation networking in the future.

### Setup During Init

```
1. Generate server key pair
   - wg genkey → /etc/wireguard/server_private.key (mode 0600)
   - derive public key → stored in ProxyPilot state + printed for operator

2. Write /etc/wireguard/wg0.conf
   [Interface]
   Address = 10.100.0.1/24
   ListenPort = 51820
   PrivateKey = <server_private_key>
   PostUp = iptables -A FORWARD -i wg0 -j ACCEPT; iptables -t nat -A POSTROUTING -o $(ip route list default | awk '{print $5}') -j MASQUERADE
   PostDown = iptables -D FORWARD -i wg0 -j ACCEPT; iptables -t nat -D POSTROUTING -o $(ip route list default | awk '{print $5}') -j MASQUERADE

3. Add nftables rule: allow UDP 51820 inbound

4. Enable + start wg-quick@wg0

5. Verify: wg show reports interface up

6. Store server private key in Infisical (core/WIREGUARD_SERVER_KEY)

7. Print server public key + endpoint for operator to configure clients
```

**Important:** Debian 13 uses predictable network interface names (e.g., `enp3s0`, not `eth0`). The PostUp/PostDown commands use dynamic detection via `$(ip route list default | awk '{print $5}')` to find the default route interface. Never hardcode an interface name.

### Peer Management

```
proxypilot vpn add-peer <name> --public-key "<key>" [--allowed-ips "10.100.0.10/32"]
```
- Assigns next available IP from VPN CIDR (10.100.0.0/24, starting at .10)
- Adds `[Peer]` block to wg0.conf
- Applies live: `wg set wg0 peer <key> allowed-ips <ip>`
- Records in SQLite + audit log
- Prints client config snippet the operator can give to the peer

```
proxypilot vpn remove-peer <name> [--force]
```
- Removes `[Peer]` block from wg0.conf
- Applies live: `wg set wg0 peer <key> remove`
- Releases IP back to pool
- Records in SQLite + audit log

```
proxypilot vpn list
```
- Table: peer name, public key (truncated), allowed IPs, last handshake, transfer stats
- Pulls live data from `wg show wg0`

```
proxypilot vpn status
```
- Interface status, listening port, peer count, transfer stats

### Admin Service Routing

Services that should only be accessible via VPN are configured in Caddy with a bind or matcher that restricts to the WireGuard subnet:

- Infisical UI → `10.100.0.1:8080` or Caddy route with `remote_ip 10.100.0.0/24` matcher
- Grafana → same pattern
- n8n → same pattern (unless explicitly published to the internet)

ProxyPilot manages this via a route flag:

```
proxypilot route add infisical.admin.example.com --upstream 127.0.0.1:8080 --vpn-only
```

`--vpn-only` adds a Caddy matcher restricting the route to requests from `10.100.0.0/24`. The route is accessible from the VPN but returns 403 from the public internet.

### SQLite Schema

```sql
CREATE TABLE vpn_peers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL UNIQUE,
  allowed_ips TEXT NOT NULL,
  endpoint TEXT,                    -- optional: for site-to-site
  created_at TEXT DEFAULT (datetime('now')),
  last_handshake_at TEXT,
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'revoked'))
);
```

### VPN IP Pool

ProxyPilot tracks VPN IP assignments in SQLite (similar to bridge IP allocation). Pool: `10.100.0.10` through `10.100.0.254`. Server is `10.100.0.1`. IPs released on peer removal.

## AIDE — Filesystem Integrity Monitoring (Hardened/Compliant)

### Purpose

Detects unauthorized modifications to system binaries, config files, libraries, and systemd units. Catches rootkits, supply chain tampering, and manual changes that bypassed ProxyPilot. Complements ProxyPilot's application-level audit trail — AIDE covers the entire host filesystem.

### Setup During Init

```
1. Install AIDE (apt install aide)

2. Write AIDE config (/etc/aide/aide.conf) with monitored paths:
   - /usr/bin, /usr/sbin, /usr/lib — system binaries
   - /etc — all configuration files
   - /boot — kernel and bootloader
   - /lib/systemd — systemd unit files
   - Exclude: /var/log, /var/lib/postgresql (data, not binaries),
     /var/lib/proxypilot (managed data), /tmp, /proc, /sys

3. Initialize database: aideinit
   (This takes 2-5 minutes — scans entire monitored filesystem)

4. Move database: cp /var/lib/aide/aide.db.new /var/lib/aide/aide.db

5. Generate proxypilot-aide-check.timer (daily at 06:00)
   and proxypilot-aide-check.service (runs aide --check)

6. Enable timer

7. Verify: aide --check returns 0 (no changes since init)
```

### AIDE Database Re-initialization

AIDE will report false positives after any legitimate system change (package updates, kernel upgrades, ProxyPilot config changes). The database must be updated after approved changes.

```
proxypilot security aide-update [--reason "<description>"]
```
- Runs `aideinit` to regenerate the baseline
- Moves new database into place
- Logs the update in audit trail with reason
- Prints what changed since the last baseline (so the operator can verify the changes are expected before accepting)

**Automatic re-init triggers:** ProxyPilot should automatically offer AIDE database update after:
- `proxypilot init` (any re-run that changes configs)
- Host unattended-upgrades run (detected via apt log)
- `proxypilot core restart` that regenerates config files

### Daily Check Integration

The `proxypilot-aide-check.timer` runs daily. Results are captured:

- **No changes:** logged as success, no action needed
- **Changes detected:** logged as alert in ProxyPilot audit trail. If Compliant profile, included in next compliance check results.

```
proxypilot security aide-check
```
- Runs AIDE check immediately (outside the daily timer)
- Prints results: files added, removed, modified
- If changes found: prints each changed file with what changed (permissions, size, checksum)

```
proxypilot security aide-status
```
- Last check time, result, database age, next scheduled check

### SQLite Schema

```sql
CREATE TABLE aide_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  result TEXT NOT NULL CHECK (result IN ('clean', 'changes_detected', 'error')),
  files_added INTEGER DEFAULT 0,
  files_removed INTEGER DEFAULT 0,
  files_modified INTEGER DEFAULT 0,
  details_json TEXT,               -- changed file list with details
  checked_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE aide_baselines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reason TEXT NOT NULL,
  updated_by TEXT NOT NULL,        -- actor
  created_at TEXT DEFAULT (datetime('now'))
);
```

## Observability Stack — Grafana + Loki + Alloy (Optional)

### Purpose

ProxyPilot generates extensive operational data across audit logs, Caddy access logs, CrowdSec alerts, AIDE results, SSH sessions, PgBouncer connections, nftables denied traffic, health checks, and compliance results. Without the observability stack, this data is queryable only through ProxyPilot CLI commands. With it, operators get unified dashboards, full-text log search, and alerting — all in one place.

This is optional because ProxyPilot's CLI is fully functional without it. Operators who already run their own Grafana/Loki instance can point it at ProxyPilot's log files instead.

### Components

| Service | Role | Resource Footprint |
|---|---|---|
| Loki | Log storage and query engine | ~200MB RAM idle, scales with ingestion |
| Alloy | Log shipper — tails files and journals, ships to Loki | ~50MB RAM |
| Grafana | Dashboard UI, alerting, log explorer | ~150MB RAM |

Total idle footprint: ~400MB RAM. Acceptable on any host with 4GB+ RAM.

Grafana Alloy replaces Promtail, which reached End-of-Life on March 2, 2026. Alloy is Grafana's unified telemetry collector and is the supported path forward for log shipping to Loki.

### Setup During Init

If the operator enables observability:

```
1. Loki
   ├─ Write loki config (/etc/loki/loki-config.yaml)
   │   - Filesystem storage (single-host, no S3 needed)
   │   - Retention: 30 days (Standard/Hardened), 365 days (Compliant) — auto-set based on profile
   │   - Listen: 127.0.0.1:3100 (localhost only — not exposed)
   ├─ Generate proxypilot-loki.service
   ├─ Enable + start
   └─ Verify: GET http://localhost:3100/ready returns 200

2. Alloy
   ├─ Write Alloy config (/etc/alloy/config.alloy)
   │   Auto-configured to tail:
   │   - /var/log/proxypilot/audit.log          → job: proxypilot_audit
   │   - Caddy access log (JSON)                → job: caddy_access
   │   - Caddy error log                        → job: caddy_error
   │   - systemd journal: sshd                  → job: sshd
   │   - systemd journal: crowdsec              → job: crowdsec
   │   - PgBouncer log                          → job: pgbouncer
   │   - PostgreSQL log                         → job: postgresql
   │   - nftables log (kern.log filtered)       → job: nftables
   │   - AIDE check output                      → job: aide
   │   - Infisical log                          → job: infisical
   │   All labels auto-applied: {host="<instance_uuid>", job="<name>"}
   ├─ Generate proxypilot-alloy.service (After=proxypilot-loki)
   ├─ Enable + start
   └─ Verify: Alloy targets all showing "Ready"

3. Grafana
   ├─ Write grafana config (/etc/grafana/grafana.ini)
   │   - HTTP listen: 127.0.0.1:3000 (localhost only)
   │   - Auth: admin password generated + stored in Infisical (core/GRAFANA_ADMIN_PASSWORD)
   │   - Anonymous access: disabled
   │   - Allow sign up: false
   ├─ Provision Loki as datasource (auto-provisioning YAML)
   │   /etc/grafana/provisioning/datasources/loki.yaml
   ├─ Provision ProxyPilot dashboard (auto-provisioning JSON)
   │   /etc/grafana/provisioning/dashboards/proxypilot.json
   ├─ Generate proxypilot-grafana.service (After=proxypilot-loki)
   ├─ Enable + start
   ├─ Verify: GET http://localhost:3000/api/health returns ok
   └─ Register Caddy route: --vpn-only (Grafana only accessible via VPN)
       If WireGuard is not enabled, register with --middleware basic-auth instead
```

### Caddy Route for Grafana

If WireGuard is enabled (Hardened+):
```
proxypilot route add grafana.<domain> --upstream 127.0.0.1:3000 --vpn-only
```

If WireGuard is not enabled (Standard with observability):
```
proxypilot route add grafana.<domain> --upstream 127.0.0.1:3000 --middleware basic-auth
```

Grafana is never exposed to the public internet without access control.

### Default ProxyPilot Dashboard

ProxyPilot ships a Grafana dashboard JSON that provides:

**Overview panel:**
- Core service status (up/down for each systemd unit)
- Container count (running/stopped)
- Route count (healthy/degraded/down)
- Active VPN peers
- Last compliance check score

**Security panel:**
- CrowdSec bans over time (graph)
- Failed SSH attempts over time (graph)
- nftables denied traffic (graph)
- AIDE check results (last 30 days)

**Access panel:**
- SSH sessions timeline (who connected when, from where)
- PgBouncer connections by database (graph)
- Active admin sessions

**Traffic panel:**
- Caddy requests per route (graph)
- Response status codes distribution
- Error rate over time
- Latency p50/p95/p99 per route

**Audit panel:**
- ProxyPilot mutations over time (graph)
- Mutations by actor
- Mutations by resource type
- Recent audit entries (log view)

**Database panel:**
- Active connections per database
- Database sizes over time
- PgBouncer pool utilization

The dashboard is provisioned automatically. The operator can duplicate and customize it in Grafana without affecting the base dashboard (Grafana provisioning preserves the original).

### Grafana Alerting

Pre-configured alert rules (provisioned via YAML):

| Alert | Condition | Severity |
|---|---|---|
| Service down | Any core systemd unit not active for 5 min | Critical |
| Container health failed | Any route health check failing for 5 min | High |
| High error rate | Any route >5% 5xx responses over 15 min | High |
| SSH brute force | >10 failed SSH attempts from same IP in 5 min | High |
| Disk space | Host disk >85% full | Warning |
| Cert expiring | Any TLS cert expiring within 7 days | Warning |
| Backup stale | No pgBackRest backup in 48 hours | High |
| AIDE changes | AIDE check found modifications | High |
| PgBouncer pool saturated | Any database pool >80% utilized for 10 min | Warning |
| Compliance degraded | Compliance check score dropped from previous run | Warning |

Alert notification channel: configured during init. Options:
- Email (if SMTP is configured)
- Webhook (generic, can trigger n8n workflows)
- Slack (if webhook URL provided)

The operator can add/modify alert rules in Grafana. ProxyPilot-provisioned rules are marked and won't be overwritten on re-init.

### Alloy Label Strategy

Every log line shipped to Loki gets structured labels for efficient querying:

```yaml
# All logs get these base labels
- host: "<instance_uuid>"
- profile: "standard|hardened|compliant"

# Per-job specific labels
# Caddy access logs (parsed from JSON):
- domain: "app.example.com"
- upstream_type: "static|docker|lxc"
- status_code: "200"
- method: "GET"

# Audit logs (parsed from JSON):
- action: "container.create"
- actor: "cli:thomas"
- resource_type: "container"
- result: "success"

# SSH sessions:
- username: "thomas"
- auth_result: "success|failure"
- source_ip: "203.0.113.10"

# PgBouncer:
- database: "n8n_db"
- event: "connect|disconnect"

# CrowdSec:
- decision_type: "ban|captcha"
- scenario: "ssh-bf|http-crawl"
```

This labeling enables queries like:
- `{job="caddy_access", domain="app.example.com", status_code=~"5.."}`
- `{job="proxypilot_audit", actor="cli:thomas"}`
- `{job="sshd", auth_result="failure"}`

### Loki Configuration

```yaml
auth_enabled: false

server:
  http_listen_address: 127.0.0.1
  http_listen_port: 3100

common:
  path_prefix: /var/lib/loki
  replication_factor: 1
  ring:
    kvstore:
      store: inmemory

schema_config:
  configs:
    - from: 2026-01-01
      store: tsdb
      object_store: filesystem
      schema: v13
      index:
        prefix: index_
        period: 24h

storage_config:
  tsdb_shipper:
    active_index_directory: /var/lib/loki/index
    cache_location: /var/lib/loki/index_cache
  filesystem:
    directory: /var/lib/loki/chunks

limits_config:
  retention_period: 720h    # 30 days default (Standard/Hardened)
                            # Auto-set to 8760h (365 days) for Compliant profile

compactor:
  working_directory: /var/lib/loki/compactor
  retention_enabled: true
```

### CLI Commands

```
proxypilot observability status
```
- Status of Loki, Alloy, Grafana services
- Loki: ingestion rate, storage used, retention period
- Alloy: active targets, positions lag
- Grafana: URL, active sessions

```
proxypilot observability logs [--job <job>] [--since <duration>] [--query <logql>]
```
- Quick log query from CLI without opening Grafana
- Queries Loki API directly
- Examples:
  - `proxypilot observability logs --job caddy_access --since 1h`
  - `proxypilot observability logs --query '{job="sshd"} |= "Failed"'`

```
proxypilot observability dashboard-url
```
- Prints the Grafana URL for the operator to open in a browser

### Infisical Secrets

If observability is enabled:
- `core/GRAFANA_ADMIN_PASSWORD` — Grafana admin password
- `core/LOKI_INTERNAL_URL` — `http://127.0.0.1:3100` (for reference by other services)

### SQLite State

```sql
CREATE TABLE observability_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- Seeded: enabled (true/false), grafana_route_domain, loki_retention_hours,
-- alert_webhook_url, alert_email
```

### Integration with Existing Features

- **Compliance checker**: If observability is enabled, compliance check verifies Loki retention meets requirements (365 days for Compliant — auto-configured during init, but verified here in case of manual changes). Also checks that Grafana alerting is configured.
- **Documentation generator**: If observability is enabled, the Network Security and Audit Log Summary documents include Grafana/Loki architecture details and log retention proof.
- **`proxypilot core status`**: Includes Loki/Alloy/Grafana status when enabled.
- **AIDE**: If observability is enabled, AIDE check results are shipped to Loki via Alloy in addition to being stored in SQLite.
- **Health checks**: Loki and Grafana health endpoints are added to ProxyPilot's health check loop.

### When Observability Is Not Enabled

Everything works through CLI. No degradation. ProxyPilot's built-in commands (`proxypilot audit log`, `proxypilot db stats`, `proxypilot health list`, `proxypilot security alerts`) query SQLite, Postgres, and log files directly. The observability stack is a visibility layer on top, not a dependency.

Operators running their own external Grafana/Loki can point Alloy at ProxyPilot's log files manually — the log formats (JSON Lines for audit, JSON for Caddy) are stable and documented.

## Host Hardening (Hardened/Compliant)

sysctl (disable redirects, log martians, ASLR, etc.), unattended security updates, disable unnecessary services, Incus network ACLs (default deny ingress except via Caddy, default deny egress to host except allowed PgBouncer).

## Container Patch Scheduling

### Patch with Snapshot Safety Net

```
proxypilot lxc patch-schedule <n> --cron "<expr>" [--snapshot-retention <duration>]
```

Default: weekly Sunday 03:00, 3-day snapshot retention.

Sequence: snapshot → apt upgrade → health check → if healthy: mark snapshot for auto-delete in 3 days → if unhealthy: auto-rollback + alert.

```
proxypilot lxc patch <n>                 # immediate patch with snapshot
proxypilot lxc patch-all                 # batch all containers
proxypilot lxc outdated                  # list pending updates
proxypilot lxc patch-schedule list       # show schedules
```

### Snapshot Auto-Cleanup

```sql
CREATE TABLE snapshot_expiry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  container_id INTEGER NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
  snapshot_name TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('pre_patch', 'manual')),
  created_at TEXT DEFAULT (datetime('now'))
);
```

Daily timer checks for expired snapshots and deletes them.

Defaults by profile: Standard (manual only), Hardened (weekly check + alert), Compliant (weekly automated patch with snapshot/rollback).

## Compliance Checker

### `proxypilot compliance check [--framework soc2|hipaa|all]`

Checks every control against actual system state.

**SOC 2 controls:** CC6.1 access controls, CC6.5 encryption, CC7.1 monitoring, CC7.3-7.4 incident response, CC8.1 change management, A1.1 availability.

**HIPAA controls:** §164.308(a)(1) risk assessment, §164.308(a)(3) workforce security, §164.308(a)(5) training records, §164.308(a)(6) incident response, §164.312(a)(2)(iv) encryption at rest, §164.312(b) audit controls (6-year retention), §164.312(d) authentication, §164.312(e) transmission security.

Output: per-control pass/fail with actionable fix commands. Overall score. Stored in `compliance_checks` table for trend tracking.

```
proxypilot compliance check
proxypilot compliance history [--since <datetime>]
```

## Documentation Generator

### `proxypilot compliance docs [--framework soc2|hipaa|all] [--format md|pdf|docx]`

All three formats: Markdown (fast, git-friendly), PDF (formal, Pandoc + LaTeX/weasyprint), DOCX (editable, Pandoc).

### Documents

| Document | Source |
|---|---|
| System Security Plan | Core services, network, encryption, access — from state |
| Access Control Policy | SSH users, Postgres roles, Infisical, firewall — from state |
| Backup & Recovery Plan | pgBackRest, snapshots, retention — from config |
| Audit Log Summary | Counts by type/actor/time, retention proof — from Postgres |
| Vulnerability Management | Patch schedules, pending updates, CrowdSec — from state |
| Network Security | Bridges, firewall, ACLs, PgBouncer, routes — from state |
| Certificate Inventory | All certs, history, renewals — from tracking table |
| Incident Response Plan | Template with actual systems pre-filled |
| Risk Assessment | Inventory, controls, gaps — from compliance check |
| Data Classification Policy | Classifications, handling rules — from tags |
| BAA Tracker | Vendors, status, review dates — from tracker |
| Breach Notification Procedures | Timelines, contacts, templates |

Output: `/var/lib/proxypilot/compliance/YYYY-MM-DD/`. Previous generations retained.

Templates are Markdown with `{{placeholders}}` filled from live queries. Operator-customizable.

### BAA Tracker

```
proxypilot compliance baa add --vendor <v> --signed-date <d> --review-date <d>
proxypilot compliance baa list
proxypilot compliance baa review
```

```sql
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
```

### Data Classification

```
proxypilot lxc tag <n> --classification phi|pii|confidential|internal|public
proxypilot db tag <n> --classification phi|pii|confidential|internal|public
```

Affects compliance check strictness and documentation output.

```sql
CREATE TABLE resource_classifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  resource_type TEXT NOT NULL,
  resource_name TEXT NOT NULL,
  classification TEXT NOT NULL CHECK (classification IN ('phi', 'pii', 'confidential', 'internal', 'public')),
  classified_by TEXT NOT NULL,
  classified_at TEXT DEFAULT (datetime('now')),
  UNIQUE (resource_type, resource_name)
);
```

## Database Management

### `proxypilot db create <n> [--container <c>] [--pool-size <n>] [--work-mem <v>] [--temp-file-limit <v>]`

1. Validate name
2. Generate role `<n>_app`, generate password (`crypto.randomBytes`)
3. Create role + database + grants + per-role settings in Postgres
4. Store password in Infisical
5. Add pool to PgBouncer, add to userlist, reload
6. If `--container`: nftables rule + container link + credential injection
7. Record in SQLite + audit log

### Other Commands

```
proxypilot db list                       # table with sizes from live Postgres
proxypilot db stats <n>                  # pg_stat_statements + pg_stat_activity
proxypilot db tune <n> [flags]           # ALTER ROLE + PgBouncer reload
proxypilot db drop <n> [--force]         # refuse if linked containers exist
proxypilot db credentials <n> [--show]   # retrieve from Infisical
proxypilot db connections [n] [--since]  # PgBouncer connection history
proxypilot db tag <n> --classification   # data classification
```

## pgBackRest

Stanza `proxypilot-core`. Weekly full, daily diff, continuous WAL. Encrypted repo (aes-256-cbc, key from Infisical). `proxypilot core backup verify [--restore-test]`.

## Bootstrap Sequence

```
proxypilot init
│
├─ 1. Profile selection
├─ 2. Preflight checks (all software for selected profile)
├─ 3. Generate bootstrap credentials → /root/.proxypilot-bootstrap.json (0600)
├─ 4. PostgreSQL (config, roles, databases, extensions)
├─ 5. PgBouncer (dual listener, userlist)
├─ 6. Valkey (localhost, requirepass)
├─ 7. Infisical (config, start, wait for health)
├─ 8. Credential rotation (→ Infisical → delete bootstrap file)
├─ 9. pgBackRest (stanza, initial backup, timers)
├─ 10. Caddy (verify admin API)
├─ 11. Incus (bridge, storage pool, default + hardened profiles)
├─ 12. DNS-over-TLS (write resolved.conf, restart systemd-resolved, verify)
├─ 13. nftables (proxypilot chain, default deny bridge → PgBouncer, UDP 51820 for WireGuard, logging for Hardened+)
├─ 14. SSH Hardening (Hardened+) — SAFE TRANSITION with test/confirm/test/confirm
├─ 15. WireGuard VPN (Hardened+) — key generation, config, enable, nftables rule, store key in Infisical
├─ 16. CrowdSec (Hardened+) — engine + Caddy bouncer + SSH bouncer
├─ 17. AIDE (Hardened+) — install, config, initialize database, daily timer
├─ 18. Host Hardening (Hardened+) — sysctl, unattended-upgrades, service disable
├─ 19. State initialization (SQLite, directories, audit log, logrotate, instance UUID)
├─ 20. Observability (if enabled) — Loki, Alloy, Grafana, dashboard provisioning, Caddy route (vpn-only or basic-auth)
├─ 21. Systemd timers (audit sync, health, compliance, patch, cleanup, session log, AIDE check)
└─ 22. Print summary
```

Idempotent: safe to rerun. Each step checks state before acting.

### Flags

```
--profile standard|hardened|compliant
--non-interactive
--dry-run
--skip-backup
--skip-infisical
--with-observability
--admin "<user>:<key>" (repeatable)
--config <path>
```

## Complete CLI Surface

### Core

```
proxypilot core status
proxypilot core restart <service>
proxypilot core logs <service>
proxypilot core backup verify [--restore-test]
```

### Database

```
proxypilot db create|list|stats|tune|drop|credentials|connections|tag
```

### Access

```
proxypilot access add|remove|list|history|review
```

### Certificates

```
proxypilot certs list|history|expiring
```

### Audit

```
proxypilot audit log|sync|stats
```

### Security (Hardened+)

```
proxypilot security bans|alerts
proxypilot security aide-check
proxypilot security aide-update [--reason "<description>"]
proxypilot security aide-status
```

### VPN (Hardened+)

```
proxypilot vpn add-peer <n> --public-key "<key>" [--allowed-ips "<cidr>"]
proxypilot vpn remove-peer <n> [--force]
proxypilot vpn list
proxypilot vpn status
```

### Observability (Optional)

```
proxypilot observability status
proxypilot observability logs [--job <job>] [--since <duration>] [--query <logql>]
proxypilot observability dashboard-url
```

### Compliance (Compliant)

```
proxypilot compliance check|history|docs|baa
```

### Patch

```
proxypilot lxc patch|patch-all|outdated|patch-schedule
```

### Init

```
proxypilot init [--profile] [--non-interactive] [--dry-run] [--skip-backup] [--skip-infisical] [--with-observability] [--admin] [--config]
```

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

## File Organization

```
src/
├── core/
│   ├── bootstrap.ts
│   ├── postgres.ts
│   ├── pgbouncer.ts
│   ├── valkey.ts
│   ├── infisical.ts
│   ├── pgbackrest.ts
│   ├── systemd.ts
│   ├── nftables.ts
│   ├── crowdsec.ts
│   ├── hardening.ts
│   ├── dns.ts                # DNS-over-TLS config
│   ├── wireguard.ts          # WireGuard setup, peer management, IP pool
│   ├── aide.ts               # AIDE init, check, baseline update
│   └── index.ts
├── observability/
│   ├── loki.ts               # Loki config generation
│   ├── alloy.ts           # Alloy config with auto-discovered log targets
│   ├── grafana.ts            # Grafana config, datasource/dashboard provisioning
│   ├── alerts.ts             # Grafana alert rule provisioning
│   ├── dashboard.json        # Default ProxyPilot dashboard
│   └── index.ts
├── access/
│   ├── ssh.ts
│   ├── users.ts
│   ├── sessions.ts
│   ├── review.ts
│   └── index.ts
├── audit/
│   ├── logger.ts
│   ├── sync.ts
│   └── index.ts
├── certs/
│   ├── tracker.ts
│   └── index.ts
├── compliance/
│   ├── checker.ts
│   ├── controls-soc2.ts
│   ├── controls-hipaa.ts
│   ├── docs-generator.ts
│   ├── templates/
│   ├── baa.ts
│   ├── classification.ts
│   └── index.ts
├── patch/
│   ├── executor.ts
│   ├── scheduler.ts
│   ├── checker.ts
│   ├── cleanup.ts
│   └── index.ts
├── db/
│   ├── management.ts
│   ├── connections.ts
│   ├── schema.ts
│   ├── queries.ts
│   └── index.ts
├── commands/
│   ├── init.ts
│   ├── core.ts
│   ├── db.ts
│   ├── access.ts
│   ├── audit.ts
│   ├── certs.ts
│   ├── security.ts           # proxypilot security (bans, alerts, aide)
│   ├── vpn.ts                # proxypilot vpn (add-peer, remove-peer, list, status)
│   ├── observability.ts      # proxypilot observability (status, logs, dashboard-url)
│   ├── compliance.ts
│   ├── patch.ts
│   └── ... (existing)
```

## Build Sequence

**Phase 1 — Core Service Bootstrap:** systemd generator, Postgres, PgBouncer, Valkey, bootstrap orchestration, `proxypilot init` (Standard)

**Phase 2 — Secrets:** Infisical client, credential rotation, agent templates, container injection

**Phase 3 — Database:** db CRUD, nftables rules, `lxc create --db` integration

**Phase 4 — Access, SSH & VPN:** admin accounts, safe SSH transition, WireGuard VPN + peer management, CrowdSec, DNS-over-TLS, AIDE, host hardening, init Hardened profile

**Phase 5 — Audit & History:** audit logger, instrument commands, Postgres sync, SSH sessions, PgBouncer connections, cert tracking

**Phase 6 — Patch:** patch with snapshot/rollback, scheduling, outdated check, snapshot cleanup

**Phase 7 — Compliance:** checker engine, SOC 2 + HIPAA controls, doc generator (md/pdf/docx), BAA tracker, data classification, init Compliant profile

**Phase 8 — Observability (Optional):** Loki config + service, Alloy config with auto-discovered targets + service, Grafana config + provisioning + dashboard JSON + alert rules + service, Caddy route (vpn-only or basic-auth), `proxypilot observability` CLI, integration with compliance checker

## Implementation Constraints

1. Systemd units: template strings, `/etc/systemd/system/`, `daemon-reload`.
2. PgBouncer reload: `RELOAD` via admin console, not restart.
3. Infisical: REST API, not CLI for programmatic ops.
4. Audit writes synchronous: command fails if audit write fails.
5. All Postgres through PgBouncer (except initial bootstrap).
6. nftables persistent: config file + live commands.
7. SSH safe transition: never disable without verified alternative. Reload, not restart.
8. Credentials: `crypto.randomBytes`, never `Math.random()`.
9. Doc generation: Markdown source, Pandoc for PDF/DOCX. Print install instructions if missing.
10. Profile-aware: Standard commands never fail due to missing Compliant components.
11. Idempotent init: every step checks state first.
12. Observability-aware: If observability is not enabled, all `proxypilot observability` commands print "Observability stack not installed. Run `proxypilot init --with-observability`." and exit cleanly. All other commands work identically with or without observability.

## Notes

- `proxypilot` Postgres database reserved but empty. Ready for SQLite migration if needed.
- `--skip-infisical` prints warning on every command.
- Bridge gateway `10.0.100.1` is stable. Changing requires full reconfig.
- Instance UUID in `instance_meta` for future federation.
- Compliance templates: Markdown with `{{placeholders}}`, operator-customizable.
- HIPAA requires 6-year policy retention. Audit log rotation is 365 days on disk; offsite archival handles longer retention.
