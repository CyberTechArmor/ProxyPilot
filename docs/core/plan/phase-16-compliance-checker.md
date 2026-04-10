<!-- Split from proxypilot-core-phased-plan.md (lines 541-581) -->
<!-- Index: docs/core/plan/README.md -->

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

## Function-by-Function Checklist (to be populated)

> This section is a placeholder. The next planning session will decompose the phase deliverables into a per-function checklist: one function → implement → test → check off → move on. Each function gets its own line with a checkbox, the file it lives in, and a one-line success criterion. Do not populate this now — leave the placeholder in place.

- [ ] _pending_
