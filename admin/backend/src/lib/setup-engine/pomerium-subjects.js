import { readConfig } from '../sso/store.js';
import { reader } from '../sso/oidc.js';
import { readPomerium, verifiedProvider } from './pomerium-store.js';
import { pomeriumError as fail } from './pomerium-logic.js';

// Keycloak may use a federated user ID; its exact readback is the authority.
const SUBJECT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/;
const EMAIL = /^[^\s@]{1,100}@[^\s@]{1,150}$/;

function observer(db) {
  const protectedRoute = readPomerium(db);
  const sso = readConfig(db);
  if (!protectedRoute || !sso?.verified_at || !sso.config?.readerClientId ||
      sso.config.issuer !== protectedRoute.config.issuer ||
      sso.config.keycloakOrigin !== new URL(protectedRoute.config.issuer).origin)
    throw fail('The verified read-only Keycloak observer for this Pomerium issuer is unavailable.');
  verifiedProvider(db, protectedRoute.config.connectionId);
  return { sso, issuer: protectedRoute.config.issuer };
}

// The observer has view-users only. An exact email search is followed by an
// individual user readback; ambiguity, disabled users and issuer drift refuse.
export async function resolveKeycloakEmail(db, email, { createReader = reader } = {}) {
  if (typeof email !== 'string' || !EMAIL.test(email) || email !== email.trim())
    throw fail('Supply one exact Keycloak email address.');
  const { sso, issuer } = observer(db);
  const get = await createReader(db, sso);
  const users = await get(`/users?email=${encodeURIComponent(email)}&exact=true`);
  if (!Array.isArray(users)) throw fail('Keycloak did not return an exact user search result.');
  const matches = users.filter(user => user?.email?.toLowerCase() === email.toLowerCase());
  if (matches.length !== 1 || !SUBJECT.test(matches[0].id || ''))
    throw fail('The supplied email does not identify exactly one verified Keycloak user.');
  const user = await get(`/users/${encodeURIComponent(matches[0].id)}`);
  if (user?.id !== matches[0].id || user?.email?.toLowerCase() !== email.toLowerCase() ||
      user.enabled !== true || user?.username !== matches[0].username)
    throw fail('The Keycloak user changed or is disabled; reopen the identity review.');
  return { issuer, id: user.id, email: user.email, username: user.username, enabled: true };
}

export async function verifyKeycloakSubjects(db, subjects, { createReader = reader } = {}) {
  const { sso } = observer(db);
  if (!Array.isArray(subjects) || subjects.length < 1 || subjects.length > 20 ||
      subjects.some(id => typeof id !== 'string' || !SUBJECT.test(id)))
    throw fail('Select one to twenty exact Keycloak subject IDs.');
  const get = await createReader(db, sso);
  for (const id of new Set(subjects)) {
    const user = await get(`/users/${encodeURIComponent(id)}`);
    if (user?.id !== id || user.enabled !== true || !EMAIL.test(user.email || ''))
      throw fail('A selected Keycloak subject is unavailable or disabled.');
  }
  return [...new Set(subjects)];
}
