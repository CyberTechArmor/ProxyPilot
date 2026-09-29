# S6 host boundary: partial implementation, finding remains open

Base for this stage: `825d050714668fb5b2d5d6bac30ac437805d0e68`.
The standard backend still runs with host-root-equivalent authority. Neither
Stage A authorization fixes nor the transport hardening below removes that
architecture. This is **partially implemented/open**, not “implemented, host
verification pending.” Do not describe all eight audit findings as closed.

## Changes delivered in this stage

- The existing Go agent authenticates Unix clients with Linux `SO_PEERCRED`.
  Its root-managed unit allows host UID 0. `--client-uids=0,1000` is an example
  of an explicit root-managed allowance for a different deployment, not an
  instruction to add that UID. Determine the actual host-observed UID first.
  Socket group membership is no longer sufficient. This authenticates a
  process, **not a human, resource grant or independent approval**.
- Request reads stop at 64 KiB without allocating an unbounded line. Unknown
  envelope fields and undeclared method parameters are refused. No generic
  exec/file-write method was added. The Node client bounds serialized requests
  before connecting and verifies response IDs on both success and error.
- At most 32 connections execute concurrently, with four calls per method.
  Update/check/storage-install submissions share one serialized slot; CVE
  patching has one slot. Read/write deadlines are 30/5 seconds. Oversized
  responses are refused at 4 MiB. Existing smaller client limits still apply.
- Command output is capped at 2 MiB per stream. Overflow is an error and kills
  the process group. Caddy commands have a 30-second deadline; storage retains
  its 10/30/120-second command deadlines; CVE probes have 30 seconds (dpkg
  comparison: 10 seconds), package/grub maintenance up to 30 minutes per
  command. Cancellation kills child process groups; inherited-pipe waits are
  also bounded. These are command bounds, not an overall multi-command job SLA.
- Agent audit records contain kernel UID/PID, registered method, fixed outcome
  and duration. No params, results, caller-provided method text or error details
  are logged. Unit limits cap file descriptors, tasks and memory.
- The updater's automatic replacement of capability restrictions with
  `privileged: true` is removed. A read-only preflight resolves effective Compose
  configuration, including overrides, before checkout/environment/service
  mutation. Restricted/custom backends are refused with recovery guidance;
  their configuration is preserved. Standard legacy deployments remain
  supported. Compose v2 is required for this preflight. It does not make the
  legacy root-equivalent baseline secure.
- CI records new/changed direct-host candidates through
  `scripts/host-boundary-inventory.py`. The checked-in
  [candidate inventory](security-host-interfaces.json) covers 96 backend files
  matched by namespace, command, process-import and host-path patterns. It
  deliberately includes comments/imports. It is review evidence, not a claim
  that all matches execute or that nonmatching indirect access is safe.

The `get_lxc_container` MCP read now invokes fixed `incus operation list
--format json` through the existing host adapter with a 10-second timeout and
1 MiB capture limit. It returns only operations whose resource or description
names the requested instance. This is diagnostic readback for interrupted
create/delete jobs; it does not cancel daemon operations or grant a guest host
control. The backend remains root-equivalent, so S6 remains open.

## Remaining operation contracts and owners

“Owner” below identifies the code subsystem responsible for the migration, not
an assigned person. The existing A-17.9–A-17.14 and A-18 ledger remains open.

| Operation family / owner | Current entry points and host interfaces | Replacement required before removing privileges |
| --- | --- | --- |
| Docker/Compose / service control | `routes/services.js`, `lib/docker-compose-operation.js`; host namespace, daemon socket, root-owned manifests | Fixed lifecycle methods; root-owned approved manifests and allowed mounts; resource identity, fresh independent grant for broad deployment authority; no caller Compose blob |
| Incus identity, import/export / instance management (A-17.9) | `routes/lxc.js`, `routes/mcp-tools/lxc-admin.js`, `lib/lxc-zip.js`, `lib/lxc-exports-instance.js`, `lib/snapshot-s3-export.js`; host exec/files | Reference-only rename/copy/import/export jobs, identity checks, destination allowlists, leases/fencing, staged artifact ownership and bounded streaming |

New guest creation now constrains the image to `images:debian/13` and reads
`/etc/os-release` through a fixed `incus exec <new-guest> -- cat` command
before reporting success. The dashboard and MCP clone/import paths may start
the newly created guest for this readback, then stop it if a stopped result
was requested. A failed readback refuses the operation and attempts to stop
that new guest. These host commands never target a pre-existing guest for
Debian 13 conversion. The existing host command and filesystem boundary
remains privileged; this check is an OS version gate, not an A3 worker
isolation boundary. S6 remains open.

