# ProxyPilot Core Infrastructure — Phased Implementation Plan

## How to Use This Document

This is the implementation plan for the ProxyPilot core infrastructure upgrade. Each phase is self-contained, independently testable, and leaves the system in a working state. Work through phases sequentially: implement → test → commit → move on.

**For each phase**, hand Claude Code:
1. This document (for overall context and phase ordering)
2. The full specification: `proxypilot-core-infrastructure-prompt.md` (for detailed schemas, configs, and CLI definitions)
3. The specific phase number you're working on

**Workflow per phase:**
```
1. Read this phase's scope and deliverables
2. Read the relevant sections in the full spec
3. Implement
4. Run the verification checklist
5. Commit: git commit -m "phase-XX: <description>"
6. Move to next phase
```

**Reference document:** `proxypilot-core-infrastructure-prompt.md` contains the full technical specification — SQLite schemas, config files, CLI command definitions, Caddy/Incus/Postgres configurations, and implementation constraints. This plan tells you what to build and in what order. The spec tells you how.

---

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

## Phase 1: Foundation

**Goal:** Build the infrastructure that every subsequent phase depends on — state store, configuration, and systemd management.

**Files to create:**
```
src/db/schema.ts             # SQLite schema + migrations + WAL mode
src/db/queries.ts            # Typed query helpers
src/db/index.ts
src/core/config.ts           # YAML config loader (~/.proxypilot/config.yaml)
src/core/systemd.ts          # Generate .service/.timer units, daemon-reload, enable/start/stop
src/core/index.ts
```

**Deliverables:**
- SQLite database initialization with full schema from spec (all tables — routes, containers, databases, vpn_peers, etc.). Tables for features not yet implemented are created empty — this avoids schema migrations later.
- Config loader that reads `~/.proxypilot/config.yaml` with defaults for every value. Environment variable overrides.
- Systemd unit generator: function that takes a unit definition (name, exec, after, type) and writes a `.service` or `.timer` file to `/etc/systemd/system/`, runs `daemon-reload`.
- Helper functions: enable, start, stop, restart, status, is-active for any unit.
- `instance_meta` table seeded with `instance_uuid` (generated) and `install_profile` (empty until Phase 19).

**Spec references:** "State Store: SQLite" section, "Config File" section, all `CREATE TABLE` statements in "Full SQLite Schema Additions", "Implementation Constraints" items 1 and 11.

**Verification:**
- [ ] `proxypilot` runs without error (no new commands yet, just infrastructure)
- [ ] SQLite database created at configured path with all tables
- [ ] Config loader reads YAML, applies defaults, respects env overrides
- [ ] Systemd generator can create a test unit, start it, check status, stop it, remove it
- [ ] Unit tests pass for schema initialization, config loading, systemd generation

**Commit:** `phase-01: foundation - sqlite schema, config loader, systemd generator`

---

## Phase 2: PostgreSQL + PgBouncer

**Goal:** Core Postgres instance with PgBouncer connection pooling, managed by systemd.

**Files to create:**
```
src/core/postgres.ts         # Config generation, role/database creation, RAM-tuned settings
src/core/pgbouncer.ts        # Config generation, dual listener, reload via admin console
```

**Deliverables:**
- `postgres.ts`: Generate `postgresql.conf` (RAM-tuned), `pg_hba.conf` (localhost + scram-sha-256). Create roles (`infisical_app`, `proxypilot_audit`, `proxypilot_app`) and databases (`infisical`, `proxypilot_audit`, `proxypilot`). Install `pg_stat_statements` extension. Set per-role `work_mem` and `temp_file_limit`.
- `pgbouncer.ts`: Generate `pgbouncer.ini` (dual listener: `127.0.0.1:6432` + `10.0.100.1:6432`), generate `userlist.txt`. Reload function via PgBouncer admin console (not systemctl restart).
- Generate and install `proxypilot-postgres.service` and `proxypilot-pgbouncer.service` (with After dependency).
- All functions are idempotent — safe to call if already configured.

