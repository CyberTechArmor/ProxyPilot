// Application storage API, mounted at /api/app-storage behind the session
// (index.js). Every route needs an administrator; changes (cleanups, policy
// edits) also need sudo, which is the one approval of a cleanup. A storage
// check request is read-only and needs no sudo. Errors are
// { error: { code, message } } with plain messages.
//
// The cleanup endpoints call the cleanup service (WS2) through the injected
// `cleanupService`:
//   requestCleanup({ targetKey, checkId, items, snapshots, exports,
//     acknowledgeSnapshotLoss, scope, origin, userId, ip })
//     → { changed: false, message } | { changed: true, cleanupId, jobId, estimate }
//   getCleanup(id), listCleanups(targetKey, limit)
// Until it is wired, a fallback answers 503 CLEANUP_UNAVAILABLE.

import { z } from 'zod';
import { checkFreshness } from '../lib/app-storage/check-service.js';
import { unavailableCleanupService } from '../lib/app-storage/index.js';
import { targetKeyOf, parseTargetKey } from '../lib/app-storage/targets.js';

export const MEMBERS_SHOWN = 50;
const ID = z.string().regex(/^[a-f0-9]{16}$/, 'an item id from the check');
const CleanupBody = z.object({
  checkId: z.string().regex(/^chk_[a-f0-9-]{36}$/, 'the id of the storage check').optional(),
  items: z.array(ID).max(20_000).default([]),
  snapshots: z.array(ID).max(1_000).default([]),
  exports: z.array(ID).max(1_000).default([]),
  acknowledgeSnapshotLoss: z.boolean().default(false),
  scope: z.enum(['items', 'categories', 'all-eligible']).default('items'),
}).strict();
const PolicyBody = z.object({
  policy: z.record(z.any()),
  expectedRevision: z.number().int().min(0).optional(),
}).strict();

const fail = (code, message, status) => Object.assign(new Error(message), { code, status });

/** The API projection of a check: group members trimmed to the first 50 (all are kept server-side). */
export function projectCheck(check) {
  if (!check) return null;
  return {
    ...check,
    items: (check.items || []).map((it) => (it.kind === 'group' && Array.isArray(it.members) && it.members.length > MEMBERS_SHOWN
      ? { ...it, members: it.members.slice(0, MEMBERS_SHOWN), membersTruncated: true }
      : it)),
  };
}

function cleanupView(c) {
  if (!c) return null;
  const selection = (c.selection || []).map((s) => ({ id: s.id, label: s.label, category: s.category, kind: s.kind, bytes: s.bytes ?? s.allocatedBytes ?? null }));
  return { id: c.id, targetKey: c.targetKey, checkId: c.checkId, status: c.status, origin: c.origin, scope: c.scope, selection, result: c.result ?? null, job: c.job ?? null, jobId: c.jobId ?? null, createdAt: c.createdAt, finishedAt: c.finishedAt ?? null };
}

