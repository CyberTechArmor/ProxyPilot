# Fractionate UI/UX alignment tracker

Owner: Thomas · implementation on Duo · started 2026-10-02.
Branch: `ui/mockup-alignment-20261002`. Publication/merge remains pending explicit instruction.

Frozen product source is `0411e2cc7b2e1ac0672685d1d71e60639490a5a5`, following verified main `35c2e9d4eb657f92e1499d8d56035217b04f7ae6` and local merge `38a14238`. Final composed A6 passed 20 journeys and 96 layout checks on this exact source, including the unchanged 1280x800 browser-frame/latest-four fit check, desktop approval rail and single mobile approval. Actual final run pixels were inspected. A fresh production build and the remaining serialized browser/accessibility checks are underway; no broader visual acceptance is claimed yet. The 224 backend contract tests passed at the merge and backend bytes have not changed since. Full UI remains unpublished. Guide PR720 was separately authorized, merged and deployed; the parent verified its successful update receipt and healthy state. This executor performed no production actions.

Website release composition is isolated to `website-review-integration`, branch `ui/website-review-integration-20261002`, current head `444cc2fe7b67e0bbea56103a6bbb824e669f06fd`. It combines verified runtime `9e02012f`, the committed `e355f5c0` component, capability-gated navigation, real dashboard/API browser fixtures and signed model-bridge evidence. Backend and installed-script bytes match runtime proof `fb5d4bb3`. This branch excludes the larger mockup alignment and original backlog commits. Saving settings and owner consent remain inert; Start pins the approved guide/configuration. It does not use the legacy synthetic sign-in runner.

Delivery priority updated by Thomas: **first authorized guide Save-to-approved plus public read-only website review end-to-end**, then finish full visual alignment. A separate runtime owner now implements the normal-Update refresh and owns final website/updater composition; the parent owns publication/merge review. General login, credentials, writes, private-network access and bypassing site protections are outside that slice. Other expanded broker/guide/storage items remain in the original backlog.

## Verified baseline and backlog

- GitHub main verified by remote Git read on 2026-10-02: `0f1b48f33fe31723100b8c758c717899bb7b3f1d`; fetched into the isolated local repository.
- Original backlog commit `ac62d45dba876b248b687679268a8d165ed221fd` is preserved unchanged as an ancestor of this branch. Original clean worktree remains at `C:/Users/thoma/Documents/Codex/2026-10-01/task-3/proxypilot-backlog-docs`.
- [CB01–08 backlog](fractionate-project-credentials-backlog.md) and [F8/F9 follow-on backlog](fractionate-follow-on-plan.md) own broker/custody confirmation, activation, isolation, real adapters/pilot, browser/OAuth, credential migration, text/image/document ingestion with originals and AI drafts plus human approval, and relational/S3/optional vector/event-ledger architecture. These items remain unaccepted planning; no stack or trust decision is made here.
- Updater PR718 and preservation PR719 are already in main and are excluded.

## Milestones and acceptance

