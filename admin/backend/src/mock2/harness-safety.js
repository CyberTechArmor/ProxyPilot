// Mock2 copilot-harness SAFETY layer (pure decision layer; spec Part E). Native-
// free, unit-tested stub-first (risk R9): imports nothing that opens a DB, hits
// the network, or touches Incus. Ported from the reference harness bundle
// (safety.ts) and adapted to ProxyPilot: file-path safety is already enforced by
// runner.safeRel (relative, no traversal, inside APP_DIR), so this module owns
// the run_terminal COMMAND POLICY and SECRET REDACTION only.
//
// Note: the copilot harness runs every command inside the SAME network-fenced
// container the other harnesses use (egress only via the squid proxy), so the
// denylist is defence-in-depth, not the primary boundary — it stops an obviously
// destructive or exfiltrating command before it ever reaches the fence.

// Any match blocks the command. Mirrors the bundle's DEFAULT_DENY: destructive
// filesystem ops, pushes, arbitrary network fetches, privilege escalation, raw
// disk writes.
export const DEFAULT_COMMAND_DENYLIST = Object.freeze([
  /\brm\s+-rf?\s+\/(?!\w)/,          // rm -rf / (root)
  /\bgit\s+push\b/,                  // the runner never pushes
  /\bcurl\b|\bwget\b/,               // no arbitrary network fetches
  /\bsudo\b/,                        // no privilege escalation
  /\bmkfs\b|\bdd\s+if=/,             // no filesystem creation / raw copy
  />\s*\/dev\/(sd|nvme|disk)/,       // no raw disk writes
]);

// commandAllowed(cmd, { deny, allow }) → { ok, reason }. deny defaults to the
// denylist above; an optional allow list further restricts to matching commands.
export function commandAllowed(cmd, { deny = DEFAULT_COMMAND_DENYLIST, allow = null } = {}) {
  const s = String(cmd || '');
  if (!s.trim()) return { ok: false, reason: 'empty command' };
  for (const re of deny) {
    if (re.test(s)) return { ok: false, reason: `blocked by command policy (${re})` };
  }
  if (Array.isArray(allow) && allow.length && !allow.some((re) => re.test(s))) {
    return { ok: false, reason: 'not in allowlist' };
  }
  return { ok: true };
}

// Secret-shaped strings, masked before tool output reaches the model or the
// durable transcript. Conservative, high-signal shapes (from the bundle) plus
// Anthropic keys — never widen this into eating ordinary hex/base64 that would
// mangle real diffs.
const SECRET_PATTERNS = Object.freeze([
  /sk-ant-[A-Za-z0-9_-]{16,}/g,     // Anthropic keys (checked before the generic sk- shape)
  /sk-[A-Za-z0-9_-]{16,}/g,         // OpenAI-style keys
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,  // Slack tokens
  /ghp_[A-Za-z0-9]{20,}/g,          // GitHub tokens
  /AKIA[0-9A-Z]{16}/g,              // AWS access key id
]);

// Mask secret shapes in `text`. Pure; returns the input unchanged when clean.
export function redactSecrets(text) {
  let out = String(text ?? '');
  for (const re of SECRET_PATTERNS) out = out.replace(re, '[REDACTED]');
  return out;
}
