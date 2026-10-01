# Fractionate credential broker — cloud implementation reference

The local integration now includes a runnable configured broker and worker,
OIDC identity, signed authority, a concrete local authority source, remote dashboard
bridge, saved-agent typed execution and encrypted broker/worker recovery. It has not been deployed, configured with
real identities/keys, migrated a consumer or established A8 acceptance.
The private source handoff is retained separately; B0 is historical context.

## Delivered boundary

`services/credential-broker` is a standalone Node24 service with protected SQLite
state, separate enrollment/read AppRoles, fixed TLS typed upstream transport,
broker-owned human intake and approval, mTLS metadata/authority management and
scoped agent operations. The dashboard never receives an upstream credential.
It uses a transient independently authenticated delegation and separate mTLS
identity; neither credential can approve operations or sign authority records.

[Configured runtime](../../services/credential-broker/CONFIGURED.md),
[worker](../../services/credential-broker/RUNNER.md),
[authority](../../services/credential-broker/authority-contract.md),
[identity](../../services/credential-broker/IDENTITY.md),
[recovery](../../services/credential-broker/RECOVERY.md), and
[dashboard integration](../../admin/backend/BROKER_CONFIGURATION.md) define the
actual interfaces and private-file configuration. Production configuration is
absent, so intake/use stay disabled. Only disposable infrastructure is enabled
in tests. The service imports no privileged dashboard or host-provisioning module.

The dashboard adds separate draft API agent configurations without widening the
existing A4 synthetic-sign-in profile constraint. Project creation stays short;
Work, Connections, Controls and Review save a disabled draft. Approved guide reuse
uses existing version/hash semantics. Named operator-registered environments and
project-activity outputs can be selected. A saved eligible configuration prepares
a short-lived action proposal; a separate fresh-authenticated start consumes it
once and obtains current source and worker authorization. Missing registrations,
checks or unsupported workflows remain unavailable; saving never starts work. Inputs and supporting
material are bounded inert narrative strings in this slice, not dereferenced files.

Global and project Connections share broker IDs and ownership. Use, assign and
manage are distinct; assignments narrow authority. Removing one assignment keeps
the shared connection. Credential values enter only the broker-owned surface;
the dashboard exchanges intent/status metadata and never auto-replays secret input.
Browser/password/OAuth enrollment and scheduling remain unavailable.

## Local verification and demonstration

Use Node 24, Docker, OpenSSL and installed backend/frontend lockfile dependencies.
No live configuration or credential is required. The pinned OpenBao fixture is
`openbao/openbao:2.6.2@sha256:11fd73a2102cda9c55d5d881a8c3210303146a7ec1e8ac76f526e175c6d24641`.

```sh
npm test --prefix services/credential-broker
npm run test:integration --prefix services/credential-broker
node services/credential-broker/synthetic-demo.mjs --synthetic --prove-write
node --test scripts/tests/broker-migration-dry-run.test.mjs
# From admin/backend:
node --test src/__tests__/broker-*.test.js src/__tests__/operational-*.test.js src/__tests__/agent-run*.test.js src/__tests__/operations-toggles.test.js
# From admin/frontend, BROWSER_EXE points to an installed Chromium:
npm run build
node tests/broker-connections.browser.mjs
node tests/broker-integrated.browser.mjs
```

UI fixture journeys prove rendering/interaction only. The integrated browser test
uses actual Express routes, Operations SQLite, broker state, separate HTTPS intake,
real disposable OpenBao and TLS upstream. Identity remains explicitly synthetic.
The configured vertical integration additionally uses actual OIDC, independent
Ed25519 authority, role-pinned mTLS, real OpenBao and registered runner without
injected service dependencies. A further saved-agent proof uses actual file-backed
Operations state, approved-guide reuse, the private Unix source daemon, a
Keycloak-shaped HTTPS fixture, signed publication and the real worker/OpenBao path.
The local source option explicitly trusts backend metadata and fresh-start controls;
it does not protect against a compromised backend or host. See
[local authority source](../../services/credential-broker/LOCAL_AUTHORITY_SOURCE.md).
Keycloak production compatibility is still a deployment verification requirement.

