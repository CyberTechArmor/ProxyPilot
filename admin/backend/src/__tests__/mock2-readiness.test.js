// Post-deploy readiness — the pure half.
//
// WHY: probeServing asks for `/` and accepts anything below 500. On an
// auth-gated app that is the 302 to /login — which a dead database, a failed
// migration, a 500ing API and a blank white page ALSO produce, because the gate
// redirect happens before any of them is reached. "The app deployed" therefore
// meant "a process is listening", and a comprehensively broken app read as
// healthy. That is the shape of "the app did not work until redeployed".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readinessScript, parseReadiness, readinessLogLines, readinessChatMessage,
  READINESS_CHECKS, AUTHED_CHECKS,
} from '../mock2/readiness-logic.js';

const AUTH = { email: 'design-review@fixture.invalid', password: 'x'.repeat(20) };

test('the probe asks the app itself, not just whether something is listening', () => {
  const s = readinessScript({ port: 4321 });
  for (const c of READINESS_CHECKS) {
    assert.ok(s.includes(`http://127.0.0.1:4321${c.path}`), `probes ${c.path}`);
    assert.ok(s.includes(`echo "${c.key}:`), `labels ${c.key}`);
  }
  // curl only: nothing here may require something to be installed in the app's
  // own container.
  assert.doesNotMatch(s, /\bjq\b|\bnode\b|\bpython/);
});

test('with fixture credentials it makes the request the redirect was hiding', () => {
  const s = readinessScript({ port: 3000, authed: AUTH });
  // Sign in, keep the cookies, then ask for the app AS A SIGNED-IN USER. An app
  // can serve /login perfectly and 500 on every screen behind it.
  assert.match(s, /-c "\$JAR".*\/api\/auth\/login/s);
  assert.match(s, /-b "\$JAR".*"http:\/\/127\.0\.0\.1:3000\/"/s);
  assert.match(s, /echo "APP:/);
  // Credentials to a 0600 file, never onto a command line.
  assert.equal(s.split(AUTH.password).length - 1, 1);
  assert.match(s, /--data-binary @"\$CRED"/);
  assert.match(s, /umask 077/);
  assert.match(s, /trap .*rm -f "\$JAR" "\$CRED"/);
  // No credentials, no authed probe — and no broken script either.
  assert.doesNotMatch(readinessScript({ port: 3000 }), /SIGNIN:/);
});

test('the exact case that used to pass: a login redirect with everything behind it broken', () => {
  // ROOT 302 is what probeServing saw and called healthy.
  const r = parseReadiness('ROOT:302\nHEALTH:503\nLOGIN:200\nSTATIC:200\nSIGNIN:200\nAPP:500\n');
  assert.equal(r.ready, false);
  // Both real problems are named, in words an operator can act on.
  assert.match(r.summary, /reports itself unhealthy/);
  assert.match(r.summary, /SIGNED-IN request/);
  assert.equal(r.failures.length, 2);
});

test('a healthy app is ready, and says how it knows', () => {
  const r = parseReadiness('ROOT:302\nHEALTH:200\nLOGIN:200\nSTATIC:200\nSIGNIN:200\nAPP:200\n');
  assert.equal(r.ready, true);
  assert.equal(r.failures.length, 0);
  assert.match(r.summary, /6\/6 readiness checks passed/);
});

test('a missing stylesheet warns but does not block — unstyled is not down', () => {
  const r = parseReadiness('ROOT:200\nHEALTH:200\nLOGIN:200\nSTATIC:404\nSIGNIN:200\nAPP:200\n');
  assert.equal(r.ready, true);
  assert.equal(r.warnings.length, 1);
  assert.match(r.summary, /warning/);
  assert.match(readinessLogLines(r).join('\n'), /readiness STATIC .*: WARN \(HTTP 404\)/);
});

test('an app with no auth component is not punished for a fixture that cannot sign in', () => {
  // LOGIN 404 means this app has no sign-in at all. The fixture having nowhere
  // to sign in to is then correct, not a failure — and a check that fails for
  // being inapplicable is how a harness teaches people to ignore it.
  const r = parseReadiness('ROOT:200\nHEALTH:200\nLOGIN:404\nSTATIC:200\nSIGNIN:401\nAPP:302\n');
  assert.equal(r.ready, true);
  assert.equal(r.failures.length, 0);
});

test('a partial run reports what it managed, and no output is a failure', () => {
  const r = parseReadiness('ROOT:200\nHEALTH:200\n');
  assert.equal(r.checks.length, 2);
  assert.equal(r.ready, true);          // of what ran, nothing failed
  const none = parseReadiness('');
  assert.equal(none.ready, false);
  assert.match(none.summary, /no output/);
  assert.equal(parseReadiness('garbage\n').ready, false);
});

test('the chat message says it is the app, not the build, that is wrong', () => {
  const r = parseReadiness('ROOT:302\nHEALTH:503\nLOGIN:200\nSTATIC:200\n');
  const msg = readinessChatMessage(r);
  assert.match(msg, /deployed, but it is not working/);
  assert.match(msg, /reports itself unhealthy/);
  // The point of the last line: the build log looks CLEAN in this state, and an
  // operator reading it for a defect that is not there wastes an hour.
  assert.match(msg, /build log will look clean/);
  assert.match(readinessChatMessage(r, { redeployed: true }), /still not working after an automatic deploy/);
  // Nothing to say when the app is fine.
  assert.equal(readinessChatMessage(parseReadiness('ROOT:200\nHEALTH:200\nLOGIN:200\nSTATIC:200\n')), null);
});

test('every check carries a reason a human can act on', () => {
  for (const c of [...READINESS_CHECKS, ...AUTHED_CHECKS]) {
    assert.ok(c.describe && c.describe.length > 8, `${c.key} needs a description`);
    assert.ok(c.why && c.why.length > 12, `${c.key} needs an actionable reason`);
  }
});
