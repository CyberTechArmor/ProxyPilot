// VERIFIED-VS-ASSUMED LEDGER CHECK (run-taxonomy fix #10/D3). finish's
// assumptions: { verified, assumed } was already structurally required —
// absence rejected — but a `verified` entry's CONTENT was never checked; it
// was taken on faith. These tests are the regression fixture: today (before
// this fix) nothing checks whether a "verified" claim cites a file the cycle
// ever actually read.
//
// Stub-first (risk R9): extractCitedFile/unverifiableClaims/
// hasSensitiveAssumedValue live in finish-guard-logic.js and
// readSetFromTranscript lives in runner-logic.js — both native-free. The
// runner.js wiring (rejectFinishOrConclude, the pendingChecklist union) is
// native orchestration, exercised by the manual verification checklist,
// matching the codebase's stub-first convention.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractCitedFile, unverifiableClaims, hasSensitiveAssumedValue, sensitiveAssumedEntries,
} from '../mock2/finish-guard-logic.js';
import { readSetFromTranscript } from '../mock2/runner-logic.js';

// ---- extractCitedFile ----

test('extractCitedFile finds a parenthesised path citation', () => {
  assert.equal(extractCitedFile('role slugs are lowercase (src/routes/profile.ts)'), 'src/routes/profile.ts');
});

test('extractCitedFile finds an inline "read <path>" citation', () => {
  assert.equal(extractCitedFile('read src/routes/profile.ts: role slugs are lowercase'), 'src/routes/profile.ts');
});

test('extractCitedFile returns null for a claim with no file reference', () => {
  assert.equal(extractCitedFile('the invariant holds across all requests'), null);
  assert.equal(extractCitedFile('conversions improved by 12.5% overall'), null);
  assert.equal(extractCitedFile(''), null);
  assert.equal(extractCitedFile(null), null);
});

test('extractCitedFile prefers the LAST parenthesised citation when more than one exists', () => {
  assert.equal(extractCitedFile('(see notes) role slugs are lowercase (src/routes/profile.ts)'), 'src/routes/profile.ts');
});

test('extractCitedFile finds a bare filename with no directory', () => {
  assert.equal(extractCitedFile('the fixture in profile.ts covers this'), 'profile.ts');
});

// ---- unverifiableClaims ----

test('unverifiableClaims: a citation to an unread file is flagged', () => {
  const flagged = unverifiableClaims({
    assumptions: { verified: ['role slugs are lowercase (src/routes/profile.ts)'], assumed: [] },
    readSet: new Set(['src/routes/other.ts']),
  });
  assert.deepEqual(flagged, ['role slugs are lowercase (src/routes/profile.ts)']);
});

test('unverifiableClaims: a citation to a read file is NOT flagged (regression fixture — today nothing checks this)', () => {
  const flagged = unverifiableClaims({
    assumptions: { verified: ['role slugs are lowercase (src/routes/profile.ts)'], assumed: [] },
    readSet: new Set(['src/routes/profile.ts']),
  });
  assert.deepEqual(flagged, []);
});

test('unverifiableClaims: a partial-path citation matches a fuller read-set path', () => {
  const flagged = unverifiableClaims({
    assumptions: { verified: ['the fixture in profile.ts covers this'], assumed: [] },
    readSet: new Set(['src/routes/profile.ts']),
  });
  assert.deepEqual(flagged, []);
});

test('unverifiableClaims: an uncited claim is never flagged (only citations are checked)', () => {
  const flagged = unverifiableClaims({
    assumptions: { verified: ['the invariant holds across all requests', 'observed via browser probe: the button now responds'], assumed: [] },
    readSet: new Set(),
  });
  assert.deepEqual(flagged, []);
});

test('unverifiableClaims: accepts a plain array readSet as well as a Set', () => {
  const flagged = unverifiableClaims({
    assumptions: { verified: ['checked (src/a.ts)'], assumed: [] },
    readSet: ['src/a.ts'],
  });
  assert.deepEqual(flagged, []);
});

test('unverifiableClaims: tolerant of missing/malformed input, never throws', () => {
  assert.doesNotThrow(() => unverifiableClaims({}));
  assert.deepEqual(unverifiableClaims({}), []);
  assert.deepEqual(unverifiableClaims({ assumptions: null, readSet: null }), []);
});

// ---- readSetFromTranscript ----

test('readSetFromTranscript: collects read_file and apply_edit paths', () => {
  const transcript = [
    { role: 'user', text: 'go' },
    { role: 'assistant', text: '', toolCalls: [{ id: '1', name: 'read_file', input: { path: 'src/a.ts' } }] },
    { role: 'tool', toolCallId: '1', name: 'read_file', content: 'file contents' },
    { role: 'assistant', text: '', toolCalls: [{ id: '2', name: 'apply_edit', input: { path: 'src/b.ts', edits: [] } }] },
    { role: 'tool', toolCallId: '2', name: 'apply_edit', content: 'ok' },
  ];
  const set = readSetFromTranscript(transcript);
  assert.equal(set.size, 2);
  assert.ok(set.has('src/a.ts'));
  assert.ok(set.has('src/b.ts'));
});

