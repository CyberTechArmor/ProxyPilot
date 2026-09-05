# Next-Session Kickoff — ProxyPilot self-update: Update button + agent-run update + MCP

Copy everything inside the fenced block below into the first message of a new
Claude Code session. One session, one PR. Written 2026-09-05 after a survey of
the code; every claim below carries the file it was read from — verify against
the tree before trusting an instinct over it.

---

```
You are adding a real, safe self-update to ProxyPilot: an "Update now" button in
the dashboard, an update runner that SURVIVES the update it performs, an
"update available" indicator that checks GitHub (ProxyPilot code) and the Mock2
standards site on Gitea (framework content), and MCP tools so an AI client can
check and trigger the same update. Build exactly this; do not widen it.

## Why this shape (read before designing anything)

- ProxyPilot's backend runs INSIDE Docker on the host (`admin/backend/src/routes/services.js:60`
  `isInDocker`; host commands go through `nsenter -t 1` via `execOnHost`, or through
  `lib/host-exec.js` `spawnHost`). `update.sh` at the install root (`/opt/proxypilot`,
  detected at `update.sh:1179`) does the whole update: DB backup, `git fetch/pull`
  (`[1/7]`, `[2/7]`, lines 855/885), a SELF RE-EXEC after the pull with
  `PROXYPILOT_UPDATE_REEXEC=1` so the freshly pulled script runs the rest
  (`update.sh:900-926`), Incus check, deps, frontend build, then
  `docker compose down --remove-orphans` + `build` + `up -d` (`update.sh:1687-1718`).
  It holds `flock` on `/var/lock/proxypilot-update.lock` (`update.sh:24-52`) and logs
  to `/tmp/proxypilot-update.log` (`update.sh:12`). It also rebuilds and restarts
  the Go agent when its source changed (`update.sh:1044-1166`).
- Anything that runs inside the backend container dies at `docker compose down`.
  The DORMANT route `POST /api/user/version/update` (`routes/user.js:1524-1652`,
  admin + sudo) does exactly that: it runs git and npm on the host from the backend
  process, keeps progress in an in-memory object (`updateProgress`), and ends with
  "Please restart the application". NOTHING in the frontend calls it (grep
  `version/update` in `admin/frontend/src` → no hits; `git log -S` shows it never
  had a button). `GET /api/user/version/update/progress` and
  `POST /api/user/version/update/reset` (`routes/user.js:1654-1665`) and
  `POST /api/user/version/restart` (`:1667`, spawns `restart.sh` detached) are the
  same dormant family. You will REPLACE their implementation behind the same paths.
- What the UI has today: Profile page → admin-only card **Application Settings**
  (`admin/frontend/src/pages/Profile.jsx:1346-1490`): current version
  (`GET /api/user/version`, `routes/user.js:1288`), a refresh icon calling
  `GET /api/user/version/check` (`:1308` — GitHub latest release, falling back to
  `main`'s `admin/backend/package.json` version), an "Update available: vX" badge,
  "View Release Notes", the GitHub repo setting (`getGitHubRepo`, `:144`), and a
  dismiss/reset pair. `api.js:689` `getVersion`, `checkForUpdates`, `updateGithubRepo`,
  `resetDismissUpdate`. `Layout.jsx:220` shows the version in the shell. There is
  no Update button. `components/UpdateBanner.jsx` is the PWA "new build ready,
  reload" banner — reuse it after a successful update, do not confuse it with this.
- The host-side Go agent already exists: `cmd/agent/` (`main.go`, `dispatcher.go`,
  `methods/registry.go` with `Register(name, Handler)`; a `Handler` is
  `func(params json.RawMessage) (any, *Error)`), JSON-over-newline on
  `/run/proxypilot-agent/proxypilot-agent.sock`, one request per connection, 64 KiB
  line cap, 30 s read deadline. Registered methods: `agent.ping`, `caddy.adapt`,
  `caddy.reload`, `caddy.fmt`, `caddy.list_modules`, `caddy.version`,
  `security.cve_2026_31431.check` / `.patch` (`methods/caddy_test.go:264`,
  `methods/registry.go:79`). Unit: `deploy/proxypilot-agent.service` —
  `User=proxypilot-agent`, `NoNewPrivileges=true`, `ProtectSystem=strict`,
  `ReadWritePaths=/etc/caddy /run -/var/lib/incus -/var/run/docker.sock`,
  `RuntimeDirectory=proxypilot-agent`. Node client: `admin/backend/src/lib/agent.js`
  `agentCall(method, params, { timeoutMs })` + `AgentError`; used by
  `lib/caddy-driver.js` behind `PROXYPILOT_USE_AGENT_FOR_CADDY` and by
  `lib/security-cve-driver.js`. Test pattern: `src/__tests__/agent.test.js` (an
  in-process stub socket). Go tests: `methods/caddy_test.go`,
  `methods/cve_2026_31431_test.go`. install.sh builds the binary
  (`install.sh:661-696`), installs the unit from `deploy/`, enables + restarts it;
  update.sh does the same when the agent source changed.
- The agent's unit is unprivileged and `NoNewPrivileges`. Do NOT make the agent run
  `update.sh` itself, do NOT add sudoers/polkit for the agent, and do NOT make the
  backend spawn it either (it dies at `compose down`). The privileged, survivable
  runner is a ROOT SYSTEMD ONESHOT triggered by a request file — see the design.
- `docs/features/security-completion/master-spec.md` Phase E (`git.pull`,
  `npm.install`, `systemd.restart` agent methods "mostly used by the self-update
  flow") is SUPERSEDED for the update flow by this design: the update is one
  `update.sh` run, not a re-implementation of its steps over RPC. Add a note to
  Phase E saying so; leave the rest of the spec alone.
- Framework/standards updates are a different thing and are ALREADY handled by
  the Projects module: the vendored seed publishes a framework version on boot
  (`mock2/framework.js` `upgradeFrameworkFromSeed`) and projects adopt it. What
  is missing is only the CHECK: is the Mock2 standards site newer than the seed?
  `https://mock2.fractionate.ai/manifest.json` has `version` (0.3.0 on 2026-09-05)
  and `changelog`; the seed's recorded source version lives in
  `admin/backend/src/mock2/framework-seed/README.md` (table row "Mock2 standards").
  Record it machine-readably (`framework-seed/standards-version.json`) and compare.
  Read `docs/mock2/standards-and-cpr.md` §3–§4 first.
