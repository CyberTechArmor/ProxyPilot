# Mock2 harness — every step, every model, every intended outcome

The complete map of the app-generation pipeline as it exists in code: what
each step does, which model serves it (and how that resolution works), the
effort/thinking/output-budget it runs with, and what a correct outcome
looks like. Deterministic (zero-model) steps are listed too — they are the
free half of the harness. This document is the source for the planned
admin-side Harness page (every model-bearing row here becomes a tunable).

File references are the implementation anchors, not reading assignments.

## 0. How a step's model is resolved (four layers, later wins)

1. **Slot** — the operator assigns connectors+models to three slots
   (Projects → Connectors): `build_runner`, `audit`, `summary`. Concept
   chat and mockup rendering ride the same connector pool with their own
   resolution (below).
2. **Hard defaults / env overrides** — per-step constants:
   `MOCK2_FAST_MODEL` (build fast-path model; default `claude-sonnet-5`,
   typically overridden to `claude-opus-4-8`), `MOCK2_MOCKUP_MODEL`
   (mockup render; default `claude-fable-5`, `'slot'` restores the slot
   model), `MOCK2_PREPASS_MODEL` (classifier; default Haiku 4.5),
   `MOCK2_REVIEW_MODEL` (design review), `MOCK2_QUICK_EFFORT` /
   `MOCK2_MVP_EFFORT`, `MOCK2_RUNNER_MAX_TOKENS`.
3. **Routing** (`routing-logic.js`) — full builds classify the task
   (kind/difficulty/rung) and may escalate; MVP/quick use fixed fast
   decisions.
4. **Lane tuning** (dashboard → Routing tab; `settings.js` +
   `lane-tuning-logic.js`) — operator overrides of model/effort/thinking
   per lane: `build`, `mvp`, `audit`, `chat`, `mockup`, `ask`. Applied
   last; wins over everything.

## 1. Concept stage (design partner + mockups)

