// Mock2 runner PURE decision layer (Phase M6, ADR-003; survey §8). Native-free,
// unit-tested stub-first (risk R9). The RUNNER is the provider-agnostic agentic
// loop that execs into a fenced M4 container, makes a targeted change, runs the
// pinned gates, and checkpoints. Everything about that loop that can be decided
// without a model API, better-sqlite3, or Incus lives here: the tool schemas the
// build_runner slot is offered, the system-prompt assembly from the PINNED
// framework content (ADR-003), and the small per-step decisions.
//
// model-client.js (the network half) and runner.js (the host/exec half) import
// these; the tests import ONLY this module.
//
// Terminology (risk R7): the AI build component is the runner; the slot that
// drives it is build_runner. Nothing here — or anywhere in M6 — is named "agent".

// The runner's tool set, as provider-neutral JSON-Schema tool definitions.
// model-client.js maps these onto each provider's tool-calling shape (Anthropic
// `tools`, OpenAI `functions`, Gemini function declarations). The runner
// EXECUTES these against the fenced container (exec/file) or the pinned gates
// (run_gates); the model only requests them.
export const RUNNER_TOOLS = Object.freeze([
  {
    name: 'exec_in_container',
    description:
      'Run a non-interactive shell command inside the project container (already network-fenced: egress only via the squid proxy). Use for inspecting the tree, running the app, etc. Returns combined stdout/stderr and the exit code.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to run in the container working directory.' },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_file',
    description: 'Read a UTF-8 file from the project working tree (relative to the app dir). Returns its contents.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path relative to the app directory, e.g. "public/index.html".' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'write_file',
    description:
      'Create or overwrite a UTF-8 file in the project working tree (relative to the app dir). Parent directories are created. This is a working-tree write — it is checkpointed by the orchestrator, not committed by you.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path relative to the app directory.' },
        content: { type: 'string', description: 'The full new file contents.' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'run_gates',
    description:
      'Run the pinned verification gate battery (copied into the container at cycle start) against the current working tree. Returns each gate name, pass/fail, and its output. Run this after making a change; the cycle only succeeds when every gate is green.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'finish',
    description:
      'Declare the targeted change complete. Only call this after run_gates reports every gate green. Provide a one-line, plain-language summary of what changed for the change record.',
    input_schema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'Human-readable "what changed", one line.' },
      },
      required: ['summary'],
      additionalProperties: false,
    },
  },
]);

export const RUNNER_TOOL_NAMES = Object.freeze(RUNNER_TOOLS.map((t) => t.name));

// Soft budget ceilings — the PRIMARY stop for a long build. A real build (every
// screen + field + action, then the whole gate battery) legitimately needs many
// model turns, so we don't fail on a turn count; instead the runner checkpoints
// its work-in-progress and PAUSES (resumable) once a cycle crosses a token or
// wall-clock budget. Each resume starts a fresh cycle continuing from the
// checkpoint, so it gets a fresh budget window. Tuned generously — a pause is a
// "this is taking a lot; continue?" checkpoint, not an error.
export const SOFT_PAUSE_TOKENS = 1_000_000;      // ~1M tokens of model spend in one run
export const SOFT_PAUSE_MS = 45 * 60 * 1000;     // ~45 minutes of wall-clock in one run

// softPauseReason — pure decision for the runner's step-boundary check. Returns
// 'budget_tokens' | 'budget_time' when this run has crossed a soft ceiling, or
// null to keep going. Unit-tested so the thresholds can't silently drift.
export function softPauseReason({
  usedTokens = 0, elapsedMs = 0, tokenLimit = SOFT_PAUSE_TOKENS, timeLimitMs = SOFT_PAUSE_MS,
} = {}) {
  if (Number(usedTokens) >= tokenLimit) return 'budget_tokens';
  if (Number(elapsedMs) >= timeLimitMs) return 'budget_time';
  return null;
}

// Hard runaway backstop — far above any real build. The soft pause above almost
// always trips first (a build burning tokens/time hits those long before this);
// this exists only so a pathological cheap-fast loop (no tool calls, tiny turns)
// still can't spin forever. A single tool result is truncated to
// MAX_TOOL_RESULT_CHARS so a huge exec output can't blow the context (R5).
export const MAX_TURNS = 300;
export const MAX_TOOL_RESULT_CHARS = 12000;

export function truncateToolResult(text) {
  const s = String(text ?? '');
  if (s.length <= MAX_TOOL_RESULT_CHARS) return s;
  return `${s.slice(0, MAX_TOOL_RESULT_CHARS)}\n…[truncated ${s.length - MAX_TOOL_RESULT_CHARS} chars]`;
}

// Parse the pinned framework's skills_json (the four skills as one JSON doc) into
// a short list the system prompt can name. Tolerant of the placeholder seed's
// shape (an object of {name: {...}} or an array of {name, description}); returns
// [{ name, description }]. Pure so the prompt assembly is unit-testable.
export function parseFrameworkSkills(skillsJson) {
  let doc;
  try { doc = JSON.parse(skillsJson || 'null'); } catch { return []; }
  if (!doc) return [];
  const out = [];
  if (Array.isArray(doc)) {
    for (const s of doc) {
      if (s && typeof s.name === 'string') out.push({ name: s.name, description: String(s.description || '') });
    }
  } else if (typeof doc === 'object') {
    for (const [k, v] of Object.entries(doc)) {
      const name = (v && typeof v.name === 'string') ? v.name : k;
      const description = (v && typeof v === 'object') ? String(v.description || v.summary || '') : String(v || '');
      out.push({ name, description });
    }
  }
  return out;
}

