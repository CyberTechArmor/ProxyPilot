# Browser source discard, retention and provenance — 2026-10-04

Problem: reviewed private browser sources could not be discarded through the
browser API, and receipts did not distinguish pending cleanup from committed
local deletion. Source reuse after asynchronous decoding also needed an exact,
synchronous physical-original check at the service boundary.

Changes: current project-edit/human/CSRF source discard route; immediate read/use
revocation with normal deferred physical cleanup; additive provenance, intake,
retention and deletion receipt fields; synchronous private source verification
without parser/model/content output. Original hashes/reviews survive as immutable
history. No migration, legacy-demo change, runtime helper change or live mutation.

Validation: `node --test src/__tests__/operational-browser-artifacts.test.js
src/__tests__/operational-browser-routes.test.js` from `admin/backend` passes
44/44. New cases cover cross-project/viewer/outsider/CSRF/body/query refusal,
metadata-only availability, immediate source/lease invalidation, physical cleanup
versus quota and durable tombstones, intake interruption/expiry, immutable source
provenance and physical corruption/current disclosure verification.
The six related artifacts/routes/conversion/selected-runtime/selected-service/
guide-save suites additionally pass 203/203, with no skipped cases.

Source audit and actual storage/decoder prerequisites, F8/F9 data/interface map,
remaining capture/knowledge/practice/concurrency vision and precise optional
storage/index/custody decisions are in
`docs/plans/fractionate-browser-knowledge-delivery-20261004.md`.

Independent exact-tree review, CI, merge, deployment and installed disposable
source acceptance remain pending. Tests do not establish production private
storage, decoder wrappers, real provider interpretation or S3/search parity.
