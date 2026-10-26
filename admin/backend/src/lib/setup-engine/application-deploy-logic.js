// Pure saved-reference contract, shared by API and independent runner.
import path from 'node:path';
export const APPLICATION_JOB_KINDS = Object.freeze(['application_validate', 'application_deploy', 'application_verify', 'application_rollback']);
export const applicationGuestName = target => `${process.env.LXC_PREFIX ?? 'pp-'}${target}`;
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
export function validateApplicationJob(job, params) {
  const p = params || {};
  return APPLICATION_JOB_KINDS.includes(job.kind) && Number.isSafeInteger(p.applicationId) && p.applicationId > 0 &&
    Number.isSafeInteger(p.profileRevision) && p.profileRevision > 0 && DIGEST.test(p.profileDigest || '') && SHA.test(p.sha || '') && SHA.test(p.treeSha || '') &&
    (p.recoveryOf === undefined || /^[a-zA-Z0-9-]{1,64}$/.test(p.recoveryOf)) &&
    Object.keys(p).every(k => ['applicationId', 'profileRevision', 'profileDigest', 'sha', 'treeSha', 'recoveryOf'].includes(k))
    ? { ok: true } : { ok: false, reason: 'application release jobs carry only immutable profile and exact candidate references' };
}

// The legacy boot unit lxc-zip.js registers (its STARTUP_UNIT_NAME; a test
// keeps the two equal). When its script or working directory lies inside a
// release-managed application's source or release root, it runs as root at
// every boot against the live release, outside the release runner. That is the
// 2026-10 Nodus outage: an old self-deploy script rebuilt the sealed release,
// stripped its permissions, stopped the service and left it down. Every
// application job reports it (job event `legacy_startup`); deploy and rollback
// refuse it while it is enabled; the recovery paths never do.
export const LEGACY_STARTUP_UNIT = 'proxypilot-startup.service';
const LEGACY_STARTUP_DISABLE = `systemctl disable ${LEGACY_STARTUP_UNIT}`;
const shownPath = x => (typeof x === 'string' && /^\/[A-Za-z0-9._/@+-]{0,255}$/.test(x) ? x : null);

// startup: the guest program's inspect `startup` field —
//   { state: 'absent' } | { state: 'unknown' } |
//   { state: 'present', enabled: <systemctl is-enabled word>, scriptPath, workingDir, inside }
// → { code, blocks, message, data } or null when there is nothing to report.
export function legacyStartupFinding(startup) {
  if (!startup || typeof startup !== 'object') return null;
  if (startup.state === 'unknown') return { code: 'LEGACY_STARTUP_UNKNOWN', blocks: false, data: { code: 'LEGACY_STARTUP_UNKNOWN', unit: LEGACY_STARTUP_UNIT },
    message: `Whether the guest's legacy startup unit ${LEGACY_STARTUP_UNIT} exists or runs at boot could not be read. If it runs a script inside this application's live release, disable it in the guest with: ${LEGACY_STARTUP_DISABLE}.` };
  if (startup.state !== 'present' || startup.inside !== true) return null;
  const enabledState = typeof startup.enabled === 'string' && /^[a-z-]{1,32}$/.test(startup.enabled) ? startup.enabled : 'unknown';
  const script = shownPath(startup.scriptPath), workingDir = shownPath(startup.workingDir);
  // The guest-supplied paths go last: a job reason is capped (sanitizeReason),
  // so a long path can never cut off the instruction.
  const where = script ? ` Script: ${script}${workingDir ? `, working directory ${workingDir}` : ''}.` : workingDir ? ` Working directory: ${workingDir}.` : '';
  const data = { unit: LEGACY_STARTUP_UNIT, enabled: enabledState, scriptPath: script, workingDir };
  if (enabledState === 'enabled' || enabledState === 'enabled-runtime') return { code: 'LEGACY_STARTUP_ENABLED', blocks: true, data: { code: 'LEGACY_STARTUP_ENABLED', ...data },
    message: `The guest's legacy startup unit ${LEGACY_STARTUP_UNIT} is enabled: at every boot it runs a script inside the live release as root, outside the release runner. Deploy and rollback are refused while it is enabled. Disable it in the guest with: ${LEGACY_STARTUP_DISABLE}.${where}` };
  return { code: 'LEGACY_STARTUP_REGISTERED', blocks: false, data: { code: 'LEGACY_STARTUP_REGISTERED', ...data },
    message: `The guest still has the legacy startup unit ${LEGACY_STARTUP_UNIT} (${enabledState}) for a script inside the live release. It does not run at boot, and rerun_startup refuses it unless explicitly acknowledged.${where}` };
}

// rerun_startup: the registered release-managed applications (a profile with
// a releaseRoot) on this container whose sourceDir or releaseRoot holds the
// registered startup script or its working directory. Plain path containment
// here; the guest-side check above also resolves links.
export function releaseManagedStartupConflicts(startup, applications, target) {
  const norm = x => (typeof x === 'string' && x.startsWith('/') ? (path.posix.normalize(x).replace(/\/+$/, '') || '/') : null);
  const within = (root, x) => !!root && !!x && (x === root || x.startsWith(root === '/' ? '/' : `${root}/`));
  const paths = [norm(startup?.scriptPath), norm(startup?.workingDir)].filter(Boolean);
  if (!paths.length || !Array.isArray(applications)) return [];
  return applications.filter(app => app?.targetId === target && app.profile?.releaseRoot).filter(app => {
    const roots = [norm(app.profile.sourceDir), norm(app.profile.releaseRoot)].filter(Boolean);
    return paths.some(x => roots.some(root => within(root, x)));
  }).map(app => ({ id: app.id, name: app.name ?? null, sourceDir: app.profile.sourceDir, releaseRoot: app.profile.releaseRoot }));
}
