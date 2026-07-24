// Mock2 project pure decision layer (Phase M2).
//
// Every project decision that can be made without better-sqlite3, Express,
// Incus, or DNS lives here so it is unit-testable at the module boundary
// (stub-first, risk R9): the derived-status function, the API response shape,
// the rotation-grace active-FQDN computation, and the role/access resolution
// the requireMock2Role middleware is built on.
//
// The single-source-of-truth rule from 03-data-model.md: the UI "status" is
// DERIVED, never stored — deriveProjectStatus is that one implementation, used
// by both the tile list and the detail page. M2 derives the subset that exists
// now (lifecycle, orphaned, flagged, container online/idle); locks, cycles,
// questions, quota, and drift join it in later phases through the same
// function, never a second one.
//
// Terminology (risk R7): the AI build component is the runner; nothing here is
// named "agent".

import { slugFqdn } from './slug.js';
import { conceptStageInfo, dashboardMockupPreviewUrl } from './concept-logic.js';

// ---- role / access resolution (ADR-007) ----

// Does an actual membership role satisfy a required minimum? editor implies
// viewer; viewer implies only viewer. Pure ordering, no privilege beyond the
// two project roles (admin is handled by bypass, not by this ladder).
export function roleSatisfies(actualRole, requiredRole) {
  if (requiredRole === 'viewer') return actualRole === 'viewer' || actualRole === 'editor';
  if (requiredRole === 'editor') return actualRole === 'editor';
  return false;
}

// resolveMock2Access — the pure core of requireMock2Role. Given the request
// user, their membership row on the project (or null), and the required role,
// decide whether the action is allowed and whether it is an admin acting
// inside a project they don't belong to (acting_as_admin, stamped on chats and
// change records per ADR-007).
//
// Admin/superadmin bypass membership entirely. If such a user IS also a member,
// the action is their own (not acting_as_admin); if they are not a member, the
// access is a bypass and stamped acting_as_admin=1.
//
// user: { id, role } (role 'admin' | 'user'); isSuperadmin is treated as admin
// for bypass — superadmins are always admins in this model.
export function resolveMock2Access({ user, membership = null, requiredRole = 'viewer', isSuperadmin = false } = {}) {
  if (!user) return { allowed: false, actingAsAdmin: false, role: null, reason: 'unauthenticated' };
  const isAdmin = user.role === 'admin' || !!isSuperadmin;
  if (isAdmin) {
    return {
      allowed: true,
      actingAsAdmin: !membership, // a member-admin acts as themselves
      role: membership?.role || 'admin',
      reason: 'admin',
    };
  }
  if (!membership) {
    return { allowed: false, actingAsAdmin: false, role: null, reason: 'not a project member' };
  }
  if (!roleSatisfies(membership.role, requiredRole)) {
    return { allowed: false, actingAsAdmin: false, role: membership.role, reason: `requires ${requiredRole}` };
  }
  return { allowed: true, actingAsAdmin: false, role: membership.role, reason: 'member' };
}

// mock2TerminalDecision — the pure verdict for opening a shell terminal into a
// project's container over the streaming-terminal WS route. A shell is a MUTATE
// capability (it can change the working tree, run the dev server, etc.), so the
// caller resolves `access` at the 'editor' role; this layers the not-found
// masking (mirror requireMock2Role: a non-member gets 404, never a 403 that
// would confirm the project exists) and the "must be online" guard on top.
// Returns { ok, status, reason, actingAsAdmin } — status is the HTTP-ish code
// the WS upgrade rejects with. Pure: the DB lookups + container-name resolution
// live in terminal.js so this stays unit-testable stub-first (risk R9).
export function mock2TerminalDecision({ project = null, access = null } = {}) {
  if (!project) return { ok: false, status: 404, reason: 'Project not found' };
  if (!access || !access.allowed) {
    if (!access || access.reason === 'not a project member') {
      return { ok: false, status: 404, reason: 'Project not found' };
    }
    return { ok: false, status: 403, reason: 'Terminal access requires the editor role on this project' };
  }
  if (project.lifecycle !== 'active') {
    return { ok: false, status: 409, reason: `The project container is not online (it is "${project.lifecycle}")` };
  }
  return { ok: true, status: 200, reason: access.reason, actingAsAdmin: !!access.actingAsAdmin };
}

// ---- derived status (single source of truth) ----

