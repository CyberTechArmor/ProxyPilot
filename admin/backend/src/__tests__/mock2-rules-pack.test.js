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

test('executable acceptance (ratchet 7): finish carries acceptance_ids into classifyTurn', async () => {
  const { classifyTurn, RUNNER_TOOLS } = await import('../mock2/runner-logic.js');
  const d = classifyTurn([{ name: 'finish', input: { summary: 's', acceptance: ['as user, do x, expect y'], assumptions: { verified: [], assumed: [] }, acceptance_ids: ['opp-create-happy', ' ', 'promote-blocked'] } }]);
  assert.equal(d.done, true);
  assert.deepEqual(d.finishAcceptanceIds, ['opp-create-happy', 'promote-blocked']);
  // Omitted → empty list, never undefined.
  const d2 = classifyTurn([{ name: 'finish', input: { summary: 's', acceptance: ['a'], assumptions: { verified: [], assumed: [] } } }]);
  assert.deepEqual(d2.finishAcceptanceIds, []);
  // The schema advertises the machine-execution contract on the finish tool.
  const finishTool = RUNNER_TOOLS.find((t) => t.name === 'finish');
  assert.ok(finishTool.input_schema.properties.acceptance_ids);
  assert.match(finishTool.input_schema.properties.acceptance_ids.description, /hard smoke failure/);
});

test('transient model errors are classified for the auto-retry (dropped stream, overload — not timeouts/4xx)', async () => {
  const { isTransientModelError } = await import('../mock2/model-client.js');
  assert.equal(isTransientModelError('model call failed: terminated'), true);
  assert.equal(isTransientModelError('model call failed: fetch failed'), true);
  assert.equal(isTransientModelError('read ECONNRESET'), true);
  assert.equal(isTransientModelError('anthropic HTTP 529: overloaded_error'), true);
  assert.equal(isTransientModelError('anthropic HTTP 500: internal'), true);
  assert.equal(isTransientModelError('anthropic HTTP 429: rate limited'), true);
  assert.equal(isTransientModelError('anthropic HTTP 400: invalid_request_error'), false);
  assert.equal(isTransientModelError('timed out after 300s waiting for the model response (the request was cancelled server-side)'), false);
  assert.equal(isTransientModelError('unsupported provider "x"'), false);
  assert.equal(isTransientModelError(''), false);
});
