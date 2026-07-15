# Harness Comparison — ProxyPilot "mock2" vs. GitHub Copilot Chat / VS Code Agent

**Scope:** This compares the *orchestration layer* (the agent harness) of two systems, not
the underlying models. "Harness A" is the AI application-builder embedded in this repo at
`admin/backend/src/mock2/` (internally called **mock2**; the loop calls itself the
"build runner"). "Harness B" is the open-source GitHub Copilot Chat / VS Code agent harness
(`microsoft/vscode-copilot-chat`, MIT).

**Sourcing convention.** Harness A claims cite exact `path:line` in this repo (paths relative
to `admin/backend/src/mock2/` unless noted). Harness B claims are tagged `[SRC]`
(verified from repo source), `[BLOG]` (from the VS Code blog / docs), `[DW]` (DeepWiki, a
third-party source-derived wiki — secondary), or `[INF]` (inference). Anything I could not
verify is flagged inline.

> **Note on what "Harness A" is.** ProxyPilot is a reverse-proxy management product. The
> agent harness is a *product feature* — mock2, a spec-driven "Concept → Define → Build →
> Run" framework that generates whole applications inside network-fenced Incus containers.
> It is not a coding assistant for ProxyPilot's own repository. The comparison is therefore
> between an **autonomous, governed, server-side app-generation harness** and an
> **interactive, human-in-the-loop, editor-hosted coding assistant** — the design divergence
> follows almost entirely from that difference in purpose.

---

## 1. Executive summary

ProxyPilot's mock2 harness and the Copilot/VS Code harness solve the same core problem — drive
a model through a plan/act/observe loop with tools — but optimize for opposite ends of the
autonomy/interactivity axis. **mock2 is a governed, unattended app factory:** each unit of work
(a "cycle") runs a hand-rolled turn loop server-side against a per-project sandboxed container,
with a tiny fixed tool set, a pinned "constitution" injected as the system prompt, a
deterministic gate battery it must pass before a change is accepted, a hash-chained audit trail,
and a per-project token/dollar budget envelope (`runner.js`, `runner-logic.js`,
`integration-enforcement.js`, `quota-logic.js`). **Copilot/VS Code is an interactive coding
assistant:** its loop runs inside the editor on the user's machine, exposes dozens of built-in
tools plus arbitrary extension/MCP tools, assembles its prompt from TSX components with
priority-based token budgeting (`@vscode/prompt-tsx`), and relies on user confirmation rather
than sandboxing for safety `[SRC]`. The sharpest architectural differences are: (a) **safety
model** — mock2 isolates untrusted generated code in a default-deny nftables-fenced container;
Copilot runs tools directly on a trusted developer machine and gates them with confirmation
prompts; (b) **governance** — mock2 makes "done" a machine-verified verdict (gates green +
integration-truthfulness gate + acceptance discipline) that the model cannot self-approve
(`runner.js:754-1011`), whereas Copilot treats the human as the reviewer; (c) **extensibility**
— Copilot has a rich open plugin surface (LanguageModelTool API, MCP, chat participants, custom
instructions) while mock2's tool set is fixed and closed by design; and (d) **context/prompt
engineering** — Copilot invests heavily in priority-based pruning and prompt caching across a
large dynamic prompt, while mock2 assembles a smaller, mostly static system prompt and leans on
the container's git working tree (not replayed conversation) as its cross-session memory
(`runner.js:460-507`). Notably, mock2 is mid-migration toward the Claude Agent SDK
(`docs/agent-sdk-migration.md`), explicitly to delete its re-implemented loop and keep only its
differentiator — the spec + governance layer. Both harnesses independently converged on the same
provider abstraction (Anthropic/OpenAI/Gemini), prompt-cache breakpoints, and multi-agent/
subagent structure.

---

## 2. Side-by-side comparison

