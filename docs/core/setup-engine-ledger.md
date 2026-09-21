# Setup engine — milestone ledger (gate two)

The platform-wide checklist (milestones A–D, host acceptance, review
decisions) is `docs/core/platform-delivery-ledger.md`; this file is the
detailed evidence it links for the setup engine.

The repository checklist for the work `docs/core/setup-engine-requirements.md`
records: what is done, what is in progress, what remains, and the estimate
each slice moves. Estimates are milestone completion, not test-pass ratios
and not deployment readiness. Requirements text alone never completes a
milestone; a slice counts when its code and executable tests are in the
tree. Live-host acceptance is tracked separately and is never folded into a
code percentage.

Starting point (carried in from the gate-one handoff): gate-one code 100 %
of its agreed scope; recovery + runner + persistent engine 5–10 %; guided
frontend wizard 0 %; new service / identity integrations 0 %; platform-aware
app provisioning 0–5 %; overall new platform repository work ≈ 20 %.

## Milestone A — recovery, independent runner, persistent engine

| # | Deliverable | State | Where |
| --- | --- | --- | --- |
| A1 | Non-destructive root recovery command: one local administrator, data and keys untouched, sessions / sudo / trusted devices revoked, audit without secrets, root-only, no secret on argv, works with the dashboard and any IdP down | **done** (host acceptance pending) | `cli/src/recovery/{install,plan,password}.js`, `cli/src/commands/recover.js`, `reset.sh` (delegates), `root-recovery.test.js`, `docs/features/root-recovery.md` |
| A1a | Defect found by A1 and closed: the public initial-setup endpoint could claim a directory-backed administrator (empty hash by design) | **done**; independently identifiable for review or backport: `git show d16b3e7 -- admin/backend/src/routes/auth.js` is the whole fix (two queries gain `AND (auth_source IS NULL OR auth_source = 'local')`), and the executed-SQL test is the last block of `root-recovery.test.js` | `routes/auth.js` (`setup-status`, `initial-setup` now local-only) |
| A2 | Independent host runner: narrow validated operations, authenticated local exchange, privileged execution and service-admin credentials outside the browser-facing API; install/update wiring and service definitions | **done** for recovery / verification AND for the application deploy: `proxypilot setup-runner serve` as a root systemd service; four job kinds (`deploy`, `recover_app`, `verify_app`, `probe`) with validated parameters; a deploy's guest commands are the app's own contract, server-resolved, never a host command; runner heartbeats (migration 1001) decide who executes; installed and enabled by `install.sh` / `update.sh` | `cli/src/setup-runner/{probes,runner}.js`, `cli/src/commands/setup-runner.js`, `deploy/proxypilot-setup-runner.service`, `lib/setup-engine/deploy-op.js`, `setup-runner.test.js`, `setup-deploy.test.js` |
| A3 | Persistent job records: identity, approved plan, progress, checkpoints, recoverable configuration references saved before disruptive actions; no secret values in job rows or logs | **done** for the operations the backend executes (deploy, both restores, the retry mint): `setup_jobs` + `setup_job_events` (migration 1000), the deploy's checkpoint is written BEFORE it stops the app and cleared when the new unit serves; every row and event is redacted on write | `lib/setup-engine/{logic,store}.js`, `mock2/container-lock.js`, `mock2/deploy.js`, `setup-engine.test.js` |
| A4 | Shared persistent lock per app across deploy, secret-rewriting retry, DB restore, snapshot restore, credential migration; enforced server-side for UI, CLI, MCP; survives backend restart; dead holder is a recorded condition, never a free lock | **done**: `setup_locks` leases (30 s, renewed every 10 s) taken by `withContainerLock` for every holder above; a live foreign lease refuses (`ContainerBusyError`), a dead holder's lease refuses with the recorded condition (`ContainerLockStaleError`) and is never taken silently; credential migration will take the same lock when it exists (milestone C) | same files; both MCP restore tools report the stale condition |
| A5 | Restart / reboot reconciliation: saved state vs actual state, safe resume or recorded recovery-required; stale workers cannot change a target after ownership moved; retry reuses generated secrets and resources | **done**: the runner reconciles on start and every minute (a dead backend's stopped app → recovery job + stale kept lease; a dead runner's resumable job → requeued; anything else → interrupted and released), takes a stale lease over with an epoch bump, stops on a fenced heartbeat mid-run, and executes the queued recovery; the backend's boot sweep records the same conditions when it comes back first; `retryPlan` carries `reuse` | `cli/src/setup-runner/runner.js`, `lib/setup-engine/backend.js` |
| A6 | Verification states: configured / port responding / application healthy / credential verified / recovery required, never conflated; deferral is an explicit sanitized outcome; gate-one probe safeguards retained | **done**: the runner's probes populate the ladder from the guest (unit, port, health, and the gate-one data probe + classifier for the credential — same role, protected password file, row-security check); a port answering is recorded as `port_responding`, never healthy; a missing guard defers the credential rung by name; every job outcome is one of succeeded / failed / deferred / refused / recovery_required | `cli/src/setup-runner/probes.js`, `lib/setup-engine/logic.js` |
| A2a | Runner-owned deployment: ONE deploy operation (`deploy-op.js`) executed by the runner when live, else in-process by the backend under the same persistent record; every caller (build cycle, connect, provision, rehydrate, REST, `promote_release`, `redeploy_project`) submits and observes the job through `deployProject`; checkpoints before the stop and after the start with recovery references that outlive the stopped-app marker; interruption at every checkpoint reconciled to resume / recover / verify; cancel at a safe checkpoint, declined after the stop; a previous writer's guest scripts reaped and counted before any takeover; retry and repeat mint nothing new | **done** | `lib/setup-engine/deploy-op.js`, `mock2/deploy.js`, `routes/setup.js`, `setup-deploy.test.js`, `docs/features/setup-engine.md` § "The deploy" |
| A2c | Deployment slice corrections: (1) the application-owned credential check is a durable `verify_app` follow-up queued before the deploy reports done, with six distinct outcomes, run once by whichever executor is live, landing on both records — execution status and verification status are separate; (2) the maintenance boundary sits before the migration, protected copies (dump in the restore directory, unit and env copies, commit, migration retry class) are retained versions on the record, a migration in flight is reconciled with its retry class, a failed one is named and never rolled back; (3) containment of stale writers with the lease kept and refusal on survivors (the mechanism was sessions in this row's first version; A2d replaced it with job cgroups); (4) `SETUP_EXECUTOR_POLICY` (`runner-required` written by install/update; `backend-allowed` the legacy/development default) decides who executes — never a request parameter — and the backend's in-process mode runs the same executor | **done** | `lib/setup-engine/{executor,deploy-op,guest-probes,logic,backend}.js`, `mock2/deploy.js`, `cli/src/setup-runner/{runner,review-login}.js`, `install.sh`, `update.sh`, `.env.example`, `setup-deploy-finish.test.js` |
| A2d | Closeout of the deployment slice: (1) containment is by **job cgroup** — a systemd transient scope on a systemd guest, else a raw cgroup v2 (`cgroup.kill`) or v1 `pids` group — so a child that `setsid()`s away is still reaped; a guest with no mechanism makes the deploy **refuse** (`containment_unavailable`, nothing run, lease released) instead of falling back; the real-process regression (setsid child outliving its parent, killed by the takeover; a process outside any job group and the current job's holder untouched) runs on every raw mechanism the host offers; (2) a follow-up verifies only the revision it was queued for (`superseded` otherwise, decided at run time by reading the guest's commit/build id; an older follow-up behind a newer deploy is kept, never cancelled, and still certifies its revision when that deploy failed before changing anything); a follow-up meeting a held lease is requeued with a not-before, never finished deferred; a deploy failing after the stop queues a post-failure verification; a successful recovery queues the application-owned check the interrupted deploy never reached, landing on both records; (3) `install.sh` / `update.sh` set `runner-required` only after the unit is active and the runner opened the database, say so loudly otherwise, and never downgrade an existing `runner-required` line (install.sh re-run preserves the value like a secret); the backend warns every five minutes under `runner-required` with no heartbeat and never drains in-process; (4) the operator table of recorded conditions and recovery steps | **done** | `lib/setup-engine/{guest-probes,deploy-op,executor,store,backend}.js`, `index.js`, `install.sh`, `update.sh`, `setup-deploy-closeout.test.js`, `__tests__/helpers/scripted-guest.js`, `docs/features/setup-engine.md` § "Containment", § "Operating it" |
| A2b | Verification rungs split: `credential_decryptable` (classifier) is distinct from `credential_use_verified` (the application reads its credential back through `/api/admin/ldaps` as the review account; recorded by the backend after the job, login never in a job row); nothing stored → unverified by name | **done** | `lib/setup-engine/logic.js`, `mock2/deploy.js` `verifyCredentialUse` |
| A7 | Privilege-separation inventory: what the backend container can still do directly (privileged, `pid: host`, Docker socket, `nsenter -t 1`) and what moves behind the runner | **recorded** below and in `docs/features/setup-engine.md`; the reach itself is unchanged (Phase F of the security master-spec remains) | |

**Deployment slice: complete in code — 100 % of its agreed scope** (the
four review issues closed: durable verification, migration-aware
checkpoints, containment, the explicit executor policy; the closeout
replaced session containment with job cgroups, made verification
revision-bound and made the policy promotion evidence-gated). Its
live-host acceptance is outstanding and listed below; **deployment
readiness is not claimed** until that table is run.

**Milestone A estimate: ≈ 80 %** (from 78 % after the deployment
corrections). Basis: the deploy path is complete in code and its
containment no longer carries a known hole; what keeps the milestone short
of complete is unchanged in kind — the restore operations and the
retry-path mint as runner jobs (the next slice), the remaining host
operations still on the container's pivot, and Phase F — and each stays
separately visible below. Live-host acceptance is separate.

## Milestone B — setup APIs and the guided frontend wizard

Not started (0 %). Server-side state only: the browser never declares an
installation fresh or an operation complete. Depends on A3–A6.

## Milestone C — service adapters and identity integration

Not started (0 %). Keycloak, Pomerium (Caddy → Pomerium → app; no forward
auth), Infisical + Agent Proxy, OpenBao, Vaultwarden. Activation gated on a
successful login and the recovery checks from A1.

## Milestone D — platform-aware app provisioning and maintenance

≈ 0–5 % (unchanged). Registry, shared integrations, coordinated lifecycle.

## Remaining in milestone A

| Item | Note |
| --- | --- |
| MCP verbs `list_setup_jobs`, `get_setup_job`, `request_app_recovery` | The lock already binds every MCP mutation through `withContainerLock`; the observe/request verbs are REST-only today |
| Dashboard surface | A page or panel over `/api/setup` (stale locks, recovery-required apps, job events); belongs with the wizard (milestone B) but the recovery view is useful on its own |
| Credential migration under the lock | The operation itself is milestone C; when it exists it takes the same lease (`withContainerLock`, kind `credential_migration`) |
| Phase F, and the operations still on the container's pivot | With the runner live, the deploy no longer runs under the container's nsenter pivot. Still on it: Incus lifecycle and snapshots, both restores, the retry-path secret mint (`runner.js` `retry-secrets`), the component pre-install, Caddy, storage, migration, the workspace terminal. Each is a candidate for the same treatment (a job kind + the runner); `privileged: true`, `pid: host` and the Docker socket stay until they are all moved (master-spec Phase F) |
| Next slice: `restore_project_db`, `restore_snapshot`, the retry-path secret mint as runner job kinds | Today they run in the backend through `withContainerLock` (persistent lease, job record) with the nsenter pivot; the executor and the protected-copy primitives are ready to take them |
| The legacy in-process executor | Exists only under `SETUP_EXECUTOR_POLICY=backend-allowed`: development checkouts, an operator's explicit choice, and an installation whose runner did not verify at install/update time (install.sh writes `backend-allowed` first and promotes only on evidence, logging an error otherwise). Retiring it entirely is a later decision once no supported host needs it |
| Containment limits (recorded, not open defects) | Job cgroups cover every process a deploy script starts, in any session. Outside them by design: the app's own service (its unit's cgroup), an operator's shell, and the executor's short verification/recovery probes; the reap acts at takeover, not continuously; `cgroup1` kills by loop and reports what it missed. The systemd-scope form is host acceptance (no systemd in the sandbox) |

