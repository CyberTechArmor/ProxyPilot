# Master spec — ProxyPilot security completion

This is the running spec for closing every security gap between
"hardening branch shipped" and "honest production-ready single-tenant."
Sessions consult this file to find the next unticked phase, do that
phase, mark it ✅, commit, push, stop. Operator gates between phases.

## Status legend

* ✅ Done + verified by operator on disposable VM (or production where noted)
* 🟡 In progress
* ⏳ Pending
* 🚫 Blocked (with reason)

## Phases

| # | Phase | Status |
|---|---|---|
| 0 | Revert broken docker-compose security_opt → restore working dashboard | ⏳ |
| A | Host-side agent: design + scaffold | ⏳ |
| B | Host-side agent: Caddy methods | ⏳ |
| C | Host-side agent: Incus methods | ⏳ |
| D | Host-side agent: Docker methods | ⏳ |
| E | Host-side agent: misc methods (git / npm / systemd) | ⏳ |
| F | Drop `privileged: true` — switch container to unprivileged | ⏳ |
| G | Agent hardening + audit log + rate limiting | ⏳ |
| H | Backup automation (DB + secrets + Caddy state) | ⏳ |
| I | External monitoring + paging | ⏳ |
| J | Account lockout per-user | ⏳ |
| K | Sudo-mode — fresh TOTP for destructive ops | ⏳ |
| L | Inactivity timeout + sliding sessions | ⏳ |
| M | JWT revocation via DB-backed denylist | ⏳ |
| N | TOTP_ENCRYPTION_KEY rotation tooling | ⏳ |
| O | JWT_SECRET rotation with old-key fallback | ⏳ |
| P | Password breach check (HIBP k-anonymity) | ⏳ |
| Q | Audit log integrity (hash chain) | ⏳ |
| R | Real e2e deploy CI on a disposable VM | ⏳ |

After R is ✅: the security work for honest production go-live is complete.

---

## Phase 0 — Restore working dashboard (mandatory first)

**Goal.** Revert today's broken docker-compose.yml security_opt changes
back to `privileged: true`. The dashboard at lxc.fractionate.ai
currently fails on every host-shell operation (Add Service, Incus
page, Caddy reload). The operator authorized: "if it's easier, the
last commit prior to today actually worked."

**Files to edit.**
* `install.sh` — `create_docker_compose()` security block
* `update.sh` — replace today's apparmor:unconfined patch with a
  full revert-to-privileged migration
* `docs/features/security-completion/master-spec.md` — flip Phase 0 to ✅

**Deliverables.**

* `install.sh` writes a docker-compose.yml block of:
  ```yaml
  privileged: true
  pid: host
  ```
  (no cap_drop, no cap_add, no security_opt).
* `update.sh` detects the broken `cap_drop:` / `cap_add:` /
  `security_opt:` blocks in deployed `/opt/proxypilot/docker-compose.yml`
  and replaces them with `privileged: true`. Idempotent: if
  `privileged: true` is already present, skip.
* In-line comment in install.sh updated to read:
  > privileged: true is the working baseline. The cap_drop attempts
  > broke nsenter under multiple combinations. The real fix is the
  > host-side agent — see docs/features/security-completion/

**Acceptance tests** (operator runs against lxc.fractionate.ai):

- [ ] 0.V1 — `cd /root/ProxyPilot && git pull && sudo ./update.sh` completes successfully.
- [ ] 0.V2 — `docker logs proxypilot-admin --tail 30` shows no nsenter errors.
- [ ] 0.V3 — Login + dashboard loads.
- [ ] 0.V4 — Incus page shows real storage / profiles / images data.
- [ ] 0.V5 — Add Service → Static Site → succeeds, Caddy reloads cleanly.
- [ ] 0.V6 — New domain serves over HTTPS via Caddy.

**Commits.**

```
revert(b1): restore privileged:true — cap_drop approach broke nsenter
fix(update): in-place migration to revert installs back to privileged:true
docs(spec): mark Phase 0 ✅
```

When all 6 acceptance tests pass, the operator confirms in chat,
and the session marks Phase 0 ✅ and proceeds to Phase A in the
same session if context allows, OR stops cleanly so the next session
picks up Phase A from the spec.
