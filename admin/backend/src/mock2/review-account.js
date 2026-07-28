// Mock2 REVIEW ACCOUNT — the native half (container exec + credential storage).
//
// See review-account-logic.js for WHY this exists. In short: the design review
// could only ever screenshot the sign-in page, because its only credentials
// came from a fixture-user block the build MODEL may or may not have written.
// The platform provisions its own admin instead, on the auth component's
// reserved @fixture.invalid domain (which that component excludes from "a real
// user exists", so the operator's first-admin bootstrap is untouched).
//
// Everything here is best-effort: an app with no auth component, an app that a
// real administrator already claimed, a container that is busy — all of those
// are ordinary outcomes, not errors. The review still runs; it just says
// honestly that it is looking at the gate.
//
// Terminology (risk R7): nothing here is named "agent".

import { sh, b64 } from './host.js';
import { getProject, updateProject } from './projects.js';
import { encryptSecret, decryptSecret } from '../lib/secrets.js';
import { DEFAULT_WEB_PORT } from './template.js';
import {
  REVIEW_EMAIL, REVIEW_VIEWER_EMAIL, generateReviewPassword, reviewAccountScript,
  parseReviewAccountResult, seedFixtureUserScript, parseSeedResult, reviewFixtureAccounts,
  screenAccountsFromSpec, screenAccountsNote, withScreenLogins,
  reviewEmailFor, viewerEmailFor, fixtureEmail, fixtureSlug,
} from './review-account-logic.js';

function containerSh(containerName, script, { timeoutMs = 60000 } = {}) {
  return sh(`printf '%s' '${b64(script)}' | base64 -d | incus exec ${containerName} -- sh`, { timeoutMs });
}

// The stored credentials for a project, or null. Decryption failures (a
// rotated TOTP_ENCRYPTION_KEY) are treated as "no credentials" — the next
// ensureReviewAccount mints a fresh pair rather than wedging the review.
export function getReviewLogin(projectId) {
  const row = getProject(projectId);
  if (!row?.review_login_email || !row?.review_login_password_enc) return null;
  try {
    const password = decryptSecret(row.review_login_password_enc);
    if (!password) return null;
    return { email: row.review_login_email, password };
  } catch {
    return null;
  }
}

// The UNPRIVILEGED fixture. Same stored password as the reviewer (one secret,
// one decrypt) on a different address — the accounts differ by ROLE, which is
// the only thing they exist to differ by.
export function getViewerLogin(projectId) {
  const review = getReviewLogin(projectId);
  return review ? { email: viewerEmailFor(getProject(projectId)), password: review.password } : null;
}