**Spec references:** "PostgreSQL Architecture" section, "PgBouncer Architecture" section, Postgres config details, pg_hba.conf rules.

**Verification:**
- [ ] Postgres starts via systemd, accepting connections on localhost:5432
- [ ] All three core databases exist with correct owners
- [ ] Each role can connect to its own database and cannot connect to others
- [ ] `pg_stat_statements` extension loaded
- [ ] PgBouncer starts, connects through it to each database
- [ ] PgBouncer listens on both 127.0.0.1:6432 and 10.0.100.1:6432
- [ ] PgBouncer reload works via admin console without dropping connections

**Commit:** `phase-02: postgresql + pgbouncer - core database with connection pooling`

---

## Phase 3: Valkey

**Goal:** Cache/queue service for Infisical.

**Files to create:**
```
src/core/valkey.ts           # Config generation, service management
```

**Deliverables:**
- Generate `valkey.conf` (localhost only, requirepass, 256MB max, no persistence).
- Generate and install `proxypilot-valkey.service`.
- Verify function: AUTH + PING.

**Spec references:** "Valkey Configuration" section.

**Verification:**
- [ ] Valkey starts via systemd
- [ ] Can AUTH with generated password and PING
- [ ] Not accessible from bridge network (localhost only)

**Commit:** `phase-03: valkey - cache service for infisical`

---

## Phase 4: Infisical + Credential Bootstrap

**Goal:** Secrets management with zero-plaintext credential lifecycle.

**Files to create:**
```
src/core/infisical.ts        # Infisical REST API client, project/environment/secret CRUD
src/core/bootstrap.ts        # Credential generation, bootstrap sequence, rotation
```

**Deliverables:**
- `bootstrap.ts`: Generate all credentials (`crypto.randomBytes`), write to `/root/.proxypilot-bootstrap.json` (mode 0600). Orchestrate: start Postgres → PgBouncer → Valkey → configure Infisical → start Infisical → wait for health → create project/environments → store all credentials in Infisical → verify retrieval → delete bootstrap file.
- `infisical.ts`: REST API client for Infisical. Create project, create environments (core, databases, workloads), create/read/update/delete secrets. No dependency on Infisical CLI for programmatic ops.
- Infisical Agent template generation (`pgbouncer-userlist.tmpl`, `valkey.tmpl`). Generate and install `proxypilot-infisical.service` and `proxypilot-infisical-agent.service`.
- After this phase, no credentials exist in plaintext on disk.

**Spec references:** "Infisical Integration" section, "Bootstrap Sequence" steps 3-8, credential rotation details, Infisical project structure.

**Verification:**
- [ ] Bootstrap generates credentials file, configures all services, starts Infisical
- [ ] Infisical API responds to health check
- [ ] All credentials stored in Infisical (core environment)
- [ ] Bootstrap file deleted after rotation
- [ ] Infisical Agent renders PgBouncer userlist and Valkey config from templates
- [ ] PgBouncer still works after switching to agent-rendered userlist
- [ ] Can retrieve any secret via Infisical API

**Commit:** `phase-04: infisical - secrets management with credential bootstrap`

---

## Phase 5: pgBackRest

**Goal:** Postgres backup with WAL archiving, scheduled full + differential backups.

**Files to create:**
```
src/core/pgbackrest.ts       # Config, stanza management, verify, backup commands
```

**Deliverables:**
- Generate `pgbackrest.conf` (stanza `proxypilot-core`, encrypted repo with key from Infisical, zstd compression, retention policy).
- Update `postgresql.conf`: `archive_mode = on`, `archive_command` for pgBackRest.
- Create stanza, run initial full backup.
- Generate `proxypilot-pgbackrest-full.timer` (weekly) and `proxypilot-pgbackrest-diff.timer` (daily).
- `proxypilot core backup verify [--restore-test]` command.

**Spec references:** "pgBackRest Configuration" section, Postgres config WAL settings.

