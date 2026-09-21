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
| restart, create | **never replayed**: the record ends `recovery_required` / `interrupted_uncertain` naming the check (`incus list <name> --format json`), no recovery job is queued (a generic guest has no application to recover), and the guest's lease is **kept stale**, pointing at that record: every exclusive operation on the guest is refused with the condition — at submission, and at the executor for a row that arrived any other way — until an operator has looked and acknowledged the job (`POST /api/setup/jobs/:id/acknowledge`, sudo), which records who and when on the job and releases exactly that lease | resumed and run |

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
(a restore, a lifecycle verb): only a recovery or a verification may.

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
platform ledger): the post-start fix-ups `ensureNetworkNat` / `ensureDns`
and the create route's post-launch configuration (IP wait, DNS, the init
script through `incus exec`, the routes); the guest configuration verbs
(`resize`, `set_lxc_config`, `set_lxc_resources`, `set_lxc_network`,
devices, port forwards) and the pre-mutation `takeLxcSnapshot` they lean
on; rename, clone, import / export and their post-import start, the
zip-import start and cleanup, the prepared-download and S3-export temp
instances; the project provisioning launch / delete and the idle sweep's
stop / start (`mock2/provision.js`, `lib/project-lifecycle.js`); the
component pre-install, Caddy, storage, migration transports, the workspace
terminal, and every read (`incus list`, `info`, `query`, usage, logs).

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
already says `runner-required`, because every deploy is then queueing. At
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
and enabled by `install.sh` and `update.sh` right after the CLI wrapper
(`install_setup_runner`).

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
| `POST /api/setup/jobs/:id/acknowledge` (sudo) | an operator has inspected the guest a restart or create left in an unknown state (`recovery_required` / `interrupted_uncertain`): records who and when on the job and releases the stale lease that records it; refused for any other job |

Admin only, behind the global CSRF check and a fresh sudo grant, audited
(`SETUP_DEPLOY_REQUESTED`, `SETUP_JOB_CANCEL_REQUESTED`,
`SETUP_RECOVERY_REQUESTED`, `SETUP_JOB_RETRIED`). The existing
`POST /api/mock2/projects/:id/deploy` keeps its synchronous contract and now
returns the `jobId`. MCP
tools for the same three verbs are listed as remaining work in the ledger;
the lock itself already binds every MCP mutation that goes through
`withContainerLock`.

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
- What it did NOT remove: the container still has `privileged: true`,
  `pid: host` and the Docker socket, and every other feature (the guest
  configuration verbs and their pre-mutation snapshots, rename / clone /
  import / export and the transports' temp instances, the create route's
  post-launch configuration and the post-start NAT / DNS fix-ups, project
  provisioning and the idle sweep, the component pre-install, Caddy,
  storage, migration, the workspace terminal, every read) still pivots
  through it. Dropping that reach is Phase F of
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
bypassed the orchestrator — at the executor, a stale row written when none
was left, the acknowledgement releasing exactly that lease and the next
request running) through the runner's reconcile and the backend's boot
sweep; mandatory checkpoints (SQLite rejecting the `issuing` write through
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