| Dimension | Harness A — ProxyPilot mock2 | Harness B — Copilot Chat / VS Code |
|---|---|---|
| **Agent loop** | Hand-rolled `for turn < MAX_TURNS(300)` loop; each turn = one model call → classify → execute tools → feed back. Terminal only via explicit `finish`/`pending_verification`/`halt`/`request_authorization` tools. Macro pipeline: Concept→Define→Build→Run. (`runner.js:546-1122`, `runner-logic.js:443-502`) | `ToolCallingLoop` "think→act→observe" `[BLOG]`; loop ends when a response has no tool calls, hits `toolCallLimit`, is cancelled, or (autopilot) calls `task_complete`. `MAX_AUTOPILOT_ITERATIONS=5`, `MAX_AUTOPILOT_RETRIES=3` `[SRC/DW]`. (`src/extension/intents/node/toolCallingLoop.ts`) |
| **Context / prompt assembly** | Server-assembled string: constitution (pinned) + skills + component catalog + design tokens + how-to-work steps, rebuilt each cycle; per-cycle context turns (stub registry, capability status, resume guidance) injected as user turns. (`runner-logic.js:281-410`, `runner.js:451-507`) | TSX components (`@vscode/prompt-tsx`) with `priority`/`flexGrow` pruning + `TokenLimit`; system rules + custom instructions (`.github/copilot-instructions.md`, `*.instructions.md`, modes, `SKILL.md`) + workspace context + summarized history + tool-call rounds; tool results capped `MAX_TOOL_RESPONSE_PCT=0.5`. (`agentPrompt.tsx`) `[SRC]` |
| **Tool system** | Frozen `RUNNER_TOOLS` array (10 tools), neutral JSON-Schema, mapped per provider; dispatch `switch` in `executeTool`; args coerced/validated defensively; results truncated to 12000 chars and pushed back as tool turns. Closed set. (`runner-logic.js:23-214`, `runner.js:1142-1229`) | VS Code `LanguageModelTool` API; ~50+ built-in tools + extension + MCP tools; declared via `contributes.languageModelTools` (JSON Schema `inputSchema`); lifecycle hooks `resolveInput`/`prepareInvocation`/`invoke`/`filterEdits`; confirmation tools. Open, extensible. (`toolNames.ts`, `toolsRegistry.ts`, `package.json`) `[SRC]` |
| **Model integration** | Provider-agnostic `callModelTurn` — raw `fetch` to Anthropic/OpenAI-compat/Gemini; no vendor SDK; Anthropic prompt-cache breakpoints; abort scales with `maxTokens`; per-turn usage normalized. Keys decrypted orchestrator-side only. (`model-client.js:38-257`) | Proprietary Copilot/CAPI backend (internals out of scope) `[INF]`; in-repo BYOK providers for Anthropic/OpenAI/Gemini/Ollama/xAI/Azure/OpenRouter via `contributes.languageModelChatProviders`; streaming `finishedCb`; prompt-tsx cache breakpoints. (`src/extension/byok/vscode-node/`) `[SRC]` |
| **State & memory** | Separate SQLite (`mock2.db`); a resume is a *fresh cycle* — transcript rebuilt from scratch, not replayed. Cross-session memory = the container git working tree (`state/*.json`, `state/rules.md`) + hash-chained change records + rolling summaries. (`runner.js:355-360`, `db.js`, `change-records.js`) | Summarized/compacted conversation history (`SummarizedConversationHistory`); cloud repo memory via CAPI (`agentMemoryService.ts`) + file-based `Memory` tool; workspace embeddings/semantic index. (`conversation/`, `workspaceChunkSearch/`) `[SRC]` |
| **Guardrails & security** | **Sandboxed:** per-project Incus container + per-project bridge + default-deny nftables fence + declared/approved egress allowlist; role model (viewer/editor/admin); checkout locks; token/dollar quotas; secrets AES-256-GCM at rest, decrypted orchestrator-side only; **machine-verified "done"** (gate battery + integration-truthfulness gate + disclosure screening + negative-auth smoke). (`network-logic.js`, `integration-enforcement.js`, `smoke.js`, `secrets.js`) | **Not sandboxed** — tools run on the user's machine `[INF]`; safety via confirmation tools (`CoreConfirmationTool*`, terminal approval allowlist `chat.tools.terminal.autoApprove` `[BLOG]`), Workspace Trust `[INF]`, `.copilotignore`/org content-exclusion, injected `SafetyRules`. (`ignore/vscode-node/`, `toolNames.ts`) `[SRC]` |
| **Observability** | Durable per-cycle event log `mock2_cycle_events` (task/ai_message/tool_call/tool_result/gate/checkpoint with per-turn token+cost meta); append-only quota ledger; hash-chained change records; merged/deduped downloadable request log. (`cycle-events.js`, `runner.js:658-668`, `request-log.js`) | Trajectory recording in ATIF v1.5 (`RequestLogger` + `TrajectoryLogger`) for replay/debug; "Chat Debug" request log; telemetry + OpenTelemetry. (`src/extension/trajectory/ARCHITECTURE.md`, `telemetry/`, `otel/`) `[SRC]` |
| **Extensibility** | Closed by design: fixed tool set; new capability = framework-version bump (constitution/skills/gates seed) + published components in the library; model "slots" admin-assigned per stage. (`framework.js`, `components.js`, `connector-logic.js`) | Open: `LanguageModelTool` tools, `chatParticipants`, MCP servers, BYOK providers, custom instructions/modes/skills — all via `package.json` contribution points. (`package.json`, `mcp/`, `byok/`) `[SRC]` |

---

## 3. Per-dimension analysis

### 3.1 Agent loop

**Harness A.** The loop is a hand-rolled bounded `for (let turn = 0; turn < MAX_TURNS; turn++)`
in `runner.js:546`, with `MAX_TURNS = 300` as a runaway backstop (`runner-logic.js:244`). Each
iteration: (1) honor interrupts at the step boundary (`runner.js:547-564`); (2) enforce
mid-cycle quota + soft budget pause (`runner.js:566-605`); (3) call the model
(`callModelTurn`, `runner.js:608`); (4) classify the turn via the pure `classifyTurn`
(`runner-logic.js:443-502`); (5) act on the classification. Continuation vs. termination is
driven entirely by *which tool the model called*, not by a heuristic:

- `finish` → `succeeded` **only after** the orchestrator re-runs the gate battery and the
  acceptance/integration checks pass — "it never approves its own work: we re-run the battery"
  (`runner.js:754-1011`).
- `pending_verification` → a calm pending-operator-verification terminal for real code that
  needs a live external check the fence can't run (`runner-logic.js:126-153`, `runner.js:756`).
- `halt(reason, options)` → blocked, non-success, resumable; must carry 2–4 typed resolution
  options or gets one retry to supply them (`runner.js:696-731`).
- `request_authorization(scope)` → ends the cycle awaiting an admin (`runner.js:736-752`).

