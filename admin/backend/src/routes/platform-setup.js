import { openbaoRouter } from './openbao.js';
import { infisicalRouter } from './infisical.js';
import { pomeriumRouter } from './pomerium.js';
import { ssoSetupRouter } from './sso.js';
import { keycloakApplySchema } from '../lib/setup-engine/keycloak-logic.js';
import { applyKeycloak, keycloakState, reviewedKeycloak } from '../lib/setup-engine/keycloak-store.js';
import { runnerAvailable } from '../lib/setup-engine/backend.js';
// G1: saved intentions and bounded read-only checks, never execution requests.
import { Router } from 'express';
import { getDb, logAudit } from '../db.js';
import { requireAdmin, requireSudo } from '../middleware/auth.js';
import { SERVICES, planInputSchema, savePlanSchema, readPlatformPlan, platformState, checkPlatformPlan, savePlatformPlan } from '../lib/setup-engine/platform-plan.js';

export const platformSetupRouter = Router();
platformSetupRouter.use(requireAdmin);
platformSetupRouter.use('/sso', ssoSetupRouter);
platformSetupRouter.use('/pomerium', pomeriumRouter);
platformSetupRouter.use('/infisical', infisicalRouter);
platformSetupRouter.use('/openbao', openbaoRouter);
platformSetupRouter.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
const invalid = (res) => res.status(400).json({ error: 'Invalid plan: choose install, connect or skip for each service, with non-secret http(s) origins for selected services. Unknown fields, credentials, URL paths, query strings and fragments are not accepted.' });

platformSetupRouter.get('/', (_req, res, next) => {
  try { res.json({ plan: readPlatformPlan(getDb()), services: SERVICES, installation: platformState(getDb()), keycloak: keycloakState(getDb()) }); } catch (err) { next(err); }
});
// POST carries the unsaved choices but changes no application/host state.
platformSetupRouter.post('/checks', async (req, res, next) => {
  const input = planInputSchema.safeParse(req.body);
  if (!input.success) return invalid(res);
  try { res.json(await checkPlatformPlan(getDb(), input.data.choices)); } catch (err) { next(err); }
});
platformSetupRouter.put('/', requireSudo, async (req, res, next) => {
  const input = savePlanSchema.safeParse(req.body);
  if (!input.success) return invalid(res);
  try {
    // Evidence is always server-generated for these exact choices, never supplied
    // by the browser. Missing adapters/checks do not prevent saving a plan.
    const checks = await checkPlatformPlan(getDb(), input.data.choices);
    const plan = savePlatformPlan(getDb(), input.data, checks, req.user.username || req.user.id);
    if (!plan) return res.status(409).json({ error: 'This plan changed in another session. Reopen the saved plan before saving again.', code: 'PLAN_REVISION_CONFLICT' });
    logAudit(req.user.id, 'PLATFORM_PLAN_SAVED', 'setup_platform_plan', '1', { revision: plan.revision, schemaVersion: plan.schemaVersion }, req.ip);
    res.json({ plan });
  } catch (err) { next(err); }
});

// Reviewing is read-only. Applying is the sole execution boundary; credentials
// are generated only by the host runner and never returned through these routes.
platformSetupRouter.get('/keycloak/review', (req, res, next) => {
  try { res.json({ review: reviewedKeycloak(getDb(), Number(req.query.revision)) }); }
  catch (e) { if (e.status) return res.status(e.status).json({ code: e.code, error: e.message }); next(e); }
});
platformSetupRouter.post('/keycloak/apply', requireSudo, (req, res, next) => {
  const parsed = keycloakApplySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Review a saved revision before applying Keycloak. Unknown fields are refused.' });
  try {
    const result = applyKeycloak(getDb(), parsed.data, req.user.id, !!runnerAvailable(getDb()));
    logAudit(req.user.id, 'KEYCLOAK_PLAN_APPLIED', 'setup_job', result.job.id, { revision: parsed.data.expectedRevision, created: result.created }, req.ip);
    res.status(result.created ? 202 : 200).json(result);
  } catch (e) { if (e.status) return res.status(e.status).json({ code: e.code, error: e.message }); next(e); }
});
