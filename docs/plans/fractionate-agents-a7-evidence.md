# A7 practice and recovery — evidence

**A7 is implemented and proven locally (2026-09-29); the user asked for it to
be merged and deployed; the host run has not run.** The gate held and every
decision is made (below). The last code commit is `805f4565` on
`claude/intelligent-heisenberg-bwnuiv`. The host pastes (H0–H7) are in the
reference; they need only the router's three forwards.

This file is the record: later dated sections win. The orientation page is
[`fractionate-agents-a7-reference.md`](fractionate-agents-a7-reference.md).

## 2026-09-29 gate check and decisions

### Gate

1. **A6 is ACCEPTED.** `fractionate-agents-a6-evidence.md` carries
   "Acceptance decision: A6 is ACCEPTED (2026-09-29)":
   - host run 1 on live `08293733`: A3 20/20 including `backend_view`, A4 6/6,
     A5 17/17 with one real human approval, both canaries clean,
     `a6-host-summary.py` `all_passed: true`, candidate `backend-tests` 0 fail;
   - the open items carry the user's dispositions;
   - host run 2 on live `776045d7` (the follow-ups, #705) passed the same way.
2. **Where the code lives.** Branch `claude/intelligent-heisenberg-bwnuiv`
   from `main` `23f138e` (after `24cfadbd` and #706). Nothing merged,
   un-drafted or closed.
3. **Host state:** not read; no host step was needed before the decisions.

Read in order: the A6 reference and evidence, the A5 reference, the
coordinator, worker boundary, A6 service, `AgentRuns.jsx`, `RunDeck.jsx`,
`run-deck-logic.js`, the supervisor, the operator script, the runner,
`a5-probe.mjs`, `CLAUDE.md`, `MOBILE_FIRST.md`, the A7 rows of the plan and
acceptance matrix, the Neko research, the security audit register and the
`open_landing` note.

### Facts that shaped the decisions

- **A resume is a fresh browser.** A new attempt is a new worker unit, and
  teardown removes the old attempt's profile and cookies. What a person did
  inside the browser during a takeover does not carry into a resumed run;
  only what the site itself kept does.
- **The runner already keeps the credential out of reach.** It runs one
  command at a time, and `submit_bound_fixture` clears both fields in a
  `finally` before the next command runs. A7 adds an explicit wait in the
  supervisor and proves it on the host.
- **A timed-out submit is an uncertain write.** The proxy answers 502 after
  8 s; the demo may still have signed in. With the proxy's at-most-once rule
  live, a `slow` fixture mode can prove it on the host.
- **An open help request blocks nothing today.**
- **Neko (v3, commit `3f4f9408`, read from its source):**
  - its runtime is Debian trixie (the proof VM's release): Xorg with the dummy
    driver, PulseAudio, GStreamer and a Go server (`neko serve`), run by
    supervisord; no Docker is needed to run it;
  - its stock Chromium runs with `--no-sandbox` under managed policies
    (DevTools off, downloads blocked, file dialogs off, password manager off);
  - input reaches X as raw keysyms over the WebRTC data channel
    (`desktop.KeyDown(keysym)`): full keyboard and mouse, no vocabulary;
  - `server.bind` accepts a Unix socket; members come from providers
    (`object`, `file`, …) with the switches `can_watch`, `can_host`,
    `can_access_clipboard`, `can_share_media`, `is_admin`; control is
    `control/take|give|release|reset` (admin or host), with
    `locked_controls`, `control_protection`, `implicit_hosting`;
  - WebRTC takes `webrtc.udpmux` / `tcpmux` / `epr`, `nat1to1`, and separate
    frontend and backend ICE servers (TURN).

### Decisions (user, 2026-09-29)

| # | Question | Answer |
|---|---|---|
| 1 | The real-time view and takeover | **Neko** |
| 1a | Where Neko and the agent's browser run | **Inside the per-attempt worker unit**: the runner starts Xorg (dummy), Neko's server on a Unix socket in the unit's private tmpfs, and its own sandboxed Chromium in kiosk mode on that display, still driven over `--remote-debugging-pipe`. The origin policy, the credential FIFO, the one-shot sign-in gate, the cgroup limits and the signed teardown receipt keep covering it |
| 1b | The network opening for the WebRTC media | **TURN with a TLS fallback**: coturn on the host (3478 UDP/TCP and TURN over TLS on 5349, one router forward each), short-lived per-viewer credentials minted by the backend after the Operations access check, relaying only to the VM's one Neko UDP port; the VM never faces the internet. The user asked first which of public TCP and TURN is more secure and better quality; the answer given: TURN on both counts (the VM has no internet-facing listener; authenticated relays; UDP media with a TCP fallback, no added delay because the relay sits next to the VM), at the cost of one more host daemon |
| 1c | The Browser pane's client | **Our own React client** in the run deck (WebRTC video, input after Take over, control state), built to `MOBILE_FIRST.md` |
| 2 | Resume | **A new linked run**, pinned to the taken-over run's policy digest and guide, profile and binding revisions (refused with the reason if any changed), starting at step 1 in a fresh browser, with its own approval before a submit and the profile's limits afresh |
| 3 | What a reconciliation decision unlocks | **Gate uncertain writes**: Start is refused for the profile while an uncertain write (a submit or a sign-out) is unresolved or marked "unknown"; uncertain reads and model calls only close the help request. Anyone with run access may decide, including the starter, after the session's re-authentication; audited |
| 4 | Practice runs | **A flag on the run, the fixture mode chosen in the dashboard**: migration 1112, a Practice start beside Start, the same policy/worker/approval path with the synthetic account's binding, labelled Practice everywhere; the practice form picks the demo fixture mode through a new audited write path into the demo guest's fixture file (synthetic account only) |
| 5 | The critique | **Both**: a rule-based typed critique from durable state, and a model summary, **written automatically** when a run of a consenting profile ends (its own per-profile owner consent and cap; typed state only in the prompt; bounded text labelled as model text that changes nothing) |
| 6 | The classes proven only locally | **The proposal**: the out-of-set reply keeps `blocked/model_choice_invalid` and unknown usage keeps `failed/usage_unknown` (spend kept at the reservation), each proven on the host through an operator-socket-only broker proof switch (a fixed reply without calling the provider, like `provider_error`); the submit `timeout` becomes a help request (an uncertain write, gated by decision 3), proven on the host with a new demo mode `slow` (synthetic account, correct password, the reply held past the proxy's 8 s: 502 → `timeout`, exactly one POST at the demo, never counted in the shared limit) |
| — | Takeover re-authentication (left to A7 by the prompt) | **Its own session grant**: the first Take over in a dashboard session asks for password + TOTP or a passkey; the session stays verified for takeover until it ends (24 h, 4 h idle, logout or revocation). It never opens sudo; audited |

The user's standing directions (in the prompt) hold: takeover in the
dashboard on the run deck's Browser pane, by run-access users only, no host
privilege; frames and video never stored; the typed text never recorded; no
MCP tool reaches any of it; the toggles stay on; the reboot test runs only
when the user chooses; host root steps are one reviewed paste each.

### What the decisions widen (each needs its own host proof)

- **The worker unit gains Neko.** Xorg (dummy), Neko's server and a headful,
  sandboxed Chromium in kiosk mode under managed policies replace the
  headless browser. The runner still drives it over the pipe. The unit's
  memory and task needs grow (to be measured on the proof VM).
- **Human input is Neko's full keyboard and mouse**, not the bounded
  vocabulary. The limits become: kiosk mode (no address bar), policies
  (DevTools, downloads, file dialogs, printing, the password manager,
  `chrome://`, `file://` and `view-source:` off), Neko with clipboard, upload,
  file transfer, chat and media sharing off, and the runner's origin policy,
  the host proxy and the fence for every request, as before.
- **The supervisor's backend socket gains the dashboard's takeover path**
  (take, hand control to one viewer, release) for the coordinator's own
  running attempt only, after any in-flight submit has finished, plus Neko
  session minting and the signalling relay for run-access viewers.
- **A new network path:** coturn on the host with a public listener, and one
  fence rule admitting only the host's relay address to the VM's Neko UDP
  port.
- **A second model use:** the automatic summary through the broker, with
  model text returned (bounded) for the first time.
- **A new write path into the demo guest** for practice fixture modes.
- **The broker gains two proof switches** (operator socket only) and the
  demo server a `slow` mode.

### Build order

1. Backend core: migration 1112 (practice, links, reconciliation, the
   takeover grant, critiques), resume, reconciliation gating, `timeout` as a
   help class, the rule-based critique, the takeover re-authentication.
2. Host scripts: the runner with Neko on its display, the supervisor's
   dashboard takeover and Neko relay, the broker proof switches and summary
   route, the demo `slow` mode, the coturn installer and fence rule, the VM
   provisioning for Neko.
3. Backend plumbing: the signalling relay, TURN credentials, takeover routes,
   the automatic summary, the practice fixture path.
4. UI: the Neko client in the Browser pane, Take over and re-authentication,
   reconciliation, practice, resume, the critique.
5. Proofs: local suites and journeys; the host proof paste list.
6. Record: this file, the reference, the plan row, `CLAUDE.md`,
   `docs/core/security-host-boundary.md`, `.env.example`, the A8 prompt.

## 2026-09-29 implementation and local verification

### As built, where it differs from the plan above

- **Xvfb, not Xorg with the dummy driver.** The runner draws the kiosk
  Chromium on a private Xvfb display (no TCP, no abstract socket, its cookie
  on the unit's tmpfs). Neko captures that display. Xvfb needs no driver
  package and no config file, and Neko's capture works the same.
- **The worker's memory is within the A3 minimum.** Measured locally with
  one viewer streaming at 25 fps: the peak was 420 MiB PSS (Chromium 296,
  Neko 81, Xvfb 42) and 109 tasks. The A3 minimum is 1024 MiB and 512 tasks.
  The A3 proof runs in live mode on the host (H4), which proves it on the VM.
- **The hand-over checks two facts from the runner's own command queue.**
  No password field holds text (`LIVE_FIELDS_NOT_CLEAR` otherwise). The X
  input counted while nobody had control is zero. The supervisor refuses a
  reply without both (`LIVE_PROTOCOL`), the backend refuses it again, and
  both facts go into the audit entry and the receipt.
- **The kill cases are host proof cases** in `a7-probe.mjs` (the prompt's
  target list): the worker killed mid-read, mid-approval and mid-write, and
  the coordinator killed mid-read, mid-approval and mid-write. Account loss
  and key loss while a person holds control are cases too (18 in all).
- **The TCP and TLS fallback on the host** is proven by allocation, not
  media. The Go probe (pion) gives a relay candidate gathered over TCP or TLS
  the TCP network type, so it cannot reach Neko's UDP port that way.
  Browsers can, and the dashboard's client in Chromium streams over UDP, TCP
  and TLS TURN locally. On the host, `live_refusals` checks the 3478/TCP and
  5349/TLS listeners: the viewer's credential allocates, the certificate
  verifies for the TURN name, and the peer scope is the same.
- **No new environment variable.** The TURN settings are host state
  (`live.json`, written by `a7-install-live.py enable`). The backend gets the
  ICE servers from the supervisor for each viewer. `.env.example` is
  unchanged.

### What changed (code `91a25b62`)

Commits:
- `c12b26bb`: backend core.
- `b9271b94`: host scripts.
- `3ed44fa6`: fence, TURN and installer.
- `9776478e`: backend plumbing.
- `d5fe6d0e`: UI.
- `f6491871`: proofs.
- `91a25b62`: kill cases and `WORKER_EXITED`.

The reference's component map lists the files.

- **Practice (decision 4).**
  - Start takes `practice: {fixture_mode}` (`normal`, `expired`, `locked`,
    `challenge`, `redirect`, `slow`).
  - The demo's fixture mode is written through one audited, fixed write into
    `pp-fractionate-demo` and read back byte-exact, set before the pin and
    reset after.
  - A practice run runs alone. It is labelled Practice everywhere, and the
    Review tab says whether the result matched the mode's expected result.
- **Reconciliation (decision 3).**
  - Every uncertain step or model call becomes an item. Another start of the
    profile is refused (`RECONCILIATION_REQUIRED`) while an uncertain write
    (a submit or a sign-out, a `timeout` included) is undecided or "Not known
    yet".
  - Reads and model calls only close the help request.
  - Decisions are append-only and audited. They need run access and the
    session's verification. Nothing is re-sent.
- **Resume (decision 2).**
  - A resume is a new run, linked to the old one and pinned to its profile,
    guide, binding revision and policy (`RESUME_STALE` with the reason
    otherwise).
  - It gets a new attempt and fence, a fresh browser and its own approval.
  - A run can be resumed once.
- **Takeover (the user's direction, decisions 1–1c).**
  - A person watches the run in the Browser pane as live video over WebRTC,
    relayed through TURN; relay candidates only.
  - "Take over" hands control to that person's own open view, after one
    "Confirm it is you" per session (password + TOTP or a passkey; not sudo).
  - There is one controller at a time. Keys, pointer and wheel go over Neko's
    data channel; only counts by kind are recorded.
  - "Give back and end run" ends the run `taken_over` with a verified receipt.
  - If the holder's view closes, their access ends or the coordinator
    restarts, the takeover ends the same way.
- **Critique (decision 5).**
  - The Review tab shows the rule-based critique (typed codes from durable
    state) for every finished run.
  - For a profile whose owner allowed summaries, one model summary is
    written automatically from typed facts under the run's budget. It is
    bounded and labelled as model text, and changes nothing.
- **The locally proven classes (decision 6).**
  - A reply outside the allowed set stays `blocked/model_choice_invalid`, and
    unknown usage stays `failed/usage_unknown`. The host proof uses the
    broker's operator-only proof switches.
  - A submit `timeout` is a help request that gates the profile. The host
    proof uses the demo's `slow` mode: the proxy answers 502 after 8 s, and
    the demo completes the sign-in afterwards.
- **Migration 1112:**
  - run origins;
  - reconciliations;
  - control grants;
  - takeovers;
  - the fixture state;
  - summaries;
  - summary consent.

  Migrations 1100–1111 are untouched.
- **UI** (to `MOBILE_FIRST.md`):
  - the Browser pane's live view with Take over / Give back;
  - the reconcile panel ("It happened", "It did not happen", "Not known yet",
    "Acknowledge");
  - the practice dialog;
  - resume;
  - the Review tab;
  - summary consent;
  - the "Confirm it is you" prompt.

### Local verification (this session, code `91a25b62`)

- **Backend, full suite:** 3,391 tests, 3,359 pass, **20 fail**, 12 skipped.
  - The 20 failures are exactly the set that fails on untouched `main` in this
    sandbox (3,361 tests, 20 failures; compared by test name). None is new.
  - Operations and agent suites (`agent-*`, `operational-*`,
    `operations-toggles`): **159/159**.
- **Scripts:** `python3 -m unittest discover -s scripts/tests -p
  'test_a[34567]*py'` ran **210 tests, OK**, with a real Neko build
  (`A7_TEST_NEKO`) and the probe (`A7_TEST_PROBE`). Included:
  - `test_a7_live_e2e`, with real Xvfb, Neko, coturn (rendered by the
    installer), the Go probe and Chromium:
    - the probe streamed over the UDP relay at **25.0 fps** (149 frames in
      6 s);
    - the dashboard's own client in Chromium streamed over **UDP 24.8 fps,
      TCP 25 fps and TLS 25 fps**, relay candidates only, to Neko's port;
    - input before control reached X zero times, and after control 4 keys,
      1 click and 2 scrolls;
    - the relay permitted only the Neko address; every other peer got `403
      Forbidden IP` over UDP, TCP and TLS;
    - the TLS check verified the name, and was refused as `TLS_UNVERIFIED`
      without the CA.
  - `test_a7_probe_harness`: the host harness itself, **18/18** against the
    real supervisor and broker socket servers.
- **Browser journeys:**
  - A6: **19/19**, 96 layout checks.
  - A7 (`agent-runs-a7.browser.mjs`): **5/5**, 36 layout checks (six
    screens at 360, 375, 390, 768, 1280 and 1920 px: no horizontal scroll,
    touch targets ≥ 44 px under 640 px).
- **Frontend build:** passed.
- **Host-boundary inventory:** 97 candidate backend files (the demo fixture
  writer is new); S6 remains open.

### MOBILE_FIRST pre-merge checklist (recorded)

- Default breakpoints only.
- The run bar's resume row wraps to its own line under `sm`.
- The confirmation dialog and "Confirm it is you" are full-screen under `sm`
  and completable at 360 px.
- On a phone:
  - the live view keeps its 16:10 box;
  - "Keyboard" opens the phone keyboard for the held browser;
  - the takeover bar's buttons are ≥ 44 px.
- Rendered and checked at 360/375/390/768/1280/1920 by the journeys.
- No dead control: the journeys' dead-control audit is empty.

### Findings while building (fixed before commit)

- **Neko sends its host candidate before its offer.** Adding it before the
  remote description throws. Both the dashboard's client and the probe now
  buffer early candidates. A unit test models it: the fake peer throws
  without a remote description.
- **React's development double mount closed the live client it kept.** A
  disposed guard stops a client closed by its own cleanup from reporting.
- **A duplicate object key (`DECK_TEXT.review`) silently replaced the
  approval button's label.** The key was renamed `reviewTab`, and a
  duplicate-key ratchet was added (`agent-run-text.test.js`).
- **coturn's `bps-capacity` reserves the rate per allocation.** A browser
  holds one allocation per TURN URL, so it answered 486 "Allocation
  Bandwidth Quota Reached". It was removed; `max-bps` (bytes per second per
  session) stays.
- **A runner that had already exited was reported as `CHANNEL_CLOSED`.** A
  submit that was never sent then became an uncertain write that gated the
  profile. The supervisor now answers `WORKER_EXITED`, a certain failure,
  and the coordinator maps it to `failed/attempt_lost`. Found by the
  `worker_killed_mid_approval` case.
- **The A3 host proof still expected `takeover` to be refused on the backend
  socket.** A7 made it a backend method. `backend_refusals` now expects
  `INVALID_REQUEST` without a viewer and `LIVE_CONN_UNKNOWN` or
  `LIVE_UNAVAILABLE` for an unknown one, and the socket test asserts the
  same. The host regression would otherwise have failed.
- **In the harness, a killed worker made the in-flight call reject** before
  the harness had attached a handler. Node treats that as fatal. It now
  attaches one at once.
- **Layout:**
  - the resume button overflowed at 360 px, so it moved to its own row;
  - a practice reason was shown twice;
  - the A6 journeys needed the new Review tab in their keyboard walk.
- **Local harness:**
  - Chromium sends TCP TURN through the proxy settings, so the local
    end-to-end test runs it with `--no-proxy-server`;
  - Chromium does not use `--host-resolver-rules` for TURN names, so the test
    uses an address.

### Open items (for the user's acceptance decision)

- **The host run (H0–H7) has not run.** It needs the TURN host name, the
  host's LAN address, the DNS record and the three router forwards.
- **The dashboard's live view from the internet** cannot be shown before A8:
  execution on the live dashboard stays unavailable until the supervisor
  socket is mounted, and nothing is deployed. A7 proves each part:
  - the client in Chromium over all three transports (locally);
  - the host's listeners, certificate, scope and UDP media (H4);
  - the router forward and certificate as a viewer sees them (the
    recommended external `openssl` check).
- **A person deciding an uncertain write sees the run's own record only.**
  In the coordinator-killed-mid-write case the supervisor's journal can
  already show the submit `done`. Showing the supervisor's record beside
  the decision would help; proposed for A8.
- **The two mid-write kill cases rely on the submit taking longer than
  300 ms on the host.** If it finishes first, the case fails with a typed
  detail and the delay is tuned (`A7_PROBE_SUBMIT_IN_FLIGHT_MS`).
- **The reboot test** (`a6-reboot-check.py`) has not run; it runs only when
  the user chooses.
- S6/SEC/INF stay with the later security audit
  (`fractionate-agents-security-audit-register.md`).

## 2026-09-29 the user: the TURN name, no Cloudflare, merge and deploy

The user's words: "Set the record: streamview.fractionate.ai"; "Please commit,
merge, deploy (if the code auto sets this up; otherwise, why is it being asked
for)"; "for this instance I don't use cloudflare, just use caddy".

- **DNS needs nothing.** The ProxyPilot Cloudflare token covers no
  `fractionate.ai` zone, and none is needed: the zone has a wildcard record,
  so `streamview.fractionate.ai` already resolves to `96.88.158.118`, the same
  address as `demo.fractionate.ai`. Caddy obtains the certificate through the
  installer's custom site (`/etc/caddy/custom/pp-a7-turn.caddy`) over the
  existing 80/443, with no DNS provider involved.
- **The LAN address is no longer asked for.** `install-turn` listens on the
  host's default-route source address (`ip -j -4 route get 1.1.1.1`, a lookup
  only), and `--listen-ip` still overrides it. The host proof reads the
  address from the install journal. This is commit `805f4565`, with a test.
- **Why the deploy cannot do all of it.**
  - The deploy updates the dashboard (backend, UI, migration 1112). The TURN
    relay, Neko in the VM and the reinstalled supervisor and broker are
    root-owned host daemons that the backend cannot install, by design (S6,
    host steps as reviewed pastes). That is H1–H4.
  - The video relay is not HTTP, so Caddy cannot carry it on 443. The
    router's forwards of 3478/UDP, 3478/TCP and 5349/TCP to this host are the
    one network step the code cannot do.
- **The deploy path** is in the reference: the PR and merge, D1 (the pinned
  stager, a user paste), and D2 (checks, backup, promote over MCP).

## 2026-09-29 merge and deploy (user: "commit, merge, deploy")

- **PR [CyberTechArmor/ProxyPilot#707](https://github.com/CyberTechArmor/ProxyPilot/pull/707)** merged as
  **`9e1d66a58d2ca048991d390036a13e1fc7e46be5`** (a merge commit). Its tree
  is identical to the tested head `316364ee`.
  - The first CI run (head `ec7e972e`) failed in `backend`: the new
    installer tests called `os.chown` to uid 0, which a non-root runner
    cannot do.
  - Fixed in `316364ee`: a non-root run records the ownership changes
    instead. Reproduced locally as `nobody` first.
  - On `316364ee` all 7 checks were green: `backend`, `frontend`, `agent`
    and four `audit` jobs.
- **Staging (user, root, the pinned stager, 2026-09-29):**
  `staged 9341dd93267de145b4abd636645c3b187b8847e8 (was 776045d741e2…) from
  9e1d66a58d2c…; 189 paths match exactly`. The candidate digests are
  `73a89f61…` (supervisor), `69dda3db…` (`a7-install-live.py`) and
  `d4693668…` (demo `server.mjs`).
- **Checks** on `9341dd93` (`backend-tests`, `backend-syntax`, with the
  install step): 3,408 tests, 3,397 pass, **0 fail**, 11 skipped.
- **Backup:** `/data/db/backups/proxypilot-pre-A7-promote-20260929T200120Z.db`,
  8,998,912 bytes, sha256 `7bd71de83c99a2a2…`. `update.sh` also kept
  `proxypilot.db.pre-update-20260929-160131`.
- **Promote:**
  - the preview showed `776045d7` → `9341dd93`, one commit (the staging of
    `9e1d66a5`);
  - rollback tag `pp-rollback-20260929T200130Z` (at `776045d7`);
  - update `a5049c12-2f01-44bf-bd9a-b8e5409960cc`: `success`, exit 0,
    20:01:30–20:02:31Z;
  - `Applied schema migration 1112: operational_practice_recovery`, the
    health check passed, and all 33 routes match their declared settings;
  - the `git pull` "divergent branches" message is the known one: the live
    `main` carries the staged commit;
  - `get_self_status`: live `9341dd93`, clean; candidate the same, 0 ahead.
- **Seen in the update log, for the host run:** the host firewall's managed
  bridge is `incusbr0`, the proof VM's bridge. It is admitted by the input
  hook, so H2 will print `relay_ports_admitted_by_bridge_rule` and adds no
  relay-port rule.
- **Not changed by the deploy:**
  - the installed supervisor, runner, broker and demo server (still the A6
    bytes until H1);
  - no TURN relay, no Neko (H2–H3);
  - execution on the live dashboard stays unavailable (A8);
  - the toggles.
- **Rollback, if needed:** `rollback_self` to `pp-rollback-20260929T200130Z`
  (`776045d7`) **and** restore the backup above, because migration 1112 has
  applied.
- **Next:** the router's forwards of 3478/UDP, 3478/TCP and 5349/TCP to this
  host, then the host run H0–H7 (reference).
