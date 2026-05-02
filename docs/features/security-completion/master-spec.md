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
| A | Host-side agent: design + scaffold | 🟡 |
| B | Host-side agent: Caddy methods | 🟡 |
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

Status legend below: 🤖 = auto-runnable in any sandbox with a Go
toolchain + Node 20+. 👤 = requires a real VM with systemd, Docker,
the deployed install, etc.; the operator runs these by hand.

- [ ] A.V1 👤 — `systemctl status proxypilot-agent` shows active (running).
- [x] A.V2 🤖 — `echo '{"id":1,"method":"agent.ping","params":{}}' | nc -U <socket>` returns `{"id":1,"result":"pong"}`. Verified locally during 3.1 + 3.7 with a binary built from cmd/agent/.
- [ ] A.V3 👤 — Inside the proxypilot Docker container: `nc -U /run/proxypilot-agent.sock < ping.json` works (the bind mount + group is wired). Cannot be exercised without a running container; docker-compose changes (3.4 / 3.6) need the operator's deployed VM to verify.
- [x] A.V4 🤖 — `agentCall('agent.ping')` from `admin/backend/src/lib/agent.js` returns `'pong'`. Verified locally during 3.7 against the real Go binary on a tmp socket. The full V4 (running INSIDE the container) is 👤.
- [ ] A.V5 👤 — Dashboard still works end-to-end (Add Service, Incus page, Caddy reload — all going through nsenter, agent NOT YET in the production path). Phase A is dual-track; no production code path imports lib/agent.js, so V5 is conceptually a regression test that the install/update changes didn't break the existing nsenter flow.
- [ ] A.V6 👤 — `update.sh` on an existing install picks up the agent: builds binary, enables service, mounts socket, container restarts cleanly. Health check passes. The Python compose-mutation logic was idempotency-tested locally against a synthetic legacy compose file (3.6).

**Auto-coverage so far.** V2 (round-trip on a tmp socket) and V4
(Node client → real binary) both pass on the build sandbox. The
node:test suite for `lib/agent.js` covers four code paths (success,
AgentError envelope, hung-server timeout, missing-socket transport
error). V1, V3, V5, V6 require a real disposable VM and are
operator gates before Phase A flips to ✅.

**Commits (one per checklist item).**

```
feat(agent): A.1 Go agent skeleton + dispatcher + agent.ping method
feat(agent): A.2 systemd unit with hardening directives
feat(agent): A.3 install.sh creates user, builds binary, installs unit
feat(agent): A.4 docker-compose socket bind-mount + group_add
feat(agent): A.5 Node client lib + smoke test
fix(update): A.6 in-place migration installs agent on existing deploys
docs(spec): A.7 Phase A scaffold complete, awaiting operator V1-V6
```

Phase A is currently 🟡 — scaffold shipped, V2 + V4 auto-verified.
Final flip to ✅ happens once the operator runs V1, V3, V5, V6 on a
disposable VM and confirms in chat. Operator confirms before Phase B.

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

Legend (carried over from Phase A): 🤖 = auto-runnable in this
sandbox. 👤 = requires a real disposable VM with systemd, Docker,
and the full deploy.

- [ ] B.V1 👤 — Flag OFF: existing dashboard behavior unchanged. Add Service still triggers Caddy reload via nsenter. `journalctl -u proxypilot-agent --since "1 min ago"` shows no agent calls during a service add.
- [ ] B.V2 👤 — Flag ON (`PROXYPILOT_USE_AGENT_FOR_CADDY=true` in .env, container restarted): Add Service triggers Caddy reload via agent. Verified by `journalctl -u proxypilot-agent --since "1 min ago"` showing `caddy.reload` entries.
- [ ] B.V3 👤 — Flag ON: malformed Caddyfile (e.g. paste a bad route into Edit Service) produces `caddy.adapt` ok=false → dashboard surfaces a clean error toast (not a 500 / nsenter exception trace).
- [x] B.V4 🤖 — `agent.ping` continues to work alongside the new methods. `TestDefaultRegistryHasAllCaddyMethods` in `cmd/agent/methods/caddy_test.go` locks in the registration contract for all six methods (agent.ping + caddy.adapt/reload/fmt/list_modules/version); duplicate-Register would panic at startup.
- [ ] B.V5 👤 — `update.sh` on an existing deploy: rebuilds the agent binary with the new methods, container restarts, `.env` gets `PROXYPILOT_USE_AGENT_FOR_CADDY=false` appended by `sync_env_keys()`, dashboard still works flag-OFF.

