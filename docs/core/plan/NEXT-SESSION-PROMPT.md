# Next-Session Kickoff Prompt

Copy everything inside the fenced block below into the first message of a
new Claude Code session. The prompt is scoped to **one phase at a time** —
right now it points at Phase 2c (Layer 4 / TCP / UDP / TLS-SNI Port
Forwards via `caddy-l4`). When Phase 2c is complete, edit this file to
point at the next planning artifact (the dual-platform deployment model
+ Phase 22 abstraction), then Phase 3, etc. Do **not** have the session
work on multiple phases in one run.

---

```
You are picking up the ProxyPilot phased upgrade. Work only on Phase 2c
(Layer 4 Port Forwards via `caddy-l4`). Phases 1, 2, and 2b are ✅
complete. The dual-platform planning artifact + Phase 22 (the Platform
abstraction) come AFTER Phase 2c — do not touch them or any file under
Phase 3-21 during this session.

## Branch

Cut a fresh branch from the latest Phase 2b state. The Phase 2b work
plus four post-Phase-2b bug fixes (snapshot error reporting, J.1
orphan-service rendering, and the four-tile Add Service picker) live
on `claude/complete-phase-2b-frontend-2yQuS`.

    git fetch origin claude/complete-phase-2b-frontend-2yQuS
    git checkout claude/complete-phase-2b-frontend-2yQuS
    git pull origin claude/complete-phase-2b-frontend-2yQuS
    git checkout -b claude/proxypilot-phase-2c-<your-session-suffix>

Push to that new branch throughout the session. Do not push to the
Phase 2b branch — it is done.

## Hard segmentation rules (the harness will hang otherwise)

The Phase 2b session learned these the hard way. Future iterations of
this prompt MUST keep them. The single biggest cause of harness hangs
is one tool call doing too much.

1. **Reads ≤ 200 lines.** Never `Read` a whole large file. Always
   pass `offset` + `limit`. Use `Grep` first to locate the line you
   want, then read a tight window around it. `Dashboard.jsx` is
   ~7300 lines after Phase 2b — reading it whole will hang.
2. **Edits are targeted.** Use `Edit` with `old_string` /
   `new_string` blocks containing just enough surrounding context
   to be unique. NEVER rewrite a whole file via `Write` unless the
   file is brand-new or under ~200 lines. For files in between
   (like this one), write a small skeleton via `Write` then fill
   sections via `Edit`.
3. **Long-running commands run in the background.** `npm install`,
   `vite build`, `npm run dev`, the dev backend, puppeteer scripts,
   `xcaddy build`, anything that takes more than a few seconds —
   all go through `run_in_background: true`. Read their output later
   via `BashOutput`. Never block a tool call on a slow process.
4. **TodoWrite checkpoints between segments.** Update the todo list
   after every meaningful step so progress is visible and so you
   don't lose your place if you have to back out a segment.
5. **One checklist item = one commit. Push after every commit.** If
   an item turns out too large, edit the spec's checklist to split
   it into sub-items first, then implement each sub-item as its own
   commit. Never batch.
6. **If a segment hangs, cancel and split.** Never retry the same
   over-large operation. Break it down further. If the same Read
   call hangs twice, the file is too big — switch to Grep + a
   narrower Read window.
7. **One concern per commit.** Bug fix, feature, doc update — pick
   one. Mixing makes diffs unreviewable and rollback impossible.

## Read, in order, before touching any code

1. `docs/core/plan/README.md` — top-level index. Confirm Phase 2c is
   listed and read its one-line summary.

2. `docs/core/plan/phase-02c-layer4-port-forwards.md` — the Phase 2c
   spec. **READ IT IN FULL** with `offset` + `limit` (do not pass
   `limit` larger than 200; the file is ~155 lines, so two reads
   cover it). The spec already exists, is populated, and contains
   a blocking Step 1 research task. Do NOT skim — every paragraph
   matters because the schema shape branches on the research result.

3. `docs/core/plan/phase-02b-container-service-model.md` — only
   sections A (schema) and C (routes CRUD). The Phase 2c port
   forwards table mirrors the routes table's CRUD pattern. Skim,
   do not read top-to-bottom.

4. `admin/frontend/MOBILE_FIRST.md` — mobile patterns Phase 1
   established. Every UI change in Phase 2c must follow these,
   including the new NetworkMap page and the Port Forwards section
   on the service detail dialog.

5. The files Phase 2c's spec lists under "Files to edit" — at
   minimum, locate them and confirm they exist. Do NOT read them
   top-to-bottom; use `Grep` to find the spots you'll be editing,
   then `Read offset/limit` a tight window around each spot.

Do not read other phase files. Do not read files under
`docs/core/prompt/`. Do not read `proxypilot-core-infrastructure-prompt.md`
or `proxypilot-core-phased-plan.md` at the repo root.

## Lessons inherited from Phase 2b

These bit the previous session and should not bite you. Internalize
before writing code.

1. **`Dashboard.jsx` is huge** (~7300+ lines after Phase 2b's H/I/J/K
   plus the post-Phase-2b four-tile picker restoration). Use `Grep`
   + targeted `Read offset/limit` to find functions before editing.
   Never use `Read` without bounds.

2. **MOBILE_FIRST.md §5 mandates 44×44px touch targets** for primary
   actions on mobile. Use the `h-11 w-11 sm:h-10 sm:w-10` pattern.
   In tests, use `Math.ceil(height) >= 44` for the touch-target
   assertion — sub-pixel rendering on headless Chromium can emit
   43.43/43.67 for an `h-11` button which is visually 44px.
   Rounding up matches the spec's intent.

3. **Puppeteer harness pattern.** The `vite` binary is at
   `admin/frontend/node_modules/vite/bin/vite.js`. On some node
   versions `npx vite` picks up a stale cached version — prefer
   `node node_modules/vite/bin/vite.js build`. Spawn `npm run dev`
   in the background. Use headless puppeteer at 360×640 AND
   1280×800 to exercise each item. Both viewports MUST pass every
   item's golden path + edge cases before the item is ticked.
   `document.documentElement.scrollWidth ===
   document.documentElement.clientWidth` at every screenshot point
   is the no-horizontal-scroll assertion.

4. **Backend auth bypass for puppeteer tests.** Write a one-shot
   `.pp2c_setup.mjs` helper that:
   - Starts the backend with `ADMIN_USERNAME=admin` (empty password)
   - POSTs to `/api/auth/initial-setup` with a known password
   - Uses the returned `totpSetupRequired` + `totpSecret` to compute
     a valid TOTP code via `OTPAuth` (imported from the backend's
     node_modules)
   - POSTs to `/api/auth/complete-totp-setup` with the code
   - Persists the final JWT to `.pp2c_token.txt` so subsequent
     puppeteer scripts can reuse it.

5. **Stub binaries for verification.** Phase 2b put stubs in
   `/tmp/pp2b/bin/`. Phase 2c needs `/tmp/pp2c/bin/caddy` and
   `/tmp/pp2c/bin/incus`, AND the caddy stub must understand TWO
   new subcommands beyond Phase 2b's bare `exit 0`:
   - `caddy list-modules` — for `caddyHasLayer4()` plugin preflight.
     Must return output containing OR not containing `layer4` on
     demand to exercise both the success path and the 412 fallback.
   - `caddy adapt` — for validating the merged layer4 file alongside
     the per-domain HTTP files. Must exit 0 on valid input, non-zero
     on invalid, so the bulk-add rollback path is exercised.
   Export `PATH="/tmp/pp2c/bin:$PATH"` in the test env.

6. **Don't leave puppeteer or helper scripts in the tree.** Put them
   in `admin/frontend/.pp2c_*_puppeteer.mjs` and delete in the same
   `Bash` invocation that ran them. Add a `admin/frontend/.pp2c_*`
   pattern to `.git/info/exclude`.

7. **node --watch is not used by the backend.** If you modify backend
   code, kill the dev backend process and restart it in the
   background. Re-check `curl -sS
   http://127.0.0.1:3001/api/auth/setup-status` at the top of each
   verification round.

