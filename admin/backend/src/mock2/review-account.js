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
  return review ? { email: REVIEW_VIEWER_EMAIL, password: review.password } : null;
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

  // Reuse the stored password when there is one, so a re-run can verify the
  // existing account rather than reseeding it on every build.
  const existing = getReviewLogin(project.id);
  const email = existing?.email || REVIEW_EMAIL;
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
      email, password, viewerEmail: REVIEW_VIEWER_EMAIL, viewerPassword: password,
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
        ? { email: REVIEW_VIEWER_EMAIL, password, role: seeded.accounts.viewer }
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

export { REVIEW_EMAIL, REVIEW_VIEWER_EMAIL };