**Auto-coverage so far.** The Go test suite at
`cmd/agent/methods/caddy_test.go` covers all five caddy methods
with table-driven cases for success, oversized config_text,
malformed JSON, /etc/caddy traversal + shell-metachar config_path,
invalid Caddyfile → structured ok=false carrying stderr,
caddy fmt exit-1 (formatting differed) → still returns text, and
missing-binary → graceful caddy_exec_failed envelope on every
method (no crash). 28 sub-tests, all green.

The backend driver at `admin/backend/src/lib/caddy-driver.js` is
covered by `admin/backend/src/__tests__/caddy-driver.test.js`:
flag-OFF fallthrough, flag-ON forwarding for both methods,
agent-side ok=false → exec-like error shape, transport error →
exec-like error shape, and a defence-in-depth check that only the
literal string `"true"` enables the agent path. 7 sub-tests.

Total npm test count: 25 → 32. V1, V2, V3, V5 all require the
disposable VM and are operator gates before Phase B flips to ✅.

**Commits (one per checklist item).**

```
feat(agent): B.1 caddy.adapt — validate Caddyfile via tmpfile + exec
feat(agent): B.2 caddy.reload — strict /etc/caddy path validation + force reload
feat(agent): B.3 caddy.fmt + caddy.list_modules + caddy.version
test(agent): B.4 table-driven coverage for all five caddy methods
feat(backend): B.5 caddy-driver dual-track helper + migrate services.js
feat(install): B.6 PROXYPILOT_USE_AGENT_FOR_CADDY=false plumbed everywhere
docs(spec): B.7 Phase B scaffold complete, awaiting operator V1-V5
```

Phase B is currently 🟡 — methods + driver + flag plumbing
shipped, V4 auto-verified. Final flip to ✅ happens once the
operator runs V1, V2, V3, V5 on a disposable VM and confirms in
chat. Phase B keeps `PROXYPILOT_USE_AGENT_FOR_CADDY=false` by
default; Phase F flips defaults to true after burn-in. Operator
approves Phase C only after B is ✅.

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

---

## Phase H — Backup automation

**Goal.** Daily DB + secrets + Caddy state backup with offsite sync.
Today, only pre-update snapshots exist — disk failure = total loss.

**Deliverables.**

* `deploy/backup/proxypilot-backup.sh` — script run by cron:
  * Locks via `flock /var/lock/proxypilot-backup.lock`.
  * `sqlite3 /opt/proxypilot/data/proxypilot.db ".backup '/var/backups/proxypilot/db-<ts>.db'"` — produces a consistent snapshot via SQLite's online backup API.
  * Bundles the DB + `.env` (the only file holding `TOTP_ENCRYPTION_KEY`, `JWT_SECRET`, `SESSION_SECRET`) + `/etc/caddy/sites/` + `/etc/caddy/custom/` + `/var/lib/caddy/.local/share/caddy/` (cert store) into a tarball.
  * gpg-encrypts the tarball with the operator's public key (ID set in `BACKUP_GPG_RECIPIENT` env var). Without a key set: tarball is uploaded unencrypted but with a loud warning in the install.
  * Uploads to a configured destination via rclone:
    * `BACKUP_REMOTE=s3:bucket/path` or `BACKUP_REMOTE=b2:bucket/path` etc.
    * If `BACKUP_REMOTE` is unset, only local `/var/backups/proxypilot/` retention.
  * Local retention: last 7 days. Remote retention: configurable, default 30 days.
