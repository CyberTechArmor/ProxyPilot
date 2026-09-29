# A5 supervised execution loop — evidence

**A5 is ACCEPTED (2026-09-29).** Host run 3 (last section) passed on the
installed A5 supervisor (`151f1d24…`), runner (`a631ad9d…`), broker
(`790a1957…`) and demo server (`496846cd…`):
- the full A3 proof, 19/19;
- the A4 proof, 6/6;
- all 17 A5 cases, with one real person's approval and a verified account;
- both canary scans (0 values, 0 markers);
- the candidate `backend-tests`, 0 fail.

Open items are named in the acceptance decision. Nothing is activated, merged,
deployed or promoted. PR #686 and PR #699 stay draft.

The [A5 reference](fractionate-agents-a5-reference.md) is the orientation page.
This file is the record: later dated sections win.

## 2026-09-28 gate check, decisions, implementation and local verification

### Gate

1. **A4 is ACCEPTED.** `fractionate-agents-a4-evidence.md` (branch
   `claude/serene-franklin-eteidj`) carries "2026-09-28 fourth host run: the
   full A4 proof and the canary pass; acceptance", with "Acceptance decision:
   A4 is ACCEPTED (2026-09-28)" and its open items named:
   - host reboot persistence;
   - the backend container socket mount and coordinator wiring (A5);
   - S6 / SEC-01 / SEC-04;
   - secret-ID rotation is not an immediate stop.
2. **Where A4's code lives.** PR #699 is open, draft and unmerged. Its head is
   `efe0aa05fcdb989efb7e84fd2e8cef224989da79`; the last code commit is
   `63e00295`, and later commits are docs. `main` is `0b743b22`.
   - **The user chose to build A5 on #699's head.** Nothing was merged,
     un-drafted or closed.
3. **Host state, read-only (MCP, 2026-09-28 ~20:30 UTC).**

   | What | Observed | Expected |
   |---|---|---|
   | Candidate | `807219527870941c37c8c8719f7a95ae58cad755`, 26 ahead, clean; last checks `b6cae65e` green | matches |
   | Live checkout | `33528751…`, clean, `main` | matches |
   | Proof VM | UUID `49592202-a8b0-45af-9ac6-5439761d73e4`, boot `728c93ce-2436-44a7-818b-017ee50645c9`, QEMU PID 272179, running, 2 vCPU / 4096 MiB / 12 GiB, no swap | matches |
   | Services | fence active/exited; origin proxy, supervisor, broker active/running; renewal timer active/waiting (its service inactive/dead between runs) | matches |
   | Host Node | `nodejs 24.21.0-1nodesource1` (dpkg) | needed by the proof harness (`node:sqlite`) |

   - The installed file digests, the receipt key, `approle_login` and the SPKI
     are read by host root only. The reference's step 0 prints them before
     any change.

### Decisions (user, 2026-09-28)

- **Base:** build on PR #699's head, not on `main`.
- **Decision 1, where the coordinator runs:** **option A, the proof harness.**
  A root script on the host runs the candidate's coordinator with a
  temporary proof SQLite database against the real supervisor backend socket.
  Nothing live changes, and the container socket mount stays an A8 item.
- **Branch:** `claude/beautiful-maxwell-9bldxg`, cut from `efe0aa05`, so A5
  stays separate from PR #699.
- **Hard rules:** a structured section of the guide (one fenced
  `proxypilot-rules` JSON block), reviewed and hashed with the guide through
  the existing independent review path.
- Decisions 2 (hybrid) and 3 (fixtures) were already recorded in the A5
  prompt.

### What changed

**Backend** (a library only: no route, no starter, activation off).

- `lib/operational-run-policy.js`
  - **Hard rules** are one fenced block in the guide:
    - `start` and `finish` fix the automated steps;
    - `model_actions` is the set the model may choose from;
    - `forbid` removes actions;
    - `approval_required` must contain `submit_bound_fixture`;
    - `stop_when` must contain `verified_account` (it may add `files_read`);
    - `max_steps` and `max_model_calls` cap the run;
    - `model` names `gpt-6-luna` with an output cap of at most 16 tokens, or is
      `null`.

    The schema is strict: none, two, bad JSON or an unknown key refuses the
    run.
  - **Policy pin.** The policy document is `{v, origin, guide_hash, rules,
    model_guide_consent}`. Its sha256 is the run's `policy_digest`, which the
    store, the supervisor and the broker already pin (`RUN_POLICY_MISMATCH`).
    The guide document is the exact bytes that `ops_guide_versions.content_hash`
    covers (`JSON.stringify({format:1,title,instructions})`).
  - **The engine** (`nextStep`). Precedence:
    1. a failed or non-`signed_in` submit maps to its outcome class;
    2. a `signed_in` submit is verified by the runner's own session read
       (rule `verify_account`);
    3. the finish steps run once the stop conditions hold;
    4. `max_steps`;
    5. the start sequence;
    6. otherwise the open set: none stops the run, exactly one is
       rule-decided (`single_choice`), and two or more go to the model.

    Each action runs at most once. The submit is offered only with a binding.
  - **Approval digest:** sha256 over run, attempt, fence, action, binding ID
    and revision, guide hash, policy digest and origin.
  - **Claim reduction:** page results keep only typed booleans, the outcome
    class and a small count. Page text never survives.
