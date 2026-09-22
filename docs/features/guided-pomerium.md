# G4: guided Pomerium application protection

G4 adds a separate guide inside **Platform Setup**. It reuses the saved platform
plan, administrator/CSRF/fresh-auth gates, encrypted secret references, setup
runner, durable backend route jobs, route store and Caddy renderer. It does not
activate Pomerium for ProxyPilot itself. Accepted progress is still **30% (3/10)**;
G4 is submitted for review, not accepted or deployed.

## Supported contract and choices

Save Install, Connect existing or Skip and a separate authentication origin, such
as `https://access.example.com`. Saving does not start a service. Skip queues no
work; it neither uninstalls an existing gateway nor removes route protection.
Apply/retry requires the saved choice to match the gateway's recorded identity.

Managed installation pins **pomerium/pomerium:v0.33.3**, the official Core release
published 2026-09-09 and checked 2026-09-22. It runs a single independently owned
Docker container, `pp-platform-pomerium`, with explicit self-hosted authentication,
an in-memory databroker, dropped capabilities and a read-only configuration bind.
Caddy continues to own public 80/443, HTTPS redirects, TLS certificates and their
renewal. Core uses host networking solely to reach native loopback applications:
HTTP `127.0.0.1:18081`, gRPC `:18082`, metrics `:18083`, health `:18084`; every
address is loopback. Authorize/databroker service URLs explicitly use port 18082;
v0.33.3 otherwise defaults them to 5443 even when grpc_address changes. No public Docker port mapping or hosted authentication.
Envoy's optional admin interface is not enabled.

The runner owns its container label, configuration directory and lifecycle. It
starts/restarts only that container during an explicit reviewed apply. Retries
reuse the resource and keys. G4 has no migration, rotation or uninstall workflow.
An unavailable runner leaves a durable queued job; the backend never substitutes
host execution. Missing Docker, occupied private ports, failed image pull or
startup, unsafe files and incompatible resources stop verification.

**Connect existing** supports this exact local, single-process Core image/profile
with an inspectable JSON config, fixed command, no environment overrides, private
listeners and a read-only bind at `/pomerium/config.json` (or its parent directory).
It performs read-only Docker inspection and health checks. Authentication settings
must already match the reviewed client. Existing explicit shared/cookie/signing
keys are preserved in a protected reference, not rotated. The runner creates its
own protected handoff, never writes the external config or restarts the external
container. Merge only the named `proxypilot-<route-id>` routes from that handoff;
preserve unrelated routes. The operator must load the config, then retry. Owned
routes must match exactly; overlapping aliases fail. Incompatible global settings
are a refused connection, not permission to overwrite unrelated configuration.
Remote, split-service, YAML-only, Enterprise/Zero management and alternate image
profiles are unavailable. Core has no supported configuration-management API for
this adapter; the guide does not pretend otherwise.

## Keycloak settings

Select the **verified G2 connection** used by G3. Use a distinct confidential OIDC
client, for example `proxypilot-pomerium`; never reuse G3's client or observer.

| Setting | Required value |
| --- | --- |
| Client authentication / Standard flow | Enabled |
| Implicit flow / Direct access grants / Service accounts | Disabled |
| Redirect URI | Exactly `https://access.example.com/oauth2/callback` |
| Web origins | Exactly `https://access.example.com` |
| PKCE | S256 required |
| Scopes | openid, profile, email; stable realm `sub`, no pairwise-subject mapper |
| ID token signature | RS256 |
| Credential | Dedicated client secret entered once; no realm-admin credential |

The guide checks the dedicated client's settings using G3's existing read-only
observer and refreshes G2 discovery/JWKS verification. It makes no identity-provider
writes. Neither a reader check nor discovery proves that the supplied client
secret completes login: perform the browser acceptance below. Keep the existing
G3 browser flow, passkey policy, native sessions and recovery settings intact.
Changing G3 account linkage is not an implicit change to a saved Pomerium policy.

## Review a route and its policy

Choose one existing route. G4 supports a single HTTPS hostname at `/`, without a
prefix rewrite, backed by a **native process bound to 127.0.0.1** on an unreserved
port. A plain proxy service may have `runtime=null` in the existing schema. No new
application type or generated application scaffold is introduced.

The review shows the exact upstream and up to twenty explicitly selected subjects
already verified through G3 for the same issuer. Policy is an OR of exact
`claim/sub` values. Everyone else is denied. Email text, request headers and
unverified group names cannot grant access. Caddy IP restrictions, response
headers/CSP, framing and body/upload limits retain their existing renderer path.
WebSocket routes, custom upstream timeouts, host overrides, basic authentication,
rate-limit combinations, static sites and prefix routes are refused rather than
having their behavior silently removed.

