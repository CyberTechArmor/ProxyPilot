# Browser authentication and connections delivery — 2026-10-04

The current user request authorizes implementation, review, CI and deployment of
ProxyPilot browser capabilities. Historical whole-feature acceptance,
independent-terminal and uninvoked-install restrictions are superseded. The
release coordinator owns production actions. This document does not assert live
authentication, credential custody, OAuth or internal reachability acceptance.

## Working contracts to use

The selected/general-site agent has manual takeover, one exact controller
user/session/live connection, model/capture suppression during sign-in, held HTTP
write review, authentication readback and durable uncertain-effect handling.
Authentication confirmation is an assertion about individually selected completed
sign-in/MFA requests. It does not grant business-action approval or automatically
release control. Give back leaves a pause; Resume is separate. Disconnect, grant
loss and attempt/fence changes terminate authority without replay.

The public-navigation capability remains independently usable. It has no model,
guide or private-storage prerequisite. Its current implementation deliberately
does not grant private takeover or effects; those are the separate agent mode's
capabilities. Making a public run authenticated requires a versioned change in
run purpose/permissions, gateway policy and private-controller prerequisites,
with explicit human review. Changing a UI label alone would not do that.

Current reusable connections use only `synthetic-ledger-v1`; their enrollment,
grants, revocation and reconciliation are useful foundations, not general browser
credentials or a provider OAuth connection. A4 demo binding paths and its
synthetic-sign-in launcher stay intact. Upstream OAuth and the broker's human
Keycloak OIDC login have separate token owners and purposes.

## First authentication acceptance

Use an authorized disposable external account and exact approved login/MFA
origins. Start a finite agent run with current consent/guide/configuration and
measured private/live capabilities. Open the live browser, enter takeover,
privately sign in and review each held authentication request's destination,
method, body byte count and exact URL/body/binding digests. Confirm only the
completed authentication requests independently observed by that controller.
Give back, verify the durable pause, then explicitly Resume a read-only task.

Prove another session cannot see/control the private authentication viewer,
model/page capture remains suppressed before Give back, a changed payload cannot
reuse approval, a business write cannot be cleared as authentication, a lost
transport receipt remains uncertain and Stop physically removes the session.
Verify the actual downstream account/task result independently; HTTP 200 alone
does not establish sign-in or business success. Real-provider acceptance and
native video/takeover transport acceptance remain distinct prerequisites.

The auth endpoint preview is validated against the gateway's existing fixed
benign-word/redaction format before readback or durable confirmation. Raw path
IDs, usernames, query/fragment, percent escapes and controls are refused even in
a validly signed inventory. This is protection against accidental helper
regressions, not protection from malicious host root that controls code/keys.

## Concrete reusable credential implementation

1. Add an additive general-browser connection namespace. Store opaque connection
   ID, Operations project ID, contributor ID, type, exact approved origin/account
   hint, credential version, policy revision, private status and opaque broker
   handle. Store no secret, token, cookie, plaintext hash or caller-chosen vault
   path. Initial rights belong only to the contributor; project membership does
   not imply a credential grant. Sharing names an exact recipient, permission,
   expiry and scope. Preserve old demo/API namespaces and records.
2. Direct human enrollment goes to the chosen custody service, using current
   verified human identity, CSRF, exact Origin and fresh proof. Reserve the opaque
   slot/idempotency identity before any OpenBao KV v2 CAS write, verify readback
   of the committed version and record metadata-only destination receipts.
   Partial writes remain reconcilable; retries cannot allocate an unrelated slot
   or claim completion from the presence of settings.
3. Website password/session use is a new typed worker capability. It binds exact
   run/attempt/fence/controller, contributor grant, connection/policy/credential
   revisions, destination and permitted authentication request. Deliver bytes
   over the protected one-use guest input channel. Values cannot enter guide,
   prompt, screenshot/artifact, event or dashboard metadata. Session cookies stay
   attempt-private and are destroyed at cleanup unless the owner separately
   chooses durable session storage with its own lifecycle contract.
4. Recheck current user eligibility, project/credential grants, lease, versions,
   destination and resource limits immediately before disclosure/send. Rotation
   invalidates pinned versions; revocation prevents future use and cancels live
   leases. It does not erase knowledge from recipients or undo requests already
   sent. Preserve uncertain effects and prohibit automatic replay.
5. Per-destination replication stays explicit. Infisical needs exact scoped
   identity/site policy and version receipts. Vaultwarden personal import needs
   contributor-side confirmation; no server collection of the master password
   or unlocked client key. An organization destination names exact collection
   and ownership change. Unsupported destinations remain visibly pending.

Source tests can build all metadata and typed transport mechanics before
activation. Operational custody and adapter readiness must derive from real
service observations and current grants, never a configuration checkbox.

