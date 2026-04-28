# Master kickoff prompt — Drive every phase to production-ready

Copy everything in the fenced block below into a fresh Claude Code
session. The session reads `docs/features/security-completion/master-spec.md`,
finds the next unticked phase, does it, marks it ✅, commits, pushes,
stops.

When the session ends (or runs out of context), paste the same prompt
into a new session — it picks up where the spec says the work left off.

This is the operator's single entry point for ALL remaining security
work. Phase 0 first (mandatory — restores the dashboard), then Phase A
through R in order, each with its own operator gate.

---

```
You are picking up the ProxyPilot security-completion work tracked
in docs/features/security-completion/master-spec.md. Each phase
has acceptance tests the operator runs against a disposable VM (or
production for Phase 0). The session does ONE phase per invocation.
When a phase completes successfully, the operator confirms, you mark
the phase ✅ in master-spec.md, commit, push, and STOP. The next
session picks up the next unticked phase from the spec.

This is a multi-week, multi-session body of work. Do not try to do
multiple phases in one session — each phase has its own commit train
and its own operator gate. Skipping the gate is what produced the
five regressions on the prior branch. Don't repeat that.

## Branch

Cut a fresh branch from the latest main per phase:

    git fetch origin main
    git checkout main
    git pull origin main
    git checkout -b claude/sec-phase-<phase-letter-or-0>-<your-suffix>

Push to that branch throughout the session. Do not push to main.

## Hard segmentation rules (the harness will hang otherwise)

1. **Reads ≤ 200 lines** with offset+limit. Use Grep first to locate.
2. **Edits are targeted** — Edit with old_string/new_string, not Write,
   unless the file is brand-new or under ~200 lines.
3. **Long-running commands run in the background** (`run_in_background:
   true`) — npm install, vite build, go build, docker compose build,
   the dev backend, puppeteer scripts. Read output later via BashOutput.
4. **TodoWrite checkpoints** between segments so progress is visible
   and so you don't lose your place if you have to back out.
5. **One checklist item = one commit. Push after every commit.** If
   an item turns out too large, edit master-spec.md to split it into
   sub-items first, then implement each sub-item as its own commit.
6. **If a segment hangs, cancel and split.** Never retry the same
   over-large operation.
7. **One concern per commit.** Bug fix, feature, doc — pick one.

## Step 0 — Find the next phase

In a single short bash call:

    grep -n "^| [0A-R] " docs/features/security-completion/master-spec.md | head -25

Pick the first row whose status column is NOT ✅. That's your phase.

If Phase 0 is ⏳: this session does the dashboard restore. The
operator's production is currently down. Treat this as urgent —
small commits, tight focus, push as fast as possible.

If Phase A is the next ⏳: this session scaffolds the host-side
agent. Read the entire Phase A section of the spec before any
code lands.

If Phase A is ✅ but the operator has not run the deploy +
acceptance tests yet, STOP and ask. You CANNOT advance to Phase B
without the operator's green light on Phase A's V1-V6 verification.

Same gate before every subsequent phase.

## Step 1 — Read the phase section in full

Read the named Phase section of master-spec.md — every row of every
table. Pay attention to:

* Files to edit (the canonical scope)
* Deliverables (the work product)
* Acceptance tests (operator gate)
* Commits (one per checklist item, one concern per commit)

Note: per master-spec.md, every phase has its OWN file list. Do not
edit files outside that list unless a discovered dependency forces
it — and if you do, document why in the commit message and update
the spec's "Files to edit" section.

## Step 2 — Read the orientation files for the phase

Common context every phase needs:

* `admin/backend/src/middleware/auth.js` (~110 lines, full read OK) —
  the auth model. Cookie + CSRF, B5 TOTP encryption, jwt.verify flow.
* `admin/backend/src/db.js` — but only the specific function the
  phase touches. Use Grep first. Don't full-read this file (it's
  ~1100 lines).
* `admin/backend/src/routes/auth.js` — ~470 lines, OK to full read.
  The login + initial-setup + TOTP-setup flows.
* `install.sh` and `update.sh` — large but heavily commented. Read
  via Grep + targeted offset/limit. The relevant function blocks are
  short.

Phase-specific:
* Phase 0: just the docker-compose.yml block in install.sh + update.sh.
* Phase A-G: focused on cmd/agent/* (new), admin/backend/src/lib/agent.js
  (new), and the migration of existing nsenter call sites. Do NOT
  read entire route files unprompted — Grep for `execOnHost` or
  `nsenter` and read tight windows.
* Phase H: deploy/backup/* (new), no modifications to existing code.
* Phase I: docs only, no code.
* Phase J: db.js (just the users table CREATE), routes/auth.js login
  function, db.js's runMigration helper.
* Phase K: middleware/auth.js, routes/services.js (specific endpoints).
* Phase L: middleware/auth.js generateToken + authenticateToken.
* Phase M: db.js (migration), middleware/auth.js, routes/auth.js logout.
* Phase N: lib/secrets.js, db.js, a new admin/backend/scripts/ file.
* Phase O: middleware/auth.js, routes/auth.js refresh.
* Phase P: routes/auth.js + routes/user.js password endpoints.
* Phase Q: db.js (migration), the logAudit helper.
* Phase R: .github/workflows/* (new), no app code.

## Step 3 — Implement one checklist item at a time

For each item in the phase's deliverables:

1. Implement it (small targeted edits — see segmentation rules).
2. Sanity-check it BEFORE committing:
   * Backend code: `node --check <file>`. For new modules, write
     a 20-line one-shot smoke script that exercises the happy path.
     Delete the smoke script before committing.
   * Frontend code: `cd admin/frontend && node node_modules/vite/bin/vite.js build`.
     Confirm no errors in the output.
   * Bash: `bash -n <script>`.
   * Go (Phases A-G): `go vet ./... && go test ./... && go build ./...`.
3. Tick the checkbox in master-spec.md if the item is one of the
   listed deliverables.
4. Commit with the message prefix from the spec's "Commits" section
   for that phase.
5. Push.
6. Update TodoWrite. Move to the next item.

NEVER batch items into one commit.
NEVER mark an item complete based on type-checks alone — those
verify code correctness, not feature correctness.

## Step 4 — Phase verification

After all deliverables for the phase are committed and pushed:

1. Tell the operator: "Phase X is ready for verification. Pull the
   branch and run the acceptance tests listed in master-spec.md
   for Phase X."
2. STOP. Do not advance to the next phase. Do not auto-update the
   spec's status to ✅ — that comes after the operator confirms.

When the operator returns confirming all V.x items pass:

1. Edit master-spec.md: change Phase X's status to ✅, optionally
   add a "Verified: <date> by operator <name>" note inline.
2. Commit:

       docs(spec): Phase X ✅ — verified <date>

3. Push.
4. STOP. The session ends. Operator merges the branch (or asks for
   a follow-up if anything's wrong).

## Rules across all phases

* **Operator gate is non-negotiable.** Do not start Phase B until
  Phase A is ✅. Do not start Phase F until A-E are ✅ AND all four
  feature flags have been ON in production for at least 7 days.
* **Feature flags default OFF.** The agent rewrite is dual-tracked
  with nsenter through Phase F. Never remove the nsenter path before
  Phase F. Never default a feature flag to ON before Phase F.
* **Never touch the production deployment from the session.** The
  operator runs `update.sh` themselves. The session pushes branches
  and waits.
* **Commit hygiene.** One concern per commit. Push after every commit.
  If you find yourself wanting to fix something unrelated, open a
  separate commit (`fix(...): ` prefix) and document it in the
  session's TodoWrite.
* **Doc updates land alongside code.** When Phase A adds new files,
  update `host-side-agent-spec.md` in the same commit chain — not
  later. The spec doc is part of the code review.
* **Stop and ask before any destructive action** — git rebase, git
  push --force, git reset --hard, schema changes that drop columns
  outside `runMigration`, anything that touches more than the
  current phase's "Files to edit" list.
* **No new sessions of the SAME phase.** If a session crashes
  mid-phase, the next session reads the partial work via git log
  and resumes from the last successful commit. Do not start the
  phase from scratch.

## When the very last phase (R) is ✅

1. Update the project README and any phase-overview docs to drop
   the "privileged-equivalent container" caveat from the
   production-readiness statement.
2. Commit:

       docs: ProxyPilot is honestly production-ready (Phase R complete)

3. Tag the release: `git tag v2.0.0` (operator approves the version
   number first).
4. Stop. Tell the operator: "All phases complete. Production-ready
   with no caveats."

Begin with Step 0: find the next phase.
```

---

## How to use this prompt

1. Operator opens a fresh Claude Code session.
2. Pastes the fenced block above as the first message.
3. Session does Phase 0 (or whichever is next), pushes a branch, stops.
4. Operator runs the acceptance tests. If green, confirms in chat.
5. Session marks the phase ✅ in master-spec.md, commits, pushes, stops.
6. Operator merges the branch.
7. Open a NEW session. Paste the SAME prompt. Session reads the spec, sees Phase 0 ✅, picks up Phase A.
8. Repeat through Phase R.

Wall-clock estimate: 5-12 weeks depending on operator test cadence.
Each phase is 1-3 sessions of work + 1-3 days of operator testing.

The discipline of the operator gate is what protects you from the
regressions that bit the prior branch. Honor it and the work lands
cleanly. Skip it and we end up here again.
