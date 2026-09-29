# Next section prompt: finish A6 (run deck, live check, host proof, acceptance)

Do not execute merely by reading this file. Check the gate first, then ask the
decisions below before writing any code or running any host step.

## Where A6 stands (2026-09-29)

- **Built and proven locally:**
  - the Operations "Agent runs" section and run detail (typed activity plus
    live browser frames);
  - the approval dialog (sudo plus at least 12 digest characters);
  - the Agent inbox, consent and read-only rules;
  - the administrators' toggles;
  - 14 browser journeys and 72 layout checks.
- **Merged:** PR #700 (A4–A6) as `469e98a9`, PR #701 (toggles) as `52f26af1`.
- **Deployed:**
  - `52f26af1` staged as candidate `85586aea` and promoted at 09:13Z. Live
    and candidate are both `85586aea`.
  - Rollback tag `pp-rollback-20260929T091306Z` (`33528751`).
  - Database backup
    `/data/db/backups/proxypilot-pre-A6-toggles-promote-20260929T091251Z.db`.
- **Live today:**
  - The toggles are off until an administrator turns them on (Operations →
    Operations settings).
  - Execution is unavailable. The backend container has no supervisor socket,
    key or VM configured; mounting them is A8. Start, Stop and the live view
    say so instead of acting.
- **Not accepted.**
  - The host run (A3 20 with `backend_view`, A4, A5, canary, summary) has not
    run.
  - The **installed** supervisor is still the A5 one (`151f1d24…`), without
    the backend `view`. Only the candidate carries the A6 bytes
    (`9d195ea2…`).

**What "the live view" is.** It is one part of the UI: the **Browser** pane of
a run's detail page.
- While a run is running, it shows the agent's browser as a picture, one frame
  a second.
- The frames come through the supervisor's read-only backend `view`. They are
  pixels only, held in memory, and never stored.
- It is view only: typing, clicking and takeover stay on the host operator
  socket.
- The rest of the UI is typed state from the database:
  - the Activity feed;
  - the approval card and dialog;
  - the result;
  - the Agent inbox;
  - consent and rules;
  - the toggles.
- On the live dashboard today there is no Browser pane to see: no run can
  start until A8, so there is no run detail. Start says why (image 11).

## Gate

1. **A6 is not accepted yet.** `fractionate-agents-a6-evidence.md` has no
   "Acceptance decision" section. If one exists, stop: this prompt is done.
2. **Code.**
   - Start from `main` at `52f26af1` or later, on the designated branch.
   - Never merge, deploy or promote unless the user asks in this
     conversation.
3. **Host state**, read-only, and only when a host step comes:
   - candidate and live `85586aea…`;
   - installed supervisor `151f1d24…`, runner `a631ad9d…`, broker
     `790a1957…`, demo `496846cd…`;
   - receipt key `f6304ffb…`, proof VM boot `62801e3b…`;
   - candidate scripts: supervisor `9d195ea2…`, probe `b770a4a9…`, summary
     `a1dfa05c…`.

   A different value is a question, not a failure.

## Read first

1. The [A6 reference](fractionate-agents-a6-reference.md) (interfaces, the
   host commands H0–H5 updated for the deployed state, rollback order), then
   the [A6 evidence](fractionate-agents-a6-evidence.md).
2. `admin/frontend/src/components/operational-projects/AgentRuns.jsx`
   (`AgentRunDetail`, `feedOf`, `FeedItem`, `FrameDialog`) and
   `agent-run-text.js`.
3. Flightdeck, the reference the user named for this view:
   - `components/mock2/Flightdeck.jsx`: the fixed-height workspace, preview
     beside chat;
   - `components/mock2/MobilePanelBar.jsx`: one panel at a time on phones;
   - `BuildChat.jsx`: chat rhythm.
4. `CLAUDE.md` (the A6 gotcha and the mobile-first rule), then
   `admin/frontend/MOBILE_FIRST.md`.

## The screens as built (real UI, UI harness)

These are captured by `admin/frontend/tests/agent-runs-screens.mjs`. It runs
the real app against the UI harness, with the scripted supervisor's frames
replaced by real screenshots of the local demo site. Dark theme unless noted.

