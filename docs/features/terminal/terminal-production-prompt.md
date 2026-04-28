# Kickoff prompt — Interactive Terminal Production Hardening

Copy everything in the fenced block below into the first message of a new
Claude Code session. **Do not run this until the MVP is verified
(`terminal-mvp.md` shows `## MVP — Verified`) AND the `## Post-MVP Use Notes`
section in `terminal-production.md` is filled in with real operator
feedback.** The session reads your feedback first and adjusts the default
plan accordingly — without it, you waste an hour on the wrong priorities.

---

```
You are picking up the ProxyPilot interactive-terminal feature. Work
ONLY on the production-hardening pass described in
docs/features/terminal/terminal-production.md. The MVP is already
shipped on a separate branch and merged (or available for cherry-pick).
Do not re-implement anything from the MVP; build on top of it.

## Branch

The terminal MVP work, like every other feature in ProxyPilot, lands
on `main` via PR. Cut a fresh branch from main:

    git fetch origin main
    git checkout main
    git pull origin main
    git checkout -b claude/terminal-production-<your-session-suffix>

Confirm with `git log --oneline -15` that you see a
`docs(terminal): mark MVP complete` commit (or the MVP merge commit)
at or near the top before proceeding. If you don't, the MVP hasn't
landed on main yet and you've started this session too early — STOP
and ask the operator to confirm the MVP merge before continuing.

Push to the new branch throughout the session. Do not push to main
directly — the operator handles merges via PR.

## Step 0 — Read operator feedback FIRST (mandatory)

Open `docs/features/terminal/terminal-production.md` and read the
`## Post-MVP Use Notes` section in full. Do NOT skim — every bullet is
a directive that adjusts the default plan.

If the section is empty (placeholder text only, no operator-supplied
content): STOP. Reply to the operator with:

    "The Post-MVP Use Notes section is empty. Use the MVP for a week
    and fill in the use-feedback before kicking off this session. The
    default plan in terminal-production.md is a starting point; your
    use-notes are what tailor it to your real deployment. Without
    them, this session would be guessing."

Do not proceed past this step until the section is populated.

When the section IS populated, summarize the operator's priorities
back in your first reply (numbered list), and explicitly call out:
- which default-plan items the feedback DROPS
- which default-plan items the feedback PROMOTES to top priority
- which features the feedback ADDS that aren't in the default plan
- which security / privacy constraints are non-negotiable

Wait for the operator to confirm your reading of their feedback
before writing any code. The harness should not run unattended past
this confirmation step.

## Hard segmentation rules (the harness will hang otherwise)

Same as the MVP prompt, repeated here for self-containment:

1. **Reads ≤ 200 lines.** Always pass offset + limit.
2. **Edits are targeted.** Use Edit with old_string / new_string blocks
   carrying just enough context to be unique.
3. **Long-running commands run in the background.** npm install, vite
   build, dev server, puppeteer — all `run_in_background: true`.
4. **TodoWrite checkpoints between segments.**
5. **One checklist item = one commit. Push after every commit.** If an
   item turns out too large, edit terminal-production.md to split it
   first.
6. **If a segment hangs, cancel and split.**
7. **One concern per commit.**

## Read, in order, before touching any code (after Step 0)

1. `docs/features/terminal/terminal-production.md` — the full spec
   plus the operator feedback section you've already read.
2. `docs/features/terminal/terminal-mvp.md` — the MVP spec, especially
   the "Function-by-Function Checklist" (so you know what shape the
   verified state is in).
3. `admin/backend/src/lib/pty.js` (created in MVP) — full read.
4. `admin/backend/src/routes/terminal-ws.js` (created in MVP) —
   full read; this is the file you extend most.
5. `admin/backend/src/middleware/wsAuth.js` (created in MVP) — short
   file, full read.
6. `admin/frontend/src/components/InteractiveTerminal.jsx` (created
   in MVP) — full read; reconnect grace + mobile polish edits live
   here.
7. `admin/backend/src/db.js`, the `runMigration` definition only
   (Grep + 30-line read). The new `terminal_sessions` table goes in
   via `runMigration(db, 7, ...)`.
8. `admin/backend/src/middleware/auth.js` — full read; you add
   `canExecOnService` to it.
9. The Phase 2b checklist style for verification notes — open
   `docs/core/plan/phase-02b-container-service-model.md`, find any
   ticked item with a "Verified:" note, copy that format.

Do NOT read anything under `docs/core/plan/` beyond that one format
reference. Phase work is a parallel track.

## Step 1 — Populate the function-by-function checklist

The "Function-by-Function Checklist" section in
terminal-production.md currently has a single placeholder
(`- [ ] _pending_`). Replace it with a concrete list of 15-20
single-commit items derived from:

  (a) the Deliverables section (D.1 through D.9), AND
  (b) the operator's Post-MVP Use Notes — especially the
      priority ranking and any added features.

Each item must have:
  * A checkbox `- [ ]`
  * The specific function, helper, table, or component to add or change
  * The file path it lives in
  * A one-line success criterion you can test against

