# Task continuity: resume work after a disconnect

**Where to find it:**
- Dashboard: Dev Studio → a project in the build phase → the build chat (Flightdeck or Classic view). The **task
  strip** sits just above the composer.
- API: `/api/mock2/projects/:id/tasks*`, plus routing inside `POST …/ask` and `POST …/cycles`, and `current_task`
  on `GET …/chat`.
- Code:
  - backend: `admin/backend/src/mock2/task-logic.js` (pure decisions), `tasks.js` (store), `task-files.js` (portable
    files), `task-sync.js` (hooks, routing, resume/stop), `task-routes.js` (HTTP), `continuity-convention.js` (the
    Mock2 convention files);
  - frontend: `components/mock2/TaskStrip.jsx`, `components/mock2/task-strip-logic.js`, and the routed-send handling
    in `BuildChat.jsx`.
- Data: mock2.db migration 562 (`mock2_tasks`).

Flightdeck remembers what the person asked for apart from the chat, and picks it up again after a disconnect, a
restart or a stalled build. A **task** is one build request (`intent: build`, one per `mock2_requests` row, kept
across its resumes and its context-handoff continuations) or one Ask / Plan / Research run
(`intent: investigation`). Its status is `active`, `interrupted`, `blocked`, `failed`, `completed` or `stopped`; the
first four are *unfinished*.

## Who decides: the database, never the files

- `mock2_tasks` is authoritative for a task's intent, status, goal, checkpoint and authorization.
- Flightdeck keeps a portable mirror in the project's own repository (below). The mirror gives any later session
  context; **it authorizes nothing**. Nothing in ProxyPilot reads it back.
- Build tools are only ever handed out by a path that already existed: `retryCycle` of a build a person started,
  or a new build a person sends. **An investigation never authorizes a build**; turning a plan into a build still
  needs the person's explicit build instruction.

## Routing: "continue", "try again", "stop", "only explain"

`POST /ask` and `POST /cycles` first resolve the person's words against the project's tasks, **before any model
receives tools**. In Plan and Design mode the composer adds a preamble, so the client also sends the person's own
words as `said`, and routing reads those. The rules are in `task-logic.js`
(`classifyContinuationMessage`, `resolveTaskRoute`).

| The person says | When | What happens |
|---|---|---|
| continue, keep going, try again, retry, resume, finish this, pick up where you left off… (whole message, optionally `continue, but …` with guidance) | the newest unfinished build (≤ 7 days) can resume | **resume_build**: `retryCycle` on its last cycle, the guidance as the resume message, the recovery checkpoint attached |
| same | that task is running now | **attach**: nothing starts; the chat shows the running job |
| same | the newest unfinished task is an investigation | **continue_investigation**: a read-only ask continuing it, in either lane |
| same | the build waits on open questions | **answer_required**: points at the question cards |
| stop, cancel, abort, pause, never mind… (whole message) | a build is running | **stop_build**: the same interrupt as the Stop button (`stop_after_step`) |
| same | nothing running, an unfinished task exists | **stop_task**: the task is marked stopped |
| only explain…, just explain…, or "don't change anything" / "without changing anything" / "no code changes" anywhere | sent as a build | **investigate**: answered in the read-only ask lane |
| anything else | — | **pass**: today's behaviour, unchanged |

The matching is deliberately narrow:
- "go ahead" is not a continuation: after a plan it means "build it", which must stay an explicit instruction.
- "Stop the timer from resetting" and "make the email field read-only" are ordinary build requests.
- A "try again" with a screenshot attached starts a new build, because a resume turn cannot carry images.
- Card resends (redo, clarifier, split, suggestions, research, escalation) are never routed.

A routed send answers `{ routed: { action, task, note } }`. The server echoes the person's message once and posts
`note` (for example "Resuming build: Add invoice export") as a system message. Audit:
- `MOCK2_TASK_ROUTED` for a routed send;
- `MOCK2_TASK_RESUME` for the strip's Resume;
- `MOCK2_TASK_STOP` for the strip's Stop;
- `MOCK2_CYCLE_INTERRUPT` for a stop of a live build.

## Recovery

- **The browser disconnected.** The chat poll carries `current_task`. After a reload the strip shows the live job
  at once ("Building: …" / "Resuming build: …" / "Investigating: …"), and the existing poll streams its progress.
- **The worker stopped.**
  - A restart: `sweepMock2OnBoot` fails orphaned cycles, then `sweepTasksOnBoot` marks their tasks `interrupted`,
    and running investigations too.
  - A stall: the watchdog interrupts the cycle.

  Either way the task records what the stopped segment may or may not have finished (`uncertain`): a tool call
  from its last turn with no result, or a deploy with no outcome.
