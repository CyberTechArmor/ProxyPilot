# Mock2 framework seed — version 1

This directory is the **vendored source** for framework version 1, inserted into
`mock2_framework_versions` on the first *enabled* boot (idempotent — see
`framework.js` → `seedFrameworkV1()`). It is inert source on disk: on a disabled
or production-pinned host nothing here is read, imported, or installed (ADR-001).

## Status (risk R8): framework content is real; the runtime scaffold is the last piece

The framework **content** artifacts below are now authored from the operator's
*The Mock2 Framework* specification (v1.1, Fractionate LLC, July 2026), closing
most of risk R8. The one remaining piece is the **runtime scaffold** — the actual
TypeScript/Express/Drizzle/Zod/Vitest project code the container is seeded from,
which today is still ProxyPilot's M2 placeholder (`mock2/template.js`, a static
placeholder app). Upgrading that scaffold is a separate infra deliverable, not
framework content.

| File | Field | State |
|---|---|---|
| `constitution.md` | `constitution_md` | **real** — the org constitution (stack, scaffold, auth, security, the four stages) per framework §3/§6/§9 |
| `skills.json` | `skills_json` | **real** — the four stage skills (concept, define, build, review) as prompt templates, a JSON array |
| `gates.json` | `gates_json` | **real** — the deterministic Tier-1 gate battery (typecheck, constitution-lint, rule-coverage, security-scan, test) per framework §6.3 |
| `design-system.md` | `design_system_md` | **real (locked)** — the design system Stage-1 mockups must obey, from the operator's design reference |
| `project-template.ref` | `project_template_ref` | names the intended scaffold (`builtin:mock2-ts-express-drizzle-v1`); the runtime `template.js` implementation is still the placeholder |

### Why the gates are self-adapting

The gate scripts are ordinary POSIX-sh checks that run identically in the runner
container and ad hoc (framework §10.2). Because the runtime scaffold is still the
M2 placeholder, each gate **detects whether its toolchain is present**: a project
without a TypeScript app is skipped green (typecheck/lint/test), while a real
scaffold is enforced for real. The security-scan (committed secrets) and
rule-coverage ("rules exist but no tests") checks run on any stack. This keeps
M6's verify checklist green against the placeholder template *and* enforces the
constitution the moment the real scaffold lands — no gate edit required.

## When new content arrives (revisions)

Editing these files changes only what a **fresh** install seeds as v1 (the insert
is guarded to run once, when the versions table is empty). On a host that already
seeded v1, replacing these files does nothing until someone **publishes a new
version through the admin editor** — the registry is append-only and content rows
are immutable (ADR-003); a revision is a new monotonic version, never an in-place
edit of the v1 row. To ship this content to an already-seeded host, publish it as
v2 with a changelog that says so.
