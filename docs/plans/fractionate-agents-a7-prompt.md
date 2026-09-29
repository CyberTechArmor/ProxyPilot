# Next section prompt: A7, practice and recovery

Do not execute merely by reading this file. Check the gate first, then ask the
decisions below before writing any code.

## Gate

1. **A6 must be ACCEPTED.** `fractionate-agents-a6-evidence.md` must carry an
   "Acceptance decision: A6 is ACCEPTED (<date>)" section recording the A6
   host run with its open items named:
   - the supervisor with the backend `view` installed;
   - A3 20/20 including `backend_view`, A4 6/6, A5 17/17 with one real human
     approval;
   - both canary scans 0 (values and markers);
   - `a6-host-summary.py` printing `"all_passed": true`;
   - the candidate `backend-tests` 0 fail.

   As of 2026-09-29 it does **not**: A6 is implemented, proven locally
   (14 browser journeys, 72 layout checks), merged and deployed (live
   `85586aea`), and its host steps H0–H5 are pending
   ([A6 finish prompt](fractionate-agents-a6-finish-prompt.md)). The finish
   decisions were: build the run deck, keep execution unavailable until A8,
   and run the host proof first. The run deck (`RunDeck.jsx`,
   `run-deck-logic.js`; 19 journeys, 96 layout checks) is built on branch
   `ccr-11407794-0pxrze` and is not merged. If the gate does not hold, stop
   and name it.
