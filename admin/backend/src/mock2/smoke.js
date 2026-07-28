// Mock2 e2e/journey SMOKE GATE — orchestration (Phase B1). Runs AFTER a cycle's
// gates pass and the app deploys (so it can see the running app), for BOTH runners.
//
// The DEFAULT smoke layer is cheap HTTP/API: hit the deployed app and assert the
// primary journey at the network level (incl. a negative security assertion). Two
// heavier connectors — a BROWSER (drive the deployed UI) and a READ-ONLY DB (inspect
// live rows) — are a RELEVANCE-GATED ESCALATION: they start ONLY when the cycle's
// diff / change metadata warrants them (smoke-triggers.js), and only if the operator
// has enabled them. A connector is started LAZILY — the trigger is evaluated first
// (a regex over the changed-file list, far cheaper than a browser), and it spins up
// only on a hit. Every run/skip + its one-line reason is recorded (no silent skips).
//
// Constraints honored here: the trigger check is cheaper than starting a connector;
// nothing here is a standing gate step (a backend-only change invokes zero
// connectors); playwright is imported lazily so a disabled install never loads it.
// Since change-69 (a disabled-admin-inputs UI regression shipped through five green
// gates) the connectors default ON. A connector left ENABLED that a diff warrants
// but that cannot RUN (playwright missing / no DSN) FAILS the cycle
// (SMOKE_REQUIRE_TRIGGERED) — never a silent skip that reads as success. Turning a
// connector OFF is the opposite, deliberate choice: the build ships (a 'disabled'
// disposition the gate accepts) so a person tests it live.
// The browser connector executes the project's declarative state/ui-checks.json
// interaction checks (ui-checks.js); the DB connector dry-runs the FULL migration
// chain on a scratch database and boots the app against it — the app's own
// database is never written.
//
// Terminology (risk R7): nothing here is named "agent".

import { sh, b64 } from './host.js';
import {
  smokeConfigFromEnv, evaluateSmokeTriggers, applyEscalations,
  resolveSmokeConnectors, smokeLogLines, smokeGateOk, pickContainerIp, httpSmokeChecks,
} from './smoke-triggers.js';
import { readRunContract } from './deploy.js';
import {
  UI_CHECKS_PATH, parseUiChecks, checksForChangedFiles, uiCheckLogLines, uiCheckFailSummary,
  withPlatformLogin, withBaselineChecks, isBaselineCheck,
} from './ui-check-logic.js';
import { runUiChecks, launchOptions, loadChromium } from './ui-checks.js';
import { ACCEPTANCE_PATH, parseAcceptance } from './acceptance-logic.js';
import { smokeEnv } from './settings.js';

// Run a script inside the container (same base64-streamed pivot as the runner).
function containerSh(containerName, script, { timeoutMs = 60000 } = {}) {
  return sh(`printf '%s' '${b64(script)}' | base64 -d | incus exec ${containerName} -- sh`, { timeoutMs });
}

// ---- diff extraction: the cycle reads its own changed-file list ----

// The files a checkpoint commit touched, relative to the app dir. Uses the commit's
// own diff (name-only) so the trigger sees exactly what THIS change modified. Falls
// back to the last commit's tree if a parent range fails (first commit). Best-effort:
// an empty list simply means "no connectors auto-fire".
export async function changedFilesForCommit(containerName, appDir, commitSha) {
  const ref = commitSha ? `'${String(commitSha).replace(/[^0-9a-fA-F]/g, '')}'` : 'HEAD';
  const script = `cd '${appDir}' 2>/dev/null || exit 3\n`
    + `git diff-tree --no-commit-id --name-only -r ${ref} 2>/dev/null`
    + ` || git show --pretty=format: --name-only ${ref} 2>/dev/null\n`;
  const r = await containerSh(containerName, script, { timeoutMs: 30000 });
  return (r.stdout || '')
    .split('\n').map((s) => s.trim()).filter(Boolean)
    .filter((s) => !s.startsWith('state/changes/')); // ignore our own mirror writes
}

// ---- the cheap default layer: HTTP/API journey assertions ----