- `lib/operational-run-coordinator.js`
  - `start` needs an eligible account with `run` access. It pins everything
    in the worker store's `prepare` transaction, together with the
    `ops_agent_run_pins` row. A second start for the profile gets
    `RUN_ALREADY_ACTIVE`.
  - `execute`: reserve the attempt, launch, bind the VM and boot, a heartbeat
    (the supervisor and store leases every 10 s), then the step loop.
  - Each step reserves durably before the supervisor acts: the
    `authorizeAction` transaction also writes the step row and consumes the
    approval.
  - A transport failure after the reservation leaves the step `uncertain`, and
    it is never replayed.
  - `approve` needs an elevated session and run access, and a digest that
    still holds. Otherwise it returns `APPROVAL_STALE`, `APPROVAL_NOT_PENDING`
    or `APPROVAL_DIGEST_MISMATCH`. A stop closes open approvals in its fence
    transaction.
  - `stop` fences the run, stops at the supervisor, verifies the signed
    receipt, and writes the result in the terminal state's transaction.
  - `TAKEN_OVER` waits for the person to finish, then collects the receipt.
  - `recover` fences every active run. Reserved steps and model calls become
    `uncertain`, and each run ends `interrupted` with `needs_human` once its
    receipt verifies.
- Migration **1111** (`lib/operational-run-schema.js`, registered in `db.js`).
  - Tables: `ops_agent_run_pins`, `ops_agent_run_steps`,
    `ops_agent_model_calls`, `ops_agent_run_approvals` and
    `ops_agent_run_results`.
  - A row changes only out of its open state; results never change.
  - `ops_agent_profiles.model_guide_consent` defaults to 0. It is set owner
    only with a typed confirmation (`modelGuideConsent`), which bumps the
    profile revision.
  - There is no column for page text, a prompt, a value, a cookie or a token.
- `lib/operational-worker-boundary.js`
  - Optional in-transaction hooks on `prepare`, `authorizeAction`, `fence`,
    `finishStop` and `recover`.
  - `abandonUnlaunched`, for a run that never reserved an attempt.
  - The `completed` stop label.
  - The runner's outcome enum.
  - `validateModelStep` and `launcher.modelStep`. A choice outside the
    allowed set is `MODEL_CHOICE_INVALID`.
- `lib/operational-worker-supervisor.js`: the client allows `model_step`.

**Host.**

- **Supervisor** (`a3-worker-supervisor.py`, `151f1d24…`, was `0850c329…`).
  - A backend `model_step`, the one approved widening, bound to the live
    attempt, fence and pinned run. It refuses, in order:
    - `RUN_POLICY_MISMATCH`, when the policy bytes do not hash to the pinned
      digest;
    - `GUIDE_HASH_MISMATCH`, when the guide bytes do not hash to the policy's
      guide hash;
    - `GUIDE_NOT_SHAREABLE`, when consent is false;
    - `MODEL_NOT_ALLOWED`;
    - `INVALID_REQUEST`, when the allowed set is not within the rules' offered
      set, has fewer than two actions, or the observations are not typed;
    - `PROMPT_TOO_LARGE` (over 16000 bytes).
  - It then journals the step, and forwards one fixed prompt to the broker's
    `model_call` with the run's pinned limits revision and the rules' output
    cap.
  - It returns `{call_id, choice, replayed, usage, settled_usd,
    price_table_revision, provider_response_id}`, never model text. A reply
    that is not exactly one allowed name (quotes or a full stop allowed) is
    `MODEL_CHOICE_INVALID`.
  - `proof: "provider_error"` is accepted on the operator socket only.
  - Stop reason `completed` is added.
- **Runner** (`a3-worker-guest.py`, `57770035…`, was `de4f44d6…`).
  - `classify_login` gives the submit outcome: `signed_in` only when the
    status is 200 and the runner's own session read names the bound account.
    The other classes are:
    - `unexpected_origin`: a redirect, or a request refused by the fixed
      origin policy during the sign-in;
    - `rate_limited`: 429;
    - `challenge_required`: the session reports `mfa`, `passkey`, `captcha`
      or `consent`;
    - `rejected`: 400, 401 or 403;
    - `timeout`: no status, 502 or 504;
    - `unknown`: anything else.
  - After a submit, `read_session` also reports
    `untrusted_page_claim_authenticated_as_bound_account`. Before a submit the
    result is unchanged, so the A3 proof's exact assertions still hold.
- **Broker** (`a4-credential-broker.py`, `790a1957…`, was `97e0a207…`).
  - `MAX_PROMPT_BYTES` goes from 4000 to 16000. The reservation arithmetic is
    unchanged (bytes + 48 + max output).
