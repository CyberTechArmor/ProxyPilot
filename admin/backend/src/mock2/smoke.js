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
// Constraints honored here: connectors default-OFF; the DB connector is READ-ONLY;
// the trigger check is cheaper than starting a connector; nothing here is a standing
// gate step (a backend-only change invokes zero connectors); playwright is imported
// lazily so a default install never loads it.
//
// Terminology (risk R7): nothing here is named "agent".

import { sh, b64 } from './host.js';
import {
  smokeConfigFromEnv, evaluateSmokeTriggers, applyEscalations,
  resolveSmokeConnectors, smokeLogLines,
} from './smoke-triggers.js';

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

// Drive the deployed page and assert the rendered journey. Default assertion: a
// fresh-install root shows exactly ONE visible form (the superadmin signup) — the
// "one form, not three" render check. Playwright is imported lazily so a default
// install never loads it. Never throws — returns { ok, detail }.
async function driveBrowserConnector({ url, config }) {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch (err) {
    return { ok: false, unavailable: true, detail: `browser connector: playwright not installed (${err?.message || err})` };
  }
  let browser = null;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    // Count VISIBLE forms — the multi-form render regression shows 3 where 1 is right.
    const forms = await page.locator('form:visible').count();
    const expected = Number(config.browserExpectedForms ?? 1);
    const ok = forms === expected;
    return { ok, detail: `rendered ${forms} visible form(s), expected ${expected}${ok ? '' : ' — journey render mismatch'}` };
  } catch (err) {
    return { ok: false, detail: `browser connector error: ${err?.message || err}` };
  } finally {
    try { if (browser) await browser.close(); } catch { /* ignore */ }
  }
}

// ---- DB connector (READ-ONLY; started only on a hit) ----

// Read the live table(s) and assert the expected data state. READ-ONLY: the query is
// wrapped so it can only SELECT (a default read-only transaction, and we never issue
// a write). Default assertion: on a fresh install, zero users ⇒ canCreateSuperadmin.
// Runs psql inside the container against the in-container Postgres. Never throws.
async function driveDbConnector({ containerName, config }) {
  // A strictly read-only probe: SET TRANSACTION READ ONLY then a single COUNT. The
  // DSN is the app's own env (in-container Postgres); we only read.
  const query = String(config.dbAssertQuery || 'SELECT count(*) AS n FROM users');
  if (!/^\s*select\b/i.test(query) || /;|--|\b(insert|update|delete|drop|alter|truncate|create|grant)\b/i.test(query)) {
    return { ok: false, detail: 'db connector: refusing a non read-only query' };
  }
  const script = `set -a\n. /etc/environment 2>/dev/null || true\nset +a\n`
    + `DSN="\${DATABASE_URL:-\${DB_URL:-}}"\n`
    + `if [ -z "$DSN" ]; then echo "NO_DSN"; exit 0; fi\n`
    // psql in a read-only transaction; -tA = tuples only, unaligned.
    + `psql "$DSN" -v ON_ERROR_STOP=1 -tA -c 'SET TRANSACTION READ ONLY' -c ${shSingleQuote(query)} 2>&1\n`;
  const r = await containerSh(containerName, script, { timeoutMs: 30000 });
  const out = (r.stdout || '').trim();
  if (/NO_DSN/.test(out)) return { ok: false, unavailable: true, detail: 'db connector: no DATABASE_URL in the container environment' };
  if (r.code !== 0) return { ok: false, detail: `db connector query failed: ${out.slice(-300)}` };
  // Default assertion: the first numeric line is the row count; expect the configured
  // value (default 0 users on a fresh install → canCreateSuperadmin true).
  const n = Number((out.match(/-?\d+/) || [])[0]);
  const expected = Number(config.dbExpectedCount ?? 0);
  const ok = Number.isFinite(n) && n === expected;
  return { ok, detail: `query returned ${Number.isFinite(n) ? n : out.slice(0, 80)}, expected ${expected}${ok ? '' : ' — data-state mismatch'}` };
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

  // 2) Deterministic relevance decision (cheaper than starting a connector), plus
  //    any justified, logged escalation. A reason-less escalation is rejected.
  const auto = evaluateSmokeTriggers({ changedFiles, changeMeta, config });
  const { decision, rejected } = applyEscalations(auto, escalations);
  const resolved = resolveSmokeConnectors({ decision, config });

  // 3) Invoke ONLY the connectors resolved to 'ran' (fired AND enabled). Lazy: a
  //    'skipped' or 'unavailable' connector is never started.
  const report = { http, decision: resolved, rejected, browser: null, db: null };

  if (resolved.browser.disposition === 'ran') {
    const target = url || `http://127.0.0.1:${webPort}/`;
    report.browser = { ...(await driveBrowserConnector({ url: target, config })), reason: resolved.browser.reason };
  }
  if (resolved.db.disposition === 'ran') {
    report.db = { ...(await driveDbConnector({ containerName, config })), reason: resolved.db.reason };
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
