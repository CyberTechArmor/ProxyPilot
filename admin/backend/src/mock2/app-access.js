// Mock2 APP ACCESS — the native half (container exec).
//
// See app-access-logic.js for WHY. In short: the first administrator belongs to
// the operator, the build is forbidden to create it, and until now the only way
// to satisfy both was to catch the sign-in page during a build. This gives the
// operator the same door on their own schedule.
//
// Everything here is best-effort and never throws: an offline project, a
// container without psql, an app that is still starting — all ordinary
// outcomes, reported as such.
//
// Terminology (risk R7): nothing here is named "agent".

import { sh, b64 } from './host.js';
import { DEFAULT_WEB_PORT } from './template.js';
import {
  accessStateScript, parseAccessState, firstAdminScript, parseFirstAdminResult,
  validateFirstAdmin,
} from './app-access-logic.js';

function containerSh(containerName, script, { timeoutMs = 45000 } = {}) {
  return sh(`printf '%s' '${b64(script)}' | base64 -d | incus exec ${containerName} -- sh`, { timeoutMs });
}

const OFFLINE = Object.freeze({
  canCreateSuperadmin: null,
  statusCode: 0,
  unreachable: true,
  rosterKnown: false,
  accounts: [],
  realCount: 0,
  fixtureCount: 0,
  offline: true,
});

// readAppAccess(project) → the state described in app-access-logic.
export async function readAppAccess(project) {
  if (!project?.container_name || project.lifecycle !== 'active') return { ...OFFLINE };
  const port = project.web_port || DEFAULT_WEB_PORT;
  try {
    const r = await containerSh(project.container_name, accessStateScript({ port }));
    return { ...parseAccessState(r.stdout || ''), offline: false };
  } catch (e) {
    console.warn(`[mock2] app-access read failed for project ${project.id}:`, e?.message);
    return { ...OFFLINE };
  }
}

// createFirstAdmin(project, { email, password }) → { ok, error }.
//
// Goes through the APP's own POST /api/auth/bootstrap/superadmin, so the race
// guard, the password hashing and the audit entry are the app's — the platform
// never writes a user row and never learns anything it would have to be trusted
// with. The password is not logged here or anywhere below.
export async function createFirstAdmin(project, { email, password } = {}) {
  const valid = validateFirstAdmin({ email, password });
  if (!valid.ok) return { ok: false, error: valid.error };
  if (!project?.container_name || project.lifecycle !== 'active') {
    return { ok: false, error: 'The project is not online — start it, then try again.' };
  }
  const port = project.web_port || DEFAULT_WEB_PORT;
  try {
    const r = await containerSh(
      project.container_name,
      firstAdminScript({ port, email: valid.email, password: valid.password }),
      { timeoutMs: 45000 },
    );
    const result = parseFirstAdminResult(r.stdout || '');
    return { ...result, email: result.ok ? valid.email : undefined };
  } catch (e) {
    // The message may carry the shell line; it never carries the credentials
    // (they go in through a file, see firstAdminScript).
    console.warn(`[mock2] first-admin create failed for project ${project.id}:`, e?.message);
    return { ok: false, error: 'The request to the app could not be sent. Check that the project is online.' };
  }
}

export {
  accessSummary, firstAdminInviteMessage, validateFirstAdmin, MIN_PASSWORD_LENGTH,
} from './app-access-logic.js';
