# Atelier port — work file

Mission: port Atelier (docs/reference/atelier-prototype.html) into the base app, per the
operator's port prompt (Mock2 harness). This file is the running record; future sessions
rely on it, not chat memory.

## Status

- **Phase 0 (orient): DONE** 2026-07-31.
- **Phase 1 (extraction): DONE** 2026-07-31 — artifacts listed below.
- **⛔ STOPPED at the Phase 1 gate** awaiting human sign-off (Mock2 design approval + rules
  confirmation) before Phase 2. Open questions below.
- Phase 2 (build, 7 groups): NOT STARTED.

## Phase 1 artifacts (harness-referenced guides)

| artifact | path |
|---|---|
| Prototype (behavior + design authority) | `docs/reference/atelier-prototype.html` |
| Inventory (screens/fields/actions/states) | `state/inventory.json` |
| Confirmed rules (R1–R5, role matrix, pipeline) | `state/rules.md` |
| Design register (binding) | `docs/design/folio-light.md` |
| Schema draft + fixture set | `docs/design/data-model.md` |
| Harness wiring (read-before-edit rules) | `CLAUDE.md` § "Atelier port (Mock2)" |

## Phase 0 — repo map

This repo is the **ProxyPilot monorepo**, host of the Mock2 harness — not a standalone seed
app. The seed app the mission targets is vendored at
`admin/backend/src/mock2/framework-seed/base-app/` ("Upload Doc" portal: Node built-ins +
pg, auth + LDAP + RBAC + lifecycle + SSE, PostgreSQL system-of-record behind an in-memory
read model, `lib/store.js`). Framework content: `framework-seed/constitution.md` declares
the Mock2 project stack **TypeScript/Express/Drizzle/Zod/Vitest + PostgreSQL**;
`design-brief.md` is the default design reference (a project's own direction — here Folio
Light — wins entirely); gates are self-adapting POSIX-sh (`gates.json`). Auth/email exist as
components (`proxypilot-auth.component.json`, `proxypilot-email.component.json`). Mock2
runtime (M0–M4 implemented) provisions projects into isolated containers. Atelier already
exists here as an example prompt: `docs/mock2/example-prompts/atelier.md`.

No root `.mock2/` or `state/` existed before this session; `state/` was created for the
Phase 1 artifacts at the mission's literal paths.

## Phase 0 — prototype walkthrough (Playwright, 22/22 checks passed)

Every screen visited and screenshotted at 1440×900 (studio: dashboard, pipeline, inquiries,
forms, form builder, public form, library, automations, settings; project p1: overview,
inquiry, docs, doc editor, board, estimate (locked) + p2 estimate (live), proposal signed,
kanban, timeline, calendar, delivery, report; portal: home, docs, boards, proposal, files,
comments — the last six also at 360×780). Flows actually performed with assertions:

- Public form submit → lead created with answers; flow w1 fired (email + reminder).
- Lead convert → client + project at brief; brief doc seeded from answers.
- Kanban drag t9 review→done; timeline shows it done; calendar drops the done task (R1).
- Timeline bar drag → start/due shifted by day delta (R1).
- Calendar drag-create → multi-day booking via modal.
- Client (Priya) "Needs changes" on shared file → production task carrying the note,
  assigned to last uploader u3; file → changes; comment thread added (R4).
- Client (Daniel) signed proposal pr2 (typed + drawn) → estimate e1 locked, p2 →
  production, 2 audit rows appended, flow w2 seeded 8 tasks + sent email (R2, G7 shape).
- Client scoping helpers deny cross-client project access (R3 — UI-level only in the
  prototype; the port enforces server-side).
- All six portal tabs at 360×780: `scrollWidth ≤ clientWidth`, **zero console errors**.

Evidence (session scratchpad, not committed): `walkthrough.js`, `walkthrough-results.json`,
`shots/*.png`.

## Open questions for the sign-off (do not proceed past them by assumption)

1. **Where does Phase 2 build?** The mission says "port Atelier into the base app", but the
   base-app tree lives inside this monorepo at
   `admin/backend/src/mock2/framework-seed/base-app/` and editing seed files publishes a new
   framework version on next boot. Options: (a) build Atelier onto the base-app tree here,
   (b) run the port in a Mock2-provisioned project repo seeded from the base app (the
   mission's paths then match a project repo root), (c) a new top-level app dir in this
   monorepo. Phase 1 artifacts are placement-neutral and move with a `git mv`.
2. **mock2-adopt not run.** The mission says to run it if `.mock2/`/`state/` are missing —
   but adopting the whole ProxyPilot monorepo would derive a second constitution over the
   existing CLAUDE.md/LEARNINGS.md harness and baseline-review the entire product, which
   contradicts "CLAUDE.md remains the authority" and clearly exceeds the seed-app intent.
   Conflict surfaced per the working agreement instead of resolved by assumption.
3. **ORM mapping.** Schema draft targets the constitution stack (Drizzle/PostgreSQL). If
   Phase 2 builds directly on the base-app tree instead, the alternative is its
   `lib/store.js` slice model. Decision follows from question 1.
4. **Rules confirmation.** `state/rules.md` (R1–R5, role matrix, pipeline semantics,
   supporting rules) needs explicit human confirmation — the Mock2 rules sign-off.
5. **Design approval.** `docs/design/folio-light.md` + the prototype constitute the design;
   needs the Mock2 design approval.

## Phase 2 plan (after sign-off)

Groups, one mock2-build cycle each, in order: 1 Foundation (projects/roles/portal shell,
block editor, form builder → lead → conversion) · 2 Money (estimate grid, proposal pages,
PDF, e-signature/R2) · 3 Production trio over one task store (R1) · 4 Delivery (files,
versions, share, R4) · 5 Concept boards · 6 Automations (DB-backed event consumers,
scheduled date_reached) · 7 Dashboard + comments/presence. Gates G1–G7 join the battery as
deterministic Playwright tests. Production-reality requirements per the mission (real
migrations, real sessions + server-side R3 test, storage/email behind interfaces, full
signature forensics, no silent stubs).
