// Action-parity gate (ratchet 3): pure selection/normalization/classification.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  mutationActions, actionParityReport, normalizeActionLabel, actionParityProbeScript,
} from '../mock2/acceptance-logic.js';

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

// ---- prose is not a path (project 55) ----
//
// The screen is called "State & Pod schedule". The summary wrote it
// "state/pod", the token's first segment happened to be a source-dir name, and
// the finish was rejected for naming a file it did not change — one of the
// three rejections that ended request 258. Nothing in the token itself tells
// prose from a directory claim; the TREE does.
test('summaryOverclaims: an extension-less token naming no real directory is prose', async () => {
  const { summaryOverclaims } = await import('../mock2/acceptance-logic.js');
  const changed = ['public/pipeline.js', 'src/pipeline/routes.ts'];
  const tracked = ['public/pipeline.js', 'src/pipeline/routes.ts', 'src/billing/invoice.ts', 'state/rules.md'];

  const oc = summaryOverclaims('Built the state/pod schedule screen', changed, { knownPaths: tracked });
  assert.equal(oc.ok, true, '"state/pod" is not a directory in this repo — it is prose');
  assert.deepEqual(oc.prose, ['state/pod']);

  // A directory that EXISTS and was not touched is still an over-claim.
  const bad = summaryOverclaims('reworked src/billing', changed, { knownPaths: tracked });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.unmatched, ['src/billing']);

  // A file claim is unaffected by the tree listing.
  const file = summaryOverclaims('rewrote src/billing/invoice.ts', changed, { knownPaths: tracked });
  assert.equal(file.ok, false);

  // Without a listing, nothing changes: every directory claim is enforced.
  assert.equal(summaryOverclaims('Built the state/pod schedule screen', changed).ok, false);
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
  const probe = readFileSync(new URL('../mock2/acceptance-logic.js', import.meta.url), 'utf8');
  assert.match(probe, /actionLabelCore\(a\.label\)/, 'the full word list was the wrong bar');
  assert.ok(!/actionLabelWords\(a\.label\)\.filter\(\(w\) => \/\^\[a-z0-9\]\+\$\/\.test\(w\)\)\.slice\(0, 6\)/.test(probe),
    'the all-words-on-one-line grep must be gone');
  const script = actionParityProbeScript([{ label: 'Delete asset', screen: 'Admin' }], { appDir: '/app' });
  assert.match(script, /printf 'HIDDEN\\t/, 'hidden-only must be its own signal');
  assert.match(script, /printf 'WORDS\\t/);
  assert.match(script, /printf 'FOUND\\t/);
  assert.match(probe, /PARITY_UNHIDE_RE/, 'a collapsed surface the app opens must stay reachable');
  // THE LINE-SUBSTRING TEST IS THE DEFECT (project 55): the old probe counted
  // lines with `grep -vc 'hidden'`, so a one-line module read as hidden
  // because the word appeared ANYWHERE on it. Asserted against the emitted
  // script, not the source — the prose above may name the old grep.
  assert.ok(!/-vc '?hidden/.test(script), 'the whole-line substring test must never come back');
  assert.ok(!/grep -vc 'hidden'/.test(src), 'and it must not be back in the runner either');
  assert.match(src, /actionParityReport\(actions, found, wordHits, hiddenOnly\)/);
});

/* ============== THE PROBE, RUN THE WAY THE CONTAINER RUNS IT ============== */
//
// Project 55 built the Board exactly as this gate says it wants — a "More
// actions" overflow menu holding Edit / Change stage / Delete acquisition,
// with real handlers — and was told three times that a user had no way to
// perform any of them. Three rejections is the entire finish budget: the
// build halted reporting a harness fault, and the operator got no app.
//
// Two properties of the file did it, and both are ordinary:
//   • the renderer is ONE LINE (a template literal per screen), so the label
//     and the collapsed menu's `class="menu hidden"` share a line;
//   • `classList.toggle('hidden')` — the code that OPENS the menu — is on
//     that line too, and its own text contains the word.
// The fixtures below are that file, reduced.

function runProbe(actions, files) {
  const dir = mkdtempSync(join(tmpdir(), 'pp-parity-'));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const p = join(dir, rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, content);
    }
    const sp = join(dir, '.probe.sh');
    writeFileSync(sp, actionParityProbeScript(actions, { appDir: dir }));
    const r = spawnSync('sh', [sp], { cwd: dir, encoding: 'utf8' });
    const tags = {};
    for (const line of String(r.stdout || '').split('\n')) {
      const [tag, label] = line.split('\t');
      if (label) tags[label] = tag;
    }
    return tags;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const P55_ACTIONS = [
  { label: 'New acquisition', screen: 'Board' },
  { label: 'Change stage', screen: 'Board' },
  { label: 'Delete acquisition', screen: 'Board' },
];

// The real markup, one line per renderer, as project 55 shipped it.
const P55_FILES = {
  'public/pipeline.js':
    'function card(item) { return `<article class="acq-card"><div class="menu-wrap">'
    + '<button class="icon-btn card-menu" data-menu="${item.id}" aria-label="Acquisition options">⋯</button>'
    + '<div class="menu hidden" id="menu-${item.id}"><button data-edit="${item.id}">Edit acquisition</button>'
    + '<button data-stage="${item.id}">Change stage</button>'
    + '<button class="danger" data-delete="${item.id}">Delete acquisition</button></div></div></article>`; }\n'
    + 'function renderBoard() { root.innerHTML = `<button class="btn-primary" id="new-acquisition">+ New acquisition</button>`;'
    + " root.querySelectorAll('.card-menu').forEach((b) => b.addEventListener('click', () =>"
    + " document.getElementById(`menu-${b.dataset.menu}`).classList.toggle('hidden'))); }\n",
  // Minified: the whole stylesheet is one line, and it carries overflow:hidden.
  'public/pipeline.css':
    '.acq-card{border-radius:12px}.bar{height:8px;width:130px;border-radius:999px;overflow:hidden}.menu.hidden{display:none}\n',
};

test('the overflow menu is REACHABLE — a collapsed surface the app opens is not a hidden-only match', () => {
  const tags = runProbe(P55_ACTIONS, P55_FILES);
  for (const a of P55_ACTIONS) {
    assert.equal(tags[a.label], 'FOUND', `"${a.label}" is in a menu the Board toggles open — it is reachable`);
  }
});

test('a stylesheet\'s overflow:hidden can never make an action hidden-only', () => {
  // Same markup with the toggle removed: the decision must come from the
  // element, and CSS must not participate in it at all.
  const tags = runProbe([{ label: 'Delete acquisition', screen: 'Board' }], {
    'public/pipeline.js': 'const card = () => `<div class="menu"><button data-delete>Delete acquisition</button></div>`;\n',
    'public/pipeline.css': '.bar{width:130px;overflow:hidden}\n',
  });
  assert.equal(tags['Delete acquisition'], 'FOUND');
});

test('project 47 stays caught: a dead `hidden` element nothing ever opens is hidden-only', () => {
  const tags = runProbe([{ label: 'Edit note', screen: 'Notes' }], {
    'public/index.html':
      '<p class="app-footer" id="admin-settings-hint" hidden><a href="/admin">Settings</a> — Edit note</p>\n',
    'public/app.js': 'document.getElementById("save").addEventListener("click", save);\n',
  });
  assert.equal(tags['Edit note'], 'HIDDEN', 'an element written for the grep is still not a control');
});

test('aria-hidden and data-hidden are not the hidden attribute', () => {
  const tags = runProbe([{ label: 'Delete asset', screen: 'Admin' }], {
    'public/admin.html': '<button data-hidden="false"><span aria-hidden="true">×</span>Delete asset</button>\n',
  });
  assert.equal(tags['Delete asset'], 'FOUND');
});

test('an action in no file at all is still missing', () => {
  const tags = runProbe([{ label: 'Archive contract', screen: 'Board' }], P55_FILES);
  assert.equal(tags['Archive contract'], undefined, 'nothing is emitted for an action with no match');
});

test('a label with quotes cannot break out of the probe script', () => {
  const tags = runProbe([{ label: "Delete Bob's asset", screen: 'Admin' }], {
    'public/admin.html': "<button>Delete Bob's asset</button>\n",
  });
  assert.equal(tags["Delete Bob's asset"], 'FOUND');
});

test('RATCHET: the pair cannot force render-everything', () => {
  // gate-audit.md #4: no-dead-controls + action parity, read together, used to
  // say "render every contract action; badge the rest" — the form-like app.
  // Each side has given up its half of that instruction, and the message must
  // keep saying so.
  const runner = readFileSync(new URL('../mock2/runner.js', import.meta.url), 'utf8');
  const i = runner.indexOf('Not finished — action parity');
  const msg = runner.slice(i, i + 1600);
  assert.match(msg, /never asks for a new top-level control/);
  assert.match(msg, /menu item, a detail view, a settings screen all count/);
  // The badge is conditional on the MOCKUP showing the control — never a
  // blanket instruction to render.
  assert.match(msg, /when the mockup SHOWS its control/);
  assert.match(msg, /leave it out and say so in your finish summary/);
  assert.ok(!/If you genuinely cannot build one this cycle, render it disabled/.test(msg),
    'the unconditional badge instruction must be gone');

  const gates = readFileSync(new URL('../mock2/baseline-gates.js', import.meta.url), 'utf8');
  const j = gates.indexOf('---- no-dead-controls ----');
  const header = gates.slice(j, j + 1800);
  assert.match(header, /ONLY to\n\/\/ controls the build CHOSE to render/);
  assert.match(header, /THE PAIR/);
  assert.match(header, /CHEAPEST PASS/);
});
