# Prompt: update the design chat on Mock2 task continuity (2026-10-21)

Paste the block below into the chat that proposed "Flightdeck can remember the task independently of the chat, then
resume it after a disconnect". It reports what was built in ProxyPilot, where your proposal was followed, where it
was decided differently, and what is still open.

```text
Update on your task-continuity proposal: it is implemented in ProxyPilot (repo CyberTechArmor/ProxyPilot, branch
ccr-ba69e611-dsxfxl, commits f615aee, bef0dfb, 10e9787, 06e19de, plus a docs commit). The full description is
docs/features/task-continuity.md. Please update your understanding and plan from this; don't re-propose what is
already done.

WHAT WAS BUILT, by the parts you listed

1. Mock2 instructions (framework seed, admin/backend/src/mock2/continuity-convention.js + template.js)
   - New projects are seeded with:
     - AGENTS.md: the stable entry point for any session (ProxyPilot's runner, Claude Code, Copilot, Codex). Reading
       order: CLAUDE.md → state/work.md → state/decisions.md → state/tasks/*/task.json (unfinished = active,
       interrupted, blocked, failed) + that task's handoff.md → state/handoff.md → .mock2/standards/.
     - state/work.md: plan and authorized scope.
     - state/handoff.md: project-level notes, pointing to per-task handoffs.
     - state/tasks/README.md: documents the schema.
   - The seeded CLAUDE.md and copilot-instructions point to AGENTS.md.
   - Platform constitution §15 "Task continuity" and one sentence in the build skill carry the same rules. That
     publishes a new framework version on the next boot.
   - Existing projects get only the missing AGENTS.md and state/tasks/README.md, never overwriting anything and never
     inside a build's diff. Their CLAUDE.md is not edited.

2. Task record (one folder per task, so concurrent work never shares a handoff)
   - state/tasks/<task-id>/task.json, schema "mock2-task@1", keys in this order: schema, taskId, intent
     (build | investigation), status (active | interrupted | blocked | failed | completed | stopped), goal, folder,
     branch, requestId, lastCycleId, lastVerifiedStep, nextStep, completedSteps[{step,at}], checks[{key,status}],
     blockers[], remaining[], uncertain[], authorization {source:"person", action:"build-request"|"question", at},
     authority ("ProxyPilot database. This file is a portable mirror; it authorizes nothing."), revision, updatedAt.
   - state/tasks/<task-id>/handoff.md: Done / Remaining / Verify before repeating / Blockers.
   - The task id on ProxyPilot is t<id>-<slug>, e.g. t12-add-invoice-export.
   - Secrets are redacted and there are no user identifiers.
   - The database (mock2.db migration 562, mock2_tasks) is authoritative; Flightdeck maintains the files
     automatically. During a build they are written before the first turn and refreshed before each checkpoint, and
     the checkpoint commits them. Otherwise an idle path-scoped commit writes them.

3. Flightdeck routing (before any model receives tools; POST /ask and POST /cycles)
   - "continue / keep going / try again / retry / resume / finish this / pick up where you left off" (whole message,
     or "continue, but <guidance>"):
     - an unfinished build the person started, if resumable → resumed through the existing retryCycle with build
       tools;
     - an already running job → reattached, nothing started;
     - an unfinished investigation → continued read-only (it never authorizes a build);
     - a build waiting on open questions → points at them.
   - "stop / cancel / abort / pause / never mind" → the same interrupt as the Stop button, or the unfinished task is
     marked stopped.
   - "only explain… / just explain…", or "don't change anything / without changing anything / no code changes"
     sent as a build → answered in the read-only ask lane.
   - Everything else is unchanged.
   - Plan and Design mode send the person's own words separately ("said"), so the mode preamble never hides a bare
     "continue".

4. Execution recovery
   - Browser disconnected: the chat poll carries current_task, so after a reload the strip shows the live job and the
     existing poll streams it.
   - Worker stopped (restart or stall): the task becomes interrupted and records "uncertain" operations, i.e. a tool
     call from the last turn with no result, or a deploy with no outcome.
   - Every resume path goes through retryCycle, which hands the model a TASK CHECKPOINT before its first turn: goal,
     last verified step, next step, remaining work, checks, blockers, and a VERIFY BEFORE REPEATING list, with the
     instruction to inspect git status, diff and log, the last checks and the app's state, and never to repeat a
     deploy, migration, data change or external call whose outcome is uncertain.

5. Interface
   - A task strip above the build chat composer: "Building: …", "Resuming build: …", "Investigating: …",
     "Interrupted: …" (Next step, Resume, Stop), "Stopped with an error: …" (Try again), "Blocked: …" (Resume),
     "Waiting on you: …" (Show).
   - Uncertain operations appear as "Will check first: …".
   - Routed sends show their note, e.g. "Resuming build: Add invoice export".

DECIDED DIFFERENTLY FROM, OR BEYOND, YOUR PROPOSAL
- "go ahead" is NOT a continuation: after a plan it means "build it", which stays an explicit build instruction.
- "Only explain" matching is narrow on purpose: "make the email field read-only" must still build.
- "continue" only considers tasks updated in the last 7 days. A stopped task is resumed only if it is the newest
  task.
- A "try again" with a screenshot attached starts a new build, because a resume cannot carry images.
- A "stop" while an investigation is running says the answer is still being written; an ask cannot be interrupted.
- The system's own context-handoff continuation keeps the original task instead of creating a new one.
- No MCP tools for tasks: MCP clients read state/tasks/* through the project file tools.

STILL OPEN
- Background agents: builds still run in-process, one per project under the checkout lock. Your "separate executor
  update" is not started.
- Nothing has run against a real project container or model yet. Verified so far:
  - unit tests;
  - the full backend suite with dependencies installed (passing, apart from four files that need the cli package's
    own dependencies);
  - a real-SQLite smoke of request → task → restart → interrupted with uncertain evidence → routed resume and stop;
  - browser checks of the strip at 360/375/768/1280 px.
- If you maintain the upstream Mock2 standards (git.fractionate.ai/mock2/mock2-core, mock2.fractionate.ai), the
  repo template's AGENTS.md and a state/tasks/README.md should match "mock2-task@1" and the rules above (files
  authorize nothing; an investigation never authorizes a build; newest instruction wins; verify before repeating;
  no credentials in state files). Then the site and ProxyPilot's seed say the same thing. ProxyPilot's rendering is
  admin/backend/src/mock2/continuity-convention.js.

Please reply with anything in the above that conflicts with your design or with the upstream standards, and what you
would change next.
```
