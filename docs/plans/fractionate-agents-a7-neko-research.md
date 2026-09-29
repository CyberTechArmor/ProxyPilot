# Neko for the A7 real-time view and takeover: research note

2026-09-29. This is research for A7 decision 1 (the real-time view: Neko or a
screencast from the existing A3 runner). The user expected Neko. It is named
nowhere in the A1–A6 documents; this note is where it enters.

**Source.** Neko's own v3 documentation, read from its repository
(`github.com/m1k1o/neko`, commit `3f4f9408`, 2026-09-27, `webpage/docs/`). The
documentation site `neko.m1k1o.net` is blocked from the A6 sandbox. Nothing
here was run; the facts below are what the documentation states.

## What Neko is

- **A self-hosted virtual browser.**
  - It runs in Docker: a browser (Chromium, Firefox and others) on an X
    server in the container.
  - It streams the screen and audio to viewers over **WebRTC**.
  - It takes mouse and keyboard from **one controlling member** at a time.
  - Apache-2.0, version 3.
- **Members and profiles.** Each member has a profile of switches:
  - `can_login`, `can_connect`, `can_watch` (see the stream) and `can_host`
    (take control of mouse and keyboard);
  - `can_access_clipboard`, `can_share_media`, `is_admin`.
- **Member providers:**
  - `multiuser` (two shared passwords, the v2 behaviour);
  - `object` (an exact user list, held in memory);
  - `file` (users in a JSON file);
  - `oauth` (OAuth 2.0);
  - `noauth` (anyone, admin; for testing only).
- **Sessions** are held in memory or in a file, with cookie or `Authorization`
  header authentication.
- **API user.** A single `session.api_token` authenticates HTTP API calls as
  an administrator. It cannot join the room. The documentation warns against
  long-lived tokens.
- **Control over HTTP.** `control/take`, `control/give` (to a session),
  `control/release`, `control/request`, `control/reset` and `control/status`.
  - Room settings `locked_controls` (only admins control),
    `control_protection` (control only while an admin is present) and
    `implicit_hosting` (clicking takes control; can be off).
- **Pictures over HTTP.** `screen/shot` (a screenshot image) and
  `screen/cast` (the current screencast image), next to the WebRTC stream.
- **Plugins:**
  - chat (`chat.enabled`, per-profile `can_send` / `can_receive`);
  - file transfer (`filetransfer.enabled`, an upload directory; non-admin
    download, upload and delete are off by default).
- **WebRTC network.** It needs either:
  - an ephemeral UDP port range (`webrtc.epr`, for example 59000–59100 UDP,
    exposed unremapped); or
  - one UDP/TCP mux port (`webrtc.udpmux` / `webrtc.tcpmux`), plus `nat1to1`
    for the public address.

  The documentation says outright: *"WebRTC does not use the HTTP protocol,
  therefore it is not possible to use nginx or other reverse proxies to
  forward the WebRTC traffic. If you only have exposed port 443 … you must
  expose as well the WebRTC ports or use a TURN server."* TURN (for example
  coturn) is configured as ICE servers, split into frontend and backend.

## What it would give A7

- Smooth, low-latency video, and a native "take control" with one controller
  and many watchers. That matches the user's direction closely.
- Control handover through an API (take, give, release, status), so the
  dashboard could own who controls when.
- Per-member switches that express "watch only" (`can_watch` without
  `can_host`) and "may take over" (`can_host`), and that turn off the
  clipboard, media and file transfer.

## What it would change in the accepted boundaries (A3/A4)

| Boundary today | With Neko |
|---|---|
| **The browser.** The runner drives a hardened Chromium over `--remote-debugging-pipe` (no debug socket), in one transient guest unit per attempt, with project CPU/memory/disk limits, a fence and a signed teardown receipt | Neko's own container runs its browser under X. Either the A3 runner is replaced for these runs (the A3 proofs are redone for the new layer), or Neko only displays and relays input to the runner's browser, which is not how Neko works: it streams *its* X display |
| **Human input.** Clicks, fixed keys, text of at most 256 characters, scroll; no URL bar, DevTools or script | Full keyboard and mouse to the X session. The browser's own UI (address bar, DevTools shortcuts) is reachable unless the image is locked down (kiosk flags, policies). This must be designed and proven |
| **The network.** Default-deny fence; the only egress is the host's fixed-origin proxy for one site; the VM has no other route | WebRTC media needs UDP ports (or a TCP mux, or TURN) **between the viewer and the Neko container**. Its path to the dashboard's users must cross the fence and the host. The browser's own egress must still go only through the origin proxy |
| **The dashboard link.** No MCP, human-only, Operations access, session plus re-authentication | Neko has its own members and sessions. The dashboard would mint a short-lived Neko session per viewer (the `object` provider or the API user) and never expose Neko's admin. Its cookie and the WebRTC signalling need a route (a WebSocket) through ProxyPilot |
| **Secrets.** The bound value is typed by the runner into a password field and cleared after submit; frames are pixels only | The same rule must hold on Neko's screen: no reveal, and the clipboard off for everyone (`can_access_clipboard: false`) |
| **Teardown.** A signed receipt proves the unit, descendants and workspace are gone | A new proof that the Neko container and its X session are gone |

## The alternative: a screencast from the A3 runner

Chromium's DevTools protocol offers `Page.startScreencast`: JPEG frames at a
chosen rate, pushed as the page changes. The runner already speaks that
protocol.
- The supervisor would relay the frames to the backend.
- The backend would push them to the dashboard over one server-sent or
  WebSocket channel.
- Human input would go through the supervisor's existing bounded `input`,
  the path that A7's dashboard takeover adds for run-access users.

It gives several frames a second rather than video, and no audio. It stays
inside the accepted browser, input, network and teardown boundaries. It adds
one new streaming method, which needs its own host proof like `backend_view`.

## Questions to settle in A7

1. **Which layer.** Neko as the display and input layer (which reopens the
   A3-class proofs), or the runner screencast (inside the accepted
   boundary)?
2. **If Neko:**
   - which image and browser;
   - which member provider, with sessions minted by the dashboard;
   - which WebRTC transport (a TCP mux on one port through the host is the
     closest to the current fence);
   - kiosk lock-down of the browser UI;
   - clipboard, file transfer and chat off;
   - how the agent drives the same browser (the runner's CDP pipe inside the
     Neko container?);
   - a teardown proof.
3. **The frame rate** that is enough to click by, measured on the proof VM.

Measure before choosing: a short spike running Neko's Chromium image on a
disposable VM behind a TCP mux, next to a runner screencast at 2–5
frames/s, compared by latency and by what each needs opened.
