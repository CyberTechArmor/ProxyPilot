// The A6 run deck's pure rules (admin/frontend run-deck-logic.js): which live
// frames the Browser pane and the Activity thumbnails show, which panel a phone
// shows, and the activity feed built from the run detail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EMPTY_VIEW, acceptFrame, callSummary, feedOf, firstStepFinishedAt, panelFor }
  from '../../../frontend/src/components/operational-projects/run-deck-logic.js';

const at = seconds => new Date(Date.UTC(2026, 8, 29, 9, 24, seconds)).toISOString();
const frame = (seconds, step, png = `png-${step}`) => ({ png_base64: png, width: 640, height: 400, captured_at: at(seconds), action_count: step });
const step = (ordinal, finished) => ({ ordinal, action: ordinal === 1 ? 'open_landing' : 'open_login', decided_by: 'rule',
  rule: 'start', state: finished ? 'done' : 'reserved', created_at: at(ordinal), finished_at: finished ? at(finished) : null });

test('no frame is shown before step 1 has finished: the browser before its first page is blank', () => {
  assert.equal(firstStepFinishedAt([]), null);
  assert.equal(acceptFrame(EMPTY_VIEW, frame(2, 1), [step(1, null)]), EMPTY_VIEW);
  // Captured before step 1 finished, even when the answer arrives after it.
  assert.equal(acceptFrame(EMPTY_VIEW, frame(4, 1), [step(1, 5)]), EMPTY_VIEW);
  const shown = acceptFrame(EMPTY_VIEW, frame(5, 1), [step(1, 5)]);
  assert.equal(shown.live.captured_at, at(5));
  assert.deepEqual([...shown.thumbs.keys()], [1]);
});

test('a frame identical to the last thumbnail is not attached again; the pane still moves on', () => {
  const steps = [step(1, 3), step(2, 6)];
  let view = acceptFrame(EMPTY_VIEW, frame(4, 1, 'landing'), steps);
  view = acceptFrame(view, frame(7, 2, 'landing'), steps);
  assert.deepEqual([...view.thumbs.keys()], [1], 'the same page after step 2 is not repeated');
  assert.equal(view.live.captured_at, at(7), 'the pane shows the newest capture');
  view = acceptFrame(view, frame(9, 2, 'login'), steps);
  assert.deepEqual([...view.thumbs.keys()], [1, 2]);
  assert.equal(view.thumbs.get(2).png_base64, 'login');
  // A newer, different frame of the same step replaces that step's thumbnail.
  view = acceptFrame(view, frame(11, 2, 'login-settled'), steps);
  assert.equal(view.thumbs.get(2).png_base64, 'login-settled');
  assert.equal(view.thumbs.size, 2);
  assert.equal(EMPTY_VIEW.thumbs.size, 0, 'the empty view is never mutated');
});

test('the phone panel: the one in the URL, else Browser while running and Details after', () => {
  assert.equal(panelFor('activity', true), 'activity');
  assert.equal(panelFor('details', true), 'details');
  assert.equal(panelFor(null, true), 'browser');
  assert.equal(panelFor(null, false), 'details');
  assert.equal(panelFor('terminal', false), 'details');
  assert.equal(panelFor('browser', false), 'browser');
});

test('the feed: frames are not items; a model call a step used is not repeated', () => {
  const call = { call_id: 'c1', step_ordinal: 3, allowed: ['submit_bound_fixture', 'read_files', 'read_workspace'], state: 'chosen',
    choice: 'submit_bound_fixture', refusal_code: null, settled_usd: '0.000004625', prompt_tokens: 212, completion_tokens: 4,
    replayed: false, created_at: at(8) };
  const approval = { id: 'a1', action: 'submit_bound_fixture', digest: '9f2d0085274a244f07e9e45a1f99f101', requested_at: at(9),
    open: true, state: 'requested' };
  const data = { run: { started_at: at(0), started_by: { id: 'u1', username: 'omar-operator' }, profile_name: 'Demo sign-in',
    guide_version_number: 1 }, events: [{ id: 1, kind: 'running', created_at: at(0) }, { id: 2, kind: 'lease_renewed', created_at: at(1) }],
  steps: [step(1, 3), step(2, 6)], model_calls: [call], approvals: [approval], result: null };
  const feed = feedOf(data);
  assert.deepEqual(feed.map(i => i.kind), ['system', 'system', 'rule', 'rule', 'model', 'approval']);
  assert.equal(feed.find(i => i.kind === 'model').body, 'From 3 allowed actions · 216 tokens · $0.000004625');
  const open = feed.find(i => i.kind === 'approval');
  assert.equal(open.open, true);
  assert.equal(open.body, 'Digest 9f2d 0085 274a …');
  // Once the submit step records the call, the call is the step's, not its own item.
  const later = feedOf({ ...data, steps: [...data.steps, { ...step(3, 12), action: 'submit_bound_fixture', decided_by: 'model',
    rule: null, model_call_id: 'c1', created_at: at(11) }], approvals: [{ ...approval, open: false, state: 'consumed',
    decided_at: at(10), decided_by: { id: 'u1', username: 'omar-operator' } }],
  result: { created_at: at(20), result_class: 'verified_account', final_state: 'completed' } });
  assert.deepEqual(later.map(i => i.kind), ['system', 'system', 'rule', 'rule', 'approval', 'person', 'model', 'result']);
  assert.equal(later.find(i => i.kind === 'person').title, 'Approved by omar-operator');
  assert.equal(callSummary(null), 'the allowed actions');
  assert.equal(callSummary({ allowed: ['sign_out'], prompt_tokens: null, completion_tokens: null }), '1 allowed action');
});
