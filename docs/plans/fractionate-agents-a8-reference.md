# A8: dashboard deployment and one supervised pilot

Status: dashboard deployed 2026-09-30; **pilot and acceptance pending**. A7 was accepted
2026-09-30. The user authorized this chat to take over all A8 development on
2026-09-30. Work is isolated on `codex/agents-a8-dashboard`, based on `f6d26cc8`.
The evidence file records actual checks; this reference describes the contract
and the remaining operator steps. Nothing here is authorization to merge or
execute a host command.

## Deployment contract

The single-user pilot uses the existing root backend. Its only new mounts are
two **read-only directories**, with `bind.create_host_path: false`:

| Host and container path | Contents | Owner/mode |
|---|---|---|
| `/run/proxypilot-a3-backend` | `supervisor.sock`, the backend method set | root / directory 0700, socket 0600 |
| `/etc/proxypilot-a8` | `supervisor-pub.pem` only | root / directory 0700, public key 0600 |

The operator socket stays `/run/proxypilot-a3/operator.sock`. Neither that
directory nor `/etc/proxypilot-a3-proof` (which contains the receipt private key)
is mounted for A8. `RuntimeDirectoryPreserve=yes` preserves both supervisor
directories across service stops/restarts; binding the directory lets the backend
see a recreated socket inode. `/run` still disappears at reboot: the reboot test
remains deferred, and reboot recovery is not claimed.

`scripts/a8-wire-dashboard.py configure --install-dir /opt/proxypilot` is an
explicit root-operator opt-in. It verifies the installed supervisor's journal,
loaded unit, VM/key pins, idle/ready state and secure paths; copies the Ed25519
**public** key; preserves unrelated `.env` content; and adds the reviewed mount
block. All three environment settings are required:

```
OPERATIONS_AGENT_SUPERVISOR_SOCKET=/run/proxypilot-a3-backend/supervisor.sock
OPERATIONS_AGENT_SUPERVISOR_PUBLIC_KEY=/etc/proxypilot-a8/supervisor-pub.pem
OPERATIONS_AGENT_VM_UUID=49592202-a8b0-45af-9ac6-5439761d73e4
```

The standard deployed installation is `/opt/proxypilot`; `/root/ProxyPilot` is
the Git source checkout. Helpers default to the deployed installation and accept
an explicit reviewed custom path. Verify the actual runtime DB/Compose location
before a host step; do not back up or enroll against a checkout's spare database.

`patch` runs from `install.sh` and `update.sh`. Without explicit settings it is a
no-op, including no probes/directories/backups. Configured installs refuse partial
or changed pins, an absent/mis-moded socket, a stale key, a key directory with
extra files, symlinks/writable ancestors, a conflicting mount, or an unsupported
Compose layout. It never silently substitutes another socket or generates a key.
Reinstall preserves the three settings. A key rotation requires an operator to
run `configure` again before the next dashboard rebuild/restart.

Changes have private byte-exact backups under `<install>/.a8-backups/<stamp>/`,
with a file/digest/mode inventory. A failed write restores earlier bytes. The
helper never restarts a service, changes a toggle, grants access or starts a run.
`status` verifies the deployed pins and owned Compose block without emitting
`.env` contents or key material.

**S6 limitation:** a read-only mount does not remove the existing backend's
host-root-equivalent authority (`privileged`, host PID namespace, Docker socket,
other writable host paths). A compromised backend could bypass the application
approval/identity checks, invoke backend methods as root, or reach host keys by
existing privileged paths. The dedicated mounts reduce accidental exposure;
they are not isolation from backend compromise. This requires written acceptance
for this limited pilot. S6/SEC-01 stay open for the later security audit.

## Supervisor record read

One new backend method, also available on the operator socket:

```
step_record({run_id, attempt_id, fence, ordinal, action})
-> {record: null}
or {record: {ordinal, action, state, at, latency_ms?, error?}}
```

Fields are exact. UUIDs and the **original attempt fence** must match. Ordinal is
a positive safe integer; action is one of the seven existing browser actions.
State is `started`, `done`, `failed` or `uncertain`. `at` is the UTC reservation
time; optional latency is a nonnegative integer and error is a bounded code.
The root-peer rule stays unchanged. Reads work after teardown/recovery, never
renew a lease or change a journal, consume limits, replay a command, grant
approval, or decide a reconciliation. They expose no page/claims/value/receipt,
credential reference, prompt or provider body. The client caps this reply at
2 KiB and uses an overall deadline of at most two seconds.

The existing authenticated GET run-detail route projects records only for its
step reconciliation items. It checks run access before reading and again after
awaiting, and rechecks the dashboard toggle before returning. Reads use the
durable step's own attempt/fence, in batches of four. Missing records and failed
or malformed reads are distinct, inconclusive states. No new HTTP route or MCP
capability is introduced. A record never changes the profile gate.

