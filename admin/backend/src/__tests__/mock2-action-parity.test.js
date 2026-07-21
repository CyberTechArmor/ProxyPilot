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
