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
  // Shown in the UI as a button AND said in the text, because the text is also
  // what gets copied and saved — a note that leaves the chat should still tell
  // the reader there was something to press.
  const m = message();
  assert.match(m, /Fix these/);
  assert.match(m, /untick anything you disagree with/);
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

test('RATCHET: the note opens a dialog, and the dialog can do all three things', () => {
  const note = readFileSync(new URL('../../../frontend/src/components/mock2/chat-messages.jsx', import.meta.url), 'utf8');
  assert.match(note, /Fix these/, 'the note carries the action');
  assert.match(note, /FindingsCard/, 'and renders the findings as a list rather than a blob');

  const dlg = readFileSync(new URL('../../../frontend/src/components/mock2/FixFindingsDialog.jsx', import.meta.url), 'utf8');
  assert.match(dlg, /type="checkbox"/, 'a tick per finding, so one can be dropped');
  assert.match(dlg, /<textarea/, 'somewhere to say anything else');
  assert.match(dlg, /ImageAttachmentBar/, 'and images — a photo of the real screen says what a paragraph cannot');
  assert.match(dlg, /composeFixInstruction\(picked, note\)/,
    'the instruction must come from what SURVIVED the ticking, not from the message');

  // The old path was a real bug: distill-prompt rejects system notes outright.
  const chat = readFileSync(new URL('../../../frontend/src/components/mock2/BuildChat.jsx', import.meta.url), 'utf8');
  assert.match(chat, /const sendFix = async/);
  assert.doesNotMatch(
    chat.slice(chat.indexOf('const sendFix'), chat.indexOf('const sendFix') + 900),
    /mock2DistillPrompt/,
    'fixing findings must not go through the distiller — it only accepts Ask answers, and it would discard the ticking',
  );
});
