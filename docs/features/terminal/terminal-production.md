<!-- Feature: Interactive streaming terminal — Production hardening -->
<!-- Sibling files: terminal-mvp.md, terminal-mvp-prompt.md, terminal-production-prompt.md -->
<!-- Prerequisite: terminal-mvp.md must show "## MVP — Verified" before this phase begins. -->

## Feature: Interactive Streaming Terminal — Production Hardening

**Goal.** Take the MVP described in `terminal-mvp.md` from "works for the operator on a Tuesday afternoon" to "shippable as a real production capability." The MVP is a deliberately narrow vertical slice (LXC + host shell, no recording, no Docker, no reconnect, no mobile polish, no ACL). This document defines the broader scope that turns it into a feature ProxyPilot can claim as production-grade.

**Scope adjustments based on operator post-MVP use** are captured in the `## Post-MVP Use Notes` section at the bottom of this file. **Read that section first** — operator feedback overrides the default plan below if there's a conflict.

**Files to edit:**

```
admin/backend/package.json                       # Add dockerode
admin/backend/src/lib/pty.js                     # Add 'docker' kind via dockerode exec
admin/backend/src/lib/asciinema.js  (NEW)        # v2 cast-file writer
admin/backend/src/routes/terminal-ws.js          # Recording wiring, reconnect grace, per-service ACL
admin/backend/src/routes/terminal-recordings.js  (NEW)  # GET /api/terminal/recordings, GET /:id, DELETE /:id
admin/backend/src/db.js                          # New schema_migrations version: terminal_sessions table
admin/backend/src/middleware/auth.js             # canExecOnService() helper
admin/frontend/package.json                      # Add asciinema-player
admin/frontend/src/components/InteractiveTerminal.jsx  # Reconnect grace, mobile keyboard buttons, status banner polish
admin/frontend/src/components/TerminalReplay.jsx  (NEW)  # Asciinema replay UI
admin/frontend/src/pages/TerminalRecordings.jsx  (NEW)   # Listing + replay page (admin-only)
admin/frontend/src/pages/Settings.jsx OR similar  # Operator-facing terminal settings (limits, recording on/off, retention)
admin/frontend/src/pages/LxcContainers.jsx       # Remove the legacy `ContainerTerminal` (request-response) tab + helper
admin/frontend/src/pages/LxcContainers.jsx       # Remove the legacy `/api/lxc/containers/:name/exec` JSON path UI; backend endpoint may remain for backwards compat or be removed in a separate commit
.env.example                                     # New TERMINAL_RECORDING_*, TERMINAL_RECONNECT_GRACE_MS keys
docs/features/terminal/terminal-production.md    # Tick-marks + sign-off
```

**Deliverables (default plan; defer to "Post-MVP Use Notes" if it overrides):**

### D.1 — Docker container support

- Extend `spawnTerminalPty({ kind, target })` to accept `kind: 'docker'`. Implementation uses the `dockerode` npm package against `/var/run/docker.sock`:
  ```js
  const exec = await container.exec({
    Cmd: ['/bin/sh'],
    AttachStdin: true, AttachStdout: true, AttachStderr: true,
    Tty: true, Env: ['TERM=xterm-256color'],
  });
  const stream = await exec.start({ hijack: true, stdin: true });
  ```
- The hijacked stream is a duplex; pipe it to/from the WebSocket like the LXC node-pty handle. Resize via `exec.resize({ h: rows, w: cols })`.
- Frontend route: `/api/terminal/docker/<container-id-or-name>`.
- Authorization: same `canExecOnService` check as LXC.

### D.2 — Asciinema session recording (opt-in)

- New table `terminal_sessions` (migration version 7):
  ```
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  target_kind TEXT NOT NULL CHECK(target_kind IN ('lxc','docker','host')),
  target_id TEXT NOT NULL,
  started_at TEXT DEFAULT CURRENT_TIMESTAMP,
  ended_at TEXT,
  duration_ms INTEGER,
  bytes_in INTEGER DEFAULT 0,
  bytes_out INTEGER DEFAULT 0,
  exit_reason TEXT,
  recording_path TEXT,
  source_ip TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ```
