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
  // Connectors are OFF by default: registered + wired, but never started unless the
  // operator enables them AND a trigger fires. A disabled-but-triggered connector is
  // reported as "unavailable" (visible), never a silent pass.
  browserEnabled: false,
  dbEnabled: false,
  // If true, a triggered-but-disabled/unavailable connector FAILS the smoke gate
  // (constitution "fail-visibly when dependencies are missing"). Default false
  // because the connectors are opt-in infra — the miss is logged loudly regardless.
  requireTriggered: false,
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
//   'ran'         — fired AND enabled: the connector is invoked.
//   'skipped'     — did not fire: intentionally bypassed (with its reason).
//   'unavailable' — fired but the connector is disabled/not configured: a VISIBLE
//                   non-pass (never a silent skip), so "covered everything" is never
//                   implied when a warranted layer was bypassed for lack of infra.
export function resolveConnectorRun(connDecision, enabled) {
  if (!connDecision.fire) return { disposition: 'skipped', reason: connDecision.reason, escalated: false };
  if (!enabled) return { disposition: 'unavailable', reason: `${connDecision.reason} — but connector is disabled (enable it to run)`, escalated: !!connDecision.escalated };
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
