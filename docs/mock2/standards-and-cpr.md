> Current adoption (2026-10-17): the framework seed includes hash-verified
> Mock2 **1.23.2** guidance (previously 1.14.0, 2026-10-03). See `framework-seed/README.md` and
> `scripts/sync-mock2-guidance.mjs`. Framework integer, scaffold, CPR 1.1 and Relay
> 1.2.1 are independent identities. Historical instructions below describe the
> earlier 0.3.0 rendering. Guidance adoption alone does not install Relay
> runtime/producers or migrate existing integrations.
>
> **Adoption policy (2026-10-18).** An available site release is adopted
> automatically while live guidance is on (§4): it becomes the guidance in every
> project's build prompt, and with `live_guidance_auto_rebuild` on, idle projects
> rebuild against it unattended. With live guidance off (frozen), an available
> site release requires reviewed adoption into a ProxyPilot build (§3) — updating
> unchanged ProxyPilot code cannot install it. Adopting a site release changes the
> constitution's pinned block (the guidance in the build prompt) and the
> `.mock2/standards/` files of NEW projects only; existing projects' files change
> only through an explicit, hash-aware rollout. The platform's own constitution
> sections, skills and gates still change only through the seed (§3).

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

Guidance-only releases no longer need this procedure: live guidance (§4) adopts
them at runtime. Vendoring a release into the seed (`node
scripts/sync-mock2-guidance.mjs <release-dir>`) still raises the offline floor.

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
   block says the site release is adopted at the next live guidance check, or —
   with live guidance off (frozen) — that a reviewed ProxyPilot build must adopt it.

Publishing site changes *from* ProxyPilot: edit the seed under `/opt/app/site` on
the `mock2` guest (`write_lxc_file`), write `/opt/app/site/.publish` with the commit
message, then `rerun_startup` — `publish.sh` commits to `mock2/mock2-core` on
`main`, the webhook syncs the checkout, and every developer picks it up at the
next chat. Never edit `/var/www/mock2` directly; it is reset to `origin/main`.

## 4. Live guidance: the site is read at runtime

*2026-10-18.* ProxyPilot reads the Mock2 guidance from the standards site at
runtime, pinned, hash-verified and cached, with the vendored seed as the floor.

**Where it reads.** The pinned standards source is the manifest URL in the
`mcp.standards_source_url` app setting (`set_standards_source` only — it is not in
`set_setting`'s writable list, because it chooses build content), else the seed's
`standards-version.json` `manifest` (`https://mock2.fractionate.ai/manifest.json`).
`release.json` is read from beside it and each file from `<site>/<src>`.
`check_proxypilot_update` and the Update block compare against the same pinned
manifest. Only the release entries the seed carries are downloaded
(`core/claude/CLAUDE.md`, `core/claude/rules/*`, `core/cpr/*`, the CPR profile and
the capacity template).

**Limits.** https only, no redirects; 15 s per request and 2 min per run; each
body is streamed with a byte counter and cut off at 4 MB; an entry that declares
more than 4 MB, or a release selecting more than 200 files, is refused before any
download.

**What it checks.** If `release.json`'s version is not newer than the active
guidance, nothing else happens. If it is newer but every selected file has the
same sha256 as the active guidance (a version-only release), it is recorded as
checked (`content_matches_version`) and nothing is downloaded or published.
Otherwise every selected file is downloaded and checked against `release.json`
(sha256 **and** byte count), target paths must be unique and the required
documents present — the same selection, checks and rendering the sync script runs,
from one module (`admin/backend/src/mock2/guidance-release-logic.js`), so the
vendored and the live guidance cannot drift.

**Integrity, stated plainly.** The hashes come from `release.json` on the same
site. That proves the set is complete and arrived intact; it does not prove who
wrote it. The site is the operator's own (published from `mock2/mock2-core` on
git.fractionate.ai); whoever can publish there can publish guidance here. Pin the
source to a host you control.

**What adoption changes.** A framework version is published through
`upgradeFrameworkFromSeed` — the path a seed upgrade takes — with the
constitution's pinned block (the guidance in every build prompt) rendered from the
release, `source: 'git_sync'`, `source_git_commit: 'mock2-core@<version>'` and the
site + release.json hash in the changelog. Projects adopt it like a seed upgrade:
the auto-adopt sweep starts update builds on idle projects when
`framework_auto_adopt` **and** `live_guidance_auto_rebuild` are on; otherwise the
manual update cycle. Only NEW projects get the release's `.mock2/standards/`
files (their `PROVENANCE.json` records `delivered_from` and `release_sha256`);
existing projects keep their files.

