import { createHash } from 'node:crypto';
import { z } from 'zod';
import { realmSchema } from './keycloak-logic.js';
import { readPlatformPlan } from './platform-plan.js';
import { SERVICES } from './platform-catalog.js';
import { createJob, getJob, jobView } from './store.js';
import { validateRouteEdgeOptions } from '../caddy-site-file.js';
import { vpnNetworks, additionalOf, effectiveNetworks, effectiveFor } from './platform-networks.js';
import { dnsRefusal } from './platform-dns.js';
import { AGENT_ROLE_RISK } from './infisical-logic.js';

export const FULL_PLATFORM_APP = 'pp-full-platform';
export const RESET_ROUTES_APP = 'pp-platform-reset-routes';
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
// One path: Full Platform installs and manages all five services as one
// system. The per-service connect/skip choices and the Custom / Advanced
// experience were removed; `mode` stays in the saved shape (always
// "install") because every adapter reads it.
const ONE_PATH = 'Full Platform installs and manages all five services as one system; per-service connect/skip and Custom / Advanced setup are no longer offered.';
const service = z.object({ mode: z.literal('install', { errorMap: () => ({ message: ONE_PATH }) }).default('install'), url: origin }).strict();
const networkList = z.array(z.string().max(50)).max(30);
export const configSchema = z.object({
  experience: z.literal('full', { errorMap: () => ({ message: ONE_PATH }) }).default('full'), publicOrigin: origin, recoveryOrigin: origin, realm: realmSchema,
  services: z.object(Object.fromEntries(SERVICES.map(s => [s.id, service]))).strict(),
  // The operator's additional addresses. The effective allowlist is the
  // built-in VPN networks ∪ these (platform-networks.js).
  additionalNetworks: networkList.optional(),
  // Derived: the effective list as last applied. Accepted on input only from
  // an older client (read as additional addresses minus the VPN ranges).
  recoveryNetworks: networkList.optional(),
}).strict().superRefine((c, ctx) => {
  const hosts = new Set([c.publicOrigin, c.recoveryOrigin]);
  if (hosts.size !== 2) ctx.addIssue({ code: 'custom', message: 'Recovery requires a separate hostname.' });
  for (const [id, s] of Object.entries(c.services)) {
    if (!s.url || hosts.has(s.url)) ctx.addIssue({ code: 'custom', message: `Select a distinct ${id} hostname.` });
    hosts.add(s.url);
  }
  for (const list of [c.additionalNetworks, c.recoveryNetworks]) {
    if (!list?.length) continue;
    const network = validateRouteEdgeOptions({ ip_allowlist: list });
    if (network.error || list.some(n => /\/0$/.test(n))) ctx.addIssue({ code: 'custom', message: 'Use restricted administrator addresses or networks; unrestricted access (/0) is refused.' });
  }
});
export const saveSchema = z.object({ expectedRevision: z.number().int().nonnegative(), config: configSchema, reviewed: z.literal(true) }).strict();
export const jobSchema = z.object({ revision: z.number().int().positive(), operation: z.enum(['administrator', 'retire', 'lifecycle', 'reset', 'keycloak_recovery']).optional() }).strict();
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
    return [id, { mode: 'install', url: existing?.url || (parent ? `https://${prefix[id]}.${parent}` : '') }];
  }));
  const vpn = vpnNetworks(db), additional = (c.recoveryNetworks || approvedNetworks).filter(n => !vpn.includes(n));
  return { experience: 'full', publicOrigin, recoveryOrigin: c.recoveryOrigin || (parent ? `https://recovery.${parent}` : ''), realm: targets.keycloak?.realm || plan.choices.keycloak.realm || 'proxypilot', services, additionalNetworks: additional, recoveryNetworks: effectiveNetworks(vpn, additional) };
}
export function changes(old, config) {
  if (!old) return [{ field: 'platform', before: 'No saved setup', after: 'Create the reviewed service connections' }];
  const flat = c => ({ publicOrigin: c.publicOrigin, recoveryOrigin: c.recoveryOrigin, realm: c.realm, additionalNetworks: additionalOf(c).join(', '), ...Object.fromEntries(Object.entries(c.services).map(([id, s]) => [id, `${s.mode} ${s.url}`])) });
  const before = flat(old), after = flat(config);
  return Object.entries(after).filter(([k, v]) => v !== before[k]).map(([field, v]) => ({ field, before: before[field], after: v }));
}
export function validateExisting(db, config) {
  const admin = db.prepare("SELECT value FROM app_settings WHERE key='admin_domain'").get()?.value;
  if (!admin || config.publicOrigin !== `https://${admin}`) throw fail('ProxyPilot must use its current administrator hostname. Change that hostname through the existing domain workflow, then reopen setup.');
  const targets = installedTargets(db);
  for (const [id, target] of Object.entries(targets)) {
    const selected = config.services[id];
    if (target.mode !== 'install') throw fail(`${id} is connected as an external service. ${ONE_PATH} Remove that external connection before using this setup.`, 'FULL_PLATFORM_MIGRATION_REQUIRED');
    if (selected.url !== target.url || id === 'keycloak' && config.realm !== target.realm) throw fail(`${id}: hostname or realm migration requires a separate reviewed replacement. Keep this working target; its data and credentials will be retained.`, 'FULL_PLATFORM_MIGRATION_REQUIRED');
  }
  const old = readFullPlatform(db), vpn = vpnNetworks(db);
  if (old?.approved_revision && digest(additionalOf(old.config, vpn)) !== digest(additionalOf(config, vpn))) throw fail('The restricted networks are live on the service routes. Change the additional addresses with the restricted-network editor (Platform Setup → Restricted networks, or set_platform_restricted_networks); saving the plan never rewrites the working routes.', 'FULL_PLATFORM_MIGRATION_REQUIRED');
  if (old?.approved_revision && ['publicOrigin', 'recoveryOrigin', 'realm'].some(k => old.config[k] !== config[k])) throw fail('Issuer, recovery hostname and passkey RP-ID changes require a separate verified replacement. The current access path is preserved.', 'FULL_PLATFORM_MIGRATION_REQUIRED');
  const routes = db.prepare('SELECT id, domain FROM service_http_routes').all();
  for (const [id, selected] of Object.entries(config.services)) {
    if (selected.mode === 'install' && !targets[id] && routes.some(r => r.domain === new URL(selected.url).hostname)) throw fail(`${id}: this hostname already serves a recorded route. Select an unassigned address.`);
  }
}
/**
 * The saved shape: always the one path, the operator's additional addresses,
 * and the effective list (VPN ∪ additional) — which, once applied, only the
 * reviewed networks change rewrites.
 */
