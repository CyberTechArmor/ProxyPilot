# Public navigation transport evidence — 2026-10-04

Public Stop receipts may now include signed `public_navigation_evidence` with
completed HTTP redirect count, completed resource count outside the starting
origin, last completed successful document origin and the SHA256 of its URL.
No raw path, query, page text or private record is returned. A document can be
an iframe: this does not claim the top-frame final URL. HSTS navigation does not
increment an HTTP redirect counter. A redirect requires an actual completed
300/301/302/303/307/308 response with Location. Refused/failed/inflight requests
never count as completed evidence.

The gateway collects this only for public navigation. The supervisor validates
its bounded shape and copies it to the signed teardown alongside the current
gateway ledger digest. Existing `final_network` remains unchanged. The backend
accepts only finite safe integer counts no greater than final requests,
canonical HTTP(S) origins, paired nullable origin/hash fields and exact keys.
Agent receipts cannot carry this public evidence. Historical receipts omit it;
no migration, acceptance rewrite or inference upgrades their proof.

Validation: 21 public gateway/protection checks, 44 selected supervisor lifecycle
checks, 92 backend selected-service tests and 142 signed-runtime integration
tests pass. Actual Chromium133 fixture proves one HTTP redirect, a resource at
the second origin, successful document hash, real PNG pixels and signed physical
cleanup. The public fixture now serves its asset from the second origin to test
the metric explicitly. Local tests still inject Incus/nft/Neko/TURN boundaries;
prior cloud Unix socket and Chromium process-inventory failures remain recorded
in the preceding runtime slices.

Independent exact-tree review, CI, merge/application delivery, dedicated fixed
runtime Install and real public-site transport evidence remain pending. The
current successful earlier Install cannot produce this new optional field.
