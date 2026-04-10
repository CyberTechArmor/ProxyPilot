<!-- Split from proxypilot-core-phased-plan.md (lines 86-116) -->
<!-- Index: docs/core/plan/README.md -->

## Phase 4: PostgreSQL + PgBouncer

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

**Commit:** `phase-04: postgresql + pgbouncer - core database with connection pooling`

---

## Function-by-Function Checklist (to be populated)

> This section is a placeholder. The next planning session will decompose the phase deliverables into a per-function checklist: one function → implement → test → check off → move on. Each function gets its own line with a checkbox, the file it lives in, and a one-line success criterion. Do not populate this now — leave the placeholder in place.

- [ ] _pending_