// deriveProjectStatus(project, ctx) → one lowercase status token the UI keys
// off. ctx carries the derived inputs M2 has: editorCount (0 ⇒ orphaned) and
// containerState (Incus status string: 'running'|'stopped'|... or null when
// unknown). Later phases add lock/cycle/question/quota inputs to ctx and this
// function grows — the tile and the detail page both call it, never a fork.
//
// Precedence: lifecycle terminal states win, then the flagged overlay is
// reported separately (it is an overlay, not a status), then orphaned, then
// container liveness.
export function deriveProjectStatus(project, ctx = {}) {
  if (!project) return 'unknown';
  const {
    editorCount = null, containerState = null,
    openEditorQuestions = 0, openAdminItems = 0, driftOpen = false,
    // Run phase — the deploy signal from the project's latest cycle
    // (deploy-logic.deployProjectStatus): 'deploying' | 'serving' |
    // 'deploy_failed' | null. Derived from the cycle row, never a stored project
    // flag, so this stays the single source of truth for the UI.
    deployState = null,
  } = ctx;
  const lc = project.lifecycle;

  if (lc === 'provisioning') return 'provisioning';
  if (lc === 'failed_provisioning') return 'failed';
  if (lc === 'archived') return 'archived';

  // M8 audit gate (ADR-002) — DERIVED from open rows, never a stored flag. An
  // open editor question means the Builder must confirm a rule (awaiting user);
  // an open admin deviation/queue item means an admin must clear it (awaiting
  // admin). Editors act first, so awaiting user wins.
  if (Number(openEditorQuestions) > 0) return 'awaiting_user';
  if (Number(openAdminItems) > 0) return 'awaiting_admin';

  // Zero editors ⇒ orphaned (ADR-007). Only meaningful for a live project.
  if (editorCount === 0) return 'orphaned';

  // Run phase (deploy) — a build's gates passed but installing/migrating/
  // building/starting the app on the live URL failed: a distinct, actionable
  // state, never a silent success. Shown ahead of drift/liveness so the operator
  // sees the deploy needs attention.
  if (deployState === 'deploy_failed') return 'deploy_failed';
  // A deploy in progress (install/migrate/build/restart running).
  if (deployState === 'deploying') return 'deploying';

  // Framework moved since the last build (ADR-003) — an "update available"
  // condition surfaced as its own status. Non-blocking; remediation is
  // explicit-consent only.
  if (driftOpen) return 'drift';

  if (lc === 'stopped') return 'stopped';

  // lifecycle === 'active' — refine by container liveness when we know it. A
  // running container whose latest build deployed is 'serving' the real app;
  // otherwise it is 'online' (placeholder / pre-build).
  if (containerState) {
    const s = String(containerState).toLowerCase();
    if (s === 'running') return deployState === 'serving' ? 'serving' : 'online';
    if (s === 'stopped' || s === 'frozen') return 'idle';
  }
  return deployState === 'serving' ? 'serving' : 'online';
}

// ---- archived read-only + idle-stop (M3) ----

// isProjectReadOnly(project) — an archived project is frozen: its git repo,
// chats, change records, and memberships are retained but nothing about it may
// change except VIEW and REHYDRATE (Q4 / 04-phased-plan §M3). This is the ONE
// predicate the API-layer guard keys off — no per-route sprinkles.
export function isProjectReadOnly(project) {
  return !!project && project.lifecycle === 'archived';
}

// isIdleStale(project, now, days) — has an ACTIVE project gone untouched long
// enough to idle-stop its container (M3 groundwork; M9 enforces)? Pure so the
// threshold logic is unit-testable without Incus. now is an ISO-8601 string;
// days is the configured idle window (mock2_settings). Only an active project
// with a valid last-activity timestamp can be stale; archived/stopped/
// provisioning projects are never idle-stopped by this function.
export function isIdleStale(project, now, days) {
  if (!project || project.lifecycle !== 'active') return false;
  if (!(Number(days) > 0)) return false;
  const last = Date.parse(project.last_activity_at || project.created_at || '');
  const nowMs = Date.parse(now);
  if (!Number.isFinite(last) || !Number.isFinite(nowMs)) return false;
  return nowMs - last >= Number(days) * 86400000;
}

// ---- per-project agent harness ----

// Which agent harness drives a project's build cycles. 'copilot' is the native
// Copilot-grade port (runner.js runCycle + the copilot tool profile) and the
// install-wide DEFAULT; 'proxypilot' is the original hand-rolled runner;
// 'claude' is the Claude Agent SDK runner (runner-sdk.js). Stored per project
// (migration 533); NULL means "no explicit choice" and resolves to the default
// (runner-logic.js resolveHarness) — 'copilot' on any install that never set the
// legacy BUILD_RUNNER=sdk flag.
export const HARNESSES = Object.freeze(['copilot', 'proxypilot', 'claude']);