* `deploy/backup/proxypilot-backup.cron` — installed at
  `/etc/cron.d/proxypilot-backup`, runs at 03:00 daily.
* `install.sh` — installs the script, prompts the operator for
  `BACKUP_GPG_RECIPIENT` and `BACKUP_REMOTE` (skippable for homelab).
* `update.sh` — re-installs the cron and script if missing.
* `docs/features/security-completion/USAGE.md` adds a "Restoring
  from backup" runbook.

**Acceptance tests.**

- [ ] H.V1 — `proxypilot-backup.sh` run manually produces a valid `.tar.gz.gpg` (or `.tar.gz` if no GPG key configured).
- [ ] H.V2 — Tarball restoration: extract on a fresh Debian VM, `cp` files to expected paths, run install.sh → ProxyPilot boots with the original DB intact, including users, services, audit log.
- [ ] H.V3 — Cron runs at 03:00, log entry at `/var/log/proxypilot-backup.log`.
- [ ] H.V4 — Local retention: 8th day's backup pushes the 1st day's out.
- [ ] H.V5 — rclone upload succeeds if configured, no-op if not.

When H.V1-V5 pass, mark Phase H ✅.

---

## Phase I — External monitoring + paging

**Goal.** Get paged when the dashboard is down. `/api/health` exists
already; nothing watches it.

**Deliverables.**

* `docs/features/security-completion/USAGE.md` adds a "Setting up
  external monitoring" section:
  * Recommended: Healthchecks.io (free tier covers single-tenant)
  * Alt: UptimeRobot, BetterUptime
  * The endpoint to monitor: `https://<DOMAIN>/api/health`
  * Expected response: `200` with `{"status":"ok",...}` JSON
  * Suggested alerting: 2 consecutive failures over 5 minutes
* `deploy/monitoring/healthchecks-cron.sh` — optional helper that
  pings a Healthchecks.io URL after `update.sh` completes
  successfully, so backups + updates show up as "fresh" in the
  dashboard.
* New audit-log filter: dashboards-page can show "5xx error rate
  per hour" computed from access_log. (Existing access_log table
  is queried, no schema change.)

**Acceptance tests.**

- [ ] I.V1 — Operator configures Healthchecks.io against the dashboard's `/api/health`. After 5 minutes of successful checks, status shows green.
- [ ] I.V2 — Stop the proxypilot container. Within 5 minutes, Healthchecks.io alerts the operator's email/Slack.
- [ ] I.V3 — Restart. Within 5 minutes, Healthchecks alerts "back up".
- [ ] I.V4 — `update.sh` completes → optional Healthchecks ping shows the update timestamp.

When I.V1-V4 pass, mark Phase I ✅.

---

## Phase J — Account lockout per-user

**Goal.** Today's rate limiter is per-IP. An attacker rotating IPs
sees no lockout. Add per-user lockout on top.

**Deliverables.**

* New columns on `users` (migration version 6):
  ```sql
  ALTER TABLE users ADD COLUMN failed_login_count INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE users ADD COLUMN locked_until TEXT;  -- ISO-8601, NULL when not locked
  ```
* `routes/auth.js` `/login`:
  * Before bcrypt compare: if `locked_until` is in the future,
    return 429 with the unlock time. No password check happens.
  * On failed password: increment `failed_login_count`. If it
    reaches `LOCKOUT_THRESHOLD` (default 10), set `locked_until` to
    NOW + `LOCKOUT_DURATION_MIN` (default 15 min) and log
    `ACCOUNT_LOCKED` audit event.
  * On success: reset `failed_login_count` to 0, clear `locked_until`.
* New env vars in `.env.example`: `LOCKOUT_THRESHOLD=10`,
  `LOCKOUT_DURATION_MIN=15`.
