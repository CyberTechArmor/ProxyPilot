# Foundation handoff and official next sequence

2026-09-25. The user selected committing/merging the completed local foundation
and making [A1–A8](fractionate-agents-a1-a8.md) the official path to one usable
supervised agent. [F1–F7](fractionate-follow-on-plan.md) retain the remaining scope
for after A8. [A1](fractionate-agents-a1-prompt.md) is the next section; it has not
been executed. A request to merge is not evidence that merge/checks succeeded.

## PR #674 host-inventory repair (2026-09-25)

The two direct-host candidates were reviewed and narrowly accepted in
`docs/core/security-host-interfaces.json`, with operation contracts and remaining
requirements in `docs/core/security-host-boundary.md`. Infisical guest networking
now validates inventory identity/network and every interpolated host/probe input,
bounds the Incus result, uses a fresh guest hosts temporary file, and restores the
registry on render failure. External Caddy state may still need reconciliation.
The evidence decoder keeps its one-process slot until child close after failure,
enforces its deadline, and rejects unexpected output fields. Direct-child SIGKILL
does not certify descendant teardown or OS isolation.

The false-default gates, approved media package versions, migrations, Operations
B1–B4, D1–D4, retirement and branding remain unchanged. The saved 127-test
foundation command, new regressions, inventory guard and frontend build were
rerun; exact results and hashes are in adjacent `merge-readiness-evidence/`.
Linux CI now has a dedicated step for both contracts. This source review does not
close S6, SEC-01–05 or INF-01–04 and does not approve feature activation,
wrapper provisioning, deployment or A1.

## Completed source included

- Batch 03 charcoal/mobile navigation polish, Operations/Dev Studio naming,
  profile/setup accessibility and preserved branding/PWA behavior.
- Lean BEAF active UI/API/AI/import/linking retirement. Migration 706 is prepared;
  deployment applies destructive retirement and requires verified backup first.
  No live database or upload cleanup was performed.
- Operations B1–B4: private current-account access, guide draft/review/versioning,
  independent approval, version-pinned manual work records and human UI.
- Demonstrations D1–D4: metadata/policy, private PNG/JPEG intake and retention,
  immutable exact evidence references in guide review, accessible author/editor/
  reviewer/viewer workflows, moderation, unavailable states and recovery.
- Additive migrations 1100–1105 and pinned pngjs 7.0.0 / jpeg-js 0.4.4 decoder
  dependencies. Package selection approval is not deployment-isolation approval.

## Verification

Fresh combined local run for this commit preparation: **127 passed, no failures
or skips**, including previous Operations, auth, review, retirement, branding,
PWA, Flightdeck, evidence metadata/storage/HTTP, initializer rollback, frozen guide
and D4 integration/client tests. Frontend production build passed; existing
large-chunk advisory remains. No runtime/source changes were made during roadmap
preparation; D4 final source hashes matched and foundation bytes were preserved.

Earlier D4 browser evidence covers author/editor/independent reviewer/viewer,
actual returned pixels, sharing/selection/review, manual pinned versions, stale
revisions, access loss and late responses, restriction/replacement, both themes
at 360/375/390/768/1280/1920 and 375px form completion. Mobile Lighthouse scored
100 on four tested Guide role states. This browser audit is prior D4 evidence,
not a newly performed roadmap-session audit or a spoken screen-reader audit.

Before this repair, the unchanged host inventory reported failures for:

- `admin/backend/src/lib/setup-engine/agent-network.js`
- `admin/backend/src/lib/operational-evidence-decoder.js`

This revision records only those two reviewed candidates; the guard still detects
new or changed sites. Required GitHub CI must be assessed on the submitted revision.
This document makes no release-ready claim.

The first PR CI run passed 304 of 305 backend regression tests; one stale MCP
assertion still required creating a retired Lean BEAF board card. The follow-up
changes that assertion to require absence of the retired integration, retaining
the parent-domain, slug, membership, preset and provisioning checks. It does not
restore retired behavior or weaken authorization. The inventory contract reviews
were separate merge gates at that historical revision; see the repair above.

## Evidence location and limits

Detailed fixtures, exact incremental patches, screenshots, hashes, commands and
reports remain in the operator's adjacent `Fractionate/` evidence directories:
`operations-completion-evidence`, `demonstrations-d1-evidence` through
`demonstrations-d4-evidence`, and `agents-roadmap-evidence`. They are local artifacts,
not dependencies available in a fresh clone. Product tests are committed under
`admin/backend/src/__tests__`; some full native HTTP/browser fixtures are retained
only in those handoff directories. Do not claim a fresh clone reproduces the full
127-test command without those fixtures and their isolated dependency setup.

D4 incremental patch SHA-256:
`08475364cee5155de164315a2bef953bb2779b6a37027d21da644d84e83c7c1a`.
That patch is relative to its saved pre-D4 working tree, not the Git parent of
the combined foundation commit. Existing evidence reports remain historical.

## Remaining authority and release gates

Both feature gates remain disabled by default. No agent runtime, provider call,
live feature activation, production scheduler, decoder wrapper or deployment was
performed. SEC-01–05 and INF-01–04 remain open, mapped to A1–A8 or non-pilot F7.
Verify target sandbox, ACLs, resource budgets, SSO, backup/restore and erasure
before activation. Older writers require `OPERATIONS_ENABLED=false`; retain
additive history, manifests, blobs, receipts and dispositions during rollback.

Current source integration is distinct from application rollout. The repository
also has an existing GitHub Pages workflow on pushes to main; a successful remote
merge can trigger that workflow even though no application deployment is requested.
