// Mock2 HTTP surface. Mounted at /api/mock2 (behind authenticateToken) ONLY
// when the module is enabled and not production-pinned (ADR-001) — on a
// disabled host the router is never imported, so every /api/mock2/* path 404s,
// indistinguishable from an unknown route.
//
// Phase M0 exposed GET /status. Phase M1 (ADR-009) adds parent-domain CRUD, the
// DNS+probe-cert verification pipeline, and the enable/disable that publishes a
// Mock2-owned Caddy site file. All admin-gated; register/enable/disable/delete
// are audit-logged; delete additionally requires a fresh sudo grant.

import { Router } from 'express';
import { z } from 'zod';
import { requireAdmin, requireSudo } from '../middleware/auth.js';
import { logAudit } from '../db.js';
import { postNotification, resolveNotification } from '../lib/notifications.js';
import {
  listParentDomains,
  getParentDomain,
  getParentDomainByName,
  insertParentDomain,
  updateParentDomain,
  deleteParentDomain,
} from './domains.js';
import { validateDomain, publicDomainShape, isSelectable } from './domain-logic.js';
import { runVerification } from './verify.js';
import { writeMock2DomainSite, unpublishMock2Domain, reloadMock2Caddy } from './caddy.js';
import { raiseQueueItem, resolveQueueItem } from './queue.js';

// Domains currently mid-verification, so a double-click on "Verify" (or a
// register+verify race) doesn't run two ACME probes against the same domain.
const verifying = new Set();

function verifyDedupeKey(id) {
  return `mock2-domain-verify:${id}`;
}

// Wire the pure pipeline's progress/fail/succeed callbacks to the DB row plus
// the notification bell and the admin queue (ADR-009 watch-item).
function buildVerifyHooks(row) {
  const dedupe = verifyDedupeKey(row.id);
  return {
    progress(status) {
      updateParentDomain(row.id, { verify_status: status });
    },
    fail(reason) {
      updateParentDomain(row.id, {
        verify_status: 'failed',
        renewal_error: reason,
        last_renewal_at: new Date().toISOString(),
      });
      try {
        postNotification({
          level: 'error',
          title: `Mock2 domain verification failed: ${row.domain}`,
          body: `${reason}\n\nProjects cannot be created on "${row.domain}" until it verifies. Re-run verification once DNS/ACME is fixed.`,
          source: 'mock2-domain-verify',
          source_id: row.id,
          dedupe_key: dedupe,
        });
      } catch (err) {
        console.error('[mock2] postNotification failed:', err?.message);
      }
      try {
        raiseQueueItem({
          kind: 'renewal_failed',
          dedupe_key: dedupe,
          ref_table: 'mock2_parent_domains',
          ref_id: row.id,
          detail: `${row.domain}: ${reason}`,
        });
      } catch (err) {
        console.error('[mock2] raiseQueueItem failed:', err?.message);
      }
    },
    succeed() {
      updateParentDomain(row.id, {
        verify_status: 'cert_ok',
        verified_at: new Date().toISOString(),
        renewal_error: null,
      });
      resolveNotification(dedupe, { reason: 'domain verified' });
      try { resolveQueueItem(dedupe, { resolution: 'verified' }); } catch { /* best effort */ }
    },
  };
}

// Fire-and-forget the async pipeline. Returns false if already running.
function startVerification(row) {
  if (verifying.has(row.id)) return false;
  verifying.add(row.id);
  Promise.resolve()
    .then(() => runVerification(row.domain, buildVerifyHooks(row)))
    .catch((err) => console.error(`[mock2] verification crashed for ${row.domain}:`, err?.message))
    .finally(() => verifying.delete(row.id));
  return true;
}

const registerSchema = z.object({ domain: z.string().min(1).max(253) });
const projectStubSchema = z.object({
  name: z.string().min(1).optional(),
  parent_domain_id: z.union([z.number().int(), z.string()]).optional(),
});

