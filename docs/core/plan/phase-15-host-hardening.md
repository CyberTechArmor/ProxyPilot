<!-- Split from proxypilot-core-phased-plan.md (lines 439-466) -->
<!-- Index: docs/core/plan/README.md -->

## Phase 15: Host Hardening

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

**Commit:** `phase-15: host-hardening - sysctl, auto-updates, incus acls`

---

## Function-by-Function Checklist (to be populated)

> This section is a placeholder. The next planning session will decompose the phase deliverables into a per-function checklist: one function → implement → test → check off → move on. Each function gets its own line with a checkbox, the file it lives in, and a one-line success criterion. Do not populate this now — leave the placeholder in place.

- [ ] _pending_
