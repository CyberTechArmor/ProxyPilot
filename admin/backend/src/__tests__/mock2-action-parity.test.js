// Action-parity gate (ratchet 3): pure selection/normalization/classification.
import test from 'node:test';
import assert from 'node:assert/strict';
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
