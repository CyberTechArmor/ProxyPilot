# Guided Infisical and Agent Proxy (G5)

This guide covers one disposable application-secret flow and one Agent Proxy
flow. It reuses Platform Setup, its saved plan, the independent runner, existing
jobs/leases, Caddy routes and protected credential references. It does not move
existing ProxyPilot or application credentials. Saving either form is inert;
only **Apply / retry reviewed setup** queues execution.

G5 was accepted at the now-unavailable `a436546`. The recovery branch preserves
24 packaged files unchanged and reconstructs the missing UI and guidance. See
[current recovery evidence](../evidence/g5-acceptance.md), not historical test
counts, for verification and publication status. Accepted guided progress is
50% (5/10); merge and real-host acceptance are separate.

## Supported release and capability contract

Retained pins: `infisical/infisical:v0.165.15`, `infisical/cli:0.43.133`,
`postgres:14.24-alpine`, `redis:7.4.11-alpine`. There is no version upgrade in
this recovery. The CLI runs **Infisical Agent Proxy**, not the separate
secret-rendering Infisical Agent or ProxyPilot's host agent.

Version-specific official references checked during reconstruction:

- [Infisical v0.165.15 deployment example](https://github.com/Infisical/infisical/blob/v0.165.15/docker-compose.prod.yml): separate server, PostgreSQL and Redis with persistent volumes. ProxyPilot restricts listeners and retains Caddy's public ports/certificates instead of copying the example's public port mapping.
- [Standalone proxy and authentication/isolation model](https://github.com/Infisical/infisical/blob/v0.165.15/docs/documentation/platform/agent-proxy/standalone-agent-proxy.mdx): proxy and agent identities are separate; agents authenticate with their own short-lived token and folder scope; only the proxy reads brokered values.
- [Proxied-service fields and substitution](https://github.com/Infisical/infisical/blob/v0.165.15/docs/documentation/platform/agent-proxy/proxied-services.mdx): destination patterns, header substitution and the service API.
- [Default self-hosted capabilities](https://github.com/Infisical/infisical/blob/v0.165.15/backend/src/ee/services/license/license-fns.ts): `secretsBrokering` is enabled; `rbac`, `oidcSSO` and dynamic secrets are not default entitlements. Do not assume scoped policy/audit support from a healthy HTTP response. Unsupported policy or audit capabilities block this flow with a recorded reason; never grant a broad built-in role to get past verification.
- [Pinned CLI release](https://github.com/Infisical/cli/releases/tag/v0.43.133). This slice uses static credentials only. Human Keycloak SSO is optional and edition-dependent; no human SSO activation is required for the machine flows.

## Review and save targets

1. In **Platform Setup**, choose Install, Connect existing or Skip for Infisical.
   Use a dedicated HTTPS DNS origin on port 443. Choose Agent Proxy independently;
   skipping it leaves only the application test. Skipping Infisical disables both.
2. For Agent Proxy use `http://<runner-private-IPv4>:17322`, not a public Caddy
   route. Save the reviewed platform plan. No runtime or job is created.
3. In the Infisical guide enter that existing RFC1918 host address, an existing
   running disposable Incus **VM**, and one to eight administrator/runner source
   IPv4 addresses. The managed Caddy route admits only those addresses; include
   the actual source address used by the runner's public HTTPS request. Do not
   select your ProxyPilot administration hostname or an existing application route.
4. The VM needs Python 3 and connectivity to the host's private ports 17322 and
   18086. It must have no host mounts, raw Incus settings, privileged mode or
   device passthrough. The runner validates VM type, running state, expanded
   devices and UUID, then holds its existing setup lock during delivery. No VM,
   firewall rule, network rebuild or replacement execution environment is created.
5. Connect for Agent Proxy also requires the name of the existing selected Docker
   container on this runner host. Remote proxies and generic agents are outside
   the supported profile. Save the reviewed secrets targets; they are immutable
   in G5. A different target or credential rotation requires separately reviewed
   work, not deleting state or repeatedly saving another plan.

For Install, review the additions and check the acknowledgement before applying.
The runner prepares owned services and requests the recorded backend Caddy child.
PostgreSQL and Redis have separate local volumes on a private internal bridge;
neither publishes a host port. The server publishes only `127.0.0.1:18085`.
Each container uses its own restart policy. Resource names carry the protected
reference suffix and ownership labels; foreign names, changed image/configuration
or missing keys cause refusal. No existing resources are adopted or overwritten.

An initial apply without identities may finish failed with an explicit handoff
instruction. From an allowed administrator address, open the saved HTTPS origin,
complete first-administrator registration, and perform the next section. This
is a truthful incomplete state, not installation success or an automatic retry.
Connect verifies the external Infisical server without changing its runtime,
public route, boot keys or unrelated identity settings.

## Generated administrator password (managed basic install)

Infisical's free edition has no Keycloak sign-in (`oidcSSO`, `samlSSO` and
`ldap` are paid entitlements), so the administrator signs in with a local email
and password. On the managed basic install the recommended choice is
**Platform Setup → stage D → Infisical administrator → Generate password and
create administrator** (`POST /api/setup/platform/full/infisical/administrator`
with `generate: true`; fresh local proof and sudo, audited as
`INFISICAL_PERSONAL_HANDOFF_REQUESTED` with `generated: true`, no MCP tool):

- `lib/setup-engine/infisical-admin-vault.js` generates a password (4×6
  characters, about 140 bits) and writes it with check-and-set to the OpenBao
  team area, `<prefix>-kv` → `team/infisical-administrator`, together with the
  email and the Infisical URL. It reads it back before Infisical is
  bootstrapped with it.
- ProxyPilot keeps no copy. Each read or write uses a transient root token
  generated from the automatic-custody shares, then revoked and proved revoked
  (`withTransientRoot`). This requires OpenBao with automatic custody and a
  completed bootstrap; otherwise the route refuses and the page offers only
  the chosen-password form.
- The provisioning record keeps only `passwordInOpenBao: true`. When the
  15-minute provisioning authority expires before provisioning finishes, the
  resume signs in by itself with the password read back from OpenBao. A
  chosen-password account still needs the password entered again.
- To sign in to Infisical, a member of the OpenBao group opens OpenBao (OIDC with
  the Keycloak passkey), goes to Secrets engines → `<prefix>-kv` →
  `team/infisical-administrator`, and copies the password. The "Use your
  platform" card lists these steps. After setup is verified, turn on Infisical's
  own two-factor authentication. A password changed in Infisical must be saved
  in the same OpenBao entry, or a later resume sign-in is refused with that
  explanation.

## Exact organization, project and identity handoff

Use the Infisical administrator UI at the selected origin. Preserve unrelated
organizations, projects, environments, identities, policies and secrets.

1. Create or select one dedicated test organization and Secret Management project.
   Record their UUIDs. Create environment slug **`g5`** and folder
   **`/proxypilot-g5`**. Reserve **`PP_G5_TEST_CREDENTIAL`** and, when using the
   proxy, **`PP_G5_PROXY_CREDENTIAL`**. Do not prefill these values; the runner
   creates them once and refuses a conflicting value or ownership comment.
2. Create one workload machine identity and, if proxy is selected, two distinct
   machine identities for proxy and agent. Give them organization **No Access**
   and project **No Access**, membership in this project only, and Universal Auth.
   Set access-token TTL and maximum TTL to **300 seconds**. Do not assign Admin,
   Member, Viewer, project-wide templates, wildcard grants or dynamic-secret leases.
3. Enter the organization/project UUIDs and each identity UUID, Universal Auth
   client UUID and client secret into the protected identity form. Saving does
   not contact Infisical or run a job. Secrets are cleared from the form on
   submission, encrypted on the server and never returned on reopen. Retrying
   uses these same credentials; the guide refuses rotation or duplicate identities.
4. Open **Exact policies and proxied service**. Use its actual identity IDs and
   JSON conditions in the project's supported role/additional-privilege controls.
   The required effective permissions are exactly:

| Identity | Permissions | Scope |
| --- | --- | --- |
| Workload | Secrets `create`, `describeSecret`, `readValue`; identity `read` for permission auditing | `environment: g5`, `secretPath: /proxypilot-g5`, and only the selected test secret names; identity read only for the displayed identity-ID list |
| Proxy | Secrets `describeSecret`, `readValue`; proxied-services `report-usage` | Secret reads only for `PP_G5_PROXY_CREDENTIAL` in the test environment/folder; reporting in that folder |
| Agent | Proxied-services `proxy` | Only the test environment/folder; **no secret-value reads** |

When proxy is skipped, only the workload identity and application secret are
allowed. The review JSON is authoritative for conditions and action names.
Effective-permission auditing includes inherited/group/folder permissions and
rejects extra, inverted, field-specific or broader grants. If the selected edition
cannot provide these exact policies or audit them, stop and report the unavailable
capability; the guide must remain unverified.

5. For Agent Proxy, in the `g5` environment and `/proxypilot-g5` folder, choose
   the **Add Secret** dropdown → **Add Proxied Service**. Create the single
   displayed service with the following fields (also available via the selected
   release's documented `POST /api/v1/proxied-services` API):

| Field | Exact value |
| --- | --- |
| Name / enabled | `proxypilot-g5-test` / true |
| Host pattern | `<reviewed-private-IPv4>:18086/g5/allowed` (no scheme or wildcard) |
| Credential role | `credential-substitution` |
| Secret key | `PP_G5_PROXY_CREDENTIAL` |
| Placeholder environment key | `PP_G5_CREDENTIAL` |
| Placeholder value | `pp-g5-placeholder-not-a-credential` |
| Substitution surfaces | `header` only |

Do not add a header rewrite, imported secret, dynamic secret or another service
in this dedicated folder. If the UI requires the secret to exist before selecting
it, apply after completing identities/policies: the runner creates the two test
secrets, then reports the missing proxied-service handoff. Add that service and
retry; the existing secret values are preserved.

Verification uses the release's Universal Auth endpoint; organization details;
project listing/details; identity permission audits with `includeFolderPermissions=true`;
`/api/v4/secrets` with imports/reference expansion disabled; and the proxied-service
listing. Token identity, project/organization membership, environment, effective
permissions and exact service fields are checked. No organization or identity is
silently created by the runner. An upstream denial/error body never becomes job
evidence.

## Agent Proxy lifecycle and external connection

Install creates an owned dedicated bridge, named state volume mounted at
`/root/.infisical`, and `infisical/cli:0.43.133` container. Its only published
port is the reviewed private IPv4's 17322, restart policy is `unless-stopped`,
and Docker logging is disabled. Command:

```text
secrets agent-proxy start --unmatched-host=block --poll-interval=30 --telemetry=false
```

The protected `/var/lib/proxypilot/infisical/agent-proxy.env` contains only the
proxy Universal Auth client ID/secret, Infisical origin and disabled update check.
The agent never mounts or receives this file, the host protected directory or
the proxy state volume.

For Connect, the guide shows the selected container and prepares the protected
environment reference during apply. An authorized operator must configure that
selected disposable proxy through the host console using the above pinned image,
command, environment file, private port and restart/logging settings. Keep its
existing dedicated bridge and named local state volume. The bridge must not be
the default bridge, host networking, internal-only, shared with another container,
or use custom driver options. Do not add extra mounts, networks, environment
overrides, capabilities, devices or host PID/IPC namespaces. Preserve any unrelated
container rather than repurposing it. Start the selected proxy yourself if stopped;
Connect performs read-only inspection and never renames, recreates or restarts it.
The pinned image ID, inherited environment, entrypoint and command must match.

The isolation boundary is the separate existing Incus VM versus the trusted
host/proxy. The test sends the agent's short-lived token and folder scope using
the release's proxy-authentication protocol. It sends only the placeholder as
the destination credential. The proxy fetches the real value with its own identity.
The temporary private destination validates it and returns no value. The consumer
uses a different disposable secret through the existing runner's stdin delivery;
it leaves no persistent guest file or credential on argv. The destination closes
after verification, including failure.

The flow checks allowed requests, unauthenticated/agent secret-read refusal, no
proxy authentication, invalid token, wrong folder and an unmatched destination.
The pinned plain-HTTP CLI path returns 407 for no authentication, 502 for invalid
token/wrong scope and 403 for unmatched destination; generic documentation's 403
description is not substituted for this executable behavior. Evidence contains
references, status and receipts only. This bounded HTTP test is not validation of
general HTTPS interception, arbitrary agents or external production destinations.

## Retry, restart and backup references

Apply records an `infisical_apply` job, bound to the saved revision and review
token. Managed routing uses `configure_infisical_route` through the existing backend
drain and app/route locks. A pending recorded child remains pending; the browser
may close and the API/runner may restart. Explicit retry creates a related job and
reuses the same resource and credential references. The test VM UUID remains bound
across retries. Changed targets, conflicting resources, failed probes or unavailable
capabilities never get a verified label. The success record is configuration-bound
evidence at a time, not continuous service monitoring.

Use the existing encrypted backup mechanisms; G5 adds no upgrade/restore engine.
Keep these artifacts as one matching restore set:

- ProxyPilot configuration backup (`packConfigTier`): SQLite, including
  `setup_infisical`, `setup_infisical_credentials` and job/lock tables; installation
  environment including its matching `TOTP_ENCRYPTION_KEY`; Caddy configuration
  and certificate references through the existing backup tier.
- A protected PostgreSQL-consistent backup of the recorded Infisical database
  volume and corresponding Redis persistence. Do not copy a live PostgreSQL data
  directory and call it a consistent backup. Preserve service versions and volume
  identities with the set. For Connect follow that installation's existing data
  backup procedure; ProxyPilot does not copy or replace its external boot keys.
- Companion encrypted file pack for `/var/lib/proxypilot/infisical` using existing
  `collectDirAsEntries(root, 'infisical')` and `pack({entries, passphrase, meta})`
  in `admin/backend/src/lib/backup-pack.js`. Keep passphrases off argv/logs. Verify
  the manifest includes `infisical/protected.json`, `database.env`, `server.env`
  and, when created, `agent-proxy.env`. The ordinary configuration pack does **not**
  automatically include this directory or service volumes. Collection can skip
  unreadable files, so check the manifest, not merely pack completion.
- The Agent Proxy named state volume and selected container configuration.
  Proxy CA roots are stored encrypted by Infisical; do not separate its database
  from its encryption material. In-memory proxy caches are not backup artifacts.

The host directory is owner-only (0700), files 0600, owned by the runner account
(root on a normal host). Restore compatible data/configuration/keys together using
existing service procedures, then revalidate the saved operation. A missing,
unreadable or mismatching protected key set requires restoring it; retry must not
mint replacement encryption keys. Never reset state to bypass that refusal.

Full-stack installation, real effective-policy enforcement, VM isolation and
Caddy execution remain a separate disposable-host acceptance exercise. G4's real
Pomerium–Keycloak allowed/denied login remains separate too. No G6 or live deployment
is part of this recovery.
