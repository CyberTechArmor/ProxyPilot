// The platform-owned design-review account (F3 — "the ai can never see past
// the login screen"). Pure logic only: script shape, result parsing, password
// shape. The container exec + credential storage live in review-account.js.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  REVIEW_EMAIL, FIXTURE_EMAIL_DOMAIN, generateReviewPassword,
  reviewAccountScript, parseReviewAccountResult, hasReviewLogin,
} from '../mock2/review-account-logic.js';

test('the review account lives on the reserved fixture domain', () => {
  // This is load-bearing, not cosmetic: the auth component excludes this exact
  // domain from "a real user exists", which is the only reason creating this
  // account does not consume the operator's first-admin bootstrap.
  assert.equal(FIXTURE_EMAIL_DOMAIN, '@fixture.invalid');
  assert.ok(REVIEW_EMAIL.endsWith('@fixture.invalid'));
});

test('the generated password clears the component\'s 12-character minimum', () => {
  for (let i = 0; i < 20; i++) {
    const pw = generateReviewPassword();
    assert.ok(pw.length >= 12, `too short: ${pw.length}`);
    assert.match(pw, /^[A-Za-z0-9_-]+$/, 'must survive JSON + shell without quoting hazards');
  }
  assert.notEqual(generateReviewPassword(), generateReviewPassword());
});

test('the script never puts credentials on a command line', () => {
  const script = reviewAccountScript({ email: 'design-review@fixture.invalid', password: 'sup3rsecretpassword', port: 3000 });
  // curl reads the body from a file; the password appears exactly once, in the
  // heredoc that writes that file.
  const occurrences = script.split('sup3rsecretpassword').length - 1;
  assert.equal(occurrences, 1);
  assert.match(script, /--data-binary @"\$CRED"/);
  assert.doesNotMatch(script, /-d '\{/, 'must not inline the JSON body as an argument');
  assert.match(script, /trap .*rm -f "\$CRED"/, 'the credential file must be removed on every exit path');
  assert.match(script, /umask 077/);
});

test('the script probes, then signs in, then creates — against the right port', () => {
  const script = reviewAccountScript({ email: REVIEW_EMAIL, password: 'x'.repeat(20), port: 4321 });
  assert.match(script, /http:\/\/127\.0\.0\.1:4321\/api\/auth\/bootstrap\/status/);
  assert.match(script, /http:\/\/127\.0\.0\.1:4321\/api\/auth\/login/);
  assert.match(script, /http:\/\/127\.0\.0\.1:4321\/api\/auth\/bootstrap\/superadmin/);
  // Order matters: a 200 sign-in must short-circuit before creation is tried,
  // or every build after the first would attempt to re-create the row.
  assert.ok(script.indexOf('/api/auth/login') < script.indexOf('/api/auth/bootstrap/superadmin'));
  assert.match(script, /echo "STATUS:/);
  assert.match(script, /echo "LOGIN:/);
  assert.match(script, /echo "CREATE:/);
});

test('a 404 on the status probe means this app simply has no accounts', () => {
  const r = parseReviewAccountResult('STATUS:404\n');
  assert.equal(r.ok, true);
  assert.equal(r.state, 'no-auth');
});

test('an app that does not answer is a failure, not "no auth"', () => {
  assert.equal(parseReviewAccountResult('STATUS:000\n').state, 'failed');
  assert.equal(parseReviewAccountResult('').state, 'failed');
  assert.equal(parseReviewAccountResult('').ok, false);
});

test('an existing review account is the idempotent happy path', () => {
  const r = parseReviewAccountResult('STATUS:200\nLOGIN:200\n');
  assert.equal(r.ok, true);
  assert.equal(r.state, 'existing');
});

test('a 201 from the bootstrap endpoint means the account was created', () => {
  const r = parseReviewAccountResult('STATUS:200\nLOGIN:401\nCREATE:201\n');
  assert.equal(r.ok, true);
  assert.equal(r.state, 'created');
});

test('a real administrator owning the bootstrap is reported as taken, not failed', () => {
  for (const code of [409, 403]) {
    const r = parseReviewAccountResult(`STATUS:200\nLOGIN:401\nCREATE:${code}\n`);
    assert.equal(r.state, 'taken');
    assert.equal(r.ok, false);
    assert.match(r.reason, /administrator/i);
  }
});

test('a sign-in that failed with no creation attempt is reported honestly', () => {
  const r = parseReviewAccountResult('STATUS:200\nLOGIN:500\n');
  assert.equal(r.state, 'failed');
  assert.match(r.reason, /500/);
});

test('hasReviewLogin needs both halves', () => {
  assert.equal(hasReviewLogin(null), false);
  assert.equal(hasReviewLogin({ email: 'a@fixture.invalid' }), false);
  assert.equal(hasReviewLogin({ password: 'x' }), false);
  assert.equal(hasReviewLogin({ email: 'a@fixture.invalid', password: 'x' }), true);
});