// Assert the deployed app answers its shell and enforces the negative-auth rule.
// This is the ALWAYS-ON layer (no connector). Deliberately curl-only inside the
// container: cheap, no browser. Returns { ok, checks:[{name,ok,detail}] }.
async function httpSmoke(containerName, webPort) {
  const base = `http://127.0.0.1:${webPort}`;
  const script = `set -e 2>/dev/null || true\n`
    // 1) the shell must serve (not 5xx / not refused)
    + `shell=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "${base}/" 2>/dev/null || echo 000)\n`
    + `echo "SHELL:$shell"\n`
    // 1b) THE SIGN-IN PAGE. The one page a gated app must serve to somebody with
    //     no session, and the question `/` cannot answer: on an auth-gated app a
    //     401 or a redirect at `/` is normal, so the shell probe alone cannot
    //     tell a working app from one nobody can get into. Project 43 deployed
    //     with a feature router shadowing /login — every path answered 401, the
    //     live URL served a JSON error body, and this layer reported ok.
    + `login=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "${base}/login" 2>/dev/null || echo 000)\n`
    + `echo "LOGIN:$login"\n`
    // 2) negative security assertion: a raw spoofed identity header, no token/cookie,
    //    must NOT be honored on an admin path (constitution §4). We can't know every
    //    app's admin route, so probe a few conventional ones; a 2xx to ANY of them
    //    with only the spoofed header is a failure. A 401/403/404 is acceptable.
    + `worst=000\n`
    + `for p in /api/admin /admin /api/users /api/me; do\n`
    + `  c=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 -H 'x-user-role: admin' "${base}$p" 2>/dev/null || echo 000)\n`
    + `  echo "SPOOF $p:$c"\n`
    + `  case "$c" in 2*) worst=$c;; esac\n`
    + `done\n`
    + `echo "SPOOF_WORST:$worst"\n`;
  const r = await containerSh(containerName, script, { timeoutMs: 40000 });
  // The verdict is pure and lives in smoke-triggers.js, where a test can reach
  // it — this module cannot be imported outside a real install.
  return httpSmokeChecks(r.stdout || '');
}

// ---- browser connector (lazy Playwright; started only on a hit) ----