| # | Screen | Image |
|---|---|---|
| 1 | Run detail, desktop 1280, waiting for approval | [01](assets/a6/01-run-live-desktop.jpg) |
| 2 | Approval dialog, desktop | [02](assets/a6/02-approval-dialog-desktop.jpg) |
| 3 | Finished run with the verified result | [03](assets/a6/03-run-result-desktop.jpg) |
| 4 | Agent runs overview | [04](assets/a6/04-runs-overview-desktop.jpg) |
| 5 | Operations page (administrator): Agent inbox and Operations settings | [05](assets/a6/05-operations-settings-and-inbox-desktop.jpg) |
| 6 | Agents tab: model consent and the hard rules | [06](assets/a6/06-profile-consent-and-rules-desktop.jpg) |
| 7 | Run detail on a phone (375), Browser pane | [07](assets/a6/07-run-live-phone.jpg) |
| 8 | Approval dialog on a phone (full-screen) | [08](assets/a6/08-approval-dialog-phone.jpg) |
| 9 | Help request: taken over (768) | [09](assets/a6/09-help-taken-over-tablet.jpg) |
| 10 | Run detail, light theme | [10](assets/a6/10-run-live-light-desktop.jpg) |
| 11 | What the live dashboard shows today: execution unavailable | [11](assets/a6/11-execution-unavailable-desktop.jpg) |

![Run detail as built, desktop](assets/a6/01-run-live-desktop.jpg)

**What the as-built screens get wrong**, which the target below fixes:

- **On desktop the browser is small and below the fold.**
  - The Browser pane is two fifths of the width (about 260 px of picture at
    1280).
  - The approval card, with nine digest fields, pushes the pane and the
    Activity feed below the first screen.
- **The Activity feed repeats pictures.**
  - Every frame is its own "BROWSER" item.
  - The first frame is a blank white page (the browser before its first
    page).
  - Identical pages repeat (steps 4 and 5).
- **On a phone, the approval card, Browser and Activity stack into one long
  page.** Reaching the feed means scrolling past everything else.
- The live state is only a checkbox label. Nothing says "live", "paused" or
  "ended" at a glance.

## Target design: the run deck (written spec and mockups)

These are static mockups of the target, not built. They were rendered from
`assets/a6/target/mockup.html` with real demo frames. Desktop:
[target-desktop](assets/a6/target/target-desktop.jpg). Phone:
[Browser tab](assets/a6/target/target-phone-browser.jpg) and
[Activity tab](assets/a6/target/target-phone-activity.jpg).

![Target run deck, desktop](assets/a6/target/target-desktop.jpg)

### Desktop (`lg` and up)

1. **Run bar** (one card):
   - Left, on one line: the title "Demo sign-in · run 4e0cd8c1", the state
     badges, and the meta line (started by, time, step N of at most M, guide,
     binding and revision).
   - Right: **Back to runs** and **Stop run** (destructive).
   - Refresh stays, and moves into the Details area.
2. **Approval banner** (amber border, one row, only while an approval is open):
   - "Approval needed: <action>";
   - "requested <time> · digest <first 12, grouped> …";
   - **Review and approve** on the right.
   - The nine fields leave the card. The dialog (as built, image 2) and the
     inbox still show all of them, and approving still needs the dialog.
3. **Deck**:
   - A fixed-height grid,
     `lg:grid-cols-[minmax(0,1fr)_380px] lg:h-[calc(100dvh-15rem)] lg:min-h-[30rem]`.
   - Browser on the left. Activity on the right, scrolling on its own.
   - At 1280 × 800, the whole frame and the latest four activity items are
     visible without scrolling the page.
4. **Browser card**:
   - Header:
     - "Browser";
     - a state pill with text: **LIVE** (red dot) while frames arrive,
       **Paused** when watching is off, **Ended** after the run;
     - the "Watch live (view only)" switch (`role="switch"`, a 44 px row);
     - an **Enlarge** button (44 × 44) that opens the existing `FrameDialog`.
   - The frame: `aspect-[16/10] object-contain` on a near-black inset.
   - Caption under the frame: "At step N · <action words> · captured <time>".
     After the run it reads "Last frame · at step N".
   - One muted line: "One frame a second while the run is live; pixels only,
     never stored. Typing, clicking and takeover stay on the host."
   - Before the first page there is no blank frame. The pane shows "Starting
     the browser…" until step 1 has finished; frames captured before that
     are not shown.
5. **Activity column** (chat rhythm, newest last):
   - A header, "Activity · N events".
   - Each item: a kind chip (text and colour: SYSTEM neutral, RULE blue,
     MODEL violet, APPROVAL amber, PERSON green, RESULT by class), the time,
     a one-line title and one muted line.
   - Frames attach to the step they were captured at, as an 88 px thumbnail
     at the right of that step item (click to enlarge). They are not separate
     items.
   - A frame identical to the previous one (same base64) is not shown again.
   - The open approval is an amber-bordered item. Under it is "The agent is
     paused until approval" (`aria-live="polite"`, no animation under
     `prefers-reduced-motion`).
   - The feed follows the newest item unless the reader has scrolled up. Then
     a **Jump to latest (n new)** pill appears.
