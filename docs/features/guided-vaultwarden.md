# Guided Vaultwarden — G7

G7 adds reviewed install/connect/skip to Platform Setup. Saving records an inert
plan. Only **Apply / retry Vaultwarden verification** queues work in the existing
host runner. G1–G6 remain accepted at **60%**; G7 is submitted for review and would
make **70% (7/10)** only on acceptance. No live deployment is authorized here.

## Selected release and boundaries

The managed image is `vaultwarden/server:1.37.3`, reviewed against source commit
`eb212e23fad88e6136723f43e5b73543fa7026d3`. Existing instances must report this
release for this adapter to verify them. A different release is unverified; the
guide does not upgrade it. The [1.37.3 release](https://github.com/dani-garcia/vaultwarden/releases/tag/1.37.3)
fixes master-password changes with newer web-vault versions and introduces
`SSO_SIGNUPS_ALLOWED`. Review also covered [deployment](https://github.com/dani-garcia/vaultwarden/wiki/Using-Docker-Compose),
the [1.37.3 configuration definitions](https://github.com/dani-garcia/vaultwarden/blob/1.37.3/src/config.rs),
[OIDC and client notes](https://github.com/dani-garcia/vaultwarden/wiki/Enabling-SSO-support-using-OpenId-Connect),
and [client compatibility](https://github.com/dani-garcia/vaultwarden/wiki/Bitwarden-clients-troubleshooting).
Wiki guidance was checked on 2026-09-22; the adapter contract follows the pinned source.

| Choice | Apply behavior |
| --- | --- |
| Install | Verify the dedicated Keycloak handoff, create the owned private service, check effective configuration, render its Caddy route, and verify the public origin. |
| Connect | Read version and database health first; verify identity and effective configuration. No Docker, vault, database, account, key, Caddy or external configuration writes. |
| Skip | No installation, deletion or apply. Any existing vault remains in place. |

Managed Vaultwarden is a standalone Docker container, independent of ProxyPilot's
Compose lifecycle, with a dedicated bridge and `unless-stopped` restart policy.
Only `127.0.0.1:18380` is published from container port 80. Existing Caddy retains
public ports 80/443 and TLS, using its existing route renderer and route lock.
Optional exact IPv4 allowlisting uses that renderer. No database server is added:
the supported SQLite default lives in the persistent data bind mount.

Owned resources are shown in the review. Names use `pp-g7-<reference suffix>` and
an ownership label; files are under `/var/lib/proxypilot/vaultwarden` (0700).
`config.json`, `credentials.json` and `owner.json` are 0600. The owned config is
mounted read-only at `/etc/vaultwarden/setup.json`, selected with `CONFIG_FILE`;
`data/` is mounted at `/data`. This prevents an old `/data/config.json` from silently
becoming the managed configuration. Docker logging is disabled and managed
Vaultwarden logging is off; ProxyPilot emits phase/status details without upstream
response bodies. Independent host diagnostics remain the operator's responsibility.

## Save, then complete the dedicated Keycloak handoff

Use the verified Keycloak provider and the existing G3 read-only observer. Choose
a separate client ID (for example `proxypilot-vaultwarden`) and a non-composite
client role (for example `vault-user`). Never reuse ProxyPilot's login/observer,
recovery, Pomerium, Infisical or OpenBao clients. Verify the existing realm's
passkey RP ID, required user verification and discoverable credentials using G3;
this flow reuses that policy and enrollment.

The following actions are operator steps on an authorized **disposable** realm
for host acceptance. Production identity changes require separate authorization.
ProxyPilot itself only reads Keycloak for G7.

1. In **Clients → Create client**, select OpenID Connect and the dedicated ID.
   Enable client authentication and Standard flow. Disable implicit flow, direct
   access grants and service accounts. Disable Full scope allowed.
2. Set exactly one valid redirect URI to the callback shown by the guide:
   `https://<vault-host>/identity/connect/oidc-signin`. Set exactly one web origin
   to `https://<vault-host>`; no wildcard or additional callback. In advanced
   settings require `S256` PKCE, `RS256` ID-token signing, and a **600-second
   client access-token lifespan**. Do not change realm-wide token settings.
3. Assign `profile`, `email` and `offline_access` client scopes as default or
   optional. The vault requests all three plus `openid`. Ensure the normal
   mappings provide verified email and `preferred_username`.
4. Create the dedicated non-composite client role. Assign it only to the chosen
   users or a reviewed group. Do not make it a realm default role. Enroll the
   allowed and denied disposable users with the existing passkey mechanism;
   only the allowed user receives the role.
5. In **Authentication → Flows**, create the top-level Basic flow whose exact
   alias is shown in the guide (`pp-vaultwarden-<client-id>`). Add **WebAuthn
   Passwordless Authenticator** first and make it **REQUIRED**. Then add a Basic
   subflow and make it **CONDITIONAL**. Inside it, in order, add **Condition –
   User Role** (**REQUIRED**, role `<client-id>.<role>`, **Negate enabled**) and
   **Deny Access** (**REQUIRED**). No alternative/cookie branch bypasses this
   sequence. Bind only the dedicated client's Browser Flow override to this flow.
6. Copy the dedicated client secret from its Credentials tab into ProxyPilot's
   save form. For Connect, also enter the existing Vaultwarden administrator
   token (the login token, not its Argon2 hash). Both are encrypted under the
   existing installation key. Saving does not use them to change identity or
   start a service. Retry reuses the encrypted values; do not regenerate them.

The role condition and negation names are checked against Keycloak **26.7.4**
[factory source](https://github.com/keycloak/keycloak/blob/26.7.4/services/src/main/java/org/keycloak/authentication/authenticators/conditional/ConditionalRoleAuthenticatorFactory.java)
and [execution source](https://github.com/keycloak/keycloak/blob/26.7.4/services/src/main/java/org/keycloak/authentication/authenticators/conditional/ConditionalRoleAuthenticator.java).
The production observer verifies callbacks, grants, scopes, flow order,
`condUserRole`, `negate=true`, role existence and the accepted passkey policy.
Keep the role and flow intact: a missing role changes Keycloak's conditional
behavior. This is a point-in-time verification, not continuous drift enforcement.
Removal from the role denies a fresh SSO login; it does not erase downloaded
vaults or promise immediate revocation of an offline client.

## Effective Vaultwarden settings and account preservation

The review displays the exact saved settings. For Connect, the existing owner
updates only those values and `sso_client_secret` through their existing config
mechanism. Preserve database/data paths, `rsa_key.*`, SMTP, organization policies
and unrelated settings. Do not replace an existing config file with the guide's
partial object. Admin-persisted `CONFIG_FILE` values override environment values.
If a setting requires a service restart, the owner schedules it separately; the
Connect adapter never restarts the service.

The contract enables SSO with the verified issuer and exact callback, S256 PKCE,
the reviewed client/secret, and scopes `openid profile email offline_access`.
`sso_only`, `sso_debug_tokens`, `sso_allow_unknown_email_verification` and
`sso_auth_only_not_session` remain false. No extra authorization parameters are
added. Additional ID-token audiences must match only the escaped, anchored client
ID regex shown in the review. Do not replace it with an empty string or `.*`:
the [release's verifier](https://github.com/dani-garcia/vaultwarden/blob/1.37.3/src/sso_client.rs)
interprets an empty configured regex permissively. The exact explicit expression
also makes effective readback unambiguous.

Managed registration disables public email signup and invitations, and enables
SSO signup behind the selected Keycloak client-role policy. Connect preserves
existing signup/invitation/domain-whitelist settings; the owner must check that
they permit the intended disposable account. Existing password login remains
an independent login path for existing accounts, not a Keycloak-role gate.

Email linking is a separate saved choice, off by default. When reviewed on, first
SSO login with a matching **verified** email can associate an existing non-SSO
account. Vaultwarden records issuer/subject in `sso_users` while retaining the
existing user UUID and vault keys. Subsequent matching follows that association.
Do not delete users, replace encryption keys, rewrite emails or remove mappings
to force a match. If linking is off, a conflicting existing account is not to be
replaced. Retargeting providers, migration/import and credential rotation are
outside G7; resolve a mismatch with the existing owner.

Apply checks `/api/version` and `/alive`, then authenticates read-only to
`POST /admin/`. In 1.37.3 this returns the effective settings form, including
persisted overrides. The adapter compares only the allowlisted inputs, including
the protected client secret, then discards the HTML and private values. It never
calls admin configuration mutation endpoints. The masked diagnostics endpoint
cannot prove exact issuer/client/credential equality and is not used. A mismatch
fails with the setting name, never its private value. The owner resolves it and
explicitly retries. Configuration success alone is not a successful login test.

## Disposable browser acceptance: authentication is not unlock

Use an isolated disposable vault, two disposable identities, and harmless data.
Perform this in Vaultwarden/Keycloak directly. Do not paste master passwords,
recovery codes, passkey material or item contents into ProxyPilot. Do not capture
network traces, screenshots or logs containing those values.

1. Apply and obtain **configuration verified**. Open the bundled web vault in a
   fresh browser session. Choose **Use single sign-on**, authenticate the allowed
   disposable user with the existing Keycloak passkey, and follow the supported
   Vaultwarden account setup if it is a new account.
2. For an existing account, expect the separate **Your vault is locked** screen.
   Enter its master password directly in Vaultwarden and choose **Unlock**.
   For a new account, set its separate master password in Vaultwarden, then lock
   and unlock. A successful Keycloak passkey ceremony alone must not reveal items.
3. Create a harmless test item, read it, lock the vault and unlock it again.
   Keep the test item's value out of ProxyPilot and evidence. Retest the retained
   email/master-password login, including any Vaultwarden second factor.
4. For the reviewed email-linking case, begin with an existing disposable
   password account and harmless item. Record its UUID and a local comparison of
   encrypted key fields through the vault owner's existing read-only mechanism.
   After SSO association, confirm the same account, old item and unchanged keys;
   record only pass/fail. Never output key values or the master password.
5. In a different fresh browser profile, authenticate a disposable user without
   the selected client role. The dedicated Keycloak flow must deny the SSO login,
   with no Vaultwarden session/account creation. Use a fresh profile so an old
   Vaultwarden or Keycloak session cannot disguise the result.
6. Return to ProxyPilot and record the required observations. The API rereads
   effective Vaultwarden and Keycloak settings and requires the same saved
   configuration fingerprint. It stores boolean observations, administrator and
   time as **operator_observed**; it does not claim to have decrypted a vault.

No SSO-only switch is offered. `SSO_ONLY=false` is verified on every apply and
observation submission. Any future SSO-only activation needs a separate review
after successful verification and a supported recovery plan: an authorized owner
must retain protected config/admin access to restore password login, users must
retain their vault master password and independent second-factor recovery, and
the Keycloak owner must retain its existing device/account recovery. Resetting a
Keycloak credential cannot recover an unknown vault-unlock secret. Preserve
ProxyPilot's independent local recovery route and credentials throughout.

Use the bundled web vault for this acceptance. Desktop browser-to-app handoff,
Firefox on Windows, and Linux protocol association have documented limitations;
extension/mobile/client-version behavior requires its own verification. This
guide builds no extension/mobile integration and makes no general compatibility
promise for every Bitwarden client release.

## Durable progress, restart and retry

`vaultwarden_apply` runs only in the existing host runner. Its recorded
`configure_vaultwarden_route` child uses the existing backend drain and Caddy
route lease. Closing the browser or restarting the API does not lose the plan or
queue. Existing runner fencing/reconciliation handles interrupted jobs. The G6
runner installation-key loading correction is unchanged; loss of that key requires
restoring the matching protected ProxyPilot database/key, not generating a key.

Saved target, linking policy and credential reference are immutable in this slice.
Repeat apply reuses named, inspected resources. Ownership, image, port, mount,
environment, network, protected-file, missing SQLite and recorded server-key
checks refuse destructive repair. Creation intent is written before Docker
create/start. An uncertain create failure or a missing previously attempted
resource needs owner inspection/recovery; retry does not create a replacement
vault. Preserve the data and ownership files even after a failed job.

After restoring a matching set, use the host's existing lifecycle mechanism to
start the same named standalone container, then explicitly reapply. Ordinary
stopped owned services can be started by apply after preservation checks; the
guide never restarts an already running service. Connect restarts are always
owner actions. No live restart was executed as part of this repository work.

Health distinguishes unavailable, unhealthy and unverified release/configuration.
The UI labels a past successful configuration check as **previously verified**;
health alone does not turn it into a current SSO/unlock proof. A changed effective
configuration invalidates a new browser observation submission. Skipping does not
remove data, routes or already running services.

## Backup set and supported recovery

Use existing host backup mechanisms; G7 adds no scheduler, backup service, upgrade
or restore framework. For this managed SQLite profile, include:

| Material | Preservation requirement |
| --- | --- |
| SQLite database | Consistent online backup, or a fully stopped copy with its matching WAL if present. Never copy only a live `db.sqlite3`. |
| `data/attachments/` | Preserve attachment files along with database state. |
| `data/sends/` | Include to preserve existing file Sends; text Sends are in the database. |
| `data/rsa_key.*` | Preserve server signing keys. These are distinct from users' vault encryption keys. |
| `config.json`, `credentials.json`, `owner.json` | Preserve the matching owned configuration, protected administrator handoff and resource identity, with the same private permissions. |
| ProxyPilot DB and installation key | Preserve the encrypted client/admin references, saved plan, resource/key fingerprints and durable jobs using existing protected custody. |
| External service configuration | For Connect, include its actual effective config file/env and its existing database backup mechanism; no database conversion is performed. |

The [official backup guidance](https://github.com/dani-garcia/vaultwarden/wiki/Backing-up-your-vault)
supports the built-in `/vaultwarden backup` SQLite command in this release.
An authorized host operator can run `docker exec <owned-container> /vaultwarden backup`
and collect its database backup using the existing mechanism, coordinated with
the attachment/config/key copy. SQLite's online `.backup` is another option.
`icon_cache` is disposable; `db.sqlite3-shm` need not be restored. Encrypt and
restrict the complete backup because config and signing keys are sensitive.

Restore acceptance occurs on a separately recorded disposable host, with the
service stopped and the original set preserved. Restore the **1.37.3-compatible**
database, attachments and matching configuration/keys/ownership records. An online
database backup must not be paired with a stale WAL; a stopped raw database copy
must retain its matching WAL. Start the same service, reapply, verify old harmless
items/attachments and account identity, then repeat the browser checks. This PR
does not execute restore or claim that a backup was proven restorable.

During a Keycloak outage, retained email/master-password login and Vaultwarden's
own second factor/recovery remain available. A lost Keycloak device follows the
existing Keycloak recovery process; a lost Vaultwarden second factor follows its
supported recovery mechanism. Neither supplies an unknown master password.
An already unlocked/offline client is not evidence of new-login availability.

See [G7 execution evidence](../evidence/g7-acceptance.md) for what actually ran,
scripted boundaries and unchanged host-test exclusions.
