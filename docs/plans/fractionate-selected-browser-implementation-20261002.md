# Selected-browser implementation and release handoff — 2026-10-02

The saved cloud checkout implements a separate selected-browser agent path.
The legacy Guide `proxypilot-rules` parser remains synthetic-sign-in-only, and
the existing bounded public Website-review path remains separate. Neither a
draft import nor a rule edit unlocks non-demo browser execution.

Current release checkpoint (2026-10-03): canonical C0 and its explicit
refresh-after412 reconciliation are merged through PR727/PR728 at main
`c742d71ae3a319aa3b6f5817405cbea868c3fd1d`. PR728's frozen head
`68b4aca96d42268205be4a2117c6dd2637129ac5` passed both exact-head workflows
and independent parent re-review. Automatic approval review rejected this
worker's mark-ready request because forwarded authorization was classified as
untrusted; this worker stopped external mutations. The parent subsequently
completed ready/merge under the direct user authorization, and merged state was
verified through GitHub and the main ref. Live deployment remains PR725 at
`863ed48caa2ec9fff212b9e9a76ea0fc8e04d7c7`; no deployment or host change is
part of this work.

The broader source checkpoint `1d284afa54651ff5c9623416e352b5bdf2f0b068`
is preserved as an ancestor of local canonical reconciliation
`5b15de31e49a5fdd906c15e27bc112d05adad4d9`, then main ancestry reconciliation
`6ed11ca2`. Migration1117 and its draft
store/schema remain canonical; runtime migrations1118–1122 are additive.
Reconciliation keeps bounded schema issue messages and removes duplicate imports.
The combined native backend suite passes461/461. PR726's published head remains
`dc8080c44dca6c2db81842709b7b48a6edc3e743` until the shared editor integration,
independent review and new source proof are ready for publication.

The frontend integration reuses canonical `BrowserConfigurations` as the
sole list/editor under Agents, with explicit selected-record/dirty-state hooks
into separate readiness, consent, Start and run controls. Local integration
proof is complete; it does not silently save, start or authorize disclosure. Actual
local Chromium/TLS proof and the package recovery contract remain source proof,
not installed acceptance.

## Dependency order and resulting behavior

| Stage | Implemented contract | Prerequisite |
| --- | --- | --- |
| C0 configuration | Strict static schemas, paste/edit/validate/save, immutable configuration versions and original/source provenance; exact origins and roles, finite budgets, separate consent and effects. | Current project edit access and guide; saving grants no execution. |
| E1 destination boundary | Same fenced HTTP/HTTPS proxy port, root-only typed control, protected inventory, exact DNS/address/route/TLS pins, request body/context hashes and single-use effect grants. Off-list requests pause before target DNS/contact. Temporary exact role/purpose grants leave the base allowlist unchanged. | Separately reviewed installed gateway and exact public/internal target policy. |
| R1 browser worker | Twelve typed primitives: navigate/read/click/scroll/type/wait/download/copy/paste/screenshot/upload/submit. Opaque current snapshots/candidates, private staged bytes, real paused-request approvals, bounded navigation waits, frames/popups and cancellation without replay. | E1 plus reviewed guest/Chromium policy and isolated attempt workspace. |
| F1 private artifacts | Dedicated pinned private root, finite quotas/leases, exact hash/MIME/size/scope reviews, approved uploads/input drafts, clipboard exchange, source memory, screenshot derivatives, bounded image/PDF wrappers, durable cleanup. | Current account/project/attempt authority, explicit disclosure reviews and separately reviewed storage/parser boundaries. |
| D1 model/conversion | Existing A3/A4 custody bridge with signed model request/result/usage correlation and durable reservations. Plain-language/files/images produce an editable proposal retaining originals; no automatic save/start. Runtime output selects only current candidates or bounded form drafts. | Current approved guide, explicit owner/provider consent, approved private sources and finite cost ceilings. |
| O1 lifecycle | Explicit Start, durable exact approvals, action and wire-effect gates, budgets, cancellation/recovery fences, signed launch/cleanup pins, real timer-driven automatic loop, pause/resume, current-session live/takeover and source-backed reports. | All earlier stages; every readiness proof is current and server authoritative. |
| U1 interface | Draft editor, readiness/consent, Start, exact approval review, private content review, source citations, controls, live view/takeover and fullscreen. Metadata is below the browser; bounded panes preserve phone access. | Repository backend/host capabilities; unavailable readiness is shown explicitly. |
| V1 acceptance | Retained local checkpoints and actual local host/Chromium/TLS composition, including startup suppression, form preparation, uncertain submission and signed denial. Installed target/provider proofs remain separate. | An authorized representative installation and selected public/authenticated/internal tasks. |

