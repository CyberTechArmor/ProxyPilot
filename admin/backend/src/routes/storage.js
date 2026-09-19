// Storage — REST surface for the dashboard's Storage page. Thin over
// lib/storage/service.js (shared with the MCP family):
//
//   GET  /api/storage/overview          devices + pools + datasets + snapshots + incus + managed + toolchain
//   GET  /api/storage/disks             (smart=0 skips SMART)
//   GET  /api/storage/pools · /datasets · /snapshots?dataset=&guest=
//   GET  /api/storage/policy · /replication · /freshness · /alerts · /ops
//   POST /api/storage/plan              { op, params }            → { plan, plan_token, commands }
//   POST /api/storage/apply             { op, params, plan_token, confirm: true, passphrase? }  (sudo)
//
// Every apply is the same plan/confirm flow the MCP tools use: the service
// recomputes the plan from the live host and refuses a stale token.

import { Router } from 'express';
import { z } from 'zod';
import { requireAdmin, requireSudo } from '../middleware/auth.js';
import { storageService } from '../lib/storage/index.js';
import { deviceEligibility } from '../lib/storage/planner.js';

export const storageRouter = Router();
storageRouter.use(requireAdmin);

const wrap = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (e) { console.error('[storage]', e?.message || e); res.status(500).json({ error: e?.message || 'storage request failed' }); }
};

storageRouter.get('/overview', wrap(async (req, res) => {
  const svc = storageService();
  const inv = await svc.inventory({ smart: req.query.smart !== '0' });
  const [toolchain, replication] = await Promise.all([svc.toolchain(), svc.replicationStatus()]);
  const fresh = await svc.freshness({ inv, replication });
  res.json({
    collected_at: inv.collected_at, source: inv.source, warnings: inv.warnings, managed: inv.managed, toolchain, agent: svc.host.agentReachable(),
    devices: inv.devices.map((d) => ({ ...d, eligibility: deviceEligibility(d), eligibility_with_wipe: deviceEligibility(d, { wipe: true }).eligible })),
    importable: inv.importable, pools: inv.pools.map((p) => ({ ...p, status: inv.poolStatus.find((s) => s.name === p.name) || null })),
    datasets: inv.datasets, snapshots: inv.snapshots, incus: { pools: inv.incusPools, instances: inv.instances, default_profile_root: inv.defaultProfileRoot },
    policy: svc.policyView(inv), replication: fresh.replication, freshness: fresh, ops: svc.listOps({ limit: 30 }),
  });
}));

storageRouter.get('/disks', wrap(async (req, res) => {
  const inv = await storageService().inventory({ smart: req.query.smart !== '0', incus: false });
  res.json({ collected_at: inv.collected_at, source: inv.source.disks, importable: inv.importable, devices: inv.devices.map((d) => ({ ...d, eligibility: deviceEligibility(d), eligibility_with_wipe: deviceEligibility(d, { wipe: true }).eligible })) });
}));

storageRouter.get('/pools', wrap(async (req, res) => {
  const svc = storageService();
  const p = await svc.host.pools();
  res.json({ source: p.source, error: p.error, managed: svc.managed(), pools: p.list.map((l) => ({ ...l, status: p.status.find((s) => s.name === l.name) || null })), importable: await svc.host.zpoolImportScan() });
}));

storageRouter.get('/datasets', wrap(async (req, res) => {
  const d = await storageService().host.datasets();
  res.json({ source: d.source, error: d.error, datasets: d.datasets });
}));

storageRouter.get('/snapshots', wrap(async (req, res) => {
  const inv = await storageService().inventory({ smart: false });
  let rows = inv.snapshots;
  if (req.query.guest) { const i = inv.instances.find((x) => x.name === String(req.query.guest)); rows = i?.dataset ? rows.filter((s) => s.dataset === i.dataset) : []; }
  if (req.query.dataset) rows = rows.filter((s) => s.dataset === String(req.query.dataset) || s.dataset.startsWith(`${req.query.dataset}/`));
  res.json({ count: rows.length, snapshots: rows.slice(-2000) });
}));

storageRouter.get('/policy', wrap(async (req, res) => { const svc = storageService(); res.json(svc.policyView(await svc.inventory({ smart: false }))); }));
storageRouter.get('/replication', wrap(async (req, res) => { const svc = storageService(); const jobs = await svc.replicationStatus(); res.json({ jobs: (await svc.freshness({ replication: jobs })).replication }); }));
storageRouter.get('/freshness', wrap(async (req, res) => res.json(await storageService().freshness())));
storageRouter.get('/alerts', wrap(async (req, res) => { const a = await storageService().alerts(); res.json({ alerts: a.alerts, at: a.freshness.at }); }));
storageRouter.get('/ops', wrap(async (req, res) => res.json({ ops: storageService().listOps({ limit: Math.max(1, Math.min(500, Number(req.query.limit) || 100)), op: req.query.op ? String(req.query.op) : null }) })));
storageRouter.get('/toolchain', wrap(async (req, res) => res.json({ toolchain: await storageService().toolchain(), agent: storageService().host.agentReachable() })));

const PlanBody = z.object({ op: z.string().min(1).max(64), params: z.record(z.any()).optional().default({}) });
const ApplyBody = PlanBody.extend({ plan_token: z.string().regex(/^[0-9a-f]{64}$/), confirm: z.literal(true), passphrase: z.string().min(8).max(512).optional() });

storageRouter.post('/plan', wrap(async (req, res) => {
  const body = PlanBody.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.issues[0]?.message || 'invalid body' });
  const svc = storageService();
  if (!svc.OP_NAMES.includes(body.data.op)) return res.status(400).json({ error: `unknown operation ${body.data.op}` });
  const p = await svc.plan(body.data.op, body.data.params);
  if (p.error) return res.status(422).json({ error: p.error, inventory_at: p.inventory_at });
  res.json(p);
}));

storageRouter.post('/apply', requireSudo, wrap(async (req, res) => {
  const body = ApplyBody.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.issues[0]?.message || 'invalid body' });
  const svc = storageService();
  if (!svc.OP_NAMES.includes(body.data.op)) return res.status(400).json({ error: `unknown operation ${body.data.op}` });
  const r = await svc.apply(body.data.op, body.data.params, { plan_token: body.data.plan_token, confirm: true, actor: req.user?.id || null, via: 'dashboard', ip: req.ip, secrets: { passphrase: body.data.passphrase } });
  if (r.refused) return res.status(409).json(r);
  res.status(r.ok ? 200 : 500).json(r);
}));
