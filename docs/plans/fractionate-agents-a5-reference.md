# A5 reference: current state for any conversation

Snapshot: 2026-09-28, after the first A5 host run and its fixes. Host run 2
is next.

This file is the orientation page. The dated
[A5 evidence](fractionate-agents-a5-evidence.md) is the record; if the two
disagree, the evidence wins. Recheck every mutable value (SHAs, services, VM
boot, proxy SPKI) before acting.

**Status in one line:** A5 is **not accepted**. Host run 1 (2026-09-28)
installed the A5 supervisor, runner, broker and demo server:
- The A3 proof passed 19/19, including both `model_step` refusals.
- 14 of the 18 A5 cases passed, with a real person's approval.
- A runner misclassification failed every successful sign-in
  (`unexpected_origin`). The failed cases were A4 `login`/`rotation` and A5
  `supervised_run`, `rule_only` and `outcome_classes` (challenge).
- `outside_set` depended on the model misbehaving.
- The marker scan counted its own sudo command line.

All three are fixed in `b9bd56e6` (see the evidence). **Host run 2** below is
next. Nothing is activated, merged, deployed or promoted. PR #686 and PR #699
stay draft.

## Read first

1. This page, then the [A5 evidence](fractionate-agents-a5-evidence.md).
2. The [A4 reference](fractionate-agents-a4-reference.md) and the
   [A3 reference](fractionate-agents-a3-reference.md). A5 drives their
   supervisor and broker and keeps their rules.
3. The [A5 prompt](fractionate-agents-a5-prompt.md) (gate, decisions, scope)
   and the A5 row of [the plan](fractionate-agents-a1-a8.md).

## Decisions (2026-09-28)

| Decision | Choice |
|---|---|
| Base | PR #699's head `efe0aa05` (A4, draft, unmerged) |
| Where the coordinator runs | **Option A: the proof harness.** A root script on the host, a proof SQLite database, the real supervisor backend socket. Nothing live changes. |
| Branch | `claude/beautiful-maxwell-9bldxg` |
| Who decides the next step | Hybrid: A3/A4 boundaries, then the guide's hard rules (code), then the model inside what the rules leave open |
| Where the hard rules live | One fenced `proxypilot-rules` JSON block in the reviewed guide |
| Fixtures | Inside the proxy's existing paths; a reviewed `server.mjs` with a kept backup |

## Exact revisions

| Where | Revision | Notes |
|---|---|---|
| GitHub `main` | `0b743b2243761d578fbcaa7177b61e2cdb541dd5` | A3 accepted |
| PR #699 head (A4) | `efe0aa05fcdb989efb7e84fd2e8cef224989da79` | A5's base; draft |
| A5 code, host run 1 | `6d420735b9e1b7a074a9c061ed5b6e133fb74d76` | Staged and installed in host run 1 |
| **A5 code, host run 2** | `b9bd56e6ae2a00eed08064ea06e4e01b0657ddb0` | **Stage this.** Changes the runner, the demo server, the harness and the canary scan; later commits are docs |
| Live checkout | `33528751b0b68771a768a69ef42c0bd614069498` | Unchanged |
| Candidate | `f2edffcf1f02fbc1a1d027020a1c0e0ab2598b9f` (host run 1 staging of `6d420735`) | Host run 2, step 1 stages `b9bd56e6` onto it |

**File digests** (sha256 of the file; the installers copy it byte-exact):

| File | A4 | A5 host run 1 (`6d42073`, installed) | A5 host run 2 (`b9bd56e6`) |
|---|---|---|---|
| `a3-worker-supervisor.py` | `0850c329…` | `151f1d24…` | `151f1d24…` (unchanged) |
| `a3-worker-guest.py` (runner) | `de4f44d6…` | `57770035…` | **`a631ad9d…`** |
| `a4-credential-broker.py` | `97e0a207…` | `790a1957…` | `790a1957…` (unchanged) |
| `admin/frontend/demo/server.mjs` | `8bb06506…` | `ce241fb1…` | **`496846cd…`** (marker only) |
| `a3-origin-proxy.py`, `a3-install-proxy.py` | `f5e63612…`, `59ae252e…` | unchanged | unchanged |
| `a3-network-fence.py`, `a3-install-fence.py` | `8d756bd2…`, `314b7766…` | unchanged | unchanged |