- Repo rules: `CLAUDE.md` (root) and `admin/frontend/MOBILE_FIRST.md` (merge gate
  for any change under `admin/frontend/src/pages` or `components`).
  `docs/known-issues.md` lists the 6 test files that fail in a fresh checkout and
  the two flaky gate-script tests; do not "fix" them.

## Design (build this)

### 1. Root-owned update runner (host, survives everything)

Files: `deploy/proxypilot-update.service`, `deploy/proxypilot-update.path`,
`scripts/update-runner.sh`. Installed by `install.sh` next to the agent unit and
re-installed by `update.sh` when they changed (mirror `install.sh:675-696`).

- `proxypilot-update.path`: `PathChanged=/run/proxypilot-update/request.json`,
  `Unit=proxypilot-update.service`. The directory `/run/proxypilot-update` is
  created by the agent unit (`RuntimeDirectory=proxypilot-agent proxypilot-update`,
  mode 0750, group `proxypilot-agent`) so the agent can write into it under
  `ProtectSystem=strict` (`/run` is already in `ReadWritePaths`).
- `proxypilot-update.service`: `Type=oneshot`, root, `ExecStart=/opt/proxypilot/scripts/update-runner.sh`,
  `StartLimitIntervalSec=600`/`StartLimitBurst=2`, `KillMode=process`,
  `TimeoutStartSec=3600`. It is NOT a child of the agent or of Docker; systemd owns it.
- `update-runner.sh`: reads and immediately renames the request
  (`request.json` → `request.<id>.taken`), validates it (`id` uuid, `requested_by`,
  `requested_at` within the last 120 s, `flags` ⊂ {`--rebuild`, `--enable-mock2`},
  `nonce` equals the one the agent left in `/run/proxypilot-update/nonce.<id>`),
  refuses otherwise with a status file saying why. Writes
  `/var/lib/proxypilot/update/state.json`
  `{ id, status: queued|running|success|failed|refused, phase, started_at,
  finished_at, exit_code, requested_by, from_sha, to_sha, log: "<path>" }` and
  streams `update.sh --yes <flags>` output to `/var/lib/proxypilot/update/<id>.log`
  (both world-readable, dir 0755), updating `phase` by grepping the `[n/7]`
  markers. Because `update.sh` re-execs itself, the runner must wrap it in
  `bash update.sh ...` and read the exit of the FINAL process; it must not assume
  the first process is the one that finishes. `update.sh` needs a non-interactive
  mode: add `--yes` that answers every `read -p` prompt with its safe default
  (the uncommitted-changes question, the Incus prompt) — grep for `read -p` and
  cover every one; refuse `--yes` when uncommitted changes exist unless
  `--discard-local` is also passed (the runner never passes it). On finish, the
  runner writes the final state and `touch`es `/var/lib/proxypilot/update/done.<id>`.
