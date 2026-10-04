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
  [candidate inventory](security-host-interfaces.json) covers 97 backend files
  matched by namespace, command, process-import and host-path patterns. It
  deliberately includes comments/imports. It is review evidence, not a claim
  that all matches execute or that nonmatching indirect access is safe.

`runHostCapture` still defaults to `spawnHost`, including its host namespace
transport in Docker. Its optional `spawnImpl` dependency lets the collector
regression launch a local fixture process through real pipes without host
namespace privileges. Only the test supplies this function; it is not an HTTP
or MCP request field. Capture limits, completion flags and failures are unchanged,
and a failed host namespace entry never falls back to local execution. This
test seam adds no host operation or privilege and does not close S6.

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

A7 (user decisions 1–1c and the takeover direction, 2026-09-29) adds the
real-time view and dashboard takeover. **Supervisor backend socket:** four
more methods, each bound to the coordinator's own running browser attempt and
fence. `live` is a stream: it opens one viewer's relay of Neko's WebRTC
signalling (at most six per attempt; the backend relay filter
passes only Neko's signalling events, bounded in size and rate). It returns a
per-viewer TURN REST credential (`<expiry>:<viewer>`, HMAC-SHA1 of a
host-held secret, one hour). `takeover` hands control to one open viewer:
the model is fenced first, and control is given only after any in-flight
action (a submit clears both fields first). The runner must report
`password_fields_empty: true` and the input X counted while nobody had
control, or the reply is `LIVE_PROTOCOL`. `release` returns input counts by
kind only. `summarize` sends typed facts of a finished run to the broker's
new `summary_call` under the run's pinned budget and returns bounded text
labelled as model text. Input, observe, the journal and proof workloads stay
on the operator socket. The broker gains `summary_call` and two operator-only
proof switches on `model_call` (`reply_outside_set`, `usage_missing`: a fixed
reply, no key read, no provider contacted). The supervisor now answers
`WORKER_EXITED` (a certain failure) when the runner had already gone before
a command was written, instead of `CHANNEL_CLOSED` (uncertain).
**Worker unit:** Xvfb, Neko's server on a Unix socket in the unit's private
tmpfs, and the runner's sandboxed Chromium in kiosk mode under managed
policies. DevTools stays shut to a person taking over through two layers:
kiosk mode, and the `devtools://*` URL block, which blocks the DevTools front
end itself. The policy does not set `DeveloperToolsAvailability`, because
Chromium then also refuses the runner's own DevTools pipe (the host run's H4,
2026-09-29). `scripts/tests/test_a7_live_policy.py` proves both layers with
real Chromium reading the real policy path. Neko has clipboard, upload, file
transfer, chat and media sharing off. The unit's limits, the origin policy, the one-shot credential FIFO and
the signed receipt are unchanged.
**Network:** coturn on the host (`proxypilot-a7-turn.service`, installed by
`scripts/a7-install-live.py`, its own user, a hardened unit), listening on
the host's LAN address on 3479 UDP/TCP and TURN over TLS on 5350 (not the
usual 3478/5349, which another TURN server on the proof host owns; the installer
refuses ports anything else listens on) with the
certificate Caddy keeps for the TURN name. It relays from the proof bridge's
gateway address only to the VM's one Neko UDP port: every other peer is
denied (`403 Forbidden IP`), with no TCP relay and a per-session rate cap.
The fence gains one line: UDP from the VM's Neko port to the gateway's relay
ports. The VM still has no internet-facing listener.
**Backend:** a WebSocket route `/api/operational-projects/:id/agent-runs/:runId/live`
(exact Origin, session cookie, the Operations toggles and run access, checked
again every ten seconds). Four more routes: `takeover`, `takeover/end`,
`reconcile`, `resume`. Model-summary consent. The session's own takeover
grant: `POST /api/auth/agent-control` and its passkey pair, password plus
TOTP or a passkey, never sudo. A practice start writes the demo's fixture mode
through one fixed `incus exec pp-fractionate-demo` write
(`lib/operational-demo-fixtures.js`: constant argv, a small non-secret
document on stdin, byte-exact read-back). Migration 1112.
**Unchanged:** frames and video are never stored, typed text is never
recorded (counts only), and no MCP tool reaches any of it. With no supervisor
configured every execution control still answers `EXECUTION_UNAVAILABLE`,
and the socket stays unmounted from the backend container (A8).
It does not close S6: a compromised backend that reaches the socket could
now also watch a running attempt live and hand its control to a viewer it
opens, within the run's pins.

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