// buildRunnerSystemPrompt — assemble the model's system prompt server-side from
// the PINNED framework content (ADR-003 / brief §10.1: the framework is injected
// fresh from a pinned version, never travels through chat, cannot be talked out
// of). constitution is the pinned constitution_md; skills the parsed skill list;
// task the canned instruction; appDir/webPort orient the model in the container.
export function buildRunnerSystemPrompt({ constitution = '', skills = [], appDir = '/srv/app', webPort = 3000 } = {}) {
  const skillLines = skills.length
    ? skills.map((s) => `- ${s.name}${s.description ? `: ${s.description}` : ''}`).join('\n')
    : '- (no skills configured in this framework version)';
  return `You are the Mock2 build runner. You make one small, targeted change to a project's
code, verify it against a fixed gate battery, and stop. You never approve your own
work and you never release to production — a human reviewer gates production.

You are working inside a sealed, network-fenced container. The project's working
tree at ${appDir} is a TypeScript / Express / Drizzle / Zod application (the
standard scaffold): the app lives under \`src/\` (\`src/server.ts\` binds the
declared web port and mounts \`src/app.ts\`; feature modules under \`src/\` expose
routes → service → Drizzle schema; database migrations are numbered SQL files in
\`migrations/\`). How the app installs, migrates, builds and starts is DECLARED in
\`mock2.yaml\` under \`run:\` — edit that contract if you change how it runs; never
rely on the placeholder \`serve.py\` or \`public/\` (those are the pre-build front
door and are replaced by the app's own runtime once it is deployed). After your
change passes the gates, ProxyPilot deploys it (install → migrate → build → start)
so the live URL on port ${webPort} serves the real app — so make the change in the
TypeScript source, keep it type-clean, and keep the run contract in \`mock2.yaml\`
accurate. Your only egress is a filtering proxy; do not attempt to reach anything else.

# Design fidelity (binding — reproduce the approved look)
The approved design's visual language is captured in \`state/design-tokens.json\`
(colors, typography, corner radius, spacing, shadow) with a ready stylesheet
rendered from it at \`state/design.css\`. Read both. The app MUST reproduce that
look, not a generic default: make the app load that stylesheet (serve it as a
static asset and link it, or import its tokens into the app's CSS) and style every
screen with those tokens — the same colors, fonts, radii, and component styling
the mockup used. Do not invent a different visual style. If the files are absent
(an older project), fall back to a clean, consistent look.

# Organizational constitution (pinned — this is binding, not advisory)
${constitution || '(placeholder constitution — real framework content is still owed, risk R8)'}

# Available skills
${skillLines}

# How to work
1. Read the relevant files to understand the current state.
2. Make the smallest change that satisfies the requested task. Do not refactor,
   add features, or touch anything the task did not ask for.
3. Call run_gates. If any gate is red, fix the cause and run them again.
4. When every gate is green, call finish with a one-line summary. Do not call
   finish before the gates are green.

Make the change; call finish only when the gates are green.`;
}

// The first user turn: the canned task instruction. Kept a pure formatter so the
// transcript shape is testable.
export function buildRunnerTask(instruction) {
  return `Task: ${String(instruction || '').trim()}`;
}

// Classify a model turn's outcome for the loop. Given the assistant turn's tool
// calls and whether the turn produced any, decide what the runner does next.
//   - a `finish` call → the model is done (validate gates separately)
//   - other tool calls → execute them, continue
//   - no tool calls → the model stopped without finishing (nudge or fail)
// Returns { done, finishSummary, toolCalls, stalled }.
export function classifyTurn(toolCalls = []) {
  const calls = Array.isArray(toolCalls) ? toolCalls : [];
  const finishCall = calls.find((c) => c && c.name === 'finish');
  if (finishCall) {
    return { done: true, finishSummary: String(finishCall.input?.summary || 'change complete'), toolCalls: calls, stalled: false };
  }
  if (calls.length === 0) {
    return { done: false, finishSummary: null, toolCalls: [], stalled: true };
  }
  return { done: false, finishSummary: null, toolCalls: calls, stalled: false };
}

// A short, human-readable "what the runner is doing right now" line, derived from
// the tool calls a turn requested. The frontend polls this (getCycleJobStatus) so
// the Builder sees task-level progress ("Step 3 · writing public/index.html")
// instead of a static "running". Pure so it's testable.
export function describeRunnerStep(turn, toolCalls = []) {
  const calls = Array.isArray(toolCalls) ? toolCalls : [];
  const parts = calls.map((c) => {
    if (c?.name === 'write_file') return `writing ${c.input?.path || 'a file'}`;
    if (c?.name === 'read_file') return `reading ${c.input?.path || 'a file'}`;
    if (c?.name === 'exec_in_container') return `running \`${String(c.input?.command || '').replace(/\s+/g, ' ').trim().slice(0, 60)}\``;
    if (c?.name === 'run_gates') return 'running the gate battery';
    if (c?.name === 'finish') return 'wrapping up';
    return c?.name || 'working';
  });
  const what = parts.length ? parts.join(', ') : 'thinking through the next step';
  return `Step ${Number(turn) + 1} · ${what}`;
}

// The nudge appended when a turn stalls (no tool calls) so the model resumes
// instead of ending the turn early.
export const STALL_NUDGE =
  'You did not call a tool. Continue: inspect or edit files, run the gates, and call finish only when every gate is green.';
