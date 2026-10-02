# Fractionate UI/UX alignment tracker

Owner: Thomas · implementation on Duo · started 2026-10-02.
Branch: `ui/mockup-alignment-20261002`. Publication/merge remains pending explicit instruction.

Checkpoint 2026-10-02 16:41 UTC: GitHub main verified at `56c881be051e2699abac1977bfa0162cd8536183` and merged locally without dropping either UI or guide tests. Current UI code is `96eed9c3fc9115e28076a9480dca91880ac53da3`. Full UI and website branches remain unpublished. Guide PR720 was separately authorized, merged and deployed; the parent verified its successful update receipt and healthy state. This executor performed no production actions.

Website release composition is isolated to `website-review-integration`, branch `ui/website-review-integration-20261002`, current head `444cc2fe7b67e0bbea56103a6bbb824e669f06fd`. It combines verified runtime `9e02012f`, the committed `e355f5c0` component, capability-gated navigation, real dashboard/API browser fixtures and signed model-bridge evidence. Backend and installed-script bytes match runtime proof `fb5d4bb3`. This branch excludes the larger mockup alignment and original backlog commits. Saving settings and owner consent remain inert; Start pins the approved guide/configuration. It does not use the legacy synthetic sign-in runner.

Delivery priority updated by Thomas: **first authorized guide Save-to-approved plus public read-only website review end-to-end**, then finish full visual alignment. A separate runtime worker owns the website capability and will provide its contract before UI integration. General login, credentials, writes, private-network access and bypassing site protections are outside that slice. Other expanded broker/guide/storage items remain in the original backlog.

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
| UX03 | Operations shell, persistent project list and overview cards; short creation | Implemented; integrated browser passed | List/detail screenshots inspected; private creation, cancel/reopen and separate Details verified; exact precreate lookup gap below | b35ac7bd, 608e47a7 |
| UX04 | Work/Connections/Controls/Review agent setup | Implemented; density refined and browser passed | Removed nested Connections outline/padding to align the reference; 208px summary; Save draft remains separate from assignment/run; final screenshots in sibling verification/ui-alignment | 6bfde28a, 234703bf |
| UX05 | Connection picker, centered Add dialog, catalogue/readiness actions | Final serialized browser and accessibility gates passed | 13 journeys and 18 theme/viewport checks at 96eed9c3; functional focus/input/status contrast passed; Lighthouse Project Agents 100, Add Midnight 96 / Latte 100 / Office 100 | 6bfde28a, 96eed9c3 |
| UX06 | Run hierarchy and browser/activity balance | Implemented; final A6 rerun passed | 20 A6 journeys/96 layout checks passed at 96eed9c3; prior 6 A7 journeys/42 checks passed; retained approval/finished-run screenshots reviewed | 0a88e924, 96eed9c3 |
| UX07 | Final aggregate checks, browser journeys and visual review | Available checks recorded; environment failures and visual acceptance open | Full UI backend 202 passed; website release CI selection 223 passed and Python review 9 passed; frontend build and 9 unit tests passed; UI flow/seven-width audit passed; Docker integration and final accessibility remain open | 96eed9c3; retained evidence |
| G01 | Guide UI dependency: authorized save/approval | PR720 merged; deployment confirmed by parent | Release head 4962c695; merge 56c881be. Final merged UI guide suite exited cleanly at 96eed9c3 (16 layouts, immutable saves, permissions and stale-evidence CAS) | 4962c695, 56c881be |
| W01 | Public read-only website review UI and flow | Local release checks passed; publication/updater integration pending | Frozen source da6630b8: final component 9 journeys / 21 theme-width audits, full dashboard 3 / 9, signed runtime 4 / 2; mobile Lighthouse 100 / 100 / 100. CI backend 223, Python review 9, frontend 4 and production build passed. Scripted site/provider fixtures, not live execution | runtime 9e02012f; tested da6630b8; evidence 444cc2fe |

No completion percentage is assigned. A milestone is accepted only when its evidence is linked and limitations are stated.

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

The sole proposed website release branch is `ui/website-review-integration-20261002` in `../website-review-integration`. Other branches retain prior owner evidence; they are not competing publication candidates. Runtime documentation and byte-for-byte backend/script identity are preserved. Repository CI adds component and full-dashboard website browser journeys; signed-runtime proof is retained in `docs/plans/assets/public-website-review`.

A normal dashboard update does not replace the installed A3/A4 component copies. A separately reviewed key-preserving updater refresh must update the two existing component files and their verified digests while checking the unchanged A8 pins before live website review can become ready. Repository implementation/testing of that refresh was authorized through the parent at 16:27 UTC; its separate runtime owner is working on it. Host activation and publication remain pending. No activation, new credentials, production review or privileged auto-update hook is performed here.

The runtime owner's full backend aggregate recorded 3,536 passed, 10 failed, 4 cancelled and 40 skipped. The 10 failures were reproduced on verified main (missing default Playwright shell, canonical root credential custody, writable cgroup). Runner-startup timeout evidence is retained; one timeout also reproduces on main and three isolated cases pass. This is not reported as a green full aggregate. See the release's `docs/plans/public-website-review-evidence.md`.

## Current reviewable deliverables

- Website release head `444cc2fe7b67e0bbea56103a6bbb824e669f06fd` (evidence-only after tested source `da6630b83ff01e392be058557784ccc531492142`), clean and unpublished. No product source changed after the frozen tests.
- Full mockup UI product source remains `96eed9c3fc9115e28076a9480dca91880ac53da3`; subsequent tracker/evidence commits preserve it. Actual layout evidence is in `docs/plans/evidence/ui-ux-20261002`.
- The maintained user copy replaces Library file `libfile_e940e43282948191b79f8d07093b9e22`; four curated unchanged PNGs accompany it. Their manifest identifies exact source commits and hashes. The website evidence image is a scrolled viewport, not a capture of the whole long result.
- Remaining decisions: full mockup visual/density acceptance; later reviewed website/updater publication; host activation through the subsequently approved supported Update path. No new credentials or key rotation are needed for the proposed refresh. No live review proof is claimed.
