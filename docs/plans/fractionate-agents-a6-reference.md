# A6 reference: current state for any conversation

Snapshot: 2026-09-29, after the A6 implementation, its local proof, the merge
into `main` and the deploy (live `85586aea`).

This file is the orientation page. The dated
[A6 evidence](fractionate-agents-a6-evidence.md) is the record; if the two
disagree, the evidence wins. Recheck every mutable value (SHAs, services, VM
boot, receipt key) before acting.

**Status in one line:** A6 is **implemented, proven locally, merged and
deployed; it is not accepted.** Acceptance needs the host steps below (the
supervisor's backend socket gained a read-only `view`, so the A3/A4/A5 target
proofs rerun, with the new A3 case `backend_view`), then a user decision. The
dashboard toggles are off until an administrator turns them on, and execution
is unavailable on the live dashboard until the supervisor socket is mounted
(A8). What is left is written up in the
[A6 finish prompt](fractionate-agents-a6-finish-prompt.md), with the as-built
screens and the target mockups.

## Read first

1. This page, then the [A6 evidence](fractionate-agents-a6-evidence.md).
2. The [A5 reference](fractionate-agents-a5-reference.md): A6 drives the A5
   coordinator unchanged and keeps every A3/A4/A5 rule.
3. The [A6 prompt](fractionate-agents-a6-prompt.md) (gate, decisions, scope)
   and the A6 row of [the plan](fractionate-agents-a1-a8.md).
4. `admin/frontend/MOBILE_FIRST.md` before touching the pages.

## Decisions (user, 2026-09-29)

