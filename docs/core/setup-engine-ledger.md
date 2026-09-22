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
| A8 | The two restores and the retry mint as runner jobs (platform ledger A-13, A-14, A-15): `restore_db`, `restore_snapshot`, `retry_secrets` through one orchestrator (`lib/setup-engine/orchestrator.js`, `mock2/ops.js`); exclusive submission (refused, never queued behind, while the lease is held or a mutating job is open, and when no executor is available); the database restore binds a recovery set by job record and establishes compatibility from the dump's own rows before the stop, plain pg_dump only, protected copies with identity and revalidated reuse; the snapshot restore validates coverage (root disk; custom volumes refused unless a partial restore is accepted and then reported `complete: false`), identifies the pre-restore snapshot by name+timestamp, runs argv to `incus` through the runner's host channel; the mint reuses the deploy's own mint, names only; MCP confirmation bound to the exact plan; the dashboard route on the same job with fresh sudo | **done** | `lib/setup-engine/{restore-logic,restore-db-op,restore-snapshot-op,retry-secrets-op,op-kit,orchestrator}.js`, `mock2/ops.js`, `routes/mcp-tools/{project-config,lxc-admin}.js`, `routes/lxc.js`, `mock2/runner.js`, `cli/src/commands/setup-runner.js`, `setup-restores.test.js`, `docs/features/setup-engine.md` § "Restores and the retry mint" |
| A9 | The Incus lifecycle and snapshot verbs as runner jobs (platform ledger A-17.1…A-17.6, the first A-17 group): `instance_create`, `instance_start`, `instance_stop`, `instance_restart`, `instance_delete`, `snapshot_create`, `snapshot_delete` through the same orchestrator; ONE fixed argv per kind rendered from a validated plan (`lifecycle-logic.js`: names, flags, a launch config allowlist; never a command, argv or option string); the resource read before and after with only the promised state counted as success; deletes bound to the guest's `volatile.uuid` + `created_at` / the snapshot's `created_at` and refused on a changed identity; exclusive like the restores (refused, never queued, at submission, at claim and with no executor); interruption operation-specific (idempotent kinds resumed by re-reading against the same identity; restart and create never replayed → `interrupted_uncertain` with the lease KEPT stale until `POST /api/setup/jobs/:id/acknowledge` releases it in one transaction, an exclusive kind refused on that lease at the executor and no other kind taking it over (a follow-up waits, a probe defers); the `validated` / `issuing` checkpoints mandatory before any command; a nonzero exit failed whatever the guest reads); a managed app's start / restart gets the ladder as a follow-up; the dashboard's nine handlers and MCP's five tools submit through `mock2/ops.js` `runLifecycle` with their contracts preserved (`jobId` / `job_id` added); the dashboard's unquoted `incus launch` interpolation gone; both dashboard snapshot deletes `requireSudo`; `delete_lxc_container`'s token bound to the guest's identity | **done** | `lib/setup-engine/{lifecycle-logic,lifecycle-op}.js`, `logic.js` (`LIFECYCLE_JOB_KINDS`, `record_uncertain`), `executor.js` (`recordUncertainLifecycle`, refused results), `backend.js`, `orchestrator.js`, `mock2/ops.js`, `routes/lxc.js`, `routes/mcp.js`, `routes/mcp-tools/lxc-admin.js`, `setup-lifecycle.test.js`, `immediate-repairs.test.js` (ratchet), `docs/features/setup-engine.md` § "Incus lifecycle and snapshots" |
| A10 | The post-launch and post-start guest setup as a runner job (platform ledger A-17.7, the second A-17 group): `guest_setup` with the ordered phases `network_nat` (fixed host argv under the host-wide lease `@host/network`: waited for, taken over when dead, `skipped (contended)` and redone by a retry), `await_address` (a bounded `incus list` poll for a host-reachable IPv4, never a docker0 / br-* address inside the guest), `dns` and `init_script` (contained guest scripts), `routes` (delegated to the backend's own `configure_routes` kind under `@host/routes` + the guest's lease, idempotent through `lib/guest-routes.js`); queued by the executor as a durable follow-up of the create (the whole plan) or the start / restart / reboot (`fixup`) BEFORE that job reports done, bound to the identity read back from the guest; every phase's state on the one setup record, the summary back on the lifecycle job, the routes outcome back on the setup; the init script an input file next to the database (0600, by reference + sha256 + bytes, consumed on completion, swept after a day), the checkpoint before it mandatory, its exit code and output kept in the guest (`/var/log/pp-init-<job>.{rc,log}`); a resumed job READS that record and never re-runs; an init whose completion is unknown (no exit code; a writer still running, gone or unknown; a timeout kill — issued OUTSIDE containment over the attempt's recorded scopes and cgroups — that finds a survivor, no record to inspect, or cannot conclude; only every recorded group empty records `timed_out`) ends `init_uncertain` with the guest's lease KEPT, flagged stale and pointed at the job — the lifecycle hold extended to initialization: every exclusive kind refused, follow-ups and probes waiting, whoever the lease names — until `POST /api/setup/jobs/:id/acknowledge { writerStopped: true }` releases it in one transaction (refused without the attestation); a retry never repeats an issued or completed init and KEEPS its result (`notRepeated` beside it: a failed init is still a failed setup) nor duplicates a route; the shared `@host/network` lease renewed before every command at the epoch held and a lost lease stopping the worker before its next write, the same fence for `@host/routes` and the guest's lease in the routes step — forwarded by the production adapter and checked before every site file, the validation, the reload, the upstream move and every write of a rollback, with no rollback after the loss, and the job CLAIM heart-beaten together with both leases on every fence and from a keep-alive between writes (a claim that is no longer the step's is the executor's `FencedError`: nothing written, nothing revived, no other owner's lock released); the script's output stays in the guest's 0600 log (every artifact created under `umask 077`), the record carrying state, exit code and the log's reference only; one completion contract (`setupOutcome`: complete / pending / partial / uncertain, execution status separate) settled onto the setup job and its lifecycle parent when the routes step lands; a phase failing after the guest is Running leaves it usable and the record `setup_partial`; the dashboard's create-status derived from the records (`activeCreations` gone); MCP's create waits on the setup record for the address | **done** (the review of `92404d9`, R-034…R-037, the second review of `91933cf`, R-038…R-039, and the third review of `afcc895`, R-040, closed on this branch) | `lib/setup-engine/{setup-logic,setup-inputs,setup-op,backend-steps}.js`, `lib/guest-routes.js`, `logic.js` (`SETUP_JOB_KINDS`, the init-issued reconcile rule), `executor.js` (follow-up list, `recordUncertainSetup`), `backend.js` (`drainBackendSteps`), `lifecycle-logic.js` (`setup` / `fixup`, `setupFollowUpFor`), `mock2/ops.js` (`runGuestSetup`, `createStatus`, `waitForSetup`, `drainBackendStepsNow`), `routes/lxc.js`, `routes/mcp.js`, `routes/setup.js` (retry of a backend step), `index.js`, `cli/src/commands/setup-runner.js`, `setup-post-launch.test.js`, `immediate-repairs.test.js` (ratchet), `docs/features/setup-engine.md` § "The post-launch and post-start guest setup" |
| A11 | The guest configuration verbs and their pre-mutation snapshot as runner jobs (platform ledger A-17.8, the third A-17 group): `config_set`, `device_add`, `device_remove`, `network_pin`, `forward_apply`, `forward_remove`, `egress_set` through the same orchestrator (`mock2/ops.js` `runGuestConfig`), each IDEMPOTENT — every step reads its own state first, issues its fixed argv only when the state does not hold and reads it back after (exit 0 never the proof), a step that does not read back stopping the sequence with the applied steps and the not-run ones on the record; validation at the surface and again at the runner (`config-logic.js` `validateConfigParams`: the five-key config allowlist and value shapes, `security.privileged=true` only with `acknowledgeRisk`, the device policy's roots / ports / reserved ports read from the same JSON, range widths, reserved device names, never a command / argv / options / script or a secret-looking value); every argv from the renderers, the one host script (the reserved-ports drop-in: `sh -c <fixed text> sh <base64 body> <constant path>`, the body rendered from validated ranges with the reconciler's header) run under real `sh` in the suite; the MCP verbs' pre-mutation snapshot the job's — named at submission, created (legacy CLI form discovered), read back present BEFORE the first write, recorded as generated with `created_at`, reused on resume / retry only by name AND timestamp, a foreign or replaced one refused, a failed one preventing the change, none taken when the whole state already holds — with the coverage stated on every record and result (root disk and config only, custom volumes named, never ProxyPilot's rows or the host firewall); the resize route keeping its no-snapshot contract with the prior values recorded (R-042); the guest's identity bound at submission and refused on a mismatch; the guest's lease held from the first read to the last read-back, the firewall kinds under `@host/firewall` after it (R-046; waited, taken over from a dead holder, contended → refused with nothing issued, renewed before every command, a loss stopping the job with the count issued and the step under way `unverified`, R-047); the job claim, the guest's lease and every held shared lease heart-beaten by the executor's keep-alive through a long command and checked before every command (R-049; proved against the runner's actual `reconcile()` from another owner); every kind resumed after a dead owner by re-reading against the bound identity, the boot sweep's `interrupted` record saying the command may have taken effect, the explicit retry the recovery path (no hold: no step has an outcome the next read cannot establish); `runner-required` with no runner → `cancelled` / `runner_unavailable`, nothing run in the backend; the forward's `service_l4_forwards` row a backend step (rolled back on a definite failure with the host's state named, kept on an unobserved one, R-045), the device, the rule and the drop-in the job's; the dashboard's resize route validated (its unquoted shell interpolation gone, R-041) and the eight callers' response shapes preserved with `jobId` / `job_id`, `verified`, `applied`, `previous`, `snapshot_covers`; **after the review of `ad1a638`** (R-050…R-052, the checklist below): the firewall's SAVED configuration and APPLIED policy verified as two steps (the `reconcile` step reading `firewall status` against `reconcile --dry-run` and issuing `firewall reconcile` when they differ; a saved-but-rejected write never verified, a retry applying it once), the saved rule compared property by property, `done` requiring the command AND the read-back; the forward's row the job's first step through the executor's `forwardStore` (a refusal changes nothing; the definite-failure disposition `settleForward` the job's; a superseded port refused with this id's orphans removed; the reserved ranges recomputed from the rows under the lease); the original snapshot verified by name and timestamp before any remaining write after a write has begun, with `protection`, `partial` and the guidance on the record and no replacement snapshot; **after the review of `e97a66a`** (R-053…R-055, the second checklist below): ownership enforced at the database boundary (the executor's `fencedForwardStore`: every write renews the claim and every held lease inside its own `BEGIN IMMEDIATE`, a lost one rolling back and raising; the per-step `applied` checkpoint required; the settlement propagating fencing, ownership loss and cancellation), the rollback limited to what the operation created (the fenced generated records `forward_row` / `proxy_device` / `firewall_rule`, inherited along the retry chain only from origins that did not succeed; kept changes named, a rejected reconcile reported unresolved), the original snapshot's protection carried across the whole retry chain (`writeBegun` on every checkpoint, `originChain`) with a usable recorded timestamp required; **closing corrections** (R-056 / R-057): rollback ownership stops at the first succeeded ancestor (the snapshot history still walks the whole chain), and a resource present after an interruption with no record of its creation is `present` with ownership uncertain — not removed, not pre-existing, the settlement `unresolved` with the operator action on the record | **done — closed for merge review** (`ad1a638`; the three findings of each review and the two closing corrections closed on the same branch; contract table and both correction checklists below recorded before their edits; HA-11 separate) | `lib/setup-engine/{config-logic,config-op}.js`, `logic.js` (`CONFIG_JOB_KINDS`, `reconcileDecision`'s issued note), `executor.js` (dispatch, keep-alive, `configFence`, `fencedForwardStore`, `originChain`, `ownedFrom`), `backend.js`, `mock2/{deploy,container-lock,ops}.js`, `lib/l4-reserved-ports.js` (`reservedPortsBody`), `routes/lxc.js`, `routes/mcp.js`, `routes/mcp-tools/lxc-admin.js`, `lib/mcp-ext/catalog/lxc.js`, `lib/mcp-logic.js` (descriptions), `setup-guest-config.test.js` (28), `setup-guest-config-review.test.js` (8), `setup-guest-config-review-2.test.js` (5), `immediate-repairs.test.js` (ratchet), `docs/features/setup-engine.md` § "The guest configuration verbs" |
| A7 | Privilege-separation inventory: what the backend container can still do directly (privileged, `pid: host`, Docker socket, `nsenter -t 1`) and what moves behind the runner | **recorded** below and in `docs/features/setup-engine.md`; the reach itself is unchanged (Phase F of the security master-spec remains) | |

**Deployment slice: complete in code — 100 % of its agreed scope** (the
four review issues closed: durable verification, migration-aware
checkpoints, containment, the explicit executor policy; the closeout
replaced session containment with job cgroups, made verification
revision-bound and made the policy promotion evidence-gated). Its
live-host acceptance is outstanding and listed below; **deployment
readiness is not claimed** until that table is run.

**Milestone A estimate: ≈ 90 %** — 88 % accepted with the lifecycle slice
(its two review rounds, R-023…R-028, closed; merged as `6008ce0`), 89 %
with the post-launch slice (A10 / A-17.7, merged as `d95186d`), and the
configuration slice (A11, closed for merge review on its branch) recorded
as the further point. The platform
ledger carries the basis: A-17 is about ten points over nine groups, the
first group was three of them, and this second group (two surfaces, five
phases, one new executor kind, the input store and the retry / resume
rules the later groups reuse) is about one. What keeps the milestone short
of complete: A-16 (the MCP observe verbs), the seven remaining A-17 groups
named in the platform ledger, and Phase F. Live-host acceptance is
separate.

## A-17.8 contract — the guest configuration verbs (recorded before the edit; implemented as row A11)

Platform ledger A-17.8, group 3. Every row below is one caller moved behind
the runner; the shared rules follow the table. Kinds: `config_set`,
`device_add`, `device_remove`, `network_pin`, `forward_apply`,
`forward_remove`, `egress_set` (`lib/setup-engine/config-logic.js`,
`config-op.js`), submitted through `mock2/ops.js` `runGuestConfig` and the
existing orchestrator / executor / store.

| Caller | Authorized inputs (validated at the surface AND by the runner) | Affected resources | Snapshot | Locks | Execution steps (fixed argv) | Success read-back | Interruption / retry | Acceptance test |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Dashboard `POST /containers/:name/resize` (session; `validateName`) → `config_set` | `cpu` integer 1–256 → `limits.cpu`; `memory` integer MB 64–1048576 → `limits.memory=<n>MB`; the guest's identity read at submission (`expect`) | the guest's instance config | none (unchanged contract: limits are live and reversible); the PRIOR values of the changed keys recorded on the job | job claim → guest lease | `incus list` (bind); checkpoint `validated`, `issuing`; `incus config set <name> <key> <value>` per key | `incus list` reads every changed key at its value; a key that does not read back ends `failed at verify` with what was applied | idempotent: resumed by re-reading against the bound identity; the same command re-issued only for a key that does not yet read back; explicit retry the same | `setup-guest-config.test.js` (executor + ops); route source ratchet in `immediate-repairs.test.js` |
| MCP `set_lxc_config` (`confirm: true`; `acknowledge_risk` for `security.privileged=true`; `LXC_CFG_POLICY`) → `config_set` | one allowlisted key + value shape (`CONFIG_KEY_ALLOWLIST` mirrors `lxc-config-allowlist.json`); `acknowledgeRisk` REQUIRED in the plan for `security.privileged=true` and re-checked by the runner; `expect` bound at submission | instance config; a pre-change snapshot | REQUIRED, named at submission (`pp-mcp-pre-<key>-<stamp>`), taken by the job, read back present (name + `created_at`) BEFORE the write; a failed snapshot = nothing changed | job claim → guest lease | as above, with `incus snapshot create` (legacy form discovered) first | as above + the snapshot present; `restart_required` from the policy on the result | as above; the snapshot recorded as generated and REUSED on resume / retry only when name and `created_at` still match (a recreated one refuses) | same file: MCP handler over a fake ctx cannot run (`routes/mcp.js` imports the native db) → source ratchet + the executor path |
| MCP `set_lxc_network` (`confirm: true`; `mode` reserve-current / static; `validIpv4`) → `network_pin` | `ip` IPv4; `expect`; the previous address recorded from the read | the instance-level `eth0` device (`ipv4.address`) | REQUIRED (`pp-mcp-pre-network-<stamp>`) as above | job claim → guest lease | `incus config device override <name> eth0 ipv4.address=<ip>`; on "already exists" → `incus config device set <name> eth0 ipv4.address <ip>` | `incus list` reads `devices.eth0["ipv4.address"] === ip`; `restart_recommended` when the pin differs from the live address (the reservation applies at the next lease) | idempotent, as above | same |
| MCP `set_lxc_resources` (`confirm`, `dry_run`) → `config_set` | `cpu` 1–256, `memory_mb` 64–1048576 (`MiB`), `disk_gb` 1–65536 (`rootSize`) | instance config; the root disk device size | REQUIRED (`pp-mcp-pre-resources-<stamp>`) | job claim → guest lease | the config keys, then `incus config device override <name> root size=<n>GiB` → fallback `device set root size` | every key at its value, `devices.root.size` at its value; a partial application is recorded per key (`applied`, `failed at`) and reported, never a success claim | idempotent | same |
| MCP `add_lxc_device` / `remove_lxc_device` (`confirm`, `dry_run`; reserved names refused; disk source under `lxc_devices.disk_source_roots`; proxy listen port in range and not reserved) → `device_add` / `device_remove` | device name, type `disk` (`source`, `path`, `readonly`, `shift`) or `proxy` (`listen`, `connect`); the runner re-validates the roots and ports from the same policy file | one instance device | REQUIRED (`pp-mcp-pre-device-<stamp>`) | job claim → guest lease | `incus config device add <name> <dev> <type> k=v…` / `incus config device remove <name> <dev>`; an existing device with OTHER properties refuses an add (never replaced) | `incus list` reads the device present with every planned property / absent; the removed device's reference-only properties (`type`, `source`, `path`, `listen`, `connect`, …) recorded as `previous` | idempotent; an add whose device already reads as planned after the interrupted attempt finishes without re-issuing; a remove's absent device counts as this job's work only after `issued: true` | same file: handlers over the fake ctx with the real store + executor |
| MCP `set_port_forward` add / remove (`confirm`, `dry_run`; ports; reserved listen ports) → DB row (backend step) + `forward_apply` / `forward_remove` | `forward` (id, proto, listen[-end], connect[-end], description), `bridgeIp`, `serviceTag`, `reserved` (every enabled UDP range row, recomputed after the row change) | `service_l4_forwards` row (backend); the `ppl4-<id>` proxy device; the `service-l4-<id>` firewall rule; the sysctl reserved-ports drop-in | none (the change is a device + a rule, reversed by `remove`) | job claim → guest lease → `@host/firewall` (waited 20 s, dead holder taken over, still held → `failed` / contended, nothing issued; renewed before every command) | add: `incus config device add … proxy listen= connect=` (exists → `present`), `proxypilot --json firewall add-service-l4 …` (exists → `present`), the reserved-ports refresh (fixed script under `sh -c` with positional arguments, or `rm` + `sysctl -p`); remove: the mirror, absent tolerated | the device read back with the planned listen / connect and the rule present in `proxypilot --json firewall list` (enabled) / both absent; the reserved value read back (`sysctl -n`); the row deleted by the tool on a DEFINITE failure (the record and the response name what the host still holds; the L4 reconciler sweeps the orphan device), kept on an uncertain one | idempotent (every command tolerates its end state); resumed by re-reading | same file, the reserved-ports script under real `sh` |
| MCP `set_lxc_egress` (`confirm`, `dry_run`; `action`, `service`, `reason` ≤ 200) → `egress_set` | `action` allow / deny, `service` name shape, bounded printable `reason` | the firewall's `container_egress` state and the reconciled ruleset (host) | none (host firewall state; an instance snapshot never covers it — stated on the record) | job claim → guest lease → `@host/firewall` | `proxypilot --json firewall egress allow|deny <short-name> <service> [--reason r]` | `proxypilot --json firewall egress list` reads the service present in / absent from the guest's entry; the CLI's reconcile summary (`applied`, `checksum`, `rejection`) recorded | idempotent (allow adds to a set, deny removes) | same |

Shared rules for the group: (1) the surfaces validate and submit, the runner
validates again (`validateConfigParams`: names, allowlisted keys and value
shapes, ports, roots, never a `command` / `argv` / `options` / `script`,
never a secret-looking value) and renders every argv itself
(`configArgv`); under `runner-required` with no live runner the job is
refused (`cancelled` / `runner_unavailable`), never executed in the
backend. (2) The executor holds the guest lease from the read through the
snapshot, the mutation and the read-back; the shared `@host/firewall`
lease is taken after it and released before it; a keep-alive renews the
job claim, the guest lease and every held shared lease every 10 s during a
long command, and a renewal that changes no row stops the job before its
next command (`FencedError` / `SharedLeaseLostError`, the count of
commands issued on the record). (3) Every job binds the guest's identity
(`expect` = `volatile.uuid` + `created_at`, read at submission) and refuses
a guest of another identity with nothing issued; a required snapshot is
read back present before the first mutation and a failed one prevents it;
the record states the coverage honestly: an instance snapshot restores
the root disk only — not attached custom volumes (named), not
ProxyPilot's database rows, not the host firewall state. (4) The
`validated` and `issuing` checkpoints are mandatory; `issuing` records the
target identity, the snapshot's identity and the per-step application so a
resumed or retried job re-reads and converges without replaying blindly.
(5) Results report what was verified: per-key / per-step `applied`,
`partial` when something did not read back, `restart_required` /
`restart_recommended`, `warnings` for a best-effort step (the reserved
ports), and the `jobId` / `job_id` as the durable reference.

## A-17.8 correction checklist — the review of `ad1a638` (recorded before the edit; closed on this branch)

Three findings, closed on the same branch. The reviewer's seven reproductions
are re-established as behavioural tests through the actual handlers, store,
executor and retry / reconcile paths BEFORE the corrections, then asserted
in their corrected form. Scope: the configuration kinds only; nothing else
moves.

| ID | Finding | Correction | Acceptance check |
| --- | --- | --- | --- |
| C-1a | The firewall CLI saves the desired egress / rule configuration in `firewall.json` BEFORE it reconciles; a rejected reconcile leaves the saved configuration in place and `egress list` / `firewall list` show it, so the job read "present" and reported verified success, and a repeated request skipped application | saved configuration and applied policy are two steps: the `egress` / `rule` step verifies the SAVED configuration (and tolerates the CLI's exit 1 only when its JSON shows the save with a `reconcile.rejection`), and a new required `reconcile` step verifies the APPLIED policy through existing interfaces — `proxypilot --json firewall status` (`last_reconcile.applied`, `ruleset_checksum`) against `proxypilot --json firewall reconcile --dry-run` (the desired checksum); evidence missing, a rejection, or a checksum that differs → the step issues `proxypilot --json firewall reconcile` and requires `ok && applied`; a step is `done` only when its command succeeded (or was tolerated by name) AND its read-back holds — exit 1 with a matching read-back is `failed`, never `done` | check 1: an egress allow whose reconcile is rejected ends `failed at reconcile` with the saved entry recorded and no verified success; a retry with the lockout fixed issues no second `egress allow`, issues `firewall reconcile` and ends verified |
| C-1b | forward-rule verification accepted the expected rule ID with the wrong port | `forwardRuleVerdict`: id, `source: service-l4`, `proto`, `port_start`, `port_end`, `scope`, `service` tag and `enabled` compared against the plan; any difference is `present with other properties`, never verified | check 2: a saved rule under the expected id with another port or protocol fails the `rule` read-back and the job never reports verified |
| C-2a | `set_port_forward` inserted / deleted the `service_l4_forwards` row before the job was admitted and rolled it back inside the request: a busy refusal deleted the row without a removal job; a retry of a partial addition could succeed with host resources and no row | the row mutation is the job's first step (`row`), under the guest's lease and `@host/firewall`, through a store the executor hands the operation (`forwardStore`: insert / delete / get / the enabled UDP ranges); the tool only validates, confirms and submits — a refusal at submission changes nothing; the definite-failure disposition (delete the row AND remove the device / rule this attempt added, recorded as `rollback`) is the job's, so it settles whether or not the request is alive; a retry re-inserts the row before it touches the host, and a row that can no longer be inserted (superseded by another forward on the port) is refused explicitly with the orphans of this id cleaned, never a success without a row | checks 3, 4: a refused removal (busy guest) leaves the row and the host untouched; a retry of a partially failed addition ends with the row present and the host applied, or refused with the row absent and the orphans removed — never host resources without a row; plus: the owner dying after the row insert and the device add → the reconcile requeues, the resumed job reads the row and the device as done, issues the rule and the reconcile once, settles once |
| C-2b | the UDP reservation aggregate travelled in the plan, so an older retry replayed a stale aggregate over newer forwards' reservations | the `reserved` step recomputes the aggregate from the authoritative rows under `@host/firewall` at execution time (`forwardStore.reservedRanges()`); the plan carries no aggregate (`reserved` is refused by the validator) | check 5: an older retry run after a newer UDP-range forward was applied writes a drop-in that keeps the newer range |
| C-3 | `issuedBefore` proved that a write began, not that every requested change completed; a job resumed after changing CPU changed memory with its original snapshot missing or replaced | before any REMAINING mutation the original snapshot's identity (name + `created_at`, the record's own or the retry origin's) must be verifiable on the guest; missing, replaced or unrecorded → no further write: the completed changes are read back (`done`), the first step needing a write ends the job `failed at protect` with `protection: missing \| replaced \| unverifiable`, `partial: true`, the prior values on the record and recovery guidance; no replacement snapshot is ever taken and presented as the original; a retry whose origin had issued gets the same rule (`originIssued`) | checks 6, 7: a resumed `config_set` with CPU applied and the snapshot gone, or replaced under its name, reads CPU back as done and does NOT set memory; a request whose remaining state already holds still completes read-only |

Shared: authorization, confirmations, validation, fixed argv, redaction,
the lease order (claim → guest → `@host/firewall`), the keep-alive and the
fencing are unchanged; the CLI fixtures model the save-before-reconcile
order (`firewall.json` written, then `reconcile` recorded in
`firewall_reconciles`), with `status` and `reconcile --dry-run` as the
evidence the job reads.

Evidence (closed): `setup-guest-config-review.test.js` — the seven
reproductions plus the interrupted row-settlement path — imports only
symbols that exist at the reviewed head and was run against `ad1a638` in a
worktree before the corrections: all seven fail there for the reviewer's
reasons (1: `ok: true` with the egress step `exit: 1`; 2: `added: true`
with the rule saved on port 7882; 3: the row removed on a busy refusal;
4: the device left with no row; 5: the drop-in holding only the older
range; 6 and 7: memory changed to 4096MB), and all eight pass on the
correction; the eighth fails at the head only because the plan's
`serviceId` did not exist there. The main suite's "dead-gone" case and
the boot-sweep retry were corrected to the new contract (no write without
the original snapshot). Review decisions R-050…R-052 in the platform
ledger.

## A-17.8 correction checklist — the review of `e97a66a` (recorded before the edit; closed on this branch)

Three findings on the corrected head, closed on the same branch. Four
reproductions are established as behavioural tests through the actual
store, executor, retry and reconcile paths BEFORE the corrections (the
review file imports only symbols that exist at `e97a66a`, so it runs
unchanged against that head), then asserted in their corrected form.
Scope: the configuration kinds only; nothing else moves.

| ID | Finding | Correction | Acceptance check |
| --- | --- | --- | --- |
| C-4 | Ownership is not enforced at the database mutation or the rollback: `settleForward` deleted the forward row before any ownership check, every cleanup step caught a fencing error and recorded it as a best-effort warning, the executor's `forwardStore.delete` was an unconditional `DELETE`, and the `applied` checkpoint was best effort — so a worker whose claim the reconciler had expired and requeued (another owner then holding the guest's lease and completing the job) still deleted the new owner's row on the way out | the executor's forward store enforces the job claim and every held lease epoch at the mutation boundary: each `insert` / `delete` runs under `BEGIN IMMEDIATE`, renews the claim (`heartbeat`), the guest's lease and every held shared lease at the epochs this worker holds inside the same transaction and rolls back with `FencedError` / `SharedLeaseLostError` when any renewal changes no row (the keep-alive's recorded loss refuses at once); `get` and `reservedRanges` fence before they read; `settleForward` fences before it starts, lets fencing, ownership-loss and cancellation propagate immediately (only a host read-back failure stays best effort, recorded as `unknown`), and the per-step `applied` checkpoint is required — a checkpoint that changes no row stops the job before any cleanup (a fenced worker throws `FencedError`; an unrecorded outcome ends `failed at checkpoint` with no rollback attempted) | check 8: a forward job whose device command fails, with the runner's actual `reconcile()` expiring and requeuing it during the following read and another owner claiming, running and completing it — the old worker returns `fenced`, issues no further command, and the new owner's row, the guest's lease, the job record (`succeeded`) and the device and rule are preserved; the store itself refuses a delete and an insert after a takeover with `FencedError` and changes nothing |
| C-5 | Rollback removed whatever matched the forward's ids without establishing that this operation created them: a retry of a completed forward whose reconcile was rejected by an unrelated saved policy change read the row, the device and the rule as already correct and then deleted all three | ownership is a persisted engine record, never inferred from an id, an `already` state or an issued command: the job records what it CREATED (`recordGenerated`: `forward_row`, `proxy_device`, `firewall_rule` for this forward's id) only after the create reported success and was not tolerated by name, in the fenced progress record; a resumed attempt reads its own records, a retry inherits its origin chain's records only from origins that did not succeed (a succeeded origin's changes are the operator's working state); pre-existing state is recorded on each step (`owned: false`); `settleForward` removes only owned changes and reports every kept one with the reason (`kept: not created by this operation`), and a failed reconcile is reported as unresolved with the rejection on the record instead of a rollback | check 9: a working forward (its job succeeded), then an unrelated rule saved with the reconcile rejected, then a retry of the completed job: it fails at `reconcile` naming the rejection, the row, the device and the rule survive (`kept`), and the response says the policy is unresolved; check 9b: a fresh forward that fails after its row and device were created still removes both, and does so after an interruption between the device and the rule (the resumed job settles its own creations) |
| C-6 | The original snapshot's protection was lost across the retry chain: `originIssued` read only the immediate parent's `issued`; a retry refused at protection recorded `issued: false`, so a retry of that retry created a replacement snapshot and continued; and the reuse match treated a recorded snapshot without a timestamp as a wildcard | the protection follows the intent, not the attempt: every checkpoint of the chain records `writeBegun: true` once a write began anywhere in it, the executor walks the whole `retry_of` chain (same app and kind) for `issued` / `writeBegun` and for the recorded snapshot identity (the origin chain's generated records), and the protect phase requires a usable identity — a recorded name with no timestamp, or a timestamp that differs, is `unverifiable` / `replaced`, never reused; no replacement snapshot is taken at any depth of the chain; read-only completion still succeeds; a request submitted without `retryOf` is a new intent with its own snapshot name | check 10: a `config_set` interrupted after its first write with the original snapshot lost, then its retry, the retry of that retry and a resume of that retry after a dead owner: every attempt ends `failed at protect`, issues no remaining change and takes no snapshot; a deliberately new request afterwards takes its own snapshot and applies; check 11: a resumed job whose recorded snapshot has no timestamp, with a snapshot of that name on the guest, refuses the remaining write as `unverifiable`, and a job that has not written yet refuses to proceed behind such a record |

Shared: authorization, confirmations, validation, fixed argv, redaction,
the lease order (claim → guest → `@host/firewall`), the keep-alive and the
fencing before every command are unchanged; the fenced store adds the same
checks at the database boundary. The seven reproductions of the previous
review and the 24 main tests keep passing.

Evidence (closed): `setup-guest-config-review-2.test.js` — the four
reproductions plus the fresh / interrupted settlement non-regression —
imports only symbols that exist at the reviewed head and was run against
`e97a66a` before the corrections (in place, with the code still identical
to that head, and again from a worktree at that head with the final file):
8 fails there with the new owner's row deleted (`[]` where `f1` was),
9 with the working forward's row deleted, 10 with the retry of the retry
`succeeded` (`config:limits.memory done`, a replacement snapshot taken),
11 with memory changed to 4096MB behind the timestamp-less record; 9b
passes on both sides as intended. All five pass on the correction, with
the eight of the first review, the 26 of the main suite (two new: the
fenced store and the chain / ownership helpers) and the extended ratchet.
Review decisions R-053…R-055 in the platform ledger.

Closing corrections (R-056, R-057), the last two of the slice: ownership
inheritance stops at the first succeeded ancestor (an old failed
ancestor's records no longer authorize deleting the working forward a
successful retry established), and a resource created by an interrupted
attempt before its ownership record persisted is reported `present` with
ownership uncertain — never `already`, never removed, the settlement
`unresolved` with the operator action in the reason and the
recovery-required verification. Both regressions in
`setup-guest-config.test.js` fail without the two fixes and pass with
them; automatic ownership reconstruction and cleanup are deferred to the
backlog. The slice is closed for merge review; nothing further is planned
on it before HA-11.

## Milestone B — setup APIs and the guided frontend wizard

Partial: G1 (platform delivery ledger, bounded G1–G10 section) provides an
admin-only planning/review page, SQLite draft (migration 1002), read-only
preflight and existing-job observation. `platform-setup.test.js` and the browser
verification script prove persistence across API restart, refusal boundaries and
truthful states. The browser never declares a fresh installation or completion;
service execution/activation and wizard retries remain later slices. Reuses
A3–A6 without modifying the runner.

## Milestone C — service adapters and identity integration

G2 provides the bounded Keycloak install/connect adapter; see the fixed G2
checklist and evidence in `platform-delivery-ledger.md` and the G2 operator
section of `docs/features/setup-engine.md`. It adds migration 1003,
`keycloak_setup` to the existing runner and `configure_keycloak_route` to the
existing backend drain. Both reuse the saved jobs, leases, fencing and restart
reconciliation. G2 `a039761` is accepted and merged by #614.

G3 extends the existing frontend guide and local authentication with explicit
issuer/subject linking, Keycloak passkeys, OIDC sudo, restricted local recovery and
server-enforced activation. Migration 1004 stores configuration/links/evidence and
encrypted credential references. `verify_sso` and `configure_recovery_route` are
bounded backend-drain jobs, using the existing job/app/route leases, fencing,
keep-alive and restart reconciliation. They carry configuration fingerprints, not
secrets. No host runner kind, installer/update behavior, A-17 or Phase F is added.
The existing root recovery command and machine authentication remain unchanged.

G3 fixed criteria/evidence are in the platform ledger; operator guidance is in
`docs/features/guided-sso.md`. Affected sequential verification: 232 tests,
231 pass / 0 fail / 1 existing process-reap skip; focused G3: 12 pass. Real disposable
Keycloak 26.7.4/Chromium virtual-passkey ceremonies and an IdP-stopped local recovery
are separate from scripted Caddy/host execution. Frontend build and responsive
browser checks pass; final accessibility metrics are in `docs/evidence/g3-browser.json`.
The user accepted G3 `4e7b257` and authorized its merge in PR #615 on 2026-09-22.
At G3 acceptance, guided progress was **30% (3/10: G1, G2 and G3)**. With G4
accepted below and historical G5 acceptance recorded in the recovery section,
current accepted progress is **50% (5/10)**; G6–G10 remain planned and
the milestone denominator is unchanged. Live-host acceptance limitations
remain separate; this merge does not authorize deployment or live-service changes.

## Milestone D — platform-aware app provisioning and maintenance

≈ 0–5 % (unchanged). Registry, shared integrations, coordinated lifecycle.

## Remaining in milestone A

| Item | Note |
| --- | --- |
| MCP verbs `list_setup_jobs`, `get_setup_job`, `request_app_recovery` | The lock already binds every MCP mutation through `withContainerLock`; the observe/request verbs are REST-only today |
| Dashboard surface | G1 now observes `/api/setup` jobs, verification, locks and redacted events. Recovery/retry controls remain future B-05/G9 work. |
| Credential migration under the lock | The operation itself is milestone C; when it exists it takes the same lease (`withContainerLock`, kind `credential_migration`) |
| Phase F, and the operations still on the container's pivot | With the runner live, the deploy, both restores, the retry-path mint, the Incus lifecycle / snapshot verbs, the post-launch / post-start guest setup (NAT, the address wait, DNS, the init script) and the guest configuration verbs (config keys, resources, devices, the address pin, port forwards, egress, and their pre-mutation snapshot) of the dashboard and MCP no longer run under the container's nsenter pivot. Still on it, by group (platform ledger A-17.9…A-17.14, and A-17.8a for what group 3 left by file and verb): rename, clone, import / export and the transports' temp instances; project provisioning and the idle sweep (with `set_project_resources`' own config writes and snapshot, and the promote's snapshot); the component pre-install; Caddy and the services router's own L4 reconcile (`routes/services.js`, the boot-time `lib/l4-startup.js`), which is why the create-time route render and the forward ROW stay backend steps; storage and migration transports; the terminal, `run_lxc_command`, the file tools, host service control, the firewall page's writes and every read. Each is a candidate for the same treatment (a job kind + the runner, or the unprivileged agent); `privileged: true`, `pid: host` and the Docker socket stay until they are all moved (master-spec Phase F) |
| The legacy in-process executor | Exists only under `SETUP_EXECUTOR_POLICY=backend-allowed`: development checkouts, an operator's explicit choice, and an installation whose runner did not verify at install/update time (install.sh writes `backend-allowed` first and promotes only on evidence, logging an error otherwise). Retiring it entirely is a later decision once no supported host needs it |
| Containment limits (recorded, not open defects) | Job cgroups cover every process a deploy script starts, in any session. Outside them by design: the app's own service (its unit's cgroup), an operator's shell, and the executor's short verification/recovery probes; the reap acts at takeover, not continuously; `cgroup1` kills by loop and reports what it missed. The systemd-scope form is host acceptance (no systemd in the sandbox) |

## Overall new-platform repository work: ≈ 40 %

Basis: milestone A at ≈ 90 % with the configuration slice (A11: seven
kinds, eight callers, the read-before-issue rule and the job-owned
snapshot the later groups reuse). Milestone A is one of four milestones of
unequal size, so the overall figure moves by well under a point; 40 %
rounds the earlier 39 % estimate rather than reporting newly delivered
functionality beyond A11. The weighting keeps the runner / engine and the
wizard as the bulk of what remains.

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
installation (the in-process executor exists only under the explicit
`backend-allowed` policy); the restores slice moved three more: the
database restore, the snapshot restore and the retry-path mint; the
lifecycle slice moved seven verbs: the Incus create, start, stop, restart
and delete, and the snapshot create and delete, for the dashboard and MCP;
the post-launch slice moved what followed them: the host NAT commands, the
address wait, the guest's resolv.conf and the operator's init script (the
script an input file the backend writes and the runner reads by digest —
never a row), leaving only the route rows and their Caddy render in the
backend as its own recorded step, because Caddy is a later group; the
configuration slice moved the guest configuration verbs — the resize, the
config keys, the address pin, the resources, the devices, the port
forwards' host side and egress, with the MCP verbs' pre-mutation snapshot
taken by the job — leaving the forward's row in the backend as its own
step for the same reason.
They removed nothing from the container itself: `privileged: true`,
`pid: host`, the Docker socket and the nsenter pivot remain for rename /
clone / import / export and the transports, project provisioning and the
idle sweep (with their own resource and snapshot writes), the component
pre-install, Caddy and the services router's L4 reconcile, storage,
migration, the workspace terminal and every read (platform ledger
A-17.9…A-17.14 and A-17.8a name each by file and verb). Until the
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
| A9: the lifecycle group's host acceptance is platform-ledger HA-09 (dashboard start / stop / restart / reboot owned by the runner and agreeing with `incus list`; a running guest's Start issuing nothing; container and VM creation with exactly the allowlisted config and the init script still applied; a missing-image create leaving no half-created guest; the snapshot dialog's poll to `done` with a note; the sudo prompt on a dashboard snapshot delete; MCP `delete_lxc_container` refusing its first token after the guest was recreated under the same name; the runner killed between a delete's stop and delete → resumed; killed during a restart → `interrupted_uncertain`; the runner stopped → a start refused, not queued; the legacy snapshot verb) | outstanding — scripted host evidence and the argv hand-off to the real spawn only |
| A10: the post-launch group's host acceptance is platform-ledger HA-10 (a dashboard create with an init script and two services on a `runner-required` host: the five phases on the setup record, the resolvers and `/var/log/pp-init-<job>.{rc,log}` in the guest, no input file left, the routes served, no line of the script in a row, an event or the runner's journal; the browser closed and the backend restarted mid-script → the poll continues from the records; the runner killed mid-script → the record reads the exit the guest recorded or `init_uncertain`, the script ran once; a retry redoing NAT / DNS and skipping the init; a nonzero exit named in the toast with the guest usable; a conflicting domain reported and untouched; two guests created at once serialised on `@host/network` and `@host/routes`; start / restart / reboot answering with `setupJobId`; MCP's create carrying `setup_job_id` and the address; a create refused with the runner stopped; a guest with no containment mechanism created with its guest phases refused by name) | outstanding — scripted host / guest evidence, the guest scripts under the sandbox's `sh`, the timeout kill with real processes under the sandbox's cgroup1 pids containment (a `setsid` writer outliving its parent, stopped by the group kill; held when the record is missing), the routes step through the production adapter over the real schema with a Caddy over a temp dir; the systemd-scope form of the kill and the real Caddy are the host's |
| A11: the configuration group's host acceptance is platform-ledger HA-11 (`set_lxc_config` owned by the runner with the planned snapshot present and `incus config get` agreeing, the repeat issuing nothing; the privileged flip refused without the acknowledgement at the tool and at the runner; the dashboard Resize with `jobId` and no snapshot; the address pin; a device under `/srv/shares` and one refused for `/etc`; a UDP-range forward's device, rule, drop-in and `sysctl` agreeing and its remove; egress allow / deny in the CLI's listing; two forwards serialized on `@host/firewall`; the runner killed mid-`set_lxc_resources` resumed with the snapshot reused and only the remaining key issued; a Stop refused during a configuration job; the runner stopped → refused, nothing changed; no `user.*` value on any record) | outstanding | `docs/features/setup-engine.md` § Host acceptance |
| A8: the restores' host acceptance is platform-ledger HA-08 (dump restored under the current configuration; a pre-deploy dump refused without and restored with its environment copy; bind and format refusals; the runner killed mid-restore; a custom-volume guest refused then partial; the pre-restore snapshot reused by timestamp; the legacy Incus verb; a restore refused with the runner stopped) | outstanding — scripted guest/host evidence only, plus real AES-GCM rows and a real process for the host channel |
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
| A8 | after the restores slice (on `main@7d6e5ab`) | 2874 | 2863 | 4 | 7 | the same four files (each fails at load: "Could not locate the bindings file" for the native `better-sqlite3`, reproduced file by file in this sandbox — an environment cause, `docs/known-issues.md`), the same seven skips; +21 tests from `setup-restores.test.js` (two with real processes, real AES-GCM rows in the compatibility check); the base `7d6e5ab` measured 2853 / 2842 / 4 / 7 in this sandbox (the `4c9ef02` row below) |
| A9 | after the lifecycle group and its two review rounds (this branch, on `main@fb7a89d`) | 2898 | 2887 | 4 | 7 | +24 tests (23 in `setup-lifecycle.test.js`, one ratchet in `immediate-repairs.test.js`), all passing; the base `fb7a89d` measured **2874 / 2862 / 5 / 7 in this sandbox** (sequential run): the four native-module files (`docs/known-issues.md`) plus the cgroup2 form of the containment real-process regression, which is intermittent under the FULL parallel `node --test` run on this host (it failed on the base run and on the branch's first two runs, passed on the third) and passes when `setup-deploy-closeout.test.js` runs alone (13 / 0 / 1 skip) — an environment condition, seen on both sides (platform ledger R-022). This sandbox had no `node_modules`; they were installed with `--ignore-scripts` (R-015) |
| A10 | after the post-launch group (`92404d9`, on `main@6008ce0`) | 2935 | 2924 | 4 | 7 | +30 tests (29 in `setup-post-launch.test.js`, one ratchet in `immediate-repairs.test.js`), all passing; no test removed or renamed (the test-name lists of both runs differ by exactly those thirty); the base `6008ce0` measured **2905 / 2894 / 4 / 7 in this sandbox** in a worktree, both runs sequential (`--test-concurrency=1`, never concurrent, so the containment real-process regression shared no cgroup path with anything): the same four native-module files (`docs/known-issues.md`) and the same seven skips (five Playwright cases, the closeout sentinel, the ZFS loop-device test) on both sides. This sandbox had no `node_modules`; they were installed with `--ignore-scripts` (R-015) and linked into the base worktree |
| A10 review fixes | after the four review fixes (R-034…R-037; this branch) | 2938 | 2927 | 4 | 7 | +33 tests over the base (32 in `setup-post-launch.test.js`, one ratchet in `immediate-repairs.test.js`; +3 over `92404d9`); the tests that asserted the reviewed behaviour — the released lease, the skipped-and-complete retry, the output tails — replaced, not kept; the base `6008ce0` measurement of this session (2905 / 2894 / 4 / 7, same sandbox, a worktree, sequential) is the comparison: the same four native-module files and the same seven skips on both sides, the test-name lists differing by exactly the thirty-three; sequential run (`--test-concurrency=1`) |
| A10 second review fixes | after the two second-review fixes (R-038…R-039; this branch) | 2943 | 2932 | 4 | 7 | +38 tests over the base (37 in `setup-post-launch.test.js`, one ratchet in `immediate-repairs.test.js`; +5 over the first review fixes: four route-ownership tests through the production adapter and the real-process timeout-kill regression); the pid-only timeout test rewritten to show what it could never establish (a `setsid` descendant surviving a session kill, `norecord`), not kept; the same four native-module files and the same seven skips as the base `6008ce0` measurement (2905 / 2894 / 4 / 7, same sandbox, sequential); with one extraction rule over both TAP files no test name is missing from the branch and thirty-eight are new; the real-process regression ran under the sandbox's cgroup1 pids controller (`/sys/fs/cgroup/pids`, no systemd) with every process, cgroup, `/run/mock2-deploy` record and `/var/log/pp-init-*` artifact removed afterwards; sequential run (`--test-concurrency=1`) |
| A10 third review fix | after the heartbeat fix (R-040; this branch) | 2944 | 2933 | 4 | 7 | +39 tests over the base (38 in `setup-post-launch.test.js`, one ratchet in `immediate-repairs.test.js`; +1 over the second review fixes: the job-claim heartbeat regression through the production adapter with the real timer keep-alive and the runner's actual `reconcile()`); the same four native-module files and the same seven skips as the base `6008ce0` measurement (2905 / 2894 / 4 / 7, same sandbox and dependency tree, sequential; not repeated — nothing in the environment changed); with one extraction rule over both TAP files no test name is missing from the branch and thirty-nine are new; the real-process containment regression ran again under the sandbox's cgroup1 pids controller with nothing left behind; sequential run (`--test-concurrency=1`) |
| A11 | after the configuration group (this branch, on `main@d95186d`) | 2969 | 2958 | 4 | 7 | +25 tests over the base (24 in `setup-guest-config.test.js`, one ratchet in `immediate-repairs.test.js`), all passing; the test-name lists of the two runs differ by exactly those twenty-five; two existing assertions updated for the new kinds (the runner-kind registry in `setup-deploy.test.js`, the snapshot-helper caller count in `mcp-logic.test.js`, which now asserts the two tools plan their snapshot for the job); the base `d95186d` measured **2944 / 2933 / 4 / 7 in this sandbox** in a worktree, both runs sequential (`--test-concurrency=1`, never concurrent, the neighbouring engine suites also run one file at a time beforehand): the same four native-module files (`docs/known-issues.md`; `node_modules` installed with `--ignore-scripts` as in R-015) and the same seven skips on both sides; the reserved-ports drop-in script under the sandbox's real `sh`, the firewall CLI and `incus` scripted, the runner's `reconcile()` real; host acceptance HA-11 pending |
| A11 review fixes | after the three review fixes (R-050…R-052; this branch, on `main@d95186d`) | 2977 | 2966 | 4 | 7 | +33 tests over the base (24 in `setup-guest-config.test.js`, 8 in `setup-guest-config-review.test.js`, one ratchet in `immediate-repairs.test.js`; +8 over `ad1a638`), all passing; no test removed (the test-name lists of the two runs differ by exactly those thirty-three); the main suite's "dead-gone" case and the boot-sweep retry rewritten to the corrected contract, not kept; the review file run against `ad1a638` beforehand: the seven reproductions fail there for the reviewer's reasons and pass here; the base `d95186d` measured **2944 / 2933 / 4 / 7 in this sandbox** in a worktree, both runs sequential (`--test-concurrency=1`, never concurrent; the neighbouring engine suites also run one file at a time beforehand: all passing), the same four native-module files (`cve-research`, `cves`, `incus`, `webauthn` — `docs/known-issues.md`) and the same seven skips (five Playwright cases, the containment sentinel, the ZFS loop-device cycle) on both sides; host acceptance HA-11 pending |
| A11 second review fixes | after the three fixes of the second review (R-053…R-055; this branch, on `main@d95186d`) | 2984 | 2973 | 4 | 7 | +40 tests over the base (26 in `setup-guest-config.test.js`, 8 in `setup-guest-config-review.test.js`, 5 in `setup-guest-config-review-2.test.js`, one ratchet in `immediate-repairs.test.js`; +7 over `e97a66a`), all passing; no test removed (the test-name lists of the two runs differ by exactly those forty); the new review file run against `e97a66a` beforehand (in place before the edit, then from a worktree with the final file): the four reproductions fail there for the reviewer's reasons and pass here, the non-regression case passes on both; the base `d95186d` re-measured **2944 / 2933 / 4 / 7 in this sandbox** in a worktree, both runs sequential (`--test-concurrency=1`, never concurrent; the affected engine suites also run one file at a time beforehand: all passing), the same four native-module files (`cve-research`, `cves`, `incus`, `webauthn` — `docs/known-issues.md`) and the same seven skips on both sides; host acceptance HA-11 pending |
| A11 closing corrections | after the two closing corrections (R-056 / R-057; this branch, on `main@d95186d`; the slice closed for merge review) | 2986 | 2975 | 4 | 7 | +42 tests over the base (28 in `setup-guest-config.test.js`, 8 in `setup-guest-config-review.test.js`, 5 in `setup-guest-config-review-2.test.js`, one ratchet in `immediate-repairs.test.js`; +2 over `bf85f65`), all passing; no test removed (the test-name lists differ from the base run by exactly those forty-two); the two new regressions fail with the two library files stashed and pass with them; the base `d95186d` measurement of this session (**2944 / 2933 / 4 / 7**, sequential, in a worktree) reused — the base tree and the sandbox are unchanged; the same four native-module files and the same seven skips on both sides; host acceptance HA-11 pending |
| A2d | after the closeout (`f23dc47`; the policy-preservation ratchet added after it changes no count) | 2853 | 2842 | 4 | 7 | same four files; the seventh skip is the closeout sentinel, which skips when the real-process regression ran on at least one mechanism and FAILS on a host with none; +14 tests from `setup-deploy-closeout.test.js` (three with real processes: the setsid regression on cgroup v2 and on cgroup v1, and the refusal), −1 from `setup-deploy-finish.test.js` (the session-based real-process test, superseded). The base was re-run in the same sandbox for this row: `d9a6eb4` in a worktree gives 2751 / 2741 / 4 / 6 (2736 counted when `cli/node_modules` was not linked, `vpn-mtu` then failing to load as one test: 2736 − 1 + 16 = 2751) |

The sandbox differs from the one the gate-one handoff reported (2674 tests,
10 failing files there): this one has `ldapts` and the CLI's dependencies
installed, so `ldap.test.js` and `vpn-mtu.test.js` run. Compare like with
like: the baseline row above was produced in this sandbox on the exact
base commit.

## G4 contract recorded before implementation (2026-09-22)

G4 only, `feat/g4-guided-pomerium` from `main@66624b5`, with accepted G3
`4e7b257` verified merged. The six fixed criteria are recorded in the existing
platform-delivery ledger's G4 table. Reuse this engine's jobs, leases, fencing,
backend Caddy drain, saved platform plan and protected secret references.
Accepted progress stays 30% until G4 review; no A-17 or Phase F continuation.


### G4 implementation evidence (2026-09-22; review pending)

Added runner kind `pomerium_apply` and backend kind `configure_pomerium_routes`.
Both carry only the saved revision reference (backend also records deny/gateway
stage). They reuse the application's lock, host route lease, heartbeat/fencing,
durable progress and reconciliation. Secrets are encrypted references; private
revision files and owned resource labels preserve retry identity. Changes never
restore an unprotected upstream on failure; explicit removal is separately
reviewed. An unsuccessful initial denial reload names the remaining running
upstream risk and does not certify protection.

Twenty focused G4 tests pass, including a real API process restart, interrupted
runner retry, external read-only inspection, failed gateway probe followed by a
durable denial child, failed initial Caddy denial, and explicit removal. The
affected set is 188 tests / 187 pass / one existing host-containment skip. The
additional closeout sentinel reports no writable cgroup/systemd; it is not a G4
regression or authorization for A-17 work. Frontend build and 15 responsive
checks pass; axe zero and Lighthouse 95. Host commands are scripted, while
HTTP/SQLite/crypto and Chromium execute for real. Docker/Core, Keycloak through
Core and actual Caddy execution remain outstanding as explicitly described in
`docs/evidence/g4-acceptance.md`. Backup references use existing DB/env and
companion encrypted file packs; no new backup engine. Accepted progress remains
30% pending G4 review. No later milestone, installer/updater or live changes.


### G4 review correction — pinned image environment compatibility

The official image fixture now includes its inherited CA setting. Two regression
paths failed against `dff6e18`: managed runtime reinspection after first install
and existing-container connection. The runtime guard now accepts exactly
`SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt`, without relaxing the remaining
image/command/environment ownership checks. Tests also refuse changed, empty or
conflicting CA settings and unrelated overrides before runtime mutation.

Managed install → repeat adapter apply → route protection reuses resources and
secrets; external connection/retry stays read-only. **22 focused tests pass;
affected 190 total / 189 pass / one existing containment skip; frontend build
passes.** Actual Core parser acceptance was reported by the user's independent
review; full startup/login encountered a sandbox socket restriction. Existing
real login/Caddy integration checks remain outstanding. No engine redesign,
installer/updater, A-17, Phase F or later G work. Accepted progress stays **30%**
until G4 acceptance, then **40%**. Evidence: `docs/evidence/g4-acceptance.md`.

### G4 review acceptance (2026-09-22)

The user accepted corrected head `6c3bdcb` and authorized merge in PR #616.
Accepted guided progress is now **40% (4/10)**, superseding the pending entries
above. The six fixed G4 criteria remain the contract; this follow-up records
acceptance only and changes no tested runtime code.

Evidence remains 22 focused passes, affected 189 pass / one existing containment
skip, successful frontend build and retained responsive checks. Actual Core
parser acceptance was reported by the independent review; full startup hit an
Envoy sandbox socket restriction. Real Pomerium–Keycloak allowed/denied login and
Caddy execution remain outstanding integration checks. Separate production host
and outage limits remain in `docs/evidence/g4-acceptance.md`. Merge authorizes no
deployment or live changes. No G5–G10, A-17 or Phase F continuation; stop at G4.


### G5 accepted-work recovery (2026-09-22)

G5 was accepted at unavailable `a436546`; accepted guided progress is **50%
(5/10)**, not another milestone. This branch reconstructs missing pieces on
`main@d2ca73a`, which already contains accepted G4/PR #616. The original full tree
cannot be certified identical. All 24 surviving source/test files, including this
engine's recovered integrations, are unchanged and SHA256-verified against
`docs/evidence/g5-recovered-files.json`. Remote checkpoint `ee3845f` preserves them
before reconstruction. The original six G5 criteria are recorded in the platform
ledger; no new completion gate is added.

Recovered engine paths remain the implementation: migration 1006, encrypted
`setup_infisical_credentials`, immutable reviewed configuration, `infisical_apply`
runner operation, `configure_infisical_route` backend child, shared app/route/VM
leases and existing restart reconciliation. Only the missing frontend API/page/
component, guidance and current verification artifacts are restored. No runner,
installer, updater, existing credential or later milestone redesign.

Fresh affected execution: **210 tests / 209 pass / zero fail / one existing
containment skip**. This includes 19 recovered G5 setup tests and actual pinned
CLI 0.43.133 substitution/denial with a real Python consumer/destination but
scripted upstream Infisical responses. UI and API restart, failure/retry, install/
connect/skip, redaction, current production build and responsive checks are in
[the current acceptance record](../evidence/g5-acceptance.md). Initial missing CLI
bcryptjs was resolved by installing the locked CLI test dependencies, with no
source/package changes. Native better-sqlite3/full entrypoint boot remains untested;
fixtures use node:sqlite and actual production route/auth/job code.

[Operator guidance](../features/guided-infisical.md) names the external bootstrap
handoff, exact policies, supported proxy isolation, and matching service-data/
encryption-key backup set through existing packs. Real Docker/Incus/Caddy/
Infisical/PostgreSQL/Redis host acceptance remains outstanding separately; G4's
real login/Caddy limits are unchanged. The recovery is published for PR review,
not merged or deployed. No live services, DNS, databases or credentials changed.

### G6 authorization and G5 acceptance (2026-09-22)

G5 accepted recovery `31d0c87b2b1fd4e00c24773e6ae0435e387c70a3` is published and
merged by PR #617 as `e9430a2314c881c23fbecc74c25acf8ac62661c2`. G6 branches
from that current main. The six fixed G6.1–G6.6 criteria and scope are recorded
in `platform-delivery-ledger.md` before implementation. Reuse the existing
plan, runner, jobs, leases, credential references and Caddy path. Guided
progress stays **50% (5/10)** pending G6 acceptance; earlier host acceptance
remains separately pending. No merge, deployment, live changes or later slice.


### G6 repository delivery — review pending (2026-09-22)

OpenBao now uses the existing saved platform plan, runner, persistent jobs/leases,
protected references and Caddy renderer. Migration 1007 adds only OpenBao state
and encrypted identity references. Saving is inert; `openbao_apply` carries only
a saved revision. `openbao_operator` holds the same service lease while handling
transient share/bootstrap inputs, and interruption records recovery required
without replay or a guest-recovery job. Owned Caddy children retain their job
reference through runner/API restarts.

The fixed G6.1–G6.6 contract remains in `platform-delivery-ledger.md`. All six have
repository implementation and focused acceptance evidence: install/connect/skip;
PGP-protected initialization/acknowledgement and manual unseal; exact Keycloak
mapping plus separate AppRole; selected disposable PostgreSQL reader/revocation;
configuration/cluster-bound retry and backup guidance; auth/redaction, affected
regressions and responsive UI checks. Actual 2.6.2 initialization, restart/unseal,
AppRole and OIDC engine execution passed; its OIDC provider was scripted. Real
Docker/Caddy/Keycloak and PostgreSQL credential execution remain pending here.

[G6 execution evidence](../evidence/g6-acceptance.md) separates real services from
scripted production adapters and documents initial failures, corrections and
precise environment limits. [Operator guidance](../features/guided-openbao.md)
covers the dedicated client, public database CA, separate recovery custody,
manual restart recovery and compatible snapshot/configuration backups using
existing mechanisms. No new backup, restore or upgrade framework.

Published on `feat/g6-guided-openbao` for review. **50% (5/10)** remains accepted;
G6 acceptance would make **60% (6/10)**. No merge, production/live changes,
G7–G10, A-17, Phase F or installer/updater/U1/U2 changes. Earlier host acceptance
items are unchanged and are not new G6 completion gates.


### G6 narrow review correction — runner key loading (2026-09-22)

The independent review found a reproducible G6.5/G6.6 fresh-runner defect:
`setup-runner` located `.env` but did not load its existing encryption key.
The bounded command-startup correction now loads and validates that key before
`serve`/`once` opens the queue, preserves the file and ciphertext, and refuses
missing/malformed/conflicting keys without claiming jobs. Inspection and
reconciliation remain available for recovery. No runner redesign or key rotation.

Three fresh-process regressions reproduce the failure before the fix and pass
after it, without an inherited key or fixture key cache. Current affected tests:
**187 pass** (same separately excluded cgroup-host assertion); frontend build
passes, with frontend source unchanged. Full evidence and precise scripted-service
boundaries are in `docs/evidence/g6-acceptance.md` under the review correction.
PR #618 remains unmerged. **50% (5/10)** remains accepted until this correction is
reviewed and accepted, then **60% (6/10)**. Real PostgreSQL, Keycloak/Caddy and
restore acceptance remain separate. No installer/updater/U1/U2 or live changes.


### G6 review acceptance (2026-09-22)

The user accepted the corrected G6 head
`6e48d89dedb058b8d760556b448d00042909b057` and authorized merging PR #618.
Accepted guided progress is now **60% (6/10: G1–G6)**. This supersedes the
pending-review status and no-merge restriction for this PR in the records above.
The six fixed G6 criteria and ten-milestone denominator are unchanged.

The accepted correction loads and validates the existing installation encryption
key before runner jobs, preserving the key and ciphertext. Evidence: 187 affected
passes, three fresh-process startup regressions, successful frontend build, and
the recorded OpenBao/adapter/browser checks. This acceptance commit changes
only documentation after the tested code at `6e48d89`.

Real PostgreSQL credential execution, Keycloak/Caddy integration and compatible
restore remain separate host-acceptance items, alongside earlier recorded limits
and the existing cgroup-host exclusion. This merge authorizes no production
rollout, live DNS/database/identity changes, credential rotation, service restart,
infrastructure rebuild or G7–G10 work.


### G7 authorization and accepted G6 ancestry (2026-09-22)

PR #618 merged as `24ba567eea4a5bd6f469b1f3fa30c0857201dfae`; accepted
`6e48d89dedb058b8d760556b448d00042909b057` is an ancestor. G7 branches from
that current main on `feat/g7-guided-vaultwarden`. The six fixed criteria and
stopping rule are recorded in the platform delivery ledger. Reuse saved plans,
runner/jobs/leases, protected credential references and Caddy; preserve G6's
fresh-runner key loading. Accepted progress **60%**, then **70% only after G7
review acceptance**. Existing host exclusions/acceptance remain separate.


### G7 repository implementation and focused evidence (2026-09-22; review pending)

Migration 1008 adds saved Vaultwarden intent and encrypted credential references.
The reviewed install/connect/skip UI uses existing platform choices;
`vaultwarden_apply` uses the host runner and `configure_vaultwarden_route` the
existing backend drain/Caddy locks. Managed 1.37.3 has independent private
listeners, persistent SQLite data and owned config. Connect only reads. Exact
Keycloak client/passkey/role and effective Vaultwarden settings are verified;
persisted overrides fail without overwrite. Retry preserves credentials, data,
server keys and attempted resources across API/browser/runner restart.

Authentication and vault unlock are separate in UI and guidance. SSO-only stays
off; the observation endpoint accepts only configuration-bound boolean facts,
explicitly labeled operator-observed. No vault secret or item content enters
plans/jobs/logs/frontend storage. Existing account/key and independent recovery
preservation, client limits and compatible backup/restore steps are documented.

[Evidence](../evidence/g7-acceptance.md): **208 affected passes**, frontend build,
20 responsive audits at 360/375/768/1280/1920px, zero axe violations, accessibility
95. Production adapters use scripted Docker/Caddy/Vaultwarden/Keycloak responses;
actual local HTTP/SQLite/crypto and API/fresh-runner process execution are
identified separately. No actual Vaultwarden SSO/unlock/test-item/denial or
account-linking execution was possible here. Real host/Caddy/Keycloak/restore,
native better-sqlite3/full boot and the existing containment-host exclusion are
not passes. [Operator guidance](../features/guided-vaultwarden.md) supplies the
exact disposable acceptance steps without a new framework or extra gate.

Published checkpoints `bcf5412a` and `7238a831` on
`feat/g7-guided-vaultwarden`; final code/evidence is submitted in its PR. G6's
accepted runner-key correction is preserved. Accepted progress stays **60%**;
G7 acceptance would make **70% (7/10)**. No merge, deployment/live change,
installer/updater/U1/U2 change, G8–G10, A-17, Phase F or migration/import. Stop G7.