- Keep the existing `flock` semantics: a second request while one runs is
  `refused` with `reason: "already running"`. `state.json` is the single source of
  truth; `/tmp/proxypilot-update.log` stays as update.sh's own log.

### 2. Agent methods (`cmd/agent/methods/update.go` + `update_test.go`)

- `update.check` → `{ install_dir, branch, head_sha, head_date, dirty: bool,
  remote_url, agent_version }` from `git -C /opt/proxypilot rev-parse HEAD`,
  `status --porcelain`, `remote get-url origin`. Read-only; the agent can read
  `/opt/proxypilot` under `ProtectSystem=strict`. No network in the agent.
- `update.request` `{ requested_by, flags?: string[] }` → writes the nonce file
  and `request.json` atomically (write temp, rename) and returns `{ id, state_path,
  log_path }`. Validates flags against the allowlist. Refuses (`update_in_progress`)
  when `state.json` says `running` and its `started_at` is < 1 h old.
- `update.status` `{ id?, log_tail_bytes? (≤ 64 KiB minus headroom) }` → the
  parsed `state.json` plus the last N bytes of the log. Remember the 64 KiB line
  cap on the wire (`dispatcher.go`): default 16 KiB tail, cap at 48 KiB.
- Register all three in `DefaultRegistry`; table-driven tests for validation,
  request-file shape, status parsing, and the log-tail cap. `GOFLAGS=-mod=mod go test ./...`
  in `cmd/agent` must pass.

### 3. Backend (`admin/backend`)

- New `lib/self-update-logic.js` (pure, unit-tested stub-first): semver compare
  (there is a `compareVersions` in `routes/user.js` — move it here), "update
  available" decision from `{ installed: {version, sha}, latest: {version, sha,
  release_url}, standards: {seed_version, site_version} }`, request/flag
  validation mirror, state-file parsing, and the public shape.
- New `lib/self-update.js`: `checkForUpdates()` (GitHub latest release + latest
  `main` commit sha via `https://api.github.com/repos/<repo>/commits/main`, both
  with the existing `getGitHubRepo()` and a 10 s timeout; the standards site
  manifest with a 5 s timeout, best-effort — a network failure is a field, not a
  500), `installedState()` via `agentCall('update.check')`, `startUpdate({ user,
  flags })` via `agentCall('update.request')`, `updateStatus()` via
  `agentCall('update.status')`. Cache the check for 10 minutes; `?force=1` bypasses.
- Routes (keep the paths, replace the bodies): `GET /api/user/version/check`
  returns `{ currentVersion, latestVersion, updateAvailable, releaseUrl,
  releaseNotes, installed: { sha, branch, dirty, head_date }, latest_sha,
  commits_behind?: null, standards: { seed_version, site_version, update_available,
  site } , agent: { reachable } }`. `POST /api/user/version/update`
  (`requireAdmin`, `requireSudo`) → `startUpdate`, `logAudit(... 'SELF_UPDATE_REQUESTED')`,
  202 `{ id }`. `GET /api/user/version/update/progress` → `updateStatus()` (works
  BEFORE, DURING and AFTER the backend restart because the state lives on the host).
  Delete the in-memory `updateProgress`, `findGit`, `findNpm` and the host `git pull`
  / `npm` code in `routes/user.js:1440-1665`; keep `/version/restart` as is.
- Boot: on startup, if `state.json` shows a run that finished after the backend's
  own start time minus 1 h and `installed_version` changed, `logAudit('SELF_UPDATE_COMPLETED')`
  and store `last_update_id` in settings so the UI can show "updated to vX at T".
- `framework-seed/standards-version.json` `{ "source": "https://git.fractionate.ai/mock2/mock2-core",
  "manifest": "https://mock2.fractionate.ai/manifest.json", "version": "0.3.0",
  "synced": "2026-09-05" }`; `mock2-standards-seed.test.js` asserts it parses and
  `framework-seed/README.md` says to bump it with the seed.

### 4. MCP (`lib/mcp-logic.js` tool defs, `routes/mcp.js` handlers)

- `check_proxypilot_update` (read-only) → the same object as `/version/check`.
- `get_proxypilot_update_status` → the same as `/progress`, with `log_tail`.
- `run_proxypilot_update` `{ confirm: true, rebuild?: boolean }` → refuses without
  `confirm: true` with the exact message to show the user, refuses when `dirty`
  (the operator must resolve local changes on the host), refuses while running,
  otherwise requests the update and returns `{ id, next: "poll
  get_proxypilot_update_status; the API will be unreachable for ~1–2 minutes while
  the container rebuilds" }`. Audit-log with `via: 'mcp'`. Add one line to
  `MCP_SERVER_INSTRUCTIONS` after the GIT REMOTES sentence (keep the working-order
  sentences first — `mcp-logic.test.js` pins their order). MCP tokens are admin
  tokens already; still gate the run tool behind a policy file
  `lib/mcp-policy/self-update-allowlist.json` (`{ "enabled": true }` default, so an
  operator can turn the MCP trigger off without touching code), mirroring how
  `project-lifecycle-allowlist.json` is loaded (`routes/mcp.js:117-125`).

