// The design stage LOOKING at its own mockup — the pure halves: riding the
// rendered screenshots on the transcript's last user turn, and the system
// prompt telling the design partner to actually review them. The capture
// itself (mockup-screenshot.js) is a browser and stays out of unit tests.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  attachRenderedMockupShots, buildConceptTranscript, buildConceptChatSystemPrompt,
} from '../mock2/concept-logic.js';

const SHOTS = [
  { media_type: 'image/jpeg', data: 'ZGVza3RvcA==', width: 1280 },
  { media_type: 'image/jpeg', data: 'bW9iaWxl', width: 390 },
];

test('attachRenderedMockupShots: shots + label land on the LAST user turn only', () => {
  const t = buildConceptTranscript([
    { kind: 'user', body: 'make me a notes app' },
    { kind: 'assistant', body: 'here is the first mockup' },
    { kind: 'user', body: 'the sidebar icons are huge', images: [{ media_type: 'image/png', data: 'cGlu' }] },
  ]);
  attachRenderedMockupShots(t, SHOTS);
  // Earlier turns untouched (the cached prefix must stay byte-identical).
  assert.equal(t[0].text, 'make me a notes app');
  assert.equal(t[0].images, undefined);
  // Last user turn: existing attachments kept, shots appended, label present.
  const last = t[2];
  assert.equal(last.images.length, 3);
  assert.equal(last.images[0].data, 'cGlu');
  assert.equal(last.images[1].data, 'ZGVza3RvcA==');
  assert.match(last.text, /CURRENT mockup as actually rendered/);
  assert.match(last.text, /1280px, 390px/);
  assert.match(last.text, /^the sidebar icons are huge/);
});

test('attachRenderedMockupShots: no shots or no user turn → transcript unchanged', () => {
  const t = buildConceptTranscript([{ kind: 'user', body: 'hi' }]);
  const before = JSON.stringify(t);
  attachRenderedMockupShots(t, []);
  assert.equal(JSON.stringify(t), before);
  const assistantOnly = [{ role: 'assistant', text: 'hello' }];
  attachRenderedMockupShots(assistantOnly, SHOTS);
  assert.equal(assistantOnly[0].images, undefined);
});

test('system prompt: the rendered-mockup review block rides only when shots do', () => {
  const withShots = buildConceptChatSystemPrompt({ hasMockup: true, reviewShots: true });
  assert.match(withShots, /RENDERED-MOCKUP REVIEW/);
  assert.match(withShots, /fix them in the next render even when the Builder did\nnot mention them/);
  const without = buildConceptChatSystemPrompt({ hasMockup: true });
  assert.doesNotMatch(without, /RENDERED-MOCKUP REVIEW/);
  // Plan mode gets the block too — the design-stage chat is one conversation,
  // and "what does the current screen do" is a plan-mode question.
  const plan = buildConceptChatSystemPrompt({ hasMockup: true, mode: 'plan', reviewShots: true });
  assert.match(plan, /RENDERED-MOCKUP REVIEW/);
});
