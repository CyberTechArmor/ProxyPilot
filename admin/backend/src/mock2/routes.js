// Mock2 HTTP surface. This router is mounted at /api/mock2 ONLY when the
// module is enabled and not production-pinned (ADR-001) — on a disabled
// host the router is never imported, so every /api/mock2/* path 404s,
// indistinguishable from an unknown route. The frontend keys its nav
// entry off GET /api/mock2/status succeeding vs. 404ing.
//
// Phase M0 exposes exactly one route: GET /status (admin-gated). Later
// phases add project/domain/connector/framework routes here.

import { Router } from 'express';
import { requireAdmin } from '../middleware/auth.js';

export function createMock2Router() {
  const router = Router();

  // Presence probe. Reaching this handler already implies the module is
  // enabled (the router isn't mounted otherwise); requireAdmin keeps the
  // signal admin-only so non-admins see the same 404-shaped absence a
  // disabled host gives.
  router.get('/status', requireAdmin, (_req, res) => {
    res.json({ status: 'ok', enabled: true, phase: 'M0' });
  });

  return router;
}
