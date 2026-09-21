# Setup engine: persistent locks, saved jobs, and the independent host runner

Gate two's foundation (`docs/core/setup-engine-requirements.md` R1, R2, R4).
Every platform operation that changes what a guest runs or stores — today
the deploy, the project database restore, the container snapshot restore
and the retry path's secret mint; later the credential migration and the
guided setup — holds one **persistent lease per app**, records itself as a
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
reap every session another job left in the guest and confirm none survive →
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
`reapStaleWritersScript`). The lease expiring is not proof the previous
writer's guest commands stopped, and a marker on the parent shell says
nothing about the children it spawned. So every script the deploy runs in
the guest is wrapped: it runs as its **own session** (`setsid`) under the
job's id, and the session id is recorded in `/run/mock2-deploy/<job>.sid`.
Everything that script spawns — `npm`'s children, a build's helpers, an
unmarked background process it left behind — shares that session id. Before
a deploy or a recovery touches the guest (after it holds the lease), the
executor kills every session recorded by **another** job (`pkill -9 -s`),
then the legacy marker scripts that carry no job id, waits, and counts live
survivors (zombies awaiting reap do not count); it tries once more and, if
any remain, ends the job as `recovery_required` (`previous_writer_alive`)
with the **lease kept and flagged stale**, so every conflicting operation is
refused with that reason until the survivors are gone — nothing is silently
cleared. The current job's own sessions and everything outside these
sessions are untouched; the application's service runs in systemd's own
cgroup and session and is never a target. The suite proves this with real
processes: a contained marked shell spawns an unmarked child that outlives
it and keeps writing; the reap by session kills it, the file stops growing,
and a legitimate current holder's session survives. Limit: a process that
calls `setsid` itself (a double-forking daemon) leaves the session and is
outside this containment; the writer inventory in
`docs/features/immediate-repairs.md` still applies to operator shells.

## Who executes: the installation policy

`SETUP_EXECUTOR_POLICY` in the installation's `.env` — read by the backend
at boot (`logic.js executorPolicy`), never from a request:

| Policy | No live runner | Live runner |
| --- | --- | --- |
| `runner-required` (written by `install.sh` and retro-fitted once by `update.sh` after the unit is installed) | the submission is **queued** and reported unavailable (`step: runner_unavailable`, HTTP 202 with a warning on the submission endpoint); nothing runs in the backend | the runner executes |
| `backend-allowed` (the legacy / development executor; the default when the variable is absent, i.e. a checkout with no `.env`) | the backend claims and executes queued runner jobs in its own process — on submission, on boot and every 30 s — with the **same** executor, record and locks; owner `backend@…` | the runner executes (a live runner always wins) |

An unknown value reads as `runner-required` (the safe reading). No request
parameter, header or MCP argument can enable the in-process executor: the
`deployProject` adapter ignores anything of the kind and decides from the
store's environment only. The two modes share `lib/setup-engine/executor.js`
and the container lock; a restore submitted while either executor holds
the app is refused the same way.

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
- What the deployment slice REMOVED from the container's path: on a
  `runner-required` host (every install.sh / update.sh installation from
  this version on), the deploy's guest commands, the secret mint, the unit
  swap, the recovery and every verification — the application-owned
  credential check included — never run in the backend container: they run
  in the runner, and with no runner they wait. Only a `backend-allowed`
  installation keeps the in-process executor and its nsenter pivot for
  these operations.
- What it did NOT remove: the container still has `privileged: true`,
  `pid: host` and the Docker socket, and every other feature (Incus
  lifecycle, Caddy, storage, migration, restores, the retry-path mint, the
  workspace terminal) still pivots through it. Dropping that reach is
  Phase F of `docs/features/security-completion/master-spec.md`; this
  slice reduces what depends on it by one operation, and does not claim
  more.
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

## Tests

`setup-deploy-finish.test.js`: the follow-up verification queued before the
deploy is finished, surviving an API restart, running exactly once and
landing on both records; the seven distinct outcomes of the application
rung with the deploy's execution status unchanged; the maintenance boundary
before the migration, protected copies as retained versions that a later
deploy does not overwrite, a migration in flight reconciled with its retry
class and its copies carried to the recovery job, a failed migration named
and never rolled back; real-process containment (an unmarked child that
outlives its marked parent is killed by session while a legitimate holder
survives) and the recorded survivor state with the lease kept; the executor
policy (explicit values, the safe reading, the default, `.env.example`,
install.sh, update.sh), runner-required queueing with no backend mutation,
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

For this slice's corrections: on a runner-required host, kill the runner
between the stop and the start of a deploy of an app with an LDAPS
credential and confirm the restarted runner recovers it and the deploy
record ends `credential_use_verified` (not merely serving); stop the runner
unit, submit a deploy and confirm the job is queued with no backend
execution, then start the runner and confirm it runs; start a deploy and
kill the guest-side `npm` tree's session leader mid-build, confirm the next
deploy's reap kills the surviving children by session and the app service
is untouched; confirm `/var/backups/proxypilot-db/app-pre-deploy-<job>.sql`
and the `.pre-<job>` copies exist after a deploy and `restore_project_db`
accepts the dump by name.

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
