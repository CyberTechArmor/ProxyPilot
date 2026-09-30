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
- `python3 -m unittest discover -s scripts/tests -p 'test_a8*.py'`: **15 passed**,
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
- Final operator CLI syntax checks pass; the 15 A8 Python checks pass again
  against the final install-directory defaults and rollback validation.

Final source review found that OpenSSL accepts an initial public key while
ignoring appended PEM/text. The wiring helper now requires the exact canonical
Ed25519 public-key PEM, refusing a public/private bundle, multiple public keys
and trailing content before any configuration write. The new regression fails
all three cases before the fix and passes after it; the public-only mount
contract is preserved.

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
manifest), confirmed it should fit, and asked to continue/finish. The user's
read-only host check measured DB **9,297,920 bytes**, `.env` **6,281 bytes** and
Compose **3,532 bytes**. The SQLite page estimate matches the DB size: total
**9,307,733 bytes / 8.88 MiB before the manifest**. Actual backup bytes will be
measured again; the live database can grow. Migrations **1100–1112** are present.
The empty Windows destination is `C:\Users\thoma\Backups\ProxyPilot\A8-20260930`,
owned by `DUO\thoma`, with inheritance disabled and only Thomas/SYSTEM access.
No backup or
off-host transfer has yet occurred. VM/container disks, website files, ZFS
snapshots and OpenBao's separate storage are outside this release backup.

## Release and acceptance gates still open

- Review and exact-head CI for any follow-up release correction; local
  baseline-only failures remain named above and are not called green.
- Manually approved guide with the scoped pilot exception, fresh binding and
  owner consents.
- Off-host copy/digest, actual container refusals/restart and A3/A4/A5/A7
  regressions/canary summary.
- Dashboard pilot over the internet, live/takeover/approval/stop/reconcile/resume,
  receipt/audit/cost/result; rollback rehearsal and disk growth.
- User's explicit A8 acceptance decision after those records.

Broader Infisical/OpenBao agent vault and general broker work is deferred until
after live agents are seen. A4 already has the scoped OpenBao-backed broker.
The reboot test is deferred; snapshots/router/Incus/nodus remain protected.

## 2026-09-30 — release preparation and supervisor preflight refusal

PR #712 was reviewed at `1250b19df9e52463b76374e09fb81e61bd962a71` and merged
as `14301df83df27f82d8d4b4550ac51414bf40ff1c` after all seven exact-head CI
checks passed. The user approved release and the written S6/SEC-01 Thomas-only
synthetic pilot limitation. Candidate `1f65659781e53e2ca7cfc77aaf3628b7bfd03222`
is clean, based on live `0627d437fa6bfe6d1761f25a4fd19f5feaae9109`. Its
backend tests and syntax check passed; its optional frontend check failed
because Vite is absent from the production container, and ShellCheck is absent.

The operator created the consistent private four-file release backup at
`/opt/proxypilot/.a8-release/20260930T132155Z-tb4ohc95`: DB, `.env`, Compose
and manifest total **9,313,738 bytes / 8.88 MiB**. Independent digests and a
second isolated SQLite restore passed; integrity, foreign keys and migrations
1100–1112 were verified. Manifest SHA-256:
`4de3babb6494557cd1b190d44768d8f1dbf99090c3fd59a283d99ad4eaa1bcf8`.
The authenticated encrypted download was packaged and checked on-host:
backup `6851168e-9798-4e98-9b8b-1276aa9ccb60`, **3,114,428 bytes / 2.97 MiB**,
SHA-256 `ebaa4397125617ea2e2a7524b481b4ed705f5602fd3e13ce832fa11bf2de96aa`.
The Windows extraction attempts stopped at a missing download path. The user
said to move on; the off-host copy remains **unverified/open**, and SEC-03 is
not closed.

The first detached supervisor update stopped during **preflight**, before the
reinstall command, with `A8_SUPERVISOR_FAILED`: the supplied paste invoked
`/etc/proxypilot-a3-proof/supervisor/a3-install-supervisor.py`, which does not
exist because the installer is not in the runtime file inventory. This attempt
made no supervisor, receipt-key or dashboard changes. Its journal tail includes
earlier A7 kill/restart proof entries, not a restart by this update.

The dashboard wiring helper had the same path assumption. The correction loads
the reviewed adjacent checkout installer; its real `status()` still verifies
the installed journal, every recorded runtime file, the loaded unit and the
serving receipt key. New tests use the actual installer inventory with no
installed installer and retain source-tamper and active-attempt refusals.
Local checks: **17/17 A8 tests**, **7/7 installer/timer tests**, and the
unsuppressed **97-file** backend inventory pass; S6 remains open. The operator
paste now also reads status through the reviewed candidate installer.

The supervisor reinstall, dashboard wiring/rebuild, fresh host proofs, dashboard
pilot, rollback/growth proof and explicit A8 acceptance remain outstanding.