**Verification:**
- [ ] Stanza created, initial full backup completed
- [ ] `pgbackrest info` shows valid backup
- [ ] WAL archiving is active (check `archive_command` in pg_stat_archiver)
- [ ] Both timers enabled and scheduled
- [ ] `proxypilot core backup verify` passes
- [ ] (Optional) `--restore-test` restores to temp dir, starts temp Postgres, runs query, cleans up

**Commit:** `phase-05: pgbackrest - postgres backup with wal archiving`

---

## Phase 6: DNS-over-TLS

**Goal:** Encrypted DNS for every ProxyPilot host.

**Files to create:**
```
src/core/dns.ts              # resolved.conf generation, restart, verify
```

**Deliverables:**
- Write `/etc/systemd/resolved.conf` with Cloudflare + Quad9 DNS, DNSSEC + DNSOverTLS.
- Restart `systemd-resolved`, verify with `resolvectl status`.
- Idempotent: skip if already configured, don't overwrite operator changes.

**Spec references:** "DNS-over-TLS" section.

**Verification:**
- [ ] `resolvectl status` shows `DNSOverTLS: yes`
- [ ] DNS queries resolve correctly
- [ ] Re-running does not overwrite if already configured

**Commit:** `phase-06: dns-over-tls - encrypted dns`

---

## Phase 7: Audit Logging (File-Based)

**Goal:** Append-only audit trail for every ProxyPilot mutation. This is the foundation for compliance — everything after this phase generates audit entries.

**Files to create:**
```
src/audit/logger.ts          # Synchronous append-only JSON Lines writer
src/audit/index.ts
```

**Deliverables:**
- `logger.ts`: Write JSON Lines entries to `/var/log/proxypilot/audit.log`. Synchronous — if the write fails, the command fails. Actor from `$SUDO_USER` or `$USER`.
- Create log directory and file with correct permissions.
- Configure logrotate (`copytruncate`, 365 days for Compliant, 90 days otherwise).
- **Instrument all existing ProxyPilot commands** with audit log writes. Every command that changes state (route add/remove, lxc create/destroy/start/stop, static deploy, etc.) must call the audit logger. This is the biggest deliverable in this phase — go through every existing command.
- `proxypilot audit log [--tail N] [--action X] [--resource X] [--actor X] [--since X]` command.
- `proxypilot audit stats` command (total entries, file size, last entry time).

**Spec references:** "Audit Logging" section, "Actions to Audit" table, audit entry JSON format, logrotate config.

**Verification:**
- [ ] Audit log file created at correct path
- [ ] Running any state-changing command produces an audit entry
- [ ] Audit entries contain correct actor, action, resource, result, timestamp
- [ ] `proxypilot audit log --tail 5` shows recent entries
- [ ] `proxypilot audit stats` shows correct totals
- [ ] Logrotate config installed
- [ ] Command fails if audit write fails (test by making log file read-only temporarily)

**Commit:** `phase-07: audit-logging - append-only audit trail for all commands`

---

## Phase 8: Database Management

**Goal:** `proxypilot db` commands for workload database lifecycle + per-container firewall rules.

**Files to create:**
```
src/db/management.ts         # Database create/drop/tune/stats/credentials
src/core/nftables.ts         # Firewall rule generation, per-container PgBouncer access
src/commands/db.ts           # CLI command definitions
```

**Deliverables:**
- `proxypilot db create` — full sequence: create role + database + grants + per-role settings in Postgres, store password in Infisical, add PgBouncer pool + reload, optional nftables rule + container link.
- `proxypilot db list` — table with live sizes from Postgres.
- `proxypilot db stats` — pg_stat_statements + pg_stat_activity queries.
- `proxypilot db tune` — ALTER ROLE + PgBouncer reload.
- `proxypilot db drop` — full teardown with container link check.
- `proxypilot db credentials` — retrieve from Infisical, print connection string.
- `nftables.ts`: Create proxypilot chain, default deny bridge → 10.0.100.1:6432, per-container allow rules, persist for boot.
- Integration with `proxypilot lxc create --db` flag.
- All commands write audit log entries.

