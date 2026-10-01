# Independent authority v1

`createAuthority({statePath,identity,sources,clock})`; private state directory 0700,
state file 0600, single-process lock. `sources` is nonempty array of
`{id,public_key,kinds}`. Public keys are PEM Ed25519; source ID is 1–64 safe
ASCII characters. Exactly one source owns each kind; all six kinds required.
No private signing key belongs in broker/dashboard configuration.

Signed snapshot envelope (no extra fields):
`{version:'authority.v1',source_id,sequence,challenge,issued_at,expires_at,records,signature}`.
Signature is base64url Ed25519 over UTF-8 `canonical(envelope minus signature)`
from schema.mjs. Timestamps are integer epoch milliseconds; issued_at <= now,
expires_at > now, lifetime <=60000ms. Challenge from `challenge()` is a new
random 32-byte base64url string each boot. sequence is positive safe integer,
strictly greater than durably accepted source sequence. `records` contains
exactly source-owned keys, each a complete array (empty allowed). Snapshot
size <=1MiB; <=1024 records per kind. Reject duplicate record IDs, extra fields,
unknown source, incorrect signature/nonce and rollback. Ack pins source,
sequence and content digest. Every record has opaque UUID `id`, positive safe
integer `revision`; changed content requires strictly newer revision. Omitted
records disappear immediately; their durable revision floor survives and
reintroduction requires a higher revision. Startup retains monotonic floors
but drops leases and all active records. Every access requires all source
leases current; outage/expiry is fail closed.

Exact records (every listed field required, no extras):

- users: `id,revision,disabled` (boolean).
- projects: `id,revision,archived,user_ids` (UUID array).
- agents: `id,revision,project_id,user_id,disabled,workload_id` (UUID).
- tasks: `id,revision,project_id,user_id,agent_id,attempt,fence,status,expires_at,
  grant_ids,connection_ids,operations,resources,limits`. status is
  `running|ended|cancelled`; attempt/fence UUIDs. arrays pin exact authorized
  grant/connection IDs. Operations/resources/limits are existing broker typed
  scopes. limits max_actions 1–20, max_seconds 1–300; broker durably counts session actions. Authority permits only one session
  reservation per task/attempt/fence, persisted before mint; failures cannot
  automatically retry issuance. A new attempt/fence needs a new independently
  signed task revision.
- ceilings: `id,revision,user_id,project_id,actions,connection_ids,adapter_ids,
  operations,resources,limits,expires_at,revoked,grant_rights,manage_actions`.
  project_id UUID or null for explicitly global private ownership. Actions:
  `list,get,activity,assignments,sessions,enroll,test,update,revoke,rotate,
  assign,unassign,approve,setPermission,reconcileOperation,revalidatePolicy`.
  connection_ids UUID array. enroll uses project/adapter/scope ceiling before
  connection ID exists; other actions require explicit connection ID. A list
  ceiling only permits query scope; broker independently filters actual
  metadata permissions. grant_rights uses view/use/assign/manage;
  manage_actions uses test/rename/rotate/revoke. adapter_ids nonempty allowlist.
- policies: `id,revision,policy_revision,credential_version,owner_id,project_id,
  adapter_id,operations,resources,limits,status`. id IS connection ID; status
  `saved|active|revoked`. Exact independent approved policy and credential
  versions are required for execution/restored-policy revalidation.

`authenticate(proof)` wraps independent identity and checks live enabled user.
Delegation actions are checked again by authorize; direct human required for
approve/setPermission/reconcileOperation/revalidatePolicy. `authorize(principal,
{action,id,body,query,connection})` returns true or throws. It never grants
broader than one applicable current protected ceiling, and core connection
rights still apply. `canAssign(principal,grant)` checks target user/project/agent,
caller membership, exact project, protected assign ceiling and target use policy.
`eligible(session)` checks current task/attempt/fence, all identities and scopes,
policy versions and connection/grant IDs. False means no send.

`issueWorkloadProof(workloadId,scope)` accepts exact worker request
`{grant_id,task_id,attempt,fence,operations,resources,limits,expires_at,audience}`.
Returns a frozen opaque in-process object, redeemable once by authenticate.
Principal: `{user_id,fresh_until,proof_type:'workload',actions:['issueSession'],
workload_scope:scope}`. Core must accept this only for issueSession and compare
all scope fields and grant ID; never let workload proof mutate management state.
Worker mTLS registration supplies workloadId. Every operation rechecks task.

`revalidatePolicy(principal,{connection})` requires direct human ownership,
protected revalidatePolicy ceiling, independently current exact connection ID,
owner/project/adapter, policy revision, credential version and full scopes.
Broker revision differs because recovery transition itself increments it;
policy_revision and credential_version are the reviewed semantic pins.
`health()` returns ready/reason/lease summaries, no credentials. `close()` drops
capabilities and leases and releases lock. `isConfiguredAuthority` checks a
module-private WeakSet; external callers cannot brand fake authority objects.

Publisher API: authority-publisher.mjs signs complete snapshots using a supplied
Ed25519 private key held by an independently administered publisher, optionally
POSTs to the broker over pinned CA/client-certificate TLS after reading boot
challenge. Signing is not dashboard access and requires independent record
review; this generic transport does not invent a deployment-specific source of
truth. No host deployment or private publisher key is configured by this work.

`endTask(workloadId,{task_id,attempt,fence})` durably denies that exact epoch,
even after restart or later signed refresh. Only a new independently signed
epoch can resume. Session issuance similarly reserves each epoch once before
proof creation; loss requires operator-authorized new epoch, never retry.
The `intent` read action requires current user and delegation intent action;
intake.status must independently enforce exact owner. No management scope or
secret access is granted by this status-only exception.

`workloadReady(workloadId)` is a boolean read-only capability probe: all source
leases must be current and at least one independently registered agent for
that exact workload must be enabled with an enabled owner and active project
membership. It creates no task, proof, session or independent readiness lease.

Protected test/approval ceilings include the actual typed read/write operation
and resource. Approval preview carries the session limits; absent limits are
conservatively bounded by the entire connection limits. `canUnassign(p,grant)`
checks an explicit unassign action and exact signed target without requiring
assign authority; core uses it only for removal, never grant creation.

Each issuance reservation also pins a digest of the full independently signed
user, project, agent, task and allowed connection policy records, including
source record revisions. eligible requires that exact digest still match;
disable/re-enable or narrow/restore under later revisions never resurrects an
old session or approval. A fresh independently authorized task epoch and new
session are required. Source lease refresh with unchanged records is allowed.

Signed tasks additionally require `configuration_revision` (positive integer)
and `readiness:{guide_revision,checks_revision,environment_revision,
execution_approved}`. Revisions are positive integers; execution_approved is
boolean. The independent publisher verifies applicable approved guide, checks,
environment and explicit human start before attesting true. No saved wizard
or backend-only assertion substitutes for this independent attestation.
`checkTask(workloadId,runnerStartRequest)` checks the exact runner IDs, epoch,
configuration revision, scopes and steps without reservation; returns
`{ready:true,task_id,user_id,project_id,agent_id,configuration_revision,attempt,
fence,expires_at}` bounded by all source leases and task expiry. It is not a
session grant. Actual issuance rechecks readiness and configuration revision.
`issueWorkloadProof` requires configuration_revision in its request; after
checking it the returned workload_scope omits that field to match broker
core's existing exact issuance DTO. The service strips configuration_revision
when calling broker.issueSession. Source revisions remain pinned separately.
