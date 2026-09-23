// Quick LDAP Link: one LDAP / Active Directory user federation on the managed
// Keycloak realm, so every service that signs in through Keycloak accepts
// directory users. ProxyPilot holds no Keycloak write credential after stage
// B, so each change is a fresh login of the PERMANENT administrator (the
// "retire" pattern in full-platform-admin.js): the password (+ OTP) and the
// directory bind password live only as short-lived protected references,
// used by the `keycloak_ldap` runner job and deleted when it ends. Keycloak
// keeps the bind password itself (it reads back masked). Edit mode is always
// READ_ONLY. Only the provider whose id ProxyPilot recorded is ever changed
// or removed. Doc: docs/features/keycloak-ldap.md.
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { approvedFetch } from '../sso/oidc.js';
import { protectedValue, storeProtected } from './full-platform-keycloak.js';
import { withKeycloakLease } from './full-platform-admin.js';
import { readFullPlatform, fail } from './full-platform-store.js';
import { createJob, getJob, jobView } from './store.js';
import { KEYCLOAK_LDAP_APP, KEYCLOAK_LDAP_SCHEMA } from './keycloak-ldap-schema.js';

export { KEYCLOAK_LDAP_APP, KEYCLOAK_LDAP_SCHEMA };
const PROVIDER_TYPE = 'org.keycloak.storage.UserStorageProvider', MAPPER_TYPE = 'org.keycloak.storage.ldap.mappers.LDAPStorageMapper';
const MARKER = 'proxypilot.installation', MAPPER_NAME = 'ProxyPilot directory group';
const DEFAULTS = {
  ad: { usernameAttribute: 'sAMAccountName', rdnAttribute: 'cn', uuidAttribute: 'objectGUID', userObjectClasses: 'person, organizationalPerson, user', groupObjectClass: 'group' },
  other: { usernameAttribute: 'uid', rdnAttribute: 'uid', uuidAttribute: 'entryUUID', userObjectClasses: 'inetOrgPerson, organizationalPerson', groupObjectClass: 'groupOfNames' },
};
const blank = v => typeof v === 'string' && !v.trim() ? undefined : v;
const opt = s => z.preprocess(blank, s.optional());
const dn = z.string().trim().min(3).max(1024).regex(/^[^\x00-\x1f]*=[^\x00-\x1f]*$/, 'Enter a distinguished name, for example OU=Staff,DC=example,DC=com.');
const attr = z.string().trim().regex(/^[A-Za-z][A-Za-z0-9-]{0,63}$/, 'Attribute names use letters, digits and hyphens.');
const adminFields = { revision: z.number().int().min(0), adminPassword: z.string().min(1, 'Enter your Keycloak administrator password.').max(256), otp: opt(z.string().regex(/^\d{6,8}$/, 'The one-time code is 6 to 8 digits.')), reviewed: z.literal(true) };

