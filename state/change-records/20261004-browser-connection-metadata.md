# Browser connection metadata ownership — 2026-10-04

## Problem and behavior

Reusable browser credentials/OAuth lack a distinct contributor-owned namespace.
The existing connections and A4 binding stores are synthetic-only. Additive
migration1124 introduces inert browser plans, immutable metadata versions and
exact recipient metadata grants while retaining all old namespaces/records.
Operations now exposes a separate metadata API with inherited authentication,
CSRF/no-store, current feature switches and fresh sudo for sharing.

Metadata saves do not enroll secrets, pick custody, register provider clients,
modify accounts/scopes, supply internal reachability or activate a browser.
Capabilities derive their unavailable enrollment/execution state from the actual
absence of a custody/provider implementation. `propose_use` is a proposal right,
not a use-without-reveal promise. Public browsing has no new dependencies.

Current contributor owns metadata and its grants; project owners/admins have no
visibility/manage bypass. Immutable versions retain prior account/origin hints;
version edits revoke prior shares. Explicit expiry, current eligibility/grants,
membership event/role pins and contributor revocation prevent stale shares from
reviving after role changes or removal/readdition. Archived projects allow
privacy revocation and history while freezing create/edit/share.

## Tests and retained failures

- Store/real HTTP tests prove strict secret-field rejection, CSRF/sudo/revision
  enforcement, contributor isolation, grant expiry, membership/rejoin denial,
  audit rollback, immutable history, pagination, archive/account deletion and
  no enrollment/execution side effects. Existing Operations/source-boundary and
  configuration HTTP regressions pass:28/28, no skips.
- The first store run found three test-fixture errors: expiry advanced less than
  the test's creation-time drift; owner-update test included the disallowed kind
  field; membership test used a nonexistent method. They were corrected using a
  larger fixture advance, the valid edit body and canonical `remove` method.
- Broader selected-browser lifecycle/privacy/route and metadata regressions:
  280/280 passed,0 failed/skipped, including focused timestamp normalization,
  membership-role and cross-project cases. Exact review/CI/release evidence is
  maintained by the release coordinator.

## Acceptance and limits

Live acceptance for this slice is authenticated metadata create/read/share/edit/
revoke, current permission refusal, history and no secret intake. It is not a
working provider OAuth or reusable password acceptance. The trust choice and
real provider/client/resource remain unresolved, so no activation is attempted.
No host helper changes or runtime Install are required.

Only the release coordinator may merge, deploy or perform live acceptance. This
implementation agent performed no production operation or secret enrollment.