8. **Backend schema changes go through `createServiceSchema` /
   route schemas** — extend with optional fields rather than
   rewriting. Phase 2b's H.6 minimal D.2 extension is the canonical
   pattern.

9. **D.14 has a known regression you may run into.** Phase 2b's
   D.14 dropped the legacy `services.domain` column but the
   migration excluded `is_admin = 1` rows from the routes backfill.
   Result: the admin (ProxyPilot itself) service has no domain
   anywhere. Phase 2c may need to reference the admin service's
   domain when building the global layer4 file — if so, expect it
   to surface as null. Add a defensive guard. Do NOT re-attempt to
   fix D.14 itself; that's a separate operator-blocking decision.

10. **The discover endpoint at `services.js:4969`** filters by
    `service_http_routes.domain` only, so any service in the
    `services` table without a corresponding routes row will appear
    in discover even though it's already managed. Pre-existing
    behavior, not your problem to fix in Phase 2c, but if your
    tests touch the discover flow, account for it.

11. **The J.1 favorite-sort grouping has an "Unrouted services"
    fallback bucket.** A post-Phase-2b commit (`dea64f6`) made the
    grouping defensive so services with no domain bucket render
    under that header instead of disappearing. If your Phase 2c
    work creates a service that shouldn't be visible in the favorite
    grid, account for this — it WILL render, just under the
    fallback header.

