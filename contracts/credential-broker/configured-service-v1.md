# Configured broker integration v1 — local implementation contract

Checkpoint:4f27d44a. Build authorization covers generic runnable code and disposable
proofs, not deployment or real credentials. Existing broker.v1 DTOs remain stable.
Production configuration must fail closed until identities, authority sources,
origins, workload registrations and exact vault/upstream targets are configured.
No component treats a dashboard signature as human proof or independent policy.

## Shared interfaces and ownership

- identity.mjs: createIdentity({config,statePath,clock}) returns authenticate(proof),
  createDelegation(humanSession,actions), handle(req,res), close(), health().
  Configured OIDC authorization-code+PKCE+state+nonce flow on broker-owned origin;
  verify issuer/audience/signature/auth_time/acr/expiry, fixed endpoints/keys.
  Maps exact issuer+subject to configured opaque user UUID, never email matching.
  Human session is HttpOnly Secure SameSite cookie on broker origin; server-side
  verifiers, CSRF and fresh proof. authenticate returns {user_id,fresh_until,
  proof_type:'human'|'delegation',actions:[]}. Delegations expire<=300seconds;
  never approve, issue sessions, enroll secret values or administer authority.
  Direct human intake/approval stays on broker-owned origin. Authentication errors
  expose no tokens/raw IdP responses. Handle supports /auth/login,/auth/callback,
  /auth/logout,/auth/session,/auth/delegations and provides requestPrincipal(req)
  {proof,csrf_token} for intake; sessionProof(req) for direct human routes.
- authority.mjs: createAuthority({statePath,identity,sources,clock}) returns
  authenticate,eligible,canAssign,authorize,revalidatePolicy,issueWorkloadProof,
  ingest,challenge,health,close. sources are independent Ed25519 signing PUBLIC
  keys with permitted record kinds. No private signer in dashboard or broker.
  Ingest signed bounded complete source snapshots with exact boot nonce,
  monotonic sequence, issued/expiry lease<=60seconds and revisions. Startup
  invalidates leases. Snapshots contain users/projects/agents/tasks/ceilings/
  policies, explicit disabled/revoked states and canonical protected scopes.
  Expired/missing/unreachable authority denies use before bytes leave broker.
  Snapshot format and exact record schemas owned by authority agent, documented
  in authority-contract.md before service/runner adoption. Returned acknowledgements
  pin accepted source,sequence,digest. No unsigned policy imports via HTTP.
  authorize(principal,{action,id,body,query,connection}) checks protected ceilings
  for enrollment/assign/manage; approval requires direct human. The production
  router invokes it before broker mutation. revalidatePolicy requires independently
  current exact policy revision/scope, never blanket true.
  issueWorkloadProof(workloadId,{grant_id,task_id,attempt,fence,...scope}) produces
  opaque internal proof usable only for issueSession; registration/current Controls
  and task epoch are checked again by eligible on every operation.
- configured-service.mjs: createConfiguredService({config,dependencies?}) returns
  start(),close(),addresses,health(). CLI main.mjs reads strict metadata config and
  private file paths; no credentials in arguments/env JSON/logs. Distinct HTTPS
  human, management and agent listeners; management/workload mTLS uses exact
  SHA256 cert fingerprint->role/ID mapping. Test-only transport injection must be
  explicit, never selected by production environment variables. Configured mode
  is supported by broker core with validated authority; existing synthetic tests
  remain compatible. No arbitrary authenticated fetch adapter.
- management RPC: POST /v1/dashboard with mTLS dashboard identity and Bearer
  delegation. Body {action,actor:{id},id?,body?,query?,expected?}; resolve user from
  delegation and reject actor mismatch. Same bridge actions/DTOs as checkpoint.
  No secret body, approval, session issuance or authority administration here.
  GET /v1/capabilities returns version,component build/compatibility,mode configured,
  intake_origin,intake_enabled,execution_enabled,actual reason; health fails closed.
  Authority snapshots POST /v1/authority/snapshot require authorized publisher mTLS
  PLUS independent signature. GET /v1/authority/challenge returns boot nonce.
  Worker POST /v1/workloads/session requires exact registered worker mTLS and
  {grant_id,task_id,attempt,fence,operations,resources,limits,expires_at,audience}.
  Returns once-only session bearer, never upstream/vault value.
