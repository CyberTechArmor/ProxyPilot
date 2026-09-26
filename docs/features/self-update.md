# Self-update: the Update button, the root runner, and the MCP tools

ProxyPilot can update itself from the dashboard (Profile → Application
Settings → **Update now**) and over MCP (`run_proxypilot_update`). Both do
exactly one thing: ask the host to run `update.sh --yes`, the same script an
operator runs by hand — DB backup, `git pull`, self re-exec, dependency
install, Incus stable-channel check and guarded upgrade, frontend build,
host-agent rebuild, `docker compose down/build/up`, health check. Nothing is
re-implemented over RPC. Even when application code is already current,
`--yes` checks Incus; it does not rebuild the dashboard merely for that check.

The Incus step uses `scripts/upgrade-incus-stable.sh`. It refuses a clustered
host, a kernel below the current Incus minimum, unsupported storage pools,
insufficient local backup capacity, failed SQL dumps or archive verification,
and unrelated apt package removals. For an upgrade it saves the local and
global SQL dumps and a full `/var/lib/incus` archive, plus recursive ZFS
snapshots for external ZFS pool sources, before installing the pinned Zabbly
stable package. The service is stopped during the checkpoint, so running
guest management may be interrupted. The archive is listed back and a SHA-256
manifest is saved for recovery verification. Directory-pool guests may keep
writing while the Incus daemon is stopped, so this archive is a recovery
checkpoint rather than a transactionally consistent backup of running guest
data. A ZFS snapshot on the same pool is also a rollback checkpoint, not an
off-host disaster recovery backup. A failed or
partial package upgrade needs operator recovery from the logged checkpoint;
the script never attempts an automatic Incus downgrade after a possible DB
schema change. Successful runs set and read back
`images.auto_update_cached=true` and `images.auto_update_interval=6`.
Existing image records keep their individual auto-update flag; fingerprint
images and remote copies made without `--auto-update` are not changed.

## Why this shape

| Constraint (from the tree) | Consequence |
|---|---|
| The backend runs **inside Docker** and `update.sh` runs `docker compose down` at `[7/7]` | The process that runs the update cannot be the backend: it dies mid-run. |
| The host agent (`proxypilot-agent`) is `User=proxypilot-agent`, `NoNewPrivileges=true`, `ProtectSystem=strict`, `ProtectHome=true` | The agent cannot run `update.sh` (root, `systemctl`, `docker`), and it cannot even read a checkout under `/root` or `/home`. No sudoers, no polkit. |
| The git checkout is **not** `/opt/proxypilot`: `install.sh` copies `admin/`, `scripts/`, `proxypilot/`, `cli/` from wherever the operator cloned (README: `git clone … && cd ProxyPilot && sudo ./install.sh`) into `/opt/proxypilot`; `update.sh` runs from the checkout and copies again at `[7/7]` | The updater has to know where the checkout is. `install.sh`/`update.sh` record it (`source-dir`, below); the runner refuses to guess beyond `/opt/proxypilot`-as-a-checkout. |
| `update.sh` re-execs itself after the pull (`PROXYPILOT_UPDATE_REEXEC=1`) and holds `flock` on `/var/lock/proxypilot-update.lock` | The runner waits for the **final** process of the pipeline and probes the same lock before starting. |

So the privileged, survivable runner is a **root systemd oneshot triggered by
a request file**, and the request file is the entire privilege boundary.

## The pieces