| ID | Deliverable | Current state | Independently verifiable acceptance/evidence | Implementation commit |
| --- | --- | --- | --- | --- |
| UX01 | Reference inventory, route/state/viewport mapping and contract gaps | Mapping recorded; visual acceptance pending | Actual reference pixels inspected on Duo; see reference map; all supplied Library bytes now readable | c4cc81a8 (tracker start) |
| UX02 | Shared type, icons, spacing, controls, border/radius tokens | Implemented; frozen-state geometry passed | Same measured geometry in Midnight/Latte/Office; actual screenshots inspected; final accessibility gate pending | bf9b241e |
| UX03 | Operations shell, persistent project list and overview cards; short creation | 40/60 split and compact Overview integrated; new browser check pending | Earlier private creation/cancel/Details checks passed at 96eed9c3. New assertions require 38-42% list width and complete Access card within the 1536x1024 canvas | b09d757d, b220f404 |
| UX04 | Work/Connections/Controls/Review agent setup | Compact paired fields and keyboard disclosures integrated; new browser check pending | 208px summary retained. New assertions require selected connection row at most 112px and setup footer within 1536x1024. Save draft remains separate from assignment/run | d47cbf32 |
| UX05 | Connection picker, centered Add dialog, catalogue/readiness actions | Compact rows/dialog copy integrated; new browser/accessibility check pending | Previous source 96eed9c3 passed 13 journeys/18 layouts and Lighthouse 96-100. Those results do not accept the new rendered source | d47cbf32 |
| UX06 | Run hierarchy and browser/activity balance | Final composed A6 passed; actual final desktop pixels inspected | At source 0411e2cc: 20 journeys / 96 layouts, all four latest entries and the whole frame visible at 1280x800, desktop approval rail, one mobile approval, digest/sudo, keyboard, stale approval and takeover/recovery. A7 and accessibility refresh pending | 10dceed2, 322a6088, 0411e2cc |
| UX07 | Final aggregate checks, browser journeys and visual review | New source syntax and focused units passed; fresh build/render pending | Six changed JSX files and two browser scripts parse. Nine connection/readiness/run-deck unit tests passed. Earlier build, nine frontend unit tests, backend 202 and browser evidence remain recorded at 96eed9c3; environment failures remain disclosed | d47cbf32; prior 96eed9c3 |
| G01 | Guide UI dependency: authorized save/approval | PR720 merged; deployment confirmed by parent | Release head 4962c695; merge 56c881be. Final merged UI guide suite exited cleanly at 96eed9c3 (16 layouts, immutable saves, permissions and stale-evidence CAS) | 4962c695, 56c881be |
| W01 | Public read-only website review UI and flow | PR721 merged; parent awaits Thomas's built-in Update | Parent reviewed exact release head 29b3a592 with green CI and both reported P1 fixes cleared. Verified merge35c2e9d4 is integrated into fullUI; independent source review confirms its website flow unchanged. Fresh composed UI/website browser checks remain pending | release 29b3a592; main35c2e9d4; local38a14238 |

No completion percentage is assigned. A milestone is accepted only when its evidence is linked and limitations are stated.

### 18:17 UTC checkpoint

Final A6 report: local `../verification/ui-final/agent-runs.browser/report.json`, SHA-256 `4e1d65f1c1ff5fb5f0b44fdfb29d4145e98cc6d71a9f569c69fda7c01f3271ae`. The actual `deck-1280x800.png` has SHA-256 `c8a676ec4ea292a1a66574e0feb55cf850b0ec88efbEec720da4dddee2cb87c1`. Compared with Flightdeck, the browser dominates and the approval is now in the right rail above bounded activity. All four recent entries fit without outer page scrolling. Task/recent-step content remains reachable in the browser card's inner scroll. The frame is a scripted fixture; arbitrary instructions, training video and live video remain unsupported reference concepts.

Root now owns the released Chrome slot and has started a serialized fresh build, alignment/theme comparisons, Connections, A7, guide and website preservation suites, and accessibility gates. The previous Office-reset evidence is explicitly superseded only when real theme captures finish. Overview/Setup/Add screenshots from the final source are still pending; the merged-source measurements (40% list, Access bottom 929px, selected row 107px, setup footer bottom 897.5px) are supporting evidence, not a final pixel acceptance claim.

Parent reports updater repair PR722 merged at `f5a8509b9fb1a931d174fcbe1e531190c8c691ab`, with Thomas's retry pending. It is a compatibility-only repair and does not change UI/runtime product source. This report does not claim the repair is deployed. Keep that update separate from full UI publication and do not restart unchanged UI verification merely for its docs/compatibility changes.

## Reference inventory and route mapping

