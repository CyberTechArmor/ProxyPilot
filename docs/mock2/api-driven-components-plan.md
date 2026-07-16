# API-driven components: define-time selection + zero-token pre-install

Planning document. Goal: evolve the component library from "a catalog the build
runner *may* adopt" into **declared infrastructure the platform installs
deterministically** — so the mockup/define stage decides *which* components a
project needs (auth if it has users, bootstrap superadmin, LDAPS, RBAC base),
the platform writes them into the container **without spending a single model
token**, and the build stage's AI budget is spent only on the one thing that
genuinely needs it: wiring the approved mockup to the components' APIs.

Everything below was verified against the code on 2026-07-16; citations are
`file:line` under `admin/backend/src/mock2/` unless another root is given.

## 1. Where we are today (verified)

- Components are a **global published catalog** (`mock2_components` /
  `mock2_component_versions`, migration 516, `migrations.js:735-795`) of
  `{files[], usage_md}` bundles. Nothing about them is machine-readable beyond
  name/tags — no declared endpoints, config, connections, or dependencies.
- They reach a build **only through the build runner's prompt + tools**:
  `buildComponentCatalogSection` is injected at `runner-logic.js:327` (hand-rolled)
  and `runner-logic.js:730` (SDK CLAUDE.md); adoption happens when the *model*
  calls `materialize_component` (`runner.js:1315-1372`). The decision, the
  `get_component` inspection (up to 60k chars), and all wiring are token-spend.
- The **define/audit stage never sees the catalog** (`buildAuditSystemPrompt`,
  invoked `audit.js:293`, receives inventory + rules only), and the concept
  stage produces `state/inventory.json` (`concept.js:594-620`) with no notion
  of required capabilities or components.
- There is **no per-project selection**: no `mock2_project_components` table,
  no `state/components.json` artifact. The only project↔component link is
  submission provenance (`mock2_component_versions.source_project_id`).
- The ADP4 pilot project proved the pain: the auth need was rediscovered via
  rule questions (rule-q103/q104/q106/q107 in the request log), and a
  user-reset that should have been a stock operation cost a full audit+build
  cycle. The extracted `proxypilot-auth` component
  (27 files, ~150k chars — migrations, login page, RBAC, LDAPS, bootstrap CLI)
  is exactly the standard bundle this plan makes declarative.