### A8 dashboard wiring and record read (2026-09-30; pending deployment acceptance)

The reviewed opt-in mounts only `/run/proxypilot-a3-backend` and
`/etc/proxypilot-a8` read-only, with `create_host_path: false`, into the existing
uid-0 backend. Directory/socket modes are 0700/0600; the key directory contains
only the pinned Ed25519 public key. The operator socket remains under
`/run/proxypilot-a3`; the receipt-private-key directory is not an A8 mount.
The supervisor preserves directory inodes over restart; the container sees the
recreated socket. Its existing root-peer rule remains. This does **not** remove
the backend's privileged/host-PID/Docker/writable-host authority: a compromised
backend remains root-equivalent and could bypass application approvals or reach
host keys. S6/SEC-01 stay open; limited single-user pilot acceptance is required.

Backend `step_record({run_id,attempt_id,fence,ordinal,action})` validates the
original attempt/fence, including terminal attempts, and returns only null or
`{ordinal,action,state,at,latency_ms?,error?}`. It writes nothing, renews no lease
and exposes no page, claims, value, binding or receipt. The transport caps this
read at 2 KiB/two seconds. The existing GET run-detail route checks current run
access before and after awaiting and checks the toggle again; no new route/MCP
authority. Reconciliation remains an explicit human decision. Explicit action
ordinals correlate reservations across refused steps without replaying effects.

The user's same-person pilot guide decision uses a root-only CLI, an immutable
authorization event for the exact pending demo submission/hash/revision, a
one-hour expiry and one immutable consumption event in the approval transaction.
Current active owner/origin and unused state are checked again; the owner must
manually approve. There is no role change, auto-approval, general self-review
setting or HTTP/MCP grant writer. Independent review remains the default.
The binding enrollment CLI writes only existing audited metadata from the
root-only broker reference; it grants no consent/run/approval. A8 adds no schema
migration. Actual container refusals/restart, host regressions, backup/off-host
restore, rollback, growth and internet pilot remain acceptance requirements.

The live WebSocket route and host proof share an opening queue: the viewer's
opening reply precedes early filtered Neko signalling, even when messages arrive
before `openLive` resolves. The transient queue caps at 40 messages/256 KiB,
preserves order and discards everything on close, refusal or overflow. It adds
no route, supervisor method, input authority or stored signalling; existing
session/access checks and relay-only TURN policy still apply. S6 remains open.

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


## Selected-browser private parser candidates — 2026-10-02

This source review accepts the following static inventory additions. It does not
accept installed parser isolation, activate a wrapper, or close S6/SEC-01–03.

| Owner / caller | Fixed source contract | Remaining installed requirement |
| --- | --- | --- |
| Browser artifact screenshot redaction (`operational-browser-artifacts-image-decoder.js`, image worker) | Authorized private artifact service supplies at most32 validated rectangles and8MiB PNG input. Explicit capability and absolute configured wrapper; fixed Node/worker argv, shell disabled, empty environment, ignored stderr, detached process group, one child slot,5s deadline,8MiB framed output,8192-edge/16MP checks. Failure kills the process group and refuses output. No HTTP-selected executable. Pixel-redaction and cancellation/race tests establish local correctness only. | Reviewed wrapper must enforce low privilege, no network, bounded accessible files/CPU/RSS/processes, trusted ownership and descendant teardown. Heap cap/path/capability strings do not establish these boundaries. No broad filesystem or credentials. |
| Browser artifact PDF text extraction (`operational-browser-artifacts-pdf-decoder.js`) | Authorized private source service passes PDF bytes over stdin to configured wrapper with fixed `/usr/bin/pdftotext -enc UTF-8 -nopgbrk - -`; shell disabled, empty environment, ignored stderr, process group teardown, one slot,5s timeout and16KiB UTF-8/nonempty/no-NUL output cap. F1 input caps/hash/MIME/leases precede decode; source authority is rechecked after await. Real local parser fixtures are correctness evidence. | Independently reviewed wrapper must enforce the same low-privilege/network/filesystem/resource boundaries. Parser installation or test injection is not production readiness. |

