import { Router } from 'express';
import { z } from 'zod';
import { logAudit } from '../db.js';
import { requireAdmin, requireSudo } from '../middleware/auth.js';

// Backend route for the SSH access manager. Wraps the CLI core
// directly — every mutation funnels through the same reconcile() that
// the CLI uses, so authorized_keys is rewritten by exactly one code
// path regardless of where the request originated.
//
// Import path is the monorepo-relative one: admin/backend → cli/src.
// Both are JavaScript ESM and share better-sqlite3, so the import
// resolves at runtime without a build step.
import {
  addEntry,
  revokeEntry,
  removeEntry,
  listEntries,
  showEntry,
  reconcile,
  inspectFallbacks,
  renderBootstrapScript,
} from '../../../../cli/src/core/ssh-access/index.js';
import { touchLastSeen } from '../../../../cli/src/core/ssh-access/last-seen.js';

export const sshAccessRouter = Router();

// All routes require an authenticated admin. Mutations also require a
// fresh sudo grant (same model as services destructive actions).
sshAccessRouter.use(requireAdmin);

function actorFor(req) {
  // The CLI core writes audit rows under this actor string. Distinct
  // prefix (`dashboard:`) so the operator can tell at a glance whether
  // an action came from the CLI or the admin panel.
  const u = req.user?.username || req.user?.email || `id:${req.user?.id ?? 'unknown'}`;
  return `dashboard:${u}`;
}

const filterSchema = z.enum(['all', 'active', 'revoked']).default('active');

sshAccessRouter.get('/', (req, res) => {
  try {
    const filter = filterSchema.parse(req.query.filter || 'active');
    // Best-effort touch on dashboard load. Idempotent and cheap.
    try { touchLastSeen(); } catch { /* best-effort, never blocks list */ }
    const entries = listEntries({ filter });
    res.json({ ok: true, filter, entries });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

sshAccessRouter.get('/:id', (req, res) => {
  try {
    const entry = showEntry(req.params.id);
    res.json({ ok: true, entry });
  } catch (e) {
    res.status(404).json({ ok: false, error: e.message });
  }
});

sshAccessRouter.get('/:id/bootstrap-script', (req, res) => {
  try {
    const script = renderBootstrapScript({
      id: req.params.id,
      user: typeof req.query.user === 'string' && req.query.user ? req.query.user : '<unix-user>',
      server: typeof req.query.server === 'string' && req.query.server ? req.query.server : '<server>',
    });
    res.json({ ok: true, id: req.params.id, script });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

const addSchema = z.object({
  id: z.string().min(1),
  unix_user: z.string().min(1),
  public_key: z.string().min(1),
  label: z.string().optional().nullable(),
});

sshAccessRouter.post('/', requireSudo, async (req, res) => {
  let body;
  try {
    body = addSchema.parse(req.body || {});
  } catch (e) {
    return res.status(400).json({ ok: false, error: e.message });
  }
  try {
    const result = await addEntry({
      id: body.id,
      unixUser: body.unix_user,
      pubkey: body.public_key,
      label: body.label ?? null,
      actor: actorFor(req),
    });
    logAudit(req.user.id, 'SSH_ACCESS_ADD', 'ssh_access', body.id, {
      unix_user: body.unix_user,
      fingerprint: result.fingerprint,
      label: body.label ?? null,
    }, req.ip);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

const revokeSchema = z.object({
  reason: z.string().optional().nullable(),
  force: z.boolean().optional(),
});

sshAccessRouter.post('/:id/revoke', requireSudo, async (req, res) => {
  let body;
  try {
    body = revokeSchema.parse(req.body || {});
  } catch (e) {
    return res.status(400).json({ ok: false, error: e.message });
  }
  let row;
  try {
    row = showEntry(req.params.id);
  } catch (e) {
    return res.status(404).json({ ok: false, error: e.message });
  }
  if (!row.revoked_at) {
    const fb = inspectFallbacks({ unixUser: row.unix_user, idBeingRevoked: row.id });
    const wouldStrand = fb.fallbacks.length === 0 && fb.remainingManaged === 0;
    if (wouldStrand && !body.force) {
      // The backend's gate is force-flag based; the typed-phrase prompt
      // happens client-side in the dashboard before we get here. Refuse
      // until the frontend re-sends with `force: true` after the
      // operator confirms.
      return res.status(409).json({
        ok: false,
        code: 'WOULD_STRAND',
        error:
          `revoking "${row.id}" would leave unix user "${row.unix_user}" with ` +
          `no authorized_keys access (no operator-added fallback, no other ` +
          `managed entries).`,
        unix_user: row.unix_user,
        fallbacks: fb.fallbacks,
        remaining_managed: fb.remainingManaged,
        requires_force: true,
      });
    }
  }
  try {
    const result = await revokeEntry({
      id: req.params.id,
      reason: body.reason ?? null,
      actor: actorFor(req),
    });
    logAudit(req.user.id, 'SSH_ACCESS_REVOKE', 'ssh_access', req.params.id, {
      unix_user: row.unix_user,
      fingerprint: row.fingerprint,
      reason: body.reason ?? null,
      forced: !!body.force,
    }, req.ip);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

const removeBodySchema = z.object({ force: z.boolean().optional() });

sshAccessRouter.delete('/:id', requireSudo, async (req, res) => {
  let body;
  try {
    body = removeBodySchema.parse(req.body || {});
  } catch (e) {
    return res.status(400).json({ ok: false, error: e.message });
  }
  let row;
  try {
    row = showEntry(req.params.id);
  } catch (e) {
    return res.status(404).json({ ok: false, error: e.message });
  }
  if (!row.revoked_at) {
    const fb = inspectFallbacks({ unixUser: row.unix_user, idBeingRevoked: row.id });
    const wouldStrand = fb.fallbacks.length === 0 && fb.remainingManaged === 0;
    if (wouldStrand && !body.force) {
      return res.status(409).json({
        ok: false,
        code: 'WOULD_STRAND',
        error:
          `removing "${row.id}" would leave unix user "${row.unix_user}" with ` +
          `no authorized_keys access. Prefer revoke for the audit trail.`,
        unix_user: row.unix_user,
        fallbacks: fb.fallbacks,
        remaining_managed: fb.remainingManaged,
        requires_force: true,
      });
    }
  }
  try {
    const result = await removeEntry({
      id: req.params.id,
      actor: actorFor(req),
    });
    logAudit(req.user.id, 'SSH_ACCESS_REMOVE', 'ssh_access', req.params.id, {
      unix_user: row.unix_user,
      fingerprint: row.fingerprint,
      forced: !!body.force,
    }, req.ip);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

const reconcileSchema = z.object({ dry_run: z.boolean().optional() });

sshAccessRouter.post('/reconcile', requireSudo, async (req, res) => {
  let body;
  try {
    body = reconcileSchema.parse(req.body || {});
  } catch (e) {
    return res.status(400).json({ ok: false, error: e.message });
  }
  try {
    const result = await reconcile({
      dryRun: !!body.dry_run,
      actor: actorFor(req),
    });
    if (!body.dry_run) {
      logAudit(req.user.id, 'SSH_ACCESS_RECONCILE', 'ssh_access', null, {
        users_changed: result.users.filter(u => u.changed).map(u => u.user),
      }, req.ip);
    }
    res.json({ ok: true, dry_run: !!body.dry_run, ...result });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});
