// Mock2 COPILOT harness profile (pure decision layer). Native-free, unit-tested
// stub-first (risk R9): imports only the pure runner-logic module. This is the
// native JS port of the reference harness bundle's DESIGN (tools.ts,
// system-prompt.ts, agent-loop.ts) onto ProxyPilot's existing container/cycle
// machinery — it does NOT reimplement the loop. runner.runCycle drives the same
// fenced-container build cycle (events, gates, finish/deploy, breakers, prompt
// caching, provider-neutral model client for Anthropic AND OpenAI); this profile
// only swaps the harness's "personality": the Copilot tool VOCABULARY and the
// coding-agent SYSTEM PROMPT (read → edit → verify, minimal anchored diffs).
//
// The copilot harness is the third selectable engine (project-logic HARNESSES)
// and the install-wide default (runner-logic resolveHarness).
//
// Terminology (risk R7): the product word stays "runner"; "harness" names the
// selectable engine.

import { RUNNER_TOOLS, runnerToolsForCycle, buildRunnerSystemPrompt } from './runner-logic.js';

// The Copilot file/navigation tools (ported from the bundle's tools.ts). These
// execute against the FENCED CONTAINER in runner.executeTool — same host
// round-trip the existing file tools use — never the orchestrator's own disk.
const COPILOT_FILE_TOOLS = Object.freeze([
  {
    name: 'search_workspace',
    description:
      'Search the project working tree for code by keyword or regex. Returns ranked file paths with matching line numbers and short snippets (respects .gitignore; skips build/vendor dirs). Use this to FIND the code to change before reading it — do not guess file paths.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keyword or regular expression to search for.' },
        max_results: { type: 'integer', description: 'Maximum matching lines to return. Default 20.' },
        path_glob: { type: 'string', description: 'Optional glob to restrict the search, e.g. "src/**/*.ts".' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_file',
    description:
      'Read a UTF-8 file from the project working tree, optionally a line range. PREFER ranges over whole files to save tokens. Returns line-numbered content.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path relative to the app directory.' },
        start_line: { type: 'integer', description: '1-based first line to read (optional).' },
        end_line: { type: 'integer', description: '1-based last line to read (optional).' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_dir',
    description: 'List a directory in the project working tree (non-recursive by default).',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path relative to the app directory ("." for the root).' },
        recursive: { type: 'boolean', description: 'List the whole subtree instead of one level. Default false.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_file',
    description:
      'Create a NEW UTF-8 file in the project working tree. Fails if the file already exists — use apply_edit to modify an existing file. Parent directories are created.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path relative to the app directory.' },
        content: { type: 'string', description: 'The full file contents.' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'run_terminal',
    description:
      'Run a non-interactive shell command in the project container (already network-fenced: egress only via the squid proxy). Subject to a safety denylist (no rm -rf /, git push, curl/wget, sudo, disk ops) — a blocked command returns DENIED. Returns combined stdout/stderr and the exit code, with secret-shaped strings redacted.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to run in the container working directory.' },
        cwd: { type: 'string', description: 'Optional working directory relative to the app dir.' },
        timeout_s: { type: 'integer', description: 'Timeout in seconds. Default 120.' },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_diagnostics',
    description:
      'Return compile/type errors for the project (a scoped TypeScript typecheck of the working tree). Run this AFTER an edit to verify it, then fix any errors before finishing. Optionally scope to a path; otherwise it reports the whole app.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Optional path to scope the diagnostics to.' },
      },
      additionalProperties: false,
    },
  },
]);

// The names the copilot profile supplies itself; the rest (apply_edit, control
// and component tools) are reused verbatim from RUNNER_TOOLS so the cycle
// machinery — finish/deploy, halt, gates, authorization — is byte-identical.
const COPILOT_OWN_NAMES = new Set(COPILOT_FILE_TOOLS.map((t) => t.name));
// Tools from the shared runner set the copilot harness does NOT expose:
//   exec_in_container → replaced by run_terminal (adds the command denylist)
//   write_file        → replaced by create_file (new) + apply_edit (existing)
const COPILOT_DROP = new Set(['exec_in_container', 'write_file', 'read_file']);

// The full copilot tool set: the Copilot file/nav tools, then apply_edit and the
// control/component tools carried over from RUNNER_TOOLS (in their original
// order). apply_edit is shared verbatim — the anchored-edit primitive is the
// same one the proxypilot harness uses.
export const COPILOT_TOOLS = Object.freeze([
  ...COPILOT_FILE_TOOLS,
  ...RUNNER_TOOLS.filter((t) => !COPILOT_OWN_NAMES.has(t.name) && !COPILOT_DROP.has(t.name)),
]);

export const COPILOT_TOOL_NAMES = Object.freeze(COPILOT_TOOLS.map((t) => t.name));

// The tool list for one cycle. Reuses runnerToolsForCycle's hasGates transform
// (drop run_gates + relax finish in fast modes) by applying it to the shared
// tail and re-attaching the copilot-owned file tools, so the two harnesses stay
// in lockstep on that behavior.
export function copilotToolsForCycle({ hasGates = true } = {}) {
  const sharedTail = runnerToolsForCycle({ hasGates })
    .filter((t) => !COPILOT_OWN_NAMES.has(t.name) && !COPILOT_DROP.has(t.name));
  return [...COPILOT_FILE_TOOLS, ...sharedTail];
}