**Spec references:** "Database Management" section (all subsections), "Container Firewall Integration" section, `databases` and `container_databases` schema.

**Verification:**
- [ ] `proxypilot db create testdb` creates database, role, PgBouncer pool, Infisical secret
- [ ] Can connect to new database through PgBouncer
- [ ] `proxypilot db list` shows the database with correct size
- [ ] `proxypilot db stats testdb` shows connection and query stats
- [ ] `proxypilot db tune testdb --pool-size 30` updates PgBouncer, role settings
- [ ] `proxypilot db credentials testdb` retrieves from Infisical
- [ ] `proxypilot lxc create --name test --db testdb` creates container with firewall rule
- [ ] Container can reach PgBouncer, container without --db cannot
- [ ] `proxypilot db drop testdb` cleans up everything
- [ ] All operations produce audit log entries
- [ ] nftables rules persist across reboot

**Commit:** `phase-08: database-management - db lifecycle with firewall rules`

---

## Phase 9: SSH Hardening + Access Management

**Goal:** Per-person SSH access with safe transition sequence.

**Files to create:**
```
src/access/ssh.ts            # SSH hardening, safe transition, sshd config
src/access/users.ts          # Admin account CRUD
src/access/review.ts         # Quarterly access review
src/access/index.ts
src/commands/access.ts       # CLI command definitions
```

**Deliverables:**
- Safe SSH transition sequence: create accounts → install keys → TEST → confirm → harden sshd → reload → TEST AGAIN → confirm. Revert on failure.
- `proxypilot access add/remove/list` — system user management with SSH keys, sshd AllowUsers, audit logging.
- `proxypilot access review` — quarterly review flow for Compliant profile.
- Actor identity: read `$SUDO_USER` for audit log actor field.

**Spec references:** "SSH Access Management" section (all subsections), "Safe Transition Sequence", admin specification.

**⚠️ TEST ON A NON-PRODUCTION MACHINE FIRST.** SSH lockout on a remote host is unrecoverable without console access.

**Verification:**
- [ ] Can create admin account with SSH key
- [ ] New account can SSH in and sudo
- [ ] After hardening: root login disabled, password auth disabled
- [ ] Existing session preserved during sshd reload
- [ ] `proxypilot access list` shows all accounts with last login
- [ ] `proxypilot access remove` locks account, updates AllowUsers, reloads sshd
- [ ] All operations produce audit log entries
- [ ] Revert works if test fails after lockdown

**Commit:** `phase-09: ssh-access - per-person ssh with safe transition`

---

## Phase 10: WireGuard VPN

**Goal:** Admin VPN access with peer management.

**Files to create:**
```
src/core/wireguard.ts        # Key generation, config, peer management, IP pool
src/commands/vpn.ts          # CLI command definitions
```

**Deliverables:**
- Server key generation, wg0.conf with dynamic interface detection (never hardcode interface name).
- nftables rule for UDP 51820.
- Store server key in Infisical.
- `proxypilot vpn add-peer/remove-peer/list/status`.
- VPN IP pool allocation (10.100.0.10-254) tracked in SQLite.
- Route `--vpn-only` flag: adds Caddy matcher restricting to 10.100.0.0/24.
- All commands write audit log entries.

**Spec references:** "WireGuard VPN" section, vpn_peers schema, PostUp/PostDown with dynamic interface detection.

**Verification:**
- [ ] WireGuard interface up, `wg show` reports listening
- [ ] Server key stored in Infisical
- [ ] `proxypilot vpn add-peer` adds peer, assigns IP, updates wg0.conf
- [ ] Client can connect and reach 10.100.0.1
- [ ] `proxypilot route add x --vpn-only` restricts route to VPN subnet
- [ ] Route returns 403 from public internet, 200 from VPN
- [ ] `proxypilot vpn remove-peer` removes peer, releases IP
- [ ] `proxypilot vpn list` shows peers with live handshake data
- [ ] All operations produce audit log entries

**Commit:** `phase-10: wireguard-vpn - admin access with peer management`

