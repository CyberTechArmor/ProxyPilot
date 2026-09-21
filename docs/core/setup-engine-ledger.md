# Setup engine — milestone ledger (gate two)

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
| A1a | Defect found by A1 and closed: the public initial-setup endpoint could claim a directory-backed administrator (empty hash by design) | **done** | `routes/auth.js` (`setup-status`, `initial-setup` now local-only); executed-SQL test in `root-recovery.test.js` |
| A2 | Independent host runner: narrow validated operations, authenticated local exchange, privileged execution and service-admin credentials outside the browser-facing API; install/update wiring and service definitions | not started | plan below |
| A3 | Persistent job records: identity, approved plan, progress, checkpoints, recoverable configuration references saved before disruptive actions; no secret values in job rows or logs | **done** for the operations the backend executes (deploy, both restores, the retry mint): `setup_jobs` + `setup_job_events` (migration 1000), the deploy's checkpoint is written BEFORE it stops the app and cleared when the new unit serves; every row and event is redacted on write | `lib/setup-engine/{logic,store}.js`, `mock2/container-lock.js`, `mock2/deploy.js`, `setup-engine.test.js` |
| A4 | Shared persistent lock per app across deploy, secret-rewriting retry, DB restore, snapshot restore, credential migration; enforced server-side for UI, CLI, MCP; survives backend restart; dead holder is a recorded condition, never a free lock | **done**: `setup_locks` leases (30 s, renewed every 10 s) taken by `withContainerLock` for every holder above; a live foreign lease refuses (`ContainerBusyError`), a dead holder's lease refuses with the recorded condition (`ContainerLockStaleError`) and is never taken silently; credential migration will take the same lock when it exists (milestone C) | same files; both MCP restore tools report the stale condition |
| A5 | Restart / reboot reconciliation: saved state vs actual state, safe resume or recorded recovery-required; stale workers cannot change a target after ownership moved; retry reuses generated secrets and resources | **partly done**: the backend's boot sweep records a predecessor's dead jobs (interrupted-and-released, or recovery-required with a queued `recover_app` and a stale kept lease); fencing by (owner, epoch) on every job/lock write; `retryPlan` carries `reuse`. **Remaining**: the host runner that acts on the queued recovery (slice 3) | `lib/setup-engine/backend.js`, `routes/setup.js` |
| A6 | Verification states: configured / port responding / application healthy / credential verified / recovery required, never conflated; deferral is an explicit sanitized outcome; gate-one probe safeguards retained | **partly done**: the ladder (`verificationState`) with its recovery procedures; the deploy's restart is recorded as an attempt with the port's verdict; a deferred operation finishes as `deferred`, never `succeeded`. **Remaining**: the runner's probes that populate the ladder from a live guest (slice 3) | `lib/setup-engine/logic.js` |
| A7 | Privilege-separation inventory: what the backend container can still do directly (privileged, `pid: host`, Docker socket, `nsenter -t 1`) and what moves behind the runner | not started — see "Privilege separation, honestly" | |

**Milestone A estimate: ≈ 50 %** (was 25 % after A1). Basis: A3 and A4 are
complete and exercised against a real SQLite engine (leases, fencing,
redaction, the boot sweep); A5 and A6 have their decision layer and their
backend half; A2 (the runner that acts) and A7 are what remain.

## Milestone B — setup APIs and the guided frontend wizard

Not started (0 %). Server-side state only: the browser never declares an
installation fresh or an operation complete. Depends on A3–A6.

## Milestone C — service adapters and identity integration

Not started (0 %). Keycloak, Pomerium (Caddy → Pomerium → app; no forward
auth), Infisical + Agent Proxy, OpenBao, Vaultwarden. Activation gated on a
successful login and the recovery checks from A1.

## Milestone D — platform-aware app provisioning and maintenance

≈ 0–5 % (unchanged). Registry, shared integrations, coordinated lifecycle.

## Overall new-platform repository work: ≈ 30 % (was ≈ 24 % after A1)

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

A2 extends that last pattern rather than the container's reach. Until the
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

## Suite evidence per slice

| Slice | Tree | Tests | Pass | Fail | Skipped | Note |
| --- | --- | --- | --- | --- | --- | --- |
| baseline | `main@d9a6eb4` (gate one merged) | 2751 | 2741 | 4 | 6 | fails: `cve-research`, `cves`, `incus`, `webauthn` (native `better-sqlite3` absent in the sandbox); skips: five Playwright cases, the ZFS loop-device test |
| A1 | this branch after A1 | 2780 | 2770 | 4 | 6 | the same four files and the same six skips; +29 tests from `root-recovery.test.js` |
| A3–A4 | after the engine core | 2799 | 2789 | 4 | 6 | same four files, same six skips; +19 tests from `setup-engine.test.js`; four gate-one source ratchets updated to the new lock call shapes (semantics unchanged) |

The sandbox differs from the one the gate-one handoff reported (2674 tests,
10 failing files there): this one has `ldapts` and the CLI's dependencies
installed, so `ldap.test.js` and `vpn-mtu.test.js` run. Compare like with
like: the baseline row above was produced in this sandbox on the exact
base commit.
