<!-- Feature: Interactive streaming terminal — MVP -->
<!-- Sibling files: terminal-mvp-prompt.md, terminal-production.md, terminal-production-prompt.md -->

## Feature: Interactive Streaming Terminal — MVP

**Goal.** Replace the request-response `ContainerTerminal` placeholder (currently mounted at the "Terminal Beta" tab in `LxcContainers.jsx:1979-2019`) with a real PTY-backed WebSocket terminal that supports interactive programs (`vim`, `htop`, `tmux`, `nano`), tab completion that flows through the shell itself, ANSI escape sequences for color and cursor control, and viewport-driven resize.

**Scope.** This MVP covers two transports: LXC containers (via `incus exec -t`) and the host shell (admin-only). Docker container support, asciinema session recording, reconnect grace, and mobile polish are explicitly out of scope — they belong to the production-hardening pass.

**Files to edit:**

```
admin/backend/package.json                       # Add ws + node-pty
admin/backend/src/index.js                       # Attach WebSocket server to HTTP server
admin/backend/src/middleware/wsAuth.js  (NEW)    # Cookie -> JWT validation on upgrade
admin/backend/src/lib/pty.js  (NEW)              # Spawn helper for incus exec -t / bash
admin/backend/src/routes/terminal-ws.js  (NEW)   # WebSocket handler: pipe stdin/stdout, resize, audit
admin/backend/src/db.js                          # Two new audit event consts (TERMINAL_SESSION_*)
admin/frontend/package.json                      # Add xterm, xterm-addon-fit, xterm-addon-web-links
admin/frontend/src/components/InteractiveTerminal.jsx  (NEW)  # xterm.js + WebSocket component
admin/frontend/src/pages/LxcContainers.jsx       # Replace the Beta-tab placeholder with the new component
admin/frontend/src/pages/Settings.jsx OR similar # Add host-shell terminal entry (admin-only)
admin/Dockerfile                                  # No code change expected — backend-builder already has python3/make/g++ for native modules
update.sh                                         # No code change — npm install picks up new deps
install.sh                                        # No code change — Caddy already reverse-proxies WebSockets
```

**Deliverables:**

- **`admin/backend/src/lib/pty.js`** exports `spawnTerminalPty({ kind, target })` returning a `node-pty` IPty handle. Two `kind` values:
  - `'lxc'`: spawns `nsenter -t 1 -m -u -n -i incus exec -t <prefixed-name> -- bash` so the PTY survives the container→host namespace traversal. The `SYS_ADMIN` capability already granted in B1 is what makes the nsenter step legal.
  - `'host'`: spawns `nsenter -t 1 -m -u -n -i bash -l` for the host-shell case (admin-only). When `DOCKER_CONTAINER` is unset (non-Docker deployment) the wrapper falls through to a plain `bash -l`.
  Defaults: `cols=80`, `rows=24`, `name='xterm-256color'`, `env: { ...process.env, TERM: 'xterm-256color' }`.

- **`admin/backend/src/middleware/wsAuth.js`** exports `verifyWsUpgrade(req)` returning `{ user }` on success or throwing on failure. Reads `pp_token` from the `Cookie` header, calls `jwt.verify` with the same `JWT_SECRET` used by `authenticateToken`. No CSRF check required for WebSocket upgrade — the browser only sends cookies on same-origin upgrade by default and `SameSite=Strict` on `pp_token` enforces that.

