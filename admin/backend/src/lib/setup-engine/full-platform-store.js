import { createHash } from 'node:crypto';
import { z } from 'zod';
import { realmSchema } from './keycloak-logic.js';
import { readPlatformPlan } from './platform-plan.js';
import { SERVICES } from './platform-catalog.js';
import { createJob, getJob, jobView } from './store.js';
import { validateRouteEdgeOptions } from '../caddy-site-file.js';

export const FULL_PLATFORM_APP = 'pp-full-platform';
export const FULL_PLATFORM_SCHEMA = `
CREATE TABLE IF NOT EXISTS setup_full_platform (
 id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL,
 config_json TEXT NOT NULL, state_json TEXT NOT NULL DEFAULT '{}',
 approved_revision INTEGER, plan_revision INTEGER, last_job_id TEXT,
 created_by TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS setup_full_credentials (id TEXT PRIMARY KEY, value TEXT NOT NULL);
`;
export const fail = (message, code = 'FULL_PLATFORM_REVIEW_REQUIRED') => Object.assign(new Error(message), { status: 409, code, fullPlatformSafe: true });
export const digest = value => createHash('sha256').update(JSON.stringify(value) ?? 'undefined').digest('hex');
const origin = z.string().refine(url => { try { const u = new URL(url); return u.origin === url && u.protocol === 'https:' && !u.port && !u.username && !u.password && /^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*$/.test(u.hostname); } catch { return false; } }, 'Use an HTTPS DNS hostname without credentials, port or path.');
const service = z.object({ mode: z.enum(['install', 'connect', 'skip']), url: z.union([origin, z.literal('')]) }).strict();
export const configSchema = z.object({
  experience: z.enum(['full', 'custom']), publicOrigin: origin, recoveryOrigin: origin, realm: realmSchema,
  services: z.object(Object.fromEntries(SERVICES.map(s => [s.id, service]))).strict(),
  recoveryNetworks: z.array(z.string().max(50)).max(30),
}).strict().superRefine((c, ctx) => {
  const hosts = new Set([c.publicOrigin, c.recoveryOrigin]);
  if (hosts.size !== 2) ctx.addIssue({ code: 'custom', message: 'Recovery requires a separate hostname.' });
  for (const [id, s] of Object.entries(c.services)) {
    if (c.experience === 'full' && s.mode === 'skip') ctx.addIssue({ code: 'custom', message: `Full Platform includes ${id}; use Custom to skip a service.` });
    if (s.mode === 'skip') { if (s.url) ctx.addIssue({ code: 'custom', message: `Clear the skipped ${id} address.` }); continue; }
    if (!s.url || hosts.has(s.url)) ctx.addIssue({ code: 'custom', message: `Select a distinct ${id} hostname.` });
    hosts.add(s.url);
  }
  const network = validateRouteEdgeOptions({ ip_allowlist: c.recoveryNetworks });
  if (c.recoveryNetworks.length && (network.error || c.recoveryNetworks.some(n => /\/0$/.test(n)))) ctx.addIssue({ code: 'custom', message: 'Use restricted administrator/VPN networks; unrestricted access is refused.' });
});
export const saveSchema = z.object({ expectedRevision: z.number().int().nonnegative(), config: configSchema, reviewed: z.literal(true) }).strict();
export const jobSchema = z.object({ revision: z.number().int().positive(), operation: z.enum(['administrator', 'retire', 'lifecycle']).optional() }).strict();
export const applySchema = z.object({ revision: z.number().int().positive() }).extend({ reviewToken: z.string().regex(/^[a-f0-9]{64}$/), reviewed: z.literal(true) }).strict();
const has = (db, table) => !!db.prepare('SELECT name FROM sqlite_master WHERE type=\'table\' AND name=?').get(table);
const one = (db, table) => has(db, table) ? db.prepare(`SELECT * FROM ${table} WHERE id=1`).get() : null;
export function readFullPlatform(db) {
  const r = one(db, 'setup_full_platform');
  return r ? { ...r, config: JSON.parse(r.config_json), state: JSON.parse(r.state_json) } : null;
}
export function installedTargets(db) {
  const result = {};
  if (has(db, 'setup_keycloak')) {
    const rows = db.prepare('SELECT * FROM setup_keycloak ORDER BY created_at').all();
    const k = rows.find(r => r.ownership === 'managed') || rows.at(-1);
    if (k) result.keycloak = { mode: k.ownership === 'managed' ? 'install' : 'connect', url: k.origin, realm: k.realm, row: k };
  }
  for (const id of ['pomerium', 'infisical', 'openbao', 'vaultwarden']) {
    const r = one(db, `setup_${id}`);
    if (r) { const c = JSON.parse(r.config_json); result[id] = { mode: c.mode, url: c.origin, row: r }; }
  }
  return result;
}
export function defaults(db) {
  const old = readFullPlatform(db); if (old) return old.config;
  const targets = installedTargets(db), plan = readPlatformPlan(db);
  const admin = db.prepare("SELECT value FROM app_settings WHERE key='admin_domain'").get()?.value;
  const sso = one(db, 'sso_config'), c = sso ? JSON.parse(sso.config_json) : {};
  // Suggestions use discovered hostnames only, never operator examples or an
  // inferred public suffix. An unknown hostname stays empty for the operator.
  const publicOrigin = c.publicOrigin || (admin ? `https://${admin}` : '');
  const linked = has(db, 'provisioned_domains') ? db.prepare('SELECT domain FROM provisioned_domains').all().map(r => r.domain).filter(Boolean) : [];
  const parent = linked.filter(d => admin === d || admin?.endsWith('.' + d)).sort((a,b) => b.length-a.length)[0] || '';
  const adminRoute = has(db, 'service_http_routes') && db.prepare('PRAGMA table_info(service_http_routes)').all().some(c => c.name === 'ip_allowlist_json') ? db.prepare('SELECT ip_allowlist_json FROM service_http_routes WHERE domain=?').get(admin) : null;
  let approvedNetworks = []; try { approvedNetworks = JSON.parse(adminRoute?.ip_allowlist_json || '[]'); } catch {}
  const prefix = { keycloak: 'iam', pomerium: 'access', infisical: 'secrets', openbao: 'bao', vaultwarden: 'vault' };
  const services = Object.fromEntries(SERVICES.map(({ id }) => {
    const existing = targets[id] || (plan.choices[id].mode !== 'skip' ? plan.choices[id] : null);
    return [id, { mode: existing?.mode || 'install', url: existing?.url || (parent ? `https://${prefix[id]}.${parent}` : '') }];
  }));
  return { experience: 'full', publicOrigin, recoveryOrigin: c.recoveryOrigin || (parent ? `https://recovery.${parent}` : ''), realm: targets.keycloak?.realm || plan.choices.keycloak.realm || 'proxypilot', services, recoveryNetworks: c.recoveryNetworks || approvedNetworks };
}
export function changes(old, config) {
  if (!old) return [{ field: 'platform', before: 'No saved setup', after: 'Create the reviewed service connections' }];
  const flat = c => ({ publicOrigin: c.publicOrigin, recoveryOrigin: c.recoveryOrigin, realm: c.realm, experience: c.experience, recoveryNetworks: c.recoveryNetworks.join(', '), ...Object.fromEntries(Object.entries(c.services).map(([id, s]) => [id, `${s.mode} ${s.url}`])) });
  const before = flat(old), after = flat(config);
  return Object.entries(after).filter(([k, v]) => v !== before[k]).map(([field, v]) => ({ field, before: before[field], after: v }));
}
export function validateExisting(db, config) {
  const admin = db.prepare("SELECT value FROM app_settings WHERE key='admin_domain'").get()?.value;
  if (!admin || config.publicOrigin !== `https://${admin}`) throw fail('ProxyPilot must use its current administrator hostname. Change that hostname through the existing domain workflow, then reopen setup.');
  const targets = installedTargets(db);
  for (const [id, target] of Object.entries(targets)) {
    const selected = config.services[id];
    if (selected.mode !== 'skip' && (selected.url !== target.url || selected.mode !== target.mode || id === 'keycloak' && config.realm !== target.realm)) throw fail(`${id}: hostname, ownership or realm migration requires a separate reviewed replacement. Keep this working target; its data and credentials will be retained.`, 'FULL_PLATFORM_MIGRATION_REQUIRED');
  }
  const old = readFullPlatform(db);
  if (old?.approved_revision && digest(old.config.recoveryNetworks) !== digest(config.recoveryNetworks)) throw fail('Recovery restrictions are already bound to the saved service routes. Review their access change and re-verification through the existing route workflow first; this flow preserves the working recovery route.', 'FULL_PLATFORM_MIGRATION_REQUIRED');
  if (old?.approved_revision && ['publicOrigin', 'recoveryOrigin', 'realm'].some(k => old.config[k] !== config[k])) throw fail('Issuer, recovery hostname and passkey RP-ID changes require a separate verified replacement. The current access path is preserved.', 'FULL_PLATFORM_MIGRATION_REQUIRED');
  const routes = db.prepare('SELECT id, domain FROM service_http_routes').all();
  for (const [id, selected] of Object.entries(config.services)) {
    if (selected.mode === 'install' && !targets[id] && routes.some(r => r.domain === new URL(selected.url).hostname)) throw fail(`${id}: this hostname already serves a recorded route. Select an unassigned address.`);
  }
}
export function saveFullPlatform(db, raw, by) {
  const p = saveSchema.parse(raw); db.exec('BEGIN IMMEDIATE');
  try {
    const old = readFullPlatform(db);
    if ((old?.revision || 0) !== p.expectedRevision) throw fail('Setup changed in another session. Reopen the saved plan.', 'PLAN_REVISION_CONFLICT');
    if (old?.last_job_id && ['queued', 'running'].includes(getJob(db, old.last_job_id)?.status)) throw fail('Wait for the current setup operation before editing this plan.');
    validateExisting(db, p.config);
    if (old && !changes(old.config, p.config).length) { db.exec('COMMIT'); return old; }
    db.prepare(`INSERT INTO setup_full_platform(id,revision,config_json,created_by,updated_at) VALUES(1,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,config_json=excluded.config_json,updated_at=excluded.updated_at`)
      .run(p.expectedRevision + 1, JSON.stringify(p.config), String(by), new Date().toISOString());
    db.exec('COMMIT'); return readFullPlatform(db);
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
export function reviewFullPlatform(db, config = null) {
  const r = readFullPlatform(db), wanted = config || r?.config;
  if (!wanted) return null;
  const missing = ['vaultwarden'].filter(id => wanted.services[id].mode !== 'skip' && !has(db, 'setup_vaultwarden'));
  return { revision: r?.revision || 0, reviewToken: r ? digest([r.revision, r.config]) : null,
    changes: changes(config ? r?.config : null, wanted), dependencies: missing.map(id => ({ service: id, reason: 'Vaultwarden schema is unavailable. G7 was merged in main at 6c6f6ff8; run the application’s normal migration/update path. Completed setup work is retained.' })),
    dns: Object.entries({ proxypilot: wanted.publicOrigin, recovery: wanted.recoveryOrigin, ...Object.fromEntries(Object.entries(wanted.services).filter(([, s]) => s.mode !== 'skip').map(([id, s]) => [id, s.url])) }).map(([service, url]) => ({ service, url, action: 'Point this hostname directly at the Caddy host. DNS and valid HTTPS are verified by the service adapters; domain inventory alone is not proof.' })),
    managed: 'Callback URLs, private ports, resource names and protected client references are derived. Caddy retains public ports and TLS.',
    humanSteps: ['Confirm restricted recovery access', 'Create and prove the permanent administrator; enroll a passkey', 'Retain and acknowledge OpenBao recovery material, then manually unseal', 'Complete supported vault unlock and recovery checks'],
  };
}
export function applyFullPlatform(db, raw, by) {
  const p = applySchema.parse(raw); db.exec('BEGIN IMMEDIATE');
  try {
    const r = readFullPlatform(db);
    if (!r || p.revision !== r.revision || p.reviewToken !== digest([r.revision, r.config])) throw fail('Review the current saved setup before applying.');
    validateExisting(db, r.config);
    if (!r.config.recoveryNetworks.length) throw fail('Confirm at least one approved administrator/VPN recovery network before applying. None was found in the existing configuration.');
    const prior = r.last_job_id && getJob(db, r.last_job_id);
    if (prior && ['queued', 'running'].includes(prior.status)) { db.exec('COMMIT'); return { job: jobView(prior), created: false }; }
    const job = createJob(db, { app: FULL_PLATFORM_APP, kind: 'full_platform_apply', plan: { params: { revision: r.revision } }, requestedBy: by, via: 'ui', retryOf: r.last_job_id, reason: 'Reviewed Full Platform setup queued for the existing host runner.' });
    db.prepare('UPDATE setup_full_platform SET approved_revision=revision,last_job_id=? WHERE id=1').run(job.id);
    db.exec('COMMIT'); return { job: jobView(job), created: true };
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
export function fullPlatformState(db) {
  const r = readFullPlatform(db), config = r?.config || defaults(db), targets = installedTargets(db);
  const job = r?.last_job_id ? jobView(getJob(db, r.last_job_id)) : null;
  const services = SERVICES.map(({ id, name }) => {
    const t = targets[id], row = t?.row, current = row?.last_job_id ? jobView(getJob(db, row.last_job_id)) : null;
    const verification = row?.verified_json ? JSON.parse(row.verified_json) : null;
    const available = id !== 'vaultwarden' || has(db, 'setup_vaultwarden');
    const selected = config.services[id].mode !== 'skip';
    const observed = current?.verification;
    const ceremony = id === 'vaultwarden' && row?.ceremony_json ? JSON.parse(row.ceremony_json) : null;
    const needsCeremony = id === 'vaultwarden' && verification && ceremony?.configurationFingerprint !== verification.configurationFingerprint;
    const removed = r?.state?.removed?.[id];
    const state = removed ? 'runtime_removed' : !selected ? 'skipped' : !available ? 'dependency_required' : current && ['failed', 'recovery_required', 'refused'].includes(current.status) ? 'failed' : current && ['queued', 'running'].includes(current.status) ? current.status : needsCeremony || observed?.state === 'awaiting_user_action' ? 'awaiting_user_action' : verification ? 'verified' : row?.resources_json ? 'installed' : row ? 'awaiting_user_action' : 'planned';
    return { id, name, state, available, ownership: t?.mode === 'install' ? 'managed' : t ? 'external' : null, url: config.services[id].url, job: current, verification, action: !available ? 'Waiting for G7 Vaultwarden adapter' : state === 'verified' ? verification.label : needsCeremony ? 'Complete the vault sign-in, unlock and denial checks directly in Vaultwarden.' : observed?.label || r?.state?.actions?.[id] || current?.reason || null };
  });
  // A successful coordinator job is not evidence of service or access completion.
  const sso = one(db, 'sso_config');
  const active = !!sso?.active && r?.state?.handoffFingerprint === sso.fingerprint;
  const complete = r?.approved_revision === r?.revision && services.every(s => s.state === 'skipped' || s.state === 'verified') && r?.state?.administratorVerified === true && r?.state?.recoveryVerified === true && active;
  const stage = complete ? 'complete' : r?.state?.stage || (r?.approved_revision ? 'install' : r ? 'review' : 'domains');
  return { revision: r?.revision || 0, config, review: reviewFullPlatform(db), job, services, stage, complete, state: r?.state || {}, approvedRevision: r?.approved_revision || null, planRevision: r?.plan_revision || null, active };
}
