// Mock2 UI interaction checks — PURE decision layer (native-free, unit-tested
// stub-first, risk R9). The change-69 lesson: a UI regression (disabled admin
// credential inputs) shipped through five green gates because nothing exercised
// the rendered DOM. The fix is a per-project DECLARATIVE interaction spec at
// state/ui-checks.json — authored by the build runner as part of UI work,
// enforced two ways:
//   - the ui-interaction GATE (framework-seed/gates.json) fails a cycle whose
//     working-tree diff touches user-facing paths with no matching check
//     (coverage — deterministic, runs in the container);
//   - the browser smoke CONNECTOR (ui-checks.js, orchestrator-side Playwright)
//     EXECUTES the checks matched by the deployed commit's diff against the
//     live app, failing the cycle on any assertion or console error.
//
// This module owns the spec format: parsing/validation, the path-glob matching
// that decides which checks a diff warrants, and result summarization.
//
// Terminology (risk R7): nothing here is named "agent".

import { matchGlob } from './smoke-triggers.js';

// Where the spec lives in a project's working tree (committed, hash-chained
// like all state/ content).
export const UI_CHECKS_PATH = 'state/ui-checks.json';

// The step vocabulary. Each step object carries EXACTLY ONE of these keys
// (plus that key's modifiers). Kept deliberately small: enough to assert the
// per-role state of interactive controls (enabled/disabled), that typed input
// actually persists into the control, and that flows like "Replace → secret
// field enables" work — without becoming a general scripting language.
export const STEP_KINDS = Object.freeze([
  'expect_enabled',   // selector → element is visible and enabled
  'expect_disabled',  // selector → element is visible but disabled
  'expect_visible',   // selector → element is visible
  // The only way to say "this must NOT be offered". Without it the most common
  // real defect in a generated app — a route or control guarded in the UI for
  // one role and not for another — was not expressible at all, so nothing ever
  // checked it. Absent OR hidden both satisfy it: what matters is that the user
  // is not offered the thing, not which mechanism withheld it.
  'expect_absent',    // selector → element is absent, or present but not visible
  'expect_text',      // { expect_text: selector, contains: 'substr' }
  'fill',             // { fill: selector, value: '...', expect_value: true } → type, optionally assert it persisted
  'click',            // selector → click (used for e.g. the "Replace" write-only-secret flow)
]);

// The base app's sign-in form, which the PLATFORM ships and therefore knows.
// Used when a spec supplies a user roster without spelling the form out.
export const DEFAULT_LOGIN_FORM = Object.freeze({
  path: '/login',
  user_field: 'input[type="email"], input[name="email"], input[name="username"]',
  pass_field: 'input[type="password"]',
  submit: 'button[type="submit"], input[type="submit"]',
});

const MAX_CHECKS = 60;
const MAX_STEPS = 30;
const MAX_STR = 500;

function isShortString(v) { return typeof v === 'string' && v.trim().length > 0 && v.length <= MAX_STR; }

