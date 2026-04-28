# Master spec — ProxyPilot security completion

This is the running spec for closing every security gap between
"hardening branch shipped" and "honest production-ready single-tenant."
Sessions consult this file to find the next unticked phase, do that
phase, mark it ✅, commit, push, stop. Operator gates between phases.

## Status legend

* ✅ Done + verified by operator on disposable VM (or production where noted)
* 🟡 In progress
* ⏳ Pending
* 🚫 Blocked (with reason)

## Phases

| # | Phase | Status |
|---|---|---|
| 0 | Revert broken docker-compose security_opt → restore working dashboard | ⏳ |
| A | Host-side agent: design + scaffold | ⏳ |
| B | Host-side agent: Caddy methods | ⏳ |
| C | Host-side agent: Incus methods | ⏳ |
| D | Host-side agent: Docker methods | ⏳ |
| E | Host-side agent: misc methods (git / npm / systemd) | ⏳ |
| F | Drop `privileged: true` — switch container to unprivileged | ⏳ |
| G | Agent hardening + audit log + rate limiting | ⏳ |
| H | Backup automation (DB + secrets + Caddy state) | ⏳ |
| I | External monitoring + paging | ⏳ |
| J | Account lockout per-user | ⏳ |
| K | Sudo-mode — fresh TOTP for destructive ops | ⏳ |
| L | Inactivity timeout + sliding sessions | ⏳ |
| M | JWT revocation via DB-backed denylist | ⏳ |
| N | TOTP_ENCRYPTION_KEY rotation tooling | ⏳ |
| O | JWT_SECRET rotation with old-key fallback | ⏳ |
| P | Password breach check (HIBP k-anonymity) | ⏳ |
| Q | Audit log integrity (hash chain) | ⏳ |
| R | Real e2e deploy CI on a disposable VM | ⏳ |

After R is ✅: the security work for honest production go-live is complete.

---

## Phase 0 — Restore working dashboard (mandatory first)

**Goal.** Revert today's broken docker-compose.yml security_opt changes
back to `privileged: true`. The dashboard at lxc.fractionate.ai
currently fails on every host-shell operation (Add Service, Incus
page, Caddy reload). The operator authorized: "if it's easier, the
last commit prior to today actually worked."

**Files to edit.**
* `install.sh` — `create_docker_compose()` security block
* `update.sh` — replace today's apparmor:unconfined patch with a
  full revert-to-privileged migration
* `docs/features/security-completion/master-spec.md` — flip Phase 0 to ✅

**Deliverables.**

* `install.sh` writes a docker-compose.yml block of:
  ```yaml
  privileged: true
  pid: host
  ```
  (no cap_drop, no cap_add, no security_opt).
* `update.sh` detects the broken `cap_drop:` / `cap_add:` /
  `security_opt:` blocks in deployed `/opt/proxypilot/docker-compose.yml`
  and replaces them with `privileged: true`. Idempotent: if
  `privileged: true` is already present, skip.
* In-line comment in install.sh updated to read:
  > privileged: true is the working baseline. The cap_drop attempts
  > broke nsenter under multiple combinations. The real fix is the
  > host-side agent — see docs/features/security-completion/

**Acceptance tests** (operator runs against lxc.fractionate.ai):

- [ ] 0.V1 — `cd /root/ProxyPilot && git pull && sudo ./update.sh` completes successfully.
- [ ] 0.V2 — `docker logs proxypilot-admin --tail 30` shows no nsenter errors.
- [ ] 0.V3 — Login + dashboard loads.
- [ ] 0.V4 — Incus page shows real storage / profiles / images data.
- [ ] 0.V5 — Add Service → Static Site → succeeds, Caddy reloads cleanly.
- [ ] 0.V6 — New domain serves over HTTPS via Caddy.

**Commits.**

```
revert(b1): restore privileged:true — cap_drop approach broke nsenter
fix(update): in-place migration to revert installs back to privileged:true
docs(spec): mark Phase 0 ✅
```

When all 6 acceptance tests pass, the operator confirms in chat,
and the session marks Phase 0 ✅ and proceeds to Phase A in the
same session if context allows, OR stops cleanly so the next session
picks up Phase A from the spec.