export function parseConnectionUrl(raw, startTls) {
  let u; try { u = new URL(String(raw).trim()); } catch { return { error: 'Enter the directory address as ldaps://host[:port] (or ldap://host with StartTLS).' }; }
  if (!['ldaps:', 'ldap:'].includes(u.protocol) || !u.hostname || u.username || u.password || !['', '/'].includes(u.pathname) || u.search || u.hash) return { error: 'Enter the directory address as ldaps://host[:port] (or ldap://host with StartTLS), with no path or credentials.' };
  if (u.protocol === 'ldap:' && !startTls) return { error: 'Plain ldap:// would send the directory password unencrypted. Use ldaps:// or turn on StartTLS.' };
  if (u.protocol === 'ldaps:' && startTls) return { error: 'StartTLS is only for ldap:// addresses; ldaps:// is already encrypted.' };
  return { url: `${u.protocol}//${u.host}` };
}
export const ldapLinkSchema = z.object({ ...adminFields,
  connectionUrl: z.string().trim().min(1).max(512), startTls: z.boolean().default(false), vendor: z.enum(['ad', 'other']),
  bindDn: dn, bindPassword: z.string().min(1, 'Enter the bind password.').max(1024), usersDn: dn,
  usernameAttribute: opt(attr), rdnAttribute: opt(attr), uuidAttribute: opt(attr),
  userObjectClasses: opt(z.string().trim().regex(/^[A-Za-z][A-Za-z0-9-]*(\s*,\s*[A-Za-z][A-Za-z0-9-]*){0,9}$/, 'List object classes separated by commas.')),
  userFilter: opt(z.string().trim().max(1024).regex(/^\([^\x00-\x1f]*\)$/, 'A custom filter starts with ( and ends with ).')),
  groupsDn: opt(dn), groupName: opt(z.string().trim().regex(/^[^\x00-\x1f,=+<>#;\\"*()]{1,128}$/, 'Enter the group’s name (its cn), without special characters.')),
  displayName: z.preprocess(blank, z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9 ._-]+$/, 'The display name uses letters, digits, spaces, dots, dashes and underscores.').default('Directory')),
}).strict().superRefine((p, ctx) => {
  const c = parseConnectionUrl(p.connectionUrl, p.startTls); if (c.error) ctx.addIssue({ code: 'custom', path: ['connectionUrl'], message: c.error });
  if (!!p.groupsDn !== !!p.groupName) ctx.addIssue({ code: 'custom', path: ['groupName'], message: 'For group mapping enter both the groups location (DN) and the group name, or leave both empty.' });
});
export const ldapRemoveSchema = z.object(adminFields).strict();
export const ldapJobSchema = z.object({ revision: z.number().int().positive(), operation: z.enum(['link', 'remove']) }).strict();

const parse = v => { try { return v ? JSON.parse(v) : null; } catch { return null; } };
export function readLdap(db) {
  const row = db.prepare('SELECT * FROM setup_keycloak_ldap WHERE id=1').get();
  return row ? { ...row, config: parse(row.config_json), linked: parse(row.linked_json), status: parse(row.status_json) || {} } : null;
}
// The managed installation, reachable only after stage B retired the bootstrap.
function installation(db) {
  const full = readFullPlatform(db);
  if (!full?.state?.administratorVerified || !full.state.administrator?.username || !full.state.identity?.bootstrapRef) throw fail('Finish stage B (permanent Keycloak administrator, bootstrap account retired) before connecting a directory.');
  const k = db.prepare('SELECT * FROM setup_keycloak WHERE id=?').get(protectedValue(db, full.state.identity.bootstrapRef).installationId);
  if (!k || k.ownership !== 'managed' || !k.verified_at) throw fail('Only the managed, verified Keycloak installation can be linked to a directory.');
  if (k.realm !== full.config.realm) throw fail('The managed Keycloak realm differs from the saved platform realm. Review the Keycloak installation first.');
  return { full, k, username: full.state.administrator.username };
}

export function ldapState(db) {
  let ready = true, readyReason = null, administrator = null;
  try { administrator = installation(db).username; } catch (e) { ready = false; readyReason = e.message; }
  const row = readLdap(db), job = row?.last_job_id ? getJob(db, row.last_job_id) : null;
  const running = job && ['queued', 'running'].includes(job.status);
  const state = running ? 'pending' : job && job.status !== 'succeeded' ? 'failed' : row?.component_id ? 'linked' : 'not_configured';
  return { state, ready, readyReason, administrator, revision: row?.revision || 0, config: row?.config || null, linked: !!row?.component_id, componentId: row?.component_id || null, groupMapped: !!row?.mapper_id,
    sync: row?.status?.sync || null, linkedAt: row?.status?.linkedAt || null,
    lastJob: job ? { id: job.id, status: job.status, operation: parse(job.plan_json)?.params?.operation || null, phase: job.phase || null, reason: running ? null : job.reason || null, updatedAt: job.updated_at } : null };
}

function forget(db, ...refs) { for (const ref of refs) if (ref) db.prepare('DELETE FROM setup_full_credentials WHERE id=?').run(ref); }
export function queueLdap(db, raw, user, operation) {
  const p = (operation === 'remove' ? ldapRemoveSchema : ldapLinkSchema).parse(raw);
  db.exec('BEGIN IMMEDIATE');
  try {
    const { k } = installation(db), row = readLdap(db);
    if ((row?.revision || 0) !== p.revision) throw fail('The directory link changed in another session. Reopen it and try again.');
    if (row?.last_job_id && ['queued', 'running'].includes(getJob(db, row.last_job_id)?.status)) throw fail('A directory link operation is already running. Wait for it to finish.');
    if (row?.component_id && row.installation_id !== k.id) throw fail('The recorded directory link belongs to a different Keycloak installation. It was not changed.');
    let config = row?.config || null;
    if (operation === 'remove') { if (!row?.component_id) throw fail('There is no directory link created by ProxyPilot to remove.'); }
    else {
      const d = DEFAULTS[p.vendor];
      config = { connectionUrl: parseConnectionUrl(p.connectionUrl, p.startTls).url, startTls: p.startTls, vendor: p.vendor, bindDn: p.bindDn, usersDn: p.usersDn,
        usernameAttribute: p.usernameAttribute || d.usernameAttribute, rdnAttribute: p.rdnAttribute || d.rdnAttribute, uuidAttribute: p.uuidAttribute || d.uuidAttribute,
        userObjectClasses: (p.userObjectClasses || d.userObjectClasses).split(',').map(s => s.trim()).join(', '), userFilter: p.userFilter || null,
        groupsDn: p.groupsDn || null, groupName: p.groupName || null, displayName: p.displayName };
      // Keycloak creates its attribute mappers from these once, at creation;
      // changing them later would leave the mappers pointing at the old ones.
      if (row?.component_id && row.linked && ['vendor', 'usernameAttribute', 'rdnAttribute', 'uuidAttribute'].some(key => row.linked[key] !== config[key])) throw fail('Changing the directory type or the username, RDN or UUID attribute needs a fresh link: remove the directory link, then connect it again.');
    }
    forget(db, row?.admin_ref, row?.bind_ref);
    const adminRef = `keycloak-ldap-admin-${randomUUID()}`, bindRef = operation === 'link' ? `keycloak-ldap-bind-${randomUUID()}` : null, expiresAt = Date.now() + 15 * 60_000;
    storeProtected(db, adminRef, { password: p.adminPassword, otp: p.otp, expiresAt });
    if (bindRef) storeProtected(db, bindRef, { bindCredential: p.bindPassword, expiresAt });
    const revision = (row?.revision || 0) + 1;
    const job = createJob(db, { app: KEYCLOAK_LDAP_APP, kind: 'keycloak_ldap', plan: { params: { revision, operation } }, requestedBy: user.id, via: 'ui', retryOf: row?.last_job_id || null,
      reason: operation === 'link' ? 'Test, create or update and sync the reviewed read-only directory link in Keycloak.' : 'Remove the directory link ProxyPilot created in Keycloak.' });
    db.prepare(`INSERT INTO setup_keycloak_ldap(id,revision,config_json,linked_json,installation_id,component_id,mapper_id,status_json,admin_ref,bind_ref,last_job_id,updated_by,updated_at) VALUES (1,?,?,NULL,?,NULL,NULL,'{}',?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,config_json=excluded.config_json,installation_id=COALESCE(setup_keycloak_ldap.installation_id,excluded.installation_id),admin_ref=excluded.admin_ref,bind_ref=excluded.bind_ref,last_job_id=excluded.last_job_id,updated_by=excluded.updated_by,updated_at=excluded.updated_at`)
      .run(revision, JSON.stringify(config), k.id, adminRef, bindRef, job.id, String(user.id), new Date().toISOString());
    db.exec('COMMIT');
    return { job: jobView(job), created: true, ldap: ldapState(db) };
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

const list = v => [String(v)];
const escapeFilter = v => v.replace(/[\\*()\x00]/g, c => '\\' + c.charCodeAt(0).toString(16).padStart(2, '0'));
export function providerConfig(c, installationId, bindCredential) {
  return { enabled: list(true), priority: list(0), vendor: list(c.vendor), connectionUrl: list(c.connectionUrl), startTls: list(!!c.startTls), useTruststoreSpi: list('always'),
    connectionPooling: list(!c.startTls), connectionTimeout: list(10000), authType: list('simple'), bindDn: list(c.bindDn), bindCredential: list(bindCredential),
    editMode: list('READ_ONLY'), usersDn: list(c.usersDn), usernameLDAPAttribute: list(c.usernameAttribute), rdnLDAPAttribute: list(c.rdnAttribute), uuidLDAPAttribute: list(c.uuidAttribute),
    userObjectClasses: list(c.userObjectClasses), ...(c.userFilter ? { customUserSearchFilter: list(c.userFilter) } : {}), searchScope: list(2), pagination: list(true),
    importEnabled: list(true), syncRegistrations: list(false), trustEmail: list(false), batchSizeForSync: list(1000), fullSyncPeriod: list(-1), changedSyncPeriod: list(-1),
    cachePolicy: list('DEFAULT'), validatePasswordPolicy: list(false), allowKerberosAuthentication: list(false), useKerberosForPasswordAuthentication: list(false), [MARKER]: list(installationId) };
}
export function mapperConfig(c) {
  return { 'groups.dn': list(c.groupsDn), 'group.name.ldap.attribute': list('cn'), 'group.object.classes': list(DEFAULTS[c.vendor].groupObjectClass), 'groups.ldap.filter': list(`(cn=${escapeFilter(c.groupName)})`),
    'preserve.group.inheritance': list(false), 'ignore.missing.groups': list(false), 'membership.ldap.attribute': list('member'), 'membership.attribute.type': list('DN'),
    'membership.user.ldap.attribute': list(c.usernameAttribute), mode: list('READ_ONLY'), 'user.roles.retrieve.strategy': list('LOAD_GROUPS_BY_MEMBER_ATTRIBUTE'),
    'memberof.ldap.attribute': list('memberOf'), 'drop.non.existing.groups.during.sync': list(false), 'groups.path': list('/') };
}

export async function runKeycloakLdap({ db, params, job, send }) {
  const p = ldapJobSchema.parse(params), coordinatorJob = job;
  const row = readLdap(db);
  if (!row || row.revision !== p.revision || row.last_job_id !== job.id) throw fail('This directory link request was superseded. Reopen the directory link.');
  const refs = [row.admin_ref, row.bind_ref];
  try {
    const { k, username } = installation(db);
    if (row.installation_id !== k.id) throw fail('The recorded directory link belongs to a different Keycloak installation. It was not changed.');
    if (!row.admin_ref || (p.operation === 'link' && !row.bind_ref)) throw fail('The one-time passwords for this request are gone. Enter them again.');
    const input = protectedValue(db, row.admin_ref), bind = p.operation === 'link' ? protectedValue(db, row.bind_ref) : null;
    if (input.expiresAt < Date.now() || (bind && bind.expiresAt < Date.now())) throw fail('The one-time passwords for this request expired. Enter them again; nothing was changed.');
    const c = row.config, fetcher = send || approvedFetch(k.origin);
    const status = { ...row.status };
    const persist = (fields = {}) => { job.fence(); const sets = Object.keys(fields).map(key => `${key}=?`); db.prepare(`UPDATE setup_keycloak_ldap SET ${[...sets, 'status_json=?'].join(',')} WHERE id=1 AND last_job_id=?`).run(...Object.values(fields), JSON.stringify(status), coordinatorJob.id); };
    return await withKeycloakLease(db, job, async guarded => {
      job = guarded;
      job.checkpoint?.('ldap_admin_login', { resumable: true });
      const response = await fetcher(`${k.origin}/realms/master/protocol/openid-connect/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: 'admin-cli', grant_type: 'password', scope: 'openid', username, password: input.password, ...(input.otp ? { totp: input.otp } : {}) }).toString() });
      job.fence(); if (!response.ok) throw fail(`Keycloak refused the administrator sign-in for ${username}. Check the password (and one-time code); nothing was changed.`);
      const grant = await response.json();
      if (!grant.access_token) throw fail('Keycloak did not issue an administrator access token; nothing was changed.');
      const call = async (path, { method = 'GET', body } = {}) => { job.fence(); const r = await fetcher(k.origin + path, { method, headers: { Authorization: `Bearer ${grant.access_token}`, Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }); job.fence(); return r; };
      const json = async (r, what) => { if (!r.ok) throw fail(`Keycloak refused ${what} (HTTP ${r.status}); provider details are withheld.`); const text = await r.text(); if (!text) return {}; try { return JSON.parse(text); } catch { throw fail(`Keycloak returned an unreadable answer to ${what}; details withheld.`); } };
      const base = `/admin/realms/${encodeURIComponent(k.realm)}`;
      try {
        const realm = await json(await call(base), 'reading the realm');
        if (realm?.attributes?.[MARKER] !== k.id || !realm.id) throw fail('This realm does not carry the managed installation ownership marker. Nothing was changed.');
        const owned = async () => {
          if (!row.component_id) return null;
          const r = await call(`${base}/components/${encodeURIComponent(row.component_id)}`);
          if (r.status === 404) return null;
          const comp = await json(r, 'reading the directory link');
          if (comp.providerId !== 'ldap' || comp.providerType !== PROVIDER_TYPE || comp.parentId !== realm.id) throw fail('The recorded component is not this realm’s LDAP directory link. It was not changed.');
          return comp;
        };
        if (p.operation === 'remove') {
          job.checkpoint?.('ldap_remove', { resumable: true });
          const comp = await owned();
          if (comp) { const r = await call(`${base}/components/${encodeURIComponent(comp.id)}`, { method: 'DELETE' }); if (![204, 404].includes(r.status)) throw fail(`Keycloak refused removing the directory link (HTTP ${r.status}); it was kept.`); }
          delete status.sync; delete status.linkedAt; status.removedAt = new Date().toISOString();
          persist({ component_id: null, mapper_id: null, linked_json: null });
          return { verification: { state: 'verified', label: 'The directory link was removed from Keycloak, with the users it had imported. Directory users can no longer sign in.', complete: true } };
        }
        const test = async action => call(`${base}/testLDAPConnection`, { method: 'POST', body: { action, connectionUrl: c.connectionUrl, authType: 'simple', bindDn: c.bindDn, bindCredential: bind.bindCredential, useTruststoreSpi: 'always', connectionTimeout: '5000', startTls: String(!!c.startTls) } });
        job.checkpoint?.('ldap_test_connection', { resumable: true });
        if (!(await test('testConnection')).ok) throw fail(`Connection test failed: Keycloak could not open a connection to ${c.connectionUrl}. Check the address and port, that the Keycloak container can reach the directory, and${c.startTls || c.connectionUrl.startsWith('ldaps:') ? ' that Keycloak trusts the directory’s TLS certificate (its CA).' : ' the network path.'} Nothing was changed.`);
        job.checkpoint?.('ldap_test_authentication', { resumable: true });
        if (!(await test('testAuthentication')).ok) throw fail('Authentication test failed: Keycloak reached the directory, but the bind DN and bind password were refused. Nothing was changed.');
        job.checkpoint?.('ldap_save_provider', { resumable: true });
        const found = await json(await call(`${base}/components?type=${encodeURIComponent(PROVIDER_TYPE)}`), 'listing user federation');
        let comp = await owned();
        if (!comp) {
          const same = (Array.isArray(found) ? found : []).filter(x => x.providerId === 'ldap' && x.name === c.displayName);
          // Adopt only a provider this installation created (a crash between
          // create and record); any other same-named provider is someone else's.
          const ours = same.find(x => x.config?.[MARKER]?.[0] === k.id && x.parentId === realm.id);
          if (same.length && !ours) throw fail(`Keycloak already has an LDAP provider named "${c.displayName}" that ProxyPilot did not create. It was not changed; choose a different display name or remove that provider yourself.`);
          comp = ours || null;
        }
        const representation = { name: c.displayName, providerId: 'ldap', providerType: PROVIDER_TYPE, parentId: realm.id, config: providerConfig(c, k.id, bind.bindCredential) };
        if (comp) {
          const r = await call(`${base}/components/${encodeURIComponent(comp.id)}`, { method: 'PUT', body: { ...representation, id: comp.id } });
          if (!r.ok) throw fail(`Keycloak refused updating the directory link (HTTP ${r.status}); provider details are withheld.`);
        } else {
          const r = await call(`${base}/components`, { method: 'POST', body: representation });
          if (r.status !== 201) throw fail(`Keycloak refused creating the directory link (HTTP ${r.status}); provider details are withheld.`);
          const id = String(r.headers.get('location') || '').split('/').pop();
          if (!/^[A-Za-z0-9-]{1,64}$/.test(id)) throw fail('Keycloak created the directory link but did not report its id. Reopen the link before retrying.');
          comp = { id };
        }
        status.linkedAt = new Date().toISOString(); delete status.removedAt;
        persist({ component_id: comp.id, linked_json: JSON.stringify(c) });
        job.checkpoint?.('ldap_group_mapper', { resumable: true });
        const mappers = await json(await call(`${base}/components?parent=${encodeURIComponent(comp.id)}&type=${encodeURIComponent(MAPPER_TYPE)}`), 'listing the directory mappers');
        const mapper = (Array.isArray(mappers) ? mappers : []).find(m => m.name === MAPPER_NAME && m.parentId === comp.id);
        let mapperId = null;
        if (c.groupsDn && c.groupName) {
          const body = { name: MAPPER_NAME, providerId: 'group-ldap-mapper', providerType: MAPPER_TYPE, parentId: comp.id, config: mapperConfig(c) };
          if (mapper) { const r = await call(`${base}/components/${encodeURIComponent(mapper.id)}`, { method: 'PUT', body: { ...body, id: mapper.id } }); if (!r.ok) throw fail(`Keycloak refused updating the group mapping (HTTP ${r.status}).`); mapperId = mapper.id; }
          else {
            const r = await call(`${base}/components`, { method: 'POST', body });
            if (r.status !== 201) throw fail(`Keycloak refused creating the group mapping (HTTP ${r.status}).`);
            mapperId = String(r.headers.get('location') || '').split('/').pop() || null;
          }
        } else if (mapper) {
          const r = await call(`${base}/components/${encodeURIComponent(mapper.id)}`, { method: 'DELETE' });
          if (![204, 404].includes(r.status)) throw fail(`Keycloak refused removing the old group mapping (HTTP ${r.status}).`);
        }
        persist({ mapper_id: mapperId });
        // A large directory can outlast one HTTP request; Keycloak finishes the
        // sync on its own, so an unanswered sync is recorded, not a failure.
        job.checkpoint?.('ldap_sync', { resumable: true });
        const counts = x => Object.fromEntries(['added', 'updated', 'removed', 'failed'].map(key => [key, Number.isFinite(x?.[key]) ? x[key] : 0]));
        const sync = { at: new Date().toISOString() }, passOn = e => { if (e?.fullPlatformSafe || ['FENCED', 'CANCELLED'].includes(e?.code)) throw e; };
        const trigger = async path => { try { return await call(path, { method: 'POST' }); } catch (e) { passOn(e); return null; } };
        const users = await trigger(`${base}/user-storage/${encodeURIComponent(comp.id)}/sync?action=triggerFullSync`);
        if (!users) Object.assign(sync, { state: 'unconfirmed', note: 'Keycloak did not report the user sync result in time. It may still be running; directory users are also imported the first time they sign in.' });
        else if (!users.ok) Object.assign(sync, { state: 'failed', note: `Keycloak reported an error while syncing users (HTTP ${users.status}). The link is saved; directory users are still imported the first time they sign in.` });
        else Object.assign(sync, { state: 'completed', users: counts(await users.json().catch(() => ({}))) });
        if (mapperId && sync.state === 'completed') {
          const groups = await trigger(`${base}/user-storage/${encodeURIComponent(comp.id)}/mappers/${encodeURIComponent(mapperId)}/sync?direction=fedToKeycloak`);
          if (groups?.ok) sync.groups = counts(await groups.json().catch(() => ({})));
          else sync.groupNote = 'The group sync result was not reported; membership is also read at each sign-in.';
        }
        status.sync = sync; persist();
        const u = sync.users;
        return { verification: { state: 'verified', label: `Directory linked (read-only).${u ? ` Users: ${u.added} added, ${u.updated} updated, ${u.failed} failed.` : ` ${sync.note}`}`, complete: true } };
      } finally {
        if (grant.refresh_token) await fetcher(`${k.origin}/realms/master/protocol/openid-connect/logout`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: 'admin-cli', refresh_token: grant.refresh_token }).toString() }).catch(() => {});
      }
    });
  } finally {
    // Keycloak keeps the bind password; ProxyPilot's copies end with the job.
    forget(db, ...refs);
    db.prepare('UPDATE setup_keycloak_ldap SET admin_ref=NULL,bind_ref=NULL WHERE id=1 AND last_job_id=?').run(coordinatorJob.id);
  }
}
