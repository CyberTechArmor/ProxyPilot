# Fractionate credential-use broker

This standalone Node24 service supports an isolated synthetic harness and a
configured runtime with OIDC identity, independently signed authority, restricted
OpenBao AppRoles, protected state, direct human intake/approval and registered
mTLS workers. Configured mode is accepted only with the branded verified authority
implementation. The first adapter remains the typed static-token synthetic ledger.
No production configuration, real-secret deployment or acceptance is implied.

Start with [configured service](CONFIGURED.md), [identity](IDENTITY.md),
[independent authority](authority-contract.md), [worker](RUNNER.md), and
[encrypted recovery](RECOVERY.md). Dashboard configuration is documented in
[the backend guide](../../admin/backend/BROKER_CONFIGURATION.md).

S6/SEC-01 remains open: a process on a root-equivalent dashboard host cannot
protect values from that host. Placement, independent source/key custody, real
IdP mapping, retention and exact pilot scope remain release decisions.

## Run the disposable proof

Prerequisites: Node >=24 (built-in `node:sqlite`), Docker daemon, and OpenSSL.
No npm dependencies or package installation are required.

```sh
cd services/credential-broker
npm test
npm run test:integration
node synthetic-demo.mjs --synthetic
node synthetic-demo.mjs --synthetic --prove-write
```

The last command explicitly enables a synthetic approved write. The demo creates
an isolated in-memory OpenBao container, TLS ledger, protected policy DB and TLS
agent listener; enrolls a generated canary; grants a single synthetic consumer;
and prints only typed receipts. The consumer sees a scoped bearer and connection
ID, never an OpenBao identity or upstream value. All listeners bind loopback with
exact fixture address exceptions. Finally it removes its labelled container and
private temporary directory. No live network mapping, real key, dashboard run,
A4 binding, production host or installed OpenBao configuration is changed.

Fixture OpenBao pin:
`openbao/openbao:2.6.2@sha256:11fd73a2102cda9c55d5d881a8c3210303146a7ec1e8ac76f526e175c6d24641`.
Eight opaque credential slots are allocated and exact data/metadata ACL paths
are provisioned **before** the broker starts. Ordinary requests cannot provision
policies. Reader and enroller use separate AppRoles; the reader cannot write,
provision or read another credential path. Synthetic root/unseal material exists
only in fixture memory and is never used by the broker execution client.
The helper accepts `{owner,project,agent,resource}` for a shared synthetic UI
harness; it is not a production provisioning API.

## Modules and integration

- `broker.mjs`: `createBroker({dbPath,vault,upstream,authority,clock,mode})`.
  `dbPath` must be in an owned mode-0700 directory. The protected single-instance
  SQLite DB holds references, policy, hashed bearer verifiers, events, approvals
  and durable operation state, never credential values.
- `openbao.mjs`: `createOpenBaoClient({transport,roleId,secretId,mount,clock,canWrite})`.
  Tokens remain in memory, expire according to server TTL with a conservative
  300-second cap, and reauthenticate only before a new request. Failed requests
  are not replayed. Reads verify current KV metadata/version/deletion before
  retrieving the pinned value. Bootstrap rotation alone does not revoke tokens.
- `transport.mjs`: `createTransport` pins validated DNS answers to TLS sockets,
  refuses redirects, encodings, ambiguous paths, duplicate response headers,
  unknown adapter fields, oversized/slow responses, and invalid certificates.
  IPv6 is intentionally unsupported in this first adapter. Public IPv4 defaults
  to port443; the fixture override is exact hostname/address/port plus test CA.
- `server.mjs`: `createAgentServer({broker,key,cert})` exposes only
  `POST /v1/operations` and `GET /v1/operations/:id`. No vault, management,
  enrollment, session-minting or dashboard run-control route is exposed.
- `intake.mjs`: independently authenticated broker-owned enrollment/rotation
  page and one-shot submission. See [INTAKE.md](INTAKE.md) for exact routes,
  intent status recovery, CSRF, origin, fresh proof and secret clearing.
- `consumer.mjs`: `createSyntheticConsumer` provides the bounded agent API.
- `fixtures/disposable.mjs`: reusable real OpenBao/TLS upstream fixture.

Every management method takes an independently verified opaque human proof as
its first argument; an agent bearer never qualifies. `authority.authenticate`
returns `{user_id,fresh_until,disabled?}` and must check current account state.
`authority.canAssign(principal,target)` verifies current target agent/project
control; `authority.eligible(session)` verifies current user, project, agent,
task, attempt and fence before every operation, and again before transport send.
In synthetic mode these dependencies are explicit test fixtures. Configured mode
uses identity.mjs and authority.mjs, requires signed current eligibility and
checks protected ceilings. Dashboard assertions alone are never sufficient.

Core async signatures:

```js
broker.enroll(proof, metadata, credential, externalIntentId = null)
broker.enrollmentStatus(proof, externalIntentId)
broker.reconcileEnrollment(proof, connectionId, revision)
broker.testConnection(proof, connectionId, revision)
broker.rotate(proof, connectionId, revision, credential)
broker.rename(proof, connectionId, revision, name)
broker.revoke(proof, connectionId, revision)
broker.detail(proof, connectionId)
broker.listConnections(proof, { project_id })
broker.listAssignableConnections(proof, { project_id, agent_id })
broker.activity(proof, connectionId)
broker.assign(proof, connectionId, revision, grant)
broker.unassign(proof, grantId, grantRevision)
broker.setPermission(proof, connectionId, revision, permission)
broker.issueSession(proof, grantId, taskScope)
broker.approve(proof, sessionId, operationRequest)
broker.execute(bearer, operationRequest, idempotencyKey)
broker.getOperation(bearer, operationId)
broker.reconcileOperation(proof, operationId, decision)
broker.revalidatePolicy(proof, connectionId, revision)
```

