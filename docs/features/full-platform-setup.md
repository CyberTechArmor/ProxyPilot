# Full Platform setup

Open **Platform Setup** for the saved six-step flow. **Custom / Advanced** keeps
the individual adapters available. Existing managed installations are reused;
an external connection never authorizes changes to its runtime or realm.

1. **Domains and realm.** Choose linked parent domains and optional subdomains,
   or enter custom hostnames. ProxyPilot retains its current administrator
   hostname. Existing service names and realm are prefilled. Point each selected
   name directly at the Caddy host; saving a name does not establish DNS or TLS.
2. **Review.** Confirm the addresses and restricted administrator/VPN networks.
   Save is inert. **Apply saved setup** queues the existing independent runner.
   Keycloak, recovery/SSO checks, and dependent adapters run in dependency order.
3. **Install and connect.** Reopen this page after a reload or restart to see the
   same operation and service records. **Continue saved setup** resumes pending
   work with the saved clients, data and protected credentials. Resolve the
   reported service failure before retrying; uncertainty is not success.
4. **Administrator and recovery.** The named administrator defaults to the
   current ProxyPilot account. Enter the person's names, email and permanent
   Keycloak password. ProxyPilot creates distinct master-realm administration
   and application-realm identities. It preserves the local account, password,
   roles and sessions. Existing users are not adopted by matching email/name.
   Existing identities need the explicit identity-proof/linking path; a
   conflicting username is preserved and reported.
5. **Verify and activate.** Enroll the application identity's discoverable
   passkey in Keycloak Account Console. Prove the ProxyPilot account link,
   test SSO login and step-up, and separately test restricted local recovery.
   Return to the administrator form, supply a fresh permanent master login
   (and its OTP if configured), then **Verify administration and retire
   bootstrap**. Any failed check retains the working bootstrap path. Only after
   that handoff can the administrator explicitly activate SSO.
6. **Complete.** The server requires every selected service's verification,
   permanent administration, recovery, current Vaultwarden observations and
   active SSO. A running process or a successful coordinator job is insufficient.

**Reveal initial Keycloak password** requires an administrator, CSRF protection,
sudo and actual local authentication within five minutes. It reads the original
managed bootstrap credential; it never rotates it. The page hides it after
30 seconds, on navigation, or when the tab loses visibility. Audit records contain
only the action. After account retirement the action reports the credential as
retired. No permanent user's password is offered for reveal.

## Product-specific handoffs

- **Infisical:** choose its local human administrator credential once. This
  edition's Keycloak human SSO is not configured; `oidcSSO` entitlement is a
  separate capability. The owned basic flow creates a dedicated project,
  environment, folder, exact scoped roles and machine identities. It replaces
  and revokes the unrestricted bootstrap grant, uses a 15-minute provisioning
  grant, and retires that authentication after verified machine login. Personal
  inputs expire after 15 minutes and are removed on execution; no refresh token
  becomes a permanent automation credential. If the edition cannot supply
  scoped roles or Agent Proxy, its precise capability check remains pending.
  Interrupted secret issuance never silently creates another credential.
- **Agent Proxy:** the basic flow derives an existing private runner address and
  checks a temporary owned local destination with allowed and denied requests.
  It does not request a disposable VM. If no private address is available, setup
  pauses for host configuration; it does not create a VPN or public listener.
- **OpenBao:** supply three custodians' public PGP keys and an initial-root
  recipient key, retain/decrypt the encrypted recovery package separately,
  acknowledge custody and manually unseal with two shares. Submit the transient
  initial root token to configure owned access; successful verification revokes
  it. The basic profile verifies scoped KV reading and explicit denials, without
  a PostgreSQL fixture. Database, SSH and PKI engines remain optional and untested.
- **Vaultwarden:** the dedicated client, restricted role/group and passkey flow
  are connected automatically. Verify the email in Keycloak, then perform the
  labeled web-vault sign-in, separate unlock, harmless-item and denied-user checks.
  Enter vault secrets only in Vaultwarden. Existing password login remains
  available, and automatic email-based account linking is disabled.

