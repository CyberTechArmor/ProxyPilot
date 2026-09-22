# Guided OpenBao (G6)

G6 adds the OpenBao section to **Platform Setup**, using its saved plan,
independent host runner, existing jobs/leases, protected credential references
and Caddy route renderer. G6 is accepted at corrected head `6e48d89` in PR #618;
accepted guided progress is **60% (6/10)**. Host acceptance remains separate.
This guide does not authorize a production change.

## Release contract

Managed image: **`openbao/openbao:2.6.2`**, independently started and persisted;
not a development server. Checked against the official `v2.6.2` source at
`dd9c19c37a878cf4a81b18efb8d6f0599c7da923`, including its shipped deployment and
API documentation. The [release](https://github.com/openbao/openbao/releases/tag/v2.6.2)
was published with security fixes; connecting this slice checks the same exact
version. This is a version pin, not a new upgrade mechanism.

Version-specific official sources inspected before selecting the pin:

- [Container deployment and installation](https://github.com/openbao/openbao/blob/v2.6.2/website/content/docs/install.mdx),
  [image entrypoint](https://github.com/openbao/openbao/blob/v2.6.2/scripts/docker/docker-entrypoint.sh).
- [Integrated Raft storage](https://github.com/openbao/openbao/blob/v2.6.2/website/content/docs/configuration/storage/raft.mdx),
  [initialization and PGP recipients](https://github.com/openbao/openbao/blob/v2.6.2/website/content/docs/api/system/init.mdx),
  [manual unseal](https://github.com/openbao/openbao/blob/v2.6.2/website/content/docs/api/system/unseal.mdx),
  [seal status](https://github.com/openbao/openbao/blob/v2.6.2/website/content/docs/api/system/seal-status.mdx),
  [health](https://github.com/openbao/openbao/blob/v2.6.2/website/content/docs/api/system/health.mdx).
- [Keycloak OIDC guide](https://github.com/openbao/openbao/blob/v2.6.2/website/content/docs/auth/jwt/oidc-providers/keycloak.mdx),
  [OIDC role API](https://github.com/openbao/openbao/blob/v2.6.2/website/content/docs/api/auth/jwt.mdx),
  [AppRole API](https://github.com/openbao/openbao/blob/v2.6.2/website/content/docs/api/auth/approle.mdx).
- [PostgreSQL engine](https://github.com/openbao/openbao/blob/v2.6.2/website/content/docs/secrets/databases/postgresql.mdx),
  [database API](https://github.com/openbao/openbao/blob/v2.6.2/website/content/docs/api/secret/databases/index.mdx),
  [token revocation](https://github.com/openbao/openbao/blob/v2.6.2/website/content/docs/api/auth/token.mdx).

The Keycloak guide contains broad sample redirects/admin policies. G6 uses only
its displayed exact UI callback and a limited database-reader policy; it does
not copy those broad examples. The existing G3 observer reads the dedicated
client. It does not change Keycloak or reuse ProxyPilot/Pomerium clients.

## Operator sequence

1. Choose **Install**, **Connect existing** or **Skip** in the platform plan,
   enter a dedicated HTTPS origin and save. Saving any G6 form creates no host
   resource and sends no OpenBao mutation. Skip prevents further execution and
   preserves an existing installation.
2. Review and save the dedicated Keycloak client ID/credential, one full-path
   allowed group, operator and runner/API egress IPv4 allowlist, and one explicitly selected
   disposable PostgreSQL target. The database name must start with `pp_g6_`;
   its address is RFC1918, with verified TLS covering that IP. Use a dedicated
   non-superuser database account with CREATEROLE. Leave the optional public CA
   bundle empty for system trust, or provide PEM CA certificates (never private
   keys). Managed apply mounts that reviewed public bundle read-only; for an
   external instance, its owner supplies the same bundle at
   `/openbao/config/postgres-ca.pem` before bootstrap. ProxyPilot never writes
   an external runtime file. Both consumers verify the chain and private IP;
   no TLS-verification bypass is provided.
3. For **Install**, supply three distinct custodians' base64 binary PGP public
   keys and the initial root-token recipient's public key. Keep all private
   keys elsewhere. For example, export a public key with
   `gpg --export <recipient-fingerprint> | base64 -w0`. Review the 2-of-3 manual
   unseal requirement and acknowledge initialization in the form. The additional
   explicit **Apply** starts the runner; saving still does nothing.
4. Review the generated resource names and exact policy/role/callback definitions.
   Apply creates only the named Docker bridge, Raft/log volumes and service;
   verifies owned configuration; initializes only a confirmed uninitialized
   managed server; and creates its restricted Caddy route. It never repeats an
   attempted initialization. A failed/unavailable start does not mean healthy.
5. Retrieve the recorded **0600** handoff on the runner host through your
   protected administrator channel:
   `/var/lib/proxypilot-openbao-recovery/<credential-reference>.json`.
   The package contains PGP-encrypted `shares` and `root` values, each base64
   encoded, plus a receipt. Base64-decode and PGP-decrypt each recipient's value
   offline. Confirm custody and decryption before entering the receipt in
   **Acknowledge handoff**. Keep the package and decrypted shares separate from
   all ordinary service/application backups. No API endpoint returns the package
   or an unseal value. Acknowledgement is required before managed setup completes.
6. Submit two different custodians' shares through **Submit share**, one at a
   time. They exist only in the request/API call and are cleared from the form.
   No share or bootstrap token enters a plan, credential-reference table, job,
   checkpoint, event, audit record, frontend local/session storage or command
   argument. JavaScript strings are garbage-collected; cryptographic memory
   zeroization is not claimed. OpenBao's seal configuration is never changed.
7. Complete the displayed **dedicated Keycloak client** handoff: confidential
   standard authorization-code flow; implicit/direct grants/service accounts
   off; exactly the displayed callback and OpenBao origin; full-path `groups`
   mapper in the ID token. The owned OpenBao OIDC role requires the exact chosen
   group and grants only its limited policy with no default policy. Unmapped
   users receive no token through this role. Existing external auth mounts and
   their users remain their owner's responsibility and are untouched.
8. Once unsealed, explicitly apply **owned access configuration** with a
   transient OpenBao bootstrap token and the selected disposable database
   account password. This first inspects existing mounts/policy names and
   refuses conflicting ownership. It creates only the displayed dedicated
   OIDC/AppRole/database mounts, policies and database reader role. The machine
   SecretID is generated once in an encrypted reference and registered using
   AppRole custom-secret-id; it is not regenerated on retry. A missing previously
   attempted registration requires operator recovery. OpenBao stores the new
   disposable database connection credential in its own encrypted storage;
   ProxyPilot does not retain that submitted password. No existing application
   credentials are moved.
9. After the separate machine identity passes allowed/denied checks, the
   submitted bootstrap token is revoked and revocation is checked. A root token
   is never the runtime identity. An interruption after revocation but before
   the success record may require a new, deliberately supplied scoped bootstrap
   token to reverify the owned configuration; do not reset data or machine keys.
10. **Apply / retry verification** verifies the current provider/client and owned
    access configuration, logs in with the scoped machine reference, issues a
    60-second PostgreSQL reader (maximum 120 seconds), reads `public.g6_probe`,
    proves that writing is denied, revokes its test token/leases and confirms a
    new connection with the old credential fails authentication/permission checks.
    A network outage does not count as successful revocation evidence. Credentials
    never reach browser output or job evidence. Confirm human browser sign-in
    for a mapped user and denial for an unmapped user on the real host.

### Disposable PostgreSQL preparation

Select a dedicated **test** server/database with verified private TLS. Its owner
prepares the test account/database/table before using G6; G6 neither starts
PostgreSQL nor opens a database listener. The test database must contain
`public.g6_probe(marker text)` with at least one harmless row, owned by the
selected administrator. Revoke PUBLIC CREATE on the database and public schema.
The selected account must have CREATEROLE, own/grant access to the probe table,
and be able to revoke/drop the roles it creates. G6 checks those prerequisites;
its generated reader gets only CONNECT, schema USAGE and SELECT on this table.
The PostgreSQL plugin uses `password_authentication=scram-sha-256`, so generated
passwords are hashed before they enter role-creation SQL. Use a compatible
PostgreSQL server (SCRAM requires PostgreSQL 10 or later).
The attempted denied INSERT runs inside a transaction that is rolled back.
No existing production database is a valid substitute for this explicit test
resource. Other database engines, SSH and PKI are not configured.

## Runtime and recovery

| Observation | Meaning and next action |
| --- | --- |
| Uninitialized | Managed initialization requires the saved recipient/initialization review and explicit apply. Connect leaves initialization to the external owner. |
| Sealed | Service is not verified. Supply the existing threshold of shares manually after restart; then reapply verification. No KMS/HSM/auto-unseal path is added. |
| Unsealed | Readiness also requires active health, supported version, matching cluster and saved configuration. An unsealed service alone does not certify the credential flow. |
| Unavailable | Restore connectivity or the owned service using existing host operations; no health or verification claim is made. |
| Initialization attempted, handoff absent/unreadable | Recovery required. Recover the separately held package/custodians' material. Never remove Raft data, generate new keys or repeat initialization to clear this state. |
| API dies during share/bootstrap submission | Existing job becomes recovery required. No input is replayed; re-read state and deliberately resubmit if needed. Already created resources are read back, not replaced. |
| Runner/API/browser restarts during apply | Existing job/revision and child Caddy reference remain. The runner rechecks owned state. Installation keys, names, data and machine credentials are reused. |
| Different cluster, container, volume, runtime configuration or policy | Refused; restore/review the matching existing state. No implicit adoption, replacement, credential rotation or migration. |

Managed HTTP is published only at host loopback `127.0.0.1:18200`; Caddy retains
80/443 and certificates, with the reviewed IPv4 allowlist. Include the source
addresses used by the runner/API when reaching the public origin as well as
operators; the guide does not automatically broaden that list. The container's cluster
listener is loopback inside the container, never published. Its dedicated bridge
allows outbound connections to the reviewed Keycloak and database targets; it is
not a default Docker shared bridge and is checked for unexpected members.
Raft/log volumes persist independently of ProxyPilot. `server`, not `server -dev`,
is the only command. Docker logs are disabled; arbitrary runtime/env/entrypoint
changes are refused. Integrated storage uses `disable_mlock` with a 512 MiB memory
limit and equal memory/swap limit (no additional swap). This is a single node;
no HA or seal migration is configured. Connect creates none of this runtime and
preserves its external seal/lifecycle/Caddy configuration.

Use OpenBao's existing Raft snapshot tools for a compatible data backup, alongside
`server.json`/owner marker and optional public `postgres-ca.pem` in
`/var/lib/proxypilot/openbao`, the Caddy references,
and the ProxyPilot SQLite database plus its matching `TOTP_ENCRYPTION_KEY`.
A generic configuration pack is not a Raft data backup. Hold the PGP handoff and
custodian shares separately; do not add the recovery directory to application
backups. Follow the version-compatible OpenBao snapshot restore procedure using
existing mechanisms; this slice adds no backup, upgrade or restore framework.
After any restore/restart, manually unseal and reapply verification.

The host runner's `serve` and `once` commands load and validate the **existing**
`TOTP_ENCRYPTION_KEY` from the resolved installation `.env` before opening the
queue (`--env` selects an alternate file). An explicitly configured service key
is supported, but conflicting file/environment keys are refused. If startup
reports a missing, malformed or conflicting key, restore the matching saved
configuration; never generate a replacement for existing ciphertext. The runner
does not rewrite the key or `.env`. `setup-runner status` and `reconcile` remain
available for recovery inspection without decrypting credentials.


## API and implementation

All routes below are under `/api/setup/platform/openbao` and administrator-only.
Mutations retain the application's CSRF middleware and fresh-auth requirement.
Every response is `Cache-Control: no-store`. Unknown input fields are refused.

| Route | Boundary |
| --- | --- |
| `GET /` | Saved state/review and current read-only seal/health observation. Historical evidence is separate; sealed/unavailable/superseded state is never currently verified. |
| `PUT /` | Inert immutable target save and encrypted client/machine references. |
| `POST /apply` | Saved revision + exact review token; queues `openbao_apply` for the independent runner. |
| `PUT /handoff` | Receipt acknowledgement; only its digest and acknowledgement flag are stored. |
| `POST /unseal` | One transient share, same persistent service lease and durable operator job; no queued secret. |
| `POST /bootstrap` | Explicit owned changes with transient token/password, same lease/job and protected references. |

Migration 1007 adds the two OpenBao tables. `openbao_apply` is runner-only;
`configure_openbao_route` reuses the backend route job and shared route lease.
`openbao_operator` records bounded transient API operations and deliberately does
not auto-replay after interruption. Its retry returns to this guide, not a generic
job endpoint. Unavailable runner means queued, with no backend host fallback.
See [focused acceptance and execution limits](../evidence/g6-acceptance.md).
