// Mock2 HTTP surface. Mounted at /api/mock2 (behind authenticateToken) ONLY
// when the module is enabled and not production-pinned (ADR-001) — on a
// disabled host the router is never imported, so every /api/mock2/* path 404s,
// indistinguishable from an unknown route.
//
// Phase M0 exposed GET /status. Phase M1 (ADR-009) adds parent-domain CRUD, the
// DNS+probe-cert verification pipeline, and the enable/disable that publishes a
// Mock2-owned Caddy site file. All admin-gated; register/enable/disable/delete
// are audit-logged; delete additionally requires a fresh sudo grant.

import dns from 'dns/promises';
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
import {
  listProjects,
  getProject,
  createProject,
  updateProject,
  deleteProject,
  mintUniqueSlug,
  rotateProjectSlug,
  countEditors,
  countMembersByRole,
  listMembers,
  getMembership,
  upsertMember,
  removeMember,
  lookupUser,
} from './projects.js';
import { publicProjectShape, isProjectReadOnly } from './project-logic.js';
import { requireMock2Role } from './authz.js';
import {
  startProvision,
  startArchive,
  startRehydrate,
  startWake,
  getProvisionStatus,
  teardownProject,
  repoPathForProject,
  containerNameForProject,
} from './provision.js';
import { publishDomain } from './publish.js';
import { getIdleStopDays, setMock2Setting, IDLE_STOP_DAYS_KEY } from './settings.js';
import {
  listAllowlist,
  addAllowlistHost,
  removeAllowlistHost,
  isAllowlistHost,
  normalizeAllowlistHost,
} from './allowlist.js';
import { reconcileMock2Egress } from './egress.js';
import { reconcileMock2Firewall } from './firewall.js';
// ---- M5: connectors, slots, prices, quotas, git connectors, framework ----
import {
  listConnectors, getConnector, getConnectorByName, insertConnector, updateConnector,
  deleteConnector, recordBaaAck, testConnector, shapeConnector,
  listSlots, getSlot, setSlot, clearSlot,
  listPrices, upsertPrice, deletePrice,
} from './connectors.js';
import {
  PROVIDERS, MODEL_SLOTS, CAPABILITIES, validateConnectorInput, normalizeCapabilities,
  defaultCapabilitiesForProvider, parseCapabilities, slotAssignmentError,
  requiresBaaAck, isCloudProvider,
} from './connector-logic.js';
import {
  listQuotas, getQuota, upsertQuota, deleteQuota, shapeQuota,
} from './quotas.js';
import {
  listGitConnectors, getGitConnector, getGitConnectorByName, insertGitConnector,
  updateGitConnector, deleteGitConnector, testGitConnector, shapeGitConnector,
  getProjectRemote, setProjectRemote, clearProjectRemote, shapeProjectRemote, exportProjectZip,
} from './git-connectors.js';
import { GIT_PROVIDERS, GIT_AUTH_KINDS, validateGitConnectorInput } from './git-logic.js';
import {
  listFrameworkVersions, getFrameworkVersion,
  getCurrentFrameworkVersion, insertFrameworkVersion,
} from './framework.js';
import {
  validateFrameworkContent, buildRevertContent, publicFrameworkShape,
} from './framework-logic.js';
// ---- M6: cycle runner + checkout lock ----
import { startCycle, getCycleJobStatus, stopAllCycles } from './runner.js';
import {
  getCycle, listCyclesForProject, latestCycle, setInterrupt,
} from './cycles.js';
import { publicCycleShape, INTERRUPTS } from './cycle-logic.js';
import {
  getLock, releaseLock, requestTakeover, getLockIdleMinutes,
} from './locks.js';
import { publicLockShape, LOCK_IDLE_MINUTES_KEY } from './lock-logic.js';
import { listChangeRecords, verifyProjectChain } from './change-records.js';
// ---- M7: Stage 1 (Concept) — chat, mockup, design approval ----
import { listMessages } from './chats.js';
import {
  startConceptTurn, startDesignApproval, getConceptJobStatus, conceptReady,
} from './concept.js';
import { publicChatMessageShape } from './concept-logic.js';

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

const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).optional(),
  parent_domain_id: z.union([z.number().int(), z.string()]),
});
const memberSchema = z.object({
  user_id: z.union([z.number().int(), z.string()]),
  role: z.enum(['editor', 'viewer']),
});
const customDomainSchema = z.object({ domain: z.string().trim().min(1).max(253) });
const flagSchema = z.object({
  flagged: z.boolean(),
  reason: z.string().trim().max(500).optional(),
});
const idleDaysSchema = z.object({
  days: z.union([z.number().int(), z.string()]).transform((v) => Number(v))
    .refine((n) => Number.isInteger(n) && n >= 0 && n <= 3650, 'out of range'),
});

// ---- M5 Zod schemas ----
const connectorCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  provider: z.enum(PROVIDERS),
  base_url: z.string().trim().max(500).optional(),
  api_key: z.string().max(4000).optional(),
  capabilities: z.array(z.enum(CAPABILITIES)).optional(),
  enabled: z.boolean().optional(),
});
const connectorUpdateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  base_url: z.string().trim().max(500).optional(),
  api_key: z.string().max(4000).optional(),
  capabilities: z.array(z.enum(CAPABILITIES)).optional(),
  enabled: z.boolean().optional(),
}).refine((o) => Object.keys(o).length > 0, 'no fields to update');
const slotAssignSchema = z.object({
  connector_id: z.union([z.number().int(), z.string()]),
  model: z.string().trim().min(1).max(200),
});
const priceSchema = z.object({
  model: z.string().trim().min(1).max(200),
  input_cents_per_mtok: z.number().int().min(0),
  output_cents_per_mtok: z.number().int().min(0),
  effective_at: z.string().trim().max(40).optional(),
});
const quotaSchema = z.object({
  scope: z.enum(['global', 'project']),
  project_id: z.union([z.number().int(), z.string()]).optional(),
  period: z.enum(['monthly', 'weekly']),
  budget_cents: z.number().int().min(0).nullable().optional(),
  budget_wall_clock_min: z.number().int().min(0).nullable().optional(),
  max_concurrent_cycles: z.number().int().min(0).nullable().optional(),
  buffer_pct: z.number().int().min(0).max(500).optional(),
});
const gitConnectorCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  provider: z.enum(GIT_PROVIDERS),
  base_url: z.string().trim().max(500).optional(),
  auth_kind: z.enum(GIT_AUTH_KINDS),
  credential: z.string().min(1).max(20000),
});
const gitConnectorUpdateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  base_url: z.string().trim().max(500).optional(),
  auth_kind: z.enum(GIT_AUTH_KINDS).optional(),
  credential: z.string().min(1).max(20000).optional(),
}).refine((o) => Object.keys(o).length > 0, 'no fields to update');
const projectRemoteSchema = z.object({
  git_connector_id: z.union([z.number().int(), z.string()]),
  remote_repo: z.string().trim().min(1).max(500),
  push_on_checkpoint: z.boolean().optional(),
});
// ---- M6 Zod schemas ----
const cycleStartSchema = z.object({
  instruction: z.string().trim().min(1).max(2000),
});
const interruptSchema = z.object({
  action: z.enum(INTERRUPTS),
});
const lockIdleSchema = z.object({
  minutes: z.union([z.number().int(), z.string()]).transform((v) => Number(v))
    .refine((n) => Number.isInteger(n) && n >= 1 && n <= 1440, 'out of range'),
});
// ---- M7 Zod schemas ----
const chatMessageSchema = z.object({
  message: z.string().trim().min(1).max(4000),
});
const frameworkContentSchema = z.object({
  constitution_md: z.string().min(1),
  skills_json: z.string().min(1),
  gates_json: z.string().min(1),
  design_system_md: z.string().min(1),
  project_template_ref: z.string().trim().min(1).max(500),
  changelog: z.string().trim().max(2000).optional(),
});

