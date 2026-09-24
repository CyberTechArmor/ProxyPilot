# September 2026 security remediation

Tracks the eight findings from the high-level audit. Each finding is delivered
as its own tested commit and pull request. A merge is not a deployment.

| ID | Finding | Status |
| --- | --- | --- |
| S1 | Service authorization and Compose command injection | Fixed; focused tests below |
| S2 | Terminal WebSocket authorization | Fixed; tests and limits below |
| S3 | Predictable trusted-device MFA bypass | Open |
| S4 | TOTP replacement and enrollment proof | Open |
| S5 | MCP scope and child-key escalation | Open |
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
