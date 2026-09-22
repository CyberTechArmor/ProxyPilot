import { randomBytes, generateKeyPairSync, createPrivateKey } from 'node:crypto';
import { encryptSecret, decryptSecret, isEncrypted } from '../secrets.js';
import { readKeycloak } from './keycloak-store.js';
import { issuerFor } from './keycloak-logic.js';
import { createJob, getJob, jobView } from './store.js';
import { digest, pomeriumError as fail, POMERIUM_APP, POMERIUM_PORT, pomeriumConfigSchema, pomeriumRouteSchema } from './pomerium-logic.js';

export const POMERIUM_SCHEMA = `
CREATE TABLE IF NOT EXISTS setup_pomerium (
 id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, config_json TEXT NOT NULL,
 credential_ref TEXT NOT NULL, last_job_id TEXT, edge_job_id TEXT, verified_json TEXT,
 applied_revision INTEGER, resources_json TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS setup_pomerium_credentials (id TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS setup_route_protection (
 route_id TEXT PRIMARY KEY REFERENCES service_http_routes(id) ON DELETE CASCADE,
 intent_json TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','denied','gateway','protected','removing','removal_gateway','removed')),
 revision INTEGER NOT NULL, verified_json TEXT
);
CREATE TRIGGER IF NOT EXISTS pomerium_route_update BEFORE UPDATE ON service_http_routes
 WHEN EXISTS(SELECT 1 FROM setup_route_protection WHERE route_id=OLD.id AND state!='removed')
 BEGIN SELECT RAISE(ABORT, 'Pomerium protection owns this route. Explicitly review removal before editing it.'); END;
CREATE TRIGGER IF NOT EXISTS pomerium_route_delete BEFORE DELETE ON service_http_routes
 WHEN EXISTS(SELECT 1 FROM setup_route_protection WHERE route_id=OLD.id AND state!='removed')
 BEGIN SELECT RAISE(ABORT, 'Pomerium protection requires explicit removal before deleting a route.'); END;
CREATE TRIGGER IF NOT EXISTS pomerium_service_update BEFORE UPDATE OF target_ip,kind,is_admin,runtime ON services
 WHEN EXISTS(SELECT 1 FROM setup_route_protection p JOIN service_http_routes r ON r.id=p.route_id WHERE r.service_id=OLD.id AND p.state!='removed')
 BEGIN SELECT RAISE(ABORT, 'Pomerium protection requires a stable private upstream.'); END;
CREATE TRIGGER IF NOT EXISTS pomerium_service_alias BEFORE UPDATE OF target_ip ON services
 WHEN EXISTS(SELECT 1 FROM setup_route_protection p JOIN service_http_routes r ON r.id=p.route_id JOIN services s ON s.id=r.service_id JOIN service_http_routes a ON a.service_id=NEW.id
 WHERE p.state!='removed' AND s.id!=NEW.id AND NEW.target_ip IN (s.target_ip,'localhost') AND a.target_port=r.target_port)
 BEGIN SELECT RAISE(ABORT, 'Changed service would bypass Pomerium protection.'); END;
CREATE TRIGGER IF NOT EXISTS pomerium_alias_insert BEFORE INSERT ON service_http_routes
 WHEN EXISTS(SELECT 1 FROM setup_route_protection p JOIN service_http_routes r ON r.id=p.route_id JOIN services s ON s.id=r.service_id JOIN services n ON n.id=NEW.service_id
 WHERE p.state!='removed' AND (NEW.domain=r.domain OR (n.target_ip IN (s.target_ip,'localhost') AND NEW.target_port=r.target_port)))
 BEGIN SELECT RAISE(ABORT, 'New route would bypass Pomerium protection.'); END;
CREATE TRIGGER IF NOT EXISTS pomerium_alias_update BEFORE UPDATE ON service_http_routes
 WHEN EXISTS(SELECT 1 FROM setup_route_protection p JOIN service_http_routes r ON r.id=p.route_id JOIN services s ON s.id=r.service_id JOIN services n ON n.id=NEW.service_id
 WHERE p.state!='removed' AND r.id!=NEW.id AND (NEW.domain=r.domain OR (n.target_ip IN (s.target_ip,'localhost') AND NEW.target_port=r.target_port)))
 BEGIN SELECT RAISE(ABORT, 'Changed route would bypass Pomerium protection.'); END;
`;
export function readPomerium(db) {
  if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='setup_pomerium'").get()) return null;
  const r = db.prepare('SELECT * FROM setup_pomerium WHERE id=1').get();
  return r ? { ...r, config: JSON.parse(r.config_json), resources: r.resources_json ? JSON.parse(r.resources_json) : null } : null;
}
export function pomeriumIntents(db) { return db.prepare('SELECT * FROM setup_route_protection ORDER BY route_id').all().map(r => ({ ...JSON.parse(r.intent_json), state: r.state, revision: r.revision, verification: r.verified_json ? JSON.parse(r.verified_json) : null })); }
export function pomeriumState(db) {
  const r = readPomerium(db);
  return r ? { revision: r.revision, config: r.config, credentialRef: r.credential_ref, resources: r.resources,
    job: r.last_job_id ? jobView(getJob(db, r.last_job_id)) : null,
    verification: r.verified_json ? JSON.parse(r.verified_json) : null, intents: pomeriumIntents(db) } : null;
}
export function pomeriumSecrets(db, r) {
  const v = db.prepare('SELECT value FROM setup_pomerium_credentials WHERE id=?').get(r.credential_ref)?.value;
  if (!isEncrypted(v)) throw fail('Protected Pomerium credentials are unavailable; restore the backup reference.');
  try { return JSON.parse(decryptSecret(v)); } catch { throw fail('Protected Pomerium credentials could not be decrypted; restore the backup set.'); }
}
// Connect reads only the supported instance's existing credentials. It never
// rotates global keys or changes sessions belonging to its unrelated routes.
export function preserveExternalSecrets(db,r,actual) {
  const old=pomeriumSecrets(db,r);
  for(const key of ['shared_secret','cookie_secret']) if(typeof actual[key]!=='string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(actual[key]) || Buffer.from(actual[key],'base64').length!==32) throw fail('Existing Core needs explicit 32-byte shared/cookie secrets in its protected config.');
  try { const key=createPrivateKey(Buffer.from(actual.signing_key,'base64')); if(key.asymmetricKeyType!=='ec' || key.asymmetricKeyDetails.namedCurve!=='prime256v1') throw new Error(); } catch { throw fail('Existing Core needs an explicit protected ES256 signing key; no keys were changed.'); }
  const values={shared:actual.shared_secret,cookie:actual.cookie_secret,signing:actual.signing_key};
  if(old.externalCaptured && Object.entries(values).some(([k,v])=>v!==old[k])) throw fail('Existing Core credentials drifted. Restore the recorded set; rotation is outside G4.');
  if(!old.externalCaptured) db.prepare('UPDATE setup_pomerium_credentials SET value=? WHERE id=?').run(encryptSecret(JSON.stringify({...old,...values,externalCaptured:true})),r.credential_ref);
}
export function verifiedProvider(db, id) {
  const k = readKeycloak(db, id), v = k?.verified_json ? JSON.parse(k.verified_json) : null;
  if (!k?.verified_at || !v?.issuerExact || !v?.signingKeys || v.issuer !== issuerFor({ url: k.origin, realm: k.realm })) throw fail('Choose a verified G2 Keycloak connection.');
  return k;
}
function idle(db, r) { if (r?.last_job_id && ['queued','running'].includes(getJob(db, r.last_job_id)?.status)) throw fail('The saved Pomerium operation is still running or waiting. Reopen its progress before making another change.'); }
function transaction(db, fn) { db.exec('BEGIN IMMEDIATE'); try { const r = fn(); db.exec('COMMIT'); return r; } catch(e) { db.exec('ROLLBACK'); throw e; } }
export function savePomerium(db, raw) {
  const input = pomeriumConfigSchema.parse(raw);
  return transaction(db, () => {
    const r = readPomerium(db); idle(db, r);
    if ((r?.revision || 0) !== input.expectedRevision) throw fail('Pomerium configuration changed; reopen it.');
    const plan = db.prepare('SELECT * FROM setup_platform_plan WHERE id=1').get();
    if (plan?.revision !== input.expectedPlanRevision) throw fail('The platform plan changed; save and reopen it first.');
    const choice = JSON.parse(plan.choices_json).pomerium;
    if (choice.mode === 'skip') throw fail('Pomerium is skipped. No setup operation was created.');
    const u = new URL(choice.url);
    if (u.protocol !== 'https:' || u.port || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(u.hostname)) throw fail('Pomerium authentication requires its own HTTPS DNS origin on port 443.');
    const k = verifiedProvider(db, input.connectionId);
    const sso = db.prepare('SELECT config_json FROM sso_config WHERE id=1').get();
    const g3 = sso ? JSON.parse(sso.config_json) : {};
    if ([g3.clientId,g3.readerClientId].includes(input.clientId)) throw fail('Use a separate Pomerium client; the G3 client and observer cannot be reused.');
    const protectedOrigins = [k.origin,g3.publicOrigin,g3.recoveryOrigin].filter(Boolean);
    const admin = db.prepare("SELECT value FROM app_settings WHERE key='admin_domain'").get()?.value;
    if (protectedOrigins.includes(choice.url) || admin === u.hostname) throw fail('Authentication hostname conflicts with Keycloak, ProxyPilot or local recovery.');
    const config = { mode: choice.mode, origin: choice.url, issuer: issuerFor({ url: k.origin, realm: k.realm }), connectionId: k.id,
      clientId: input.clientId, externalContainer: choice.mode === 'connect' ? input.externalContainer : null };
    if (config.mode === 'connect' && !config.externalContainer) throw fail('Existing Core requires its local Docker container name for read-only configuration verification. Remote/split/Enterprise management is unavailable in G4.');
    if (r && JSON.stringify(config) !== JSON.stringify(r.config)) throw fail('This installation identity is already saved. G4 retries preserve it; service migration is outside this slice.');
    if (r) {
      if (input.clientSecret && input.clientSecret !== pomeriumSecrets(db,r).client) throw fail('Retry must preserve the existing client credential; rotation is outside G4.');
      return pomeriumState(db);
    }
    if (!input.clientSecret || input.clientSecret.startsWith('enc:v1:')) throw fail('Enter the dedicated Keycloak client credential once.');
    const credentials = { client: input.clientSecret, shared: randomBytes(32).toString('base64'), cookie: randomBytes(32).toString('base64'),
      signing: Buffer.from(generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' })).toString('base64') };
    const ref = `pomerium-${randomBytes(12).toString('hex')}`;
    db.prepare('INSERT INTO setup_pomerium_credentials VALUES (?,?)').run(ref, encryptSecret(JSON.stringify(credentials)));
    db.prepare('INSERT INTO setup_pomerium(id,revision,config_json,credential_ref,created_at) VALUES (1,1,?,?,?)').run(JSON.stringify(config),ref,new Date().toISOString());
    return pomeriumState(db);
  });
}
export function subjectChoices(db, issuer) {
  return db.prepare('SELECT l.subject,u.username FROM sso_links l JOIN users u ON u.id=l.user_id WHERE l.issuer=? ORDER BY u.username').all(issuer);
}
export function routeSnapshot(db, id, config) {
  const r = db.prepare('SELECT r.*,s.target_ip,s.kind,s.is_admin,s.name,s.runtime FROM service_http_routes r JOIN services s ON s.id=r.service_id WHERE r.id=?').get(id);
  if (!r) throw fail('The selected route no longer exists.');
  const sso = db.prepare('SELECT config_json FROM sso_config WHERE id=1').get();
  const g3 = sso ? JSON.parse(sso.config_json) : {};
  const admin = db.prepare("SELECT value FROM app_settings WHERE key='admin_domain'").get()?.value;
  const excluded = [admin, new URL(config.origin).hostname, new URL(config.issuer).hostname, ...[g3.publicOrigin,g3.recoveryOrigin].filter(Boolean).map(x=>new URL(x).hostname)];
  if (r.is_admin || excluded.includes(r.domain) || r.target_port === 3001 || r.service_id.startsWith('keycloak-') || r.service_id.startsWith('sso-')) throw fail('ProxyPilot, recovery, machine APIs and identity endpoints must remain independent.');
  if (r.kind !== 'container_service' || r.path_prefix !== '/' || r.strip_prefix || !r.ssl_enabled || !r.force_https || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(r.domain)) throw fail('G4 supports a single HTTPS application route at / with no prefix rewrite.');
  if (r.target_ip !== '127.0.0.1' || !Number.isInteger(r.target_port) || r.target_port < 1024 || [POMERIUM_PORT,18082,18083,18084,18080].includes(r.target_port)) throw fail(`Direct-upstream bypass is not contained: ${r.target_ip}:${r.target_port}. G4 supports verified host-loopback application listeners only.`);
  for (const field of ['websocket_enabled','read_timeout_seconds','write_timeout_seconds','host_header_override','basic_auth_json','rate_limit_json']) if (r[field]) throw fail(`Unsupported existing route behavior: ${field}. It will not be removed or weakened.`);
  const aliases = db.prepare('SELECT r.id,r.domain,r.target_port,s.target_ip FROM service_http_routes r JOIN services s ON s.id=r.service_id WHERE r.id!=?').all(id);
  if (aliases.some(a=>a.domain===r.domain || (['127.0.0.1','localhost'].includes(a.target_ip) && a.target_port===r.target_port))) throw fail('Another recorded route shares this hostname or upstream; it would bypass the selected gateway.');
  return r;
}
export function reviewPomeriumRoute(db, raw) {
  const input = pomeriumRouteSchema.parse(raw), r = readPomerium(db);
  if (!r || r.revision !== input.expectedRevision) throw fail('Pomerium revision changed; reopen and review again.');
  verifiedProvider(db,r.config.connectionId);
  const route = routeSnapshot(db,input.routeId,r.config);
  const old = db.prepare('SELECT * FROM setup_route_protection WHERE route_id=?').get(input.routeId);
  const subjects = [...new Set(input.subjects)].sort();
  if (input.action === 'protect') {
    if (!subjects.length) throw fail('Select at least one verified identity; everyone else will be denied.');
    const known = new Set(subjectChoices(db,r.config.issuer).map(x=>x.subject));
    if (subjects.some(s=>!known.has(s))) throw fail('Select identities already verified through G3 for this exact Keycloak issuer.');
  } else if (!old || old.state === 'removed' || subjects.length) throw fail('Removal needs an existing protected/pending route and an empty allow list.');
  const intent = { routeId: route.id, domain: route.domain, upstream: `http://127.0.0.1:${route.target_port}`, action: input.action, subjects,
    snapshot: digest(route), restrictions: { ipAllowlist: route.ip_allowlist_json, headers: route.extra_headers_json, csp: route.csp, maxBodyBytes: route.max_body_bytes, maxUploadSize: route.max_upload_size } };
  return { ...intent, reviewToken: digest([r.revision,r.config,intent]), warning: input.action === 'remove' ? 'This explicitly restores direct Caddy → app access. Existing application authentication and route restrictions remain.' : 'Access will be denied during apply. Host listener, configuration and gateway checks must pass before this route is labelled protected.' };
}
export function savePomeriumRoute(db, input, by) {
  return transaction(db, () => {
    const r = readPomerium(db); idle(db,r);
    const review = reviewPomeriumRoute(db, Object.fromEntries(['expectedRevision','routeId','action','subjects'].map(k=>[k,input[k]])));
    if (!input.reviewed || review.reviewToken !== input.reviewToken) throw fail('Route or policy changed after review. Review the exact route again.');
    const { reviewToken,warning,...intent } = review;
    const revision = r.revision+1;
    db.prepare("INSERT INTO setup_route_protection(route_id,intent_json,state,revision) VALUES (?,?,?,?) ON CONFLICT(route_id) DO UPDATE SET intent_json=excluded.intent_json,state=excluded.state,revision=excluded.revision,verified_json=NULL").run(input.routeId,JSON.stringify(intent),input.action==='remove'?'removing':'pending',revision);
    db.prepare('UPDATE setup_pomerium SET revision=?,verified_json=NULL WHERE id=1').run(revision);
    return queuePomerium(db,revision,by);
  });
}
function queuePomerium(db, revision, by) {
  const r = readPomerium(db);
  if (!r || r.revision !== revision) throw fail('Pomerium revision changed; reopen the saved guide.');
  const plan=db.prepare('SELECT choices_json FROM setup_platform_plan WHERE id=1').get();
  const choice=plan?JSON.parse(plan.choices_json).pomerium:null;
  if(!choice || choice.mode==='skip' || choice.mode!==r.config.mode || choice.url!==r.config.origin) throw fail('Pomerium is skipped or the platform target changed; restore its reviewed choices before applying.');
  const last = r.last_job_id ? getJob(db,r.last_job_id) : null;
  if (last && JSON.parse(last.plan_json).params.revision === revision && ['queued','running','succeeded'].includes(last.status)) return { job: jobView(last), created: false };
  const job = createJob(db,{ app:POMERIUM_APP,kind:'pomerium_apply',plan:{params:{revision}},configRefs:{connection:r.config.connectionId,credentials:r.credential_ref},requestedBy:by,via:'ui',retryOf:r.last_job_id,
    reason:'Reviewed Pomerium intent queued for the independent runner; the browser may close. No backend host fallback.' });
  db.prepare('UPDATE setup_pomerium SET last_job_id=?,edge_job_id=NULL,verified_json=NULL WHERE id=1').run(job.id);
  return { job:jobView(job),created:true };
}
export function applyPomerium(db, revision, by) { return transaction(db,()=>queuePomerium(db,revision,by)); }
