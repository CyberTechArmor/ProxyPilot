// SMOKE NOISE vs SIGNAL — project 47 request 140's report shape, fixed.
//
// $10.28 across three cycles: two recurring failures were the platform's own
// baseline checks (unfixable by the build), and the one real app failure
// (notes-todo-add) sat beneath them, ignored, while cycles 2 and 3 concluded
// "no product-code change was needed". These tests pin the fixes: platform
// checks tagged and grouped last, app failures listed first, and an empty-diff
// finish after an app-owned smoke failure must answer the failing checks by
// name.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  uiCheckLogLines, uiCheckFailSummary, baselineOnlyFailure,
  appOwnedFailureIds, unansweredSmokeFailures, BASELINE_CHECK_PREFIX,
} from '../mock2/ui-check-logic.js';

const app = (id, ok, detail = 'expect_visible #x: Timeout') => ({ id, ok, page: '/', role: 'admin', steps: ok ? [] : [{ ok: false, detail }], consoleErrors: [] });
const platform = (name, ok) => app(`${BASELINE_CHECK_PREFIX}${name}`, ok);

// The request-140 shape: one real app failure under two platform failures.
const REQUEST_140_RESULTS = [
  platform('admin-reachable', false),
  platform('signin-legal', false),
  app('notes-todo-add', false, 'click #todo-add did nothing'),
  app('notes-list-loads', true),
];

test('log lines list app-owned results first and tag platform checks', () => {
  const lines = uiCheckLogLines(REQUEST_140_RESULTS);
  assert.ok(lines[0].includes('notes-todo-add'));
  assert.ok(!lines[0].includes('[platform check]'));
  const platformLines = lines.filter((l) => l.includes('[platform check]'));
  assert.equal(platformLines.length, 2);
  // Platform lines come after every app-owned line.
  assert.ok(lines.findIndex((l) => l.includes('[platform check]')) > lines.findIndex((l) => l.includes('notes-list-loads')));
});

test('the failure summary puts the app failure first and tags the platform ones', () => {
  const s = uiCheckFailSummary(REQUEST_140_RESULTS);
  assert.ok(s.startsWith('notes-todo-add:'));
  assert.ok(s.includes('[platform check — not your change]'));
});

test('baselineOnlyFailure stays null while an app-owned failure exists (request 140 could never conclude platform-only)', () => {
  assert.equal(baselineOnlyFailure(REQUEST_140_RESULTS), null);
  const onlyPlatform = [platform('admin-reachable', false), platform('signin-legal', false), app('notes-list-loads', true)];
  const verdict = baselineOnlyFailure(onlyPlatform);
  assert.ok(verdict);
  assert.deepEqual(verdict.ids, [`${BASELINE_CHECK_PREFIX}admin-reachable`, `${BASELINE_CHECK_PREFIX}signin-legal`]);
});

/* -------- the empty-diff "no product change needed" honesty floor -------- */

const PRIOR_ERROR = 'Smoke gate failed after deploy — notes-todo-add: click #todo-add did nothing · '
  + `${BASELINE_CHECK_PREFIX}admin-reachable [platform check — not your change]: expect_visible header: Timeout`;

test('appOwnedFailureIds extracts app checks and skips platform/layer prefixes', () => {
  assert.deepEqual(appOwnedFailureIds(PRIOR_ERROR), ['notes-todo-add']);
  assert.deepEqual(appOwnedFailureIds('Smoke gate failed after deploy — http: shell, login'), []);
  assert.deepEqual(appOwnedFailureIds('deploy failed at build'), []);
});

test('an empty-diff finish that never names the failing check is unanswered', () => {
  const unanswered = unansweredSmokeFailures({
    failedIds: ['notes-todo-add'],
    summary: 'No product-code change was needed; added sw.js path to an existing check.',
    acceptance: ['as admin, open the app, expect it to load'],
  });
  assert.deepEqual(unanswered, ['notes-todo-add']);
});

test('naming the check in the summary or acceptance answers it', () => {
  assert.deepEqual(unansweredSmokeFailures({
    failedIds: ['notes-todo-add'],
    summary: 'notes-todo-add fails because the check clicks a selector the approved design replaced; the Add flow works via the new #new-todo control.',
    acceptance: [],
  }), []);
  assert.deepEqual(unansweredSmokeFailures({
    failedIds: ['notes-todo-add'],
    summary: 'No change needed.',
    acceptance: ['the notes-todo-add check asserts the removed legacy button; as admin, press New to-do — the item appears'],
  }), []);
});
