# Operations projects, credentials and sharing — phased backlog

Status: **A1 design backlog; implementation pending** (2026-09-25).
The user will create the first Operations project and enter its site through
the project interface when ready. A2 adds the dedicated optional site origin
field because current Operations projects have only name/description. Project
and disabled profile creation do not require a site. The exact
`ops_projects.id`, selected origin and approved guide version/hash are checked
before an authorized run. The deployed `demo.fractionate.ai` remains an
available synthetic target; never silently use it as the user's project site.

This backlog refers to **Operations** projects (`/operational-projects`). Dev
Studio (`/projects`) has different IDs and grants. A current eligible ProxyPilot
`user` or `admin` can already create an Operations project and become owner;
this does not yet grant access to another user's project, a vault, or an agent.
Project sharing, credential storage and agent use are separate grants.

## Recommended project access model

Use two independent controls: **discoverability** (can a nonmember find the
project?) and **member capability** (what can a named member do?). A project
display name, tag or open discovery state must never grant credential access.
The owner selects one preset and may still assign narrower named roles.

| Owner-facing preset | Discovery | Default project access | Changes and safeguards |
|---|---|---|---|
| **Hidden** (default) | Only current members can find it. Nonmembers get no title, site, tags or existence confirmation. | Named members only, with the existing viewer/operator/editor/reviewer roles. | Owner grants access individually; existing independent guide review stays required. |
| **Read-only** | Eligible signed-in users can find a redacted project card and request access; optionally they may read nonsecret project material after the owner enables that separately. | Proposed default is **request/approval**, not automatic membership. | Read-only never reveals guide drafts, credentials, run private content or membership roster merely by discovery. |
| **Collaborative** (user's “manage openly”) | Eligible signed-in users can find the project and request to contribute. | Proposed default is owner-approved membership; approved editors/operators can work within their existing role. | No automatic owner, credential, guide-approval or agent-run authority. A broader automatic-join option is a distinct reviewed policy choice. |

The existing Operations roles are `viewer`, `operator`, `editor`, `reviewer`
plus owner. Keep those role names for capability; add a separate discoverability
setting and explicit membership requests rather than inventing a role named
“open.” Owners manage membership; independent reviewers approve guide bytes.
An archived project cannot accept new members, credentials, profiles or runs.
Apply account eligibility and current grants on every read/write, with
optimistic revision, audit and cross-project denial. Changing a preset must
show the exact visibility expansion before save and never widen secret grants.

## Credential model and destination contract

Each credential has a stable opaque ID, `ops_project_id`, **contributor user ID**,
type (`website-login`, `api-key`, etc.), target origin/account hint, version,
status, owner-selected classification, and redacted destination receipts.
ProxyPilot stores references, policy, revision and audit metadata; no plaintext
value, vault token, session cookie or recovery secret in its project database,
search index, guide, event or agent prompt. The contributor enters the value
through an authenticated, CSRF-protected flow with fresh proof. New credentials
start **private to that contributor** even in a collaborative project.

Recommended source of truth for a **project/agent credential** is a dedicated
OpenBao KV v2 path scoped by project and credential ID, with compare-and-set
versioning. Use stable opaque path segments; OpenBao warns that paths/names are
not secret. A named person's personal vault remains their own separate copy,
not an administrator-readable project store. Do not reuse the current
`agents/<name>` path or an Infisical `pp-agent-<name>` project as an Operations
project namespace. The existing OpenBao AppRole and Infisical Agent Proxy
management APIs are references, not ready project credential grants.

**Per-credential destination selection:** OpenBao is the requested initial
write. Replication to an explicitly scoped Infisical project and an optional
Vaultwarden destination is a queued, independently authorized action with a
receipt per destination (`pending`, `synced`, `failed`, `revoked`). A success UI
must say which destinations actually match the OpenBao version. Retry by
credential ID/version and idempotency key; reconcile partial writes. Rotation
creates a new version, updates permitted destinations, invalidates agent
bindings and reports any stale copy. Revocation removes future broker use and
starts destination-specific revoke/delete where supported; it cannot make a
recipient forget a previously viewed password. Rotate the upstream account
credential after removing a recipient who knew it.

Infisical free edition's existing Agent Proxy identity is Admin of **its own**
project and can read those secrets. Use a dedicated per-consumer/project scope
and explicit approved site allowlist; never infer non-disclosure from a proxy
placeholder. Administrator re-authentication and MFA boundaries in the current
integration remain. Do not sync personal human credentials into a machine
identity's project by default.

Vaultwarden/Bitwarden personal vault items are encrypted by the person's
client-held key. A ProxyPilot server-side OpenBao write **cannot by itself**
create an item in that person's personal vault. Phase P4 must prove an
authenticated contributor-side import/confirmation path or an explicitly
authorized organization collection path using the reviewed Vaultwarden version.
An organization collection changes ownership and can expand access; the UI
must display that transition and require an exact recipient/collection choice.
If an adapter cannot preserve person-specific ownership and access, leave that
destination `pending` and do not claim a completed cascade. No server capture
of a person's Vaultwarden master password or unlocked vault key.
This proposed OpenBao-first project flow also differs from the current Full
Platform guide's direction to enter personal vault secrets only in
Vaultwarden. Treat it as a new product contract for specifically selected
project/agent credentials, with explicit ownership and consent; do not silently
migrate existing personal vault items or change platform bootstrap secrets.

Search is **permission-filtered metadata only**: accessible project, label,
site origin, account hint, owner/contributor, purpose, type, tags and sync
status. Never index or return secret values, hidden project names, private
Vaultwarden item names, or names of credentials outside the viewer's scope.
Sharing selects exact recipient user/group, permission (`use-without-reveal`,
`view`, `manage`), expiry and reason. `use-without-reveal` requires a proven
broker/proxy path; do not offer it for a destination whose reader can fetch the
value. Share, revoke, reveal and use are separately audited. Project membership
alone never creates a credential share.

## Delivery phases and tags

| Phase / tag | Bounded result | Exit evidence | Planned place |
|---|---|---|---|
| **P0 `A1/design`** | Fix the synthetic sign-in scope and safe defaults: hidden project, owner-approved membership for discoverable presets, per-credential destination selection and no implicit secret sharing. | A1 architecture, pilot contract, acceptance matrix and executable A2 prompt. Project/site/guide/human IDs are deferred to configuration and run authorization. | A1 design complete; no agent implementation. |
| **P1 `A2/project-access`** | Add optional owner-managed site origin input, owner-controlled discoverability preset, membership requests/approvals, redacted directory, and project-scoped disabled profile configuration. Keep create-project available to eligible accounts. | Cross-project, hidden-name, invalid/changed site, stale-grant, archive, admin-bypass, accessibility and migration tests; no vault/worker side effects. | A2; no first-project or site prerequisite. |
| **P2 `A4/openbao-intake`** | Contributor-specific credential record and fresh-proof input; OpenBao scoped write/readback/version, no plaintext persistence, rotation and revoke contract. Agent binding is a separate least-authority grant. | Disposable OpenBao positive/negative ACL, CAS race, failed write, leak scan, backup/restore and revocation evidence. | A4 after A3 isolation proof. |
| **P3 `A4/infisical-sync`** | Explicit per-credential Infisical destination, scoped identity, site allowlist and durable sync receipts. | Free-edition authority check, partial failure/retry, version drift, recipient and revocation tests. | A4 integration slice; no automatic broad copy. |
| **P4 `A4/vaultwarden-handoff`** | Prove contributor-side personal import or exact organization collection sharing; show per-destination status and recipient/ownership transition. | Disposable Vaultwarden client/version proof, no master-key custody, wrong-recipient and offline/revocation tests. | A4 integration slice; block claim if infeasible. |
| **P5 `A6/search-share`** | Permission-filtered metadata search, explicit sharing/reveal/use UI and audit; supervisor sees only authorized references. | Hidden-project/secret non-disclosure, grant loss, indexing, expiry and accessible browser tests. | A6, with store/API groundwork in A2/A4. |
| **P6 `A8/release`** | Exact deployment-target credentials, current authority, backup/restore, audit, rotation and one supervised pilot. | Fresh SEC/INF and real-target isolation, destination consistency and rollback proof; separate live authorization. | A8; demo website deployment does not satisfy this. |

Do not absorb all phases into the next A2 implementation. P2–P4 are separate
security-critical integrations within the existing A4 section and may require
multiple reviews. A full personal-vault cascade is a **feasibility gate**, not
an already available feature. If the first sign-in pilot uses only the public
fixture, it may proceed through A2–A8 without P3/P4 after the user approves a
smaller credential scope; the broader vault backlog remains visible.

## Broker boundary and expanded capabilities backlog - 2026-10-02

Thomas requested that boundary confirmation and the expanded capabilities remain
visible backlog. **Boundary confirmation is not accepted; no broker activation,
credential enrollment, host deployment or real-service pilot is authorized by
this record.** The successful dashboard update is not broker acceptance. The
earlier A1/P0-P6 plan above is retained as historical scope; the current broker
implementation and its limits are described in the
[implementation reference](fractionate-openbao-broker-implementation-reference.md).

| ID | Deferred item | Required decision and completion evidence | Status |
|---|---|---|---|
| CB-01 | Confirm the credential-use trust boundary | Choose protection from an agent/VM only with explicit backend/host-root trust, or protection from a compromised backend/host. Record exact broker/vault/identity/authority placement, administrators, key/bootstrap custody and access paths. The implemented `local_backend_authority` source trusts backend metadata and host root; its signature is not independence. A stronger boundary needs separately controlled custody, signing and current project/task/policy authority outside the backend's root/hypervisor domain. Demonstrate backend policy/grant/task forgery denial, actor/certificate mismatch denial, current eligibility/revocation/lease expiry, restricted vault ACLs, secret-free outputs and restored-policy quarantine. Same-host containers/VMs, TLS, a checkbox or deployment assertion alone are not acceptance. S6/SEC-01 remain open. | Backlog; not confirmed or accepted |
| CB-02 | Configured broker/worker installation and bounded activation | Select exact Keycloak issuer/client/subject mapping and fresh-proof level; broker-owned intake/approval origins; TLS/mTLS identities; restricted enrollment/read AppRoles and opaque slots; registered worker and source; private state/retention/recovery. Verify compatible components and live readiness before enabling intake/use. Existing Keycloak/OpenBao and the Go host agent do not install the new Node broker/worker. Present a reviewed scoped rollout/rollback after those decisions; preserve existing A4, routes, custody and evidence. | Backlog; no activation paste selected |
| CB-03 | First real typed API adapter and pilot | Only `synthetic-ledger-v1` exists. GitHub Issues read-only on one disposable repository remains a candidate, not an implemented adapter or selected live resource. Decide exact service/resource, minimal credential permissions, typed operation/result schemas, TLS/egress policy and owner. Prove allow/deny, leak/echo, revocation, uncertainty and recovery behavior before a separately approved real-key pilot. Broader API/provider adapters require individual scope and review. | Backlog; real adapter/pilot absent |
| CB-04 | Broader browser, website-password and OAuth connection support | Define provider-specific authorization, human consent/account binding, refresh/revocation/MFA and browser isolation contracts. Do not equate broker OIDC human login with an upstream OAuth adapter. The existing bounded A4 synthetic browser sign-in remains separate; it does not authorize general browser/password/OAuth enrollment. | Backlog; preserve existing pilot |
| CB-05 | Real consumer migration and legacy-authority retirement | Plan exact live human authorization, transfer, verification, revoke/denial, cutover and rollback; no uncertain write replay. Disposable migration mechanics are not live migration acceptance. Actual Infisical authentication/MFA integration, per-destination consistency and retirement need separate implementation/review; preserve P3/P4 feasibility and ownership decisions. | Backlog; no live migration |
| CB-06 | Multiple instances, entities, workers and concurrent work | Define multi-instance leases, isolation, queue fairness, budgets, per-run cancellation, and per-entity identity/custody/routing. Current dashboard configuration selects one broker and one worker; there is no fleet router, central registry or hard shared-tenant boundary. Keep the optional future management platform separate from self-contained ProxyPilot. | Backlog; link F5/F6 |
| CB-07 | Additional credential classes and integration breadth | Separately assess dynamic database credentials, transparent interception, broad SDK compatibility, personal-vault imports/organization ownership and wider provider support. Do not promise use-without-reveal for an identity that can fetch the value, capture personal vault keys, or treat whole-Infisical retirement as delivered. | Backlog; feasibility and consent required |
| CB-08 | Production recovery, retention and audit guarantees | Map protected broker/worker/source state and private identity/custody backups, off-host encrypted transport, isolated restore/revalidation, uncertain-operation handling, retention and verified erasure. Existing durable events are administrator-modifiable; append-only or immutable audit claims need a defined threat model and independent tamper evidence/custody. A8 deferred proofs and outstanding SEC/INF findings remain visible. | Backlog; production guarantees unaccepted |

Boundary implementation contracts:
[configured service](../../services/credential-broker/CONFIGURED.md),
[independent authority](../../services/credential-broker/authority-contract.md),
[local source trust](../../services/credential-broker/LOCAL_AUTHORITY_SOURCE.md),
[worker](../../services/credential-broker/RUNNER.md), and
[deployment compatibility](fractionate-openbao-broker-deployment-options.md).
Recording CB-01 does not select either trust option, provision a service or close
the host-root finding. Reconfirm current deployment facts when that work is scoped.

The separate guide ingestion/AI conversion and durable run-history architecture
request is recorded as F8/F9 in the
[official follow-on plan](fractionate-follow-on-plan.md#guide-ingestion-and-run-history-architecture---2026-10-02).
It must preserve permission boundaries and provenance rather than turning a
knowledge index, uploaded document or generated guide into credential authority.

## Source notes

- Local `docs/features/operations.md` and
  `admin/backend/src/lib/operational-projects-logic.js`: eligible accounts can
  create projects, existing roles/grants and independent guide approval.
- Local `docs/features/agents.md`: current OpenBao agent AppRole and Infisical
  free-edition Agent Proxy boundaries; these are machine integration APIs.
- [OpenBao KV v2](https://openbao.org/docs/2.5.x/secrets/kv/): versioning and
  check-and-set; use opaque paths because [KV paths are not obscured](https://openbao.org/docs/secrets/kv/kv-v1/).
- [Bitwarden encrypted vault data](https://bitwarden.com/help/vault-data/):
  client-held key model; [organization collections](https://bitwarden.com/help/collection-management/)
  and [individual-vault ownership](https://bitwarden.com/help/onboarding-and-succession/)
  have distinct access semantics. Vaultwarden compatibility and exact API must
  be demonstrated on the pinned managed version before implementation.
