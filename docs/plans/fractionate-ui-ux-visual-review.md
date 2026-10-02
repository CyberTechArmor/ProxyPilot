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

## Final visible differences for review

These observations compare the retained source `96eed9c3` pixels with the approved
Projects, setup, Add and Flightdeck references. They are acceptance gaps, not a
proposal to add unsupported capabilities or redesign the reviewed website flow.

- **Overview fold and proportions:** the current Overview adds separate Agents
  and Recent activity cards. Capability explanation makes the Agents card tall
  and leaves Access only partly visible at 1024px; the Projects reference fits
  Access in its initial canvas. Its project list is also proportionally wider:
  approximately 41% of list/detail width versus 36% in the current Overview.
  The supplied canvases differ (1586px versus 1536px), so this is a proportional
  comparison rather than an equal-viewport pixel claim.
- **Setup fold:** beyond the selected-row 130px versus 104px difference, explicit
  model-provider, broker and Browser/OAuth availability explanations add vertical
  space. Current navigation buttons reach below the 1024px fold; the approved
  setup puts its footer in the first screen. The narrow assignment summary is
  present, but correctly labels saved-draft selections as pending assignments.
- **Dialog treatment and capabilities:** the centered 600px shell follows the
  reference. Its content differs visibly: metadata-only save, external broker
  intake or an unavailable-intake panel, disabled Browser/OAuth/link-existing
  types, and a separate assignment step replace the concept's secret field and
  Save securely & assign action. These are current contract boundaries, not
  missing styling acceptance evidence.
- **Run composition:** the implemented deck places a full-width digest/sudo
  approval banner above Browser and Activity/Guide/Details. The Flightdeck
  reference places its help card in the right rail and includes task/recent-
  activity cards under the browser plus Direct the agent. Those latter arbitrary
  instruction/training-video concepts have no implemented contract. The retained
  screenshot contains a scripted frame and lacks live video, so it cannot prove
  the reference's realistic browser content or takeover video treatment.
- **Navigation and state vocabulary:** existing Operations/infrastructure routes
  and Guide/Versions/Runs/Agents/Access/Details remain available. The reference's
  Projects/Applications/Knowledge/Flightdeck navigation, Training labels,
  project/agent toggles and fabricated running/training/help states are not
  duplicated. Current guide/readiness/access states use actual API data. The
  precreation people picker also remains deferred to named lookup after creation
  because its permission-safe API requires an existing project ID.

No further product or website changes were made for this comparison. Library
delivery remains the earlier tracker identity/version; the latest screenshot
deliverables are local because the required preparation action was unavailable.