Public routing is **Caddy → Pomerium → application**. There is no `forward_auth`.
Caddy deletes incoming `X-Pomerium-*`, forwarded user/email/groups,
`X-Auth-Request-*`, `Remote-User` and Authorization before forwarding to Core.
Applications requiring an Authorization header or browser-independent API access
are outside this profile; keep those routes under their existing authentication.

The route store refuses a second hostname/upstream alias and locks protected route
edits/deletion and upstream movement until explicit removal. The runner checks
native process listeners using `ss`, refuses Docker-published ports and a process
with another public listener, and requires `route_localnet=0` for every interface.
Caddy's owned/custom files are inspected for conflicting hostnames/upstreams,
including localhost aliases. A named conflict blocks activation without editing
that other configuration. These checks assume an uncompromised host and measure
its current state; G4 does not continuously police root changes, arbitrary
external tunnels or future application rebinding. A service needing broader
network containment is refused; G4 does not rebuild host networking.

## Apply, failure and removal

One saved route intent and revision produces both configurations:

1. A runner job rechecks the provider/client and queues a recorded backend Caddy
   deny/authentication-route step under the existing application and route locks.
2. The backend renders and validates before reloading. Pending is not confirmed
   protection. Only a successful reload records denial.
3. With selected routes denied, the runner validates the closed generated config,
   writes owner-only revision files atomically, and starts the owned Core. Core's
   actual parser/startup and `/readyz` health must succeed. This release has no
   separate `validate` CLI; the guide does not invent one.
4. A recorded backend step switches the application routes to Core. Private and
   public TLS requests with forged identity headers must redirect through the
   self-hosted authentication origin, or retain an existing edge IP denial.
5. Only then does the job record `protected`. This label means the saved policy,
   runtime and unauthenticated/spoof probes passed; real user authorization browser
   acceptance remains separately reported.

Parent progress, child references, ownership and revision files survive browser,
API and runner restart. Reconciliation resumes the saved steps. Retry cannot
silently change a reviewed upstream/policy, replace credentials or duplicate a
route. The application lock and `@host/routes` lease use the existing fencing and
keep-alive machinery. Unrelated Caddy sites continue to use the normal renderer's
rollback behavior.

A failed runtime leaves denial. A failed gateway probe queues a durable denial
step before settling failure. A failed Caddy change retains deny intent on disk
and attempts a validated denial reload; it never restores a direct upstream as a
fallback. If Caddy cannot apply even denial, the job names the affected hostname
and says **runtime denial is not confirmed**. On first activation its old direct
route may still be running: activation is blocked and must not be treated as
protected. Restore Caddy apply before retrying. For an already protected route,
the previous running configuration remains a gateway or denial, not direct.

**Removal is a separate review and fresh-auth action.** It explicitly restores
Caddy → app with existing restrictions and application authentication. Removal
stays locked until completion. Skip, a general route edit and a failed apply
cannot remove protection. A test app that requires a signed assertion will still
return 401 after removal; removal does not turn off its own authentication.

## Identity assertion contract and acceptance app

`admin/backend/scripts/g4-test-app.mjs` is only the G4 acceptance app. It listens on
loopback (default 18443) and requires `X-Pomerium-Jwt-Assertion`. Pin its public
JWKS locally from the trusted configured ES256 signing key or verify the key
fingerprint out of band before using Core's
`/.well-known/pomerium/jwks.json`. Do not fetch a key URL from an incoming token.
The app verifies ES256 signature, key/algorithm, exact application-domain `iss`
and `aud`, expiry, issued-at and nonempty subject, and rejects spoofed identity
headers. An IdP ID token is not this assertion. The assertion's subject is
Pomerium's user identifier; do not assume it is identical to Keycloak's raw `sub`.
Never trust an unsigned email/user header instead.

On an isolated acceptance host, derive only a public key file from the protected
config (never print the private key), then run:

```sh
G4_APP_DOMAIN=app.example.com G4_JWKS_FILE=/secure/g4-public-jwks.json \
  node admin/backend/scripts/g4-test-app.mjs
```

Register its loopback upstream through the existing route mechanism, retain your
existing access restrictions, link one allowed and one unlisted test identity in
the isolated realm, and use the setup guide to review/apply its protection.
Reusable app integration belongs to G8.

## Independent access and sessions

ProxyPilot's dashboard hostname, native SSO callbacks, local recovery hostname,
backend port 3001 and G2 identity hostname are excluded from selection. The entire
Pomerium authentication hostname routes directly to Core without a Pomerium access
policy; Core owns its OAuth and `.pomerium` endpoints. Application `.pomerium`
endpoints also traverse Core. Keycloak discovery, authorization, token, JWKS and
logout endpoints keep their existing G2 route. These separations avoid login loops.

