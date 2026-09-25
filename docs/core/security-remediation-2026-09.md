# September 2026 security remediation

Tracks the eight findings from the high-level audit. Each finding is delivered
as its own tested commit and pull request. A merge is not a deployment.

| ID | Finding | Status |
| --- | --- | --- |
| S1 | Service authorization and Compose command injection | Fixed; focused tests below |
| S2 | Terminal WebSocket authorization | Fixed; tests and limits below |
| S3 | Predictable trusted-device MFA bypass | Fixed; migration 1012 |
| S4 | TOTP replacement and enrollment proof | Fixed; migration 1013 |
| S5 | MCP scope and child-key escalation | Fixed; migrations 1014/1016 and log upgrade below |
| S6 | Web backend holds host-root authority | Partially implemented/open; boundary hardening delivered, architectural migration remains |
| S7 | Vulnerable production dependencies | Package findings fixed; scan limits below |
| S8 | Public first-account claim | Fixed; migration 1015 and local bootstrap |

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

**Upgrade compatibility correction:** migration 1014 initially paused all historical
keys. Migration 1016 resumes only active dashboard root keys with a unique,
matching creation audit, preserving their exact hash, scope and expiry. Unknown
or ambiguous provenance, MCP-created keys, revoked/expired keys and inactive
owners remain refused. A freshly proven local administrator can use **Restore
connection** to save a new root grant using the same token and URL.

MCP Access now defaults to **Allow all tools** and shows the complete searchable
catalog. The checkbox submits `{self_edit:true}` with `full_access:true` (all
tools/resources, including self-edit); unchecking enables custom JSON scopes.
Saving still needs fresh local proof and an explicit expiry (30 days by default,
0 for no expiry). It never enables feature flags or bypasses operation checks.
Secrets are shown once, stored hashed, and excluded from inventory responses.

Regression verification: 211 MCP tests pass, including actual HTTP catalog/grant
checks and the native SQLite recovery migration. The real dashboard/browser
flow tests default selection, custom/all checkbox transitions, restoration with
the same connection, error feedback, CSRF and six widths (360/375/390/768/1280/
1920px), with the overflow guard disabled. Lighthouse mobile accessibility: 98.
Production frontend build passes. Browser regression runs in security CI.

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


## S7: dependencies and continuous regression checks

Fresh npm audits on 2026-09-24: backend **9 → 0** package entries (2 high,
6 moderate, 1 low before); frontend **7 → 0** (3 high, 3 moderate, 1 low).
CLI and shipped application template both report zero. Full before/after
advisory data is in `security-dependency-scan-2026-09.json`.

Runtime fixes: Multer 2.4.0, Nodemailer 9.1.1, SimpleWebAuthn 13.3.3,
Express 4.22.3/body-parser 1.20.8/qs 6.16.0, ldapts 8.2.0 and node-cron
4.6.0. The latter two remove vulnerable nested uuid versions. Multer's new
safeguards require explicit opt-in: every upload route now bounds multipart
field depth, array indices, field count/size and parts as well as file bytes.
Cron scheduling still starts immediately; discarded tasks use v4 destroy to
release their registry entries. LDAP's used Client/bind/search/unbind interface
is unchanged. Nodemailer keeps the SMTP-only, explicit field interface.

Frontend uses React Router 7.18.4 (React 18 compatible), with PostCSS 8.5.28,
Nano ID 3.3.19 and updated browser/selector tooling. Router is a runtime browser
dependency; PostCSS and browser-target discovery are build-time dependencies.
The app does not use Router server rendering, so its SSR-specific advisory did
not represent an observed deployed SSR path. Multipart issues are reachable
through authorized upload routes. Several Nodemailer advisories concern options
not accepted by the notification wrapper; the package is updated regardless.

The image moves from EOL Node 20 to Node 24 LTS and installs the lockfile with
npm ci. Backend and recovery CLI native SQLite move to 12.11.1 for supported runtime compatibility.
Native installs/build hosts require Node 22.15+ or 24; update preflight refuses
older versions before rebuild, and installation selects 24. The agent builder
moves from Go 1.21.13 to verified Go 1.27.1 tarballs with pinned SHA-256 checks.
Existing configuration, data and encryption keys are untouched.

Validation: **267 tests passed**, including all S1–S5 HTTP/WebSocket/MCP and
migration tests, real native SQLite/passkey checks, LDAP/notification tests,
real SMTP delivery/header-injection checks, bounded multipart size/index,
malformed/aborted upload cleanup and scheduler lifetime. Frontend build, Go vet,
Go tests, and govulncheck passed (no Go vulnerabilities found). Caddy transform
and shell syntax checks pass. Four pre-existing Unix-socket CVE-driver tests
are blocked locally by EPERM on socket bind; they remain enabled in CI.
Browser visual/navigation QA and Docker image/OS vulnerability scanning remain
unexecuted because the necessary runtime tools are unavailable.

`security-regression.yml` runs on every PR and main push: native backend
security/upgrade tests, all four npm audits (all severities), frontend build,
Python/shell checks, Go vet/tests and govulncheck. No path filter can omit a
middleware/schema/policy change. No advisory suppression was introduced.

