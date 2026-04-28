# Kickoff prompt — Host-side agent (real B1 fix)

**Pre-read:** `docs/features/security-completion/README.md` and
`docs/features/security-completion/restore-dashboard-prompt.md`. The
restore-dashboard work must be merged and the dashboard must be
verified working BEFORE this prompt is run. Otherwise the operator's
production is broken and you'd be designing while it's down.

This is the real B1 fix. Today's container is privileged-equivalent
(`privileged: true` + `pid: host` + Docker socket mount = host root
on container compromise). The cap-drop attempts in this branch all
failed. The architectural fix is a host-side agent: a small,
narrow-protocol RPC service running on the host that ProxyPilot
inside the container talks to over a Unix socket. The container
becomes unprivileged; compromise is bounded by what the agent's
protocol allows.

This is a **multi-session, multi-week** body of work. The kickoff
prompt below is structured so each step is its own session: the
operator pastes the same prompt into a fresh session at each step,
the session reads where it left off in the spec doc, picks up the
next unticked checklist item.

---

## Phase plan

This work splits into seven phases, each with its own commit train
and operator gate. Sessions run one phase at a time.

| Phase | Goal | Estimate |
|---|---|---|
| **A — Design + scaffolding** | Phase doc + agent skeleton + Unix socket transport | 2-3 days |
| **B — Caddy methods** | Migrate every `caddy adapt` / `caddy reload` to the agent | 2-3 days |
| **C — Incus methods** | Migrate every `incus exec` / `incus snapshot` / etc. | 3-4 days |
| **D — Docker methods** | Migrate every `docker compose` / `docker exec` / etc. | 3-4 days |
| **E — Misc methods** | git pull, npm install, npm run build, systemd reload | 2-3 days |
| **F — Drop privileged** | Switch container to unprivileged, drop pid:host + Docker socket | 2 days |
| **G — Hardening + audit** | Per-method audit log on the agent side, rate limiting, deny-list of dangerous arg patterns, install/update.sh updates | 3-4 days |

Total: roughly 2.5-3 focused weeks. Real-world calendar will likely
double that with operator-test cycles between phases.

## Operator gates between phases

After each phase, the session pauses. The operator must:

1. Pull the branch.
2. Run update.sh on a real disposable Debian VM (not production).
3. Verify the listed acceptance tests for that phase.
4. Approve the next phase before the session resumes.

This is non-negotiable. Five regressions on the prior branch
happened because there was no operator-in-the-loop testing on a
real VM. The agent rewrite touches every privileged operation in
ProxyPilot — skipping the gate would be catastrophic.

---

## The kickoff prompt

Copy everything in the fenced block below into a fresh Claude Code
session. The session will do Phase A only. When Phase A is verified,
re-paste the same prompt into a new session — it will read the
phase doc, see Phase A is ✅, start Phase B. Repeat per phase.

