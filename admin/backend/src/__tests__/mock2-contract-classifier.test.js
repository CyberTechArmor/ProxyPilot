// Contract classifier — the build-time answer to the "unapproved feature"
// dead-end (project-53 folders saga: three halts, then a "Not built yet"
// placeholder shipped as the feature). Stub-first (risk R9): native-free.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CONTRACT_CLASSIFIER_FLAG,
  contractClassifierMode,
  CONTRACT_CLASSIFIER_PROMPT,
  buildContractClassifierTask,
  parseContractClassifierReply,
  applyInventoryAdditions,
  AMENDMENT_ORIGIN,
  contractAmendmentMessage,
  splitPartsFidelity,
  significantWords,
} from '../mock2/contract-classifier-logic.js';

// ---- toggle + prompt ----

test('classifier defaults on; only off/0/false disables', () => {
  assert.equal(contractClassifierMode({}), 'on');
  assert.equal(contractClassifierMode({ [CONTRACT_CLASSIFIER_FLAG]: 'off' }), 'off');
  assert.equal(contractClassifierMode({ [CONTRACT_CLASSIFIER_FLAG]: 'junk' }), 'on');
  assert.match(CONTRACT_CLASSIFIER_PROMPT, /STRICT JSON/);
  const task = buildContractClassifierTask({ instruction: 'add folders', inventoryJson: '{"screens":[]}' });
  assert.ok(task.includes('add folders') && task.includes('"screens"'));
});

// ---- parsing (fail-open on junk) ----

test('parse: covered / additions / lane signals / junk', () => {
  const covered = parseContractClassifierReply('{"covered":true,"reason":"styling only","complexity":"mechanical","touches":[],"additions":{}}');
  assert.equal(covered.covered, true);
  assert.equal(covered.complexity, 'mechanical');
  assert.deepEqual(covered.touches, []);
  const v = parseContractClassifierReply(`Here you go:
    {"covered":false,"reason":"folders are not in the contract","complexity":"complex","touches":["migration"],"additions":{
      "actions":[{"screen":"Documents","label":"Create folder"},{"screen":"Documents","label":"Move document to folder"}],
      "fields":[{"screen":"Documents","name":"Folder"}],"screens":[]}}`);
  assert.equal(v.covered, false);
  assert.equal(v.additions.actions.length, 2);
  assert.deepEqual(v.touches, ['migration']);
  // Missing/junk lane signals default to the SAFE side: complex, no touches.
  const bare = parseContractClassifierReply('{"covered":true,"additions":{}}');
  assert.equal(bare.complexity, 'complex');
  assert.deepEqual(bare.touches, []);
  // covered:false with EMPTY additions normalizes to covered (nothing to add).
  assert.equal(parseContractClassifierReply('{"covered":false,"additions":{}}').covered, true);
  assert.equal(parseContractClassifierReply('not json at all'), null);
  assert.equal(parseContractClassifierReply('{"nope":1}'), null);
});

// ---- applying additions: append-only, origin-stamped, deduped ----

const DOCS_INVENTORY = {
  screens: [
    { name: 'Documents', purpose: 'list', actions: [{ label: 'Create document' }, { label: 'Delete document' }], fields: [{ name: 'Title' }] },
    { name: 'Editor', actions: [{ label: 'Edit title' }] },
  ],
};

test('additions append with origin stamps; existing entries untouched; dupes dropped', () => {
  const r = applyInventoryAdditions(DOCS_INVENTORY, {
    actions: [
      { screen: 'Documents', label: 'Create folder' },
      { screen: 'Documents', label: 'create document' }, // dupe (case-insensitive)
      { screen: 'Nowhere', label: 'Rename folder' },     // unknown screen → first screen
    ],
    screens: [{ name: 'Folder settings', purpose: 'manage folders', actions: [{ label: 'Delete folder' }], fields: [] }],
    fields: [{ screen: 'Documents', name: 'Folder' }],
  }, { at: '2026-08-02T10:00:00Z' });
  assert.equal(r.added.screens, 1);
  assert.equal(r.added.actions, 3); // Create folder + Rename folder + Delete folder (dupe dropped)
  assert.equal(r.added.fields, 1);
  const docs = r.inventory.screens[0];
  // Existing entries byte-identical; new ones stamped.
  assert.deepEqual(docs.actions[0], { label: 'Create document' });
  const created = docs.actions.find((a) => a.label === 'Create folder');
  assert.equal(created.origin, AMENDMENT_ORIGIN);
  assert.equal(created.amended_at, '2026-08-02T10:00:00Z');
  // The source object was not mutated.
  assert.equal(DOCS_INVENTORY.screens[0].actions.length, 2);
  // Nothing to add → total 0 (caller skips the write).
  assert.equal(applyInventoryAdditions(DOCS_INVENTORY, { actions: [{ screen: 'Documents', label: 'Create document' }] }).added.total, 0);
  assert.match(contractAmendmentMessage(r.added, r.summary, 'folders missing'), /request_amendment/);
});

// ---- split fidelity: the REAL folders→fonts corruption ----

test('the project-53 split (folders request → fonts parts) is flagged', () => {
  const original = 'Add folders to the documents screen: a collapsible folder tree in the sidebar, documents belong to one folder, drag to move, per-folder document counts';
  const parts = [
    { title: 'Folder list column and selection state', items: ['Add 240px fixed left column to fonts view layout', 'Fetch and render folder tree with name + font count per folder'] },
    { title: 'Breadcrumb navigation and main list filtering', items: ['Build breadcrumb component', 'Filter main font list by selected folder'] },
    { title: 'Empty state and drop zone hint', items: ["Detect when selected folder has no fonts", "Replace main list with 'No fonts in this folder'"] },
  ];
  const f = splitPartsFidelity(original, parts);
  assert.equal(f.ok, false);
  assert.ok(f.foreign.some((w) => w === 'font' || w === 'fonts'), `expected fonts flagged, got ${f.foreign}`);
});

test('legitimate implementation vocabulary confined to one part never trips fidelity', () => {
  const original = 'Add folders to the documents screen with a folder tree and per-folder document counts';
  const parts = [
    { title: 'Folder column', items: ['Add 240px column', 'render folder tree with document count per folder'] },
    { title: 'Breadcrumbs', items: ['Build breadcrumb path from root to selected folder', 'breadcrumb segments clickable'] },
    { title: 'Empty state', items: ['No documents in this folder message', 'drop hint for moving documents'] },
  ];
  // 'breadcrumb' repeats only inside part 2; '240px' only in part 1 — fine.
  assert.equal(splitPartsFidelity(original, parts).ok, true);
  // Sanity on the word helper: plural tolerance.
  assert.ok(significantWords('folders and documents').has('folders'));
  assert.equal(splitPartsFidelity('add folder support', [{ title: 'x', items: ['folders everywhere'] }, { title: 'y', items: ['folders again'] }]).ok, true);
});

test('redoContextSection: the prior attempt rides a redo, bounded; empty record rides nothing', async () => {
  const { redoContextSection } = await import('../mock2/contract-classifier-logic.js');
  const s = redoContextSection({ summary: 'Fixed the export menu\n\nDiff (this checkpoint):\n public/notes.js | 12 +-' });
  assert.match(s, /PRIOR ATTEMPT/);
  assert.match(s, /Fixed the export menu/);
  assert.match(s, /do not redo it blind/);
  assert.equal(redoContextSection(null), '');
  assert.equal(redoContextSection({ summary: '' }), '');
  assert.ok(redoContextSection({ summary: 'x'.repeat(9000) }).length < 1800);
});
