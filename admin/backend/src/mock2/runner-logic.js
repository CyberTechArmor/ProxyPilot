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
      'Adopt a component: the platform writes every file of the published component verbatim into the app source tree server-side (byte-exact at any size — contents never pass through your context) and returns a manifest of what landed (path, bytes, sha256, per-file status). Files that already exist are kept untouched and reported unless overwrite is true. Afterwards read/adapt the real files with read_file/write_file and wire the glue per the integration notes.',
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
      'Declare the targeted change complete AND WORKING. Only call this after run_gates reports every gate green. finish records the cycle as SUCCEEDED and deploys it — never call it for blocked, partial, or not-actually-working work. Provide a one-line, plain-language summary, the human-runnable acceptance check(s), and your verified-vs-assumed cross-layer assumption list — all three land in the change record.',
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
      'End the cycle WITHOUT success because you cannot honestly complete the change — you are blocked, a dependency is missing, or the fix needed is out of scope. This is the ONLY honest way to stop short of finishing: it records the cycle as blocked (needs human attention), does NOT deploy, and is resumable once the blocker is cleared. Note: a build that is complete and real but awaits a LIVE external verification the fence cannot run is NOT a block — use pending_verification for that, not halt. Give the specific reason (what blocks you), and ALWAYS propose 2–4 concrete `options` — the viable paths forward, each with its tradeoff and exactly what will be fed back to you on resume. Never a bare refusal: the operator picks one option (or an admin grants an authorization option) and it resumes the build. Never keep responding without calling a tool when you are stuck — call halt instead.',
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
export function buildRunnerSystemPrompt({ constitution = '', skills = [], appDir = '/srv/app', webPort = 3000, components = [], installedComponents = [], buildMode = 'full' } = {}) {
  const skillLines = skills.length
    ? skills.map((s) => `- ${s.name}${s.description ? `: ${s.description}` : ''}`).join('\n')
    : '- (no skills configured in this framework version)';
  // MVP builds trade the authoring-discipline artifacts for speed; the section
  // below OVERRIDES the "How to work" spec-first steps for this cycle only.
  const mvpSection = String(buildMode) === 'mvp' ? `

# MVP BUILD (this cycle only — overrides the spec-first steps below)
This is an MVP build: deliver a WORKING, testable end-to-end version fast.
- Do NOT write state/acceptance.json, state/ui-checks.json, or per-rule test
  suites this cycle — their gates are not in this battery and finish does not
  require them. Skipping them is sanctioned here and only here.
- Everything else still binds: type-clean code, the constitution, honest
  integrations, and the remaining gates (typecheck, constitution-lint,
  security-scan, test, component-reuse) must be green before finish.
- Wire the installed standard components instead of re-implementing them.
- SPEED IS THE POINT — minimize turn count, not just token count:
  - BATCH tool calls: emit MULTIPLE independent tool calls in ONE turn (write
    several files at once; run several independent commands together). One
    call per turn wastes a full model round-trip each time.
  - Write each file COMPLETE in a single write_file. Never draft-then-extend.
  - Do not re-read files you just wrote, and skip exploratory reads of
    scaffold files whose content the task description already tells you.
  - Plan once, briefly, then execute; target well under 40 turns total.
- finish still requires the one-line summary, at least one human-runnable
  acceptance check, and the verified-vs-assumed assumption split.
A later FULL build adds the rule interview, per-rule tests, ui-checks, and the
acceptance spec — do not attempt them now.` : '';
  // Quick updates are the ITERATION loop: one small, guided, high-quality
  // change on an app that already works, landed in minutes.
  const quickSection = String(buildMode) === 'quick' ? `

# QUICK UPDATE (this cycle only — overrides the spec-first steps below)
This is a quick update: ONE small, precise change to a WORKING app, live in
minutes. Think "editor session", not "project build".
- MINIMAL DIFF IS THE CONTRACT: touch only the files the change needs; never
  refactor, restyle, re-scaffold, or "improve" anything that wasn't asked for.
  If the request is ambiguous, make the smallest reasonable interpretation and
  say what you assumed in the finish summary.
- QUALITY over ceremony: get the change RIGHT — read the specific file(s) you
  are changing before editing them (never guess API shapes or element ids),
  keep the approved design tokens (/design.css), and keep every existing
  behavior working.
- Do NOT write state/acceptance.json, ui-checks, per-rule tests, or new test
  suites; the vitest gate is not in this battery. Typecheck, constitution-lint,
  security-scan, and component-reuse still must be green, and the deploy
  health-check still runs — quick means live, not unverified.
- Never touch the auth wiring (src/auth/*, withAuth/bootstrapGate in
  src/app.ts) or the login/bootstrap flow.
- SPEED: batch independent tool calls in one turn, write files complete in one
  write_file, no exploratory reads beyond the files involved; target well
  under 15 turns total.
- finish still requires the one-line summary, one human-runnable check, and
  the verified-vs-assumed split.` : '';
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
The scaffold ships a shared app shell: \`public/base.css\` (header/nav, .card,
.btn, .badge, .stat, .field, table.list — all token-driven) and
\`public/app-shell.html\` (the authenticated home served at /). BUILD SCREENS ON
THIS SHELL: link /design.css + /base.css, reuse its classes, and add nav entries
to the shell's header — never hand-roll a parallel layout or restyle the shell.

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
${skillLines}${buildInstalledComponentsSection(installedComponents)}${buildComponentCatalogSection(components, { access: 'tool' })}${mvpSection}${quickSection}

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

# How to work
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
2. Read the relevant files to understand the current state.
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
   never stub the transport to force a plain finish.

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

Make the change; call finish only when the gates are green, or halt if you are blocked.`;
}

// The first user turn: the canned task instruction. Kept a pure formatter so the
// transcript shape is testable.
export function buildRunnerTask(instruction) {
  return `Task: ${String(instruction || '').trim()}`;
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
    return { summary: String(input?.summary || 'change complete'), acceptance, assumptions };
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
    if (c?.name === 'read_file') return `reading ${c.input?.path || 'a file'}`;
    if (c?.name === 'exec_in_container') return `running \`${String(c.input?.command || '').replace(/\s+/g, ' ').trim().slice(0, 60)}\``;
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

## Design fidelity (binding — reproduce the approved look)
The approved design's visual language is captured in \`state/design-tokens.json\`
(colors, typography, corner radius, spacing, shadow) with a ready stylesheet
rendered from it at \`state/design.css\`. Read both. The app MUST reproduce that
look, not a generic default: make the app load that stylesheet (serve it as a
static asset and link it, or import its tokens into the app's CSS) and style every
screen with those tokens — the same colors, fonts, radii, and component styling
the mockup used. Do not invent a different visual style. If the files are absent
(an older project), fall back to a clean, consistent look.
The scaffold ships a shared app shell: \`public/base.css\` (header/nav, .card,
.btn, .badge, .stat, .field, table.list — all token-driven) and
\`public/app-shell.html\` (the authenticated home served at /). BUILD SCREENS ON
THIS SHELL: link /design.css + /base.css, reuse its classes, and add nav entries
to the shell's header — never hand-roll a parallel layout or restyle the shell.

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