After host run 1: the supervisor receipt key is `b7fa10e4…` and the proof VM
boot is `83df9a03-e43f-4d95-80b8-3f9303e9f6e5` (A3 `guest_crash`).

## Component map

| File | Role |
|---|---|
| `admin/backend/src/lib/operational-run-policy.js` | Hard-rules schema and parser, policy document and digest, the hybrid engine `nextStep`, approval digest, claim reduction |
| `admin/backend/src/lib/operational-run-coordinator.js` | `start`, `execute`, `approve`, `stop`, `recover`, `status` |
| `admin/backend/src/lib/operational-run-schema.js` | Migration **1111** |
| `admin/backend/src/lib/operational-worker-boundary.js` | In-transaction hooks, `abandonUnlaunched`, `completed`, outcome enum, `validateModelStep`, `launcher.modelStep` |
| `admin/backend/src/lib/operational-agents-store.js` | `modelGuideConsent` (owner only, typed confirmation) |
| `scripts/a3-worker-supervisor.py` | `model_step` |
| `scripts/a3-worker-guest.py` | `classify_login`; bound session read after a submit |
| `scripts/a4-credential-broker.py` | `MAX_PROMPT_BYTES = 16000` |
| `admin/frontend/demo/server.mjs` | A5 fixture modes and the injected file entry |
| `scripts/a4-fixture-account.py` | `set-mode`, `clear-mode`, `server.mjs.previous`, `rollback-server --to` |
| `scripts/a5-probe.mjs`, `scripts/a5-proof-db.mjs` | **Target proof harness** (18 cases) and its proof database |
| `scripts/a4-canary-scan.py` | `--a5-dir`, `--a5-marker` (the marker comes from the file, never the command line) |
| Tests | `admin/backend/src/__tests__/operational-run-coordinator.test.js` (15); `scripts/tests/test_a5_{model_step,fixture_modes,probe_harness}.py` (12); A5 cases in `test_a4_credential_submit.py` |

## Interfaces

**Hard rules** (in the guide; strict):

```
{"v":1,"workflow":"synthetic_sign_in",
 "start":[…],"finish":[…],"model_actions":[…],"forbid":[…],
 "approval_required":["submit_bound_fixture",…],
 "stop_when":["verified_account"(,"files_read")],
 "max_steps":1..20,"max_model_calls":0..10,
 "model":{"name":"gpt-6-luna","max_output_tokens":1..16}|null}
```

The rules are rejected in these cases:
- `approval_required` lacks the submit;
- `stop_when` lacks `verified_account`;
- a forbidden action also appears in start, finish or the model set;
- `read_session` is forbidden;
- the submit is a finish step;
- there are model calls with `model: null`.

**Policy document** (the pre-image of `policy_digest`):
`{"v":"a5-policy-1","origin","guide_hash","rules","model_guide_consent"}`.
It is stored in `ops_agent_run_pins.policy_json`.

**Supervisor `model_step`** (backend and operator sockets).
- Request: `{run_id, attempt_id, fence, call_id, policy, guide, observations,
  allowed}`.
  - `policy` and `guide` are exact byte strings.
  - `observations` are up to 20 `{action, status: done|failed, claims}`.
    Claims are the booleans `authenticated`, `as_bound_account`,
    `sample_present` and `signed_out`, an `outcome` class, and
    `login_requests` 0..10.
  - `allowed` holds 2 to 7 distinct actions.
- Reply: `{call_id, choice, replayed, usage:{prompt_tokens,completion_tokens},
  settled_usd, price_table_revision, provider_response_id}`.