- **`admin/backend/src/routes/terminal-ws.js`** exports `attachTerminalServer(httpServer)`:
  - Creates a `WebSocketServer({ noServer: true })`.
  - Registers an `httpServer.on('upgrade', ...)` handler that matches paths under `/api/terminal/`, validates the cookie, enforces `MAX_SESSIONS_PER_USER` (default `3`, configurable via `TERMINAL_MAX_SESSIONS`), and hands off to `wss.handleUpgrade`.
  - Per-session lifecycle:
    - On open: parse target from URL (`/api/terminal/lxc/<name>` or `/api/terminal/host`), call `spawnTerminalPty`, write `TERMINAL_SESSION_START` audit row.
    - On message: JSON envelope `{type:'input', data}` writes to PTY; `{type:'resize', cols, rows}` calls `pty.resize`. Plain string/binary frames also accepted as input for compatibility.
    - On PTY data: forward as binary frame to client.
    - On idle (no input AND no output for `TERMINAL_IDLE_TIMEOUT_MS`, default `15 * 60_000`): send `{type:'closed', reason:'idle'}`, kill PTY, close WS.
    - On output backpressure (`ws.bufferedAmount > 1_000_000`): pause PTY (`pty.pause()`); resume when drained. Without this, `yes | head -c 1G` self-DoSes the browser.
    - On close: clear timers, kill PTY, write `TERMINAL_SESSION_END` audit row with duration + byte counts.
  - The `requireAdmin` check applies only to the host-shell path. LXC paths reuse the standard `authenticateToken` semantics; per-container ACL hardening is deferred to the production phase.

- **`admin/backend/src/index.js`** changes:
  - `import http from 'http'` and `const server = http.createServer(app)`.
  - Replace `app.listen(PORT, ...)` with `server.listen(PORT, ...)`.
  - After `initDatabase()` and route registration, `attachTerminalServer(server)`.
  - Order matters: WebSocket upgrade handler must be installed before `server.listen()`.

- **`admin/frontend/src/components/InteractiveTerminal.jsx`** is a self-contained component that takes a `wsPath` prop (e.g. `/api/terminal/lxc/my-container`):
  - Mounts an `xterm.Terminal` with `cursorBlink: true`, `fontSize: 14`, dark theme, `xterm-addon-fit` for viewport sizing.
  - Opens a WebSocket to `${location.origin.replace(/^http/,'ws')}${wsPath}`, `binaryType = 'arraybuffer'`.
  - Wires `term.onData → ws.send` (JSON `{type:'input', data}`) and `ws.onmessage → term.write` (binary or string).
  - Uses `ResizeObserver` on the container div to call `fit.fit()` and emit `{type:'resize', cols, rows}`.
  - On unmount: `ws.close()`, `term.dispose()`, disconnect observer.
  - Status banner above the xterm shows connecting / connected / closed / error states.

- **`admin/frontend/src/pages/LxcContainers.jsx`** swap: the placeholder block at `1980-2019` replaced by `<InteractiveTerminal wsPath={'/api/terminal/lxc/' + selectedContainer.name} />`. The legacy `ContainerTerminal` (request-response) stays in place under the original "Terminal" tab during the MVP — they coexist; the legacy version is removed in the production phase.

- **Host-shell terminal entry** added to wherever the operator currently lands for admin-only host operations (likely a new tab on the Settings page or a new `/admin/shell` route). Gated by `requireAdmin` on the backend; UI surfaces to admin role only.

- **Two new audit event types** in `db.js` audit log: `TERMINAL_SESSION_START` (target_kind, target_id, source_ip), `TERMINAL_SESSION_END` (duration_ms, bytes_in, bytes_out, exit_reason). Existing `logAudit()` is reused — no schema change.

**Configuration (env vars, default in code, surfaced through `.env.example`):**

```
TERMINAL_MAX_SESSIONS=3              # Concurrent sessions per user
TERMINAL_IDLE_TIMEOUT_MS=900000      # 15 min idle kill
TERMINAL_OUTPUT_BACKPRESSURE_BYTES=1000000   # WS buffer high-water mark before PTY pause
```

`update.sh`'s `sync_env_keys` will append these to existing `.env` files automatically when the new `.env.example` is pulled.

**Verification checklist** — every item must pass on a real deploy before MVP is declared done:

