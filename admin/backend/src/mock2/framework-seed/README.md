# Mock2 framework seed — vendored framework content

This directory is the **vendored source** of the framework version ProxyPilot
publishes. On the first *enabled* boot it is inserted as version 1
(`framework.js` → `seedFrameworkV1()`); on every later boot where any file here
differs from the latest published version, `upgradeFrameworkFromSeed()` publishes a
**new** version and projects adopt it through the drift → update-cycle path
(automatically when `framework_auto_adopt` is on). It is inert source on disk: on a
disabled or production-pinned host nothing here is read, imported, or installed
(ADR-001). The registry is append-only and content rows are immutable (ADR-003).

## Current guidance adoption (2026-10-22)

The embedded Mock2 source release is **1.35.0**, family `mock2-core`, scope
`guidance`. `upstream-guidance.json` retains 33 canonical guidance files and their
release hashes. The platform constitution includes the pinned current
constitution after the retained platform contracts. New project seeds carry
these documents under `.mock2/standards/` with VERSION and PROVENANCE.json.
Existing project files require an explicit hash-aware rollout; publishing a
framework version does not certify their local files or deployed application.

Regenerate offline with `node scripts/sync-mock2-guidance.mjs <source-directory>`.
Every required source file is checked against release.json before output.
Source release.json SHA256 at adoption:
`7a3eea91ef84f43033386da14c7735b5fb1805ba2f624b8d4abe2991bc40fab6`
(1.35.0, 2026-10-22; previous adoption 1.23.2 on 2026-10-17 was
`745cb748d94f4ae229b1c4731fc26f10d1e3ba28403f774399ecd6ea1512574d`).

CPR remains specification **1.1**, framework registry integers and the base-app
scaffold are separate version families. Relay reference **1.2.1** is described
by the guidance; its runtime and ongoing producers are **not installed by this
seed**. Integration foundations are instructions for new builds; existing
connections and schemas are not migrated by adopting standards. Existing
dependency release lines are preserved.

## Stack and application foundation (2026-10-24)

Constitution §2 is now **"The stack and the application foundation"**, a platform
contract written from the user's decisions of 2026-10-24
(`docs/features/app-foundation.md`). It says, in binding rules:

- PostgreSQL + pgvector from the foundation is the only application database,
  provisioned when the application is created; a missing or unreachable database is
  an explicit failure, never a fallback.
- SQLite and other engines are refused unless the user explicitly asked for one and a
  person recorded that request on the project (the builder cannot create the record;
  the prompts quote it).
- Object storage only through the foundation `storage` adapter (bundled SeaweedFS by
  default, any S3-compatible provider); embeddings and vector search only through the
  foundation adapters (local model by default, with a production-quality warning;
  OpenAI or an OpenAI-compatible provider). Feature code never uses an S3 SDK or an
  embedding HTTP API directly.
- Secrets are encrypted in the database, never in env files or the repository.
  Per-deployment switches never delete data. An embedding model or dimension change
  re-embeds into a new validated index. Health is reported truthfully.

**Precedence.** The pinned upstream guidance below the marker supersedes historical
general-workflow wording only. §2 says that it does not supersede §2, and the
generated header line says the same thing. The header comes from
`pinnedGuidanceHeader()` in `scripts/sync-mock2-guidance.mjs`, so a later re-sync
keeps it. The pinned upstream bytes and hashes are unchanged.

The build skill's stack sentence (`skills.json`) carries the same rules in short.
`base-app/lib/db.js` no longer falls back to a hard-coded `DATABASE_URL`; it fails
with `DATABASE_URL_REQUIRED`. The upstream text that closes the same gaps in
mock2-core is drafted, not published, in `docs/mock2/upstream/2026-10-foundation/`.
`standards-version.json` still names upstream **1.35.0**; its `local_amendments`
entry records this ProxyPilot amendment and the upstream version it is proposed for.

## Portable Git readiness adoption (2026-10-22)

The pinned canonical release additionally supplies six files: `.mock2/git-readiness.md`
and the five-module `.mock2/bin/git-readiness*.mjs` dependency closure. The sync script
checks every included file against the release hashes and permits only static
relative imports within that named slice plus Node builtins. A missing module,
changed byte, application dependency or release-path escape refuses acquisition
before any generated seed is written.