12. **Snapshot endpoints in `lxc.js` no longer use `2>&1`.** A
    post-Phase-2b commit (`64eb683`) dropped the trailing `2>&1`
    from `incus snapshot create/restore/delete` so error.stderr is
    populated naturally. If you add new incus shell-outs, follow
    the same pattern: no `2>&1`, and read `error.stderr ||
    error.stdout || error.message` in the catch.

## Step 0 — Branch + setup verification (small)

After cutting the branch, verify the environment in three small bash
calls (NOT one long script):

1. `git log --oneline -8` — confirm you branched from the right point.
   You should see the five post-Phase-2b commits at the top:
   `2babf6c` (next-session prompt retarget), `8630a76` (four-tile
   picker), `dea64f6` (J.1 orphan rendering), `64eb683` (snapshot
   error reporting), `28a39ed` (K.6 bookkeeping).
2. Check `node_modules` exists in `admin/backend` and
   `admin/frontend`. If missing, run `npm install` in each in the
   background (`run_in_background: true`) and check status with
   `BashOutput` later.
3. Re-create the `/tmp/pp2c/bin/caddy` and `/tmp/pp2c/bin/incus`
   stubs if missing. The caddy stub for Phase 2c needs to handle
   `list-modules` and `adapt`; see lesson #5 above.

Checkpoint via `TodoWrite` after each step.

## Step 1 — MANDATORY blocking research task

The Phase 2c spec at `docs/core/plan/phase-02c-layer4-port-forwards.md`
contains a Step 1 research task that **must be done before the
function-by-function checklist is populated**. The spec text is
explicit:

> **Do not populate the function-by-function checklist until this
> research is done.**

The research task is: experimentally verify whether the `caddy-l4`
plugin supports UDP port ranges natively (e.g.,
`udp/:16384-32768 { route { proxy udp/10.0.0.42:16384-32768 } }`).

Procedure:

1. Build Caddy locally via `xcaddy build --with github.com/mholt/caddy-l4`.
   Run this in the background (`run_in_background: true`) — it pulls
   Go modules and takes a while.
2. Stand up a minimal test config with a range listener + a toy UDP
   echo backend (a Python `socketserver` script is fine).
3. Confirm experimentally:
   - **(a)** Caddy binds the whole range (check `ss -u -l -n`).
   - **(b)** UDP packets forward correctly across the range (echo
     a packet at the low end, the middle, and the high end of the
     range — all three should round-trip).
   - **(c)** The range syntax survives a `caddy adapt` round-trip
     (the JSON output should preserve the range, not silently
     collapse it to a single port).

Document the finding in the Phase 2c spec body BEFORE moving on. The
finding determines the schema shape:

- **Shape A (ranges work):** `service_port_forwards` table has
  `host_port_start` / `host_port_end` / `target_port_start` /
  `target_port_end` columns. Conflict detection walks per `(port,
  protocol)` in the range.
