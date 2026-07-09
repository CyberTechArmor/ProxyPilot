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
| `NEXT-SESSION-PROMPT-mock2-phase-0N.md` | One handoff prompt per subsequent phase; `-04` opens Phase M3 (archive/rehydrate), `-05` opens Phase M4 (network isolation). |

## Build status

M0 (skeleton/absence), M1 (parent domains + per-slug TLS), M2 (project registry
+ container + bare repo + live URL) and **M3 (archive & rehydrate, idle-stop
groundwork)** are implemented. The M3 host round-trip is verified by
`scripts/mock2-m3-verify.sh` on an enabled host (create → modify in container →
archive → rehydrate → same URL, then image-cache-delete → rehydrate again to
prove no snapshot dependency, ADR-006). The pure decision layer is unit-tested
stub-first in `admin/backend/src/__tests__/mock2-lifecycle.test.js`.

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
2. **Project databases — ACCEPTED.** Access control and all project
   details/chats stay in SQLite; each project runs its own Postgres inside
   its container, used only by that project's generated application. See
   ADR-008.
3. **TLS — ACCEPTED.** Per-slug Let's Encrypt HTTP-01 certs for v1; wildcard
   DNS points at the host; DNS-01 wildcard is the deferred upgrade path. See
   ADR-009.
4. **Egress allowlisting — ACCEPTED with a complexity guardrail.** Squid
   egress proxy, installed only when Mock2 is enabled, required to stay at
   the weight of the existing generated-config subsystems; fallback to
   bridge-isolation-only if it can't. See ADR-010 and
   `05-risks-and-open-questions.md` §Q6.
