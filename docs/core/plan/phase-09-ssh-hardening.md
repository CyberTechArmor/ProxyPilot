<!-- Split from proxypilot-core-phased-plan.md (lines 302-338) -->
<!-- Index: docs/core/plan/README.md -->

## Phase 9: SSH Hardening + Access Management

**Goal:** Per-person SSH access with safe transition sequence.

**Files to create:**
```
src/access/ssh.ts            # SSH hardening, safe transition, sshd config
src/access/users.ts          # Admin account CRUD
src/access/review.ts         # Quarterly access review
src/access/index.ts
src/commands/access.ts       # CLI command definitions
```

**Deliverables:**
- Safe SSH transition sequence: create accounts → install keys → TEST → confirm → harden sshd → reload → TEST AGAIN → confirm. Revert on failure.
- `proxypilot access add/remove/list` — system user management with SSH keys, sshd AllowUsers, audit logging.
- `proxypilot access review` — quarterly review flow for Compliant profile.
- Actor identity: read `$SUDO_USER` for audit log actor field.

**Spec references:** "SSH Access Management" section (all subsections), "Safe Transition Sequence", admin specification.

**⚠️ TEST ON A NON-PRODUCTION MACHINE FIRST.** SSH lockout on a remote host is unrecoverable without console access.

**Verification:**
- [ ] Can create admin account with SSH key
- [ ] New account can SSH in and sudo
- [ ] After hardening: root login disabled, password auth disabled
- [ ] Existing session preserved during sshd reload
- [ ] `proxypilot access list` shows all accounts with last login
- [ ] `proxypilot access remove` locks account, updates AllowUsers, reloads sshd
- [ ] All operations produce audit log entries
- [ ] Revert works if test fails after lockdown

**Commit:** `phase-09: ssh-access - per-person ssh with safe transition`

---

## Function-by-Function Checklist (to be populated)

> This section is a placeholder. The next planning session will decompose the phase deliverables into a per-function checklist: one function → implement → test → check off → move on. Each function gets its own line with a checkbox, the file it lives in, and a one-line success criterion. Do not populate this now — leave the placeholder in place.

- [ ] _pending_
