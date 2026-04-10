# Next-Session Kickoff Prompt

Copy everything inside the fenced block below into the first message of a
new Claude Code session. The prompt is scoped to **one phase at a time** —
right now it points at Phase 1 (Mobile-Friendly Admin Dashboard). When
Phase 1 is complete, edit this file to point at Phase 2, then Phase 3,
etc. Do **not** have the session work on multiple phases in one run.

---

```
You are picking up the ProxyPilot phased upgrade. Work only on Phase 1
(Mobile-Friendly Admin Dashboard). Do not touch any other phase until
Phase 1 is fully verified and marked complete in the plan index.

## Orient yourself first

Before touching any code, read these files in order:

1. docs/core/plan/README.md
   The top-level index. Confirms that Phase 1 is "Mobile-Friendly Admin
   Dashboard", that it depends only on "existing ProxyPilot", and that
   Phases 2-21 come after it.

2. docs/core/plan/phase-01-mobile-friendly.md
   The phase spec. Goal, files to edit, deliverables, verification
   checklist, and a placeholder "Function-by-Function Checklist" at the
   bottom. This file is the single source of truth for Phase 1 scope.

3. The files the phase spec lists under "Files to edit", at minimum:
   - admin/frontend/src/components/Layout.jsx
   - admin/frontend/src/pages/Dashboard.jsx (large — read strategically)
   - admin/frontend/src/pages/LxcContainers.jsx
   - admin/frontend/src/pages/IncusManagement.jsx
   - admin/frontend/src/pages/Profile.jsx
   - admin/frontend/src/pages/Users.jsx
   - admin/frontend/src/pages/Login.jsx
   - admin/frontend/src/components/ui/dialog.jsx
   - admin/frontend/tailwind.config.js

Do not read any other phase file. Do not read any file under
docs/core/prompt/ (that directory is for Phase 3+). Do not read the
monolithic proxypilot-core-infrastructure-prompt.md or
proxypilot-core-phased-plan.md at the repo root — they are reference
archives, not the working spec.

## Step 1 — Populate the Function-by-Function Checklist

Open docs/core/plan/phase-01-mobile-friendly.md. At the bottom is a
placeholder section:

    ## Function-by-Function Checklist (to be populated)
    - [ ] _pending_

Replace `_pending_` with a concrete per-function checklist derived from
the phase's "Deliverables" section. Each item must have:

- A checkbox: `- [ ]`
- The specific function, component, or region of code to change
- The file path it lives in
- A one-line success criterion you can test against

Example shape (do NOT copy these items verbatim — derive your own from
the deliverables):

    - [ ] `Layout` sidebar (admin/frontend/src/components/Layout.jsx:250)
          — becomes a slide-out drawer on <md; hamburger button shows
          on <md and hides on md+
    - [ ] `Layout` main content (admin/frontend/src/components/Layout.jsx:378)
          — `pl-0 md:pl-64` instead of hardcoded `pl-64`
    - [ ] Dashboard service card grid
          (admin/frontend/src/pages/Dashboard.jsx:~3400)
          — `grid-cols-1 sm:grid-cols-2 lg:grid-cols-3`; confirms no
          fixed grid-cols-N remains
    - [ ] Add Service wizard dialog
          (admin/frontend/src/pages/Dashboard.jsx:~2751)
          — `max-w-full h-full sm:max-w-lg sm:h-auto`; completable on
          a 375px viewport end-to-end

Order the checklist so the sidebar/shell work happens first (it unblocks
everything), then per-page fixes, then polish. Every deliverable bullet
in the phase spec must be represented by at least one checklist item.

Once the checklist is populated, commit it as its own commit:

    git add docs/core/plan/phase-01-mobile-friendly.md
    git commit -m "phase-01: populate function-by-function checklist"
    git push -u origin <current-branch>

Then stop and confirm with me that the checklist looks right before you
start modifying code. Do not start Step 2 until I approve the checklist.

## Step 2 — Execute the checklist, one item at a time

After I approve the checklist:

For each unchecked item, in order:

1. Implement it.
2. Verify it against the one-line success criterion in the checklist
   item. Run the frontend dev server (`npm run dev` from
   admin/frontend/) if needed and confirm the change at 375px viewport.
3. Tick the checkbox in phase-01-mobile-friendly.md: `- [ ]` → `- [x]`
4. Commit with a message like:
      phase-01: <one-line summary of what this item did>

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
   phase-01-mobile-friendly.md. This is the real acceptance test.
   Every item must be confirmed.
2. If any verification item fails, go back to Step 2 and add a new
   checklist item to fix it. Do not mark the phase complete until
   verification is green.
3. Once all verification checkboxes are ticked, update
   docs/core/plan/README.md: change the Phase 1 row in the Phases
   table to indicate it is done — prepend ✅ to the "File" column
   link, e.g.:
      | 01 | ✅ [`phase-01-mobile-friendly.md`](phase-01-mobile-friendly.md) | ... |
4. Commit this status change:
      phase-01: mark mobile-friendly phase complete
5. Push.
6. Stop. Do not start Phase 2. Report back that Phase 1 is done and
   wait for me to kick off the next phase with a fresh session.

## Rules

- Stay scoped to Phase 1. Do not touch backend code, Caddy config, the
  database schema, or any file outside admin/frontend/ (with the
  exception of docs/core/plan/phase-01-mobile-friendly.md and
  docs/core/plan/README.md for status updates).
- Commit often. One checklist item = one commit.
- Never mark a checklist item complete if it is not verified working.
- Never mark the phase complete if any verification checklist item fails.
- Do not create a pull request. Just push to the current branch.
- Ask me before any destructive action (rebases, force pushes, deleting
  files, etc.) — the stock rules still apply.

Begin with Step 1: read the three orientation files and report back with
a draft Function-by-Function Checklist for my review.
```

---

## How to use this prompt

1. Start a new Claude Code session on this repo and branch.
2. Copy the fenced block above (everything between the two triple-backtick lines) and paste it as the first message.
3. The session will read the orientation files and reply with a draft checklist. Review and approve it (or ask for changes) before it starts writing code.
4. Subsequent sessions that resume Phase 1 work: paste the same prompt again — the session will re-orient itself, see the already-populated checklist, and pick up at the first unchecked item.
5. When Phase 1 is complete and the session has marked ✅ in `docs/core/plan/README.md`, edit this file: change every `Phase 1` / `phase-01-mobile-friendly.md` reference to `Phase 2` / `phase-02-path-prefix-multi-service.md`. Then repeat.
