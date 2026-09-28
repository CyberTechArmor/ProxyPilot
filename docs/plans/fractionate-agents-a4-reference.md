# A4 reference: current state for any conversation

Snapshot: 2026-09-28, after the A4 implementation and local verification.
This file is the orientation page. The dated [A4 evidence](fractionate-agents-a4-evidence.md)
is the record; if the two disagree, the evidence wins. Recheck every mutable
value below (SHAs, services, VM boot) before acting.

**Status in one line:** A4 is implemented, every local suite passes, and
exact-head Security CI passed on draft PR #699 (run `36436717665`, head
`ae8c8db1`). A4 is **not accepted**: nothing is installed on the proof host
yet, and the target proofs and the canary scan are open.

## Read first

1. This page, then the A4 evidence.
2. The [A3 reference](fractionate-agents-a3-reference.md). A4 builds on its
   supervisor, runner, fence, proxy, sockets and rules. A3 was accepted on
   2026-09-28 (last section of the [A3 evidence](fractionate-agents-a3-evidence.md)).
3. The [A1–A8 plan](fractionate-agents-a1-a8.md) (A4 row),
   [host boundary](../core/security-host-boundary.md) (A3 supervisor and A4
   broker paragraphs), and `CLAUDE.md` (A3/A4 gotcha).
4. Historical: the [original A4 prompt](fractionate-agents-a4-prompt.md).

## Exact revisions (2026-09-28)

