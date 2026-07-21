# The ProxyPilot Build Harness — complete step-by-step guide

This is the operator's map of the entire app-generation pipeline: every step
from the first design-chat message to a deployed, smoke-tested app — which
model serves it, at what effort, with what prompt, what it costs, and what
deterministic machinery verifies it. It exists so the harness can be
**evaluated**, not just used: every consequential prompt instruction is quoted
verbatim, and every model/effort resolution chain is spelled out with its
defaults and overrides.

The shipped copy of this document lives with the backend code and updates with
it. Edits made on this page are stored separately and win until you reset —
so an upgraded install always has an accurate description one tap away.

Companion references: the condensed step table lives in
`docs/core/harness-steps.md`; slot assignment is on **Projects → Connectors**;
per-lane tuning is on the **Routing** tab of the Admin queue.

**This page's Controls tab is live**: every step listed here has a
model/effort/thinking control that writes the **step-override layer** — the
topmost precedence (step override → lane tuning → env override →
slot/shipped default), applied on the step's very next model call. A rejected
override model falls back to the step's default on the same call and logs it.
Each step's **system prompt** is shown on its row and is editable: an
override serves verbatim on the next call, with `{{PLACEHOLDER}}` markers
(design system, constitution, project name, …) substituted at call time —
keep the markers to keep the dynamic content. Steps whose prompt varies by
mode note it; an override replaces every variant. The render continuation
shares the full render's prompt.

**Output budgets were removed** (operator decision, 2026-07): per-step
output-token caps no longer exist. Every turn runs free to the serving
model's own maximum output (128k where the model is known to accept it,
64k otherwise), and the only spend caps are the **platform / project /
people quotas** — never per step or per model. `MOCK2_RUNNER_MAX_TOKENS`
remains available as an explicit operator cap on runner turns; the safety
breakers (soft pause, turn backstop, no-progress breaker) are unchanged.
Budget figures quoted in the step sections below describe the historical
shipped caps and now read as sizing context only.

**Shipped per-step defaults were raised** (operator decision, 2026-07): the
concept/define/utility steps now default to **Claude Opus 4.8 at high
effort** (concept chat, design-doc adjust, design-token extraction,
chat→prompt distill; inventory extraction runs Opus at **medium**), the rule
audit, tweak/continuation, pre-pass/split-probe, Explain, checklist
post-pass, and Ask default to **high** effort, and the mockup render keeps
its Fable 5 deep/iteration split. The Controls tab shows the live resolved
values; effort/model figures in the step sections below reflect the original
shipped behavior.

---

## The pipeline at a glance

Four stages. Model calls (the paid half) are marked 💰; everything else is
deterministic code (the free half).

| Stage | What happens | Model-bearing steps |
| --- | --- | --- |
| **1 · Concept** | Design-partner chat → interactive HTML mockup → design approval → inventory + design-token extraction | 💰 chat turn · mockup render (full / tweak / screen / continuation) · design-doc adjust · inventory extraction · token extraction |
| **2 · Define** | Rule audit/interview against the constitution (full builds); MVP/quick skip it and inherit the CRUD rules floor | 💰 rule audit (which also classifies the task) |
| **3 · Build** | The build runner edits code in a fenced container through tools, runs gates, finishes | 💰 quick pre-pass · split probe · chat distill · **the runner loop (80–90% of all cost)** |
| **4 · Finish / verify / deploy** | Acceptance verdict, over-claim check, action parity, gate battery, tripwire, deploy, smoke — all deterministic | none — this half is free |
| **Post-build / on demand** | Checklist post-pass, design review, Explain, Ask, Consult | 💰 all five |

Every model call in the pipeline goes through one client, `callModelTurn`
(`src/mock2/model-client.js`): provider-agnostic, one automatic retry on
transient errors (429/5xx/network — never timeouts, never 4xx), a timeout
that scales with the requested output (`max(120s, maxTokens × 50ms)`),
streaming for heavy requests, prompt-cache breakpoints on the system prompt
and last message, and per-call usage accounting (input / output / cache-read /
cache-write tokens) that feeds the spend ledger.

---

## How a step's model, effort, and thinking are resolved

Four layers, later wins:

1. **Slot** — the admin pins one connector+model per slot on Projects →
   Connectors. This is the base identity of each lane.
2. **Hard defaults / env overrides** — per-step constants, each overridable:
   `MOCK2_FAST_MODEL` (fast code model, default `claude-sonnet-5`; `off`
   disables), `MOCK2_MOCKUP_MODEL` (mockup render, default `claude-fable-5`;
   literal `slot` restores the slot model), `MOCK2_PREPASS_MODEL` (classifier
   calls, default `claude-haiku-4-5-20251001`), `MOCK2_REVIEW_MODEL` (design
   review, falls back to the build slot), `MOCK2_QUICK_EFFORT` /
   `MOCK2_MVP_EFFORT` (fast-lane efforts), `MOCK2_RUNNER_MAX_TOKENS`
   (per-turn output ceiling, default 64000), `MOCK2_ESCALATE_MODEL`
   (escalation fallback), `MOCK2_ROUTING` (`on|shadow|off`), `MOCK2_THINKING`
   (global thinking env fallback). The dashboard's **fast code model**
   setting overlays `MOCK2_FAST_MODEL` and therefore wins over the env var.
