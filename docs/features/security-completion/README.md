# Security completion — ProxyPilot production go-live

This directory plans every remaining security item between "where the
hardening branch left ProxyPilot" and "honest production-ready for
single-tenant use." One running spec, one master kickoff prompt:

| File | Purpose |
|---|---|
| **`master-prompt.md`** | **The single entry point.** Copy-paste into a fresh Claude Code session. The session reads the spec, finds the next unticked phase (0 → A-G → H-R), does it, marks it ✅, stops. Re-paste the same prompt into a new session to continue. |
| **`master-spec.md`** | The running spec covering Phases 0 + A-R: file lists, deliverables, acceptance tests, commit message templates. Sessions update the status column as phases complete. The single source of truth — every prompt consults it. |
| `restore-dashboard-prompt.md` | (Superseded by `master-prompt.md`.) Standalone kickoff for just Phase 0. Kept for reference; new sessions should use `master-prompt.md` which covers Phase 0 + everything after. |
| `host-side-agent-prompt.md` | (Superseded by `master-prompt.md`.) Standalone kickoff for just Phases A-G. Kept for reference. |

## Why this directory exists

The hardening branch (PRs #131-#133) shipped real security progress:

* B5 — TOTP secrets encrypted at rest (AES-256-GCM)
* B4 — JWT moved to httpOnly cookies + double-submit CSRF
* B3 — DB file perms + data-dir lockdown
* B6 — D.14 admin-domain regression patched
* U1 — Pre-update DB backup + auto-restore on failure
* U2 — Versioned migrations table with FK-safe rebuilds (B2)
* U4 — `.env.example` diff + auto-generate of secret keys
* U5 — Operator-extension Caddy snippets directory
* CSP re-enabled with strict directives
* CORS HTTPS-only in production
* Per-route body limits (1mb default, 55mb on uploads)
* Rate limiting on every unauth endpoint
* Cookie-based session + CSRF middleware
* HSTS in production

These all merged and stuck. Then the **B1 attempt** (replacing
`privileged: true` with cap_drop + cap_add) hit unforeseen issues:

1. Docker's default AppArmor profile blocked `/proc/$pid/ns/*` access.
2. Even after `apparmor:unconfined` was added, `setns()` into the
   mount namespace still failed with "Operation not permitted" —
   cause not fully diagnosed (suspected combination of seccomp
   profile, user-namespace boundary, and ambient capabilities, but
   chasing it further would have prolonged the dashboard outage).
3. Five regressions accumulated during the chase: env-pollution,
   Caddy `*` glob, CSRF mount-prefix, QR external-image, and the
   admin-service seed referencing dropped columns.

The user's verdict: "if it's easier, the last commit prior to today
actually worked." The honest answer is yes — the cap-drop approach
has more friction than a one-session fix can resolve, and reverting
to `privileged: true` while planning the real architectural fix is
the right call.

## What "real B1 fix" means

The fundamental issue: ProxyPilot's container reaches host root via
`nsenter -t 1`. Whether or not we drop `privileged: true`, the
container's threat model is "if compromised, the attacker is one
nsenter call away from owning the host."

The only architecture that breaks that link is a **host-side agent**:

```
┌─────────────┐         ┌──────────────────────────┐
│  ProxyPilot │  RPC    │  proxypilot-agent        │
│  (container)│◄───────►│  (host systemd service)  │
└─────────────┘ unix    └──────────────────────────┘
                socket            │
                                  │ direct exec, no nsenter
                                  ▼
                  caddy / incus / docker / git / npm
```

* The agent runs on the host as a dedicated user.
* It listens on a Unix socket with mode 0660, owned by `proxypilot-agent:proxypilot-agent`.
* The container is in the `proxypilot-agent` group; the socket is bind-mounted in.
* The agent exposes a **narrow, validated RPC protocol**: explicit methods
  like `caddy.reload`, `incus.exec(name, command)`, `docker.compose.up(dir)`.
  Each method has hard input validation. There is **no** "run arbitrary
  shell" method.
* The container can drop `privileged: true`, `pid: host`, and the Docker
  socket mount entirely.
* Container compromise → can talk to agent → bounded by what the agent's
  protocol allows. Cannot break out into arbitrary host commands.

This is `host-side-agent-prompt.md`. It's a 4-6 week build with seven
phases (A-G). Each phase has a strict operator gate: the operator
verifies acceptance tests on a disposable VM before the next session
proceeds.

## What's still left BESIDES B1 for production go-live

These are the items I called out as "should-have for production" in
the prior assessment. They don't depend on the agent — they're
straightforward to land independently. Sequencing is rough priority
for "honest production-ready":

| Item | Effort | Why it matters |
|---|---|---|
| **DB + secrets backup automation** | half day | Pre-update snapshots only protect against bad updates. Disk failure = total loss without a cron-driven dump + offsite sync. Pre-Phase-7 minimum: `sqlite3 .backup` to `/var/backups/`, weekly rsync to a remote. |
| **External monitoring + paging** | 1 hour | `/api/health` exists; nothing watches it. Hook UptimeRobot or Healthchecks.io. Pre-Phase-20 minimum. |
| **JWT revocation via shared denylist** | 2-3 days (depends on Phase 5 Valkey) | Logout currently is browser-side only. Server can't revoke a leaked token short of rotating JWT_SECRET (logs everyone out). |
| **Account lockout per-user** | 1 day | Today's rate limiter is per-IP — attacker rotating IPs sees no lockout. Add `users.failed_attempts` + cooldown. |
| **Sudo-mode for sensitive ops** | 2 days | Once you've cleared TOTP at login, you stay authenticated 24h for ANYTHING — including delete-all-services. Should require fresh TOTP for destructive operations. |
| **Inactivity timeout + sliding sessions** | 1 day | JWTs are 24h hard. Sliding refresh window with 30-min inactivity timeout would tighten the leak window. |
| **TOTP_ENCRYPTION_KEY rotation tooling** | 1 day | Today: lose the key = all users re-enroll. Need an admin command that re-encrypts every row under a new key. |
| **JWT_SECRET rotation with old-key fallback** | 1 day | Same idea — rotate without invalidating live sessions. |
| **Password breach check (HIBP k-anonymity)** | half day | The 12-char minimum doesn't catch reused leaked passwords. |
| **Audit log integrity (hash chain)** | 3-4 days | Phase 9 territory. An attacker with DB write can edit the audit trail today. |
| **Real e2e deploy CI** | 2-3 days | A disposable Debian VM that gets `install.sh` run + a puppeteer flow that creates a service / opens a terminal / verifies Caddy reload. Would have caught all five regressions on this branch on the first push. |

## Recommended sequencing for the operator

After the dashboard is restored (`restore-dashboard-prompt.md`):

1. **TODAY: backup automation + uptime check.** Five minutes each. Removes the two largest single-points-of-failure.
2. **THIS WEEK: account lockout + sudo-mode.** Cheap, high-impact.
3. **NEXT WEEK: kick off the host-side agent (Phase A).** This is the long road. Don't block other work on it.
4. **WHILE AGENT PROGRESSES: JWT revocation, TOTP key rotation, password breach check.** Independent, can land in parallel with agent phases.
5. **AFTER AGENT PHASE F:** B1 is closed. Update the production-readiness statement to drop the privileged-container caveat.
6. **AFTER AGENT PHASE G + audit-log integrity:** Honest production-ready statement is reachable.

## How to interpret current production state

ProxyPilot today is **suitable for self-hosted single-operator use**. The
control plane runs in a privileged-equivalent container, which is fine
when the only authenticated user is the operator themselves. It is
**not** suitable for:

* Exposing the dashboard URL to less-trusted operators (until per-user
  RBAC + sudo-mode + the agent rewrite).
* Multi-tenant SaaS (out of scope per operator).
* Compliance attestation (Phase 18 + audit-log integrity required).
* Any deployment where "container compromise = host root" is unacceptable
  in the threat model.

For everything between "homelab" and "production traffic for a small
team you trust," this is what production-ready looks like once the
restore-dashboard work is merged. The agent rewrite raises the
ceiling on who you can grant dashboard access to.

## Status tracker

Live status lives in `master-spec.md` — the table at the top of that
file is the canonical view. Don't duplicate it here.

Right now (before any phase has run):

* Phase 0 — Restore working dashboard — ⏳
* Phases A-G — Host-side agent (B1 real fix) — ⏳
* Phases H-R — Backups, monitoring, lockout, sudo-mode, sliding sessions, JWT revocation, key rotation, password breach check, audit log integrity, e2e CI — ⏳

After Phase R: every production-blocking caveat is closed.

## How to start

1. Open a fresh Claude Code session.
2. Open `master-prompt.md`, copy the fenced block (between the triple-backticks), paste as the first message.
3. The session does Phase 0 first (mandatory — the dashboard is currently down). Operator runs the acceptance tests on production.
4. After confirmation, the session marks Phase 0 ✅. Operator merges.
5. Open a new session, paste the same prompt. Session sees Phase 0 ✅ in the spec and starts Phase A.
6. Repeat through Phase R.

Per-phase wall-clock: 1-3 sessions of session-work + 1-3 days of operator deploy/test cadence. End-to-end: 5-12 weeks. The discipline of the operator gate is what protects against the kind of regression cluster that bit the prior branch.
