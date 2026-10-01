# Bounded credential transfer and selected-consumer cutover

This is an operator-invoked execution library, not a production deployment or live
migration instruction. No module discovers legacy accounts, configures hosts,
uninstalls Infisical, edits networks, or reads secrets on import. The existing
`scripts/broker-migration-dry-run.mjs` remains metadata-only. Its mapping must be
reviewed and enriched with the exact execution contract below before transfer.

Implemented and proved: one OpenBao-source credential, one existing broker
connection rotated through its normal CAS/metadata/session invalidation path, and
one registered typed API read consumer. Generic injectable contracts support other
bounded integrations, but **an actual Infisical login/MFA/read/revoke adapter is
not implemented or proved**. These tests do not constitute Infisical retirement,
a live pilot, deployment approval, or the migration of a real consumer.

## Execution contract

`createMigration({statePath,source,target,legacy,consumer,authorize})` returns
`execute(proof,plan)`, `status(proof,id)`, `reconcile(proof,id)`,
`cutover(proof,id)`, `activate(proof,id)`, and `close()`.

The exact metadata-only plan has UUID fields `id`, `consumer_id`, `agent_id`,
`source_id`, `target_id`, `connection_id`, `grant_id`, `legacy_identity_id`,
`owner_id`, `project_id`; integers `source_version`, `target_cas`,
`consumer_revision`; and bounded `operations`, `resources`, `limits`.
`id` is the durable idempotency key. A reused ID with any changed plan is rejected.
No plan field accepts a secret, vault path, token, arbitrary URL, header, or code.
Operations profile/agent IDs and consumer registration IDs remain separate.

The independent `authorize(proof,{action,plan})` callback must verify the current
human decision, fresh proof, exact selected consumer/source/owner/target and grant
ceiling for `transfer`, `view`, `reconcile`, `cutover`, or `activate`.
For cutover/activation it must additionally require reviewed adapter/revocation
proof, backup/restore and rollback readiness, and the exact live-pilot decision
where applicable. A plain dashboard assertion or boolean from a submitted plan
is not sufficient. Tests inject disposable operator authority. This library is
not automatically wired into the configured service's human authority endpoints;
a live adapter must connect these decisions independently before exposure.

Required adapter interfaces:

| Adapter  | Contract                                                                                                                                                                                                    |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| source   | `version(source_id)` and `read(source_id,expected_version) -> {value,version}`; read requires exact source version and existing source authentication/MFA boundaries                                        |
| target   | `write(target_id,value,{cas,intent})`, `read(target_id,version) -> {value,version,intent}`, and `ready(plan,version) -> true` only for verified, current exact agent/grant/policy compatibility             |
| legacy   | `exclusive(identity_id,consumer_id)`, `revoke(identity_id,{consumer_id,migration_id})`, `proveDenied(identity_id,consumer_id)`; denial must be an observed authorization rejection, not a timeout or outage |
| consumer | `inspect`, revision-checked `disable`/`activate`, and a read-only `probe`; binding/revision/migration IDs must be durable and authoritative                                                                 |

## Transfer, uncertainty and recovery

Transfer reserves the plan durably before reading. Source version is checked
before/after the exact read, before send, and after target readback. Target write
uses explicit CAS and an intent marker. Verification compares values internally;
only versions, identities, state and receipts leave the trusted process. No
secret or reusable secret hash is persisted in migration metadata, stdout or
manifests. Values remain transient in the source/target process memory and vault.

The durable possible-write boundary is recorded before send. Exceptions, lost
responses, mismatches and interrupted states produce `reconcile_required`; calling
execute again returns the existing receipt without sending again. Reconcile is
observation-only: it rereads the pinned source and exact target version/intent,
then observes consumer binding and legacy denial. It never writes, revokes,
reactivates legacy authority, or repeats an uncertain operation.

`createOpenBaoMigrationIO` maps opaque IDs to exact server-owned KV paths and uses
already restricted OpenBao clients. Its current-version reader is separately
configured; it must not reuse the legacy identity that will be revoked.

`createBrokerRotationMigrationIO` supports an **existing connection** and an exact
preselected credential slot/revision/version. It calls ordinary `broker.rotate`,
retaining the broker's OpenBao CAS, readback, metadata transition and session
invalidation. A protected receipt maps the migration ID to the actual broker vault
intent after successful internal verification. Safe connection testing and grant
creation are separate explicit steps. Readiness checks the current connection,
credential version, user/agent/project grant, limits and expiry.

A crash after broker rotation but before the rotation adapter's receipt commits
stays blocked. It cannot establish exact intent attribution from matching names
or values and deliberately has no automatic retry. Inspect/reconcile the broker's
own enrollment state through its reviewed operator flow, then prepare a separately
reviewed plan/adapter registration pinned to the resulting revision/version. Never
remove the old receipt to rerun a possible write. This edge does not silently
roll back or reactivate anything.

## Consumer cutover and rollback boundary

`createTypedMigrationConsumer` is a concrete persistent registration for one
consumer, agent, connection, grant and resource. It performs only `item.read`.
Its broker callback uses a scoped broker session; the consumer interface receives
only the adapter-defined result. Secrets never enter consumer configuration or
state. Reopening with changed registration fails closed. It is a selected bounded
API consumer, not a host configuration manager or browser adapter.

Cutover revalidates transfer/readiness, verifies that the legacy identity belongs
exclusively to this consumer, and disables the consumer with an exact revision.
Only after observing disabled state does it revoke the selected legacy authority
and prove an actual denial. It then checks fresh activation authorization, enables
the exact broker binding, performs the read-only broker probe and verifies the
final binding again. Only then is the receipt `completed`.

An uncertain revoke leaves the consumer disabled. Reconcile can observe that the
old authority was removed; it reports `disabled/EXPLICIT_ACTIVATION_REQUIRED`.
A subsequent **explicit** `activate(proof,id)` rechecks current authorization,
source/target/grant versions, actual legacy denial and the disabled revision, then
performs one activation and final broker probe. It does not repeat revocation.
Unexpected running bindings remain `reconcile_required`, never falsely `disabled`.

There is no automatic restore of an old token, direct-read path, session or consumer
configuration. After legacy revocation, a broker outage means stopped/unavailable
work. Any rollback that would restore legacy access is a new separately authorized
change with its own exact scope and provider-side rotation decision. Source values
are retained; retaining them does not preserve the revoked consumer's authority.

## Evidence and limits

Run the unit and actual integration proofs explicitly:

```
node --test services/credential-broker/test/migration.test.mjs
node --test services/credential-broker/test/migration.integration.mjs
```

The integration starts the repository's digest-pinned disposable OpenBao 2.6.2
fixture and TLS ledger. It transfers a canary from an independent source slot via
actual broker rotation, verifies CAS version 2, tests the connection, cuts over the
concrete consumer, revokes its actual legacy OpenBao token and observes HTTP 403.
Subsequent work uses a scoped broker session and the typed ledger API; source data
remains readable to the separate migration identity. The test checks migration,
consumer, rotation-adapter and broker databases plus returned receipts for the
canary, and repeated calls for duplicate effects.

Unit tests cover wrong authority, changed source, CAS conflicts, concurrent calls,
lost write responses, restart reconciliation, wrong running bindings, registration
drift, uncertain revocation and explicit activation recovery. Fixture authority,
source provisioning/revocation and consumer registration are isolated test inputs;
no production source account, live network route, backup or real-pilot decision was
selected. Original A4 consumers and deferred A8 evidence are unaffected.
