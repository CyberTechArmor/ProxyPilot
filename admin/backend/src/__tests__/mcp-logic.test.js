// MCP server pure layer + project-clone decision logic.
// Native-free (no better-sqlite3): everything under test lives in
// lib/mcp-logic.js and mock2/clone-logic.js.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MCP_PROTOCOL_VERSION, MCP_KNOWN_VERSIONS, MCP_TOOLS,
  rpcResult, rpcError, toolResult,
  mintMcpToken, hashMcpToken, looksLikeMcpToken, tokenFromRequest,
  mintUploadTicket, looksLikeUploadTicket,
  startupCandidates,
} from '../lib/mcp-logic.js';
import { normalizeCloneMode, cloneCopyPatch, cloneSourceError } from '../mock2/clone-logic.js';

// ---- tokens ----

test('mcp tokens: mint shape, hash stability, and request extraction', () => {
  const token = mintMcpToken();
  assert.ok(looksLikeMcpToken(token), token);
  assert.equal(hashMcpToken(token), hashMcpToken(token));
  assert.notEqual(hashMcpToken(token), hashMcpToken(mintMcpToken()));

  // Bearer header wins; tokenized URL path is the fallback.
  assert.equal(tokenFromRequest({ authorization: `Bearer ${token}` }), token);
  assert.equal(tokenFromRequest({ pathToken: token }), token);
  assert.equal(tokenFromRequest({ authorization: 'Bearer nonsense', pathToken: token }), token);
  assert.equal(tokenFromRequest({}), null);
  assert.equal(tokenFromRequest({ authorization: 'Basic dXNlcjpwdw==' }), null);
});

test('mcp upload tickets: shape check rejects arbitrary strings', () => {
  const t = mintUploadTicket();
  assert.ok(looksLikeUploadTicket(t), t);
  assert.equal(looksLikeUploadTicket('../../etc/passwd'), false);
  assert.equal(looksLikeUploadTicket('ppup_short'), false);
});

// ---- JSON-RPC envelopes ----

test('rpc helpers produce spec-shaped envelopes', () => {
  assert.deepEqual(rpcResult(3, { ok: true }), { jsonrpc: '2.0', id: 3, result: { ok: true } });
  const err = rpcError(4, -32601, 'nope');
  assert.equal(err.error.code, -32601);
  assert.equal(err.id, 4);
  // Missing id normalizes to null (spec: error responses to unparseable
  // requests carry id null).
  assert.equal(rpcError(undefined, -32700, 'parse').id, null);
});

test('toolResult wraps data as a text content block; isError marks failures', () => {
  const ok = toolResult({ a: 1 });
  assert.equal(ok.isError, false);
  assert.equal(ok.content[0].type, 'text');
  assert.match(ok.content[0].text, /"a": 1/);
  const bad = toolResult('broken', { isError: true });
  assert.equal(bad.isError, true);
  assert.equal(bad.content[0].text, 'broken');
});

// ---- tool catalog ----

test('tool catalog: every tool has a name, description, and object schema', () => {
  assert.ok(MCP_TOOLS.length >= 10);
  const names = new Set();
  for (const t of MCP_TOOLS) {
    assert.ok(t.name && !names.has(t.name), `duplicate/missing name: ${t.name}`);
    names.add(t.name);
    assert.ok(t.description.length > 20, `${t.name} needs a real description`);
    assert.equal(t.inputSchema.type, 'object');
  }
  // The two-phase deploy pairs both exist for both surfaces.
  for (const required of [
    'list_static_sites', 'inspect_static_site_zip', 'apply_static_site_zip',
    'list_lxc_containers', 'inspect_lxc_zip', 'apply_lxc_zip',
    'read_lxc_file', 'write_lxc_file', 'rerun_startup',
    'list_projects', 'send_project_build', 'clone_project', 'create_upload_ticket',
  ]) {
    assert.ok(names.has(required), `missing tool ${required}`);
  }
});

test('protocol versions: ours is among the known list', () => {
  assert.ok(MCP_KNOWN_VERSIONS.includes(MCP_PROTOCOL_VERSION));
});

test('startupCandidates finds .sh files and the startup.sh default', () => {
  const entries = [
    { path: 'index.html', isDirectory: false },
    { path: 'startup.sh', isDirectory: false },
    { path: 'scripts/build.sh', isDirectory: false },
    { path: 'scripts', isDirectory: true },
  ];
  const c = startupCandidates(entries);
  assert.deepEqual(c.scripts, ['startup.sh', 'scripts/build.sh']);
  assert.equal(c.defaultScript, 'startup.sh');
  assert.equal(startupCandidates([{ path: 'a.txt', isDirectory: false }]).defaultScript, null);
});

// ---- clone logic ----

test('normalizeCloneMode accepts fresh/full and rejects everything else', () => {
  assert.equal(normalizeCloneMode('fresh'), 'fresh');
  assert.equal(normalizeCloneMode(' FULL '), 'full');
  assert.equal(normalizeCloneMode('database'), null);
  assert.equal(normalizeCloneMode(''), null);
});

test('cloneCopyPatch carries settings, never identity or runtime state', () => {
  const patch = cloneCopyPatch({
    id: 7, name: 'Src', slug: 'src', container_name: 'm2-7', deployed_commit: 'abc',
    description: 'a thing', design_preset: 'portal-blue', harness: 'claude',
    suggest_mode: 'ask', clarify_mode: 'on', design_approved_at: '2026-01-01T00:00:00Z',
    design_inventory_seq: 4, current_mockup_id: 99,
  });
  assert.deepEqual(patch, {
    description: 'a thing', design_preset: 'portal-blue', harness: 'claude',
    suggest_mode: 'ask', clarify_mode: 'on', design_approved_at: '2026-01-01T00:00:00Z',
    design_inventory_seq: 4,
  });
  assert.ok(!('slug' in patch) && !('container_name' in patch) && !('current_mockup_id' in patch));
});

test('cloneSourceError: fresh works from archived; full needs the source active', () => {
  const base = { repo_path: '/repos/1.git' };
  assert.equal(cloneSourceError({ ...base, lifecycle: 'active' }, 'fresh'), null);
  assert.equal(cloneSourceError({ ...base, lifecycle: 'archived' }, 'fresh'), null);
  assert.equal(cloneSourceError({ ...base, lifecycle: 'active' }, 'full'), null);
  assert.match(cloneSourceError({ ...base, lifecycle: 'archived' }, 'full'), /online/);
  assert.match(cloneSourceError({ ...base, lifecycle: 'provisioning' }, 'fresh'), /provisioning/);
  assert.match(cloneSourceError(null, 'fresh'), /not found/);
  assert.match(cloneSourceError({ lifecycle: 'active' }, 'fresh'), /repository/);
});