---

## Phase A — Host-side agent: design + scaffold

**Goal.** Build the host-side RPC agent that replaces nsenter as the
container's bridge to host operations. Agent scaffold only — methods
return UnimplementedError except `agent.ping`. The container is
DUAL-TRACKED: nsenter still works (privileged: true stays), the
agent socket is mounted in but no production code uses it yet.

**Language: Go.** Single static binary, well-suited for Unix-socket
servers, ships without a runtime. Build target: `dist/proxypilot-agent`
(ELF, ~5MB, runs anywhere).

**Wire protocol.** JSON-over-newline-delimited Unix socket.

```
Request:  {"id":<int>,"method":"<name>","params":{...}}\n
Response: {"id":<int>,"result":<any>}\n  on success
          {"id":<int>,"error":{"code":"<code>","message":"<msg>"}}\n  on failure
```

* Method names: dotted, e.g. `caddy.adapt`, `incus.exec`.
* `id` echoed back so callers can pipeline (later optimization).
* Connection per call is fine for v1; pooling is a later concern.

**Files to create.**

```
cmd/agent/main.go                              Entry point, --socket flag, accept loop
cmd/agent/dispatcher.go                        Method registry + JSON encode/decode
cmd/agent/methods/agent_ping.go                The one method that works (returns "pong")
cmd/agent/methods/registry.go                  Method-to-handler map
deploy/proxypilot-agent.service                Systemd unit
deploy/build-agent.sh                          `go build` wrapper used by install.sh
admin/backend/src/lib/agent.js                 Node client: agentCall(method, params)
admin/backend/src/lib/agent.test.mjs           Smoke test against the running binary
docs/features/security-completion/host-side-agent-spec.md   Per-method protocol reference
```

**Files to modify.**

```
install.sh
  * Create system user + group `proxypilot-agent`
  * Install Go (or require Go 1.21+ pre-installed)
  * Run deploy/build-agent.sh, place binary at /usr/local/bin/proxypilot-agent
  * Install systemd unit, enable + start
  * The Docker container's /etc/sub{u,g}id additions: add the proxypilot-agent group so the container can read the socket
  * docker-compose.yml: add bind mount `/run/proxypilot-agent.sock:/run/proxypilot-agent.sock:ro` and `group_add: ["proxypilot-agent"]`
  * Keep `privileged: true` and `pid: host` — Phase F is what drops them

update.sh
  * Detect missing agent binary or systemd unit, install/enable
  * Detect missing socket bind-mount in docker-compose.yml, sed-add it
  * The agent is dual-tracked, no breaking changes to existing behavior
```

**Systemd unit content.**

```ini
[Unit]
Description=ProxyPilot host-side agent
After=network.target

[Service]
Type=simple
User=proxypilot-agent
Group=proxypilot-agent
ExecStart=/usr/local/bin/proxypilot-agent --socket=/run/proxypilot-agent.sock
Restart=on-failure
RestartSec=2

# Hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
RestrictAddressFamilies=AF_UNIX
LockPersonality=true
RestrictRealtime=true

# Read/write paths the agent needs to drive caddy + incus + docker
ReadWritePaths=/etc/caddy /run /var/lib/incus /var/run/docker.sock

[Install]
WantedBy=multi-user.target
```

**Node client API.**

```js
// admin/backend/src/lib/agent.js
export async function agentCall(method, params = {}, opts = {}) {
  const socketPath = process.env.PROXYPILOT_AGENT_SOCKET || '/run/proxypilot-agent.sock';
  const timeoutMs = opts.timeoutMs ?? 30_000;
  // Connect, write one JSON line, read one JSON line, close. Throw on
  // protocol error or method error. Return result on success.
}
```

**Acceptance tests (operator runs on disposable VM).**

