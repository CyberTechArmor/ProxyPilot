# Configured service v1

This adds a runnable configuration-driven service; it does not install a host,
select a real IdP, enroll real credentials, or approve a production pilot.
The configured mode uses actual OIDC human identity, independently signed
short-lived authority snapshots, exact mTLS registrations, and restricted
OpenBao AppRoles. The existing synthetic command remains isolated.

## Operator preparation and lifecycle

Use Node24+. Provision a dedicated unprivileged service account and owned0700
state directory outside the dashboard's privilege domain when that separation
is required. Review `deploy/fractionate-credential-broker.service.example` before
installation. It is an input for the operator's reviewed host paste, not an installer.
Prepare exact KV paths/ACLs, two AppRoles (enrollment and read/use), TLS server
certificates, client trust CA, and exact SHA256 leaf-certificate registrations.
Read-only runtime ACLs require both data and metadata on each allocated path;
no wildcard or root token is implied by configuration.

```sh
node main.mjs --check-config /absolute/private/config.json
node main.mjs --config /absolute/private/config.json
```

`--check-config` validates structure and prints a digest of metadata configuration.
Startup also checks certificate/key/secret-file ownership and permissions,
constructs identity/authority and acquires a lifetime maintenance lease. No
credential value is accepted through arguments, environment JSON or logging.
SIGINT/SIGTERM drains listeners and closes component stores before releasing
the state lease. A bind failure closes previously started listeners. An unclean
stop requires the documented stopped-process lock recovery; no automatic lock
stealing or restart that replays possible writes.

## Exact metadata configuration

Top-level fields are required and unknown fields fail:

```text
schema_version: 1
mode: configured
state_dir: /absolute/owned-0700-directory
listeners:
  human:      {origin, host, port, tls:{key_file,cert_file,ca_file?}}
  management: {origin, host, port, tls:{key_file,cert_file,ca_file}}
  agent:      {origin, host, port, tls:{key_file,cert_file,ca_file}}
clients: [{fingerprint,role,id}]
identity: <identity.mjs configuration below>
authority: {sources:[{id,public_key,kinds}]}
vault:
  origin, mount, ca_file?, approved_address?,
  reader: {role_id_file,secret_id_file},
  enroller: {role_id_file,secret_id_file},
  slots:[{owner_id,credential_id}]
upstream: {origin,ca_file?,approved_address?}
```

All origins are exact HTTPS origins with no paths/query/userinfo. Listener
origins are distinct, their ports match explicit nonzero listen ports, and host
is an explicit bind IP. Certificate fingerprints are lowercase64-hex SHA256 of
DER leaf bytes, unique across roles. Roles are dashboard, publisher and worker;
publisher ID matches its independent source ID; worker ID is its opaque UUID.
Public keys are Ed25519 PEM; all six authority record kinds have exactly one
configured source. No source private key belongs in broker or dashboard config.

Identity config is `{issuer,authorization_endpoint,token_endpoint,jwks_endpoint,
client_id,broker_origin,dashboard_origin,subject_map:[{issuer,subject,user_id}],
required_acr,max_age_seconds,ca_file?}`. Use reviewed fixed endpoints, exact
issuer/subject mapping, required fresh authentication level, and at most300s
freshness. `broker_origin` equals the human listener's origin. No email-based
identity inference or dashboard-signed human identity.

Credential files contain only the configured AppRole value; their paths are
absolute, nonsymlink, owner-private regular files. Public certificate files can
be owner-readable nonwritable by others. Directory/filename references are
metadata, not values. Configured slot UUIDs are persisted in allocator.json
before use; slots are never reused automatically. KV CAS0 also rejects reuse
after an old allocator backup. Exhaustion requires explicit reviewed provisioning.

Default outbound targets must resolve to approved public IPv4 on port443.
An explicit `approved_address` is an exact operator-reviewed IPv4 pin for that
one hostname/port, with CA verification and hostname checking retained. It does
not permit arbitrary private targets, redirects, agent URLs or inherited proxy
configuration. The first adapter remains typed `synthetic-ledger-v1`; configured
mode is not a new GitHub/browser/OAuth adapter.

