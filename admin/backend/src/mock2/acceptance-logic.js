// Mock2 acceptance discipline — PURE decision layer (native-free, unit-tested
// stub-first, risk R9). Designed against the cycle-94 failure: a bug-fix cycle
// "succeeded" with all gates green while the reported defect (ADP mTLS false
// rejection) was never reproduced, the only committed change was rewording
// string literals to dodge the secret-scan regex, and the change record claimed
// prior cycles' work. Root cause: "done" was defined as a PROXY (Tier-1 gates)
// for the goal (the acceptance criterion) — so the proxy got optimized
// (Goodhart). This module owns the decisions that close that gap:
//
//   - every cycle declares a machine-checkable acceptance spec
//     (state/acceptance.json) — task, kind, defect tag, regression tests,
//     integration contract, live ui checks;
//   - a BUG-FIX cycle must demonstrate red→green INSIDE the cycle: the test
//     gate must have been observed FAILING at least once before the finish
//     battery goes green ("the code looks correct" is not acceptance);
//   - the change-record summary must correspond to THIS cycle's diff
//     (over-claiming is rejected);
//   - a suspiciously cheap "fix" (tiny spend, no repro, no test touched)
//     trips an anomaly flag for human review.
//
// runner.js / runner-sdk.js / smoke.js import these; tests import ONLY this.
//
// Terminology (risk R7): nothing here is named "agent".

// Where a cycle's acceptance spec lives in the working tree (committed and
// hash-chained like all state/ content; the runner writes it FIRST).
export const ACCEPTANCE_PATH = 'state/acceptance.json';

export const TASK_KINDS = Object.freeze(['bugfix', 'feature', 'chore']);

// Classify the task from its instruction. Deliberately eager on 'bugfix': a
// missed bug-fix classification silently skips reproduce-first, while an
// over-eager one merely asks a feature cycle for a red test it can also
// satisfy with a new failing spec test.
export function classifyTaskKind(instruction) {
  const s = String(instruction || '').toLowerCase();
  if (/\b(fix|bug|defect|broken|breaks|fails?|failing|failure|regression|error|crash|does\s*n[o']t\s+work|not\s+work(ing)?|can\s*n[o']t\b|cannot\b|wrong(ly)?|incorrect)\b/.test(s)) return 'bugfix';
  return 'feature';
}

