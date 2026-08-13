# RecapShare — Batch 5: silent capture audio, final root-cause

You are working on **ProxyPilot AI-dev project 57** (RecapShare, a browser
video editor at https://recapshare.com). Work through the ProxyPilot MCP
tools only:

- `read_project_file` / `search_project_files` to read, `edit_project_file` /
  `write_project_file` to change (every write is a commit — no build queue).
- Verify with `run_project_command` → `npm run gates` (typecheck +
  typecheck:app + vitest; currently 1404 tests green).
- Apply with `redeploy_project` after each task.
- End every report by telling the operator to take the **Update now** banner
  (hard-reload) AND **close any open RecapShare receiver tabs** — the
  service worker serves stale bundles until then, and stale receiver tabs
  were responsible for most of today's false test results.
- Comments explain WHY. Migrations are numbered (now through 0130); never
  edit applied ones. Frontend pages must follow the mobile-first rules.
- The session record lives in the ProxyPilot repo
  (`docs/recapshare-half-2-completion.md`, branch
  `claude/recapshare-half-2-continuity-i341d4`) — append to it.

**Ask the operator to re-upload `recapsharecapture0.5.2dev.zip`** (the
extension source) — file uploads do not carry over between conversations,
and you will need `background.js`, `offscreen.js`, `bridge-content.js`,
`review.js` and `CHANGES-0.5.2.md`.

## The one open defect

**Captured audio clips contain silence.** Everything else now works and is
operator-confirmed by screenshots: bridge-delivered media (video + audio
items) lands visibly in the destination project, simulations import (a
3-step sim imported today), and extension-side project creation works.

Evidence so far:

- Two older tab-audio masters measure **−91.0 dB mean AND max** — pure
  digital silence (measured with `npm run diag:capture-import`, which dumps
  the latest capture rows and runs ffprobe/volumedetect on the newest audio
  masters; the QR-encoder rule applies: always inspect artefacts, never
  trust the code path).
- Today's new audio clips ("Claude Code — tab audio" 00:12, direct/tabbed
  mode, Aug 13 12:54 PM ET; "RecapShare — Browser Video Editor" audio 00:27,
  bridge/media mode) show **flat waveforms** in the media pane and the
  extension review header says "**no audio captured**" for the tabbed one.
  They have NOT uploaded as masters yet, so their dB is unverified
  server-side.
- **Timeline trap:** app deploys went out 16:33Z and 16:55Z (= 12:33 /
  12:55 PM ET). All of today's operator tests ran 12:35–12:54 PM ET —
  *between* the two. The 16:55Z deploy added the immediate stale-build
  check, so those tests very likely still recorded with the OLD bundle.
  **First step: establish which bundle records.** The receiver stamps
  `appVersion` = `freshcut-1.1.0+<build-id>` into `receiver-ready`; persist
  the build id into the direct session record / track meta if needed so the
  diagnostic can prove it.

## Code state (all deployed)

- `apps/freshcut/src/directCaptureRecorder.ts` — raw-track recording for
  every kind (`TrackRecorder`; recorded bytes must NEVER depend on an
  AudioContext), plus `startTabAudioPump`: a separate loopback/diagnosis
  graph (source→speakers for tab audio only, aggressive `resume()` retries
  on visibility/focus/pointer/keydown + 2s interval, AnalyserNode silence
  detection pushing session WARNINGS). The removed `RoutedAudioRecorder`
  (graph-output recording) was the −91 dB cause: Chrome keeps a gesture-less
  page's AudioContext suspended and `resume()` stays pending forever in a
  background tab.
- `apps/freshcut/src/directCaptureReceiver.ts` — `projectExists` =
  `ensureLocalProject` (shared `localProjects.ts`: local IndexedDB first,
  then `/api/projects?mine=1`, materializes a minimal local Project);
  stale-build check now runs immediately at install plus every 60s plus on
  visibilitychange.
- `apps/freshcut/src/captureBridgeHost.tsx` — materializes the destination
  project before filing bridge media; falls back to the platform library
  (with a flash) when unreachable. This fixed "synced but nothing arrived".
- `apps/freshcut/src/recapshareImport.ts` — metadata-only packages
  (media `omitted: true`, client-sync mode) import their session track with
  honest notes instead of throwing "nothing to import".
- Server: `POST /api/captures/projects` (create), video-status/stream
  (HMAC token), storage quotas default-unlimited/admin-set.

## Working hypotheses for the remaining silence (verify, don't assume)

1. **Stale bundle** (most likely for today's tests): the 12:54 capture
   probably ran pre-revert code. Get ONE clean test on the current build
   before touching the recorder again.
2. **Unpulled raw track in a background tab**: if a clean-build tabbed
   capture is STILL silent, the raw tab-capture track may deliver zeros
   when nothing pulls it and the pump's context stays suspended (no
   gesture). Candidate robust fix: attach the audio track to a **muted
   `<audio>` element and `play()`** — muted autoplay is always permitted,
   and a playing element sink pulls samples regardless of AudioContext
   state. Keep recording raw; keep the pump for audible loopback and
   diagnostics.
3. **Extension-side (media mode)**: 0.5.2 records its separate
   system-audio/microphone clips from a WebAudio `MediaStreamDestination`
   inside the extension's **offscreen document** (see `CHANGES-0.5.2.md`) —
   the same suspended-context class of bug, but in code the app cannot fix.
   If only bridge-delivered (media-mode) audio is silent while direct-mode
   tab audio is fine, report it as an extension defect with the evidence.

Also investigate: the extension recordings list shows "RecapShare — Browser
Video Editor" stuck at "**Waiting for RecapShare**" (Aug 13 12:35 PM) even
though its media landed — find which state transition the extension awaits
(`session.delivery.clientSync` in `background.js`) and what the app/server
must answer to complete it.

## Verification loop (every deploy)

1. Operator: Update now + close all receiver tabs.
2. Operator records: (a) a tabbed capture of a page audibly playing sound,
   Mic on, speaking; (b) a screen/window capture of the same.
3. Check the media pane waveforms (flat = silent), the review page's
   session warnings (the pump pushes "blocked graph" / "pure silence"
   warnings — they should now be visible), and run
   `npm run diag:capture-import` for the artefact-level dB verdict once the
   masters upload.

Do not declare success on code reading — success is a non-flat waveform and
a healthy volumedetect number from a capture made on the current build.