## Overall new-platform repository work: ≈ 35 % (from the reviewer's 33–34 % after the deployment slice)

Basis for the increase: milestone A moved by roughly fifteen points and is
one of four milestones of unequal size; the weighting keeps the runner /
engine and the wizard as the bulk of what remains.

## Privilege separation, honestly

What exists today, and must not be described as separation:

- The dashboard backend runs in a container with `privileged: true`,
  `pid: host`, the Docker socket bind-mounted, and every host operation
  pivoting through `nsenter -t 1` (`lib/host-exec.js`, `install.sh`'s
  compose file). A compromise of the backend is host root.
- `proxypilot-agent` (Go, unprivileged, `NoNewPrivileges`,
  `ProtectSystem=strict`) serves `agent.ping`, the Caddy methods, the
  `storage.*` discovery methods and the self-update file exchange. It is
  not on the production path for guest operations.
- The root oneshot `proxypilot-update.service` (`scripts/update-runner.sh`)
  is the one allowlisted host runner: a request file authored by the agent
  (owner, nonce, freshness, flag allowlist), three actions (`update`,
  `check`, `storage-install`), nothing caller-supplied reaches a command.

The deployment slice moved one operation — the application deploy: its
guest commands, the secret mint, the unit swap, the recovery and every
verification — off the container's pivot on every `runner-required`
installation (all of them from this version on; the in-process executor
exists only under the explicit `backend-allowed` policy). It removed
nothing from the container itself: `privileged: true`, `pid: host`, the
Docker socket and the nsenter pivot remain for Incus lifecycle and
snapshots, both restores, the retry-path mint, the component pre-install,
Caddy, storage, migration and the workspace terminal. Until the
container's `privileged: true` is dropped (Phase F of
`docs/features/security-completion/master-spec.md`), "privilege separation"
in this ledger means: the new engine's privileged steps run in the runner
and not in the container, and the browser-facing API cannot author an
arbitrary host command through it. It does not mean the backend has lost
its existing reach; that remains listed here until it is true.