- **Demo** (`server.mjs`, `ce241fb1…`, was `8bb06506…`).
  - An optional `a5-fixture.json` holds the modes `normal`, `expired` (401),
    `locked` (429 for this account only), `challenge` (a pending `mfa` in the
    session) and `redirect` (302 to the same-origin `/external-login`).
    - They apply to the synthetic account only, after a correct password.
    - They never count toward the shared failure bucket.
  - `injection` adds a file entry whose text instructs an agent. It is visible
    only to the synthetic session.
  - It uses only the paths the proxy already allows. There is no new proxy
    path.
- **Fixture tool** (`a4-fixture-account.py`).
  - `set-mode` and `clear-mode`.
  - `deploy-server` also keeps the file it replaces as `server.mjs.previous`,
    and `rollback-server --to previous` restores it.
- **Proof harness** (`a5-probe.mjs` + `a5-proof-db.mjs`).
  - It is a root Node process (Node 22.13+, `node:sqlite`). It runs the
    candidate's coordinator against a proof database under
    `/var/lib/proxypilot-a5-proof/<stamp>/`.
  - 18 cases.
  - The supervised run's approval is typed by a person on the TTY: the first
    12 characters of the digest shown. Every other approval is the harness's
    own and is labelled `proof-harness`.
  - It creates a binding per case (broker and proof DB, same IDs) and revokes
    them all at the end.
  - It clears the fixture mode and restores the price and limits it changed.
- **Canary scan.** `--a5-dir` adds the proof database (files and a dump) and
  the harness log and reports as sinks. `--marker` counts the injected marker
  in every sink.
- **A3 target proof.** `backend_refusals` gains
  `model_step_foreign_policy: RUN_POLICY_MISMATCH` and `model_step_proof_flag:
  INVALID_REQUEST` (14 codes).

**Boundary.** These are unchanged:
- the root-peer rule;
- every other socket method;
- the fence, unit properties and limits;
- the origin proxy (`f5e63612…`) and its installer (`59ae252e…`);
- the fence scripts (`8d756bd2…`, `314b7766…`);
- the broker's value path;
- "binding ID, revision and outcome only" in results and receipts.

The widenings are `model_step` and the broker's prompt cap (decision 2). The
`completed` label and the finer outcome classes add no capability.

### Local verification (this session, code `6d420735b9e1b7a074a9c061ed5b6e133fb74d76`)

- **Script tests:** `python3 -m unittest discover -s scripts/tests -p
  'test_a[345]*py'` ran 148 tests, all OK.
  - `test_a5_model_step.py` (6): model_step through the real Supervisor and
    real Broker classes. It covers:
    - pins, consent, the allowed set, observations, prompt size, budget,
      price, provider error and invalid choices;
    - a replay without a second request;
    - takeover;
    - the `completed` receipt.
  - `test_a4_credential_submit.py` gained a **real-Chromium test through the
    real origin-proxy policy**. From one correct bound value, the six fixture
    modes give `signed_in`, `rejected`, `rate_limited`, `challenge_required`,
    `unexpected_origin` and `timeout` (the proxy's 8 s upstream timeout
    answers 502). The pure `classify_login` table is tested too.
  - `test_a5_fixture_modes.py` (4): mode documents, deploy keeping
    `server.mjs.previous`, rollback, the demo accepting the Python mode file,
    and the A5 canary sinks and marker.
  - `test_a5_probe_harness.py` (2): **the harness end to end.** It runs as a
    Node process against the real Supervisor and Broker socket servers (uid-0
    peer rule), with a scripted runner, provider and fixture tool.
    - All 18 cases pass. The one human approval is answered through a real
      pseudo-terminal from the printed digest.
    - The injected marker is in no proof file and in no prompt.
    - Every binding is revoked at the broker, and the fixture is cleared.
    - A person who refuses stops the run, and no submit reaches the
      supervisor.
- **Harness defects the end-to-end test found (fixed before commit):**
  - `world.operator` named both the operator-socket call and the seeded
    operator user;
  - an `undefined` launcher in the options spread over the real one;
  - after removing the operator's grant, the case read the run as the
    operator, and the grant was not restored, so later cases cascaded;
  - a plain `fs` read of the TTY left a blocking read in the thread pool, so
    Node never exited after the last case. It now uses `tty.ReadStream`, and
    the harness exits explicitly.
- **Operations Node:** `node --test src/__tests__/operational-*.test.js`, 94
  passed (79 before, plus 15 in `operational-run-coordinator.test.js`). The
  new tests cover:
  - rules;
  - claim reduction;
  - the engine;
  - one full run (rule and model steps, human approval, verified account,
    typed sinks with no injected text, immutable history);
  - a rule-only run with no model call;
  - no consent (no call);
  - a choice outside the set;
  - the provider, price, usage, budget and transport refusals;
  - all six outcome classes;
  - the approval refusals (elevation, access, digest, stale after rotation,
    duplicate, revocation);
  - the approval-versus-stop race;
  - a guide approved mid-run;
  - coordinator restart (fenced, never replayed, receipt);
  - an uncertain step;
  - takeover;
  - no binding means no submit;
  - **the JS policy and guide bytes accepted by the Python supervisor's
    `model_policy`** (non-ASCII, quotes, backslash, U+2028).
