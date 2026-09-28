# A3 reference: current state for any conversation

Snapshot: 2026-09-28, after the third target run (minimums confirmed). This file is the orientation page. The dated
[A3 evidence](fractionate-agents-a3-evidence.md) sections are the record, and
the [A3 acceptance prompt](fractionate-agents-a3-acceptance-prompt.md) is the
next work. Recheck every mutable value below (SHAs, services, VM boot) before
acting. If this page and a later dated evidence entry disagree, the evidence
wins.

**Status (updated after acceptance):** A3 was **accepted on 2026-09-28** (last
section of the [A3 evidence](fractionate-agents-a3-evidence.md)); A4 now builds
on it, see the [A4 reference](fractionate-agents-a4-reference.md). The status
notes below are the pre-acceptance snapshot.

**Pre-acceptance status:** every automated A3 criterion has passed on the VM, but
A3 was **not accepted** yet.

- The supervisor and runner are installed from code commit `0572dcff`. The
  second target run passed all 18 cases.
- The third run passed `sessions`, `minimums` and `human_takeover`, and the
  minimums (1 CPU, 1024 MiB, 64 MiB) are confirmed by measurement.
- Candidate `backend-tests` pass at `228fdd12` (3322/3333, 0 fail, 11
  environment skips).
- Still required for acceptance:
  1. a real person using the human page (`a3-probe-worker.py --human-session`,
     added in `44c630fb`);
  2. the candidate frontend build on the host. The container check cannot run
     it because `NODE_ENV=production` omits `vite`.
- Security CI stays open unless the user asks for a draft PR.

## Read first

1. This page, then the last three dated sections of the
   [A3 evidence](fractionate-agents-a3-evidence.md) (the first, second and third
   target runs of 2026-09-28).
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
| A3 Isolated execution | **In progress; the automated proof passes.** Supervisor installed from `0572dcff`; 18/18 target cases, the minimums and candidate `backend-tests` pass. Open before acceptance: a real person on the human page and the candidate frontend build. |
| A4 Credentials and provider | Not started; gated by A3 acceptance. [A4 prompt](fractionate-agents-a4-prompt.md). |
| A5–A8 | Not started; each gated by the previous step. A8 also needs release authorization. |
| F1–F7 | Deferred per the follow-on plan. F7 cannot absorb pilot-specific SEC/INF or host-isolation blockers. |

## Exact revisions (2026-09-28)

| Where | Revision | Notes |
|---|---|---|
| GitHub `main` | `12ad1392845630eec56705776bae444f54eac58a` | Base of the A3 branch. Contains migration 1108 and `inspect_a3_vm`. |
| Branch `claude/step-a3-isolated-execution-yg80mx` | supervisor and runner `0572dcff` (installed); probe `1c5f486b` (minimums) and `44c630fbdf363110b9acabe8e7db153376d0b795` (`--human-session`) | No PR yet. `44c630fb` is the latest code commit to stage. Commits after `0572dcff` change only the probe and its test, so no reinstall is needed. |
| PR #686 `agents-a3-isolation-continuation` | `cd4abbca`, draft, unmerged, GitHub `dirty` | Only its broker correction (`5cacdefb`) is carried in the branch; the rest is already on `main`. Keep it draft. |
| ProxyPilot live checkout | `33528751b0b68771a768a69ef42c0bd614069498` | Not on GitHub. Carries live-only Nodus route-ingress tools that are not A3. |
| ProxyPilot candidate (`pp-candidate`) | `228fdd12…` (staged `1c5f486b`), 20 ahead, clean | `backend-tests` and `backend-syntax` recorded green at this head (`skip_install: true` after the native repair). |
| Windows workspace | `agents-a3-isolation-continuation` at `83387f7b` | Uncommitted work plus the untracked `scripts/tests/a3-vm-probe.zip`. Cloud sessions cannot reach it; never reset it or commit the zip. |

## Proof target (recheck before use)