* Admin UI: Users page shows lockout state per user. Admin can
  manually unlock by clearing `locked_until` (audit event
  `ACCOUNT_UNLOCKED`).
* `proxypilot unlock-user <username>` CLI on the host (or via the
  dashboard) for the case where admin gets locked out themselves.

**Acceptance tests.**

- [ ] J.V1 — 11 failed login attempts on the same username from different IPs locks the user. 12th attempt returns 429, no bcrypt cost paid.
- [ ] J.V2 — `locked_until` expires → user can log in again with correct credentials.
- [ ] J.V3 — Successful login resets `failed_login_count` to 0.
- [ ] J.V4 — Admin can unlock another user. Audit log records who unlocked whom.
- [ ] J.V5 — `proxypilot unlock-user thomas` works from the host shell.

When J.V1-V5 pass, mark Phase J ✅.

---

## Phase K — Sudo-mode for destructive ops

**Goal.** Once you've cleared TOTP at login, you stay authenticated
for 24h for ANYTHING — including delete-all-services. Sensitive
operations should require a fresh TOTP code.

**Deliverables.**

* New middleware `requireFreshTotp` in `admin/backend/src/middleware/auth.js`:
  * Reads `pp_sudo_until` cookie (httpOnly, SameSite=Strict).
  * If absent or expired, returns 403 with `{ error: "sudo_required" }`.
  * Frontend interprets that as "show TOTP prompt, then retry".
* New endpoint `POST /api/auth/sudo` — accepts `{ totpCode }`,
  validates, sets `pp_sudo_until` cookie with 5-minute expiry.
* Operations that get `requireFreshTotp`:
  * DELETE /api/services/:id
  * DELETE /api/lxc/containers/:name
  * DELETE /api/users/:id
  * POST /api/services/caddy/regenerate-all
  * POST /api/auth/rotate-jwt-secret (Phase O)
  * POST /api/auth/rotate-totp-key (Phase N)
  * Any future irreversible op
* Frontend: `useSudo()` hook that wraps any action button —
  intercepts 403 sudo_required, opens a TOTP-prompt modal, posts
  to `/api/auth/sudo`, retries the original action.

**Acceptance tests.**

- [ ] K.V1 — Logged in as admin, click "Delete service" → TOTP prompt appears. Wrong code → action blocked. Right code → service deleted.
- [ ] K.V2 — After successful sudo, deleting a SECOND service within 5 minutes does NOT re-prompt.
- [ ] K.V3 — After 5+ minutes, deleting another service prompts again.
- [ ] K.V4 — Sudo cookie has SameSite=Strict + HttpOnly + Secure (in prod).
- [ ] K.V5 — `pp_sudo_until` is cleared on logout.

When K.V1-V5 pass, mark Phase K ✅.

---

## Phase L — Inactivity timeout + sliding sessions

**Goal.** JWT expires 24h hard. Should be sliding window: each
authenticated request bumps expiry, 30-min inactivity = expired.

**Deliverables.**

* JWT TTL drops to 30 minutes. Each authenticated request in
  `authenticateToken` middleware re-signs the token with a fresh
  30-min expiry IF the existing token is < 5 min from expiry, and
  sets the new cookie. Avoids re-signing on every request (cost).
* On idle ≥ 30 min → cookie expires, next request returns 401, frontend redirects to login.
* `INACTIVITY_TIMEOUT_MIN` env var (default 30) configurable.
* Documented in USAGE.md: "Sessions auto-expire after 30 minutes
  of inactivity. Set INACTIVITY_TIMEOUT_MIN to adjust."

**Acceptance tests.**

- [ ] L.V1 — Login, sit idle for 31 minutes, click anything → bounced to login.
- [ ] L.V2 — Login, click around every 5 minutes → session stays alive indefinitely.
- [ ] L.V3 — `pp_token` cookie's `Expires` attribute updates only when re-signed (≤ 5 min from old expiry).
- [ ] L.V4 — `INACTIVITY_TIMEOUT_MIN=120` extends to 2 hours.