// CHANGED DELIBERATELY (project 55). create_file/write_file used to be
// excluded — "a fresh write is not a read of prior content" — but the question
// this set answers is "could the cycle honestly claim to have verified
// something about this file", and a file the cycle AUTHORED answers it as well
// as one it read. An inventory build creates most of its files, so the old
// rule rejected a build for citing its own work: request 258 spent a finish
// attempt on "assumptions.verified claims a file this cycle never read" for
// files it had written minutes earlier.
test('readSetFromTranscript: a file the cycle AUTHORED counts as verifiable', () => {
  const transcript = [
    { role: 'assistant', text: '', toolCalls: [{ id: '1', name: 'create_file', input: { path: 'src/new.ts', content: 'x' } }] },
    { role: 'assistant', text: '', toolCalls: [{ id: '2', name: 'write_file', input: { path: 'src/new2.ts', content: 'x' } }] },
  ];
  const set = readSetFromTranscript(transcript);
  assert.ok(set.has('src/new.ts'));
  assert.ok(set.has('src/new2.ts'));
});

// ---- a ROUTE is not a file (project 55) ----
//
// These two claims are browser-probe observations — the exact shape this
// module's contract says must never be flagged — and both were rejected
// because "/login" and "/api/health" are path-shaped. Together they cost
// request 258 two of its three finish attempts.

test('extractCitedFile: a URL route is never a file citation', () => {
  assert.equal(extractCitedFile('Verified /login rendered without browser console or network errors through browser_probe.'), null);
  assert.equal(extractCitedFile('npm run build completed; GET /api/health returned 200; browser probe of /login reported no console errors.'), null);
  assert.equal(extractCitedFile('the health endpoint at https://example.test/api/health answers 200'), null);
});

test('extractCitedFile: a real file cited alongside a route is still found', () => {
  assert.equal(extractCitedFile('GET /api/health is served by src/health.ts'), 'src/health.ts');
  assert.equal(extractCitedFile('the /login page is rendered from public/login.html'), 'public/login.html');
});

test('unverifiableClaims: a browser-probe claim about a route is not flagged', () => {
  const flagged = unverifiableClaims({
    assumptions: {
      verified: ['Verified /login rendered without console or network errors through browser_probe.'],
      assumed: [],
    },
    readSet: new Set(['src/app.ts']),
  });
  assert.deepEqual(flagged, []);
});

test('unverifiableClaims: a genuine unread-file claim is STILL flagged', () => {
  const flagged = unverifiableClaims({
    assumptions: { verified: ['roles are lowercase (src/routes/profile.ts)'], assumed: [] },
    readSet: new Set(['src/app.ts']),
  });
  assert.equal(flagged.length, 1);
});

test('readSetFromTranscript: tolerant of an empty/malformed transcript', () => {
  assert.equal(readSetFromTranscript([]).size, 0);
  assert.equal(readSetFromTranscript(undefined).size, 0);
  assert.equal(readSetFromTranscript([null, { role: 'assistant' }, { role: 'assistant', toolCalls: [null, {}] }]).size, 0);
});

test('readSetFromTranscript: multiple reads of the same path only count once (a Set)', () => {
  const transcript = [
    { role: 'assistant', toolCalls: [{ id: '1', name: 'read_file', input: { path: 'src/a.ts' } }] },
    { role: 'assistant', toolCalls: [{ id: '2', name: 'read_file', input: { path: 'src/a.ts' } }] },
  ];
  assert.equal(readSetFromTranscript(transcript).size, 1);
});

// ---- hasSensitiveAssumedValue / sensitiveAssumedEntries ----

test('hasSensitiveAssumedValue: true for a role/permission-shaped assumed entry', () => {
  assert.equal(hasSensitiveAssumedValue(['the user role is admin by default']), true);
  assert.equal(hasSensitiveAssumedValue(['assumed the RBAC policy allows this']), true);
  assert.equal(hasSensitiveAssumedValue(['assumed is_admin defaults to false']), true);
  assert.equal(hasSensitiveAssumedValue(['assumed the access level is read-only']), true);
});

test('hasSensitiveAssumedValue: false for an unrelated assumed entry', () => {
  assert.equal(hasSensitiveAssumedValue(['the button color is blue']), false);
  assert.equal(hasSensitiveAssumedValue([]), false);
  assert.equal(hasSensitiveAssumedValue(undefined), false);
});

test('sensitiveAssumedEntries: returns only the matching entries', () => {
  const entries = sensitiveAssumedEntries(['the button color is blue', 'assumed the admin role check is server-side']);
  assert.deepEqual(entries, ['assumed the admin role check is server-side']);
});