6. **Details** under the deck:
   - Tabs **Result · Model calls (n) · Approvals (n) · Pins**, with arrow-key
     navigation. They replace the three disclosures.
   - Result is selected when the run ends. The result summary (as built,
     image 3) moves there unchanged.

### Phone (below `lg`)

1. **Header**:
   - "Back to runs";
   - the title and badges;
   - a 44 px **Stop** at the right of the title, destructive.
2. **Approval banner** sticky under the header:
   - On the Browser tab: the full compact form (title, digest prefix, a
     full-width **Review and approve**).
   - On the Activity tab: one row, "Approval needed" and **Review**.
3. **One panel at a time**, following `MobilePanelBar`:
   - A bottom bar with **Browser · Activity (n) · Details**. Each tab has an
     icon and a label, is at least 44 px high, and the bar respects
     `env(safe-area-inset-bottom)`.
   - Browser is the default while a run is running; Details after it ends.
   - The chosen panel is kept in the URL (`&panel=`), so refresh returns to
     it.
4. **Browser tab**: the frame at full width, the state pill, the caption, the
   switch row and the note.
5. **Activity tab**: the same items as desktop, with thumbnails at 72 px.
6. **The approval dialog is unchanged** (full-screen below `sm`, image 8).

### Everywhere

- Use the app's existing tokens only (`bg-card`, `border`,
  `text-muted-foreground`, `primary`, `destructive`, amber as now), in both
  themes. There are no new colours outside Tailwind's defaults and no new
  fonts. Default breakpoints only.
- Words: every new sentence goes in `agent-run-text.js`. The existing
  sentences stay unless this spec replaces them.
- Focus order: run bar → approval → Browser → Activity → Details. Each
  control that cannot act still says why (`aria-describedby`), as today.
- **No data change.** The same routes and fields: no new route, no new
  field, no new socket method, no new MCP surface. Frames stay in memory
  only. The deck is a layout over what `GET /:id/agent-runs/:runId` and
  `/view` already return.

## Decisions to ask the user before writing code

1. **The run deck.**
   - **Build it as specified (recommended).**
   - Or keep the screens as built and accept A6 on the host proof alone.
   - Or change the spec first. Show the three target images and the as-built
     images 1 and 7 when asking.
2. **Execution on the live dashboard.**
   - **Keep it unavailable until A8 (recommended).**
   - The alternative, pulling the supervisor socket mount forward, is a
     boundary decision: root peers only, the container user, the key and VM
     configuration, S6. It needs its own design and host proof, and is not
     part of this prompt.
3. **Order.**
   - **Host run first (recommended).** It needs no code change: the
     candidate already holds the A6 script bytes.
   - The run deck follows and changes no host script.
   - Or build the deck first and stage it before the host run.

## Scope

**Part A: the run deck** (only if decision 1 is to build).
- Files:
  - `AgentRuns.jsx` (`AgentRunDetail`, `feedOf`, `FeedItem`); a new
    `RunDeck.jsx` if it keeps the file readable;
  - `agent-run-text.js`;
  - reuse `MobilePanelBar` rather than copying it.
- Journeys in `agent-runs.browser.mjs`: update the selectors, and keep every
  existing journey. Add these:
  - At 1280 × 800, the frame's box and the latest activity item are inside
    the viewport while an approval is open.
  - A phone panel switch survives a refresh (`&panel=`).
  - Follow-latest: new items keep the view at the bottom. A scrolled-up
    reader sees **Jump to latest** and is not moved.
  - There is no blank first frame, and an identical frame is not repeated.
  - Paused and Ended pills, and "Last frame · at step N".
  - Tabs by keyboard.
  - The six-width, two-theme layout check.
  - Every control acts or says why.
- Regenerate the as-built screens with `agent-runs-screens.mjs`, then compare
  them with the target mockups side by side in the evidence.
- The `MOBILE_FIRST.md` pre-merge checklist, recorded.

**Part B: the live dashboard check** (the user, in a browser; read-only).
1. Operations → Operations settings: turn on Operations, then Agent metadata,
   then Agent runs. Sudo is asked; three audit rows result.
2. The Agent runs section shows "Execution is unavailable: no worker
   supervisor is configured on this installation." Start is disabled with
   that reason (image 11).
3. Nothing launches.
4. The user decides whether the toggles stay on.