// The browser runs in the BACKEND process, so 127.0.0.1 is the backend's own
// loopback — the app listens inside the project's Incus container (req-76: the
// connector failed a green build with ERR_CONNECTION_REFUSED at
// http://127.0.0.1:3000/). Resolve the container's bridge IPv4 and target that;
// last resort stays loopback so a resolution hiccup degrades to the old
// behavior instead of throwing.
export async function resolveBrowserTarget(containerName, webPort) {
  // Host-side first: `incus list -c4` knows the address regardless of what
  // userland the container ships (no ip/hostname binaries needed inside).
  const safeName = String(containerName || '').replace(/[^a-zA-Z0-9_.-]/g, '');
  try {
    const r = await sh(`incus list '${safeName}' -c 4 --format csv`, { timeoutMs: 15000 });
    // csv cell looks like "10.163.220.42 (eth0)" — strip the interface note.
    const ip = pickContainerIp(String(r.stdout || '').replace(/\([^)]*\)/g, ' ').replace(/[",]/g, ' '));
    if (ip) return `http://${ip}:${webPort}/`;
  } catch { /* fall through */ }
  // In-container probes as backup (host command shape differs on some installs).
  try {
    const r = await containerSh(
      containerName,
      `ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1; hostname -I 2>/dev/null`,
      { timeoutMs: 15000 },
    );
    const ip = pickContainerIp(r.stdout);
    if (ip) return `http://${ip}:${webPort}/`;
  } catch { /* fall through */ }
  return `http://127.0.0.1:${webPort}/`;
}

// Read the project's declarative interaction spec (state/ui-checks.json) from
// the working tree. Returns { exists, text } — parsing/validation is the pure
// layer's job so a malformed spec fails with ONE authoritative error message.
async function readUiChecksFile(containerName, appDir) {
  const script = `if [ -f '${appDir}/${UI_CHECKS_PATH}' ]; then echo '__UI_CHECKS__'; cat '${appDir}/${UI_CHECKS_PATH}'; fi`;
  const r = await containerSh(containerName, script, { timeoutMs: 20000 });
  const out = r.stdout || '';
  if (!out.startsWith('__UI_CHECKS__')) return { exists: false, text: '' };
  return { exists: true, text: out.slice('__UI_CHECKS__'.length).replace(/^\n/, '') };
}

// Drive the deployed UI. PRIMARY layer (change-69): execute the project's
// state/ui-checks.json interaction checks that this diff's changed paths
// warrant — per-role login (seeded fixture users), enabled/disabled control
// assertions, type→value-persisted, Replace→secret-enables flows, and a
// fail-on-any-console-error rule. Falls back to the original render check
// (visible-form count on the root page) when the project has no spec or no
// check matches this diff. A spec that exists but does not parse FAILS the
// connector — a broken test manifest must never read as a pass. Never throws.
async function driveBrowserConnector({ url, config, containerName, appDir, changedFiles, requiredIds = [], reviewLogin = null, viewerLogin = null }) {
  // 1) Project interaction checks, when declared. The run set is the UNION of
  //    the diff-matched checks and the ACCEPTANCE-REQUIRED ids (cycle-94: the
  //    task's live acceptance — e.g. "Test connection turns all three checks
  //    green" — must be exercised regardless of which paths the diff touched).
  //    A required id with no matching check is a hard failure, not a skip.
  if (containerName) {
    const file = await readUiChecksFile(containerName, appDir);
    const required = Array.isArray(requiredIds) ? requiredIds.filter(Boolean) : [];
    // specInvalid marks a problem with the TEST FILE, not with the app.
    //
    // Project 38: the app deployed, served, and worked — and the whole build
    // went red because state/ui-checks.json used a different (equally valid,
    // more conventional) step spelling. A malformed test artefact is a real
    // defect and says so loudly, but it is not evidence the app is broken, and
    // failing the cycle over it threw away a working deploy and made the
    // operator press "Continue build". The caller decides what to do with it.
    if (!file.exists && required.length) {
      return { ok: false, specInvalid: true, detail: `acceptance requires live ui check(s) [${required.join(', ')}] but ${UI_CHECKS_PATH} does not exist` };
    }
    // A spec the model never wrote, or one it wrote badly, must not mean NO
    // rendered-DOM checking at all — that is precisely the cycle where
    // something is most likely wrong. The platform's own baseline runs on an
    // empty spec too.
    const parsed = file.exists ? parseUiChecks(file.text) : { ok: true, spec: { login: null, checks: [] } };
    if (file.exists && !parsed.ok) return { ok: false, specInvalid: true, detail: `ui-checks spec invalid: ${parsed.error}` };
    {
      const missing = required.filter((id) => !parsed.spec.checks.some((c) => c.id === id));
      if (missing.length) {
        return { ok: false, specInvalid: true, detail: `acceptance ui check(s) not defined in ${UI_CHECKS_PATH}: ${missing.join(', ')}` };
      }
      // THE USERS THE SPEC ITSELF DECLARES MUST EXIST.
      //
      // withPlatformLogin below stands aside when the spec has a login block —
      // a build that said how to sign in has made a choice. But nothing ever
      // CREATED the users that block names: the model invents an address and a
      // password, and every check logging in as one of them is rejected at the
      // form and times out behind the gate. Project 44 build 133 lost three
      // checks that way on a build that had deployed and worked.
      //
      // Seeded here rather than at deploy time because here is where the spec is
      // read. Fixture domain only, best effort, one exec.
      //
      // Order matters: this reads the spec AS WRITTEN, before the two transforms
      // below add their own users. withPlatformLogin adds the reviewer under a
      // role called `platform`, which is not an admin role name — seeding from
      // the transformed spec would give the reviewer the LEAST privileged role
      // in the table and quietly break every admin screen it exists to reach.
      let screenAccounts = null;
      try {
        const { ensureScreenAccounts } = await import('./review-account.js');
        screenAccounts = await ensureScreenAccounts(parsed.spec, { containerName });
      } catch (e) {
        screenAccounts = { note: `screen accounts could not be checked: ${e?.message || 'unknown error'}` };
      }
      // Sign the checks in when the spec did not say how — otherwise they run
      // anonymous, get bounced to /login, and time out on elements that only
      // exist behind the gate (project 40: three checks, three timeouts).
      parsed.spec = withPlatformLogin(parsed.spec, reviewLogin);
      // The PLATFORM's own checks, on top of whatever the model wrote. They
      // assert base-app guarantees the platform ships and therefore knows are
      // there — including the one question a single admin fixture could never
      // ask: is the admin route actually denied to a viewer, or only hidden?
      parsed.spec = withBaselineChecks(parsed.spec, { reviewLogin, viewerLogin });
      const matched = checksForChangedFiles(parsed.spec, changedFiles);
      const byId = new Map(matched.map((c) => [c.id, c]));
      for (const id of required) {
        if (!byId.has(id)) byId.set(id, parsed.spec.checks.find((c) => c.id === id));
      }
      const toRun = [...byId.values()];
      if (toRun.length) {
        const run = await runUiChecks({ baseUrl: url, spec: parsed.spec, checks: toRun });
        if (run.unavailable) return { ok: false, unavailable: true, detail: run.detail };
        const acceptanceFailed = run.results.filter((r) => required.includes(r.id) && !r.ok);
        // A baseline failure is a statement about the BASE APP, not about the
        // change the operator just asked for. Naming it separately stops an
        // hour being spent reading a build diff for a defect that is not in it.
        const baselineFailed = run.results.filter((r) => isBaselineCheck(r) && !r.ok);
        const baselineRan = run.results.filter(isBaselineCheck).length;
        return {
          ok: run.ok,
          detail: run.ok
            ? `${run.results.length} interaction check(s) passed${baselineRan ? ` (incl. ${baselineRan} platform baseline)` : ''}${required.length ? ` (incl. ${required.length} acceptance check(s))` : ''}`
            : `${acceptanceFailed.length ? 'ACCEPTANCE check failed — ' : baselineFailed.length && baselineFailed.length === run.results.filter((r) => !r.ok).length ? 'BASE APP check failed (not your change) — ' : 'interaction checks failed — '}${uiCheckFailSummary(run.results) || run.detail || 'see results'}`,
          uiChecks: run.results.map((r) => ({ ...r, acceptance: required.includes(r.id), baseline: isBaselineCheck(r) })),
          // The screen-accounts line goes FIRST: when a login check fails, the
          // next question is always "did that user exist?", and the answer
          // should be on the line above rather than inferred from a timeout.
          logLines: [
            ...(screenAccounts?.note ? [`ui-check ${screenAccounts.note}`] : []),
            ...uiCheckLogLines(run.results),
          ],
          screenAccounts: screenAccounts?.note || null,
        };
      }
      // Spec exists but nothing matches this diff — fall through to the render
      // check (and say so; the coverage gate is what enforces matching checks).
    }
  }

  // 2) Fallback: the original journey render check + console errors on load.
  const chromium = await loadChromium();
  if (!chromium) {
    return { ok: false, unavailable: true, detail: 'browser connector: playwright-core is not installed (npm install in admin/backend, or rerun update.sh)' };
  }
  let browser = null;
  try {
    browser = await chromium.launch(launchOptions());
    const page = await browser.newPage();
    const consoleErrors = [];
    // Same collection rules as runUiChecks: the favicon probe is noise, and
    // every entry carries the failing URL so a "404 (Not Found)" names the
    // resource (a New-6 build failed on exactly this with no way to tell what
    // 404'd).
    page.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      const src = String(msg.location()?.url || '');
      if (/failed to load resource/i.test(msg.text()) && /favicon\.ico(\?|$)/i.test(src)) return;
      consoleErrors.push(`${msg.text()}${src ? ` [${src}]` : ''}`.slice(0, 300));
    });
    page.on('pageerror', (err) => { consoleErrors.push(String(err?.message || err).slice(0, 300)); });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    // Count VISIBLE forms — the multi-form render regression shows 3 where 1 is right.
    const forms = await page.locator('form:visible').count();
    const expected = Number(config.browserExpectedForms ?? 1);
    const ok = forms === expected && consoleErrors.length === 0;
    const consoleNote = consoleErrors.length ? ` · ${consoleErrors.length} console error(s): ${consoleErrors.slice(0, 3).join(' | ')}` : '';
    return { ok, detail: `no matching ui-checks — render fallback: ${forms} visible form(s), expected ${expected}${consoleNote}` };
  } catch (err) {
    return { ok: false, detail: `browser connector error: ${err?.message || err}` };
  } finally {
    try { if (browser) await browser.close(); } catch { /* ignore */ }
  }
}

