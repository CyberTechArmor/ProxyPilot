# Fractionate rendered UI review

Frozen product source: `00b5c68d0816cb0921a2caee71a11adcf8d71ec7`, composed with independently verified main `35c2e9d4eb657f92e1499d8d56035217b04f7ae6`. Actual final pixels were inspected on Duo by root and surface reviewers. These are disposable local fixtures, not production/live-provider proof. [PNG hashes/canvases](evidence/ui-ux-20261002/screenshots.json) and [report provenance](evidence/ui-ux-20261002/verification-manifest.json) identify retained bytes.

## Actual final screen comparisons

| Screen | Retained actual pixels | Reference comparison and limits |
| --- | --- | --- |
| Overview desktop | [Office](evidence/ui-ux-20261002/overview-office-1536.png), [Latte](evidence/ui-ux-20261002/overview-latte-1536.png), [Midnight](evidence/ui-ux-20261002/overview-midnight-1536.png) | Persistent project list and selected detail use40/60; full Access card fits at 929px. Real three palettes differ; identical geometry. The2x2 cards differ from the reference's taller columns. |
| Overview phone | [375px](evidence/ui-ux-20261002/overview-office-375.png) | Project switch collapses; cards stack; tabs scroll horizontally. This viewport does not show every lower card. |
| Short project creation | [Phone](evidence/ui-ux-20261002/new-project-office-375.png) | Name/purpose, private default and subsequent owner Access lookup; no raw IDs or fabricated precreation user directory. |
| Four-step setup | [Work](evidence/ui-ux-20261002/setup-work-office-1536.png), [Connections](evidence/ui-ux-20261002/setup-connections-office-1536.png), [Controls](evidence/ui-ux-20261002/setup-controls-office-1536.png), [Review](evidence/ui-ux-20261002/setup-review-office-1536.png) | Paired fields, bounded cards and 208px summary. Selected connection 107px. Work action bottom 1003.5, Connections 897.5; Controls/Review actions visibly fit. Supported capabilities remain explicit. |
| Setup phone | [375px](evidence/ui-ux-20261002/setup-connections-office-375.png) | Active Agents tab visible; four steps clear; assignment summary/content stack vertically. Lower controls require scrolling. |
| Add connection | [Desktop](evidence/ui-ux-20261002/add-connection-office-1536.png), [phone](evidence/ui-ux-20261002/add-connection-office-375.png), [phone footer/error](evidence/ui-ux-20261002/broker-modal-footer-office-375.png) | Centered600px desktop shell, aligned grouped fields and advanced chevron; full-screen phone dialog with reachable actions/focus recovery. Metadata-only save/trusted external intake and separate assignment replace the concept secret field/Save securely and assign. |
| Approval run | [1280x800](evidence/ui-ux-20261002/deck-1280x800.png), [phone Details](evidence/ui-ux-20261002/phone-details.png) | Browser dominates; approval is above right-rail tabs, all four recent entries and whole frame fit. One mobile approval remains visible across panels. Task/recent steps remain reachable by inner browser-card scrolling. Colored frame is scripted; no live video proof. |
| Finished run | [Result](evidence/ui-ux-20261002/flow-result.png) | Historical outcome and last-frame state preserved; immutable guide pins and human controls retained. Synthetic sign-in is separate from public website review. |
| Released website preserved | [Phone source evidence](evidence/ui-ux-20261002/website-review-completed-evidence-mobile.png) | Actual dashboard/API/store/extraction/signed-bridge fixture. This is a scrolled evidence viewport, not the whole long result or a live public-provider run. |

## Verified geometry and behavior

- Final production build and JSX parsing passed; nine frontend unit tests passed. The 224 dashboard/backend contracts passed at merge 38a14238; backend bytes are unchanged in the final frozen source.
- UI alignment: 8 journeys/28 layouts; Connections: 13/18; A6: 20/96; A7: 6/42; typed tasks: 7/6. All recorded assertions passed on the final product source. Guide checks passed with 16 layouts, immutable approval, stale-evidence CAS and no run starts.
- Website preservation: component 9/21, real dashboard 3/9, signed runtime 4/2. Website mobile accessibility: 100/100/100. Sites/providers and browser frames are scripted local fixtures; no production or live-provider proof.
- Connections accessibility: Project Agents 100; Add Midnight 96, Latte 100, Office 100. Seven run/Operations mobile pages scored 96-100 and passed the repository minimum 90 gate.

- Seventeen actual final screenshots with canvases, hashes and exact source are retained in the repository. All desktop/phone surfaces were inspected against the approved references; the complete Access card, setup actions and right-rail approval are now visible.
- The layout follows reference proportions and hierarchy. Visible differences remain: Overview uses a 2x2 grid plus Access, type appears heavier, and truthful availability/pending states replace unsupported concept content. No pixel-perfect claim.

## Remaining visual and environment limits

- Two real OpenBao browser integrations stopped during fixture setup with Docker ENOENT. They are blocked, not passed. Docker/iptables integration remains unavailable locally.
- Accessibility gates passed, with remaining color-contrast and heading-order findings recorded. Earlier broader aggregates had environment/baseline failures (including CRLF source snapshot, root custody/cgroup and default browser path); they are not reported as green full aggregates.
- A local wrapper reread failed after completed passing A6 assertions. Fresh wrapper syntax succeeded and remaining checks completed separately. Exact node/report and wrapper outcomes are retained; no failed wrapper is counted as a passing aggregate.

- Overall visual treatment follows reference proportions, card hierarchy, compact rows, grouped fields and desktop approval placement; it is not an exact pixel reproduction. Current persistent navigation rail 224px versus reference 210px, heavier-looking type, Overview2x2 plus Access rather than two tall columns, and setup 40/60 versus reference approximately 37/63 remain visible differences.
- Four project fixtures leave more whitespace than the reference's five/eight examples; truthful guide/readiness/availability/pending states replace concept toggles, fabricated running/training states, connected model/browser-account examples and intake assumptions.
- Unsupported Browser/OAuth/link-existing-secret labels are static and clearly marked unavailable. Pending selections and broker-unavailable text qualify the Assigned heading/Verified credential status. Mobile setup starts below the project header; vertical scrolling is expected, with tested reachable actions and focus.
- Direct-agent instructions, training/capture material and live-video concepts have no current implementation contract. Do not widen capabilities to imitate reference content.
- The precreation people picker is limited by the existing owner/project-scoped API; named lookup follows private creation. Infrastructure routes, permissions and explicit approvals remain available.

Earlier Office-only theme evidence, clipped fourth event and clipped Work footer were corrected and replaced by these final pixels. No visual gate was weakened. This is a reviewable local result with stated differences; Thomas's acceptance and publication remain separate.
