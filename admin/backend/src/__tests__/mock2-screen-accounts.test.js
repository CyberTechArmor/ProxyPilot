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
  REVIEW_EMAIL, REVIEW_VIEWER_EMAIL, withScreenLogins, fixtureEmail, fixtureSlug,
  reviewEmailFor, viewerEmailFor,
} from '../mock2/review-account-logic.js';

const spec = (users) => ({ login: { path: '/login', user_field: '#e', pass_field: '#p', submit: '#s', users } });
const PROJECT = { id: 44, name: 'N8' };
const PW = 'mzQJXb04XIamWNyhNLtsz06O1UhFD5dk';
const from = (users) => screenAccountsFromSpec(spec(users), { project: PROJECT, password: PW });

test('every declared role becomes an account, named for the role and the project', () => {
  const { accounts } = from({
    admin: { username: `whatever${FIXTURE_EMAIL_DOMAIN}`, password: 'correct-horse-battery' },
    viewer: { username: `other${FIXTURE_EMAIL_DOMAIN}`, password: 'staple-battery-horse' },
  });
  assert.deepEqual(accounts.map((a) => a.email), ['admin-n8@fixture.invalid', 'viewer-n8@fixture.invalid']);
});

test('THE PASSWORD IS NEVER THE ONE THE SPEC DECLARES', () => {
  // A live project was seeded with `n8-admin-password-123` because that is what
  // the build model wrote into its own spec. The platform already holds a
  // 32-character secret per project; there is no reason for a weaker one to
  // exist anywhere.
  const { accounts } = from({ admin: { username: `a${FIXTURE_EMAIL_DOMAIN}`, password: 'n8-admin-password-123' } });
  assert.equal(accounts[0].password, PW);
  assert.ok(!accounts.some((a) => a.password.includes('password-123')));
});

test('A REAL ADDRESS IS NEVER MINTED — it is replaced, not skipped', () => {
  // The security property is unchanged: no account on a real domain is ever
  // created, because it would be a real person's, would count as "a real user
  // exists", and would take the operator's first-admin slot. Substituting beats
  // skipping, because the check that declared it now RUNS.
  const { accounts, renamed } = from({
    admin: { username: 'thomas@fractionate.ai', password: 'whatever-the-model-invented' },
  });
  assert.deepEqual(accounts.map((a) => a.email), ['admin-n8@fixture.invalid']);
  assert.deepEqual(renamed, [{ role: 'admin', from: 'thomas@fractionate.ai', to: 'admin-n8@fixture.invalid' }]);
});

test('EVERY minted address ends with the reserved domain, whatever the spec said', () => {
  // The one invariant the auth component's `NOT LIKE '%@fixture.invalid'` guard
  // depends on. A `{role}@{project}.com` address would not match it and would
  // silently consume the first-admin slot — see the note in the module.
  const { accounts } = from({
    admin: { username: 'admin@n8.com', password: 'x'.repeat(12) },
    'we!rd role': { username: 'x@n8.fixture.invalid', password: 'x'.repeat(12) },
    auditor: { username: '', password: '' },
  });
  assert.equal(accounts.length, 3);
  for (const a of accounts) assert.ok(a.email.endsWith(FIXTURE_EMAIL_DOMAIN), a.email);
});

test('the slug is bounded, safe, and never empty', () => {
  assert.equal(fixtureSlug({ id: 1, name: 'N8' }), 'n8');
  assert.equal(fixtureSlug({ id: 1, name: 'My Notes App!' }), 'my-notes-app');
  assert.equal(fixtureSlug({ id: 7, name: '!!!' }), 'p7', 'a nameless project still gets a distinct address');
  assert.equal(fixtureSlug({ id: 7, name: '' }), 'p7');
  const long = fixtureSlug({ id: 1, name: 'x'.repeat(200) });
  assert.ok(long.length <= 24);
  assert.match(fixtureEmail('admin', { id: 1, name: 'N8' }), /^admin-n8@fixture\.invalid$/);
  assert.match(fixtureEmail('we!rd role', { id: 1, name: 'N8' }), /^[a-z0-9-]+-n8@fixture\.invalid$/);
});

test('the platform pair is role-named and project-scoped too', () => {
  assert.equal(reviewEmailFor(PROJECT), 'admin-n8@fixture.invalid');
  assert.equal(viewerEmailFor(PROJECT), 'viewer-n8@fixture.invalid');
  // A spec declaring `admin` lands on the SAME address as the platform
  // reviewer, which is the point: one admin fixture per project, not two.
  const { accounts } = from({ admin: { username: 'x@y.com', password: 'p' } });
  assert.equal(accounts[0].email, reviewEmailFor(PROJECT));
});