// Provision (or confirm) the review account inside a deployed project.
//
// Idempotent: the happy path is one sign-in attempt that returns 200 and stops.
// Returns { ok, state, reason, login } — login is the usable credential pair,
// or null when there is nothing to sign in to.
export async function ensureReviewAccount(project, { timeoutMs = 60000 } = {}) {
  const containerName = project?.container_name;
  if (!containerName || project.lifecycle !== 'active') {
    return { ok: false, state: 'offline', reason: 'the project is not online', login: null };
  }
  const port = project.web_port || DEFAULT_WEB_PORT;

  // The PASSWORD is reused when there is one — it is the project's single
  // fixture secret and every fixture account shares it, so rotating it would
  // invalidate accounts this run is not reseeding.
  //
  // The ADDRESS is always the canonical one. A project created before the
  // rename has `design-review@fixture.invalid` stored; keeping it would leave
  // that project permanently on the old shape, since nothing else reseeds. The
  // canonical address simply fails the probe below on the first run after the
  // rename, which takes the seed path, mints both accounts and stores the new
  // address — so every project converges on its own. The old rows are left
  // where they are: fixtures on the reserved domain, invisible to the
  // first-admin bootstrap, removed by "Free the first-admin slot" like any
  // other.
  const existing = getReviewLogin(project.id);
  const email = reviewEmailFor(project);
  const password = existing?.password || generateReviewPassword();

  const persist = () => {
    try {
      updateProject(project.id, {
        review_login_email: email,
        review_login_password_enc: encryptSecret(password),
      });
    } catch (e) {
      console.warn(`[mock2] could not store the review login for project ${project.id}:`, e?.message);
    }
  };

  // 1) Cheapest question first: does it already sign in?
  let probe;
  try {
    probe = parseReviewAccountResult(
      (await containerSh(containerName, reviewAccountScript({ email, password, port }), { timeoutMs }))?.stdout || '',
    );
  } catch (e) {
    return { ok: false, state: 'failed', reason: e?.message || 'exec failed', login: existing };
  }
  if (probe.state === 'no-auth') return { ...probe, login: null };
  if (probe.state === 'existing' || probe.state === 'created') { persist(); return { ...probe, login: { email, password } }; }

  // 2) It did not. SEED THE ROW DIRECTLY.
  //
  // The HTTP bootstrap endpoint above can only ever fire on a project nobody
  // has signed into: it is guarded by "no real user exists yet", and the first
  // thing an operator does is create their administrator. So on every project
  // that matters, step 1 fails and this is the path that actually works. The
  // platform has root in the container; the row lands on the reserved
  // @fixture.invalid domain, which the auth component excludes from "a real
  // user exists", so the operator's first-admin flow is untouched.
  //
  // BOTH fixtures land in one pass: the admin reviewer, and a viewer that must
  // NOT be able to reach the admin screens. With only the admin there is no way
  // to ask that question at all, and a route guarded in the UI but not on the
  // server is the most common real defect in a generated app.
  let seeded;
  try {
    const accounts = reviewFixtureAccounts({
      email, password, viewerEmail: viewerEmailFor(project), viewerPassword: password,
    });
    seeded = parseSeedResult(
      (await containerSh(containerName, seedFixtureUserScript({ accounts }), { timeoutMs }))?.stdout || '',
    );
  } catch (e) {
    return { ok: false, state: 'failed', reason: e?.message || 'seed exec failed', login: existing };
  }
  if (seeded.state === 'no-auth') return { ok: true, state: 'no-auth', reason: seeded.reason, login: null };
  if (!seeded.ok) {
    console.warn(`[mock2] review account seed failed for project ${project.id}: ${seeded.reason}`);
    return { ok: false, state: 'failed', reason: seeded.reason, login: existing };
  }

  // 3) Prove it. A row that exists and cannot sign in is the failure mode worth
  //    catching here rather than in a screenshot of the login page.
  let after;
  try {
    after = parseReviewAccountResult(
      (await containerSh(containerName, reviewAccountScript({ email, password, port }), { timeoutMs }))?.stdout || '',
    );
  } catch {
    after = { state: 'failed', reason: 'could not re-check the sign-in' };
  }
  if (after.state === 'existing') {
    persist();
    return {
      ok: true, state: 'seeded', role: seeded.role, roles: seeded.accounts,
      reason: 'the reviewer account was created',
      login: { email, password },
      // Only offer the viewer when it actually got an unprivileged role. A
      // viewer that fell back to admin would make every permission check pass.
      viewerLogin: seeded.accounts?.viewer && seeded.accounts.viewer !== seeded.accounts.reviewer
        ? { email: viewerEmailFor(project), password, role: seeded.accounts.viewer }
        : null,
    };
  }
  persist();  // keep the credentials: the row exists, so a later probe may pass
  return {
    ok: false,
    state: 'failed',
    reason: `the reviewer row was written (role ${seeded.role}) but signing in still returned ${after.code ?? '?'}`,
    login: { email, password },
  };
}

