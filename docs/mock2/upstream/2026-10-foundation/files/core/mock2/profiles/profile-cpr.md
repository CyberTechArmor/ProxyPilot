# PRO application profile

The Mock2 workflow — scope control, requirement traceability, durable decisions, handoffs,
verification provenance, independent review — is general and applies to any repository in any
language. This file is the other half: the technology choices that make up a **PRO application**.

It is the profile of every new PRO application, and every new PRO application starts on the
**application foundation stack**: PostgreSQL with pgvector, S3-compatible object storage and an
embedding service, provisioned by the host with the application (PRO current §W.6). It is not a
description of every Mock2 repository, and adopting Mock2 in an existing repository never rewrites
that repository's stack to match this profile.

A repository records its profile in `.github/copilot-instructions.md`:

```
Profile: cpr          # this document is in force
Profile: none         # an existing repository's own stack; only the general workflow applies
Deviations:
  - <what differs from the profile, and the one-line reason>
```

A new application records `Profile: cpr` with the foundation stack. An agent never records
`Profile: none`, a stack deviation or a database deviation for a new application. Another database
engine is never a deviation: it needs the developer's explicit request, recorded on the project by a
person in the host, outside anything an agent writes (PRO current §W.6).

An existing repository being adopted records the profile it actually follows and its deliberate
deviations. Differences from this profile are recorded as deviations, or raised under **Deviations
for decision** in `state/production-checklist.md` — never corrected by rewriting working code.

## First-time project and instance setup

New applications start with the existing `/mock2-init` entry point or resumable `/mock2-setup`.
Use `.mock2/application-setup.md` and `.mock2/bin/project-setup.mjs` to keep purpose, audience,
role/action/resource scopes, the initial data model, sourced research and conditional modules in
project-owned `state/application-blueprint.json` (PRO current §W). The base-app generator consumes
that definition; public landing, authenticated shell/admin and database are composed according to
the actual use case. Generated source belongs to the application and is not a runtime-package upgrade
mechanism. Features use the generated host centrally, not their own credential stores or resolvers.

The instance's `/setup` establishes its initial owner through the configured private bootstrap
mechanism and durable completion; it is distinct from project definition and user onboarding.
Adoption and standards upgrades preserve the current application and its blueprint. The host
provisions the foundation stack with a new instance; installing standards provisions nothing. A
selected external identity, job or retrieval capability still needs its declared host binding and
behavioral evidence; installing standards never provisions it or silently substitutes another.

## Server

For a new application, use `Stack-Versions.md` and `stack.versions.json` for exact selected
versions and tested compatibility scope. Existing applications retain their recorded release lines;
maintenance patching is the default unless the developer asks for an upgrade/migration.

- TypeScript with `strict: true`. No `any`; use `unknown` and narrow.
- ES modules, named exports, one responsibility per file.
- Express routers under `src/routes/`, one file per resource. Handlers are thin; logic lives in `src/services/`.
- Zod schemas are the single source of the request and response types (`z.infer`). Wire shapes live in `contracts/`, one file per resource, derived from the Drizzle schema where a table backs them; the routes parse with them and the client imports their types (PRO current §K.7). A schema used only inside one job may stay beside it.
- Drizzle for database access. Schema in `src/db/schema.ts`; migrations generated, never hand-edited; no raw SQL outside `src/db/`. Parameterization is a rule you follow, not a guarantee the library provides — see the security baseline on `sql.raw()`.
- PostgreSQL with pgvector, from the foundation stack, is the only application database. `DATABASE_URL` is required: a missing or unreachable database fails start-up with a message naming what is missing, never a fallback to a default URL, an in-memory store, a file or SQLite. SQLite and every other engine need the developer's explicit, recorded request (PRO current §W.6).
- Object storage only through the host storage adapter: the bundled S3-compatible default, or any S3-compatible provider configured per deployment. Bytes in object storage, metadata in PostgreSQL.
- Embeddings and vector search only through the host embeddings adapter and vector helpers. Feature code never imports an S3 SDK and never calls an embedding HTTP API directly.
- Secrets are held encrypted by the host and delivered sealed; a deployed instance never reads a password, key or token from an env file, a compose or unit file, or the repository. Non-secret settings stay environment-driven.
- Errors: throw typed errors, map to HTTP status in one error middleware. Never leak stack traces or DB errors to clients.
- Logging: structured (JSON) via the project logger; never `console.log` in committed code.
- Naming: `camelCase` for values, `PascalCase` for types and schemas, `kebab-case` for files.

## Client