- **Backend `npm test`:** 3394 tests, 3369 pass, 11 fail. The same 11 fail on
  the base `efe0aa05` in this sandbox (3380 / 3355 / 11); they are
  environment-only, and none is an Operations test.
- **Demo:** `npm run demo:build` passes, and `npm run demo:test` passes 3/3,
  including the A5 modes. Nine fixture refusals leave the shared bucket
  untouched, and the public account never sees a mode or the injected entry.
- **Host-boundary inventory:** exit 0.
- **Staging (stand-in candidate).** From `12ad1392` plus a candidate-only
  policy line:
  - staging `63e00295` gave `63 paths match exactly`;
  - staging `6d42073` on top gave `74 paths match exactly`;
  - the candidate-only line was preserved.

### Findings to carry

- **The origin proxy can resend the one admitted sign-in POST.** In
  `a3-origin-proxy.py`, an `OSError` after `upstream.request(...)` (for
  example a read timeout in `getresponse()`) moves on to the next public
  address and sends the request again. A4's "exactly one bounded POST" holds
  per browser tunnel, not per upstream attempt.
  - It was not changed here: the proxy policy is outside A5's widening.
  - The harness never uses a slow mode on the live demo (the `slow` class is
    proven locally only).
  - Fix candidate for a later section: retry only on connect failures, never
    after the request was sent.
- **The fixture page's hidden input.** On the local test page, a successful
  sign-in only hides the dialog, so the typed `clear` (visible dialog only)
  leaves the value in a hidden input. The real demo unmounts the dialog and
  resets its password state on close. The assertion is kept where the dialog
  stays open, and this is recorded rather than hidden.

### Open (A5 acceptance needs all of these)

1. **Host step 0** (read-only): the gate 3 values from the installers'
   `status`.
2. **Host step 1:** stage `6d42073`, reinstall the supervisor and broker,
   deploy the demo server, then the proxy proof (21).
3. **Host step 2:** a new A4 binding, then the full A3 proof (19, with 14
   backend refusals), the A4 proof (six cases) and the canary scan.
4. **Host step 3:** the A5 proof with a person at the terminal, then the
   canary scan with the A5 sinks and the marker.
5. **Session step 4:** `run_self_checks` on the new candidate head,
   `get_host_services`, and `inspect_a3_vm`.
6. The A5 acceptance decision, recorded here.

Exact-head Security CI runs only on a draft PR, if the user asks for one.

## 2026-09-28 host run 1: the A3 proof passes; a runner defect fails every successful sign-in

The user pasted every output. No value appears in any of it.

### Step 0 (gate 3, read-only): as expected

- The candidate was `807219527870941c37c8c8719f7a95ae58cad755`.
- The supervisor was installed with the expected digests:
  - supervisor `0850c329…`, runner `de4f44d6…`, proxy `f5e63612…`;
  - fence `314b7766…` / `8d756bd2…`, proxy installer `59ae252e…`;
  - renewal `cfd074a8…` / `058e2af8…`;
  - key `962dc0cf…`, `accepting_launch: true`, SPKI `ASpAFpze…`, boot
    `728c93ce…`.
- The broker was `97e0a207…` with `approle_login: ok`, three revoked
  bindings and none active, price table revision 3, provider revision 3.
- The operator status showed `active: null`.

### Step 1: staged and installed as expected

- **Staging.** `staged f2edffcf1f02fbc1a1d027020a1c0e0ab2598b9f (was
  80721952…) from 6d420735…; 74 paths match exactly`.
- **Supervisor reinstall.** Supervisor `151f1d24…`, runner `57770035…`, the
  rest unchanged, `accepting_launch: true`.
  - The new receipt key is `b7fa10e409257cb827280ac8969fc060589d36fd22302262b15d823d27fec62c`;
    `962dc0cf…` was archived.
- **Broker reinstall.** Broker `790a1957…`, `approle_config_removed: false`,
  `approle_login: ok`; bindings, prices and provider kept.
- **Demo deploy.** `previous_sha256 8bb06506…`, `server_sha256 ce241fb1…`,
  `previous` `/opt/app/demo/server.mjs.previous`, service active.
- **Proxy proof.** `proxy_checks: passed`, 21 codes (unchanged).

### Step 2: the A3 proof passes; A4 `login` and `rotation` fail

- **Binding.** New binding `965b99f7-7d8c-4926-9ce0-47179a2c7fbb` (revision
  1), provider revision 4, verifier provisioned.
- **A3 proof.** `worker_proof: passed`, **19/19**, report
  `worker-proof-20260928T211143Z.json`.
  - `backend_refusals` shows the 14 codes, including
    `model_step_foreign_policy: RUN_POLICY_MISMATCH` and
    `model_step_proof_flag: INVALID_REQUEST`.
  - `guest_crash` moved the boot to `83df9a03-e43f-4d95-80b8-3f9303e9f6e5`.
  - Sessions: unit peak 218–223 MiB. At the minimums: 225–227 MiB and no OOM.
