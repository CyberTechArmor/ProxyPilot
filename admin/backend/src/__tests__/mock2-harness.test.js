// Per-project agent harness (mock2_projects.harness, migration 533): the pure
// selection + configuration layer. These tests carry the guarantees the feature
// promises:
//   - an EXISTING project (no harness set) defaults to the ProxyPilot harness
//     and behaves exactly as before (including the legacy BUILD_RUNNER flag);
//   - an explicit per-project choice always wins over the global flag;
//   - the Claude harness ships the required `search` (WebSearch) and
//     `pull-website` (WebFetch) subagents, each scoped to its ONE network tool;
//   - the query() option shape wires those subagents in without interactive
//     prompts, while the main loop's tool set stays the read/edit/run set;
//   - key resolution (connector secret → server-env ANTHROPIC_API_KEY) is
//     decided without the decision objects ever carrying key material.
//
// Everything here is native-free (no better-sqlite3, no SDK binary): harness.js
// dynamic-imports the runners only inside runTask, so the factory itself is
// unit-testable at the module boundary like the rest of the mock2 logic layer.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveHarness, resolveClaudeAuth, claudeHarnessModel, CLAUDE_HARNESS_FALLBACK_MODEL,
  sdkQueryOptions, sdkSubagents, SDK_SUBAGENTS, SDK_ALLOWED_TOOLS, SDK_SUBAGENT_TOOLS, SDK_WEB_TOOLS,
} from '../mock2/runner-logic.js';
import { HARNESSES, normalizeHarness, publicProjectShape } from '../mock2/project-logic.js';
import {
  harnessForProject, ProxyPilotHarness, ClaudeHarness, claudeHarnessStatus,
} from '../mock2/harness.js';

// ---- vocabulary ----

test('HARNESSES / normalizeHarness: the two harnesses, unknowns degrade to null', () => {
  assert.deepEqual([...HARNESSES], ['proxypilot', 'claude']);
  assert.equal(normalizeHarness('proxypilot'), 'proxypilot');
  assert.equal(normalizeHarness('claude'), 'claude');
  assert.equal(normalizeHarness('  Claude  '), 'claude'); // case/space tolerant
  assert.equal(normalizeHarness(null), null);
  assert.equal(normalizeHarness(undefined), null);
  assert.equal(normalizeHarness(''), null);
  assert.equal(normalizeHarness('copilot'), null); // unknown value never selects a runner
});

// ---- the factory decision ----

test('resolveHarness: existing project (no harness set) defaults to ProxyPilot', () => {
  assert.equal(resolveHarness({}, {}), 'proxypilot');
  assert.equal(resolveHarness({ harness: null }, {}), 'proxypilot');
  assert.equal(resolveHarness({ harness: '' }, {}), 'proxypilot');
  assert.equal(resolveHarness(undefined, {}), 'proxypilot');
});

test('resolveHarness: explicit per-project choice wins', () => {
  assert.equal(resolveHarness({ harness: 'claude' }, {}), 'claude');
  assert.equal(resolveHarness({ harness: 'proxypilot' }, {}), 'proxypilot');
  // ...even against the legacy global flag: a project pinned to ProxyPilot
  // stays on ProxyPilot when BUILD_RUNNER=sdk is set.
  assert.equal(resolveHarness({ harness: 'proxypilot' }, { BUILD_RUNNER: 'sdk' }), 'proxypilot');
  assert.equal(resolveHarness({ harness: 'claude' }, { BUILD_RUNNER: '' }), 'claude');
});

test('resolveHarness: no explicit choice falls back to the legacy BUILD_RUNNER flag (behavior identical to before)', () => {
  assert.equal(resolveHarness({}, { BUILD_RUNNER: 'sdk' }), 'claude');
  assert.equal(resolveHarness({ harness: 'bogus' }, { BUILD_RUNNER: 'sdk' }), 'claude');
  assert.equal(resolveHarness({}, { BUILD_RUNNER: 'anything-else' }), 'proxypilot');
});