| Field | Value |
|---|---|
| Incus name / MCP name | `pp-agents-a3-debian13-proof-20260927` / `agents-a3-debian13-proof-20260927` |
| VM UUID | `49592202-a8b0-45af-9ac6-5439761d73e4` |
| Guest boot ID | `524515b5-6576-4479-8b0f-07fa4d9205c6` since the second run's guest-crash case (earlier `92a161fd…`, `b08210f9…`); QEMU PID 272179 unchanged |
| Shape | Incus 7.5.1, Debian 13.7, 2 vCPU, `4096MiB`, `12GiB` root, no swap. Autostart, guest API and nesting false. |
| Network | `incusbr0`, TAP `ppa3proof0`, guest `10.185.17.179` on NIC `enp5s0`, MAC `10:66:6a:55:f6:3f`, gateway `10.185.17.1` |
| Host units | `proxypilot-a3-fence.service` (active/exited), `proxypilot-a3-origin-proxy.service` (active/running on `10.185.17.1:18083`), `proxypilot-a3-supervisor.service` (active/running; key ID `d6817618265ac253ea341b9f3f69dfe102ba9f1077e597f9accda4e113d0d517`, the old `c31fecee…` archived) |
| Rollback snapshot | `pp-mcp-pre-network-20260927-222658`. Keep it; the fence installer also requires it. |
| Proxy certificate | Self-signed (CN `demo.fractionate.ai`), pinned by SPKI in the guest browser; not Caddy or Let's Encrypt. It lives 7 days, and proxy `status` refuses it with under 24 h left. Since `d932ecd2`, `proxypilot-a3-proxy-renew.timer` (installed with the supervisor) re-issues it every ~4 days via `a3-install-proxy.py renew`; see the [A4 evidence](fractionate-agents-a4-evidence.md) section "proxy certificate: automatic renewal". Before that, only a proxy reinstall re-issued it. Proven on the host on 2026-09-28 (the timer's service ran, then 21 proxy cases and three sessions passed on the renewed pin `ASpAFpze…`). |

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
| `scripts/a3-probe-worker.py` | **Target proof**: 19 cases (the 18 plus `minimums`) against the installed supervisor, and `--human-session` for a real person. |
| `scripts/tests/test_a3_*.py` | 74 local tests, including real-Chromium tests that skip without a local Chromium. |
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

## Limit semantics (changed in A3; minimums measured)

- **What the limits bound.** Project `cpu`, `memory_mib` and `temporary_disk_mib`
  limit the worker unit inside the VM.
- **VM capacity.** The installed VM shape is at least 2 vCPU / 4096 MiB /
  12 GiB, and above that `cpu` and `memory_mib + 1024`.
- **Minimums.** CPU 1, memory 1024 MiB, temporary disk 64 MiB, **confirmed on
  the VM 2026-09-28**. At exactly these limits the browser peaked at 225 MiB,
  with shmem 13.2 MiB, 112 pids, no OOM and under 2% throttling. A value below
  them refuses launch and is never raised. A limit larger than the VM gets
  `VM_CAPACITY_INSUFFICIENT`.
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
| Production launcher on the VM: CPU/memory/tasks/disk/deadline/action overruns, detached descendant, escape (raw socket EPERM) and guest-root egress, lease expiry, stale fence, launch failure, backend refusals, supervisor crash without replay, guest crash with a new boot | **Passed**: all 18 cases at `0572dcff` (report `worker-proof-20260928T121140Z.json`). |
| Browser sessions, automated human takeover click/Escape and runner-layer cross-origin refusals on the real origin | **Passed** in the second and third runs. |
| Measured browser minimum and VM sizing | **Passed.** `minimums` at 1/1024/64: peak 225 MiB, no OOM. VM 2/4096/12 GiB confirmed for one worker. See the third-run evidence. |
| Candidate `backend-tests` / `backend-syntax` | **Passed** at `228fdd12` (3322/3333, 0 fail; 11 environment skips; the tool excludes the six `known-issues` native files). |
| Candidate `frontend-build` | **Open.** The container check fails with `vite: not found` (`NODE_ENV=production` omits devDependencies). The branch builds locally; the host command below builds the exact candidate. |
| A real person using the human page | **Open.** `--human-session` (`44c630fb`). |
| Host reboot persistence (fence → proxy → supervisor) | **Open.** Never reboot the host without explicit approval. |
| Backend socket mount and coordinator wiring | **Open**, deliberately. Activation stays off until A5. |
| Exact-head Security CI for the branch | **Open.** `workflow_dispatch` returned 403; the workflow runs on a pull request. |
| S6 / SEC-01 / SEC-04 | **Open.** |