## Repair and retained-data runtime actions

Expand the relevant owned service in **Install and connect** and review **Repair**,
**Reinstall** or **Remove**. Each action has its own preview, current review token,
fresh local authentication and confirmation. External services are refused.
Removal stops/removes only inspected owned container IDs. Persistent volumes,
directories, databases, keys, credentials, recovery packages, networks and Caddy
routes remain. Routes fail closed while runtime is absent. Ordinary continuation
does not undo an explicit removal. Reinstall reuses compatible retained data;
missing SQLite/key/configuration files fail before a replacement vault starts.
Active Keycloak and Pomerium dependencies block removal/reinstallation.

## Reset: start over

**Custom / Advanced → Reset Full Platform** (and the MCP tool
`reset_platform_setup`) blows the setup out so **1. Domains and realm** starts
clean. **Review reset** is inert and lists everything the reset touches: every
owned container (with its ownership label), every owned Caddy route, and every
database row it discards. The reset itself needs the same fresh local
authentication as the other runtime actions (MCP: a one-time confirmation token
bound to that exact preview, plus `mcp.destructive`). It is refused while SSO is
active (disable it from local recovery first), while Pomerium application
policies are active, or while any platform operation is queued or running.
External services are never touched: their records and runtime stay.

- **Default (data kept).** The host runner stops and removes the owned
  containers by inspected ID after checking every container's ownership label
  and data mounts — for all services before the first change. A backend step
  removes the owned route rows and re-renders their hostnames. Then the saved
  Full Platform plan, the shared service plan, the platform operations and the
  owned service records (managed Keycloak, Pomerium, Infisical, OpenBao,
  Vaultwarden, and the inactive ProxyPilot SSO record that named the owned
  Keycloak) are discarded. Data directories, volumes, networks, keys and the
  protected credential rows stay in place. A later managed install at the same
  fixed paths (Vaultwarden, OpenBao, Infisical, Pomerium) finds the retained
  ownership marker of the discarded record and refuses to adopt it; restore that
  record, or reset with data purge to reuse those paths.
- **Delete owned data too** (`purge_data`; over MCP additionally the
  `mcp.platform.purge` flag, **off by default**). The preview also lists every
  directory, volume and network. Containers are stopped first, then a backup set
  is written to `/var/lib/proxypilot/mcp-exports/platform-reset-<job id>/`,
  following the backup table in `guided-vaultwarden.md`: a tar of each owned
  directory (Vaultwarden's stopped SQLite database with any WAL, attachments,
  sends, `rsa_key.*`, `config.json`/`credentials.json`/`owner.json`), a tar of
  each owned volume (Keycloak/Infisical PostgreSQL, Redis, OpenBao Raft and
  logs), `proxypilot-records.json` (the discarded rows; protected values remain
  ciphertext under the installation key, which is not copied) and
  `manifest.json` (size and sha256 of every file). Every file is re-hashed and
  every archive listed back with tar; any mismatch stops the reset with nothing
  deleted. Only then are the owned directories, volumes, networks and protected
  credential rows removed. The OpenBao recovery-package directory is kept.

Credential rotation remains unsupported. Hostname, issuer, realm, passkey RP-ID
and approved recovery-network changes still require a separately reviewed
migration/access change (or a reset). Unsupported migrations preserve the
current working path and explain the boundary.

## Over MCP

The `platform` MCP family (`docs/features/mcp.md`) calls the same store
functions as this page. `get_platform_setup` returns the saved revision and
`review_digest`, domains, realm, services, restricted networks, the status of
steps 1–6, the current operation and service jobs, each failure's job,
`reason_code` (the phase it failed at) and plain reason, the read-only Keycloak
observer's status, and ordered `next_actions`. Each action says whether an MCP
client can do it (with the tool and arguments) or a person must, and where
(page, step, control). `save_platform_setup` is inert and CAS-guarded by
`if_revision`; `apply_platform_setup` / `continue_platform_setup` require the
reviewed `revision` and `review_digest` and `confirm: true`, and refuse while an
operation runs or when the next step needs a person. `continue_platform_setup
({ service })` retries one service adapter with its stored encrypted inputs.
`manage_platform_service` is Repair / Reinstall / Remove through the same review.

