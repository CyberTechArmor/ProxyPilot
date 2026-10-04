# Fractionate UI/UX alignment tracker

## Current owner-directed UI release — 2026-10-04

This section supersedes the historical ownership, exposed-demo and reference-retrieval wording below. Work is in cloud isolated worktrees; the owner performs production updates. Original Library reference bytes were retrieved and inspected on October 4. No production mutation was performed for this slice.

| Item | Status | Evidence / deployment | What I should see or be able to do |
| --- | --- | --- | --- |
| Projects original hierarchy | In progress | New two tall Overview cards and full-width Access; independent source68c8c18a approved; integrated10journeys/seven-width overflow passed; PR748 published; final exact-head CI pending | Projects & SOPs first, 210px desktop navigation, project/detail split, Guide & material and Version & readiness |
| Four-step browser setup | In progress | Seven fixture journeys; six-width checks; final narrow stepper corrected; seven exact integrated journeys and four Lighthouse100 audits passed | Work → Connections → Controls → Review; plain website/objective fields; editable inert settings; exact review before execution |
| Original Add connection dialog | In progress | Six-width create/edit/conflict/history/revoke, keyboard/focus, axe0 and mobile Lighthouse100 fixtures | Centered600px dialog, aligned fields, segmented types; contributor-private inert plans, no secret intake |
| General-runner Flightdeck | In progress | Six-width native/fallback/fullscreen/approval/Stop fixtures; independent final source review approved; PR748 published; final exact-head CI pending | Active browser fills work area,64/36 browser and review rail,32px task title, compact controls, Task/Recent activity; project list returns after Stop |
| Agents overview | In progress | Real API metadata fixture, bounded6-project batches, six-width axe0 and Lighthouse100 | Two-column cards for loaded real runs; explicit project setup/run links; no invented thumbnails or fleet concurrency |
| Demo retirement | In progress | Access-checked410 for start/resume, retained historical Stop/approval/recovery; local historical lifecycle journeys passed; final exact-head CI pending | No demo creation/start/practice/resume; historical sign-in records and controls remain behind disclosures |
| Project connection plans everywhere | In progress | Global Connections permission/current-revision/identity-race fixture, six-width axe0 and Lighthouse100 | Choose permitted project, manage own inert plans in Connections, setup and project Access; existing broker records remain in storage |
| PR747 necessary metadata dependency | Merged | Independently source-reviewed; exact91621229 CI passed; merged4fbd5f3a after explicit owner approval | Draft connection records and durable human comments; enrollment/OAuth execution remain unavailable |
| Exact candidate merge / owner update | In progress | Explicit owner approval resolved publication/merge blocks; reviewed tree62bf9402 published in PR748; legacy fixture adaptation and final CI pending | Concrete reviewed PR first; owner ordinary app update after merge; no runtime Install for this UI slice |
| Deployed acceptance | Blocked | Waiting for owner update; fixtures are not deployed/provider proof | Verify running source/dashboard/agent and unchanged installed/loaded helpers, then serialized actual public browsing, Stop and UI checks |

No numerical completion percentage or pixel-perfect acceptance is assigned. Follow [current release procedure](fractionate-ui-first-release-20261004.md) and [reference comparison](fractionate-ui-ux-visual-review.md). Preserve the frozen broader backend candidates until this UI phase is accepted.

## Historical October 2 evidence (not current acceptance)

Owner: Thomas. Started 2026-10-02; repository implementation and verification on Duo.
Branch: `ui/mockup-alignment-20261002`. Frozen product source: `00b5c68d0816cb0921a2caee71a11adcf8d71ec7`.
Thomas authorized draft PR publication on 2026-10-02. Final demo labels/navigation are being verified before publication; merge and deployment remain pending separate decisions.

## Baseline, dependencies and preserved backlog