- **Every resume reads the checkpoint first.** `retryCycle` (Retry, Restart build, the header and banner buttons,
  a routed "try again", the strip's Resume) attaches `buildRecoverySection(task)` to the resumed cycle. Before its
  first turn the model sees:
  - the goal, last verified step, next step, remaining work, checks and blockers;
  - a **VERIFY BEFORE REPEATING** list;
  - the instruction to inspect git status, diff and log, the last check results and the app's state;
  - the rule never to repeat a deploy, migration, data change or external call whose outcome is uncertain.

  A bare resume stays a bare resume otherwise: the classifier and prepass behave as before, and the checkpoint text
  is all it gains.
- **"Stop" wins over a stale resume.** A stopped task is only picked up again by "continue" when it is the newest
  task.

## The task strip

`TaskStrip.jsx` shows `current_task`: the live task, else the newest unfinished one. Its states:

| State | Wording | Actions |
|---|---|---|
| live build | Building / Resuming build | — |
| live investigation | Investigating | — |
| interrupted | Interrupted, with "Next: …" | Resume and Stop |
| failed | Stopped with an error | Try again; Stop inside the details |
| blocked, resumable | Blocked: \<reason\> | Resume |
| blocked on questions | Waiting on you | Show (scrolls to the question) |

- A task that is not running and lists uncertain operations shows them as "Will check first: …". Stopped and
  completed tasks are not shown.
- Resume sends any composer text as guidance.
- Viewers see the strip without buttons.
- Words and states are in `task-strip-logic.js`.

## Portable files in the project repository (the Mock2 convention)

New projects are seeded with:
- `AGENTS.md`: the entry point and reading order for any session (Flightdeck's runner, Claude Code, Copilot,
  Codex);
- `state/work.md`: plan and authorized scope;
- `state/handoff.md`: project-level notes;
- `state/tasks/README.md`: the schema.

Platform constitution §15 and the build skill carry the same rules.

Each task gets its own folder, so concurrent work never shares one handoff:
- `state/tasks/<key>/task.json`: schema `mock2-task@1`, a fixed key order, secrets redacted, no user identifiers,
  and `"authority": "ProxyPilot database. This file is a portable mirror; it authorizes nothing."`.
- `state/tasks/<key>/handoff.md`: a short summary for the next session.

The key is `t<id>-<slug>`.

When the files are written:
- **During a build:** before its first turn, and again just before each checkpoint commit. They are not committed
  separately; the checkpoint commits them.
- **Otherwise:** once the project is idle (no lock, no live cycle, no running ask), as a path-scoped commit of
  exactly those files (`ProxyPilot Flightdeck <flightdeck@proxypilot>`), debounced and retried with backoff.

Existing projects get `AGENTS.md` and `state/tasks/README.md` only where those paths do not exist, and only through
the idle commit, never inside a build's diff. Their own `CLAUDE.md` is not edited, so a tool that reads only
`CLAUDE.md` finds `AGENTS.md` by convention, not by a pointer.

## API

| Method | Path | Role | Answer |
|---|---|---|---|
| GET | `/projects/:id/tasks?scope=unfinished\|all&limit=` | viewer | `{ tasks, current }` |
| GET | `/projects/:id/tasks/:key` | viewer | `{ task }`, 404 for an unknown or invalid key |
| POST | `/projects/:id/tasks/:key/resume` `{ message? }` | editor | 202 `{ routed }`; 409 when not resumable |
| POST | `/projects/:id/tasks/:key/stop` | editor | 200 `{ routed }` |

`TaskShape`: `key, id, intent, status, unfinished, goal, request_id, last_cycle_id, live, resumed, can_resume,
last_verified_step, next_step, remaining, blockers, uncertain, checks, completed_steps, files, created_at,
updated_at, finished_at`.

## Not in this change

- An executor for real background workers. Builds still run in-process, one per project under the checkout lock.
- MCP tools for tasks. MCP clients read `state/tasks/*` through the project file tools like any other file.

## Verified so far

- Unit tests: `mock2-task-logic`, `mock2-task-files` (real `sh` + `git` against a bare origin), `mock2-tasks-store`,
  `mock2-task-sync`, `mock2-continuity-convention`, and `task-strip-logic.test.mjs` in the frontend.
- With the backend's dependencies installed, the full backend suite passes except four files that need `cli/`
  dependencies.
- A real-SQLite smoke ran the whole path: migration 562, request → task, the running cycle, a restart (boot sweep →
  interrupted with the unfinished deploy and command as uncertain), routing, and a routed resume reaching
  `retryCycle` and a routed stop.
- The strip passed the browser check (`task-strip.browser.mjs`) at 360/375/768/1280 px.

Nothing has run against a real project container or model yet.
