<!-- Kickoff prompt: post-MVP cleanup + package audit + terminal v2 -->
<!-- Sibling files: terminal-mvp.md, terminal-mvp-prompt.md (terminal MVP spec, completed). -->

# Post-MVP cleanup + package audit + live-terminal v2

You are picking up a single-tenant, internet-exposed ProxyPilot install
that already has the full security bundle landed: P.1 (JWT-secret
production guard), Phase M (revocable JWT sessions, 4h sliding idle,
logout-revokes, list/revoke endpoints, stale-row sweep), Phase J
(account lockout, 10 failures / 30 min / 30 min lockout, countdown UI),
Phase K (sudo-mode re-auth on destructive routes, 4h sliding TTL,
auto-retry modal). The streaming-terminal MVP also landed: PTY-backed
WebSocket terminal at `/admin/shell` (admin-only) and on the
LxcContainers "Terminal Beta" tab. The data-layout split (`data/db/`
0700 vs `data/services/` 0755) and the cookie+CSRF auth path are in
place.

This session has **three concerns**, in order. Do them on **one branch,
one PR**, but commit each item independently so the operator can
unwind any individual change. Do not rush the terminal replacement —
it is the biggest piece and benefits from the MVP discipline of one
checklist item, one commit, one push.

## Branch

Cut a fresh branch from the latest `main` (post-merge of PR #146,
which fixed the Host Shell viewport sizing).

    git fetch origin main
    git checkout main
    git pull origin main
    git checkout -b claude/post-mvp-cleanup-<your-session-suffix>

Push to that branch throughout. One PR at the end against `main`.

## Hard segmentation rules (the harness will hang otherwise)

Inherited from prior sessions, non-negotiable:

1. **Reads ≤ 200 lines.** Always pass `offset` + `limit`. Use Grep
   first to locate the line, then a tight Read. Some files are 7000+
   lines (services.js); reading whole files will hang.
2. **Edits are targeted.** Use Edit with old_string / new_string blocks
   carrying just enough surrounding context to be unique. Never
   rewrite a whole file via Write unless the file is brand-new or
   under ~200 lines.
3. **Long-running commands run in the background.** `npm install`,
   `npm audit`, `vite build`, `docker compose build`, the dev backend
   — all go through `run_in_background: true`. Read output later via
   BashOutput. Never block a tool call on a slow process.
4. **TodoWrite checkpoints between segments.** Update the todo list
   after every meaningful step.
5. **One checklist item = one commit. Push after every commit.**
6. **If a segment hangs, cancel and split.** Never retry the same
   over-large operation.
7. **One concern per commit.** Cleanup commits, audit commits, and
   terminal commits stay separate even though they share a branch.

## Read, in order, before touching code

1. `docs/features/post-mvp-cleanup/kickoff-prompt.md` — this file. You
   are reading it now.
2. `docs/features/terminal/terminal-mvp.md` — full MVP spec, already
   complete. Reference for the existing terminal architecture
   (especially the wsAuth + spawnTerminalPty + attachTerminalServer
   composition).
3. `update.sh` lines 1–60 + 480–570 — the bootstrap section + the
   restart block where the host-side `npm install` lives. Don't read
   the whole 770+ line file; use grep + tight reads.
4. `admin/backend/Dockerfile` (50 lines, full read fine) — confirms
   that the Docker build does its own `npm install --omit=dev` in the
   alpine builder with python3 + make + g++ already present.
5. `admin/backend/package.json` + `admin/frontend/package.json` —
   short, full read fine. Source-of-truth for what `npm audit` will
   examine.
6. `admin/frontend/src/components/InteractiveTerminal.jsx` (170
   lines) — the live-terminal component you'll be extending with a
   cwd prop.
7. `admin/frontend/src/pages/LxcContainers.jsx` lines 79–371 — the
   legacy `ContainerTerminal` component (request-response). This is
   what you are replacing in task 4. Read just that window.
8. `admin/frontend/src/pages/LxcContainers.jsx` lines 1500–1620
   AND 1970–2020 — the tab triggers + tab content for "Terminal" and
   "Terminal Beta". The tab structure is what you'll be reshaping.

Do NOT read other files unless an edit's old_string requires more
context. Do NOT re-read sections of `services.js` already covered by
prior session work unless your edits demand it.

## Lessons inherited from prior sessions

1. **Update.sh self-update bootstrap.** `update.sh` does
   `git pull origin main` partway through its run, but the running
   shell continues with the OLD copy of itself in memory. Migrations
   added to the new `update.sh` do NOT execute on the same run that
   pulled them — operators must run `update.sh` again. Mentioned in
   PR #142's recovery note. If your cleanup affects update.sh logic
   that needs to run on the same run as it lands, an `exec "$0" "$@"`
   re-exec right after the `git pull` is the right fix. Don't add it
   speculatively — only if a cleanup item demands it.

2. **Docker rebuild does its own npm install.** The host-side
   `npm install` for backend deps is **redundant** in a Docker
   deployment because `Dockerfile`'s `backend-builder` stage runs
   `npm install --omit=dev` in alpine with python3+make+g++ already
   apk-added. The host has no make / g++, so node-pty's prebuild
   falls back to `node-gyp rebuild` and fails noisily. The deploy
   succeeds anyway because docker captures the deps. This is task 1.