| Where | Revision | Notes |
|---|---|---|
| GitHub `main` | `0b743b2243761d578fbcaa7177b61e2cdb541dd5` | A3 accepted (PR #698). Base of A4. |
| Branch `claude/serene-franklin-eteidj` | code `9ef3af5656c58218cec9d214f18c6076a45cc2e1`; later commits are docs | Stage `9ef3af56` (fixes the proxy reinstall found on the first host run). Draft PR #699 carries Security CI. |
| ProxyPilot live checkout | `33528751b0b68771a768a69ef42c0bd614069498` | Unchanged. Promotion is a separate user decision. |
| ProxyPilot candidate (`pp-candidate`) | `10290c81…` (staged `d0d4c2de` in the first host run), 22 ahead, clean | Staging `9ef3af56` over it was simulated on a stand-in: "63 paths match exactly". The proxy is **removed** (unit not found) since that run; step 1 reinstalls it. |
| PR #686 | draft, unmerged | Keep draft. |

## Proof target

Same as A3; recheck with `inspect_a3_vm`.

| Field | Value |
|---|---|
| VM | `pp-agents-a3-debian13-proof-20260927`, UUID `49592202-a8b0-45af-9ac6-5439761d73e4` |
| Boot | `524515b5-6576-4479-8b0f-07fa4d9205c6`, QEMU PID 272179 (2026-09-28 readback). The A3 `guest_crash` case changes the boot. |
| Fixture origin | `https://demo.fractionate.ai`, LXC `pp-fractionate-demo`, `fractionate-demo.service` (`www-data`), `/opt/app/demo/server.mjs` |
| Vault | OpenBao (Docker, `127.0.0.1:18200`), agent `a4-broker` from *Platform Setup → Agents and machines (OpenBao)* |
| Model route | OpenAI `gpt-6-luna`, Chat Completions, `https://api.openai.com/v1/chat/completions`, called from the host |

## Component map

| File | Role |
|---|---|
| `scripts/a4-credential-broker.py` | **Host broker** (root daemon, installed copy only). Binding registry, run pins, `check`/`deliver`, OpenBao AppRole reads, model route, ledger. |
| `scripts/a4-install-broker.py` | `install\|status\|remove\|reinstall\|configure` (the AppRole role ID and secret ID are read without echo into a 0600 file). |
| `scripts/a4-broker-operator.py` | Root CLI: `status`, `bindings`, `bind`, `rotate`, `revoke`, `provider`, `price set\|clear`, `ledger`. No value input. |
| `scripts/a4-fixture-account.py` | `provision` (scrypt verifier of the bound value → demo guest), `deploy-server`, `rollback-server`. |
| `scripts/a4-probe.py` | **Target proof**: `proxy_policy`, `login`, `egress`, `budget`, `rotation`, `revocation`. |
| `scripts/a4-canary-scan.py` | Match counts of the canary across every sink; an unread sink fails. |
| `scripts/a3-worker-supervisor.py` | Now also: the optional `credential` launch pin, broker pin, and the `submit_bound_fixture` path; receipts carry a `credential` block; logout before teardown. |
| `scripts/a3-worker-guest.py` | Now also: FIFO receive, typed login form, one armed `POST /api/login`, clear, and logout at `stop`. |
| `scripts/a3-origin-proxy.py`, `a3-install-proxy.py`, `a3-probe-proxy.py` | Bounded JSON `POST /api/login`; `reinstall`; 21-case proxy proof. |
| `admin/frontend/demo/server.mjs` | Optional synthetic account from `synthetic-account.json` (scrypt verifier). |
| `admin/backend/src/lib/operational-credential-binding-schema.js` | Migration **1110** (binding metadata and run pin columns). |
| `admin/backend/src/lib/operational-credential-bindings.js` | Owner-only bind, rotate and revoke (no route). |
| `admin/backend/src/lib/operational-worker-boundary.js` | Launch `credential` pin, `binding_id` on submit, per-use revision checks. |
| `scripts/tests/test_a4_*.py`, `admin/backend/src/__tests__/operational-credential-bindings.test.js` | 41 Python and 6 Node tests. |

## Interfaces

**Host paths.**

| Path | Contents |
|---|---|
| `/etc/proxypilot-a4/broker/a4-credential-broker.py` | Reviewed copy (digest in the install journal) |
| `/etc/proxypilot-a4/broker-config.json` | OpenBao address, mounts, agent, AppRole role and secret ID (0600) |
| `/etc/systemd/system/proxypilot-a4-broker.service` | Unit (`RuntimeDirectory=proxypilot-a4`, 0700) |
| `/var/lib/proxypilot-a4/broker-install.json` | Install journal |
| `/var/lib/proxypilot-a4/broker/state.json` | Bindings, run pins, deliveries, price table, model ledger (no value) |
| `/var/lib/proxypilot-a4-proof/` | A4 proof reports |
| `/opt/app/demo/synthetic-account.json` (demo guest) | scrypt verifier (salt, N, r, p, key); never the value |

**Broker socket** `/run/proxypilot-a4/broker.sock`. It uses newline JSON, one
request per connection, and answers uid 0 peers only. It is never mounted into
the backend.

- Supervisor methods:
  - `pin_run {run_id, project_limits_revision, limits:{max_tokens?,max_usd?}, credential|null}`
  - `check {run_id, binding_id}`
  - `deliver {run_id, attempt_id, binding_id}`
- Operator methods:
  - `bind {binding_id, project_id, profile_id, username, vault_key}`
  - `rotate {binding_id, expected_revision}`
  - `revoke {binding_id}`
  - `bindings`
  - `provider_bind {vault_key}`
  - `price_set {model, input, cached_input, cache_write, output}` (USD per 1M tokens, decimal strings)
  - `price_clear {model}`
  - `ledger {run_id?}`
  - `status`
- Proof harness: `model_call {run_id, call_id, project_limits_revision, model, max_output_tokens (1..4096), prompt (≤4000 bytes)}`,
  plus `proof: "provider_error"` (sends `max_completion_tokens: 0`).

**Supervisor changes (same sockets and methods).**
- `launch` may carry `credential {project_id, profile_id, profile_revision,
  binding_id, binding_revision}`. It is either absent or valid; `null` is
  refused.
- `action` with `submit_bound_fixture` needs `binding_id`. The result is
  `{binding_id, binding_revision, outcome: signed_in|rejected|unknown,
  login_requests, untrusted_page_claim_authenticated_as_bound_account}`.

**Runner channel.** `{op:'action', action:'submit_bound_fixture', binding_id}`
travels in; the event `{event:'credential_channel', binding_id}` travels out.
The value goes only through
`incus exec … python3 -I -c GUEST_WRITER <pid> <unit>` stdin →
`/proc/<pid>/root/tmp/pp-a4-credential` (FIFO, 0600, uid 65534).

**New refusal codes.**
- Broker:
  - `BINDING_UNKNOWN` `BINDING_EXISTS` `BINDING_REVOKED`
    `BINDING_REVISION_MISMATCH` `BINDING_SCOPE_MISMATCH` `BINDING_MISMATCH`
    `CREDENTIAL_NOT_BOUND` `RUN_NOT_PINNED` `RUN_POLICY_MISMATCH`;
  - `VAULT_CONFIG_INVALID` `VAULT_CONFIG_MISSING` `VAULT_UNAVAILABLE`
    `VAULT_KEY_MISSING` `VAULT_VERSION_MISMATCH` `VALUE_UNSUPPORTED`;
  - `WORKER_NOT_RUNNING` `DELIVERY_FAILED`;
  - `MODEL_NOT_ALLOWED` `PRICE_UNKNOWN` `PROVIDER_KEY_UNBOUND`
    `BUDGET_EXHAUSTED` `REVISION_MISMATCH` `PROVIDER_ERROR` `USAGE_MISSING`
    `MODEL_MISMATCH` `CALL_UNCERTAIN` `CALL_REFUSED`.
- Runner: `LOGIN_FORM_MISSING` `CREDENTIAL_CHANNEL_BUSY`
  `CREDENTIAL_NOT_DELIVERED` `CREDENTIAL_FRAME_INVALID`
  `CREDENTIAL_ENTRY_FAILED`.
- Backend: `CREDENTIAL_BINDING_STALE` `CREDENTIAL_BINDING_REVOKED`
  `CREDENTIAL_REVISION_MISMATCH`.

**Receipt addition.** `credential: {binding_id, binding_revision,
submits:[{ordinal, outcome}], logout: done|failed|not_run}` and
`evidence.logout`. There is no value or hash.

**Who can read the value.** The OpenBao AppRole `agent-a4-broker` (the root
broker) can read it, as can an Infisical project Admin for values kept there
(A4 keeps none). Host root, and so the root-equivalent backend while S6 is
open, can also reach it. So can the fixture origin that verifies it, and the
login page's own JavaScript in the browser. It is kept out of the model
context, the runner command channel, page reads, logs, receipts, journals,
the ledger and the database.

## Spending semantics

- The pinned policy is the run's `max_tokens` and `max_usd`, set at launch
  under `project_limits_revision`. Unset limits are unbounded, but price and
  usage still fail closed.
- Worst case per call:
  - tokens = prompt UTF-8 bytes + 48 + `max_output_tokens`;
  - cost = those prompt tokens × max(input, cache-write) + output tokens ×
    output, in integer nano-USD rounded up.
- A reservation needs settled plus outstanding, plus the new worst case, to
  fit within each limit. It is journalled durably before sending.
- Settlement uses the provider usage at the current price-table revision.
  Uncached prompt tokens are charged at the higher rate, because the usage
  report does not say which were cache writes.
- Unknown price, service tier or model, or missing usage, keeps the whole
  reservation as spent. An explicit 4xx releases it. 5xx, a timeout or a crash
  after `sent` leaves the call `uncertain`, and it keeps the reservation.
- A call ID is single-use. A retry returns the record and never sends again.

## Host commands

Every command runs as root on the proof host. Each is one paste. Review the
output of each step before the next; no step prints a secret.

**Step 0 (dashboard, no command).**
1. Platform Setup → *Use your platform* → **Agents and machines (OpenBao)**.
   OpenBao must be verified with automatic custody.
2. Register agent `a4-broker`, with no IPv4 ranges: the broker reaches OpenBao
   on `127.0.0.1:18200` through Docker's published port, whose source address
   is not stable.
3. Keep the role ID and secret ID it shows once. Note the page's `kv` and
   `approle` mount names.
4. Assign the credential `a4-fixture-password`: a **new random value**, 16–64
   printable ASCII characters. This is the synthetic account's password and the
   canary. Enter it only there.
5. Assign the credential `openai-api-key`: an OpenAI project key restricted to
   `gpt-6-luna` with a small hard budget.
6. On OpenAI's pricing page, confirm the standard `gpt-6-luna` prices used in
   step 2 ($0.10 input, $0.01 cached input, $0.125 cache write, $0.50 output
   per 1M tokens). Change the numbers in step 2 if they differ.

**Step 1 (stage, reinstall the proxy and supervisor, install the broker, proxy proof).**

```
sudo sh -c 'set -e; C=9ef3af5656c58218cec9d214f18c6076a45cc2e1; cd /var/lib/proxypilot/self/candidate; git fetch -q https://github.com/CyberTechArmor/ProxyPilot.git claude/serene-franklin-eteidj; git merge-base --is-ancestor $C FETCH_HEAD; git show $C:scripts/a3-stage-candidate.sh | sh -s -- . $C; git rev-parse HEAD; cd scripts; python3 a3-install-proxy.py reinstall; python3 a3-install-supervisor.py reinstall; python3 a3-probe-proxy.py; python3 a4-install-broker.py install'
```

Expected output, in order:
1. `staged <sha> (was 10290c81…) from 9ef3af56…; 63 paths match exactly`, then
   the new HEAD.
2. The proxy JSON: `"installed": true` and a new `certificate_spki_sha256`
   (7-day certificate from now). `previous_removed` is `null`, because the
   first host run already removed the proxy; on a host where it is still
   installed it reads `removed: true`.
3. The supervisor JSON: `"installed": true`, `"accepting_launch": true`,
   `"blockers": []` and a new `key_id`, with the old key archived under
   `supervisor-keys/`.
4. `"proxy_checks": "passed"` with 21 `status_codes`, starting
   `403,403,200,200,403,403,403,400,…,200`.
5. The broker JSON: `"installed": true`, `"vault_healthy": false` (not
   configured yet) and `"bindings": []`.

If a step fails:
- "candidate differs from both base and reviewed commit: <path>": a
  candidate-only change. Stop and report the path.
- "Running proof VM and active fence required": start the VM through MCP only.
- "A worker attempt is live": `python3 a3-worker-operator.py status`, then
  `stop` it.
- A proxy probe mismatch: paste its JSON, which names the case.
- "Unowned broker file exists": report `ls -la /etc/proxypilot-a4`.

**Step 2 (AppRole, price, provider key, binding, fixture origin).** This step
is interactive: two hidden prompts, for the role ID and then the secret ID. It
**replaces the live demo's `server.mjs`**, keeping `server.mjs.pre-a4`.

The mount names are this host's OpenBao names: prefix `pp-g6-23bfea7a17f8`,
so the KV mount is `pp-g6-23bfea7a17f8-kv` and the AppRole mount is
`pp-g6-23bfea7a17f8-machine`. The agents page shows the same. The binding ID
is saved (not secret) to `/var/lib/proxypilot-a4/proof-binding` for step 3.

```
sudo sh -c 'set -e; cd /var/lib/proxypilot/self/candidate/scripts; python3 a4-install-broker.py configure --approle-mount pp-g6-23bfea7a17f8-machine --kv-mount pp-g6-23bfea7a17f8-kv --agent a4-broker; python3 a4-broker-operator.py price set --model gpt-6-luna --input 0.10 --cached-input 0.01 --cache-write 0.125 --output 0.50; python3 a4-broker-operator.py provider --vault-key openai-api-key; B=$(cat /proc/sys/kernel/random/uuid); P=$(cat /proc/sys/kernel/random/uuid); Q=$(cat /proc/sys/kernel/random/uuid); python3 a4-broker-operator.py bind --binding $B --project $P --profile $Q --username a4-fixture@demo.fractionate.ai --vault-key a4-fixture-password; umask 077; echo "$B" > /var/lib/proxypilot-a4/proof-binding; echo "binding=$B project=$P profile=$Q"; python3 a4-fixture-account.py deploy-server; python3 a4-fixture-account.py provision --binding $B; python3 a4-install-broker.py status'
```

Expected output:
1. `"approle_login": "ok"`.
2. The price table with `"revision": 1`.
3. The provider with `"revision": 1` and a `vault_version`.
4. The binding with `"revision": 1`, `"state": "active"` and a vault
   `path`/`version`.
5. The `binding=… project=… profile=…` line. The ID is also saved for step 3.
6. `"deployed": true` with `previous_sha256` and `server_sha256 8bb06506…`,
   `"service": "active"`.
7. `"provisioned": true`, `"binding_revision": 1`.
8. Status with `"vault_healthy": true`.

If a step fails:
- "AppRole login refused": wrong mount, role or secret, or OpenBao sealed.
  Nothing was written; rerun the whole step.
- `VAULT_KEY_MISSING`: the credential key name differs from the dashboard.
- After the binding line printed, do not rerun the whole step (it would create
  a second binding). Rerun only what failed:
  `sudo sh -c 'cd /var/lib/proxypilot/self/candidate/scripts; B=$(cat /var/lib/proxypilot-a4/proof-binding); python3 a4-fixture-account.py deploy-server; python3 a4-fixture-account.py provision --binding "$B"; python3 a4-install-broker.py status'`
- A `deploy-server` failure that left the demo broken:
  `sudo sh -c 'cd /var/lib/proxypilot/self/candidate/scripts; python3 a4-fixture-account.py rollback-server'`

**Step 3 (A3 regression, A4 proof, canary).** This takes about 6–9 minutes and
reboots the proof VM's guest once, in the A3 `guest_crash` case. The
`revocation` case ends the binding.

```
sudo sh -c 'cd /var/lib/proxypilot/self/candidate/scripts; python3 a3-probe-worker.py; echo "a3_exit=$?"; B=$(cat /var/lib/proxypilot-a4/proof-binding); python3 a4-probe.py --binding "$B"; echo "a4_exit=$?"; python3 a4-canary-scan.py --binding "$B"; echo "canary_exit=$?"'
```

Expected output:
1. `"worker_proof": "passed"` with 19 cases. `backend_refusals` now has 12
   codes, including `credential_action: CREDENTIAL_NOT_BOUND`.
2. `a3_exit=0`.
3. `"a4_proof": "passed"` with `proxy_policy`, `login`, `egress`, `budget`,
   `rotation` and `revocation` all passed, then `a4_exit=0`.
4. `"canary_scan": "passed"`: every sink `"scanned": true, "matches": 0`.
5. `canary_exit=0`.

Paste the summaries. The reports are under `/var/lib/proxypilot-a3-proof/proof/`
and `/var/lib/proxypilot-a4-proof/`.

After step 3, from the session: run `run_self_checks` (`backend-tests`,
`backend-syntax`, `skip_install: true`) on the new candidate head, and read the
units back with `get_host_services a3` / `a4` and `inspect_a3_vm`.

**Local checks** (repository root):

```
python3 -m unittest discover -s scripts/tests -p 'test_a[34]*py'
(cd admin/backend && node --test src/__tests__/operational-*.test.js)
python3 scripts/host-boundary-inventory.py
(cd admin/frontend && npm run build && npm run demo:build && npm run demo:test)
```

## Rollback order

1. Keep A2/A3/Operations activation off.
2. `a4-broker-operator.py revoke --binding <B>`. Delivery is refused at once.
3. `a4-install-broker.py remove`. This removes the unit, the copy and the
   AppRole file, and keeps the journal and ledger. Then issue a new secret ID
   for `a4-broker` in the dashboard.
4. `a4-fixture-account.py rollback-server`.
5. To return the supervisor and proxy to A3: stage `44c630fb` with its stager,
   then `a3-install-proxy.py reinstall` and `a3-install-supervisor.py
   reinstall`.
6. Revert code. Keep migration 1110 and all rows.

## Rules for every conversation

- Everything in the A3 reference rules still applies:
  - never touch `pp-nodus` or `nodus.fractionate.ai`;
  - never use `--upgrade-incus` or an archive;
  - never bypass managed-LXC refusals;
  - never weaken a test or a proof;
  - host root runs as one reviewed command;
  - supervisor and broker run from installed copies only.
- No secret value ever enters the conversation, a command line, a file in the
  repository, a log or MCP. Values are entered in the dashboard. A binding
  names a vault path and version.
- Do not widen the broker socket, the supervisor methods, the proxy policy
  (beyond the one bounded sign-in POST) or the fence.
- Do not start A5 until the A4 evidence records A4 as accepted from observed
  target evidence. The [A5 prompt](fractionate-agents-a5-prompt.md) is gated
  on that.
