// Mock2 smoke-gate relevance triggers — PURE decision layer (native-free,
// unit-tested). The e2e/journey smoke gate defaults to the cheap HTTP/API layer;
// two heavier connectors — a browser (drive the deployed UI) and a read-only DB
// (inspect live rows) — are a RELEVANCE-GATED ESCALATION, never a standing step.
//
// This module answers the ONE question that must be cheaper than starting a
// connector: given the cycle's changed files + change metadata, does this change
// WARRANT the browser and/or the DB connector? The decision is deterministic
// (static analysis of changed paths + change-record/inventory metadata), so the
// model never decides arbitrarily to launch a browser or DB session. A justified
// escalation to a connector that didn't auto-fire is allowed — but only with a
// stated reason, which this module requires and records.
//
// smoke.js (the native half) starts a connector only when this module says `fire`,
// and records every run/skip + the one-line reason (no silent skips).
//
// Terminology (risk R7): nothing here is named "agent".

// Default trigger globs + metadata patterns. Overridable via env (smokeConfigFromEnv)
// so an operator can tune what counts as user-facing / data-semantic without a code
// change. Globs match the cycle's changed-file paths (relative to the app dir).
export const DEFAULT_SMOKE_CONFIG = Object.freeze({
  // Connectors are ON by default (the change-69 lesson: a UI regression shipped
  // through five green gates because nothing exercised the rendered DOM). A
  // trigger still gates WHEN they run — a backend-only diff invokes neither.
  // The toggle to turn one OFF is per install: SMOKE_BROWSER_ENABLED=0 /
  // SMOKE_DB_ENABLED=0. Turning a connector off is an explicit choice to test the
  // deployed build live by hand — it SHIPS (a 'disabled' disposition the gate
  // accepts), it does NOT fail the cycle. That is the whole point of the toggle.
  browserEnabled: true,
  dbEnabled: true,
  // requireTriggered governs the OTHER case: a connector left ENABLED that a diff
  // warrants but that then cannot RUN (playwright missing, no DSN). That is a
  // warranted-but-unrunnable check and FAILS the smoke gate ("fail-visibly when
  // dependencies are missing") — it must never read as success. It does NOT apply
  // to a connector the operator deliberately turned off (that ships for live
  // testing, above). Opt out with SMOKE_REQUIRE_TRIGGERED=0.
  requireTriggered: true,
  // If true, a failing ALWAYS-ON http layer fails the cycle. Default false so adding
  // the smoke gate does not change outcomes for apps whose conventional admin-path
  // probing we haven't validated — the http result is logged either way. An INVOKED
  // connector (operator explicitly enabled it) that fails ALWAYS fails the cycle,
  // regardless of this flag.
  enforceHttp: false,
  // Browser fires when the diff touches user-facing render/flow.
  browserGlobs: Object.freeze([
    'public/**', '**/*.html', '**/*.css', '**/*.scss',
    '**/*.jsx', '**/*.tsx', '**/views/**', '**/templates/**',
    '**/*login*', '**/*signup*', 'app.html', '**/app.html',
  ]),
  // Change-record/inventory metadata that marks a screen or user-journey change.
  browserMetaPattern: '\\b(screen|page|login|signup|sign-up|form|render|layout|ui|user[- ]?journey|flow|front[- ]?end)\\b',
  // DB fires when the diff touches data/state semantics.
  dbGlobs: Object.freeze([
    'migrations/**', '**/migrations/**', '**/*.sql',
    '**/schema.*', '**/schema/**', '**/drizzle/**',
    '**/*seed*', '**/*bootstrap*', '**/*first-run*', '**/*firstrun*',
  ]),
  // Logic whose correctness depends on runtime rows, or a rule about data state.
  dbMetaPattern: '\\b(bootstrap|superadmin|super[- ]?admin|first[- ]?user|users?[- ]?exist|canCreateSuperadmin|seed|seeding|first[- ]?run|user existence|data state|row[- ]?level)\\b',
});

