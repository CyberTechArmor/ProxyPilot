> Current adoption (2026-10-22): the framework seed now includes hash-verified
> Mock2 **1.35.0** guidance and its dedicated local Git-readiness slice
> (previous guidance adoption 1.23.2, 2026-10-17). See `framework-seed/README.md` and
> `scripts/sync-mock2-guidance.mjs`. Framework integer, scaffold, CPR 1.1 and Relay
> 1.2.1 are independent identities. Historical instructions below describe the
> earlier 0.3.0 rendering. An available site release requires reviewed adoption;
> updating unchanged ProxyPilot code cannot install it. Guidance adoption alone
> does not install Relay runtime/producers or migrate existing integrations.
>
> 2026-10-24: constitution §2 is now **"The stack and the application foundation"**,
> a platform contract that the pinned guidance does not supersede (§7 below). The
> matching upstream amendment was **published as mock2-core 1.39.0** on 2026-10-25
> (commit `8e2eaf7`, from `docs/mock2/upstream/2026-10-foundation/`), and the seed now
> pins 1.39.0.
>
> 2026-10-30: mock2-core **1.42.0** (release-train lessons; core `2154827`) and **1.43.0** (provider-scoped
> model tiers, workflow and attribution; core `3e57c5c`) were **published** from
> `docs/mock2/upstream/2026-10-release-train-and-model-tiers/`. The seed still pins 1.39.0; adopting them is
> separate reviewed work.

# Mock2 standards, CPR v1.1, and how ProxyPilot tracks them

*2026-09-05.* This note records where the Mock2 standards live, how ProxyPilot's
vendored framework seed relates to them, how CPR v1.1 was brought in, and what a
live link to the Gitea instance would take. Read it before editing anything under
`admin/backend/src/mock2/framework-seed/`.

## 1. The three sources

| Source | Where | Owner | How it reaches people |
|---|---|---|---|
| **Mock2 standards** (`mock2-core`) | Gitea `mock2/mock2-core` on git.fractionate.ai; served at https://mock2.fractionate.ai from a checkout on the `mock2` LXC guest (push to `main` → webhook → `site-sync.sh`) | operator | `curl -fsSL https://mock2.fractionate.ai/install.sh \| bash` writes `~/.claude/CLAUDE.md`, `~/.claude/rules/mock2-*.md`, `~/.copilot/{prompts,agents,hooks}` and `~/.mock2/` on a developer machine; the SessionStart hook re-installs when `manifest.json` changes version |
| **CPR v1.1** (Continuous Production Readiness) | the operator's `Continuous_Production_Readiness_v1.1.docx`; now rendered to Markdown at `framework-seed/cpr/CPR-v1.1.md` and published on the site as `core/cpr/CPR-v1.1.md` (installed to `~/.mock2/standards/CPR-v1.1.md`) with the rule `core/claude/rules/mock2-cpr.md` | operator | same installer, standards v0.3.0 |
| **ProxyPilot framework seed** | `admin/backend/src/mock2/framework-seed/` | this repo | published as a framework version at boot (`upgradeFrameworkFromSeed`); the runner is prompted with `constitution_md`, `skills_json`, `design_system_md`, and runs `gates_json` |

The site is the human-edited source of truth. The seed is ProxyPilot's *runtime
rendering* of it, because the platform needs one prompt-sized constitution,
executable check scripts, and skill templates — not a set of files for
`~/.claude`.

## 2. What changed in this update (seed v2)

- **Rule 0** (mock2-core v0.2.0; CPR §3.1/§11.3): nothing blocks building or
  testing; production-policy questions are classified (implementation requirement /
  configurable capability / production checklist item / recommendation); intentional
  real-path testing is allowed; the platform's battery is the automated half of the
  production checklist.
- **Stages**: Concept → Define → Build → **Check** → Run; a Builder may start at any
  stage; rules carry `[draft]` / `[confirmed]` / `[observed]` tags.