Two safety mechanisms bound the loop *below* `MAX_TURNS`: a **soft budget pause** (default ~1M
tokens or ~45 min wall-clock, `runner-logic.js:225-237`) that checkpoints WIP and pauses
(resumable), and a **no-progress circuit breaker** (default 3 consecutive no-tool/near-identical/
no-state-change turns → auto-halt, `runner-logic.js:529-540`, `runner.js:1096-1099`). Both were
added in response to a real incident where the model emitted 118 near-identical refusals and
burned ~$4.76 because `finish` was the only terminal action (`docs/agent-sdk-migration.md:73-85`).
Above the single cycle sits a **macro pipeline** — Concept (chat + mockup, restricted tools) →
Define (rule-question audit) → Build (this loop) → Run (deploy) — with per-stage cycle rows and
distinct model slots (`concept.js:1-24`, `cycle-logic.js:20-30`).

**Harness B.** The loop is `ToolCallingLoop` (`toolCallingLoop.ts`) with the agent entry in
`agentIntent.ts` `[SRC]`. The blog frames it as "think → act → observe → think again," with the
harness assembling context, exposing tools, running the loop, and interpreting tool calls
`[BLOG]`. It terminates when a response has no tool calls, hits a configurable `toolCallLimit`
(behavior `Confirm` vs `Stop` via `onHitToolCallLimit`), is cancelled/`yieldRequested`, or — in
autopilot — the model calls `task_complete` `[SRC/DW]`. Autopilot caps: `MAX_AUTOPILOT_ITERATIONS
= 5`, `MAX_AUTOPILOT_RETRIES = 3`, `toolCallLimit` extended ~1.5× capped at 200 `[DW]` (constants
read via DeepWiki/WebFetch, not byte-verified — re-open `toolCallingLoop.ts` to confirm exact
values). "Stop hooks" can veto termination by returning `shouldContinue: true` `[SRC]`.

**Divergence.** mock2's loop is *deterministically governed* — termination is a typed tool call
whose success is re-verified by the orchestrator, and the whole thing runs unattended. Copilot's
loop is *interaction-governed* — it stops to ask the human (tool-call limit dialogs, confirmation
tools) and treats the natural "no more tool calls" state as done. mock2 has no equivalent of
Copilot's interactive continue/stop dialog; Copilot has no equivalent of mock2's machine-verified
finish verdict.

### 3.2 Context / prompt assembly

**Harness A.** `buildRunnerSystemPrompt` (`runner-logic.js:281-410`) assembles a mostly static
system prompt each cycle from: a fixed role/scaffold preamble, a design-fidelity section
(reads `state/design-tokens.json` / `state/design.css`), the **pinned** organizational
constitution injected verbatim ("this is binding, not advisory", `:313-314`), an
administrator-approved-exceptions override clause, the skills list, the component catalog, an
integration-manifest contract, and numbered how-to-work steps. The first user turn is the task
(`buildRunnerTask`, `runner-logic.js:414-416`). Additional context is injected as **discrete
labeled user turns** at cycle start: unresolved-stub registry status (`runner.js:467-480`),
ambient capability-verification status (`:485-496`), and — on resume — operator guidance from
`resume_context_json` (`:497-507`). The prompt is rebuilt fresh every cycle from the pinned
framework version; the constitution/skills deliberately never travel through chat
(`runner-logic.js:276-281`). Token efficiency comes from **Anthropic prompt-cache breakpoints**
on the system block and the last message block (`model-client.js:75-138`), not from pruning.

**Harness B.** Prompts are authored as **TSX components** via `@vscode/prompt-tsx`; the main
agent prompt is `agentPrompt.tsx` `[SRC]`. Verified system identity: "You are an expert AI
programming assistant, working with a user in the VS Code editor," plus injectable
`CopilotIdentityRules`, `SafetyRules`, memory instructions `[SRC]`. Layered assembly: base system
instructions → custom instructions (placement configurable) → global agent context (workspace,
OS, date, tasks, preferences) → summarized conversation history → current message; prior tool
output re-enters via `ChatToolCalls` components keyed by `toolCallResults`/`toolCallRounds` with
`truncateAt` `[SRC]`. The distinctive engineering is **priority-based token budgeting**: nodes
carry a `priority` (higher wins on prune) and `flexGrow`, governed by a `TokenLimit`; tool
results are capped at 50% of the window (`MAX_TOOL_RESPONSE_PCT = 0.5`) and cache breakpoints are
inserted to maximize prompt-cache hits `[SRC]`. Custom instructions come from
`.github/copilot-instructions.md`, `*.instructions.md`, chat modes, and `SKILL.md` files `[SRC]`.

**Divergence.** Copilot treats prompt assembly as a first-class, dynamic, budget-managed problem
(a component tree with priorities and pruning) because its context (open workspace, long chat,
many tools) is large and variable. mock2's context is smaller and more controlled, so it uses
straight string assembly + prompt caching and pushes long-lived state into the file tree rather
than the prompt. Both converged on cache breakpoints for ITPM/cost control.

### 3.3 Tool system

