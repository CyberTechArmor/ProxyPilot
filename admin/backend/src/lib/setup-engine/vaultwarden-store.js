import { randomBytes } from 'node:crypto';
import { encryptSecret, decryptSecret, isEncrypted } from '../secrets.js';
import { createJob, getJob, jobView } from './store.js';
import { verifiedProvider } from './pomerium-store.js';
import { issuerFor } from './keycloak-logic.js';
import { configSchema, VAULTWARDEN_APP, VAULTWARDEN_IMAGE, VAULTWARDEN_ROOT, digest, fail, namesFor, callbackFor, expectedSettings, flowAlias } from './vaultwarden-logic.js';
export const VAULTWARDEN_SCHEMA = `CREATE TABLE IF NOT EXISTS setup_vaultwarden(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL,config_json TEXT NOT NULL,credential_ref TEXT NOT NULL,last_job_id TEXT,edge_job_id TEXT,resources_json TEXT,verified_json TEXT,ceremony_json TEXT,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS setup_vaultwarden_credentials(id TEXT PRIMARY KEY,value TEXT NOT NULL);`;
export function readVaultwarden(db) {
  if (!db.prepare("SELECT name FROM sqlite_master WHERE name='setup_vaultwarden'").get()) return null;
  const r = db.prepare('SELECT * FROM setup_vaultwarden WHERE id=1').get();
  return r ? { ...r, config: JSON.parse(r.config_json), resources: r.resources_json ? JSON.parse(r.resources_json) : null } : null;
}
export function secrets(db, r) {
  try { const v = db.prepare('SELECT value FROM setup_vaultwarden_credentials WHERE id=?').get(r.credential_ref)?.value;
    if (!isEncrypted(v)) throw Error(); return JSON.parse(decryptSecret(v));
  } catch { throw fail('Protected Vaultwarden credentials cannot be opened. Restore the matching ProxyPilot database and installation key; never regenerate credentials.'); }
}
function tx(db, fn) { db.exec('BEGIN IMMEDIATE'); try { const v = fn(); db.exec('COMMIT'); return v; } catch (e) { db.exec('ROLLBACK'); throw e; } }
const plan = db => { const p = db.prepare('SELECT * FROM setup_platform_plan WHERE id=1').get(); return p ? { revision: p.revision, ...JSON.parse(p.choices_json).vaultwarden } : null; };
export function currentPlan(db, r) { const p = plan(db); if (!p || p.mode === 'skip' || p.mode !== r.config.mode || p.url !== r.config.origin) throw fail('Vaultwarden is skipped or its saved targets changed. Restore and review the saved choices.'); return p; }
export function state(db) { const r = readVaultwarden(db); return r ? { revision: r.revision, config: r.config, credentialRef: r.credential_ref, resources: r.resources,
  job: r.last_job_id ? jobView(getJob(db, r.last_job_id)) : null, lastVerification: r.verified_json ? JSON.parse(r.verified_json) : null,
  ceremony: r.ceremony_json ? JSON.parse(r.ceremony_json) : null } : null; }
