import { randomUUID } from 'node:crypto';
import { OperationsError, parse, revision, schemas } from '../lib/operational-projects-logic.js';

// Sudo is injected (middleware/auth.js requireSudo in the server). Without it
// no approval can pass: the default answers the same sudo_required envelope.
const noSudo = (_req, res) => res.status(401).json({ error: 'sudo_required', sudo_required: true,
  message: 'This action requires sudo re-authentication.' });

// Router and limiter come from the server; never imports the production DB.
// The switches are booleans or getters read on every request (the server passes
// the administrators' toggles, lib/operations-toggles.js), so turning one off
// takes effect at the next request. `agentRuns` (A6) is the supervision service.
// `controlVerified(req)` (A7) says whether this session has made its
// once-per-session agent-control verification (lib/operational-control-grants.js);
// without it nothing is verified, so takeover and reconciliation are refused.
export function createOperationsRouter({ Router, store, enabled = false, agentsEnabled = false, lookupLimiter, evidenceRouter, evidenceEnabled = false,
  agentRuns = null, agentRunsEnabled = true, requireSudo = noSudo, controlVerified = () => false }) {
  const router = Router();
  const on = value => (typeof value === 'function' ? value() : value) === true;
  const opsOn = () => on(enabled), agentsOn = () => opsOn() && on(agentsEnabled);
  const runsEnabled = () => agentsOn() && !!agentRuns && on(agentRunsEnabled);
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  router.get('/capabilities', (req, res) => {
    const ops = opsOn(), runs = runsEnabled();
    res.json({ enabled: ops, stage: 'human-workflow', ui_available: ops,
      evidence_enabled: ops && evidenceEnabled, agents_metadata_enabled: agentsOn(),
      agent_runs_enabled: runs, ...(runs ? { agent_execution_available: agentRuns.execution.available,
        agent_execution_message: agentRuns.execution.message } : {}),
      // Only a hint for the sidebar; the settings routes check the role themselves.
      can_manage_settings: req.user?.role === 'admin' });
  });
  router.use((_req, res, next) => opsOn() ? next() : res.status(404).json({ error: 'Not found' }));
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
  // A6 agent runs: async, and a refusal carries its typed code (and a few typed
  // fields such as the active run or the stale reason) next to the words. Access
  // denials are audited like the other agent routes.
  const agentHandle = (fn, status = 200, denialAction = null) => async (req, res) => {
    try {
      const data = await fn(req, req.operationsActor);
      return res.status(typeof status === 'function' ? status(data) : status).json(data);
    } catch (err) {
      const known = err instanceof OperationsError;
      if (denialAction && known && [401, 403, 404].includes(err.status)) {
        try { store.auditDenied(req.operationsActor, req.params?.id, denialAction, err.status); } catch { /* preserve refusal */ }
      }
      return res.status(known ? err.status : 500).json({
        error: known ? err.message : 'Unable to complete operational request',
        ...(known && err.code ? { code: err.code, ...(err.extra ?? {}) } : {}),
      });
    }
  };
  const agentRunsOnly = (_req, res, next) => runsEnabled() ? next() : res.status(404).json({ error: 'Not found' });
  const expected = req => revision(req.get('If-Match'));
  if (evidenceRouter) router.use('/:id/demonstrations', evidenceRouter);
  const empty = req => parse(schemas.empty, req.body ?? {});
  const agentsOnly = (_req,res,next) => agentsOn() ? next() : res.status(404).json({error:'Not found'});
  router.get('/directory', agentsOnly, handle((r,a)=>store.directory(a,r.query),200,'directory_read'));
  // Human-only: approving needs the session's sudo elevation plus the typed digest.
  router.get('/agent-approvals', agentRunsOnly, agentHandle((_r,a)=>agentRuns.inbox(a),200,'agent_inbox_read'));
  // A7: whether this session already made its agent-control verification.
  router.get('/agent-control', agentRunsOnly, (req, res) => res.json({ verified: controlVerified(req) === true }));
  router.post('/agent-approvals/:approvalId', agentRunsOnly, requireSudo,
    agentHandle((r,a)=>agentRuns.approve(a,r.params.approvalId,r.body,{elevated:true}),200,'agent_approval'));
  router.get('/', handle((r, a) => store.list(a, r.query)));
  router.post('/', handle((r, a) => ({ project: store.create(a, r.body) }), 201));
  router.get('/:id', handle((r, a) => ({ project: store.get(a, r.params.id) })));
  router.patch('/:id', handle((r, a) => store.update(a, r.params.id, expected(r), r.body)));
  router.put('/:id/visibility', agentsOnly, handle((r,a)=>store.visibility(a,r.params.id,expected(r),r.body),200,'visibility_write'));
  router.put('/:id/site', agentsOnly, handle((r,a)=>store.site(a,r.params.id,expected(r),r.body),200,'site_write'));
  router.put('/:id/agent-limits', agentsOnly, handle((r,a)=>store.agentLimits(a,r.params.id,expected(r),r.body),200,'agent_limits_write'));
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
  router.put('/:id/agent-profiles/:profileId/model-guide-consent', agentRunsOnly,
    handle((r,a)=>store.modelGuideConsent(a,r.params.id,r.params.profileId,expected(r),r.body),200,'profile_model_guide_consent'));
  router.put('/:id/agent-profiles/:profileId/model-summary-consent', agentRunsOnly,
    handle((r,a)=>store.modelSummaryConsent(a,r.params.id,r.params.profileId,expected(r),r.body),200,'profile_model_summary_consent'));
  router.get('/:id/agent-profiles/:profileId/rules', agentRunsOnly,
    agentHandle((r,a)=>agentRuns.rules(a,r.params.id,r.params.profileId),200,'profile_rules_read'));
  router.get('/:id/agent-runs', agentRunsOnly, agentHandle((r,a)=>agentRuns.list(a,r.params.id,r.query),200,'agent_runs_read'));
  router.post('/:id/agent-runs', agentRunsOnly, agentHandle((r,a)=>agentRuns.start(a,r.params.id,r.body),201,'agent_run_start'));
  router.get('/:id/agent-runs/:runId', agentRunsOnly, agentHandle((r,a)=>agentRuns.status(a,r.params.id,r.params.runId),200,'agent_run_read'));
  router.post('/:id/agent-runs/:runId/stop', agentRunsOnly, agentHandle((r,a)=>{empty(r);return agentRuns.stop(a,r.params.id,r.params.runId);},
    data=>data.stopping?202:200,'agent_run_stop'));
  router.get('/:id/agent-runs/:runId/view', agentRunsOnly, agentHandle((r,a)=>agentRuns.view(a,r.params.id,r.params.runId),200,'agent_run_view'));
  // A7: resume (a new linked run with the same pins) and reconciliation (a
  // person's typed decision; needs the session's agent-control verification).
  router.post('/:id/agent-runs/:runId/resume', agentRunsOnly, agentHandle((r,a)=>{empty(r);return agentRuns.resume(a,r.params.id,r.params.runId);},
    201,'agent_run_resume'));
  router.post('/:id/agent-runs/:runId/reconcile', agentRunsOnly, agentHandle((r,a)=>agentRuns.reconcile(a,r.params.id,r.params.runId,r.body,
    { verified: controlVerified(r) === true }),200,'agent_run_reconcile'));
  // A7 takeover: control goes to the caller's own open live view (the live
  // WebSocket, routes/agent-live-ws.js); needs the session's agent-control
  // verification. Ending it gives the browser back and ends the run.
  router.post('/:id/agent-runs/:runId/takeover', agentRunsOnly, agentHandle((r,a)=>agentRuns.takeover(a,r.params.id,r.params.runId,r.body,
    { verified: controlVerified(r) === true, sessionId: r.user?.jti ?? null }),200,'agent_run_takeover'));
  router.post('/:id/agent-runs/:runId/takeover/end', agentRunsOnly, agentHandle((r,a)=>{empty(r);return agentRuns.endTakeover(a,r.params.id,r.params.runId);},
    data=>data.stopping?202:200,'agent_run_takeover_end'));
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