Use the shared `contracts/credential-broker/README.md` for request fields.
Timestamps in the standalone API are epoch milliseconds. `manage_actions` on
delegated permission records enumerates `test`, `rename`, `rotate`, `revoke`;
only the owner changes permission grants. Delegation of use is separate from
assign. Projections hide other users' sessions/assignments from nonowners.
There is one catalogue, with filtered project and global views.

## Durability and limits

Operation reservation, approval consumption and task-budget reservation are one
SQLite transaction. Sending is persisted before any transport is handed a value.
Final authorization runs after TLS handshake and before writing request bytes.
Revocation during vault/DNS/TLS waits prevents a subsequent send. Revocation
cannot undo a request already accepted by the upstream. Writes that may have
sent become `uncertain`; no automatic retry occurs. Reusing the same session's
idempotency key returns the durable receipt; a changed digest conflicts.
A new linked recovery requires owner reconciliation `confirmed_not_applied`
and a fresh exact approval. `confirmed_applied` and `abandon` never authorize
recovery. Approval expiry remains enforced at final send.

Limits: one executing operation per connection; 10 reserved operations per
connection/minute; at most20 actions for a task/connection across sessions;
sessions at most300 seconds; approval at most120 seconds; 16KiB request,
32KiB upstream response, 5-second transport deadline. This adapter has no
monetary cost and reports `not_applicable`, not a fabricated zero charge.
Finite output is matching resource UUID, `open|closed`, and write `applied`.
Secret echoes in headers are discarded; unknown/raw/encoded body fields and
errors never reach consumers. This does not make arbitrary upstream text safe.

## Recovery and rollout boundaries

Startup revokes every saved session/approval, converts possible sends to
`uncertain`, marks incomplete enrollment for reconciliation and quarantines
all saved connection policy. Fresh sessions remain blocked until the owner
explicitly calls `revalidatePolicy` and independently configured
`authority.revalidatePolicy(principal,{connection})` affirms current policy.
This prevents a restored old DB silently reissuing authority. Reaffirmation
must compare an independently held current policy revision/grant ceiling; the
public snapshot supplies policy_revision, not a permission-editing interface.
A permissive synthetic callback proves mechanics only. Local owner proof alone is not
enough. Configured authority requires an exact independently signed current policy.

An unclean process death deliberately leaves a lock. After proving the process
has stopped, an operator can call `recoverStoppedStore(path)` (and
`recoverIntakeLock(path)` for intake). These refuse a live PID; they do not auto
steal locks. A SIGKILL test exercises this path. For backups, stop the service
and preserve the SQLite DB with its WAL plus intake state in protected encrypted
operator custody. Restores must retain startup quarantine, independently
reconcile current policy and vault versions, and review uncertain operations.
The encrypted backup/restore module and disposable restore proofs are implemented;
off-host transport and a production restore have not been performed.

Release order: exact commit review and CI; independent host/custody/intake
choice; reviewed scoped provisioning and restore rehearsal; backend/broker/
consumer compatibility proof; then explicit real-pilot decision. Production
host root changes remain reviewed pastes the operator runs. Rollback disables intake
and use, revokes capabilities and restores reviewed configuration; never replay
uncertain operations or revive revoked sessions. No deployment script is
provided that bypasses these decisions.

## Evidence and known limits

Cloud verification: Node24.19.0; Docker28.4.0; OpenBao2.6.2 digest above.
The historical synthetic checkpoint had27 unit/security checks and one real
OpenBao proof. The configured extension adds signed identity/authority, mTLS,
worker and encrypted recovery tests, plus a no-injection full configured
OpenBao integration. See the implementation evidence for current counts.
The original real OpenBao proof includes including reader write/provision/other-owner and
unlisted-same-owner denial, CAS conflict, out-of-band version mismatch, agent
bearer denial, typed results, echo/redirect/size/encoding refusals, rotation,
revocation and one uncertain write effect without resend. Demo proves TLS
agent→broker→TLS upstream with vault retrieval. No deployed/pilot acceptance
claim follows from these local tests.

[Official AppRole documentation](https://openbao.org/docs/2.6.x/auth/approle/)
and [KV v2 documentation](https://openbao.org/docs/2.6.x/secrets/kv/kv-v2/)
are protocol references; exact pinned2.6.2 behavior is checked against the real
container. Installed production versions were not inspected.

Not configured or deployed: real IdP/source custody, provisioning, live resources
or host services. Not implemented: multi-instance leases, arbitrary adapters/
browser/OAuth, real migration/cutover, off-host backup transport, immutable audit
claims or production retention automation.
Operation/event records are durable but administrator-modifiable; retention
must be selected before real secrets. Original UI visual acceptance belongs to
the dashboard workstream. A8 deferred evidence and S6/SEC-01 remain unchanged.
