// G1: saved intentions and bounded read-only checks, never execution requests.
import { Router } from 'express';
import { getDb, logAudit } from '../db.js';
import { requireAdmin, requireSudo } from '../middleware/auth.js';
import { SERVICES, planInputSchema, savePlanSchema, readPlatformPlan, platformState, checkPlatformPlan, savePlatformPlan } from '../lib/setup-engine/platform-plan.js';

export const platformSetupRouter = Router();
platformSetupRouter.use(requireAdmin);
platformSetupRouter.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
const invalid = (res) => res.status(400).json({ error: 'Invalid plan: choose install, connect or skip for each service, with non-secret http(s) origins for selected services. Unknown fields, credentials, URL paths, query strings and fragments are not accepted.' });

platformSetupRouter.get('/', (_req, res, next) => {
  try { res.json({ plan: readPlatformPlan(getDb()), services: SERVICES, installation: platformState(getDb()) }); } catch (err) { next(err); }
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