- [ ] **V.1** `npm install` in `admin/backend` succeeds; `node-pty` native build completes in the Alpine container build (`backend-builder` stage already has python3 / make / g++ — confirm).
- [ ] **V.2** `npm install` in `admin/frontend` succeeds; `npm run build` produces `dist/` with no CSP-violation imports.
- [ ] **V.3** Login → navigate to a container's "Terminal Beta" tab → terminal connects within 2s, prompt visible.
- [ ] **V.4** Run `vim /tmp/x`, type, save, quit. PTY mode confirmed (vim relies on raw mode + alternate screen).
- [ ] **V.5** Run `htop` for 10s. Cursor positioning + screen updates render correctly. Quit with `q`.
- [ ] **V.6** Run `tmux new -s a`, type `echo ok`, detach with `Ctrl-b d`, reattach with `tmux a -t a`. Alternate-screen + signal handling confirmed.
- [ ] **V.7** Resize the browser window. `tput cols && tput lines` inside the terminal reflects the new dimensions.
- [ ] **V.8** Backpressure: run `yes` for 5s. Browser remains responsive (PTY paused via the `bufferedAmount` guard). Send Ctrl-C; terminal recovers.
- [ ] **V.9** Idle timeout: leave the terminal idle for 16 minutes (or temporarily lower `TERMINAL_IDLE_TIMEOUT_MS=10000` for the test). Backend closes the session with `{reason:'idle'}`. Frontend status banner reflects it.
- [ ] **V.10** Concurrent session cap: open 4 terminals from the same user. The 4th refuses to upgrade with a clear error message.
- [ ] **V.11** Audit log shows `TERMINAL_SESSION_START` and `TERMINAL_SESSION_END` rows for every session, with non-zero duration + byte counts on END.
- [ ] **V.12** Disconnect (close tab) → confirm via `ps -ef | grep nsenter` on the host that the PTY child process is reaped within 2s. No zombie sessions.
- [ ] **V.13** Host-shell terminal at `/api/terminal/host`: visible only to admin role; non-admin users get 401 on upgrade.
- [ ] **V.14** Mobile sanity check at 360×640: terminal renders, virtual keyboard appears on focus, output legible. Mobile polish is deferred to production phase but it must not be broken.
- [ ] **V.15** **`update.sh` end-to-end on an existing install** — pulls the branch, npm-installs both deps trees, builds frontend, restarts container, health check passes within 60s, terminal feature works post-update. The DB-backup + restore-on-failure flow remains intact.
- [ ] **V.16** **Fresh `install.sh` on a clean Debian VM** — installs all deps, generates `.env` (with the new TERMINAL_* keys present in `.env.example`), brings up Caddy, brings up ProxyPilot, terminal feature works on first login.
- [ ] **V.17** Caddy reverse-proxies WebSocket cleanly: confirm via `caddy adapt --config /etc/caddy/Caddyfile` that the existing config still validates; the WebSocket upgrade flows through the standard `reverse_proxy 127.0.0.1:${PORT}` directive without explicit `transport` overrides.
- [ ] **V.18** CSP not violated: open browser DevTools console, confirm no CSP errors during terminal use. xterm.js relies on `style-src 'unsafe-inline'` (already allowed) and same-origin `connect-src` for the WebSocket (already allowed).
- [ ] **V.19** `bash -n install.sh && bash -n update.sh` clean. `node --check` clean on every touched JS file.

**Out-of-scope for MVP (deferred to production phase):**

- Docker container support (dockerode + hijacked HTTP exec stream).
- Asciinema session recording + replay UI.
- Reconnect grace (server holds PTY 30s after WS close).
- Mobile virtual-keyboard helper buttons (Tab / Esc / Ctrl / Alt).
- Per-service `canWriteService()` ACL check on container terminals.
- Operator-configurable settings UI for the terminal limits.
- Removing the legacy request-response `ContainerTerminal` component.

## Function-by-Function Checklist (to be ticked by the executing session)