## Commands

The next host command stages `44c630fb` (probe and test only, so no
reinstall), builds the exact candidate frontend with its devDependencies, and
starts a human session for a real person. Root is required. The session waits up
to 15 minutes (`--minutes`, at most 60).

```
sudo sh -c 'set -e; cd /var/lib/proxypilot/self/candidate; git fetch -q https://github.com/CyberTechArmor/ProxyPilot.git claude/step-a3-isolated-execution-yg80mx; git merge-base --is-ancestor 44c630fbdf363110b9acabe8e7db153376d0b795 FETCH_HEAD; git show 44c630fbdf363110b9acabe8e7db153376d0b795:scripts/a3-stage-candidate.sh | sh -s -- . 44c630fbdf363110b9acabe8e7db153376d0b795; git rev-parse HEAD; set +e; docker exec -w /var/lib/proxypilot/self/candidate/admin/frontend proxypilot-admin sh -c "npm ci --include=dev --no-audit --no-fund --loglevel=error && npm run build -- --logLevel error"; echo "frontend_build_exit=$?"; python3 scripts/a3-probe-worker.py --human-session; echo "human_exit=$?"'
```

The full proof, when a supervisor or runner change needs it again, is
`python3 scripts/a3-install-supervisor.py reinstall; python3 scripts/a3-probe-worker.py`
after staging. It takes about 3–5 minutes and reboots the proof VM's guest once;
append `--skip-guest-crash` to skip that case.

Do **not** use `git cherry-pick` for this. The first host attempt stopped on eight add/add
conflicts: the branch holds the mirrored A3 scripts as mode 100755, and the
candidate holds identical bytes as 100644. The stager `scripts/a3-stage-candidate.sh`
(first used at `9dade53b`, pinned in the command above at the staged commit)
does the following:

- aborts an interrupted cherry-pick;
- refuses uncommitted changes, any candidate file that matches neither the base
  nor a commit of the reviewed branch, and a policy without the self-check line;
- checks out exactly the reviewed paths (the policy excepted), commits, and
  verifies them byte-for-byte.

It was tested against a stand-in candidate reproducing the conflict: the same 30
dirty paths, 37 paths staged exactly, and the candidate-only change preserved.
Staging `0572dcff` over that first staging was also simulated: 43 paths matched
exactly. It has unit tests. Because the supervisor is already installed, the
command uses `reinstall`: it refuses while an attempt is live, archives the old
public key and creates a new key.

Other operator commands (run on the host as root, from the candidate `scripts/` directory):

```
python3 a3-install-supervisor.py status        # install readback, key id, accepting_launch, blockers
python3 a3-worker-operator.py status           # live attempt, boundary
python3 a3-worker-operator.py journal <attempt>
python3 a3-worker-operator.py stop <run> <attempt> <fence> [--reason ...]
python3 a3-worker-operator.py human <run> <attempt> <fence>   # then ssh -L 18090:127.0.0.1:18090 <host>
python3 a3-probe-worker.py --only <case> ...   # rerun specific cases
python3 a3-probe-worker.py --human-session     # launch one attempt for a real person on the human page
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
  target evidence (the [A4 prompt](fractionate-agents-a4-prompt.md) is gated on
  that record). Keep PR #686 draft. Keep A2/A3/Operations activation off.
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
