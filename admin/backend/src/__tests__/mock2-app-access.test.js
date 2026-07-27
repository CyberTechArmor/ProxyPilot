// The operator's first-administrator door — PURE logic (native-free, risk R9).
//
// WHY IT EXISTS, and what these tests are protecting.
//
// The first account in a built app belongs to the operator, and the build is
// forbidden to create it. Project 44's build refused twice and was right to.
// But the only way the operator could exercise that rule was to watch the
// sign-in page DURING a build and race to it — "there is limited time from
// seeing the create super admin first user, then when the app finishes I'm
// unable to log in" — which is what pushed them to ask the build to break the
// rule instead.
//
// So the door is a platform action now, on the operator's schedule. Two
// properties make that safe rather than convenient, and both are asserted here:
// the password is the operator's and never reaches an argv or a log, and the
// account is created through the APP'S OWN bootstrap endpoint so the app keeps
// its race guard, its hashing and its audit entry.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FIXTURE_EMAIL_DOMAIN, MIN_PASSWORD_LENGTH, isFixtureEmail, validateFirstAdmin,
  accessStateScript, parseAccessState, accessSummary,
  firstAdminScript, parseFirstAdminResult, firstAdminInviteMessage,
} from '../mock2/app-access-logic.js';

// The stdout shape the container script produces.
const out = ({ status = 200, body = null, users = [], roster = 'ok' } = {}) => [
  `STATUS:${status}`,
  `BODY:${body === null ? '' : JSON.stringify(body)}`,
  ...users.map((u) => `USER:${u}`),
  `ROSTER:${roster}`,
].join('\n');

/* ------------------------------- validation ------------------------------- */

test('validateFirstAdmin: the operator supplies a real address and a password they chose', () => {
  assert.equal(validateFirstAdmin({ email: '', password: 'x'.repeat(12) }).ok, false);
  assert.match(validateFirstAdmin({ email: 'not-an-email', password: 'x'.repeat(12) }).error, /email address/);
  assert.equal(validateFirstAdmin({ email: 'a@b.co', password: 'x'.repeat(MIN_PASSWORD_LENGTH - 1) }).ok, false);
  assert.equal(validateFirstAdmin({ email: 'a@b.co', password: 'x'.repeat(MIN_PASSWORD_LENGTH) }).ok, true);

  // A fixture address would create an account the auth component does not
  // count as a user — the door would still read as open and the operator would
  // have made a ghost.
  const ghost = validateFirstAdmin({ email: `me${FIXTURE_EMAIL_DOMAIN}`, password: 'x'.repeat(12) });
  assert.equal(ghost.ok, false);
  assert.match(ghost.error, /reserved for the platform/);
  assert.equal(isFixtureEmail(`Design-Review${FIXTURE_EMAIL_DOMAIN.toUpperCase()}`), true);

  // Normalised the way the app stores it, so the panel and the app agree.
  assert.equal(validateFirstAdmin({ email: '  Thomas@Fractionate.ai ', password: 'x'.repeat(12) }).email,
    'thomas@fractionate.ai');
});

/* ----------------------------- reading the state --------------------------- */

test('parseAccessState: the platform\'s own fixtures never close the operator\'s door', () => {
  const s = parseAccessState(out({
    body: { canCreateSuperadmin: true },
    users: [
      `design-review${FIXTURE_EMAIL_DOMAIN}|admin|t|builtin`,
      `design-review-viewer${FIXTURE_EMAIL_DOMAIN}|viewer|t|builtin`,
    ],
  }));
  assert.equal(s.canCreateSuperadmin, true);
  assert.equal(s.canAttempt, true);
  assert.equal(s.realCount, 0);
  assert.equal(s.fixtureCount, 2);
  assert.ok(s.accounts.every((a) => a.fixture));
  // The summary says the fixtures exist AND that they do not count — an
  // operator who sees two accounts listed and no explanation reasonably
  // concludes the door is already used.
  assert.match(accessSummary(s), /no administrator yet/);
  assert.match(accessSummary(s), /do not count/);
});

test('parseAccessState: a real account closes it, and the panel says who', () => {
  const s = parseAccessState(out({
    body: { canCreateSuperadmin: false },
    users: ['thomas@fractionate.ai|admin|t|builtin', `design-review${FIXTURE_EMAIL_DOMAIN}|admin|t|builtin`],
  }));
  assert.equal(s.canCreateSuperadmin, false);
  assert.equal(s.canAttempt, false);
  assert.equal(s.realCount, 1);
  assert.match(accessSummary(s), /thomas@fractionate\.ai/);
  assert.match(accessSummary(s), /Sign in with that account/);
});

test('parseAccessState: a SHADOWED endpoint is unreachable, never "an account exists"', () => {
  // The project 43/44 shape: a feature router mounted above the platform's auth
  // routes. /login renders perfectly and this endpoint answers 401 — which
  // login.js reads as "a user already exists". Reporting it the same way here
  // would repeat that exact mistake in the panel.
  for (const status of [401, 403]) {
    const s = parseAccessState(out({ status, body: {}, users: [] }));
    assert.equal(s.unreachable, true, `${status} must read as unreachable`);
    assert.notEqual(s.canCreateSuperadmin, false, `${status} must not read as "closed"`);
    assert.equal(s.canAttempt, false, 'and must not offer a form that would 401');
    assert.match(accessSummary(s), /mounted above/, 'the summary must name the cause');
  }
});

