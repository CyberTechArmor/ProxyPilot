# Full Platform setup

**Platform Setup** has one path: Keycloak, Pomerium, Infisical, OpenBao and
Vaultwarden are installed and managed as one system. The former Custom /
Advanced experience and the per-service install/connect/skip choices were
removed (dashboard and MCP). Existing managed installations are reused; a
saved external connection is refused with a reason.

The setup runs in stages. Each is actionable only when the one before it is
verified: the coordinator refuses to queue a later stage early, every
per-service entry point (`applyService`, the service routers' `/apply`, the
overview retry and MCP `continue_platform_setup` with `service`) refuses with
`STAGE_LOCKED`, and the page shows later stages locked with the reason. A
failed stage names the failing service and its reason. One coordinator job
(apply or **Continue**) works on one stage and ends when that stage is
verified; the next continue starts the next stage.

- **A. Domains, realm and networks → review.** Choose linked parent domains
  and optional subdomains, or enter custom hostnames. ProxyPilot retains its
  current administrator hostname. Add any **additional addresses** (below).
  Save is inert. **Apply** completes A and queues stage B only.
- **B. Keycloak.** Install and verify Keycloak, the managed identity (all
  service clients are created here from inert service records — nothing else is
  installed), the SSO record and the restricted recovery route. Then the
  person: reveal the bootstrap password → create the permanent administrator
  (names, email, permanent password) and enroll a passkey → link the ProxyPilot
  account → SSO login test, step-up test, separate-browser recovery check →
  **Verify administration and retire bootstrap**. Any failed check retains the
  working bootstrap path. Stage C unlocks only after the retirement.
- **C. Pomerium.**
- **D. Infisical, OpenBao, Vaultwarden**, each with its human steps (Infisical
  personal administrator, OpenBao recovery custody — by default the one-time
  recovery kit download — Vaultwarden sign-in/unlock observations). Stage D is
  not done while an automatic-custody recovery kit is still unacknowledged.
- **E. Verify everything → Activate SSO → Complete.** The server requires every
  service's verification, permanent administration, recovery, current
  Vaultwarden observations and active SSO. A running process or a successful
  coordinator job is insufficient.

Stages are computed (`stagesFrom` in `full-platform-store.js`), never stored:
`fullPlatformState(db).stages` / `.stage`, MCP `get_platform_setup.stages` /
`current_stage`.

## Restricted networks

The allowlist for local recovery and every restricted service route is
**(ProxyPilot's built-in VPN networks) ∪ (additional addresses)**.

- VPN networks are derived from the VPN configuration (`vpn_config.cidr` in the
  host CLI database, read through `proxypilot --json vpn status`), recorded in
  `app_settings` (`platform.vpn_networks`), always present and not editable.
  They are re-read at boot, every five minutes and after the VPN
  enable/disable routes (`lib/platform-vpn-sync.js`); when they change, the
  `update_platform_networks` step is queued by the system (audit
  `PLATFORM_VPN_NETWORKS_FOLLOWED`) and every restricted route follows.
- Additional addresses are the operator's list (`additionalNetworks` in the
  saved plan). Before apply they are part of stage A; after apply they are
  edited at any time — **including after SSO is active** — in **Restricted
  networks** (VPN rows locked, extras add/remove), with a review, fresh local
  step-up (local password + TOTP or local passkey) and an audit record
  (`FULL_PLATFORM_NETWORKS_CHANGE`). The change is live when its Caddy step
  finishes. `/0` and an empty effective list are refused.
- **Reaching them over the VPN.** VPN peers tunnel only `10.100.0.0/24`, so a
  platform hostname resolved through public DNS is reached outside the tunnel
  and Caddy sees the client's public address — being connected to the VPN
  alone never satisfied the allowlist. The **VPN resolver**
  (`proxypilot-vpn-dns.service`, `cli/src/core/vpn/dns.js`, bound to
  `10.100.0.1:53` udp+tcp only) answers the Full Platform hostnames and the
  operator's **extra domains** (exact or `*.suffix`) with `10.100.0.1`, returns
  no AAAA for them, and forwards every other query to the host's resolvers.
  Peer configs issued now carry `DNS = 10.100.0.1`; add that line under
  `[Interface]` in configs issued earlier. The firewall admits port 53 to
  `10.100.0.1` from the VPN subnet only. The names are pushed from the
  backend with `proxypilot --json vpn dns set` (boot, every five minutes, after
  a plan save, a network change or an edit) and shown in **Reached through the
  VPN** (platform names locked, extra domains editable with sudo + audit
  `PLATFORM_VPN_DNS_CHANGED`) and in `get_platform_setup.vpn_dns`. A platform
  hostname whose route admits only non-VPN addresses is left out (sending it
  through the tunnel would lock VPN users out) and listed with the reason.
  Host: `proxypilot vpn dns status`.
