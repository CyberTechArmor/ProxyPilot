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
import { buildComponentCatalogSection, buildInstalledComponentsSection } from './component-logic.js';
import { normalizeHarness } from './project-logic.js';
import { MODEL_PRIMARY } from './models.js';

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
    name: 'apply_edit',
    description:
      'Make targeted edits to an EXISTING file by exact, anchored string replacement — NOT a whole-file rewrite. This is the preferred way to change a file you have already read: cheaper and safer than write_file. Each edit replaces old_string with new_string. old_string must be copied byte-for-byte from the file (exact whitespace and indentation) and must include enough surrounding context — usually 3+ lines — to match EXACTLY ONCE in the file. Errors are returned, not thrown, so you can fix and retry: NO_MATCH (old_string not found — re-read and copy the exact text; a hint of the nearest lines is included), AMBIGUOUS_MATCH (matched more than once — add more context or set replace_all:true), FILE_NOT_FOUND. The batch is all-or-nothing: if any edit fails, the file is left unchanged. On success you get a unified diff of exactly what changed.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path relative to the app directory of the existing file to edit.' },
        edits: {
          type: 'array',
          minItems: 1,
          description: 'One or more replacements, applied in order. All must succeed or none are written.',
          items: {
            type: 'object',
            properties: {
              old_string: { type: 'string', description: 'Exact text to find, copied verbatim from the file (including indentation). Include 3+ lines of surrounding context so it is unique.' },
              new_string: { type: 'string', description: 'Text to replace it with.' },
              replace_all: { type: 'boolean', description: 'Replace every occurrence instead of requiring a single unique match. Default false.' },
            },
            required: ['old_string', 'new_string'],
            additionalProperties: false,
          },
        },
      },
      required: ['path', 'edits'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_component',
    description:
      'Inspect a component from the installation\'s component library: its integration notes plus its sources (inline when small; larger components return a path/size/sha256 file MANIFEST instead — their contents are delivered whole by materialize_component, never through this tool). The available components are listed in your system prompt under "Component library" — when the task overlaps one, REUSE it instead of writing your own implementation.',
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
    name: 'materialize_component',
    description:
      'Adopt a component: the platform writes every file of the published component verbatim into the app source tree server-side (byte-exact at any size — contents never pass through your context) and returns a manifest of what landed (path, bytes, sha256, per-file status). Files that already exist are kept untouched and reported unless overwrite is true. Afterwards read/adapt the real files with your read/edit tools and wire the glue per the integration notes.',
    input_schema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'The component key from the catalog, e.g. "ldaps-auth".' },
        overwrite: { type: 'boolean', description: 'Replace files that already exist at the component\'s paths. Default false: existing files are kept and reported.' },
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
      'Declare the targeted change complete AND WORKING. Only call this after run_gates reports every gate green. finish records the cycle as SUCCEEDED and deploys it — never call it for blocked, partial, or not-actually-working work. Provide a one-line, plain-language summary, the human-runnable acceptance check(s), and your verified-vs-assumed cross-layer assumption list — all three land in the change record. SPECIAL CASE — work already done: if your investigation shows the requested change is ALREADY fully present in the tree (common on a resumed request whose work a prior cycle completed), finish is still the right call: state explicitly in the summary that you verified it already implemented and changed nothing (e.g. "Verified all requested fixes already implemented — no code changes needed"), and give acceptance checks for the EXISTING behavior. Do NOT halt for "already done" — halt is for blockers.',
    input_schema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'Human-readable "what changed", one line.' },
        acceptance: {
          type: 'array',
          minItems: 1,
          items: { type: 'string' },
          description: 'Human-runnable acceptance check(s), ONE PER USER-VISIBLE CHANGE, each in "as <role>, do X, expect Y" form (e.g. "as admin, open Connection Settings, type into Client ID — the value persists and Test connection is clickable"). For a change with no user-visible surface, one entry describing the verification actually performed.',
        },
        acceptance_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'MACHINE-EXECUTED acceptance: for each user-visible happy path above, ADD a matching interaction check to state/ui-checks.json (page + steps: expect_visible / expect_text / click / fill / expect_enabled) and list its id here. These ids are run against the DEPLOYED app right after deploy — an id with no defined check is a hard smoke failure, so define the check first. Acceptance that exists only as prose is never executed by a machine; give at least the happy path an id.',
        },
        removals: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              what: { type: 'string', description: 'The thing you removed, in the same words as the summary (e.g. "the To-dos inner scrollbar").' },
              check_id: { type: 'string', description: 'The id of a check in state/ui-checks.json that FAILS while that thing is still present.' },
            },
            required: ['what', 'check_id'],
            additionalProperties: false,
          },
          description: 'REQUIRED when the summary says you removed, hid, dropped or deleted something a user can SEE. For each one, add a step to state/ui-checks.json that would fail if it were still there — { "expect_absent": "#delete-note" } for an element, { "expect_no_scroll": "#panel-todos" } for a scrollbar, { "expect_text": … } for wording — and name that check here. These ids are run against the DEPLOYED app, so an untrue claim comes back red. Code-only removals (a dead helper, an unused import, a file) need no entry. If you cannot write a check that could fail, say what you actually did instead of claiming a removal.',
        },
        assumptions: {
          type: 'object',
          description: 'Cross-layer assumptions behind this change, split HONESTLY: verified = values you READ the authoritative source for THIS cycle (name the file, e.g. "src/routes/profile.ts returns lowercase role slugs"); assumed = values you relied on without reading. A permission or role-name value in `assumed` is a defect — verify it before finishing. Use empty arrays only when genuinely none exist.',
          properties: {
            verified: { type: 'array', items: { type: 'string' }, description: 'Assumptions verified against source this cycle, each naming the file read.' },
            assumed: { type: 'array', items: { type: 'string' }, description: 'Assumptions NOT verified against source (should be empty for permission/role values).' },
          },
          required: ['verified', 'assumed'],
          additionalProperties: false,
        },
      },
      required: ['summary', 'acceptance', 'assumptions'],
      additionalProperties: false,
    },
  },
  {
    name: 'pending_verification',
    description:
      'Conclude the cycle as PENDING-OPERATOR-VERIFICATION — a calm, expected completion, NOT a block. Use this INSTEAD of finish when all in-fence gates are green and the code is real and complete, but one or more declared integrations require a LIVE external check that cannot run inside the sealed fence (it needs a human with production credentials/network to the real endpoint) — e.g. an ADP Test Connection or an LDAPS bind against the production directory. This is the correct end state for exactly that situation: it deploys the built app (so the operator can verify it) and records the cycle as pending-operator-verification with the outstanding live checks listed, WITHOUT falsely claiming succeeded and WITHOUT raising a blocker. The integration gate still runs first: if it finds a stub, canned success, or fabricated data, this becomes a block — pending-verification is ONLY for real, implemented integrations. Provide the same summary + acceptance + assumptions as finish. Do NOT ask to inject production credentials or open fence egress to verify in-cycle — that is a separate, rare admin action, never part of a normal completion.',
    input_schema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'Human-readable "what changed", one line.' },
        acceptance: {
          type: 'array',
          minItems: 1,
          items: { type: 'string' },
          description: 'Human-runnable acceptance check(s), one per user-visible change, in "as <role>, do X, expect Y" form (as for finish).',
        },
        assumptions: {
          type: 'object',
          description: 'Cross-layer assumptions, split honestly into verified (read the source this cycle — name the file) vs assumed (as for finish).',
          properties: {
            verified: { type: 'array', items: { type: 'string' } },
            assumed: { type: 'array', items: { type: 'string' } },
          },
          required: ['verified', 'assumed'],
          additionalProperties: false,
        },
      },
      required: ['summary', 'acceptance', 'assumptions'],
      additionalProperties: false,
    },
  },
  {
    name: 'halt',
    description:
      'End the cycle WITHOUT success because you cannot honestly complete the change — you are blocked, a dependency is missing, or the fix needed is out of scope. This is the ONLY honest way to stop short of finishing: it records the cycle as blocked (needs human attention), does NOT deploy, and is resumable once the blocker is cleared. Note: a build that is complete and real but awaits a LIVE external verification the fence cannot run is NOT a block — use pending_verification for that, not halt. Also NOT a block: discovering the requested work is ALREADY implemented in the tree — verify it against source and call finish with a verification-only summary ("already implemented — no code changes needed") instead; halting for "already done" strands finished work behind a blocker. Give the specific reason (what blocks you), and ALWAYS propose 2–4 concrete `options` — the viable paths forward, each with its tradeoff and exactly what will be fed back to you on resume. Never a bare refusal: the operator picks one option (or an admin grants an authorization option) and it resumes the build. Never keep responding without calling a tool when you are stuck — call halt instead.',
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

// ---- parallel-safe tool execution (efficiency, never behavior) ----

// Tools that only OBSERVE the working tree — no writes, no shell, no control
// flow. When the model emits several of these in one turn they can run
// concurrently: the results are identical either way (nothing they touch can be
// mutated by a sibling), and the transcript still records them in the model's
// original order. Names span both harness vocabularies (proxypilot + copilot).
//
// Deliberately EXCLUDED, and why:
//   write_file / create_file / apply_edit / materialize_component — mutate files
//   exec_in_container / run_terminal                              — arbitrary shell
//   run_gates                                                     — runs scripts, writes reports
//   finish / halt / pending_verification / request_authorization  — control flow
export const READ_ONLY_TOOLS = Object.freeze([
  'read_file', 'list_dir', 'search_workspace', 'get_diagnostics', 'get_component',
]);
const READ_ONLY_SET = new Set(READ_ONLY_TOOLS);

export function isReadOnlyTool(name) {
  return READ_ONLY_SET.has(String(name || ''));
}

// groupToolCallsForExecution — split one turn's tool calls into ordered groups.
// A run of CONSECUTIVE read-only calls becomes one { parallel: true } group the
// caller may execute with Promise.all; every other call is its own serial group.
// Order is preserved exactly, so a write never overtakes a read (or vice versa)
// and the transcript is byte-identical to the serial path. PURE.
export function groupToolCallsForExecution(calls = []) {
  const groups = [];
  for (const call of calls) {
    const ro = isReadOnlyTool(call?.name);
    const last = groups[groups.length - 1];
    if (ro && last && last.parallel) last.calls.push(call);
    else groups.push({ parallel: ro, calls: [call] });
  }
  return groups;
}

// The tool list for ONE cycle. Fast modes (quick/MVP) run NO gate battery, so
// the run_gates tool is REMOVED — not stubbed: a present-but-empty battery
// returns "pending" with no entries, and a discipline-following model loops on
// it forever ("I cannot honestly call finish"), which is exactly the Test5
// block. finish's contract likewise drops the every-gate-green precondition.
export function runnerToolsForCycle({ hasGates = true } = {}) {
  if (hasGates) return RUNNER_TOOLS;
  return RUNNER_TOOLS
    .filter((t) => t.name !== 'run_gates')
    .map((t) => (t.name === 'finish'
      ? {
        ...t,
        description:
          'Declare the targeted change complete AND WORKING. This build mode runs NO gate battery — verify the change yourself as you work, then call finish; ProxyPilot\'s deploy (tsc build + health check) is the platform backstop. finish records the cycle and deploys it — never call it for blocked, partial, or not-actually-working work. Provide a one-line, plain-language summary, the human-runnable acceptance check(s), and your verified-vs-assumed cross-layer assumption list — all three land in the change record.',
      }
      : t));
}

// Soft budget ceilings — the PRIMARY stop for a long build. A real build (every
// screen + field + action, then the whole gate battery) legitimately needs many
// model turns, so we don't fail on a turn count; instead the runner checkpoints
// its work-in-progress and PAUSES (resumable) once a cycle crosses a token or
// wall-clock budget. Each resume starts a fresh cycle continuing from the
// checkpoint, so it gets a fresh budget window. Tuned generously — a pause is a
// "this is taking a lot; continue?" checkpoint, not an error.
// Both ceilings are operator-tunable via env (MOCK2_SOFT_PAUSE_TOKENS /
// MOCK2_SOFT_PAUSE_MINUTES) — these are SPEND guards, not context caps; a
// pause is always resumable in one click with the work checkpointed.
const envNum = (name, fallback) => {
  const n = Number(process.env?.[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
export const SOFT_PAUSE_TOKENS = envNum('MOCK2_SOFT_PAUSE_TOKENS', 1_000_000); // ~1M tokens of model spend in one run
export const SOFT_PAUSE_MS = envNum('MOCK2_SOFT_PAUSE_MINUTES', 45) * 60 * 1000; // wall-clock in one run

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
// still can't spin forever.
export const MAX_TURNS = 300;
// Per-tool-result truncation. 12k proved far too tight — reading one large
// source file truncated mid-function, forcing re-reads in chunks. With 1M-token
// context windows and prompt caching, 200k chars (~50k tokens) fits comfortably;
// the cap now exists only so a pathological dump (a binary cat, a megaline log)
// can't blow the context in one turn. Override via MOCK2_MAX_TOOL_RESULT_CHARS.
export const MAX_TOOL_RESULT_CHARS = (() => {
  const n = Number(process.env?.MOCK2_MAX_TOOL_RESULT_CHARS);
  if (!Number.isFinite(n) || n <= 0) return 200_000;
  return Math.max(1000, Math.round(n));
})();

export function truncateToolResult(text) {
  const s = String(text ?? '');
  if (s.length <= MAX_TOOL_RESULT_CHARS) return s;
  return `${s.slice(0, MAX_TOOL_RESULT_CHARS)}\n…[truncated ${s.length - MAX_TOOL_RESULT_CHARS} chars]`;
}

// ── Transcript cost levers ──────────────────────────────────────────
//
// RUNNER_CACHE_TTL — the build lane opts into the 1-hour prompt cache
// by default: a slow gate battery or long tool run between turns easily
// exceeds the 5-minute default TTL, and every expired gap re-writes the
// entire transcript prefix at full cache-write price. 1h costs 2x to
// write (vs 1.25x) but a multi-turn cycle reads it back dozens of
// times at ~0.1x, clearing the ~3-reads break-even trivially.
export const RUNNER_CACHE_TTL = (() => {
  const v = String(process.env?.MOCK2_RUNNER_CACHE_TTL ?? '').trim().toLowerCase();
  if (v === '5m' || v === 'off') return null; // null → provider default (5m)
  return '1h';
})();

// Stale tool-result pruning. Deep into a cycle the transcript is
// dominated by old file reads and command output that later edits made
// obsolete — yet every turn re-reads them in the cached prefix, and
// every cache miss re-writes them. Pruning replaces the BODY of tool
// results older than the last PRUNE_KEEP_RECENT tool turns with a short
// head + marker (the runner can always re-run the tool if it truly
// needs the content again).
//
// Why batched: an edit anywhere in the transcript invalidates the
// cached prefix from that point, so pruning one result per turn would
// force a prefix re-write EVERY turn — worse than not pruning. Instead
// nothing is touched until PRUNE_BATCH_MIN results are stale, then the
// whole batch is pruned at once: one amortized re-write of a now much
// smaller prefix, followed by many cheap reads of it.
export const PRUNE_KEEP_RECENT_TOOL_RESULTS = envNum('MOCK2_PRUNE_KEEP_TOOL_RESULTS', 20);
export const PRUNE_BATCH_MIN = envNum('MOCK2_PRUNE_BATCH_MIN', 12);
export const PRUNE_STUB_KEEP_CHARS = 500;
export const PRUNE_MIN_CHARS = 2_000; // small results aren't worth stubbing
export const PRUNED_MARKER = '[stale tool result pruned';

// Mutates `transcript` in place (it is cycle-local); returns
// { prunedCount, prunedChars } — zeros when below the batch threshold.
// Idempotent: already-pruned results carry PRUNED_MARKER and are never
// re-counted or re-pruned. Disable with MOCK2_PRUNE_KEEP_TOOL_RESULTS=0.
export function pruneStaleToolResults(transcript, {
  keepRecent = PRUNE_KEEP_RECENT_TOOL_RESULTS,
  batchMin = PRUNE_BATCH_MIN,
  keepChars = PRUNE_STUB_KEEP_CHARS,
  minChars = PRUNE_MIN_CHARS,
} = {}) {
  if (!Array.isArray(transcript) || keepRecent <= 0) return { prunedCount: 0, prunedChars: 0 };
  // Find stale candidates: tool turns beyond the most recent `keepRecent`,
  // not yet pruned, big enough to matter.
  const toolIdxs = [];
  for (let i = 0; i < transcript.length; i++) {
    if (transcript[i]?.role === 'tool') toolIdxs.push(i);
  }
  const staleIdxs = toolIdxs.slice(0, Math.max(0, toolIdxs.length - keepRecent)).filter((i) => {
    const c = String(transcript[i].content ?? '');
    return c.length >= minChars && !c.includes(PRUNED_MARKER);
  });
  if (staleIdxs.length < Math.max(1, batchMin)) return { prunedCount: 0, prunedChars: 0 };

  let prunedChars = 0;
  for (const i of staleIdxs) {
    const turn = transcript[i];
    const c = String(turn.content ?? '');
    prunedChars += c.length - keepChars;
    turn.content = `${c.slice(0, keepChars)}\n…${PRUNED_MARKER}: ${c.length - keepChars} chars removed to keep the context lean — re-run \`${turn.name || 'the tool'}\` if you need this content again]`;
  }
  return { prunedCount: staleIdxs.length, prunedChars };
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

// ---- the base app's platform module (binding) ----
//
// WHY THIS EXISTS. The scaffold ships a platform module — theme switching,
// branding, legal pages, an asset library, machine API keys, read-only SQL
// views — and NOTHING in the build prompt mentioned it. A build therefore
// could not use what it did not know about, and had no reason to preserve it:
// a shipped app came back with none of the base app's features, having
// re-derived its own settings storage on top of the one already there.
//
// This section is the contract. It is shared by BOTH prompt builders (the API
// harness's system prompt and the SDK harness's CLAUDE.md) so the two can
// never drift apart — the duplicated shell paragraph below them is exactly the
// kind of drift this avoids.
// BUILD_CONTRACT_SECTION — the capability/restraint/honesty contract, shared
// verbatim by BOTH prompt builders (same no-drift discipline as
// PLATFORM_SECTION). Written for the 2026-07 harness redesign: P47's builds
// printed contract strings on buttons, promoted every action to the top
// level, and rephrased rejected finish prose five times — each paragraph
// below closes one of those, and the checks it references were changed in the
// same branch so prompt and harness agree.
export const BUILD_CONTRACT_SECTION = `# The build contract (binding)
FEATURE-COMPLETENESS HONESTY (binding): never ship a dead button, a silently
missing element, or a fake success path. Anything from the inventory/
instruction you cannot finish this cycle: if the approved mockup SHOWS its
control, ship that control disabled with a small "Not built yet" badge; if the
mockup does NOT show it, leave it out and say so in your finish summary — an
unrequested control is not honesty, it is clutter. STATES are conditions to
HANDLE when they genuinely occur — NEVER fabricate an artificial state to
satisfy a spec item (no fake spinners, invented delays, or placeholder loading
UX for data that arrives at once).
CAPABILITY PLACEMENT (binding): the inventory's actions are CAPABILITIES a
user must be able to perform, not button captions. Put each one where the
approved design says it belongs — a card's overflow menu, a detail view, a
settings screen — not all on the top level. The action-parity check accepts
any placement a user can reach; it never requires a top-level control and
never requires the contract's wording on screen.
RESTRAINT (binding): the mockup's density is part of the contract. When a
gate, a validator message, or a review finding seems to push toward adding a
control the approved design does not show, THE DESIGN WINS pending an operator
decision — state the conflict in your finish summary instead of contorting the
UI to satisfy a checker. The design guidelines bind by default; an EXPLICIT
user instruction to depart from them wins over them — follow it and record the
departure in your finish summary as a project deviation.
HARNESS REJECTIONS (read once — it saves whole cycles): every finish rejection
echoes the parameter names and values the harness actually received. If a tool
rejects your payload repeatedly with the same message, do NOT keep rephrasing
the prose: re-read the rejection's echo, compare it against what you meant to
send, and fix the STRUCTURAL cause (a parameter folded into another one, a
wrong parameter name, tool-call syntax inside a value). If it still persists,
halt and quote the payload and the rejection verbatim — a halt reporting a
harness fault after repeated rejections is accepted as-is.`;

export const PLATFORM_SECTION = `
## The platform module (binding — already built, do not rebuild)
\`src/platform/\` is the base app's own feature set. It is LOAD-BEARING: it is
wired into \`src/app.ts\` and \`src/server.ts\`, its tables ship in
\`migrations/0100_platform.sql\`, and the ProxyPilot platform keeps it updated.
NEVER delete it, re-implement it, or create a parallel settings/branding/
api-key table. Read the files before you touch anything adjacent to them.

What it already gives the app, for free:
- **Theme** — light / dark / follow-the-system, applied synchronously in
  \`<head>\` by \`public/theme.js\` before first paint (a deferred apply flashes
  white at dark-mode users). Every page you add MUST include that script tag
  and style from the token palette, or the toggle does nothing on your screen.
- **Branding** — app name, logo, favicon (falls back to the logo), and the
  "what this app is for" context, editable by an admin. Served unauthenticated
  at \`GET /api/branding\`; \`GET /favicon.ico\` resolves the uploaded icon.
- **Legal pages** — privacy policy and terms, admin-editable, rendered from
  \`GET /api/legal/:slug\` with a footer that carries ®/™ and the CURRENT year.
  They render with no session because they appear on the sign-in screen.
- **Asset library** — uploaded images/content at \`GET /api/assets/:id\`,
  managed by an admin. Use it for anything the app displays; do not add a
  second upload path.
- **Machine API keys** — \`src/platform/api-key-auth.ts\` exposes
  \`withApiKey\`, so any route can be called by another application with a
  scoped key instead of a session. Admin CRUD lives under the admin routes.
- **Read-only SQL** — \`src/platform/readonly.ts\` maintains curated views in
  the \`api_read\` schema for reporting clients. When you add a table worth
  reporting on, register a view there rather than handing out table access.
- **Discovery** — \`GET /api/meta\` describes the app's own API surface.
- **Notifications (Web Push)** — \`src/platform/push.ts\` already does the
  whole thing: VAPID keys minted on first use, per-device subscriptions keyed
  on the endpoint, aes128gcm payload encryption, dead-subscription cleanup, and
  the \`/api/push/*\` routes. To notify someone from YOUR feature, call
  \`notifyUser(userId, { title, body, url }, origin)\` or \`notifyAll(...)\`.
  Do NOT write your own push code — every mistake in those RFCs is silent (the
  push service accepts the request and the browser drops the message).
- **App install** — \`public/install.js\` invites the user to install the app
  ONCE, as a styled modal, and \`public/push.js\` keeps the offer permanently
  available in the Notifications panel. Never add your own install button.
- **Client helpers** — \`public/platform.js\` renders branding and the legal
  footer with no session; \`public/theme.js\` owns the toggle; it also exposes
  \`pp.alert\` / \`pp.confirm\` / \`pp.prompt\` — styled modals you MUST use
  instead of \`window.alert\` / \`confirm\` / \`prompt\` (a browser dialog in a
  polished app reads as unfinished, and the \`no-native-dialogs\` gate reds it).

How to EXTEND it (the only supported way):
- A new setting → add it to the platform's settings section, not a new table.
- A new page in the shell → add the nav entry to the shell header AND the
  theme.js + platform.js head lines, so it themes and shows the footer.
- A new reportable table → register a view in \`readonly.ts\`.
- A new machine-callable route → mount it behind \`withApiKey\`.
- Something worth telling a user about → \`notifyUser\` / \`notifyAll\` from
  \`src/platform/push.ts\`.
- A confirmation or a message → \`await pp.confirm(…)\` / \`pp.alert(…)\`.

NEVER show a raw validation or server error to a user. \`Expected number,
received nan\` is a message for you, not for someone adding a to-do — and it
means the CLIENT sent nonsense the server correctly rejected, so the bug is
usually the field that produced NaN, not the message. Validate in the browser
before you send (an empty number input reads as NaN, not 0), and when a request
does fail, say what the person can do about it: "Give the task a name", not the
schema's complaint.

The \`platform-intact\` gate checks this: it reds the build if the module lost
its exports or the app grew a second branding/settings/api-key store.

## The approved design (binding)
\`state/design.css\` carries TWO things: the approved token block, and the
mockup's own COMPONENT CSS lifted verbatim (its cards, lists, nav bars, chips,
buttons, empty states). Read it before you write a screen.

- Put the class names design.css defines on your elements. That is how the
  built app inherits the mockup's look without you re-deriving it.
- Style anything genuinely new on \`var(--...)\` from the same file. Never type
  a colour in: hardcoded colours do not follow the theme, and they are why a
  built app drifts from its mockup and why dark mode looks wrong.
- \`state/mockups/current.html\` is the visual contract — its layout, its
  navigation pattern (including a mobile bottom tab bar if it has one), its
  component arrangement, screen by screen.
- That INCLUDES the sign-in screen. \`public/login.html\` is yours to restyle
  onto the approved design (keep its ids, its forms and its \`theme.js\` /
  \`platform.js\` tags — the auth flow and the first-administrator state depend
  on them). It is the first screen anyone sees; leaving it on the base app's
  default is the most visible way an app looks unfinished.

The \`design-adherence\` gate measures this, and it measures your MARKUP as well
as your CSS: shipping screens with neither their own styling nor the approved
component classes reds the build. "The app has no stylesheet" is not a way to
pass it.

## Claiming a removal (binding)
If your summary says you REMOVED, hid, dropped or deleted something a user can
SEE, you must also add a check that would FAIL while that thing is still there,
and name it in \`finish(removals: [...])\`:

    { "expect_absent": "#delete-note" }        an element or control is gone
    { "expect_no_scroll": "#panel-todos" }     a scrollbar is gone
    { "expect_text": "#title-row", "contains": "…" }   wording is gone

Those checks are RUN against the deployed app, so an untrue claim comes back
red. Code-only removals — a dead helper, an unused import, a file — need no
entry, and neither does a style tweak like dropping some padding.

A build once claimed "removed the To-dos inner scrollbar", wrote an acceptance
sentence about it, named two checks that assert nothing of the kind, and shipped
with the scrollbar still on the screen. If you cannot write a check that could
fail, do not claim the removal — say what you actually did.

## Restructuring the app shell (binding)
The shell — the nav, the theme control, the legal footer — is APP-OWNED markup in
\`public/app-shell.html\` and the app's own stylesheet. You may hide the top nav,
move it to a sidebar, fold its controls into a menu, or collapse it on mobile.

What you may NOT do is drop the base app's guarantees, and the platform's own
baseline checks hold you to that. Those checks read \`state/shell.json\`, so when
you change the shell's STRUCTURE you must write that file in the SAME change —
otherwise the checks go looking for a visible \`header\` you deliberately removed
and fail your own work:

    { "nav": "side", "navSelector": "aside.app-nav", "menuOpener": "#nav-toggle" }

\`nav\` is "top" | "side" | "hidden". Set \`menuOpener\` only when the theme control
or legal footer sit behind a menu — the check clicks it before asserting. Omit
what you did not change. Whatever you write, from the default screen the theme
control, the legal footer and the admin route must each still be reachable in at
most one interaction: moving a control into a menu is fine, deleting it is not.

## Browser tests (binding)
The project owns a real Playwright suite. \`playwright.config.ts\` starts the app
itself (build → migrate a scratch database → serve), so \`npm run test:e2e\`
works with nothing deployed. Two projects run: \`desktop\` (1280px) and
\`mobile\` (Pixel 5) — the mobile one is where the defects have actually been.

- \`e2e/platform.spec.ts\` asserts the BASE APP's guarantees (sign-in renders,
  the theme toggle persists, no horizontal scroll on a phone, no console
  errors). Never edit it to make your change pass; if it goes red, your change
  broke something the app is supposed to do.
- Put YOUR specs in other files under \`e2e/\` — one per screen or flow. Test
  what a user DOES: fill the form, submit it, expect the row to appear, reload,
  expect it to still be there. A spec that only asserts an element exists is
  worth very little.
- The \`e2e\` gate runs the suite from the MVP profile up, BEFORE the deploy.
  It skips green when the browser binary is not installed (an environment
  problem, never your code) but NEVER when a test fails.

This is NOT the same thing as \`state/ui-checks.json\`. Those are the platform's
post-deploy smoke checks against the LIVE app, per role, executed by ProxyPilot
after your build ships. Your Playwright specs run before the deploy, against a
server the suite starts. Write both — they catch different failures.

\`state/ui-checks.json\` is one file, and this is the whole of it. Copy it and
edit it rather than deriving the format — it is valid JSON exactly as written:
{
  "users": [{ "role": "admin", "email": "admin@fixture.invalid", "password": "<12+ chars>" }],
  "checks": [{
    "id": "notes-list-loads",
    "name": "The notes list renders and search filters it",
    "paths": ["public/app.html", "public/n7.js"],
    "login": "admin@fixture.invalid",
    "page": "/",
    "steps": [
      { "expect_visible": "#note-grid" },
      { "fill": "#search", "value": "groceries", "expect_value": true },
      { "expect_text": "#note-grid", "contains": "Groceries" },
      { "click": "#new-note" },
      { "expect_enabled": "#save" }
    ]
  }]
}
\`paths\` are globs saying which files a check covers, and EVERY user-facing file
you touch needs at least one check matching it — that is what the
\`ui-interaction\` gate enforces. \`login\` names a user from \`users\`; omit it to
run the check SIGNED OUT. One assertion per step; the full step vocabulary is
expect_visible / expect_enabled / expect_disabled / expect_absent /
expect_text (+contains) / fill (+value) / click.
`;

// ---- shared prompt sections (2026-07 restructure) ----
//
// One altitude per section, defined ONCE and consumed by BOTH prompt builders
// (the PLATFORM_SECTION no-drift discipline, applied to the rest of the
// prompt). Every sentence below is a ratcheted lesson carried over verbatim
// from the pre-restructure prompt — the restructure moved text, it did not
// drop any. The mockup-contract paragraph now LEADS the design section: it is
// the single most important sentence in the prompt and used to be the last
// line of its section.

export const DESIGN_CONTRACT_SECTION = `# The design contract (binding — reproduce the approved look)
When the approved mockup exists at \`state/mockups/current.html\`, it is the
visual CONTRACT beyond the tokens: read it and reproduce its layout, navigation
structure (e.g. a mobile bottom tab bar), and component arrangement for the
screens you build — the app should look and navigate like the mockup.
The approved design's visual language is captured in \`state/design-tokens.json\`
(colors, typography, corner radius, spacing, shadow) with a ready stylesheet
rendered from it at \`state/design.css\`. Read both. The app MUST reproduce that
look, not a generic default: make the app load that stylesheet (serve it as a
static asset and link it, or import its tokens into the app's CSS) and style every
screen with those tokens — the same colors, fonts, radii, and component styling
the mockup used. Do not invent a different visual style. If the files are absent
(an older project), fall back to a clean, consistent look.
The scaffold ships a shared app shell: \`public/base.css\` (header/nav, .card,
.btn, .badge, .stat, .field, table.list, plus the component kit: .modal/.drawer,
.toast, .tabs, .menu, .pager, .skel skeletons, .empty empty-states, .switch,
.num tabular numerals, .bars mini charts, field .err/.hint validation, and the
motion utilities above — all token-driven) and \`public/assets.svg\` (inline SVG symbols for empty states:
empty-box, search, alert, check, inbox — use \`<svg><use href="/assets.svg#empty-box"/></svg>\`) and
\`public/app-shell.html\` (the authenticated home served at /). BUILD SCREENS ON
THIS SHELL: link /design.css + /base.css, reuse its classes, and add nav entries
to the shell's header — never hand-roll a parallel layout or restyle the shell.
MOTION is part of the design system, not decoration you add: the tokens carry
\`--app-dur-fast|base|slow\` and \`--app-ease-standard|entrance|exit\`, and the
shell ships the classes that consume them — \`.enter\` / \`.enter-fade\` for
something arriving, \`.stagger\` (set \`--i\` per row) for a list arriving in
order, \`.press\` for a control acknowledging a press, \`.pulse-once\` for
drawing the eye ONCE to something that just changed. SELECT motion with those
classes; do not hand-write \`@keyframes\` with your own timings, which is how an
app ends up moving at a different speed on every screen. Nothing loops, nothing
animates a value while someone is reading it.
PWA (binding): the app is an installable Progressive Web App — \`public/
manifest.webmanifest\`, \`sw.js\`, \`install.js\`, and \`icon.svg\` plus the
manifest link and install.js script in every page head must SURVIVE your
changes; give any new page the same head lines. Never cache /api responses in
the service worker.
\`state/design-findings.json\` is the ledger of what the automated review found
the last time it looked at the RUNNING app. The platform owns that file — read
it, never write it. Anything still \`open\` there is a defect the app is
currently shipping, and the ones with a high \`timesSeen\` are the ones builds
keep walking past.
CHROME OVERFLOW (operator-reported defects — binding):
- The app chrome NEVER scrolls horizontally: the top nav wraps or collapses
  into a menu — never a horizontally scrolling strip beside the brand.
- ONE theme control in the whole app, in the header. Never a second theme
  switch, a theme page, or a separate route per theme — themes are tokens
  flipped by the one toggle.
- Long unbroken strings (emails, URLs, one-time links, tokens) truncate with
  ellipsis or break-anywhere inside their cell/card. A visible horizontal
  scrollbar on the page, header, or a card is a defect (.table-scroll on wide
  tables is the one sanctioned exception).`;

export const CRAFT_FLOOR_SECTION = `# The craft floor (how a professional app behaves — apply without being asked)
DESIGN CRAFT (the fidelity floor is not the ceiling): the mockup fixes the
layout and style; production polish is still your job. Keep a consistent
spacing rhythm and clear visual hierarchy (one primary action per view), align
numeric columns (tabular numerals), and give every interactive control real
hover/focus/active affordances. DESIGN the empty, loading, and error state of
each screen — an empty state names the next action ("No punches yet — Clock in
to start"), never a bare "No data". Guard destructive actions, prefer dense
well-formatted real data over oversized placeholder cards, and tie badge/status
colors to semantic states. These touches are the difference between a demo and
a product; apply them without being asked.
DOMAIN COMPLETENESS (binding): model the data like a domain expert, not a
demo. Persist and display the COMPLETE record the domain implies — every event
in the period, not just the latest state (a timesheet day lists EVERY
clock-in/out pair, not one line); make full history reachable where one exists
(audit trails, prior versions). Surface DERIVED signals the domain expects —
a missing punch-out, an overtime day, a stale sync, an anomalous gap — as
visible, server-computed flags. When the instruction allows both a shallow and
a complete reading, build the complete one; if that meaningfully changes
scope, say so in your summary and mark the deferred depth "Not built yet".
INTERACTION COMPLETENESS (binding): professional apps imply mechanics beyond
the literal ask. Lists that can exceed ~20 rows get search/filter and
pagination (or explicit "showing N of M" + load more). Forms validate inline,
keep the user's input on error, and disable double-submits. Destructive
actions confirm (or offer undo). Every async action shows real progress and a
retryable failure state. Every screen is reachable within two taps/clicks of
its natural entry point, and the current location is visible (active nav
state). Apply these without being asked wherever the domain implies them.
ERROR MESSAGES (binding): every user-facing error says WHAT happened, WHY (as
far as known), and WHAT TO DO NEXT, in plain language — "Couldn't save — the
server didn't respond. Your entry is kept; tap Retry." Never surface raw
exception text, status codes alone, or a bare "Error". Preserve the user's
work through every failure.
JOURNEYS DRIVE THE LAYOUT: when state/inventory.json carries a journeys list
(name, steps, frequency), the FREQUENT journeys get the prominent navigation
(e.g. the mobile bottom tab bar) and the fewest taps; rare/admin journeys go
behind a menu. Do not give every screen equal navigational weight.`;

export const DATA_DISCIPLINE_SECTION = `# Data and time discipline (binding)
TIME HANDLING (binding): the SERVER is the time authority. Store and compute
timestamps in UTC (ISO-8601 / timestamptz) and define day/period boundaries
server-side; the BROWSER only CONVERTS for display with the user's own locale
and timezone (Intl.DateTimeFormat / toLocaleString on the ISO value). Never
compute day boundaries from the client clock, and never compare client-local
dates against server-UTC dates — that class of bug shifts punches/records
across midnight.
LIVE DATABASE HYGIENE (binding): the container's Postgres at DATABASE_URL IS
this project's LIVE production database — there is no separate staging copy,
and "the deploy will reset it" is FALSE (deploys migrate in place). Any
account or row you create to verify your work must be deleted before you
finish, in the same cycle. Accounts that must persist for automated checks
(the login users referenced by state/ui-checks.json) MUST use the reserved
fixture domain \`@fixture.invalid\` — never a real-looking address. NEVER
consume the app's first-admin bootstrap: do not create a real-domain account
through the bootstrap/superadmin flow — the first real account belongs to the
operator. If the users table was empty when your cycle started, it must hold
only \`@fixture.invalid\` accounts (or nothing) when you finish.
NO SAMPLE DATA IN THE LIVE APP (binding): realistic sample content belongs in
the MOCKUP only (that is where design is judged). The deployed app starts
EMPTY and its screens earn their look through designed empty states — never
seed demo rows, placeholder records, or "example" content into the live
database or ship hardcoded fake data in the UI. If a screen needs data to be
meaningful, its empty state says how to create the first real record.`;

// The editing mechanics, stated ONCE for every engine (they were previously
// stated three times — copilot preamble, workflow step 3, efficiency notes —
// and referenced write_file, which the default copilot harness does not have).
export const EDITING_MECHANICS_SECTION = `# Editing mechanics
- Understand first: use search_workspace to find the code and read_file (with
  line ranges) to read the exact lines before changing them. NEVER edit a file
  you have not read this cycle.
- To CHANGE an existing file use apply_edit — the smallest anchored replacement
  that solves the task, never a whole-file rewrite. old_string must be copied
  byte-for-byte from the file (exact indentation) with 3+ lines of surrounding
  context so it matches exactly once. On NO_MATCH, re-read the file and copy
  the exact text; on AMBIGUOUS_MATCH, add more context or set replace_all.
- Whole-file writes (write_file / create_file — whichever this cycle's tools
  provide) are for CREATING a new file, or a change that is essentially a full
  rewrite. Write each new file COMPLETE in one call; never draft-then-extend.
- After editing, VERIFY: run get_diagnostics (and run_gates when this cycle
  has a gate battery) and fix every error before you finish. Terminal commands
  only when genuinely necessary — they are policy-checked.`;

// buildRunnerSystemPrompt — assemble the model's system prompt server-side from
// the PINNED framework content (ADR-003 / brief §10.1: the framework is injected
// fresh from a pinned version, never travels through chat, cannot be talked out
// of). constitution is the pinned constitution_md; skills the parsed skill list;
// task the canned instruction; appDir/webPort orient the model in the container.
export function buildRunnerSystemPrompt({ constitution = '', skills = [], appDir = '/srv/app', webPort = 3000, components = [], installedComponents = [], buildMode = 'full', harness = 'proxypilot' } = {}) {
  const skillLines = skills.length
    ? skills.map((s) => `- ${s.name}${s.description ? `: ${s.description}` : ''}`).join('\n')
    : '- (no skills configured in this framework version)';
  // THIS CYCLE header — the mode's own contract, stated FIRST. The old prompt
  // opened with the full-lane story ("one small targeted change… fixed gate
  // battery") and patched it ~700 lines later with mode sections filed under
  // "# Available skills" that "override the spec-first steps below" — so the
  // first thing a fast-lane build read about itself was false. The header and
  // the workflow are now BUILT for the mode instead of overridden.
  const mode = String(buildMode);
  const modeHeader = mode === 'mvp' ? `THIS CYCLE IS AN MVP BUILD: deliver a WORKING, testable end-to-end version of
the approved design, fast.
- There is NO gate battery and NO run_gates tool this cycle. Do NOT write
  state/acceptance.json, state/ui-checks.json, or per-rule test suites —
  skipping them is sanctioned here and only here. A later FULL build adds the
  rule interview, per-rule tests, ui-checks, and the acceptance spec — do not
  attempt them now.
- ProxyPilot's deploy (tsc build + health check on the live URL) is the
  verification backstop. Everything else still binds: type-clean code, the
  constitution, honest integrations.
- finish still requires the one-line summary, at least one human-runnable
  acceptance check, and the verified-vs-assumed assumption split.`
    : mode === 'quick' ? `THIS CYCLE IS A QUICK UPDATE: ONE small, precise change to a WORKING app, live
in minutes. Think "editor session", not "project build".
- MINIMAL DIFF IS THE CONTRACT: touch only the files the change needs; never
  refactor, restyle, re-scaffold, or "improve" anything that wasn't asked for.
  If the request is ambiguous, make the smallest reasonable interpretation and
  say what you assumed in the finish summary.
- SPECIFIC MEANS LITERAL: build what the instruction says, not an adjacent
  improvement, and never modify the UI to satisfy what you guess a checker
  matches on. If the instruction conflicts with a gate or the approved design,
  satisfy the instruction and state the conflict in your finish summary.
- There is NO gate battery and NO run_gates tool this cycle, and you must NOT
  write state/acceptance.json, ui-checks, per-rule tests, or new test suites —
  verify the change yourself (keep it type-clean); ProxyPilot's deploy (tsc
  build + health check on the live URL) is the verification backstop. Quick
  means live, not unverified.
- finish still requires the one-line summary, one human-runnable check, and
  the verified-vs-assumed split.`
    : `THIS CYCLE IS A FULL BUILD. Spec-first discipline applies: write the
acceptance spec, verify with the pinned gate battery (run_gates), and finish
only when every gate is green — the "How to work" steps below are the
contract.`;
  // The workflow is assembled PER MODE — full keeps the spec-first steps;
  // fast lanes get steps that match what their cycle actually runs.
  const workflow = mode === 'mvp' ? `# How to work — MVP build
1. Read the contract first: state/mockups/current.html (the visual contract),
   state/design.css (its component classes), state/inventory.json, and the
   installed components' integration notes.
2. Build the WHOLE approved inventory on the scaffold — every screen, field,
   and action — wiring the installed standard components instead of
   re-implementing them.
3. Verify as you work: keep the code type-clean (get_diagnostics); there is no
   gate battery to lean on this cycle.
4. SPEED IS THE POINT — minimize turn count, not just token count: BATCH
   independent tool calls in ONE turn (write several files at once; run
   independent commands together — one call per turn wastes a full model
   round-trip); plan once, briefly, then execute; do not re-read files you
   just wrote, and skip exploratory reads of scaffold files whose content the
   task description already tells you; target well under 40 turns total.
5. Call finish when the app is complete and working.`
    : mode === 'quick' ? `# How to work — quick update
1. Read the specific file(s) you are changing before editing them — never
   guess API shapes or element ids.
2. Make the smallest change that satisfies the request; keep the approved
   design tokens (/design.css) and keep every existing behavior working.
3. Never touch the auth wiring (src/auth/*, withAuth/bootstrapGate in
   src/app.ts) or the login/bootstrap flow.
4. SPEED: batch independent tool calls in one turn; no exploratory reads
   beyond the files involved; target well under 15 turns total.
5. Call finish when the change is complete and working.`
    : `# How to work — full build
1. Write state/acceptance.json FIRST — what "done" means for THIS task: {task,
   kind: bugfix|feature|chore, defect_tag + regression tests for a bug fix,
   integration contract test when the change touches an external integration,
   ui: the state/ui-checks.json ids that must pass against the deployed app}.
   For a BUG FIX, reproduce first: write the defect-tagged regression test so
   it FAILS against the current behavior, run run_gates to record the red, then
   fix and drive it green — finish is rejected without that observed red.
   Reproduce-first applies only when product code changes: if the work turns
   out to already be done (an idempotent re-adoption, a state/-only alignment,
   nothing to change), do NOT fabricate a red test and do NOT reclassify —
   declare the honest kind (usually chore), leave the code untouched, and call
   finish; the orchestrator verifies the empty diff itself and accepts it.
2. Read the relevant files to understand the current state. NEVER edit a file
   you have not read this cycle.
3. Make the smallest change that satisfies the requested task. Do not refactor,
   add features, or touch anything the task did not ask for. When a gate fires
   falsely, propose the gate/allowlist change as a reviewed act — NEVER reword
   or restructure product code just to slip past a detector pattern.
4. Call run_gates. If any gate is red, fix the cause and run them again.
5. When every gate is green, call finish with a one-line summary, the
   human-runnable acceptance check(s) ("as <role>, do X, expect Y" — one per
   user-visible change), and your cross-layer assumptions split into verified
   (you READ the source this cycle — name the file) vs assumed. Do not call
   finish before the gates are green, and do not leave a permission or
   role-name value in "assumed" — verify it. The summary must describe THIS
   cycle's diff only — naming files this cycle did not change is rejected.
6. When the code is real and complete and the gates are green, but a DECLARED
   integration still needs a live external check the fence cannot run (the
   credentials/endpoint belong to the operator — e.g. an LDAPS bind against the
   production directory), call pending_verification instead of finish: it is
   the first-class honest completion for exactly that case. Verify everything
   verifiable in-fence first (typecheck, config-schema presence, the contract
   test against the local fixture server); never fabricate a live test and
   never stub the transport to force a plain finish.`;
  return `You are ProxyPilot's ${harness} build engine (the Mock2 build runner). You build and
change one project's code inside its own container, and you stop when the work
is honestly done. You never approve your own work and you never release to
production — a human reviewer gates production.

${modeHeader}

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

${DESIGN_CONTRACT_SECTION}
${PLATFORM_SECTION}
${BUILD_CONTRACT_SECTION}
${CRAFT_FLOOR_SECTION}
${DATA_DISCIPLINE_SECTION}
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
${skillLines}${buildInstalledComponentsSection(installedComponents)}${buildComponentCatalogSection(components, { access: 'tool' })}

# Integration manifest (state/integrations.json — the EXACT shape is enforced)
Any external capability (a third-party API, a directory bind, an external DB)
must be declared in state/integrations.json. The gate validates the exact field
names — entries written with keys like \`key\`, \`name\`, \`destinations\`, or
\`code\` do NOT validate and will block finish. One valid example:
{"schema_version":1,"entries":[{"id":"adp-workforce","subsystem":"adp",
"actions":[{"name":"test-connection","operation":"oauth-token"}],
"destination":{"source":"env","key":"ADP_TOKEN_URL"},"transport":"https-mtls",
"provenance":{"response_to_output":"required"},
"live_verification":{"required":true},"egress":{"classification":"public"},
"contract_test":"tests/contract/adp.contract.test.ts"}]}
subsystem is the src/<subsystem>/ folder; destination.key is the env/config key
the real endpoint comes from; live_verification.required true means a human
runs the live check after deploy (pending_verification is then your finish).

${workflow}

${EDITING_MECHANICS_SECTION}

# Work efficiently (this changes HOW you work, never WHAT you deliver)
Every step above still binds — the discipline, the reads before edits, the gates,
the honest finish. These rules only remove wasted round-trips:
- BATCH independent tool calls: emit MULTIPLE tool calls in ONE turn whenever they
  do not depend on each other (read several files at once; run independent
  commands together). One call per turn spends a full model round-trip on nothing.
  Anything whose input depends on a previous result still waits for that result.
- Read narrow: request line ranges rather than whole files, and do not re-read a
  file or re-run a search whose result you already have in this conversation —
  EXCEPT after you edit a file, where re-reading before the next edit is required.
- Do not restate large file contents back in your messages; refer to them.
- Prefer one apply_edit with enough context over several speculative attempts.
Quality is never traded for speed: if batching would make you guess, don't batch —
read first, then act.

# MOUNTING YOUR ROUTES: YOUR ROUTERS GO LAST
In \`src/app.ts\`, every \`app.use(...)\` of your own goes BELOW every platform
mount — below the auth routes, the platform routes, the sign-in route and the
static mount. Last. That is the whole rule, and it is not a style preference.

A router runs its router-level middleware for every request that reaches it and
matches its mount path, whatever the paths declared inside it:

    const router = Router();
    router.use(requireAuth);            // reasonable — for its own routes
    router.get('/api/notes', ...);
    app.use(notesRoutes);               // <- now guards EVERYTHING below it

Mounted above the sign-in route, that answers 401 to \`/login\` and to every
stylesheet: the live URL serves a JSON error body and the app looks dead.

Mounted above \`app.use('/api', authRoutes)\`, it answers 401 to
\`/api/auth/bootstrap/status\` — and login.js reads a non-ok status there as "a
user already exists", so it shows the sign-in form and HIDES the
create-the-first-administrator link. The app LOOKS fine and nobody can ever
create the first account. Both of these happened, on the same project, one
after the other.

A PATH PREFIX DOES NOT SAVE YOU. \`app.use('/api', notesRoutes)\` above
\`app.use('/api', authRoutes)\` shadows \`/api/auth/*\` exactly the same way — the
prefix matches, the router's guard runs, and the platform's auth API is never
reached. Position is what matters, not the prefix.

So:
- Put your \`app.use(...)\` lines at the END of the route wiring, after the
  platform's. A path prefix on top of that is good practice, not a substitute.
- \`router.use(requireAuth)\` is fine once the router is mounted last. Guarding
  per route (\`router.get('/notes', requireAuth, handler)\`) is safe anywhere.

The \`signin-reachable\` gate fails the build for this before it deploys and
names the line and the boundary. Do not work around it by moving the sign-in
route or the platform's mounts — move YOURS down.

# What ProxyPilot runs FOR you after you finish — do not rebuild it
The moment you call finish and the gates are green, the platform checkpoints,
deploys, and then runs all of this itself, against the REAL deployed app:
- A readiness probe: \`/api/health\` must be 200, the sign-in page must render,
  the stylesheet must be served, and ONE SIGNED-IN request must come back with
  the app — using a platform fixture account it provisions and holds.
- The migration chain, dry-run end to end on a scratch database, with the app
  booted against it. Your app's own database is never touched.
- The browser connector, executing \`state/ui-checks.json\` per role against the
  live app, plus the platform's own baseline checks. Any console error fails.

So do NOT build a second copy of that. Specifically: do not create scratch
databases, do not boot the server by hand, do not mint your own auth tokens to
exercise your own API, and do not write throwaway curl/psql round-trips to
prove the app works end to end. One build spent 34 of its 73 turns and 41% of
its cost on exactly that — a whole hand-rolled integration harness for
something that was going to run anyway five minutes later, and the turns were
the most expensive in the run because they were the fattest end of the context.

"Verified" in your finish means YOU READ THE SOURCE this cycle and can name the
file. It does not mean you booted the app. If a cross-layer assumption cannot
be settled by reading — a signature, a cookie name, a claim shape — read the
file that defines it and cite it. That is the bar, and it is the whole bar.

What IS worth running locally, because nothing downstream repeats it: the
typecheck/build, your own Playwright specs under \`e2e/\`, and any unit test you
wrote this cycle.

# External endpoints are NOT reachable from this fence (read this before you halt)
This container is network-fenced: it has NO route to external services or LAN
hosts (a directory server, an ADP/OAuth token endpoint, an internal database).
Their live credentials and network belong to the operator, not this fence. So for
an app whose job IS an external integration:
- Implement the REAL transport (the actual bind/handshake/request) that ATTEMPTS
  the call and SURFACES failures — do not swallow errors into success, do not
  return success from config-field presence.
- DECLARE it in state/integrations.json with live_verification.required: true.
- Then call pending_verification — that IS your completion. The operator runs the
  live check against the real system after deploy.
Do NOT halt just because a live bind/connection failed or is unreachable FROM THE
FENCE — that is expected here and is NOT a blocker; it is precisely what
pending_verification is for. Do NOT fake a green connection to force finish, and
do NOT loop re-probing an endpoint the fence cannot reach. Reserve halt for a real
blocker (a missing dependency, an out-of-scope fix, a rule question) — never for
"the fence can't reach the live endpoint."

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

Make the change; call finish only when the work is honestly complete (gates green when this cycle has them), or halt if you are blocked.`;
}

// The first user turn: the canned task instruction. Kept a pure formatter so the
// transcript shape is testable.
export function buildRunnerTask(instruction) {
  return `Task: ${String(instruction || '').trim()}`;
}

// buildFeedbackSection — recent thumbs-DOWN notes the operator left on earlier
// builds, distilled into the task turn as standing taste. Subordinate to the
// instruction (same discipline as the pre-pass brief); empty input renders
// nothing so old projects with no ratings pay zero tokens.
export function buildFeedbackSection(notes = []) {
  const items = (Array.isArray(notes) ? notes : [])
    .map((n) => String(n || '').trim()).filter(Boolean).slice(0, 5)
    .map((n) => n.slice(0, 400));
  if (!items.length) return '';
  return `\n\nRecurring operator feedback (from thumbs-down ratings on earlier builds — standing taste for THIS project; do not repeat these mistakes):\n- ${items.join('\n- ')}`;
}

// buildCompletionSummaryBody — the review summary posted into the BUILD CHAT
// when a cycle reaches a calm terminal (succeeded / pending-operator-
// verification), so the person who asked for the change can see WHAT was done
// without opening the change history: outcome headline, the build's own
// finish summary, the orchestrator-verified changed-file list (never a model
// claim), and any live checks left for the operator. Pure so both runners
// post the identical shape.
export function buildCompletionSummaryBody({ summary = '', changedFiles = [], deployed = null, pendingChecklist = [] } = {}) {
  const pending = Array.isArray(pendingChecklist) ? pendingChecklist : [];
  const headline = pending.length
    ? `Build complete — deployed, with ${pending.length} live verification${pending.length === 1 ? '' : 's'} left for you to run`
    : deployed?.noop
      ? 'Build complete — nothing needed changing (the work was already done and verified)'
      : deployed?.skipped
        ? 'Build complete — change checkpointed into the repo'
        : 'Build complete — deployed and live on the app URL';
  const parts = [`${headline}.`];
  const s = String(summary || '').trim();
  if (s) parts.push(`What was done:\n${s}`);
  const files = (Array.isArray(changedFiles) ? changedFiles : []).filter(Boolean);
  if (files.length) {
    const shown = files.slice(0, 15);
    parts.push(`Files changed (${files.length}):\n${shown.map((f) => `- ${f}`).join('\n')}${files.length > shown.length ? `\n… and ${files.length - shown.length} more` : ''}`);
  }
  if (pending.length) {
    const items = pending.slice(0, 8).map((c) => `- ${c?.description || c?.item_id || 'live external check'}`);
    parts.push(`Verify live when ready (Build panel → Live verification):\n${items.join('\n')}${pending.length > 8 ? `\n… and ${pending.length - 8} more` : ''}`);
  }
  parts.push('The full record (acceptance evidence, diff, hashes) is under Change history.');
  return parts.join('\n\n').slice(0, 8000);
}

// Render finish's acceptance + assumptions into the block appended to the
// change record's summary (and mirrored into the cycle event log) — the
// human-runnable evidence a Reviewer replays. Pure so the record shape is
// testable and can't drift between runners.
export function formatAcceptanceBlock(acceptance = [], assumptions = null) {
  const lines = ['Acceptance:'];
  for (const a of Array.isArray(acceptance) ? acceptance : []) lines.push(`- ${a}`);
  const v = assumptions?.verified || [];
  const s = assumptions?.assumed || [];
  lines.push(`Assumptions verified:${v.length ? '' : ' (none)'}`);
  for (const x of v) lines.push(`- ${x}`);
  lines.push(`Assumptions assumed:${s.length ? '' : ' (none)'}`);
  for (const x of s) lines.push(`- ${x}`);
  return lines.join('\n');
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
  const base = { done: false, halted: false, pendingVerification: false, haltReason: null, haltOptions: [], authRequest: null, finishSummary: null, toolCalls: calls, stalled: false, refusal: false, trigger: null };
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
  const strList = (v) => (Array.isArray(v) ? v.map((s) => String(s || '').trim()).filter(Boolean) : null);
  const parseFinishShape = (input) => {
    const acceptance = Array.isArray(input?.acceptance) ? input.acceptance.map((s) => String(s || '').trim()).filter(Boolean) : [];
    const a = input?.assumptions;
    const assumptions = a && typeof a === 'object' && strList(a.verified) && strList(a.assumed)
      ? { verified: strList(a.verified), assumed: strList(a.assumed) }
      : null;
    // Machine-executed acceptance: ui-check ids the builder declared (run
    // against the deployed app by smoke — ratchet 7; prose alone is never
    // machine-executed).
    const acceptanceIds = strList(input?.acceptance_ids) || [];
    // Declared removals: what was taken away, and the check that would catch it
    // if it were still there. Structured rather than parsed out of the summary
    // — the platform should not be guessing which sentence maps to which check.
    const removals = (Array.isArray(input?.removals) ? input.removals : [])
      .map((r) => ({
        what: String(r?.what ?? '').trim().slice(0, 200),
        check_id: String(r?.check_id ?? '').trim().slice(0, 120),
      }))
      .filter((r) => r.what || r.check_id)
      .slice(0, 12);
    return { summary: String(input?.summary || 'change complete'), acceptance, assumptions, acceptanceIds, removals };
  };
  // A calm PENDING-OPERATOR-VERIFICATION conclusion: the same finish-shaped
  // payload, but the builder is declaring "real + complete in-fence, awaiting a
  // live external check" rather than "succeeded". Checked before finish so a turn
  // that pairs both is treated as the (more conservative) pending conclusion; the
  // runner still re-runs the integration gate and downgrades to a block if the
  // code is a stub (the invariant — pending is never reachable from a fake).
  const pendingCall = calls.find((c) => c && c.name === 'pending_verification');
  if (pendingCall) {
    const f = parseFinishShape(pendingCall.input);
    return {
      ...base, pendingVerification: true,
      finishSummary: f.summary, finishAcceptance: f.acceptance, finishAssumptions: f.assumptions,
      // The RAW input rides along for the finish guard (request 141: a summary
      // carrying "</summary><parameter …" is a malformed call, and the guard
      // can only diagnose what it can see un-normalized).
      finishInput: pendingCall.input || {},
    };
  }
  const finishCall = calls.find((c) => c && c.name === 'finish');
  if (finishCall) {
    const f = parseFinishShape(finishCall.input);
    return {
      ...base,
      done: true,
      finishSummary: f.summary,
      finishAcceptance: f.acceptance,
      finishAssumptions: f.assumptions,
      finishAcceptanceIds: f.acceptanceIds,
      finishRemovals: f.removals,
      finishInput: finishCall.input || {},
    };
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
    if (c?.name === 'create_file') return `creating ${c.input?.path || 'a file'}`;
    if (c?.name === 'apply_edit') return `editing ${c.input?.path || 'a file'}`;
    if (c?.name === 'read_file') return `reading ${c.input?.path || 'a file'}`;
    if (c?.name === 'search_workspace') return `searching for \`${String(c.input?.query || '').replace(/\s+/g, ' ').trim().slice(0, 40)}\``;
    if (c?.name === 'list_dir') return `listing ${c.input?.path || 'a directory'}`;
    if (c?.name === 'get_diagnostics') return 'checking diagnostics';
    if (c?.name === 'exec_in_container' || c?.name === 'run_terminal') return `running \`${String(c.input?.command || '').replace(/\s+/g, ' ').trim().slice(0, 60)}\``;
    if (c?.name === 'get_component') return `fetching component ${c.input?.key || ''}`.trim();
    if (c?.name === 'materialize_component') return `materializing component ${c.input?.key || ''}`.trim();
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
  // create_file is the copilot harness's file-creation tool (it has no
  // write_file) — omitting it here made a copilot turn that only created
  // files count as "no write" for the breaker.
  const hadWrite = calls.some((c) => c?.name === 'write_file' || c?.name === 'create_file' || c?.name === 'apply_edit' || c?.name === 'Write' || c?.name === 'Edit');
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

// resolveHarness(project, env) — the ONE per-project harness decision. An
// explicit project choice (mock2_projects.harness, migration 533) always wins:
// 'copilot' / 'proxypilot' select the two native engines, 'claude' selects the
// Claude Agent SDK runner even against the default, and 'proxypilot' pins the
// original hand-rolled runner even when the legacy global flag is set. No
// explicit choice (NULL / unknown value) resolves to the install-wide default:
// the legacy BUILD_RUNNER=sdk flag still opts a whole install into the Claude
// harness, but absent that the default is now the COPILOT harness (the native
// Copilot-grade port). An install that set BUILD_RUNNER=sdk is unchanged.
export function resolveHarness(project = {}, env = {}) {
  const choice = normalizeHarness(project?.harness);
  if (choice) return choice;
  return buildRunnerMode(env) === 'sdk' ? 'claude' : 'copilot';
}

// The built-in Claude Agent SDK tools the build runner is allowed to use. These
// replace the hand-rolled RUNNER_TOOLS: the SDK executes them itself against its
// working directory (the local checkout), so we don't implement tool execution.
// Deliberately the read/inspect/edit/run set — the main loop's working tools.
// Web access is designed to flow through the two scoped subagents below (each
// restricted to its single network tool); their WebSearch/WebFetch are
// appended separately in sdkQueryOptions (see SDK_WEB_TOOLS).
export const SDK_ALLOWED_TOOLS = Object.freeze(['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob']);

// The subagent-delegation tool. The current SDK docs name it 'Agent'; earlier
// releases called it 'Task'. Both are allowlisted so the pinned option shape
// keeps working across SDK versions.
export const SDK_SUBAGENT_TOOLS = Object.freeze(['Agent', 'Task']);

// The subagents' network tools. Under permissionMode 'dontAsk' a tool call is
// auto-approved only if allowlisted, and the allowlist is global — so the
// subagents' WebSearch/WebFetch must appear here to run without prompting.
// Which agent can CALL them is still scoped by each subagent's own `tools`
// list; the main loop's job (edit + verify against the gate battery) gives it
// no reason to reach for them, and the constitution/gates govern the change.
export const SDK_WEB_TOOLS = Object.freeze(['WebSearch', 'WebFetch']);

// The Claude harness's subagents (SDK `agents` option). Two are required by the
// harness contract — a web-search agent and a URL-fetch agent — and each is
// deliberately restricted to its ONE network tool (no Bash, no file writes), so
// delegating never widens what the build itself may do. More subagents (or
// custom MCP tools) can be added here later without touching the runner.
export const SDK_SUBAGENTS = Object.freeze({
  search: Object.freeze({
    description: 'Web search specialist. Use when the task needs information that is not in the '
      + 'working tree or the constitution — current library/API documentation, error messages, '
      + 'version compatibility, best practices. Returns relevant sources with a short summary of each.',
    prompt: 'You are a web research subagent for a build runner. Given a query, use WebSearch to find '
      + 'the most relevant, authoritative sources. Return a concise list of findings: for each source, '
      + 'the URL, and one or two sentences on what it says that answers the query. Prefer official '
      + 'documentation and primary sources. Do not speculate beyond what the results say.',
    tools: Object.freeze(['WebSearch']),
  }),
  'pull-website': Object.freeze({
    description: 'Web page fetcher. Use when a SPECIFIC URL is already known (from the task, the '
      + 'search subagent, or the code) and its content is needed — documentation pages, changelogs, '
      + 'API references. Retrieves the page and returns the relevant extracted content.',
    prompt: 'You are a web-fetch subagent for a build runner. Given a URL (and optionally what to look '
      + 'for), use WebFetch to retrieve the page and return the content relevant to the request — '
      + 'quote the pertinent sections rather than summarizing them away. If the page cannot be '
      + 'fetched, say so plainly and return nothing else.',
    tools: Object.freeze(['WebFetch']),
  }),
});

// sdkSubagents() — a fresh, mutable copy of SDK_SUBAGENTS for handing to the SDK
// (query() options must not receive our frozen constants).
export function sdkSubagents() {
  return Object.fromEntries(
    Object.entries(SDK_SUBAGENTS).map(([name, a]) => [name, { ...a, tools: [...a.tools] }]),
  );
}

// resolveClaudeAuth — where the Claude harness's Anthropic API key comes from.
// Order: the build_runner slot's Anthropic connector (the existing encrypted
// secrets store), else the server environment's ANTHROPIC_API_KEY. Pure and
// key-material-free: it returns only the SOURCE decision, never the key itself,
// so callers (and tests, and logs) can handle the verdict without ever holding
// a secret. This is a pay-as-you-go API key — never a claude.ai subscription
// login — and it stays server-side: nothing derived from it is sent to the
// browser beyond the boolean "configured".
export function resolveClaudeAuth({ provider = null, hasConnectorKey = false, hasEnvKey = false } = {}) {
  if (String(provider || '').trim().toLowerCase() === 'anthropic' && hasConnectorKey) {
    return { ok: true, source: 'connector' };
  }
  if (hasEnvKey) return { ok: true, source: 'env' };
  return {
    ok: false,
    source: null,
    reason: 'The Claude harness needs an Anthropic API key: point the build_runner model slot at an '
      + 'Anthropic connector with a decryptable key, or set ANTHROPIC_API_KEY in the server '
      + 'environment (.env). Or switch this project back to the ProxyPilot harness.',
  };
}

// Which model a Claude-harness cycle runs. The build_runner slot's model when
// the slot points at Anthropic (existing behavior, unchanged); otherwise —
// running on the server-env ANTHROPIC_API_KEY with a non-Anthropic slot — the
// slot's model belongs to another provider and can't be sent to the SDK, so
// fall back to CLAUDE_HARNESS_MODEL (env) or the pinned default.
export const CLAUDE_HARNESS_FALLBACK_MODEL = MODEL_PRIMARY;
export function claudeHarnessModel({ provider = null, slotModel = null, env = {} } = {}) {
  if (String(provider || '').trim().toLowerCase() === 'anthropic' && slotModel) return slotModel;
  return String(env.CLAUDE_HARNESS_MODEL || '').trim() || CLAUDE_HARNESS_FALLBACK_MODEL;
}

// sdkQueryOptions — the pinned option shape for a Claude-harness query() round.
// Pure so the harness contract is unit-testable without the SDK installed:
// the allowlisted tool set (main loop + delegation + the subagents' web tools),
// the two scoped subagents attached, and CLAUDE.md auto-loading from the
// checkout. permissionMode is 'dontAsk': every allowlisted tool runs without an
// interactive prompt, anything NOT allowlisted is denied outright, and the
// PreToolUse hook still denies protected paths + destructive shell (deny >
// allow). Deliberately NOT 'bypassPermissions': that mode maps to the CLI's
// --dangerously-skip-permissions, which the bundled binary REFUSES under
// root/sudo — and the backend runs as root on standard installs — so bypass
// hard-fails exactly where this harness deploys; 'dontAsk' is also strictly
// tighter (deny-by-default instead of allow-everything). `env` is the SDK
// subprocess environment the caller builds (the API key rides there,
// orchestrator-side only); `hooks` fragments are spread in by the caller.
export function sdkQueryOptions({ cwd, model, maxTurns, env, resumeSessionId = null } = {}) {
  return {
    cwd,
    model,
    allowedTools: [...SDK_ALLOWED_TOOLS, ...SDK_SUBAGENT_TOOLS, ...SDK_WEB_TOOLS],
    permissionMode: 'dontAsk',
    settingSources: ['project'], // auto-load .claude/CLAUDE.md from cwd
    maxTurns,
    env,
    agents: sdkSubagents(),
    ...(resumeSessionId ? { resume: resumeSessionId } : {}),
  };
}

// buildRunnerClaudeMd — render the SAME governance content the hand-rolled system
// prompt injects (buildRunnerSystemPrompt), but as a CLAUDE.md document that the
// Agent SDK auto-loads from the working directory (settingSources: ['project']).
// This is the Phase-1 proof that the constitution is SOURCED FROM CONTEXT, not
// re-explored: it travels as pinned framework content into a file the SDK reads on
// its own. Pure so the mapping is unit-testable and can't silently drift from the
// system-prompt version. `task` is passed to the SDK as the prompt, so it is NOT
// duplicated here; the administrator-decisions block (when present) rides on the
// task like it does today.
export function buildRunnerClaudeMd({ constitution = '', skills = [], appDir = '/srv/app', webPort = 3000, components = [], installedComponents = [] } = {}) {
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

${DESIGN_CONTRACT_SECTION}
${PLATFORM_SECTION}
${BUILD_CONTRACT_SECTION}
${CRAFT_FLOOR_SECTION}
${DATA_DISCIPLINE_SECTION}

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
${skillLines}${buildInstalledComponentsSection(installedComponents).replace(/^# /m, '## ')}${buildComponentCatalogSection(components, { access: 'files', dir: '.claude/components' }).replace(/^# /m, '## ')}

## Integration manifest (state/integrations.json — the EXACT shape is enforced)
Any external capability (a third-party API, a directory bind, an external DB)
must be declared in state/integrations.json. The gate validates the exact field
names — entries written with keys like \`key\`, \`name\`, \`destinations\`, or
\`code\` do NOT validate. One valid example:
{"schema_version":1,"entries":[{"id":"adp-workforce","subsystem":"adp",
"actions":[{"name":"test-connection","operation":"oauth-token"}],
"destination":{"source":"env","key":"ADP_TOKEN_URL"},"transport":"https-mtls",
"provenance":{"response_to_output":"required"},
"live_verification":{"required":true},"egress":{"classification":"public"},
"contract_test":"tests/contract/adp.contract.test.ts"}]}
subsystem is the src/<subsystem>/ folder; destination.key is the env/config key
the real endpoint comes from; live_verification.required true means a human
runs the live check after deploy.

## External endpoints are NOT reachable from this fence
This checkout builds for a network-fenced container with NO route to external
services or LAN hosts (a directory server, an ADP/OAuth endpoint, an internal DB).
For an app whose job IS an external integration: implement the REAL transport that
attempts the call and surfaces failures (never swallow errors into success, never
return success from config-field presence), DECLARE it in state/integrations.json
with live_verification.required: true, and treat the live check as the operator's
job after deploy. A live bind failing or being unreachable FROM THE FENCE is
expected and is NOT a blocker — do not fake a green connection and do not loop
re-probing an endpoint the fence cannot reach.

## How to work
1. Write \`state/acceptance.json\` FIRST — what "done" means for THIS task: {task,
   kind: bugfix|feature|chore, defect_tag + regression tests for a bug fix,
   integration contract test for external-integration changes, ui check ids}.
   For a BUG FIX, reproduce first: write the defect-tagged regression test so it
   fails against the current behavior; the harness must observe it red before a
   green battery counts. Reproduce-first applies only when product code changes:
   if the work is already done (idempotent re-adoption, state/-only alignment),
   do NOT fabricate a red test — declare the honest kind (usually chore), leave
   the code untouched, and stop; the harness verifies the empty diff itself.
2. Read the relevant files to understand the current state.
3. Make the smallest change that satisfies the requested task. Do not refactor,
   add features, or touch anything the task did not ask for. Never reword or
   restructure product code just to slip past a gate's detector pattern —
   propose the gate/allowlist change as a reviewed act instead.
4. Keep the TypeScript source type-clean and keep \`mock2.yaml\`'s run contract
   accurate. ProxyPilot runs the pinned verification gate battery for you after you
   finish — you do not run or approve the gates yourself.
5. When the change is complete, stop. Report, for the change record: a one-line
   plain-language summary of what THIS run changed (never prior cycles' work); a
   human-runnable acceptance check per user-visible change ("as <role>, do X,
   expect Y"); and your cross-layer assumptions split into verified (you read
   the source this cycle — name the file) vs assumed. A permission or role-name
   value left "assumed" is a defect.

## If you cannot honestly finish
If you are blocked — a missing dependency, a gate that can't pass for a reason
outside this change, or a fix that is out of scope — say so clearly and stop; do NOT
repeat the same explanation over and over without making an edit. Completing the
change means finishing working code; a build that cannot honestly be completed is a
blocked build for a human to resolve, not a success.

The working directory (${appDir}) is a local checkout; your edits are synced back and
checkpointed by ProxyPilot, not committed by you.`;
}
