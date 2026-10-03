# Operations Overview alignment and accessibility

User direction on 2026-10-03: own the browser/Operations updates, prioritizing UI/UX. This bounded batch follows the original Projects-mockup pixels (1586×992; reference-map identity and checksum retained) and keeps current runtime and permission contracts.

## Resulting interface

The selected project Overview uses two outlined summary columns: guide/material and agent requirements on the left, version/readiness and recent activity on the right. Access and connection permissions remain in the full-width row below. The groups stack on phones and narrow selected-project panes. Existing guide, version, agent and work-record actions remain available.

Operations selected-title weight is 600. Nested summary headings are level 3 beneath the selected project level-2 heading. The Operations index's explanatory card headings also follow its level-2 choice heading.

The desktop and phone project browsers share search/filter state but mount distinct search IDs and label targets. The New project action uses the same contrast treatment as shared Operations primary actions. Midnight Operations links, alerts and field boundaries use scoped functional colors; all three global palettes and identical theme geometry remain unchanged.

## Verification

The existing UI alignment suite now asserts the two reference summary columns, unchanged 40/60 list/detail range, complete Access-row fit, unique mounted search IDs/labels, responsive search persistence, correct nested summary headings, seven-width overflow audits and identical theme geometry. Its existing private creation, guide-save/CAS, inert agent-draft save and unsupported-capability journeys stay intact.

With LIGHTHOUSE_DIR set to an installation of Lighthouse 12 and puppeteer-core, the same route-intercept fixture snapshots Overview at 375px in Office, Latte and Midnight. The gate requires mobile accessibility ≥90 and refuses color-contrast, heading-order or duplicate-id-aria findings. Reports retain failing node details and source commit. Fixture screenshots are presentation evidence; they do not prove live provider, production deployment or runtime behavior.

Build/browser/CI validation is pending exact-head execution. No merge or production deployment is performed by this batch. The existing rail geometry, infrastructure navigation and browser workspace product files are outside this change.
