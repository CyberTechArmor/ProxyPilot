'use strict';
const store = require('./store');
const { uuid } = require('./util');
const { hashPassword } = require('./crypto');

function sanitize(u) {
  if (!u) return null;
  const { passwordHash, ...rest } = u;
  return rest;
}
function norm(s) { return String(s || '').trim().toLowerCase(); }

function findByLogin(login) {
  const db = store.get();
  const n = norm(login);
  return db.users.find(u => norm(u.username) === n || norm(u.email) === n) || null;
}
function findById(id) { return store.get().users.find(u => u.id === id) || null; }
// Active roster excludes soft-deleted accounts so they drop out of view for
// current users everywhere listUsers() is consumed (admin, physicians, roster).
function listUsers() { return store.get().users.filter(u => !u.deleted).map(sanitize); }
function listDeleted() { return store.get().users.filter(u => u.deleted).map(sanitize); }

function createUser(data) {
  const db = store.get();
  if (findByLogin(data.username) || (data.email && findByLogin(data.email)))
    throw Object.assign(new Error('USER_EXISTS'), { code: 'USER_EXISTS' });
  const now = new Date().toISOString();
  const user = {
    id: uuid(),
    username: String(data.username).trim(),
    email: data.email ? String(data.email).trim() : '',
    displayName: data.displayName || data.username,
    passwordHash: data.password ? hashPassword(data.password) : null,
    roles: Array.isArray(data.roles) && data.roles.length ? data.roles : ['staff'],
    active: data.active !== false,
    provider: data.provider || 'local',
    mustSetPassword: !!data.mustSetPassword,
    forcePasswordReset: !!data.forcePasswordReset,
    mfaRequired: !!data.mfaRequired,
    createdAt: now,
    updatedAt: now,
    deactivatedAt: null,
    lastLoginAt: null,
    deleted: false,
    deletedAt: null,
    deletedBy: null
  };
  db.users.push(user);
  store.save();
  return user;
}

function setActive(userId, active) {
  const u = findById(userId);
  if (!u) return null;
  // A soft-deleted account can never be reactivated; it must be restored first.
  if (active && u.deleted) return u;
  u.active = !!active;
  u.deactivatedAt = active ? null : new Date().toISOString();
  u.updatedAt = new Date().toISOString();
  store.save();
  return u;
}

// Soft delete: account leaves the active roster, cannot sign in, and cannot be
// edited/reactivated until restored. Preserved for audit history.
function softDelete(userId, actor) {
  const u = findById(userId);
  if (!u) return null;
  u.deleted = true;
  u.deletedAt = new Date().toISOString();
  u.deletedBy = (actor && actor.id) || null;
  u.active = false;
  u.deactivatedAt = u.deactivatedAt || u.deletedAt;
  u.updatedAt = u.deletedAt;
  store.save();
  return u;
}

function restore(userId) {
  const u = findById(userId);
  if (!u || !u.deleted) return null;
  u.deleted = false;
  u.deletedAt = null;
  u.deletedBy = null;
  u.active = true;
  u.deactivatedAt = null;
  u.updatedAt = new Date().toISOString();
  store.save();
  return u;
}

function assignRoles(userId, roles) {
  const u = findById(userId);
  if (!u) return null;
  const db = store.get();
  const valid = new Set(db.roles.map(r => r.key));
  u.roles = [...new Set((roles || []).filter(r => valid.has(r)))];
  if (!u.roles.length) u.roles = ['staff'];
  u.updatedAt = new Date().toISOString();
  store.save();
  return u;
}

function setPassword(userId, password) {
  const u = findById(userId);
  if (!u) return null;
  u.passwordHash = hashPassword(password);
  u.mustSetPassword = false;
  u.forcePasswordReset = false;
  u.provider = 'local';
  u.updatedAt = new Date().toISOString();
  store.save();
  return u;
}

function requirePasswordReset(userId, required) {
  const u = findById(userId);
  if (!u) return null;
  u.forcePasswordReset = required !== false;
  u.updatedAt = new Date().toISOString();
  store.save();
  return u;
}

function updateProfile(userId, patch) {
  const u = findById(userId);
  if (!u) return null;
  if (patch.displayName) u.displayName = String(patch.displayName).trim();
  if (patch.email) u.email = String(patch.email).trim();
  if (patch.ldapDN) u.ldapDN = String(patch.ldapDN);
  u.updatedAt = new Date().toISOString();
  store.save();
  return u;
}

function touchLogin(userId) {
  const u = findById(userId);
  if (u) { u.lastLoginAt = new Date().toISOString(); store.save(); }
}

// Deal lifecycle for a provider: pending (pipeline) | completed | cancelled.
function setDeal(userId, { status, activeDate, reason }) {
  const u = findById(userId);
  if (!u) return null;
  const valid = ['pending', 'completed', 'cancelled'];
  const next = valid.includes(status) ? status : 'pending';
  u.deal = {
    status: next,
    activeDate: next === 'completed' ? (activeDate || new Date().toISOString().slice(0, 10)) : (u.deal && u.deal.activeDate) || null,
    reason: next === 'cancelled' ? (reason || '') : '',
    updatedAt: new Date().toISOString()
  };
  u.updatedAt = new Date().toISOString();
  store.save();
  return u.deal;
}
function getDeal(u) {
  return (u && u.deal) || { status: 'pending', activeDate: null, reason: '', updatedAt: null };
}

// Per-provider section acknowledgements. When a team member acknowledges a gated
// section for a provider, the sections that follow it unlock for that provider
// even though the section is not yet fully approved. Keyed by catalog section id.
function setSectionAck(userId, sectionId, on, actor) {
  const u = findById(userId);
  if (!u || !sectionId) return null;
  u.sectionAcks = u.sectionAcks || {};
  if (on) u.sectionAcks[sectionId] = { by: (actor && actor.id) || '', name: (actor && actor.name) || 'Credentialing team', at: new Date().toISOString() };
  else delete u.sectionAcks[sectionId];
  u.updatedAt = new Date().toISOString();
  store.save();
  return u.sectionAcks;
}
function getSectionAcks(u) {
  return (u && u.sectionAcks) || {};
}

function countActiveAdmins(excludeId) {
  return store.get().users.filter(u => u.active && u.roles.includes('admin') && u.id !== excludeId).length;
}

module.exports = {
  sanitize, findByLogin, findById, listUsers, listDeleted, createUser,
  setActive, softDelete, restore, assignRoles, setPassword, requirePasswordReset, updateProfile, touchLogin, countActiveAdmins,
  setDeal, getDeal, setSectionAck, getSectionAcks
};
