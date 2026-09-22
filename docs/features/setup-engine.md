# Setup engine: persistent locks, saved jobs, and the independent host runner

Gate two's foundation (`docs/core/setup-engine-requirements.md` R1, R2, R4).
Every platform operation that changes what a guest runs or stores — today
the deploy, the project database restore, the container snapshot restore,
the retry path's secret mint, and the Incus lifecycle and snapshot verbs
(create, start, stop, restart, delete; snapshot create and delete); later
the credential migration and the guided setup — holds one **persistent
lease per app**, records itself as a
**saved job** with a checkpoint before its disruptive step, and is
**recovered by a root host runner** when the process that ran it dies. The
browser, the CLI and MCP submit and observe rows; the runner acts.

## The pieces

| Piece | Where | What it is |
| --- | --- | --- |
| Decision layer | `admin/backend/src/lib/setup-engine/logic.js` | Pure: lease verdicts, the fencing epoch, redaction, the R4 verification ladder, reconcile decisions, retry reuse, runner-job validation |
| Store | `admin/backend/src/lib/setup-engine/store.js` | SQL over a SQLite handle (better-sqlite3 in the backend and the runner, `node:sqlite` in the suite): `setup_locks`, `setup_jobs`, `setup_job_events` (migration 1000) |
| Backend half | `admin/backend/src/lib/setup-engine/backend.js`, `mock2/container-lock.js`, `routes/setup.js` | The container lock's persistent backing, the boot sweep, `/api/setup` |
| Host runner | `cli/src/setup-runner/{probes,runner}.js`, `cli/src/commands/setup-runner.js`, `deploy/proxypilot-setup-runner.service` | The root service that reconciles dead leases and executes recovery / verification jobs inside guests |

## Locks (R1)

`setup_locks` holds one row per app: owner, operation, job, **epoch**, and a
lease that expires 30 s after its last renewal (renewed every 10 s while the
operation runs). `withContainerLock` — the entry every holder above goes
through — takes the lease before running the operation and releases it
after, so the check is server-side and identical for the dashboard, the CLI
and MCP.

| The lease is… | An ordinary acquirer gets |
| --- | --- |
| free | the lock |
| held by a live owner (a deploy in this backend, the runner recovering the app) | `ContainerBusyError` — the MCP restores say who holds it and are refused before any change; a deploy queues behind another deploy in the same process as before |
| held by a **dead** owner (a backend that restarted mid-operation) | `ContainerLockStaleError` — *"a previous deploy for container X did not finish (holder …, since …); recovery is required before another operation"*. Nothing takes it silently |

A stale lease is taken over only by a reconciler (the runner), and the
takeover bumps the epoch. Every job and lock write carries `(owner, epoch)`
in its `WHERE` clause, so a worker whose ownership moved changes nothing and
stops (the runner throws `FencedError` when its heartbeat updates no row).

## Jobs (R2)

