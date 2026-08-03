// Human feedback / unblock channels: the pure wire formats that carry operator
// context into a resumed cycle, present scoped authorizations, and record an
// approve-as-edited deviation. These are the audit-visible artifacts the four
// channels produce, so pin them. Native-free.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseHaltOptions, resolveSelectedOption, buildResumeContextBlock,
  buildAuthorizationBlock, approveAsEditedText, validateAuthScope, HALT_OPTION_LIMIT,
  validateHaltOptions, haltOptionRequiresAdmin, haltOptionCarriesAuthorization,
  HALT_OPTION_KINDS,
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
  const free = resolveSelectedOption(options, 'do something else');
  assert.equal(free.id, 'free');
  assert.equal(free.kind, 'expand_scope'); // free-text is a neutral expand_scope
  assert.equal(free.authorization, null);
  assert.equal(resolveSelectedOption(options, '   '), null);
});

test('parseHaltOptions: enriched shape — typed kind, risk, injectOnResume, inline authorization', () => {
  const opts = parseHaltOptions([
    {
      label: 'Grant the one-row DELETE', kind: 'grant_authorization', recommended: true,
      risk: 'deletes 1 stale test row from the live DB', injectOnResume: 'You may run the DELETE, once.',
      authorization: { scope: "DELETE FROM users WHERE email = 'seed@test'", expectedRows: 1 },
    },
    { label: 'Run the framework isolation cycle first, then resume', kind: 'run_dependency_first', risk: 'slower' },
    { label: 'Abandon this change', kind: 'abandon' },
  ]);
  assert.equal(opts.length, 3);
  assert.equal(opts[0].kind, 'grant_authorization');
  assert.equal(opts[0].recommended, true);
  assert.equal(opts[0].risk, 'deletes 1 stale test row from the live DB');
  assert.equal(opts[0].injectOnResume, 'You may run the DELETE, once.');
  assert.equal(opts[0].authorization.scope, "DELETE FROM users WHERE email = 'seed@test'");
  assert.equal(opts[0].authorization.expectedRows, '1');
  assert.equal(opts[1].kind, 'run_dependency_first');
  assert.equal(opts[2].kind, 'abandon');
});

test('parseHaltOptions: tolerant kind coercion + at most one recommended', () => {
  const opts = parseHaltOptions([
    { label: 'Override the rule', kind: 'override_rule (admin)', recommended: true },
    { label: 'Just give up', recommended: true }, // 2nd recommended is dropped; label infers abandon
    { label: 'Let me widen it', scope: 'ALTER TABLE x ADD COLUMN y' }, // top-level scope ⇒ grant_authorization
  ]);
  assert.equal(opts[0].kind, 'override_rule'); // " (admin)" suffix stripped
  assert.equal(opts[0].recommended, true);
  assert.equal(opts[1].kind, 'abandon'); // inferred from label
  assert.equal(opts[1].recommended, false); // only the first recommended sticks
  assert.equal(opts[2].kind, 'grant_authorization'); // inferred from an inline scope
  assert.ok(HALT_OPTION_KINDS.includes(opts[2].kind));
});

test('validateHaltOptions: needs ≥2 options; grant/override kinds need an exact scope', () => {
  assert.equal(validateHaltOptions([]).ok, false);
  assert.equal(validateHaltOptions(['only one']).ok, false);
  // grant_authorization option missing a scope is rejected (operator must see the exact op)
  const noScope = validateHaltOptions([
    { label: 'Grant it', kind: 'grant_authorization' },
    { label: 'Abandon', kind: 'abandon' },
  ]);
  assert.equal(noScope.ok, false);
  assert.match(noScope.error, /exact authorization scope/);
  // a well-formed ADP-shaped halt validates
  const ok = validateHaltOptions([
    { label: 'Grant the one-row DELETE', kind: 'grant_authorization', authorization: { scope: 'DELETE FROM users WHERE id = 1', expectedRows: 1 }, recommended: true },
    { label: 'Run the framework isolation cycle first, then resume', kind: 'run_dependency_first' },
    { label: 'Abandon', kind: 'abandon' },
  ]);
  assert.equal(ok.ok, true);
  assert.equal(ok.options.length, 3);
});

test('haltOptionRequiresAdmin + haltOptionCarriesAuthorization', () => {
  assert.equal(haltOptionRequiresAdmin('grant_authorization'), true);
  assert.equal(haltOptionRequiresAdmin('override_rule'), true);
  assert.equal(haltOptionRequiresAdmin('run_dependency_first'), false);
  assert.equal(haltOptionRequiresAdmin('abandon'), false);
  assert.equal(haltOptionCarriesAuthorization({ kind: 'grant_authorization', authorization: { scope: 'DELETE ...' } }), true);
  assert.equal(haltOptionCarriesAuthorization({ kind: 'grant_authorization', authorization: null }), false);
  assert.equal(haltOptionCarriesAuthorization({ kind: 'run_dependency_first', authorization: { scope: 'x' } }), false);
});

test('buildResumeContextBlock: injects the chosen option kind + its injectOnResume text', () => {
  const block = buildResumeContextBlock({
    selectedOption: {
      id: 'g', label: 'Grant the one-row DELETE', kind: 'grant_authorization',
      detail: 'deletes 1 row', injectOnResume: 'You are authorized to run the DELETE below, once.',
    },
    authorizations: [{ scope: "DELETE FROM users WHERE email = 'seed@test'", conditions: null }],
  });
  assert.match(block, /Chosen resolution \[grant_authorization\]: Grant the one-row DELETE — deletes 1 row/);
  assert.match(block, /You are authorized to run the DELETE below, once\./);
  assert.match(block, /Authorized one-time operations/);
});

test('buildResumeContextBlock: empty when nothing given (a bare resume stays bare)', () => {
  assert.equal(buildResumeContextBlock({}), '');
  assert.equal(buildResumeContextBlock({ message: '   ' }), '');
});

// ---- D1.4: the "verified, don't re-derive" framing line ----

test('a verified halt summary gets the "do not re-derive" framing line', () => {
  const block = buildResumeContextBlock({
    lastCheckpoint: { seq: 12, summary: 'halt: no progress\n\n3/4 gates passed on the checkpointed tree — failing: rule-coverage' },
  });
  assert.match(block, /Last checkpoint before this resume \(change record 12\):/);
  assert.match(block, /This was verified against the tree before the halt — do not re-derive what it already confirms\./);
});

test('an unverified (pre-fix-shaped) summary does NOT get the framing line', () => {
  const block = buildResumeContextBlock({
    lastCheckpoint: { seq: 9, summary: 'halt: the build reported it was blocked' },
  });
  assert.match(block, /Last checkpoint before this resume \(change record 9\):/);
  assert.doesNotMatch(block, /do not re-derive what it already confirms/);
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
