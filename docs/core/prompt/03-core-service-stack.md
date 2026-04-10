<!-- Split from proxypilot-core-infrastructure-prompt.md (lines 104-133) -->
<!-- Index: docs/core/prompt/README.md -->

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