- Refusals, in check order:
  - `INVALID_REQUEST`, `TAKEN_OVER`, `ATTEMPT_NOT_ACTIVE`, `STALE_FENCE`,
    `DEADLINE`, `LEASE_EXPIRED`;
  - `RUN_POLICY_MISMATCH`, `GUIDE_HASH_MISMATCH`, `GUIDE_NOT_SHAREABLE`,
    `MODEL_NOT_ALLOWED`;
  - `INVALID_REQUEST` (allowed set);
  - `PROMPT_TOO_LARGE`;
  - then the broker's `RUN_NOT_PINNED`, `REVISION_MISMATCH`, `PRICE_UNKNOWN`,
    `PROVIDER_KEY_UNBOUND`, `BUDGET_EXHAUSTED`, `PROVIDER_ERROR`,
    `USAGE_MISSING`, `MODEL_MISMATCH`, `CALL_UNCERTAIN`, `CALL_REFUSED`;
  - finally `MODEL_CHOICE_INVALID`.
- `proof: "provider_error"` is allowed on the operator socket only.

**Runner submit outcome:** `signed_in`, `rejected`, `rate_limited`,
`challenge_required`, `unexpected_origin`, `timeout`, `unknown`.

**Result classes** (`ops_agent_run_results.result_class`; the final state is
in brackets):
- the outcome classes:
  - `verified_account` [completed];
  - `credential_rejected`, `rate_limited`, `challenge_required` (needs human),
    `unexpected_origin` [blocked];
  - `timeout` [failed];
  - `unverified_account`, `submit_failed` [blocked];
- the stops:
  - `cancelled` [cancelled];
  - `taken_over` (needs human) [blocked];
  - `interrupted` (restart; needs human) [failed];
  - `uncertain_step`, `model_uncertain` (needs human) [failed];
- the refusals:
  - `approval_stale`, `approval_timeout` [blocked];
  - `model_choice_invalid`, `guide_not_shareable`, `model_unavailable`,
    `model_call_limit` [blocked];
  - `budget_exhausted` [blocked];
  - `price_unknown`, `usage_unknown`, `provider_error` [failed];
  - `stale_configuration`, `binding_changed`, `action_not_permitted`,
    `action_limit`, `step_limit`, `no_allowed_action` [blocked];
  - `lease_expired`, `attempt_lost`, `deadline`, `launch_failed` [failed].
- The result also carries `logout` (`done|failed|not_run`), taken from the
  signed receipt.

**Harness cases** (`node a5-probe.mjs --list`):

| Case | Proves |
|---|---|
| `supervised_run` | **The one complete supervised run**, with a person approving on the TTY: land and open sign-in (rules), the model picks submit, human approval, submit, verified by the session read (rule), the model picks read_files, sign out (rule), logout at stop, verified receipt, durable result; injection on |
| `injection_scan` | The injected marker is in no proof DB, log, supervisor journal or broker journal |
| `rule_only` | A rule-decided run makes no model call anywhere |
| `outcome_classes` | expired → `credential_rejected`, locked → `rate_limited`, challenge → `challenge_required`, redirect → `unexpected_origin` (no failure counted in the shared bucket) |
| `outside_set` | A real model answer outside the set gives `model_choice_invalid` (the call settles) |
| `pins_and_consent` | A live attempt refuses an altered guide (`GUIDE_HASH_MISMATCH`), an altered policy (`RUN_POLICY_MISMATCH`) and a set not offered (`INVALID_REQUEST`); a profile without consent gets `GUIDE_NOT_SHAREABLE`, and its run makes no call |
| `duplicate_start` | `RUN_ALREADY_ACTIVE`; the unlaunched run ends without a worker |
| `approval_checks` | Wrong digest, no elevation, not eligible, stale after rotation, duplicate; no submit |
| `approval_race` | Stop then approve, and approve then stop: cancelled, no submit |
| `approval_after_revocation` | `APPROVAL_STALE` (`binding_revoked`) |
| `binding_changed_mid_run` | Broker-only revoke or rotate after the approval: the submit is refused at the broker, no delivery |
| `stale_guide_and_grant` | A guide approved mid-run and a removed grant: approval refused |
| `operator_stop` | Cancelled mid-run with a verified receipt |
| `takeover` | Operator takeover: the coordinator hands over, then collects the receipt |
| `provider_error` | The broker's provider-error proof gives `provider_error`, released |
| `unknown_price` | `price_unknown`; the price is restored |
| `budget_exhausted` | Refused before any provider request; the limits are restored |
| `coordinator_restart` | A child coordinator is SIGKILLed after reserving a step: fenced, the step is never sent, `interrupted`, receipt verified |

