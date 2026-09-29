# A6 supervision UI — evidence

**A6 is implemented and proven locally; it is NOT accepted.** The supervisor's
backend socket gained one read-only method (`view`, user decision 4), so the
A3/A4/A5 target proofs must rerun on the proof host with the new A3 case
`backend_view`. The host steps are in the
[A6 reference](fractionate-agents-a6-reference.md) (H0–H5, all required) and
have not been run. Nothing is activated, merged, deployed or promoted; no PR
was opened.

The [A6 reference](fractionate-agents-a6-reference.md) is the orientation page.
This file is the record: later dated sections win.

## 2026-09-29 gate check, decisions, implementation and local verification

### Gate

1. **A5 is ACCEPTED.** `fractionate-agents-a5-evidence.md` on
   `claude/beautiful-maxwell-9bldxg` carries "Acceptance decision: A5 is
   ACCEPTED (2026-09-29)" (host run 3) with its open items named: A3 19/19, A4
   6/6, A5 17/17 with one real human approval, canary 0, candidate
   `backend-tests` 0 fail. Nothing later reverses it.
2. **Where the code lives.** A4 and A5 are not in `main` (`0b743b22`): PR #699
   (A4) is an open draft, A5 has no PR, PR #686 is an open draft. The A6 prompt
   exists only on the A5 branch (head `5210cfb7`). **Asked the user** (below).
   Nothing was merged, un-drafted or closed.
3. **Host state, read-only (MCP, 2026-09-29 ~01:55 UTC)**, because a host step
   is needed:

   | What | Observed | Expected |
   |---|---|---|
   | Candidate | `8d25755c8853e302a15a66855cd35207365373d1`, 29 ahead, clean; last checks `backend-tests` and `backend-syntax` ok | `8d25755c…` |
   | Live checkout | `33528751…`, `main`, clean | `33528751…` |
   | Proof VM | UUID `49592202-…`, boot `62801e3b-8419-40aa-85bf-dffab35788c2`, running, 2 vCPU / 4096 MiB / 12 GiB, no swap | boot `62801e3b…` |
   | Services | fence active/exited; origin proxy, supervisor, broker active/running; renewal timer active/waiting | matches |

   The installed digests (supervisor `151f1d24…`, runner `a631ad9d…`, broker
   `790a1957…`, demo `496846cd…`) and the receipt key `f6304ffb…` are read by
   host root only; step H0 prints them before any change.
   - The candidate's copies of the six shared files A6 changes
     (`index.js`, `routes/operational-projects.js`, `.env.example`, the two
     Operations pages, `Agents.jsx`) are byte-identical to the staging base
     `12ad1392` (read with `read_self_file` and compared by sha256), so
     `a3-stage-candidate.sh` will accept them.

### Decisions (user, 2026-09-29)

| # | Question | Answer |
|---|---|---|
| Base | Build on the A5 head, which branch | The A5 head `5210cfb7`, on the designated branch `ccr-4216e4d3-jsij65` (fast-forwarded from `main`; the A5 branch untouched) |
| 1 | Where a run executes behind the UI | **Option A**: new false-default flag, `EXECUTION_UNAVAILABLE` without a supervisor, journeys against a separate UI harness; nothing live changes |
| 2 | The approval gesture | **Sudo + at least the first 12 characters of the digest** |
| 3 | Four-eyes | **Allow** the starter to approve |
| 4 | The view-only stream | **Both** — "reference ProxyPilot Flightdeck chat (for text based and screenshots), should stream the browser and agent control" |

Decision 4 is the boundary decision the prompt names. It was implemented as
the narrowest form that meets it: a new read-only method on the **backend**
socket rather than a backend path to the operator socket (which would reach
takeover, input and the proof workloads). It needs its own host proof.

### What changed

**Supervisor** (`scripts/a3-worker-supervisor.py`, `9d195ea2…`): the backend
method set gains `view`, served by `backend_view`:
- only the coordinator's running browser attempt (`running`; a takeover's
  `human` state answers `TAKEN_OVER`), within the lease and deadline, fence
  checked;
