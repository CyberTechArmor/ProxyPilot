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
import { requireSudo, requireAdminOrPermission } from '../middleware/auth.js';

// Module-wide gate: full admins OR regular users holding the
// 'developer' feature permission (assigned from the Users page access
// dialog, effective in realtime). Shadowing the old requireAdmin name
// keeps every route registration below unchanged; per-project
// membership is still enforced on top by requireMock2Role.
const requireAdmin = requireAdminOrPermission('developer');

import { logAudit, getDb } from '../db.js';

// The acting user's id for attribution and NOT NULL actor columns.
//
// users.id is a UUID (TEXT PRIMARY KEY, uuidv4) — NEVER coerce it to Number:
// Number("6f1c…") is NaN, better-sqlite3 binds NaN as NULL, and a NOT NULL
// actor column (mock2_integration_verifications.operator_id,
// mock2_integration_resolutions.decided_by) then rejects the insert with an
// opaque error. That coercion was the root cause of the unrecoverable
// pending-operator-verification deadlock. Resolve robustly through four
// sources — JWT id, session row, sessions lookup by `jti`, users lookup by
// `username` — accepting any non-empty id value as-is.
const usableActorId = (v) => v != null && String(v).trim() !== '';

function mock2ActorId(req) {
  const direct = req?.user?.id ?? req?.session?.user_id;
  if (usableActorId(direct)) return direct;
  const jti = req?.user?.jti;
  if (jti) {
    try {
      const row = getDb().prepare('SELECT user_id FROM sessions WHERE id = ?').get(jti);
      if (usableActorId(row?.user_id)) return row.user_id;
    } catch { /* fall through — the username lookup below still applies */ }
  }
  const username = req?.user?.username;
  if (username) {
    try {
      const row = getDb().prepare('SELECT id FROM users WHERE username = ?').get(String(username));
      if (usableActorId(row?.id)) return row.id;
    } catch { /* fall through to null — the caller returns a clean error */ }
  }
  return null;
}

// Resolve the acting user's id or answer the request with an actionable 401 —
// the operator-facing alternative to the opaque "NOT NULL constraint failed"
// 500 that used to leave pending-verification builds with no working button.
// Returns the id, or null after responding.
function requireMock2Actor(req, res) {
  const id = mock2ActorId(req);
  if (id == null) {
    res.status(401).json({ error: 'Your session no longer carries a resolvable user id — sign out, sign back in, and retry this action.' });
    return null;
  }
  return id;
}
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
  isUserSuperadmin,
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
import { getIdleStopDays, setMock2Setting, IDLE_STOP_DAYS_KEY, getChatMaxChars, CHAT_MAX_CHARS_KEY, CHAT_MAX_CHARS_OPTIONS, getIntegrationGateMode, INTEGRATION_GATE_MODE_KEY } from './settings.js';
import { INTEGRATION_GATE_MODES } from './accept-pending-logic.js';
import { reconcileMock2Egress, readEgressLog } from './egress.js';
import { bridgeCidrForProject } from './network-logic.js';
import { reconcileMock2Firewall } from './firewall.js';
import {
  listEgressGrants, getEgressGrant, setEgressGrantStatus, setEgressGrantReachable,
  insertOperatorEgressGrant, probeEgressGrants,
} from './egress-grants.js';
import { probeHostReachable } from './network.js';
import { publicEgressGrantShape } from './egress-logic.js';
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
  exportProjectRepoBundle, pushProjectRemote,
} from './git-connectors.js';
import { GIT_PROVIDERS, GIT_AUTH_KINDS, validateGitConnectorInput } from './git-logic.js';
import {
  listFrameworkVersions, getFrameworkVersion,
  getCurrentFrameworkVersion, insertFrameworkVersion,
} from './framework.js';
import {
  validateFrameworkContent, buildRevertContent, publicFrameworkShape,
  buildFrameworkExport, parseFrameworkImport,
} from './framework-logic.js';
// ---- Component library (migration 516) ----
import {
  listComponents, getComponent, getComponentByKey, getComponentVersion,
  listComponentVersions, getCurrentComponentVersion,
  insertComponent, insertComponentVersion, updateComponentMeta, deleteComponent,
  insertSubmission, getSubmission, listSubmissions, countPendingSubmissions,
  approveSubmission, rejectSubmission,
  listProjectComponents, decideProjectComponent,
} from './components.js';
import {
  COMPONENT_STATUSES, MAX_COMPONENT_FILES,
  validateComponentKey, deriveComponentKey, normalizeTags,
  validateComponentFiles, validateChangeReason, validateComponentContract,
  parseContractJson, publicComponentShape, publicComponentVersionShape,
  publicSubmissionShape, publicProjectComponentShape,
  buildComponentExport, parseComponentImport,
} from './component-logic.js';
import { preinstallComponents } from './component-install.js';
import { startAsk, getAskJobStatus } from './ask.js';
// ---- Multi-modal chat images (migration 526) ----
import { validateChatImages, MAX_CHAT_IMAGES, isChatImageId } from './chat-image-logic.js';
import { readChatImage } from './chat-images.js';
// ---- Model routing knowledge base (migration 525) ----
import { listRoutingRules, getRoutingRule, updateRoutingRule, listRoutingOutcomes } from './routing.js';
import {
  ROUTING_TASK_KINDS, ROUTING_EFFORTS, routingMode,
  publicRoutingRuleShape, aggregateRoutingOutcomes,
} from './routing-logic.js';
// ---- M6: cycle runner + checkout lock ----
import { getCycleJobStatus, stopAllCycles, retryCycle, retryDeploy, acceptPendingVerification, readFileInContainer } from './runner.js';
import {
  getAuthorization, listOpenAuthorizations, listAuthorizationsForCycle,
  insertAuthorization, decideAuthorization, publicAuthorizationShape,
} from './authorizations.js';
import { resolveSelectedOption, haltOptionRequiresAdmin, haltOptionCarriesAuthorization } from './unblock-logic.js';
import { explainCard, explainFollowup } from './explain.js';
import {
  EXPLAIN_MAX_INPUT_CHARS, FOLLOWUP_MAX_QUESTION_CHARS, FOLLOWUP_MAX_PRIOR_CHARS,
} from './explain-logic.js';
// ---- Cost-truth: requests (umbrella), consults (second opinion), grouped log ----
import { getRequest, listRequestsForProject, closeRequest, publicRequestShape } from './requests.js';
import { listCyclesForRequest } from './cycles.js';
import { listConsultsForRequest, listConsultsForCycle, countConsultsForCycle, countConsultsForRequest, publicConsultShape } from './consults.js';
import { buildRequestLog, requestLogArtifact } from './request-log.js';
import { runConsult } from './consult.js';
import { consultAllowed } from './consult-logic.js';
import {
  getCycle, listCyclesForProject, latestCycle, setInterrupt, finishCycle, updateCycle,
  countRunningCycles,
} from './cycles.js';
import { publicCycleShape, INTERRUPTS } from './cycle-logic.js';
import {
  getLock, releaseLock, requestTakeover, getLockIdleMinutes,
} from './locks.js';
import { publicLockShape, LOCK_IDLE_MINUTES_KEY } from './lock-logic.js';
import { listChangeRecords, verifyProjectChain, insertChangeRecord, changeRecordMirror } from './change-records.js';
import { buildRestoreScript, parseRestoreOutput, restoreSummary, validateRestoreRequest } from './restore-logic.js';
import { buildCheckpointScript } from './template.js';
import { listCycleEvents, listProjectCycleEvents, recordCycleFeedback, getCycleFeedback } from './cycle-events.js';
// ---- M7: Stage 1 (Concept) — chat, mockup, design approval ----
import { listMessages } from './chats.js';
import {
  startConceptTurn, startDesignApproval, getConceptJobStatus, conceptReady,
  exportDesignTemplate, importDesignTemplate,
} from './concept.js';
import { publicChatMessageShape } from './concept-logic.js';
import { parseDesignTemplate, MAX_IMPORT_NOTES_CHARS } from './design-template-logic.js';
// ---- Integration truthfulness (AUDIT.md; B.4/B.5/B.6) ----
import {
  reportedCycleOutcome, deployPendingIsHealthy, validateConfirmation, OUTCOME_CODES,
  deriveVerificationChecklist, verificationTransition, capabilityCheckStatus,
  failureBugfixInstruction,
} from './verification-logic.js';
import {
  listActiveVerifications, recordVerification, listOpenIntegrationFindings,
  recordIntegrationResolution, listIntegrationResolutions, priorBlockedSignatures,
  projectChecklistItems,
} from './integration-state.js';
import { blockingSummary, backfillManifestEntryInContainer, repairManifestInContainer } from './integration-enforcement.js';
import { validateManifestEntry } from './integration-logic.js';
import { waiverEligible } from './resolution-logic.js';
import { execInContainer, writeFileInContainer, containerSh } from './runner.js';
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
// Multi-modal chat (migration 526): image attachments on the concept chat, the
// build composer, and the ask lane. The zod layer bounds shape/size; the deep
// validation (media-type allowlist, base64 integrity, decoded-size cap) is
// chat-image-logic.validateChatImages in each handler. ~3.4M base64 chars ≈
// the 2.5MB decoded cap.
const chatImagesSchema = z.array(z.object({
  media_type: z.string().trim().max(40),
  data: z.string().min(1).max(3_400_000),
  name: z.string().max(200).optional(),
})).max(MAX_CHAT_IMAGES).optional();