The `timeout` class is proven locally only (real Chromium through the real
proxy policy). It is never run on the live demo: see the proxy finding in the
evidence.

## Host commands

Every command runs as root on the proof host, as one paste. Review each
output before the next. No step prints a secret.

### Host run 2 (next): stage `b9bd56e6`, then the A3, A4 and A5 proofs again

The supervisor and broker code are unchanged since host run 1. The runner
changed, and it is installed with the supervisor, so the supervisor is
reinstalled (with a new receipt key). The broker is not reinstalled.

**Step R1 (stage, reinstall the supervisor, keep the A4 demo server aside, deploy the demo server, proxy proof).**
`deploy-server` overwrites `server.mjs.previous` with the file it replaces
(host run 1's `ce241fb1…`). The A4 server (`8bb06506…`, the current
`.previous`) is therefore first copied to `server.mjs.a4`, once.

```
sudo sh -c 'set -e; C=b9bd56e6ae2a00eed08064ea06e4e01b0657ddb0; cd /var/lib/proxypilot/self/candidate; git fetch -q https://github.com/CyberTechArmor/ProxyPilot.git claude/beautiful-maxwell-9bldxg; git merge-base --is-ancestor $C FETCH_HEAD; git show $C:scripts/a3-stage-candidate.sh | sh -s -- . $C; git rev-parse HEAD; cd scripts; python3 a3-install-supervisor.py reinstall || { echo supervisor_reinstall_failed; journalctl -u proxypilot-a3-supervisor.service --since -10min -o cat --no-pager | tail -40; exit 1; }; python3 a4-install-broker.py status; incus exec pp-fractionate-demo -- sh -c "test -e /opt/app/demo/server.mjs.a4 || cp -p /opt/app/demo/server.mjs.previous /opt/app/demo/server.mjs.a4; sha256sum /opt/app/demo/server.mjs.a4"; python3 a4-fixture-account.py deploy-server || { echo demo_deploy_failed; incus exec pp-fractionate-demo -- journalctl -u fractionate-demo.service --since -10min -o cat --no-pager | tail -40; exit 1; }; python3 a3-probe-proxy.py'
```

Expected output, in order:
1. `staged <sha> (was f2edffcf…) from b9bd56e6…; 77 paths match exactly`,
   then the new HEAD.
2. The supervisor JSON:
   - `"accepting_launch": true`, `"blockers": []`;
   - a new `key_id` (`b7fa10e4…` archived);
   - supervisor `151f1d24…` (unchanged) and runner **`a631ad9d…`**;
   - every other file unchanged.
3. The broker status: file `790a1957…`, `"approle_login": "ok"`.
4. `8bb065061749f42c…  /opt/app/demo/server.mjs.a4` (the A4 server).
5. The demo JSON:
   - `previous_sha256` `ce241fb1…`;
   - `server_sha256` **`496846cd…`**;
   - `"service": "active"`.
6. `"proxy_checks": "passed"` with 21 codes.

If `server.mjs.a4` does not print `8bb06506…`, stop and paste it.

**Step R2:** exactly step 2 below (a new A4 binding, then the full A3 proof,
the A4 proof and the canary). All six A4 cases must now pass, including
`login` and `rotation`.

**Step R3 (the A5 proof, with the marker taken from the scanner, never typed).**

```
sudo sh -c 'cd /var/lib/proxypilot/self/candidate/scripts; node --no-warnings a5-probe.mjs; echo "a5_exit=$?"; D=$(ls -td /var/lib/proxypilot-a5-proof/*/ | head -1); B=$(cat "$D/last-binding"); python3 a4-canary-scan.py --binding "$B" --a5-dir "$D" --a5-marker; echo "canary_exit=$?"'
```