- New env vars:
  - `TERMINAL_RECORDING_ENABLED=false` (default off — opt-in)
  - `TERMINAL_RECORDING_DIR=/data/terminal-recordings`
  - `TERMINAL_RECORDING_RETENTION_DAYS=30`
- When enabled, every PTY session writes an asciinema v2 cast file:
  - First line: `{"version":2,"width":<cols>,"height":<rows>,"timestamp":<unix_ts>,"env":{"TERM":"xterm-256color"}}`
  - Subsequent lines: `[<seconds_since_start>, "o", "<utf8 chunk>"]` for output, `[<seconds_since_start>, "i", "<chunk>"]` for input.
- File written incrementally (not buffered) so a crash mid-session still leaves a partial replay-able file. Permissions 0600. `chmod`'d at create time, `recording_path` written to the DB row on session start.
- Retention: a daily cron-style cleanup (run on backend boot + every 24h) deletes recordings older than `TERMINAL_RECORDING_RETENTION_DAYS` and removes the corresponding DB rows.
- **Privacy banner** must be visible in the UI when recording is enabled. The status line above the xterm reads "Recording" with a tooltip explaining where the file lives and the retention policy.
- **Audit log:** `TERMINAL_SESSION_END` audit row gains a `recording_path` field when recording was active.

### D.3 — Replay UI

- New page `admin/frontend/src/pages/TerminalRecordings.jsx`, admin-only:
  - Lists `terminal_sessions` rows with filters by user, target_kind, date range.
  - Each row links to `/admin/terminal/replay/:id`.
- Replay page uses `asciinema-player` (npm package). Streams the `.cast` file via a new `GET /api/terminal/recordings/:id/stream` endpoint that the backend serves with appropriate Content-Type and 0600-permission gating.
- Delete button on each row removes the recording file + DB row, with a confirmation dialog.

### D.4 — Reconnect grace

- Server holds the PTY for `TERMINAL_RECONNECT_GRACE_MS` (default 30_000) after WebSocket close. During the grace window, output is buffered (capped at 64KB rolling buffer; older content dropped).
- Client reconnects with a `?session=<id>` query parameter. If a held session matches and was created by the same user, the buffer is flushed to the new socket and the PTY resumes. Otherwise a new session is started.
- Idle timeout still applies during grace.

### D.5 — Mobile polish

- Virtual keyboard helper bar above the xterm canvas on touch devices: buttons for `Tab`, `Esc`, `Ctrl`, `Alt`, `↑`, `↓`. `Ctrl` and `Alt` are sticky-modifiers (next keystroke is modified, then released).
- Larger default font on viewports < 640px.
- Two-finger tap → paste from clipboard; long-press → context menu (copy / paste).
- Fullscreen toggle on mobile (lets the operator use the terminal without the dashboard chrome).
- xterm renderer choice: try the canvas renderer on mobile (better perf) and fall back to DOM if it crashes.

### D.6 — Per-service ACL integration

- New helper in `middleware/auth.js`: `canExecOnService(userId, serviceId)` returns true if the user is admin OR if `user_service_access` has `can_write = 1` for that user-service pair.
- The container terminal upgrade handler resolves `<lxc-name>` to a service via `services.lxc_container_name = ?` and calls `canExecOnService`. Refusal returns 403 on upgrade.
- Host-shell terminal remains admin-only — no ACL extension.

### D.7 — Operator-configurable settings

