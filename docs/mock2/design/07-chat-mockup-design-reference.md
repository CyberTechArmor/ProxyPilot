# Mock2 chat → mockup → build UI — design reference (Phases M7–M9)

**Source.** An interactive HTML mockup produced with Claude "design" by the
operator (2026-07-09) to walk through what the **chat-to-mockup/build** feature
should feel like. It is a *design reference*, not a spec to copy pixel-for-pixel
— the binding rules are still ADR-002 (audit routing), the phase scopes in
`04-phased-plan.md` (M7/M8/M9), and `MOBILE_FIRST.md`. A compact static
reconstruction of the hero state lives beside this file as
`chat-mockup-reference.html`; the operator's original interactive mockup is the
source of truth for look-and-feel and can be re-shared to render live.

**Why it matters now.** It pins the *product surface* the AI phases build toward,
so M5/M6 (connectors + runner) are built with the end in view, and so M7 doesn't
re-derive the UX from scratch. It is captured here early, on purpose — the actual
build of this surface is M7+, which depends on M5 (a model slot to call) and M6
(the runner). Nothing here changes the dependency graph.

---

## The one big idea: a three-phase project lifecycle, always visible

Every project detail view carries an **ever-present status pill** and a
**3-step stepper** that reads:

| Phase | Pill label | Accent | Maps to |
|---|---|---|---|
| **Design · Mockup** | `Design · Mockup` | cyan `#22d3ee` | **M7** — chat → mockup → design approval |
| **Building** | `Building` | amber `#f59e0b` | **M6/M8** — audit on "Build", then the cycle runner assembling the real app |
| **Live · Maintenance** | `Live · Maintenance` | emerald `#34d399` | **M9** — in use, iterated via chat |

The pill and stepper are **derived** from the project's lifecycle + cycle/lock
state (single-source-of-truth rule, `03-data-model.md`), never hand-set — the
same `deriveProjectStatus` the tiles use, extended.

The primary header CTA is **context-dependent**:
- Design phase, mockup ready → **`Approve & Build`** (disabled until a mockup exists).
- Building → **`Building…`** (disabled).
- Live → **`Open live app`**.

`Approve & Build` is the M7 stage exit: the design-approval gesture writes
`state/inventory.json`, commits, and unlocks Build (ADR-002 / M7 scope).

---

## Layout

```
┌── sidebar 236px ──┬───────────────── main ─────────────────────────────┐
│ ProxyPilot Studio │ header: breadcrumb · title · STATUS PILL · [details]│
│ · My Projects     │         · context CTA (Approve&Build / Open live)   │
│ · Templates       ├─ collapsible "Project details" ─────────────────────┤
│ · Help & guides   │  stepper · what-this-is · goals · connects-to · meta│
│                   ├──────────────── body (flex) ────────────────────────┤
│ [user card]       │  PREVIEW (dominant, flex:1)   │  CHAT (docked 378px) │
└───────────────────┴───────────────────────────────┴──────────────────────┘
```

- **Preview is dominant, chat is docked** (378px right rail). The build view is
  preview-first; chat is the control surface.
- **Collapsible details** panel (toggled from the header) holds: the stepper, a
  plain-language *"What this project is"* paragraph, a **Goals** checklist,
  *"Connects to"* chips (calendar / email / records), and a **Details** block
  (owner / started / last change).

## Preview pane

A faux browser chrome: three dots, a **preview URL** field with a lock icon
(the per-slug HTTPS URL — green lock only when Live), a **Desktop / Mobile**
device toggle (drives `frameWidth` 760px↔390px), and **Open in new tab**
(enabled only when a mockup is ready or the app is live).

The canvas has **five states** (the whole reason the pane exists):
1. **Empty** — "Your mockup will appear here" + a nudge to describe the app in chat.
2. **Generating** — a shimmer skeleton while the mockup is designed.
3. **Ready** — the rendered mockup itself (in the reference: a light-themed dental
   new-patient intake form). Per the brief, the mockup is an **HTML artifact
   committed under `state/mockups/`** and served through the project's preview
   URL path — here it's shown inline, but M7 serves it via that path.