**Harness A.** Tools are a single frozen array `RUNNER_TOOLS` (`runner-logic.js:23-214`), each
`{ name, description, input_schema }` with `input_schema` a JSON Schema
(`additionalProperties:false`). Ten tools: `exec_in_container`, `read_file`, `write_file`,
`get_component`, `materialize_component`, `run_gates`, plus the four terminal moves `finish`,
`pending_verification`, `halt`, `request_authorization`. `callModelTurn` maps the neutral schema
to each provider's shape (Anthropic `input_schema`, OpenAI `function.parameters`, Gemini
`functionDeclarations`) at `model-client.js:91/174/221`. Non-terminal calls dispatch through a
`switch (call.name)` in `executeTool` (`runner.js:1142-1229`); terminal calls are intercepted by
`classifyTurn` before dispatch. Validation is **defensive/coercive at execution** (`String(...)`
coercion, path safety via `safeRel` rejecting `..`/absolute paths at `runner.js:1234`) rather
than schema-enforced, plus rich **payload validation that feeds errors back into the transcript**
so the model can restate (halt options `runner.js:700-718`, auth scope `:737-742`, finish
acceptance/assumptions `:778-836`, gates-not-green `:854-866`). Results are truncated to
`MAX_TOOL_RESULT_CHARS = 12000` (`runner-logic.js:245`) and pushed back as `role:'tool'` turns.
The set is **closed** — an unknown tool returns an error string (`runner.js:1228`).

**Harness B.** Tools use VS Code's `LanguageModelTool` API. Built-ins are enumerated in
`toolNames.ts` (~50+, e.g. `ReadFile`, `EditFile`, `ReplaceString`, `ApplyPatch`, `Codebase`,
`FindTextInFiles`, `CoreRunInTerminal`, `FetchWebPage`, `Memory`, plus subagent tools
`CoreRunSubagent`/`SearchSubagent`/`ExecutionSubagent` and a dynamic `ToolSearch`) `[SRC]`.
Registration is via a singleton `ToolRegistry` (`toolsRegistry.ts`) with `registerTool`/
`registerModelSpecificTool`; the `ICopilotTool` interface exposes lifecycle hooks `resolveInput`,
`prepareInvocation`, `invoke`, `provideInput?`, and `filterEdits?` (edit-confirmation gating)
`[SRC]`. Model-facing declaration is `contributes.languageModelTools` in `package.json` with
`name`/`toolReferenceName`/`modelDescription`/`inputSchema` `[SRC]`; schemas are normalized by
`toJsonSchema.ts` + `toolSchemaNormalizer.ts` `[SRC]`. Confirmation is first-class
(`CoreConfirmationTool*`, `CoreTerminalConfirmationTool`) `[SRC]`, and MCP tools surface into the
same list (`src/extension/mcp/`) `[SRC]`. The set is **open and uniform** — Copilot's own tools
and third-party/MCP tools register through the same path.

**Divergence.** mock2's tools are few, fixed, and every one runs inside the sandbox; Copilot's
are many, extensible, and run on the host with per-tool confirmation. mock2 encodes governance in
the *tools themselves* (finish/halt/authorization as typed terminal moves with validated
payloads); Copilot encodes safety in *confirmation gating* around general-purpose tools.

### 3.4 Model integration

**Harness A.** `model-client.js` is a provider-agnostic layer that speaks raw `fetch` to
Anthropic Messages, OpenAI-compatible chat-completions (also serving `openai_compatible`/
`ollama`), and Gemini `generateContent` (`model-client.js:38-257`) — **no vendor SDK**. It
normalizes a neutral transcript ↔ provider shapes and returns
`{ ok, text, toolCalls, usage, stopReason }`. It implements Anthropic prompt caching with
ephemeral `cache_control` breakpoints on the system block and last message (`:90`, `:127-138`),
surfaces `cache_read`/`cache_creation` tokens for cost-truth, and scales the abort deadline with
requested output (`~50ms/token` floor) so large mockups aren't aborted mid-stream (`:42-48`).
Keys are **decrypted orchestrator-side only** and injected into the outbound request header/URL,
never entering a container (`model-client.js:12-14/96/178/217`; asserted again in
`runner.js:12-16`). Models are chosen per **slot** (concept_chat / mockup / audit / classifier /
build_runner / summary / remediation), admin-assigned to connectors
(`connector-logic.js MODEL_SLOTS`). Retries: transient model failures retry up to
`MAX_CYCLE_RETRIES` then escalate to an admin (`runner.js:609-618`). The **Claude Agent SDK
runner** (`runner-sdk.js`, opt-in `BUILD_RUNNER=sdk`) is Anthropic-only and hands the key to the
SDK subprocess via `options.env` (`docs/agent-sdk-migration.md:44-71`).

**Harness B.** The production path is a proprietary Copilot/CAPI backend whose serving internals
are out of scope `[INF]`; the blog deliberately separates the open harness from the closed model
`[BLOG]`. In-repo **BYOK providers** cover Anthropic/OpenAI/Gemini/Ollama/xAI/Azure/OpenRouter
over `abstractLanguageModelChatProvider.ts`, plugging into
`contributes.languageModelChatProviders`; credentials live in `byokStorageService.ts` `[SRC]`.
Streaming is via the loop's `fetch()` `finishedCb` callback (incremental tool-call/text
extraction) `[SRC]`; token-window management is prompt-tsx priority pruning + the 50% tool-result
cap + cache breakpoints `[SRC]`; retries include autopilot transient-error recovery
(`MAX_AUTOPILOT_RETRIES=3`) `[DW]`.

**Convergence.** Both independently built the same provider matrix (Anthropic/OpenAI/Gemini/
Ollama) and both use prompt-cache breakpoints. **Divergence:** mock2 rolls its own transport
(and is now migrating onto a vendor SDK to shed that code); Copilot leans on the VS Code language-
model provider abstraction and a proprietary primary backend.

### 3.5 State & memory

