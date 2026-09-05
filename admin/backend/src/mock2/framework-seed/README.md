# Mock2 framework seed — vendored framework content

This directory is the **vendored source** of the framework version ProxyPilot
publishes. On the first *enabled* boot it is inserted as version 1
(`framework.js` → `seedFrameworkV1()`); on every later boot where any file here
differs from the latest published version, `upgradeFrameworkFromSeed()` publishes a
**new** version and projects adopt it through the drift → update-cycle path
(automatically when `framework_auto_adopt` is on). It is inert source on disk: on a
disabled or production-pinned host nothing here is read, imported, or installed
(ADR-001). The registry is append-only and content rows are immutable (ADR-003).

## Where the content comes from (2026-09-05)

| Source | Version | What it governs here |
|---|---|---|
| **Mock2 standards** — `mock2/mock2-core` on git.fractionate.ai, served at https://mock2.fractionate.ai | **0.2.0** (2026-09-02) → **0.3.0** (2026-09-05, adds CPR) | Rule 0 (no gates; classify production-policy questions), the five-stage pipeline (Concept → Define → Build → Check → Run), rule status tags, the production checklist, the change-record format, `npm run check` scripts, the per-repo template files. |
| **Continuous Production Readiness (CPR)** — `cpr/CPR-v1.1.md` | **1.1** | Development first / no invented gates, host contract + host SDK, feature manifests, versioning, assurance outcomes (PASS / WARNING / BLOCK), readiness stages, decision ledger, roles. Shipped to projects as the `cpr-host` component. |
| *The Mock2 Framework* (Fractionate LLC, July 2026) | 1.1 | The fixed stack, the scaffold conventions, the auth pattern, the locked design system. |

The standards site is the newer, human-edited source; this seed is ProxyPilot's
**runtime rendering** of it (the platform needs the constitution as one document
the runner is prompted with, the checks as executable scripts, and the skills as
prompt templates). When the site changes, update the seed to match and publish —
see `docs/mock2/standards-and-cpr.md` for the procedure and for what a live link
to the Gitea repo would take. **Bump `standards-version.json` with the seed**:
it records the site version this seed renders (`0.3.0`, synced 2026-09-05), and
the dashboard's Update block and the `check_proxypilot_update` MCP tool compare
it with the live `manifest.json` to say "site X available — update ProxyPilot to
pick it up" (`mock2-standards-seed.test.js` checks it stays in step with the
table above).

| File | Field | State |
|---|---|---|
| `constitution.md` | `constitution_md` | **v2** — rule 0, the stages, CPR §13, change records + production checklist §14, on top of the hardened v1 sections (§4 identity, §5 gated shells, §7 end-to-end done, §7a no silent simulation, §9 deviations, §11–12 acceptance) |
| `skills.json` | `skills_json` | the four stage skills (concept, define, build, review) as prompt templates — v0.2.0 posture: `[draft]` rules, checks between changes, reviewer never blocks, phase-routing@1 contract kept |
| `gates.json` | `gates_json` | the deterministic check battery (typecheck, constitution-lint, rule-coverage, security-scan, test, ui-interaction, acceptance, component-reuse). The platform still calls them "gates" in report rows; read as production-checklist items. `security-scan`: committed secret = hard stop, dependency audit = recorded WARNING |
| `design-system.md` | `design_system_md` | **locked** — the design system Stage-1 mockups must obey (unchanged) |
| `project-template.ref` | `project_template_ref` | names the scaffold (`builtin:mock2-ts-express-drizzle-v1`); the runtime is `scaffold.js` |
| `standards-version.json` | — | the standards site version this seed renders (`version`, `synced`); compared with the live manifest by the self-update check |
| `cpr/` | — | the CPR v1.1 standard, a worked `feature.manifest.json`, and notes |
| `cpr-host.component.json` | component library | the CPR Host component, seeded at boot by `component-seed.js` |
| `proxypilot-auth.component.json` | component library | the auth component, seeded at boot |

### Why the checks are self-adapting

The check scripts are ordinary POSIX-sh and run identically in the runner
container and ad hoc. Each **detects whether its toolchain is present**: a project
without a TypeScript app is skipped green (typecheck/lint/test), while a real
scaffold is checked for real. `skipped` is reported as such — never as `passed`.

## Base application template + default design brief

- `base-app/` — **ProxyPilot's standard base application** (the "Upload Doc"
  portal: auth + LDAP + RBAC + lifecycle + SSE + JSON store, near-zero
  dependencies). A generated project starts from this tree so the plumbing costs
  nothing per project. Its own docs are `base-app/RUNBOOK.md`; read the
  **Required configuration** table there before deploying (`APP_BASE_URL` is
  mandatory in production).
- `design-brief.md` — the **default** design reference, with
  `design-brief-appendix.md` as its detailed component inventory. Default, never
  forced: any design direction a project supplies wins entirely and the brief
  only fills gaps. It reaches the generation AI as `§9` of `design-system.md`,
  which is what the concept/mockup prompts inject.
- `BASE-APP-MIGRATION.md` — what changed vs the previous base template
  (security fixes, the keep-alive robustness fix, new features), so an existing
  project can be diffed against it.

## What a new project is provisioned with

Every project starts as a **TypeScript / Express / Drizzle / PostgreSQL** app —
`mock2/scaffold.js` — with these wired in automatically before the AI ever
builds anything:

1. **The auth component** (`proxypilot-auth.component.json`): local + LDAPS
   sign-in, JWT access tokens with rotating refresh, DB-driven RBAC with
   per-role permission overrides, and the first-administrator bootstrap.
2. **The platform module** (`mock2/scaffold-platform.js`): theme, mobile
   styles, editable Privacy/Terms pages, branding, API keys, read-only SQL.
3. **The Mock2 standards' repo files** (`mock2/template.js` →
   `mock2StandardsSeedFiles`): `CLAUDE.md` / `.github/copilot-instructions.md`
   (the per-repo constitution pointing at the standards site), `state/rules.md`
   with status tags, `state/production-checklist.md`, `state/decisions.md` (the
   CPR decision ledger), `state/change-records/README.md`, `.mock2/README.md`;
   and `npm run check` + `check:*` scripts in `package.json`.
4. **The CPR Host component** is in the library (not pre-installed): a build
   adopts it with `materialize_component` when the first feature needs the host
   seam.

The AI builds *on top of* all of this. It adds feature tables beside the
platform tables and screens behind the auth gate; it does not re-implement any
of it.

### The other "base app"

`framework-seed/base-app/` is a **reference implementation** of the same
capabilities in plain CommonJS with no build step. It is deliberately NOT what
gets installed: the constitution, the check battery and the build skills all
require TypeScript/Drizzle/Zod/Vitest, so shipping a different stack would break
every build that followed. Read it to see a capability end to end; change
`scaffold-platform.js` to change what projects actually get.
