# Kickoff prompt — Interactive Terminal MVP

Copy everything in the fenced block below into the first message of a new
Claude Code session. The prompt is scoped to **one feature** — the streaming
terminal MVP described in `terminal-mvp.md`. When the MVP is complete and
verified, the production-hardening session uses `terminal-production-prompt.md`
with operator-supplied post-MVP feedback.

---

```
You are picking up the ProxyPilot interactive-terminal feature. Work
ONLY on the MVP described in
docs/features/terminal/terminal-mvp.md — the production-hardening
work (Docker support, asciinema recording, reconnect grace, mobile
polish, ACL integration) is a SEPARATE next session and is OUT OF
SCOPE for this run. Do not touch files under docs/core/plan/ — phase
work and this feature are parallel concerns.

## Branch

The hardening work (versioned migrations, B5 TOTP encryption, B4
cookie auth, B1 cap-drop, body-limit fix, install/update validation,
deploy regressions fix) is merged to `main`. Cut a fresh branch from
the latest main:

    git fetch origin main
    git checkout main
    git pull origin main
    git checkout -b claude/terminal-mvp-<your-session-suffix>

Push to that new branch throughout the session. Do not push to main
directly — the operator handles merges via PR.

## Hard segmentation rules (the harness will hang otherwise)

These were learned the hard way during prior sessions. They are
non-negotiable.

1. **Reads ≤ 200 lines.** Always pass `offset` + `limit`. Use Grep
   first to locate the line you want, then read a tight window.
   Dashboard.jsx is ~7300 lines, LxcContainers.jsx is ~2000 lines —
   reading either whole will hang.
2. **Edits are targeted.** Use Edit with old_string / new_string blocks
   carrying just enough surrounding context to be unique. Never rewrite
   a whole file via Write unless the file is brand-new or under ~200
   lines.
3. **Long-running commands run in the background.** `npm install`,
   `vite build`, `npm run dev`, the dev backend, puppeteer scripts,
   `docker compose build` — all go through `run_in_background: true`.
   Read output later via BashOutput. Never block a tool call on a slow
   process.
4. **TodoWrite checkpoints between segments.** Update the todo list
   after every meaningful step so progress is visible and so you don't
   lose your place if you have to back out a segment.
5. **One checklist item = one commit. Push after every commit.** If an
   item turns out too large, edit terminal-mvp.md to split it into
   sub-items first, then implement each sub-item as its own commit.
   Never batch.
6. **If a segment hangs, cancel and split.** Never retry the same
   over-large operation. If the same Read call hangs twice, the file
   is too big — switch to Grep + a narrower Read window.
7. **One concern per commit.** Bug fix, feature, doc update — pick one.
   Mixing makes diffs unreviewable and rollback impossible.

## Read, in order, before touching any code

1. `docs/features/terminal/terminal-mvp.md` — the spec. **Read it in
   full** with offset/limit reads (the file is ~250 lines so two reads
   cover it). Every section matters: scope, files to edit,
   deliverables, configuration, verification, function-by-function
   checklist.

2. `admin/frontend/src/pages/LxcContainers.jsx`, lines 1979-2019 —
   the Beta-tab placeholder you are replacing. Read just that window.

3. `admin/frontend/src/pages/LxcContainers.jsx`, lines 79-371 —
   the existing `ContainerTerminal` (request-response) component. You
   are NOT removing it during the MVP; it stays as the legacy "Terminal"
   tab. Read just that window so you understand its contract and don't
   accidentally break it.

4. `admin/backend/src/routes/lxc.js`, lines 839-873 —
   the existing `/api/lxc/containers/:name/exec` endpoint. The MVP
   does not modify this endpoint; you are adding a parallel WebSocket
   path. Read just that window.

5. `admin/backend/src/index.js` in full — it is ~210 lines, so a single
   read is fine. Pay attention to middleware ordering and the recent
   B4 cookie wiring. The WebSocket server attaches to the same HTTP
   server you create here.

6. `admin/backend/src/middleware/auth.js` in full — ~105 lines. The
   wsAuth middleware mirrors the cookie-then-header logic.

7. `admin/backend/src/db.js`, the `logAudit` definition only (Grep for
   `function logAudit` or `export.*logAudit` and read 30 lines around
   it). You are reusing it, not extending it.

Do NOT read other files unless an Edit's old_string requires more
context. Do NOT read docs/core/plan/* — phase work is unrelated.

## Lessons inherited from prior sessions

1. **Migrations framework is in place** (commit 1352d42). If you find
   yourself needing a schema change for the MVP, register it via
   `runMigration(db, version, name, fn, opts)` with a fresh version
   number ≥ 6. Do NOT inline `CREATE TABLE` or `ALTER TABLE` outside
   the framework. The MVP as scoped does NOT need a schema change —
   the audit log already supports new event types via the existing
   `logAudit()` call signature.

2. **Cookie + CSRF auth is canonical** (commit ab488ac). The frontend
   uses `credentials: 'include'` and reads the `pp_csrf` cookie for
   the X-CSRF-Token header. WebSocket upgrade uses cookies natively;
   no CSRF check is required on the upgrade itself because SameSite=Strict
   on `pp_token` blocks cross-site upgrades.

3. **Body limits are tight** (commit 6a1b86f). The default 1mb does NOT
   apply to WebSocket payloads — those are framed by the WebSocket
   protocol. No interaction with body parsing.

4. **B1 cap-drop allows nsenter** (commit 24abfb6). The container has
   CAP_SYS_ADMIN + CAP_SYS_PTRACE, which is what makes `nsenter -t 1
   -m -u -n -i incus exec -t <name>` work. Do not add new capabilities
   without operator approval.

5. **TOTP_ENCRYPTION_KEY guard is fail-loud** (commit 0d6a859). In
   production NODE_ENV, missing keys crash the server at boot. The
   terminal feature does not need this key, but if your dev test
   accidentally trips the guard you'll see a clear error message at
   startup.

6. **update.sh DB backup + health check** (commits 062d79e + 6a1b86f).
   When you test V.15 (update on existing install) the script will
   poll `/api/health` for 60s post-restart. Make sure your changes
   keep `/api/health` responsive — a hung event loop or a synchronous
   blocking call in the WS server boot path will fail this check.

## Step 0 — Branch + setup verification (small)

After cutting the branch, verify the environment in three small bash
calls (NOT one long script):

1. `git log --oneline -15` — confirm you branched from a main that
   includes all of the hardening work. You should see (in any order
   among the recent commits) the deploy-regression fix `cad4e46`
   ("env corruption + Caddy README parse"), `6a1b86f` (body-limit
   ordering), `ab488ac` (B4 cookie auth), `0d6a859` (B5 TOTP
   encryption), `1352d42` (U2+B2 versioned migrations), and the
   merge commit that landed them all on main. If any of these are
   missing, you've branched from a stale main — pull and try again.
2. Check `node_modules` exists in `admin/backend` and `admin/frontend`.
   If missing, run `npm install` in each in the background and check
   status with BashOutput later.
3. Check that the existing dev environment can boot the backend cleanly:
   `cd admin/backend && node --check src/index.js`. Exit code 0
   confirms no syntax regressions on top of main.

Checkpoint via TodoWrite after each step.

## Step 1 — Build the MVP one item at a time

Walk the function-by-function checklist in `terminal-mvp.md` from the
top:

  B.1 → B.2 → B.3 → B.4 → B.5 → B.6 → B.7 → F.1 → F.2 → F.3

For each item:

1. Implement it (small targeted edits — see segmentation rules).
2. Sanity-check it BEFORE committing:
   - Backend code: `node --check <file>`. For B.4 (`pty.js`) write a
     20-line one-shot smoke script that spawns a host-kind PTY and
     writes `echo ok` — the resulting output must contain `ok`. Delete
     the smoke script before committing.
   - Frontend code: confirm vite dev (`npm run dev` in background)
     hot-reloads without console errors after the change.
3. Tick the checkbox in `terminal-mvp.md`: `- [ ]` → `- [x]`.
4. Commit with the message format from terminal-mvp.md ("commit
   messages" section). Push.
5. Update TodoWrite. Move to the next item.

Do NOT batch items into one commit.
Do NOT mark an item complete based on type-checks or builds alone —
those verify code correctness, not feature correctness.

## Step 2 — Verification

After all B.x and F.x items are ticked, walk the V.1–V.19 verification
checklist. Each item gets its own commit (`verify(terminal): V.x …`)
that ticks the box and adds a one-line evidence note inline.

V.4 / V.5 / V.6 require a real browser session against a running
backend talking to a real LXC container. Spin up:

- The dev backend in the background (`npm run dev` from
  admin/backend).
- The frontend dev server in the background (`npm run dev` from
  admin/frontend).
- A test LXC container (re-use the puppeteer/auth-bypass pattern
  documented in NEXT-SESSION-PROMPT.md sections 4-5 if you need
  scripted login; otherwise log in manually through the browser).

V.15 (update.sh on existing install) and V.16 (fresh install.sh) MUST
be performed against a real disposable VM or container. Document the
test environment in the verification commit message. If you do not
have access to a disposable VM, STOP and ask the operator how to
proceed — do NOT skip these two checks.

## Step 3 — Finish the MVP

When every V.x box is ticked:

1. Append a `## MVP — Verified` section at the bottom of
   `terminal-mvp.md` with today's date and the latest commit hash.
