// Platform overview (Part 2) and the mcp.platform toggle (Part 1) — the
// dashboard side. Mounted under /api/setup/platform/overview (admin-only via
// platformSetupRouter). Every handler calls the same function its MCP tool
// calls (lib/setup-engine/platform-overview.js, full-platform-networks.js,
// full-platform-store.js resync*, full-platform-kc-recovery.js,
// lib/platform-mcp-flag.js); this file adds only authentication, the audit
// entry and the HTTP shape. Dashboard actions are NOT gated by mcp.platform.

import { Router } from 'express';
import { getDb, logAudit } from '../db.js';
import { requireAdmin, requireSudo } from '../middleware/auth.js';
import { requireLocalProof, requestOrigin } from '../lib/sso/sessions.js';
import { runHostCapture } from '../lib/lxc-zip.js';
import { platformOverview, serviceOverview, serviceLogs, servicePreflight, verifyService, retryService, containerControlReview, controlContainer, SERVICE_NAMES } from '../lib/setup-engine/platform-overview.js';
import { networksReview, queueNetworksChange } from '../lib/setup-engine/full-platform-networks.js';
import { resyncReview, resyncSharedPlan } from '../lib/setup-engine/full-platform-store.js';
import { recoveryReview, queueRecovery } from '../lib/setup-engine/full-platform-kc-recovery.js';
import { platformFlagState, setPlatformFlag } from '../lib/platform-mcp-flag.js';

export const platformOverviewRouter = Router();
platformOverviewRouter.use(requireAdmin);
platformOverviewRouter.use((_req, res, next) => { res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }); next(); });

export const hostRun = (argv, timeoutMs = 30000) => runHostCapture(argv[0], argv.slice(1), { timeoutMs });
const SERVICES = Object.keys(SERVICE_NAMES);
const handle = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (e) {
    const safe = e?.fullPlatformSafe || e?.ssoSafe || e?.openbaoSafe || e?.infisicalSafe || e?.vaultwardenSafe || e?.pomeriumSafe;
    res.status(e?.status && e.status < 500 ? e.status : safe ? 409 : 400).json({ code: e?.code || 'PLATFORM_OVERVIEW', error: safe || e?.status ? e.message : e?.name === 'ZodError' ? e.issues.map((i) => i.message).join(' ') : 'The platform action could not be completed; private details are withheld.', ...(e?.detail ? { detail: e.detail } : {}) });
  }
};
const service = (req) => { const s = String(req.params.service || ''); if (!SERVICES.includes(s)) throw Object.assign(new Error(`Unknown service ${s}.`), { status: 404 }); return s; };
const localProof = (req, res, what) => {
  try { requireLocalProof(getDb(), req.session.id, requestOrigin(req)); return true; }
  catch { res.status(403).json({ error: 'sudo_required', sudo_required: true, message: `${what} requires fresh local administrator proof within five minutes.` }); return false; }
};

/* ------------------------------ overview + flag --------------------------- */

platformOverviewRouter.get('/', handle(async (req, res) => res.json(await platformOverview(getDb(), { run: hostRun, fresh: req.query.refresh === '1' }))));
platformOverviewRouter.get('/flag', handle((_req, res) => res.json(platformFlagState(getDb()))));
platformOverviewRouter.put('/flag', requireSudo, handle((req, res) => {
  const enabled = req.body?.enabled;
  if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be true or false.' });
  // setPlatformFlag writes the FEATURE_FLAG_CHANGED audit row itself (who, old, new, time).
  res.json(setPlatformFlag(getDb(), enabled, req.user, req.ip));
}));

/* -------------------------------- per service ----------------------------- */

