// Mock2 — Claude Agent SDK hook layer (Phase 1 enforcement + audit seed).
// Ported to ESM JS from the ProxyPilot hooks skeleton; the DENY schema is pinned
// to the installed @anthropic-ai/claude-agent-sdk (verified against the hooks docs
// for v0.3.x): a PreToolUse block is
//   { hookSpecificOutput: { hookEventName, permissionDecision: 'deny', permissionDecisionReason } }
// — NOT the older { decision:'block', reason } shape the skeleton warned about. A
// hook `deny` wins even under permissionMode:'bypassPermissions' (deny > allow).
//
// These hooks plug into query()'s `hooks` option WITHOUT touching the loop:
//   PreToolUse  -> block edits to protected/governed paths + destructive shell.
//   PostToolUse -> append an audit record for every Edit/Write/Bash.
// Audit + guardrail events are routed through the injected `logEvent` into the
// DURABLE cycle-events transcript (migration 512) — never a file in the checkout,
// so nothing pollutes the project's committed tree. The PostToolUse audit is the
// Phase-3 seed; the PreToolUse guard is day-one enforcement.
//
// SECURITY NOTE (Phase-1): in the SDK path the model's Bash runs on the
// ORCHESTRATOR host inside the local checkout — NOT inside the fenced container the
// hand-rolled runner uses. This guard is a mitigation, not a sandbox. See
// docs/agent-sdk-migration.md ("SDK Bash executes on the orchestrator").
//
// Terminology (risk R7): nothing here is named "agent".

// Paths the SDK runner must never edit (secrets, governed content, hash-chained
// history, CI). file_path from the SDK is usually absolute (cwd-joined), so the
// `(^|/)` anchors match a segment anywhere in the path. mock2.yaml is deliberately
// NOT protected — the runner legitimately edits the run contract.
const PROTECTED_PATH_PATTERNS = [
  /(^|\/)\.env(\.|$)/i,           // secrets
  /(^|\/)state\/deviations\//i,   // admin-set, not agent-set
  /(^|\/)state\/changes\//i,      // hash-chained change records — must not be forged
  /(^|\/)\.github\//i,            // CI
  /(^|\/)\.claude\//i,            // our injected governance (ephemeral)
  /(^|\/)CLAUDE\.md$/i,           // constitution is governed, not self-edited
];

// Destructive shell an autonomous cycle must never run — and here it matters more
// than usual: SDK Bash runs on the orchestrator host, not in the fenced container.
const BLOCKED_BASH_PATTERNS = [
  /\brm\s+-rf\s+[/~]/,               // rm -rf / or ~
  /\bgit\s+push\b.*\s(-f|--force)\b/, // force push
  /\bDROP\s+DATABASE\b/i,
  /\bTRUNCATE\b(?!.*_test)/i,        // allow truncating *_test tables only
  /:\(\)\s*\{\s*:\s*\|\s*:/,         // fork bomb
];

function toolNameOf(input) { return input?.tool_name ?? input?.tool ?? 'unknown'; }
function toolInputOf(input) { return input?.tool_input ?? {}; }

// The pinned deny decision for this SDK version. `reason` reaches the model
// (permissionDecisionReason) so it stops retrying; `systemMessage` surfaces it.
function denyDecision(input, reason) {
  return {
    systemMessage: reason,
    hookSpecificOutput: {
      hookEventName: input?.hook_event_name || 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}

// PostToolUse: immutable-ish audit into the cycle-events log. The tool already ran
// (PostToolUse records, it does not undo). Never throws — an audit failure must not
// interrupt the loop.
export function makePostToolUseAudit(ctx) {
  return async (input) => {
    try {
      const tool = toolNameOf(input);
      const ti = toolInputOf(input);
      if (tool === 'Edit' || tool === 'Write') {
        ctx.logEvent('audit', { role: 'system', content: `${tool} ${ti.file_path || ''}`.trim(), meta: { event: 'file.mutated', tool, file: ti.file_path, bytes: typeof ti.content === 'string' ? ti.content.length : undefined, ts: ctx.now() } });
      } else if (tool === 'Bash') {
        ctx.logEvent('audit', { role: 'system', content: `Bash: ${String(ti.command || '').slice(0, 400)}`, meta: { event: 'bash.ran', command: ti.command, ts: ctx.now() } });
      }
    } catch { /* audit is best-effort */ }
    return {}; // allow / no change
  };
}

// PreToolUse: hard guardrails. Runs BEFORE the tool executes, so a deny actually
// prevents it. Never throws (an unhandled throw can interrupt the loop) — on an
// internal error it fails OPEN (allow) rather than wedging the cycle, since the
// gate battery is still the load-bearing check.
export function makePreToolUseGuard(ctx) {
  return async (input) => {
    try {
      const tool = toolNameOf(input);
      const ti = toolInputOf(input);
      if (tool === 'Edit' || tool === 'Write') {
        const rel = String(ti.file_path ?? '');
        if (PROTECTED_PATH_PATTERNS.some((re) => re.test(rel))) {
          ctx.logEvent('guardrail', { role: 'system', content: `blocked ${tool} → ${rel}`, meta: { event: 'guardrail.blocked', tool, file: rel, reason: 'protected_path', ts: ctx.now() } });
          return denyDecision(input, `Editing \`${rel}\` is not permitted: protected/governed path (constitution §7 — deviations, secrets, CI, and the change ledger are set outside the build).`);
        }
      }
      if (tool === 'Bash') {
        const cmd = String(ti.command ?? '');
        if (BLOCKED_BASH_PATTERNS.some((re) => re.test(cmd))) {
          ctx.logEvent('guardrail', { role: 'system', content: `blocked Bash: ${cmd.slice(0, 200)}`, meta: { event: 'guardrail.blocked', tool, command: cmd, reason: 'destructive_command', ts: ctx.now() } });
          return denyDecision(input, `Refused: \`${cmd}\` matches a blocked destructive pattern.`);
        }
      }
    } catch { /* fail open — never wedge the cycle on a guard bug */ }
    return {}; // allow
  };
}

// buildHookOptions(ctx) → the `hooks` fragment for query() options.
//   ctx = { cycleId, projectId, actorUserId, repoRoot, logEvent, now }
// Matchers are the documented exact-list form (tool names). One guard + one audit,
// both scoped to the mutating tools.
export function buildHookOptions(ctx) {
  return {
    hooks: {
      PreToolUse: [{ matcher: 'Edit|Write|Bash', hooks: [makePreToolUseGuard(ctx)] }],
      PostToolUse: [{ matcher: 'Edit|Write|Bash', hooks: [makePostToolUseAudit(ctx)] }],
    },
  };
}

// Exported for unit tests (native-free): the pure predicates behind the guard.
export function isProtectedPath(rel) {
  return PROTECTED_PATH_PATTERNS.some((re) => re.test(String(rel || '')));
}
export function isBlockedCommand(cmd) {
  return BLOCKED_BASH_PATTERNS.some((re) => re.test(String(cmd || '')));
}
