# Next section prompt — A2 project access and agent profiles only

Prepared by A1 on 2026-09-25. Do not execute merely by reading this file.
**A1 remains open: `demo.fractionate.ai` is the live-verified sign-in target
website with a public fixture account and sample CSV, but the exact Operations
project/final site/approved guide version and hash, human authority and proposed limits in
the [pilot contract](fractionate-agents-a1-pilot-contract.md) await approval.
The user will create the first project and specify its site. The
[project access and credential backlog](fractionate-project-credentials-backlog.md)
adds owner-selected visibility modes and contributor-owned secret intake;
this A2 section implements **project access and profile metadata only**.
This website deployment is not an A8 agent deployment. Optional document
delivery into an Operations project is outside the
initial sign-in acceptance unless explicitly selected.** Begin A2
only after that decision is recorded in the A1 pilot contract and the user
selects A2 as the next bounded section.

Workspace: `C:/Users/thoma/Fractionate/OpenAI/Fractionate/ProxyPilot-batch-03`.

## Read and preserve

Read the official [A1–A8 plan](fractionate-agents-a1-a8.md),
[A1 architecture](fractionate-agents-a1-architecture.md),
[acceptance matrix](fractionate-agents-a1-acceptance.md),
[source/dependency register](fractionate-agents-a1-sources.md), current A1 evidence,
the [repository evidence handoff](fractionate-agents-a1-evidence.md),
the [project access and credential backlog](fractionate-project-credentials-backlog.md),
adjacent `FINISH.md` and both trackers, current Git status/log, applicable
`CLAUDE.md`/`AGENTS.md`, Operations/evidence source and required security CI.
Inspect exact current guide/version/permission and account contracts; do not
trust prior line numbers or assume a clean branch. Record branch, HEAD, complete
status, relevant hashes and an exact pre-edit baseline. Preserve all existing
work and immutable migrations. Do not reset, clean, overwrite or silently
integrate an unrelated PR.

## Scope

Implement **project access policy and profile configuration only** for the
selected pilot:

1. Preserve the current rule that any eligible signed-in ProxyPilot account
   can create an Operations project and become owner. Add owner-controlled
   `hidden` (default), `read-only` and `collaborative` presets, modeled as
   discovery plus named membership capability. Implement the exact A1-approved
   meaning of each preset; discovery alone must expose only a redacted card
   and must never grant drafts, credentials, private events or agent run access.
   Add membership request/approval only if included in that reviewed preset.
   Keep the existing viewer/operator/editor/reviewer and independent guide
   approval rules. The owner cannot make a hidden project discoverable without
   an explicit reviewed change. Account loss, archive and revocation take
   effect on the next read/action.
2. Add stable opaque profile identity tied to an Operations project, with
   revision, display name, selected workflow type, proposed action/domain limits,
   budgets and exact approved guide assignment. Represent future run, worker
   and credential-binding relationships by IDs/contracts only where necessary;
   do not create those runtime records yet. Never identify a profile by an
   Infisical `agent` name, Dev Studio project ID or mutable display name.
3. Add native authenticated project-scoped CRUD/assignment APIs, strict schema,
   optimistic concurrency, transactional audit and current-account checks.
   Define the explicit configuration roles from the reviewed A1 pilot decision.
   Owner/admin status cannot bypass independent guide approval, archived
   project restriction or current account/grant checks. Reject cross-project,
   withdrawn/not-current guide and stale revision assignments. No authority is
   obtained from guide/evidence text.
4. Add an accessible minimal Operations access/profile UI for the permitted roles,
   using the existing API client/CSRF and `MOBILE_FIRST.md`. Show assigned
   version/hash, scope, disabled state, revision and meaningful errors. It must
   not imply that a profile can run. Creation/assignment changes metadata only.
5. Keep every new feature flag false by default. Make the schema additive and
   test rollback/older-writer behavior; retain all B1–B4 and D1–D4 history,
   manual runs, frozen evidence and immutable migration files.

## Acceptance and stop

Test positive and negative current-user authorization with native SQLite/HTTP:
nonmember, viewer, operator, editor, owner, platform admin without membership,
pending/deleted account, archive, guide withdrawal/supersession, cross-project
IDs, hidden project existence leakage, read-only/collaborative discovery,
membership request races, preset downgrade, stale `If-Match` and racing
grant/assignment changes. Assert no worker,
provider, credential or run side effect from profile creation. Test accessible
browser paths, keyboard and 360/375px completion, affected regressions and the
frontend build. Run required security CI on any submitted revision, without
inventory suppression. Record exact commands/results, hashes, diff, limits and
tracker changes in adjacent `agents-a2-evidence/`; cite historical checks as
historical. Write the bounded A3 prompt and stop for review.

No credential input/storage, vault sync or personal/organization Vaultwarden
write in A2. Those belong to the reviewed A4 phases. No provider calls, live
credential reads or provisioning, Infisical/OpenBao
agent registration, worker launch, runtime loop, feature activation, deployment,
host mutation, live account/application changes, D5 or shared Knowledge. Do not
commit, push, create/merge a PR or advance to A3 unless separately requested.