// ---- DB connector (migration dry-run on a SCRATCH database; started only on a hit) ----

// A diff that touches migrations/ or the data layer must prove two things
// before the cycle can succeed: (1) the FULL migration chain applies cleanly to
// a scratch database created for this run, and (2) the app BOOTS against that
// result (declared start command, throwaway port, HTTP answer). The deploy step
// already migrated the LIVE database, so "pending migrations apply" is vacuous
// by smoke time — a from-zero chain apply is the assertion that actually
// catches a broken/ordered-wrong/new migration. The app's own database is never
// touched: everything runs against smoke_mig_<pid>, dropped afterwards. Runs
// inside the container (psql + the declared run contract). Never throws.
async function driveDbConnector({ containerName, appDir }) {
  const contract = await readRunContract(containerName, appDir);
  if (!contract.hasContract || !contract.migrate) {
    // Nothing declared to dry-run (placeholder project / no migrate command) —
    // visible in the log, not a silent pass of something that exists.
    return { ok: true, detail: 'no run contract / migrate command declared — no migration chain to verify' };
  }
  const bootPort = 18973; // fixed throwaway port well away from app ports
  const script = `set -a\n. /etc/environment 2>/dev/null || true\nset +a\n`
    + `cd '${appDir}' 2>/dev/null || { echo "NO_APPDIR"; exit 0; }\n`
    + `DSN="\${DATABASE_URL:-\${DB_URL:-}}"\n`
    + `if [ -z "$DSN" ]; then echo "NO_DSN"; exit 0; fi\n`
    + `SMOKEDB="smoke_mig_$$"\n`
    // A scratch DSN: swap the database name in the app's own DSN.
    + `SDSN=$(printf '%s' "$DSN" | sed -E "s#/[^/?]+(\\?.*)?\$#/\${SMOKEDB}\\1#")\n`
    + `psql "$DSN" -v ON_ERROR_STOP=1 -c "CREATE DATABASE \${SMOKEDB}" >/dev/null 2>&1 || { echo "CREATE_FAIL"; exit 0; }\n`
    + `cleanup() { psql "$DSN" -c "DROP DATABASE IF EXISTS \${SMOKEDB} WITH (FORCE)" >/dev/null 2>&1 || psql "$DSN" -c "DROP DATABASE IF EXISTS \${SMOKEDB}" >/dev/null 2>&1; }\n`
    + `trap cleanup EXIT\n`
    // (1) full migration chain against the scratch DB.
    + `if DATABASE_URL="$SDSN" DB_URL="$SDSN" timeout 180 sh -c ${shSingleQuote(String(contract.migrate))} >/tmp/smoke-mig.log 2>&1; then\n`
    + `  echo "MIGRATE:ok"\n`
    + `else\n`
    + `  echo "MIGRATE:fail"\n  tail -c 1500 /tmp/smoke-mig.log\n  exit 0\nfi\n`
    // (2) boot the app against the migrated scratch DB on a throwaway port.
    + `( DATABASE_URL="$SDSN" DB_URL="$SDSN" PORT=${bootPort} WEB_PORT=${bootPort} setsid timeout 30 sh -c ${shSingleQuote(String(contract.start))} >/tmp/smoke-boot.log 2>&1 & echo $! > /tmp/smoke-boot.pid )\n`
    + `code=000\n`
    + `for i in $(seq 1 20); do\n`
    + `  code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 2 "http://127.0.0.1:${bootPort}/" 2>/dev/null || echo 000)\n`
    + `  [ "$code" != "000" ] && break\n  sleep 1\ndone\n`
    + `echo "BOOT:$code"\n`
    + `[ "$code" = "000" ] && tail -c 800 /tmp/smoke-boot.log\n`
    + `pid=$(cat /tmp/smoke-boot.pid 2>/dev/null); [ -n "$pid" ] && kill -- -"$pid" >/dev/null 2>&1; rm -f /tmp/smoke-boot.pid\n`;
  const r = await containerSh(containerName, script, { timeoutMs: 300000 });
  const out = (r.stdout || '').trim();
  if (/NO_DSN/.test(out)) return { ok: false, unavailable: true, detail: 'db connector: no DATABASE_URL in the container environment' };
  if (/NO_APPDIR/.test(out)) return { ok: false, detail: 'db connector: app dir missing' };
  if (/CREATE_FAIL/.test(out)) return { ok: false, detail: 'db connector: could not create the scratch database (psql/permissions)' };
  const migrated = /MIGRATE:ok/.test(out);
  if (!migrated) {
    const log = out.split('MIGRATE:fail')[1] || '';
    return { ok: false, detail: `migration chain failed on a scratch database: ${log.trim().slice(-400) || 'see /tmp/smoke-mig.log'}` };
  }
  const boot = (out.match(/BOOT:(\d+)/) || [])[1] || '000';
  const booted = boot !== '000' && Number(boot) < 500;
  return {
    ok: booted,
    detail: booted
      ? `migration chain applied cleanly to a scratch database and the app booted against it (GET / → ${boot})`
      : `migrations applied but the app did NOT boot against the result (GET / → ${boot})`,
  };
}

