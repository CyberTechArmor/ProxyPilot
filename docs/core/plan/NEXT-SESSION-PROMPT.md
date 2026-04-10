# Next-Session Kickoff Prompt

Copy everything inside the fenced block below into the first message of a
new Claude Code session. The prompt is scoped to **one phase at a time** —
right now it points at Phase 3 (Foundation — SQLite schema, config loader,
systemd generator). When Phase 3 is complete, edit this file to point at
Phase 4, then Phase 5, etc. Do **not** have the session work on multiple
phases in one run.

---

```
You are picking up the ProxyPilot phased upgrade. Work only on Phase 3
(Foundation — SQLite schema, config loader, systemd generator). Phases 1
and 2 are ✅ complete. Do not touch any other phase until Phase 3 is
fully verified and marked complete in the plan index.

## Orient yourself first

Before touching any code, read these files in order:

1. docs/core/plan/README.md
   The top-level index. Confirms that Phase 3 is "Foundation", that it
   depends only on "existing ProxyPilot", and what later phases build on
   top of it.

2. docs/core/plan/phase-03-foundation.md
   The phase spec. Goal, files to create, deliverables, verification
   checklist, and a placeholder "Function-by-Function Checklist" at the
   bottom. This file is the single source of truth for Phase 3 scope.

3. docs/core/prompt/README.md (and the 1–2 prompt sections it references
   for Phase 3) — Phase 3 is the first phase that uses the core
   infrastructure prompts, so this is where the spec details live.

4. docs/core/plan/phase-02-path-prefix-multi-service.md
   The most recently completed phase. Read for the function-by-function
   workflow style and to see how the verification + Phase ✅ promotion is
   done. Do not touch any Phase 2 code.

Do not read any other phase file. Do not read the monolithic
proxypilot-core-infrastructure-prompt.md or proxypilot-core-phased-plan.md
at the repo root — they are reference archives, not the working spec.

## Lessons from Phase 2 (do not repeat)

1. Each call site flip is its own commit. Phase 2 had 9 Caddy generator
   call sites, each was a separate item with its own integration test
   and commit. The same discipline applies to Phase 3's SQLite + systemd
   work — one helper or one query at a time.
2. Schema migrations must be idempotent. Phase 2 used a `sqlite_master.sql`
   inspection to detect whether the migration had already run, then
   short-circuited. Apply the same pattern for any Phase 3 schema changes.
3. Test the rollback path, not just the happy path. Phase 2's create and
   update endpoints had to revert both DB rows and on-disk state on a
   downstream failure — the integration tests proved both directions.
4. `npm run build` does NOT catch unresolved references at runtime. For
   any frontend work, run `npm run dev` AND load the route in a real
   (or headless puppeteer) browser before marking ANY item complete.
5. One checklist item = one commit. Push after every commit.

## Step 1 — Populate the Function-by-Function Checklist

Open docs/core/plan/phase-03-foundation.md. At the bottom is a
placeholder section:

    ## Function-by-Function Checklist (to be populated)
    - [ ] _pending_

Replace `_pending_` with a concrete per-function checklist derived from
the phase's "Deliverables" section. Each item must have:

- A checkbox: `- [ ]`
- The specific function, helper, table, or unit to add
- The file path it lives in
- A one-line success criterion you can test against

Order the checklist so the SQLite schema lands first (it unblocks every
other Phase 3 deliverable), then the config loader, then the systemd
generator, then the verification pass. Every deliverable bullet in the
phase spec must be represented by at least one checklist item.

Once the checklist is populated, commit it as its own commit:

    git add docs/core/plan/phase-03-foundation.md
    git commit -m "phase-03: populate function-by-function checklist"
    git push -u origin <current-branch>

Then stop and confirm with me that the checklist looks right before you
start modifying code. Do not start Step 2 until I approve the checklist.

## Step 2 — Execute the checklist, one item at a time

After I approve the checklist:

For each unchecked item, in order:

1. Implement it.
2. Verify it against the one-line success criterion in the checklist
   item. For schema changes: run a smoke test that opens the DB and
   inspects `sqlite_master`. For systemd helpers: run them against a
   throwaway test unit (in a sandboxed environment if needed). For the
   config loader: write a temp YAML and load it.
3. Tick the checkbox in phase-03-foundation.md: `- [ ]` → `- [x]`
4. Commit with a message like:
      phase-03: <one-line summary of what this item did>

5. Push.
6. Move to the next unchecked item.

Do NOT batch multiple items into one commit. One item = one commit.
If an item is too large to finish in a single commit, split it into
sub-items in the checklist first, then implement each sub-item as its
own commit.

If an item turns out to be wrong or impossible, edit the checklist to
fix it (or strike it through with a note) rather than silently skipping.

## Step 3 — Finish the phase

When every Function-by-Function Checklist item is ticked:

1. Work through the "Verification" checklist at the top of
   phase-03-foundation.md. This is the real acceptance test.
   Every item must be confirmed.
2. If any verification item fails, go back to Step 2 and add a new
   checklist item to fix it. Do not mark the phase complete until
   verification is green.
3. Once all verification checkboxes are ticked, update
   docs/core/plan/README.md: change the Phase 3 row in the Phases
   table to indicate it is done — prepend ✅ to the "File" column
   link, e.g.:
      | 03 | ✅ [`phase-03-foundation.md`](phase-03-foundation.md) | ... |
   Also add a Phase 3 entry to the Status section of the README,
   matching the format used for Phases 1 and 2.
4. Commit this status change:
      phase-03: mark phase complete
5. Push.
6. Update docs/core/plan/NEXT-SESSION-PROMPT.md to point at Phase 4
   (Postgres + PgBouncer). Commit. Push.
7. Stop. Do not start Phase 4. Report back that Phase 3 is done and
   wait for me to kick off the next phase with a fresh session.

## Rules

- Stay scoped to Phase 3. Do not touch backend code in
  admin/backend/, frontend code in admin/frontend/, Caddy config, or
  any file outside the Phase 3 "Files to create" list (with the
  exception of docs/core/plan/phase-03-foundation.md and
  docs/core/plan/README.md for status updates, plus
  docs/core/plan/NEXT-SESSION-PROMPT.md at the very end).
- Commit often. One checklist item = one commit.
- Never mark a checklist item complete if it is not verified working.
- Never mark the phase complete if any verification checklist item fails.
- Do not create a pull request. Just push to the current branch.
- Ask me before any destructive action (rebases, force pushes, deleting
  files, etc.) — the stock rules still apply.

Begin with Step 1: read the orientation files and report back with a
draft Function-by-Function Checklist for my review.
```

---

## How to use this prompt

1. Start a new Claude Code session on this repo and branch.
2. Copy the fenced block above (everything between the two triple-backtick lines) and paste it as the first message.
3. The session will read the orientation files and reply with a draft checklist. Review and approve it (or ask for changes) before it starts writing code.
4. Subsequent sessions that resume Phase 3 work: paste the same prompt again — the session will re-orient itself, see the already-populated checklist, and pick up at the first unchecked item.
5. When Phase 3 is complete and the session has marked ✅ in `docs/core/plan/README.md`, edit this file: change every `Phase 3` / `phase-03-foundation.md` reference to `Phase 4` / `phase-04-postgres-pgbouncer.md`. Then repeat.