- [ ] A.V1 — `systemctl status proxypilot-agent` shows active (running).
- [ ] A.V2 — `echo '{"id":1,"method":"agent.ping","params":{}}' | nc -U /run/proxypilot-agent.sock` returns `{"id":1,"result":"pong"}`.
- [ ] A.V3 — Inside the proxypilot Docker container: `nc -U /run/proxypilot-agent.sock < ping.json` works (the bind mount + group is wired).
- [ ] A.V4 — `node -e "import('./admin/backend/src/lib/agent.js').then(m => m.agentCall('agent.ping')).then(console.log)"` from inside the container prints `pong`.
- [ ] A.V5 — Dashboard still works end-to-end (Add Service, Incus page, Caddy reload — all going through nsenter, agent NOT YET in the production path).
- [ ] A.V6 — `update.sh` on an existing install picks up the agent: builds binary, enables service, mounts socket, container restarts cleanly. Health check passes.

**Commits (one per checklist item).**

```
feat(agent): A.1 Go agent skeleton + dispatcher + agent.ping method
feat(agent): A.2 systemd unit with hardening directives
feat(agent): A.3 install.sh creates user, builds binary, installs unit
feat(agent): A.4 docker-compose socket bind-mount + group_add
feat(agent): A.5 Node client lib + smoke test
fix(update): A.6 in-place migration installs agent on existing deploys
docs(spec): A.V1-V6 verified, Phase A ✅
```

When A.V1-V6 pass, mark Phase A ✅. Operator confirms before Phase B.

---

## Phase B — Host-side agent: Caddy methods

**Goal.** Implement and migrate every Caddy operation onto the agent
behind a feature flag. Dual-tracked: nsenter path still works,
flag flips to use agent.

**Methods to implement.**

| Method | Params | Result |
|---|---|---|
| `caddy.adapt` | `{ config_text: string }` | `{ ok: bool, adapted_json?: string, error?: string }` |
| `caddy.reload` | `{ config_path?: string }` (default `/etc/caddy/Caddyfile`) | `{ ok: bool, error?: string }` |
| `caddy.list_modules` | `{}` | `{ modules: string[] }` |
| `caddy.fmt` | `{ config_text: string }` | `{ formatted: string, error?: string }` |
| `caddy.version` | `{}` | `{ version: string }` |

Input validation:
* `config_text` length cap: 5 MB.
* `config_path` must match `^/etc/caddy/[A-Za-z0-9_/.-]+$` — no `..`, no absolute escape.

**Files.**

```
cmd/agent/methods/caddy.go                     Implementations
cmd/agent/methods/caddy_test.go                Unit tests (table-driven)
admin/backend/src/routes/services.js           Migrate exec sites behind PROXYPILOT_USE_AGENT_FOR_CADDY flag
docs/features/security-completion/host-side-agent-spec.md  Per-method spec rows
```

**Feature flag.** New env var `PROXYPILOT_USE_AGENT_FOR_CADDY=false`
default. When `true`, the backend's existing Caddy reload helper
calls `agentCall('caddy.reload')` instead of `execOnHost('caddy reload …')`.
Phase F flips the default to `true`.

**Acceptance tests.**

- [ ] B.V1 — Flag OFF: existing dashboard behavior unchanged. Add Service still triggers Caddy reload via nsenter.
- [ ] B.V2 — Flag ON: Add Service triggers Caddy reload via agent. Verified by `journalctl -u proxypilot-agent --since "1 min ago"` showing the method call.
- [ ] B.V3 — Flag ON: malformed Caddyfile produces `caddy.adapt` error response, dashboard surfaces clean error message.
- [ ] B.V4 — `agent.ping` continues to work alongside the new methods.
- [ ] B.V5 — `update.sh` picks up the new methods on an existing deploy without operator intervention.

When B.V1-V5 pass, mark Phase B ✅. Operator approves Phase C.

---

## Phase C — Host-side agent: Incus methods

**Goal.** Migrate every `incus` shellout to the agent. This is the
biggest single migration in the project — Incus drives container
lifecycle, snapshots, networking, profiles, images.

**Methods to implement.**

