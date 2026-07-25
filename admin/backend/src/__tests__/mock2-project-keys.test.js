// Per-project / per-user provider API keys — the PURE precedence + permission
// layer. Native-free (no DB, no crypto): the store does the I/O, this decides.
//
// The rule under test, in one line: a user's own key beats the project key,
// which beats the global connector key — and a personal key is NEVER spent by
// anyone but its owner.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  selectKeyRow, resolveKeySource, canManageKey, visibleKeyRows, publicKeyShape,
  keyHint, isKeyScope, isKeyProvider, KEY_PROVIDERS,
} from '../mock2/project-keys-logic.js';

// Realistic fixtures: the hint is genuinely the last 4 of the secret, so the
// "never serialize the secret" assertion below is meaningful rather than tripping
// over a 4-character fake key that IS its own hint.
const PROJECT_SECRET = 'sk-ant-project-aaaa1111';
const MY_SECRET = 'sk-ant-personal-bbbb2222';
const OTHER_SECRET = 'sk-ant-someone-cccc3333';
const projKey = { id: 1, scope: 'project', user_id: null, provider: 'anthropic', api_key: PROJECT_SECRET, key_hint: '••••1111' };
const myKey = { id: 2, scope: 'user', user_id: 7, provider: 'anthropic', api_key: MY_SECRET, key_hint: '••••2222' };
const otherKey = { id: 3, scope: 'user', user_id: 9, provider: 'anthropic', api_key: OTHER_SECRET, key_hint: '••••3333' };

test('precedence: user key > project key > global', () => {
  // 1. only a global key
  assert.equal(resolveKeySource([], { provider: 'anthropic', userId: 7, globalKey: 'GLOBAL' }).source, 'global');
  assert.equal(resolveKeySource([], { provider: 'anthropic', userId: 7, globalKey: 'GLOBAL' }).apiKey, 'GLOBAL');

  // 2. a project key wins over the global one, for everyone
  const withProject = resolveKeySource([projKey], { provider: 'anthropic', userId: 7, globalKey: 'GLOBAL' });
  assert.equal(withProject.source, 'project');
  assert.equal(withProject.apiKey, PROJECT_SECRET);

  // 3. the acting user's own key wins over both
  const withMine = resolveKeySource([projKey, myKey], { provider: 'anthropic', userId: 7, globalKey: 'GLOBAL' });
  assert.equal(withMine.source, 'user');
  assert.equal(withMine.apiKey, MY_SECRET);
});

test("a personal key is never spent on someone else's build", () => {
  // User 9 has a key; user 7 builds. User 7 must fall through to the project key.
  const asSeven = resolveKeySource([projKey, otherKey], { provider: 'anthropic', userId: 7, globalKey: 'GLOBAL' });
  assert.equal(asSeven.source, 'project');
  assert.equal(asSeven.apiKey, PROJECT_SECRET);

  // With no project key it falls all the way through to global — never THEIRS.
  const noProject = resolveKeySource([otherKey], { provider: 'anthropic', userId: 7, globalKey: 'GLOBAL' });
  assert.equal(noProject.source, 'global');
  assert.notEqual(noProject.apiKey, OTHER_SECRET);

  // And user 9 does get their own.
  assert.equal(resolveKeySource([projKey, otherKey], { provider: 'anthropic', userId: 9 }).apiKey, OTHER_SECRET);
});

test('keys are provider-scoped: an anthropic key never answers for openai', () => {
  const rows = [projKey, myKey];
  assert.equal(selectKeyRow(rows, { provider: 'openai', userId: 7 }), null);
  const openai = resolveKeySource(rows, { provider: 'openai', userId: 7, globalKey: 'GLOBAL_OPENAI' });
  assert.equal(openai.source, 'global');
  assert.equal(openai.apiKey, 'GLOBAL_OPENAI');
});

test('no key anywhere → an explicit none (never a silent null key)', () => {
  const r = resolveKeySource([], { provider: 'anthropic', userId: 7, globalKey: null });
  assert.equal(r.source, 'none');
  assert.equal(r.apiKey, null);
});

test('an anonymous/system call (no user) still gets the project key', () => {
  const r = resolveKeySource([projKey, myKey], { provider: 'anthropic', userId: null, globalKey: 'GLOBAL' });
  assert.equal(r.source, 'project'); // never someone's personal key
});

test('permissions: project-wide key needs editor/admin; a personal key is your own', () => {
  // Project scope — it changes what EVERY member's builds bill to.
  assert.equal(canManageKey({ scope: 'project' }, { userId: 7, role: 'viewer' }).ok, false);
  assert.equal(canManageKey({ scope: 'project' }, { userId: 7, role: 'editor' }).ok, true);
  assert.equal(canManageKey({ scope: 'project' }, { userId: 7, role: 'viewer', isAdmin: true }).ok, true);

  // User scope — any member may set their OWN.
  assert.equal(canManageKey({ scope: 'user', targetUserId: 7 }, { userId: 7, role: 'viewer' }).ok, true);
  // ...but not someone else's.
  assert.equal(canManageKey({ scope: 'user', targetUserId: 9 }, { userId: 7, role: 'editor' }).ok, false);
  // An admin may remove another user's key (cleanup) — deleting, never reading.
  const adminOther = canManageKey({ scope: 'user', targetUserId: 9 }, { userId: 7, role: 'editor', isAdmin: true });
  assert.equal(adminOther.ok, true);
  assert.equal(adminOther.adminActingOnOther, true);

  assert.equal(canManageKey({ scope: 'nonsense' }, { userId: 7, role: 'editor' }).ok, false);
});

test('visibility: you see the project key and your own; an admin sees existence only', () => {
  const rows = [projKey, myKey, otherKey];
  const seven = visibleKeyRows(rows, { userId: 7 }).map((r) => r.id);
  assert.deepEqual(seven, [1, 2]); // project + mine, NOT user 9's

  const admin = visibleKeyRows(rows, { userId: 7, isAdmin: true }).map((r) => r.id);
  assert.deepEqual(admin, [1, 2, 3]);
});

test('the public shape never carries the secret', () => {
  const shaped = publicKeyShape({ ...myKey, api_key_enc: 'CIPHERTEXT', created_at: 't' }, { userId: 7 });
  const json = JSON.stringify(shaped);
  assert.ok(!json.includes(MY_SECRET), 'plaintext key must never be serialized');
  assert.ok(!json.includes('CIPHERTEXT'), 'ciphertext must never be serialized');
  assert.equal(shaped.key_hint, '••••2222');
  assert.equal(shaped.mine, true);
  // Someone else's row is not "mine".
  assert.equal(publicKeyShape(otherKey, { userId: 7 }).mine, false);
});

test('keyHint reveals only the last 4 characters', () => {
  assert.equal(keyHint('sk-ant-super-secret-1234'), '••••1234');
  assert.equal(keyHint('abc'), '••••'); // too short to hint safely
  assert.equal(keyHint(''), '••••');
  assert.ok(!keyHint('sk-ant-super-secret-1234').includes('super'));
});

test('scope/provider validators are closed sets', () => {
  assert.ok(isKeyScope('project') && isKeyScope('user'));
  assert.ok(!isKeyScope('global') && !isKeyScope(''));
  for (const p of KEY_PROVIDERS) assert.ok(isKeyProvider(p));
  assert.ok(!isKeyProvider('bring-your-own'));
});
