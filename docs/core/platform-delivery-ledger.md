# Platform delivery ledger

The one place that says what the new platform work consists of, what is
demonstrably done, what is open, and how review feedback is dispositioned.
It links evidence; it does not duplicate it. The detailed record of the
setup engine (locks, jobs, runner, deploy, containment, policy) is
`docs/core/setup-engine-ledger.md`; the requirements it answers are
`docs/core/setup-engine-requirements.md`; feature behaviour is documented
under `docs/features/`.

How to read it:

- **Status** is one of `done` (code and executable tests in the tree, with
  the evidence named), `partial` (some criteria met, the rest listed),
  `planned` (agreed scope, not started), `proposed` (not agreed scope).
- **Completion criteria** are observable: a test that exists, a record that
  reads a certain way, a command that behaves a certain way.
- **Host acceptance** is tracked in its own table and is never folded into
  a code percentage. "Done" here means done in code; rollout readiness is a
  separate statement.
- A `done` row is not reopened by later feedback: a defect found in it goes
  in the review-decision table with a new resolution, and the row's
  evidence is updated to the fixing commit.

Branch of record: `claude/proxypilot-gate-two-otcksh` on base
`main@d9a6eb4`. Commits: `d16b3e7` (recovery + LDAP fix), `613086e`
(engine core), `246a307` (runner), `90be461` (runner-owned deploy),
`6570b34` (deployment corrections), `f23dc47` (closeout), `4c9ef02` (this
file; policy preservation on install re-run) — merged to `main` as
`7d6e5ab` (PR #602). The restores slice (A-13…A-15) is the commit carrying
this revision of the file, on the same branch restarted from `7d6e5ab`.

## Milestone A — reliable execution and recovery

Runner-owned execution of every privileged platform operation, persistent
ownership and progress, truthful recovery states, and finally the removal
of the backend container's host reach (Phase F).

| ID | Deliverable | Completion criteria | Status | Evidence |
| --- | --- | --- | --- | --- |
| A-01 | Non-destructive root recovery command (`proxypilot recover admin\|status`) | restores one local administrator (password / TOTP / passkeys / promote / create) leaving every other row byte-identical; revokes sessions, sudo windows, trusted devices; root-only; no secret on argv; audit entry without secrets; works with the dashboard and every IdP down | done | `root-recovery.test.js` (29); setup-engine ledger A1; `docs/features/root-recovery.md` |
| A-02 | Initial-setup endpoints cannot claim a directory-backed administrator | `setup-status` and `initial-setup` consider local accounts only; executed-SQL test | done | `git show d16b3e7 -- admin/backend/src/routes/auth.js`; last block of `root-recovery.test.js`; ledger A1a |
| A-03 | One persistent lease per app for deploy, both restores, the retry mint (later: credential migration) | `setup_locks` (migration 1000): live foreign lease refuses; expired lease is a recorded stale condition, never free; survives backend restart; enforced for UI, CLI, MCP through `withContainerLock` | done | `setup-engine.test.js`; ledger A4; `docs/features/setup-engine.md` § Locks |
| A-04 | Saved job records with checkpoints and recovery references, no secret values | `setup_jobs` + `setup_job_events`; checkpoint before the disruptive step; redaction on every write; retained protected copies named on the record | done | `setup-engine.test.js`, `setup-deploy.test.js`, `setup-deploy-finish.test.js`; ledger A3, A2c(2) |
| A-05 | Independent host runner as a root systemd service | `proxypilot setup-runner serve\|once\|reconcile\|status`; four validated job kinds; heartbeats (migration 1001); unit installed and enabled by install.sh / update.sh | done | `setup-runner.test.js`; `deploy/proxypilot-setup-runner.service`; ledger A2 |
| A-06 | Restart / reboot reconciliation | dead backend that stopped an app → recovery job + stale kept lease; dead runner's resumable job → requeued; anything else → interrupted and released; epoch fencing stops a stale worker | done | `setup-runner.test.js`, `setup-deploy.test.js` (interruption at every checkpoint); ledger A5 |
| A-07 | Distinct verification states, never conflated | ladder unconfigured → configured → port_responding → app_healthy → credential_decryptable → credential_use_verified / recovery_required; deferral is a named outcome; `pending` rungs on the record | done | `setup-runner.test.js`, `setup-deploy-finish.test.js`; ledger A6, A2b |
| A-08 | Runner-owned application deploy (one operation, one executor) | every caller submits through `deployProject`; runner executes when live, backend in-process only under `backend-allowed`; cancel at a safe checkpoint, declined after the stop | done | `setup-deploy.test.js` (18); ledger A2a |
| A-09 | Durable, revision-bound application-owned verification | follow-up `verify_app` queued before the deploy reports done; seven outcomes incl. `superseded` (a different commit/build id running is never certified); requeued on a held lease with a not-before, never finished deferred; post-failure verification after a stop; a successful recovery queues the check the interrupted deploy never reached | done | `setup-deploy-finish.test.js`, `setup-deploy-closeout.test.js` § C–E; ledger A2c(1), A2d(2) |
| A-10 | Migration-aware checkpoints and protected copies | maintenance boundary before the migration; pre-deploy dump in the restore directory, unit and env copies (0600), commit and migration retry class on the record; a failed migration named, never rolled back | done | `setup-deploy-finish.test.js` § 2; ledger A2c(2) |
| A-11 | Job-scoped process containment with refusal | every deploy script in a job cgroup (systemd scope → cgroup2 → cgroup1); no mechanism → exit 97, `containment_unavailable`, nothing run; takeover reaps other jobs' groups, counts live survivors, keeps and flags the lease on survivors; real-process regression with a `setsid` child on every raw mechanism the host offers | done (systemd-scope form is host acceptance HA-06) | `setup-deploy-closeout.test.js` § A–B; `docs/features/setup-engine.md` § Containment; ledger A2d(1) |
| A-12 | Explicit executor policy, evidence-gated, never downgraded | `SETUP_EXECUTOR_POLICY` read from the store's env only; `runner-required` queues and reports, never executes in the backend; install.sh promotes only after the unit is active and the runner opened the database; install.sh re-run preserves an existing value; update.sh writes only when absent; a failed runner start on a `runner-required` install keeps it and says so; backend warns every five minutes without a heartbeat | done | `setup-deploy-finish.test.js` § 4, `setup-deploy-closeout.test.js` § F; ledger A2c(4), A2d(3); review R-004 |
| A-13 | `restore_project_db` as a durable runner job (`restore_db`) | validated reference-only parameters; refused at submission and at claim while the app's lease is held or any mutating job is open (never queued behind); the dump bound to a recovery set only by a job record of THIS app (name + sha256), or restored under the current configuration; compatibility established BEFORE the stop by decrypting the dump's own protected rows under the key that will be in force (no "assume"); plain pg_dump format only, server major checked; pre-restore dump (temp-name capture, promoted only when verified) and environment copy with identity on the record, reused on `retry_of` only after revalidation; checkpoint before the stop; interrupted → resume / recovery-required naming the restore and its copy; `verify_app` follow-up landing on the record; MCP confirmation bound to the exact plan; refused (cancelled on the record) when no executor is available | done | `lib/setup-engine/{restore-logic,restore-db-op,orchestrator,op-kit}.js`, `mock2/ops.js`, `routes/mcp-tools/project-config.js`, `setup-restores.test.js`; `docs/features/setup-engine.md` § Restores |
| A-14 | `restore_snapshot` as a durable runner job | as A-13 for the lease, exclusivity, confirmation and executor policy; validated against `incus list` before anything; **coverage**: root disk only — a guest with custom volumes attached is refused unless `accept_partial`, and then reports `complete: false` naming them; pre-restore snapshot identified by name + `created_at`, reused on retry only when both match; argv arrays to `incus` (the runner's host channel spawns directly; the legacy `snapshot` verb discovered by the client's answer); the guest started again if it was running; a managed app gets the full ladder as a follow-up, another guest an explicit `not_applicable`; all coordination records on the host; the dashboard route now `requireSudo` and on the same job | done | `lib/setup-engine/restore-snapshot-op.js`, `routes/mcp-tools/lxc-admin.js`, `routes/lxc.js`, `cli/src/commands/setup-runner.js` (`host`), `setup-restores.test.js` |
| A-15 | Retry-path secret minting as a durable runner job (`retry_secrets`) | the deploy's own mint (`mintComponentSecrets`) run alone under the lease in the job's cgroup: markers, data guard, never overwrite, defer and say why; key NAMES only on the record, a real value only in the guest; `retry_of` reports the recorded keys found in place as `reused`; verification `not_applicable` by name (the deploy that follows verifies); refused, not queued, when no executor is available | done | `lib/setup-engine/retry-secrets-op.js`, `mock2/runner.js`, `setup-restores.test.js` |
| A-16 | MCP observe/request verbs for setup jobs | `list_setup_jobs`, `get_setup_job`, `request_app_recovery` through `kit.mutation` with ledger rows | planned | setup-engine ledger "Remaining" |
| A-17 | Remaining host operations behind the runner | Incus lifecycle and the snapshots other than the restore, component pre-install, Caddy reload, storage, migration transports, workspace terminal each as a job kind or an agent method | planned — the next bounded task after review | setup-engine ledger § "Privilege separation, honestly" |
| A-18 | Phase F: drop `privileged: true`, `pid: host` and the Docker socket from the backend container | compose file without them; every host operation reaches the host through the runner or the agent; documented in the security master-spec | planned (depends on A-17) | `docs/features/security-completion/master-spec.md` (Phase F) |

Milestone A code completion: **≈ 80 %, held**. A-01…A-15 are done in
code with executable tests (this slice added A-13…A-15); A-16 is small;
A-17 and A-18 are the large remainder. The figure is held at the previous
estimate until the merge review of the restores slice accepts it as
demonstrated; on acceptance the basis supports ≈ 85 %.

## Milestone B — guided frontend setup and upgrade

| ID | Deliverable | Completion criteria | Status | Evidence |
| --- | --- | --- | --- | --- |
| B-01 | Server-side setup plan and state API | the server decides "fresh" / "partial" / "complete" from the database, never the browser; a plan is a persisted record with steps, each with a state | planned | requirements R3 |
| B-02 | Persistent progress, retries and recovery for wizard steps | every wizard step is a setup job (A-04) or a lock-holding operation; a closed browser or restarted backend changes nothing about progress; retry reuses generated resources | planned | depends on A-03, A-04, A-06 |
| B-03 | Guided setup wizard (dashboard) | first-run flow: admin, TLS, first app, identity; completable on a 360 px screen (`MOBILE_FIRST.md`); every action goes through `lib/api.js` | planned | |
| B-04 | Guided upgrade flow | update readiness, protected copies named before the disruptive step, post-update verification with the ladder, rollback pointer | planned | depends on A-10, A-13 |
| B-05 | Recovery and jobs panel | stale locks, recovery-required apps, job events and the operator table of `docs/features/setup-engine.md` § "Operating it" rendered in the dashboard | planned (useful before B-03) | `/api/setup` exists (`routes/setup.js`) |

Milestone B code completion: **0 %** (the REST surface `/api/setup` exists
and is tested, but no plan model or wizard).

## Milestone C — connected services

| ID | Deliverable | Completion criteria | Status | Evidence |
| --- | --- | --- | --- | --- |
| C-01 | Keycloak adapter | provision, health, admin credential handling through the runner, activation gated on a successful login and the A-01 recovery check | planned | |
| C-02 | Pomerium adapter | Caddy → Pomerium → app; no forward-auth; route templates | planned | |
| C-03 | Infisical + Agent Proxy adapter | secret injection into guests without values in ProxyPilot rows | planned | |
| C-04 | OpenBao adapter | unseal / policy / app roles; recovery material handling | planned | |
| C-05 | Vaultwarden adapter | provision, backup, TLS | planned | |
| C-06 | Credential migration under the shared lease | takes `withContainerLock` kind `credential_migration`; job-recorded; recovery_required on interruption | planned | setup-engine ledger A4 note |

Milestone C code completion: **0 %**.

## Milestone D — application provisioning automation

| ID | Deliverable | Completion criteria | Status | Evidence |
| --- | --- | --- | --- | --- |
| D-01 | Registry-driven provisioning of a new app | one request produces guest, contract, secrets (gate-one rules), route, verification to `credential_use_verified` | partial (the deploy, mint and verification exist; the registry-driven flow does not) | A-08, A-09; `docs/features/immediate-repairs.md` |
| D-02 | Selectable adoption of an existing app | the operator selects a running guest/app; ProxyPilot records its contract and guards without changing it; the first deploy is opt-in | planned | migration feature (`docs/features/migration.md`) is the nearest primitive |
| D-03 | Integrated upgrade verification | an app upgrade ends with the ladder and the application-owned check on the record, superseded rules applied | partial (the mechanism exists for the deploy path; not wired to component upgrades) | A-09 |
| D-04 | Integrated restore verification | a restore (A-13, A-14) ends with a verification job the same way | partial (the follow-up exists for both restores; not yet surfaced as a restore-flow step in a wizard) | A-13, A-14 |
| D-05 | Coordinated lifecycle and maintenance | shared integrations, scheduled maintenance windows, dependency ordering | planned | |

Milestone D code completion: **≈ 5 %**.

## Overall

Overall new-platform repository work: **≈ 36 %, held** (weights: A the
largest share, B and C the bulk of what remains, D built on both), on the
same basis as milestone A above. Code completion only; rollout readiness
requires the host acceptance below.

## Host acceptance (separate from the code figures)

| ID | Check | State | Where the steps are |
| --- | --- | --- | --- |
| HA-01 | Gate-one host acceptance (secrets, markers, restarts) | outstanding | `docs/features/immediate-repairs.md` § Acceptance record |
| HA-02 | A-01 on a real install: `recover status`, `recover admin --password --totp`, fresh-browser login, other accounts untouched, audit visible | outstanding | `docs/features/root-recovery.md` |
| HA-03 | Runner unit active after install; backend killed between a deploy's stop and start recovers through the runner; records read as documented; MCP restore during a deploy refused naming the holder; clean restart queues nothing | outstanding | setup-engine ledger, acceptance rows A2–A6 |
| HA-04 | Dashboard deploy owned by `runner@…`; browser closed and backend restarted mid-deploy; runner killed between stop and start; cancel before and after the stop | outstanding | ledger row A2a |
| HA-05 | `credential_use_verified` on a real LDAPS app; queued submission with the runner stopped; pre-deploy dump and `.pre-<job>` copies present and restorable | outstanding | ledger row A2c |
| HA-06 | Containment in a real guest: `setsid` writer reaped through its systemd scope; raw-cgroup fallback proceeds and reaps (systemd unable to start a scope, cgroup tree writable); refusal only when every mechanism is absent | outstanding — sandbox evidence covers the raw mechanisms with real processes | ledger row A2d; `docs/features/setup-engine.md` § Host acceptance |
| HA-07 | Policy: fresh install promotes only on evidence; re-run with the runner masked keeps `runner-required`; `update.sh` with the runner masked warns and changes nothing | outstanding | same |
| HA-08 | Restores on a real host (A-13…A-15): a dump restored under the current configuration ends `credential_use_verified`; a pre-deploy dump refused without its environment copy at `compatibility` and restored with it; the bind and format refusals; the runner killed between stop and start → `interrupted_after_stop` naming the restore, recovery brings the app up; a guest with a custom volume refused then restored root-only with `complete: false`; the pre-restore snapshot reused on retry by timestamp; the legacy Incus `snapshot` verb; a restore refused (not queued) with the runner stopped | outstanding — the sandbox proved the operations over scripted guest/host executors, the compatibility check with real AES-GCM rows and the host channel with a real process | `docs/features/setup-engine.md` § Host acceptance |

## Review decisions

Every piece of review feedback lands here with the item it affects, the
evidence consulted, its class and its resolution. Classes: **defect in
scope** (the agreed deliverable does not meet its criteria — fixed in the
slice), **non-blocking follow-up** (a real gap outside the criteria, or a
limit documented as such — tracked, not a merge blocker), **proposed new
scope** (needs agreement before it becomes a row above).

| # | Date | Item | Finding | Evidence consulted | Class | Disposition | Resolution |
| --- | --- | --- | --- | --- | --- | --- | --- |
| R-001 | 2026-09-21 | A-11 | session-based containment cannot see a child that calls `setsid()` | real-process test: the child is its own session leader, `pgrep -s <parent>` does not find it | defect in scope | fix | job cgroups with refusal on no mechanism; `f23dc47`; `setup-deploy-closeout.test.js` § A |
| R-002 | 2026-09-21 | A-09 | cancelling an older follow-up at submission dropped an obligation when the newer deploy failed before changing anything | closeout test "an older follow-up queued behind a newer deploy" | defect in scope | fix | supersession decided only at run time from the guest's commit/build id; `f23dc47` |
| R-003 | 2026-09-21 | A-09 | a successful recovery of an interrupted deploy left the application-owned check un-queued | `executeJob` recover_app path; `setup-runner.test.js` reconcile test | defect in scope | fix | recovery queues `verify_credential_use` landing on both records; `f23dc47` |
| R-004 | 2026-09-21 | A-12 | `install.sh` re-run regenerated `.env` from the heredoc, rewriting `runner-required` to `backend-allowed`; a failed runner start then left the host downgraded | `install.sh` heredoc (existing `.env` preserved secrets only) | defect in scope | fix | existing value preserved like a secret; failed start on a `runner-required` install keeps it and names the requirement; ratchet in the closeout suite; this commit |
| R-005 | 2026-09-21 | HA-06 | acceptance text conflated "systemd masked" with "no containment" | `docs/features/setup-engine.md` host acceptance; ledger row A2d | documentation defect in scope | fix | raw-cgroup fallback (a supported mechanism) and total absence are separate checks; this commit |
| R-006 | 2026-09-21 | A-11 | the executor's verification and recovery probes run outside a job cgroup | `executor.js` `guest()`; probes are single short commands with timeouts | non-blocking follow-up | document | listed as limit (3) in § Containment; revisit when probes grow a long-lived step |
| R-007 | 2026-09-21 | A-09 | `claimNextJob` considers the 50 oldest queued jobs; more than 50 not-yet-due follow-ups ahead of a due job would delay it one tick | `store.js` `claimNextJob` | non-blocking follow-up | track | bounded by the 30 s not-before; raise the window if a host ever queues that many |
| R-008 | 2026-09-21 | A-12 | `.env.example` says `runner-required` while a fresh `install.sh` starts at `backend-allowed` | `.env.example`, install.sh | non-blocking follow-up | document | intended: the example documents the production value; a hand-made `.env` from it queues visibly with the five-minute warning until the runner runs |
| R-009 | 2026-09-21 | A-13…A-15 | restores and the retry mint still execute in the backend under the persistent lease | ledger "Remaining" | proposed → agreed as the next bounded task | schedule | rows A-13, A-14, A-15 — done in the restores slice |
| R-010 | 2026-09-22 | A-13…A-15 | the handoff named uncommitted operation modules in a workspace (`/home/claude/pp`) that does not exist in this environment and no remote branch carries; nothing was recoverable | `git status`, remote branches, the filesystem | process note | record | the slice was implemented from the committed tree and the ledgers, following the deploy pattern; no checkpoint commit was possible because there was nothing to checkpoint |
| R-011 | 2026-09-22 | A-14 | the dashboard's snapshot-restore route ran `incus snapshot restore` as an interpolated shell string with no lease, no pre-restore snapshot and no fresh-authentication requirement | `routes/lxc.js` before this slice | defect in scope | fix | the route submits the same `restore_snapshot` job (`requireSudo`; argv; pre-restore snapshot; lease); ratchet in `immediate-repairs.test.js` |
| R-012 | 2026-09-22 | A-04, A-13 | the redactor's long-hex net erased a protected copy's sha256 from job records, so a retry could not have revalidated what it reused | `logic.js` `redact`; `setup-restores.test.js` (binding by recorded sha256) | defect in scope | fix | a content hash under a key that names it (`sha256`, `digest`, `fingerprint`) is kept as an identity; every other value net unchanged |
| R-013 | 2026-09-22 | A-15 | with no executor available, should the retry mint queue (like the deploy) or refuse (like a restore)? | the retry-deploy flow; the deploy's own mint | decision | refuse, on the record | a queued mint would run with nobody deploying; the deploy that follows carries the same mint and reports the same unavailability — `cancelled` / `runner_unavailable` with that reason |
| R-014 | 2026-09-22 | A-13 | compatibility without an environment copy: the current configuration's key is read into the runner's memory from the guest's environment file to decrypt the dump's rows | `restore-logic.js` `inspectScript`, `restore-db-op.js` | non-blocking follow-up | document | the same in-memory handling the deploy's mint already uses for the environment text; never a row, never a log; the value net redacts it should a message ever carry it |
