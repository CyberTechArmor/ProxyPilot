// Action-parity gate (ratchet 3): pure selection/normalization/classification.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mutationActions, actionParityReport, normalizeActionLabel } from '../mock2/acceptance-logic.js';

test('mutationActions: mutations selected, navigation/expand noise excluded, deduped', () => {
  const inv = { screens: [
    { name: 'List', actions: [
      { label: 'New opportunity', effect: 'create' },
      { label: 'Card click', effect: 'Navigates to detail' },
      { label: 'Blocked section expand/collapse', effect: 'toggles' },
      { label: '+ 2 more due this week', effect: 'shows more' },
    ] },
    { name: 'Detail', actions: [
      { label: 'Add task', effect: '' },
      { label: 'Edit opportunity', effect: '', inferred: true },
      { label: 'Delete opportunity', effect: '', inferred: true },
      { label: 'Change Task status dot', effect: '' },
      { label: 'Promote', effect: '' },
      { label: 'Add task', effect: 'dupe' },
    ] },
  ] };
  const acts = mutationActions(inv);
  const labels = acts.map((a) => a.label);
  assert.deepEqual(labels, ['New opportunity', 'Add task', 'Edit opportunity', 'Delete opportunity', 'Change Task status dot', 'Promote']);
  assert.equal(acts[0].screen, 'List');
});

test('normalizeActionLabel strips parentheticals/brackets/+ and short junk', () => {
  assert.equal(normalizeActionLabel('Opportunity link (opplink)'), 'Opportunity link');
  assert.equal(normalizeActionLabel('+ N more in [Stage]'), 'N more in');
  assert.equal(normalizeActionLabel('Go'), '');
});

test('actionParityReport: label found anywhere in UI source = surfaced; nowhere = silently missing', () => {
  const actions = [
    { label: 'New opportunity', screen: 'List' },
    { label: 'Edit opportunity', screen: 'Detail' },
    { label: 'Delete opportunity', screen: 'Detail' },
  ];
  const found = new Set(['new opportunity', 'edit opportunity']); // delete nowhere
  const r = actionParityReport(actions, found);
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing.map((a) => a.label), ['Delete opportunity']);
  assert.equal(r.present.length, 2);
  assert.equal(actionParityReport(actions, new Set(actions.map((a) => a.label.toLowerCase()))).ok, true);
});

test('actionParityReport: a shipped action under a different label is drift, not a silent drop', () => {
  // Project 42. The inventory said "Delete asset". The platform admin console
  // already shipped that control — a confirm-guarded DELETE /branding/assets/:id
  // — under another name. Exact-label matching called it silently missing, the
  // gate rejected the finish, and the build spent seven searches discovering
  // the feature was already there before renaming a control to satisfy a grep.
  const actions = [
    { label: 'Delete asset', screen: 'Admin' },
    { label: 'Create widget', screen: 'List' },
  ];
  const r = actionParityReport(actions, new Set(), new Set(['delete asset']));
  // Drift does NOT reject the finish — the action is in the app.
  assert.equal(r.ok, false, 'the genuinely absent one still fails');
  assert.deepEqual(r.drifted.map((a) => a.label), ['Delete asset']);
  assert.deepEqual(r.missing.map((a) => a.label), ['Create widget']);

  // Drift alone is a clean pass with a report, never a rejection.
  const drift = actionParityReport([actions[0]], new Set(), new Set(['delete asset']));
  assert.equal(drift.ok, true);
  assert.equal(drift.drifted.length, 1);
  assert.equal(drift.present.length, 0);

  // An exact label still outranks a word hit — it is present, not drifted.
  const exact = actionParityReport([actions[0]], new Set(['delete asset']), new Set(['delete asset']));
  assert.equal(exact.present.length, 1);
  assert.equal(exact.drifted.length, 0);
});