- Original GitHub main was verified and fetched at `0f1b48f33fe31723100b8c758c717899bb7b3f1d`. Main `35c2e9d4eb657f92e1499d8d56035217b04f7ae6` was merged locally as `38a14238d9de2c5d12eec99365e095cefc73a0a3`. Before draft publication, current GitHub main was independently verified at `ed87dd059b9dafb9c34f19098416cb3870bf3ec1` and cleanly integrated as `e5066256b409314d8bbb73fb156b054052f45467`; the intervening compatibility/updater changes do not change UI product files.
- Original docs-only backlog `ac62d45dba876b248b687679268a8d165ed221fd` is preserved unchanged as an ancestor. Its clean original `proxypilot-backlog-docs` worktree is preserved on Duo.
- [CB01-08](fractionate-project-credentials-backlog.md) and [F8/F9](fractionate-follow-on-plan.md) own unaccepted custody/trust confirmation, broker deployment/activation, independent isolation, real adapters/pilot, browser/OAuth, expanded credentials/migration, ingestion retaining originals with AI guide drafts and human approval, and relational state/S3 artifacts/optional vector retrieval/event ledger with permitted outcomes/comments. These remain backlog planning: no stack choice, implementation or trust acceptance.
- Guide PR720 was separately authorized, merged and successfully updated according to the parent. Its guide-only Save-to-approved policy is preserved below.
- Website/updater PR721 was separately reviewed and merged at main 35c2e9d4. Parent reports compatibility-only repair PR722 merged at `f5a8509b9fb1a931d174fcbe1e531190c8c691ab` and successful website deployment to `ed87dd05`; the first live pilot is pending Thomas. Recovery/deployment were separately owned. This executor performed no production actions; local tests remain attributed to the integrated main 35c product.
- Updater PR718 and preservation PR719 are already completed and excluded.

## Independently verifiable milestones

| ID | Deliverable | Current state | Acceptance evidence | Implementation commit |
| --- | --- | --- | --- | --- |
| UX01 | Actual references and route/state/viewport mapping | Recorded; pixels inspected | [Reference map](fractionate-ui-ux-reference-map.md), Library bytes readable locally, original title/thread retained | c4cc81a8 |
| UX02 | Shared typography/icons/spacing/controls; color-only themes | Implemented; three real palettes verified | Final frozen-state geometry is identical; three body colors and PNG hashes differ; no Nodus branding | bf9b241e, 1fd40ca7 |
| UX03 | Operations shell, project list, Overview and short creation | Implemented; local journeys passed | 40/60 split; Access bottom 929; private creation/cancel/reopen; Details separate; named Access lookup after creation | b09d757d, b220f404, 1fd40ca7 |
| UX04 | Work/Connections/Controls/Review setup | Implemented; all four screens reviewed | Work footer 1003.5; Connections footer 897.5; selected row 107; narrow 208px summary; inert draft saves and mobile tab visibility | d47cbf32, 00b5c68d |
| UX05 | Connection picker/dialog/catalogue/readiness | Implemented; journeys/accessibility passed | 13 journeys/18 layouts; keyboard/focus, trusted-intake simulation, unavailable/revoked/permission states, unassign versus revoke | d47cbf32, 1fd40ca7 |
| UX06 | Browser/activity/approval run hierarchy | Implemented; A6/A7 journeys passed | A6 20/96, A7 6/42; whole frame and latest four at 1280x800; right-rail approval, one mobile control, sudo/digest/recovery retained | 10dceed2, 322a6088, 0411e2cc |
| UX07 | Final build/browser/visual evidence | UI checks passed; Docker blocked | Final build, 9 frontend units, 224 unchanged backend contracts; retained exact-source reports/PNG hashes and visual comparison | 00b5c68d |
| G01 | Authorized guide save dependency | Merged; composed UI assertions passed | Atomic immutable Save-to-approved; explicit pending snapshot approval/CAS; no run starts | 4962c695, 56c881be |
| W01 | Preserve released website review flow | Unchanged; composed journeys passed | Strict capability gate, URLs, separate save/consent/Start, signed real API/store fixture and mobile accessibility | main 35c2e9d4, local 38a14238 |

No completion percentage is assigned. Local evidence does not imply Thomas's visual acceptance, production deployment or live-provider proof.

## Final evidence and comparison

