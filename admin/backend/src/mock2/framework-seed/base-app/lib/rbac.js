'use strict';
const store = require('./store');

// Permission catalog (machine keys + human labels)
const PERMISSIONS = [
  { key: 'portal.view',    label: 'View credentialing portal', group: 'Portal' },
  { key: 'portal.submit',  label: 'Submit / edit own documents', group: 'Portal' },
  { key: 'portal.review',  label: 'Review, approve & request fixes', group: 'Portal' },
  { key: 'internal.review', label: 'Review employee credentialing', group: 'Portal' },
  { key: 'users.view',     label: 'View users', group: 'Administration' },
  { key: 'users.manage',   label: 'Assign roles, activate/deactivate users', group: 'Administration' },
  { key: 'roles.view',     label: 'View roles', group: 'Administration' },
  { key: 'roles.manage',   label: 'Create / edit / delete roles', group: 'Administration' },
  { key: 'perms.manage',   label: 'Edit permission overrides', group: 'Administration' },
  { key: 'ldap.manage',    label: 'Manage LDAP / directory settings', group: 'Administration' },
  { key: 'smtp.manage',    label: 'Manage email (SMTP) settings', group: 'Administration' },
  { key: 'catalog.manage', label: 'Manage document catalog (sections & documents)', group: 'Administration' },
  { key: 'audit.view',     label: 'View audit log', group: 'Administration' }
];

// Baseline roles with lifecycle flags.
const BASELINE_ROLES = [
  { key: 'admin',     label: 'Administrator', system: true,  editable: false, deletable: false },
  { key: 'staff',     label: 'Staff',         system: true,  editable: true,  deletable: false },
  { key: 'manager',   label: 'Manager',       system: false, editable: true,  deletable: true },
  { key: 'payroll',   label: 'Payroll',       system: false, editable: true,  deletable: true },
  { key: 'physician', label: 'Physician',     system: false, editable: true,  deletable: true }
];

const ALL = PERMISSIONS.map(p => p.key);
const DEFAULTS = {
  admin: ALL,
  staff: ['portal.view', 'portal.review', 'users.view', 'audit.view'],
  manager: ['portal.view', 'portal.review', 'users.view', 'users.manage'],
  payroll: ['portal.view', 'audit.view'],
  physician: ['portal.view', 'portal.submit']
};

function seed() {
  const db = store.get();
  if (!db.permissions.length) db.permissions = PERMISSIONS.map(p => ({ ...p }));
  if (!db.roles.length) db.roles = BASELINE_ROLES.map(r => ({ ...r }));
  if (!db.defaultRolePerms.length) {
    const rows = [];
    for (const role of BASELINE_ROLES) {
      const allowed = new Set(DEFAULTS[role.key] || []);
      for (const perm of PERMISSIONS) rows.push({ roleKey: role.key, permKey: perm.key, allowed: allowed.has(perm.key) });
    }
    db.defaultRolePerms = rows;
  }
  // Upgrade path: make sure any newly introduced permissions exist in an
  // already-seeded database, and that every role has a default row for them.
  let changed = false;
  for (const perm of PERMISSIONS) {
    if (!db.permissions.find(p => p.key === perm.key)) { db.permissions.push({ ...perm }); changed = true; }
    for (const role of db.roles) {
      if (!db.defaultRolePerms.find(d => d.roleKey === role.key && d.permKey === perm.key)) {
        const allowed = role.key === 'admin' || (DEFAULTS[role.key] || []).includes(perm.key);
        db.defaultRolePerms.push({ roleKey: role.key, permKey: perm.key, allowed });
        changed = true;
      }
    }
  }
  store.save();
}

function getRole(key) { return store.get().roles.find(r => r.key === key) || null; }
function listRoles() { return store.get().roles.slice(); }
function listPermissions() { return store.get().permissions.slice(); }

// Effective allow: override if present, else default mapping.
function isAllowed(roleKey, permKey) {
  const db = store.get();
  const ov = db.permOverrides.find(o => o.roleKey === roleKey && o.permKey === permKey);
  if (ov) return !!ov.allowed;
  const def = db.defaultRolePerms.find(d => d.roleKey === roleKey && d.permKey === permKey);
  return def ? !!def.allowed : false;
}

// Effective permission set for a user (union across roles).
function effectivePermissions(roleKeys) {
  const set = new Set();
  for (const rk of roleKeys || []) {
    for (const perm of ALL) if (isAllowed(rk, perm)) set.add(perm);
  }
  return [...set];
}

function userCan(user, permKey) {
  if (!user || !user.active) return false;
  return effectivePermissions(user.roles).includes(permKey);
}

// Permissions that mark an account as an internal "team member" (staff/admin/
// management) rather than an external 3rd-party provider (physician). A user is
// a team member if any of their roles grants one of these capabilities.
const TEAM_PERMS = [
  'portal.review', 'internal.review', 'users.view', 'users.manage', 'roles.view', 'roles.manage',
  'perms.manage', 'ldap.manage', 'smtp.manage', 'catalog.manage', 'audit.view'
];
function isTeamRoles(roleKeys) {
  const perms = effectivePermissions(roleKeys);
  return TEAM_PERMS.some(p => perms.includes(p));
}

function effectiveMatrix() {
  const db = store.get();
  return db.roles.map(role => ({
    role: role.key,
    perms: db.permissions.map(p => ({
      key: p.key,
      allowed: isAllowed(role.key, p.key),
      overridden: !!db.permOverrides.find(o => o.roleKey === role.key && o.permKey === p.key),
      default: (db.defaultRolePerms.find(d => d.roleKey === role.key && d.permKey === p.key) || {}).allowed || false
    }))
  }));
}

module.exports = {
  PERMISSIONS, BASELINE_ROLES, ALL, DEFAULTS,
  seed, getRole, listRoles, listPermissions,
  isAllowed, effectivePermissions, userCan, effectiveMatrix, isTeamRoles
};
