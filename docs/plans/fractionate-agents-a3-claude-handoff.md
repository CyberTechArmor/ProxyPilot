> **Archived input (2026-09-28).** This is the handoff that started the cloud
> session which implemented the A3 supervisor. Its state snapshot (09:32 UTC)
> is historical: the current state is in the
> [A3 reference](fractionate-agents-a3-reference.md), the dated sections of the
> [A3 evidence](fractionate-agents-a3-evidence.md) and the next work is the
> [A3 acceptance prompt](fractionate-agents-a3-acceptance-prompt.md).

# Claude handoff — finish Fractionate Agents A3

Copy this prompt to Claude Code in the ProxyPilot workspace. Snapshot verified
2026-09-28 09:32 UTC. Recheck mutable state before changing anything.

---

Finish **A3 — Isolated execution environment** for the first Fractionate
agent. The target is the synthetic sign-in workflow at
`https://demo.fractionate.ai`, not Nodus or a production credentialed agent.
Do the implementation and target proofs; do not merely restate the plan.
Keep A3 fail closed and call it incomplete until every required live gate
passes. Do not start A4 or any F item in this handoff.

## Canonical scope and status of every section

The official bounded plan is
`docs/plans/fractionate-agents-a1-a8.md`; the separate follow-on list is
`docs/plans/fractionate-follow-on-plan.md`. Older status paragraphs in
`FINISH.md`, the trackers and the original A3 continuation prompt are
historical when they conflict with the dated A3 evidence below.

| Step | Scope | Current status and boundary |
|---|---|---|
| A1 | Select the pilot, architecture, authority and acceptance contract | **Design complete**, merged through PR #676. The first workflow is synthetic sign-in at `demo.fractionate.ai`. Actual project, guide, human and run authority remain later gates; the demo website is not an agent deployment. |
| A2 | Operations project access, optional site origin and disabled agent profiles | **Implemented and merged** as PR #677 at `ade9a783d1b80058f8bbcd255872d229bfdd17bc`; migration 1106 is additive and the metadata gate defaults off. Profile creation does not start compute. |
| A3 | Selected VM/browser boundary, typed launch/stop, private workspace, egress/tool/resource limits and teardown | **In progress, not accepted.** Fail-closed groundwork from PR #680 is merged; PR #686 remains draft/unmerged. Live host fence, fixed-origin proxy, disposable Chromium and fixed cgroup probes now pass. Production supervisor, broker, human view/control and lifecycle proof remain open. |
| A4 | Contributor-scoped credentials, one provider, brokered access, revocation and spending | **Not started; gated by A3.** Do not introduce real secrets, model calls or vault bindings here. |
| A5 | Explicit durable, bounded execution loop and approval checkpoints | **Not started as a usable runtime; gated by A4.** A3 contains some durable run/attempt and broker contract groundwork, not an active loop. |
| A6 | Minimal Agents/Flightdeck supervision UI | **Not started; gated by A5.** Preserve current Dev Studio contracts. |
| A7 | Practice, interruption/recovery and explicit human takeover | **Not started; gated by A6.** A3 still must prove its own selected-worker human control and safe teardown prerequisites. |
| A8 | Reviewed deployment and one supervised pilot | **Not started; gated by A7 and deployment authorization.** The live demo website and A3 proof VM do not satisfy A8. |
| F1 | D5/RecapShare feasibility and bounded still import | **Deferred until after A8**; no importer or capture authorization. |
| F2 | Consented capture and further modalities | **Deferred until after F1**; no automatic capture, replay or inherited consent. |
| F3 | Cross-project shared Knowledge | **Deferred**; direct approved-guide assignment is enough for the first agent. |
| F4 | Richer practice, critique and learning | **Deferred** beyond A7's basic rehearsal; no self-approved guide changes. |
| F5 | Concurrent agents and scheduling | **Deferred**; A3 proves one selected worker first. |
| F6 | Advanced Flightdeck and broader workflows/providers | **Deferred** beyond minimal A6/A7 and the one pilot. |
| F7 | Remaining estate-wide migration, historical PR and release/retention work | **Deferred only when the selected A1–A8 pilot does not depend on it.** Pilot-specific SEC/INF, host-isolation and deployment blockers cannot be parked here. |

