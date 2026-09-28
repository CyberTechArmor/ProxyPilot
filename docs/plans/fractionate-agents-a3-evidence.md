# A3 isolated worker boundary — target review stop

Original review: 2026-09-25; disposable VM continuation: 2026-09-26.
**A3 is blocked, not accepted.** The source adds a closed
internal contract and durable fencing records. It does not launch a worker,
browser, provider or credential broker. This A3 work made no route, feature
activation or live account action. User-authorized MCP tests created and
stopped two disposable LXC guests and one Debian VM. The VM observations below
show that the generic VM does not enforce the selected A3 worker boundary.

## Exact A2 baseline and preservation

Before editing: branch `agents-a2-project-access`, HEAD
`3290d5a391e6ef6fb15ae71347f423cc83a7c9c1`, upstream `origin/main`,
ahead 1 / behind 0, clean tracked and untracked status. HEAD's parent is A1
merge `e22431d2bda0ca1fa8f0ee47bbb962d31e7f2177`. The A2 evidence
`../../../agents-a2-evidence/report.md` originally describes an uncommitted patch on
`057922f`; this checkout has that content committed as `3290d5a`. Every one
of the 17 file hashes in `../../../agents-a2-evidence/hashes-after.json` matched
the clean pre-edit worktree. Its recorded incremental patch has SHA-256
`b3f33da3b39b7c1cf08618bddfab6297841f8ea141a1fedd046d64faae77e394`.
This review did not reset, clean or integrate another PR.

During A3 verification, the shared branch was amended externally from
`3290d5a` to `7bec67f15ec799ff333fcc00fb407716c5d6533e` (same parent,
author date and A2 subject; commit time 15:56:36 -0400). The sole tree
difference between those commits is deletion of “and unsubmitted” from the
A3 prompt's opening paragraph. This A3 work did not make that commit or
change that prompt. The original 17-hash A2 match was observed before edits;
the current A2 hash mismatch is limited to that amended prompt plus the three
tracked files edited by A3. The amended head is **not** the exact originally
reviewed A2 revision. Review must account for the prompt amendment; no
history was rewritten by this work.

Subsequent GitHub review merged A2 as PR #677. Its parent commit `397dda2`
has an identical tree to the local amended `7bec67f` (`git diff --stat
7bec67f 397dda2` produced no output); main at `ade9a78` therefore includes
the exact local A2 file content. Commit identity differs, and the amendment
to the prompt remains disclosed above.

Pre-edit worktree SHA-256 for modified files:

| File | SHA-256 |
|---|---|
| `admin/backend/src/db.js` | `22d2e0aa09663e46bcbda0df828cbcc0dc695f4bfdaaf21b6659f65b5f81c6cc` |
| `admin/backend/src/__tests__/helpers/operations-fixture.js` | `61ed471a8f0ab0d244a9ee6ba4c740a019f8936430357048424ee0a7cbb4fab5` |
| `admin/backend/src/__tests__/operational-agents.test.js` | `52a41e2903b144cb5bb6848b2f2aeb77a226e270873e43069e97a5cf50628992` |

The read-only plan/contract/acceptance/source SHA-256s were respectively
`79d0764614fcb63d9034567a07c7fc01cab51575937021a995dea99f0a6cb8c5`,
`af2e2eab1477cb7164cdc37996926f4119a3873ac697b6700754ca692bd69177`,
`64c3ee2207d1c2efbd4d90af5cb5afc2d09ab3eb9f011c4d79a6e2ce4c1e37a4`,
`cf39e81e46bcb11d27de20044d79fa7d1e36a82967d4cca3653b8af445e5043c`,
and `edc6c79047f82b899fab960215458f352d89cc04dbf392bb41b9c3b040e98693`.
The host-boundary inventory and Operations feature document hashes were
`e2ea233a5e54692c0c80842669613ac868248552aab1e0de23b17cd8b46d3119`
and `269fe6271db06abd2b023f21f96d91e835aaee834362767fbe2268443270dca5`.
Adjacent `FINISH.md`, section tracker and demonstration tracker hashes were
`17fdb87e16458875b054feb1a3f38481ee850a57a546b55de557ffe53b216280`,
`8327ef291ccc7ac649d6996e0ee2162fda4a0ffa72967d300e4712a53a68c0f0`,
and `7f62769b8a4d2e9ac0238e34e4ea54a200d63179cb2e3cd8fd7580c83ab58a06`.
They were read and not edited. B1–B4, D1–D4, migrations 1100–1106 and
immutable history remain unchanged.

## Selected target and required enforcement

Selected pilot target after user correction: a disposable **Incus VM provisioned
through ProxyPilot's intended Incus host**, identified in the typed contract as
`incus-disposable-vm-browser-v1`. A trusted host-side supervisor must own
the VM image, Incus project/profile, cgroup, network/egress proxy, guest
policy, temporary storage and termination. The ProxyPilot backend may request a
fixed typed launch/stop but must not control supervisor binaries, policy,
attestation or host credentials. The VM receives no host mounts, repository,
Dev Studio, evidence archive, Docker/Incus socket or management network.
Only a fixed origin-aware browser proxy may reach the approved synthetic site;
DNS, redirects, CONNECT, raw IP and subresource requests must all be checked
against the same exact-origin policy. The browser and all descendants must be
inside the one VM/process tree. A separate bounded broker must accept only the
seven typed browser operations in `operational-worker-boundary.js` and verify
the current run/attempt fence before each operation. The guest must receive no
provider key, credential value, shell or arbitrary path. Its workspace and
cookie jar must be private per attempt and destroyed with the VM.

The proposed host supervisor must enforce **one vCPU, total 512 MiB memory,
128 MiB temporary disk, one browser process tree, 300 seconds and 20 brokered
actions**. These are requirements, not installed controls. Incus `limits.cpu=1`
sets one guest vCPU; its VM `limits.memory` setting alone does not prove a
512 MiB total host RSS cap for QEMU and descendants. Incus `limits.processes`
is container-only, so guest process-tree limits require a separately verified
guest or host mechanism. The 128 MiB limit applies to all writable temporary
guest storage, not just an extra disk; the image/root disk and swap require
specific verification. A missing limit, egress policy, broker or teardown
receipt refuses launch. A2 profile/site/guide values remain configuration
references; they do not activate a run or credential.

