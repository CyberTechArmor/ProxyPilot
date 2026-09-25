import { randomUUID } from 'node:crypto';
import { OperationsError, parse, revision, schemas } from '../lib/operational-projects-logic.js';

// Router and limiter come from the server; never imports the production DB.
export function createOperationsRouter({ Router, store, enabled = false, agentsEnabled = false, lookupLimiter, evidenceRouter, evidenceEnabled = false }) {
  const router = Router();
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  router.get('/capabilities', (_req, res) => res.json({ enabled, stage: 'human-workflow', ui_available: enabled,
    evidence_enabled: enabled && evidenceEnabled, agents_metadata_enabled: enabled && agentsEnabled }));
  router.use((_req, res, next) => enabled ? next() : res.status(404).json({ error: 'Not found' }));
  router.use((req, res, next) => {
    try {
      req.operationsActor = { ...req.user, requestId: randomUUID() };
      store.assertActor(req.operationsActor);
      next();
    } catch (err) { return res.status(err.status || 500).json({ error: err instanceof OperationsError ? err.message : 'Unable to authorize operational request' }); }
  });
  const handle = (fn, status = 200, denialAction = null) => (req, res) => {
    try {
      const data = fn(req, req.operationsActor);
      const rev = data?.revision ?? data?.project?.revision ?? data?.draft?.revision;
      if (rev) res.set('ETag', `"${rev}"`);
      return res.status(status).json(data);
    } catch (err) {
      if (denialAction && err instanceof OperationsError && err.status >= 400 && err.status < 500) {
        try { store.auditDenied(req.operationsActor,req.params?.id,denialAction,err.status); } catch { /* preserve refusal */ }
      }
      return res.status(err instanceof OperationsError ? err.status : 500).json({
        error: err instanceof OperationsError ? err.message : 'Unable to complete operational request',
      });
    }
  };
  const expected = req => revision(req.get('If-Match'));
  if (evidenceRouter) router.use('/:id/demonstrations', evidenceRouter);
  const empty = req => parse(schemas.empty, req.body ?? {});
  const agentsOnly = (_req,res,next) => agentsEnabled ? next() : res.status(404).json({error:'Not found'});
  router.get('/directory', agentsOnly, handle((r,a)=>store.directory(a,r.query),200,'directory_read'));
  router.get('/', handle((r, a) => store.list(a, r.query)));
  router.post('/', handle((r, a) => ({ project: store.create(a, r.body) }), 201));
  router.get('/:id', handle((r, a) => ({ project: store.get(a, r.params.id) })));
  router.patch('/:id', handle((r, a) => store.update(a, r.params.id, expected(r), r.body)));
  router.put('/:id/visibility', agentsOnly, handle((r,a)=>store.visibility(a,r.params.id,expected(r),r.body),200,'visibility_write'));
  router.put('/:id/site', agentsOnly, handle((r,a)=>store.site(a,r.params.id,expected(r),r.body),200,'site_write'));
  router.post('/:id/access-requests', agentsOnly, handle((r,a)=>{empty(r);return store.request(a,r.params.id);},201,'membership_request'));
  router.get('/:id/access-requests', agentsOnly, handle((r,a)=>store.requests(a,r.params.id),200,'membership_requests_read'));
  router.post('/:id/access-requests/:requestId/decision', agentsOnly,
    handle((r,a)=>store.decideRequest(a,r.params.id,r.params.requestId,expected(r),r.body),200,'membership_decision'));
  router.get('/:id/agent-profiles', agentsOnly, handle((r,a)=>store.profiles(a,r.params.id),200,'profiles_read'));
  router.post('/:id/agent-profiles', agentsOnly, handle((r,a)=>store.createProfile(a,r.params.id,expected(r),r.body),201,'profile_create'));
  router.get('/:id/agent-profiles/:profileId', agentsOnly, handle((r,a)=>store.profile(a,r.params.id,r.params.profileId),200,'profile_read'));
  router.patch('/:id/agent-profiles/:profileId', agentsOnly,
    handle((r,a)=>store.updateProfile(a,r.params.id,r.params.profileId,expected(r),r.body),200,'profile_update'));
  router.put('/:id/agent-profiles/:profileId/guide', agentsOnly,
    handle((r,a)=>store.assignProfile(a,r.params.id,r.params.profileId,expected(r),r.body),200,'profile_guide_assignment'));
  router.delete('/:id/agent-profiles/:profileId', agentsOnly,
    handle((r,a)=>{empty(r);return store.deleteProfile(a,r.params.id,r.params.profileId,expected(r));},200,'profile_delete'));
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
