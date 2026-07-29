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
// over-eager one merely asks a feature cycle for a red test.
//
// "MERELY" WAS WRONG, and it cost a whole build. The anomaly tripwire fires on
// a bugfix that shows no red test and HOLDS the deploy — so an over-eager
// classification does not just ask for a test, it stops the app from shipping.
//
// And the over-eager case was ProxyPilot's own doing: INITIAL_BUILD_INSTRUCTION
// contains "Any inventory feature you CANNOT finish this cycle must be visibly
// marked…", `cannot` matched, and the platform classified its own first build
// as a bug fix. The build succeeded, the gates went green, the deploy was held,
// the app never served, the design review screenshotted ERR_CONNECTION_REFUSED,
// and the operator had to press Deploy by hand.
//
// Two changes. The bug words must appear in an ASK, not anywhere in a long
// canned brief: the negative forms now need a following verb-ish word ("cannot
// save", "doesn't work") rather than matching a bare "cannot". And an
// instruction that ANNOUNCES itself as a build of the whole app is a feature by
// construction, whatever prose follows.

// A canned, platform-authored instruction. These describe building or
// verifying an app, never fixing a reported defect. Includes the two shapes
// behind the P48 tripwire storm (7 of 9 deploys held): the design review's
// own "Fix these N design-review findings…" brief and the annotate lanes'
// "Annotated …" pin composition — both are DESIGN work (layout, labels,
// spacing) where a cheap close with no red test is normal, not suspicious;
// classifying them bugfix armed the no-red-test hold on every one.
const PLATFORM_FEATURE_INSTRUCTION_RE =
  /^(initial build|build the working application|production check|design polish pass|screen build|feature build|fix these \d+ design-review findings|annotated\b)/i;

// The unambiguous defect vocabulary — a single word is enough.
const DEFECT_WORDS_RE =
  /\b(bug|defect|broken|breaks|regression|crash(es|ed|ing)?|traceback|stack\s*trace)\b/i;
// Verbs that only read as a defect when they are about something specific:
// "fix the header", "the save button fails". A bare "failure mode" in a brief
// is not a bug report.
const DEFECT_PHRASE_RE = new RegExp(
  [
    // "Fix …" as the OPENING of an instruction is a defect report whatever
    // follows ("Fix three issues in the ADP screen"). Mid-sentence it needs an
    // object, so a brief saying "fix only what a gate flags" does not match.
    String.raw`^\s*fix(es|ed|ing)?\b`,
    String.raw`\bfix(es|ed|ing)?\s+(the|a|an|this|that|our|its|it)\b`,
    // "…connection fails ("private key does not match…")" — a bare `fails`
    // followed by punctuation is a report, not prose.
    String.raw`\bfails?\s*[("'“]`,
    String.raw`\bfails?\s+(to|when|with|on|if)\b`,
    String.raw`\b(failing|failed)\s+\w+`,
    String.raw`\bdoes\s*n[o']?t\s+(work|save|load|open|render|show|appear|update|submit|match|connect|respond|display)\b`,
    // The contraction needs its own alternative: `can\s*n[o']t` cannot match
    // "can't" (the n is already consumed by "can"), which is why the ORIGINAL
    // pattern only ever caught the "cannot" spelling.
    String.raw`\b(can\s*not|can['’]t|cannot)\s+(be\s+)?(save|load|open|log|sign|see|reach|delete|edit|submit|create|find|add|access|view|get|start|run)\w*\b`,
    String.raw`\b(is|are|was|were)\s+(wrong|incorrect|broken)\b`,
    String.raw`\bthrows?\s+(an?\s+)?error\b`,
    String.raw`\berror\s+(when|on|after|while)\b`,
  ].join('|'),
  'i',
);