// Shape a project row for a response, computing the derived inputs M2 has
// (editor/viewer counts, parent-domain name) and gating the admin debug fields.
function shapeProject(project, { isAdmin }) {
  const parent = project.parent_domain_id ? getParentDomain(project.parent_domain_id) : null;
  const counts = countMembersByRole(project.id);
  return publicProjectShape(project, {
    parentDomain: parent?.domain || null,
    editorCount: counts.editor,
    viewerCount: counts.viewer,
    isAdmin,
  });
}

// The ONE archived read-only guard (04-phased-plan §M3 / Q4): an archived
// project is frozen — every mutating project route refuses it except VIEW and
// REHYDRATE. Runs AFTER requireMock2Role (which loads req.mock2Project), so it
// reads the already-loaded row rather than re-querying. Not a per-route
// sprinkle: it is inserted once into each mutating route's middleware chain.
function refuseIfArchived(req, res, next) {
  if (isProjectReadOnly(req.mock2Project)) {
    return res.status(409).json({ error: 'This project is archived (read-only). Rehydrate it to make changes.' });
  }
  next();
}

export function createMock2Router() {
  const router = Router();

  // Presence probe (admin-gated). Reaching this handler already implies the
  // module is enabled; the frontend keys its nav entry off a 200 here.
  router.get('/status', requireAdmin, (_req, res) => {
    res.json({ status: 'ok', enabled: true, phase: 'M7' });
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

  // ---- Projects (M2) ----

  const isReqAdmin = (req) => req.user?.role === 'admin';

  // List projects. Admins see all; a non-admin sees only projects they are a
  // member of. (The module's nav entry is admin-only today, but the routes are
  // mounted behind plain auth, so filter defensively.)
  router.get('/projects', (req, res) => {
    const admin = isReqAdmin(req);
    let rows = listProjects();
    if (!admin) rows = rows.filter((p) => getMembership(p.id, req.user.id));
    res.json({ projects: rows.map((p) => shapeProject(p, { isAdmin: admin })) });
  });

  // Create a project: mint a slug under a SELECTABLE parent domain (the M1
  // gate), create the row + permanent slug reservation, add the creator as an
  // editor (so it isn't born orphaned), and kick off provisioning (202 + poll).
  // Admin-gated — creating a project provisions a container.
  router.post('/projects', requireAdmin, (req, res) => {
    const parsed = createProjectSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'name and parent_domain_id are required' });
    const { name, description } = parsed.data;
    const parentId = Number(parsed.data.parent_domain_id);
    const parent = getParentDomain(parentId);
    if (!parent) return res.status(400).json({ error: 'A verified parent domain is required' });
    if (!isSelectable(parent)) {
      return res.status(400).json({ error: `Parent domain "${parent.domain}" is not verified and enabled — it cannot host a project yet` });
    }

    let project;
    try {
      const slug = mintUniqueSlug(parentId);
      project = createProject({
        name, description, parentDomainId: parentId, slug,
        repoPathFor: repoPathForProject,
        containerNameFor: containerNameForProject,
        createdBy: req.user.id,
      });
      // Add the creator as the first editor so the project isn't born orphaned.
      upsertMember({ projectId: project.id, userId: req.user.id, role: 'editor', invitedBy: req.user.id });
    } catch (err) {
      console.error('[mock2] project create failed:', err?.message);
      return res.status(500).json({ error: `Could not create project: ${err?.message || 'unknown error'}` });
    }

    logAudit(req.user.id, 'MOCK2_PROJECT_CREATE', 'mock2_project', project.id, { name, slug: project.slug, domain: parent.domain }, req.ip);
    startProvision(project);
    res.status(202).json({ project: shapeProject(project, { isAdmin: true }) });
  });

  router.get('/projects/:id', requireMock2Role('viewer'), (req, res) => {
    const project = req.mock2Project;
    const shaped = shapeProject(project, { isAdmin: isReqAdmin(req) });
    shaped.members = listMembers(project.id).map((m) => {
      const u = lookupUser(m.user_id);
      return { user_id: m.user_id, username: u?.username || null, role: m.role };
    });
    shaped.acting_as_admin = req.mock2Access.actingAsAdmin;
    // The requesting user's effective role ('admin' | 'editor' | 'viewer') so
    // the frontend can hide mutating controls from a pure viewer. The server
    // still enforces every mutation via requireMock2Role regardless.
    shaped.my_role = req.mock2Access.role;
    res.json({ project: shaped });
  });

  // Live provisioning progress (mirrors the LXC create-status poll).
  router.get('/projects/:id/provision-status', requireMock2Role('viewer'), (req, res) => {
    const project = req.mock2Project;
    const status = getProvisionStatus(project.id);
    res.json({
      lifecycle: project.lifecycle,
      provision_error: project.provision_error || null,
      progress: status ? { phase: status.phase, message: status.message } : null,
    });
  });

  // Rotate the slug: new slug, 1h grace on the old one, old slug 404s after and
  // is never reusable. Editor-gated; republishes the domain's Caddy file.
  router.post('/projects/:id/rotate-slug', requireMock2Role('editor'), refuseIfArchived, async (req, res) => {
    const project = req.mock2Project;
    if (project.lifecycle !== 'active' && project.lifecycle !== 'stopped') {
      return res.status(409).json({ error: 'Only an active project can rotate its slug' });
    }
    if (!project.parent_domain_id) return res.status(409).json({ error: 'Project has no parent domain to rotate within' });
    let result;
    try {
      result = rotateProjectSlug(project.id, req.user.id);
    } catch (err) {
      return res.status(500).json({ error: `Rotate failed: ${err?.message || 'unknown error'}` });
    }
    logAudit(req.user.id, 'MOCK2_PROJECT_ROTATE_SLUG', 'mock2_project', project.id,
      { old_slug: result.oldSlug, new_slug: result.newSlug, acting_as_admin: req.mock2Access.actingAsAdmin }, req.ip);
    const caddy = await publishDomain(project.parent_domain_id);
    res.json({ project: shapeProject(getProject(project.id), { isAdmin: isReqAdmin(req) }), rotation: result, caddy });
  });

  // Add or change a member's role. Editor-gated (admins bypass).
  router.post('/projects/:id/members', requireMock2Role('editor'), refuseIfArchived, (req, res) => {
    const project = req.mock2Project;
    const parsed = memberSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'user_id and role (editor|viewer) are required' });
    const userId = Number(parsed.data.user_id);
    const user = lookupUser(userId);
    if (!user) return res.status(400).json({ error: 'No such user' });
    const member = upsertMember({ projectId: project.id, userId, role: parsed.data.role, invitedBy: req.user.id });
    logAudit(req.user.id, 'MOCK2_PROJECT_MEMBER_SET', 'mock2_project', project.id,
      { user_id: userId, role: parsed.data.role }, req.ip);
    res.json({ member: { user_id: userId, username: user.username, role: member.role } });
  });

  router.delete('/projects/:id/members/:userId', requireMock2Role('editor'), refuseIfArchived, (req, res) => {
    const project = req.mock2Project;
    const userId = Number(req.params.userId);
    removeMember(project.id, userId);
    logAudit(req.user.id, 'MOCK2_PROJECT_MEMBER_REMOVE', 'mock2_project', project.id, { user_id: userId }, req.ip);
    // Surface the resulting editor count so the UI can warn about an
    // orphaned (zero-editor) project.
    res.json({ ok: true, editor_count: countEditors(project.id) });
  });

  // Flag / unflag the project for admin attention (the one manual overlay).
  router.post('/projects/:id/flag', requireMock2Role('editor'), refuseIfArchived, (req, res) => {
    const project = req.mock2Project;
    const parsed = flagSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'flagged (boolean) is required' });
    const updated = updateProject(project.id, parsed.data.flagged
      ? { flagged: 1, flagged_by: req.user.id, flagged_reason: parsed.data.reason || null }
      : { flagged: 0, flagged_by: null, flagged_reason: null });
    if (parsed.data.flagged) {
      try {
        raiseQueueItem({
          kind: 'flag', project_id: project.id,
          dedupe_key: `mock2-flag:${project.id}`,
          ref_table: 'mock2_projects', ref_id: project.id,
          detail: `${project.name}: ${parsed.data.reason || 'flagged for admin attention'}`,
        });
      } catch { /* best effort */ }
    } else {
      resolveQueueItem(`mock2-flag:${project.id}`, { resolution: 'unflagged', resolvedBy: req.user.id });
    }
    logAudit(req.user.id, 'MOCK2_PROJECT_FLAG', 'mock2_project', project.id, { flagged: parsed.data.flagged }, req.ip);
    res.json({ project: shapeProject(updated, { isAdmin: isReqAdmin(req) }) });
  });

  // Attach a custom domain (admin-gated): validate, best-effort A-record check
  // against the host's public IP, then republish so Caddy issues an HTTP-01
  // cert for it. The custom-domain block rides in the parent domain's Mock2
  // file (its explicit address obtains its own cert; Caddy is indifferent to
  // which file the block lives in).
  router.post('/projects/:id/custom-domain', requireAdmin, requireMock2Role('editor'), refuseIfArchived, async (req, res) => {
    const project = req.mock2Project;
    const parsed = customDomainSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'domain is required' });
    const v = validateDomain(parsed.data.domain);
    if (!v.ok) return res.status(400).json({ error: v.error });
    if (!project.parent_domain_id) return res.status(409).json({ error: 'Custom domains attach to a slug-based project in M2' });

    const dnsCheck = await checkARecord(v.domain);
    const updated = updateProject(project.id, { custom_domain: v.domain });
    const caddy = await publishDomain(project.parent_domain_id);
    logAudit(req.user.id, 'MOCK2_PROJECT_CUSTOM_DOMAIN', 'mock2_project', project.id, { domain: v.domain, dns: dnsCheck }, req.ip);
    res.json({ project: shapeProject(updated, { isAdmin: true }), dns: dnsCheck, caddy });
  });

  // Archive (M3): checkpoint the working tree into the bare repo → destroy the
  // container → lifecycle='archived'. The bare repo, slug history, chats,
  // change records, and memberships are all RETAINED (ADR-006 / Q4). Admin or
  // editor. 202 + poll (the frontend polls until lifecycle flips to 'archived').
  router.post('/projects/:id/archive', requireMock2Role('editor'), async (req, res) => {
    const project = req.mock2Project;
    if (project.lifecycle === 'archived') return res.status(409).json({ error: 'Project is already archived' });
    if (project.lifecycle === 'provisioning') return res.status(409).json({ error: 'Cannot archive a project while it is still provisioning' });
    if (project.lifecycle !== 'active' && project.lifecycle !== 'stopped') {
      return res.status(409).json({ error: `Cannot archive a project in state "${project.lifecycle}"` });
    }
    logAudit(req.user.id, 'MOCK2_PROJECT_ARCHIVE', 'mock2_project', project.id,
      { name: project.name, slug: project.slug, acting_as_admin: req.mock2Access.actingAsAdmin }, req.ip);
    startArchive(project);
    res.status(202).json({ project: shapeProject(getProject(project.id), { isAdmin: isReqAdmin(req) }) });
  });

  // Rehydrate (M3): rebuild an archived project's container from the bare repo
  // (ADR-006 — never a snapshot), same slug/URL (it was never released). Admin
  // or editor. Flip to 'provisioning' + restore container_name so the existing
  // provisioning poll/UI drives it, then run the shared launch sequence.
  router.post('/projects/:id/rehydrate', requireMock2Role('editor'), (req, res) => {
    const project = req.mock2Project;
    if (project.lifecycle !== 'archived') {
      return res.status(409).json({ error: 'Only an archived project can be rehydrated' });
    }
    const containerName = containerNameForProject(project.id);
    // Restore container_name (NULLed at archive) and flip to provisioning WITHOUT
    // clearing archived_at — the bring-up success path clears it, so a failed
    // rehydrate reverts cleanly to 'archived' with its original timestamp.
    updateProject(project.id, { lifecycle: 'provisioning', container_name: containerName, provision_error: null });
    logAudit(req.user.id, 'MOCK2_PROJECT_REHYDRATE', 'mock2_project', project.id,
      { name: project.name, slug: project.slug, acting_as_admin: req.mock2Access.actingAsAdmin }, req.ip);
    startRehydrate({ ...project, lifecycle: 'provisioning', container_name: containerName });
    res.status(202).json({ project: shapeProject(getProject(project.id), { isAdmin: isReqAdmin(req) }) });
  });

  // Wake (M3, restart-on-visit): start a stopped container, refresh its IP, and
  // republish. Any member may wake (viewer-gated — opening a stopped project
  // should bring it back). 202 + poll.
  router.post('/projects/:id/wake', requireMock2Role('viewer'), (req, res) => {
    const project = req.mock2Project;
    if (project.lifecycle === 'archived') {
      return res.status(409).json({ error: 'Project is archived — rehydrate it instead of waking' });
    }
    if (project.lifecycle !== 'stopped') {
      return res.status(409).json({ error: 'Only a stopped project can be woken' });
    }
    logAudit(req.user.id, 'MOCK2_PROJECT_WAKE', 'mock2_project', project.id, { name: project.name }, req.ip);
    startWake(project);
    res.status(202).json({ project: shapeProject(getProject(project.id), { isAdmin: isReqAdmin(req) }) });
  });

  // Idle-stop window (M3 groundwork). Admin-gated read/write of the
  // mock2_settings.idle_stop_days value that the idle sweep (idle.js) keys off.
  router.get('/settings/idle-stop-days', requireAdmin, (_req, res) => {
    res.json({ idle_stop_days: getIdleStopDays() });
  });
  router.post('/settings/idle-stop-days', requireAdmin, (req, res) => {
    const parsed = idleDaysSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'days must be an integer between 0 and 3650 (0 disables idle-stop)' });
    setMock2Setting(IDLE_STOP_DAYS_KEY, parsed.data.days, req.user.id);
    logAudit(req.user.id, 'MOCK2_SETTING_IDLE_STOP_DAYS', 'mock2_setting', 0, { days: parsed.data.days }, req.ip);
    res.json({ idle_stop_days: getIdleStopDays() });
  });

  // ---- Egress allowlist (M4, ADR-010) ----
  // The per-project filtering-proxy allowlist. Admin-gated + audit-logged (an
  // allowlist edit widens what a container can reach — a security-relevant
  // change). Read is allowed to any project member so editors/viewers can SEE
  // the fence; only admins mutate it. refuseIfArchived on the mutators (an
  // archived project is read-only, Q4). Every edit re-renders the squid ACL.
  router.get('/projects/:id/egress-allowlist', requireMock2Role('viewer'), (req, res) => {
    res.json({ hosts: listAllowlist(req.mock2Project.id), editable: isReqAdmin(req) });
  });

  router.post('/projects/:id/egress-allowlist', requireAdmin, requireMock2Role('editor'), refuseIfArchived, async (req, res) => {
    const project = req.mock2Project;
    const host = normalizeAllowlistHost(req.body?.host);
    if (!isAllowlistHost(host)) {
      return res.status(400).json({ error: 'host must be a bare hostname or domain (e.g. registry.npmjs.org or .npmjs.org)' });
    }
    const { added } = addAllowlistHost(project.id, host, req.user.id);
    // Regenerate the squid ACL so the change is live. Non-fatal (a squid that is
    // absent leaves the fence denying — safe direction).
    const egress = await reconcileMock2Egress().catch((e) => ({ ok: false, error: e?.message }));
    logAudit(req.user.id, 'MOCK2_EGRESS_ALLOW_ADD', 'mock2_project', project.id, { host, added }, req.ip);
    res.json({ hosts: listAllowlist(project.id), added, egress });
  });

  router.delete('/projects/:id/egress-allowlist/:host', requireAdmin, requireMock2Role('editor'), refuseIfArchived, async (req, res) => {
    const project = req.mock2Project;
    const host = normalizeAllowlistHost(decodeURIComponent(req.params.host || ''));
    const { removed } = removeAllowlistHost(project.id, host);
    const egress = await reconcileMock2Egress().catch((e) => ({ ok: false, error: e?.message }));
    logAudit(req.user.id, 'MOCK2_EGRESS_ALLOW_REMOVE', 'mock2_project', project.id, { host, removed }, req.ip);
    res.json({ hosts: listAllowlist(project.id), removed, egress });
  });

  // Destroy a project: tear down its container, drop its slug block, delete the
  // row + memberships. The bare repo AND slug-history reservations are kept so
  // the slug stays un-reusable forever (ADR-006). Admin + fresh sudo. An
  // archived project is read-only (Q4) — it cannot be deleted, only rehydrated;
  // long-term purge policy is deferred (ADR-006 / Q4).
  router.delete('/projects/:id', requireAdmin, requireSudo, async (req, res) => {
    const project = getProject(Number(req.params.id));
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (project.lifecycle === 'archived') {
      return res.status(409).json({ error: 'Archived projects are read-only and cannot be deleted (rehydrate first). Purge policy is a future decision.' });
    }
    const containerName = project.container_name || containerNameForProject(project.id);
    // Remove the row first so the republish drops this project's FQDN blocks.
    deleteProject(project.id);
    resolveQueueItem(`mock2-provision:${project.id}`, { resolution: 'project deleted' });
    resolveQueueItem(`mock2-flag:${project.id}`, { resolution: 'project deleted' });
    let caddy = { ok: true };
    if (project.parent_domain_id) caddy = await publishDomain(project.parent_domain_id);
    // Destroy the container + its bridge; KEEP the bare repo (ADR-006 —
    // slug/history live on). The row is already deleted, so the fence + proxy
    // reconciles below drop this project from both plans (M4).
    teardownProject({ containerName, projectId: project.id, repoPath: project.repo_path, removeRepo: false })
      .then(() => Promise.all([
        reconcileMock2Firewall().catch((e) => console.error('[mock2] firewall reconcile (delete) failed:', e?.message)),
        reconcileMock2Egress().catch((e) => console.warn('[mock2] egress reconcile (delete) failed:', e?.message)),
      ]))
      .catch((err) => console.error('[mock2] teardown failed:', err?.message));
    logAudit(req.user.id, 'MOCK2_PROJECT_DELETE', 'mock2_project', project.id, { name: project.name, slug: project.slug }, req.ip);
    res.json({ ok: true, caddy });
  });

  // ============================================================
  // M5 — Model connectors, slots, prices (ADR-003; backup-destinations pattern)
  // ============================================================
  // A configured connector's API host becomes reachable from project containers
  // (the M4 egress seam) — so create/update/delete re-reconcile the squid ACLs.
  const reReconcileEgress = () => reconcileMock2Egress().catch((e) => ({ ok: false, error: e?.message }));

  router.get('/connectors', requireAdmin, (_req, res) => {
    res.json({ connectors: listConnectors().map(shapeConnector) });
  });

  router.get('/connectors/:id', requireAdmin, (req, res) => {
    const row = getConnector(req.params.id);
    if (!row) return res.status(404).json({ error: 'Connector not found' });
    res.json({ connector: shapeConnector(row) });
  });

  router.post('/connectors', requireAdmin, async (req, res) => {
    const parsed = connectorCreateSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'invalid connector' });
    const d = parsed.data;
    const vErr = validateConnectorInput({ provider: d.provider, base_url: d.base_url });
    if (vErr) return res.status(400).json({ error: vErr });
    if (getConnectorByName(d.name)) return res.status(409).json({ error: `A connector named "${d.name}" already exists` });
    const capabilities = d.capabilities?.length ? normalizeCapabilities(d.capabilities) : defaultCapabilitiesForProvider(d.provider);
    if (capabilities.length === 0) return res.status(400).json({ error: 'A connector needs at least one capability' });
    const row = insertConnector({
      name: d.name, provider: d.provider, baseUrl: d.base_url,
      apiKey: d.api_key, capabilities, enabled: d.enabled === false ? 0 : 1, createdBy: req.user.id,
    });
    logAudit(req.user.id, 'MOCK2_CONNECTOR_CREATE', 'mock2_model_connector', row.id, { name: d.name, provider: d.provider }, req.ip);
    const egress = await reReconcileEgress();
    // BAA acknowledgement (Q7): a cloud connector prompts a one-time ack. Not a
    // blocker — the connector is already saved; the client shows the ack modal
    // and POSTs /baa-ack. baa_ack_required tells it whether to.
    res.status(201).json({
      connector: shapeConnector(row),
      baa_ack_required: requiresBaaAck(d.provider, row.baa_ack_at),
      egress,
    });
  });

  router.put('/connectors/:id', requireAdmin, async (req, res) => {
    const row = getConnector(req.params.id);
    if (!row) return res.status(404).json({ error: 'Connector not found' });
    const parsed = connectorUpdateSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'invalid update' });
    const d = parsed.data;
    if (d.name && d.name !== row.name && getConnectorByName(d.name)) {
      return res.status(409).json({ error: `A connector named "${d.name}" already exists` });
    }
    const nextBaseUrl = d.base_url !== undefined ? d.base_url : row.base_url;
    const vErr = validateConnectorInput({ provider: row.provider, base_url: nextBaseUrl });
    if (vErr) return res.status(400).json({ error: vErr });
    const fields = {};
    if (d.name !== undefined) fields.name = d.name;
    if (d.base_url !== undefined) fields.base_url = d.base_url;
    if (d.api_key !== undefined) fields.apiKey = d.api_key;
    if (d.capabilities !== undefined) {
      const caps = normalizeCapabilities(d.capabilities);
      if (caps.length === 0) return res.status(400).json({ error: 'A connector needs at least one capability' });
      fields.capabilities = caps;
    }
    if (d.enabled !== undefined) fields.enabled = d.enabled;
    const updated = updateConnector(row.id, fields);
    logAudit(req.user.id, 'MOCK2_CONNECTOR_UPDATE', 'mock2_model_connector', row.id,
      { name: updated.name, secret_rotated: d.api_key !== undefined }, req.ip);
    const egress = await reReconcileEgress();
    res.json({ connector: shapeConnector(updated), egress });
  });

  router.delete('/connectors/:id', requireAdmin, requireSudo, async (req, res) => {
    const row = getConnector(req.params.id);
    if (!row) return res.status(404).json({ error: 'Connector not found' });
    deleteConnector(row.id);
    logAudit(req.user.id, 'MOCK2_CONNECTOR_DELETE', 'mock2_model_connector', row.id, { name: row.name }, req.ip);
    const egress = await reReconcileEgress();
    res.json({ ok: true, egress });
  });

  // Test connection — a lightweight "list models" GET that validates the key
  // without spending generation tokens. Caches the verdict on the row.
  router.post('/connectors/:id/test', requireAdmin, async (req, res) => {
    const row = getConnector(req.params.id);
    if (!row) return res.status(404).json({ error: 'Connector not found' });
    const verdict = await testConnector(row);
    logAudit(req.user.id, 'MOCK2_CONNECTOR_TEST', 'mock2_model_connector', row.id, { ok: verdict.ok }, req.ip);
    res.json({ ...verdict, connector: shapeConnector(getConnector(row.id)) });
  });

  // Record the one-time BAA acknowledgement (Q7). Cloud connectors only.
  router.post('/connectors/:id/baa-ack', requireAdmin, (req, res) => {
    const row = getConnector(req.params.id);
    if (!row) return res.status(404).json({ error: 'Connector not found' });
    if (!isCloudProvider(row.provider)) return res.status(400).json({ error: 'BAA acknowledgement applies to cloud connectors only' });
    const updated = recordBaaAck(row.id, req.user.id);
    logAudit(req.user.id, 'MOCK2_CONNECTOR_BAA_ACK', 'mock2_model_connector', row.id, { provider: row.provider }, req.ip);
    res.json({ connector: shapeConnector(updated) });
  });

  // ---- Model slots (the 7 stages) ----
  router.get('/model-slots', requireAdmin, (_req, res) => {
    const rows = listSlots();
    const bySlot = new Map(rows.map((r) => [r.slot, r]));
    // Return every slot (assigned or not) so the UI can render the full matrix.
    const slots = MODEL_SLOTS.map((slot) => {
      const r = bySlot.get(slot) || null;
      const conn = r ? getConnector(r.connector_id) : null;
      return {
        slot,
        connector_id: r?.connector_id || null,
        connector_name: conn?.name || null,
        model: r?.model || null,
        updated_at: r?.updated_at || null,
      };
    });
    res.json({ slots });
  });

  router.put('/model-slots/:slot', requireAdmin, (req, res) => {
    const slot = req.params.slot;
    if (!MODEL_SLOTS.includes(slot)) return res.status(404).json({ error: 'Unknown slot' });
    const parsed = slotAssignSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'connector_id and model are required' });
    const conn = getConnector(parsed.data.connector_id);
    if (!conn) return res.status(400).json({ error: 'No such connector' });
    if (!conn.enabled) return res.status(400).json({ error: 'Connector is disabled — enable it before assigning a slot' });
    // Capability enforcement: build_runner refuses a chat-only model, etc.
    const capErr = slotAssignmentError(parseCapabilities(conn.capabilities), slot);
    if (capErr) return res.status(400).json({ error: capErr });
    const row = setSlot({ slot, connectorId: conn.id, model: parsed.data.model, updatedBy: req.user.id });
    logAudit(req.user.id, 'MOCK2_SLOT_ASSIGN', 'mock2_model_slot', 0, { slot, connector_id: conn.id, model: row.model }, req.ip);
    res.json({ slot: { slot, connector_id: conn.id, connector_name: conn.name, model: row.model, updated_at: row.updated_at } });
  });

  router.delete('/model-slots/:slot', requireAdmin, (req, res) => {
    const slot = req.params.slot;
    if (!MODEL_SLOTS.includes(slot)) return res.status(404).json({ error: 'Unknown slot' });
    const { cleared } = clearSlot(slot);
    logAudit(req.user.id, 'MOCK2_SLOT_CLEAR', 'mock2_model_slot', 0, { slot }, req.ip);
    res.json({ ok: true, cleared });
  });

  // ---- Model prices (per connector+model, effective-dated) ----
  router.get('/connectors/:id/prices', requireAdmin, (req, res) => {
    const row = getConnector(req.params.id);
    if (!row) return res.status(404).json({ error: 'Connector not found' });
    res.json({ prices: listPrices(row.id) });
  });

  router.post('/connectors/:id/prices', requireAdmin, (req, res) => {
    const row = getConnector(req.params.id);
    if (!row) return res.status(404).json({ error: 'Connector not found' });
    const parsed = priceSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'invalid price' });
    const d = parsed.data;
    const prices = upsertPrice({
      connectorId: row.id, model: d.model,
      inputCentsPerMtok: d.input_cents_per_mtok, outputCentsPerMtok: d.output_cents_per_mtok,
      effectiveAt: d.effective_at,
    });
    logAudit(req.user.id, 'MOCK2_PRICE_SET', 'mock2_model_connector', row.id, { model: d.model }, req.ip);
    res.json({ prices });
  });

  router.delete('/connectors/:id/prices/:priceId', requireAdmin, (req, res) => {
    const row = getConnector(req.params.id);
    if (!row) return res.status(404).json({ error: 'Connector not found' });
    const { deleted } = deletePrice(req.params.priceId);
    res.json({ ok: true, deleted });
  });

  // ============================================================
  // M5 — Quotas (ADR-003 / risk R5). canStartCycle is enforced by M6; here we
  // manage the budgets + expose live spend from the ledger.
  // ============================================================
  router.get('/quotas', requireAdmin, (_req, res) => {
    res.json({ quotas: listQuotas().map(shapeQuota) });
  });

  router.post('/quotas', requireAdmin, (req, res) => {
    const parsed = quotaSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'invalid quota' });
    const d = parsed.data;
    if (d.scope === 'project' && d.project_id == null) return res.status(400).json({ error: 'project_id is required for a project-scoped quota' });
    const row = upsertQuota({
      scope: d.scope,
      projectId: d.scope === 'project' ? Number(d.project_id) : null,
      period: d.period,
      budgetCents: d.budget_cents ?? null,
      budgetWallClockMin: d.budget_wall_clock_min ?? null,
      maxConcurrentCycles: d.max_concurrent_cycles ?? null,
      bufferPct: d.buffer_pct ?? 15,
    });
    logAudit(req.user.id, 'MOCK2_QUOTA_SET', 'mock2_quota', row.id, { scope: d.scope, period: d.period, budget_cents: d.budget_cents ?? null }, req.ip);
    res.json({ quota: shapeQuota(row) });
  });

  router.delete('/quotas/:id', requireAdmin, (req, res) => {
    const row = getQuota(req.params.id);
    if (!row) return res.status(404).json({ error: 'Quota not found' });
    deleteQuota(row.id);
    logAudit(req.user.id, 'MOCK2_QUOTA_DELETE', 'mock2_quota', row.id, { scope: row.scope, period: row.period }, req.ip);
    res.json({ ok: true });
  });

  // ============================================================
  // M5 — Git connectors + project remotes + zip export (ADR-006)
  // Credentials never enter a container; push runs orchestrator-side.
  // ============================================================
  router.get('/git-connectors', requireAdmin, (_req, res) => {
    res.json({ connectors: listGitConnectors().map(shapeGitConnector) });
  });

  router.post('/git-connectors', requireAdmin, (req, res) => {
    const parsed = gitConnectorCreateSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'invalid git connector' });
    const d = parsed.data;
    const vErr = validateGitConnectorInput({ provider: d.provider, auth_kind: d.auth_kind, base_url: d.base_url });
    if (vErr) return res.status(400).json({ error: vErr });
    if (getGitConnectorByName(d.name)) return res.status(409).json({ error: `A git connector named "${d.name}" already exists` });
    const row = insertGitConnector({ name: d.name, provider: d.provider, baseUrl: d.base_url, authKind: d.auth_kind, credential: d.credential, createdBy: req.user.id });
    logAudit(req.user.id, 'MOCK2_GIT_CONNECTOR_CREATE', 'mock2_git_connector', row.id, { name: d.name, provider: d.provider }, req.ip);
    res.status(201).json({ connector: shapeGitConnector(row) });
  });

  router.put('/git-connectors/:id', requireAdmin, (req, res) => {
    const row = getGitConnector(req.params.id);
    if (!row) return res.status(404).json({ error: 'Git connector not found' });
    const parsed = gitConnectorUpdateSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'invalid update' });
    const d = parsed.data;
    if (d.name && d.name !== row.name && getGitConnectorByName(d.name)) {
      return res.status(409).json({ error: `A git connector named "${d.name}" already exists` });
    }
    const nextProvider = row.provider;
    const nextAuth = d.auth_kind || row.auth_kind;
    const nextBase = d.base_url !== undefined ? d.base_url : row.base_url;
    const vErr = validateGitConnectorInput({ provider: nextProvider, auth_kind: nextAuth, base_url: nextBase });
    if (vErr) return res.status(400).json({ error: vErr });
    const updated = updateGitConnector(row.id, d);
    logAudit(req.user.id, 'MOCK2_GIT_CONNECTOR_UPDATE', 'mock2_git_connector', row.id, { name: updated.name, secret_rotated: d.credential !== undefined }, req.ip);
    res.json({ connector: shapeGitConnector(updated) });
  });

  router.delete('/git-connectors/:id', requireAdmin, requireSudo, (req, res) => {
    const row = getGitConnector(req.params.id);
    if (!row) return res.status(404).json({ error: 'Git connector not found' });
    deleteGitConnector(row.id);
    logAudit(req.user.id, 'MOCK2_GIT_CONNECTOR_DELETE', 'mock2_git_connector', row.id, { name: row.name }, req.ip);
    res.json({ ok: true });
  });

  router.post('/git-connectors/:id/test', requireAdmin, async (req, res) => {
    const row = getGitConnector(req.params.id);
    if (!row) return res.status(404).json({ error: 'Git connector not found' });
    const verdict = await testGitConnector(row);
    logAudit(req.user.id, 'MOCK2_GIT_CONNECTOR_TEST', 'mock2_git_connector', row.id, { ok: verdict.ok }, req.ip);
    res.json({ ...verdict, connector: shapeGitConnector(getGitConnector(row.id)) });
  });

  // Project remote config (which git connector + remote repo a project pushes
  // to). Read is viewer; mutate is admin (a push target is a security-relevant
  // egress). refuseIfArchived on the mutators.
  router.get('/projects/:id/remote', requireMock2Role('viewer'), (req, res) => {
    const remote = getProjectRemote(req.mock2Project.id);
    res.json({ remote: remote ? shapeProjectRemote(remote) : null, editable: isReqAdmin(req) });
  });

  router.post('/projects/:id/remote', requireAdmin, requireMock2Role('editor'), refuseIfArchived, (req, res) => {
    const project = req.mock2Project;
    const parsed = projectRemoteSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'invalid remote' });
    const d = parsed.data;
    const conn = getGitConnector(d.git_connector_id);
    if (!conn) return res.status(400).json({ error: 'No such git connector' });
    const remote = setProjectRemote({ projectId: project.id, gitConnectorId: conn.id, remoteRepo: d.remote_repo, pushOnCheckpoint: d.push_on_checkpoint ? 1 : 0 });
    logAudit(req.user.id, 'MOCK2_PROJECT_REMOTE_SET', 'mock2_project', project.id, { git_connector_id: conn.id, remote_repo: d.remote_repo }, req.ip);
    res.json({ remote: shapeProjectRemote(remote) });
  });

  router.delete('/projects/:id/remote', requireAdmin, requireMock2Role('editor'), refuseIfArchived, (req, res) => {
    const project = req.mock2Project;
    const { cleared } = clearProjectRemote(project.id);
    logAudit(req.user.id, 'MOCK2_PROJECT_REMOTE_CLEAR', 'mock2_project', project.id, {}, req.ip);
    res.json({ ok: true, cleared });
  });

  // Export as zip = git archive of the bare repo (ADR-006). Any member may
  // export. Streams application/zip.
  router.get('/projects/:id/export.zip', requireMock2Role('viewer'), async (req, res) => {
    const project = req.mock2Project;
    if (!project.repo_path) return res.status(409).json({ error: 'Project has no repository to export' });
    const out = await exportProjectZip(project.repo_path);
    if (!out.ok) return res.status(500).json({ error: `Export failed: ${out.error}` });
    logAudit(req.user.id, 'MOCK2_PROJECT_EXPORT_ZIP', 'mock2_project', project.id, { bytes: out.buffer.length }, req.ip);
    const fname = `${project.slug || `project-${project.id}`}.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    res.send(out.buffer);
  });

  // ============================================================
  // M5 — Framework registry (ADR-003). Admin-gated editor; content immutable per
  // version; revert = new version carrying old content; logAudit on publish.
  // ============================================================
  router.get('/framework/versions', requireAdmin, (_req, res) => {
    res.json({ versions: listFrameworkVersions().map((r) => publicFrameworkShape(r)) });
  });

  router.get('/framework/current', requireAdmin, (_req, res) => {
    const row = getCurrentFrameworkVersion();
    res.json({ version: row ? publicFrameworkShape(row, { includeContent: true }) : null });
  });

  router.get('/framework/versions/:id', requireAdmin, (req, res) => {
    const row = getFrameworkVersion(req.params.id);
    if (!row) return res.status(404).json({ error: 'Framework version not found' });
    res.json({ version: publicFrameworkShape(row, { includeContent: true }) });
  });

  // Publish a new version (edit → diff → commit is a client-side flow; the
  // server just validates content and appends the next monotonic version).
  router.post('/framework/versions', requireAdmin, (req, res) => {
    const parsed = frameworkContentSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'invalid framework content' });
    const d = parsed.data;
    const v = validateFrameworkContent(d);
    if (!v.ok) return res.status(400).json({ error: v.error });
    const row = insertFrameworkVersion({
      constitution_md: d.constitution_md,
      skills_json: d.skills_json,
      gates_json: d.gates_json,
      design_system_md: d.design_system_md,
      project_template_ref: d.project_template_ref,
      changelog: d.changelog || null,
      source: 'in_app',
      createdBy: req.user.id,
    });
    logAudit(req.user.id, 'MOCK2_FRAMEWORK_PUBLISH', 'mock2_framework_version', row.id, { version: row.version }, req.ip);
    res.status(201).json({ version: publicFrameworkShape(row, { includeContent: true }) });
  });

  // Revert to an existing version = publish a NEW version carrying that
  // version's content (content rows are immutable; ADR-003).
  router.post('/framework/versions/:id/revert', requireAdmin, (req, res) => {
    const source = getFrameworkVersion(req.params.id);
    if (!source) return res.status(404).json({ error: 'Framework version not found' });
    const content = buildRevertContent(source, { changelog: req.body?.changelog || null });
    const row = insertFrameworkVersion({
      constitution_md: content.constitution_md,
      skills_json: content.skills_json,
      gates_json: content.gates_json,
      design_system_md: content.design_system_md,
      project_template_ref: content.project_template_ref,
      changelog: content.changelog,
      revertedFromVersion: content.reverted_from_version,
      source: 'in_app',
      createdBy: req.user.id,
    });
    logAudit(req.user.id, 'MOCK2_FRAMEWORK_REVERT', 'mock2_framework_version', row.id,
      { version: row.version, reverted_from_version: source.version }, req.ip);
    res.status(201).json({ version: publicFrameworkShape(row, { includeContent: true }) });
  });

  // ============================================================
  // M6 — Cycle runner + checkout lock (ADR-003/004). A cycle is one targeted
  // change: exec into the fenced container, run the pinned gates, checkpoint. The
  // lock guards the CONTAINER (ADR-004) — startCycle takes it as the cycle holder
  // and the runner releases it (checkpoint-then-release). The container-writing
  // mutation M6 introduces is the cycle; membership/flag/domain edits are metadata
  // and don't take the lock (ADR-004: the lock guards the working tree + dev
  // server + project DB, not the registry row). refuseIfArchived on the mutators.
  // ============================================================

  // Start a cycle (editor-gated). estimate → canStartCycle quota check
  // (refused_quota terminal) → pin framework version → take lock → copy pinned
  // gates → run in the background. 202 + poll (or 200 refused_quota).
  router.post('/projects/:id/cycles', requireMock2Role('editor'), refuseIfArchived, async (req, res) => {
    const project = req.mock2Project;
    const parsed = cycleStartSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'instruction is required (1–2000 chars)' });
    let result;
    try {
      result = await startCycle({
        project, instruction: parsed.data.instruction,
        initiatedBy: req.user.id, actingAsAdmin: req.mock2Access.actingAsAdmin ? 1 : 0,
      });
    } catch (err) {
      return res.status(500).json({ error: `Could not start cycle: ${err?.message || 'unknown error'}` });
    }
    if (result.status === 'error') return res.status(409).json({ error: result.error });
    logAudit(req.user.id, 'MOCK2_CYCLE_START', 'mock2_cycle', result.cycle?.id || 0,
      { instruction: parsed.data.instruction, status: result.status, acting_as_admin: req.mock2Access.actingAsAdmin }, req.ip);
    return res.status(result.status === 'refused' ? 200 : 202).json({
      cycle: publicCycleShape(result.cycle), refused: result.status === 'refused', reason: result.error || null,
    });
  });

  // List a project's cycles (viewer).
  router.get('/projects/:id/cycles', requireMock2Role('viewer'), (req, res) => {
    res.json({ cycles: listCyclesForProject(req.mock2Project.id).map(publicCycleShape) });
  });

  // The project's latest cycle — the poll target for the "gates going green" view.
  router.get('/projects/:id/cycle', requireMock2Role('viewer'), (req, res) => {
    const cycle = latestCycle(req.mock2Project.id);
    res.json({ cycle: cycle ? publicCycleShape(cycle) : null, job: cycle ? getCycleJobStatus(cycle.id) : null });
  });

  // Poll one cycle (viewer). Job progress rides alongside (house 202+poll pattern).
  router.get('/projects/:id/cycles/:cycleId', requireMock2Role('viewer'), (req, res) => {
    const cycle = getCycle(req.params.cycleId);
    if (!cycle || cycle.project_id !== req.mock2Project.id) return res.status(404).json({ error: 'Cycle not found' });
    res.json({ cycle: publicCycleShape(cycle), job: getCycleJobStatus(cycle.id) });
  });

  // Request an interrupt on a running cycle (editor). Honored at the next step
  // boundary by the runner: queue_after_step / stop_after_step / abandon.
  router.post('/projects/:id/cycles/:cycleId/interrupt', requireMock2Role('editor'), refuseIfArchived, (req, res) => {
    const cycle = getCycle(req.params.cycleId);
    if (!cycle || cycle.project_id !== req.mock2Project.id) return res.status(404).json({ error: 'Cycle not found' });
    const parsed = interruptSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: `action must be one of ${INTERRUPTS.join(', ')}` });
    if (cycle.status !== 'running') return res.status(409).json({ error: `Cycle is "${cycle.status}", not running` });
    setInterrupt(cycle.id, parsed.data.action);
    logAudit(req.user.id, 'MOCK2_CYCLE_INTERRUPT', 'mock2_cycle', cycle.id, { action: parsed.data.action }, req.ip);
    res.json({ cycle: publicCycleShape(getCycle(cycle.id)) });
  });

  // Admin stop-all — interrupt every running cycle (escape hatch). Sets
  // stop_after_step so runners checkpoint and stop at their next boundary.
  router.post('/cycles/stop-all', requireAdmin, (req, res) => {
    const r = stopAllCycles();
    logAudit(req.user.id, 'MOCK2_CYCLE_STOP_ALL', 'mock2_cycle', 0, r, req.ip);
    res.json(r);
  });

  // ---- Checkout lock (ADR-004) ----

  // Lock status for the project-detail banner (any member). Holder, remaining
  // time, warn state, takeover-pending.
  router.get('/projects/:id/lock', requireMock2Role('viewer'), (req, res) => {
    const lock = getLock(req.mock2Project.id);
    let holderName = null;
    if (lock?.holder_user_id) { const u = lookupUser(lock.holder_user_id); holderName = u?.username || `user ${lock.holder_user_id}`; }
    else if (lock?.holder_cycle_id) holderName = `cycle #${lock.holder_cycle_id}`;
    res.json({
      lock: publicLockShape(lock, { nowIso: new Date().toISOString(), idleMinutes: getLockIdleMinutes(), holderName }),
      my_role: req.mock2Access.role,
      idle_minutes: getLockIdleMinutes(),
    });
  });

  // Request a takeover — pings the current holder (editor). Doesn't release; the
  // holder decides, the lock idle-expires, or an admin force-releases.
  router.post('/projects/:id/lock/takeover', requireMock2Role('editor'), refuseIfArchived, (req, res) => {
    const r = requestTakeover(req.mock2Project.id, req.user.id);
    if (!r.ok) return res.status(409).json({ error: 'Project is not checked out.' });
    logAudit(req.user.id, 'MOCK2_LOCK_TAKEOVER_REQUEST', 'mock2_project', req.mock2Project.id, {}, req.ip);
    res.json({ ok: true, lock: publicLockShape(getLock(req.mock2Project.id), { nowIso: new Date().toISOString(), idleMinutes: getLockIdleMinutes() }) });
  });

  // Admin force-release (ADR-004 — audit-logged). The override for a stuck lock.
  router.post('/projects/:id/lock/force-release', requireAdmin, requireMock2Role('editor'), (req, res) => {
    const project = req.mock2Project;
    const lock = getLock(project.id);
    if (!lock) return res.status(409).json({ error: 'Project is not checked out.' });
    releaseLock(project.id);
    logAudit(req.user.id, 'MOCK2_LOCK_FORCE_RELEASE', 'mock2_project', project.id,
      { released_holder_user: lock.holder_user_id ?? null, released_holder_cycle: lock.holder_cycle_id ?? null }, req.ip);
    res.json({ ok: true });
  });

  // Lock idle-timeout (ADR-004 default 15 min). Admin read/write of the
  // mock2_settings.lock_idle_minutes value the lock sweep keys off.
  router.get('/settings/lock-idle-minutes', requireAdmin, (_req, res) => {
    res.json({ lock_idle_minutes: getLockIdleMinutes() });
  });
  router.post('/settings/lock-idle-minutes', requireAdmin, (req, res) => {
    const parsed = lockIdleSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'minutes must be an integer between 1 and 1440' });
    setMock2Setting(LOCK_IDLE_MINUTES_KEY, parsed.data.minutes, req.user.id);
    logAudit(req.user.id, 'MOCK2_SETTING_LOCK_IDLE', 'mock2_setting', 0, { minutes: parsed.data.minutes }, req.ip);
    res.json({ lock_idle_minutes: getLockIdleMinutes() });
  });

  // ---- Change records + chain verification (03-data-model.md; M10 formalizes) ----

  // The project's append-only, hash-chained change history + a live verification
  // of the whole chain (any member). The M6 verify checklist asserts this passes.
  router.get('/projects/:id/change-records', requireMock2Role('viewer'), (req, res) => {
    const records = listChangeRecords(req.mock2Project.id).map((r) => {
      let gates = null;
      try { gates = r.gates_run ? JSON.parse(r.gates_run) : null; } catch { gates = null; }
      return {
        seq: r.seq, prev_hash: r.prev_hash, hash: r.hash, summary: r.summary,
        commit_sha: r.commit_sha, gates_run: gates, framework_version: r.framework_version,
        cycle_id: r.cycle_id, initiated_by: r.initiated_by,
        acting_as_admin: Number(r.acting_as_admin) === 1, created_at: r.created_at,
      };
    });
    res.json({ records, verification: verifyProjectChain(req.mock2Project.id) });
  });

  // ============================================================
  // M7 — Stage 1 (Concept): chat, mockup, design approval. A Builder describes an
  // idea in chat; the concept loop (concept_chat + mockup slots, constrained to
  // the pinned design system) generates an interactive HTML mockup served at the
  // project's preview URL; iteration is conversational; the ONLY exit is the
  // design-approval gesture that extracts state/inventory.json, discards the
  // mockup, records a hash-chained change record (sign-off #1), and unlocks Build.
  // Chat polls (whole-message updates) like the rest of the app. A human chat
  // write takes the checkout lock (ADR-004). refuseIfArchived on the mutators.
  // ============================================================

  // The concept-stage view: the whole chat, the live turn/approval job, the stage
  // indicator, and the mockup preview URL (any member — viewers watch, editors
  // drive). Polled while a turn is in flight.
  router.get('/projects/:id/chat', requireMock2Role('viewer'), (req, res) => {
    const project = req.mock2Project;
    const shaped = shapeProject(project, { isAdmin: isReqAdmin(req) });
    const ready = conceptReady();
    res.json({
      messages: listMessages(project.id).map(publicChatMessageShape),
      job: getConceptJobStatus(project.id),
      stage: shaped.stage,
      current_mockup_id: shaped.current_mockup_id,
      preview_url: shaped.preview_url,
      concept_ready: ready.ok,
      concept_ready_reason: ready.ok ? null : ready.reason,
      my_role: req.mock2Access.role,
    });
  });

  // Send a chat message (editor-gated — a chat write takes the lock and may
  // mutate the container). 202 + poll: the user message lands immediately, the
  // assistant reply + any mockup update arrive on the background turn.
  router.post('/projects/:id/chat', requireMock2Role('editor'), refuseIfArchived, async (req, res) => {
    const project = req.mock2Project;
    const parsed = chatMessageSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'message is required (1–4000 chars)' });
    let result;
    try {
      result = await startConceptTurn({
        project, message: parsed.data.message, user: req.user,
        actingAsAdmin: req.mock2Access.actingAsAdmin ? 1 : 0,
      });
    } catch (err) {
      return res.status(500).json({ error: `Could not send message: ${err?.message || 'unknown error'}` });
    }
    if (result.status === 'error') return res.status(409).json({ error: result.error });
    logAudit(req.user.id, 'MOCK2_CHAT_MESSAGE', 'mock2_project', project.id,
      { acting_as_admin: req.mock2Access.actingAsAdmin, status: result.status }, req.ip);
    return res.status(result.status === 'refused' ? 200 : 202).json({
      message: result.userMessage ? publicChatMessageShape(result.userMessage) : null,
      refused: result.status === 'refused', reason: result.error || null,
      job: getConceptJobStatus(project.id),
    });
  });

  // Approve the design — Stage 1's only exit (sign-off #1). Editor-gated. 202 +
  // poll: extraction/commit run in the background; the frontend polls the chat
  // endpoint until stage.design_approved flips (or a system message reports why
  // it couldn't).
  router.post('/projects/:id/design/approve', requireMock2Role('editor'), refuseIfArchived, async (req, res) => {
    const project = req.mock2Project;
    let result;
    try {
      result = await startDesignApproval({
        project, user: req.user, actingAsAdmin: req.mock2Access.actingAsAdmin ? 1 : 0,
      });
    } catch (err) {
      return res.status(500).json({ error: `Could not approve the design: ${err?.message || 'unknown error'}` });
    }
    if (result.status === 'error') return res.status(409).json({ error: result.error });
    logAudit(req.user.id, 'MOCK2_DESIGN_APPROVE', 'mock2_project', project.id,
      { acting_as_admin: req.mock2Access.actingAsAdmin }, req.ip);
    return res.status(202).json({ job: getConceptJobStatus(project.id) });
  });

  return router;
}