- direct human operations: broker-origin routes for approval (exact digest review),
  permission proposals within independent ceiling, policy revalidation and operation
  reconciliation; cookie+CSRF+fresh proof. Intake handler retained one-shot.
  Session issuance is exclusively worker route in configured service.
- backend remote bridge: configured authenticated TLS client, strict version and
  health cache, no credential storage. Takes user's short-lived delegation via
  X-Broker-Delegation header (never cookies/logs/database). Metadata API rejects
  absent delegation; authenticated user ID must match independently validated user.
  Frontend obtains delegation only via broker-owned authenticated popup, exact
  configured origin/source checks and transient memory, never localStorage/URL.
  POST auth/delegations returns message only to exact configured dashboard origin;
  human login/consent separate from app proof. Existing UI callbacks retained;
  adapter availability comes from verified live configured capabilities.
- runner: standalone registered bounded worker over mTLS for session issuance,
  then normal agent HTTPS typed API. executeTask({task_id,attempt,fence,grant_id,
  connection_id,operations[]}) validates configured task only, exposes sanitized
  receipts; stops on cancellation, lease expiry, uncertain write, revocation or
  task end. Never automatically replays possible writes. Production integration
  exports backend task dispatch contract; no MCP run control or implicit starts.
  Durable task lifecycle + explicit human start gate separate from draft creation.
- recovery: stopped-service encrypted backup/restore CLI, private key file,
  authenticated encryption and manifest schema/config/version pins, atomic staging,
  symlink/permissions checks, no overwrite running store. Restored broker and authority
  remain quarantined until fresh independent signed state and exact policy review.
  No auto replay/session revival. Package service unit/examples are reviewed-paste
  inputs only, never installed by this task.

## Integration proof

Disposable OIDC issuer with real signatures/HTTPS, independent signed authority
publisher, mTLS dashboard/worker, real OpenBao2.6.2 and typed ledger. Prove login,
wrong issuer/audience/stale proof denial, enrollment, delegated metadata/grants,
exact human approval, registered worker, rotation/revoke/task end/feed outage,
restart and encrypted restore quarantine. No real IdP/host/service/key selection.
Production choices remain configuration/trust decisions, not a reason to leave
these generic components stubbed. Record limits without calling disabled features
implemented. Parallel owners must coordinate interface changes explicitly.

## Integrated readiness amendment

The independently signed task additionally requires `configuration_revision` and
`readiness:{guide_revision,checks_revision,environment_revision,execution_approved}`.
Positive revision pins identify reviewed source evidence; the independently
administered publisher verifies that evidence and explicit human execution
approval. The dashboard cannot author it. Existing approved guides may satisfy
the guide pin without a new approval cycle.

Registered-worker `POST /v1/workloads/tasks/readiness` takes the full typed runner
start request and returns `{contract_version,readiness}` with exact identity,
configuration, attempt/fence pins and a lease bounded by60s. Worker
`POST /v1/tasks/readiness` forwards this nonmutating check. Dashboard and worker
require matching current readiness before reserving start; actual session mint
repeats authority checks and requires `configuration_revision`. The public session
projects project/task/attempt/fence/scope pins for exact worker attribution.

Only one session can be reserved per task epoch. The reservation pins exact signed
user/project/agent/task/policy state, so an old session cannot become usable again
after a disable/re-enable or scope restoration. `POST /v1/workloads/tasks/:id/end`
with `{attempt,fence}` durably denies that epoch; acknowledgement requires
`{contract_version:'broker.v1',ended:true}`. Failed acknowledgement is explicit;
no completed upstream effect is undone. Worker restart never resumes a task.