// normalizeStep — accept BOTH spellings of a step.
//
// The canonical form keys the step on the assertion:
//     { expect_visible: '#nav-new' }
//     { fill: '#title', value: 'Groceries' }
//     { expect_text: 'h1', contains: 'Notes' }
//
// Models overwhelmingly reach for the conventional form instead:
//     { action: 'expect_visible', selector: '#nav-new' }
//     { action: 'fill', selector: '#title', text: 'Groceries' }
//     { action: 'expect_value', selector: '#title', text: 'Groceries' }
//
// Project 38 wrote the second form for every step of every check, and the
// build FAILED after a successful deploy over it — the app was live and
// working, and the cycle went red because a test file used the other spelling.
// Both forms express exactly the same thing, so the parser accepts both and
// normalizes to the canonical one. `expect_value` is folded onto the preceding
// fill, which is where the canonical form carries it (fill's `expect_value`
// flag) — the ui-interaction gate's own advice says "fill + expect_value", so
// rejecting it was the harness contradicting itself.
//
// Returns { step } (normalized, canonical) or { fold: 'expect_value', ... } for
// a step that merges into the previous one, or { error }.
export function normalizeStep(raw, i) {
  if (!raw || typeof raw !== 'object') return { error: `step ${i + 1} must be an object` };

  // Already canonical?
  const present = STEP_KINDS.filter((k) => raw[k] !== undefined);
  if (present.length === 1) return { step: raw };
  if (present.length > 1) {
    return { error: `step ${i + 1} has more than one of: ${STEP_KINDS.join(', ')} — one assertion per step` };
  }

  // Conventional { action, selector, ... }.
  const action = typeof raw.action === 'string' ? raw.action.trim() : null;
  const selector = isShortString(raw.selector) ? raw.selector : null;
  if (!action) {
    return { error: `step ${i + 1} must have exactly one of: ${STEP_KINDS.join(', ')} (or {"action": …, "selector": …})` };
  }
  if (!selector) return { error: `step ${i + 1} ("${action}") needs a selector string` };

  // expect_value asserts the PREVIOUS fill persisted. In the canonical form
  // that is fill's own flag, so it folds rather than becoming a step.
  if (action === 'expect_value') return { fold: 'expect_value', selector, value: raw.text ?? raw.value };

  if (!STEP_KINDS.includes(action)) {
    return { error: `step ${i + 1}: unknown action "${action}" — one of: ${STEP_KINDS.join(', ')}, expect_value` };
  }
  const out = { [action]: selector };
  // `text` is what a model writes; `value`/`contains` are the canonical names.
  if (action === 'fill') out.value = raw.value ?? raw.text;
  if (action === 'expect_text') out.contains = raw.contains ?? raw.text;
  return { step: out };
}

function validateStep(step, i) {
  if (!step || typeof step !== 'object') return `step ${i + 1} must be an object`;
  const kinds = STEP_KINDS.filter((k) => step[k] !== undefined);
  if (kinds.length !== 1) return `step ${i + 1} must have exactly one of: ${STEP_KINDS.join(', ')}`;
  const kind = kinds[0];
  if (!isShortString(step[kind])) return `step ${i + 1} (${kind}) needs a selector string`;
  if (kind === 'fill' && !isShortString(step.value)) return `step ${i + 1} (fill) needs a value string`;
  if (kind === 'expect_text' && !isShortString(step.contains)) return `step ${i + 1} (expect_text) needs a contains string`;
  return null;
}

// Normalize a whole step list, folding expect_value onto its fill.
function normalizeSteps(rawSteps) {
  const out = [];
  for (let i = 0; i < rawSteps.length; i++) {
    const r = normalizeStep(rawSteps[i], i);
    if (r.error) return { error: r.error };
    if (r.fold === 'expect_value') {
      const prev = out[out.length - 1];
      if (!prev || prev.fill === undefined) {
        return { error: `step ${i + 1} (expect_value) must follow a fill of the same control` };
      }
      // Only meaningful for the control that was just filled.
      if (prev.fill !== r.selector) {
        return { error: `step ${i + 1} (expect_value) targets "${r.selector}" but the previous fill targeted "${prev.fill}"` };
      }
      prev.expect_value = true;
      continue;
    }
    const err = validateStep(r.step, out.length);
    if (err) return { error: err };
    out.push(r.step);
  }
  if (!out.length) return { error: 'needs at least one assertion step' };
  return { steps: out };
}