2. **Where the code lives.**
   - A4–A6 are in `main`: PR #700 merged as `469e98a9` and the toggles
     (PR #701) as `52f26af1`. Start from `main` at the A6 acceptance commit
     or later, on the designated branch.
   - Never merge, un-draft or close a PR yourself.
3. **Host state**, read-only, only if a host step is needed: the candidate
   and live SHAs, the installed supervisor/runner/broker/demo digests, the
   receipt key and the proof VM boot from the A6 acceptance section. A
   different value is a question, not a failure.

## Read first, in this order

1. The [A6 reference](fractionate-agents-a6-reference.md) and
   [A6 evidence](fractionate-agents-a6-evidence.md), then the
   [A5 reference](fractionate-agents-a5-reference.md) (coordinator, result
   classes, recovery, harness cases).
2. The code A7 builds on:
   - `admin/backend/src/lib/operational-run-coordinator.js` (`recover`,
     `terminate`, `awaitTakeover`, the `NEEDS_HUMAN` classes) and
     `operational-worker-boundary.js` (`recover`, fences, attempts);
   - `admin/backend/src/lib/operational-agent-runs.js` (help requests, the
     inbox, the in-memory frame cache) and
     `components/operational-projects/AgentRuns.jsx`, `RunDeck.jsx` (the
     Browser pane the dashboard takeover goes into) and `run-deck-logic.js`;
   - `scripts/a3-worker-supervisor.py` (takeover, the operator socket, the
     journal's uncertain actions, the receipt's `uncertain_actions`,
     `backend_view` and `frame_only`);
   - `scripts/a3-worker-operator.py` (`human`: today's host-only page with
     the view, Take over, Stop and the bounded input on one screen);
   - `scripts/a3-worker-guest.py` (`submit_bound_fixture` clears both login
     fields in a `finally`; the input vocabulary `validate_input`);
   - `scripts/a5-probe.mjs` (`coordinator_restart`, `takeover`,
     `operator_stop`).
3. `CLAUDE.md` (the A3–A6 gotchas and the mobile-first UI rule), then
   `admin/frontend/MOBILE_FIRST.md`.
4. The A7 row of `fractionate-agents-a1-a8.md`, and in
   `fractionate-agents-a1-acceptance.md` the A7 row and "Cross-cutting
   negative cases".

## Goal

Practice and recovery for the one synthetic sign-in workflow:
- **Rehearsal:** a disposable practice run through the same policy and worker
  path with the synthetic account, marked as practice everywhere it appears.
- **Interruptions:** kill the coordinator or the worker mid-read, mid-approval
  and mid-write; every case ends in a durable terminal result, never a blind
  replay.
- **Reconciliation:** a person resolves each uncertain step or model call
  with a typed decision (for example "the sign-in happened" / "it did not" /
  "unknown, leave blocked"), recorded and audited; nothing is re-sent on
  their behalf.
- **Takeover in the dashboard and resume:** a real-time view and takeover on
  the same screen, the run deck's Browser pane. That means explicit human
  takeover ownership from the dashboard (see the user's direction below) and
  an explicit resume that starts a new attempt with a new fence, never the
  old attempt.
- **Basic critique:** a short, typed summary of what went well or wrong per
  run, from durable state only.

## User direction on takeover (2026-09-29, decided)

The user asked for this before A7 starts. It answers what used to be
decision 1 ("where takeover is driven").

1. **Takeover is in the dashboard, on the same screen as the live view.**
   - It goes in the run deck's Browser pane: a Take over control, then
     clicks on the frame, fixed keys, bounded text and scroll.
   - The host page (`a3-worker-operator.py human`) stays as the root
     fallback. It is no longer the only way to take over.
2. **Who may take over: anyone with run access** (owner, operator, editor,
   reviewer), the same people who may start, stop and approve. Viewers and
   outsiders may not.
   - A regular user gets no host sudo or root and no new dashboard role.
     Taking over from the dashboard grants control of that one attempt's
     browser, through the backend, and nothing else.
3. **The gesture: re-enter one's own password and TOTP at Take over.**
   - This is the dashboard's `requireSudo` re-authentication, as for
     approval. It proves who is acting and grants no privilege; any user
     with TOTP can do it for their own session.
   - It is asked because takeover hands a person a signed-in session.
4. **Real time.**
   - One frame every 2 s is too slow to click on. While a person watches
     and while they hold control, the view must be near real time and
     pushed to the page.
   - The technology is decision 1 below. The user expected Neko. Neko is
     named nowhere in the A1–A6 documents or the repository, so this
     direction is where it enters the plan.
5. **After a takeover.** Today the run ends as `taken_over` (blocked, a help
   request in the inbox) once the person finishes. Handing back to the agent
   is decision 2 (resume).
6. **Record.**
   - Record who took over, when, for how long, and the count and kind of
     inputs, never the typed text: it may be an MFA code.
   - Frames stay in memory only.
   - No MCP tool, catalog entry or policy allowlist reaches takeover, input
     or the stream.

**What this widens, and must prove on the host** (like A6's
`backend_view`):
- **The new backend path.** The dashboard's backend gains `takeover` and
  `input`, on its socket or on a dedicated third socket. Anyone who controls
  the backend process could then drive the agent's browser by hand. Today
  they could only launch, act within the allowed actions, view and stop.
- **Only the coordinator's own attempt, while it runs.** There is one
  controller at a time. Other viewers stay view-only. The lease and deadline
  still apply, and human input renews the lease exactly as on the operator
  socket.
- **The same input limits as the host page.** Clicks, fixed keys, text of at
  most 256 characters, and scroll. No URL bar, DevTools, script, clipboard
  or file transfer. Every request still passes the origin policy, the host
  proxy and the fence.
- **Nothing but pixels comes back.** No page URL, text or DOM.
- **The credential stays out of reach.** Human input waits until an
  in-flight `submit_bound_fixture` has finished and cleared the fields, so a
  person can never reach a filled password field (for example through the
  site's "show password").
- **Refusals in the dashboard.** A viewer, an outsider, a revoked grant or a
  lapsed re-authentication are each refused, and the refusal says why.

## Decisions to ask the user before writing code

1. **The real-time view: which technology.**
   - **Neko** (`m1k1o/neko`, v3, Apache-2.0; the user's expectation).
     Confirmed from its repository: a self-hosted virtual browser in Docker,
     on an X server, streamed over WebRTC, with multi-participant control.
     It gives smooth video and a native "take control". But it replaces the
     browser layer A3 accepted:
     - Its browser runs under its own X server, not the runner's hardened
       Chromium over `--remote-debugging-pipe`.
     - Its input is the full keyboard and mouse, not the bounded input
       vocabulary.
     - WebRTC media must cross the default-deny fence and the origin proxy.
     - It adds a new image and daemon inside the proof VM, and a stream
       that must be authenticated to the dashboard.

     To verify against the v3 documentation (its docs site was unreachable
     from the A6 sandbox): the WebRTC port settings (a UDP range, a single
     mux port, TURN), whether clipboard and file transfer can be switched
     off, and how control handover and its API map onto "one controller,
     run-access users only".

     Choosing it reopens A3-class proofs: the fence, the unit, the input
     limits, the canary and teardown.
   - **Screencast from the existing runner** (CDP `Page.startScreencast`):
     frames pushed through the supervisor to the dashboard over one
     server-sent or WebSocket channel. It stays inside the accepted
     boundary and bounded input, with a new method but not a new browser
     layer. It gives several frames a second rather than video.
2. **Resume semantics.** A new run pinned from the taken-over run's policy
   (same guide, profile and binding revisions, refused if any changed), or a
   new attempt within the same run (needs a coordinator change and the A5
   host proof rerun).
3. **What a reconciliation decision may unlock.** Only closing the help
   request, or also allowing the next run to start; whether it needs a
   second person.
4. **Practice runs.** A flag on the run (same tables), or a separate project
   of the same shape; how the synthetic account and the demo's fixture modes
   are selected.
5. **The critique.** Rule-based from typed state only (recommended), or a
   model summary (a new model use: consent, budget and prompt boundary).

## Preserve

- Git and PRs: the designated branch, no rewritten pushed history, nothing
  opened, merged, deployed or promoted unless the user asks.
- Activation stays off; every new flag defaults false.
- Human-only: no MCP tool, catalog entry or policy allowlist starts,
  approves, stops, reconciles, takes over or resumes a run.
- The A3/A4/A5/A6 boundaries do not widen without a decision: the socket
  methods (A6 added only the read-only backend `view`; the user's direction
  above adds dashboard `takeover` and `input` for run-access users, with
  its own host proof, and nothing else), the root-peer rule,
  the fence, the unit properties, the origin proxy's one bounded
  `POST /api/login`, the broker's value path, typed claims only, and
  "results and receipts carry binding ID, revision and outcome only".
- Migrations 1100–1111 are immutable; a new one takes the next free number
  in the Operations range.
- `MOBILE_FIRST.md` for every UI change; no dead control.
- Untouchable: `pp-nodus` and `nodus.fractionate.ai`; no `--upgrade-incus`,
  no Incus archive, no bypassing managed-LXC refusals; keep
  `scripts/tests/a3-vm-probe.zip` and the pre-network snapshot.

## Out of scope

- A8: deployment, the container socket mount, a real target, release gates.
- Every F item; more origins or workflows.
- The carried A5/A6 open items (the origin proxy's resend-after-timeout, the
  one `open_landing` timeout, the locally proven classes) unless the user
  moves one into A7.

## Lessons carried forward

- Test the harness and the UI end to end against the real classes; A6's
  journeys found a help-classification defect that unit tests missed.
- Local fixtures must behave like the real application after each state
  change.
- A case that passes only if a model or a person misbehaves is not a proof.
- Input checks must accept every correct human answer.
- Never put a secret or a scan marker on a command line.
- Host steps: one paste per step, `set -e`, `cmd || echo marker` plus the
  journal on failure, the expected output stated, and a read-only summary
  command (`a6-host-summary.py` or its successor) that prints every verdict.
  Say plainly which steps are required.
- Resolve module constants that tests patch at call time.
- Never trip the live demo's shared sign-in limit.

## Proofs

- Local: the Operations and backend suites (sandbox failures named), the
  A3–A7 script suites, the host-boundary inventory without suppression, the
  frontend build, and the A6 browser journeys plus new A7 journeys.
- Target:
  - the kill cases on the proof host (coordinator and worker, mid-read,
    mid-approval, mid-write);
  - dashboard takeover through the backend path, meeting every limit in
    "What this widens" above;
  - the real-time view: its frame rate and its authentication;
  - resume with a new fence;
  - grant and key loss;
  - the regression proofs and the canary.
- CI: exact-head Security CI on a draft PR, only if the user authorizes one.

## Record and stop

- Write `fractionate-agents-a7-evidence.md` (dated sections) and
  `fractionate-agents-a7-reference.md`.
- Update the A7 row of `fractionate-agents-a1-a8.md`, `CLAUDE.md`,
  `docs/core/security-host-boundary.md` (if a route, mount or method
  changed) and `.env.example` (for any new flag).
- Write the A8 prompt, gated on A7 acceptance. Then stop for review. Do not
  start A8.
