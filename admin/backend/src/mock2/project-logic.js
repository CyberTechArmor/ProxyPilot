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
import { conceptStageInfo, mockupPreviewUrl } from './concept-logic.js';

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

// ---- derived status (single source of truth) ----

// deriveProjectStatus(project, ctx) → one lowercase status token the UI keys
// off. This is the SINGLE implementation (03-data-model.md) the tile list and
// the detail page both call — never a fork. M9 finalizes it across ALL states by
// adding the remaining derived inputs to the SAME ctx:
//
//   editorCount        : 0 ⇒ orphaned (ADR-007)
//   containerState     : live Incus status ('running'|'stopped'|'frozen'|null)
//   openEditorQuestions: >0 ⇒ awaiting_user (M8 + M9 classifier questions)
//   openAdminItems     : >0 ⇒ awaiting_admin (M8)
//   driftOpen          : an open drift queue item ⇒ drift (ADR-003)
//   cycleRunning       : a live cycle (queued/estimating/running) ⇒ building (M6/M9)
//   lockHeldByHuman    : a human holds the checkout lock ⇒ checked_out (ADR-004)
//   quotaExhausted     : period spend ≥ budget (ledger vs budget) ⇒ quota_exhausted (M9)
//
// All are DERIVED (from locks, cycles, open questions, queue items, quota state,
// membership counts) — never stored. Every input is optional with a safe default
// so an older caller (M2 tests) gets the pre-M9 behavior unchanged.
//
// Precedence (lifecycle terminals first; the flagged overlay is reported
// separately, it is an overlay not a status):
//   provisioning/failed/archived → building → quota_exhausted → awaiting_user →
//   awaiting_admin → checked_out → drift → orphaned → stopped → online/idle.
// quota_exhausted is placed ahead of the awaiting/queue lanes deliberately: a
// budget-exhausted project cannot proceed regardless of open questions, and its
// quota_exhausted queue item would otherwise read as a generic "awaiting admin".
export function deriveProjectStatus(project, ctx = {}) {
  if (!project) return 'unknown';
  const {
    editorCount = null, containerState = null,
    openEditorQuestions = 0, openAdminItems = 0, driftOpen = false,
    cycleRunning = false, lockHeldByHuman = false, quotaExhausted = false,
  } = ctx;
  const lc = project.lifecycle;

  if (lc === 'provisioning') return 'provisioning';
  if (lc === 'failed_provisioning') return 'failed';
  if (lc === 'archived') return 'archived';

  // A live cycle is the most important thing to show — the runner is working
  // (M6/M9). Derived from cycle state, never a stored flag.
  if (cycleRunning) return 'building';

  // Budget exhausted (M9 — ledger vs budget). Can't run a cycle regardless of
  // anything below, so it fronts the awaiting/queue lanes.
  if (quotaExhausted) return 'quota_exhausted';

  // M8 audit gate (ADR-002) — DERIVED from open rows. An open editor question
  // means a rule must be confirmed (awaiting user); an open admin deviation/queue
  // item means an admin must clear it (awaiting admin). Editors act first.
  if (Number(openEditorQuestions) > 0) return 'awaiting_user';
  if (Number(openAdminItems) > 0) return 'awaiting_admin';

  // A human holds the checkout lock (ADR-004) — someone is actively editing the
  // container. (A cycle-held lock is already 'building' above.)
  if (lockHeldByHuman) return 'checked_out';

  // Framework moved since the last build (ADR-003) — an "update available"
  // condition. Non-blocking; remediation is explicit-consent only.
  if (driftOpen) return 'drift';

  // Zero editors ⇒ orphaned (ADR-007). Only meaningful for a live project.
  if (editorCount === 0) return 'orphaned';

  if (lc === 'stopped') return 'stopped';

  // lifecycle === 'active' — refine by container liveness when we know it.
  if (containerState) {
    const s = String(containerState).toLowerCase();
    if (s === 'running') return 'online';
    if (s === 'stopped' || s === 'frozen') return 'idle';
  }
  return 'online';
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
    // M9 lifecycle-derived inputs (03-data-model.md — all DERIVED).
    cycleRunning = false,
    lockHeldByHuman = false,
    quotaExhausted = false,
  } = extra;

  const status = deriveProjectStatus(project, {
    editorCount, containerState, openEditorQuestions, openAdminItems, driftOpen,
    cycleRunning, lockHeldByHuman, quotaExhausted,
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
    flagged: Number(project.flagged) === 1,
    flagged_reason: project.flagged_reason || null,
    editor_count: editorCount,
    viewer_count: viewerCount,
    web_port: project.web_port ?? null,
    last_activity_at: project.last_activity_at || null,
    created_by: project.created_by ?? null,
    created_at: project.created_at || null,
    archived_at: project.archived_at || null,
    // M7 concept stage: the persistent stage indicator (Concept → Define →
    // Build → Run), the design-approval sign-off, and the live mockup preview
    // URL (project URL + the dev-server preview path). preview_url is null until
    // a mockup exists / the project has a live URL.
    stage: conceptStageInfo(project),
    design_approved_at: project.design_approved_at || null,
    current_mockup_id: project.current_mockup_id || null,
    preview_url: mockupPreviewUrl(host ? `https://${host}` : null, !!project.current_mockup_id),
    // M8 audit-gate counts (drive the awaiting/drift chips + the in-detail
    // banners) and the framework-drift "update available" signal (ADR-003).
    open_editor_questions: Number(openEditorQuestions) || 0,
    open_admin_items: Number(openAdminItems) || 0,
    drift: !!driftOpen,
    framework_update_available: !!frameworkUpdateAvailable,
    framework_current_version: frameworkCurrentVersion,
    framework_last_built_version: frameworkLastBuiltVersion,
    // M9 derived lifecycle signals (drive the building/checked-out/quota chips).
    cycle_running: !!cycleRunning,
    checked_out: !!lockHeldByHuman,
    quota_exhausted: !!quotaExhausted,
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
