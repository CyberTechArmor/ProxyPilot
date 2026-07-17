// Component auto-apply — the operator policy that confirms EVERY published
// component for every build (origin 'auto') instead of waiting on a
// capability-match suggestion + per-project confirm. Exercises the PURE
// decision layer (component-logic.js): setting normalization and the selection
// of which catalog rows auto-apply may confirm. No DB/container, so it runs at
// the module boundary (risk R9).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeComponentAutoApply, selectAutoApplyComponents,
  COMPONENT_AUTO_APPLY_ON, COMPONENT_AUTO_APPLY_OFF,
} from '../mock2/component-logic.js';

test('normalizeComponentAutoApply recognizes off spellings', () => {
  for (const v of ['off', 'OFF', ' false ', '0', 'no', 'disabled']) {
    assert.equal(normalizeComponentAutoApply(v), COMPONENT_AUTO_APPLY_OFF, `"${v}" should be off`);
  }
});

test('normalizeComponentAutoApply defaults everything else to on', () => {
  for (const v of ['on', 'true', '1', 'yes', '', null, undefined, 'banana']) {
    assert.equal(normalizeComponentAutoApply(v), COMPONENT_AUTO_APPLY_ON, `"${v}" should be on`);
  }
});

const catalog = [
  { id: 1, key: 'proxypilot-auth', current_version_id: 11 },
  { id: 2, key: 'proxypilot-billing', current_version_id: 22 },
  { id: 3, key: 'proxypilot-chat', current_version_id: 33 },
];

test('selectAutoApplyComponents picks undecided and still-suggested components', () => {
  const rows = [{ key: 'proxypilot-billing', status: 'suggested' }];
  const out = selectAutoApplyComponents(catalog, rows);
  assert.deepEqual(out.map((c) => c.key), ['proxypilot-auth', 'proxypilot-billing', 'proxypilot-chat']);
});

test('selectAutoApplyComponents never overrides a human decision or a finished install', () => {
  const rows = [
    { key: 'proxypilot-auth', status: 'declined' },       // human said no — stays no
    { key: 'proxypilot-billing', status: 'installed' },   // already landed
    { key: 'proxypilot-chat', status: 'install_failed' }, // retried by the pre-installer itself
  ];
  assert.deepEqual(selectAutoApplyComponents(catalog, rows), []);
});

test('selectAutoApplyComponents leaves confirmed rows alone (nothing to re-decide)', () => {
  const rows = [{ key: 'proxypilot-auth', status: 'confirmed' }];
  assert.deepEqual(
    selectAutoApplyComponents(catalog, rows).map((c) => c.key),
    ['proxypilot-billing', 'proxypilot-chat'],
  );
});

test('selectAutoApplyComponents is order-stable by key and tolerant of empty input', () => {
  const shuffled = [catalog[2], catalog[0], catalog[1]];
  assert.deepEqual(
    selectAutoApplyComponents(shuffled, []).map((c) => c.key),
    ['proxypilot-auth', 'proxypilot-billing', 'proxypilot-chat'],
  );
  assert.deepEqual(selectAutoApplyComponents([], []), []);
  assert.deepEqual(selectAutoApplyComponents(undefined, undefined), []);
});