Expected output: step 3's list below.
- `outside_set` now passes: the one-token reply is recorded by the
  supervisor as `invalid`.
- `host_journal_all` must show `marker_matches: 0`. The host run 1 sudo line
  carried the old marker, which is no longer searched for.

**Step R4:** step 4 below.

### Host run 1 (2026-09-28, done; the record is in the evidence)

**Step 0 (read-only, gate 3).**

```
sudo sh -c 'cd /var/lib/proxypilot/self/candidate/scripts; git -C .. rev-parse HEAD; python3 a3-install-supervisor.py status; python3 a4-install-broker.py status; python3 a3-worker-operator.py status'
```

Expected output:
1. `807219527870941c37c8c8719f7a95ae58cad755`.
2. The supervisor installed with these digests:
   - supervisor `0850c329…`, runner `de4f44d6…`, proxy `f5e63612…`;
   - fence `314b7766…` / `8d756bd2…`, proxy installer `59ae252e…`;
   - renewal service and timer `cfd074a8…` / `058e2af8…`;
   - key `962dc0cf…`;
   - `"accepting_launch": true`, and `certificate_renewal` active/enabled with
     SPKI `ASpAFpze…`. A newer SPKI after the ~4-day renewal is expected, not
     a failure.
3. The broker `97e0a207…`, `"approle_login": "ok"`, no active binding.
4. `"active": null`.

A different value is a question, not a failure: paste it.

**Step 1 (stage A5, reinstall the supervisor and broker, deploy the demo server, proxy proof).**
This **replaces the live demo's `server.mjs`**. The A4 server is kept as
`server.mjs.previous`, and the original as `server.mjs.pre-a4`.

```
sudo sh -c 'set -e; C=6d420735b9e1b7a074a9c061ed5b6e133fb74d76; cd /var/lib/proxypilot/self/candidate; git fetch -q https://github.com/CyberTechArmor/ProxyPilot.git claude/beautiful-maxwell-9bldxg; git merge-base --is-ancestor $C FETCH_HEAD; git show $C:scripts/a3-stage-candidate.sh | sh -s -- . $C; git rev-parse HEAD; cd scripts; python3 a3-install-supervisor.py reinstall || { echo supervisor_reinstall_failed; journalctl -u proxypilot-a3-supervisor.service --since -10min -o cat --no-pager | tail -40; exit 1; }; python3 a4-install-broker.py reinstall || { echo broker_reinstall_failed; journalctl -u proxypilot-a4-broker.service --since -10min -o cat --no-pager | tail -40; exit 1; }; python3 a4-install-broker.py status; python3 a4-fixture-account.py deploy-server || { echo demo_deploy_failed; incus exec pp-fractionate-demo -- journalctl -u fractionate-demo.service --since -10min -o cat --no-pager | tail -40; exit 1; }; python3 a3-probe-proxy.py'
```

Expected output, in order:
1. `staged <sha> (was 80721952…) from 6d420735…; 74 paths match exactly`,
   then the new HEAD.
2. The supervisor JSON:
   - `"installed": true`, `"accepting_launch": true`, `"blockers": []`;
   - a new `key_id` (the old key archived);
   - supervisor `151f1d24…` and runner `57770035…`;
   - proxy, fence, proxy installer and renewal files unchanged.
3. The broker reinstall JSON: `"installed": true`, `previous_removed` with
   `"approle_config_removed": false`, and the broker file `790a1957…`.
4. The broker status: `"approle_login": "ok"`, `"vault_healthy": true`, and
   the bindings, prices and provider unchanged.
5. The demo JSON:
   - `"deployed": true`;
   - `previous_sha256` `8bb06506…` (the A4 server);
   - `server_sha256` `ce241fb1…`;
   - `previous` `/opt/app/demo/server.mjs.previous` with that same
     `8bb06506…`;
   - `"service": "active"`.