**Harness A.** State lives in a **separate SQLite database** `data/db/mock2.db` (WAL, 0600, its
own block-500 migrations, opened only when enabled) (`db.js:29-58`). The unit is a **cycle** (one
targeted change + gate battery + checkpoint); `mock2_cycles` records stage/status/pinned framework
version (`migrations.js:217-243`). Crucially, **the model transcript is not persisted as
replayable messages** — it lives in an in-memory array during the run (`runner.js:460`) and the
durable record is the separate `mock2_cycle_events` log (§3.6). A **resume is a fresh cycle**, not
a continuation: `resumeCycle → startCycle(segment:'resumed')` (`runner.js:355-360`), and the new
transcript is rebuilt from the task + injected context, **not** from the prior turn log. The real
cross-session memory is therefore the **git working tree in the container** — `state/rules.md`
(confirmed rules), `state/inventory.json` (the UI spec; mockup code is discarded),
`state/integrations.json`, `state/acceptance.json`, `state/changes/<seq>.json` — plus the
hash-chained `mock2_change_records` spine and rolling `mock2_summaries`. This is a deliberate,
documented trade-off; the SDK migration's Phase 2 is explicitly "replace re-explore-the-tree-on-
every-resume with the SDK's `resume` session" (`docs/agent-sdk-migration.md:363-365`).

**Harness B.** Conversation state is summarized/compacted (`SummarizedConversationHistory`,
`conversation/`, `conversationStore/`) `[SRC]`. Two memory mechanisms: **cloud repo memory** via
the Copilot Memory service/CAPI (`agentMemoryService.ts`, structured `subject`/`fact`/`citations`
entries keyed by repo, fails open if disabled) `[SRC]`, and **file-based memory** implied by the
`Memory`/`ResolveMemoryFileUri` tools + `memoryCleanupService.ts` `[SRC/INF]`. Workspace
**embeddings/semantic index** (`workspaceChunkSearch/`, `workspaceSemanticSearch/`, the `Codebase`
tool) feed relevant code into context on demand `[SRC]`.

**Divergence.** Copilot invests in *conversation* memory (summarization + cloud memory +
embeddings) because it's a long-lived interactive session over an existing codebase. mock2 treats
each cycle as nearly stateless at the LLM level and makes the **filesystem + audit chain** the
source of truth — which fits an unattended, resumable, auditable pipeline but means each resume
re-reads the tree cold (the gap Phase 2 targets).

### 3.6 Guardrails & security

**Harness A — sandboxing is the headline.** Generated (untrusted) code runs in a per-project
unprivileged **Incus container** on a per-project **bridge**/`/24` (`provision.js:227`,
`network-logic.js:57-79`), behind a **default-deny nftables fence** in a dedicated `table inet
mock2` (`firewall.js`, `network-logic.js:118-169`): inbound only the declared web port; egress to
RFC1918/link-local is rejected-and-logged; a bridge may reach only its own gateway for DNS/DHCP.
Egress is **declared, never discovered** — an app that needs an internal host declares it in
`mock2.yaml`, which creates a *pending* grant that an admin must approve before a scoped
allow-hole is punched (`egress-grants.js:10-144`, `egress-logic.js:136-147`). (Doc drift to flag:
`.env.example:126-145` still describes a squid proxy that the code has removed in favor of direct
Incus NAT + nftables — `egress.js:1-21`.) **Permissioning** is a viewer/editor/admin role model
with 404-not-403 for non-members (`authz.js:19-45`, `project-logic.js:45-63`) and one-writer
**checkout locks** (`lock-logic.js`, `locks.js`). **Quotas** enforce a cost envelope at start
(`canStartCycle`, `quota-logic.js:110-139`) and mid-cycle against a live ledger
(`runner.js:566-575`). **Secrets** are AES-256-GCM at rest (`secrets.js`), keyed by
`TOTP_ENCRYPTION_KEY` (prod refuses to boot without it), model/git credentials decrypted
orchestrator-side only and never entering a container (`connectors.js`, `git-connectors.js`). The
distinctive guardrail is **machine-verified "done"**: `evaluateIntegrationTruthfulness`
(`integration-enforcement.js:51-138`) composes the integration gate (undeclared/simulated external
capability → fail-closed), egress completeness, and disclosure screening (a lexical classifier
over the model's own finish text catching "faked/canned success" claims); a **negative-auth smoke
check** verifies a generated app rejects a spoofed `x-user-role: admin` header (`smoke.js:65-96`);
and a resume loop-breaker disables auto-retry when the same finding set survives repeated
resolutions (`integration-enforcement.js:158-201`).

**Harness B — confirmation, not isolation.** Tools run directly on the **user's machine**; there
is no execution sandbox `[INF]`. Safety comes from: dedicated **confirmation tools**
(`CoreConfirmationTool`, `CoreConfirmationToolWithOptions`, `CoreTerminalConfirmationTool`) and
per-tool `filterEdits` edit gating `[SRC]`; a **terminal auto-approve allowlist**
(`chat.tools.terminal.autoApprove`) `[BLOG]`; **Workspace Trust** `[INF]`; **content exclusion**
(`.copilotignore`/org policy via `ignore/vscode-node/`) so excluded files never enter context
`[SRC/INF]`; and injected `SafetyRules`/`CopilotIdentityRules` `[SRC]`.

**Divergence.** This is the deepest split. mock2 assumes the *code it runs is untrusted* and the
*operator is remote*, so it isolates aggressively and makes acceptance a verified verdict.
Copilot assumes the *developer is present and trusts their own workspace*, so it optimizes for low-
friction execution with human confirmation at the risky edges. Neither model transfers cleanly:
mock2's fence would be overkill (and impossible) for editing a user's live repo; Copilot's
confirmation model would be unsafe for unattended generation of untrusted apps.

### 3.7 Observability

**Harness A.** The durable, reviewable transcript is `mock2_cycle_events` (`cycle-events.js`,
migration 512): `logEvent` records `task`, `ai_message` (with per-turn input/output/cache tokens
+ `cost_cents` in meta, `runner.js:658-666`), `tool_call` (name + input), `tool_result`, `gate`,
`checkpoint`, `deploy`, `stub_context`, `resume_guidance`, and Builder `feedback`
(`cycle-events.js:79-102`); content clipped to 8000 chars and logging is best-effort (never fails
a build). An operator can trace every prompt turn, tool call + input, tool result, gate outcome,
and per-step spend via `listCycleEvents`. Cost is tracked per model call into an append-only
`mock2_quota_ledger` (`runner.js:647`) with cache-aware pricing (`quota-logic.js:16-39`), and the
`request-log.js` builder produces a merged/ordered/deduped, content-hashed **downloadable** log
per build request. The audit spine is the **hash-chained** `mock2_change_records`
(`change-logic.js:20-87`).

**Harness B.** Observability centers on **trajectory recording** in **ATIF v1.5** (Agent Trajectory
Interchange Format) — `RequestLogger` (bounded log of all LLM requests, tool calls, prompt traces)
+ `TrajectoryLogger` + adapter, exporting JSON steps with timestamps/messages/tool-calls/
observations/token metrics for analysis, debugging, and replay (`src/extension/trajectory/
ARCHITECTURE.md`) `[SRC]`. There's a user-facing "Chat Debug"/request-log output channel, plus
`telemetry/` and OpenTelemetry (`otel/vscode-node/`) `[SRC]`.

**Convergence.** Both capture a structured, replayable per-turn trace with token metrics. mock2's
adds a *tamper-evident* hash chain and a *cost ledger* (because it bills/budgets and audits);
Copilot's adds a *standardized interchange format* + telemetry/OTel (because it's a debugging/
benchmarking surface across a fleet).

