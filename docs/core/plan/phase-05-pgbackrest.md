<!-- Split from proxypilot-core-phased-plan.md (lines 173-202) -->
<!-- Index: docs/core/plan/README.md -->

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

## Function-by-Function Checklist (to be populated)

> This section is a placeholder. The next planning session will decompose the phase deliverables into a per-function checklist: one function → implement → test → check off → move on. Each function gets its own line with a checkbox, the file it lives in, and a one-line success criterion. Do not populate this now — leave the placeholder in place.

- [ ] _pending_