## Routes and trust separation

Management HTTPS requires a CA-valid client certificate **and** an exact role
fingerprint. Dashboard requests additionally supply Bearer delegation:

- `GET /v1/capabilities`: configured build/version, independent feed/vault status,
  human intake origin and separate intake/execution availability.
- `POST /v1/dashboard`: `{action,actor:{id},id?,body?,query?,expected?}`. Actions
  list/get/assignments/sessions/activity/intent/enroll/test/update/revoke/rotate/
  assign/unassign. Actor must match the independently authenticated delegation.
  Metadata only; raw credential/token/password/value fields are refused.
- Publisher `GET /v1/authority/challenge` and `POST /v1/authority/snapshot` require
  publisher mTLS and matching source ID, plus verified signed challenge-bound,
  monotonic, leased complete state. TLS identity alone never imports policy.

Agent HTTPS supports bearer typed operations. Workload routes additionally
require exact registered worker mTLS:

- `GET /v1/workloads/ready` verifies current independent registration and renews
  a bounded30s readiness observation. Runner should refresh at most15s apart.
- `POST /v1/workloads/tasks/readiness` checks the exact signed task, configuration
  revision and current approved guide/checks/environment and human execution gate.
  It returns a readiness assessment, never a session or implicit start.
- `POST /v1/workloads/session` additionally requires configuration_revision and takes the exact grant/task/attempt/fence/scope
  contract and exchanges a one-use internal workload proof for one scoped bearer.
  Human and delegation proofs cannot mint these sessions.
- `POST /v1/workloads/tasks/:id/end` with `{attempt,fence}` persistently narrows
  that task epoch. It cannot widen, resume or restart execution.

The human origin handles OIDC login/logout/delegation consent and direct intake.
`GET /` is the independent operator console. It shows an exact typed write
preview with identity/task/revision pins and digest; approval requires entering
the complete digest. It also exposes bounded permission proposal, uncertain
operation reconciliation and restored-policy revalidation. Cookie+CSRF+exact
Origin+fresh independent human proof are required. Direct endpoints:
`POST /v1/human/approval-preview|approve|permissions|revalidate|reconcile`.
Dashboard delegations and worker proofs cannot approve or administer these paths.

Capabilities stay unavailable without current identity/authority and a successful
vault health observation no older than15s. Both intake and execution also need a current
registered worker observation. Intent reservation, page entry, secret submission
and rotation enforce that gate, including immediately before vault write bytes. Actual calls recheck authority and vault; a cached
health display never overrides authorization. Final test/read/write transport
checks occur after TLS handshake and before bytes leave. Configured credential
writes also recheck independent authorization immediately before vault send.

## State, recovery and evidence limits

Protected state consists of broker.db (+ SQLite sidecars), intake.json,
authority.json and allocator.json. Identity capabilities remain memory-only.
Use the separate stopped-service recovery module; private TLS/AppRole/IdP custody
is backed up separately. Restored authority leases are absent and broker policy
is quarantined. New signed state plus exact independent policy revalidation is
required; no old bearer, delegation or approval survives restart.

`test/configured-service.test.mjs` exercises real HTTPS/OIDC signatures, role-
pinned mTLS, signed feed activation, actor mismatch, delegated metadata,
one-shot human enrollment, status polling and human console/CSRF. Its vault and
ledger are explicit in-process injected fixtures; it is not real OpenBao proof.
The existing `test:integration` uses real pinned OpenBao2.6.2. Root integration
combines these components with the registered runner; report its results
separately. Test dependency injection requires an explicit in-process testOnly
flag; no environment/config switch selects test dependencies.

This generic implementation does not decide the independently administered
source of project/task/policy truth, real credential placement, live resource,
provider permission scope, operator custody or release approval. Same-host
root authority remains S6/SEC-01; authenticated TLS does not remove host trust.
