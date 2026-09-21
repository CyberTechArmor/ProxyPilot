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
import { readinessScript, parseReadiness, masterKeyRowsCode } from './readiness-logic.js';
import { authDataProbeScript, parseAuthDataProbe } from './auth-data-logic.js';

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
    const stdout = r?.stdout || '';
    // MASTERKEY_ROWS is computed here, not in the guest: it needs the cipher
    // (auth-data-logic.js), and the shell probe stays free of node/jq/python.
    // Only for a project with an auth component that declares what its master
    // secret protects; a failure to work that out yields no line (no check).
    const rowsLine = await masterKeyRowsLine({ containerName, project, stdout }).catch(() => '');
    return parseReadiness(stdout + rowsLine);
  } catch (e) {
    return { ready: false, checks: [], failures: [e?.message || 'the readiness probe failed'], summary: e?.message || 'the readiness probe failed' };
  }
}

async function masterKeyRowsLine({ containerName, project, stdout }) {
  if (/^LOGIN:404$/m.test(stdout)) return '';                 // no auth component
  // Dynamic imports: components.js is the DB module and component-logic sits
  // behind it; this module stays importable without either.
  const [{ listProjectComponents }, { parseContractJson, secretDataGuards }] = await Promise.all([
    import('./components.js'), import('./component-logic.js'),
  ]);
  const guards = [];
  for (const row of listProjectComponents(project.id)) {
    if (row.status !== 'installed') continue;
    for (const g of secretDataGuards(parseContractJson(row.contract_json)?.config || [])) guards.push(g);
  }
  const guard = guards[0]?.guard;
  if (!guard) return '';
  const env = await containerSh(containerName, `sed -n 's/^AUTH_MASTER_SECRET=//p' /etc/environment 2>/dev/null | head -1 | sed -e 's/^"//' -e 's/"$//'`, { timeoutMs: 15000 });
  const envKey = String(env?.stdout || '').trim();
  const probeRun = await containerSh(containerName, authDataProbeScript(guard), { timeoutMs: 20000 });
  const probe = parseAuthDataProbe(probeRun?.stdout || '');
  return `\nMASTERKEY_ROWS:${masterKeyRowsCode({ probe, envKey, legacyDefault: guard.legacy_default })}\n`;
}

export { readinessLogLines, readinessChatMessage } from './readiness-logic.js';
