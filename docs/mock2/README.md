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

## Decisions that need the operator's sign-off before their phase starts

These are argued in `02-adrs.md` and listed with alternatives in
`05-risks-and-open-questions.md`. None of them block Phase M0.

1. **Identity (blocks Phase M2's membership model at "who is a superadmin"):**
   ProxyPilot has **no LDAP/LDAPS anywhere** and its user store is SQLite, not
   Postgres. The plan reuses ProxyPilot auth and adds Mock2 roles on top;
   LDAPS becomes a separate, later feature. See ADR-007.
2. **Project databases (blocks Phase M2 container template):** No Postgres or
   PgBouncer exists on a ProxyPilot host today (they are unbuilt phases 4–7 of
   the core plan). The plan runs Postgres **inside each project container**
   instead of a shared cluster — a deliberate deviation from the brief. See ADR-008.
3. **Wildcard TLS mechanism (blocks Phase M1):** stock Caddy has no DNS-01
   provider; wildcard domains are currently downgraded to plain HTTP. Pick a
   DNS provider and one of the two mechanisms in ADR-009.
4. **Egress allowlisting mechanism (blocks Phase M4):** FQDN allowlists don't
   work as pure nftables rules; the plan uses a filtering egress proxy plus
   default-deny at the bridge. See ADR-010.