export function registerAppStorageRoutes(router, { storage, cleanupService = null, requireAdmin, requireSudo, audit = () => {}, now = () => Date.now() } = {}) {
  for (const [name, fn] of Object.entries({ storage, requireAdmin, requireSudo })) {
    if (typeof fn !== 'function' && !(name === 'storage' && fn && typeof fn === 'object')) throw new TypeError(`${name} dependency is required`);
  }
  const svc = async () => (typeof storage === 'function' ? storage() : storage);
  const cleanups = async () => {
    const s = await svc();
    const c = typeof cleanupService === 'function' ? cleanupService() : cleanupService;
    return c || s?.cleanupService?.() || unavailableCleanupService(s?.store || null);
  };
  const wrap = (fn) => async (req, res, next) => {
    try { await fn(req, res); } catch (error) {
      if (res.headersSent) return next(error);
      const status = Number.isInteger(error?.status) ? error.status : error?.code ? 400 : 500;
      const message = status === 500 && !error?.code ? 'The storage request failed.' : (error?.message || 'The storage request failed.');
      res.status(status).json({ error: { code: error?.code || 'APP_STORAGE_FAILED', message, ...(error?.issues ? { issues: error.issues } : {}), ...(error?.ids ? { ids: error.ids } : {}), ...(error?.items ? { items: error.items } : {}) } });
    }
  };
  const keyOf = (req) => {
    const id = String(req.params.id || '');
    if (!['application', 'project'].includes(req.params.kind) || !/^[1-9][0-9]{0,15}$/.test(id)) throw fail('TARGET_NOT_FOUND', 'No such application or project.', 404);
    return parseTargetKey(targetKeyOf(req.params.kind, id)) && targetKeyOf(req.params.kind, id);
  };
  const parseBody = (schema, req) => {
    const r = schema.safeParse(req.body ?? {});
    if (!r.success) throw Object.assign(fail('INVALID_REQUEST', `The request is not valid: ${r.error.issues.slice(0, 5).map((i) => `${i.path.join('.') || 'body'} ${i.message}`).join('; ')}.`, 400), { issues: r.error.issues.slice(0, 10).map((i) => ({ path: i.path.join('.'), message: i.message })) });
    return r.data;
  };
  const userOf = (req) => req.user?.id ?? null;

  router.get('/overview', requireAdmin, wrap(async (req, res) => {
    res.json(await (await svc()).overview());
  }));

  router.get('/targets/:kind/:id', requireAdmin, wrap(async (req, res) => {
    const key = keyOf(req);
    const s = await svc();
    const detail = await s.targetDetail(key);
    let list = [];
    try { list = await (await cleanups()).listCleanups(key, 10) || []; } catch { list = []; }
    res.json({ ...detail, latestCheck: projectCheck(detail.latestCheck), cleanups: list.slice(0, 10).map(cleanupView) });
  }));

  router.post('/targets/:kind/:id/checks', requireAdmin, wrap(async (req, res) => {
    const key = keyOf(req);
    const r = (await svc()).requestCheck(key, { userId: userOf(req), origin: 'user' });
    audit(req, 'STORAGE_CHECK_REQUESTED', key, { checkId: r.checkId, reused: r.reused });
    res.status(202).json(r);
  }));

  router.get('/checks/:checkId', requireAdmin, wrap(async (req, res) => {
    const check = (await svc()).getCheck(String(req.params.checkId));
    if (!check) throw fail('CHECK_NOT_FOUND', 'That storage check does not exist (only the newest 20 per application are kept).', 404);
    res.json(projectCheck(check));
  }));

  router.post('/targets/:kind/:id/cleanups', requireAdmin, requireSudo, wrap(async (req, res) => {
    const key = keyOf(req);
    const s = await svc();
    s.resolveTarget(key);
    const body = parseBody(CleanupBody, req);
    if (!body.items.length && !body.snapshots.length && !body.exports.length) {
      audit(req, 'STORAGE_CLEANUP_NONE', key, { checkId: body.checkId ?? null });
      return res.json({ changed: false, message: 'Nothing was selected, so nothing was changed.' });
    }
    if (!body.checkId) throw fail('INVALID_REQUEST', 'Name the storage check the selection comes from (checkId).', 400);
    const stale = checkFreshness({ check: s.store.getCheck(body.checkId), latest: s.store.latestCheck(key), targetKey: key, now: now() });
    if (stale) throw stale;
    if (body.snapshots.length && body.acknowledgeSnapshotLoss !== true) throw fail('SNAPSHOT_ACK_REQUIRED', 'Deleting a snapshot removes the option to restore to that point. Confirm that you understand before deleting snapshots.', 400);
    const result = await (await cleanups()).requestCleanup({
      targetKey: key, checkId: body.checkId, items: body.items, snapshots: body.snapshots, exports: body.exports,
      acknowledgeSnapshotLoss: body.acknowledgeSnapshotLoss, scope: body.scope, origin: 'user', userId: userOf(req), ip: req.ip ?? null,
    });
    res.status(result?.changed ? 202 : 200).json(result);
  }));

  router.get('/cleanups/:cleanupId', requireAdmin, wrap(async (req, res) => {
    const id = String(req.params.cleanupId || '');
    if (!/^cln_[a-f0-9-]{36}$/.test(id)) throw fail('CLEANUP_NOT_FOUND', 'That cleanup does not exist.', 404);
    const c = await (await cleanups()).getCleanup(id);
    if (!c) throw fail('CLEANUP_NOT_FOUND', 'That cleanup does not exist.', 404);
    res.json(cleanupView(c));
  }));

  router.get('/targets/:kind/:id/policy', requireAdmin, wrap(async (req, res) => {
    const p = (await svc()).getPolicy(keyOf(req));
    res.json(p);
  }));

  router.put('/targets/:kind/:id/policy', requireAdmin, requireSudo, wrap(async (req, res) => {
    const key = keyOf(req);
    const body = parseBody(PolicyBody, req);
    const r = (await svc()).putPolicy(key, body.policy, { userId: userOf(req), expectedRevision: body.expectedRevision });
    audit(req, 'STORAGE_POLICY_CHANGED', key, { revision: r.revision, changed: r.changed, previousSource: r.previousSource });
    res.json({ policy: r.policy, revision: r.revision, source: r.source, proposedRules: r.proposedRules, changed: r.changed });
  }));
}