- **Shape B (ranges do not work):** Single port columns + `UNIQUE
  (host_port, protocol)` constraint. Port ranges explode into N
  rows; the wizard surfaces a warning when N exceeds a threshold
  (default 50) and points the operator at Phase 10 for nftables
  support.

Commit this as its own commit:

    docs(phase-02c): Step 1 research — caddy-l4 UDP port range support

Push it. Do not start Step 2 until this commit lands and the operator
has had a chance to review the finding.

If `xcaddy build` cannot run in your environment (no Go toolchain,
network restrictions, etc.), STOP and ask the operator how to
proceed. Do NOT guess the answer or pick a shape arbitrarily — the
schema decision flows downstream into half a dozen later items.

## Step 2 — Populate the function-by-function checklist

The Phase 2c spec ends with:

    ## Function-by-Function Checklist (to be populated)
    > This section is a placeholder. ...
    - [ ] _pending_

Replace `_pending_` with a concrete per-function checklist derived
from the phase's "Deliverables" section, choosing schema details
based on the Step 1 finding. Each item must have:

- A checkbox: `- [ ]`
- The specific function, helper, table, or component to add or change
- The file path it lives in
- A one-line success criterion you can test against

Suggested order (refine based on the Deliverables in the spec):

1. Schema migration (the new `service_port_forwards` table, shape
   chosen by Step 1)
2. Plugin preflight helper (`caddyHasLayer4()` + `GET
   /api/system/caddy-modules`)
3. Conflict detection helpers (DB-level + system-level via
   `ss -tulnp` parsing)
4. Host port auto-allocation helper
5. Port discovery via container exec (LXC + Docker variants)
6. CRUD endpoints for `service_port_forwards`
7. Bulk-add endpoint with partial success + adapt-rollback
8. Network map endpoint + system listening ports endpoint
9. Merged Caddy generator extension (`buildLayer4Block`)
10. Audit log additions (`PORT_FORWARD_*`)
11. Export/import shape extension (nest `port_forwards` array under
    each service)
12. Frontend api.js helpers: `getServicePortForwards`,
    `createPortForward`, `updatePortForward`, `deletePortForward`,
    `bulkAddPortForwards`, `detectPorts`, `getNetworkMap`,
    `getListeningPorts`, `getCaddyModules`
13. Service detail page Port Forwards section (container_service
    only — static_site services skip it entirely)
14. Add Service wizard Port Forwards step (after the routes step)
15. Detection modal with bulk-add table
16. New top-level NetworkMap page + sidebar entry in Layout.jsx
17. Mobile verification at 360×640
18. Desktop verification at 1280×800

Every Deliverables bullet in the spec must be represented by at
least one checklist item. The frontend api.js helper names above
are the canonical Phase 2c names — do NOT use `service_l4_routes` /
`createL4Route` style names; the spec uses `service_port_forwards`
and `port_forward` everywhere.

Commit the populated checklist as its own commit:

    docs(phase-02c): populate function-by-function checklist

Push. Then STOP and confirm with the operator that the checklist
shape is right before starting Step 3.

## Step 3 — Execute the checklist, one item at a time

After the operator approves the checklist:

For each unchecked item, in order:

1. Implement it (small targeted edits — see segmentation rules).
2. Verify it against its one-line success criterion:
   - **Schema changes:** smoke test that opens the DB and inspects
     `sqlite_master.sql` + `pragma table_info`.
   - **Backend CRUD:** in-process Express integration test that
     POSTs a payload, asserts the response, and inspects the DB +
     the merged layer4 file on disk.
   - **Frontend changes:** `npm run dev` (background) + headless
     puppeteer load at 360px AND 1280px with a JWT injected into
     localStorage and a backend seeded with realistic test data.
3. Tick the checkbox in `phase-02c-layer4-port-forwards.md`:
   `- [ ]` → `- [x]`. Append a brief **Verified:** note describing
   what you actually checked (mirroring the Phase 2b checklist
   style — see any C.x or H.x note in
   `phase-02b-container-service-model.md` for the format).
4. Commit:

       phase-02c: <one-line summary of what this item did>

5. Push.
6. Update `TodoWrite`. Move to the next unchecked item.

