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

import { parseHaltOptions, HALT_OPTION_KINDS } from './unblock-logic.js';
import { buildComponentCatalogSection } from './component-logic.js';

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
    name: 'get_component',
    description:
      'Fetch a component from the installation\'s component library: its full source files and integration notes. The available components are listed in your system prompt under "Component library" — when the task overlaps one, fetch it and REUSE its code (copy the files into the app source, adapt only the glue) instead of writing your own implementation.',
    input_schema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'The component key from the catalog, e.g. "ldaps-auth".' },
      },
      required: ['key'],
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
      'Declare the targeted change complete AND WORKING. Only call this after run_gates reports every gate green. finish records the cycle as SUCCEEDED and deploys it — never call it for blocked, partial, or not-actually-working work. Provide a one-line, plain-language summary of what changed for the change record.',
    input_schema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'Human-readable "what changed", one line.' },
      },
      required: ['summary'],
      additionalProperties: false,
    },
  },
  {
    name: 'halt',
    description:
      'End the cycle WITHOUT success because you cannot honestly complete the change — you are blocked, a dependency is missing, or the fix needed is out of scope. This is the ONLY honest way to stop short of finishing: it records the cycle as blocked (needs human attention), does NOT deploy, and is resumable once the blocker is cleared. Give the specific reason (what blocks you), and ALWAYS propose 2–4 concrete `options` — the viable paths forward, each with its tradeoff and exactly what will be fed back to you on resume. Never a bare refusal: the operator picks one option (or an admin grants an authorization option) and it resumes the build. Never keep responding without calling a tool when you are stuck — call halt instead.',
    input_schema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Why you cannot complete the change, in plain language.' },
        options: {
          type: 'array',
          minItems: 2,
          maxItems: 4,
          description:
            'REQUIRED — the 2–4 viable paths a human could take to unblock you, specific and mutually distinct. The operator picks one; mark at most one recommended. Example: [{"label":"Grant the one-row DELETE","kind":"grant_authorization","risk":"deletes 1 stale test row from the live DB","recommended":true,"injectOnResume":"You are authorized to run the DELETE below, once.","authorization":{"scope":"DELETE FROM users WHERE email = \'seed@test\'","expectedRows":1}},{"label":"Run the framework-isolation cycle first, then resume","kind":"run_dependency_first","risk":"slower; needs a separate build","injectOnResume":"The isolation cycle has run; the seed row is gone — proceed."},{"label":"Abandon this change","kind":"abandon","risk":"no change is made"}].',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: 'Short choice label.' },
              kind: {
                type: 'string',
                enum: HALT_OPTION_KINDS,
                description: 'The type of resolution: grant_authorization | expand_scope | run_dependency_first | override_rule (admin) | abandon.',
              },
              risk: { type: 'string', description: 'One-line tradeoff / risk of choosing this.' },
              recommended: { type: 'boolean', description: 'Mark AT MOST ONE option recommended.' },
              injectOnResume: { type: 'string', description: 'Exactly what will be fed back to you (as authoritative operator guidance) if this option is chosen.' },
              authorization: {
                type: 'object',
                description: 'REQUIRED for kind grant_authorization / override_rule: the exact, narrowest privileged operation to authorize.',
                properties: {
                  scope: { type: 'string', description: 'The exact operation (e.g. a specific SQL statement).' },
                  expectedRows: { type: ['integer', 'string'], description: 'How many rows/objects the operation should affect (e.g. 1).' },
                },
                required: ['scope'],
                additionalProperties: false,
              },
            },
            required: ['label', 'kind'],
            additionalProperties: false,
          },
        },
      },
      required: ['reason', 'options'],
      additionalProperties: false,
    },
  },
  {
    name: 'request_authorization',
    description:
      'Request a SCOPED, ONE-TIME operational authorization to perform a single privileged act that the constitution/gates otherwise forbid, when it is genuinely required to unblock the change (e.g. deleting a specific stale test-artifact row from the live database). State the EXACT scope (the precise statement or operation, as narrow as possible) and why it is needed. This ends the cycle awaiting an administrator, like a blocking question: an admin grants or denies it, and on resume a granted authorization is handed back to you for single use. Do NOT use this to bypass the constitution generally — only for a narrow, necessary, one-time operation.',
    input_schema: {
      type: 'object',
      properties: {
        scope: { type: 'string', description: 'The exact, narrowest operation you need authorized (e.g. a specific SQL statement).' },
        reason: { type: 'string', description: 'Why this one-time operation is necessary to unblock the change.' },
      },
      required: ['scope'],
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
export function buildRunnerSystemPrompt({ constitution = '', skills = [], appDir = '/srv/app', webPort = 3000, components = [] } = {}) {
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

# Administrator-approved exceptions (override the constitution for THIS project)
Your task may contain a section headed "Administrator decisions on framework
deviations". Those are AUTHORITATIVE: an administrator has explicitly signed off
on them for this project. An APPROVED item OVERRIDES the pinned constitution and
you MUST implement it exactly as requested — build the login page, auth flow, or
whatever was approved, even though the constitution would otherwise forbid it. A
DENIED item must NOT be built. When an approved exception conflicts with the
constitution, the approved exception WINS. Do not refuse or silently skip an
approved exception; implementing it is the required work for this build.

# Available skills
${skillLines}${buildComponentCatalogSection(components, { access: 'tool' })}

# How to work
1. Read the relevant files to understand the current state.
2. Make the smallest change that satisfies the requested task. Do not refactor,
   add features, or touch anything the task did not ask for.
3. Call run_gates. If any gate is red, fix the cause and run them again.
4. When every gate is green, call finish with a one-line summary. Do not call
   finish before the gates are green.

# If you cannot honestly finish
If you cannot complete the change — you are blocked, a dependency is missing, the
gate can't pass for a reason outside this change, or the real fix is out of scope —
call halt(reason, options) with the specific blocker. halt is a real terminating
action: it ends the cycle as blocked (a human is notified) without recording success
and without deploying.

When you halt, ALWAYS propose the 2–4 viable paths forward with their tradeoffs —
never a bare refusal. Each option needs a short label, a typed kind
(grant_authorization | expand_scope | run_dependency_first | override_rule (admin) |
abandon), a one-line risk/tradeoff, and exactly what to inject on resume if it is
chosen; mark at most one recommended. The operator picks ONE and it is fed back to
you on resume as authoritative guidance. If a narrow, one-time privileged operation
the constitution forbids (e.g. deleting a specific stale test-artifact row) is a
viable path, offer it as a grant_authorization option carrying the EXACT scope (the
precise SQL/operation) and the expected row count — an admin grants that exact act
for single use by picking it, and it is handed back to you on resume. (The standalone
request_authorization tool still exists for a lone grant, but prefer halt with a
grant_authorization option among the alternatives so the operator sees every path at
once.) Do NOT keep replying without calling a tool, and do NOT repeat the same
explanation turn after turn — that makes
no progress and wastes the budget. Every turn must either make progress (a tool call
that changes or checks the code), call finish (gates green), call halt (blocked), or
request_authorization (need a one-time grant). If you are stuck, halt.

On a RESUME you may receive an "Operator guidance on resume" turn (a human's message,
a chosen resolution option, and/or an "Authorized one-time operations" grant). Treat
it as authoritative direction and act on it — a granted authorization permits EXACTLY
its stated scope, once.

Make the change; call finish only when the gates are green, or halt if you are blocked.`;
}

// The first user turn: the canned task instruction. Kept a pure formatter so the
// transcript shape is testable.
export function buildRunnerTask(instruction) {
  return `Task: ${String(instruction || '').trim()}`;
}

// Classify a model turn's outcome for the loop. Given the assistant turn's tool
// calls and whether the turn produced any, decide what the runner does next.
//   - a `halt` call → the model cannot honestly finish (blocked); end non-success
//   - a `finish` call → the model is done (validate gates separately)
//   - other tool calls → execute them, continue
//   - no tool calls → the model stopped without finishing (nudge or fail)
// halt takes precedence over finish: a turn that pairs both is a blocked turn (the
// model should not both give up and claim success). Returns
// { done, halted, haltReason, finishSummary, toolCalls, stalled }.
export function classifyTurn(toolCalls = [], { stopReason = null } = {}) {
  const calls = Array.isArray(toolCalls) ? toolCalls : [];
  const base = { done: false, halted: false, haltReason: null, haltOptions: [], authRequest: null, finishSummary: null, toolCalls: calls, stalled: false, refusal: false, trigger: null };
  // Fable 5 (audit lane / consult) can return stop_reason "refusal" from its safety
  // classifiers — a shape Opus 4.8 never produces. Map it to the existing halt state
  // (needs-attention, resumable) with the refusal as the reason — NEVER a crash or a
  // retry loop, and NEVER the "propose options" nudge (a refusing model won't). Checked
  // first so it wins over an empty-turn "stalled" classification.
  if (isRefusalStop(stopReason)) {
    return { ...base, refusal: true, haltReason: REFUSAL_HALT_REASON, trigger: 'model_refusal' };
  }
  // A request for a scoped one-time authorization ends the cycle awaiting an admin
  // (it wants to CONTINUE after a grant, so it's checked before halt).
  const authCall = calls.find((c) => c && c.name === 'request_authorization');
  if (authCall) {
    return { ...base, authRequest: { scope: String(authCall.input?.scope || '').trim(), reason: String(authCall.input?.reason || '').trim() } };
  }
  const haltCall = calls.find((c) => c && c.name === 'halt');
  if (haltCall) {
    return { ...base, halted: true, haltReason: String(haltCall.input?.reason || 'blocked — no reason given'), haltOptions: parseHaltOptions(haltCall.input?.options) };
  }
  const finishCall = calls.find((c) => c && c.name === 'finish');
  if (finishCall) {
    return { ...base, done: true, finishSummary: String(finishCall.input?.summary || 'change complete') };
  }
  if (calls.length === 0) {
    return { ...base, stalled: true, toolCalls: [] };
  }
  return base;
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
    if (c?.name === 'get_component') return `fetching component ${c.input?.key || ''}`.trim();
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
  'You did not call a tool. Every turn must make progress (a tool call), call finish (gates green), or call halt(reason) if you are blocked. Do not reply again without calling a tool.';

// ---- no-progress circuit breaker (harness safety, both runners) ----
//
// A build cycle must never run without making progress. The ADP repro looped 118
// near-identical refusals because the model correctly refused to `finish` blocked
// work but the loop treated a no-tool-call turn as "keep going". This breaker
// detects a stuck cycle cheaply and auto-terminates it as blocked (halt), instead
// of re-prompting forever and burning tokens.
//
// Threshold is a small single digit (default 3), configurable via
// BUILD_NO_PROGRESS_LIMIT. It trips on ANY of three signals, each a reliable
// "stuck" indicator that a healthy build never sustains for N turns in a row:
//   - no_tool_calls   : N consecutive assistant turns with no tool call.
//   - repeated_output : N consecutive near-identical assistant messages that also
//                       made no new action (the 118 refusals were near-verbatim).
//   - no_state_change : N consecutive turns with no file edit and no NEW tool call
//                       (same action, or none — the model is spinning).
// A turn that makes a real move (a write, or a tool call different from the last)
// resets every counter, so legitimate multi-step work is never tripped.
export const NO_PROGRESS_LIMIT = 3;

// Read the configured breaker threshold (clamped ≥2 so it can never trip on a
// single turn). Pure given its env argument.
export function noProgressLimit(env = {}) {
  const n = parseInt(env.BUILD_NO_PROGRESS_LIMIT, 10);
  return Number.isFinite(n) && n >= 2 ? n : NO_PROGRESS_LIMIT;
}

// A cheap, stable signature of an assistant message for near-identical detection:
// lowercased, whitespace-collapsed, truncated. The refusals differed only in
// incidental whitespace, so a truncated normalized signature matches them.
export function progressSignature(text) {
  return String(text || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 500);
}

// A stable signature of a turn's tool calls (name + input), so "same action again"
// is detectable. Empty string when the turn made no tool call.
export function toolCallSignature(toolCalls = []) {
  const calls = Array.isArray(toolCalls) ? toolCalls : [];
  if (!calls.length) return '';
  return calls
    .map((c) => `${c?.name || ''}:${stableInput(c?.input)}`)
    .join('|')
    .slice(0, 1000);
}
function stableInput(input) {
  if (input == null || typeof input !== 'object') return String(input ?? '');
  try { return JSON.stringify(input, Object.keys(input).sort()); } catch { return ''; }
}

export function initProgressState() {
  return { noToolTurns: 0, staleTurns: 0, repeatCount: 0, lastMsgSig: null, lastToolSig: null };
}

// updateProgress — fold one assistant turn into the breaker state and decide
// whether the cycle is stuck. Pure: returns { state, tripped, trigger }. The
// caller halts the cycle when tripped, recording `trigger` as the halt_reason.
export function updateProgress(state, { toolCalls = [], text = '' } = {}, limit = NO_PROGRESS_LIMIT) {
  const s = { ...initProgressState(), ...(state || {}) };
  const calls = Array.isArray(toolCalls) ? toolCalls : [];
  const hadTool = calls.length > 0;
  const hadWrite = calls.some((c) => c?.name === 'write_file' || c?.name === 'Write' || c?.name === 'Edit');
  const toolSig = toolCallSignature(calls);
  const msgSig = progressSignature(text);

  // A real move: a file edit, or a tool call different from the previous turn's.
  const newAction = hadWrite || (!!toolSig && toolSig !== s.lastToolSig);

  s.noToolTurns = hadTool ? 0 : s.noToolTurns + 1;
  s.staleTurns = newAction ? 0 : s.staleTurns + 1;
  // Repeated output only counts when the turn ALSO made no new action — so a model
  // that keeps a stock preamble but is genuinely working is never tripped.
  if (msgSig && msgSig === s.lastMsgSig && !newAction) s.repeatCount += 1;
  else s.repeatCount = 0;

  s.lastToolSig = toolSig || s.lastToolSig;
  s.lastMsgSig = msgSig || s.lastMsgSig;

  let trigger = null;
  if (s.noToolTurns >= limit) trigger = 'no_tool_calls';
  else if (s.repeatCount >= limit) trigger = 'repeated_output';
  else if (s.staleTurns >= limit) trigger = 'no_state_change';

  return { state: s, tripped: !!trigger, trigger };
}

// Human-readable one-liner for a breaker trip / halt reason.
export function haltReasonLabel(reason) {
  switch (reason) {
    case 'model_halt': return 'the build reported it was blocked';
    case 'model_refusal': return 'the model declined to continue (safety refusal)';
    case 'no_tool_calls': return 'no progress — repeated turns with no action';
    case 'repeated_output': return 'no progress — the same response repeated without changes';
    case 'no_state_change': return 'no progress — repeated the same action with no change';
    case 'max_turns': return 'reached the step ceiling without finishing';
    default: return String(reason || 'blocked');
  }
}

// A model turn that ended in a safety refusal (Fable 5's classifier can emit
// stop_reason "refusal"; Opus 4.8 never does). Pure so both runners test it identically.
export function isRefusalStop(stopReason) {
  return String(stopReason || '').trim().toLowerCase() === 'refusal';
}

// The halt reason surfaced when a turn is a refusal — a needs-attention, resumable halt.
export const REFUSAL_HALT_REASON =
  'The model declined to continue (a safety refusal). A human should review and redirect it; your work so far is checkpointed and this is resumable.';

// ---- Claude Agent SDK runner (Phase 1, docs/agent-sdk-migration.md) ----

// buildRunnerMode — which build runner drives a cycle. Pure so it's testable and
// so the flag has ONE authoritative reading. 'sdk' selects the Claude Agent SDK
// runner (runner-sdk.js); anything else (unset / any other value) keeps the
// hand-rolled loop (runner.js runCycle) — the default, byte-for-byte unchanged.
// The flag is deliberately opt-in: an install that never sets BUILD_RUNNER behaves
// exactly as it did before this migration existed.
export function buildRunnerMode(env = {}) {
  return String(env.BUILD_RUNNER || '').trim().toLowerCase() === 'sdk' ? 'sdk' : 'handrolled';
}

// The built-in Claude Agent SDK tools the build runner is allowed to use. These
// replace the hand-rolled RUNNER_TOOLS: the SDK executes them itself against its
// working directory (the local checkout), so we don't implement tool execution.
// Deliberately the read/inspect/edit/run set — no network tools (the constitution
// and gate battery, not an allowlist here, govern what the change may contain).
export const SDK_ALLOWED_TOOLS = Object.freeze(['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob']);

// buildRunnerClaudeMd — render the SAME governance content the hand-rolled system
// prompt injects (buildRunnerSystemPrompt), but as a CLAUDE.md document that the
// Agent SDK auto-loads from the working directory (settingSources: ['project']).
// This is the Phase-1 proof that the constitution is SOURCED FROM CONTEXT, not
// re-explored: it travels as pinned framework content into a file the SDK reads on
// its own. Pure so the mapping is unit-testable and can't silently drift from the
// system-prompt version. `task` is passed to the SDK as the prompt, so it is NOT
// duplicated here; the administrator-decisions block (when present) rides on the
// task like it does today.
export function buildRunnerClaudeMd({ constitution = '', skills = [], appDir = '/srv/app', webPort = 3000, components = [] } = {}) {
  const skillLines = skills.length
    ? skills.map((s) => `- ${s.name}${s.description ? `: ${s.description}` : ''}`).join('\n')
    : '- (no skills configured in this framework version)';
  return `# Mock2 build runner — project constitution & working rules

You are the Mock2 build runner. You make one small, targeted change to this project's
code, verify it against a fixed gate battery, and stop. You never approve your own
work and you never release to production — a human reviewer gates production.

The project working tree here is a TypeScript / Express / Drizzle / Zod application
(the standard scaffold): the app lives under \`src/\` (\`src/server.ts\` binds the
declared web port and mounts \`src/app.ts\`; feature modules under \`src/\` expose
routes → service → Drizzle schema; database migrations are numbered SQL files in
\`migrations/\`). How the app installs, migrates, builds and starts is DECLARED in
\`mock2.yaml\` under \`run:\` — edit that contract if you change how it runs; never
rely on the placeholder \`serve.py\` or \`public/\` (those are the pre-build front
door and are replaced by the app's own runtime once it is deployed). After your
change passes the gates, ProxyPilot deploys it (install → migrate → build → start)
so the live URL on port ${webPort} serves the real app — so make the change in the
TypeScript source, keep it type-clean, and keep the run contract in \`mock2.yaml\`
accurate.

## Design fidelity (binding — reproduce the approved look)
The approved design's visual language is captured in \`state/design-tokens.json\`
(colors, typography, corner radius, spacing, shadow) with a ready stylesheet
rendered from it at \`state/design.css\`. Read both. The app MUST reproduce that
look, not a generic default: make the app load that stylesheet (serve it as a
static asset and link it, or import its tokens into the app's CSS) and style every
screen with those tokens — the same colors, fonts, radii, and component styling
the mockup used. Do not invent a different visual style. If the files are absent
(an older project), fall back to a clean, consistent look.

## Organizational constitution (pinned — this is binding, not advisory)
${constitution || '(placeholder constitution — real framework content is still owed, risk R8)'}

## Administrator-approved exceptions (override the constitution for THIS project)
Your task may contain a section headed "Administrator decisions on framework
deviations". Those are AUTHORITATIVE: an administrator has explicitly signed off
on them for this project. An APPROVED item OVERRIDES the pinned constitution and
you MUST implement it exactly as requested — build the login page, auth flow, or
whatever was approved, even though the constitution would otherwise forbid it. A
DENIED item must NOT be built. When an approved exception conflicts with the
constitution, the approved exception WINS. Do not refuse or silently skip an
approved exception; implementing it is the required work for this build.

## Available skills
${skillLines}${buildComponentCatalogSection(components, { access: 'files', dir: '.claude/components' }).replace(/^# /m, '## ')}

## How to work
1. Read the relevant files to understand the current state.
2. Make the smallest change that satisfies the requested task. Do not refactor,
   add features, or touch anything the task did not ask for.
3. Keep the TypeScript source type-clean and keep \`mock2.yaml\`'s run contract
   accurate. ProxyPilot runs the pinned verification gate battery for you after you
   finish — you do not run or approve the gates yourself.
4. When the change is complete, stop. Report a one-line, plain-language summary of
   what changed for the change record.

## If you cannot honestly finish
If you are blocked — a missing dependency, a gate that can't pass for a reason
outside this change, or a fix that is out of scope — say so clearly and stop; do NOT
repeat the same explanation over and over without making an edit. Completing the
change means finishing working code; a build that cannot honestly be completed is a
blocked build for a human to resolve, not a success.

The working directory (${appDir}) is a local checkout; your edits are synced back and
checkpointed by ProxyPilot, not committed by you.`;
}