const cycleStartSchema = z.object({
  instruction: z.string().trim().min(1),
  images: chatImagesSchema,
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
  images: chatImagesSchema,
  // Conversation mode (M7): 'plan' talks through requirements without touching
  // the mockup; 'design' (default) may generate/iterate the mockup.
  mode: z.enum(['plan', 'design']).optional(),
});
// Design-template import: either an uploaded exported document OR another
// project to copy the design from (the server exports that project's template
// internally — same document either way), plus optional changes/context notes
// carried into the seeded chat and the initial build instruction.
const designTemplateImportSchema = z.object({
  doc: z.record(z.any()).optional(),
  source_project_id: z.union([z.number().int(), z.string()]).optional(),
  notes: z.string().trim().max(MAX_IMPORT_NOTES_CHARS).optional(),
}).refine((o) => o.doc || o.source_project_id != null, 'doc or source_project_id is required');
// Operator-verification confirmation (B.5): confirm a live check with an OBSERVED
// RESULT (never a bare checkbox), or an admin waiver with a recorded reason.
const verifyConfirmSchema = z.object({
  item_id: z.string().trim().min(1).max(200),
  environment: z.string().trim().min(1).max(60),
  observed_result: z.string().trim().max(4000).optional(),
  waived: z.boolean().optional(),
  waiver_reason: z.string().trim().max(2000).optional(),
  evidence_ref: z.string().trim().max(500).optional(),
  expires_at: z.string().trim().max(40).optional(),
});
// PATCH B.1 — declare an undeclared capability: an operator-confirmed manifest
// entry (re-validated in the handler by validateManifestEntry).
const manifestBackfillSchema = z.object({
  entry: z.object({
    id: z.string().trim().min(1).max(120),
    subsystem: z.string().trim().min(1).max(80),
    actions: z.array(z.object({ name: z.string().trim().min(1), operation: z.string().trim().min(1) })).min(1),
    destination: z.object({ source: z.string().trim().min(1), key: z.string().trim().min(1) }),
    transport: z.string().trim().min(1).max(60),
    provenance: z.object({ response_to_output: z.string().trim().min(1) }),
    live_verification: z.object({ required: z.boolean() }),
    egress: z.object({ classification: z.string().trim().min(1) }),
    contract_test: z.string().trim().max(400).optional(),
  }).passthrough(),
  reason: z.string().trim().max(2000).optional(),
});
// PATCH B.2 — analysis-limitation waiver (admin): the finding being waived, what
// was manually inspected, and why it is confirmed real. Handler enforces
// waiver-eligibility (never for positively-fabricated findings).
const provenanceWaiverSchema = z.object({
  finding_kind: z.string().trim().min(1).max(80),
  file: z.string().trim().max(400).optional(),
  inspected: z.string().trim().min(1).max(2000),
  reason: z.string().trim().min(1).max(2000),
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
  // Direct abandon: close the blocked cycle as abandoned WITHOUT picking one of
  // the model's proposed options first (the blocked card's Abandon button).
  // Same terminal as choosing an abandon halt option; still resumable later
  // via Continue build.
  abandon: z.boolean().optional(),
  // Enforced rule waivers (ADMIN only — checked in the handler): applied at the
  // real enforcement layer (acceptanceVerdict) of the resumed cycle and stamped
  // into its acceptance record; never a narrated claim.
  waivers: z.array(z.enum(['reproduce_first'])).max(1).optional(),
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
  // Follow-up: an operator question about an already-explained card, plus the
  // plain-language explanation they already read (context for the answer). When
  // `question` is present the route answers it instead of re-explaining the card.
  question: z.string().trim().min(1).max(FOLLOWUP_MAX_QUESTION_CHARS).optional(),
  prior: z.string().trim().max(FOLLOWUP_MAX_PRIOR_CHARS).optional(),
});
// ---- Component library Zod schemas ----
const componentFileSchema = z.object({
  path: z.string().min(1).max(400),
  content: z.string().max(250000),
});
const componentCreateSchema = z.object({
  key: z.string().trim().max(64).optional(),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).optional(),
  category: z.string().trim().max(80).optional(),
  tags: z.array(z.string()).optional(),
  status: z.enum(COMPONENT_STATUSES).optional(),
  usage_md: z.string().max(20000).optional(),
  contract: z.record(z.any()).nullish(),
  files: z.array(componentFileSchema).min(1).max(MAX_COMPONENT_FILES),
  change_reason: z.string().trim().max(2000).optional(),
});
const componentMetaSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(2000).optional(),
  category: z.string().trim().max(80).optional(),
  tags: z.array(z.string()).optional(),
  status: z.enum(COMPONENT_STATUSES).optional(),
}).refine((o) => Object.keys(o).length > 0, 'no fields to update');
const componentVersionSchema = z.object({
  files: z.array(componentFileSchema).min(1).max(MAX_COMPONENT_FILES),
  usage_md: z.string().max(20000).optional(),
  contract: z.record(z.any()).nullish(),
  change_reason: z.string().trim().min(1).max(2000),
});
// The ask lane's input — a question/task for the read-and-run assistant.
const askSchema = z.object({ question: z.string().trim().min(1).max(4000), images: chatImagesSchema });
// A routing-rule edit — every field optional; null/'' clears back to the default.
const routingRuleSchema = z.object({
  model: z.string().trim().max(120).nullish(),
  escalate_model: z.string().trim().max(120).nullish(),
  effort: z.enum(ROUTING_EFFORTS).nullable().optional(),
  enabled: z.boolean().optional(),
  notes: z.string().trim().max(2000).nullish(),
}).refine((o) => Object.keys(o).length > 0, 'no fields to update');
// A project's component selection: an editor picks a library component for the
// project (or declines a suggestion) by key.
const projectComponentSelectSchema = z.object({
  key: z.string().trim().min(2).max(64),
  decision: z.enum(['confirmed', 'declined']).default('confirmed'),
  options: z.record(z.any()).optional(),
});
const componentImportSchema = z.object({
  doc: z.record(z.any()),
  change_reason: z.string().trim().max(2000).optional(),
});
// A submission proposes files either INLINE or by container PATHS (read from the
// running project container server-side, so "promote what I just built" is one
// click, not copy-paste).
const submissionCreateSchema = z.object({
  component_id: z.union([z.number().int(), z.string()]).optional(),
  proposed_key: z.string().trim().max(64).optional(),
  proposed_name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).optional(),
  category: z.string().trim().max(80).optional(),
  tags: z.array(z.string()).optional(),
  usage_md: z.string().max(20000).optional(),
  notes: z.string().trim().max(4000).optional(),
  files: z.array(componentFileSchema).max(MAX_COMPONENT_FILES).optional(),
  paths: z.array(z.string().min(1).max(400)).max(MAX_COMPONENT_FILES).optional(),
}).refine((o) => (o.files && o.files.length) || (o.paths && o.paths.length), 'files or paths required');
const submissionReviewSchema = z.object({
  approved: z.boolean(),
  reason: z.string().trim().max(2000).optional(),
  overrides: z.object({
    key: z.string().trim().max(64).optional(),
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(2000).optional(),
    category: z.string().trim().max(80).optional(),
    tags: z.array(z.string()).optional(),
  }).optional(),
});