### 3.8 Extensibility

**Harness A.** Intentionally closed. New capability is *not* a new tool — it's a **framework
version bump** (edit the `framework-seed/` constitution/skills/gates, published monotonically via
`upgradeFrameworkFromSeed`, `framework.js`, `framework-logic.js`) and/or a **published component**
in the library that the runner can `get_component`/`materialize_component`
(`components.js`, `runner.js:1158-1223`). Models are pluggable via admin-assigned **slots**
(`connector-logic.js`). The one architectural extension point is the **runner backend** itself:
`BUILD_RUNNER=sdk` swaps the hand-rolled loop for the Claude Agent SDK (`runner.js:271-273`).

**Harness B.** Broadly open via `package.json` contribution points: `languageModelTools` (custom
tools), `chatParticipants` (`github.copilot.default`, `editsAgent`, etc.), MCP servers, BYOK
`languageModelChatProviders`, and custom instructions/modes/`SKILL.md` `[SRC]`. Third parties
extend the harness through the same APIs Copilot itself uses.

**Divergence.** Copilot is a *platform* (extension ecosystem, MCP, participants); mock2 is a
*closed appliance* whose extensibility is governance-first (change the rules/gates/components, not
the tool surface) — appropriate when the harness must keep untrusted generation inside a fixed,
audited envelope.

---

## 4. Strengths, weaknesses, convergence/divergence

### Harness A — ProxyPilot mock2

**Strengths**
- **Strong isolation of untrusted code** — per-project container + default-deny nftables + declared/
  approved egress is a genuine security boundary, not advisory (`network-logic.js`, `egress-grants.js`).
- **Governance as verified verdict** — "done" is re-checked by the orchestrator (gate battery +
  integration-truthfulness + disclosure screening + negative-auth smoke), so the model can't
  self-approve blocked or faked work (`integration-enforcement.js`, `smoke.js`).
- **Honest termination + runaway safety** — typed `halt` with resolution options, no-progress
  breaker, soft budget pause; all learned from a real 118-refusal/$4.76 incident
  (`docs/agent-sdk-migration.md:73-85`).
- **Auditability & cost-truth** — hash-chained change records, per-call cost ledger, cache-aware
  pricing, downloadable deduped request log (`change-logic.js`, `quota-logic.js`, `request-log.js`).
- **Provider-agnostic** at the model layer with prompt caching (`model-client.js`).

**Weaknesses**
- **Re-implements a coding agent** — ~23K lines under `mock2/` including a bespoke loop, token
  accounting, retries, truncation; the team itself plans to delete much of it
  (`docs/agent-sdk-migration.md`).
- **Cold resume** — each resume rebuilds context from the tree rather than resuming a session, so
  it re-reads the repo cold (Phase 2 gap).
- **Coarse arg validation** — tool inputs are coerced defensively rather than validated against the
  declared JSON Schema before execution (`runner.js:1145-1156`); Zod is already a dependency.
- **Context injection is un-budgeted** — stub/capability/resume blocks are appended as full user
  turns with only a flat 12000-char tool-result cap; no priority-based pruning if they grow.
- **SDK runner weakens the sandbox** — in `BUILD_RUNNER=sdk`, tools run on the orchestrator host
  against a local checkout, guarded by a PreToolUse denylist that the docs explicitly call "a
  mitigation, not a sandbox" (`docs/agent-sdk-migration.md:451-458`).
