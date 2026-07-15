// LDAPS directory integration. Connection settings live in the
// ldap_connections table (migration 601); the bind password is
// encrypted at rest via lib/secrets.js. The login flow calls
// ldapAuthenticate() when the username doesn't match a local account
// (or matches an LDAP-provisioned one) and every enabled connection is
// tried in creation order until one recognises the user.
//
// Auth model per connection: search-then-bind.
//   1. Bind with the configured service account (or anonymously when
//      no bind DN is set).
//   2. Search base_dn (subtree) with user_filter, substituting the
//      RFC 4515-escaped username for every {username} placeholder.
//      Exactly one entry must match.
//   3. Re-bind as the found entry's DN with the user's password.
//
// Only ldaps:// is spoken — plaintext LDAP with credentials on the
// wire is not offered at all. Certificate verification is on by
// default; a private CA chain can be pasted per connection, and
// tls_verify=0 exists strictly as a lab escape hatch (the UI warns).
// NOTE: deliberately does NOT import db.js — callers pass the db
// handle in, keeping this module unit-testable without the native
// better-sqlite3 module (same split as lib/backup-cron.js).
import { Client } from 'ldapts';
import { decryptSecret } from './secrets.js';

export const DEFAULT_USER_FILTER = '(|(uid={username})(sAMAccountName={username}))';

// RFC 4515 filter-value escaping. The username is untrusted input
// headed into a search filter — without this, `*` or `)(` would turn
// the lookup into an injection point.
export function escapeLdapFilterValue(value) {
  return String(value).replace(/[\\*()\u0000]/g, (ch) => {
    switch (ch) {
      case '\\': return '\\5c';
      case '*': return '\\2a';
      case '(': return '\\28';
      case ')': return '\\29';
      default: return '\\00';
    }
  });
}

export function buildUserFilter(template, username) {
  const escaped = escapeLdapFilterValue(username);
  return (template || DEFAULT_USER_FILTER).split('{username}').join(escaped);
}

export function listEnabledLdapConnections(db) {
  return db
    .prepare(
      `SELECT * FROM ldap_connections WHERE enabled = 1 ORDER BY created_at ASC, name ASC`
    )
    .all();
}

export function hasEnabledLdapConnections(db) {
  const row = db
    .prepare(`SELECT COUNT(*) AS count FROM ldap_connections WHERE enabled = 1`)
    .get();
  return (row?.count || 0) > 0;
}

function tlsOptionsFor(conn) {
  const opts = {
    rejectUnauthorized: conn.tls_verify !== 0,
    servername: conn.host,
  };
  if (conn.ca_cert) opts.ca = conn.ca_cert;
  return opts;
}

function clientFor(conn) {
  return new Client({
    url: `ldaps://${conn.host}:${conn.port || 636}`,
    connectTimeout: 5000,
    timeout: 10000,
    tlsOptions: tlsOptionsFor(conn),
  });
}

// LDAP attributes come back as string | string[] | Buffer depending on
// the server; normalise to the first string value or null.
function firstAttr(value) {
  if (value === undefined || value === null) return null;
  const v = Array.isArray(value) ? value[0] : value;
  if (v === undefined || v === null) return null;
  return Buffer.isBuffer(v) ? v.toString('utf8') : String(v);
}

async function serviceBind(client, conn) {
  if (!conn.bind_dn) return; // anonymous bind path — server permitting
  const password = conn.bind_password_enc
    ? decryptSecret(conn.bind_password_enc)
    : '';
  await client.bind(conn.bind_dn, password);
}

// Look up the user's entry via the service account. Returns
// { dn, displayName } when exactly one entry matches, null otherwise
// (zero matches OR an ambiguous multi-match — refusing ambiguity beats
// binding as "whichever came back first").
export async function findUserInDirectory(conn, username) {
  const client = clientFor(conn);
  try {
    await serviceBind(client, conn);
    const filter = buildUserFilter(conn.user_filter, username);
    const { searchEntries } = await client.search(conn.base_dn, {
      scope: 'sub',
      filter,
      attributes: ['displayName', 'cn'],
      sizeLimit: 2,
    });
    if (searchEntries.length !== 1) return null;
    const entry = searchEntries[0];
    return {
      dn: entry.dn,
      displayName: firstAttr(entry.displayName) || firstAttr(entry.cn) || null,
    };
  } finally {
    await client.unbind().catch(() => { /* connection already gone */ });
  }
}

async function verifyUserPassword(conn, dn, password) {
  const client = clientFor(conn);
  try {
    await client.bind(dn, password);
    return true;
  } catch {
    return false;
  } finally {
    await client.unbind().catch(() => { /* connection already gone */ });
  }
}

// Authenticate `username`/`password` against every enabled connection
// in order. Resolves to:
//   { ok: true, dn, displayName, connectionId, connectionName }
//   { ok: false, reason: 'no_connections' | 'empty_password' |
//                'invalid_credentials' | 'user_not_found' |
//                'directory_error', error? }
//
// An empty password is rejected up front — LDAP treats a simple bind
// with an empty password as an ANONYMOUS bind that "succeeds" on many
// servers, which would let anyone log in as any directory user.
//
// The first directory that knows the username decides the outcome; a
// wrong password there does NOT fall through to later directories
// (that would turn multiple connections into extra password-guess
// attempts per lockout increment).
export async function ldapAuthenticate(username, password, { db } = {}) {
  if (typeof password !== 'string' || password.length === 0 || password.trim().length === 0) {
    return { ok: false, reason: 'empty_password' };
  }
  const connections = listEnabledLdapConnections(db);
  if (connections.length === 0) {
    return { ok: false, reason: 'no_connections' };
  }

  let lastError = null;
  for (const conn of connections) {
    let found;
    try {
      found = await findUserInDirectory(conn, username);
    } catch (e) {
      lastError = e;
      continue; // unreachable / misconfigured directory — try the next one
    }
    if (!found) continue;

    const valid = await verifyUserPassword(conn, found.dn, password);
    if (!valid) {
      return { ok: false, reason: 'invalid_credentials', connectionId: conn.id };
    }
    return {
      ok: true,
      dn: found.dn,
      displayName: found.displayName,
      connectionId: conn.id,
      connectionName: conn.name,
    };
  }

  if (lastError) {
    return { ok: false, reason: 'directory_error', error: lastError.message || String(lastError) };
  }
  return { ok: false, reason: 'user_not_found' };
}

// Operator-facing "Test connection": service bind + base-scope read of
// base_dn. Proves reachability, TLS trust, credentials, and that the
// base DN exists — everything short of an actual user login.
export async function testLdapConnection(conn) {
  const client = clientFor(conn);
  try {
    await serviceBind(client, conn);
    await client.search(conn.base_dn, {
      scope: 'base',
      filter: '(objectClass=*)',
      attributes: ['objectClass'],
      sizeLimit: 1,
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  } finally {
    await client.unbind().catch(() => { /* connection already gone */ });
  }
}