Do NOT batch items into one commit.
Do NOT mark an item complete unless its verification passed.
Do NOT mark an item complete based on type-checks or builds alone —
those verify code correctness, not feature correctness.

## Step 4 — Finish the phase

When every Function-by-Function Checklist item is ticked:

1. Walk the "Verification" checklist at the top of
   `phase-02c-layer4-port-forwards.md` one entry at a time. Every
   bullet must be confirmed AND cross-referenced to the
   function-by-function note that proves it. (Phase 2b's K.6 commit
   `790ecae` is the canonical example of how to write the
   cross-references — copy that style.)
2. If any verification item fails, add a new function-by-function
   checklist item to fix it. Do not mark the phase complete until
   verification is green.
3. Update `docs/core/plan/README.md`: change the Phase 2c row to
   indicate it is done (prepend ✅ to the file column link, update
   the Status section to match how Phase 2b is recorded).
4. Commit `phase-02c: mark phase complete`. Push.
5. Update `docs/core/plan/NEXT-SESSION-PROMPT.md` to point at the
   dual-platform planning + Phase 22 work. Commit. Push.
6. Stop. Report back that Phase 2c is done.

## Rules

- Stay scoped to Phase 2c. Touch only files Phase 2c's spec lists
  under "Files to edit", plus
  `docs/core/plan/phase-02c-layer4-port-forwards.md`,
  `docs/core/plan/README.md`, and
  `docs/core/plan/NEXT-SESSION-PROMPT.md` (the last only in Step 4
  step 5).
- **Do not touch Phase 3-21 files or code under any circumstances.**
- Do not touch (and do not create) `docs/core/plan/00-deployment-model.md`
  or `docs/core/plan/phase-22-platform-abstraction.md`. Those are
  the next session's task.
- Do not touch `proxypilot-core-infrastructure-prompt.md` or
  `proxypilot-core-phased-plan.md` at the repo root.
- Commit often. One checklist item = one commit. Push after every
  commit.
- Never mark a checklist item complete unless verification passed
  (integration test for backend, real/headless browser at BOTH
  viewports for frontend).
- Never mark the phase complete if any verification checklist item
  fails.
- Do not create a pull request — the operator handles merges.
- Ask before any destructive action (rebases, force pushes,
  deletes). Stock rules apply.
- Bug fixes that surface during Phase 2c work but are unrelated to
  Phase 2c go in their own commits with `fix(...)` prefix, NOT
  rolled into a Phase 2c checklist item commit. Examples of
  unrelated-but-tempting fixes: D.14 admin-domain regression,
  discover endpoint filter, anything in Dashboard.jsx not related
  to port forwards.

## When Phase 2c is done

**Stop. Do NOT start Phase 22 or Phase 3 work.** A separate
next-session prompt will be written for the dual-platform planning +
Phase 22 work once Phase 2c is green. The strategic context for
that work is documented in the appendix of this file (in the
operator-side, not in the fenced block) — context only, not
authorization. Read it if you're curious about why the
"stop after Phase 2c" rule is non-negotiable, but do not act on it.

