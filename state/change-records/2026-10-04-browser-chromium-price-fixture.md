# Actual Chromium price fixture matches the host contract

The signed cross-language test fixture still emitted numeric `input`, `output`
and `cache_write` prices and omitted `cached_input`. The installed Python model
helper's actual contract emits all four prices as bounded decimal strings.
The stronger backend readiness validation correctly rejected that stale fixture
before browser launch, producing `MODEL_ROUTE_UNAVAILABLE` in both Chromium
journeys. This failure was reproduced on source `223a90f4` before the edit.

Only the fixture price representation changes. Production price validation,
signature checks, budgets, approval assertions, lifecycle checks and all waits
remain unchanged. No F8 code or production operation is included.

Validation: `node --test admin/backend/src/__tests__/operational-selected-browser-chromium.test.js`
passes both actual Chromium journeys, including the 22-second guest setup case,
with zero skips in 25.86 seconds. Local `/usr/bin/chromium` points to
`/tmp/chromium`, which reports Chromium 133.0.6943.0. CI uses its installed browser
and remains a separate requirement. Existing fixture final uncertainty is
retained; this is local composition, not installed runtime/provider acceptance.

`node --test admin/backend/src/__tests__/operational-browser-model.test.js admin/backend/src/__tests__/operational-browser-conversion.test.js`
passes 21 tests, including malformed signed price status and held readiness/quote
source-revocation barriers. Exact independent review and CI remain required.