// Build the effective config from the environment (all optional). Globs are
// comma-separated; enable flags are '1'/'true'. Missing keys fall back to defaults.
export function smokeConfigFromEnv(env = {}) {
  const list = (v, def) => {
    if (v == null || String(v).trim() === '') return def;
    return String(v).split(',').map((s) => s.trim()).filter(Boolean);
  };
  const bool = (v, def) => (v == null || String(v).trim() === '' ? def : /^(1|true|yes|on)$/i.test(String(v).trim()));
  return {
    ...DEFAULT_SMOKE_CONFIG,
    browserEnabled: bool(env.SMOKE_BROWSER_ENABLED, DEFAULT_SMOKE_CONFIG.browserEnabled),
    dbEnabled: bool(env.SMOKE_DB_ENABLED, DEFAULT_SMOKE_CONFIG.dbEnabled),
    requireTriggered: bool(env.SMOKE_REQUIRE_TRIGGERED, DEFAULT_SMOKE_CONFIG.requireTriggered),
    enforceHttp: bool(env.SMOKE_GATE_ENFORCING, DEFAULT_SMOKE_CONFIG.enforceHttp),
    browserGlobs: list(env.SMOKE_BROWSER_GLOBS, DEFAULT_SMOKE_CONFIG.browserGlobs),
    dbGlobs: list(env.SMOKE_DB_GLOBS, DEFAULT_SMOKE_CONFIG.dbGlobs),
    browserMetaPattern: env.SMOKE_BROWSER_META || DEFAULT_SMOKE_CONFIG.browserMetaPattern,
    dbMetaPattern: env.SMOKE_DB_META || DEFAULT_SMOKE_CONFIG.dbMetaPattern,
  };
}

// A tiny, dependency-free glob matcher supporting '*' (within a path segment) and
// '**' (across segments). Anchored full-path match. Pure + tested.
export function matchGlob(path, glob) {
  const p = String(path || '').replace(/^\.\//, '').replace(/^\/+/, '');
  let re = '';
  const g = String(glob || '');
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        i++;
        if (g[i + 1] === '/') { i++; re += '(?:.*/)?'; } // '**/': zero or more dirs
        else re += '.*';
      } else {
        re += '[^/]*';
      }
    } else if ('.+?^${}()|[]\\/'.includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  try { return new RegExp(`^${re}$`, 'i').test(p); } catch { return false; }
}

// Which changed files matched any of the globs (for the log reason).
function matchedFiles(changedFiles = [], globs = []) {
  const out = [];
  for (const f of changedFiles) {
    if (globs.some((g) => matchGlob(f, g))) out.push(f);
  }
  return out;
}

// Combine the change-record/inventory text a metadata pattern is tested against.
function metaHaystack({ summary = '', rulesText = '', ruleUnderTest = '', inventoryText = '', screensTouched = [] } = {}) {
  return [summary, rulesText, ruleUnderTest, inventoryText, (screensTouched || []).join(' ')]
    .filter(Boolean).join('\n');
}

function metaMatches(haystack, pattern) {
  if (!pattern) return false;
  try { return new RegExp(pattern, 'i').test(haystack); } catch { return false; }
}