The canonical plan's old table still says A2 is pending; the dated PR/evidence
record supersedes that status. Preserve the sequence and the open original
finding IDs, especially S6/SEC-01/SEC-03/SEC-04 and applicable INF controls.

## Workspace and exact state to preserve

- Workspace:
  `C:/Users/thoma/Fractionate/OpenAI/Fractionate/ProxyPilot-batch-03`.
  Local branch `agents-a3-isolation-continuation`, HEAD
  `83387f7b1db277f84e3c83ec7a1a098518954cdd`, has intentional modified
  and untracked A3 work. Run `git status --short` and inspect the diff; do not
  reset, clean, overwrite, or accidentally commit the untracked
  `scripts/tests/a3-vm-probe.zip`.
- ProxyPilot live is clean `main` at
  `33528751b0b68771a768a69ef42c0bd614069498`. Its separate candidate
  is based on that SHA, 17 commits ahead, clean at
  `7851c1a0d6084213e842151d37083d49ff204dd8`. The candidate has not
  been promoted. It holds the installed-fence/proxy source and A3 proofs.
  Read `get_self_status` before every candidate edit or promotion.
- Required candidate checks at that exact head: `backend-tests` passed
  3,327 total / 3,316 pass / 0 fail / 11 existing skips; `backend-syntax`
  was skipped by the checker because no backend JS changed. The local A3
  Python suite passed 45/45. The candidate native `better-sqlite3 12.11.1`
  binding was repaired using `scripts/prepare-self-check-native.mjs` after
  `npm ci --ignore-scripts` removed it. `skip_install:true` preserved that
  repaired binding for the full unchanged suite; it did not exclude tests.
  Never weaken or omit required tests to pass promotion.
- GitHub PR #686 is **open, draft and unmerged** at head
  `cd4abbca6648dd9efda3c3c7e004bf44275d5861`, base SHA
  `d3de8659add2f41a26ec15fd1943c45704ac857a` when read. Local and
  candidate changes after that head are not represented by its old CI.
  Keep the PR draft/unmerged while any A3 gate is open; rebase/integrate
  only after reviewing the exact current upstream tree and migration range.
- The user says Nodus local sign-in works. Its Pomerium rollout is paused.
  Do not restart, upgrade, delete, reconfigure or use `pp-nodus` for A3.
  Do not modify `nodus.fractionate.ai` or its port 3000 route.

## Live A3 target and already accepted prerequisite proofs

The one disposable proof VM is `pp-agents-a3-debian13-proof-20260927`
(Incus name without `pp-`: `agents-a3-debian13-proof-20260927`), UUID
`49592202-a8b0-45af-9ac6-5439761d73e4`. Latest independent MCP read:
Incus 7.5.1, Debian 13.7, Running, guest boot ID
`b08210f9-fe81-4e86-9362-926f5ee21e59`, QEMU PID 272179, 2 vCPU,
4096 MiB configured RAM, 12 GiB root, no swap. Network `incusbr0`, host
TAP `ppa3proof0`, guest IPv4 `10.185.17.179`, gateway `10.185.17.1`,
guest NIC MAC `10:66:6a:55:f6:3f`. Autostart, guest API and nesting are
false. Preserve rollback snapshot `pp-mcp-pre-network-20260927-222658`.
Recheck identity, boot, resources, NIC and state before acting.

`proxypilot-a3-fence.service` is active/exited. Its persistent, host-owned
bridge nft fence passed Linux nft syntax and `systemd-analyze verify`.
Its unit orders before Incus startup, but reboot persistence and the future
supervisor's boot dependency have **not** been proved. The user
ran `scripts/a3-probe-fence.py` on the host: four raw-TCP SYN cases for
host and routed IPv4/IPv6 destinations each incremented the matching
drop counter by three packets, with no other counter increment. This
proves those packet drops, not the whole worker boundary. Do not rerun
the proof merely for ceremony; rerun if the fixture, firewall, NIC or
relevant network state changes. Do not bypass the runner's managed-LXC
refusal or broaden its allowlist to impersonate this VM.

