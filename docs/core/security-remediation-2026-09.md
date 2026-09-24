# September 2026 security remediation

Tracks the eight findings from the high-level audit. Each finding is delivered
as its own tested commit and pull request. A merge is not a deployment.

| ID | Finding | Status |
| --- | --- | --- |
| S1 | Service authorization and Compose command injection | Fixed; focused tests below |
| S2 | Terminal WebSocket authorization | Open |
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
