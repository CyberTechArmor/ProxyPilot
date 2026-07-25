// Live build-activity derivation (cycle-activity-logic.js) — the "what's being
// worked on" stream the build chat renders. Native-free (pure, no DB).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveActivityItem, deriveActivity } from '../mock2/cycle-activity-logic.js';
import { groupToolCallsForExecution, isReadOnlyTool, READ_ONLY_TOOLS } from '../mock2/runner-logic.js';

const ev = (kind, meta, content = null, seq = 1) => ({ seq, kind, content, meta, created_at: '2026-01-01T00:00:00Z' });
const pick = (it) => ({ action: it.action, verb: it.verb, file: it.file });

test('ai_message → narration row (empty dropped)', () => {
  assert.deepEqual(deriveActivityItem(ev('ai_message', null, 'Recomposing the modal…')), {
    seq: 1, at: '2026-01-01T00:00:00Z', type: 'message', text: 'Recomposing the modal…',
  });
  assert.equal(deriveActivityItem(ev('ai_message', null, '   ')), null);
});

test('Edit → action/verb + basename + add/del line counts', () => {
  const it = deriveActivityItem(ev('tool_call', { name: 'Edit', input: { file_path: 'src/components/TemplateManagerModal.tsx', old_string: 'a\nb\nc', new_string: 'x\ny' } }));
  assert.equal(it.type, 'tool');
  assert.equal(it.action, 'edit');
  assert.equal(it.verb, 'Edited');
  assert.equal(it.file, 'TemplateManagerModal.tsx');
  assert.equal(it.path, 'src/components/TemplateManagerModal.tsx');
  assert.equal(it.adds, 2);
  assert.equal(it.dels, 3);
});

test('Read → "lines X–Y" detail from offset/limit', () => {
  const it = deriveActivityItem(ev('tool_call', { name: 'Read', input: { file_path: 'a/b.ts', offset: 210, limit: 80 } }));
  assert.equal(it.action, 'read');
  assert.equal(it.file, 'b.ts');
  assert.equal(it.detail, 'lines 210–290');
});

test('harness tool vocabularies normalize to canonical actions', () => {
  // Copilot / ProxyPilot harness names carry `path` and different verbs.
  assert.deepEqual(pick(deriveActivityItem(ev('tool_call', { name: 'read_file', input: { path: 'x/y.ts' } }))), { action: 'read', verb: 'Read', file: 'y.ts' });
  assert.deepEqual(pick(deriveActivityItem(ev('tool_call', { name: 'create_file', input: { path: 'a.ts', content: 'l1\nl2' } }))), { action: 'create', verb: 'Created', file: 'a.ts' });
  assert.equal(deriveActivityItem(ev('tool_call', { name: 'create_file', input: { path: 'a.ts', content: 'l1\nl2' } })).adds, 2);
  assert.deepEqual(pick(deriveActivityItem(ev('tool_call', { name: 'list_dir', input: { path: 'db' } }))), { action: 'list', verb: 'Listed', file: 'db' });
  assert.equal(deriveActivityItem(ev('tool_call', { name: 'run_terminal', input: { command: 'npm   run\n build' } })).detail, 'npm run build');
  assert.equal(deriveActivityItem(ev('tool_call', { name: 'search_workspace', input: { query: '.field' } })).detail, '".field"');
});

test('Write counts content lines; Bash carries the command; unknown tool → readable verb', () => {
  assert.equal(deriveActivityItem(ev('tool_call', { name: 'Write', input: { file_path: 'x.ts', content: 'l1\nl2\nl3' } })).adds, 3);
  assert.equal(deriveActivityItem(ev('tool_call', { name: 'Bash', input: { command: 'npm run build' } })).detail, 'npm run build');
  const unknown = deriveActivityItem(ev('tool_call', { name: 'get_diagnostics', input: { path: 'a.ts' } }));
  assert.equal(unknown.action, 'check');
  assert.equal(unknown.verb, 'Checked');
  const custom = deriveActivityItem(ev('tool_call', { name: 'weird_custom_tool', input: {} }));
  assert.equal(custom.action, 'other');
  assert.equal(custom.verb, 'Weird custom tool');
});

test('non-surfaced kinds → null; the bulky old/new strings never leak', () => {
  for (const k of ['gate', 'checkpoint', 'deploy', 'task', 'note']) {
    assert.equal(deriveActivityItem(ev(k, {}, 'x')), null);
  }
  const it = deriveActivityItem(ev('tool_call', { name: 'Edit', input: { file_path: 'a.ts', old_string: 'SECRET', new_string: 'SECRET2' } }));
  assert.ok(!('old_string' in it) && !('new_string' in it), 'raw strings must be dropped');
});

test('deriveActivity filters + keeps the last N, chronological', () => {
  const events = [
    ev('task', {}, 'go', 1),
    ev('ai_message', null, 'plan', 2),
    ev('tool_call', { name: 'Read', input: { file_path: 'a.ts' } }, null, 3),
    ev('gate', {}, 'green', 4),
    ev('tool_call', { name: 'Edit', input: { file_path: 'b.ts', old_string: 'x', new_string: 'y\nz' } }, null, 5),
  ];
  const out = deriveActivity(events, { limit: 2 });
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((o) => o.seq), [3, 5]); // task/gate dropped, last 2 kept in order
});

// ---- parallel-safe tool grouping (efficiency, never behavior) ----

test('isReadOnlyTool: only observe-the-tree tools; every mutating tool excluded', () => {
  for (const n of READ_ONLY_TOOLS) assert.equal(isReadOnlyTool(n), true, `${n} should be read-only`);
  for (const n of ['write_file', 'create_file', 'apply_edit', 'materialize_component',
    'exec_in_container', 'run_terminal', 'run_gates',
    'finish', 'halt', 'pending_verification', 'request_authorization']) {
    assert.equal(isReadOnlyTool(n), false, `${n} must NOT be parallelized`);
  }
  assert.equal(isReadOnlyTool(undefined), false);
});

test('groupToolCallsForExecution: batches consecutive reads, keeps writes serial and ordered', () => {
  const calls = [
    { id: '1', name: 'read_file' }, { id: '2', name: 'search_workspace' }, { id: '3', name: 'list_dir' },
    { id: '4', name: 'apply_edit' },
    { id: '5', name: 'read_file' }, { id: '6', name: 'get_diagnostics' },
    { id: '7', name: 'run_gates' },
  ];
  const groups = groupToolCallsForExecution(calls);
  assert.deepEqual(groups.map((g) => ({ p: g.parallel, ids: g.calls.map((c) => c.id) })), [
    { p: true, ids: ['1', '2', '3'] },   // three reads → one concurrent batch
    { p: false, ids: ['4'] },            // write alone, serial
    { p: true, ids: ['5', '6'] },        // reads batch again
    { p: false, ids: ['7'] },            // gates alone, serial
  ]);
  // Flattening the groups reproduces the ORIGINAL order exactly — the transcript
  // is byte-identical to the serial path.
  assert.deepEqual(groups.flatMap((g) => g.calls.map((c) => c.id)), ['1', '2', '3', '4', '5', '6', '7']);
});

test('groupToolCallsForExecution: a write between reads is never overtaken', () => {
  const groups = groupToolCallsForExecution([
    { id: 'a', name: 'read_file' }, { id: 'b', name: 'write_file' }, { id: 'c', name: 'read_file' },
  ]);
  assert.deepEqual(groups.map((g) => g.parallel), [true, false, true]);
  assert.deepEqual(groups.map((g) => g.calls.length), [1, 1, 1]); // no batching across the write
  assert.deepEqual(groupToolCallsForExecution([]), []);
});
