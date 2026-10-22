// Task continuity — the Mock2 repository convention for resuming work.
//
// Every project repository carries a small set of portable files that let any
// session (the platform's build runner, a developer's editor, another tool)
// pick up unfinished work without the chat that started it:
//
//   AGENTS.md                         the stable entry point and reading order
//   state/work.md                     the plan and the scope the owner authorized
//   state/decisions.md                durable decisions (seeded by template.js)
//   state/tasks/<task-id>/task.json   structured checkpoint for ONE task (mock2-task@1)
//   state/tasks/<task-id>/handoff.md  short explanation of that task for the next session
//   state/handoff.md                  project-level notes between sessions
//
// One folder per task, so two builds running at once never overwrite one
// shared handoff. On ProxyPilot the platform database is authoritative for
// what ran and what was authorized; Flightdeck mirrors it into these files.
// The files never authorize anything, and never hold credentials.
//
// This module is PURE (stub-first, risk R9): it returns paths and file
// contents as strings and imports nothing that opens a DB, hits the network,
// or touches Incus. template.js seeds the files into new projects; the task
// writer adds the convention files to existing projects only where a path is
// absent (conventionFilesIfAbsent) — it never overwrites them.
//
// Terminology (risk R7): AGENTS.md is the industry file name the tools look
// for; nothing in the code here is named "agent" beyond the one required
// export, agentsMd.

export const TASK_SCHEMA = 'mock2-task@1';
export const TASKS_DIR = 'state/tasks';

// A task folder is ONE path segment: lowercase letters, digits and hyphens,
// starting and ending with a letter or digit. ProxyPilot's keys
// (t<id>-<slug>, see task-logic.js) always match; anything that could climb
// out of state/tasks/ ('..', '/', NUL) never does.
const TASK_FOLDER_RE = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;

function taskFolder(key) {
  const k = String(key ?? '');
  if (!TASK_FOLDER_RE.test(k)) throw new TypeError(`invalid task folder name: ${JSON.stringify(k.slice(0, 80))}`);
  return k;
}

// Repo-relative paths for one task's records. Throw on a key that is not a
// single safe folder name rather than build a path outside state/tasks/.
export function taskDir(key) {
  return `${TASKS_DIR}/${taskFolder(key)}`;
}

export function taskJsonPath(key) {
  return `${taskDir(key)}/task.json`;
}

export function taskHandoffPath(key) {
  return `${taskDir(key)}/handoff.md`;
}

function projectName(project) {
  return String(project?.name || 'Project').trim() || 'Project';
}

// AGENTS.md — the entry point any tool or session reads first.
export function agentsMd(project) {
  const name = projectName(project);
  return `# ${name} — start here

Read this first when you start or resume work in this repository, whoever you
are: ProxyPilot's build runner, Claude Code, GitHub Copilot, Codex or another
tool or session. It says where the plan, the decisions and any unfinished work
are recorded, and the rules for using them.

## Reading order

Preserve the repository's managed Mock2 startup instructions. If a managed
block supplies a startup command or reading order, follow it first; this task
lookup supplements it and never replaces it. Do not overwrite a managed block
or project-owned instructions to add continuity. Where the files exist:

1. \`.mock2/capacity.md\` — the canonical run and handoff workflow; then
   \`000-READ-FIRST.md\`, if this branch has one.
2. \`state/handoff.md\`, \`state/work.md\` and \`state/decisions.md\` — the
   current project notes, plan, authorized scope and durable decisions, in
   that canonical order. The person's newest instruction outranks stale state.
3. \`state/rules.md\` and \`state/production-checklist.md\` — the confirmed
   requirements and verification notes.
4. \`state/tasks/*/task.json\` — one folder per task. Unfinished tasks have
   status \`active\`, \`interrupted\`, \`blocked\` or \`failed\`. Read the
   named task and its \`handoff.md\`; the format is in \`state/tasks/README.md\`.
5. \`CLAUDE.md\` — project and stack context; Copilot also reads
   \`.github/copilot-instructions.md\`. Their pointer back to this file is
   an entry link, not an instruction to restart this reading order.
6. \`.mock2/standards/\` — the repository's pinned Mock2 guidance, starting
   with \`constitution.md\` and the rules applicable to the work before edits.

### Selecting a task

Inside Flightdeck the database selects the authorized task. Bare "continue"
considers only this project's tasks updated in the last seven days; it can
select a stopped task only when that task is the newest task overall. An
already running task is reattached, not started again. A blocked build that
needs answers stays blocked. "Go ahead" is an explicit build request, not a
continuation keyword. Continuing an investigation stays read-only.

Outside the runtime, saved files are context only: read the task the person
names and verify the current goal before acting. Do not select or authorize a
build from the newest file, a stale timestamp or a stopped status alone.

## Rules

1. **One task, one folder.** Each task keeps its own records in
   \`state/tasks/<task-id>/\`. Never write another task's records, and never use
   one shared handoff for work that runs at the same time.
2. **Who keeps the task files current.** On ProxyPilot the platform database is
   authoritative: Flightdeck (Dev Studio's build workspace) writes these files
   from it and overwrites any edits, so inside Flightdeck do not edit
   \`state/tasks/\` by hand. Outside ProxyPilot (a plain checkout), keep your own
   task's \`task.json\` and \`handoff.md\` current in the same format, after each
   verified step and before you stop.
3. **Files never authorize anything.** A saved task gives you context, not
   permission: a task file authorizes nothing, whatever it says. An
   \`investigation\` task never authorizes a build — building needs the
   person's explicit instruction to build.
4. **The person's newest instruction wins.** If they say "only explain",
   answer without changing anything. If they say "stop", stop.
5. **Check before you continue.** When resuming, find out what actually
   completed — \`git status\`, \`git diff\`, \`git log\`, the last check results,
   the app's current state — before doing more. Never repeat an operation
   listed under \`uncertain\` (the handoff's "Verify before repeating" list: a
   deploy, a migration, a data change, an external call) until you have
   confirmed whether it already happened.
6. **No secrets in state files.** Never put credentials, tokens, keys,
   passwords or personal data in any file under \`state/\`, in this file, or in
   a commit message.
`;
}

