# ProxyPilot Core Infrastructure Spec — Section Index

This directory is the per-section split of
[`proxypilot-core-infrastructure-prompt.md`](../../../proxypilot-core-infrastructure-prompt.md).

Load only the sections you need for the phase you're working on. Every file
in this directory is self-contained for reading, but **all cross-references
and schema details only make sense when combined with the phased plan** —
see [`../plan/`](../plan/).

## Sections

| # | File | Summary |
|---|---|---|
| 00 | [`00-overview.md`](00-overview.md) | Title, project context |
| 01 | [`01-design-principles.md`](01-design-principles.md) | The seven principles ProxyPilot is built on |
| 02 | [`02-installation-profiles.md`](02-installation-profiles.md) | Standard / Hardened / Compliant / Custom + component matrix |
| 03 | [`03-core-service-stack.md`](03-core-service-stack.md) | Systemd units, dependency graph |
| 04 | [`04-ssh-access-management.md`](04-ssh-access-management.md) | Safe SSH transition, per-person access, audit actor identity |
| 05 | [`05-cert-and-connection-history.md`](05-cert-and-connection-history.md) | Cert tracker, SSH sessions, PgBouncer connection log |
| 06 | [`06-postgresql-architecture.md`](06-postgresql-architecture.md) | Single instance / multi-DB, role isolation, pgAudit |
| 07 | [`07-pgbouncer-architecture.md`](07-pgbouncer-architecture.md) | Dual listener, transaction pooling, per-DB pools |
| 08 | [`08-valkey.md`](08-valkey.md) | Cache backend for Infisical |
| 09 | [`09-infisical.md`](09-infisical.md) | Secrets store, Agent templates, container injection |
| 10 | [`10-audit-logging.md`](10-audit-logging.md) | Dual-write JSONL + Postgres, retention, audited actions |
| 11 | [`11-crowdsec.md`](11-crowdsec.md) | Caddy + SSH bouncers |
| 12 | [`12-dns-over-tls.md`](12-dns-over-tls.md) | systemd-resolved config |
| 13 | [`13-wireguard-vpn.md`](13-wireguard-vpn.md) | Admin VPN, peer management, `--vpn-only` routes |
| 14 | [`14-aide.md`](14-aide.md) | Filesystem integrity monitoring |
| 15 | [`15-observability-stack.md`](15-observability-stack.md) | Grafana + Loki + Alloy (optional) |
| 16 | [`16-host-hardening.md`](16-host-hardening.md) | sysctl, unattended-upgrades, Incus ACLs |
| 17 | [`17-container-patch-scheduling.md`](17-container-patch-scheduling.md) | Patch with snapshot/rollback, snapshot cleanup |
| 18 | [`18-compliance-checker.md`](18-compliance-checker.md) | SOC 2 + HIPAA control checks |
| 19 | [`19-documentation-generator.md`](19-documentation-generator.md) | Compliance docs from live state |
| 20 | [`20-database-management.md`](20-database-management.md) | `proxypilot db` CRUD |
| 21 | [`21-pgbackrest.md`](21-pgbackrest.md) | Postgres backup with WAL archiving |
| 22 | [`22-bootstrap-sequence.md`](22-bootstrap-sequence.md) | `proxypilot init` 22-step sequence + flags |
| 23 | [`23-cli-surface.md`](23-cli-surface.md) | Full CLI command reference |
| 24 | [`24-sqlite-schema.md`](24-sqlite-schema.md) | All `CREATE TABLE` statements |
| 25 | [`25-file-organization.md`](25-file-organization.md) | `src/` tree layout |
| 26 | [`26-build-sequence.md`](26-build-sequence.md) | Alternate phase ordering |
| 27 | [`27-implementation-constraints.md`](27-implementation-constraints.md) | The 12 hard rules |
| 28 | [`28-notes.md`](28-notes.md) | Miscellaneous reminders |

## Which sections each phase references

When you pick up a phase file from [`../plan/`](../plan/), these are the
prompt sections it most relies on:

| Phase | Primary prompt sections |
|---|---|
| 01 Foundation | 24 (schema), 25 (file org), 27 (constraints) |
| 02 Postgres + PgBouncer | 06, 07 |
| 03 Valkey | 08 |
| 04 Infisical + Bootstrap | 09, 22 |
| 05 pgBackRest | 21 |
| 06 DNS-over-TLS | 12 |
| 07 Audit Logging | 10 |
| 08 Database Management | 20 |
| 09 SSH Hardening | 04 |
| 10 WireGuard VPN | 13 |
| 11 CrowdSec | 11 |
| 12 AIDE | 14 |
| 13 Host Hardening | 16 |
| 14 Audit Sync + History | 05, 10 |
| 15 Patch Management | 17 |
| 16 Compliance Checker | 18 |
| 17 Documentation Generator | 19 |
| 18 Observability | 15 |
| 19 Init Orchestrator | 02, 22, 23 |
