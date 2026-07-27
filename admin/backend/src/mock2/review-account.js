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
  REVIEW_EMAIL, generateReviewPassword, reviewAccountScript, parseReviewAccountResult,
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

  // Reuse the stored password when there is one, so a re-run can actually
  // verify the existing account rather than always failing sign-in and then
  // failing creation (the row already exists) — which would look like a
  // permanent failure on every build after the first.
  const existing = getReviewLogin(project.id);
  const email = existing?.email || REVIEW_EMAIL;
  const password = existing?.password || generateReviewPassword();

  let out;
  try {
    out = await containerSh(containerName, reviewAccountScript({ email, password, port }), { timeoutMs });
  } catch (e) {
    return { ok: false, state: 'failed', reason: e?.message || 'exec failed', login: existing };
  }
  const result = parseReviewAccountResult(out?.stdout || '');

  if (result.state === 'created' || result.state === 'existing') {
    // Persist on 'created'; on 'existing' persist too, because an install that
    // lost the row (restore, manual DB edit) can still re-learn the pair it
    // just proved works.
    try {
      updateProject(project.id, {
        review_login_email: email,
        review_login_password_enc: encryptSecret(password),
      });
    } catch (e) {
      console.warn(`[mock2] could not store the review login for project ${project.id}:`, e?.message);
    }
    return { ...result, login: { email, password } };
  }
  // 'taken' / 'no-auth' / 'failed' — keep whatever we already had (a real admin
  // owning the bootstrap does not invalidate a review account created earlier).
  return { ...result, login: existing };
}

export { REVIEW_EMAIL };
