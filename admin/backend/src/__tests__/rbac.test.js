// Three-tier RBAC tests (ADR-011) — the effective-role mapping, the Zod-token
// → { role, is_superadmin } translation, the generalised superadmin guards, the
// developer-or-above predicate, and the Mock2 access resolution for a developer
// (role='developer') vs an admin bypass vs a pending (no-role) account.
//
// Stub-first (risk R9 / docs/known-issues.md): imports ONLY the pure decision
// modules (lib/roles.js, lib/superadmin.js, mock2/project-logic.js). None pulls
// in better-sqlite3, Express, or the DB, so the suite never worsens the
// fresh-checkout native-module gap. The route-level enforcement (last-superadmin
// count, pending 403s, getAccessibleServices=[], a developer creating a project
// and adding a member) is built directly on these predicates and is exercised by
// the manual RBAC verification checklist, not here.

import test from 'node:test';
import assert from 'node:assert/strict';

import { effectiveRole, roleToColumns, isDeveloperOrAbove } from '../lib/roles.js';
import { checkSuperadminProtection, checkSuperadminGrant } from '../lib/superadmin.js';
import { resolveMock2Access } from '../mock2/project-logic.js';

// ---- effectiveRole: all four states ----

test('effectiveRole: role=admin + is_superadmin=1 → superadmin', () => {
  assert.equal(effectiveRole({ role: 'admin', is_superadmin: 1 }), 'superadmin');
  assert.equal(effectiveRole({ role: 'admin', is_superadmin: true }), 'superadmin');
});

test('effectiveRole: role=admin + is_superadmin=0 → admin', () => {
  assert.equal(effectiveRole({ role: 'admin', is_superadmin: 0 }), 'admin');
  assert.equal(effectiveRole({ role: 'admin' }), 'admin');
});

test('effectiveRole: role=developer → developer (and legacy user tolerated)', () => {
  assert.equal(effectiveRole({ role: 'developer', is_superadmin: 0 }), 'developer');
  assert.equal(effectiveRole({ role: 'user' }), 'developer'); // pre-migration snapshot
});

test('effectiveRole: role=pending / unknown / missing → pending', () => {
  assert.equal(effectiveRole({ role: 'pending' }), 'pending');
  assert.equal(effectiveRole({ role: 'wat' }), 'pending');
  assert.equal(effectiveRole({}), 'pending');
  assert.equal(effectiveRole(), 'pending');
});

// a developer flag is never elevated to superadmin by a stray is_superadmin bit
test('effectiveRole: is_superadmin only matters for an admin role', () => {
  assert.equal(effectiveRole({ role: 'developer', is_superadmin: 1 }), 'developer');
  assert.equal(effectiveRole({ role: 'pending', is_superadmin: 1 }), 'pending');
});

// ---- roleToColumns: the Zod-token → { role, is_superadmin } translation ----

test('roleToColumns: every token maps to the right column pair', () => {
  assert.deepEqual(roleToColumns('superadmin'), { role: 'admin', is_superadmin: 1 });
  assert.deepEqual(roleToColumns('admin'), { role: 'admin', is_superadmin: 0 });
  assert.deepEqual(roleToColumns('developer'), { role: 'developer', is_superadmin: 0 });
  assert.deepEqual(roleToColumns('pending'), { role: 'pending', is_superadmin: 0 });
  assert.equal(roleToColumns('nonsense'), null);
});

test('roleToColumns then effectiveRole round-trips', () => {
  for (const token of ['superadmin', 'admin', 'developer', 'pending']) {
    assert.equal(effectiveRole(roleToColumns(token)), token);
  }
});

// ---- isDeveloperOrAbove: pending denied, everyone else allowed ----

test('isDeveloperOrAbove: admin/developer allowed, pending denied', () => {
  assert.equal(isDeveloperOrAbove({ role: 'admin' }), true);       // covers superadmin too (role=admin)
  assert.equal(isDeveloperOrAbove({ role: 'developer' }), true);
  assert.equal(isDeveloperOrAbove({ role: 'pending' }), false);
  assert.equal(isDeveloperOrAbove({}), false);
});

// ---- checkSuperadminProtection: admin cannot touch a superadmin ----

test('checkSuperadminProtection: a non-superadmin cannot modify a superadmin', () => {
  const r = checkSuperadminProtection({ actorIsSuperadmin: false, targetIsSuperadmin: true, action: 'modify' });
  assert.equal(r.allowed, false);
  assert.match(r.error, /superadmin/i);
});

test('checkSuperadminProtection: a superadmin may act on a superadmin', () => {
  assert.equal(
    checkSuperadminProtection({ actorIsSuperadmin: true, targetIsSuperadmin: true, action: 'delete' }).allowed,
    true,
  );
});

test('checkSuperadminProtection: anyone may act on a non-superadmin target', () => {
  assert.equal(
    checkSuperadminProtection({ actorIsSuperadmin: false, targetIsSuperadmin: false, action: 'modify' }).allowed,
    true,
  );
});

// ---- checkSuperadminGrant: only a superadmin grants superadmin ----

test('checkSuperadminGrant: a non-superadmin cannot grant superadmin', () => {
  const r = checkSuperadminGrant({ actorIsSuperadmin: false, grantingSuperadmin: true });
  assert.equal(r.allowed, false);
  assert.match(r.error, /superadmin/i);
});

test('checkSuperadminGrant: a superadmin may grant superadmin; non-grants always pass', () => {
  assert.equal(checkSuperadminGrant({ actorIsSuperadmin: true, grantingSuperadmin: true }).allowed, true);
  assert.equal(checkSuperadminGrant({ actorIsSuperadmin: false, grantingSuperadmin: false }).allowed, true);
});

// ---- Mock2 access: developer is membership-only; admin bypasses; pending denied ----

test('resolveMock2Access: a developer editor may edit a project they belong to', () => {
  const dev = { id: 2, role: 'developer' };
  const r = resolveMock2Access({ user: dev, membership: { role: 'editor' }, requiredRole: 'editor' });
  assert.equal(r.allowed, true);
  assert.equal(r.actingAsAdmin, false);
});

test('resolveMock2Access: a developer non-member is denied (no admin bypass)', () => {
  const dev = { id: 2, role: 'developer' };
  const r = resolveMock2Access({ user: dev, membership: null, requiredRole: 'viewer' });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'not a project member');
});

test('resolveMock2Access: an admin bypasses membership, stamped acting_as_admin', () => {
  const admin = { id: 1, role: 'admin' };
  const r = resolveMock2Access({ user: admin, membership: null, requiredRole: 'editor' });
  assert.equal(r.allowed, true);
  assert.equal(r.actingAsAdmin, true);
});

test('resolveMock2Access: a pending account is denied like any non-member', () => {
  const pending = { id: 5, role: 'pending' };
  const r = resolveMock2Access({ user: pending, membership: null, requiredRole: 'viewer' });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'not a project member');
});
