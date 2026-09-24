# September 2026 security remediation

Tracks the eight findings from the high-level audit. Each finding is delivered
as its own tested commit and pull request. A merge is not a deployment.

| ID | Finding | Status |
| --- | --- | --- |
| S1 | Service authorization and Compose command injection | Fixed; focused tests below |
| S2 | Terminal WebSocket authorization | Fixed; tests and limits below |
| S3 | Predictable trusted-device MFA bypass | Fixed; migration 1012 |
| S4 | TOTP replacement and enrollment proof | Fixed; migration 1013 |
| S5 | MCP scope and child-key escalation | Fixed; migration 1014 and log upgrade below |
| S6 | Web backend holds host-root authority | Open; requires architectural migration |
| S7 | Vulnerable production dependencies | Open |
| S8 | Public first-account claim | Open |

## S1: service authorization

Every service route carries a policy from `middleware/service-access.js`.
Anonymous, pending, missing and link-only accounts are refused. Authorization
reads the current database role and service grants. Lists and exports filter
each service. Delegated viewers may read granted services; delegated writers
may edit granted static content. Docker manifests, raw Caddy configuration,
routing, imports, certificates and host operations require an administrator;
mutations additionally require the existing sudo reauthentication gate.

Compose uses argument arrays through the host namespace boundary. Service names
are validated. Its YAML file and ancestor directories must be canonical,
root-owned and not group/world writable. Symlink paths are refused. The generic
endpoint rejects `destroy`; the dedicated destroy endpoint also verifies a
confirmation factor. A missing manifest is an error, and host-wide prune is no
longer part of project deletion. Operators must restore the manifest or manage
orphaned resources locally. Static file operations reject symlink traversal.

Validation: 41 tests passed across `security-services`, `route-render`,
`zip-extract`, `zip-staging`, and `tls-mode-route-order`. Security tests exercise
the real Express routes, authentication, CSRF, and SQLite authorization with
host-command effects replaced by a recording boundary. They cover denied and
permitted service access, host-operation refusal before execution, sudo, argv
injection, destroy alias refusal, symlinks, and route-policy coverage. No live
host or production configuration was modified. These tests do not establish
host privilege separation (S6 remains open).

## S2: terminal authorization

Browser upgrades require an exact configured dashboard/SSO/recovery Origin and
matching destination. Host-supplied values alone are insufficient. Additional
explicit development origins may be configured in `TERMINAL_ALLOWED_ORIGINS`
(comma separated). Cookie-authenticated requests without Origin are refused.
Bearer clients may omit Origin only when no authentication cookie is present.
Session and token identities must match; pending, linking-only and revoked users
are denied before PTY allocation.

A delegated guest operator needs both the `proxy` feature permission and a
write grant on a service whose `lxc_container_name` names that guest. This is
full guest shell authority. The same decision protects HTTP container routes,
including exec and workspace operations. Project terminals retain their editor
membership resolver and recheck its resolved container. Host terminals require
a local administrator session, local proof within five minutes on opening,
and an unexpired sudo grant. The existing sudo modal opens before a host
connection; SSO operators must use the configured local recovery origin.

Every input/output frame rechecks current authorization. Quiet terminals poll
at five seconds, killing the PTY on revocation, role or grant loss. Central SSO
account verification retains its existing 60-second freshness bound, plus the
five-second terminal polling interval. The VM probe is followed by another
check before PTY spawn. Nested HTTP shell source is single-quoted at the host
boundary to prevent guest commands expanding on the host.

Validation: six actual WebSocket integration tests (fake PTY, real auth/SQLite)
cover origin policy, pending/ungranted callers, identity mismatch, delegated and
bearer access, fresh host proof, demotion, project/guest grant loss, logout and
SSO account disable. All eleven guided SSO tests pass. Frontend production build
passes. The terminal layout and modal markup are unchanged. Mobile visual QA
and a real sibling-origin browser check remain unexecuted: this environment
has no installed browser, and the browser download failed. HTTP upgrade tests
exercise hostile sibling and absent Origin headers directly.

## S3: retire fingerprint device trust

Password sign-in always requires TOTP. Request headers, `deviceFingerprint`
and `registerDevice` can no longer create or exercise MFA exemptions. Passkey
sign-in retains its existing verification. The login page removes the old
remember-device switch and explains the new behavior.