```
You are picking up Phase A of the ProxyPilot host-side agent work
described in docs/features/security-completion/host-side-agent-prompt.md.
The restore-dashboard work must already be merged and the dashboard
must be working. If it isn't, STOP and ask the operator to run the
restore-dashboard kickoff first.

The agent rewrite is a multi-session, multi-week effort. Stay scoped
to ONE phase per session. Operator approval is required between
phases.

## Branch

Cut a fresh branch from the latest main:

    git fetch origin main
    git checkout main
    git pull origin main
    git checkout -b claude/host-agent-phase-<letter>-<your-suffix>

## Hard segmentation rules

Same as every other prompt in this repo:

1. Reads ≤ 200 lines, with offset+limit.
2. Edits are targeted.
3. Long-running commands run in the background.
4. TodoWrite checkpoints between segments.
5. One concern per commit. Push after every commit.
6. If a segment hangs, cancel and split.
7. One concern per commit.

## Step 0 — Read where the work stands

1. Read docs/features/security-completion/host-side-agent-spec.md
   in full. (If it doesn't exist yet, you are the first session
   and your job is to create it — see Phase A below.)
2. Find the first phase whose status is not ✅. That's your phase.
3. If Phase A's status is ✅ but Phase B is ⏳ or absent, you are
   running Phase B. And so on.

## Phase A — Design + scaffolding (first session)

If host-side-agent-spec.md does not exist:

1. Create docs/features/security-completion/host-side-agent-spec.md
   with the structure outlined below.
2. Survey the existing code for every nsenter / execOnHost call.
   Inventory them in the spec.
3. Choose a language (Go preferred — single static binary, easy to
   distribute, well-suited for Unix-socket servers). Document the
   choice with a one-paragraph rationale in the spec.
4. Define the wire protocol:
   * JSON-over-newline-delimited Unix socket (one request per line,
     one response per line).
   * Each request: { id, method, params }.
   * Each response: { id, result | error }.
   * Methods named like "caddy.adapt", "caddy.reload",
     "incus.exec", "incus.snapshot.create", "docker.exec",
     "docker.compose.up", "git.pull", "npm.install", "npm.run".
5. Build the agent skeleton in cmd/agent/ at the repo root:
   * main.go: parses --socket flag (default /run/proxypilot-agent.sock),
     listens, accepts connections, dispatches to handlers, writes
     responses.
   * Method handlers all return UnimplementedError for now — except
     one (e.g., agent.ping) that returns "pong" so the operator can
     verify the socket works.
   * Build target: a single static binary in dist/ via
     `go build -ldflags="-s -w" -o dist/proxypilot-agent ./cmd/agent`.
6. Add a systemd unit at deploy/proxypilot-agent.service:
   * User=proxypilot-agent (created by install.sh, see below).
   * ExecStart with --socket=/run/proxypilot-agent.sock.
   * Restart=on-failure.
   * Hardening: NoNewPrivileges=true, ProtectSystem=strict,
     ProtectHome=true, PrivateTmp=true, RestrictAddressFamilies=AF_UNIX.
7. Update install.sh:
   * Create proxypilot-agent system user.
   * `go build` the agent (require Go on the host, install if missing).
   * Install systemd unit, enable + start.
   * Create /run/proxypilot-agent.sock with mode 0660 owned by
     proxypilot-agent:proxypilot-agent (the proxypilot Docker
     container will be added to the proxypilot-agent group).
8. Update docker-compose.yml in install.sh:
   * Add a bind mount: /run/proxypilot-agent.sock:/run/proxypilot-agent.sock
   * NOTE: do NOT remove privileged:true yet — that happens in Phase F.
     The agent is dual-tracked with nsenter for now.
9. Add a thin client in admin/backend/src/lib/agent.js:
   * `agentCall(method, params, opts) → Promise<result>`
   * Connects to /run/proxypilot-agent.sock, sends one JSON line,
     reads one JSON line, returns result or throws on error.
   * Connection per-call (simple). Pooling can come later if measured.
10. Add an integration test:
    * Spin up the agent binary in the background.
    * Call agentCall('agent.ping') from Node.
    * Assert the response is "pong".
    * Tear down.

Phase A acceptance tests (operator runs against a disposable VM):
* `systemctl status proxypilot-agent` shows running.
* `echo '{"id":1,"method":"agent.ping","params":{}}' | nc -U /run/proxypilot-agent.sock` returns `{"id":1,"result":"pong"}`.
* The proxypilot Docker container can read the socket (via the bind mount).
* `agentCall('agent.ping')` from Node inside the container returns "pong".
* The dashboard still works (no regression — agent is dual-tracked,
  not yet replacing nsenter).
* update.sh end-to-end on an existing install picks up the new
  agent binary, systemd unit, socket mount, AND keeps the existing
  docker-compose privileged: true (so nsenter still works for
  the production code paths).

When all acceptance tests pass, mark Phase A as ✅ in
host-side-agent-spec.md with the date and commit hash. Commit:

    docs(host-agent): mark Phase A complete (verified <date>)

Push. Stop. Operator merges. Next session reads the spec, sees
Phase A ✅, starts Phase B.

## Phase B — Caddy methods

(Same kickoff prompt, second invocation.)

The session will see Phase A ✅, Phase B ⏳, and read the spec for
Phase B's checklist:

1. Implement caddy.adapt(config_text) on the agent — runs
   `caddy adapt --config <stdin>` on the host, returns
   { ok, error?, adapted_json? }.
2. Implement caddy.reload() on the agent — runs `caddy reload
   --config /etc/caddy/Caddyfile`.
3. Add a feature flag PROXYPILOT_USE_AGENT_FOR_CADDY (default off
   for now). When on, the backend's existing Caddy reload path
   calls agentCall('caddy.reload') instead of execOnHost.
4. Migrate every existing Caddy nsenter call site in
   admin/backend/src/routes/services.js to the gated path.
5. Acceptance tests: with the flag ON, every Caddy operation that
   used to work via nsenter now works via the agent. With the flag
   OFF, behavior is unchanged.

Acceptance tests:
* Toggle the flag on, create a new service, confirm Caddy reload
  succeeds.
* Toggle the flag off, repeat — should still work via nsenter
  (dual-tracked).
* Audit log shows the agent path was used when the flag was on.

When all acceptance tests pass: ✅ Phase B, commit, push, stop,
operator merges.

## Phase C — Incus methods

* incus.version()
* incus.exec(name, command, timeout, env)
* incus.list()
* incus.snapshot.create(name, snapshot_name, optional_note)
* incus.snapshot.restore(name, snapshot_name)
* incus.snapshot.delete(name, snapshot_name)
* incus.network.list()
* incus.profile.list()
* incus.image.list()
* (any other incus call you find via grep)

Strict input validation: name must match `^[a-z][a-z0-9-]{0,62}$`,
command bounded length, env values bounded, timeout capped at
600s. The agent rejects anything outside the allowlist with a
specific error code.

Same dual-track + flag pattern as Phase B
(PROXYPILOT_USE_AGENT_FOR_INCUS).

Acceptance: every Incus-driven dashboard feature works with the
flag on. The Incus page shows networks, storage pools, profiles,
and images. Container creation, exec, snapshot, restore all work.

## Phase D — Docker methods

* docker.compose.up(install_dir)
* docker.compose.down(install_dir)
* docker.compose.build(install_dir, options)
* docker.exec(container, command, timeout)
* docker.ps()
* docker.logs(container, lines)

Important: with the agent in place, the Docker socket bind-mount
into the proxypilot container is no longer needed. Document this
but DON'T remove the mount yet (Phase F drops it along with
privileged:true).

Same flag pattern (PROXYPILOT_USE_AGENT_FOR_DOCKER).

## Phase E — Misc methods

* git.pull(install_dir, branch)
* npm.install(directory)
* npm.run(directory, script_name)
* systemd.reload(service_name)

These are used by the dashboard's update / version-management UI.

Same flag pattern.

## Phase F — Drop privileged

Once Phases B-E are complete and the operator has run for at least
a week with all flags ON in production:

1. Flip every PROXYPILOT_USE_AGENT_* flag default to ON.
2. install.sh docker-compose.yml: remove privileged:true,
   pid:host, Docker socket mount. Add unprivileged container with
   only the agent socket mount + the existing /etc/caddy/* mounts.
3. Update update.sh to migrate live installs:
   * Detect the post-Phase-A docker-compose.yml.
   * Replace privileged:true with the unprivileged config.
   * Verify health post-restart (the agent is the only path now).
4. The nsenter-based execOnHost helpers in lxc.js / services.js /
   user.js should be DELETED in this commit. Keep them as long
   as the dual-track was active; remove now that there's no
   fallback.

Acceptance:
* docker inspect proxypilot-admin shows no privileged caps.
* Every dashboard feature works.
* `nsenter -t 1` from inside the container fails (correctly — we
  no longer have pid:host or the caps for it).

This is the moment B1 is actually done.

## Phase G — Hardening + audit

* Per-method audit log entries on the AGENT side (parallel to
  ProxyPilot's audit_log). Records: timestamp, method, caller PID
  + UID, params hash, result code, duration_ms.
* Per-method rate limiting (e.g., caddy.reload max 10/min,
  incus.exec max 60/min, docker.compose.up max 1/min).
* Deny-list of dangerous arg patterns (e.g., `--privileged` or
  `--cap-add` in docker.exec args, `rm -rf /` in npm.run, etc.).
* Health endpoint on the agent (HTTP-over-Unix-socket
  /agent/health) for monitoring.
* update.sh / install.sh fully wired to the new model — no leftover
  nsenter assumptions.
* Documentation: docs/features/security-completion/USAGE.md
  (operator-facing), TROUBLESHOOTING.md (debug guide), and
  ARCHITECTURE.md (the agent design rationale, kept up to date).

When Phase G is verified, the security work for production go-live
is complete in the privileged-container sense. Other items (JWT
revocation, sudo-mode, account lockout, backup automation, external
monitoring) are tracked separately in the README's "What's left
besides B1" section.

## Rules across all phases

* Never touch the production deployment from this session — operator
  runs update.sh themselves.
* Operator gate is mandatory between phases. Don't auto-advance.
* Every phase commits its own ✅ marker in host-side-agent-spec.md.
* Feature flags default OFF until Phase F. The dual-track is the
  rollback path — keep both working.
* If acceptance tests fail at any phase, STOP and report. Don't
  patch over failures to keep moving.
* The disposable VM the operator uses for testing is NOT the
  production VM. Production only sees stable, post-acceptance code.

Begin with Step 0: read the spec doc (or create it if Phase A).
```

---

## How to use this

1. Operator FIRST runs the restore-dashboard prompt to get the dashboard back online. Confirms it works.
2. Operator pastes THIS prompt into a fresh session. Session does Phase A.
3. After Phase A: operator merges, runs update on a disposable VM, runs the Phase A acceptance tests. If green, paste the same prompt into a new session — it picks up Phase B.
4. Repeat through Phase G.
5. After Phase G is verified in production: B1 is closed. Update the production-readiness assessment to drop the privileged-container caveat.

Total elapsed time depends entirely on the operator's test cadence between phases. Realistic minimum: 4-6 weeks. Realistic comfortable: 8-12 weeks.

## Why this is structured as one prompt re-pasted across sessions

The alternative — seven separate prompts — would diverge over time as the spec evolves. Keeping it as one prompt that consults `host-side-agent-spec.md` for current state means the spec is the single source of truth and the prompt stays small and stable.