test('parseAccessState: "we could not look" is not "there is nobody"', () => {
  // A container with no psql, or a database that is down. The first version of
  // the script echoed one unconditional marker, so this case read as "queried
  // successfully, zero users" — and the panel would have told an operator the
  // door was open on an app it could not see into.
  const blind = parseAccessState(out({ status: 0, body: null, roster: 'unavailable' }));
  assert.equal(blind.rosterKnown, false);
  assert.equal(blind.canCreateSuperadmin, null);
  assert.equal(blind.canAttempt, false);

  // But when the app itself answers, its answer stands even with no roster.
  const appAnswered = parseAccessState(out({ body: { canCreateSuperadmin: true }, roster: 'unavailable' }));
  assert.equal(appAnswered.canCreateSuperadmin, true);
  assert.equal(appAnswered.canAttempt, true);
});

test('accessStateScript: asks the APP the same question the sign-in screen asks', () => {
  const script = accessStateScript({ port: 4100 });
  assert.match(script, /http:\/\/127\.0\.0\.1:4100\/api\/auth\/bootstrap\/status/);
  // The roster marker must be CONDITIONAL on psql's exit code — that is the
  // whole "could not look" distinction above.
  assert.match(script, /if \[ "\$RC" -eq 0 \]; then echo "ROSTER:ok"; else echo "ROSTER:unavailable"; fi/);
  assert.doesNotMatch(script, /DROP|DELETE|UPDATE|INSERT/i, 'reading the roster must never write');
});

/* ------------------------------- creating it ------------------------------- */

test('firstAdminScript: the password goes in through a FILE, never an argument', () => {
  const script = firstAdminScript({ port: 3000, email: 'thomas@fractionate.ai', password: 'a-password-i-chose' });
  // An argument is visible in the container's process list to anything that can
  // read /proc, and the whole point of this path is that the password is the
  // operator's.
  const curlLine = script.split('\n').find((l) => l.includes('curl'));
  assert.ok(curlLine, 'there must be a curl invocation');
  assert.doesNotMatch(curlLine, /a-password-i-chose/, 'the password must not be on the command line');
  assert.match(curlLine, /--data-binary @"\$CRED"/, 'it must be read from the credential file');
  assert.match(script, /umask 077/, 'and that file must not be world-readable');
  assert.match(script, /trap 'rm -f "\$CRED"' EXIT INT TERM/, 'and must be removed on every exit path');
  // Through the APP's own endpoint — so the race guard, the hashing and the
  // audit entry stay the app's, and the platform never writes a user row.
  assert.match(script, /\/api\/auth\/bootstrap\/superadmin/);
  assert.doesNotMatch(script, /INSERT INTO users/i, 'the platform must not seed the row itself');
});

test('parseFirstAdminResult: every outcome is named in words the operator can act on', () => {
  assert.deepEqual(parseFirstAdminResult('CREATE:200\nDETAIL:{"ok":true}'), { ok: true, status: 200, error: null });

  const taken = parseFirstAdminResult('CREATE:409\nDETAIL:{"error":"ADMIN_ALREADY_EXISTS"}');
  assert.equal(taken.ok, false);
  assert.match(taken.error, /already has an account/);
  assert.match(taken.error, /restore an earlier checkpoint/, 'and offers the way out');

  const shadowed = parseFirstAdminResult('CREATE:401\nDETAIL:{}');
  assert.equal(shadowed.ok, false);
  assert.match(shadowed.error, /mounted above/);
  assert.match(shadowed.error, /signin-reachable/, 'it points at the gate that finds the line');

  const dead = parseFirstAdminResult('CREATE:000\nDETAIL:');
  assert.equal(dead.ok, false);
  assert.match(dead.error, /did not answer/);

  // The app's own message beats an invented one: only the app knows why.
  const refused = parseFirstAdminResult('CREATE:400\nDETAIL:{"message":"Password must be at least 12 characters."}');
  assert.match(refused.error, /at least 12 characters/);
});

/* ------------------------------- the timing -------------------------------- */

test('firstAdminInviteMessage: told at the END of the build, and only while the door is open', () => {
  // Nothing was ever expiring. But the only thing that announced the door was
  // the sign-in page, mid-build, so it read as a window the operator had missed.
  const open = parseAccessState(out({ body: { canCreateSuperadmin: true } }));
  const msg = firstAdminInviteMessage({ project: { name: 'N9' }, state: open });
  assert.ok(msg);
  assert.match(msg, /N9/);
  assert.match(msg, /no administrator yet/);
  assert.match(msg, /Nothing expires/, 'the timing worry is the thing to answer directly');

  // Silent in every other state — an invitation to use a door that is closed,
  // or that cannot be reached, is worse than none.
  assert.equal(firstAdminInviteMessage({ state: parseAccessState(out({ body: { canCreateSuperadmin: false } })) }), null);
  assert.equal(firstAdminInviteMessage({ state: parseAccessState(out({ status: 401, body: {} })) }), null);
  assert.equal(firstAdminInviteMessage({ state: null }), null);
});