When L.V1-V4 pass, mark Phase L ✅.

---

## Phase M — JWT revocation via DB-backed denylist

**Goal.** Logout currently is browser-side only. Server can't revoke
a leaked token. Add a denylist keyed by JWT `jti` claim.

**Deliverables.**

* Migration version 7: new table
  ```sql
  CREATE TABLE jwt_denylist (
    jti TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    revoked_at TEXT DEFAULT CURRENT_TIMESTAMP,
    expires_at TEXT NOT NULL,
    reason TEXT
  );
  CREATE INDEX idx_jwt_denylist_expires ON jwt_denylist(expires_at);
  ```
* `generateToken()` in `middleware/auth.js` adds a random `jti`
  (UUID) to every token.
* `authenticateToken` checks `SELECT 1 FROM jwt_denylist WHERE jti = ?`
  before accepting a token.
* `/api/auth/logout` inserts the current `jti` into `jwt_denylist`
  with `expires_at = decoded.exp` and `reason = 'logout'`.
* Admin endpoint `POST /api/admin/users/:id/revoke-sessions` —
  inserts denylist rows for every active token tied to that user.
  Best-effort (we don't have a token registry, only revoke after-
  the-fact when we see the token). For now: revoke the user's
  CURRENT cookie (we know its jti) and set
  `users.revoke_before` = now; auth checks reject any token issued
  before that timestamp regardless of jti. Two-pronged.
* Cleanup job: every 24h, delete denylist rows where
  `expires_at < now()` (the token has naturally expired anyway,
  the row is no longer useful).

**Acceptance tests.**

- [ ] M.V1 — Login, copy the cookie via browser devtools. Logout. Try to use the copied cookie — auth rejects with 401.
- [ ] M.V2 — Two browsers logged in as same user. Admin clicks "Revoke all sessions for thomas". Both browsers next-request 401.
- [ ] M.V3 — Cleanup job runs after 24h, expired denylist rows pruned.
- [ ] M.V4 — Performance: 1000 expired tokens in the denylist, the SELECT WHERE jti = ? lookup uses the PRIMARY KEY index, < 1ms.

When M.V1-V4 pass, mark Phase M ✅.

---

## Phase N — TOTP_ENCRYPTION_KEY rotation tooling

**Goal.** Today: lose the key = every user re-enrolls. Need an
admin command that re-encrypts every `users.totp_secret` under a
new key while supporting both old + new key during the rotation
window.

**Deliverables.**

* Two env vars supported:
  * `TOTP_ENCRYPTION_KEY` — the active key (used for new writes)
  * `TOTP_ENCRYPTION_KEY_PREVIOUS` — the previous key (decrypt-only fallback)
* `decryptSecret()` in `lib/secrets.js`: if decrypt with current
  key fails, retry with previous key. Audit-log
  `TOTP_DECRYPT_FALLBACK` events for visibility.
* New CLI: `proxypilot rotate-totp-key` (a small Node script
  invoked as `node admin/backend/scripts/rotate-totp-key.js`):
  * Prompts (or reads from stdin) for the new key.
  * Validates: 64 hex chars.
  * For every `users.totp_secret`: decrypt with current key, encrypt
    with new key, UPDATE.
  * Writes both keys to `.env`: PREVIOUS = the old current,
    current = the new one.
  * Reports counts: `migrated N rows`. Fails loud on any decrypt
    error, leaves DB unchanged in that case.
* The dashboard's Settings page gets an admin-only "Rotate TOTP
  encryption key" action that triggers the same flow via the
  agent (so the flow runs on the host, not inside the container).
  Gated by Phase K's sudo-mode.