test('actionLabelWords: the words a control implementing the action would have to mention', async () => {
  const { actionLabelWords } = await import('../mock2/acceptance-logic.js');
  assert.deepEqual(actionLabelWords('Delete asset'), ['delete', 'asset']);
  // Noise words carry no signal and would match any line in the codebase.
  assert.deepEqual(actionLabelWords('Add a task to the list'), ['add', 'task', 'list']);
  assert.deepEqual(actionLabelWords('New note'), ['note'], '"new" is in every UI');
  // Every word survives as [a-z0-9]+, so the grep built from them is shell-safe.
  for (const w of actionLabelWords("Mark as done — Bob's row (2)")) assert.match(w, /^[a-z0-9]+$/);
});

test('summary over-claim precision (ratchet 9): the project-32 rejection now passes', async () => {
  const { extractSummaryPathClaims, summaryOverclaims } = await import('../mock2/acceptance-logic.js');
  // The EXACT summary shape the orchestrator rejected despite an accurate diff.
  const summary = "Added the opportunities domain (migrations/0004_opportunities.sql, src/db/schema.ts, src/opportunities/{schema,service,routes}.ts) and wired it in src/app.ts, plus a token-styled SPA (public/app.html, public/app.css, public/app.js) served at / behind existing auth reproducing the approved mockup's six screens with blocked/stale/promote-ready attention chips.";
  const changed = [
    'migrations/0004_opportunities.sql', 'src/db/schema.ts', 'src/opportunities/schema.ts',
    'src/opportunities/service.ts', 'src/opportunities/routes.ts', 'src/app.ts',
    'public/app.html', 'public/app.css', 'public/app.js',
  ];
  const claims = extractSummaryPathClaims(summary);
  // Brace shorthand expanded to real paths; prose word-runs never claimed.
  assert.ok(claims.includes('src/opportunities/schema.ts'));
  assert.ok(claims.includes('src/opportunities/routes.ts'));
  assert.ok(!claims.includes('blocked/stale/promote-ready'));
  assert.ok(!claims.some((c) => c === 'routes/service/schema'));
  const oc = summaryOverclaims(summary, changed);
  assert.deepEqual(oc.unmatched, []);
  assert.equal(oc.ok, true);
  // Slash-joined file lists split into files (each covered by basename).
  const oc2 = summaryOverclaims('rebuilt public/app.html/app.css/app.js', changed);
  assert.equal(oc2.ok, true);
  // Directory claims covered by prefix.
  assert.equal(summaryOverclaims('filled out src/opportunities', changed).ok, true);
  // REAL over-claims are still caught.
  const bad = summaryOverclaims('Rewrote src/auth/session.ts and src/opportunities/schema.ts', changed);
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.unmatched, ['src/auth/session.ts']);
  // A directory nothing changed under is still an over-claim.
  assert.equal(summaryOverclaims('reworked src/billing', changed).ok, false);
});

/* ===================== THE GATE THAT DICTATED THE UI ====================== */
//
// Project 47's build had already designed `More actions → Edit`. The drift
// grep required EVERY significant word of the contract label on ONE LINE —
// for "Edit note title/body" that is edit AND note AND title AND body,
// together — which no designed control ever satisfies. So the gate reported
// the action as appearing NOWHERE, and the build reasoned:
//
//   "I have it via More actions → Edit, but the checker likely wants an
//    explicit id/label. Let me add explicit affordances"
//
// It shipped a button reading "Edit note title/body" and a second path to
// /admin. The gate did not catch a missing feature; it wrote two labels and
// added a redundant control.

test('THE CORE IS TWO WORDS, because that is what a real control can carry', async () => {
  const { actionLabelCore, actionLabelWords } = await import('../mock2/acceptance-logic.js');
  assert.deepEqual(actionLabelWords('Edit note title/body'), ['edit', 'note', 'title', 'body']);
  assert.deepEqual(actionLabelCore('Edit note title/body'), ['edit', 'note'],
    'the verb and the thing it acts on — a button reading "Edit" inside a note view can satisfy this');
  assert.deepEqual(actionLabelCore('Edit application name / legal text'), ['edit', 'application']);
  assert.deepEqual(actionLabelCore('Delete to-do / subtask'), ['delete', 'subtask']);
  assert.deepEqual(actionLabelCore('Add to-do'), ['add'], 'a one-word core is fine — a loose miss costs less than a false rejection');
  assert.deepEqual(actionLabelCore(''), []);
});

