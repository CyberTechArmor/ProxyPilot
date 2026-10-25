// Mock2 application foundation — the HTTP API over one deployment's
// foundation (docs/features/app-foundation.md § "Host API"):
//
//   GET  /projects/:id/foundation                     viewer   the state, health, jobs, warnings
//   POST /projects/:id/foundation/storage             editor + sudo   on | off | switch
//   POST /projects/:id/foundation/embeddings          editor + sudo   on | off | switch
//   POST /projects/:id/foundation/health              editor   run the real probes now
//   GET  /projects/:id/foundation/jobs/:jobId         viewer   job progress
//   POST /projects/:id/foundation/jobs/:jobId/cancel  editor + sudo
//
// Mounted on the mock2 router (already authenticateToken + blockPendingRole +
// CSRF + rate-limited). The project access check is the one every project
// write route uses (requireMock2Role, plus refuseIfArchived on writes).
// Refusals answer 409 { code, message, options } (400 for an invalid request,
// 404 for an unknown job). `credentials` are WRITE-ONLY: accepted in a body,
// stored encrypted, never echoed — responses carry has_secret flags, and the
// audit entry names the credential FIELDS supplied, never a value.
//
// The orchestration is foundation-service.js; the rules foundation-logic.js.
//
// Terminology (risk R7): nothing here is named "agent".

import { z } from 'zod';
import { AUDIT_PREFIX, CODES } from './foundation-logic.js';

const credentialsSchema = z.record(z.string().max(2048)).optional();
const storageSchema = z.object({
  action: z.enum(['on', 'off', 'switch']),
  provider: z.string().max(40).optional(),
  config: z.record(z.any()).optional(),
  credentials: credentialsSchema,
  mode: z.enum(['copy', 'fresh']).optional(),
  acknowledge: z.boolean().optional(),
}).strict();
const embeddingsSchema = z.object({
  action: z.enum(['on', 'off', 'switch']),
  provider: z.string().max(40).optional(),
  config: z.record(z.any()).optional(),
  credentials: credentialsSchema,
}).strict();

function send(res, result, okStatus = 200) {
  if (result && result.ok === false) {
    // job_id (FOUNDATION_JOB_RUNNING) and object_count (STORAGE_HAS_OBJECTS)
    // ride along so the dashboard can offer the cancel / the copy directly.
    return res.status(result.status || 409).json({
      code: result.code, message: result.message, options: result.options || [],
      ...(result.job_id ? { job_id: result.job_id } : {}),
      ...(Number.isInteger(result.object_count) ? { object_count: result.object_count } : {}),
    });
  }
  return res.status(okStatus).json(result);
}

// What an audit entry may say about a request: never a credential value.
function auditDetail(feature, body, result) {
  return {
    feature,
    action: body?.action ?? null,
    provider: body?.provider ?? null,
    mode: body?.mode ?? null,
    acknowledge: body?.acknowledge === true,
    credentials_supplied: body?.credentials && typeof body.credentials === 'object' ? Object.keys(body.credentials).sort() : [],
    outcome: result?.ok === false ? 'refused' : (result?.noop ? 'noop' : (result?.job ? 'job_started' : 'applied')),
    ...(result?.ok === false ? { code: result.code } : {}),
    ...(result?.job?.id ? { job_id: result.job.id } : {}),
  };
}

