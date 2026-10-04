# Browser model conversion: current source access and signed prices

Scope: selected/general-site browser backend only. Base application commit
`d2331e251fc1a58443adfd979112192810b0d283`; source verification depends on the
knowledge slice `c24154940d0449b9284fc254e9b7c183b14610cb` (locally cherry-picked
as `987c032a`). Historical demo, stored sources, configuration snapshots and
completed conversion rows remain unchanged.

Completed conversion reads now recheck current project/guide authority, current
source review, physical source integrity and exact disclosed-content hashes.
Deletion, revoked model-input review, changed bytes, guide withdrawal, ownership
change or archive withholds the generated configuration and derived prose. The
original user instructions and immutable historical conversion row remain; no
provider call is repeated. Status and cancellation projections are async and
the existing route handlers already await both.

Every requested source is verified synchronously after the final decoder await,
including the earlier sources whose reviews might change while a later document
is decoding. The runtime injects the knowledge service's exact metadata-only
verification method. Text-only conversion needs no artifact adapter.

Model readiness validates the actual host status contract: a bounded datetime,
positive price-table revision and all four bounded decimal-string prices.
Malformed signed expiry cannot create an indefinitely cached quote. Failed
readiness invalidates previous cached prices. The runtime composition fixture
now uses the production Python helper's decimal-string price representation.

Validation on 2026-10-04 at 09:27Z:

`node --test admin/backend/src/__tests__/operational-browser-conversion.test.js admin/backend/src/__tests__/operational-browser-model.test.js admin/backend/src/__tests__/operational-browser-routes.test.js admin/backend/src/__tests__/operational-selected-browser-runtime.test.js`

175 tests passed. The initial broader test exposed the old numeric/incomplete
price fixture as MODEL_ROUTE_UNAVAILABLE; that failure is retained here. The
fixture was corrected to the actual host contract before the passing run.
New regressions cover post-completion revocation/deletion, guide withdrawal,
archive, immutable historical rows, cancellation projection bypass, membership
loss during decoder await, earlier-source review loss during later-source
decoding, malformed signed price status and stale quote invalidation.

These are repository tests, including signed and scripted provider fixtures.
They do not establish real provider execution, installed private storage,
selected task acceptance or production delivery. Public navigation remains
independent of model/conversion capabilities.

| Item | Status | Evidence / deployment | What I should see or be able to do |
| --- | --- | --- | --- |
| Conversion current-source projection | In progress | Local regression tests; independent review/CI/release pending | Re-reading a completed conversion after source loss returns CONVERSION_SOURCE_UNAVAILABLE and no generated settings. |
| Signed model price readiness | In progress | Local signed-contract tests; release pending | Invalid/expired model readiness cannot offer a cached quote. |
| Real provider conversion and bounded website task | Not started | No production/provider operations by this agent | Reviewed original objective becomes editable settings, then a real finite task produces source-linked results. |

Release coordinator acceptance path: inspect current signed model readiness and
configured A4 provider/price-table health; inspect actual private storage;
use a genuine currently approved guide and current owner disclosure; request a
bounded text-only conversion with its displayed token/USD ceilings; inspect
original instructions, editable settings and actual signed usage; validate/save
explicit destination read rules and start a separate bounded selected task.
Then verify actual decisions/report citations, cancellation and signed cleanup.
No guide, consent, configuration identity or acceptance marker may be fabricated.
Conversion-created empty request rules do not automatically classify website
GET/resources as read; review the intended method/path/resource/query rules or
use exact request approvals. Preserve manual sign-in and consequential writes
as their separately approved capabilities.

Independent exact-tree review of `854b3580` found P1: source revocation during
the async readiness/quote calls could still disclose previously parsed content
to the provider. A deterministic reviewer reproduction confirmed one provider
call after that revocation. The correction rechecks every original byte/review
pin synchronously immediately before dispatch, with no intervening await.
Held-readiness and held-quote regressions now prove zero provider calls after
review loss and preserve a blocked record with `model_spend:not_requested`.
The combined command above then passed 176/176 tests on the corrected tree;
independent re-review remains required before release.
