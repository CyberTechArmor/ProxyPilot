# Next section prompt — A3 isolated worker boundary only

Prepared after local A2 implementation for review. Do not execute merely by
reading this file. A2 remains feature gated; confirm its exact
reviewed revision before starting A3. No project UUID or site origin is needed
to review A2. The user will create the first Operations project and enter its
site when ready.

Workspace: `C:/Users/thoma/Fractionate/OpenAI/Fractionate/ProxyPilot-batch-03`.

## Read and preserve

Read the official [A1–A8 plan](fractionate-agents-a1-a8.md),
[A1 architecture](fractionate-agents-a1-architecture.md),
[pilot contract](fractionate-agents-a1-pilot-contract.md),
[acceptance matrix](fractionate-agents-a1-acceptance.md),
[source register](fractionate-agents-a1-sources.md), A2 evidence and exact diff,
the current Operations schema/store/routes and the host-boundary inventory.
Read `CLAUDE.md`, `MOBILE_FIRST.md` if changing UI, adjacent `FINISH.md` and
both trackers. Capture branch, HEAD, complete Git status and pre-edit hashes.
Preserve B1–B4, D1–D4, migration 1100–1106 and immutable history. Do not reset,
clean or silently integrate another PR.

## Scope

Select one worker/browser target for the synthetic sign-in workflow and document
why its isolation boundary is enforceable on the intended host. Implement a
typed launch/stop contract, stable run and worker-attempt IDs, private
per-attempt workspace, narrow browser/network tools, one active attempt per
profile, durable lease/fence, cancellation and descendant teardown. The model
must have no host-root shell, management API, Docker/Incus socket, repository,
Dev Studio, evidence archive or unrestricted filesystem reachability. Enforce
the [pilot contract](fractionate-agents-a1-pilot-contract.md) worker limits at
the OS and broker boundaries: 1 vCPU, 512 MiB memory, 128 MiB temporary disk,
one browser process tree, five minutes and 20 browser actions. A missing or
unverified hard limit fails closed. Use disposable synthetic site/account data.

Treat A2 profiles and site/guide revisions as configuration and future authority
references only. A3 may add run/worker identity and lifecycle records necessary
for isolation tests, but must not start a provider-backed agent loop. Do not
read or store credentials, call a model/provider, connect Infisical/OpenBao or
Vaultwarden, provision live identities, activate A2/A3 flags, deploy, mutate a
host or live application, implement A4–A8, D5 or shared Knowledge. Optional
document delivery remains excluded from the sign-in pilot.

## Acceptance and stop

Prove the actual isolation boundary on the selected disposable target: forbidden
host files, management sockets and network destinations are unreachable; browser
actions cannot escape the typed broker; CPU, RSS, process count, time and disk
limits terminate an overrun; cancellation and crashes tear down descendants and
private workspace; a stale worker/fence cannot act or revive a run. Test launch
failure and restart recovery with no blind replay. Include positive synthetic
browser access only to the approved origin and negative redirect/egress cases.
Document where the target OS or sandbox cannot provide a claimed control.
Resolve or explicitly block the selected pilot's S6/SEC-01/SEC-04 dependency
with observed evidence, not configuration claims.

Run affected native SQLite/HTTP and worker tests, frontend build if touched,
and required Security CI for any submitted revision without inventory
suppression. Record commands, results, hashes, diff, rollback/older-writer
limits and target proof in adjacent A3 evidence. Write the bounded A4 prompt
and stop for review. Do not commit, push, create or merge a PR, activate a
feature or deploy unless separately requested.