New project seeds can run `node .mock2/bin/git-readiness.mjs --inspect` locally
without a hosting-provider account. The separate runtime provenance is
`git-readiness-local-inspection`; the general guidance scope remains `guidance`.
This does not run an installer, attach a provider, fetch/push a branch, replace
project history or deploy an application. ProxyPilot's existing host/connector
operations retain their authorization and durable-job boundaries. A canonical
application-intake `project-setup.mjs` command applies only to clients that have
that runtime; it is not installed by this narrow readiness adoption.

Guidance bytes and readiness-tool hashes are recorded independently in seeded
`PROVENANCE.json`. Existing projects use their explicit additive, hash-aware
standards rollout; a framework version publication is not a claim that every
existing checkout or running application has already adopted the tool.

## Task continuity convention (2026-10-21)

Constitution §15 and one sentence in the build skill add the task-continuity
convention: `AGENTS.md` is every session's entry point and reading order
(`CLAUDE.md` → `state/work.md` → `state/decisions.md` →
`state/tasks/<task-id>/task.json` + `handoff.md` → `state/handoff.md` →
`.mock2/standards/`); each task keeps its own checkpoint folder (schema
`mock2-task@1`, documented in `state/tasks/README.md`); on ProxyPilot the
database is authoritative and Flightdeck rewrites those files; files never
authorize anything (an investigation never authorizes a build), the person's
newest instruction wins, a resumed build verifies uncertain operations before
repeating them, and no state file holds credentials or personal data. The file
contents come from `mock2/continuity-convention.js`; `template.js` seeds them
into new projects, and existing projects gain `AGENTS.md` and
`state/tasks/README.md` only where those paths are absent. Like any seed edit,
this publishes a new framework version on the next boot
(`upgradeFrameworkFromSeed`); projects adopt it through the usual drift → update
path. The pinned upstream guidance and `standards-version.json` are unchanged.

## Historical platform rendering (2026-09-05)

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
| `constitution.md` | `constitution_md` | **v2** — rule 0, the stages, CPR §13, change records + production checklist §14, on top of the hardened v1 sections (§4 identity, §5 gated shells, §7 end-to-end done, §7a no silent simulation, §9 deviations, §11–12 acceptance); §2 the stack and the application foundation (2026-10-24, a platform contract the pinned guidance does not supersede) |
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

- `base-app/` — a **reference implementation** (the "Upload Doc" portal: auth +
  LDAP + RBAC + lifecycle + SSE, PostgreSQL through `lib/db.js`, near-zero
  dependencies, plain CommonJS). It is **not installed** into projects: see *The
  other "base app"* below. Its own docs are `base-app/RUNBOOK.md`; read the
  **Required configuration** table there before running it (`DATABASE_URL` is
  always required; `APP_BASE_URL` is mandatory in production).
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

1. **The application foundation** (projects created after the 2026-10 revision;
   `docs/features/app-foundation.md`): one Docker Compose stack in the guest with
   PostgreSQL 18.6 + pgvector 0.8.7, SeaweedFS S3 and a local embedding model, and
   the platform-owned `foundation/` module the app uses to reach them. Storage and
   embeddings can each be turned off per deployment; nothing is deleted. Secrets
   are encrypted in the database, never in env files. Constitution §2 is the
   binding text.
2. **The auth component** (`proxypilot-auth.component.json`): local + LDAPS
   sign-in, JWT access tokens with rotating refresh, DB-driven RBAC with
   per-role permission overrides, and the first-administrator bootstrap.
3. **The platform module** (`mock2/scaffold-platform.js`): theme, mobile
   styles, editable Privacy/Terms pages, branding, API keys, read-only SQL.
4. **The Mock2 standards' repo files** (`mock2/template.js` →
   `mock2StandardsSeedFiles`): `CLAUDE.md` / `.github/copilot-instructions.md`
   (the per-repo constitution pointing at the standards site), `state/rules.md`
   with status tags, `state/production-checklist.md`, `state/decisions.md` (the
   CPR decision ledger), `state/change-records/README.md`, `.mock2/README.md`;
   the task-continuity files `AGENTS.md`, `state/work.md`, `state/handoff.md`,
   `state/tasks/README.md`; and `npm run check` + `check:*` scripts in
   `package.json`.
5. **The CPR Host component** is in the library (not pre-installed): a build
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
