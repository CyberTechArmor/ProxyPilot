# Startup and destination continuation source checkpoint

The published2ed34018 candidate failed its paired Python suites in broker run
37119080600 and Security run37119080634:466 tests,6 failures,1 error,33 existing
skips in each. Its frontend, dashboard and filesystem checks passed. Retained
error excerpts show native startup CONNECT traffic to www.google.com and
update.googleapis.com; the destination gateway denied before upstream contact.
These are historical failures, not fresh follow-up CI results.

The selected browser argv now disables native search preconnect and supplies a
fixed non-network component-updater endpoint. Actual native component traffic is
first forced in a disposable fixture: it is denied with zero upstream requests
or effects. The matching suppression control retains the product endpoint,
proves ordinary selected-page traffic still needs exact tickets and denies an
off-list navigation. The cloud's mandatory SearchSuggestEnabled:false prevents a
local positive search-preconnect control; Chromium154 primary source and fresh
CI remain necessary. The component-updater switch is explicitly debug behavior,
so this is version-bound suppression, not a stable enterprise-policy contract.
The unchanged gateway must fail closed if a future browser ignores it.

The original continuation defect is reproduced through actual Node lifecycle,
real Ed25519 host receipts, Chromium and local TLS. An approved destination never
activated while the completed original action stayed reserved. The host now
settles a finished blocked action only with idle wire counters and unchanged
effect totals, retaining the exact destination review. The service can consume
one temporary grant, preserve its base policy and known spend, and use a fresh
snapshot/candidate/ordinal for a successful local read. A later navigation still
needs its own exact wire approval and remains uncertain without business
readback. No direct-host grant or synthesized blocked poll substitutes for this
cross-language test; only the model provider and installed OS boundary are
fixtures.

The first combined run caught a further regression: after settling an uncertain
action, a later grant skipped the old started-slot check. That failure is
retained. Terminal polls now keep their original outcome, and destination grants
refuse uncertain actions, transport uncertainty or unreconciled automated effects
before target resolution. A manual sign-in continuation requires the exact live
controller, session and current worker connection; capture stays disabled and
separate authentication readback remains required.

verification.json binds the tested source bytes; manifest.json binds retained
artifacts. log-provenance.json preserves raw input hashes and records trailing
whitespace normalization. Logs contain only disposable synthetic fixture data.
Local proofs establish no installed Incus/nft/Neko/private-decoder/provider or
first selected-site acceptance. The separate installation/rollback proposal is
local commit e6cc08175a72f455c8899d747e568c3ce3746682 and includes no activation.

The frozen source passed the full paired Python selection:474 tests,441 passed,
33 unchanged pre-existing dependency skips,173.846seconds,exit0. The broader
native backend selection passed462/462,zero skips,12.060seconds. The actual
Chromium10-case composition and backend171-case focused proof are included in
these broader selections; do not add overlapping counts as unique tests. Fresh
exact-head CI remains the next independent environment check.