// evaluateSmokeTriggers — the deterministic auto-decision. Returns, per connector,
// { fire, reason, matched } where `matched` is the concrete evidence (paths or
// 'metadata') for the log line. Runs BEFORE any connector starts and is far cheaper
// than starting one (regex over a path list).
export function evaluateSmokeTriggers({ changedFiles = [], changeMeta = {}, config = DEFAULT_SMOKE_CONFIG } = {}) {
  const files = Array.isArray(changedFiles) ? changedFiles.filter(Boolean) : [];
  const hay = metaHaystack(changeMeta);

  const browserFiles = matchedFiles(files, config.browserGlobs);
  const browserMeta = metaMatches(hay, config.browserMetaPattern);
  const browserFire = browserFiles.length > 0 || browserMeta;

  const dbFiles = matchedFiles(files, config.dbGlobs);
  const dbMeta = metaMatches(hay, config.dbMetaPattern);
  const dbFire = dbFiles.length > 0 || dbMeta;

  return {
    browser: {
      fire: browserFire,
      matched: browserFiles,
      reason: browserFire
        ? (browserFiles.length ? `user-facing paths in diff (${browserFiles.slice(0, 3).join(', ')}${browserFiles.length > 3 ? ', …' : ''})` : 'change metadata marks a screen / user-journey change')
        : 'no user-facing paths in diff',
    },
    db: {
      fire: dbFire,
      matched: dbFiles,
      reason: dbFire
        ? (dbFiles.length ? `data/state paths in diff (${dbFiles.slice(0, 3).join(', ')}${dbFiles.length > 3 ? ', …' : ''})` : 'rule under test is about data state')
        : 'no data/state paths in diff',
    },
  };
}

// applyEscalations — allow a justified, LOGGED escalation to a connector that did
// not auto-fire. Each escalation is { connector:'browser'|'db', reason }. A reason
// is REQUIRED: an escalation without one is rejected (flagged), never honored — the
// model may not launch a connector "just in case" or silently. Returns the updated
// decision plus `rejected` (the flagged, reason-less escalations).
export function applyEscalations(decision, escalations = []) {
  const out = { browser: { ...decision.browser }, db: { ...decision.db } };
  const rejected = [];
  for (const e of Array.isArray(escalations) ? escalations : []) {
    const conn = e && (e.connector === 'browser' || e.connector === 'db') ? e.connector : null;
    const reason = e && typeof e.reason === 'string' ? e.reason.trim() : '';
    if (!conn) { rejected.push({ escalation: e, why: 'unknown connector' }); continue; }
    if (!reason) { rejected.push({ escalation: e, why: 'escalation without a stated reason is not permitted' }); continue; }
    if (out[conn].fire) continue; // already auto-fired; escalation is a no-op
    out[conn] = { fire: true, matched: out[conn].matched, escalated: true, reason: `escalated: ${reason}` };
  }
  return { decision: out, rejected };
}

// resolveConnectorRun — turn a per-connector fire decision + the enable flag into a
// terminal disposition for the run log:
//   'ran'      — fired AND enabled: the connector is invoked.
//   'skipped'  — did not fire: intentionally bypassed (with its reason).
//   'disabled' — fired but the operator TURNED THE CONNECTOR OFF (the build toggle):
//                a deliberate hand-off to live human testing. It is logged loudly
//                (never a silent skip) but does NOT fail the gate — shipping the
//                build so a person can test it is the whole point of the toggle.
//                (A connector left ENABLED that fires but then cannot run —
//                playwright missing, no DSN — is a DIFFERENT thing: it reports
//                unavailable at RUN time and still fails under requireTriggered.
//                See smoke.js.)
export function resolveConnectorRun(connDecision, enabled) {
  if (!connDecision.fire) return { disposition: 'skipped', reason: connDecision.reason, escalated: false };
  if (!enabled) return { disposition: 'disabled', reason: `${connDecision.reason} — connector turned off; the build ships for live human testing`, escalated: !!connDecision.escalated };
  return { disposition: 'ran', reason: connDecision.reason, escalated: !!connDecision.escalated };
}

// The full run/skip resolution for both connectors, ready for logging + invocation.
export function resolveSmokeConnectors({ decision, config = DEFAULT_SMOKE_CONFIG }) {
  return {
    browser: resolveConnectorRun(decision.browser, config.browserEnabled),
    db: resolveConnectorRun(decision.db, config.dbEnabled),
  };
}

// One-line, human-readable run/skip lines for the cycle log (no silent skips).
export function smokeLogLines(resolved) {
  return [
    `browser: ${resolved.browser.disposition} — ${resolved.browser.reason}`,
    `db: ${resolved.db.disposition} — ${resolved.db.reason}`,
  ];
}