4. **Building** — a progress bar: "Building your app for real…".
5. **Live** — success: "Your app is ready!" + Open-live-app.

## Chat pane ("Design assistant")

- Header: sparkle avatar, "Design assistant · Describe your app in plain words".
- **Intro state** (no messages): a friendly greeting asking *what it should do,
  who will use it, what should happen at the end*, followed by **"Try saying
  something like"** and 4 tappable **suggestion chips** that pre-fill the input.
- **Message list**: user bubbles right (green `#1a6d3f`), assistant bubbles left
  (dark card), a typing indicator (three bouncing dots) while generating.
- **Composer**: auto-growing textarea + send button (Enter to send, Shift+Enter
  newline), with the reassurance line *"No code needed — just tell me what you
  want in plain language."*

The suggestion-chip / tappable-choice pattern is exactly the shape ADR-002 wants
for **editor rule-questions** in M8 (fixed choices + free-text escape hatch).

## Interaction model (from the mockup's `DCLogic`)

- `phase`: `design | building | live`; `previewState`: `empty | generating | ready`.
- `send()` appends the user message + an assistant ack, flips preview to
  `generating`, then (async) to `ready` with a "here's your mockup, approve or
  change it" message.
- `build()` requires `phase==='design' && previewState==='ready'` → sets
  `building` → later `live`. (In real M7/M8 the "later" is the audit + runner.)

---

## Design tokens (for consistency when this is built for real)

- Surface `#070b11`; panels `#0a0f18` / `#0d1420` / `#0f1621`; hairline
  `rgba(255,255,255,.06)`.
- Primary green `#22c55e`; phase accents cyan `#22d3ee` (design), amber
  `#f59e0b` (building), emerald `#34d399` (live).
- Text `#e8edf4` / muted `#8a97a8` / faint `#5d6b7d`. Font **Manrope**
  (fall back to `system-ui`). Generous radii (9–16px), soft shadows.

These are the **studio/build-view** palette. They are NOT a license to deviate
from the app's existing shadcn/Tailwind theme in the rest of ProxyPilot — this
is a distinct, immersive surface (like an IDE) reachable only inside an enabled
Mock2 project. Reconcile with the real design system (`mock2_framework_versions.
design_system_md`) when M7 lands; the *mockups the model generates* must obey the
framework design system, while this *chrome around them* is ProxyPilot's.

---

## Phase mapping — what each phase takes from this reference

**M7 — Stage 1: chat, mockup, design approval.** The Design phase in full: the
docked chat, the empty→generating→ready preview, the suggestion chips, the
`Approve & Build` gesture (→ `inventory.json` + commit + unlock Build). Chat
polls like the rest of the app; the mockup is an HTML artifact under
`state/mockups/` served through the preview URL (new tab). Concept stage
structurally cannot write backend code/rules (orchestrator tool policy).

**M8 — audit, rule questions, admin queue.** The `Approve & Build` press triggers
the audit; **editor questions render in-chat as the tappable-chip pattern** shown
here (answers append to `state/rules.md`); **framework deviations** go to the
admin queue. The `Building` phase pill/stepper is the "cycle blocked awaiting
answers" state, derived from open questions.

**M9 — iteration: classifier, summary, lifecycle polish.** The
`Live · Maintenance` phase: ongoing chat requests run the classifier
(implements / contradicts / unaddressed), the status pill/stepper reflect
idle-stop (`Stopped`) and quota states, and the adaptive summary surfaces in the
details panel.

## MOBILE_FIRST (R10) — non-negotiable

The reference is a desktop three-column layout. `MOBILE_FIRST.md` is a **merge
gate**: at 360/375px the preview + docked chat must collapse to a single column
(e.g. a preview/chat tab switch), suggestion chips and tappable rule-questions
must stay ≥44px touch targets, and the composer must be reachable above the
keyboard. Design these at 360px from the first M7 mock, not as a retrofit — the
phase-stepper pattern in `LxcContainers.jsx:2304-2340` is the in-repo precedent.