`proxypilot-a3-origin-proxy.service` is active/running on
`10.185.17.1:18083`, restricted to `https://demo.fractionate.ai` with
the guest-pinned certificate SPKI SHA-256
`u8bIwg5KbrqCPaXpU5ab5KMDL5V48uLAjbFiVl8qyWI=`. User-run host
command `sudo python3 /var/lib/proxypilot/self/candidate/scripts/a3-probe-proxy.py`
passed on the above UUID/boot: two rejected CONNECT targets returned
403; approved `/` and `/api/session` returned 200; `/api/login`, wrong
Host and WebSocket upgrade returned 403. The guest observed certificate
DER SHA-256
`1cb08c27a9b45ecce54caede92daf329cd972c9c591e6415bdf9c891ae873e81`.
The previous `Proxy certificate changed` and `IndexError` errors were
probe defects, corrected in candidate commits `14bce981`, `be60664d`
and `7851c1a0`; the successful seven-case run supersedes them.

In the same conditional host command, `a3-probe-browser.py` passed three
nonroot Chromium cold starts without a `--no-sandbox` flag. Each produced
the synthetic Sign in DOM (8,694 bytes) with exit 0 at 0.659, 0.591 and
0.527 seconds. It reported sampled QEMU-tree baseline RSS 1,446,484 KiB
and peak 1,446,580 KiB. That fast sampled delta is **not** a credible
per-browser memory bound or final headroom conclusion; measure the
production workload over time. There is no human view/control proof.

The third command, `a3-probe-guest-cgroups.py`, passed five fixed transient
systemd probes: CPU quota throttled (2.243 s); 64 MiB memory limit
OOM-killed the process; `TasksMax=8` denied extra children; 2-second
runtime limit timed out; 16 MiB `/tmp` tmpfs denied a larger write.
Cleanup checks found the units inactive or failed as expected and their
cgroups unpopulated. These are selected disposable fixture limits, **not**
the production per-project/cumulative worker budget.

Every successful probe returned `worker_ready:false`. The live host fence
and origin proxy are prerequisites only. Do not label A3 complete from them.

## Implement and prove the remaining A3 boundary

1. **Reconcile before edit.** Read the full dated
   `docs/plans/fractionate-agents-a3-evidence.md`, this prompt, the official
   A1–A8 plan, A1 architecture/pilot contract/acceptance/source register,
   A2 evidence, original A3 prompt, `CLAUDE.md`, `../FINISH.md`, both adjacent
   trackers, the host-boundary inventory and applicable migrations 1100–1108.
   Capture current Git status, local/remote/base SHAs, PR #686 state, live
   and candidate state, host services, VM UUID/boot/PID, and pre-edit hashes.
   Historical claims in long records may be superseded by later dated entries.
2. **Build the independently owned production supervisor.** The current
   `createWorkerLauncher()` in
   `admin/backend/src/lib/operational-worker-boundary.js` still throws
   `BOUNDARY_UNVERIFIED` for launch and stop. Replace that only after a
   narrow host-owned launcher/stopper is installed and independently
   verified on this exact VM. Bind run ID, attempt ID, durable fence,
   policy digest, project policy revision, VM UUID and boot generation;
   admit one active attempt per profile. Do not expose caller-selected
   argv, URL, path, host shell, Incus/Docker API or raw browser endpoint
   to the model. Require the verified fence and proxy before launch.
   Install reviewed root-owned units/files transactionally with exact
   identity/readback, dependency verification and owned rollback; do not
   edit general host firewall tables or Incus profiles.
3. **Enforce the actual worker boundary.** Make a private per-attempt
   workspace and one browser process tree. Run the browser unprivileged
   with sandbox, constrained filesystem/devices/namespaces and no host,
   repository, evidence archive, management socket or broader network
   reach. Apply each configured CPU, memory, temporary-disk, process,
   runtime and action limit; keep absent project limits unbounded as
   *project policy* but retain finite VM capacity and safe OS limits.
   A configured limit below the measured worker minimum must refuse
   launch, not be silently raised. Pin total time/action budgets across
   restarts and attempts; renewal cannot reset them. Derive minimum VM
   sizing from repeated sustained browser/human-control measurements,
   including host QEMU+descendant RSS, CPU pressure, free disk, restart
   headroom and security-update/log growth. Resize only the failing
   dimension after recording evidence.