export function createMock2Router() {
  const router = Router();

  // Presence probe (admin-gated). Reaching this handler already implies the
  // module is enabled; the frontend keys its nav entry off a 200 here.
  router.get('/status', requireAdmin, (_req, res) => {
    res.json({ status: 'ok', enabled: true, phase: 'M1' });
  });

  // ---- Parent domains ----

  router.get('/parent-domains', requireAdmin, (_req, res) => {
    const rows = listParentDomains().map(publicDomainShape);
    res.json({ domains: rows });
  });

  router.get('/parent-domains/:id', requireAdmin, (req, res) => {
    const row = getParentDomain(Number(req.params.id));
    if (!row) return res.status(404).json({ error: 'Parent domain not found' });
    res.json({ domain: { ...publicDomainShape(row), verifying: verifying.has(row.id) } });
  });

  router.post('/parent-domains', requireAdmin, (req, res) => {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Domain is required' });

    const v = validateDomain(parsed.data.domain);
    if (!v.ok) return res.status(400).json({ error: v.error });

    if (getParentDomainByName(v.domain)) {
      return res.status(409).json({ error: `Domain "${v.domain}" is already registered` });
    }

    const row = insertParentDomain({ domain: v.domain, createdBy: req.user?.id });
    logAudit(req.user?.id, 'MOCK2_DOMAIN_REGISTER', 'mock2_parent_domain', row.id, { domain: v.domain }, req.ip);

    // Kick off verification in the background; the client polls GET for status.
    startVerification(row);

    res.status(202).json({ domain: { ...publicDomainShape(row), verifying: true } });
  });

  router.post('/parent-domains/:id/verify', requireAdmin, (req, res) => {
    const row = getParentDomain(Number(req.params.id));
    if (!row) return res.status(404).json({ error: 'Parent domain not found' });
    const started = startVerification(row);
    logAudit(req.user?.id, 'MOCK2_DOMAIN_VERIFY', 'mock2_parent_domain', row.id, { domain: row.domain, started }, req.ip);
    res.status(202).json({ domain: { ...publicDomainShape(getParentDomain(row.id)), verifying: true }, alreadyRunning: !started });
  });

  router.post('/parent-domains/:id/enable', requireAdmin, async (req, res) => {
    const row = getParentDomain(Number(req.params.id));
    if (!row) return res.status(404).json({ error: 'Parent domain not found' });
    if (row.verify_status !== 'cert_ok') {
      return res.status(409).json({ error: 'Domain must pass verification (cert_ok) before it can be enabled' });
    }
    const updated = updateParentDomain(row.id, { enabled: 1 });
    // Publish the (steady-state, no-slug in M1) site file and reload so the
    // import line is present and future slug blocks land in a live file.
    let reload = { ok: true };
    try {
      await writeMock2DomainSite(row.domain, []);
      reload = await reloadMock2Caddy();
    } catch (err) {
      reload = { ok: false, error: err.message };
    }
    logAudit(req.user?.id, 'MOCK2_DOMAIN_ENABLE', 'mock2_parent_domain', row.id, { domain: row.domain }, req.ip);
    res.json({ domain: publicDomainShape(updated), caddy: reload });
  });

  router.post('/parent-domains/:id/disable', requireAdmin, async (req, res) => {
    const row = getParentDomain(Number(req.params.id));
    if (!row) return res.status(404).json({ error: 'Parent domain not found' });
    const updated = updateParentDomain(row.id, { enabled: 0 });
    let reload = { ok: true };
    try {
      reload = await unpublishMock2Domain(row.domain);
    } catch (err) {
      reload = { ok: false, error: err.message };
    }
    logAudit(req.user?.id, 'MOCK2_DOMAIN_DISABLE', 'mock2_parent_domain', row.id, { domain: row.domain }, req.ip);
    res.json({ domain: publicDomainShape(updated), caddy: reload });
  });

  // Destructive: remove the domain and its Caddy site file. Requires a fresh
  // sudo grant on top of admin.
  router.delete('/parent-domains/:id', requireAdmin, requireSudo, async (req, res) => {
    const row = getParentDomain(Number(req.params.id));
    if (!row) return res.status(404).json({ error: 'Parent domain not found' });
    try {
      await unpublishMock2Domain(row.domain);
    } catch (err) {
      console.error('[mock2] failed to unpublish caddy on delete:', err?.message);
    }
    resolveNotification(verifyDedupeKey(row.id), { reason: 'domain deleted' });
    try { resolveQueueItem(verifyDedupeKey(row.id), { resolution: 'domain deleted' }); } catch { /* best effort */ }
    deleteParentDomain(row.id);
    logAudit(req.user?.id, 'MOCK2_DOMAIN_DELETE', 'mock2_parent_domain', row.id, { domain: row.domain }, req.ip);
    res.json({ ok: true });
  });

  // ---- Project create (M1 stub gate) ----
  // M2 owns project creation. M1 ships only the guard that proves the
  // "un-verified domain is not selectable" contract: a project cannot be
  // created against a domain that isn't cert_ok AND enabled.
  router.post('/projects', requireAdmin, (req, res) => {
    const parsed = projectStubSchema.safeParse(req.body || {});
    const pid = parsed.success ? parsed.data.parent_domain_id : undefined;
    const row = pid != null ? getParentDomain(Number(pid)) : null;
    if (!row) return res.status(400).json({ error: 'A verified parent domain is required' });
    if (!isSelectable(row)) {
      return res.status(400).json({ error: `Parent domain "${row.domain}" is not verified and enabled — it cannot host a project yet` });
    }
    return res.status(501).json({ error: 'Project creation arrives in Phase M2' });
  });

  return router;
}