- **Doc drift** — `.env.example` still documents the removed squid proxy (`egress.js:1-21`).

### Harness B — Copilot Chat / VS Code

**Strengths**
- **Mature prompt engineering** — TSX components with priority pruning + `flexGrow` + `TokenLimit`
  + cache breakpoints + 50% tool-result cap is a principled answer to large dynamic context `[SRC]`.
- **Open, uniform extensibility** — tools, participants, MCP, BYOK providers, custom instructions/
  modes/skills all via standard contribution points `[SRC]`.
- **Rich built-in toolset + subagents + dynamic tool discovery** (`ToolSearch`, `CoreRunSubagent`)
  `[SRC]`.
- **Standardized observability** — ATIF trajectory format + OTel telemetry for cross-fleet
  debugging/benchmarking `[SRC]`.
- **Low-friction interactive UX** — confirmation-gated execution keeps a human in the loop cheaply.

**Weaknesses**
- **No execution sandbox** — safety rests on confirmation + trust + content-exclusion; a misfired
  or prompt-injected tool call runs on the developer's machine `[INF]`.
- **No machine-verified acceptance** — correctness/"done" is the human reviewer's job; there's no
  built-in equivalent of mock2's gate-battery-must-be-green verdict.
- **Weaker cost/budget governance surfaced to source** — no per-project spend ledger/quota envelope
  visible in-repo (billing is server-side/proprietary) `[INF]`.
- **Proprietary primary backend** — the production model path and some inference services are not
  inspectable (out of scope by design) `[BLOG]`.

### Where they converge
- Provider matrix (Anthropic/OpenAI/Gemini/Ollama) and **prompt-cache breakpoints**.
- **Multi-agent/subagent** structure (mock2 stage slots + audit lane; Copilot `CoreRunSubagent`/
  `SearchSubagent`).
- A **structured, replayable per-turn trace** with token metrics.
- Tool schemas as **JSON Schema**, normalized before hitting the provider.

### Where they diverge
- **Trust/safety model:** sandbox-and-verify (unattended, untrusted code) vs. confirm-and-trust
  (interactive, trusted workspace) — the root divergence everything else follows from.
- **Termination:** verified typed-tool finish vs. no-more-tool-calls / human dialog.
- **Memory:** filesystem + audit chain vs. summarized conversation + cloud/embedding memory.
- **Extensibility:** closed governed appliance vs. open platform.

---

## 5. Recommendations for ProxyPilot

Prioritized, and split into quick wins vs. larger refactors. Each names the gap and the concrete
change; nothing here compromises the sandbox/governance model that is mock2's genuine advantage.

### Quick wins (low risk, days)

1. **Validate tool inputs against the declared JSON Schema before execution.** Today `executeTool`
   coerces with `String(call.input?.x)` (`runner.js:1145-1156`) while every tool already ships a
   precise `input_schema` (`runner-logic.js:23-214`) and **Zod is already a backend dependency**.
   Compile each `input_schema` to a validator and reject/feed-back malformed calls the same way
   halt/finish payloads are validated (`runner.js:700-836`). Borrows Copilot's
   `toolSchemaNormalizer` discipline; closes a validation gap. *(Quick win — additive.)*

2. **Fix the egress doc drift.** Update `.env.example:126-145` to describe the current Incus-NAT +
   nftables fence and drop the removed squid vars (`egress.js:1-21`). Stale security docs are a
   real hazard on an operator install. *(Quick win.)*

3. **Adopt a standard trajectory export format for the cycle-event log.** The data in
   `mock2_cycle_events` is already trajectory-shaped (`runner.js:658-668`); add an exporter that
   emits it in a documented format (Copilot's **ATIF** is a candidate, `trajectory/ARCHITECTURE.md`
   `[SRC]`) alongside the existing `request-log.js` artifact. Enables external replay/diffing/
   benchmarking of cycles without changing capture. *(Quick win — additive.)*

4. **Surface the constitution/gates/quota envelope in the operator UI as the "harness contract."**
   The governance layer is mock2's differentiator but is spread across framework versions, gates,
   and quotas; a single read-only "what governs this project" view (pinned constitution + gate
   battery + budget + approved egress grants) improves operability and audit. *(Quick win — read
   model only.)*

### Medium (weeks)

5. **Add priority-based budgeting to injected context blocks.** The stub-registry, capability-
   status, and resume-guidance turns are appended whole (`runner.js:467-507`) under only a flat
   12000-char tool-result cap. Borrow Copilot's **priority/pruning** idea (`@vscode/prompt-tsx`,
   `MAX_TOOL_RESPONSE_PCT` `[SRC]`): assign each injected block a priority and a token budget so a
   large registry can't crowd out the task or the constitution. You don't need TSX — a small
   priority-ordered budget allocator over the existing string blocks suffices. *(Medium.)*

6. **Close the cold-resume gap.** A resume currently rebuilds context from the tree and re-reads
   the repo cold (`runner.js:355-360`, §3.5). Either (a) proceed with SDK-migration **Phase 2**
   (persist a session id, resume it, `docs/agent-sdk-migration.md:363-365`), or (b) if staying on
   the hand-rolled runner, persist a compact "resume digest" (files touched, decisions, open
   threads) into `state/` and inject it, rather than making the model re-discover everything.
   *(Medium.)*

### Larger refactors (months; sequence deliberately)

