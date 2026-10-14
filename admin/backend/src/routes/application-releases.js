// Mounted behind the existing session/CSRF boundary. Guards are mandatory so
// reusing this registration cannot accidentally expose release mutations.
export function registerApplicationReleaseRoutes(router, {
  service, submitJob, listJobs, jobDetail, requireAdmin, requireSudo, audit = () => {},
}) {
  for (const [name, fn] of Object.entries({ service, submitJob, listJobs, jobDetail, requireAdmin, requireSudo })) {
    if (typeof fn !== 'function') throw new TypeError(`${name} dependency is required`);
  }
  const wrap = fn => async (req, res, next) => {
    try { await fn(req, res); } catch (error) {
      if (res.headersSent) return next(error);
      res.status(Number.isInteger(error.status) ? error.status : 400).json({ error: error.message || 'Application release operation failed.', code: error.code, next_action: error.next_action });
    }
  };
  const body = req => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) throw new Error('A JSON object is required.');
    return req.body;
  };
  const application = async (req) => {
    const app = (await service()).getApplication(String(req.params.id));
    if (!app) throw Object.assign(new Error('Application not found.'), { status: 404 });
    return app;
  };
  const sha = req => {
    const value = body(req).sha;
    if (typeof value !== 'string' || !/^[a-f0-9]{40}$/.test(value)) throw new Error('Select an exact 40-character candidate SHA.');
    return value;
  };
  const log = (req, action, appId, result) => audit(req, action, appId, { jobId: result?.job?.id, sha: req.body?.sha });

  router.get('/', requireAdmin, wrap(async (req, res) => {
    const apps = (await service()).listApplications();
    res.json({ applications: req.query.targetId ? apps.filter(a => a.targetId === String(req.query.targetId)) : apps });
  }));
  router.post('/', requireAdmin, requireSudo, wrap(async (req, res) => {
    // Existing application registration never invokes an installer.
    const profile = body(req);
    const app = await (await service()).importApplication({ ...profile, installScript: profile.installScript || null });
    log(req, 'APPLICATION_REGISTERED', app.id);
    res.status(201).json({ application: app });
  }));
  router.get('/:id', requireAdmin, wrap(async (req, res) => res.json({ application: await application(req) })));
  router.put('/:id/profile', requireAdmin, requireSudo, wrap(async (req, res) => {
    await application(req); const value = body(req);
    if (!Number.isInteger(value.expectedRevision) || value.expectedRevision < 1) throw new Error('The current profile revision is required.');
    if (!value.profile || typeof value.profile !== 'object' || Array.isArray(value.profile)) throw new Error('An application profile is required.');
    const app = await (await service()).updateProfile(req.params.id, { ...value.profile, installScript: value.profile.installScript || null }, { expectedRevision: value.expectedRevision });
    log(req, 'APPLICATION_PROFILE_UPDATED', req.params.id);
    res.json({ application: app });
  }));
  router.post('/:id/checkpoint', requireAdmin, requireSudo, wrap(async (req, res) => {
    await application(req); const ref = body(req).ref;
    if (typeof ref !== 'string' || !ref.trim() || ref.length > 200) throw new Error('A source commit or ref is required.');
    const result = await (await service()).checkpoint(req.params.id, { ref: ref.trim() });
    log(req, 'APPLICATION_CHECKPOINTED', req.params.id);
    res.status(201).json(result);
  }));
  router.post('/:id/commit', requireAdmin, requireSudo, wrap(async (req, res) => {
    await application(req); const input = body(req);
    if (typeof input.patch !== 'string' || !input.patch.trim() || Buffer.byteLength(input.patch) > 1_000_000) throw new Error('A unified patch up to 1 MB is required.');
    if (typeof input.message !== 'string' || !input.message.trim() || input.message.length > 2000) throw new Error('A commit message up to 2,000 characters is required.');
    if (typeof input.branch !== 'string' || !input.branch.trim() || input.branch.length > 200) throw new Error('A branch name is required.');
    if (typeof input.expectedParentSha !== 'string' || !/^[a-f0-9]{40}$/.test(input.expectedParentSha)) throw new Error('An exact expected parent SHA is required.');
    const result = await (await service()).commitChanges(req.params.id, { patch: input.patch, message: input.message.trim(), branch: input.branch.trim(), parentSha: input.expectedParentSha });
    log(req, 'APPLICATION_COMMITTED', req.params.id);
    res.status(201).json(result);
  }));
  router.post('/:id/merge', requireAdmin, requireSudo, wrap(async (req, res) => {
    await application(req); const input = body(req);
    if (input.expectedRemoteSha !== null && (typeof input.expectedRemoteSha !== 'string' || !/^[a-f0-9]{40}$/.test(input.expectedRemoteSha))) throw new Error('An exact expected remote SHA, or explicit null for an absent branch, is required.');
    const result = await (await service()).mergeCandidate(req.params.id, { sha: sha(req), expectedRemoteSha: input.expectedRemoteSha });
    log(req, 'APPLICATION_MERGED', req.params.id);
    res.json({ publication: result });
  }));
  router.post('/:id/reconcile', requireAdmin, requireSudo, wrap(async (req, res) => {
    await application(req); const token = body(req).token;
    if (typeof token !== 'string' || !token || token.length > 200) throw new Error('An exact interrupted operation token is required.');
    const result = await (await service()).reconcileOperation(req.params.id, { token });
    log(req, 'APPLICATION_OPERATION_RECONCILED', req.params.id);
    res.json(result);
  }));
  router.post('/:id/prepare', requireAdmin, requireSudo, wrap(async (req, res) => {
    await application(req); const candidate = await (await service()).prepareCandidate(req.params.id, { sha: sha(req) });
    res.json({ prepared: true, appId: candidate.appId, profileRevision: candidate.profile.revision, candidate: candidate.candidate });
  }));
  for (const action of ['validate', 'deploy', 'verify', 'rollback']) {
    router.post(`/:id/${action}`, requireAdmin, requireSudo, wrap(async (req, res) => {
      await application(req);
      const result = await submitJob({ kind: `application_${action}`, appId: req.params.id, sha: sha(req), requestedBy: req.user?.username || req.user?.id || null, via: 'ui' });
      if (result.error) return res.status(409).json({ error: result.error, code: result.code, next_action: result.next_action });
      log(req, `APPLICATION_${action.toUpperCase()}_QUEUED`, req.params.id, result);
      res.status(result.created ? 202 : 200).json(result);
    }));
  }
  for (const [action, method] of [['publish', 'publishCandidate'], ['remote-check', 'verifyRemote']]) {
    router.post(`/:id/${action}`, requireAdmin, requireSudo, wrap(async (req, res) => {
      await application(req); const input = body(req);
      if (input.branch !== undefined && (typeof input.branch !== 'string' || !input.branch.trim() || input.branch.length > 200)) throw new Error('A valid remote branch is required.');
      const result = await (await service())[method](req.params.id, { sha: sha(req), ...(input.branch ? { branch: input.branch.trim() } : {}) });
      log(req, `APPLICATION_${action.toUpperCase()}`, req.params.id);
      res.json({ publication: result });
    }));
  }
  router.get('/:id/jobs', requireAdmin, wrap(async (req, res) => {
    await application(req); res.json({ jobs: await listJobs(req.params.id) });
  }));
  router.get('/:id/jobs/:jobId', requireAdmin, wrap(async (req, res) => {
    await application(req);
    const jobs = await listJobs(req.params.id);
    if (!jobs.some(job => String(job.id) === String(req.params.jobId))) throw Object.assign(new Error('Job not found for this application.'), { status: 404 });
    res.json(await jobDetail(req.params.jobId));
  }));
}
