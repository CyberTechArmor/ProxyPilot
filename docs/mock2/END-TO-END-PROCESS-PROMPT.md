# Prompt: write the ProxyPilot end-to-end process paper and process map

You are producing two artifacts from the specification below:

1. **A paper** (2–4 pages) that narrates the full journey from "new project"
   to "shipped, verified build" — written for a smart non-engineer who will
   operate the platform. Every feature earns its place in the story by the
   problem it removes; do not list features, *walk* them.
2. **A process map** — one diagram (swimlane style preferred) covering the
   same journey. The exact nodes, decision diamonds, and loops are enumerated
   in the "Process map specification" section; do not invent or omit stages.

Everything you need is in this document. Do not add capabilities that are not
described here, and keep the terminology rules at the end.

---

## What ProxyPilot is (one paragraph of context)

ProxyPilot turns a described idea into a deployed, working web application
through a staged pipeline: **Plan → Design → Build → Run**. A human operator
steers by conversation and review; the platform supplies isolated
infrastructure (a container, a git repository, a live HTTPS URL per project),
a team of AI models routed by task, and a battery of machine checks that keep
the AI honest. The operating principle throughout: **the human's 15-minute
review loop is the scarce resource** — everything else exists to make each of
those reviews land on something true.

---

## The journey, stage by stage

### Stage 0 — Create and provision (~1 minute, automatic)

