# A7 practice and recovery — evidence

**A7 is in progress (2026-09-29).** The gate holds and every decision is
made (below). Nothing is merged, deployed or promoted; no host step has run.

This file is the record: later dated sections win. The orientation page will
be `fractionate-agents-a7-reference.md`.

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
