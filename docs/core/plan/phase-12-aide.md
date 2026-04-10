<!-- Split from proxypilot-core-phased-plan.md (lines 405-438) -->
<!-- Index: docs/core/plan/README.md -->

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

## Function-by-Function Checklist (to be populated)

> This section is a placeholder. The next planning session will decompose the phase deliverables into a per-function checklist: one function → implement → test → check off → move on. Each function gets its own line with a checkbox, the file it lives in, and a one-line success criterion. Do not populate this now — leave the placeholder in place.

- [ ] _pending_