// registerFoundationRoutes(router, { requireRole, requireSudo, refuseIfArchived, audit, service })
//   requireRole(minRole) → middleware (mock2 authz.requireMock2Role)
//   audit(req, action, projectId, detail)
//   service: the foundation-service.js module (injected for tests)
export function registerFoundationRoutes(router, deps = {}) {
  const { requireRole, requireSudo, refuseIfArchived, audit, service } = deps;
  for (const [k, v] of Object.entries({ requireRole, requireSudo, refuseIfArchived, audit, service })) {
    if (!v) throw new Error(`registerFoundationRoutes: the ${k} dependency is required`);
  }
  const svc = typeof service === 'function' ? service : () => service;
  const pid = (req) => Number(req.mock2Project?.id ?? req.params.id);

  router.get('/projects/:id/foundation', requireRole('viewer'), async (req, res) => {
    try {
      const foundation = await svc().getFoundation(pid(req), { refresh: true });
      if (!foundation) return res.status(404).json({ code: CODES.PROJECT_NOT_FOUND, message: 'Project not found', options: [] });
      res.json(foundation);
    } catch (err) {
      res.status(500).json({ code: 'FOUNDATION_ERROR', message: `Could not read the foundation: ${String(err?.message || 'unknown error').slice(0, 200)}`, options: [] });
    }
  });

  for (const feature of ['storage', 'embeddings']) {
    const schema = feature === 'storage' ? storageSchema : embeddingsSchema;
    router.post(`/projects/:id/foundation/${feature}`, requireRole('editor'), refuseIfArchived, requireSudo, async (req, res) => {
      const parsed = schema.safeParse(req.body || {});
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return res.status(400).json({ code: CODES.INVALID_REQUEST, message: `${issue?.path?.join('.') || 'body'}: ${issue?.message || 'invalid'}`, options: [] });
      }
      let result;
      try {
        result = await svc().featureAction(pid(req), feature, parsed.data, { userId: req.user?.id ?? null });
      } catch (err) {
        result = { ok: false, status: 500, code: 'FOUNDATION_ERROR', message: `The ${feature} change failed: ${String(err?.message || 'unknown error').slice(0, 200)}`, options: [] };
      }
      try { audit(req, `${AUDIT_PREFIX}${feature.toUpperCase()}_${parsed.data.action.toUpperCase()}`, pid(req), auditDetail(feature, parsed.data, result)); } catch { /* audit is best effort here; the write happened */ }
      send(res, result, result?.job ? 202 : 200);
    });
  }

  router.post('/projects/:id/foundation/health', requireRole('editor'), refuseIfArchived, async (req, res) => {
    try {
      const result = await svc().runHealth(pid(req));
      if (result?.ok === false) return send(res, result);
      res.json(result.foundation);
    } catch (err) {
      res.status(500).json({ code: 'FOUNDATION_ERROR', message: `The health probe failed: ${String(err?.message || 'unknown error').slice(0, 200)}`, options: [] });
    }
  });

  router.get('/projects/:id/foundation/jobs/:jobId', requireRole('viewer'), async (req, res) => {
    try {
      const job = await svc().getJob(pid(req), String(req.params.jobId || ''), { refresh: true });
      if (!job) return res.status(404).json({ code: CODES.JOB_NOT_FOUND, message: 'Job not found', options: [] });
      res.json({ job });
    } catch (err) {
      res.status(500).json({ code: 'FOUNDATION_ERROR', message: `Could not read the job: ${String(err?.message || 'unknown error').slice(0, 200)}`, options: [] });
    }
  });

  router.post('/projects/:id/foundation/jobs/:jobId/cancel', requireRole('editor'), refuseIfArchived, requireSudo, async (req, res) => {
    let result;
    try {
      result = await svc().cancelJob(pid(req), String(req.params.jobId || ''));
    } catch (err) {
      result = { ok: false, status: 500, code: 'FOUNDATION_ERROR', message: `The cancel failed: ${String(err?.message || 'unknown error').slice(0, 200)}`, options: [] };
    }
    try {
      audit(req, `${AUDIT_PREFIX}JOB_CANCEL`, pid(req), { job_id: String(req.params.jobId || '').slice(0, 64), outcome: result?.ok === false ? 'refused' : 'cancelled', ...(result?.ok === false ? { code: result.code } : { app_cancelled: !!result.app_cancelled }) });
    } catch { /* best effort */ }
    send(res, result);
  });
}