- [x] **B.1** Add `ws` and `node-pty` to `admin/backend/package.json`. Run `npm install` in the backend dir. Verify `node-pty` builds (`require('node-pty')` in a smoke script does not throw).
- [x] **B.2** Add `xterm`, `xterm-addon-fit`, `xterm-addon-web-links` to `admin/frontend/package.json`. Run `npm install` in the frontend dir.
- [x] **B.3** Create `admin/backend/src/middleware/wsAuth.js` with `verifyWsUpgrade(req)`. Unit-test by calling it with a forged `Cookie: pp_token=<valid jwt>` header and confirming `{ user }` is returned; with a missing or invalid cookie, confirm it throws.
- [x] **B.4** Create `admin/backend/src/lib/pty.js` with `spawnTerminalPty({ kind, target })`. Smoke-test in a one-shot Node script: spawn a `kind:'host'` PTY, write `echo hello\n`, read the response, verify `hello` is in the output.
- [x] **B.5** Create `admin/backend/src/routes/terminal-ws.js` with `attachTerminalServer(httpServer)`. Compose the WebSocket server, the upgrade handler, the per-session lifecycle. Add `TERMINAL_SESSION_START` / `TERMINAL_SESSION_END` to the audit event taxonomy.
- [x] **B.6** Modify `admin/backend/src/index.js` to use `http.createServer(app)`, attach the terminal server, and listen via `server.listen` instead of `app.listen`. Backend smoke-test: `curl http://127.0.0.1:3001/api/health` still returns 200.
- [ ] **B.7** Add `TERMINAL_MAX_SESSIONS`, `TERMINAL_IDLE_TIMEOUT_MS`, `TERMINAL_OUTPUT_BACKPRESSURE_BYTES` to `.env.example`. Confirm `update.sh`'s `sync_env_keys` would append them on existing installs.
- [ ] **F.1** Create `admin/frontend/src/components/InteractiveTerminal.jsx`. Verify in isolation (vite dev) that the component mounts without console errors before wiring it in.
- [ ] **F.2** Replace the placeholder block in `admin/frontend/src/pages/LxcContainers.jsx` (`TabsContent value="terminal-beta"`) with `<InteractiveTerminal wsPath={...}/>`. Build and verify in browser.
- [ ] **F.3** Add a host-shell terminal entry — admin-only navigation surface. Choose: a new tab on Settings, or a new `/admin/shell` route in the router. Document the choice in the commit message.
- [ ] **V.1**–**V.19** Verification checklist above. Each item ticked individually with a one-line evidence note (matching the Phase 2b checklist style). Items V.15 and V.16 are mandatory before declaring MVP complete.

**One-commit-per-item discipline.** Mirror the Phase 2b convention: one checklist item = one commit, push after every commit. Use `feat(terminal):` prefix for B.x and F.x items, `verify(terminal):` for V.x items that introduce no code but tick a verification box with a note.

## Commit messages

```
feat(terminal): B.1 add ws + node-pty backend dependencies
feat(terminal): B.2 add xterm + addons frontend dependencies
feat(terminal): B.3 WebSocket upgrade auth middleware
feat(terminal): B.4 spawnTerminalPty helper for lxc + host shells
feat(terminal): B.5 attachTerminalServer + per-session lifecycle
feat(terminal): B.6 wire WebSocket server into index.js
feat(terminal): B.7 expose terminal limits via .env.example
feat(terminal): F.1 InteractiveTerminal xterm.js component
feat(terminal): F.2 replace ContainerTerminal beta placeholder with live PTY
feat(terminal): F.3 host-shell admin-only terminal entry
verify(terminal): V.x <one-line evidence>
docs(terminal): mark MVP complete in terminal-mvp.md
```

When V.1–V.19 are all ticked: append `## MVP — Verified` section at the bottom of this file with the date and the commit hash that flipped the last verification box.
