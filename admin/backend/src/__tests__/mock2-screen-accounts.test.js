// SCREEN ACCOUNTS — the users a project's own checks sign in as must exist.
//
// "No build to date has been able to login and assess the screens." The reason
// is mechanical: state/ui-checks.json is written by the build MODEL, which
// invents an address and a password for its fixture users, and nothing ever
// created those rows. Every check declaring one signs in against a form that
// rejects it, gets bounced to the gate, and times out on an element that only
// exists behind it — reported as the app failing.
//
//   project 44 build 133: three checks, three timeouts, on a build that had
//                         deployed and worked
//   project 46 build 129: five of seven, at $9.65
//
// The tell in both: the PLATFORM's own baseline checks passed in the same run,
// because those use accounts the platform creates.
//
// The security property this file exists to hold is the sharp one. The first
// administrator belongs to the OPERATOR, and only the reserved
// @fixture.invalid domain is excluded from "a real user exists". A spec naming
// a real address must therefore never be minted: that account is a real
// person's, and creating it would silently consume the operator's first-admin
// slot.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  screenAccountsFromSpec, screenAccountsNote, reviewFixtureAccounts, seedFixtureUserScript,
  parseSeedResult, FIXTURE_EMAIL_DOMAIN, REVIEW_ROLE_PREFERENCE, VIEWER_ROLE_PREFERENCE,
  REVIEW_EMAIL, REVIEW_VIEWER_EMAIL,
} from '../mock2/review-account-logic.js';

const spec = (users) => ({ login: { path: '/login', user_field: '#e', pass_field: '#p', submit: '#s', users } });

test('the users a spec declares become accounts to mint', () => {
  const { accounts, skipped } = screenAccountsFromSpec(spec({
    admin: { username: `admin${FIXTURE_EMAIL_DOMAIN}`, password: 'correct-horse-battery' },
    viewer: { username: `viewer${FIXTURE_EMAIL_DOMAIN}`, password: 'staple-battery-horse' },
  }));
  assert.equal(skipped.length, 0);
  assert.deepEqual(accounts.map((a) => a.email), [`admin${FIXTURE_EMAIL_DOMAIN}`, `viewer${FIXTURE_EMAIL_DOMAIN}`]);
  assert.equal(accounts[0].password, 'correct-horse-battery', 'the password the SPEC declares — the checks type that one');
});

test('A REAL ADDRESS IS NEVER MINTED', () => {
  // The security property. That account is the operator's; creating it would
  // count as "a real user exists" and take the first-admin slot.
  const { accounts, skipped } = screenAccountsFromSpec(spec({
    admin: { username: 'thomas@fractionate.ai', password: 'whatever-the-model-invented' },
    viewer: { username: `viewer${FIXTURE_EMAIL_DOMAIN}`, password: 'pw-for-the-viewer' },
  }));
  assert.deepEqual(skipped, ['thomas@fractionate.ai']);
  assert.deepEqual(accounts.map((a) => a.email), [`viewer${FIXTURE_EMAIL_DOMAIN}`]);
});

test('and a lookalike domain is not the reserved one', () => {
  const { accounts, skipped } = screenAccountsFromSpec(spec({
    admin: { username: 'admin@fixture.invalid.example.com', password: 'p'.repeat(12) },
    b: { username: 'admin@notfixture.invalid', password: 'p'.repeat(12) },
  }));
  // Neither is the reserved domain: a subdomain of it is somebody's real host,
  // and `@notfixture.invalid` merely ends with `.invalid`. The match is on the
  // full `@fixture.invalid` suffix, so both are refused.
  assert.equal(accounts.length, 0);
  assert.equal(skipped.length, 2);
});

test('an admin role gets admin preference; anything else falls to the LEAST privileged', () => {
  // A viewer fixture that quietly became an admin makes every permission check
  // pass and proves nothing — the exact defect the second fixture exists to find.
  const { accounts } = screenAccountsFromSpec(spec({
    admin: { username: `a${FIXTURE_EMAIL_DOMAIN}`, password: 'x'.repeat(12) },
    viewer: { username: `v${FIXTURE_EMAIL_DOMAIN}`, password: 'x'.repeat(12) },
  }));
  const [admin, viewer] = accounts;
  assert.equal(admin.fallback, 'first');
  assert.deepEqual(admin.prefer, [...REVIEW_ROLE_PREFERENCE]);
  assert.equal(viewer.fallback, 'least');
  assert.equal(viewer.prefer[0], 'viewer', 'the role the spec asked for is tried first');
  assert.ok(VIEWER_ROLE_PREFERENCE.every((r) => viewer.prefer.includes(r)));
});

test('a role name the platform has never heard of still gets its own role first', () => {
  const { accounts } = screenAccountsFromSpec(spec({
    auditor: { username: `x${FIXTURE_EMAIL_DOMAIN}`, password: 'x'.repeat(12) },
  }));
  assert.equal(accounts[0].prefer[0], 'auditor');
  assert.equal(accounts[0].fallback, 'least', 'an unknown role is not assumed to be an admin one');
  assert.equal(accounts[0].key, 'spec-auditor');
});

test('a key is always shell/JSON safe', () => {
  const { accounts } = screenAccountsFromSpec(spec({
    'we!rd $role`name': { username: `x${FIXTURE_EMAIL_DOMAIN}`, password: 'x'.repeat(12) },
  }));
  assert.match(accounts[0].key, /^spec-[a-z0-9_-]*$/);
});

