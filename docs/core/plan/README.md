# ProxyPilot Core Infrastructure Phased Plan — Index

This directory is the per-phase split of
[`proxypilot-core-phased-plan.md`](../../../proxypilot-core-phased-plan.md).

Every phase file is self-contained: goal, files to create, deliverables,
verification checklist, commit message. Phases are ordered by dependency.
Work through them sequentially: implement → test → commit → move on.

## Workflow per phase

1. Open the phase file for the phase you're on.
2. Open the 1–2 prompt sections it references (see
   [`../prompt/README.md`](../prompt/README.md)).
3. Implement the deliverables.
4. Run the verification checklist.
5. Commit with the suggested commit message.
6. Move to the next phase.

Each phase file also has a placeholder `Function-by-Function Checklist`
section at the bottom. Once a later planning session crafts the
function-level breakdown, that is where it lives. The workflow inside a
phase then becomes: tick off one function, confirm it works, move to the
next — potentially across multiple Claude Code sessions per phase.

## How to Use

- [`00-how-to-use.md`](00-how-to-use.md) — original "how to use this document" preface
- [`01-phase-overview.md`](01-phase-overview.md) — phase dependency matrix
- [`99-execution-order.md`](99-execution-order.md) — recommended ordering with milestones

## Phases

| Phase | File | Depends on | Delivers |
|---|---|---|---|
| 01 | [`phase-01-foundation.md`](phase-01-foundation.md) | existing ProxyPilot | SQLite schema, config loader, systemd generator |
| 02 | [`phase-02-postgres-pgbouncer.md`](phase-02-postgres-pgbouncer.md) | 01 | Core database + connection pool |
| 03 | [`phase-03-valkey.md`](phase-03-valkey.md) | 01 | Cache service for Infisical |
| 04 | [`phase-04-infisical-bootstrap.md`](phase-04-infisical-bootstrap.md) | 02, 03 | Secrets management + credential bootstrap |
| 05 | [`phase-05-pgbackrest.md`](phase-05-pgbackrest.md) | 02, 04 | Postgres backup with WAL archiving |
| 06 | [`phase-06-dns-over-tls.md`](phase-06-dns-over-tls.md) | 01 | Encrypted DNS |
| 07 | [`phase-07-audit-logging.md`](phase-07-audit-logging.md) | 01 | Append-only audit trail + instrument commands |
| 08 | [`phase-08-database-management.md`](phase-08-database-management.md) | 02, 04, 07 | `proxypilot db` CRUD + nftables rules |
| 09 | [`phase-09-ssh-hardening.md`](phase-09-ssh-hardening.md) | 04, 07 | Per-person SSH + safe transition |
| 10 | [`phase-10-wireguard-vpn.md`](phase-10-wireguard-vpn.md) | 04, 07 | Admin VPN + `--vpn-only` routes |
| 11 | [`phase-11-crowdsec.md`](phase-11-crowdsec.md) | 07 | Caddy + SSH bouncers |
| 12 | [`phase-12-aide.md`](phase-12-aide.md) | 07 | Filesystem integrity monitoring |
| 13 | [`phase-13-host-hardening.md`](phase-13-host-hardening.md) | 07 | sysctl + auto-updates + Incus ACLs |
| 14 | [`phase-14-audit-sync-history.md`](phase-14-audit-sync-history.md) | 02, 07 | Postgres sync + SSH/DB/cert history |
| 15 | [`phase-15-patch-management.md`](phase-15-patch-management.md) | 07 | Patching with snapshot rollback |
| 16 | [`phase-16-compliance-checker.md`](phase-16-compliance-checker.md) | 07-15 | SOC 2 + HIPAA control verification |
| 17 | [`phase-17-docs-generator.md`](phase-17-docs-generator.md) | 16 | Compliance docs from live state |
| 18 | [`phase-18-observability.md`](phase-18-observability.md) | 02, 04, 10 | Grafana + Loki + Alloy |
| 19 | [`phase-19-init-orchestrator.md`](phase-19-init-orchestrator.md) | all | `proxypilot init` profile-based bootstrap |

## Milestones (from execution order)

- After **Phase 6**: core services running, secrets managed, backups active
- After **Phase 8**: `proxypilot db create` works, full workload lifecycle
- After **Phase 13**: Hardened profile fully functional
- After **Phase 17**: Compliant profile fully functional
- After **Phase 19**: `proxypilot init` works end-to-end

## Status

None of the phases are implemented yet. The docs exist so that a later
session can craft the function-level checklists and start executing phase
by phase.
