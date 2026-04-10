# ProxyPilot Core Infrastructure Phased Plan — Index

This directory is the per-phase split of
[`proxypilot-core-phased-plan.md`](../../../proxypilot-core-phased-plan.md)
plus two phases added later (Phase 1 and Phase 2) that the operator
requested before kicking off the core infrastructure work.

Every phase file is self-contained: goal, files to create, deliverables,
verification checklist, commit message. Phases are ordered by dependency.
Work through them sequentially: implement → test → commit → move on.

## Workflow per phase

1. Open the phase file for the phase you're on.
2. Open the 1–2 prompt sections it references (see
   [`../prompt/README.md`](../prompt/README.md)) — only relevant for
   phases 3+, since phases 1 and 2 are frontend/Caddy work that predate
   the core spec.
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
| 01 | ✅ [`phase-01-mobile-friendly.md`](phase-01-mobile-friendly.md) | existing ProxyPilot | Responsive admin dashboard for phones and tablets |
| 02 | ✅ [`phase-02-path-prefix-multi-service.md`](phase-02-path-prefix-multi-service.md) | existing ProxyPilot | Multiple services per domain via merged `handle_path` |
| 03 | [`phase-03-foundation.md`](phase-03-foundation.md) | existing ProxyPilot | SQLite schema, config loader, systemd generator |
| 04 | [`phase-04-postgres-pgbouncer.md`](phase-04-postgres-pgbouncer.md) | 03 | Core database + connection pool |
| 05 | [`phase-05-valkey.md`](phase-05-valkey.md) | 03 | Cache service for Infisical |
| 06 | [`phase-06-infisical-bootstrap.md`](phase-06-infisical-bootstrap.md) | 04, 05 | Secrets management + credential bootstrap |
| 07 | [`phase-07-pgbackrest.md`](phase-07-pgbackrest.md) | 04, 06 | Postgres backup with WAL archiving |
| 08 | [`phase-08-dns-over-tls.md`](phase-08-dns-over-tls.md) | 03 | Encrypted DNS |
| 09 | [`phase-09-audit-logging.md`](phase-09-audit-logging.md) | 03 | Append-only audit trail + instrument commands |
| 10 | [`phase-10-database-management.md`](phase-10-database-management.md) | 04, 06, 09 | `proxypilot db` CRUD + nftables rules |
| 11 | [`phase-11-ssh-hardening.md`](phase-11-ssh-hardening.md) | 06, 09 | Per-person SSH + safe transition |
| 12 | [`phase-12-wireguard-vpn.md`](phase-12-wireguard-vpn.md) | 06, 09 | Admin VPN + `--vpn-only` routes |
| 13 | [`phase-13-crowdsec.md`](phase-13-crowdsec.md) | 09 | Caddy + SSH bouncers |
| 14 | [`phase-14-aide.md`](phase-14-aide.md) | 09 | Filesystem integrity monitoring |
| 15 | [`phase-15-host-hardening.md`](phase-15-host-hardening.md) | 09 | sysctl + auto-updates + Incus ACLs |
| 16 | [`phase-16-audit-sync-history.md`](phase-16-audit-sync-history.md) | 04, 09 | Postgres sync + SSH/DB/cert history |
| 17 | [`phase-17-patch-management.md`](phase-17-patch-management.md) | 09 | Patching with snapshot rollback |
| 18 | [`phase-18-compliance-checker.md`](phase-18-compliance-checker.md) | 09-17 | SOC 2 + HIPAA control verification |
| 19 | [`phase-19-docs-generator.md`](phase-19-docs-generator.md) | 18 | Compliance docs from live state |
| 20 | [`phase-20-observability.md`](phase-20-observability.md) | 04, 06, 12 | Grafana + Loki + Alloy |
| 21 | [`phase-21-init-orchestrator.md`](phase-21-init-orchestrator.md) | all | `proxypilot init` profile-based bootstrap |

## Milestones (from execution order)

- After **Phase 1**: the dashboard is usable on phones and tablets
- After **Phase 2**: multiple services can share a domain on different paths
- After **Phase 8**: core services running, secrets managed, backups active
- After **Phase 10**: `proxypilot db create` works, full workload lifecycle
- After **Phase 15**: Hardened profile fully functional
- After **Phase 19**: Compliant profile fully functional
- After **Phase 21**: `proxypilot init` works end-to-end

## Status

- **Phase 1** — ✅ Complete (mobile-friendly admin dashboard). See
  `phase-01-mobile-friendly.md` for the per-function checklist and
  verification notes. Live browser sign-off at 360/375/390/768/1280/1920
  and Lighthouse ≥90 still to be confirmed by the operator via
  `npm run dev`. Future UI changes must follow
  [`admin/frontend/MOBILE_FIRST.md`](../../../admin/frontend/MOBILE_FIRST.md).
- **Phase 2** — ✅ Complete (multi-service path-prefix routing). See
  `phase-02-path-prefix-multi-service.md` for the function-by-function
  checklist and verification notes. Schema migration is idempotent (fresh
  installs use the new `UNIQUE(domain, path_prefix)` constraint directly,
  existing installs are rebuilt on first boot). All nine `generateCaddyConfig`
  call sites now go through `regenerateDomainCaddyConfig`, which writes a
  single merged site block per domain with `handle_path /prefix*` blocks
  emitted in length-DESC specificity order. Per design decision, SSL is
  enforced as all-or-nothing per domain. Frontend wizard shows existing
  prefixes when the operator types an in-use domain, the services grid
  groups multi-service domains under a header row, and the delete dialog
  warns when siblings will be left behind. Verified end-to-end via
  puppeteer at 360px and 1280px and via Express integration tests for
  every endpoint. Live `caddy adapt` against a real Caddy install still
  to be confirmed by the operator via `npm run dev`.
- **Phases 3–21** — Not started. The docs exist so that later sessions
  can craft the function-level checklists and execute phase by phase.