| Step | Trigger | What it does | Model | Effort / thinking | Output budget | Intended outcome |
| --- | --- | --- | --- | --- | --- | --- |
| **Concept chat turn** (`concept.js` ~539) | Every design-chat message | Design-partner conversation; expands simple asks into domain-expert briefs; decides tweak/screen/full scope via the `generate_mockup` tool | Chat slot model, lane `chat` | Lane default (adaptive) | 16k | A brief that is the design's ceiling; right scope chosen so revisions cost the minimum |
| **Mockup render — full** (`concept.js` ~779) | First render, explore, restyle brief | One self-contained multi-screen HTML mockup obeying token precedence (brief > preset > design system) | `claude-fable-5` (`MOCK2_MOCKUP_MODEL`; falls back to slot model if rejected), lane `mockup` | Deep renders (first/explore/restyle): high + adaptive thinking. On-theme iterations: low, thinking off | Sized from current doc (40–64k) + truncation continuation (2×30k hops) | The visual contract every build inherits — worth the strongest model once |
| **Mockup tweak** (`concept.js` ~662) | Small copy/style change | Search/replace edit blocks against current HTML (falls back to full render if they don't apply) | Same as render | low / off | 6k | A one-line change costs cents, not a re-render |
| **Mockup screen re-render** (`concept.js` ~699) | One screen changes substantially | Re-renders ONE `<section data-screen>`; swap-in | Same as render | high / adaptive | 20k | Screen-scale change without whole-document cost or size ceiling |
| **Render continuation** (`concept.js` ~736 area) | Render stopped at max_tokens | Instruction-turn continuation + defensive stitching (no prefill — model rejects it) | Same as render | low / off | 30k per hop (≤2) | Paid partial output is finished, never discarded |
| **Design-doc AI adjust** (`concept.js` ~181) | Operator asks AI to adjust a design preset | Proposes sanitized token JSON (cannot inject CSS) | Chat slot, lane `chat` | lane default | small | A valid `proxypilot-design@1` proposal |
| **Inventory extraction** (`concept.js` ~1071) | Design approval | Mockup HTML → structured inventory (screens, fields, actions incl. MUTATION COVERAGE, states + `default_state`, journeys, capabilities); then `mergeVariantScreens` + `completeInventoryCrud` + `lintInventory` post-process it (pure, free) | Chat slot | thinking off (JSON) | generous, 1 retry | The build contract: complete CRUD, variants folded, defaults explicit |
| **Design-token extraction** (`concept.js` ~1130) | Design approval (after inventory) | Mockup → `state/design-tokens.json` + rendered `design.css` | Chat slot | thinking off | 8k | The approved LOOK carried into the build; falls back to framework defaults |

## 2. Build request — Define segment

| Step | Trigger | What it does | Model | Effort / thinking | Budget | Intended outcome |
| --- | --- | --- | --- | --- | --- | --- |
| **Rule audit / interview** (`audit.js` ~392) | Full build only | Audits the instruction against rules + constitution; produces tappable rule questions; answers append `state/rules.md` | `audit` slot, lane `audit` | medium | bounded | Confirmed, testable rules before code |
| **MVP/quick define skip** (`audit.js` ~278) | MVP/quick build | Zero-cost define segment records the skip; the standard CRUD rules pack is injected later as the build floor | — (no model) | — | $0 | Speed with a floor instead of a void |

## 3. Build request — Build segment

| Step | Trigger | What it does | Model | Effort / thinking | Budget | Intended outcome |
| --- | --- | --- | --- | --- | --- | --- |
| **Route-time split probe** (`runner.js` ~265) | Quick update submitted | Sizes the ask; feature-scale requests get a split proposal card | Haiku 4.5 (`MOCK2_PREPASS_MODEL`) | low / off | tiny | Big asks decompose BEFORE they burn a big cycle |
| **Quick-lane pre-pass** (`runner.js` ~218) | Quick/MVP cycle start | Classifies scope, writes the working brief (+ suggest-mode additions) stamped into routing | Haiku 4.5 | low / off | tiny | The cheap model does the thinking scaffold; the big model builds |
| **Chat→prompt distill** (`runner.js` ~287) | "Build this as a Quick update" button | Converts a chat message into a well-formed instruction | Haiku 4.5 | low / off | 1.6k | One tap from conversation to build |
| **Build runner loop** (`runner.js` ~1070) | Every build cycle | THE builder: reads mockup/inventory/rules, edits code in the fenced container via tools, runs gates, finishes | `build_runner` slot; fast modes use `MOCK2_FAST_MODEL` (operator: opus-4-8). Full: high (routing). MVP: high. Quick: **medium** default (`MOCK2_QUICK_EFFORT`), lane `build`/`mvp` | 64k/turn (`MOCK2_RUNNER_MAX_TOKENS`) | Working, contract-complete code. **This is where ~80–90% of a request's cost lives — cost scales with TURNS, so everything that reduces round-trips (precise briefs, checklists, one-shot gates) is a cost lever** |
| **Consult (second opinion)** (`consult.js`) | Operator asks on a halted/blocked cycle | Digest of the failure → one advisory diagnosis | `claude-fable-5` (fixed) | — | 16k | Unblocks a stuck cycle with senior eyes; advisory only |
| **Explain card / follow-up** (`explain.js`) | Operator taps Explain | Plain-language rewrite of a halt/authorization card | `summary` slot | — | 4k | Non-technical operator understands the decision |

## 4. Finish, verification, deploy (the free half)

All deterministic — zero model cost:

| Step | What it does | Outcome |
| --- | --- | --- |
| **Acceptance verdict** (full builds) | `state/acceptance.json` discipline; red→green demonstrated for bugfixes; stale specs (not written this cycle) never feed classification | "Gates green" ≠ "acceptance demonstrated" stays distinguishable |
| **Summary over-claim check** | Finish summary may only name files this cycle changed (brace/list/prose-aware extractor) | Honest change records; no bundling |
| **Action-parity gate** | Inventory mutation actions must appear in UI source (implemented or badged "Not built yet"); silently-missing rejects finish once; a still-missing accept posts a build-chat warning | The contract cannot be silently dropped |
| **Gate battery** (full builds) | Pinned deterministic scripts (framework `gates.json`) in-container | Machine-verifiable correctness floor |
| **Anomaly tripwire** | Under-verified bugfix signature → deploy HELD before going live; operator releases via Deploy | Nothing under-verified ships silently |
| **Deploy stage** | deps → migrate → build → systemd swap → health check | Live URL serves the real app |
| **Smoke gate** | HTTP layer always; browser/db connectors by diff triggers; builder `acceptance_ids` hard-execute named ui-checks against the deployed app | The happy paths are machine-verified live |
| **Mockup checks battery** | On every saved render: legacy palette, token-only colors, themes+toggle, data-bound bars, canonical rows, detail bands, computed AA | Design defects caught before a human looks |

## 5. Post-build / on-demand passes

| Step | Trigger | Model | Budget | Intended outcome |
| --- | --- | --- | --- | --- |
| **Checklist post-pass** (`screen-plan.js` ~468) | Request close | Haiku 4.5 | 0.9k | Screens/features checklist stays truthful |
| **Design review / Polish pass** (`design-review.js` ~249) | Button or auto after request close (toggle) | `MOCK2_REVIEW_MODEL` or build slot | 2.5k, effort high | Screenshot-based critique + deterministic overflow/axe/rogue-color findings → auto-fix queue |
| **Ask** (`ask.js` ~201) | Build-chat Ask | Build slot, lane `ask` | 16k | Answers/drafts with conversation context; can act via tools |

## 6. Where the money goes (and the Sonnet/Opus point)

Observed request costs decompose as: **runner loop turns ≈ 80–90%**,
mockup renders next, everything else (pre-pass, distill, checklist,
explain) is pennies. Cost therefore scales with **how many turns the
runner needs**, which is a function of brief precision, checklist scope,
and rejection round-trips — not primarily of the per-token price.

This matches the operator's finding: a weaker/cheaper build model (Sonnet)
produces code that misses cross-effects on this codebase-scale work, which
then COSTS MORE in re-work turns and human review than Opus's premium.
The harness therefore treats Opus-class as the build floor and spends
cheap models only where the task is classification/transcription (Haiku
pre-pass lanes) — and attacks cost by removing turns: scoped lanes
(tweak/screen/quick), split proposals, one-rejection gates, and
continuation instead of re-render.
