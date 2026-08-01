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
| `MOCK2_PHASE_ROUTING` | `on` / `off` | `on` | Per-phase model routing (phase-routing@1); the stored `phase_routing` setting wins over the env var |

## API

- `GET /api/mock2/routing/rules` (admin) — mode, kinds, efforts, rules.
- `PATCH /api/mock2/routing/rules/:kind` (admin, audited) — edit a rule;
  null/empty clears a field back to the default.
- `GET /api/mock2/routing/outcomes?kind=` (admin) — aggregated scoreboard +
  the 50 most recent outcome rows.

## OpenAI provider + cross-provider equivalence map

OpenAI is a first-class provider (the neutral model client already spoke the
chat-completions shape; only its catalog and a tier map were missing). Two
additive pieces:

- **Pricing** — `quota-logic.DEFAULT_MODEL_PRICES` now carries the OpenAI
  frontier + utility catalog (per 1M tokens, input / cached input / output;
  verified against the vendor pricing pages **2026-08-01** — OpenAI cut
  `gpt-5.6-luna` ~80% and `gpt-5.6-terra` ~20% on 2026-07-30; `sol` was not
  cut):

  | Model | Input | Cached input | Output | Role |
  |---|---|---|---|---|
  | `gpt-5.6-sol` | $5.00 | $0.50 | $30.00 | flagship, hardest coding + complex tool use |
  | `gpt-5.6-terra` | $2.00 | $0.20 | $12.00 | balanced default production coding |
  | `gpt-5.6-luna` | $0.20 | $0.02 | $1.20 | fast, low-cost |
  | `gpt-5.5-pro` *(legacy)* | $30.00 | — none (bills full input) | $180.00 | off the active sheet |
  | `gpt-5.3-codex` | $1.75 | (0.1×) | $14.00 | coding specialist (400K context) |
  | `gpt-5.4-mini` | $0.75 | (0.1×) | $4.50 | cheap utility (below the Haiku floor) |
  | `gpt-5.4-nano` | $0.20 | (0.1×) | $1.25 | cheapest (below the Haiku floor) |

  Every sheet row now carries `effective_date` + `source_url` (surfaced as
  "prices last verified on <date>" via `estimateStageCostCents` /
  `breakdownForDisplay`), per-model cache rates (write ×1.25 of uncached
  input; reads ×0.1 except `gpt-5.5-pro`, which has no cached rate), a
  **long-context multiplier** (OpenAI: 2× on input *and* output above a
  ~270K-token breakpoint, applied via the usage record's
  `longContextInputShare` / `longContextOutputShare`; Anthropic rows keep the
  field at 1.0 — per-model, not per-vendor, so it can be corrected later),
  and dated rows for promo transitions (`claude-sonnet-5` bills $2/$10 through
  2026-08-31 and $3/$15 from 2026-09-01 — `defaultModelPrice(model, { date })`
  resolves the row in effect for the estimate's date). Batch API is recorded
  as a 50% input+output discount (metadata; the platform does not batch).

  Cost accounting picks these up unchanged (`defaultModelPrice` → the same
  cache-aware `costCentsForUsage`).

- **Equivalence map** — `model-equivalence.js` aligns Anthropic and OpenAI by
  capability tier (speed and rough cost track the tier within each provider), so
  a connector chooser or a future cross-provider fallback can resolve one id to
  its twin. Bidirectional; `mini`/`nano` have no Anthropic equivalent.

  | Anthropic | OpenAI |
  |---|---|
  | `claude-fable-5` | `gpt-5.6-sol` |
  | `claude-opus-4-8` | `gpt-5.6-sol` (coding cost-down: `gpt-5.3-codex`) |
  | `claude-sonnet-5` | `gpt-5.6-terra` |
  | `claude-haiku-4-5` | `gpt-5.6-luna` |

  The reverse of Sol resolves to Opus 4.8 (the workhorse), not Fable 5, so a
  round-trip lands on the everyday tier. Cross-provider *fallback* (retry the
  mapped-equivalent model on the other provider) is intentionally left as a
  future flag-gated wiring — the map is the prerequisite building block.

OpenAI keys, like every non-Anthropic provider, come from the connector row
(encrypted in the DB), never an env var — see the note in `.env.example`.

## Per-phase model routing (phase-routing@1)

A full build on a framework version that carries the `phase-routing@1` marker
(the shipped seed does) runs as **five phases with independently selectable
models**, resolved once at cycle start:

| Phase | Tier | Both providers | OpenAI only | Anthropic only |
|---|---|---|---|---|
| 1 recon | cheap | `gpt-5.6-luna` | `gpt-5.6-luna` | `claude-haiku-4-5` |
| 2 plan | top | `claude-opus-5` | `gpt-5.6-sol` | `claude-opus-5` |
| 3a implement (mechanical) | cheap | `gpt-5.6-luna` | `gpt-5.6-luna` | `claude-haiku-4-5` |
| 3b implement (complex) | mid | `gpt-5.6-terra` | `gpt-5.6-terra` | `claude-sonnet-5` |
| 4 summarize | cheap | `gpt-5.6-luna` | `gpt-5.6-luna` | `claude-haiku-4-5` |
| 5 review | top | `claude-opus-5` | `gpt-5.6-sol` | `claude-opus-5` |

Mechanics (pure layer: `phase-routing-logic.js`, tested in
`mock2-phase-routing.test.js`; wiring: `runner.js` `startCycle` +
`checkpointAndRecord`):

- **Provider detection** reuses the connector rows (enabled + decryptable key
  — the same `secret_decryptable` signal the provider selector shows; no
  second credential store). Neither Anthropic nor OpenAI configured → the
  cycle **fails at start** with an operator message, before any cycle row is
  inserted (no partial state). No hardcoded fallback.
- The resolved map is stamped into the cycle's `routing_json`
  (`phase_scenario` / `phase_providers` / `phase_map`) and echoed as a
  `Phase model map [...]` line in the change record, so any cycle is
  reproducible from its record.
- **Recon** (the only new phase) dispatches *scoped* briefs — one per touched
  subsystem, written to `state/recon/NNN-<subsystem>.md` and committed; the
  plan reads briefs, not the raw tree.
- **3a/3b carve-out**: the plan classifies each work-file task with
  `complexity: mechanical | complex` and `touches: [auth, rbac, crypto,
  migration, external-integration, money, none]`. A task with non-empty
  `touches` is **never** dispatched to the cheap tier, regardless of size
  (the surface-trigger / human-sovereign lists, reused as the routing floor).
  A mechanical task that fails Tier-1 gates twice escalates to the 3b model —
  never a third cheap attempt.
- **Assumption ledger**: phase 3 emits it (verified-with-citation vs.
  assumed-with-reason); phase 4 writes only the narrative/tables and must not
  author or edit the ledger — close-out fails a record whose ledger did not
  come from the implement phase (`closeOutLedgerVerdict`, both the
  `state/changes/N.json` and `NNN-change-record.md` serializations).
- **Tier-2 dispatch** receives the change record *and* the full diff
  (`buildReviewDispatchInputs` refuses to dispatch without the diff); findings
  must cite `file:line` from the diff.
- No phase routes to a pro/frontier tier by default (`gpt-5.5-pro` is legacy
  + uncached; Fable is priced above Opus). The only opt-in is a plan-phase
  override.
- **Toggle**: `phase_routing` setting (Admin queue → "Per-phase model
  routing", `GET/POST /api/mock2/settings/phase-routing`) or
  `MOCK2_PHASE_ROUTING` env — default **on**; `off` restores the single-model
  path. Projects on framework versions without the marker are untouched
  either way, and the Tier-1 deterministic gate battery is unchanged in every
  mode.
- **Cost posture** (`phase_routing_posture` setting on the same card/API, or
  `MOCK2_PHASE_POSTURE` env): five presets applied over the resolved map at
  cycle start, all provider-aware and all stamped into `routing_json` +
  the change record's map line:

  | Posture | Meaning | both / OpenAI-only | Anthropic-only |
  |---|---|---|---|
  | `default` | the manually set configuration, as resolved | (per-phase map) | (per-phase map) |
  | `suggested` | recommended tier model at every phase | (per-phase map, overrides dropped) | (per-phase map, overrides dropped) |
  | `ultra_cheap` | cheapest available model for everything | `gpt-5.6-luna` | `claude-haiku-4-5` |
  | `balanced` | mid tier for everything | `gpt-5.6-terra` | `claude-sonnet-5` |
  | `max_quality` | "take my money": best available flagship for everything | `claude-fable-5` (Sol when OpenAI-only) | `claude-fable-5` |

  `max_quality` is the one sanctioned way a frontier tier runs outside the
  plan phase — an explicit operator opt-in, never a default; `gpt-5.5-pro`
  stays excluded even there (legacy, uncached). A posture never overrides the
  neither-provider refusal, and the gate battery runs identically under every
  posture.

## apply_edit — anchored targeted file editing

The runner exposes `apply_edit` alongside `write_file`: instead of re-emitting a
whole file, the model replaces exact, anchored substrings (`old_string` copied
byte-for-byte with 3+ lines of context). Cheaper (output tokens cost 5–10×
input) and safer — a mismatch is a **structured error the model retries on**,
never a silent corrupt write:

- `NO_MATCH` — not found; a nearest-lines hint helps re-anchor.
- `AMBIGUOUS_MATCH` — matched >1 and `replace_all` is false; returns the count.
- `PARSE_FAIL` — an optional post-apply validator rejected the result (rolled
  back). The runner leaves the validator unset today and verifies via the gate
  battery; the hook exists for a future syntax check.
- `FILE_NOT_FOUND` / `INVALID_EDIT`.

The batch is **all-or-nothing**: if any edit fails, the file is left untouched.
On success the tool returns a unified diff. Pure logic in
`apply-edit-logic.js` (tested: `src/__tests__/mock2-apply-edit.test.js`);
`write_file` is unchanged, so existing behavior is preserved.

## Files

- `admin/backend/src/mock2/routing-logic.js` — pure decisions (tested:
  `src/__tests__/mock2-routing.test.js`).
- `admin/backend/src/mock2/phase-routing-logic.js` — the per-phase pipeline's
  pure decisions (tested: `src/__tests__/mock2-phase-routing.test.js`).
- `admin/backend/src/mock2/model-equivalence.js` — the Anthropic↔OpenAI tier map
  (tested: `src/__tests__/mock2-model-equivalence.test.js`).
- `admin/backend/src/mock2/apply-edit-logic.js` — the `apply_edit` contract
  (tested: `src/__tests__/mock2-apply-edit.test.js`).
- `admin/backend/src/mock2/quota-logic.js` — `DEFAULT_MODEL_PRICES` (OpenAI
  catalog; tested: `src/__tests__/mock2-quotas.test.js`).
- `admin/backend/src/mock2/routing.js` — rules + outcomes DB half; the
  `finishCycle` hook records outcomes.
- `admin/backend/src/mock2/runner.js` — the decision at `startCycle`, the
  `routing` event, effort pass-through.
- `admin/backend/src/mock2/audit-logic.js` / `audit.js` — task classification.
- `admin/backend/src/mock2/model-client.js` — `anthropicTuning`, raw-content
  replay for adaptive thinking.
- `admin/frontend/src/pages/ModelConnectors.jsx` — the Routing tab.
- `admin/frontend/src/components/mock2/BuildStatus.jsx` — the per-build line.
