// Mock2 ASK-lane PURE decision layer. Native-free, unit-tested stub-first
// (risk R9): imports nothing that opens a DB, hits the network, or touches
// Incus.
//
// The ASK lane is the build chat's conversational mode: a question about the
// codebase, or a bounded OPERATIONAL task ("run the tests", "add a user to the
// database", "curl the health endpoint with the stored credentials") answered
// by a tool-loop over the SAME fenced container the builds use — WITHOUT the
// build ceremony. No audit gate, no checkpoint, no deploy, no change record:
// the ask must not modify the CODE (files, packages, schema, git), so there is
// nothing to record. Runtime actions against the RUNNING app and its data ARE
// in scope when the user asks for them — that's the difference between
// operating the app (ask) and changing the app (build). Code changes are
// explicitly out of scope — the answer directs the user to run a build.
//
// Cost containment mirrors the consult lane: bounded turns, bounded output,
// spend recorded to the quota ledger (cycle-less entries).
//
// Terminology (risk R7): nothing here is named "agent".

export const ASK_MAX_TURNS = 15;
export const ASK_MAX_TOKENS = 16000;
export const ASK_MAX_QUESTION_CHARS = 32000;

// A generous reservation for the quota check (the ask is refused when the
// project budget can't cover it, exactly like a cycle).
export function estimateAskTokens() {
  return { inputTokens: 20000, outputTokens: 4000 };
}

// The ask lane's tools — the runner's read/exec/inspect subset, NO write_file /
// materialize_component / run_gates. The lane operates the app; it never edits
// the code.
export const ASK_TOOLS = Object.freeze([
  {
    name: 'exec_in_container',
    description:
      'Run a non-interactive shell command inside the project container (network-fenced: egress only via the filtering proxy). Use it to run tests, hit the app\'s own API (e.g. curl localhost with credentials from .env), inspect processes/logs, query the project database, or perform an operational action the user asked for (e.g. insert a row, restart the app service). Returns combined stdout/stderr and the exit code.',
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
        path: { type: 'string', description: 'Path relative to the app directory, e.g. "src/app.ts".' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_component',
    description:
      'Inspect a component from the installation\'s component library: its integration notes plus sources (inline when small; larger components return a file manifest). Useful when the question is about an installed standard component (auth, bootstrap, LDAPS, …).',
    input_schema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'The component key, e.g. "proxypilot-auth".' },
      },
      required: ['key'],
      additionalProperties: false,
    },
  },
]);

export const ASK_TOOL_NAMES = Object.freeze(ASK_TOOLS.map((t) => t.name));

// ---- web search (Anthropic server-side tool) ----
//
// ProxyPilot's build fence blocks general egress, but the MODEL call is made
// host-side (model-client.js) and Anthropic's web_search is a SERVER tool —
// the search runs inside Anthropic's infrastructure during the API call, so it
// needs no fence egress and no extra credentials. It is therefore safe to offer
// wherever the connector is Anthropic. Other providers get no search tool (the
// entry would be rejected); the prompt tells the model whether search exists so
// it never hallucinates the capability.

export const WEB_SEARCH_FLAG = 'MOCK2_WEB_SEARCH'; // ask lane; default ON
export const RUNNER_WEB_SEARCH_FLAG = 'MOCK2_RUNNER_WEB_SEARCH'; // build runner; default OFF
export const WEB_SEARCH_MAX_USES = 5;

// webSearchServerTools — the raw server-tool entries to append to an Anthropic
// request, or [] (non-Anthropic provider, or the flag turns it off). `defaultOn`
// picks the lane's polarity: the ask lane defaults on (that's the point of the
// lane), the runner defaults off (builds should stay deterministic unless the
// operator opts in).
export function webSearchServerTools({ provider, env = {}, flag = WEB_SEARCH_FLAG, defaultOn = false, maxUses = WEB_SEARCH_MAX_USES } = {}) {
  if (provider !== 'anthropic') return [];
  const v = String(env?.[flag] ?? '').trim().toLowerCase();
  const on = v ? ['on', '1', 'true'].includes(v) : defaultOn;
  if (!on) return [];
  return [{ type: 'web_search_20250305', name: 'web_search', max_uses: maxUses }];
}

