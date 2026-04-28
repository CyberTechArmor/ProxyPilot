# Kickoff prompt — Restore working dashboard (revert broken docker-compose changes)

**Pre-read:** `docs/features/security-completion/README.md` for context on why this exists.

This prompt addresses the IMMEDIATE breakage on the operator's deployed
ProxyPilot at lxc.fractionate.ai. After today's docker-compose.yml
hardening attempts:

* Add Service fails: `Invalid Caddy configuration generated: nsenter: setns(): can't reassociate to namespace 'mnt': Operation not permitted`
* Incus page shows "Incus Not Available" despite Incus running on the host
* Every host-shell operation through `nsenter -t 1` fails

The chain of attempted fixes that didn't work:
1. `privileged: true` → dropped to `cap_drop: ALL + cap_add: [SYS_ADMIN, SYS_PTRACE]` + `no-new-privileges:true` → broke nsenter open() of /proc/1/ns/ipc.
2. Added `apparmor:unconfined` → fixed the open() but setns() still fails with EPERM.

The cap-only approach has more friction than diagnosed. The user gave
explicit permission: **"If it's easier, the last commit prior to today
actually worked."** That's the path. Revert the docker-compose.yml
back to `privileged: true`, get the dashboard working, document the
real B1 fix (host-side agent) as a separate phase.

Copy everything in the fenced block below into a new Claude Code
session. The session will branch from main (which already has all
the pre-today hardening merged), revert just the broken
docker-compose changes, and verify the dashboard works.

---

