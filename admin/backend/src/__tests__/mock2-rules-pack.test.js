// Standard CRUD rules pack (ratchet 5) + the MVP floor section (ratchet 4).
import test from 'node:test';
import assert from 'node:assert/strict';
import { CRUD_RULES_PACK, crudRulesFloorSection } from '../mock2/rules-pack-logic.js';

test('the pack encodes every project-32 miss as a rule', () => {
  assert.match(CRUD_RULES_PACK, /edited and deleted/);
  assert.match(CRUD_RULES_PACK, /fully cyclable/);
  assert.match(CRUD_RULES_PACK, /blocked ↔ unblocked/);
  assert.match(CRUD_RULES_PACK, /recomputes after every mutation/);
  assert.match(CRUD_RULES_PACK, /confirm-guarded/);
  assert.match(CRUD_RULES_PACK, /no pre-applied filters/);
  assert.match(CRUD_RULES_PACK, /Empty states are designed/);
});

test('the floor section binds the pack but keeps inventory/instruction authoritative', () => {
  const s = crudRulesFloorSection();
  assert.match(s, /Standard rules floor \(MVP fast path/);
  assert.match(s, /BINDING as the floor/);
  assert.match(s, /inventory\/instruction wins/);
  assert.ok(s.includes(CRUD_RULES_PACK));
});