**Where it lands.** After every file verified, the release is written to a temp
directory and renamed into `$MOCK2_DATA_DIR/guidance/<version>/` (`release.json`
exactly as fetched + `upstream-guidance.json`). The pointer `current.json`
(version, site, release.json sha256, time) is replaced atomically only once a
framework version carries the release. The last two versions are kept.

**When it runs.** At boot the cache is loaded first (local only; re-checked
against its own `release.json` and the recorded hash; ignored when it came from a
different source than the one now pinned), so a restart republishes nothing; then
the site is checked in the background (5 s after boot) and daily; and on demand
with `refresh_standards_guidance` over MCP.

**No downgrade on a lost cache.** If the cache is missing, damaged or ignored at
boot while the latest framework version carries newer guidance than the seed,
the boot seed upgrade keeps that version's pinned block and applies only platform
changes (`mock2/framework-upgrade.js`); the live check then re-fetches the
release. Until it does, new projects get the seed's `.mock2/standards/` files.
Changing the pinned source never downgrades either: a lower release from the new
source is reported as `blocked` until `reset_to_seed`.

**Failure.** Offline, timeout, HTTP error, oversize body, bad release identity,
a hash or size mismatch, a missing file: nothing is written, the active guidance
stays as it is, and the error is reported (`get_standards_version` → `guidance`,
`check_proxypilot_update` → `standards.guidance`, the dashboard card). A publish
that throws puts the active guidance back, so the next check retries; a publish
that changes nothing is reported as `already_published` (`published: false`).
Nothing is thrown at boot.

**The seed is the floor.** Live guidance is used only when it is newer than the
vendored seed. When a ProxyPilot update ships a seed at or past the cached
release, the seed wins and the cache is ignored.

**Off means frozen.** With `live_guidance` off nothing is fetched and the active
guidance stays exactly as it is — including a site release adopted earlier. Off
does not roll back.

**Rollback.** `refresh_standards_guidance` with `reset_to_seed: true` (and
`confirm: true`; `dry_run: true` shows the plan) publishes a framework version
with the seed's guidance through the normal publish path (the one deliberate
guidance downgrade), deletes the cache, and turns `live_guidance` off so the same
release is not adopted again at the next check. Ledgered and audited. This is how
a bad or hostile release (say `99.0.0`) is undone without touching files; turn
live guidance back on once the site is fixed.

**Control.**

| | |
|---|---|
| Settings | `live_guidance` in `mock2_settings`, `on` by default (off = frozen). `live_guidance_auto_rebuild`, default in ONE constant, `LIVE_GUIDANCE_AUTO_REBUILD_DEFAULT` in `mock2/settings.js` (currently `on` = rebuilds as for any version); off = auto-adopt skips site-sourced versions. Dashboard: Dev Studio → Framework versions → **Live guidance** (both switches). API: `GET/POST /api/mock2/settings/live-guidance` `{ setting?, auto_rebuild? }` (admin; audited `MOCK2_SETTING_LIVE_GUIDANCE`). |
| Source | `set_standards_source` (MCP; its confirmation states the build consequence). |
| Check now | MCP `refresh_standards_guidance`: `dry_run: true` reads `release.json` only and returns what would change; `confirm: true` runs the refresh; `reset_to_seed: true` is the rollback. Ledgered and audited like every extended-surface write. |
| Status | `get_standards_version` → `guidance` (active origin seed/site, version, both settings, last check time, result, error, `content_matches_version`); `check_proxypilot_update` and the Update block → `standards.guidance`, comparing the pinned site with the active guidance. |

Code: `mock2/guidance-release-logic.js` (pure, shared with the script),
`mock2/live-guidance.js` (fetch → verify → cache → publish, reset; dependencies
injected), `mock2/framework-upgrade.js` (the publish, with the guidance floor),
`mock2/active-guidance.js` + `mock2/guidance-status.js` (in memory),
`mock2/live-guidance-instance.js` (the real boundaries), boot wiring in
`index.js`. Tests: `__tests__/live-guidance.test.js`.

What is not live: the platform's own constitution sections, `skills.json`,
`gates.json` and the design system still change only with the seed (§3); the
Gitea raw API is not used (the site serves the release files directly); a
`default_git_connector` setting that pre-fills project remotes is still missing
(`docs/features/git-remotes.md`).

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