## Review and release sequence

Review broker foundation, dashboard API/schema and UI changes independently, then
review the exact integrated commit and CI. Existing baseline migrations remain immutable;
new local allocations1113–1115 hold draft configurations, task metadata and
single-use proposals. Review any new
allocation against the eventual merge target before release.

Before production, decide exact broker/vault/identity placement and custody.
Protection from the root-equivalent dashboard host requires a separate privilege
domain plus independent human grant ceilings and current eligibility authority.
A same-host process only isolates the agent's access; it does not isolate secrets
from host administrators/backend. S6/SEC-01 remain open.

The generic identity/fresh-proof, registered-task authority, policy reconciliation
and encrypted stopped-state recovery are implemented and tested locally. The
self-contained source derives current metadata under explicit local-backend trust;
its signatures are not proof of independence from that backend. Choose
and verify the live identity/source/key custody and its accepted trust boundary,
operational supervision, retention and exact destination/port configuration.
Neither a backend signature nor synthetic cookies constitute real activation proof. Restored policy must remain quarantined until
independent current authority validates it. Do not use old database state to
silently revive revoked grants.

Only after release review and required CI, present the operator with an exact rollout,
rollback and first-consumer pilot. Host root actions remain reviewed guarded
pastes the operator runs, detached where long-running. No SSH/MCP workaround. Keep
pp-nodus, nodus routes, MEET/TURN, Incus snapshots, custody and receipt history.
Enable intake/use only after reviewed backend/broker/required consumer components
are deployed, healthy and contract-compatible. Rollback disables intake/use and
quarantines restored policy; it never retries uncertain writes or revives sessions.

Proposed first real adapter remains GitHub Issues read-only on one disposable
repository, with exact owner/resource/key permissions separately selected. This
implementation contains only the synthetic ledger adapter. Metadata migration
planning transfers no values. A bounded execution library and concrete OpenBao
source/broker-rotation/typed-consumer adapters now have disposable transfer and
cutover proofs; no actual Infisical authentication/MFA adapter is implemented.
Live human migration authorization wiring, transfer/cutover and legacy authority
retirement remain separate authorized work. See
[migration](../../services/credential-broker/MIGRATION.md) and
[worker recovery](../../services/credential-broker/WORKER-RECOVERY.md).

## Preserved limitations

Original pixels were unavailable in this cloud executor. The parent independently
compared revised screenshots with the supplied originals and returned concrete
layout corrections, incorporated here: project/detail balance, card scope grouping,
compact progression, complete modal/footer and workspace heading. Fresh final
three-theme/responsive screenshots are packaged separately from historical reports.
Final visual acceptance remains the operator’s; no pixel/font-metric identity is claimed.

A8 runner/readback confirmations and saved A5/recovery/rollback/off-host-backup
proofs remain deferred. No historical or skipped test is counted as fresh evidence.
No real-key pilot, production activation, migration, PR publication or acceptance
is implied by this local result. OAuth, general browser credentials, dynamic DB
credentials, transparent interception, broad SDK compatibility, personal-vault
imports and whole-Infisical retirement remain outside the slice.

## Color themes

Midnight retains the existing dark palette/default; Latte supplies warm ivory,
charcoal and muted gold; Office supplies white/cool surfaces and blue actions.
All share fonts, icons, components and geometry. The existing `pp-theme` preference
is retained, including legacy dark/light migration and pre-paint application.
New broker form outlines/errors use semantic roles borrowing existing palette
colors to meet contrast thresholds. No external brand name or logo is imported.
See `admin/frontend/THEME.md` and the evidence document for measurements.

## Entity deployment investigation

Keycloak is the operator’s intended identity provider; no live provider is configured.
See [entity deployment compatibility](fractionate-openbao-broker-deployment-options.md)
for the fit of per-entity instances and the explicit additional work a limited
central control plane would require. Existing browser pilot evidence remains separate from the new API proof.