---

## Phase 11: CrowdSec

**Goal:** Threat detection with Caddy and SSH bouncers.

**Files to create:**
```
src/core/crowdsec.ts         # Engine config, bouncer registration
src/commands/security.ts     # CLI command definitions (shared with AIDE in Phase 12)
```

**Deliverables:**
- CrowdSec engine configuration.
- Register Caddy bouncer + SSH bouncer.
- `proxypilot security bans [--list]` and `proxypilot security alerts [--since X]`.
- CrowdSec status integrated into `proxypilot core status`.
- All operations write audit log entries.

**Spec references:** "CrowdSec" section.

**Verification:**
- [ ] CrowdSec engine running
- [ ] `cscli bouncers list` shows Caddy + SSH bouncers active
- [ ] `proxypilot security bans` works (may show empty list)
- [ ] `proxypilot core status` includes CrowdSec state
- [ ] Simulated SSH brute force triggers a ban

**Commit:** `phase-11: crowdsec - threat detection with caddy and ssh bouncers`

---

## Phase 12: AIDE

**Goal:** Filesystem integrity monitoring with baseline management.

**Files to create:**
```
src/core/aide.ts             # Init, check, baseline update
```

**Deliverables:**
- AIDE config with monitored paths (binaries, configs, boot) and exclusions (data dirs, logs).
- Database initialization.
- Daily timer (`proxypilot-aide-check.timer`).
- `proxypilot security aide-check` — manual immediate check.
- `proxypilot security aide-update [--reason X]` — re-initialize baseline after approved changes.
- `proxypilot security aide-status` — last check, database age, next check.
- Auto re-init triggers documented (after init re-run, after unattended-upgrades).
- Check results stored in SQLite (`aide_checks` table).

**Spec references:** "AIDE" section, aide_checks and aide_baselines schemas.

**Verification:**
- [ ] AIDE database initialized
- [ ] `proxypilot security aide-check` returns clean
- [ ] Modify a monitored file → `aide-check` detects the change
- [ ] `proxypilot security aide-update --reason "test"` re-initializes baseline
- [ ] After update, check returns clean again
- [ ] Timer installed and scheduled
- [ ] Check results recorded in SQLite

**Commit:** `phase-12: aide - filesystem integrity monitoring`

---

## Phase 13: Host Hardening

**Goal:** Kernel/network hardening, automatic security updates, Incus network ACLs.

**Files to create:**
```
src/core/hardening.ts        # sysctl, unattended-upgrades, service disable, Incus ACLs
```

**Deliverables:**
- Apply sysctl settings (disable redirects, log martians, ASLR, etc.).
- Configure unattended-upgrades (security updates only).
- Disable unnecessary services (interactive confirmation).
- Incus network ACLs: default deny ingress except via Caddy, default deny egress to host except PgBouncer for containers with `--db`.

**Spec references:** "Host Hardening" section, sysctl values, Incus network ACLs.

**Verification:**
- [ ] `sysctl` values applied and persisted
- [ ] `unattended-upgrades` configured and enabled
- [ ] Incus ACLs prevent container from reaching host services (except PgBouncer for authorized containers)
- [ ] Containers with `--db` can still reach PgBouncer
- [ ] Containers without `--db` cannot

**Commit:** `phase-13: host-hardening - sysctl, auto-updates, incus acls`

---

## Phase 14: Audit Postgres Sync + History Tracking

**Goal:** Sync audit log to Postgres for querying. Track SSH sessions, PgBouncer connections, and TLS certificates.

**Files to create:**
```
src/audit/sync.ts            # File → Postgres sync with offset tracking
src/access/sessions.ts       # SSH session log parser
src/db/connections.ts        # PgBouncer connection history parser
src/certs/tracker.ts         # Certificate history from Caddy API
src/certs/index.ts
src/commands/certs.ts        # CLI command definitions
```