3. **Routing** — full builds classify the task (kind + difficulty, see
   Routing and classifiers below) and map it to model + effort through the
   admin-editable routing-rule knowledge base, including escalation on
   retry/difficulty-5. MVP/quick builds use fixed fast decisions instead.
4. **Lane tuning** — the operator's last word (Routing tab): per-lane
   `{model, effort, thinking}` overrides for the six lanes `build`, `mvp`
   (governs both MVP and Quick), `audit`, `chat`, `mockup`, `ask`. A separate
   **global thinking switch** (`off`) overlays thinking-off onto every lane at
   read time without touching the stored per-lane values.

Effort scale: `low / medium / high / xhigh / max`. Thinking: adaptive
(`{type:'adaptive'}`) is only sent to models that support it
(Opus 4.6–4.8, Sonnet 4.6/5, Fable/Mythos); `thinking:'off'` *omits* the
parameter entirely (sending `{type:'disabled'}` 400s on Fable 5); `xhigh`
effort is clamped to `high` on models that don't take it. Unknown models get
neither parameter — the client never sends something that could 400.

**Fallback guards.** The mockup render has a preferred-model fallback: if the
env-preferred model is rejected with an error matching `/model/i`, the call
retries once on the assigned slot model and posts a note. Storage lives in
`mock2_settings` (`lane_tuning` JSON, `global_thinking`, `fast_code_model`).

---

## The model slots

The code defines **seven** slots (`MODEL_SLOTS`, `src/mock2/connector-logic.js`);
one connector+model is pinned per slot, and a connector must advertise the
slot's required capability — a chat-only model structurally cannot be the
build runner. Recommended defaults are what the UI suggests and the estimator
prices when a slot is unassigned; they are suggestions, never silently applied.