- **A4 proof.** `a4-proof-20260928T211441Z.json`, **failed**:
  - passed: `proxy_policy`, `egress`, `budget` (one real call,
    `chatcmpl-ETCyQhngksYCjC2rLh94pvY38TaUx`, settled $0.000004625), and
    `revocation`;
  - **failed: `login`** with `outcome: unexpected_origin` although
    `untrusted_page_claim_authenticated_as_bound_account: true` and
    `login_requests: 1`;
  - **failed: `rotation`**, the same assertion on the new revision's sign-in.
- **Canary.** `canary_scan: passed`, 0 matches in 13 sinks.

### Step 3: 14 of 18 A5 cases pass; one real human approval

- **The approval.** The terminal showed the approval block for run
  `69f3514d-…`:
  - attempt `a542fec4-…`, fence 1;
  - binding `cc9ad9fd-…` revision 1;
  - guide hash `d151cec9…`, policy digest `96d9075f…`;
  - digest `53a4f74814cf9e0b…`.

  The person typed `53a4f74814cf`. The approval was accepted and consumed,
  and the submit ran.
- **Passed (14):**
  - `injection_scan`, `pins_and_consent`, `duplicate_start`;
  - `approval_checks`, `approval_race`, `approval_after_revocation`;
  - `binding_changed_mid_run`, `stale_guide_and_grant`;
  - `operator_stop`, `takeover`;
  - `provider_error`, `unknown_price`, `budget_exhausted`;
  - `coordinator_restart`.
- **Failed:**
  - `supervised_run`: `result_class: unexpected_origin`. The model chose the
    submit (1 model step, 1 call), the submit outcome was
    `unexpected_origin`, logout `done`, receipt verified.
  - `rule_only`: `unexpected_origin`, with 0 model calls (that part held).
  - `outcome_classes`: `expired` and `locked` gave their classes, and
    `challenge` gave `unexpected_origin`.
  - `outside_set`: the model answered `read_workspace`, inside the allowed
    set. The run ended `no_allowed_action`.
- **Canary.** 0 value matches in all 16 sinks, including the three A5 sinks.
  But `host_journal_all` had `marker_matches: 1`, so the scan failed.

### Causes (confirmed)

1. **A runner defect (mine): `unexpected_origin` was over-broad.** The runner
   classified the sign-in `unexpected_origin` when **any** request was
   refused by its policy during the sign-in window.
   - On the real demo, the workspace that renders after a successful sign-in
     loads web fonts the policy refuses. The A3 `origin_refusals` case lists
     `fonts.googleapis.com` among the browser-layer refusals.
   - So every successful sign-in, and the `challenge` mode (whose 200 also
     renders the workspace), was misclassified. `expired` and `locked` keep
     the dialog open, load nothing, and were right.
   - My local fixture page loaded nothing after a sign-in, so the tests
     missed it.
   - **Fix (`b9bd56e6`):** `unexpected_origin` now means the armed sign-in
     request was itself redirected. That is detected by a
     `Network.requestWillBeSent` whose `redirectResponse` is the login URL,
     or by a 3xx status. The fixture page now loads a refused font after a
     sign-in, like the demo.
   - **Reproduced locally:** with the old runner, the real-Chromium tests fail
     exactly as the host did (`normal → unexpected_origin`, and A4's
     sign-in/logout test `'unexpected_origin' != 'signed_in'`). The new runner
     passes all six modes, including the real redirect.
2. **A harness defect: `outside_set` depended on the model misbehaving.** The
   real model obeyed ALLOWED, which is the safe behaviour.
   - **Fix:** the refusals guide caps the model at **one output token**. No
     action name is a single token, so the real reply is always outside the
     set.
   - The case now also requires the supervisor journal to record the reply as
     `invalid` with no choice.
3. **A harness defect: the marker counted itself.** The step 3 command
   carried `--marker A5-INJECTION-MARKER`, and sudo logs every command line
   in the host journal. That one match is the command, not a leak: no A5
   sink, the supervisor journal or the broker records had any.
   - **Fix:** the marker is rotated to a new value the scanner holds in code
     (`--a5-marker`), and the demo serves that value. The old sudo line no
     longer matches, and no command line ever carries the marker.

### What the run already proves (and host run 2 must repeat)

- **Staging and install:** the digests are exactly as predicted.
- **The A3 regression with the A5 runner and supervisor:** 19/19, and the
  `model_step` refusals on the target.
- **Refusals and boundaries on the target:**
  - approvals (wrong digest, no elevation, not eligible, stale after
    rotation, duplicate, race, after revocation), with no submit reaching
    the supervisor;
  - broker-side revoke and rotate mid-run;
  - a stale guide and a removed grant;
  - operator stop and takeover;
  - provider error, unknown price and budget (refused before any request);
  - coordinator restart (SIGKILL, fenced, step never sent, receipt
    verified);
  - a pinned guide or policy mismatch, a set not offered, and no consent
    (`GUIDE_NOT_SHAREABLE`, no provider call).