export function normalizeConfig(db, config, old = readFullPlatform(db)) {
  const vpn = vpnNetworks(db);
  const additional = [...new Set(additionalOf(config, vpn).map(n => String(n).trim()).filter(Boolean))];
  const services = Object.fromEntries(Object.entries(config.services).map(([id, s]) => [id, { mode: 'install', url: s.url }]));
  const recoveryNetworks = old?.approved_revision ? old.config.recoveryNetworks : effectiveNetworks(vpn, additional);
  return { ...config, experience: 'full', services, additionalNetworks: additional, recoveryNetworks };
}
export function saveFullPlatform(db, raw, by) {
  const p = saveSchema.parse(raw); db.exec('BEGIN IMMEDIATE');
  try {
    const old = readFullPlatform(db);
    if ((old?.revision || 0) !== p.expectedRevision) throw fail('Setup changed in another session. Reopen the saved plan.', 'PLAN_REVISION_CONFLICT');
    if (old?.last_job_id && ['queued', 'running'].includes(getJob(db, old.last_job_id)?.status)) throw fail('Wait for the current setup operation before editing this plan.');
    const config = normalizeConfig(db, p.config, old);
    validateExisting(db, config);
    if (old && !changes(old.config, config).length) { db.exec('COMMIT'); return old; }
    db.prepare(`INSERT INTO setup_full_platform(id,revision,config_json,created_by,updated_at) VALUES(1,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,config_json=excluded.config_json,updated_at=excluded.updated_at`)
      .run(p.expectedRevision + 1, JSON.stringify(config), String(by), new Date().toISOString());
    db.exec('COMMIT'); return readFullPlatform(db);
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
export function reviewFullPlatform(db, config = null) {
  const r = readFullPlatform(db), wanted = config || r?.config;
  if (!wanted) return null;
  const missing = ['vaultwarden'].filter(() => !has(db, 'setup_vaultwarden'));
  return { revision: r?.revision || 0, reviewToken: r ? digest([r.revision, r.config]) : null,
    changes: changes(config ? r?.config : null, wanted), dependencies: missing.map(id => ({ service: id, reason: 'Vaultwarden schema is unavailable. G7 was merged in main at 6c6f6ff8; run the application’s normal migration/update path. Completed setup work is retained.' })),
    networks: { vpn: vpnNetworks(db), additional: additionalOf(wanted, vpnNetworks(db)), effective: effectiveFor(db, wanted) },
    stages: STAGES.map(({ id, name }) => ({ id, name })),
    dns: Object.entries({ proxypilot: wanted.publicOrigin, recovery: wanted.recoveryOrigin, ...Object.fromEntries(Object.entries(wanted.services).map(([id, s]) => [id, s.url])) }).map(([service, url]) => ({ service, url, action: 'Point this hostname directly at the Caddy host. DNS and valid HTTPS are verified by the service adapters; domain inventory alone is not proof.' })),
    managed: 'Callback URLs, private ports, resource names and protected client references are derived. Caddy retains public ports and TLS.',
    humanSteps: ['B: reveal the bootstrap password, create the permanent administrator and enroll a passkey, link the ProxyPilot account, test SSO login, step-up and separate-browser recovery, retire the bootstrap account', 'D: the Infisical personal administrator, OpenBao recovery custody and manual unseal, Vaultwarden sign-in/unlock checks', 'E: activate SSO'],
  };
}
// The ProxyPilot and recovery hostnames are fixed at the first apply (changing
// them needs a separate migration, FULL_PLATFORM_MIGRATION_REQUIRED), so both
// must resolve to this Caddy host BEFORE it: a hostname pointing elsewhere
// (e.g. an apex served by another machine) never gets a certificate here, and
// the plan would be stuck with a recovery page nobody can open. Services are
// checked per stage by the coordinator; these two only here.
export const approvalDeps = { check: dnsRefusal }; // tests replace check
export async function approvalDnsRefusal(db, { check = approvalDeps.check, ...opts } = {}) {
  const r = readFullPlatform(db);
  if (!r || r.approved_revision === r.revision) return null;
  const hosts = [r.config.publicOrigin, r.config.recoveryOrigin].filter(Boolean).map(u => new URL(u).hostname);
  const refusal = await check(db, hosts, opts);
  return refusal ? { ...refusal, error: `${refusal.error} The ProxyPilot and recovery hostnames cannot change after apply, so apply waits until they resolve to this host (or save a hostname that does).` } : null;
}
export function applyFullPlatform(db, raw, by, { via = 'ui' } = {}) {
  const p = applySchema.parse(raw); db.exec('BEGIN IMMEDIATE');
  try {
    const r = readFullPlatform(db);
    if (!r || p.revision !== r.revision || p.reviewToken !== digest([r.revision, r.config])) throw fail('Review the current saved setup before applying.');
    validateExisting(db, r.config);
    if (!effectiveFor(db, r.config).length) throw fail('No restricted network is available: the VPN is not enabled here and no additional address is saved. Add at least one administrator address before applying.');
    const stages = platformStages(db);
    if (r.approved_revision === r.revision && stages.current === 'E') throw fail('Every service is installed and verified. Activate SSO in Platform Setup → E (a human, step-up-gated action); there is nothing for the coordinator to queue.', 'STAGE_HUMAN_ONLY');
    if (stages.current === 'complete') throw fail('Full Platform setup is complete; there is nothing to continue.', 'STAGE_COMPLETE');
    const prior = r.last_job_id && getJob(db, r.last_job_id);
    if (prior && ['queued', 'running'].includes(prior.status)) { db.exec('COMMIT'); return { job: jobView(prior), created: false }; }
    const job = createJob(db, { app: FULL_PLATFORM_APP, kind: 'full_platform_apply', plan: { params: { revision: r.revision } }, requestedBy: by, via, retryOf: r.last_job_id, reason: 'Reviewed Full Platform setup queued for the existing host runner.' });
    db.prepare('UPDATE setup_full_platform SET approved_revision=revision,last_job_id=? WHERE id=1').run(job.id);
    db.exec('COMMIT'); return { job: jobView(job), created: true };
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
// The one setup path, in stages. Each stage is actionable only when the one
// before it is verified; the coordinator refuses to queue a later stage early.
//   A  domains, realm, networks → review (saved + applied)
//   B  Keycloak: install and verify, bootstrap reveal, permanent administrator
//      + passkey, account link, SSO login + step-up + separate-browser
//      recovery checks, bootstrap retired. Nothing else installs before this.
//   C  Pomerium
//   D  Infisical, OpenBao, Vaultwarden (each with its human steps)
//   E  verify everything → activate SSO → complete
export const STAGES = Object.freeze([
  { id: 'A', name: 'Domains, realm and networks', services: [] },
  { id: 'B', name: 'Keycloak, permanent administrator and recovery', services: ['keycloak'] },
  { id: 'C', name: 'Pomerium', services: ['pomerium'] },
  { id: 'D', name: 'Infisical, OpenBao and Vaultwarden', services: ['infisical', 'openbao', 'vaultwarden'] },
  { id: 'E', name: 'Verify everything and activate SSO', services: [] },
]);
export const STAGE_OF = Object.freeze(Object.fromEntries(STAGES.flatMap(st => st.services.map(id => [id, st.id]))));
const OPEN_STATES = ['queued', 'running'];
// A service counts as verified for its stage while a re-verification runs;
// a failure or an outstanding human step does not.
const serviceDone = s => !!s?.verification && !['failed', 'awaiting_user_action', 'runtime_removed'].includes(s.state);

export function stagesFrom(r, services, { active, complete }) {
  const by = Object.fromEntries(services.map(s => [s.id, s]));
  const done = {
    A: !!r && r.approved_revision === r.revision,
    B: serviceDone(by.keycloak) && r?.state?.administratorVerified === true && r?.state?.recoveryVerified === true,
    C: serviceDone(by.pomerium),
    D: ['infisical', 'openbao', 'vaultwarden'].every(id => serviceDone(by[id])),
    E: complete && active,
  };
  let current = 'complete';
  for (const st of STAGES) if (!done[st.id]) { current = st.id; break; }
  const currentIndex = STAGES.findIndex(st => st.id === current);
  const opRunning = OPEN_STATES.includes(r?.last_job_status);
  const list = STAGES.map((st, i) => {
    const failing = st.services.map(id => by[id]).filter(x => x?.state === 'failed').map(x => ({ service: x.id, job_id: x.job?.id || null, phase: x.job?.phase || null, reason: x.job?.reason || x.action || 'failed' }));
    if (i === currentIndex && r?.last_job_status && ['failed', 'refused', 'recovery_required'].includes(r.last_job_status) && r.last_job_reason) failing.push({ service: 'coordinator', job_id: r.last_job_id, phase: r.last_job_phase || null, reason: r.last_job_reason });
    const running = st.services.some(id => OPEN_STATES.includes(by[id]?.state)) || (i === currentIndex && opRunning);
    const status = currentIndex < 0 || i < currentIndex ? 'done' : i === currentIndex ? (failing.length ? 'failed' : running ? 'running' : 'current') : 'locked';
    return { id: st.id, name: st.name, services: st.services, status,
      ...(status === 'locked' ? { locked_reason: `Locked until stage ${current} (${STAGES[currentIndex].name}) is verified.` } : {}),
      ...(failing.length ? { failing } : {}) };
  });
  return { current, stages: list };
}

export function fullPlatformState(db) {
  const r = readFullPlatform(db), config = r?.config || defaults(db), targets = installedTargets(db);
  const job = r?.last_job_id ? jobView(getJob(db, r.last_job_id)) : null;
  const services = SERVICES.map(({ id, name }) => {
    const t = targets[id], row = t?.row, current = row?.last_job_id ? jobView(getJob(db, row.last_job_id)) : null;
    const verification = row?.verified_json ? JSON.parse(row.verified_json) : null;
    const available = id !== 'vaultwarden' || has(db, 'setup_vaultwarden');
    const observed = current?.verification;
    const ceremony = id === 'vaultwarden' && row?.ceremony_json ? JSON.parse(row.ceremony_json) : null;
    const needsCeremony = id === 'vaultwarden' && verification && ceremony?.configurationFingerprint !== verification.configurationFingerprint;
    const removed = r?.state?.removed?.[id];
    const state = removed ? 'runtime_removed' : !available ? 'dependency_required' : current && ['failed', 'recovery_required', 'refused'].includes(current.status) ? 'failed' : current && ['queued', 'running'].includes(current.status) ? current.status : needsCeremony || observed?.state === 'awaiting_user_action' ? 'awaiting_user_action' : verification ? 'verified' : row?.resources_json ? 'installed' : row ? 'awaiting_user_action' : 'planned';
    return { id, name, stage: STAGE_OF[id], state, available, risk: id === 'infisical' && (t?.mode === 'install' || !t) ? AGENT_ROLE_RISK : null, ownership: t?.mode === 'install' ? 'managed' : t ? 'external' : null, url: config.services[id].url, job: current, verification, action: !available ? 'Waiting for G7 Vaultwarden adapter' : state === 'verified' ? verification.label : needsCeremony ? 'Complete the vault sign-in, unlock and denial checks directly in Vaultwarden.' : observed?.label || r?.state?.actions?.[id] || current?.reason || null };
  });
  // A successful coordinator job is not evidence of service or access completion.
  const sso = one(db, 'sso_config');
  const active = !!sso?.active && r?.state?.handoffFingerprint === sso.fingerprint;
  const complete = r?.approved_revision === r?.revision && services.every(s => s.state === 'verified') && r?.state?.administratorVerified === true && r?.state?.recoveryVerified === true && active;
  const staged = stagesFrom(r ? { ...r, last_job_status: job?.status || null, last_job_reason: job?.reason || null, last_job_phase: job?.phase || null } : null, services, { active, complete });
  const vpn = vpnNetworks(db);
  const networks = { vpn, additional: additionalOf(config, vpn), effective: effectiveNetworks(vpn, additionalOf(config, vpn)), applied: r?.approved_revision ? (config.recoveryNetworks || []) : null };
  return { revision: r?.revision || 0, config, review: reviewFullPlatform(db), job, services, stage: staged.current, stages: staged.stages, complete, networks, state: r?.state || {}, approvedRevision: r?.approved_revision || null, planRevision: r?.plan_revision || null, active };
}
/**
 * A service job may be queued only in its own stage or a verified earlier
 * one. → null, or the refusal naming the current stage. No saved Full
 * Platform → null (nothing is staged).
 */
export function stageRefusal(db, service) {
  const target = STAGE_OF[service];
  if (!target || !readFullPlatform(db)) return null;
  const { current } = platformStages(db);
  const order = id => (id === 'complete' ? STAGES.length : STAGES.findIndex(st => st.id === id));
  if (order(target) <= order(current)) return null;
  const cur = STAGES.find(st => st.id === current);
  return `${service} belongs to stage ${target} (${STAGES.find(st => st.id === target).name}). The current stage is ${current} (${cur.name}); ${service} is locked until that stage is verified.`;
}
export function assertStage(db, service) { const why = stageRefusal(db, service); if (why) throw fail(why, 'STAGE_LOCKED'); }
export const platformStages = db => { const s = fullPlatformState(db); return { current: s.stage, stages: s.stages }; };

// 3g: Custom / Advanced saved the shared service plan after this Full Platform
// revision recorded it, so the coordinator refuses to continue. The
// coordinator re-syncs the shared plan only for a NEW Full Platform revision,
// and an unchanged save creates none. Resync creates that revision from the
// saved values (nothing else changes); an applied revision stays applied, so
// the next continue re-writes the shared plan from the Full Platform values.
export function resyncReview(db) {
  const full = readFullPlatform(db);
  if (!full) throw fail('No Full Platform setup is saved.');
  const shared = readPlatformPlan(db), blockers = [];
  const inSync = !full.plan_revision || shared.revision === full.plan_revision;
  if (inSync) blockers.push('The shared service plan already matches the one this Full Platform revision recorded; nothing to resync.');
  const prior = full.last_job_id && getJob(db, full.last_job_id);
  if (prior && ['queued', 'running'].includes(prior.status)) blockers.push(`Operation ${prior.id} is ${prior.status}. Wait for it.`);
  return { revision: full.revision, next_revision: full.revision + 1, applied: full.approved_revision === full.revision, shared_plan_revision: shared.revision || null, recorded_plan_revision: full.plan_revision || null, in_sync: inSync, blockers,
    effects: [`Creates Full Platform revision ${full.revision + 1} from the saved values (domains, realm, services and networks unchanged).`, 'On the next continue the coordinator writes the shared service plan from those values again, replacing whatever changed it.', 'No service, route or credential changes until that continue.'] };
}
export function resyncSharedPlan(db, { revision }, by) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const review = resyncReview(db);
    if (Number(revision) !== review.revision) throw fail(`The saved revision is ${review.revision}, not ${revision}. Reopen the saved plan.`, 'PLAN_REVISION_CONFLICT');
    if (review.blockers.length) throw fail(review.blockers.join(' '), 'RESYNC_NOT_NEEDED');
    db.prepare("UPDATE setup_full_platform SET revision=revision+1, approved_revision=CASE WHEN approved_revision=revision THEN revision+1 ELSE approved_revision END, updated_at=? WHERE id=1 AND revision=?").run(new Date().toISOString(), review.revision);
    db.exec('COMMIT');
    return { ...readFullPlatform(db), by: String(by) };
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