| Slot | Serves | Required capability | Recommended default |
| --- | --- | --- | --- |
| `concept_chat` | Design partner chat, design-doc adjust, inventory + token extraction | chat | claude-opus-4-8 |
| `mockup` | Mockup renders (the env-preferred model sits on top) | chat | claude-opus-4-8 |
| `audit` | Rule interview (+ the consult's connector) | chat | **claude-fable-5** — the one deliberately Fable-5-defaulted lane |
| `classifier` | Classification surface (the pipeline's classifier calls currently ride `MOCK2_PREPASS_MODEL` on the build connector) | classify | claude-haiku-4-5 |
| `build_runner` | The build loop, Ask, design review, checklist post-pass connector | agentic_build | claude-opus-4-8 |
| `summary` | Explain cards | summarize | claude-haiku-4-5 |
| `remediation` | Remediation surface (outside the build pipeline) | agentic_build | claude-opus-4-8 |

The five slots the pipeline's step map references (`concept_chat`, `mockup`,
`audit`, `build_runner`, `summary`) are the ones its model-bearing steps
resolve through. The default model id is never hardcoded in the runner — every
call is made with the model string the admin assigned (or the layer that
overrode it).

---

## Stage 1 — Concept (design partner + mockups)

Two slots serve the whole stage: `concept_chat` and `mockup`. Every turn
checks both are ready, takes the checkout lock, and pre-checks a buffered cost
envelope against the monthly quota (turn ≈ chat 6k-in/1.5k-out + mockup
12k-in/9k-out; refusal creates a terminal `refused_quota` cycle). All
container writes go to fixed paths chosen by the orchestrator — the model
never names a file path, and no code path writes backend code or rules during
Concept.

### 1. Concept chat turn 💰

- **Trigger:** every design-chat message (`POST /projects/:id/chat`).
- **Model:** `concept_chat` slot · lane `chat` tuning applies · no built-in
  effort (adaptive thinking where supported) · **16k** max output ·
  streaming with a live partial bubble.
- **Prompt:** the system prompt frames the persona — *"You are the Mock2
  Concept-stage design partner. You help a Builder — who may be non-technical
  — turn an app idea into a clear, interactive mockup."* Its most consequential
  instructions:
  - Scope economy: *"COST-AWARE REVISIONS — pick the smallest scope that truly
    fits: scope "tweak" for a SMALL change (copy/labels, a color, one
    element)… scope "screen" when ONE screen changes substantially… scope
    "full" for changes across screens… When unsure, "full"."*
  - Brief quality: *"THE BRIEF YOU WRITE IS THE DESIGN'S CEILING — extrapolate
    it like a multi-step domain expert on the Builder's behalf"* — simple asks
    get expanded via a 5-point checklist (surfaces & audiences, operating
    conditions, *"Hard states the mockup must PROVE — empty, overloaded (12+
    rows still scan), over-threshold/escalated, mid-action, a validation slip
    handled gracefully"*, domain rules, anti-patterns), written *"as DIRECTIVES
    ("the eye must land first on whoever waited longest"), never as questions."*
  - Structural limits: *"You cannot write code, files, backend logic, or
    rules… The mockup is non-functional."* And: *"THE BUILDER OWNS THE LOOK:
    when the Builder explicitly specifies colors, tokens, a theme… their spec
    OVERRIDES the locked design system"*.
- **Tool:** exactly one — `generate_mockup {brief, scope: tweak|screen|full,
  screen}`. Plan mode gets **no tools**, so a render is structurally
  impossible there. The orchestrator (not the model) then drives the mockup
  slot. Unknown scope defaults to `full`.
- **Context:** the whole chat history is replayed (user/assistant only); the
  6 most recent image attachments ride as real images, older ones become
  cache-stable placeholders.

### 2. Mockup render — full 💰

- **Trigger:** `generate_mockup` scope `full`, or any smaller scope falling
  back.
- **Model:** `mockupRenderModel` = `MOCK2_MOCKUP_MODEL` env (default
  **`claude-fable-5`**, `'slot'` restores the slot model). Deep renders
  (first render, explore turn, restyle) run at **effort high + adaptive
  thinking**, bypassing lane defaults — *"low-effort/thinking-off 'pure
  transcription' produced exactly the flat, junior first designs the operator
  flagged."* On-theme iterations run at **low / thinking off**, with `mockup`
  lane tuning as the last word.
- **Output budget:** dynamic — `min(64000, max(40000, ceil(len/3.2 × 1.35)
  + 6000))` sized from the current document so a revision can re-emit the
  whole file; 15-minute timeout; first renders stream into the live preview
  every 8 seconds.
- **Prompt:** the system prompt is the design constitution. Highlights:
  - *"Output ONLY the HTML document, starting with `<!doctype html>`…
    A SINGLE file: all CSS in a `<style>` tag and all JS inline. No external
    hosts, fonts, scripts, stylesheets, or images."*
  - Token discipline: define values once as CSS custom properties, route
    every style through `var(--…)`; the base token stylesheet + theme toggle
    are injected verbatim and *"Never bypass var(--…) and never hard-code a
    hex color outside the ==tokens== blocks."*
  - *"Mobile-first: every screen renders cleanly in a single column at
    360–375px… Tappable controls are at least 44×44px."*
  - Screen contract: *"wrap every distinct screen/view in `<section
    data-screen="Screen Name">`… One section per SCREEN, never per variant"*
    (no "X (Dark)" sections — themes are toggles); demo-only pressed/active
    states must carry `data-demo-state`.
  - Craft rules with teeth: *"NEVER use emoji as UI iconography — the loudest
    'AI mockup' tell. Draw small inline SVG icons"*; one dominant primary
    action per view; *"PROVE IT WITH THE HARD STATES"*; realistic sample
    density (*"a timesheet shows a full period of days…, not two placeholder
    rows"*); render-on-load (first screen visible before JS runs).
  - Precedence: *"the Builder's explicit spec wins, everywhere, including on
    revision turns."*
- **Fallbacks, in order:** timeout → one retry; preferred model rejected with
  an `/model/i` error → one retry on the slot model (with a visible note);
  stopped at max tokens → continuation (step 5); implausible output (must
  open **and** close the document) → one retry at ≥64k budget → honest
  failure note, previous mockup untouched.
- **After save:** written to `state/mockups/mk-<id>.html` + `current.html`,
  git-checkpointed, and the deterministic mockup-checks battery (below) posts
  an advisory note.

### 3. Mockup tweak 💰

- **Trigger:** scope `tweak` with an existing mockup (readable up to the 400k
  save cap, so every saved mockup is tweakable). Exists because *"a one-line
  copy change used to re-output the ENTIRE document — output tokens dominate
  render cost."*
- **Model:** same render model · **effort low / thinking off** ·
  no lane tuning on this path.
- **Prompt:** search/replace contract — *"Output ONLY edit blocks… Each
  SEARCH must be copied EXACTLY from the current file (whitespace included)
  and long enough to be UNIQUE"*; at most 12 blocks, several small blocks
  preferred over one large; `FULL_RERENDER` is framed as a **last resort**
  reserved for new screens or cross-screen restructuring.
- **Escalation ladder (2026-07):** a miss no longer jumps straight to a full
  re-render. Edit application is whitespace-tolerant (runs of whitespace
  match any whitespace; uniqueness still required — ambiguity always fails).
  A failed application gets **one corrective retry** in the same
  conversation with the exact miss named ("edit 2: search text not found").
  If the retry still fails and every failed edit localizes inside ONE
  `<section data-screen>`, the fallback is that **screen's re-render**, not
  the document. Only cross-screen or shared-CSS targets (or an explicit
  `FULL_RERENDER` from the model) reach the full renderer — the slow,
  drift-prone outcome the ladder exists to avoid. A half-applied mockup
  still can never ship.

### 4. Mockup single-screen re-render 💰

- **Trigger:** scope `screen` + a screen name that matches a
  `<section data-screen>` in the current document.
- **Model:** render model · **effort high / adaptive thinking / 20k** output.
- **Prompt:** *"You redesign ONE screen… Output ONLY the replacement
  `<section>` element… Keep the opening tag's attributes EXACTLY as they are
  (the page's navigation depends on them)."* Same brief-wins precedence; the
  full document rides along as context.
- **Fallback:** unknown screen / unusable reply / failed splice → full-render
  fallback with a note.

### 5. Render continuation 💰

- **Trigger:** a full render stops at `max_tokens` (assistant prefill is not
  used — the render model rejects it).
- **Model:** whatever model served the truncated render · **low / off / 30k
  per hop, at most 2 hops**. Images are not re-sent.
- **Prompt:** *"CONTINUE the HTML document EXACTLY from the cut point — output
  ONLY the remaining characters… For alignment, the document currently ends
  with: <last 300 chars>"*.
- **Stitching is defensive:** fences stripped; a continuation containing its
  own `<!doctype` replaces the partial; otherwise the longest 12–4000-char
  overlap is removed before appending. Still truncated after 2 hops → the
  advice is screen-scoped renders.

### 6. Design-doc AI adjust 💰

- **Trigger:** admin asks the AI to adjust a design preset ("make the primary
  warmer") on Design specs.
- **Model:** `concept_chat` slot · `chat` lane tuning · 4k output. The only
  concept-stage call with **no ledger entry** (stateless, no cycle).
- **Prompt:** strict-JSON token-set contract; *"Change ONLY what the
  instruction asks, plus whatever minimal changes keep text readable (AA
  contrast…). Return the FULL token set."*
- **Safety:** output is re-validated through the strict design-doc parser
  (hex/size/font/shadow grammars) — *the model cannot inject CSS*. Nothing is
  saved here; the operator reviews and saves it as a custom preset.

### 7. Inventory extraction 💰 (design approval — sign-off #1)

- **Trigger:** the Builder approves the design. This is Stage 1's only exit.
- **Model:** `concept_chat` slot directly (no lane tuning) · **thinking off**
  (adaptive thinking ate the budget and truncated JSON mid-value) · **32k**
  output · streams internally.
- **Prompt:** *"You extract a structured DESIGN INVENTORY from an approved
  product mockup. The inventory — not the mockup's markup — becomes the
  specification the app is built against."* Two rules carry postmortem
  weight:
  - *"MUTATION COVERAGE: … after extracting what IS shown, ADD the implied
    mutation actions for every record a user can create — edit, delete/
    archive, change status — each marked `"inferred": true`… An app whose
    inventory has create actions but no edit/delete actions produced permanent
    workflow dead ends in production; do not repeat that."*
  - *"DEMONSTRATED ≠ DEFAULT: … Elements the mockup marks with
    `data-demo-state` are demonstrations — record them in "states" but NEVER
    as the resting state."* Every screen must declare `default_state`.
- **Retry:** parse failure gets one automatic re-extraction; a second failure
  fails the approval honestly ("The design is not approved — try approving
  again").
- **Deterministic post-processing (free):** `mergeVariantScreens` folds
  "(Dark)/(Empty)/(Loading)" pseudo-screens into states on the base screen;
  `completeInventoryCrud` appends inferred Edit/Delete/Change-status actions
  for any creatable noun that lacks them; `lintInventory` posts advisory
  warnings (creates-without-edit, missing default states, display-only status
  fields). The human approves with eyes open; nothing blocks.
- **Then:** inventory written to `state/inventory.json`, change record
  hash-chained, screen plan seeded, lock released, and (by default) the
  initial MVP build auto-starts.

### 8. Design-token extraction 💰

- **Trigger:** same approval run, right after the inventory. Best-effort —
  failure logs a warning and approval proceeds (build falls back to framework
  defaults).
- **Model:** `concept_chat` slot · thinking off · 8k output.
- **Prompt:** *"You extract the DESIGN TOKENS from an approved product mockup
  so the built app can reproduce its exact look… Read the ACTUAL values from
  the mockup's CSS."*
- **Safety:** the parser never fails — every value is re-validated
  (`#RRGGBB`-only hexes, size/font/shadow grammars, invalid values fall back
  to defaults) and rendered to `state/design-tokens.json` + a ready
  `state/design.css` the build runner is ordered to reproduce.