| Decision | Choice |
|---|---|
| Base and branch | The A5 head `5210cfb7` (A5 code `9b9a15ed`, acceptance docs `21507dc`), on `ccr-4216e4d3-jsij65`. A4 (PR #699, draft) and A5 (no PR) are not in `main` |
| 1. Where a run executes | **Option A.** Routes and UI behind the false-default `OPERATIONS_AGENT_RUNS_ENABLED` (replaced on 2026-09-29 by the administrators' Agent runs dashboard toggle, still off until turned on). With no supervisor configured the backend builds no launcher and every execution control answers `EXECUTION_UNAVAILABLE`. Journeys run against a separate UI harness. Nothing live changes |
| 2. Approval gesture | Sudo elevation (`requireSudo`, the api.js modal) **plus at least the first 12 characters of the digest** (spaces and capitals allowed; any correct longer prefix accepted) |
| 3. Four-eyes | **Allow**: the person who started a run may approve its submit (as in A5) |
| 4. View-only stream | **Both**: typed progress, and a live browser view modelled on Flightdeck chat (text and screenshots). A boundary decision: the supervisor's backend socket gains a read-only `view` (pixels only), which needs its own host proof |

## Exact revisions

| Where | Revision | Notes |
|---|---|---|
| GitHub `main` | `52f26af18403dfceae6f63306521968a591ccab1` | A4–A6 merged as `469e98a9` (#700), toggles as `52f26af1` (#701) |
| A5 head (base) | `5210cfb7af3a840e1a7bbf62feca61c8993f2d68` | branch `claude/beautiful-maxwell-9bldxg` |
| A6 code | `b8178074` (UI, service, routes, supervisor `view`); `ec986a88` (`a6-host-summary.py`) | The supervisor bytes are final at `b8178074` |
| **A6 code, host steps** | **`5a8648f5cd4f453278908326cd36258714337f43`** | Stop retry for a fenced run, supervisor codes in words. **Stage this.** Later commits are docs |
| Live checkout | `85586aea843d04dd17f94d5ac4f605e7e15bf66c` | Promoted 2026-09-29 09:13Z from `33528751` (rollback tag `pp-rollback-20260929T091306Z`); the staging of `52f26af1` |
| Candidate | `85586aea843d04dd17f94d5ac4f605e7e15bf66c` | Same as live, 0 ahead. Its scripts carry the A6 bytes below; the INSTALLED supervisor is still the A5 one |

**File digests** (sha256; the installers copy byte-exact):

| File | A5 (installed) | A6 (`5a8648f5`; the same bytes at `52f26af1`) |
|---|---|---|
| `a3-worker-supervisor.py` | `151f1d24…` | **`9d195ea2…`** (backend `view`) |
| `a3-worker-guest.py` (runner) | `a631ad9d…` | `a631ad9d…` (unchanged) |
| `a4-credential-broker.py` | `790a1957…` | unchanged |
| `admin/frontend/demo/server.mjs` | `496846cd…` | unchanged |
| `a3-probe-worker.py` | — | `b770a4a9…` (adds `backend_view`) |
| `a5-probe.mjs` | `fbbda1c9…` | unchanged |
| `a6-host-summary.py` | — | `a1dfa05c…` |

Receipt key before A6: `f6304ffb…`; the supervisor reinstall archives it and
makes a new one. Proof VM boot before A6: `62801e3b-8419-40aa-85bf-dffab35788c2`
(it changes whenever the A3 `guest_crash` case runs).

## Component map

| File | Role |
|---|---|
| `admin/backend/src/lib/operational-agent-runs.js` | The A6 service: typed projections (no raw row, receipt body, prompt, page text, value, cookie or token), Operations access (outsider 404, member without `run` 403), start/stop/approve through the A5 coordinator, inbox and help requests, parsed rules, the in-memory single-flight frame cache |
| `admin/backend/src/lib/operational-agent-runtime.js` | Flags and supervisor configuration → service (with or without a coordinator) |
| `admin/backend/src/routes/operational-projects.js` | The routes (below), `agentHandle` (async, typed `code`, denial audit), injected `requireSudo` |
| `admin/backend/src/index.js` | Builds the runtime from env; `recover()` at boot only with a coordinator |
| `admin/backend/src/lib/operational-worker-boundary.js` | `launcher.view(ref)`: reply must be exactly `{png_base64,width,height}`, a PNG, ≤ 3 MiB base64 |
| `admin/backend/src/lib/operational-worker-supervisor.js` | Client method set gains `view` |
| `scripts/a3-worker-supervisor.py` | `backend_view` + `frame_only` |
| `scripts/a3-probe-worker.py` | Host case `backend_view` (A3 proof now 20 cases) |
| `scripts/a6-host-summary.py` | Read-only: every verdict from the newest A3/A4/A5 reports and the saved canary results |
| `admin/frontend/src/components/operational-projects/AgentRuns.jsx` | `AgentRunsPanel`, `AgentRunDetail`, `ApprovalDialog`, `AgentInbox` |
| `admin/frontend/src/components/operational-projects/agent-run-text.js` | Every sentence about a run: states, actions, rules, claims, result classes, help decisions, stale reasons |
| `admin/frontend/src/components/operational-projects/Agents.jsx` | `ModelConsent` (owner), `EnforcedRules` (read-only) |
| `admin/frontend/src/pages/OperationalProjectDetail.jsx`, `OperationalProjects.jsx` | The "Agent runs" section (`?section=Agent%20runs&run=<id>`), the Agent inbox panel |
| Tests | `admin/backend/src/__tests__/operational-agent-runs.test.js` (15), `helpers/agent-runs-world.js`; `operational-worker-supervisor.test.js` (launcher view); `scripts/tests/test_a3_worker_supervisor.py` (backend view); `scripts/tests/test_a6_host_summary.py` |
| Browser journeys | `admin/frontend/tests/agent-runs-harness.mjs` (UI harness) and `agent-runs.browser.mjs` (14 journeys, 72 layout checks); `agent-runs-screens.mjs` (the as-built screens in `assets/a6/`) |

## Interfaces

**Activation** (user decision, 2026-09-29): dashboard toggles, not env.
Operations → Operations settings (administrators; sudo; audited;
`lib/operations-toggles.js`, `routes/operations-settings.js`): **Operations**,
**Agent metadata**, **Agent runs**, each requiring the one before, all off until
turned on, read on every request, not writable over MCP. The former
`OPERATIONS_ENABLED`, `OPERATIONS_AGENTS_METADATA_ENABLED` and
`OPERATIONS_AGENT_RUNS_ENABLED` env vars are gone.
Execution also needs `OPERATIONS_AGENT_SUPERVISOR_SOCKET`,
`OPERATIONS_AGENT_SUPERVISOR_PUBLIC_KEY` (PEM path) and
`OPERATIONS_AGENT_VM_UUID`; none set = `not_configured`, some or invalid =
`invalid_configuration`. The container mount is A8.

**Routes** (under `/api/operational-projects`, all 404 unless the flags are on;
CSRF as everywhere; every refusal is `{error, code, …typed fields}`):

| Route | Access | Notes |
|---|---|---|
| `GET /capabilities` | any | adds `agent_runs_enabled`, `agent_execution_available`, `agent_execution_message` |
| `GET /:id/agent-runs` | run | `{own_role, execution, runs[], next_before, profiles[]}`; each profile carries `ready`, `reasons[]` (words), `active_run_id`, `binding{binding_id,revision,username}` |
| `POST /:id/agent-runs` | run | `{profile_id, credential_binding_id?}` → 201 run detail; `RUN_ALREADY_ACTIVE` carries `active_run_id` |
| `GET /:id/agent-runs/:runId` | run | run, steps (ordinal, action, decided_by, rule, state, typed claims, error_code), model_calls (allowed, choice, refusal, tokens, settled cost), approvals (the digest fields and digest, `open`), events, result (receipt as `{verified, key_id}`), `controls.stop/view {enabled, reason}`, `execution` |
| `POST /:id/agent-runs/:runId/stop` | run | 200 when the receipt is collected, 202 `stopping: true` when the fence is set and the receipt still comes; a fenced run whose receipt did not arrive (`cancelling`) may be stopped again (`controls.stop.retry`); `SUPERVISOR_UNREACHABLE`/`_TIMEOUT`/`_PROTOCOL` 503, `TEARDOWN_UNVERIFIED` 502 |
| `GET /:id/agent-runs/:runId/view` | run | `{frame:{png_base64,width,height,captured_at,action_count}}`; `VIEW_UNAVAILABLE`, `VIEW_BUSY`, `VIEW_FAILED` |
| `GET /agent-approvals` | any eligible | `{approvals[], help_requests[], execution}` across projects where the caller has run access |
| `POST /agent-approvals/:approvalId` | run + **sudo** | `{digest, confirmation}`; `APPROVAL_CONFIRMATION_MISMATCH` (400), `APPROVAL_DIGEST_MISMATCH`, `APPROVAL_NOT_PENDING`, `APPROVAL_STALE` (409, with `approval_state`, `stale_reason`), `APPROVAL_UNKNOWN` (404, also for no access) |
| `PUT /:id/agent-profiles/:profileId/model-guide-consent` | owner, `If-Match` | the A5 store method; enabling needs `reviewed_statement` |
| `GET /:id/agent-profiles/:profileId/rules` | read | `{rules}` or `{rules:null, refusal, refusal_message}` |

**Supervisor backend `view`** (A6 widening, user decision 4). Request
`{run_id, attempt_id, fence}` exactly. Refused unless the attempt is the
coordinator's running browser attempt (`TAKEN_OVER` during a takeover,
`ATTEMPT_NOT_ACTIVE` after it), within its lease and deadline; at most one
frame in flight per attempt and one per second (`VIEW_BUSY`); never renews the
lease. Reply: `{png_base64, width, height}` only (PNG magic, ≤ 3 MiB base64,
sides 1..4096), else `VIEW_INVALID`. The page URL the runner reports is
dropped; operator `view` is unchanged. Not journaled.

**Help requests:** a result with `needs_human`. Its decision class is the
result class when it is one a person decides (`challenge_required`,
`interrupted`, `uncertain_step`, `model_uncertain`, `taken_over`), otherwise
`uncertain_step`; `uncertain_steps` travels with it. The inbox lists the latest
such run per profile (a newer run of the same profile closes it).

## Host commands (A6 host run 1: required, not yet run)

Every step runs as root on the proof host, as one paste, in a terminal where
you can type. Review each output before the next. No step prints a secret.
**All five steps are required**; the last one prints every verdict.

**Step H0 (read-only; gate 3).**

```
sudo sh -c 'cd /var/lib/proxypilot/self/candidate/scripts; git -C .. rev-parse HEAD; sha256sum a3-worker-supervisor.py a3-probe-worker.py a6-host-summary.py; python3 a3-install-supervisor.py status | grep -E "a3-worker-(supervisor|guest)|accepting_launch|key_id"; python3 a4-install-broker.py status | grep -E "a4-credential-broker|approle_login"; python3 a3-worker-operator.py status'
```

Expected output:
- `85586aea843d04dd17f94d5ac4f605e7e15bf66c` (or the later staging of a
  reviewed A6 UI commit; the scripts do not change);
- the candidate files: `9d195ea2…`, `b770a4a9…`, `a1dfa05c…`;
- installed supervisor `151f1d24…`, runner `a631ad9d…`, `"accepting_launch": true`,
  key `f6304ffb…`;
- broker `790a1957…`, `"approle_login": "ok"`;
- `"active": null`.

A different value is a question, not a failure: paste it.

**Step H1 (reinstall the supervisor, proxy proof).** The deploy already put
the A6 script bytes in the candidate, so nothing is staged. Only the supervisor
file changed among the installed files, so only the supervisor is reinstalled
(with a new receipt key). The broker and the demo server stay.

```
sudo sh -c 'set -e; mkdir -p -m 700 /var/lib/proxypilot-a6-proof; cd /var/lib/proxypilot/self/candidate/scripts; git -C .. rev-parse HEAD; sha256sum a3-worker-supervisor.py; python3 a3-install-supervisor.py reinstall || { echo supervisor_reinstall_failed; journalctl -u proxypilot-a3-supervisor.service --since -10min -o cat --no-pager | tail -40; exit 1; }; python3 a4-install-broker.py status | grep -E "a4-credential-broker|approle_login"; python3 a3-probe-proxy.py'
```

Expected output, in order:
1. The candidate HEAD, then `9d195ea2…  a3-worker-supervisor.py`.
2. The supervisor JSON: `"accepting_launch": true`, `"blockers": []`, a new
   `key_id` (`f6304ffb…` archived), supervisor **`9d195ea2…`**, runner
   `a631ad9d…` (unchanged), every other file unchanged.
3. The broker `790a1957…` and `"approle_login": "ok"`.
4. `"proxy_checks": "passed"` with 21 codes.

If it fails:
- "A worker attempt is live": run `python3 a3-worker-operator.py status`, then
  `stop` it.
- `supervisor_reinstall_failed`: the journal lines after it name the cause.

**Step H2 (A3 and A4 regression with `backend_view`: a new binding, the full A3
proof, the A4 proof, the A4 canary saved for the summary).** About 7–10
minutes; reboots the proof VM's guest once (`guest_crash`); one real
`gpt-6-luna` call.

```
sudo sh -c 'set -e; OK=openai-api-key; FK=a4-fixture-password; cd /var/lib/proxypilot/self/candidate/scripts; OLD=$(cat /var/lib/proxypilot-a4/proof-binding); python3 a4-broker-operator.py revoke --binding "$OLD" || true; mv /var/lib/proxypilot-a4/proof-binding /var/lib/proxypilot-a4/proof-binding.$OLD; python3 a4-broker-operator.py provider --vault-key "$OK"; B=$(cat /proc/sys/kernel/random/uuid); P=$(cat /proc/sys/kernel/random/uuid); Q=$(cat /proc/sys/kernel/random/uuid); python3 a4-broker-operator.py bind --binding $B --project $P --profile $Q --username a4-fixture@demo.fractionate.ai --vault-key "$FK"; umask 077; echo "$B" > /var/lib/proxypilot-a4/proof-binding; echo "binding=$B"; python3 a4-fixture-account.py provision --binding $B; set +e; python3 a3-probe-worker.py; echo "a3_exit=$?"; python3 a4-probe.py --binding "$B"; echo "a4_exit=$?"; python3 a4-canary-scan.py --binding "$B" > /var/lib/proxypilot-a6-proof/canary-a4.json; echo "canary_exit=$?"; grep -E "\"canary_scan\"" /var/lib/proxypilot-a6-proof/canary-a4.json'
```

Expected output:
1. `BINDING_REVOKED` for the old binding (fine) or the revoke JSON; the
   provider at its next revision; the new binding at `"revision": 1`; the
   `binding=` line; `"provisioned": true`.
2. `"worker_proof": "passed"` with **20** cases, including `backend_view`
   (`busy: VIEW_BUSY`, `lease_renewed_by_view: false`, `extra_field:
   INVALID_REQUEST`, `operator_view_has_url: true`, `during_takeover:
   TAKEN_OVER`, `backend_input: METHOD_NOT_ALLOWED`, `after_stop:
   ATTEMPT_NOT_ACTIVE`, and a screenshot path). `backend_refusals` keeps its
   14 codes. Then `a3_exit=0`.
3. `"a4_proof": "passed"` with six cases, `a4_exit=0`.
4. `canary_exit=0` and `"canary_scan": "passed"`.

**Step H3 (the A5 proof; one human approval; the A5 canary saved).** Same as
A5 step 3: at the prompt, check the fields and type at least the first 12
characters of the approval digest (a longer correct prefix is fine).

```
sudo sh -c 'cd /var/lib/proxypilot/self/candidate/scripts; node --no-warnings a5-probe.mjs; echo "a5_exit=$?"; D=$(ls -td /var/lib/proxypilot-a5-proof/*/ | head -1); B=$(cat "$D/last-binding"); python3 a4-canary-scan.py --binding "$B" --a5-dir "$D" --a5-marker > /var/lib/proxypilot-a6-proof/canary-a5.json; echo "canary_exit=$?"; grep -E "\"canary_scan\"" /var/lib/proxypilot-a6-proof/canary-a5.json'
```

Expected output: 17 JSON case lines, each `"passed": true`; the final
`"a5_proof": "passed"` line; `a5_exit=0`; `canary_exit=0` and
`"canary_scan": "passed"`. If `BACKEND_MODULES_MISSING`, run `run_self_checks`
with `backend-tests` once (since the deploy, the live policy's install step
restores the native addon itself), then rerun H3.

**Step H4 (read-only summary; required).**

```
sudo sh -c 'python3 /var/lib/proxypilot/self/candidate/scripts/a6-host-summary.py; echo "summary_exit=$?"'
```

Expected output: one JSON document with `a3` passed 20/20 (its `case_names`
include `backend_view`), `a4` passed 6/6, `a5` passed 17/17, two `canary`
entries passed with `unclean_sinks: []`, `"all_passed": true`, then
`summary_exit=0`. Paste the whole document.

**Step H5 (from the session, read-only):** `run_self_checks` (`backend-tests`,
`backend-syntax`) on the candidate head;
`get_host_services proxypilot-a`; `inspect_a3_vm` (the boot changes in H2).

**Local checks** (from a repository checkout's root):

```
python3 -m unittest discover -s scripts/tests -p 'test_a[3456]*py'
(cd admin/backend && node --test src/__tests__/operational-*.test.js)
python3 scripts/host-boundary-inventory.py
(cd admin/frontend && npm run build && node tests/agent-runs.browser.mjs)
```

## Rollback order

1. Turn Agent runs (or Operations) off in Operations → Operations settings;
   keep every other activation off.
2. Supervisor: in the candidate, `git checkout 8d25755c -- scripts/a3-worker-supervisor.py`
   (the A5 staging, `151f1d24…`), commit, then
   `python3 a3-install-supervisor.py reinstall`; `status` shows `151f1d24…`
   again (with a new key).
3. For the deployed code: `rollback_self` to `pp-rollback-20260929T091306Z`
   (`33528751`) **and** restore the database backup taken before the promote
   (`/data/db/backups/proxypilot-pre-A6-toggles-promote-20260929T091251Z.db`
   inside the container), because the deploy applied the A4/A5 migrations
   (up to 1111). A6 itself has no migration.

## Rules for every conversation

- Everything in the A3, A4 and A5 references still applies (never touch
  `pp-nodus` or `nodus.fractionate.ai`; never `--upgrade-incus` or an Incus
  archive; never bypass managed-LXC refusals; never weaken a test or a proof;
  host root runs as one reviewed paste; daemons run from installed copies; no
  secret in the conversation, a command line, the repository, a log or MCP).
- Human-only: no MCP tool, catalog entry or policy allowlist starts, approves
  or stops a run, or reaches the live view (`operational-agent-runs.test.js`
  ratchet). Approval needs an authenticated session, sudo and the typed digest.
- The only A6 widening is the backend socket's read-only `view`. Input,
  takeover and every other operator control stay on the operator socket.
- Frames are pixels only, memory only: never written to the database, a log,
  a report or the journal.
- A6 is not accepted. After the host run is recorded, acceptance is a user
  decision; A7 (`fractionate-agents-a7-prompt.md`) waits for it.
