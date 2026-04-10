<!-- Split from proxypilot-core-phased-plan.md (lines 504-540) -->
<!-- Index: docs/core/plan/README.md -->

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

## Function-by-Function Checklist (to be populated)

> This section is a placeholder. The next planning session will decompose the phase deliverables into a per-function checklist: one function → implement → test → check off → move on. Each function gets its own line with a checkbox, the file it lives in, and a one-line success criterion. Do not populate this now — leave the placeholder in place.

- [ ] _pending_
