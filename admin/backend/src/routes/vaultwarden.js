import { Router } from 'express';
import { stageRefusal } from '../lib/setup-engine/full-platform-store.js';
import { getDb, logAudit } from '../db.js';
import { requireAdmin, requireSudo } from '../middleware/auth.js';
import { configSchema, applySchema, ceremonySchema, digest } from '../lib/setup-engine/vaultwarden-logic.js';
import { state, readVaultwarden, review, save, apply, currentPlan, recordCeremony, secrets } from '../lib/setup-engine/vaultwarden-store.js';
import { createClient, health, verifyEffective } from '../lib/setup-engine/vaultwarden-api.js';
import { verifyClient } from '../lib/setup-engine/vaultwarden-identity.js';
export const vaultwardenRouter = Router();
vaultwardenRouter.use(requireAdmin, (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
const respond = async (res, fn) => { try { await fn(); } catch (e) { res.status(e.vaultwardenSafe ? e.status : 500).json({ error: e.vaultwardenSafe ? e.message : 'Vaultwarden setup could not be completed. Credentials and upstream details withheld.' }); } };
vaultwardenRouter.get('/', (_req, res) => respond(res, async () => {
  const db = getDb(), r = readVaultwarden(db), s = state(db); let h = r ? await health(createClient(r.config.origin)) : { state: 'not_configured' }, matches = true;
  try { if (r) currentPlan(db, r); } catch { matches = false; }
  // Health alone never upgrades an old verification to a current configuration
  // proof. Full readback happens on explicit apply or the ceremony submission.
  const last = matches && h.state === 'healthy' && s?.lastVerification?.fingerprint === digest(r.config) ? s.lastVerification : null;
  res.json({ state: s, review: review(db), health: h, verification: { state: last ? 'previously_verified' : 'not_verified',
    label: last ? `Configuration last verified at ${last.verifiedAt}. Reapply to check current settings before a new browser test.` : matches ? `Current state: ${h.state}. No current configuration verification.` : 'Saved platform choices are skipped or changed.' } });
}));
vaultwardenRouter.put('/', requireSudo, (req, res) => respond(res, async () => {
  const p = configSchema.safeParse(req.body); req.body = {}; if (!p.success) return res.status(400).json({ error: 'Invalid reviewed Vaultwarden settings; unknown fields are refused.' });
  const s = save(getDb(), p.data); logAudit(req.user.id, 'VAULTWARDEN_SETTINGS_SAVED', 'setup_vaultwarden', '1', { revision: s.revision }, req.ip); res.json({ state: s, review: review(getDb()) });
}));
vaultwardenRouter.post('/apply', requireSudo, (req, res) => respond(res, async () => {{const why=stageRefusal(getDb(),'vaultwarden');if(why)return res.status(409).json({code:'STAGE_LOCKED',error:why});}
  const p = applySchema.safeParse(req.body); if (!p.success) return res.status(400).json({ error: 'Review the current saved Vaultwarden configuration.' });
  const result = apply(getDb(), p.data, req.user.id); logAudit(req.user.id, 'VAULTWARDEN_PLAN_APPLIED', 'setup_job', result.job.id, { created: result.created }, req.ip); res.status(result.created ? 202 : 200).json(result);
}));
vaultwardenRouter.post('/ceremony', requireSudo, (req, res) => respond(res, async () => {
  const p = ceremonySchema.safeParse(req.body); req.body = {}; if (!p.success) return res.status(400).json({ error: 'Record only the required browser observations. Secrets, item contents and free text are refused.' });
  const db = getDb(), r = readVaultwarden(db); if (!r) return res.status(409).json({ error: 'Save and apply Vaultwarden first.' });
  const effective = await verifyEffective(createClient(r.config.origin), r, secrets(db, r)), client = await verifyClient(db, r);
  if (digest([effective.configurationFingerprint, client.fingerprint]) !== p.data.configurationFingerprint) return res.status(409).json({ error: 'Effective configuration changed. Reapply and repeat the browser checks.' });
  const s = recordCeremony(db, p.data, req.user.id); logAudit(req.user.id, 'VAULTWARDEN_BROWSER_OBSERVED', 'setup_vaultwarden', '1', { source: 'operator_observed', revision: s.revision }, req.ip); res.json({ state: s });
}));
