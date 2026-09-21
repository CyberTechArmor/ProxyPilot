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
`7d6e5ab` (PR #602). The restores slice (A-13…A-15) is `4936073` on the same
branch restarted from `7d6e5ab`, merged as `fb7a89d` (PR #603). The first
A-17 group (A-17.1…A-17.6, this revision of the file) is on
`claude/proxypilot-incus-lifecycle-snapshots-r27kl5` from `main@fb7a89d`.

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
| A-17 | Remaining host operations behind the runner | every host operation the backend still performs through its pivot moved behind the runner as a validated job kind (or an agent method), group by group; complete only when the inventory below is empty | **partial** — group 1 (Incus lifecycle and snapshot create / delete) done; groups A-17.7…A-17.14 planned | sub-rows below; setup-engine ledger A9 and § "Privilege separation, honestly" |
| A-17.1 | Inventory of group 1: verbs, callers, authorization, resource ownership, locking, result contracts | recorded in `docs/features/setup-engine.md` § "Incus lifecycle and snapshots" and in this table's groups A-17.7…A-17.14 (what stays on the pivot, by file and verb) | done | this file; setup-engine ledger A9 |
| A-17.2 | `instance_start` / `instance_stop` / `instance_restart` as runner jobs | one fixed argv per kind (`lifecycleArgv`); the guest read before and after; Running / Stopped as the only success; a guest already in the state issues nothing; a managed app's start / restart queues the ladder; refused (never queued) on a held lease, an open mutating job or no executor; start / stop resumed after a dead owner, restart never replayed (`interrupted_uncertain`) | done | `lib/setup-engine/{lifecycle-logic,lifecycle-op}.js`, `setup-lifecycle.test.js` §2–4 |
| A-17.3 | `instance_delete` as a runner job, identity-bound | bound to `volatile.uuid` + `created_at` (`expect`); a guest of another identity under the name refused with nothing issued; stop (force optional) then delete as two fixed commands; verified absent; the deleted identity kept on a record that outlives the guest; resumed after a dead owner only against the same identity; a guest that will not stop cleanly is not deleted | done | same; `setup-lifecycle.test.js` "instance_delete", "interruption, idempotent kinds" |
| A-17.4 | `instance_create` (the launch) as a runner job | `incus launch` from a plan of image, profile, an allowlisted `--config` map (`LAUNCH_CONFIG_ALLOWLIST`), `--network`, `--vm`; the root size a best-effort follow-up; an existing name refused before launch; a failed launch's half-created guest removed and reported; verified present and Running; never replayed after issue; the dashboard's unquoted shell interpolation of image and profile gone (R-017) | done | same; `routes/lxc.js` `POST /containers`; `routes/mcp.js` `create_lxc_container` |
| A-17.5 | `snapshot_create` / `snapshot_delete` as runner jobs | the create with the legacy CLI form discovered and the note recorded by the job, verified present; the delete bound to the snapshot's `created_at`, verified absent; both resumed after a dead owner by re-reading; the dashboard's progress poll reads the engine record and refusals are answered before any job exists | done | same; `routes/lxc.js` snapshot routes; `routes/mcp.js` `snapshot_lxc_container`; `routes/mcp-tools/lxc-admin.js` `delete_snapshot` |
| A-17.6 | Callers redirected; old paths removed; ratchets | dashboard start / stop / restart / reboot / delete / create / snapshot create / both snapshot deletes / `cleanup exportTemps`, and MCP `control_lxc_container`, `create_lxc_container`, `snapshot_lxc_container`, `delete_lxc_container` (stop + delete), `delete_snapshot` submit through `mock2/ops.js` `runLifecycle`; no `incus start|stop|restart|delete|launch|snapshot create|snapshot delete` command built by any of them; `delete_lxc_container`'s token bound to the guest's identity; both dashboard snapshot deletes `requireSudo` (R-016); API and MCP response shapes preserved (a `jobId` / `job_id` added) | done | `immediate-repairs.test.js` "ratchet (A-17.6)"; `setup-lifecycle.test.js` §5 |
| A-17.7 | Group 2: post-launch and post-start fix-ups | `ensureNetworkNat`, `ensureDns` (guest exec), the create route's IP wait, init script (`incus exec … pp-init.sh`) and route rendering; the MCP create's DHCP wait — each as a job step or an agent method | planned — next | `routes/lxc.js` `POST /containers` tail, start / restart handlers; `routes/mcp.js` `create_lxc_container` tail |
| A-17.8 | Group 3: guest configuration verbs and their pre-mutation snapshot | `resize`, `set_lxc_config`, `set_lxc_resources`, `set_lxc_network`, `add_lxc_device` / `remove_lxc_device`, `set_port_forward`, `set_lxc_egress` and `takeLxcSnapshot` (`routes/mcp.js`) as validated job kinds over the config allowlist | planned | `routes/mcp.js`, `routes/mcp-tools/lxc-admin.js`, `routes/lxc.js` `/resize` |
| A-17.9 | Group 4: identity and transport verbs | `rename`, `clone_lxc_container` (copy + start), `export_lxc` / `import_lxc` and the export before `delete_lxc_container`, the dashboard's exports restore (import + start), zip import (import + start + cleanup delete), prepared downloads' temp copy / delete (`lib/lxc-exports.js`), snapshot S3 export's temp instance (`lib/snapshot-s3-export.js`) | planned | those files |
| A-17.10 | Group 5: project provisioning and the idle sweep | `mock2/provision.js` launch / delete / stop / start and its setup script (the component pre-install boundary), `lib/project-lifecycle.js` archive stop / start and the idle sweep — as runner jobs with the project's lease | planned | `mock2/provision.js`, `lib/project-lifecycle.js` |
| A-17.11 | Group 6: component pre-install | the guest-side install of a component's runtime and packages as a job kind (today part of provisioning and `install_component`) | planned | `mock2/component-install.js` |
| A-17.12 | Group 7: Caddy | site-file writes, `caddy adapt` / `reload`, cert mounts — through the agent's Caddy methods or a job kind | planned | `lib/caddy-driver.js`, `routes/services.js` |
| A-17.13 | Group 8: storage and migration transports | ZFS / pool mutations (`lib/storage/service.js` apply) and the migration agent's transfers and `incus import` | planned | `lib/storage/`, `lib/migration/` |
| A-17.14 | Group 9: the workspace terminal, `run_lxc_command`, in-guest file operations, host service control and reads | the PTY (`lib/pty.js`), `run_lxc_command`, the lxc file tools, `host_service_control`, packages, cron, and every read (`incus list|info|query|snapshot list|image list`, usage, logs) — the reads are the last to move or are re-homed on the unprivileged agent | planned | `routes/lxc-workspace.js`, `routes/mcp.js`, `routes/mcp-tools/lxc-admin.js` |
| A-18 | Phase F: drop `privileged: true`, `pid: host` and the Docker socket from the backend container | compose file without them; every host operation reaches the host through the runner or the agent; documented in the security master-spec | planned (depends on A-17) | `docs/features/security-completion/master-spec.md` (Phase F) |

Milestone A code completion: **≈ 88 %**. Basis: A-01…A-15 are done in code
with executable tests and merged (the restores slice's review accepted the
≈ 85 % its ledger row proposed); of the remaining fifteen points, A-16 is
about two, A-18 about three and A-17 about ten spread over nine groups of
unequal size — group 1 (this slice: five verbs across two surfaces, the
interruption model and the identity binding that the later groups reuse)
is worth roughly three of those ten. The figure is proposed with this
slice and held at 85 % until its merge review accepts it.

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

Overall new-platform repository work: **≈ 39 %** (from 38 % on acceptance of
the restores slice; weights: A the largest share, B and C the bulk of what
remains, D built on both) — milestone A moved three points and is one of
four milestones of unequal size. Proposed with this slice, held at 38 %
until its merge review accepts it. Code completion only; rollout readiness
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
| HA-09 | The lifecycle group on a real host (A-17.2…A-17.6): dashboard start / stop / restart / reboot owned by `runner@…` with `incus list` agreeing with the recorded state; Start on a running guest issuing nothing; a container and a VM created from the dashboard with exactly the allowlisted config keys and the VM root size, the init script and routes still applied afterwards; a create with a missing image leaving no half-created guest; a snapshot with a note through the dialog's poll to `done` with a `snapshot_durations` row; a dashboard snapshot delete behind the sudo prompt; MCP `delete_lxc_container` refusing its first token after the guest was recreated under the same name, then deleting with a fresh one; the runner killed between a delete's stop and delete → resumed, guest gone; killed during a restart → `interrupted_uncertain`, nothing re-issued; the runner stopped → a start refused (503), not queued; the legacy Incus snapshot verb | outstanding — the sandbox proved every path over a scripted host executor and the argv hand-off to the real spawn | `docs/features/setup-engine.md` § Host acceptance |
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
| R-015 | 2026-09-21 | A-17 | the previous slice's merge state and base | `git merge-base --is-ancestor 4936073 origin/main`; `origin/main@fb7a89d` = PR #603 | process note | record | the restores slice is merged; this branch starts from `fb7a89d` with no divergence; the sandbox had no `node_modules` at all (the ledger's earlier suite rows came from another sandbox) — installed with `--ignore-scripts`, so the four native-module test files fail at load here exactly as `docs/known-issues.md` describes |
| R-016 | 2026-09-21 | A-17.5 | the dashboard's two snapshot delete routes ran `incus snapshot delete` with no fresh-authentication requirement while the container delete and the MCP twin are gated | `routes/lxc.js` before this slice; R-011 | defect in scope | fix | both routes `requireSudo` (the client's sudo modal makes it transparent) and submit the `snapshot_delete` job; ratchet in `immediate-repairs.test.js` |
| R-017 | 2026-09-21 | A-17.4 | the dashboard's create route interpolated the operator's `image` and `profile` unquoted into an `incus launch` shell string (its own comment called the interpolation out of scope) | `routes/lxc.js` `launchCmd` before this slice | defect in scope | fix | the launch is a plan validated by name (`IMAGE_ALIAS_RE`, `PROFILE_NAME_RE`, the config allowlist) and rendered as argv by the runner; the shell string is gone; ratchet |
| R-018 | 2026-09-21 | A-17.2…A-17.5 | should a lifecycle verb queue behind a held lease or a missing runner (like the deploy) or refuse (like a restore)? | the restores' rule; a stop or delete that runs minutes later under a state nobody looked at | decision | refuse, on the record | all seven kinds are `EXCLUSIVE_JOB_KINDS`: refused at submission, at claim and with no executor (`cancelled` / `runner_unavailable`); the dashboard answers 409 / 503 synchronously; the snapshot dialog's poll is entered only after a successful submission |
| R-019 | 2026-09-21 | A-17.2…A-17.5 | how an interrupted lifecycle job is handled after its command was issued | requirement 6 of the slice; the reconcile decision table | decision | operation-specific | start, stop, delete and both snapshot verbs are resumed by re-reading, finishing when the state holds and re-issuing only against the identity the dead attempt bound (`checkpoint.target`); restart and create are never replayed (`record_uncertain` → `recovery_required` / `interrupted_uncertain`, no recovery job, lease released as the explicit outcome) |
| R-020 | 2026-09-21 | A-14 | `resultFromJob` spreads the operation's result under the job's own `status`, so `restore_snapshot`'s Incus `status` field is shadowed by the job status in what the MCP tool returns | `orchestrator.js` `resultFromJob`; `lxc-admin.js` `restore_snapshot` `status: out.status` | non-blocking follow-up (pre-existing) | track | the lifecycle kinds report `instanceState` and are unaffected; rename the restore's field with its next change |
| R-021 | 2026-09-21 | A-17.1 | what this group leaves on the container's pivot | the inventory in `docs/features/setup-engine.md` § "Incus lifecycle and snapshots" (last paragraph) | scope decision | record as groups A-17.7…A-17.14 | the post-launch configuration and post-start NAT / DNS fix-ups, the config verbs and their `takeLxcSnapshot`, rename / clone / import / export and the transports' temp instances, provisioning and the idle sweep, component pre-install, Caddy, storage, migration transports, the terminal, the reads — each named by file and verb above; `privileged: true`, `pid: host` and the Docker socket stay until every group is empty |
| R-022 | 2026-09-21 | evidence | the full backend suite run on base and branch concurrently in this sandbox made the cgroup real-process regression fail once on each side (both runs used the real `/sys/fs/cgroup/*/mock2-deploy/dead-job` group) | `suite-base.log` / `suite-branch.log` of the session; the sequential re-runs | measurement note | re-run sequentially | the like-for-like rows in the setup-engine ledger come from the sequential runs; the cgroup2 form of that regression still fails under the FULL parallel run on this host on base and branch alike and passes when its file runs alone (13 pass / 1 skip) — an environment condition of this sandbox, identical on both sides, recorded not fixed |
