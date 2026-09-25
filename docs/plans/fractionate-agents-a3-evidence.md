# A3 isolated worker boundary — local review stop

Date: 2026-09-25. **A3 is blocked, not accepted.** The source adds a closed
internal contract and durable fencing records. It does not launch a worker,
browser, provider or credential broker. This A3 work made no route, feature
activation or live account action. User-authorized MCP tests created and
stopped two disposable LXC guests. Neither guest is the selected VM boundary.

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

## Verification and rollback

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
stop in this checkout. The interim LXC is stopped with autostart disabled;
MCP has no delete verb, so its storage remains allocated. A later runner must
prove teardown before terminal
disposition and must reconcile any uncertain browser effect without replay.
The next bounded prompt is [A4](fractionate-agents-a4-prompt.md), contingent
on completing the A3 target proof first.

Final A3 worktree diff against the concurrent `7bec67f` HEAD has three
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
