# A3 reference: current state for any conversation

Snapshot: 2026-09-28, after the cloud session that implemented the host-owned
worker supervisor. This file is the orientation page. The dated
[A3 evidence](fractionate-agents-a3-evidence.md) sections are the record, and
the [A3 acceptance prompt](fractionate-agents-a3-acceptance-prompt.md) is the
next work. Recheck every mutable value below (SHAs, services, VM boot) before
acting. If this page and a later dated evidence entry disagree, the evidence
wins.

**Status in one line:** A3 is implemented but **not accepted**. The supervisor
has not been installed on the host and the target proof has not run. Every
gate stays open and fail-closed until `a3-probe-worker.py` passes on the proof
VM and its output is reviewed.

## Read first

1. This page, then the last two dated sections of the
   [A3 evidence](fractionate-agents-a3-evidence.md) ("2026-09-28 host-owned
   worker supervisor" and "Submission state").
2. The official [A1–A8 plan](fractionate-agents-a1-a8.md) and the
   [follow-on plan](fractionate-follow-on-plan.md).
3. [A1 architecture](fractionate-agents-a1-architecture.md) (trust boundaries,
   takeover rules), [pilot contract](fractionate-agents-a1-pilot-contract.md),
   [acceptance matrix](fractionate-agents-a1-acceptance.md).
4. [Host boundary](../core/security-host-boundary.md) (S6, and the A3
   supervisor contract paragraph), `CLAUDE.md` (A3 gotcha).
5. Historical inputs: the [archived Claude handoff](fractionate-agents-a3-claude-handoff.md),
   the [A3 prompt](fractionate-agents-a3-prompt.md) and the
   [continuation prompt](fractionate-agents-a3-continuation-prompt.md).

## Section status

| Step | Status |
|---|---|
| A1 Scope and architecture | Design complete (PR #676). Pilot: synthetic sign-in at `https://demo.fractionate.ai`. |
| A2 Project access and profiles | Merged (PR #677, `ade9a783`). Migration 1106; metadata gate off. |
| A3 Isolated execution | **In progress.** Prerequisites pass on the VM: fence, fixed-origin proxy, cold Chromium and fixed cgroup probes (user-run; services and identity re-corroborated). Supervisor, guest runner, human page, installer, proof runner and backend client are implemented and pushed. Target install and proof are open. |
| A4 Credentials and provider | Not started; gated by A3 acceptance. [A4 prompt](fractionate-agents-a4-prompt.md). |
| A5–A8 | Not started; each gated by the previous step. A8 also needs release authorization. |
| F1–F7 | Deferred per the follow-on plan. F7 cannot absorb pilot-specific SEC/INF or host-isolation blockers. |

## Exact revisions (2026-09-28)

| Where | Revision | Notes |
|---|---|---|
| GitHub `main` | `12ad1392845630eec56705776bae444f54eac58a` | Base of the A3 branch. Contains migration 1108 and `inspect_a3_vm`. |
| Branch `claude/step-a3-isolated-execution-yg80mx` | code `3cd80b70e971b484f442fbb96ac07f2ad8c66add`; later commits are docs only | No PR yet. All of the A3 code is in that one commit. |
| PR #686 `agents-a3-isolation-continuation` | `cd4abbca`, draft, unmerged, GitHub `dirty` | Only its broker correction (`5cacdefb`) is carried in the branch; the rest is already on `main`. Keep it draft. |
| ProxyPilot live checkout | `33528751b0b68771a768a69ef42c0bd614069498` | Not on GitHub. Carries live-only Nodus route-ingress tools that are not A3. |
| ProxyPilot candidate (`pp-candidate`) | `7851c1a0d6084213e842151d37083d49ff204dd8`, 17 ahead | Holds the fence, proxy and probe scripts. **Not yet** holding the supervisor work. Last checks there: `backend-tests` ok. |
| Windows workspace | `agents-a3-isolation-continuation` at `83387f7b` | Uncommitted work plus the untracked `scripts/tests/a3-vm-probe.zip`. Cloud sessions cannot reach it; never reset it or commit the zip. |

## Proof target (recheck before use)

| Field | Value |
|---|---|
| Incus name / MCP name | `pp-agents-a3-debian13-proof-20260927` / `agents-a3-debian13-proof-20260927` |
| VM UUID | `49592202-a8b0-45af-9ac6-5439761d73e4` |
| Guest boot ID at snapshot | `b08210f9-fe81-4e86-9362-926f5ee21e59` (a guest-crash proof changes it) |
| Shape | Incus 7.5.1, Debian 13.7, 2 vCPU, `4096MiB`, `12GiB` root, no swap. Autostart, guest API and nesting false. |
| Network | `incusbr0`, TAP `ppa3proof0`, guest `10.185.17.179` on NIC `enp5s0`, MAC `10:66:6a:55:f6:3f`, gateway `10.185.17.1` |
| Host units | `proxypilot-a3-fence.service` (active/exited), `proxypilot-a3-origin-proxy.service` (active/running on `10.185.17.1:18083`). `proxypilot-a3-supervisor.service` is not installed yet. |
| Rollback snapshot | `pp-mcp-pre-network-20260927-222658`. Keep it; the fence installer also requires it. |
| Proxy certificate | Self-signed, 7 days from install. Proxy `status` refuses with under 24 h left, so launches fail closed from about **2026-10-03** until the proxy is reinstalled and re-probed. |

## Component map

| File | Role |
|---|---|
| `scripts/a3-network-fence.py`, `a3-install-fence.py` | Bridge nft fence on the TAP: only ARP and TCP to `10.185.17.1:18083` leave the VM. Installed and active. |
| `scripts/a3-origin-proxy.py`, `a3-install-proxy.py` | Fixed-origin HTTPS proxy with host TLS termination and a per-request path/method policy. Installed and active. |
| `scripts/a3-probe-fence.py`, `a3-probe-proxy.py`, `a3-probe-browser.py`, `a3-probe-guest-cgroups.py` | Earlier prerequisite probes (passed; user-run). |
| `scripts/a3-worker-supervisor.py` | **Host-owned supervisor** (root daemon). Installed copies only; journal, receipts, watchdog, recovery. |
| `scripts/a3-worker-guest.py` | Fixed program in the guest worker unit. One Chromium over `--remote-debugging-pipe`; CDP `Fetch` origin policy; typed actions, human input and proof workloads. |
| `scripts/a3-install-supervisor.py` | `install\|status\|remove\|reinstall`: byte-exact copies into `/etc/proxypilot-a3-proof/supervisor`, Ed25519 key, the unit, rollback. |
| `scripts/a3-stage-candidate.sh` | Stages one reviewed commit's paths on the candidate slot with three-way guards (replaces the failed cherry-pick). |
| `scripts/a3-worker-operator.py` | Root CLI: `status`, `journal`, `stop`, `takeover`, `view`, `verify-receipt`, `human` (loopback page). |
| `scripts/a3-probe-worker.py` | **Target proof**: 18 cases against the installed supervisor. |
| `scripts/tests/test_a3_*.py` | 72 local tests (45 mirrored + 27 new), including real-Chromium tests that skip without a local Chromium. |
| `admin/backend/src/lib/operational-worker-supervisor.js` | Backend socket client (5 methods) and `createTeardownVerifier`. |
| `admin/backend/src/lib/operational-worker-boundary.js` | Launch contract (adds `workspace_id`, `project_limits_revision`); `createWorkerLauncher({client, vmUuid})` fails closed without a client; store binding in `markRunning(ref, binding)`/`finishStop`. |
| `admin/backend/src/lib/operational-worker-binding-schema.js` | Migration **1109**: `ops_agent_worker_attempts.vm_uuid`, `boot_id` (additive). |
| `admin/backend/src/lib/operational-browser-broker.js` | Secondary Playwright broker (PR #686 correction: no local caps). Not the production path. |

## Interfaces

**Host paths.**

| Path | Contents |
|---|---|
| `/etc/proxypilot-a3-proof/supervisor/` | Reviewed copies of the six Python files |
| `/etc/proxypilot-a3-proof/supervisor-key.pem` | Private key, 0600, never leaves the host |
| `/etc/proxypilot-a3-proof/supervisor-pub.pem` | Public key |
| `/var/lib/proxypilot-a3-proof/supervisor-install.json` | Install journal |
| `/var/lib/proxypilot-a3-proof/supervisor/state.json` | Attempt and run journal |
| `/var/lib/proxypilot-a3-proof/proof/` | Proof reports and screenshots |
| `/var/lib/proxypilot-a3-proof/supervisor-keys/` | Archived public keys after `remove` |

**Sockets.** Newline-delimited JSON, one request per connection. Only uid 0 peers are answered.

- **Backend** `/run/proxypilot-a3/supervisor.sock`. Methods:
  - `status {}`
  - `launch {run_id, attempt_id, workspace_id, fence, policy_digest, project_limits_revision, origin, target, limits, install}`
  - `renew {run_id, attempt_id, fence}`
  - `action {run_id, attempt_id, fence, action}`: one of `open_landing`, `open_login`, `read_workspace`, `read_session`, `read_files`, `sign_out`. `submit_bound_fixture` is refused.
  - `stop {run_id, attempt_id, fence, reason: cancelled|blocked|failed}`
- **Operator** `/run/proxypilot-a3/operator.sock`. Every backend method, plus:
  - `launch` with `workload` (`browser` or `proof:cpu|memory|tasks|disk|time|escape|descendant|fail`)
  - `takeover`, `view`, `input` (`click`/`key`/`text`/`scroll`)
  - `observe`, `locate`, `egress_probe`, `proof`
  - `unit_stats {attempt_id}`, `journal {attempt_id}`
  - `proof_crash_mid_action`
  - `stop` reasons also `taken_over|proof`

**Refusal codes (supervisor).** `ACTION_LIMIT` `ACTIVE_ATTEMPT` `ATTEMPT_EXISTS`
`ATTEMPT_NOT_ACTIVE` `ATTESTATION_UNAVAILABLE` `BOUNDARY_LOST` `BOUNDARY_UNVERIFIED`
`CHANNEL_CLOSED` `CREDENTIAL_BROKER_UNAVAILABLE` `DEADLINE` `GUEST_READBACK_FAILED`
`HOST_COMMAND_FAILED` `INVALID_BROWSER_ACTION` `INVALID_LAUNCH` `INVALID_REQUEST`
`JOURNAL_INVALID` `LAUNCH_FAILED` `LEASE_EXPIRED` `METHOD_NOT_ALLOWED`
`PROJECT_LIMIT_BELOW_WORKER_MINIMUM` `ROOT_REQUIRED` `STALE_FENCE` `SUPERVISOR_STOPPING`
`TAKEN_OVER` `TEARDOWN_UNVERIFIED` `TEMPORARY_DISK_EXCEEDS_WORKER_MEMORY`
`UNIT_READBACK_FAILED` `UNKNOWN_ATTEMPT` `VM_CAPACITY_INSUFFICIENT` `WORKER_TIMEOUT`.
Guest runner codes (`BROWSER_*`, `INVALID_*`) pass through on a failed action.

**Receipt.** `{run_id, attempt_id, fence, descendants_gone, workspace_removed, attestation}`.

- `attestation` is `a3r1.<base64url canonical JSON>.<base64url Ed25519 signature>`.
- The payload also carries `vm_uuid`, `bound_boot_id`, `workspace_id`, `unit`, `reason`, `evidence`, `uncertain_actions`, `actions_performed` and `key_id`.
- `key_id` is the sha256 of the public key's SPKI DER.
- The backend verifier accepts a receipt only for the same attempt, fence, workspace, VM and bound boot.

**Worker unit.** `pp-a3-worker-<attempt_id>` in the guest.

- Sandbox:
  - identity: `User=nobody`, `NoNewPrivileges`, empty capability set;
  - filesystem: `ProtectSystem=strict`, `ProtectHome`, `PrivateDevices`/`PrivateIPC`, `ProtectProc=invisible`;
  - hidden trees: empty read-only tmpfs over `/run` and `/var`;
  - network: `RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK`, `IPAddressDeny=any` except `10.185.17.1/32`;
  - workspace: private tmpfs `/tmp` plus a 128 MiB `/dev/shm`.
- Resource limits: `MemoryMax`, `MemorySwapMax=0`, `TasksMax=512`, `CPUQuota` (when configured), `RuntimeMaxSec` (time left to the pinned deadline), `OOMPolicy=kill`, `KillMode=control-group`.
- Lease 30 s; health check every 10 s; runner watchdog 20 s.

## Limit semantics (changed in A3; still for review)

- **What the limits bound.** Project `cpu`, `memory_mib` and `temporary_disk_mib`
  limit the worker unit inside the VM.
- **VM capacity.** The installed VM shape is at least 2 vCPU / 4096 MiB /
  12 GiB, and above that `cpu` and `memory_mib + 1024`.
- **Minimums.** The worker minimums are **provisional**: CPU 1, memory
  1024 MiB, temporary disk 64 MiB. A value below them refuses launch and is
  never raised. A limit larger than the VM gets `VM_CAPACITY_INSUFFICIENT`.
- **Unset limits.** Memory defaults to guest MemTotal − 768 MiB, temporary disk
  to min(512, memory/2) MiB, and CPU has no quota. Time and actions are
  unbounded, but the 30-second lease still applies.
- **Code to change together.** `WORKER_MINIMUM` and the install reserve live in
  both `a3-worker-supervisor.py` and `operational-worker-boundary.js`, and the
  dashboard text is in `AccessPolicy.jsx`.

## Proven versus open

| Claim | State |
|---|---|
| Fence drops host and routed IPv4/IPv6 (raw SYN counters) | Passed on the VM (user-run, earlier boot). |
| Proxy CONNECT/path/Host/WebSocket refusals; approved GETs 200 | Passed on the VM (user-run). |
| Nonroot sandboxed Chromium cold start; transient cgroup CPU/memory/tasks/time/tmpfs limits | Passed on the VM with fixture units, not the production launcher. |
| Supervisor, runner, human path, receipts, recovery, no replay | Passed **locally only**: real Chromium through a local proxy, with systemd and `incus exec` simulated. |
| Production launcher overruns, escapes, lifecycle, crash, human takeover on the VM | **Open.** Needs the `a3-probe-worker.py` output. |
| Measured browser minimum and VM sizing | **Open.** Taken from the proof's session measurements. |
| A real person using the human page | **Open.** |
| Host reboot persistence (fence → proxy → supervisor) | **Open.** Never reboot the host without explicit approval. |
| Backend socket mount and coordinator wiring | **Open**, deliberately. Activation stays off until A5. |
| Exact-head Security CI for the branch | **Open.** `workflow_dispatch` returned 403; the workflow runs on a pull request. |
| S6 / SEC-01 / SEC-04 | **Open.** |

## Commands

The host command stages the exact code commit on the candidate, then installs
and runs the proof. Root is required. It takes about 10 minutes and reboots
the proof VM's guest once. Append `--skip-guest-crash` to the last step to skip
that case.

```
sudo sh -c 'set -e; cd /var/lib/proxypilot/self/candidate; git fetch -q https://github.com/CyberTechArmor/ProxyPilot.git claude/step-a3-isolated-execution-yg80mx; git merge-base --is-ancestor 9dade53bbcfb5c236d22fb2fa3d7b74a111857df FETCH_HEAD; git show 9dade53bbcfb5c236d22fb2fa3d7b74a111857df:scripts/a3-stage-candidate.sh | sh -s -- . 3cd80b70e971b484f442fbb96ac07f2ad8c66add; python3 scripts/a3-install-supervisor.py install; python3 scripts/a3-probe-worker.py'
```

Do **not** use `git cherry-pick` for this. The first host attempt stopped on eight add/add
conflicts: the branch holds the mirrored A3 scripts as mode 100755, and the
candidate holds identical bytes as 100644. The stager `scripts/a3-stage-candidate.sh`,
pinned at `9dade53b`, does the following:

- aborts that interrupted cherry-pick;
- refuses uncommitted changes, any candidate file that differs from both the base
  and the reviewed commit, and a policy without the self-check line;
- checks out exactly the reviewed paths (the policy excepted), commits, and
  verifies them byte-for-byte.

It was tested against a stand-in candidate reproducing the conflict: the same 30
dirty paths, 37 paths staged exactly, and the candidate-only change preserved. It
also has a unit test.

Other operator commands (run on the host as root, from the candidate `scripts/` directory):

```
python3 a3-install-supervisor.py status        # install readback, key id, accepting_launch, blockers
python3 a3-worker-operator.py status           # live attempt, boundary
python3 a3-worker-operator.py journal <attempt>
python3 a3-worker-operator.py stop <run> <attempt> <fence> [--reason ...]
python3 a3-worker-operator.py human <run> <attempt> <fence>   # then ssh -L 18090:127.0.0.1:18090 <host>
python3 a3-probe-worker.py --only <case> ...   # rerun specific cases
python3 a3-install-supervisor.py reinstall     # after a reviewed fix is staged
```

Local checks (repository root):

```
python3 -m unittest discover -s scripts/tests -p 'test_a3*py'
(cd admin/backend && node --test src/__tests__/operational-*.test.js)
python3 scripts/host-boundary-inventory.py
(cd admin/frontend && npm run build)
```

## Rollback order

1. Keep A3/Operations flags off.
2. Stop any live attempt through the operator CLI and verify its receipt.
3. `a3-install-supervisor.py remove`. It refuses while an attempt is live, and it keeps the state journal and archives the public key.
4. Withdraw origin access if needed: `a3-install-proxy.py remove`.
5. Stop the VM through supported MCP before removing any fence.
6. `a3-install-fence.py remove`, only with the VM stopped.
7. The pre-network snapshot, only for a confirmed VM regression.

For code, revert the branch. Keep migration 1109 and all run, attempt and
event rows. Older writers do not bind `vm_uuid`/`boot_id`, which is safe only
while A3 is inactive.

## Rules for every conversation

- Do not start A4 or any F item until A3 is explicitly accepted from observed
  target evidence. Keep PR #686 draft. Keep A2/A3/Operations activation off.
- Never touch `pp-nodus`, `nodus.fractionate.ai` or its port 3000 route. Never use
  `--upgrade-incus` or an Incus archive, and never bypass managed-LXC refusals.
- Never weaken, skip or suppress a test, the host-boundary inventory or a proof
  case to get green. A failed proof stays an open gate.
- The supervisor runs only from its installed, digest-checked copies. Do not point
  its unit at a checkout, and do not broaden its sockets, methods or allowlists
  without a reviewed contract change.
- Host-root actions go to the user as one exact command with expected output and
  failure diagnostics. Do not claim a user-run result before reviewing its output.
- Cloud sessions cannot upload repository content to `edge.fractionate.ai` (the
  session's data-exfiltration guard refuses it), and `workflow_dispatch` returns
  403. Stage host code from GitHub with the pinned stager command above, never with a plain cherry-pick. Exact-head
  Security CI needs a pull request, which only the user can ask for.
