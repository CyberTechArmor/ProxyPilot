// FIRST-RUN STATE — "could not run" is not "failed".
//
// Project 46 build 129: 5 of 7 checks reported `locator.waitFor: Timeout
// 5000ms exceeded`, including the platform's own baseline. The build had done
// nothing wrong — the app had no first administrator, so /login was showing
// the create-administrator form and hiding the sign-in form. An operator read
// "5 of 7 failed" and went looking through a diff that was fine.
//
// The danger in the fix is obvious and is what most of these tests are about:
// a feature that converts failures into excuses must never fire on a guess.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  firstRunProbeScript, parseFirstRun, needsSession,
  firstRunVerdict, firstRunDetail, firstRunLogLines,
} from '../mock2/first-run-logic.js';

const ok = (id) => ({ id, ok: true });
const bad = (id) => ({ id, ok: false });
const sess = (id) => ({ id, role: 'admin' });
const anon = (id) => ({ id });

/* ------------------------------- the probe -------------------------------- */

test('the probe asks the app, not the database', () => {
  // The sign-in screen acts on /api/auth/bootstrap/status. Asking Postgres
  // directly would let this disagree with the screen it is explaining.
  const s = firstRunProbeScript({ port: 4000 });
  assert.match(s, /127\.0\.0\.1:4000\/api\/auth\/bootstrap\/status/);
  assert.match(s, /STATUS:/);
  assert.match(s, /BODY:/);
  assert.ok(!/psql|postgres/i.test(s), 'the roster query belongs to the access panel, not to a gate');
});

test('A PROBE THAT DID NOT GET AN ANSWER CHANGES NOTHING', () => {
  // Every one of these must leave `known` false. This is the whole safety
  // property: an unreachable app must not be able to excuse a real failure.
  for (const out of [
    '', 'garbage',
    'STATUS:000', 'STATUS:404', 'STATUS:500', 'STATUS:401',
    'STATUS:200\nBODY:not json',
    'STATUS:200\nBODY:{}',
    'STATUS:200\nBODY:{"canCreateSuperadmin":"yes"}',   // right key, wrong type
    'STATUS:200\nBODY:{"canCreateSuperadmin":null}',
  ]) {
    const p = parseFirstRun(out);
    assert.equal(p.known, false, JSON.stringify(out));
    assert.equal(p.firstRun, false, JSON.stringify(out));
  }
});

test('a clear answer is believed, both ways', () => {
  const yes = parseFirstRun('STATUS:200\nBODY:{"canCreateSuperadmin":true}');
  assert.deepEqual([yes.known, yes.firstRun], [true, true]);
  assert.match(yes.reason, /no first administrator/);

  const no = parseFirstRun('STATUS:200\nBODY:{"canCreateSuperadmin":false}');
  assert.deepEqual([no.known, no.firstRun], [true, false]);
});

/* ---------------------------- what gets excused --------------------------- */

test('only checks that NEED A SESSION are excused', () => {
  // A check that runs anonymously and fails, fails. First-run explains
  // nothing about it, and excusing it would hide a real defect.
  assert.equal(needsSession(sess('a')), true);
  assert.equal(needsSession(anon('b')), false);
  assert.equal(needsSession(null), false);

  const v = firstRunVerdict({
    results: [bad('needs-login'), bad('public-page')],
    checks: [sess('needs-login'), anon('public-page')],
    firstRun: true,
  });
  assert.deepEqual(v.notPossible.map((r) => r.id), ['needs-login']);
  assert.deepEqual(v.stillFailed.map((r) => r.id), ['public-page']);
});

test('THE GATE STAYS RED WHILE ANYTHING GENUINELY FAILED', () => {
  // The failure mode that would make this feature worse than the bug: one
  // real defect hiding behind four excused ones.
  const v = firstRunVerdict({
    results: [bad('login-a'), bad('login-b'), bad('the-real-bug')],
    checks: [sess('login-a'), sess('login-b'), anon('the-real-bug')],
    firstRun: true,
  });
  assert.equal(v.blocked, 2);
  assert.equal(v.remaining, 1, 'the real one must survive the excuse');
  const d = firstRunDetail({ blocked: v.blocked, total: 3, stillFailed: v.stillFailed });
  assert.match(d, /AND 1 genuinely failed/);
  assert.match(d, /the-real-bug/, 'and it must be named, not just counted');
});