- **Change records + production checklist** (constitution §14): the standards'
  record format and `state/production-checklist.md`.
- **CPR §13** in the constitution: features consume host capabilities, declare
  `feature.manifest.json`, namespaced permissions, expand → migrate → contract,
  decisions are durable (`state/decisions.md`), roles.
- **Skills**: build keeps going on a red check and records what it left failing;
  the reviewer walks the checklist, lists findings by severity, never blocks.
- **security-scan**: committed secret = hard stop; `npm audit` finding = recorded
  WARNING (was blocking).
- **Scaffold**: `npm run check` + `check:lint|types|test|audit|secrets`; seed files
  `CLAUDE.md`, `.github/copilot-instructions.md`, `state/production-checklist.md`,
  `state/decisions.md`, `state/change-records/README.md`, `.mock2/README.md`.
- **CPR Host component** (`cpr-host`) seeded into the component library: host
  contract 0.1.0, host SDK, manifest schema, reference host adapter.
- **MCP server instructions** now point chat clients at the standards and at the
  project's constitution files.

Deliberately **not** changed: the gate battery's blocking semantics at finish
(the runner still drives red items green where it can, and the finish-guard budget
hands the cycle to the operator otherwise — that *is* the human decision the
standard asks for), the hash-chained `state/changes/` spine, the locked design
system, the platform's deploy path (blue/green slots, release registry and
no-build rollback are CPR Base Platform responsibilities — see §5).

## 3. Updating the seed when the site changes

### Git readiness slice

`scripts/sync-mock2-guidance.mjs` also acquires the pinned canonical Git readiness
guide and dedicated `git-readiness*.mjs` static dependency closure. Source files
must match release hashes and remain within the acquired release. Arbitrary
application modules, external packages, dynamic imports and path escapes are
refused before outputs are written. `upstream-guidance.json` keeps these files
in `runtime_files`, with `runtime_scope: git-readiness-local-inspection`;
`template.js` emits them and records their hashes in project provenance.

This makes the read-only local CLI available in newly seeded projects. Local
Git does not require GitHub or Gitea. A configured external connector remains a
separate host capability: seed acquisition does not install Git, attach a
remote, fetch/push or execute the consuming client's privileged operations.
The canonical application-intake setup runtime is not part of this slice;
its status command applies only when that runtime is installed by the client.
Existing projects require their normal explicit hash-aware additive rollout;
publishing a seed version alone does not establish local or deployed adoption.

1. Read `manifest.json` on the site (version + changelog) and diff `core/` against
   the last version recorded in `framework-seed/README.md`.
2. Fold the change into `constitution.md` / `skills.json` / `gates.json` (the
   runner's contract strings — `phase-routing@1`, `cite file:line from the diff` —
   must survive; `mock2-framework.test.js` checks the bundle validates).
3. Record the new site version in `framework-seed/README.md`, in
   `framework-seed/standards-version.json` (`version` + `synced` — this is what the
   dashboard's Update block and `check_proxypilot_update` compare with the live
   `manifest.json`; `mock2-standards-seed.test.js` fails if the two disagree), and
   here.
4. Boot the backend: `upgradeFrameworkFromSeed` publishes the new version; projects
   adopt it (auto-adopt sweep, or a manual update cycle). Deployed hosts get there
   by updating ProxyPilot — Profile → Application Settings → Update now, or
   `run_proxypilot_update` over MCP (`docs/features/self-update.md`); the Update
   block says "site X available — update ProxyPilot to pick it up" until they do.

Publishing site changes *from* ProxyPilot: edit the seed under `/opt/app/site` on
the `mock2` guest (`write_lxc_file`), write `/opt/app/site/.publish` with the commit
message, then `rerun_startup` — `publish.sh` commits to `mock2/mock2-core` on
`main`, the webhook syncs the checkout, and every developer picks it up at the
next chat. Never edit `/var/www/mock2` directly; it is reset to `origin/main`.

## 4. Could ProxyPilot link to the Gitea instance so projects always reference it?

