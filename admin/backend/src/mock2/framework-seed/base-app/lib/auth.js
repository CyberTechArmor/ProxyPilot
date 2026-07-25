'use strict';
const store = require('./store');
const users = require('./users');
const rbac = require('./rbac');
const ldapAdapter = require('./ldap');
const { verifyPassword } = require('./crypto');

// Machine-readable outcome codes (clients branch on these, not on messages).
const CODES = {
  OK: 'OK',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  ACCOUNT_DEACTIVATED: 'ACCOUNT_DEACTIVATED',
  PASSWORD_SETUP_REQUIRED: 'PASSWORD_SETUP_REQUIRED',
  PASSWORD_RESET_REQUIRED: 'PASSWORD_RESET_REQUIRED',
  MFA_REQUIRED: 'MFA_REQUIRED',
  RATE_LIMITED: 'RATE_LIMITED',
  SETUP_REQUIRED: 'SETUP_REQUIRED'
};

function gateActiveUser(user) {
  if (user.deleted) return { ok: false, code: CODES.ACCOUNT_DEACTIVATED, message: 'This account is no longer available.' };
  if (!user.active) return { ok: false, code: CODES.ACCOUNT_DEACTIVATED, message: 'This account has been deactivated.' };
  if (user.forcePasswordReset) return { ok: false, code: CODES.PASSWORD_RESET_REQUIRED, message: 'A password reset is required. Use the reset link sent by your administrator.' };
  if (user.mustSetPassword) return { ok: false, code: CODES.PASSWORD_SETUP_REQUIRED, message: 'Password setup is required before you can sign in.', user };
  if (user.mfaRequired) return { ok: false, code: CODES.MFA_REQUIRED, message: 'Multi-factor authentication is required.', user };
  return { ok: true, code: CODES.OK, user };
}

// Attempt local first, then LDAP fallback. `deps.ldap` overridable for tests.
async function authenticate(login, password, deps = {}) {
  const ldap = deps.ldap || ldapAdapter;
  const db = store.get();
  const local = users.findByLogin(login);

  // 1) Local authentication
  if (local && local.provider === 'local' && local.passwordHash) {
    if (verifyPassword(password, local.passwordHash)) {
      const g = gateActiveUser(local);
      return Object.assign(g, { provider: 'local' });
    }
    // local password mismatch -> fall through to LDAP per spec
  }

  // 2) LDAP fallback (if enabled/configured)
  const cfg = db.ldapConfig;
  if (cfg && cfg.enabled && cfg.host) {
    let res;
    try { res = await ldap.authenticate(cfg, login, password); }
    catch (e) { res = { ok: false, code: 'LDAP_ERROR', reason: e.message }; }
    if (res.ok) {
      // Provision or map local identity
      let user = users.findByLogin(login);
      const profile = res.profile || {};
      const displayName = profile.displayName || login;
      const email = profile.email || (login.includes('@') ? login : '');
      if (!user) {
        user = users.createUser({
          username: login, email,
          displayName, roles: (cfg.defaultRoles && cfg.defaultRoles.length ? cfg.defaultRoles : ['staff']),
          provider: 'ldap', active: true
        });
      } else if (user.provider !== 'ldap') {
        // existing local identity matched by same login; keep, mark ldap-linked
        users.updateProfile(user.id, { displayName: profile.displayName, email: profile.email, ldapDN: res.dn });
      } else {
        users.updateProfile(user.id, { displayName: profile.displayName, email: profile.email, ldapDN: res.dn });
      }
      const g = gateActiveUser(user);
      return Object.assign(g, { provider: 'ldap' });
    }
    // If local existed but was deactivated, surface that explicitly
    if (local && !local.active) return { ok: false, code: CODES.ACCOUNT_DEACTIVATED, message: 'This account has been deactivated.' };
    return { ok: false, code: CODES.INVALID_CREDENTIALS, message: 'Invalid username or password.', ldap: res.code };
  }

  if (local && !local.active) return { ok: false, code: CODES.ACCOUNT_DEACTIVATED, message: 'This account has been deactivated.' };
  return { ok: false, code: CODES.INVALID_CREDENTIALS, message: 'Invalid username or password.' };
}

// --- Physician self-service signup ---
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Creates an active physician account owned by the person signing up.
// Returns { ok, code, message, user }.
function registerPhysician(data = {}) {
  if (needsSetup()) return { ok: false, code: 'SETUP_REQUIRED', message: 'The portal has not been set up yet.' };
  const email = String(data.email || '').trim().toLowerCase();
  const password = String(data.password || '');
  const displayName = String(data.displayName || '').trim();
  if (!EMAIL_RE.test(email)) return { ok: false, code: 'INVALID_EMAIL', message: 'Enter a valid email address.' };
  if (password.length < 8) return { ok: false, code: 'WEAK_PASSWORD', message: 'Password must be at least 8 characters.' };
  if (users.findByLogin(email)) return { ok: false, code: 'USER_EXISTS', message: 'An account with this email already exists. Try signing in instead.' };
  rbac.seed();
  const user = users.createUser({
    username: email,
    email,
    displayName: displayName || email,
    password,
    roles: ['physician'],
    active: true,
    provider: 'local',
    mustSetPassword: false
  });
  return { ok: true, code: CODES.OK, user };
}

// --- Super admin first-run setup ---
function needsSetup() {
  const db = store.get();
  const hasAdmin = db.users.some(u => u.active && u.roles.includes('admin'));
  return !db.meta.initialized && !hasAdmin;
}

function createSuperAdmin(data) {
  if (!needsSetup()) throw Object.assign(new Error('ALREADY_INITIALIZED'), { code: 'ALREADY_INITIALIZED' });
  rbac.seed();
  const user = users.createUser({
    username: data.username, email: data.email, displayName: data.displayName || data.username,
    password: data.password, roles: ['admin'], active: true, provider: 'local'
  });
  const db = store.get();
  db.meta.initialized = true;
  db.meta.initializedAt = new Date().toISOString();
  store.save();
  return user;
}

function buildIdentity(user) {
  return {
    id: user.id, username: user.username, email: user.email, displayName: user.displayName,
    roles: user.roles, active: user.active, provider: user.provider,
    permissions: rbac.effectivePermissions(user.roles)
  };
}

module.exports = { CODES, authenticate, registerPhysician, needsSetup, createSuperAdmin, gateActiveUser, buildIdentity };
