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
// gates) the connectors default ON and a warranted-but-unrunnable connector FAILS
// the cycle (SMOKE_REQUIRE_TRIGGERED) — never a silent skip that reads as success.
// The browser connector executes the project's declarative state/ui-checks.json
// interaction checks (ui-checks.js); the DB connector dry-runs the FULL migration
// chain on a scratch database and boots the app against it — the app's own
// database is never written.
//
// Terminology (risk R7): nothing here is named "agent".

import { sh, b64 } from './host.js';
import {
  smokeConfigFromEnv, evaluateSmokeTriggers, applyEscalations,
  resolveSmokeConnectors, smokeLogLines,
} from './smoke-triggers.js';
import { readRunContract } from './deploy.js';
import {
  UI_CHECKS_PATH, parseUiChecks, checksForChangedFiles, uiCheckLogLines, uiCheckFailSummary,
} from './ui-check-logic.js';
import { runUiChecks, launchOptions } from './ui-checks.js';
import { ACCEPTANCE_PATH, parseAcceptance } from './acceptance-logic.js';

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
  const out = r.stdout || '';
  const shell = (out.match(/SHELL:(\d+)/) || [])[1] || '000';
  const spoofWorst = (out.match(/SPOOF_WORST:(\d+)/) || [])[1] || '000';
  const shellOk = shell !== '000' && Number(shell) < 500;
  // If no conventional admin path exists (all 000/404), we can't assert the negative
  // case — report it as not-applicable rather than a false pass.
  const spoofTested = /SPOOF \S+:(2|4)\d\d/.test(out);
  const spoofOk = spoofWorst[0] !== '2';
  const checks = [
    { name: 'shell-serves', ok: shellOk, detail: `GET / → ${shell}` },
    { name: 'negative-auth (spoofed x-user-role rejected)', ok: spoofOk, detail: spoofTested ? `worst spoofed-header response: ${spoofWorst}` : 'no conventional admin path answered — assertion not applicable' },
  ];
  return { ok: checks.every((c) => c.ok), checks };
}