- New Settings tab "Terminal" (admin-only):
  - Toggle: enable/disable recording (writes `TERMINAL_RECORDING_ENABLED` to DB-backed `app_settings` so the operator doesn't need to edit `.env`).
  - Numeric: max sessions per user (1-10).
  - Numeric: idle timeout (1-120 minutes).
  - Numeric: recording retention days (7-365).
  - Numeric: reconnect grace seconds (0-120).
- Settings written to `app_settings` table. Loaded at session-open time, not at boot — so changes take effect immediately for new sessions.
- Env-var values become defaults; DB values override.

### D.8 — Remove legacy ContainerTerminal

- Delete the `ContainerTerminal` component definition (currently `LxcContainers.jsx` lines 79-371).
- Delete its TabsTrigger and TabsContent ("Terminal" tab — the new InteractiveTerminal becomes the only terminal UI; rename "Terminal Beta" → "Terminal").
- The backend `POST /api/lxc/containers/:name/exec` endpoint can stay for one release as a non-UI compatibility path, but its frontend caller (`api.execInContainer` in `lib/api.js` lines 533-544) is removed.
- `tabComplete` (request-response tab completion) is also removed — the new terminal flows tab completion through the actual shell.

### D.9 — Documentation

- Add `docs/features/terminal/USAGE.md` with operator-facing docs:
  - How to open a terminal session (per container / for the host).
  - What programs are supported (anything that runs in a real PTY).
  - How to enable session recording, where recordings live, how to find them.
  - Retention behavior + how to extend it.
  - Privacy considerations (recordings include keystrokes — passwords typed at a sudo prompt land in the recording).
- Add `docs/features/terminal/TROUBLESHOOTING.md`:
  - "Connection refused on upgrade" → check Caddy reverse_proxy config.
  - "PTY exits immediately" → check container has a shell (`/bin/sh`/`/bin/bash`).
  - "Resize broken on mobile" → known limitation, see GitHub issue.
  - How to recover a session left running by an idle timeout.

## Verification checklist

Each ticked with a one-line evidence note in the commit message.

- [ ] **D.1.V** Docker container support: open a `kind:'docker'` terminal against an `nginx:alpine` test container. Run `vi /tmp/x`, save, exit. PTY mode confirmed via dockerode hijacked stream.
- [ ] **D.2.V** Recording on: open a session, type `ls`, exit. Confirm the `.cast` file exists, has 0600 perms, and replays correctly via `asciinema play`.
- [ ] **D.2.V2** Recording off (default): confirm no `.cast` file is created and `terminal_sessions.recording_path` is NULL.
- [ ] **D.2.V3** Retention: set `TERMINAL_RECORDING_RETENTION_DAYS=0`, restart backend, confirm old recordings are pruned within one cleanup cycle.
- [ ] **D.3.V** Replay page lists sessions, filters work, replay plays back smoothly.
- [ ] **D.3.V2** Delete button on a recording removes the file from disk AND the row from `terminal_sessions`.
- [ ] **D.4.V** Disconnect (close tab) and reconnect within 30s with the same session token: PTY survives, buffered output flushes. Reconnect after 31s: new session starts cleanly.
- [ ] **D.5.V** Mobile at 360×640: virtual keyboard bar visible and functional, font legible, terminal usable for `vi /tmp/x`.
- [ ] **D.6.V** A non-admin user with `can_write=1` on service A can open a terminal for A's container. Without `can_write`, upgrade returns 403.
- [ ] **D.7.V** Toggle "recording enabled" in Settings → next session writes a recording. Toggle off → no recording. Both happen without backend restart.
- [ ] **D.8.V** Legacy `ContainerTerminal` component removed; "Terminal" tab uses the new `InteractiveTerminal`. `api.execInContainer` removed from `lib/api.js`.
- [ ] **D.9.V** USAGE.md and TROUBLESHOOTING.md present and accurate.
- [ ] **D.X** **Migration version 7** (terminal_sessions table) registered via `runMigration` with `disableFks: false` (no DROP TABLE involved). Smoke-tested on a fresh DB and on an upgrade from MVP-state DB.
- [ ] **D.Y** **`update.sh` on an existing install with active terminal sessions**: confirm the pre-update DB backup includes `terminal_sessions` rows, the upgrade health check passes, and the new feature works post-update.
- [ ] **D.Z** **Fresh `install.sh`** with the new `TERMINAL_*` env keys present in `.env.example` — `sync_env_keys` correctly appends them on existing installs.

**Deploy validation (mandatory):**

- `bash -n install.sh && bash -n update.sh` clean.
- `node --check` clean on every touched JS file.
- Vite production build clean of CSP violations.
- All migrations run cleanly on:
  1. A fresh DB.
  2. A DB at MVP state (versions 1, 2, 3, 5 applied; no `terminal_sessions`).
  3. A DB at production state, re-run (idempotency).

## Function-by-Function Checklist

(To be populated by the executing session BEFORE any code lands. The list above under "Deliverables" is the source of truth — translate D.1 through D.9 into 15-20 concrete, testable, single-commit items. Use the Phase 2b function-by-function checklist as the format reference.)

- [ ] _pending_ — populate from Deliverables before touching code.

## Commit messages

```
feat(terminal): D.1.x docker container exec via dockerode
feat(terminal): D.2.x asciinema cast-file writer
feat(terminal): D.3.x recordings list + replay UI
feat(terminal): D.4.x reconnect grace window
feat(terminal): D.5.x mobile virtual-keyboard helpers
feat(terminal): D.6.x per-service ACL on container terminals
feat(terminal): D.7.x operator-configurable terminal settings
refactor(terminal): D.8 remove legacy ContainerTerminal
docs(terminal): D.9 USAGE + TROUBLESHOOTING
verify(terminal): D.x.V <one-line evidence>
docs(terminal): mark production phase complete
```

---

## Post-MVP Use Notes

> **Operator: fill this section in BEFORE kicking off the production-hardening session.**
> Use the MVP for at least a week of real operator work — open terminals against real
> containers, run `vim`, `htop`, `tmux`; intentionally close tabs mid-session; try it on
> mobile if mobile use is anticipated; let an idle session expire; check the audit log.
> Then write down everything that surprised you, frustrated you, or felt missing. Be
> specific (file:line where applicable, exact program names, exact behaviors).
>
> The Claude Code session that picks up `terminal-production-prompt.md` will read this
> section and use it to **adjust the default plan above** — anything you flag as a
> blocker bubbles to the top of the work order; anything you flag as out-of-scope is
> dropped. If a section is empty when the session starts, it falls back to the default
> plan.

### Use feedback (operator-supplied)

**Date of MVP first-use:** _<fill in>_

**MVP commit hash at first-use:** _<fill in>_

**What worked well:**
- _<bullet list — concrete behaviors that were better than expected>_

**What broke or surprised me:**
- _<bullet list — UX confusion, performance gotchas, edge-case crashes; include reproducer steps>_

**Programs I expected to work that didn't:**
- _<list: e.g., "ssh from inside the container", "less with --RAW-CONTROL-CHARS", "vim plugins that need 256-color">_

**Workflow gaps:**
- _<list: e.g., "no way to copy multi-line output", "tab completion for nested paths is slow", "session timeout fires mid-edit">_

**Mobile use, if any:**
- _<observations from real device tests; if not used, write "not tested">_

**Privacy / compliance considerations specific to my deployment:**
- _<e.g., "we cannot record sessions due to <regulation>", or "we MUST record everything for SOC 2", or "recordings are fine but must NOT include keystrokes (input track)">_

**Features from the default plan that should be DROPPED for my use:**
- _<e.g., "I don't run Docker containers, so D.1 is wasted effort">_

**Features NOT in the default plan that I want added:**
- _<e.g., "session sharing (two operators in one PTY)", "command-bookmarks bar", "theme switcher">_

**Performance issues encountered:**
- _<e.g., "yes | head -c 1G crashed the browser despite the backpressure guard", "htop refresh causes 100% CPU on a Raspberry Pi backend">_

**Security concerns from operator use:**
- _<e.g., "I noticed the audit log doesn't capture which container the session was for", "I want a way to force-kill all active terminals from another browser tab">_

**Priority for the production phase (rank these):**
- Docker support — _high / med / low / drop_
- Recording + replay — _high / med / low / drop_
- Reconnect grace — _high / med / low / drop_
- Mobile polish — _high / med / low / drop_
- Per-service ACL — _high / med / low / drop_
- Settings UI — _high / med / low / drop_
- Legacy ContainerTerminal removal — _high / med / low / drop_

**Anything else:**
- _<free-form notes>_

---

When this section is filled in, kick off the next session with `terminal-production-prompt.md`. The session reads this file in full as Step 0 and uses your notes to populate the function-by-function checklist before any code lands.
