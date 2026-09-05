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

1. Read `manifest.json` on the site (version + changelog) and diff `core/` against
   the last version recorded in `framework-seed/README.md`.
2. Fold the change into `constitution.md` / `skills.json` / `gates.json` (the
   runner's contract strings — `phase-routing@1`, `cite file:line from the diff` —
   must survive; `mock2-framework.test.js` checks the bundle validates).
3. Record the new site version in `framework-seed/README.md` and here.
4. Boot the backend: `upgradeFrameworkFromSeed` publishes the new version; projects
   adopt it (auto-adopt sweep, or a manual update cycle).

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
3. **Project remotes on Gitea by default** — the `gitea` git connector already
   exists (`git-logic.js`, `ModelConnectors.jsx`); `bootstrap.py` on the guest
   already creates a `fractionate` org. Make a Gitea connector the default
   `push_on_checkpoint` remote for new projects (one row in `mock2_project_remotes`
   at `create_project`), so every project's history is on git.fractionate.ai and
   the site, the template repo and the project repos share one host.

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