Incus [VM creation](https://linuxcontainers.org/incus/docs/main/howto/instances_create/)
and [instance options](https://linuxcontainers.org/incus/docs/main/reference/instance_options/)
support the VM and guest resource configuration. Its
[project limits](https://linuxcontainers.org/incus/docs/main/reference/projects/)
can bound aggregate declared resources but do not by themselves attest guest
browser descendants or isolate the root-equivalent backend. Incus
[VMs use QEMU and an agent](https://linuxcontainers.org/incus/docs/main/explanation/instances/);
`security.guestapi` defaults to true and the agent enables host-to-guest exec
and file transfer unless its features are constrained. The worker must have no
access to the Incus management endpoint, and guest API/agent behavior must be
reviewed on the selected VM. These source contracts identify possible
enforcement points; they are not target observations.

## Source delivered and exact limits

- Migration 1107 adds additive `ops_agent_runs`, distinct worker attempts,
  one-active-run/profile and one-active-attempt/run indexes, monotonic fences,
  action count, append-only worker events and terminal-history triggers. It
  does not change migration 1100–1106 or `ops_manual_runs`.
- The internal launch/stop schema rejects extra fields, arbitrary argv/path,
  weakened resource limits and non-demo origins. The launcher returns
  `BOUNDARY_UNVERIFIED` unconditionally: there is no installed OS runner.
- The internal browser action shape rejects URL/selector/shell/fetch/download
  parameters. A secondary Playwright broker creates a no-download,
  service-worker-blocked context, refuses WebSockets, permits only fixed
  same-origin methods/paths, rejects cross-origin requests/redirects, and
  caps its own action calls at 20 and five minutes. Credential submission
  remains unavailable in A3. Browser page readback is labelled untrusted.
  This browser layer is **not** an OS egress boundary.
- SQLite transactions reserve stable IDs, check one active run/attempt,
  pin the current site/profile/guide, apply narrower profile time/action
  budgets, increment the fence before cancellation and reject stale actions.
  Restart recovery leaves the run `cancelling` and its active profile slot
  occupied pending teardown; it does not replay actions. A terminal stop
  requires a teardown receipt and injected verifier, absent by default. The
  unit verifier is explicitly test-only; an independent host-side verifier
  and observed descendant/workspace removal remain missing. No HTTP start
  route exists. The store is groundwork; A5 must add current actor/grant,
  policy and approval checks before exposing it.

## Observed target probe and blocked acceptance

Read-only probe of the available WSL2 Ubuntu instance showed Linux
`6.18.33.2-microsoft-standard-WSL2`, user `uid=1000`, KVM device present and
unprivileged user/network namespaces available. Its cgroup root is read-only
to the user. No `bwrap`, browser, Incus, Podman, QEMU or Firecracker executable
was found. WSL2 mounts/exposes Windows host resources and is not the selected
Incus host. This probe does **not** prove that an A3 worker is isolated.

The user confirmed no disposable host exists on this machine and clarified
that ProxyPilot would use an Incus VM which can be provisioned. No disposable
Incus VM, worker image/supervisor/browser/egress proxy or target measurements
were available in this checkout. The original A3 scope forbade host mutation;
the subsequent user message explicitly authorized creating a disposable VM
through ProxyPilot for testing. The exposed MCP creation tool does not support
VM creation. A subsequent user instruction authorized LXC testing as an
interim probe; the results are recorded below. Therefore
forbidden host files/sockets/destinations, redirects, browser tool confinement,
CPU/RSS/process/time/disk overruns, descendant/workspace teardown and crash
cleanup were **not** observed on the selected target. The requested positive
approved-origin browser access and negative redirect/egress checks were not
run **on that target**. S6/SEC-01 and the pilot's SEC-04 separation remain **open**.
The selected VM target avoids putting the worker in a privileged LXC, but its
actual host, management reachability and device/network boundaries have not
been measured. No config-only closure is claimed.

## Incus VM blockers reviewed 2026-09-25

The live ProxyPilot MCP connection succeeded. `get_host_usage` observed 32
host CPU cores, 87,772 MiB available memory, 1,212.85 GiB available root
storage and an Incus ZFS pool named `Storage` with 102.52 GiB used;
`list_lxc_containers` returned managed guests. This establishes that the
connector reaches an Incus host, not that any A3 worker limit is enforceable.
The available MCP tool inventory has `create_lxc_container`, whose schema
contains no VM/type field. The local MCP implementation calls
`runLifecycle({ kind: 'instance_create', ... })` without `vm: true`, so it
creates a container; its default `docker_ready: true` is especially unsuitable
for a worker. ProxyPilot's separate dashboard route supports `vm: isVm`, but
the user has not provided a dashboard session or URL. The LXC guest created
below was expressly an interim test, not a substitute for VM acceptance. This
is a **tool-surface blocker**, not a host capacity finding.

### Interim LXC probe through ProxyPilot MCP

User-authorized creation called `create_lxc_container` with name
`agents-a3-synthetic-test`, image `images:debian/12`, `cpu: 1`,
`memory_gb: 0.5`, `disk_gb: 1`, `docker_ready: false`, and `autostart: false`.
It created Incus guest `pp-agents-a3-synthetic-test` on the host's default
profile and bridge, launch job `cd494fc4-96fb-4c88-91bf-911a625ea3e4`,
setup job `ff251abc-54b2-4172-88aa-d19ee90e2f3b`. MCP readback reported
`limits.cpu=1`, `limits.memory=512MiB`, and `boot.autostart=false`.
No provider, credential, login, or live site action was involved.

| Probe | Observed result | A3 implication |
|---|---|---|
| `free -m`; `memory.max`; `memory.swap.max` | 512 MiB guest memory, 536870912-byte cgroup memory cap, zero swap | Useful LXC memory smoke test; no VM/QEMU RSS proof |
| `cpuset.cpus.effective`; `cpu.max`; `pids.max` | CPU 31 only; `max 100000`; `max` | One effective CPU, but no CPU quota or process-count limit |
| `df -h` | 1.2 GiB root with about 1.0 GiB free; 25 GiB `/run` tmpfs, 62 GiB `/dev/shm` tmpfs | 128 MiB total writable temporary disk limit fails |
| `stat /dev/incus/sock` | Socket exists with mode `0666` | Incus guest API reachable; it must be disabled or constrained and separately tested before an A3 worker launch |
| `stat /var/run/incus.sock`, `/var/run/docker.sock`, `/data` | All absent | These three paths were not mounted; not exhaustive host-file proof |
| `stat /var/lib/incus/unix.socket`, `/run/incus/unix.socket`, `/opt/ProxyPilot`, `/workspace`, `/host`; `ls -la /mnt` | Listed paths absent; `/mnt` empty | No mount at these common paths; not exhaustive host-file proof |
| `ip route`; `curl -I --max-time 8 https://example.com` | Default route via bridge; nonapproved origin returned HTTP 200 | Deny-by-default egress fails |
| `ss -lntp` | Only resolver listeners | No browser or worker process was installed |

A bounded startup probe (source `scripts/tests/operational-lxc-probe.sh`,
transferred as an 803-byte zip with SHA-256
`4f0b9f5c760fed5c6f6560d54de287beacd1d4bc77f5eb110e5da2a6208efbaf`)
actually wrote **167,772,160 bytes** to `/tmp` and spawned **32** three-second
children (`pids.current` was 46). It exited 0, reaped the children and removed
its temporary directory, confirmed by `stat /tmp/a3-lxc-probe` returning
ENOENT. This directly demonstrates the missing disk and process limits on
the interim LXC configuration. It does not prove one browser tree, because no
browser was installed.

A one-shot 600 MiB tmpfs write (source
`scripts/tests/operational-lxc-memory-probe.sh`) returned exit 137. The
guest's `memory.events` changed from `max 0, oom 0, oom_kill 0` to
`max 613, oom 20, oom_kill 6`; the container then reported `Stopped`.
After a manual start it was `Running` again with 512 MiB available and no
`/dev/shm/a3-memory-probe` file. The script had written a one-shot marker
before the stress, so boot did not repeat the overrun. This is observed LXC
memory enforcement and a recovery smoke test, not total VM/QEMU RSS proof.
The original bounded startup script was restored from `.old` after checking
the diff.

A separate 45-second descendant probe (source
`scripts/tests/operational-lxc-crash-probe.sh`) started a detached `sleep`
and exited 17. `rerun_startup` returned exit 17 and child PID 260;
`stat /proc/260` immediately succeeded after the parent had exited. Thus the
generic startup path did **not** immediately tear down a detached descendant
on that failure. The original bounded script was restored after a checked
diff, then the guest was stopped (job
`cc770b24-b99f-43c8-967b-3d1988bf6e28`) and read back `Stopped` with
autostart false. The guest stop is not an independent A3 teardown receipt.

For final cleanup the guest was started once more, its registered startup
file was replaced with a five-line idle cleanup script (SHA-256
`befed7f4d9be9319362c416d78898153c42428cfdcd3fb58ddb17dfc243edbf4`),
and `rerun_startup` exited 0. `stat` confirmed the one-shot marker, disk
probe directory and memory probe file were absent. Final stop job
`a353f1f3-f74e-4d27-b3b5-1f2716b079d1` returned `Stopped`; a second
`get_lxc_container` read showed `Stopped`, no address, and
`boot.autostart=false`. The idle startup file and its `.old` backup remain in
the stopped guest; neither starts a worker. MCP's stopped-guest detail reports
`registered_startup:null`, although the running-guest detail and
`get_lxc_startup` showed the registered path before stop.

The dynamic `memory.current` and `pids.current` read tool returned SHA
mismatches as their values changed during transfer; no inference is drawn from
those reads. A `control_lxc_container` stop job
`fa81c6aa-b361-4999-accf-353c375d50f5` succeeded, and subsequent
`get_lxc_container` readback showed `Stopped`, no address, autostart false,
and no snapshots. This was the first stop before
the bounded stress probes; later starts and the final stop are recorded above.
The stops prove the test guest stopped; they do **not** prove browser descendant cleanup, private workspace
removal, crash recovery, or VM teardown. ProxyPilot MCP has no guest deletion
tool, so the stopped, non-ephemeral test LXC remains for host-side cleanup or
later review. No worker launch was attempted because the observed socket,
egress, disk and process limits fail closed.

### Acceptance matrix after interim testing

| A3 check | Result |
|---|---|
| Fixed one CPU, 512 MiB memory, no swap | Observed in LXC; 600 MiB overrun OOM-killed the writer and stopped the guest; VM/QEMU total RSS untested |
| 128 MiB writable disk and process restraint | Failed in LXC: 160 MiB write and 32 children succeeded; one browser tree remains untested because no browser is installed |
| Five-minute host deadline and 20 host-brokered actions | No A3 OS supervisor or host broker exists; local database/broker action tests pass but target proof is blocked |
| Host files and sockets | Common host paths absent, Incus guest API socket present; exhaustive mounts and VM devices untested |
| Approved origin, redirects, subresources and egress | Local synthetic browser fixture passed; LXC reached a nonapproved origin, so host egress fails |
| Cancellation, crash, descendants and workspace removal | Generic LXC startup failure left a detached child; stopping the guest succeeded; no A3 worker cancellation or private workspace exists |
| Launch failure and restart without replay; stale fence | Native SQLite/worker tests passed; no target worker launch, crash reconciliation or host-side fence to test |
| S6/SEC-01/SEC-04 | Open; the interim LXC failures cannot be treated as VM acceptance |

- **Target and authority:** The Incus host is reachable through MCP, but no
  disposable Incus VM or per-VM observation is available. The intended worker
  project, profile, image digest, network, storage policy and ability to
  provision a disposable **VM through MCP** are unverified.
  The existing setup engine can launch generic VMs, but it is not an A3
  worker supervisor. It accepts caller-selected profiles/networks and general
  launch config and applies `rootSize` only as a best-effort follow-up. It
  cannot establish the full worker boundary at creation.
- **Trusted launch and identity:** The A3 launcher still rejects every launch
  and stop with `BOUNDARY_UNVERIFIED`. There is no narrow Incus supervisor,
  immutable policy or independent teardown verifier. Stable database IDs and
  fences are not bound to an Incus `volatile.uuid`, guest boot identity or
  host-side broker; backend-writable state cannot independently close S6.
- **Guest and filesystem:** No pinned, minimal browser VM image or private
  per-attempt workspace exists. The effective device list, shared mounts,
  Incus socket, guest API/agent features, repository, Dev Studio and evidence
  archive reachability have not been measured. An ephemeral VM and 128 MiB
  writable workspace/root/swap budget have not been implemented or verified.
- **Network and browser:** No dedicated deny-by-default Incus network and
  host egress proxy has been installed. DNS, raw IP, management destinations,
  redirects, subresources, WebSocket and CONNECT must be blocked outside
  Playwright. The narrow broker has only run in a Windows fixture, not in an
  Incus guest or across an authenticated VM transport; its 20-action and
  five-minute limits are not independently enforced at the host.
- **Resources and teardown:** No measured 1-vCPU, 512 MiB total host RSS,
  128 MiB writable disk, one browser tree, 300-second expiry or guest process
  limit exists. Browser viability at 512 MiB is unknown. No forced overrun,
  cancellation, crash, descendant cleanup, workspace removal or no-replay
  restart proof exists on the selected target. Incus VM `limits.processes` and
  `limits.memory.enforce` are container-only options, so they cannot be used
  as evidence for those VM controls.
- **Acceptance and release:** The target negative probes and approved-origin
  positive probe remain unrun. S6/SEC-01/SEC-04 remain open. A draft A3
  revision requires Security CI and must remain unmerged and inactive until
  actual target proof closes these gates. A4 remains gated by observed A3 proof.

## VM provisioning continuation and connector limit

User-authorized prerequisite PR [#678](https://github.com/CyberTechArmor/ProxyPilot/pull/678)
added an optional `vm` flag to the generic `create_lxc_container` MCP tool,
disabled guest API and nesting for VM requests, and reports instance type.
Security regression run `36192267767` passed all backend, frontend, agent and
audit jobs, including the host-boundary inventory with no suppression. The PR
merged as `e2c40accf1689d31454350165391f9d8b15a1990`. The ProxyPilot
self-update run `d79637b3-88bb-41e2-a178-c6753ebb6d75` completed with
exit 0 and a healthy application, moving the host from `9bc071a` to that
exact merge commit. This is **generic VM provisioning only**, not the A3
worker supervisor or isolation boundary.

The connector schema available to this task remained the pre-update schema;
it had no `vm` property. Calling the tool with `vm: true`, `docker_ready:
false`, 1 CPU, 512 MiB, 4 GiB root disk and autostart false created
`agents-a3-vm-test` as `vm: false`, `type: container` on the default profile
and bridge. The connector dropped the unknown property before the updated
server received it. The guest was stopped immediately; final status was
`Stopped`. It was not used for A3 proof. The previously tested
`agents-a3-synthetic-test` LXC also remains stopped. The MCP catalog has no
delete operation; both non-ephemeral guests remain allocated for host-side
cleanup. A refreshed connector schema or a reviewed VM-capable host surface
is required before a disposable VM can be provisioned and observed.

The fail-closed A3 groundwork was submitted as draft PR
[#680](https://github.com/CyberTechArmor/ProxyPilot/pull/680) at commit
`528e889569f849ac1ca87193e3cfc8e42093cddc`, based on the deployed
`e2c40acc` main tree. Security regression run `36193254890` completed
successfully at that head. This submission is for review and does not mark
A3 accepted; the selected VM tests and all S6/SEC-01/SEC-04 proof remain open.

The user then asked for Debian in the Incus VM image picker. PR
[#679](https://github.com/CyberTechArmor/ProxyPilot/pull/679) made
`images:debian/12` selectable even when only container images are cached,
corrected the VM image preflight and passed Security regression run
`36193694335`. Its merge `87b35f221ca3523ea1abe651061a4cdb1e843dea`
was deployed by self-update `cb3d985f-09f7-4806-a8eb-b36bad3fed3b`,
exit 0 with a healthy application. The MCP catalog in this task still has
no `vm` input for `create_lxc_container`; passing the property previously
created an ordinary container. The user directed MCP-only verification, so
there is still no authorized MCP path to create the selected disposable VM
from this task. A fresh MCP schema must expose and transmit the deployed
`vm` property. Both test guests were rechecked after deployment: each is
`type: container`, `status: Stopped`, `boot.autostart: false`. No VM proof
or A3 activation followed.

## 2026-09-26 disposable Debian VM observation (supersedes the MCP availability statements above)

The refreshed ProxyPilot MCP schema exposed `vm: boolean`. The user authorized
MCP-only creation and all disposable testing. Before this continuation the A3
branch was `agents-a3-isolated-worker` at
`937c639d0b51b7cf1683b74bf6a09b490bbe6770`; `git status --short
--branch` showed one untracked probe zip and the new browser probe script,
with no tracked modifications. The A3 launch implementation remained the
fail-closed draft in PR #680. No feature flag was activated.

`create_lxc_container` was called with `vm: true`, `docker_ready: false`,
`autostart: false`, `cpu: 1`, `memory_gb: 0.5`, `disk_gb: 4`, and
`image: images:debian/12` for `agents-a3-vm-probe-01`. MCP returned
`created: true`, `vm: true`, `type: virtual-machine`. The guest was created
at `2026-09-26T11:56:57.595066535Z` on the default profile and bridge,
with `limits.cpu=1`, `limits.memory=512MiB`, `security.guestapi=false`,
`security.nesting=false`, `boot.autostart=false`, and initial address
`10.185.17.144`. The requested 4 GiB root override failed with **“Block
volumes cannot be shrunk”**; the inherited root volume remained about 9.6
GiB. This is a generic VM, not an A3 worker VM. Its caller-selected default
profile and network are not an attested worker policy.

The following operations used only ProxyPilot MCP guest tools. `free -m`
reported 430 MiB guest-visible memory and no swap; it does not measure host
QEMU RSS. `df -h` showed 9.6 GiB root, 216 MiB `/dev/shm`, 44 MiB `/run`
and 50 MiB `/run/incus_agent`. `/dev/kvm` was present. `stat` returned
ENOENT for `/dev/incus/sock`, `/run/incus/unix.socket`,
`/var/run/docker.sock`, `/root/ProxyPilot`, `/opt/proxypilot`,
`/data/services`, `/workspace` and `/evidence`. These sampled paths are
not an exhaustive mount or device audit. The Incus agent mount remained
present despite the guest API socket being absent.

| Actual VM probe | Observation | A3 result |
|---|---|---|
| `ip route` | Default route via `10.185.17.1` on `enp5s0` | No dedicated deny-by-default worker network |
| `curl -I --max-time 10 https://demo.fractionate.ai` | HTTP/2 200 | Approved synthetic origin reachable by curl, not a browser proof |
| `curl -I --max-time 10 https://example.com` | HTTP/2 200 | **Forbidden public egress reachable** |
| `curl -I --max-time 5 https://10.185.17.1:8443` | TLS handshake reached the Incus management port; curl exited 60 on its self-signed certificate | **Management network reachable**, although authenticated API use was not attempted |
| Registered bounded probe `scripts/tests/operational-lxc-probe.sh` | 167,772,160-byte `/tmp` write and 32 children succeeded, then were reaped; startup exit 0 | **128 MiB writable-space and process restraint absent** |
| `get_lxc_container` more than 300 seconds after creation | Still `Running` | **No host-enforced five-minute worker deadline** on generic VM |
| Guest cgroup root read and `sysctl -n kernel.pid_max` | No root `memory.max`, `cpu.max` or `pids.max` files; global pid max 4,194,304 | No observed guest process cap; `limits.cpu=1` is one configured vCPU, not an observed CPU overrun termination |

The bounded probe's first upload had Windows CRLF and failed with exit 127
because of its `#!/bin/sh\r` line. MCP `read_lxc_file` and
`write_lxc_file` with the observed SHA precondition replaced it with LF
content (`dda661bc1b7d6f76c05a85c902eb605cac2e49f2422a7be87497f0f943b9915e`);
the next `rerun_startup` exited 0 in 3.355 seconds. It removed its
160 MiB temporary file and reaped the children before exit. This cleanup
belongs to the test script, not a host teardown guarantee.

The separate disposable browser viability source
`scripts/tests/operational-vm-browser-probe.sh` has SHA-256
`297c7b9af1560e2cd35ec9866496c15fbbf1a8b343925fa577d7e0c077743564`.
It installed Debian Chromium 154.0.8037.57 and launched it as a nonroot
`a3browser` user through the registered startup mechanism. An initial
45-second approved-origin `--dump-dom` attempt exited 124 with zero DOM
bytes. A second bounded run tested a local `data:` page for 15 seconds
and the approved origin for 25 seconds with a ten-second virtual-time
budget; both also exited 124 with zero DOM bytes. Thus **browser viability
and positive approved-origin browser access are unproved**. The console
showed D-Bus/GCM errors, but these logs do not identify a proven root
cause. The browser probe used `--disable-dev-shm-usage`, which directs
temporary browser data to the unrestricted root filesystem; it is a
diagnostic and cannot serve as an A3 launch configuration. No agent loop,
credential or provider was run.

The VM was stopped with `control_lxc_container`, job
`8498c894-3ed6-4a63-8541-630693dde892`; a fresh `get_lxc_container`
read showed `type: virtual-machine`, `status: Stopped`, no address,
`boot.autostart=false`, and no snapshots. The non-ephemeral guest remains
allocated for review. A newly exposed MCP deletion tool refuses guests
without a snapshot; no deletion was attempted. The two interim LXC guests
also remain stopped.

This VM **fails** the required network, management reachability, writable
disk, process and deadline checks. The configured memory and CPU values do
not establish total host RSS, CPU overrun termination or one browser tree.
The approved-origin browser test, redirect/subresource policy, 20-action
host broker, cancellation, crash cleanup, per-attempt workspace removal,
host-side fence and no-replay restart proof remain unobserved on the VM.
No A3 worker was launched, so S6/SEC-01/SEC-04 remain open. Draft PR #680
must stay unmerged and the A2/A3 feature gates off until an enforceable
supervisor, isolated network and resource limits have independent target
proof. These results supersede the earlier dated statement that MCP could
not provision a VM; they do not change the earlier LXC observations.

## Verification and rollback

For the 2026-09-26 VM-evidence continuation, the affected native command
`node --import ../../../agents-a2-evidence/dependency-loader.mjs --test
src/__tests__/operational-*.test.js` passed **65/65** in `admin/backend`.
`git diff --check` exited 0 with only Windows LF/CRLF conversion notices.
This continuation changed only this evidence, the A4 gate wording and the
disposable VM browser probe; it changed no frontend or runtime source, so
the existing frontend build and browser fixture results below remain the
relevant local checks. Required Security CI for any newly submitted head
must be recorded against that exact commit in PR #680; a previous head's
green result cannot validate a later evidence commit.

From `admin/backend`:

`node --import ../../../agents-a2-evidence/dependency-loader.mjs --test src/__tests__/operational-*.test.js`

Result: **65 passed, zero failed/skipped**, including native SQLite and
registered Operations HTTP tests plus A3 contract/fence tests. A direct test
without the loader failed because this checkout lacks `zod`; the exact A2
dependency loader supplies the existing external dependencies. Frontend was
not changed; no frontend build was required. `git diff --check` passed with
only Windows LF/CRLF warnings. The host inventory command, using the bundled
Python executable, passed: **96 candidate backend files inventoried; S6
remains open**. No suppression was added. These local results precede the
draft A3 submission; its exact head must pass required Security CI.

The 2026-09-25 continuation reran the native command: **65 passed, zero
failed/skipped**. It also reran the separate disposable Chrome fixture
`node scripts/tests/operational-browser-proof.mjs` (with
`PLAYWRIGHT_CORE_DIR` and `CHROMIUM_EXECUTABLE` pointing at the existing
Playwright package and Chrome binary) passed: 20 approved synthetic-origin
fixture requests, two blocked cross-origin requests (subresource and
redirect), 20 broker calls in one context with the 21st refused by its action
limit, and credential submission refused. A separate fresh context reserved
one call to test the blocked redirect. The fixture fulfills requests
in-process; it does not contact the public demo or prove OS egress filtering.
The browser process ran on Windows outside the selected Incus VM target. The
host inventory with the bundled Python runtime and `PYTHONUTF8=1` completed
with **96 candidate backend files; S6 open**. A first unqualified `python`
invocation failed because Python was not on PATH; a second bundled-Python
invocation needed `PYTHONUTF8=1` to avoid a Windows cp1252 decode error.

Code rollback must set `OPERATIONS_ENABLED=false` for older writers and retain
additive migration 1107, run/attempt/event rows and migrations 1100–1106.
Never delete rows to make an older binary writable. No A3 OS worker exists to
stop in this checkout. The two interim LXC guests and the disposable VM are
stopped with autostart disabled and remain allocated. The refreshed MCP
deletion verb refuses guests without snapshots. A later runner must
prove teardown before terminal
disposition and must reconcile any uncertain browser effect without replay.
The next bounded prompt is [A4](fractionate-agents-a4-prompt.md), contingent
on completing the A3 target proof first.

Initial A3 worktree diff against the concurrent `7bec67f` HEAD had three
tracked modifications (`db.js`, Operations fixture and A2 test), plus ten
new files: worker schema, worker boundary, browser broker, worker test,
synthetic browser proof, three LXC probe scripts, this evidence and the A4
prompt. No other tracked
file was edited by A3. Final source/test SHA-256:

| File | SHA-256 |
|---|---|
| `admin/backend/src/db.js` | `bbe52b3f17af56e5c3e6567b20278837da1cb58fad56df645f18c5acb3f0e609` |
| `admin/backend/src/__tests__/helpers/operations-fixture.js` | `2c52cb2b1d8b9270983758bf5ccd8936dc10f5bb5d2da7528a2dd1cbfaa56dc6` |
| `admin/backend/src/__tests__/operational-agents.test.js` | `8fad626ba763c89c86b0ca5cb323b523acc134031cc4f3abb70d17f57a188cf0` |
| `admin/backend/src/lib/operational-worker-schema.js` | `717cabc6eb327b7a49d6463f6a7604385b863fcf39459fdb322c06fa8c6b9f21` |
| `admin/backend/src/lib/operational-worker-boundary.js` | `5a75e88e7c15042727ab0d68d436c993951eefa8080855ccf95c510ac7538228` |
| `admin/backend/src/lib/operational-browser-broker.js` | `87798b0ed9cb956c98f30f1ef13754c0e4cb8eec9fea5b182dd6f66eca1bfa16` |
| `admin/backend/src/__tests__/operational-worker-boundary.test.js` | `5d1f1cb0bcf68f2aabdf79df2ba2e329a86403458ab56115f6871452b93d71c7` |
| `scripts/tests/operational-browser-proof.mjs` | `3ee87c943d93bfdbbce151f0ba09df45b78e0aa42ad3d1384bd270cd49750780` |
| `scripts/tests/operational-lxc-probe.sh` | `dda661bc1b7d6f76c05a85c902eb605cac2e49f2422a7be87497f0f943b9915e` |
| `scripts/tests/operational-lxc-memory-probe.sh` | `f52b8e5705f9ad672c1e938a8b42c4d2a6d50df4d9d6d6333ff5307630ff59c0` |
| `scripts/tests/operational-lxc-crash-probe.sh` | `30460be1695a10ef6e664b27ca37a626d0b06636521fd47ce18e48e535f02a42` |
| `docs/plans/fractionate-agents-a4-prompt.md` | `2d239ac28000ba473fbcde8cf2b9aaa77302749b1d1b34c3087060f95249ce1f` |

## 2026-09-26 project-limits follow-up

The user superseded the illustrative A1/A3 numeric limits: each Operations
project now owns optional CPU, worker memory, temporary disk, run seconds,
browser actions, provider tokens and spending limits. An empty policy means
those fields are unbounded by project policy. One browser process tree,
origin/action allowlists, run fencing, a renewable 30-second attempt lease,
and verified descendant/workspace teardown remain security boundaries.
This does **not** authorize an OS runner: `createWorkerLauncher` still returns
`BOUNDARY_UNVERIFIED`. Those one-browser-tree and teardown controls remain
requirements for the future OS runner, not current enforcement. S6/SEC-01/SEC-04 remain open; no target proof was
claimed or host/guest changed in this follow-up.

Base branch/head: `agents-a3-isolated-worker` at
`031883ba6d3105d4c4788bf2125c0dae3ce64e75` (draft PR #680). The
reviewed A2 merge remains `ade9a783d1b80058f8bbcd255872d229bfdd17bc`
(PR #677). Before editing, the tracked tree was clean; the preexisting
untracked `scripts/tests/a3-vm-probe.zip` was preserved. The untracked
`fractionate-agents-a3-continuation-prompt.md` was prepared in the prior
turn and updated for this policy. No merge, flag activation or deployment
was made in this follow-up.

Migration 1108 adds `ops_projects.agent_limits_json` (default `{}`) and
`agent_limits_revision`, rebuilds `ops_agent_runs` with nullable run caps,
copies existing rows with policy revision 0 so legacy runs cannot resume
under an unbounded new policy, and restores the active-run unique index and immutable
history triggers. It runs with foreign keys disabled only during the table
rebuild and checks them afterward. Existing profile `budgets_json` remains in
the database for older history, but new profile requests reject that field
and the worker ignores it. Project owners write limits through a gated,
audited, If-Match `PUT /:id/agent-limits`; a policy change invalidates a
prepared/running worker through its pinned revision. The internal launch
spec derives the current policy from the pinned project, while the actual
launcher still refuses execution.

Verification:

| Command | Result |
|---|---|
| `node --import ../../../agents-a2-evidence/dependency-loader.mjs --test src/__tests__/operational-*.test.js` from `admin/backend` | 67 passed, 0 failed/skipped; includes owner-only limits, unbounded action/time behavior, stale policy fence and populated 1108 migration/history preservation. |
| `node node_modules/vite/bin/vite.js build --configLoader runner --config vite.codex-temp.config.mjs` from `admin/frontend`, with a temporary config defining `__dirname` | Built 1,972 modules successfully; existing dynamic-import/chunk warnings. Temporary config removed. A direct default config build was blocked by the local esbuild/junction sandbox path; bundled pnpm attempted an unavailable network reinstall, so the preexisting junction packages were restored before the successful direct Vite build. |
| `PYTHONUTF8=1` with bundled Python, `scripts/host-boundary-inventory.py` | 96 candidate backend files inventoried; S6 remains open. No suppression. |
| `git diff --check` | No whitespace errors; Windows LF/CRLF warnings only. |

Source SHA-256 after this follow-up:

| File | SHA-256 |
|---|---|
| `admin/backend/src/db.js` | `230febf661393f97467068a54bf91f1bf4abd19f175ce47217932c9cd7c90ebd` |
| `admin/backend/src/lib/operational-projects-logic.js` | `61029941776f1ac8ebdf356ec3ed14e6fbb46ba543fcdde47ff0822188f29a20` |
| `admin/backend/src/lib/operational-agents-store.js` | `53a23a51646c115f2ac2579f689eae9a1772943cdb0f5e300a5682d9f9d8e675` |
| `admin/backend/src/lib/operational-projects-store.js` | `cd387f22f6296784be8af78d8cbd7555cdf52f2a7a678a26888401460cac1135` |
| `admin/backend/src/lib/operational-worker-boundary.js` | `3b5b9a772b5be7b68deeb206b0d6d7b835e03687bc3f34241db2fa0578ea7c2b` |
| `admin/backend/src/lib/operational-agent-limits-schema.js` | `b82d91e209b6b81d2074f658f714073e37fa2f81a49a0ed327d19428679d7d90` |
| `admin/backend/src/routes/operational-projects.js` | `f04d834493dd1317c524a583e0956ce2d2833475a82deeb7ec8982625ccb85af` |
| `admin/backend/src/__tests__/helpers/operations-fixture.js` | `9d0224ef92c8c5b25353b1ba917e46e9f97a3fdbf60b69c85d661549dc6bd02b` |
| `admin/backend/src/__tests__/operational-agents.test.js` | `3cd3717533a087beac8ccf3203365e937c3fe22544f8e2fcbebb4e7a74829a60` |
| `admin/backend/src/__tests__/operational-worker-boundary.test.js` | `0450d7f8a6d9350cce39cf0843d73d36d7b071c1d55e205d5d3f877b21dd2c69` |
| `admin/frontend/src/components/operational-projects/AccessPolicy.jsx` | `9c0050a144394192f65cc34a8d50b148983b8a17d29e5d9807a58042d2d204e5` |
| `admin/frontend/src/components/operational-projects/Agents.jsx` | `2787eb6b56047bd422f2354159d626f544980e1c5cdbfb7fdcb8e27c1079b298` |

Rollback/older-writer limit: keep migration 1108 and all run, attempt and
event rows; disable `OPERATIONS_ENABLED` (and the A2/A3 agent gate) before
using an older backend. An A2 frontend sending profile `budgets` receives
HTTP 400 against the new strict request schema, so backend and frontend must
ship together when this gated feature is later activated. An older A3 writer
cannot safely create a run after the project policy changes because it does
not pin `agent_limits_revision`; do not use it for execution. No OS runner
exists at either revision.

## 2026-09-26 provisional browser VM install size

The user requested the smallest practical installed CPU/RAM/disk for the A3
browser, agent broker and human interaction. The typed launch contract now
derives a provisional **2-vCPU, 4096-MiB guest RAM, 12-GiB root disk** install
shape when project resource fields are unset. If project CPU or memory is
configured above that floor, the install shape uses the configured value; a
value below the floor fails before run preparation. This is VM capacity, not
a run quota. `temporary_disk_mib` remains a separate optional project limit.
The OS launcher still returns `BOUNDARY_UNVERIFIED`, so no VM was installed
or resized and this size has **not** passed browser or host-resource proof.

The choice uses the earlier 512-MiB VM's timed-out Chromium probes and failed
4-GiB root shrink as negative observations. ProxyPilot's generic MCP guest
creation already defaults to 2 vCPU/4 GiB RAM and describes 2 GiB browser
OOM experience; that description is a sizing clue, not A3 proof. Debian's
[Chromium package](https://packages.debian.org/trixie/chromium) is roughly
320 MB installed before dependencies and cache. Current
[Incus instance options](https://linuxcontainers.org/incus/docs/main/reference/instance_options/)
support VM `limits.cpu` and `limits.memory`; the
[root disk device](https://linuxcontainers.org/incus/docs/main/reference/devices_disk/)
supports a size value. The 12-GiB root proposal is above the prior image's
9.6-GiB inherited filesystem and below ProxyPilot's generic 20-GiB VM
default. A3 must measure host QEMU/descendant RSS separately from guest RAM,
read back the actual root size, and resize only from representative browser
and human takeover results. Incus container-only process/CPU allowance
controls cannot prove equivalent VM limits.

Local validation for this follow-up: the affected native Operations suite
passed **67/67**; the frontend production build passed; the host-boundary
inventory returned **96 candidate files, S6 open**, without suppression;
`git diff --check` found no whitespace errors (only Windows line-ending
warnings). No new target proof, feature activation, deployment or merge is
claimed. The updated bounded work prompt is
[A3 continuation](fractionate-agents-a3-continuation-prompt.md).

Follow-up source SHA-256 before submission:

| File | SHA-256 |
|---|---|
| `admin/backend/src/lib/operational-worker-boundary.js` | `4b7a4b620f246ae2b1650fa96f1505afbf53105ce081f4e4885fe7d595e15fe9` |
| `admin/backend/src/__tests__/operational-worker-boundary.test.js` | `978dc7ccaded3dd6814cdfc2cc311c33e0eb5e315e2de499740eff6306785683` |
| `admin/frontend/src/components/operational-projects/AccessPolicy.jsx` | `af2e9ee54748b224ad9749e90bfa8a0d3ff00e74184d3ac2192f3f9a4d2f7c38` |
| `docs/plans/fractionate-agents-a3-continuation-prompt.md` | `a028ebbaeadf52f5c0e4f81257f2a9ef9e82c0460b8f64a3014266462c49367c` |

## 2026-09-26 continuation after the groundwork merge

GitHub reported PR #680 **merged**, with exact head
`4c4a3ce22086f25727302f58b1e4b61c82fcc061`, base
`e2c40accf1689d31454350165391f9d8b15a1990`, and merge commit
`5946de10c7048979949fd84c1cdc3bd25a7cf605`. Security regression
run `36252438415` succeeded on that head. The current `main` branch API and a
fresh `git fetch origin main` both reported the merge commit. The prior
instruction to keep PR #680 draft cannot be applied after its merge. The
continuation was moved to `agents-a3-isolation-continuation` based on that
exact `origin/main`, carrying only this turn's uncommitted edits. No earlier
commit was reset, rewritten or silently integrated. The pre-edit branch was
`agents-a3-isolated-worker` at `4c4a3ce22086f25727302f58b1e4b61c82fcc061`;
complete pre-edit status was only
`?? scripts/tests/a3-vm-probe.zip`. That preexisting ZIP remains untracked,
unmodified and excluded from the intended diff (SHA-256
`4cae3e4a36c0b9809270aef126c6c47c0b3ddb67fb144f387854c299616ad9fb`).

The host package readback reported Incus
`1:7.5.1-debian13-202609250203`. Before the attempted resize, the stopped
`agents-a3-vm-probe-01` was a Debian 12 virtual machine with one vCPU,
512 MiB configured RAM, autostart off and guest API/nesting off. A
`set_lxc_resources` dry run planned two vCPUs, 4096 MiB and an explicit
12 GiB root disk, with a snapshot first. The apply call timed out at the
connector (HTTP 504). Readback showed the new pre-resources snapshot but
still reported one vCPU and 512 MiB; no successful disk readback was
available. The call was not treated as a successful resize, was not retried
blindly, and the VM remained stopped. A separate `create_lxc_container`
request for a Debian 13 VM with `vm:true`, two vCPUs, four GiB RAM, 12 GiB
disk and autostart off returned `INVALID_ARGUMENT` twice, including a call
that omitted `docker_ready`. A fresh guest inventory showed no new guest;
no Debian 13 VM, browser or human transport was installed by these calls.

The source correction removes the browser broker's old 20-action and
300-second local caps. Fixed JSON reads retain a 10-second request timeout.
The project-owned durable reservation already checks
the pinned policy revision, cumulative action count and optional run
deadline on every operation. A separate broker-local counter would incorrectly
stop an unbounded project at 20 and reset on a broker restart. The updated
browser proof uses an explicit disposable 25-action reservation policy;
the new native test performs 25 actions and observes that the 26th is refused
by the reservation. Credential submission remains unavailable, and the OS
launcher still returns `BOUNDARY_UNVERIFIED`. This correction is source-level
only; it does not establish target broker enforcement.

Verification from `admin/backend`:
`node --import ../../../agents-a2-evidence/dependency-loader.mjs --test src/__tests__/operational-*.test.js`
passed **68/68** native SQLite/HTTP/worker tests. From repository root,
`PYTHONUTF8=1` with the bundled Python running
`scripts/host-boundary-inventory.py` inventoried **96** backend candidates and
left S6 open without suppression. `git diff --check` found no whitespace
errors (Windows line-ending warnings only). No frontend file changed, so no
frontend build was required for this diff. The exact review diff is
`git diff origin/main` on this continuation branch; it changes the broker,
worker test, browser proof and this evidence/prompt only. Pre-edit broker
SHA-256 was `4d5aea71db85487434c5b2f29e56e905231507e8bb02c6343ee8cb68d6ba12c6`.
Post-edit source SHA-256 values before evidence edits are:

| File | SHA-256 |
|---|---|
| `admin/backend/src/lib/operational-browser-broker.js` | `dc39701c8a091d07875c03204b3092c448be8dde29be780586c4fd2f4a6ee493` |
| `admin/backend/src/__tests__/operational-worker-boundary.test.js` | `a0a94677b5a824f3d7fe050697c3f869e013437ee661efae3d0d5ba2bdd61c13` |
| `scripts/tests/operational-browser-proof.mjs` | `a9555f31eea294d9027e793291aa63206505ea98629d531db2fd0b9b2b859637` |
| `docs/plans/fractionate-agents-a3-continuation-prompt.md` | `7e36036fd1b7490561e768ff586c8afe582abe7489efb240fb4f03d976f7d9f9` |

**A3 is still blocked.** The Debian 13 VM capacity, host QEMU RSS, root
disk, restricted network, browser viability, approved-origin sign-in, human
takeover, process/temporary-disk/time limits and independent teardown remain
unproved. The existing Debian 12 VM's observed public egress and Incus
management reachability remain failures. S6/SEC-01/SEC-04 stay open; no
feature activation, provider, credential, vault or live identity was used.
Rollback of this continuation is the small broker/test/document diff; retain
migrations 1100–1108 and immutable history. Older writers still require
`OPERATIONS_ENABLED=false` and the agent gate off before rollback. Do not
start A4 until a Debian 13 target and its host-enforced boundary pass.

The correction was submitted as draft PR
[#686](https://github.com/CyberTechArmor/ProxyPilot/pull/686), initially at
`5cacdefbc5d38f6d463249089cdb664557ff9639`. Its exact-head
[Security regression run](https://github.com/CyberTechArmor/ProxyPilot/actions/runs/36254343922)
completed successfully: frontend, backend, agent and all four audit jobs
passed. The backend job included the unsuppressed host-boundary inventory.
This CI pass validates that source revision; it does not close the VM target
failures or authorize merging the draft.

## 2026-09-26 correction: VM creation timed out after Incus created it

The earlier `INVALID_ARGUMENT` and "no Debian 13 VM" interpretation above was
incorrect. The connector's structured error code is generic; its text block
contains the server's actual response. A repeated creation request for
`agents-a3-browser-proof` took longer than the MCP gateway deadline and
returned HTTP 504. ProxyPilot MCP readback then found a **stopped Debian 13
virtual machine** created at `2026-09-26T18:20:24.655225835Z` with
`limits.cpu=2`, `limits.memory=4096MiB`, `boot.autostart=false`,
`security.nesting=false`, `security.guestapi=false`, and an instance root disk
device of exactly `12GiB`. It had no address, browser, or human transport.
No second guest should be launched. A subsequent start was refused because
the previous `instance_create` setup job still held a stale lease; its exact
job status was not available through the deployed MCP catalog. The guest
remains stopped and is **not** an isolated worker.

The underlying API issue is synchronous waiting for durable setup jobs:
`create_lxc_container` waited through VM launch and post-launch setup, and
`set_lxc_resources` waited through a VM snapshot and resize. Both can exceed
the gateway deadline while the job continues or enters recovery. The local
correction submits those VM operations and returns a job id without claiming
completion, exposes compact per-guest setup job and lease status through MCP,
and adds a token-gated acknowledgement for only an inspected
`interrupted_uncertain` or `init_uncertain` job. The existing setup engine
still binds the acknowledgement to the exact stale lease and never replays
the uncertain operation. It does not acknowledge the live job by itself.

Focused Windows validation used the dependency set installed in the sibling
checkout: the three resource/job/acknowledgement tests and all 19 extended
MCP catalog tests passed; the pure VM Incus argv test passed. The full
setup-guest-config suite cannot pass on this Windows host because its
reserved-port tests invoke Unix `sh` and `sysctl`. The MCP-only repair was
cherry-picked from commit `f37208dbb404888bfc84ebc3caf7bd55af6d871b`
onto current `main` as `b591171ec7e97e16ee77311f4f2b809e5a1f4914` in
[PR #687](https://github.com/CyberTechArmor/ProxyPilot/pull/687).
Its exact-head [Security regression run](https://github.com/CyberTechArmor/ProxyPilot/actions/runs/36263182848)
passed all seven jobs. The A3 continuation head before this evidence update,
`c82834ef7dde4219280f1d5978e074b2536331f2`, also passed all seven jobs
in [run 36263094910](https://github.com/CyberTechArmor/ProxyPilot/actions/runs/36263094910).
The live host still runs an older checkout;
the new MCP status and acknowledgement tools are not deployed. The job must
be inspected and its stale lease resolved before any start or browser proof.
S6/SEC-01/SEC-04 remain open, A3 stays inactive, and PR #686 remains draft.

## 2026-09-26 live MCP repair deployment

PR #687 merged at `869c5bcd38ae7bc56b8bce255350f399af6c7da0` after
its seven-job Security CI pass. ProxyPilot's managed update run
`79e33237-6dc6-4c9e-bf3e-e7cf9a2ac89f` succeeded from
`10fdc9bbe848420a9c98180087b850c0760dcfa7` to that merge commit;
the rebuilt Docker backend reported healthy. The live checkout read back
clean at the merged SHA. `agents-a3-browser-proof` still read back as a
stopped VM with its original 2-vCPU, 4096-MiB and 12-GiB configuration.
A resource dry run confirmed the same values and changed nothing.

The first update spent a prolonged period copying the entire `admin`
directory into the Docker build context, including host-installed
`node_modules`. PR #688 replaced that copy with a tar stream that keeps
source and the built frontend while excluding host dependencies and
preserving install-local data. Its focused copy test, Bash syntax check and
seven-job Security CI passed; it merged at
`3401bead4dafb6bf790fcfb431e9e50882778c77`. A second managed update
was submitted as `5f02caef-41fa-4afe-b88d-f243b7f4e611` to deploy it.
That run succeeded from `869c5bcd38ae7bc56b8bce255350f399af6c7da0`
to `3401bead4dafb6bf790fcfb431e9e50882778c77`, reporting a healthy
Docker restart. The live checkout read back clean at the final merged SHA.
Systemd showed the new tar helper excluding both host `node_modules`
directories. The second copy phase completed and the update succeeded; this
does not quantify the copy's exact duration because the dashboard was
temporarily unavailable during Docker rebuild.
The original update completed without interruption, so the attempted
managed service restart was not performed; automatic approval review had
rejected interrupting the active copy due to partial-install risk.

This chat's ProxyPilot connector still advertises its pre-deployment tool
catalog, so `get_lxc_setup_jobs` and `acknowledge_lxc_setup_job` cannot yet
be called through this MCP connection even after the second deployment.
No uncertain job was acknowledged,
no stale lease was released, and the VM was not started. The actual setup
job outcome, target network fence, browser and human takeover proofs remain
unverified. A3 stays inactive and PR #686 stays draft.

## 2026-09-27 continuation: Debian 13 policy and disposable VM readback

The continuation integrated `origin/main` at
`d3de8659add2f41a26ec15fd1943c45704ac857a` with a reviewable merge
commit `c0d6041cfaae315af3e2a7345a50ce051a949890`. No existing guest was
upgraded, deleted, or restarted. In particular, `pp-nodus` remained running
and untouched. The two older named A3 proof VMs were absent; the remaining
`agents-a3-synthetic-test` and `agents-a3-vm-test` were stopped containers.
The two small, unmounted Incus-owned ZFS records for the deleted VMs were
left for separate reconciliation; no direct ZFS mutation was attempted.

Before creation, `list_lxc_containers` and `zfs_list` showed neither an Incus
name nor storage collision for `agents-a3-debian13-proof-20260927`. The
ProxyPilot MCP `create_lxc_container` request used `images:debian/13`,
`vm:true`, 2 vCPU, 4 GiB RAM, 12 GiB root, `docker_ready:false`, and
`autostart:false`. Setup job `813a3120-1e0c-4fc9-8226-ca02600a08cb`
succeeded. `list_host_packages(filter=incus)` reported
`incus 1:7.5.1-debian13-202609250203`. `get_lxc_container` read back a
running virtual machine created `2026-09-27T09:19:00.951999976Z`, with
`limits.cpu=2`, `limits.memory=4096MiB`, `security.guestapi=false`,
`security.nesting=false` and `boot.autostart=false`. `get_lxc_usage` read back
a `12GiB` root device, zero swap, 248,733,696 bytes guest memory used and
123 processes at one sample; `free -m` reported 3,845 MiB total guest memory
and zero swap, and `df -h /` reported 12 GiB total, 708 MiB used. These are
guest/Incus measures, **not** host QEMU-plus-descendant RSS. The MCP catalog
did not expose the actual Incus image fingerprint or host process RSS, so
neither can be claimed as proved.

`read_lxc_file(/etc/os-release)` on this VM returned `ID=debian`,
`VERSION_ID="13"`, `DEBIAN_VERSION_FULL=13.7`, with SHA-256
`e249e69c32d81350fdd6b05ac5575255f14e380ba14b8454acea14e49f088bfa`.
This is the guest OS proof; the requested image alias alone was not used as
proof. A Chromium/font `install_package` dry run was refused by the deployed
MCP package allowlist. No browser was installed, no cold starts were measured,
and no synthetic sign-in or human takeover was attempted. The local untracked
probe archive `scripts/tests/a3-vm-probe.zip` was preserved without applying
it; its SHA-256 is
`4cae3e4a36c0b9809270aef126c6c47c0b3dd67fb144f387854c299616ad9fb`.

Network negatives on the actual VM were decisive: `curl -I
https://demo.fractionate.ai` returned HTTP/2 200, but `curl -I
https://example.org` also returned HTTP/2 200, and a request to the bridge
management address `http://10.185.17.1:8443` reached it and returned HTTP
400. `stat /dev/incus/sock` found no guest API socket. The public and
management reachability prevent host-boundary acceptance; redirects,
subresources, DNS, raw IP, WebSocket and CONNECT escape denial have not been
proved. The only VM mutation after these negatives was a clean stop via
ProxyPilot MCP. Stop job `2ee88fd2-fe4f-40c6-b31d-20cec1ca1983`
succeeded, and a final `get_lxc_container` readback showed **Stopped**, no
addresses, no active Incus operation and no setup lease. The disposable VM
was retained stopped for review.

The source change now pins all new image aliases to `images:debian/13`,
rejects explicit image overrides including Debian 12, and checks the
resulting guest's `/etc/os-release` after creation. Dashboard/MCP, Mock2,
application migration, clone and import paths either obtain guest readback or
fail closed with a reason; snapshot/S3/host restore paths without a safe
readback route are disabled before creating a guest. Mock2 also refuses an
existing-name collision. The policy deliberately does not rewrite historical
fixtures or existing guests. This source has **not** been deployed to the
live ProxyPilot host.

Local verification: 85 native SQLite/HTTP/worker/migration/Mock2 tests in
the affected groups passed with Node's test runner and the bundled native
dependency loader. Focused lifecycle, post-launch, dashboard and storage
tests passed; broader Windows suites encounter baseline Unix `sh`, symlink
and path assumptions. `node --check` on edited backend files, `git diff
--check`, and the frontend Vite production build passed. The unsuppressed
`scripts/host-boundary-inventory.py` returned **96 candidate backend files;
S6 remains open**. No Security CI result for this new head is claimed here
until a submitted exact-head run completes.

Rollback for this source change is a code revert of the Debian 13 policy and
documentation; it does not require changing any guest. Older writers remain
unsafe for activating an A3 worker: keep `OPERATIONS_ENABLED=false` and the
agent feature gate off while any older backend can write the operational
tables. The durable run/attempt store and typed browser contract still have
no independently enforced OS runner or credential broker. Cumulative CPU,
memory, process and temporary-disk limits, private workspace/descendant
teardown, cold browser starts, forced overruns, crash/restart recovery and
human takeover are unproved on the VM. S6/SEC-01/SEC-04 stay open. PR #686
must remain draft and unmerged; no deployment, live agent, provider,
credential, vault or real sign-in identity is authorized by this evidence.

## MCP proof surface added after the stopped-VM probe

Source now includes `inspect_a3_vm`, a read-only MCP tool restricted to an
Incus virtual machine in the Running state. It reads the Incus server version,
expanded CPU/memory/root-disk configuration, actual guest `/etc/os-release`,
guest visible CPU/RAM/swap, image fingerprint, Incus VM UUID and guest boot ID,
and the exact host QEMU process
plus descendant RSS. Any missing item, a container, a stopped VM, or a guest
that does not prove Debian 13 is refused with a reason. The package allowlist
now includes Debian `chromium`, `fonts-liberation`, and `fonts-dejavu-core` for
the existing confirmed `install_package` action. These changes are source
only; the stopped proof VM was not started and no package was installed.

Local commands `node --check src/routes/mcp-tools/lxc-admin.js` and
`node --test --test-reporter=spec --test-name-pattern="inspect_a3_vm|extended
catalog is well-formed" src/__tests__/mcp-extended.test.js` passed (2 tests).
The unsuppressed `scripts/host-boundary-inventory.py` passed after reviewing
and recording the new fixed host-read call site: 96 candidate backend files,
with S6 still open. `git diff --check` passed.
Actual image fingerprint, host QEMU RSS, browser latency and the host network
boundary remain unmeasured until this tool is deployed and the VM can be
started behind a verified deny-by-default fence. The older-writer and
S6/SEC-01/SEC-04 limits above still apply.

## 2026-09-28 host-owned worker supervisor (implementation; target proof open)

**A3 remains in progress and is not accepted.** This continuation implements the
host-owned supervisor, the guest worker runner, the human view/control path, the
proof runner and the typed backend client. It proves them locally against a real
Chromium. It has **not** yet run on the proof VM: installing the supervisor and
running the lifecycle proof need one host-root command (below). Every earlier
open gate stays open until that output is reviewed. No feature flag, route,
provider, credential, vault, live identity or deployment was activated, and
`pp-nodus` was not read or touched.

### Reconciliation before editing

- Work ran in a cloud session on branch `claude/step-a3-isolated-execution-yg80mx`,
  created from GitHub `main` `12ad1392845630eec56705776bae444f54eac58a` (clean).
  The Windows workspace (`agents-a3-isolation-continuation` at `83387f7b`, with its
  uncommitted work and the untracked `scripts/tests/a3-vm-probe.zip`) is not
  reachable from this session. Nothing from it is claimed, copied or overwritten.
- `get_self_status`: live `main` `33528751b0b68771a768a69ef42c0bd614069498`
  (clean, 1.4.0); candidate `pp-candidate` `7851c1a0d6084213e842151d37083d49ff204dd8`
  on that base, 17 ahead, 0 dirty, with `backend-tests` ok and `backend-syntax`
  skipped at that exact head. Neither SHA exists on GitHub.
- PR #686 is still open, draft and unmerged at `cd4abbca`, base `d3de8659`, and
  GitHub reports it `dirty` (conflicting). This branch carries only its small broker
  correction (`5cacdefb`: no broker-local 20-action/300-second cap; the durable
  reservation owns totals). The rest of #686 is already in `main` through #695.
- `inspect_a3_vm` read back the handoff's exact target: Incus 7.5.1, Debian 13.7,
  UUID `49592202-a8b0-45af-9ac6-5439761d73e4`, boot `b08210f9-fe81-4e86-9362-926f5ee21e59`,
  QEMU PID 272179, 2 vCPU, `4096MiB`, `12GiB` root (guest filesystem
  12,307,730,432 bytes), swap 0. `eth0` is on `incusbr0` with host name `ppa3proof0`
  and MAC `10:66:6a:55:f6:3f`; image fingerprint `4e38eb6d…9840a`; QEMU tree RSS
  1,481,121,792 bytes. `get_host_services`: `proxypilot-a3-fence.service`
  active/exited and `proxypilot-a3-origin-proxy.service` active/running. The fence,
  proxy, cold-browser and cgroup probe outputs in the handoff are user-reported;
  this session corroborated the services and VM identity but did not rerun those
  probes.
- The candidate's A3 backend files are byte-identical to GitHub `main`
  (`operational-worker-boundary.js` `89293cb3…`, `operational-browser-broker.js`
  `87798b0e…`, `operational-agents-store.js` `53a23a51…`, `db.js` `1860024a…`,
  the boundary test `739af82e…`, `host-boundary-inventory.py` `c76d4b25…`,
  `self-edit.js` `05e9b766…`, `CLAUDE.md` `39077531…`, this evidence file
  `6f4dfe8e…`).
- Candidate-only A3 files were mirrored into this branch, each verified against the
  candidate's `read_self_file` sha256 and size: `a3-network-fence.py` `8d756bd2…`,
  `a3-install-fence.py` `314b7766…`, `a3-origin-proxy.py` `0a48a12b…`,
  `a3-install-proxy.py` `d4cb9bb8…`, `a3-probe-fence.py` `26e7fc14…`,
  `a3-probe-proxy.py` `06125dc3…`, `a3-probe-browser.py` `75f95b3f…`,
  `a3-probe-guest-cgroups.py` `57b42de7…`, `prepare-self-check-native.mjs`
  `e61c52cf…`, and tests `test_a3_network_fence.py` `2d0745a6…`,
  `test_a3_install_fence.py` `cc759291…`, `test_a3_origin_proxy.py` `16e6a457…`,
  `test_a3_probe_fence.py` `ddee0782…`, `test_a3_guest_cgroups.py` `20b2712c…`,
  `test_a3_browser_probe.py` `f47c7e34…`. From the candidate policy file only the
  `backend-tests` install line (`prepare-self-check-native.mjs`) was carried over.
  That file also lists live-only Nodus route-ingress tools, which are not A3 work
  and were not copied.

### What was built

- `scripts/a3-worker-supervisor.py` is a root-only daemon. The installer copies
  reviewed files into `/etc/proxypilot-a3-proof/supervisor`, and the daemon refuses
  to serve unless its own files match the install journal.
  - **Backend socket** `/run/proxypilot-a3/supervisor.sock` (uid 0 peers only):
    `status`, a typed `launch`, `renew`, one fixed browser `action`, and `stop`
    (`cancelled|blocked|failed`).
  - **Operator socket** `operator.sock`: adds the proof workloads, `takeover`,
    `view`, typed `input`, `observe`/`locate` proof readbacks, `egress_probe`,
    `unit_stats`, `journal` and a crash-mid-action proof hook.
  - **Launch preconditions:** the installed fence and proxy (`a3-install-proxy.py`
    `status()`, which includes the fence status), the exact VM UUID, a running
    QEMU, the guest NIC MAC, a readable boot ID and the install shape.
  - **Binding and budgets.** Each attempt binds run, attempt, workspace, fence,
    policy digest, project-limits revision, VM UUID, boot ID and QEMU PID in a
    host journal that is written durably before any guest effect. Only one attempt
    may be live. A run pins its policy, deadline (first launch + `max_seconds`) and
    `max_actions` on first launch. A later attempt, a lease renewal or a restart
    cannot reset them, and a policy mismatch or a non-increasing fence is refused.
  - **The worker unit.** Each attempt is one transient guest unit started through
    `incus exec … systemd-run --pipe --wait --collect`:
    - identity: `User=nobody`, `NoNewPrivileges`, empty capability bounding set;
    - filesystem and devices: `ProtectSystem=strict`, `ProtectHome`,
      `PrivateDevices`, `PrivateIPC`, `ProtectProc=invisible`, the kernel
      protections, empty read-only tmpfs over `/run` and `/var`, and the
      inaccessible paths;
    - network: `RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK` and
      `IPAddressDeny=any` except `10.185.17.1/32`;
    - workspace: private tmpfs `/tmp` sized to the temporary-disk limit, plus a
      128 MiB `/dev/shm`;
    - limits: `MemoryMax` (the limit, or the guest's MemTotal − 768 MiB),
      `MemorySwapMax=0`, `TasksMax=512`, `CPUQuota` = cpu×100% when configured,
      `RuntimeMaxSec` = time left to the pinned deadline, `OOMPolicy=kill` and
      `KillMode=control-group`.

    The supervisor reads back the unit's cgroup `memory.max`, `memory.swap.max`,
    `pids.max`, `cpu.max` and its sandbox properties, and refuses the launch on any
    mismatch.
  - **Lease and watchdog.** The lease is 30 s. Every 10 s a light health check
    compares the fence table fingerprint, fence/proxy liveness and the VM
    UUID/QEMU PID. A lost lease, a passed deadline, a worker exit or a lost boundary
    tears the attempt down.
  - **Teardown and receipts.** Every stop is followed by guest readback: the unit
    is inactive or collected, the cgroup is empty, no process is in it or runs as
    the worker uid, and no mount of the workspace tmpfs device remains. A stopped
    VM or a new boot ID also counts as proof. A Frozen VM does not; it stays
    unverified and is retried. Only then is a receipt signed with the host-held
    Ed25519 key (`a3r1.<payload>.<sig>`). An unverified teardown keeps the attempt
    `stopping`, which blocks every new launch.
  - **Recovery.** Actions are journaled `started` before they are sent. After a
    restart, recovery tears down every non-terminal attempt, marks any in-flight
    action `uncertain` and never replays it, and stops orphan `pp-a3-worker-*`
    units. A `stop` for an attempt this supervisor never started returns a signed
    "never launched" receipt, and that attempt can never be started later.
- `scripts/a3-worker-guest.py` is the fixed program the unit runs. It drives
  exactly one Chromium over `--remote-debugging-pipe`, so no DevTools socket
  exists, and keeps Chromium's own sandbox (no `--no-sandbox`). Every request from
  the page, its frames and its workers passes CDP `Fetch` with the broker's
  same-origin read-only policy, including redirect hops. Other page targets are
  closed and downloads are denied. The browser uses the host proxy
  (`<-loopback>`, `MAP * ~NOTFOUND`) with the pinned SPKI. It serves the six typed
  actions (`submit_bound_fixture` is refused as `CREDENTIAL_BROKER_UNAVAILABLE`),
  screenshots, typed human input (a point, 8 fixed keys, ≤256 printable characters,
  bounded scroll) and fixed proof workloads. It exits after 20 s without host
  contact or when its channel closes. Page reads run in an isolated world and are
  labelled untrusted.
- `scripts/a3-install-supervisor.py install|status|remove|reinstall` copies the
  reviewed files byte-exact with digest readback, generates the Ed25519 key (0600)
  and installs `proxypilot-a3-supervisor.service`. That unit has
  `Requires=proxypilot-a3-fence.service` and is ordered after the fence and proxy.
  Activation is verified by a live `status` carrying the new key ID, and a failed
  activation rolls back every file it wrote. `remove` refuses while an attempt is
  live and archives the public key so old receipts stay verifiable. It never
  touches the VM, the fence, the proxy, Incus profiles or firewall tables.
- `scripts/a3-worker-operator.py` is the root operator CLI. Its `human` page is the
  smallest usable human view/control path. It binds to loopback only (reach it with
  an SSH local forward), requires a per-run token and a loopback Host header, and
  sets a strict CSP. It shows the screenshot and sends only typed input, and only
  after Take over. It has no URL bar, no script input and no DevTools.
- `scripts/a3-probe-worker.py` is the target proof. It runs against the
  **installed** supervisor through its real sockets:
  - three measured browser sessions;
  - human takeover;
  - page-level origin refusals;
  - in-unit escape;
  - guest-root IPv4/IPv6 egress with nft counter deltas;
  - forced CPU, memory, process, disk, time and action overruns, using proof
    workloads under the production unit builder;
  - a detached descendant;
  - lease expiry, stale fence and launch failure;
  - backend-socket refusals;
  - a supervisor crash between the durable action reservation and delivery;
  - a guest crash (sync, then sysrq reboot), followed by the post-reboot fence and a
    relaunch.

  Receipts are verified with the public key. The full JSON and screenshots are
  written to `/var/lib/proxypilot-a3-proof/proof/`. A host reboot is deliberately
  not performed.
- Backend. `lib/operational-worker-supervisor.js` holds a typed Unix-socket client
  (backend methods only) and `createTeardownVerifier`: Ed25519 verification pinned
  to the proof VM UUID and the attempt's bound boot. `createWorkerLauncher({client, vmUuid})`
  keeps `BOUNDARY_UNVERIFIED` when it has no client and checks the supervisor's
  launch readback. The launch contract adds `workspace_id` and
  `project_limits_revision`. Additive migration **1109** gives
  `ops_agent_worker_attempts` the columns `vm_uuid` and `boot_id`, set by
  `markRunning(ref, binding)` and checked by `finishStop`. Nothing in the routes
  constructs a client, and the socket is not mounted into the backend container.
- **Limit semantics correction (for review).** Project `cpu`, `memory_mib` and
  `temporary_disk_mib` now limit the worker unit *inside* the VM. The previous rule
  compared them with the VM floor, and that made CPU and memory enforcement
  unprovable on the fixed 2-vCPU/4-GiB proof VM. Worker minimums are CPU 1,
  memory 1024 MiB and temporary disk 64 MiB. They are **provisional** until the
  proof's measured browser peak confirms them. A configured value below a minimum
  refuses launch and is never raised. The install shape stays at least
  2 vCPU / 4096 MiB / 12 GiB, and above that it is `cpu` and `memory_mib + 1024`.
  A limit larger than the installed VM fails with `VM_CAPACITY_INSUFFICIENT`
  instead of a silent resize. The dashboard text in `AccessPolicy.jsx` states this.

### Local verification (this session)

| Command | Result |
|---|---|
| `python3 -m unittest discover -s scripts/tests -p 'test_a3*py'` | **69 passed** (45 mirrored + 24 new). Includes real Chromium 141 over the private pipe through a local CONNECT proxy to a locally pinned TLS origin: actions, screenshot, human click/Escape, 8/8 page escape attempts refused, a cross-origin redirect refused, only the approved Host reached, browser tree gone after stop. Also includes the real supervisor → runner → Chromium path with takeover and a verified receipt. |
| `node --test src/__tests__/operational-*.test.js` (admin/backend) | **73 passed** (68 existing and updated + 5 new supervisor/verifier/binding tests). A receipt produced by the Python supervisor code verifies with the Node verifier. |
| `npm test` (admin/backend, native `better-sqlite3` rebuilt) | Branch 3374 tests: 3348 pass, 12 fail, 14 skipped. Clean `origin/main` in the same sandbox: 3368 tests: 3343 pass, 11 fail, 14 skipped. The 11 shared failures are identical sandbox failures (root-only bootstrap/recovery, `vpn-mtu`, several ratchets). The one branch-only failure, `setup-deploy.test.js`, came from running both suites concurrently; alone it passed 18/18 three times. |
| `npm run build` (admin/frontend) | Passed (1,972 modules; existing chunk warnings). The only UI change is explanatory text. |
| `python3 scripts/host-boundary-inventory.py` | 96 candidate backend files; S6 remains open; no suppression. |
| `systemd-analyze verify` (systemd 255) on the worker unit's properties and the supervisor unit | All worker properties parsed. Expected warning: `User=nobody` is shared (kept because the earlier guest probes proved Chromium under uid 65534). The supervisor unit failed only on the absent local fence unit. |

### Still open (every item needs observed target evidence)

- Supervisor installation on the host and the full `a3-probe-worker.py` result on
  the proof VM: every lifecycle, overrun, escape, crash and human-control case above.
- Measured browser minimum and VM sizing: unit `memory.peak`, `pids.peak`, host
  QEMU tree RSS, guest memory and pressure, free disk and log growth across the
  three sessions. The minimums above are provisional until then.
- A real human (not the automated operator path) using the `human` page.
- Host reboot persistence of the fence → proxy → supervisor ordering.
- Backend wiring: the socket mount into the container and a coordinator (A5).
  Activation stays off.
- The origin-proxy certificate is valid for 7 days from its install and
  `a3-install-proxy.py status` refuses under 24 h of validity. A launch will fail
  closed after about 2026-10-03 until the proxy certificate is re-issued (proxy
  `remove`/`install`, then a fresh proxy probe).
- S6/SEC-01/SEC-04 remain open. The supervisor narrows the worker path, but a
  compromised root-equivalent backend keeps its other host interfaces.

### Operator commands and rollback

The installation and proof run from the candidate checkout (the installer copies
reviewed bytes into root-owned `/etc`, and the journal records their digests):

```
sudo python3 /var/lib/proxypilot/self/candidate/scripts/a3-install-supervisor.py install
sudo python3 /var/lib/proxypilot/self/candidate/scripts/a3-probe-worker.py
```

Ordered rollback, which adds to the handoff's order:

1. Keep A3/Operations flags off.
2. `a3-worker-operator.py status`. Stop any live attempt with `a3-worker-operator.py stop <run> <attempt> <fence>` and check its receipt with `verify-receipt`.
3. `a3-install-supervisor.py remove`. It refuses while an attempt is live, and it keeps the state journal and the archived public key.
4. The proxy and fence rollback steps are unchanged.

A code rollback is a revert of this branch. Migration 1109 is additive: keep it
and its rows. Older writers do not set `vm_uuid`/`boot_id`, which is safe only
while A3 is inactive.
