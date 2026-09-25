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
