// /api/setup — the setup engine's browser-facing surface: OBSERVE jobs and
// locks, and SUBMIT the narrow requests the host runner accepts. Nothing here
// executes a host operation; the runner does (cli/src/setup-runner), and the
// server-side lock and the job record are what every surface (UI, CLI, MCP)
// shares (docs/core/setup-engine-requirements.md R1–R4).
//
//   GET  /api/setup/overview          locks (with stale flags) + recent jobs
//   GET  /api/setup/jobs              ?app=&status=&limit=
//   GET  /api/setup/jobs/:id          the job and its redacted events
//   POST /api/setup/apps/:app/recover  { webPort?, unit?, verifyOnly? }  (sudo)
//   POST /api/setup/jobs/:id/retry     queue the same plan again, reusing what
//                                      the first attempt generated (sudo)
//   POST /api/setup/apps/:app/deploy   submit a deploy for a managed app and
//                                      return its job id (sudo); the job runs
//                                      in the host runner (or in-process when
//                                      none is live) and is observed above
//   POST /api/setup/jobs/:id/cancel    cancel: outright while queued, at the
//                                      next safe checkpoint while running (sudo)

import { Router } from 'express';
import { z } from 'zod';
import { getDb, logAudit } from '../db.js';
import { requireAdmin, requireSudo } from '../middleware/auth.js';
import { engineOverview, jobDetail, requestAppRecovery } from '../lib/setup-engine/backend.js';
import { listJobs, getJob, createJob, jobView, requestCancel } from '../lib/setup-engine/store.js';
import { CONTAINER_NAME_RE, RUNNER_JOB_KINDS, retryPlan, validateRunnerJob, parseJson } from '../lib/setup-engine/logic.js';

export const setupRouter = Router();

setupRouter.get('/overview', requireAdmin, (req, res) => {
  res.json(engineOverview(getDb()));
});

setupRouter.get('/jobs', requireAdmin, (req, res) => {
  const q = z.object({ app: z.string().regex(CONTAINER_NAME_RE).optional(), status: z.string().max(32).optional(), limit: z.coerce.number().int().min(1).max(500).optional() }).safeParse(req.query);
  if (!q.success) return res.status(400).json({ error: q.error.errors[0].message });
  res.json({ jobs: listJobs(getDb(), q.data).map(jobView) });
});

setupRouter.get('/jobs/:id', requireAdmin, (req, res) => {
  const d = jobDetail(getDb(), String(req.params.id));
  if (!d) return res.status(404).json({ error: 'No such job' });
  res.json(d);
});

const recoverSchema = z.object({
  webPort: z.number().int().min(1).max(65535).optional(),
  unit: z.string().regex(/^[A-Za-z0-9@._-]+\.service$/).optional(),
  verifyOnly: z.boolean().optional(),
});

setupRouter.post('/apps/:app/recover', requireAdmin, requireSudo, (req, res) => {
  const app = String(req.params.app || '');
  if (!CONTAINER_NAME_RE.test(app)) return res.status(400).json({ error: 'app must be an Incus guest name' });
  const body = recoverSchema.safeParse(req.body || {});
  if (!body.success) return res.status(400).json({ error: body.error.errors[0].message });
  const { job, created } = requestAppRecovery(getDb(), { app, requestedBy: req.user?.username || req.user?.id || null, via: 'ui', ...body.data });
  const v = validateRunnerJob(job);
  if (!v.ok) return res.status(500).json({ error: v.reason });
  logAudit(req.user?.id || null, 'SETUP_RECOVERY_REQUESTED', 'setup_job', job.id, { app, kind: job.kind, created }, req.ip);
  res.status(created ? 201 : 200).json({ job: jobView(job), created });
});

setupRouter.post('/jobs/:id/retry', requireAdmin, requireSudo, (req, res) => {
  const db = getDb();
  const prior = getJob(db, String(req.params.id));
  if (!prior) return res.status(404).json({ error: 'No such job' });
  if (!RUNNER_JOB_KINDS.includes(prior.kind)) return res.status(400).json({ error: `only runner jobs (${RUNNER_JOB_KINDS.join(', ')}) can be retried here; a ${prior.kind} is retried from its own surface` });
  if (['queued', 'running'].includes(prior.status)) return res.status(409).json({ error: `job ${prior.id} is ${prior.status}` });
  const plan = retryPlan(prior);
  const job = createJob(db, { kind: prior.kind, app: prior.app, plan, configRefs: parseJson(prior.config_refs_json) || {}, requestedBy: req.user?.username || null, via: 'ui', retryOf: prior.id });
  logAudit(req.user?.id || null, 'SETUP_JOB_RETRIED', 'setup_job', job.id, { app: job.app, kind: job.kind, retry_of: prior.id, reuse: plan.reuse.length }, req.ip);
  res.status(201).json({ job: jobView(job) });
});

setupRouter.post('/apps/:app/deploy', requireAdmin, requireSudo, async (req, res) => {
  const app = String(req.params.app || '');
  if (!CONTAINER_NAME_RE.test(app)) return res.status(400).json({ error: 'app must be an Incus guest name' });
  const body = z.object({ webPort: z.number().int().min(1).max(65535).optional() }).safeParse(req.body || {});
  if (!body.success) return res.status(400).json({ error: body.error.errors[0].message });
  // The deploy module resolves the plan's references (contract, secret
  // configs, guard) from the registry; a container the registry does not
  // know deploys with none of them. detach: submit and return.
  const { deployProject } = await import('../mock2/deploy.js');
  const out = await deployProject({ containerName: app, webPort: body.data.webPort, requestedBy: req.user?.username || null, via: 'ui', detach: true });
  logAudit(req.user?.id || null, 'SETUP_DEPLOY_REQUESTED', 'setup_job', out.jobId || null, { app, submitted: !!out.submitted, ok: !!out.ok, step: out.step || null }, req.ip);
  if (out.step === 'runner_unavailable') return res.status(202).json({ jobId: out.jobId, created: out.created, runner: null, executor: 'none', policy: out.policy, status: 'queued', warning: out.error });
  if (!out.ok) return res.status(409).json({ error: out.error || 'deploy refused', step: out.step || null, jobId: out.jobId || null });
  if (out.submitted) return res.status(out.created ? 202 : 200).json({ jobId: out.jobId, created: out.created, runner: out.runner, executor: out.executor, policy: out.policy, status: 'queued' });
  return res.status(200).json({ jobId: out.jobId || null, created: true, runner: null, status: 'finished', result: { ok: out.ok, step: out.step || null, skipped: !!out.skipped } });
});

setupRouter.post('/jobs/:id/cancel', requireAdmin, requireSudo, (req, res) => {
  const db = getDb();
  const prior = getJob(db, String(req.params.id));
  if (!prior) return res.status(404).json({ error: 'No such job' });
  const r = requestCancel(db, { id: prior.id, by: req.user?.username || req.user?.id || 'admin' });
  if (!r.ok) return res.status(409).json({ error: r.reason || 'cannot cancel' });
  logAudit(req.user?.id || null, 'SETUP_JOB_CANCEL_REQUESTED', 'setup_job', prior.id, { app: prior.app, kind: prior.kind, state: r.state }, req.ip);
  res.json({ ok: true, state: r.state, note: r.state === 'requested' ? 'honoured at the next safe checkpoint (before the app is stopped); after that the deploy finishes bringing the app up and the cancel is recorded as declined' : 'cancelled before it started' });
});