| Existing surface | G4 behavior |
| --- | --- |
| Dashboard and `/api/auth/sso/*` | Existing native G3 authentication |
| Local recovery and root recovery CLI | Independent of Core and Keycloak availability |
| MCP and delegated editing | Existing token/owner authorization, no gateway redirect |
| Provisioning and migration | Existing API permissions and job ownership |
| Terminal and health | Existing terminal/session or health contract |

Core evaluates policy for requests using its session and refreshed identity data.
This profile sets the cookie/session lifetime to **one hour**, not the default
fourteen hours. IdP token refresh occurs before access/ID token expiry; failed
refresh terminates the corresponding session. Disabling a user or revoking an
IdP session is not promised to take effect within G3's sixty seconds. Measure
actual Keycloak token/refresh timing on the acceptance host. A Keycloak outage
blocks new logins; previously valid sessions may work until refresh failure or
expiry. A Core outage leaves Caddy's gateway route unavailable, without a direct
fallback. Its in-memory sessions are lost on restart. Neither ProxyPilot logout
nor local account disable alone is a Pomerium-wide logout. No new back-channel
revocation service is implemented in G4.

## Backup references using existing mechanisms

Keep the existing encrypted configuration backup (database dump plus installation
`.env` / encryption key) and a companion encrypted Pomerium file pack as one
restore set. `packConfigTier` dumps all tables, including `setup_pomerium`,
`setup_pomerium_credentials`, `setup_route_protection` and the setup jobs. The
credential reference alone is insufficient without `TOTP_ENCRYPTION_KEY`.

The normal configuration/config-plus-data backup **does not automatically include**
`/var/lib/proxypilot/pomerium`. From an authorized host console use the existing
`collectDirAsEntries(root, 'pomerium')` and `pack({entries, passphrase, meta})` in
`admin/backend/src/lib/backup-pack.js` to create a companion `.ppbackup`. Supply
the passphrase through the existing protected input mechanism, never argv/logs.
Verify its manifest contains `pomerium/owner.json`, `pomerium/config.json` for a
managed installation, and every retained `pomerium/revision-N.json`; collection
can skip unreadable files, so a successful pack alone is insufficient. Use the
existing destination/storage workflow for the encrypted pack. For Connect also
back up the operator-owned actual configuration via that service's existing
backup procedure; ProxyPilot's handoff is not the whole external configuration.

Restore in a maintenance window with selected routes denied. Restore matching DB,
encryption key, ownership marker and config revisions (directory 0700/files0600,
root-owned on the runner host), Caddy configuration/certificates through the
existing backup tier, and any external config. Revalidate the saved operation
before returning traffic. Missing or conflicting ownership/credential files cause
refusal, not regeneration. Backups do not preserve in-memory Pomerium sessions.
G4 adds documentation and references, not a new G9 backup engine or restore UI.

## Acceptance evidence and remaining execution limits

See `docs/evidence/g4-acceptance.md` for commands, actual results and the explicit
host matrix. Unit/API/runner tests use real HTTP, SQLite, crypto and job code with
scripted host commands. The UI test uses the built frontend and an actual API
process restart; its host completion is explicitly scripted. No result here is
presented as a real Pomerium/Keycloak/Caddy three-service execution.

## Official sources checked before rendering (2026-09-22)

- [Core v0.33.3 release](https://github.com/pomerium/pomerium/releases/tag/v0.33.3)
  , [pinned internal URL defaults](https://github.com/pomerium/pomerium/blob/v0.33.3/config/options.go)
  and [pinned entry point](https://github.com/pomerium/pomerium/blob/v0.33.3/cmd/pomerium/main.go).
- [Upgrade guide: removed forward authentication](https://www.pomerium.com/docs/deploy/upgrading).
- [OIDC / Keycloak](https://www.pomerium.com/docs/integrations/user-identity/oidc)
  and [v0.33.3 OIDC PKCE implementation](https://github.com/pomerium/pomerium/blob/v0.33.3/pkg/identity/oidc/oidc.go).
- [Service URLs](https://www.pomerium.com/docs/reference/service-urls),
  [listener](https://www.pomerium.com/docs/reference/address),
  [gRPC](https://www.pomerium.com/docs/reference/grpc),
  [configuration](https://www.pomerium.com/docs/internals/configuration),
  [health](https://www.pomerium.com/docs/internals/health-checks),
  [PPL claim syntax](https://www.pomerium.com/docs/internals/ppl).
- [Signed application identity](https://www.pomerium.com/docs/capabilities/getting-users-identity)
  and [signing key](https://www.pomerium.com/docs/reference/signing-key).
- [Sessions and refresh](https://www.pomerium.com/docs/internals/sessions),
  [cookies](https://www.pomerium.com/docs/reference/cookies).