// The Copilot coding-agent workflow preamble (ported from the bundle's
// system-prompt.ts, adapted to the container tool vocabulary). Prepended to the
// full runner system prompt so ALL of ProxyPilot's completion discipline (gates,
// finish/pending/halt, integration honesty, design fidelity) is preserved — only
// the editing workflow is restated in Copilot terms.
export const COPILOT_WORKFLOW_PREAMBLE = `You are ProxyPilot's coding agent working in a real repository. Use tools to inspect and change code; never answer from assumption.

Editing workflow (how to make the change):
- Understand first. Use search_workspace to find the code and read_file (with line ranges) to read the exact lines before changing them. NEVER edit a file you have not read this cycle.
- Make minimal, targeted edits with apply_edit — the smallest change that solves the task. Do NOT rewrite whole files.
- For apply_edit, old_string must be copied byte-for-byte from the file (exact indentation) with enough surrounding context (usually 3+ lines) to be unique. On NO_MATCH, re-read the file and copy the exact text; on AMBIGUOUS_MATCH, add more context or set replace_all.
- Create NEW files with create_file; modify EXISTING files with apply_edit.
- Read narrow: request line ranges, and do not re-read files or re-run searches you already have.
- After editing, VERIFY: run get_diagnostics and, when the cycle has a gate battery, run_gates — fix every error before you finish. Only run_terminal commands that are necessary (they are policy-checked).
- Stop when the task is complete and diagnostics/gates are clean. If you cannot resolve an error after a few attempts, halt and explain what remains rather than looping.

`;

// buildCopilotSystemPrompt — the Copilot workflow preamble followed by the full
// runner system prompt (constitution, components, gate/finish/integration
// discipline, design fidelity). Same signature as buildRunnerSystemPrompt so
// runCycle can call either behind the harness profile.
export function buildCopilotSystemPrompt(args = {}) {
  return COPILOT_WORKFLOW_PREAMBLE + buildRunnerSystemPrompt(args);
}

// ---- pure formatting helpers (used by runner.executeTool; tested here) ----

const MAX_WHOLE_FILE_LINES = 400;

function withLineNumbers(text, startLine = 1) {
  return String(text).split('\n').map((l, i) => `${startLine + i}\t${l}`).join('\n');
}

// formatReadRange — line-numbered file content for read_file. No range → the
// whole file, but a very large file is truncated with a note nudging the model
// to request a range (token economy, ported from the bundle). start/end are
// 1-based and clamped; end omitted means to EOF.
export function formatReadRange(content, startLine = null, endLine = null, { maxWholeFileLines = MAX_WHOLE_FILE_LINES } = {}) {
  const all = String(content ?? '').split('\n');
  const hasStart = Number.isFinite(Number(startLine)) && Number(startLine) > 0;
  const hasEnd = Number.isFinite(Number(endLine)) && Number(endLine) > 0;
  if (!hasStart && !hasEnd) {
    if (all.length > maxWholeFileLines) {
      return `NOTE: file has ${all.length} lines — showing the first ${maxWholeFileLines}. Request a line range (start_line/end_line) to save tokens.\n\n${withLineNumbers(all.slice(0, maxWholeFileLines).join('\n'), 1)}`;
    }
    return withLineNumbers(all.join('\n'), 1);
  }
  const start = hasStart ? Math.min(Number(startLine), all.length) : 1;
  const end = hasEnd ? Math.min(Number(endLine), all.length) : all.length;
  if (end < start) return `error: end_line (${end}) is before start_line (${start})`;
  return withLineNumbers(all.slice(start - 1, end).join('\n'), start);
}

// formatSearchResults — group a `file:line:snippet` grep/ripgrep stream into
// ranked per-file blocks with trimmed, capped snippets (ported from the bundle's
// search_workspace). Pure over the raw stdout so it is unit-testable.
export function formatSearchResults(stdout, { cap = 20 } = {}) {
  const lines = String(stdout ?? '').split('\n').filter(Boolean).slice(0, cap);
  if (!lines.length) return 'no matches';
  const byFile = new Map();
  for (const line of lines) {
    const m = line.match(/^(.+?):(\d+):(.*)$/);
    if (!m) continue;
    const [, file, ln, snippet] = m;
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file).push(`  ${ln}: ${snippet.trim().slice(0, 200)}`);
  }
  if (!byFile.size) return 'no matches';
  return [...byFile.entries()].map(([f, hits]) => `${f}\n${hits.join('\n')}`).join('\n\n');
}

// The harness profile runner.runCycle consumes: which tools to offer and which
// system prompt to build. The proxypilot/claude harnesses pass no profile and
// get today's behavior unchanged.
export const COPILOT_PROFILE = Object.freeze({
  name: 'copilot',
  toolsForCycle: copilotToolsForCycle,
  buildSystemPrompt: buildCopilotSystemPrompt,
});