Suggested ordering (refine based on operator feedback):
  1. Migration version 7 (terminal_sessions table) — first because
     several later items depend on the table.
  2. Recording infrastructure (cast writer + DB writes) — recording
     is the biggest single deliverable and gating-it-off is the
     cleanest first step.
  3. Per-service ACL helper + wiring — small change, high security
     value.
  4. Reconnect grace — touches both backend and frontend.
  5. Replay endpoint + UI — depends on recording.
  6. Docker support via dockerode — independent module, low risk.
  7. Mobile polish — last because it's iterative and needs real
     device testing.
  8. Settings UI for limits — depends on most of the above being
     wired.
  9. Legacy ContainerTerminal removal — last; only when the new
     terminal has been used in anger and proven equivalent.
  10. Documentation updates.

Items ANY operator feedback drops do NOT make it into the checklist.
Items operator feedback promotes go to the top regardless of the
suggested ordering.

Commit the populated checklist as its own commit:

    docs(terminal): populate production checklist from use-feedback

Push. Then STOP and confirm with the operator that the checklist
shape is right before starting Step 2.

## Step 2 — Execute the checklist, one item at a time

For each unchecked item, in order:

1. Implement it (small targeted edits).
2. Verify it against its one-line success criterion. For schema
   changes, smoke-test the migration on three states:
     (a) Fresh DB
     (b) MVP-state DB (versions 1, 2, 3, 5)
     (c) Production-state DB re-run (idempotency)
3. Tick the checkbox in terminal-production.md and append a brief
   `Verified:` note describing what you actually checked. Mirror the
   Phase 2b note format.
4. Commit using the message templates in terminal-production.md.
5. Push.
6. Update TodoWrite. Move to the next unticked item.

Do NOT batch items into one commit.
Do NOT mark an item complete unless verification passed.
Do NOT mark an item complete based on type-checks or builds alone.

## Step 3 — Walk the verification checklist

Once every function-by-function item is ticked, walk the
"Verification checklist" section (D.1.V through D.9.V plus D.X / D.Y
/ D.Z deploy items). Each verification item gets its own
`verify(terminal):` commit with a one-line evidence note.

The deploy items (D.X, D.Y, D.Z) are mandatory:
  * D.X — migrations on three DB states.
  * D.Y — update.sh on an existing install with active terminal
    sessions.
  * D.Z — fresh install.sh with the new TERMINAL_* env keys.

Cannot test against a real disposable VM? STOP and ask the operator
how to proceed. Do NOT skip these.

## Step 4 — Finish the production phase

When every verification item is ticked:

1. Append a `## Production — Verified` section at the bottom of
   terminal-production.md with the date and the latest commit hash.
2. Commit:
       docs(terminal): mark production phase complete (verified <date>)
3. Push.
4. Stop. Report back. The terminal feature is production-ready.

## Rules

- Stay scoped to the production-hardening checklist. Do not touch
  files outside the "Files to edit" list in terminal-production.md
  unless the operator's Post-MVP Use Notes explicitly add them.
- Operator feedback in `## Post-MVP Use Notes` is the source of
  truth for scope. Default plan is a starting point, not a contract.
- Every schema change MUST go through `runMigration(db, version,
  name, fn, opts)` with a version number ≥ 6. Use `disableFks: true`
  ONLY if you are doing a table rebuild (DROP + RENAME); simple
  CREATE TABLE / ALTER TABLE migrations do not need it.
- Every state-changing endpoint added MUST be CSRF-aware (the global
  csrfProtection middleware covers it automatically; just confirm
  the path is not in CSRF_EXEMPT_PREFIXES).
- Recording, when implemented, is OPT-IN by default. Default
  TERMINAL_RECORDING_ENABLED=false in .env.example and in the
  fallback when the app_settings row is absent. The operator turns
  it on explicitly.
- Privacy: when recording IS enabled, the UI MUST show a clear
  "Recording" indicator in the terminal status banner. Silent
  recording is unacceptable.
- Commit often. One checklist item = one commit. Push after every
  commit.
- Never skip the deploy verification items (D.X / D.Y / D.Z).
- Do not create a pull request — the operator handles merges.
- Ask before any destructive action (rebases, force pushes, deletes,
  schema changes that drop columns).

Begin with Step 0: read the Post-MVP Use Notes and confirm your
understanding of the operator's priorities back to them.
```

---

## How to use this prompt

1. **Use the MVP for at least a week.** Open terminals against real containers. Run `vim`, `htop`, `tmux`. Intentionally close tabs. Let idle sessions expire. Check the audit log. Try it on mobile if you'll use it on mobile.

2. **Fill in `## Post-MVP Use Notes`** in `terminal-production.md`. Be specific. The session is going to read this and adjust the default plan. The more concrete you are, the less the session has to guess.

3. Start a new Claude Code session on this repo.

4. Copy the fenced block above (everything between the two triple-backtick lines) and paste it as the first message.

5. The session will read the operator notes section first. It will summarize back its understanding and **wait for your confirmation** before populating the function-by-function checklist. Approve or correct the summary before letting it ship code.

6. After confirmation, the session populates the checklist as its own commit, pauses again, and waits for your sign-off on the checklist shape. Then it executes one item at a time with commits and pushes.

7. The session ends when every verification item is ticked and `terminal-production.md` shows `## Production — Verified`.

## What to do if the use-feedback section is empty

The session will refuse to proceed and ask you to fill it in. That refusal is intentional — running the production phase without operator feedback wastes a day building features you don't need and missing features you do.

If you want a fast pass without filling out feedback, that's fine — but use a different prompt that explicitly tells the session "no operator feedback, just build the default plan." Don't paste this prompt expecting it to silently fall through. The Step-0 guard exists to protect you from that mistake.