The retained build/browser/visual evidence below uses frozen product `00b5c68d0816cb0921a2caee71a11adcf8d71ec7` unless explicitly attributed otherwise. Final documentation and PNG retention do not change product bytes.

- Final production build and JSX parsing passed; nine frontend unit tests passed. The 224 dashboard/backend contracts passed at merge 38a14238; backend bytes are unchanged in the final frozen source.
- UI alignment: 8 journeys/28 layouts; Connections: 13/18; A6: 20/96; A7: 6/42; typed tasks: 7/6. All recorded assertions passed on the final product source. Guide checks passed with 16 layouts, immutable approval, stale-evidence CAS and no run starts.
- Website preservation: component 9/21, real dashboard 3/9, signed runtime 4/2. Website mobile accessibility: 100/100/100. Sites/providers and browser frames are scripted local fixtures; no production or live-provider proof.
- Connections accessibility: Project Agents 100; Add Midnight 96, Latte 100, Office 100. Seven run/Operations mobile pages scored 96-100 and passed the repository minimum 90 gate.

[Rendered visual review](fractionate-ui-ux-visual-review.md) compares actual final desktop/phone pixels with approved Projects, setup, Add and Flightdeck references. [Screenshot manifest](evidence/ui-ux-20261002/screenshots.json) records exact source, canvas, bytes and SHA-256. [Verification manifest](evidence/ui-ux-20261002/verification-manifest.json) attributes reports/logs, including tests without a native source field.

The corrected geometry is measured, not estimated: list 499.1875 / detail 748.8125 (39.999% list), Access bottom 929; Work action bottom 1003.5; selected connection 107; Connections action bottom 897.5 at 1536x1024. Office/Latte/Midnight body colors are rgb(248,250,252), rgb(247,244,238), rgb(26,26,26). At 1280x800 the approval is in the right rail, the frame fits, and all four latest events are completely visible without outer page scroll.

## Important decisions and remaining limits

- Two real OpenBao browser integrations stopped during fixture setup with Docker ENOENT. They are blocked, not passed. Docker/iptables integration remains unavailable locally.
- Accessibility gates passed, with remaining color-contrast and heading-order findings recorded. Earlier broader aggregates had environment/baseline failures (including CRLF source snapshot, root custody/cgroup and default browser path); they are not reported as green full aggregates.
- A local wrapper reread failed after completed passing A6 assertions. Fresh wrapper syntax succeeded and remaining checks completed separately. Exact node/report and wrapper outcomes are retained; no failed wrapper is counted as a passing aggregate.

Broader aggregate history remains disclosed: broker 83/85 (two missing-Docker cases), security 312/313 (unchanged MCP snapshot CRLF/LF difference), and the separate runtime owner's 3,536 passed/10 failed/4 cancelled/40 skipped with failures reproduced on main (default browser path, root custody and writable cgroup). These are historical results, not a green current full aggregate. See [website release evidence](public-website-review-evidence.md).

- Precreation people-picker contract gap: `GET /:id/access/candidate` requires an existing project and owner access; the global directory is administrative. Create privately, then use named existing-user lookup in Access. No account-enumeration endpoint or raw-account-ID creation UI was added.
- Generic API work is a typed synthetic-ledger workflow; the legacy browser profile is the synthetic sign-in pilot at `https://demo.fractionate.ai`. A freeform guide or Researcher role does not create general research capability. Public website review uses its separate released public HTML/text route.
- Add connection saves metadata and delegates credential intake to the trusted broker surface. Browser/OAuth/link-existing-secret concepts remain unavailable when unsupported. Assignment is separately confirmed; remove-assignment and global revoke remain different operations.
- Layout follows the approved hierarchy and proportions, but remains visibly different: Overview is a 2x2 card grid plus Access, rather than two taller reference columns; the persistent rail is 224px versus reference 210px; type appears heavier; setup uses 40/60 versus reference approximately 37/63. Fixture row counts and truthful availability/pending content differ. These are disclosed for review, not called pixel-perfect.
- Phone screenshots show viewports; lower cards/footers require vertical scrolling. Active sections scroll into the horizontal tab strip without moving the outer page. Mobile journey evidence covers footer reachability, focus, Escape and repeated/cancel/back behavior.

