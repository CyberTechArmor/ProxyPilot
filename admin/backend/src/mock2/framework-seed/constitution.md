# Mock2 Framework Constitution — v1 (PLACEHOLDER)

> ⚠ **This is a placeholder, not the operator's real constitution (risk R8).**
> Phase M5 wires up the framework registry and its seed mechanism; the actual
> constitution prose is owed by the operator and must replace this file before
> the runner (M6+) builds against real user intent. Do not treat the text below
> as governing policy — it exists only so the registry has a well-formed v1 to
> pin and diff against.

## Purpose

The constitution is the top-level, human-readable statement of how a Mock2
project is allowed to be built: the non-negotiable rules the runner and the
generated application must honor, independent of any single project's own
`rules.md`.

## Placeholder principles (to be replaced)

1. **Isolation first.** The generated app runs inside its fenced project
   container; it reaches only its allowlisted egress hosts (M4).
2. **Declared, not discovered.** Topology comes from `mock2.yaml`; nothing is
   auto-exposed (ADR-005).
3. **The repo is the source of truth.** Every change is a commit; archive and
   rehydrate go through the bare repo, never a snapshot (ADR-006).
4. **Rules belong to editors; standards belong to admins.** Domain questions
   append to the project's `rules.md`; framework deviations go to the admin
   queue (ADR-002).
5. **Design obeys the framework design system.** Mockups the model generates
   conform to `design_system_md` of the pinned framework version (ADR-003).

_Replace this entire document with the operator's real constitution._