// ensureScreenAccounts — make the users a project's OWN ui-checks.json declares
// actually exist, so the checks written against them can get past the sign-in
// page.
//
// THE FAILURE THIS ENDS. `ensureReviewAccount` above guarantees the PLATFORM's
// two fixtures, and `withPlatformLogin` deliberately stands aside when the spec
// declares a login block of its own — a build that says how to sign in has made
// a choice the platform must not override. But nothing ever created the users
// that block names. The build model invents an address and a password, writes
// them into the spec, and every check that logs in as one of them signs in
// against a form that rejects it, gets bounced, and times out on an element that
// only exists behind the gate. That is reported as the app failing.
//
// Project 44 build 133: three checks, three timeouts, on a build that had
// deployed and worked. Project 46 build 129: five of seven, at $9.65. The tell
// in both is that the platform's own baseline checks passed in the same run —
// because those use accounts the platform creates.
//
// The spec's ROLES are honoured; its invented credentials are not. Each role
// gets the canonical `{role}-{project}@fixture.invalid` address and the
// project's own generated password — see screenAccountsFromSpec for why both
// substitutions close a real defect rather than express a preference. The
// returned `spec` has those credentials put back into it, so the checks sign in
// as the accounts that now exist.
//
// Best-effort throughout. An app with no auth component, no pg driver, or a
// spec with no login block are ordinary outcomes — the checks then run exactly
// as they did before.
//
// Returns { ok, ran, accounts, renamed, seeded, note, spec }.
// The project ROW rather than the object, so a caller deep in the smoke gate
// does not have to thread one down through four signatures for the sake of a
// name and an id.
export async function ensureScreenAccounts(spec, { projectId, containerName, timeoutMs = 60000 } = {}) {
  const project = getProject(projectId);
  const password = getReviewLogin(projectId)?.password || '';
  const { accounts, renamed } = screenAccountsFromSpec(spec, { project, password });
  const idle = { ok: true, ran: false, accounts: [], renamed: [], seeded: null, note: '', spec };
  if (!containerName || !accounts.length) return idle;
  // Without the project's stored secret there is nothing to seed these accounts
  // WITH, and inventing one here would leave the checks holding a password the
  // panel cannot show. ensureReviewAccount mints and stores it; it runs first.
  if (!password) return { ...idle, note: 'screen accounts: the project has no stored fixture password yet — nothing was created' };

  let seeded;
  try {
    seeded = parseSeedResult(
      (await containerSh(containerName, seedFixtureUserScript({ accounts }), { timeoutMs }))?.stdout || '',
    );
  } catch (e) {
    seeded = { ok: false, state: 'failed', reason: e?.message || 'seed exec failed', accounts: {} };
  }
  if (!seeded.ok && seeded.state !== 'no-auth') {
    console.warn(`[mock2] screen accounts could not be created: ${seeded.reason}`);
  }
  return {
    ok: seeded.ok !== false,
    ran: true,
    accounts,
    renamed,
    seeded,
    note: screenAccountsNote({ accounts, renamed, seeded }),
    // Only rewrite the spec when the rows actually landed. Pointing the checks
    // at credentials that were not created would turn a seeding failure into a
    // wall of sign-in timeouts — the exact report this whole feature exists to
    // stop producing.
    spec: seeded.ok ? withScreenLogins(spec, accounts) : spec,
  };
}