platformOverviewRouter.get('/services/:service', handle(async (req, res) => res.json(await serviceOverview(getDb(), service(req), { run: hostRun, fresh: req.query.refresh === '1' }))));
platformOverviewRouter.get('/services/:service/logs', handle(async (req, res) => {
  const s = service(req);
  const out = await serviceLogs(getDb(), s, { run: hostRun, lines: Number(req.query.lines) === 200 ? 200 : 50, container: req.query.container ? String(req.query.container) : null });
  logAudit(req.user.id, 'PLATFORM_LOGS_VIEWED', 'platform_service', s, { lines: out.lines, container: req.query.container || null }, req.ip);
  res.json(out);
}));
platformOverviewRouter.post('/services/:service/preflight', handle(async (req, res) => {
  const s = service(req), out = await servicePreflight(getDb(), s, { run: hostRun });
  logAudit(req.user.id, 'PLATFORM_PREFLIGHT', 'platform_service', s, { ready: out.ready }, req.ip);
  res.json(out);
}));
platformOverviewRouter.post('/services/:service/verify', handle(async (req, res) => {
  const s = service(req), out = await verifyService(getDb(), s, { run: hostRun });
  logAudit(req.user.id, 'PLATFORM_VERIFY', 'platform_service', s, { ok: out.ok }, req.ip);
  res.json(out);
}));
platformOverviewRouter.post('/services/:service/retry', requireSudo, handle(async (req, res) => {
  const s = service(req), out = await retryService(getDb(), s, req.user.id);
  logAudit(req.user.id, 'FULL_PLATFORM_SERVICE_RETRY', 'setup_job', out.job.id, { service: s, via: 'ui' }, req.ip);
  res.status(202).json(out);
}));
platformOverviewRouter.post('/services/:service/containers/review', handle(async (req, res) => {
  res.json(await containerControlReview(getDb(), { service: service(req), container: String(req.body?.container || ''), action: String(req.body?.action || '') }, hostRun));
}));
platformOverviewRouter.post('/services/:service/containers', requireSudo, handle(async (req, res) => {
  const s = service(req), action = String(req.body?.action || ''), container = String(req.body?.container || '');
  if (req.body?.reviewed !== true) return res.status(400).json({ error: 'Review the action first.' });
  if (action !== 'start' && !localProof(req, res, `${action[0]?.toUpperCase() || ''}${action.slice(1)}`)) return;
  const out = await controlContainer(getDb(), { service: s, container, action, reviewToken: String(req.body?.reviewToken || '') }, hostRun);
  logAudit(req.user.id, 'PLATFORM_CONTAINER_CONTROL', 'platform_service', s, { container, action, container_id: out.container_id, via: 'ui' }, req.ip);
  res.json(out);
}));

/* ---------------------------- section-level actions ----------------------- */

// Additional addresses (the VPN networks are derived and not editable here).
// Allowed at any time — also after SSO is active — behind fresh local step-up
// (local password + TOTP or local passkey), with an audit record per change.
platformOverviewRouter.post('/networks/review', handle((req, res) => res.json(networksReview(getDb(), req.body?.additionalNetworks))));
platformOverviewRouter.post('/networks', requireSudo, handle(async (req, res) => {
  if (!localProof(req, res, 'Changing the restricted networks')) return;
  const out = queueNetworksChange(getDb(), req.body, req.user.id);
  logAudit(req.user.id, 'FULL_PLATFORM_NETWORKS_CHANGE', 'setup_job', out.job.id, { vpn: out.review.vpn_networks, additional_before: out.review.before_additional, additional_after: out.review.additional_networks, before: out.review.before, after: out.review.after, via: 'ui' }, req.ip);
  import('../mock2/ops.js').then(({ drainBackendStepsNow }) => drainBackendStepsNow?.()).catch(() => {});
  res.status(202).json({ job: out.job, created: out.created });
}));
platformOverviewRouter.post('/resync/review', handle((_req, res) => res.json(resyncReview(getDb()))));
platformOverviewRouter.post('/resync', requireSudo, handle((req, res) => {
  const out = resyncSharedPlan(getDb(), { revision: Number(req.body?.revision) }, req.user.id);
  logAudit(req.user.id, 'FULL_PLATFORM_PLAN_RESYNCED', 'setup_full_platform', '1', { from: Number(req.body?.revision), revision: out.revision, via: 'ui' }, req.ip);
  res.json({ revision: out.revision, approved_revision: out.approved_revision });
}));
platformOverviewRouter.post('/keycloak/recover/review', handle((_req, res) => res.json(recoveryReview(getDb()))));
platformOverviewRouter.post('/keycloak/recover', requireSudo, handle((req, res) => {
  if (!localProof(req, res, 'Keycloak bootstrap recovery')) return;
  const out = queueRecovery(getDb(), req.body || {}, req.user.id);
  logAudit(req.user.id, 'KEYCLOAK_BOOTSTRAP_RECOVERY_REQUESTED', 'setup_job', out.job.id, { via: 'ui' }, req.ip);
  res.status(202).json(out);
}));
