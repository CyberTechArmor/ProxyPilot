<!-- Split from proxypilot-core-phased-plan.md (lines 117-141) -->
<!-- Index: docs/core/plan/README.md -->

## Phase 3: Valkey

**Goal:** Cache/queue service for Infisical.

**Files to create:**
```
src/core/valkey.ts           # Config generation, service management
```

**Deliverables:**
- Generate `valkey.conf` (localhost only, requirepass, 256MB max, no persistence).
- Generate and install `proxypilot-valkey.service`.
- Verify function: AUTH + PING.

**Spec references:** "Valkey Configuration" section.

**Verification:**
- [ ] Valkey starts via systemd
- [ ] Can AUTH with generated password and PING
- [ ] Not accessible from bridge network (localhost only)

**Commit:** `phase-03: valkey - cache service for infisical`

---

## Function-by-Function Checklist (to be populated)

> This section is a placeholder. The next planning session will decompose the phase deliverables into a per-function checklist: one function → implement → test → check off → move on. Each function gets its own line with a checkbox, the file it lives in, and a one-line success criterion. Do not populate this now — leave the placeholder in place.

- [ ] _pending_