Begin with Step 0: cut the branch and verify the environment.
```

---

## How to use this prompt

1. Start a new Claude Code session on this repo.
2. Copy the fenced block above (everything between the two triple-backtick lines) and paste it as the first message.
3. The session will read the orientation files and reply with confirmation of the branch + environment, then a draft of the Step 1 research approach. Approve or correct it before it runs `xcaddy build`.
4. Subsequent sessions resuming Phase 2c work: paste the same prompt — the session will re-orient itself, see the populated checklist, and pick up at the first unchecked item.
5. When Phase 2c is complete (Step 4), this file should be re-pointed at the dual-platform planning + Phase 22 work in a single follow-up commit.

---

## Appendix: Strategic direction — dual-platform deployment model

This is context for what comes **after** Phase 2c. Do not act on it
during the Phase 2c session. It is included here so the next session
understands why the "stop after Phase 2c" rule is non-negotiable.

**The decision.** ProxyPilot will target both bare-metal Debian
(`host` mode) and IncusOS-hosted LXC (`incus` mode) as first-class
deployment platforms, sharing a single codebase behind a platform
abstraction layer. Neither is a second-class citizen.

**Two platforms.**

- **`host` mode:** ProxyPilot installed directly on a Debian 13 host.
  Full host compliance surface: SSH hardening, AIDE, sysctl tuning,
  host patching with snapshot rollback, host-level audit.
- **`incus` mode:** IncusOS on the host; ProxyPilot inside a Debian
  13 LXC. ProxyPilot talks to the host Incus API to manage sibling
  LXCs. Host compliance delegated to IncusOS (immutable rootfs);
  container compliance remains ProxyPilot's responsibility.

Both run the same binary, same frontend, same schema, same Caddy
generator, same audit log. Only platform-specific bits differ,
behind a `Platform` interface.

**What changes in the plan after Phase 2c.** Two planning artifacts
land before Phase 3 starts:

1. `docs/core/plan/00-deployment-model.md` — dated one-page decision
   doc stating both platforms are first-class, the abstraction is
   introduced in Phase 22, every phase 3+ must implement both
   modes, links from every affected phase file.
2. `docs/core/plan/phase-22-platform-abstraction.md` — new phase
   whose scope is introducing the `Platform` interface with
   `HostPlatform` and `IncusOSPlatform` implementations, migrating
   Phase 2b LXC code into `IncusOSPlatform`, adding a
   `deployment.mode` config read at boot, and adding a startup
   assertion that fails loud if the selected mode is not fully
   implemented for a phase the install depends on. Phase 22 is
   small and structural and runs *before* Phase 3. The interface
   must include `spawnContainer`, `stopContainer`, `deleteContainer`
   from the start even if the first implementations throw
   "not implemented in this phase," AND a `hostCapabilities()`
   method returning a tag-by-concern set (e.g.
   `"file-integrity-monitoring"`, `"ssh-service-hardening"`,
   `"kernel-sysctl-tuning"`) so Phase 18's compliance checker can
   stay tool-agnostic.

**Sequencing rule for Phase 3 onward.** Every phase implements
IncusOS first within the phase, bare-Debian as the second pass
inside the same phase. The phase is only complete when both
verifications pass and the commit note cites both platforms. If one
side is genuinely much larger, split the phase into `N.a IncusOS` +
`N.b host` and block the next phase on both. **Never merge a phase
where one mode is half-done.** When a phase is genuinely not
applicable in one mode (AIDE on IncusOS, SSH hardening on IncusOS,
sysctl on IncusOS — phases 11, 14, 15), the no-op side still must:
return a clean no-op from the `Platform` method, log an info-level
skip at startup, surface in Phase 18's compliance checker as "not
applicable on this platform" rather than "not implemented," and be
documented in the phase file with the reason.

**Phase 17 genuinely splits into two different problems** (host
patching with snapshot rollback vs. container patching). Container
patching is `incus exec apt-get` + reboot. Host patching with
snapshot rollback is a btrfs/ZFS-aware, boot-monitoring state
machine. Budget honestly.

**Federation is out of scope.** No Phase 23 work, no federation
schema, no multi-host UI. But two small design concessions in
Phase 3 onward: (1) backend HTTP API supports machine authentication
(API tokens or mTLS) alongside session cookies; (2) audit log
captures the caller identity (user ID or token ID).

**Test environments.** Every phase's verification requires two
environments: an IncusOS host with a Debian 13 LXC for ProxyPilot,
and a bare Debian 13 VM. Phase 22 will document how to spin up
both. Every subsequent phase's checklist must cite test results
from both.

**Discipline that makes this work.**

1. Never merge a phase where bare-Debian mode is half-done. If one
   mode is harder than the other, split the phase.
2. Every phase verification must cite both environments. If you
   cannot test both, you cannot mark the phase complete. Period.

The failure mode being guarded against is "bare Debian silently
becomes unsupported without anyone deciding it should be." That
would set user expectations the code cannot meet.

**Under no circumstances start modifying Phase 3-21 files or code
while you are still working on Phase 2c.** The sequencing is
strict: Phase 2b ✓ → Phase 2c (current work) → planning commit
(next session) → Phase 22 (next+1 session) → Phase 3.
