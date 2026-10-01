# ProxyPilot / Keycloak local authority source

This is the **local_backend_authority** deployment option. ProxyPilot's SQLite
metadata, the broker metadata DB, operator policy, Keycloak's enabled-user API,
and the administrators/processes able to modify them are trusted. The publisher
signature authenticates this source; it does **not** protect it from the
root-equivalent ProxyPilot backend or host administrator (S6/SEC-01 remains).
The source signing key stays in its private configuration, outside agent VMs.
No production configuration or credential is included.

## Runtime and current data

Run Node 24 with `node services/credential-broker/local-authority-source-main.mjs
/absolute/private/source.json`. The configuration path is the only argument.
The process opens ProxyPilot and broker SQLite databases read-only. Backend
`readLocalFacts` selects user role/lock state, project owner/membership/archive,
current approved guide ID/hash, saved agent revision/selected references/Controls,
and durable task start metadata. It does not select passwords, guide narratives,
vault values, session verifiers or receipts. Broker reads select only connection
and grant metadata. The latest withdrawn guide never falls back to an older one.

The reader obtains a Keycloak client-credentials token and checks each explicitly
mapped subject by exact user ID over verified HTTPS; it does not infer identity
from email or display name. Keycloak `enabled:false`, missing subject, local
pending/deleted user and active local lock deny eligibility. Required permissions
are an explicitly reviewed Keycloak service account capable of reading only the
selected users; no realm administration is needed by the source operation.
The generic reader follows the documented [token endpoint](https://www.keycloak.org/securing-apps/oidc-layers)
and [Admin user GET API](https://www.keycloak.org/docs-api/latest/rest-api/index.html#_users).
Tests cover the protocol with a disposable HTTPS fixture; deployment must verify
the installed Keycloak version and exact least-privilege reader configuration.
It does not enroll an upstream OAuth connection or add OAuth broker adapters.

The complete lookup has a five-second deadline, at most four user requests in
flight, and bounded responses. A source failure stops publication. Polls are
coalesced rather than queued indefinitely; current authority leases expire.
Default recommendation: poll every 5 seconds, lease 15 seconds. Configuration
allows poll 1–10 seconds, lease at least twice poll and at most 30 seconds.
Revocation freshness is bounded by observation and lease expiry, not instantaneous
cross-process synchronization. Broker-side direct revocation still enforces its
own current checks before a possible send.

## Configuration

`source.json` exact keys:

- `trust_mode`: `local_backend_authority` (explicit acknowledgement of boundary).
- `proxypilot_db`, `broker_db`: absolute existing SQLite paths, no symlinks or
  group/world-write permission. Files are opened read-only.
- `state_path`: separate private SQLite state; directory 0700, file 0600.
- `socket_path`: Unix socket under a private 0700 directory; socket is 0600.
  The trusted backend runs as the permitted UID. Never expose this socket over
  an unauthenticated network or broaden it to arbitrary local users.
- `policy_file`: private JSON policy below, read again on each observation.
- `keycloak`: `{issuer,client_id,client_secret_file,ca_file}`. Issuer is exact
  HTTPS `.../realms/REALM`; subject IDs are Keycloak UUIDs. Secret stays in its
  private file; no password/token command arguments, environment JSON or logs.
- `publisher`: `{origin,ca_file,cert_file,key_file,source_id,signing_key_file}`.
  Origin is the broker management HTTPS origin; certificate fingerprint and
  source ID must already be registered. Signing key is Ed25519 PKCS8 PEM.
- `poll_ms`, `lease_ms`: intervals described above.

`policy_file` exact keys: `trust_mode`, `subject_map`, `registrations`, `ceilings`.

`subject_map` rows: `{user_id,issuer,subject}`. They must match independently
configured broker OIDC subject mappings. Unknown local users are disabled;
missing or failed Keycloak observations never imply enabled.

Registration rows:

```json
{
  "agent_id":"<uuid>", "user_id":"<uuid>", "project_id":"<uuid>",
  "workload_id":"<registered-worker-uuid>",
  "environment":{"id":"<uuid>","name":"API worker","revision":1},
  "output":{"id":"<uuid>","name":"Project activity","revision":1,"kind":"project_activity"},
  "configuration_revision":1,"guide_id":"<approved-guide-uuid>",
  "guide_hash":"<64-character approved content hash>","checks_revision":1,
  "expires_at":1900000000000,"enabled":true
}
```

These are explicit operator-reviewed environment/check bindings. The daemon
verifies selected saved references, current approved guide/hash and agent
revision; it cannot manufacture missing environment or practice/check evidence.
A saved change requires its corresponding review registration update. The
catalogue reports permitted registered environments/outputs without requiring
them to be selected already. Only `project_activity` receipts are supported as
an output; there is no arbitrary file/URL destination. Registration does not
start a task or give another person's private connection access.

Ceiling rows: `{id,user_id,project_id,actions,connection_ids,owned_connections,
task_use,adapter_ids,operations,resources,limits,expires_at,enabled,grant_rights,
manage_actions}`. Fields use the existing authority scope vocabulary. The
boolean `task_use` must explicitly be true to approve task execution; a list or
view-only scope does not imply use. `owned_connections:true` is an explicit
operator ceiling over only that user's own connections in the exact project
(or null private scope), adapter/resource/operation/limit bounds. Otherwise
connection IDs must be explicitly named. Existing broker ownership and grants
are additionally intersected. Admin role or project membership grants no
private connection access. Management, assignment and permission expansion
remain separate actions with explicit ceilings.

## Backend and task lifecycle

Configure the backend's optional authority-source Unix client. Its fixed paths:

- `GET /v1/registrations?user_id=...&project_id=...`: permitted named catalogues.
- `POST /v1/task/preview`: exact runner start request. Reads current facts and
  returns `{readiness:...}` without recording or signing execution approval.
- `POST /v1/task/authorize`: same exact request, allowed only after an existing
  durable ProxyPilot `starting` row matches user/project/agent/configuration/
  task/attempt/fence and exact request digest. This is invoked by the backend
  only after its authenticated, fresh, explicit Start action.
- `GET /v1/health`: bounded readiness/trust-mode metadata.

The source persists an exact one-shot approved task, publishes it, and only then
returns. The backend subsequently asks the registered worker/broker to validate
current signed readiness and mint its bounded session. An ambiguous publication
failure is not retried as a new approval. The task ID is consumed; a new explicit
start/epoch is required. Saving a project, configuration or connection never
calls task authorization.

Task approval is permanently cancelled after an observed invalid user, project,
configuration, guide/check/environment, grant, connection or backend terminal
state. Repairs do not revive the old task. Source restart cancels all prior source
tasks. Broker separately durably limits issuance to one session per epoch and
checks signed revision pins; no source restart or lease renewal revives a bearer.

## Persistence, rollback and limits

Source sequence and record revision floors are durable and reserve before
publication. Complete snapshots remove missing records; reappearance advances
revision. Broker metadata floors reject rollback of connection revision,
policy/credential versions, changed same-revision scopes/permissions, restored
revocations and deleted records reappearing at stale revisions. Grant revision
and content floors are also persistent. A stale broker restore therefore cannot
silently become a newly approved local-source policy.

Back up the source state alongside the broker's protected state. If source state
itself is lost or rolled back, the broker's durable source sequence rejects stale
publication; operators must review exact current records and recover sequence/
revision continuity. Do not delete state to bypass rollback denial. This is not
protection against an administrator modifying both trusted stores; that boundary
requires a separately administered authority deployment. Source history, task
receipts and reviewed approvals remain evidence to preserve.

The initial implementation retains consumed task IDs and revision history;
there is no automatic destructive garbage collection. Deployments must monitor
private source-state disk use and define reviewed retention/recovery before
claiming unlimited service operation. No fleet or production host change is
performed by this implementation.