## Live-host acceptance (separate from the code percentages)

| Item | State |
| --- | --- |
| Gate-one host acceptance table (`docs/features/immediate-repairs.md`) | outstanding |
| A1: `recover status` and `recover admin --password --totp` on a real install, fresh-browser login, TOTP re-enrolment, password change, other accounts and services untouched, audit entry visible | outstanding |
| A2–A6: unit active after install; kill the backend between a deploy's stop and start and confirm the runner recovers the app, the LDAPS credential decrypts, the records read as described in `docs/features/setup-engine.md`; an MCP restore during a deploy is refused naming the holder; a clean restart queues nothing | outstanding |
| A2a: a dashboard deploy owned by `runner@…`; browser closed and backend restarted mid-deploy — the job completes; runner killed between stop and start — the restarted runner reconciles and the app comes up; cancel before and after the stop; on a `backend-allowed` host with the runner stopped the deploy runs in-process as `backend@…` | outstanding — a scripted guest is not evidence of this |
| A2c: on a `runner-required` host, the deploy record ends `credential_use_verified` for an app with an LDAPS credential (the follow-up job ran in the runner with the login read from mock2.db); with the runner stopped a submission queues and nothing executes in the container; the pre-deploy dump and the `.pre-<job>` copies exist and `restore_project_db` accepts the dump | outstanding |
| A2d: in a real guest, a detached (`setsid`) writer started by a deploy script is stopped by the next deploy's reap through its `mock2-deploy-<job>-*` scope (journal shows the `systemctl kill`) and the mock2-dev service is untouched; with systemd unable to start a scope but a writable cgroup tree the deploy proceeds under `cgroup2`/`cgroup1` (recorded on the job) and the setsid writer is still reaped — the raw fallback is a supported mechanism; only with systemd unusable AND the cgroup roots unwritable does the deploy refuse with `containment_unavailable` (masking systemd alone is the first case, never the second); a fresh install reads `runner-required` in `.env` only after the unit is active; `install.sh` re-run with the runner unit masked leaves `runner-required` in place and names the requirement; `update.sh` with the unit masked prints the red warning and changes nothing; a second deploy submitted before the first's follow-up ran leaves the first's rung `superseded`; a deploy failed after the stop shows the post-failure verification's outcome | outstanding — the sandbox proved the raw cgroup mechanisms with real processes and everything else against scripted guests |

