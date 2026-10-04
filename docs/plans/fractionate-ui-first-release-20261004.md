# UI-first release — 2026-10-04

## Scope and release boundary

The owner handoff explicitly requests separately implemented, independently reviewed, CI-passing merged UI slices and reserves all production updates and runtime installations to the owner. This candidate is based on mainf891840c (PR746), includes the necessary PR747 metadata dependency while preserving746, and leaves the frozen guides/auth/decoder/model/knowledge/concurrency candidates untouched. No deploy, rebuild, restart, runtime Install, Incus upgrade or other application mutation was performed.

The visible slice restores original-reference composition: project Overview and navigation, four-step plain-field browser setup,600px connection-plan dialog, full-workarea64/36 Flightdeck, real two-column Agents page and project-scoped Connections. Historical demo records remain readable with Stop, exact approval, recovery and physical cleanup. Exposed demo start/practice/resume and synthetic-ledger creation flows are retired. Production routes access-check before returning410; existing records, credentials and assignments are not deleted. Project Details edit/archive/restore is retained.

Connection plans are contributor-private metadata, not credential enrollment, model connection readiness, OAuth authorization or assignment. Public browsing remains independent of optional model/guide/credential capabilities. Current runtime is singleton; Agents lists existing records and starts no viewer or run by navigation.

## Source verification and retained failures

Implementers used isolated worktrees and actual original Library images. Independent reviewer did not author the reviewed changes. Per-slice fixtures cover360/375/390/768/1280/1920 widths, guard-disabled overflow, keyboard/focus, role/identity loss, stale revisions and no implicit execution. Final integrated source/build/browser checks and exact-head CI are required before merge. Fixture and source results do not establish deployed/provider acceptance.

PR747 head91621229 exact CI37195274005/37195274073 passed; independent compatibility review on mainf891 passed231 checks and preserved746 bytes. Integrated focused backend332 checks passed. Broad local operational aggregate547 passed with seven nativeAF_UNIX listenEPERM failures and one auth timezone failure; the latter reproduces on baselinef891 and passes underTZ=UTC. These are not a green broad aggregate. Native listener/root/Docker contracts remain unskipped in CI. Existing Docker-backed saved-agent fixture is unavailable locally (ENOENT). Preserve historical live video and download-image failures and unverified model/private-sign-in/restart evidence.

## Final local source review receipt

Independent reviewer approved product commit68c8c18a47369ac431d14e0a36f9e5e7ce35dec6, tree351a2e98bee3fe831137355a025b2e9179c82c83, with no remaining source/UI blockers. All five originals were inspected. Exact final build passed;204 backend and22 frontend checks passed on byte-identical final scopes;10 integrated UI journeys/seven-width overflow passed; seven setup journeys/six-width axe0 passed; four mobile setup Lighthouse audits scored100 with zero binary findings. Flightdeck/Sessions/dialog/global Connections suites passed and their final source bytes were independently compared. Root final standalone setup rerun passed after a concurrent local Vite/load-timeout failure; the failed attempt remains retained, not counted as a passing run.

Historical A6 exact941f84ed completed20/20journeys/96layouts and A7 completed6/6journeys/36layouts, no skips. Final68 differs in presentation/fixture handling/documentation; runtime/browser lifecycle bytes are unchanged. Targeted final68 historical presentation validation passed5/5 journeys and90 layout checks, including72 checks across all six widths and both themes; lifecycle/backend/test scopes were byte-compared unchanged from941. Remote combined exact-head CI remains unavailable because publication was rejected. Live MCP recheck still reports clean049239296a116784f06735436cb5a1d8919e4175; no deployment claim follows from local source review.

## Merge and owner update procedure

1. Publish the exact independently reviewed integrated tree without replacing newer main. Verify the PR's exact head and both required CI workflows after final changes. Resolve any failures and re-review material changes.
2. Merge only after independent exact-tree approval and passing exact-head CI. Automatic approval review rejected source-tree publication to the existing GitHub repository, citing an unverified external destination and source-disclosure authorization, and rejected merge of PR747 despite the explicit merged-slice instruction, citing consequential shared-mainline mutation and insufficient recognized authorization. No alternate mainline route was used. Until resolved, this release is Blocked, not Merged or update-ready.
3. After merge, tell the owner the merged identity and inspect routes below. Owner runs ordinary ProxyPilot app update with empty ordinary flags. This slice changes no runtime helper/unit/package/install source, so no dedicated runtime Install is needed. It does not authorize Incus upgrade. The cached connector normal-update description still incorrectly claims Incus upgrade; do not invoke that operation from the coordinator.
4. After owner reports update, read actual dashboard/source/host-agent identity and installed/loaded helper hashes. If a run is active, do not run idle-only guest checks. Verify actual browser behavior serially, respect singleton admission, and Stop every verification run with signed cleanup receipts.

## Owner inspection and actual acceptance

- Projects & SOPs: select an existing permitted project; inspect Overview, then Details. Edit/archive/restore remain authorized explicit actions; do not modify owner data merely for visual proof.
- Project Agents: use public browsing independently; inspect Work, Connections, Controls and Review. Plain fields prepare editable inert settings; model interpretation and Start retain separate consent/readiness/approval boundaries.
- Connections: choose a permitted project; Add/edit/history/revoke own metadata plans. Verify600px desktop dialog and full-screen phone; no credential field or connected claim.
- Agents: inspect real loaded records and counts; Start task chooses an existing project; Review opens the exact stored run by GET-only navigation.
- Active public/selected run: inspect full-width Flightdeck, review-card placement, tabs, Task/Recent activity, image/video state, native/fallback fullscreen and focus return. Verify public target availability and bounded transient-image fallback honestly; continuous video remains unverified until actual success.
- Historical runs: verify retained read, approval, Stop/reconcile/recovery/cleanup without exposing new demo execution.

The original-reference comparison documents remaining capability/content differences explicitly. Real credential custody/OAuth, private sign-in, provider tasks, guides/uploads/training, richer practice/critique and concurrent scheduling remain visible backlog; do not infer delivery from this UI slice.