test('harnessForProject: returns the right implementation per project', () => {
  const def = harnessForProject({ id: 1 }, {});
  assert.ok(def instanceof ProxyPilotHarness);
  assert.equal(def.name, 'proxypilot');
  assert.equal(typeof def.runTask, 'function');

  const claude = harnessForProject({ id: 1, harness: 'claude' }, {});
  assert.ok(claude instanceof ClaudeHarness);
  assert.equal(claude.name, 'claude');
  assert.equal(typeof claude.runTask, 'function');

  // Legacy flag still honored for unset projects; explicit choice beats it.
  assert.ok(harnessForProject({ id: 1 }, { BUILD_RUNNER: 'sdk' }) instanceof ClaudeHarness);
  assert.ok(harnessForProject({ id: 1, harness: 'proxypilot' }, { BUILD_RUNNER: 'sdk' }) instanceof ProxyPilotHarness);
});

// ---- the API response shape ----

test('publicProjectShape: harness surfaces with the ProxyPilot default for untouched projects', () => {
  const base = { id: 7, name: 'p', lifecycle: 'active' };
  assert.equal(publicProjectShape(base, {}).harness, 'proxypilot');
  assert.equal(publicProjectShape(base, {}).harness_choice, null);
  assert.equal(publicProjectShape({ ...base, harness: 'claude' }, {}).harness, 'claude');
  assert.equal(publicProjectShape({ ...base, harness: 'claude' }, {}).harness_choice, 'claude');
  // Install default (legacy flag) is injected by the caller, never re-derived here.
  assert.equal(publicProjectShape(base, { defaultHarness: 'claude' }).harness, 'claude');
  assert.equal(publicProjectShape(base, { defaultHarness: 'claude' }).harness_choice, null);
});

// ---- Claude harness subagents ----

test('SDK_SUBAGENTS: exactly search + pull-website, each scoped to its one network tool', () => {
  assert.deepEqual(Object.keys(SDK_SUBAGENTS).sort(), ['pull-website', 'search']);
  assert.deepEqual([...SDK_SUBAGENTS.search.tools], ['WebSearch']);
  assert.deepEqual([...SDK_SUBAGENTS['pull-website'].tools], ['WebFetch']);
  for (const a of Object.values(SDK_SUBAGENTS)) {
    assert.ok(a.description.length > 20, 'description tells the model when to delegate');
    assert.ok(a.prompt.length > 20, 'prompt defines the subagent role');
    // No file-mutation or shell escape through a subagent.
    for (const t of a.tools) assert.ok(!['Bash', 'Write', 'Edit'].includes(t));
  }
});

test('sdkSubagents(): a fresh mutable copy each call (frozen constant never handed to the SDK)', () => {
  const a = sdkSubagents();
  const b = sdkSubagents();
  assert.notEqual(a, b);
  assert.notEqual(a.search, b.search);
  assert.deepEqual(a, b);
  a.search.tools.push('Bash'); // mutating a copy must not leak into the pinned config
  assert.deepEqual([...SDK_SUBAGENTS.search.tools], ['WebSearch']);
  assert.deepEqual(sdkSubagents().search.tools, ['WebSearch']);
});

// ---- query() option shape (the SDK smoke: what the harness hands the loop) ----

test('sdkQueryOptions: subagents attached, delegation allowlisted, no interactive prompts', () => {
  const env = { ANTHROPIC_API_KEY: 'k' };
  const o = sdkQueryOptions({ cwd: '/tmp/x', model: 'claude-opus-4-8', maxTurns: 200, env });
  assert.equal(o.cwd, '/tmp/x');
  assert.equal(o.model, 'claude-opus-4-8');
  assert.equal(o.maxTurns, 200);
  assert.equal(o.env, env);
  // 'dontAsk': allowlisted tools run unprompted, everything else is DENIED.
  // Never 'bypassPermissions' — the CLI refuses that mode under root/sudo, and
  // the backend runs as root on standard installs.
  assert.equal(o.permissionMode, 'dontAsk');
  assert.deepEqual(o.settingSources, ['project']);
  // Allowlist: read/edit/run set + subagent delegation + the subagents' web
  // tools ('dontAsk' permissions are global, so WebSearch/WebFetch must be
  // allowlisted for the subagents to run them; which agent can CALL them is
  // scoped by each subagent's own tools list).
  for (const t of SDK_ALLOWED_TOOLS) assert.ok(o.allowedTools.includes(t));
  for (const t of SDK_SUBAGENT_TOOLS) assert.ok(o.allowedTools.includes(t));
  for (const t of SDK_WEB_TOOLS) assert.ok(o.allowedTools.includes(t));
  // Both required subagents ride along.
  assert.deepEqual(Object.keys(o.agents).sort(), ['pull-website', 'search']);
  assert.deepEqual(o.agents.search.tools, ['WebSearch']);
  assert.deepEqual(o.agents['pull-website'].tools, ['WebFetch']);
  // Resume only when a session exists.
  assert.ok(!('resume' in o));
  assert.equal(sdkQueryOptions({ cwd: '/t', model: 'm', maxTurns: 1, env, resumeSessionId: 'sess-1' }).resume, 'sess-1');
});

