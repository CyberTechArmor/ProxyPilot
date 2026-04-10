# Next-Session Kickoff Prompt

Copy everything inside the fenced block below into the first message of a
new Claude Code session. The prompt is scoped to **one phase at a time** —
right now it points at Phase 2b (Container-as-Service Data Model + Multiple
HTTP Routes per Service). When Phase 2b is complete, edit this file to
point at Phase 2c, then Phase 3, etc. Do **not** have the session work on
multiple phases in one run.

---

```
You are picking up the ProxyPilot phased upgrade. Work only on Phase 2b
(Container-as-Service Data Model + Multiple HTTP Routes per Service).
Phases 1 and 2 are ✅ complete. Phase 2c (caddy-l4 port forwards) and
Phase 3 (Foundation) come after this one — do not touch them.

## Orient yourself first

Before touching any code, read these files in order:

1. docs/core/plan/README.md
   The top-level index. Confirms that Phase 2b is "Container-as-Service
   Data Model + Multiple HTTP Routes per Service", that it depends on
   Phase 2, and that Phase 2c + Phase 3 come after it.

2. docs/core/plan/phase-02b-container-service-model.md
   The phase spec. Goal, files to edit, deliverables, verification
   checklist, and a placeholder "Function-by-Function Checklist" at the
   bottom. This file is the single source of truth for Phase 2b scope.

3. docs/core/plan/phase-02-path-prefix-multi-service.md
   The most recently completed phase. Read for the merged-Caddy
   generator (`buildDomainCaddyConfig`, `regenerateDomainCaddyConfig`)
   that Phase 2b extends, and for the workflow style — every Phase 2
   item was implemented, integration-tested, and committed one at a
   time, with the function-by-function checklist updated in lockstep.
   Do not touch any Phase 2 code outside of what Phase 2b's "Files to
   edit" list explicitly calls out.

4. docs/core/plan/phase-02c-layer4-port-forwards.md
   The phase that immediately follows 2b. Skim it to make sure the
   schema decisions you make in 2b are coherent with what 2c expects
   (the `services` table will gain a `service_port_forwards` sibling in
   2c — leave room for it). Do NOT implement any 2c work in this session.

5. The files the phase spec lists under "Files to edit", at minimum:
   - admin/backend/src/db.js
   - admin/backend/src/routes/services.js
   - admin/backend/src/routes/lxc.js
   - admin/frontend/src/pages/Dashboard.jsx
   - admin/frontend/src/lib/api.js

6. admin/frontend/MOBILE_FIRST.md
   The mobile-first patterns Phase 1 established. Every UI change in
   Phase 2b's wizard + service detail must follow these.

Do not read any other phase file. Do not read any file under
docs/core/prompt/. Do not read the monolithic
proxypilot-core-infrastructure-prompt.md or proxypilot-core-phased-plan.md
at the repo root.

## Lessons from Phase 2 (do not repeat)

1. `npm run build` does NOT catch unresolved references at runtime. Run
   `npm run dev` AND load the route in a real (or headless puppeteer)
   browser at 360px and 1280px before marking ANY frontend item complete.
2. Schema migrations must be idempotent. Phase 2 used a `sqlite_master.sql`
   inspection to detect whether the migration had already run, then
   short-circuited. Phase 2b's split migration (one services row →
   one services + one service_http_routes row) must do the same.
3. Test the rollback path, not just the happy path. Phase 2's create and
   update endpoints had to revert both DB rows and on-disk state on a
   downstream failure. Phase 2b's route-level CRUD has the same
   requirement — and now there are two related tables to revert.
4. tailwind-merge only resolves conflicts within the same class group;
   `md:flex` and `hidden` do NOT conflict. Use the patterns documented
   in MOBILE_FIRST.md instead of inventing new ones.
5. Never nest a <Button> inside a <button>.
6. The Dialog base is already mobile-overridable; use
   `max-w-full h-full rounded-none sm:max-w-<X> sm:h-auto sm:rounded-lg`.
7. One checklist item = one commit. Push after every commit.

## Step 1 — Populate the Function-by-Function Checklist

Open docs/core/plan/phase-02b-container-service-model.md. At the bottom
is a placeholder section:

    ## Function-by-Function Checklist (to be populated)
    - [ ] _pending_

Replace `_pending_` with a concrete per-function checklist derived from
the phase's "Deliverables" section. Each item must have:

- A checkbox: `- [ ]`
- The specific function, helper, table, or component to add or change
- The file path it lives in
- A one-line success criterion you can test against

Order the checklist backend-first: schema migration → Caddy generator
extension → routes CRUD endpoints → LXC integration → frontend wizard +
service detail page → mobile verification. Every deliverable bullet in
the phase spec must be represented by at least one checklist item.

Once the checklist is populated, commit it as its own commit:

    git add docs/core/plan/phase-02b-container-service-model.md
    git commit -m "phase-02b: populate function-by-function checklist"
    git push -u origin <current-branch>

Then stop and confirm with me that the checklist looks right before you
start modifying code. Do not start Step 2 until I approve the checklist.

## Step 2 — Execute the checklist, one item at a time

After I approve the checklist:

For each unchecked item, in order:

1. Implement it.
2. Verify it against the one-line success criterion in the checklist
   item:
   - For schema changes: run a smoke test that opens the DB and inspects
     `sqlite_master.sql` + `pragma table_info`.
   - For backend CRUD: an Express in-process integration test that POSTs
     a payload, asserts the response, and inspects the DB + the merged
     Caddy file on disk.
   - For frontend changes: `npm run dev` + a headless puppeteer load at
     360px AND 1280px with a JWT injected into localStorage and a backend
     seeded with realistic test data.
3. Tick the checkbox in phase-02b-container-service-model.md:
   `- [ ]` → `- [x]`. Append a brief **Verified:** note describing what
   you actually checked (mirroring the Phase 2 checklist style).
4. Commit with a message like:
      phase-02b: <one-line summary of what this item did>
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
   phase-02b-container-service-model.md. This is the real acceptance test.
   Every item must be confirmed.
2. If any verification item fails, go back to Step 2 and add a new
   checklist item to fix it. Do not mark the phase complete until
   verification is green.
3. Once all verification checkboxes are ticked, update
   docs/core/plan/README.md: change the Phase 2b row in the Phases
   table to indicate it is done — prepend ✅ to the "File" column
   link, e.g.:
      | 02b | ✅ [`phase-02b-container-service-model.md`](phase-02b-container-service-model.md) | ... |
   Also update the Status section entry for Phase 2b to mark it complete,
   matching the format used for Phases 1 and 2.
4. Commit this status change:
      phase-02b: mark phase complete
5. Push.
6. Update docs/core/plan/NEXT-SESSION-PROMPT.md to point at Phase 2c
   (Layer 4 Port Forwards via caddy-l4). Commit. Push.
7. Stop. Do not start Phase 2c. Report back that Phase 2b is done and
   wait for me to kick off the next phase with a fresh session.

## Rules

- Stay scoped to Phase 2b. Touch only files listed in the phase spec
  plus docs/core/plan/phase-02b-container-service-model.md and
  docs/core/plan/README.md. NEXT-SESSION-PROMPT.md is touched only in
  Step 3 step 6.
- Do not touch Phase 2c (`phase-02c-layer4-port-forwards.md`) or any
  files it lists. Do not pre-create the `service_port_forwards` table
  or any layer4 helpers. Phase 2c is a separate session.
- Commit often. One checklist item = one commit.
- Never mark a checklist item complete if it is not verified working
  (backend smoke test for backend items, real/headless browser at 360px
  AND 1280px for frontend items).
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
4. Subsequent sessions that resume Phase 2b work: paste the same prompt again — the session will re-orient itself, see the already-populated checklist, and pick up at the first unchecked item.
5. When Phase 2b is complete and the session has marked ✅ in `docs/core/plan/README.md`, edit this file: change every `Phase 2b` / `phase-02b-container-service-model.md` reference to `Phase 2c` / `phase-02c-layer4-port-forwards.md`. Then repeat for Phase 3, Phase 4, etc.