**Deliverables:**
- `proxypilot audit sync` — read new entries from audit log file, insert into Postgres `audit_log` table. Track byte offset + inode for `copytruncate` handling.
- `proxypilot-audit-sync.timer` (every 60 seconds).
- SSH session parser: parse sshd journal entries → `ssh_sessions` table. `proxypilot access history [username]`.
- PgBouncer connection parser: parse PgBouncer logs → `db_connections` table. `proxypilot db connections [name]`.
- Certificate tracker: poll Caddy admin API → `certificate_history` table. `proxypilot certs list/history/expiring`.

**Spec references:** "Audit Logging" Postgres schema, "SSH Connection History", "PgBouncer Connection History", "Certificate Tracking" sections, all related schemas.

**Verification:**
- [ ] `proxypilot audit sync` syncs entries to Postgres
- [ ] Postgres audit_log rows match file entries
- [ ] Sync handles file truncation (logrotate) correctly
- [ ] Timer runs on schedule
- [ ] `proxypilot access history` shows SSH sessions
- [ ] `proxypilot db connections` shows PgBouncer connections
- [ ] `proxypilot certs list` shows current certificates
- [ ] `proxypilot certs history <domain>` shows cert lifecycle

**Commit:** `phase-14: audit-sync-history - postgres sync, ssh/db/cert tracking`

---

## Phase 15: Patch Management

**Goal:** Container patching with pre-patch snapshots and auto-rollback.

**Files to create:**
```
src/patch/executor.ts        # Patch execution with snapshot/rollback
src/patch/scheduler.ts       # Cron schedule management
src/patch/checker.ts         # Check for pending updates
src/patch/cleanup.ts         # Snapshot expiry cleanup
src/patch/index.ts
src/commands/patch.ts        # CLI command definitions
```

**Deliverables:**
- `proxypilot lxc patch` — snapshot → apt upgrade → health check → rollback if unhealthy.
- `proxypilot lxc patch-all` — batch with sequential/parallel options.
- `proxypilot lxc outdated` — check for pending security updates in all containers.
- `proxypilot lxc patch-schedule` — cron-based scheduling with configurable snapshot retention.
- Snapshot auto-cleanup timer: delete expired pre-patch snapshots.
- All operations write audit log entries.

**Spec references:** "Container Patch Scheduling" section, snapshot_expiry and patch_schedules schemas.

**Verification:**
- [ ] `proxypilot lxc patch myapp` creates snapshot, runs upgrade, health checks
- [ ] Healthy after patch: snapshot marked for auto-delete
- [ ] Unhealthy after patch: auto-rollback to snapshot, alert logged
- [ ] `proxypilot lxc outdated` lists containers with pending updates
- [ ] `proxypilot lxc patch-schedule` creates schedule, timer registered
- [ ] Expired snapshots auto-deleted by cleanup timer
- [ ] All operations produce audit log entries

**Commit:** `phase-15: patch-management - patching with snapshot rollback`

---

## Phase 16: Compliance Checker

**Goal:** Automated SOC 2 + HIPAA control verification against live system state.

**Files to create:**
```
src/compliance/checker.ts       # Control verification engine
src/compliance/controls-soc2.ts # SOC 2 control definitions + checks
src/compliance/controls-hipaa.ts# HIPAA control definitions + checks
src/compliance/baa.ts           # BAA tracker CRUD
src/compliance/classification.ts# Data classification tagging
src/compliance/index.ts
src/commands/compliance.ts      # CLI command definitions
```

**Deliverables:**
- `proxypilot compliance check [--framework soc2|hipaa|all]` — walks every control, checks live state, prints pass/fail with actionable fix commands.
- SOC 2 controls: CC6.1 (access), CC6.5 (encryption), CC7.1 (monitoring), CC7.3-7.4 (incident response), CC8.1 (change management), A1.1 (availability).
- HIPAA controls: §164.308 (risk assessment, workforce, training, incident response), §164.312 (encryption, audit, authentication, transmission).
- Results stored in `compliance_checks` table. `proxypilot compliance history`.
- `proxypilot-compliance.timer` (weekly, Compliant profile).
- `proxypilot compliance baa add/list/review` — BAA tracker.
- `proxypilot lxc tag` / `proxypilot db tag` — data classification.
- All operations write audit log entries.