test('the spec the CHECKS run gets the substituted credentials back', () => {
  // Without this the platform would create the accounts and the checks would go
  // on signing in as whatever the model invented — the substitution would be
  // worse than doing nothing.
  const original = spec({
    admin: { username: 'n8-admin@fixture.invalid', password: 'n8-admin-password-123' },
    viewer: { username: 'nobody@example.com', password: 'hunter2' },
  });
  const { accounts } = screenAccountsFromSpec(original, { project: PROJECT, password: PW });
  const out = withScreenLogins(original, accounts);
  assert.equal(out.login.users.admin.username, 'admin-n8@fixture.invalid');
  assert.equal(out.login.users.admin.password, PW);
  assert.equal(out.login.users.viewer.username, 'viewer-n8@fixture.invalid');
  assert.equal(out.login.users.viewer.password, PW);
  // Untouched on disk and untouched in memory — the original object is not
  // mutated, so a caller that kept a reference still sees what the build wrote.
  assert.equal(original.login.users.admin.password, 'n8-admin-password-123');
  // Everything else about the spec survives.
  assert.equal(out.login.path, '/login');
});

test('withScreenLogins is a no-op when there is nothing to substitute', () => {
  const sp = spec({ admin: { username: 'a@fixture.invalid', password: 'p' } });
  assert.equal(withScreenLogins(sp, []), sp);
  assert.equal(withScreenLogins(null, [{ role: 'admin', email: 'x', password: 'y' }]), null);
  assert.equal(withScreenLogins({ login: null, checks: [] }, [{ role: 'admin' }]).login, null);
});

test('an incomplete or absent login block yields nothing, quietly', () => {
  for (const sp of [null, undefined, {}, { login: null }, { login: {} }, { login: { users: null } }, spec({})]) {
    assert.deepEqual(screenAccountsFromSpec(sp, { project: PROJECT, password: PW }), { accounts: [], renamed: [] });
  }
});

test('the note names what was created AND what was replaced', () => {
  const { accounts, renamed } = from({
    admin: { username: 'real@example.com', password: 'x'.repeat(12) },
  });
  const note = screenAccountsNote({ accounts, renamed, seeded: { ok: true, state: 'seeded' } });
  assert.match(note, /1 declared fixture user\(s\) ready/);
  assert.match(note, /real@example\.com → admin-n8@fixture\.invalid/);
  assert.match(note, /never the one written into the spec/);
});

test('an admin role gets admin preference; anything else falls to the LEAST privileged', () => {
  // A viewer fixture that quietly became an admin makes every permission check
  // pass and proves nothing — the exact defect the second fixture exists to find.
  const { accounts } = from({
    admin: { username: `a${FIXTURE_EMAIL_DOMAIN}`, password: 'x'.repeat(12) },
    viewer: { username: `v${FIXTURE_EMAIL_DOMAIN}`, password: 'x'.repeat(12) },
  });
  const [admin, viewer] = accounts;
  assert.equal(admin.fallback, 'first');
  assert.deepEqual(admin.prefer, [...REVIEW_ROLE_PREFERENCE]);
  assert.equal(viewer.fallback, 'least');
  assert.equal(viewer.prefer[0], 'viewer', 'the role the spec asked for is tried first');
  assert.ok(VIEWER_ROLE_PREFERENCE.every((r) => viewer.prefer.includes(r)));
});

test('a role name the platform has never heard of still gets its own role first', () => {
  const { accounts } = from({ auditor: { username: `x${FIXTURE_EMAIL_DOMAIN}`, password: 'x'.repeat(12) } });
  assert.equal(accounts[0].prefer[0], 'auditor');
  assert.equal(accounts[0].fallback, 'least', 'an unknown role is not assumed to be an admin one');
  assert.equal(accounts[0].key, 'spec-auditor');
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
    ...screenAccountsFromSpec(spec({ admin: { username: `a${FIXTURE_EMAIL_DOMAIN}`, password: 'ignored' } }),
      { project: PROJECT, password: 'spec-pw-5678' }).accounts,
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
  const { accounts } = screenAccountsFromSpec(transformed, { project: PROJECT, password: PW });
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].fallback, 'least',
    'seeding the TRANSFORMED spec would demote the reviewer — which is why the order above is asserted');
});