```
dashboard / MCP client
   │  POST /api/user/version/update   (admin + sudo)   |  run_proxypilot_update({confirm:true})
   ▼
backend (Docker)            lib/self-update.js → agentCall('update.request')
   │  unix socket
   ▼
proxypilot-agent (unprivileged)   cmd/agent/methods/update.go
   │  writes  /run/proxypilot-update/nonce.<id>  +  request.json   (atomic rename)
   ▼
proxypilot-update.path (PathExists=…/request.json)  →  proxypilot-update.service (root, oneshot)
   │  /usr/local/sbin/proxypilot-update-runner   (= scripts/update-runner.sh)
   │  validate → bash <checkout>/update.sh --yes [--rebuild] [--enable-mock2]
   ▼
/var/lib/proxypilot/update/state.json, state.<id>.json, <id>.log, done.<id>, installed.json
   ▲
   │  agentCall('update.status') / ('update.check')  — read back for the UI; the same directory is
   │  bind-mounted into the container, so the backend can read state.json directly while the agent restarts
```

### Files

| Path | Role |
|---|---|
| `deploy/proxypilot-update.path` | `PathExists=/run/proxypilot-update/request.json` → starts the service. `PathExists` (not `PathChanged`) so a request that lands while the runner is busy is picked up when it is free. |
| `deploy/proxypilot-update.service` | `Type=oneshot`, root, `ExecStart=/usr/local/sbin/proxypilot-update-runner`, `TimeoutStartSec=21600`, `KillMode=control-group`, `StartLimitIntervalSec=60`/`StartLimitBurst=10`. No `[Install]`: only the path unit starts it. |
| `scripts/update-runner.sh` | The runner. Installed atomically to `/usr/local/sbin/proxypilot-update-runner` by `install.sh` and re-installed by `update.sh` when changed (same pattern as the agent unit). All functions, `main "$@"` on the last line — bash has parsed the whole file before running, so the copy `update.sh` installs mid-run cannot corrupt the running one. |
| `deploy/proxypilot-agent.service` | `RuntimeDirectory=proxypilot-agent proxypilot-update` — the agent's *only* writable drop box under `ProtectSystem=strict` besides `/etc/caddy`. `0750`, group `proxypilot-agent`: nothing else on the host can author a request. |
| `cmd/agent/methods/update.go` | `update.check`, `update.request`, `update.status` (tests: `update_test.go`). |
| `admin/backend/src/lib/self-update-logic.js` | Pure: version compare, the update decision, flag allowlist, refusal reasons, state parsing, phase list, payload shapes. |
| `admin/backend/src/lib/self-update.js` | I/O: GitHub + standards-site lookups (cached), agent calls, host-file fallback, boot bookkeeping. |
| `admin/backend/src/routes/user.js` | `GET /version/check`, `POST /version/update`, `GET /version/update/progress` (paths kept; the dormant in-process `git pull`/`npm` implementation is gone). |
| `admin/backend/src/routes/mcp.js` + `lib/mcp-logic.js` | `check_proxypilot_update`, `get_proxypilot_update_status`, `run_proxypilot_update`; policy `lib/mcp-policy/self-update-allowlist.json`. |
| `admin/frontend/src/components/SelfUpdatePanel.jsx` | The Update block (installed / latest / standards / button / confirm / progress). `Layout.jsx` shows a dot on the version label for admins when an update is available. |
| `admin/backend/src/mock2/framework-seed/standards-version.json` | The Mock2 standards version the seed renders, compared with `https://mock2.fractionate.ai/manifest.json`. |

### What `update.sh` gained

* `--yes` / `-y` — non-interactive. Every `read -p` prompt takes its safe
  default: the uncommitted-changes question is answered **no** (the run is
  cancelled with exit 1 and a message naming `--discard-local`), and "rebuild
  anyway?" on an up-to-date checkout is answered **no** (exit 0, "No changes
  made") unless `--rebuild` was given. The self re-exec forwards `"$@"`, so
  `--yes` survives the pull.
* `--discard-local` — with `--yes`: `git reset --hard HEAD && git clean -fd`
  (no `-x`: `.env`, `data/` and other ignored files survive) instead of
  cancelling. **The runner never passes it**; it is not in the flag allowlist
  of the agent, the runner or the backend. An operator types it at a shell.
* `install_update_runner` — installs the runner + units, enables the path
  unit, records the checkout, refreshes `installed.json`.
