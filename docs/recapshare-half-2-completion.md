# RecapShare — Half 2 completion record

Completed 2026-08-13 against ProxyPilot AI-dev project **57**
(https://recapshare.com). All changes were made by direct MCP writes to the
project's own repository (each write is a commit there), per the Half 2
prompt's working rules — this file is the session's record in the
ProxyPilot repo. Gates (`npm run gates`: typecheck + typecheck:app + vitest)
were green and the project was **redeployed after every numbered task**;
final state: **1389 tests passing** (up from 1352 at the start of the half).

## What shipped, task by task

1. **Render-output retention vs stored_videos** — `render_outputs` table
   (migration 0125) with its own directory (`STORAGE_DIR/renders/`), its own
   pure retention policy (90 days, `src/renders/retention.ts`, tested) and
   its own hourly sweep. CHECK constraints make the path namespaces disjoint
   so neither the job-input sweep nor the render sweep can ever collect the
   other's artefact. All three lifetimes written down in
   `docs/features/retention-lifetimes.md`.

2. **The checkout lease** — lease + takeover, never a lock. Policy in
   `src/projects/lease-rules.ts` (TTL 3 min, renew 45s, force always
   allowed, never silent; tested), table in migration 0126, client in
   `apps/freshcut/src/lease.ts` (per-TAB identity via sessionStorage).
   Read-only mode is enforced at the editor's four existing chokepoints —
   `commit()`, `undo`, `redo`, `doSave` — not at 40 call sites. The banner
   names the other device and the time, states that nothing is lost, and
   points at Version history → "Saved to the platform". Same-account UX
   decided and recorded: the "other device" is always you (owner-scoped
   lease routes), so the copy is device-first and non-alarming.

3. **Live sync** — delivered over the app's existing socket layer,
   per-user SSE (`GET /api/projects/events`), deliberately not a raw
   websocket: billing and captures already run this shape, it is
   notification-only (one writer — nothing to replicate), and the session
   cookie authenticates through the ordinary middleware chain. Carries
   exactly two messages: lease changes (takeovers land live) and "this
   project changed elsewhere". HTTP sync machinery untouched as the
   fallback; the editor's save-state readout says when the channel is down.
   Decision recorded in `docs/features/project-sync-architecture.md`.

4. **Lazy-hybrid pull** — Home's "On the platform" section lists projects
   this device has never seen; opening one joins the latest version's
   manifest to `master_files` by sha256 (`apps/freshcut/src/pull.ts`),
   streams media over the ranged masters blob route, and (after an explicit
   consent row, gated on storage health) downloads in the background into
   IndexedDB, switching items over safely. `MediaItem.blob` became nullable
   so the compiler forced every direct byte-reader through accessors or
   explicit guards — the "honest move" the prompt named. Pulled items never
   re-upload; their sync hash answers from the master reference.
   Pulled-but-undecodable behaviour decided and recorded in
   `docs/known-issues.md`.

5. **Server render** — `render_jobs` (migration 0127) →
   `src/renders/queue.ts` (one at a time) → `src/renders/pipeline.ts`:
   headless Chromium loads the app's own built harness
   (`renderHarness.html`), which runs the SAME `drawTimelineFrame` — one
   renderer, two hosts, no filtergraphs. Frames pump over image2pipe into
   ffmpeg (`-vsync cfr` + rate pin, half-second keyint, spawnNiced +
   workerThreadCap). **Verified the QR-encoder way** (`npm run
   verify:render`): 0.00% per-packet jitter, 0 hitches, every frame held
   exactly 2×60Hz refreshes. Audio mixes offline through OfflineAudioContext
   with the live mixer's exact gain expression; denoise-offline is a
   declared warning, never a silent divergence. Local render untouched and
   default when the server can't render.

6. **Delivery + Exports** — ranged (resumable) output download, keep/unpin
   past the 90-day retention (the number is stated in the UI, served by the
   API), delete; the Export modal gained a third destination ("Render on the
   platform", offered only when available) and an Exports section with live
   job progress. The EDL travels; footage never does — missing masters come
   back as a 409 that kicks the existing upload queue.

7. **ACE-Step music generation** — the gate passed in Half 1 (30s audio =
   63.8s inference on this host; figures written into the code), so it
   shipped: `music_jobs` (migration 0128), a queued worker running the
   spike-derived driver (`scripts/acestep-generate.py`, both install traps
   preserved) through spawnNiced + thread caps, **hard caps server-side in
   `src/music/rules.ts` (2 clips, 2 minutes — pure, tested; a test trips on
   any unasked raise)**, and a Generate-music modal that states the caps and
   the expected wait. Results are ordinary media through `onImportFiles`,
   stamped with `MediaItem.aiGenerated` (model + prompt), auto-backed-up as
   masters. Outputs use the tmp lifetime on purpose. MIT licence rationale
   recorded next to the caps.

Standing rule closed: **the account storage quota now exists** — 50 GB of
masters per account (MASTER_QUOTA_GB to override), enforced at
`/api/masters/finish` after the dedupe check, refusal names both numbers.
Decision recorded in the sync architecture doc.

## Outstanding (carried, still blocked on the operator)

- The 22s file that imported as ~3s — fix proven from code, never verified
  against the file that lied. The file is still needed.
- The "sometimes won't play" report — needs the file, the browser, and
  whether it is preview or export. Task 4's pull + the undecodable-master
  handling is where the real fix now lands.

## Operator action needed

**Hard-reload the app** (take the "Update now" banner) — the service worker
holds the old bundle until then, and none of this half is visible before it.
