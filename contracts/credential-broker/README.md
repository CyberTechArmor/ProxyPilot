# Credential broker v1 — shared implementation contract

B0 design is docs/plans/fractionate-openbao-broker-b0-cloud-plan.md. This file freezes
working defaults for synthetic implementation. Production activation stays off.
No change to A4 or existing synthetic_sign_in execution.

## Common JSON
UUID opaque IDs; revision positive integer; UTC timestamps. Unknown fields denied.
If-Match quoted numeric revision required for updates. HTTP failures:
`{error:{code,message,request_id,retryable:false,next_action:null},contract_version:'broker.v1'}`.
Hidden/absent both 404 NOT_FOUND. Other codes INVALID_REQUEST(400), AUTH_REQUIRED(401),
FRESH_PROOF_REQUIRED(401), NOT_PERMITTED(403), SCOPE_EXCEEDED(403),
REVISION_MISMATCH(409), IDEMPOTENCY_CONFLICT(409), OPERATION_UNCERTAIN(409),
REVISION_REQUIRED(428), LIMIT_EXCEEDED(429), BROKER_UNAVAILABLE(503).

## Public connection
`{id,name,owner_id,project_id:null|uuid,adapter_id:'synthetic-ledger-v1',revision,
policy_revision,credential_version,status:'saved'|'active'|'revoked',
operations:['item.read'],resources:[uuid],limits:{max_actions:20,max_seconds:300},
rights:['view','use','assign','manage'],readiness:{state,code},
assignments:[],sessions:[]}`. No vault path/value/verifier in public projection.
Lists `{connections:[],next_cursor:null,contract_version}`. Detail `{connection}`.
Activity `{events:[]}`; assignments `{assignments:[]}`; sessions `{sessions:[]}`.
Capabilities `{contract_version,mode:'disabled'|'synthetic',intake_enabled:false,
execution_enabled:false,adapters:[{id,type:'static_api_token',supported:true}],
reason:'BROKER_NOT_ACTIVATED'}`. Synthetic test harness may explicitly enable its
own intake and execution only with isolated fixture configuration.

## Dashboard routes
GET /api/connections/capabilities; GET /api/connections with optional project_id
and assignable_to_agent_id; GET /api/connections/:id;
GET /api/connections/:id/assignments|sessions|activity.
POST /api/connections/enrollment-intents metadata `{name,project_id,adapter_id}`
returns `{intent:{id,status},intake_enabled:false}` when unavailable; never accept
value in dashboard. POST /:id/test; PATCH /:id `{name}`; POST /:id/revoke;
POST /:id/rotation-intents; POST /:id/assignments
`{user_id,project_id,agent_id,operations,resources,limits,expires_at}`;
POST /assignments/:id/revoke. Mutations require current rights and fresh proof.
Backend bridge stays fail-closed absent independently configured broker. No
production memory store. Dependency injection for disposable synthetic harness.

## Agent configuration
Separate `ops_agent_configurations` table, not widening A4 profile constraints.
Fields `{id,project_id,revision,lifecycle:'draft',execution_enabled:false,
workflow_type:'typed_api_v1',work:{name,role,task,expected_outcome,inputs:[],
guide_ref:null,supporting_material:[],environment_ref:null},
controls:{operations:[],resources:[],max_seconds:300,max_actions:20,
approval_policy:'writes',output_ref:null,escalation_user_ids:[]}}`.
Work narrative max4096 each; name200; array max32. Guide reference when provided
`{id,hash}` must identify applicable existing approved version. No implicit run.
POST/GET /api/operational-projects/:projectId/agent-configurations;
GET/PATCH /.../:id; GET /.../:id/readiness.
POST accepts `{workflow_type,work,controls}`; result `{agent,readiness}`.
GET list `{agents:[]}`; PATCH work/controls replacement with expected revision.
Readiness `{contract_version,agent_id,state:'blocked'|'ready',can_start:false,
execution_enabled:false,pins:{agent_revision,project_revision},checks:[
{kind,state,code,next_action}]}`. Production default BROKER_NOT_ACTIVATED.
Use existing project permissions and guide semantics. Agent creation requires
no guide, environment, credential. No session/run created by saving.

## Broker service boundary (standalone service owns authoritative state)
New code under services/credential-broker. Restricted OpenBao AppRole, KV CAS,
protected durable SQLite state, own auth, separate enrollment/execution authority.
Standalone synthetic harness provisions random fixture credentials in memory,
not dashboard database. No privileged backend imports. Agent API:
POST /v1/operations `{connection_id,operation,input,approval_id?}` with Bearer
session + Idempotency-Key; GET /v1/operations/:id. Read input `{resource_id}`;
write adds `{state:'open'|'closed'}`. Results contain only matching resource_id,
state and (for writes) applied boolean; refuse raw errors/echoes. Sessions may
not mint sessions or access management. Enrollment, grants, test, sessions,
approval and revoke management methods require independently authenticated
human/operator (synthetic harness only until live boundary selected).
Mutation approval pins operation digest, revisions, task/attempt/fence; exactly
once consumption. Persist sending before transport. Unknown outcome never retries.

Service exports a createBroker factory with explicit dbPath, vault, upstream,
clock and authority dependencies; no auto-start on import. Backend bridge is
injected, not automatically connected to a host service. Service owner documents
actual method signatures for integration. Typed synthetic consumer gets only
session bearer + connection ID, never vault access. One shared catalogue.

## UI
Add four-section wizard in selected project's Agents tab; retain existing A4
profiles and runs. Connection catalogue at /connections and project Access.
Existing vs Add; unassign differs revoke; secret entry disabled unless verified
synthetic intake enabled. No unsupported browser/OAuth input. Readiness after
save; no autosave of credentials; explicit one-shot transport if enabled.
Project create label Name/Purpose/People access, private default; initial named
membership support handled transactionally by backend owner if implemented.

## Integrated refinements (2026-10-01)

Project catalogue views include permitted global/private (`project_id:null`)
connections as well as the exact project; target eligibility is rechecked by the
assignment picker and on save. Operation activity carries bounded status/timing/
cost/recovery metadata; dashboard projection strips arbitrary content and results.

Restart/restore sets `POLICY_REVALIDATION_REQUIRED`. New sessions, delegated use,
testing, rotation and assignment fail closed until external current policy
revalidation; owner revocation remains available. `policy_revalidated` is an audit
event. Synthetic harness checks current agent Controls and pins config revision;
edits invalidate old sessions even if the previous Controls are later restored.

B0 narrative reference arrays are implemented as bounded inert text in this
slice; they confer no fetch authority. Environment/output registration and live
runner readiness remain unavailable. Exact production reason mapping/identity
integration must precede activation, not be inferred from synthetic capabilities.

UI palettes are Midnight (existing dark), Latte (ivory/charcoal/muted gold), and
Office (white/blue), sharing one typography/icon/component/layout system. Theme
preference is independent of connection and agent readiness.
