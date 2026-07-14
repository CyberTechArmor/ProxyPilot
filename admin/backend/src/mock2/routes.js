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
import { validateDomain, publicDomainShape, isSelectable, parseHostIps } from './domain-logic.js';
import { runVerification } from './verify.js';
import { writeMock2DomainSite, unpublishMock2Domain, reloadMock2Caddy, removeMock2Certs } from './caddy.js';
import { raiseQueueItem, resolveQueueItem } from './queue.js';
import {
  listProjects,
  getProject,
  createProject,
  updateProject,
  deleteProject,
  deriveProjectSlug,
  SlugError,
  rotateProjectSlug,
  countEditors,
  countMembersByRole,
  listMembers,
  getMembership,
  upsertMember,
  removeMember,
  lookupUser,
  listProjectSlugs,
  purgeProjectSlugHistory,
  addTypingSeconds,
} from './projects.js';
import { computeTimeSummary, computeUsageSummary } from './time-logic.js';
import { publicProjectShape, isProjectReadOnly } from './project-logic.js';
import { deployProjectStatus } from './deploy-logic.js';
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
import { getIdleStopDays, setMock2Setting, IDLE_STOP_DAYS_KEY, getChatMaxChars, CHAT_MAX_CHARS_KEY, CHAT_MAX_CHARS_OPTIONS } from './settings.js';
import { reconcileMock2Egress, readEgressLog } from './egress.js';
import { bridgeCidrForProject } from './network-logic.js';
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
import { getCycleJobStatus, stopAllCycles, retryCycle, retryDeploy } from './runner.js';
import {
  getAuthorization, listOpenAuthorizations, listAuthorizationsForCycle,
  insertAuthorization, decideAuthorization, publicAuthorizationShape,
} from './authorizations.js';
import { resolveSelectedOption, haltOptionRequiresAdmin, haltOptionCarriesAuthorization } from './unblock-logic.js';
import { explainCard } from './explain.js';
import { EXPLAIN_MAX_INPUT_CHARS } from './explain-logic.js';
import {
  getCycle, listCyclesForProject, latestCycle, setInterrupt, finishCycle,
} from './cycles.js';
import { publicCycleShape, INTERRUPTS } from './cycle-logic.js';
import {
  getLock, releaseLock, requestTakeover, getLockIdleMinutes,
} from './locks.js';
import { publicLockShape, LOCK_IDLE_MINUTES_KEY } from './lock-logic.js';
import { listChangeRecords, verifyProjectChain } from './change-records.js';
import { listCycleEvents, listProjectCycleEvents, recordCycleFeedback, getCycleFeedback } from './cycle-events.js';
// ---- M7: Stage 1 (Concept) — chat, mockup, design approval ----
import { listMessages } from './chats.js';
import {
  startConceptTurn, startDesignApproval, getConceptJobStatus, conceptReady,
} from './concept.js';
import { publicChatMessageShape } from './concept-logic.js';
// ---- M8: audit, rule questions, admin queue (ADR-002/003) ----
import {
  startBuild, answerAuditQuestion, resolveFrameworkDeviation, getAuditJobStatus, auditReady,
} from './audit.js';
import {
  getQuestion, listQuestionsForProject, listOpenEditorQuestions,
  countOpenEditorQuestions, countOpenAdminQuestions,
} from './questions.js';
import {
  listQueueItems, getQueueItem, queueCounts, setQueueItemStatus,
  countAwaitingAdminItems, hasOpenDrift,
} from './queue.js';
import {
  QUEUE_KINDS, QUEUE_STATUSES, publicQuestionShape, publicQueueItemShape,
  isFrameworkDrifted,
} from './audit-logic.js';

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
    succeed(finalStatus = 'dns_ok') {
      updateParentDomain(row.id, {
        verify_status: finalStatus,
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
// The instruction ceiling is the same operator-configurable chat_max_chars the
// design chat uses (getChatMaxChars) — the length bound is applied in the handler,
// not baked in here, so raising the limit carries over to Build too.
const cycleStartSchema = z.object({
  instruction: z.string().trim().min(1),
});
const cycleFeedbackSchema = z.object({
  rating: z.enum(['up', 'down']),
  note: z.string().trim().max(4000).optional(),
});
const interruptSchema = z.object({
  action: z.enum(INTERRUPTS),
});
const lockIdleSchema = z.object({
  minutes: z.union([z.number().int(), z.string()]).transform((v) => Number(v))
    .refine((n) => Number.isInteger(n) && n >= 1 && n <= 1440, 'out of range'),
});
// ---- M7 Zod schemas ----
// The message ceiling is operator-configurable (mock2_settings.chat_max_chars),
// so the length bound is applied in the handler against getChatMaxChars() rather
// than baked into this static schema.
const chatMessageSchema = z.object({
  message: z.string().trim().min(1),
  // Conversation mode (M7): 'plan' talks through requirements without touching
  // the mockup; 'design' (default) may generate/iterate the mockup.
  mode: z.enum(['plan', 'design']).optional(),
});
// ---- M8 Zod schemas ----
const answerQuestionSchema = z.object({
  // Length bound applied in the handler against getChatMaxChars() (same ceiling
  // as the design + build chat), so a raised limit carries over here too.
  answer: z.string().trim().min(1),
});
const queueStatusSchema = z.object({
  status: z.enum(['open', 'in_progress', 'resolved', 'dismissed']),
  resolution: z.string().trim().max(1000).optional(),
  // Approve-as-edited (framework_deviation): the admin may rewrite the deviation
  // text and/or append conditions; the edited text becomes the authoritative record.
  editedText: z.string().trim().max(4000).optional(),
  conditions: z.string().trim().max(2000).optional(),
});
// Resume-with-message: optional operator guidance carried into the resumed cycle,
// and the id/label of a halt resolution option the operator chose.
const resumeSchema = z.object({
  message: z.string().trim().max(8000).optional(),
  option: z.string().trim().max(200).optional(),
});
// Scoped one-time authorization decision (admin): grant (optionally with appended
// conditions) or deny.
const authDecisionSchema = z.object({
  approved: z.boolean(),
  conditions: z.string().trim().max(2000).optional(),
});
// "Explain this" — a card's full text + minimal cycle context for the summary lane to
// rewrite in plain language. Read-only; card_id is opaque (used only for the audit note).
const explainSchema = z.object({
  text: z.string().trim().min(1).max(EXPLAIN_MAX_INPUT_CHARS + 4000),
  kind: z.enum(['blocker', 'authorization', 'deviation', 'rule_question']).optional(),
  title: z.string().trim().max(400).optional(),
  status: z.string().trim().max(60).optional(),
  card_id: z.string().trim().max(160).optional(),
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
  // M8 derived inputs (03-data-model.md — all DERIVED from open rows, never
  // stored): the audit-gate question counts, the open-drift signal, and the
  // "update available" framework comparison (ADR-003). Cheap COUNT queries; kept
  // in the shaper so both the tile list and the detail page derive identically.
  const openEditorQuestions = countOpenEditorQuestions(project.id);
  const openAdminItems = countOpenAdminQuestions(project.id) + countAwaitingAdminItems(project.id);
  const driftOpen = hasOpenDrift(project.id);
  const current = getCurrentFrameworkVersion();
  const frameworkUpdateAvailable = isFrameworkDrifted(project.last_built_framework_version_id, current?.id ?? null);
  const lastBuilt = project.last_built_framework_version_id ? getFrameworkVersion(project.last_built_framework_version_id) : null;
  // Run phase — the derived deploy signal from the latest cycle's deploy_status
  // (deploying/serving/deploy_failed). One cheap lookup, kept in the shaper so
  // the tile and the detail page derive the deploy state identically.
  const latest = latestCycle(project.id);
  const deployState = deployProjectStatus(latest?.deploy_status);
  return publicProjectShape(project, {
    parentDomain: parent?.domain || null,
    editorCount: counts.editor,
    viewerCount: counts.viewer,
    isAdmin,
    openEditorQuestions,
    openAdminItems,
    driftOpen,
    frameworkUpdateAvailable,
    frameworkCurrentVersion: current?.version ?? null,
    frameworkLastBuiltVersion: lastBuilt?.version ?? null,
    deployState,
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
    res.json({ status: 'ok', enabled: true, phase: 'M8' });
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
    // DNS-verified is enough to enable (operator decision): the per-slug
    // Let's Encrypt cert is issued when a project is actually created, not
    // up front. A legacy cert_ok row still qualifies.
    if (row.verify_status !== 'dns_ok' && row.verify_status !== 'cert_ok') {
      return res.status(409).json({ error: 'Domain must pass DNS verification before it can be enabled — run Verify first' });
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

    // The subdomain is derived from the project NAME (e.g. "My App" →
    // my-app.<domain>); a duplicate name is rejected, not disambiguated.
    let slug;
    try {
      slug = deriveProjectSlug(parentId, name);
    } catch (err) {
      if (err instanceof SlugError) return res.status(409).json({ error: err.message });
      throw err;
    }

    let project;
    try {
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
      progress: status ? { phase: status.phase, message: status.message, log: status.log || [] } : null,
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
    const userId = String(parsed.data.user_id);  // users.id is a UUID, never coerce to Number
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

  // Flag / unflag the project for admin attention (the one manual overlay). M8
  // extends this to VIEWERS (04-phased-plan §M8): a viewer who spots something
  // wrong can raise the `!` overlay + a queue item, exactly like an editor.
  router.post('/projects/:id/flag', requireMock2Role('viewer'), refuseIfArchived, (req, res) => {
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

  // Concept chat message limit. Admin-gated read/write of the
  // mock2_settings.chat_max_chars value the chat POST handler enforces. Only the
  // discrete CHAT_MAX_CHARS_OPTIONS (4k/8k/16k/32k) are accepted.
  router.get('/settings/chat-max-chars', requireAdmin, (_req, res) => {
    res.json({ max_chars: getChatMaxChars(), options: CHAT_MAX_CHARS_OPTIONS });
  });
  router.post('/settings/chat-max-chars', requireAdmin, (req, res) => {
    const parsed = z.object({
      max_chars: z.union([z.number(), z.string()]).transform((v) => Number(v))
        .refine((n) => CHAT_MAX_CHARS_OPTIONS.includes(n), 'unsupported value'),
    }).safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: `max_chars must be one of ${CHAT_MAX_CHARS_OPTIONS.join(', ')}` });
    }
    setMock2Setting(CHAT_MAX_CHARS_KEY, parsed.data.max_chars, req.user.id);
    logAudit(req.user.id, 'MOCK2_SETTING_CHAT_MAX_CHARS', 'mock2_setting', 0, { max_chars: parsed.data.max_chars }, req.ip);
    res.json({ max_chars: getChatMaxChars(), options: CHAT_MAX_CHARS_OPTIONS });
  });

  // Egress traffic log — what this project's container actually reached, as the
  // FIREWALL recorded it (the nftables fence logs every new outbound connection
  // to the kernel log; squid was removed). Read-only, any member (viewer+). The
  // firewall sees IP:port, not hostnames, so entries show the destination
  // address. Best-effort: a host without a readable kernel log returns an empty
  // list, not an error.
  router.get('/projects/:id/egress-log', requireMock2Role('viewer'), async (req, res) => {
    const project = req.mock2Project;
    const cidr = project.bridge_cidr || bridgeCidrForProject(project.id);
    const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 1000);
    const log = await readEgressLog(cidr, { limit }).catch((e) => ({ ok: false, error: e?.message, entries: [] }));
    res.json(log);
  });

  // ---- Time tracking ----
  // Accumulate active-typing seconds (the client measures spans of typing in the
  // design/build chats and flushes increments here). Editors only; a viewer isn't
  // driving the build.
  router.post('/projects/:id/typing', requireMock2Role('editor'), (req, res) => {
    const seconds = Number(req.body?.seconds);
    const total = addTypingSeconds(req.mock2Project.id, seconds);
    res.json({ ok: true, chat_typing_seconds: total });
  });

  // Time summary — project start + AI time (mockup / building / adjustments,
  // derived from cycle durations) + admin-wait (framework-deviation open→resolved)
  // + active-typing. Any member can see it.
  router.get('/projects/:id/time-summary', requireMock2Role('viewer'), (req, res) => {
    const project = getProject(req.mock2Project.id);
    const cycles = listCyclesForProject(project.id, { limit: 500 });
    const deviations = listQueueItems({ projectId: project.id, kind: 'framework_deviation', limit: 500 });
    res.json({
      summary: computeTimeSummary({ project, cycles, deviations, nowMs: Date.now() }),
      usage: computeUsageSummary({ cycles }),
    });
  });

  // Destroy a project: tear down its container + bridge, drop its slug block,
  // purge its certs, and delete the row + memberships + bare repo + slug-history
  // reservations. Delete is a FULL purge (operator decision): the name/URL is
  // released for reuse and the repo is removed — unlike archive, which stays
  // read-only and rehydratable and keeps everything. Admin + fresh sudo. An
  // archived project cannot be deleted, only rehydrated.
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
    if (project.parent_domain_id) {
      caddy = await publishDomain(project.parent_domain_id);
      // publishDomain dropped the routes, but Caddy keeps the issued certs on
      // disk until they expire — purge them so a deleted project leaves nothing
      // behind. Every FQDN the project ever served: current + rotated slugs, and
      // a custom domain. Best-effort (never blocks the delete response).
      try {
        const domain = getParentDomain(project.parent_domain_id);
        if (domain) {
          const fqdns = [...new Set([project.slug, ...listProjectSlugs(project.id)].filter(Boolean)
            .map((s) => `${s}.${domain.domain}`))];
          if (project.custom_domain) fqdns.push(project.custom_domain);
          await removeMock2Certs(fqdns);
        }
      } catch (err) {
        console.error('[mock2] cert cleanup on delete failed:', err?.message);
      }
    }
    // Release the slug reservations so the name/URL can be reused by a new
    // project (must run AFTER the cert cleanup above, which reads the history).
    try { purgeProjectSlugHistory(project.id); } catch (err) { console.error('[mock2] slug-history purge failed:', err?.message); }
    // Destroy the container + its bridge AND remove the bare repo — delete is a
    // full purge (see the route comment). The row is already deleted, so the
    // fence + proxy reconciles below drop this project from both plans (M4).
    teardownProject({ containerName, projectId: project.id, repoPath: project.repo_path, removeRepo: true })
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
    const maxChars = getChatMaxChars();
    const parsed = cycleStartSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: `instruction is required (1–${maxChars} chars)` });
    if (parsed.data.instruction.length > maxChars) {
      return res.status(400).json({ error: `instruction is too long (max ${maxChars} chars)` });
    }
    // M8 (ADR-002): the Build press runs the AUDIT first. It compares the
    // approved inventory + rules.md + the pinned framework and either asks
    // editor/admin questions (blocking the build) or, when clear, hands off to
    // the M6 runner. 202 + poll: the audit runs in the background.
    let result;
    try {
      result = await startBuild({
        project, instruction: parsed.data.instruction,
        user: req.user, actingAsAdmin: req.mock2Access.actingAsAdmin ? 1 : 0,
      });
    } catch (err) {
      return res.status(500).json({ error: `Could not start the build: ${err?.message || 'unknown error'}` });
    }
    if (result.status === 'error') return res.status(409).json({ error: result.error });
    logAudit(req.user.id, 'MOCK2_BUILD_AUDIT_START', 'mock2_cycle', result.cycle?.id || 0,
      { instruction: parsed.data.instruction, status: result.status, acting_as_admin: req.mock2Access.actingAsAdmin }, req.ip);
    return res.status(result.status === 'refused' ? 200 : 202).json({
      cycle: publicCycleShape(result.cycle), refused: result.status === 'refused',
      audit: result.status === 'started', reason: result.error || null,
    });
  });

  // List a project's cycles (viewer).
  router.get('/projects/:id/cycles', requireMock2Role('viewer'), (req, res) => {
    res.json({ cycles: listCyclesForProject(req.mock2Project.id).map(publicCycleShape) });
  });

  // The project's latest cycle — the poll target for the "gates going green" view.
  // Carries the Builder's feedback (thumbs up/down) so the UI can require a rating
  // on a finished build before the next cycle.
  router.get('/projects/:id/cycle', requireMock2Role('viewer'), (req, res) => {
    const cycle = latestCycle(req.mock2Project.id);
    res.json({
      cycle: cycle ? { ...publicCycleShape(cycle), feedback: getCycleFeedback(cycle.id) } : null,
      job: cycle ? getCycleJobStatus(cycle.id) : null,
      // Pending one-time authorization requests (Part 4) so the blocked card can show
      // them + an admin Grant/Deny without a separate fetch.
      authorizations: listOpenAuthorizations(req.mock2Project.id).map(publicAuthorizationShape),
    });
  });

  // Record the Builder's thumbs up/down on a finished build (editor). A thumbs-down
  // requires a note; both land in the cycle's event log for later evaluation. Only
  // a terminal cycle can be rated (rating a running build makes no sense).
  router.post('/projects/:id/cycles/:cycleId/feedback', requireMock2Role('editor'), refuseIfArchived, (req, res) => {
    const cycle = getCycle(req.params.cycleId);
    if (!cycle || cycle.project_id !== req.mock2Project.id) return res.status(404).json({ error: 'Cycle not found' });
    if (['queued', 'estimating', 'running', 'awaiting_user', 'awaiting_admin'].includes(cycle.status)) {
      return res.status(409).json({ error: 'This build is still running — rate it once it finishes.' });
    }
    const parsed = cycleFeedbackSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'rating must be up or down' });
    const note = (parsed.data.note || '').trim();
    if (parsed.data.rating === 'down' && !note) {
      return res.status(400).json({ error: 'A note is required for a thumbs-down so the log can be evaluated.' });
    }
    const feedback = recordCycleFeedback({ projectId: req.mock2Project.id, cycleId: cycle.id, rating: parsed.data.rating, note: note || null, userId: req.user.id });
    logAudit(req.user.id, 'MOCK2_CYCLE_FEEDBACK', 'mock2_cycle', cycle.id, { rating: parsed.data.rating, has_note: !!note }, req.ip);
    res.json({ feedback });
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

  // Retry a stalled cycle (editor). When the runner exhausts its retries on a
  // transient failure (e.g. an upstream 429 rate limit) the cycle lands in
  // awaiting_admin/failed with no way forward from the chat. Once the cause is
  // fixed, this resolves the handoff queue item and starts a fresh cycle with the
  // same instruction, continuing from the checkpointed WIP. 202 + poll.
  router.post('/projects/:id/cycles/:cycleId/retry', requireMock2Role('editor'), refuseIfArchived, async (req, res) => {
    const project = req.mock2Project;
    const cycle = getCycle(req.params.cycleId);
    if (!cycle || cycle.project_id !== project.id) return res.status(404).json({ error: 'Cycle not found' });
    const parsedResume = resumeSchema.safeParse(req.body || {});
    if (!parsedResume.success) return res.status(400).json({ error: 'Invalid resume message/option.' });
    const optionId = parsedResume.data.option || null;
    const message = (parsedResume.data.message || '').trim();

    // Resolve the chosen halt option against what the model actually offered, so the
    // typed kind decides how the choice is applied (task Part 3). The offered options
    // are the audit-visible record of what was on the card.
    let offered = [];
    try { offered = cycle.halt_options_json ? JSON.parse(cycle.halt_options_json) : []; } catch { offered = []; }
    const chosen = optionId ? resolveSelectedOption(offered, optionId) : null;
    const offeredIds = (Array.isArray(offered) ? offered : []).map((o) => o?.id).filter(Boolean);
    const auditBase = {
      from_cycle: cycle.id,
      offered_options: offeredIds,
      chosen_option: chosen?.id || null,
      chosen_label: chosen?.label || null,
      chosen_kind: chosen?.kind || null,
      has_context: !!message,
      acting_as_admin: req.mock2Access.actingAsAdmin,
    };

    // The privileged kinds (grant a one-time authorization, override a rule) may only
    // be chosen by an admin — grant/deny folds into picking/rejecting the option.
    const actingAdmin = isReqAdmin(req) || req.mock2Access?.actingAsAdmin;
    if (chosen && haltOptionRequiresAdmin(chosen.kind) && !actingAdmin) {
      return res.status(403).json({ error: `Choosing “${chosen.label}” requires an administrator.` });
    }

    // Abandon closes the cycle as abandoned — no resume (task Part 3).
    if (chosen && chosen.kind === 'abandon') {
      finishCycle(cycle.id, { status: 'abandoned', error: `abandoned by operator${message ? `: ${message}` : ''}` });
      for (const key of [`mock2-blocked:${cycle.id}`, `mock2-retries:${cycle.id}`, `mock2-requeue:${cycle.id}`]) {
        try { resolveQueueItem(key, { resolution: 'abandoned by operator', resolvedBy: req.user.id }); } catch { /* best effort */ }
      }
      logAudit(req.user.id, 'MOCK2_CYCLE_ABANDON', 'mock2_cycle', cycle.id, { ...auditBase, context: message || null }, req.ip);
      return res.json({ cycle: publicCycleShape(getCycle(cycle.id)), abandoned: true });
    }

    // A grant_authorization (or override_rule) option carries the exact scope the
    // operator is signing off on: create + grant that one-time authorization now, so
    // the resume injects it (single-use). Admin-gated above. Any typed context becomes
    // the binding conditions on the grant.
    if (chosen && haltOptionCarriesAuthorization(chosen)) {
      try {
        const auth = insertAuthorization({ projectId: project.id, cycleId: cycle.id, scope: chosen.authorization.scope, reason: chosen.label });
        decideAuthorization(auth.id, { approved: true, conditions: message || null, by: req.user.id });
        logAudit(req.user.id, 'MOCK2_AUTHORIZATION_DECISION', 'mock2_authorization', auth.id,
          { approved: true, via: 'halt_option', option: chosen.id, scope: chosen.authorization.scope, expected_rows: chosen.authorization.expectedRows ?? null }, req.ip);
      } catch (err) {
        return res.status(500).json({ error: `Could not grant the authorization: ${err?.message || 'unknown error'}` });
      }
    }

    let result;
    try {
      result = await retryCycle({
        project, cycle,
        initiatedBy: req.user.id, actingAsAdmin: req.mock2Access.actingAsAdmin ? 1 : 0,
        message, option: optionId,
      });
    } catch (err) {
      return res.status(500).json({ error: `Could not retry the build: ${err?.message || 'unknown error'}` });
    }
    if (result.status === 'error') return res.status(409).json({ error: result.error });
    logAudit(req.user.id, 'MOCK2_CYCLE_RETRY', 'mock2_cycle', result.cycle?.id || cycle.id,
      { ...auditBase, status: result.status, context: message || null }, req.ip);
    return res.status(result.status === 'refused' ? 200 : 202).json({
      cycle: publicCycleShape(result.cycle), refused: result.status === 'refused', reason: result.error || null,
    });
  });

  // Retry the DEPLOY only (install → migrate → build → start → health) for a
  // cycle whose gates passed but whose deploy failed. No model calls, no gate
  // battery — redeploys the existing checkpoint. Cheaper than /retry.
  router.post('/projects/:id/cycles/:cycleId/retry-deploy', requireMock2Role('editor'), refuseIfArchived, async (req, res) => {
    const project = req.mock2Project;
    const cycle = getCycle(req.params.cycleId);
    if (!cycle || cycle.project_id !== project.id) return res.status(404).json({ error: 'Cycle not found' });
    let result;
    try {
      result = await retryDeploy({ project, cycle });
    } catch (err) {
      return res.status(500).json({ error: `Could not retry the deploy: ${err?.message || 'unknown error'}` });
    }
    if (result.status === 'error') return res.status(409).json({ error: result.error });
    logAudit(req.user.id, 'MOCK2_CYCLE_RETRY_DEPLOY', 'mock2_cycle', cycle.id,
      { cycle: cycle.id, acting_as_admin: req.mock2Access.actingAsAdmin }, req.ip);
    return res.status(202).json({ cycle: publicCycleShape(result.cycle) });
  });

  // "Explain this" — rewrite a blocker / authorization / deviation / rule-question
  // card in plain language via the summary lane (small/fast model). READ-ONLY: it never
  // blocks, resumes, grants, or resolves anything; it only reads the card text and logs
  // that an explanation was VIEWED. Any member (viewer+) may ask. On a model/slot
  // failure it returns { ok:false } with 200 so the client falls back to the original
  // text — the operator is never blocked on the explainer (task item 3).
  router.post('/projects/:id/explain', requireMock2Role('viewer'), async (req, res) => {
    const parsed = explainSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'text is required to explain a card' });
    const { text, kind = 'blocker', title = '', status = '', card_id = null } = parsed.data;
    let result;
    try {
      result = await explainCard({ text, title, status, kind });
    } catch (err) {
      result = { ok: false, error: err?.message || 'the explainer failed' };
    }
    // Audit log ONLY that an explanation was viewed — no state change to the cycle,
    // authorization, or deviation this explained.
    logAudit(req.user.id, 'MOCK2_EXPLAIN_VIEW', 'mock2_project', req.mock2Project.id,
      { kind, card_id, ok: !!result.ok }, req.ip);
    return res.json(result.ok
      ? { ok: true, explanation: result.explanation }
      : { ok: false, error: result.error || 'could not explain this right now' });
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
    // Join each record to its cycle's spend so the change history can show a
    // per-change token/cost counter without a second round-trip (Task 3).
    const usageByCycle = new Map();
    for (const c of listCyclesForProject(req.mock2Project.id, { limit: 1000 })) {
      usageByCycle.set(c.id, { used_tokens: c.used_tokens ?? 0, used_cost_cents: c.used_cost_cents ?? 0 });
    }
    const records = listChangeRecords(req.mock2Project.id).map((r) => {
      let gates = null;
      try { gates = r.gates_run ? JSON.parse(r.gates_run) : null; } catch { gates = null; }
      let rules = null;
      try { rules = r.rules_touched ? JSON.parse(r.rules_touched) : null; } catch { rules = null; }
      const usage = r.cycle_id != null ? usageByCycle.get(r.cycle_id) : null;
      return {
        seq: r.seq, prev_hash: r.prev_hash, hash: r.hash, summary: r.summary,
        commit_sha: r.commit_sha, gates_run: gates, rules_touched: rules,
        framework_version: r.framework_version,
        cycle_id: r.cycle_id, initiated_by: r.initiated_by,
        used_tokens: usage ? usage.used_tokens : null,
        used_cost_cents: usage ? usage.used_cost_cents : null,
        acting_as_admin: Number(r.acting_as_admin) === 1, created_at: r.created_at,
      };
    });
    res.json({ records, verification: verifyProjectChain(req.mock2Project.id) });
  });

  // ---- Build log (downloadable transcript — "what actually happened") ----

  // One cycle's full transcript: the cycle row, its change record (if it
  // checkpointed), the chat messages tied to it (the user request + framework
  // rule questions/answers + system events), and the durable event log (every AI
  // message, tool call/result, gate, checkpoint, deploy). Assembled for review /
  // download so a Builder can evaluate how a build went. Viewer-gated.
  router.get('/projects/:id/cycles/:cycleId/log', requireMock2Role('viewer'), (req, res) => {
    const cycle = getCycle(req.params.cycleId);
    if (!cycle || cycle.project_id !== req.mock2Project.id) return res.status(404).json({ error: 'Cycle not found' });
    const cid = Number(cycle.id);
    const record = listChangeRecords(req.mock2Project.id).find((r) => Number(r.cycle_id) === cid) || null;
    const messages = listMessages(req.mock2Project.id).map(publicChatMessageShape).filter((m) => Number(m.cycle_id) === cid);
    res.json({
      project: { id: req.mock2Project.id, name: req.mock2Project.name },
      cycle: publicCycleShape(cycle),
      change_record: record ? { seq: record.seq, commit_sha: record.commit_sha, summary: record.summary } : null,
      messages,
      events: listCycleEvents(cid),
      generated_at: new Date().toISOString(),
    });
  });

  // The whole project's build log — every cycle's events + every chat message +
  // every change record, in one downloadable document, for end-to-end evaluation.
  router.get('/projects/:id/log', requireMock2Role('viewer'), (req, res) => {
    const pid = req.mock2Project.id;
    res.json({
      project: { id: pid, name: req.mock2Project.name },
      cycles: listCyclesForProject(pid, { limit: 1000 }).map(publicCycleShape),
      change_records: listChangeRecords(pid).map((r) => ({ seq: r.seq, cycle_id: r.cycle_id, commit_sha: r.commit_sha, summary: r.summary, created_at: r.created_at })),
      messages: listMessages(pid).map(publicChatMessageShape),
      events: listProjectCycleEvents(pid),
      generated_at: new Date().toISOString(),
    });
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
    const audit = auditReady();
    // Open editor questions (the rule_question rows the chat renders as tappable
    // choices) — the frontend shows the choice buttons only for OPEN ids (M8).
    const openQuestions = listOpenEditorQuestions(project.id);
    res.json({
      messages: listMessages(project.id).map(publicChatMessageShape),
      job: getConceptJobStatus(project.id),
      audit_job: getAuditJobStatus(project.id),
      stage: shaped.stage,
      current_mockup_id: shaped.current_mockup_id,
      preview_url: shaped.preview_url,
      concept_ready: ready.ok,
      concept_ready_reason: ready.ok ? null : ready.reason,
      audit_ready: audit.ok,
      audit_ready_reason: audit.ok ? null : audit.reason,
      open_question_ids: openQuestions.map((q) => q.id),
      open_editor_questions: openQuestions.length,
      open_admin_items: shaped.open_admin_items,
      my_role: req.mock2Access.role,
    });
  });

  // Send a chat message (editor-gated — a chat write takes the lock and may
  // mutate the container). 202 + poll: the user message lands immediately, the
  // assistant reply + any mockup update arrive on the background turn.
  router.post('/projects/:id/chat', requireMock2Role('editor'), refuseIfArchived, async (req, res) => {
    const project = req.mock2Project;
    const maxChars = getChatMaxChars();
    const parsed = chatMessageSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: `message is required (1–${maxChars} chars)` });
    if (parsed.data.message.length > maxChars) {
      return res.status(400).json({ error: `message is too long (max ${maxChars} chars)` });
    }
    let result;
    try {
      result = await startConceptTurn({
        project, message: parsed.data.message, user: req.user,
        actingAsAdmin: req.mock2Access.actingAsAdmin ? 1 : 0,
        mode: parsed.data.mode || 'design',
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

  // ============================================================
  // M8 — Audit questions, rule confirmation, admin queue (ADR-002/003). The Build
  // press (POST /cycles above) now runs the audit first; the routes here let the
  // editor confirm rules (append to state/rules.md → sign-off #2, resumes Build)
  // and the admin work the queue (framework deviations, drift, retries, flags).
  // ============================================================

  // The project's audit questions (any member sees them; only editors answer the
  // editor-routed ones). Open editor questions also ride in the chat as
  // rule_question messages; this is the structured view + the admin's read.
  router.get('/projects/:id/questions', requireMock2Role('viewer'), (req, res) => {
    const rows = listQuestionsForProject(req.mock2Project.id).map(publicQuestionShape);
    res.json({
      questions: rows,
      open_editor: countOpenEditorQuestions(req.mock2Project.id),
      open_admin: countOpenAdminQuestions(req.mock2Project.id),
      my_role: req.mock2Access.role,
    });
  });

  // Answer an editor rule question — appends to state/rules.md (commit + change
  // record + rules_md_anchor), posts a rule_answer, and resumes Build once every
  // question is confirmed (sign-off #2). Editor-gated; free text always allowed.
  router.post('/projects/:id/questions/:qid/answer', requireMock2Role('editor'), refuseIfArchived, async (req, res) => {
    const project = req.mock2Project;
    const question = getQuestion(req.params.qid);
    if (!question || question.project_id !== project.id) return res.status(404).json({ error: 'Question not found' });
    const maxChars = getChatMaxChars();
    const parsed = answerQuestionSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: `answer is required (1–${maxChars} chars)` });
    if (parsed.data.answer.length > maxChars) {
      return res.status(400).json({ error: `answer is too long (max ${maxChars} chars)` });
    }
    let result;
    try {
      result = await answerAuditQuestion({
        project, question, answer: parsed.data.answer,
        user: req.user, actingAsAdmin: req.mock2Access.actingAsAdmin ? 1 : 0,
      });
    } catch (err) {
      return res.status(500).json({ error: `Could not record the answer: ${err?.message || 'unknown error'}` });
    }
    if (!result.ok) return res.status(409).json({ error: result.error });
    logAudit(req.user.id, 'MOCK2_RULE_ANSWER', 'mock2_audit_question', question.id,
      { resumed: result.resumed, acting_as_admin: req.mock2Access.actingAsAdmin }, req.ip);
    res.json({ question: publicQuestionShape(result.question), resumed: !!result.resumed });
  });

  // ---- Admin queue page (the queue-of-items view) ----

  // List queue items with optional filters (project, kind, status). Admin-gated —
  // the queue is the admin's object. Project names are joined in (cross-DB ref).
  router.get('/queue', requireAdmin, (req, res) => {
    const { project_id: projectId, kind, status } = req.query || {};
    if (kind && !QUEUE_KINDS.includes(String(kind))) return res.status(400).json({ error: 'unknown kind' });
    if (status && !QUEUE_STATUSES.includes(String(status))) return res.status(400).json({ error: 'unknown status' });
    const items = listQueueItems({
      projectId: projectId != null && projectId !== '' ? Number(projectId) : null,
      kind: kind ? String(kind) : null,
      status: status ? String(status) : null,
    });
    const nameCache = new Map();
    const shaped = items.map((it) => {
      let pname = null;
      if (it.project_id) {
        if (!nameCache.has(it.project_id)) nameCache.set(it.project_id, getProject(it.project_id)?.name || null);
        pname = nameCache.get(it.project_id);
      }
      return publicQueueItemShape(it, { projectName: pname });
    });
    res.json({ items: shaped, counts: queueCounts(), kinds: QUEUE_KINDS, statuses: QUEUE_STATUSES });
  });

  router.get('/queue/counts', requireAdmin, (_req, res) => {
    res.json({ counts: queueCounts() });
  });

  // Scoped one-time operational authorizations (Part 4). Project members can SEE the
  // pending requests a blocked cycle raised; an admin grants/denies. A grant is
  // injected on the next resume and consumed (single-use).
  router.get('/projects/:id/authorizations', requireMock2Role('viewer'), (req, res) => {
    const project = req.mock2Project;
    const open = listOpenAuthorizations(project.id).map(publicAuthorizationShape);
    res.json({ authorizations: open });
  });

  router.post('/projects/:id/authorizations/:authId/decision', requireMock2Role('viewer'), refuseIfArchived, (req, res) => {
    const project = req.mock2Project;
    if (!(isReqAdmin(req) || req.mock2Access?.actingAsAdmin)) {
      return res.status(403).json({ error: 'Only an administrator can grant or deny a one-time authorization.' });
    }
    const auth = getAuthorization(req.params.authId);
    if (!auth || auth.project_id !== project.id) return res.status(404).json({ error: 'Authorization not found' });
    if (auth.status !== 'open') return res.status(409).json({ error: `This authorization is already "${auth.status}".` });
    const parsed = authDecisionSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'approved (boolean) is required; conditions optional.' });
    const updated = decideAuthorization(auth.id, { approved: parsed.data.approved, conditions: parsed.data.conditions || null, by: req.user.id });
    logAudit(req.user.id, 'MOCK2_AUTHORIZATION_DECISION', 'mock2_authorization', auth.id,
      { project_id: project.id, cycle_id: auth.cycle_id, approved: parsed.data.approved, scope: auth.scope, conditions: parsed.data.conditions || null }, req.ip);
    res.json({ authorization: publicAuthorizationShape(updated) });
  });

  // Change a queue item's status (admin). Resolving/dismissing a
  // framework_deviation ALSO clears its linked audit question and resumes the
  // blocked Build (a project's answer never writes the framework — ADR-002).
  router.post('/queue/:id/status', requireAdmin, async (req, res) => {
    const item = getQueueItem(req.params.id);
    if (!item) return res.status(404).json({ error: 'Queue item not found' });
    const parsed = queueStatusSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: `status must be one of ${QUEUE_STATUSES.join(', ')}` });
    const { status, resolution, editedText, conditions } = parsed.data;
    const updated = setQueueItemStatus(item.id, status, { resolvedBy: req.user.id, resolution: resolution || null });
    let resumed = false;
    if (item.kind === 'framework_deviation' && item.ref_table === 'mock2_audit_questions' && item.ref_id
        && (status === 'resolved' || status === 'dismissed')) {
      try {
        const r = await resolveFrameworkDeviation({
          questionId: item.ref_id, user: req.user, resolution: resolution || `deviation ${status}`,
          approved: status === 'resolved', editedText: editedText || null, conditions: conditions || null,
        });
        resumed = !!r.resumed;
      } catch (err) { console.warn('[mock2] deviation resolve follow-through failed:', err?.message); }
    }
    logAudit(req.user.id, 'MOCK2_QUEUE_ITEM_STATUS', 'mock2_queue_item', item.id,
      { kind: item.kind, status, resumed, edited: !!(editedText || conditions) }, req.ip);
    res.json({ item: publicQueueItemShape(updated, { projectName: updated.project_id ? getProject(updated.project_id)?.name || null : null }), resumed });
  });

  return router;
}

// Best-effort A/AAAA lookup for a custom domain, cross-checked against
// MOCK2_PUBLIC_IP when set. Returns { ok, resolved, matched, reason } — never
// throws; a mismatch is a warning, not a hard block (the operator may be behind
// a proxy/CDN the host can't see).
async function checkARecord(domain) {
  const expected = parseHostIps(process.env.MOCK2_PUBLIC_IP);
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