Yes. Nothing in the architecture prevents it; three pieces are missing, all
modest:

1. **A standards source setting** — `mock2.standards_url`
   (`https://mock2.fractionate.ai/manifest.json`) and/or the Gitea repo
   (`https://git.fractionate.ai/mock2/mock2-core`, raw file API
   `/api/v1/repos/mock2/mock2-core/raw/<path>?ref=main`). Stored in
   `mock2_settings` like the other settings in `settings.js`.
2. **A sync step** — at boot and on a timer: fetch `manifest.json`; if `version`
   differs from the `source_git_commit` / changelog marker of the latest framework
   version, fetch the `core/` files, render them into the five content fields
   (constitution = site `CLAUDE.md` + rules + the platform's hardened sections;
   skills = the four prompt files; gates = the battery with `check:*` names) and
   call `insertFrameworkVersion({ source: 'git', sourceGitCommit })`. The registry
   already has the `source` and `source_git_commit` columns (migration 501) for
   exactly this. Projects then adopt through the existing drift → update path.
3. **Project remotes on Gitea by default** — done per object (2026-09-05, see
   `docs/features/git-remotes.md`): the New project dialog, the static-site
   wizard and the LXC create dialog all take an optional Gitea remote, with the
   repository created on the remote when missing; existing objects get the same
   card on their page. What is still missing is a `default_git_connector` setting
   that pre-fills it for every new object.

Constraints to keep: the site's rendering is *derived* content, so the sync must
never overwrite the platform's hardened constitution sections silently — render
the site's constitution into a marked block and keep the platform sections
outside it; content rows stay immutable (a site change is a new version, never an
edit); the Gitea token lives encrypted in `mock2.db` as the connectors' do and
never enters a container. The vendored seed remains the offline fallback.

Until that lands, the seed is updated by hand as in §3, and every project already
carries the pointer (`CLAUDE.md` in the scaffold, and the MCP instructions).

## 5. Does an AI subscription using the MCP server get the Mock2 / CPR guidance?

Two lanes, deliberately different (`routes/mcp.js`, "project build control"
comment):

- **Harness lane** (a build started from the UI, on the project's own configured
  model credential): the runner is prompted with the pinned framework version's
  `constitution_md`, the stage skill, the design system, the installed-components
  section, and runs the check battery. Mock2 + CPR guidance is **in the prompt**.