// ---- key resolution (pay-as-you-go API key; server-side only) ----

test('resolveClaudeAuth: connector secret first, then server-env ANTHROPIC_API_KEY', () => {
  assert.deepEqual(resolveClaudeAuth({ provider: 'anthropic', hasConnectorKey: true, hasEnvKey: true }),
    { ok: true, source: 'connector' });
  assert.deepEqual(resolveClaudeAuth({ provider: 'anthropic', hasConnectorKey: true, hasEnvKey: false }),
    { ok: true, source: 'connector' });
  assert.deepEqual(resolveClaudeAuth({ provider: 'openai', hasConnectorKey: true, hasEnvKey: true }),
    { ok: true, source: 'env' }); // a non-Anthropic connector key is never used
  assert.deepEqual(resolveClaudeAuth({ provider: 'anthropic', hasConnectorKey: false, hasEnvKey: true }),
    { ok: true, source: 'env' });
});

test('resolveClaudeAuth: no usable key is a clear, actionable failure', () => {
  const v = resolveClaudeAuth({ provider: 'openai', hasConnectorKey: false, hasEnvKey: false });
  assert.equal(v.ok, false);
  assert.equal(v.source, null);
  assert.match(v.reason, /ANTHROPIC_API_KEY/);
  assert.match(v.reason, /Anthropic connector/);
  assert.deepEqual(resolveClaudeAuth(), { ...v }); // no input at all → same failure
});

test('claudeHarnessStatus: booleans/labels only — key material never appears', () => {
  const readyOk = { ok: true, connector: { provider: 'anthropic' }, model: 'claude-opus-4-8', apiKey: 'sk-ant-SECRET' };
  const s1 = claudeHarnessStatus({ ready: readyOk, env: {} });
  assert.deepEqual(s1, { configured: true, source: 'connector', reason: null });
  assert.ok(!JSON.stringify(s1).includes('SECRET'));

  const s2 = claudeHarnessStatus({ ready: { ok: false, reason: 'no slot' }, env: { ANTHROPIC_API_KEY: 'sk-ant-ENVSECRET' } });
  assert.deepEqual(s2, { configured: true, source: 'env', reason: null });
  assert.ok(!JSON.stringify(s2).includes('ENVSECRET'));

  const s3 = claudeHarnessStatus({ ready: null, env: {} });
  assert.equal(s3.configured, false);
  assert.match(s3.reason, /ANTHROPIC_API_KEY/);

  // Whitespace-only env key is not a key.
  assert.equal(claudeHarnessStatus({ ready: { ok: false }, env: { ANTHROPIC_API_KEY: '   ' } }).configured, false);
});

test('claudeHarnessModel: slot model on an Anthropic slot, pinned fallback otherwise', () => {
  assert.equal(claudeHarnessModel({ provider: 'anthropic', slotModel: 'claude-sonnet-5', env: {} }), 'claude-sonnet-5');
  assert.equal(claudeHarnessModel({ provider: 'openai', slotModel: 'gpt-x', env: {} }), CLAUDE_HARNESS_FALLBACK_MODEL);
  assert.equal(claudeHarnessModel({ provider: 'openai', slotModel: 'gpt-x', env: { CLAUDE_HARNESS_MODEL: 'claude-haiku-4-5' } }), 'claude-haiku-4-5');
  assert.equal(claudeHarnessModel({}), CLAUDE_HARNESS_FALLBACK_MODEL);
});
