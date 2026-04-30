<!-- Split from proxypilot-core-phased-plan.md (lines 203-227) -->
<!-- Index: docs/core/plan/README.md -->

> **Note (2026-04-30):** The nftables placeholder originally listed for
> Phase 8 (`src/core/nftables.ts`) is **superseded by the Firewall Manager
> upgrade**. See `proxypilot-firewall-vpn-ssh-prompt.md` (`## Firewall
> Manager`) and `docs/core/plan/phase-08b-firewall-manager.md`. The
> firewall manager is shipped as steps 1–4 of that upgrade and includes
> a default-deny `inet/proxypilot` table, listener discovery (host +
> LXC + Docker + Caddy-L4), per-rule toggles, panic-close, container
> egress, and systemd-driven reconcile + discovery timers. DNS-over-TLS
> itself is unchanged from this phase doc.

## Phase 8: DNS-over-TLS

**Goal:** Encrypted DNS for every ProxyPilot host.

**Files to create:**
```
src/core/dns.ts              # resolved.conf generation, restart, verify
```

**Deliverables:**
- Write `/etc/systemd/resolved.conf` with Cloudflare + Quad9 DNS, DNSSEC + DNSOverTLS.
- Restart `systemd-resolved`, verify with `resolvectl status`.
- Idempotent: skip if already configured, don't overwrite operator changes.

**Spec references:** "DNS-over-TLS" section.

**Verification:**
- [ ] `resolvectl status` shows `DNSOverTLS: yes`
- [ ] DNS queries resolve correctly
- [ ] Re-running does not overwrite if already configured

**Commit:** `phase-08: dns-over-tls - encrypted dns`

---

## Function-by-Function Checklist (to be populated)

> This section is a placeholder. The next planning session will decompose the phase deliverables into a per-function checklist: one function → implement → test → check off → move on. Each function gets its own line with a checkbox, the file it lives in, and a one-line success criterion. Do not populate this now — leave the placeholder in place.

- [ ] _pending_
