# Mock2 Module — Planning Bundle

This directory is the planning output for adding **Mock2** — a four-stage,
spec-driven AI development framework (Concept → Define → Build → Run) — as a
module inside ProxyPilot. It was produced by a planning session that read the
codebase; every claim about ProxyPilot's current state in these documents was
verified against the code and carries `file:line` citations.

**No application code was written.** This bundle exists so build sessions can
execute the plan phase by phase, the same way `docs/core/plan/` drives the
core-infrastructure work.

## Contents

| File | What it is |
|---|---|
| `00-original-brief.md` | The operator's Mock2 design brief, verbatim. The requirements source. Where it conflicts with the code, the survey and ADRs say so. |
| `01-survey.md` | What already exists vs. what is new, subsystem by subsystem, with the exact seams (files, functions, tables) a build session will touch. |
| `02-adrs.md` | Architecture Decision Records for the contested decisions — including the places where this plan deliberately deviates from the brief. |
| `03-data-model.md` | The Mock2 schema: every table, the migration numbering, and where state lives (orchestrator DB vs. project repo vs. container). |
| `04-phased-plan.md` | Ten phases, each independently testable and useful, with verification checklists and dependency ordering. |
| `05-risks-and-open-questions.md` | Risks the existing architecture creates, plus open policy questions the operator must answer (some block specific phases; none block Phase M0). |
| `NEXT-SESSION-PROMPT-mock2-phase-01.md` | Ready-to-carry handoff prompt for the first build session (Phase M0 + M1 groundwork), in the repo's established `NEXT-SESSION-PROMPT` format. |

## How to use this bundle

Same workflow as `docs/core/plan/00-how-to-use.md`:

1. Hand a build session the `NEXT-SESSION-PROMPT` for the phase (or point it at
   `04-phased-plan.md` + a phase number).
2. The session reads the relevant survey/ADR/data-model sections before coding.
3. Implement → run the phase's verification checklist → commit → move on.
4. After each phase lands, write the next phase's `NEXT-SESSION-PROMPT-mock2-phase-NN.md`
   recording what shipped and what the next session must not re-implement
   (mirror the style of `docs/core/plan/NEXT-SESSION-PROMPT-dashboard.md`).

## Operator sign-off status (reviewed 2026-07-09)

Argued in `02-adrs.md`, answers recorded in `05-risks-and-open-questions.md`.
Nothing blocks Phases M0–M1.

1. **Identity — ACCEPTED.** Built-in ProxyPilot auth for initial setup; LDAPS
   arrives later as the user-provisioning layer (LDAP authenticates, local
   flags authorize admin/editor/viewer/nothing). See ADR-007.
2. **Project databases — STILL OPEN, blocks Phase M2.** Postgres inside each
   project container vs. a shared cluster (nothing exists today either way).
   See ADR-008.
3. **TLS — ACCEPTED.** Per-slug Let's Encrypt HTTP-01 certs for v1; wildcard
   DNS points at the host; DNS-01 wildcard is the deferred upgrade path. See
   ADR-009.
4. **Egress allowlisting — AWAITING DECISION, blocks Phase M4 only.**
   Explained in plain language in `05-risks-and-open-questions.md` §Q6;
   recommendation is a squid egress proxy installed only when Mock2 is
   enabled. See ADR-010.
