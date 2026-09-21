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
| `credential_use_verified` | the **application** read its protected credential back through its own code path: the backend signs in as the review account and reads `/api/admin/ldaps` — `masterKey` current or rekeyed, inventory complete. Recorded on the job after it finishes (`verification.rungs.credential_use_verified`), by `backend`, without the login ever entering a job row. Nothing stored → unverified, by name |
| `recovery_required` | a rung failed; the record names which and the procedure |

A rung that was not checked caps the state and the next step says why (for
example *credential verified was not checked: no data guard recorded*). A
deferred operation finishes as `deferred`, never `succeeded`.

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

The application deploy is ONE operation, `lib/setup-engine/deploy-op.js`:
reap any previous writer's scripts and confirm none survive → install /
migrate / build (install skipped on an unchanged manifest) → the e2e browser
and the PWA build stamp (best effort) → **checkpoint** (`stopping_app`,
`app_stopped: true`) → stop the unit and free the port → mint the installed
components' owned secrets under the gate-one rules (source and built-artifact
markers, the data probe as the app's role, never overwrite, defer and say
why) → validate the environment → write the unit, start → health (45 polls)
→ verify (application health, then the stored credential under the
configured key). It runs over an injected guest executor, so the same code
executes in two places and there is no second implementation:

| Executor | When | Owner recorded |
| --- | --- | --- |
| The host runner (`proxypilot setup-runner serve`) | a runner has a heartbeat younger than 30 s in `setup_runners` (migration 1001) | `runner@…` |
| The backend, in-process (nsenter pivot) | no live runner — a development checkout, or a host before `update.sh` installed the unit | `backend@…` |

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
| `starting`, `install`, `migrate`, `build`, `build_done` | nothing disruptive yet | **resume**: requeued and run again from the start (steps are idempotent; minted keys are reused) |
| `stopping_app`, `secrets_minted`, `unit_written` | the app is stopped | **recover**: `recovery_required` on the dead job, a `recover_app` queued with the references (port, unit, environment file, the guard, the generated key names), the lease kept and flagged stale |
| `app_started` | the new unit runs; verification unfinished | **verify**: a `verify_app` queued; the dead job records `interrupted_unverified` with its recovery references kept |
| `verified` | done bar the record | interrupted, lease released |

`checkpoint.recovery` (unit path, environment file, contract commands, guard,
generated key names, build id) is written at the start and never cleared;
`app_stopped` is the only flag that flips. Nothing rolls an environment key
back on its own — the recovery procedure for a credential mismatch says to
restore the recovery set together.

**Cancel** (`POST /api/setup/jobs/:id/cancel`): a queued job is cancelled
outright; a running deploy is cancelled at its next safe checkpoint — any
fence before the stop — and nothing has changed in the guest but its build
outputs; a cancel that arrives after the stop is not honoured mid-way: the
deploy finishes bringing the app up and records `cancel_declined`.

**Before takeover.** The lease expiring is not proof the previous writer's
guest commands stopped. Every deploy script carries `mock2_deploy_marker`;
the runner (for a deploy and for a recovery) and the operation itself run
`pkill -9 -f` on the marker, wait, count survivors with `pgrep`, try once
more, and **refuse** (`PREVIOUS_WRITER_ALIVE`) if any remain — a job that
starts never races a script it could not stop. This is containment for
guest-side scripts; a dead backend's nsenter parent has no further effect
once its guest script is gone. The suite kills a real marker-carrying child
process with the same script.

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
- What this slice REMOVED from the container's path: on a host with the
  runner unit installed and live, the deploy's guest commands, the secret
  mint and the unit swap no longer run under the backend container's
  nsenter pivot — they run in the runner. The fallback executor keeps the
  pivot only where no runner exists.
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