// normalizeHarness(value) → 'copilot' | 'proxypilot' | 'claude' | null. NULL (no
// explicit choice) for unset or unrecognized values — an unknown string in the
// column must degrade to the default, never crash or select an unintended runner.
export function normalizeHarness(value) {
  const v = String(value ?? '').trim().toLowerCase();
  return HARNESSES.includes(v) ? v : null;
}

// ---- API response shape ----

// publicProjectShape(project, extra) — decorate a stored project row for the
// API. Derives status + the live URL; surfaces the admin-only debug upstream
// (bridge_ip:port) ONLY when the caller passes isAdmin (no host ports are ever
// exposed — this is the container's bridge address, admin-gated). Never leaks
// repo_path to non-admins.
export function publicProjectShape(project, extra = {}) {
  if (!project) return null;
  const {
    parentDomain = null,
    editorCount = null,
    viewerCount = null,
    containerState = null,
    isAdmin = false,
    // M8 audit/queue-derived inputs (03-data-model.md — all DERIVED).
    openEditorQuestions = 0,
    openAdminItems = 0,
    driftOpen = false,
    frameworkUpdateAvailable = false,
    frameworkCurrentVersion = null,
    frameworkLastBuiltVersion = null,
    // Run phase — derived deploy signal (deploy-logic.deployProjectStatus of the
    // latest cycle's deploy_status).
    deployState = null,
    // What a NULL harness column resolves to on this install — 'copilot'
    // unless the caller passes the legacy BUILD_RUNNER=sdk resolution
    // (runner-logic.js resolveHarness). Injected so this shape stays pure.
    defaultHarness = 'copilot',
  } = extra;

  const status = deriveProjectStatus(project, {
    editorCount, containerState, openEditorQuestions, openAdminItems, driftOpen, deployState,
  });
  const host = project.custom_domain
    ? project.custom_domain
    : (project.slug && parentDomain ? slugFqdn(project.slug, parentDomain) : null);

  const shaped = {
    id: project.id,
    name: project.name,
    description: project.description || null,
    parent_domain_id: project.parent_domain_id ?? null,
    parent_domain: parentDomain,
    slug: project.slug || null,
    custom_domain: project.custom_domain || null,
    url: host ? `https://${host}` : null,
    lifecycle: project.lifecycle,
    status,
    // Run phase — the derived deploy signal, surfaced so the tile/detail can
    // show "serving"/"deploying"/"deploy failed" without re-deriving.
    deploy_state: deployState,
    flagged: Number(project.flagged) === 1,
    flagged_reason: project.flagged_reason || null,
    editor_count: editorCount,
    viewer_count: viewerCount,
    web_port: project.web_port ?? null,
    last_activity_at: project.last_activity_at || null,
    created_by: project.created_by ?? null,
    created_at: project.created_at || null,
    archived_at: project.archived_at || null,
    // Domain-suggestion handling ('off'|'ask'|'auto', migration 539); rows
    // predating the column normalize to the 'ask' default.
    suggest_mode: ['off', 'ask', 'auto'].includes(project.suggest_mode) ? project.suggest_mode : 'ask',
    // The design action queued during provisioning (migration 540) — compact
    // preview only; consumed server-side the moment provisioning completes.
    pending_design: (() => {
      try {
        const d = project.pending_design_json ? JSON.parse(project.pending_design_json) : null;
        return d ? {
          kind: d.kind,
          mode: d.mode || 'design',
          text_preview: String(d.text || '').slice(0, 140),
          has_images: (d.attachments || []).length > 0,
          created_at: d.created_at || null,
        } : null;
      } catch { return null; }
    })(),
    // M7 concept stage: the persistent stage indicator (Concept → Define →
    // Build → Run), the design-approval sign-off, and the live mockup preview
    // URL (the dashboard's own /mockup-preview route). preview_url is null
    // until a mockup exists.
    stage: conceptStageInfo(project),
    // The design preset the project was created with ('' / 'ai' = AI-derived) —
    // the Design specs page highlights it.
    design_preset: project.design_preset || null,
    design_approved_at: project.design_approved_at || null,
    // Set once the provision-time (or self-heal) base-app deploy succeeds — the
    // UI offers "Deploy base app" retry while this is null and nothing serves.
    base_app_deployed_at: project.base_app_deployed_at || null,
    // A base-app deploy is running RIGHT NOW (no cycle carries it, so without
    // this the UI has no signal — the banner invited a press mid-deploy and the
    // user got a bare 409). Derived from the in-process guard, never stored.
    base_app_deploying: !!extra.baseAppDeploying,
    current_mockup_id: project.current_mockup_id || null,
    // Served by the dashboard itself (reads the mockup HTML out of the
    // container) so the design review never depends on the project app being
    // up, un-gated, and frameable — see the /mockup-preview route.
    preview_url: dashboardMockupPreviewUrl(project.id, !!project.current_mockup_id),
    // The archived design mockup — the record of where the design started. Set
    // once the design is approved (the live mockup pointer is cleared but the
    // mockup HTML is kept on disk). Surfaced in the Details tab so anyone can
    // revisit the original design. Falls back to the live mockup pre-approval
    // so callers always have "the design preview" regardless of stage.
    mockup_archive_url: dashboardMockupPreviewUrl(
      project.id,
      !!(project.mockup_archived_id || project.current_mockup_id),
    ),
    // M8 audit-gate counts (drive the awaiting/drift chips + the in-detail
    // banners) and the framework-drift "update available" signal (ADR-003).
    open_editor_questions: Number(openEditorQuestions) || 0,
    open_admin_items: Number(openAdminItems) || 0,
    drift: !!driftOpen,
    // The agent harness driving this project's builds: the explicit per-project
    // choice, else the install default. Always a concrete value so the UI can
    // render the toggle without re-deriving the fallback.
    harness: normalizeHarness(project.harness) || defaultHarness,
    harness_choice: normalizeHarness(project.harness),
    framework_update_available: !!frameworkUpdateAvailable,
    framework_current_version: frameworkCurrentVersion,
    framework_last_built_version: frameworkLastBuiltVersion,
  };

  if (isAdmin) {
    // Admin debug view (04-phased-plan §M2): show the container's bridge
    // upstream, never a host port. NULL until the container has an IP.
    shaped.container_name = project.container_name || null;
    shaped.bridge_ip = project.container_ip || null;
    // Per-project managed bridge (M4): its name + subnet. The container is
    // pinned to this bridge and fenced by nftables + the egress proxy.
    shaped.bridge_name = project.bridge_name || null;
    shaped.bridge_cidr = project.bridge_cidr || null;
    shaped.upstream = project.container_ip && project.web_port
      ? `${project.container_ip}:${project.web_port}`
      : null;
    shaped.repo_path = project.repo_path || null;
    shaped.provision_error = project.provision_error || null;
  }
  return shaped;
}

