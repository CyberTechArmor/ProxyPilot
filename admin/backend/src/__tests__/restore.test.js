// Tests for admin/backend/src/lib/restore.js — the path-traversal
// guard that prevents a tampered .ppbackup from escaping its
// sandbox dir during a Mode A restore.
//
// runModeA / runModeC are integration-level (DB + S3 + fs); they
// live in a follow-up integration suite.  This file covers only
// the pure helpers reachable via __test.

import test from 'node:test';
import assert from 'node:assert/strict';

import { safeExtractName } from '../lib/restore-paths.js';

test('safeExtractName: passes a normal relative path', () => {
  assert.equal(safeExtractName('caddy/Caddyfile'), 'caddy/Caddyfile');
  assert.equal(safeExtractName('proxypilot.db.json'), 'proxypilot.db.json');
});

test('safeExtractName: rejects absolute paths', () => {
  assert.throws(() => safeExtractName('/etc/passwd'), /absolute path/);
});

test('safeExtractName: rejects path traversal segments', () => {
  // Most obvious form.
  assert.throws(() => safeExtractName('../etc/shadow'), /path traversal/);
  // Nested form a tampered archive might emit.
  assert.throws(
    () => safeExtractName('caddy/../../etc/shadow'),
    /path traversal/,
  );
  assert.throws(() => safeExtractName('a/b/../c'), /path traversal/);
});

test('safeExtractName: legitimate ".." inside a filename is fine', () => {
  // Path-traversal check looks at SEGMENT == '..', not literal substring,
  // so 'foo..bar' (which is one segment) must pass.
  assert.equal(safeExtractName('foo..bar/file.txt'), 'foo..bar/file.txt');
});
