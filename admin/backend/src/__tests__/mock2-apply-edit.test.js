// Anchored-edit pure logic (apply-edit-logic.js): the apply_edit contract that
// makes the runner's file editing Copilot-grade — byte-exact matching,
// occurrence counting (NO_MATCH / AMBIGUOUS_MATCH), all-or-nothing batches, an
// optional post-apply parse hook (PARSE_FAIL), and a unified diff. Stub-first
// (risk R9): imports ONLY the native-free logic module.

import test from 'node:test';
import assert from 'node:assert/strict';
import { applyEdits, unifiedDiff, nearestLines } from '../mock2/apply-edit-logic.js';

const SRC = [
  'function greet(name) {',
  '  const msg = "hi " + name;',
  '  console.log(msg);',
  '  return msg;',
  '}',
  '',
].join('\n');

test('unique match applies and returns a diff, file content changed', () => {
  const res = applyEdits(SRC, [{ old_string: '  return msg;', new_string: '  return msg.trim();' }], { path: 'greet.js' });
  assert.equal(res.ok, true);
  assert.equal(res.applied, 1);
  assert.ok(res.content.includes('return msg.trim();'));
  assert.ok(!res.content.includes('  return msg;\n')); // old line gone
  assert.match(res.diff, /^--- a\/greet\.js/m);
  assert.match(res.diff, /-\s+return msg;/);
  assert.match(res.diff, /\+\s+return msg\.trim\(\);/);
});

test('NO_MATCH returns a structured error with a nearest-lines hint; content untouched', () => {
  const res = applyEdits(SRC, [{ old_string: '  return value;', new_string: '  return other;' }]);
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'NO_MATCH');
  assert.equal(res.content, undefined);
  assert.ok(typeof res.error.nearest === 'string' && res.error.nearest.length);
});

test('AMBIGUOUS_MATCH returns the count and leaves the file unchanged', () => {
  const dup = 'x = 1;\ny = 2;\nx = 1;\n';
  const res = applyEdits(dup, [{ old_string: 'x = 1;', new_string: 'x = 9;' }]);
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'AMBIGUOUS_MATCH');
  assert.equal(res.error.count, 2);
});

test('replace_all rewrites every occurrence and reports the applied count', () => {
  const dup = 'x = 1;\ny = 2;\nx = 1;\n';
  const res = applyEdits(dup, [{ old_string: 'x = 1;', new_string: 'x = 9;', replace_all: true }]);
  assert.equal(res.ok, true);
  assert.equal(res.applied, 2);
  assert.equal(res.content, 'x = 9;\ny = 2;\nx = 9;\n');
});

test('PARSE_FAIL from the post-apply validator rolls the whole batch back', () => {
  const validate = (text) => (text.includes('BROKEN') ? { ok: false, message: 'syntax error at line 2' } : { ok: true });
  const res = applyEdits(SRC, [{ old_string: '  console.log(msg);', new_string: '  console.log(BROKEN);' }], { validate });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'PARSE_FAIL');
  assert.match(res.error.message, /syntax error/);
});

test('batch with one bad edit applies NONE (all-or-nothing)', () => {
  const res = applyEdits(SRC, [
    { old_string: '  return msg;', new_string: '  return msg.trim();' }, // valid
    { old_string: 'does-not-exist', new_string: 'whatever' },            // NO_MATCH
  ]);
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'NO_MATCH');
  assert.equal(res.content, undefined); // caller writes nothing → file unchanged
});

test('sequential edits in one batch build on each other', () => {
  const res = applyEdits(SRC, [
    { old_string: 'const msg = "hi " + name;', new_string: 'const msg = `hi ${name}`;' },
    { old_string: '  return msg;', new_string: '  return msg.toUpperCase();' },
  ]);
  assert.equal(res.ok, true);
  assert.equal(res.applied, 2);
  assert.ok(res.content.includes('`hi ${name}`'));
  assert.ok(res.content.includes('toUpperCase()'));
});

test('new_string containing $ patterns is inserted literally (no regex interpretation)', () => {
  const res = applyEdits('const a = 1;\n', [{ old_string: 'const a = 1;', new_string: 'const a = "$& $1 $`";' }]);
  assert.equal(res.ok, true);
  assert.equal(res.content, 'const a = "$& $1 $`";\n');
});

test('INVALID_EDIT: empty edits, empty old_string, and no-op edits are rejected', () => {
  assert.equal(applyEdits(SRC, []).error.code, 'INVALID_EDIT');
  assert.equal(applyEdits(SRC, [{ old_string: '', new_string: 'x' }]).error.code, 'INVALID_EDIT');
  assert.equal(applyEdits(SRC, [{ old_string: 'return msg;', new_string: 'return msg;' }]).error.code, 'INVALID_EDIT');
  assert.equal(applyEdits(42, [{ old_string: 'a', new_string: 'b' }]).error.code, 'INVALID_EDIT');
});

test('unifiedDiff: identical inputs produce an empty diff', () => {
  assert.equal(unifiedDiff('a\nb\n', 'a\nb\n', 'f'), '');
});

test('nearestLines: points at the closest resembling line', () => {
  const hint = nearestLines(SRC, '  return msgs;');
  assert.match(hint, /return msg;/);
  assert.match(hint, /^\d+\t/m); // line-numbered
});