- React at the selected registry version + TypeScript in `.tsx`, built by Vite; one Vite entry per app surface (`site`, `admin`, and any customer- or staff-facing app), each under `web/src/<app>/`, shared code under `web/src/shared/`.
- The build runs `tsc --noEmit -p tsconfig.client.json` before `vite build`; a type error fails the build. Vite does not type-check on its own.
- Tailwind utilities plus shadcn/ui primitives copied into `web/src/shared/ui/` — never a second component library.
- Colours, fonts and radii come from the host's `--t-*` palette tokens in `web/src/shared/theme/palettes.css`, scoped by `data-theme`. A surface never hard-codes a colour and never references another surface's class names. Where the repository keeps `state/design/tokens.json` (DTCG), `node .mock2/bin/tokens.mjs` writes the `--t-` custom properties to the CSS file the developer names (`"out"` under `$extensions.mock2`, or `--out`); it has no default output and writes nothing until one is named; whether the prefix becomes the repository's choice is OPEN (PRO current §K.8).
- Wire types shared with the server are `import type` from `contracts/`; nothing is hand-copied, and no runtime import from `src/` or `contracts/` reaches the browser bundle.
- API access goes through one `api.ts` per app: same-origin `fetch` with credentials, JSON errors mapped to a `userMessage` the UI can show.
- Live state goes through the host's realtime client (`web/src/shared/live.ts` or the Host SDK equivalent); never `new WebSocket` inside a feature.
- Vendored third-party code (a QR decoder, a codec) lives in `web/src/shared/vendor/` with a script that regenerates it and a test that checks it against upstream fixtures.

## Host capabilities

Features consume host capabilities through the Host SDK and never recreate auth, database access,
jobs, secrets, configuration, realtime, theming or AI access (PRO §5–§6, Addendum A.2). AI goes
through the capability layer — capabilities, not vendors; sealed credentials; every call metered
with a scope; a mock provider selectable in configuration. A mock or local development-quality
provider reports itself as such and is never reported as production-ready. A model never produces
a dollar amount.

Every feature declares a `feature.manifest.json` with namespaced permissions, owned migrations,
jobs, outbound hosts and the fakes its tests ship (PRO §7, Appendix B, A.6).

The application declares the capabilities it uses in `app.manifest.json` at the repository root —
name, reason and fake for each — and the host provisions from that declaration (PRO current §J.9).
The foundation stack is the exception that is not inferred: the host provisions it with every new
application, and `database`, `object_storage`, `embeddings` and `vector_search` are declared like
any other capability when the application uses them.
Flags, where the developer asks for them, are the optional `flags` capability: OpenFeature-shaped
evaluation with a default and a context, an in-memory fake under `tests/fakes/`, and an owner and a
removal follow-up per flag (PRO current §J.10).

For AI retrieval, embeddings and file/object data follow `AI-Data-Standards.md`: explicit extension
and index identities, authorized retrieval, source/chunk provenance, host ingestion jobs, private
S3-compatible objects with PostgreSQL metadata and a measured scale/replacement path. The foundation
stack's storage and embedding service are present from creation, each switchable off per deployment;
their presence is not a reason to build features the task does not ask for.

## Tests

- Vitest. Every service function has a unit test; every route has at least one request test. Test files sit beside the code as `*.test.ts`.
- Every external service has a fake under `tests/fakes/` and the suite runs green with no network. The foundation stack's storage and embeddings adapters have fakes too. Migrations and vector operations are tested against the real PostgreSQL + pgvector pair; a PGlite-only test does not establish them.
- Playwright for browser tests. Select on whatever expresses the behaviour most durably:
  - `getByRole` and `getByLabel` where the assertion is about user-facing behaviour and
    accessibility semantics. These are preferred for anything a person interacts with — the test
    then fails when the experience breaks, which is what you want it to detect.
  - a stable test id (`data-*`) where the contract is structural, where no accessible name is
    stable, or where the element is not user-facing.
  Either kind is a contract. A material selector-contract change is recorded in the change record
  and the affected tests are updated — without weakening what they assert.

## Verification

The check ids are fixed; the commands behind them are this profile's:

| id | command |
| --- | --- |
| `lint` | `npm run check:lint` |
| `types` | `npm run check:types` (`tsc --noEmit`, server and client configs) |
| `test` | `npm run check:test` (`vitest run`) |
| `e2e` | `npm run check:e2e` (Playwright, desktop and mobile projects) |
| `audit` | `npm run check:audit` |
| `secrets` | `npm run check:secrets` |

`package.json` gets `"check": "node .mock2/bin/check.mjs"`. A repository on another toolchain keeps
the ids and changes the commands in `.mock2/checks.json`; nothing in the workflow assumes npm.
Apply `rules/mock2-verification.md` for the current order and evidence rules. Browser checks that
consume production output depend on its build. Avoid duplicate type-check execution when a build
already records the same successful command against identical inputs; preserve the evidence and
keep the build's type-error failure behavior. Requiredness, scheduling, caching and freshness are
separate concerns. Optional checks have an explicit selection/result, not a silent omission.

Use one shared server resource budget across agents/worktrees and a worker cap inside each job.
Runtime `.mock2/cache/` and `.mock2/evidence/` are ignored local state. Keep redacted durable evidence
with the release when it must survive a checkout or be reviewed from another surface.

## Directory layout

```
src/routes/      HTTP
src/services/    logic
src/db/          schema and migrations
contracts/       Zod wire schemas from the database schema, shared by routes and client
foundation/      the host's foundation stack definition (compose.yaml) and adapters; host-owned
tests/fakes/     one fake per external service
web/src/<app>/   one Vite entry per surface
web/src/shared/  ui/, theme/, vendor/, types
state/           Mock2 state — always committed
.mock2/          framework files: capacity.md, checks.json, bin/, standards/ — always committed
mockups/         disposable Stage 1 mockups
app.manifest.json  the Base Platform capabilities the application uses, each with its fake
```
