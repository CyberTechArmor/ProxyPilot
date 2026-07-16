# Model routing — difficulty-based model selection, effort tuning, escalation

Migration 525. Routing turns "which model, at which reasoning effort, for this
task" from a fixed per-slot setting into a **reviewable, tunable decision**,
without a single extra model call.

## How a decision is made

1. **Classification (free).** The define audit already returns structured JSON;
   it now also returns `task: { kind, difficulty }` — kind is one of
   `chore | bugfix | feature | refactor | question`, difficulty is 1–5. Zero
   extra tokens: it rides on the audit call that runs anyway.
2. **The knowledge base** (`mock2_routing_rules` — the reference dictionary,
   editable at Connectors → Routing) maps task kind → optional model override,
   optional escalation model, optional effort, and free-text notes. A fresh
   install seeds lane defaults with **no** model overrides — behavior is
   exactly as before until an operator tunes it.
3. **Deterministic escalation.** When a prior build attempt of the same
   request ended `failed / awaiting_admin / interrupted / abandoned` (ground
   truth from the cycle table — never a model's self-report), or the audit
   scored difficulty 5, the next attempt steps up to the rule's escalation
   model (falling back to `MOCK2_ESCALATE_MODEL`). No escalation model
   configured → stay on the base model; the system never invents a model id.
4. **Effort.** The rule's effort if set, else mapped from difficulty
   (1–2 → medium, 3 → high, 4–5 → xhigh), else the lane default (high).

## What gets sent to the model (Anthropic only)

`routing-logic.anthropicTuning()` gates per model id, conservatively — an
unrecognized model gets nothing (never risk a 400):

- `thinking: { type: "adaptive" }` on models that support it (Opus 4.6+,
  Sonnet 4.6/5, Fable/Mythos). Previously no thinking parameter was sent at
  all — on Opus 4.7/4.8 that means the model ran *without* thinking.
- `output_config: { effort }`, clamped down where a level isn't supported.

Adaptive thinking requires replaying thinking blocks verbatim on multi-turn
tool loops — `model-client.js` now keeps each assistant turn's raw content
array (`turn.raw`) and replays it unchanged.

Other providers (openai/gemini/ollama) get no tuning fields; routing's model
selection still applies (the override must be a model the build_runner slot's
connector can serve).

## Reviewability (the logs)

- The decision is stamped on the cycle (`mock2_cycles.routing_json`:
  model, applied_model, effort, rung, task_kind, difficulty, reason, mode)
  and surfaced in the Build panel ("Model: … · effort … · escalated").
- A `routing` cycle event lands in the request log at start.
- Every terminal build cycle writes one row to `mock2_routing_outcomes`
  (append-only evidence; upserted on re-finish so the final status wins):
  what ran, at what cost, with what outcome.

## Fine-tuning loop (the knowledgebase)

Connectors → Routing shows the dictionary and the **outcome scoreboard**
(per task kind × model: runs, success rate, escalation rate, avg cost —
`GET /api/mock2/routing/outcomes`). The intended loop:

1. Run with defaults (or `shadow`) and let evidence accumulate.
2. Where a cheap model's success rate is high for a kind (e.g. chores),
   set it as the rule's model — record why in the notes field.
3. Set an escalation model so retries get a stronger model automatically.
4. Watch the scoreboard; revert a rule that degrades success rate.

## Env

| Var | Values | Default | Meaning |
| --- | --- | --- | --- |
| `MOCK2_ROUTING` | `on` / `shadow` / `off` | `on` | `shadow` decides + records but keeps the slot model (trial mode); `off` skips entirely |
| `MOCK2_ESCALATE_MODEL` | model id | unset | Global fallback escalation model when a rule has none |

## API

- `GET /api/mock2/routing/rules` (admin) — mode, kinds, efforts, rules.
- `PATCH /api/mock2/routing/rules/:kind` (admin, audited) — edit a rule;
  null/empty clears a field back to the default.
- `GET /api/mock2/routing/outcomes?kind=` (admin) — aggregated scoreboard +
  the 50 most recent outcome rows.

## Files

- `admin/backend/src/mock2/routing-logic.js` — pure decisions (tested:
  `src/__tests__/mock2-routing.test.js`).
- `admin/backend/src/mock2/routing.js` — rules + outcomes DB half; the
  `finishCycle` hook records outcomes.
- `admin/backend/src/mock2/runner.js` — the decision at `startCycle`, the
  `routing` event, effort pass-through.
- `admin/backend/src/mock2/audit-logic.js` / `audit.js` — task classification.
- `admin/backend/src/mock2/model-client.js` — `anthropicTuning`, raw-content
  replay for adaptive thinking.
- `admin/frontend/src/pages/ModelConnectors.jsx` — the Routing tab.
- `admin/frontend/src/components/mock2/BuildStatus.jsx` — the per-build line.
