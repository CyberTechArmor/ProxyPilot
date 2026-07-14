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