## Suite evidence per slice

| Slice | Tree | Tests | Pass | Fail | Skipped | Note |
| --- | --- | --- | --- | --- | --- | --- |
| baseline | `main@d9a6eb4` (gate one merged) | 2751 | 2741 | 4 | 6 | fails: `cve-research`, `cves`, `incus`, `webauthn` (native `better-sqlite3` absent in the sandbox); skips: five Playwright cases, the ZFS loop-device test |
| A1 | this branch after A1 | 2780 | 2770 | 4 | 6 | the same four files and the same six skips; +29 tests from `root-recovery.test.js` |
| A3–A4 | after the engine core | 2799 | 2789 | 4 | 6 | same four files, same six skips; +19 tests from `setup-engine.test.js`; four gate-one source ratchets updated to the new lock call shapes (semantics unchanged) |
| A2, A5, A6 | after the host runner | 2813 | 2803 | 4 | 6 | same four files, same six skips; +14 tests from `setup-runner.test.js` |
| A2a, A2b | after the runner-owned deploy | 2831 | 2821 | 4 | 6 | same four files, same six skips; +18 tests from `setup-deploy.test.js` (two of them real child processes); four gate-one ratchets re-pointed at `deploy-op.js` (same assertions) |
| A2c | after the deployment corrections (`6570b34`) | 2840 | 2830 | 4 | 6 | same four files, same six skips; +9 tests from `setup-deploy-finish.test.js` (one with real processes: an unmarked child surviving its marked parent, killed by session, a legitimate holder preserved); the gate-one ratchets updated for the migration-after-stop order (six restart paths) and the executor-driven adapter |
| A2d | after the closeout (`f23dc47`; the policy-preservation ratchet added after it changes no count) | 2853 | 2842 | 4 | 7 | same four files; the seventh skip is the closeout sentinel, which skips when the real-process regression ran on at least one mechanism and FAILS on a host with none; +14 tests from `setup-deploy-closeout.test.js` (three with real processes: the setsid regression on cgroup v2 and on cgroup v1, and the refusal), −1 from `setup-deploy-finish.test.js` (the session-based real-process test, superseded). The base was re-run in the same sandbox for this row: `d9a6eb4` in a worktree gives 2751 / 2741 / 4 / 6 (2736 counted when `cli/node_modules` was not linked, `vpn-mtu` then failing to load as one test: 2736 − 1 + 16 = 2751) |

The sandbox differs from the one the gate-one handoff reported (2674 tests,
10 failing files there): this one has `ldapts` and the CLI's dependencies
installed, so `ldap.test.js` and `vpn-mtu.test.js` run. Compare like with
like: the baseline row above was produced in this sandbox on the exact
base commit.
