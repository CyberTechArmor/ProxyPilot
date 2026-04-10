<!-- Split from proxypilot-core-infrastructure-prompt.md (lines 585-870) -->
<!-- Index: docs/core/prompt/README.md -->

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