The operator names a project. The platform provisions a fenced container, a
git repository, and a live URL (per-slug HTTPS) — progress is narrated
step-by-step in the chat, and the base app (sign-in, first-admin setup,
theme, admin panel, legal pages, PWA shell) is already running when
provisioning completes. A **guided setup checklist** lives in the Details
tab's Overview section — every step optional, each step's done-state computed
from real data: name the audience ("About this app" — it shapes the first
mockup and the app's own self-description), create *your* account in the app
(the platform is forbidden to create the first human account), upload a logo
and brand assets, make the design, approve it. While provisioning runs, the
operator can already type — anything sent is queued fire-and-forget and runs
the moment the container is up.

### Stage 1 — Plan (talk before anything renders)

The chat opens in **Plan mode** (a three-way toggle: Plan / Design / Build;
Build is greyed out until it unlocks). Plan is pure conversation: the design
partner helps think through the problem, the audiences, the screens, the
flows — it structurally *cannot* render anything in this mode. Two exits:

- **Accept plan** — one button converts the agreed plan into the first design
  brief and starts the mockup automatically.
- The operator switches to **Design** and describes what they want directly.

Interaction to feature: before the first design message, a **design choice
popup** requires picking one of the saved house designs or "Let the AI
decide", and an **assets prompt** invites uploading a logo, screenshots of
what's being replaced, or real wording — because the mockup is built *from*
these, and they matter most before the first render.

### Stage 2 — Design (an interactive mockup, iterated cheaply)

Design turns produce a **fully interactive HTML mockup** served at a live
preview URL — screens, navigation, dialogs, sample data — rendered on the
project's chosen design system. The features that shape this stage:

- **Scoped revisions.** Every revision is sized: a *tweak* (surgical edits,
  seconds, cents), a single *screen* re-render, or a *full* re-render
  (minutes, dollars) — with a hard bias small. A "full" is honored only when
  the request actually reads structural (restyle, new screens, navigation);
  otherwise it is demoted to a tweak that **escalates automatically**
  (tweak → screen → full) if it proves too small. Demotions are announced in
  chat.
- **The design partner sees the render.** On every turn, the platform
  screenshots the current mockup (desktop + mobile) and attaches it to the
  conversation — so "the sidebar looks broken" needs no further explanation,
  and the model reviews its own render for craft defects (overlaps, clipped
  text, oversized icons) even unprompted.
- **Annotate.** The operator can drop numbered pins directly on the mockup
  (element-aware — each pin resolves to the actual element tapped, and names
  its screen); pins + a burned-in screenshot send as a design turn.
- **Live narration.** A step-by-step activity timeline shows what the render
  is doing, each step a persisted row.
- **Portability.** A design can be exported as a template file, imported from
  a file, or copied from another project. **Skip mockup** exists for
  operators who just want the base app and quick updates.

### Stage 3 — The handoff: approval → inventory → MVP (sign-off #1)

**Approving the design is the pivotal, irreversible gesture.** On approval
the platform extracts a **design inventory** — every screen, field, and
action in the mockup, as a structured contract — archives the mockup
read-only, and unlocks Build. The inventory is not documentation; it is the
**contract every later build is measured against** (see action parity,
below). The default path then runs the **MVP build**: one pass that
implements the whole approved design on top of the base app (~20–25 minutes,
~$2), ending in deploy + verification rather than a claim.

### Stage 4 — Build (iterate on the running app)

The chat becomes the build chat (inside the Flightdeck workspace — file
tree, editor, terminal, preview, chat — or a classic stacked view). The
Plan/Design/Build toggle persists as the **send register**:

- **Plan** — a planning turn against the *current code*: a scoped plan comes
  back, nothing is built. Its deeper register is **Research & plan**: web
  search pulls the current official docs for any external API/SDK involved
  (or names exactly what to upload when docs aren't public), only
  plan-changing questions are asked, and the reply is a phased build-ready
  plan — each phase one Quick update with its acceptance check.
- **Design** — a look/layout-only update scoped to the named screens,
  starting from the current design; never a redesign.
- **Build** (default) — **Quick update** (one scoped change, straight to
  deploy) or **Ask** (question or bounded action on the running app — run
  the tests, add a user, call the API — no code changes).

**Route-time cards** (each fires *before* money is spent, and never twice):
a **clarifier** when a request has no checkable outcome; a **research card**
when a cheap classifier judges the request depends on external knowledge
(Research first / Build anyway / Cancel, with an addendum box — and a
follow-up "Build it" card when research completes); a **split proposal** when
a feature-scale ask should become ordered smaller builds; a **suggestions
card** carrying domain expectations a request implied but didn't say.

Other build-phase interactions: **Annotate** on the live app (pins resolve to
real components); **Design options** ("this doesn't look right" returns 2–3
concrete layouts to choose from); **Screen check** (screenshot + critique of
the live app on demand); **Redo** (re-run the last request, optionally
amended — it automatically carries what the prior attempt *did* as context,
and defaults to the routed harness with an explicit model pick one dropdown
away); an **extra-effort boost** for one build; a **build queue** so requests
stack while a build runs; and an **Interrupt** that stops at a safe,
resumable checkpoint.

### The model economy (runs underneath every build)

Work is routed across a five-phase model map — cheap / mid / top tiers
(e.g. Luna / Terra / Opus in a hybrid setup): a **cheap classifier** sizes
every request and flags research needs; the **top-tier plan phase** writes an
implementation plan before every first-attempt build; a **lane router** sends
mechanical tasks to the cheap tier and complex ones to the mid tier; an
**escalation ladder** climbs one tier per failed attempt instead of starting
expensive. Every step in the live feed is tagged with the model that did it,
every call lands in a per-project spend ledger visible in the chat header,
and quotas refuse work past budget. Typical costs: a design iteration in
cents, an MVP ~$2, quick updates $0.05–0.50.

### The honesty machinery (every build, automatic)

A build is never "done because the model said so". In order: **typecheck**
and **design-adherence** gates; **action parity** against the approved
inventory (every contracted action must be *visibly reachable* — hidden or
renamed controls are called out); an **integration gate** (undeclared
external calls are flagged); a **finish guard** that rejects completions
overclaiming what changed; then **deploy**, then **browser acceptance
checks** — a real browser signs in and exercises the change. Failures are
attributed honestly: *platform-owned* baseline failures ship with "not
yours"; *pre-existing* reds don't fail an unrelated build. A user-visible
change no browser check observed concludes as **pending operator
verification** with a human checklist — not a claimed success. Every
shipped build writes a hash-chained **change record** (summary, diff stat,
gates run, commit) and a git checkpoint any build can be restored to.

### The failure loop (when a check fails)

When a build fails its own acceptance checks, the platform **diagnoses
before anyone retries**: it compiles the evidence deterministically (every
failing check's exact steps and console errors, the build's claim, the
changed files' code) and hands it to the top-tier model, which posts a
**Build diagnosis** to the chat — root cause(s), why each check fails, and
*one* combined build-ready fix instruction covering all failures — sendable
with one tap. Measured origin story worth citing: four blind retries cost
$1.07 and fixed adjacent things; one diagnosis-led fix cost $0.17.

### Run (steady state)

The app serves on its URL (custom domains attachable); the operator confirms
pending verifications, rates builds, invites members (editor/viewer roles),
watches spend, and can archive a project (checkpointed into the bare repo,
container destroyed, rehydratable later to the same URL). Idle containers
stop automatically; egress from the container is fenced and logged.

---

## Process map specification

Use four swimlanes: **Operator**, **Platform**, **Models**, **Checks**.
Nodes and branches (→ = flow, ◇ = decision):

1. Operator: *Create project* → Platform: *Provision (container, repo, URL,
   base app)* → Operator: *Guided setup (optional steps)*
2. Operator: *Plan chat* ◇ "Accept plan?" — yes → auto design brief; no →
   operator writes design request. (◇ "Skip mockup?" → jump to node 6.)
3. Platform: *Design choice + assets prompt* → Models: *Mockup render* ◇
   scope: tweak → screen → full (self-escalating ladder; unjustified full
   demoted to tweak) → Platform: *screenshot mockup, attach to next turn* →
   Operator: *review preview / annotate pins* → loop to 3 until satisfied.
4. Operator: **Approve design (sign-off #1, irreversible)** → Platform:
   *Extract design inventory (the contract)* → *archive mockup*.
5. Platform: *MVP build* (top-tier plan → mid-tier implement) → node 8.
6. Build chat ◇ register: Plan / Research & plan / Design / Build.
7. On Build send — Checks (pre-spend cards): ◇ clarifier needed? ◇ research
   needed? (Research first / Build anyway / Cancel) ◇ split? ◇ suggestions?
   → Models: *classifier (cheap) → plan phase (top) → implement (lane-routed
   cheap/mid)*.
8. Checks (post-build): typecheck → design adherence → action parity vs
   inventory → integration gate → finish guard ◇ overclaim? → deploy →
   browser acceptance ◇ result: **pass** → ◇ human-visible change? → yes:
   *pending operator verification* (Operator confirms) / no: *succeeded*;
   **platform-owned/pre-existing failure** → *shipped, attributed "not
   yours"*; **app-owned failure** → *cycle failed* → Models: **failure
   diagnosis (top tier)** → Operator: ◇ send fix (one tap) → loop to 7 (redo
   carries prior-attempt context; escalation ladder climbs one tier).
9. Steady state loop: Operator review (≈15 min) → next request → node 6.
   Side paths off node 9: Annotate, Design options, Screen check, Redo,
   Archive/Rehydrate.

Mark loops 3, 7–8, and 9 visually as cycles; mark node 4 as the single
irreversible gate.

---

## Terminology and tone rules

- Say **operator** or **Builder** for the human; never "user" for the AI's
  counterpart. Nothing in the system is called an "agent".
- The stages are **Plan → Design → Build → Run** (the internal names Concept/
  Define may appear in screenshots; use the public four).
- Models are a routed *team* (cheap/mid/top tiers), not one AI. Name the
  behavior ("the top tier plans, the cheap tier types"), not vendor SKUs,
  except in one cost sidebar where real numbers are allowed.
- Honest-completion vocabulary matters: "pending verification", "shipped —
  not yours", "the contract" (the design inventory). Keep these exact.
- Tone: confident, concrete, numbers over adjectives. Costs and minutes from
  this document may be cited as "typical". No marketing superlatives; the
  system's credibility *is* the honesty machinery, so let it carry the pitch.