**Part C: host run 1** (required). Steps H0–H5 are in the
[A6 reference](fractionate-agents-a6-reference.md#host-commands-a6-host-run-1-required-not-yet-run),
updated for the deployed state:

| Step | What it does | Expected |
|---|---|---|
| H0 | Read-only state | Candidate `85586aea…` and its script digests; installed supervisor `151f1d24…`, runner `a631ad9d…`, key `f6304ffb…`, broker `790a1957…` `approle_login ok`; `"active": null` |
| H1 | Reinstall the supervisor from the candidate (no staging), proxy proof | Supervisor `9d195ea2…`, a new key, `accepting_launch`, `blockers: []`; `proxy_checks passed` (21) |
| H2 | New binding, the full A3 proof (20 with `backend_view`), A4 proof, A4 canary | `a3_exit=0`, `a4_exit=0`, canary passed |
| H3 | A5 proof with one real human approval (type at least 12 digest characters), A5 canary | 17 cases passed, `a5_exit=0`, canary passed |
| H4 | Read-only summary | `"all_passed": true`, `summary_exit=0`; paste the whole document |
| H5 | From the session: `run_self_checks` (`backend-tests`, `backend-syntax`), `get_host_services proxypilot-a`, `inspect_a3_vm` | 0 fail; services active; the VM boot changed in H2 |

Rules for the host run:
- One paste per step, run as root, in a terminal where the person can type.
- Review each output before the next step.
- No secret or scan marker on a command line: H2 names vault keys, never
  values.
- A step that fails stops the run. Report the marker and the journal lines;
  never retry blindly.

**Part D: deploy the deck** (only if built, and only when the user asks).
1. The PR is merged by the user's word.
2. Stage the merge commit on the candidate with `a3-stage-candidate.sh` (one
   root paste).
3. `run_self_checks` (`backend-tests`, `backend-syntax`). Since the
   2026-09-29 deploy, the live policy's install step restores the native
   addon itself. A frontend build proof runs inside `proxypilot-admin`:
   `npm ci --include=dev`, then `npm run build`.
4. `backup_proxypilot_db`.
5. The `promote_self` preview, shown to the user, then the promote on their
   word.
6. `get_proxypilot_update_status` until success, then `get_self_status`.

**Part E: the acceptance decision** (user). Present:
- the H4 summary;
- the canary results;
- the journeys;
- the live check;
- the open items below.

Then record the decision.

## Preserve

Everything in the [A6 prompt](fractionate-agents-a6-prompt.md) § Preserve
still applies. The short form:
- **Human-only.** No MCP tool, catalog entry or allowlist starts, approves or
  stops a run, reaches the live view or changes a toggle.
- **The only A6 widening** is the backend socket's read-only `view`.
- **Frames** are pixels, in memory only.
- **The UI never receives** a receipt body, prompt, page text, value, cookie
  or token.
- **Migrations** 1100–1111 are immutable.
- **Untouchable:**
  - `pp-nodus` and `nodus.fractionate.ai`;
  - never `--upgrade-incus`, and never bypass managed-LXC refusals;
  - keep the untracked `scripts/tests/a3-vm-probe.zip`.

## Out of scope

- A7: resume after takeover, reconciling uncertain steps, practice runs.
- A8: the container socket mount (unless decision 2 changes), a real target,
  release gates.
- Fixing the A5 carried items:
  - the origin proxy's resend-after-timeout;
  - the one `open_landing` timeout;
  - the locally-proven classes;
  - S6, SEC-01, SEC-04;
  - host reboot persistence.
- The sidebar brand truncation at 1280 ("Fraction…"): it predates A6.

## Proofs

- **Local:**
  - `node --test src/__tests__/operational-*.test.js src/__tests__/operations-toggles.test.js`;
  - the Python suites (`test_a[3456]*py`);
  - `host-boundary-inventory.py`;
  - the frontend build;
  - `node tests/agent-runs.browser.mjs` (all journeys);
  - `node tests/agent-runs-screens.mjs` (screens regenerated).
- **Live:** the Part B check, as seen by the user.
- **Target:** host run 1 (H0–H5), with the summary pasted whole.

## Record and stop

- Evidence: add dated sections for the deck (if built), the live check, the
  host run, and the acceptance decision in the form
  "Acceptance decision: A6 is ACCEPTED (<date>)", with its open items named.
- Update:
  - the reference (revisions, installed digests, new receipt key, VM boot);
  - the A6 row of `fractionate-agents-a1-a8.md`;
  - the A6 gotcha in `CLAUDE.md`;
  - the A7 prompt's gate facts.
- Then stop. Do not start A7.
