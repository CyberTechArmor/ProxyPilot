# Next-Session Kickoff Prompt

Copy everything inside the fenced block below into the first message of a
new Claude Code session. The prompt is scoped to **one phase at a time** —
right now it points at Phase 2 (Multi-Service Path-Prefix Routing).
Phase 1 (Mobile-Friendly Admin Dashboard) is ✅ complete. When Phase 2
is complete, edit this file to point at Phase 3, then Phase 4, etc.
Do **not** have the session work on multiple phases in one run.

---

```
You are picking up the ProxyPilot phased upgrade. Work only on Phase 2
(Multi-Service Path-Prefix Routing). Do not touch any other phase until
Phase 2 is fully verified and marked complete in the plan index.

Phase 1 (Mobile-Friendly Admin Dashboard) is already ✅ complete on
branch claude/mobile-admin-dashboard-phase1-iJdmt. You may reference its
spec and commit history for responsive patterns, but do not modify
anything Phase 1 shipped unless you are fixing a regression caused by
your Phase 2 work.

## Branch

Work on a new feature branch for Phase 2:

    claude/phase-02-path-prefix-multi-service

Create it from the Phase 1 branch (which has already been merged or is
the current main, depending on the repo state when you start). If the
branch already exists, switch to it and pick up at the first unchecked
item in the Function-by-Function Checklist.

## Orient yourself first

Before touching any code, read these files in order:

1. docs/core/plan/README.md
   The top-level index. Confirms Phase 1 is ✅ and Phase 2 is the next
   row. Read the "Cross-cutting rule: mobile-first UI" section — any
   frontend change in Phase 2 must follow it.

2. docs/core/plan/phase-02-path-prefix-multi-service.md
   The phase spec. Goal, files to edit, deliverables (including a
   "Mobile-first UI" subsection), verification checklist, and a
   placeholder "Function-by-Function Checklist" at the bottom. This
   file is the single source of truth for Phase 2 scope.

3. admin/frontend/MOBILE_FIRST.md
   The mobile-first patterns Phase 1 established. Every new page,
   dialog, grid, and form you add in Phase 2 must follow these rules.
   Specifically study:
   - Dialogs: the `max-w-full h-full rounded-none sm:…` pattern
   - Grids: always start at grid-cols-1 and ramp up at sm:/md:/lg:
   - Rows with action buttons: flex-col sm:flex-row + flex-wrap
   - Touch targets: primary actions ≥ 44px on mobile

4. The files the Phase 2 spec lists under "Files to edit":
   - admin/backend/src/db.js
   - admin/backend/src/routes/services.js (large — read strategically)
   - admin/frontend/src/pages/Dashboard.jsx (large — read strategically;
     focus on the Add Service wizard + delete dialog + services grid)
   - admin/frontend/src/lib/api.js (audit for domain-keyed caching)

5. Phase 1 verification patterns worth borrowing:
   - docs/core/plan/phase-01-mobile-friendly.md (for the checklist-item
     format — derive your own Phase 2 items, do not copy verbatim)
   - admin/frontend/src/components/ui/dialog.jsx (the mobile-overridable
     DialogContent base you'll build on)

Do NOT read any other phase file. Do NOT read anything under
docs/core/prompt/ (that directory is for Phase 3+). Do NOT read the
monolithic proxypilot-core-infrastructure-prompt.md or
proxypilot-core-phased-plan.md at the repo root — they are reference
archives, not the working spec.

## Lessons from Phase 1 (do not repeat these)

1. `npm run build` passes even when there are unresolved references.
   Phase 1 shipped a broken build for ~60 commits because `cn` was
   called in Dashboard.jsx but never imported — `vite build` doesn't
   check references, only syntax. Before marking ANY checklist item
   complete, run `npm run dev` from admin/frontend/ AND load the
   affected route in a real browser (or headless). The MOBILE_FIRST.md
   checklist already requires this.

2. When writing cn() expressions with responsive overrides, remember
   that tailwind-merge only resolves conflicts within the same class
   group. `flex` and `hidden` conflict (same group). `md:flex` and
   `hidden` do NOT conflict (different breakpoints) — both get kept.
   Use this deliberately: `hidden md:flex` → display:none on mobile,
   display:flex on md+.

3. Never nest a `<Button>` inside a `<button>` — that's invalid HTML.
   If a row has a tappable header area + a nested action button, make
   the header a `<div>` with onClick (or two sibling clickables).

4. twMerge handles the Dialog base correctly: the base has
   `sm:max-w-lg sm:max-h-[90vh] sm:rounded-lg` (no unconditional width
   or height cap). Per-dialog overrides use
   `max-w-full h-full rounded-none sm:max-w-<X> sm:h-auto sm:rounded-lg`
   and twMerge replaces the `sm:max-w-lg` correctly.

5. One checklist item = one commit. Push after each commit. If an item
   is too large, split it into sub-items in the checklist first.

## Step 1 — Populate the Function-by-Function Checklist

Open docs/core/plan/phase-02-path-prefix-multi-service.md. At the
bottom is a placeholder section:

    ## Function-by-Function Checklist (to be populated)
    - [ ] _pending_

Replace `_pending_` with a concrete per-function checklist derived
from the phase's "Deliverables" section. Each item must have:

- A checkbox: `- [ ]`
- The specific function, table, or region of code to change
- The file path it lives in
- A one-line success criterion you can test against

Example shape (do NOT copy these items verbatim — derive your own
from the Phase 2 deliverables):

    - [ ] `initDatabase()` schema migration (admin/backend/src/db.js:~120)
          — detect old UNIQUE(domain) via sqlite_master.sql; rebuild
          into services_new with UNIQUE(domain, path_prefix); copy
          rows; rename; idempotent on re-run
    - [ ] `regenerateDomainCaddyConfig(db, domain)` helper
          (admin/backend/src/routes/services.js:~new)
          — emits one site block per domain with handle_path entries
          sorted by prefix length DESC; writes to caddyFilePath(domain)
    - [ ] Delete endpoint Caddy regeneration
          (admin/backend/src/routes/services.js:~ delete route)
          — after DELETE FROM services, call
          regenerateDomainCaddyConfig so sibling services survive
    - [ ] Add Service wizard: existing-prefix info banner
          (admin/frontend/src/pages/Dashboard.jsx:~2830)
          — blue info box appears when typed domain matches an
          existing service; lists existing prefixes; wraps at 360px
    - [ ] Add Service wizard: client-side (domain, path_prefix)
          validation (admin/frontend/src/pages/Dashboard.jsx:~handleAddService)
          — allow same domain if path_prefix differs
    - [ ] Service grid: group services by domain in favorites-first
          sort (admin/frontend/src/pages/Dashboard.jsx:~3354)
          — domain header wraps at 360px, cards still stack 1/2/3

Order the checklist so the backend schema migration and Caddy
generator land first (they unblock everything else), then the
endpoint refactors, then the frontend changes, then the mobile-first
verification pass. Every deliverable bullet in the phase spec must
be represented by at least one checklist item, including every
bullet in the "Mobile-first UI" subsection.

Once the checklist is populated, commit it as its own commit:

    git add docs/core/plan/phase-02-path-prefix-multi-service.md
    git commit -m "phase-02: populate function-by-function checklist"
    git push -u origin claude/phase-02-path-prefix-multi-service

Then STOP and confirm with me that the checklist looks right before
you start modifying code. Do not start Step 2 until I approve the
checklist.

## Step 2 — Execute the checklist, one item at a time

After I approve the checklist:

For each unchecked item, in order:

1. Implement it.
2. Verify it against the one-line success criterion.
   - Backend items: run the backend locally or write a focused unit
     test (the repo has a jest harness under admin/backend/).
   - Frontend items: run `npm run dev` from admin/frontend/ AND load
     the affected route in a real browser (or headless). Check the
     console for runtime errors. `vite build` passing is NOT enough.
   - Any frontend change: open the affected page/dialog at 360px
     (Chrome DevTools → Responsive → 360×640) and confirm no
     horizontal scroll and no cramped/overflowing content.
3. Tick the checkbox: `- [ ]` → `- [x]`
4. Commit with:
      phase-02: <one-line summary of what this item did>
5. Push.
6. Move to the next unchecked item.

Do NOT batch multiple items into one commit. One item = one commit.
If an item is too large to finish in a single commit, split it into
sub-items in the checklist first, then implement each sub-item as
its own commit.

If an item turns out to be wrong or impossible, edit the checklist
to fix it (or strike it through with a note) rather than silently
skipping.

## Step 3 — Finish the phase

When every Function-by-Function Checklist item is ticked:

1. Work through the "Verification" checklist at the top of
   phase-02-path-prefix-multi-service.md. This is the real
   acceptance test. Every item must be confirmed — including the
   four "**Mobile:**" bullets at the bottom.

2. Run the full verification matrix:
   - `npm run dev` from admin/frontend/, load `/` at 1280px in a
     real browser, confirm the Dashboard renders with no console
     errors, Add Service wizard opens, you can create a service at
     `example.com/` and a second service at `example.com/api`.
   - Switch the browser to 360px responsive mode, repeat the create
     flow end-to-end. Confirm the "Domain already in use" info
     banner wraps, the delete dialog fits, and there's no horizontal
     scroll on any route (`/`, `/incus`, `/users`, `/profile`).
   - Backend: verify the schema migration is idempotent (run
     initDatabase() twice, confirm no errors and the table shape
     is identical).
   - Caddy: pick a real merged config the phase produces and run
     `caddy adapt` on it. The adapt output should be valid JSON
     with no warnings.

3. If any verification item fails, go back to Step 2 and add a new
   checklist item to fix it. Do not mark the phase complete until
   verification is green.

4. Once all verification checkboxes are ticked, update
   docs/core/plan/README.md: change the Phase 2 row to indicate it
   is done — prepend ✅ to the "File" column link, matching Phase 1:

      | 02 | ✅ [`phase-02-path-prefix-multi-service.md`](phase-02-path-prefix-multi-service.md) | existing ProxyPilot | Multiple services per domain via merged `handle_path` |

5. Update the "Status" block in docs/core/plan/README.md to mark
   Phase 2 complete alongside Phase 1.

6. Commit the status change:
      phase-02: mark multi-service path routing phase complete

7. Push.

8. Stop. Do not start Phase 3. Report back that Phase 2 is done and
   wait for me to kick off the next phase with a fresh session.

9. Finally, update docs/core/plan/NEXT-SESSION-PROMPT.md so that it
   points at Phase 3 instead of Phase 2 for the next operator. The
   shape of the prompt stays the same — just swap the phase number,
   file name, branch name, and orient-yourself file list.

## Rules

- Stay scoped to Phase 2. Do not touch any other phase file. Do not
  touch any core infrastructure (Postgres, Infisical, SSH, VPN, etc.)
  — that's Phase 3+.
- The only files you should be editing are the ones in the Phase 2
  "Files to edit" list, plus docs/core/plan/phase-02-* and
  docs/core/plan/README.md for status updates.
- Commit often. One checklist item = one commit. Push after every
  commit.
- Never mark a checklist item complete if it is not verified working
  in a real (or headless) browser / test.
- Never mark the phase complete if any verification checklist item
  fails — including the mobile verification items.
- Do not create a pull request unless I explicitly ask for one. Just
  push to the feature branch.
- Ask before any destructive action (rebases, force pushes, deleting
  files, dropping tables, etc.). The stock rules still apply.
- If you add new frontend code that needs a responsive primitive
  already built in Phase 1, reuse it — do not reinvent. If the
  primitive doesn't exist yet, add it to admin/frontend/src/components/
  with a mobile-first class set and document the pattern in
  admin/frontend/MOBILE_FIRST.md.

Begin with Step 1: read the orientation files and report back with a
draft Function-by-Function Checklist for my review.
```

