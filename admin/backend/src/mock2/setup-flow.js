// Mock2 GUIDED SETUP — the native half (project row, container reads, the
// push into the app's own branding).
//
// See setup-flow-logic.js for WHY. This gathers the facts each step's done-state
// is derived from, saves the intake, and reconciles the composed context into
// the running app.
//
// Every read is best-effort: a project still provisioning, a container that
// cannot be reached, an app that has not migrated yet — all ordinary, all
// reported as "not done yet" rather than as an error. A setup panel that can
// fail is worse than no setup panel.
//
// Terminology (risk R7): nothing here is named "agent".

import { getProject, updateProject } from './projects.js';
import { listAssets } from './project-assets.js';
import { readAppAccess } from './app-access.js';
import { ensureReviewAccount, getReviewLogin } from './review-account.js';
import { sh, b64 } from './host.js';
import { MOCKUP_CURRENT } from './concept-logic.js';
import { getSetupFlowSetting } from './settings.js';
import {
  parseSetupIntake, renderSetupIntake, setupStepStates, currentSetupStep,
  setupComplete, setupProgress, shouldShowSetup, composeAppContext,
  INTAKE_KEYS, INTAKE_FIELDS, hasIntakeAnswers,
} from './setup-flow-logic.js';

const APP_DIR = '/srv/app';

function containerSh(containerName, script, { timeoutMs = 20000 } = {}) {
  return sh(`printf '%s' '${b64(script)}' | base64 -d | incus exec ${containerName} -- sh`, { timeoutMs });
}

async function hasMockupFile(project) {
  if (!project?.container_name || project.lifecycle !== 'active') return false;
  try {
    const r = await containerSh(project.container_name, `[ -s '${APP_DIR}/${MOCKUP_CURRENT}' ] && echo yes || echo no`);
    return (r.stdout || '').trim() === 'yes';
  } catch { return false; }
}

// readSetupState(project) → everything the panel renders from.
//
// The account check reuses readAppAccess rather than asking the database: the
// question is "can somebody sign in to the APP", and only the app can answer
// it. It also gives us `unreachable`, which is what separates "not done" from
// "cannot be done yet" — a distinction the panel needs so a provisioning
// container does not look like a failure.
export async function readSetupState(projectId) {
  const project = getProject(projectId);
  if (!project) return null;
  const mode = getSetupFlowSetting();
  const intake = parseSetupIntake(project.setup_intake_json);

  const provisioned = project.lifecycle === 'active' && !!project.container_name;
  let access = { offline: true, unreachable: true, accounts: [], realCount: 0 };
  if (provisioned) {
    try { access = await readAppAccess(project); } catch { /* treated as unreachable */ }
  }
  const appReachable = provisioned && !access.offline && !access.unreachable;
  const hasRealAdmin = (access.realCount || 0) > 0;

  let hasLogo = false;
  try { hasLogo = listAssets(project.id).some((a) => a.kind === 'image' && a.tag === 'logo'); } catch { hasLogo = false; }

  const hasMockup = provisioned ? await hasMockupFile(project) : false;
  const designApproved = !!project.design_approved_at;

  const states = setupStepStates({
    provisioned, appReachable, hasRealAdmin, hasLogo, intake, hasMockup, designApproved,
  });

  return {
    mode,
    show: shouldShowSetup({ mode, intake, states }),
    dismissed: intake.dismissed,
    complete: setupComplete(states),
    progress: setupProgress(states),
    steps: states,
    current: currentSetupStep(states)?.id || null,
    fields: INTAKE_FIELDS,
    intake: Object.fromEntries(INTAKE_KEYS.map((k) => [k, intake[k] || ''])),
    // Surfaced so the panel can say WHY the account step is waiting rather than
    // showing an inert disabled button.
    app_reachable: appReachable,
  };
}

// saveSetupIntake — write the answers, then try to push them into the app.
//
// The write always succeeds (it is a column on a row this platform owns); the
// push is best-effort and retried on later reads. That ordering is the whole
// reason the answers live here: an operator who answers "who is this for" while
// the container is still provisioning must not lose it.
export async function saveSetupIntake(projectId, patch = {}) {
  const project = getProject(projectId);
  if (!project) return { ok: false, error: 'No such project.' };
  const current = parseSetupIntake(project.setup_intake_json);
  const next = { ...current };
  for (const k of INTAKE_KEYS) {
    if (patch[k] === undefined) continue;
    next[k] = String(patch[k] ?? '').trim();
  }
  // Answers changed → the app's copy is stale, so clear the push marker and
  // let the reconciler send it again.
  if (INTAKE_KEYS.some((k) => next[k] !== current[k])) next.pushedAt = null;
  if (patch.dismissed !== undefined) next.dismissed = patch.dismissed === true;
  updateProject(projectId, { setup_intake_json: renderSetupIntake(next) });
  await pushAppContext(projectId).catch(() => {});
  return { ok: true };
}