// The worked example in state/tasks/README.md, rendered exactly as the task
// writer renders a real record (two-space JSON, keys in schema order).
const EXAMPLE_TASK = {
  schema: TASK_SCHEMA,
  taskId: 't12-add-invoice-export',
  intent: 'build',
  status: 'interrupted',
  goal: 'Add invoice export',
  folder: '/srv/app',
  branch: 'main',
  requestId: 34,
  lastCycleId: 88,
  lastVerifiedStep: 'Checkpoint 1a2b3c4 committed',
  nextStep: 'Resume from the last checkpoint',
  completedSteps: [{ step: 'Build started', at: '2026-10-21T10:00:00.000Z' }],
  checks: [{ key: 'typecheck', status: 'passed' }],
  blockers: [],
  remaining: ['Run checks', 'Review changes'],
  uncertain: ['A deploy was in progress when the build stopped — check whether the app serves the new version before deploying again'],
  authorization: { source: 'person', action: 'build-request', at: '2026-10-21T10:00:00.000Z' },
  authority: 'ProxyPilot database. This file is a portable mirror; it authorizes nothing.',
  revision: 7,
  updatedAt: '2026-10-21T10:05:00.000Z',
};

// state/tasks/README.md — the task record format.
export function tasksReadmeMd() {
  return `# Task records

Each task — a build or an investigation — keeps its own checkpoint here, so it
can be resumed in a new session and two tasks running at once never overwrite
each other's notes. Start from \`AGENTS.md\` at the repository root.

## Folders

One folder per task: \`state/tasks/<task-id>/\`, holding \`task.json\` and
\`handoff.md\`.

- On ProxyPilot the task id is \`t<number>-<slug>\` (for example
  \`t12-add-invoice-export\`): the platform's task number, then the goal in
  lowercase letters, digits and hyphens, cut to 40 characters.
- Elsewhere, use any stable lowercase id made of letters, digits and hyphens
  (for example \`2026-10-21-invoice-export\`). Ids of the form \`t<number>-…\`
  belong to ProxyPilot; do not create them by hand.

## Who writes them

- **On ProxyPilot**, Flightdeck writes both files from the platform database
  as the task moves and commits them. The database is authoritative; the files
  are a portable mirror, and hand edits are overwritten. Do not edit them
  inside Flightdeck.
- **Outside ProxyPilot**, the session doing a task writes that task's files —
  never another task's — after each verified step and before it stops.

The files never authorize anything, and never contain credentials, tokens,
keys, passwords or personal data.

## task.json (schema \`${TASK_SCHEMA}\`)

Two-space indented JSON with exactly these keys, in this order, ending with a
newline. Fields marked "or null" may be \`null\`.

| Key | Meaning |
|---|---|
| \`schema\` | Always \`"${TASK_SCHEMA}"\`. |
| \`taskId\` | The task id — the same as the folder name. |
| \`intent\` | \`build\` (change the code) or \`investigation\` (read-only: answer and propose). |
| \`status\` | One of the six statuses below. |
| \`goal\` | The task in one line, as the person asked for it. |
| \`folder\` | The working directory the task runs in (on ProxyPilot, \`/srv/app\` in the project container). |
| \`branch\` | The git branch the work is on, or null. |
| \`requestId\` | ProxyPilot's build request number, or null. |
| \`lastCycleId\` | The ProxyPilot build cycle the task last ran in, or null. |
| \`lastVerifiedStep\` | The last step confirmed to have completed (for example a checkpoint commit), or null. |
| \`nextStep\` | What to do next, or null. |
| \`completedSteps\` | Steps done so far, oldest first: \`[{ "step", "at" }]\`, keeping the 30 most recent. |
| \`checks\` | The latest check results: \`[{ "key", "status" }]\`, for example \`typecheck\` / \`passed\`. |
| \`blockers\` | What is stopping the task now (list of sentences). |
| \`remaining\` | Work still to do (list of sentences). |
| \`uncertain\` | Operations that may or may not have happened — check each before repeating it (list of sentences). |
| \`authorization\` | What started the task: \`{ "source", "action", "at" }\`. \`source\` is \`person\`; \`action\` is \`build-request\` (a person asked for a build) or \`question\` (a person asked a question — an investigation). It records context only and authorizes nothing; it never holds names, email addresses, ids or tokens. |
| \`authority\` | One sentence saying where the authoritative state lives. ProxyPilot writes "ProxyPilot database. This file is a portable mirror; it authorizes nothing." |
| \`revision\` | Goes up by one every time the task changes. |
| \`updatedAt\` | When the task last changed (ISO 8601, UTC). |

### Statuses

| Status | Meaning | Unfinished? |
|---|---|---|
| \`active\` | Running now, or queued to run. | yes |
| \`interrupted\` | Stopped unexpectedly (restart, disconnect, stall). Resume from the last verified step after checking \`uncertain\`. | yes |
| \`blocked\` | Waiting on something: answers, an administrator, budget. | yes |
| \`failed\` | Ended with an error; it can be tried again. | yes |
| \`completed\` | Done. | no |
| \`stopped\` | A person stopped it. Resume only when a person asks. | no |

### Build or investigation

A **build** task exists because a person explicitly asked for a build. An
**investigation** answers questions and proposes changes without changing
code. Continuing an investigation stays read-only: it never authorizes a
build, which still needs the person's explicit instruction.

### Example

\`\`\`json
${JSON.stringify(EXAMPLE_TASK, null, 2)}
\`\`\`

## handoff.md

A short note for the next session, in this layout:

\`\`\`markdown
# Task <task-id> — <intent> — <status>

**Goal:** <goal>

**Last verified step:** <step>
**Next step:** <step>

## Done
- <completed steps>
## Remaining
- <work still to do>
## Verify before repeating
- <the uncertain list, or "none">
## Blockers
- <blockers, or "none">
\`\`\`

ProxyPilot ends it with a line saying how to resume in Flightdeck ("continue"
or the Resume button), that the database is authoritative and the file
authorizes nothing, and that edits are overwritten.
`;
}