---

## How to use this prompt

1. Start a new Claude Code session on this repo.
2. Copy the fenced block above (everything between the two triple-backtick lines) and paste it as the first message.
3. The session will read the orientation files and reply with a draft checklist. Review and approve it (or ask for changes) before it starts writing code.
4. Subsequent sessions that resume Phase 2 work: paste the same prompt again — the session will re-orient itself, see the already-populated checklist, and pick up at the first unchecked item.
5. When Phase 2 is complete and the session has marked ✅ in `docs/core/plan/README.md`, the final step of Phase 2 is for the session itself to update **this file** (step 9 in the prompt) so that every `Phase 2` / `phase-02-path-prefix-multi-service.md` / `claude/phase-02-path-prefix-multi-service` reference becomes `Phase 3` / `phase-03-foundation.md` / `claude/phase-03-foundation`. Then repeat from step 1.

## History

- **Phase 1** (Mobile-Friendly Admin Dashboard) — ✅ complete on branch
  `claude/mobile-admin-dashboard-phase1-iJdmt`. Shipped in 66 commits
  over one session. Established the mobile-first baseline and created
  `admin/frontend/MOBILE_FIRST.md` as the governance doc for future
  UI phases. Known caveat: the initial implementation had a missing
  `cn` import in Dashboard.jsx that `vite build` failed to catch —
  fixed in commit `e5ad286`. This is why every future phase must run
  `npm run dev` + a real browser load before marking items complete,
  not just rely on `vite build`.
