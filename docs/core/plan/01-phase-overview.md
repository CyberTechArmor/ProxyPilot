<!-- Split from proxypilot-core-phased-plan.md (lines 26-51), updated for 21-phase plan -->
<!-- Index: docs/core/plan/README.md -->

## Phase Overview

| Phase | Name | What It Delivers | Depends On |
|---|---|---|---|
| 1 | Mobile-Friendly Admin Dashboard | Responsive layout for phones and tablets across every admin page | Existing ProxyPilot |
| 2 | Multi-Service Path-Prefix Routing | Multiple services per domain via merged Caddy `handle_path` blocks | Existing ProxyPilot |
| 3 | Foundation | SQLite schema, config loader, systemd unit generator | Existing ProxyPilot |
| 4 | PostgreSQL + PgBouncer | Core database with connection pooling | Phase 3 |
| 5 | Valkey | Cache service for Infisical | Phase 3 |
| 6 | Infisical | Secrets management + credential bootstrap/rotation | Phases 4, 5 |
| 7 | pgBackRest | Postgres backup with WAL archiving | Phases 4, 6 |
| 8 | DNS-over-TLS | Encrypted DNS for the host | Phase 3 |
| 9 | Audit Logging (File) | Append-only audit trail + instrument all commands | Phase 3 |
| 10 | Database Management | `proxypilot db` CRUD + nftables firewall rules | Phases 4, 6, 9 |
| 11 | SSH Hardening + Access | Per-person SSH, safe transition, access CRUD | Phases 6, 9 |
| 12 | WireGuard VPN | Admin VPN + peer management + `--vpn-only` routes | Phases 6, 9 |
| 13 | CrowdSec | Caddy + SSH bouncers, security CLI | Phase 9 |
| 14 | AIDE | Filesystem integrity monitoring | Phase 9 |
| 15 | Host Hardening | sysctl, unattended-upgrades, Incus network ACLs | Phase 9 |
| 16 | Audit Postgres Sync | File → Postgres sync + connection/session/cert history | Phases 4, 9 |
| 17 | Patch Management | Container patching with snapshot/rollback | Phase 9 |
| 18 | Compliance Checker | SOC 2 + HIPAA control verification | Phases 9-17 |
| 19 | Documentation Generator | Compliance docs from live state (md/pdf/docx) | Phase 18 |
| 20 | Observability | Grafana + Loki + Alloy dashboards and alerting | Phases 4, 6, 12 |
| 21 | Init Orchestrator | `proxypilot init` ties all phases into profile-based bootstrap | All phases |

Phases 1 and 2 were added after the initial plan was split because they
are prerequisites the operator asked for: mobile access to the dashboard,
and multiple services per domain. They do not depend on any core
infrastructure phase and can ship as soon as they are ready.

---