2. Commit:
       docs(terminal): mark MVP complete (verified <date>)
3. Push.
4. Stop. Report back that the terminal MVP is verified and ready for
   operator hands-on use. The production-hardening session is a
   separate kickoff prompt
   (`docs/features/terminal/terminal-production-prompt.md`); the
   operator will trigger that after spending real time with the MVP.

## Rules

- Stay scoped to the MVP. Touch only files terminal-mvp.md lists under
  "Files to edit", plus terminal-mvp.md itself for tick-marks.
- Do NOT touch the legacy `ContainerTerminal` component or the
  `/api/lxc/containers/:name/exec` endpoint — they coexist with the
  new code during the MVP. Removal is a production-phase task.
- Do NOT add Docker container support, asciinema recording, mobile
  polish, or reconnect grace. Those are explicitly out of scope and
  belong to the production phase.
- Commit often. One checklist item = one commit. Push after every
  commit.
- Never mark a verification item complete unless it actually passed
  — type-checks and builds verify code correctness, not feature
  correctness.
- Never skip V.15 or V.16. Main's deploy story (install.sh +
  update.sh + the DB-backup/restore trap + the `/api/health`
  post-up gate) is the foundation everything else stands on; if
  your changes break install.sh / update.sh, the whole branch is
  unsafe to merge.
- Do not create a pull request — the operator handles merges.
- Ask before any destructive action (rebases, force pushes, deletes).

Begin with Step 0: cut the branch and verify the environment.
```

---

## How to use this prompt

1. Start a new Claude Code session on this repo.
2. Copy the fenced block above (everything between the two triple-backtick lines) and paste it as the first message.
3. The session will read the orientation files, branch, and reply with confirmation of the environment + a draft of B.1 before running `npm install`. Approve or correct it before it ships changes.
4. Subsequent sessions resuming the MVP after a break: paste the same prompt — the session will re-orient itself, see the partially-ticked checklist, and pick up at the first unticked item.
5. When the MVP is complete and verified, **switch to `terminal-production-prompt.md`** for the production-hardening pass. Do not extend this prompt — the production prompt has additional scope and a placeholder for operator feedback.