// pushAppContext — reconcile the composed { summary, audience } into the app's
// own branding row, so the app describes itself on its sign-in screen.
//
// Through the app's OWN admin endpoint rather than a direct table write, for
// the same reason the first-admin flow does: the app owns its validation, and
// the platform should not be the second thing that writes to that row.
//
// Idempotent and silent. Called after every save and on every read, so an app
// that was down when the answers were given picks them up the next time anyone
// looks at the panel.
export async function pushAppContext(projectId) {
  const project = getProject(projectId);
  if (!project?.container_name || project.lifecycle !== 'active') return false;
  const intake = parseSetupIntake(project.setup_intake_json);
  if (!hasIntakeAnswers(intake) || intake.pushedAt) return false;
  const ctx = composeAppContext(intake);
  if (!ctx) return false;

  // PUT /api/admin/branding is admin-guarded, so this needs a session. The
  // platform already keeps its own admin fixture for exactly this class of
  // job — the account the design review signs in with, on the reserved
  // @fixture.invalid domain that never counts as a real user and never takes
  // the operator's first-admin slot. Reusing it means no second credential and
  // no direct write to a row the app owns.
  //
  // ensureReviewAccount is idempotent and cheap on the happy path (one sign-in
  // that returns 200), and returns null when there is nothing to sign in to —
  // an app mid-boot, or one with no auth component. Both mean "not yet".
  let login = null;
  try {
    const r = await ensureReviewAccount(project, { timeoutMs: 30000 });
    login = r?.login || getReviewLogin(project.id);
  } catch { login = getReviewLogin(project.id); }
  if (!login?.email || !login?.password) return false;

  const port = project.web_port || 3000;
  // Payload AND credentials go in through FILES, never an argv: a command line
  // is readable from /proc, and this is the same discipline the first-admin
  // path uses. It is also the only shape that survives an operator's prose,
  // which will contain quotes.
  const payload = JSON.stringify({ appContext: { summary: ctx.summary, audience: ctx.audience } });
  const creds = JSON.stringify({ email: login.email, password: login.password });
  const script = `set -e
umask 077
BODY=$(mktemp); CRED=$(mktemp); JAR=$(mktemp)
trap 'rm -f "$BODY" "$CRED" "$JAR"' EXIT INT TERM
printf '%s' '${b64(payload)}' | base64 -d > "$BODY"
printf '%s' '${b64(creds)}' | base64 -d > "$CRED"
curl -s -o /dev/null -c "$JAR" -X POST -H 'Content-Type: application/json' \\
  --data-binary @"$CRED" "http://127.0.0.1:${port}/api/auth/login" 2>/dev/null || true
CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" -X PUT \\
  -H 'Content-Type: application/json' \\
  --data-binary @"$BODY" \\
  "http://127.0.0.1:${port}/api/admin/branding" 2>/dev/null || echo 000)
echo "CTX:$CODE"`;
  try {
    const r = await containerSh(project.container_name, script, { timeoutMs: 30000 });
    const code = /CTX:(\d{3})/.exec(r.stdout || '')?.[1];
    // 2xx is a push. Anything else — 401 because no admin session, 404 on an
    // app without the platform routes, 000 because it is not listening — means
    // "not yet", and the marker stays clear so the next read tries again.
    if (!code || !/^2/.test(code)) return false;
    const next = { ...intake, pushedAt: new Date().toISOString() };
    updateProject(projectId, { setup_intake_json: renderSetupIntake(next) });
    return true;
  } catch (e) {
    console.warn(`[mock2] app-context push failed for project ${projectId}:`, e?.message);
    return false;
  }
}

// The intake as the concept and build layers want it — a plain object, with no
// panel bookkeeping attached.
export function projectIntake(project) {
  return parseSetupIntake(project?.setup_intake_json);
}

export { INTAKE_FIELDS, INTAKE_KEYS } from './setup-flow-logic.js';