test('A HIDDEN ELEMENT IS NOT A SURFACED ACTION', async () => {
  // Project 47 shipped, and still ships:
  //   <p class="app-footer t-faint" id="admin-settings-hint" hidden …>
  //     <a href="/admin">Settings</a> — edit application name / legal text…
  // A dead element whose only purpose was to match the grep. The old check
  // counted it as present.
  const { actionParityReport } = await import('../mock2/acceptance-logic.js');
  const actions = [{ label: 'Edit application name / legal text', screen: 'Admin' }];
  const r = actionParityReport(actions, new Set(), new Set(), new Set(['edit application name / legal text']));
  assert.equal(r.ok, false, 'hidden-only must not pass');
  assert.equal(r.hiddenOnly.length, 1);
  assert.equal(r.present.length, 0);
  assert.deepEqual(r.missing.map((a) => a.label), ['Edit application name / legal text'],
    'and it must still be reported as not surfaced');
});

test('hidden-only wins over a stale FOUND for the same label', async () => {
  const { actionParityReport } = await import('../mock2/acceptance-logic.js');
  const actions = [{ label: 'Delete asset', screen: 'Admin' }];
  const r = actionParityReport(actions, new Set(['delete asset']), new Set(), new Set(['delete asset']));
  assert.equal(r.ok, false);
  assert.equal(r.hiddenOnly.length, 1);
});

test('the three original buckets are unchanged when nothing is hidden', async () => {
  const { actionParityReport } = await import('../mock2/acceptance-logic.js');
  const actions = [
    { label: 'Add note', screen: 'List' },
    { label: 'Delete asset', screen: 'Admin' },
    { label: 'Archive note', screen: 'List' },
  ];
  const r = actionParityReport(actions, new Set(['add note']), new Set(['delete asset']));
  assert.deepEqual(r.present.map((a) => a.label), ['Add note']);
  assert.deepEqual(r.drifted.map((a) => a.label), ['Delete asset'], 'renamed, reported, not blocking');
  assert.deepEqual(r.missing.map((a) => a.label), ['Archive note']);
  assert.deepEqual(r.hiddenOnly, []);
  assert.equal(r.ok, false);
});

test('RATCHET: the rejection must not ask for the contract wording', () => {
  // The old message said the actions "appear NOWHERE in the app's UI source",
  // which a build correctly read as "print the string". A gate that dictates
  // copy is worse than the drop it catches.
  const src = readFileSync(new URL('../mock2/runner.js', import.meta.url), 'utf8');
  const i = src.indexOf('Not finished — action parity');
  assert.ok(i > 0);
  const msg = src.slice(i, i + 1400);
  assert.match(msg, /CAPABILITIES, not button copy/);
  assert.match(msg, /More actions" menu all pass/, 'the good design must be named as acceptable');
  // The source escapes the apostrophe inside its single-quoted string.
  assert.match(msg, /Do NOT put the contract\\?'s wording on screen/);
  assert.match(msg, /Edit note title\/body/, 'name the actual bad outcome, not an abstraction');
  assert.match(msg, /`hidden` attribute/);
  assert.ok(!/appear NOWHERE in the app's UI source/.test(msg), 'the wording that caused it must be gone');
});

test('RATCHET: the greps use the core and detect hidden-only', () => {
  const src = readFileSync(new URL('../mock2/runner.js', import.meta.url), 'utf8');
  assert.match(src, /actionLabelCore\(a\.label\)/, 'the full word list was the wrong bar');
  assert.ok(!/actionLabelWords\(a\.label\)\.filter\(\(w\) => \/\^\[a-z0-9\]\+\$\/\.test\(w\)\)\.slice\(0, 6\)/.test(src),
    'the all-words-on-one-line grep must be gone');
  assert.match(src, /printf 'HIDDEN/, 'hidden-only must be its own signal');
  assert.match(src, /grep -vc 'hidden'/);
  assert.match(src, /actionParityReport\(actions, found, wordHits, hiddenOnly\)/);
});