6. `"proxy_checks": "passed"` with 21 codes.

If a step fails:
- "candidate differs from both base and reviewed commit: <path>": a
  candidate-only change. Stop and report the path.
- "A worker attempt is live": run `python3 a3-worker-operator.py status`,
  then `stop` it.
- A `*_failed` marker: the journal lines after it name the cause. Paste them.
- The demo is broken after the deploy:
  `sudo sh -c 'cd /var/lib/proxypilot/self/candidate/scripts; python3 a4-fixture-account.py rollback-server --to previous'`.

**Step 2 (A3 and A4 regression: a new A4 binding, the full A3 proof, the A4 proof, the canary).**
This takes about 7–10 minutes and reboots the proof VM's guest once (the A3
`guest_crash` case). It makes one real `gpt-6-luna` call.

```
sudo sh -c 'set -e; OK=openai-api-key; FK=a4-fixture-password; cd /var/lib/proxypilot/self/candidate/scripts; OLD=$(cat /var/lib/proxypilot-a4/proof-binding); python3 a4-broker-operator.py revoke --binding "$OLD" || true; mv /var/lib/proxypilot-a4/proof-binding /var/lib/proxypilot-a4/proof-binding.$OLD; python3 a4-broker-operator.py provider --vault-key "$OK"; B=$(cat /proc/sys/kernel/random/uuid); P=$(cat /proc/sys/kernel/random/uuid); Q=$(cat /proc/sys/kernel/random/uuid); python3 a4-broker-operator.py bind --binding $B --project $P --profile $Q --username a4-fixture@demo.fractionate.ai --vault-key "$FK"; umask 077; echo "$B" > /var/lib/proxypilot-a4/proof-binding; echo "binding=$B"; python3 a4-fixture-account.py provision --binding $B; set +e; python3 a3-probe-worker.py; echo "a3_exit=$?"; python3 a4-probe.py --binding "$B"; echo "a4_exit=$?"; python3 a4-canary-scan.py --binding "$B"; echo "canary_exit=$?"'
```

Expected output:
1. `BINDING_REVOKED` for the old binding (fine), or the revoke JSON; then the
   provider at the next revision, the new binding at `"revision": 1`, the
   `binding=` line, and `"provisioned": true`.
2. `"worker_proof": "passed"` with 19 cases. `backend_refusals` has 14 codes,
   including `model_step_foreign_policy: RUN_POLICY_MISMATCH` and
   `model_step_proof_flag: INVALID_REQUEST`. Then `a3_exit=0`.
3. `"a4_proof": "passed"` with the six cases, and `a4_exit=0`.
4. `"canary_scan": "passed"`, and `canary_exit=0`.

If it fails, paste the failing case's JSON; it names the case. The reports
are under `/var/lib/proxypilot-a3-proof/proof/` and
`/var/lib/proxypilot-a4-proof/`.

**Step 3 (the A5 proof; one human approval; then the canary with the A5 sinks).**
Run it in a terminal where you can type. It takes about 3–6 minutes and makes
about three real `gpt-6-luna` calls (two in the supervised run, one in
`outside_set`); the provider-error case is refused by the provider without
generating.

When the supervised run reaches the submit, the terminal shows the action,
run, attempt and fence, binding and revision, origin, guide hash, policy
digest and the **approval digest**. Check them, then type the digest's first
12 characters. Anything else refuses and stops the run.

```
sudo sh -c 'cd /var/lib/proxypilot/self/candidate/scripts; node --no-warnings a5-probe.mjs; echo "a5_exit=$?"; D=$(ls -td /var/lib/proxypilot-a5-proof/*/ | head -1); B=$(cat "$D/last-binding"); python3 a4-canary-scan.py --binding "$B" --a5-dir "$D" --a5-marker; echo "canary_exit=$?"'
```

Expected output:
1. One JSON line per case, each `"passed": true`: the 18 cases in the table
   above, starting with `supervised_run`.
2. A final line with `"a5_proof": "passed"`, the report path and the last
   binding ID. Then `a5_exit=0`.