* The agent is built with `-ldflags -X …methods.AgentVersion=<short sha>` so
  `update.check` reports which agent build is running.

## The request-file contract

`/run/proxypilot-update/request.json` — one line, written by the agent via
temp + rename; **one slot**, so the agent refuses to write while a request is
pending rather than silently replacing it.

```json
{"id":"<uuid v4>","action":"update","requested_by":"admin",
 "requested_at":"2026-09-05T13:24:06Z","requested_at_unix":1788614646,
 "nonce":"<32 hex>","flags":"--rebuild"}
```

`/run/proxypilot-update/nonce.<id>` — the same nonce, `0600`, written by the
agent **before** the request.

The runner takes the request (renames it away, so the path unit re-arms) and
refuses — writing `state.<id>.json` with `status: "refused"` and a `reason`
prefixed by one of these codes — when:

| Code | Check |
|---|---|
| `not_written_by_agent` | `request.json` is not owned by `proxypilot-agent`. |
| `malformed` | `id` is not a uuid, `action` ∉ {`update`, `check`}, `requested_by` ∉ `^[A-Za-z0-9._@:+-]{1,80}$`, `requested_at_unix` missing. |
| `stale` | older than 120 s (or more than 60 s in the future). |
| `nonce_mismatch` | no `nonce.<id>`, not owned by the agent, or its content differs. |
| `invalid_flags` | any token outside `--rebuild --enable-mock2`. |
| `source_dir_missing` | no recorded checkout (see `source-dir`). |
| `already_running` | `/var/lock/proxypilot-update.lock` is held (a manual `update.sh` is running). |

`action: "check"` is the read-only sibling: it refreshes `installed.json` and
touches no run state. `update.check` on the agent uses it when the recorded
facts are older than 30 s (the agent writes the request, waits up to 3 s for
the runner to answer, and otherwise returns the stale facts with
`fresh: false`). This is how the dashboard gets a live `dirty` flag without
the agent running git as itself.

## The state directory: `/var/lib/proxypilot/update` (root writes, 0755)

| File | Content |
|---|---|
| `source-dir` | Absolute path of the git checkout `update.sh` lives in. Written by `install.sh`/`update.sh` (`record-source`). |
| `installed.json` | `{configured, checked_at, checked_at_unix, source_dir, branch, head_sha, head_short, head_date, head_subject, remote_url, dirty, dirty_count, dirty_files[≤20], installed_version}`. `package-lock.json` drift is not counted as dirty (update.sh restores it). |
| `state.json` | The latest run (schema below). A refusal never overwrites a run that is still `running`. |
| `state.<id>.json` | One per run; `update.status {id}` reads it, so the UI can follow *its* run even if a later request was refused. |
| `<id>.log` | Full `update.sh` output (ANSI kept on disk; stripped on the wire). |
| `done.<id>` | Touched when a run finished (success or failed). |

The newest 10 runs are kept.

### `state.json`

```json
{"id":"…","action":"update","status":"queued|running|success|failed|refused",
 "phase":"Pulling latest code","phase_index":2,"phase_total":7,
 "started_at":"…","started_at_unix":1788614646,"finished_at":"…"|null,"exit_code":0|null,
 "requested_by":"admin","from_sha":"…","to_sha":"…","from_version":"1.4.0","to_version":"1.4.1",
 "flags":"--rebuild","reason":null|"<code>: <text>","up_to_date":false,
 "log":"/var/lib/proxypilot/update/<id>.log","runner_pid":1234,"updated_at":"…"}
```

`phase`/`phase_index` follow `update.sh`'s `[n/7]` markers (`3.5` is the
host-agent step); `self-update-logic.test.js` fails if the script's markers
and the UI's phase list drift apart. `reason` on failure is the last
non-empty log line. `up_to_date` is set when `update.sh` reported "Code is
already up to date" and the sha did not move.

## Agent methods