// ---- browser connector (lazy Playwright; started only on a hit) ----

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
async function driveBrowserConnector({ url, config, containerName, appDir, changedFiles, requiredIds = [] }) {
  // 1) Project interaction checks, when declared. The run set is the UNION of
  //    the diff-matched checks and the ACCEPTANCE-REQUIRED ids (cycle-94: the
  //    task's live acceptance — e.g. "Test connection turns all three checks
  //    green" — must be exercised regardless of which paths the diff touched).
  //    A required id with no matching check is a hard failure, not a skip.
  if (containerName) {
    const file = await readUiChecksFile(containerName, appDir);
    const required = Array.isArray(requiredIds) ? requiredIds.filter(Boolean) : [];
    if (!file.exists && required.length) {
      return { ok: false, detail: `acceptance requires live ui check(s) [${required.join(', ')}] but ${UI_CHECKS_PATH} does not exist` };
    }
    if (file.exists) {
      const parsed = parseUiChecks(file.text);
      if (!parsed.ok) return { ok: false, detail: `ui-checks spec invalid: ${parsed.error}` };
      const missing = required.filter((id) => !parsed.spec.checks.some((c) => c.id === id));
      if (missing.length) {
        return { ok: false, detail: `acceptance ui check(s) not defined in ${UI_CHECKS_PATH}: ${missing.join(', ')}` };
      }
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
        return {
          ok: run.ok,
          detail: run.ok
            ? `${run.results.length} interaction check(s) passed${required.length ? ` (incl. ${required.length} acceptance check(s))` : ''}`
            : `${acceptanceFailed.length ? 'ACCEPTANCE check failed — ' : 'interaction checks failed — '}${uiCheckFailSummary(run.results) || run.detail || 'see results'}`,
          uiChecks: run.results.map((r) => ({ ...r, acceptance: required.includes(r.id) })),
          logLines: uiCheckLogLines(run.results),
        };
      }
      // Spec exists but nothing matches this diff — fall through to the render
      // check (and say so; the coverage gate is what enforces matching checks).
    }
  }

  // 2) Fallback: the original journey render check + console errors on load.
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch (err) {
    return { ok: false, unavailable: true, detail: `browser connector: playwright not installed (${err?.message || err})` };
  }
  let browser = null;
  try {
    browser = await chromium.launch(launchOptions());
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 300)); });
    page.on('pageerror', (err) => { consoleErrors.push(String(err?.message || err).slice(0, 300)); });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    // Count VISIBLE forms — the multi-form render regression shows 3 where 1 is right.
    const forms = await page.locator('form:visible').count();
    const expected = Number(config.browserExpectedForms ?? 1);
    const ok = forms === expected && consoleErrors.length === 0;
    const consoleNote = consoleErrors.length ? ` · ${consoleErrors.length} console error(s): ${consoleErrors[0]}` : '';
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
// assertion fails, OR (config.requireTriggered) a warranted connector was unavailable.
// A backend-only change invokes zero connectors and costs one curl round-trip.
export async function runSmokeGate({
  containerName, appDir = '/srv/app', webPort = 3000, url = null,
  changedFiles = [], changeMeta = {}, escalations = [], env = process.env,
}) {
  const config = smokeConfigFromEnv(env);

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
  const allEscalations = acceptanceUi.length
    ? [...escalations, { connector: 'browser', reason: `acceptance requires live ui check(s): ${acceptanceUi.join(', ')}` }]
    : escalations;

  // 2) Deterministic relevance decision (cheaper than starting a connector), plus
  //    any justified, logged escalation. A reason-less escalation is rejected.
  const auto = evaluateSmokeTriggers({ changedFiles, changeMeta, config });
  const { decision, rejected } = applyEscalations(auto, allEscalations);
  const resolved = resolveSmokeConnectors({ decision, config });

  // 3) Invoke ONLY the connectors resolved to 'ran' (fired AND enabled). Lazy: a
  //    'skipped' or 'unavailable' connector is never started.
  const report = { http, decision: resolved, rejected, browser: null, db: null };

  if (resolved.browser.disposition === 'ran') {
    const target = url || `http://127.0.0.1:${webPort}/`;
    report.browser = { ...(await driveBrowserConnector({ url: target, config, containerName, appDir, changedFiles, requiredIds: acceptanceUi })), reason: resolved.browser.reason };
  }
  if (resolved.db.disposition === 'ran') {
    report.db = { ...(await driveDbConnector({ containerName, appDir })), reason: resolved.db.reason };
  }

  // 4) Verdict. The always-on http layer is load-bearing. An invoked connector that
  //    FAILS its assertion fails the gate (a real journey/data-state break). A
  //    connector that was warranted but unavailable is a VISIBLE non-pass only when
  //    the operator opted into requireTriggered; otherwise it's logged loudly and
  //    advisory (connectors are opt-in infra).
  const invokedFail = (report.browser && report.browser.ok === false && !report.browser.unavailable)
    || (report.db && report.db.ok === false && !report.db.unavailable);
  const unavailableWarranted = resolved.browser.disposition === 'unavailable' || resolved.db.disposition === 'unavailable'
    || (report.browser && report.browser.unavailable) || (report.db && report.db.unavailable);
  const ok = !(config.enforceHttp && !http.ok)
    && !invokedFail
    && !(config.requireTriggered && unavailableWarranted);

  const logLines = [
    ...smokeLogLines(resolved),
    ...(report.browser?.logLines || []),
    ...report.rejected.map((r) => `escalation rejected — ${r.why}`),
  ];
  return { ok, report, logLines };
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
  logEvent = null, env = process.env,
}) {
  const changedFiles = await changedFilesForCommit(containerName, appDir, commitSha);
  const changeMeta = { summary: summary || '', ruleUnderTest: instruction || '' };
  const result = await runSmokeGate({ containerName, appDir, webPort, url, changedFiles, changeMeta, escalations, env });
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