* After rotation, after a configurable delay (default 24h, env
  `TOTP_PREVIOUS_KEY_RETENTION_HOURS`), an automated cleanup
  removes `TOTP_ENCRYPTION_KEY_PREVIOUS` from `.env`. Operator
  can rerun rotation if they want a longer window.

**Acceptance tests.**

- [ ] N.V1 — Run rotation. Every user can still log in with their existing TOTP authenticator (no re-enrollment).
- [ ] N.V2 — Inspect DB: `users.totp_secret` values changed (new ciphertext) but decrypt to the same plaintext base32 as before.
- [ ] N.V3 — `.env` has both keys present.
- [ ] N.V4 — After 24h cleanup, only the current key remains in `.env`.
- [ ] N.V5 — Rotation flow gated by sudo-mode (Phase K).

When N.V1-V5 pass, mark Phase N ✅.

---

## Phase O — JWT_SECRET rotation with old-key fallback

**Goal.** Rotating `JWT_SECRET` today logs everyone out. Should
support a rotation window where old tokens validate against the
previous secret.

**Deliverables.**

* Two env vars: `JWT_SECRET` (signs new), `JWT_SECRET_PREVIOUS` (verify-only fallback).
* `authenticateToken`: try verify with current secret; on `jwt.verify` failure, retry with previous secret. Set a header `X-Token-Previous-Secret: 1` on the response so the frontend can refresh the cookie via `/api/auth/refresh`.
* `/api/auth/refresh` — accepts the old-secret-signed token, re-signs with the new secret, returns the new cookie.
* CLI + dashboard action `rotate-jwt-secret`:
  * Generates a new 64-char secret.
  * Moves current to PREVIOUS, sets new as current.
  * Increments a global counter that triggers `/api/auth/refresh` for every authenticated request via the X-header signal above.
* After 30 minutes (longer than the inactivity timeout in Phase L),
  remove `JWT_SECRET_PREVIOUS` automatically. Tokens still signed
  by the previous secret then become invalid (forcing re-login).

**Acceptance tests.**

- [ ] O.V1 — Run rotation. Currently-logged-in users keep working — their next request silently refreshes their cookie.
- [ ] O.V2 — A user idle past the rotation window (30+ min) gets bounced to login on next click.
- [ ] O.V3 — Rotation flow gated by sudo-mode.
- [ ] O.V4 — Audit log records `JWT_SECRET_ROTATED` event with the operator's user_id.

When O.V1-V4 pass, mark Phase O ✅.

---

## Phase P — Password breach check (HIBP k-anonymity)

**Goal.** 12-char minimum doesn't catch reused leaked passwords. On
password set/change, check against haveibeenpwned.com using their
k-anonymity API (only first 5 chars of SHA-1 hash sent over the
wire — privacy-preserving).

**Deliverables.**

* New helper `lib/passwordCheck.js`:
  * `isPasswordPwned(plaintext) → Promise<{ pwned: bool, count?: number }>`
  * Hashes with SHA-1, sends first 5 hex chars to
    `https://api.pwnedpasswords.com/range/<5chars>`, parses
    response, checks for the rest of the hash. Returns count
    of breaches if pwned.
* Endpoints `/api/auth/initial-setup`, `/api/user/change-password`,
  `/api/users` (admin-create-user) use the helper.
* Behavior on pwned password:
  * Default: warn, don't block (operator can override with
    `PASSWORD_PWNED_BEHAVIOR=block`).
  * In block mode: return 400 with clear message.
* Network failure handling: HIBP API unreachable → log a warning,
  let the password through (don't take down auth because of an
  external dependency).
* Frontend: surface the warning (or block) clearly.

**Acceptance tests.**

- [ ] P.V1 — Set password to `password123` (commonly pwned) — warning appears.
- [ ] P.V2 — Set `PASSWORD_PWNED_BEHAVIOR=block`, retry — blocked.
- [ ] P.V3 — Set a strong password (e.g., `correct horse battery staple something something`) — accepted, no warning.
- [ ] P.V4 — Block HIBP API at the firewall, set a password — accepted with warning logged.