- The networks are not part of the SSO fingerprint: the change rewrites the
  SSO record's list and the recovery route together in place, and SSO
  verification and activation stand.

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
  environment, folder and machine identities. The self-hosted free edition
  refuses custom project roles (licence `rbac: false`), so the identities hold
  Infisical's BUILT-IN project roles in that dedicated project: broker →
  Viewer, test workload → Member, agent → Admin (the only built-in role with
  `proxied-services: proxy`). Consequence, shown as a banner on the service and
  as `risk` over MCP: an agent identity can read the project's real credentials
  directly, not only through the proxy. Keep the project for brokered
  credentials only, limit each proxied service to the agent's sites, and broker
  agent-specific accounts. Enterprise custom roles remove the trade-off
  (`BUILTIN_ROLES` / `AGENT_ROLE_RISK` in `infisical-logic.js`). It replaces
  and revokes the unrestricted bootstrap grant, uses a 15-minute provisioning
  grant, and retires that authentication after verified machine login. Personal
  inputs expire after 15 minutes and are removed on execution; no refresh token
  becomes a permanent automation credential.
  Interrupted secret issuance never silently creates another credential.
- **Agent Proxy:** the basic flow derives an existing private runner address and
  checks a temporary owned local destination with allowed and denied requests.
  It does not request a disposable VM. If no private address is available, setup
  pauses for host configuration; it does not create a VPN or public listener.
- **OpenBao — team workspace (basic profile).** People in the OpenBao group sign
  in through Keycloak (OIDC, mount `pp-g6-<ref12>-oidc`, role `mapped`; the
  dashboard's *Use your platform* card shows the steps) and get an 8-hour
  token with the workspace policy (`humanPolicyFor`): create, read, update and
  delete under `pp-g6-<ref12>-kv/team/`, plus what the web UI needs to list the
  engine. The machine AppRole policy is unchanged. An install made before the
  workspace existed is upgraded on its next apply (`upgradeHumanAccess`): only
  when the live human policy and role are exactly the earlier ProxyPilot
  rendering (`priorHumanFor`), ProxyPilot generates a transient root token from
  the 2 automatic-custody shares it already holds (`withTransientRoot`,
  generate-root with a one-time pad), writes the two values, revokes the token
  and proves the revocation. Any other difference is refused as drift, and a
  root generation somebody else started is never cancelled. PGP custody: the
  job asks for a transient root token through the bootstrap action instead.
- **OpenBao — recovery custody.** Two choices under *OpenBao recovery custody*:
  - **Set up OpenBao automatically (default).** `POST /full/openbao/recovery`
    with `{ revision, custody: 'auto', reviewed: true }` (no keys) saves
    `custody: 'auto'` and continues the setup job. ProxyPilot initializes
    OpenBao once (3 shares, threshold 2, no PGP) and in the same transaction
    stores, encrypted with the installation key in `setup_openbao_credentials`,
    an **auto-unseal record** (`<ref>:unseal`, 2 of the 3 shares, kept) and a
    **one-time kit record** (`<ref>:kit`: receipt, all 3 shares, the initial
    root token). Nothing secret reaches a plan, job, event, audit row or the
    host recovery directory. The job then unseals with the 2 stored shares,
    configures owned access with the root token (the same `bootstrap` as the
    manual path), **revokes the root token and removes it from the kit
    record**, and verifies. **Download recovery kit (one time)** —
    `GET /full/openbao/recovery-kit`, fresh sudo + fresh local proof, audited
    `OPENBAO_RECOVERY_KIT_DOWNLOADED` without contents, `no-store` attachment —
    saves the kit as JSON and acknowledges its receipt automatically
    (`PUT /openbao/handoff`); acknowledgement deletes the kit record, so a
    second download returns 410. Store the file offline (print it, or keep it
    in Vaultwarden). After a restart the job and a backend sweep (`index.js`,
    30 s after boot then every 2 minutes, only once the kit is acknowledged
    and no OpenBao operation is pending) unseal OpenBao with the stored shares.
    Trade-off: someone with full control of this server (database + installation
    key) can unlock OpenBao. Recovery without ProxyPilot: unseal with 2 kit
    shares, then `bao operator generate-root` with 2 shares.
  - **Advanced: use your own PGP custodians** (unchanged). Supply three
    custodians' public PGP keys and an initial-root recipient key,
    retain/decrypt the encrypted recovery package separately, acknowledge
    custody and manually unseal with two shares. Submit the transient initial
    root token to configure owned access; successful verification revokes it.

  The basic profile verifies scoped KV reading and explicit denials, without
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

**Platform Setup → Reset Full Platform** (and the MCP tool
`reset_platform_setup`) blows the setup out so **A. Domains, realm and networks** starts
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
  Keycloak) are discarded. Nothing is deleted: the fixed-path service
  directories (Pomerium, Infisical, OpenBao, Vaultwarden) are **moved aside** to
  `<directory>.retained-<YYYYMMDD>-<reset job>` next to the original, so a later
  managed install starts clean instead of refusing on the discarded record's
  ownership marker (the preview lists each move). Keycloak's per-installation
  directory, the Docker volumes (Infisical/OpenBao volume names are per
  installation, so a new install uses new ones), networks, keys and the
  protected credential rows stay where they are. To reuse retained data, move a
  directory back before reinstalling from a restored record.
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
  credential rows removed, including the OpenBao automatic-custody records
  (`<ref>:unseal`, `<ref>:kit`); a data-kept reset keeps them with the other
  protected credentials. The OpenBao recovery-package directory is kept.

