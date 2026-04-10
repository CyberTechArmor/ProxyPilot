<!-- Split from proxypilot-core-infrastructure-prompt.md (lines 1421-1438) -->
<!-- Index: docs/core/prompt/README.md -->

## Build Sequence

**Phase 1 — Core Service Bootstrap:** systemd generator, Postgres, PgBouncer, Valkey, bootstrap orchestration, `proxypilot init` (Standard)

**Phase 2 — Secrets:** Infisical client, credential rotation, agent templates, container injection

**Phase 3 — Database:** db CRUD, nftables rules, `lxc create --db` integration

**Phase 4 — Access, SSH & VPN:** admin accounts, safe SSH transition, WireGuard VPN + peer management, CrowdSec, DNS-over-TLS, AIDE, host hardening, init Hardened profile

**Phase 5 — Audit & History:** audit logger, instrument commands, Postgres sync, SSH sessions, PgBouncer connections, cert tracking

**Phase 6 — Patch:** patch with snapshot/rollback, scheduling, outdated check, snapshot cleanup

**Phase 7 — Compliance:** checker engine, SOC 2 + HIPAA controls, doc generator (md/pdf/docx), BAA tracker, data classification, init Compliant profile

**Phase 8 — Observability (Optional):** Loki config + service, Alloy config with auto-discovered targets + service, Grafana config + provisioning + dashboard JSON + alert rules + service, Caddy route (vpn-only or basic-auth), `proxypilot observability` CLI, integration with compliance checker