function shSingleQuote(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }

// ---- the smoke gate: default HTTP layer + relevance-gated connectors ----

// runSmokeGate — the whole gate for one cycle. Returns
//   { ok, report, logLines } where report = { http, browser, db, decision, rejected }.
// ok is false only when the ALWAYS-ON http layer fails, OR an INVOKED connector's
// assertion fails, OR (config.requireTriggered) a warranted, still-ENABLED connector
// could not run. A connector the operator turned OFF ships the build (never fails).
// A backend-only change invokes zero connectors and costs one curl round-trip.
export async function runSmokeGate({
  containerName, appDir = '/srv/app', webPort = 3000, url = null,
  changedFiles = [], changeMeta = {}, escalations = [], requiredIds = [], env = process.env,
  reviewLogin = null, viewerLogin = null,
}) {
  // The dashboard's browser toggle (settings.smokeEnv) overlays the env var —
  // an operator flips the connector from the UI without touching .env.
  const config = smokeConfigFromEnv(smokeEnv(env));

  // 1) The cheap default layer — always runs, no connector.
  const http = await httpSmoke(containerName, webPort);

  // 1b) The task's ACCEPTANCE spec may require live ui checks (cycle-94: the
  //     stated acceptance must be exercised against the deployed app, not live
  //     in prose). Required ids force the browser connector via a logged
  //     escalation even when the diff alone wouldn't warrant it.
  let acceptanceUi = [];
  try {
    const accRaw = await containerSh(containerName, `cat '${appDir}/${ACCEPTANCE_PATH}' 2>/dev/null`, { timeoutMs: 15000 });
    if ((accRaw.stdout || '').trim()) {
      const parsedAcc = parseAcceptance(accRaw.stdout);
      if (parsedAcc.ok) acceptanceUi = parsedAcc.spec.ui;
    }
  } catch { /* best effort — finish-time enforcement owns spec validity */ }
  // Builder-declared machine acceptance (finish acceptance_ids — ratchet 7):
  // union with the task-spec ids; both force the browser connector and both
  // hard-fail when the id has no defined check.
  acceptanceUi = [...new Set([...acceptanceUi, ...(Array.isArray(requiredIds) ? requiredIds.filter(Boolean) : [])])];
  const allEscalations = acceptanceUi.length
    ? [...escalations, { connector: 'browser', reason: `acceptance requires live ui check(s): ${acceptanceUi.join(', ')}` }]
    : escalations;

  // 2) Deterministic relevance decision (cheaper than starting a connector), plus
  //    any justified, logged escalation. A reason-less escalation is rejected.
  const auto = evaluateSmokeTriggers({ changedFiles, changeMeta, config });
  const { decision, rejected } = applyEscalations(auto, allEscalations);
  const resolved = resolveSmokeConnectors({ decision, config });

  // 3) Invoke ONLY the connectors resolved to 'ran' (fired AND enabled). Lazy: a
  //    'skipped' (didn't fire) or 'disabled' (operator toggled off) connector is
  //    never started.
  const report = { http, decision: resolved, rejected, browser: null, db: null };

  if (resolved.browser.disposition === 'ran') {
    const target = url || await resolveBrowserTarget(containerName, webPort);
    report.browser = { ...(await driveBrowserConnector({ url: target, config, containerName, appDir, changedFiles, requiredIds: acceptanceUi, reviewLogin, viewerLogin })), reason: resolved.browser.reason };
  }
  if (resolved.db.disposition === 'ran') {
    report.db = { ...(await driveDbConnector({ containerName, appDir })), reason: resolved.db.reason };
  }

  // 4) Verdict (pure, in smoke-triggers.js so it is unit-testable). The always-on
  //    http layer is load-bearing; an invoked connector that FAILS its assertion
  //    fails the gate. A connector the operator TURNED OFF ('disabled') is never
  //    started, so it ships the build for live human testing — it never fails the
  //    gate. Only a still-ENABLED connector that fired and could NOT run (playwright
  //    missing / no DSN) is a warranted-but-unrunnable non-pass, under requireTriggered.
  const ok = smokeGateOk({ http, report, config });

  // Did the gate fail because the app is broken, or because the TEST FILE is?
  // Surfaced separately so the runner can keep a working deploy while still
  // saying loudly that the checks could not run (see the specInvalid note
  // above). Only meaningful when the gate did not pass.
  const specInvalid = !ok && report.browser?.specInvalid === true && http.ok !== false;

  const logLines = [
    ...smokeLogLines(resolved),
    ...(report.browser?.logLines || []),
    ...report.rejected.map((r) => `escalation rejected — ${r.why}`),
  ];
  return { ok, specInvalid, report, logLines };
}

