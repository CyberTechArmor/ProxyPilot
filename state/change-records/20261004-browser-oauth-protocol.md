# Generic browser OAuth lifecycle mechanics — 2026-10-04

Implement a generic bounded one-shot PKCE/state/current-principal/provider-pin
protocol factory without selecting a provider, custody boundary or registering
a client. The module has no production endpoint, token transport, account grant
or activation path. It provides a concrete interface for the next genuine
provider adapter rather than inventing provider support in the existing broker.

Tests cover exact authorization pins/PKCE, controller/session/version/state/
issuer mismatch, scope/configuration boundaries, denial, concurrent callbacks,
uncertain exchange/no replay, cancellation and close during awaited exchange,
authority loss, restart/expiry and finite limits. Injected exchange fixtures are
explicitly source proof; no real provider/custody success is claimed.

Focused protocol and metadata/HTTP/Operations regressions:47/47 passed,0
failed/skipped. Protocol coverage includes distinct provider authorization
failure versus human consent denial. Independent exact-tree review and CI/
release evidence are maintained by the release coordinator.

Independent review found a close/begin race: an awaited authority check could
finish after close and mint a new authorization URL, and the same factory could
begin again. A terminal closed guard now fences begin before/after the await,
callback/cancel/current checks and configuration display. A held-authority
regression proves no URL or exchange after close; direct post-close operations
also refuse. The historical finding is retained and requires exact re-review.

Client secrets, authorization codes, verifier and tokens are not returned in
metadata results. Errors are static redacted codes. Reference dropping in
JavaScript is not guaranteed secure memory erasure. Account acceptance remains
human-review-required and execution unavailable, even after a trusted adapter
receipt. Production exchange durability/revoke/refresh/custody and strict route
logging/query handling must be implemented and verified for the selected
provider before activation; see the exact interface/limits in
`docs/plans/fractionate-browser-oauth-protocol-20261004.md`.

No provider selection, host/runtime modification, secret enrollment, permission
mutation, live verification, push/merge or deployment was performed here.