3. `"canary_scan": "passed"`. Every sink, including `a5_proof_database_files`,
   `a5_proof_database_dump` and `a5_harness_log_and_reports`, shows
   `"scanned": true, "matches": 0, "marker_matches": 0`. Then `canary_exit=0`.

If it fails:
- `A5 proof stopped: BACKEND_MODULES_MISSING`: the candidate has no backend
  `node_modules`. From the session, run `run_self_checks` with
  `backend-tests` and without `skip_install` once; it runs `npm ci` in the
  candidate. Then rerun step 3.
- `SUPERVISOR_NOT_ACCEPTING`: the blockers are printed. Paste them.
- A case with `"passed": false` names its error. The report under
  `/var/lib/proxypilot-a5-proof/<stamp>/` has each case's typed observation.
  A failed case stops its run before the next starts. The harness always
  revokes its bindings, clears the fixture mode and restores the price and
  limits it changed.
- `outside_set` failing with the model answering inside the set is a model
  behaviour, not a boundary failure. Paste it; the case is then rerun with
  `--only outside_set`.

(Host run 1 typed `--marker A5-INJECTION-MARKER` here. That option is gone:
the typed marker was logged by sudo and counted itself.)

**Step 4 (from the session, read-only):**
- `run_self_checks` (`backend-tests`, `backend-syntax`, `skip_install: true`)
  on the new candidate head;
- `get_host_services proxypilot-a`;
- `inspect_a3_vm` (the boot changes in step 2).

**Local checks** (in a repository checkout, from its root; not on the host
from `/`):

```
python3 -m unittest discover -s scripts/tests -p 'test_a[345]*py'
(cd admin/backend && node --test src/__tests__/operational-*.test.js)
python3 scripts/host-boundary-inventory.py
(cd admin/frontend && npm run demo:build && npm run demo:test)
```

## Rollback order

1. Keep A2/A3/Operations activation off; nothing activates A5.
2. Put the demo back to the A4 server (`8bb06506…`, kept as
   `server.mjs.a4` since host run 2):
   `python3 a4-fixture-account.py clear-mode; incus exec pp-fractionate-demo -- sh -c 'cp -p /opt/app/demo/server.mjs.a4 /opt/app/demo/server.mjs && systemctl restart fractionate-demo.service'`.
   `rollback-server --to previous` restores only the file the last deploy
   replaced.
3. Return the supervisor, runner and broker to the A4 bytes. In the
   candidate, run `git revert --no-edit <the A5 staging commit>`, then
   `python3 a3-install-supervisor.py reinstall` and
   `python3 a4-install-broker.py reinstall`. Check the digests with `status`.
4. Revoke any binding still active (`a4-broker-operator.py bindings`). The
   harness revokes its own.
5. Keep or delete the proof databases under `/var/lib/proxypilot-a5-proof/`.
   They hold typed fields only.
6. For the code, revert the branch. Migration 1111 was never applied to the
   live database (option A).

## Rules for every conversation

- Everything in the A3 and A4 reference rules still applies:
  - never touch `pp-nodus` or `nodus.fractionate.ai`;
  - never use `--upgrade-incus` or an Incus archive;
  - never bypass managed-LXC refusals;
  - never weaken a test or a proof;
  - host root runs as one reviewed paste;
  - daemons run from installed copies only;
  - no secret value in the conversation, a command line, the repository, a
    log or MCP.
- No MCP tool starts a run, approves a step or enters a secret. The
  coordinator's `approve` needs an elevated human session. In the proof,
  that is the person at the host terminal.
- The only A3/A4 widenings are `model_step` and the broker's prompt cap. Do
  not add a socket method, a proxy path, a fence rule or a unit property.
- Proof runs never trip the live demo's shared sign-in limit. The fixture
  modes never count, and the harness never submits a wrong value.
- Do not start A6 until the A5 evidence records A5 as accepted from observed
  host evidence. The [A6 prompt](fractionate-agents-a6-prompt.md) is gated on
  that.
