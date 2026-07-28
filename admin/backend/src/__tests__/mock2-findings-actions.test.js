// THE FINDINGS NOTE IS A TO-DO LIST, AND HAS TO BE ACTIONABLE AS ONE.
//
// "Please also present the findings, ask/make suggestions, offer a quick update
//  from that specific chat / and an 'Update and Input' where they specify
//  anything else."
//
// Every other system note in the chat is status — the base app deployed, three
// screen accounts were created. There is nothing to do with them but read them.
// The design review is the opposite: seven numbered defects, each with the fix
// already written next to it, and the only way to act on any of them was to
// read the list, decide which mattered, and re-type an instruction into the
// composer by hand.
//
// The chat tells the two apart by the message's opening words, which means the
// backend's wording and the frontend's test have to agree. That is what this
// file holds still.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { reviewChatMessage, REVIEW_MESSAGE_PREFIX } from '../mock2/design-review-logic.js';

const FINDINGS = [
  { severity: 'high', screen: '/admin@390', issue: 'the users table breaks on mobile', fix: 'collapse it to cards below 640px' },
  { severity: 'medium', screen: '/login@1280', issue: 'footer links are illegible', fix: 'use var(--accent)' },
];

const message = (over = {}) => reviewChatMessage({
  review: { summary: 'Core screens are close to the contract.', findings: FINDINGS },
  screenshotCount: 6,
  ...over,
});

test('both review labels start with the prefix the chat keys on', () => {
  for (const trigger of ['auto', 'manual']) {
    const m = message({ trigger });
    assert.ok(
      m.startsWith(REVIEW_MESSAGE_PREFIX),
      `a ${trigger} review must be recognisable as a findings note — got: ${m.slice(0, 40)}`,
    );
  }
});

test('RATCHET: the frontend tests for exactly that prefix', () => {
  // Two files, one string. If the label here ever changes to "Screen check
  // results", the buttons silently stop appearing and the note goes back to
  // being a wall of text nobody can act on.
  const src = readFileSync(new URL('../../../frontend/src/components/mock2/chat-messages.jsx', import.meta.url), 'utf8');
  const m = /export function isFindingsNote\(body\) \{\s*return (\/[^\n]+\/)\.test/.exec(src);
  assert.ok(m, 'the frontend must expose isFindingsNote with a literal regex this test can read');
  // Reconstruct the frontend's regex and run it against the real message.
  const body = m[1].replace(/\\\\\(/g, '\\(');
  const re = new RegExp(body.slice(1, body.lastIndexOf('/')));
  assert.ok(re.test(message()), 'the frontend regex must match a real review message');
  assert.ok(!re.test('Created 3 screen accounts (admin-n8@fixture.invalid).'),
    'and must NOT match ordinary status notes, or every one of them sprouts a Fix button');
  assert.ok(!re.test('The base app deployed.'));
});

test('the message says what to do about it, in its own words', () => {
  // Shown in the UI as buttons AND said in the text, because the text is also
  // what gets copied and saved — a note that leaves the chat should still tell
  // the reader there was something to press.
  const m = message();
  assert.match(m, /Fix these/);
  assert.match(m, /Fix \+ add a note/);
  assert.match(m, /what to leave alone/);
});

test('a clean review does not invite a build that has nothing to do', () => {
  const clean = reviewChatMessage({ review: { summary: 'No findings.', findings: [] }, screenshotCount: 4 });
  assert.doesNotMatch(clean, /Fix these/);
  assert.ok(clean.startsWith(REVIEW_MESSAGE_PREFIX), 'still a findings note — the buttons just have nothing to run');
});

test('accessibility or adherence findings alone still earn the invitation', () => {
  // The critique can come back empty while axe reports six serious issues, or
  // while the adherence check reports drift. Those are just as actionable.
  const axeOnly = reviewChatMessage({
    review: { summary: 'Looks fine.', findings: [] },
    axe: [{ impact: 'critical', page: '/admin', help: 'Form elements must have labels', id: 'label' }],
    screenshotCount: 4,
  });
  assert.match(axeOnly, /Fix these/);

  const adherenceOnly = reviewChatMessage({
    review: { summary: 'Looks fine.', findings: [] },
    adherence: { findings: [{ severity: 'medium', code: 'TOKENDRIFT', detail: '10/58 variables' }] },
    screenshotCount: 4,
  });
  assert.match(adherenceOnly, /Fix these/);
});

test('RATCHET: the note actually renders both actions and the note field', () => {
  const src = readFileSync(new URL('../../../frontend/src/components/mock2/chat-messages.jsx', import.meta.url), 'utf8');
  assert.match(src, /Fix these/, 'the quick-update action');
  assert.match(src, /Fix \+ add a note/, 'the "Update and input" action');
  assert.match(src, /<textarea/, 'and somewhere to type the anything-else');
  // The extra note must reach the build, not be collected and dropped.
  const chat = readFileSync(new URL('../../../frontend/src/components/mock2/BuildChat.jsx', import.meta.url), 'utf8');
  assert.match(chat, /quickUpdateFromMessage = async \(m, extra = ''\)/);
  assert.match(chat, /this wins where it disagrees/,
    'a note that cannot override the findings is not worth typing');
});
