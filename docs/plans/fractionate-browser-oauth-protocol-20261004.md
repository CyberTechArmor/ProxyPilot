# Browser OAuth protocol groundwork — 2026-10-04

No provider/account/client/resource has been selected by the user. No custody
trust choice is inferred. `operational-browser-oauth-lifecycle.js` supplies the
generic protocol API behind a future provider-specific adapter; it has no
production HTTP route, registered provider, token transport or connection
activation. The reachable metadata API continues to report OAuth authorization
and credential enrollment unavailable.

The API is `createBrowserOAuthLifecycle({resolveProvider,authorize,
exchangeToCustody,now,maxPending,maxPerSession,ttlMs})`. Default configuration
has no provider or custody adapter and cannot generate an authorization.
`configured(providerId)` means protocol configuration exists, never a successful
provider connection or operational readiness observation.

The trusted server registry supplies exact provider ID/revision, issuer,
authorization/token endpoints, client ID, redirect URI, allowed scopes and
whether callback issuer is required. Client input cannot select endpoints,
redirect URIs, keys or client secrets. The contributor principal binds exact
contributor/session/connection/metadata-version identity. A current-authority
callback enforces current eligibility/project/credential permission/session
before beginning, before exchange and after every awaited authority/provider
operation; provider revision drift fences an old callback.

`begin` creates random256-bit state and a random PKCE verifier, exact requested
scope subset, S256 challenge, an at-most5-minute intent and fixed authorization
URL. The verifier remains a transient server-memory reference and is passed
only to the trusted custody adapter. No cryptographic memory-erasure guarantee
is claimed for JavaScript strings. Concurrency is bounded by64 total retained
intents and4 active intents per session by default.

`callback` validates one-use state, exact principal/version, required issuer and
current provider pins. It claims the intent before asynchronous token exchange;
simultaneous callbacks dispatch at most one exchange. Explicit consent denial
consumes state without token exchange. The trusted adapter receives the intent
ID, exact provider/principal/scopes, code/verifier and `assertCurrent` hook. It
must reserve durable custody/reconciliation identity before external bytes,
perform genuine pinned TLS/egress token exchange, fetch/verify actual provider
account and scopes, store secrets directly in the chosen custody service, and
return only a metadata subject/scopes/enrollment-receipt ID. A caller-supplied
account or synthesized receipt is not provider acceptance.

Returned scopes cannot exceed requested scopes, raw/extra token fields are
rejected, and even a valid receipt yields `review_required` with
`execution_available:false`. Separate exact human review must bind the actual
account/scopes/resources to the immutable connection version. The generic module
cannot mint a broker/worker session or approve a browser effect.

Exchange/custody failure, authority loss, cancellation during exchange, close,
expiry or a late invalid result requires reconciliation without replay. Cancel
and close cannot be overwritten by a late account result. Restart drops all
in-memory authority, so old callbacks cannot resume. Close is terminal and also
fences an awaited `begin`; another factory instance is needed after restart.
Durable external exchange
receipts, refresh serialization, provider revocation, token cleanup, restore
quarantine and isolated custody placement are the selected adapter/service's
remaining implementation requirements; this module does not claim them.

Before exposing routes, select the real provider and exact client/redirect/
account/resource scopes, confirm the custody threat boundary, and implement
current session+Origin/CSRF initiation, strict callback query parsing (including
duplicate fields), secret-free request logging, custody-receipt persistence and
actual exchange/revoke/refresh/error verification. Do not register clients or
request account permissions merely to make the generic code selectable.

The protocol tests use explicitly injected trusted adapter fixtures; they are
source/lifecycle proof and never real-provider evidence.
