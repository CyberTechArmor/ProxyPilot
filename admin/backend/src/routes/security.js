// Routes for ProxyPilot's host-side CVE check/patch surface.
//
// Mounted at /api/security behind authenticateToken (see index.js).
// Per-handler RBAC:
//
//   GET  /api/security/cve/CVE-2026-31431          requireAdmin
//        Read-only detection. Forwards to the agent's
//        security.cve_2026_31431.check RPC.
//
//   POST /api/security/cve/CVE-2026-31431/patch    requireAdmin + requireSudo
//        Mutates host state (apt-get, grub, /etc/modprobe.d, the
//        CVE inbox file). Body may carry {force,mitigate_only,patch_only}.
//
// The frontend hits these endpoints directly; the api.js wrapper
// surfaces sudo_required envelopes via the existing useSudo hook,
// so the user is prompted to re-auth before the patch fires.

import { Router } from 'express';
import { z } from 'zod';
import { logAudit } from '../db.js';
import { requireAdmin, requireSudo } from '../middleware/auth.js';
import {
  cveCheck202631431,
  cvePatch202631431,
} from '../lib/security-cve-driver.js';

export const securityRouter = Router();

// Only one CVE is wired today; the route shape carries the CVE id so
// that adding more (security.cve.<id>.check / .patch handlers in the
// agent) is a one-line table extension here, not a new URL family.
const CVE_HANDLERS = {
  'CVE-2026-31431': {
    check: cveCheck202631431,
    patch: cvePatch202631431,
  },
};

const cveIdRe = /^CVE-\d{4}-\d{4,7}$/;

function lookup(req, res) {
  const id = req.params.cveId;
  if (!cveIdRe.test(id)) {
    res.status(400).json({ error: 'invalid CVE id' });
    return null;
  }
  const handler = CVE_HANDLERS[id];
  if (!handler) {
    res.status(404).json({ error: 'CVE not handled by this agent' });
    return null;
  }
  return { id, handler };
}

securityRouter.get('/cve/:cveId', requireAdmin, async (req, res) => {
  const found = lookup(req, res);
  if (!found) return;
  try {
    const result = await found.handler.check();
    res.json(result);
  } catch (err) {
    res.status(502).json({
      error: err.message || 'agent unreachable',
      code: err.code || 'agent_call_failed',
    });
  }
});

const patchBodySchema = z.object({
  force: z.boolean().optional(),
  mitigate_only: z.boolean().optional(),
  patch_only: z.boolean().optional(),
}).strict();

securityRouter.post('/cve/:cveId/patch', requireAdmin, requireSudo, async (req, res) => {
  const found = lookup(req, res);
  if (!found) return;

  let body;
  try {
    body = patchBodySchema.parse(req.body || {});
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  if (body.mitigate_only && body.patch_only) {
    return res.status(400).json({ error: 'mitigate_only and patch_only are mutually exclusive' });
  }

  try {
    const result = await found.handler.patch(body);
    logAudit(req.user.id, 'CVE_PATCH', 'cve', found.id, {
      params: body,
      status: result?.status ?? null,
      operator_action_required: result?.operator_action_required ?? null,
      actions_taken: result?.actions_taken ?? null,
    }, req.ip);
    res.json(result);
  } catch (err) {
    res.status(502).json({
      error: err.message || 'agent unreachable',
      code: err.code || 'agent_call_failed',
    });
  }
});
