// Mock2 application foundation — the HTTP API of ADOPTION (an existing,
// pre-foundation project moves onto the foundation; foundation-adopt-service.js):
//
//   POST /projects/:id/foundation/adopt/plan      editor          read-only probes → { ok, plan, blockers, plan_token }
//   POST /projects/:id/foundation/adopt           editor + sudo   { plan_token, acknowledge_downtime: true, features? } → 202 { ok, adoption }
//   GET  /projects/:id/foundation/adopt           viewer          { adoption: null | { … } }
//   POST /projects/:id/foundation/adopt/rollback  editor + sudo   → 202 { ok, adoption }
//   POST /projects/:id/foundation/adopt/resume    editor + sudo   → 202 { ok, adoption }
//
// Mounted on the mock2 router (authenticateToken + blockPendingRole + CSRF +
// rate limit already applied); the project access chain is the one every
// project write route uses (requireMock2Role, refuseIfArchived on writes).
// Refusals answer { code, message, options } (+ blockers for PLAN_BLOCKED):
// 400 INVALID_REQUEST / ACKNOWLEDGE_DOWNTIME_REQUIRED, 404 PROJECT_NOT_FOUND /
// NO_ADOPTION, 409 otherwise. The start, rollback and resume are audited as
// MOCK2_FOUNDATION_ADOPT_* with the outcome — never a secret value (the run
// holds none). No MCP tool reaches any of it.
//
// Terminology (risk R7): nothing here is named "agent".

import { z } from 'zod';
import { ADOPT_AUDIT, ADOPT_CODES } from './foundation-adopt-logic.js';

const startSchema = z.object({
  plan_token: z.string().max(200),
  acknowledge_downtime: z.boolean().optional(),
  features: z.object({
    storage: z.enum(['on', 'off']).optional(),
    embeddings: z.enum(['on', 'off']).optional(),
  }).strict().optional(),
}).strict();

function send(res, result, okStatus = 200) {
  if (result && result.ok === false) {
    return res.status(result.status || 409).json({
      code: result.code, message: result.message, options: result.options || [],
      ...(Array.isArray(result.blockers) ? { blockers: result.blockers } : {}),
    });
  }
  const { status, ...body } = result || {};
  return res.status(status || okStatus).json(body);
}

const errorOf = (err, what) => ({ ok: false, status: 500, code: 'FOUNDATION_ADOPT_ERROR', message: `${what} failed: ${String(err?.message || 'unknown error').slice(0, 200)}`, options: [] });

function auditDetail(result, extra = {}) {
  return {
    ...extra,
    outcome: result?.ok === false ? 'refused' : 'started',
    ...(result?.ok === false ? { code: result.code } : {}),
    ...(result?.adoption?.id ? { adoption_id: result.adoption.id, state: result.adoption.state, step: result.adoption.step } : {}),
  };
}

// registerFoundationAdoptRoutes(router, { requireRole, requireSudo, refuseIfArchived, audit, service })
//   service: foundation-adopt-service.js (planAdoption, startAdoption, getAdoption, rollbackAdoption, resumeAdoption)
export function registerFoundationAdoptRoutes(router, deps = {}) {
  const { requireRole, requireSudo, refuseIfArchived, audit, service } = deps;
  for (const [k, v] of Object.entries({ requireRole, requireSudo, refuseIfArchived, audit, service })) {
    if (!v) throw new Error(`registerFoundationAdoptRoutes: the ${k} dependency is required`);
  }
  const svc = typeof service === 'function' ? service : () => service;
  const pid = (req) => Number(req.mock2Project?.id ?? req.params.id);
  const userId = (req) => req.user?.id ?? null;
  const record = (req, action, result, extra) => { try { audit(req, action, pid(req), auditDetail(result, extra)); } catch { /* best effort; the change is recorded on the run */ } };

  router.post('/projects/:id/foundation/adopt/plan', requireRole('editor'), refuseIfArchived, async (req, res) => {
    let result;
    try { result = await svc().planAdoption(pid(req)); } catch (err) { result = errorOf(err, 'The adoption plan'); }
    send(res, result);
  });

  router.post('/projects/:id/foundation/adopt', requireRole('editor'), refuseIfArchived, requireSudo, async (req, res) => {
    const parsed = startSchema.safeParse(req.body || {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const result = { ok: false, status: 400, code: ADOPT_CODES.INVALID_REQUEST, message: `${issue?.path?.join('.') || 'body'}: ${issue?.message || 'invalid'}`, options: [] };
      record(req, ADOPT_AUDIT.start, result, {});
      return send(res, result);
    }
    let result;
    try { result = await svc().startAdoption(pid(req), parsed.data, { userId: userId(req) }); } catch (err) { result = errorOf(err, 'Starting the adoption'); }
    record(req, ADOPT_AUDIT.start, result, {
      acknowledge_downtime: parsed.data.acknowledge_downtime === true,
      features: { storage: parsed.data.features?.storage || 'on', embeddings: parsed.data.features?.embeddings || 'on' },
    });
    send(res, result, 202);
  });

  router.get('/projects/:id/foundation/adopt', requireRole('viewer'), async (req, res) => {
    let result;
    try { result = await svc().getAdoption(pid(req)); } catch (err) { result = errorOf(err, 'Reading the adoption'); }
    if (result?.ok === false) return send(res, result);
    res.json({ adoption: result?.adoption ?? null });
  });

  for (const [path, action, fn, what] of [
    ['rollback', ADOPT_AUDIT.rollback, 'rollbackAdoption', 'The rollback'],
    ['resume', ADOPT_AUDIT.resume, 'resumeAdoption', 'Resuming the adoption'],
  ]) {
    router.post(`/projects/:id/foundation/adopt/${path}`, requireRole('editor'), refuseIfArchived, requireSudo, async (req, res) => {
      let result;
      try { result = await svc()[fn](pid(req), { userId: userId(req) }); } catch (err) { result = errorOf(err, what); }
      record(req, action, result, {});
      send(res, result, 202);
    });
  }
}
