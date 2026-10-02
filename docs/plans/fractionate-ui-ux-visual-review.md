# Fractionate rendered UI review

Review source: `96eed9c3fc9115e28076a9480dca91880ac53da3`, locally integrated with GitHub main `56c881be051e2699abac1977bfa0162cd8536183`. Screenshots were captured and their actual pixels inspected on Duo. They show disposable fixtures, not production or live provider proof. [Screenshot hashes and byte sizes](evidence/ui-ux-20261002/screenshots.json) identify the retained bytes.

## Actual screens

| Screen | Rendered evidence | Comparison and limits |
| --- | --- | --- |
| Overview, desktop | [1536px screenshot](evidence/ui-ux-20261002/overview-office-1536.png) | Project list remains beside selected detail, with guide/readiness/agents/activity/access cards and separate Details actions. At 1536px the navigation is 224px; project list/detail are approximately 449px/799px. Reference Projects canvas is 1586px; proportions are comparable rather than copied as fixed widths. |
| Overview, phone | [375px screenshot](evidence/ui-ux-20261002/overview-office-375.png) | Project switching uses a disclosure, cards stack, creation stays visible and tabs scroll locally. No document overflow with the global guard disabled. The screenshot shows the viewport, not every item in the inner scrolling content. |
| Connections setup | [1536px screenshot](evidence/ui-ux-20261002/setup-connections-office-1536.png) | Work/Connections/Controls/Review hierarchy, application rows and 208px assignment summary follow Projects-setup. The redundant nested outline/padding was removed. Current selected card remains about 130px tall versus about 104px in the reference; truthful broker/provider/browser availability text increases overall height. Exact density acceptance remains open. |
| Add connection | [Desktop](evidence/ui-ux-20261002/add-connection-office-1536.png), [phone](evidence/ui-ux-20261002/add-connection-office-375.png) | Desktop dialog is centered at 600px width; label/control grouping follows the reference. Phones use a full-screen scrolling dialog. A broker-owned intake replaces the concept secret field; assignment follows saving. Browser/OAuth and arbitrary services are explicitly unavailable. |
| Run needing approval | [1280x800 screenshot](evidence/ui-ux-20261002/deck-1280x800.png) | Browser panel dominates with bounded activity/guide/details rail, compact state hierarchy and visible approval action. The colored frame is a scripted supervisor test image, not a real website screenshot. Real CSRF/router/store/coordinator and receipt verification are exercised by the suite. |
| Finished run | [Result screenshot](evidence/ui-ux-20261002/flow-result.png) | Historical status, last-frame labeling and recorded outcome remain visible. Existing immutable guide pins and approvals were retained. Public website review is a separate workflow and is not demonstrated by this synthetic sign-in screenshot. |

## Verified behavior and unresolved evidence

- UI alignment: 8 journeys and 28 overflow audits passed at 360, 375, 390, 768, 1280, 1536 and 1920px. Frozen Office/Latte/Midnight geometry is identical. Themes change colors only; no Nodus branding appears.
- A6 final rerun: 20 journeys and 96 layout checks passed, including keyboard approval, permission loss, stale guide/binding, stop, reconnect and historical run handling. A7 prior final-code tests passed 6 journeys and 42 layout checks.
- Guide browser assertions passed against this merged UI: atomic save, immutable revisions, explicit pending approval, viewer access, five widths and interrupted evidence CAS; no run starts on save. The corrected local shell wrapper rerun exited cleanly with all assertions passing and 16 layout checks.
- Final serialized Connections evidence at `96eed9c3fc9115e28076a9480dca91880ac53da3`: 13 journeys / 18 theme-width checks, keyboard focus, functional contrast and inert-save behavior passed. Lighthouse scored Project Agents 100, Add Midnight 96 / Latte 100 / Office 100. Earlier concurrent cold-start failures are superseded by this successful serialized rerun.
- Build and 9 frontend unit tests passed. Backend aggregate passed 202 tests at the prior implementation, with no subsequent backend product change in this branch. Lighthouse gates passed 96-100; contrast and heading-order findings remain, so no claim of zero accessibility issues is made.
- Docker/iptables are unavailable locally. Two real OpenBao cases failed with Docker ENOENT, while 83 other broker tests passed. A local Linux security aggregate passed 312/313; the unchanged MCP file failed a source snapshot comparison due to CRLF/LF. No unrelated security repair is included.

Visual acceptance requires reviewing these actual rendered screens and the documented differences. Functional success and color themes alone do not establish mockup fidelity. The remaining density difference, unavailable runtime concepts, and local integration limits are deliberately visible in the [tracker](fractionate-ui-ux-tracker.md).
