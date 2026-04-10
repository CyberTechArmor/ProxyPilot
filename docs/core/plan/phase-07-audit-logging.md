<!-- Split from proxypilot-core-phased-plan.md (lines 228-260) -->
<!-- Index: docs/core/plan/README.md -->

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

## Function-by-Function Checklist (to be populated)

> This section is a placeholder. The next planning session will decompose the phase deliverables into a per-function checklist: one function → implement → test → check off → move on. Each function gets its own line with a checkbox, the file it lives in, and a one-line success criterion. Do not populate this now — leave the placeholder in place.

- [ ] _pending_