**Spec references:** "Compliance Checker" section (all control lists), "BAA Tracker", "Data Classification", compliance_checks/baa_tracker/resource_classifications schemas.

**Verification:**
- [ ] `proxypilot compliance check` runs all controls, produces pass/fail output
- [ ] Intentionally break a control (e.g., disable pgAudit) → check detects failure with fix command
- [ ] Fix the control → check passes again
- [ ] Results stored in compliance_checks table
- [ ] `proxypilot compliance history` shows past results
- [ ] BAA add/list/review works
- [ ] Classification tagging works and affects compliance check strictness
- [ ] Weekly timer installed for Compliant profile

**Commit:** `phase-16: compliance-checker - soc2 and hipaa control verification`

---

## Phase 17: Documentation Generator

**Goal:** Auto-generate compliance documentation from live system state.

**Files to create:**
```
src/compliance/docs-generator.ts  # Document generation from live state
src/compliance/templates/         # Markdown templates with {{placeholders}}
  system-security-plan.md
  access-control-policy.md
  backup-recovery-plan.md
  audit-log-summary.md
  vulnerability-management.md
  network-security.md
  certificate-inventory.md
  incident-response-plan.md
  risk-assessment.md
  data-classification-policy.md
  baa-tracker.md
  breach-notification.md
```

**Deliverables:**
- `proxypilot compliance docs [--framework soc2|hipaa|all] [--format md|pdf|docx]`.
- 12 document templates filled from live queries (SQLite, Postgres audit, Caddy API, Incus API, system state).
- Markdown output always available. PDF via Pandoc + LaTeX/weasyprint. DOCX via Pandoc.
- Output to `/var/lib/proxypilot/compliance/YYYY-MM-DD/`. Previous generations retained.
- Graceful fallback: if Pandoc not installed and PDF/DOCX requested, print install instructions, generate Markdown.

**Spec references:** "Documentation Generator" section, document list table, output location.

**Verification:**
- [ ] `proxypilot compliance docs --format md` generates all 12 documents
- [ ] Documents contain actual data from the system (not just template placeholders)
- [ ] `--format pdf` generates PDFs (if Pandoc installed)
- [ ] `--format docx` generates DOCX files (if Pandoc installed)
- [ ] Previous generation directories are retained
- [ ] Missing Pandoc prints install instructions, falls back to Markdown

**Commit:** `phase-17: docs-generator - compliance documentation from live state`

---

## Phase 18: Observability Stack

**Goal:** Optional Grafana + Loki + Alloy for dashboards, log search, and alerting.

**Files to create:**
```
src/observability/loki.ts        # Loki config generation
src/observability/alloy.ts       # Alloy config with auto-discovered log targets
src/observability/grafana.ts     # Grafana config, datasource/dashboard provisioning
src/observability/alerts.ts      # Grafana alert rule provisioning
src/observability/dashboard.json # Default ProxyPilot dashboard
src/observability/index.ts
src/commands/observability.ts    # CLI command definitions
```

**Deliverables:**
- Loki: config with tsdb_shipper, filesystem storage, profile-aware retention (30 days default, 365 days Compliant). Localhost only.
- Alloy: auto-configured to tail all ProxyPilot log sources (audit, Caddy, sshd, CrowdSec, PgBouncer, PostgreSQL, nftables, AIDE, Infisical) with structured labels.
- Grafana: config, Loki datasource provisioning, default dashboard (6 panels: overview, security, access, traffic, audit, database), alert rules (10 pre-configured alerts).
- Caddy route for Grafana: `--vpn-only` if WireGuard enabled, `--middleware basic-auth` otherwise. Never exposed without access control.
- Grafana admin password in Infisical.
- `proxypilot observability status/logs/dashboard-url` commands.
- All services managed via systemd. All commands gracefully handle "not installed" state.

