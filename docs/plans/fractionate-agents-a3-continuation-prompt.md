# Next work prompt — finish A3 isolation before A4

Do not execute merely by reading this file. A2 is merged as PR #677 at
`ade9a783d1b80058f8bbcd255872d229bfdd17bc`; its metadata gate remains
off. A3 is **not accepted**. Draft PR #680 is open at
`031883ba6d3105d4c4788bf2125c0dae3ce64e75`; Security regression run
`36241086515` passed at that head, but the disposable Debian VM failed the
required boundary checks. Recheck these revisions and the current `main`
before working. No Operations project UUID or live site is needed for A3.

Workspace: `C:/Users/thoma/Fractionate/OpenAI/Fractionate/ProxyPilot-batch-03`.

## Read and preserve

Read the official A1–A8 plan, A1 architecture, pilot contract, acceptance
matrix and source register; the A2 evidence and exact submitted diff; the
entire [A3 evidence](fractionate-agents-a3-evidence.md), draft PR #680 and
its exact diff; the host-boundary inventory; `CLAUDE.md`, adjacent `FINISH.md`
and both trackers. Read `MOBILE_FIRST.md` if changing UI. Capture branch,
HEAD, complete Git status, current `main`, PR head and pre-edit hashes.
The A3 checkout currently has an untracked `scripts/tests/a3-vm-probe.zip`;
account for it without deleting or committing it by accident. Preserve
B1–B4, D1–D4, migrations 1100–1108 and immutable history. Do not reset,
clean, silently integrate another PR or rewrite the reviewed A2 revision.

## A3 scope

Use one disposable Debian 13 Incus VM target on the intended host. The host
currently runs Incus 7.5.1; verify that again before using version-specific
controls. Use ProxyPilot MCP for host and guest operations, consistent with
the user's MCP-only direction. The generic VM created for earlier A3 probes
is stopped with autostart off and is **not** an isolated worker.

Complete an enforceable A3 launch/stop supervisor and typed browser broker.
Bind stable run/attempt IDs and a durable fence to the actual VM identity
and boot generation. Create a private per-attempt workspace, one active
attempt per profile, any project-configured deadline and action limit,
cancellation, crash recovery and descendant teardown.
The model must have no host-root shell, Incus/Docker or guest-management
socket, management network, repository, Dev Studio, evidence archive or
unrestricted filesystem reachability. Keep browser and network access on a
host-enforced, deny-by-default route to the one approved synthetic origin;
block redirects, subresources, DNS/raw-IP bypass, WebSocket and CONNECT
escape. Browser policy in application code alone is insufficient.

Enforce and measure one browser process tree and each configured CPU, memory,
temporary disk, time and browser-action limit. A best-effort root-disk resize,
guest-visible `free` result or configured `limits.cpu` alone is not proof.
If the target cannot enforce a configured limit or run a browser within it,
fail closed and document the observed blocker.

The current reviewed A3 head still contains illustrative 1-vCPU, 512-MiB,
128-MiB, 300-second and 20-action constants. The 2026-09-26 local follow-up
adds migration 1108 and project-owned optional limits; review its exact diff
and test results before continuing. An absent project limit is unbounded by
project policy. Pin the project policy revision, and enforce configured totals
across restarts and attempts. Lease renewal and checkpointing must not reset a
configured total. A worker or model cannot extend its own limits; a project
owner must change the policy, which fences the old worker. Use explicit
disposable test limits to prove enforcement without treating them as defaults.

The earlier VM allowed public egress, reached the Incus management port,
wrote 160 MiB to `/tmp`, spawned 32 children, remained up beyond five
minutes and timed out on both local and approved-origin Chromium DOM tests.
Resolve these observed failures on the actual target; do not substitute
the Windows browser fixture or an LXC result for VM proof.

Treat A2 profiles and site/guide revisions as configuration references.
Do not start a provider-backed loop, read/store credentials, call a model,
connect a vault, provision live identities, activate A2/A3 flags, deploy a
live agent, implement A4–A8, D5 or shared Knowledge. Optional document
delivery remains outside this sign-in pilot.

## Acceptance and handoff

On the disposable VM, prove approved-origin browser access and negative
host-file, socket, management-network, public-egress, redirect and broker
escape cases. Set disposable test limits and force CPU, memory, process,
time, disk and action overruns against those settings.
Prove cancellation and crashes remove descendants and private workspace;
a stale fence cannot act or revive a run; launch failure and restart recovery
do not replay an uncertain browser effect. Record actual observations and
explicitly leave S6/SEC-01/SEC-04 open for any control that cannot be proved.

Run affected native SQLite/HTTP and worker tests, frontend build if touched,
host-boundary inventory without suppression, and required Security CI for
every submitted head. Update adjacent A3 evidence with commands, results,
hashes, exact diff, target proof, rollback and older-writer limits. Reconcile
draft PR #680 with current `main` only through a reviewable integration and
fresh exact-head CI. Keep it draft and unmerged while any A3 gate remains
open. When A3 is accepted, use the existing bounded
[A4 prompt](fractionate-agents-a4-prompt.md) as the next section and stop
for review before A4 implementation.
