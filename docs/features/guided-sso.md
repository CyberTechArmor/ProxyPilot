# Guided ProxyPilot SSO, passkeys and recovery (G3)

G3 extends **Platform Setup** for fresh and existing installations. It uses the
verified Keycloak connection from G2, existing local users/sessions, sudo gates,
root recovery command and setup jobs. It does not change generated-app or machine
authentication. Local passwords, TOTP and existing passkeys are never removed.

## Before starting

Keep a working local administrator and its recovery factors. For a fresh install,
finish the existing administrator and TOTP setup first. Verify G2, then choose
three distinct stable HTTPS DNS origins: ProxyPilot, Keycloak and local recovery.
The ProxyPilot origin must match the current administrator domain. Changing a
passkey hostname requires separate enrollment; do not use temporary IP addresses.

G3 supports **Keycloak 26.7.4**. For managed G2 this is its pinned version; for an
external service, the realm administrator must confirm the installed version.
The guide reads settings using a limited observer, not server-wide administrator
access. It cannot independently discover the distribution version through those
permissions. Other versions require a reviewed settings profile before use.

## Configure the realm and dedicated clients

The realm administrator performs these actions. ProxyPilot makes no realm/client
writes, for managed or external realms. Obtain authorization before changing
shared realm passwordless policy. If it is incompatible with other applications,
use a separately approved realm and verify that connection through G2.

1. Import the client JSON shown by the guide. Enable confidential client
   authentication and standard authorization-code flow. Disable implicit flow,
   direct access grants and service accounts. Require S256 PKCE and RS256 ID-token
   signatures. The **only** redirect is
   `https://<proxypilot-host>/api/auth/sso/callback`, with no wildcard, additional
   redirect or fragment. No web origin is needed for server-side exchanges.
2. In Authentication → Policies → WebAuthn Passwordless Policy, set RP ID to the
   exact Keycloak hostname, User Verification to `required`, and Discoverable
   Credential to `required`. In 26.7.4 the representation field is
   `webAuthnPolicyPasswordlessResidentKey: "required"`. The deprecated
   `webAuthnPolicyPasswordlessRequireResidentKey: "Yes"` is accepted only if the
   replacement field is absent. An explicitly weaker replacement is refused.
3. Enable the `webauthn-register-passwordless` required action. Create a dedicated
   loginless browser flow with a single REQUIRED `webauthn-authenticator-passwordless`
   execution. Bind it **only to the ProxyPilot client** as its Browser Flow
   override. No Cookie, password alternative, conditional branch or subflow is
   accepted. Preserve the realm's existing default browser flow for enrollment
   and other applications.
4. Use the signed ACR value appropriate to that flow (normally `1`). The backend
   verifies both that value and the passkey-only flow; ACR alone is not proof.
5. Create a separate confidential observer client with service accounts enabled,
   interactive/direct grants disabled, and only the `realm-management` roles
   `view-realm`, `view-clients`, `view-users`. Do not supply realm-admin credentials.
   This observer checks client/flow/policy and account enabled/deleted state.
6. Save both client IDs and secrets in the guide. Save is inert. Secrets are
   encrypted with the existing AES-GCM secret mechanism; jobs contain only a
   configuration fingerprint/reference. Blank secret fields retain the protected
   credential when editing. Review both origins and the existing administrator
   network/WireGuard addresses, then explicitly queue settings verification and
   recovery-route creation. Their durable states appear on the existing setup page.