| Method | Params | Result |
|---|---|---|
| `incus.version` | `{}` | `{ client: string, server: string }` |
| `incus.list` | `{ project?: string }` | `{ containers: [{ name, status, ipv4, type, ... }] }` |
| `incus.exec` | `{ name, command, env?, cwd?, timeout_ms? }` | `{ stdout, stderr, exit_code }` |
| `incus.create` | `{ name, image, profile?, config? }` | `{ ok, error? }` |
| `incus.start` / `incus.stop` / `incus.restart` | `{ name }` | `{ ok, error? }` |
| `incus.delete` | `{ name, force?: bool }` | `{ ok, error? }` |
| `incus.snapshot.create` | `{ name, snapshot_name, stateful?: bool }` | `{ ok, error? }` |
| `incus.snapshot.restore` | `{ name, snapshot_name }` | `{ ok, error? }` |
| `incus.snapshot.delete` | `{ name, snapshot_name }` | `{ ok, error? }` |
| `incus.snapshot.list` | `{ name }` | `{ snapshots: [...] }` |
| `incus.network.list` | `{}` | `{ networks: [...] }` |
| `incus.network.show` | `{ name }` | `{ network: {...} }` |
| `incus.profile.list` | `{}` | `{ profiles: [...] }` |
| `incus.profile.show` | `{ name }` | `{ profile: {...} }` |
| `incus.storage.list` | `{}` | `{ pools: [...] }` |
| `incus.image.list` | `{}` | `{ images: [...] }` |
| `incus.config.set` | `{ name, key, value }` | `{ ok, error? }` |
| `incus.file.push` | `{ name, dest_path, content_b64, mode?, owner? }` | `{ ok }` |
| `incus.file.pull` | `{ name, src_path, max_bytes? }` | `{ content_b64 }` |