4. **Connect the typed broker without widening authority.** Preserve
   current per-attempt browser authority, exact action allowlist, durable
   action reservation and idle expiry; keep `submit_bound_fixture`
   unavailable in A3 (credential work is A4). Enforce the synthetic
   origin at the host fence/proxy as well as in browser routing. Refuse
   cross-origin redirects, subresources, DNS/raw-IP escapes, alternate
   hosts/ports, WebSockets and CONNECT bypass. Do not treat untrusted
   page DOM as an instruction or authority. Provide the smallest usable
   human view/control takeover path for this disposable sign-in without
   granting a general browser/debugging socket to the model.
5. **Prove negative and lifecycle behavior on the real VM.** Test direct
   host, management and routed egress over IPv4 and IPv6; forbidden host
   files, guest/host management sockets, raw network and unauthorized
   broker actions. Force configured CPU, memory, process, time, temporary
   disk and action overruns against the production launcher, not only
   transient fixtures. Demonstrate cancellation, lease expiry, stale
   fence, launch failure, supervisor/guest crash and host restart recovery:
   descendants die, workspace is removed, attempts cannot revive,
   uncertain browser effects are never replayed, and stop receipts are
   independently attested. Exercise real human view/control and takeover.
   Any failed proof stops activation and remains an explicit open gate.
6. **Verify and hand off.** Run affected native SQLite/HTTP/worker tests,
   local A3 Python tests, frontend build if UI changes, unsuppressed
   host-boundary inventory and required candidate checks. Do not skip
   tests or weaken a gate. For a submitted head, run exact-head Security
   CI and review the diff and migration compatibility. Update adjacent
   A3 evidence and top tracker status with commands, exact revisions,
   observed output/failures, limitations, operator commands and ordered
   rollback. Keep PR #686 draft/unmerged and A3/Operations activation off
   until all selected-worker gates pass and the user separately chooses
   integration/release. Stop before A4.

For local A3 Python regression use
`python -m unittest discover -s scripts/tests -p 'test_a3*py' -q` from the
repository root. On Windows set `PYTHONUTF8=1` before running
`python scripts/host-boundary-inventory.py` so console encoding does not
abort the unsuppressed inventory. The candidate's required gate is
`run_self_checks` on the exact candidate head (`backend-tests` plus any
other required check for changed files). If dependency installation drops
the native database binding, repair and verify the matching binding and
rerun the **full** backend suite; do not skip its database tests. Run the
repository's exact submitted-head Security regression workflow after
reviewing the PR integration. Record test counts and all existing skips.

## Interaction, safety and rollback

Use ProxyPilot MCP for readback, candidate patches, checks and supported
guest operations. It has no arbitrary host-root command. When host-root
execution is unavoidable, give the user **one exact copy/paste Host Terminal
or SSH command** with expected outputs and failure diagnostics; batch safe
dependent proofs with `&&`. Do not claim a user-run step happened until its
output is reviewed and independently corroborated where possible. Do not
repeatedly ask permission already granted for A3/this proof VM. The user
asked to avoid repeated back-and-forth. Never bypass managed-LXC runner
refusals, use `--upgrade-incus` or an Incus archive, or alter `pp-nodus`.

Keep rollback ordered and scoped: (1) leave A3 feature flags off and fence
new attempts; (2) stop the owned supervisor and verify its browser
descendants and private workspaces are gone; (3) remove only its
hash-verified owned artifacts; (4) if withdrawing origin access, run
`a3-install-proxy.py remove` and verify its listener/unit is gone while
retaining the VM fence; (5) stop this exact VM through supported MCP before
any fence removal; (6) use the owned fence installer removal only after
the VM is stopped, preserving unrelated nftables tables and services;
(7) use the named pre-network Incus snapshot only for a confirmed VM
regression after reviewing exact identity and data impact. Do not roll
back live ProxyPilot, touch Nodus or delete the proof VM by default.

The immediate next action is a design-and-code review of the current
worker/host integration surfaces and a concrete host-owned supervisor
implementation. The passing proxy, cold-browser and fixed-cgroup outputs
need not be repeated unless the relevant code, host fence/proxy, NIC,
VM boot or network state changes. Report each still-open proof honestly.
