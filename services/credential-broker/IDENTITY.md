# Configured broker human identity

`createIdentity({config,clock?})` implements a configured public-client OpenID
Connect authorization-code flow with S256 PKCE. No real provider registration or
account is created by this code. Register the exact callback
`<broker_origin>/auth/callback` at the selected issuer. The issuer must support
public-client token exchange, RS256 signed ID tokens, `auth_time`, and the exact
required `acr` value. Confidential-client authentication, dynamic discovery,
refresh tokens and general OAuth provider connectors are not implemented.

Configuration has exact required fields:

```
issuer, authorization_endpoint, token_endpoint, jwks_endpoint, client_id,
broker_origin, dashboard_origin, subject_map, required_acr, max_age_seconds
```

All endpoints are fixed HTTPS URLs without credentials/query/fragments. Origins
must be canonical and distinct. `subject_map` is an array of exact
`{issuer,subject,user_id}` tuples (opaque UUID IDs); email and display names are
never identity keys. `max_age_seconds` is 1–300. Optional `ca_file` adds the
operator-selected CA for private issuer TLS; verification is never disabled.
Service configuration must independently approve those exact issuer hosts.

The identity object exposes:

- `handle(req,res)` → promise boolean handled for `/auth/*`.
- `authenticate(proof)` → `{user_id,fresh_until,proof_type,actions}`.
- `requestPrincipal(req)` → `{proof,csrf_token}` for a direct human request.
- `sessionProof(req)` → opaque direct human proof; no bearer response to a page.
- `createDelegation(humanProof,actions)` → `{bearer,expires_at,user_id,actions}`.
- `health()` and `close()`; close immediately invalidates all capabilities.

`/auth/login` stores independent state, nonce and PKCE verifier in broker memory,
binds the response to a Secure/HttpOnly/SameSite=Lax `__Host-` login cookie, and
redirects only to the fixed authorization endpoint. Callback consumes state before
any token exchange. Token and JWKS fetches use verified HTTPS, bounded bytes, total
five-second deadlines, no redirects, and no raw error propagation. The ID token
must have an unambiguous RS256 key and valid signature, exact issuer, audience and
azp, state-bound nonce, known subject, valid expiry/iat/nbf, fresh auth_time and
required acr. Only standard 30-second future-clock tolerance is allowed. Human
session expiry is bounded by both ID token expiry and authentication freshness.

Sessions, login flows and delegations are ephemeral maps, each capped at 1000;
expired entries are pruned. Bearer verifiers are SHA-256 of random 256-bit values.
No ID/access token, cookie proof, PKCE verifier or delegation is written to disk,
audit or logs. Restart discards all authentication state. Local logout invalidates
the human session and all linked delegations, not the upstream IdP session.
Disabling a principal at the independent authority is a separate per-operation
check; a valid human login alone never creates policy authority.

GET `/auth/session` returns only `{user_id,fresh_until,csrf_token}`. POST
`/auth/logout` and `/auth/delegations` require broker cookie, exact Origin and
session-bound `X-CSRF-Token`. POST delegation body is `{actions:[...]}`. Only the
explicit metadata bridge actions `list,get,assignments,sessions,activity,enroll,
rotate,intent,test,update,revoke,assign,unassign` are accepted; `enroll`/`rotate`
mean reserve metadata intake intents, never submit secret values. Delegations
expire within 300 seconds and their parent human session cutoff. Delegations cannot
mint delegations, approve operations, issue workload sessions, or manage authority.
The configured service must additionally enforce independent ceilings for each action.

Dashboard popup entry:
`/auth/delegations?dashboard_origin=<configured-origin>&state=<random-base64url>`.
State must be 16–128 characters. An unauthenticated popup redirects through OIDC,
retaining dashboard correlation separately from OAuth state. An authenticated
broker-owned consent page explains every action before issuing a delegation. It
posts `{type:'fractionate.broker.delegation',state,delegation,expires_at,user_id}`
only to the configured dashboard origin. The frontend must check exact event origin,
source window and state, bind user ID, and keep the token only in transient memory.
No credentials or delegation appears in URLs or browser storage. Direct intake
login may specify `return_to=/intake/<UUID>`; arbitrary redirects are rejected.

Configured intake requires a genuine identity instance and authenticated human
proof at the HTTP secret surface. Metadata-only delegated reserve/status methods
require the corresponding allowed action. The service supplies the independent
authority wrapper and enforces policy before secret writes. Synthetic fixture
mode remains separately available; merely claiming a configured identity in JSON
does not enable configured intake.

The exported disposable `fixtures/oidc.mjs` issuer generates temporary TLS/RSA
keys and real signatures, serves HTTPS authorization/token/JWKS endpoints, and
checks PKCE. Tests use no external account and no copied production key.

Protocol references checked for implementation:
[OpenID Connect Core 1.0, code flow and ID-token validation](https://openid.net/specs/openid-connect-core-1_0.html#CodeFlowAuth),
[ID Token Validation](https://openid.net/specs/openid-connect-core-1_0.html#IDTokenValidation),
and [RFC 7636 S256 PKCE](https://www.rfc-editor.org/rfc/rfc7636).
This is a constrained configured profile, not a claim of general OIDC certification.