export function classifyTaskKind(instruction) {
  const s = String(instruction || '').trim();
  if (!s) return 'feature';
  // The platform's own briefs are never bug reports, however they are worded.
  if (PLATFORM_FEATURE_INSTRUCTION_RE.test(s)) return 'feature';
  if (DEFECT_WORDS_RE.test(s) || DEFECT_PHRASE_RE.test(s)) return 'bugfix';
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
const FILE_EXT_RE = /\.(?:ts|tsx|js|jsx|mjs|cjs|sql|html|css|scss|json|ya?ml|md)$/i;

export function extractSummaryPathClaims(summary) {
  // Brace shorthand ("src/x/{a,b,c}.ts") is EXPANDED before token scanning —
  // the project-32 false positive left fragments like "routes/service/schema"
  // that matched nothing and rejected an accurate summary.
  let s = String(summary || '').replace(/([A-Za-z0-9_./-]*)\{([^{}]+)\}([A-Za-z0-9_./-]*)/g,
    (_, pre, inner, post) => inner.split(',').map((x) => `${pre}${x.trim()}${post}`).join(' '));
  const out = new Set();
  const re = /(?:^|[\s`'"(])((?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+|[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\.(?:ts|tsx|js|jsx|mjs|cjs|sql|html|css|scss|json|ya?ml|md))(?=$|[\s`'"),.:;!?])/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    // Trailing SENTENCE punctuation is not part of the path. The token class
    // includes '.', so a summary that ends a sentence with a filename —
    // "…a type error in src/platform/branding.ts." — captured the full stop,
    // matched no changed file, and was rejected as an over-claim. Project 46
    // lost two of its five finish attempts to exactly that, and the model
    // correctly called it a false positive both times; repeated over-claiming
    // AUTO-HALTS a cycle, so this could kill a build for punctuation.
    // No filename ends in sentence punctuation, so stripping is always safe.
    const tok = m[1].replace(/^\.\//, '').replace(/[.,;:!?]+$/, '');
    if (!tok) continue;
    // Skip bare version-ish tokens and URLs.
    if (/^\d+(\.\d+)*$/.test(tok) || /:\/\//.test(tok)) continue;
    const segs = tok.split('/');
    const extSegs = segs.filter((x) => FILE_EXT_RE.test(x));
    if (extSegs.length > 1) {
      // Slash-JOINED file list ("public/app.html/app.css/app.js" — prose, not
      // a path): split into individual files, non-first ones by basename.
      const leadDirs = segs.slice(0, segs.indexOf(extSegs[0]));
      out.add([...leadDirs, extSegs[0]].join('/'));
      for (const x of extSegs.slice(1)) out.add(x);
      continue;
    }
    // A slash run whose LAST segment has no file extension is either a
    // directory claim (verified against changed paths by summaryOverclaims)
    // or plain hyphen/slash prose ("blocked/stale/promote-ready"). Word runs
    // where NO segment looks like a file or a known source dir are prose —
    // never a claim to reject a summary over.
    if (!FILE_EXT_RE.test(segs[segs.length - 1])
      && !segs.some((x) => FILE_EXT_RE.test(x))
      && !/^(?:src|public|app|lib|server|client|migrations|routes|components|pages|views|tests?|__tests__|scripts|state|docs)$/.test(segs[0])) {
      continue;
    }
    out.add(tok);
  }
  return [...out];
}

// ---- verification-only finish (the resume dead-end, P47 request 141) ----
//
// A halted cycle's work was already committed; every RESUME then replayed the
// original instruction, verified the tree already satisfied it, changed
// nothing — and had no honest exit: a finish summary naming the files it
// VERIFIED was rejected as an over-claim (empty diff ⇒ every named file is
// "not changed this cycle"), so the model halted again. ~$1 per resume,
// forever, with the work sitting finished the whole time.
//
// A finish that changed NO PRODUCT CODE and says so in terms is a legitimate
// completion: the files it names are the evidence trail of the verification,
// not a claim of authorship. The explicit phrasing requirement is the honesty
// forcing-function — an empty-diff summary that still reads as "I fixed X"
// stays rejected (and the rejection message teaches the phrasing).
const VERIFICATION_ONLY_RE = new RegExp(
  [
    String.raw`\balready\s+(?:implemented|present|resolved|fixed|addressed|satisfied|applied|in\s+place|done|correct|complete|exists?)\b`,
    String.raw`\bno\s+(?:code\s+|product\s+)?changes?\s+(?:were\s+|was\s+|are\s+|is\s+)?(?:needed|required|made|necessary)\b`,
    String.raw`\bnothing\s+(?:to\s+change|needed\s+changing|left\s+to\s+(?:change|fix))\b`,
    String.raw`\bverification[- ]only\b`,
  ].join('|'),
  'i',
);

// verificationOnlyFinish(summary, codeChanged) → true when this finish changed
// no product code AND the summary explicitly frames itself as verification of
// work that already exists. Callers pass the CODE diff (codeChangedFiles), not
// the raw working-tree list — platform-owned state files (a refreshed findings
// ledger) legitimately move under a verification cycle.
export function verificationOnlyFinish(summary, codeChanged = []) {
  const changed = (Array.isArray(codeChanged) ? codeChanged : []).filter(Boolean);
  if (changed.length) return false;
  return VERIFICATION_ONLY_RE.test(String(summary || ''));
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
      || changed.some((f) => c.endsWith(`/${f}`))
      // Directory claim ("src/opportunities"): covered when changed files
      // live under it (summaries legitimately name the folder they filled).
      || changed.some((f) => f.startsWith(`${c}/`));
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

// ---- action-parity gate (harness ratchet 3, project-32 finding 1) ----
// The inventory is the build contract, but nothing diffed its actions
// against what actually shipped — project 32's inventory-driven build
// implemented create flows and silently dropped nothing it was given...
// because the inventory itself was incomplete. Now that CRUD completion
// puts mutations INTO the inventory, this gate makes silently dropping
// them impossible: every mutation action must either appear in the app's
// UI source (its label is user-visible — implemented or explicitly badged
// "Not built yet") or the finish is rejected with the missing list.

const MUTATION_LABEL_RE = /^(?:\+\s*)?(?:new|add|create|edit|update|rename|delete|remove|archive|change|mark|complete|reopen|promote|assign|unblock|resolve)\b/i;

// Normalize an inventory label to a greppable literal: parentheticals and
// bracket placeholders stripped, whitespace collapsed. Returns '' when the
// remainder is too short to match meaningfully.
export function normalizeActionLabel(label) {
  const s = String(label || '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/^\s*\+\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length >= 4 ? s : '';
}

// The subset of inventory actions the parity gate enforces: mutations.
// Navigation/expand/filter labels are often descriptions ("Card click"),
// not button text — enforcing them would be noise. Mutations are the class
// that silently vanished. Returns [{ label, screen }], deduped by label.
export function mutationActions(inventory) {
  const out = [];
  const seen = new Set();
  for (const sc of inventory?.screens || []) {
    for (const a of sc.actions || []) {
      if (!MUTATION_LABEL_RE.test(String(a.label || ''))) continue;
      const label = normalizeActionLabel(a.label);
      if (!label || seen.has(label.toLowerCase())) continue;
      seen.add(label.toLowerCase());
      out.push({ label, screen: sc.name });
    }
  }
  return out;
}

// The significant words of an action label — what a control implementing it
// would have to mention somewhere, whatever it calls itself. Short words carry
// no signal, so they are dropped ("Add to list" → ['add', 'list']).
const PARITY_STOPWORDS = new Set(['the', 'a', 'an', 'to', 'of', 'for', 'from', 'this', 'that', 'and', 'or', 'new']);

export function actionLabelWords(label) {
  return String(label || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !PARITY_STOPWORDS.has(w));
}

// The action's CORE: its verb and the first thing that verb acts on.
//
// WHY THE FULL WORD LIST WAS THE WRONG BAR. The drift grep required EVERY
// significant word on ONE LINE of source. For "Edit note title/body" that is
// `edit` AND `note` AND `title` AND `body`, together, on a single line — which
// no honestly-designed control will ever satisfy. A real UI has
// `<button>Edit</button>` on one line and the word "title" three files away.
//
// So project 47's build, which had already designed `More actions → Edit`,
// was told the action appeared NOWHERE, and reasoned its way to the only thing
// that would pass:
//
//     "I have it via More actions → Edit, but the checker likely wants an
//      explicit id/label. Let me add explicit affordances"
//
// It shipped a button reading "Edit note title/body" — the contract string,
// printed on screen — plus a second path to /admin so the other action would
// match too. The gate did not catch a missing feature; it dictated the wording
// of two controls and added a redundant one.
//
// Two words is the bar because two words is what a REAL control can carry:
// the verb somewhere near the noun. Anything looser stops catching a genuine
// silent drop, which is what this gate is for.
export function actionLabelCore(label) {
  const words = actionLabelWords(label);
  return words.slice(0, 2);
}

// Classify against what was actually found in UI source. Three outcomes, not
// two:
//
//   present  — the contract's exact label is in the source. Working control or
//              a visible "Not built yet" badge; either way it is surfaced.
//   drifted  — the label is NOT there, but every significant word of it appears
//              together on one line of UI source. The action exists under a
//              different name.
//   missing  — nothing. This is the silent drop the gate exists to catch.
//
// WHY `drifted` earns its own bucket. Project 42's inventory said "Delete
// asset" and the platform admin console already shipped that control, labelled
// differently, wired to DELETE /branding/assets/:id. Exact-label matching
// called it silently missing, so the gate rejected the finish and the build
// spent seven searches and a round-trip discovering that the feature was there
// all along — then renamed a control to satisfy the grep. That is the gate
// teaching a build to edit labels for the detector, which is precisely what the
// runner is told never to do.
//
// Only `missing` rejects a finish. `drifted` is reported, because a real
// mismatch between the approved contract and the shipped label is worth
// knowing about — it is just not evidence the action was dropped.
// `hiddenOnlyLabelsLower` — the contract's label WAS found, and every line it
// was found on carries a `hidden` attribute. That is not a surfaced action, it
// is the gate being satisfied by an invisible element, and project 47 shipped
// exactly that:
//
//     <p class="app-footer t-faint" id="admin-settings-hint" hidden …>
//       <a href="/admin">Settings</a> — edit application name / legal text…
//
// A dead element whose only purpose was to match this grep. So the check was
// simultaneously too strict about WORDING and too weak about VISIBILITY, and
// both errors pushed in the same direction: toward markup written for the
// detector rather than for a person.
export function actionParityReport(
  actions = [],
  foundLabelsLower = new Set(),
  wordHitLabelsLower = new Set(),
  hiddenOnlyLabelsLower = new Set(),
) {
  const present = [];
  const drifted = [];
  const missing = [];
  const hiddenOnly = [];
  for (const a of actions) {
    const key = a.label.toLowerCase();
    if (hiddenOnlyLabelsLower.has(key)) { hiddenOnly.push(a); missing.push(a); continue; }
    if (foundLabelsLower.has(key)) present.push(a);
    else if (wordHitLabelsLower.has(key)) drifted.push(a);
    else missing.push(a);
  }
  return { ok: missing.length === 0, present, drifted, missing, hiddenOnly };
}
