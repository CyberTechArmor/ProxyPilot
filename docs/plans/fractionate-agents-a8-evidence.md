# A8 evidence

## 2026-09-30 — takeover and implementation

Status: **in progress; not deployed, not accepted**. The user asked this chat to
take over development through A8 completion. The A7 acceptance gate is met in
`fractionate-agents-a7-evidence.md`. The earlier checkouts, their user changes,
and the protected snapshots remain preserved.

Worktree: `codex/agents-a8-dashboard`, base `f6d26cc85e08ad6eefdf644eb70d2e0102f0e476`
(A7 acceptance docs PR #711). Read-only baseline: live/candidate
`0627d437fa6bfe6d1761f25a4fd19f5feaae9109`, clean, last candidate backend check
green. Installed host services and scoped OpenBao are active as described in A7.
No A8 host installation, promotion, merge, run, role grant or consent change
has been executed by this chat.

Implementation: dedicated preserved backend socket directory, public-key-only
mounts and strict operator opt-in; step-record read with original fences and
explicit durable ordinal correlation; authorization/redaction and record display;
private SQLite backup/isolated restore verification and disk baseline; operator
binding-reference import; CI coverage and the operator reference/runbook.

Local validation used Node 24.19.0 and Python 3.12 in a local Linux environment.
The unchanged `main` comparison was archived from `f6d26cc8`, with Git text
files normalized to LF like the Linux checkout. Early Windows line-ending,
ownership and WSL display/startup artifacts are not reported as source failures.

Completed checks:

- `node --test src/__tests__/operational-*.test.js src/__tests__/agent-run*.test.js
  src/__tests__/operations-toggles.test.js`: **157 passed, zero failures/skips**.
- `python3 -m unittest discover -s scripts/tests -p 'test_a8*.py'`: **14 passed**,
  including durable ordinal/refusal/overflow, root peer, directory/socket
  recreation, wiring/default/idempotence/write and verification rollback,
  committed-WAL backup, isolated restore and tamper/migration refusals.
- `npm run build`: production frontend passes; existing chunk/import warnings
  remain. A6 journeys: **19/19, 96 layout checks**. A7/A8 journeys: **6/6, 42
  layout checks**, including the manual pilot-review exception and inconclusive
  supervisor record display. Mobile Lighthouse accessibility: **100 on all
  seven pages**, including the pilot guide.
- `host-boundary-inventory.py`: **97 backend candidate files**, no suppression;
  S6 remains open. `bash -n install.sh update.sh` passes.
- Full backend (`node --test --test-concurrency=4 src/__tests__/*.test.js`):
  **3506 tests, 3485 passed, 8 failed, 13 skipped**. Unchanged `main`, same
  runtime/concurrency: **3493 tests, 3473 passed, 7 failed, 13 skipped**. The
  same seven failures are the API-client serialization ratchet, four
  immediate-repair ratchets (MCP owner/revocation, Incus lifecycle, post-launch
  phases), Platform MCP inventory count, and the stale setup-phase registry
  expectation. The eighth is an unchanged migration token secrecy assertion;
  its focused recheck passes **32/32**. This is not a green full-suite result.
- Full Python discovery: **263 tests, one failure, two skipped**. Real pinned
  Neko, coturn UDP/TCP/TLS relay, Chromium dashboard client/input, policy and
  supervisor/broker harness checks executed. The failure is the unchanged A4
  `slow` fixture returning `challenge_required` instead of `timeout`; it also
  reproduces on unchanged `main` (8 tests, one failure). The two skips required
  a built demo; after `npm run demo:build`, separate `test_a4_tooling.py` and
  `test_a5_fixture_modes.py` discovery passes **9/9 and 4/4**, including both
  formerly skipped checks. No assertion was suppressed.
- Final operator CLI syntax checks pass; the 14 A8 Python checks pass again
  against the final install-directory defaults and rollback validation.

The real-browser checks use the pinned A7 Neko commit plus the existing Unix
socket patch and Chrome for Testing 149. Its verified native managed-policy
path `/etc/opt/chrome_for_testing/policies` was temporarily linked to the actual
production `/etc/chromium/policies` path; the tests prove enforcement and restore
it. The runner's policy constant was not redirected to an invented path. A local
wrapper disables CFT's built-in Hangouts background component extension to keep
the target inventory deterministic. Xvfb uses a private mount namespace because
WSLg's `/tmp/.X11-unix` is read-only. These are local harness accommodations,
not production changes or substitutes for the fresh host proof.

An enrollment gap was found: the production dashboard needs the operator's
broker binding mirrored into its DB, while the older proof creates only a proof
DB. The new CLI mirrors a fresh exact reference using the existing audited
credential store. It reads no value and starts/grants nothing. User decision
2026-09-30: "Please review, for now the same person." The exact pending demo
guide may receive an operator-authorized one-hour, one-use self-review exception
with immutable authorization/consumption audit events; Thomas still manually
approves it in the dashboard. Independent review stays the default. No grant
has been issued on the host. Only Thomas retains pilot run access.

Backup destination decision: **Thomas's Windows computer**. The user reviewed
the scope (consistent ProxyPilot SQLite DB, private `.env`, Compose and checksum
manifest), confirmed it should fit, and asked to continue/finish. Exact live
bytes remain unmeasured; the dry-run backup tool gives no size. No backup or
off-host transfer has yet occurred. VM/container disks, website files, ZFS
snapshots and OpenBao's separate storage are outside this release backup.

## Release and acceptance gates still open

- Final review and exact-head draft PR CI; local
  baseline-only failures remain named above and are not called green.
- User's concrete merge/deployment decision and written S6/SEC-01 single-user
  pilot limitation; manually approved guide with the scoped pilot exception,
  fresh binding and owner consents.
- Fresh host backup plus isolated restore, off-host copy/digest, migration check,
  actual container refusals/restart and A3/A4/A5/A7 regressions/canary summary.
- Dashboard pilot over the internet, live/takeover/approval/stop/reconcile/resume,
  receipt/audit/cost/result; rollback rehearsal and disk growth.
- User's explicit A8 acceptance decision after those records.

Broader Infisical/OpenBao agent vault and general broker work is deferred until
after live agents are seen. A4 already has the scoped OpenBao-backed broker.
The reboot test is deferred; snapshots/router/Incus/nodus remain protected.