Model-selected input text receives exact human content review, then a separate
consequential action approval, and any resulting HTTP write receives its exact
payload approval. Private pins are rechecked before execution and immediately
before a held request can be released. During manual authentication, verification
of already retained pins is read-only; model capture and automatic input
activation stay disabled. The sole controller is bound to the exact live session;
disconnect fences and cleans up control. Release leaves a durable pause.

Authentication readback is an explicit, individually selected human assertion
for completed requests bound to consumed sign-in/MFA approvals, exact payload
and URL hashes, the current sole controller/session, and signed send/response
ledger evidence. It never infers authentication from HTTP200 or Release.
Unconfirmed or ordinary business effects keep manual control/capture suppression
and prevent model/report continuation. Confirmation, Release and Resume are
separate actions. The new source remains default gated pending integration and
independent review.

`max_actions` counts automated and typed declared browser primitives. Native
takeover keyboard/mouse/scroll events are separately measured in the signed
receipt; time, network, resource and effect rules continue during takeover.
HTTP success or DOM completion does not establish a business write succeeded.
An unverified sent effect requires human reconciliation and cannot be replayed.

Cleanup revokes authority before taking its mandatory signed final network facts.
A late write, outstanding request or unconfirmed effect withholds completion and
reporting even if the earlier idle check passed. Authentic partial cleanup
receipts retain known meters and physical cleanup failures. A fresh cleanup
retry can reconcile physical closure; it cannot certify a business effect or
replay it. Explicit submit intent requires readback even when a page suppresses
its HTTP request. Local field preparation can continue when the actual ledger is
idle, with a local-operation fact that makes no website success claim.

Reports cite only private source artifacts actually disclosed to the model.
Sources preserve content, origin/URL/snapshot, configuration/guide/consent,
capture/chunker and call provenance. Current access is checked before and after
provider/parser waits and every disclosure; deletion, expiry or withdrawal
withholds derived summary text. See [actual Nodus source alignment](fractionate-browser-nodus-alignment-20261002.md).

## Local proof checkpoint

All commands ran in this saved cloud environment. No Duo executor, production
SSH/MCP operation, real external task, broad credential activation or deployment
was used. No runtime application dependencies or lockfiles changed.

- Operations/agent backend integration:333/333 tests passed.
- Full Python suite:412 cases,379 passed and33 environment/legacy skips. New
  selected-browser suites:90/90 passed, including24 worker cases with actual
  local Chromium,31 gateway cases with real local HTTP/TLS and16 host cases.
- Strict proposal fixtures:10/10 passed. Runtime composition:28/28 passed,
  including automatic action/report completion, signed receipts, mandatory and
  cumulative metering, gate/session/storage revocation and both approval-stage
  upload expiry.
- Production frontend build passed; existing bundle-size warnings remain.
  Browser-agent UI unit tests:10/10. Five-width fixture checks report no overflow,
  no accessibility violations, exact reviews, no implicit start or mutation replay.