**Spec references:** "Observability Stack" section (all subsections), Loki config, Alloy label strategy, Grafana dashboard panels, alert rules table.

**Verification:**
- [ ] Loki starts, ready endpoint returns 200
- [ ] Alloy starts, all targets showing active
- [ ] Grafana starts, health endpoint returns ok
- [ ] Grafana accessible via VPN (or basic auth) — not publicly
- [ ] Default dashboard renders with real data
- [ ] `proxypilot observability logs --job caddy_access --since 1h` returns results
- [ ] Alert rules present in Grafana
- [ ] `proxypilot observability status` shows all three services
- [ ] Without observability installed: `proxypilot observability status` prints install suggestion, does not error

**Commit:** `phase-18: observability - grafana, loki, alloy dashboards and alerting`

---

## Phase 19: Init Orchestrator

**Goal:** `proxypilot init` ties every phase into a single profile-based bootstrap command.

**Files to create/update:**
```
src/commands/init.ts         # Full proxypilot init command
src/commands/status.ts       # Updated proxypilot status with all subsystems
```

**Deliverables:**
- Interactive profile selection (Standard / Hardened / Compliant / Custom).
- Non-interactive mode (`--profile`, `--admin`, `--config`, `--with-observability`, `--non-interactive`).
- `--dry-run` prints everything without executing.
- Full bootstrap sequence (22 steps from spec) calling all Phase 1-18 functions in order.
- Each step checks current state before acting (idempotent).
- SSH safe transition with interactive confirmation (or programmatic verification in non-interactive mode).
- Summary printout at the end: all services, databases, networking, access, security, backups, timers, next steps.
- `proxypilot status` updated to show unified view of every subsystem.
- `proxypilot core status/restart/logs` commands.
- Audit log entry for the init itself.

**Spec references:** "Installation Profiles" section, "Bootstrap Sequence" full step list, init flags, summary printout format.

**Verification:**
- [ ] `proxypilot init --profile standard` on clean host: all core services running
- [ ] `proxypilot init --profile hardened` on clean host: core + SSH + VPN + CrowdSec + AIDE + hardening
- [ ] `proxypilot init --profile compliant` on clean host: everything
- [ ] `proxypilot init --profile compliant --with-observability`: everything + Grafana/Loki/Alloy
- [ ] Re-running `proxypilot init` skips already-configured steps
- [ ] `--dry-run` prints plan without executing
- [ ] `--non-interactive` works without operator prompts
- [ ] `proxypilot status` shows unified overview of all subsystems
- [ ] `proxypilot core status` shows all core service states
- [ ] Full end-to-end: init → create container with database → verify route, TLS, database, secrets, firewall, audit trail

**Commit:** `phase-19: init-orchestrator - proxypilot init with profile-based bootstrap`

---

## Recommended Execution Order

Phases are ordered by dependency and value delivery:

```
Phase 1:  Foundation (everything depends on this)
Phase 2:  PostgreSQL + PgBouncer
Phase 3:  Valkey
Phase 4:  Infisical + Bootstrap
Phase 5:  pgBackRest
Phase 6:  DNS-over-TLS
          ─── At this point: core services running, secrets managed, backups active ───
Phase 7:  Audit Logging
Phase 8:  Database Management
          ─── At this point: proxypilot db create works, full workload lifecycle ───
Phase 9:  SSH Hardening
Phase 10: WireGuard VPN
Phase 11: CrowdSec
Phase 12: AIDE
Phase 13: Host Hardening
          ─── At this point: Hardened profile fully functional ───
Phase 14: Audit Sync + History
Phase 15: Patch Management
Phase 16: Compliance Checker
Phase 17: Documentation Generator
          ─── At this point: Compliant profile fully functional ───
Phase 18: Observability
Phase 19: Init Orchestrator
          ─── At this point: proxypilot init works end-to-end ───
```

Phases 6 can be done any time after Phase 1 (no dependencies). Phases 11-13 can be done in any order relative to each other. Phases 16-17 must be sequential (docs depend on checker). Phase 19 is last because it orchestrates everything.