## Provider-specific OAuth slice

A first provider should be selected by a real intended task. GitHub read-only on
one disposable repository is a concrete candidate; it is not selected or active
merely because the project repository exists. Google/Microsoft/calendar/mail
permissions must have separate provider-specific reviews and scopes.

For the selected provider, register a dedicated connection client with exact
redirect URI. Pin authorization/token/revocation/userinfo endpoints and approved
scope list in an owned adapter. Use unpredictable one-use state, PKCE S256 and
current contributor-session binding; verify issuer where supported and fetch the
actual provider account identity. Show exact account, granted resources/scopes
and contributor before committing the connection. Abort/callback failure cannot
silently enroll a partial connection or bind by email alone.

Authorization code and refresh/access tokens go directly to chosen custody;
dashboard URLs/logs/history/prompts contain no values. Bound refresh by connection
version, serialize rotation, reconcile interrupted exchanges and revoke all
local leases before calling provider revocation. Provider revocation failure is
retained explicitly. Re-consent/rotation changes account/scopes only through a
new reviewed version. Browser-session authentication does not itself confer API
OAuth permission, and an API OAuth token is not a browser cookie.

## Exact internal destinations

The selected gateway already has a strict `internal` target-plan shape: exact
origin, address set, port, current route digest and reviewed identity. The public
resolver correctly refuses private/mixed/metadata/protected answers. Do not
weaken it or add blanket RFC1918 access.

For the requested internal site, prepare a reviewed host-owned plan covering
only its hostname/origin, private IPs/port and isolated VM route. Bind owner,
project, policy revision, purpose and expiry at the authority source. Keep the
protected host/address inventory and metadata/control-plane/vault exclusions
authoritative and stronger than the plan. Screen all DNS answers, route changes
and the actual connected peer before request bytes. TLS/hostname checks remain.
Off-list redirects/resources need exact temporary grants and cannot create
internal reachability themselves. Inventory drift, mixed scope, address change,
route change or expiry revokes the run's reachability and leaves recovery
evidence. A legitimate application on a protected control-plane address needs a
separate application-only proxy/listener, not an exception to that exclusion.

Needed concrete configuration is the intended internal application's exact
origin/IP/port and approved route. No internal target is inferred from existing
hosted service names, and no estate-wide application update is part of it.

## The material custody decision

Recommended first delivery: keep ProxyPilot self-contained and state explicitly
that credential protection isolates the model/browser VM and ordinary dashboard
users while trusting the ProxyPilot backend, host root and hypervisor. Keep
dedicated broker/vault scopes, immutable version references, current grants,
short leases and secret-free outputs. Manual private sign-in can proceed in the
current selected agent without reusable credential enrollment.

The exact decision before activating reusable credentials is:

> Should credential use trust ProxyPilot backend/host root, protecting against
> the browser/model and ordinary users, or must it also resist compromise of
> the backend/host?

If the second guarantee is required, move both custody and the authoritative
current project/task/policy signing service outside the dashboard's
root/hypervisor administration domain, with independently controlled keys,
human identity, registered worker TLS identity, narrow vault ACLs and restricted
upstream enforcement. A sibling container/VM, same-host OpenBao or a signature
whose key is on that host cannot supply the promised independence. Browser
credentials necessarily reach the browser process when used; the isolated
process must still be trusted not to leak them, and MFA/anti-automation provider
constraints may require manual sign-in. CB-01/SEC-01 remain open until this exact
trust choice and placement are confirmed. No stronger protection is claimed by
this document or the existing broker's local backend authority mode.

## Release and verification inventory

| Item | Status | Evidence / deployment | What I should see or be able to do |
|---|---|---|---|
| Manual takeover, exact effects and authentication readback | Deployed | Existing selected service/runtime/routes; source tests cover controller/session, payload pins, partial confirmation and uncertainty | Private sign-in and explicit readback are offered only with current eligible agent/live capability; real account acceptance remains pending |
| Authentication preview non-disclosure | In progress | Auth-only schema and signed-host regression tests, no runtime helper mutation | Endpoint labels retain login/MFA context with arbitrary path segments redacted |
| General reusable browser credentials | Not started | Typed delivery plan above; existing demo/broker adapters remain synthetic-only | Future contributor-owned scoped credential connection with honest version/revoke receipts |
| Provider-specific OAuth | Not started | Exact adapter/client/resource selection and plan above | Future real-provider account/scopes confirmation and token revocation |
| Explicit internal destination delivery | Not started | Internal target-policy shape exists; real target/route and installed acceptance pending | One deliberately configured internal application, with protected targets still refused |
| Compromised-backend/host credential protection | Blocked | Precise CB-01 choice above; same-root sources are not independent | Accurate custody protection statement before reusable enrollment |
