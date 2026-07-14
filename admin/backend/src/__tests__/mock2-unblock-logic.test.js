// Human feedback / unblock channels: the pure wire formats that carry operator
// context into a resumed cycle, present scoped authorizations, and record an
// approve-as-edited deviation. These are the audit-visible artifacts the four
// channels produce, so pin them. Native-free.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseHaltOptions, resolveSelectedOption, buildResumeContextBlock,
  buildAuthorizationBlock, approveAsEditedText, validateAuthScope, HALT_OPTION_LIMIT,
} from '../mock2/unblock-logic.js';

test('parseHaltOptions: normalizes strings + objects, assigns stable ids, caps count', () => {
  const opts = parseHaltOptions([
    'Delete the stale test user row',
    { label: 'Change the test to create its own user', detail: 'no shared state' },
    { id: 'skip', title: 'Skip the auth test for now' },
    '', null, 42,
  ]);
  assert.equal(opts[0].label, 'Delete the stale test user row');
  assert.ok(opts[0].id.startsWith('opt-1-'));
  assert.equal(opts[1].detail, 'no shared state');
  assert.equal(opts[2].id, 'skip');
  assert.equal(opts.length, 3); // blanks/non-strings dropped
});

test('parseHaltOptions: caps at HALT_OPTION_LIMIT', () => {
  const many = Array.from({ length: 20 }, (_, i) => `option ${i}`);
  assert.equal(parseHaltOptions(many).length, HALT_OPTION_LIMIT);
});

test('resolveSelectedOption: matches by id or label, else synthesizes free-text', () => {
  const options = parseHaltOptions(['Delete the row', 'Rewrite the test']);
  assert.equal(resolveSelectedOption(options, options[0].id).label, 'Delete the row');
  assert.equal(resolveSelectedOption(options, 'Rewrite the test').label, 'Rewrite the test');
  assert.equal(resolveSelectedOption(options, 'do something else').id, 'free');
  assert.equal(resolveSelectedOption(options, '   '), null);
});

test('buildResumeContextBlock: empty when nothing given (a bare resume stays bare)', () => {
  assert.equal(buildResumeContextBlock({}), '');
  assert.equal(buildResumeContextBlock({ message: '   ' }), '');
});

test('buildResumeContextBlock: labels operator guidance, choice, and authorizations', () => {
  const block = buildResumeContextBlock({
    message: 'the test artifact is safe to remove',
    selectedOption: { id: 'del', label: 'Delete the stale test user row', detail: 'id 1 only' },
    authorizations: [{ scope: 'DELETE FROM users WHERE email = \'seed@test\'', conditions: 'exactly one row' }],
  });
  assert.match(block, /Operator guidance on resume \(AUTHORITATIVE/);
  assert.match(block, /Chosen resolution: Delete the stale test user row — id 1 only/);
  assert.match(block, /Operator message: the test artifact is safe to remove/);
  assert.match(block, /Authorized one-time operations/);
  assert.match(block, /DELETE FROM users WHERE email/);
  assert.match(block, /\[conditions: exactly one row\]/);
});

test('buildAuthorizationBlock: single-use, scoped-exactly wording; empty when none', () => {
  assert.equal(buildAuthorizationBlock([]), '');
  const b = buildAuthorizationBlock([{ scope: 'TRUNCATE users_test' }]);
  assert.match(b, /single-use and scoped EXACTLY/);
  assert.match(b, /- TRUNCATE users_test/);
});

test('approveAsEditedText: edited text + conditions become the authoritative record', () => {
  const r = approveAsEditedText({
    originalText: 'Use password login instead of SSO',
    editedText: 'Use password + TOTP login instead of SSO',
    conditions: 'rate-limit the login route',
  });
  assert.match(r.text, /password \+ TOTP/);
  assert.match(r.text, /Conditions: rate-limit the login route/);
  assert.match(r.resolutionNote, /approved as edited; conditions:/);
  assert.equal(r.edited, true);
});

test('approveAsEditedText: no edits → original text, plain approved', () => {
  const r = approveAsEditedText({ originalText: 'Allow a login page' });
  assert.equal(r.text, 'Allow a login page');
  assert.equal(r.resolutionNote, 'approved');
  assert.equal(r.edited, false);
});

test('validateAuthScope: requires a non-empty bounded scope', () => {
  assert.equal(validateAuthScope('').ok, false);
  assert.equal(validateAuthScope('DELETE FROM users WHERE id = 1').ok, true);
  assert.equal(validateAuthScope('x'.repeat(2100)).ok, false);
});