test('nothing is excused when the app is NOT in first-run state', () => {
  const v = firstRunVerdict({
    results: [bad('login-a')], checks: [sess('login-a')], firstRun: false,
  });
  assert.equal(v.blocked, 0);
  assert.equal(v.remaining, 1);
  assert.ok(!v.results[0].notPossible);
});

test('a PASSING session check is left alone', () => {
  // If it passed, the premise was wrong and the passing result is the better
  // evidence. Marking it "not possible" would contradict the run.
  const v = firstRunVerdict({ results: [ok('login-a')], checks: [sess('login-a')], firstRun: true });
  assert.equal(v.blocked, 0);
  assert.ok(!v.results[0].notPossible);
});

test('a result whose check cannot be found is left alone', () => {
  // Guessing at an unmatched id is how an excuse generator starts.
  const v = firstRunVerdict({ results: [bad('mystery')], checks: [], firstRun: true });
  assert.equal(v.blocked, 0);
  assert.equal(v.remaining, 1);
});

test('empty input is not a crash', () => {
  const v = firstRunVerdict({});
  assert.deepEqual([v.blocked, v.remaining], [0, 0]);
  assert.equal(firstRunDetail({}), '');
  assert.deepEqual(firstRunLogLines({}), []);
});

/* ------------------------------ what is said ------------------------------ */

test('THE MESSAGE EXPLAINS, because not explaining was the actual bug', () => {
  const d = firstRunDetail({ blocked: 5, total: 7, stillFailed: [] });
  assert.match(d, /no first administrator yet/);
  assert.match(d, /5 of 7/);
  assert.match(d, /hides the sign-in form/, 'the cause, or the reader re-derives it');
  assert.match(d, /fixture users exist; the door is shut/, 'the half that is already fixed must not be re-debugged');
  assert.match(d, /nothing else failed/);
  assert.ok(/re-run/.test(d), 'and a way out');
});

test('the log carries the fact even on a build nobody reads twice', () => {
  const lines = firstRunLogLines({ blocked: 2, notPossible: [{ id: 'a' }, { id: 'b' }] });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /not-yet-possible: 2 session check\(s\)/);
  assert.match(lines[0], /a, b/);
});

/* ------------------------------- the wiring ------------------------------- */

test('RATCHET: the probe is lazy, and cannot silently turn a red build green', () => {
  const src = readFileSync(new URL('../mock2/smoke.js', import.meta.url), 'utf8');
  assert.match(src, /if \(!run\.ok && webPort\)/,
    'a green run must not pay for a probe that only ever explains a failure');
  assert.match(src, /probe\.known && probe\.firstRun/,
    'an unknown answer must leave the report untouched');
  assert.match(src, /const gateOk = run\.ok \|\| \(first\.blocked > 0 && first\.remaining === 0\)/,
    'one real failure must keep the gate red');
  assert.match(src, /catch \(e\) \{\s*console\.warn\('\[mock2\] first-run probe failed \(report unchanged\)/,
    'a throwing probe must fail open to the OLD behaviour, not to a pass');
});

test('RATCHET: webPort actually reaches the connector', () => {
  // The probe needs a port. Adding the parameter and not passing it would make
  // the whole feature dead code that no test notices.
  const src = readFileSync(new URL('../mock2/smoke.js', import.meta.url), 'utf8');
  assert.match(src, /driveBrowserConnector\(\{[^}]*webPort[^}]*\}\)/s);
});

test('RATCHET: the pass is reported as qualified, not as clean', () => {
  // The gate now PASSES on a first-run app. A silent green would be worse than
  // the red it replaces, so the flag must ride out with the result.
  const src = readFileSync(new URL('../mock2/smoke.js', import.meta.url), 'utf8');
  assert.match(src, /const notYetPossible = report\.browser\?\.notYetPossible === true/);
  assert.match(src, /return \{ ok, specInvalid, notYetPossible, report, logLines \}/);
});

test('RATCHET: an excused check is not counted as an acceptance failure', () => {
  // acceptanceFailed drives the loudest branch of the report. Leaving
  // notPossible out of its filter would put "ACCEPTANCE check failed" on a
  // build whose acceptance check never ran.
  const src = readFileSync(new URL('../mock2/smoke.js', import.meta.url), 'utf8');
  assert.match(src, /required\.includes\(r\.id\) && !r\.ok && !r\.notPossible/);
});
