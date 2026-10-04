# Browser connection plans

Browser connection metadata lives separately from the legacy demo credentials and
synthetic API broker. A saved website/OAuth plan has no secret, enrolled account,
credential version, OAuth client or execution authority. Current capability
responses say custody/provider enrollment and execution are unavailable. The
unresolved backend/host trust choice remains explicit; saving metadata does not
choose it or impede public browsing.

A current Operations owner/editor/operator/reviewer can create a plan as its
contributor. Plans start private to that contributor. The project owner or an
administrator does not inherit metadata visibility or manage rights. Current
project membership and account eligibility are checked on every read/write.

The contributor can share one exact metadata version with another current
member until an explicit future expiry. `view_metadata` shares its name, origin
and account hint. `propose_use` also shares that metadata and records an intention
to propose a future scoped use; it grants no browser execution, secret disclosure
or broker session. Share creation uses fresh sudo and an exact review statement.
Editing creates a retained metadata version and revokes prior version shares.
Member removal/readdition or role/ownership changes cannot revive earlier grants.
Account deletion preserves historical records. Archived projects keep history
and permit privacy revocation while refusing new plans/edits/shares.

Use `/api/operational-projects/:projectId/browser-connections`:

| Method / suffix | Result |
|---|---|
| `GET /capabilities` | Metadata-only capabilities; enrollment/execution/OAuth authorization unavailable |
| `GET /` | Current contributor/explicitly shared plans, filtered before cursor pagination |
| `POST /` | Create `{name,kind,origin,account_hint}` with project `If-Match`; kind `website-login` or `oauth` |
| `GET /:id` | Current authorized metadata and connection ETag |
| `PATCH /:id` | Create retained version from `{name,origin,account_hint}` with connection `If-Match`; revoke prior shares |
| `POST /:id/revoke` | Revoke plan and its grants with connection `If-Match`; preserve history |
| `GET /:id/versions` | Contributor-only retained versions; `after` descending numeric version and `limit`1–50 |
| `GET /:id/grants` | Contributor-only grant history; `after` UUID and `limit`1–50 |
| `POST /:id/grants` | Fresh-sudo share with recipient ID, permission, expiry, fixed statement and connection `If-Match` |
| `POST /:id/grants/:grantId/revoke` | Contributor revocation with connection `If-Match`; no enrollment/execution effect |

Fixed share statement:
`Share this exact browser connection metadata version with this member`.

Creation/edit input origins are exact HTTPS origins; they do not create internal
reachability, expand protected targets or contact a website. There are no
enroll/reveal/rotate/authorize/callback/start/test endpoints. Unknown secret,
token, vault-path, client-secret, activation and identity-override fields are
refused without echoing values. Global Operations session/CSRF/no-store and
current feature switches remain authoritative.

Migration1124 is additive, retaining existing projects, demo bindings, broker
records and browser histories. Connection identity/revocation and version/grant
history have SQL immutability constraints. State, version snapshots and audit
events commit in one immediate transaction; an audit failure rolls all of them
back. These records are not tamper evidence against host/DB administrators.

Real enrollment and provider OAuth require separately implemented and verified
custody/adapter boundaries. See the concrete delivery plan in
`docs/plans/fractionate-browser-connections-delivery-20261004.md`.