**Upgrade notice:** migration 1012 deletes legacy trusted-device records and
revokes pre-upgrade sessions/sudo grants. Users must sign in again with their
existing factors. Password hashes, TOTP seeds and passkeys are preserved. The
versioned migration runs once; subsequent starts preserve newly authenticated
sessions. No replacement device-trust credential is introduced.

Validation: the actual login-route regression and all eleven guided SSO tests
pass, including copied fingerprints and matching headers. Ten passkey guard
checks and an actual initDatabase upgrade/idempotence test pass using Node's
SQLite engine through a test-only adapter because native better-sqlite3
bindings are unavailable in this environment. The unadapted passkey suite
could not start; it was not counted as a native pass. Frontend build passes.
Browser visual QA remains unavailable as described under S2.

## S4: bound MFA enrollment and factor replacement

Initial setup and password login for an unenrolled account now issue a
five-minute enrollment session. The database and JWT both record its limited
purpose. Only completion and logout are allowed; ordinary APIs, setup, key
minting and WebSockets refuse it. The pending server-generated seed is encrypted
at rest and bound to that user/session, purpose, prior factor and deadline.
Completion consumes it atomically; wrong proofs have a five-attempt budget.
Cookie completion requires CSRF, and pre-auth CSRF exemptions match exact routes.

An already-enrolled account cannot use the setup endpoint to reset its factor.
The profile replacement flow verifies the password and current TOTP (the API
also supports the existing current-passkey confirmation ceremony), then creates
a session-bound pending seed. The profile form asks for the current code before
showing a replacement QR. Finishing replacement atomically updates the factor,
consumes pending state, revokes all sessions/device trust, and writes the audit
and notification. The user signs in again with the new factor.

Migration 1013 retires sessions and MCP keys belonging to accounts that had not
completed TOTP enrollment under the previous flow. Completed accounts retain
their existing authority. The migration and repeated startup are tested.

Validation: 28 integration/regression tests pass across enrollment, service,
terminal, device-trust and guided SSO suites. Tests cover arbitrary factor
replacement, real old/new OTP proof, session binding, encrypted storage,
expiry, attempt budget, missing CSRF, concurrent completion, replay, limited
session boundaries, session invalidation and durable notification. Both upgrade
migration tests pass with the test-only Node SQLite adapter. Frontend build
passes; browser visual QA remains unexecuted (S2 environment limitation).


## S5: MCP delegation and review

Scopes fail closed on malformed JSON, unknown fields/types and invalid resource
IDs. Empty allowlists deny all. Explicit tools do not override resource bounds;
source/destination and kind/target aliases are checked. Filtered inventory and
catalogs follow the same restrictions, with dispatch authoritative. Child keys
inherit omitted scopes/finite expiry and cannot broaden tools, resources,
self-edit or expiry. Every request checks current owners and the complete stored
parent chain; revocation, restriction, expiry and role loss disable descendants.
Cycles/depth abuse fail closed. Confirmation flags/tokens remain machine workflow
controls, not proof of a separate human decision. Administrator account creation,
promotion and reactivation now require the dashboard, preventing a restricted
automation key from manufacturing a new administrator grant.

**Upgrade notice:** migration 1014 marks every existing key for explicit review,
because historical lineage is unknown. Hashes/inventory are retained. An admin
with local proof from the last five minutes reviews the scope and expiry in MCP
Access, granting a new root authority without rotating the secret. Root creation
also requires explicit scope/expiry and an additional full-access choice when
unrestricted. New UI defaults to inventory tools and 30 days. Secrets are shown
once, stored hashed, and excluded from inventory responses.

Application errors and ledger serialization redact MCP credentials. Installer
and updater harden standard Caddy access and runtime log formats, including URL,
Referer, cookie and Authorization fields. The updater stops for custom formats
that require local review, or failed Caddy validation/reload, restoring config
on failure. Manually deployed backends must apply equivalent log filters before
using URL credentials. Prefer Bearer transport. Review upstream/CDN logs too;
these are outside the repository's control. Existing historical logs are not
rewritten: revoke/reissue keys if they were recorded there.

Validation: 186 MCP tests pass, including actual Express/CSRF/authentication,
SQLite, child minting and dashboard review. A recorded host boundary proves
out-of-scope calls have no effects and container inventory remains filtered.
The actual migration/idempotence test passes using the Node SQLite adapter.
Two Python Caddy transform tests, shell syntax checks and frontend build pass.
Caddy validate/reload and 360px browser QA remain unexecuted here (no binaries).
The upgrade performs Caddy checks on the operator's host before continuing.