### The mockup-checks battery (free, advisory)

Runs after **every** saved render — pure regex/string analysis plus WCAG
math; findings ride the save note ("Design checks flagged N item(s)…
Advisory — ask for a revision if any matter"): legacy-palette ban, rogue hex
literals outside the token blocks, both themes + working toggle, data-bound
bars (`--fill:NN%`, no identical bars), canonical list rows (one metric, one
known stage badge), detail screens with all three bands and exactly one
primary action, SVG labeling, and computed AA contrast (≥4.5:1) for both
themes from the tokens the document actually ships. The prompt CSS, the
design-system markdown, and these checks all derive from one source file so
they can never drift apart.

---

## Stage 2 — Define (the rule interview)

### The rule audit 💰 (full builds only)

- **Trigger:** every full-mode Build press, after guards (active project,
  approved design, both slots ready, framework pinned, quota — refusal is a
  terminal `refused_quota` define cycle).
- **Model:** `audit` slot (the deliberately Fable-5-recommended lane) ·
  effort **medium** · `audit` lane tuning applies · **16k** output · no tools.
- **Reads:** the approved inventory (*"the mockup is discarded on approval —
  the inventory, not pixels, is what the audit reads"*), existing
  `state/rules.md`, and the pinned constitution injected verbatim
  (*"binding — this is what a framework_deviation is measured against"*).
- **Prompt:** *"You are the Mock2 build AUDITOR… you surface ONLY the
  questions that must be answered first."* The format contract separates:
  - **Editor questions** (plain, warm language, 2–4 tappable choices):
    `domain_question`, `rule_contradiction`, `rule_gap`.
  - **Admin questions**: `framework_deviation` — *"Never phrase this as a
    choice for the editor… A project's answer never changes the framework."*
  - Restraint is explicit: *"Ask as FEW questions as possible… Never invent
    ambiguity… An empty "questions" array is the correct answer when nothing
    blocks the build."*
- **The classifier rides along (zero extra cost):** the same JSON reply
  carries `task: { kind: chore|bugfix|feature|refactor|question, difficulty:
  1–5 }` — *"used to pick the model/effort for the build — be honest, not
  flattering."* Question routing is derived from the kind by code, **never
  trusted from the model** (a mis-routed deviation would silently change the
  framework).
- **Answers become rules:** each editor answer appends an anchored section to
  `state/rules.md` (git-checkpointed, hash-chained change record) — sign-off
  #2. The build resumes only when zero editor questions and zero admin items
  remain open, both derived from open rows, never a stored flag. Admin
  deviation decisions are folded into the build instruction as authoritative:
  *"APPROVED — you MUST implement this even though it deviates from the
  constitution"* / *"DENIED — do NOT implement this; build the compliant
  remainder instead."*

### The MVP/quick skip + the CRUD rules floor (free)

Fast modes insert a zero-cost define cycle and go straight to build, but
inherit the **CRUD rules pack** as a binding floor — 8 rules born from the
project-32 postmortem (the skipped interview shipped permanent workflow dead
ends): every user-creatable record editable/deletable; status fields fully
cyclable (*"a status that can be shown but never reached or left is a
defect"*); mutations reflect without refresh; confirm-guarded deletes;
screens load in resting state with no pre-applied filters; user stays in
context after a mutation; designed empty states; sane default permissions.
Injected into the runner's task turn: *"the STANDARD CRUD RULES below are
BINDING as the floor. Where the approved inventory or the instruction
explicitly contradicts one, the inventory/instruction wins — note the
deviation in your summary."*

Component suggestions at define time are pure code (zero tokens): inventory
capabilities matched against the component catalog; the deterministic
pre-install of confirmed components runs before the build and a failed
install blocks it.

---

## Routing and classifiers

### The task classifier

Not a separate call and not a heuristic — it piggybacks on the define audit
(above). MVP builds skip classification (fixed `feature`/difficulty-null);
resumes recover the classification from the most recent routed build cycle.

### The routing decision (full builds)

`decideRouting` maps the classification through the admin-editable
knowledge base (`mock2_routing_rules`, seeded so a fresh install behaves
exactly as before — no model overrides, no escalation models):

- **Rung 0 model:** the rule's model override; else — when difficulty ≤ 3 and
  the rule has no override — the **fast code model** (`claude-sonnet-5`
  default; dashboard setting → `MOCK2_FAST_MODEL` env → default); else the
  `build_runner` slot model. Rationale: *"routine code-writing does not need
  the top-tier model — the deep-reasoning spend belongs to the audit, hard
  tasks, and escalations."*
- **Rung 1 (escalation):** the rule's escalation model (else
  `MOCK2_ESCALATE_MODEL`), triggered by `priorAttempts ≥ 1 || difficulty === 5`
  — *"don't waste a cheap attempt on a task the audit already called very
  hard."* Escalation feeds on **ground truth only**: prior cycles of the same
  request that ended failed/awaiting_admin/interrupted/abandoned — never a
  model's self-report. No escalation model configured → stay rung 0 (never
  invent a model id).
- **Effort:** rule's effort → else difficulty mapping (≤2 medium, 3 high,
  4–5 xhigh) → else the build lane default **high**. Default per-kind efforts:
  chore medium, bugfix high, feature high, refactor xhigh, question medium.