// Best-effort A/AAAA lookup for a custom domain, cross-checked against
// MOCK2_PUBLIC_IP when set. Returns { ok, resolved, matched, reason } — never
// throws; a mismatch is a warning, not a hard block (the operator may be behind
// a proxy/CDN the host can't see).
async function checkARecord(domain) {
  const expected = (process.env.MOCK2_PUBLIC_IP || '').split(',').map((s) => s.trim()).filter(Boolean);
  let resolved = [];
  try { resolved = resolved.concat(await dns.resolve4(domain)); } catch { /* no A */ }
  try { resolved = resolved.concat(await dns.resolve6(domain)); } catch { /* no AAAA */ }
  if (resolved.length === 0) {
    return { ok: false, resolved, matched: false, reason: 'domain does not resolve — point an A/AAAA record at this host' };
  }
  if (expected.length === 0) {
    return { ok: true, resolved, matched: false, reason: 'resolves, but host public IP unknown (set MOCK2_PUBLIC_IP to cross-check)' };
  }
  const matched = resolved.some((ip) => expected.includes(ip));
  return matched
    ? { ok: true, resolved, matched: true, reason: 'resolves to this host' }
    : { ok: false, resolved, matched: false, reason: `resolves to ${resolved.join(', ')} but host answers on ${expected.join(', ')}` };
}