export function save(db, raw) { const p = configSchema.parse(raw); return tx(db, () => {
  const old = readVaultwarden(db);
  if (old?.last_job_id && ['queued', 'running'].includes(getJob(db, old.last_job_id)?.status)) throw fail('Wait for the current Vaultwarden job.');
  if ((old?.revision || 0) !== p.expectedRevision) throw fail('Vaultwarden settings changed. Reopen them.');
  const choice = plan(db);
  if (!choice || choice.revision !== p.expectedPlanRevision || choice.mode === 'skip') throw fail('Save an active Vaultwarden platform plan first.');
  const u = new URL(choice.url);
  if (u.protocol !== 'https:' || u.port || !/^([a-z0-9-]+\.)+[a-z0-9-]+$/.test(u.hostname)) throw fail('Use a dedicated Vaultwarden HTTPS DNS origin on port 443.');
  let k; try { k = verifiedProvider(db, p.connectionId); } catch { throw fail('Select a verified Keycloak provider.'); }
  const configs = ['sso_config', 'setup_pomerium', 'setup_openbao', 'setup_infisical'].flatMap(table => {
    if (!db.prepare('SELECT name FROM sqlite_master WHERE name=?').get(table)) return [];
    return db.prepare(`SELECT config_json FROM ${table}`).all().map(x => JSON.parse(x.config_json));
  });
  if (configs.some(c => [c.clientId, c.readerClientId].includes(p.clientId))) throw fail('Use a separate Vaultwarden Keycloak client; existing service clients are preserved.');
  if (u.origin === k.origin || configs.some(c => [c.origin, c.publicOrigin, c.recoveryOrigin].includes(u.origin)) || db.prepare("SELECT value FROM app_settings WHERE key='admin_domain'").get()?.value === u.hostname) throw fail('Vaultwarden origin conflicts with an existing identity or recovery service.');
  const config = { mode: choice.mode, origin: u.origin, connectionId: k.id, issuer: issuerFor({ url: k.origin, realm: k.realm }), clientId: p.clientId,
    accessRole: p.accessRole, matchExistingEmail: p.matchExistingEmail, allowedIps: [...new Set(p.allowedIps)].sort() };
  if (old) { const s = secrets(db, old); if (digest(config) !== digest(old.config) || p.clientSecret && p.clientSecret !== s.client || p.adminToken && p.adminToken !== s.admin) throw fail('G7 preserves saved targets, account-linking policy and credentials. Rotation, import and retargeting are outside this slice.'); return state(db); }
  if (!p.clientSecret || choice.mode === 'connect' && !p.adminToken) throw fail('Supply the dedicated client credential and, for connect, the existing Vaultwarden admin token for read-only effective configuration checks.');
  if (choice.mode === 'install' && p.adminToken) throw fail('Managed setup creates its own protected administrative credential.');
  const ref = 'vaultwarden-' + randomBytes(12).toString('hex');
  db.prepare('INSERT INTO setup_vaultwarden_credentials VALUES (?,?)').run(ref, encryptSecret(JSON.stringify({ client: p.clientSecret, admin: p.adminToken || randomBytes(32).toString('base64url') })));
  db.prepare('INSERT INTO setup_vaultwarden(id,revision,config_json,credential_ref,created_at) VALUES(1,1,?,?,?)').run(JSON.stringify(config), ref, new Date().toISOString());
  return state(db);
}); }
export function review(db) { const r = readVaultwarden(db); return r ? { revision: r.revision, reviewToken: digest([r.revision, r.config, r.credential_ref]), image: VAULTWARDEN_IMAGE,
  names: namesFor(r), callback: callbackFor(r), flow: flowAlias(r), settings: expectedSettings(r), role: `${r.config.clientId}.${r.config.accessRole}`,
  adminHandoff: r.config.mode === 'install' ? `${VAULTWARDEN_ROOT}/credentials.json` : null,
  changes: ['Saving performs no installation or identity changes. Explicit apply verifies the dedicated Keycloak handoff before managed startup.',
    'Managed install owns only its named private Docker service/network, persistent SQLite data directory, protected configuration and Caddy route. Existing instances receive read-only checks; their owners apply only the listed settings.',
    'SSO-only remains off. Existing password login, accounts and vault keys are preserved. Keycloak authentication and vault unlock are separate.',
    'No master password, recovery code or item content is accepted by this guide. Browser verification happens directly in Vaultwarden.'] } : null; }
export function assertReview(db, input) { const r = readVaultwarden(db), v = review(db); if (!r || r.revision !== input.revision || v.reviewToken !== input.reviewToken || input.reviewed !== true) throw fail('Review the current saved Vaultwarden configuration.'); currentPlan(db, r); return r; }
export function apply(db, input, by) { return tx(db, () => { const r = assertReview(db, input), old = r.last_job_id ? getJob(db, r.last_job_id) : null;
  if (old && ['queued', 'running'].includes(old.status)) return { job: jobView(old), created: false };
  const j = createJob(db, { app: VAULTWARDEN_APP, kind: 'vaultwarden_apply', plan: { params: { revision: r.revision } }, configRefs: { credentials: r.credential_ref }, requestedBy: by, via: 'ui', retryOf: r.last_job_id, reason: 'Reviewed Vaultwarden verification queued. Existing data, keys and login options are preserved.' });
  db.prepare('UPDATE setup_vaultwarden SET last_job_id=?,edge_job_id=NULL,verified_json=NULL WHERE id=1').run(j.id); return { job: jobView(j), created: true };
}); }
export function recordCeremony(db, input, by) { return tx(db, () => { const r = assertReview(db, input), v = r.verified_json && JSON.parse(r.verified_json);
  if (!v || v.configurationFingerprint !== input.configurationFingerprint || v.fingerprint !== digest(r.config) || getJob(db, r.last_job_id)?.status !== 'succeeded') throw fail('Apply and verify the saved effective configuration before recording browser observations.');
  const result = { source: 'operator_observed', configurationFingerprint: v.configurationFingerprint, fingerprint: v.fingerprint, recordedAt: new Date().toISOString(), recordedBy: by,
    browserSso: true, vaultUnlock: true, harmlessItem: true, deniedUser: true, existingLogin: true, accountPreserved: true, disposable: true };
  db.prepare('UPDATE setup_vaultwarden SET ceremony_json=? WHERE id=1').run(JSON.stringify(result)); return state(db);
}); }