- Every decision is stamped on the cycle (`routing_json`), event-logged
  (`model=… effort=… rung=… kind=…` — this is where you verify an override
  took), and its terminal outcome recorded append-only in
  `mock2_routing_outcomes` for the operator scoreboard. `MOCK2_ROUTING=shadow`
  records without applying; `off` skips.

**MVP/quick override the knowledge base** with fixed fast decisions: MVP =
fast model at effort **high** (`MOCK2_MVP_EFFORT`; started at low, "shipped
apps read as too basic"); Quick = fast model at effort **medium**
(`MOCK2_QUICK_EFFORT`; high cost $6.96 for "a simple frontend change").
Lane tuning (`mvp` entry governs both) remains the last word.

### The quick-lane pre-pass 💰

- **Trigger:** fresh Quick cycles, unless `MOCK2_PREPASS=off`.
- **Model:** `MOCK2_PREPASS_MODEL` → **`claude-haiku-4-5-20251001`** · low /
  off / **900** output · no tools · on the build connector's key.
- **Prompt:** *"You size and brief incoming build requests for a web-app
  build system. Reply with STRICT JSON only."* The scope rubric, verbatim:
  - *"simple": one screen/element, one behavior — a button, a label, one
    endpoint tweak.*
  - *"multi_part": several coordinated changes — a screen plus its API, or
    2-4 related elements.*
  - *"feature_scale": a whole page/feature/redesign — would take a person a
    session, not minutes.*
  Split rule: split **only** feature-scale asks that decompose into 2–4
  sequential parts *"EACH independently buildable, deployable, and checkable
  by a human (part 1 must be useful before part 2 exists)."* And the
  domain-expert clause: *"'domain_expectations' is where you think like a
  DOMAIN EXPERT, not a coder: what would a professional in this domain assume
  the feature obviously includes even though the request doesn't spell it
  out?"*
- **Effects:** multi_part/feature_scale bump the lane effort one notch; the
  working brief rides the task turn *subordinately* ("the request above is
  authoritative; ignore any note that contradicts it"); feature-scale posts a
  heads-up suggesting Build MVP; domain expectations honor the project's
  suggest mode (off/ask/auto) and confirmed extras become **binding**
  deliverables. Everything fails open — a dead pre-pass changes nothing.

### The split probe and chat distill 💰

- **Split probe:** before a quick update starts, the same pre-pass prompt is
  raced against a **9-second timeout**; a returned split feeds the "build all
  as one / in ordered groups" card. Per-group instructions are binding
  (*"Scope is BINDING to this part"*), and later groups must leave *"a
  visibly disabled control with a 'Not built yet' badge, never a dead
  element."*
- **Chat distill:** the "Build this as a Quick update" button converts a chat
  message into one well-formed instruction (same model, 1.6k output, 25s
  timeout): *"Preserve EVERY concrete deliverable the message contains…
  Do NOT invent anything the message does not contain. Output ONLY the
  instruction text."*

---

## Stage 3 — Build (the runner loop)

This is where 80–90% of a request's cost lives, and cost scales with **how
many turns the runner needs** — not primarily with per-token price.

### Cycle start (deterministic)

Stale one-time authorizations expire → the cycle attaches to its umbrella
request (one request = the operator's ask; audit + build + resumes + consults
are its cost segments) → build mode resolves (resumes stay in their mode) →
routing stamps → a no-op refusal backstop (repeated verified-no-op cycles for
the same instruction refuse to start another) → framework version pinned →
quota estimate checked (refusal is terminal) → checkout lock acquired → the
**pinned** gate scripts (this version's, not latest) are copied into the
container → the harness runs the cycle in the background.

### The runner system prompt (the contract)

Role, verbatim: *"You are the Mock2 build runner. You make one small,
targeted change to a project's code, verify it against a fixed gate battery,
and stop. You never approve your own work and you never release to production
— a human reviewer gates production."* It works *"inside a sealed,
network-fenced container"* on the standard TypeScript/Express/Drizzle/Zod
scaffold; how the app runs is declared in `mock2.yaml`; the only egress is a
filtering proxy.

What it reads and must honor:

- **Design fidelity (binding):** `state/design-tokens.json` + `design.css` —
  *"The app MUST reproduce that look, not a generic default."* When
  `state/mockups/current.html` exists it is *"the visual CONTRACT beyond the
  tokens."* Journeys drive the layout: frequent journeys get the prominent
  navigation.
- **Honesty blocks:** *"FEATURE-COMPLETENESS HONESTY (binding): anything from
  the inventory/instruction you do NOT implement in this cycle must be VISIBLY
  marked in the UI — a disabled control with a small 'Not built yet' badge —
  never a dead button, a silently missing element, or a fake success path."*
  Plus live-database hygiene (fixture accounts on `@fixture.invalid`, never
  consume the first-admin bootstrap), no sample data in the live app, error
  message quality, time handling, and design craft.
- **Constitution:** pinned and binding, with admin-approved deviations as the
  only override.
- **The working discipline:** write `state/acceptance.json` FIRST; for a bug
  fix *"reproduce first: write the defect-tagged regression test so it FAILS
  against the current behavior, run run_gates to record the red, then fix and
  drive it green — finish is rejected without that observed red."* Make the
  smallest change; *"when a gate fires falsely, propose the gate/allowlist
  change as a reviewed act — NEVER reword or restructure product code just to
  slip past a detector pattern."* Call `finish` only when every gate is green
  — with a summary that *"must describe THIS cycle's diff only"*,
  human-runnable acceptance checks ("as <role>, do X, expect Y"), and
  assumptions split into verified (file named) vs assumed. Real integrations
  the fence can't verify live end in `pending_verification`, *"WITHOUT falsely
  claiming succeeded"* — *"Do NOT fake a green connection to force finish."*
  If stuck: *"Do NOT keep replying without calling a tool… If you are stuck,
  halt"* — with 2–4 typed options.

MVP builds override with a speed contract (no acceptance.json, no gate
battery — the deploy build + health check are the backstop; *"SPEED IS THE
POINT"*, target well under 40 turns). Quick updates: *"MINIMAL DIFF IS THE
CONTRACT"*, never touch auth wiring, target well under 15 turns.

### The tools

| Tool | What it does |
| --- | --- |
| `exec_in_container` | Non-interactive shell in the fenced container; stdout/stderr + exit code |
| `read_file` / `write_file` | Read/write files under `/srv/app` (writes are checkpointed by the orchestrator) |
| `get_component` / `materialize_component` | Inspect a library component / have the platform write its files byte-exact (sha256-verified — contents never transit model context) |
| `run_gates` | Run the pinned gate battery mid-loop; per-gate pass/fail (removed entirely, not stubbed, for fast modes) |
| `finish` | Declare complete-and-working: summary + acceptance checks + optional machine-executed `acceptance_ids` + verified/assumed assumptions |
| `pending_verification` | Same payload — the honest terminal for real integrations awaiting a live external check |
| `halt` | Honest non-success stop with 2–4 typed options (grant_authorization / expand_scope / run_dependency_first / override_rule / abandon) |
| `request_authorization` | Scoped one-time privileged operation; ends the cycle awaiting an admin; single-use on resume |

Web search is a server-side tool only when `MOCK2_RUNNER_WEB_SEARCH=on` on
Anthropic connectors — the fence stays sealed.

### Budgets, limits, breakers

- Per-turn output: **the model's own maximum** (128k on models known to
  accept it, 64k otherwise); `MOCK2_RUNNER_MAX_TOKENS` is an explicit
  operator cap (floor 1024) when set.
- Per-tool-result: 200k chars (`MOCK2_MAX_TOOL_RESULT_CHARS`).
- Soft pause (the primary stop): 1M fresh tokens or 45 minutes per run
  (`MOCK2_SOFT_PAUSE_TOKENS` / `MOCK2_SOFT_PAUSE_MINUTES`; dollar mode via
  `MOCK2_BUDGET_DOLLARS`) → checkpoint + resumable `interrupted`.
- Hard backstop: 300 turns — checkpoints and pauses, never fails.
- No-progress breaker: repeated no-tool/repeated-output/no-state-change turns
  → auto-halt as blocked.
- Transient model failures: 2 retries, then escalate to the admin.
- Mid-cycle quota buffer stop against the live ledger.

Every turn's usage is priced cache-aware and written to the ledger and to the
cycle's canonical usage columns; the same numbers ride each transcript event,
so the per-cycle transcript doubles as a per-step spend trail.

### Halts and resumes

A halt checkpoints WIP, stamps the reason + options on the cycle, lands
`awaiting_admin`, releases the lock, raises a needs-attention item, and may
auto-fire one bounded consult (off by default). Resume starts a fresh cycle
from the checkpoint with the operator's message / chosen option / granted
one-time authorizations (consumed single-use) / gate waivers injected.

### The two engines

The harness abstraction (`harness.js`) makes the loop pluggable:
**ProxyPilotHarness** is an adapter over the hand-rolled loop above —
byte-for-byte the pre-abstraction behavior. **ClaudeHarness** runs the Claude
Agent SDK loop in the orchestrator process against a tar-synced local
checkout (API key never enters the container), then syncs back and runs the
**identical** gate battery, checkpoint, deploy, and smoke tail. Both write
the same normalized event records (`task / ai_message / tool_call /
tool_result / gate / checkpoint / deploy / halt / smoke / …`) into the
per-cycle transcript, so the frontend needs no engine-specific rendering.

---

## The free half — deterministic finish, verification, deploy

Zero model cost. In order, when the runner calls `finish` /
`pending_verification`:

1. **Own-diff check** — the orchestrator reads `git diff` itself; *"a model
   claim of 'nothing changed' is never trusted."*
2. **Acceptance verdict** — built against an observed Goodhart failure
   ("done" defined as a proxy). Valid `state/acceptance.json` required
   (bugfixes need a defect tag + regression test), and a bug-fix cycle must
   have shown the test gate **red inside this cycle** — *"'The code looks
   correct' is not acceptance."* Exceptions: a verified empty product-code
   diff, or an admin-granted reproduce-first waiver (applied here, never
   inferred from narration). MVP/quick skip the strict verdict.
3. **Summary over-claim check** — path-like claims in the finish summary must
   match the verified changed files; naming files the cycle didn't change
   rejects the finish.
4. **Action-parity gate** — every mutation action in the inventory must
   appear in the UI source (working control or a visible "Not built yet"
   badge — a label found nowhere is silently missing). Rejects finish once;
   a second finish proceeds with a loud operator warning instead of looping.
5. **Gate battery** — the pinned scripts run in-container (300s each, exit
   codes captured); any red gate rejects the finish with the formatted
   battery. Fast modes run zero gates by design; zero gates on a full build
   is vacuously green but loudly warned.
6. **Integration-truthfulness gate** — deterministic source analysis for
   fabricated data, no-I/O tests, undeclared egress; fail-closed (even an
   analyzer crash blocks); admin modes can downgrade, always logged, never a
   silent bypass.
7. **Checkpoint + change record** — DB snapshot, commit, diff-stat,
   hash-chained change record mirrored into `state/changes/`.
8. **Anomaly tripwire** — a bug-fix that closed under 15% of its token
   estimate with no observed red test → **deploy held** (cycle still
   succeeds; the operator releases via Deploy; the previous deploy keeps
   serving).
9. **Deploy** — declared egress synced (new hosts pend admin approval) →
   deps → migrate → build → systemd swap to the `mock2.yaml run:` contract →
   restart → health check. Failure is retryable without model calls.
10. **Smoke gate** — the HTTP layer always runs (non-5xx + negative-auth: a
    spoofed admin header must not get a 2xx). Browser (Playwright over
    `state/ui-checks.json`, per-role fixture logins, fail on any console
    error) and read-only DB (full migration chain dry-run on a scratch
    database) connectors escalate by the commit's own changed-file list —
    a backend-only change invokes zero connectors; every run/skip is
    reasoned. `acceptance_ids` from the finish call force the browser
    connector on — an id with no defined check is a hard smoke failure.
11. **Terminal** — outstanding live checks → `awaiting_user` with a derived
    operator verification checklist; otherwise `succeeded` and the request
    closes. Reported outcomes: succeeded 0 · pending-operator-verification 70
    · blocked-deviation 71 · gate-rejected 72 · migration-analysis-incomplete
    73 · resolution-ineffective 74.

---

## Post-build and on-demand passes

| Pass | Trigger | Model default | effort / thinking / max out | Tools | Spend |
| --- | --- | --- | --- | --- | --- |
| Checklist post-pass | request close (succeeded, not deterministically settled) | `MOCK2_PREPASS_MODEL` → Haiku 4.5 | low / off / 900 | none | not ledgered (deliberately one cheap call) |
| Design review / Polish | manual button or auto after success (toggle, default on) | `MOCK2_REVIEW_MODEL` → build slot | high / adaptive / 2500 | none (vision input) | ledger, cycle-less |
| Explain card / follow-up | operator taps Explain (any member) | `summary` slot | default / adaptive / 4000 | none | none (read-only) |
| Ask | build-chat Ask (editor) | `build_runner` slot + `ask` lane tuning | tuned / tuned / 16000 × ≤15 turns | exec (blocklist-gated), read_file, get_component, web_search | quota pre-check + per-turn ledger |
| Consult | operator "Get guidance" (uncapped) or auto (`MOCK2_CONSULT` default **off**; 1/halt, 2/request) | **fixed `claude-fable-5`** on the audit slot's connector (build fallback) | default / adaptive / 16000 | none (digest only) | on the consult row (own request segment) |

Details worth knowing when evaluating:

- **Checklist post-pass** keeps the screens/features checklist truthful:
  *"new_screens: ONLY pages the build genuinely created… completed_item_ids:
  … (be conservative — when unsure, leave it pending). Never invent work the
  summary does not support. Empty lists are the normal answer for a small
  fix."* Fail-open everywhere.
- **Design review** screenshots the LIVE app (mobile 390px + desktop 1280px,
  ≤6 shots) and feeds the vision model the approved mockup + tokens plus
  deterministic riders: a horizontal-overflow check (flagged as
  *"DETERMINISTIC FINDING — … a defect; include a fix in your findings"*),
  axe-core violations, and a rogue-color lint. The prompt judges *"like a
  design lead doing a polish review, not a linter"* across fidelity, craft,
  states, density, mobile; specific findings only (*"never generic ('improve
  spacing')"*; ≤12). **Never a gate** — builds ship on the gate battery, not
  on taste. With apply, findings become one bounded quick build: *"apply
  EXACTLY these visual fixes, no new features… Keep every fix inside the
  design tokens."*
- **Explain** rewrites a technical halt/authorization card for a
  non-technical operator: *"Do NOT use jargon… Do NOT mention section
  numbers, rule references, file paths, code, SQL… translate the MEANING."*
  Exactly five things (what happened / why it stopped / what it's asking /
  if you approve / if you decline) + a risk judgment that defaults to
  **medium** when the model is vague — never silently "low". Failures fall
  back to the original card text; the operator is never blocked.
- **Ask** is a bounded tool loop on the build container with the build
  ceremony stripped: *"Do NOT modify the CODE… If the user asks for a code or
  config CHANGE, … tell them to run it as a Quick update"*, but *"DRAFTING
  TEXT IS ALWAYS FINE"* and operational data changes are allowed only when
  explicitly asked — *"NEVER destroy data in bulk."* The exec tool refuses
  destructive commands outright (rm -rf, git state changes, npm installs,
  DROP/TRUNCATE, DELETE without WHERE). It takes the checkout lock so an ask
  and a build never interleave.
- **Consult** is a single tool-free Fable 5 call over a compiled digest of a
  stuck cycle — *"You have NO tools and NO access to the code beyond the
  digest… you advise, you do not act, and you never take over the build."*
  Output: diagnosis + 2–4 ranked paths + a paste-ready resume paragraph. The
  only build-time path besides the audit lane that names Fable 5.

---

## Where the money goes

Observed request costs decompose as: **runner-loop turns ≈ 80–90%**, mockup
renders next, everything else (pre-pass, distill, checklist, explain) is
pennies. Cost therefore scales with **how many turns the runner needs** — a
function of brief precision, checklist scope, and rejection round-trips — not
primarily of per-token price.

This matches the operator's standing finding: a weaker/cheaper build model
(Sonnet) misses cross-effects on codebase-scale work, which then costs more
in re-work turns and human review than Opus's premium. The harness therefore
treats Opus-class as the build floor and spends cheap models only on
classification/transcription (the Haiku pre-pass lanes) — and attacks cost by
removing turns: scoped lanes (tweak/screen/quick), split proposals,
one-rejection gates, and continuation instead of re-render.

Accounting mechanics: every call is priced cache-aware (`costCentsForUsage`:
input 1×, cache reads 0.1×, cache writes 1.25×) at the connector's effective
price (admin price rows win over list defaults), written to the
`mock2_quota_ledger` and the cycle's usage columns. Quotas gate cycle starts
with a buffered estimate (default 15%); a refusal is a terminal
`refused_quota` — the pipeline never dead-ends mid-flight on budget.
Known intentional gaps: the checklist post-pass and Explain are unledgered
(read-only/pennies); consult costs live on the consult row as their own
request segment.

---

## Evaluating the harness — a checklist

When judging whether a step is doing its job, the levers are:

1. **Model identity per step** — slot assignment (Connectors), env overrides,
   and lane tuning (Routing). Verify what actually served a call in the
   request log's routing/model lines and the transcript events.
2. **Effort/thinking per step** — the tables above list every default; the
   deep-render vs iteration split in the mockup lane and the difficulty→
   effort mapping in routing are the two adaptive points.
3. **Prompt contracts** — the verbatim excerpts here are the load-bearing
   instructions; each traces to an observed failure (dead-end CRUD, demo
   states shipped as defaults, emoji iconography, Goodharted gates,
   over-claimed summaries). If a class of defect recurs, the fix belongs in
   the prompt contract or a deterministic check — not in ad-hoc re-prompting.
4. **Turn count over token price** — the dominant cost lever. Watch the
   runner's turns-per-cycle; brief precision (concept chat + pre-pass) and
   gate one-shot-ness are what move it.
5. **The free half's verdicts** — acceptance red-before-green, parity,
   over-claim, tripwire, smoke: these are the honesty layer. A harness change
   that weakens one should be treated as a regression even if builds "pass"
   more often.