// smokeGateOk — the smoke-gate pass/fail decision, kept in the pure layer so it is
// unit-testable without a container. Inputs: the always-on `http` result, the per-
// connector run `report` (browser/db each null | { ok, unavailable? }) for the
// connectors that actually ran, and the effective config. Rules:
//   * enforceHttp && the http layer failed                              → fail
//   * an INVOKED connector's assertion failed (ok===false, not unavailable) → fail
//   * requireTriggered && an ENABLED connector fired but could not RUN
//     (report.*.unavailable — playwright missing / no DSN)              → fail
//   * a connector the operator TURNED OFF is 'disabled' upstream and is never
//     started, so it never reaches `report` — it can only ship the build for live
//     human testing, never fail the gate. That is the point of the toggle.
export function smokeGateOk({ http, report = {}, config = DEFAULT_SMOKE_CONFIG }) {
  const invokedFail = (report.browser && report.browser.ok === false && !report.browser.unavailable)
    || (report.db && report.db.ok === false && !report.db.unavailable);
  const unavailableWarranted = (report.browser && report.browser.unavailable)
    || (report.db && report.db.unavailable);
  return !(config.enforceHttp && !(http && http.ok))
    && !invokedFail
    && !(config.requireTriggered && unavailableWarranted);
}

// pickContainerIp — first non-loopback IPv4 in `ip -4 -o addr` / `hostname -I`
// output. The browser connector runs Playwright in the BACKEND process, which
// cannot see the app on its own 127.0.0.1 (the app listens inside the project's
// container — req-76 burned a cycle on exactly that ERR_CONNECTION_REFUSED), so
// the target must be the container's bridge address.
// ---- the HTTP smoke layer's verdict (pure, so it can be tested) ----
//
// smoke.js runs the curl script in the container; this reads its output. It
// lives here rather than there because smoke.js cannot be imported outside a
// real install (it pulls in the native DB chain), and this classification is
// exactly the kind of thing that regresses in silence.
//
// THE SIGN-IN CHECK EARNS ITS PLACE. The layer used to ask for `/` and accept
// anything under 500. On an auth-gated app a 401 at `/` is normal, so that
// question cannot distinguish a working app from one nobody can get into.
// Project 43 deployed with a feature router mounted above the sign-in route:
// every path answered 401, the live URL served a JSON error body, and this
// layer reported ok.
export function httpSmokeChecks(out) {
  const text = String(out || '');
  const grab = (key) => (text.match(new RegExp(`${key}:(\\d+)`)) || [])[1] || '000';
  const shell = grab('SHELL');
  const login = grab('LOGIN');
  const spoofWorst = grab('SPOOF_WORST');

  const shellOk = shell !== '000' && Number(shell) < 500;

  // 404 is fine — not every app has a sign-in page; an ungated tool does not.
  // 401/403 is NOT: it means the sign-in page is itself behind the auth gate,
  // which is unreachable by construction. 5xx or a refused connection is a
  // dead app. A redirect is a normal sign-in flow.
  const loginCode = Number(login);
  const loginOk = login !== '000'
    && (loginCode === 200 || loginCode === 404 || (loginCode >= 300 && loginCode < 400));
  const loginDetail = loginOk
    ? `GET /login → ${login}`
    : `GET /login → ${login} — nobody can sign in. ${
      loginCode === 401 || loginCode === 403
        ? 'The sign-in page is itself behind the auth gate: something mounted above it in src/app.ts is guarding every request (see the signin-reachable gate).'
        : 'The app is not serving it.'}`;

  // If no conventional admin path answered at all we cannot assert the negative
  // case — report not-applicable rather than a false pass.
  const spoofTested = /SPOOF \S+:(2|4)\d\d/.test(text);
  const spoofOk = spoofWorst[0] !== '2';

  const checks = [
    { name: 'shell-serves', ok: shellOk, detail: `GET / → ${shell}` },
    { name: 'sign-in page reachable', ok: loginOk, detail: loginDetail },
    {
      name: 'negative-auth (spoofed x-user-role rejected)',
      ok: spoofOk,
      detail: spoofTested
        ? `worst spoofed-header response: ${spoofWorst}`
        : 'no conventional admin path answered — assertion not applicable',
    },
  ];
  return { ok: checks.every((c) => c.ok), checks };
}

