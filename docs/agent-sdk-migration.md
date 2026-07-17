# Claude Agent SDK migration

Status: **Phase 1 in progress.** Phases 2–5 are recorded here as the roadmap only —
they are **not built** yet.

## North star

Today the mock2 build runner is a **hand-rolled agentic loop**: `runner.js` `runCycle()`
drives a provider-agnostic model turn-by-turn (`model-client.js` `callModelTurn`),
executing a small fixed tool set (`exec_in_container` / `read_file` / `write_file` /
`run_gates` / `finish`) against a network-fenced project container, with our own token
accounting, soft-pause, retry, checkpoint, and change-record logic wrapped around it.

The north star is to move that **agentic loop** onto the
[`@anthropic-ai/claude-agent-sdk`](https://code.claude.com/docs/en/agent-sdk) — Claude
Code packaged as a library. The SDK already owns the loop, context compaction, built-in
Read/Write/Edit/Bash/Grep/Glob tools, hooks, subagents, sessions, and `CLAUDE.md`
auto-loading. Adopting it lets us **delete the parts of our code that re-implement a
coding agent** and refocus ProxyPilot's own code on what is actually ours and
differentiating: the **spec + governance layer** — the constitution, the rule-question
audit, the deterministic gate battery, the hash-chained audit trail, the deviation
sign-offs, and the quota/budget envelope.

This is a **context document, not a build-everything mandate.** We adopt the SDK in
small, reversible phases. Each phase must leave the product shippable with the flag off.

### Confirmed SDK API surface (TypeScript, verified against the live docs 2026-07)

Pinned so the implementation does not rely on an assumed signature:

- **Package:** `@anthropic-ai/claude-agent-sdk`. The TS package **bundles a native
  Claude Code binary** as an optional dependency (no separate Claude Code install).
- **Entry point:** `query({ prompt, options }): Query`, where `Query extends
  AsyncGenerator<SDKMessage, void>`. You iterate the messages; the loop runs itself.
- **Options fields we use:**
  - `cwd: string` — working directory the built-in tools operate on.
  - `model: string` — full model id (e.g. the per-slot build_runner model).
  - `allowedTools: string[]` — tools auto-approved without a prompt (`Read`, `Edit`,
    `Write`, `Bash`, `Grep`, `Glob`).
  - `permissionMode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto'`.
  - `settingSources: ('user'|'project'|'local')[]` — **`'project'` is what makes the
    SDK auto-load `CLAUDE.md` / `.claude/CLAUDE.md` from `cwd`.**
  - `systemPrompt: string | { type:'preset', preset:'claude_code', append?, excludeDynamicSections? }`.
  - `env: Record<string,string|undefined>` — **replaces** (not merges) the subprocess
    env; pass `{ ...process.env, ANTHROPIC_API_KEY: key }`. This is how the key is
    provided **orchestrator-side** to the SDK subprocess.
  - `maxTurns`, `abortController`, `resume`, `forkSession`, `hooks`, `mcpServers`,
    `agents` — recorded for later phases.
- **Messages yielded:** a `system` init message carrying `session_id`; `assistant`
  messages; a final `result` message carrying `usage` (`input_tokens`,
  `output_tokens`, `cache_creation_input_tokens?`, `cache_read_input_tokens?`),
  `total_cost_usd?`, `num_turns`, `model`.
- **Auth:** API key via the `env` option → the SDK's Claude Code subprocess. It never
  touches the project container. (claude.ai login is not permitted for third-party
  products; we use API-key auth, which is what our connectors already store.)

### Architectural tension this migration must resolve

The SDK's built-in tools operate on the **local filesystem** where the SDK process runs.
Our hard security rule (stated verbatim across `runner.js` / `model-client.js`) is:

> The plaintext key is read ORCHESTRATOR-SIDE only (`decryptConnectorKey`) and never
> enters a container.

Resolution adopted in Phase 1: **the SDK runs in the backend (orchestrator) process,
against a local working checkout synced out of the fenced container.** The key is handed
to the SDK subprocess via `options.env` — it stays orchestrator-side and never enters the
container. The edited tree is synced back into the container, where the **unchanged**
gate battery, checkpoint, and deploy run (in-container, exactly as today). Every gate,
commit, and change-record is produced by the **same** functions the hand-rolled runner
calls, so "flag on" yields the same governance outputs as "flag off".

## Runner safety: honest termination + no-progress circuit breaker

> **North star.** A build cycle must always be able to terminate **honestly**, and
> must never be able to run **without making progress**. A real ADP cycle proved both
> gaps at once: the model correctly determined it was blocked (the `test` gate re-seeds
> a user into the serving DB, which it verified empirically) and correctly refused to
> call `finish` (which records "succeeded" for blocked work) — but `finish` was the
> **only** cycle-terminating action, and the loop treated a no-tool-call turn as "keep
> going", so it emitted **118 near-identical refusals and burned ~$4.76** until a human
> hit Stop. The governance was working; the platform gave honesty no exit and had no
> runaway guard. This change fixes both. It is a **harness/runner change** — no Mock2
> application (generated-project) code is touched — and both the hand-rolled and the
> SDK runners inherit it as a core, non-opt-in behavior.

### Where the machinery lives (pre-change investigation)

- **The build-cycle loop:** `admin/backend/src/mock2/runner.js` `runCycle()` — calls the
  model (`callModelTurn`), executes `RUNNER_TOOLS`, and ends the cycle. The pure
  turn-classification is `runner-logic.js` `classifyTurn()`. The SDK variant is
  `runner-sdk.js` `runCycleSdk()` driving the Agent SDK `query()` loop.
- **Cycle status recording:** `cycles.js` `finishCycle()` / `updateCycle()`; the status
  vocabulary + terminal/resumable sets are `cycle-logic.js` (`CYCLE_STATUSES`,
  `TERMINAL_STATUSES`); the DB CHECK is migration 502 in `migrations.js`. Resumable set
  for the editor Retry is `runner.js` `RESUMABLE_CYCLE_STATUSES`.
- **Deploy gating on status:** deploy runs **only** on the `finish` → gates-green →
  `checkpointAndRecord` → `deployStage` path inside `runCycle`; every non-success
  terminal (halt, pause, failure) returns before `deployStage`, so a blocked cycle
  never deploys.
- **Build-cycle system prompt / instructions:** `runner-logic.js`
  `buildRunnerSystemPrompt()` (hand-rolled) and `buildRunnerClaudeMd()` (the SDK's
  auto-loaded CLAUDE.md); the task framing is `buildRunnerTask()`.

### Part 1 — a first-class non-success terminal action (`halt`)

- **New tool `halt(reason)`** in `RUNNER_TOOLS` (`runner-logic.js`), registered so the
  model can call it. `classifyTurn` recognizes it and it takes precedence over `finish`
  (a turn can't both give up and claim success).
- **System-prompt instruction** added to both prompts: *"If you cannot honestly
  complete the change (blocked, missing dependency, out-of-scope fix required), call
  halt(reason) — do not keep responding without a tool call."* The ADP model said the
  only terminating call available was `finish`; now it has, and is told to reach for,
  `halt`.
- **Terminal behavior** (`runner.js` `haltCycle()`, exported and shared by both
  runners): checkpoints WIP (branch + report artifacts recoverable), marks the cycle
  **blocked** — status `awaiting_admin` + a new `halt_reason` column (migration 513) —
  which is **not `succeeded`, does not deploy, and is resumable** (the editor Retry
  already resumes `awaiting_admin`). It records the model's stated reason (`error`),
  **links any report artifacts** the cycle wrote (`state/changes/*.md`, `state/*.md`),
  raises a needs-attention queue item (`dedupe mock2-blocked:<id>`), logs a `halt`
  cycle-event, and notifies with a `blocked` outcome. The UI (`BuildStatus.jsx`) shows a
  distinct **"Blocked — needs attention"** banner, separate from success, a user stop,
  and a soft budget pause.
  - *Status-model note:* we reuse the allowed `awaiting_admin` status + a `halt_reason`
    marker rather than adding a new `blocked` status token, following the codebase's
    established idiom (migration 511 reused `interrupted` + `pause_reason` specifically
    to avoid a CHECK-constraint rebuild of the central `mock2_cycles` table). The
    user-facing surface still says "Blocked".

### Part 2 — a no-progress circuit breaker

`runner-logic.js` `updateProgress()` (pure, unit-tested) folds each assistant turn and
trips on **any** of three stuck signals, each reset by a real move (a file edit, or a
tool call different from the previous turn's), so legitimate multi-step work is never
tripped:
- `no_tool_calls` — N consecutive assistant turns with no tool call (the 118 refusals).
- `repeated_output` — N consecutive near-identical assistant messages that **also** made
  no new action (a cheap, reliable signal; the refusals were near-verbatim).
- `no_state_change` — N consecutive turns with no file edit and no new tool call.

**Threshold** is a small single digit, **default 3**, configurable via
`BUILD_NO_PROGRESS_LIMIT` (clamped ≥2 so it can't trip on one turn). When it trips the
runner ends the cycle through `haltCycle` (trigger recorded as the `halt_reason`),
stopping token spend. Wired into `runCycle` on every non-success path (including a
`finish`-on-red loop) and into `runCycleSdk` (folded per streamed assistant message;
on trip it **aborts the `query()` stream** via `AbortController` and halts — the SDK
equivalent of a Stop-hook/maxTurns resolving to the blocked state, not success).

**Max-turns / budget exhaustion** already resolve to a resumable `interrupted` +
`pause_reason` (`max_turns` / `budget_*`) — **not `succeeded`** — consistent with the
constitution's "budget-paused ≠ succeeded"; the breaker (default 3) now trips long
before the `MAX_TURNS` (300) backstop is ever reached.

### Acceptance & the ADP before/after

| Acceptance criterion | Status |
|---|---|
| Blocked cycle can `halt(reason)` → non-success, no deploy, resumable, reason + artifacts attached, visible in UI | **Met** (`haltCycle`; UI banner) |
| Repeated no-tool/near-identical turns auto-terminated within the threshold (single-digit, not 100+) | **Met** — pinned by `mock2-progress-breaker.test.js`: the 118-refusal repro trips at **turn 3** (`no_tool_calls`), not 118 |
| Max-turns/budget records incomplete/blocked, never succeeded | **Met** (already `interrupted`; breaker trips first) |
| Normal successful cycles unaffected | **Met** — breaker never trips on multi-step read→edit→gate work (test); flag-off finish path unchanged; backend suite 473 pass / 1 pre-existing fail |

**ADP before/after (real-repro run — required, pending the operator environment).** The
deterministic proof above replays the exact ADP failure shape (118 near-verbatim,
no-tool refusals) through the real breaker and shows it stops at **turn 3**. A live
re-run of the ADP first-user-login cycle (whose blocking condition — the `test` gate
re-seeds the serving DB — is real and still present) needs an Incus + Anthropic-connector
environment this dev container lacks, so the live row is recorded here rather than
fabricated:

| Metric | Before (observed) | After (expected; fill on the operator run) |
|---|---|---|
| Turns before stopping | 118 | ≤ 3 (breaker) or 1 (model calls `halt`) |
| Cost before stopping | ~$4.76 | a few cents |
| How it ended | human hit Stop | blocked (needs attention), resumable |

> Procedure to fill the "After" column on a real install: re-run the ADP first-user
> login cycle. Expect one of: (a) the model calls `halt(reason)` and the cycle ends
> **blocked** with its report attached in ~1 turn; or (b) it emits no-progress turns and
> the breaker halts it within `BUILD_NO_PROGRESS_LIMIT` (default 3). Record the turn
> count + cost from the cycle row / event log in the table above.

## Smoke gate: relevance-gated browser + read-only DB connectors

> **North star.** The e2e/journey smoke gate should be able to **see the running app
> and its live data** when — and only when — a change actually warrants it. Add a
> browser connector (drive the deployed UI) and a read-only Postgres connector
> (inspect live rows) to the harness, but invoke them **conditionally, on a
> deterministic relevance trigger, never on every cycle**. The default smoke layer
> stays cheap HTTP/API; the connectors are a relevance-gated escalation, not a standing
> step. Harness change only — no Mock2 application code is touched, and both runners
> inherit it identically.

### Where the machinery lives (pre-change investigation)

- **The smoke gate did not exist yet.** The pinned gate battery is five *shell* gates
  (`typecheck`, `constitution-lint`, `rule-coverage`, `security-scan`, `test`) in
  `framework-seed/gates.json`, run in-container before checkpoint/deploy. The
  constitution *references* an e2e/journey gate (§7) but nothing implemented it; the
  closest HTTP-level journey check was the deploy **health-check** in `deploy.js`
  (curl `/`, reject 5xx/000). This change adds the smoke gate as a **post-deploy runner
  step** (it needs the app deployed and serving to see it), not a sixth shell gate.
- **MCP wiring for the runner:** none existed. The connectors are wired harness-side and
  invoked by the runner post-deploy; they are deterministic drivers (a gate must be
  deterministic, per constitution §1.3), not model-driven MCP calls.
- **Diff / changed-file + change metadata:** the change record (`change-logic.js`) stores
  `summary`, `gates_run`, `commit_sha` (no file list). The new `smoke.js`
  `changedFilesForCommit()` derives the cycle's own changed-file list from the checkpoint
  commit (`git diff-tree --name-only`); `changeMeta` = the checkpoint `summary` + the
  cycle instruction (and any `state/inventory.json` screen marks).

### The change

- **Two connectors, registered default-OFF** (`SMOKE_BROWSER_ENABLED` /
  `SMOKE_DB_ENABLED`, both `false`), wired but never started unless enabled **and**
  triggered. Starting is **lazy**: the trigger (a regex over the changed-path list —
  far cheaper than a browser) is evaluated first; a connector spins up only on a hit.
  `playwright` is imported lazily so a default install never loads it. The DB connector
  is **read-only** (`SET TRANSACTION READ ONLY` + a SELECT-only guard that refuses any
  write/DDL/`;`).
- **Deterministic relevance triggers** (`smoke-triggers.js`, pure + unit-tested):
  - *Browser* fires when the diff touches user-facing render/flow (`public/**`,
    `**/*.html|css|jsx|tsx`, view/template/login/signup paths) **or** the change
    metadata marks a screen/user-journey change → then it drives the deployed page and
    asserts the rendered journey (default: exactly one visible form on the fresh-install
    root — "one form, not three").
  - *DB* fires when the diff touches data/state semantics (`migrations/**`, `**/*.sql`,
    `schema/seed/bootstrap` paths) **or** the rule under test is about data state
    (bootstrap / user-existence / first-run) → then it reads the live table(s) and
    asserts expected state (default: zero users ⇒ `canCreateSuperadmin`).
  - Neither fires → HTTP/API assertions only; both connectors stay untouched. This is
    the common case and stays cheap (one curl round-trip). Globs are configurable
    (`SMOKE_BROWSER_GLOBS` / `SMOKE_DB_GLOBS`).
- **No arbitrary invocation, justified escalation allowed.** The trigger is deterministic
  static analysis, so the model never launches a connector arbitrarily. An escalation to
  a connector that didn't auto-fire is honored **only with a stated reason**
  (`applyEscalations`); a reason-less escalation is **rejected and flagged**, never
  honored silently.
- **No silent skips.** Every smoke run records, per connector, one of `ran` / `skipped`
  / `unavailable` **with its one-line reason** (`smokeLogLines`), logged as a `smoke`
  cycle-event on every cycle — so "covered everything" is never implied when a layer was
  intentionally bypassed. A warranted-but-disabled connector is `unavailable` (visible),
  not a hidden skip.
- **Verdict / safety.** The always-on HTTP layer is advisory by default
  (`SMOKE_GATE_ENFORCING=false`) so adding the gate changes **no** default cycle
  outcomes; an **invoked** connector (the operator enabled it) that fails its assertion
  **fails the cycle** (status `failed`, `smoke_failed` job phase) — that's the point:
  catch the multi-form render / the stale-user state. With both connectors OFF and HTTP
  not enforced (defaults), `ok` is always true and the success path is byte-for-byte
  unchanged.
- **Both runners** call the same `smoke.js smokeAfterDeploy()` after a successful deploy,
  so the run/skip decision and the assertions are runner-agnostic (hand-rolled + SDK).

### Acceptance & the three ADP replays

| Acceptance criterion | Status |
|---|---|
| Backend-only change → zero connector invocations, HTTP-cost only, proven by the run log | **Met** — replay 1 test; both resolve `skipped` with reasons |
| `public/**` change auto-fires browser; `migrations/**`/bootstrap auto-fires DB; each logs its trigger reason | **Met** — replays 2 & 3 tests |
| A manual escalation without a logged reason is rejected/flagged | **Met** — `applyEscalations` test |
| The skip/run decision for each connector is recorded every cycle | **Met** — `smoke` cycle-event with `smokeLogLines` on every cycle |

**Three ADP replays** (pinned in `mock2-smoke-triggers.test.js`):

1. **Pure backend/config change** (`src/service/rateLimit.ts`, `src/config/env.ts`) →
   both connectors **skip**: `browser: skipped — no user-facing paths in diff` /
   `db: skipped — no data/state paths in diff`.
2. **CSS/login-render fix** (`public/login.html`, `public/styles/login.css`) → **browser
   fires** (`ran — user-facing paths in diff`), DB skips. The browser assertion catches
   the multi-form render (expects 1 visible form, not 3).
3. **`usersExist` bootstrap fix** (`migrations/004_seed_guard.sql`, `src/auth/bootstrap.ts`)
   → **DB fires** (`ran — data/state paths in diff`), browser skips. The DB assertion
   catches the stale-user state (expects 0 users → `canCreateSuperadmin`).

> The trigger decisions + run/skip logging above are proven deterministically. The live
> connector **drivers** (Playwright against the deployed URL; read-only `psql` against
> the in-container Postgres) run only when enabled and require a real Incus/deployed-app
> environment, which this dev container lacks — so the driver *execution* is validated on
> a real install (enable `SMOKE_BROWSER_ENABLED` / `SMOKE_DB_ENABLED`, re-run replays 2 &
> 3, confirm the browser flags the 3-form render and the DB flags the stale user).

## Human feedback channels for blocked/awaiting states

> **North star.** A blocked or awaiting cycle must be able to receive new context and
> make progress. Before this, the only affordances were Resume and Approve — so a
> correctly-halted build (the ADP first-user cycle halted with a precise blocker
> report) had no way to be answered: no message on resume, no way to authorize the
> one-time data fix it needed, and the deviation queue was approve-only. Harness change
> only; both runners inherit it.

### Where the machinery lives (pre-change investigation)

- **Resume:** `runner.js` `retryCycle()` → `startCycle()` starts a fresh cycle with the
  same instruction, continuing from the checkpoint in the container. The route is
  `POST /projects/:id/cycles/:cycleId/retry`.
- **The blocked/awaiting model:** a halt is status `awaiting_admin` + `halt_reason`
  (migration 513); admin decisions on framework deviations live in
  `mock2_audit_questions` (kind `framework_deviation`), recorded via
  `resolveFrameworkDeviation()` → `markDeviationDecision()`, and injected into the build
  task by `buildAdminDecisionsBlock()` (which reads `question.question`).
- **The rule-question card UI** renders a question's `choices_json` via `ChatMessageList`
  in `BuildChat.jsx` — reused here to render the model's halt resolution options.

### The four channels

1. **Resume-with-message.** `retryCycle`/`startCycle` accept operator guidance and store
   it (`resume_context_json`, migration 514); `runCycle` injects it as a distinct,
   labeled **"Operator guidance on resume"** user turn AFTER the task (SDK runner appends
   it to the round-0 prompt). The `/retry` route takes `{ message, option }`. A bare
   resume carries nothing — so a build blocked on a real blocker **re-halts rather than
   loops** (the halt tool + no-progress breaker still apply).
2. **Structured unblock options.** `halt(reason, options)` — the model proposes
   `[{label,detail}]` resolution choices (`parseHaltOptions`, capped); stored
   (`halt_options_json`), surfaced via `publicCycleShape.halt_options`, and rendered as
   selectable buttons in the blocked card. The chosen option (id/label) + optional
   free text is recorded and injected on resume.
3. **Approve-as-edited.** `resolveFrameworkDeviation` accepts `editedText`/`conditions`;
   the edited text **replaces the deviation's question text** so it becomes the
   authoritative APPROVED record the runner is handed (`approveAsEditedText`). The
   admin deviation card gains an editable box + an "Approve as edited" button.
4. **Scoped one-time authorization.** `request_authorization(scope, reason)` — a new
   runner tool distinct from a constitutional deviation. The model requests a narrow
   privileged op (e.g. deleting a specific stale test-artifact row) from inside a cycle;
   it is stored in `mock2_authorizations` (migration 514) and the cycle **halts awaiting
   an admin, like a rule question**. An admin grants/denies (optionally appending
   conditions) via `POST /projects/:id/authorizations/:authId/decision`. A grant is
   injected on the next resume (`buildAuthorizationBlock`) and **consumed (single-use)**;
   ungranted/unused grants **expire with the cycle** (`expireStaleAuthorizations` on a
   fresh build). Every state change is audit-logged (`MOCK2_AUTHORIZATION_DECISION`).

**Also:** when a cycle is blocked/`awaiting_admin`, the **build chat is unlocked as the
resume-message input** (typing resumes with that message). And the footer copy that
mislabeled a governance halt as a "transient error / add billing / raise your rate
limit" stall now shows only for a genuine retries-exhausted transient — a governance
halt has its own **"Blocked — needs attention"** card.

### Acceptance

| Criterion | Status |
|---|---|
| Halt shows resolution options; admin grants a scoped one-time authorization; resume carries it and the cycle completes (or re-halts for a new reason) | **Wired** — halt `options`, `request_authorization` → grant → resume injection (`buildResumeContextBlock` + `buildAuthorizationBlock`) |
| A bare resume with no new context re-halts rather than loops | **Met** — resumeContext null ⇒ no injected turn; the halt tool + breaker re-halt |
| All four channels appear in the audit trail | **Met** — `resume_guidance`/`authorization_request`/`halt` cycle-events + `MOCK2_QUEUE_ITEM_STATUS`/`MOCK2_AUTHORIZATION_DECISION`/`MOCK2_CYCLE_RETRY` audit-log entries |

Pure formats pinned by `mock2-unblock-logic.test.js` (+9). Backend suite 494 pass / 1
pre-existing fail; frontend builds. The live end-to-end replay of the blocked ADP
first-user cycle (grant the row-delete authorization, resume, complete) needs a real
Incus/connector environment — the mechanisms + audit artifacts are proven here; the
live journey is validated on a real install.

## Per-project harness selection (landed)

The runner selection is no longer only the global `BUILD_RUNNER` flag: each project
now carries a **harness** setting (`mock2_projects.harness`, migration 533) toggled in
the UI (Project → Details → **Build harness**: "ProxyPilot" | "Claude") and via
`GET`/`PUT /api/mock2/projects/:id/harness`. Exactly one harness drives a project at a
time; switching persists immediately and applies from the next build cycle.

- **The abstraction.** `harness.js` defines the common Harness contract
  (`{ name, runTask(input) }`), with `ProxyPilotHarness` as a thin **adapter** over the
  unchanged hand-rolled `runCycle` and `ClaudeHarness` over `runCycleSdk`. Both stream
  through the app's existing event model — the durable `mock2_cycle_events` transcript +
  the live job phase — so the frontend needs no harness-specific rendering.
  `startCycle` picks the implementation via the `harnessForProject` factory
  (`resolveHarness` in `runner-logic.js`: explicit project choice → legacy
  `BUILD_RUNNER` flag → ProxyPilot). A project that never touches the toggle behaves
  **exactly** as before.
- **Claude harness auth.** A pay-as-you-go Anthropic **API key**, resolved
  orchestrator-side only (`resolveClaudeAuth`): the build_runner slot's Anthropic
  connector secret first, else the server env's `ANTHROPIC_API_KEY` (`.env`). Never a
  claude.ai subscription login; the key is never logged, never sent to the browser
  (the harness API returns only a `configured` boolean + source label), and never
  enters a project container. Selecting Claude with no usable key is refused with an
  actionable error, both at toggle time (409) and at run time (failed cycle, clear
  message).
- **Subagents.** The Claude harness configures two SDK subagents (`agents` option,
  pinned in `SDK_SUBAGENTS`): **`search`** (WebSearch only — finds and returns relevant
  sources) and **`pull-website`** (WebFetch only — retrieves and extracts a given URL).
  The main loop's tool set stays the read/edit/run set plus the delegation tool; web
  access exists *only* through those scoped subagents, and the PreToolUse guardrails
  still deny protected paths and destructive shell. More subagents / custom MCP tools
  slot into `SDK_SUBAGENTS` later without touching the runner.

## Phased roadmap

- [ ] **Phase 1 — Tool + context swap (IN PROGRESS).** SDK build runner behind a
  feature flag (`BUILD_RUNNER=sdk`, default hand-rolled). Flag off ⇒ behavior is
  byte-for-byte identical to today. Flag on ⇒ one build cycle runs via SDK `query()`
  with the built-in Read/Edit/Write/Bash/Grep/Glob tools, the project constitution/rules
  mapped into an auto-loaded `CLAUDE.md`, and still produces the **same commit, change
  record, and gate-battery invocation**. Fully reversible by flipping the flag.
  - Non-goals for this phase (explicitly untouched): the define stage, the
    rule-question / audit flow, the gate scripts themselves, deviation approvals, and
    session-resume.
- [ ] **Phase 2 — Session resume.** Replace "re-explore the tree on every resume" with
  the SDK's `resume` (session id persisted on the cycle). A paused/continued build picks
  up its own prior context instead of re-reading the repo cold.
- [ ] **Phase 3 — Gates as hooks.** Move the deterministic gate battery into SDK
  `PreToolUse` / `PostToolUse` hooks so governance is enforced inside the loop
  (block-on-red) rather than only re-run after `finish`. _Seed landed in Phase 1:_
  `runner-sdk-hooks.js` already wires a `PostToolUse` audit hook (every mutating tool
  call → the durable cycle-events log) and a `PreToolUse` guardrail (protected paths +
  destructive shell). Phase 3 extends this to the full gate battery.
- [ ] **Phase 4 — Spec-reviewer subagent.** Turn the rule-question / audit reviewer into
  an SDK subagent (`agents`) invoked by the main loop, keeping the human sign-off gate.
- [ ] **Phase 5 — Retire the hand-rolled loop.** Once Phases 1–4 are proven in
  production, delete the bespoke turn loop, token accounting, and retry logic that the
  SDK now owns; keep only the governance layer.

## Phase 1 — implementation notes

**Flag.** `BUILD_RUNNER` env var, read by the pure `buildRunnerMode()` helper
(`runner-logic.js`): `sdk` selects the SDK runner; anything else (default/unset) keeps
the hand-rolled `runCycle`. `startCycle()` is the only branch point — when the flag is
off it calls `runCycle` exactly as before, so nothing about the default path changes.

**Constitution → CLAUDE.md.** `buildRunnerClaudeMd()` (`runner-logic.js`, pure +
unit-tested) renders the same governance content the hand-rolled system prompt injects
(design fidelity, the pinned constitution, the administrator-approved-exceptions
override clause, the available skills, and the how-to-work steps) as a `CLAUDE.md`
written into the local checkout. With `settingSources: ['project']` the SDK loads it
automatically — proving the constitution is **sourced from context, not re-explored**.
Because it injects the *pinned* `framework.constitution_md`, both runners and the audit
stay governed by the same text.

**Constitution hardening (adopted as a new framework version).** The org constitution
seed (`framework-seed/constitution.md`) was hardened with the lessons from the first
build cycles — kept v1's philosophy (four stages, "restriction is the feature") and
merged in: identity only from a verified credential + never-trust `x-user-role` with a
required negative-assertion test (§4); HTML shells only through gated routes + token/
refresh-hash rules (§5); a redefined "done" that requires the **e2e journey gate with a
negative security assertion**, fail-visible-not-skip-as-pass, and treats a budget-paused
build as **incomplete, never succeeded** (§7); approved deviations must **propagate to
code, UI copy, and `state/inventory.json`** (§9); and a final integration/wire-up pass
for budget-split tasks (§10). Section numbers the gates reference (§2/§5/§6) are
unchanged. This publishes a **new** framework version on boot via the existing
`upgradeFrameworkFromSeed` path; **projects adopt it only through an explicit update
cycle** (no auto-remediation). **Revert:** `git revert` the seed change (or restore the
prior `constitution.md`); pinned projects are unaffected until they choose to update.

**Same outputs.** `runner-sdk.js` reuses the exported `runGateBattery`,
`checkpointAndRecord`, and `deployStage` from `runner.js` — the identical functions the
hand-rolled runner uses — so the commit, hash-chained change record, and gate battery are
produced the same way regardless of which runner drove the edits.

**Dependency.** `@anthropic-ai/claude-agent-sdk` is **not** a `package.json` dependency
and is imported **dynamically only when the flag is on**, so the default (flag-off)
install and run never require it. It is kept out of `package.json` on purpose: the SDK
peers `zod@^4` while the backend pins `zod@^3`, so listing it (even under
`optionalDependencies`) makes `npm install` fail with an `ERESOLVE` peer conflict and
breaks the production Docker build. Operators who opt into `BUILD_RUNNER=sdk` install it
out-of-band:

```bash
cd admin/backend
npm install @anthropic-ai/claude-agent-sdk --no-save --legacy-peer-deps
```

`--legacy-peer-deps` is required for the zod peer mismatch; `--no-save` keeps it out of
`package.json` so the default build stays clean. If the package is absent when the flag
is on, the cycle fails with an actionable message (it never crashes the process).

**Sync channel.** The local checkout is synced in/out of the fenced container through
the same channel `containerSh` already uses — a tarball piped through
`incus exec <c> -- tar`, base64 over stdout (pull) and over the host command's stdin
(push), so neither the tarball nor its base64 ever lands on a command line (no E2BIG).
The local extract/create runs via `tar` in this Node process's namespace (the same
namespace the SDK's built-in tools operate in).

**Hooks (enforcement + audit).** `runner-sdk-hooks.js` `buildHookOptions(ctx)` drops
into the `query()` options:
- `PreToolUse` guardrail — blocks `Edit`/`Write` to governed paths (`.env*`,
  `state/deviations/`, `state/changes/`, `.github/`, `.claude/`, `CLAUDE.md`) and
  destructive `Bash` (`rm -rf /`, force-push, `DROP DATABASE`, non-test `TRUNCATE`).
  The deny shape is pinned to the installed SDK version:
  `{ hookSpecificOutput: { hookEventName, permissionDecision: 'deny', permissionDecisionReason } }`
  (verified against the hooks docs — **not** the `{ decision:'block' }` shape older
  skeletons use), and a hook `deny` wins even under `permissionMode:'bypassPermissions'`.
- `PostToolUse` audit — every `Edit`/`Write`/`Bash` is recorded into the durable
  cycle-events transcript (migration 512), **not** a file in the checkout, so nothing
  is synced back into the project. This is the Phase-3 audit seed.

> **SDK Bash executes on the orchestrator.** A real difference from the hand-rolled
> runner: the SDK's built-in `Bash`/`Edit`/`Write` run in **this backend process's**
> namespace against the local checkout, **not inside the fenced container**. The
> `PreToolUse` guardrail is a mitigation, not a sandbox. Until a later phase sandboxes
> the SDK itself (e.g. running it inside the container — which reopens the
> key-never-in-container tension), run `BUILD_RUNNER=sdk` only in a disposable / CI-like
> environment, and keep the guardrail's protected-path and blocked-command lists tuned
> to the host.

### Known Phase-1 limitations (to revisit in later phases)

- **Provider:** the SDK path requires an **Anthropic** build_runner connector (key via
  `env`). A non-Anthropic slot fails the cycle with an actionable message rather than
  running; the hand-rolled runner stays provider-agnostic. (The SDK also supports
  Bedrock/Vertex via env flags — not wired in Phase 1.)
- **Deletions:** push-back uses `tar -xf` (overwrite), which does not remove files the
  SDK deleted in the local checkout. Rare for a targeted change; revisit if it bites.
- **Gate feedback:** the SDK does not run the gates itself (governance stays ours). It
  makes the change; ProxyPilot runs the pinned battery after each pass and, if red,
  resumes the SDK session with the gate output — bounded to a few rounds. Moving the
  gates *inside* the loop as hooks is Phase 3.
- **`tar` dependency:** both the backend host and the project container must have `tar`
  (standard on Linux). Noted so it isn't a surprise on a minimal image.

## Phase 1 acceptance & A/B validation

Acceptance criteria:

1. Flag off ⇒ unchanged. **Proven.** `startCycle` only branches on
   `buildRunnerMode(process.env)`; with `BUILD_RUNNER` unset it calls the hand-rolled
   `runCycle` exactly as before, and `runner-sdk.js` / the SDK package are never
   imported. The backend suite is green apart from the one pre-existing, unrelated
   `vpn-mtu.test.js` failure: **454 pass / 1 pre-existing fail / 2 skipped** (was 451
   tests; +6 are the new pure-helper tests in `mock2-sdk-runner.test.js`).
2. Flag on ⇒ one cycle completes via `query()` producing a commit + change record + gate
   battery, with the constitution loaded from `.claude/CLAUDE.md` (not re-explored).
   **Implemented**; end-to-end journey pending the operator A/B run below (needs a live
   container + Anthropic connector).
3. Fully reversible by flipping `BUILD_RUNNER`. **Yes** — the flag is the only switch,
   read in one place.

Phase 1 checkbox is intentionally left **unchecked** until the A/B run confirms the
primary user journey works via the SDK path on a real environment — per the acceptance
rule "do not claim success on gates-green alone."

**A/B validation (required before claiming success).** Run the **same** known task on the
ADP repo both ways and record the numbers here. The gate that matters is the **primary
user journey working end-to-end**, not gates-green alone.

| Metric | Hand-rolled runner | SDK runner |
|---|---|---|
| Primary user journey works end-to-end | _pending real-env run_ | _pending real-env run_ |
| Total tokens (input+output) | _pending_ | _pending_ |
| Number of turns | _pending_ | _pending_ |
| Human interventions | _pending_ | _pending_ |

> The A/B numbers require a live Incus + Anthropic-connector environment (a real fenced
> project container and a decryptable build_runner key). The development container this
> was authored in has neither, so the A/B row is **left pending an operator run** rather
> than filled with fabricated numbers. Procedure to fill it in:
>
> 1. On a real install, pick a project whose build_runner slot points at an **Anthropic**
>    connector. Choose the front-end/JWT wiring task on the ADP repo (a good exercise of
>    the login-page + auth journey).
> 2. Run the cycle once with `BUILD_RUNNER` unset (hand-rolled) and note tokens/turns/
>    interventions from the cycle row + change record + event log, then confirm the app's
>    login journey actually works in the live preview.
> 3. Restart the environment with `BUILD_RUNNER=sdk` and run the **same** task; record the
>    same four metrics from the `result` message usage + event log.
> 4. Fill the table above and check the Phase 1 box only if the journey works both ways.

---

## Cost-truth: request-as-umbrella, honest usage, tiered model routing

> Added as a self-contained work item (not part of the SDK phases above, but it shares
> the runner/usage/estimator surfaces so it lives here). Both runners
> (`runner.js` hand-rolled, `runner-sdk.js`) inherit every change identically.

### North star

One build request is **one record**. **Cost (dollars) is the honest primary metric.**
Model spend is **tiered** — Fable 5 only where judgment density is highest (the audit
lane) or where Opus 4.8 is demonstrably stuck (a capped escalation consult), **never a
default build lane**.

### What's wrong today (observed)

- A single ask fragments into multiple change records (#26/#27, #30/#31, #36/#39,
  #40/#41/#42).
- `used_tokens` counts only input+output, but cache traffic is ~82% of cost (13,044
  shown for a **$1.78** cycle that actually moved **2.01M** tokens).
- The token basis changed between framework versions (change #30's 1,031,216 includes
  cache; v3's doesn't) — history mixes incomparable numbers.
- The estimator runs ~2× high.
- Duplicate log exports (#40/#41 were byte-identical).

### Located subsystems (the surfaces this work touches)

| Concern | Where |
|---|---|
| Cost computation (**do not change** — penny-accurate) | `quota-logic.js` `costCentsForUsage` (cache-aware: read 0.1×, write 1.25×), `DEFAULT_MODEL_PRICES` |
| Per-turn usage capture | `runner.js` (~L458–465): `u.inputTokens/outputTokens`, `cacheRead/cacheWrite`, `costCentsForUsage`, `addCycleUsage`, `insertLedgerEntry`; SDK: `runner-sdk.js` result `usage` |
| Cycle model/status lifecycle | `cycle-logic.js` `CYCLE_STATUSES` / `ACTIVE`/`TERMINAL`; `cycles.js` |
| Change-record sequencing | `change-records.js` `insertChangeRecord` (seq per **project**, hash-chained) |
| Log export | `routes.js` `GET /projects/:id/cycles/:cycleId/log` and `GET /projects/:id/log`; events in `cycle-events.js` |
| Token-budget ceiling | `runner-logic.js` `SOFT_PAUSE_TOKENS` + `softPauseReason`; `cycle-logic.js` `shouldStopForBudget` (quota is already cents) |
| Estimator | `cycle-logic.js` `estimateCycleTokens`; `runner.js` `estimateCycle` (price via `effectivePrice`) |
| Model-lane config | `connector-logic.js` `MODEL_SLOTS` (concept_chat/mockup/audit/classifier/build_runner/summary/remediation); slots admin-assigned via `connectors.js` `getSlot` |

### Part 1 — Request as the umbrella entity (one request = one log)

- New `request` entity created when the operator submits an ask. Every resulting cycle
  (define, build, halt, resume, budget-pause continuation, retry, **consult**) carries a
  `request_id` and a `segment` label.
- Change-record numbering, UI history, and log export key on the **request**: one entry
  per request showing its segments (define → build → halted → resumed → succeeded), one
  cumulative cost roll-up, one final status. **Cycles stay the internal
  execution/gate/checkpoint unit** (constraint: don't restructure cycles/gates).
- "Download log" exports the **merged, ordered, deduplicated** request log. The
  duplicate-export bug is fixed by making export **idempotent per request + content**
  (a content hash; identical inputs → one identical artifact). Pure builder:
  `request-log.js` `buildRequestLog()` / `requestLogArtifact()`.
- Backfill: **new-requests-only** by default; a cheap optional linker attaches existing
  fragmented cycles to synthetic parents by `(project, contiguous time window)`. If not
  run, history says "legacy (pre-request)". *(Migration additive; see schema below.)*

### Part 2 — Standardize usage; cost becomes primary

- Canonical usage record, **always all four token classes + cost**:
  `{ input, output, cache_read, cache_write, cost_cents }`. No bare "tokens" field.
  Pure: `usage-logic.js` `canonicalUsage()`, `sumUsage()`, `usageCostCents()`
  (delegates to the untouched `costCentsForUsage`), `breakdownForDisplay()`.
- **Primary display is dollars everywhere**, with an expandable four-class breakdown;
  any single token figure is explicitly labeled **"billable in+out"** (`billableInOut()`).
- Budget ceiling converts **tokens → dollars** (per request/project). The existing
  `SOFT_PAUSE_TOKENS = 1_000_000` migrates to its **dollar equivalent**
  `SOFT_PAUSE_COST_CENTS` so behavior doesn't jump: at the build_runner list rate the
  1M-token envelope ≈ **$X** (computed from the lane price, see `budgetCentsForTokenLegacy`).
  Budget-pause messages report **dollars**. Cache-heavy and output-heavy runs with equal
  in+out now trip at **equal spend** (they didn't before — the ceiling ignored cache).
- **Schema version stamp** on usage: `USAGE_SCHEMA_VERSION = 3`. Pre-v3 records are
  flagged `comparable:false`, excluded from history mixing and estimator training
  (`isComparable()`). Change #30 renders as **legacy-basis**.

### Part 3 — Calibrate the estimator from history

- Estimate **cost, not tokens**. Rolling **per-stage-type** calibration
  (define / build / resume-verify) from recent `(estimate, actual)` pairs, biased
  **~20% high**, multiplier **clamped** to a sane band. Show **est-vs-actual** on every
  completed request. **Per-lane pricing** is folded in (audit on Fable 5 costs 2×/token
  vs Opus, so the estimator multiplies the lane's own model price). Pure:
  `estimate-logic.js` `calibrateMultiplier()`, `estimateStageCostCents()`.

### Part 4 — Spend visibility

- Per-request: cost per **segment** (define vs build vs resume vs consult).
- Per-project: cumulative spend + a rolling est-vs-actual accuracy read.
- Reuses existing display components (constraint: no unrelated UI work).

### Part 5 — Fable 5 in exactly two places

**Prerequisite (built first, gating):** Fable 5 can return `stop_reason: "refusal"`
from its safety classifiers — a shape Opus 4.8 never produces. The runner maps a refusal
to the existing **`halt`** state with the refusal text as the reason (needs-attention,
resumable) — **never a crash or a retry loop**. `runner-logic.js` `classifyTurn` now
detects `stopReason === 'refusal'` → `{ halted, haltReason, trigger:'model_refusal' }`;
both runners route it through the existing `haltCycle`. No lane may switch to Fable 5
until this exists and is tested. *(Tested: `mock2-cost-truth.test.js`.)*

1. **Audit lane → Fable 5** (`claude-fable-5`, $10/$50 per M — already in
   `DEFAULT_MODEL_PRICES`). Audit cycles are tiny (~$0.07 → ~$0.15) and judgment-dense
   (rule questions, deviation flags, blocker analysis): the best price/quality trade.
   Encoded as a **recommended model per slot** (`connector-logic.js`
   `RECOMMENDED_MODEL_FOR_SLOT`), audit → `claude-fable-5`. **build_runner / remediation /
   all other lanes keep their current models** (opus/haiku). A guard test asserts no lane
   except `audit` recommends Fable 5, so *"a config or code path that routes build/
   remediation to Fable 5 by default"* cannot exist.
2. **Escalation consult ("second opinion") — bounded, trigger-gated, advisory-only.**
   A single Fable 5 call that fires only when Opus 4.8 is demonstrably stuck. Pure logic:
   `consult-logic.js`.
   - **Deterministic triggers:** (a) same gate fails ≥2 consecutive attempts in a cycle;
     (b) no-progress breaker trips; (c) a resumed request halts again for the **same**
     reason; (d) operator clicks **"Get guidance"** on a halt card.
   - **Hard cost containment:** **no tool access** — it gets a compiled **context digest
     only** (task, halt/failure reason, last errors/gate output, relevant file excerpts);
     input capped **~30k tokens**, output capped **~4k tokens** ≈ **$0.50/consult**.
   - **Caps:** max **1 consult per halt**, max **2 per request**; further consults require
     the operator button (`consultAllowed()`).
   - **Advisory-only:** output is a diagnosis + 2–4 ranked paths forward + suggested
     resume text, attached to the halt card as **"Second opinion (Fable 5)"** and offered
     as pre-filled resume guidance. It **never** takes over the build, **never** switches
     the build lane; the operator (or the resuming Opus cycle) executes. Its cost logs as
     its **own segment** in the request roll-up (Parts 1/4).

### Also (same cycle): data-reset guidance out of the migration chain

Framework guidance that **resets data** ("clear users for re-test") belongs in
`scripts/` or behind a **scoped operational authorization** (the Part-4 authorization
mechanism from the halt-resolution work), **not** in the schema migration chain. The ADP
migration is **not** retro-edited. Delivered as `scripts/mock2-reset-users.sh` documented
as authorization-gated.

### Schema changes — **shipped as migration 515** (strictly additive + reversible)

Migration `515` (`mock2_cost_truth_request_usage_consults`) adds ONLY new tables and
NULLable columns — no existing row is rewritten, no column/type changes — so a fresh
checkout behaves byte-identically until code opts in.

- `mock2_requests` (new): `id, project_id, instruction, status, initiated_by,
  acting_as_admin, created_at, finished_at` — the umbrella. Cycles gain `request_id` +
  `segment` (both NULLable; pre-existing cycles stay NULL = legacy/new-requests-only).
- `mock2_cycles`: `+ input_tokens, output_tokens, cache_read_tokens, cache_write_tokens`
  (the four canonical classes; the old `used_tokens` stays for back-compat, surfaced as
  the `usage` object + labeled "billable in+out"), `+ usage_schema_version` (stamped `3`
  by the runner; NULL on legacy rows ⇒ non-comparable), `+ request_id`, `+ segment`.
- `mock2_consults` (new): `id, project_id, request_id, cycle_id, trigger, model,
  input_tokens, output_tokens, cost_cents, diagnosis, paths_json, suggested_resume,
  requested_by, created_at`.

### Budget semantics — **shipped behind a flag** `MOCK2_BUDGET_DOLLARS` (default OFF)

The runner's soft-pause ceiling stays **token-based** (unchanged) until an operator sets
`MOCK2_BUDGET_DOLLARS=on|1|true` on the live install. When on, the token ceiling is
replaced by its **dollar equivalent** (`budgetCentsForTokenLegacy(SOFT_PAUSE_TOKENS,
laneModel)` — the 1M-token envelope priced at the lane's own model, so behavior doesn't
jump), checked via `budgetPauseReasonCents` against the run's real spend (cache included);
pause messages read dollars. Both runners inherit this identically. The four canonical
token classes are written to the cycle **in both modes** (additive; only the *pause
decision* is flag-gated).

### Auto-consult — **shipped behind a flag** `MOCK2_CONSULT` (default OFF)

The AUTO escalation consult (triggers a/b — same gate failing twice; no-progress breaker)
fires from `haltCycle` only when `MOCK2_CONSULT=on`. The operator **"Get guidance"** button
(trigger d) is NOT gated — it's an on-demand route (`POST …/cycles/:id/consult`) that never
touches the runner loop. Caps (1/halt, 2/request) enforced from `mock2_consults` counts;
the button bypasses the auto caps.

### New routes (additive, viewer/editor-gated)

- `GET  /projects/:id/requests` — one row per request with its cost roll-up + segments.
- `GET  /projects/:id/requests/:reqId/log` — the merged/ordered/deduped request log +
  the **idempotent** export artifact (content-hashed).
- `POST /projects/:id/cycles/:cycleId/consult` — operator "Get guidance" (Fable 5 second
  opinion, advisory-only, ~$0.50, logged as a segment).
- `GET  /projects/:id/cycles/:cycleId/consults` — consults attached to a cycle.

### Acceptance mapping & evidence

| Acceptance | Status |
|---|---|
| #42 four-class breakdown reproduces **$1.778** at Opus rates (72 / 12,972 / 1,922,721 / 78,722) | ✓ pure test `mock2-cost-truth.test.js` |
| Budget triggers on **dollars**; equal in+out ⇒ equal-spend trip regardless of cache/output mix | ✓ pure test; **wired** in both runners behind `MOCK2_BUDGET_DOLLARS` — needs a live run with the flag on to observe |
| Estimates land ~+10–35% of actual; per-lane pricing reflected | ✓ pure test (`estimate-logic`); estimator not yet swapped into the live start path (still the token envelope) — **pending** |
| Simulated Fable 5 `refusal` ⇒ halt with reason, no crash/loop | ✓ pure test; **wired** in both runners (`classifyTurn` → `haltCycle` trigger `model_refusal`) |
| Consult: one stuck cycle fires **exactly one** consult within caps; 3rd refused w/o button; lane never switches | ✓ pure test; **wired** (auto behind `MOCK2_CONSULT`, operator button always on) — live observation pending |
| One request define→build→halt→consult→resume→succeed ⇒ one history entry + one log, consult itemized (~$0.50); double-export identical | ✓ pure idempotency test; request entity + grouped-log/export routes **wired** — end-to-end render **pending live DB** |
| Audit lane runs on Fable 5 for one real define stage; cost delta visible | **pending operator run** (needs live Incus + Fable 5 connector) |
| #40/#41/#42 renders as one record ~**$1.85**; #30 legacy-basis; before/after screenshots | **pending operator run** (needs live DB + the spend UI, which is deliberately left for the live pass) |

**Operator live checklist (run on a real install; report back — do not fabricate):**
1. Apply migration 515 (automatic on boot when enabled). Confirm existing cycles read
   unchanged (NULL `request_id`, `usage_schema_version` NULL ⇒ shown legacy-basis).
2. Run one build ask end-to-end → confirm it renders as **one request** with segments +
   a cumulative dollar roll-up; **download the log twice** → identical artifact (same
   `content_hash`).
3. Set `MOCK2_BUDGET_DOLLARS=on`; confirm a cache-heavy run soft-pauses on **dollars**.
4. Assign the **audit** slot to a Fable 5 connector; run one define stage; confirm the
   audit cost is itemized and the delta is visible; confirm a simulated refusal lands as
   a halt (no loop).
5. Set `MOCK2_CONSULT=on`; force the same gate to fail twice; confirm **exactly one**
   auto-consult fires (≤ caps), attaches to the halt card, and logs as a `consult`
   segment; a 3rd auto attempt is refused without the "Get guidance" button; the build
   lane never switches models.
6. Confirm the #40/#41/#42 request totals ~**$1.85** as one record and #30 shows
   legacy-basis. Screenshot before/after change history into this doc.

> **Live-validation honesty (same convention as Phase 1 above).** The development
> container has no better-sqlite3 native module, no Incus, no Fable 5 connector, and no
> browser, so the three live-data acceptance items (real Fable-5 define stage, the
> #40/#41/#42 one-record render, and before/after change-history screenshots) are **left
> pending an operator run** rather than fabricated. Every item that can be proven with
> pure logic (the #42 cost math, the dollar budget trip, refusal→halt, consult caps,
> estimator range, export idempotency) is covered by `mock2-cost-truth.test.js` and the
> per-module tests and runs in CI here.