| Method | Params | Result |
|---|---|---|
| `update.check` | — | `installed.json` merged with `{configured, fresh, pending, agent_version, error?}`. Asks the runner for a refresh when the facts are > 30 s old. |
| `update.request` | `{requested_by, flags?: string[]}` | `{id, requested_at, flags, request_path, state_path, log_path}`. Errors: `invalid_params`, `update_in_progress` (state.json running/queued and started < 1 h ago), `update_pending` (a request is waiting), `request_write_failed`. |
| `update.status` | `{id?, log_tail_bytes?}` | `state.json` (or `state.<id>.json`) + `pending`, `id_match`, `log_tail` (ANSI-stripped, default 16 KiB, max 48 KiB, then trimmed until the JSON encoding fits the 64 KiB wire line), `log_truncated`, `log_total_bytes`. `{status:"idle"}` when nothing ran. A `log` path outside the state dir is refused. |

## Backend

* `GET /api/user/version/check` (admin) → `{ currentVersion, latestVersion,
  updateAvailable, updateReason, releaseUrl, releaseNotes, releaseTag,
  latest_sha, latest_sha_short, latest_commit_date, commits_behind,
  installed: {reachable, configured, fresh, source_dir, branch, sha, short_sha,
  head_date, head_subject, dirty, dirty_count, dirty_files, checkout_version,
  agent_version, error}, standards: {seed_version, site_version,
  update_available, site, changelog, error}, agent: {reachable, version},
  canUpdate, cannotUpdateReason, github: {repo, error}, checkedAt, cached }`.
  GitHub: `releases/latest`, the branch's `admin/backend/package.json`
  (`latestVersion` — the version an update would actually install),
  `commits/<branch>`, `compare/<sha>...<branch>` for `commits_behind`; 10 s
  timeouts; results cached 10 minutes per repo, `?force=1` bypasses.
  Standards: the site manifest, 5 s, best-effort. Host facts: cached 60 s.
  **A network failure is a field, not a 500.**

  **What decides "update available"** (`decideUpdate`): the commit sha when
  both sides are known — `update.sh` pulls the installed branch, so sitting
  on its head *is* up to date whatever a release tag says. Without shas the
  branch's `package.json` version decides; only when that is unknown too
  does the latest release's tag. The release is reported separately
  (`release: {version, tag, url, published_at, ahead_of_code}`); a tag
  numbered ahead of the code's own version is flagged, not believed. This
  is the fix for the first thing an operator saw after merging: GitHub's
  latest release is `v1.21.0` from 2025-12-29 — a mis-numbered tag (v0.2.0
  → v1.2.0 → v1.21.0 in one day) whose commit is not on `main` — while the
  code is 1.4.0, so a host on main's head read "Update available".
  Cleaning up the release on GitHub (delete/rename the `v1.21.0` release and
  tag, or publish a `v1.4.0` release) needs the repo's release permissions
  and is the operator's; the dashboard is correct either way.
* `POST /api/user/version/update` (admin + sudo, body `{rebuild?}`) → `202
  {id}`; `409 {error}` with the refusal reason (agent unreachable, no
  checkout recorded, dirty checkout, run live, request pending); `400` on a
  bad flag; `502` when the agent cannot be reached. Audit
  `SELF_UPDATE_REQUESTED` / `SELF_UPDATE_REFUSED`.
* `GET /api/user/version/update/progress?id=&tail=` → `buildProgress()`:
  the state fields, `terminal`, `live`, `stale`, `pending`, `log_tail`,
  `phases[{index,label,state}]`, `agent: {reachable, source: agent|file|null}`.
  Agent first, then the bind-mounted state file (the agent is restarted by
  `update.sh` when its source changed), then `idle`.
* Boot (`index.js`, 5 s after listen): `noteCompletedUpdateOnBoot()` — if
  the latest run is `success`, finished within the last hour and not yet
  recorded, write the `SELF_UPDATE_COMPLETED` audit row and
  `last_update_id/at/version` settings, and clear the update dismissal.
