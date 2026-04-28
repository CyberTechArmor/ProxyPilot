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