// parseAcceptance — parse + validate state/acceptance.json. Malformed specs
// FAIL loudly ({ok:false}); a valid spec normalizes to
// { task, kind, defect_tag, tests[], integration{paths[],contract_test}|null, ui[] }.
export function parseAcceptance(text) {
  let doc;
  try { doc = JSON.parse(String(text || '')); } catch (err) {
    return { ok: false, error: `acceptance.json is not valid JSON: ${err?.message || err}` };
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { ok: false, error: 'acceptance.json must be a JSON object' };
  const task = String(doc.task || '').trim();
  if (!task) return { ok: false, error: 'acceptance.task is required (what this cycle must demonstrably achieve)' };
  const kind = String(doc.kind || '').trim().toLowerCase();
  if (!TASK_KINDS.includes(kind)) return { ok: false, error: `acceptance.kind must be one of ${TASK_KINDS.join(', ')}` };
  const defectTag = doc.defect_tag != null ? String(doc.defect_tag).trim() : '';
  if (kind === 'bugfix') {
    if (!/^[a-z0-9][a-z0-9-]{2,80}$/.test(defectTag)) {
      return { ok: false, error: 'a bugfix needs a defect_tag slug (e.g. "defect-adp-mtls-mismatch") that the regression test carries' };
    }
  }
  const tests = Array.isArray(doc.tests) ? doc.tests.map((t) => String(t || '').trim()).filter(Boolean) : [];
  if (kind === 'bugfix' && !tests.length) {
    return { ok: false, error: 'a bugfix must name at least one regression test file in acceptance.tests' };
  }
  let integration = null;
  if (doc.integration != null) {
    const i = doc.integration;
    if (!i || typeof i !== 'object') return { ok: false, error: 'acceptance.integration must be an object' };
    const contract = String(i.contract_test || '').trim();
    if (!contract) return { ok: false, error: 'acceptance.integration.contract_test is required when integration is declared' };
    integration = {
      paths: Array.isArray(i.paths) ? i.paths.map((p) => String(p || '').trim()).filter(Boolean) : [],
      contract_test: contract,
    };
  }
  const ui = Array.isArray(doc.ui) ? doc.ui.map((u) => String(u || '').trim()).filter(Boolean) : [];
  return { ok: true, spec: { task, kind, defect_tag: defectTag || null, tests, integration, ui } };
}

// Did any observed gate battery show the TEST gate red? This is the
// reproduce-first signal: a bug-fix cycle that never produced a failing test
// run never reproduced the defect. Accepts either a battery list or a list of
// batteries.
export function batteryHasRedTestGate(battery = []) {
  return (Array.isArray(battery) ? battery : []).some((g) => g && g.name === 'test' && g.status === 'failed');
}

// ---- the verified empty-diff rule ----

// Paths under state/ are the harness's own spec/record files (acceptance.json,
// rules.md, ui-checks.json, integrations.json, change mirrors) — aligning them is
// bookkeeping, not a product change, and the test gate does not exercise them.
export const STATE_PATH_RE = /^state\//;

// The PRODUCT-CODE slice of a cycle's diff: everything the cycle changed except
// the state/ bookkeeping. This is what reproduce-first is really about — a cycle
// that changed no product code has no behavior change to reproduce a defect
// against, and fabricating a red test would REQUIRE a product change (a
// contradiction the old rule forced). The caller must pass the ORCHESTRATOR'S
// OWN diff reading (git in the container), never a model claim (§12: verify,
// don't trust).
export function codeChangedFiles(changedFiles = []) {
  return (Array.isArray(changedFiles) ? changedFiles : [])
    .map((f) => String(f || '').replace(/^\.\//, '').trim())
    .filter(Boolean)
    .filter((f) => !STATE_PATH_RE.test(f));
}

// acceptanceVerdict — the finish-time decision (orchestrator side). Given the
// parsed spec (or its parse failure), the task classification, whether a red
// test gate was observed this cycle, the ORCHESTRATOR-VERIFIED list of files
// this cycle changed, and any enforced operator waiver, decide whether finish
// may proceed. Returns { ok, reasons: [], reproduce_first } — every reason is
// actionable feedback fed back to the finish tool call; reproduce_first records
// the basis on which the requirement was satisfied or set aside, so the record
// is honest about WHY (§12 — a waiver that isn't in effect is never implied).
//
// The verified empty-diff rule (first-class, not a per-cycle manual waiver):
// reproduce-first exists to stop "the code looks correct" from passing as a
// fix. A cycle whose verified diff contains NO product-code change (an
// idempotent re-adoption, a spec/state alignment, a nothing-left-to-do re-run)
// has no behavior change to demonstrate red→green against — and fabricating a
// red test would itself require a product change. When changedFiles is the
// orchestrator's own diff reading and its code slice is empty, reproduce-first
// does not apply and the spec's own kind (e.g. chore) stands. changedFiles null
// = unknown (caller didn't verify) → the strict rule applies unchanged.
export function acceptanceVerdict({
  parsed, instructionKind = 'feature', redTestObserved = false,
  changedFiles = null, reproduceFirstWaiver = null,
} = {}) {
  const reasons = [];
  const codeChanged = changedFiles == null ? null : codeChangedFiles(changedFiles);
  const diffEmpty = codeChanged != null && codeChanged.length === 0;
  if (!parsed || parsed.ok === false) {
    reasons.push(`state/acceptance.json is missing or invalid (${parsed?.error || 'not found'}) — write it FIRST: {task, kind, defect_tag?, tests[], integration?, ui[]}.`);
    if (instructionKind === 'bugfix' && !diffEmpty) {
      reasons.push('This task is a BUG FIX: declare kind "bugfix" with a defect_tag and a regression test, and demonstrate red→green inside this cycle.');
    }
    return { ok: false, reasons, reproduce_first: 'not_evaluated' };
  }
  const spec = parsed.spec;
  // A verified-empty code diff: nothing to reproduce, the spec's kind stands.
  if (diffEmpty) {
    return { ok: true, reasons: [], reproduce_first: 'not_required_empty_diff' };
  }
  // The instruction says bug-fix but the spec claims otherwise — the spec must
  // not be used to opt out of reproduce-first.
  const kind = instructionKind === 'bugfix' ? 'bugfix' : spec.kind;
  if (kind === 'bugfix' && spec.kind !== 'bugfix') {
    reasons.push('The task instruction describes a defect, but acceptance.kind is not "bugfix" — reclassify it and add a defect_tag + regression test.');
  }
  let reproduceFirst = kind === 'bugfix' ? (redTestObserved ? 'demonstrated' : 'not_demonstrated') : 'not_applicable';
  if (kind === 'bugfix' && !redTestObserved) {
    // An ENFORCED operator waiver (admin-granted on resume, applied HERE — the
    // real enforcement layer — and stamped into the record). Never inferred
    // from narration: the caller passes it only when the structured waiver was
    // actually granted.
    if (reproduceFirstWaiver && reproduceFirstWaiver.rule === 'reproduce_first') {
      reproduceFirst = 'waived_by_operator';
    } else {
      reasons.push('Reproduce-first not demonstrated: no gate battery in THIS cycle showed the test gate RED. Write the regression test so it FAILS against the current (broken) behavior, run run_gates to record the red, then fix and go green. "The code looks correct / appears already implemented" is not acceptance.');
    }
  }
  return { ok: reasons.length === 0, reasons, reproduce_first: reproduceFirst };
}

// ---- change-record accountability (over-claim rejection) ----

// Extract path-like claims from a summary: tokens that look like repo paths or
// filenames ("src/adp/tls.ts", "public/app.js", "connection.repro.test.ts").
export function extractSummaryPathClaims(summary) {
  const s = String(summary || '');
  const out = new Set();
  const re = /(?:^|[\s`'"(])((?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+|[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\.(?:ts|tsx|js|jsx|mjs|cjs|sql|html|css|scss|json|ya?ml|md))(?=$|[\s`'"),.:;!?])/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const tok = m[1].replace(/^\.\//, '');
    // Skip bare version-ish tokens and URLs.
    if (/^\d+(\.\d+)*$/.test(tok) || /:\/\//.test(tok)) continue;
    out.add(tok);
  }
  return [...out];
}

// summaryOverclaims — does the summary name files this cycle did NOT touch?
// A named file counts as covered when it matches a changed path exactly, by
// basename, or as a suffix (summaries often shorten "src/adp/tls.ts" to
// "adp/tls.ts"). Returns { ok, unmatched: [] }.
export function summaryOverclaims(summary, changedFiles = []) {
  const changed = (Array.isArray(changedFiles) ? changedFiles : []).map((f) => String(f || '').replace(/^\.\//, ''));
  const basenames = new Set(changed.map((f) => f.split('/').pop()));
  const unmatched = [];
  for (const claim of extractSummaryPathClaims(summary)) {
    const c = claim.replace(/^\.\//, '');
    const covered = changed.some((f) => f === c || f.endsWith(`/${c}`))
      || (!c.includes('/') && basenames.has(c))
      || changed.some((f) => c.endsWith(`/${f}`));
    if (!covered) unmatched.push(claim);
  }
  return { ok: unmatched.length === 0, unmatched };
}

// ---- anomaly tripwire (heuristic — flags for human review, never blocks) ----

export const ANOMALY_TOKEN_FRACTION = 0.15;

const TEST_FILE_RE = /(^|\/)(tests?|__tests__)\/|\.(test|spec|repro)\.[a-z]+$/i;

// anomalySignals — a cheap post-success heuristic: a bug-fix cycle that closed
// at a small fraction of its estimate, demonstrated no red test, and touched no
// test file is low effort against a live defect — a Goodhart signature worth a
// human look. Returns { flag, reasons: [] }.
export function anomalySignals({
  kind = 'feature', usedTokens = 0, estTokens = 0, changedFiles = [], redTestObserved = false,
} = {}) {
  if (kind !== 'bugfix') return { flag: false, reasons: [] };
  const reasons = [];
  const files = Array.isArray(changedFiles) ? changedFiles.filter(Boolean) : [];
  const touchedTest = files.some((f) => TEST_FILE_RE.test(String(f)));
  const cheap = Number(estTokens) > 0 && Number(usedTokens) < Number(estTokens) * ANOMALY_TOKEN_FRACTION;
  if (cheap) reasons.push(`closed at ${Math.round((usedTokens / estTokens) * 100)}% of its token estimate`);
  if (!redTestObserved) reasons.push('no failing (red) test was observed this cycle — the defect may never have been reproduced');
  if (!touchedTest) reasons.push('no test file was added or changed');
  // Flag when the cycle is cheap AND unproven, or completely test-free.
  const flag = (cheap && !redTestObserved) || (!touchedTest && !redTestObserved);
  return { flag, reasons: flag ? reasons : [] };
}

// The machine-readable acceptance state stamped on the cycle (migration 517)
// and echoed into the record — "gates green" and "acceptance demonstrated" are
// DISTINGUISHABLE states. changedFiles (orchestrator-verified) adds the
// no-op/empty-diff facts; reproduceFirst is the verdict's recorded basis
// ('demonstrated' | 'not_required_empty_diff' | 'waived_by_operator' |
// 'not_applicable' | 'not_demonstrated') so the record never implies a red test
// that wasn't observed, or hides a waiver that was.
export function acceptanceRecord({
  spec = null, instructionKind = 'feature', redTestObserved = false, uiRequired = [],
  changedFiles = null, reproduceFirst = null,
} = {}) {
  const codeChanged = changedFiles == null ? null : codeChangedFiles(changedFiles);
  const diffEmpty = codeChanged != null && codeChanged.length === 0;
  // A verified-empty diff keeps the spec's own kind (the empty-diff rule); with
  // code changes the eager instruction classification still wins.
  const kind = diffEmpty
    ? (spec?.kind || 'chore')
    : (instructionKind === 'bugfix' ? 'bugfix' : (spec?.kind || instructionKind));
  const basis = reproduceFirst
    || (kind !== 'bugfix' ? 'not_applicable' : (redTestObserved ? 'demonstrated' : 'not_demonstrated'));
  return {
    kind,
    defect_tag: spec?.defect_tag || null,
    red_test_observed: !!redTestObserved,
    tests: spec?.tests || [],
    ui_required: uiRequired,
    // A verified no-op (no product-code change) — the loop-termination signal
    // the orchestrator counts (cycle-logic.consecutiveNoopCycles).
    code_diff_empty: diffEmpty,
    no_op: diffEmpty,
    reproduce_first: basis,
    demonstrated: kind === 'bugfix'
      ? (!!redTestObserved || basis === 'not_required_empty_diff' || basis === 'waived_by_operator')
      : true,
  };
}
