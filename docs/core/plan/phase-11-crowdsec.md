<!-- Split from proxypilot-core-phased-plan.md (lines 375-404) -->
<!-- Index: docs/core/plan/README.md -->

## Phase 11: CrowdSec

**Goal:** Threat detection with Caddy and SSH bouncers.

**Files to create:**
```
src/core/crowdsec.ts         # Engine config, bouncer registration
src/commands/security.ts     # CLI command definitions (shared with AIDE in Phase 12)
```

**Deliverables:**
- CrowdSec engine configuration.
- Register Caddy bouncer + SSH bouncer.
- `proxypilot security bans [--list]` and `proxypilot security alerts [--since X]`.
- CrowdSec status integrated into `proxypilot core status`.
- All operations write audit log entries.

**Spec references:** "CrowdSec" section.

**Verification:**
- [ ] CrowdSec engine running
- [ ] `cscli bouncers list` shows Caddy + SSH bouncers active
- [ ] `proxypilot security bans` works (may show empty list)
- [ ] `proxypilot core status` includes CrowdSec state
- [ ] Simulated SSH brute force triggers a ban

**Commit:** `phase-11: crowdsec - threat detection with caddy and ssh bouncers`

---

## Function-by-Function Checklist (to be populated)

> This section is a placeholder. The next planning session will decompose the phase deliverables into a per-function checklist: one function → implement → test → check off → move on. Each function gets its own line with a checkbox, the file it lives in, and a one-line success criterion. Do not populate this now — leave the placeholder in place.

- [ ] _pending_