Credential rotation remains unsupported. Hostname, issuer, realm and passkey
RP-ID changes still require a separately reviewed migration (or a reset). The
approved recovery networks change through **Platform overview → Restricted
networks** (below), not by saving the plan. Unsupported migrations preserve the
current working path and explain the boundary.

## Platform overview

The top of the Platform section is the **Platform MCP access** switch, then the
**Platform overview**: one row per service (Keycloak, Pomerium, Infisical,
OpenBao, Vaultwarden) plus the ProxyPilot recovery route. One endpoint
(`GET /api/setup/platform/overview`, `lib/setup-engine/platform-overview.js`)
builds the whole view from the same functions the MCP tools use; it never
returns a secret, credential or protected reference. Refresh button, plus an
automatic refresh every 30 s while the page is visible; docker inspect, the
listening ports and DNS are cached for 15 s; logs load only when opened.

Per row: the service URL; ownership (managed / external / not selected); health
per owned container from the same `docker inspect` as `get_platform_service`
(running state, health, exit code and `State.Error` when stopped, expected but
missing containers, log driver) and the verification state and time (current or
previously verified, plus the last live check); the route's loopback upstream
and whether it is listening — a recorded route whose upstream nothing listens on
is **broken** even when every present container runs; the route's hostname,
restricted networks and whether it exists yet; DNS from the host resolver and
from 1.1.1.1 against the Caddy host, whether they agree, and whether the zone is
on the stored Cloudflare token (else the exact record to set at the external DNS
host); the last job with status, phase, reason and reason code, linking to its
job log; and the effective MCP access (`mcp.platform`, `mcp.destructive`,
`mcp.platform.purge`) with the callable tools.

**Service panel** (a full-screen sheet on phones). Every action is admin-only,
audited, calls the same backend function as its MCP tool, and is disabled with
its reason while an operation runs or a precondition fails:

- **Start / Stop / Restart** one owned container, by inspected ID after its
  ownership label is checked; a short preview first (the token binds the
  container ID). Stop/restart are refused while the service has active
  dependents (Keycloak: SSO/recovery and the services connected to it; Pomerium:
  saved application policies). Start waits for running and then the image's
  healthcheck.