test('an incomplete or absent login block yields nothing, quietly', () => {
  for (const s of [null, undefined, {}, { login: null }, { login: {} }, { login: { users: null } }, spec({})]) {
    assert.deepEqual(screenAccountsFromSpec(s), { accounts: [], skipped: [] });
  }
  // A user with no password cannot be signed in as, so there is nothing to mint.
  assert.deepEqual(
    screenAccountsFromSpec(spec({ admin: { username: `a${FIXTURE_EMAIL_DOMAIN}` } })),
    { accounts: [], skipped: [] },
  );
});

test('`email` is accepted as well as `username`', () => {
  const { accounts } = screenAccountsFromSpec(spec({
    admin: { email: `a${FIXTURE_EMAIL_DOMAIN}`, password: 'x'.repeat(12) },
  }));
  assert.equal(accounts.length, 1);
});

test('the note names what was minted AND what was refused', () => {
  const { accounts, skipped } = screenAccountsFromSpec(spec({
    admin: { username: `a${FIXTURE_EMAIL_DOMAIN}`, password: 'x'.repeat(12) },
    owner: { username: 'real@example.com', password: 'x'.repeat(12) },
  }));
  const note = screenAccountsNote({ accounts, skipped, seeded: { ok: true, state: 'seeded' } });
  assert.match(note, /1 declared fixture user\(s\) ready/);
  assert.match(note, /real@example\.com/);
  assert.match(note, /never creates a real-domain account/);
});

test('the note distinguishes "no auth component" from "it failed"', () => {
  // A check failing because the app has no accounts at all and a check failing
  // because the seeder broke are different problems with different next steps.
  const accounts = [{ email: `a${FIXTURE_EMAIL_DOMAIN}` }];
  assert.match(screenAccountsNote({ accounts, seeded: { ok: true, state: 'no-auth' } }), /no auth component/);
  const failed = screenAccountsNote({ accounts, seeded: { ok: false, state: 'failed', reason: 'connection refused' } });
  assert.match(failed, /could not be created/);
  assert.match(failed, /connection refused/, 'the reason travels with the failure or it gets re-derived');
  assert.equal(screenAccountsNote({}), '', 'nothing to say is said with nothing');
});

test('the seeder script carries every account and leaks no password to argv', () => {
  const accounts = [
    ...reviewFixtureAccounts({
      email: REVIEW_EMAIL, password: 'platform-pw-1234', viewerEmail: REVIEW_VIEWER_EMAIL, viewerPassword: 'platform-pw-1234',
    }),
    ...screenAccountsFromSpec(spec({ admin: { username: `a${FIXTURE_EMAIL_DOMAIN}`, password: 'spec-pw-5678' } })).accounts,
  ];
  const script = seedFixtureUserScript({ accounts });
  for (const a of accounts) assert.ok(script.includes(a.email), `${a.email} must be in the payload`);
  // Credentials go in through a 0600 heredoc file; `ps` inside the container is
  // readable by the app, and the build model runs code there.
  assert.match(script, /umask 077/);
  assert.match(script, /PP_SEED_EOF/);
  assert.doesNotMatch(script, /node -e/, 'the seeder is a file, not a quoted argument');
  for (const line of script.split('\n')) {
    if (line.includes('platform-pw-1234') || line.includes('spec-pw-5678')) {
      assert.ok(!/^(CRED=|node |su |curl )/.test(line.trim()), `a password reached a command line: ${line}`);
    }
  }
});

test('a partial seed still reports which accounts landed', () => {
  // "Some of it worked" is the state a retry needs to know about.
  const r = parseSeedResult([
    'SEED:acct:reviewer:admin',
    'SEED:acct:viewer:member',
    'SEED:error:relation "users" does not exist',
  ].join('\n'));
  assert.equal(r.ok, false);
  assert.deepEqual(r.accounts, { reviewer: 'admin', viewer: 'member' });
  assert.match(r.reason, /relation "users"/);
});

test('the platform pair is never given a viewer role by accident', () => {
  const [reviewer, viewer] = reviewFixtureAccounts({
    email: REVIEW_EMAIL, password: 'p', viewerEmail: REVIEW_VIEWER_EMAIL, viewerPassword: 'p',
  });
  assert.equal(reviewer.fallback, 'first');
  assert.deepEqual(reviewer.prefer, [...REVIEW_ROLE_PREFERENCE]);
  assert.equal(viewer.fallback, 'least');
});

test('RATCHET: the smoke gate seeds from the spec AS WRITTEN, before withPlatformLogin', async () => {
  // withPlatformLogin adds the reviewer under a role literally called
  // `platform`. That is not an admin role name, so screenAccountsFromSpec would
  // give it `fallback: 'least'` — the reviewer would be seeded with the LOWEST
  // privilege role in the table and every admin screen it exists to reach would
  // start failing. Ordering is the whole correctness argument, so assert it.
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../mock2/smoke.js', import.meta.url), 'utf8');
  const seed = src.indexOf('ensureScreenAccounts(parsed.spec');
  const platformLogin = src.indexOf('withPlatformLogin(parsed.spec');
  assert.ok(seed > 0, 'the smoke gate must seed the declared users');
  assert.ok(platformLogin > 0);
  assert.ok(seed < platformLogin, 'seeding must read the spec BEFORE the platform adds its own users to it');

  // And prove the hazard is real rather than theoretical.
  const { withPlatformLogin } = await import('../mock2/ui-check-logic.js');
  const transformed = withPlatformLogin(
    { login: null, checks: [{ id: 'c', paths: ['**/*'], steps: [] }] },
    { email: REVIEW_EMAIL, password: 'p'.repeat(12) },
  );
  const { accounts } = screenAccountsFromSpec(transformed);
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].fallback, 'least',
    'seeding the TRANSFORMED spec would demote the reviewer — which is why the order above is asserted');
});