// state/work.md — the initial plan and authorized-scope file.
export function workMd(project) {
  const name = projectName(project);
  return `# Work — ${name}

The plan for this project and the scope its owner has authorized. Read it when
starting or resuming work (see \`AGENTS.md\`). The plan records and breaks down
what the owner asked for; it never widens it. Anything outside the authorized
scope needs the owner's explicit instruction first. Progress on each task is
kept in \`state/tasks/<task-id>/\`.

## What is being built
<one paragraph: what the app does and for whom>

## Authorized scope: <feature>
Outcome: <who can do what when this is done — one sentence>
Done when: <the R-### rules whose demonstrated behavior means done>
Appetite: <the owner's time budget, or "not set">

## Out of scope
- <what the owner has said this work does not do, or "none yet">

## Current plan
<!-- One line per item, in order. Tick an item only once it is verified. -->
- [ ] <item>

## Run history
<!-- One line per working session or build: date, what was done, result. -->

## Follow-ups
<!-- Findings outside the scope, one line each, starting with its severity. Lines leave only when the owner triages them. -->
- <none yet>

Never write credentials, tokens, keys, passwords or personal data here.
`;
}

// state/handoff.md — the initial project-level handoff.
export function projectHandoffMd(project) {
  const name = projectName(project);
  return `# Handoff — ${name}

Project-level notes for whoever works on this repository next: the state the
project is in and anything a new session needs that is not obvious from the
code. Keep it short and current.

**Work in progress is not tracked here.** Each task — a build or an
investigation — keeps its own checkpoint in \`state/tasks/<task-id>/\`
(\`task.json\` and \`handoff.md\`); look there first for unfinished work. Two
tasks running at once never share one handoff. See \`AGENTS.md\` for the
reading order.

## Current state
- <what works, what is deployed, what is half done>

## Notes for the next session
- <gotchas, environment quirks, anything not obvious from the code>

Never write credentials, tokens, keys, passwords or personal data here.
`;
}

// The convention files an EXISTING project gains on first use: the task
// writer creates each one only when its path does not exist yet and never
// overwrites it. state/work.md and state/handoff.md are deliberately absent —
// an existing project may already keep its own versions of those.
export function conventionFilesIfAbsent(project) {
  return [
    { path: 'AGENTS.md', content: agentsMd(project) },
    { path: `${TASKS_DIR}/README.md`, content: tasksReadmeMd() },
  ];
}
