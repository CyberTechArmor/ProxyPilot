import { randomUUID } from 'node:crypto';
import { OperationsError, parse, revision, schemas } from '../lib/operational-projects-logic.js';

// Router and limiter come from the server; never imports the production DB.
export function createOperationsRouter({ Router, store, enabled = false, lookupLimiter, evidenceRouter, evidenceEnabled = false }) {
  const router = Router();
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  router.get('/capabilities', (_req, res) => res.json({ enabled, stage: 'human-workflow', ui_available: enabled, evidence_enabled: enabled && evidenceEnabled }));
  router.use((_req, res, next) => enabled ? next() : res.status(404).json({ error: 'Not found' }));
  router.use((req, res, next) => {
    try {
      req.operationsActor = { ...req.user, requestId: randomUUID() };
      store.assertActor(req.operationsActor);
      next();
    } catch (err) { return res.status(err.status || 500).json({ error: err instanceof OperationsError ? err.message : 'Unable to authorize operational request' }); }
  });
  const handle = (fn, status = 200) => (req, res) => {
    try {
      const data = fn(req, req.operationsActor);
      const rev = data?.revision ?? data?.project?.revision ?? data?.draft?.revision;
      if (rev) res.set('ETag', `"${rev}"`);
      return res.status(status).json(data);
    } catch (err) {
      return res.status(err instanceof OperationsError ? err.status : 500).json({
        error: err instanceof OperationsError ? err.message : 'Unable to complete operational request',
      });
    }
  };
  const expected = req => revision(req.get('If-Match'));
  if (evidenceRouter) router.use('/:id/demonstrations', evidenceRouter);
  const empty = req => parse(schemas.empty, req.body ?? {});
  router.get('/', handle((r, a) => store.list(a, r.query)));
  router.post('/', handle((r, a) => ({ project: store.create(a, r.body) }), 201));
  router.get('/:id', handle((r, a) => ({ project: store.get(a, r.params.id) })));
  router.patch('/:id', handle((r, a) => store.update(a, r.params.id, expected(r), r.body)));
  router.get('/:id/draft', handle((r, a) => ({ draft: store.draft(a, r.params.id) })));
  router.patch('/:id/draft', handle((r, a) => store.saveDraft(a, r.params.id, expected(r), r.body)));
  router.put('/:id/draft/evidence', (_req,res,next)=>evidenceEnabled?next():res.status(404).json({error:'Not found'}),
    handle((r,a)=>store.replaceDraftEvidence(a,r.params.id,expected(r),r.body)));
  router.get('/:id/access', handle((r, a) => store.roster(a, r.params.id)));
  router.get('/:id/access/candidate', lookupLimiter, handle((r, a) => store.candidate(a, r.params.id, r.query)));
  router.put('/:id/members/:userId', handle((r, a) => store.grant(a, r.params.id, r.params.userId, expected(r), r.body)));
  router.delete('/:id/members/:userId', handle((r, a) => { empty(r); return store.remove(a, r.params.id, r.params.userId, expected(r)); }));
  router.post('/:id/archive', handle((r, a) => store.archive(a, r.params.id, expected(r), r.body)));
  router.post('/:id/restore', handle((r, a) => { empty(r); return store.restore(a, r.params.id, expected(r)); }));
  router.post('/:id/ownership-offers', handle((r, a) => store.offer(a, r.params.id, expected(r), r.body), 201));
  router.post('/:id/ownership-offers/:offerId/decision', handle((r, a) => store.decideOffer(a, r.params.id, r.params.offerId, expected(r), r.body)));
  router.get('/:id/events', handle((r, a) => store.events(a, r.params.id, r.query)));
  router.post('/:id/submissions',handle((r,a)=>store.submit(a,r.params.id,expected(r),r.body),201));
  router.get('/:id/submissions/:submissionId',handle((r,a)=>store.submission(a,r.params.id,r.params.submissionId)));
  router.post('/:id/submissions/:submissionId/decision',handle((r,a)=>store.review(a,r.params.id,r.params.submissionId,expected(r),r.body)));
  router.post('/:id/submissions/:submissionId/cancel',handle((r,a)=>store.cancelSubmission(a,r.params.id,r.params.submissionId,expected(r),r.body)));
  router.post('/:id/draft/start-revision',handle((r,a)=>store.startRevision(a,r.params.id,expected(r),r.body)));
  router.get('/:id/versions',handle((r,a)=>store.versions(a,r.params.id,r.query)));
  router.get('/:id/versions/:versionId',handle((r,a)=>store.version(a,r.params.id,r.params.versionId)));
  router.post('/:id/versions/:versionId/withdraw',handle((r,a)=>store.withdraw(a,r.params.id,r.params.versionId,expected(r),r.body)));
  router.get('/:id/runs',handle((r,a)=>store.runs(a,r.params.id,r.query)));
  router.get('/:id/runs/:runId',handle((r,a)=>store.run(a,r.params.id,r.params.runId)));
  router.post('/:id/runs',handle((r,a)=>store.recordRun(a,r.params.id,r.body),201));
  router.post('/:id/runs/:runId/corrections',handle((r,a)=>store.correctRun(a,r.params.id,r.params.runId,r.body),201));
  return router;
}