- **MCP / chat lane** (Claude Code, Claude Desktop, a claude.ai custom connector,
  any MCP client on the operator's subscription): ProxyPilot only executes file
  ops — read, patch, commit, redeploy — and exposes tool descriptions plus the
  server instructions. It does **not** inject the constitution, skills or design
  system. Whatever the client's model knows about Mock2/CPR comes from the
  **client side**: the synced `mock2-*` skills in Claude Code, the `~/.claude`
  rules the standards installer writes, and now the project tree itself
  (`CLAUDE.md`, `state/*`) and the instructions' STANDARDS pointer. A claude.ai
  connector user with none of those installed gets the standards only through the
  pointer and the files.

So: the subscription's built-in Claude is doing the thinking, and it is guided by
Mock2/CPR only to the extent the client or the project tree supplies it. To make
the MCP lane first-class, add either an MCP **resource** (`mock2://standards/
constitution`) served from the current framework version, or a `get_standards`
tool the instructions tell the client to call first; both are small additions to
`lib/mcp-logic.js` + `routes/mcp.js` and reuse `getCurrentFrameworkVersion()`.

## 6. Where CPR is not yet real

Recorded per CPR §20 in `CPR-IMPLEMENTATION-FINDINGS.md`:

- Blue/green candidate slots, the Release Registry UI and no-build rollback
  (§12) — ProxyPilot deploys a single dev slot; the `cpr-starter` host exposes
  `/healthz`, `/readyz`, `/platform/host` but no slots yet.
- `auth`, `identity`, `secrets` capabilities are **unbound** in the reference host
  (they throw by name); binding them to the auth component is a per-project step
  documented in the component's `usage_md`.
- The `@cpr/*` packages are versioned 0.1.0 and the internal registry
  (`10.185.17.239:4873`) holds no published packages yet; the component vendors
  the sources instead.
- Boundary/manifest analysis (declared vs actual dependencies, §10.1) is not a
  gate in the battery.

## 7. The application foundation and constitution §2 (2026-10-24)

The user decided on 2026-10-24 that every new application gets the application
foundation (`docs/features/app-foundation.md`): PostgreSQL + pgvector, SeaweedFS S3
(replaceable by any S3-compatible provider) and a local embedding model, as one
Compose stack in its guest; per-deployment switches that never delete data; secrets
encrypted in the database, never in env files; and no SQLite unless the user
explicitly asked and a person recorded it on the project.

**What ProxyPilot changed (its own text).**

- `framework-seed/constitution.md` §2 is rewritten as binding rules: the stack, the
  foundation's three services, one database with no fallback, the recorded SQLite
  exception that nothing in the repository can create, the storage and embeddings
  adapters as the only path, encrypted secrets, switches that never delete data, one
  vector space per index, truthful health, and existing projects left alone. §3
  (config), §5 (secrets) and §13 (host capabilities) now agree with it.
- **Precedence lives in two places.** §2 ends with a *Precedence* paragraph that names
  each upstream sentence it overrides for new Dev Studio applications (profiles,
  `Profile: none`, "adoption never rewrites a stack", "never provisions external
  services", "AI alone does not select", automatic embedding failover, "SQLite as the
  production database"). The generated header above the pinned block says the same in
  one line. That header comes from `pinnedGuidanceHeader()` in
  `scripts/sync-mock2-guidance.mjs`, so a re-sync keeps it; the pinned upstream bytes
  and their hashes are unchanged.
- The build skill's stack sentence (`skills.json`), the seed README (base-app is a
  reference implementation, not installed) and `base-app/lib/db.js` (no hard-coded
  `DATABASE_URL`; it fails with `DATABASE_URL_REQUIRED`) follow.
- `standards-version.json` names upstream 1.39.0. Its `local_amendments` entry
  records this amendment as `published-adopted` (2026-10-25, commit `8e2eaf7`). The
  self-update check reads only the fields it knows, so the dashboard's Update block
  and `check_proxypilot_update` are unaffected.

**How §2 reaches a project and the model.**

1. A changed seed publishes a new framework version on the next boot
   (`upgradeFrameworkFromSeed`). New projects pin it; existing projects adopt it through
   the drift → update path (automatically when `framework_auto_adopt` is on).
2. Each build cycle pins a framework version, and the runner puts its whole
   `constitution_md` into the system prompt under *Organizational constitution (pinned
   — this is binding, not advisory)* (`buildRunnerSystemPrompt` in `runner-logic.js`,
   called from `runner.js` and `runner-sdk.js`). That covers every build mode (full,
   MVP, quick) and both harnesses (the copilot harness reuses the same builder). An
   operator prompt override still receives it through `{{CONSTITUTION}}`. The audit
   prompt (`audit.js`) injects it the same way.
3. The repository's `.mock2/standards/constitution.md` is the upstream text only,
   byte-identical to the pin, so it does **not** contain §2. The repository's own
   `CLAUDE.md` comes from `template.js`. Over MCP nothing is injected (§5 above), so an
   MCP client sees the foundation rules only if the project tree states them.

**Upstream.** `docs/mock2/upstream/2026-10-foundation/` holds the mock2-core 1.39.0
amendment that closes the same gaps upstream: one patch for 14 files, full copies of
the five most changed, base and result hashes, the changelog entry and the order to
apply. It was checked against hash-verified 1.38.0 bytes; nothing was published. When
it is published and adopted with the sync script, §2 and the header line stay as they
are, and the `local_amendments` entry moves to adopted.
