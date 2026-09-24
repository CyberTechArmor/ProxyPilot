import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { keycloakFetch } from '../sso/oidc.js';
import { readConfig, activationReadiness, readinessText } from '../sso/store.js';
import { protectedValue, storeProtected, keycloakAdmin } from './full-platform-keycloak.js';
import { readFullPlatform, fail } from './full-platform-store.js';
import { createJob, getJob, jobView, acquireLock, releaseLock, renewLock, readLock, takeoverLock } from './store.js';

export const administratorSchema = z.object({ revision: z.number().int().positive(), action: z.enum(['create', 'verify_and_retire']),
  useCurrent: z.boolean().default(true), username: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._@-]{1,99}$/).optional(),
  email: z.string().email().max(254), firstName: z.string().trim().min(1, 'Enter the administrator’s first name.').max(100), lastName: z.string().trim().min(1, 'Enter the administrator’s last name.').max(100),
  password: z.string().min(12).max(256), otp: z.string().regex(/^\d{6,8}$/).optional(), reviewed: z.literal(true),
}).strict();

export function queueAdministrator(db, raw, user) {
  const p = administratorSchema.parse(raw); db.exec('BEGIN IMMEDIATE');
  try {
    const full = readFullPlatform(db);
    if (!full || full.revision !== p.revision || full.approved_revision !== p.revision || !full.state.identity?.bootstrapRef) throw fail('Apply and verify the managed Keycloak connection first.');
    if (full.last_job_id && ['queued', 'running'].includes(getJob(db, full.last_job_id)?.status)) throw fail('The current setup operation must finish before the administrator handoff.');
    if (String(full.created_by) !== String(user.id)) throw fail('Resume this handoff as the administrator who reviewed this installation.');
    const username = (p.useCurrent ? user.username : p.username)?.toLowerCase();
    if (!username || username === 'bootstrap-admin') throw fail('Choose a permanent named administrator distinct from the bootstrap account.');
    if (full.state.administrator && (full.state.administrator.username.toLowerCase() !== username || full.state.administrator.email !== p.email)) throw fail('This handoff already names a permanent administrator. Reopen it; existing users will not be replaced.');
    if (p.action === 'verify_and_retire') {
      for (const kind of ['proxypilot','observer','pomerium','openbao','vaultwarden']) if ((['proxypilot','observer'].includes(kind) || full.config.services[kind].mode !== 'skip') && !full.state.identity.clients?.[kind]) throw fail('Connect all selected identity clients before retiring bootstrap administration.');
      const sso = readConfig(db);
      if (!full.state.administrator?.masterId || !sso) throw fail('Prove permanent administration, ProxyPilot SSO login/step-up and separate local recovery before retiring the bootstrap account.');
      const readiness = activationReadiness(db, sso, user.id);
      if (!readiness.ready) throw fail(`Before retiring the bootstrap account: ${readinessText(readiness.missing)}.`);
      const link = db.prepare('SELECT subject FROM sso_links WHERE issuer=? AND user_id=?').get(sso.config.issuer, user.id);
      if (link?.subject !== full.state.administrator.applicationId) throw fail('The proven application identity is not the permanent administrator named in this handoff.');
    }
    const ref = `full-administrator-${randomUUID()}`;
    if (full.state.administratorRequest) db.prepare('DELETE FROM setup_full_credentials WHERE id=?').run(full.state.administratorRequest);
    storeProtected(db, ref, { password: p.password, otp: p.otp, expiresAt: Date.now() + 15 * 60_000 });
    const state = { ...full.state, administrator: { ...full.state.administrator, username, email: p.email, firstName: p.firstName, lastName: p.lastName, localUserId: user.id }, administratorRequest: ref };
    const job = createJob(db, { app: 'pp-full-platform', kind: 'full_platform_apply', plan: { params: { revision: p.revision, operation: p.action === 'create' ? 'administrator' : 'retire' } }, requestedBy: user.id, via: 'ui', retryOf: full.last_job_id, reason: p.action === 'create' ? 'Create or resume the reviewed permanent administrator handoff.' : 'Freshly verify permanent administration and retire the temporary account only after all access checks.' });
    db.prepare('UPDATE setup_full_platform SET state_json=?,last_job_id=? WHERE id=1').run(JSON.stringify(state), job.id);
    db.exec('COMMIT'); return { job: jobView(job), created: true };
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

export async function withKeycloakLease(db, job, fn) {
  const record = getJob(db, job.id), owner = record?.owner;
  let lock = acquireLock(db, { app: 'pp-platform-keycloak', owner, operation: 'full_platform_identity', jobId: job.id, leaseMs: 30000 });
  if (!lock.ok && lock.reason === 'stale' && readLock(db, 'pp-platform-keycloak')?.job_id === job.id) lock = takeoverLock(db, { app: 'pp-platform-keycloak', by: owner, operation: 'full_platform_identity', jobId: job.id, leaseMs: 30000, reason: 'Resume this interrupted managed identity handoff.' });
  if (!lock.ok) throw fail('Keycloak has an active or unresolved operation. Reopen that operation before continuing the handoff.');
  let lost = false;
  const fence = () => { job.fence(); if (lost || !renewLock(db, { app: 'pp-platform-keycloak', owner, epoch: lock.lock.epoch, leaseMs: 30000 })) { lost = true; throw fail('The Keycloak identity lease was lost. The working access path was retained.'); } };
  const timer = setInterval(() => { try { fence(); } catch { lost = true; } }, 10000); timer.unref();
  try { return await fn({ ...job, fence }); }
  finally { clearInterval(timer); releaseLock(db, { app: 'pp-platform-keycloak', owner, epoch: lock.lock.epoch }); }
}

export async function runAdministrator(db, full, operation, job, { send } = {}) {
  const coordinatorJob = job;
  const profile = full.state.administrator, inputRef = full.state.administratorRequest;
  if (!profile || !inputRef) throw fail('Enter the permanent administrator credential again to resume this handoff.');
  let input = protectedValue(db, inputRef);
  if (input.expiresAt < Date.now()) { db.prepare('DELETE FROM setup_full_credentials WHERE id=?').run(inputRef); throw fail('The one-time administrator input expired. Enter it again; saved users and their credentials were retained.'); }
  const bootstrap = protectedValue(db, full.state.identity.bootstrapRef);
  const k = db.prepare('SELECT * FROM setup_keycloak WHERE id=?').get(bootstrap.installationId);
  if (!k || k.ownership !== 'managed') throw fail('Only an owned Keycloak installation supports this handoff.');
  const state = { ...full.state, administrator: { ...profile } };
  const persist = () => { job.fence(); db.prepare('UPDATE setup_full_platform SET state_json=? WHERE id=1 AND revision=? AND last_job_id=?').run(JSON.stringify(state), full.revision, job.id); };
  try {
    return await withKeycloakLease(db, job, async guarded => {
      job = guarded;
      if (operation === 'administrator') {
        if (bootstrap.retired) throw fail('The bootstrap account is already retired. Use permanent administration; it will not be recreated.');
        const authority = await keycloakAdmin(k, bootstrap.password, { send: send || keycloakFetch(db, k.origin), job, ...(bootstrap.username ? { username: bootstrap.username } : {}) });
        try {
          const ensureUser = async (realm, key) => {
            const base = `/admin/realms/${encodeURIComponent(realm)}`, query = `${base}/users?username=${encodeURIComponent(profile.username)}&exact=true`;
            // Declarative user profiles discard unknown attributes. Register
            // only these administrator-controlled ownership fields, preserving
            // every existing profile rule and leaving email linking disabled.
            const profilePath = `${base}/users/profile`, schema = await authority.api(profilePath);
            if (!Array.isArray(schema?.attributes)) throw fail('Keycloak user-profile ownership fields are unavailable.');
            let changed = false;
            for (const name of ['proxypilot.installation', 'proxypilot.local-user']) {
              const existing = schema.attributes.find(a => a.name === name);
              if (existing && (JSON.stringify(existing.permissions?.view) !== '["admin"]' || JSON.stringify(existing.permissions?.edit) !== '["admin"]')) throw fail('An ownership profile field has conflicting permissions. Existing profile rules were preserved.');
              if (!existing) { schema.attributes.push({ name, displayName: name, permissions: { view: ['admin'], edit: ['admin'] }, multivalued: false }); changed = true; }
            }
            if (changed) await authority.api(profilePath, { method: 'PUT', body: schema });
            let list = await authority.api(query), user = list?.find(u => u.username === profile.username);
            if (!user) {
              if (state.administrator[key]) throw fail('The recorded permanent user is missing. Restore that identity; retry will not replace it.');
              await authority.api(`${base}/users`, { method: 'POST', body: { username: profile.username, email: profile.email, firstName: profile.firstName, lastName: profile.lastName, enabled: true, emailVerified: true,
                attributes: { 'proxypilot.installation': [k.id], 'proxypilot.local-user': [String(profile.localUserId)] }, credentials: [{ type: 'password', value: input.password, temporary: false }], requiredActions: realm === 'master' ? [] : ['webauthn-register-passwordless'] } });
              list = await authority.api(query); user = list?.find(u => u.username === profile.username);
            }
            if (!user?.id || user.attributes?.['proxypilot.installation']?.[0] !== k.id || user.attributes?.['proxypilot.local-user']?.[0] !== String(profile.localUserId) || !user.enabled || state.administrator[key] && state.administrator[key] !== user.id) throw fail('An existing user cannot be linked by username or email alone. Prove the existing identities through the explicit linking flow; no account or credential was replaced.');
            // The address was entered by the administrator who proved this installation;
            // an unverified one blocks SSO sign-in and linking (Vaultwarden refuses it).
            if (!user.emailVerified) { await authority.api(`${base}/users/${user.id}`, { method: 'PUT', body: { ...user, emailVerified: true } }); user = { ...user, emailVerified: true }; }
            state.administrator[key] = user.id; persist(); return { base, user };
          };
          const master = await ensureUser('master', 'masterId');
          const role = await authority.api(`${master.base}/roles/admin`);
          if (!role?.id) throw fail('The permanent master-realm administration role is unavailable.');
          const rolesPath = `${master.base}/users/${master.user.id}/role-mappings/realm`;
          const roles = await authority.api(rolesPath);
          if (!roles?.some(r => r.id === role.id)) await authority.api(rolesPath, { method: 'POST', body: [role] });
          if (!(await authority.api(rolesPath))?.some(r => r.id === role.id)) throw fail('Permanent master administration privileges were not verified.');
          const appUser = await ensureUser(k.realm, 'applicationId');
          for (const group of Object.values(full.state.identity.groups || {})) {
            await authority.api(`${appUser.base}/users/${appUser.user.id}/groups/${group}`, { method: 'PUT' });
          }
          state.stage = 'administrator';
          state.actions = { ...state.actions, administrator: 'Permanent master and application identities are prepared. Enroll a Keycloak passkey, prove the application link, test SSO and independent recovery, then verify and retire the temporary administrator.' };
          persist();
          return { verification: { state: 'awaiting_user_action', label: state.actions.administrator, complete: false } };
        } finally { await authority.close(); }
      }
      const sso = readConfig(db);
      if (!sso || !activationReadiness(db, sso, profile.localUserId).ready) throw fail('The current SSO/recovery evidence expired or changed. The bootstrap account was retained.');
      const link = db.prepare('SELECT subject FROM sso_links WHERE issuer=? AND user_id=?').get(sso.config.issuer, profile.localUserId);
      if (link?.subject !== profile.applicationId) throw fail('The linked application identity differs from this handoff.');
      const fetcher = send || keycloakFetch(db, k.origin);
      job.fence();
      const response = await fetcher(`${k.origin}/realms/master/protocol/openid-connect/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: 'admin-cli', grant_type: 'password', scope: 'openid', username: profile.username, password: input.password, ...(input.otp ? { totp: input.otp } : {}) }).toString() });
      job.fence(); if (!response.ok) throw fail('Permanent administrator fresh login failed. The temporary administrator was retained.');
      const grant = await response.json();
      const call = async (path, method = 'GET') => { job.fence(); const r = await fetcher(k.origin + path, { method, headers: { Authorization: `Bearer ${grant.access_token}`, Accept: 'application/json' } }); job.fence(); return r; };
      try {
        const roles = await call(`/admin/realms/master/users/${profile.masterId}/role-mappings/realm/composite`);
        if (!roles.ok || !(await roles.json()).some(r => r.name === 'admin')) throw fail('Permanent master administration privileges were not proved.');
        // Whose login is this? Keycloak 26 issues admin-cli LIGHTWEIGHT access
        // tokens and its userinfo endpoint refuses them, so the proof is
        // server-side instead: the session this fresh login created
        // (session_state, from our own token request) must be one of the
        // permanent administrator's own sessions in the admin API.
        const sid = typeof grant.session_state === 'string' ? grant.session_state : null;
        const sessions = sid ? await call(`/admin/realms/master/users/${encodeURIComponent(profile.masterId)}/sessions`) : null;
        if (!sessions?.ok) throw fail('The fresh administrator login could not be matched to the permanent administrator (Keycloak did not report its sessions). The temporary administrator was retained.');
        if (!(await sessions.json()).some(x => x.id === sid)) throw fail('The fresh administrator login belongs to a different Keycloak user than the permanent administrator named in this handoff. The temporary administrator was retained.');
        // After a reviewed recovery (3h) there are two temporary accounts: the
        // original bootstrap-admin and the recovery account. Both are retired.
        const temporaries = [...new Set([bootstrap.username || 'bootstrap-admin', ...(bootstrap.recovered ? ['bootstrap-admin'] : [])])];
        for (const [index, name] of temporaries.entries()) {
          const users = await call(`/admin/realms/master/users?username=${encodeURIComponent(name)}&exact=true`);
          if (!users.ok) throw fail('Permanent administration could not inspect the temporary account.');
          const temporary = (await users.json()).find(u => u.username === name);
          if (temporary) {
            if (temporary.id === profile.masterId) throw fail('The permanent account cannot be the bootstrap account.');
            state.bootstrapRetirementAttempted = true; persist();
            const removed = await call(`/admin/realms/master/users/${temporary.id}`, 'DELETE');
            if (removed.status !== 204 && removed.status !== 404) throw fail('Temporary account retirement failed. Reopen the current administrator state.');
          } else if (index === 0 && !state.bootstrapRetirementAttempted && !bootstrap.retired) throw fail('The bootstrap account is unexpectedly absent. Review its ownership before accepting this handoff.');
          const after = await call(`/admin/realms/master/users?username=${encodeURIComponent(name)}&exact=true`);
          if (!after.ok || (await after.json()).some(u => u.username === name)) throw fail('Temporary administrator removal was not verified.');
        }
        storeProtected(db, full.state.identity.bootstrapRef, { installationId: k.id, retired: true });
        state.handoffFingerprint = sso.fingerprint; state.administratorVerified = true; state.recoveryVerified = true; state.stage = 'verify';
        state.actions = { ...state.actions, administrator: 'Permanent administration, linked SSO and independent recovery verified. The bootstrap credential is retired. Confirm SSO activation to continue.' }; persist();
        return { verification: { state: 'administrator_handoff_verified', label: state.actions.administrator, complete: false } };
      } finally {
        if (grant.refresh_token) await fetcher(`${k.origin}/realms/master/protocol/openid-connect/logout`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: 'admin-cli', refresh_token: grant.refresh_token }).toString() }).catch(() => {});
      }
    });
  } finally { coordinatorJob.fence(); db.prepare('DELETE FROM setup_full_credentials WHERE id=?').run(inputRef); input = null; }
}