`setup_jobs` is the saved operation: kind, app, status, phase, the approved
`plan`, `progress` (including every generated resource: a secret's **name**
and where it was written, a snapshot, a dump), the `checkpoint`,
configuration **references** (`config_refs`: port, unit, environment file,
the data guard's table and column names), the lease, the outcome, the
sanitized reason and the R4 verification. `setup_job_events` is the
append-only progress stream.

Everything is redacted on write (`redact`): a string under a key that names
a secret (`password`, `*_secret`, `token`, `nonce`, …), bcrypt hashes,
`enc:v1:` envelopes, private-key blocks, long hex, URL passwords and
`KEY=value` lines for the known secret names. A key that names a
*reference* (`secret_column`, `key_path`, `secret_names`, `has_password`)
stays, and so do numbers, booleans and nested records. A plan that carries a
value the net catches is refused by the runner outright.

The deploy writes its checkpoint **before it stops the app** (`stopping_app`,
`app_stopped: true`) and clears it when the new unit serves
(`app_started`). Its restart after a failure is recorded as *restart
attempted* with the port's verdict — never as recovered.

Retrying a runner job (`POST /api/setup/jobs/:id/retry`) queues the same plan
with `reuse`: everything the first attempt generated, so a retry finds it
instead of minting again.

## The verification ladder (R4)

| State | Means |
| --- | --- |
| `unconfigured` | no unit |
| `configured` | the unit exists; not verified running |
| `port_responding` | the web port answers below 500; **not** verified healthy |
| `app_healthy` | root, login page and `/api/health` (when present) answer; credential **not** verified |
| `credential_decryptable` | the platform's classifier opens the stored rows with the configured key (`MASTERKEY_ROWS` 200, or 204 with nothing stored — the vacuous case is marked). Evidence about the data and the file, not about the running process |
| `credential_use_verified` | the **application** read its protected credential back through its own code path: a `verify_app` job (step `verify_credential_use`) signs in as the review account and reads `/api/admin/ldaps` — `masterKey` current or rekeyed **and** the inventory complete with no legacy and no unreadable rows (a 200 that still reports unreadable rows is `failed`). The outcome is one of `verified`, `failed`, `no_protected_credentials` (nothing stored), `no_verification_credentials` (no review login on this host), `unreachable` (the app did not answer), `not_applicable` (no data guard). Recorded on the deploy record as `verification.rungs.credential_use_verified` with the outcome, and the deploy's state moves only then. The login is read by the executor's host (the runner from mock2.db + `.env`, the backend from the registry) and never enters a job row or an event |
| `recovery_required` | a rung failed; the record names which and the procedure |

A rung that was not checked caps the state and the next step says why. A
rung a follow-up job will check is listed in `verification.pending` and the
state is not final until it lands. **Execution status and verification
status are separate facts:** a deploy job's `status`/`outcome`
(`succeeded`/`serving`) says the operation ran to the end; its
`verification.state` says how much is proven, and it reads
`credential_decryptable` with `pending: [credential_use_verified]` until
the follow-up records the application rung. A deferred operation finishes
as `deferred`, never `succeeded`.

**Durable verification.** The follow-up `verify_app` job is created by the
executor **before** it marks the deploy finished (`progress.verification_job_id`
points at it), so a browser that closed, an API process that exited or a
runner that died cannot lose the obligation: the job is queued in the
database and the next executor tick — the runner's, or the backend's under
`backend-allowed` — claims it once (compare-and-swap). The boot sweep leaves
a queued job alone.

## What happens when the backend dies mid-deploy

1. The lease and the job stay in the database with the checkpoint
   `stopping_app` / `app_stopped: true`.
2. The **runner's reconcile** (on its start and every minute) — or the
   **backend's boot sweep** if it comes back first — sees the expired lease:
   the job becomes `recovery_required`, a `recover_app` job is queued with
   the references, the lease is kept and flagged stale (`stale_since`,
   `recovery_job_id`). A job that had not reached its disruptive step is
   recorded as `interrupted` and its lease released. The sweep only records;
   it never starts a unit.
3. The **runner** claims the recovery job, takes the stale lease over
   (epoch +1), and runs the fixed steps inside the guest through `incus
   exec`: read the unit's state, `systemctl start` it if inactive, probe the
   port (15 tries), run the health probe, read the active key into memory,
   run the gate-one data probe (as the app's own role, password through a
   protected file, row security checked) and classify the rows with the same
   classifier the deploy uses. The result is the ladder state; the job is
   `succeeded` (with `outcome` = the state reached) or `recovery_required`
   (with `failedAt` and the procedure). The lease is released. The dead
   deploy's record gets a `recovery_result` event pointing at it.
4. Nothing waits for another deployment; nobody has to be watching.

If the runner is not installed, step 3 does not happen: the recorded
condition stays visible (`/api/setup/overview`, `proxypilot setup-runner
status`), every new operation on that app is refused with it, and the
recovery procedure is in the job's verification. The condition is never
auto-cleared.

## The deploy (runner-owned since the deployment slice)

The application deploy is ONE operation, `lib/setup-engine/deploy-op.js`,
run by ONE executor, `lib/setup-engine/executor.js`:
reap every process group another job left in the guest and confirm none survive →
install / build under the running old application (install skipped on an
unchanged manifest; only the working tree and `dist/` change, which the
running process does not reload) → the e2e browser and the PWA build stamp
(best effort) → **protected copies** (a database dump into the directory
`restore_project_db` restores from, a copy of the unit file, a 0600 copy of
the environment file, the deployed commit, the migration runner's retry
class) → **checkpoint** (`stopping_app`, `app_stopped: true`) → stop the unit
and free the port → **migrate** (the first potentially incompatible
mutation, so it runs behind the maintenance boundary, never under the old
process) → mint the installed components' owned secrets under the gate-one
rules (source and built-artifact markers, the data probe as the app's role,
never overwrite, defer and say why) → validate the environment → write the
unit, start → health (45 polls) → verify (application health, then the
stored credential under the configured key) → queue the **application-owned
credential check** as a durable follow-up job. The executor runs in two
places, and there is no second implementation:

| Executor | When | Owner recorded |
| --- | --- | --- |
| The host runner (`proxypilot setup-runner serve`) | a runner has a heartbeat younger than 30 s in `setup_runners` (migration 1001) — under either policy | `runner@…` |
| The backend, in-process (nsenter pivot) | no live runner **and** the installation policy is `backend-allowed` (see "Who executes") | `backend@…` |
| Nobody | no live runner and the policy is `runner-required`: the job is queued and the caller is told the runner is unavailable | — |

`mock2/deploy.js` `deployProject()` is the single entry every caller keeps
using (the build cycle, connect, provision and rehydrate, the REST deploy
route, `promote_release`, `redeploy_project`). It resolves the plan's
**references** — the run contract from the caller or the guest's manifest,
the installed components' secret contracts and data guards from the
registry, the port, the app dir — never a value; then either submits a
`deploy` job and **waits** for it (replaying the runner's step events to the
caller's `onStep`), or runs the operation itself under the persistent lock.
Either way the record is the same: a job with the plan, the checkpoints, the
generated secret **names**, the outcome and the verification. `detach: true`
submits and returns the job id (`POST /api/setup/apps/:app/deploy`).

A repeated submission while a deploy for the app is queued or running
observes that job rather than starting another; a retry after completion
mints nothing new (an existing key is never overwritten). The browser, the
API process and the awaiting promise can all go away: the runner finishes
the job.

**The contract's commands.** `install`, `migrate`, `build` and `start` are
the app's own declarations in its `mock2.yaml`, resolved by the server (or
read by the executor from that file) and run *inside the named guest*. They
are guest-scope, bounded single-line strings; they are not host commands and
never come from the request. A plan carrying `command`, `script` or `argv`,
or a value that looks like a secret, is refused before any guest command.

**Interruption, by checkpoint.** A dead owner (expired lease) is reconciled
by the runner (on start and every minute) or the backend's boot sweep:

| Last checkpoint | Meaning | Reconcile |
| --- | --- | --- |
| `starting`, `install`, `build`, `build_done` | nothing disruptive yet: no data changed, the old process still runs | **resume**: requeued and run again from the start (steps are idempotent; minted keys are reused; the protected copies are taken again under the new job's id) |
| `stopping_app`, `migrating`, `migrated`, `secrets_minted`, `unit_written` | the app is stopped; from `migrating` on, the database may be partly or fully migrated | **recover**: `recovery_required` on the dead job with the migration's retry class in its reason, a `recover_app` queued with the references (port, unit, environment file, the guard, the generated key names) and the protected copies, the lease kept and flagged stale |
| `app_started` | the new unit runs; verification unfinished | **verify**: a `verify_app` queued; the dead job records `interrupted_unverified` with its recovery references kept |
| `verified` | done bar the record (the application rung has its own job) | interrupted, lease released |

**What "recovered" restarts.** `recover_app` starts the unit as it is on
disk — the new `dist/`, the current environment file, whatever the
migration ledger already applied — and then *verifies*; it never rolls the
environment key back on its own, never restores the old application over a
migrated database, and never replays a dump. Those are operator decisions
made from the record's references (below); the recovery procedure for a
credential mismatch says to restore the recovery set — database and
environment — together.

**The migration.** `checkpoint.recovery.migration` classifies what `npm run
migrate` runs: the platform's own `scripts/migrate.mjs` is ledgered
(`_migrations`), one transaction per file, idempotent — an interrupted run
left whole files applied or not, and a retry resumes at the first unapplied
file (`retry: resume`); a framework migrator with a ledger reads the same;
anything else is `retry: unknown`, and an interrupted unknown migration is
recorded as recovery-required rather than re-run. A failed migration is its
own step (`migrate`), restarts the old process on the new `dist/` and names
the ledger and the protected dump; it does not roll anything back.

**Recovery references are retained versions**, not live paths the deploy
overwrites: `checkpoint.recovery.protected` names the pre-deploy dump
(`/var/backups/proxypilot-db/app-pre-deploy-<job>.sql`, with size and
sha256), the unit file copy (`…/mock2-dev.service.pre-<job>`), the
environment file copy (`/etc/environment.pre-<job>`, mode 0600) and the
source commit; `completed` lists the phases that finished; `generatedKeys`
the secret names minted. A copy that could not be taken is recorded as such
(`dbDumpNote`) — never assumed. `checkpoint.recovery` is written at the
start and never cleared; `app_stopped` is the only flag that flips.

**Cancel** (`POST /api/setup/jobs/:id/cancel`): a queued job is cancelled
outright; a running deploy is cancelled at its next safe checkpoint — any
fence before the stop — and nothing has changed in the guest but its build
outputs; a cancel that arrives after the stop is not honoured mid-way: the
deploy finishes bringing the app up and records `cancel_declined`.

**Containment of every writer** (`guest-probes.js` `containedScript`,
`reapStaleWritersScript`; `setup-deploy-closeout.test.js`). The lease
expiring is not proof the previous writer's guest commands stopped, a marker
on the parent shell says nothing about the children it spawned, and a
session is not a boundary either: a child that calls `setsid()` (a
double-forking daemon, a build helper that detaches) leaves its parent's
session and is invisible to session-based cleanup. So every script the
deploy runs in the guest is placed in a **cgroup that belongs to the job**,
chosen by what the guest has, in this order:

| Mechanism | Where | How it is reaped |
| --- | --- | --- |
| `systemd` — a transient scope unit per script (`systemd-run --scope --unit=mock2-deploy-<job>-<n>`, `KillMode=control-group`) | a guest with a running systemd: every Incus guest ProxyPilot provisions | `systemctl kill --signal=KILL --kill-whom=all <scope>` |
| `cgroup2` — a raw cgroup `<root>/mock2-deploy/<job>` under the unified hierarchy | a guest with a writable cgroup v2 tree and no systemd | `cgroup.kill` (kernel ≥ 5.14): every member, atomically |
| `cgroup1` — a raw cgroup under the `pids` controller | a guest with only a v1 tree | a `kill -9` loop over `cgroup.procs`, then a recount |

A cgroup follows every descendant whatever session or process group it
makes for itself. The wrapper records what it used under
`/run/mock2-deploy/<job>.units` (scopes) or `<job>.cgroups` (paths) and
prints `CONTAINMENT:<kind> <ref>` on stderr, which the deploy records on the
job (`recovery.containment`) and as a `containment` event. **If the guest
has none of the three, the wrapper prints `CONTAINMENT:none`, runs nothing,
and exits 97; the deploy ends `recovery_required` / `containment_unavailable`
before any body has run, with the lease released and the fix named. There
is no fallback to sessions or markers: the operation refuses rather than
run under weaker containment.** (A body's own exit 97 under a recorded
mechanism is an ordinary failure, not a refusal.)

Before a deploy or a recovery touches the guest (after it holds the lease),
the executor's reap kills every group recorded by **another** job, then the
legacy marker scripts that carry no job id (pre-containment deploys), waits
one second, and counts live survivors per group (zombies awaiting reap do
not count); records whose groups are empty are removed. It tries once more
and, if any remain, ends the job as `recovery_required`
(`previous_writer_alive`) with the **lease kept and flagged stale**, so every
conflicting operation is refused with that reason until the survivors are
gone — nothing is silently cleared. The current job's own groups and
everything outside any job group are untouched: the application's service
runs in systemd's cgroup for its unit and is never a target, and neither is
an operator's shell.

The guarantee, exactly: *every process started by a deploy script of a job
that is not the current one — marked or not, in any session — is signalled
as a group at the next takeover, and the takeover proceeds only when none of
them is alive.* The regression (`setup-deploy-closeout.test.js`, real
processes) does what the words say: a contained script spawns a child with
`setsid` that is its own session leader, outlives its parent and keeps
writing to a file; `pgrep -s <parent session>` does not find it; the reap
under another job id kills it through the cgroup, the file stops growing,
the empty cgroup and its record are removed, a process outside any job group
(the application service's stand-in) and the current job's own contained
holder are alive afterwards, and a second reap reports zero. It runs on
every raw mechanism the host offers (in this sandbox: cgroup v2 at
`/sys/fs/cgroup/unified` with `cgroup.kill`, and cgroup v1 `pids`); the
systemd scope form is the same cgroup with systemd as its manager and is
host acceptance, not sandbox evidence.

Limits: (1) the reap is a takeover-time action, not a supervisor — between
two deploys a stale writer runs until the next one reaps it (the lease and
the recorded condition are what stop the *engine* from racing it);
(2) `cgroup1` has no atomic kill: a process that forks between the listing
and the signal is caught by the recount and reported as a survivor, never
assumed dead; (3) only the deploy operation's scripts are contained —
the executor's verification and recovery probes are single short commands
with timeouts that start nothing long-lived, and `start_unit` starts the
application under its own unit's cgroup, which is where it belongs;
(4) processes an operator starts by hand in the guest are outside it, as
the writer inventory in `docs/features/immediate-repairs.md` says.

**Verification is an obligation, and only of the revision it was queued
for.** The follow-up `verify_app` job carries `origin.revision` (the source
commit and the build id the deploy stamped). Before the application-owned
check runs, the executor reads what the guest runs (`git rev-parse HEAD`,
`public/build-id.txt`); if either differs, the outcome is `superseded`
(rung value `null`, never `true`): that deploy's revision was never
verified, and the check does not run against something else. A newer deploy
submitted while an older deploy's follow-up is still queued does **not**
cancel it: the follow-up is an obligation, and it decides at run time — in
the natural order it runs first (it is older) and certifies the older
revision before the newer deploy stops anything; if the newer deploy ran
first it finds the new build id and records `superseded`; and if the newer
deploy failed before changing anything (install, build), the older revision
still runs and is certified rather than thrown away. A follow-up that meets
a held lease (a restore in
progress) is **requeued** with a not-before of 30 s (`progress.not_before`,
`requeues` counted, a `requeued` event) and the claim skips it until due —
it is never finished as `deferred`; only a job that is not a follow-up
(`probe`) still ends `deferred` on a held lease. A deploy that **fails
after the stop** (the restart was attempted, or the new unit started and
failed health) queues a post-failure `verify_app` (unit, port, health,
credential, application-owned check; `origin.rung: post_failure`, no
revision claim) and names it in its reason; what the guest runs after the
failure is checked and lands on the failed record as
`post_failure_credential_use`, and the execution verdict stays `failed`.
A **recovery** (`recover_app`) that brought an interrupted deploy's app up
owes the same check the deploy never reached: on success with a data guard
it queues a `verify_credential_use` follow-up before it reports done
(`origin.also` names the recovered deploy), and the rung lands on the
recovery and on that deploy's record; the deploy's own verdict
(`recovery_required`) does not change.

## Restores and the retry mint as runner jobs (A-13, A-14, A-15)

Since this slice the project database restore, the container snapshot
restore and the retry path's secret mint are runner jobs like the deploy:
`restore_db`, `restore_snapshot`, `retry_secrets` (`logic.js`
`RUNNER_JOB_KINDS`). Their surfaces — the MCP tools `restore_project_db`
and `restore_snapshot`, the dashboard's `POST /api/lxc/containers/:name/
snapshot/:snapshot/restore` (now `requireSudo`), and the retry-deploy path
in `mock2/runner.js` — resolve references on the server, submit through
`lib/setup-engine/orchestrator.js` (`mock2/ops.js` wires the three calls)
and observe the job; none of them runs a guest or host command itself any
more. One operation per kind: `restore-db-op.js`, `restore-snapshot-op.js`,
`retry-secrets-op.js`, over the same contained guest executor
(`op-kit.js`) and, for the snapshot, the runner's **host channel**: one
argv array spawned directly (`['incus', 'snapshot', 'restore', name,
snap]`), never a shell string; the backend's in-process executor offers
the same channel through its usual pivot.

**Exclusive submission.** A restore is refused — at submission, before a
job row exists — while the app's lease is held (live: "in progress";
stale: "recovery is required"), or while any mutating job of the app
(`deploy`, `recover_app`, `restore_db`, `restore_snapshot`,
`retry_secrets`) is queued or running; and again at claim time if a lease
appeared meanwhile (`refused` / `lock_held`). It is never queued behind
another operation: a destructive restore must not start minutes later
under a state its operator never looked at. With no executor available
(`runner-required`, no live runner) a restore is refused too — the job is
recorded `cancelled` / `runner_unavailable`, never left queued; a mint is
refused the same way (the deploy that follows mints the same keys when it
runs). The deploy keeps queueing, as before.

**`restore_db`** (`restore_project_db`: `file`, optional
`environment_copy`, optional `retry_of`):

1. *bind* — the dump name must be one our tools write
   (`app-<label>-<stamp>.sql` from `dump_project_db`,
   `app-pre-deploy-<job>.sql` from a deploy, `app-pre-restore-<job>.sql`
   from a restore). With `environment_copy` (`environment.pre-<job>`), the
   pair is a **recovery set** only when a job record of THIS app recorded
   them together (`bindRecoverySet`: the deploy's `recovery.protected`, or
   a restore's); the dump's sha256 must match that record. A file name
   alone binds nothing. Without a copy the mode is *current configuration*.
2. *inspect* (read-only, one contained script): the dump's size, sha256
   and header, the server version, the guard table's `COPY` block, and —
   into the runner's memory only, never a row — the key that will be in
   force after the restore (the copy's, or the current file's).
3. *format and server*: plain pg_dump SQL only (`-- PostgreSQL database
   dump`); a custom-format archive (`PGDMP`) or anything else is refused by
   name; a dump from a newer PostgreSQL major than the guest runs is
   refused.
4. *compatibility, established or refused*: the dump's own protected rows
   are decrypted in memory under that key (or the guard's legacy default);
   one row nothing opens means the restored credentials would be unusable,
   and the restore refuses **before anything is stopped**. No COPY block
   for the guard table → not establishable → refused. An app with no guard
   → not applicable, said so.
5. *protect*: `app-pre-restore-<job>.sql` (written to a temp name; it
   becomes the artifact only when `pg_dump` exited 0, the file is non-empty
   and carries the header — a failed or interrupted capture is reported as
   none and refuses the restore) and `/etc/environment.pre-restore-<job>`
   (0600). Both are recorded with their identity (`generated`: path, size,
   sha256). A `retry_of` reuses the prior attempt's dump only after
   **revalidating** size and sha256 against the record; otherwise a new one
   is taken and the record says why.
6. **checkpoint** (`stopping_app`, `disruptive`, `restore_in_progress`)
   → stop the unit → `psql -f` (errors counted; statement text only) →
   in recovery-set mode the copy is put in force as `/etc/environment` →
   start → port and health → the job ends `succeeded` / `restored` with the
   ladder observed and the two credential rungs **pending**, and a
   `verify_app` follow-up (unit, port, health, classifier, application-owned
   check) queued before it reports done. Its outcome lands on the restore
   record.

Interrupted before the stop → resumed; after it → `recovery_required` /
`interrupted_after_stop` with the reason naming the restore in flight and
the pre-restore dump, the lease kept stale, a recovery job queued (start,
verify, then the application check).

**`restore_snapshot`** (`restore_snapshot`: `container`, `snapshot`,
optional `accept_partial`, optional `retry_of`):

1. *query and validate*: `incus list <name> --format json`; the snapshot
   must exist. **Coverage**: an instance snapshot restores the root disk; a
   custom storage volume attached as a disk device (`pool` + `source`, a
   path other than `/`) is outside it. Such a guest is refused unless
   `accept_partial: true`, and the result then says `complete: false` and
   names the volumes not restored — never a claim of a complete restore.
2. *protect*: the pre-restore snapshot `pp-pre-restore-<job>-<stamp>`,
   confirmed present by a second list and recorded with its `created_at`.
   A `retry_of` reuses the recorded one only when name **and** timestamp
   still match.
3. **checkpoint** (`restoring`, `disruptive`) → `incus snapshot restore`
   → the guest is started again if it was running → a managed application
   gets the full `verify_app` ladder as a follow-up; any other guest ends
   with an explicit `not_applicable` ("not a managed application; Incus
   reports it Running"). Every coordination record lives in the engine's
   database on the host, outside the guest being restored. A failed
   restore keeps the pre-restore snapshot on the record and queues a
   post-failure verification.

The legacy `incus snapshot <name> <snap>` client is discovered by the
client's own "unknown command" answer, as before; everything else fails as
itself.

**`retry_secrets`** (the retry-deploy path): the deploy's own mint
(`deploy-op.js` `mintComponentSecrets`: markers, the data guard, never
overwrite, defer and say why) run alone under the lease, in the job's
cgroup, recording key **names** only; a `retry_of` reports which recorded
keys it found in place (`reused`) — a key already in the file is never
replaced. Its verification is `not_applicable` by name: the deploy that
follows verifies the application.

**Confirmation covers the plan.** The MCP tools issue their one-time token
against `<subject>/<digest>` where the digest is a canonical hash of the
resolved plan (dump, environment copy, mode, snapshot, `accept_partial`,
`retry_of`): a token issued for one plan cannot confirm another, and the
plan is what the dry run shows. `retry_of`, `environment_copy` and the
dump are resolved on the server with ownership checks (same app, same
kind, a terminal prior job; a recovery set of this app).

## Incus lifecycle and snapshots as runner jobs (A-17.2 … A-17.6)

Since this slice the Incus instance lifecycle verbs and the snapshot create
and delete are runner jobs: `instance_create`, `instance_start`,
`instance_stop`, `instance_restart`, `instance_delete`, `snapshot_create`,
`snapshot_delete` (`lifecycle-logic.js` `LIFECYCLE_JOB_KINDS`, mirrored in
`logic.js` `RUNNER_JOB_KINDS`). Their surfaces — the dashboard's
`POST /containers/:name/{start,stop,restart,reboot}`, `DELETE /containers/:name`,
`POST /containers` (the launch), `POST /containers/:name/snapshot`, both
snapshot `DELETE` routes and the `exportTemps` category of
`POST /cleanup/execute`; the MCP tools `control_lxc_container`,
`create_lxc_container`, `snapshot_lxc_container`, `delete_lxc_container`
(the stop and the delete; its protective export stays where it was) and
`delete_snapshot` — call `mock2/ops.js` `runLifecycle` and observe the job.
None of them builds an `incus` command any more; the dashboard's create
route used to interpolate the image and profile unquoted into a shell
string (R-017).

**One operation, fixed commands.** `lifecycle-op.js` runs every kind over
the host executor's argv channel (the runner spawns `incus` directly; the
backend's in-process executor uses its pivot):

| Kind | Command | Verified afterwards |
| --- | --- | --- |
| `instance_start` | `incus start <name>` | `incus list` reads **Running** |
| `instance_stop` | `incus stop <name> [--force]` | **Stopped** |
| `instance_restart` | `incus restart <name> [--force]` | **Running** |
| `instance_delete` | `incus stop <name> [--force]` when running, then `incus delete <name>` | **absent** |
| `instance_create` | `incus launch <image> <name> --profile <p> [--config k=v]… [--network <bridge>] [--vm]`, then best-effort `incus config device override <name> root size=<n>` | present and **Running** |
| `snapshot_create` | `incus snapshot create <name> <snap>` (legacy form discovered from the client's answer), then best-effort `incus config set <name>/snapshots/<snap> user.note=…` | the snapshot **present** |
| `snapshot_delete` | `incus snapshot delete <name> <snap>` | the snapshot **absent** |

The argv comes from `lifecycleArgv(kind, params)` and from nothing else. A
plan carries names, flags and — for a create — a config map whose keys are
on `LAUNCH_CONFIG_ALLOWLIST` (`security.nesting`, the four
`security.syscalls.intercept.*` keys, `security.privileged`, `raw.lxc`
accepting exactly `lxc.apparmor.profile=unconfined`, `limits.cpu`,
`limits.memory`, `boot.autostart`, each with a value shape); a plan with a
`command`, `argv`, `args`, `options` or `script`, an unknown config key, an
unaccepted value or a value that looks like a secret is refused at
submission and again by the runner before it renders anything
(`validateLifecycleParams`). The runner validates every claimed job itself:
authorization happens where the request arrives (the route's permission and
sudo, the MCP key and its gates), validation at the privileged boundary.

**Read before, read after, claim nothing.** Every job reads the guest first
(`incus list <name> --format json`): the target must exist — or, for a
create, must not — and must be the resource the operator confirmed. A
delete is bound to the guest's identity (Incus's `volatile.uuid` and
`created_at`, `params.expect`) and a snapshot delete to the snapshot's
`created_at`; a guest or snapshot recreated under the same name since the
confirmation is refused with nothing issued (`refused` / `target`). After
the command the guest is read again, and only the state in the table above
is success: a command that exited 0 while the guest still reads otherwise
ends `failed` at `verify` — "not claiming success". A start of a guest
already Running (or a stop of one already Stopped) issues nothing and says
so. A failed launch that left a half-created guest removes it
(`incus delete --force`, recorded as `cleanup`) — never one that already
existed, because a create never replaces. The verification recorded on a
lifecycle job is the resource's own state (`resource_state_verified`); the
application ladder is `not_applicable` by name, except that a start or
restart of a **managed** application (a project guest) queues the full
`verify_app` ladder as a follow-up, exactly as a snapshot restore does.

**Exclusive, never queued behind.** A lifecycle verb is an operator's
immediate action: like the restores it is refused at submission while the
guest's lease is held (live: "in progress"; stale: "recovery is required")
or while any mutating job of the guest is open, refused again at claim time
if a lease appeared meanwhile, and refused — `cancelled` /
`runner_unavailable`, not left queued — when no executor is available. A
second identical request while the first is open is refused, not duplicated.
The dashboard maps these to 409 (busy, stale, changed target, create over an
existing name), 503 (no executor), 404 (no such guest or snapshot), 400 (an
invalid plan) (`lifecycleHttpStatus`).

**Interruption is operation-specific** (`LIFECYCLE_PROFILE[kind].replay`):

| Kind | Owner dies after the command was issued | Owner dies before |
| --- | --- | --- |
| start, stop, snapshot create, snapshot delete, delete | **resumed**: the requeued job re-reads the resource; the end state already holds → finished (`resumed after an interrupted attempt`, nothing re-issued); the target is still there with the **same identity** the dead attempt bound (`checkpoint.target`) → the same command once more; a resource of a different identity under the name → `refused`, nothing issued | resumed and run |
| restart, create | **never replayed**: the record ends `recovery_required` / `interrupted_uncertain` naming the check (`incus list <name> --format json`), no recovery job is queued (a generic guest has no application to recover), and the guest's lease is **kept stale**, pointing at that record: every exclusive operation on the guest is refused with the condition — at submission, and at the executor for a row that arrived any other way — and **no job kind takes the lease over** (a follow-up verification waits, requeued every five minutes; a probe or a recovery defers; a diagnostic check clears nothing) until an operator has looked and acknowledged the job (`POST /api/setup/jobs/:id/acknowledge`, sudo). The acknowledgement is one transaction: the outcome, the event naming who and when, and the release of exactly that lease commit together or not at all — a failure leaves the hold in place | resumed and run |

A delete's target identity is recorded at `validated` and again at
`issuing`, so an absent guest after an interrupted delete is verified as this
job's work only when the dead attempt had reached `issued: true` — an absent
target before any command is somebody else's doing and is reported as such.
The `validated` and `issuing` checkpoints are **mandatory**: a write the
store rejects, or one that changes no row because the job was fenced, ends
the operation at `checkpoint` with nothing issued — a record that says
`issued: false` is never reconciled against a command that ran. A cancel is
honoured at the fence before the command; after it, the job finishes and
reads the state back. A stale lease is never taken over by an exclusive kind
(a restore, a lifecycle verb): only a recovery or a verification may — and
none of them when the lease records an unresolved lifecycle verb
(`leaseHold`), which only the acknowledgement clears.

**The record outlives the resource.** Every checkpoint, the identity of what
was deleted, the argv-free plan and the outcome live in `setup_jobs` /
`setup_job_events` on the host; a job that deleted a guest or a snapshot
keeps its evidence. Nothing in a plan or an event is a secret: the note a
snapshot carries is bounded text that the redaction net still scans.

**Confirmation covers the resource.** `delete_lxc_container`'s one-time
token is bound to `<name>/<digest>` where the digest covers the guest's
identity, the export decision and `force`, so a token issued for one guest
cannot delete a guest recreated under its name; the job then revalidates the
same identity before the delete. `delete_snapshot` keeps `confirm: true`
and binds the job to the snapshot's timestamp from the listing the caller
saw. The dashboard's container delete keeps `requireSudo`; both snapshot
delete routes now require it too (R-016), and the client's sudo modal makes
that transparent. `control_lxc_container` keeps `confirm: true` and clean
shutdown only (no `--force` over MCP); the dashboard's stop and restart
buttons keep their `--force`, its reboot its graceful restart.

**The snapshot dialog's polling** is unchanged: `POST /containers/:name/snapshot`
submits the job detached and answers with the client's `jobId` (plus the
engine's `setupJobId`); `GET …/snapshot-jobs/:jobId` reads the engine record
(`running` while queued or running, `done` on `succeeded`, `error` with the
job's reason otherwise) and records the duration for the next estimate. A
refusal — busy guest, no executor — is answered synchronously, before any job
exists to poll. Under `backend-allowed` a detached submission kicks the
in-process drain rather than waiting for the 30 s interval.

What this group did NOT move (each recorded as a later A-17 group in the
platform ledger): the guest configuration verbs (`resize`,
`set_lxc_config`, `set_lxc_resources`, `set_lxc_network`, devices, port
forwards) and the pre-mutation `takeLxcSnapshot` they lean on — moved by
A-17.8, two sections below; rename,
clone, import / export and their post-import start, the zip-import start
and cleanup, the prepared-download and S3-export temp instances; the
project provisioning launch / delete and the idle sweep's stop / start
(`mock2/provision.js`, `lib/project-lifecycle.js`); the component
pre-install, Caddy, storage, migration transports, the workspace terminal,
and every read (`incus list`, `info`, `query`, usage, logs). The
post-launch configuration and the post-start fix-ups it listed here first
are the next section's (A-17.7).

## The post-launch and post-start guest setup (A-17.7)

What used to follow a launch in the dashboard's create route — an in-memory
`activeCreations` map, `ensureNetworkNat` (host `sysctl`, `incus network
set`, `iptables`), a 30 × 1 s IP wait, `ensureDns` (the guest's
`/etc/resolv.conf`), the operator's init script piped through `incus exec`
with a 5-minute kill, the route rows and the Caddy render — and the
fire-and-forget NAT + DNS after the start / restart / reboot buttons, and
MCP `create_lxc_container`'s NAT and 15 s DHCP poll, is one runner job kind,
**`guest_setup`**, with five ordered phases, plus one backend-executed kind,
**`configure_routes`**, for the routes.

| Phase | Where | What |
| --- | --- | --- |
| `network_nat` | host argv, under the host-wide lease `@host/network` | `sysctl -w net.ipv4.ip_forward=1`; `incus network list --format json`; for every managed bridge the host reported (its name validated again before it becomes an argument): `incus network set <bridge> ipv4.nat true`, `iptables -C DOCKER-USER -i|-o <bridge> -j ACCEPT` else `-I`; `iptables -t nat -C POSTROUTING -s 10.0.0.0/8 ! -d 10.0.0.0/8 -j MASQUERADE` else `-A`. Idempotent. A live holder of the lease is waited for (20 s); a dead one is taken over; still held → the phase is `skipped (contended)` and a retry redoes it. **Every command under the lease renews it first at the epoch this job holds it and checks it is still this job's**: a sequence of bounded commands that outlives one lease period keeps the lease, and a lease another job took over meanwhile stops this one before its next write (`failed` / `leaseLost`, the count of commands issued on the record, nothing further issued). A missing Docker chain is a note; a refused `sysctl` or bridge NAT fails the phase |
| `await_address` | host argv | `incus list <name> --format json` every second until the guest holds a **host-reachable** IPv4 (eth0 first, then the Incus NIC device, never a `docker0` / `br-*` / `veth*` address inside the guest) or the bound wait (`addressTimeoutMs`, dashboard 30 s, MCP 15 s, at most 5 min) elapses — recorded as `failed` with the guest left running |
| `dns` | contained guest script | `/etc/resolv.conf` carries the public resolvers (the first one is the marker; a symlink is replaced) — `written` / `unchanged` / `failed` |
| `init_script` | contained guest script | the operator's script, issued **once** (below); the record carries its state, exit code and the log's reference — never its output |
| `routes` | the backend (`configure_routes`) | recorded `pending` on the setup with the follow-up's job id; the backend settles the outcome back onto the same phase and recomputes the setup's completion |

**The completion contract.** `setupOutcome(phases)` is one function every
surface reads (the job's outcome, `progress.completion`, the create-status
answer, MCP's result, the future wizard): `complete` when every required
phase is done; `pending` (outcome `setup_pending`) while a required phase
is with another job — the routes — so a setup is **never** reported
complete with its routes outstanding; `partial` (`setup_partial`) when a
required phase failed, was refused, timed out, was skipped for contention,
or is a failed / acknowledged-uncertain init a retry did not repeat;
`uncertain` (`init_uncertain`) while an init script's completion is
unknown and unacknowledged. The job's **execution status** (`succeeded`,
`failed`, `recovery_required`) is recorded separately and never conflated
with it: a setup that ran to its end with the routes pending is
`succeeded` / `setup_pending`; when the routes step lands, the backend
(`settleSetupRecord`) rewrites the phase, recomputes the completion and
annotates the terminal outcome (`setup_complete` or `setup_partial`) on
the setup job and the summary on the lifecycle job it followed — a failed
render leaves both `partial`, a later successful retry settles both
`complete`.

**One parent record, every phase.** The create route submits the launch
job with the whole setup plan (`params.setup`: phases, the address bound,
the script reference, the services); the start / restart / reboot routes
submit theirs with `fixup: true`. The lifecycle op returns the setup as a
follow-up and the executor persists it as a `guest_setup` job — **bound to
the identity it read back from the launched / started guest** (`expect` =
`volatile.uuid` + `created_at`; a create's plan may not carry an identity
of its own) — BEFORE the lifecycle job reports done, recording
`setup_job_id` on it. The setup record's `progress.phases` names every
required phase with its state (`done`, `skipped`, `failed`, `refused`,
`timed_out`, `uncertain`, `pending`, `not_run`) and is rewritten after
every phase, so a record read at any moment says what was done and what
was not; when it finishes, the summary lands back on the lifecycle job
(`progress.setup`) and the routes step's outcome lands on the setup's
`routes` phase. A phase that fails after the guest is Running undoes
nothing: the guest stays usable, the later phases still run where they
can (no address → routes skipped by name), and the job ends `failed` /
`setup_partial` naming the phases — never a success claim. The dashboard's
`GET /containers/:name/create-status` is derived from the three records
(`mock2/ops.js` `createStatus`): the same answer after a closed browser or
a restarted API, and no map to forget.

**The init script is bound and issued once, and its output stays in the
guest.** The script text never becomes a row, an event or a log line — an
operator's script may carry a token or a password, and the engine's
redaction net cannot know every shape. The route writes it to an **input
file next to the database** (`<db dir>/setup-inputs/<ref>.init.sh`, 0600
in a 0700 directory, `lib/setup-engine/setup-inputs.js`); the plan carries
`initScript: { ref, sha256, bytes }`. The executor — the runner from the
database it opened, the backend in-process from its own path, the same
bind-mounted directory — reads the file by reference, refuses the phase
when it is missing or its digest is not the plan's, writes the
`init_script` checkpoint (`init_issued: true`; mandatory: a write the
store rejects issues nothing), and runs the wrapper in the job's cgroup
**under `umask 077`**: the script is materialised from base64 (0700), run
under `sh` in its own session, its exit code written to
`/var/log/pp-init-<job>.rc` and its stdout and stderr to `.log` — every
artifact owner-only from its first byte whatever the guest's umask (the
log is re-chmodded 0600 as well) — and the wrapper prints **markers only**
(`PP_INIT_RC:<n>`, `PP_INIT_LOG:<path>`, `PP_INIT_LOG_BYTES:<n>`), never
the output: what the script printed (a generated credential, say) exists
in the guest's 0600 log and nowhere else, and no regex stands between it
and the record because nothing crosses. The phase records the state, the
exit code, the log's path and size; warnings and reasons name the log
("its output (61 bytes) is in /var/log/pp-init-<job>.log inside the
container"). The input file is consumed (unlinked) when the phase
completes. A script that runs past `initTimeoutMs` (5 min by default, 30
at most) has its exec client killed by the executor; the kill script then
stops and inspects the attempt's **whole containment group** — the scopes
and cgroups the contained scripts recorded under `/run/mock2-deploy/<job>.*`
(`systemctl kill --kill-whom=all` per scope, `cgroup.kill` or a kill loop
per cgroup; TERM, then KILL) — and counts what is still alive in every
recorded group afterwards, zombies excluded. It is the one script issued
*outside* containment (`op-kit.js` `uncontainedGuest`), because a member
of the group cannot kill and count it. The recorded pid is never the
verdict: an installer that daemonises with `setsid()` leaves the session
group the wrapper started but never its cgroup. Only `PP_INIT_KILL:gone`
(every recorded group empty; the records, the wrapper bodies and the pid
file removed) reads `timed_out`; `alive <n>`, `norecord` (nothing recorded
to inspect — the pid's session is killed on the way out, which proves
nothing) and `unknown` (a scope with no `systemctl`, a cgroup tree no
longer there) are an unknown writer and the guest is **held** (next
paragraph).

**An unknown writer holds the guest; nothing repeats it.** An owner dying
before the script was issued resumes the job (the idempotent phases run
again). Dying after: the resumed job runs the read-back script instead of
the wrapper — an exit code the guest recorded is the phase's result
(`resumed: true`, the log referenced); none → `uncertain`
(`recovery_required` / `init_uncertain`) with the writer's state as the
guest reports it (`running` with its pid, `stopped` with no exit code
recorded, `unknown`), and — because a script nobody can account for may
still be changing the guest — the guest's lease is **kept, flagged stale
and pointed at the job** (the same hold a never-replayed restart takes,
`leaseHold`): every exclusive kind (a lifecycle verb, a restore, a direct
setup or retry) is refused at submission and at the executor, a follow-up
(a verification, a follow-up's retry, the routes step) waits on the long
interval, a probe defers — whoever the lease names, the hold is checked
before any lease is acquired, so a runner cannot walk over the hold it
recorded itself. With no runner to resume it (the backend's boot sweep
after a dead in-process executor) the record ends `init_uncertain` and
held the same way, with the phases that were done kept. The hold ends only
through `POST /api/setup/jobs/:id/acknowledge` **with `writerStopped:
true`**: the operator establishes that nothing of the script is still
changing the guest (the job's cgroup or scope empty, `.rc` read — never
the recorded pid alone) and says so;
without the attestation the request is refused (`WRITER_NOT_ESTABLISHED`,
409) and the hold stands. The acknowledgement is one transaction — the
outcome (`init_uncertain_acknowledged`), the phase marked `acknowledged`
with the writer recorded as stopped by whom, the completion recomputed
(`partial`), the event and the release of exactly that lease commit
together or not at all. Nothing ever replays the script: not the
acknowledgement, not a resume, not a retry. A retry (`POST
/api/setup/jobs/:id/retry`, or `retryOf`) reads the origin's phase table
and **keeps the origin's result** — its state, exit code and log — with
`notRepeated: true` beside it: a retry of a failed init is still a failed
setup (`setup_partial`), a retry of an acknowledged-uncertain init is
partial with the acknowledgement carried (no new hold for a resolved
condition), and running the script again is a deliberate new request
carrying it. The retry redoes NAT, the address, DNS and re-queues the
routes.

**The routes are the backend's.** `configure_routes` (`BACKEND_JOB_KINDS`,
drained by `lib/setup-engine/backend-steps.js` on boot, every 15 s, when a
create-status poll sees it queued, and after a retry) takes the guest's
lease and the host-wide `@host/routes` lease — a held one requeues it with
a not-before, an unresolved hold (checked first, whoever the lease names)
waits longer; it is an obligation, never finished deferred — and hands
the configurator a **fence** that renews both leases at their epochs and
throws when either is no longer this step's. The production adapter
(`mock2/ops.js` `backendStepDeps`) forwards it as-is, and it is checked
before every write of the whole path: the service row, the upstream move
and its revert, each route row, and inside `lib/route-render.js`
`renderDomains` the snapshot, each domain's site file, the validation, the
reload, and every write and the reload of a rollback — so a step whose
lease was taken over ends `failed` / `lease_lost` with nothing further
written, and **no rollback runs after the loss**: the site files and the
upstream row are the new owner's, and a stale worker's "restore" would
overwrite its work. The fence renews **three** leases at the epochs the
step holds them — the job claim itself first (the store's fenced
`heartbeat`: owner, epoch, still running), then the guest lock, then the
routes lock — and between writes (a `caddy adapt` or reload that runs
long) a keep-alive renews the same three every 10 s, so a legitimately
long operation never lets the claim lapse for the runner's `reconcile` to
record it interrupted under live locks, and never lets a lock lapse
either; a renewal that changes no row is remembered and the next write
throws. A claim that is no longer the step's (re-claimed at a new epoch,
ended by the reconciler, expired and taken) is the executor's own
`FencedError`: the step writes no outcome, touches no setup record and
releases only the locks it holds at its epochs — a lost claim is never
revived, because the heartbeat extends only a claim this owner still
holds. Then `lib/guest-routes.js` `configureGuestRoutes`: the
guest's `services` row, its upstream moved and re-rendered when the
address changed, one `service_http_routes` row per service (a domain
already routed to THIS guest's service is `existing`, re-rendered and never
duplicated; one routed elsewhere is a conflict that is reported and never
clobbered), then the Caddy render for the created and existing domains
together. A render failure keeps the rows (`routes_recorded_render_failed`)
and a retry renders again. The Caddy pivot itself is A-17.12's and stays
where it is: this step runs in the backend whatever the executor policy
because it is ProxyPilot's own rows and its own reload, not a host
privilege. A lifecycle verb submitted while the routes job is open is
refused busy like any other mutating job.

**Exclusive, or a follow-up.** A `guest_setup` is in `EXCLUSIVE_JOB_KINDS`:
submitted directly (`mock2/ops.js` `runGuestSetup`, a retry) it is refused
— never queued — while the guest's lease is held or a mutating job is open,
on a stale lease, and when no executor is live (`cancelled` /
`runner_unavailable`). Queued as a follow-up (its plan carries `origin`) it
waits instead: requeued on a live lease, requeued with the long interval on
an unresolved lifecycle hold, and it runs once the hold is acknowledged.
Every parameter is validated at submission and again by the executor
(`validateSetupParams`): phases in their fixed order, a script reference
and never its text (`initScriptText`, `command`, `argv`, … are refused),
validated domains and ports, bounded waits, IPv4 resolvers, a secret
lookalike refused. MCP's `create_lxc_container` carries the two host phases
and waits on the setup **record** for the address (`waitForSetup`, one
minute), reporting `setup_job_id` and what the setup recorded when it ended
otherwise.


## The guest configuration verbs (A-17.8)

Since this slice the dashboard's `POST /containers/:name/resize` and the
MCP tools `set_lxc_config`, `set_lxc_network`, `set_lxc_resources`,
`add_lxc_device`, `remove_lxc_device`, `set_port_forward` (add / remove)
and `set_lxc_egress` submit runner jobs through `mock2/ops.js`
`runGuestConfig`, and the pre-mutation snapshot the MCP tools always took
is taken by the job itself, under the guest's lease, before its first
write. None of them builds an `incus config …` or `proxypilot firewall …`
command any more; the resize route used to interpolate the operator's
`cpu` and `memory` unquoted into a shell string. Seven kinds
(`config-logic.js` `CONFIG_JOB_KINDS`, mirrored in `logic.js`), each
idempotent, each over the host executor's argv channel:

| Kind | Caller | Commands (fixed argv) | Verified afterwards |
| --- | --- | --- | --- |
| `config_set` | resize (dashboard), `set_lxc_config`, `set_lxc_resources` | `incus config set <name> <key> <value>` per allowlisted key; `incus config device override <name> root size=<n>` (fallback `device set`) for a root size | every key reads at its value in `incus list`; `devices.root.size` at its value |
| `device_add` | `add_lxc_device` | `incus config device add <name> <dev> disk\|proxy k=v…` | the device present with every planned property |
| `device_remove` | `remove_lxc_device` | `incus config device remove <name> <dev>` | absent; the removed device's reference-only properties recorded as `previous` |
| `network_pin` | `set_lxc_network` | `incus config device override <name> eth0 ipv4.address=<ip>`, on "already exists" `device set … ipv4.address <ip>` | `devices.eth0["ipv4.address"] === ip` |
| `forward_apply` / `forward_remove` | `set_port_forward` add / remove | the `service_l4_forwards` row written / removed (the job's first step, through the store the executor hands it); `incus config device add <name> ppl4-<id> proxy listen= connect=` / `remove`; `proxypilot --json firewall add-service-l4 --id service-l4-<id> …` / `remove-service-l4`; `proxypilot --json firewall reconcile` when the applied policy does not match; the reserved-ports drop-in refreshed from the rows (below) | the row with the plan's fields; the device with its listen / connect; the SAVED rule with every property (`source`, `proto`, `port_start`, `port_end`, `scope`, `service`, `enabled`) in `firewall list` — or all absent; the APPLIED policy: `firewall status`'s last reconcile applied with the checksum `reconcile --dry-run` reports for the saved configuration; the drop-in body and `sysctl -n net.ipv4.ip_local_reserved_ports` |
| `egress_set` | `set_lxc_egress` | `proxypilot --json firewall egress allow\|deny <guest> <service> [--reason r]`; `proxypilot --json firewall reconcile` when the applied policy does not match | the service present in / absent from the guest's SAVED entry in `egress list`; the APPLIED policy as above; the CLI's reconcile summary on the record |

**Validation at both ends.** The surface validates (the MCP policy files,
`confirm: true`, `dry_run`, `acknowledge_risk`; the resize route's ranges)
and submits; the runner validates the claimed row again
(`validateConfigParams`): a config key must be on `CONFIG_KEY_ALLOWLIST`
(the five keys of `lxc-config-allowlist.json`, each with its value shape),
`security.privileged=true` must carry `acknowledgeRisk: true` in the plan,
a disk device's source must lie under `mcp-extended-policy.json`
`lxc_devices.disk_source_roots` and its proxy listen port within the
policy's range and off its reserved list (the runner reads the same file),
ports and range widths are checked, a device named `root`, `eth0`,
`ppl4-*`, `ppcert-*` or `reporepo` is refused, and a plan carrying a
`command`, `argv`, `args`, `options` or `script`, or a value that looks
like a secret, is refused at submission and again at claim. Every argv
comes from the renderers in `config-logic.js` and from nothing else. Under
`runner-required` with no live runner every kind is refused — `cancelled`
/ `runner_unavailable`, never executed in the backend, never left queued.

**Saved is not applied.** The firewall CLI writes the desired
configuration to `firewall.json` BEFORE it reconciles, and a rejected
reconcile (a lockout, an `nft` failure) leaves the saved configuration in
place with `egress list` / `firewall list` showing it. The review of the
first revision (R-050) found the job reading that saved configuration as
proof. Since the correction the saved configuration (`egress` / `rule`)
and the applied policy (`reconcile`) are two steps: the write step
tolerates the CLI's exit 1 only when its JSON shows the save with a
`reconcile.rejection`, recording the rejection; the `reconcile` step then
reads the evidence — `proxypilot --json firewall status` (the last
recorded reconcile: applied, and its checksum) against `proxypilot --json
firewall reconcile --dry-run` (the desired ruleset's checksum) — and
issues `proxypilot --json firewall reconcile` when they differ, `done`
only when it reports ok and applied. A saved-but-rejected change ends
`failed at reconcile`, never verified; a repeated request never skips
application because the reconcile step reads the evidence, not the saved
entry; a retry after the cause is fixed issues no second write and
reconciles once. A forward's saved rule is compared property by property
(`forwardRuleVerdict`): the expected id with another port, protocol,
range end, scope, service tag or source, or disabled, is `present with
other properties` and never verifies (R-051). And in every kind a step is
`done` only when its command succeeded (or was tolerated by name) AND its
read-back holds: an exit 1 behind a matching read-back is `failed` with
the exit on the record.

**Read, then issue only what is missing, then read back.** Every step
reads its own state first and issues its command only when the state does
not hold: a request whose whole state already holds ends `alreadyInState`
with nothing issued and *no snapshot taken* (there is nothing to protect);
a device that exists with other properties, or a remove of a device that is
not there, is refused before any snapshot or lease. Then the pre-change
snapshot (the MCP kinds), then — for the firewall kinds — the shared
`@host/firewall` lease (waited for 20 s, a dead holder taken over,
contended → refused with nothing issued; renewed before every command, a
lost lease stopping the job before its next command with the count issued
on the record), then the steps in order: the mandatory `issuing`
checkpoint before the first write, a read-back after each, the per-step
state (`already`, `done`, `failed`, `unverified`) on the record. A step
that does not read back — an exit 0 whose value is not there as much as a
nonzero exit — stops the sequence: the job ends `failed at <step>` naming
what was applied before it and what was not run, never a success claim.
The reserved-ports step of a forward is best effort like the reconciler's
(`lib/l4-reserved-ports.js`): its failure is a warning on a forward that
is otherwise complete, with the step's state on the record.

**The snapshot is the job's, named at submission, bound by timestamp.**
The tool plans the name (`pp-mcp-pre-<key>-<stamp>`) and the job creates it
(the legacy CLI form discovered as before), reads it back present and
records it as generated with its `created_at`; a snapshot that fails or
does not read back prevents the change. A snapshot already there under the
planned name that this request did not take is refused (its content is
unknown). A resumed attempt, or a retry (`retryOf`, `reuse`), reuses the
recorded snapshot only when name AND `created_at` still match. Once a
write has begun — this job's interrupted attempt had issued, or the origin
it retries had (`originIssued`) — the ORIGINAL snapshot's identity must be
verifiable before anything further is written: `issuedBefore` proves that
a write began, not that every requested change completed (R-052, the
review of the first revision, which let a job resumed after changing CPU
change memory with its snapshot gone). Missing, replaced under its name
or unrecorded, the job reads the completed changes back (`done`), issues
NO remaining change (`not_run`) and ends `failed at protect` with
`protection: { state: missing | replaced | unverifiable }`, `partial:
true`, the prior values in `previous` and the guidance: revert from those
values, or submit a new request deliberately — it takes a fresh snapshot
of the guest as it is now, which is not the original pre-change point. No
replacement snapshot is ever taken and presented as the original. A
resumed job whose remaining state already holds completes read-only, the
unverifiable snapshot a warning on the record. The protection follows the
INTENT, not the attempt (R-055, the second review): every checkpoint of a
job carries `writeBegun` once a write began anywhere in its chain, the
executor walks the whole `retry_of` chain (same app and kind) for
`issued` / `writeBegun` and for the recorded snapshot identity (the chain's
generated records), so a retry of a retry — and a resume of that retry
after a dead owner — refuses the remaining write exactly as the first
retry did, at any depth; a retry that was itself refused at protection
never becomes the origin of a fresh write. And the identity must be usable:
a recorded name without a timestamp is `unverifiable`, never a wildcard,
after the first write (no further write) and before it (refused: the
snapshot on the guest cannot be certified as this job's). A request
submitted without `retryOf` is a new intent with its own snapshot name and
its own fresh snapshot — distinct from retrying the original. The record
and every result state the coverage honestly (`snapshot.covers`): an
instance snapshot restores the guest's root disk and configuration only —
attached custom volumes are named as not covered — and never ProxyPilot's
own rows (services, routes, forwards) or the host firewall's state. The
resize route keeps its old contract (no snapshot: a live, reversible
limit) and records the prior values of the keys it changes instead;
egress and forwards take none (host firewall state, reversed by the
opposite verb). The prior state a job records is references only: the
changed keys' previous values, a device's addresses and paths
(`RECORDED_DEVICE_PROPS`), the previous reservation.

**Identity.** The MCP tools read the guest before their confirmation and
bind the job to its identity (`expect` = `volatile.uuid` + `created_at`);
the runner refuses a guest of another identity under the name with nothing
issued, and a resumed attempt refuses one that changed since it bound it.
The dashboard resize binds by name (it has no confirmation step to bind)
and runs at once or is refused busy.

**Leases and the keep-alive.** The executor holds the guest's lease from
the first read through the snapshot, every write and the last read-back;
the firewall kinds take `@host/firewall` after it and release it before it
(the documented order: job claim → guest → `@host/firewall`; the NAT phase's
`@host/network` is a different resource and is never held together with
it). A keep-alive renews the job CLAIM, the guest's lease and every held
shared lease every 10 s while one command runs long (`incus snapshot
create` on a large guest, a slow firewall reconcile), and the fence before
every command checks all three: a renewal that changes no row — the claim
ended or re-claimed by the reconciler, a lease taken over — stops the job
before its next command (`FencedError`, `SharedLeaseLostError`), revives
nothing and releases only what it holds at its epochs. The step under way
when a lease is lost is recorded `unverified` when its command had been
issued (its read-back was not done under the lease), the steps after it
`not run`; a retry re-reads every step.

**Interruption.** Every kind is idempotent, so an owner dying at any point
is RESUMED by the runner's reconcile: the requeued job re-reads the guest
against the identity the dead attempt bound (`checkpoint.target`), reuses
its recorded snapshot, reads each applied step as done and issues only the
steps whose state does not hold — nothing is replayed blindly. The
backend's boot sweep (a dead in-process executor, nothing able to act)
records such a job `interrupted` with the honest reason — "the command had
been issued and may have taken effect; a retry re-reads the guest and
finishes or re-issues the same command against the same identity" — and
releases the lease: an idempotent command holds nothing. The explicit
retry (`POST /api/setup/jobs/:id/retry`) is its recovery path; there is no
hold and no acknowledgement for this group, because no step of it has an
outcome the next read cannot establish.

**Forwards: the row and its disposition are the job's.** The first
revision wrote the `service_l4_forwards` row in the request before the job
was admitted and rolled it back in the request (R-050 of the review: a
busy refusal deleted the row with no removal job; a retry of a partial
addition could end with host resources and no row; an older retry
replayed a stale reservation aggregate over newer forwards). Since the
correction `set_port_forward` only validates, confirms and submits — a
refusal at submission changes nothing — and the row is the job's FIRST
step (`row`), written for an apply and removed for a remove through the
store the executor hands the operation (`forwardStore`, the same database
the setup engine's rows live in), under the guest's lease and
`@host/firewall`, before the device, the saved rule, the applied policy and
the reserved ranges. The reserved UDP ranges are recomputed from the
enabled rows under the lease at the moment of the check and of the write
(the plan carries no aggregate; the validator refuses one), so an older
retry keeps what newer forwards reserved. The store is fenced AT the
database boundary (R-053, the second review): each insert / delete runs
under `BEGIN IMMEDIATE` and, inside that transaction, renews the job
claim, the guest's lease and every held shared lease at the epochs this
worker holds; a renewal that changes no row rolls the transaction back and
raises (`FencedError` for the claim, `SharedLeaseLostError` for a lease) —
a takeover bumps the epoch under its own `BEGIN IMMEDIATE`, so it can never
interleave with the write; reads fence the same way. A worker whose claim
the runner's reconcile expired and requeued while another owner completed
the job returns `fenced` and touches nothing: the per-step `applied`
checkpoint is required before anything acts on a step's outcome (a
checkpoint that changes no row raises the fence; an unrecorded outcome
ends `failed at checkpoint` with no rollback attempted), and the
settlement lets a fencing, ownership-loss or cancellation error propagate
at once — only a host read-back failure is best effort, recorded
`unknown`. A definite failure after the row was written is settled by the
job itself (`settleForward`), and the settlement removes ONLY what this
operation CREATED (R-054): ownership is a persisted engine record, never
inferred from an id, an `already` state or an issued command — the job
records `forward_row`, `proxy_device` and `firewall_rule` as generated
(the fenced progress record) only after the create reported success and
was not tolerated by name; a resumed attempt reads its own records; a
retry inherits the records of the failed attempts newer than the first
succeeded ancestor in its chain and nothing older (R-056: a succeeded
origin's changes are the operator's working state, and what an older
failed attempt created under the same names was superseded by that
success — the snapshot history is separate and still walks the whole
chain); every step carries `owned: true | false`. A resource present on a
resume after a write had begun, with no record of its step and no
ownership record, may have been created by the interrupted attempt just
before its record persisted: it is `present` with `ownership: uncertain`
(`owned: null`), never `already` (R-057); the settlement leaves it
(`unresolved … — not removed`), ends `rollback.state: unresolved` and
`partial: true`, and the reason and the recovery-required verification
name the resource and the operator action (decide whether it belongs to
the forward, remove it by hand if it does, retry). Reconstructing
ownership from the guest or cleaning such a resource up automatically is
deferred (`docs/known-issues.md`).
A retry of a completed forward that fails at the reconcile because an
unrelated saved policy is rejected keeps the row, the device and the rule
(`kept (not created by this operation)`, `rollback.state: none`) and
reports the policy as unresolved with the rejection on the record; a fresh
forward that fails after its row and device were created still removes
both, also when it was interrupted between them and resumed. The response
names what could not be removed (the L4 reconciler sweeps an orphan device
at its next pass) — the disposition settles whether or not the request is
still alive. A retry
re-records the row before it touches the host; a row that can no longer be
written because another forward binds the port (the executor's store
checks the port NULL-safely, as `UNIQUE` ignores a NULL range end) is
refused as `superseded` with this id's orphans removed — never a success
without an authoritative row. The drop-in
`/etc/sysctl.d/99-proxypilot-l4-reserved.conf` is refreshed with the
reconciler's exact body — the one host script of this group, a fixed text
under `sh -c` whose only arguments are the base64 of the rendered body and
the drop-in's constant path (`reservedWriteArgv`), applied with `sysctl
-p` and read back through `sysctl -n`; an empty set removes the file and
reloads `/etc/sysctl.conf`. The response keeps its shape
(`reconcile.applied[].detail.{incus,firewall,policy}`,
`reconcile.reservedPorts`) with `job_id` and `verified: true` beside it.

**Truthful results.** Every result carries `applied` per step (with
`owned` on a forward's row, device and rule), `previous`,
`snapshot` (name, timestamp, reused, verified, covers), `partial` and
`notRun` on a failure, `protection` when the original snapshot could not
be verified, `row` (with `owned`; `rolled_back` only when the row was in
fact removed), `firewallPolicy` and `rollback` (per change `removed`,
`absent`, `kept (…)` with the reason, `unresolved` for a policy the
reconcile could not apply; `applied.rollback.state` `done`, `partial` or
`none`) for a forward,
`warnings` for a best-effort step, the executor's `jobId`; the MCP
results keep their fields (`applied`, `snapshot`, `restart_required`,
`restart_recommended`, `previous`, `reconcile`, `reverse_with`) and add
`job_id`, `verified`, `snapshot_covers`, `previous_value` /
`previous_reservation`; the resize route answers `success`, `message`,
`config` as before plus `jobId`, `applied`, `previous`, `verified`. A
refusal maps to 409 (busy, stale, changed identity, a contended firewall
lease, a foreign snapshot, a device that exists otherwise), 503 (no
executor), 404 (no such guest), 400 (an invalid plan)
(`lifecycleHttpStatus`).

What this group did NOT move (each recorded in the platform ledger):
`set_project_resources` and the promote's snapshot in
`routes/mcp-tools/project-config.js` (project provisioning, A-17.10 /
A-17.11), the clone's `eth0` unset (A-17.9), the L4 reconciler's own runs
from the services router and the boot-time `lib/l4-startup.js` (the
services surface, A-17.12's neighbour), the firewall page's own writes,
and the reads. `takeLxcSnapshot` in `routes/mcp.js` remains for the
project lifecycle's deps and the ctx those out-of-scope tools use.

## Who executes: the installation policy

`SETUP_EXECUTOR_POLICY` in the installation's `.env` — read by the backend
at boot (`logic.js executorPolicy`), never from a request:

| Policy | No live runner | Live runner |
| --- | --- | --- |
| `runner-required` (what `install.sh` / `update.sh` set **only after** the runner unit is active and `proxypilot setup-runner status --json` opened the database; see below) | the submission is **queued** and reported unavailable (`step: runner_unavailable`, HTTP 202 with a warning on the submission endpoint); nothing runs in the backend | the runner executes |
| `backend-allowed` (the legacy / development executor; the default when the variable is absent, i.e. a checkout with no `.env`) | the backend claims and executes queued runner jobs in its own process — on submission, on boot and every 30 s — with the **same** executor, record and locks; owner `backend@…` | the runner executes (a live runner always wins) |

An unknown value reads as `runner-required` (the safe reading). No request
parameter, header or MCP argument can enable the in-process executor: the
`deployProject` adapter ignores anything of the kind and decides from the
store's environment only. The two modes share `lib/setup-engine/executor.js`
and the container lock; a restore submitted while either executor holds
the app is refused the same way.

**How the policy is set, and on what evidence.** `install.sh` writes
`SETUP_EXECUTOR_POLICY=backend-allowed` into a **new** `.env` (on a re-run
the existing value is read first and preserved, like the secrets), installs
and starts `proxypilot-setup-runner.service`, waits up to 10 s for the unit to
be active, then runs `proxypilot setup-runner status --install-dir … --json`
(root, opens the engine database). Only when both succeed does it rewrite
the line to `runner-required` and log the success; otherwise it logs an
**error** naming the fix (`journalctl -u proxypilot-setup-runner`, then set
the line by hand and restart) and a fresh installation keeps executing
deploys in the container — visibly, never silently. **A failed runner start
never downgrades:** an installation whose `.env` already says
`runner-required` keeps it (install.sh re-run and update.sh alike: neither
ever rewrites an existing value to `backend-allowed`), the error says the
installation requires the runner and that every deploy queues until it
runs, and the backend's five-minute warning repeats it. `update.sh`
(`install_setup_runner`) does the same on every update: it appends
`runner-required` only on the same evidence, and when the runner is not
there it warns in red — and warns again, differently, when the `.env`
already says `runner-required`, because every deploy is then queueing.
Two rules keep that evidence honest on an update
(`update-runner-policy.test.js` drives the real functions in the script's
order): the generic env sync (`sync_env_keys`, which runs first) skips
`SETUP_EXECUTOR_POLICY` — the example's `runner-required` is never copied
into a `.env` that had no line, so a previously unset installation is
promoted only by the readiness step; and the runner is restarted on every
update, unit file changed or not, because the update refreshed the modules
it imports — a restart the service manager refuses is reported in red and
never reads as ready (the old process may still be active, on the previous
code). At
boot under `runner-required` the backend logs the policy and, from 60 s on
and every five minutes while no runner has a fresh heartbeat, warns
`policy runner-required but no host runner heartbeat: N queued job(s)
wait` with the `systemctl status` / `journalctl` commands; it never drains
the queue itself under that policy. A queued deploy is reported to its
caller as `step: runner_unavailable` (HTTP 202 with a warning on the
submission endpoint) and appears in `GET /api/setup/jobs`.

## The runner

```
proxypilot setup-runner serve       # what the unit runs
proxypilot setup-runner once        # reconcile + drain, then exit
proxypilot setup-runner reconcile   # record dead leases only
proxypilot setup-runner status      # locks (stale flags) + recent jobs
```

Root on the host, outside the dashboard container. It opens the backend's
database the way `proxypilot recover` does (`cli/src/recovery/install.js`)
and imports the engine's pure modules from the checkout it ships in
(`admin/backend/src/lib/setup-engine`, `mock2/auth-data-logic.js`,
`mock2/readiness-logic.js`), so the runner and the deploy agree on every
rule by construction. Its identity is `runner@<host>#<pid>:<instance>`,
fresh per start.

Job kinds it accepts: `deploy`, `recover_app`, `verify_app`, `probe`. Parameters:
`container` (an Incus guest name), `webPort`, `unit` (a `.service` name),
`environmentFile` (absolute), `guard` (table / column names), and for a
deploy the run contract and the secret configs (keys, markers, guards — no
values). **No job carries a host command**; a plan with `command`, `script`
or `argv`, or with a value that looks like a secret, is refused before any
guest command runs. The runner heartbeats into `setup_runners` on every
tick and removes its row on a clean stop.
The scripts it runs are fixed (`probes.js`), print marker lines only, and
the one secret they touch — the active master key, needed to classify the
rows — is read into a variable and never written anywhere.

`deploy/proxypilot-setup-runner.service`: `Restart=always`, `After=incus`,
`NoNewPrivileges`, `ProtectSystem=full`, `ProtectHome=read-only`; installed
and enabled by `install.sh` after the CLI wrapper. On a Docker update,
`update.sh` defers `install_setup_runner` until database maintenance and
the image build have succeeded, before the backend reads its policy.

### Update compatibility corrections (U1 / U2, 2026-09-22)

Verified `main@28fe9e3` against pre-#601 `83c0dff`: both regressions remained;
the #611 policy/restart corrections were already present and are retained.

- **U1 — database maintenance.** Stop the host runner and confirm systemd
  reports it inactive before stopping Docker or relocating the database.
  A failed stop or unavailable state check refuses maintenance. Once this
  phase begins, the EXIT handler covers command failures, explicit failure
  exits, SIGINT and SIGTERM. Recovery stops both writers again, restores the
  original database with its backup WAL only, and discards failed-update
  WAL/SHM (SQLite rebuilds SHM). A legacy-layout rollback also restores the
  pre-layout `.env`, including its database path and unchanged keys, and
  removes the relocated copy. Failed recovery does not restart services;
  successful recovery restarts the runner and checks readiness at the
  restored path before starting Docker. Failures before database maintenance
  do not overwrite a database the update has not yet changed. The existing
  explicit policy values, generic-sync exclusion, readiness-only promotion
  and refused-restart checks remain in force.
  Native updates also arm recovery before PM2 or nohup startup, since startup
  can migrate the database before failing readiness. Recovery stops the PM2
  application and checks its reported PIDs, or terminates the recorded nohup
  child and waits for its exit; an unconfirmed stop refuses restoration.
- **U2 — existing host writes.** The only new `ReadWritePaths` are
  `/root/.proxypilot` and `/etc/sysctl.d`. `HOME=/root` plus
  `cli/src/config.js` resolves the existing CLI database to
  `/root/.proxypilot/proxypilot.db`; SQLite also creates sidecars there.
  `config-logic.js`'s `reservedWriteArgv` creates a temporary file and renames
  it to `/etc/sysctl.d/99-proxypilot-l4-reserved.conf`, so a file-only
  exception is insufficient. Both installer paths create the writable
  directories before startup. Existing CLI files and the other hardening
  directives are preserved.

Evidence: `update-runner-maintenance.test.js` executes the real Bash
functions and Docker maintenance stanza against temporary SQLite databases
with open runner/backend connections; it covers both layouts, rollback
without surviving post-backup rows, absent/present backup WAL, stale sidecars,
mid-relocation/build failures, failure exits/signals, stop refusal (including
during recovery), and final-path readiness. Service/Docker commands are test
doubles; `update-runner-policy.test.js` retains the accepted policy cases.
Permission evidence is configuration-level plus pre-start directory and
CLI-data-preservation tests. **Actual systemd namespace execution is
unverified**: the test environment's PID 1 is `codex`, not systemd. No live
update, service restart, database change, merge or deployment was performed.

Validation on Node 24.19.0: **107/107 passed** across
`update-runner-maintenance`, `update-runner-policy`, `setup-runner`,
`setup-guest-config`, `l4-reserved-ports` and `root-recovery` tests.
The additional `self-update-runner` / `self-update-driver` checks had 17
passes and 5 environment failures: this sandbox denies Unix socket listeners
(`listen EPERM` in the stub agent). `bash -n update.sh`, `bash -n install.sh`
and `git diff --check` passed.

Native-recovery follow-up: **43/43 passed** across `update-runner-maintenance`,
`update-runner-policy` and `setup-runner`. One added regression test executes
the actual native startup stanza and error handler with real temporary
SQLite connections: failed PM2 startup, refused stop, falsely successful
stop with a live PID, and nohup failure with an actual temporary child.
It proves rollback removes startup changes only after the writer closes;
users, keys and configuration are preserved. Both shell syntax checks and
the diff check passed. Actual PM2/systemd host execution remains unverified.

Outside these two corrections: the pre-existing raw-copy backup mechanism
is not an atomic snapshot of concurrent writes, and the existing Docker
image tagging/restart path does not guarantee the old image after a
successful build followed by failure. These remain separate findings, not
additional work in this change.

## The API

| Endpoint | Purpose |
| --- | --- |
| `GET /api/setup/overview` | locks with stale flags, recent jobs, apps in recovery-required |
| `GET /api/setup/jobs?app=&status=&limit=` | jobs |
| `GET /api/setup/jobs/:id` | a job with its redacted events |
| `POST /api/setup/apps/:app/recover` (sudo) | queue `recover_app` (or `verify_app` with `verifyOnly`) for the runner; an open one is returned, not duplicated |
| `POST /api/setup/jobs/:id/retry` (sudo) | queue the same runner plan again with `reuse` |
| `POST /api/setup/apps/:app/deploy` (sudo) | submit a deploy and return its job id (202 queued for the runner; 200 with the result when no runner is live and it ran in-process) |
| `POST /api/setup/jobs/:id/cancel` (sudo) | cancel a queued job, or a running one at its next safe checkpoint |
| `POST /api/setup/jobs/:id/acknowledge` (sudo) | an operator has inspected the guest a restart or create left in an unknown state (`recovery_required` / `interrupted_uncertain`), or — with `{ writerStopped: true }` — established that an init script with an unknown outcome (`recovery_required` / `init_uncertain`) has stopped writing: in one transaction records who and when on the job (and, for an init, the phase as acknowledged with the completion recomputed) and releases the stale lease that records it; refused for any other job (409), and for an init without the attestation (409, `WRITER_NOT_ESTABLISHED`, the hold intact); a store failure leaves the hold in place (500, nothing recorded) |

Admin only, behind the global CSRF check and a fresh sudo grant, audited
(`SETUP_DEPLOY_REQUESTED`, `SETUP_JOB_CANCEL_REQUESTED`,
`SETUP_RECOVERY_REQUESTED`, `SETUP_JOB_RETRIED`). The existing
`POST /api/mock2/projects/:id/deploy` keeps its synchronous contract and now
returns the `jobId`. MCP
tools for the same three verbs are listed as remaining work in the ledger;
the lock itself already binds every MCP mutation that goes through
`withContainerLock`.

### Guided Platform Setup (G1)

Administrators open **Platform Setup** from the existing sidebar
(`/platform-setup`). Choose install, connect existing or skip for Keycloak,
Pomerium, Infisical with Agent Proxy, OpenBao and Vaultwarden. Origins include
scheme and optional port; credentials, paths, query parameters, fragments and
unknown fields are refused. No bootstrap credentials are accepted.

| Endpoint | Purpose / authorization |
| --- | --- |
| `GET /api/setup/platform` | Admin: saved plan, catalog and separate installation evidence; no-store |
| `POST /api/setup/platform/checks` | Admin + global CSRF: check supplied choices without saving or executing; no sudo needed for read-only observation |
| `PUT /api/setup/platform` | Admin + global CSRF + existing fresh sudo: `{schemaVersion:1, expectedRevision, reviewed:true, choices}`; validate, recompute checks and save; stale revision returns 409 |

Migration 1002 stores one shared draft with monotonically increasing revision,
schema version, reviewer/time and server-generated check snapshot. This is a
`saved_plan`, never an executable job, installed service or changed login.
The plan survives API restart. Empty inventory reads `unknown`, never fresh;
recorded routes show existing configuration but cannot verify a service.

Preflight uses the existing system-stats reader (API-visible CPU/memory/disk,
not target-host suitability), runner heartbeats, safe `agent.ping` and
`caddy.version` calls with bounded timeouts, and recorded services/routes/admin
domain conflict checks. Existing connector URL and egress host/port validators
are reused. Service URL reachability, DNS/TLS/identity, unmanaged Caddy state
and target sizing remain **not checked**: no policy-approved service adapter
exists, no arbitrary URL probe or host-shell fallback is introduced, and no
egress grant is created. Conflicts and unresolved dependencies can be saved
for later. Editing choices clears the displayed check snapshot; saving checks
the exact choices again on the server. Installation/login activation stay
disabled until later adapters exist.

Existing jobs and their redacted events come from the existing `/api/setup`
endpoints and refresh every 10 seconds. Execution status, outcome and
verification/pending rungs are shown separately; saving does not create a job.

Verification and limits: platform delivery ledger G1 evidence. Run
`node --test src/__tests__/platform-setup.test.js` from the backend, then
`npm run build` from the frontend. Browser verification after the build:
`CHROMIUM_EXECUTABLE_PATH=/path/to/chromium G1_EVIDENCE_DIR=/tmp/g1-evidence node
admin/frontend/scripts/verify-platform-setup.mjs` from the repository root.
Optionally provide `G1_LIGHTHOUSE_MODULE` as an installed Lighthouse module path
for the mobile accessibility gate. The script uses a disposable SQLite/HTTP
fixture; it never starts the production boot sweep or contacts live services.

### Guided Keycloak setup (G2)

G2 extends the saved G1 plan. Choose **Keycloak → Install / Connect existing /
Skip**, enter an HTTPS **origin** and a separate **realm name**, save, then
**Review Keycloak changes**. Inspect the target, issuer, ownership and changes;
**Apply Keycloak installation** or **Verify and record connection** is the only
execution boundary. It uses existing admin authorization, CSRF and fresh sudo.
Saving, opening, checking and skipping never submit an operation. Revision
conflicts return 409; reopen, review and apply the current revision.

| API | Behavior |
| --- | --- |
| `GET /api/setup/platform/keycloak/review?revision=N` | Admin-only, no-store; exact saved revision and planned changes, no execution |
| `POST /api/setup/platform/keycloak/apply` | Admin + CSRF + fresh sudo; `{expectedRevision:N, reviewed:true, retry?:true}`; durable job or existing attempt; no credential input |
| `GET /api/setup/platform` | Intended plan plus separate `keycloak` records: ownership, resource references, latest job, verified connection and verification time |
| Existing `/api/setup/jobs/:id` | Persistent phases, outcome, verification and redacted events; generic retry refuses Keycloak because reviewed revision is required |

Migration 1003 stores immutable installation identities and verified evidence
separately from intentions. The adapter is deliberately runner-only under either
existing executor policy: protected host files must never be generated inside
the API container. No runner means a queued `runner_unavailable` result, never a
host-shell fallback. Start/repair the existing `proxypilot-setup-runner` service;
do not weaken `SETUP_EXECUTOR_POLICY`. Its existing reconciliation and leases
resume interrupted operations. The API's existing periodic backend-step drain
performs the Caddy handoff under the app and shared routes leases; a restarted
API requeues an interrupted Keycloak route step and reads its owned rows back.

**Managed installation.** Requires host Docker, the existing runner and managed
Caddy routing. Supported target is one DNS HTTPS origin on port 443 with a
dedicated root-context realm other than `master`. The pinned images are
`quay.io/keycloak/keycloak:26.7.4` and `postgres:17.9-bookworm`. They have distinct
`pp-kc-<id>-server` / `-db` containers, an isolated Docker network, persistent
`-data` volume and `unless-stopped` restart policies. They carry no ProxyPilot
Compose project labels, so update.sh's application `compose down --remove-orphans`
does not own them. No changes to install.sh, update.sh or the accepted U1/U2 unit.

Only Keycloak's HTTP port is published, at **127.0.0.1:18080**. Caddy retains
ports 80/443 and certificates, using the existing route rows, rendering,
validation and reload. PostgreSQL and management port 9000 are not published.
Hostname conflicts (including current route records, legacy services,
admin domain and unmanaged managed/custom/main Caddy files), foreign Docker
ownership labels and altered owned container configuration are refused.
A fixed Keycloak hostname and realm belong to the recorded installation; G2
does not retarget it, adopt another service or replace its volume.

The realm is imported only on initial creation; subsequent startup skips it.
A realm ownership attribute is checked in this installation's database before
routing. Readiness requires PostgreSQL readiness, Keycloak `/health/ready`
with database metrics enabled, then discovery at the **public HTTPS issuer**,
exact issuer equality and parseable public signing keys at that realm's certs
endpoint. Starting a container alone never reports ready. Certificate/trust,
DNS or public reachability failures remain failed verification with resources
retained. The initial master realm is Keycloak's own bootstrap requirement;
no ProxyPilot client or user is provisioned.

**Existing connection.** G2 reads only the selected realm's discovery and keys.
It records `external` ownership and the time/checks actually performed. This
proves the issuer connection, **not administrative permission or DB health**.
No admin API, credentials, clients, users or realm mutation is involved. G3
will own ProxyPilot client registration and login activation.

The network reader reuses the existing operator egress host/port validator and
restricts reads to the explicitly reviewed HTTPS origin. It pins DNS for each
request, retains TLS certificate/hostname validation, refuses redirects and
cross-origin key URLs, limits bodies to 1 MiB and bounds DNS/HTTP time. G2
supports IPv4 (including explicitly reviewed RFC1918 destinations); loopback,
link-local/metadata and other special-use addresses are blocked. IPv6-only
issuers and installations under a non-root context such as `/auth` are not
supported in this slice. No firewall grant or arbitrary URL probe is created.

**Initial administration.** The guide displays only the protected reference:
`/var/lib/proxypilot/keycloak/kc-<id>/credentials.json`. As root on the host,
read its `bootstrap` field in a private terminal (never paste it into a job,
issue or log). Open `https://<selected-host>/admin/`, sign in as
`bootstrap-admin`, create a permanent Keycloak administrator, confirm that
account works, then remove the temporary bootstrap account. Keycloak creates
bootstrap administrators only before its master realm exists; restarting the
container does not recreate a removed account. This does not change the
ProxyPilot administrator, local credentials or active sessions.

**Protected backup/recovery set.** Retain a PostgreSQL-consistent backup of the
owned Keycloak database (for example `pg_dump -Fc -U keycloak -d keycloak` run
inside its recorded DB container), the entire **0700** installation directory
(including **0600** credentials/env/owner files and the realm import), and a
consistent ProxyPilot SQLite backup including its installation/job/route
records. Protect dumps as secrets; Keycloak's DB includes user data, realm keys
and sessions. Record the pinned image versions and existing Caddy certificate
references. A raw copy of a running PG volume is not a consistent backup.
Restore matching data, configuration and ownership references together; never
restore or delete one side and regenerate credentials to compensate.

For lost Keycloak administration, use its documented `bootstrap-admin user`
command with all Keycloak nodes stopped, the **same DB options** and a protected
environment password (`--password:env ...`, not a password on argv). The pinned
image and recorded network/env files provide those options. Restart only the
owned Keycloak service after recovery, establish permanent access, and remove
the temporary account. This is an operator recovery procedure, not a G2 button;
no recovery command or live restart was executed during implementation.

**Interrupted setup.** Reopen the saved target and inspect its existing job.
Runner/API restart resumes durable work. After a definite failure, correct the
reported collision, runner, TLS or readiness problem, review again and apply;
the guide submits a retry referencing the same installation. Resources and
credentials are reused, never automatically replaced or rotated. Missing or
unsafe protected files require restoring the recovery set. An orphan partial
file set without an ownership marker requires host inspection; G2 refuses to
claim it. Skip saves an intention; it does not uninstall an existing service or
cancel an already approved operation. Successful output is:
**“Keycloak ready/connected; ProxyPilot SSO not activated.”**

Official configuration references checked 2026-09-22:
[release/downloads](https://www.keycloak.org/downloads),
[container configuration](https://www.keycloak.org/server/containers),
[reverse proxy and hostname](https://www.keycloak.org/server/reverseproxy),
[supported databases](https://www.keycloak.org/server/db),
[startup realm import](https://www.keycloak.org/server/importExport),
[health and DB metrics](https://www.keycloak.org/observability/health),
[bootstrap administration and recovery](https://www.keycloak.org/server/bootstrap-admin-recovery),
[PostgreSQL 17.9](https://www.postgresql.org/docs/release/17.9/).

**Verification limits.** `keycloak-setup.test.js` drives production HTTP routes,
auth/CSRF, SQL, jobs, leases, reconciliation, runtime command construction,
protected files, Caddy route SQL/render orchestration and discovery parsing.
Docker command responses and the external discovery service are scripted for
the end-to-end install/connect tests. A separate local HTTPS contract test uses
real TLS and public-key parsing; its sole network seam maps a validated private
test address to loopback because the sandbox exposes no external interface.
The browser fixture uses production setup endpoints and node:sqlite, with
background shell endpoints stubbed. Native better-sqlite3 production boot,
real Docker/Keycloak/PostgreSQL, Caddy binary, public DNS/TLS issuance and
systemd were unavailable, not claimed as executed. There was no production
deployment or live service/DNS/database/credential change. Full maintenance UI
and restore drill remain outside G2.

## Privilege separation, stated exactly

- The runner is the process that deploys, starts units inside guests and
  reads their environment files for the engine; the browser-facing API
  writes rows it reads. A request cannot make it run anything but its fixed
  scripts and the guest's own contract commands inside that guest.
- What the deployment slice, the restores slice and the lifecycle slice
  REMOVED from the container's path: on a `runner-required` host (what
  install.sh / update.sh set once the runner proved it starts and opens the
  database), the deploy's guest commands, both restores (their dumps,
  `psql`, the `incus snapshot` commands), the retry path's mint, the secret
  mint, the unit swap, the recovery and every verification — the
  application-owned credential check included — and the Incus lifecycle
  verbs (`incus launch|start|stop|restart|delete`) and snapshot create /
  delete of the dashboard and MCP never run in the backend container: they
  run in the runner, and with no runner the deploy waits and everything
  else is refused. Only a `backend-allowed` installation keeps the
  in-process executor and its nsenter pivot for these operations.
- The post-launch slice (A-17.7) moved the create route's post-launch
  configuration and the post-start NAT / DNS fix-ups the same way: the
  host NAT commands, the address wait, the guest's resolv.conf and the
  operator's init script run in the runner as `guest_setup` phases (the
  script an input file by reference, never a row); only the route rows and
  their Caddy render stay in the backend, as its own `configure_routes`
  step, because Caddy is A-17.12's.
- The configuration slice (A-17.8) moved the guest configuration verbs the
  same way: the dashboard resize and the MCP config, network, resources,
  device, port-forward and egress writes — and the pre-mutation snapshot
  the MCP verbs take — run in the runner as the seven configuration kinds
  (the `service_l4_forwards` row stays a backend step, as the routes do).
- What it did NOT remove: the container still has `privileged: true`,
  `pid: host` and the Docker socket, and every other feature (rename /
  clone / import / export and the transports' temp instances, project
  provisioning and the idle sweep with their own resource and snapshot
  writes, the component pre-install, Caddy and the services router's L4
  reconcile, storage, migration, the workspace terminal, every read)
  still pivots through it. Dropping that reach is Phase F of
  `docs/features/security-completion/master-spec.md`; each slice reduces
  what depends on it, and does not claim more.
- The dashboard backend still runs `privileged: true`, `pid: host`, with the
  Docker socket mounted, and still drives Incus, Caddy and Docker itself
  through `nsenter -t 1` for every existing feature. **That reach is
  unchanged by this work.** Until Phase F of
  `docs/features/security-completion/master-spec.md` drops it, "privilege
  separation" here means the *new* engine's privileged execution does not
  depend on it — not that it is gone.
- The unprivileged `proxypilot-agent` is not involved: it may not start
  units in guests, and the runner needs no request-file exchange because it
  reads the same database.

## Operating it: restrictions and recovery steps

What an operator may see on `GET /api/setup/jobs` (or the runner's
journal), and what to do. Every step below is reversible or read-only
except where it says so; none needs a secret on a command line.

| Record | Meaning | What to do |
| --- | --- | --- |
| deploy `recovery_required` / `containment_unavailable` | the guest offers no containment (no running systemd with `systemd-run`, no writable cgroup tree); **nothing ran**, the lease was released | fix the guest (the provisioned image has systemd; a hand-built guest may not), then retry the job (`POST /api/setup/jobs/:id/retry`) |
| deploy or recovery `recovery_required` / `previous_writer_alive`, lease `stale_since` set | a previous job's processes survived two kills; the lease is kept and flagged; every deploy / restore / mint on this app is refused with this reason | in the guest: `cat /run/mock2-deploy/*.units *.cgroups`, then `systemctl kill --signal=KILL --kill-whom=all <scope>` or `echo 1 > <cgroup>/cgroup.kill` (never the application unit); retry the job — its reap recounts and, at zero, proceeds and releases the flag |
| `verify_app` outcome `superseded` (rung value `null`) | a newer revision was running when the check came due (a newer deploy ran first); the older revision was never certified | nothing: the newer deploy carries its own follow-up; an app that never reaches `credential_use_verified` on any record has a real problem in that record's reason |
| `verify_app` queued with `progress.not_before` and `requeues` | the app's lease was held (a restore) when the check came due; it retries every 30 s | nothing, unless the lease is stale (then the runner's reconcile records that and the check follows) |
| deploy `failed` with "post-failure verification queued: job …" | the failure happened after the stop; a full verification of whatever runs now is queued | read that job's outcome first: `succeeded` means the old app is serving and its credential is usable; `recovery_required` names the rung and the next step |
| deploy `queued` with `step: runner_unavailable` at submission | policy `runner-required`, no runner heartbeat | `systemctl status proxypilot-setup-runner`, `journalctl -u proxypilot-setup-runner`; the job runs when the runner heartbeats — do not set `backend-allowed` to "unblock" a production host |
| backend log `policy runner-required but no host runner heartbeat` every five minutes | the same, seen from the backend | the same |
| restore `failed` at `bind`, `inspect`, `compatibility` or `protect` | refused before anything was stopped: the recovery set does not match a record, the dump is not a plain pg_dump, the guest's PostgreSQL is older, the dump's rows do not decrypt under the key that would be in force, or the pre-restore copy could not be taken | nothing to recover; read the reason. For a mismatch, restore the dump together with the environment copy of the same recovery set (`environment_copy`), or a dump made under the current configuration |
| restore `recovery_required` / `interrupted_after_stop` with "A database restore was in flight" | the owner died between the stop and the start; the database may be partially restored | the recovery job starts the unit and verifies; if the application is wrong, restore the named pre-restore dump (`app-pre-restore-<job>.sql`, with its `environment.pre-restore-<job>` copy) |
| restore `cancelled` / `runner_unavailable` | policy `runner-required`, no runner heartbeat: a restore is refused, never queued | start the runner, submit again |
| restore_snapshot `failed` at `coverage` | the guest has custom storage volumes attached that an instance snapshot does not restore | pass `accept_partial: true` for a root-disk-only restore (the result says `complete: false`), or restore the volumes by other means |
| restore_snapshot `succeeded` with `complete: false` | the root disk was restored; the named custom volumes were not | what the result names is still at its current state |
| `retry_secrets` `cancelled` / `runner_unavailable` | the retry path's mint had no executor; not queued | the deploy that follows mints the same keys when the runner runs it |
| a lifecycle job (`instance_*`, `snapshot_*`) `cancelled` / `runner_unavailable` | no runner heartbeat under `runner-required`: the verb was refused, never queued | start the runner, click again |
| a lifecycle job `refused` at `target` | the guest or snapshot under that name is not the one the request was confirmed for (its uuid or timestamp changed) | look at it again (`incus list <name> --format json`, the snapshots panel) and submit a new request |
| a lifecycle job `refused` at `query` ("already exists") | a create over an existing name; nothing was launched | pick another name, or delete the existing guest deliberately |
| a lifecycle job `failed` at `verify` | the command exited 0 but the guest does not read as the verb promises (e.g. a start that leaves it Stopped) | read the guest's console / `incus info --show-log <name>`; nothing was claimed |
| a lifecycle job `failed` at `issue` with `cleanup` | the launch failed; a half-created guest was removed (`removed: true`) or could not be (`detail`) | fix the image / profile named in the error; remove the leftover by hand if `removed` is false |
| a restart or create `recovery_required` / `interrupted_uncertain`, lease `stale_since` set with `recovery_job_id` = that job | the owner died after issuing the command and before reading the result; it is not replayed; every operation on the guest is refused with this condition | `incus list <name> --format json` (or `incus info`); when you know the guest's state, `POST /api/setup/jobs/:id/acknowledge` — the lease is released and the job reads `interrupted_uncertain_acknowledged`; then submit the request you want |
| a lifecycle job `failed` at `checkpoint` ("could not be persisted") | the engine database rejected the checkpoint before the command, or the job was fenced; nothing was issued | look at the database (disk, locks); submit again |
| a lifecycle job `refused` / `lock_stale` | a row reached the executor (a retry, a direct insert) while the guest's lease is stale | resolve the condition the lease records (recovery, or the acknowledgement above), then submit again |
| a start / stop / delete / snapshot verb resumed after its owner died ("resumed after an interrupted attempt") | the requeued job re-read the resource and finished, or re-issued the same command against the same identity | nothing |
| install.sh / update.sh `Setup runner did NOT start …` (error) or the red update warning | the host stays (or is left) on `backend-allowed`: deploys execute in the container | fix the runner, then set `SETUP_EXECUTOR_POLICY=runner-required` in the install's `.env` and restart ProxyPilot; `update.sh` records it itself on the next update that finds the runner working |

Restrictions that hold on every installation: a deploy, restore or retry
mint on an app whose lease is held or flagged is refused, not queued behind
it (the follow-up verification is the one job that waits); a cancel after
the stop is declined; the engine never rolls a migration back — a restore
is an operator's explicit, confirmed request naming the copy, and the
copies a deploy or restore took are named on its record for that.

## Tests

`setup-guest-config-review-2.test.js` (5 tests): the review of `e97a66a`
(R-053…R-055), imports only symbols that exist at the reviewed head and was
run against it in a worktree first (the four reproductions fail there for
the reviewer's reasons; the non-regression case passes on both): a
forward job whose device command fails, expired and requeued by the
runner's actual `reconcile()` during the following read and completed by
another owner meanwhile — the old worker `fenced`, nothing further issued,
the new owner's row, job record and host state preserved; a retry of a
completed forward failing at the reconcile behind an unrelated rejected
policy keeping the row, the device and the rule with the policy reported
unresolved, and a fresh partial forward (also one interrupted between its
device and its rule) still removing its own creations; the retry, the
retry of the retry and a resume of that retry after a partial change with
the original snapshot lost, each refusing the remaining write with no
replacement snapshot, then a deliberately new request applying with its
own snapshot; a recorded snapshot without a timestamp refusing the
remaining write as `unverifiable` and refusing to proceed before any
write. The main suite gained the store-level test (the executor's
`fencedForwardStore` refusing a delete, an insert and a read after a
takeover of the guest's lease and after a re-claim, inside its own
transaction, the row untouched, no transaction left open) and the chain /
ownership helpers (`originChain`, `ownedFrom`).

`setup-guest-config-review.test.js` (8 tests): the review of the first
revision's seven reproductions — a rejected egress application not
verified and applied by the retry; a saved rule under the expected id with
the wrong port or protocol never verified; a refused forward removal
preserving its row and host state; a retry of a partially failed addition
ending with row AND host, or refused superseded with the orphans removed;
an older retry preserving a newer forward's reservation; a missing and a
replaced original snapshot after the first write preventing the remaining
one — plus the row-settlement path interrupted after its row and device
(resumed once, settled once) and a resumed job completing read-only. Every
symbol it imports exists at the reviewed head, and the file was run
against `ad1a638` in a worktree: the seven fail there for the reviewer's
reasons (verified success with exit 1; `added: true` with the wrong port;
the row removed on a refusal; the device left with no row; the newer
range lost; memory changed) and pass on the correction. Its fixture,
shared with the main suite (`helpers/scripted-config-host.js`), models the
CLI's save-before-reconcile order with `status`, `reconcile --dry-run` and
`reconcile` as the evidence.

`setup-guest-config.test.js` (28 tests, the last two the closing
corrections R-056 / R-057; the reserved-ports drop-in written
under the sandbox's real `sh` against a temp file, twice — once alone, once
through the executor from a forward job; the rest over a scripted host —
`incus`, the firewall CLI by its path, a `sysctl` that reads the temp file
— and the real store, executor and orchestrator on `node:sqlite`, the MCP
tools over the real `services` / `service_l4_forwards` / `mcp_ledger`
schema). Covered: the registry and the strict validation (allowlisted keys
and shapes, the risk acknowledgement, the device policy's roots and ports,
range widths, never a command or a secret-looking value), every argv
renderer, the read-back verdicts and the reference-only prior state;
`config_set` with and without its snapshot (taken and read back before the
first write, recorded as generated with the coverage naming a custom
volume; a failed snapshot changing nothing; a foreign snapshot under the
planned name refused), a key whose write exits 0 but does not read back
(failed at that key, the rest not run, the applied ones reported), a
changed identity refused with nothing issued, devices added / refused when
present otherwise / removed with `previous` recorded / a remove of an
absent device refused before any command, the address pin with its
override-then-set fallback, the forward (device + rule + drop-in, the
tolerated present device and rule, a firewall refusal leaving the device
on the record as applied, the remove recomputing the reservation and
removing the drop-in, a failed `sysctl` as a warning), egress allow / deny
with the CLI's reconcile summary, a deny of a service not allowed issuing
nothing; exclusivity at submission, at claim and under `runner-required`
(cancelled, nothing run in the backend) and a lifecycle verb refused while
a configuration job is open; the shared firewall lease waited for and the
job refused contended with nothing issued, a dead holder taken over, a
lease lost between two commands stopping the job with the count issued
(the device `unverified`, the rule and the drop-in not run); the claim, the
guest's lease and the shared lease heart-beaten through one long command
while the runner's actual `reconcile()` runs from another owner with the
clock past the lease period three times (nothing interrupted, every lock
live, the job completes) and a claim the reconciler requeued under the
command fencing the worker before its next write; interruption before and
after the first write (resumed by the reconcile, the snapshot reused by
name and timestamp, the applied key read as done, only the missing key
issued; a recreated guest refused; a gone snapshot a warning), the boot
sweep's honest `interrupted` record with the lease released, an explicit
retry reusing the origin's snapshot and refusing one replaced under its
name, the mandatory `issuing` checkpoint; the ops layer's plan digest and
HTTP mapping; the MCP tools' dry-run and confirm gates, ledger rows naming
the job and the snapshot, a guest replaced between the tool's read and the
job refused, a definite forward failure rolling the row back with the
host's state named; the runner's host channel handed each rendered argv
verbatim. `immediate-repairs.test.js` gained the A-17.8 ratchet (no `incus
config` / firewall command and no snapshot in the callers; the op with no
shell of its own; the one fixed host script; the keep-alive and the fence
in the executor). The resize route and the two tools in `routes/mcp.js`
import the native database module and are covered by that ratchet.

`setup-post-launch.test.js` (32 tests; three run the generated guest scripts
under the sandbox's real `sh` with a real detached child for the timeout
and the guest's umask at 022, one more runs the real wrapper and read-back
through the store with a script that echoes a synthetic credential, the
rest over a scripted host + guest and the real store, executor and backend
step on `node:sqlite`, the routes step over the real `services` /
`service_http_routes` schema with a fake render bundle). The review of the
first revision (platform ledger R-034…R-037) is covered by: an unknown
writer (still running, gone without an exit code, unknown) holding the
guest — every exclusive kind refused at submission and at the executor
with nothing issued, a follow-up and a follow-up's retry waiting with the
hold event, a probe deferred, the acknowledgement refused without
`writerStopped`, refused and releasing nothing when its event write fails,
and releasing exactly the lease with the phase, outcome, completion and
event together otherwise, after which the waiters run and a start is
accepted, a retry still partial and never re-running; the boot sweep
holding the same way, also when the lease row had already gone; a kill
that leaves the writer alive holding, one that establishes it gone not;
the shared network lease renewed through a sequence in which every command
outlives the lease period (another owner refused `held` at every step, no
takeover, every command issued) and a worker whose lease was taken over
mid-sequence issuing nothing further (three commands then none, the new
owner's lease untouched); the routes fence (a lost route-store lease and a
lost guest lease, through the real configurator: no row written after the
loss); the echoed credential in the guest's 0600 log and in no row, event,
verification or create-status answer, with the read-back the same; a
retry keeping a failed init failed; a failed render and an interrupted
routes step settling the setup and its lifecycle parent `partial`, a
successful retry settling both `complete`, `setup_pending` while the
routes are with the backend. The second review (R-038, R-039) by: the
route path through the PRODUCTION adapter (`backendStepDeps` →
`drainBackendStepsNow`, the store carrying only a Caddy over a temp dir)
— success with the files rendered from the rows, one adapt and one
reload; the routes lease taken before any mutation (no row, no file); the
guest lease taken after the first of two domains (the second never
rendered, nothing validated or reloaded, no rollback write, the new
owner's file standing, its epoch untouched); a validation failure with
ownership intact (every file restored, the known-good config reloaded)
and after the lease was taken (nothing restored, the new owner's site
file and upstream row untouched, `lease_lost`); both leases renewed
through a validation that outlives the lease period five times over and
a keep-alive that sees the loss stopping the reload; the third review
(R-040) by the job claim heart-beaten with the locks — the render
outliving the claim period three times over with the runner's actual
`reconcile()` invoked at each increment while adapt waits (it touches
nothing; claim and both locks live and this backend's at every probe; one
reload; setup and create complete), the claim ended by that reconciler
under the render (fenced: no reload, no rollback write, the reconciler's
record and the other owner's guest lock untouched, the routes lock
released, the setup record left to its next owner) and re-claimed at a new
epoch by another backend (fenced, the next owner's claim untouched); and
the timeout kill
with REAL processes through `submitRunnerJob` and the executor under the
sandbox's cgroup1 pids containment: an init script daemonising a `setsid`
writer, the client timed out at the bound, the recorded leader killed and
the descendant still writing inside the job's cgroup → the group kill
stops it (`gone`, no hold, cgroup and records removed, a delete
accepted); the record removed before the kill → `norecord`, the
descendant still writing, the guest held, a delete and a setup refused,
the acknowledgement refused without the attestation and releasing only
after the writers are stopped by hand; plus the scripted `alive`,
`norecord` and `unknown` verdicts holding, and a pid-only kill shown to
leave the descendant writing (why the pid was never evidence). The rest of the file: the kind
registries (both modules agree; `configure_routes` never a runner kind);
strict parameter validation (a script reference and never its text,
ordered phases, validated services, bounded waits, secret lookalikes;
through `validateRunnerJob`; a create's plan without an identity, `fixup`
on start / restart only; `setupFollowUpFor`); the fixed NAT argv, a bridge
name validated before it is an argument, the host-reachable address pick
(eth0, the NIC device, never a runtime's own bridge); the markers, the
phase table, the outcome, the create-status view for every state; the DNS
script writing, leaving alone, replacing a symlink, failing; the init
wrapper recording `.rc` / `.log` / the tail and removing its script, the
read-back, the timed-out script surviving its client in its own session
and stopped by the kill script with nothing claiming an exit; the input
store (0600 / 0700, once per reference, digest, consume, sweep); the
dashboard create end to end (the plan on the launch, the setup bound to
the launched guest, every phase recorded, the script reaching the guest
once and never a row, the routes step queued and landed, the summary on
the create, create-status `caddy` → `ready`, the poll kicking the drain,
every lease released); a create without script or services; a failed
launch queueing no setup; MCP's create waiting on the record; start /
restart / reboot's fix-up (a Running guest still gets it; no fixup → no
setup; not a project → no ladder); no address (routes skipped, guest
kept); a nonzero exit (recorded, consumed, the retry redoing NAT / DNS and
never the script); a timeout (killed, recorded); containment unavailable
(host phases done, guest phases refused, nothing run, input kept); a
tampered input refused by digest; identity (recreated guest refused,
Stopped refused, absent not found); NAT notes and failures; interruption
before the script (resumed, run once) and after (exit read back — 0 and
7 — never re-run; nothing recorded → `init_uncertain`, lease released,
origin annotated, a start not refused, a retry still not repeating; the
boot sweep for a dead backend); a dead backend mid-routes (interrupted,
the setup's phase marked and the aggregate settled, the retry re-rendering
with no duplicate row);
`configureGuestRoutes` (conflicts never clobbered, render failure keeps
rows, upstream move); runner-required (direct setup refused, create
refused before any launch, a live runner running create then setup);
unresolved holds (direct refused at submission and executor, follow-up
requeued with the hold intact, running after the acknowledgement);
contention on `@host/network` (waited, skipped contended, dead holder
taken over, released) and on the routes (guest lease and route store
requeue with a not-before, dead holder taken over); mutual refusal between
lifecycle verbs and open setups; the direct surface's plan and digest; the
executor refusing rows that carry the script text, a command or an
unordered plan. `immediate-repairs.test.js` gained the A-17.7 ratchet on
the callers (no NAT / DNS / init-script command and no creation map in the
routes, the plan on the launch, `fixup` on the three buttons, create-status
from the records, the MCP wait) and on the engine (contained scripts, the
mandatory checkpoint, the read-never-rerun and retry rules, both executors'
input directory).

`setup-lifecycle.test.js` (20 tests; one with a real spawn capture of the
runner's host channel; the rest over a scripted host executor and the real
executor on `node:sqlite`): the kind registry and the agreement between
`lifecycle-logic.js` and `logic.js` (both import orders load); strict
parameter validation (no command / argv / options, force only where it
applies, the launch config allowlist and value shapes, note bounds, secret
lookalikes) reaching `validateRunnerJob` and `submitRunnerJob`; the fixed
argv per kind and a refusal to render an invalid plan; identity, state
verdicts and the idempotent short-circuit; every kind end to end (the argv
issued, the state read back, the record's outcome and verification, the
lease released, `resultFromJob` keeping the job status and the guest state
apart); a start of a running guest issuing nothing; a start that exits 0
but leaves the guest Stopped failing at `verify`; a delete bound to the
confirmed identity (refused for another uuid with nothing issued; stop then
delete for the right one; the identity kept on the record; a missing guest
not found; a guest that will not stop cleanly not deleted); a create with
the allowlisted config and `--vm`, the root size a warning when the profile
refuses it, an existing name refused before launch, a failed launch's
half-created guest removed; snapshot create with the note, the legacy CLI
form, an existing name refused, snapshot delete bound to the timestamp; the
managed follow-up landing on the record and the explicit `not_applicable`
otherwise; contention at submission (live lease, stale lease, open mutating
job, duplicate) and at claim; interruption for every idempotent kind
(finished by re-reading, re-issued against the same identity, refused on a
changed identity, resumed before any command) and for restart / create
(`interrupted_uncertain`, nothing re-issued, no recovery job, the lease
kept stale so a delete is refused at submission and — for a row that
bypassed the orchestrator — at the executor, a verification follow-up
requeued and a probe deferred on the hold with the lease untouched and a
delete still refused afterwards, a stale row written when none was left,
the acknowledgement releasing exactly that lease and the next request
running) through the runner's reconcile and the backend's boot sweep; the
acknowledgement as one transaction (the event write and the outcome write
each made to fail: nothing recorded, the hold kept, a delete still refused;
a sound store landing all three together); mandatory checkpoints (SQLite rejecting the `issuing` write through
the real store and executor → nothing issued; a fenced job stopped before
the command; a handle reporting no row changed); a nonzero exit (1, 124)
with the guest still Running recorded as failed, never as restarted or
started;
cancel before the claim and after it; runner-required refusing (cancelled,
no host call) while a live runner takes the job and backend-allowed runs the
same executor in-process, with a detached snapshot kicked rather than left
for the interval; the ops layer's plan digest, HTTP mapping and refusal of
an invalid plan before any row; the MCP tools `delete_lxc_container` (the
token bound to the identity: a guest recreated under the same name cannot
be deleted with it; the job through the executor; no `incus stop|delete` in
the tool; the ledger row naming the job) and `delete_snapshot` (bound to the
timestamp; a replaced snapshot refused by the job; busy refused); and the
rendered argv reaching `hostGuestExec` as one spawn with no shell.
`immediate-repairs.test.js` carries the source ratchets for the dashboard
routes (which import the native database module and are not executed here):
every verb goes through `lifecycleViaRunner`, none of the removed shell
strings remains, both snapshot delete routes require sudo, and only the
transport group's post-import start and temp cleanup are left.

`setup-restores.test.js` (21 tests; two with real processes — the runner's
host channel — and real AES-GCM rows for the compatibility check; the
rest over scripted guest and host executors on `node:sqlite`): recovery-set
binding by record, dump format and server verdicts, compatibility from the
dump's own rows (established / not established / not applicable), snapshot
coverage, artifact revalidation and the temp-name capture; `restore_db`
end to end with the follow-up landing on the record; every refusal before
disruption (compatibility, custom format, no COPY block, missing dump,
older server, failed capture) with nothing stopped; the recovery set with
the copy's key deciding and put in force, a broken set refused at bind, the
same dump refused under the current key; retry reuse after revalidation and
a tampered artifact not reused; interruption before (resumed) and after
(recovery-required naming the restore, lease stale, recovery job, then the
application check) the stop; conflicts refused at submission and at claim;
runner-required refusing restores and the mint, handing over to a live
runner; `restore_snapshot` with argv assertions, restart, follow-up, the
non-managed explicit outcome, coverage refusal and accepted partial, a
failed incus restore keeping the pre-restore snapshot, no host channel
refused, retry reuse by name+timestamp, the legacy CLI form; `retry_secrets`
minting a real value into the guest with names only on the record, reuse on
retry without replacement; the MCP tools over a fake ctx and the real store
and executor: the token bound to the exact plan (a token for one plan
cannot confirm another), dry run, the run through the executor, busy
refused, the ledger row; and the runner's host channel with a real process
(argv only, metacharacters inert, timeout).

`setup-deploy-closeout.test.js` (14 tests here; one real-process test per
available cgroup mechanism plus one real-process refusal): the setsid() regression above on cgroup v2 and
cgroup v1 (a sentinel test fails, rather than skips silently, on a host
with no writable cgroup tree); the wrapper's refusal with no mechanism
(real process: exit 97, `CONTAINMENT:none`, the body never ran, no record
left) and on the record (a scripted guest: `containment_unavailable`, the
reap and one refused wrapper are the only calls, the lease released, a
mechanism-bearing guest deploys afterwards); supersession by what runs; an
older follow-up kept behind a newer deploy (superseded when the deploy
changed what runs, certified when the deploy failed before changing
anything); the recovery's own follow-up landing on both records; the
requeued follow-up with its not-before consumed by the
claim and a plain probe still deferred; the post-failure verification
landing on the failed record; ratchets on install.sh's and update.sh's
evidence-gated promotion, the backend's runner-required warning with no
in-process drain, the executor's revision read before the check, the
reaper's live-only count and the wrapper having no session mechanism.

`setup-deploy-finish.test.js`: the follow-up verification queued before the
deploy is finished, surviving an API restart, running exactly once and
landing on both records; the seven distinct outcomes of the application
rung with the deploy's execution status unchanged; the maintenance boundary
before the migration, protected copies as retained versions that a later
deploy does not overwrite, a migration in flight reconciled with its retry
class and its copies carried to the recovery job, a failed migration named
and never rolled back; the recorded survivor state with the lease kept (the
real-process proof moved to the closeout suite); the executor policy
(explicit values, the safe reading, the default, `.env.example`, install.sh
writing the safe default and promoting only by `sed`, update.sh's gate), runner-required queueing with no backend mutation,
backend-allowed running the same executor in-process with the follow-up
verification, a live runner taking precedence under either policy, and the
boot wiring.

`setup-deploy.test.js`: the whole operation against a scripted guest (order
of steps, the checkpoint before the stop, the mint with real values written
and only names recorded, the unit and environment written, no value in any
row or event), repeat and retry minting nothing, the bridge and the deferred
marker, the four failure paths with restart attempted, the credential
outcomes (no guard, mismatch, row security), skipped and contract-from-guest,
a surviving previous writer refused, the application-owned rung's
interpretation, submission validation and de-duplication, the runner
executing a submitted job to the result every caller reads, `waitForJob`
replaying step events, runner liveness gating the hand-over, `deployProject`
submitting with a live runner, cancel before and after the stop, the fence
mid-deploy, interruption at every checkpoint reconciled and then run, the
boot sweep leaving a runner's jobs alone, contention in both directions,
two real child-process checks (a marker-carrying script is killed and stays
dead; a job submitted by a process that exits is executed), and the
authorization ratchet.

`setup-engine.test.js` (leases, fencing, takeover, claim CAS, checkpoints,
redaction, the ladder, reconcile decisions, the boot sweep, the container
lock's persistent backing) and `setup-runner.test.js` (probe scripts and
parsers, the credential verdict with real AES-GCM rows under the
component's cipher, the ladder from observations, a recovery executed
against a scripted guest, the four recovery-required outcomes, deferral on a
live foreign lease, takeover of a dead one, the fence mid-run, reconcile of
dead backend and runner jobs, the serve loop, the command, the exec wrapper,
the unit and install wiring). Both against `node:sqlite`.

## Host acceptance (not yet run)

For the configuration group (A-17.8, platform ledger HA-11): on a
`runner-required` host, `set_lxc_config` (`security.nesting=true`,
`confirm: true`) on a running guest — the job owned by `runner@…`, the
snapshot `pp-mcp-pre-security_nesting-<stamp>` in `incus snapshot list`
with the `created_at` the job recorded, `incus config get` reading `true`,
`restart_required: true` on the result; the same call again reporting
`nothing was issued` with no new snapshot; `set_lxc_config` with
`security.privileged=true` refused without `acknowledge_risk` at the tool
and — a hand-made row without `acknowledgeRisk` — at the runner; the
dashboard's Resize dialog changing CPU and memory with `jobId` on the
answer and no snapshot; `set_lxc_network` reserve-current and the
reservation in `incus config device get <name> eth0 ipv4.address`;
`add_lxc_device` with a disk under `/srv/shares` mounted in the guest and
refused for `/etc`; `remove_lxc_device` with `previous` on the result;
`set_port_forward` add of a UDP range: the `ppl4-<id>` device, the
`service-l4-<id>` rule in `proxypilot firewall list`, the drop-in
`/etc/sysctl.d/99-proxypilot-l4-reserved.conf` carrying the range and
`sysctl net.ipv4.ip_local_reserved_ports` agreeing, the remove clearing all
three; `set_lxc_egress` allow / deny reflected in `proxypilot firewall
egress list` and the nftables ruleset — and, with `proxypilot firewall`
in a rejecting state (a lockout the dry-run reports), an allow that ends
`failed at reconcile` with the entry saved in `firewall.json`, the
ruleset unchanged (`nft list table inet proxypilot`) and a retry after the
cause is fixed applying it with one reconcile; `set_port_forward` add
with the guest busy (a deploy running) refused with NO row in
`service_l4_forwards` and nothing on the host; two forwards submitted at once (two
MCP calls) serialized on `@host/firewall` (the second's job waiting, both
applied); the runner killed during a `set_lxc_resources` after its first
key — the restarted runner's record reading `resumed after an interrupted
attempt` with the snapshot `(reused)` and only the remaining key issued
(`journalctl -u proxypilot-setup-runner`); a Stop refused (409) while a
configuration job runs; with the runner stopped, `set_lxc_config` refused
(`runner_unavailable`) and `incus config get` unchanged; no line of any
job row, event or the runner's journal carrying a guest's `user.*` value.

For the post-launch group (A-17.7, platform ledger HA-10): on a
`runner-required` host, create a container from the dashboard with an init
script (one that installs a package and echoes a marker) and two services;
confirm the create job is owned by `runner@…` and carries `setup_job_id`,
the setup job shows the five phases `done` / `done` / `done` / `done` /
`done` with the address `incus list` shows, `/etc/resolv.conf` in the guest
carries the resolvers, `/var/log/pp-init-<job>.rc` reads `0` and `.log` the
marker, `<data>/db/setup-inputs/` holds no file for it afterwards, the
routes are in `service_http_routes` and Caddy serves them, and neither the
job rows, the events nor the runner's journal contain a line of the
script; close the browser during the init script and restart the backend
container: the create-status poll after the restart shows `init-script`
then `ready`; kill the runner during the init script and confirm the
restarted runner's record reads `resumed: true` with the exit the guest
recorded (or `init_uncertain` naming the log when the script died with
it), that the script did NOT run twice (the marker appears once in the
log) — and when the script is still running, that the record reads
`init_uncertain` with its pid, that Stop / Delete are refused (409) and
MCP's `delete_lxc_container` too, that `POST /api/setup/jobs/:id/acknowledge`
without `writerStopped` is refused, and that after the job's scope or
cgroup is empty the acknowledgement with `writerStopped: true` releases
the guest and a Stop runs; run an init script that daemonises a writer
with `setsid` and let it time out, and confirm the record reads
`timed_out` / `killed: gone` only when `systemctl status
mock2-deploy-<job>-*.scope` (or the job's cgroup) shows nothing left, that
the writer is gone with it, and that on a guest with no systemd the raw
cgroup form does the same; that `/var/log/pp-init-<job>.log` is mode 0600 in the guest and its
content appears in no job row, event or create-status answer; retry
that setup from `/api/setup/jobs/:id/retry` and confirm NAT and DNS run
again and the init phase reads `skipped` / `notRepeated`; create a guest
with an init script that exits 1 and confirm the toast names the exit code,
the guest is running and usable; create with a service whose domain is
already routed to another guest and confirm the conflict is reported and
the other route untouched; create two guests at once and confirm the runner
serialises their NAT phases on `@host/network` (one `lock_takeover` or
wait event at most, never interleaved iptables writes) and the backend
serialises their route renders on `@host/routes`; start, restart and
reboot a guest from the dashboard and confirm each answer carries
`setupJobId` and the fix-up job ran NAT + DNS in the runner; over MCP,
`create_lxc_container` and confirm the result carries `setup_job_id` and
`primary_address` from the setup record within the minute; stop the runner
and confirm a create is refused (503) before any launch; on a guest with no
containment mechanism confirm the DNS and init phases read `refused` /
`containment_unavailable` and the guest is still created and running.

For the lifecycle group (A-17.2 … A-17.6, platform ledger HA-09): on a
`runner-required` host, start, stop, restart and reboot a guest from the
dashboard and confirm each job is owned by `runner@…`, the button's answer
carries the `jobId`, and `incus list` agrees with the recorded
`instanceState`; click Start on a running guest and confirm the record says
nothing was issued; create a container and a VM from the dashboard (with
Docker support on the container) and confirm the guest's config carries
exactly the allowlisted keys, the VM's root size, and the init script and
routes still run after the job; create with an image that does not exist
and confirm the half-created guest is gone and the create-status shows the
job's reason; take a snapshot with a note from the dialog and confirm the
progress poll ends `done`, the note is on the snapshot and
`snapshot_durations` gained a row; delete a snapshot from the dashboard and
confirm the sudo prompt, then the job; over MCP, `delete_lxc_container`
dry-run, recreate the guest under the same name, present the first token
and confirm the "different target" refusal, then delete with a fresh token
and confirm the export, the job and the ledger row; kill the runner between
a delete's stop and its delete and confirm the restarted runner resumes the
job and the guest is gone; kill it during a restart and confirm the record
reads `interrupted_uncertain`, the guest is Running, nothing was
re-issued and a Stop from the dashboard is refused (409) until the job is
acknowledged, after which it runs; stop the runner and confirm a start is refused (503, job
`cancelled` / `runner_unavailable`) rather than queued; on a legacy Incus
client confirm the snapshot create still lands.

For this slice's corrections: on a runner-required host, kill the runner
between the stop and the start of a deploy of an app with an LDAPS
credential and confirm the restarted runner recovers it and the deploy
record ends `credential_use_verified` (not merely serving); stop the runner
unit, submit a deploy and confirm the job is queued with no backend
execution, then start the runner and confirm it runs; start a deploy and
kill the guest-side `npm` tree's session leader mid-build, confirm the next
deploy's reap kills the surviving children through their scope's cgroup and
the app service is untouched; in the guest, start a detached writer from a
deploy script (`setsid sh -c 'while :; do date >> /tmp/w; sleep 1; done' &`)
and confirm the next deploy's reap stops it and `journalctl` shows the
`systemctl kill` of the `mock2-deploy-<job>-*` scope, with the mock2-dev
service untouched (the systemd-scope mechanism is the one the sandbox
cannot exercise). Two further containment checks that must be kept apart:
(a) **raw-cgroup fallback works** — in a guest where `systemd-run` cannot
start a scope (mask `dbus` or run the deploy from a chroot without a
systemd bus) but the cgroup tree is writable, the deploy proceeds and the
job's `containment` event and `recovery.containment.kind` read `cgroup2`
(or `cgroup1`), and the setsid writer above is still reaped; this is a
supported mechanism, not degraded containment; (b) **no mechanism at all**
— only with systemd unusable *and* the cgroup roots unwritable (e.g. an
unprivileged guest whose cgroup tree is read-only) the deploy must end
`recovery_required` / `containment_unavailable` with the reap and one
refused wrapper as its only guest calls. Masking systemd alone is check
(a), never (b). For the policy: on a fresh install confirm `.env` reads
`runner-required` only after `systemctl is-active proxypilot-setup-runner`
is true; re-run `install.sh` on that installation with the runner unit
masked and confirm `.env` still reads `runner-required` and the error names
the requirement; mask the unit before `update.sh` and confirm the policy is
unchanged with the red warning printed; confirm `/var/backups/proxypilot-db/app-pre-deploy-<job>.sql`
and the `.pre-<job>` copies exist after a deploy and `restore_project_db`
accepts the dump by name.

For the restores (A-13…A-15): on a `runner-required` host with an LDAPS
app, `dump_project_db`, change a setting, `restore_project_db` the dump
and confirm the job record reads `restored` with the compatibility event
`current_configuration`, the app is serving and the follow-up ends
`credential_use_verified`; deploy twice, then `restore_project_db` the
first deploy's `app-pre-deploy-<job>.sql` **without** `environment_copy`
and confirm the refusal at `compatibility` names the rows that do not
decrypt, then with `environment_copy: environment.pre-<job>` and confirm
the restore succeeds, `/etc/environment` is the copy, and the follow-up
verifies; rename the dump and confirm the bind refusal; put a `PGDMP`
archive under a dump name and confirm the format refusal; kill the runner
between the stop and the start and confirm the record reads
`interrupted_after_stop` with the restore named and the recovery brings
the app up; attach a custom volume to a guest and confirm
`restore_snapshot` refuses, then succeeds with `accept_partial` reporting
`complete: false`; confirm the pre-restore snapshot exists with the
recorded timestamp and a retry reuses it; on an Incus client with the
legacy `snapshot` verb confirm the pre-restore snapshot is still taken;
stop the runner and confirm a restore is refused (job `cancelled` /
`runner_unavailable`), not queued.

For the deploy: with the runner unit live, deploy a project from the
dashboard and confirm the job is owned by `runner@…`, the runner's journal
shows the steps, the cycle's chat shows the same labels, and the app serves;
close the browser and restart the backend container mid-deploy and confirm
the job completes and the dashboard shows it; kill the runner between the
stop and the start and confirm the restarted runner reconciles (recovery job,
app up, `credential_use_verified` recorded by the backend on the next
deploy); request a cancel before and after the stop and confirm the recorded
outcomes; stop the runner unit entirely and confirm a deploy runs in-process
with owner `backend@…`.

On a real installation: install the unit and confirm `systemctl status
proxypilot-setup-runner` is active; start a deploy and kill the backend
container between its stop and its start; confirm the runner's journal shows
the reconcile and the recovery, the app is serving again, the LDAPS settings
decrypt the credential, `GET /api/setup/jobs` shows the dead deploy as
`recovery_required` with a `recovery_result` event and the recovery job as
`succeeded` / `credential_verified`; then confirm a new deploy is accepted.
Also: request `restore_project_db` through MCP during a deploy and confirm
the refusal names the holder; restart the backend with nothing running and
confirm the sweep queues nothing.


## G3 — guided ProxyPilot SSO and independent recovery

After G2 verification, Platform Setup offers dedicated-client configuration,
Keycloak passkey enrollment, explicit local-account linking, SSO/sudo tests,
a separate-browser local recovery check and explicit activation. This applies to
fresh and existing installations. Follow [the G3 operator guide](guided-sso.md)
for Keycloak 26.7.4 client/policy settings, protected credentials, local-only role
mapping, the 60-second central revocation/outage contract and offline disable.

`verify_sso` and `configure_recovery_route` use this existing backend drain and its
job/app/route leases, fencing and restart reconciliation. Save/open do not execute
jobs. Results and prerequisites are bound to the saved configuration fingerprint.
The recovery route uses existing Caddy source-IP controls; no VPN or new recovery
command is introduced. Live-host limitations and evidence remain in the G3 ledger.


## G4 — guided Pomerium and selected application routes

Platform Setup now adds a separate Pomerium guide after verified G2/G3 identity.
The host runner executes `pomerium_apply`; recorded `configure_pomerium_routes`
children use the existing backend drain and `@host/routes` lock. Both configurations
come from the saved route intent. Initial denial precedes Core startup, probes
precede the protected label, failures retain gateway/denial, and removal needs a
separate explicit review. Existing native login, recovery and machine routes
stay outside Core. Follow [the G4 operator guide](guided-pomerium.md) for the
supported private profile, external handoff, session timing, retries and existing
backup references. [G4 evidence](../evidence/g4-acceptance.md) separates scripted
host checks from real HTTP/crypto/browser execution and the unperformed real
three-service/host acceptance. G4 is accepted at corrected head `6c3bdcb`
(PR #616); accepted progress is **40% (4/10)**. Deployment has not been performed;
the recorded integration and host checks remain outstanding. No installer/updater,
A-17, Phase F or G5–G10 work.


## G5 — guided Infisical and Agent Proxy

Platform Setup independently selects Infisical and Agent Proxy install/connect/
skip, saves inert plans and reviewed immutable test targets, protects identity
credentials, shows the administrator handoff and exact scoped policies, and
queues explicit apply/retry. `infisical_apply` runs in the existing host runner;
`configure_infisical_route` uses the existing backend drain/Caddy locks. Progress,
failed handoffs and configuration-bound verification survive browser/API/runner
restart. Existing external resources and all current application credentials are
preserved. Agent Proxy is separate from the secret-rendering Infisical Agent.

Follow [the G5 operator guide](guided-infisical.md) for release/edition limits,
first-administrator and identity handoffs, the one disposable application secret,
proxy placeholder/denial flow, VM boundary and matching data/key backup references.
[Current reconstruction evidence](../evidence/g5-acceptance.md) distinguishes actual
CLI/HTTP/Python/SQLite/browser execution from scripted Docker/Incus/Caddy and
Infisical responses. Full-stack host acceptance and G4 runtime limits stay separate.

G5 was accepted at unavailable `a436546`: **50% (5/10)**. Its reconstructed tree
has a new identity, preserves all 24 supplied source/test files unchanged and
requires current verification. Recovery is submitted for review, not merged or
deployed. No G6–G10, credential migration, installer/update changes or new restore
framework is included.

## G6 — guided OpenBao

The accepted G5 recovery is `31d0c87b2b1fd4e00c24773e6ae0435e387c70a3`, merged
by #617 as `e9430a2314c881c23fbecc74c25acf8ac62661c2`. G6 builds from that main.
The [OpenBao guide](guided-openbao.md) covers install/connect/skip, reviewed
PGP initialization and separate recovery handoff, manual unseal, dedicated
Keycloak/group access, preserved AppRole references and one selected disposable
PostgreSQL credential flow. Migration 1007 and `openbao_apply`,
`configure_openbao_route`, `openbao_operator` reuse the existing store, runner,
leases and route render. Transient operator inputs are not queued or replayed.
A sealed/unavailable service never appears currently verified. Lost handoff after
initialization requires recovery without data reset. No new backup framework,
installer/updater change, G7–G10, A-17 continuation or Phase F is included.
G6 is accepted at corrected head `6e48d89`, PR #618. Accepted guided progress
is **60% (6/10)**; runtime validation limits remain separate in
[the evidence](../evidence/g6-acceptance.md).


G6 review correction: before `setup-runner serve` or `once` opens the queue, it
loads and validates the existing installation `TOTP_ENCRYPTION_KEY` using the
resolved `.env`/`--env`. It never generates or rotates that key; missing,
malformed or conflicting keys leave jobs unclaimed. Status and reconciliation remain available. A fresh-process regression covers the real
command/executor without an inherited fixture key; see the G6 evidence record.


## G7 — guided Vaultwarden (review pending)

G6's accepted head `6e48d89` is included in main `24ba567e` after PR #618.
G7 adds the [Vaultwarden guide](guided-vaultwarden.md): reviewed install/connect/
skip, an inert save and explicit apply, a private independent persistent SQLite
service, and read-only connection to an existing 1.37.3 instance. The dedicated
Keycloak client handoff verifies exact callbacks, PKCE, role denial and the
accepted passkey policy without changing other clients. Effective Vaultwarden
configuration is read back including persisted overrides; client/admin credentials
use the existing protected references and are preserved on retry.

Migration 1008, `vaultwarden_apply` and `configure_vaultwarden_route` use the
existing saved plans, host runner, backend drain and Caddy locks. Retry does not
replace missing data, server keys or attempted resources. The accepted G6 runner
key-loading correction remains unchanged. Browser/API/runner process checks and
configuration-bound verification are covered in [G7 evidence](../evidence/g7-acceptance.md).

Keycloak authentication is separate from vault unlock. The UI records explicitly
operator-observed disposable browser SSO/unlock/item/denial/account-preservation
checks, with no master password, recovery code or item content accepted.
SSO-only stays off. Recovery guidance covers the matching database, attachments,
configuration and signing keys through existing mechanisms; real restore remains
separate host acceptance. Actual Vaultwarden/Keycloak ceremony and Caddy runtime
were unavailable here and are not claimed as passes.

Accepted progress stays **60% (6/10)** until G7 review acceptance, then **70%**.
No G8–G10, migration/import, A-17, Phase F, installer/updater/U1/U2 change or live
operation is included. This slice stops after G7.