export function pickContainerIp(text) {
  const tokens = String(text || '').split(/\s+/).filter(Boolean);
  return tokens.find((t) => /^(\d{1,3})(\.\d{1,3}){3}$/.test(t)
    && !t.startsWith('127.')
    && t.split('.').every((o) => Number(o) <= 255)) || null;
}

// ---- the honest gate: a user-visible change nothing actually confirmed ----
//
// Origin (measured, project 34 build #113): the build edited public/admin.js,
// deployed cleanly, and reported SUCCESS — but no browser check ever confirmed
// the change, and the operator's browser was serving a stale cached bundle, so
// the fix was invisible. Three builds were spent before the cause was found.
//
// "Succeeded" must mean "we verified it", not "we wrote the file". When a change
// is user-visible and NOTHING observed it in a browser, the honest terminal is
// pending_verification with a human check — not finish. This does not fail or
// block anything: the deploy still happens, the operator just gets told which
// check is still owed. PURE so the rule is unit-testable.

// browserConfirmed(report) — did a browser actually observe this deploy?
// Requires a browser connector that RAN and PASSED. `unavailable` (playwright
// missing) is explicitly not confirmation — that was the silent hole.
export function browserConfirmed(report = {}) {
  const b = report?.browser;
  if (!b) return false;
  if (b.unavailable) return false;
  return b.ok === true;
}

// userVisibleChange(changedFiles, config) — does the diff touch what a person
// looks at? Reuses the browser trigger globs so "user-visible" means exactly the
// same thing here as it does when deciding to run the browser connector.
export function userVisibleChange(changedFiles = [], config = DEFAULT_SMOKE_CONFIG) {
  const globs = config?.browserGlobs || DEFAULT_SMOKE_CONFIG.browserGlobs;
  return (changedFiles || []).some((f) => globs.some((g) => matchGlob(f, g)));
}

// needsOperatorUiVerification({ changedFiles, report, acceptance, config })
//   → { needed, reason, checklist }
//
// checklist entries reuse the existing pending-verification shape so they merge
// straight into the integration checklist the UI already renders.
export function needsOperatorUiVerification({
  changedFiles = [], report = {}, acceptance = [], config = DEFAULT_SMOKE_CONFIG,
} = {}) {
  if (!userVisibleChange(changedFiles, config)) return { needed: false, reason: 'no user-visible files changed', checklist: [] };
  if (browserConfirmed(report)) return { needed: false, reason: 'a browser check confirmed this change', checklist: [] };

  const why = report?.browser?.unavailable
    ? 'the browser check could not run (playwright unavailable)'
    : report?.browser
      ? 'the browser check did not pass'
      : 'no browser check ran for this change';
  // One item per human-runnable acceptance check the build declared; if it
  // declared none, a single generic item still forces a real look.
  const items = (acceptance || []).map((a) => String(a).trim()).filter(Boolean);
  const checklist = (items.length ? items : ['Open the app and confirm this change is visible and works.'])
    .map((text) => ({
      kind: 'ui_verification',
      text,
      why: `${why} — confirm it in a real browser.`,
      // The stale-cache trap that started this: a hard refresh is the first
      // thing to try when a shipped change appears missing.
      hint: 'If it looks unchanged, hard-refresh (or check for the app update prompt) — a cached service worker can serve the previous build.',
    }));
  return { needed: true, reason: why, checklist };
}