The `inspect_a3_vm` MCP reader adds fixed, bounded Incus and `ps` calls for
one named VM. It refuses containers, stopped guests, missing image fingerprint,
non-Debian-13 guest `/etc/os-release`, missing Incus UUID or guest boot ID,
and incomplete CPU/RAM/root/swap/QEMU
readback. It returns only the matching QEMU PID and aggregate descendant RSS,
never the process command line. The instance name comes through the existing
MCP guest-name and token-scope checks, and no call starts or changes a guest.
This remains a root-equivalent backend read path and does not prove A3 network
or process isolation. The underlying host adapter still needs a typed
least-privilege replacement for S6.

The A3 worker supervisor (`scripts/a3-worker-supervisor.py`, installed by
`scripts/a3-install-supervisor.py`) is a host-owned, root-only daemon that the
backend does **not** control: the operator installs reviewed copies under
`/etc/proxypilot-a3-proof/supervisor`, its unit requires the installed A3
fence, and it refuses to serve unless its own files match the install journal.
Its backend socket (`/run/proxypilot-a3/supervisor.sock`, uid 0 peer only)
accepts exactly `status`, a typed `launch`, `renew`, one of the fixed browser
actions, and `stop`; there is no argv, URL, path, unit property, Incus call or
browser endpoint in that contract. Proof workloads, takeover and human
view/control exist only on the separate operator socket. Teardown receipts are
signed with a host-held Ed25519 key; the backend holds only the public key
(`lib/operational-worker-supervisor.js`). No route constructs the client and the
socket is not mounted into the backend container, so this adds no reachable
backend host call while A3 activation is off. It narrows the future worker path;
it does not close S6, because the backend keeps its other root-equivalent
interfaces and a compromised backend could still request launches within the
pinned project budgets.

The A4 credential and provider broker (`scripts/a4-credential-broker.py`,
installed by `scripts/a4-install-broker.py`) is a second host-owned, root-only
daemon, installed and digest-checked the same way under `/etc/proxypilot-a4`.
Its socket (`/run/proxypilot-a4/broker.sock`, uid 0 peers only) is for the
supervisor and the root operator tools and is **not** mounted into the backend
container. It holds operator-authorized bindings (project, profile and binding
UUIDs, revision, OpenBao path and version; never a value), reads a value with
its own OpenBao AppRole only at delivery time, and writes it through `incus
exec` standard input into the worker's one-shot FIFO; the supervisor, the
runner's command channel, receipts, journals, logs and the database never carry
it. The model route calls one allowlisted provider/model from the host with a
provider key read from the vault per call, under per-run pinned budgets with a
durable worst-case reservation. This keeps the value away from the model and the
guest command channel; it does not hide it from the AppRole, from host root, or
from the root-equivalent backend while S6 is open (the AppRole file is on the
host), and it adds no reachable backend host call while activation is off. The
origin proxy's only A4 widening is one bounded JSON `POST /api/login` per tunnel.
The immediate stop is revoking a binding at the broker (observed on the host:
refused at the broker in 0 ms and at the next submit in 4 ms). Replacing the
AppRole secret ID in the dashboard is not one: tokens already issued stay valid
for their TTL (1 h, max 4 h), and the running broker kept reading on its cached
token until it was restarted.

A5 widens the supervisor's backend socket by exactly one method, `model_step`
(no mount, no other method, proxy path, fence rule or unit property changes).
It is bound to the live attempt, its fence and its pinned run: the caller sends
the run's policy document and the approved guide as exact bytes, and the
supervisor refuses unless their sha256 match the pinned `policy_digest` and the
policy's `guide_hash`, the profile consented to sending its guide to the
provider, and the offered actions lie within the pinned rules. It then sends one
fixed prompt to the broker's existing `model_call` under the run's pinned
budget and returns one action name or a refusal, never model text. The
broker's only change is a larger prompt cap (16000 bytes; the reservation
arithmetic is unchanged). The A5 coordinator that calls it is a backend library
that no route constructs; the proof runs it in a root host harness against a
proof database, so the backend container still has no supervisor socket and
this adds no reachable backend host call (the mount stays an A8 item). It does
not close S6: a compromised root-equivalent backend could already drive the
socket within the pinned project budgets, and now also spend the run's pinned
model budget choosing among actions the pinned rules offer.