The coordinator now passes its durable step ordinal to `action`. The supervisor
reserves that ordinal before effects, refuses repeated/backwards ordinals, and
continues counting actual commands independently for action limits. Gaps caused
by a refusal cannot shift the next record onto a different backend step. Existing
operator/proof callers may omit the ordinal and receive the next unused one.

The panel says **"Reserved at"** and explains that a completed command can still
have an uncertain site outcome. A `done` timed-out submit is still a human
decision. "No matching record" is not evidence that no effect happened.

## Pilot enrollment

The target remains `https://demo.fractionate.ai`, the A4 synthetic account and
its existing scoped OpenBao credential/provider broker. A4 already uses OpenBao.
The broader Infisical agent-vault migration and new general broker are deferred
until the user has seen live agents.

Create/select the real dashboard project/profile and approved guide through the
dashboard, with the existing hard rules. User decision 2026-09-30: **the same
person drafts and reviews this pilot guide**. Thomas alone retains run access.
Independent review remains the default. The explicit pilot exception is a
root-operator grant for the exact pending demo submission ID and content hash:

```
node scripts/a8-authorize-pilot-review.mjs --owner <owner-uuid> --project <project-uuid> --submission <submission-uuid> --hash <content-sha256>
```

It requires the current active demo owner, the immutable pending snapshot and
no active project run. It writes an immutable `a8_pilot_self_review_authorized`
event, expires in one hour and supplies no approval or role. After refreshing,
the UI explains the exception and Thomas must manually click **Approve and
publish**. Approval rechecks current owner/origin, exact hash/revision, expiry
and unused state under the same write lock; its `a8_pilot_self_review_used`
event and publication commit together. Cancellation, another revision, transfer,
expiry or previous consumption makes it unusable. No HTTP/MCP grant writer,
new schema migration, automatic approval or general self-review setting exists.
Owner consent for model guide use and summaries remains explicit in the UI.
Use finite pilot limits (one hour, 20 actions, 20,000 tokens, USD 0.01), the one
demo origin and the seven existing workflow actions; do not add capabilities.

After the owner/project/profile IDs are confirmed, the root operator creates a
fresh A4 binding for those exact IDs using `a4-broker-operator.py bind` (the vault
key name and synthetic username are metadata, not secret values). Then:

```
node scripts/a8-import-pilot-binding.mjs --owner <owner-uuid> --project <project-uuid> --profile <profile-uuid> --binding <binding-uuid>
```

This root-only CLI reads the broker's `bindings` through its fixed root-only
socket, verifies a fresh active revision-1 reference for the exact IDs/origin,
and uses the existing credential store to mirror only metadata into the live
dashboard database. The A4 public reference includes a non-secret `vault.key`
name; enrollment validates that name against the final path segment and keeps
only mount, path and version in the dashboard. Unknown fields and values remain
refused. It requires the active project owner and an eligible idle
profile; creates the existing binding audit event; refuses a second active
binding, an extra value field, revoked/rotated/mismatched references; and is
idempotent for identical metadata. It grants no run, approval or consent. Account,
owner, profile, active-run and prior-binding checks are repeated under the write
lock. No route or MCP tool imports this operator enrollment module.

## Operator sequence (each host step separately reviewed)

1. **Exact-head release gate.** One draft PR; backend, frontend, agent and audits
   green on its exact SHA; source review on that SHA; inventory without suppression.
   Record baseline-only failures separately, never call a failing check green.
   Obtain the user's merge/deployment decision before proceeding. No force push.
2. **Read-only host baseline.** Confirm candidate/live SHAs, clean checkouts,
   installed supervisor/runner/broker/demo digests, receipt key, VM UUID/boot,
   live marker/policy/Neko digests, TURN 3479/UDP+TCP and 5350/TCP, timers,
   current toggles, DB path and absence of active attempts. Compare with A7
   acceptance. A drift is investigated before installation.
3. **Backup and restore check before deployment.** From the reviewed candidate:
   `sudo python3 scripts/a8-release-check.py backup`. Expected: `restore_check`,
   `integrity`, `foreign_keys` true, migrations including **1100–1112**, private
   backup path, digests and disk baseline. Use `verify --backup-dir <that-path>`
   to independently check file digests and restore again. Copy the DB, `.env`,
   Compose and manifest off-host to the user's approved destination and verify
   the digests there. Same-host copies/snapshots are not off-host backup.
   Destination approved 2026-09-30: Thomas's Windows computer, in a private
   directory outside the Git worktree. Copy only `proxypilot.db`, `.env`,
   `docker-compose.yml` and `manifest.json`; measure bytes before transfer and
   verify the manifest hashes afterwards. This excludes VM/container disks,
   website files, ZFS snapshots and the separate OpenBao data directory.