- **Retry this service's adapter** — the per-service continue with its stored
  encrypted inputs; disabled while its hostname fails the DNS check (the reason
  names both resolver answers and the expected address).
- **Re-run verification only** — runtime, upstream, DNS, and a probe through the
  local Caddy with SNI/Host pinned (the adapter self-check path); recorded as the
  last live check; nothing is reapplied.
- **Repair / Reinstall / Remove** — the existing review. Repair also recreates,
  by inspected ID with data retained, any owned container still on a log driver
  other than `local`, so its logs become readable.
- **View logs** — last 50 / 200 redacted lines per container (`docker logs`, or
  `journalctl CONTAINER_NAME=…` for journald); a container whose logs cannot be
  read says why.
- **Re-run preflight** for the service's hostname and ports.
- **Recover bootstrap administrator** (Keycloak only) — see below.

Section actions: **Restricted networks** (VPN rows locked, additional
addresses editable; a reviewed change: preview listing every route and record
with before → after, one-time token/fresh local proof, then a backend step
rewrites exactly those rows and re-renders; `/0` and an empty effective list
are refused; allowed while SSO is active — see *Restricted networks* above) and
**Resync shared plan** (when the shared plan changed after this Full Platform revision:
a new Full Platform revision from the saved values; the next continue writes
the shared plan again — no reset needed).

Kept out of the overview, with links: secret inputs stay in their Platform Setup
forms, SSO activation in stage E, reset (data kept or purge) in Platform
Setup → Reset Full Platform behind its own preview, DNS edits in the DNS tools (or at the external
DNS host).

**Routes page.** Owned platform routes are listed read-only, labelled with
their service and linking to its panel. Creating or editing a route on any
hostname in the saved Full Platform plan (dashboard, `set_route`,
`set_route_path`) is refused: the service adapter creates that route, and a
hand-made one would block it.

## Runtime behaviour (2026-09-23 fixes)

- **Infisical published port.** Docker publishes no port for a container
  whose every network is `--internal`. The Infisical server's primary network
  is therefore a second owned bridge, `pp-if-<ref>-edge-net` (non-internal, IP
  masquerade off, the server only), and it joins the internal data network for
  db/redis, which stay internal-only. A server left by the internal-only
  profile holds no data and is recreated by a plain retry. Reset lists the edge
  network; `get_platform_service` lists each owned network and each
  container's networks. The Agent Proxy reads **pending — created after
  bootstrap** until the bootstrap handoff creates it.
- **Masked adapter errors.** When an adapter throws something other than its
  own safe failure, the job reason stays generic and an `adapter_error` job
  event records the error class, the phase, and — for local errors only
  (TypeError, fs/system errors) — one redacted message line.
- **Image defaults.** Newer Docker omits empty image `Config` fields; container
  inspect reports `null`/`""`. The runtimes compare `Cmd`/`Entrypoint`/`User`
  through `sameArgv`/`sameUser` (owned-runtime.js). Vaultwarden (no image
  `CMD`) failed here with a `TypeError` between `docker create` and `docker
  start`; a retry now starts the created container without a reset.

- **Logs.** Owned containers are created with `--log-driver local --log-opt
  max-size=10m --log-opt max-file=3` whatever the daemon default is (they used
  to be created with `none`, which `docker logs` cannot read). Repair migrates
  existing ones.
- **Start.** Every adapter starts its containers by inspected ID and waits for
  running, then healthy (image `HEALTHCHECK`, bounded). A failure records a
  reason code — `image_pull`, `port_bind`, `mount_permission`, `start_timeout`,
  `health_timeout`, `exited:<code>` — with `State.Error` and the last redacted
  log lines in the job events. A container already running and healthy on a
  retry is continued from, never recreated. A local cause is never reported as
  "upstream details withheld".
- **Self-checks behind restricted routes.** An owned Infisical/OpenBao/
  Vaultwarden instance is checked through the local Caddy (`127.0.0.1`,
  override `PROXYPILOT_LOCAL_EDGE`) with TLS SNI and Host kept as the service
  hostname — the host's own hostname would hairpin through the firewall and
  arrive from its LAN address. The restricted matcher of an owned platform
  route admits the loopback source only together with the installation's
  self-check header; the firewall's LAN address and the host's public address
  are never added to the allowlist.
