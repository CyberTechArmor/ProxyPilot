import { queueAdministrator } from '../lib/setup-engine/full-platform-admin.js';
import { Router } from 'express';
import { getDb, logAudit } from '../db.js';
import { requireAdmin, requireSudo } from '../middleware/auth.js';
import { localProofRefusal, requestOrigin } from '../lib/sso/sessions.js';
import { fullPlatformState, saveFullPlatform, applyFullPlatform, approvalDnsRefusal, reviewFullPlatform, configSchema, readFullPlatform, fail } from '../lib/setup-engine/full-platform-store.js';
import { protectedValue, storeProtected } from '../lib/setup-engine/full-platform-keycloak.js';
import { personalSchema, personalRef } from '../lib/setup-engine/full-platform-infisical.js';
import { readInfisical } from '../lib/setup-engine/infisical-store.js';
import { readOpenBao, save as saveBao, idle as baoIdle } from '../lib/setup-engine/openbao-store.js';
import { getJob } from '../lib/setup-engine/store.js';
import { z } from 'zod';
import { lifecycleReview, queueLifecycle } from '../lib/setup-engine/full-platform-lifecycle.js';
import { resetReview, queueReset } from '../lib/setup-engine/full-platform-reset.js';
export const fullPlatformRouter = Router();
fullPlatformRouter.use(requireAdmin);
fullPlatformRouter.use((_req, res, next) => { res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }); next(); });
const handle = fn => async (req, res) => {
  try { await fn(req, res); }
  catch (e) { res.status(e.status || 400).json({ code: e.code || 'FULL_PLATFORM_INPUT', error: e.fullPlatformSafe || e.ssoSafe || e.openbaoSafe || e.infisicalSafe ? e.message : e.name === 'ZodError' ? e.issues.map(i => i.message).join(' ') : 'Setup could not continue. Reopen the saved plan and check the current service step; private provider details are withheld.' }); }
};
fullPlatformRouter.get('/', handle((req, res) => res.json({ ...fullPlatformState(getDb()), administrator: { id: req.user.id, username: req.user.username, email: req.user.email || '' } })));
fullPlatformRouter.post('/review', handle((req, res) => res.json(reviewFullPlatform(getDb(), configSchema.parse(req.body)))));
fullPlatformRouter.post('/lifecycle/review', handle((req, res) => {
  const p = z.object({ service: z.enum(['keycloak','pomerium','infisical','openbao','vaultwarden']), action: z.enum(['repair','reinstall','remove']) }).strict().parse(req.body);
  res.json(lifecycleReview(getDb(), p.service, p.action));
}));
fullPlatformRouter.post('/lifecycle', requireSudo, handle((req, res) => {
  { const refusal = localProofRefusal(getDb(), req.session.id, requestOrigin(req), 'Runtime actions'); if (refusal) return res.status(refusal.status).json(refusal.body); }
  const result = queueLifecycle(getDb(), req.body, req.user.id);
  logAudit(req.user.id, 'FULL_PLATFORM_RUNTIME_ACTION', 'setup_job', result.job.id, { service: req.body.service, action: req.body.action, retainData: true }, req.ip);
  res.status(202).json(result);
}));
// Reset (Platform Setup → Reset Full Platform): the preview is inert; the reset itself needs the
// same fresh local proof as the other runtime actions. The MCP tool
// reset_platform_setup calls the same resetReview/queueReset.
fullPlatformRouter.post('/reset/review', handle((req, res) => {
  const p = z.object({ purgeData: z.boolean().default(false) }).strict().parse(req.body || {});
  res.json(resetReview(getDb(), p));
}));
fullPlatformRouter.post('/reset', requireSudo, handle((req, res) => {
  { const refusal = localProofRefusal(getDb(), req.session.id, requestOrigin(req), 'Reset'); if (refusal) return res.status(refusal.status).json(refusal.body); }
  const result = queueReset(getDb(), req.body, req.user.id);
  logAudit(req.user.id, 'FULL_PLATFORM_RESET_REQUESTED', 'setup_job', result.job.id, { purgeData: req.body.purgeData === true }, req.ip);
  res.status(202).json(result);
}));
fullPlatformRouter.put('/', requireSudo, handle((req, res) => {
  const r = saveFullPlatform(getDb(), req.body, req.user.id);
  logAudit(req.user.id, 'FULL_PLATFORM_PLAN_SAVED', 'setup_full_platform', '1', { revision: r.revision }, req.ip);
  import('./platform-overview.js').then(({ pushVpnDnsSoon }) => pushVpnDnsSoon()).catch(() => {});
  res.json(fullPlatformState(getDb()));
}));
fullPlatformRouter.post('/apply', requireSudo, handle(async (req, res) => {
  const blocked = await approvalDnsRefusal(getDb());
  if (blocked) return res.status(409).json({ code: blocked.code, error: blocked.error, hostnames: blocked.hostnames.map(h => h.hostname) });
  const result = applyFullPlatform(getDb(), req.body, req.user.id);
  logAudit(req.user.id, 'FULL_PLATFORM_APPLIED', 'setup_job', result.job.id, { revision: req.body.revision, created: result.created }, req.ip);
  res.status(result.created ? 202 : 200).json(result);
}));
fullPlatformRouter.post('/administrator', requireSudo, handle((req, res) => {
  { const refusal = localProofRefusal(getDb(), req.session.id, requestOrigin(req), 'The administrator handoff'); if (refusal) return res.status(refusal.status).json(refusal.body); }
  const result = queueAdministrator(getDb(), req.body, req.user);
  logAudit(req.user.id, 'FULL_PLATFORM_ADMINISTRATOR_REQUEST', 'setup_job', result.job.id, { action: req.body.action }, req.ip);
  res.status(202).json(result);
}));
fullPlatformRouter.post('/infisical/administrator', requireSudo, handle((req, res) => {
  const db = getDb();
  { const refusal = localProofRefusal(db, req.session.id, requestOrigin(req), 'Entering a personal credential'); if (refusal) return res.status(refusal.status).json(refusal.body); }
  const p = personalSchema.parse(req.body), full = readFullPlatform(db), r = readInfisical(db);
  if (!full || full.revision !== p.revision || full.approved_revision !== p.revision || !r?.config.basic || r.config.mode !== 'install') throw fail('Apply the reviewed basic Infisical installation first.');
  if (full.last_job_id && ['queued', 'running'].includes(getJob(db, full.last_job_id)?.status)) throw fail('Wait for the current setup operation before entering the personal credential.');
  const result = applyFullPlatform(db, { revision: full.revision, reviewToken: reviewFullPlatform(db).reviewToken, reviewed: true }, req.user.id);
  storeProtected(db, personalRef(r), { email: p.email, password: p.password, expiresAt: Date.now() + 900_000 });
  logAudit(req.user.id, 'INFISICAL_PERSONAL_HANDOFF_REQUESTED', 'setup_job', result.job.id, {}, req.ip);
  res.status(202).json(result);
}));
fullPlatformRouter.post('/openbao/recovery', requireSudo, handle((req, res) => {
  const p = z.object({ revision: z.number().int().positive(), pgpKeys: z.array(z.string()).length(3), rootPgpKey: z.string(), reviewed: z.literal(true) }).strict().parse(req.body);
  const db = getDb(), full = readFullPlatform(db), r = readOpenBao(db);
  if (!full || full.revision !== p.revision || full.approved_revision !== p.revision || !r?.config.basic || r.config.mode !== 'install' || r.init_attempted) throw fail('Recovery recipients can be enrolled only before this owned basic instance is initialized.');
  baoIdle(db, r);
  const { mode, origin, issuer, ...config } = r.config;
  saveBao(db, { ...config, expectedPlanRevision: full.plan_revision, expectedRevision: r.revision, pgpKeys: p.pgpKeys, rootPgpKey: p.rootPgpKey, initialize: true, reviewed: true });
  const result = applyFullPlatform(db, { revision: full.revision, reviewToken: reviewFullPlatform(db).reviewToken, reviewed: true }, req.user.id);
  logAudit(req.user.id, 'OPENBAO_RECIPIENTS_REVIEWED', 'setup_job', result.job.id, {}, req.ip);
  res.status(202).json(result);
}));
fullPlatformRouter.post('/keycloak/reveal', requireSudo, handle((req, res) => {
  const db = getDb();
  // The existing four-hour sliding sudo window alone is insufficient here.
  // Reuse the actual proof timestamp, not sudo_until or the browser's clock.
  { const refusal = localProofRefusal(db, req.session.id, requestOrigin(req), 'Revealing the initial Keycloak password'); if (refusal) return res.status(refusal.status).json(refusal.body); }
  const full = readFullPlatform(db), ref = full?.state?.identity?.bootstrapRef;
  if (!ref) throw fail('Apply the reviewed managed Keycloak connection before revealing its initial password.');
  const value = protectedValue(db, ref);
  if (value.retired) return res.json({ retired: true, label: 'The temporary administrator credential is retired.' });
  const k = db.prepare('SELECT * FROM setup_keycloak WHERE id=?').get(value.installationId);
  if (!k || k.ownership !== 'managed') throw fail('Only this installation’s managed bootstrap credential can be revealed.');
  logAudit(req.user.id, 'KEYCLOAK_BOOTSTRAP_REVEALED', 'setup_keycloak', k.id, {}, req.ip);
  res.json({ username: value.username || 'bootstrap-admin', password: value.password, expiresInSeconds: 30 });
}));
