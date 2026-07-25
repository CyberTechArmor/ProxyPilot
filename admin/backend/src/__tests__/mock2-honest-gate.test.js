// The honest gate: "succeeded" must mean "we verified it", not "we wrote the file".
//
// Origin (measured, project 34 build #113): the build edited public/admin.js,
// deployed cleanly and reported SUCCESS, but nothing ever observed the change in
// a browser — and the operator's browser was serving a stale cached bundle, so
// the fix was invisible. Three builds ($5.81, ~43 min) were burned before the
// cause was found. A user-visible change that no browser confirmed now completes
// as pending-verification with a human check instead of a silent success.
//
// Native-free: pure smoke-triggers logic.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  needsOperatorUiVerification, userVisibleChange, browserConfirmed,
} from '../mock2/smoke-triggers.js';

test('userVisibleChange: UI files count, backend-only files do not', () => {
  assert.equal(userVisibleChange(['public/admin.js']), true);
  assert.equal(userVisibleChange(['public/login.html']), true);
  assert.equal(userVisibleChange(['src/components/Card.tsx']), true);
  assert.equal(userVisibleChange(['public/base.css']), true);
  // Pure backend / infra changes need no browser confirmation.
  assert.equal(userVisibleChange(['src/db/schema.ts', 'migrations/0002_x.sql']), false);
  assert.equal(userVisibleChange([]), false);
});

test('browserConfirmed: only a run-AND-passed browser check counts', () => {
  assert.equal(browserConfirmed({ browser: { ok: true } }), true);
  assert.equal(browserConfirmed({ browser: { ok: false } }), false);
  assert.equal(browserConfirmed({ browser: null }), false);       // never ran
  assert.equal(browserConfirmed({}), false);
  // The silent hole: playwright missing is NOT confirmation.
  assert.equal(browserConfirmed({ browser: { ok: true, unavailable: true } }), false);
});

test('build #113 exactly: a user-visible edit nothing observed → pending verification', () => {
  const v = needsOperatorUiVerification({
    changedFiles: ['public/admin.js'],
    report: { browser: null },                       // no browser check ran
    acceptance: ['as admin, open /admin → Email delivery (SMTP), click Save — expect it to persist'],
  });
  assert.equal(v.needed, true);
  assert.match(v.reason, /no browser check ran/);
  assert.equal(v.checklist.length, 1);
  assert.equal(v.checklist[0].kind, 'ui_verification');
  assert.match(v.checklist[0].text, /click Save/);
  // The stale-cache trap is called out where the operator will read it.
  assert.match(v.checklist[0].hint, /hard-refresh|service worker/i);
});

test('a confirmed browser check keeps it a plain success', () => {
  const v = needsOperatorUiVerification({
    changedFiles: ['public/admin.js'],
    report: { browser: { ok: true } },
    acceptance: ['as admin, click Save'],
  });
  assert.equal(v.needed, false);
  assert.deepEqual(v.checklist, []);
  assert.match(v.reason, /confirmed/);
});

test('backend-only change never demands a UI check', () => {
  const v = needsOperatorUiVerification({
    changedFiles: ['src/db/schema.ts'],
    report: { browser: null },
    acceptance: ['run the migration'],
  });
  assert.equal(v.needed, false);
  assert.match(v.reason, /no user-visible files/);
});

test('unavailable / failing browser check still demands a human look', () => {
  const unavailable = needsOperatorUiVerification({
    changedFiles: ['public/app-shell.html'],
    report: { browser: { ok: true, unavailable: true } },
    acceptance: [],
  });
  assert.equal(unavailable.needed, true);
  assert.match(unavailable.reason, /could not run/);
  // No declared acceptance → still one generic, human-runnable item.
  assert.equal(unavailable.checklist.length, 1);
  assert.match(unavailable.checklist[0].text, /confirm this change/i);

  const failed = needsOperatorUiVerification({
    changedFiles: ['public/app-shell.html'], report: { browser: { ok: false } }, acceptance: [],
  });
  assert.equal(failed.needed, true);
  assert.match(failed.reason, /did not pass/);
});

test('one checklist item per declared acceptance check', () => {
  const v = needsOperatorUiVerification({
    changedFiles: ['public/admin.js'],
    report: { browser: null },
    acceptance: ['as admin, do X', 'as viewer, do Y', '   '],
  });
  assert.equal(v.checklist.length, 2); // blank entries dropped
  assert.deepEqual(v.checklist.map((c) => c.text), ['as admin, do X', 'as viewer, do Y']);
});