## Contracts and exclusions

Keep permissions/CSRF/sudo, exact-operation approvals, secret non-disclosure, revocation, interrupted/repeated request handling, immutable historical guide/run status, takeover/reconciliation and no execution side effects on save. Infrastructure routes remain accessible.

Thomas explicitly requested that adding/saving a guide approves it. This supersedes independent-review separation only for authorized guide publication. Owner/editor Save validates and atomically publishes an immutable version with author/time/hash/provenance. Existing pending submissions require explicit Save and approve of their saved snapshot with CAS; no migration bulk-approves them. Existing pins are immutable. Saving a guide starts no run, approves no credential action, grants no access and enables no adapter.

Excluded: production shell/SSH/MCP mutation, deployment, credential enrollment or broker activation, trust acceptance, stack selection, push/merge/un-draft and history rewrite. This executor performed none. Local disposable fixtures do not establish external account/provider or production readiness.

## Exact commit ledger and verification corrections

| Change | Root commit | Original owner commit/evidence |
| --- | --- | --- |
| Initial tracker, reference inventory and preserved backlog | c4cc81a8; ac62d45d | Original backlog worktree remains clean |
| Shared tokens and color-only themes | bf9b241e | Final nine unit tests and geometry assertions |
| Recent-activity descending read with stable permission-safe pagination | 2dfef8f5 | 224 contracts at 38a14238; backend bytes unchanged afterwards |
| Stronger proportional/row/footer assertions | 41ebeb9c | Final UI report retains exact measurements |
| 40/60 split, compact Overview and full history disclosure | b09d757d | 1c36dee7fd6c3716a67597690faf74e14904a5d5 |
| Visible synthetic-pilot unavailability | b220f404 | Final Overview pixels |
| Desktop right-rail/single mobile approval | 10dceed2 | 0dc38cc334dce8c303f4cc729e572c41a9eee3f0 |
| Flightdeck title sizing | 322a6088 | Final 32px desktop run title |
| Tight setup rows, paired fields/disclosures and Add copy | d47cbf32 | eef1636ec2a8a817ad448c252c2196af4e5dc721 |
| Verified main 35c integration | 38a14238 | Released website/runtime/updater bytes preserved |
| Real theme fixture, mobile active tab, active access count, advanced chevron | 1fd40ca7; c7c68096 | Corrected duplicate declaration; nine units passed |
| Full-frame/latest-four fit beside approval | 0411e2cc | dde406acf1ba657f7e5f939483df929fd22dfa80 |
| Work footer fit and new required assertion | 00b5c68d | Final action bottom 1003.5; no contract change |

Initial merge 38 evidence exposed an unconditional Office reset and a clipped fourth run event. Those results were not accepted; real palette switching and run height were corrected. The next 0411 render exposed a partly clipped Work footer; source 00b5 fixes it and adds a required assertion. Earlier evidence is retained locally under `../verification/ui-final/initial-38a14238` and `previous-0411e2cc`; the repository's final retained PNGs/reports replace the earlier 96eed9c3 set. No fit assertion was weakened.

Source review at `00b5c68d0816cb0921a2caee71a11adcf8d71ec7` found no concrete blockers: released website/updater product files are identical to main 35c; strict gates and URL handling remain; saves stay inert; recent-event ordering is SELECT-only and preserves access redaction/default ascending behavior.

## Local delivery and Library blocker

User-facing two-page PDF: `../output/pdf/Fractionate-UI-UX-tracker.pdf`. Curated unchanged PNG copies/manifest: `../output/ui-review`. Canonical tracker and retained evidence are repository-owned.

Library tracker `libfile_e940e43282948191b79f8d07093b9e22` remains at last confirmed version 2. The latest current prepared-upload helper failed before preparation because `Library prepare_uploads is not available`. No transfer/finalization/version change/duplicate tracker or new screenshot IDs resulted. No retry or alternate writer was used; deliverables are readable locally.