Official version-specific sources checked for this implementation:
[26.7.4 WebAuthn guide](https://github.com/keycloak/keycloak/blob/26.7.4/docs/documentation/server_admin/topics/authentication/webauthn.adoc),
[26.7.4 realm representation](https://github.com/keycloak/keycloak/blob/26.7.4/core/src/main/java/org/keycloak/representations/idm/RealmRepresentation.java),
[26.7.4 policy compatibility](https://github.com/keycloak/keycloak/blob/26.7.4/server-spi/src/main/java/org/keycloak/models/WebAuthnPolicy.java),
and [26.7.4 Admin REST API](https://www.keycloak.org/docs-api/26.7.4/rest-api/index.html).

## Link, test, recover, then explicitly activate

Use the guide in this order; all results are checked by the server:

1. Enroll a Keycloak passkey through its account console. A realm administrator
   can assign the registration required action if needed. This must be a new
   Keycloak enrollment even if the same device has a local ProxyPilot passkey.
2. Re-prove your local password plus TOTP or local passkey, then explicitly link
   the Keycloak identity. Local proof lasts five minutes. The fresh passkey login
   proves the other identity. The key is **issuer + subject**, never email.
   Existing IDs, account data and local roles remain unchanged. Conflicting links
   are refused. Unlinked Keycloak identities are pending and receive no session.
3. Test SSO login. It must return to ProxyPilot as the linked local administrator.
   Login grants no sudo elevation. Then test OIDC reauthentication through the
   existing sudo gate. It must use the same issuer/subject and newly authenticate:
   `prompt=login`, `max_age=0`, signed `auth_time` no earlier than the challenge
   (five-second clock tolerance), at most 120 seconds old, and the required ACR.
4. Generate a recovery-check URL. Open it in a **different browser or private
   profile**. It first visits the primary hostname to reject the initiating browser,
   then enters the recovery hostname using a one-time challenge. Sign in locally
   as that administrator and confirm with fresh local sudo. Two host-scoped cookies
   in the same browser do not count as separate-browser evidence.
5. Return to the primary browser, refresh checks and explicitly select activation.
   The server requires the linked current local administrator, valid client/policy,
   successful SSO login, step-up and separate-browser recovery from this saved
   configuration. Login/sudo/recovery evidence expires after one hour and requires
   still-valid, unrevoked sessions. The recovery route must have a successful job
   and retain the reviewed hostname, loopback target, HTTPS and network allowlist.
   Keycloak settings and administrator enabled state are checked again. A checkbox
   or browser success message cannot satisfy these checks.

Saving any configuration revision invalidates old flow/evidence and test sessions.
Changing an active configuration first requires disabling SSO through recovery.
There is no sandbox bypass or automatic activation.

Before activation, existing local access remains usable. Activation revokes public
local sessions; the independent local recovery session and valid SSO sessions remain.
The public login page still offers **Link an existing local account**. Those local
proof sessions can only view their profile, re-prove their identity, link, or log
out: they cannot access applications, jobs, terminals or other APIs. LDAP sessions
also cannot bypass activated SSO. Existing administrator-issued invitation links can still set a local password;
the subsequent sign-in is also linking-only. Users then sign in through Keycloak. Administrators
continue to assign roles locally; no Keycloak group/role/email silently grants access.

## Independent local recovery and disabling SSO

The recovery route is an ordinary managed Caddy route to ProxyPilot's existing
backend, restricted with its existing source-IP allowlist. Supply the administrator
CIDRs or existing admin/full WireGuard peer IPs already used on the host. G3 creates
no VPN. Configure DNS/TLS and ensure the backend port is private so direct access
cannot bypass Caddy. Account for the host's existing trusted-proxy topology; do not
replace source addresses with an untrusted client header.

Recovery requires a **local administrator**. Trusted-device shortcuts cannot skip
TOTP there. Password/TOTP work without Keycloak. A separately enrolled local recovery
passkey also works: its RP ID is explicitly the recovery hostname and its sole
allowed origin is the saved recovery HTTPS origin, independent of the normal
passkey-origin allowlist. Public-host or Keycloak passkeys are not migrated.
Cookies are host-scoped (no Domain attribute).

If local credentials are lost, use the unchanged root-only command over existing
SSH/console access:

```sh
sudo proxypilot recover admin <username> --password
```

Use its existing `--totp`, `--unlock`, `--passkeys`, `--revoke-mcp-keys` or `--create`
options only as needed; see [root recovery](root-recovery.md) for prompts and effects.
Then sign in at the recovery hostname, open **Local administrator recovery**, and
choose **Disable SSO** with fresh local password/TOTP or a local recovery passkey.
This operation makes no IdP request and works even if G2 verification metadata is
no longer valid. It revokes OIDC sessions/elevation and clears activation evidence;
local credentials and recovery access remain. Public local sign-in is restored.
Do not delete local credentials during G3.

Back up the existing ProxyPilot SQLite database and its secret-encryption key
(`TOTP_ENCRYPTION_KEY`) using existing protected backup procedures. The database
contains encrypted client credentials, links and configuration. Keep Keycloak's
G2 database/configuration backup independently recoverable.

## Revocation and outage contract

Local disable/delete continues to immediately revoke sessions, elevation and the
user's existing MCP keys through the existing revocation paths. Each authenticated
request reads the current local account/role; sessions cannot outlive deletion.
Machine credentials and generated-app authentication are otherwise unchanged.

For central revocation, G3 uses the supported Admin REST **read-only account-state
check**, not a back-channel logout assumption. Each OIDC session has a hard maximum
**60-second** positive-check lifetime, measured from before the network request.
At expiry the next authenticated request must verify settings and confirm the same
Keycloak subject is still enabled. A disable/delete revokes all OIDC sessions and
elevation for that issuer/subject. DNS/network/TLS/observer failure denies access
when the existing deadline expires; it never extends the deadline. Recovery stays
available. Inactive sessions need no background polling because they cannot make
a new authorized request past the deadline. Terminal input/output checks that same
deadline; idle terminal sockets close on the five-second sweep after expiry.
An already-running host job is not automatically cancelled by logout/revocation.

OIDC uses maintained `openid-client` 6.8.8, code + S256 PKCE, single-use encrypted
transactions, state/nonce, explicit signature/JWKS checks and issuer/audience/time
validation. Provider tokens are transient server-side values, never local-session
JWTs, frontend payloads, job records or logs. `form_post` keeps authorization codes
out of redirect query/access logs. The secure HttpOnly host-only transaction cookie
uses SameSite=None to receive that cross-site POST; the existing local-session
cookie policy remains unchanged. Outbound requests pin reviewed DNS, validate TLS,
refuse redirects/other origins and bound response size/time. Infrastructure must
not log request bodies or authorization headers containing credentials.

## Verification and acceptance boundaries

See the fixed [G3 ledger](../core/platform-delivery-ledger.md#g3--fixed-acceptance-checklist-recorded-before-implementation-2026-09-22)
for final counts and evidence. `guided-sso.test.js` executes production API, auth,
CSRF, SQL/job paths and real RSA-signed OIDC validation against scripted transport.
`sso-transport.test.js` uses real local TLS and the production restricted transport.
The fixture substitutes `node:sqlite` for the unavailable native driver.

`admin/frontend/scripts/verify-sso-live.mjs` is opt-in disposable acceptance. It
requires a loopback Keycloak 26.7.4, a disposable bootstrap password, test TLS key/cert
and Chromium. It refuses to replace a realm unless explicitly marked disposable.
It runs actual passkey ceremonies with a virtual UV/discoverable CTAP2 authenticator,
real Keycloak tokens and read-only observer calls. The live disable test forces
local cache expiry; the backend suite separately tests the exact 60-second boundary.
Loopback transport mapping,
fixture local database and test certificates are explicit limitations; no production
identity or service is touched. Physical devices, real host DNS/certificates,
Caddy/WireGuard enforcement and a live root-console restore drill require host
acceptance. Production activation still enforces every prerequisite above.

Optional backlog, outside G3: additional version profiles, optional authorized
client provisioning, additional explicit non-admin role mappings and obsolete
encrypted-credential garbage collection. G4–G10, A-17 and Phase F remain untouched.


Reproduce the repository checks from the checkout root:

```sh
node --test admin/backend/src/__tests__/guided-sso.test.js admin/backend/src/__tests__/sso-transport.test.js
npm run build --prefix admin/frontend
```

For disposable browser/service acceptance, provide `JAVA_HOME` for Java 21,
`G3_KEYCLOAK_HOME` for an unpacked **26.7.4** distribution,
`G3_KEYCLOAK_URL=http://127.0.0.1:18088`, a throwaway
`G3_KEYCLOAK_PASSWORD`, `CHROMIUM_EXECUTABLE_PATH`, and `G3_TLS_KEY` /
`G3_TLS_CERT`. The test certificate needs SANs `identity.example.com`,
`pilot.example.com`, `recover.example.com`. `G3_LIGHTHOUSE_MODULE` points to a
separately installed Lighthouse `core/index.js`; `G3_EVIDENCE_DIR` selects the
output directory. Then run `node admin/frontend/scripts/verify-sso-live.mjs`.
It starts/stops its disposable Keycloak when `G3_KEYCLOAK_HOME` is supplied;
its local HTTPS/CONNECT test proxy preserves the explicit hostname/RP without
editing host DNS. These test packages are not new production dependencies.