### 5. Frontend (`admin/frontend`, MOBILE_FIRST applies)

- Profile → Application Settings card: replace the static "Update available" badge
  area with an **Update** block: installed version + short sha + branch (+ "local
  changes on the host" warning when `dirty`), latest release + latest main sha,
  standards line ("Mock2 standards: seed 0.3.0, site 0.3.0 — current" or "site
  0.4.0 available — update ProxyPilot to pick it up"), and the **Update now**
  button (admin; disabled with a reason when the agent is unreachable, when dirty,
  or when a run is in progress). Clicking opens a confirm dialog that names what
  happens (backup, pull, rebuild, ~1–2 min of downtime, the page will reconnect),
  then calls `api.startUpdate()` and switches the card into progress mode: phase
  list from the `[n/7]` markers, live log tail (poll `/progress` every 2 s;
  tolerate fetch failures silently while the container rebuilds — show
  "Restarting…" after 3 consecutive failures — and resume when it answers again),
  final state, and a **Reload** button when `success` (the new SPA build is live;
  `UpdateBanner` may also appear — that is fine). The dialog must be completable
  on a 360 px screen (full-screen on `<sm`).
- Layout shell: when `/version/check` says an update is available, show a small
  dot on the version label in `Layout.jsx` linking to Profile (admin only).
- `api.js`: `startUpdate`, `getUpdateProgress`, extend `checkForUpdates({ force })`.

### 6. install.sh / update.sh

- Install the two new units + `scripts/update-runner.sh` (0755) + create
  `/var/lib/proxypilot/update` (0755). Enable the `.path` unit. Add the second
  `RuntimeDirectory` to the agent unit. update.sh re-installs them when changed,
  exactly as it does for the agent unit.
- `update.sh --yes` (see §1) and `--discard-local`; document both in `--help`.
- Nothing in the runner or the units may reference a model name or an AI vendor.

### 7. Tests and proof

- Node: `self-update-logic.test.js` (compare, decision, state parsing, flags),
  extend `mcp-logic.test.js`-style coverage for the three tools in a new
  `self-update-mcp.test.js`, and an `agent.test.js`-style stub test that
  `lib/self-update.js` maps `AgentError`/transport failures to `{ agent: {
  reachable: false } }` instead of throwing. Go: `update_test.go`.
- `cd admin/backend && npm test` — no new failures beyond `docs/known-issues.md`.
  `cd admin/frontend && npm run build` passes.
- Operator proof on a disposable VM, recorded in `docs/features/self-update.md`:
  U.V1 Update now from the dashboard on an out-of-date install completes and the
  page reconnects on the new version; U.V2 a second click during a run is refused
  with "already running"; U.V3 the MCP `run_proxypilot_update` without `confirm`
  is refused, with `confirm: true` it runs and `get_proxypilot_update_status`
  reports through the restart; U.V4 a host with uncommitted changes in
  `/opt/proxypilot` shows the warning and the button is disabled; U.V5 a forged
  `request.json` written by a non-agent process is `refused` (nonce mismatch);
  U.V6 the standards line flips to "available" when the site manifest version is
  bumped.

## Do NOT

- Do not run update.sh from the backend process or from the agent process.
- Do not add sudoers or polkit rules; the root oneshot + request file is the whole
  privilege boundary.
- Do not implement Phase E's git/npm/systemd RPC methods; note their supersession.
- Do not touch the Mock2 framework seed content, the gate battery, or the git
  remotes feature (`docs/features/git-remotes.md`) beyond the standards-version file.
- Do not auto-update. Every run is an explicit admin (or MCP with `confirm`) action.

## Deliverables

Branch `claude/self-update-<short-id>` off `origin/main`, one PR. Commits prefixed
`self-update:`. `docs/features/self-update.md` (design as built, the request-file
contract, the state.json schema, the proof table), a note in
`docs/features/security-completion/master-spec.md` Phase E, an entry removed from
or added to `docs/known-issues.md` as appropriate, and a `LEARNINGS.md` row if any
human-caught defect surfaces during the work. Before finishing, run the two test
commands above and paste their summary lines into the PR description.
```