- **The one human approval:** it reached a real submit.
- The value canary is 0 in every sink, including the A5 proof database, log
  and reports.

### State after host run 1

- The candidate is `f2edffcf…`.
- The installed files are supervisor `151f1d24…`, runner `57770035…`,
  broker `790a1957…` and demo `ce241fb1…`. The A4 demo server is
  `server.mjs.previous`.
- The receipt key is `b7fa10e4…` and the boot is `83df9a03…`.
- The harness revoked all its bindings and cleared the fixture mode. The A4
  binding `965b99f7…` is revoked (by the `revocation` case).

### Local checks at the end of the paste

They ran from `/` on the host (`Start directory is not importable:
'scripts/tests'`, `cd: admin/backend: No such file or directory`). Those
commands are for a repository checkout. They ran here on `b9bd56e6`:
- script tests: 148 OK;
- Operations Node: 94 passed;
- demo: 3/3;
- host-boundary inventory: exit 0.

The reference now says so.

## 2026-09-28 host run 2: runner fix confirmed on the A5 path; R2 not yet run

The user pasted the outputs of step R1, a first A5 proof, the diagnostic
command, and a second A5 proof. **Step R2** (the A3 proof on the new runner,
the A4 proof and the A4 canary) **was not run.**

### Step R1: as predicted

- **Staging.** `staged 39787edbbd8f8d42a5acbee29874faadeeb845de (was
  f2edffcf…) from b9bd56e6…; 77 paths match exactly`.
- **Supervisor reinstall.** Supervisor `151f1d24…` (unchanged), runner
  **`a631ad9d…`**, everything else unchanged, `accepting_launch: true`.
  - The new receipt key is `f6304ffbec8af33f3d98cc205ce08c6b3d63cfe9a09023b1c427b9526d6df05b`;
    `b7fa10e4…` was archived. Boot `83df9a03…`.
- **Broker.** `790a1957…`, `approle_login: ok`, every binding revoked (19),
  price revision 7.
- **A4 demo server set aside.** `server.mjs.a4` = `8bb065061749f42c…`.
- **Demo deploy.** `previous_sha256 ce241fb1…`, `server_sha256 496846cd…`,
  service active.
- **Proxy proof.** 21 codes passed.

### First A5 proof (report `20260928T212926Z`): 16 of 18

- **The approval.** Run `4d232b84-…`, digest `7e990e0ca66c…`, typed
  `7e990e0ca66c`.
- **`supervised_run` passed (29.9 s).** This is **the runner fix confirmed on
  the real demo**: the verified account, both model choices, the human
  approval consumed, logout, and a verified receipt.
- **Also passed:**
  - `injection_scan`, `rule_only`, and `outcome_classes` (all four,
    including `challenge`);
  - `pins_and_consent`, `duplicate_start`;
  - `approval_checks`, `approval_race`, `approval_after_revocation`;
  - `binding_changed_mid_run`, `stale_guide_and_grant`;
  - `operator_stop`, `takeover`;
  - `provider_error`, `unknown_price`, `budget_exhausted`.
- **Failed: `outside_set`**, with `result_class: provider_error`. The ledger
  (call `f9de1651-…`) shows `max_output_tokens: 1`, `http_status: 400`,
  `provider_error: {type: invalid_request_error}`, released with 0 settled.
  **The provider rejects a 1-token cap.** The main guide's 8-token cap works,
  so the minimum is between 2 and 8.
- **Failed: `coordinator_restart`.** The child ended normally (`code: 0`)
  after 11 s. Its log shows `open_landing` → `step_failed: BROWSER_TIMEOUT`
  (10.1 s), so the run ended `blocked/action_failed` and never reached the
  crash point at `open_login`.
  - This was one navigation timeout out of about 40 launches on this host
    that day. The same step took 0.2 s in the run before it.
  - The case depended on a page loading. The timeout itself is recorded
    here, not explained away.
- **Canary.** Passed: 0 value and 0 marker matches in all 16 sinks,
  **including `host_journal_all`**. The marker fix is confirmed.

### Second A5 proof (report `20260928T213452Z`): 16 of 18

- **`coordinator_restart` passed (1.1 s).**
- **Failed: `supervised_run`.** The terminal showed digest
  `dd6af16a721bed0e…`, and the person typed **13** characters
  (`dd6af16a721be`). The harness accepted exactly 12, so it recorded
  `REFUSED_BY_PERSON` and stopped the run. The result was `cancelled` (0
  submits) with a verified receipt. This is the designed fail-safe for an
  answer that is not the expected one; nothing reached the credential path.
- **Failed: `outside_set`**, the same HTTP 400 as before.
- **Canary.** Passed again, 0 value and 0 marker matches in all 16 sinks.