A6 (user decision 4, 2026-09-29) widens the same backend socket by one more
read-only method, `view`: one PNG frame of the coordinator's running browser
attempt for the supervision UI. It is narrower than the operator's view:
refused during a takeover (`TAKEN_OVER`) and outside the lease or deadline,
it never renews the lease, at most one frame is in flight per attempt and one
per second, and the reply is only `{png_base64, width, height}` (PNG magic,
≤ 3 MiB, the runner's page URL dropped, nothing journaled). Input, observe,
takeover, the journal and the proof workloads stay on the operator socket;
the socket stays unmounted from the backend container (A8). The backend adds
Operations routes behind the administrators' **Agent runs** dashboard toggle
(off until an administrator turns it on with sudo, audited; not an environment
variable since 2026-09-29, and not writable over MCP)
(`/:id/agent-runs`, stop, `view`, `/agent-approvals` behind `requireSudo`,
model-guide consent, parsed rules) that call the unchanged A5 coordinator;
with no supervisor configured they build no launcher and every execution
control answers `EXECUTION_UNAVAILABLE`, so this adds no reachable backend
host call. Frames are page pixels by the user's choice: they are kept in
backend memory for a moment and never written to the database, a log or a
report; the runner types a bound value only into a password input, so a
frame shows it masked. It does not close S6: a compromised backend that
reaches the socket could now also read frames of a running attempt.
| Project provisioning and component install / setup engine (A-17.10–11) | `mock2/provision.js`, `mock2/component-install.js`, `lib/project-lifecycle.js`, `mock2/{host,deploy,runner-sdk}.js`; launch, guest scripts, idle sweep | Existing runner job kinds with project lease, immutable approved inputs, guest-only execution and durable recovery; remove backend-allowed execution only after replacements pass |
| Caddy, domains, TLS / edge controller (A-17.12) | `lib/{caddy-driver,caddy-cert,cert-mount-reconciler,tls-cert-store}.js`, `mock2/caddy.js`, `routes/{services,domains}.js`; writable `/etc/caddy`, adapt/reload | Constrained route/certificate methods and host-owned writes; canonical path/symlink policy, no arbitrary Caddy imports/config authority from a compromised backend. Current optional RPCs still accept broad config and are not isolation |
| Firewall, L4, VPN, SSH / network controller | `lib/l4-*`, `lib/{platform-vpn-sync,vpn-startup}.js`, `mock2/{firewall,network}.js`, `routes/{firewall,vpn,ssh-access}.js`; host exec, sysctl, network/credential files | Typed validated rules and peer operations, host-owned ranges/ports/path policy, shared firewall lease; root-controlled grants for broader changes |
| Storage and migrations / storage controller (A-17.13) | `lib/storage/`, `lib/migration/`; raw devices, ZFS mutations, host import and transfer | Fixed disk/pool methods tied to stable device identity and reviewed plans, protected approval state outside backend-writable DB; discovery fallback and SMART completion must migrate too |
| Backups/restores / backup controller | `lib/{backup-pack,restore,snapshot-s3-export}.js`; host files, guest exports, temporary instances | Reference-only artifact/restore jobs, canonical staging paths, protected credentials, leases and validated restore identity; bounded content transport |
| Guest terminals, workspace and commands / terminal controller (A-17.14) | `routes/{terminal-ws,lxc-workspace,mcp-editor}.js`, `routes/mcp-tools/*`, `lib/pty.js`; PTY, guest files and shell | Target-bound guest channels with host-side grant verification, current revocation and bounded streams. Host shell is intentionally arbitrary root authority and needs independently verified, short-lived operator proof unavailable for the backend to mint |
| Host packages, cron, service control, self-edit, CVE / platform controller | `routes/mcp.js`, `routes/mcp-tools/{admin,self-edit,platform}.js`, `lib/{engine-cli,cve-research,security-cve-driver}.js`; host exec/files | Fixed reviewed operations or separately approved broad capability. MCP `confirm:true`, backend sudo state and backend-writable approval rows do not establish a boundary against backend compromise |
| Read APIs and fallbacks / shared host adapters | `lib/host-exec.js`, `lib/setup-engine/{owned-runtime,platform-access,platform-overview}.js`, `routes/platform-overview.js`, storage discovery and other inventory candidates | Typed read methods, bounded outputs and redacted credentials; fail closed on agent outage. The selected-agent Caddy path already has no automatic shell fallback, but storage and other legacy paths still do |
| Setup/update runners / orchestration | Existing root runners share DB, install checkout, credentials and jobs with backend-facing code | Preserve fencing/recovery while moving privileged policy, grant verification and trusted executable ownership beyond backend writes. An arbitrary root job executor or writable runner source would defeat isolation |

The agent service's `disk` group can access raw devices. Its broad writable path
allowances and Caddy permissions also need a method-by-method review. The
current service is not a minimal final privilege boundary. Do not widen these
permissions merely to make a failed method work.

## Reviewed merge candidates for PR #674

This is acceptance of two *static inventory entries*, not closure of S6 or
deployment approval. The backend still has root-equivalent host access.

| Operation / owner | Caller and authority | Implemented contract and evidence | Remaining requirement |
| --- | --- | --- | --- |
| Infisical guest networking / setup engine (`lib/setup-engine/agent-network.js`, `infisical-agents.js`) | `routes/infisical.js` agent create/link/unlink requires administrator, sudo and fresh local proof, with audit after success; no MCP mutation. `index.js` invokes a periodic stale-link sweep. | The helper uses fixed `incus list`, `network get` and guest `exec` operations through `host-exec.js`; requested container and inventory network names, fixed IPv4 and nonempty instance identity are checked before further privileged calls. Hostname, gateway and probe host/port are checked before guest shell interpolation; stored proxy origin is validated before hosts/route changes. The host command has a 30-second timeout and 1 MiB output bound. Hosts edits use a fresh guest temporary file, retain unrelated lines and only change the marked entry. The stored `/32` is added by `services.js`/`caddy-site-file.js` only to the Infisical route. Tests cover rejection before effects, link/unlink, failed render rollback, and deleted/readdressed/replaced/unreadable inventory. | Root-equivalent backend authority, guest-root hosts writes and a time-of-check/time-of-use race between Incus identity reads, route render and actual traffic remain. A failed external Caddy reload may need operator reconciliation; the static review cannot prove host network isolation. S6/SEC-01–03 and applicable INF findings stay open. |
| Private image decoding / Operations (`lib/operational-evidence-decoder.js`, `operational-evidence-decoder-worker.cjs`) | Authenticated, authorized evidence intake calls `operational-evidence-service.js`; `operational-evidence-runtime.js` requires both false-default feature gates, finite quota, an absolute reviewed runner path and a separate boundary-review assertion. Neither HTTP nor evidence metadata selects the executable. | Fixed Node executable/worker argv, shell-disabled spawn, empty environment and piped byte protocol. At most one child per backend process. Input/output each stop at 8 MiB, output framing and fields are checked, dimensions stop at 8192 per edge/16 MP, timeout is at most 10 seconds, and malformed/error/early-exit results fail closed. Timeout/output failure sends SIGKILL to the direct child; the slot is held until `close`. Real PNG/JPEG HTTP fixtures and new failure/slot tests cover the source contract. The approved pins remain pngjs 7.0.0 and jpeg-js 0.4.4. | The wrapper must independently enforce low privilege, no network, hard CPU/RSS/process limits, trusted executable ownership, no database/evidence-root/credential access and whole-job descendant teardown. An absolute path, V8 heap cap, kill or review flag does not establish these guarantees. A child or descendant retaining pipes can keep the local slot occupied until closure; deployment-wide concurrency budgets and host acceptance remain open. S6/SEC-01–03 stay open. |

## Why container privilege removal is blocked

Replacement contracts above are not implemented for all supported operations.
The web backend can still use `nsenter`, daemon access and writable host paths.
The shared job store and broad operator capabilities also lack independent
host-side authority against a compromised backend. Flipping Compose flags now
would break supported workflows; generic agent shell execution would preserve
the vulnerability under a different transport.

There is no disposable Docker/Incus/Caddy/systemd installation available in the
execution environment. Local Unix socket creation is denied. Hosted CI runs the
real Unix peer/transport tests; it is not a representative production host.
Both missing code and missing host acceptance evidence block closure.

## Required host acceptance record

Before A-18/S6 closure, complete the remaining typed contracts, remove the direct
paths and privileged fallbacks, and test a disposable installation with:

1. A non-root backend, all capabilities dropped, no-new-privileges, read-only
   root filesystem with explicit writable application directories, no host PID
   namespace, daemon socket or unnecessary host mounts.
2. Fresh install and upgrade from the legacy baseline; reboot, absent/stopped
   agent, runner loss, failed update, interruption and root recovery. Confirm
   subsequent updates preserve restrictive posture and never enable fallback.
3. Valid route/TLS, Docker/Incus lifecycle/import/export, project build/deploy,
   backup/restore, storage, firewall/VPN and guest-terminal workflows. Exercise
   lease contention, fencing, retry and credential delivery without logging
   secrets.
4. Hostile RPC inputs: unknown fields/methods, excessive input/output, forged
   or expired grants, peer mismatch, changed resource identity, path traversal,
   escaping symlinks, arbitrary scripts/manifests and backend-forged job rows.
   Record denial and absence of host effects.
5. Independent host-terminal/broad-capability authorization, current revocation,
   and proof that backend compromise cannot sign its own grant, replace trusted
   policy/executables or write another operation's protected approval state.

Use [the deployment runbook](security-remediation-runbook.md) for Stage A and the
partial S6 changes. Runtime acceptance remains a distinct gate.
