// Tests for admin/backend/src/lib/s3-keys.js's buildKey() — the
// pure path-prefix concatenation that protects against accidental
// double-slashes (legal in S3 but a UX disaster).
//
// Imports from lib/s3-keys.js (not lib/s3.js) so the test never
// drags in @aws-sdk/client-s3.  lib/s3.js re-exports buildKey for
// the runtime call sites; the function definition lives here.

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildKey } from '../lib/s3-keys.js';

test('buildKey: no path_prefix → object name verbatim', () => {
  assert.equal(
    buildKey({ path_prefix: null }, 'abc.ppbackup'),
    'abc.ppbackup',
  );
  assert.equal(
    buildKey({}, 'abc.ppbackup'),
    'abc.ppbackup',
  );
});

test('buildKey: single trailing slash on prefix is stripped', () => {
  assert.equal(
    buildKey({ path_prefix: 'prod/' }, 'a.bin'),
    'prod/a.bin',
  );
});

test('buildKey: multiple leading + trailing slashes collapse', () => {
  assert.equal(
    buildKey({ path_prefix: '///prod/proxypilot///' }, '///a.bin'),
    'prod/proxypilot/a.bin',
  );
});

test('buildKey: nested path_prefix preserves inner slashes', () => {
  assert.equal(
    buildKey({ path_prefix: 'tenant-42/proxypilot/backups' }, '2026/05/abc.ppbackup'),
    'tenant-42/proxypilot/backups/2026/05/abc.ppbackup',
  );
});

test('buildKey: empty object name with prefix → just the prefix', () => {
  assert.equal(
    buildKey({ path_prefix: 'prefix' }, ''),
    'prefix/',
  );
});