These stay on this page and have **no** MCP tool: **Reveal initial Keycloak
password**, the administrator/recovery password, the fresh permanent master
login that retires the bootstrap account, **Activate SSO**, and any secret
(client secrets, admin tokens, the Infisical personal password, PGP keys, unseal
shares, root token). They keep the fresh-local-proof requirement; an MCP key
cannot reach them.

**Observer.** Vaultwarden and OpenBao verify their dedicated client through the
existing read-only G3 observer (the `pp-<keycloak>-observer` client named by
the ProxyPilot SSO record). The Full Platform coordinator creates it in its
`connect_managed_identity` step, before any service job is queued. A service
applied before that step (for example from Custom / Advanced) fails at
`dedicated_keycloak_handoff` with "The existing read-only Keycloak observer for
this provider is required."; `get_platform_setup` reports that, and continuing
the saved setup lets the coordinator create it.

## Verification and limits

The feature has focused production-route/store/runner tests, including inert save,
fresh Keycloak dispatch, existing-service continuation, authorization/redaction,
credential reuse, failed administrator proof, bootstrap retirement and retained
Vaultwarden reinstall. Infisical provisioning uses scripted responses from the
pinned API contract, including lost secret/retirement responses. Those are not
real Infisical server acceptance.

Disposable **Keycloak 26.7.4** executed the actual coordinator and administrator
runner path: all selected clients/flows, readback, permanent-user creation,
fresh master login and retry preservation. Disposable **OpenBao 2.6.2** executed
PGP recovery, manual unseal after restart, AppRole allow/deny and OIDC mapped/denied
flows with a scripted IdP; the new basic profile also executed production
bootstrap, scoped KV use, root retirement and credential reuse after restart.
These loopback tests do not claim Caddy/public TLS, real passkey ceremonies,
Vaultwarden unlock, or whole-stack installation. Docker/Incus and a real
Infisical server were unavailable. Host acceptance remains separate.

The browser script uses the built UI and real HTTP/auth/CSRF/SQLite, including
an API-process restart. It audits 360/375/390/768/1280/1920px with the horizontal
overflow guard disabled, one content scroll owner, 44px buttons, zero axe
violations and Lighthouse accessibility 100. See `docs/evidence/fp-browser.json`.
The script produces screenshots for local inspection; the repository retains
the audit JSON and reproducible checks without publishing the image payloads.

Reproduce from `admin/backend`:

```sh
node --test src/__tests__/full-platform.test.js src/__tests__/full-platform-infisical.test.js src/__tests__/full-platform-mcp.test.js
FP_KEYCLOAK_HOME=/path/keycloak-26.7.4 FP_JAVA_HOME=/path/java21 node --test src/__tests__/full-platform-keycloak-live.test.js
G6_BAO_BINARY=/path/bao node --test src/__tests__/full-platform-openbao-live.test.js
G6_BAO_BINARY=/path/bao G6_OPENPGP_MODULE=/path/openpgp.mjs node --test src/__tests__/openbao-live.test.js
FP_BROWSER_MODULES=/path/browser-deps FP_CHROMIUM=/path/chromium FP_EVIDENCE_DIR=../../docs/evidence node scripts/full-platform-browser-check.mjs
```

Pinned contracts: [Keycloak REST](https://www.keycloak.org/docs-api/26.7.4/rest-api/index.html),
[Keycloak policy update implementation](https://github.com/keycloak/keycloak/blob/26.7.4/model/storage-private/src/main/java/org/keycloak/storage/datastore/DefaultExportImportManager.java),
[Infisical bootstrap](https://infisical.com/docs/api-reference/endpoints/admin/bootstrap-instance),
[Infisical tagged routes](https://github.com/Infisical/infisical/tree/v0.165.15/backend/src/server/routes).
