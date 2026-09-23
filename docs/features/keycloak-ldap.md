# Quick LDAP Link (Keycloak directory federation)

Platform Setup → **Use your platform** → **Connect a directory (LDAP)** links an LDAP or Active Directory directory to the managed Keycloak realm as a Keycloak *User Federation* provider. After that, everything that signs in through Keycloak (ProxyPilot SSO, sites protected by Pomerium, Vaultwarden, OpenBao) accepts directory users. Being able to sign in does not grant access by itself: each service's own rules and groups still decide.

## What it sets up

- One LDAP provider in the platform realm, **always read-only** (`editMode READ_ONLY`): Keycloak never writes to the directory. Users are imported into Keycloak (`importEnabled`), new Keycloak users are never written back (`syncRegistrations false`), directory e-mail addresses are not trusted as verified (`trustEmail false`), paged searches are on, and the search covers the users location and everything below it.
- Optionally one **group mapper** (`group-ldap-mapper`, read-only, `LOAD_GROUPS_BY_MEMBER_ATTRIBUTE`, membership attribute `member`, type DN): the members of the named directory group (looked up by `cn` under the groups location) are placed in a Keycloak group of the same name. That Keycloak group is what you use in the platform services' group rules.
- A full user sync right after saving; the added/updated/failed counts are shown on the card. Users who were not imported yet are also imported the first time they sign in. A very large directory can take longer than one request: the card then says the result was not reported, and Keycloak finishes the sync on its own.

Defaults: Active Directory uses `sAMAccountName` / `cn` / `objectGUID` and the object classes `person, organizationalPerson, user`; other directories use `uid` / `uid` / `entryUUID` and `inetOrgPerson, organizationalPerson`. The directory type and the username, RDN and UUID attributes can only be changed by removing the link and connecting again, because Keycloak builds its attribute mappers from them once, when the link is created.

## Prerequisites

- Stage B finished: the permanent Keycloak administrator exists and the bootstrap account is retired. ProxyPilot holds no Keycloak write credential, so every change asks for **your Keycloak administrator password** (and one-time code, if you use one). It is used for one sign-in by the runner job, which signs out afterwards and deletes ProxyPilot's copy. Entering it needs a local ProxyPilot sign-in (not an SSO session), the same as the other password steps, and there is no MCP tool for it.
- A read-only **service account** in the directory (bind DN + password). Keycloak stores this password in its provider configuration (it reads back masked). ProxyPilot keeps its own copy only until the job ends, whether the job succeeded or failed.
- **Network reachability from the Keycloak container** to the directory (usually TCP 636 for `ldaps://`, 389 for `ldap://` + StartTLS). Keycloak connects, not ProxyPilot.
- **Encryption is required**: `ldaps://`, or `ldap://` with StartTLS. Plain `ldap://` is refused.
- **Certificate trust**: Keycloak must trust the directory's TLS certificate (for a private AD CA, add that CA to Keycloak's truststore). If it does not, the connection test fails and nothing is saved.

## How it runs

Saving queues a `keycloak_ldap` runner job (params: revision and operation only). The job signs in as the permanent administrator and runs Keycloak's `testConnection`, then `testAuthentication`. A failure names the step that failed, and nothing is saved. Then it creates or updates the provider, the optional group mapper and the sync. The card polls the status while the job runs.

ProxyPilot records the component id it created and only ever changes or removes **that** provider. An LDAP provider with the same name that ProxyPilot did not create is refused, not adopted. Other federation providers are left alone.

API: `GET/POST /api/setup/platform/full/ldap`, `POST /api/setup/platform/full/ldap/remove`. Code: `lib/setup-engine/keycloak-ldap.js`, table `setup_keycloak_ldap` (migration 1010), UI `components/KeycloakLdapLink.jsx`.

## Removing the link

**Remove directory link** (administrator password again) deletes only the ProxyPilot-created provider. Keycloak removes it **together with every user it imported**, and those people can no longer sign in. The directory is not changed. Accounts created in Keycloak by hand are not touched, and neither are other providers. A Keycloak group created from the directory may remain without its directory members.
