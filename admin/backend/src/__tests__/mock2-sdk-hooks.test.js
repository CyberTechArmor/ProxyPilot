// Phase 1 SDK hook layer: the PreToolUse guardrail predicates + the deny-decision
// schema. These gate real enforcement (protected paths, destructive shell) and the
// exact block shape the installed @anthropic-ai/claude-agent-sdk expects, so pin
// them. Native-free (no SDK, no DB) — pure predicates + a fake logEvent.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isProtectedPath, isBlockedCommand, makePreToolUseGuard, makePostToolUseAudit, buildHookOptions,
} from '../mock2/runner-sdk-hooks.js';

test('isProtectedPath: governed/secret/history/CI paths are protected (absolute or relative)', () => {
  for (const p of [
    '.env', '.env.production', '/tmp/x/.env',
    'state/deviations/12.json', '/tmp/co/state/deviations/x',
    'state/changes/7.json',
    '.github/workflows/ci.yml',
    '.claude/CLAUDE.md', 'CLAUDE.md', '/tmp/co/CLAUDE.md',
  ]) assert.equal(isProtectedPath(p), true, `expected protected: ${p}`);
});

test('isProtectedPath: normal source + the run contract are editable', () => {
  for (const p of [
    'src/app.ts', 'src/auth/routes.ts', 'mock2.yaml', 'package.json',
    'public/index.html', 'state/rules.md', 'migrations/001_init.sql',
    'state/design.css', // env in the middle of a word must not trip .env
  ]) assert.equal(isProtectedPath(p), false, `expected editable: ${p}`);
});

test('isBlockedCommand: destructive shell is blocked', () => {
  for (const c of [
    'rm -rf /', 'rm -rf ~', 'sudo rm  -rf   /var',
    'git push --force origin main', 'git push -f',
    'psql -c "DROP DATABASE app"', 'TRUNCATE users',
  ]) assert.equal(isBlockedCommand(c), true, `expected blocked: ${c}`);
});

test('isBlockedCommand: ordinary + test-table commands are allowed', () => {
  for (const c of [
    'npm test', 'tsc --noEmit', 'ls -la src', 'git push origin main',
    'rm -rf ./dist', 'rm -rf node_modules',
    'TRUNCATE users_test', 'grep -r TODO src',
  ]) assert.equal(isBlockedCommand(c), false, `expected allowed: ${c}`);
});

test('makePreToolUseGuard: denies a protected Write with the SDK deny schema', async () => {
  const events = [];
  const guard = makePreToolUseGuard({ logEvent: (k, d) => events.push({ k, d }), now: () => 'T' });
  const out = await guard({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: '/co/.env' } });
  // Exact shape the installed SDK version expects (NOT { decision:'block' }).
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.ok(out.hookSpecificOutput.permissionDecisionReason.includes('.env'));
  assert.ok(out.systemMessage);
  assert.equal(events[0].k, 'guardrail');
});

test('makePreToolUseGuard: allows an ordinary edit (returns {})', async () => {
  const guard = makePreToolUseGuard({ logEvent: () => {}, now: () => 'T' });
  const out = await guard({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: '/co/src/app.ts' } });
  assert.deepEqual(out, {});
});

test('makePreToolUseGuard: fails OPEN on a malformed input (never wedges the loop)', async () => {
  const guard = makePreToolUseGuard({ logEvent: () => { throw new Error('boom'); }, now: () => 'T' });
  const out = await guard({ tool_name: 'Write', tool_input: { file_path: '/co/.env' } });
  assert.deepEqual(out, {}); // guard swallowed the logEvent throw and allowed
});

test('makePostToolUseAudit: records mutations and always returns {}', async () => {
  const events = [];
  const audit = makePostToolUseAudit({ logEvent: (k, d) => events.push({ k, d }), now: () => 'T' });
  assert.deepEqual(await audit({ tool_name: 'Edit', tool_input: { file_path: 'src/x.ts', content: 'abc' } }), {});
  assert.deepEqual(await audit({ tool_name: 'Bash', tool_input: { command: 'npm test' } }), {});
  assert.equal(events.length, 2);
  assert.equal(events[0].d.meta.event, 'file.mutated');
  assert.equal(events[0].d.meta.bytes, 3);
  assert.equal(events[1].d.meta.event, 'bash.ran');
});

test('buildHookOptions: registers guard + audit on the mutating tools', () => {
  const opts = buildHookOptions({ logEvent: () => {}, now: () => 'T' });
  assert.equal(opts.hooks.PreToolUse[0].matcher, 'Edit|Write|Bash');
  assert.equal(opts.hooks.PostToolUse[0].matcher, 'Edit|Write|Bash');
  assert.equal(typeof opts.hooks.PreToolUse[0].hooks[0], 'function');
  assert.equal(typeof opts.hooks.PostToolUse[0].hooks[0], 'function');
});
