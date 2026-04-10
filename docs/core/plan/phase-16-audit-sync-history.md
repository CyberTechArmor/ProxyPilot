<!-- Split from proxypilot-core-phased-plan.md (lines 467-503) -->
<!-- Index: docs/core/plan/README.md -->

## Phase 16: Audit Postgres Sync + History Tracking

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

**Commit:** `phase-16: audit-sync-history - postgres sync, ssh/db/cert tracking`

---

## Function-by-Function Checklist (to be populated)

> This section is a placeholder. The next planning session will decompose the phase deliverables into a per-function checklist: one function → implement → test → check off → move on. Each function gets its own line with a checkbox, the file it lives in, and a one-line success criterion. Do not populate this now — leave the placeholder in place.

- [ ] _pending_