**Input validation (CRITICAL — this is the agent's main job).**

* `name` must match `^[a-z][a-z0-9-]{0,62}$`.
* `command` length cap: 16 KB.
* `command` deny-list checked AFTER allowlist normalization (no
  `--privileged`, no `--cap-add`, no `nsenter`, no `chroot`, no
  `mount` outside the container's own bind paths).
* `env` keys match `^[A-Z_][A-Z0-9_]*$`, values bounded.
* `timeout_ms` capped at 600_000 (10 min).
* `dest_path` / `src_path` for file methods must be inside the
  container's filesystem (no `..`, no `/proc`, no `/sys`).
* `content_b64` size cap: 100 MB (push), 100 MB (pull max_bytes).

**Files.**

```
cmd/agent/methods/incus.go                     All incus.* methods
cmd/agent/methods/incus_validation.go          Allowlist + deny-list helpers
cmd/agent/methods/incus_test.go                Unit + integration tests
admin/backend/src/routes/lxc.js                Migrate every execOnHost('incus ...') behind PROXYPILOT_USE_AGENT_FOR_INCUS
admin/backend/src/routes/services.js           Migrate any incus refs
docs/features/security-completion/host-side-agent-spec.md   Per-method protocol rows
```

**Feature flag.** `PROXYPILOT_USE_AGENT_FOR_INCUS=false` default.
Flip in Phase F.

**Acceptance tests (operator on disposable VM with at least 2 LXC containers).**

- [ ] C.V1 — Flag OFF: Incus page works as today (via nsenter).
- [ ] C.V2 — Flag ON: Incus page populates from agent. Networks, storage, profiles, images all visible. No errors in the dashboard or agent journalctl.
- [ ] C.V3 — Flag ON: create a new LXC container from the wizard. Container appears in Incus, ProxyPilot lists it as a service.
- [ ] C.V4 — Flag ON: open the legacy terminal (request-response) on a running container, run `whoami` — succeeds. (The interactive WS terminal is a separate feature, out of scope here.)
- [ ] C.V5 — Flag ON: take a snapshot, restore from it, delete it. Each shows a clear success/failure in the audit log.
- [ ] C.V6 — Flag ON: invalid container name (`../../../etc/passwd`) is rejected by the agent's validation BEFORE any incus call runs. Audit shows the rejection.
- [ ] C.V7 — Flag ON: command with denied pattern (`incus.exec` with `--privileged` in args) is rejected.

When C.V1-V7 pass, mark Phase C ✅.

---

## Phase D — Host-side agent: Docker methods

**Goal.** Migrate every Docker shellout to the agent. Smaller surface
than Incus but politically important: the Docker socket bind-mount
into the container is what Phase F removes, so Docker MUST flow
through the agent before that happens.

**Methods to implement.**

| Method | Params | Result |
|---|---|---|
| `docker.version` | `{}` | `{ client, server, compose }` |
| `docker.ps` | `{ all?: bool, filter?: object }` | `{ containers: [...] }` |
| `docker.logs` | `{ container, tail?, since? }` | `{ logs: string }` |
| `docker.exec` | `{ container, command, env?, timeout_ms? }` | `{ stdout, stderr, exit_code }` |
| `docker.compose.up` | `{ install_dir, options?: { build?, no_cache? } }` | `{ ok, error? }` |
| `docker.compose.down` | `{ install_dir, remove_orphans?: bool }` | `{ ok, error? }` |
| `docker.compose.build` | `{ install_dir, options?: { no_cache? } }` | `{ ok, error? }` |
| `docker.compose.ps` | `{ install_dir }` | `{ services: [...] }` |
| `docker.image.list` | `{}` | `{ images: [...] }` |
| `docker.network.list` | `{}` | `{ networks: [...] }` |

**Input validation.**

* `container` matches container-name regex.
* `command` deny-list mirrors incus.exec — no `--privileged`,
  `--cap-add`, `--pid=host`, `--mount`, etc.
* `install_dir` must be under `/opt/proxypilot/` or
  `/var/lib/proxypilot-services/<service-name>/`. No `..` traversal.
* `tail` capped at 10000 lines, `since` parsed as ISO-8601 or duration.

**Files.**

```
cmd/agent/methods/docker.go                    All docker.* methods
cmd/agent/methods/docker_validation.go         Path + arg validation
cmd/agent/methods/docker_test.go               Unit tests
admin/backend/src/routes/services.js           Migrate `docker compose` calls
admin/backend/src/routes/lxc.js                Any docker refs there too
docs/features/security-completion/host-side-agent-spec.md   Per-method spec rows
```

**Feature flag.** `PROXYPILOT_USE_AGENT_FOR_DOCKER=false` default.

**Note on the Docker socket.** The agent runs on the host and uses
the host's Docker socket directly (`/var/run/docker.sock`, owned by
root or the docker group). The agent's systemd unit's
`SupplementaryGroups=docker` adds it to the docker group. The
ProxyPilot container's `/var/run/docker.sock` bind-mount becomes
unnecessary — Phase F removes it.

**Acceptance tests.**

- [ ] D.V1 — Flag OFF: Docker dashboard pages work as today.
- [ ] D.V2 — Flag ON: Docker container list populates from agent.
- [ ] D.V3 — Flag ON: `docker compose up` from the dashboard rebuilds a docker-compose service correctly.
- [ ] D.V4 — Flag ON: Volume import / export feature still works.
- [ ] D.V5 — Flag ON: invalid `install_dir` (`/etc/passwd`) is rejected by validation.
- [ ] D.V6 — Flag ON: command with denied pattern (`--privileged` in docker.exec) is rejected.

When D.V1-V6 pass, mark Phase D ✅.

---

## Phase E — Host-side agent: misc methods (git / npm / systemd)

**Goal.** Cover the remaining nsenter calls. Mostly used by the
self-update flow in the dashboard's "Settings → Update" page.

**Methods.**

| Method | Params | Result |
|---|---|---|
| `git.pull` | `{ install_dir, branch? }` | `{ ok, output, error? }` |
| `git.fetch` | `{ install_dir, ref? }` | `{ ok, output, error? }` |
| `git.status` | `{ install_dir }` | `{ clean: bool, files: string[] }` |
| `git.rev_parse` | `{ install_dir, ref }` | `{ sha: string }` |
| `npm.install` | `{ directory }` | `{ ok, output, error? }` |
| `npm.run` | `{ directory, script }` | `{ ok, output, error? }` |
| `npm.ci` | `{ directory }` | `{ ok, output, error? }` |
| `systemd.reload` | `{ unit }` | `{ ok, error? }` |
| `systemd.restart` | `{ unit }` | `{ ok, error? }` |
| `systemd.status` | `{ unit }` | `{ active: bool, status: string }` |

**Input validation.**

* `install_dir` / `directory` allowlisted as in Docker phase.
* `branch` / `ref` matches `^[A-Za-z0-9._/-]{1,200}$` — no `..`, no shell metachars.
* `script` is one of an allowlist read from the directory's
  `package.json` `scripts` keys (the agent reads the file and
  validates against it). No arbitrary npm scripts.
* `unit` matches `^proxypilot[a-z0-9-]*\.service$` — only
  ProxyPilot's own units, never anything else on the host.

**Files.**

```
cmd/agent/methods/git.go
cmd/agent/methods/npm.go
cmd/agent/methods/systemd.go
admin/backend/src/routes/user.js               Migrate git+npm calls in the version-update flow
docs/features/security-completion/host-side-agent-spec.md
```

**Feature flag.** `PROXYPILOT_USE_AGENT_FOR_MISC=false` default.

**Acceptance tests.**

- [ ] E.V1 — Flag ON: `Settings → Update` triggers `git fetch` + `git pull` via the agent. Update completes successfully on the disposable VM.
- [ ] E.V2 — Flag ON: `npm install` and `npm run build` invoked by the same flow run via the agent.
- [ ] E.V3 — Flag ON: attempt to call `npm.run` with a script not in package.json — agent rejects.
- [ ] E.V4 — Flag ON: attempt to call `systemd.restart` on a non-proxypilot unit (e.g., `nginx.service`) — agent rejects.

When E.V1-V4 pass, mark Phase E ✅.

---

## Phase F — Drop `privileged: true`

**Goal.** Switch the ProxyPilot container to unprivileged. The agent
is now the only path for host operations. After Phase F, container
compromise is bounded by the agent's protocol — the original B1
intent is realized.

**Pre-conditions** (block Phase F if any are unmet):

* Phases A-E all ✅
* All four feature flags (CADDY, INCUS, DOCKER, MISC) have been
  flipped to ON in production for at least 7 days
* The operator has run an end-to-end smoke (Add Service, Incus
  page, Docker page, Settings → Update) on production with the
  flags ON, no nsenter calls observed in the last week's logs

**Files to modify.**

* `install.sh` — rewrite `create_docker_compose()`:
  * Remove `privileged: true`
  * Remove `pid: host`
  * Remove `cap_drop`, `cap_add`, `security_opt` if any are present
  * Remove `/var/run/docker.sock` bind-mount (the agent owns Docker now)
  * Keep:
    * `/etc/caddy/sites:/etc/caddy/sites` (read by the container too)
    * `/etc/caddy/custom:/etc/caddy/custom`
    * `/etc/caddy/Caddyfile:/etc/caddy/Caddyfile`
    * `./data:/data` (the SQLite + secrets dir)
    * `/run/proxypilot-agent.sock:/run/proxypilot-agent.sock:ro` (the agent socket)
  * `cap_drop: [ALL]`, `security_opt: [no-new-privileges:true]`,
    `read_only: true` with `tmpfs: [/tmp]` for ephemeral writes,
    `user: proxypilot` (the Dockerfile's existing non-root user)

* `update.sh` — full migration step:
  * Detect `privileged: true` in the deployed compose file
  * Confirm all feature flags have been ON in `.env`
  * Block the migration with a clear error if any flag is OFF
  * Replace privileged config with the unprivileged shape
  * Run a post-up health check that exercises every category of
    operation: Caddy reload, Incus list, Docker ps, git fetch.
    Any failure → roll back to the privileged compose, surface
    the error, exit 1.

* All `nsenter` based `execOnHost` helpers in `admin/backend/src/`
  are deleted in this phase. Search for `nsenter` and remove every
  match.

* The four feature flag default values flip to `true`. The flags
  themselves stay (so they can be disabled in an emergency by
  setting them to `false` in `.env`), but the dual-track is gone.

**Acceptance tests.**

- [ ] F.V1 — `docker inspect proxypilot-admin --format '{{.HostConfig.Privileged}}'` returns `false`.
- [ ] F.V2 — `docker exec proxypilot-admin nsenter -t 1 -- ls /` fails with EACCES (no `pid: host`).
- [ ] F.V3 — Add Service, Incus page, Docker page, Settings → Update — all functional via the agent.
- [ ] F.V4 — Audit log on the agent side shows EVERY method call from the dashboard during the smoke test.
- [ ] F.V5 — `update.sh` migration on an existing privileged install completes successfully and passes the post-migration health check.
- [ ] F.V6 — All four `PROXYPILOT_USE_AGENT_FOR_*` env vars default to `true` in `.env.example`. Existing installs with explicit OFF values STILL work as long as nsenter is no longer the path — but the OFF case effectively disables the feature category. Documented in the README.

When F.V1-V6 pass, **B1 is closed.** This is the moment ProxyPilot's
production-readiness statement loses the privileged-equivalent caveat.

---

## Phase G — Agent hardening + audit + rate limiting

**Goal.** Operationally harden the agent. After Phase F the agent IS
the trust boundary; treat it that way.

**Deliverables.**

* **Per-method audit log on the agent side.** New SQLite DB at
  `/var/lib/proxypilot-agent/audit.db` (mode 0600, owned by
  proxypilot-agent). Schema:
  ```sql
  CREATE TABLE method_calls (
    id INTEGER PRIMARY KEY,
    ts TEXT DEFAULT CURRENT_TIMESTAMP,
    method TEXT NOT NULL,
    caller_pid INTEGER, caller_uid INTEGER, caller_gid INTEGER,
    params_hash TEXT,    -- SHA-256 of the JSON params (no sensitive data in plaintext)
    duration_ms INTEGER,
    result_code TEXT,    -- 'ok', 'validation_error', 'method_error', 'timeout'
    error_message TEXT
  );
  ```

* **Per-method rate limiting** in the agent. Token bucket per method:
  * `caddy.reload`: 10/min
  * `caddy.adapt`: 30/min
  * `incus.exec`: 60/min
  * `docker.compose.up`: 1/5min
  * `docker.compose.build`: 1/10min
  * Default for unspecified: 30/min
  * Limits configurable via `/etc/proxypilot-agent/rate-limits.toml`.

* **Deny-list of dangerous arg patterns.** Centralized in
  `cmd/agent/methods/denylist.go`. Patterns:
  * `--privileged`, `--cap-add`, `--cap-drop`
  * `--pid=host`, `--ipc=host`, `--net=host`
  * `--mount`, `--volume` outside whitelisted paths
  * `chroot`, `unshare`, `nsenter`
  * `mount.cifs`, `mount.nfs`
  * Any path containing `..`
  * Any path under `/proc/`, `/sys/`, `/dev/` (read-only access via `/dev/null`, `/dev/zero` exempt)
  * Tested via table-driven unit tests.

* **Agent health endpoint.** HTTP-over-Unix-socket at the same
  socket: `GET /health` returns `{"status":"ok","uptime_s":N}`.
  Used by an external uptime check (Phase I).

* **Documentation.**
  * `docs/features/security-completion/USAGE.md` — operator-facing:
    how to inspect agent state, read audit log, tune rate limits,
    disable a method category in an emergency.
  * `docs/features/security-completion/TROUBLESHOOTING.md` — debug
    runbook: agent not starting, socket permission errors, method
    rejected unexpectedly, audit log growing too large.
  * `docs/features/security-completion/ARCHITECTURE.md` — the
    design rationale, kept up to date as Phase G lands.

* **Audit log retention.** Cron-like cleanup inside the agent:
  delete rows older than `AUDIT_RETENTION_DAYS` (default 90).
  Vacuum the DB monthly.

**Acceptance tests.**

- [ ] G.V1 — Every method call from the dashboard appears in `/var/lib/proxypilot-agent/audit.db` with caller PID + duration + result code.
- [ ] G.V2 — Rapid-fire 100 `caddy.reload` calls — first 10 succeed, rest return `rate_limit_exceeded`. Audit log records all 100.
- [ ] G.V3 — Method call with denied arg pattern returns `validation_error`, no shellout occurs. Verified via `strace -f -p $(pidof proxypilot-agent)` showing no `execve` for the rejected request.
- [ ] G.V4 — `curl --unix-socket /run/proxypilot-agent.sock http://localhost/health` returns `{"status":"ok","uptime_s":N}`.
- [ ] G.V5 — Audit log retention: insert a row dated 100 days ago, run cleanup, row gone. Vacuum runs without error.

When G.V1-V5 pass, mark Phase G ✅. The host-side-agent rewrite is
complete.
