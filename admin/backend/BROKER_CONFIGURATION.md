# Configured credential broker dashboard bridge

Implementation only; no production placement or identity/authority enrollment is
selected by these files. Existing A4 browser execution is separate.

Set `FRACTIONATE_BROKER_CONFIG_FILE` to an absolute, owner-private JSON file:

```json
{
  "version": 1,
  "management_origin": "https://broker-management.example:8444",
  "human_origin": "https://broker.example",
  "ca_file": "/etc/fractionate-broker/dashboard-ca.pem",
  "cert_file": "/etc/fractionate-broker/dashboard-client.pem",
  "key_file": "/etc/fractionate-broker/dashboard-client.key",
  "timeout_ms": 5000
}
```

Paths and hostnames above are placeholders. Configure the exact reviewed origin
and independently issued dashboard mTLS identity. JSON and private keys must be
regular, non-symlink files, mode 0600; certificates must not be group/world
writable. Missing/invalid config fails closed. No vault credentials belong here.

The client verifies TLS, exact `broker.v1` contract and configured component
build, capability origin and authority readiness. Redirects/compression and
oversized/slow replies are refused. Every metadata RPC requires an independent,
short-lived human delegation in `X-Broker-Delegation`, forwarded once as Bearer.
The broker matches the delegation user to the dashboard actor. A dashboard
certificate is transport authority only. Broker login/consent occurs in its
own popup; the returned delegation remains in tab memory, expires within five
minutes, and is cleared at dashboard logout. No secret input crosses this API.

Set `FRACTIONATE_BROKER_WORKER_CONFIG_FILE` only when a separate bounded worker
has been registered with the independent authority:

```json
{
  "version": 1,
  "origin": "https://broker-worker.example:8445",
  "ca_file": "/etc/fractionate-broker/worker-ca.pem",
  "cert_file": "/etc/fractionate-broker/worker-dashboard-client.pem",
  "key_file": "/etc/fractionate-broker/worker-dashboard-client.key",
  "timeout_ms": 10000
}
```

Explicit task routes live below
`/api/operational-projects/:projectId/agent-configurations/:agentId/tasks`:
GET lists this person's tasks; POST `/readiness` checks the exact registered task without starting it; POST explicitly starts the exact task request;
GET `/:taskId` observes status; POST `/:taskId/cancel` stops it; POST
`/:taskId/approval` forwards `{approval_id}` previously issued on the broker's
human approval surface. Start/cancel/continuation require dashboard fresh proof.
The backend cannot create approval, enroll a worker, sign authority snapshots,
or authorize a task merely by dispatching it. An independently signed live task,
user/project/agent, registration, epoch and permission ceilings must already
exist and match the request at worker session issuance.

The independent signed task record must additionally pin `configuration_revision`
and current readiness evidence references for guide approval, environment and
required checks. A saved `draft` configuration is not an activation record.
`checkTask` returns `{ready:true,task_id,user_id,project_id,agent_id,
configuration_revision,attempt,fence,expires_at}` only after the worker verifies
that independent registration. The backend requires exact matching identities,
revision and epoch and a readiness lease no longer than 60 seconds before reserving
any task. An absent/expired/refused preflight makes no dispatch record and starts
nothing. Both the worker and session issuance independently repeat these checks;
a successful preflight is not a bearer capability or blanket authorization.
The operator task panel exposes this separate activation explicitly, with one
selected allowed action and resource and the external registered task references.
It neither changes the saved draft lifecycle nor manufactures readiness evidence.

Start body: `{task_id,grant_id,connection_id,attempt,fence,configuration_revision,
scope:{operations,resources,limits,expires_at,audience:'fractionate-broker'},
steps:[{operation,input}]}`. All identifiers are UUIDs; steps only accept the
explicit typed adapter. Scope must fit current Controls and expiry limits.
Saving a project/configuration/grant starts nothing. Migration 1114 adds only
metadata dispatch records including immutable attempt/fence response pins. Reserve before transport, never automatically replay
an ambiguous send or duplicate task ID. Worker outage preserves a known status;
ambiguous mutation returns uncertainty. After restart active dispatches remain
uncertain until worker status is read. Receipts contain no session bearer.

Rollback disables these two file settings and restarts the dashboard; do not
remove migration history or replay tasks. Stopping/revoking independent workload
authority remains required for tasks already accepted by a worker. Production
host root steps require the reviewed operator paste and separate deployment
choice from the handoff.

## Saved configuration task preparation and local authority source

`BROKER_AUTHORITY_SOURCE_SOCKET` optionally selects the private Unix socket of
`services/credential-broker/local-authority-source-main.mjs`. The client requires
an actual mode-0600 socket owned by the backend user or root in a non-writable,
non-symlink parent. Requests use fixed bounded metadata paths; no arbitrary URL,
secret, source signing key, or human broker delegation is sent on this channel.
This is explicitly **local_backend_authority**: the source trusts current local
Operations metadata and explicit fresh dashboard start. It does not protect
against a compromised dashboard/root changing that metadata or calling the socket.
Keycloak account eligibility and operator-maintained per-user ceilings, checked
configuration/guide registrations, and current broker grants are additional checks,
not evidence that this deployment is independent of its administrators.

The metadata reader selects only role/lockout, project access/current guide IDs
and hashes, configuration Controls/environment references, and task status/epoch
pins. A withdrawn newest guide cannot revive an older approved guide. User
`locked_until` is login throttling, not a general account-disable record; the
source applies its conservative lockout policy and independently reads Keycloak
account enablement. Pending or missing users have no authority.

Save the agent first, then have the operator register that exact agent/configuration
revision, approved guide, checked environment and project-activity output. The
permission-filtered `GET /api/operational-projects/:id/broker-registrations` supplies
selectable IDs; an empty list means registration is still required. Editing saved
settings changes the configuration revision and requires a current registration.
Existing applicable approved guides are reused, not re-approved by setup.

`POST /:id/agent-configurations/:configurationId/task-proposals` accepts only the
current configuration revision, connection/grant IDs, one typed operation,
resource ID and optional `open`/`closed` state. It derives task/attempt/fence and a
one-action scope limited by saved Controls, and asks the source to preview the
exact scope without publishing execution authority. It returns a short-lived
proposal and revision-bound readiness. Readiness is not a start, training result,
or deployment claim. All guide/check/registration/permission checks happen again
at explicit fresh-authenticated `POST .../task-proposals/:proposalId/start`.

Migration 1115 stores bounded typed request metadata only. Start consumes the
proposal atomically before any external request; dispatcher reserves its task
before source authorization and worker transmission. Lost responses cannot replay
that proposal or task. Source/preflight failure leaves a blocked task when already
reserved; use the task list/status to inspect it. No secret, session bearer,
narrative content or approval capability is stored in the proposal. A new attempt
requires a new reviewed proposal; uncertain upstream work still requires the
separate broker reconciliation decision. The existing operator task API remains
bounded by the same source and worker checks. No save or navigation starts a run.
