# Selected-browser implementation and release handoff — 2026-10-02

The saved cloud checkout implements a separate selected-browser agent path.
The legacy Guide `proxypilot-rules` parser remains synthetic-sign-in-only, and
the existing bounded public Website-review path remains separate. Neither a
draft import nor a rule edit unlocks non-demo browser execution.

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
| V1 acceptance | Local integrated cloud proofs are complete; installed target/provider proofs are separate. | An authorized representative installation and selected public/authenticated/internal tasks. |

Model-selected input text receives exact human content review, then a separate
consequential action approval, and any resulting HTTP write receives its exact
payload approval. Private pins are rechecked before execution and immediately
before a held request can be released. During manual authentication, verification
of already retained pins is read-only; model capture and automatic input
activation stay disabled. The sole controller is bound to the exact live session;
disconnect fences and cleans up control. Release leaves a durable pause.

`max_actions` counts automated and typed declared browser primitives. Native
takeover keyboard/mouse/scroll events are separately measured in the signed
receipt; time, network, resource and effect rules continue during takeover.
HTTP success or DOM completion does not establish a business write succeeded.
An unverified sent effect requires human reconciliation and cannot be replayed.

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

## Release and activation boundaries

PR725 merged after independent review and both exact-head workflows passed.
Remote main is `863ed48caa2ec9fff212b9e9a76ea0fc8e04d7c7`. Thomas can use
the existing Settings → Update now flow and reload Operations. That update changes
viewport/fullscreen behavior; it does not activate selected websites. The broader
implementation is draft PR726, based on that main commit. Its first CI pass
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
