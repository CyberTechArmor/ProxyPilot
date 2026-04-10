<!-- Split from proxypilot-core-phased-plan.md (lines 26-51) -->
<!-- Index: docs/core/plan/README.md -->

## Phase Overview

| Phase | Name | What It Delivers | Depends On |
|---|---|---|---|
| 1 | Foundation | SQLite schema, config loader, systemd unit generator | Existing ProxyPilot |
| 2 | PostgreSQL + PgBouncer | Core database with connection pooling | Phase 1 |
| 3 | Valkey | Cache service for Infisical | Phase 1 |
| 4 | Infisical | Secrets management + credential bootstrap/rotation | Phases 2, 3 |
| 5 | pgBackRest | Postgres backup with WAL archiving | Phases 2, 4 |
| 6 | DNS-over-TLS | Encrypted DNS for the host | Phase 1 |
| 7 | Audit Logging (File) | Append-only audit trail + instrument all commands | Phase 1 |
| 8 | Database Management | `proxypilot db` CRUD + nftables firewall rules | Phases 2, 4, 7 |
| 9 | SSH Hardening + Access | Per-person SSH, safe transition, access CRUD | Phases 4, 7 |
| 10 | WireGuard VPN | Admin VPN + peer management + `--vpn-only` routes | Phases 4, 7 |
| 11 | CrowdSec | Caddy + SSH bouncers, security CLI | Phase 7 |
| 12 | AIDE | Filesystem integrity monitoring | Phase 7 |
| 13 | Host Hardening | sysctl, unattended-upgrades, Incus network ACLs | Phase 7 |
| 14 | Audit Postgres Sync | File → Postgres sync + connection/session/cert history | Phases 2, 7 |
| 15 | Patch Management | Container patching with snapshot/rollback | Phase 7 |
| 16 | Compliance Checker | SOC 2 + HIPAA control verification | Phases 7-15 |
| 17 | Documentation Generator | Compliance docs from live state (md/pdf/docx) | Phase 16 |
| 18 | Observability | Grafana + Loki + Alloy dashboards and alerting | Phases 2, 4, 10 |
| 19 | Init Orchestrator | `proxypilot init` ties all phases into profile-based bootstrap | All phases |

---