Initial confirmed local references:
- `C:/Users/thoma/Fractionate/OpenAI/outputs/agent-platform-setup/agent-connections.png`: inspected; Operations project list/detail, Agents setup Connections state, narrow assignment summary.
- `C:/Users/thoma/Fractionate/OpenAI/outputs/agent-platform-setup/add-connection.png`: inspected; centered credential dialog over the same setup route.
- `design-and-prompts.json`: source title “Fractionate Agent Vison Plan and Review”, thread `01a0d3b8-06f8-7fb2-9c6f-02ad48e753a9`; no chat URL supplied.
- Library approved references: Projects-add-connection, Projects-setup, agent-flightdeck, agent;s-mockup, Projects-mockup, palette. Current comparison images: Connections, Add dialog, Operations, Overview, Latte ended run. All materialized to the local Duo `references` folder with the current unmodified helper and a Windows named-metadata-stream adapter; byte sizes and Library identity/version streams verified. Actual Projects, setup, Flightdeck, agents catalogue, current Operations/Overview/ended-run and new approval-blocker pixels inspected. Do not infer setup appearance from global Connections.
- Additional usability evidence: `libfile_f96b564e9cdc819184ea510b566b29d2` and `libfile_ec32b6ade5cc81918a79c20b90caeeac`, inspected locally. TAG Armor's generic Researcher configuration has no guide/binding and a demo-only execution workflow; guide pending state showed the now-superseded independent reviewer blocker.

The route/state map is in [fractionate-ui-ux-reference-map.md](fractionate-ui-ux-reference-map.md). Reference canvases differ; exact dimensions and checksums are recorded there. Phone adaptations follow MOBILE_FIRST.md rather than copy desktop widths.

## Contracts and exclusions

Keep explicit run/action approvals, CSRF/sudo flow, permissions, secret non-disclosure, agent draft/readiness/run separation and no execution side effects on save unchanged. Existing infrastructure routes remain accessible. UI changes do not establish runtime capabilities shown only in concepts.

### Explicit policy scope change — 2026-10-02

Thomas requested: “Please remove the restrictions. By adding and saving, it should be approved.” This supersedes independent-review separation **only for authorized guide save/publication**. An owner/editor save validates and publishes an immutable approved version with author/time/version/hash/provenance. Existing pending submissions require an explicit Save and approve action using their saved snapshot; no migration bulk-approves them. Stale saves must fail revision checks. Existing approved versions and run pins remain unchanged. Saving a guide does not start a run, approve a credential write, grant access, enable an adapter, or widen the synthetic `https://demo.fractionate.ai` browser pilot. Historical backlog text describes the earlier policy; G01 owns this explicit change.

Excluded: production shell/SSH/MCP mutation, deployment, credential enrollment, broker activation, trust acceptance, stack selection, updater/preservation work, push/merge/un-draft and rewriting pushed history. Local disposable browser fixtures may simulate responses; evidence must identify fixtures rather than imply production proof.

## Evidence log

- Baseline and original backlog ancestry verified; no remote mutation.
- Local mockup pixels inspected using image viewer.
- AGENTS.md and .agents/skills are absent from current repository; CLAUDE.md, LEARNINGS.md, MOBILE_FIRST.md and relevant design-reference instructions were inspected.
- Local evidence lives in sibling `../verification/`: `final-dashboard.log`, `final-build.log`, `operations-guide.log`, `ui-alignment/ui-alignment-report.json`, and `connections/broker-ui-report.json`. Reports identify disposable/frozen fixtures; no production proof is inferred.
- The user-facing tracker PDF is Library file `libfile_e940e43282948191b79f8d07093b9e22`; future updates replace this identity.
- Current full UI code 96eed9c3: build and 9 frontend unit tests passed; frozen UI suite passed 8 journeys and 28 overflow audits at seven widths. A6 passed 20 journeys / 96 layouts. Released guide assertions passed against the combined layout. The serialized Connections rerun passed 13 journeys / 18 theme-width audits and Lighthouse 96-100; the earlier concurrent cold-start failure is resolved by serialization. Contrast/heading findings remain disclosed.
- [Rendered visual review](fractionate-ui-ux-visual-review.md) retains seven actual screenshots in the repository with byte sizes and SHA-256 hashes. It records remaining density differences and labels the scripted run frames.
- Website evidence: component syntax/build passed, 9 grouped component journeys / 21 color-only theme-width audits passed at e355f5c0; full main dashboard source eb46eef7 passed 3 journeys / 9 layouts; runtime source fb5d4bb3 passed 4 real API/store/extraction/signed-bridge fixture journeys / 2 layouts. Runtime receipt/capability defects and cancellable timeout were fixed at 9e02012f. Final integrated release CI backend selection passed 223 and cross-language Python review passed 9. The final composed release production build passed; component/dashboard/signed-runtime browser suites exited zero, and three actual dashboard mobile Lighthouse snapshots scored 100. Frozen source is da6630b83ff01e392be058557784ccc531492142; retained reports and screenshots are in the release branch under docs/plans/assets/public-website-review/release. No live provider proof is claimed.