When P.V1-V4 pass, mark Phase P ✅.

---

## Phase Q — Audit log integrity (hash chain)

**Goal.** An attacker with DB write access can edit `audit_log`
freely today. Add a hash chain so tampering is detectable.

**Deliverables.**

* Migration version 8: `audit_log` gains
  ```sql
  ALTER TABLE audit_log ADD COLUMN prev_hash TEXT;
  ALTER TABLE audit_log ADD COLUMN row_hash TEXT;
  ```
* `logAudit()` updated to:
  * `prev_hash` = the most recent row's `row_hash` (or empty string for the first row)
  * `row_hash` = `SHA-256(prev_hash || id || ts || user_id || action || resource_type || resource_id || JSON(details))`
* New endpoint `GET /api/admin/audit/verify`:
  * Walks the chain from oldest to newest.
  * Recomputes each `row_hash` and compares.
  * Returns `{ valid: bool, broken_at_id?: string }`.
* Dashboard "Audit Log" page gets a "Verify Integrity" button (admin-only).
* Migration step for existing audit_log rows: backfill `prev_hash`
  + `row_hash` linearly. Anchor commit recorded as the "trust
  anchor" — anything before this point is grandfathered.

**Acceptance tests.**

- [ ] Q.V1 — Fresh install: every new audit_log row has prev_hash + row_hash populated.
- [ ] Q.V2 — `GET /api/admin/audit/verify` returns `{valid: true}`.
- [ ] Q.V3 — Manually edit one `audit_log.details` field via sqlite3 CLI. Verify endpoint returns `{valid: false, broken_at_id: <the row>}`.
- [ ] Q.V4 — Existing install with audit history: migration backfills hashes, verify passes from the migration anchor onward.

When Q.V1-V4 pass, mark Phase Q ✅.

---

## Phase R — Real e2e deploy CI

**Goal.** A disposable Debian VM that gets `install.sh` run + a
puppeteer flow that creates a service / opens a terminal / verifies
Caddy reload. Pre-merge gate. Would have caught all five regressions
on this branch on the first push.

**Deliverables.**

* `.github/workflows/e2e-deploy.yml` — GitHub Actions workflow:
  * Spins up a Debian 13 ephemeral VM (via Vagrant + libvirt OR
    via a self-hosted runner with KVM access — the latter is
    faster and avoids public CI rate limits on container-based runners).
  * Clones the PR branch.
  * Runs `install.sh` non-interactively (env vars provide DOMAIN,
    ADMIN_USERNAME, etc.).
  * Runs a puppeteer flow:
    * Navigate to https://<test-domain>/
    * Complete first-time setup (password + TOTP via OTPAuth lib)
    * Add Service → Static Site → confirm route appears
    * Open Incus page → confirm renders
    * Settings → check version (should match package.json)
  * Runs `update.sh` (with the latest changes already pulled)
    against the same VM.
  * Verifies post-update health.
* The puppeteer flow uses the same auth-bypass pattern documented
  in `docs/core/plan/NEXT-SESSION-PROMPT.md` lessons section.
* Required CI status check on `main` so PRs can't merge red.
* Documentation in
  `docs/features/security-completion/CI.md` for setting up the
  self-hosted runner if the operator wants to host it.

**Acceptance tests.**

- [ ] R.V1 — Open a PR with a deliberately-broken change (e.g., introduce a typo in a Caddyfile generator). CI fails.
- [ ] R.V2 — Open a PR with a clean change. CI passes within 15 minutes.
- [ ] R.V3 — `update.sh` step in CI verifies the upgrade-from-current-main path works.
- [ ] R.V4 — Branch protection on main enforces the CI status check.

When R.V1-V4 pass, mark Phase R ✅.

**After R: every security gap I called out as production-blocking is
closed. The honest production-readiness statement loses every caveat.**