const frameworkContentSchema = z.object({
  constitution_md: z.string().min(1),
  skills_json: z.string().min(1),
  gates_json: z.string().min(1),
  design_system_md: z.string().min(1),
  project_template_ref: z.string().trim().min(1).max(500),
  changelog: z.string().trim().max(2000).optional(),
});
// Import a framework document (the buildFrameworkExport shape) as a NEW version;
// the content bar is re-enforced by parseFrameworkImport in the handler.
const frameworkImportSchema = z.object({
  doc: z.record(z.any()),
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
    const userId = String(req.params.userId);  // users.id is a UUID, never coerce to Number
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

  // Integration-gate mode — the block/approve loop relief valve. Admin-gated
  // read/write of mock2_settings.integration_gate_mode. 'enforce' (default)
  // blocks a build that ships a simulated/undeclared integration; 'pending'
  // downgrades that block to pending-operator-verification (the build deploys and
  // the live checks are recorded); 'monitor' records the findings but never
  // blocks. See accept-pending-logic.js for the exact semantics.
  router.get('/settings/integration-gate-mode', requireAdmin, (_req, res) => {
    res.json({ mode: getIntegrationGateMode(), options: INTEGRATION_GATE_MODES });
  });
  router.post('/settings/integration-gate-mode', requireAdmin, (req, res) => {
    const parsed = z.object({
      mode: z.string().refine((m) => INTEGRATION_GATE_MODES.includes(m), 'unsupported mode'),
    }).safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: `mode must be one of ${INTEGRATION_GATE_MODES.join(', ')}` });
    }
    setMock2Setting(INTEGRATION_GATE_MODE_KEY, parsed.data.mode, req.user.id);
    logAudit(req.user.id, 'MOCK2_SETTING_INTEGRATION_GATE_MODE', 'mock2_setting', 0, { mode: parsed.data.mode }, req.ip);
    res.json({ mode: getIntegrationGateMode(), options: INTEGRATION_GATE_MODES });
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

  // Declared egress grants for a project — the internal hosts it declared in
  // mock2.yaml `egress:`, each with its admin-decision status and the host
  // reachability probe. Any member can see it (it explains why an outbound call
  // is blocked or allowed); only admins decide (through the queue). Newest first.
  router.get('/projects/:id/egress', requireMock2Role('viewer'), (req, res) => {
    const grants = listEgressGrants(req.mock2Project.id).map(publicEgressGrantShape);
    res.json({ grants });
  });

  // Re-probe host reachability for a single grant (admin) — the "can the HOST
  // even route to this destination?" check (acceptance #5), on demand so an admin
  // can re-test after fixing host routing without re-approving. Records the result
  // on the grant and returns it.
  router.post('/projects/:id/egress/:grantId/probe', requireAdmin, async (req, res) => {
    const grant = getEgressGrant(req.params.grantId);
    if (!grant || grant.project_id !== req.mock2Project.id) return res.status(404).json({ error: 'Egress grant not found' });
    const probe = await probeHostReachable(grant.host, grant.port).catch((e) => ({ reachable: 'unreachable', error: e?.message }));
    const updated = setEgressGrantReachable(grant.id, probe.reachable);
    logAudit(req.user.id, 'MOCK2_EGRESS_GRANT_PROBE', 'mock2_egress_grant', grant.id,
      { host: grant.host, port: grant.port, reachable: probe.reachable }, req.ip);
    res.json({ grant: publicEgressGrantShape(updated), reachable: probe.reachable });
  });

  // Operator-initiated egress grant (admin) — open the build fence to a LAN or
  // external host:port DIRECTLY, without waiting for the app to declare it in
  // mock2.yaml. The grant is created already-approved (origin 'operator'); the
  // fence is reconciled immediately so the container can reach it, and host
  // reachability is probed so "policy blocked" vs "host can't route" is visible.
  // This is the lever for an app whose whole job is an external integration: on a
  // ProxyPilot install that CAN route to the endpoint, the build then verifies the
  // real handshake in-fence and completes as succeeded.
  router.post('/projects/:id/egress', requireAdmin, refuseIfArchived, async (req, res) => {
    const projectId = req.mock2Project.id;
    const { host, port, protocol = 'tcp', reason = '' } = req.body || {};
    const created = insertOperatorEgressGrant({ projectId, host, port, protocol, reason, decidedBy: req.user.id });
    if (!created.ok) return res.status(400).json({ error: created.error });
    try {
      await reconcileMock2Firewall();
    } catch (e) {
      return res.status(500).json({ error: `Grant saved but the fence reconcile failed: ${e?.message || 'unknown error'}` });
    }
    try { await probeEgressGrants([created.grant.id]); } catch { /* best effort — probe is advisory */ }
    logAudit(req.user.id, 'MOCK2_EGRESS_GRANT_OPERATOR_ADD', 'mock2_egress_grant', created.grant.id,
      { project_id: projectId, host: created.grant.host, port: created.grant.port, protocol: created.grant.protocol, reason }, req.ip);
    return res.status(201).json({ grant: publicEgressGrantShape(getEgressGrant(created.grant.id)) });
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

  // Export as zip = git archive of the bare repo's working tree at HEAD (ADR-006).
  // Any member may export. Streams application/zip. This is the project FILES, no
  // git history.
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

  // Download the git repository = a `git bundle` of the bare repo with FULL
  // history (every ref + commit — the checkpoints and the hash-chained change
  // records). `git clone <file>.bundle` reconstructs a working repo. Any member
  // may export. Streams application/octet-stream.
  router.get('/projects/:id/repo.bundle', requireMock2Role('viewer'), async (req, res) => {
    const project = req.mock2Project;
    if (!project.repo_path) return res.status(409).json({ error: 'Project has no repository to export' });
    const out = await exportProjectRepoBundle(project.repo_path);
    if (!out.ok) return res.status(500).json({ error: `Export failed: ${out.error}` });
    logAudit(req.user.id, 'MOCK2_PROJECT_EXPORT_BUNDLE', 'mock2_project', project.id, { bytes: out.buffer.length }, req.ip);
    const fname = `${project.slug || `project-${project.id}`}.bundle`;
    res.setHeader('Content-Type', 'application/octet-stream');
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

  // Export a framework version as a portable JSON document ("download the
  // harness") — the five immutable content fields + provenance, self-contained so
  // it imports into any install as a NEW version. Admin-gated; streams a download.
  router.get('/framework/versions/:id/export', requireAdmin, (req, res) => {
    const row = getFrameworkVersion(req.params.id);
    if (!row) return res.status(404).json({ error: 'Framework version not found' });
    const doc = buildFrameworkExport(row);
    logAudit(req.user.id, 'MOCK2_FRAMEWORK_EXPORT', 'mock2_framework_version', row.id, { version: row.version }, req.ip);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="proxypilot-framework-v${row.version}.json"`);
    res.json(doc);
  });

  // Import a framework document as a NEW version (append-only, monotonic —
  // exactly like a publish; the imported bundle is held to the same content bar).
  // source='import' records honest provenance. Admin-gated.
  router.post('/framework/import', requireAdmin, (req, res) => {
    const parsed = frameworkImportSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'doc (the exported framework JSON) is required' });
    const check = parseFrameworkImport(parsed.data.doc);
    if (!check.ok) return res.status(400).json({ error: check.error });
    const d = check.data;
    const changelog = (parsed.data.changelog || '').trim() || d.changelog;
    const row = insertFrameworkVersion({
      constitution_md: d.constitution_md,
      skills_json: d.skills_json,
      gates_json: d.gates_json,
      design_system_md: d.design_system_md,
      project_template_ref: d.project_template_ref,
      changelog,
      source: 'import',
      createdBy: req.user.id,
    });
    logAudit(req.user.id, 'MOCK2_FRAMEWORK_IMPORT', 'mock2_framework_version', row.id,
      { version: row.version, exported_from_version: d.exported_from_version }, req.ip);
    res.status(201).json({ version: publicFrameworkShape(row, { includeContent: true }) });
  });

  // ============================================================
  // Component library (migration 516). Reusable, versioned building blocks the
  // build runner is offered so recurring needs (an LDAPS auth module, …) reuse
  // ONE audited implementation. Reads are open to any authenticated user (a
  // project editor browses what exists before proposing); writes are admin;
  // delete additionally requires sudo. Content is immutable per version — every
  // change is a NEW version with a REQUIRED annotated change_reason.
  // ============================================================

  router.get('/components', (req, res) => {
    const status = req.query.status ? String(req.query.status) : null;
    if (status && !COMPONENT_STATUSES.includes(status)) return res.status(400).json({ error: 'unknown status' });
    const rows = listComponents({ status }).map((c) => publicComponentShape(c, { currentVersion: getCurrentComponentVersion(c) }));
    res.json({ components: rows, pending_submissions: isReqAdmin(req) ? countPendingSubmissions() : undefined });
  });

  router.get('/components/:id', (req, res) => {
    const row = getComponent(req.params.id);
    if (!row) return res.status(404).json({ error: 'Component not found' });
    res.json({ component: publicComponentShape(row, { currentVersion: getCurrentComponentVersion(row), includeFiles: true }) });
  });

  router.post('/components', requireAdmin, (req, res) => {
    const parsed = componentCreateSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'invalid component' });
    const d = parsed.data;
    const keyCheck = validateComponentKey(d.key || deriveComponentKey(d.name));
    if (!keyCheck.ok) return res.status(400).json({ error: keyCheck.error });
    if (getComponentByKey(keyCheck.key)) return res.status(409).json({ error: `A component with key "${keyCheck.key}" already exists — publish a new version of it instead` });
    const filesCheck = validateComponentFiles(d.files);
    if (!filesCheck.ok) return res.status(400).json({ error: filesCheck.error });
    const contractCheck = validateComponentContract(d.contract ?? null);
    if (!contractCheck.ok) return res.status(400).json({ error: contractCheck.error });
    const { component, version } = insertComponent({
      key: keyCheck.key, name: d.name, description: d.description || null,
      category: d.category || null, tags: normalizeTags(d.tags),
      status: d.status || 'published', files: filesCheck.files,
      usage_md: d.usage_md || null, contract: contractCheck.contract,
      change_reason: (d.change_reason || '').trim() || 'Initial version',
      createdBy: req.user.id,
    });
    logAudit(req.user.id, 'MOCK2_COMPONENT_CREATE', 'mock2_component', component.id, { key: component.key, files: filesCheck.files.length }, req.ip);
    res.status(201).json({ component: publicComponentShape(component, { currentVersion: version, includeFiles: true }) });
  });

  router.patch('/components/:id', requireAdmin, (req, res) => {
    const row = getComponent(req.params.id);
    if (!row) return res.status(404).json({ error: 'Component not found' });
    const parsed = componentMetaSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'invalid update' });
    const d = parsed.data;
    const updated = updateComponentMeta(row.id, {
      ...(d.name !== undefined ? { name: d.name } : {}),
      ...(d.description !== undefined ? { description: d.description || null } : {}),
      ...(d.category !== undefined ? { category: d.category || null } : {}),
      ...(d.tags !== undefined ? { tags: normalizeTags(d.tags) } : {}),
      ...(d.status !== undefined ? { status: d.status } : {}),
    });
    logAudit(req.user.id, 'MOCK2_COMPONENT_UPDATE', 'mock2_component', row.id, { key: row.key, fields: Object.keys(d) }, req.ip);
    res.json({ component: publicComponentShape(updated, { currentVersion: getCurrentComponentVersion(updated) }) });
  });

  router.delete('/components/:id', requireAdmin, requireSudo, (req, res) => {
    const row = getComponent(req.params.id);
    if (!row) return res.status(404).json({ error: 'Component not found' });
    deleteComponent(row.id);
    logAudit(req.user.id, 'MOCK2_COMPONENT_DELETE', 'mock2_component', row.id, { key: row.key }, req.ip);
    res.json({ ok: true });
  });

  // Version history — the annotated record of every swap and why.
  router.get('/components/:id/versions', (req, res) => {
    const row = getComponent(req.params.id);
    if (!row) return res.status(404).json({ error: 'Component not found' });
    res.json({ versions: listComponentVersions(row.id).map((v) => publicComponentVersionShape(v)) });
  });

  router.get('/components/:id/versions/:vid', (req, res) => {
    const row = getComponent(req.params.id);
    if (!row) return res.status(404).json({ error: 'Component not found' });
    const v = getComponentVersion(req.params.vid);
    if (!v || v.component_id !== row.id) return res.status(404).json({ error: 'Version not found' });
    res.json({ version: publicComponentVersionShape(v, { includeFiles: true }) });
  });

  // Publish a new version. change_reason is REQUIRED — the library's history
  // must say why each version exists.
  router.post('/components/:id/versions', requireAdmin, (req, res) => {
    const row = getComponent(req.params.id);
    if (!row) return res.status(404).json({ error: 'Component not found' });
    const parsed = componentVersionSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'invalid version' });
    const reasonCheck = validateChangeReason(parsed.data.change_reason);
    if (!reasonCheck.ok) return res.status(400).json({ error: reasonCheck.error });
    const filesCheck = validateComponentFiles(parsed.data.files);
    if (!filesCheck.ok) return res.status(400).json({ error: filesCheck.error });
    const contractCheck = validateComponentContract(parsed.data.contract ?? null);
    if (!contractCheck.ok) return res.status(400).json({ error: contractCheck.error });
    const version = insertComponentVersion(row.id, {
      files: filesCheck.files, usage_md: parsed.data.usage_md || null,
      contract: contractCheck.contract,
      change_reason: reasonCheck.reason, createdBy: req.user.id,
    });
    logAudit(req.user.id, 'MOCK2_COMPONENT_VERSION_PUBLISH', 'mock2_component', row.id, { key: row.key, version: version.version }, req.ip);
    res.status(201).json({ version: publicComponentVersionShape(version, { includeFiles: true }) });
  });

  // Revert = a NEW version carrying the old content (same idiom as the
  // framework registry) — the annotated reason records the rollback.
  router.post('/components/:id/versions/:vid/revert', requireAdmin, (req, res) => {
    const row = getComponent(req.params.id);
    if (!row) return res.status(404).json({ error: 'Component not found' });
    const source = getComponentVersion(req.params.vid);
    if (!source || source.component_id !== row.id) return res.status(404).json({ error: 'Version not found' });
    const reason = String(req.body?.change_reason || '').trim() || `Revert to v${source.version}`;
    const version = insertComponentVersion(row.id, {
      files: JSON.parse(source.files_json), usage_md: source.usage_md,
      contract: parseContractJson(source.contract_json),
      change_reason: reason, revertedFromVersion: source.version,
      source: 'revert', createdBy: req.user.id,
    });
    logAudit(req.user.id, 'MOCK2_COMPONENT_VERSION_REVERT', 'mock2_component', row.id, { key: row.key, version: version.version, reverted_from: source.version }, req.ip);
    res.status(201).json({ version: publicComponentVersionShape(version, { includeFiles: true }) });
  });

  // Export the current version as a portable JSON document (download).
  router.get('/components/:id/export', (req, res) => {
    const row = getComponent(req.params.id);
    if (!row) return res.status(404).json({ error: 'Component not found' });
    const current = getCurrentComponentVersion(row);
    if (!current) return res.status(409).json({ error: 'Component has no versions' });
    const doc = buildComponentExport(row, current);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${row.key}-v${current.version}.component.json"`);
    res.json(doc);
  });

  // Import a component document (admin). A NEW key creates the component; a
  // key that already exists appends a NEW VERSION of it (annotated as an import).
  router.post('/components/import', requireAdmin, (req, res) => {
    const parsed = componentImportSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'doc (the exported component JSON) is required' });
    const check = parseComponentImport(parsed.data.doc);
    if (!check.ok) return res.status(400).json({ error: check.error });
    const d = check.data;
    const reason = (parsed.data.change_reason || '').trim() || `Imported component document (${d.key})`;
    const existing = getComponentByKey(d.key);
    if (existing) {
      const version = insertComponentVersion(existing.id, {
        files: d.files, usage_md: d.usage_md, contract: d.contract, change_reason: reason,
        source: 'import', createdBy: req.user.id,
      });
      logAudit(req.user.id, 'MOCK2_COMPONENT_IMPORT', 'mock2_component', existing.id, { key: d.key, as: 'new_version', version: version.version }, req.ip);
      return res.status(201).json({ component: publicComponentShape(getComponent(existing.id), { currentVersion: version }), created: false });
    }
    const { component, version } = insertComponent({
      key: d.key, name: d.name, description: d.description, category: d.category,
      tags: d.tags, files: d.files, usage_md: d.usage_md, contract: d.contract,
      change_reason: reason, source: 'import', createdBy: req.user.id,
    });
    logAudit(req.user.id, 'MOCK2_COMPONENT_IMPORT', 'mock2_component', component.id, { key: d.key, as: 'new_component', version: version.version }, req.ip);
    res.status(201).json({ component: publicComponentShape(component, { currentVersion: version }), created: true });
  });

  // ---- per-project component selection (migration 524) ----
  //
  // WHICH components a project uses: suggested at define time, confirmed via
  // the chat questions, or picked here directly. The list is the visible record
  // of what the build was given; POST lets an editor specify a component to use
  // (or decline one) without waiting for a suggestion; /install runs the
  // deterministic zero-token pre-install immediately instead of at next build.

  router.get('/projects/:id/components', requireMock2Role('viewer'), (req, res) => {
    const rows = listProjectComponents(req.mock2Project.id).map((r) => publicProjectComponentShape(r));
    res.json({ components: rows });
  });

  router.post('/projects/:id/components', requireMock2Role('editor'), refuseIfArchived, (req, res) => {
    const project = req.mock2Project;
    const parsed = projectComponentSelectSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'invalid selection' });
    const d = parsed.data;
    const component = getComponentByKey(d.key);
    if (!component) return res.status(404).json({ error: `No component with key "${d.key}"` });
    if (d.decision === 'confirmed' && component.status !== 'published') {
      return res.status(409).json({ error: `Component "${d.key}" is not published (${component.status}) — only published components can be used` });
    }
    const row = decideProjectComponent({
      projectId: project.id, componentId: component.id,
      versionId: component.current_version_id, status: d.decision,
      origin: 'operator', options: d.options || null, decidedBy: req.user.id,
    });
    logAudit(req.user.id, 'MOCK2_PROJECT_COMPONENT_SELECT', 'mock2_project_component', row.id,
      { project_id: project.id, key: component.key, decision: d.decision }, req.ip);
    const joined = listProjectComponents(project.id).find((r) => r.id === row.id);
    res.status(201).json({ component: publicProjectComponentShape(joined || row) });
  });

  // Run the deterministic pre-install NOW (it otherwise runs automatically when
  // the next build starts). Zero model tokens; requires the container online.
  router.post('/projects/:id/components/install', requireMock2Role('editor'), refuseIfArchived, async (req, res) => {
    const project = req.mock2Project;
    if (project.lifecycle !== 'active') {
      return res.status(409).json({ error: `The project must be online to install components (it is "${project.lifecycle}").` });
    }
    try {
      const result = await preinstallComponents({ project, initiatedBy: req.user.id, actingAsAdmin: req.mock2Access?.actingAsAdmin ? 1 : 0 });
      const rows = listProjectComponents(project.id).map((r) => publicProjectComponentShape(r));
      res.status(result.ok ? 200 : 502).json({
        ok: result.ok,
        installed: result.installed.map((i) => ({ key: i.component.key, version: i.version.version, ...i.counts })),
        failed: result.failed.map((f) => ({ key: f.row.key, error: f.error })),
        components: rows,
      });
    } catch (err) {
      res.status(500).json({ error: err?.message || 'install failed' });
    }
  });

  // ---- submissions: the in-platform promotion path ----

  // Propose code from a project as a component (project editor). Files come
  // inline OR as container paths (read server-side from the RUNNING project
  // container, so "promote what the last build wrote" needs no copy-paste).
  router.post('/projects/:id/component-submissions', requireMock2Role('editor'), refuseIfArchived, async (req, res) => {
    const project = req.mock2Project;
    const parsed = submissionCreateSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'invalid submission' });
    const d = parsed.data;

    let targetComponent = null;
    if (d.component_id != null && d.component_id !== '') {
      targetComponent = getComponent(d.component_id);
      if (!targetComponent) return res.status(400).json({ error: 'No such component to propose a version for' });
    }
    let proposedKey = null;
    if (!targetComponent) {
      const keyCheck = validateComponentKey(d.proposed_key || deriveComponentKey(d.proposed_name));
      if (!keyCheck.ok) return res.status(400).json({ error: keyCheck.error });
      proposedKey = keyCheck.key;
    }

    // Resolve the files: inline wins; otherwise read each path from the container.
    let candidateFiles = d.files || [];
    if (!candidateFiles.length) {
      if (project.lifecycle !== 'active') {
        return res.status(409).json({ error: 'Reading files from the project requires its container to be running — wake the project or paste the files inline' });
      }
      candidateFiles = [];
      for (const p of d.paths || []) {
        const r = await readFileInContainer(project.container_name, p);
        if (!r.ok) return res.status(400).json({ error: `Could not read "${p}" from the project: ${r.error}` });
        candidateFiles.push({ path: p, content: r.content });
      }
    }
    const filesCheck = validateComponentFiles(candidateFiles);
    if (!filesCheck.ok) return res.status(400).json({ error: filesCheck.error });

    const submission = insertSubmission({
      projectId: project.id, componentId: targetComponent?.id || null,
      proposedKey, proposedName: d.proposed_name,
      description: d.description || null, category: d.category || null,
      tags: normalizeTags(d.tags), files: filesCheck.files,
      usage_md: d.usage_md || null, notes: d.notes || null, createdBy: req.user.id,
    });
    logAudit(req.user.id, 'MOCK2_COMPONENT_SUBMIT', 'mock2_component_submission', submission.id,
      { project_id: project.id, target_component_id: targetComponent?.id || null, files: filesCheck.files.length }, req.ip);
    try {
      postNotification({
        level: 'info',
        title: `Component submission: ${d.proposed_name}`,
        body: `${project.name} proposed ${targetComponent ? `a new version of "${targetComponent.name}"` : `a new component "${d.proposed_name}"`} for the library. Review it under Projects → Components.`,
        source: 'mock2-component-submission',
        source_id: submission.id,
        dedupe_key: `mock2-component-submission:${submission.id}`,
      });
    } catch (err) { console.error('[mock2] postNotification failed:', err?.message); }
    res.status(201).json({ submission: publicSubmissionShape(submission) });
  });

  // A project's own submissions (member view — track the review outcome).
  router.get('/projects/:id/component-submissions', requireMock2Role('viewer'), (req, res) => {
    res.json({ submissions: listSubmissions({ projectId: req.mock2Project.id }).map((s) => publicSubmissionShape(s)) });
  });

  // The review inbox (admin).
  router.get('/component-submissions', requireAdmin, (req, res) => {
    const status = req.query.status ? String(req.query.status) : null;
    if (status && !['pending', 'approved', 'rejected', 'withdrawn'].includes(status)) return res.status(400).json({ error: 'unknown status' });
    res.json({ submissions: listSubmissions({ status }).map((s) => publicSubmissionShape(s)) });
  });

  router.get('/component-submissions/:id', requireAdmin, (req, res) => {
    const row = getSubmission(req.params.id);
    if (!row) return res.status(404).json({ error: 'Submission not found' });
    res.json({ submission: publicSubmissionShape(row, { includeFiles: true }) });
  });

  // Approve into the library (new component, or new version of the targeted
  // one) or reject with a reason — the submitter sees the outcome + reason.
  router.post('/component-submissions/:id/review', requireAdmin, (req, res) => {
    const row = getSubmission(req.params.id);
    if (!row) return res.status(404).json({ error: 'Submission not found' });
    if (row.status !== 'pending') return res.status(409).json({ error: `Submission is already ${row.status}` });
    const parsed = submissionReviewSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'invalid review' });
    const d = parsed.data;

    if (!d.approved) {
      const reason = (d.reason || '').trim();
      if (!reason) return res.status(400).json({ error: 'A reason is required to reject — the submitter sees it' });
      const updated = rejectSubmission(row.id, { reviewerId: req.user.id, reason });
      logAudit(req.user.id, 'MOCK2_COMPONENT_SUBMISSION_REJECT', 'mock2_component_submission', row.id, { reason }, req.ip);
      return res.json({ submission: publicSubmissionShape(updated) });
    }

    const overrides = { ...(d.overrides || {}) };
    if (overrides.key !== undefined) {
      const keyCheck = validateComponentKey(overrides.key);
      if (!keyCheck.ok) return res.status(400).json({ error: keyCheck.error });
      overrides.key = keyCheck.key;
    }
    if (overrides.tags !== undefined) overrides.tags = normalizeTags(overrides.tags);
    // Creating a NEW component whose key already exists is a reviewer mistake —
    // point them at targeting the existing component instead.
    if (!row.component_id) {
      const key = overrides.key || row.proposed_key;
      if (key && getComponentByKey(key)) {
        return res.status(409).json({ error: `Key "${key}" already exists — re-review with an overridden key, or have the submitter target that component with a new-version submission` });
      }
    }
    let result;
    try {
      result = approveSubmission(row, { reviewerId: req.user.id, reason: (d.reason || '').trim() || null, overrides });
    } catch (err) {
      return res.status(409).json({ error: `Could not approve: ${err?.message || 'unknown error'}` });
    }
    logAudit(req.user.id, 'MOCK2_COMPONENT_SUBMISSION_APPROVE', 'mock2_component_submission', row.id,
      { component_id: result.component.id, key: result.component.key, version: result.version.version }, req.ip);
    res.json({
      submission: publicSubmissionShape(result.submission),
      component: publicComponentShape(result.component, { currentVersion: result.version }),
    });
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
      const imgCheck = validateChatImages(parsed.data.images);
      if (!imgCheck.ok) return res.status(400).json({ error: imgCheck.error });
      result = await startBuild({
        project, instruction: parsed.data.instruction,
        user: req.user, actingAsAdmin: req.mock2Access.actingAsAdmin ? 1 : 0,
        images: imgCheck.images,
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
    const waivers = parsedResume.data.waivers || [];

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
    // A rule waiver (e.g. reproduce_first) is an admin act — it is APPLIED at the
    // resumed cycle's enforcement layer, so granting it is equivalent in weight
    // to an override_rule halt option.
    if (waivers.length && !actingAdmin) {
      return res.status(403).json({ error: 'Waiving a finish-gate rule requires an administrator.' });
    }

    // Abandon closes the cycle as abandoned — no resume (task Part 3). Reached
    // by choosing an abandon halt option OR directly via { abandon: true } (the
    // blocked card's Abandon button — no option pick required).
    const wantAbandon = parsedResume.data.abandon === true;
    if (wantAbandon || (chosen && chosen.kind === 'abandon')) {
      finishCycle(cycle.id, { status: 'abandoned', error: `abandoned by operator${message ? `: ${message}` : ''}` });
      // Cost-truth: abandoning closes the whole umbrella request.
      try { if (cycle.request_id) closeRequest(cycle.request_id, 'abandoned'); } catch { /* best effort */ }
      for (const key of [`mock2-blocked:${cycle.id}`, `mock2-retries:${cycle.id}`, `mock2-requeue:${cycle.id}`]) {
        try { resolveQueueItem(key, { resolution: 'abandoned by operator', resolvedBy: req.user.id }); } catch { /* best effort */ }
      }
      logAudit(req.user.id, 'MOCK2_CYCLE_ABANDON', 'mock2_cycle', cycle.id, { ...auditBase, context: message || null, direct: wantAbandon }, req.ip);
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
        message, option: optionId, waivers,
      });
    } catch (err) {
      return res.status(500).json({ error: `Could not retry the build: ${err?.message || 'unknown error'}` });
    }
    if (result.status === 'error') return res.status(409).json({ error: result.error });
    logAudit(req.user.id, 'MOCK2_CYCLE_RETRY', 'mock2_cycle', result.cycle?.id || cycle.id,
      { ...auditBase, status: result.status, context: message || null, waivers }, req.ip);
    return res.status(result.status === 'refused' ? 200 : 202).json({
      cycle: publicCycleShape(result.cycle), refused: result.status === 'refused', reason: result.error || null,
    });
  });

  // "Get guidance" — the operator-triggered escalation consult (a Fable 5 SECOND
  // OPINION) on a blocked cycle. Advisory-only: it never resumes, grants, or switches the
  // build lane; it returns a diagnosis + ranked paths + suggested resume text attached to
  // the halt card. Bounded (~$0.50) and logged as its own request segment. The operator
  // button bypasses the auto caps (they're explicitly asking); its cost is on them.
  router.post('/projects/:id/cycles/:cycleId/consult', requireMock2Role('editor'), refuseIfArchived, async (req, res) => {
    const project = req.mock2Project;
    const cycle = getCycle(req.params.cycleId);
    if (!cycle || cycle.project_id !== project.id) return res.status(404).json({ error: 'Cycle not found' });
    if (!cycle.halt_reason && cycle.status !== 'awaiting_admin' && cycle.status !== 'failed') {
      return res.status(409).json({ error: 'A second opinion is available on a blocked or failed build.' });
    }
    const trigger = 'operator';
    const gate = consultAllowed({
      trigger,
      perHaltCount: countConsultsForCycle(cycle.id),
      perRequestCount: countConsultsForRequest(cycle.request_id),
    });
    if (!gate.allowed) return res.status(409).json({ error: gate.reason });

    // Compile the tool-free digest from what the cycle already carries (no container
    // reads — bounded by construction). Gate output comes from the stored gate reports.
    let gateOutput = '';
    try {
      const gates = cycle.gates_json ? JSON.parse(cycle.gates_json) : [];
      gateOutput = (Array.isArray(gates) ? gates : []).map((g) => `${g.name}: ${g.status}${g.report ? ` — ${g.report}` : ''}`).join('\n');
    } catch { /* ignore */ }
    const digestParts = {
      task: cycle.instruction || '',
      haltReason: cycle.error || cycle.halt_reason || 'blocked',
      lastErrors: cycle.error || '',
      gateOutput,
    };

    let result;
    try {
      result = await runConsult({ projectId: project.id, requestId: cycle.request_id, cycleId: cycle.id, trigger, digestParts, requestedBy: req.user.id });
    } catch (err) {
      result = { ok: false, error: err?.message || 'the consult failed' };
    }
    // Read-only w.r.t. the build; log that a second opinion was requested.
    logAudit(req.user.id, 'MOCK2_CONSULT', 'mock2_cycle', cycle.id,
      { trigger, request_id: cycle.request_id, ok: !!result.ok, cost_cents: result.consult?.cost_cents ?? null }, req.ip);
    return res.json(result.ok ? { ok: true, consult: result.consult } : { ok: false, error: result.error });
  });

  // List the consults (second opinions) attached to a cycle — the halt card reads these.
  router.get('/projects/:id/cycles/:cycleId/consults', requireMock2Role('viewer'), (req, res) => {
    const cycle = getCycle(req.params.cycleId);
    if (!cycle || cycle.project_id !== req.mock2Project.id) return res.status(404).json({ error: 'Cycle not found' });
    res.json({ consults: listConsultsForCycle(cycle.id).map(publicConsultShape) });
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

  // Accept a BLOCKED build as pending live verification (admin) — the completion
  // valve. When a cycle is blocked because the sealed fence cannot verify a live
  // external integration, an admin who ATTESTS the code is real and will be
  // verified live converts it to pending-operator-verification and deploys it,
  // WITHOUT another model round and NEVER as "succeeded". The outstanding live
  // check is recorded and the attestation is audit-logged, so the honesty
  // guarantee moves from "the fence proves it" to "a named human verifies it live".
  router.post('/projects/:id/cycles/:cycleId/accept-pending', requireAdmin, refuseIfArchived, async (req, res) => {
    const project = req.mock2Project;
    const cycle = getCycle(req.params.cycleId);
    if (!cycle || cycle.project_id !== project.id) return res.status(404).json({ error: 'Cycle not found' });
    const attestation = String(req.body?.attestation || '').trim();
    const acceptActorId = requireMock2Actor(req, res);
    if (acceptActorId == null) return;
    let result;
    try {
      result = await acceptPendingVerification({ project, cycle, initiatedBy: acceptActorId, attestation });
    } catch (err) {
      return res.status(500).json({ error: `Could not accept the build as pending verification: ${err?.message || 'unknown error'}` });
    }
    if (result.status === 'error') return res.status(409).json({ error: result.error });
    logAudit(req.user.id, 'MOCK2_CYCLE_ACCEPT_PENDING', 'mock2_cycle', cycle.id,
      { cycle: cycle.id, acting_as_admin: req.mock2Access.actingAsAdmin }, req.ip);
    return res.status(202).json({ cycle: publicCycleShape(result.cycle), warn: result.warn || null });
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
    const { text, kind = 'blocker', title = '', status = '', card_id = null, question = null, prior = '' } = parsed.data;
    let result;
    try {
      result = question
        ? await explainFollowup({ text, title, status, kind, prior, question })
        : await explainCard({ text, title, status, kind });
    } catch (err) {
      result = { ok: false, error: err?.message || 'the explainer failed' };
    }
    // Audit log ONLY that an explanation was viewed — no state change to the cycle,
    // authorization, or deviation this explained.
    logAudit(req.user.id, 'MOCK2_EXPLAIN_VIEW', 'mock2_project', req.mock2Project.id,
      { kind, card_id, ok: !!result.ok, followup: !!question }, req.ip);
    if (!result.ok) return res.json({ ok: false, error: result.error || 'could not explain this right now' });
    return res.json(question ? { ok: true, answer: result.answer } : { ok: true, explanation: result.explanation });
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
    // per-change token/cost counter without a second round-trip (Task 3), and to
    // its cycle's REQUEST so the log download is request-scoped: one build
    // request = ONE log, however many checkpoints (halts/resumes/retries) it
    // took. request_id is null on legacy cycles — the UI falls back per-cycle.
    const usageByCycle = new Map();
    for (const c of listCyclesForProject(req.mock2Project.id, { limit: 1000 })) {
      usageByCycle.set(c.id, { used_tokens: c.used_tokens ?? 0, used_cost_cents: c.used_cost_cents ?? 0, request_id: c.request_id ?? null });
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
        request_id: usage ? usage.request_id : null,
        used_tokens: usage ? usage.used_tokens : null,
        used_cost_cents: usage ? usage.used_cost_cents : null,
        acting_as_admin: Number(r.acting_as_admin) === 1, created_at: r.created_at,
      };
    });
    res.json({ records, verification: verifyProjectChain(req.mock2Project.id) });
  });

  // ---- Restore (roll the project back to a checkpoint — append-only) ----

  // Every checkpoint in the change history is a point in time. Restore makes a
  // chosen one the CURRENT state — code and (when that checkpoint carries a
  // snapshot) the in-container database — by appending a NEW checkpoint whose
  // tree is the old one's. Nothing is rewritten: git history and the hash
  // chain keep every later change, and the next build simply works off the
  // restored HEAD. The default, with no restore, is the latest checkpoint
  // ("what was currently built").
  const restoreSchema = z.object({ seq: z.coerce.number().int().positive() });
  router.post('/projects/:id/restore', requireMock2Role('editor'), refuseIfArchived, async (req, res) => {
    const project = req.mock2Project;
    const parsed = restoreSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'seq (the checkpoint number to restore to) is required' });
    const seq = parsed.data.seq;

    const records = listChangeRecords(project.id);
    const record = records.find((r) => Number(r.seq) === seq) || null;
    const latestSeq = records.reduce((m, r) => Math.max(m, Number(r.seq || 0)), 0);
    const check = validateRestoreRequest({
      record, latestSeq,
      runningCycles: countRunningCycles(project.id),
      lifecycle: project.lifecycle,
    });
    if (!check.ok) return res.status(409).json({ error: check.error });
    const lock = getLock(project.id);
    if (lock && (lock.holder_cycle_id != null || lock.holder_user_id != null)) {
      return res.status(409).json({ error: 'This project is checked out by another writer. Wait, or request a takeover.' });
    }
    const framework = getCurrentFrameworkVersion();
    if (!framework) return res.status(409).json({ error: 'No framework version exists to pin the restore record to.' });

    const containerName = containerNameForProject(project);
    const script = buildRestoreScript({
      commitSha: record.commit_sha,
      message: `mock2: restore to checkpoint #${seq} (${String(record.commit_sha).slice(0, 8)})`,
    });
    const r = await containerSh(containerName, script, { timeoutMs: 300000 });
    const out = `${r.stdout || ''}\n${r.stderr || ''}`.trim();
    if (r.code !== 0) {
      return res.status(502).json({ error: `Restore failed inside the container: ${out.slice(-400)}` });
    }
    const { sha: restoredSha, db } = parseRestoreOutput(r.stdout);
    if (!restoredSha) return res.status(502).json({ error: `Restore did not produce a commit: ${out.slice(-400)}` });

    // The hash-chained record + its repo mirror (ADR-006) — the same discipline
    // as every other checkpoint, so the restore itself is auditable history.
    const summary = restoreSummary({ seq, commitSha: record.commit_sha, db });
    let newRecord = null;
    try {
      newRecord = insertChangeRecord({
        projectId: Number(project.id), cycleId: null, initiatedBy: req.user.id,
        actingAsAdmin: req.mock2Access.actingAsAdmin ? 1 : 0,
        frameworkVersion: framework.version, frameworkVersionId: framework.id,
        commitSha: restoredSha, summary,
      });
    } catch (e) {
      console.error('[mock2] restore change record insert failed:', e?.message);
    }
    if (newRecord) {
      try {
        await writeFileInContainer(containerName, `state/changes/${newRecord.seq}.json`, JSON.stringify(changeRecordMirror(newRecord), null, 2));
        await containerSh(containerName, buildCheckpointScript({ message: `mock2: change record ${newRecord.seq}` }), { timeoutMs: 60000 });
      } catch (e) { console.warn('[mock2] restore change-record mirror failed:', e?.message); }
    }
    try {
      const remote = getProjectRemote(project.id);
      if (remote?.push_on_checkpoint) await pushProjectRemote(project);
    } catch (e) { console.warn('[mock2] restore push_on_checkpoint failed:', e?.message); }

    logAudit(req.user.id, 'MOCK2_PROJECT_RESTORE', 'mock2_project', project.id,
      { to_seq: seq, target_sha: record.commit_sha, restored_sha: restoredSha, db }, req.ip);
    res.json({ restored: true, to_seq: seq, record_seq: newRecord?.seq ?? null, restored_sha: restoredSha, db });
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

  // ---- Cost-truth: requests (one ask = one record) ----

  // List a project's requests (umbrella entities), newest first, each with its cumulative
  // cost roll-up + segment costs derived from its cycles + consults.
  router.get('/projects/:id/requests', requireMock2Role('viewer'), (req, res) => {
    const pid = req.mock2Project.id;
    const requests = listRequestsForProject(pid).map((r) => {
      const cycles = listCyclesForRequest(r.id);
      const consults = listConsultsForRequest(r.id).map(publicConsultShape);
      const log = buildRequestLog({ request: publicRequestShape(r), cycles: cycles.map(publicCycleShape), consults });
      return { ...publicRequestShape(r), cost: log.cost, segments: log.segments, final_status: log.final_status };
    });
    res.json({ requests });
  });

  // One request's merged, ordered, deduplicated log — the "one entry per request"
  // history + the idempotent "Download log" artifact (fixes the byte-identical duplicate
  // export). The artifact hash is over deterministic content only, so a double-export
  // yields one identical artifact.
  router.get('/projects/:id/requests/:reqId/log', requireMock2Role('viewer'), (req, res) => {
    const pid = req.mock2Project.id;
    const request = getRequest(req.params.reqId);
    if (!request || request.project_id !== pid) return res.status(404).json({ error: 'Request not found' });
    const cycles = listCyclesForRequest(request.id).map(publicCycleShape);
    const consults = listConsultsForRequest(request.id).map(publicConsultShape);
    const changeRecords = listChangeRecords(pid).filter((r) => cycles.some((c) => Number(c.id) === Number(r.cycle_id)));
    const cycleIds = new Set(cycles.map((c) => Number(c.id)));
    const messages = listMessages(pid).map(publicChatMessageShape).filter((m) => cycleIds.has(Number(m.cycle_id)));
    const events = cycles.flatMap((c) => listCycleEvents(c.id));
    const log = buildRequestLog({ request: publicRequestShape(request), cycles, changeRecords, messages, events, consults });
    const artifact = requestLogArtifact(log, { at: new Date().toISOString() });
    res.json(artifact);
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
      ask_job: getAskJobStatus(project.id),
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

  // ASK lane — a question about the codebase or a bounded read-and-run task
  // ("run the tests", "curl the API with the stored credentials"), answered by
  // a tool loop over the fenced container with NO build ceremony (no audit, no
  // checkpoint, no deploy). Takes the checkout lock while it runs (exec is a
  // writer for locking purposes), records spend to the quota ledger, and posts
  // the answer into the build chat. 202 + poll (ask_job on GET /chat).
  router.post('/projects/:id/ask', requireMock2Role('editor'), refuseIfArchived, async (req, res) => {
    const parsed = askSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'question is required (1–4000 chars)' });
    let result;
    try {
      const imgCheck = validateChatImages(parsed.data.images);
      if (!imgCheck.ok) return res.status(400).json({ error: imgCheck.error });
      result = await startAsk({
        project: req.mock2Project, question: parsed.data.question,
        user: req.user, actingAsAdmin: req.mock2Access.actingAsAdmin ? 1 : 0,
        images: imgCheck.images,
      });
    } catch (err) {
      return res.status(500).json({ error: `Could not start the ask: ${err?.message || 'unknown error'}` });
    }
    if (result.status === 'error') return res.status(409).json({ error: result.error });
    logAudit(req.user.id, 'MOCK2_ASK_START', 'mock2_project', req.mock2Project.id,
      { chars: parsed.data.question.length, acting_as_admin: req.mock2Access.actingAsAdmin }, req.ip);
    res.status(202).json({ status: 'started' });
  });

  router.get('/projects/:id/ask/status', requireMock2Role('viewer'), (req, res) => {
    res.json({ job: getAskJobStatus(req.mock2Project.id) });
  });

  // Chat image bytes (migration 526). Content-addressed id ("<sha256>.<ext>"),
  // so the response is immutable — the browser caches it forever and the chat
  // never re-downloads a thumbnail. Viewer-gated like the chat itself.
  router.get('/projects/:id/chat-images/:imageId', requireMock2Role('viewer'), (req, res) => {
    const id = String(req.params.imageId || '');
    if (!isChatImageId(id)) return res.status(400).json({ error: 'bad image id' });
    const img = readChatImage(req.mock2Project.id, id);
    if (!img) return res.status(404).json({ error: 'image not found' });
    res.set('Content-Type', img.media_type);
    res.set('Cache-Control', 'private, max-age=31536000, immutable');
    res.send(img.buffer);
  });

  // ============================================================
  // MODEL ROUTING knowledge base (migration 525) — the reference dictionary
  // mapping task kind → model / escalation model / effort, plus the append-only
  // outcome evidence it is tuned against. Reads are admin (models + costs are
  // operator concerns); edits are admin + audited.
  // ============================================================

  router.get('/routing/rules', requireAdmin, (req, res) => {
    res.json({
      mode: routingMode(process.env),
      task_kinds: ROUTING_TASK_KINDS,
      efforts: ROUTING_EFFORTS,
      env_escalate_model: String(process.env.MOCK2_ESCALATE_MODEL || '').trim() || null,
      rules: listRoutingRules().map((r) => publicRoutingRuleShape(r)),
    });
  });

  router.patch('/routing/rules/:kind', requireAdmin, (req, res) => {
    const kind = String(req.params.kind || '').trim().toLowerCase();
    if (!ROUTING_TASK_KINDS.includes(kind)) return res.status(404).json({ error: 'unknown task kind' });
    const parsed = routingRuleSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'invalid update' });
    const d = parsed.data;
    const updated = updateRoutingRule(kind, {
      ...(d.model !== undefined ? { model: d.model || null } : {}),
      ...(d.escalate_model !== undefined ? { escalate_model: d.escalate_model || null } : {}),
      ...(d.effort !== undefined ? { effort: d.effort || null } : {}),
      ...(d.enabled !== undefined ? { enabled: d.enabled } : {}),
      ...(d.notes !== undefined ? { notes: d.notes || null } : {}),
      updatedBy: req.user.id,
    });
    logAudit(req.user.id, 'MOCK2_ROUTING_RULE_UPDATE', 'mock2_routing_rule', kind, { fields: Object.keys(d) }, req.ip);
    res.json({ rule: publicRoutingRuleShape(updated) });
  });

  // The scoreboard: per task-kind × model — runs, success rate, escalation
  // rate, avg cost/tokens — derived from the append-only outcome rows. This is
  // the evidence an operator reviews before tuning the dictionary.
  router.get('/routing/outcomes', requireAdmin, (req, res) => {
    const taskKind = req.query.kind ? String(req.query.kind).trim().toLowerCase() : null;
    if (taskKind && !ROUTING_TASK_KINDS.includes(taskKind)) return res.status(400).json({ error: 'unknown task kind' });
    const rows = listRoutingOutcomes({ taskKind, limit: 1000 });
    res.json({
      stats: aggregateRoutingOutcomes(rows),
      recent: rows.slice(0, 50).map((r) => ({
        cycle_id: r.cycle_id, project_id: r.project_id, request_id: r.request_id,
        task_kind: r.task_kind, difficulty: r.difficulty, model: r.model, effort: r.effort,
        rung: r.rung, status: r.status, cost_cents: r.cost_cents, tokens: r.tokens, created_at: r.created_at,
      })),
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
      const imgCheck = validateChatImages(parsed.data.images);
      if (!imgCheck.ok) return res.status(400).json({ error: imgCheck.error });
      result = await startConceptTurn({
        project, message: parsed.data.message, user: req.user,
        actingAsAdmin: req.mock2Access.actingAsAdmin ? 1 : 0,
        mode: parsed.data.mode || 'design',
        images: imgCheck.images,
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

  // Export the project's DESIGN TEMPLATE — the mockup HTML + original design
  // brief + conversation + design tokens, and never any application code — as
  // a downloadable JSON document. Any member may export (same bar as
  // export.zip); works for active, stopped, and archived projects (the bare
  // repo is the fallback source, ADR-006).
  router.get('/projects/:id/design-template', requireMock2Role('viewer'), async (req, res) => {
    const project = req.mock2Project;
    const out = await exportDesignTemplate(project);
    if (!out.ok) return res.status(409).json({ error: out.error });
    logAudit(req.user.id, 'MOCK2_DESIGN_TEMPLATE_EXPORT', 'mock2_project', project.id, { name: project.name }, req.ip);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${project.slug || `project-${project.id}`}.design-template.json"`);
    res.json(out.doc);
  });

  // Import a design template into THIS project's Concept stage: either an
  // uploaded exported document or another project picked from the list (the
  // server exports that project's template — the design/mockup only, no code).
  // Editor-gated; refuses once the design is approved. Optional `notes` carry
  // the Builder's changes/context; otherwise the template's original prompt is
  // the reference the initial build quotes.
  router.post('/projects/:id/design-template/import', requireMock2Role('editor'), refuseIfArchived, async (req, res) => {
    const project = req.mock2Project;
    const parsed = designTemplateImportSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'doc (an exported design template) or source_project_id is required' });
    }
    let doc = parsed.data.doc || null;
    let source = 'file';
    let sourceName = null;
    if (!doc) {
      const src = getProject(Number(parsed.data.source_project_id));
      // Mask a non-member's probe as not-found (mirror requireMock2Role): the
      // source design is only copyable by someone who can already view it.
      const adminBypass = isReqAdmin(req) || isUserSuperadmin(req.user.id);
      if (!src || (!adminBypass && !getMembership(src.id, req.user.id))) {
        return res.status(404).json({ error: 'Source project not found' });
      }
      if (src.id === project.id) {
        return res.status(400).json({ error: 'Choose a different project to copy the design from' });
      }
      const out = await exportDesignTemplate(src);
      if (!out.ok) return res.status(409).json({ error: `Could not read the source project's design: ${out.error}` });
      doc = out.doc;
      source = 'project';
      sourceName = src.name;
    }
    const check = parseDesignTemplate(doc);
    if (!check.ok) return res.status(400).json({ error: check.error });
    if (source === 'file') sourceName = check.template.name || null;
    let result;
    try {
      result = await importDesignTemplate({
        project, template: check.template, notes: parsed.data.notes || '',
        source, sourceName, user: req.user,
        actingAsAdmin: req.mock2Access.actingAsAdmin ? 1 : 0,
      });
    } catch (err) {
      return res.status(500).json({ error: `Import failed: ${err?.message || 'unknown error'}` });
    }
    if (!result.ok) return res.status(409).json({ error: result.error });
    logAudit(req.user.id, 'MOCK2_DESIGN_TEMPLATE_IMPORT', 'mock2_project', project.id,
      { source, source_name: sourceName, mockup_id: result.mockupId, acting_as_admin: req.mock2Access.actingAsAdmin }, req.ip);
    res.status(201).json({
      project: shapeProject(getProject(project.id), { isAdmin: isReqAdmin(req) }),
      mockup_id: result.mockupId,
    });
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
    // Egress grant follow-through: resolving the queue item APPROVES the grant
    // (and probes host reachability so the decision has the "policy vs host-down"
    // context, acceptance #5); dismissing DENIES it. The fence reconcile then
    // wires only approved grants. The full audit record — who approved, when,
    // host/port/reason — is the grant row's decided_by/decided_at plus this log.
    if (item.kind === 'egress_grant' && item.ref_table === 'mock2_egress_grants' && item.ref_id
        && (status === 'resolved' || status === 'dismissed')) {
      try {
        const grantStatus = status === 'resolved' ? 'approved' : 'denied';
        const g = setEgressGrantStatus(item.ref_id, grantStatus, { decidedBy: req.user.id });
        if (g && grantStatus === 'approved') {
          const probe = await probeHostReachable(g.host, g.port).catch(() => null);
          if (probe) setEgressGrantReachable(g.id, probe.reachable);
          // Wire the newly-approved allow-hole into the project's fence now.
          await reconcileMock2Firewall().catch((e) => console.warn('[mock2] fence reconcile (egress approve) failed:', e?.message));
          logAudit(req.user.id, 'MOCK2_EGRESS_GRANT_APPROVE', 'mock2_egress_grant', g.id,
            { host: g.host, port: g.port, protocol: g.protocol, reason: g.reason, reachable: probe?.reachable || null }, req.ip);
        } else if (g) {
          // Denied grants are never wired; nothing to reconcile.
          logAudit(req.user.id, 'MOCK2_EGRESS_GRANT_DENY', 'mock2_egress_grant', g.id,
            { host: g.host, port: g.port, protocol: g.protocol }, req.ip);
        }
      } catch (err) { console.warn('[mock2] egress grant follow-through failed:', err?.message); }
    }
    logAudit(req.user.id, 'MOCK2_QUEUE_ITEM_STATUS', 'mock2_queue_item', item.id,
      { kind: item.kind, status, resumed, edited: !!(editedText || conditions) }, req.ip);
    res.json({ item: publicQueueItemShape(updated, { projectName: updated.project_id ? getProject(updated.project_id)?.name || null : null }), resumed });
  });

  // ============================================================
  // Integration truthfulness (AUDIT.md; B.4/B.5/B.6). The integration-gate
  // result rides on the cycle (integration_gate_json); this surfaces the
  // pending-operator-verification checklist + the stub registry + the reported
  // outcome, and lets an operator confirm a live verification (or an admin waive
  // one). Confirmation requires an OBSERVED RESULT — a bare checkbox is invalid.
  // ============================================================

  // The project's integration status: reported outcome of the latest cycle, the
  // outstanding verification checklist (from the gate result), the active
  // confirmations, and the open production simulations (stub registry).
  router.get('/projects/:id/integration-status', requireMock2Role('viewer'), (req, res) => {
    const project = req.mock2Project;
    const latest = latestCycle(project.id);
    let gate = null;
    try { gate = latest?.integration_gate_json ? JSON.parse(latest.integration_gate_json) : null; } catch { gate = null; }
    const outcome = latest ? reportedCycleOutcome(latest) : null;
    // PATCH2 B.2 — CAPABILITY-scoped live-check status: the outstanding/verified
    // split across the WHOLE project (not the latest cycle), netted against active
    // confirmations. This is ambient status — a capability's pending checks
    // persist across cycles and gate the app's production-ready flag, independent
    // of whichever cycle last ran.
    const capStatus = capabilityCheckStatus({
      checklistItems: projectChecklistItems(project.id),
      activeVerifications: listActiveVerifications(project.id),
    });
    res.json({
      reported_outcome: outcome,
      outcome_code: outcome ? (OUTCOME_CODES[outcome] ?? null) : null,
      verification_state: latest?.verification_state || null,
      // App-level production readiness (capability-scoped): true only when NO
      // capability has an outstanding live check. A calm "N live checks remain",
      // never a blocker.
      production_ready: capStatus.production_ready,
      outstanding_checks: capStatus.outstanding,
      verified_checks: capStatus.verified,
      checklist: gate?.checklist || [],
      gate: gate ? { outcome: gate.outcome, reasons: gate.reasons, limits: gate.gate?.limits } : null,
      confirmations: listActiveVerifications(project.id).map((v) => ({
        item_id: v.item_id, manifest_id: v.manifest_id, subsystem: v.subsystem,
        operator_id: v.operator_id, role: v.role, environment: v.environment,
        endpoint_classification: v.endpoint_classification,
        observed_result: v.observed_result, waived: !!v.waived, waiver_reason: v.waiver_reason,
        created_at: v.created_at, content_hash: v.content_hash,
      })),
      open_findings: listOpenIntegrationFindings(project.id).map((f) => ({
        id: f.id, kind: f.kind, subsystem: f.subsystem, file: f.file, severity: f.severity,
        blocking: !!f.blocking, detail: f.detail, origin: f.origin, created_at: f.created_at,
      })),
      deploy_pending_is_healthy: deployPendingIsHealthy(),
    });
  });

  // Confirm (operator) or waive (admin) a live-verification checklist item. The
  // confirmation is validated for a real observed result, hash-linked, and
  // append-only. When every checklist item on the pending cycle is confirmed or
  // waived, the cycle advances pending-operator-verification → succeeded.
  router.post('/projects/:id/cycles/:cycleId/verify', requireMock2Role('editor'), refuseIfArchived, (req, res) => {
    const project = req.mock2Project;
    const cycle = getCycle(req.params.cycleId);
    if (!cycle || cycle.project_id !== project.id) return res.status(404).json({ error: 'Cycle not found' });
    if (cycle.verification_state !== 'pending') return res.status(409).json({ error: 'This cycle is not pending operator verification.' });
    let gate = null;
    try { gate = cycle.integration_gate_json ? JSON.parse(cycle.integration_gate_json) : null; } catch { gate = null; }
    const checklist = gate?.checklist || [];
    const parsed = verifyConfirmSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'invalid confirmation' });
    const item = checklist.find((c) => c.item_id === parsed.data.item_id);
    if (!item) return res.status(404).json({ error: 'No such verification item on this cycle' });
    const isAdmin = isReqAdmin(req) || req.mock2Access?.actingAsAdmin;
    const verifyActorId = requireMock2Actor(req, res);
    if (verifyActorId == null) return;
    const record = {
      project_id: project.id, cycle_id: cycle.id, item_id: item.item_id,
      // Synthesized checklist items (accept-pending's live-<subsystem>-N) carry no
      // manifest entry — fall back so a confirmation on them validates instead of
      // dead-ending the pending state on a 400.
      manifest_id: item.manifest_id || item.item_id, manifest_hash: item.manifest_hash || 'unversioned', subsystem: item.subsystem,
      operator_id: verifyActorId, role: parsed.data.waived ? 'admin' : (isAdmin ? 'admin' : 'operator'),
      environment: parsed.data.environment, endpoint_classification: item.endpoint_classification,
      observed_result: parsed.data.observed_result || null,
      waived: !!parsed.data.waived, waiver_reason: parsed.data.waiver_reason || null,
      evidence_ref: parsed.data.evidence_ref || null, expires_at: parsed.data.expires_at || null,
    };
    const v = validateConfirmation(record);
    if (!v.ok) return res.status(400).json({ error: v.error });
    if (record.waived && !isAdmin) return res.status(403).json({ error: 'Only an administrator can waive a verification item.' });
    try {
      const saved = recordVerification(record);
      // Advance to succeeded once every checklist item has an active confirmation/waiver.
      const active = new Set(listActiveVerifications(project.id).filter((r) => r.cycle_id === cycle.id).map((r) => r.item_id));
      const allDone = checklist.every((c) => active.has(c.item_id));
      let advanced = false;
      if (allDone) {
        updateCycle(cycle.id, { verification_state: 'verified' });
        finishCycle(cycle.id, { status: 'succeeded', error: null });
        try { const rc = getCycle(cycle.id); if (rc?.request_id) closeRequest(rc.request_id, 'succeeded'); } catch { /* best effort */ }
        resolveQueueItem(`mock2-verify:${cycle.id}`, { resolution: 'operator verified', resolvedBy: req.user.id });
        advanced = true;
      }
      logAudit(req.user.id, 'MOCK2_INTEGRATION_VERIFY', 'mock2_cycle', cycle.id,
        { item_id: item.item_id, waived: record.waived, advanced }, req.ip);
      return res.status(201).json({
        confirmation: { id: saved.id, item_id: saved.item_id, content_hash: saved.content_hash },
        remaining: checklist.filter((c) => !active.has(c.item_id)).map((c) => c.item_id),
        reported_outcome: reportedCycleOutcome(getCycle(cycle.id)),
        advanced_to_succeeded: advanced,
      });
    } catch (err) {
      console.error('[mock2] cycle verify failed:', err?.stack || err?.message || err);
      return res.status(500).json({ error: `Could not record the confirmation: ${err?.message || 'unknown error'}` });
    }
  });

  // PATCH2 B.2 — verify a CAPABILITY's live check independently of any build
  // cycle. Verification is a property of the capability's lifecycle, not gated
  // behind a pending cycle: the operator confirms/waives an outstanding check from
  // the project-wide set at any time (observed result required, hash-linked,
  // append-only). When a capability's check clears, any pending cycle whose whole
  // checklist is now satisfied advances to succeeded, and production_ready flips
  // once nothing is outstanding.
  router.post('/projects/:id/capability-checks/verify', requireMock2Role('editor'), refuseIfArchived, (req, res) => {
    const project = req.mock2Project;
    const parsed = verifyConfirmSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'invalid confirmation' });
    const items = projectChecklistItems(project.id);
    const item = items.find((c) => c.item_id === parsed.data.item_id);
    if (!item) return res.status(404).json({ error: 'No such capability live check in this project' });
    const isAdmin = isReqAdmin(req) || req.mock2Access?.actingAsAdmin;
    const verifyActorId = requireMock2Actor(req, res);
    if (verifyActorId == null) return;
    const record = {
      project_id: project.id, cycle_id: null, item_id: item.item_id,
      // Same synthesized-item fallback as the cycle-scoped verify above.
      manifest_id: item.manifest_id || item.item_id, manifest_hash: item.manifest_hash || 'unversioned', subsystem: item.subsystem,
      operator_id: verifyActorId, role: parsed.data.waived ? 'admin' : (isAdmin ? 'admin' : 'operator'),
      environment: parsed.data.environment, endpoint_classification: item.endpoint_classification || 'unknown',
      observed_result: parsed.data.observed_result || null,
      waived: !!parsed.data.waived, waiver_reason: parsed.data.waiver_reason || null,
      evidence_ref: parsed.data.evidence_ref || null, expires_at: parsed.data.expires_at || null,
    };
    const v = validateConfirmation(record);
    if (!v.ok) return res.status(400).json({ error: v.error });
    if (record.waived && !isAdmin) return res.status(403).json({ error: 'Only an administrator can waive a verification item.' });
    // The DB write + advance is wrapped so a persistence error surfaces its real
    // cause instead of an opaque 500 the operator can't act on.
    try {
      const saved = recordVerification(record);
      // Recompute capability-scoped status and advance any pending cycle now fully
      // verified. A pending cycle → succeeded once its whole checklist is satisfied.
      const active = new Set(listActiveVerifications(project.id).map((r) => r.item_id));
      const advanced = [];
      for (const cyc of listCyclesForProject(project.id, { limit: 200 })) {
        if (cyc.verification_state !== 'pending') continue;
        let gate = null;
        try { gate = cyc.integration_gate_json ? JSON.parse(cyc.integration_gate_json) : null; } catch { gate = null; }
        const cl = gate?.checklist || [];
        if (cl.length && cl.every((c) => active.has(c.item_id))) {
          updateCycle(cyc.id, { verification_state: 'verified' });
          finishCycle(cyc.id, { status: 'succeeded', error: null });
          try { if (cyc.request_id) closeRequest(cyc.request_id, 'succeeded'); } catch { /* best effort */ }
          advanced.push(cyc.id);
        }
      }
      const capStatus = capabilityCheckStatus({ checklistItems: items, activeVerifications: listActiveVerifications(project.id) });
      logAudit(req.user.id, 'MOCK2_CAPABILITY_VERIFY', 'mock2_project', project.id,
        { item_id: item.item_id, waived: record.waived, advanced_cycles: advanced }, req.ip);
      return res.status(201).json({
        confirmation: { id: saved.id, item_id: saved.item_id, content_hash: saved.content_hash },
        production_ready: capStatus.production_ready,
        outstanding_checks: capStatus.outstanding.map((c) => c.item_id),
        advanced_cycles: advanced,
      });
    } catch (err) {
      console.error('[mock2] capability-check verify failed:', err?.stack || err?.message || err);
      return res.status(500).json({ error: `Could not record the confirmation: ${err?.message || 'unknown error'}` });
    }
  });

  // The class-matched resolution options for a blocked cycle (PATCH B.1). Reads the
  // stored gate result, computes the offered options (each resolves ≥1 present
  // class), and reports the loop-breaker state. Any member can see it; only the
  // relevant role may act (backfill: editor; waiver/approve: admin).
  router.get('/projects/:id/cycles/:cycleId/resolutions', requireMock2Role('viewer'), (req, res) => {
    const project = req.mock2Project;
    const cycle = getCycle(req.params.cycleId);
    if (!cycle || cycle.project_id !== project.id) return res.status(404).json({ error: 'Cycle not found' });
    let decision = null;
    try { decision = cycle.integration_gate_json ? JSON.parse(cycle.integration_gate_json) : null; } catch { decision = null; }
    if (!decision || !decision.blocking) return res.json({ blocked: false, options: [] });
    let priorSignatures = [];
    try { priorSignatures = priorBlockedSignatures(cycle.request_id, cycle.id); } catch { priorSignatures = []; }
    const bs = blockingSummary(decision, { priorSignatures });
    res.json({
      blocked: true,
      state: bs.state || 'blocked-deviation',
      reason: bs.reason,
      classes: bs.classes || [],
      findings: bs.findings || decision.reasons || [],
      options: bs.options || [],
      requires_resolution: bs.requires_resolution || null,
      uncovered: bs.uncovered || [],
      resolutions: listIntegrationResolutions(project.id, { cycleId: cycle.id }).map((r) => ({
        id: r.id, kind: r.kind, finding_class: r.finding_class, routed_to: r.routed_to,
        reason: r.reason, created_at: r.created_at, content_hash: r.content_hash,
      })),
    });
  });

  // PATCH B.1 — backfill: DECLARE an undeclared capability by appending an
  // operator-confirmed entry to state/integrations.json, then resume the cycle so
  // the gate re-runs against it (an undeclared finding becomes a real-provenance
  // check — the deadlock is broken). Editor-gated; the project must be online.
  router.post('/projects/:id/cycles/:cycleId/backfill-manifest', requireMock2Role('editor'), refuseIfArchived, async (req, res) => {
    const project = req.mock2Project;
    const cycle = getCycle(req.params.cycleId);
    if (!cycle || cycle.project_id !== project.id) return res.status(404).json({ error: 'Cycle not found' });
    if (project.lifecycle !== 'active') return res.status(409).json({ error: 'Bring the project online to declare an integration.' });
    const parsed = manifestBackfillSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'invalid manifest entry' });
    const check = validateManifestEntry(parsed.data.entry);
    if (!check.ok) return res.status(400).json({ error: check.error });
    const containerName = project.container_name || containerNameForProject(project.id);
    let result;
    try {
      result = await backfillManifestEntryInContainer({
        containerName, entry: parsed.data.entry,
        execInContainer, readFileInContainer, writeFileInContainer,
      });
    } catch (err) {
      return res.status(500).json({ error: `Backfill failed: ${err?.message || 'unknown error'}` });
    }
    if (!result.ok) return res.status(409).json({ error: result.error });
    const backfillActorId = requireMock2Actor(req, res);
    if (backfillActorId == null) return;
    recordIntegrationResolution({
      project_id: project.id, cycle_id: cycle.id, kind: 'manifest_backfill',
      finding_class: 'undeclared', finding_kind: 'undeclared_integration',
      subsystem: result.entry.subsystem, manifest_id: result.entry.id, manifest_hash: result.hash,
      manifest_entry_json: result.entry, routed_to: 'building',
      reason: parsed.data.reason || `declared integration "${result.entry.id}"`,
      decided_by: backfillActorId, role: isReqAdmin(req) ? 'admin' : 'editor',
    });
    logAudit(req.user.id, 'MOCK2_INTEGRATION_BACKFILL', 'mock2_cycle', cycle.id,
      { manifest_id: result.entry.id, subsystem: result.entry.subsystem }, req.ip);
    // Resume the cycle: a fresh cycle continues from the checkpoint and re-runs the
    // gate against the now-declared manifest.
    let resumed = null;
    try {
      resumed = await retryCycle({ project: getProject(project.id), cycle: getCycle(cycle.id), initiatedBy: req.user.id, actingAsAdmin: req.mock2Access.actingAsAdmin ? 1 : 0, message: `Declared integration "${result.entry.id}" in the manifest — re-run the gate against it.` });
    } catch (err) { console.warn('[mock2] backfill resume failed:', err?.message); }
    res.status(201).json({ declared: { id: result.entry.id, subsystem: result.entry.subsystem, hash: result.hash }, resume: resumed?.status || 'not_resumed' });
  });

  // Repair a MALFORMED state/integrations.json (the manifest-invalid dead end).
  // Self-healing, never destructive: the broken text is archived to
  // state/integrations.invalid.json, every entry that still validates is
  // salvaged, and a valid schema_version + entries[] scaffold is committed. If a
  // cycle is blocked on the manifest, it is resumed so the gate re-reads it.
  // Editor-gated; the project must be online.
  router.post('/projects/:id/integrations/repair-manifest', requireMock2Role('editor'), refuseIfArchived, async (req, res) => {
    const project = req.mock2Project;
    if (project.lifecycle !== 'active') return res.status(409).json({ error: 'Bring the project online to repair the manifest.' });
    const containerName = project.container_name || containerNameForProject(project.id);
    let result;
    try {
      result = await repairManifestInContainer({ containerName, execInContainer, readFileInContainer, writeFileInContainer });
    } catch (err) {
      return res.status(500).json({ error: `Repair failed: ${err?.message || 'unknown error'}` });
    }
    if (!result.ok) return res.status(409).json({ error: result.error });
    if (!result.repaired) return res.json({ repaired: false, reason: result.reason });
    logAudit(req.user.id, 'MOCK2_INTEGRATION_MANIFEST_REPAIR', 'mock2_project', project.id,
      { salvaged: result.salvaged.map((e) => e.id), migrated: result.migrated, dropped: result.dropped, archive: result.archive }, req.ip);
    // Resume a cycle blocked on the invalid manifest so the gate re-reads it.
    let resumed = null;
    try {
      const latest = latestCycle(project.id);
      if (latest && ['awaiting_admin', 'failed'].includes(latest.status)) {
        resumed = await retryCycle({ project: getProject(project.id), cycle: latest, initiatedBy: req.user.id, actingAsAdmin: req.mock2Access.actingAsAdmin ? 1 : 0, message: 'The integration manifest was repaired (broken text archived to state/integrations.invalid.json) — re-run the gate against it.' });
      }
    } catch (err) { console.warn('[mock2] manifest-repair resume failed:', err?.message); }
    res.status(201).json({
      repaired: true,
      salvaged: result.salvaged.map((e) => e.id),
      migrated: result.migrated,
      dropped: result.dropped,
      archived_to: result.archive,
      resume: resumed?.status || 'not_resumed',
    });
  });

  // Operator reports a live capability check FAILED against the real system
  // (B.5 `live_check_failed → building`). This is the honest downstream of
  // pending-operator-verification: the operator ran the check with real
  // credentials and it did not work — which is a genuine, reproducible defect
  // report. The failure is recorded append-only, the pending cycle's
  // verification_state moves to 'failed', and a REAL bug-fix build opens
  // carrying the observation (the new cycle legitimately has a defect to
  // reproduce against the in-fence contract fixture).
  router.post('/projects/:id/capability-checks/report-failure', requireMock2Role('editor'), refuseIfArchived, async (req, res) => {
    const project = req.mock2Project;
    const parsed = verifyConfirmSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'invalid failure report' });
    const observed = String(parsed.data.observed_result || '').trim();
    if (!observed) return res.status(400).json({ error: 'Report what you OBSERVED when the check failed (the error message, status, behavior) — that observation is what the bug-fix build reproduces.' });
    const items = projectChecklistItems(project.id);
    const item = items.find((c) => c.item_id === parsed.data.item_id);
    if (!item) return res.status(404).json({ error: 'No such capability live check in this project' });

    const failureActorId = requireMock2Actor(req, res);
    if (failureActorId == null) return;

    // Append-only failure evidence (migration-522 table — same hash-linked record
    // class as backfills/waivers; routed_to 'building' per the lifecycle).
    const saved = recordIntegrationResolution({
      project_id: project.id, cycle_id: null, kind: 'live_check_failed',
      finding_class: 'live-check-failed', finding_kind: 'live_check_failed',
      subsystem: item.subsystem, manifest_id: item.manifest_id, manifest_hash: item.manifest_hash,
      reason: `${parsed.data.environment}: ${observed}`, routed_to: 'building',
      decided_by: failureActorId, role: isReqAdmin(req) ? 'admin' : 'editor',
    });

    // The pending cycle(s) carrying this item stop being "pending" — the live
    // check failed. Their build work is intact; the new bug-fix cycle owns the fix.
    const affected = [];
    for (const cyc of listCyclesForProject(project.id, { limit: 200 })) {
      if (cyc.verification_state !== 'pending') continue;
      let gate = null;
      try { gate = cyc.integration_gate_json ? JSON.parse(cyc.integration_gate_json) : null; } catch { gate = null; }
      if ((gate?.checklist || []).some((c) => c.item_id === item.item_id)) {
        updateCycle(cyc.id, { verification_state: 'failed' });
        finishCycle(cyc.id, { status: 'failed', error: `Live verification failed for "${item.item_id}" — a bug-fix build was opened with the operator's observation.` });
        affected.push(cyc.id);
      }
    }

    // Open the REAL bug-fix build through the normal audit-first pipeline. The
    // instruction deliberately reads as a defect (classifyTaskKind → bugfix), so
    // the new cycle must reproduce red→green against the contract fixture.
    let build = null;
    try {
      build = await startBuild({
        project: getProject(project.id),
        instruction: failureBugfixInstruction({ item, observed }),
        user: req.user, actingAsAdmin: req.mock2Access.actingAsAdmin ? 1 : 0,
      });
    } catch (err) {
      return res.status(500).json({ error: `The failure was recorded, but the bug-fix build could not start: ${err?.message || 'unknown error'}` });
    }
    logAudit(req.user.id, 'MOCK2_CAPABILITY_CHECK_FAILED', 'mock2_project', project.id,
      { item_id: item.item_id, environment: parsed.data.environment, affected_cycles: affected, build_status: build?.status || null }, req.ip);
    res.status(202).json({
      failure: { id: saved.id, item_id: item.item_id, content_hash: saved.content_hash },
      affected_cycles: affected,
      bugfix: { status: build?.status || 'error', cycle: build?.cycle ? publicCycleShape(build.cycle) : null, error: build?.error || null },
    });
  });

  // Operator DEFERS a live capability check — "I can't run this against the real
  // system right now" (no production access from here, the app isn't reachable/
  // deployed yet, credentials not available). This is the honest third option next
  // to confirm ("it works") and report-failure ("it's broken"): the code is real
  // and the build is DONE (pending-operator-verification is a calm, complete,
  // non-blocking state), the operator simply cannot verify it in this environment.
  // It records an append-only deferral note with a reason and LEAVES the cycle
  // pending — it never advances to succeeded, never marks failed, never opens a
  // bug-fix build. Editor+; a reason is required (no silent skip).
  router.post('/projects/:id/capability-checks/defer', requireMock2Role('editor'), refuseIfArchived, (req, res) => {
    const project = req.mock2Project;
    const itemId = String(req.body?.item_id || '').trim();
    const reason = String(req.body?.reason || '').trim();
    if (!itemId) return res.status(400).json({ error: 'item_id is required.' });
    if (!reason) return res.status(400).json({ error: 'A short reason is required — e.g. "no route to the directory from here" or "app not deployed yet".' });
    const items = projectChecklistItems(project.id);
    const item = items.find((c) => c.item_id === itemId);
    if (!item) return res.status(404).json({ error: 'No such capability live check in this project' });
    const deferActorId = requireMock2Actor(req, res);
    if (deferActorId == null) return;
    try {
      const saved = recordIntegrationResolution({
        project_id: project.id, cycle_id: null, kind: 'live_check_deferred',
        finding_class: 'live-check-deferred', finding_kind: 'live_check_deferred',
        subsystem: item.subsystem, manifest_id: item.manifest_id, manifest_hash: item.manifest_hash,
        reason, routed_to: 'pending-operator-verification',
        decided_by: deferActorId, role: isReqAdmin(req) ? 'admin' : 'editor',
      });
      logAudit(req.user.id, 'MOCK2_CAPABILITY_CHECK_DEFERRED', 'mock2_project', project.id,
        { item_id: item.item_id, reason }, req.ip);
      return res.status(201).json({
        deferred: { id: saved.id, item_id: item.item_id, content_hash: saved.content_hash },
        note: 'Recorded — this build stays pending your live verification. Nothing else is required; verify it when you can reach the real system.',
      });
    } catch (err) {
      console.error('[mock2] capability-check defer failed:', err?.stack || err?.message || err);
      return res.status(500).json({ error: `Could not record the deferral: ${err?.message || 'unknown error'}` });
    }
  });

  // Admin escape hatch — RELEASE every outstanding live capability check at once.
  // The guaranteed way out of pending-operator-verification: records an admin
  // waiver (append-only, reasoned, hash-linked — same evidence class as a
  // per-item waive) for each outstanding item, then advances every pending
  // awaiting_user cycle whose checklist is now satisfied to succeeded. Use it
  // when the live checks will never be run (no credentials/route from anywhere,
  // the checks are unwanted, or the project must be unstuck NOW). Pairs with
  // integration_gate_mode 'off', which stops NEW checks from being derived.
  router.post('/projects/:id/capability-checks/release', requireMock2Role('editor'), refuseIfArchived, (req, res) => {
    const project = req.mock2Project;
    if (!(isReqAdmin(req) || req.mock2Access?.actingAsAdmin)) {
      return res.status(403).json({ error: 'Only an administrator can release outstanding live checks.' });
    }
    const actorId = requireMock2Actor(req, res);
    if (actorId == null) return;
    const reason = String(req.body?.reason || '').trim() || 'released by administrator — live verification not required for this project';
    try {
      const cap = capabilityCheckStatus({
        checklistItems: projectChecklistItems(project.id),
        activeVerifications: listActiveVerifications(project.id),
      });
      const released = [];
      for (const item of cap.outstanding) {
        const record = {
          project_id: project.id, cycle_id: null, item_id: item.item_id,
          // Synthesized items (no manifest entry) must still be releasable — the
          // netting in capabilityCheckStatus treats a hash-less item as matched
          // by any active verification with the same item_id.
          manifest_id: item.manifest_id || item.item_id, manifest_hash: item.manifest_hash || 'unversioned', subsystem: item.subsystem || null,
          operator_id: actorId, role: 'admin',
          environment: 'n/a', endpoint_classification: item.endpoint_classification || 'unknown',
          observed_result: null, waived: true, waiver_reason: reason,
          evidence_ref: null, expires_at: null,
        };
        const v = validateConfirmation(record);
        if (!v.ok) return res.status(400).json({ error: v.error });
        recordVerification(record);
        released.push(item.item_id);
      }
      // Advance every pending cycle whose whole checklist is now satisfied —
      // the same sweep the per-item verify performs.
      const active = new Set(listActiveVerifications(project.id).map((r) => r.item_id));
      const advanced = [];
      for (const cyc of listCyclesForProject(project.id, { limit: 200 })) {
        if (cyc.verification_state !== 'pending') continue;
        let gate = null;
        try { gate = cyc.integration_gate_json ? JSON.parse(cyc.integration_gate_json) : null; } catch { gate = null; }
        const cl = gate?.checklist || [];
        if (!cl.length || cl.every((c) => active.has(c.item_id))) {
          updateCycle(cyc.id, { verification_state: 'verified' });
          finishCycle(cyc.id, { status: 'succeeded', error: null });
          try { if (cyc.request_id) closeRequest(cyc.request_id, 'succeeded'); } catch { /* best effort */ }
          try { resolveQueueItem(`mock2-verify:${cyc.id}`, { resolution: 'released by administrator', resolvedBy: actorId }); } catch { /* best effort */ }
          advanced.push(cyc.id);
        }
      }
      logAudit(req.user.id, 'MOCK2_CAPABILITY_CHECKS_RELEASE', 'mock2_project', project.id,
        { released, advanced_cycles: advanced, reason }, req.ip);
      // Recompute rather than assert: the honest answer even if a write raced.
      const capAfter = capabilityCheckStatus({
        checklistItems: projectChecklistItems(project.id),
        activeVerifications: listActiveVerifications(project.id),
      });
      return res.status(released.length || advanced.length ? 201 : 200).json({
        released,
        advanced_cycles: advanced,
        production_ready: capAfter.production_ready,
        note: released.length
          ? `Released ${released.length} outstanding live check${released.length === 1 ? '' : 's'} (recorded as admin waivers) — the project is no longer pending verification.`
          : 'No live checks were outstanding — nothing to release.',
      });
    } catch (err) {
      console.error('[mock2] capability-check release failed:', err?.stack || err?.message || err);
      return res.status(500).json({ error: `Could not release the live checks: ${err?.message || 'unknown error'}` });
    }
  });

  // PATCH B.2 — waiver: an admin confirms a provenance-not-established finding is
  // genuinely real code the analyzer could not prove ("confirmed real — analysis
  // limitation"). Records a hash-linked waiver and routes the capability to
  // pending-operator-verification (NEVER succeeded). Refused for any finding the
  // analyzer positively classified as fabricated. Admin-only.
  router.post('/projects/:id/cycles/:cycleId/waive-provenance', requireMock2Role('editor'), refuseIfArchived, (req, res) => {
    const project = req.mock2Project;
    if (!(isReqAdmin(req) || req.mock2Access?.actingAsAdmin)) {
      return res.status(403).json({ error: 'Only an administrator can waive a provenance finding.' });
    }
    const cycle = getCycle(req.params.cycleId);
    if (!cycle || cycle.project_id !== project.id) return res.status(404).json({ error: 'Cycle not found' });
    let decision = null;
    try { decision = cycle.integration_gate_json ? JSON.parse(cycle.integration_gate_json) : null; } catch { decision = null; }
    if (!decision || !decision.blocking) return res.status(409).json({ error: 'This cycle is not blocked on an integration finding.' });
    const parsed = provenanceWaiverSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'invalid waiver' });
    // Find the target finding and ENFORCE waiver-eligibility (never fabricated).
    const target = (decision.gate?.findings || []).find((f) => f.kind === parsed.data.finding_kind
      && (parsed.data.file ? f.file === parsed.data.file : true));
    if (!target) return res.status(404).json({ error: 'No matching finding on this cycle' });
    if (!waiverEligible(target)) {
      return res.status(409).json({ error: 'This finding is positively-fabricated, not merely unprovable — a waiver is refused. Implement the real integration or approve it as a recorded simulation.' });
    }
    const t = verificationTransition({ state: 'blocked-deviation', event: 'provenance_waived', waiverEligible: true });
    if (!t.ok) return res.status(409).json({ error: t.reason });
    // Record the append-only, hash-linked waiver (with the analyzer's limitation +
    // a manifest hash so a manifest change re-opens it).
    const manEntry = (decision.manifest?.entry_hashes || [])[0] || null;
    const saved = recordIntegrationResolution({
      project_id: project.id, cycle_id: cycle.id, kind: 'analysis_limitation_waiver',
      finding_class: 'provenance-not-established', finding_kind: target.kind,
      subsystem: target.subsystem || null, file: target.file || null,
      inspected: parsed.data.inspected, analyzer_limitation: (decision.gate?.limits?.known_limits || []).join(' | ').slice(0, 2000),
      manifest_id: manEntry?.id || null, manifest_hash: manEntry?.hash || null,
      reason: parsed.data.reason, routed_to: 'pending-operator-verification',
      decided_by: req.user.id, role: 'admin',
    });
    // Route the cycle to pending-operator-verification with a checklist derived
    // from the manifest for the waived subsystem — the live backstop.
    const checklist = deriveVerificationChecklist({
      manifest: { entries: (decision.manifest?.entry_hashes || []).map((h) => ({ id: h.id })) },
      subsystems: [],
    });
    updateCycle(cycle.id, {
      verification_state: 'pending',
      integration_gate_json: JSON.stringify({ ...decision, outcome: 'pending-operator-verification', blocking: false, checklist: checklist.length ? checklist : (decision.checklist || []), waived: true }),
    });
    finishCycle(cycle.id, { status: 'awaiting_user', error: null });
    logAudit(req.user.id, 'MOCK2_INTEGRATION_WAIVE', 'mock2_cycle', cycle.id,
      { finding_kind: target.kind, file: target.file, routed_to: 'pending-operator-verification' }, req.ip);
    res.status(201).json({
      waiver: { id: saved.id, content_hash: saved.content_hash, routed_to: 'pending-operator-verification' },
      reported_outcome: reportedCycleOutcome(getCycle(cycle.id)),
    });
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