- Host-boundary inventory:99 reviewed candidate backend files. S6 remains open.
- Additional authentication/security checks:60 passed initially; after installing the
  missing locked CLI dependencies, all28 root-recovery cases passed. Five bootstrap
  integration cases require actual UID0/root-owned temporary directories. This
  cloud runs as UID1000 and has no sudo, so their local run remains unavailable;
  the existing disposable CI runner executes them as root. Production checks are
  unchanged.

Counts are the retained integration checkpoint, not installed acceptance. Fixture
provider outputs and Neko transport stand-ins do not prove a real provider,
external browser session or controller-only credential privacy.

## Preserved source checkpoint 1d284afa — 2026-10-03

Native locked dependencies passed 434 Operations/agent backend tests and 26
broker backend tests, with no skips. Frontend units passed 13/13 and the
production build passed with 2002 modules. Eight explicit authentication UI
scenarios passed at five actual viewport sizes, with zero accessibility
violations or horizontal overflow. That standalone fixture scrolls vertically;
it does not replace PR725's production fixed-viewport proof.

The source-frozen aggregate Python suite passed 466 cases: 433 passes and the
same 33 environment/legacy skips, in 171.524 seconds. Actual Chromium/host/TLS
composition passed 8/8, with zero skips, in 29.366 seconds. Earlier 465-case and
seven-case checkpoints are retained. A subsequent process check found six old experimental browser groups; the
test wrapper had put Chromium outside the fake guest's process group. The
fixture now records exact browser PID/start/session ownership, cleans that
owned group even after forced guest death, asserts no live descendants remain,
and proves an unrelated process survives. The focused forced-stop test passed;
the source-frozen final aggregate and eight-case composition outputs are retained
in [final verification](evidence/selected-browser-20261002/verification-final.json).
Product guest/worker/gateway/host hashes stayed unchanged by this test correction.
Unclosed fixture file/socket ResourceWarnings remain visible in both aggregate
logs; warning filtering and enforcement were not changed.

The 24 package tests and 22 legacy refresh tests pass; the ordinary refresh
allowlist and historical guest exception remain unchanged. The source-only
proxy plan binds the final gateway hash and records `installed:false` and
`acceptance_created:false`. All artifacts and candidate source hashes are pinned
in the evidence manifest. PR726's published `dc8080c` Security workflow passed,
but broker CI failed on an unexplained first Chromium startup timeout. Bounded
diagnostics were added without retries, skips or a timeout increase. Fresh
candidate CI and independent exact-head review remain pending publication.

## Canonical editor integration checkpoint — 2026-10-03

The preserved runtime source and merged C0/PR728 now share one editor, list and
Save path under Agents. An optional runtime composition consumes the selected
saved record and draft dirty/conflict state. Capability metadata can reveal
runtime controls; it cannot establish installed readiness or enable Start.
Consent and Start bind the immutable saved revision, configuration/guide hashes
and current project revision. A fresh server readiness check precedes Start.
Draft changes and412 conflicts block consent, readiness and Start. Refresh keeps
the conflict; explicit reconciliation remains the canonical C0 path.

Provider/action waits lock the editor and selection controls. Conversion results
bind the saved selection and monotonic draft generation, so a queued result
cannot overwrite a newer draft or clear its conflict. Shared authority loss
aborts and fences every canonical read/write, latches denial and clears private
state immediately. Conversion-only polling uses that same denial path. Browser
regressions reproduce a delayed list response after runtime403 and a conversion
denial without a selected run. LEARNINGS258 records the failure and ratchets.

The native combined backend suite passes461/461 with no skips; backend source
is unchanged from reconciliation5b15de31. Final frontend proof passes13/13 units,
six real HTTP/SQLite C0 journeys, seven shared-editor checks, eight retained
authentication scenarios and three actual Agents-page checks. Existing A6
passes20journeys/96layout checks and A7 passes6journeys/42layout checks. The new
Agents test also passes in CI mode using locked backend axe-core, without
temporary tools. C0 and the actual Agents page use internal scrolling at all
five actual viewports, with zero document overflow and axe violations. The
separate authentication fixture allows vertical scrolling and has zero
horizontal overflow. Actual Agents mobile Lighthouse accessibility is96/100.
The final production build passes with2004modules; existing bundle warnings
remain. Security CI now includes the runtime units and actual Agents test.