### Decision and fixes (`9b9a15ed`, harness only)

- **`outside_set` (user decision): prove it locally.** A real model reply
  outside the allowed set cannot be forced:
  - the provider rejects a 1-token cap;
  - two tokens can already spell `read_files`;
  - the model otherwise obeys ALLOWED (host run 1).

  The refusal stays proven against the real Supervisor and Broker classes
  (`test_a5_model_step.py`: `I would choose read_files` and `shell` give
  `MODEL_CHOICE_INVALID`, and the call is settled), by the launcher, and by
  the coordinator tests. The installed supervisor is byte-identical to the
  tested one (`151f1d24…`). The host case is removed, and the aux guide's cap
  returns to 8.
- **The approval** now accepts any correct digest prefix of **12 or more**
  characters. Fewer or wrong characters still refuse. The harness test now
  answers 13 characters, and the refusal test answers 11.
- **`coordinator_restart`** kills the child right after reserving its
  **first** step (`open_landing`), before the supervisor is asked. It also
  asserts that the supervisor journal has no action for the attempt and that
  the step is `uncertain`. When the child does not die, the report carries
  the child run's result.
- **Local checks:** script tests 148 OK (the harness end-to-end test
  included) and host-boundary inventory exit 0. No backend, runner,
  supervisor, broker or demo file changed.

### State after host run 2

- The candidate is `39787edb…`.
- The installed files are supervisor `151f1d24…`, runner `a631ad9d…`, broker
  `790a1957…` and demo `496846cd…`.
- The receipt key is `f6304ffb…` and the boot is `83df9a03…`.
- The price table is at revision 9 (restored by `unknown_price`).
- All bindings are revoked, and the fixture mode is cleared.

## 2026-09-29 host run 3: A3, A4 and A5 pass; acceptance

The user ran steps S1–S3 and pasted them as terminal screenshots, then ran a
read-only summary of the three proof reports. No value appears anywhere.

### S1: staged only (nothing to reinstall)

- `staged 8d25755c8853e302a15a66855cd35207365373d1 (was 39787edb…) from
  9b9a15ed…; 77 paths match exactly`.
- Installed supervisor `151f1d242d7cdf35…`, runner `a631ad9d6062b675…`, key
  `f6304ffb…`, `"accepting_launch": true`.

### S2: A3 and A4 regression on the A5 runner, and the A4 canary

- **A3:** `worker-proof-20260929T003859Z.json`, `worker_proof: passed`, **19
  cases, failed []**. The guest-crash case moved the boot from `83df9a03…` to
  `62801e3b-8419-40aa-85bf-dffab35788c2`; QEMU PID 272179 is unchanged
  (`inspect_a3_vm`, read after the run).
- **A4:** `a4-proof-20260929T004200Z.json`, `a4_proof: passed`, **6 cases,
  failed []**.
  - `login` and `rotation` pass on runner `a631ad9d…`. That is the host
    confirmation of the `unexpected_origin` fix on A4's own proof.
  - `budget` made one real call, settled $0.000004625; the retry replayed; the
    refusals were `BUDGET_EXHAUSTED` (tokens and dollars), `MODEL_NOT_ALLOWED`,
    `REVISION_MISMATCH`, `PRICE_UNKNOWN` (restored at price revision 13) and
    `PROVIDER_ERROR` (one request).
- **A4 canary:** binding `9441ae77-088f-4004-ba62-8074d5af2409` (revision 2,
  after `rotation`), all sinks 0 matches, `canary_exit=0`.

### S3: the A5 proof, `a5-proof-20260929T004454Z.json`

- **`a5_proof: passed`, 17 cases, failed [].**
- **`supervised_run`:** passed, result `verified_account`, logout `done`.
  - The explicit start, the rules steps and the model's choices led to the
    **human approval**, then the submit, a verification by the runner's own
    session read, the model's `read_files`, the rule `sign_out`, and stop with
    a verified receipt and a durable result.
  - The injected file entry was on the page the worker read.
- **Approvals:** exactly one `('tty', 'APPROVED')` (the person at the host
  terminal) and ten `('proof-harness', 'APPROVED')` (refusal and class cases,
  labelled as such).
- **Cleanup:** fixture `cleared`, and 16 bindings revoked at the broker and in
  the proof database.
- **A5 canary:** binding `0ec49e96-b48b-4c3e-897c-ca55b8107213`. All sinks,
  including `a5_proof_database_files`, `a5_proof_database_dump` and
  `a5_harness_log_and_reports`, show `matches: 0, marker_matches: 0`.
  `canary_exit=0`.

### S4: from the session (MCP)

- **`run_self_checks`** (`backend-tests`, `backend-syntax`, `skip_install`) on
  candidate `8d25755c`: **3354 tests, 3343 pass, 0 fail, 11 skipped**
  (environment); syntax ok. The tool reports `promote_ready`. **Nothing was
  promoted.**
- **`get_host_services proxypilot-a`:** fence active/exited; proxy,
  supervisor and broker active/running; renewal timer active/waiting.