- never renews the lease (the operator's view renews only during a takeover);
- one frame in flight per attempt and at most one per second (`VIEW_BUSY`);
- the reply is `frame_only`: `{png_base64, width, height}`, PNG magic,
  ≤ 3 MiB base64, sides 1..4096, else `VIEW_INVALID`; the runner's
  `untrusted_page_url` is dropped;
- not journaled. The runner is unchanged (`a631ad9d…`): it types a bound value
  only into an `input[type="password"]`, so a frame shows it masked.

The operator socket keeps its own `view` (with the URL) and every other
operator control. `input`, `observe`, `takeover`, `journal` and the proof
workloads stay operator-only (the A3 test asserts `METHOD_NOT_ALLOWED` on the
backend socket for `takeover`, `input` and `observe`).

**A3 probe** (`a3-probe-worker.py`): new case `backend_view` (the A3 proof now
has 20 cases). On a backend-launched attempt it checks the exact reply keys,
the PNG magic and 1280×800, `VIEW_BUSY` for an immediate second frame, that the
journal lease did not move, `INVALID_REQUEST` for an extra field, that the
operator view still carries the URL, `TAKEN_OVER` during a takeover,
`METHOD_NOT_ALLOWED` for backend `input`, and `ATTEMPT_NOT_ACTIVE` after stop;
it saves the frame and verifies the receipt.

**Backend:**
- `lib/operational-worker-supervisor.js`: `view` in the client's method set.
- `lib/operational-worker-boundary.js`: `launcher.view(ref)` validates the
  reply again (exact keys, base64, PNG magic, size, dimensions).
- `lib/operational-agent-runs.js` (new): the A6 service. Typed projections only
  (the result's receipt becomes `{verified, key_id}`; model calls lose the
  provider response ID; claims are the stored typed claims). Operations access
  semantics (outsider 404, member without `run` 403 with the words). Start,
  Stop and Approve go to the **unchanged** A5 coordinator; `execute` runs in the
  background; Stop answers 200 once the receipt is collected or 202 while it
  comes. Approve checks the typed prefix (whitespace and case ignored, 12–64
  hex, a prefix of the digest shown) and passes the shown digest to
  `coordinator.approve` with `elevated: true` only behind `requireSudo`. Inbox
  (pending approvals on running runs where the caller has run access) and help
  requests (the latest needs-human result per profile). Parsed rules or the
  typed parse refusal. Readiness reasons per profile, in words. The live frame:
  access re-checked on every request, one supervisor call per run at a time,
  cached 1.5 s in memory, dropped when the run ends; never stored or logged.
- `lib/operational-agent-runtime.js` (new): `OPERATIONS_AGENT_RUNS_ENABLED`
  (plus Operations and agent metadata) and the supervisor socket, public key
  and VM UUID. No supervisor configured → a service without a coordinator:
  every execution control answers `EXECUTION_UNAVAILABLE` (503 with the reason)
  and nothing launches.
- `routes/operational-projects.js`: the routes in the reference, behind
  `agentRunsOnly`, through `agentHandle` (typed `code`, audited 401/403/404
  denials); `requireSudo` is injected (the default refuses with the sudo
  envelope). `/agent-approvals` is registered before `/:id`.
- `index.js`: builds the runtime; `recover()` at boot only with a coordinator.
- No migration: A6 reads migrations 1106–1111 and writes nothing new.

**UI** (`MOBILE_FIRST.md` applies):
- `OperationalProjectDetail.jsx`: an "Agent runs" section (capability-gated;
  `?section=Agent%20runs&run=<id>` survives refresh). A dev-only StrictMode
  glitch (an aborted first request showed "signal is aborted without reason")
  is now ignored when its own controller aborted.
- `AgentRuns.jsx`:
  - `AgentRunsPanel`: execution note, Start per profile (disabled with the
    reasons listed and referenced by `aria-describedby`), the runs list
    (state, result, needs a person, awaiting approval, started by, when).
  - `AgentRunDetail`: Stop (or why not), the help banner, the approval card,
    and — modelled on Flightdeck chat — a live **Browser** pane (polled frame,
    view only, pausable, sticky on desktop, first on phones) beside an
    **Activity** feed of typed durable state (each step with who decided it —
    rule name or the model and its allowed set, tokens and cost — typed
    claims, error codes; approvals; fence events; the result) with the frames
    captured while watching inline as screenshots. Model calls, approvals
    (every digest field) and pins in disclosures. `aria-live` announcements
    for new steps, approvals, state changes and the result.
  - `ApprovalDialog`: the digest's fields and the digest in groups of four,
    the typed prefix with live feedback, Approve disabled until it matches
    (with the reason), sudo through the api.js modal; a stale, duplicate,
    raced, revoked or no-longer-listed approval turns the dialog into the
    refusal with only Close.
  - `AgentInbox` on the Operations page: pending approvals (fields, digest,
    Review and approve, Open the run) and help requests with the decision in
    words.
- `Agents.jsx`: owner consent (reviewed statement checkbox, withdraw), a
  read-only "Hard rules enforced by code" view, the A2 "disabled" wording
  replaced when runs are on, and a reason under the pre-existing "Assign
  current approved guide" button when it is disabled.
- `agent-run-text.js`: every sentence about states, actions, rules, claims,
  result classes, help decisions and stale reasons.

**UI harness** (`admin/frontend/tests/agent-runs-harness.mjs`): the real app
through Vite, the real Operations router and stores, the real A5 coordinator
and A6 service on an in-memory `node:sqlite` database, the real CSRF
middleware, and a scripted supervisor (`helpers/agent-runs-world.js`) behind
the real `createWorkerLauncher` and the real receipt verifier (it signs
Ed25519 receipts and serves real PNG frames). Only the session cookie and the
sudo check are fixtures. `index.js` never imports it.

### Local verification (this session, code `5a8648f5`)

| Check | Result |
|---|---|
| `node --test src/__tests__/operational-*.test.js` | **110/110** (15 new in `operational-agent-runs.test.js`, 1 new launcher test) |
| Full backend `npm test` | 3386 pass, **11 fail**, 14 skipped of 3411. The same 11 fail on the untouched A5 head in this sandbox (run with the A6 changes stashed): 4 files `ERR_MODULE_NOT_FOUND` on `cli/node_modules` (`bcryptjs`, `better-sqlite3`), and source-ratchet assertions in `frontend-api-client`, `immediate-repairs`, `platform-overview`, `setup-post-launch` that A6 does not touch. Host run 3 had the candidate at 0 fail |
| `python3 -m unittest discover -s scripts/tests -p 'test_a[3456]*py'` | **151 OK** (2 environment-conditional skips), including the new supervisor tests and `test_a6_host_summary.py` |
| `python3 scripts/host-boundary-inventory.py` (no suppression) | 96 files inventoried, exit 0; S6 open |
| `npm run build` (frontend) | built |
| `npm run demo:build && npm run demo:test` | 3/3 |
| Browser journeys `node tests/agent-runs.browser.mjs` (Chromium 1194) | **13/13, 60 layout checks** |

Backend tests cover:
- flags (every route 404 when off; manual `/runs` untouched);
- configuration (off by default, `not_configured`, `invalid_configuration`,
  a bad key; no launch and no run row without execution);
- roles (owner, operator, editor, reviewer start; viewer 403 with the reason;
  outsider 404; denials audited; rules readable by a viewer);
- the full run through the routes (duplicate start → `RUN_ALREADY_ACTIVE`
  with the active run; inbox per role; no sudo → 401 envelope; 11 characters,
  a wrong prefix and another digest refused; viewer 403; outsider 404; 13
  characters with capitals and spaces accepted; a second approve refused; the
  verified result with the supervisor's key ID; the exact step/rule/model
  timeline; no receipt body, attestation, page text, prompt ID or vault path
  in any response);
- the starter approving their own run (decision 3);
- stop mid-run; a stop whose supervisor call fails leaves the run fenced
  (`SUPERVISOR_UNREACHABLE`, 503) and a second Stop collects the verified
  receipt (no submit, never resumed); both orders of the approval/stop race
  (no submit);
- stale approvals after a rotated binding, a revoked binding and a newly
  approved guide;
- a removed grant: view, status, list and approve refused at the next request;
- the view (pixels only, one supervisor call for three concurrent viewers,
  exact supervisor request, viewer 403, `VIEW_UNAVAILABLE` after the end);
- every outcome class plus uncertain step, uncertain model call, budget and
  takeover, with help requests in the inbox;
- restart recovery (`interrupted`, the step `COORDINATOR_RESTART`, receipt
  verified, the help request keeps its class);
- consent and rules routes (`If-Match`, statement, owner only, parse refusal);
- a ratchet: no MCP tool, catalog entry or policy file references agent runs,
  approvals, the view or consent.

Browser journeys (report in the session scratchpad; screenshots reviewed by
eye at 360, 768 and 1280 in both themes):

| Journey | Proves |
|---|---|
| Roles | owner, operator, editor, reviewer see Start enabled; viewer sees why not and the read-only rules and consent; outsider gets "Operational record not found" |
| Full flow (operator) | start; rule steps; live frame; the inbox shows the approval to a reviewer; 11 characters and a wrong character keep Approve disabled with the reason; 13 characters approve; the sudo modal (password + TOTP) appears and completes; verified result with the receipt key; Stop and view say why they are gone; frames in the feed; no attestation, injected text or vault path on the page |
| Stop mid-run (editor) | Stopped result, no submit sent |
| Stale approval, binding rotated | the dialog becomes "The approval is stale … Reason: the run, its binding, the guide or the policy changed." with only Close; result Approval stale |
| Stale approval, new guide | stale; then Start lists "The assigned guide is no longer the current approved version."; the owner reassigns in Agents; Ready again |
| Owner consent | withdrawing makes Start say why for an editor; the editor cannot change it; giving needs the reviewed statement |
| Approval racing a stop | the owner stops from another session; the operator's open dialog closes itself ("closed (stale: the run was stopping)"); no submit |
| Revoked grant while viewing | the owner revokes the operator in Access; the operator's run page shows the refusal and no more frames are requested |
| Refresh and reconnect at 360 px | reload during the approval shows the durable card again; 3.5 s offline and back; the dialog passes the layout checks at six widths and is completed at 360 px with sudo |
| Keyboard only | Tab to Start (visible focus ring asserted), Enter; Tab to Review and approve (ring asserted), Enter; Tab to the digest input, type, Enter; sudo by keyboard; verified result |
| Result classes | credential rejected, rate limited, challenge required, unexpected origin, timed out, account not verified, budget exhausted, uncertain model call, uncertain step, taken over, interrupted: the label and explanation each time; the help banner exactly for the five human-decision classes; the inbox lists the open help request with its decision and links to the run |
| Layout | run detail with a pending approval and a live frame, the inbox, the overview and Agents with the rules open, at 360/375/390/768/1280/1920 in light and dark: no horizontal scroll (page or any element), every visible button and link in `main` ≥ 44×44 below 640 px, no disabled control without a stated reason |
| Execution unavailable | a harness without a supervisor: the note, Start disabled with the reason, the inbox note, no supervisor call |

### MOBILE_FIRST pre-merge checklist (recorded)

- [x] Builds (`npm run build`) and runs under Vite dev without errors (page
  errors asserted empty in the role, flow, stop and layout journeys).
- [x] 360 px: every A6 route renders with no horizontal scroll (automated at
  360/375/390/768/1280/1920, page and element level, both themes).
- [x] 375 px: the approval dialog is full-screen below `sm` and completable
  end to end (completed at 360 px, including the sudo modal and Close).
- [x] 768 px: reviewed screenshots (two-column profile form, full-width run
  detail); not an upscaled phone.
- [x] 1280/1920 px: activity left and a sticky browser right; existing
  sections unchanged.
- [x] Touch targets: every visible button and link in `main` ≥ 44×44 below
  640 px (automated). The shared dialog close "X" is the existing primitive;
  each A6 dialog also has a full-width Close or Cancel button.
- [x] Dialogs: `max-w-full h-full rounded-none` below `sm`.
- [x] Grids start at one column (`grid-cols-1 sm:grid-cols-2|3`,
  `lg:grid-cols-5`).
- [ ] Lighthouse mobile accessibility ≥ 90: not run (no Lighthouse in this
  sandbox). Covered in part by the journeys: labelled inputs, `role="alert"`
  refusals, `aria-live` status, `aria-describedby` reasons, visible focus.

### Findings

- **Help classification (found by the journeys, fixed before commit).** An
  interrupted run with an uncertain step was labelled "Uncertain step" in the
  help banner; it now keeps its own class and states the uncertain steps as an
  extra line (a backend test pins it).
- **Dev-only abort message** on the operation page under React StrictMode
  (pre-existing, not A6's); fixed by ignoring a request aborted by its own
  unmount.
- **A stuck stop (found in review, fixed):** when the supervisor did not
  answer the stop, the run stayed fenced in `cancelling` and the UI offered no
  way to retry collecting the receipt (and the refusal was a generic 500).
  Stop now stays available there as a retry, and the supervisor codes have
  their own words and statuses.
- **Frame timing:** `action_count` counts reserved steps, so a frame captured
  during step N is labelled "at step N", not "after".

### Open (A6 acceptance needs these)

1. **Host run 1** (reference steps H0–H5): the supervisor with backend `view`
   installed; A3 20/20 including `backend_view`; A4 6/6; A5 17/17 with one
   real human approval; both canary scans 0 (values and markers); the summary
   `all_passed: true`; the candidate `backend-tests` 0 fail.
2. **The acceptance decision** (user).
3. Carried, not absorbed: the origin proxy's resend-after-timeout; the one
   `open_landing` timeout; the locally-proven classes (out-of-set model reply,
   unknown usage, `timeout`); host reboot persistence; S6 / SEC-01 / SEC-04;
   the container socket mount and a live run behind the UI (A8).
4. Lighthouse mobile accessibility score (not available here).
5. No exact-head Security CI: only on a draft PR, if the user asks for one.

## 2026-09-29 merge; activation becomes dashboard toggles

### Merge

At the user's request, PR #700 (this branch: A4, A5 and A6) was merged into
`main` as `469e98a9` with a merge commit, so the SHAs these documents cite
stay reachable. GitHub marked draft PR #699 (A4) merged because its head is
now in `main`. Six checks passed. `audit (admin/backend)` failed on
GHSA-6vj9-mwq6-2f5v (nodemailer ≤ 10.0.1, moderate). The PR does not touch the
backend's package files, and `main` fails the same audit. The fix, nodemailer
10, is a major upgrade and a separate change; this is recorded on the PR.

### Deploy attempt

The candidate slot needs the A6 code before `promote_self`. Sending the code
patch to the host over MCP (`apply_self_patch` via an upload ticket) was denied
by the session's safety check as data exfiltration, and the sandbox cannot
reach the host's upload URL. The GitHub update path (`run_proxypilot_update`)
runs `git pull origin main` in a live checkout that sits on a local commit
(`33528751`) GitHub does not know, so it would merge divergent history; it was
not used. The live host is unchanged.

### Decision (user, 2026-09-29): toggles, not env

The user asked first for the three switches to be on by default; that was
declined by the session's safety check as weakening a security gate, and
nothing was changed. The user then asked for **toggles, not env**. Implemented:
- `lib/operations-toggles.js` has three toggles: Operations, Agent metadata
  and Agent runs. Each requires the one before it. They are stored as
  `operations_toggle:*` rows in `app_settings` and are **off until an
  administrator turns them on**. The only writer re-reads the role from the
  database and writes the setting and one `OPERATIONS_TOGGLE_CHANGED` audit
  row in one transaction.
- `routes/operations-settings.js` serves `GET /api/operations-settings`
  (administrators) and `PUT /api/operations-settings/:name` (administrators
  plus sudo; the body is exactly `{enabled}`; turning one on before the one it
  requires answers 409).
- The Operations router takes the switches as getters read on every request.
  A change takes effect at once, with no restart; capabilities add
  `can_manage_settings`.
- The env vars `OPERATIONS_ENABLED`, `OPERATIONS_AGENTS_METADATA_ENABLED` and
  `OPERATIONS_AGENT_RUNS_ENABLED` are removed. Evidence keeps its own env
  switches; the Operations toggle now stands in for `OPERATIONS_ENABLED`
  there. The supervisor socket, key and VM stay configuration.
- UI: `OperationsSettings.jsx` on the Operations page, in one stable place.
  Administrators always see the Operations sidebar entry; others see it only
  when Operations is on. The sidebar refreshes when a toggle changes.
- MCP cannot reach the toggles: they are not in the `set_setting` allowlist or
  the feature-flag policy. A ratchet test also refuses the old env names in
  any backend source file.

### Local verification (toggles)

| Check | Result |
|---|---|
| `node --test src/__tests__/operational-*.test.js src/__tests__/operations-toggles.test.js` | 114/114 (4 new) |
| Browser journeys | **14/14, 72 layout checks**, including the new toggles journey |
| Frontend build | built |

What the new journey checks:
- a person sees "not turned on" and no sidebar entry;
- at 375 px, an administrator sees the three toggles, with Agent runs
  disabled and a stated reason;
- turning Operations on asks for sudo; the page switches on;
- Agent metadata and Agent runs follow; the Agent inbox appears;
- three audit rows are written;
- the person can then start runs;
- turning Operations off shuts it for the person at the next request;
- no supervisor call is made.

**Finding (fixed):** the first run of that journey caught the settings panel
remounting when Operations switched on, which dropped its confirmation. The
panel now sits in one stable place on the page.