* `getGitHubRepo()` and `getCurrentVersion()` are exported from
  `routes/user.js` for the MCP handlers.

## MCP

| Tool | Gate | Does |
|---|---|---|
| `check_proxypilot_update {force?}` | none | The `/version/check` payload. |
| `get_proxypilot_update_status {id?, log_tail_bytes?}` | none | The `/progress` payload with `log_tail`. |
| `run_proxypilot_update {confirm, rebuild?}` | `confirm: true` + policy | Refuses without `confirm` (returns the exact sentence to relay), when the policy file has `enabled: false`, when dirty / running / pending / agent unreachable / not configured; otherwise requests the run and returns `{id, next}`. Audited with `via: 'mcp'`. |

`lib/mcp-policy/self-update-allowlist.json` (`enabled: true` by default) is
the switch an operator flips to keep updates dashboard-only. The server
instructions carry one SELF-UPDATE sentence after GIT REMOTES; the working
order sentences stay first (`mcp-logic.test.js` pins them).

## Frontend

`SelfUpdatePanel` in Profile → Application Settings: installed (version ·
short sha · branch, commit date/subject), latest (release · main sha ·
commits behind), status, the Mock2 standards line ("seed 0.3.0, site 0.3.0 —
current" / "site 0.4.0 available, update ProxyPilot to pick it up"), the
warnings that disable the button (agent unreachable, no checkout, local
changes with the file list), **Update now** → confirm dialog (what happens,
the downtime, a "force rebuild" switch that defaults on when already up to
date) → progress mode: status line, phase checklist from the `[n/7]`
markers, live log tail, polling every 2 s. Poll failures are expected while
the container rebuilds: "Restarting…" after three in a row, resume when the
new backend answers. A page reload mid-run adopts the live run. On success:
**Reload dashboard** (the PWA `UpdateBanner` may also appear — same thing).
The dialog is full-screen under `sm`; every target is ≥ 44 px; grids are
`grid-cols-1 sm:grid-cols-3`; the log scrolls inside its own box.

`Layout.jsx`: a dot next to the version label (admins) links to Profile when
`/version/check` says an update is available.

## Operator notes

* First install: `install.sh` records the checkout and installs the runner.
  Existing installs get it on the next manual `sudo ./update.sh` (the
  button cannot install its own runner — that first run is by hand).
* `journalctl -u proxypilot-update` shows every request the runner handled,
  including refusals. `systemctl status proxypilot-update.path` must be
  `active (waiting)`; if the start limit ever trips, `update.sh` re-arms it,
  or `systemctl reset-failed proxypilot-update.path && systemctl restart
  proxypilot-update.path`.
* A dirty checkout is the operator's to resolve on the host. The dashboard
  and MCP never discard local changes.
* `PROXYPILOT_UPDATE_STATE_DIR` (backend) and `PROXYPILOT_UPDATE_RUN_DIR` /
  `PROXYPILOT_UPDATE_STATE_DIR` / `PROXYPILOT_UPDATE_LOCK` /
  `PROXYPILOT_UPDATE_REQUEST_OWNER` (runner) exist for tests only.

## Deviations from the session prompt, and why

* **Checkout location.** The prompt assumed `update.sh` lives at
  `/opt/proxypilot`; the tree says the checkout is wherever the operator
  cloned and `/opt/proxypilot` holds copies. Hence `source-dir`, the runner
  at `/usr/local/sbin`, and `update.check` reading recorded facts (refreshed
  through the runner's `check` mode) instead of running git as the agent
  user, which `ProtectHome=true` would block for `/root/ProxyPilot`.
* **Start limit.** `StartLimitBurst=2 / 600 s` would have been tripped by
  the `check` requests the dashboard makes; the service uses `10 / 60 s`.
* **Path unit.** `PathExists` instead of `PathChanged`, so a request written
  while the runner is busy or before the unit is up is not lost.
* **A `check` request type.** Not in the prompt; it is what makes the
  live `dirty` flag possible without new privileges.

## Proof

Machine checks (run in CI-less sandboxes too):

| Check | Where |
|---|---|
| Request contract: valid run, forged (no/mismatched nonce), stale, bad flag, malformed id/action/requested_by refused with the code; `check` refreshes facts; refusal never clobbers a live run; history pruned | `self-update-runner.test.js` (drives the real runner under bash with a fake `update.sh`) |
| `update.sh --yes`: every `read -p` guarded; `--discard-local` only with `reset --hard` + `clean -fd`, never `-x`; re-exec forwards `"$@"`; units and agent unit agree on the request dir; no vendor names | same file |
| Agent: params validation, nonce + request shape, in-progress/pending refusal, check-through-runner, status per id, log tail cap + ANSI strip + wire budget, path traversal refused | `cmd/agent/methods/update_test.go` |
| Decision, refusals, phases vs `update.sh` markers, payload shapes, boot bookkeeping | `self-update-logic.test.js` |
| Driver: agent down is a field, file fallback, allowlist before the wire, GitHub 404 fallback, cache + force, standards manifest best-effort | `self-update-driver.test.js` |
| MCP: advertised + dispatched, confirm before anything, policy file shape, instructions order | `self-update-mcp.test.js` |

Operator proof on a disposable VM — **not yet run** (this feature was built
in a sandbox without a host; `docs/known-issues.md` tracks it):

| # | Scenario | Expected |
|---|---|---|
| U.V1 | Out-of-date install, Profile → Update now → confirm | phases advance, "Restarting…" during the rebuild, `success`, Reload shows the new version; `SELF_UPDATE_REQUESTED` and `SELF_UPDATE_COMPLETED` in the audit log |
| U.V2 | Click Update now again while a run is live | button disabled ("An update is running"); a forced `POST` → 409 "already running"; a second `request.json` → `update_pending` / runner refusal |
| U.V3 | MCP `run_proxypilot_update` without `confirm` → refused with the confirm sentence; with `confirm: true` → `{id, next}`; `get_proxypilot_update_status` polled through the restart | status reaches `success` after the API returns |
| U.V4 | `touch /root/ProxyPilot/x.txt` on the host | Update block shows "Local changes on the host" with `?? x.txt`, button disabled; MCP run refused with the same reason |
| U.V5 | As root: write `/run/proxypilot-update/request.json` by hand (no nonce file) | `state.<id>.json` → `refused`, `reason: "not_written_by_agent: …"` (or `nonce_mismatch` when written as the agent user) |
| U.V6 | Bump `version` in the site's `manifest.json` (or lower `standards-version.json` locally) and force a check | standards line flips to "site X available, update ProxyPilot to pick it up" |

## Host Node runtime upgrades (September 2026 correction)

The updater must be able to fetch/re-exec new shell code even when the installed
Node is older than the new application requires. After the privilege/checkout
checks and self-reexec, **Preparing Node.js runtime** selects a compatible
Node/npm pair (22.15+ in the 22 series, or 24). It checks the current PATH and
system installations, puts the chosen binary first in PATH, and pins the host
CLI wrapper to that interpreter.

If none is usable, root updates on Debian/Ubuntu with apt-get and curl provision
Node 24 from the same NodeSource repository used by `install.sh`. The setup
script is fully downloaded over HTTPS before execution; download, repository,
package-manager and final runtime verification failures stop before environment
changes, application dependency replacement or service shutdown. Other hosts
get a specific local runtime-installation instruction. This changes the host's
Node package; the container image already uses its own Node 24 runtime.

Backend (native installs), frontend and host CLI use `npm ci` so a Node-major
change cannot retain a native addon built for the previous ABI. Failure through
`tee` is propagated; a failed CLI dependency install is fatal instead of a
warning followed by starting an incompatible runner.

### Recovering a host already stopped at the old Node-version gate

The affected updater checks Node **before fetching**, so its Update button
cannot fetch this correction. From **SSH or the server console**, pull the
recorded checkout once and run the supported updater (no flags are removed and
no local changes discarded). Keep that SSH session open until the final health
check succeeds. Earlier updater versions must not run inside ProxyPilot's own
terminal: stopping the dashboard also kills its terminal's processes.

```sh
sudo bash <<'SH'
set -e
cd -- "$(cat /var/lib/proxypilot/update/source-dir)"
git pull --ff-only origin main
bash ./update.sh --yes --rebuild
SH
```

If the recorded checkout is missing, locate the original git clone before
proceeding; `/opt/proxypilot` may be a deployed copy rather than the clone.
Afterward the dashboard update path can prepare the runtime itself. A source
merge alone does not run this repair on an installed host.

Validation: executable shell bootstrap tests replace only downloads/package
installation with disposable fixtures; they cover old/missing runtimes, missing
npm, PATH shadowing, supported-version reuse, failed/truncated downloads,
repository/apt failure, false installation success and npm failure through tee.
The real updater still refuses restricted Compose before runtime mutation.
Runner/progress and database-maintenance/recovery regression tests pass. A live
Debian/Ubuntu package upgrade and production deployment were not performed.

### Updates started inside the dashboard terminal

The host terminal now marks its shell with `PROXYPILOT_TERMINAL=host`. Before
taking the update lock or changing the application, `update.sh` recognizes that
marker (or the old Docker marker) in its environment or an ancestor shell,
including when `sudo` has cleared the child environment. A restarting update
is handed to an independent root systemd service named
`proxypilot-terminal-update-<time>-<pid>`. The service owns its process lifetime
and journal output; it has no browser PTY. If handoff is unavailable or refused,
the updater stops before making changes and asks for SSH/console execution.
`nohup` alone would still leave an updater in the dashboard container's cgroup.

The detached service uses safe noninteractive defaults and preserves explicitly
selected Compose overrides. It never adds `--discard-local`. The existing
dashboard Update button and MCP update runner already use an independent host
service. A manual terminal handoff is logged in its journal and
`/tmp/proxypilot-update.log`; it does not create a dashboard update-history job.
`--no-restart` remains in the foreground and reports only build completion.

Handoff is **not completion**. The script prints “Update completed successfully”
only after restart, a successful `/api/health` response, and runner installation.
Use the exact `journalctl` command printed by the handoff to inspect progress
and the result after the browser disconnects. Host API readiness does not prove
that an external reverse-proxy route is reachable.

If an older terminal-launched update left the Docker dashboard unavailable,
inspect it from **SSH/console**:

```sh
sudo docker ps -a --filter name=proxypilot-admin
sudo tail -n 80 /tmp/proxypilot-update.log
```

For the standard `/opt/proxypilot` Docker install, the following attempts to
start the existing image, refusing while an updater still owns its lock. Use
the same Compose overrides as the installation if you configured any. It
neither rebuilds an image nor restores a database:

```sh
sudo flock -n -E 75 /var/lock/proxypilot-update.lock bash -c '
  set -e
  cd /opt/proxypilot
  docker compose up -d --no-build --pull never
  docker compose ps
'
```

Exit 75 means an update is still active; inspect its journal before intervening.
If the container exits or remains unhealthy, inspect
`sudo docker logs --tail 100 proxypilot-admin` before attempting a rebuild or
database recovery. A native installation needs its own service/process-manager
recovery, not this Docker command. Starting the old image does not install the
source correction; pull and run the updater from SSH/console afterward.

Validation: tests execute the actual updater entry with only host commands
stubbed, verify sudo-style ancestor detection, lock release during handoff,
failure refusal and honest completion, and exercise the real PTY factory and
the deployed frontend build gate. Stopping a real dashboard container under
systemd still requires disposable-host acceptance; these tests do not claim it.