## Blockers and decisions

- Library helper Windows metadata incompatibility resolved with NTFS named streams while keeping the current helper unchanged; all requested references readable with identity/version preserved.
- Precreation user-picker contract gap: `GET /:id/access/candidate` requires an existing project and owner access; the global user directory is administrative. The short creation flow defaults private, then directs the owner to named existing-user lookup in Access. No new account-enumeration endpoint is introduced.
- Browser execution remains the synthetic sign-in pilot at `https://demo.fractionate.ai`; configured generic work is not general research capability. Typed API configuration remains limited to supported adapters. Surface those constraints before setup and beside readiness actions.
- Repository aggregate selection/build and broker/agent browser checks were run; local environment failures remain disclosed. Linux host/root tests only use disposable local WSL fixtures. Docker and iptables are absent: two real OpenBao cases in the broker aggregate failed with `spawnSync docker ENOENT`; 83 remaining broker tests passed. No test is silently skipped or counted as passed.

## Website release integration and host boundary

Root's frozen website frontend/runtime integration branch is `ui/website-review-integration-20261002` in `../website-review-integration`. The separate runtime owner owns the final website/updater release composition; root's branch remains available as its reviewed input. Other UI branches are not competing publication candidates. Runtime documentation and byte-for-byte backend/script identity are preserved. Repository CI adds component and full-dashboard website browser journeys; signed-runtime proof is retained in `docs/plans/assets/public-website-review`.

A normal dashboard update does not replace the installed A3/A4 component copies. A separately reviewed key-preserving updater refresh must update the two existing component files and their verified digests while checking the unchanged A8 pins before live website review can become ready. Repository implementation/testing of that refresh was authorized through the parent at 16:27 UTC; its separate runtime owner is working on it. Host activation and publication remain pending. No activation, new credentials, production review or privileged auto-update hook is performed here.

The runtime owner's full backend aggregate recorded 3,536 passed, 10 failed, 4 cancelled and 40 skipped. The 10 failures were reproduced on verified main (missing default Playwright shell, canonical root credential custody, writable cgroup). Runner-startup timeout evidence is retained; one timeout also reproduces on main and three isolated cases pass. This is not reported as a green full aggregate. See the release's `docs/plans/public-website-review-evidence.md`.

## Current reviewable deliverables

- Website release head `444cc2fe7b67e0bbea56103a6bbb824e669f06fd` (evidence-only after tested source `da6630b83ff01e392be058557784ccc531492142`), clean and unpublished. No product source changed after the frozen tests.
- Full mockup UI product source is now `d47cbf32f4f54fc9199063b9ff4a2863dfa58cd7`; fresh build/render checks are pending. Retained screenshots in `docs/plans/evidence/ui-ux-20261002` apply to earlier source `96eed9c3`, not this refinement.
- The maintained user copy replaces Library file `libfile_e940e43282948191b79f8d07093b9e22`; four curated unchanged PNGs accompany it. Their manifest identifies exact source commits and hashes. The website evidence image is a scrolled viewport, not a capture of the whole long result.
- Remaining decisions: full mockup visual/density acceptance; later reviewed website/updater publication; host activation through the subsequently approved supported Update path. No new credentials or key rotation are needed for the proposed refresh. No live review proof is claimed.