// A one-line summary of WHY the smoke gate failed, for the cycle error + status.
export function smokeFailSummary(report) {
  const parts = [];
  if (report?.http && !report.http.ok) parts.push(`http: ${report.http.checks.filter((c) => !c.ok).map((c) => c.name).join(', ')}`);
  if (report?.browser && report.browser.ok === false && !report.browser.unavailable) parts.push(`browser: ${report.browser.detail}`);
  if (report?.db && report.db.ok === false && !report.db.unavailable) parts.push(`db: ${report.db.detail}`);
  return parts.join(' · ') || 'smoke assertions failed';
}

// smokeAfterDeploy — the shared post-deploy entry point BOTH runners call
// identically (harness parity). Reads the cycle's own changed-file list, runs the
// gate (cheap http always; connectors only on a relevance hit), records the report
// + the explicit run/skip lines (no silent skips), and returns { ok, report }.
export async function smokeAfterDeploy({
  containerName, appDir = '/srv/app', webPort = 3000, url = null,
  commitSha = null, summary = '', instruction = '', escalations = [],
  requiredIds = [], logEvent = null, env = process.env, reviewLogin = null, viewerLogin = null,
}) {
  const changedFiles = await changedFilesForCommit(containerName, appDir, commitSha);
  const changeMeta = { summary: summary || '', ruleUnderTest: instruction || '' };
  const result = await runSmokeGate({ containerName, appDir, webPort, url, changedFiles, changeMeta, escalations, requiredIds, env, reviewLogin, viewerLogin });
  if (typeof logEvent === 'function') {
    try {
      logEvent('smoke', {
        role: 'system',
        content: result.logLines.join('\n'),
        meta: { ok: result.ok, changed_files: changedFiles.slice(0, 50), report: result.report },
      });
    } catch { /* best effort */ }
  }
  return result;
}
