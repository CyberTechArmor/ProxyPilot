<!-- Split from proxypilot-core-phased-plan.md (lines 666-705) -->
<!-- Index: docs/core/plan/README.md -->

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

## Function-by-Function Checklist (to be populated)

> This section is a placeholder. The next planning session will decompose the phase deliverables into a per-function checklist: one function → implement → test → check off → move on. Each function gets its own line with a checkbox, the file it lives in, and a one-line success criterion. Do not populate this now — leave the placeholder in place.

- [ ] _pending_
