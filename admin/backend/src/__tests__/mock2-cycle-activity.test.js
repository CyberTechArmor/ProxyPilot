// Live build-activity derivation (cycle-activity-logic.js) — the "what's being
// worked on" stream the build chat renders. Native-free (pure, no DB).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveActivityItem, deriveActivity } from '../mock2/cycle-activity-logic.js';

const ev = (kind, meta, content = null, seq = 1) => ({ seq, kind, content, meta, created_at: '2026-01-01T00:00:00Z' });

test('ai_message → narration row (empty dropped)', () => {
  assert.deepEqual(deriveActivityItem(ev('ai_message', null, 'Recomposing the modal…')), {
    seq: 1, at: '2026-01-01T00:00:00Z', type: 'message', text: 'Recomposing the modal…',
  });
  assert.equal(deriveActivityItem(ev('ai_message', null, '   ')), null);
});

test('Edit → file basename + add/del line counts', () => {
  const it = deriveActivityItem(ev('tool_call', { name: 'Edit', input: { file_path: 'src/components/TemplateManagerModal.tsx', old_string: 'a\nb\nc', new_string: 'x\ny' } }));
  assert.equal(it.type, 'tool');
  assert.equal(it.tool, 'Edit');
  assert.equal(it.file, 'TemplateManagerModal.tsx');
  assert.equal(it.path, 'src/components/TemplateManagerModal.tsx');
  assert.equal(it.adds, 2);
  assert.equal(it.dels, 3);
});

test('Read → "lines X–Y" detail from offset/limit', () => {
  const it = deriveActivityItem(ev('tool_call', { name: 'Read', input: { file_path: 'a/b.ts', offset: 210, limit: 80 } }));
  assert.equal(it.tool, 'Read');
  assert.equal(it.file, 'b.ts');
  assert.equal(it.detail, 'lines 210–290');
});

test('Write counts content lines; Bash carries the command; unknown tool passes through', () => {
  assert.equal(deriveActivityItem(ev('tool_call', { name: 'Write', input: { file_path: 'x.ts', content: 'l1\nl2\nl3' } })).adds, 3);
  assert.equal(deriveActivityItem(ev('tool_call', { name: 'Bash', input: { command: 'npm   run\n build' } })).detail, 'npm run build');
  assert.equal(deriveActivityItem(ev('tool_call', { name: 'Whatever', input: {} })).tool, 'Whatever');
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