All25 retained script hashes are unchanged from checkpoint1d284afa, preserving
its466-case Python and8/8 actual Chromium/host/TLS evidence. The earlier
verification files remain historical checkpoints. Current source/artifact
hashes, logs, responsive screenshots and the pre-fix denial reproduction are
recorded in [canonical integration proof](evidence/selected-browser-20261002/canonical-integration/verification.json).
No installed proof, new-candidate publication, CI, deployment or acceptance marker
is implied by these local results. The separate package/ordinary-update gate
below remains unresolved.

## Release and activation boundaries

The [separate package contract](fractionate-selected-runtime-package-contract.md)
now defines source-side installation, future update, recovery, rollback and
commit for a coordinated 25-file package. Its 24 temporary filesystem/key/journal
tests include all 25 owned replacement failures, interruption/recovery, immutable
protected state and durable parent directory links before service effects. An
independent source review found no remaining package blocker. Actual installed
host proof is still required. It preserves runtime history, receipt identity and
existing policies, and never creates or refreshes an acceptance marker. The
ordinary updater remains unchanged.

PR725 merged after independent review and both exact-head workflows passed.
Main now includes PR727/PR728 at `c742d71ae3a319aa3b6f5817405cbea868c3fd1d`;
live deployment is separately verified at PR725 `863ed48c`. The existing
Settings → Update now flow can take reviewed main changes; no update was run here.
C0 adds inert drafts and does not activate selected websites. The broader
implementation remains draft PR726 and is being reconciled onto canonical C0. Its first CI pass
exposed test portability assumptions: a hardcoded checkout path and undeclared
PDF fixture utilities. The follow-up derives the path and installs/verifies the
real bounded extraction tools on disposable CI; production source is unchanged.

The broader selected-browser implementation must not be merged as an ordinary
installed-host refresh without resolving its packaging contract. The current
`review-runtime-refresh.py` explicitly preserves the legacy guest, adjacent
package files, receipt key, journals, wiring and timer. It refuses the new guest
or seven-helper owned file set before backups, service operations or target
writes. A hash-verified PR724 test-only package preserves the positive historical
refresh/rollback proof; new tests enforce the separate-review refusal. Production
allowlists and the exact historical guest exception remain unchanged.

`python3 scripts/a3-install-proxy.py plan-selected` emits a reviewable source-only
plan with exact files/unit hashes and root-owned paths. It performs no installation
and creates no acceptance marker. Selected runtime remains unavailable until:

1. The expanded supervisor/guest/gateway package and future refresh/rollback
   behavior receive a separately reviewed installation contract.
2. A representative installed target proves actual Incus identity, effective nft
   fence, cgroup/resource limits, Chromium policy, gateway before-contact blocking,
   restart/recovery/cleanup, Neko spectator closure/controller privacy and private
   chooser workspace behavior.
3. A service-owned dedicated0700 root, finite quota and each fixed decoder wrapper
   receive installed filesystem/network/resource/teardown review. Environment
   defaults stay unavailable; capability strings alone are insufficient.
4. Real provider text/multimodal and selected public/authenticated/internal tasks
   demonstrate current consent, approval, budget, cancellation, receipt and report
   behavior. Manual auth remains attempt-private; CB-01/CB-04 and deferred A8 work
   are not silently activated.

This cloud has Chromium/Node/Python but lacks Incus/nft and the representative
installed Neko/provider boundaries. Production changes and that target acceptance
have not been authorized. Source and local tests are ready for review; activation
remains blocked on those concrete prerequisites. S6/SEC-01/backend-root findings
remain open independently of this slice.
