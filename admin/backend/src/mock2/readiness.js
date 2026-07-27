// Mock2 READINESS — the native half (container exec).
//
// See readiness-logic.js for WHY. In short: the deploy probe asked for `/` and
// accepted anything below 500, which on a gated app is the login redirect — so
// a dead database, a failed migration and a 500ing app all read as healthy.
//
// Best-effort: never throws into the caller, which is a build closing out.
//
// Terminology (risk R7): nothing here is named "agent".

import { sh, b64 } from './host.js';
import { DEFAULT_WEB_PORT } from './template.js';
import { readinessScript, parseReadiness } from './readiness-logic.js';

function containerSh(containerName, script, { timeoutMs = 60000 } = {}) {
  return sh(`printf '%s' '${b64(script)}' | base64 -d | incus exec ${containerName} -- sh`, { timeoutMs });
}

// verifyAppReady — is the deployed app actually WORKING, not merely listening?
//
// Pass the platform's fixture credentials to get the check that matters most:
// a signed-in request for the app itself. Without them the probe still runs,
// just without the behind-the-gate question.
export async function verifyAppReady(project, { authed = null, timeoutMs = 60000 } = {}) {
  const containerName = project?.container_name;
  if (!containerName || project.lifecycle !== 'active') {
    return { ready: false, checks: [], failures: ['the project is not online'], summary: 'the project is not online' };
  }
  const port = project.web_port || DEFAULT_WEB_PORT;
  try {
    const r = await containerSh(containerName, readinessScript({ port, authed }), { timeoutMs });
    return parseReadiness(r?.stdout || '');
  } catch (e) {
    return { ready: false, checks: [], failures: [e?.message || 'the readiness probe failed'], summary: e?.message || 'the readiness probe failed' };
  }
}

export { readinessLogLines, readinessChatMessage } from './readiness-logic.js';