The selected-browser runtime defaults private storage and every wrapper to
unavailable. A finite reviewed dedicated root receives a read-only owner/mode,
ancestor/symlink and directory-identity preflight; each file operation repeats
checks. Browser host readiness independently requires signed installed
Incus/nft/gateway/managed-policy/Neko acceptance. None of these changes remove
existing backend root-equivalent access or authorize deployment.

## Explicit local Source Memory setup — 2026-10-04

This review accepts only the `host_files` candidate in
`lib/operations-source-memory-setup.js`: the fixed
`/var/lib/proxypilot/browser-private` directory. The standard backend already has
that host path through its existing `/var/lib/proxypilot` mount. No new mount,
host command, namespace pivot, agent method, executable or parser is added.
S6/SEC-01–03 remain open; this is an application contract inside the existing
root-equivalent backend, not an independent host privilege boundary.

The only mutation entry point is
`POST /api/operations-settings/source-memory {}`. It requires the current
administrator role, session authentication, double-submit CSRF and sudo. The
UI obtains fresh sudo before sending one non-replayed setup request. No caller
path, quota, contents, shell, credentials or decoder choice is accepted, and no
MCP writer exposes this review. Custom environment storage configuration and
`OPERATIONS_BROWSER_LOCAL_STORAGE_DISABLED=true` are preserved. Stock blank/
false environment settings are left unchanged; the administrator's explicit
review is recorded separately in the database after filesystem verification.

The service creates at most one fixed directory beneath preexisting safe
ancestors. It pins ancestor identities and opens the reviewed parent with
`O_DIRECTORY|O_NOFOLLOW`; creation through that descriptor cannot follow a
swapped ancestor into another directory. Unexpected `EEXIST`, occupied
unreviewed roots, links, unsafe ancestor permissions, a different service UID,
non-0700 root permissions or changed directory identity refuse. It never
recursively creates parents, chmods/chowns existing paths, migrates private
bytes or chooses another storage root.

A bounded constant probe is written as one opaque UUID object through the
existing private file adapter, then read with exact length/SHA256 checks and
deleted. Objects are mode 0600 with no symlinks or hardlinks. The original
probed root device/inode remains pinned through the review transaction; the
receipt and its digest-linked audit commit atomically only after successful
write/read/hash/delete verification and current role/custody checks. Refusal
cannot persist activation. Cleanup never deletes unknown replacement bytes,
and descriptor close/buffer clearing still run if cleanup fails.

Setup reports verification pending an owner-performed dashboard backend restart.
It does not restart a service or enable storage in the running artifact service.
On the next ordinary backend start, the review/audit linkage, same physical root,
service UID, exact 0700 mode and existing out-of-checkout storage validator must
pass before the existing runtime adapter is initialized. A failed initialization
reports unavailable, not pending restart. Runtime file operations recheck custody;
there is no local fallback after refusal.

The fixed installation quota is 256 MiB; existing 128 MiB account/project caps,
16 MiB object maximum, reservations, retention, leases, deletion accounting,
source disclosure and exact action approvals are unchanged. No model consent,
run, guide approval or parser boundary is granted. A setting copied without its
linked audit, a missing/replaced root or a different physical restore target
refuses. Full same-host database/audit restoration against the same root can
retain the installation review; the review itself grants no source lease,
consent or execution authority, and existing current authority/expiry checks
still apply. Host root can alter the database and storage, so no independent
audit/custody or encrypted-backup guarantee is claimed.

Source evidence is the real HTTP CSRF/sudo setup test, deterministic ancestor/
root replacement and creation-race tests, malformed/restore/audit tests, exact
permission refusal tests, and the existing artifact/runtime regressions in
`operational-browser-source-memory-setup.test.js`. Browser journeys exercise
fresh-sudo cancellation, no POST before verification, one exact setup POST,
non-replay on refusal and honest pending/unavailable responses. Installed
host storage verification, activation and any owner restart remain separate
from this static inventory acceptance.
