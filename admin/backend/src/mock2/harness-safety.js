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

import { classifyEngineSpecifier, exceptionAllows, databaseRefusalText } from './database-exception-logic.js';

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

// ---- the application foundation (2026-10; docs/features/app-foundation.md) ----
//
// The guest's foundation stack (/opt/mock2-foundation, Compose project
// mock2-foundation: Postgres + pgvector, S3 storage, embeddings) is
// platform-owned, and its volumes ARE the app's data. A build never removes,
// stops or rewrites it, never deletes its volumes, and never reads the
// deployment master key (/etc/mock2-foundation/master.key) into a transcript.
// These apply to EVERY lane (run_terminal, exec_in_container, the SDK's Bash),
// so they live apart from the copilot-only denylist above. A pattern matches
// within one simple command (no ; & | or newline in between) unless noted.
const SEG = '[^;&|\\n]*';
const COMPOSE = '\\bdocker(?:-compose|\\s+compose)\\b';
const rx = (src) => new RegExp(src);
export const FOUNDATION_COMMAND_DENYLIST = Object.freeze([
  // docker compose … down … -v / --volumes — any compose project.
  { test: rx(`${COMPOSE}${SEG}\\bdown\\b${SEG}(?:\\s-[A-Za-z]*v[A-Za-z]*\\b|\\s--volumes\\b)`), why: 'removes the stack\'s volumes — the application\'s data' },
  { test: /\bdocker\s+volume\s+(?:rm|remove|prune)\b/, why: 'deletes Docker volumes — the application\'s data' },
  { test: /\bdocker\s+(?:system|container|image|builder|network)\s+prune\b/, why: 'prunes Docker state the foundation stack runs on' },
  { test: rx(`\\bdocker\\s+(?:container\\s+)?(?:rm|stop|kill)\\b${SEG}mock2[-_]foundation`), why: 'removes or stops a foundation container' },
  // docker stop $(docker ps -q) and the like: every container, the foundation's included.
  { test: /\bdocker\s+(?:container\s+)?(?:rm|stop|kill)\b[^;&\n]*(?:\$\(|`)/, why: 'stops or removes every container, the foundation\'s included' },
  // The foundation's compose project however it is named — -p mock2-foundation,
  // -f /opt/mock2-foundation/compose.yaml, or `cd /opt/mock2-foundation && …`
  // (the name may come before the compose call, so it is checked on its own).
  { test: (s) => /mock2[-_]foundation/.test(s) && rx(`${COMPOSE}${SEG}\\b(?:rm|down|stop|kill)\\b`).test(s), why: 'takes the foundation stack down' },
  { test: rx(`(?:\\brm|\\bmv|\\bcp|\\btee|\\btruncate|\\bsed\\s+-i|\\bchmod|\\bchown|\\bln|\\binstall|\\bdd|\\bunlink|\\bshred)\\b${SEG}/(?:opt/mock2-foundation|run/mock2-foundation|var/lib/docker)\\b`), why: 'changes platform-owned foundation files or Docker\'s data' },
  { test: />>?\s*\/(?:opt\/mock2-foundation|run\/mock2-foundation|var\/lib\/docker)\b/, why: 'writes platform-owned foundation files or Docker\'s data' },
  // Any reference at all: the deployment master key lives here and never enters a build transcript.
  { test: /\/etc\/mock2-foundation\b/, why: 'the deployment master key and foundation configuration are platform-only' },
]);

function matches(rule, s) {
  return typeof rule.test === 'function' ? rule.test(s) : rule.test.test(s);
}

// npm / pnpm / yarn / bun install|i|add <packages> — the packages named.
const INSTALL_RE = /(?:^|[\s;&|(`])(?:npm|pnpm|yarn|bun)\s+(?:--?[\w-]+(?:=\S+)?\s+)*(?:install|i|in|ins|inst|insta|instal|isnt|isnta|isntal|isntall|add)\b([^;&|\n]*)/g;

function packageNameOf(token) {
  let t = String(token || '').replace(/^['"]|['"]$/g, '').trim();
  if (!t || t.startsWith('-')) return null;
  const alias = t.match(/@npm:(.+)$/);           // alias@npm:real@1
  if (alias) t = alias[1];
  if (t.startsWith('npm:')) t = t.slice(4);
  if (/^(?:\.|\/|~|https?:|git[+:]|file:|github:)/.test(t)) return null;
  const at = t.indexOf('@', t.startsWith('@') ? 1 : 0); // strip the version
  return at > 0 ? t.slice(0, at) : t;
}

// refusedDatabaseInstall(cmd, { databaseException }) → null | { packages, reason }
export function refusedDatabaseInstall(cmd, { databaseException = null } = {}) {
  const hits = [];
  for (const m of String(cmd || '').matchAll(INSTALL_RE)) {
    for (const tok of m[1].trim().split(/\s+/)) {
      const name = packageNameOf(tok);
      const c = name ? classifyEngineSpecifier(name) : null;
      if (c && !exceptionAllows(c, databaseException)) hits.push(`${c.name} (${c.engine})`);
    }
  }
  if (!hits.length) return null;
  return { packages: hits, reason: `installing ${hits.join(', ')} is refused. ${databaseRefusalText()}` };
}

// foundationCommandPolicy(cmd, { databaseException }) → { ok, reason } — the
// rules every lane applies: no refused database package installs (a recorded
// SQLite exception, read by the host from mock2.db, allows the SQLite family)
// and nothing that removes, stops or rewrites the foundation stack.
export function foundationCommandPolicy(cmd, { databaseException = null } = {}) {
  const s = String(cmd || '');
  const install = refusedDatabaseInstall(s, { databaseException });
  if (install) return { ok: false, reason: install.reason };
  for (const rule of FOUNDATION_COMMAND_DENYLIST) {
    if (matches(rule, s)) return { ok: false, reason: `refused: ${rule.why} (the application foundation is platform-owned; docs/features/app-foundation.md)` };
  }
  return { ok: true };
}

// commandAllowed(cmd, { deny, allow, databaseException }) → { ok, reason }.
// deny defaults to the denylist above; an optional allow list further
// restricts to matching commands. The foundation policy always applies.
export function commandAllowed(cmd, { deny = DEFAULT_COMMAND_DENYLIST, allow = null, databaseException = null } = {}) {
  const s = String(cmd || '');
  if (!s.trim()) return { ok: false, reason: 'empty command' };
  for (const re of deny) {
    if (re.test(s)) return { ok: false, reason: `blocked by command policy (${re})` };
  }
  const foundation = foundationCommandPolicy(s, { databaseException });
  if (!foundation.ok) return foundation;
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