Library delivery checkpoint: the current local two-page PDF and four unchanged PNGs are ready under output/pdf and output/ui-review. The prepared-upload helper reported that its required Library preparation action was unavailable before any transfer; this update was not saved to Library. The existing tracker identity was last confirmed at version 2. No duplicate tracker was created or version guard removed.

## Supported refinement checkpoint

Resumed after parent confirmed PR721 merged. GitHub main was independently verified at `35c2e9d4eb657f92e1499d8d56035217b04f7ae6` and merged locally as `38a14238d9de2c5d12eec99365e095cefc73a0a3`. Website component/backend/updater source is preserved. Local merged-source checks passed: production build, nine frontend unit tests, 224 dashboard contract tests, eight alignment journeys and 28 overflow audits. Measured geometry: 40% list width; Access bottom 929px; selected connection 107px; continuation bottom 897.5px at 1536x1024.

Fresh review exposed two remaining verification defects: the alignment fixture reset every navigation to Office, so its three identically colored screenshots prove Office geometry only; the 1280x800 run fit test showed only three of the latest four activity entries completely visible beside the new approval rail. Neither result is accepted as a final gate. Root is correcting real palette switching and mobile tab visibility; the isolated run owner is fixing the measured activity-space deficit without weakening the four-entry assertion. Chrome/build release priority is cleared. No full UI publication or production work is authorized.

The three isolated source changes are integrated. No claim of new pixel fidelity is made until the browser checks below run against the current source.

| Change | Root commit | Owner commit | Required acceptance |
| --- | --- | --- | --- |
| 40/60 project split, compact Overview, full history disclosure | b09d757d | 1c36dee7fd6c3716a67597690faf74e14904a5d5 | Measure list fraction and Access bottom at 1536x1024; inspect reference comparison and phones |
| Visible synthetic-pilot runtime unavailable reason | b220f404 | Root integration | Unavailable runtime reason stays visible in compact summary |
| One approval card, desktop right rail and visible phone placement | 10dceed2 | 0dc38cc334dce8c303f4cc729e572c41a9eee3f0 | Approval is right of browser and above rail tabs; visible once on all phone panels; approvals/takeover/reconcile/history journeys still pass |
| Flightdeck run title size | 322a6088 | Root integration | Inspect 32px desktop run title without changing other page headings |
| Tight rows, paired setup fields, keyboard disclosures, concise Add copy | d47cbf32 | eef1636ec2a8a817ad448c252c2196af4e5dc721 | Selected row at most 112px, setup footer fits reference canvas, mobile keyboard/intake/permissions/revoke checks pass |
| Stronger reference geometry assertions | 41ebeb9c | Root integration | Existing eight UI journeys and overflow/theme audits also pass without weakening the new fit assertions |

Source-only verification passed: all six changed JSX files parse; UI alignment and run browser scripts pass syntax checks; nine existing connection/readiness/run-deck unit tests pass. Exact commands, counts and output are retained in [polish-source-check.json](evidence/ui-ux-20261002/polish-source-check.json). No build or browser was started for this checkpoint. Configured broker compatibility text follows the existing strict `broker.v1` contract, which requires `compatible: true` in configured mode.

Website/updater publication is the priority. Its separate runtime owner has the Chrome/build resource slot; root will promptly perform requested release frontend checks. The frozen website head `444cc2fe7b67e0bbea56103a6bbb824e669f06fd` remains clean and unchanged. Full UI publication is not authorized. Local tracker and screenshots remain deliverables; the Library prepared-upload failure above is not retried or routed through another writer.