// parseUiChecks — parse + validate a state/ui-checks.json document. Returns
// { ok:false, error } on ANY problem (a malformed spec must fail the gate
// loudly, never be half-honored) or { ok:true, spec } with the normalized spec.
export function parseUiChecks(text) {
  let doc;
  try { doc = JSON.parse(String(text || '')); } catch (err) {
    return { ok: false, error: `ui-checks.json is not valid JSON: ${err?.message || err}` };
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { ok: false, error: 'ui-checks.json must be a JSON object' };

  // login block (optional overall, required when any check declares a role).
  //
  // TWO ACCEPTED SHAPES, for the same reason as the steps above. The canonical
  // one spells out the sign-in form:
  //     "login": { "path": "/login", "user_field": "#email", "pass_field": "#password",
  //                "submit": "button[type=submit]",
  //                "users": { "admin": { "username": "…", "password": "…" } } }
  // Models write the roster and assume the platform knows its own sign-in page:
  //     "users": [ { "role": "admin", "email": "…", "password": "…" } ]
  // The second is a fair assumption — the base app's sign-in page IS shipped by
  // the platform and its fields are standard — so the selectors are filled in
  // rather than demanded. Project 38 wrote the roster form and the parse failed.
  let login = null;
  if (doc.login == null && Array.isArray(doc.users) && doc.users.length) {
    const users = {};
    for (const u of doc.users) {
      const role = isShortString(u?.role) ? u.role : null;
      const name = isShortString(u?.username) ? u.username : (isShortString(u?.email) ? u.email : null);
      if (!role || !name || !isShortString(u?.password)) {
        return { ok: false, error: 'users[] entries need role + email/username + password (seeded test-fixture users)' };
      }
      users[role] = { username: name, password: u.password };
    }
    login = { ...DEFAULT_LOGIN_FORM, users };
  }
  if (doc.login != null) {
    const l = doc.login;
    if (!l || typeof l !== 'object') return { ok: false, error: 'login must be an object' };
    for (const f of ['path', 'user_field', 'pass_field', 'submit']) {
      if (!isShortString(l[f])) return { ok: false, error: `login.${f} is required (string)` };
    }
    const users = l.users && typeof l.users === 'object' && !Array.isArray(l.users) ? l.users : null;
    if (!users || !Object.keys(users).length) return { ok: false, error: 'login.users must map role → {username, password}' };
    for (const [role, u] of Object.entries(users)) {
      if (!u || !isShortString(u.username) || !isShortString(u.password)) {
        return { ok: false, error: `login.users.${role} needs username + password (seeded test-fixture users)` };
      }
    }
    login = { path: l.path, user_field: l.user_field, pass_field: l.pass_field, submit: l.submit, users };
  }

  const checksIn = Array.isArray(doc.checks) ? doc.checks : null;
  if (!checksIn) return { ok: false, error: 'checks must be an array' };
  if (checksIn.length > MAX_CHECKS) return { ok: false, error: `too many checks (max ${MAX_CHECKS})` };

  const checks = [];
  const seenIds = new Set();
  for (let c = 0; c < checksIn.length; c++) {
    const chk = checksIn[c];
    if (!chk || typeof chk !== 'object') return { ok: false, error: `check ${c + 1} must be an object` };
    if (!isShortString(chk.id)) return { ok: false, error: `check ${c + 1} needs an id` };
    if (seenIds.has(chk.id)) return { ok: false, error: `duplicate check id "${chk.id}"` };
    seenIds.add(chk.id);
    if (!Array.isArray(chk.paths) || !chk.paths.length || !chk.paths.every(isShortString)) {
      return { ok: false, error: `check "${chk.id}" needs paths (the diff globs that trigger it)` };
    }
    if (!isShortString(chk.page)) return { ok: false, error: `check "${chk.id}" needs a page path` };
    // A check names its actor as `role`. Models often name the USER instead
    // ("login": "ui-admin@fixture.invalid"), which identifies the same actor —
    // resolve it back to the role rather than rejecting the spec.
    let role = chk.role ?? null;
    if (role == null && isShortString(chk.login) && login) {
      const match = Object.entries(login.users).find(([, u]) => u.username === chk.login);
      if (!match) {
        return { ok: false, error: `check "${chk.id}" logs in as "${chk.login}", which is not one of the declared users` };
      }
      [role] = match;
    }
    if (role != null) {
      if (!isShortString(role)) return { ok: false, error: `check "${chk.id}" role must be a string` };
      if (!login) return { ok: false, error: `check "${chk.id}" declares role "${role}" but no login block exists` };
      if (!login.users[role]) return { ok: false, error: `check "${chk.id}" role "${role}" has no login.users entry` };
    }
    const rawSteps = Array.isArray(chk.steps) ? chk.steps : null;
    if (!rawSteps || !rawSteps.length) return { ok: false, error: `check "${chk.id}" needs steps` };
    if (rawSteps.length > MAX_STEPS) return { ok: false, error: `check "${chk.id}" has too many steps (max ${MAX_STEPS})` };
    const norm = normalizeSteps(rawSteps);
    if (norm.error) return { ok: false, error: `check "${chk.id}": ${norm.error}` };
    checks.push({
      id: chk.id,
      name: isShortString(chk.name) ? chk.name : chk.id,
      paths: chk.paths,
      role: role || null,
      page: chk.page,
      steps: norm.steps,
    });
  }
  return { ok: true, spec: { login, checks } };
}

// withPlatformLogin — sign the checks in when the spec did not say how.
//
// Project 40's smoke run reported `ui-check notes-list-loads [anonymous /]:
// FAIL — expect_visible #search: Timeout`, three times over. The spec declared
// no login block at all, so every check ran signed OUT, was bounced to the
// sign-in page by the auth gate, and timed out looking for elements that only
// exist behind it. Three green-looking checks that could never have passed, and
// a red build on top.
//
// The platform keeps a working fixture account for exactly this (review-
// account.js). When the spec is silent about signing in, use it: a check
// written against `/` on an auth-gated app plainly means "as a signed-in user".
//
// DELIBERATELY NOT when the spec HAS a login block: a check with no role there
// is an explicit choice to test the signed-out state, and overriding it would
// silently change what the build asked for.
export function withPlatformLogin(spec, reviewLogin) {
  if (!spec || spec.login || !reviewLogin?.email || !reviewLogin?.password) return spec;
  const role = 'platform';
  return {
    ...spec,
    // `via: 'api'` — this block is the PLATFORM's account, not a fixture the
    // build declared, so signing it in is plumbing rather than something under
    // test. Going through /api/auth/login skips the sign-in page entirely,
    // which matters because that page shows one of three forms depending on
    // bootstrap state and a restyled build can move every control on it.
    login: { ...DEFAULT_LOGIN_FORM, via: 'api', users: { [role]: { username: reviewLogin.email, password: reviewLogin.password } } },
    checks: (spec.checks || []).map((c) => (c.role ? c : { ...c, role })),
  };
}

/* -------------------- the PLATFORM's own baseline checks -------------------- */
//
// state/ui-checks.json is written by the build MODEL, and two builds in a row
// shipped one that passed the coverage gate and then failed the strict parser
// after deploy — so on those cycles NOTHING exercised the rendered app. A spec
// the platform derives itself has no such failure mode: it is built from what
// the platform SHIPS and therefore knows is there.
//
// These are appended to whatever the model wrote, never written to the file, so
// they cannot be edited away and do not satisfy the model's coverage gate. They
// assert only base-app guarantees — every one of them has been a real defect:
//
//   - the shell renders at all, signed in (project 40: every check ran
//     anonymous, was bounced to /login, and timed out)
//   - the theme control and the legal footer are actually mounted on a screen
//     (learnings 44/48: both modules loaded, neither rendered anything)
//   - a VIEWER is not offered the admin route, and cannot reach the admin page
//     by typing the URL — "guarded in the UI, not on the server" is the most
//     common real defect in a generated app, and until there was a second
//     fixture there was no way to ask
//
// Console errors fail every check automatically (runUiChecks), which is most of
// the value on the plain page loads.
export const BASELINE_CHECK_PREFIX = 'platform-baseline-';

export function buildBaselineChecks({ reviewerRole = null, viewerRole = null } = {}) {
  const checks = [];
  const id = (name) => `${BASELINE_CHECK_PREFIX}${name}`;
  // paths ['**/*'] so these run on EVERY cycle: a baseline that only fires when
  // a particular file changed is a baseline that is usually not checked.
  const base = { paths: ['**/*'] };

  if (reviewerRole) {
    checks.push({
      ...base,
      id: id('app-shell'),
      name: 'The signed-in app shell renders, with its theme control and legal footer',
      role: reviewerRole,
      page: '/',
      steps: [
        { expect_visible: 'header' },
        { expect_visible: '.theme-toggle' },
        { expect_visible: '[data-legal-footer]' },
      ],
    });
    checks.push({
      ...base,
      id: id('admin-reachable'),
      name: 'An administrator can reach the admin screens',
      role: reviewerRole,
      page: '/admin',
      steps: [{ expect_visible: 'header' }, { expect_visible: '#add-role' }],
    });
  }

  if (viewerRole) {
    checks.push({
      ...base,
      id: id('viewer-not-offered-admin'),
      name: 'A viewer is not offered the admin route',
      role: viewerRole,
      page: '/',
      steps: [{ expect_visible: 'header' }, { expect_absent: '#admin-link' }],
    });
    checks.push({
      ...base,
      id: id('viewer-denied-admin'),
      name: 'A viewer typing the admin URL does not get the admin screens',
      role: viewerRole,
      page: '/admin',
      // The UI hiding the link is not the guard. This types the URL, which is
      // what an actual attacker does, and fails if the page renders its
      // controls anyway — the exact shape of "guarded in the UI, not on the
      // server".
      steps: [{ expect_absent: '#add-role' }],
    });
  }
  return checks;
}

// withBaselineChecks — add the platform's checks to a spec, and make sure the
// spec can sign in as each role they need.
//
// Never overrides a model-written check of the same id (the model's own spec
// wins on its own ground), and never runs a role the platform could not
// actually provision: no viewer fixture, no viewer checks. A check that cannot
// sign in would fail for a reason that has nothing to do with the app.
export function withBaselineChecks(spec, { reviewLogin = null, viewerLogin = null } = {}) {
  if (!spec || !reviewLogin?.email || !reviewLogin?.password) return spec;
  const reviewerRole = 'platform';
  const viewerRole = viewerLogin?.email && viewerLogin?.password ? 'platform_viewer' : null;

  const users = { ...(spec.login?.users || {}), [reviewerRole]: { username: reviewLogin.email, password: reviewLogin.password } };
  if (viewerRole) users[viewerRole] = { username: viewerLogin.email, password: viewerLogin.password };

  const existing = new Set((spec.checks || []).map((c) => c.id));
  const added = buildBaselineChecks({ reviewerRole, viewerRole }).filter((c) => !existing.has(c.id));
  if (!added.length) return spec;

  return {
    ...spec,
    // `via: 'api'` — these sign in as PLATFORM accounts, which is plumbing
    // rather than something under test (see withPlatformLogin).
    login: { ...DEFAULT_LOGIN_FORM, ...(spec.login || {}), via: 'api', users },
    checks: [...(spec.checks || []), ...added],
  };
}

// Is this one of the platform's own checks? Used to report them separately —
// a baseline failure is a statement about the BASE APP, not about the change
// the operator just asked for, and reading it as the latter wastes their time.
export function isBaselineCheck(check) {
  return String(check?.id || '').startsWith(BASELINE_CHECK_PREFIX);
}

// The checks a diff warrants: every check whose path globs match ANY changed
// file. This is what both enforcement points share — the coverage gate asks
// "does at least one check match?", the connector asks "which checks run?".
export function checksForChangedFiles(spec, changedFiles = []) {
  const files = Array.isArray(changedFiles) ? changedFiles.filter(Boolean) : [];
  const out = [];
  for (const chk of spec?.checks || []) {
    if (files.some((f) => chk.paths.some((g) => matchGlob(f, g)))) out.push(chk);
  }
  return out;
}

// Normalize a step to { kind, selector, ...modifiers } for the executor.
export function stepShape(step) {
  const kind = STEP_KINDS.find((k) => step[k] !== undefined);
  return {
    kind,
    selector: step[kind],
    ...(kind === 'fill' ? { value: step.value, expectValue: step.expect_value !== false } : {}),
    ...(kind === 'expect_text' ? { contains: step.contains } : {}),
  };
}

// One line per check for the cycle log ("no silent skips" discipline).
export function uiCheckLogLines(results = []) {
  return results.map((r) => {
    const bad = (r.steps || []).filter((s) => !s.ok);
    const consoleBad = (r.consoleErrors || []).length;
    const why = r.ok ? 'ok'
      : bad.length ? bad.map((s) => s.detail).join('; ')
        : consoleBad ? `${consoleBad} console error(s)`
          : r.detail || 'failed';
    return `ui-check ${r.id} [${r.role || 'anonymous'} ${r.page}]: ${r.ok ? 'PASS' : 'FAIL'} — ${why}`;
  });
}

// A short failure summary for the cycle error line.
export function uiCheckFailSummary(results = []) {
  const bad = results.filter((r) => !r.ok);
  if (!bad.length) return '';
  return bad.map((r) => {
    const step = (r.steps || []).find((s) => !s.ok);
    const consoleBad = (r.consoleErrors || []).length;
    return `${r.id}: ${step ? step.detail : consoleBad ? `${consoleBad} console error(s)` : r.detail || 'failed'}`;
  }).join(' · ');
}