// ---- rotation-grace active-FQDN computation (ADR-009 / slug rotate) ----

// projectActiveFqdns(project, historyRows, now) → the FQDN blocks a single
// project contributes to its parent domain's Caddy file, each already carrying
// the reverse_proxy upstream. The current slug is always active; a rotated-away
// slug stays active only while its mock2_slug_history.active_until is in the
// future (the 1-hour grace window), after which it 404s and is never reused.
// A custom domain contributes its own block.
//
// Only a live project with a known upstream (container_ip + web_port) publishes
// a real reverse_proxy block — a provisioning/failed/archived project, or one
// whose container has no IP yet, contributes nothing (its FQDN keeps serving
// the parent domain's default, which is no route ⇒ Caddy 404, exactly right).
//
// now is an ISO-8601 string (injected so this stays pure/testable).
export function projectActiveFqdns(project, historyRows = [], now) {
  if (!project) return [];
  if (project.lifecycle === 'archived' || project.lifecycle === 'failed_provisioning') return [];
  const upstream = project.container_ip && project.web_port
    ? `${project.container_ip}:${project.web_port}`
    : null;
  if (!upstream) return [];

  const out = [];
  const seen = new Set();
  const add = (fqdn, note) => {
    if (!fqdn || seen.has(fqdn)) return;
    seen.add(fqdn);
    out.push({ fqdn, upstream, note });
  };

  if (project.custom_domain) {
    add(project.custom_domain, `project ${project.id} (custom domain)`);
  }
  if (project.slug && project.parent_domain) {
    add(slugFqdn(project.slug, project.parent_domain), `project ${project.id}`);
  }
  // Grace-window slugs: still routing to the same container during rotation.
  const nowMs = Date.parse(now);
  for (const h of historyRows || []) {
    if (!h.active_until || !h.slug || !project.parent_domain) continue;
    const untilMs = Date.parse(h.active_until);
    if (Number.isFinite(untilMs) && Number.isFinite(nowMs) && untilMs > nowMs) {
      add(slugFqdn(h.slug, project.parent_domain), `project ${project.id} (rotation grace until ${h.active_until})`);
    }
  }
  return out;
}