3. **Migrations framework is in place.** Reserved versions used: 1, 2,
   3, 4, 5, 6 (M sessions), 7 (J lockout). Next available: 8. If you
   need to register a new schema migration, use
   `runMigration(db, 8, 'descriptive_name', (d) => { ... })`. Do not
   inline `CREATE TABLE` outside the framework.

4. **JWT_SECRET production guard is fail-loud.** Any cleanup that
   touches `.env` handling must preserve the guard's expectations:
   real 64-byte random secret, never the dev fallback string.

5. **Sessions table revokes per-jti.** Any new endpoint that issues
   tokens must go through `generateToken(user, { ip, userAgent })` so
   the session row exists. Anything that reads `req.user` already
   has `req.session` populated by `authenticateToken`.

6. **Sudo gate is sliding 4h.** Any new destructive endpoint added
   during this session should mount `requireSudo` after the
   router-level `authenticateToken`. Existing examples:
   `services.js:3271` (DELETE /:id), `lxc.js:1215`
   (DELETE /containers/:name), `user.js:660/724/1275/516`.

7. **Forced re-login on M.2 deploy already happened.** The first
   update past the M.2 commit invalidated every active token. This
   has already shipped — no further forced-logout events expected.

## Task 1 — Cleanup

Goal: silence the noisy `node-pty` gyp error during `update.sh` runs
on Docker deployments. The deploy already works; this is purely
quieting the log.

Implementation:

- **C.1** Detect Docker deployment **early** in `update.sh` (before
  the `[4/7] Installing backend dependencies` step). The detection
  test should mirror the late-stage logic already in update.sh
  (around line 530): if any of `/opt/proxypilot/docker-compose.yml`,
  `$SCRIPT_DIR/docker-compose.yml`, or
  `$(dirname "$SCRIPT_DIR")/docker-compose.yml` exists AND grep
  matches `proxypilot`, set `IS_DOCKER_DEPLOY=true`.
- **C.2** Wrap the host-side backend `npm install` in
  `if [ "$IS_DOCKER_DEPLOY" != "true" ]`. Print a one-line
  log message `"Docker deployment detected — skipping host-side
  backend npm install (Dockerfile installs deps in alpine builder)"`
  in the skip branch. Frontend npm install stays unconditional
  because the host runs `vite build`.
- **C.3** Verify by running update.sh in dry-run mode against the
  current install (or by inspecting via `bash -n` + manual trace).
  Make sure the `[5/7] Installing frontend dependencies` and the
  build/restart steps still run.
- **C.4** Update `docs/features/post-mvp-cleanup/kickoff-prompt.md`
  (this file) with a `## Status` section noting C.x complete.

One commit per item. Commit messages start with `cleanup(deploy):`.

## Task 2 — Package security audit

Goal: identify and resolve npm-audit findings on backend and frontend
dependencies. **This is package-level, not code-level** — the
code-level audit happened in PR #145.

Implementation:

- **A.1** `cd admin/backend && npm audit --json > /tmp/backend-audit.json`.
  Read the JSON; categorize findings by severity (info, low, moderate,
  high, critical) and by whether they affect runtime or dev-only
  dependencies. Write a short summary table to the PR description.
- **A.2** Same for frontend: `cd admin/frontend && npm audit --json
  > /tmp/frontend-audit.json`. Categorize.
- **A.3** For each HIGH or CRITICAL: assess reachability in our usage
  (e.g. a vuln in a transitive dep we never call is lower priority).
  Fix where the upgrade is non-breaking. Use `npm audit fix` (NEVER
  `--force` without explicit per-package review). Re-run audit after
  each fix. Commit per package or per logical group.
- **A.4** For each MODERATE that has a non-breaking fix: same flow.
- **A.5** For findings with no available fix or only a breaking fix:
  document the residual risk in a new file
  `docs/features/post-mvp-cleanup/known-vulnerabilities.md`. Format:
  one row per vuln with package, severity, advisory URL, reachability
  assessment, decision (defer / wait / replace package).
- **A.6** If any **direct** dependency has a major version bump that
  would resolve a vuln, prototype it on the branch and run the
  existing smoke / build pipeline. If it works, land it. If it
  breaks, document why in known-vulnerabilities.md and don't push.

Commits start with `audit(deps):` or `chore(deps):` depending on
whether the commit is documentation or a real bump.

**Hard rule:** do NOT run `npm audit fix --force` blindly. It
upgrades transitive deps to versions that may have breaking API
changes. Every upgrade is a deliberate per-package decision.

## Task 3 — Replace all terminals with the live PTY

Goal: retire the legacy request-response `ContainerTerminal`
component. Make every terminal surface in the dashboard use the
streaming `InteractiveTerminal`. Add a baked-in "open this terminal at
folder `<path>`" feature so the Files browser can hand off into a
terminal pre-cd'd to the right directory.

Surfaces to audit BEFORE you start (read each, decide):

