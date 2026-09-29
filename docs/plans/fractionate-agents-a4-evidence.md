# A4 credentials and provider route — evidence

**A4 is ACCEPTED (2026-09-28).** Every gate has observed, reviewed evidence on
the proof host with the installed broker (`97e0a207…`), supervisor
(`0850c329…`), runner (`de4f44d6…`) and origin proxy (`f5e63612…`).
- The full A3 proof passed again (19/19), and the proxy proof passed (21
  cases).
- The final A4 proof `a4-proof-20260928T161223Z.json` passed all six cases.
- A canary scan after it found 0 matches in all 13 sinks.

The decision is in the last section. The
[A4 reference](fractionate-agents-a4-reference.md) is the orientation page,
and this file is the record. A2, A3 and Operations activation stay off.
PR #686 stays draft and PR #699 stays draft; nothing was merged or promoted.
The only live change is the demo's reviewed `server.mjs`, which the operator
deployed with a kept backup; it now also accepts the synthetic test account.

## 2026-09-28 gate check, implementation and local verification

### Gate

The A4 prompt is eligible only once the A3 evidence records A3 as ACCEPTED. It
does: `main` at `0b743b22` (PR #698, "A3: host-owned worker supervisor, target
proof and acceptance") carries the dated section *"2026-09-28 real-person
human session and A3 acceptance decision"*, which states **"A3 is ACCEPTED
(2026-09-28)"** against the acceptance-prompt criteria. A first check in this
session, before that merge, found no acceptance record and stopped. The user
then asked for A4, and the re-fetched `main` held the accepted record.

The A3 items that stay open by name, carried forward here:
- host reboot persistence of the fence → proxy → supervisor ordering;
- the backend socket mount and coordinator (A5);
- S6 / SEC-01 / SEC-04;
- exact-head Security CI for the A3 branch;
- the proxy certificate expiring around 2026-10-03 (A4's proxy reinstall
  re-issues it);
- the candidate `frontend_build_exit` line.

### Baseline and preservation

- Branch `claude/serene-franklin-eteidj` was at `12ad1392` (old `main`, no own
  commits). It was fast-forwarded to `origin/main` `0b743b22`. Nothing was
  rewritten.
- The pre-edit SHA-256 of every modified file is in the table at the end. The
  installed A3 supervisor (`cdd49b83…`) and runner (`0cee977c…`) digests in the
  A3 evidence equal the pre-edit files here.
- Migrations 1100–1109 are unchanged. The new migration is **1110**, the next
  free number (`db.js` registers 1100–1109 in the Operations range).
- `pp-nodus`, `nodus.fractionate.ai`, `--upgrade-incus`, Incus archives and
  managed-LXC refusals were not touched. The untracked
  `scripts/tests/a3-vm-probe.zip` and the snapshot
  `pp-mcp-pre-network-20260927-222658` live on the operator's workstation and
  host, and this cloud session did not touch them.
- MCP was used read-only:
  - `get_self_status`: live `33528751`, candidate `ba5c6363` (21 ahead, clean;
    backend checks green);
  - `get_host_services a3`: the three units active;
  - `inspect_a3_vm`: UUID `49592202-…`, boot `524515b5-…`, QEMU PID 272179,
    running, 2 vCPU / 4096 MiB / 12 GiB, no swap;
  - the demo guest's `/opt/app` listing and `startup.sh`:
    `fractionate-demo.service` runs `/opt/app/demo/server.mjs` as `www-data`.

### Operator choices

- **Model route.** The user chose OpenAI and asked for GPT-6 Luna.
  - Model ID `gpt-6-luna`, via Chat Completions, with `reasoning_effort:
    "none"` (completion tokens are then the visible output),
    `max_completion_tokens` (the model returns 400 for `max_tokens`),
    `service_tier: "default"`, `store: false`, `n: 1`.
  - Launched 2026-09-23. Standard prices per 1M tokens: input $0.10, cached
    input $0.01, cache write $0.125, output $0.50.
  - `developers.openai.com`, OpenRouter, Vercel and LiteLLM were blocked by this
    session's egress policy. The ID and prices therefore come from search
    results and secondary sources. They are **not** trusted by code: the price
    table is operator-confirmed on the host (`price set`) with a revision, and a
    missing price refuses.
- **Vault.** OpenBao, through the existing dashboard feature *Platform Setup →
  Agents and machines (OpenBao)*. The agent `a4-broker` gets its own AppRole and
  policy (`read` on `<kv>/data/agents/a4-broker/*` only). The operator enters
  the values in that page: the synthetic password, which is also the canary,
  and a capped provider key. There is no MCP tool for secret input.
- **Draft PR.** The user authorized one draft PR for exact-head Security CI.

### What was built

**Who can read the value.** The OpenBao AppRole `agent-a4-broker` (used by the
root broker on the host) can read the assigned values. An Infisical project
Admin could read values kept in Infisical, though A4 keeps none there. Host
root, and so the root-equivalent backend (S6 is open), can reach the broker's
AppRole file. The broker keeps the value away from the model context, the
guest runner's command channel, page reads, logs, receipts, journals, the
ledger and the database. It does **not** hide the value from those principals,
from the fixture origin that verifies it, or from the page's own JavaScript
inside the browser.

**Host broker (`scripts/a4-credential-broker.py`).**
- Root daemon. `a4-install-broker.py` installs a reviewed copy into
  `/etc/proxypilot-a4/broker` and the unit `proxypilot-a4-broker.service`. It
  refuses to serve unless its files match the install journal.
- Socket `/run/proxypilot-a4/broker.sock`: uid 0 peers only, never mounted into
  the backend container.
- Binding registry, managed by the root `a4-broker-operator.py`:
  - `bind`: project, profile and binding UUIDs, a non-secret username, and a
    vault key → path and current version, revision 1;
  - `rotate`: expected revision → a new revision at the key's current version;
  - `revoke`: final.
- Supervisor-facing methods:
  - `pin_run`: binding revision and scope, `max_tokens`/`max_usd`, and
    `project_limits_revision`; immutable per run;
  - `check`: the binding is active at the pinned revision;
  - `deliver`: re-check, then the worker's MainPID read back from systemd in the
    guest, the vault read at the pinned version at delivery time, a
    re-check, and a write through `incus exec` stdin by a fixed guest writer.
    The writer checks the PID's cgroup is the attempt's unit and its uid is
    65534, then opens `/proc/<pid>/root/tmp/pp-a4-credential` with `O_NOFOLLOW`
    only if it is a FIFO owned by 65534 with a reader present. The frame is
    wiped after the write.
- The deliveries journal records the binding ID, revision and outcome, never a
  value or a hash of it.
- The model route is `model_call` (see below).

**Supervisor (`scripts/a3-worker-supervisor.py`).**
- The launch contract gains an optional `credential` pin
  `{project_id, profile_id, profile_revision, binding_id, binding_revision}`. It
  is part of the run pins (a relaunch with another pin gets
  `RUN_POLICY_MISMATCH`).
- Before any effect, the launch is pinned at the broker. A credential launch
  without the broker is refused `CREDENTIAL_BROKER_UNAVAILABLE`. A launch
  without a credential proceeds unpinned when no broker is installed, so the A3
  proof is unchanged.
- `submit_bound_fixture{binding_id}` is the only credential action. Its steps:
  1. broker `check` (a refusal here counts no action and never touches the
     runner or the vault);
  2. count the action and journal it with the binding ID and revision;
  3. send the runner the action with the binding ID;
  4. wait for the runner's `credential_channel` event (FIFO reader open);
  5. broker `deliver`;
  6. record the outcome.
- This process never holds the value. The result is `{binding_id,
  binding_revision, outcome, login_requests,
  untrusted_page_claim_authenticated_as_bound_account}`.
- Receipts gain `credential: {binding_id, binding_revision,
  submits:[{ordinal,outcome}], logout}`. An attempt that submitted signs out
  first (the runner's `stop` does `POST /api/logout`), and the evidence records
  `logout`.
- Nothing else widened: same sockets and methods, same peer rule, fence, unit
  properties and limits.

**Runner (`scripts/a3-worker-guest.py`).**
- On submit, it makes a fresh 0600 FIFO on the unit's private tmpfs, emits
  `credential_channel`, and reads one framed value (`PPA4 | u16 username | u16
  password`, printable ASCII, ≤256 each) within 20 s. It then removes the FIFO.
- Typed lookup: the dialog named "Sign in to your workspace", exactly one
  `autocomplete=username` field, one password field and one `type=submit` in
  the same form.
- It clears each field, types with CDP `Input.insertText`, and checks only the
  lengths (as booleans). It then arms **exactly one** `POST /api/login` in the
  Fetch policy (the standing policy never admits it), submits, and reads the
  status from the network events and `/api/session`.
- It then wipes its buffers and clears both fields (a rejected value never
  stays in the form). The reply carries the binding ID and outcome only.

**Origin proxy (`scripts/a3-origin-proxy.py`).**
- It admits exactly `POST /api/login` with `Content-Type: application/json`
  (optionally `; charset=utf-8`) and `Content-Length` 1..1024, still one
  request per tunnel. The body is forwarded as-is and never logged (the proxy
  logs nothing per request).
- Every other POST keeps the A3 rule (empty `POST /api/logout` only). Any
  target containing `?` or `#` is now refused, including a bare `?`.
- `a3-install-proxy.py reinstall` exists. Remove-then-install used to refuse on
  the journal's `removed` phase, and removal required a day of certificate
  validity. Both are fixed, so the documented re-issue path now works.

**Model route (`model_call`).**
- Allowlist: `gpt-6-luna` only (`MODEL_ROUTES`). The provider key is read from
  the vault at call time, at the version bound by `provider`. The call goes
  from the host; the guest has no route to the provider or the vault (fence
  unchanged).
- Per call:
  1. check the run pin (`project_limits_revision`), the allowlist, the price
     table and the provider key;
  2. reserve the worst case (prompt bytes + 48 tokens at max(input,
     cache-write) plus `max_output_tokens` at the output price, in integer
     nano-USD rounded up) against settled spend plus outstanding
     reservations;
  3. write the journal durably (fsync), then send.
- Settlement:
  - validated usage settles at the price-table revision (uncached prompt
    tokens at the higher rate);
  - unknown price, service tier or model, or missing usage, keeps the whole
    reservation as spent;
  - HTTP 400/401/403/404/409/413/415/422/429 releases it;
  - 5xx, timeouts and a crash after `sent` stay `uncertain` and keep it.
- Call IDs are single-use: a retry returns the recorded outcome and never
  sends again.
- The ledger records the provider response ID, model, usage, cost, price-table
  revision, HTTP status and latency. It also keeps a 200-character untrusted
  response excerpt and its SHA-256.
- Refusals: `MODEL_NOT_ALLOWED`, `BUDGET_EXHAUSTED`, `PRICE_UNKNOWN`,
  `REVISION_MISMATCH`, `PROVIDER_ERROR`, `USAGE_MISSING`, `MODEL_MISMATCH`,
  `CALL_UNCERTAIN`, `RUN_NOT_PINNED`, `PROVIDER_KEY_UNBOUND`.

**Fixture origin (`admin/frontend/demo/server.mjs`).**
- One optional synthetic account read from `synthetic-account.json`: an scrypt
  verifier with `N ∈ {2^14, 2^15, 2^16}`, `r=8`, `p=1` and a 32-byte key, and
  anything else disables it. The file is re-read on change, so a rotation
  needs no restart. The public demo account is unchanged.
- `a4-fixture-account.py provision` derives the verifier on the host from the
  bound value and pushes only the verifier. `deploy-server` and
  `rollback-server` replace or restore the demo's `server.mjs`, keeping
  `server.mjs.pre-a4`.

**Proof tools.**
- `a4-probe.py` runs these cases through the installed sockets: proxy policy,
  login, egress, budget, rotation and revocation.
- `a4-canary-scan.py` reports match counts only, over:
  - the supervisor, broker, proxy and whole-host journals and the guest unit
    journals;
  - backend container logs;
  - the database (raw files and a logical dump) and the MCP ledger;
  - supervisor and broker journals, with receipts decoded;
  - proof reports and page reads;
  - Incus logs.

  It searches raw, JSON-escaped and URL-encoded forms and base64/base64url at
  all three byte alignments. An unreadable sink fails the scan.

**Backend (groundwork; no route, activation off).**
- Migration **1110** adds `ops_agent_credential_bindings` and an append-only
  `…_binding_events`:
  - no value, secret or hash column;
  - one active binding per profile;
  - revoked is final.

  It also adds `credential_binding_id` and `credential_binding_revision` to
  `ops_agent_runs`.
- `lib/operational-credential-bindings.js`: owner-only bind, rotate and revoke,
  with strict schemas and no value field.
- `operational-worker-boundary.js`:
  - `prepare` pins the revision, and `launchSpec` emits `credential` (omitted,
    never `null`, when unbound);
  - every later use (`reserveAttempt`, `markRunning`, `launchSpec`, `renew`,
    `authorizeAction`) refuses `CREDENTIAL_REVISION_MISMATCH` or
    `CREDENTIAL_BINDING_REVOKED`;
  - `submit_bound_fixture` needs the pinned `binding_id` and a profile with
    `type`;
  - the launcher sends only the binding ID and checks the typed result.

### Failures found and fixed during implementation

- **Delivery before the reader was open.** The first design delivered in
  parallel with the runner action. A runner that refused first (no login
  form) would still have caused a vault read and a 15-second writer wait. Now
  the supervisor waits for the runner's `credential_channel` event; a runner
  that refused first never causes a vault read.
- **A late broker write.** The supervisor's delivery timeout (now 90 s)
  exceeds the runner's FIFO window (20 s). A late write then finds no reader
  and writes nothing.
- **A3 proxy re-issue path.** The documented `remove` → `install` refused
  after removal, and removal needed a day of certificate validity. Fixed with
  tests (above).
- **Bare `?` in a proxy target.** It passed `urlsplit` with an empty query.
  It is now refused.
- **Test-only defects fixed in the tests.** Default-argument binding of
  patched constants (`DELIVERY_SECONDS`, `getpass`), and duplicate module
  instances making refusal classes differ across fixtures.

### Local verification (this session, Linux sandbox, Python 3.11, Node 22)

| Command | Result |
|---|---|
| `python3 -m unittest discover -s scripts/tests -p 'test_a3*py'` | **77 passed** (74 A3 plus 3 new proxy tests). Real Chromium 141 tests ran; none skipped. |
| `python3 -m unittest discover -s scripts/tests -p 'test_a4*py'` | **41 passed**. Covers: real Chromium sign-in through the FIFO only, including through the **real proxy handler** (TLS terminated, SPKI pinned); the full supervisor → broker → FIFO → runner → Chromium → origin chain; the proxy byte-exact forward; the guest writer's target checks; the OpenBao client against an OpenBao-shaped API; reservation and settlement; fail-closed paths; restart recovery; tooling; canary encodings. The canary and provider-key values appear in no reply, event, journal or receipt, in any searched encoding. |
| `python3 -m unittest discover -s scripts/tests -p 'test_*.py'` (as CI) | **147 passed** |
| `(cd admin/backend && node --test src/__tests__/operational-*.test.js)` | **79 passed** (73 plus 6 new; includes a cross-language check that the backend's launch contract passes the Python supervisor's `validate_launch`) |
| `(cd admin/backend && npm test)` | 3380 tests: 3355 pass, **11 fail**, 14 skipped. The same run on a clean `origin/main` worktree gave 3374: 3349 pass, 11 fail, 14 skipped. The 11 failure names are **identical** (the root-only bootstrap and recovery tests, `vpn-mtu`, and several sandbox ratchets). |
| `python3 scripts/host-boundary-inventory.py` | exit 0, "96 candidate backend files inventoried; S6 remains open", no suppression |
| `(cd admin/frontend && npm run build)` | passed (10.6 s) |
| `(cd admin/frontend && npm run demo:build && npm run demo:test)` | build passed; **2/2** smoke tests (public account, and the synthetic account with rotation, a bounds-refused file and a malformed file) |
| `systemd-analyze verify proxypilot-a4-broker.service` | no findings |

### Exact-head Security CI (draft PR #699)

The user authorized one draft PR. [CyberTechArmor/ProxyPilot#699](https://github.com/CyberTechArmor/ProxyPilot/pull/699)
ran *Security regression* run `36436717665` on head
`ae8c8db1f8b1189ce8aae01e72be612352492413` (code `d0d4c2de` plus docs). All
seven jobs passed: `backend`, `agent`, `frontend`, and the four dependency
`audit` jobs (`admin/backend`, `admin/backend/src/mock2/framework-seed/base-app`,
`admin/frontend`, `cli`). GitHub reported the PR `mergeable_state: clean`.
The `backend` job runs every `scripts/tests/test_*.py`, so this includes the
A3 and A4 Python suites and the unsuppressed host-boundary inventory. The PR
stays draft.

### Target proof: not run (host root required)

A cloud session cannot upload repository content to the host, and root on the
host is needed. The exact commands, expected output and diagnostics are in the
[A4 reference](fractionate-agents-a4-reference.md#host-commands). The live
demo's `server.mjs` must be replaced (`a4-fixture-account.py deploy-server`,
with a kept backup and `rollback-server`) so it can verify the synthetic
account. That is a change to a live site, which the operator makes
deliberately.

### Acceptance decision (2026-09-28, at implementation): A4 was NOT accepted

Superseded: every gate below passed on the host, and A4 was **accepted** in the
fourth host run (last section). The gates as they stood at implementation:
1. ~~Staging on the candidate, the proxy reinstall, the supervisor reinstall
   and the broker install, with readback~~: **passed** on the second host run.
2. ~~The full A3 proof again (18 cases plus `minimums`), because the supervisor
   and runner changed~~: **passed**, 19/19, on the second host run.
3. ~~`a3-probe-proxy.py`: 21 cases (A3's 7, 12 refused POST/path variants, and
   the two positives: the bounded sign-in POST and the empty logout)~~:
   **passed** on the second host run.
4. ~~`a4-probe.py`, where every case must pass~~: **passed**,
   `a4-proof-20260928T161223Z.json` (fourth host run):
   - `login` (signed in, `read_files`, logout `done`, receipt credential block,
     no profile or cookie file in the guest after stop);
   - `egress` (provider, vault and DNS refused; fence counters move);
   - `budget` (one real allowed call with its provider response ID; replay;
     tokens and dollars exhausted; unknown price; not allowlisted; revision
     mismatch; provider error);
   - `rotation` and `revocation` (with timings).
5. ~~`a4-canary-scan.py`: every sink `scanned: true` with **0** matches~~:
   **passed** after the final proof (fourth host run).
6. ~~Exact-head Security CI on the draft PR~~: **passed** at `ae8c8db1` (run
   `36436717665`). It must pass again on any later code head.

Still open by name after A4 (not A4 gates): S6 / SEC-01 / SEC-04, host reboot
persistence (now also of the broker unit), and the backend socket mount and
coordinator (A5).

### Rollback

1. Keep A2/A3/Operations activation off.
2. `a4-broker-operator.py revoke --binding <id>`. It refuses delivery at once.
3. `a4-install-broker.py remove`. This removes the unit, the installed copy
   and the AppRole file, and keeps the journal and ledger. Then issue a new
   secret ID in the dashboard, so the removed one is dead.
4. `a4-fixture-account.py rollback-server`. This restores the demo's
   `server.mjs.pre-a4`. The verifier file stays and is ignored by the pre-A4
   server.
5. Supervisor and proxy code: stage the previous reviewed A3 commit
   (`44c630fb`) with the stager, then `a3-install-proxy.py reinstall` and
   `a3-install-supervisor.py reinstall`.
6. Code: revert the branch commits. **Keep migration 1110** and its rows.

Older writers do not pin or check bindings. That is safe only while activation
is off. No backend route writes 1110 tables.

### Pre-edit and post-edit SHA-256 (base `0b743b22`)

| File | Before | After |
|---|---|---|
| `scripts/a3-worker-supervisor.py` | `cdd49b83e0e71425…` | `0850c329d85d64a0…` |
| `scripts/a3-worker-guest.py` | `0cee977cafa053ce…` | `de4f44d6bddccf04…` |
| `scripts/a3-origin-proxy.py` | `0a48a12bf851432d…` | `f5e63612043ce1fc…` |
| `scripts/a3-install-proxy.py` | `d4cb9bb8fdb9464e…` | `a9c81db1f3360e8b…` |
| `scripts/a3-probe-proxy.py` | `06125dc327fd90bc…` | `f8b1771095af07e8…` |
| `scripts/a3-probe-worker.py` | `26bce4b1af1f9421…` | `847702f85be178c9…` |
| `admin/backend/src/db.js` | `5b9e5eace01c06cc…` | `374d12f57cda7926…` |
| `admin/backend/src/lib/operational-worker-boundary.js` | `7fbdfaaf13b79463…` | `57a6c53958bcbeff…` |
| `admin/backend/src/__tests__/helpers/operations-fixture.js` | `c674666bace6c6e2…` | `bd583bae28c27e83…` |
| `admin/frontend/demo/server.mjs` | `f83d81891973c272…` | `8bb065061749f42c…` |
| `admin/frontend/demo/smoke.test.mjs` | `a975452c80dff030…` | `ec899bbe13632b75…` |
| `scripts/a4-credential-broker.py` | new | `97e0a2074414ba37…` |

The other new files are the A4 scripts and tests, `operational-credential-*.js`
and the new backend test. The full list is in `git diff --stat
0b743b22..HEAD`.

## 2026-09-28 first host run of step 1: proxy reinstall stopped; fixed

The user ran step 1 in the ProxyPilot Host Terminal with the stager pinned at
`d0d4c2de`. A screenshot of the output was reviewed in the session.

- **Staging.** `staged 10290c81c78b56d9c79aa3787056a9cba64ccc4a (was
  ba5c6363…) from d0d4c2de…; 60 paths match exactly`. MCP `get_self_status`
  then read candidate `10290c81`, 22 ahead, clean.
- **Proxy reinstall.** It stopped with `A3 proxy operation refused: Refusing to
  replace unrelated file: /var/lib/proxypilot-a3-proof/proxy-install.json`. The
  `set -e` command did not reach the supervisor reinstall, the proxy probe or
  the broker install.
- **State afterwards (MCP `get_host_services`).**
  - `proxypilot-a3-origin-proxy.service` is `not-found`: removal completed.
  - The fence is active/exited and the supervisor active/running.
  - With no proxy, the supervisor's boundary check refuses every launch. That
    is the fail-closed direction. No guest, route or other service changed.
- **Root cause (my defect).** `remove()` leaves the journal in phase
  `removed`. `install()` then accepted that phase but wrote its new
  `prepared` journal with the installer's non-replacing `save`, which refuses
  to overwrite a file with different content. The earlier unit test stopped
  the install before that write (at certificate generation), so it did not
  catch the defect.
- **Fix (`9ef3af56`).**
  - `install()` replaces only its own `removed` journal.
  - `reinstall` skips the removal when the proxy is already removed, so the
    same step-1 command recovers this host.
  - The new test runs `install()` end to end on temp paths, with a real
    certificate and real journal writes. On the old code it fails with the
    host's exact error; on the fix it passes. It also shows that a `prepared`
    journal is still refused and left untouched.
- **Hardening in the same commit, found while re-reading steps 2 and 3.**
  - `a4-fixture-account.py` pushes from a 0600 temporary file instead of
    relying on `incus file push -` reading stdin.
  - The login case counts only profile or cookie files that are new since the
    attempt started. It reports earlier leftovers separately, and dropped the
    generic names `Preferences`/`History`.
  - The canary scan reads a two-day journal window instead of fourteen days.
- **Local after the fix:** `python3 -m unittest discover -s scripts/tests -p
  'test_*.py'`: 149 passed.
- **Staging `9ef3af56` over the `d0d4c2de` staging,** simulated on a stand-in
  candidate: `63 paths match exactly`, and scripts, backend and demo are
  byte-identical to `9ef3af56`.
- **Mount names.** MCP `get_platform_service openbao` gave the OpenBao
  container prefix `pp-g6-23bfea7a17f8`. With `namesFor`, the broker config
  uses the KV mount `pp-g6-23bfea7a17f8-kv` and the AppRole mount
  `pp-g6-23bfea7a17f8-machine`. The step 2 command now carries both, so no
  placeholder is left.

A4 remains **not accepted**; every target gate listed above is still open.

## 2026-09-28 second host run: step 1 and the A3 regression pass; step 2 stops at a credential name

The user ran steps 1–3 in the ProxyPilot Host Terminal and pasted the full
output into the session. No value appears in it.

### Step 1: passed

- **Staging.** `staged 795392979b7c68c1ce6bbe1f981548c77d2af027 (was
  10290c81…) from 9ef3af56…; 63 paths match exactly`.
- **Proxy reinstall.** `"installed": true`, `"previous_removed": null`. This is
  the reinstall-skip path of the `9ef3af56` fix, run on the host where the first
  run had already removed the proxy. The new certificate SPKI is
  `NdkAJzLxqviLAlokZghRbU+B+uE8lO7dmjnEg7NqwyM=`, and the service is
  active/enabled.
- **Supervisor reinstall.** `"installed": true`, `"accepting_launch": true`,
  `"blockers": []`, new `key_id` `062aa93bb65d…ecee8b`. The previous key was
  archived as `supervisor-keys/d6817618…d517.pem`; the state journal, fence
  and proxy were retained. The installed files read back as:

  | File | SHA-256 |
  |---|---|
  | `a3-worker-supervisor.py` | `0850c329d85d64a00e5941f92317a74bf5a6ee13df3223c77be75b19f5572eeb` |
  | `a3-worker-guest.py` | `de4f44d6bddccf045ba17621c323b5eb376dff987b5ca60deb526a26705d3c3b` |
  | `a3-origin-proxy.py` | `f5e63612043ce1fce052c1de0c04722754b290d2fdd35c61e79b2d8af33a1104` |
  | `a3-install-proxy.py` | `f0233e1619a7aeff4fd64eb5f847ad03b56043737fc7730120d9642002948e44` |
  | `a3-install-fence.py` | `314b77669482b3f55bf5526fe745cf0fe68a28eb9fa979c2a8ad9ae9d8fa46d6` |
  | `a3-network-fence.py` | `8d756bd27c4c308945215ae80ad7439a6d58f2678183208180534b0986a35eb7` |
  | `proxypilot-a3-supervisor.service` | `254ec0d57fe46b7b618941f62369ca63aa2ab128392a6a2dce48e7f72f2fcdfe` |
  | `supervisor-pub.pem` | `7e1d2c48564b87b18da35c2429c7fcf1028440b2777a7dfd4259386ddcc842d0` |

- **Proxy proof.** `"proxy_checks": "passed"`, 21 codes
  `403,403,200,200,403,403,403,400,403×12,200`, all on the demo certificate
  `d54fdbc7…107a`.
  - `login_json_reaches_origin`: 400 from the origin (`origin_answered: true`).
    The bounded JSON sign-in POST passes the proxy; the demo refuses the
    probe's deliberately invalid body.
  - The 12 refused variants all return 403 with `origin_answered: false`:
    text/plain, no content type, empty body, over 1024 bytes, chunked, query,
    other host, PUT, POST to session, files and root, and logout with a body.
  - `logout_empty_reaches_origin`: 200 (`origin_answered: true`).
  - The old A3 `request_/api/login` GET is still 403.
- **Broker install.** `"installed": true`, service active/enabled. Broker
  `97e0a2074414ba377b16102819ab4355556101b5cfacb16d1fc175c9fd8d4bd5`, unit
  `23aeff46dadf4a7d3591fe779459182783e3fb4530b4379fa0a697dc0c8f11e4`.
  `vault_healthy: false` and `bindings: []`, as expected before configuration.

### Step 2: stopped at `VAULT_KEY_MISSING`

- **First attempt.** Interrupted at the hidden secret-ID prompt
  (`KeyboardInterrupt` in `getpass`). Nothing was written.
- **Second attempt.**
  - `configure`: `"approle_login": "ok"`; config `/etc/proxypilot-a4/broker-config.json`,
    mode 0600, address `http://127.0.0.1:18200`, mounts
    `pp-g6-23bfea7a17f8-machine` and `pp-g6-23bfea7a17f8-kv`, agent `a4-broker`.
  - `price set`: price table revision 1 at `2026-09-28T15:22:20Z`, `gpt-6-luna`
    input 0.10, cached input 0.01, cache write 0.125, output 0.50.
  - `provider --vault-key openai-api-key`: `A4 broker refused:
    VAULT_KEY_MISSING`.
- **What the refusal means.** The broker got HTTP 404 on
  `pp-g6-23bfea7a17f8-kv/metadata/agents/a4-broker/openai-api-key` with its own
  AppRole token. Its policy grants that path, so a 404 rather than a 403 means
  the mount and policy are right. No credential exists under that exact name,
  and names are case-sensitive.
  - The dashboard's credential name field shows `OPENAI_API_KEY` as its
    placeholder, so the key was probably entered under a different name, or not
    yet entered.
  - `set -e` stopped the step before `bind`. No binding exists, and
    `/var/lib/proxypilot-a4/proof-binding` was not written.
- **Partial rerun** (the "rerun only what failed" command). It read the
  missing binding file, then:
  - `deploy-server`: `"deployed": true`, previous `f83d8189…df6a`, now
    `8bb065061749…e390`, backup `/opt/app/demo/server.mjs.pre-a4`, service
    `active`.
  - `provision`: `BINDING_UNKNOWN`, since there is no binding. The demo's
    synthetic account stays inactive; the public demo account is unchanged.
  - Status: `config_present: true`, `vault_healthy: true`, `bindings: []`,
    `provider: null`, prices revision 1.

### Step 3: A3 regression passed; A4 probe and canary blocked

- **A3 regression.** `"worker_proof": "passed"`, 19/19, `a3_exit=0`, report
  `worker-proof-20260928T152421Z.json`. It ran against the A4 supervisor and
  runner above, with key `062aa93b…`.
  - `backend_refusals` has 12 codes, including `credential_action:
    CREDENTIAL_NOT_BOUND` and `credential_action_without_binding:
    INVALID_REQUEST`.
  - `origin_refusals` still refuses the page's own `login_submission`. The
    runner's single armed POST exists only inside `submit_bound_fixture`.
  - `guest_crash` rebooted the guest from `524515b5…` to
    `728c93ce-2436-44a7-818b-017ee50645c9`. The fence refused everything after
    the reboot.
  - Sizing:

    | Measure | Range |
    |---|---|
    | Unit memory peak | 221.6–224.3 MiB |
    | Unit memory peak at minimums | 220.6–228.5 MiB, 0 OOM kills |
    | Launch | median 0.571 s |
    | Browser start | median 0.162 s |
    | Idle QEMU tree RSS | 2,541,992 KiB |

  - The A3 open items are unchanged: host reboot persistence, and the backend
    socket mount.
- **A4 probe.** `"a4_proof": "blocked"`, `a4_exit=1`. The preflight had
  everything but a binding:

  | Preflight field | Value |
  |---|---|
  | `credential_broker` | `available` |
  | `broker_sha256` | matches `97e0a207…` |
  | `key_id_matches` | `true` |
  | `vault_healthy` | `true` |
  | `provider` | `null` |
  | Prices | revision 1 |
  | Boundary boot | `728c93ce…` |
  | SPKI | as installed |
  | `binding` | `null` |

- **Canary.** `A4 canary scan stopped: BINDING_UNKNOWN`, `canary_exit=1`.
- Both blocks follow from step 2. Neither is a proof failure.

### Read back from the session (MCP, after the run)

- `get_host_services`: `proxypilot-a3-fence` active/exited,
  `proxypilot-a3-origin-proxy`, `proxypilot-a3-supervisor` and
  `proxypilot-a4-broker` active/running.
- `inspect_a3_vm agents-a3-debian13-proof-20260927`: Running, VM UUID
  `49592202-…73e4`, boot `728c93ce-2436-44a7-818b-017ee50645c9`, QEMU PID
  272179 (RSS 2,384,216,064 bytes), 2 CPUs, 4096 MiB, 12 GiB root on
  `Storage`, swap off, Debian 13.7.
- `test_route demo.fractionate.ai`: edge 200, upstream `10.185.17.210:4179`
  200. The demo serves on the A4 `server.mjs`.
- `get_self_status`: candidate `79539297`, 23 ahead, clean.

### Next (operator)

1. Read the exact credential names under agent `a4-broker`. Use the dashboard's
   *Assigned credentials* list, or the reference's name-only diagnostic.
2. Run step 2b from the reference, with those names. It skips configure, price
   and deploy, which are done.
3. Run step 3b: the A4 probe and the canary only. The A3 regression already
   passed at these supervisor and runner bytes.

A4 remains **not accepted**. Gates 4 (A4 probe) and 5 (canary scan) are open.

## 2026-09-28 third host run: bound sign-in, rotation, egress and canary pass; two harness defects fixed

The user pasted the output of each step. No value appears in any of it.

### Credential names

- The name-only diagnostic listed `keys ["AgentKeys"]`: the agent had one
  credential, under a different name. The user then assigned
  `openai-api-key` and `a4-fixture-password` in the dashboard.
- Step 2b:
  - provider revision 1 (vault version 1, 15:53:00Z);
  - binding `29532439-72a5-4654-9141-37c87909c3e3`, revision 1, active, vault
    `agents/a4-broker/a4-fixture-password` version 1.
  - `provision` was then refused with `VAULT_UNAVAILABLE`.

### The dashboard's "Issue a new secret ID" and a stale broker sign-in

- **Cause.** Between steps, the user confirmed *Issue a new secret ID* for
  `a4-broker`. The broker config on the host still held the old secret ID.
- **Why some calls still worked.** The running broker kept working on the token
  it had signed in with at 15:22, which lasts up to one hour. So `provider` and
  `bind` succeeded, and later the `login` case's delivery did too. Every fresh
  sign-in was refused: the fixture tool, the canary scan, and the probe's
  in-process re-provisioning.
- **Confirmation.** A sign-in-only check with the saved config returned
  `approle_login_http 400`. After the user reconfigured with the new secret ID
  and restarted the broker, it returned to `ok`.
- **Finding (recorded, not a code defect).** Issuing a new AppRole secret ID
  does not end tokens already issued with the old one. The broker could read
  assigned values for up to the token TTL (1 h, max 4 h) after the secret ID
  was replaced, until it was restarted. Binding revocation is the immediate
  stop (below); a secret-ID rotation is not.
- **Tooling fixes (`d052e416`).**
  - `a4-install-broker.py status` now also reports `approle_login` from a fresh
    sign-in. `vault_healthy` only says OpenBao answers, and it read `true`
    throughout.
  - `configure` now restarts an installed broker and waits for it. The host's
    `systemctl restart` returned before the broker's socket existed, so the
    status call that followed failed with ENOENT (`[Errno 2]`).
  - The fixture tool, the canary scan and the probe now print the broker's
    fixed refusal detail next to its code.

### Proof run 1 (`a4-proof-20260928T155331Z.json`, binding `29532439…`): failed

| Case | Result |
|---|---|
| `proxy_policy` | Passed. |
| `egress` | Passed. |
| `login` | `outcome: rejected`, `login_requests: 1`, page claim `false`. The delivery and the one armed POST worked, but the demo had no synthetic account (provisioning had failed), so it refused the sign-in. A wrong or missing account yields `rejected`, never a false success. |
| `budget` | `CallFailed: ACTIVE_ATTEMPT` (harness defect, below). |
| `rotation` | `VAULT_UNAVAILABLE`: its re-provisioning needed a fresh sign-in. |
| `revocation` | `KeyError: 'revoked_at'` (harness defect, below). The binding was revoked. |

The canary scan stopped with `VAULT_UNAVAILABLE`.

### Step 2c after reconfiguring

- Revoking the old binding was refused with `BINDING_REVOKED` (the proof had
  already revoked it); its ID file was kept as `proof-binding.29532439…`.
- Provider revision 2 (vault version 1, 16:00:30Z).
- New binding `87698f27-d3a6-4484-86f9-40068d56e777` (project `2f32bad0-…`,
  profile `1089ce8a-…`), revision 1, active.
- `"provisioned": true`: verifier 197 bytes, binding revision 1, vault
  version 1.
- Status: two bindings (`29532439…` revision 2 revoked; `87698f27…`
  revision 1 active), provider revision 2, prices revision 1.

### Proof run 2 (`a4-proof-20260928T160109Z.json`, binding `87698f27…`): four of six passed

- **`proxy_policy`: passed.** The same 21 codes, boot `728c93ce…`.
- **`login`: passed.**
  - The submit returned `outcome: signed_in`, `login_requests: 1`, and the page
    claims the bound account. The binding is `87698f27…` at revision 1; the
    submit took 430 ms (journal `latency_ms` 404).
  - `read_files` (a page read after sign-in) returned
    `untrusted_page_claim_sample_present: true`.
  - The journal's submit record has only `ordinal` 3, `action`, `binding_id`,
    `binding_revision`, `state: done`, `at`, `latency_ms` and
    `outcome: signed_in`.
  - The receipt's credential block has only `binding_id`,
    `binding_revision: 1`, `logout: done` and
    `submits: [{ordinal: 3, outcome: signed_in}]`; the receipt reason is `proof`.
  - Logout was `done`.
  - Guest profile or cookie files after the stop: `[]` (before: `[]`); the
    worker unit is `inactive`.
  - The broker ledger has exactly one delivery, `outcome: delivered`, for run
    `27a1a635…` / attempt `b5573ba1…`.
- **`egress`: passed.**
  - Guest root is refused to every `api.openai.com` address
    (`162.159.140.245`, `172.66.0.243`: timeout; `2606:4700:7::f3`,
    `2a06:98c1:58::f3`: 113).
  - Also refused: the DNS gateway and public DNS, the vault on the bridge
    (`10.185.17.1:18200`), and the vault route (`:443`).
  - Fence counters: `allowed_proxy` +4, `denied_ipv4` +18, `denied_ipv6` +3.
- **`rotation`: passed.**
  - Revision 1 → 2 at vault version 1. The value was unchanged; this proves the
    revision semantics.
  - At the old revision, each of these was refused with
    `BINDING_REVISION_MISMATCH`: the next submit (5 ms), a relaunch of the same
    run, and a new run.
  - The verifier was re-provisioned at revision 2, and the new revision signed
    in (`signed_in`, `binding_revision: 2`, 484 ms).
- **`budget`: failed**, `CallFailed: ACTIVE_ATTEMPT` (below).
- **`revocation`: failed**, `KeyError: 'revoked_at'` (below). Binding
  `87698f27…` is now revoked.

`a4_exit=1`.

### Canary scan after run 2: passed

`"canary_scan": "passed"`, `canary_exit=0`, binding `87698f27…` revision 2,
vault version 1. Every sink is `scanned: true` with 0 matches:

| Sink | Bytes | Matches |
|---|---|---|
| supervisor unit journal | 4,415 | 0 |
| broker unit journal | 776 | 0 |
| proxy unit journal | 486 | 0 |
| whole host journal (2 days) | 12,658,287 | 0 |
| guest journal | 589,816 | 0 |
| backend container logs (48 h) | 26,408 | 0 |
| receipts and supervisor state journal | 400,019 | 0 |
| broker journal and model records | 22,712 | 0 |
| page reads and proof reports | 88,627 | 0 |
| Incus logs | 138,717 | 0 |
| database files | 12,959,248 | 0 |
| database dump | 7,014,079 | 0 |
| MCP ledger | 262,486 | 0 |

`encodings_searched: 4`: the raw value plus its base64 at three alignments.
For a letters-and-digits value the JSON-escaped and URL-encoded forms equal
the raw one, and base64 equals base64url, so duplicates collapse.

The scan covers the value delivered in all three sign-ins of both runs: the
rejected one in run 1 and the two successful ones in run 2. It also covers the
dashboard entry of the value through the backend.

### Harness defects and fix (`d052e416`)

- **`budget`.**
  - The case launched run B while run A's attempt was still live. The
    installed supervisor allows one live attempt and refused it
    (`ACTIVE_ATTEMPT`); that refusal is correct.
  - Each run is now stopped before the next launches, so its calls happen while
    its own attempt is live.
  - Before the refusal, run A had already made its real allowed call in both
    runs. A refused or failed call would have raised a different code first. So
    two real `gpt-6-luna` calls settled; the ledger readback after the rerun
    records them.
- **`revocation`.**
  - Every assertion passed: broker `check`, the running attempt's next submit
    and a new launch were each refused with `BINDING_REVOKED`, and no submit
    was journalled. The case then read `revoked_at`, which the broker's
    `revoke` reply does not carry (it returns `revoked_at_epoch`), so its
    timings were lost.
  - It now reports `revoked_at_epoch` and reads the binding state back.
- **Why local tests missed both.** The earlier tests covered only the pure
  helpers. The new `ProofFlowTests` run both cases end to end against the real
  `Broker` class, with a supervisor fake that enforces one live attempt. On
  the old code they fail with the host's exact errors
  (`a4_probe_operator.CallFailed: ACTIVE_ATTEMPT` at the run-B launch, and
  `KeyError: 'revoked_at'`).
- **Local after the fix.** All script tests: 154 passed. The host-boundary
  inventory exits 0.
- **Staging.**
  - Staging `d052e416` over the `9ef3af56` staging, simulated on a stand-in
    candidate, gives `63 paths match exactly`.
  - The installed broker, supervisor, runner and proxy are byte-identical at
    `d052e416` (`97e0a207…`, `0850c329…`, `de4f44d6…`, `f5e63612…`), so
    nothing is reinstalled.

### Next (operator)

1. Stage `d052e416`; the status should report `"approle_login": "ok"`.
2. Run step 2c: binding `87698f27…` is revoked, so the proof needs a new
   binding.
3. Run step 3b, then read back the ledger.

A4 remains **not accepted**. The `login` and `rotation` cases have passed on
the host (gate 4 in part), and a canary scan has passed (gate 5), but
`budget` and `revocation` must pass, and the canary must pass again after the
final run.

## 2026-09-28 fourth host run: the full A4 proof and the canary pass; acceptance

The user pasted every output. No value appears in any of it.

### Staging and binding

- **Staging `d052e416`.** `staged b6cae65e193f778d7bff632e3d5ab14ceee9366f (was
  79539297…) from d052e416…; 63 paths match exactly`.
- **Status after staging.** The installed files are unchanged (`97e0a207…`,
  `23aeff46…`), `vault_healthy: true`, and **`approle_login: ok`** (the new
  check).
- **Step 2c.**
  - Revoking `87698f27…` was refused with `BINDING_REVOKED` (the proof had
    revoked it); its ID file was kept.
  - Provider revision 3 (vault version 1, 16:11:31Z).
  - New binding `fae88e7f-3732-4c99-80e9-60645c37ffaa` (project `ba73a818-…`,
    profile `9e72c127-…`), revision 1, active.
  - `"provisioned": true`: verifier 197 bytes at binding revision 1.
  - Status: `approle_login: ok`.

### Final A4 proof: `a4-proof-20260928T161223Z.json`, `a4_proof: passed`

| Case | Seconds | Observed |
|---|---|---|
| `proxy_policy` | 0.6 | 21 codes as installed |
| `login` | 2.0 | `signed_in`; delivery at 16:12:25 (run `ff87f168…`, revision 1) |
| `egress` | 4.1 | guest root refused to provider, vault and DNS |
| `budget` | 4.8 | below |
| `rotation` | 3.4 | revision 2 delivery at 16:12:37 (run `0b6bf69f…`) |
| `revocation` | 1.5 | below |

**`budget`.** Each run stopped before the next launched.
- **Run A** (`901d7d0b…`, `max_tokens` 145 = worst case 135 + 10, `max_usd`
  0.001):
  - **The real call** `2a955d91…`: HTTP 200, provider response
    `chatcmpl-ET8FsfxsXXEIdkcHy8ChwxnX9ZGIA`, model `gpt-6-luna`, service tier
    `default`, `finish_reason: stop`, reply excerpt "OK" (untrusted), 2135 ms.
  - **Usage and cost.** Usage: 21 prompt tokens, 4 completion, 0 cached, 0
    reasoning. Reserved $0.000022875 (135 tokens) before sending; settled
    $0.000004625 at price table revision 1.
  - **Retry.** The retry replayed the same response ID without a second
    request (`retry_replayed: true`).
  - **Budget.** The next call was refused with `BUDGET_EXHAUSTED` (tokens:
    25 settled + 135 worst case > 145). Provider requests: 1 before the
    refusals, 1 after.
- **Run B** (`e9da6759…`, 2000 tokens, $0.001):
  - `MODEL_NOT_ALLOWED` (`gpt-6-sol`).
  - `REVISION_MISMATCH` (project limits revision 2 against pinned 1).
  - `PRICE_UNKNOWN`, with the price table cleared at revision 2, then restored
    at revision 3.
  - `PROVIDER_ERROR`: one request answered HTTP 400 `invalid_request_error` /
    `integer_below_min_value` in 313 ms; the reservation was released (run B
    settled 0).
- **Run C** (`e2280e26…`, `max_usd` 0.000001): `BUDGET_EXHAUSTED` before any
  request (`budget_usd_requests: 0`).
- **Settlement arithmetic.**
  - 21 × $0.125/M + 4 × $0.50/M = $0.000004625. Uncached input is charged at
    the higher of the input and cache-write prices, because the response
    cannot show that no cache write happened: fail-closed, never
    under-charged.
  - The reservation: (71 prompt bytes + 16 + 32) = 119 input tokens × $0.125/M
    + 16 × $0.50/M = $0.000022875.
- **Real spend.** The ledger holds three settled real calls from today's runs
  (15:53, 16:01 and 16:12), $0.000013875 in the broker's accounting, plus one
  provider 400 that settled nothing.

**`revocation`.** The revoke call took 3 ms. Each of these was then refused
with `BINDING_REVOKED`, and no submit was journalled:

| After revoke | Time |
|---|---|
| broker `check` | 0 ms |
| the running attempt's next submit | 4 ms |
| a new launch | — |

The binding's state reads back `revoked` (revoked at epoch 1790611959.516).

**Ledger readback.**
- **Deliveries:** five `delivered` records across the three runs, each with the
  binding ID, revision, run and attempt only:
  - 15:53:44: `29532439…` revision 1, the run-1 sign-in the demo rejected;
  - 16:01:11 and 16:01:22: `87698f27…` revisions 1 and 2;
  - 16:12:25 and 16:12:37: `fae88e7f…` revisions 1 and 2.
- **Run pins:** one per launch, with the credential pin where the launch
  carried one. The A3 regression's launches are pinned with `credential: null`
  and no spend.

### Canary scan after the final proof: passed

`"canary_scan": "passed"`, `canary_exit=0`, binding `fae88e7f…` revision 2,
vault version 1, `encodings_searched: 4`. Every sink is `scanned: true` with
0 matches:

| Sink | Bytes | Matches |
|---|---|---|
| supervisor unit journal | 4,415 | 0 |
| broker unit journal | 776 | 0 |
| proxy unit journal | 486 | 0 |
| whole host journal (2 days) | 12,716,800 | 0 |
| guest journal | 601,497 | 0 |
| backend container logs (48 h) | 26,796 | 0 |
| receipts and supervisor state journal | 440,195 | 0 |
| broker journal and model records | 33,622 | 0 |
| page reads and proof reports | 100,115 | 0 |
| Incus logs | 150,077 | 0 |
| database files | 12,959,248 | 0 |
| database dump | 7,014,079 | 0 |
| MCP ledger | 262,486 | 0 |

The same value was delivered in five sign-ins across three proof runs and
entered once in the dashboard.

### Read back from the session (MCP, after the run)

- **`inspect_a3_vm`:** Running, VM UUID `49592202-…73e4`, boot `728c93ce…`
  (unchanged; A4 does not reboot the guest), QEMU PID 272179, 2 CPUs,
  4096 MiB, 12 GiB, swap off.
- **`get_host_services proxypilot-a`:** the fence is active/exited; the origin
  proxy, supervisor and A4 broker are active/running.
- **`test_route demo.fractionate.ai`:** edge 200, upstream 200.
- **`get_self_status`:** live `33528751` (unchanged, clean); candidate
  `b6cae65e`, 24 ahead, clean.
- **`run_self_checks`** (`backend-tests`, `backend-syntax`,
  `skip_install: true`) on candidate `b6cae65e`: `ok`. `backend-tests`: 3,339
  tests, 3,328 pass, 0 fail, 11 skipped (the native-module files).
  `backend-syntax`: exit 0. It was not promoted.

### Exact-head Security CI

- Run `36444990456` on `79817dfa` (docs): 7/7 success.
- Run `36449054256` on `c2c02aaa`, which carries the code at `d052e416`: 7/7
  success (three audits, `agent`, `backend`, `frontend`, and the base-app
  audit).

### Acceptance decision: A4 is ACCEPTED (2026-09-28)

| Gate | Evidence |
|---|---|
| Staging, proxy and supervisor reinstall, broker install, with readback | Second host run (file digests, key `062aa93b…`, SPKI `NdkAJzLx…`); fourth run status |
| Full A3 proof again (18 cases plus `minimums`) after the supervisor and runner change | `worker-proof-20260928T152421Z.json`, 19/19, at the installed `0850c329…` / `de4f44d6…`, which are unchanged since |
| Proxy policy: exactly one bounded JSON `POST /api/login`, 12 refused variants, empty logout | `a3-probe-proxy.py` 21 cases (second run) and `proxy_policy` in the final proof |
| One bound credential reaches the approved login form through the host broker, and never the model context, runner channel, page reads, logs, receipts, journals, ledger or DB | `login` (`signed_in`; receipt and journal carry ID, revision and outcome only); canary 0 matches in 13 sinks after five deliveries |
| Rotation and revocation, timed | `rotation` passed in the final proof (the third run's readback, same assertions: old revision refused at the next submit in 5 ms, at relaunch and for a new run; the new revision signs in); `revocation` (refused at the broker in 0 ms and at the next submit in 4 ms; relaunch refused) |
| Logout at stop, cookie-jar disposal | `login`: `logout: done`; no guest profile or cookie file after the stop; unit inactive |
| Egress | `egress`: guest root refused to provider, vault and DNS; fence counters moved |
| One allowlisted model route under the pinned token and spend policy, fail-closed | `budget`: one real `gpt-6-luna` call reserved, then settled with its response ID, usage, cost and price-table revision; idempotent replay; refusals `BUDGET_EXHAUSTED` (tokens and dollars), `MODEL_NOT_ALLOWED`, `PRICE_UNKNOWN`, `REVISION_MISMATCH`, `PROVIDER_ERROR` (reservation released) |
| Local suites and candidate checks | 154 script tests at `d052e416`; Operations Node 79; inventory exit 0; candidate `b6cae65e` `backend-tests` 0 fail |
| Exact-head Security CI | Run `36449054256` on `c2c02aaa` (code `d052e416`), 7/7 |

**Who can read the value** (unchanged, restated):
- The OpenBao AppRole `agent-a4-broker`, used by the root broker; its config
  is a root-only 0600 file on the host.
- Host root, and so the root-equivalent backend (S6 is open).
- OpenBao's own root custody.
- The demo origin, which verifies it against an scrypt verifier and never
  stores it.
- The page's own JavaScript inside the browser, while the form is filled.

The broker keeps it from the model, the runner's channel, page reads, logs,
receipts, journals, the ledger and the database.

**Open by name, allowed by the criteria:**
- **Host reboot persistence** of the fence, proxy, supervisor and now broker
  ordering. It needs explicit approval and a time window.
- **The backend container socket mount and coordinator wiring (A5);**
  activation stays off.
- **S6 / SEC-01 / SEC-04.**
- **Secret-ID rotation is not an immediate stop.** Issuing a new AppRole
  secret ID leaves tokens already issued valid for up to their TTL (1 h,
  max 4 h). Binding revocation is the immediate stop.

**Operational items:**
- **Proxy certificate.** The certificate from the second host run lasts 7
  days, to about 2026-10-05; launches would fail closed after that. It is now
  renewed automatically (`d932ecd2`; see the next section), once the host
  step there has run.
- **`AgentKeys`.** The agent `a4-broker` also holds a credential named
  `AgentKeys`, which A4 does not use. The AppRole can read it; remove it
  unless it is meant for this agent.
- **Synthetic account.** It stays valid on the demo for the last verifier
  (binding `fae88e7f…`, revoked at the broker). To retire it, delete
  `/opt/app/demo/synthetic-account.json` in `pp-fractionate-demo` (the server
  then ignores it), or run `a4-fixture-account.py rollback-server`.
- **Broker state.** Three revoked bindings and a run pin for every launch
  since the install remain as history; no binding is active.

Accepting A4 does not authorize A5, activation, deployment, or promotion of the
candidate to live; each is a separate user decision. The
[A5 prompt](fractionate-agents-a5-prompt.md) is now eligible, and work stops
here for review before any A5 work.

## 2026-09-28 proxy certificate: automatic renewal (after acceptance)

The user asked whether the proxy certificate is managed by Caddy / Let's
Encrypt. It is not.

### What the certificate is

- The fixed-origin proxy (`a3-origin-proxy.py`, `10.185.17.1:18083`) is how
  the proof VM's browser reaches `demo.fractionate.ai`.
  - It terminates the browser's TLS with its **own self-signed certificate**
    (CN `demo.fractionate.ai`).
  - It checks every decrypted request against the path policy, which is how
    it admits exactly one bounded `POST /api/login`.
  - It then opens its own verified TLS connection to the real origin, which
    serves Caddy's Let's Encrypt certificate.
- The guest browser trusts the proxy certificate only through the SPKI pin
  that the supervisor passes at each launch
  (`--ignore-certificate-errors-spki-list`). Nobody else trusts it.
- **Why not a Let's Encrypt or Caddy certificate.** Doing that would put a
  publicly trusted key for the real hostname, or the edge's own key, inside
  the proof boundary. Caddy is also controlled by the root-equivalent backend
  (S6 is open), so a Caddy-issued key would let a compromised backend mint
  certificates the guest accepts.
- **Why 7 days.** A3 kept the key short-lived.
- **The gap.** Until now nothing renewed the certificate. Proxy `status`
  refuses a certificate with under 24 hours left, so launches would have
  failed closed from about 2026-10-04 until someone reinstalled the proxy.

### The fix (`d932ecd2`)

**`a3-install-proxy.py renew`** re-issues the key and certificate in place.
It runs only when all of these hold:
- fewer than 3 days remain (or `--force` is given);
- the proof VM is running;
- no worker attempt is live (the supervisor operator socket reports
  `active: null`).

A live attempt's browser pinned the current key, so renewal waits for it. The
renewal then:
1. records the pending pair in the journal first, so an interrupted renewal
   is finished rather than refused;
2. writes the key (0600) and the certificate;
3. updates the recorded digests;
4. restarts the proxy and reads its status back.

The proxy source and unit are verified unchanged. The supervisor reads the SPKI
from proxy `status` at every launch, so the next launch pins the new key with
no supervisor restart.

**`proxypilot-a3-proxy-renew.timer` and `.service`** are installed, recorded
and digest-checked by `a3-install-supervisor.py`.
- The timer runs every six hours (`00/6:17`, randomized by 10 min,
  `Persistent=true`) and 10 minutes after boot.
- It runs the supervisor's installed copy of `a3-install-proxy.py`, never a
  checkout.
- The supervisor's `status` reports the timer; `remove` disables it; an
  installation from before the timer still reads back and removes.

With 3 days of lead and four checks a day, a renewal has about twelve chances
before launches would refuse the certificate. A failed run leaves the service
`failed` (visible in `get_host_services failed=true`), and the current
certificate stays in use.

**Boundary.** No socket method, peer rule, fence rule, unit property or limit
changes. The installed supervisor, runner, proxy and broker code are
byte-identical to the accepted A4 run.

**Local verification.**
- All script tests: 162 passed. The new tests use real openssl and journal
  writes:
  - not due → nothing changes;
  - due → re-issued in place, digests recorded, proxy restarted, SPKI
    changed;
  - an attempt live or the VM stopped → nothing changes;
  - an interrupted renewal is finished; a foreign certificate is refused;
  - the socket read;
  - `systemd-analyze verify` passes for the timer and service.
- Host-boundary inventory: exit 0.
- Staging `d932ecd2` over the `d052e416` staging on a stand-in candidate gives
  `63 paths match exactly`.

**Open until the host step in the [A4 reference](fractionate-agents-a4-reference.md)
("Proxy certificate renewal") runs.** That step stages `d932ecd2`, reinstalls
the supervisor (installing the timer; new receipt key), forces one renewal,
runs the timer's service once, and re-runs the proxy probe and three A3
session launches on the new pin.

### Host run 1 of the renewal step: the forced renewal worked, the timer's service did not

- **Staging.** `staged 39e3a8a91364db7fbb4d37e0267aee04dac0b3e9 (was b6cae65e…)
  from d932ecd2…; 63 paths match exactly`.
- **Supervisor reinstall.** `"installed": true`, `"accepting_launch": true`,
  `"blockers": []`.
  - New receipt key `e52ffcf3b101…66f6`; the previous `062aa93b…` was
    archived.
  - `a3-install-proxy.py` is now `59ae252e…`. The renewal service is
    `99f8c3e7…` and the timer `058e2af8…`; `"certificate_renewal"` reads
    active/enabled.
  - The supervisor, runner, origin proxy and fence digests are unchanged
    (`0850c329…`, `de4f44d6…`, `f5e63612…`, `314b7766…`, `8d756bd2…`).
- **`renew --force`** (the installed copy, run from a root shell):
  `"renewed": true`. `previous_spki_sha256` was `NdkAJzLx…qwyM=`; the new
  `certificate_spki_sha256` is `ASpAFpzeM18Iynjr8SzmdGLAnozqpdqf1BZ3S18WDnI=`,
  `not_after` Oct 5 16:54:37 2026 GMT.
- **`systemctl start proxypilot-a3-proxy-renew.service`** failed ("control
  process exited with error code"). `set -e` stopped the command, so the
  journal, the timer listing, the proxy probe and the sessions probe did not
  run.
- **Cause (my defect).** The service carried `ProtectHome=yes`. It makes the
  same Incus and nft calls as the supervisor, whose unit has no
  `ProtectHome`, and the incus client keeps its config under `/root`. That is
  the service's only restriction beyond the supervisor unit's, and the same
  command succeeded from a root shell. The next run's first lines (the
  failed run's journal) confirm or correct this.
- **Fix (`63e00295`).** Removed `ProtectHome` from the renewal service. A test
  pins that its sandbox is never tighter than the supervisor's (no
  `ProtectHome`, `ProtectSystem`, `ReadOnlyPaths`, `InaccessiblePaths` or
  `User=`); `systemd-analyze verify` passes; all script tests pass.
- **State now.** The proxy serves the renewed certificate, and the supervisor
  pins the new SPKI at the next launch. The timer is enabled, but its service
  fails until `63e00295` is installed. No renewal is due before about
  2026-10-02.

### Host run 2 of the renewal step: the timer's service renews; proven

- **The failed run's journal** (printed first) confirms the cause:
  - the first renewal run, fired by the timer at install while the installer
    held the lock, printed `"reason": "installer_busy"` and exited 0, as
    designed;
  - the `systemctl start` run printed `A3 proxy operation refused: Error:
    mkdir /root/.config: read-only file system` — the incus client under
    `ProtectHome=yes`.
- **Staging.** `staged 807219527870941c37c8c8719f7a95ae58cad755 (was 39e3a8a9…)
  from 63e00295…; 63 paths match exactly`.
- **Supervisor reinstall.** `"accepting_launch": true`, `"blockers": []`,
  `"certificate_renewal"` active/enabled.
  - Receipt key `962dc0cf07218cfdd1de71b116b636ae345c87852bc8cfdce5f5fd08f8284732`;
    the previous `e52ffcf3…` was archived.
  - The renewal service is `cfd074a8…`; the timer (`058e2af8…`) and every
    other file are unchanged.
  - The boundary pins `ASpAFpzeM18Iynjr8SzmdGLAnozqpdqf1BZ3S18WDnI=`.
- **The timer's own service, started by systemd:** success.
  `"renewed": false, "reason": "not_due"`, `not_after` Oct 5 16:54:37 2026
  GMT, `renew_within_seconds` 259200, the same SPKI. Next run in 5 h 19 min.
- **Proxy proof.** `"proxy_checks": "passed"`, the same 21 codes, and a new
  certificate hash `5a8e71ca…351f` (was `d54fdbc7…`).
- **Sessions.** `a3-probe-worker.py --only sessions`: `"worker_proof":
  "passed"`, report `worker-proof-20260928T170109Z.json`.
  - The preflight pins the new SPKI with `key_id_matches: true`.
  - Three launches: median 0.538 s, browser start 0.158 s, unit peak about
    221 MiB, 0 OOM kills.
- **CI.** Run `36454795456` on `d3a1b2b3` (code `63e00295`): 7/7 success.

**Result.** The proxy certificate now renews unattended.
- The first automatic renewal is expected at the first six-hourly check after
  2026-10-02 16:54 UTC, when under 3 days remain.
- A failed run shows as a failed `proxypilot-a3-proxy-renew.service`, with the
  cause in its journal, while the current certificate stays valid for up to
  3 more days.