- **Upstreams.** Before its bootstrap check an adapter proves its route's
  upstream is listening (`upstream_not_listening` otherwise). Infisical's
  route targets the server's published port 18085; the Agent Proxy listens on
  the private runner address (:17322) and is created after bootstrap.
- **DNS.** The coordinator does not queue a service whose hostname fails the DNS
  check, and a per-service retry is refused, with a reason naming the hostname,
  both resolver answers, the expected address, a disagreement between them
  (cache or local override), and where the record is changed (`set_dns_record`
  on the stored Cloudflare token, or the exact record at the external DNS host).
- **Keycloak bootstrap recovery.** When `connect_managed_identity` finds the
  bootstrap administrator cannot authenticate, **Recover bootstrap
  administrator** (MCP `recover_keycloak_bootstrap`) runs Keycloak 26's
  `kc.sh bootstrap-admin user` inside the owned server container
  (`--optimized`, falling back to a plain run) with a ProxyPilot-generated
  credential that is stored encrypted before use, passed only through a 0600
  env file deleted right after, and verified with a token grant; the saved
  setup then continues in the same job. Retiring the bootstrap (stage B) removes
  both temporary accounts. No purge is needed.

## Over MCP

The `platform` MCP family (`docs/features/mcp.md`) calls the same store
functions as this page. `get_platform_setup` returns the saved revision and
`review_digest`, domains, realm, `vpn_networks` (derived), `additional_networks`,
`restricted_networks` (their union), `current_stage` and `stages` (done /
current / running / failed with `failing` / locked with `locked_reason`), the
current operation and service jobs, each failure's job,
`reason_code` (the phase it failed at) and plain reason, the read-only Keycloak
observer's status, and ordered `next_actions` — for the current stage only. Each action says whether an MCP
client can do it (with the tool and arguments) or a person must, and where
(page, step, control). `save_platform_setup` is inert and CAS-guarded by
`if_revision`; `apply_platform_setup` / `continue_platform_setup` require the
reviewed `revision` and `review_digest` and `confirm: true`, advance ONE stage
per job, and refuse while an operation runs, when the next step needs a person,
and in stage E. `save_platform_setup` takes `domains`, `realm` and
`additional_networks`; `services`, `experience` and `restricted_networks` are
refused (`ONE_PATH`, `NETWORKS_DERIVED`). `set_platform_restricted_networks`
takes `additional_networks`. `continue_platform_setup
({ service })` retries one service adapter with its stored encrypted inputs.
`manage_platform_service` is Repair / Reinstall / Remove through the same review.
The overview's actions have tools too: `control_platform_container`,
`verify_platform_service`, `get_platform_service_logs`,
`set_platform_restricted_networks`, `resync_platform_plan`,
`recover_keycloak_bootstrap`.

**The `mcp.platform` master flag** gates every tool of the family, the readers
included: off, each refuses before any work (no DB read, no docker inspect, no
job) and names where a person turns it on. It is **human-only**:
`set_feature_flag` refuses to change it in either direction; only an
administrator flips it, with the switch at the top of this section, and each
change is audited (who, old, new, when; `FEATURE_FLAG_CHANGED`) and exported by
`export_grc_evidence` (`feature_flag_changes`). Turning it off cancels nothing
already queued or running on the host runner; dashboard actions are never gated
by it. `mcp.destructive` and `mcp.platform.purge` only take effect behind it.
Off on new installs; installs that existed before it were migrated on
(migration 915).

These stay on this page and have **no** MCP tool: **Reveal initial Keycloak
password**, the administrator/recovery password, the fresh permanent master
login that retires the bootstrap account, **Activate SSO**, and any secret
(client secrets, admin tokens, the Infisical personal password, PGP keys, unseal
shares, root token), and the OpenBao recovery-kit download. They keep the fresh-local-proof requirement; an MCP key
cannot reach them.

**Observer.** Vaultwarden and OpenBao verify their dedicated client through the
existing read-only G3 observer (the `pp-<keycloak>-observer` client named by
the ProxyPilot SSO record). The Full Platform coordinator creates it in its
`connect_managed_identity` step, before any service job is queued. A service
applied before that step fails at
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
