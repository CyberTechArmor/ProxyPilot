// The three self-update MCP tools: advertised, dispatched, confirm-gated,
// policy-gated, and the instructions tell the client the working order.
// Source-level where routes/mcp.js is involved (it pulls in the native DB).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { MCP_TOOLS, MCP_SERVER_INSTRUCTIONS } from '../lib/mcp-logic.js';

const routeSrc = readFileSync(new URL('../routes/mcp.js', import.meta.url), 'utf8');
const policy = JSON.parse(readFileSync(new URL('../lib/mcp-policy/self-update-allowlist.json', import.meta.url), 'utf8'));
const byName = new Map(MCP_TOOLS.map((t) => [t.name, t]));

test('the three tools are advertised with the right gates', () => {
  for (const n of ['check_proxypilot_update', 'get_proxypilot_update_status', 'run_proxypilot_update']) {
    assert.ok(byName.has(n), `missing tool ${n}`);
  }
  const check = byName.get('check_proxypilot_update');
  assert.deepEqual(check.inputSchema.required ?? [], []);
  assert.match(check.description, /Read-only/);
  assert.match(check.description, /Mock2 standards/);
  const status = byName.get('get_proxypilot_update_status');
  assert.ok(status.inputSchema.properties.id && status.inputSchema.properties.log_tail_bytes);
  assert.match(status.description, /unreachable for ~1–2 minutes/);
  const run = byName.get('run_proxypilot_update');
  assert.deepEqual(run.inputSchema.required, ['confirm']);
  assert.ok(run.inputSchema.properties.rebuild);
  assert.equal(run.inputSchema.additionalProperties, false, 'no free-form flags on the wire');
  assert.ok(!('flags' in run.inputSchema.properties), 'the client never chooses flags — rebuild is the only knob');
  assert.match(run.description, /confirm with the user first/i);
  assert.match(run.description, /uncommitted local changes/);
  assert.match(run.description, /self-update-allowlist\.json/);
});

test('every self-update tool is dispatched', () => {
  const table = routeSrc.slice(routeSrc.indexOf('const TOOL_HANDLERS = {'));
  const body = table.slice(0, table.indexOf('\n};'));
  for (const n of ['check_proxypilot_update', 'get_proxypilot_update_status', 'run_proxypilot_update']) {
    assert.ok(new RegExp(`\\n  ${n}:`).test(body), `${n} is not dispatched`);
  }
});

test('run_proxypilot_update: policy gate, then confirm gate, then refusals, then the request — never --discard-local', () => {
  const fn = routeSrc.slice(routeSrc.indexOf('async function toolRunProxypilotUpdate'), routeSrc.indexOf('const TOOL_HANDLERS = {'));
  const at = (s) => { const i = fn.indexOf(s); assert.ok(i >= 0, `missing ${s}`); return i; };
  assert.ok(at('SELF_UPDATE_POLICY.enabled !== true') < at('args.confirm !== true'), 'policy before confirm');
  assert.ok(at('args.confirm !== true') < at('updateStartRefusal({ installed, progress'), 'confirm before the host is even asked');
  assert.ok(at('updateStartRefusal({ installed, progress') < at('selfUpdateStart('), 'refusals before the request');
  assert.match(fn, /MCP_RUN_CONFIRM_MESSAGE/);
  assert.match(fn, /'SELF_UPDATE_REQUESTED'/);
  assert.match(fn, /'SELF_UPDATE_REFUSED'/);
  assert.match(fn, /via: 'mcp'/);
  assert.match(fn, /flagsFromOptions\(\{ rebuild: args\.rebuild === true \}\)/);
  assert.doesNotMatch(fn, /discard-local/);
  assert.match(fn, /get_proxypilot_update_status/, 'the result names the next step');
});

test('the policy file is the enforcement source: enabled by default, dirty and running refuse, discard is absent', () => {
  assert.equal(policy.enabled, true);
  assert.equal(policy.tools.run_proxypilot_update.gate, 'confirm');
  assert.deepEqual(policy.tools.run_proxypilot_update.flags, ['--rebuild']);
  for (const r of ['dirty', 'running', 'agent_unreachable', 'not_configured']) {
    assert.ok(policy.tools.run_proxypilot_update.refuse_when.includes(r), `refuse_when must list ${r}`);
  }
  assert.equal(policy.tools.check_proxypilot_update.mutating, false);
  assert.equal(policy.tools.get_proxypilot_update_status.mutating, false);
  assert.ok(policy.explicitly_absent.discard_local);
  assert.ok(policy.explicitly_absent.auto_update);
  assert.match(routeSrc, /self-update-allowlist\.json/);
});

test('the instructions add SELF-UPDATE after GIT REMOTES and keep the working order first', () => {
  const at = (s) => MCP_SERVER_INSTRUCTIONS.indexOf(s);
  assert.ok(at('SELF-UPDATE:') > at('GIT REMOTES:'), 'self-update sentence comes after git remotes');
  assert.ok(at('project_map') < at('apply_project_patch') && at('apply_project_patch') < at('SELF-UPDATE:'), 'working order stays first');
  assert.match(MCP_SERVER_INSTRUCTIONS, /run_proxypilot_update\(\{ confirm: true \}\)/);
  assert.match(MCP_SERVER_INSTRUCTIONS, /ask the operator first/);
  assert.match(MCP_SERVER_INSTRUCTIONS, /Never an automatic update/);
});