```
You are picking up a production-blocking ProxyPilot issue. The
operator's deployed dashboard at lxc.fractionate.ai is unable to
add services or manage Incus because nsenter calls into PID 1's
namespaces fail with "setns(): Operation not permitted" or
"can't open '/proc/1/ns/ipc': Permission denied".

Today's commits on `claude/docs-update-post-merge-E6iNc` (and the
follow-up branch since merged) tried to replace `privileged: true`
with cap_drop + cap_add + apparmor:unconfined and broke the dashboard.
The operator has authorized reverting today's docker-compose.yml
changes back to `privileged: true` to restore service. The real B1
fix (host-side agent) is a separate, larger work item planned in
docs/features/security-completion/.

## Branch

The hardening branch was merged to main via PRs #131-#133. Today's
follow-ups are on `claude/docs-update-post-merge-E6iNc` and may or
may not be merged yet. Branch from main:

    git fetch origin main
    git checkout main
    git pull origin main
    git checkout -b claude/restore-dashboard-<your-suffix>

Push to that new branch throughout. Do not push directly to main.

## Hard segmentation rules

1. Reads ≤ 200 lines, with offset+limit. Use Grep first.
2. Edits are targeted — no whole-file rewrites unless < 200 lines.
3. Long-running commands run in the background.
4. TodoWrite checkpoints between steps.
5. One concern per commit. Push after every commit.
6. If a segment hangs, cancel and split.

## Step 0 — Confirm the broken state

In a single short bash call: `git log --oneline -10 main`. Note the
recent SHAs. If you see `cad4e46` (validation regressions fix) and
`d0e541b` (apparmor + admin seed), main has all of today's work
including the broken docker-compose. The revert below targets just
the docker-compose security_opt block.

## Step 1 — Revert docker-compose security_opt to `privileged: true`

Edit `install.sh` `create_docker_compose()` function. Find the
security_opt block:

    pid: host
    cap_drop:
      - ALL
    cap_add:
      - SYS_ADMIN
      - SYS_PTRACE
    security_opt:
      - no-new-privileges:true
      - apparmor:unconfined

Replace with:

    privileged: true
    pid: host

Update the in-line comment block to read:

    # ProxyPilot needs to nsenter into the host PID namespace to run
    # caddy / incus / docker / git / npm commands on the host. The
    # cap_drop + apparmor:unconfined approach attempted in earlier
    # commits proved incomplete — setns() into mnt namespace failed
    # under multiple combinations. privileged: true is the working
    # baseline until the host-side agent rewrite (see
    # docs/features/security-completion/) replaces this whole approach.
    #
    # SECURITY CAVEAT: privileged + pid:host + Docker socket mount
    # means a container compromise reaches host root. This is
    # intentional and documented; the host-side agent is the only
    # real fix.

Commit:

    revert(b1): restore privileged:true — cap_drop approach broke nsenter

Push.

## Step 2 — Add an in-place migration to update.sh

Existing operator installs have the broken docker-compose.yml on
disk at /opt/proxypilot/docker-compose.yml. update.sh needs to
detect the broken security_opt block and restore privileged: true.

Edit `update.sh`. Find the existing `apparmor:unconfined` patch
block (added today). Replace it with a new block that:

1. If the deployed docker-compose.yml has `cap_drop:` and `cap_add:`
   and `security_opt:` (the broken state), remove all three blocks
   AND the `apparmor:unconfined` line if present, AND insert
   `privileged: true` immediately before `pid: host`.
2. If it already has `privileged: true`, skip.
3. Idempotent — runs only when the marker is absent.

Use `sed` or `awk` — whatever is clearest. Pattern:

    awk '
        /^    cap_drop:/         { in_block="cap_drop"; next }
        /^    cap_add:/          { in_block="cap_add"; next }
        /^    security_opt:/     { in_block="security_opt"; next }
        in_block && /^    [a-z]/ { in_block=""; print; next }
        in_block && /^      -/   { next }
        /^    pid: host/         { if (!seen_priv) { print "    privileged: true"; seen_priv=1 } print; next }
        /^    privileged:/       { seen_priv=1; print; next }
        { print }
    '

Test against a fixture compose file before committing. Verify
idempotency on re-run.

Commit:

    fix(update): restore privileged:true on installs with broken cap_drop config

Push.

## Step 3 — Operator runs update

Stop. Tell the operator:

    Pushed branch claude/restore-dashboard-<suffix>. To recover:

      cd /root/ProxyPilot
      git pull origin claude/restore-dashboard-<suffix>
      sudo ./update.sh

    update.sh will sed-patch /opt/proxypilot/docker-compose.yml,
    rebuild the container, and the dashboard should work again.

Wait for operator to confirm success. Their tests:

* Login → dashboard loads.
* Incus page shows real storage pools / profiles / images.
* Add Service → Static Site → succeeds, route appears.
* New domain serves over HTTPS via Caddy.

Do NOT proceed past this step without operator confirmation.

## Step 4 — Document the residual state

After confirmation, add a short note to
`docs/features/security-completion/README.md` (create if missing)
recording:

* Date of revert.
* Commit hashes that were reverted (the cap_drop + apparmor attempt).
* Why: setns() failed even with apparmor:unconfined + SYS_ADMIN —
  cause not fully diagnosed but suspected to be Docker's seccomp
  profile, user-namespace boundary, or some combination.
* Path forward: host-side agent (separate prompt at
  `docs/features/security-completion/host-side-agent-prompt.md`).

Commit:

    docs(security): note privileged:true revert + path to real B1 fix

Push.

## Rules

* Stay scoped to docker-compose.yml + update.sh + the security-
  completion README. Do NOT touch any other code.
* Do NOT attempt the host-side agent in this session — it's a
  multi-week design + build effort with its own kickoff prompt.
* Operator confirmation between Step 3 and Step 4 is mandatory.
* If anything unexpected appears in main's history (e.g., commits
  beyond what this prompt anticipates), STOP and report — don't
  guess.

Begin with Step 0.
```

---

## How to use

1. Operator pastes the fenced block above into a fresh Claude Code session.
2. Session does Steps 0-2 (10-30 minutes), pushes a branch.
3. Operator runs `git pull && ./update.sh` on the deployed host.
4. Operator confirms dashboard works.
5. Session does Step 4 (the doc commit).
6. Operator merges the branch.

Total wall-clock: 1 hour, mostly waiting for the deploy + operator-test loop.

After this, the dashboard is back to its pre-today working state (modulo the
already-merged hardening that does NOT depend on the broken docker-compose:
TOTP encryption, CSRF, cookie auth, FK-safe migrations, deploy validation
with rollback). The privileged-equivalent container is back in place. The
host-side agent is the real fix and is planned in
`docs/features/security-completion/host-side-agent-prompt.md` (separate
kickoff, multi-week scope).
