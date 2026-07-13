You are continuing the build of the Mock2 module inside ProxyPilot. A planning session read the whole codebase and produced this brief — do not re-derive the architecture, and do not trust your instincts over the citations below; they were verified against the code (and against a real generated project pulled out of a live container). Phases M0–M8 are built and merged to main, M9 (iteration/classifier/summary) and M10 (hardening) are separately specced. **Your job is the RUN phase: make the app the runner generates actually run inside the LXC and be served at the live URL, and make later chat/build cycles operate against that generated codebase.** This is the "runtime scaffold" deliverable flagged as still-owed in `docs/mock2/05-risks-and-open-questions.md` R8, plus the deploy/run step that consumes it.

## The problem, precisely

Today the loop is: Chat → mockup → **design approval** (extracts `state/inventory.json`, sign-off #1) → **Build** press → **audit** (rule questions to the editor, framework deviations to the admin queue) → when the gate clears, the **runner** (`mock2/runner.js` `startCycle` → `runCycle`) execs into the fenced container and, via its `write_file` tool, writes real application code into the working tree at `/srv/app`, runs the pinned gate battery, and checkpoints (git commit + push to the bare repo). **That part works** — a real project was verified in a live container: a full TypeScript app under `src/` (`app.ts`, `server.ts`, `config.ts`, `connections/`, `db/`, `lookup/`, `mappings/`, `middleware/`), `migrations/0001_init.sql`, and a `package.json` declaring Express 4 + Drizzle ORM + `pg` + Zod with scripts `dev: tsx watch src/server.ts`, `build: tsc`, `start: node dist/server.js`. `src/server.ts` binds the `web` port from `mock2.yaml` (via `config.ts`).

**But the app is never installed, never migrated, and never started.** The container's systemd unit is hardcoded to the placeholder static server:

```
# admin/backend/src/mock2/template.js  →  buildContainerSetupScript()
ExecStart=/usr/bin/python3 ${appDir}/serve.py
```

`serve.py` (`template.js` `serverPy()`) is a stdlib-only Python static server that serves `${appDir}/public` at `/` and `${appDir}/state/mockups` at `/_preview`. So the placeholder `public/index.html` ("Fly is live…") keeps owning the web port. The generated Express app sits in the repo, uninstalled and unrun. The Builder sees the placeholder forever and reasonably concludes "nothing is being coded" — when in fact code IS being written; it is just never executed.

There is **no** step anywhere in `admin/backend/src/mock2/` that runs `npm install`, runs migrations, or swaps `mock2-dev.service` from `serve.py` to the project's own start command. Confirm this yourself (`grep -rn "npm install\|mock2-dev\|ExecStart" admin/backend/src/mock2` returns only the placeholder wiring in `template.js`).

## Hard prerequisite you must verify first — egress

The generated app needs its dependencies, and `npm install` needs the network. Inside a provisioned container the ONLY egress after the M4 fence is the squid filtering proxy at `10.200.1.1:3128`. On the host this brief was written from, that proxy was **refusing connections** (`Could not connect to 10.200.1.1:3128 — Connection refused`), so `apt`/`npm` at runtime failed outright. **Before building anything below, confirm squid is up and the container can reach the npm registry through it** (the recent commits `mock2: egress-proxy preflight` / `fix squid IPv4 binding` are the relevant code; `admin/backend/src/mock2/egress.js` + the admin egress panel are where to look). The install step you add must run through the baked proxy env (`buildProxyConfigScript` already writes `http_proxy`/`https_proxy` into the container) and the project's egress allowlist must include the npm registry (and any other host the install needs). If the proxy is down, the Run phase cannot work — treat fixing/verifying it as step 0, not an afterthought.

> Note: the container-setup **bootstrap** apt installs (`python3`, `postgres`, and now `git`/`curl`/`nano`/`sudo`) run BEFORE the fence with direct NAT egress and are unaffected. Only POST-fence runtime egress (what `npm install` needs) goes through squid.

## What to build

Once design is approved, Build is pressed, and any audit questions are answered, the build must **write the code into the LXC AND make it run**, so the live URL serves the real app instead of the placeholder, and future chat/build cycles reference that generated codebase. Concretely:

1. **Declare how the app runs, in the manifest — never discover it.** `mock2.yaml` (ADR-005) already declares ports (`web: 3000`, `postgres: 5432`) and is parsed by `template.js parseManifestWebPort`. Extend the manifest schema with an explicit **run contract** the container obeys — e.g. `run: { install: "npm ci || npm install", migrate: "npm run migrate", build: "npm run build", start: "npm run start" }` (or a named runtime like `node-express`). The seeded scaffold writes this; the runner may update it. The container must NEVER guess the start command from file sniffing — declared, not discovered, exactly like ports.

2. **A "run the project" step that replaces the placeholder dev server.** After a cycle succeeds (`runner.js runCycle` reaches `finishCycle(..., { status:'succeeded' })` via `checkpointAndRecord`), a deploy step must, inside the container and through `mock2/host.js` (R3 — never a raw exec):
   - run the manifest `install` (through the proxy env),
   - run `migrate` against the in-container Postgres (ADR-008; Postgres is already installed + started best-effort by `buildContainerSetupScript`; `DATABASE_URL` is in `.env.example`),
   - optionally `build`,
   - rewrite `/etc/systemd/system/mock2-dev.service` `ExecStart` to the manifest `start` command (still binding the declared `web` port via `PORT`/`EnvironmentFile`), `systemctl daemon-reload`, and restart the unit.
   Decide deliberately WHERE this runs: (a) as a stage of the runner cycle after gates pass (before the success message, so "succeeded" means "running"), or (b) as a distinct post-build "deploy" job the audit/runner hands off to. Option (a) keeps "succeeded ⇒ live" honest and is preferred; whichever you pick, it holds the **checkout lock** (ADR-004 — it writes the container) and reports progress through the same `setJob(cycle.id, …)` channel the poll UI already renders (`getCycleJobStatus`; the frontend `CycleCard` shows `job.message`). Surface a clear terminal state: gates green **and** the app is serving, vs. gates green but deploy failed (install/migrate/start error) — the latter must be actionable, not a silent "succeeded".

3. **The seeded runtime scaffold (R8).** Today `buildSeedFiles` (`template.js`) seeds the placeholder: `serve.py`, `public/index.html`, `mock2.yaml`, `state/mockups/.gitkeep`. `project_template_ref` names the intended scaffold `builtin:mock2-ts-express-drizzle-v1` but the seed is still the placeholder. Replace the seed with the real TS/Express/Drizzle scaffold that matches the framework constitution (`admin/backend/src/mock2/framework-seed/`) and the generated apps' shape (Express + Drizzle + pg + Zod, `src/server.ts` binding the manifest `web` port, a `migrations/` dir, the manifest run contract). Keep the `/_preview` mockup-serving behavior working during the Concept stage — the scaffold's dev server (or a thin front door) must still serve `state/mockups` at `/_preview` until design approval, then serve the real app at `/`. Decide how the two coexist (e.g. the real dev server also mounts `/_preview`, or the swap happens at approval). The placeholder `serve.py` may remain as the pre-build/idle fallback, but a built project must be served by its own runtime.

4. **Future chat references the generated codebase.** After the first successful build, subsequent Build cycles already re-enter the same container working tree (the runner reads/edits `/srv/app`) and the framework "build"/"review" stage skills apply. Verify the runner's context actually reflects the current codebase (it reads files on demand via `read_file`; make sure the system prompt / task orientation points at the real project structure, not the placeholder). The Concept chat is design-time; once approved and built, the loop is Build cycles against the living codebase — confirm that path is coherent (no stale "public/index.html is the site" assumption once a real runtime scaffold serves it). The `public/` served-root hint added to `buildRunnerSystemPrompt` (`runner-logic.js`) was a stopgap for the placeholder; revisit it so the runner's mental model matches the real scaffold's layout.

5. **Idempotency on rehydrate + restart.** `provision.js bringUpFromRepo` runs `buildContainerSetupScript` on BOTH create and rehydrate, and the M9 idle-stop lifecycle stops/starts containers. A rehydrated or restarted container must bring the **built** app back up (its systemd unit persists in the repo/working tree or is re-derived from the manifest), not silently revert to the placeholder. Make the run contract survive archive→rehydrate (it's in `mock2.yaml`, which is in the repo — good) and make container restart start the real app (systemd `WantedBy=multi-user.target` already does this for the unit; ensure the unit content reflects the built app after a build).

## Files you will touch (verified citations)

- `admin/backend/src/mock2/template.js` — `serverPy`, `placeholderIndexHtml`, `buildSeedFiles` (the seed — R8 scaffold replacement), `buildContainerSetupScript` (the `mock2-dev.service` unit + bootstrap installs), `buildProxyConfigScript`, `parseManifestWebPort`, `DEFAULT_WEB_PORT`. The manifest run-contract + the dev-server swap live here.
- `admin/backend/src/mock2/provision.js` — `bringUpFromRepo` (shared create+rehydrate), `APP_DIR='/srv/app'`, `REPO_MOUNT='/srv/repo.git'`, manifest read. Where a first-boot "install + start the built app" hook belongs if not in the runner.
- `admin/backend/src/mock2/runner.js` / `runner-logic.js` — the cycle loop, `RUNNER_TOOLS`, `buildRunnerSystemPrompt`, `checkpointAndRecord`, `finishCycle`. If the deploy step is a runner stage, it goes after gates pass and before the success job message. `describeRunnerStep` already feeds the poll UI.
- `admin/backend/src/mock2/audit.js` — `proceedToBuild` (hands off to `startCycle`). If deploy is a separate job, this is where it chains after a green cycle.
- `admin/backend/src/mock2/host.js` — ALL container exec + host ops pivot through here (R3 / Docker+nsenter). The install/migrate/start commands run through it.
- `admin/backend/src/mock2/egress.js` + the admin egress allowlist — the npm registry (and any install host) must be reachable; verify squid is healthy (the hard prerequisite above).
- `admin/frontend/src/pages/ProjectDetail.jsx` (`CycleCard`) — already polls the cycle + shows `job.message` and reloads the preview on success (`onBuilt`). Surface the deploy sub-states (installing / migrating / starting / serving / deploy-failed) here; it must comply with `admin/frontend/MOBILE_FIRST.md`.
- `admin/backend/src/mock2/framework-seed/` — the constitution/skills/gates the scaffold must match. Content is real; only the runtime scaffold code is owed (R8).

## Read these first, in order (all in `docs/mock2/`)

- `00-original-brief.md` (the four stages — Concept/Define/Build/**Run**; the live-URL contract), `02-adrs.md` (ADR-003 framework pin, **ADR-004 the lock — the deploy step writes the container and MUST take it**, ADR-005 declared-ports/manifest, ADR-008 in-container Postgres, ADR-011 the disk-device repo mount), `03-data-model.md` (`mock2.yaml` manifest, `state/` layout, the derived-status `deriveProjectStatus` — add a "deploying"/"serving"/"deploy_failed" derived state to the SAME function, never a fork), `05-risks-and-open-questions.md` (**R8 — the runtime scaffold this phase delivers**; R3 host ops; R5 cost — an install step spends wall-clock, price/bound it).

## Hard constraints (same as every mock2 phase)

- **Absence (ADR-001):** a `MOCK2_ENABLED=false` host stays byte-for-byte unchanged; all new code is reached only through the gated router.
- **Naming (R7):** the AI build component is the RUNNER; nothing is named "agent".
- **Migrations append-only:** if you need schema (e.g. a deploy-status column or a `mock2_deploys` table), append a new migration (check the current high-water mark in `db.js`; never edit an applied one).
- **Host ops (R3):** every container exec + systemd write goes through `mock2/host.js` (Docker → `nsenter -t 1`).
- **The lock (ADR-004):** the deploy step writes the container → it takes the checkout lock as the cycle/deploy holder and releases it.
- **Declared, not discovered (ADR-005):** the run command comes from `mock2.yaml`, never from sniffing files.
- **Egress fence (M4):** the install runs through the baked proxy env + the project allowlist; do not punch a hole in the fence. If the registry isn't reachable, the deploy fails loudly with an actionable message — do not disable the fence to make it pass.
- **Cost (R5):** an install/build step consumes wall-clock and possibly model turns; bound it (timeout) and reflect it in status, like the cycle's budget guards.
- **Tests stub-first:** pure decision logic (manifest run-contract parsing, the deploy state machine, the systemd-unit rewrite string) in a `*-logic.js` unit-tested importing ONLY the pure module (never `db.js`/native/Incus). Thin native/exec in the sibling. Frontend passes MOBILE_FIRST.
- Default cloud model ids are NEVER hardcoded — if any new model call is added, load the `claude-api` skill and default to the latest Claude models.

## What "done" looks like

- Approve a design, press Build, answer the audit's rule questions → the runner writes the app into `/srv/app`, gates pass, **then the deploy step installs deps, runs migrations, swaps `mock2-dev.service` to the project's start command, and restarts it** — and the live URL now serves the real generated app, not the placeholder. The preview reload already wired in `CycleCard` (`onBuilt`) shows it without a manual refresh.
- A build whose deploy fails (install/migrate/start error, or egress unreachable) lands in a distinct, actionable state (not a silent "succeeded"), with the error surfaced and a retry path (the `retryCycle` / `mock2RetryCycle` retry affordance already exists for stalled cycles — extend it to deploy failures).
- Archive → rehydrate, and container restart, both bring the **built** app back up (not the placeholder).
- A second Build cycle edits the living codebase and redeploys; the runner's context reflects the real project.
- `cd admin/backend && node --test 'src/__tests__/*.test.js'` has no NEW failures beyond the 4 known environmental ones (`cves`, `incus`, `webauthn`, `vpn-mtu` — all `Cannot find package 'better-sqlite3'`; see `docs/known-issues.md`). `cd admin/frontend && npm run build` passes. A `MOCK2_ENABLED=false` host is byte-for-byte unchanged.

Branch off `main`, commit as `mock2-run: <description>`, open its own PR. Flag in your PR description whether the egress proxy was healthy in your environment (if not, the deploy path can be code-complete but unverifiable end-to-end — say so explicitly and note what remains to test once squid is up).