7. **Continue the Claude Agent SDK migration — but keep it Anthropic-optional and keep the
   sandbox.** The migration is the right strategic call: delete the re-implemented loop/token-
   accounting/retry code and keep only the spec + governance layer (`docs/agent-sdk-migration.md:6-22`).
   Two cautions grounded in the repo's own notes: (i) the SDK path is **Anthropic-only** while the
   hand-rolled runner is provider-agnostic (`model-client.js`) — don't lose multi-provider support
   for the whole product; gate SDK adoption per-slot. (ii) the Phase-1 SDK runner **runs tools on
   the orchestrator host, not in the container**, which the docs correctly call "a mitigation, not
   a sandbox" (`docs/agent-sdk-migration.md:451-458`). **Do not ship `BUILD_RUNNER=sdk` as a
   default** until the SDK is sandboxed inside the fence (or an equivalent boundary), or you trade
   away mock2's single biggest advantage. Sequence: land Phase 3 (gates-as-hooks, enforce inside
   the loop) and a real SDK sandbox *before* Phase 5 (retire the hand-rolled loop).

8. **Move the gate battery inside the loop as hooks (SDK Phase 3).** Today gates re-run only after
   `finish` (`runner.js:754-1011`); enforcing them as `PreToolUse`/`PostToolUse` hooks
   (`runner-sdk-hooks.js` already seeds this, `docs/agent-sdk-migration.md:366-371`) gives block-on-
   red *during* the build rather than a post-hoc reject, cutting wasted turns. *(Larger; depends on
   #7.)*

### What NOT to borrow from Copilot

- **Do not adopt the confirm-and-trust safety model in place of the sandbox.** Copilot can run
  tools on the user's machine because the developer is present and trusts their workspace; mock2
  runs *untrusted generated code unattended*, so its container fence + verified-acceptance model is
  correct and must be preserved. Confirmation prompts are a complement at admin-decision points
  (mock2 already has these via `halt`/`request_authorization`), not a replacement for isolation.
- **Do not open the tool surface to arbitrary third-party/MCP tools inside the build fence** without
  extending the egress/authorization model to cover them. mock2's closed tool set is a feature: it
  keeps every model action inside the audited envelope. An open plugin surface (Copilot's strength
  as a platform) would reintroduce exactly the undeclared-capability risk the integration-
  truthfulness gate exists to catch (`integration-enforcement.js`).

### Gaps worth closing (summary)

- **Guardrails:** input-schema validation (#1); keep the SDK path sandboxed before defaulting (#7).
- **Observability:** standardized trajectory export (#3); operator-facing governance view (#4).
- **Context handling:** budgeted/priority-pruned context injection (#5); warm resume (#6).

---

### Appendix — primary evidence

**Harness A (this repo, under `admin/backend/src/mock2/` unless noted):** `runner.js` (loop,
tool execution, budget/termination), `runner-logic.js` (`RUNNER_TOOLS`, `classifyTurn`,
`buildRunnerSystemPrompt`, `MAX_TURNS`, soft-pause, no-progress breaker), `model-client.js`
(provider-agnostic transport + prompt caching), `runner-sdk.js` / `runner-sdk-hooks.js` (Claude
Agent SDK variant), `integration-enforcement.js` / `verification-logic.js` / `screening-logic.js`
/ `smoke.js` (verified-acceptance gates), `network-logic.js` / `firewall.js` / `egress-grants.js`
/ `egress.js` (sandbox + egress), `authz.js` / `project-logic.js` / `locks.js` (permissioning),
`quota-logic.js` / `quotas.js` (budget), `secrets.js` (repo `admin/backend/src/lib/`) /
`connectors.js` / `git-connectors.js` (secrets), `cycle-events.js` / `change-logic.js` /
`request-log.js` (observability), `db.js` / `migrations.js` / `framework.js` / `framework-seed/`
(state + framework), `docs/agent-sdk-migration.md` (roadmap + incident history).

**Harness B (`microsoft/vscode-copilot-chat`, archived read-only; active dev in
`microsoft/vscode`):** `src/extension/intents/node/toolCallingLoop.ts` + `agentIntent.ts` (loop)
`[SRC]`; `src/extension/prompts/node/agent/agentPrompt.tsx` + `@vscode/prompt-tsx` (prompt)
`[SRC]`; `src/extension/tools/common/{toolNames.ts, toolsRegistry.ts, toJsonSchema.ts,
toolSchemaNormalizer.ts, agentMemoryService.ts}` + `package.json` `contributes.languageModelTools`
(tools) `[SRC]`; `src/extension/byok/vscode-node/` (BYOK model providers) `[SRC]`;
`src/extension/mcp/vscode-node/` (MCP) `[SRC]`; `src/extension/trajectory/ARCHITECTURE.md` (ATIF
observability) `[SRC]`; `src/extension/{conversation,workspaceChunkSearch,ignore}/` (state/
context/exclusion) `[SRC]`. Anchor blog:
`https://code.visualstudio.com/blogs/2026/05/15/agent-harnesses-github-copilot-vscode` `[BLOG]`
(returns 403 to automated fetch; blog claims rest on search snippets — verify exact wording before
quoting). Autopilot constants (`MAX_AUTOPILOT_ITERATIONS=5`, `MAX_AUTOPILOT_RETRIES=3`, ~1.5×/
cap-200) and `MAX_TOOL_RESPONSE_PCT=0.5` read via DeepWiki/WebFetch `[DW]`, not byte-verified.