- LxcContainers.jsx "Terminal" tab — currently uses the legacy
  ContainerTerminal (lines ~79-371). Replace with InteractiveTerminal.
- LxcContainers.jsx "Terminal Beta" tab — currently uses
  InteractiveTerminal. Either drop the tab and merge into "Terminal"
  (cleanest) or keep both with one labelled "Beta" gone. Recommend
  merge — operator already trusts the streaming path.
- HostShell.jsx — already InteractiveTerminal. No change unless
  you're adding the cwd prop pass-through (`/admin/shell?cwd=...`
  query param if you want it to be sharable).
- LxcContainers.jsx Files tab — find the existing file/folder browser
  surface. Add a "Open terminal here" button (icon + tooltip) that
  switches the dialog to the Terminal tab and passes the current
  folder path as `initialCwd` to InteractiveTerminal.
- Search the rest of `admin/frontend/src/` for any other terminal
  embeddings (`grep -r ContainerTerminal\\|InteractiveTerminal admin/frontend/src/`).
  Document each found surface and its decision in the PR body.

Implementation:

- **T.1** Add an `initialCwd` prop to InteractiveTerminal. On
  WebSocket open (after sending the first resize), send a single
  `{type:'input', data: 'cd ' + JSON.stringify(initialCwd) + ' && clear\\n'}`
  envelope. Use `JSON.stringify` so paths with spaces / quotes are
  shell-escaped. Falsy / empty `initialCwd` → no-op (current
  behaviour). Smoke-test in isolation that a host-shell terminal
  with `initialCwd='/tmp'` lands in /tmp.
- **T.2** Replace LxcContainers.jsx legacy ContainerTerminal
  references with InteractiveTerminal. The "Terminal" tab now uses
  the live component; the "Terminal Beta" tab is removed (rename
  the trigger label and drop the duplicate tab content). Adjust the
  TabsTrigger list. Verify in the browser that the Terminal tab
  still opens, connects, and the prompt is visible within 2s.
- **T.3** Delete the legacy `ContainerTerminal` function from
  LxcContainers.jsx (lines ~79-371). Remove the now-unused imports
  it depended on (`api.execInContainer`, `api.tabComplete`, `Loader2`
  if unused elsewhere, etc.). `node --check` clean afterwards.
- **T.4** Add an "Open terminal here" button to the Files browser
  surface in LxcContainers.jsx. Clicking it switches the active tab
  to "Terminal" and stores the folder path in component state; the
  Terminal tab's `<InteractiveTerminal />` reads that state into the
  `initialCwd` prop. Confirm via browser: navigate Files into a
  subdir, click Open Terminal Here, see prompt cd'd into that path.
- **T.5** (Optional) Same pattern for HostShell — but HostShell has
  no Files browser, so this is just a query-param hookup
  (`/admin/shell?cwd=/tmp`). Skip if scope is creeping.
- **T.6** (Optional) Audit log enhancement: include `cwd` in
  `TERMINAL_SESSION_START` details when the frontend sends the
  initial cd. Keeps forensic trail of where sessions opened. Skip if
  scope is creeping.
- **T.7** Update `docs/features/terminal/terminal-mvp.md` to mark the
  legacy-component-removal as done; this was originally listed as
  "Out-of-scope for MVP (deferred to production phase)".

One commit per item. Commit messages start with `feat(terminal):`
for T.1–T.6 and `docs(terminal):` for T.7.

## Verification (operator-side acceptance)

After each task ships, run the relevant manual check:

- **Cleanup**: next `update.sh` run shows no `gyp ERR! stack Error:
  not found: make` lines. Deploy still completes healthy.
- **Audit**: `npm audit` returns 0 high/critical on both backend and
  frontend; documented residuals are in
  `known-vulnerabilities.md`.
- **Terminal**: open a container's Terminal tab → live prompt within
  2s. `vim`, `htop`, `tmux` all work. From Files, navigate to a
  subdir, click "Open terminal here" → terminal opens already cd'd
  into that subdir. Run `pwd` to confirm. The legacy "Terminal Beta"
  label is gone (or merged).

## Rules

- Stay in scope. The three concerns above are it.
- Do NOT touch the security middleware (auth.js, sudo middleware,
  session table). It is current and tested.
- Do NOT touch the migration framework. New migrations register via
  `runMigration(db, 8, ...)` if needed; no inline DDL.
- Commit often. One checklist item = one commit. Push after every
  commit.
- Never run `npm audit fix --force` without per-package review.
- Do not create the PR until all three tasks are complete OR until
  the operator decides to ship a partial.
- Ask before any destructive action (rebases, force pushes, deletes
  beyond the legacy ContainerTerminal removal which is in scope).

## When done

1. Update this file's `## Status` section with one line per task
   completed (date + commit hash).
2. Open a single PR against `main` titled
   `cleanup + audit + terminal-v2: <one-line>`. PR body lists each
   task with its commits and any residual decisions.
3. Stop. Operator picks up from there.

## Status

- 2026-04-28 — Task 1 cleanup: detect Docker deploy early in `update.sh`
  and skip the host-side backend `npm install`; node-pty gyp noise is
  silenced on Docker hosts. Frontend install + vite build untouched.