// ---- prompt ----

export function buildAskSystemPrompt({ projectName = 'this project', appDir = '/srv/app', webPort = 3000, webSearch = false, installedComponentsSection = '' } = {}) {
  return `You are the ProxyPilot project assistant for "${projectName}" — the build chat's
ASK mode. You answer questions about the project's codebase and run bounded
tasks on request: run the test suite, exercise an API endpoint with the
credentials already configured in the container, inspect logs or the database,
explain how something works — and perform OPERATIONAL actions the user asks
for against the running app and its data (e.g. add a user to the database,
call an admin API, re-run a seed script, restart the app service).

You are working against the project's fenced container. The working tree at
${appDir} is a TypeScript / Express / Drizzle app (app under src/, migrations in
migrations/, run contract in mock2.yaml); the app serves on port ${webPort}.
Credentials/config live in .env inside the container — use them in-place (e.g.
\`curl\` against localhost with a token from .env); NEVER print secret values
back into the chat. Refer to secrets by key name only.

HARD RULES — this is not a build:
- Do NOT modify the CODE: no editing files, no installing packages, no schema
  migrations, no git commands that change state. If the user asks for a code
  or config CHANGE, briefly say what it would involve and tell them to run it
  as a Quick update or build — the build lane audits, gates, and checkpoints
  changes; this lane must not.
- Operational data changes are allowed ONLY when the user explicitly asked for
  them, and prefer the app's own API over raw SQL (the API enforces the app's
  validation and hashing — e.g. create a user through the admin endpoint, not
  an INSERT, when one exists). Say exactly what you changed.
- NEVER destroy data in bulk: no DROP/TRUNCATE, no DELETE without a precise
  WHERE clause, nothing irreversible the user didn't spell out.
- Report command results honestly (exit codes, failures included). Never
  fabricate output.
${webSearch
    ? `- You have a web_search tool for things outside this project (API
  documentation, library versions, error messages). Cite what you used.`
    : `- You have NO internet/web search access — answer from the project tree and
  your own knowledge, and say so when something would need a doc lookup.`}
${installedComponentsSection}
Answer concisely and concretely, quoting file paths and command output where it
helps. When you have the answer, reply with it directly — no preamble.`;
}

// The first user turn.
export function buildAskTask(question) {
  return String(question || '').trim().slice(0, ASK_MAX_QUESTION_CHARS);
}

// Commands the ask lane refuses to run even if asked — the cheap, obvious
// CODE-mutation and bulk-destruction surface (the prompt is the real guard;
// this backstops the worst). Operational data changes (INSERT/UPDATE, a
// targeted DELETE with a WHERE clause, service restarts) are deliberately NOT
// here — the lane may operate the running app on request; it may not change
// the code or destroy data wholesale.
const FORBIDDEN_RE = /\b(rm\s+-rf?|git\s+(push|commit|reset|checkout|clean)|npm\s+(install|uninstall|update)|npx\s+drizzle|drop\s+(table|database|schema)|truncate\s+table|mkfs|shutdown|reboot)\b/i;
// A DELETE with no WHERE clause wipes the table — refuse it outright (a
// scoped, user-requested delete passes; the prompt requires the explicit ask).
const BULK_DELETE_RE = /\bdelete\s+from\s+\S+\s*(?:;|"|'|$)/i;
export function askCommandAllowed(command) {
  const c = String(command || '');
  if (!c.trim()) return { ok: false, reason: 'empty command' };
  if (FORBIDDEN_RE.test(c)) return { ok: false, reason: 'this command changes the project code or destroys data in bulk — run it as a build instead.' };
  if (BULK_DELETE_RE.test(c) && !/\bwhere\b/i.test(c)) return { ok: false, reason: 'a DELETE without a WHERE clause wipes the table — scope it to specific rows, or run it as a build.' };
  return { ok: true };
}
