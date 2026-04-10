<!-- Split from proxypilot-core-phased-plan.md (lines 261-301) -->
<!-- Index: docs/core/plan/README.md -->

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

## Function-by-Function Checklist (to be populated)

> This section is a placeholder. The next planning session will decompose the phase deliverables into a per-function checklist: one function → implement → test → check off → move on. Each function gets its own line with a checkbox, the file it lives in, and a one-line success criterion. Do not populate this now — leave the placeholder in place.

- [ ] _pending_
