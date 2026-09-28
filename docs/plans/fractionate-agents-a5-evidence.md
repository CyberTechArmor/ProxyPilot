# A5 supervised execution loop — evidence

**A5 is NOT accepted.** The code and every local suite are done (below). The
host proof has not run yet: the commands are in the
[A5 reference](fractionate-agents-a5-reference.md), steps 0–4. A2, A3 and
Operations activation stay off. PR #686 and PR #699 stay draft. Nothing was
merged, deployed or promoted, and no host command ran from this session.

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