// provisionScreenAccounts — the OPERATOR's button: create every account that
// exists to look at this app's screens, now, and tell them what to sign in with.
//
// WHY IT IS NOT JUST ensureReviewAccount. That function is the build's, and it
// is deliberately lazy: its first step asks "does the reviewer already sign in?"
// and stops on a yes. On a project whose reviewer exists but whose VIEWER never
// landed — every project built before the viewer fixture existed — pressing a
// button that calls it would report success and create nothing. This seeds the
// whole set unconditionally, in one pass, and is idempotent because the seeder
// resets an existing row rather than failing on it.
//
// It also covers the third group: the users the project's own ui-checks.json
// declares. Those are why the operator is here — "no build to date has been able
// to login and assess the screens" is a build signing in as a user nobody made.
//
// Returns { ok, error, accounts: [{ email, password, role, purpose }], note }.
// The passwords ARE returned. They are the PLATFORM's own fixture credentials on
// the reserved @fixture.invalid domain, already stored encrypted against this
// project, and the entire point of the action is that a person can sign in and
// see what the automated checks see. Nothing here touches the operator's own
// account, whose password the platform still never generates, stores, or echoes.
export async function provisionScreenAccounts(project, { timeoutMs = 90000 } = {}) {
  const containerName = project?.container_name;
  if (!containerName || project.lifecycle !== 'active') {
    return { ok: false, error: 'The project is not online — start it, then try again.', accounts: [], note: '' };
  }
  const port = project.web_port || DEFAULT_WEB_PORT;
  const existing = getReviewLogin(project.id);
  const email = reviewEmailFor(project);
  // One secret per project, shared by every fixture account and stored
  // encrypted — 32 base64url characters, never the `n8-admin-password-123` a
  // build model writes into its own spec.
  const password = existing?.password || generateReviewPassword();

  // What the project's own checks say they will sign in as. Read before the
  // seed so all of it lands in ONE exec; a missing or malformed spec is an
  // ordinary outcome — the platform's own pair still gets created.
  let specAccounts = [];
  let renamed = [];
  try {
    const { UI_CHECKS_PATH, parseUiChecks } = await import('./ui-check-logic.js');
    const r = await containerSh(containerName, `cat '/srv/app/${UI_CHECKS_PATH}' 2>/dev/null`, { timeoutMs: 20000 });
    const text = (r?.stdout || '').trim();
    if (text) {
      const parsed = parseUiChecks(text);
      if (parsed.ok) ({ accounts: specAccounts, renamed } = screenAccountsFromSpec(parsed.spec, { project, password }));
    }
  } catch (e) {
    console.warn(`[mock2] could not read the ui-checks spec for project ${project.id}:`, e?.message);
  }

  const platformPair = reviewFixtureAccounts({
    email, password, viewerEmail: viewerEmailFor(project), viewerPassword: password,
  });
  // The platform's pair first, so its addresses win if the spec happens to name
  // one of them — the seeder writes in order and the last write would otherwise
  // decide the reviewer's role.
  const seen = new Set(platformPair.map((a) => a.email.toLowerCase()));
  const accounts = [...platformPair, ...specAccounts.filter((a) => !seen.has(a.email.toLowerCase()))];

  let seeded;
  try {
    seeded = parseSeedResult(
      (await containerSh(containerName, seedFixtureUserScript({ accounts }), { timeoutMs }))?.stdout || '',
    );
  } catch (e) {
    return { ok: false, error: e?.message || 'The seeder could not be run in the container.', accounts: [], note: '' };
  }
  if (seeded.state === 'no-auth') {
    return { ok: false, error: 'This app has no auth component, so there are no accounts to create.', accounts: [], note: '' };
  }
  if (!seeded.ok) {
    return { ok: false, error: seeded.reason || 'The accounts could not be created.', accounts: [], note: '' };
  }

  try {
    updateProject(project.id, { review_login_email: email, review_login_password_enc: encryptSecret(password) });
  } catch (e) {
    console.warn(`[mock2] could not store the review login for project ${project.id}:`, e?.message);
  }

  // Prove it. A row that exists and cannot sign in is exactly the failure this
  // action is meant to end, and finding it here beats finding it in a screenshot
  // of the login page two builds later.
  let signIn = null;
  try {
    signIn = parseReviewAccountResult(
      (await containerSh(containerName, reviewAccountScript({ email, password, port }), { timeoutMs: 60000 }))?.stdout || '',
    );
  } catch { signIn = null; }

  const purposeFor = (key) => {
    if (key === 'reviewer') return 'Administrator. This is the account the design review and the screen checks sign in with — use it to see exactly what they see.';
    if (key === 'viewer') return 'Lowest-privilege role. It exists to prove the admin screens are actually denied on the server, not just hidden in the UI.';
    return 'Declared by this project\'s own ui-checks.json. The checks sign in as this user; until now it had never been created.';
  };
  return {
    ok: true,
    error: null,
    accounts: accounts.map((a) => ({
      email: a.email,
      password: a.password,
      role: seeded.accounts?.[a.key] || null,
      purpose: purposeFor(a.key),
    })),
    renamed,
    // Honest about the one thing worth knowing beyond "created": a seeded row
    // that still cannot sign in means the app's own login path is broken, which
    // is a different problem from the one this button solves.
    signedIn: signIn?.state === 'existing',
    note: signIn && signIn.state !== 'existing'
      ? `The accounts were written, but signing in still returned ${signIn.code ?? '?'} — the app's login path itself is not working.`
      : screenAccountsNote({ accounts: specAccounts, renamed, seeded }),
  };
}

export { REVIEW_EMAIL, REVIEW_VIEWER_EMAIL, screenAccountsFromSpec, fixtureEmail, fixtureSlug };
