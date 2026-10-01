# Broker-owned human intake

`createIntakeHandler` is an opt-in HTTP request handler for the isolated synthetic
harness. Configured mode additionally requires a genuine `createIdentity` instance
and authenticated direct-human proof for all HTTP intake, with TLS enforced.
See [IDENTITY.md](IDENTITY.md) for the production-capable configured OIDC profile.
Unknown modes fail at construction. It must be mounted on a separate
broker-owned HTTPS origin, with a broker-owned human login/session implementation.
Neither dashboard cookie authentication nor an agent bearer qualifies. The harness
injects `authenticateRequest(req) -> {proof, csrf_token}` and independent
`authenticateProof(proof) -> {user_id, fresh_until, disabled?}`. Proofs and CSRF
values stay in memory; use random disposable fixture credentials, never live keys.
TLS termination must preserve the configured Host. No CORS is enabled.

Factory options: `{mode:'synthetic'|'configured', identity?, broker, origin, statePath,
authenticateRequest, authenticateProof, clock?}`. The returned request handler also
has `.reserve(proof, metadata)`, `.status(proof, intentId)`, and `.close()` methods.
Only a trusted fixture adapter may call these methods. Their proof is independently
validated; arbitrary dashboard user assertions are not authority. Metadata reserve
is not credential enrollment, connection assignment, or a run.

HTTP contract:

| Method/path | Body/result |
| --- | --- |
| POST `/v1/intake/intents` | `{kind:'enroll',connection:{name,project_id,adapter_id,operations,resources,limits}}` or `{kind:'rotate',connection_id,revision}` |
| GET `/v1/intake/intents/:id` | Same authenticated owner's intent status; other owners receive 404 |
| GET `/intake/:id` | Broker-owned HTML with masked field and exact enrollment/rotation summary |
| POST `/v1/intake/intents/:id/submit` | `{credential}`; exactly once, no automatic retry |

POST requires exact Origin, Host, JSON Content-Type, no content encoding, and the
independently authenticated session's X-CSRF-Token. Duplicate headers/JSON keys and
unknown keys are rejected. Bodies are limited to 8192 bytes and a five-second read.
Deploying harness server must additionally bound connection counts and header timeouts.

Reserve/status/submit return `{id,state,intake_url,expires_at}` plus
`connection_id,revision,credential_version` after success and `code` on uncertainty.
States are `reserved`, `submitting`, `committed`, `reconcile_required`. Expiration
blocks submit with `INTAKE_EXPIRED`; status remains readable. Intents expire within
five minutes or the human proof expiry, whichever comes first. The intake page clears
the field before sending, disables its submit button, and reads status after any
response or transport failure. It never automatically retransmits credentials.
Saving is separate from test and assignment. No upstream operation is implied.

State file contains metadata only. A synchronous fsync/atomic replacement records
`submitting` before calling the broker. Startup changes interrupted submissions to
`reconcile_required`; a duplicate submit cannot repeat a vault write. Enrollment
passes the outer intent UUID as broker `externalIntentId`, so operators can look up
the exact protected enrollment record via `broker.enrollmentStatus(proof,id)` and
reconcile it without resubmitting a value. A committed inner enrollment and uncertain
outer receipt are not a reason to enroll again. Rotation targets its original
connection ID/revision. Do not infer success merely from a connection name match.

Only one handler process may own a statePath. The lock records the local process ID.
Normal shutdown calls `.close()`. After an abrupt process exit, the isolated harness
operator can call exported `recoverIntakeLock(statePath)` before reopening. This
helper exclusively serializes recovery and refuses removal unless a local PID probe
returns ESRCH (confirmed dead). A live, reused, inaccessible, malformed or unknown
PID fails closed. Never delete a lock blindly or expose recovery through HTTP. This
is a local filesystem/single-host fixture, not a clustered service. The parent
directory must be owner-only and trusted. Failed storage and capacity exhaustion
fail closed; the disposable store caps total intents at 1000. No automatic garbage
collection or production retention claims are made.

No proof, credential, arbitrary broker error text, or raw request is logged or
projected. CSP disallows framing and external requests; responses are no-store and
no-referrer. Tests exercise concurrent duplicate submit, hostile Origin/CSRF,
wrong owner, unknown secret-bearing metadata, response sanitization, status recovery,
restart replay denial and dead-process lock recovery. Tests use a fake broker; real
OpenBao storage and credential isolation are separately tested by the broker suite.
This component alone does not constitute production identity integration or UI
visual acceptance against the original design assets.
