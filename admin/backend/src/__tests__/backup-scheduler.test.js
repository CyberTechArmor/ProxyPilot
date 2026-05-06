// Tests for admin/backend/src/lib/backup-cron.js — the pure
// cron-expression matcher + next-run computer that lives behind
// the backup-scheduler module.
//
// Imports from lib/backup-cron.js directly (not lib/backup-
// scheduler.js) so the test never drags in the node-cron
// package.  Same pattern as PR 1's lib/s3-keys.js split.
//
// register / hydrate / runSchedule aren't covered here — those
// touch the DB.  An integration suite (PR follow-up) drives them
// against a temp SQLite + the __drainForTest hook.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  cronMatches, matchField, computeNextRunMs, isValidCronExpr,
} from '../lib/backup-cron.js';

// ── matchField ─────────────────────────────────────────────────────

test('matchField: wildcard matches anything in range', () => {
  assert.equal(matchField('*', 0, 0, 59), true);
  assert.equal(matchField('*', 30, 0, 59), true);
  assert.equal(matchField('*', 59, 0, 59), true);
});

test('matchField: literal matches only the literal', () => {
  assert.equal(matchField('15', 15, 0, 59), true);
  assert.equal(matchField('15', 14, 0, 59), false);
});

test('matchField: comma list matches any element', () => {
  assert.equal(matchField('1,3,5', 1, 0, 59), true);
  assert.equal(matchField('1,3,5', 5, 0, 59), true);
  assert.equal(matchField('1,3,5', 4, 0, 59), false);
});

test('matchField: range matches inclusive bounds', () => {
  assert.equal(matchField('5-10', 5, 0, 59), true);
  assert.equal(matchField('5-10', 7, 0, 59), true);
  assert.equal(matchField('5-10', 10, 0, 59), true);
  assert.equal(matchField('5-10', 4, 0, 59), false);
  assert.equal(matchField('5-10', 11, 0, 59), false);
});

test('matchField: step alone matches lo + multiples', () => {
  assert.equal(matchField('*/15', 0, 0, 59), true);
  assert.equal(matchField('*/15', 15, 0, 59), true);
  assert.equal(matchField('*/15', 30, 0, 59), true);
  assert.equal(matchField('*/15', 7, 0, 59), false);
});

test('matchField: range + step', () => {
  assert.equal(matchField('0-59/30', 0, 0, 59), true);
  assert.equal(matchField('0-59/30', 30, 0, 59), true);
  assert.equal(matchField('0-59/30', 15, 0, 59), false);
});

test('matchField: day-of-week 7 == 0 (Sunday)', () => {
  assert.equal(matchField('7', 0, 0, 7), true);
  assert.equal(matchField('0', 0, 0, 7), true);
  assert.equal(matchField('7', 1, 0, 7), false);
});

// ── cronMatches ────────────────────────────────────────────────────

test('cronMatches: 5-field nightly 3am', () => {
  // 0 3 * * *  →  matches 03:00 on any date.
  assert.equal(cronMatches('0 3 * * *', new Date(2026, 4, 6, 3, 0)), true);
  assert.equal(cronMatches('0 3 * * *', new Date(2026, 4, 6, 4, 0)), false);
  assert.equal(cronMatches('0 3 * * *', new Date(2026, 4, 6, 3, 1)), false);
});

test('cronMatches: every 5 minutes', () => {
  assert.equal(cronMatches('*/5 * * * *', new Date(2026, 4, 6, 12, 0)), true);
  assert.equal(cronMatches('*/5 * * * *', new Date(2026, 4, 6, 12, 5)), true);
  assert.equal(cronMatches('*/5 * * * *', new Date(2026, 4, 6, 12, 7)), false);
});

test('cronMatches: weekly Sunday midnight', () => {
  // 0 0 * * 0  →  Sundays at midnight. May 3 2026 is a Sunday.
  assert.equal(cronMatches('0 0 * * 0', new Date(2026, 4, 3, 0, 0)), true);
  assert.equal(cronMatches('0 0 * * 0', new Date(2026, 4, 4, 0, 0)), false);
});

test('cronMatches: 6-field form drops the seconds prefix', () => {
  // The 6-field is silently treated as 5-field with seconds dropped.
  // Equivalent of '0 3 * * *' at minute resolution.
  assert.equal(cronMatches('0 0 3 * * *', new Date(2026, 4, 6, 3, 0)), true);
});

test('cronMatches: malformed expression fails closed', () => {
  assert.equal(cronMatches('not-a-cron', new Date()), false);
  assert.equal(cronMatches('* * *', new Date()), false);  // too few fields
});

// ── computeNextRunMs ───────────────────────────────────────────────

test('computeNextRunMs: nightly 3am from 9am yields tomorrow 3am', () => {
  // We pin a wall-clock time so the test is deterministic.  May 6
  // 2026 09:00 → next 3am = May 7 03:00.
  const from = new Date(2026, 4, 6, 9, 0).getTime();
  const ms = computeNextRunMs('0 3 * * *', from);
  const dt = new Date(ms);
  assert.equal(dt.getDate(), 7);
  assert.equal(dt.getHours(), 3);
  assert.equal(dt.getMinutes(), 0);
});

test('computeNextRunMs: nightly 3am from 1am same day yields 3am same day', () => {
  const from = new Date(2026, 4, 6, 1, 0).getTime();
  const ms = computeNextRunMs('0 3 * * *', from);
  const dt = new Date(ms);
  assert.equal(dt.getDate(), 6);
  assert.equal(dt.getHours(), 3);
});

test('computeNextRunMs: invalid expression returns null', () => {
  assert.equal(computeNextRunMs('garbage'), null);
});

// ── isValidCronExpr ────────────────────────────────────────────────

test('isValidCronExpr: accepts standard 5-field forms', () => {
  assert.equal(isValidCronExpr('0 3 * * *'), true);
  assert.equal(isValidCronExpr('*/5 * * * *'), true);
});

test('isValidCronExpr: rejects empty / non-string', () => {
  assert.equal(isValidCronExpr(''), false);
  assert.equal(isValidCronExpr(null), false);
  assert.equal(isValidCronExpr(undefined), false);
  assert.equal(isValidCronExpr(42), false);
});
