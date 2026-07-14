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
  'expect_text',      // { expect_text: selector, contains: 'substr' }
  'fill',             // { fill: selector, value: '...', expect_value: true } → type, optionally assert it persisted
  'click',            // selector → click (used for e.g. the "Replace" write-only-secret flow)
]);

const MAX_CHECKS = 60;
const MAX_STEPS = 30;
const MAX_STR = 500;

function isShortString(v) { return typeof v === 'string' && v.trim().length > 0 && v.length <= MAX_STR; }

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
  let login = null;
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
    if (chk.role != null) {
      if (!isShortString(chk.role)) return { ok: false, error: `check "${chk.id}" role must be a string` };
      if (!login) return { ok: false, error: `check "${chk.id}" declares role "${chk.role}" but no login block exists` };
      if (!login.users[chk.role]) return { ok: false, error: `check "${chk.id}" role "${chk.role}" has no login.users entry` };
    }
    const steps = Array.isArray(chk.steps) ? chk.steps : null;
    if (!steps || !steps.length) return { ok: false, error: `check "${chk.id}" needs steps` };
    if (steps.length > MAX_STEPS) return { ok: false, error: `check "${chk.id}" has too many steps (max ${MAX_STEPS})` };
    for (let i = 0; i < steps.length; i++) {
      const err = validateStep(steps[i], i);
      if (err) return { ok: false, error: `check "${chk.id}": ${err}` };
    }
    checks.push({
      id: chk.id,
      name: isShortString(chk.name) ? chk.name : chk.id,
      paths: chk.paths,
      role: chk.role || null,
      page: chk.page,
      steps,
    });
  }
  return { ok: true, spec: { login, checks } };
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