Primary references: [Multer array-index advisory](https://github.com/expressjs/multer/security/advisories/GHSA-535w-7cp7-47q4),
[Multer aborted-upload advisory](https://github.com/expressjs/multer/security/advisories/GHSA-qfvm-cv95-jqjf),
[Nodemailer advisory](https://github.com/nodemailer/nodemailer/security/advisories/GHSA-8m3c-c648-2xjj),
[Router advisory](https://github.com/remix-run/react-router/security/advisories/GHSA-wrjc-x8rr-h8h6),
[PostCSS advisory](https://github.com/postcss/postcss/security/advisories/GHSA-fxqj-rqcc-2cmp),
[cron migration](https://nodecron.com/migrating-from-v3.html),
[Node release support](https://nodejs.org/en/about/previous-releases), and
[Go release checksums](https://go.dev/dl/?mode=json).

S7 CI follow-up: all 13 checks on the first PR revision passed, including the
Unix-socket CVE-driver tests and both storage integration jobs. The recovery
CLI SQLite dependency is also upgraded for Node 24, and its recovery tests are
included in the security workflow.


## S8: installation possession proof

Initial administrator setup requires a 256-bit random credential bound to the
installation and intended local user. Migration 1015 creates the protected
verifier/lifecycle table and a stable installation identifier without changing
initialized accounts. No credential is generated by a public API. The installer
uses `proxypilot recover bootstrap <username>` after backend startup; the same
root-only command handles expiry/retry on upgrades. It writes a fresh 0600
credential file under root-owned `/run/proxypilot-bootstrap` and prints only the
path/deadline. Only the hash persists in the database. Issuing again invalidates
the preceding token; runtime files disappear on host reboot.

The public status response contains only needsSetup. Claiming checks proof
before hashing and atomically rechecks/consumes it with the password update.
LDAP/SSO-linked accounts, passkey holders, initialized accounts and the wrong
installation cannot be claimed. Success yields S4's limited enrollment session.
After an interrupted enrollment, ordinary password sign-in restarts the bounded
MFA ceremony. Existing root recovery handles a lost password without resetting
application data or encryption keys. The setup UI has an explicit credential
field and never stores it in browser storage or URLs.

Validation: 33 bootstrap/upgrade/root-recovery tests pass with native SQLite.
They include two concurrent HTTP claims, one-use proof, expiry, cross-account /
installation mismatch, no username disclosure, root file permissions, verifier
storage, LDAP/SSO refusal, limited-session denial, real TOTP completion, password
retry and an actual second-process database restart. Frontend production build
passes. Browser visual QA and installer execution on a representative host
remain unexecuted. See `docs/features/root-recovery.md` for operator commands.

CI runs the bootstrap integration subset as root on its disposable runner, using
temporary databases/directories, to exercise the real root-only CLI and file
ownership checks. All other backend tests retain the ordinary runner identity.
The initial CI run correctly refused the positive issuance cases as non-root;
the production ownership checks remain intact.


## S6: partial host-boundary hardening; architectural finding remains open

The existing agent now checks kernel Unix peer UIDs, rejects undeclared fields,
limits connections/method concurrency and bounds request reads, responses,
subprocess output, child lifetime and update-state reads. Audit metadata excludes
request/result/error content. The Node client refuses oversized requests before
connecting. Agent unit resource limits are explicit. The updater no longer
restores privileged mode; a read-only effective-Compose preflight refuses a
restricted/custom deployment before mutation. A real invocation of update.sh in
a disposable fixture proves refusal before checkout, package or service effects.

The standard backend still retains privileged mode, host PID access, daemon
socket and host mounts because replacements remain incomplete. The 96-file
candidate inventory, operation/owner/contract matrix and exact missing host
acceptance checks are in [security-host-boundary.md](security-host-boundary.md).
PR #674 adds reviewed Infisical guest-network and evidence-decoder candidate
contracts with narrow validation and cleanup fixes. Inventory acceptance records
source review only; S6 and SEC/INF deployment findings remain open.
This is not closure by configuration flag or a generic agent exec method.
Independent host-side authority for broad operators, remaining typed operations,
and a representative installation are still required.

Local validation: Go vet, method/migration tests and dispatcher/UID-policy tests
pass with the race detector. The real Unix peer test cannot bind in this sandbox
and is required in hosted CI. Five Python tests cover logging and effective
Compose preflight, including the actual updater invocation. All 57 affected
update/recovery/policy tests pass. The selected-agent Caddy outage reaches no
recorded host-command effect. Two locally runnable Node client tests pass; hosted
CI runs the complete Unix client/driver suite. No host deployment occurred.

## Publication and combined rollout

Stage A was committed and merged per finding: S1 [#649](https://github.com/CyberTechArmor/ProxyPilot/pull/649),
S2 [#650](https://github.com/CyberTechArmor/ProxyPilot/pull/650),
S3 [#651](https://github.com/CyberTechArmor/ProxyPilot/pull/651),
S4 [#652](https://github.com/CyberTechArmor/ProxyPilot/pull/652),
S5 [#654](https://github.com/CyberTechArmor/ProxyPilot/pull/654),
S7 [#655](https://github.com/CyberTechArmor/ProxyPilot/pull/655),
S8 [#657](https://github.com/CyberTechArmor/ProxyPilot/pull/657).
S7/S8 hosted security CI passed, including native SQLite and the Unix-socket
checks that were unavailable earlier locally. Those later native results
supersede the initial S3/S4 adapter-only limitation above. All seven S8 checks
passed after its root-only integration step was corrected; eight combined S8 /
newer Infisical compatibility tests also passed before merge.

Use [security-remediation-runbook.md](security-remediation-runbook.md) for backups,
management-network containment, credential/key transitions, preflight, verification,
root recovery and rollback limits. The unexecuted browser, image/OS and representative
host checks remain explicit. Seven findings are fixed; S6 remains open.