4. **Install the reviewed supervisor while idle.** One reviewed paste running
   `scripts/a3-install-supervisor.py reinstall`, with failure marker and unit
   journal. Expected: `accepting_launch: true`, no blockers, the reviewed source
   digests, a new receipt key (previous public key archived), and the two runtime
   directories. A7's installed Neko/TURN/policy/marker are retained and checked;
   no reprovision, router change, Incus upgrade or snapshot deletion is needed.
   Run the installer's `status` from the reviewed checkout as well: the installer
   itself is not copied into `/etc/proxypilot-a3-proof/supervisor`. Its status
   command verifies the installed journal, recorded files, unit and serving key.
5. **Configure/rebuild dashboard.** Run `a8-wire-dashboard.py configure`; record
   private backup path and public key ID. Deploy through the normal reviewed
   update/promotion path and record its rollback tag. `patch` must pass before
   the old container stops. Confirm health, migrations and `status` inside the
   actual runtime. No migrations are added by A8.
6. **Actual container refusal/restart proof.** Verify UID 0, both long-form
   read-only directory mounts, public key digest and successful backend `status`.
   Confirm the operator socket/private key have no A8 mount. Under an isolated
   test client, non-root peer, wrong socket, missing/wrong public key and missing
   source directory all fail closed. Restart the idle supervisor: directory inode
   remains, socket is recreated, and the existing container reaches the new one.
7. **Host regressions.** Run A3 20/20 in live mode (updated `backend_refusals`
   covers the read after stop and its strict refusals), A4 6/6, A5 17/17 with one
   real human approval, A7 18/18 with all kill/account/key-loss cases, three clean
   canary scans and `a7-host-summary.py` with `all_passed: true`. Reuse the A7
   H4–H7 reviewed commands, with the A8 candidate SHA and fresh proof outputs.
   Long commands run detached with end markers; no marker or value on argv.
8. **One dashboard pilot over the internet.** Enroll the real approved profile;
   Thomas starts explicitly, watches live video through relay-only TURN, verifies
   the session to take over, returns control, approves the exact submit digest
   with sudo, stops a held/uncertain step, checks the site and the displayed
   supervisor record, reconciles deliberately, and resumes into a fresh linked
   run with fresh approval. Read the verified receipt, human decisions, audit,
   cost ledger, result and (only with owner consent) summary back. Never replay
   an uncertain write or bypass the demo's shared sign-in limit.
9. **Rollback rehearsal and growth.** Drain/stop through the dashboard and
   verify teardown. Rehearse the pinned previous application checkout with the
   verified private DB/env/Compose backup in an isolated restore installation;
   record old/new health, migration compatibility and return to reviewed A8.
   A8 adds no schema migration, so no down migration is used. An actual
   production DB replacement would require the container stopped, no active
   attempt, WAL/SHM handled safely and one reviewed operator paste; the backup
   helper never performs it. Compare `a8-release-check.py disk` with the baseline,
   including DB/WAL, release/wiring copies and both journals; record delta/free
   space and bounded pilot storage. Preserve rollback checkpoints.
10. **Acceptance.** Date the actual outputs in the evidence, including open
    items, written S6/SEC-01 pilot limitation and same-person guide exception.
    Ask the user for A8 acceptance.
    Neither source completion nor a green PR substitutes for the live pilot.

For an application rollback, first drain and disable agent execution, then
restore the reviewed previous `.env`/Compose and application tag through the
normal operator procedure. The new host backend socket may remain unmounted
and idle. Rolling the supervisor back separately uses the A7 reviewed source,
reinstalls its old runtime layout (a fresh receipt key), and reruns the host
proofs before re-enabling execution. Never reconnect stale key material.

## Security dispositions and limitations

SEC-02 (exact-head CI/inventory), SEC-03 (backup/restore, migrations, rollback and
growth), INF-01 (current auth), INF-02 (identity/fences), INF-03 (keys, broker and
proxy), INF-04 (actual revocation) and compatible SEC-05 integration require
fresh pilot proof. SEC-04's worker is already a VM; estate migration is later.
S6/SEC-01 remain an explicit single-user pilot limitation, not closed findings.

There is one supervisor host and one active attempt. No HA, second target,
general credential broker, browser recording, stored video/frames, typed-input
logging, extra origin or document-delivery workflow is added. The root-held
journals retain history without a new retention service; disk-growth proof and
finite pilot limits are required, and retention stays on the audit register.

The reboot test remains deferred. Keep the four `pp-a7-pre-live-*` snapshots and
`pp-mcp-pre-network-20260927-222658`. Never touch `pp-nodus`,
`nodus.fractionate.ai`, router mappings, MEET's TURN rules, Incus packages or
Incus archives as part of this release.