- **`get_self_status`:** live `33528751…` unchanged, candidate `8d25755c`
  (29 ahead, clean).
- **`inspect_a3_vm`:** UUID `49592202-…`, boot `62801e3b-…`, running, 2 vCPU
  / 4096 MiB / 12 GiB, no swap.

### Acceptance decision: A5 is ACCEPTED (2026-09-29)

Criteria from the A1 acceptance matrix (A5 row) and the A5 prompt:

| Criterion | Evidence |
|---|---|
| One synthetic end-to-end workflow completes | `supervised_run` (host run 3): verified account, logout, verified receipt, durable result |
| Explicit user start; one active run | Start needs `run` access (`stale_guide_and_grant`: a removed grant refuses); `duplicate_start` gives `RUN_ALREADY_ACTIVE` |
| Atomic guide, profile and policy pin | `prepare` and the pin row in one transaction; `pins_and_consent`: altered guide `GUIDE_HASH_MISMATCH`, altered policy `RUN_POLICY_MISMATCH` at the installed supervisor |
| Typed action broker; refusal outside permitted actions; wrong domain or action | Supervisor typed actions only; `pins_and_consent` `not_offered` gives `INVALID_REQUEST`; A3 `backend_refusals` (other origin, unknown action, URL field, `model_step` foreign policy and proof flag); the store refuses a non-demo origin (local) |
| Approval digest, stale, duplicate, race and revocation | `approval_checks`, `approval_race` (both orders, no submit), `approval_after_revocation`, `binding_changed_mid_run` (broker-side revoke and rotate refuse the submit, no delivery), `stale_guide_and_grant` |
| Human-only approval | One TTY approval by a person (digest shown, prefix typed). An unelevated or ineligible actor is refused. No MCP tool or route exists |
| Durable events and results | Migration 1111 rows, immutable after close; one result per outcome class (`outcome_classes`: `credential_rejected`, `rate_limited`, `challenge_required`, `unexpected_origin`) |
| Cancellation fence, stop and recovery | `operator_stop`, `takeover` (hand-over, then receipt), `coordinator_restart` (SIGKILL after the reservation: the step is never sent, `interrupted`, needs human, receipt verified) |
| Provider errors, unknown price, budget | `provider_error`, `unknown_price`, `budget_exhausted` (refused before any request); A4 `budget` |
| Hybrid: a rule-decided step makes no model call; no consent means no model step | `rule_only` (0 calls at the broker and the supervisor); `pins_and_consent` `GUIDE_NOT_SHAREABLE` and a no-consent run with 0 calls |
| Prompt injection and untrusted page content; redacted observation | The injected entry was served to the worker in `supervised_run`. Claims are typed; the marker count is 0 in every sink, including the model prompts (the prompt is not stored; the fixture runner test proves it absent) |
| No credential, cookie or token in any sink | Both canary scans: 0 in all 16 sinks |
| A3/A4 boundaries intact | A3 19/19 and A4 6/6 on the A5 supervisor, runner and broker; proxy proof 21 |

**Open by name, allowed by the criteria:**
- **A model reply outside the allowed set** is proven locally only (user
  decision, 2026-09-28): the real Supervisor and Broker classes, the
  launcher and the coordinator. The provider rejects a 1-token cap, and 2
  tokens can spell `read_files`. The installed supervisor is byte-identical
  to the tested one.
- **Unknown usage** (a provider reply without usage) is proven locally only,
  as in A4; the real provider cannot be made to omit it.
- **The `timeout` outcome class** is proven locally only (real Chromium
  through the real proxy policy). It is never run on the live demo because
  of the next item.
- **The origin proxy can resend the one admitted sign-in POST** after an
  upstream timeout (first A5 section, findings). The proxy is unchanged; fix
  it in a later section.
- **One `open_landing` BROWSER_TIMEOUT** in about 60 launches (host run 2).
  It is recorded, not explained.
- **The coordinator runs only in the host proof harness** (decision 1,
  option A). The backend container socket mount and any route are A8.
  Activation stays off.
- **Carried from A3/A4:** host reboot persistence, S6 / SEC-01 / SEC-04, and
  secret-ID rotation not being an immediate stop.
- **No PR and no exact-head Security CI for the A5 branch.** CI runs on a
  draft PR, only if the user asks for one.

**Operational state:**
- The candidate is `8d25755c`, not promoted.
- The live demo serves `server.mjs` `496846cd…`. The A5 fixture file is
  cleared, so public users are unaffected. `server.mjs.a4` (the A4 server) and
  `server.mjs.pre-a4` (the original) are kept.
- The synthetic account verifier stays in place; every binding is revoked.
  Retire it with the A4 reference's rollback if it is not wanted.
- The proof databases under `/var/lib/proxypilot-a5-proof/` hold typed
  fields only.

Accepting A5 does not authorize A6, activation, deployment or promotion; each
is a separate user decision. The [A6 prompt](fractionate-agents-a6-prompt.md)
is now eligible, and work stops here for review.