**Foundations already in place (reuse, don't rebuild):**

- A **model-free container write path**, exported and callable outside any
  runner session: `writeFileInContainer` / `containerSh` / `execInContainer`
  (`runner.js:1414/1393/1397`) + `containerNameForProject` (`provision.js:70`)
  + the pure materialize helpers — manifest/sha256, exists-check, byte-exact
  verify (`component-logic.js:307-416`). The SDK runner's
  `materializeComponents` (`runner-sdk.js:598-617`) already runs one of these
  paths model-free before the loop starts.
- A **define-time confirmation mechanism** ready to carry "this app needs
  component X": audit questions → tappable chat choices → build gating →
  auto-resume (`audit.js:319-343`, `audit-logic.js:40-48`, `questions.js:60`).
- **Egress/connection governance** to hang component connections on:
  `mock2.yaml` egress declarations → `syncDeclaredEgress` → pending grant →
  admin approval → nftables (`egress-grants.js:71-139`, `provision.js:282`),
  and the integration manifest `state/integrations.json`
  (`integration-logic.js:21`, `schemas/integration-manifest.schema.json`).
- **Structured `state/` artifacts + checkpointing** at concept approval
  (`concept.js:620-642`) and the hash-chained change records for
  platform-authored commits.

## 2. Target flow

```
Concept (mockup)          Define (audit)                 Pre-build (platform)        Build (AI)
────────────────          ──────────────                 ────────────────────        ──────────
inventory.json gains  →   capability→component match  →  install confirmed        →  prompt lists the
required_capabilities     (pure code, no model);         components: files,           INSTALLED components
(has_users, needs_        component_suggestion           npm deps, migrations,        + their API tables;
directory, …)             questions confirm scope        egress, .env, manifest       AI only wires the
                          (LDAP on? roles?)              entries — 0 tokens           mockup to them
```

## 3. Design

### 3.1 Component contract: additive manifest fields (stay `proxypilot-component@1`)

`parseComponentImport` ignores unknown fields (`component-logic.js:233-256`),
so the format tag does not need to change; old documents stay valid, old
installs ignore the new fields. Add optional, validated fields:

```jsonc
{
  "format": "proxypilot-component@1",
  "key": "proxypilot-auth",
  // ... existing fields ...

  // What the component IS, for the selection matcher.
  "provides": ["auth", "auth.bootstrap-superadmin", "auth.ldaps", "rbac"],

  // When the define stage should suggest it (matcher hints + the question text).
  "requires_when": {
    "capabilities_any": ["users", "login", "roles"],
    "suggest_prompt": "This app has user accounts. Install the standard auth component (local password + bootstrap superadmin, optional LDAPS, role-based access)?"
  },

  // The wiring contract — what the build runner connects the mockup to.
  "api": [
    { "method": "GET",  "path": "/api/auth/bootstrap/status",     "summary": "canCreateSuperadmin flag drives the first-run form", "auth": "public" },
    { "method": "POST", "path": "/api/auth/bootstrap/superadmin", "summary": "first-come superadmin creation (race-safe)",         "auth": "public" },
    { "method": "POST", "path": "/api/auth/login",                "summary": "email/password (local or LDAPS)",                    "auth": "public" },
    { "method": "POST", "path": "/api/auth/refresh",              "summary": "rotate refresh token",                               "auth": "user" },
    { "method": "GET",  "path": "/api/admin/users",               "summary": "user management",                                    "auth": "role:admin" }
    // ...
  ],

  // Exported code surface the glue may use (names only — cheap to render).
  "exports": ["initAuth", "withAuth", "authRoutes", "adminAuthRoutes", "requireRole", "requirePermission", "wireLdapsFromConfig"],

  // Structured config — the machine half of usage_md §3.
  "config": [
    { "key": "AUTH_JWT_SECRET",    "secret": true,  "required": true,  "description": "HS256 signing key" },
    { "key": "AUTH_MASTER_SECRET", "secret": true,  "required": true,  "description": "derives the AES-256-GCM key for stored LDAPS secrets" },
    { "key": "ACCESS_TOKEN_TTL_SECONDS", "default": "900" },
    { "key": "LDAPS_TRANSPORT", "default": "ldapts", "enum": ["ldapts", "fake", "none"] }
  ],

  // External connections — pre-declares integration-manifest entries and egress.
  "connections": [
    {
      "id": "ldaps-directory",
      "transport": "ldaps",
      "optional": true,
      "egress": { "classification": "private", "port": 636, "protocol": "tcp" },
      "config_keys": ["LDAPS_TRANSPORT"],
      "live_verification": { "required": true }
    }
  ],

  // Deterministic dependency install (replaces "read usage_md and run npm install").
  "dependencies": { "runtime": ["cookie", "ldapts", "zod"], "peers": ["drizzle-orm", "express", "pg"], "dev": ["vitest"] },

  // Files under this dir are SQL migrations; installer renumbers to append
  // after the project's existing migrations/*.sql.
  "migrations": { "dir": "migrations", "renumber": "append" }
}
```

Implementation:

- Validation lives in `component-logic.js` as new pure functions
  (`validateComponentContract` etc.), enforced in `parseComponentImport` and in
  the create/new-version routes; stored as one `contract_json` column on
  `mock2_component_versions` (immutable per version, like `files_json`) — new
  numbered migration in `migrations.js`. Caps: ≤64 api entries, ≤48 config
  keys, ≤8 connections, ≤64 provides/exports; strings length-capped like tags.
- `buildComponentExport` includes the fields; re-import round-trips.
- `ComponentLibrary.jsx` renders the contract (API table, config table,
  connections) read-only; authoring stays JSON-first (import/export), which is
  how components are produced anyway. Spec addendum in
  `docs/features/component-authoring.md`.
- `usage_md` remains the model-facing narrative; the contract is the
  automation-facing truth. Where both exist, automation reads only the
  contract.

### 3.2 Per-project selection: `mock2_project_components` + `state/components.json`

New table (append-history where it matters, matching house idioms):

```
mock2_project_components(
  id, project_id, component_id, version_id,
  status  CHECK IN ('suggested','confirmed','declined','installed','install_failed'),
  origin  CHECK IN ('concept','define','operator'),
  options_json,          -- confirmed choices, e.g. {"ldaps": true}
  selected_by, decided_at, installed_at, install_manifest_json,  -- path/bytes/sha256 of what landed
  created_at, updated_at, UNIQUE(project_id, component_id)
)
```

Mirrored repo artifact `state/components.json`
(`{schema_version:1, entries:[{key, version, status, options, api:[…]}]}`) —
written at confirm and install time, checkpointed like the other `state/`
artifacts, so the container, the gates, and the change history all see the
selection. Template seeds it empty next to `state/integrations.json`
(`template.js:222-224`).

### 3.3 Concept stage: extract required capabilities

Extend the inventory-extraction prompt (`buildInventoryExtractionPrompt`,
`concept-logic.js:209`, call at `concept.js:594-599`) to also emit a
`required_capabilities` block into `inventory.json`:

```jsonc
"required_capabilities": {
  "users": true,            // the mockup shows accounts/login/roles — not a static site
  "roles": ["admin", "staff"],
  "external_directories": ["ldap"],   // only if the brief/mockup mentions it
  "notifications": false
}
```

This costs nothing extra — it rides the model call that already runs at design
approval. It is a *hint*, not a decision: the decision is made by the matcher +
operator confirmation in define.

### 3.4 Define stage: deterministic matching + confirmation

In `runAudit` (`audit.js:272`), before the model call:

1. **Pure matcher** (`component-logic.js`, no model): join
   `inventory.required_capabilities` against published components'
   `requires_when.capabilities_any` / `provides`. Result: suggested components
   with their `suggest_prompt`. Insert `suggested` rows.
2. **New question kind** `component_suggestion` added to `EDITOR_KINDS`
   (`audit-logic.js:40`) so each suggestion renders as a tappable confirmation
   in the existing flow (`audit.js:319-325`), with per-component option choices
   (e.g. "Auth: local only / local + LDAPS"). Confirm → `confirmed` (+
   `options_json`); decline → `declined` (a later cycle can re-offer only if
   capabilities change).
3. The audit model prompt gains one short section: the *confirmed* component
   contracts (key, provides, api summaries) — so its rule questions stop
   re-litigating solved ground (no more "which credential do subsequent logins
   use" when the auth component's contract already answers it). This is a few
   hundred tokens of catalog metadata, never file contents.
4. Component `connections` raise their egress needs at confirm time: append to
   `mock2.yaml` `egress:` (host filled by an operator question when unknown) →
   existing `syncDeclaredEgress` + admin grant queue (`egress-grants.js:100-107`).

### 3.5 Pre-build install: `preinstallComponents(projectId)` — zero tokens

New server-side module (`component-install.js` + pure half in
`component-logic.js`), invoked from `proceedToBuild` (`audit.js:314`) after
questions clear and before `startCycle` (`audit.js:374`). For each `confirmed`,
not-yet-`installed` row, in library order:

1. **Files**: reuse the exact `materialize_component` internals — exists-check
   (`buildPathsExistScript`), `writeFileInContainer` per file, sha256 verify
   (`buildManifestVerifyScript`/`parseShaVerifyOutput`) — refactored out of
   `runner.js:1315-1372` into a shared function both the tool and the
   pre-installer call. Keep-existing semantics (never clobber adapted files on
   follow-up cycles).
2. **Migrations**: scan the project's `migrations/*.sql`, renumber the
   component's `migrations.dir` files to append after the highest prefix
   (`0001_auth.sql` → `000N_auth.sql`). The run contract already executes
   `npm run migrate` on deploy (`mock2.yaml` `run.migrate`), so no new
   mechanism is needed.
3. **Dependencies**: `npm install <runtime+peers>` (`npm install -D <dev>`)
   via `containerSh` with the fence's egress proxy as-is.
4. **Config**: append non-secret defaults to the project `.env`; **secrets are
   never written** — they become `required_config` items on the existing
   operator verification checklist (`verification-logic.js`
   `deriveVerificationChecklist`), which already carries exactly this hand-off.
5. **Integration manifest**: append entries derived from `connections` to
   `state/integrations.json` via `appendManifestEntry`
   (`integration-enforcement.js:239-246`) — pre-declared instead of
   runner-declared, so the B.4 gate sees an honest manifest from cycle start.
6. **Record**: update rows to `installed` with `install_manifest_json`; write
   `state/components.json`; audit-log `MOCK2_COMPONENT_PREINSTALL` (counts and
   hashes, never contents); commit as a platform-authored checkpoint in the
   hash-chained change records (cost: $0.00 — it appears in the request log's
   cost truth as a zero-token segment, mirroring how `define`/`build` segments
   report today).
7. **Failure**: mark `install_failed`, raise a queue item, and block the build
   cycle from starting (a half-installed component is worse than none).

Why pre-build rather than scaffold-time: selection only exists after concept
approval, and `proceedToBuild` is the single choke point both the first build
and every follow-up build pass through. Scaffold-time seeding
(`template.js:187-242`) stays reserved for a possible future "every project
gets X" baseline tier.

### 3.6 Build stage: wire, don't rebuild

- `buildRunnerSystemPrompt` / `buildRunnerClaudeMd` (`runner-logic.js:327/730`)
  gain an **"Installed components"** section generated from
  `state/components.json` + contracts: per component — version, file roots,
  the API table, exported guards, and the hard instruction: *these are already
  on disk and audited; wire the approved mockup to these endpoints and write
  only the glue (mounts per `usage_md` §2); do not rewrite or fork them.*
- The existing global catalog section stays, filtered to components **not**
  installed (still adoptable via `materialize_component` for unforeseen needs).
- `get_component` stays for reading integration notes of installed components.
- **Integrity report (not a hard gate initially)**: at finish, sha256 the
  installed components' files against `install_manifest_json` and attach a
  drift report to the cycle (`gates`/acceptance record). Glue-driven edits to
  component files are legitimate (e.g. `permissions.ts` is *meant* to be
  adapted); the report gives reviewers the diff surface without blocking. A
  follow-up can add per-file `adaptable: true` flags to the contract and harden
  the gate for the non-adaptable core.

### 3.7 Mockup alignment (later, optional)

Since the auth component ships `public/login.html` with fixed element IDs, the
concept stage's mockup prompt can be told (via the same contract) that the
login/bootstrap/setup flows are **stock screens** — the mockup then focuses on
the app's own pages, and wiring cost drops further. Deferred: it couples the
design system to component internals and needs the design-tokens story
(`concept.js:633-642`) thought through first.

## 4. Phasing (each independently shippable)

| Phase | Delivers | Touches |
|---|---|---|
| **C1 — Contract** | manifest fields + validation + `contract_json` column + export/import round-trip + library UI display; authoring-spec addendum; re-issue `proxypilot-auth` example with a full contract (`docs/features/examples/`) | `component-logic.js`, `components.js`, `migrations.js`, `routes.js`, `ComponentLibrary.jsx`, docs |
| **C2 — Manual pre-install** | `mock2_project_components` + `state/components.json` + `preinstallComponents()` + an operator **"Install into project"** action (admin, audit-logged) — proves the zero-token path end-to-end with no model changes | `component-install.js` (new), `component-logic.js`, `migrations.js`, `routes.js`, `template.js`, project UI |
| **C3 — Define-time selection** | `required_capabilities` in inventory extraction; pure matcher; `component_suggestion` question kind + chat UI; confirm→install in `proceedToBuild`; egress pre-declaration | `concept-logic.js`, `concept.js`, `audit-logic.js`, `audit.js`, `questions.js`, `egress-grants.js` callers |
| **C4 — Build wiring contract** | installed-components prompt section (both runners), catalog filtering, integration-manifest pre-declaration, integrity drift report | `runner-logic.js`, `runner.js`, `runner-sdk.js`, `integration-enforcement.js` |
| **C5 — Polish** | mockup alignment hints; `adaptable` flags + hardened integrity gate; component upgrade flow (new library version → queue item offering re-install, never auto-overwrite) | concept prompts, contract, queue |

House rules apply throughout: pure logic stub-first-tested in
`__tests__/mock2-*.test.js` with the DB stubbed at the module boundary; nothing
named "agent"; all mutations audit-logged; migrations append-only.

## 5. What this buys (the two asks, answered)

1. **Requirement-driven components**: the mockup/inventory now *declares*
   capabilities; a deterministic matcher plus one round of tappable
   confirmations turns them into a per-project component set with connections
   (LDAPS/egress) governed by the existing grant flow — and the build sees that
   set as installed infrastructure with a typed API surface to wire against.
2. **Zero-credit installation**: standard components land via the already-proven
   server-side write path (`writeFileInContainer`, sha-verified) plus
   deterministic npm/migration/env/manifest steps — no catalog reasoning, no
   `get_component` round-trips, no model-authored boilerplate. Model spend is
   confined to wiring the design to the contract, and it's faster: the build
   cycle starts with auth/RBAC/bootstrap already on disk and its migrations
   queued.

## 6. Risks / open questions

- **Follow-up cycles vs. keep-existing**: after the build adapts component
  files (e.g. `permissions.ts`), a re-run of the installer must not clobber
  them — keep-existing covers this, but component *upgrades* need the C5 queue
  flow, not silent overwrites.
- **Capability extraction quality**: `required_capabilities` is a model output;
  the matcher must treat it as a hint (suggest, never silently install), and
  the confirm step is the correcting human loop.
- **Migration renumbering** assumes the template's `migrations/*.sql` +
  `scripts/migrate.mjs` convention (it is the scaffold's own convention —
  `scaffold.js` — but the installer should verify before renaming and fail
  loudly otherwise).
- **Contract drift vs. reality**: nothing forces `api` to match the shipped
  routes. Mitigation: the C1 example is generated from the real module; a C5
  nicety could lint `api` paths against the component's route files at import.
- **Declined suggestions** must stay declined (no nag loop) yet re-openable
  when the inventory's capabilities genuinely change — key the suggestion on a
  hash of the matched capability set.
