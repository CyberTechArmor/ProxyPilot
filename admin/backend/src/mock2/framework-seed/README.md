# Mock2 framework seed — version 1 (⚠ PLACEHOLDER, risk R8)

This directory is the **vendored source** for framework version 1, inserted into
`mock2_framework_versions` on the first *enabled* boot (idempotent — see
`framework.js` → `seedFrameworkV1()`). It is inert source on disk: on a disabled
or production-pinned host nothing here is read, imported, or installed (ADR-001).

## Status: awaiting the operator's real content (risk R8 / Q3)

Phase M5's one outstanding **external prerequisite** is the operator's *current
Mock2 framework* — the real constitution prose, the four skills, the gate
scripts, the locked design system, and the project template. Per the phase
brief, that content **must be supplied by the operator**; this session did NOT
invent a constitution/skills/gates and pass them off as the operator's.

What is vendored here instead:

| File | Field | State |
|---|---|---|
| `constitution.md` | `constitution_md` | **placeholder** — labelled as such in-body |
| `skills.json` | `skills_json` | **placeholder** — the four skill slots named, bodies stubbed |
| `gates.json` | `gates_json` | **placeholder** — minimal no-op gate so M6 has a shape to pin |
| `design-system.md` | `design_system_md` | **starting point** — grounded in `docs/mock2/design/07-chat-mockup-design-reference.md` (operator-provided design surface), still marked provisional |
| `project-template.ref` | `project_template_ref` | the M2 built-in template reference |

## When the real content arrives

Drop the operator's real material into these files and **publish a new version
through the admin editor** (the registry is append-only; content rows are
immutable, ADR-003). Do **not** edit the already-inserted v1 row in place — a
revision is a new monotonic version. If v1 was already seeded from these
placeholders, the operator's first real content becomes v2 (or a revert-to-real
if they prefer), carrying a changelog that says so.

The seed insert is guarded so it runs **once** (only when the versions table is
empty). Replacing these files after v1 already exists does nothing until someone
publishes a new version — by design.
